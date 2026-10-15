/**
 * Message protocol between the extension host and the webview.
 * Must stay free of `vscode` imports (bundled into the webview).
 */
import type { AlignedDiffModel } from './model';

export interface DiffSettings {
  /**
   * The user's `editor.*` configuration as plain JSON; applied to the Monaco
   * panes so they match the regular editor (Monaco option names mirror the
   * VS Code setting keys).
   */
  editorOptions: Record<string, unknown>;
  /** Drives which chunk actions the webview offers (revert/stage vs unstage vs none). */
  rightSide: 'worktree' | 'index' | 'ref';
  /** False when the index cannot take part: the worktree pane only offers revert. */
  canStage: boolean;
  /** Initial state of the "collapse unchanged regions" toggle. */
  collapseUnchanged: boolean;
  /** F7 past the last chunk moves to the next changed file (diffs of uncommitted changes only). */
  fileNavigation: boolean;
}

/** The user's active color theme, resolved host-side and loadable by shiki. */
export interface SyntaxTheme {
  name: string;
  type: 'dark' | 'light';
  /** Raw VS Code theme JSON (includes already merged). */
  raw: Record<string, unknown>;
}

/** extension → webview */
export type HostMessage =
  | { type: 'init'; model: AlignedDiffModel; settings: DiffSettings; syntaxTheme?: SyntaxTheme }
  | { type: 'update'; model: AlignedDiffModel }
  | { type: 'navigate'; direction: 'next' | 'prev' }
  | { type: 'theme'; syntaxTheme?: SyntaxTheme }
  | { type: 'editorConfig'; options: Record<string, unknown> };

/** webview → extension */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'currentChunkChanged'; chunkId: number }
  /** Jump to Source: open the real file at this (worktree-side) line. */
  | { type: 'openAt'; line: number }
  | { type: 'navigateFile'; direction: 'next' | 'prev' }
  | { type: 'revertChunk'; chunkId: number }
  | { type: 'stageChunk'; chunkId: number }
  | { type: 'unstageChunk'; chunkId: number }
  /** Full right-side text after an in-place edit (LF line endings). */
  | { type: 'edit'; text: string }
  | { type: 'saveFile' };
