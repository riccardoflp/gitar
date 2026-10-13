import type { Resolution } from '../shared/protocol';

// Resolves the conflicts of a file that need no choice between the two sides. Git stops wherever both sides changed
// lines that touch; a good part of what it stops at is two changes that sit side by side, or the same lines spaced
// differently. What is written here never invents a line: every line of the result is a line of one of the two sides,
// as it is in the file, and a conflict that is not plainly one of the cases below is left exactly as git wrote it.

/** One stretch of lines that differs between two texts: `[bs, be)` of the first became `[s, e)` of the second. */
interface Hunk {
  bs: number;
  be: number;
  s: number;
  e: number;
}

/** Past this many differences two texts are not compared line by line: they are taken to differ from the first to the last. */
const MAX_EDITS = 1500;
/** Longer files are left alone. */
const MAX_LINES = 50_000;
const MARKER = 7;

/**
 * The stretches where two lists of lines differ, in order, by the shortest way from one to the other (Myers).
 * Lines are compared as numbers: `keys` gives the same number to the same line.
 */
export function diff(a: number[], b: number[]): Hunk[] {
  let start = 0;
  let endA = a.length;
  let endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (!n && !m) return [];
  const whole = [{ bs: start, be: endA, s: start, e: endB }];
  if (!n || !m) return whole;

  // The furthest point reached on each diagonal with d differences, for d from 0 up, until the end is reached.
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const trace: Int32Array[] = [];
  const v = new Int32Array(2 * max + 3);
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    // What was reached with one difference less, on the diagonals that can have been: all that the way back needs.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return whole;

  // Back from the end: each step is one line of `a` left out or one line of `b` put in.
  const hunks: Hunk[] = [];
  let x = n;
  let y = m;
  const edit = (ax: number, by: number, removed: boolean) => {
    const last = hunks[hunks.length - 1];
    const [bs, s] = [start + ax, start + by];
    // Steps come from the end to the start: one that touches the stretch found before it makes it longer.
    if (last && last.bs === bs + (removed ? 1 : 0) && last.s === s + (removed ? 0 : 1)) {
      last.bs = bs;
      last.s = s;
    } else {
      hunks.push({ bs, be: bs + (removed ? 1 : 0), s, e: s + (removed ? 0 : 1) });
    }
  };
  for (let d = found; d > 0; d--) {
    const reached = (k: number) => trace[d][k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && reached(k - 1) < reached(k + 1));
    const previousK = down ? k + 1 : k - 1;
    x = reached(previousK);
    y = x - previousK;
    // From there one line differs, and the lines after it up to where this step started are in both.
    edit(x, y, !down);
  }
  return hunks.reverse();
}

/**
 * The same, looked for from the end. Where lines repeat, as closing braces and empty lines do, there is more than one
 * shortest way from a list to another, and this one takes the others' last choice first: what comes out the same
 * from both does not hang on which of two lines alike was taken for which.
 */
export function diffBackward(a: number[], b: number[]): Hunk[] {
  const [n, m] = [a.length, b.length];
  return diff([...a].reverse(), [...b].reverse())
    .map((hunk) => ({ bs: n - hunk.be, be: n - hunk.bs, s: m - hunk.e, e: m - hunk.s }))
    .reverse();
}

type Differ = typeof diff;

/** Numbers for lines, the same for the same line, so that comparing two lines is comparing two numbers. */
function keys(): (line: string) => number {
  const known = new Map<string, number>();
  return (line) => {
    let key = known.get(line);
    if (key === undefined) known.set(line, (key = known.size));
    return key;
  };
}

/** A line without what ends it, which is how lines are compared: a file checked out with other line endings is the same file. */
const bare = (line: string) => line.replace(/\r?\n$|\r$/, '');
/** Without the spaces at its end too. */
const trimmed = (line: string) => bare(line).replace(/[ \t]+$/, '');
/** With every run of spaces and tabs counted as one, and none at its ends. */
const loose = (line: string) => bare(line).replace(/\s+/g, ' ').trim();

