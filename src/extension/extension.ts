import * as vscode from 'vscode';
import type { SyncAction } from '../shared/protocol';
import { BlameAnnotator } from './blame';
import { GitContentProvider, SCHEME } from './content';
import { Controller } from './controller';

const GRAPH_VIEW = 'gitar.graph';
const CHANGES_VIEW = 'gitar.changes';

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

  const changesProvider: vscode.WebviewViewProvider = {
    resolveWebviewView(view) {
      const attachment = controller.attach(view.webview, 'changes');
      // The number on the activity bar icon: how many files have uncommitted changes.
      const badge = controller.onDidChangeState((state) => {
        const count = state?.changes ?? 0;
        view.badge = count ? { value: count, tooltip: `${count} changed ${count === 1 ? 'file' : 'files'}` } : undefined;
      });
      view.onDidDispose(() => vscode.Disposable.from(attachment, badge).dispose());
    },
  };

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
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitContentProvider()),
    vscode.window.registerWebviewViewProvider(GRAPH_VIEW, graphProvider, webviewOptions),
    vscode.window.registerWebviewViewProvider(CHANGES_VIEW, changesProvider, webviewOptions),
    command('gitar.openGraph', () => vscode.commands.executeCommand(`${GRAPH_VIEW}.focus`)),
    command('gitar.openChanges', () => vscode.commands.executeCommand(`${CHANGES_VIEW}.focus`)),
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
