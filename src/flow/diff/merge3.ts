/**
 * Computes the three-way model of a file in conflict: what each side changed of the common ancestor, and where each
 * of those changes is in the file git wrote. No `vscode` import: it runs in the diff worker and is unit-tested.
 */
import { computeDiff } from './computeDiff';
import { normalizeEol } from './hunks';
import { type LineHighlight, type MergeModel, type MergeRegion, type RegionKind, span } from './mergeModel';
import type { DiffChunk } from './model';

export interface MergeInput {
  base: string;
  ours: string;
  theirs: string;
  result: string;
  languageId: string;
  filePath: string;
  oursLabel: string;
  theirsLabel: string;
  resultLabel: string;
  /** Give up with DiffTooComplexError after this many milliseconds, for each of the diffs. */
  timeoutMs?: number;
}

/** A stretch of lines from 0, the first and the one after the last, in one text (`s`, `e`) and in another (`bs`, `be`). */
interface Hunk {
  bs: number;
  be: number;
  s: number;
  e: number;
}

const MARKER = 7;

export function computeMerge(input: MergeInput): MergeModel {
  const [base, ours, theirs, result] = [input.base, input.ours, input.theirs, input.result].map(normalizeEol);
  const [oursLines, theirsLines, resultLines] = [ours, theirs, result].map(lines);
  const diff = differ(input.timeoutMs);
  const { groups, oursDiff, theirsDiff } = regionsOf(base, ours, theirs, diff);

  // The result git would have written for these regions: the base where neither side changed it, the side that
  // changed it, and both sides between markers where they differ. Compared with the real one, it tells where each
  // region is in it, whatever git did differently and whatever was edited since.
  const expected: string[] = [];
  const expectedSpans: [number, number][] = [];
  let atOurs = 0;
  for (const region of groups) {
    for (let index = atOurs; index < region.ours[0]; index++) expected.push(oursLines[index]);
    const start = expected.length;
    const [oursPart, theirsPart] = [oursLines.slice(...region.ours), theirsLines.slice(...region.theirs)];
    if (region.kind === 'theirs') expected.push(...theirsPart);
    else if (region.kind !== 'conflict') expected.push(...oursPart);
    else expected.push('<'.repeat(MARKER), ...oursPart, '='.repeat(MARKER), ...theirsPart, '>'.repeat(MARKER));
    expectedSpans.push([start, expected.length]);
    atOurs = region.ours[1];
  }
  for (let index = atOurs; index < oursLines.length; index++) expected.push(oursLines[index]);
  const toResult = diff(text(expected), text(resultLines)).chunks.map(toHunk);

  const blocks = markerBlocks(resultLines);
  const regions: MergeRegion[] = groups.map((region, id) => {
    const at: [number, number] = [mapBoundary(toResult, expectedSpans[id][0], 'start'), mapBoundary(toResult, expectedSpans[id][1], 'end')];
    return { id, kind: region.kind, base: span(region.base), ours: span(region.ours), theirs: span(region.theirs), at };
  }).map(({ at, ...region }) => {
    const block = blocks.find((each) => each.from < Math.max(at[1], at[0] + 1) && at[0] < each.to);
    // Where git marked a conflict, it is one, even where the two diffs found the sides to agree.
    const kind: RegionKind = block ? 'conflict' : region.kind;
    const whole = block ? ([Math.min(at[0], block.from), Math.max(at[1], block.to)] as [number, number]) : at;
    return {
      ...region,
      kind,
      result: span(whole),
      resultOurs: span(block ? block.ours : whole),
      resultTheirs: span(block ? block.theirs : whole),
      unresolved: block !== undefined,
    };
  });

  return {
    ours,
    result,
    theirs,
    regions,
    oursHighlights: highlights(oursDiff.rows),
    theirsHighlights: highlights(theirsDiff.rows),
    markerLines: blocks.flatMap((block) => block.markers.map((line) => line + 1)),
    languageId: input.languageId,
    filePath: input.filePath,
    oursLabel: input.oursLabel,
    theirsLabel: input.theirsLabel,
    resultLabel: input.resultLabel,
  };
}

