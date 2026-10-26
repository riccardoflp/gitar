import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ThemeService } from '../flow/theme';
import { discoverRepos, repoName } from '../git/discover';
import { GitError, formatCommand, git, writeFiles } from '../git/exec';
import { compareRangeUrl, compareUrl, parseGitHubRemote, type GitHubRepo } from '../git/github';
import {
  cleanupBranchesOp,
  clearIdentityOp,
  fetchRemoteOp,
  identityOp,
  pullAction,
  refNameProblem,
  remoteAddOp,
  remoteRemoveOp,
  remoteRenameOp,
  remoteSetUrlOp,
  restoreBranchOp,
  restoreConflictsOp,
  restoreStashOp,
  syncOp,
  takeFileOp,
  undoOp,
  type GitOp,
  type IdentityProfile,
} from '../git/ops';
import { allChanges, samePath } from '../git/parse';
import { Repo, isHash } from '../git/repo';
import { changeSetup, previewSetup, scanIgnored, unlinkFolderLinks } from '../git/worktreeSetup';
import { GRAPH_COLUMNS, WORKTREE, showsGraph } from '../shared/protocol';
import { changesText, sortRefs, worktreeLabel, worktreeOf, worktreeStatus } from '../shared/refs';
import { cleanPatterns, type IgnoredEntry, type SetupChoice, type SetupPatterns, type SetupTarget } from '../shared/worktreeSetup';
import { submoduleFolder } from '../shared/submodules';
import { Activity } from './activity';
import { FileIcons } from './fileIcons';
import type {
  Action,
  CompareMode,
  CompareSide,
  ComparedRef,
  DiffSource,
  FileChange,
  FilesLayout,
  BranchSort,
  Filter,
  GraphColumn,
  HostMessage,
  Loading,
  PullAction,
  PullRequest,
  RepoInfo,
  RepoState,
  Scope,
  Search,
  SyncAction,
  UiCommand,
  ViewKind,
  WebviewMessage,
} from '../shared/protocol';
import { openMergeEditor } from '../flow/merge';
import { AGENTS_WINDOW, SETUP_OFFERED, closeInVSCodeGit, inVSCodeGit, recoverHeldWorktree, refreshVSCodeGit, removeEmptyParents, resolveAction, squashRange, worktreesFolder } from './actions';
import { chooseConflictModel, draftCommitMessage } from './ai';
import { ConflictReviewTab } from './conflictReview';
import { INDEX, contentUri, proposalUri } from './content';
import { fetchPulls, githubSession } from './github';
import { editSetupJson, savePatterns, saveSetup, setupChangeText, setupPatterns, worktreeSetupInfo } from './worktreeSettings';

/** How many commits the graph reads at a time, unless the settings ask for another number between the two after it. */
const PAGE_SIZE = 1000;
const SMALLEST_PAGE = 100;
const LARGEST_PAGE = 10_000;
/** The most commits a search is told about, to highlight them in the graph. */
const FOUND_LIMIT = 5000;

const REFRESH_DELAY = 400;
/** Builds and installs write many files at once, so those are given longer to settle. */
const WORKTREE_REFRESH_DELAY = 1000;
const LOST_COMMITS_SHOWN = 10;
const REFLOG_ENTRIES = 200;
/** The diffs VS Code's Git serves the sides of, once it has the repository. */
const WORKING_SOURCES = new Set<DiffSource['kind']>(['staged', 'unstaged', 'change']);
const REPO_KEY = 'gitardo.repository';
/** The branches chosen for the graph of each repository, by its folder. */
const SCOPE_KEY = 'gitardo.scope';
/** How the files of a commit are laid out in its tab: as a tree until a list is asked for. */
const FILES_KEY = 'gitardo.commitFiles';
/** The favorite branches of each repository of the workspace. */
const FAVORITES_KEY = 'gitardo.favorites';
/** How many lines of what a commit changed are sent to its tab. The diff editor shows a commit longer than that. */
const PATCH_LINES = 20_000;
/** The most commits the view of the commits of a branch is given, however many it asks for. */
const LOG_LIMIT = 10_000;
/** What fits of the message of a commit in the title of its tab. */
const TITLE_LENGTH = 32;
/** Pull requests change on GitHub's side, so they are re-read at most this often unless something asks for it. */
const PULLS_MAX_AGE = 120_000;
/** The comparisons opened last in each repository, by its folder. */
const RECENT_KEY = 'gitardo.recentComparisons';
/** How many of them are kept. */
const RECENT_COMPARISONS = 8;

/** The working tree, as a side of a comparison. */
const WORKTREE_SIDE: ComparedRef = { name: 'Working tree', hash: WORKTREE };

/** A comparison opened before, to open again: its sides by the names they had, and the file or folder it showed. */
interface RecentComparison {
  from: ComparedRef;
  to: ComparedRef;
  path?: string;
}

/** A comparison open in a tab: its two sides as they were chosen, and what the tab was sent last. */
interface CompareTab {
  panel: vscode.WebviewPanel;
  repo: Repo;
  from: CompareSide;
  to: CompareSide;
  mode: CompareMode;
  /** The file or the folder the comparison is narrowed to. */
  path: string | null;
  /** The commits and the mode the tab shows, to tell whether what it shows has to be read again. */
  shown?: string;
  /** Where the changes the tab shows start from. */
  since?: string;
}

interface RunResult {
  ok: boolean;
  /** Git's error output when the operation ran and failed. Absent when the user cancelled. */
  error?: string;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The title of the tab of a comparison. */
const compareTitle = (from: CompareSide, to: CompareSide, path: string | null) =>
  `${from.name} ↔ ${to.name}${path ? ` · ${path.slice(path.lastIndexOf('/') + 1)}` : ''}`;

/**
 * How two sides are compared at first: two branches or tags from where they diverged, as a pull request shows them; a
 * commit, or the working tree, directly, for how the files differ from it.
 */
const compareMode = (from: CompareSide, to: CompareSide): CompareMode =>
  from.live && to.live && from.hash !== WORKTREE && to.hash !== WORKTREE ? 'diverged' : 'direct';

/** What can be a side of a comparison: a commit, or the working tree. */
const isSide = (hash: unknown): hash is string => typeof hash === 'string' && (hash === WORKTREE || isHash(hash));

/** A file or a folder as git names it, from the top of the repository, or null for all of it. */
const cleanPath = (path: unknown): string | null => {
  if (typeof path !== 'string') return null;
  const clean = path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.?\/)+|\/+$/g, '');
  return clean && clean !== '.' ? clean : null;
};

const hasCommand = async (id: string) => (await vscode.commands.getCommands(true)).includes(id);

/**
 * Whether a file of the folder of git that changed can mean that the repository did. What git writes for itself and
 * takes away again does not: the daemon of `core.fsmonitor` leaves a file in the folder of a worktree each time
 * `git status` runs there, as it does each time Gitardo reads, which would have it read again and again for ever; and a
 * lock is followed by the file it locked.
 */
function meansChange(file: string): boolean {
  return !/(^|\/)fsmonitor--daemon(\/|$)/.test(file) && !file.endsWith('.lock');
}

/** What the status bar says of a read of the repository: what asked for it, and how many came one after another. */
function readDetail(reads: number, cause: string | undefined): string | undefined {
  const why = cause ? `Because ${cause}.` : '';
  if (reads === 1) return why || undefined;
  return `Read ${reads} times in a row: something changed during each read. ${why}`.trim();
}

/**
 * Identifies the first `count` rows of a state: two states with the same key have the same rows, as far as that.
 * A commit never changes, so its hash stands for all of it, and the lines of the graph of a row only depend on the rows
 * above it. The row of the uncommitted changes only counts for being there or not, which moves the lines of the graph:
 * how many changes it says there are is sent apart.
 * The filter is part of it because the history of a file gives the same commits other parents, and so is following
 * only the first parent of each merge, which leaves a merge one parent.
 */
function rowsKey(state: RepoState, filter: Filter | null, count = state.rows.length): string {
  const hash = createHash('sha1');
  hash.update(`${state.root}\0${JSON.stringify(filter)}\0${state.firstParent}\0`);
  for (let index = 0; index < count; index++) hash.update(state.rows[index].hash);
  return hash.digest('hex');
}

/** What the graph shows of each commit beside its message, as `gitardo.graph.columns` asks: all of it when that is not a list. */
function graphColumns(): GraphColumn[] {
  const wanted = vscode.workspace.getConfiguration('gitardo').get('graph.columns');
  return Array.isArray(wanted) ? GRAPH_COLUMNS.filter((column) => wanted.includes(column)) : GRAPH_COLUMNS;
}

/**
 * How branches and tags are listed, as `gitardo.branches.sortOrder` asks, or else as VS Code's `git.branchSortOrder`
 * does when it was set. Its default is by date, and Gitardo lists them by name unless asked otherwise.
 */
function branchSort(): BranchSort {
  const set = vscode.workspace.getConfiguration('gitardo').inspect<unknown>('branches.sortOrder');
  const ours = set?.workspaceFolderValue ?? set?.workspaceValue ?? set?.globalValue;
  if (ours === 'name' || ours === 'date') return ours;
  const git = vscode.workspace.getConfiguration('git').inspect<unknown>('branchSortOrder');
  return (git?.workspaceFolderValue ?? git?.workspaceValue ?? git?.globalValue) === 'committerdate' ? 'date' : 'name';
}

/** How many commits the graph reads at a time, as `gitardo.graph.pageSize` asks. */
function pageSize(): number {
  const wanted = Math.trunc(Number(vscode.workspace.getConfiguration('gitardo').get('graph.pageSize')));
  return Number.isFinite(wanted) ? Math.min(Math.max(wanted, SMALLEST_PAGE), LARGEST_PAGE) : PAGE_SIZE;
}

/** Owns the repository state and serves every Gitardo webview, wherever the user has placed it. */
export class Controller implements vscode.Disposable {
  private repo?: Repo;
  private state: RepoState | null = null;
  private located = false;
  private limit = pageSize();
  /** The read of the repository under way, if any. */
  private loading?: Promise<void>;
  /** Who waits for a read that starts after they asked: each is let go once one is done, or when reading stops. */
  private waiters: (() => void)[] = [];
  /** What changed last that the repository is read again for, as the status bar says it. */
  private cause?: string;
  /** What the views were told the graph is read for, and how many of those reads are not done yet. */
  private waiting: { what: Loading; count: number } | null = null;
  /** How many operations were started, to tell a state that was read across one. */
  private operations = 0;
  /** Something changed since that read started. */
  private dirty = false;
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  /** When `timer` fires. */
  private due = 0;
  private watcher?: vscode.Disposable;
  /** The inverse of Gitardo's last operation, valid for as long as HEAD's reflog has not moved since. */
  private undoable?: { reflogTop: string; op: GitOp };
  /** Where the branch was before the cherry-pick of several commits that is under way, or just ended. */
  private series?: { before: string; branch: string | null; title: string };
  private filter: Filter | null = null;
  /** Which branches the graph shows: all of them when null. */
  private scope: Scope | null = null;
  private github: GitHubRepo | null = null;
  /** The remote that `github` is. */
  private githubRemote: string | null = null;
  private pulls: Record<string, PullRequest> = {};
  private pullsAt = 0;
  /** A commit to show as soon as a graph view is there to show it. */
  private pendingReveal?: string;
  /** Every repository of the workspace; `repo` is the one being shown. */
  private repos: RepoInfo[] = [];
  /** The repository of the workspace shown before a worktree of it that is not in the workspace. */
  private home?: RepoInfo;
  /** Whether this VS Code has the Agents window, which is looked up once: it comes and goes with VS Code itself. */
  private agentsWindow?: Promise<boolean>;
  private readonly views = new Map<vscode.Webview, ViewKind>();
  /** The tabs of the commits, by repository and hash, and the repository each is of: not always the one being shown. */
  private readonly commitTabs = new Map<string, vscode.WebviewPanel>();
  /** The tabs of the comparisons, by their webview. */
  private readonly compareTabs = new Map<vscode.Webview, CompareTab>();
  private readonly pinned = new Map<vscode.Webview, Repo>();
  /** The pages that color code, which are sent the colors of the theme again when it changes. */
  private readonly colored = new Set<vscode.Webview>();
  private readonly themes = new ThemeService();
  /** The pages that show files, which are sent the icons of the file icon theme again when it changes. */
  private readonly iconed = new Set<vscode.Webview>();
  private readonly fileIcons: FileIcons;
  /** The folders the pages may load files from: the build, and the extensions with icon themes. */
  private roots: vscode.Uri[];
  /** The tab where what new worktrees get is chosen, the repository it is of and what git ignores there, once looked at. */
  /** `saving` while the tab writes the settings one after the other, which it shows once they are all written. */
  private setupTab?: { panel: vscode.WebviewPanel; repo: Repo; entries: IgnoredEntry[] | null; saving: boolean };
  /** The tab where what is proposed for the conflicts is looked at before it is written. */
  private reviewTab?: ConflictReviewTab;
  /** The views with a search box that have the keyboard: one at most, but each says so on its own. */
  private readonly focused = new Set<vscode.Webview>();
  /** What identifies the commits each view that lists them was last sent, and how many they were. */
  private readonly sentRows = new WeakMap<vscode.Webview, { key: string; count: number }>();
  /** The files of the repository shown that have edits not saved in an editor, by their paths from its root. */
  private unsaved: string[] = [];
  /** What `unsaved` was last worked out from: the state, and the files of the editors with edits not saved. */
  private unsavedFrom?: { state: RepoState | null; files: string };
  private readonly stateEmitter = new vscode.EventEmitter<RepoState | null>();
  private readonly subscriptions: vscode.Disposable[];
  /** What Gitardo is doing that takes time, in the status bar. */
  readonly activity: Activity;

