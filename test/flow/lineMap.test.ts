import * as assert from 'node:assert/strict';
import { test } from 'vitest';
import { computeDiff } from '../../src/flow/diff/computeDiff';
import { rightLineForLeft } from '../../src/flow/diff/lineMap';

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

test('context and modified lines map to their own row', () => {
  const m = model('a\nb\nc\nd\n', 'x\na\nB\nc\nd\n');
  assert.equal(rightLineForLeft(m, 1), 2); // a, shifted by the insertion
  assert.equal(rightLineForLeft(m, 2), 3); // b → B
  assert.equal(rightLineForLeft(m, 4), 5);
});

test('a removed line maps to the line above the gap', () => {
  const m = model('a\nb\nc\nd\n', 'a\nd\n');
  assert.equal(rightLineForLeft(m, 2), 1);
  assert.equal(rightLineForLeft(m, 3), 1);
  assert.equal(rightLineForLeft(m, 4), 2);
});

test('removed lines at the top map to line 1', () => {
  assert.equal(rightLineForLeft(model('a\nb\nc\n', 'c\n'), 1), 1);
});
