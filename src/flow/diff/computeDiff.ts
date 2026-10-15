/**
 * Pure diff engine: (oldText, newText) → AlignedDiffModel.
 * No `vscode` import — unit-testable with `node --test`.
 */
import { type Change, diffLines, diffWordsWithSpace, type LinesOptions } from 'diff';
import type { AlignedDiffModel, CharRange, DiffChunk, DiffRow } from './model';

export interface ComputeDiffInput {
  oldText: string;
  newText: string;
  leftLabel: string;
  rightLabel: string;
  languageId: string;
  filePath: string;
  /** Give up with DiffTooComplexError after this many milliseconds. */
  timeoutMs?: number;
}

/** The line diff exceeded `timeoutMs` (huge file with many scattered changes). */
export class DiffTooComplexError extends Error {
  constructor() {
    super('too many differences to display');
  }
}

/**
 * When more than this fraction of both lines changed, intra-line highlights
 * are noise rather than signal, so they are skipped.
 */
const INTRA_LINE_SKIP_RATIO = 0.65;

export function computeDiff(input: ComputeDiffInput): AlignedDiffModel {
  const parts = lineParts(normalizeEol(input.oldText), normalizeEol(input.newText), input.timeoutMs);
  const rows: DiffRow[] = [];
  const chunks: DiffChunk[] = [];
  let leftLine = 1;
  let rightLine = 1;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (!part.added && !part.removed) {
      for (const line of splitLines(part.value)) {
        rows.push({
          left: { kind: 'context', lineNumber: leftLine++, text: line },
          right: { kind: 'context', lineNumber: rightLine++, text: line },
        });
      }
      continue;
    }

    // jsdiff emits the removed run before the added run for replaced regions:
    // pair them into a single 'modified' chunk.
    let removedLines: string[] = [];
    let addedLines: string[] = [];
    if (part.removed) {
      removedLines = splitLines(part.value);
      const next = parts[i + 1];
      if (next?.added) {
        addedLines = splitLines(next.value);
        i++;
      }
    } else {
      addedLines = splitLines(part.value);
    }

    chunks.push(buildChunk(chunks.length, removedLines, addedLines, leftLine, rightLine, rows));
    leftLine += removedLines.length;
    rightLine += addedLines.length;
  }

  return {
    rows,
    chunks,
    leftLabel: input.leftLabel,
    rightLabel: input.rightLabel,
    languageId: input.languageId,
    filePath: input.filePath,
  };
}

function lineParts(oldText: string, newText: string, timeoutMs: number | undefined): Change[] {
  // jsdiff supports `timeout` (returns undefined when exceeded) but its typings lag behind
  const options: LinesOptions & { timeout?: number } = timeoutMs === undefined ? {} : { timeout: timeoutMs };
  const parts = diffLines(oldText, newText, options) as Change[] | undefined;
  if (!parts) {
    throw new DiffTooComplexError();
  }
  return parts;
}

function buildChunk(
  id: number,
  removed: string[],
  added: string[],
  leftLine: number,
  rightLine: number,
  rows: DiffRow[]
): DiffChunk {
  const rowStart = rows.length;
  const kind = removed.length === 0 ? 'added' : added.length === 0 ? 'removed' : 'modified';

  // Pair min(L, R) lines as 'modified' with word-level highlights,
  // pad the shorter side with fillers for the remaining |L - R| rows.
  const paired = Math.min(removed.length, added.length);
  for (let j = 0; j < paired; j++) {
    const [leftRanges, rightRanges] = intraLineHighlights(removed[j], added[j]);
    rows.push({
      left: { kind: 'modified', lineNumber: leftLine + j, text: removed[j], highlights: leftRanges },
      right: { kind: 'modified', lineNumber: rightLine + j, text: added[j], highlights: rightRanges },
      chunkId: id,
    });
  }
  for (let j = paired; j < removed.length; j++) {
    rows.push({
      left: { kind: 'removed', lineNumber: leftLine + j, text: removed[j] },
      right: { kind: 'filler' },
      chunkId: id,
    });
  }
  for (let j = paired; j < added.length; j++) {
    rows.push({
      left: { kind: 'filler' },
      right: { kind: 'added', lineNumber: rightLine + j, text: added[j] },
      chunkId: id,
    });
  }

  return {
    id,
    kind,
    rowStart,
    rowEnd: rows.length,
    leftStart: removed.length === 0 ? leftLine - 1 : leftLine,
    leftCount: removed.length,
    rightStart: added.length === 0 ? rightLine - 1 : rightLine,
    rightCount: added.length,
  };
}

function intraLineHighlights(
  oldLine: string,
  newLine: string
): [CharRange[] | undefined, CharRange[] | undefined] {
  const parts = diffWordsWithSpace(oldLine, newLine);
  const leftRanges: CharRange[] = [];
  const rightRanges: CharRange[] = [];
  let posOld = 0;
  let posNew = 0;
  let changedOld = 0;
  let changedNew = 0;

  for (const part of parts) {
    const len = part.value.length;
    if (part.removed) {
      leftRanges.push([posOld, posOld + len]);
      posOld += len;
      changedOld += len;
    } else if (part.added) {
      rightRanges.push([posNew, posNew + len]);
      posNew += len;
      changedNew += len;
    } else {
      posOld += len;
      posNew += len;
    }
  }

  const tooDifferent =
    oldLine.length > 0 &&
    newLine.length > 0 &&
    changedOld > oldLine.length * INTRA_LINE_SKIP_RATIO &&
    changedNew > newLine.length * INTRA_LINE_SKIP_RATIO;
  if (tooDifferent) {
    return [undefined, undefined];
  }
  return [mergeAdjacent(leftRanges), mergeAdjacent(rightRanges)];
}

function mergeAdjacent(ranges: CharRange[]): CharRange[] | undefined {
  if (ranges.length === 0) {
    return undefined;
  }
  const merged: CharRange[] = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] <= last[1]) {
      last[1] = Math.max(last[1], ranges[i][1]);
    } else {
      merged.push(ranges[i]);
    }
  }
  return merged;
}

/**
 * Display-only normalization: CRLF → LF so word diffs never highlight a bare
 * `\r`. Phase 2 patch synthesis must re-read original contents from git.
 */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Split a jsdiff part value into lines, dropping the trailing newline artifact. */
function splitLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '' && value.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}