/** One list after another, however long: a list cannot be spread into the arguments of a call past a certain length. */
function append<T>(list: T[], more: T[]): void {
  for (const item of more) list.push(item);
}

const alike = (one: string[], other: string[], by: (line: string) => string) =>
  one.length === other.length && one.every((line, index) => by(line) === by(other[index]));

interface Merged {
  lines: string[];
  resolution: Resolution;
}

interface Met extends Merged {
  /** Whether changes of the two sides touched and differed, which is what makes git stop. */
  met: boolean;
}

interface Woven {
  lines: string[];
  /** Whether a difference in spaces alone was settled for one side. */
  spaces: boolean;
  /** The lines each side wrote in changes that were taken as its own, without what ends them. */
  written: Set<string>[];
  /** Whether a change of one side touched one of the other that was not the same. */
  met?: boolean;
}

const nothing = (): Set<string>[] => [new Set(), new Set()];

/** Whether a change of one side and a change of the other are about the same lines, so that one has to give way. */
function overlap(one: Hunk, two: Hunk): boolean {
  const [emptyOne, emptyTwo] = [one.bs === one.be, two.bs === two.be];
  // Two additions at the same place have no order of their own.
  if (emptyOne && emptyTwo) return one.bs === two.bs;
  // An addition right before or right after the lines the other side changed is beside them, not among them.
  if (emptyOne) return two.bs < one.bs && one.bs < two.be;
  if (emptyTwo) return one.bs < two.bs && two.bs < one.be;
  return one.bs < two.be && two.bs < one.be;
}

/** Whether they are that or next to each other, which is where git stops. */
const touch = (one: Hunk, two: Hunk) => one.bs <= two.be && two.bs <= one.be;

/** Of two changes that start at the same line, the one that adds lines before it comes first. */
const precedes = (one: Hunk, two: Hunk) => one.bs < two.bs || (one.bs === two.bs && one.bs === one.be && two.bs !== two.be);

/** Which side to take of two that changed the same lines, when that is no choice. */
function settle(before: string[], mine: string[], other: string[]): Woven | null {
  if (alike(mine, other, bare)) return { lines: mine, spaces: false, written: nothing() };
  // One side only touched the spaces at the end of the lines the other changed.
  if (alike(mine, before, trimmed)) return { lines: other, spaces: true, written: nothing() };
  if (alike(other, before, trimmed) || alike(mine, other, loose)) return { lines: mine, spaces: true, written: nothing() };
  return null;
}

/**
 * The changes of two sides to the same lines, each put where it was made, or null when two of them are about the same
 * lines and differ. With `near` the changes that touch are looked at together and taken apart at the lines the two
 * sides have alike, which is what tells a line both added from a line each added; without it they are taken as they are.
 */
