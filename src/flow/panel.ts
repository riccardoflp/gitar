import * as vscode from 'vscode';
import { normalizeEol } from './diff/hunks';
import type { AlignedDiffModel } from './diff/model';
import type { HostMessage, WebviewMessage } from './diff/protocol';
import { minimalReplace, offsetToPosition } from './diff/textEdit';
import { type DiffDescriptor, canStage, diffKey, fileUri, rightSide, title } from './sides';
import type { ThemeService } from './theme';

export type ChunkActionMessage = Extract<WebviewMessage, { type: 'revertChunk' | 'stageChunk' | 'unstageChunk' }>;

/** What chunk actions and refreshes need from a diff view. */
export interface DiffHost {
  readonly descriptor: DiffDescriptor;
  readonly currentModel: AlignedDiffModel | undefined;
  readonly inputKey: string | undefined;
  setModel(model: AlignedDiffModel, inputKey: string): void;
}

/** What a panel delegates to the rest of the extension. */
export interface PanelHandlers {
  chunkAction(panel: DiffPanel, message: ChunkActionMessage): void;
  navigateFile(panel: DiffPanel, direction: 'next' | 'prev'): void;
}

/** Where the bundled webview is, under the folder of the extension. */
const DIST = ['dist', 'flow'];

export class DiffPanel implements DiffHost {
  static readonly viewType = 'gitardo.flowDiff';

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private model: AlignedDiffModel | undefined;
  private modelInputKey: string | undefined;
  private webviewReady = false;
  private initSent = false;

