import * as vscode from 'vscode';
import type { RepoState, SyncAction, ViewKind } from '../shared/protocol';
import { BlameAnnotator } from './blame';
import { GitContentProvider, SCHEME } from './content';
import { Controller } from './controller';

const GRAPH_VIEW = 'gitar.graph';
const CHANGES_VIEW = 'gitar.changes';
const COMMITS_VIEW = 'gitar.commits';
const BRANCHES_VIEW = 'gitar.branches';
const STASHES_VIEW = 'gitar.stashes';

/** What the extension hands to whoever activates it: the end-to-end tests drive it through this. */
export interface GitarApi {
  controller: Controller;
  log: vscode.LogOutputChannel;
}

export function activate(context: vscode.ExtensionContext): GitarApi {
  const log = vscode.window.createOutputChannel('Gitar', { log: true });
  const controller = new Controller(context.extensionUri, log, context.workspaceState);

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
    const panel = vscode.window.createWebviewPanel('gitar.graphEditor', 'Gitar', vscode.ViewColumn.Active, {
      retainContextWhenHidden: true,
    });
    const attachment = controller.attach(panel.webview, 'graph');
    panel.onDidDispose(() => attachment.dispose());
  };

  const toggleBlame = () => {
    const config = vscode.workspace.getConfiguration('gitar');
    return config.update('blame.enabled', !config.get<boolean>('blame.enabled'), vscode.ConfigurationTarget.Global);
  };

  const command = (id: string, handler: (argument?: unknown) => unknown) => vscode.commands.registerCommand(id, handler);
  const syncActions: SyncAction[] = ['fetch', 'pull', 'pullRebase', 'push', 'pushForceWithLease', 'pushForce'];
  const webviewOptions = { webviewOptions: { retainContextWhenHidden: true } };

  context.subscriptions.push(
    log,
    controller,
    new BlameAnnotator(log),
    command('gitar.fileHistory', (uri) => controller.fileHistory(uri instanceof vscode.Uri ? uri : undefined)),
    command('gitar.revealCommit', (hash) => typeof hash === 'string' && controller.reveal(hash)),
    command('gitar.reflog', () => controller.command('reflog')),
    command('gitar.cleanupBranches', () => controller.command('cleanupBranches')),
    command('gitar.signInGitHub', () => controller.command('signInGitHub')),
    command('gitar.toggleBlame', toggleBlame),
    command('gitar.switchIdentity', () => controller.command('switchIdentity')),
    command('gitar.selectRepository', () => controller.command('selectRepository')),
    command('gitar.remotes', () => controller.command('remotes')),
    command('gitar.bisectReset', () => controller.action({ kind: 'bisectReset' })),
    command('gitar.compare', () => controller.compare()),
    command('gitar.goToCommit', () => controller.goToCommit()),
    command('gitar.openCommit', (hash) => controller.openCommit(typeof hash === 'string' ? hash : undefined)),
    command('gitar.resolveConflicts', () => controller.action({ kind: 'resolveConflicts' })),
    // The views that list commits put the cursor in their search box at Ctrl+F by themselves. While one of them has the
    // keyboard the key is bound to this, for VS Code to run something other than the search of the editor behind them.
    command('gitar.find', () => {}),
    command('gitar.createBranch', () => controller.action({ kind: 'createBranch', at: 'HEAD' })),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitContentProvider()),
    vscode.window.registerWebviewViewProvider(GRAPH_VIEW, graphProvider, webviewOptions),
    // Hidden until it is asked for: VS Code has its own list of changes just above.
    vscode.window.registerWebviewViewProvider(CHANGES_VIEW, sideView('changes'), webviewOptions),
    vscode.window.registerWebviewViewProvider(
      COMMITS_VIEW,
      // There is no room there for the box that names the repository, which matters when there are several.
      sideView('commits', (state) => (state.repos.length > 1 ? state.name : undefined)),
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
    command('gitar.openGraph', () => vscode.commands.executeCommand(`${GRAPH_VIEW}.focus`)),
    command('gitar.openChanges', () => vscode.commands.executeCommand(`${CHANGES_VIEW}.focus`)),
    command('gitar.openCommits', () => vscode.commands.executeCommand(`${COMMITS_VIEW}.focus`)),
    command('gitar.openBranches', () => vscode.commands.executeCommand(`${BRANCHES_VIEW}.focus`)),
    command('gitar.openStashes', () => vscode.commands.executeCommand(`${STASHES_VIEW}.focus`)),
    command('gitar.openInEditor', openInEditor),
    command('gitar.refresh', () => controller.refresh()),
    command('gitar.showLog', () => log.show()),
    command('gitar.stash', () => controller.action({ kind: 'stashPush' })),
    command('gitar.undo', () => controller.action({ kind: 'undo' })),
    ...syncActions.map((action) => command(`gitar.${action}`, () => controller.sync(action))),
  );
  return { controller, log };
}

export function deactivate(): void {}
