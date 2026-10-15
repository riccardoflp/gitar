import * as vscode from 'vscode';
import { discoverRepos } from '../git/discover';
import type { RepoState, SyncAction, ViewKind } from '../shared/protocol';
import { BlameAnnotator, BlameSource } from './blame';
import { GitContentProvider, SCHEME } from './content';
import { Controller } from './controller';
import { FileBlame } from './fileBlame';

const GRAPH_VIEW = 'gitardo.graph';
const CHANGES_VIEW = 'gitardo.changes';
const COMMITS_VIEW = 'gitardo.commits';
const SIDE_GRAPH_VIEW = 'gitardo.sideGraph';
const BRANCHES_VIEW = 'gitardo.branches';
const STASHES_VIEW = 'gitardo.stashes';

/** What the extension hands to whoever activates it: the end-to-end tests drive it through this. */
export interface GitardoApi {
  controller: Controller;
  log: vscode.LogOutputChannel;
  fileBlame: FileBlame;
}

export function activate(context: vscode.ExtensionContext): GitardoApi {
  const log = vscode.window.createOutputChannel('Gitardo', { log: true });
  const controller = new Controller(context.extensionUri, log, context.workspaceState);
  const blameSource = new BlameSource(log);
  const fileBlame = new FileBlame(blameSource, {
    open: (hash, repo) => controller.openCommit(hash, repo),
    reveal: (hash) => controller.reveal(hash),
  });

  const graphProvider: vscode.WebviewViewProvider = {
    resolveWebviewView(view) {
      const attachment = controller.attach(view.webview, 'graph');
      view.onDidDispose(() => attachment.dispose());
    },
  };

  /**
   * One of the views in the Source Control side bar of VS Code. `describe` is what its header says after its name,
   * such as how many stashes there are. None of them counts the changes on the icon of the side bar: VS Code does.
   */
  const sideView = (kind: ViewKind, describe?: (state: RepoState) => string | undefined): vscode.WebviewViewProvider => ({
    resolveWebviewView(view) {
      const attachment = controller.attach(view.webview, kind);
      const described = controller.onDidChangeState((state) => {
        view.description = state && describe ? describe(state) : undefined;
      });
      view.onDidDispose(() => vscode.Disposable.from(attachment, described).dispose());
    },
  });

  const openInEditor = () => {
    const panel = vscode.window.createWebviewPanel('gitardo.graphEditor', 'Gitardo', vscode.ViewColumn.Active, {
      retainContextWhenHidden: true,
    });
    const attachment = controller.attach(panel.webview, 'graph');
    panel.onDidDispose(() => attachment.dispose());
  };

  /** Turns a setting that is on or off into the other, for the user wherever they work. */
  const toggleSetting = (name: string) => () => {
    const config = vscode.workspace.getConfiguration('gitardo');
    return config.update(name, !config.get<boolean>(name), vscode.ConfigurationTarget.Global);
  };

  // A way to the graph that is always in sight, as a tab of the editor: the one the panel opens from its own header.
  const status = vscode.window.createStatusBarItem('gitardo.graph', vscode.StatusBarAlignment.Left, 0);
  status.name = 'Gitardo Graph';
  status.text = '$(git-commit) Gitardo';
  status.tooltip = 'Open the Gitardo graph in an editor tab';
  status.command = 'gitardo.openInEditor';
  // Only where there is a repository to show, as the button of the editors that shows the blame of a file: looked
  // for now, since no view may be open to read one, and again when the folders of the workspace change. A repository
  // made later shows them as soon as a view reads it.
  const hasRepository = (has: boolean) => {
    if (has) status.show();
    else status.hide();
    void vscode.commands.executeCommand('setContext', 'gitardo.hasRepository', has);
  };
  const lookForRepos = async () => {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    hasRepository((await discoverRepos(folders).catch(() => [])).length > 0);
  };
  void lookForRepos();
  const shown = vscode.Disposable.from(
    vscode.workspace.onDidChangeWorkspaceFolders(lookForRepos),
    controller.onDidChangeState((state) => {
      if (!state) return;
      hasRepository(true);
      // A commit made since gives its name to the lines that had none.
      fileBlame.refresh();
    }),
  );

  const command = (id: string, handler: (...args: unknown[]) => unknown) => vscode.commands.registerCommand(id, handler);
  /** The files of what VS Code hands to a command of its own list of changes: the files clicked, or the group they are in. */
  const scmFiles = (given: unknown[]): vscode.Uri[] =>
    given.flatMap((each) => {
      const item = each as { resourceUri?: unknown; resourceStates?: unknown } | undefined;
      if (item?.resourceUri instanceof vscode.Uri) return [item.resourceUri];
      return Array.isArray(item?.resourceStates) ? scmFiles(item.resourceStates) : [];
    });
  const syncActions: SyncAction[] = [
    'fetch',
    'pull',
    'pullRebase',
    'pullAutostash',
    'pullRebaseAutostash',
    'push',
    'pushForceWithLease',
    'pushForce',
  ];
  const webviewOptions = { webviewOptions: { retainContextWhenHidden: true } };

  context.subscriptions.push(
    log,
    controller,
    status,
    shown,
    new BlameAnnotator(blameSource),
    fileBlame,
    command('gitardo.fileHistory', (uri) => controller.fileHistory(uri instanceof vscode.Uri ? uri : undefined)),
    command('gitardo.revealCommit', (hash) => typeof hash === 'string' && controller.reveal(hash)),
    command('gitardo.reflog', () => controller.command('reflog')),
    command('gitardo.cleanupBranches', () => controller.command('cleanupBranches')),
    command('gitardo.signInGitHub', () => controller.command('signInGitHub')),
    command('gitardo.toggleBlame', toggleSetting('blame.enabled')),
    // Each of the two has a command for the palette and two for the button of the editors, in its two states.
    ...['gitardo.toggleBlameWhitespace', 'gitardo.blameIgnoreWhitespace', 'gitardo.blameCountWhitespace'].map((id) =>
      command(id, toggleSetting('blame.ignoreWhitespaceAndMoves')),
    ),
    ...['gitardo.toggleBlameEveryFile', 'gitardo.blameEveryFile', 'gitardo.blameChosenFiles'].map((id) =>
      command(id, toggleSetting('fileBlame.everyFile')),
    ),
    command('gitardo.openLineCommit', () => fileBlame.openLine()),
    command('gitardo.revealLineCommit', () => fileBlame.revealLine()),
    command('gitardo.blamePrevious', (root, hash, file) => fileBlame.previous(root, hash, file)),
    // The button of an editor names its file, which is not the active one when the button is of another group.
    ...['gitardo.toggleFileBlame', 'gitardo.showFileBlame', 'gitardo.hideFileBlame'].map((id) =>
      command(id, (uri) => fileBlame.toggle(uri instanceof vscode.Uri ? uri : undefined)),
    ),
    command('gitardo.switchIdentity', () => controller.command('switchIdentity')),
    command('gitardo.selectRepository', () => controller.command('selectRepository')),
    command('gitardo.remotes', () => controller.command('remotes')),
    command('gitardo.bisectReset', () => controller.action({ kind: 'bisectReset' })),
    command('gitardo.compare', () => controller.compare()),
    command('gitardo.goToCommit', () => controller.goToCommit()),
    command('gitardo.openCommit', (hash) => controller.openCommit(typeof hash === 'string' ? hash : undefined)),
    command('gitardo.resolveConflicts', () => controller.action({ kind: 'resolveConflicts' })),
    // The views that list commits put the cursor in their search box at Ctrl+F by themselves. While one of them has the
    // keyboard the key is bound to this, for VS Code to run something other than the search of the editor behind them.
    command('gitardo.find', () => {}),
    command('gitardo.createBranch', () => controller.action({ kind: 'createBranch', at: 'HEAD' })),
    command('gitardo.createWorktree', () => controller.action({ kind: 'worktreeAdd' })),
    command('gitardo.switchWorktree', () => controller.command('switchWorktree')),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitContentProvider()),
    vscode.window.registerWebviewViewProvider(GRAPH_VIEW, graphProvider, webviewOptions),
    // Hidden until it is asked for: VS Code has its own list of changes just above.
    vscode.window.registerWebviewViewProvider(CHANGES_VIEW, sideView('changes'), webviewOptions),
    vscode.window.registerWebviewViewProvider(
      COMMITS_VIEW,
      // What its commits are of: the branch, and the repository when there are several.
      sideView('commits', (state) => {
        const branch = state.branch ?? (state.head ? `detached at ${state.head.slice(0, 7)}` : undefined);
        return state.repos.length > 1 ? [state.name, branch].filter(Boolean).join(' · ') : branch;
      }),
      webviewOptions,
    ),
    vscode.window.registerWebviewViewProvider(
      SIDE_GRAPH_VIEW,
      // There is no room there for the box that names the repository, which matters when there are several.
      sideView('sideGraph', (state) => (state.repos.length > 1 ? state.name : undefined)),
      webviewOptions,
    ),
    vscode.window.registerWebviewViewProvider(
      BRANCHES_VIEW,
      sideView('branches', (state) => state.branch ?? (state.head ? `detached at ${state.head.slice(0, 7)}` : undefined)),
      webviewOptions,
    ),
    vscode.window.registerWebviewViewProvider(
      STASHES_VIEW,
      sideView('stashes', (state) => (state.stashes.length ? String(state.stashes.length) : undefined)),
      webviewOptions,
    ),
    command('gitardo.openGraph', () => vscode.commands.executeCommand(`${GRAPH_VIEW}.focus`)),
    command('gitardo.openChanges', () => vscode.commands.executeCommand(`${CHANGES_VIEW}.focus`)),
    command('gitardo.openCommits', () => vscode.commands.executeCommand(`${COMMITS_VIEW}.focus`)),
    command('gitardo.openSideGraph', () => vscode.commands.executeCommand(`${SIDE_GRAPH_VIEW}.focus`)),
    command('gitardo.openBranches', () => vscode.commands.executeCommand(`${BRANCHES_VIEW}.focus`)),
    command('gitardo.openStashes', () => vscode.commands.executeCommand(`${STASHES_VIEW}.focus`)),
    command('gitardo.openInEditor', openInEditor),
    command('gitardo.refresh', () => controller.refresh()),
    command('gitardo.showLog', () => log.show()),
    command('gitardo.stash', () => controller.action({ kind: 'stashPush' })),
    // The buttons Gitardo adds to the list of changes of VS Code, in the repository of what they are on.
    command('gitardo.scmStashFile', (...files) => controller.stashFromScm(scmFiles(files), 'files')),
    command('gitardo.scmStashStaged', (...groups) => controller.stashFromScm(scmFiles(groups), 'staged')),
    command('gitardo.scmStashAll', (...groups) => controller.stashFromScm(scmFiles(groups), 'all')),
    command('gitardo.undo', () => controller.action({ kind: 'undo' })),
    // Pull is the button, which pulls the way the settings choose: the pull with no option has a command of its own.
    ...syncActions.map((action) => command(`gitardo.${action}`, () => (action === 'pull' ? controller.pull() : controller.sync(action)))),
    command('gitardo.pullPlain', () => controller.sync('pull')),
  );
  return { controller, log, fileBlame };
}

export function deactivate(): void {}
