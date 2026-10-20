import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CONFLICT_SIDES, stageOp } from '../git/ops';
import { Repo } from '../git/repo';
import { samePath } from '../git/parse';
import type { Operation } from '../shared/protocol';
import { CONFLICT, contentUri } from '../extension/content';
import { answers } from '../extension/answers';
import { resolveConflicts } from '../git/conflicts';
import { answerProposal, fingerprint, rulesProposal } from '../git/review';
import { normalizeEol } from './diff/hunks';
import { markerBlockCount, mergeEditorStart } from './diff/merge3';
import { bounds, type MergeModel, type MergeProposal } from './diff/mergeModel';
import type { MergeHostMessage, MergeWebviewMessage } from './diff/mergeProtocol';
import { minimalReplace, offsetToPosition } from './diff/textEdit';
import type { RunOp } from './chunks';
import type { DiffEngine } from './engine';
import { inRepository } from './sides';
import type { ThemeService } from './theme';

/** A file in conflict, in a repository. */
export interface MergeDescriptor {
  repoRoot: string;
  /** Relative to the repository, with forward slashes. */
  path: string;
}

/** Beyond this many lines of the four texts together, ask before computing. */
const LARGE_FILE_LINES = 200_000;
/** A diff still running after this long is abandoned as too complex. */
const DIFF_TIMEOUT_MS = 5_000;
/** Where the bundled page is, under the folder of the extension. */
const DIST = ['dist', 'flow'];

/** The commands that focus each of the first editor groups. */
const FOCUS_GROUP = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'].map((nth) => `workbench.action.focus${nth}EditorGroup`);

const fileUri = (d: MergeDescriptor) => vscode.Uri.file(path.join(d.repoRoot, d.path));
const sameFile = (one: MergeDescriptor, two: MergeDescriptor) => samePath(one.repoRoot, two.repoRoot) && one.path === two.path;

/**
 * Opens a file in conflict in the merge editor of VS Code, with the three sides git keeps in the index. The command
 * is the one the built-in Git extension uses: it is not part of the documented API, so it can fail.
 */
export async function openMergeEditor(root: string, file: string, operation: Operation | null): Promise<void> {
  const [current, incoming] = CONFLICT_SIDES[operation ?? 'none'];
  const at = (ref: string) => contentUri(root, ref, file);
  await vscode.commands.executeCommand('_open.mergeEditor', {
    base: at(CONFLICT.base),
    input1: { uri: at(CONFLICT.ours), title: 'Current', description: current },
    input2: { uri: at(CONFLICT.theirs), title: 'Incoming', description: incoming },
    output: vscode.Uri.file(path.join(root, file)),
  });
}

/**
 * The Flow Merge: a file in conflict in three columns, what the current side has, the result and what the incoming
 * side has, with the changes of each side joined by bands to where they are in the result. It is one way to look at
 * a merge, next to the merge editor of VS Code: a button of either opens the same file in the other, in place of it.
 */
