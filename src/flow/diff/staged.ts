/**
 * Staged-chunk detection for HEAD↔worktree models.
 * No `vscode` import — unit-testable with plain node.
 *
 * A chunk is staged when the index agrees with the worktree on the chunk's
 * region: staging copies worktree content into the index, so once a chunk is
 * staged no index↔worktree difference touches its lines anymore. Partially
 * staged chunks still differ there and stay unmarked.
 */
import { hunkSpan, lineHunks, lineSpan, overlaps } from './hunks';
import type { AlignedDiffModel } from './model';

export function markStagedChunks(
  model: AlignedDiffModel,
  indexText: string | undefined,
  worktreeText: string
): void {
  if (indexText === undefined) {
    return; // nothing in the index (untracked file): every chunk is unstaged
  }
  // worktree-side spans of every index↔worktree difference
  const dirty = lineHunks(indexText, worktreeText).map((h) => hunkSpan(h, 'new'));
  for (const chunk of model.chunks) {
    const span = lineSpan(chunk.rightStart, chunk.rightCount);
    chunk.staged = !dirty.some((d) => overlaps(span, d));
  }
}