function weave(base: string[], ours: string[], theirs: string[], near: boolean, differ: Differ): Woven | null {
  const key = keys();
  const number = (lines: string[]) => lines.map((line) => key(bare(line)));
  const texts = [ours, theirs];
  const hunks = texts.map((lines) => differ(number(base), number(lines)));
  const next = [0, 0];
  const at = [0, 0];
  const out: string[] = [];
  const written = nothing();
  let position = 0;
  let spaces = false;
  let met = false;
  const together = near ? touch : overlap;

  for (;;) {
    const [first, second] = [hunks[0][next[0]], hunks[1][next[1]]] as (Hunk | undefined)[];
    if (!first && !second) break;
    // The changes that have to be looked at together: the next one, and every one of either side that meets one of them.
    const group: Hunk[][] = [[], []];
    const lead = !second || (first && !precedes(second, first)) ? 0 : 1;
    group[lead].push(hunks[lead][next[lead]++]);
    for (let grown = true; grown; ) {
      grown = false;
      for (const side of [0, 1]) {
        const candidate = hunks[side][next[side]] as Hunk | undefined;
        if (candidate && group[1 - side].some((taken) => together(candidate, taken))) {
          group[side].push(candidate);
          next[side]++;
          grown = true;
        }
      }
    }
    const all = [...group[0], ...group[1]];
    const from = Math.min(...all.map((hunk) => hunk.bs));
    const to = Math.max(...all.map((hunk) => hunk.be));

    // The lines neither side changed, up to there: both sides have them, and ours are the ones written.
    append(out, ours.slice(at[0], at[0] + from - position));
    const starts = at.map((start) => start + from - position);
    // What each side has in place of those lines of the base.
    const slices = texts.map((lines, side) => {
      const grown = group[side].reduce((sum, hunk) => sum + (hunk.e - hunk.s) - (hunk.be - hunk.bs), 0);
      return lines.slice(starts[side], starts[side] + (to - from) + grown);
    });

    let part: Woven | null;
    if (!group[0].length || !group[1].length) {
      const side = group[0].length ? 0 : 1;
      part = { lines: slices[side], spaces: false, written: nothing() };
      for (const hunk of group[side]) for (const line of texts[side].slice(hunk.s, hunk.e)) part.written[side].add(bare(line));
    } else {
      const before = base.slice(from, to);
      if (!alike(slices[0], slices[1], bare)) met = true;
      const apart = near && !alike(slices[0], slices[1], bare) ? refine(base, from, to, group, starts, slices, differ) : null;
      part = apart ?? settle(before, slices[0], slices[1]);
    }
    if (!part) return null;
    append(out, part.lines);
    spaces ||= part.spaces;
    part.written.forEach((lines, side) => lines.forEach((line) => written[side].add(line)));
    starts.forEach((start, side) => (at[side] = start + slices[side].length));
    position = to;
  }
  append(out, ours.slice(at[0]));
  return { lines: out, spaces, written, met };
}

/**
 * Lines `from` to `to` of the base, which both sides changed into `slices`, taken apart at the lines the two sides
 * have alike there: those are written once, and what is between them is put together on its own. It takes knowing
 * which lines of the base each stretch they have alike stands for, and null is the answer when the two sides, each
 * compared with the base, do not agree on it.
 */
function refine(base: string[], from: number, to: number, group: Hunk[][], starts: number[], slices: string[][], differ: Differ): Woven | null {
  const key = keys();
  const [mine, other] = slices.map((lines) => lines.map((line) => key(bare(line))));
  const lines: string[] = [];
  const written = nothing();
  let spaces = false;
  let reached = from;
  let gap: string[][] = [[], []];
  let [i, j] = [0, 0];

  /**
   * Where in the base a line of a side starts, or ends: the least and the most it can be. A line the side left alone
   * is where it is. A line it wrote is somewhere among the lines it wrote over: after as many of them as it wrote
   * lines before this one, and anywhere when this one is the first.
   */
  const edge = (side: number, index: number, end: boolean): [number, number] => {
    const line = starts[side] + index;
    let shift = from - starts[side];
    for (const hunk of group[side]) {
      if (line < hunk.s) break;
      if (line < hunk.e) {
        const beside = end ? hunk.e - 1 - line : line - hunk.s;
        if (!beside) return [hunk.bs, hunk.be];
        const exact = end ? Math.max(hunk.be - beside, hunk.bs) : Math.min(hunk.bs + beside, hunk.be);
        return [exact, exact];
      }
      shift = hunk.be - hunk.e;
    }
    const exact = line + shift + (end ? 1 : 0);
    return [exact, exact];
  };
  /** Puts together what the two sides have between two stretches they have alike, over the lines of the base left to it. */
  const close = (until: number) => {
    const woven = weave(base.slice(reached, until), gap[0], gap[1], false, differ);
    if (!woven) return false;
    append(lines, woven.lines);
    spaces ||= woven.spaces;
    woven.written.forEach((own, side) => own.forEach((line) => written[side].add(line)));
    return true;
  };

  for (const hunk of [...differ(mine, other), null]) {
    const [endMine, endOther] = hunk ? [hunk.bs, hunk.s] : [mine.length, other.length];
    if (endMine > i) {
      // A stretch the two sides have alike: the lines of the base it stands for are the most both allow.
      const starting = [edge(0, i, false), edge(1, j, false)];
      const ending = [edge(0, endMine - 1, true), edge(1, endOther - 1, true)];
      const start = Math.max(starting[0][0], starting[1][0], reached);
      const end = Math.min(ending[0][1], ending[1][1]);
      if (start > Math.min(starting[0][1], starting[1][1]) || end < Math.max(ending[0][0], ending[1][0])) return null;
      if (start > end || !close(start)) return null;
      append(lines, slices[0].slice(i, endMine));
      reached = end;
      gap = [[], []];
    }
    if (hunk) {
      gap = [slices[0].slice(hunk.bs, hunk.be), slices[1].slice(hunk.s, hunk.e)];
      [i, j] = [hunk.be, hunk.e];
    }
  }
  return close(to) ? { lines, spaces, written } : null;
}

