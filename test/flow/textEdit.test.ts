import * as assert from 'node:assert/strict';
import { test } from 'vitest';
import { minimalReplace, offsetToPosition, type TextReplace } from '../../src/flow/diff/textEdit';

function apply(text: string, edit: TextReplace | undefined): string {
  return edit ? text.slice(0, edit.start) + edit.text + text.slice(edit.end) : text;
}

test('equal texts need no edit', () => {
  assert.equal(minimalReplace('abc', 'abc'), undefined);
});

test('a typed character becomes a single insertion', () => {
  assert.deepEqual(minimalReplace('const a = 1;\n', 'const ab = 1;\n'), { start: 7, end: 7, text: 'b' });
});

test('a deletion keeps the text around it', () => {
  const edit = minimalReplace('one\ntwo\nthree\n', 'one\nthree\n');
  // 'one\n[two\n]three' and 'one\nt[wo\nt]hree' are equally minimal
  assert.ok(edit && edit.text === '' && edit.end - edit.start === 4);
  assert.equal(apply('one\ntwo\nthree\n', edit), 'one\nthree\n');
});

test('repeated characters do not make prefix and suffix overlap', () => {
  for (const [a, b] of [['aaa', 'aaaa'], ['aaaa', 'aa'], ['ab', 'abab'], ['', 'x'], ['x', '']]) {
    const edit = minimalReplace(a, b);
    assert.ok(edit && edit.start <= edit.end);
    assert.equal(apply(a, edit), b);
  }
});

test('surrogate pairs are never split', () => {
  const edit = minimalReplace('x😀y', 'x😁y');
  assert.deepEqual(edit, { start: 1, end: 3, text: '😁' });
  const suffixSide = minimalReplace('a😀', 'b😀');
  assert.equal(apply('a😀', suffixSide), 'b😀');
});

test('offsets map to 0-based line and column', () => {
  const text = 'ab\ncd\n\nef';
  assert.deepEqual(offsetToPosition(text, 0), { line: 0, character: 0 });
  assert.deepEqual(offsetToPosition(text, 2), { line: 0, character: 2 });
  assert.deepEqual(offsetToPosition(text, 3), { line: 1, character: 0 });
  assert.deepEqual(offsetToPosition(text, 6), { line: 2, character: 0 });
  assert.deepEqual(offsetToPosition(text, 9), { line: 3, character: 2 });
});
