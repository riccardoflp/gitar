import * as assert from 'node:assert/strict';
import { test } from 'vitest';
import { computeDiff } from '../../src/flow/diff/computeDiff';
import { unchangedRegions } from '../../src/flow/diff/unchanged';

function lines(from: number, to: number, mark?: (n: number) => string): string {
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    out.push(mark?.(n) ?? `line ${n}`);
  }
  return out.join('\n') + '\n';
}

function model(oldText: string, newText: string) {
  return computeDiff({
    oldText,
    newText,
    leftLabel: 'HEAD',
    rightLabel: 'Working Tree',
    languageId: 'plaintext',
    filePath: 'f.txt',
  });
}

test('one change in the middle: both edges collapse, 3 lines of context kept', () => {
  const m = model(lines(1, 40), lines(1, 40, (n) => (n === 20 ? 'CHANGED' : `line ${n}`)));
  assert.deepEqual(unchangedRegions(m), [
    { leftStart: 1, rightStart: 1, count: 16 }, // 1..16 hidden, 17..19 shown
    { leftStart: 24, rightStart: 24, count: 17 }, // 21..23 shown, 24..40 hidden
  ]);
});

test('line numbers follow each side after an insertion', () => {
  const oldText = lines(1, 30);
  const newText = lines(1, 10) + 'a\nb\nc\n' + lines(11, 30);
  const regions = unchangedRegions(model(oldText, newText));
  // before the insertion: lines 1..7 on both sides; after: left 14.., right 17..
  assert.deepEqual(regions, [
    { leftStart: 1, rightStart: 1, count: 7 },
    { leftStart: 14, rightStart: 17, count: 17 },
  ]);
});

test('short gaps between chunks stay expanded', () => {
  const m = model(lines(1, 12), lines(1, 12, (n) => (n === 2 || n === 11 ? 'X' : `line ${n}`)));
  // gap 3..10 is 8 lines: keeping 3 + 3 leaves 2 < 4, nothing to hide
  assert.deepEqual(unchangedRegions(m), []);
});

test('an unchanged file collapses nothing', () => {
  assert.deepEqual(unchangedRegions(model(lines(1, 50), lines(1, 50))), []);
});