/** The two sides put together with the lines paired one way. */
function mergeWith(base: string[], ours: string[], theirs: string[], differ: Differ): Met | null {
  const woven = weave(base, ours, theirs, true, differ);
  if (!woven) return null;
  // The same line written by each side in a change of its own is one change read as two, or two that are one: either
  // way the lines of the base were paired with the wrong ones of a side, and the result would have that line twice.
  for (const line of woven.written[0]) if (woven.written[1].has(line)) return null;
  const { lines } = woven;
  const [mine, other] = [alike(lines, ours, bare), alike(lines, theirs, bare)];
  let resolution: Resolution;
  if (woven.spaces) resolution = 'whitespace';
  // The same lines on both sides, ended differently if at all.
  else if (mine && other) resolution = ours.join('') === theirs.join('') ? 'same' : 'whitespace';
  else resolution = mine || other ? 'oneSide' : 'separate';
  return { lines, resolution, met: woven.met === true };
}

const WAYS = [diff, diffBackward];

/**
 * The two sides of a stretch of a file put together, given what the stretch was before either changed it, or null
 * when that takes a choice. `base` is only compared with: the result is made of the lines of `ours` and `theirs`.
 * It is found twice, with the lines that repeat paired from the start and from the end, and has to be the same.
 */
export function merge(base: string[], ours: string[], theirs: string[]): Merged | null {
  const [one, two] = WAYS.map((differ) => mergeWith(base, ours, theirs, differ));
  return one && two && one.lines.join('') === two.lines.join('') ? { lines: one.lines, resolution: one.resolution } : null;
}

interface Block {
  /** Where its markers are among the lines of the file, the first and the one after the last. */
  from: number;
  to: number;
  ours: string[];
  theirs: string[];
  /** Markers inside it that make no sense, as when a side has a line of equal signs of its own. */
  broken: boolean;
}

const marks = (line: string, sign: string) => {
  const text = bare(line);
  return text.startsWith(sign.repeat(MARKER)) && (text.length === MARKER || text[MARKER] === ' ');
};

/** The conflicts git marked in a file, or null when the markers do not pair up. */
function blocks(lines: string[]): Block[] | null {
  const found: Block[] = [];
  let block: Block | null = null;
  let part: 'ours' | 'base' | 'theirs' = 'ours';
  for (const [index, line] of lines.entries()) {
    if (!block) {
      if (marks(line, '<')) {
        block = { from: index, to: index, ours: [], theirs: [], broken: false };
        part = 'ours';
      }
      continue;
    }
    if (marks(line, '>') && part === 'theirs') {
      block.to = index + 1;
      found.push(block);
      block = null;
    } else if (marks(line, '<')) {
      block.broken = true;
    } else if (marks(line, '|') && part === 'ours') {
      part = 'base';
    } else if (bare(line) === '='.repeat(MARKER)) {
      if (part === 'theirs') block.broken = true;
      part = 'theirs';
    } else if (part !== 'base') {
      block[part].push(line);
    }
  }
  return block ? null : found;
}

