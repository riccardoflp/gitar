import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BlameLine } from '../git/parse';
import type { Repo } from '../git/repo';
import { DEFAULT_AGE, DEFAULT_FORMAT, ageColor, blameLabels, parseFormat, type AgeColors, type FormatPart } from '../shared/blameFormat';
import { ignoresWhitespace, type Blamable, type BlameSource } from './blame';
import { revisionUri } from './content';

/** How long a file is left alone after it changes before it is blamed again. */
const DELAY = 400;
/** True while the file of the active editor shows its blame: what the buttons of the editor go by. */
const CONTEXT = 'gitardo.fileBlame';
/** A space that is not taken for a place to fold the line at, nor run together with the next one. */
const SPACE = String.fromCharCode(0xa0);
/** What a decoration has no name for is said after the one thing it lets through as it is written. */
const STYLE = 'none; white-space: pre; overflow: hidden; text-overflow: ellipsis; vertical-align: top; padding: 0 1ch';
/** The line at the left of what stands beside a line, in the color of its age. */
const BAR = '3px';

/** What a line that was typed is taken to be until git is asked again. */
const UNCOMMITTED: BlameLine = { hash: '0'.repeat(40), author: '', date: 0, summary: '', committed: false };

interface Settings {
  format: FormatPart[];
  group: boolean;
  /** Null when the age of the lines is not to be told by a color. */
  age: AgeColors | null;
  everyFile: boolean;
  ignoreWhitespace: boolean;
}

function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration('gitardo');
  const text = (name: string, fallback: string) => {
    const value = config.get<unknown>(name);
    return typeof value === 'string' && value.trim() ? value : fallback;
  };
  const days = config.get<unknown>('fileBlame.age.oldAfterDays');
  return {
    format: parseFormat(text('fileBlame.format', DEFAULT_FORMAT)),
    group: config.get<boolean>('fileBlame.groupLines') !== false,
    age:
      config.get<boolean>('fileBlame.age.enabled') === false
        ? null
        : {
            recent: text('fileBlame.age.recentColor', DEFAULT_AGE.recent),
            old: text('fileBlame.age.oldColor', DEFAULT_AGE.old),
            days: typeof days === 'number' && days >= 1 ? days : DEFAULT_AGE.days,
          },
    everyFile: config.get<boolean>('fileBlame.everyFile') === true,
    ignoreWhitespace: ignoresWhitespace(),
  };
}

/** What the rest of the extension does with a commit that the blame names. */
export interface BlameActions {
  /** Opens a commit of a repository in an editor tab. */
  open(hash: string, repo: Repo): unknown;
  /** Shows a commit in the graph. */
  reveal(hash: string): unknown;
}

