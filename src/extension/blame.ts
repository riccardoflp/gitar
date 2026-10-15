import * as path from 'node:path';
import * as vscode from 'vscode';
import { Repo, type BlameOptions } from '../git/repo';
import { ago } from '../shared/blameFormat';
import { revisionOf } from './content';

const DELAY = 200;

/** Where a document is in a repository: the name the file has there, and the commit it is shown as it was in, if any. */
export interface Blamable {
  repo: Repo;
  file: string;
  revision?: string;
}

/** Whether a line is left to who wrote it when only its whitespace or its place in the file changed since. */
export const ignoresWhitespace = () => vscode.workspace.getConfiguration('gitardo').get<boolean>('blame.ignoreWhitespaceAndMoves') === true;

/** Finds the repository a file of the editor is in. It works before any Gitardo view is opened. */
export class BlameSource {
  /** The repository of each folder a file was opened from, found once. */
  private readonly found = new Map<string, Promise<Repo | undefined>>();
  private readonly repos = new Map<string, Repo>();

  constructor(private readonly log: vscode.LogOutputChannel) {}

  private repo(root: string): Repo {
    let repo = this.repos.get(root);
    if (!repo) this.repos.set(root, (repo = new Repo(root, (command) => this.log.debug(command))));
    return repo;
  }

  private repoOf(folder: string): Promise<Repo | undefined> {
    let repo = this.found.get(folder);
    if (!repo) {
      repo = Repo.discover(folder).then(
        (root) => (root ? this.repo(root) : undefined),
        () => undefined,
      );
      this.found.set(folder, repo);
    }
    return repo;
  }

  /** The repository of a document, when it is a file on disk inside one or a file as it was in a commit. */
  async of(document: vscode.TextDocument): Promise<Blamable | undefined> {
    const past = revisionOf(document.uri);
    if (past) return { repo: this.repo(past.root), file: past.file, revision: past.revision };
    if (document.uri.scheme !== 'file') return undefined;
    const repo = await this.repoOf(path.dirname(document.uri.fsPath));
    if (!repo) return undefined;
    const file = path.relative(repo.root, document.uri.fsPath).replace(/\\/g, '/');
    return file.startsWith('..') || path.isAbsolute(file) ? undefined : { repo, file };
  }

  /** What git is told to blame a document: the text of the editor when it is not saved, and what the settings ask. */
  options(document: vscode.TextDocument, found: Blamable): BlameOptions {
    return {
      contents: !found.revision && document.isDirty ? document.getText() : undefined,
      revision: found.revision,
      ignoreWhitespace: ignoresWhitespace(),
    };
  }
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

  constructor(private readonly source: BlameSource) {
    const schedule = () => this.schedule();
    this.subscriptions = [
      this.decoration,
      vscode.window.onDidChangeActiveTextEditor(schedule),
      vscode.window.onDidChangeTextEditorSelection(schedule),
      vscode.workspace.onDidChangeConfiguration((event) => event.affectsConfiguration('gitardo.blame') && schedule()),
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

  private async update(): Promise<void> {
    const request = ++this.request;
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const clear = () => editor.setDecorations(this.decoration, []);

    const enabled = vscode.workspace.getConfiguration('gitardo').get<boolean>('blame.enabled');
    const { document, selection } = editor;
    if (!enabled || document.uri.scheme !== 'file' || !selection.isSingleLine) return clear();

    const found = await this.source.of(document);
    if (request !== this.request) return;
    if (!found) return clear();

    const line = selection.active.line;
    const blame = await found.repo.blameLine(found.file, line + 1, this.source.options(document, found)).catch(() => null);
    if (request !== this.request) return;
    if (!blame) return clear();

    const text = blame.committed ? `${blame.author}, ${ago(blame.date)} • ${blame.summary}` : 'Not committed yet';
    const hover = new vscode.MarkdownString();
    if (blame.committed) {
      hover.isTrusted = { enabledCommands: ['gitardo.revealCommit'] };
      const link = `command:gitardo.revealCommit?${encodeURIComponent(JSON.stringify([blame.hash]))}`;
      hover.appendText(`${blame.author}, ${new Date(blame.date * 1000).toLocaleString()}\n\n${blame.summary}`);
      hover.appendMarkdown(`\n\n[Show ${blame.hash.slice(0, 7)} in the Gitardo graph](${link})`);
    }
    const end = document.lineAt(line).range.end;
    editor.setDecorations(this.decoration, [
      { range: new vscode.Range(end, end), hoverMessage: blame.committed ? hover : undefined, renderOptions: { after: { contentText: text } } },
    ]);
  }
}
