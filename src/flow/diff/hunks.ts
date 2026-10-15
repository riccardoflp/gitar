/**
 * Line-level hunks between two texts, and spans to intersect them with chunks.
 * No `vscode` import — unit-testable with plain node.
 */
import { diffLines } from 'diff';

/** A changed region, in hunk-header coordinates (count 0 → start is the line before). */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/**
 * Closed interval on (fractional) line numbers. Zero-length sides — pure
 * insertions/deletions — sit on the boundary *after* their anchor line
 * (n + 0.5), so two of them at the same spot intersect while adjacent
 * changes on whole lines do not.
 */
export type Span = [lo: number, hi: number];

/** Hunks of `oldText` → `newText`; CRLF/LF differences are ignored. */
export function lineHunks(oldText: string, newText: string): Hunk[] {
  const parts = diffLines(normalizeEol(oldText), normalizeEol(newText));
  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const count = part.count ?? 0;
    if (!part.added && !part.removed) {
      oldLine += count;
      newLine += count;
      continue;
    }
    // jsdiff emits the removed run before the added run for replaced regions
    let removed = 0;
    let added = 0;
    if (part.removed) {
      removed = count;
      const next = parts[i + 1];
      if (next?.added) {
        added = next.count ?? 0;
        i++;
      }
    } else {
      added = count;
    }
    hunks.push({
      oldStart: removed > 0 ? oldLine : oldLine - 1,
      oldCount: removed,
      newStart: added > 0 ? newLine : newLine - 1,
      newCount: added,
    });
    oldLine += removed;
    newLine += added;
  }
  return hunks;
}

/** Span of a hunk-header range (`start`, `count`) on its own side. */
export function lineSpan(start: number, count: number): Span {
  return count > 0 ? [start, start + count - 1] : [start + 0.5, start + 0.5];
}

/**
 * Span a hunk occupies on one side. A replacement also touches the boundary
 * before its first line, so a pure insertion/deletion anchored right above it
 * counts as overlapping.
 */
export function hunkSpan(hunk: Hunk, side: 'old' | 'new'): Span {
  const [start, count, otherCount] =
    side === 'old'
      ? [hunk.oldStart, hunk.oldCount, hunk.newCount]
      : [hunk.newStart, hunk.newCount, hunk.oldCount];
  const span = lineSpan(start, count);
  return count > 0 && otherCount > 0 ? [span[0] - 0.5, span[1]] : span;
}

export function overlaps(a: Span, b: Span): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/** Display-only normalization: CRLF → LF. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
