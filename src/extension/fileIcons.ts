import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FileIconTheme } from '../shared/fileIcons';
import { addressed, languageMap, readFileIconTheme, type ReadTheme, type ThemeKind } from './fileIconTheme';

interface IconThemeContribution {
  id?: string;
  path?: string;
}

const contributed = <T>(extension: vscode.Extension<unknown>, point: string): T[] => {
  const entries = (extension.packageJSON as { contributes?: Record<string, unknown> } | undefined)?.contributes?.[point];
  return Array.isArray(entries) ? (entries as T[]) : [];
};

function themeKind(): ThemeKind {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return 'light';
    case vscode.ColorThemeKind.HighContrast:
    case vscode.ColorThemeKind.HighContrastLight:
      return 'highContrast';
    default:
      return 'dark';
  }
}

/** The file icon theme the user chose, or none: null is what the setting holds when the user chose None. */
const chosenTheme = () => vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme') || null;

/** The file icon theme the user chose in VS Code, read once for each theme and kind of colors, for the pages that show files. */
export class FileIcons implements vscode.Disposable {
  private read?: { key: string; theme: Promise<ReadTheme | null> };
  private languages?: FileIconTheme['languages'];
  /** The theme and the kind of colors the pages were last told about. */
  private shown = this.key();
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires when the icons may have changed: another theme, other colors, extensions added or taken away. */
  readonly onDidChange = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.subscriptions = [
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('files.associations')) {
          this.languages = undefined;
          this.emitter.fire();
        } else if (event.affectsConfiguration('workbench.iconTheme')) this.changed();
      }),
      vscode.window.onDidChangeActiveColorTheme(() => this.changed()),
      vscode.extensions.onDidChange(() => {
        this.languages = undefined;
        this.read = undefined;
        this.emitter.fire();
      }),
      this.emitter,
    ];
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  /** The folders of the extensions with icon themes: what a page may load icons from. */
  static roots(): vscode.Uri[] {
    return vscode.extensions.all.filter((extension) => contributed(extension, 'iconThemes').length).map((extension) => extension.extensionUri);
  }

  /** The theme for a page, with its files as that page loads them. Null when the user chose none, or when it cannot be read. */
  async for(webview: vscode.Webview): Promise<FileIconTheme | null> {
    const theme = await this.current();
    return theme && addressed(theme, this.languageMap(), (file) => webview.asWebviewUri(vscode.Uri.file(file)).toString());
  }

  private key(): string {
    return `${chosenTheme()}\n${themeKind()}`;
  }

  /** Tells the pages only when the theme or the kind of colors changed: another color theme of the same kind has the same icons. */
  private changed(): void {
    const key = this.key();
    if (key === this.shown) return;
    this.shown = key;
    this.emitter.fire();
  }

  private current(): Promise<ReadTheme | null> {
    const key = this.key();
    if (this.read?.key !== key) this.read = { key, theme: this.load() };
    return this.read.theme;
  }

  private async load(): Promise<ReadTheme | null> {
    const id = chosenTheme();
    if (!id) return null;
    for (const extension of vscode.extensions.all) {
      const entry = contributed<IconThemeContribution>(extension, 'iconThemes').find((theme) => theme.id === id);
      if (!entry?.path) continue;
      try {
        return await readFileIconTheme(path.join(extension.extensionPath, entry.path), themeKind());
      } catch (error) {
        this.log.warn(`Files are shown with no icons: the file icon theme ${id} could not be read. ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }
    // VS Code shows no icons either then.
    this.log.info(`Files are shown with no icons: no extension has the file icon theme ${id}.`);
    return null;
  }

  /** The languages of VS Code by the names and extensions of their files, with those of `files.associations` first. */
  private languageMap(): FileIconTheme['languages'] {
    this.languages ??= languageMap(
      vscode.extensions.all.map((extension) => extension.packageJSON),
      vscode.workspace.getConfiguration('files').get<Record<string, unknown>>('associations'),
    );
    return this.languages;
  }
}