function hover(line: BlameLine, root: string): vscode.MarkdownString {
  const text = new vscode.MarkdownString();
  text.isTrusted = { enabledCommands: ['gitardo.revealCommit', 'gitardo.openCommit', 'gitardo.blamePrevious'] };
  const link = (command: string, ...args: unknown[]) => `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
  text.appendText(`${line.author}, ${new Date(line.date * 1000).toLocaleString()}\n\n${line.summary}`);
  const links = [
    `[Show ${line.hash.slice(0, 7)} in the Gitardo graph](${link('gitardo.revealCommit', line.hash)})`,
    `[Open it in an editor tab](${link('gitardo.openCommit', line.hash)})`,
  ];
  // A commit that added the file has nothing before it.
  if (line.previous) links.push(`[Blame the file as it was before](${link('gitardo.blamePrevious', root, line.previous.hash, line.previous.file)})`);
  text.appendMarkdown(`\n\n${links.join(' · ')}`);
  return text;
}

interface Shown {
  /** Who last changed each line, the first one at 0. */
  lines: (BlameLine | undefined)[];
  /** The repository the file is in. */
  root: string;
  /** Bumped each time git is asked, so that an answer that comes after a later one is dropped. */
  request: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Shown because every file is, rather than because it was asked for this one. */
  auto: boolean;
}

/**
 * Shows beside every line of a file when it was last changed and by whom. It is switched on and off file by file,
 * and a file keeps it until it is closed; or it is switched on for every file, and off for the ones it is not wanted in.
 */
export class FileBlame implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    before: {
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'normal',
      fontWeight: 'normal',
      margin: '0 1.5ch 0 0',
      textDecoration: STYLE,
    },
  });
  /** Where the other lines of the commit of the line under the cursor are, in the scroll bar of a file longer than its editor. */
  private readonly marks = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: new vscode.ThemeColor('gitardo.blameHighlightForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  private readonly subscriptions: vscode.Disposable[];
  private settings = readSettings();
  /** The files that show their blame, by the URI of their document. */
  private readonly shown = new Map<string, Shown>();
  /** The files that were told not to show it while every file does. */
  private readonly hidden = new Set<string>();
  /** The files git has no blame for, which are not asked of it again each time they come in sight. */
  private readonly none = new Set<string>();
  private readonly loading = new Set<string>();
  /** The commit each editor has highlighted the lines of: the one of the line its cursor is on. */
  private readonly highlighted = new WeakMap<vscode.TextEditor, string | undefined>();

  constructor(
    private readonly source: BlameSource,
    private readonly actions: BlameActions,
  ) {
    this.subscriptions = [
      this.decoration,
      this.marks,
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.render();
        this.follow();
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => this.moved(event.textEditor)),
      vscode.window.onDidChangeActiveTextEditor(() => this.tell()),
      vscode.workspace.onDidChangeTextDocument((event) => this.edited(event)),
      vscode.workspace.onDidSaveTextDocument((document) => this.schedule(document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.forget(document.uri)),
      vscode.workspace.onDidChangeConfiguration(
        (event) => (event.affectsConfiguration('gitardo.fileBlame') || event.affectsConfiguration('gitardo.blame')) && this.configured(),
      ),
    ];
    this.tell();
    this.follow();
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
    if (!document) {
      void vscode.window.showInformationMessage('Gitardo: open a file of a repository to see who changed its lines.');
      return;
    }
    const key = document.uri.toString();
    if (this.shown.has(key)) {
      this.hide(document.uri);
      // Or it would be back the next time the file comes in sight.
      if (this.settings.everyFile) this.hidden.add(key);
      return;
    }
    this.hidden.delete(key);
    if (await this.show(document)) return;
    void vscode.window.showInformationMessage(
      `Gitardo: ${path.basename(document.uri.fsPath)} is not in any commit yet, so there is no one to name beside its lines.`,
    );
  }

  /** Asks git again for the files that show their blame: the commits may have changed under them. */
  refresh(): void {
    for (const document of vscode.workspace.textDocuments) this.schedule(document);
    this.none.clear();
    this.follow();
  }

  /** Opens the commit that last changed the line under the cursor in an editor tab. */
  async openLine(): Promise<void> {
    const at = await this.underCursor();
    if (at) await this.actions.open(at.line.hash, at.found.repo);
  }

  /** Shows the commit that last changed the line under the cursor in the graph. */
  async revealLine(): Promise<void> {
    const at = await this.underCursor();
    if (at) await this.actions.reveal(at.line.hash);
  }

  /**
   * Opens a file as it was before a commit changed it, with its blame: who had written what the commit replaced. The
   * commit is the one named, as a link of the hover names it, or the one of the line under the cursor.
   */
  async previous(root?: unknown, hash?: unknown, file?: unknown): Promise<void> {
    if (typeof root !== 'string' || typeof hash !== 'string' || typeof file !== 'string') {
      const at = await this.underCursor();
      if (!at) return;
      if (!at.line.previous) {
        void vscode.window.showInformationMessage(
          `Gitardo: ${at.line.hash.slice(0, 7)} is the commit that added this file, so there is nothing before it to blame.`,
        );
        return;
      }
      [root, hash, file] = [at.found.repo.root, at.line.previous.hash, at.line.previous.file];
    }
    const from = vscode.window.activeTextEditor;
    let document = await vscode.workspace.openTextDocument(revisionUri(root as string, hash as string, file as string));
    // A name that says the commit may not say the language as the name of the file did.
    if (from && from.document.languageId !== document.languageId && document.languageId === 'plaintext') {
      document = await vscode.languages.setTextDocumentLanguage(document, from.document.languageId);
    }
    // About where the cursor was, which is where the line was if little was changed above it.
    const line = Math.min(from?.selection.active.line ?? 0, document.lineCount - 1);
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(line, 0, line, 0) });
    this.hidden.delete(document.uri.toString());
    await this.show(document);
  }

  /** The commit of the line the cursor is on in the active editor, or nothing, said why, when it has none. */
  private async underCursor(): Promise<{ line: BlameLine; found: Blamable } | undefined> {
    const editor = vscode.window.activeTextEditor;
    const found = editor && (await this.source.of(editor.document));
    if (!editor || !found) {
      void vscode.window.showInformationMessage('Gitardo: put the cursor on a line of a file of a repository.');
      return undefined;
    }
    const lines =
      this.shown.get(editor.document.uri.toString())?.lines ??
      (await found.repo.blame(found.file, this.source.options(editor.document, found)).catch(() => null));
    const line = lines?.[editor.selection.active.line];
    if (line?.committed) return { line, found };
    void vscode.window.showInformationMessage(line ? 'Gitardo: this line is not committed yet.' : 'Gitardo: this line is in no commit.');
    return undefined;
  }

  /** Reads the blame of a file and shows it. False for a file that has none. */
  private async show(document: vscode.TextDocument, auto = false): Promise<boolean> {
    const key = document.uri.toString();
    if (this.shown.has(key) || this.loading.has(key)) return true;
    this.loading.add(key);
    try {
      const read = auto
        ? await this.read(document)
        : await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Gitardo: reading the blame…' }, () => this.read(document));
      if (!read) {
        this.none.add(key);
        return false;
      }
      // Closed while git was answering, or no longer wanted.
      if (document.isClosed || (auto && (!this.settings.everyFile || this.hidden.has(key)))) return true;
      this.shown.set(key, { ...read, request: 0, auto });
    } finally {
      this.loading.delete(key);
    }
    this.render();
    this.tell();
    return true;
  }

  /** While every file shows its blame, the files that come in sight are given theirs. */
  private follow(): void {
    if (!this.settings.everyFile) return;
    for (const { document } of vscode.window.visibleTextEditors) {
      const key = document.uri.toString();
      if (document.uri.scheme === 'file' && !this.hidden.has(key) && !this.none.has(key)) void this.show(document, true);
    }
  }

  private configured(): void {
    const before = this.settings;
    this.settings = readSettings();
    if (before.ignoreWhitespace !== this.settings.ignoreWhitespace) {
      for (const document of vscode.workspace.textDocuments) this.schedule(document);
    }
    if (before.everyFile && !this.settings.everyFile) {
      // The files that were asked for one by one keep theirs.
      for (const [key, shown] of this.shown) {
        if (!shown.auto) continue;
        clearTimeout(shown.timer);
        this.shown.delete(key);
      }
      this.hidden.clear();
    }
    this.render();
    this.tell();
    this.follow();
  }

  private hide(uri: vscode.Uri): void {
    const shown = this.shown.get(uri.toString());
    if (!shown) return;
    clearTimeout(shown.timer);
    this.shown.delete(uri.toString());
    this.render();
    this.tell();
  }

  /** A file that is closed starts again from nothing when it is opened. */
  private forget(uri: vscode.Uri): void {
    this.hide(uri);
    this.hidden.delete(uri.toString());
    this.none.delete(uri.toString());
  }

  private async read(document: vscode.TextDocument): Promise<{ lines: BlameLine[]; root: string } | null> {
    const found = await this.source.of(document);
    const lines = found && (await found.repo.blame(found.file, this.source.options(document, found)));
    return lines ? { lines, root: found.repo.root } : null;
  }

  /**
   * The lines that were typed are not committed, which is told at once so that every line keeps something beside
   * it and the text does not jump; git is asked a moment later, since typing a line back makes it committed again.
   */
  private edited(event: vscode.TextDocumentChangeEvent): void {
    const shown = this.shown.get(event.document.uri.toString());
    if (!shown || !event.contentChanges.length) return;
    for (const { range, text } of event.contentChanges) {
      const written = text.split('\n').length;
      // Whole lines put in or taken out leave the line after them as it was; anything else changes the lines it touches.
      const whole = range.start.character === 0 && range.end.character === 0 && (text === '' || text.endsWith('\n'));
      const [taken, put] = whole ? [range.end.line - range.start.line, written - 1] : [range.end.line - range.start.line + 1, written];
      shown.lines.splice(range.start.line, taken, ...Array<BlameLine>(put).fill(UNCOMMITTED));
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
      const read = await this.read(document).catch(() => null);
      // Hidden in the meantime, asked again in the meantime, or no longer a file git knows: what is shown stays.
      if (!read || this.shown.get(document.uri.toString()) !== shown || request !== shown.request) return;
      shown.lines = read.lines;
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
    const { format, group, age } = this.settings;
    const now = Date.now() / 1000;
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
      const bars = new Map<string, string>();
      const options: vscode.DecorationOptions[] = [];
      const marks: vscode.Range[] = [];
      // Every line has something before it, if only room, for the text to stay in one column: as wide as the longest.
      const labels = blameLabels(shown.lines, editor.document.lineCount, { format, group, now });
      const width = `${labels.reduce((longest, text) => Math.max(longest, text.length), 1)}ch`;
      /** The color of the age of a line, at the left of what is beside it; a line git said nothing of has the room of it. */
      const bar = (line: BlameLine | undefined) => {
        if (!age) return undefined;
        if (!line) return `${STYLE}; border-left: ${BAR} solid transparent`;
        let style = bars.get(line.hash);
        // A line that is in no commit was changed now.
        if (!style) bars.set(line.hash, (style = `${STYLE}; border-left: ${BAR} solid ${ageColor(line.committed ? line.date : now, now, age)}`));
        return style;
      };
      // What the line under the cursor has beside it stands out, as it does beside the other lines of its commit.
      const lit = {
        color: new vscode.ThemeColor('gitardo.blameHighlightForeground'),
        backgroundColor: new vscode.ThemeColor('gitardo.blameHighlightBackground'),
      };
      for (const [index, label] of labels.entries()) {
        const line = shown.lines[index];
        let hoverMessage: vscode.MarkdownString | undefined;
        if (line?.committed) {
          hoverMessage = hovers.get(line);
          if (!hoverMessage) hovers.set(line, (hoverMessage = hover(line, shown.root)));
        }
        const stands = line !== undefined && line.hash === commit;
        const textDecoration = bar(line);
        options.push({
          range: new vscode.Range(index, 0, index, 0),
          hoverMessage,
          renderOptions: {
            before: { contentText: label ? label.replace(/ /g, SPACE) : SPACE, width, ...(textDecoration ? { textDecoration } : {}), ...(stands ? lit : {}) },
          },
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
