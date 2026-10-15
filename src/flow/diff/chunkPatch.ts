/**
 * Index patches for the per-chunk stage / unstage buttons.
 * No `vscode` import — unit-testable with plain node.
 *
 * Both directions patch the index *forward*, starting from its exact current
 * content: staging moves it towards the worktree, unstaging back towards
 * HEAD, touching only the hunks that overlap the chunk. Building on the
 * index (instead of replaying a HEAD↔worktree chunk) keeps the line numbers
 * right when other parts of the file are already partially staged.
 */
import { type Hunk, hunkSpan, lineHunks, lineSpan, overlaps, type Span } from './hunks';
import { synthesizePatch } from './patch';

/** A hunk-header line range of a chunk on one side of the diff. */
export interface LineRange {
  start: number;
  count: number;
}

/**
 * Patch staging the index↔worktree hunks that overlap `worktreeRange`, or
 * undefined when that region is already staged.
 */
export function stagePatch(
  repoRelativePath: string,
  indexText: string,
  worktreeText: string,
  worktreeRange: LineRange
): string | undefined {
  const hunks = select(lineHunks(indexText, worktreeText), 'new', worktreeRange);
  if (hunks.length === 0) {
    return undefined;
  }
  // new lines take the index's EOL style (what `git add` would store under autocrlf)
  const addedEol = indexText.includes('\r\n') ? 'crlf' : 'lf';
  return synthesizePatch(repoRelativePath, indexText, worktreeText, hunks, { addedEol });
}

/**
 * Patch restoring HEAD content in the index for the HEAD↔index hunks that
 * overlap `range`, given either in index coordinates (index view, where
 * chunks are HEAD↔index) or in HEAD coordinates (worktree view, where a
 * staged chunk's left side is HEAD). Undefined when nothing is staged there.
 */
export function unstagePatch(
  repoRelativePath: string,
  indexText: string,
  headText: string,
  range: LineRange,
  rangeSide: 'index' | 'head'
): string | undefined {
  const hunks = select(lineHunks(indexText, headText), rangeSide === 'index' ? 'old' : 'new', range);
  if (hunks.length === 0) {
    return undefined;
  }
  return synthesizePatch(repoRelativePath, indexText, headText, hunks, { addedEol: 'raw' });
}

function select(hunks: Hunk[], side: 'old' | 'new', range: LineRange): Hunk[] {
  const target: Span = lineSpan(range.start, range.count);
  return hunks.filter((h) => overlaps(hunkSpan(h, side), target));
}