export interface Conflict {
  /** The line of the file its first marker is on, from 1. */
  line: number;
  /** How it is resolved, or null when it is left for a person. */
  resolution: Resolution | null;
}

export interface Resolved {
  /** The file with the conflicts that need no choice resolved, and the others as they were. */
  text: string;
  conflicts: Conflict[];
}

/** The file as each side of a conflict has it, whole. */
export interface Sides {
  ours: string;
  theirs: string;
}

const split = (text: string) => (text ? text.split(/(?<=\n)/) : []);

/**
 * Resolves what can be resolved of the conflicts marked in `text`, a file as git left it or as it was edited since.
 * `base` is the file before either side changed it: empty when both added it. With the file of each side in
 * `sides`, a conflict is resolved only where both really have the lines around it that the file says they share:
 * git also writes there the lines only one of them changed, and those are no ground to read what the other did.
 */
export function resolveConflicts(text: string, base: string, sides?: Sides): Resolved {
  // Each line with what ends it, so that putting them together again gives the file back.
  const lines = text.split(/(?<=\n)/);
  const found = blocks(lines);
  const untouched: Resolved = { text, conflicts: (found ?? []).map((block) => ({ line: block.from + 1, resolution: null })) };
  if (!found?.length || lines.length > MAX_LINES) return untouched;
  const baseLines = split(base);
  const real = sides && [split(sides.ours), split(sides.theirs)];
  if (baseLines.length > MAX_LINES || real?.some((side) => side.length > MAX_LINES)) return untouched;

  const [one, two] = WAYS.map((differ) => plan(lines, found, baseLines, real, differ));
  const out: string[] = [];
  const conflicts: Conflict[] = [];
  let written = 0;
  found.forEach((block, index) => {
    const conflict: Conflict = { line: block.from + 1, resolution: null };
    conflicts.push(conflict);
    const [first, second] = [one[index], two[index]];
    if (!first || !second) return;
    // The two may have looked as far as different lines around the conflict: over the same lines they have to say the same.
    const [start, end] = [Math.min(first.from, second.from), Math.max(first.to, second.to)];
    const over = (patch: Patch) => [...lines.slice(start, patch.from), ...patch.lines, ...lines.slice(patch.to, end)];
    const resolved = over(first);
    if (start < written || resolved.join('') !== over(second).join('')) return;
    conflict.resolution = first.resolution;
    append(out, lines.slice(written, start));
    append(out, resolved);
    written = end;
  });
  append(out, lines.slice(written));
  return { text: out.join(''), conflicts };
}

/** Lines of a file, from `from` up to `to`, and the lines to have in their place. */
interface Patch {
  from: number;
  to: number;
  lines: string[];
  resolution: Resolution;
}