/**
 * The result as the merge editor of VS Code starts it, before anything is chosen in it: the base, with the changes of
 * one side or the same on both, and the base where the two sides conflict. Found the way the regions are found here,
 * so it can differ from the merge editor's own where the two diffs would pair lines differently.
 */
export function mergeEditorStart(base: string, ours: string, theirs: string, timeoutMs?: number): string {
  const [b, o, t] = [base, ours, theirs].map(normalizeEol);
  const [baseLines, oursLines, theirsLines] = [b, o, t].map(lines);
  const out: string[] = [];
  let at = 0;
  for (const region of regionsOf(b, o, t, differ(timeoutMs)).groups) {
    out.push(...baseLines.slice(at, region.base[0]));
    if (region.kind === 'theirs') out.push(...theirsLines.slice(...region.theirs));
    else if (region.kind === 'conflict') out.push(...baseLines.slice(...region.base));
    else out.push(...oursLines.slice(...region.ours));
    at = region.base[1];
  }
  out.push(...baseLines.slice(at));
  return text(out);
}

type Differ = (from: string, to: string) => ReturnType<typeof computeDiff>;

function differ(timeoutMs: number | undefined): Differ {
  return (from, to) => computeDiff({ oldText: from, newText: to, leftLabel: '', rightLabel: '', languageId: '', filePath: '', timeoutMs });
}

/** The regions of the changes of the two sides, from texts with LF line endings, and the diffs they come from. */
function regionsOf(base: string, ours: string, theirs: string, diff: Differ) {
  const [oursDiff, theirsDiff] = [diff(base, ours), diff(base, theirs)];
  const groups = settle(group(oursDiff.chunks.map(toHunk), theirsDiff.chunks.map(toHunk)), lines(ours), lines(theirs));
  return { groups, oursDiff, theirsDiff };
}

/** A region as found from the two diffs: half-open stretches from 0 of the base and of each side. */
interface Grouped {
  kind: RegionKind;
  base: [number, number];
  ours: [number, number];
  theirs: [number, number];
}

/**
 * The changes of the two sides, put in regions: a change of one side that touches one of the other, or is next to
 * it, is in the same region, which is where git stops. The regions are in the order of the base.
 */
function group(oursHunks: Hunk[], theirsHunks: Hunk[]): Grouped[] {
  const hunks = [oursHunks, theirsHunks];
  const next = [0, 0];
  // How many more lines each side has than the base, before the place reached.
  const shift = [0, 0];
  const touch = (one: Hunk, two: Hunk) => one.bs <= two.be && two.bs <= one.be;
  const regions: Grouped[] = [];
  for (;;) {
    const [first, second] = [hunks[0][next[0]], hunks[1][next[1]]] as (Hunk | undefined)[];
    if (!first && !second) break;
    const members: Hunk[][] = [[], []];
    const lead = !second || (first && first.bs <= second.bs) ? 0 : 1;
    members[lead].push(hunks[lead][next[lead]++]);
    for (let grown = true; grown; ) {
      grown = false;
      for (const side of [0, 1]) {
        const candidate = hunks[side][next[side]] as Hunk | undefined;
        if (candidate && members[1 - side].some((taken) => touch(candidate, taken))) {
          members[side].push(candidate);
          next[side]++;
          grown = true;
        }
      }
    }
    const all = [...members[0], ...members[1]];
    const from = Math.min(...all.map((hunk) => hunk.bs));
    const to = Math.max(...all.map((hunk) => hunk.be));
    const [ours, theirs] = [0, 1].map((side) => {
      const grown = members[side].reduce((sum, hunk) => sum + (hunk.e - hunk.s) - (hunk.be - hunk.bs), 0);
      const stretch: [number, number] = [from + shift[side], to + shift[side] + grown];
      shift[side] += grown;
      return stretch;
    });
    const kind: RegionKind = !members[1].length ? 'ours' : !members[0].length ? 'theirs' : 'both';
    regions.push({ kind, base: [from, to], ours, theirs });
  }
  return regions;
}

