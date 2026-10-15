/**
 * Line correspondence between the two sides of an aligned model.
 * No `vscode` import — unit-testable with plain node.
 */
import type { AlignedDiffModel } from './model';

/**
 * The right-side line matching `leftLine`: the same row when it has a right
 * line, otherwise (a removed line) the nearest right line above it — where
 * the removed text used to be. 1-based; 1 when there is none above.
 */
export function rightLineForLeft(model: AlignedDiffModel, leftLine: number): number {
  let lastRight = 1;
  for (const row of model.rows) {
    if (row.right.lineNumber !== undefined && row.left.lineNumber === leftLine) {
      return row.right.lineNumber;
    }
    if (row.left.lineNumber === leftLine) {
      return lastRight;
    }
    if (row.right.lineNumber !== undefined) {
      lastRight = row.right.lineNumber;
    }
  }
  return lastRight;
}