/** What each conflict of a file resolves to, or null for the ones that take a choice, with its lines paired with the ones of the base by `differ`. */
function plan(lines: string[], found: Block[], baseLines: string[], real: string[][] | undefined, differ: Differ): (Patch | null)[] {
  // The file as each side would have it: what is outside the conflicts, which they share, and its own part of each.
  // `shared` says which line of the file, if any, a line of a side is: the lines outside the conflicts.
  const sides = [0, 1].map(() => ({ lines: [] as string[], shared: [] as number[], starts: [] as number[], ends: [] as number[] }));
  let at = 0;
  for (const block of found) {
    for (const side of sides) {
      for (let index = at; index < block.from; index++) {
        side.lines.push(lines[index]);
        side.shared.push(index);
      }
    }
    sides.forEach((side, index) => {
      const own = index ? block.theirs : block.ours;
      side.starts.push(side.lines.length);
      append(side.lines, own);
      for (let line = 0; line < own.length; line++) side.shared.push(-1);
      side.ends.push(side.lines.length);
    });
    at = block.to;
  }
  for (const side of sides) {
    for (let index = at; index < lines.length; index++) {
      side.lines.push(lines[index]);
      side.shared.push(index);
    }
  }

  // Which line of the base each line of a side is, or -1 for the lines the side changed.
  const key = keys();
  const number = (list: string[]) => list.map((line) => key(bare(line)));
  const baseKeys = number(baseLines);
  const realKeys = real?.map(number);
  const sideKeys = sides.map((side) => number(side.lines));
  /** Whether a side really has lines `from` to `to` of what it is taken to have, one after the other: at its start or at its end when so asked. */
  const has = (side: number, from: number, to: number, first: boolean, last: boolean) => {
    if (!realKeys) return true;
    const [file, wanted] = [realKeys[side], sideKeys[side]];
    const length = to - from;
    for (let at = 0; at + length <= file.length; at++) {
      if (last && at + length !== file.length) continue;
      let index = 0;
      while (index < length && file[at + index] === wanted[from + index]) index++;
      if (index === length) return true;
      if (first) break;
    }
    return false;
  };
  const matches = sides.map((side) => {
    const match = new Int32Array(side.lines.length).fill(-1);
    let [inBase, inSide] = [0, 0];
    const pair = (untilBase: number) => {
      while (inBase < untilBase) match[inSide++] = inBase++;
    };
    for (const hunk of differ(baseKeys, number(side.lines))) {
      pair(hunk.bs);
      inBase = hunk.be;
      inSide = hunk.e;
    }
    pair(baseLines.length);
    return match;
  });

  /**
   * How far a conflict is from the nearest line, before it (`step` -1) or after it, that both sides have and that is
   * the same line of the base for both: where the two sides are known to be at the same place. Null when another
   * conflict comes first. At the ends of the file the two sides are at the same place by themselves.
   */
  const anchor = (starts: number[], step: 1 | -1): { distance: number; base: number } | null => {
    for (let distance = step < 0 ? 1 : 0; ; distance++) {
      const [mine, other] = starts.map((start) => start + step * distance);
      if (mine < 0 || other < 0) return { distance, base: -1 };
      if (mine >= sides[0].lines.length || other >= sides[1].lines.length) return { distance, base: baseLines.length };
      if (sides[0].shared[mine] < 0 || sides[1].shared[other] < 0) return null;
      if (matches[0][mine] >= 0 && matches[0][mine] === matches[1][other]) return { distance, base: matches[0][mine] };
    }
  };

  return found.map((block, index) => {
    if (block.broken) return null;
    const up = anchor(
      sides.map((side) => side.starts[index]),
      -1,
    );
    const down = anchor(
      sides.map((side) => side.ends[index]),
      1,
    );
    if (!up || !down || up.base >= down.base) return null;
    // Those two lines and what is between them, in the file of each side: the start and the end of a file are such lines too.
    const [first, last] = [up.base < 0, down.base >= baseLines.length];
    const there = sides.every((side, which) =>
      has(which, side.starts[index] - up.distance + (first ? 1 : 0), side.ends[index] + down.distance + (last ? 0 : 1), first, last),
    );
    if (!there) return null;
    // The conflict with the lines around it up to those two places, as each side has it and as it was before.
    const [ours, theirs] = sides.map((side) => side.lines.slice(side.starts[index] - up.distance + 1, side.ends[index] + down.distance));
    const merged = mergeWith(baseLines.slice(up.base + 1, down.base), ours, theirs, differ);
    if (!merged) return null;
    // Git stopped here because changes of the two sides touched. A pairing of the lines by which they do not is not
    // the one git made, and what it resolves to is not what git stopped for. Sides that differ in their line endings
    // alone are the exception: no change of lines is seen in those.
    if (!merged.met && !alike(block.ours, block.theirs, bare)) return null;
    return { from: block.from - (up.distance - 1), to: block.to + down.distance, lines: merged.lines, resolution: merged.resolution };
  });
}
