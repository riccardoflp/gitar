import * as path from 'node:path';
import * as vscode from 'vscode';
import { discardOp, stageOp, unstageOp } from '../git/ops';
import { Repo } from '../git/repo';
import { buildModel, refreshPanel } from './build';
import { ChunkActions, type RunOp } from './chunks';
import { DiffEngine } from './engine';
import { FlowMerge } from './merge';
import { type DiffHost, type DiffPanel, PanelRegistry } from './panel';
import { Refresher } from './refresher';
import { type DiffDescriptor, changedFiles, describeDiff, fileUri, openInDiffEditor } from './sides';
import { ThemeService } from './theme';

/**
 * Flow Diff: a file of a repository side by side in two Monaco editors, joined by the connectors of its changes, with
 * the actions of each change between them. It is one way to look at a diff, next to the diff editor of VS Code: a
 * button of either opens the same diff in the other, in place of itself.
 */
export class FlowDiff implements vscode.Disposable {
  private readonly engine: DiffEngine;
  private readonly registry: PanelRegistry;
  private readonly refresher: Refresher;
  /** The three columns of a file in conflict, which share the worker and the themes. */
  readonly merge: FlowMerge;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    extensionUri: vscode.Uri,
    private readonly runOp: RunOp,
  ) {
    // The worker is bundled next to the extension itself.
    this.engine = new DiffEngine(path.join(__dirname, 'flowWorker.js'));
    const refresh = (panel: DiffHost) => refreshPanel(this.engine, panel);
    const chunks = new ChunkActions(runOp, refresh);
    const themes = new ThemeService();
    this.registry = new PanelRegistry(extensionUri, themes, {
      chunkAction: (panel, message) => void chunks.handle(panel, message.type, message.chunkId),
      navigateFile: (panel, direction) => void this.openAdjacentFile(panel, direction),
    });
    this.refresher = new Refresher(this.registry, refresh);
    this.merge = new FlowMerge(extensionUri, this.engine, themes, runOp);

    const command = (id: string, handler: (...args: unknown[]) => unknown) => vscode.commands.registerCommand(id, handler);
    this.disposables.push(
      this.registry,
      this.merge,
      this.refresher,
      this.engine,
      vscode.window.onDidChangeActiveColorTheme(() => {
        for (const panel of this.registry.all()) void panel.refreshTheme();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('editor')) return;
        for (const panel of this.registry.all()) panel.refreshEditorConfig();
      }),
      command('gitardo.openInFlowDiff', (uri) => this.openFromDiffEditor(uri instanceof vscode.Uri ? uri : undefined)),
      command('gitardo.flowDiff.openInDiffEditor', () => this.openInDiffEditor()),
      command('gitardo.flowDiff.nextChange', () => this.registry.getActive()?.navigate('next')),
      command('gitardo.flowDiff.previousChange', () => this.registry.getActive()?.navigate('prev')),
      command('gitardo.flowDiff.openFile', () => this.fileAction('open')),
      command('gitardo.flowDiff.stageFile', () => this.fileAction('stage')),
      command('gitardo.flowDiff.unstageFile', () => this.fileAction('unstage')),
      command('gitardo.flowDiff.discardFile', () => this.fileAction('discard')),
    );
  }

  /** Gitardo has read a repository again: what it shows may have moved. */
  repositoryChanged(root: string): void {
    this.refresher.repositoryChanged(root);
    this.merge.repositoryChanged(root);
  }

  /** The panels open, for the tests. */
  panels(): DiffPanel[] {
    return this.registry.all();
  }

  /** Shows a diff, in the group of `viewColumn`. Resolves to whether there is one to show. */
  async open(descriptor: DiffDescriptor, viewColumn?: vscode.ViewColumn): Promise<boolean> {
    const existing = this.registry.get(descriptor);
    if (existing) {
      existing.reveal();
      return true;
    }
    const built = await buildModel(this.engine, descriptor, { interactive: true });
    if (!built) return false;
    const panel = this.registry.create(descriptor, viewColumn);
    panel.setModel(built.model, built.inputKey);
    this.refresher.watch(descriptor.repoRoot);
    return true;
  }

  /** The button of a diff editor: the same diff, in a Flow Diff that takes the place of the editor. */
  private async openFromDiffEditor(uri?: vscode.Uri): Promise<void> {
    const isDiff = (tab: vscode.Tab): tab is vscode.Tab & { input: vscode.TabInputTextDiff } => tab.input instanceof vscode.TabInputTextDiff;
    // The button names the file of its editor, which is not the active one when the button is of another group.
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter(isDiff);
    const active = vscode.window.tabGroups.activeTabGroup.activeTab;
    const tab = (uri && tabs.find((each) => each.isActive && each.input.modified.toString() === uri.toString())) ?? (active && isDiff(active) ? active : undefined);
    if (!tab) return;
    const descriptor = await describeDiff(tab.input.original, tab.input.modified);
    if (!descriptor) {
      void vscode.window.showInformationMessage('Flow Diff shows a file of a Git repository against another version of the same file: this diff is not one.');
      return;
    }
    if (await this.open(descriptor, tab.group.viewColumn)) await vscode.window.tabGroups.close(tab);
  }

  /** The button of a Flow Diff: the same diff in the diff editor of VS Code, in its place. */
  private async openInDiffEditor(): Promise<void> {
    const panel = this.registry.getActive();
    if (!panel) return;
    await openInDiffEditor(panel.descriptor, panel.viewColumn);
    panel.close();
  }

  /** Whole-file actions for the panel title bar (parity with the built-in diff editor). */
  private async fileAction(kind: 'open' | 'stage' | 'unstage' | 'discard'): Promise<void> {
    const panel = this.registry.getActive();
    if (!panel) return;
    const { repoRoot, path: file } = panel.descriptor;
    if (kind === 'open') {
      await vscode.window.showTextDocument(fileUri(panel.descriptor), { preview: false });
      return;
    }
    const repo = new Repo(repoRoot);
    let ran = false;
    if (kind === 'stage') ran = await this.runOp(repoRoot, stageOp([file]));
    if (kind === 'unstage') ran = await this.runOp(repoRoot, unstageOp([file], (await repo.resolve('HEAD')) !== null));
    // Asked first, as every operation that can lose work.
    if (kind === 'discard') ran = await this.runOp(repoRoot, discardOp([file], await repo.working()));
    if (ran) await refreshPanel(this.engine, panel);
  }

  /**
   * F7 past the last chunk: replaces the panel with the diff of the next (or
   * previous) changed file, in path order, wrapping around. Files that cannot
   * be diffed (binary, too complex) are skipped.
   */
  private async openAdjacentFile(panel: DiffPanel, direction: 'next' | 'prev'): Promise<void> {
    const { descriptor } = panel;
    const working = await new Repo(descriptor.repoRoot).working().catch(() => null);
    const files = working ? (changedFiles(descriptor, working) ?? []).sort(compare) : [];
    const current = descriptor.path;
    // files after the current one in the given direction, then wrapping around
    const below = files.filter((f) => compare(f, current) < 0);
    const above = files.filter((f) => compare(f, current) > 0);
    const candidates = direction === 'next' ? [...above, ...below] : [...below.reverse(), ...above.reverse()];

    for (const candidate of candidates) {
      const next: DiffDescriptor = { ...descriptor, path: candidate, oldPath: undefined };
      const existing = this.registry.get(next);
      if (existing) {
        existing.reveal();
        panel.close();
        return;
      }
      const built = await buildModel(this.engine, next, { interactive: false });
      if (built) {
        const created = this.registry.create(next, panel.viewColumn);
        created.setModel(built.model, built.inputKey);
        panel.close();
        return;
      }
    }
    void vscode.window.showInformationMessage('Flow Diff: no other changed files.');
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

function compare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}
