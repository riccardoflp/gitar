import * as path from 'node:path';
import * as vscode from 'vscode';
import { Repo } from '../git/repo';

const DELAY = 200;

function ago(seconds: number): string {
  const elapsed = Math.max(0, Date.now() / 1000 - seconds);
  const units: [number, string][] = [
    [31536000, 'year'],
    [2592000, 'month'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    const count = Math.floor(elapsed / size);
    if (count >= 1) return `${count} ${name}${count === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

/** Shows who last changed the line under the cursor, dimmed at the end of that line. */
export class BlameAnnotator implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 3em' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  private readonly subscriptions: vscode.Disposable[];
  private timer?: ReturnType<typeof setTimeout>;
  /** Bumped on every request, so that a slow answer for a line the cursor already left is dropped. */
  private request = 0;
  /** The repository of each folder a file was opened from, found once. It works before any Gitar view is opened. */
  private readonly repos = new Map<string, Promise<Repo | undefined>>();

  constructor(private readonly log: vscode.LogOutputChannel) {
    const schedule = () => this.schedule();
    this.subscriptions = [
      this.decoration,
      vscode.window.onDidChangeActiveTextEditor(schedule),
      vscode.window.onDidChangeTextEditorSelection(schedule),
      vscode.workspace.onDidChangeConfiguration((event) => event.affectsConfiguration('gitar.blame') && schedule()),
    ];
    schedule();
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(), DELAY);
  }

  private repoOf(folder: string): Promise<Repo | undefined> {
    let repo = this.repos.get(folder);
    if (!repo) {
      repo = Repo.discover(folder).then(
        (root) => (root ? new Repo(root, (command) => this.log.debug(command)) : undefined),
        () => undefined,
      );
      this.repos.set(folder, repo);
    }
    return repo;
  }

  private async update(): Promise<void> {
    const request = ++this.request;
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const clear = () => editor.setDecorations(this.decoration, []);

    const enabled = vscode.workspace.getConfiguration('gitar').get<boolean>('blame.enabled');
    const { document, selection } = editor;
    if (!enabled || document.uri.scheme !== 'file' || !selection.isSingleLine) return clear();

    const repo = await this.repoOf(path.dirname(document.uri.fsPath));
    if (request !== this.request) return;
    if (!repo) return clear();
    const file = path.relative(repo.root, document.uri.fsPath).replace(/\\/g, '/');
    if (file.startsWith('..') || path.isAbsolute(file)) return clear();

    const line = selection.active.line;
    const blame = await repo.blameLine(file, line + 1, document.isDirty ? document.getText() : undefined).catch(() => null);
    if (request !== this.request) return;
    if (!blame) return clear();

    const text = blame.committed ? `${blame.author}, ${ago(blame.date)} • ${blame.summary}` : 'Not committed yet';
    const hover = new vscode.MarkdownString();
    if (blame.committed) {
      hover.isTrusted = { enabledCommands: ['gitar.revealCommit'] };
      const link = `command:gitar.revealCommit?${encodeURIComponent(JSON.stringify([blame.hash]))}`;
      hover.appendText(`${blame.author}, ${new Date(blame.date * 1000).toLocaleString()}\n\n${blame.summary}`);
      hover.appendMarkdown(`\n\n[Show ${blame.hash.slice(0, 7)} in the Gitar graph](${link})`);
    }
    const end = document.lineAt(line).range.end;
    editor.setDecorations(this.decoration, [
      { range: new vscode.Range(end, end), hoverMessage: blame.committed ? hover : undefined, renderOptions: { after: { contentText: text } } },
    ]);
  }
}