  /** Fires whenever the repository state has been reloaded. */
  readonly onDidChangeState = this.stateEmitter.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
    /** Remembers which repository of this workspace was chosen, and which branches of each are shown. */
    private readonly memento: vscode.Memento,
  ) {
    const schedule = (cause: string) => () => this.scheduleRefresh(cause);
    const unsaved = () => void this.checkUnsaved();
    this.fileIcons = new FileIcons(log);
    this.roots = this.resourceRoots();
    this.activity = new Activity(log);
    this.subscriptions = [
      this.stateEmitter,
      this.activity,
      this.fileIcons,
      this.fileIcons.onDidChange(() => this.sendFileIcons()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.locate()),
      vscode.workspace.onDidSaveTextDocument((document) => {
        unsaved();
        this.scheduleRefresh(`${vscode.workspace.asRelativePath(document.uri)} was saved`);
      }),
      // An edit, or one undone back to what is saved, and an editor closed without saving.
      vscode.workspace.onDidChangeTextDocument(unsaved),
      vscode.workspace.onDidCloseTextDocument(unsaved),
      vscode.workspace.onDidCreateFiles(schedule('files were created')),
      vscode.workspace.onDidDeleteFiles(schedule('files were deleted')),
      vscode.workspace.onDidRenameFiles(schedule('files were renamed')),
      vscode.window.onDidChangeWindowState((window) => window.focused && this.scheduleRefresh('VS Code got the focus')),
      vscode.workspace.onDidChangeConfiguration((event) => {
        const sections = ['gitardo.conflicts', 'gitardo.pull', 'gitardo.worktrees', 'gitardo.branches', 'gitardo.graph', 'git.branchSortOrder'];
        if (sections.some((section) => event.affectsConfiguration(section))) {
          this.scheduleRefresh('the settings changed');
        }
        if (event.affectsConfiguration('gitardo.conflicts')) void this.reviewTab?.reload();
      }),
      // The branches a comparison is of may have moved, and the conflicts of the review may be resolved.
      this.onDidChangeState(() => {
        for (const tab of this.compareTabs.values()) void this.sendCompare(tab);
        void this.reviewTab?.reload();
      }),
      vscode.window.onDidChangeActiveColorTheme(async () => {
        if (!this.colored.size) return;
        const theme = (await this.themes.resolveActive()) ?? null;
        for (const webview of this.colored) this.post({ type: 'syntaxTheme', theme }, webview);
      }),
    ];
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.watcher?.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  /** Loads the UI into a webview and wires it to this controller. `data` is written on the page for the view to read. */
  attach(webview: vscode.Webview, kind: ViewKind, data: Record<string, string> = {}): vscode.Disposable {
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    webview.options = { enableScripts: true, localResourceRoots: this.roots };
    // The session tells the page what it remembers from an earlier start of VS Code, for what is to start afresh each time.
    webview.html = this.html(webview, dist, { view: kind, session: vscode.env.sessionId, ...data });
    this.views.set(webview, kind);
    const listener = webview.onDidReceiveMessage((message: WebviewMessage) => this.onMessage(webview, message));
    return new vscode.Disposable(() => {
      listener.dispose();
      this.views.delete(webview);
      this.colored.delete(webview);
      this.iconed.delete(webview);
      this.setFocused(webview, false);
    });
  }

  /**
   * VS Code is told when a view that searches has the keyboard, for the keybinding of package.json to take Ctrl+F
   * away from the search of the editor behind: nothing else says that the focus is inside a webview.
   */
  private setFocused(webview: vscode.Webview, focused: boolean): void {
    const before = this.focused.size;
    if (focused) this.focused.add(webview);
    else this.focused.delete(webview);
    if (!before !== !this.focused.size) void vscode.commands.executeCommand('setContext', 'gitardo.searchFocus', this.focused.size > 0);
  }

  async refresh(): Promise<void> {
    if (!this.located || !this.repo) return this.locate();
    // A read already under way may have started before what the caller just did: it is followed by another,
    // and the caller waits for that one too.
    this.dirty = true;
    // Nothing is read while an operation runs: it reads once it is done. Reading runs git in every worktree, and on
    // Windows a folder git runs in can be neither moved nor removed.
    if (this.running) return this.loading;
    // Only for that one: while files keep changing, a large repository is read again and again, and what the caller
    // waits for is already there after the first.
    const read = new Promise<void>((resolve) => this.waiters.push(resolve));
    this.loading ??= this.load(this.repo);
    return read;
  }

  private async load(first: Repo): Promise<void> {
    const task = this.activity.start(this.readTitle(first));
    let waiting: (() => void)[] = [];
    try {
      for (let repo: Repo | undefined = first, reads = 1; repo && this.dirty && !this.running; repo = this.repo, reads++) {
        this.dirty = false;
        waiting = this.waiters.splice(0);
        const cause = this.cause;
        this.cause = undefined;
        task.describe(readDetail(reads, cause), this.readTitle(repo));
        const operations = this.operations;
        const scope = this.scope;
        const state = await this.readState(repo);
        // Read while an operation ran, it can be half from before it and half from after, such as a new commit that
        // no branch points at yet. It is dropped: the operation is followed by a read of its own.
        // Unless the views were pointed at another repository in the meantime. Who waited for it waits for the next.
        if (this.running || operations !== this.operations || repo !== this.repo) {
          this.waiters.unshift(...waiting.splice(0));
          continue;
        }
        // Unless another was chosen while this one was read.
        if (scope === this.scope) this.settleScope(state.root, state.scope);
        const sort = branchSort();
        this.setState({
          ...sortRefs(state, sort),
          favorites: this.favorites(state),
          defaultPull: this.defaultPull(),
          repos: this.repos,
          github: this.github,
          pulls: this.pulls,
          agentsWindow: await (this.agentsWindow ??= hasCommand(AGENTS_WINDOW)),
          worktreesRoot: worktreesFolder(state),
          openBranches: vscode.workspace.getConfiguration('gitardo').get('branches.openIn') === 'worktree' ? 'worktree' : 'checkout',
          branchesFollowScope: vscode.workspace.getConfiguration('gitardo').get('branches.followGraphFilter') !== false,
          branchSort: sort,
          traceSelected: vscode.workspace.getConfiguration('gitardo').get('graph.traceSelected') !== false,
          graphColumns: graphColumns(),
          dateSeparators: vscode.workspace.getConfiguration('gitardo').get('graph.dateSeparators') !== false,
          resolveWithAI: this.resolveWithAI(),
          home: this.repos.some((each) => samePath(each.root, state.root)) ? null : (this.home ?? null),
        });
        for (const resolve of waiting.splice(0)) resolve();
      }
    } catch (error) {
      this.log.error(errorText(error));
      this.setState(null);
    } finally {
      // In the same turn as the last look at `dirty`, so that no request can fall between the two.
      this.dirty = false;
      this.loading = undefined;
      for (const resolve of [...waiting, ...this.waiters.splice(0)]) resolve();
      task.end();
    }
    void this.refreshPulls(false);
  }

  /** What the status bar says the repository is read for, by the name the list of repositories gives it. */
  private readTitle(repo: Repo): string {
    const name = this.repos.find((each) => samePath(each.root, repo.root))?.name ?? path.basename(repo.root);
    const searching = this.filter?.kind === 'pickaxe' || this.filter?.kind === 'regex';
    return `${searching ? 'Searching' : 'Reading'} ${name}`;
  }

  /** Resolving conflicts without choosing a side is experimental: nothing of it is offered, or run, until it is switched on. */
  private autoResolve(): boolean {
    return vscode.workspace.getConfiguration('gitardo').get<boolean>('conflicts.autoResolve') === true;
  }

  /** Asking a language model how to resolve conflicts is experimental too, with a setting of its own. */
  private resolveWithAI(): boolean {
    return vscode.workspace.getConfiguration('gitardo').get<boolean>('conflicts.ai') === true;
  }

  /**
   * Opens the tab where what is proposed for the conflicts is looked at, of these files or of all of them, or shows the
   * one open. With `ai` the language model is asked about the conflicts the rules leave.
   */
  async reviewConflicts(paths?: string[], ai = false): Promise<void> {
    const repo = (await this.requireState()) && this.repo;
    if (!repo) return;
    if (!this.autoResolve() && !this.resolveWithAI()) {
      void vscode.window
        .showInformationMessage('Gitardo: resolving conflicts automatically is experimental, and it is switched off in the settings.', 'Open Settings')
        .then((choice) => choice && vscode.commands.executeCommand('workbench.action.openSettings', 'gitardo.conflicts'));
      return;
    }
    const wanted = paths?.filter((file) => typeof file === 'string');
    if (this.reviewTab && samePath(this.reviewTab.repo.root, repo.root)) this.reviewTab.reveal(wanted);
    else {
      this.reviewTab?.dispose();
      const host = {
        attach: (webview: vscode.Webview, kind: ViewKind, data: Record<string, string>) => this.attach(webview, kind, data),
        post: (message: HostMessage, webview: vscode.Webview) => this.post(message, webview),
        write: (on: Repo, op: GitOp, files: string[]) => this.writeResolutions(on, op, files),
        settings: () => ({ rules: this.autoResolve(), ai: this.resolveWithAI() }),
      };
      const tab: ConflictReviewTab = new ConflictReviewTab(host, repo, wanted, () => {
        this.pinned.delete(tab.webview);
        if (this.reviewTab === tab) this.reviewTab = undefined;
      });
      this.reviewTab = tab;
      this.pinned.set(tab.webview, repo);
      await tab.reload();
    }
    if (ai) await this.reviewTab?.ask();
  }

  /** Opens a file in conflict where it is resolved by hand: the Flow Merge, the merge editor of VS Code, or the file itself at a line. */
  private async openConflict(repo: Repo, file: string, line: number, editor: 'flowMerge' | 'mergeEditor' | 'text'): Promise<void> {
    if (typeof file !== 'string' || !(await repo.conflicted()).includes(file)) return;
    const uri = vscode.Uri.file(path.join(repo.root, file));
    try {
      if (editor === 'flowMerge') return void (await vscode.commands.executeCommand('gitardo.openInFlowMerge', uri));
      const stages = await repo.conflictStages(file);
      // The merge editor needs all three sides: a file both sides added has no base.
      if (editor === 'mergeEditor' && [1, 2, 3].every((stage) => stages.includes(stage))) {
        return await openMergeEditor(repo.root, file, await repo.operation().catch(() => null));
      }
    } catch (error) {
      this.log.warn(`Could not open ${file} to resolve it: ${errorText(error)}`);
    }
    const at = Math.max(0, (Number(line) || 1) - 1);
    await vscode.window.showTextDocument(uri, { selection: new vscode.Range(at, 0, at, 0), preview: false });
  }

  /** Writes resolutions of conflicts, with the way back, and says what is left. */
  private async writeResolutions(repo: Repo, op: GitOp, files: string[]): Promise<boolean> {
    const top = (await repo.reflog('HEAD', 1).catch(() => []))[0];
    if (!(await this.run(op, { repo })).ok) return false;
    if (this.repo && samePath(this.repo.root, repo.root)) this.undoable = { reflogTop: top ? `${top.hash} ${top.subject}` : '', op: restoreConflictsOp(files) };
    return true;
  }

  /** A search git cannot run, such as an invalid regular expression, is reported and dropped rather than taking the graph down. */
  private async readState(repo: Repo): Promise<RepoState> {
    const resolve = this.autoResolve();
    const stashes = vscode.workspace.getConfiguration('gitardo').get('graph.showStashes') !== false;
    repo.firstParent = vscode.workspace.getConfiguration('gitardo').get('graph.firstParent') === true;
    if (!this.filter) return repo.state(this.limit, null, this.scope, resolve, stashes);
    try {
      return await repo.state(this.limit, this.filter, this.scope, resolve, stashes);
    } catch (error) {
      this.filter = null;
      const text = error instanceof GitError ? error.result.stderr.trim() : errorText(error);
      this.log.error(text);
      void vscode.window.showErrorMessage(`Gitardo: the search failed. ${text.split('\n')[0]}`);
      return repo.state(this.limit, null, this.scope, resolve, stashes);
    }
  }

  /** Narrows the graph to the history of some branches, or shows them all again. What the filter does is left to it. */
  async setScope(scope: Scope | null): Promise<void> {
    if (!this.located) await this.locate();
    // As it is given: reading the repository leaves out what is not a branch of it.
    this.scope = scope && typeof scope === 'object' ? scope : null;
    this.limit = pageSize();
    await this.reload('filter');
  }

  /**
   * Reads the graph again, or does what ends with that, telling the views what for while they wait. Reads that overlap
   * are one wait: the views are told it is over when the last of them is, and what for by the first.
   */
  private async reload(what: Loading, work = () => this.refresh()): Promise<void> {
    if (this.waiting) this.waiting.count++;
    else {
      this.waiting = { what, count: 1 };
      this.post({ type: 'loading', what });
    }
    try {
      await work();
    } finally {
      if (!--this.waiting!.count) {
        this.waiting = null;
        this.post({ type: 'loading', what: null });
      }
    }
  }

  /** The scope as git took it, without the branches deleted since they were chosen, is the one in use and the one remembered. */
  private settleScope(root: string, scope: Scope | null): void {
    this.scope = scope;
    const all = this.memento.get<Record<string, Scope>>(SCOPE_KEY, {});
    if (JSON.stringify(all[root] ?? null) === JSON.stringify(scope)) return;
    const others = Object.fromEntries(Object.entries(all).filter(([other]) => other !== root));
    void this.memento.update(SCOPE_KEY, scope ? { ...others, [root]: scope } : others);
  }

  /** The favorites of a repository that are still branches of it, by their full names. */
  private favorites(state: Pick<RepoState, 'root' | 'branches' | 'remoteBranches'>): string[] {
    const known = new Set([...state.branches.map((branch) => `refs/heads/${branch.name}`), ...state.remoteBranches.map((ref) => `refs/remotes/${ref.name}`)]);
    const stored: unknown = this.memento.get<Record<string, unknown>>(FAVORITES_KEY, {})[state.root];
    return Array.isArray(stored) ? stored.filter((ref): ref is string => typeof ref === 'string' && known.has(ref)) : [];
  }

  /** Marks a branch as a favorite, or no longer. Nothing of the repository changes: the views are told at once. */
  async setFavorite(ref: string, favorite: boolean): Promise<void> {
    const state = await this.requireState();
    if (!state || typeof ref !== 'string') return;
    // The ones whose branch is gone are forgotten as soon as there is something to save.
    const others = this.favorites(state).filter((other) => other !== ref);
    const next = favorite ? [...others, ref] : others;
    await this.memento.update(FAVORITES_KEY, { ...this.memento.get<Record<string, unknown>>(FAVORITES_KEY, {}), [state.root]: next });
    if (this.state?.root === state.root) this.setState({ ...this.state, favorites: this.favorites(this.state) });
  }

  /** Narrows the graph to the history of a file or to a search, or shows everything again. */
  async setFilter(filter: Filter | null): Promise<void> {
    if (!this.located) await this.locate();
    this.filter = filter;
    this.limit = pageSize();
    // Searching inside the changes of every commit can take a while on a large repository.
    const slow = filter?.kind === 'pickaxe' || filter?.kind === 'regex';
    if (slow) this.post({ type: 'busy', title: 'Searching' });
    try {
      await this.reload('filter');
    } finally {
      if (slow) this.post({ type: 'busy', title: null });
    }
  }

  /** Shows the commits that touched a file: the given one, or the one in the active editor. */
  async fileHistory(uri = vscode.window.activeTextEditor?.document.uri): Promise<void> {
    if (!(await this.requireState())) return;
    if (uri?.scheme === 'file') await this.showRepoOf(uri);
    if (!this.repo) return;
    const file = uri?.scheme === 'file' ? path.relative(this.repo.root, uri.fsPath).replace(/\\/g, '/') : '';
    if (!file || file.startsWith('..') || path.isAbsolute(file)) {
      void vscode.window.showWarningMessage('Gitardo: open a file of this repository to see its history.');
      return;
    }
    await vscode.commands.executeCommand('gitardo.graph.focus');
    await this.setFilter({ kind: 'path', path: file });
  }

  /** In a workspace with several repositories a file decides which one to show: the innermost one that contains it. */
  private async showRepoOf(uri: vscode.Uri): Promise<void> {
    const contains = (root: string) => {
      const relative = path.relative(root, uri.fsPath);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    };
    const owner = this.repos.filter((repo) => contains(repo.root)).sort((a, b) => b.root.length - a.root.length)[0];
    if (owner) await this.selectRepo(owner.root);
  }

  /**
   * Stashes from the list of changes VS Code keeps, in the repository these files are of: the files themselves, only
   * what is staged, or everything.
   */
  async stashFromScm(uris: vscode.Uri[], what: 'files' | 'staged' | 'all'): Promise<void> {
    if (!(await this.requireState())) return;
    const local = uris.filter((uri) => uri.scheme === 'file');
    if (local[0]) await this.showRepoOf(local[0]);
    const { state, repo } = this;
    if (!state || !repo) return;
    if (what !== 'files') return this.action({ kind: 'stashPush', staged: what === 'staged' || undefined });
    const files = local
      .map((uri) => path.relative(repo.root, uri.fsPath).replace(/\\/g, '/'))
      .filter((file) => file && !file.startsWith('..') && !path.isAbsolute(file));
    if (!files.length) return;
    // A renamed file is stashed with the name it had, or git would leave half of the rename behind.
    const before = new Map([...state.working.staged, ...state.working.unstaged].map((change) => [change.path, change.oldPath]));
    const paths = [...new Set(files.flatMap((file) => [file, before.get(file)]).filter((file) => file !== undefined))];
    return this.action({ kind: 'stashPush', paths });
  }

  /** Selects a commit in the graph, opening the graph first if needed. `hash` is the full one. */
  async reveal(hash: string): Promise<void> {
    if (!isHash(hash)) return;
    await vscode.commands.executeCommand('gitardo.graph.focus');
    await this.include(hash);
    // Only now: a view that loads in the meantime would be told of a commit it has not been sent yet.
    this.pendingReveal = hash;
    this.flushPending();
  }

  /**
   * Makes sure a commit is among the ones listed. The history is loaded as far back as it is; what narrows the list
   * gives way if it leaves the commit out; and a commit that no branch or tag reaches any more, such as one found in
   * the reflog, is shown with its own history.
   */
  private async include(hash: string): Promise<void> {
    if (!this.located) await this.locate();
    const repo = this.repo;
    if (!repo || this.state?.rows.some((row) => row.hash === hash)) return;
    const shown = this.filter;
    const scope = this.scope;
    let index = await repo.position(hash, shown, scope);
    if (index < 0 && shown) {
      this.filter = null;
      index = await repo.position(hash, null, scope);
    }
    // On a branch that is not among the ones shown: they are all shown again.
    if (index < 0 && scope) {
      this.scope = null;
      index = await repo.position(hash);
    }
    if (index < 0) {
      this.filter = { kind: 'ref', ref: hash, lost: true };
      index = 0;
    }
    const page = pageSize();
    const pages = Math.floor(index / page) + 1;
    const same = this.filter === shown && this.scope === scope;
    this.limit = Math.max(same ? this.limit : page, pages * page);
    await this.reload(same ? 'more' : 'filter');
  }

  /** Selects, in the view that asked, the commit that a hash or anything else git understands stands for. */
  private async goTo(revision: unknown, asker: vscode.Webview): Promise<void> {
    const repo = this.repo;
    if (!repo || typeof revision !== 'string' || !revision.trim()) return;
    const hash = await repo.resolve(revision.trim());
    if (!hash) {
      // A few characters can be the start of more than one hash, which git refuses to choose between.
      void vscode.window.showWarningMessage(`Gitardo: "${revision.trim()}" is not a commit of this repository, or is the start of several.`);
      return;
    }
    await this.include(hash);
    this.post({ type: 'reveal', hash }, asker);
  }

  /**
   * Opens a commit in an editor tab of its own, with its message, its files and what it changed in them, or shows the
   * tab it has already. Without a hash it asks for one, or for anything else git understands.
   */
  async openCommit(hash?: unknown, repo = this.repo): Promise<void> {
    if (hash === undefined) {
      repo = ((await this.requireState()) && this.repo) || undefined;
      hash = repo && (await this.askRevision(repo, 'Open commit'))?.hash;
    }
    if (!repo || !isHash(hash)) return;
    const detail = await repo.commitDetail(hash).catch(() => null);
    if (!detail) {
      void vscode.window.showWarningMessage(`Gitardo: ${hash.slice(0, 7)} is not a commit of this repository.`);
      return;
    }
    const key = `${repo.root}\n${detail.hash}`;
    const open = this.commitTabs.get(key);
    if (open) return open.reveal();

    const subject = detail.subject.length > TITLE_LENGTH ? `${detail.subject.slice(0, TITLE_LENGTH).trimEnd()}…` : detail.subject;
    const panel = vscode.window.createWebviewPanel('gitardo.commit', `${detail.hash.slice(0, 7)} ${subject}`, vscode.ViewColumn.Active, {
      retainContextWhenHidden: true,
      // The search of VS Code, for a word among the changes.
      enableFindWidget: true,
    });
    const layout = this.memento.get<FilesLayout>(FILES_KEY, 'tree');
    // Kept at hand: a panel that is closed no longer says which webview was its own.
    const { webview } = panel;
    const attachment = this.attach(webview, 'commit', { commit: detail.hash, root: repo.root, files: layout });
    this.pinned.set(webview, repo);
    this.commitTabs.set(key, panel);
    panel.onDidDispose(() => {
      attachment.dispose();
      this.pinned.delete(webview);
      this.commitTabs.delete(key);
    });
  }

  /**
   * Opens the tab where what new worktrees get of what git ignores is chosen, for the repository the views show, or
   * shows the one open for it.
   */
  async openWorktreeSetup(): Promise<void> {
    const repo = (await this.requireState()) && this.repo;
    if (!repo) return;
    // Once it has been seen, creating a worktree no longer offers it.
    void this.memento.update(SETUP_OFFERED, true);
    if (this.setupTab && samePath(this.setupTab.repo.root, repo.root)) return this.setupTab.panel.reveal();
    this.setupTab?.panel.dispose();

    const panel = vscode.window.createWebviewPanel('gitardo.worktreeSetup', `New Worktrees · ${path.basename(repo.root)}`, vscode.ViewColumn.Active, {
      retainContextWhenHidden: true,
    });
    const { webview } = panel;
    const tab = { panel, repo, entries: null as IgnoredEntry[] | null, saving: false };
    this.setupTab = tab;
    const attachment = this.attach(webview, 'worktreeSetup', { root: repo.root });
    this.pinned.set(webview, repo);
    // Settings changed elsewhere, in the Settings editor or settings.json, show here at once.
    const watching = vscode.workspace.onDidChangeConfiguration((event) => {
      const sections = ['gitardo.worktrees.linkFolders', 'gitardo.worktrees.copyFiles', 'git.worktreeSymlinkFolders', 'git.worktreeIncludeFiles'];
      if (tab.saving) return;
      if (sections.some((section) => event.affectsConfiguration(section, vscode.Uri.file(repo.root)))) void this.sendSetup(webview, false);
    });
    panel.onDidDispose(() => {
      attachment.dispose();
      watching.dispose();
      this.pinned.delete(webview);
      if (this.setupTab === tab) this.setupTab = undefined;
    });
  }

  /** Sends the tab of the setup of new worktrees what it shows, looking again at what git ignores when `rescan`. */
  private async sendSetup(webview: vscode.Webview, rescan: boolean): Promise<void> {
    const tab = this.setupTab;
    if (!tab || tab.panel.webview !== webview) return;
    const { root } = tab.repo;
    try {
      if (rescan || !tab.entries) tab.entries = await scanIgnored(root);
      // The other worktrees can be given what applies only while the views show this repository, which that runs in.
      const state = this.state && samePath(this.state.root, root) ? this.state : null;
      const others = state?.worktrees.filter((worktree) => !worktree.prunable && !samePath(worktree.path, root)).length ?? 0;
      this.post({ type: 'worktreeSetup', info: { ...worktreeSetupInfo(root, others), entries: tab.entries } }, webview);
    } catch (error) {
      this.log.error(errorText(error));
      this.post({ type: 'worktreeSetup', info: null, error: errorText(error) }, webview);
    }
  }

  /** Asks for a hash or a revision, and shows its commit in the graph. */
  async goToCommit(): Promise<void> {
    const repo = (await this.requireState()) && this.repo;
    if (!repo) return;
    const commit = await this.askRevision(repo, 'Go to commit');
    if (commit) await this.reveal(commit.hash);
  }

  /** Tells a view which commits a search finds in the history that is shown, for it to highlight them where they are. */
  private async find(search: Search, asker: vscode.Webview): Promise<void> {
    const repo = this.repo;
    const kinds = ['message', 'author', 'pickaxe', 'regex'];
    if (!repo || !kinds.includes(search?.kind) || typeof search.query !== 'string' || !search.query) return;
    try {
      // A list of results gives way to the graph, in which the new ones are to be shown.
      if (this.filter && 'query' in this.filter) await this.setFilter(null);
      const found = await repo.matches({ kind: search.kind, query: search.query }, this.filter, FOUND_LIMIT, this.scope);
      this.post({ type: 'found', search, ...found }, asker);
    } catch (error) {
      const text = error instanceof GitError ? error.result.stderr.trim() : errorText(error);
      this.log.error(text);
      void vscode.window.showErrorMessage(`Gitardo: the search failed. ${text.split('\n')[0]}`);
      this.post({ type: 'found', search, hashes: [], more: false, failed: true }, asker);
    }
  }

  /** Selects a commit in the views that list commits and are there, without opening any or taking the focus. */
  private show(hash: string): void {
    if (!isHash(hash)) return;
    for (const [view, kind] of this.views) if (showsGraph(kind)) this.post({ type: 'reveal', hash }, view);
  }

  /** Brings out the history of a commit in the views of the graph, or no longer, while the pointer rests on its branch. */
  private trace(hash: string | null): void {
    if (hash !== null && !isHash(hash)) return;
    for (const [view, kind] of this.views) if (showsGraph(kind)) this.post({ type: 'trace', hash }, view);
  }

  /** Hands over what was waiting for a graph view to be there. */
  private flushPending(): void {
    const views = (wanted: (kind: ViewKind) => boolean) => [...this.views].filter(([, kind]) => wanted(kind)).map(([view]) => view);
    const lists = views(showsGraph);
    if (this.pendingReveal && lists.length) {
      for (const view of lists) this.post({ type: 'reveal', hash: this.pendingReveal }, view);
      this.pendingReveal = undefined;
    }
  }

  /**
   * Compares two branches, tags or commits, or one with the working tree, in a tab, asking which. With `from`, only
   * the other side is asked. The first question also offers the comparisons opened last.
   */
  async compare(from?: ComparedRef): Promise<void> {
    const state = await this.requireState();
    const repo = this.repo;
    if (!state || !repo) return;
    try {
      const given = from && isSide(from.hash) && typeof from.name === 'string' ? { name: from.name, hash: from.hash } : undefined;
      const first =
        given ??
        (await this.pickRevision(state, repo, 'Compare', 'The branch, tag or commit to start from, or a comparison opened before', {
          worktree: true,
          recent: this.recentComparisons(repo),
        }));
      if (!first) return;
      if ('to' in first) return await this.openRecent(first, repo);
      const second = await this.pickRevision(state, repo, `Compare ${first.name} with`, 'The branch, tag or commit to compare it with', {
        other: first,
        worktree: true,
      });
      if (!second || 'to' in second) return;
      await this.openCompare(first, second, repo);
    } catch (error) {
      void vscode.window.showErrorMessage(`Gitardo: ${errorText(error)}`);
    }
  }

  /**
   * Compares a file or a folder as it is in the working tree with a branch, tag or commit, asking which: the given
   * one, or the file in the active editor.
   */
  async compareWith(uri = vscode.window.activeTextEditor?.document.uri): Promise<void> {
    if (!(await this.requireState())) return;
    if (uri?.scheme === 'file') await this.showRepoOf(uri);
    const { state, repo } = this;
    if (!state || !repo) return;
    const file = uri?.scheme === 'file' ? path.relative(repo.root, uri.fsPath).replace(/\\/g, '/') : '';
    if (!uri || file.startsWith('..') || path.isAbsolute(file)) {
      void vscode.window.showWarningMessage('Gitardo: choose a file or a folder of this repository to compare.');
      return;
    }
    try {
      const name = file || path.basename(repo.root);
      const picked = await this.pickRevision(state, repo, `Compare ${name} with`, 'The branch, tag or commit to compare the working tree with');
      if (!picked || 'to' in picked) return;
      await this.openCompare(picked, WORKTREE_SIDE, repo, file || null);
    } catch (error) {
      void vscode.window.showErrorMessage(`Gitardo: ${errorText(error)}`);
    }
  }

  /**
   * Has new worktrees get the files and folders chosen in the Explorer linked, copied, or nothing by a pattern of their
   * own path, in the settings that apply to the repository each one is in, and says what became of each.
   */
  async setUpFromExplorer(choice: SetupChoice, chosen: vscode.Uri[]): Promise<void> {
    if (!this.located) await this.locate();
    const owner = (uri: vscode.Uri) => {
      const inside = this.repos.filter((repo) => {
        const relative = path.relative(repo.root, uri.fsPath);
        return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
      });
      return inside.sort((a, b) => b.root.length - a.root.length)[0];
    };
    const said: string[] = [];
    let changed = 0;
    let saved: SetupTarget | undefined;
    const byRepo = new Map<string, vscode.Uri[]>();
    for (const uri of chosen.filter((each) => each.scheme === 'file')) {
      const repo = owner(uri);
      if (!repo) said.push(`${path.basename(uri.fsPath)} is in no repository of the workspace.`);
      else byRepo.set(repo.root, [...(byRepo.get(repo.root) ?? []), uri]);
    }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Gitardo: looking at what git ignores' }, async () => {
        for (const [root, uris] of byRepo) {
          const { linkFrom, copyFrom, ...before } = setupPatterns(root);
          let patterns: SetupPatterns = before;
          for (const uri of uris) {
            const entry = { path: path.relative(root, uri.fsPath).split(path.sep).join('/'), folder: ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0 };
            const result = await changeSetup(root, entry, choice, patterns);
            patterns = result.patterns;
            if (result.change.kind === 'done' || result.change.kind === 'still') changed++;
            said.push(setupChangeText(entry.path, entry.folder, choice, result.change));
          }
          for (const [kind, from] of [['link', linkFrom], ['copy', copyFrom]] as const) {
            const same = patterns[kind].length === before[kind].length && patterns[kind].every((pattern, index) => pattern === before[kind][index]);
            if (!same) saved = await savePatterns(root, kind, patterns[kind], from);
          }
        }
      });
    } catch (error) {
      said.push(errorText(error));
    }
    if (!said.length) return;
    const where = saved && ` Saved in the settings of ${saved === 'user' ? 'the user' : 'the workspace folder'}.`;
    const text = `Gitardo: ${said.join(' ')}${where ?? ''}`;
    const open = 'Choose What New Worktrees Get…';
    const show = changed ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    if ((await show(text, open)) !== open) return;
    const [first] = byRepo.values();
    if (first) await this.showRepoOf(first[0]);
    await this.openWorktreeSetup();
  }

  /** Opens a comparison opened before, its branches where they are now. */
  private async openRecent(recent: RecentComparison, repo: Repo): Promise<void> {
    const now = async (ref: ComparedRef): Promise<ComparedRef> =>
      ref.hash === WORKTREE || ref.hash.startsWith(ref.name) ? ref : { name: ref.name, hash: (await repo.resolve(ref.name)) ?? ref.hash };
    await this.openCompare(await now(recent.from), await now(recent.to), repo, recent.path ?? null);
  }

  /**
   * Opens the comparison of two branches, tags or commits, or of one with the working tree, in a tab of its own, or
   * shows the tab it has. With `path`, only that file or folder.
   */
  async openCompare(from: ComparedRef, to: ComparedRef, repo = this.repo, path: string | null = null): Promise<void> {
    if (!repo || !isSide(from?.hash) || !isSide(to?.hash) || (from.hash === WORKTREE && to.hash === WORKTREE)) return;
    const narrowed = cleanPath(path);
    const [first, second] = await Promise.all([this.compareSide(repo, from), this.compareSide(repo, to)]);
    this.rememberComparison(repo, first, second, narrowed);
    const same = (a: CompareSide, b: CompareSide) => a.name === b.name && a.live === b.live && (a.live || a.hash === b.hash);
    for (const tab of this.compareTabs.values()) {
      if (samePath(tab.repo.root, repo.root) && same(tab.from, first) && same(tab.to, second) && tab.path === narrowed) return tab.panel.reveal();
    }

    const panel = vscode.window.createWebviewPanel('gitardo.compare', compareTitle(first, second, narrowed), vscode.ViewColumn.Active, {
      retainContextWhenHidden: true,
      // The search of VS Code, for a word among the changes.
      enableFindWidget: true,
    });
    const { webview } = panel;
    const tab: CompareTab = { panel, repo, from: first, to: second, mode: compareMode(first, second), path: narrowed };
    const attachment = this.attach(webview, 'compare', { root: repo.root, files: this.memento.get<FilesLayout>(FILES_KEY, 'tree') });
    this.pinned.set(webview, repo);
    this.compareTabs.set(webview, tab);
    panel.onDidDispose(() => {
      attachment.dispose();
      this.pinned.delete(webview);
      this.compareTabs.delete(webview);
    });
  }

  /**
   * A side of a comparison: followed when git gives its name the commit it was chosen at, fixed when it is a hash. The
   * working tree is followed as it changes.
   */
  private async compareSide(repo: Repo, ref: ComparedRef): Promise<CompareSide> {
    if (ref.hash === WORKTREE) return { name: WORKTREE_SIDE.name, hash: WORKTREE, live: true };
    const name = typeof ref.name === 'string' && ref.name ? ref.name : ref.hash.slice(0, 7);
    // A name that git reads as another commit, a tag that has the name of a branch, stands for the one chosen.
    const live = !ref.hash.startsWith(name) && (await repo.resolve(name)) === ref.hash;
    return { name, hash: ref.hash, live };
  }

  /** The comparisons opened last in a repository, the latest first. */
  private recentComparisons(repo: Repo): RecentComparison[] {
    return this.memento.get<Record<string, RecentComparison[]>>(RECENT_KEY, {})[repo.root] ?? [];
  }

  private rememberComparison(repo: Repo, from: CompareSide, to: CompareSide, path: string | null): void {
    const all = this.memento.get<Record<string, RecentComparison[]>>(RECENT_KEY, {});
    const entry: RecentComparison = { from: { name: from.name, hash: from.hash }, to: { name: to.name, hash: to.hash }, ...(path ? { path } : {}) };
    // The two ways of a comparison are one: the last is kept.
    const same = (other: RecentComparison) =>
      (other.path ?? null) === path &&
      ((other.from.name === from.name && other.to.name === to.name) || (other.from.name === to.name && other.to.name === from.name));
    const list = [entry, ...(all[repo.root] ?? []).filter((other) => !same(other))].slice(0, RECENT_COMPARISONS);
    void this.memento.update(RECENT_KEY, { ...all, [repo.root]: list });
  }

  /**
   * Sends the tab of a comparison what it shows, once its sides are looked up again, and then the lines of its files.
   * Nothing is sent when it shows that already, unless `again`; a comparison with the working tree is read again
   * whenever the repository is.
   */
  private async sendCompare(tab: CompareTab, again = false): Promise<void> {
    const { panel, repo } = tab;
    const { webview } = panel;
    // Its repository is read again only while the other views show it.
    if (!again && !(this.state && samePath(this.state.root, repo.root))) return;
    // A tab closed while git answered is not there to be told.
    const open = () => this.compareTabs.get(webview) === tab;
    try {
      for (const side of [tab.from, tab.to]) {
        if (!side.live || side.hash === WORKTREE) continue;
        const hash = await repo.resolve(side.name);
        if (!hash) side.gone = true;
        else {
          side.hash = hash;
          delete side.gone;
        }
      }
      const { from, to, mode, path } = tab;
      const changing = from.hash === WORKTREE || to.hash === WORKTREE;
      const key = `${from.hash} ${to.hash} ${mode} ${from.gone} ${to.gone} ${path}`;
      if (!open() || (!again && !changing && tab.shown === key)) return;
      tab.shown = key;
      panel.title = compareTitle(from, to, path);
      // What the user changed shows a wait until it is compared; the working tree compared again as it changes does not.
      if (again) this.post({ type: 'loading', what: 'filter' }, webview);
      const found = await this.activity.track(`Comparing ${panel.title}`, () => repo.compareSides(from.hash, to.hash, mode, path));
      // The sides changed again meanwhile: the answer for them is the one to send, and the end of any wait.
      if (tab.shown !== key || !open()) return;
      this.post({ type: 'loading', what: null }, webview);
      if (!found) return this.post({ type: 'compareView', view: null, error: 'These are not commits of this repository.' }, webview);
      tab.since = found.since;
      this.post({ type: 'compareView', view: { from: { ...from }, to: { ...to }, mode, ...found } }, webview);
      const patch = await repo.comparePatch(found.files, found.since, to.hash, PATCH_LINES, path).catch(() => null);
      if (tab.shown === key && open()) this.post({ type: 'comparePatch', since: found.since, to: to.hash, patch }, webview);
    } catch (error) {
      tab.shown = undefined;
      if (!open()) return;
      this.log.error(errorText(error));
      this.post({ type: 'loading', what: null }, webview);
      this.post({ type: 'compareView', view: null, error: errorText(error) }, webview);
    }
  }

  /** Lets the user choose one side of a comparison again, in its tab. */
  private async pickCompareSide(tab: CompareTab, which: 'from' | 'to'): Promise<void> {
    // The branches to choose from are of the repository of the tab, which the other views may no longer show.
    const state = this.state && samePath(this.state.root, tab.repo.root) ? this.state : await tab.repo.state(1).catch(() => null);
    if (!state) return;
    const other = which === 'from' ? tab.to : tab.from;
    const title = which === 'from' ? `Compare with ${other.name}` : `Compare ${other.name} with`;
    const picked = await this.pickRevision(state, tab.repo, title, `The branch, tag or commit to put in place of ${tab[which].name}`, {
      other,
      worktree: other.hash !== WORKTREE,
    });
    if (!picked || 'to' in picked) return;
    tab[which] = await this.compareSide(tab.repo, picked);
    // As when the tab opened.
    tab.mode = compareMode(tab.from, tab.to);
    this.rememberComparison(tab.repo, tab.from, tab.to, tab.path);
    await this.sendCompare(tab, true);
  }

  /**
   * Makes a file in the working tree and the index what the second side of a comparison has: its version of the file,
   * or no file when it has none.
   */
  private async takeCompareFile(tab: CompareTab, file: FileChange): Promise<void> {
    const { to, repo } = tab;
    if (to.hash === WORKTREE || typeof file?.path !== 'string' || !file.path) return;
    // What is not committed in the file is lost: when that cannot be told, it is assumed.
    const state = this.state && samePath(this.state.root, repo.root) ? this.state : null;
    const changed = !state || allChanges(state.working).some((change) => change.path === file.path);
    try {
      await this.run(takeFileOp(file.path, to.name, to.hash, file.status === 'D', changed), { repo });
    } catch (error) {
      void vscode.window.showErrorMessage(`Gitardo: ${errorText(error)}`);
    }
  }

  /** Copies the changes of a comparison as a patch that `git apply` takes. */
  private async copyComparePatch(tab: CompareTab): Promise<void> {
    if (!tab.since) return;
    const text = await tab.repo.compareText(tab.since, tab.to.hash, tab.path).catch(() => '');
    if (!text) {
      void vscode.window.showInformationMessage('Gitardo: there are no changes to copy.');
      return;
    }
    await vscode.env.clipboard.writeText(text);
    const files = text.match(/^diff --git /gm)?.length ?? 0;
    void vscode.window.showInformationMessage(`Gitardo: copied the changes of ${files} ${files === 1 ? 'file' : 'files'} as a patch.`);
  }

  /**
   * Opens the comparison on GitHub, each side by the name it has there: a branch by its upstream there, a remote
   * branch of that remote and a tag by their names, anything else by its commit, which GitHub knows once it is pushed.
   */
  private async openCompareOnGitHub(tab: CompareTab): Promise<void> {
    const { state, github, githubRemote } = this;
    const { from, to, mode } = tab;
    if (!state || !github || !samePath(state.root, tab.repo.root) || from.hash === WORKTREE || to.hash === WORKTREE) return;
    const there = (side: CompareSide) => {
      if (!side.live || side.gone) return side.hash;
      const branch = state.branches.find((candidate) => candidate.name === side.name);
      if (branch) return branch.upstream && !branch.upstream.gone && branch.upstream.remote === githubRemote ? branch.upstream.branch : side.hash;
      const prefix = `${githubRemote}/`;
      if (side.name.startsWith(prefix) && state.remoteBranches.some((ref) => ref.name === side.name)) return side.name.slice(prefix.length);
      if (state.tags.some((tag) => tag.name === side.name)) return side.name;
      return side.hash;
    };
    await vscode.env.openExternal(vscode.Uri.parse(compareRangeUrl(github, there(from), there(to), mode === 'diverged' ? '...' : '..')));
  }

  /** Lets the user choose a branch or a tag, or type anything git can turn into a commit: a hash, `HEAD~3`, `v1.0^`. */
  private async pickRevision(
    state: RepoState,
    repo: Repo,
    title: string,
    placeHolder: string,
    options: {
      /** The side chosen already, which is not offered again. */
      other?: ComparedRef;
      /** Offers the working tree too. */
      worktree?: boolean;
      /** Comparisons to open again, offered first. */
      recent?: RecentComparison[];
    } = {},
  ): Promise<ComparedRef | RecentComparison | undefined> {
    const { other, worktree, recent = [] } = options;
    type Item = vscode.QuickPickItem & { ref?: ComparedRef; recent?: RecentComparison };
    const group = (label: string, refs: { name: string; hash: string }[], icon: string): Item[] =>
      refs.length
        ? [
            { label, kind: vscode.QuickPickItemKind.Separator },
            ...refs.map((ref) => ({ label: `$(${icon}) ${ref.name}`, description: ref.hash.slice(0, 7), ref: { name: ref.name, hash: ref.hash } })),
          ]
        : [];
    const items: Item[] = recent.length
      ? [
          { label: 'Opened before', kind: vscode.QuickPickItemKind.Separator },
          ...recent.map((entry) => ({ label: `$(history) ${entry.from.name} ↔ ${entry.to.name}`, description: entry.path, recent: entry })),
          { label: '', kind: vscode.QuickPickItemKind.Separator },
        ]
      : [];
    items.push({ label: '$(edit) Enter a hash or a revision…', description: 'such as 1a2b3c4 or HEAD~3', alwaysShow: true });
    if (state.head) {
      const name = state.branch ?? 'HEAD';
      items.push({ label: `$(target) ${name}`, description: `${state.head.slice(0, 7)} · checked out`, ref: { name, hash: state.head } });
    }
    if (worktree && other?.hash !== WORKTREE) {
      items.push({ label: `$(files) ${WORKTREE_SIDE.name}`, description: 'with the changes not committed', ref: WORKTREE_SIDE });
    }
    items.push(
      ...group(
        'Branches',
        state.branches.filter((branch) => !branch.current),
        'git-branch',
      ),
      ...group('Remote branches', state.remoteBranches, 'cloud'),
      ...group('Tags', state.tags, 'tag'),
    );
    // Comparing something with itself shows nothing.
    const offered = items.filter((item) => !item.ref || item.ref.name !== other?.name || item.ref.hash !== other.hash);
    const choice = await vscode.window.showQuickPick(offered, { title, placeHolder, matchOnDescription: true });
    if (!choice) return;
    return choice.recent ?? choice.ref ?? this.askRevision(repo, title);
  }

  /** Lets the user type a hash, or anything else git can turn into a commit, and says which commit that is. */
  private async askRevision(repo: Repo, title: string): Promise<ComparedRef | undefined> {
    const revision = (
      await vscode.window.showInputBox({
        title,
        prompt: 'A commit hash, or anything else git understands: HEAD~3, v1.0^, main@{yesterday}',
        validateInput: async (value) =>
          !value.trim() || (await repo.resolve(value.trim())) ? undefined : 'Git does not know a commit by this name in this repository.',
      })
    )?.trim();
    if (!revision) return;
    // The box can be accepted before the last check has come back.
    const hash = await repo.resolve(revision);
    if (!hash) {
      void vscode.window.showWarningMessage(`Gitardo: "${revision}" is not a commit of this repository.`);
      return;
    }
    return { name: isHash(revision) ? hash.slice(0, 7) : revision, hash };
  }

  async command(command: UiCommand): Promise<void> {
    try {
      if (command === 'activeFileHistory') return await this.fileHistory();
      if (command === 'signInGitHub') return await this.refreshPulls(true, true);
      if (command === 'reflog') return await this.browseReflog();
      if (command === 'goToCommit') return await this.goToCommit();
      if (command === 'cleanupBranches') return await this.cleanupBranches();
      if (command === 'draftMessage') return await this.draftMessage();
      if (command === 'switchIdentity') return await this.switchIdentity();
      if (command === 'selectRepository') return await this.pickRepo();
      if (command === 'remotes') return await this.manageRemotes();
      if (command === 'switchWorktree') return await this.switchWorktree();
      if (command === 'worktreeSetup') return await this.openWorktreeSetup();
    } catch (error) {
      void vscode.window.showErrorMessage(`Gitardo: ${errorText(error)}`);
    }
  }

  /**
   * Lists the worktrees with how they stand: the branch against its upstream, the files not committed, the pull request.
   * The one picked opens where the settings say; the last entry creates another.
   */
  private async switchWorktree(): Promise<void> {
    const state = await this.requireState();
    if (!state) return;
    const create = { label: '$(add) Create worktree…', path: '', current: false };
    const worktrees = state.worktrees
      .filter((worktree) => !worktree.prunable)
      .map((worktree) => {
        const { ahead, pull } = worktreeStatus(worktree, state);
        const description = [
          [worktree.branch ?? `detached at ${worktree.hash.slice(0, 7)}`, ahead].filter(Boolean).join(' '),
          worktree.changes ? `$(edit) ${worktree.changes}` : undefined,
          pull && `$(git-pull-request) #${pull.number}`,
          worktree.current && 'this window',
        ];
        return {
          label: `$(${worktree.main ? 'home' : 'worktree'}) ${worktreeLabel(worktree.path, state.worktreesRoot)}`,
          description: description.filter(Boolean).join(' · '),
          detail: worktree.path,
          path: worktree.path,
          current: worktree.current,
        };
      });
    // The one open here is listed last: it is where the user already is.
    worktrees.sort((a, b) => Number(a.current) - Number(b.current));
    const picked = await vscode.window.showQuickPick([...worktrees, { label: '', kind: vscode.QuickPickItemKind.Separator, path: '', current: false }, create], {
      title: 'Switch Worktree',
      placeHolder: 'The worktree to open',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked || picked.current) return;
    await this.action(picked === create ? { kind: 'worktreeAdd' } : { kind: 'worktreeOpen', path: picked.path });
  }

  /** Lists where HEAD has been, and offers what can be done with the chosen position, even if no branch reaches it any more. */
  private async browseReflog(): Promise<void> {
    const state = await this.requireState();
    if (!state || !this.repo) return;
    const entries = await this.repo.reflog('HEAD', REFLOG_ENTRIES);
    const entry = await vscode.window.showQuickPick(
      entries.map((item) => ({
        label: item.subject,
        description: `${item.hash.slice(0, 7)} · ${item.selector}`,
        detail: new Date(item.date * 1000).toLocaleString(),
        item,
      })),
      { title: 'Reflog: where HEAD has been', placeHolder: 'Pick an entry to go back to it or recover it', matchOnDescription: true },
    );
    if (!entry) return;
    const { hash } = entry.item;
    const short = hash.slice(0, 7);
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Show in the graph', run: () => this.reveal(hash) },
        { label: 'Create branch here…', run: () => this.action({ kind: 'createBranch', at: hash }) },
        { label: `Reset ${state.branch ?? 'HEAD'} to here…`, run: () => this.action({ kind: 'reset', hash }) },
        { label: 'Check out (detached)', run: () => this.action({ kind: 'checkout', target: 'detached', ref: hash }) },
        { label: 'Cherry-pick', run: () => this.action({ kind: 'cherryPick', hash, isMerge: false }) },
      ],
      { title: `${short}: ${entry.item.subject}` },
    );
    await choice?.run();
  }

  /** Offers to delete the local branches that are merged into the current one, or whose upstream is gone. */
  private async cleanupBranches(): Promise<void> {
    const state = await this.requireState();
    if (!state || !this.repo) return;
    const merged = new Set(await this.repo.mergedBranches());
    // A branch that another worktree has goes with that worktree, except the main one, which git cannot remove.
    const candidates = state.branches.filter(
      (branch) => !branch.current && !worktreeOf(branch.name, state)?.main && (merged.has(branch.name) || branch.upstream?.gone),
    );
    if (!candidates.length) {
      void vscode.window.showInformationMessage('Gitardo: no local branches are merged or have lost their upstream.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      candidates.map((branch) => {
        const worktree = worktreeOf(branch.name, state);
        const dirty = !!worktree?.changes;
        const why = merged.has(branch.name) ? `merged into ${state.branch ?? 'HEAD'}` : 'upstream is gone, not merged';
        const where =
          worktree &&
          (worktree.prunable
            ? 'with its missing worktree'
            : `with its worktree ${worktreeLabel(worktree.path, state.worktreesRoot)}${dirty ? `, ${changesText(worktree.changes)}` : ''}`);
        return {
          label: branch.name,
          description: [why, where].filter(Boolean).join(' · '),
          // Unmerged branches can lose commits, and worktrees their files not committed: those are left for the user to tick.
          picked: merged.has(branch.name) && !dirty,
          branch,
          worktree,
        };
      }),
      { title: 'Clean up branches', placeHolder: 'Branches to delete, with their worktrees', canPickMany: true },
    );
    if (!picked?.length) return;
    const names = (wanted: boolean) => picked.filter((item) => merged.has(item.branch.name) === wanted).map((item) => item.branch.name);
    const worktrees = picked.flatMap(({ worktree }) => (worktree ? [{ path: worktree.path, dirty: !!worktree.changes, prunable: worktree.prunable }] : []));
    const op = cleanupBranchesOp(names(true), names(false), worktrees);
    if (worktrees.length) {
      op.prepare = async (log) => {
        await closeInVSCodeGit(worktrees.filter((worktree) => !worktree.prunable).map((worktree) => worktree.path), log);
        for (const worktree of worktrees) if (!worktree.prunable) await unlinkFolderLinks(worktree.path, log);
      };
      op.recover = recoverHeldWorktree(state.root);
      op.finish = async () => {
        for (const worktree of worktrees) await removeEmptyParents(worktree.path, state);
      };
    }
    await this.run(op);
  }

  /** Asks the language model for a commit message and hands it to the Changes view. */
  private async draftMessage(): Promise<void> {
    const state = await this.requireState();
    const repo = this.repo;
    if (!state || !repo) return;
    this.post({ type: 'drafting', active: true });
    try {
      const message = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Gitardo: drafting commit message', cancellable: true },
        (_progress, token) => draftCommitMessage(repo, state, token),
      );
      this.post({ type: 'drafting', active: false, message });
    } catch (error) {
      this.post({ type: 'drafting', active: false });
      throw error;
    }
  }

  /**
   * Reads the open pull requests from GitHub. Without `force` it reuses what it has for a while;
   * without `prompt` it does nothing unless the user already signed in to GitHub in VS Code.
   */
  private async refreshPulls(force: boolean, prompt = false): Promise<void> {
    const github = this.github;
    if (!github) {
      if (prompt) void vscode.window.showWarningMessage('Gitardo: the main remote of this repository is not on github.com.');
      return;
    }
    if (!force && Date.now() - this.pullsAt < PULLS_MAX_AGE) return;
    try {
      const session = await githubSession(prompt);
      if (!session) return;
      this.pullsAt = Date.now();
      const pulls = await this.activity.track('Reading the pull requests from GitHub', () => fetchPulls(github, session.accessToken));
      if (github !== this.github || JSON.stringify(pulls) === JSON.stringify(this.pulls)) return;
      this.pulls = pulls;
      if (this.state) this.setState({ ...this.state, pulls });
    } catch (error) {
      this.log.warn(`Could not read pull requests: ${errorText(error)}`);
      if (prompt) void vscode.window.showErrorMessage(`Gitardo: could not read pull requests. ${errorText(error)}`);
    }
  }

  /** Opens the pull request of a branch in the browser, or GitHub's page to create one. */
  private async openPullRequest(branch: string): Promise<void> {
    if (!this.github) return;
    const url = this.pulls[branch]?.url ?? compareUrl(this.github, branch);
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /** What the Pull button runs: the settings add `--rebase` and `--autostash`, unless switched off. */
  private defaultPull(): PullAction {
    const config = vscode.workspace.getConfiguration('gitardo.pull');
    return pullAction(config.get<boolean>('rebase') !== false, config.get<boolean>('autostash') !== false);
  }

  /** Pulls the way the settings choose. */
  pull(): Promise<void> {
    return this.sync(this.defaultPull());
  }

  async sync(action: SyncAction): Promise<void> {
    const state = await this.requireState();
    if (!state) return;
    if (!state.remotes.length) {
      // Nothing to fetch from or push to yet: the useful next step is to say where.
      const choice = await vscode.window.showWarningMessage('Gitardo: this repository has no remote.', 'Add Remote…');
      if (choice) await this.manageRemotes(true);
      return;
    }
    try {
      const op = syncOp(action, state);
      const upstream = state.branches.find((branch) => branch.current)?.upstream;
      if (op.danger && upstream && !upstream.gone) {
        // A force push replaces the remote branch: say which of its commits are not in the local one.
        const lost = await this.repo!.commitsOnlyIn(upstream.name, LOST_COMMITS_SHOWN + 1);
        const more = lost.length > LOST_COMMITS_SHOWN ? '\n…and more' : '';
        op.note = lost.length
          ? `These commits on ${upstream.name} are not in ${state.branch} and will be overwritten:\n${lost.slice(0, LOST_COMMITS_SHOWN).join('\n')}${more}`
          : `As of the last fetch, every commit on ${upstream.name} is also in ${state.branch}.`;
      }
      const result = await this.run(op);
      if (!result.ok) return;
      void this.refreshPulls(true);
      // The changes that were set aside no longer fit on what came in: git leaves them in conflict in the files, and
      // keeps the stash it made, which nothing says unless its output is read.
      const kept = this.state?.stashes[0];
      if (action.endsWith('Autostash') && kept && this.state!.stashes.length > state.stashes.length && /autostash/i.test(kept.message)) {
        void vscode.window
          .showWarningMessage(
            `Gitardo: pulled, but your changes do not fit on what came in. They are in conflict in the files, and whole in the stash "${kept.message}": resolve the conflicts, then drop the stash.`,
            'Show Stashes',
          )
          .then((choice) => choice && vscode.commands.executeCommand('gitardo.openStashes'));
      }
      // The first push of a branch is the natural moment to open a pull request for it.
      const branch = state.branch;
      if (action.startsWith('push') && branch && !upstream && this.github && !this.pulls[branch]) {
        const choice = await vscode.window.showInformationMessage(`Pushed ${branch}.`, 'Create Pull Request');
        if (choice) await this.openPullRequest(branch);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Gitardo: ${errorText(error)}`);
    }
  }

  async action(action: Action): Promise<void> {
    const state = await this.requireState();
    const repo = this.repo;
    if (!state || !repo) return;
    // A key binding, or a view drawn before the setting changed, can still ask for it.
    if (action.kind === 'resolveConflicts' && !this.autoResolve()) {
      void vscode.window
        .showInformationMessage('Gitardo: resolving conflicts automatically is experimental, and it is switched off in the settings.', 'Open Settings')
        .then((choice) => choice && vscode.commands.executeCommand('workbench.action.openSettings', 'gitardo.conflicts.autoResolve'));
      return;
    }
    try {
      const top = (await repo.reflog('HEAD', 1))[0];
      const reflogTop = top ? `${top.hash} ${top.subject}` : '';

      // Deleting a branch or dropping a stash leaves no trace in the reflog, so Gitardo remembers how to take its own back.
      if (action.kind === 'undo' && this.undoable?.reflogTop === reflogTop) {
        const { op } = this.undoable;
        if ((await this.run(op)).ok) this.undoable = undefined;
        return;
      }

      // A series of cherry-picks that stopped is still the same series while the user continues or skips.
      if (!state.operation) this.series = undefined;

      // Git can mark the conflicts of a file again only while it has both of its sides.
      const sides = action.kind === 'takeSide' ? await repo.conflictStages(action.path) : [];
      // A commit given a new message, or made of several, is made again with the ones after it: the new one is that many
      // before HEAD.
      const after =
        action.kind === 'reword' && action.hash !== state.head
          ? ((await repo.lineAfter(action.hash))?.length ?? 0)
          : action.kind === 'squash'
            ? ((await squashRange(action.hashes, state, repo).catch(() => null))?.after.length ?? 0)
            : 0;
      const op = await resolveAction(action, state, repo, this.memento);
      if (!op) return;
      // What is about to be written can be looked at first.
      const asked = action.kind === 'resolveConflicts';
      if (asked && !(await this.confirmWrites(repo, op, action.paths))) return;

      const { result, ran } = await this.runWithFallback(op, asked);
      if (action.kind === 'cherryPickMany' && state.head && (result.ok || this.state?.operation === 'cherry-pick')) {
        this.series = { before: state.head, branch: state.branch, title: op.title };
      }
      if (!result.ok) return;
      // Said along with the operation, so not asked again.
      if (ran.then) await this.runWithFallback(ran.then, true);

      if (action.kind === 'commit') this.post({ type: 'committed' });
      if (action.kind === 'bisect') this.reportBisect();
      if (action.kind === 'reword' || action.kind === 'squash') this.show((await git(repo.root, ['rev-parse', `HEAD~${after}`])).stdout.trim());
      this.undoable = undefined;
      const branch = action.kind === 'deleteBranch' && state.branches.find((candidate) => candidate.name === action.name);
      const stash = action.kind === 'stashDrop' && state.stashes.find((candidate) => candidate.ref === action.ref);
      if (branch) this.undoable = { reflogTop, op: restoreBranchOp(branch.name, branch.hash) };
      if (stash) this.undoable = { reflogTop, op: restoreStashOp(stash.message, stash.hash) };
      if (action.kind === 'takeSide' && sides.includes(2) && sides.includes(3)) {
        this.undoable = { reflogTop, op: restoreConflictsOp([action.path]) };
      }
      if (action.kind === 'resolveConflicts' && op.writes?.length) {
        this.undoable = { reflogTop, op: restoreConflictsOp(op.writes.map((write) => write.path)) };
        this.reportResolved(op.writes.length);
      }

      // Each commit of a series moves the branch on its own, so the reflog alone would only take back the last one.
      const series = this.series;
      if (action.kind === 'abort') this.series = undefined;
      else if (series && !this.state?.operation) {
        this.series = undefined;
        const now = (await repo.reflog('HEAD', 1))[0];
        const info = { kind: 'move', previous: series.before, subject: series.title, mode: 'keep' } as const;
        if (now) this.undoable = { reflogTop: `${now.hash} ${now.subject}`, op: undoOp(info, series.branch) };
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Gitardo: ${errorText(error)}`);
    }
  }

  /**
   * Runs an operation, and when git refuses it in the way its fallback is for, the fallback, which is asked first as
   * any operation is. `ran` is the one that ran last.
   */
  private async runWithFallback(op: GitOp, asked: boolean): Promise<{ result: RunResult; ran: GitOp }> {
    const result = await this.run(op, { silent: Boolean(op.fallback), asked });
    if (!op.fallback || result.error === undefined) return { result, ran: op };
    if (op.fallback.when.test(result.error)) return { result: await this.run(op.fallback.op), ran: op.fallback.op };
    this.reportFailure(op, result.error);
    return { result, ran: op };
  }

  /**
   * Asks before an operation writes files. Who wants to look at each resolution first, and choose among them, is shown
   * them in the tab of the review.
   */
  private async confirmWrites(repo: Repo, op: GitOp, paths?: string[]): Promise<boolean> {
    const choice = await vscode.window.showInformationMessage(`${op.title}?`, { modal: true, detail: this.describe(repo, op) }, 'Resolve', 'Review');
    if (choice === 'Review') await this.reviewConflicts(paths);
    return choice === 'Resolve';
  }

  /** Says what is left to do after conflicts were resolved, and offers the way back. */
  private reportResolved(written: number): void {
    const operation = this.state?.operation;
    const left = this.state?.working.conflicts.length ?? 0;
    const files = written === 1 ? '1 file' : `${written} files`;
    const rest = left
      ? `${left === 1 ? '1 file still has' : `${left} files still have`} conflicts to resolve by hand.`
      : `No file is left in conflict${operation ? `: the ${operation} can continue` : ''}.`;
    const buttons = !left && operation ? ['Continue', 'Undo'] : ['Undo'];
    void vscode.window.showInformationMessage(`Gitardo resolved conflicts in ${files}. ${rest}`, ...buttons).then((choice) => {
      if (choice === 'Undo') void this.action({ kind: 'undo' });
      if (choice === 'Continue') void this.action({ kind: 'continue' });
    });
  }

  /** Says so when the last answer left a single suspect: that is the commit the bisect was looking for. */
  private reportBisect(): void {
    const bisect = this.state?.bisect;
    const bad = bisect?.bad;
    if (!bad || bisect.suspects !== 1) return;
    const subject = this.state?.rows.find((row) => row.hash === bad)?.subject;
    void vscode.window
      .showInformationMessage(`Bisect: the first bad commit is ${bad.slice(0, 7)}${subject ? ` "${subject}"` : ''}.`, 'Show in the graph', 'End bisect')
      .then((choice) => {
        if (choice === 'Show in the graph') void this.reveal(bad);
        if (choice === 'End bisect') void this.action({ kind: 'bisectReset' });
      });
  }

  private async requireState(): Promise<RepoState | null> {
    if (!this.located) await this.locate();
    if (!this.state) void vscode.window.showWarningMessage('Gitardo: no Git repository in this workspace.');
    return this.state;
  }

  private setState(state: RepoState | null): void {
    this.state = state;
    this.post({ type: 'state', state });
    this.stateEmitter.fire(state);
    void this.checkUnsaved();
  }

  /** Tells the Changes views which files of the repository have edits not saved in an editor, when that changed. */
  private async checkUnsaved(): Promise<void> {
    const { state, repo } = this;
    const documents = vscode.workspace.textDocuments.filter((document) => document.isDirty && document.uri.scheme === 'file');
    const files = documents.map((document) => document.uri.fsPath);
    const from = { state, files: JSON.stringify(files) };
    // It runs at every key typed in an editor: most of the time nothing it looks at has changed.
    if (this.unsavedFrom?.state === from.state && this.unsavedFrom.files === from.files) return;
    this.unsavedFrom = from;
    const paths = state && repo ? await this.unsavedIn(repo, state, files) : [];
    if (this.unsavedFrom !== from || JSON.stringify(paths) === JSON.stringify(this.unsaved)) return;
    this.unsaved = paths;
    for (const [view, kind] of this.views) if (kind === 'changes') this.post({ type: 'unsaved', paths }, view);
  }

  /**
   * Those of these files that are of the repository, by their paths from its root, in order. The files of its
   * submodules and of the worktrees inside it are of other repositories, and the ones git ignores are no change to it.
   */
  private async unsavedIn(repo: Repo, state: RepoState, files: string[]): Promise<string[]> {
    const inside = (folder: string) => {
      const relative = path.relative(repo.root, folder);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.replace(/\\/g, '/') : null;
    };
    const others = [
      ...state.submodules.map((submodule) => submodule.path),
      ...state.worktrees.filter((worktree) => !worktree.current).flatMap((worktree) => inside(worktree.path) ?? []),
    ];
    const paths = files
      .flatMap((file) => inside(file) ?? [])
      .filter((file) => !others.some((other) => file === other || file.startsWith(`${other}/`)))
      .sort();
    const ignored = await repo.ignored(paths).catch(() => new Set<string>());
    return paths.filter((file) => !ignored.has(file));
  }

  /** Saves the editors of these files, by their paths from the root of the repository. */
  private async save(paths: string[], repo = this.repo): Promise<void> {
    if (!repo || !Array.isArray(paths)) return;
    const wanted = paths.map((file) => path.join(repo.root, file));
    const documents = vscode.workspace.textDocuments.filter(
      (document) => document.isDirty && document.uri.scheme === 'file' && wanted.some((file) => samePath(file, document.uri.fsPath)),
    );
    await Promise.all(documents.map((document) => document.save()));
  }

  private async locate(): Promise<void> {
    this.located = true;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const roots = await discoverRepos(folders);
    this.repos = roots.map((root) => ({ root, name: repoName(root, folders) }));
    // The repository chosen last time in this workspace, as long as it is still there.
    const remembered = this.memento.get<string>(REPO_KEY);
    await this.open(roots.find((root) => root === remembered) ?? roots[0]);
  }

  /** Points every view at one repository of the workspace, or at none. */
  private async open(root: string | undefined): Promise<void> {
    this.watcher?.dispose();
    this.watcher = undefined;
    this.repo = undefined;
    this.limit = pageSize();
    this.filter = null;
    this.scope = null;
    this.github = null;
    this.pulls = {};
    this.pullsAt = 0;
    this.undoable = undefined;
    if (!root) return this.setState(null);
    this.scope = this.memento.get<Record<string, Scope>>(SCOPE_KEY, {})[root] ?? null;
    const repo = new Repo(root, (command) => this.log.debug(command));
    this.repo = repo;
    // The commits of the repository before stay in the views until those of this one come.
    await this.reload('filter', async () => {
      this.watch(root, await repo.commonDir());
      await this.detectGitHub(repo);
      await this.refresh();
    });
  }

  /** Works out whether the main remote is a repository on GitHub. */
  private async detectGitHub(repo: Repo): Promise<void> {
    const remotes = await repo.remotes();
    const main = remotes.find((remote) => remote.name === 'origin') ?? remotes[0];
    const github = main ? parseGitHubRemote(main.url) : null;
    this.githubRemote = github ? main.name : null;
    if (JSON.stringify(github) === JSON.stringify(this.github)) return;
    this.github = github;
    this.pulls = {};
    this.pullsAt = 0;
  }

  /** Lists the remotes, to fetch, rename, repoint or remove one, or to add another. */
  private async manageRemotes(add = false): Promise<void> {
    const state = await this.requireState();
    const repo = this.repo;
    if (!state || !repo) return;
    const remotes = await repo.remotes();
    const taken = (except?: string) => (name: string) =>
      refNameProblem(name) ?? (name !== except && remotes.some((remote) => remote.name === name) ? 'A remote with that name already exists' : undefined);
    const askUrl = (title: string, value = '') =>
      vscode.window.showInputBox({
        title,
        value,
        prompt: 'URL of the remote repository',
        placeHolder: 'https://github.com/owner/repository.git',
        validateInput: (url) => (!url.trim() ? 'Enter a URL' : url.trim().startsWith('-') ? 'That is not a URL' : undefined),
      });
    const addRemote = async (): Promise<GitOp | undefined> => {
      const name = await vscode.window.showInputBox({
        title: 'Add remote',
        prompt: 'Name of the remote',
        value: remotes.length ? '' : 'origin',
        validateInput: taken(),
      });
      if (!name) return;
      const url = await askUrl(`Add remote ${name}`);
      return url ? remoteAddOp(name, url.trim()) : undefined;
    };

    let op: GitOp | undefined;
    if (add) {
      op = await addRemote();
    } else {
      const picked = await vscode.window.showQuickPick(
        [
          ...remotes.map((remote) => ({ label: remote.name, description: remote.url, remote })),
          { label: 'Add remote…', remote: undefined },
        ],
        { title: `Remotes of ${state.name}`, placeHolder: 'Pick a remote to fetch, rename, repoint or remove it', matchOnDescription: true },
      );
      if (!picked) return;
      const { remote } = picked;
      if (!remote) {
        op = await addRemote();
      } else {
        const { name, url } = remote;
        const choice = await vscode.window.showQuickPick(
          [
            { label: 'Fetch', description: `git fetch --prune ${name}`, op: () => fetchRemoteOp(name) },
            {
              label: 'Change URL…',
              op: async () => {
                const next = await askUrl(`Change the URL of ${name}`, url);
                return next && next.trim() !== url ? remoteSetUrlOp(name, next.trim()) : undefined;
              },
            },
            {
              label: 'Rename…',
              op: async () => {
                const next = await vscode.window.showInputBox({ title: `Rename remote ${name}`, value: name, validateInput: taken(name) });
                return next && next !== name ? remoteRenameOp(name, next) : undefined;
              },
            },
            {
              label: 'Copy URL',
              op: async () => {
                await vscode.env.clipboard.writeText(url);
                return undefined;
              },
            },
            { label: 'Remove', description: 'Deletes its remote-tracking branches here', op: () => remoteRemoveOp(name) },
          ],
          { title: `${name}: ${url}` },
        );
        op = await choice?.op();
      }
    }
    if (!op || !(await this.run(op)).ok) return;
    // The remote that pull requests are read from may be another one now.
    await this.detectGitHub(repo);
    await this.refresh();
  }

  /**
   * Switches to another repository of the workspace, and remembers the choice for this workspace; or to another worktree
   * of the repository shown, for as long as the window lasts: its changes, commits and branches are worked on from here.
   */
  async selectRepo(root: string): Promise<void> {
    const shown = this.repo?.root;
    if (this.running || (shown && samePath(root, shown))) return;
    const repo = this.repos.find((each) => samePath(each.root, root));
    if (repo) {
      await this.memento.update(REPO_KEY, repo.root);
      return this.open(repo.root);
    }
    const state = this.state;
    // A worktree of it, or one of its submodules initialized since the repositories of the workspace were looked for.
    const folder = !state
      ? undefined
      : (state.worktrees.find((each) => samePath(each.path, root) && !each.prunable)?.path ??
        state.submodules.filter((each) => each.head).map((each) => submoduleFolder(each, state)).find((each) => samePath(each, root)));
    if (!folder) return;
    // The way back is the repository of the workspace that was shown, or the one that was before another worktree.
    this.home = this.repos.find((each) => shown && samePath(each.root, shown)) ?? this.home;
    await this.open(folder);
  }

  private async pickRepo(): Promise<void> {
    if (!this.located) await this.locate();
    // Showing a worktree, there is always the repository of the workspace to go back to.
    if (this.repos.length < 2 && !this.state?.home) {
      void vscode.window.showInformationMessage(
        this.repos.length ? 'Gitardo: this workspace has a single repository.' : 'Gitardo: no Git repository in this workspace.',
      );
      return;
    }
    const current = this.repo?.root;
    const choice = await vscode.window.showQuickPick(
      [
        ...this.repos.map((repo) => ({ label: repo.name, description: repo.root === current ? 'current' : undefined, detail: repo.root, repo })),
        ...(this.state?.home && current ? [{ label: this.state.name, description: 'worktree, current', detail: current, repo: { root: current, name: this.state.name } }] : []),
      ],
      { title: 'Repository shown in Gitardo', matchOnDetail: true },
    );
    if (choice) await this.selectRepo(choice.repo.root);
  }

  /** Chooses who commits are made as in this repository: a profile from the settings, a new one, or the global identity again. */
  private async switchIdentity(): Promise<void> {
    const state = await this.requireState();
    const repo = this.repo;
    if (!state || !repo) return;
    const configured = vscode.workspace.getConfiguration('gitardo').get<unknown[]>('identities') ?? [];
    const profiles = configured.filter(
      (profile): profile is IdentityProfile =>
        typeof (profile as IdentityProfile)?.name === 'string' && typeof (profile as IdentityProfile)?.email === 'string',
    );
    const localKeys = await repo.localIdentityKeys();
    const { name, email } = state.identity;

    const ask = async (): Promise<GitOp | undefined> => {
      const newName = await vscode.window.showInputBox({ title: 'Commit as', prompt: 'Name', value: name });
      if (!newName?.trim()) return;
      const newEmail = await vscode.window.showInputBox({ title: `Commit as ${newName.trim()}`, prompt: 'Email', value: email });
      return newEmail?.trim() ? identityOp({ name: newName, email: newEmail }, localKeys) : undefined;
    };
    const openSettings = async (): Promise<undefined> => {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'gitardo.identities');
    };
    const items: (vscode.QuickPickItem & { op(): GitOp | undefined | Promise<GitOp | undefined> })[] = profiles.map((profile) => ({
      label: profile.name,
      description: profile.email,
      detail: profile.name === name && profile.email === email ? 'In use' : undefined,
      op: () => identityOp(profile, localKeys),
    }));
    items.push({ label: 'Enter a name and email…', op: ask });
    if (localKeys.length) {
      items.push({ label: 'Use the global identity', description: "Remove this repository's own setting", op: () => clearIdentityOp(localKeys) });
    }
    items.push({ label: 'Edit the list of identities…', description: 'gitardo.identities', op: openSettings });

    const choice = await vscode.window.showQuickPick(items, {
      title: `Commit in ${state.name} as`,
      placeHolder: name || email ? `Now: ${name} <${email}>` : 'No identity is configured',
      matchOnDescription: true,
    });
    const op = await choice?.op();
    if (op) await this.run(op);
  }

  /** Picks up changes made outside Gitardo: the terminal, another tool, a background fetch. */
  private watch(root: string, gitDir: string): void {
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(gitDir),
      // The submodules keep their repositories in it too: what is checked out in them and their branches.
      '{HEAD,FETCH_HEAD,ORIG_HEAD,MERGE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,BISECT_LOG,index,config,packed-refs,refs/**,logs/refs/stash,worktrees/**,modules/**/HEAD,modules/**/refs/**}',
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const relative = (from: string, uri: vscode.Uri) => path.relative(from, uri.fsPath).replace(/\\/g, '/');
    const schedule = (uri: vscode.Uri) => {
      const file = relative(gitDir, uri);
      if (!meansChange(file)) return;
      this.scheduleRefresh(`.git/${file} changed`);
    };
    // Files written by something other than this editor, such as a command in the terminal. Git's own files have the watcher above.
    const files = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**'));
    const fileChanged = (uri: vscode.Uri) => {
      if (/(^|\/)\.git(\/|$)/.test(uri.path)) return;
      this.scheduleRefresh(`${relative(root, uri)} changed`, WORKTREE_REFRESH_DELAY);
    };
    this.watcher = vscode.Disposable.from(
      watcher,
      watcher.onDidChange(schedule),
      watcher.onDidCreate(schedule),
      watcher.onDidDelete(schedule),
      files,
      files.onDidChange(fileChanged),
      files.onDidCreate(fileChanged),
      files.onDidDelete(fileChanged),
    );
  }

  /** Refreshes once, `delay` after the first of a burst of events, however long the burst lasts. `cause` is the last of them. */
  private scheduleRefresh(cause: string, delay = REFRESH_DELAY): void {
    if (!this.views.size || this.running) return;
    this.cause = cause;
    const due = Date.now() + delay;
    if (this.timer && this.due <= due) return;
    clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delay);
  }

  private post(message: HostMessage, to?: vscode.Webview): void {
    const targets = to ? [to] : [...this.views.keys()];
    if (message.type !== 'state' || !message.state) {
      for (const view of targets) void view.postMessage(message);
      return;
    }
    const { state } = message;
    const { rows } = state;
    const keys = new Map([[rows.length, rowsKey(state, this.filter)]]);
    const keyOf = (count: number) => keys.get(count) ?? keys.set(count, rowsKey(state, this.filter, count)).get(count)!;
    for (const view of targets) {
      // The views that never show the graph are spared the rows.
      if (!showsGraph(this.views.get(view) ?? 'graph')) {
        void view.postMessage({ type: 'state', state: { ...state, rows: [] } } satisfies HostMessage);
        continue;
      }
      // Most refreshes follow a change to the files, which leaves the history as it was, and loading more of it only
      // adds commits after the others: the thousands a view already has are not sent to it again.
      const before = this.sentRows.get(view);
      const kept = before && before.count <= rows.length && keyOf(before.count) === before.key ? before.count : 0;
      const sent = { key: keyOf(rows.length), count: rows.length };
      this.sentRows.set(view, sent);
      const worktree = rows[0]?.hash === WORKTREE ? [rows[0]] : [];
      const posted: HostMessage = kept ? { type: 'state', state: { ...state, rows: [...worktree, ...rows.slice(kept)] }, kept } : message;
      void view.postMessage(posted).then((delivered) => {
        // A view that is not there to receive it asks again when it comes back, and gets everything.
        if (!delivered && this.sentRows.get(view) === sent) this.sentRows.delete(view);
      });
    }
  }

  private async onMessage(webview: vscode.Webview, message: WebviewMessage): Promise<void> {
    // What the tab of a commit asks is about the repository of its commit.
    const repo = this.pinned.get(webview) ?? this.repo;
    const compareTab = this.compareTabs.get(webview);
    const review = this.reviewTab?.webview === webview ? this.reviewTab : undefined;
    // The tab of the review reads the files in conflict by itself.
    if (review && message.type === 'ready') return review.reload();
    switch (message.type) {
      case 'focus':
        return this.setFocused(webview, message.focused === true);
      case 'ready':
        // The tab of a commit reads its commit by itself, and nothing in it goes stale: the repository is not read for it.
        if (this.views.get(webview) === 'commit') return this.post({ type: 'state', state: this.state }, webview);
        // The tab of a comparison is sent its comparison, and the state for what each side is.
        if (compareTab) {
          this.post({ type: 'state', state: this.state }, webview);
          return this.sendCompare(compareTab, true);
        }
        // A view that has just loaded has nothing yet.
        this.sentRows.delete(webview);
        if (this.located && !this.loading) this.post({ type: 'state', state: this.state }, webview);
        if (this.waiting) this.post({ type: 'loading', what: this.waiting.what }, webview);
        if (this.views.get(webview) === 'changes' && this.unsaved.length) this.post({ type: 'unsaved', paths: this.unsaved }, webview);
        await this.refresh();
        return this.flushPending();
      case 'setFilter':
        return this.setFilter(message.filter);
      case 'setScope':
        return this.setScope(message.scope);
      case 'setBranchesFollowScope':
        // For the user wherever they work. The views are told when the settings change.
        return vscode.workspace.getConfiguration('gitardo').update('branches.followGraphFilter', message.follow === true, vscode.ConfigurationTarget.Global);
      case 'setShowStashes':
        return vscode.workspace.getConfiguration('gitardo').update('graph.showStashes', message.show === true, vscode.ConfigurationTarget.Global);
      case 'setDateSeparators':
        return vscode.workspace.getConfiguration('gitardo').update('graph.dateSeparators', message.show === true, vscode.ConfigurationTarget.Global);
      case 'setBranchSort': {
        const sort = message.sort === 'date' ? 'date' : 'name';
        return vscode.workspace.getConfiguration('gitardo').update('branches.sortOrder', sort, vscode.ConfigurationTarget.Global);
      }
      case 'setGraphColumns': {
        const columns = GRAPH_COLUMNS.filter((column) => message.columns.includes(column));
        return vscode.workspace.getConfiguration('gitardo').update('graph.columns', columns, vscode.ConfigurationTarget.Global);
      }
      case 'setFirstParent':
        return vscode.workspace.getConfiguration('gitardo').update('graph.firstParent', message.only === true, vscode.ConfigurationTarget.Global);
      case 'setTraceSelected':
        return vscode.workspace.getConfiguration('gitardo').update('graph.traceSelected', message.trace === true, vscode.ConfigurationTarget.Global);
      case 'setFavorite':
        return this.setFavorite(message.ref, message.favorite === true);
      case 'goTo':
        return this.goTo(message.revision, webview);
      case 'find':
        return this.find(message.search, webview);
      case 'command':
        return this.command(message.command);
      case 'pullRequest':
        return this.openPullRequest(message.branch);
      case 'syntaxTheme':
        this.colored.add(webview);
        return this.post({ type: 'syntaxTheme', theme: (await this.themes.resolveActive()) ?? null }, webview);
      case 'fileIcons':
        this.iconed.add(webview);
        return this.post({ type: 'fileIcons', theme: await this.fileIcons.for(webview) }, webview);
      case 'getWorktreeSetup':
        return this.sendSetup(webview, message.rescan === true);
      case 'previewWorktreeSetup': {
        if (!repo) return;
        const patterns = { link: cleanPatterns(message.patterns?.link), copy: cleanPatterns(message.patterns?.copy) };
        try {
          const preview = await previewSetup(repo.root, patterns);
          return this.post({ type: 'worktreeSetupPreview', patterns: message.patterns, preview }, webview);
        } catch (error) {
          return this.post({ type: 'worktreeSetupPreview', patterns: message.patterns, preview: null, error: errorText(error) }, webview);
        }
      }
      case 'saveWorktreeSetup': {
        if (!repo || (message.target !== 'user' && message.target !== 'workspace')) return;
        const tab = this.setupTab?.panel.webview === webview ? this.setupTab : undefined;
        if (tab) tab.saving = true;
        try {
          await saveSetup(repo.root, message.target, message.patterns, message.alsoVSCode === true);
        } catch (error) {
          void vscode.window.showErrorMessage(`Gitardo: the settings were not saved. ${errorText(error)}`);
        } finally {
          if (tab) tab.saving = false;
        }
        return this.sendSetup(webview, false);
      }
      case 'editWorktreeSetup':
        return repo && editSetupJson(repo.root, message.target === 'user' ? 'user' : 'workspace');
      case 'reviewConflicts':
        return this.reviewConflicts(Array.isArray(message.paths) ? message.paths : undefined, message.ai === true);
      case 'getReview':
        return review?.reload();
      case 'writeResolutions':
        return Array.isArray(message.accepted) ? review?.write(message.accepted) : undefined;
      case 'previewResolutions':
        return Array.isArray(message.accepted) ? review?.preview(message.accepted) : undefined;
      case 'askAI':
        return review?.ask(Array.isArray(message.conflicts) ? message.conflicts : undefined);
      case 'stopAsking':
        return review?.stop();
      case 'chooseConflictModel':
        return chooseConflictModel();
      case 'openConflict':
        return repo && this.openConflict(repo, message.path, message.line, message.editor);
      case 'refresh':
        return this.refresh();
      case 'loadMore':
        this.limit += pageSize();
        return this.reload('more');
      case 'getLog': {
        const limit = Math.min(Math.max(Math.trunc(Number(message.limit)) || 1, 1), LOG_LIMIT);
        const log = await this.repo?.branchLog(limit).catch(() => null);
        return log ? this.post({ type: 'log', log }, webview) : undefined;
      }
      case 'getDetail': {
        const detail = (await repo?.commitDetail(message.hash).catch(() => null)) ?? null;
        return this.post({ type: 'detail', hash: message.hash, detail }, webview);
      }
      case 'getPatch': {
        const detail = await repo?.commitDetail(message.hash).catch(() => null);
        const patch = (detail && (await repo?.commitPatch(detail, PATCH_LINES).catch(() => null))) ?? null;
        return this.post({ type: 'patch', hash: message.hash, patch }, webview);
      }
      case 'openCommit':
        return this.openCommit(message.hash, repo);
      case 'reveal':
        // In the repository the commit is of, when the tab that asks is of another than the one shown.
        if (repo && repo.root !== this.repo?.root) await this.selectRepo(repo.root);
        return this.reveal(message.hash);
      case 'setFilesLayout':
        return void this.memento.update(FILES_KEY, message.layout === 'list' ? 'list' : 'tree');
      case 'compare':
        return this.compare(message.from);
      case 'openCompare':
        return this.openCompare(message.from, message.to, repo);
      case 'pickCompareSide':
        return compareTab && this.pickCompareSide(compareTab, message.side === 'from' ? 'from' : 'to');
      case 'swapCompare':
        if (!compareTab) return;
        [compareTab.from, compareTab.to] = [compareTab.to, compareTab.from];
        this.rememberComparison(compareTab.repo, compareTab.from, compareTab.to, compareTab.path);
        return this.sendCompare(compareTab, true);
      case 'setCompareMode':
        if (!compareTab) return;
        compareTab.mode = message.mode === 'diverged' ? 'diverged' : 'direct';
        return this.sendCompare(compareTab, true);
      case 'setComparePath':
        if (!compareTab) return;
        compareTab.path = cleanPath(message.path);
        this.rememberComparison(compareTab.repo, compareTab.from, compareTab.to, compareTab.path);
        return this.sendCompare(compareTab, true);
      case 'takeCompareFile':
        return compareTab ? this.takeCompareFile(compareTab, message.file) : undefined;
      case 'copyComparePatch':
        return compareTab ? this.copyComparePatch(compareTab) : undefined;
      case 'openCompareOnGitHub':
        return compareTab ? this.openCompareOnGitHub(compareTab) : undefined;
      case 'show':
        return this.show(message.hash);
      case 'trace':
        return this.trace(message.hash);
      case 'getComparison': {
        const comparison = await this.repo?.compare(message.from, message.to).catch(() => null);
        return comparison ? this.post({ type: 'comparison', comparison }, webview) : undefined;
      }
      case 'selectRepo':
        return this.selectRepo(message.root);
      case 'openDiff':
        return this.openDiff(message.source, message.file, repo);
      case 'openFile':
        return this.openFile(message.file, repo);
      case 'openChange':
        return vscode.workspace.getConfiguration('gitardo').get('changes.openOnClick') === 'diff'
          ? this.openDiff({ kind: 'change' }, message.file, repo)
          : this.openFile(message.file, repo);
      case 'openChanges':
        return this.openChanges(message.title, message.source, message.files, repo);
      case 'save':
        return this.save(message.paths, repo);
      case 'compareWithSaved':
        if (!repo || typeof message.path !== 'string') return;
        return void vscode.commands.executeCommand('workbench.files.action.compareWithSaved', vscode.Uri.file(path.join(repo.root, message.path)));
      case 'sync':
        return this.sync(message.action);
      case 'action':
        return this.action(message.action);
      case 'copy':
        return void vscode.env.clipboard.writeText(message.text);
    }
  }

  /** Runs an operation that another part of Gitardo, such as the Flow Diff, made for a repository: not always the one shown. */
  async runIn(root: string, op: GitOp): Promise<boolean> {
    const repo = this.repo && samePath(this.repo.root, root) ? this.repo : new Repo(root, (command) => this.log.debug(command));
    return (await this.run(op, { repo })).ok;
  }

  /** Runs an operation, first showing its exact commands when the user asked for that or when it can lose work. */
  private async run(op: GitOp, options: { silent?: boolean; asked?: boolean; repo?: Repo } = {}): Promise<RunResult> {
    const repo = options.repo ?? this.repo;
    if (!repo || this.running) return { ok: false };

    const preview = vscode.workspace.getConfiguration('gitardo').get<string>('commandPreview') === 'all';
    if (!options.asked && (preview || op.danger || op.confirm)) {
      const ask = op.danger ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      if ((await ask(`${op.title}?`, { modal: true, detail: this.describe(repo, op) }, 'Run')) !== 'Run') return { ok: false };
    }

    let error: string | undefined;
    this.running = true;
    this.operations++;
    this.post({ type: 'busy', title: op.title });
    const task = this.activity.start(op.title);
    try {
      // A read under way is let finish first, for the git it runs in the worktrees; what it read is dropped.
      await this.loading;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Gitardo: ${op.title}` },
        async () => {
          await op.prepare?.(this.log);
          if (op.writes?.length) {
            for (const write of op.writes) this.log.info(`> write ${write.path}`);
            await writeFiles(repo.root, op.writes);
          }
          for (const [index, args] of op.commands.entries()) {
            const input = index === op.commands.length - 1 ? op.input : undefined;
            this.log.info(`> ${formatCommand(args)}`);
            if (input) this.log.info(`standard input:\n${input}`);
            try {
              const result = await git(repo.root, args, { input });
              const output = (result.stdout + result.stderr).trim();
              if (output) this.log.info(output);
            } catch (failure) {
              // What git said goes to the log as the error, unless the operation gets past it, which says so itself.
              if (!(failure instanceof GitError) || !(await op.recover?.(args, failure, this.log))) throw failure;
            }
          }
          await op.finish?.(this.log);
        },
      );
      op.onSuccess?.();
    } catch (failure) {
      error = failure instanceof GitError ? `${failure.result.stdout}${failure.result.stderr}`.trim() : errorText(failure);
      this.log.error(error);
    } finally {
      this.running = false;
      task.end();
      this.post({ type: 'busy', title: null });
      await this.refresh();
    }

    if (error === undefined) return { ok: true };
    if (!options.silent) this.reportFailure(op, error);
    return { ok: false, error };
  }

  /** What an operation is about to do, for who is asked whether to do it: the files it writes and the commands it runs. */
  private describe(repo: Repo, op: GitOp): string {
    // What runs no command says what it does in its note.
    if (!op.commands.length && !op.writes?.length) return op.note ?? '';
    const then = op.then ? `\n\nand once that is done:\n\n${op.then.commands.map(formatCommand).join('\n')}` : '';
    const commands = op.commands.map(formatCommand).join('\n') + then;
    const note = op.note ? `${op.note}\n\n` : '';
    if (!op.writes?.length) return `${note}Gitardo will run in ${repo.root}:\n\n${commands}`;
    const files = op.writes.map((write) => write.path).join('\n');
    return `${note}Gitardo will write in ${repo.root}:\n\n${files}${commands ? `\n\nand then run:\n\n${commands}` : ''}`;
  }

  private reportFailure(op: GitOp, error: string): void {
    const showLog = (choice?: string) => choice && this.log.show();
    const conflicts = this.state?.working.conflicts.length ?? 0;
    if (this.state && conflicts) {
      const { operation } = this.state;
      const files = conflicts === 1 ? '1 file has conflicts' : `${conflicts} files have conflicts`;
      // Without an operation to continue, as after a stash that did not apply cleanly, staging the files is all there is to do.
      const then = operation ? `continue or abort the ${operation}` : 'stage the files';
      const marked = this.state.conflictFiles.reduce((sum, file) => sum + file.conflicts, 0);
      const resolvable = this.state.conflictFiles.reduce((sum, file) => sum + file.resolvable.length, 0);
      // The ones that need no choice between the two sides are a click away.
      const which = marked === 1 ? 'the conflict' : resolvable === marked ? `all ${marked} conflicts` : `${resolvable} of the ${marked} conflicts`;
      const offer = resolvable ? ` Gitardo can resolve ${which} automatically.` : '';
      // The language model is offered for what the rules leave.
      const ai = this.resolveWithAI() && (!marked || resolvable < marked);
      const items = [...(resolvable ? ['Resolve Automatically'] : []), ...(ai ? ['Resolve with AI'] : []), 'Show Log'];
      void vscode.window.showWarningMessage(`${op.title} stopped: ${files}. Resolve them, then ${then}.${offer}`, ...items).then((choice) => {
        if (choice === 'Resolve Automatically') void this.action({ kind: 'resolveConflicts' });
        if (choice === 'Resolve with AI') void this.reviewConflicts(undefined, true);
        if (choice === 'Show Log') this.log.show();
      });
      return;
    }
    // Git prefixes the line that matters; hints and progress come after it.
    const lines = error.split('\n').filter(Boolean);
    const summary = lines.find((line) => /^(error|fatal):/.test(line)) ?? lines[0] ?? 'unknown error';
    void vscode.window.showErrorMessage(`${op.title} failed. ${summary}`, 'Show Log').then(showLog);
  }

  /** The two versions of a file that a diff of `source` puts side by side, and what to call the pair. */
  private sides(repo: Repo, source: DiffSource, file: FileChange): { left: vscode.Uri; right: vscode.Uri; label: string } | null {
    const added = file.status === 'A' || file.status === '?';
    const deleted = file.status === 'D';
    const before = file.oldPath ?? file.path;
    const head = this.state?.head ?? '';
    const onDisk = vscode.Uri.file(path.join(repo.root, file.path));
    const at = (ref: string, filePath = file.path) => contentUri(repo.root, ref, filePath);
    // The index and HEAD as VS Code's Git extension serves them, when it has the repository: its own commands, such as
    // Stage Selected Ranges, then know the diff, as they only do for its URIs. Gitardo serves them otherwise.
    const vscodeGit = (source.kind === 'staged' || source.kind === 'unstaged') && inVSCodeGit(repo.root);
    const inGit = (ref: '~' | 'HEAD', filePath = file.path) => {
      if (!vscodeGit) return at(ref === '~' ? INDEX : head, filePath);
      const uri = vscode.Uri.file(path.join(repo.root, filePath));
      return uri.with({ scheme: 'git', query: JSON.stringify({ path: uri.fsPath, ref }) });
    };

    switch (source.kind) {
      case 'commit': {
        // Either side of a comparison can be the working tree.
        const { hash, parent } = source;
        if (!isSide(hash) || (parent !== null && !isSide(parent)) || hash === parent) return null;
        const name = (ref: string | null) => (ref === WORKTREE ? 'Working Tree' : ref ? ref.slice(0, 7) : 'empty');
        const left = added || !parent ? at('', before) : parent === WORKTREE ? vscode.Uri.file(path.join(repo.root, before)) : at(parent, before);
        const right = deleted ? at('') : hash === WORKTREE ? onDisk : at(hash);
        return { left, right, label: `${name(parent)} ↔ ${name(hash)}` };
      }
      case 'worktree':
        return { left: at(added ? '' : head, before), right: deleted ? at('') : onDisk, label: 'Working Tree' };
      case 'staged':
        return { left: added ? at('') : inGit('HEAD', before), right: deleted ? at('') : inGit('~'), label: 'Index' };
      case 'unstaged':
        return { left: added ? at('') : inGit('~'), right: deleted ? at('') : onDisk, label: 'Working Tree' };
      case 'change': {
        // The file as git lists it on that side: added to the index and changed since is `A` there, `M` here.
        const working = repo === this.repo ? this.state?.working : undefined;
        const unstaged = working?.unstaged.find((each) => each.path === file.path);
        if (unstaged || !working) return this.sides(repo, { kind: 'unstaged' }, unstaged ?? file);
        return this.sides(repo, { kind: 'staged' }, working.staged.find((each) => each.path === file.path) ?? file);
      }
      case 'conflict':
        return null;
    }
  }

  /** Opens the diffs of several files in a single editor, one under the other. */
  private async openChanges(title: string, source: DiffSource, files: FileChange[], repo = this.repo): Promise<void> {
    if (!repo) return;
    if (WORKING_SOURCES.has(source.kind)) await refreshVSCodeGit(repo.root);
    const resources = files.flatMap((file) => {
      const sides = this.sides(repo, source, file);
      return sides ? [[vscode.Uri.file(path.join(repo.root, file.path)), sides.left, sides.right]] : [];
    });
    if (resources.length) await vscode.commands.executeCommand('vscode.changes', title, resources);
  }

  /** A file of the working tree in its editor. A deleted one is not there to open: its diff shows what it was. */
  private async openFile(file: FileChange, repo = this.repo): Promise<void> {
    if (!repo) return;
    if (file.status === 'D') return this.openDiff({ kind: 'change' }, file, repo);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(repo.root, file.path)));
  }

  private async openDiff(source: DiffSource, file: FileChange, repo = this.repo): Promise<void> {
    if (!repo) return;
    const onDisk = vscode.Uri.file(path.join(repo.root, file.path));

    switch (source.kind) {
      case 'commit':
      case 'worktree':
      case 'staged':
      case 'unstaged':
      case 'change': {
        if (WORKING_SOURCES.has(source.kind)) await refreshVSCodeGit(repo.root);
        const sides = this.sides(repo, source, file);
        if (!sides) return;
        const title = `${path.posix.basename(file.path)} (${sides.label})`;
        await vscode.commands.executeCommand('vscode.diff', sides.left, sides.right, title);
        return;
      }
      case 'conflict': {
        // The merge editor needs all three sides: a file added or deleted on one of them has fewer, and opens as it is.
        const stages = await repo.conflictStages(file.path);
        if ([1, 2, 3].every((stage) => stages.includes(stage))) {
          try {
            // Not part of the documented API, hence the fallback.
            await openMergeEditor(repo.root, file.path, this.state?.operation ?? null);
            return;
          } catch (error) {
            this.log.warn(`Could not open the merge editor: ${errorText(error)}`);
          }
        }
        await vscode.commands.executeCommand('vscode.open', onDisk);
        return;
      }
    }
  }

  private resourceRoots(): vscode.Uri[] {
    return [vscode.Uri.joinPath(this.extensionUri, 'dist'), ...FileIcons.roots()];
  }

  /**
   * Sends the pages that show files the icons of the file icon theme, which changed. An extension with icon themes
   * added since they were opened is let in first: that loads them again, and they ask for the icons anew.
   */
  private sendFileIcons(): void {
    const roots = this.resourceRoots();
    if (roots.join('\n') !== this.roots.join('\n')) {
      this.roots = roots;
      for (const webview of this.views.keys()) webview.options = { ...webview.options, localResourceRoots: roots };
    }
    for (const webview of this.iconed) void this.fileIcons.for(webview).then((theme) => this.post({ type: 'fileIcons', theme }, webview));
  }

  /** `data` becomes the `data-` attributes of the body, which is where the page reads what view it is. */
  private html(webview: vscode.Webview, dist: vscode.Uri, data: Record<string, string>): string {
    const escape = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
    const attributes = Object.entries(data).map(([name, value]) => `data-${name}="${escape(value)}"`).join(' ');
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    // The scripts of the extension itself, besides the page's own: those that color code are imported once it shows some.
    // Images and fonts also for the icons of the file icon theme.
    const csp = `default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${style}" rel="stylesheet">
</head>
<body ${attributes}>
  <div id="root"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