/** Tells `both` from `conflict`, which needs the lines: done apart so that `group` only deals with places. */
function settle(regions: Grouped[], oursLines: string[], theirsLines: string[]): Grouped[] {
  return regions.map((region) => {
    if (region.kind !== 'both') return region;
    const [mine, other] = [oursLines.slice(...region.ours), theirsLines.slice(...region.theirs)];
    const same = mine.length === other.length && mine.every((line, index) => line === other[index]);
    return same ? region : { ...region, kind: 'conflict' };
  });
}

/**
 * Where a place between two lines of a text is in another, given the hunks from the one to the other. A place inside
 * a hunk, or at a hunk that only adds lines, goes to its start when it starts a region and to its end when it ends
 * one: the region takes in what changed at its edges.
 */
export function mapBoundary(hunks: Hunk[], place: number, edge: 'start' | 'end'): number {
  let shift = 0;
  for (const hunk of hunks) {
    if (hunk.bs > place) break;
    if (hunk.bs === place && hunk.be > place) break;
    if (hunk.be < place || (hunk.be === place && hunk.bs < place)) {
      shift = hunk.e - hunk.be;
      continue;
    }
    return edge === 'start' ? hunk.s : hunk.e;
  }
  return place + shift;
}

interface Block {
  /** The line of its first marker and the one after its last, from 0. */
  from: number;
  to: number;
  ours: [number, number];
  theirs: [number, number];
  markers: number[];
}

const marks = (line: string, sign: string) => line.startsWith(sign.repeat(MARKER)) && (line.length === MARKER || line[MARKER] === ' ');

/** The conflicts git marked in the result. Markers that do not pair up are not taken for any. */
function markerBlocks(resultLines: string[]): Block[] {
  const found: Block[] = [];
  let open: { from: number; base?: number; middle?: number } | undefined;
  for (const [index, line] of resultLines.entries()) {
    if (marks(line, '<')) open = { from: index };
    else if (!open) continue;
    else if (marks(line, '|') && open.middle === undefined) open.base ??= index;
    else if (line === '='.repeat(MARKER) && open.middle === undefined) open.middle = index;
    else if (marks(line, '>') && open.middle !== undefined) {
      const markers = [open.from, ...(open.base === undefined ? [] : [open.base]), open.middle, index];
      found.push({ from: open.from, to: index + 1, ours: [open.from + 1, open.base ?? open.middle], theirs: [open.middle + 1, index], markers });
      open = undefined;
    }
  }
  return found;
}

function toHunk(chunk: DiffChunk): Hunk {
  const bs = chunk.leftCount > 0 ? chunk.leftStart - 1 : chunk.leftStart;
  const s = chunk.rightCount > 0 ? chunk.rightStart - 1 : chunk.rightStart;
  return { bs, be: bs + chunk.leftCount, s, e: s + chunk.rightCount };
}

function highlights(rows: ReturnType<typeof computeDiff>['rows']): LineHighlight[] {
  return rows.flatMap((row) =>
    row.right.kind === 'modified' && row.right.lineNumber !== undefined && row.right.highlights?.length
      ? [{ line: row.right.lineNumber, ranges: row.right.highlights }]
      : [],
  );
}

/** The lines of a text without what ends them; the end of the last line does not make one more. */
function lines(value: string): string[] {
  if (!value) return [];
  return (value.endsWith('\n') ? value.slice(0, -1) : value).split('\n');
}

function text(list: string[]): string {
  return list.length ? `${list.join('\n')}\n` : '';
}
