/**
 * Piecewise linear scroll mapping between the two panes, anchored at chunk
 * boundaries. Pure geometry (no Monaco, no `vscode`) — unit-testable.
 */

/** Matching pixel positions on both sides, in order. */
export interface ScrollAnchors {
  left: number[];
  right: number[];
}

/**
 * Anchor sequences from matching [left, right] pixel pairs (chunk tops and
 * bottoms, then the content end), starting at [0, 0]. Each side is clamped
 * to stay monotonic so the interpolation is always well-defined.
 */
export function buildAnchors(pairs: Array<[left: number, right: number]>): ScrollAnchors {
  const left = [0];
  const right = [0];
  for (const [l, r] of pairs) {
    left.push(Math.max(l, left[left.length - 1]));
    right.push(Math.max(r, right[right.length - 1]));
  }
  return { left, right };
}

/**
 * Maps a position from one side to the other: linear between consecutive
 * anchors (1:1 across context, stretched across chunks of different heights),
 * 1:1 past the last anchor.
 */
export function mapPosition(y: number, from: number[], to: number[]): number {
  if (y <= from[0]) {
    return to[0];
  }
  for (let i = 1; i < from.length; i++) {
    if (y <= from[i]) {
      const span = from[i] - from[i - 1];
      const t = span === 0 ? 1 : (y - from[i - 1]) / span;
      return to[i - 1] + t * (to[i] - to[i - 1]);
    }
  }
  return to[to.length - 1] + (y - from[from.length - 1]);
}
