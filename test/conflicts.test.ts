import { describe, expect, it } from 'vitest';
import { applyReplacements, conflictCount, diff, diffBackward, merge, resolveConflicts } from '../src/git/conflicts';

/** Lines as they are in a file: each with its line break. */
const lines = (...texts: string[]) => texts.map((text) => `${text}\n`);
const file = (...texts: string[]) => lines(...texts).join('');
/** A conflict as git marks it, with the common ancestor between the two sides when `base` is given. */
const conflict = (ours: string[], theirs: string[], base?: string[]) => [
  '<<<<<<< HEAD',
  ...ours,
  ...(base ? ['||||||| 1a2b3c4', ...base] : []),
  '=======',
  ...theirs,
  '>>>>>>> feature',
];

/** Numbers that are the same each time, for cases made at random. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('the differences between two lists of lines', () => {
  const ranges = (a: number[], b: number[]) => diff(a, b).map((hunk) => `${hunk.bs}-${hunk.be}>${hunk.s}-${hunk.e}`);

  it('finds none between two lists that are the same, and one for a list against none', () => {
    expect(ranges([1, 2, 3], [1, 2, 3])).toEqual([]);
    expect(ranges([], [])).toEqual([]);
    expect(ranges([], [1, 2])).toEqual(['0-0>0-2']);
    expect(ranges([1, 2], [])).toEqual(['0-2>0-0']);
  });

  it('tells lines added, removed and changed, each where it is', () => {
    expect(ranges([1, 2, 3], [1, 9, 2, 3])).toEqual(['1-1>1-2']);
    expect(ranges([1, 2, 3], [1, 3])).toEqual(['1-2>1-1']);
    expect(ranges([1, 2, 3], [1, 9, 3])).toEqual(['1-2>1-2']);
    expect(ranges([1, 2, 3, 4, 5], [0, 1, 2, 4, 5, 6])).toEqual(['0-0>0-1', '2-3>3-3', '5-5>5-6']);
    expect(ranges([1, 2, 3, 4], [5, 6, 7])).toEqual(['0-4>0-3']);
  });

  it('gives changes that lead from the first list to the second, whatever the lists', () => {
    const next = random(7);
    for (let round = 0; round < 300; round++) {
      const list = (length: number) => Array.from({ length }, () => Math.floor(next() * 6));
      const [a, b] = [list(Math.floor(next() * 40)), list(Math.floor(next() * 40))];
      const hunks = diff(a, b);
      const rebuilt: number[] = [];
      let [inA, inB] = [0, 0];
      for (const hunk of hunks) {
        // In order, apart, and never empty on both sides.
        expect(hunk.bs).toBeGreaterThanOrEqual(inA);
        expect(hunk.be - hunk.bs + hunk.e - hunk.s).toBeGreaterThan(0);
        // What is between two changes is the same in both lists.
        expect(a.slice(inA, hunk.bs)).toEqual(b.slice(inB, hunk.s));
        rebuilt.push(...a.slice(inA, hunk.bs), ...b.slice(hunk.s, hunk.e));
        [inA, inB] = [hunk.be, hunk.e];
      }
      rebuilt.push(...a.slice(inA));
      expect(rebuilt, `${a} to ${b}`).toEqual(b);
    }
  });

  it('finds them from the end too, where it takes the other of two lines alike', () => {
    const backward = (a: number[], b: number[]) => diffBackward(a, b).map((hunk) => `${hunk.bs}-${hunk.be}>${hunk.s}-${hunk.e}`);
    // One of two lines alike is gone: the second, or the first.
    expect(ranges([1, 7, 7, 2], [1, 7, 2])).toEqual(['2-3>2-2']);
    expect(backward([1, 7, 7, 2], [1, 7, 2])).toEqual(['1-2>1-1']);
    expect(backward([1, 2, 3], [1, 9, 3])).toEqual(['1-2>1-2']);
    expect(backward([], [1])).toEqual(['0-0>0-1']);
    const next = random(13);
    for (let round = 0; round < 200; round++) {
      const list = (length: number) => Array.from({ length }, () => Math.floor(next() * 5));
      const [a, b] = [list(Math.floor(next() * 30)), list(Math.floor(next() * 30))];
      const rebuilt: number[] = [];
      let inA = 0;
      for (const hunk of diffBackward(a, b)) {
        rebuilt.push(...a.slice(inA, hunk.bs), ...b.slice(hunk.s, hunk.e));
        inA = hunk.be;
      }
      rebuilt.push(...a.slice(inA));
      expect(rebuilt, `${a} to ${b}`).toEqual(b);
      // As short a way as the other.
      const size = (hunks: { bs: number; be: number; s: number; e: number }[]) => hunks.reduce((sum, hunk) => sum + hunk.be - hunk.bs + hunk.e - hunk.s, 0);
      expect(size(diffBackward(a, b))).toBe(size(diff(a, b)));
    }
  });

  it('gives up on two long lists with little in common, and calls them different from the first line that is to the last', () => {
    const a = Array.from({ length: 4000 }, (_, index) => index);
    const b = Array.from({ length: 4000 }, (_, index) => (index === 0 || index === 3999 ? index : -index));
    expect(ranges(a, b)).toEqual(['1-3999>1-3999']);
  });
});

describe('two sides of some lines put together', () => {
  const merged = (base: string[], ours: string[], theirs: string[]) => {
    const result = merge(lines(...base), lines(...ours), lines(...theirs));
    return result && [result.lines.map((line) => line.replace(/\n$/, '')).join(), result.resolution];
  };

  it('takes both changes when they are of lines next to each other', () => {
    expect(merged(['a', 'b', 'c'], ['A', 'b', 'c'], ['a', 'B', 'c'])).toEqual(['A,B,c', 'separate']);
    expect(merged(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd'], ['A', 'b', 'C', 'D'])).toEqual(['A,B,C,D', 'separate']);
    // A line removed beside a line changed.
    expect(merged(['a', 'b', 'c'], ['a', 'c'], ['A', 'b', 'c'])).toEqual(['A,c', 'separate']);
    expect(merged(['a', 'b', 'c'], ['a', 'B', 'c'], ['a', 'b'])).toEqual(['a,B', 'separate']);
  });

  it('puts lines one side added before or after the lines the other changed, where they were added', () => {
    expect(merged(['a', 'b'], ['a', 'new', 'b'], ['a', 'B'])).toEqual(['a,new,B', 'separate']);
    expect(merged(['a', 'b'], ['A', 'b'], ['a', 'new', 'b'])).toEqual(['A,new,b', 'separate']);
    expect(merged(['a', 'b'], ['a', 'b', 'end'], ['a', 'B'])).toEqual(['a,B,end', 'separate']);
    expect(merged(['a', 'b'], ['first', 'a', 'b'], ['A', 'b'])).toEqual(['first,A,b', 'separate']);
  });

  it('leaves to a person what both sides changed differently', () => {
    expect(merged(['a'], ['ours'], ['theirs'])).toBeNull();
    expect(merged(['a', 'b', 'c'], ['a', 'ours', 'c'], ['a', 'theirs', 'c'])).toBeNull();
    // Lines added by both at the same place have no order of their own.
    expect(merged(['a', 'b'], ['a', 'ours', 'b'], ['a', 'theirs', 'b'])).toBeNull();
    expect(merged([], ['ours'], ['theirs'])).toBeNull();
    // Lines one side removed and the other changed.
    expect(merged(['a', 'b', 'c'], ['a', 'c'], ['a', 'B', 'c'])).toBeNull();
    // Lines one side added among the ones the other rewrote.
    expect(merged(['a', 'b', 'c'], ['a', 'new', 'b', 'c'], ['A', 'B', 'c'])).toBeNull();
    // One change of a side that is next to one of the other and over another.
    expect(merged(['a', 'b', 'c'], ['A', 'b', 'C'], ['a', 'B', 'see'])).toBeNull();
  });

  it('takes once what both sides did the same', () => {
    expect(merged(['a', 'b'], ['a', 'B'], ['a', 'B'])).toEqual(['a,B', 'same']);
    expect(merged(['a'], ['a', 'new'], ['a', 'new'])).toEqual(['a,new', 'same']);
    expect(merged([], ['new'], ['new'])).toEqual(['new', 'same']);
    // The same here, and something else there.
    expect(merged(['a', 'b', 'c'], ['A', 'B', 'c'], ['A', 'b', 'c'])).toEqual(['A,B,c', 'oneSide']);
    expect(merged(['a', 'b', 'c'], ['A', 'B', 'c'], ['A', 'b', 'C'])).toEqual(['A,B,C', 'separate']);
    expect(merged(['a', 'b', 'c', 'd'], ['A', 'b', 'c', 'D'], ['A', 'b', 'C', 'd'])).toEqual(['A,b,C,D', 'separate']);
  });

  it('writes once a line both sides added, also among lines each of them changed', () => {
    // Taken one by one these changes would write the new line twice.
    expect(merged(['a', 'b'], ['new', 'A', 'b'], ['new', 'a', 'B'])).toEqual(['new,A,B', 'separate']);
    expect(merged(['a', 'b'], ['A', 'new', 'b'], ['a', 'new', 'B'])).toEqual(['A,new,B', 'separate']);
    expect(merged(['a', 'b'], ['A', 'b', 'new'], ['a', 'B', 'new'])).toEqual(['A,B,new', 'separate']);
    expect(merged(['a', 'b', 'c'], ['A', 'new', 'more', 'b', 'c'], ['a', 'new', 'more', 'B', 'c'])).toEqual(['A,new,more,B,c', 'separate']);
    // And a line both changed the same way, beside one that only one of them changed.
    expect(merged(['top', 'a', 'b'], ['TOP', 'A', 'b'], ['TOP', 'a', 'B'])).toEqual(['TOP,A,B', 'separate']);
    expect(merged(['a', 'b', 'end'], ['A', 'b', 'END'], ['a', 'B', 'END'])).toEqual(['A,B,END', 'separate']);
    // A line one removed above one both changed.
    expect(merged(['a', 'b', 'c'], ['a', 'B', 'c'], ['B', 'c'])).toEqual(['B,c', 'oneSide']);
  });

  it('does not take a line one side removed for one both rewrote', () => {
    // Both wrote the first line anew; one then removed the second, which the other changed.
    expect(merged(['p', 'q'], ['X'], ['X', 'Q'])).toBeNull();
    expect(merged(['p', 'q'], ['X', 'Q'], ['X'])).toBeNull();
    expect(merged(['p', 'q'], ['P'], ['Q', 'P'])).toBeNull();
    // What both have alike, around what each has of its own.
    expect(merged(['a'], ['new', 'ours'], ['new', 'theirs'])).toBeNull();
    expect(merged([], ['new', 'ours', 'end'], ['new', 'theirs', 'end'])).toBeNull();
  });

  it('leaves to a person what lines that repeat let be read in more than one way', () => {
    // Each side has a new line the other has too, around a brace that may be the one of the base or not: taken as
    // lines each added on its side of that brace, the new line would be there twice.
    expect(merged(['}'], ['} ours', 'new', '}'], ['}', 'new', '} theirs'])).toBeNull();
    // One of two lines alike is gone on one side, and one of them is changed on the other: the same one, or the other.
    expect(merged(['end', 'end'], ['end'], ['END', 'end'])).toBeNull();
    expect(merged(['end', 'end'], ['end'], ['end', 'END'])).toBeNull();
    // Lines that repeat are no trouble where they can only be read one way.
    expect(merged(['}', 'a', '}', 'b', '}'], ['}', 'A', '}', 'b', '}'], ['}', 'a', '}', 'B', '}'])).toEqual(['},A,},B,}', 'separate']);
    expect(merged(['', 'a', 'b', ''], ['', 'A', 'b', ''], ['', 'a', 'B', ''])).toEqual([',A,B,', 'separate']);
  });

  it('takes the side that changed something when the other is as it was', () => {
    expect(merged(['a', 'b'], ['a', 'b'], ['a', 'B'])).toEqual(['a,B', 'oneSide']);
    expect(merged(['a', 'b'], ['A'], ['a', 'b'])).toEqual(['A', 'oneSide']);
  });

  it('takes the current side of two that differ only in how their lines are spaced', () => {
    expect(merged(['x=1'], ['x = 2'], ['x  =  2'])).toEqual(['x = 2', 'whitespace']);
    expect(merged(['if (a) {', 'b();', '}'], ['if (a) {', '  c();', '}'], ['if (a) {', '\tc();', '}'])).toEqual(['if (a) {,  c();,}', 'whitespace']);
    // Not when the words differ too, nor when a space parts what was one word.
    expect(merged(['x=1'], ['x = 2'], ['x=2'])).toBeNull();
    expect(merged(['x=1'], ['x = 2'], ['x = 3'])).toBeNull();
  });

  it('lets a real change win over spaces left or removed at the end of the same lines', () => {
    expect(merged(['a', 'b'], ['a  ', 'b\t'], ['A', 'B'])).toEqual(['A,B', 'whitespace']);
    expect(merged(['a  ', 'b'], ['A', 'b'], ['a', 'b'])).toEqual(['A,b', 'whitespace']);
    // Spaces at the start of a line can be what the line means: those are a change like any other.
    expect(merged(['a', 'b'], ['  a', 'b'], ['A', 'b'])).toBeNull();
  });

  it('compares lines without what ends them, and writes them with it', () => {
    const result = merge(['a\n', 'b\n', 'c\n'], ['A\r\n', 'b\r\n', 'c\r\n'], ['a\r\n', 'B\r\n', 'c']);
    expect(result).toEqual({ lines: ['A\r\n', 'B\r\n', 'c\r\n'], resolution: 'separate' });
    // Two sides that are the same lines with other endings are the current side.
    expect(merge(['a\n', 'b\n'], ['a\r\n', 'b\r\n'], ['a\n', 'b\n'])).toEqual({ lines: ['a\r\n', 'b\r\n'], resolution: 'whitespace' });
  });

  it('never writes anything but what the two sides did, whatever they did, and puts most of it together', () => {
    const next = random(23);
    let done = 0;
    const rounds = 2000;
    for (let round = 0; round < rounds; round++) {
      const base = Array.from({ length: 1 + Math.floor(next() * 10) }, (_, index) => `line ${index}`);
      const [ours, theirs, expected]: string[][] = [[], [], []];
      // Each line is left alone, changed or removed by one side, or by both the same way; then a line may be added after it.
      base.forEach((line, index) => {
        const roll = next();
        const [mine, other] =
          roll < 0.35
            ? [line, line]
            : roll < 0.5
              ? [`${line} ours`, line]
              : roll < 0.65
                ? [line, `${line} theirs`]
                : roll < 0.72
                  ? [null, line]
                  : roll < 0.79
                    ? [line, null]
                    : roll < 0.93
                      ? [`${line} both`, `${line} both`]
                      : [null, null];
        if (mine !== null) ours.push(mine);
        if (other !== null) theirs.push(other);
        if (mine !== null && other !== null) expected.push(mine === line ? other : mine);
        const added = next();
        if (added < 0.08) [ours, expected].forEach((list) => list.push(`added ${index} ours`));
        else if (added < 0.16) [theirs, expected].forEach((list) => list.push(`added ${index} theirs`));
        else if (added < 0.26) [ours, theirs, expected].forEach((list) => list.push(`added ${index} both`));
      });
      const result = merged(base, ours, theirs);
      if (!result) continue;
      done++;
      expect(result[0], `${base} / ${ours} / ${theirs}`).toBe(expected.join());
    }
    expect(done).toBeGreaterThan(rounds / 2);
  });

  it('puts together what real changes it can, each line of the base changed by one side or by none', () => {
    const next = random(11);
    for (let round = 0; round < 300; round++) {
      const base = Array.from({ length: 1 + Math.floor(next() * 14) }, (_, index) => `line ${index}`);
      const [ours, theirs, expected]: string[][] = [[], [], []];
      for (const line of base) {
        const roll = next();
        // Left alone, changed by one side, or removed by one side.
        const [mine, other] = roll < 0.4 ? [line, line] : roll < 0.6 ? [`${line} ours`, line] : roll < 0.8 ? [line, `${line} theirs`] : roll < 0.9 ? [null, line] : [line, null];
        if (mine !== null) ours.push(mine);
        if (other !== null) theirs.push(other);
        if (mine !== null && other !== null) expected.push(mine === line ? other : mine);
      }
      const result = merged(base, ours, theirs);
      expect(result?.[0], `${base} / ${ours} / ${theirs}`).toBe(expected.join());
    }
  });
});

describe('the conflicts of a file', () => {
  const resolved = (text: string[], base: string[]) => {
    const result = resolveConflicts(file(...text), file(...base));
    return { text: result.text, how: result.conflicts.map((found) => found.resolution), at: result.conflicts.map((found) => found.line) };
  };

  it('resolves a conflict between changes to lines next to each other, as git marks it', () => {
    const text = ['top', ...conflict(['A', 'b'], ['a', 'B']), 'c', 'd'];
    expect(resolved(text, ['top', 'a', 'b', 'c', 'd'])).toEqual({ text: file('top', 'A', 'B', 'c', 'd'), how: ['separate'], at: [2] });
    // And with the common ancestor in the file, as some like it marked.
    const three = ['top', ...conflict(['A', 'b'], ['a', 'B'], ['a', 'b']), 'c', 'd'];
    expect(resolved(three, ['top', 'a', 'b', 'c', 'd']).text).toBe(file('top', 'A', 'B', 'c', 'd'));
  });

  it('resolves the ones that need no choice and leaves the others exactly as they were', () => {
    const hard = conflict(['ours'], ['theirs']);
    const text = ['one', ...conflict(['A', 'b'], ['a', 'B']), 'two', ...hard, 'three', ...conflict(['x = 1'], ['x  =  1']), 'four'];
    const base = ['one', 'a', 'b', 'two', 'old', 'three', 'x=0', 'four'];
    expect(resolved(text, base)).toEqual({
      text: file('one', 'A', 'B', 'two', ...hard, 'three', 'x = 1', 'four'),
      how: ['separate', null, 'whitespace'],
      at: [2, 10, 16],
    });
  });

  it('resolves a conflict at the very start of a file and one at its very end', () => {
    const text = [...conflict(['A', 'b'], ['a', 'B']), 'mid', ...conflict(['Y', 'z'], ['y', 'Z'])];
    expect(resolved(text, ['a', 'b', 'mid', 'y', 'z'])).toEqual({ text: file('A', 'B', 'mid', 'Y', 'Z'), how: ['separate', 'separate'], at: [1, 9] });
    // A whole file added by both sides, spaced differently.
    expect(resolved(conflict(['a = 1', 'b = 2'], ['a  =  1', 'b =\t2']), [])).toMatchObject({ text: file('a = 1', 'b = 2'), how: ['whitespace'] });
    expect(resolveConflicts(file(...conflict(['a = 1'], ['  a = 1  '])), '')).toMatchObject({ text: file('a = 1') });
  });

  it('keeps what was changed by hand anywhere else in the file', () => {
    const text = ['top, edited by hand', ...conflict(['A', 'b'], ['a', 'B']), 'c', 'a line typed in', 'd'];
    expect(resolved(text, ['top', 'a', 'b', 'c', 'd']).text).toBe(file('top, edited by hand', 'A', 'B', 'c', 'a line typed in', 'd'));
  });

  it('looks past the lines both sides added around a conflict, and keeps them', () => {
    // Git leaves out of a conflict the lines its two sides begin or end with alike, also when they are new.
    const text = ['x', 'new in both', ...conflict(['A', 'b'], ['a', 'B']), 'also new in both', 'y'];
    expect(resolved(text, ['x', 'a', 'b', 'y'])).toEqual({ text: file('x', 'new in both', 'A', 'B', 'also new in both', 'y'), how: ['separate'], at: [3] });
    // Around a real conflict they change nothing.
    const hard = ['x', 'new in both', ...conflict(['ours'], ['theirs']), 'y'];
    expect(resolved(hard, ['x', 'y'])).toEqual({ text: file(...hard), how: [null], at: [3] });
  });

  it('leaves alone two conflicts with nothing certain between them', () => {
    // The line between them is new: what is before it and what is after it could be one change or two.
    const text = ['x', ...conflict(['A', 'b'], ['a', 'B']), 'new in both', ...conflict(['C', 'd'], ['c', 'D']), 'y'];
    expect(resolved(text, ['x', 'a', 'b', 'c', 'd', 'y'])).toEqual({ text: file(...text), how: [null, null], at: [2, 10] });
    // With a line of the base between them each is on its own.
    const apart = ['x', ...conflict(['A', 'b'], ['a', 'B']), 'mid', ...conflict(['C', 'd'], ['c', 'D']), 'y'];
    expect(resolved(apart, ['x', 'a', 'b', 'mid', 'c', 'd', 'y']).text).toBe(file('x', 'A', 'B', 'mid', 'C', 'D', 'y'));
  });

  it('writes a file checked out with other line endings as it is, and compares it as if it were not', () => {
    const windows = (...texts: string[]) => texts.map((text) => `${text}\r\n`).join('');
    const text = windows('top', ...conflict(['A', 'b'], ['a', 'B']), 'c');
    expect(resolveConflicts(text, file('top', 'a', 'b', 'c'))).toMatchObject({ text: windows('top', 'A', 'B', 'c'), conflicts: [{ line: 2, resolution: 'separate' }] });
    // A last line without a line break stays without one.
    expect(resolveConflicts(`${file(...conflict(['A', 'b'], ['a', 'B']))}end`, 'a\nb\nend').text).toBe('A\nB\nend');
  });

  it('does not touch a file whose markers do not pair up, nor a conflict with markers inside it', () => {
    const open = file('a', '<<<<<<< HEAD', 'ours', '=======', 'theirs');
    expect(resolveConflicts(open, 'a\n')).toEqual({ text: open, conflicts: [] });
    const never = file('a', '<<<<<<< HEAD', 'ours', '>>>>>>> feature', 'b');
    expect(resolveConflicts(never, 'a\nb\n')).toEqual({ text: never, conflicts: [] });
    // A side with a line of equal signs of its own, as under a title: which line parts the sides cannot be told.
    const title = ['top', ...conflict(['Title', '=======', 'b'], ['Title', '=======', 'B']), 'c', ...conflict(['Y', 'z'], ['y', 'Z']), 'end'];
    expect(resolved(title, ['top', 'Title', '=======', 'b', 'c', 'y', 'z', 'end'])).toMatchObject({ how: [null, 'separate'] });
    // No markers at all, or what only looks like them.
    expect(resolveConflicts('plain\n', 'plain\n')).toEqual({ text: 'plain\n', conflicts: [] });
    const look = file('<<<<<<<HEAD', '=======', '>>>>>>>x', '<<<<<<<<< nine', '=====');
    expect(resolveConflicts(look, '')).toEqual({ text: look, conflicts: [] });
  });

  it('resolves only what git would have stopped for: changes of the two sides that touch', () => {
    // Markers written by hand around changes two lines apart, which git merges by itself.
    const apart = ['top', ...conflict(['A', 'b', 'c'], ['a', 'b', 'C']), 'end'];
    expect(resolved(apart, ['top', 'a', 'b', 'c', 'end'])).toEqual({ text: file(...apart), how: [null], at: [2] });
    // And around a change of one side alone.
    const one = ['top', ...conflict(['A'], ['a']), 'end'];
    expect(resolved(one, ['top', 'a', 'end'])).toEqual({ text: file(...one), how: [null], at: [2] });
    // Two sides that are the same lines ended differently are what git stops for when it is not told to see past that.
    const endings = `top\n<<<<<<< HEAD\na\r\n=======\na\n>>>>>>> feature\nend\n`;
    expect(resolveConflicts(endings, 'top\na\nend\n')).toMatchObject({ text: 'top\na\r\nend\n', conflicts: [{ line: 2, resolution: 'whitespace' }] });
  });

  it('leaves alone a conflict that reads differently with the lines that repeat paired another way', () => {
    // One side removed one of two lines alike, the other changed one of them. Read from the top the other added a
    // line and removed the same one; read from the bottom it changed the one that was removed.
    const base = ['top', 'end', 'end', 'bottom'];
    const text = ['top', ...conflict([], ['end, theirs']), 'end', 'bottom'];
    const sides = { ours: file('top', 'end', 'bottom'), theirs: file('top', 'end, theirs', 'end', 'bottom') };
    expect(resolveConflicts(file(...text), file(...base), sides)).toMatchObject({ text: file(...text), conflicts: [{ line: 2, resolution: null }] });
    expect(resolved(text, base)).toEqual({ text: file(...text), how: [null], at: [2] });
  });

  it('with the files of the two sides, resolves a conflict only between lines both of them have', () => {
    const base = ['top', 'a', 'b', 'mid', 'c', 'end'];
    const sides = { ours: file('top', 'A', 'b', 'mid', 'c', 'end'), theirs: file('top', 'a', 'B', 'mid', 'c', 'end') };
    const text = ['top', ...conflict(['A', 'b'], ['a', 'B']), 'mid', 'c', 'end'];
    expect(resolveConflicts(file(...text), file(...base), sides).text).toBe(file('top', 'A', 'B', 'mid', 'c', 'end'));
    // A line typed further down is kept, and is in no one's way.
    const typed = [...text.slice(0, -1), 'typed by hand', 'end'];
    expect(resolveConflicts(file(...typed), file(...base), sides).text).toBe(file('top', 'A', 'B', 'mid', 'c', 'typed by hand', 'end'));
    // The line above the conflict changed by hand is not what either side has there: the conflict is left to who changed it.
    const edited = ['top, edited', ...text.slice(1)];
    expect(resolveConflicts(file(...edited), file(...base), sides)).toMatchObject({ text: file(...edited), conflicts: [{ line: 2, resolution: null }] });

    // Git writes around a conflict the lines only one side changed too. Here one side moved an empty line above
    // "moved", and the other changed "moved" where it was: the line after the conflict is not one the other side has.
    const moved = {
      base: file('top', 'moved', '', 'end'),
      ours: file('top', '', 'moved', 'end'),
      theirs: file('top', '', 'moved, theirs', 'more', '', 'end'),
    };
    const marked = ['top', ...conflict([], ['', 'moved, theirs', 'more']), '', 'moved', 'end'];
    expect(resolveConflicts(file(...marked), moved.base, moved)).toMatchObject({ text: file(...marked), conflicts: [{ line: 2, resolution: null }] });

    // At the two ends of a file the lines both have are its first and its last.
    const ends = { ours: file('A', 'b'), theirs: file('a', 'B') };
    expect(resolveConflicts(file(...conflict(['A', 'b'], ['a', 'B'])), file('a', 'b'), ends).text).toBe(file('A', 'B'));
    expect(resolveConflicts(file(...conflict(['A', 'b'], ['a', 'B'])), file('a', 'b'), { ours: file('A', 'b', 'more'), theirs: ends.theirs }).conflicts[0].resolution).toBeNull();
    // A file checked out with other line endings than the ones it is kept with is the same file.
    const windows = file(...text).replaceAll('\n', '\r\n');
    expect(resolveConflicts(windows, file(...base), sides).text).toBe(file('top', 'A', 'B', 'mid', 'c', 'end').replaceAll('\n', '\r\n'));
  });

  it('is not fooled by lines that repeat, such as the braces that close every block', () => {
    const base = ['function a() {', '  one();', '  two();', '}', '', 'function b() {', '  one();', '  two();', '}'];
    const text = [
      'function a() {',
      '  one();',
      '  two();',
      '}',
      '',
      'function b() {',
      ...conflict(['  ONE();', '  two();'], ['  one();', '  TWO();']),
      '}',
    ];
    expect(resolved(text, base).text).toBe(file('function a() {', '  one();', '  two();', '}', '', 'function b() {', '  ONE();', '  TWO();', '}'));
  });
});

describe('the resolution of each conflict, to look at before it is written', () => {
  const hard = conflict(['ours'], ['theirs']);
  const text = ['one', ...conflict(['A', 'b'], ['a', 'B']), 'two', ...hard, 'three', ...conflict(['x = 1'], ['x  =  1']), 'four'];
  const base = ['one', 'a', 'b', 'two', 'old', 'three', 'x=0', 'four'];

  it('says which lines each resolution replaces, and puts back the whole file when they are all taken', () => {
    const { conflicts } = resolveConflicts(file(...text), file(...base));
    expect(conflicts.map(({ from, to }) => [from, to])).toEqual([
      [1, 8],
      [9, 14],
      [15, 20],
    ]);
    expect(conflicts.map((found) => found.patch)).toEqual([{ from: 1, to: 8, text: file('A', 'B') }, null, { from: 15, to: 20, text: file('x = 1') }]);
    const patches = conflicts.flatMap((found) => found.patch ?? []);
    expect(applyReplacements(file(...text), patches)).toBe(resolveConflicts(file(...text), file(...base)).text);
  });

  it('takes some of the resolutions only, and refuses two for the same lines', () => {
    const { conflicts } = resolveConflicts(file(...text), file(...base));
    const last = conflicts[2].patch!;
    expect(applyReplacements(file(...text), [last])).toBe(file('one', ...conflict(['A', 'b'], ['a', 'B']), 'two', ...hard, 'three', 'x = 1', 'four'));
    // A resolution of the conflict left for a person, as a language model would propose it.
    const chosen = { from: conflicts[1].from, to: conflicts[1].to, text: file('ours and theirs') };
    expect(applyReplacements(file(...text), [last, chosen])).toBe(file('one', ...conflict(['A', 'b'], ['a', 'B']), 'two', 'ours and theirs', 'three', 'x = 1', 'four'));
    expect(() => applyReplacements(file(...text), [chosen, { ...chosen, text: '' }])).toThrow('same lines');
    expect(conflictCount(applyReplacements(file(...text), [last, chosen]))).toBe(1);
    expect(conflictCount(file(...text))).toBe(3);
  });

  it('tells what each side and the base have around a conflict, from the sides or from the markers', () => {
    const { conflicts } = resolveConflicts(file(...text), file(...base));
    expect(conflicts[1].stretch).toEqual({ base: file('old'), ours: file('ours'), theirs: file('theirs') });
    // With a conflict right after another, the base is only known when git wrote it between the markers.
    const close = [...conflict(['A'], ['B']), ...conflict(['C'], ['D'], ['c'])];
    const found = resolveConflicts(file(...close), file('x', 'c')).conflicts;
    expect(found.map((each) => each.stretch)).toEqual([null, { base: file('c'), ours: file('C'), theirs: file('D') }]);
  });
});
