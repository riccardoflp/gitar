import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BlameLine } from '../git/parse';
import type { Repo } from '../git/repo';
import { DEFAULT_AGE, DEFAULT_FORMAT, ageColor, blameLabels, parseFormat, type AgeColors, type FormatPart } from '../shared/blameFormat';
import { ignoresWhitespace, type Blamable, type BlameSource } from './blame';
import { SCHEME, revisionUri } from './content';

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
/**
 * How much wider than what is beside the lines the room kept for it is, in characters: the padding on either side,
 * the bar, and a gap before the text.
 */
const ROOM = 4;
/** Between what is beside a line and its text. */
const GAP = '1.5ch';
/** What stands beside the lines of the commit of the line under the cursor is on this. */
const LIT = 'var(--vscode-gitardo-blameHighlightBackground)';

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

interface Drawn {
  lines: (BlameLine | undefined)[];
  labels: string[];
  /** What the first line in sight is given, when it is not the first of its commit. */
  pin(line: BlameLine, label: string): vscode.DecorationOptions['renderOptions'];
  /** The line that was given it, -1 for none, -2 until it is told. */
  at: number;
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
      textDecoration: STYLE,
    },
  });
  /**
   * What the first line of a commit says, over the first line in sight when the editor is scrolled past the first
   * one: what is beside the lines that follow it would otherwise say nothing of them.
   */
  private readonly pinned = vscode.window.createTextEditorDecorationType({
    before: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'normal', fontWeight: 'normal' },
  });
  /** Where the other lines of the commit of the line under the cursor are, in the scroll bar of a file longer than its editor. */
  private readonly marks = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: new vscode.ThemeColor('gitardo.blameHighlightForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  private readonly subscriptions: vscode.Disposable[];
  /**
   * What is beside the lines is drawn before them, and VS Code does not count it when it folds the lines that are
   * too long: the first part of each would go past the edge. Room is kept for it with an inlay hint of spaces at the
   * start of each line, which VS Code counts, and what is beside the line is drawn over that room. This says how many
   * spaces each file is given, by the URI of its document.
   */
  private readonly room = new Map<string, number>();
  private readonly roomChanged = new vscode.EventEmitter<void>();
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
  /** What was drawn beside the lines of each editor, for the first line in sight to be given what its commit says. */
  private readonly drawn = new WeakMap<vscode.TextEditor, Drawn>();

  constructor(
    private readonly source: BlameSource,
    private readonly actions: BlameActions,
  ) {
    this.subscriptions = [
      this.decoration,
      this.pinned,
      this.marks,
      this.roomChanged,
      vscode.languages.registerInlayHintsProvider([{ scheme: 'file' }, { scheme: SCHEME }], {
        onDidChangeInlayHints: this.roomChanged.event,
        provideInlayHints: (document, range) => this.hints(document, range),
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.render();
        this.follow();
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => this.moved(event.textEditor)),
      vscode.window.onDidChangeTextEditorVisibleRanges((event) => this.pin(event.textEditor)),
      vscode.window.onDidChangeActiveTextEditor(() => this.tell()),
      vscode.workspace.onDidChangeTextDocument((event) => this.edited(event)),
      vscode.workspace.onDidSaveTextDocument((document) => this.schedule(document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.forget(document.uri)),
      vscode.workspace.onDidChangeConfiguration(
        (event) =>
          ['gitardo.fileBlame', 'gitardo.blame', 'editor.inlayHints', 'editor.fontSize'].some((section) => event.affectsConfiguration(section)) &&
          this.configured(),
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
        this.makeRoom(vscode.Uri.parse(key), 0);
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
    this.makeRoom(uri, 0);
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
    // An edit moves the hints with the text, and a file read again from the disk runs them all into its first line.
    this.roomChanged.fire();
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
      // What the hints say of each line, too.
      this.roomChanged.fire();
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
        this.makeRoom(editor.document.uri, 0);
        this.drawn.delete(editor);
        editor.setDecorations(this.decoration, []);
        editor.setDecorations(this.pinned, []);
        editor.setDecorations(this.marks, []);
        continue;
      }
      const hovers = new Map<BlameLine, vscode.MarkdownString>();
      const styles = new Map<string, string>();
      const options: vscode.DecorationOptions[] = [];
      const marks: vscode.Range[] = [];
      // Every line has something before it, if only room, for the text to stay in one column: as wide as the longest.
      const labels = blameLabels(shown.lines, editor.document.lineCount, { format, group, now });
      const chars = labels.reduce((longest, text) => Math.max(longest, text.length), 1);
      const room = roomFor(editor.document, chars);
      // Over the room, as wide as it all, with the gap before the text in it.
      const width = room ? `${chars + ROOM}ch` : `${chars}ch`;
      this.makeRoom(editor.document.uri, room);
      /**
       * How what is beside a line is drawn: over the room kept for it, on the background of the editor that hides the
       * one of the hint, or before the line when there is no room; with the color of the age of the line at its left,
       * where a line git said nothing of has the room of it. What a line is given for its commit to be named on it
       * is drawn over what it has beside it, always on the background of the editor.
       */
      const style = (line: BlameLine | undefined, stands: boolean, pinned = false) => {
        const key = `${line?.hash ?? ''} ${stands} ${pinned}`;
        let text = styles.get(key);
        if (text) return text;
        const parts = [STYLE];
        if (room) {
          const lit = stands ? `linear-gradient(to right, ${LIT} calc(100% - ${GAP}), transparent 0), ` : '';
          parts.push(`position: absolute; left: 0; box-sizing: border-box; background: ${lit}var(--vscode-editor-background)`);
        } else if (pinned) {
          const lit = stands ? `linear-gradient(${LIT}, ${LIT}), ` : '';
          parts.push(`position: absolute; left: 0; background: ${lit}var(--vscode-editor-background)`);
        } else parts.push(`margin-right: ${GAP}`);
        if (pinned) parts.push('z-index: 1');
        // A line that is in no commit was changed now.
        if (age) parts.push(`border-left: ${BAR} solid ${line ? ageColor(line.committed ? line.date : now, now, age) : 'transparent'}`);
        styles.set(key, (text = parts.join('; ')));
        return text;
      };
      // What the line under the cursor has beside it stands out, as it does beside the other lines of its commit.
      const lit = { color: new vscode.ThemeColor('gitardo.blameHighlightForeground') };
      const litBefore = room ? lit : { ...lit, backgroundColor: new vscode.ThemeColor('gitardo.blameHighlightBackground') };
      for (const [index, label] of labels.entries()) {
        const line = shown.lines[index];
        let hoverMessage: vscode.MarkdownString | undefined;
        // Over the room, the hint has it.
        if (line?.committed && !room) {
          hoverMessage = hovers.get(line);
          if (!hoverMessage) hovers.set(line, (hoverMessage = hover(line, shown.root)));
        }
        const stands = line !== undefined && line.hash === commit;
        options.push({
          range: new vscode.Range(index, 0, index, 0),
          hoverMessage,
          renderOptions: {
            before: { contentText: label ? label.replace(/ /g, SPACE) : SPACE, width, textDecoration: style(line, stands), ...(stands ? litBefore : {}) },
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
      this.drawn.set(editor, {
        lines: shown.lines,
        labels,
        pin: (line, label) => {
          const stands = line.hash === commit;
          return { before: { contentText: label.replace(/ /g, SPACE), width, textDecoration: style(line, stands, true), ...(stands ? lit : {}) } };
        },
        // Drawn again, whatever line had it.
        at: -2,
      });
      this.pin(editor);
    }
  }

  /**
   * What the first line of a commit says is on the first line in sight when the ones above it are scrolled out of
   * sight, for the lines that follow to be said whose they are.
   */
  private pin(editor: vscode.TextEditor): void {
    const drawn = this.drawn.get(editor);
    if (!drawn) return;
    const top = editor.visibleRanges[0]?.start.line ?? 0;
    const line = drawn.lines[top];
    let first = top;
    // Only the first line of the lines of a commit that follow each other says anything.
    if (line && !drawn.labels[top]) while (first > 0 && drawn.lines[first - 1]?.hash === line.hash) first--;
    const at = line && first < top && drawn.labels[first] ? top : -1;
    if (at === drawn.at) return;
    drawn.at = at;
    editor.setDecorations(
      this.pinned,
      line && at >= 0 ? [{ range: new vscode.Range(at, 0, at, 0), renderOptions: drawn.pin(line, drawn.labels[first]) }] : [],
    );
  }

  /**
   * The room kept at the start of the lines of a document in sight. What is drawn over it is not what the pointer
   * is on: the hint is, and says what the decoration would have said.
   */
  private hints(document: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
    const key = document.uri.toString();
    const spaces = this.room.get(key);
    const shown = this.shown.get(key);
    if (!spaces || !shown) return [];
    const said = new Map<BlameLine, vscode.MarkdownString>();
    const hints: vscode.InlayHint[] = [];
    for (let index = range.start.line; index <= range.end.line; index++) {
      const hint = new vscode.InlayHint(new vscode.Position(index, 0), SPACE.repeat(spaces));
      const line = shown.lines[index];
      if (line?.committed) {
        let tooltip = said.get(line);
        if (!tooltip) said.set(line, (tooltip = hover(line, shown.root)));
        hint.tooltip = tooltip;
      }
      hints.push(hint);
    }
    return hints;
  }

  /** Keeps that many spaces at the start of each line of a document, or none, and has VS Code ask again when it changes. */
  private makeRoom(uri: vscode.Uri, spaces: number): void {
    const key = uri.toString();
    if ((this.room.get(key) ?? 0) === spaces) return;
    if (spaces) this.room.set(key, spaces);
    else this.room.delete(key);
    this.roomChanged.fire();
  }
}

/**
 * How many spaces of an inlay hint make room for what is that many characters wide beside the lines of a document;
 * none when its hints cannot be counted on: when they are switched off, written in a font of their own, whose spaces
 * are not as wide as the ones of the text, or cut at a length shorter than the room.
 */
function roomFor(document: vscode.TextDocument, chars: number): number {
  const hints = vscode.workspace.getConfiguration('editor.inlayHints', document);
  if (!['on', 'onUnlessPressed'].includes(hints.get<string>('enabled') ?? 'on') || hints.get<string>('fontFamily')) return 0;
  // They are written in the size of the text, unless a smaller one is asked for.
  const size = vscode.workspace.getConfiguration('editor', document).get<number>('fontSize') ?? 14;
  const asked = hints.get<number>('fontSize') ?? 0;
  const scale = asked >= 5 && asked < size ? size / asked : 1;
  const spaces = Math.ceil((chars + ROOM) * scale);
  const longest = hints.get<number>('maximumLength') ?? 43;
  return longest > 0 && spaces > longest ? 0 : spaces;
}
