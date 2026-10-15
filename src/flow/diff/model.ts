/**
 * Aligned diff model shared between the extension host and the webview.
 * Must stay free of `vscode` imports: it is bundled into the webview and
 * unit-tested with plain node.
 */

/** A half-open character range [start, end) within a line's text. */
export type CharRange = [start: number, end: number];

export type CellKind = 'context' | 'added' | 'removed' | 'modified' | 'filler';

export interface DiffCell {
  kind: CellKind;
  /** 1-based line number in the source document; absent for filler. */
  lineNumber?: number;
  /** Line text without trailing newline; absent for filler. */
  text?: string;
  /** Intra-line changed ranges (only for kind 'modified'). */
  highlights?: CharRange[];
}

/** One visual row. Filler cells guarantee both panes have the same row count. */
export interface DiffRow {
  left: DiffCell;
  right: DiffCell;
  /** Index into chunks, present iff this row belongs to a changed block. */
  chunkId?: number;
}

/** A contiguous changed block — the unit for connectors, navigation and (later) apply/revert. */
export interface DiffChunk {
  id: number;
  kind: 'added' | 'removed' | 'modified';
  /** Row span in the aligned grid (inclusive start, exclusive end). Drives connector geometry. */
  rowStart: number;
  rowEnd: number;
  /**
   * Original-file line spans, 1-based, hunk-header style (when count is 0, start
   * is the line *before* the insertion point, like unified diff headers).
   * Captured now so phase 2 (`git apply --cached`) needs no model change.
   */
  leftStart: number;
  leftCount: number;
  rightStart: number;
  rightCount: number;
  /**
   * True when the index already contains this change (worktree views only).
   * Drives the dimmed rendering and the stage→unstage button swap.
   */
  staged?: boolean;
}

export interface AlignedDiffModel {
  rows: DiffRow[];
  chunks: DiffChunk[];
  leftLabel: string;
  rightLabel: string;
  /** For future syntax highlighting. */
  languageId: string;
  /** Workspace-relative path, used for the panel title and header. */
  filePath: string;
}
