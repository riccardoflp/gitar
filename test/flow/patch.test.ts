import * as assert from 'node:assert/strict';
import { test } from 'vitest';
import { lineHunks } from '../../src/flow/diff/hunks';
import { synthesizePatch } from '../../src/flow/diff/patch';

/** Patch of every hunk between the two texts. */
function patchAll(oldText: string, newText: string, path = 'sample.txt'): string {
  return synthesizePatch(path, oldText, newText, lineHunks(oldText, newText), { addedEol: 'raw' });
}

test('patch for a modified hunk carries hunk header and -/+ lines', () => {
  assert.equal(
    patchAll('a\nb\nc\n', 'a\nB\nc\n', 'dir/sample.txt'),
    [
      'diff --git a/dir/sample.txt b/dir/sample.txt',
      '--- a/dir/sample.txt',
      '+++ b/dir/sample.txt',
      '@@ -2,1 +2,1 @@',
      '-b',
      '+B',
      '',
    ].join('\n')
  );
});

test('patch for a pure insertion uses a zero-count old side', () => {
  assert.ok(patchAll('a\nc\n', 'a\nb\nc\n').endsWith('@@ -1,0 +2,1 @@\n+b\n'));
});

test('patch for a pure deletion uses a zero-count new side', () => {
  assert.ok(patchAll('a\nb\nc\n', 'a\nc\n').endsWith('@@ -2,1 +1,0 @@\n-b\n'));
});

test('windows-style relative paths are normalized to forward slashes', () => {
  assert.ok(patchAll('a\n', 'b\n', 'src\\nested\\file.ts').startsWith(
    'diff --git a/src/nested/file.ts b/src/nested/file.ts'
  ));
});

test('new-side starts only count the hunks that are part of the patch', () => {
  const oldText = 'a\nb\nc\nd\n';
  const newText = 'x\ny\na\nb\nc\nD\n';
  const [insertion, modification] = lineHunks(oldText, newText);
  // the insertion above is left out, so D stays at line 4
  const patch = synthesizePatch('f', oldText, newText, [modification], { addedEol: 'raw' });
  assert.ok(patch.endsWith('@@ -4,1 +4,1 @@\n-d\n+D\n'));
  const both = synthesizePatch('f', oldText, newText, [modification, insertion], { addedEol: 'raw' });
  assert.ok(both.includes('@@ -0,0 +1,2 @@\n+x\n+y\n@@ -4,1 +6,1 @@'));
});

test('a last line without newline gets the no-newline marker', () => {
  assert.ok(
    patchAll('a\nb', 'a\nB').endsWith(
      '@@ -2,1 +2,1 @@\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n'
    )
  );
});

test('removed lines keep their CR; added lines follow addedEol', () => {
  const oldText = 'a\r\nb\r\n';
  const newText = 'a\nB\n';
  const hunks = lineHunks(oldText, newText);
  const crlf = synthesizePatch('f', oldText, newText, hunks, { addedEol: 'crlf' });
  assert.ok(crlf.endsWith('-b\r\n+B\r\n'));
  const lf = synthesizePatch('f', oldText, newText, hunks, { addedEol: 'lf' });
  assert.ok(lf.endsWith('-b\r\n+B\n'));
});
