import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BlameLine } from '../git/parse';
import type { BlameSource } from './blame';

/** How long a file is left alone after it changes before it is blamed again. */
const DELAY = 400;
/** The letters of the name of an author that are shown. */
const AUTHOR = 18;
/** True while the file of the active editor shows its blame: what the buttons of the editor go by. */
const CONTEXT = 'gitar.fileBlame';
const SPACE = ' ';

/** What a line that was typed is taken to be until git is asked again. */
const UNCOMMITTED: BlameLine = { hash: '0'.repeat(40), author: '', date: 0, summary: '', committed: false };

const two = (value: number) => String(value).padStart(2, '0');

/** The day of a commit, as wide whatever the day. */
function day(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** What stands beside a line: when it was last changed and by whom. */
function label(line: BlameLine | undefined): string {
  if (!line) return SPACE;
  if (!line.committed) return `Not${SPACE}committed${SPACE}yet`;
  const author = line.author.length > AUTHOR ? `${line.author.slice(0, AUTHOR - 1)}…` : line.author;
  return `${day(line.date)}${SPACE}${author.replace(/ /g, SPACE)}`;
}

function hover(line: BlameLine): vscode.MarkdownString {
  const text = new vscode.MarkdownString();
  text.isTrusted = { enabledCommands: ['gitar.revealCommit', 'gitar.openCommit'] };
  const link = (command: string) => `command:${command}?${encodeURIComponent(JSON.stringify([line.hash]))}`;
  text.appendText(`${line.author}, ${new Date(line.date * 1000).toLocaleString()}\n\n${line.summary}`);
  text.appendMarkdown(
    `\n\n[Show ${line.hash.slice(0, 7)} in the Gitar graph](${link('gitar.revealCommit')}) · [Open it in an editor tab](${link('gitar.openCommit')})`,
  );
  return text;
}

interface Shown {
  /** Who last changed each line, the first one at 0. */
  lines: (BlameLine | undefined)[];
  /** Bumped each time git is asked, so that an answer that comes after a later one is dropped. */
  request: number;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Shows beside every line of a file when it was last changed and by whom. It is switched on and off file by file,
 * and a file keeps it until it is closed.
 */
export class FileBlame implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    before: {
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'normal',
      fontWeight: 'normal',
      margin: '0 1.5ch 0 0',
      // What a decoration has no name for is said after the one thing it lets through as it is written.
      textDecoration: 'none; white-space: pre; overflow: hidden; text-overflow: ellipsis; vertical-align: top; padding: 0 1ch',
    },
  });
  /** Where the other lines of the commit of the line under the cursor are, in the scroll bar of a file longer than its editor. */
  private readonly marks = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: new vscode.ThemeColor('gitar.blameHighlightForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  private readonly subscriptions: vscode.Disposable[];
  /** The files that show their blame, by the URI of their document. */
  private readonly shown = new Map<string, Shown>();
  /** The commit each editor has highlighted the lines of: the one of the line its cursor is on. */
  private readonly highlighted = new WeakMap<vscode.TextEditor, string | undefined>();

  constructor(private readonly source: BlameSource) {
    this.subscriptions = [
      this.decoration,
      this.marks,
      vscode.window.onDidChangeVisibleTextEditors(() => this.render()),
      vscode.window.onDidChangeTextEditorSelection((event) => this.moved(event.textEditor)),
      vscode.window.onDidChangeActiveTextEditor(() => this.tell()),
      vscode.workspace.onDidChangeTextDocument((event) => this.edited(event)),
      vscode.workspace.onDidSaveTextDocument((document) => this.schedule(document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.hide(document.uri)),
    ];
    this.tell();
  }

  dispose(): void {
    for (const shown of this.shown.values()) clearTimeout(shown.timer);
    this.shown.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  /** The blame a file is showing, or nothing for one that is not: what the tests read. */
  linesOf(uri: vscode.Uri): (BlameLine | undefined)[] | undefined {
    return this.shown.get(uri.toString())?.lines;
  }

  /** Shows the blame of a file, the one of the active editor unless another is named, or hides it when it is shown. */
  async toggle(uri?: vscode.Uri): Promise<void> {
    const document = uri
      ? vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString())
      : vscode.window.activeTextEditor?.document;
    if (!document || document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Gitar: open a file of a repository to see who changed its lines.');
      return;
    }
    const key = document.uri.toString();
    if (this.shown.has(key)) return this.hide(document.uri);

    const lines = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Gitar: reading the blame…' }, () =>
      this.read(document),
    );
    if (!lines) {
      void vscode.window.showInformationMessage(
        `Gitar: ${path.basename(document.uri.fsPath)} is not in any commit yet, so there is no one to name beside its lines.`,
      );
      return;
    }
    this.shown.set(key, { lines, request: 0 });
    this.render();
    this.tell();
  }

  /** Asks git again for the files that show their blame: the commits may have changed under them. */
  refresh(): void {
    for (const document of vscode.workspace.textDocuments) this.schedule(document);
  }

  private hide(uri: vscode.Uri): void {
    const shown = this.shown.get(uri.toString());
    if (!shown) return;
    clearTimeout(shown.timer);
    this.shown.delete(uri.toString());
    this.render();
    this.tell();
  }

  private async read(document: vscode.TextDocument): Promise<BlameLine[] | null> {
    const found = await this.source.of(document);
    if (!found) return null;
    return found.repo.blame(found.file, document.isDirty ? document.getText() : undefined);
  }

  /**
   * The lines that were typed are not committed, which is told at once so that every line keeps something beside
   * it and the text does not jump; git is asked a moment later, since typing a line back makes it committed again.
   */
  private edited(event: vscode.TextDocumentChangeEvent): void {
    const shown = this.shown.get(event.document.uri.toString());
    if (!shown || !event.contentChanges.length) return;
    for (const change of event.contentChanges) {
      const written = change.text.split('\n').length;
      shown.lines.splice(change.range.start.line, change.range.end.line - change.range.start.line + 1, ...Array<BlameLine>(written).fill(UNCOMMITTED));
    }
    this.render();
    this.schedule(event.document);
  }

  private schedule(document: vscode.TextDocument): void {
    const shown = this.shown.get(document.uri.toString());
    if (!shown) return;
    clearTimeout(shown.timer);
    shown.timer = setTimeout(async () => {
      const request = ++shown.request;
      const lines = await this.read(document).catch(() => null);
      // Hidden in the meantime, asked again in the meantime, or no longer a file git knows: what is shown stays.
      if (!lines || this.shown.get(document.uri.toString()) !== shown || request !== shown.request) return;
      shown.lines = lines;
      this.render();
    }, DELAY);
  }

  /** Tells VS Code whether the file of the active editor shows its blame, for the button that fits to be offered. */
  private tell(): void {
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    void vscode.commands.executeCommand('setContext', CONTEXT, active !== undefined && this.shown.has(active));
  }

  /** The commit of the line the cursor of an editor is on, if its file shows its blame. */
  private under(editor: vscode.TextEditor): string | undefined {
    return this.shown.get(editor.document.uri.toString())?.lines[editor.selection.active.line]?.hash;
  }

  /** The cursor is on a line of another commit: the lines that stand out are others. */
  private moved(editor: vscode.TextEditor): void {
    if (this.under(editor) !== this.highlighted.get(editor)) this.render(editor);
  }

  private render(only?: vscode.TextEditor): void {
    for (const editor of only ? [only] : vscode.window.visibleTextEditors) {
      const shown = this.shown.get(editor.document.uri.toString());
      const commit = this.under(editor);
      this.highlighted.set(editor, commit);
      if (!shown) {
        editor.setDecorations(this.decoration, []);
        editor.setDecorations(this.marks, []);
        continue;
      }
      const hovers = new Map<BlameLine, vscode.MarkdownString>();
      const options: vscode.DecorationOptions[] = [];
      const marks: vscode.Range[] = [];
      // Every line has something before it, if only room, for the text to stay in one column: as wide as the longest.
      const labels = Array.from({ length: editor.document.lineCount }, (_, index) => label(shown.lines[index]));
      const width = `${labels.reduce((longest, text) => Math.max(longest, text.length), 0)}ch`;
      // What the line under the cursor has beside it stands out, as it does beside the other lines of its commit.
      const plain = { width };
      const lit = {
        width,
        color: new vscode.ThemeColor('gitar.blameHighlightForeground'),
        backgroundColor: new vscode.ThemeColor('gitar.blameHighlightBackground'),
      };
      for (const [index, contentText] of labels.entries()) {
        const line = shown.lines[index];
        let hoverMessage: vscode.MarkdownString | undefined;
        if (line?.committed) {
          hoverMessage = hovers.get(line);
          if (!hoverMessage) hovers.set(line, (hoverMessage = hover(line)));
        }
        const stands = line !== undefined && line.hash === commit;
        options.push({
          range: new vscode.Range(index, 0, index, 0),
          hoverMessage,
          renderOptions: { before: { contentText, ...(stands ? lit : plain) } },
        });
        if (!stands) continue;
        // One mark for the lines that follow each other.
        const last = marks.at(-1);
        if (last?.end.line === index - 1) marks[marks.length - 1] = new vscode.Range(last.start.line, 0, index, 0);
        else marks.push(new vscode.Range(index, 0, index, 0));
      }
      editor.setDecorations(this.decoration, options);
      editor.setDecorations(this.marks, marks);
    }
  }
}
