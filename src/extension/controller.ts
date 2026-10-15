import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { discoverRepos, repoName } from '../git/discover';
import { GitError, formatCommand, git, writeFiles } from '../git/exec';
import { compareUrl, parseGitHubRemote, type GitHubRepo } from '../git/github';
import {
  CONFLICT_SIDES,
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
  undoOp,
  type GitOp,
  type IdentityProfile,
} from '../git/ops';
import { samePath } from '../git/parse';
import { Repo, isHash } from '../git/repo';
import { previewSetup, scanIgnored, unlinkFolderLinks } from '../git/worktreeSetup';
import { WORKTREE, showsGraph, showsComparisons } from '../shared/protocol';
import { changesText, worktreeLabel, worktreeOf, worktreeStatus } from '../shared/refs';
import { cleanPatterns, type IgnoredEntry } from '../shared/worktreeSetup';
import type {
  Action,
  ComparedRef,
  Comparing,
  DiffSource,
  FileChange,
  FilesLayout,
  Filter,
  HostMessage,
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
import { AGENTS_WINDOW, SETUP_OFFERED, closeInVSCodeGit, recoverHeldWorktree, removeEmptyParents, resolveAction, worktreesFolder } from './actions';
import { draftCommitMessage } from './ai';
import { CONFLICT, INDEX, contentUri, proposalUri } from './content';
import { fetchPulls, githubSession } from './github';
import { editSetupJson, saveSetup, worktreeSetupInfo } from './worktreeSettings';

const PAGE_SIZE = 1000;
/** The most commits a search is told about, to highlight them in the graph. */
const FOUND_LIMIT = 5000;

const REFRESH_DELAY = 400;
/** Builds and installs write many files at once, so those are given longer to settle. */
const WORKTREE_REFRESH_DELAY = 1000;
const LOST_COMMITS_SHOWN = 10;
const REFLOG_ENTRIES = 200;
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

interface RunResult {
  ok: boolean;
  /** Git's error output when the operation ran and failed. Absent when the user cancelled. */
  error?: string;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const hasCommand = async (id: string) => (await vscode.commands.getCommands(true)).includes(id);

/**
 * Identifies the rows of a state: two states with the same key have the same rows.
 * A commit never changes, so its hash stands for all of it. The row of the uncommitted changes only counts for being
 * there or not, which moves the lines of the graph: how many changes it says there are is sent apart.
 * The filter is part of it because the history of a file gives the same commits other parents.
 */
function rowsKey(state: RepoState, filter: Filter | null): string {
  const hash = createHash('sha1');
  hash.update(`${state.root}\0${JSON.stringify(filter)}\0`);
  for (const row of state.rows) hash.update(row.hash);
  return hash.digest('hex');
}

/** Owns the repository state and serves every Gitardo webview, wherever the user has placed it. */
export class Controller implements vscode.Disposable {
  private repo?: Repo;
  private state: RepoState | null = null;
  private located = false;
  private limit = PAGE_SIZE;
  /** The read of the repository under way, if any. */
  private loading?: Promise<void>;
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
  private pulls: Record<string, PullRequest> = {};
  private pullsAt = 0;
  /** A commit to show as soon as a graph view is there to show it. */
  private pendingReveal?: string;
  /** A comparison waiting for the same. */
  private pendingCompare?: Comparing;
  /** Every repository of the workspace; `repo` is the one being shown. */
  private repos: RepoInfo[] = [];
  /** The repository of the workspace shown before a worktree of it that is not in the workspace. */
  private home?: RepoInfo;
  /** Whether this VS Code has the Agents window, which is looked up once: it comes and goes with VS Code itself. */
  private agentsWindow?: Promise<boolean>;
  private readonly views = new Map<vscode.Webview, ViewKind>();
  /** The tabs of the commits, by repository and hash, and the repository each is of: not always the one being shown. */
  private readonly commitTabs = new Map<string, vscode.WebviewPanel>();
  private readonly pinned = new Map<vscode.Webview, Repo>();
  /** The tab where what new worktrees get is chosen, the repository it is of and what git ignores there, once looked at. */
  /** `saving` while the tab writes the settings one after the other, which it shows once they are all written. */
  private setupTab?: { panel: vscode.WebviewPanel; repo: Repo; entries: IgnoredEntry[] | null; saving: boolean };
  /** The views with a search box that have the keyboard: one at most, but each says so on its own. */
  private readonly focused = new Set<vscode.Webview>();
  /** What identifies the commits each view that lists them was last sent. */
  private readonly sentRows = new WeakMap<vscode.Webview, string>();
  private readonly stateEmitter = new vscode.EventEmitter<RepoState | null>();
  private readonly subscriptions: vscode.Disposable[];

  /** Fires whenever the repository state has been reloaded. */
  readonly onDidChangeState = this.stateEmitter.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
    /** Remembers which repository of this workspace was chosen, and which branches of each are shown. */
    private readonly memento: vscode.Memento,
  ) {
    const schedule = () => this.scheduleRefresh();
    this.subscriptions = [
      this.stateEmitter,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.locate()),
      vscode.workspace.onDidSaveTextDocument(schedule),
      vscode.workspace.onDidCreateFiles(schedule),
      vscode.workspace.onDidDeleteFiles(schedule),
      vscode.workspace.onDidRenameFiles(schedule),
      vscode.window.onDidChangeWindowState((window) => window.focused && schedule()),
      vscode.workspace.onDidChangeConfiguration(
        (event) => ['gitardo.conflicts', 'gitardo.pull', 'gitardo.worktrees', 'gitardo.branches'].some((section) => event.affectsConfiguration(section)) && schedule(),
      ),
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
    webview.options = { enableScripts: true, localResourceRoots: [dist] };
    webview.html = this.html(webview, dist, { view: kind, ...data });
    this.views.set(webview, kind);
    const listener = webview.onDidReceiveMessage((message: WebviewMessage) => this.onMessage(webview, message));
    return new vscode.Disposable(() => {
      listener.dispose();
      this.views.delete(webview);
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
    this.loading ??= this.load(this.repo);
    return this.loading;
  }

  private async load(first: Repo): Promise<void> {
    try {
      for (let repo: Repo | undefined = first; repo && this.dirty && !this.running; repo = this.repo) {
        this.dirty = false;
        const operations = this.operations;
        const scope = this.scope;
        const state = await this.readState(repo);
        // Read while an operation ran, it can be half from before it and half from after, such as a new commit that
        // no branch points at yet. It is dropped: the operation is followed by a read of its own.
        if (this.running || operations !== this.operations) continue;
        // Unless the views were pointed at another repository in the meantime.
        if (repo !== this.repo) continue;
        // Unless another was chosen while this one was read.
        if (scope === this.scope) this.settleScope(state.root, state.scope);
        this.setState({
          ...state,
          favorites: this.favorites(state),
          defaultPull: this.defaultPull(),
          repos: this.repos,
          github: this.github,
          pulls: this.pulls,
          agentsWindow: await (this.agentsWindow ??= hasCommand(AGENTS_WINDOW)),
          worktreesRoot: worktreesFolder(state),
          openBranches: vscode.workspace.getConfiguration('gitardo').get('branches.openIn') === 'worktree' ? 'worktree' : 'checkout',
          home: this.repos.some((each) => samePath(each.root, state.root)) ? null : (this.home ?? null),
        });
      }
    } catch (error) {
      this.log.error(errorText(error));
      this.setState(null);
    } finally {
      // In the same turn as the last look at `dirty`, so that no request can fall between the two.
      this.dirty = false;
      this.loading = undefined;
    }
    void this.refreshPulls(false);
  }

  /** Resolving conflicts without choosing a side is experimental: nothing of it is offered, or run, until it is switched on. */
  private autoResolve(): boolean {
    return vscode.workspace.getConfiguration('gitardo').get<boolean>('conflicts.autoResolve') === true;
  }

  /** A search git cannot run, such as an invalid regular expression, is reported and dropped rather than taking the graph down. */
  private async readState(repo: Repo): Promise<RepoState> {
    const resolve = this.autoResolve();
    if (!this.filter) return repo.state(this.limit, null, this.scope, resolve);
    try {
      return await repo.state(this.limit, this.filter, this.scope, resolve);
    } catch (error) {
      this.filter = null;
      const text = error instanceof GitError ? error.result.stderr.trim() : errorText(error);
      this.log.error(text);
      void vscode.window.showErrorMessage(`Gitardo: the search failed. ${text.split('\n')[0]}`);
      return repo.state(this.limit, null, this.scope, resolve);
    }
  }

  /** Narrows the graph to the history of some branches, or shows them all again. What the filter does is left to it. */
  async setScope(scope: Scope | null): Promise<void> {
    if (!this.located) await this.locate();
    // As it is given: reading the repository leaves out what is not a branch of it.
    this.scope = scope && typeof scope === 'object' ? scope : null;
    this.limit = PAGE_SIZE;
    await this.refresh();
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
    this.limit = PAGE_SIZE;
    // Searching inside the changes of every commit can take a while on a large repository.
    const slow = filter?.kind === 'pickaxe' || filter?.kind === 'regex';
    if (slow) this.post({ type: 'busy', title: 'Searching' });
    try {
      await this.refresh();
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
    const pages = Math.floor(index / PAGE_SIZE) + 1;
    const same = this.filter === shown && this.scope === scope;
    this.limit = Math.max(same ? this.limit : PAGE_SIZE, pages * PAGE_SIZE);
    await this.refresh();
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

  /** Hands over what was waiting for a graph view to be there. */
  private flushPending(): void {
    const views = (wanted: (kind: ViewKind) => boolean) => [...this.views].filter(([, kind]) => wanted(kind)).map(([view]) => view);
    const lists = views(showsGraph);
    if (this.pendingReveal && lists.length) {
      for (const view of lists) this.post({ type: 'reveal', hash: this.pendingReveal }, view);
      this.pendingReveal = undefined;
    }
    // The one in the panel was opened for it, and has the room for it.
    const graphs = views((kind) => kind === 'graph');
    if (this.pendingCompare && graphs.length) {
      for (const view of graphs) this.post({ type: 'compare', comparing: this.pendingCompare }, view);
      this.pendingCompare = undefined;
    }
  }

  /**
   * Shows the files that differ between two branches, tags or commits, asking which. With `from`, only the other
   * side is asked. The answer goes to the view that asked, if it can show it, or else to the graph.
   */
  async compare(from?: ComparedRef, asker?: vscode.Webview): Promise<void> {
    const state = await this.requireState();
    const repo = this.repo;
    if (!state || !repo) return;
    try {
      const given = from && isHash(from.hash) && typeof from.name === 'string' ? { name: from.name, hash: from.hash } : undefined;
      const first = given ?? (await this.pickRevision(state, repo, 'Compare', 'The branch, tag or commit to start from'));
      if (!first) return;
      const second = await this.pickRevision(state, repo, `Compare ${first.name} with`, 'The branch, tag or commit to compare it with', first);
      if (!second) return;
      const comparing: Comparing = { from: first.hash, to: second.hash, fromName: first.name, toName: second.name };
      const kind = asker && this.views.get(asker);
      if (asker && kind && showsComparisons(kind)) return this.post({ type: 'compare', comparing }, asker);
      this.pendingCompare = comparing;
      await vscode.commands.executeCommand('gitardo.graph.focus');
      this.flushPending();
    } catch (error) {
      void vscode.window.showErrorMessage(`Gitardo: ${errorText(error)}`);
    }
  }

  /** Lets the user choose a branch or a tag, or type anything git can turn into a commit: a hash, `HEAD~3`, `v1.0^`. */
  private async pickRevision(
    state: RepoState,
    repo: Repo,
    title: string,
    placeHolder: string,
    other?: ComparedRef,
  ): Promise<ComparedRef | undefined> {
    type Item = vscode.QuickPickItem & { ref?: ComparedRef };
    const group = (label: string, refs: { name: string; hash: string }[], icon: string): Item[] =>
      refs.length
        ? [
            { label, kind: vscode.QuickPickItemKind.Separator },
            ...refs.map((ref) => ({ label: `$(${icon}) ${ref.name}`, description: ref.hash.slice(0, 7), ref: { name: ref.name, hash: ref.hash } })),
          ]
        : [];
    const items: Item[] = [{ label: '$(edit) Enter a hash or a revision…', description: 'such as 1a2b3c4 or HEAD~3', alwaysShow: true }];
    if (state.head) {
      const name = state.branch ?? 'HEAD';
      items.push({ label: `$(target) ${name}`, description: `${state.head.slice(0, 7)} · checked out`, ref: { name, hash: state.head } });
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
    return choice.ref ?? this.askRevision(repo, title);
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
        { label: 'Show in graph', run: () => this.reveal(hash) },
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
      const pulls = await fetchPulls(github, session.accessToken);
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
      const op = await resolveAction(action, state, repo, this.memento);
      if (!op) return;
      // What is about to be written can be looked at first.
      const asked = action.kind === 'resolveConflicts';
      if (asked && !(await this.confirmWrites(repo, op))) return;

      let result = await this.run(op, { silent: Boolean(op.fallback), asked });
      if (op.fallback && result.error !== undefined) {
        if (op.fallback.when.test(result.error)) result = await this.run(op.fallback.op);
        else this.reportFailure(op, result.error);
      }
      if (action.kind === 'cherryPickMany' && state.head && (result.ok || this.state?.operation === 'cherry-pick')) {
        this.series = { before: state.head, branch: state.branch, title: op.title };
      }
      if (!result.ok) return;

      if (action.kind === 'commit') this.post({ type: 'committed' });
      if (action.kind === 'bisect') this.reportBisect();
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

  /** Asks before an operation writes files, and shows what it would write in each to who wants to see that first. */
  private async confirmWrites(repo: Repo, op: GitOp): Promise<boolean> {
    let choice = await vscode.window.showInformationMessage(`${op.title}?`, { modal: true, detail: this.describe(repo, op) }, 'Resolve', 'Preview');
    if (choice === 'Preview') {
      const resources = (op.writes ?? []).map((write) => {
        const onDisk = vscode.Uri.file(path.join(repo.root, write.path));
        return [onDisk, onDisk, proposalUri(repo.root, write.path, write.content)];
      });
      await vscode.commands.executeCommand('vscode.changes', 'Preview of the conflicts resolved automatically', resources);
      choice = await vscode.window.showInformationMessage(`${op.title}, as in the preview?`, 'Resolve');
    }
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
      .showInformationMessage(`Bisect: the first bad commit is ${bad.slice(0, 7)}${subject ? ` "${subject}"` : ''}.`, 'Show in Graph', 'End Bisect')
      .then((choice) => {
        if (choice === 'Show in Graph') void this.reveal(bad);
        if (choice === 'End Bisect') void this.action({ kind: 'bisectReset' });
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
    this.limit = PAGE_SIZE;
    this.filter = null;
    this.scope = null;
    this.github = null;
    this.pulls = {};
    this.pullsAt = 0;
    this.undoable = undefined;
    if (!root) return this.setState(null);
    this.scope = this.memento.get<Record<string, Scope>>(SCOPE_KEY, {})[root] ?? null;
    this.repo = new Repo(root, (command) => this.log.debug(command));
    this.watch(root, await this.repo.commonDir());

    await this.detectGitHub(this.repo);
    await this.refresh();
  }

  /** Works out whether the main remote is a repository on GitHub. */
  private async detectGitHub(repo: Repo): Promise<void> {
    const remotes = await repo.remotes();
    const main = remotes.find((remote) => remote.name === 'origin') ?? remotes[0];
    const github = main ? parseGitHubRemote(main.url) : null;
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
    const worktree = this.state?.worktrees.find((each) => samePath(each.path, root) && !each.prunable);
    if (!worktree) return;
    // The way back is the repository of the workspace that was shown, or the one that was before another worktree.
    this.home = this.repos.find((each) => shown && samePath(each.root, shown)) ?? this.home;
    await this.open(worktree.path);
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
      '{HEAD,FETCH_HEAD,ORIG_HEAD,MERGE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,BISECT_LOG,index,config,packed-refs,refs/**,logs/refs/stash,worktrees/**}',
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const schedule = () => this.scheduleRefresh();
    // Files written by something other than this editor, such as a command in the terminal. Git's own files have the watcher above.
    const files = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**'));
    const fileChanged = (uri: vscode.Uri) => {
      if (!/(^|\/)\.git(\/|$)/.test(uri.path)) this.scheduleRefresh(WORKTREE_REFRESH_DELAY);
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

  /** Refreshes once, `delay` after the first of a burst of events, however long the burst lasts. */
  private scheduleRefresh(delay = REFRESH_DELAY): void {
    if (!this.views.size || this.running) return;
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
    const key = rowsKey(state, this.filter);
    for (const view of targets) {
      // The views that never show the graph are spared the rows.
      if (!showsGraph(this.views.get(view) ?? 'graph')) {
        void view.postMessage({ type: 'state', state: { ...state, rows: [] } } satisfies HostMessage);
        continue;
      }
      // Most refreshes follow a change to the files, which leaves the history as it was: thousands of commits
      // are not sent again to a view that already has them.
      const sameRows = this.sentRows.get(view) === key;
      this.sentRows.set(view, key);
      const sent: HostMessage = sameRows
        ? { type: 'state', state: { ...state, rows: state.rows.filter((row) => row.hash === WORKTREE) }, sameRows }
        : message;
      void view.postMessage(sent).then((delivered) => {
        // A view that is not there to receive it asks again when it comes back, and gets everything.
        if (!delivered && this.sentRows.get(view) === key) this.sentRows.delete(view);
      });
    }
  }

  private async onMessage(webview: vscode.Webview, message: WebviewMessage): Promise<void> {
    // What the tab of a commit asks is about the repository of its commit.
    const repo = this.pinned.get(webview) ?? this.repo;
    switch (message.type) {
      case 'focus':
        return this.setFocused(webview, message.focused === true);
      case 'ready':
        // The tab of a commit reads its commit by itself, and nothing in it goes stale: the repository is not read for it.
        if (this.views.get(webview) === 'commit') return this.post({ type: 'state', state: this.state }, webview);
        // A view that has just loaded has nothing yet.
        this.sentRows.delete(webview);
        if (this.located && !this.loading) this.post({ type: 'state', state: this.state }, webview);
        await this.refresh();
        return this.flushPending();
      case 'setFilter':
        return this.setFilter(message.filter);
      case 'setScope':
        return this.setScope(message.scope);
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
      case 'refresh':
        return this.refresh();
      case 'loadMore':
        this.limit += PAGE_SIZE;
        return this.refresh();
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
        return this.compare(message.from, webview);
      case 'show':
        return this.show(message.hash);
      case 'getComparison': {
        const comparison = await this.repo?.compare(message.from, message.to).catch(() => null);
        return comparison ? this.post({ type: 'comparison', comparison }, webview) : undefined;
      }
      case 'selectRepo':
        return this.selectRepo(message.root);
      case 'getHunks': {
        const hunks = (await this.repo?.hunks(message.path, message.staged).catch(() => null)) ?? null;
        return this.post({ type: 'hunks', path: message.path, staged: message.staged, hunks }, webview);
      }
      case 'openDiff':
        return this.openDiff(message.source, message.file, repo);
      case 'openChanges':
        return this.openChanges(message.title, message.source, message.files, repo);
      case 'sync':
        return this.sync(message.action);
      case 'action':
        return this.action(message.action);
      case 'copy':
        return void vscode.env.clipboard.writeText(message.text);
    }
  }

  /** Runs an operation, first showing its exact commands when the user asked for that or when it can lose work. */
  private async run(op: GitOp, options: { silent?: boolean; asked?: boolean } = {}): Promise<RunResult> {
    const repo = this.repo;
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
    const commands = op.commands.map(formatCommand).join('\n');
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
      void vscode.window
        .showWarningMessage(
          `${op.title} stopped: ${files}. Resolve them, then ${then}.${offer}`,
          ...(resolvable ? ['Resolve Automatically', 'Show Log'] : ['Show Log']),
        )
        .then((choice) => {
          if (choice === 'Resolve Automatically') void this.action({ kind: 'resolveConflicts' });
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

    switch (source.kind) {
      case 'commit': {
        const { hash, parent } = source;
        if (!isHash(hash) || (parent !== null && !isHash(parent))) return null;
        const label = `${parent ? parent.slice(0, 7) : 'empty'} ↔ ${hash.slice(0, 7)}`;
        return { left: at(added || !parent ? '' : parent, before), right: at(deleted ? '' : hash), label };
      }
      case 'worktree':
        return { left: at(added ? '' : head, before), right: deleted ? at('') : onDisk, label: 'Working Tree' };
      case 'staged':
        return { left: at(added ? '' : head, before), right: at(deleted ? '' : INDEX), label: 'Staged' };
      case 'unstaged':
        return { left: at(added ? '' : INDEX), right: deleted ? at('') : onDisk, label: 'Working Tree' };
      case 'conflict':
        return null;
    }
  }

  /** Opens the diffs of several files in a single editor, one under the other. */
  private async openChanges(title: string, source: DiffSource, files: FileChange[], repo = this.repo): Promise<void> {
    if (!repo) return;
    const resources = files.flatMap((file) => {
      const sides = this.sides(repo, source, file);
      return sides ? [[vscode.Uri.file(path.join(repo.root, file.path)), sides.left, sides.right]] : [];
    });
    if (resources.length) await vscode.commands.executeCommand('vscode.changes', title, resources);
  }

  private async openDiff(source: DiffSource, file: FileChange, repo = this.repo): Promise<void> {
    if (!repo) return;
    const onDisk = vscode.Uri.file(path.join(repo.root, file.path));
    const at = (ref: string) => contentUri(repo.root, ref, file.path);

    switch (source.kind) {
      case 'commit':
      case 'worktree':
      case 'staged':
      case 'unstaged': {
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
          const [current, incoming] = CONFLICT_SIDES[this.state?.operation ?? 'none'];
          try {
            // The command the built-in Git extension uses. It is not part of the documented API, hence the fallback.
            await vscode.commands.executeCommand('_open.mergeEditor', {
              base: at(CONFLICT.base),
              input1: { uri: at(CONFLICT.ours), title: 'Current', description: current },
              input2: { uri: at(CONFLICT.theirs), title: 'Incoming', description: incoming },
              output: onDisk,
            });
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

  /** `data` becomes the `data-` attributes of the body, which is where the page reads what view it is. */
  private html(webview: vscode.Webview, dist: vscode.Uri, data: Record<string, string>): string {
    const escape = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
    const attributes = Object.entries(data).map(([name, value]) => `data-${name}="${escape(value)}"`).join(' ');
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    const csp = `default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
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
