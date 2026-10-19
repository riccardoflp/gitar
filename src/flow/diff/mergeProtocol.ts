/**
 * Message protocol between the extension host and the Flow Merge page.
 * Must stay free of `vscode` imports (bundled into the webview).
 */
import type { MergeModel } from './mergeModel';
import type { SyntaxTheme } from './protocol';

export interface MergeSettings {
  /** The user's `editor.*` configuration as plain JSON, as for the Flow Diff. */
  editorOptions: Record<string, unknown>;
}

/** extension → webview */
export type MergeHostMessage =
  | { type: 'init'; model: MergeModel; settings: MergeSettings; syntaxTheme?: SyntaxTheme }
  | { type: 'update'; model: MergeModel }
  | { type: 'navigate'; direction: 'next' | 'prev' }
  | { type: 'theme'; syntaxTheme?: SyntaxTheme }
  | { type: 'editorConfig'; options: Record<string, unknown> };

/** webview → extension */
export type MergeWebviewMessage =
  | { type: 'ready' }
  /** Jump to Source: open the file at this line of the result. */
  | { type: 'openAt'; line: number }
  /** The whole text of the result, as typed or chosen in it: the host puts it in the file, unsaved. */
  | { type: 'edit'; text: string }
  /** Ctrl+S in the page: save the file. */
  | { type: 'saveFile' };