export class FlowMerge implements vscode.Disposable {
  private readonly panels: MergePanel[] = [];
  private readonly timers = new Map<MergePanel, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly engine: DiffEngine,
    private readonly themes: ThemeService,
    private readonly runOp: RunOp,
  ) {
    const command = (id: string, handler: (...args: unknown[]) => unknown) => vscode.commands.registerCommand(id, handler);
    this.disposables.push(
      command('gitardo.openInFlowMerge', (uri) => this.openFromEditor(uri instanceof vscode.Uri ? uri : undefined)),
      command('gitardo.flowMerge.openInMergeEditor', () => this.openInMergeEditor()),
      command('gitardo.flowMerge.openFile', () => this.openFile()),
      command('gitardo.flowMerge.nextChange', () => this.active()?.navigate('next')),
      command('gitardo.flowMerge.previousChange', () => this.active()?.navigate('prev')),
      vscode.window.onDidChangeActiveColorTheme(() => {
        for (const panel of this.panels) void panel.refreshTheme();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('editor')) for (const panel of this.panels) panel.refreshEditorConfig();
        // The rules propose, or no longer.
        if (event.affectsConfiguration('gitardo.conflicts')) for (const panel of this.panels) void this.refresh(panel, true);
      }),
      // The language model answered about a conflict, here or in the review of the conflicts.
      answers.onDidChange((root) => {
        for (const panel of this.panels) if (samePath(panel.descriptor.repoRoot, root)) void this.refresh(panel, true);
      }),
      // The result is the file: what is typed in its editor shows here as it is typed.
      vscode.workspace.onDidChangeTextDocument((event) => {
        for (const panel of this.panels) if (samePath(event.document.uri.fsPath, fileUri(panel.descriptor).fsPath)) this.schedule(panel);
      }),
    );
  }

  /** The panels open, for the tests. */
  all(): readonly MergePanel[] {
    return this.panels;
  }

  /** Gitardo has read a repository again: the sides of a conflict may have changed, or be gone. */
  repositoryChanged(root: string): void {
    for (const panel of this.panels) if (samePath(panel.descriptor.repoRoot, root)) this.schedule(panel);
  }

  /** Shows a file in conflict, in the group of `viewColumn`. Resolves to whether there is one to show. */
  async open(descriptor: MergeDescriptor, viewColumn?: vscode.ViewColumn): Promise<boolean> {
    const existing = this.panels.find((panel) => sameFile(panel.descriptor, descriptor));
    if (existing) {
      existing.reveal();
      return true;
    }
    const built = await buildMerge(this.engine, descriptor, true);
    if (!built) return false;
    const panel = new MergePanel(this.extensionUri, descriptor, this.themes, viewColumn, {
      onDispose: () => {
        this.panels.splice(this.panels.indexOf(panel), 1);
        clearTimeout(this.timers.get(panel));
        this.timers.delete(panel);
      },
      markResolved: () => this.markResolved(panel),
    });
    this.panels.push(panel);
    panel.setModel(built.model, built.inputKey);
    return true;
  }

  private schedule(panel: MergePanel): void {
    clearTimeout(this.timers.get(panel));
    this.timers.set(
      panel,
      setTimeout(() => {
        this.timers.delete(panel);
        void this.refresh(panel);
      }, 250),
    );
  }

  /** Builds the model of a panel again, when what it is made from changed, or when `always` because the proposals did. */
  private async refresh(panel: MergePanel, always = false): Promise<void> {
    // Once resolved and added, the file has no sides any more: the panel keeps what it showed last.
    const built = await buildMerge(this.engine, panel.descriptor, false, always ? undefined : panel.inputKey);
    if (built && this.panels.includes(panel)) panel.setModel(built.model, built.inputKey);
  }

  /**
   * The button of the page: the file saved and staged, which is how git is told a conflict is resolved, and the page
   * closed. Markers of git still in it are asked about first: staged with them, they would be committed.
   */
  private async markResolved(panel: MergePanel): Promise<void> {
    const { repoRoot, path: file } = panel.descriptor;
    const document = await vscode.workspace.openTextDocument(fileUri(panel.descriptor));
    const left = markerBlockCount(normalizeEol(document.getText()));
    if (left > 0) {
      const mark = 'Mark as Resolved';
      const choice = await vscode.window.showWarningMessage(
        `${path.posix.basename(file)} still has ${left === 1 ? 'a conflict' : `${left} conflicts`} marked by git. Mark it as resolved all the same, with the markers in it?`,
        { modal: true },
        mark,
      );
      if (choice !== mark) return;
    }
    if (document.isDirty && !(await document.save())) return;
    if (await this.runOp(repoRoot, stageOp([file]))) panel.close();
  }

  private active(): MergePanel | undefined {
    return this.panels.find((panel) => panel.active);
  }

  /** The button of the merge editor, or the command on a file in conflict: the file, in a Flow Merge in its place. */
  private async openFromEditor(uri?: vscode.Uri): Promise<void> {
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter(isMerge);
    const current = vscode.window.tabGroups.activeTabGroup.activeTab;
    // The button names the file of its editor, which is not the active one when the button is of another group.
    const tab = (uri && tabs.find((each) => each.isActive && samePath(each.input.result.fsPath, uri.fsPath))) ?? (current && isMerge(current) ? current : undefined);
    const file = tab?.input.result ?? uri ?? vscode.window.activeTextEditor?.document.uri;
    const at = file?.scheme === 'file' ? await inRepository(file.fsPath) : undefined;
    if (!at) {
      void vscode.window.showInformationMessage('Flow Merge shows a file of a Git repository that is in conflict: open one first.');
      return;
    }
    const descriptor = { repoRoot: at.root, path: at.path };
    const viewColumn = tab?.group.viewColumn ?? vscode.window.tabGroups.activeTabGroup.viewColumn;
    if (tab && !(await this.leaveMergeEditor(tab, descriptor))) return;
    await this.open(descriptor, viewColumn);
  }

  /**
   * Closes a merge editor, to show its file here. As it opens, the merge editor writes in the file, without saving
   * it, its own start of the result, where the conflicts are the base and the markers of git are gone: that is
   * undone, for the result here to be the file git wrote. What was chosen or typed in it since is asked about first.
   * Resolves to whether it was closed.
   */
  private async leaveMergeEditor(tab: vscode.Tab & { input: { result: vscode.Uri } }, descriptor: MergeDescriptor): Promise<boolean> {
    const repo = new Repo(descriptor.repoRoot);
    const stages = await repo.conflictStages(descriptor.path).catch(() => [] as number[]);
    // Not a file in conflict any more: the merge editor stays, and opening the Flow Merge says why it cannot.
    if (!stages.includes(2) || !stages.includes(3)) return true;
    const document = vscode.workspace.textDocuments.find((each) => samePath(each.uri.fsPath, tab.input.result.fsPath));
    if (document?.isDirty) {
      const stage = (number: number) => (stages.includes(number) ? repo.show(`:${number}`, descriptor.path).catch(() => '') : Promise.resolve(''));
      const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)]);
      const untouched = normalizeEol(document.getText()) === mergeEditorStart(base, ours, theirs, DIFF_TIMEOUT_MS);
      if (!untouched) {
        const discard = 'Discard and Open';
        const choice = await vscode.window.showWarningMessage(
          `The merge editor has changes to ${path.posix.basename(descriptor.path)} that are not saved. The Flow Merge shows the file as git wrote it, with its conflict markers: discard those changes?`,
          { modal: true },
          discard,
        );
        if (choice !== discard) return false;
      }
    }
    // Reverting is what closes it without asking about the conflicts it still has, and it acts on the active editor:
    // the button can be of a group that is not the active one.
    const isThis = (each: vscode.Tab | undefined) => !!each && isMerge(each) && samePath(each.input.result.fsPath, tab.input.result.fsPath);
    const focus = FOCUS_GROUP[(tab.group.viewColumn ?? 1) - 1];
    if (!isThis(vscode.window.tabGroups.activeTabGroup.activeTab) && tab.isActive && focus) await vscode.commands.executeCommand(focus);
    if (isThis(vscode.window.tabGroups.activeTabGroup.activeTab)) {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    } else {
      await vscode.window.tabGroups.close(tab);
    }
    return true;
  }

  /** The button of a Flow Merge: the same file in the merge editor of VS Code, in its place. */
  private async openInMergeEditor(): Promise<void> {
    const panel = this.active();
    if (!panel) return;
    const { repoRoot, path: file } = panel.descriptor;
    const repo = new Repo(repoRoot);
    const stages = await repo.conflictStages(file).catch(() => [] as number[]);
    // What was chosen here and not saved is not lost: the merge editor saves the file as it opens it. Where markers of
    // git are left in it, it then starts its own result again from the base, without saving that.
    try {
      // The merge editor needs all three sides: a file both sides added has no base, and opens as it is.
      if ([1, 2, 3].every((stage) => stages.includes(stage))) await openMergeEditor(repoRoot, file, await repo.operation().catch(() => null));
      else await vscode.window.showTextDocument(fileUri(panel.descriptor), { preview: false });
    } catch (error) {
      void vscode.window.showWarningMessage(`Flow Merge: could not open the merge editor — ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    panel.close();
  }

  private async openFile(): Promise<void> {
    const panel = this.active();
    if (panel) await vscode.window.showTextDocument(fileUri(panel.descriptor), { preview: false });
  }

  dispose(): void {
    for (const panel of [...this.panels]) panel.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.disposables.forEach((d) => d.dispose());
  }
}

/**
 * Whether a tab is a merge editor. Its kind of input is a proposed API, not in the stable one, but the tab has it all
 * the same: the three sides and the result.
 */
function isMerge(tab: vscode.Tab): tab is vscode.Tab & { input: { result: vscode.Uri } } {
  const input = tab.input as Record<string, unknown> | undefined;
  return !!input && ['base', 'input1', 'input2', 'result'].every((key) => input[key] instanceof vscode.Uri);
}

/** The page of one file in conflict. */
export class MergePanel {
  static readonly viewType = 'gitardo.flowMerge';

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private model: MergeModel | undefined;
  private modelInputKey: string | undefined;
  private webviewReady = false;
  private closing = false;
  private queue: Promise<void> = Promise.resolve();
  /** Whether the page has its first model; public for the tests. */
  initSent = false;

  constructor(
    extensionUri: vscode.Uri,
    readonly descriptor: MergeDescriptor,
    private readonly themes: ThemeService,
    viewColumn: vscode.ViewColumn | undefined,
    private readonly handlers: { onDispose: () => void; markResolved: () => Promise<void> },
  ) {
    this.panel = vscode.window.createWebviewPanel(MergePanel.viewType, `${path.posix.basename(descriptor.path)} (Current ↔ Incoming)`, viewColumn ?? vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, ...DIST)],
    });
    this.panel.webview.html = this.renderHtml(extensionUri);
    this.panel.webview.onDidReceiveMessage((message: MergeWebviewMessage) => this.onMessage(message), undefined, this.disposables);
    this.panel.onDidDispose(
      () => {
        this.disposables.forEach((d) => d.dispose());
        handlers.onDispose();
        // Closed with what was chosen or typed in it not saved: the file shows in an editor, not to be forgotten.
        if (!this.closing) void this.showIfUnsaved(viewColumn);
      },
      undefined,
      this.disposables,
    );
  }

  get active(): boolean {
    return this.panel.active;
  }

  get currentModel(): MergeModel | undefined {
    return this.model;
  }

  get inputKey(): string | undefined {
    return this.modelInputKey;
  }

  reveal(): void {
    this.panel.reveal();
  }

  /** Closes the page, as a command does: the file is not shown in its place. */
  close(): void {
    this.closing = true;
    this.panel.dispose();
  }

  private async showIfUnsaved(viewColumn: vscode.ViewColumn | undefined): Promise<void> {
    const document = vscode.workspace.textDocuments.find((each) => samePath(each.uri.fsPath, fileUri(this.descriptor).fsPath));
    if (document?.isDirty) await vscode.window.showTextDocument(document, { viewColumn, preview: false });
  }

  navigate(direction: 'next' | 'prev'): void {
    this.post({ type: 'navigate', direction });
  }

  setModel(model: MergeModel, inputKey: string): void {
    this.model = model;
    this.modelInputKey = inputKey;
    if (!this.webviewReady) return;
    if (this.initSent) this.post({ type: 'update', model });
    else void this.sendInit();
  }

  async refreshTheme(): Promise<void> {
    if (this.initSent) this.post({ type: 'theme', syntaxTheme: await this.themes.resolveActive() });
  }

  refreshEditorConfig(): void {
    if (this.initSent) this.post({ type: 'editorConfig', options: this.readEditorOptions() });
  }

  /** The user's `editor.*` configuration for this file, as plain JSON, as the Flow Diff reads it. */
  private readEditorOptions(): Record<string, unknown> {
    const uri = fileUri(this.descriptor);
    const scope: vscode.ConfigurationScope = this.model ? { uri, languageId: this.model.languageId } : uri;
    return JSON.parse(JSON.stringify(vscode.workspace.getConfiguration('editor', scope))) as Record<string, unknown>;
  }

  private async sendInit(): Promise<void> {
    if (this.initSent || !this.model) return;
    this.initSent = true;
    this.post({ type: 'init', model: this.model, settings: { editorOptions: this.readEditorOptions() }, syntaxTheme: await this.themes.resolveActive() });
  }

  private onMessage(message: MergeWebviewMessage): void {
    // What changes the file runs in the order it was sent: an edit before a save, a save before the staging.
    if (message.type === 'edit' || message.type === 'saveFile' || message.type === 'markResolved') {
      this.queue = this.queue.then(() => this.run(message)).catch(() => {});
      return;
    }
    switch (message.type) {
      case 'ready':
        this.webviewReady = true;
        void this.sendInit();
        break;
      case 'openAt': {
        const line = Math.max(0, message.line - 1);
        void vscode.window.showTextDocument(fileUri(this.descriptor), { selection: new vscode.Range(line, 0, line, 0), preview: false });
        break;
      }
    }
  }

  private async run(message: Extract<MergeWebviewMessage, { type: 'edit' | 'saveFile' | 'markResolved' }>): Promise<void> {
    switch (message.type) {
      case 'edit':
        return this.applyWebviewEdit(message.text);
      case 'saveFile':
        await (await vscode.workspace.openTextDocument(fileUri(this.descriptor))).save();
        return;
      case 'markResolved':
        return this.handlers.markResolved();
    }
  }

  /**
   * What was typed or chosen in the result, put in the file and left unsaved, as the Flow Diff does: only the stretch
   * that changed is replaced, so the undo history and the cursors of the editors of the file stay as they are.
   */
  private async applyWebviewEdit(text: string): Promise<void> {
    const uri = fileUri(this.descriptor);
    const document = await vscode.workspace.openTextDocument(uri);
    // The page works in LF: lines and columns are the same whatever the line endings of the file.
    const current = normalizeEol(document.getText());
    const change = minimalReplace(current, text);
    if (!change) return;
    const [start, end] = [offsetToPosition(current, change.start), offsetToPosition(current, change.end)];
    const replacement = document.eol === vscode.EndOfLine.CRLF ? change.text.replace(/\n/g, '\r\n') : change.text;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(start.line, start.character, end.line, end.character), replacement);
    await vscode.workspace.applyEdit(edit);
  }

  private post(message: MergeHostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private renderHtml(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...DIST, name));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    // As the Flow Diff: the module loads its chunks and Monaco's worker from the extension, the worker through a blob.
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; worker-src blob:; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('merge.css')}">
</head>
<body data-view="flowMerge">
  <div id="app" data-worker="${asset('editor.worker.js')}"></div>
  <script type="module" nonce="${nonce}" src="${asset('merge.js')}"></script>
</body>
</html>`;
  }
}

/**
 * The model of a file in conflict, or nothing when it is not one with both of its sides, or cannot be shown (binary,
 * declined as too large, too complex), or with `unlessInputKey` when what it is made from did not change.
 */
async function buildMerge(
  engine: DiffEngine,
  descriptor: MergeDescriptor,
  interactive: boolean,
  unlessInputKey?: string,
): Promise<{ model: MergeModel; inputKey: string } | undefined> {
  const tell = (message: string) => interactive && void vscode.window.showInformationMessage(`Flow Merge: ${message}`);
  const repo = new Repo(descriptor.repoRoot);
  const stages = await repo.conflictStages(descriptor.path).catch(() => [] as number[]);
  if (!stages.includes(2) || !stages.includes(3)) {
    tell(`${descriptor.path} is not in conflict with a change on each side.`);
    return undefined;
  }
  // Both sides added the file: there is no base, which is the same as an empty one.
  const stage = (number: number) => (stages.includes(number) ? repo.show(`:${number}`, descriptor.path).catch(() => '') : Promise.resolve(''));
  const document = await Promise.resolve(vscode.workspace.openTextDocument(fileUri(descriptor))).catch(() => undefined);
  const [base, ours, theirs, operation] = await Promise.all([stage(1), stage(2), stage(3), repo.operation().catch(() => null)]);
  const result = document?.getText() ?? '';
  const languageId = document?.languageId ?? 'plaintext';

  const hash = createHash('sha1');
  for (const part of [base, ours, theirs, result, languageId, operation ?? '']) hash.update(part).update('\0\0');
  const inputKey = hash.digest('hex');
  if (inputKey === unlessInputKey) return undefined;

  if ([base, ours, theirs, result].some((text) => text.includes('\0'))) {
    tell('this file looks binary.');
    return undefined;
  }
  const lines = [base, ours, theirs, result].reduce((sum, text) => sum + text.split('\n').length, 0);
  if (interactive && lines > LARGE_FILE_LINES) {
    const choice = await vscode.window.showWarningMessage('Flow Merge: this file is very large and the merge may be slow to show. Continue?', { modal: true }, 'Continue');
    if (choice !== 'Continue') return undefined;
  }

  const [current, incoming] = CONFLICT_SIDES[operation ?? 'none'];
  const outcome = await engine.runMerge({
    base,
    ours,
    theirs,
    result,
    languageId,
    filePath: descriptor.path,
    oursLabel: `Current — ${current}`,
    theirsLabel: `Incoming — ${incoming}`,
    resultLabel: 'Result',
    timeoutMs: DIFF_TIMEOUT_MS,
  });
  if (!outcome.ok) {
    tell(outcome.tooComplex ? 'this file has too many differences to display.' : `could not compute the merge — ${outcome.message}`);
    return undefined;
  }
  return { model: { ...outcome.model, proposals: proposalsOf(outcome.model, descriptor) }, inputKey };
}

/**
 * What the rules, when they are switched on, and the language model, when it was asked, propose for the conflicts
 * still marked in the result, each with the region it is of.
 */
function proposalsOf(model: MergeModel, descriptor: MergeDescriptor): MergeProposal[] {
  const rules = vscode.workspace.getConfiguration('gitardo').get<boolean>('conflicts.autoResolve') === true;
  const { conflicts } = resolveConflicts(model.result, model.base, { ours: model.ours, theirs: model.theirs });
  return conflicts.flatMap((conflict) => {
    const answer = answers.get(descriptor.repoRoot, descriptor.path, fingerprint(model.result, conflict));
    const proposal = (rules ? rulesProposal(conflict) : null) ?? (answer ? answerProposal(model.result, conflict, answer) : null);
    const region = model.regions.find((each) => {
      const [from, to] = bounds(each.result);
      return each.unresolved && from <= conflict.from && conflict.from < Math.max(to, from + 1);
    });
    return proposal && region ? [{ region: region.id, proposal }] : [];
  });
}
