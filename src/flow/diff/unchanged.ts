/**
 * Collapsible runs of unchanged lines between chunks.
 * No `vscode` import — unit-testable with plain node.
 */
import type { AlignedDiffModel } from './model';

/** Lines hidden on both sides (context rows map 1:1, so one count). */
export interface UnchangedRegion {
  /** First hidden line, 1-based, on each side. */
  leftStart: number;
  rightStart: number;
  count: number;
}

/**
 * Context runs long enough to collapse, keeping `context` lines visible next
 * to each chunk (none at the file edges). A file with no changes collapses
 * nothing: there is nothing else to look at.
 */
export function unchangedRegions(
  model: AlignedDiffModel,
  context = 3,
  minHidden = 4
): UnchangedRegion[] {
  const { rows } = model;
  if (model.chunks.length === 0) {
    return [];
  }
  const regions: UnchangedRegion[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].chunkId !== undefined) {
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].chunkId === undefined) {
      j++;
    }
    const start = i === 0 ? i : i + context;
    const end = j === rows.length ? j : j - context;
    const left = rows[start]?.left.lineNumber;
    const right = rows[start]?.right.lineNumber;
    if (end - start >= minHidden && left !== undefined && right !== undefined) {
      regions.push({ leftStart: left, rightStart: right, count: end - start });
    }
    i = j;
  }
  return regions;
}