  constructor(
    extensionUri: vscode.Uri,
    readonly descriptor: DiffDescriptor,
    private readonly themes: ThemeService,
    private readonly handlers: PanelHandlers,
    onDispose: () => void,
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active,
  ) {
    this.panel = vscode.window.createWebviewPanel(DiffPanel.viewType, title(descriptor), viewColumn, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, ...DIST)],
    });
    this.panel.webview.html = this.renderHtml(extensionUri);
    this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => this.onMessage(message), undefined, this.disposables);
    this.panel.onDidDispose(
      () => {
        this.disposables.forEach((d) => d.dispose());
        onDispose();
      },
      undefined,
      this.disposables,
    );
    // Drives the editor/title button when-clauses (stage vs unstage actions).
    this.panel.onDidChangeViewState(
      (event) => {
        if (event.webviewPanel.active) {
          this.setSideContext();
        }
      },
      undefined,
      this.disposables,
    );
    this.setSideContext();
  }

  get active(): boolean {
    return this.panel.active;
  }

  get viewColumn(): vscode.ViewColumn | undefined {
    return this.panel.viewColumn;
  }

  get currentModel(): AlignedDiffModel | undefined {
    return this.model;
  }

  /** Hash of the inputs `currentModel` was built from (refresh skips when unchanged). */
  get inputKey(): string | undefined {
    return this.modelInputKey;
  }

  /**
   * Drives the editor/title when-clauses: 'worktree' (the index takes part: stage and
   * discard), 'worktreeVsRef' (vs a commit: no git file actions),
   * 'index' (unstage) or 'ref' (read-only).
   */
  private setSideContext(): void {
    const side = rightSide(this.descriptor);
    const value = side === 'worktree' && !canStage(this.descriptor) ? 'worktreeVsRef' : side;
    void vscode.commands.executeCommand('setContext', 'gitardo.flowDiffSide', value);
  }

  reveal(): void {
    this.panel.reveal();
  }

  close(): void {
    this.panel.dispose();
  }

  setModel(model: AlignedDiffModel, inputKey: string): void {
    this.model = model;
    this.modelInputKey = inputKey;
    if (!this.webviewReady) {
      return;
    }
    if (this.initSent) {
      this.post({ type: 'update', model });
    } else {
      void this.sendInit();
    }
  }

  /** Pushes a theme change to an already-initialized webview. */
  async refreshTheme(): Promise<void> {
    if (this.initSent) {
      this.post({ type: 'theme', syntaxTheme: await this.themes.resolveActive() });
    }
  }

  /** Pushes `editor.*` setting changes into the live Monaco panes. */
  refreshEditorConfig(): void {
    if (this.initSent) {
      this.post({ type: 'editorConfig', options: this.readEditorOptions() });
    }
  }

  /**
   * The user's `editor.*` configuration (with language-specific overrides for
   * this file) as plain JSON. JSON round-trip strips the proxy's methods and
   * leaves only setting values, which map 1:1 onto Monaco options.
   */
  private readEditorOptions(): Record<string, unknown> {
    const uri = fileUri(this.descriptor);
    const scope: vscode.ConfigurationScope = this.model ? { uri, languageId: this.model.languageId } : uri;
    return JSON.parse(JSON.stringify(vscode.workspace.getConfiguration('editor', scope))) as Record<string, unknown>;
  }

  navigate(direction: 'next' | 'prev'): void {
    this.post({ type: 'navigate', direction });
  }

  private async sendInit(): Promise<void> {
    if (this.initSent || !this.model) {
      return;
    }
    this.initSent = true;
    this.post({
      type: 'init',
      model: this.model,
      settings: {
        editorOptions: this.readEditorOptions(),
        rightSide: rightSide(this.descriptor),
        canStage: canStage(this.descriptor),
        collapseUnchanged: vscode.workspace.getConfiguration('gitardo').get<boolean>('flowDiff.collapseUnchanged', true),
        // the changed-files list only exists between HEAD, the index and the working tree
        fileNavigation: canStage(this.descriptor),
      },
      syntaxTheme: await this.themes.resolveActive(),
    });
  }

  private onMessage(message: WebviewMessage): void {
    switch (message.type) {
      case 'ready':
        this.webviewReady = true;
        void this.sendInit();
        break;
      case 'openAt': {
        const line = Math.max(0, message.line - 1);
        void vscode.window.showTextDocument(fileUri(this.descriptor), {
          selection: new vscode.Range(line, 0, line, 0),
          preview: false,
        });
        break;
      }
      case 'navigateFile':
        this.handlers.navigateFile(this, message.direction);
        break;
      case 'currentChunkChanged':
        // Reserved: could mirror "n of m" into the panel title.
        break;
      case 'revertChunk':
      case 'stageChunk':
      case 'unstageChunk':
        this.handlers.chunkAction(this, message);
        break;
      case 'edit':
        void this.applyWebviewEdit(message.text);
        break;
      case 'saveFile':
        void vscode.workspace.openTextDocument(fileUri(this.descriptor)).then((document) => document.save());
        break;
    }
  }

  /** In-place edit from the Monaco pane: sync into the real document (kept dirty). */
  private async applyWebviewEdit(text: string): Promise<void> {
    if (this.descriptor.right.kind !== 'worktree') {
      return;
    }
    const uri = fileUri(this.descriptor);
    const document = await vscode.workspace.openTextDocument(uri);
    // diff in LF space (what the webview works in): line/column positions
    // are the same whatever the document's EOL
    const current = normalizeEol(document.getText());
    const change = minimalReplace(current, text);
    if (!change) {
      return;
    }
    // replace only the changed span, so the document's undo history, other
    // editors' cursors and folding outside it stay untouched
    const start = offsetToPosition(current, change.start);
    const end = offsetToPosition(current, change.end);
    const replacement = document.eol === vscode.EndOfLine.CRLF ? change.text.replace(/\n/g, '\r\n') : change.text;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(start.line, start.character, end.line, end.character), replacement);
    await vscode.workspace.applyEdit(edit);
  }

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private renderHtml(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...DIST, name));
    const nonce = makeNonce();
    // script-src includes cspSource so the module entry can import() its
    // esbuild-split chunks (lazy shiki grammars/themes) and so Monaco's blob
    // worker can importScripts() its bundled code; worker-src allows the blob.
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; worker-src blob:; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('main.css')}">
</head>
<body data-view="flowDiff">
  <div id="app" data-worker="${asset('editor.worker.js')}"></div>
  <script type="module" nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/** Dedupes panels per diff: opening it again reveals instead of stacking. */
export class PanelRegistry implements vscode.Disposable {
  private readonly panels = new Map<string, DiffPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly themes: ThemeService,
    private readonly handlers: PanelHandlers,
  ) {}

  get(descriptor: DiffDescriptor): DiffPanel | undefined {
    return this.panels.get(diffKey(descriptor));
  }

  create(descriptor: DiffDescriptor, viewColumn?: vscode.ViewColumn): DiffPanel {
    const key = diffKey(descriptor);
    const panel = new DiffPanel(this.extensionUri, descriptor, this.themes, this.handlers, () => this.panels.delete(key), viewColumn);
    this.panels.set(key, panel);
    return panel;
  }

  getActive(): DiffPanel | undefined {
    for (const panel of this.panels.values()) {
      if (panel.active) {
        return panel;
      }
    }
    return undefined;
  }

  all(): DiffPanel[] {
    return [...this.panels.values()];
  }

  dispose(): void {
    for (const panel of this.all()) panel.close();
    this.panels.clear();
  }
}
