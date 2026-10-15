import * as assert from 'node:assert/strict';
import { test } from 'vitest';
import { computeDiff } from '../../src/flow/diff/computeDiff';

function diff(oldText: string, newText: string) {
  return computeDiff({
    oldText,
    newText,
    leftLabel: 'HEAD',
    rightLabel: 'Working Tree',
    languageId: 'plaintext',
    filePath: 'sample.txt',
  });
}

test('identical texts produce only context rows and no chunks', () => {
  const model = diff('a\nb\nc\n', 'a\nb\nc\n');
  assert.equal(model.chunks.length, 0);
  assert.equal(model.rows.length, 3);
  assert.ok(model.rows.every((r) => r.left.kind === 'context' && r.right.kind === 'context'));
});

test('pure addition fills the left side', () => {
  const model = diff('a\nc\n', 'a\nb\nc\n');
  assert.equal(model.chunks.length, 1);
  const chunk = model.chunks[0];
  assert.equal(chunk.kind, 'added');
  const row = model.rows[chunk.rowStart];
  assert.equal(row.left.kind, 'filler');
  assert.equal(row.right.kind, 'added');
  assert.equal(row.right.text, 'b');
  assert.equal(row.right.lineNumber, 2);
  // hunk-header convention: zero-count side starts at the line before
  assert.equal(chunk.leftCount, 0);
  assert.equal(chunk.leftStart, 1);
  assert.equal(chunk.rightStart, 2);
  assert.equal(chunk.rightCount, 1);
});

test('pure removal fills the right side', () => {
  const model = diff('a\nb\nc\n', 'a\nc\n');
  const chunk = model.chunks[0];
  assert.equal(chunk.kind, 'removed');
  const row = model.rows[chunk.rowStart];
  assert.equal(row.left.kind, 'removed');
  assert.equal(row.left.text, 'b');
  assert.equal(row.right.kind, 'filler');
  assert.equal(chunk.leftStart, 2);
  assert.equal(chunk.leftCount, 1);
  assert.equal(chunk.rightCount, 0);
  assert.equal(chunk.rightStart, 1);
});

test('modified block pairs lines and emits word-level highlights', () => {
  const model = diff('const value = 1;\n', 'const value = 2;\n');
  assert.equal(model.chunks.length, 1);
  assert.equal(model.chunks[0].kind, 'modified');
  const row = model.rows[0];
  assert.equal(row.left.kind, 'modified');
  assert.equal(row.right.kind, 'modified');
  assert.ok(row.left.highlights && row.left.highlights.length > 0);
  assert.ok(row.right.highlights && row.right.highlights.length > 0);
  const [start, end] = row.right.highlights![0];
  assert.equal('const value = 2;'.slice(start, end), '2');
});

test('unequal modified block pads the shorter side with fillers', () => {
  const model = diff('one\ntwo\nthree\n', 'uno\n');
  const chunk = model.chunks[0];
  assert.equal(chunk.kind, 'modified');
  assert.equal(chunk.rowEnd - chunk.rowStart, 3);
  const rows = model.rows.slice(chunk.rowStart, chunk.rowEnd);
  assert.equal(rows[0].left.kind, 'modified');
  assert.equal(rows[0].right.kind, 'modified');
  assert.equal(rows[1].left.kind, 'removed');
  assert.equal(rows[1].right.kind, 'filler');
  assert.equal(rows[2].left.kind, 'removed');
  assert.equal(rows[2].right.kind, 'filler');
  assert.equal(chunk.leftCount, 3);
  assert.equal(chunk.rightCount, 1);
});

test('completely different lines skip intra-line highlights', () => {
  const model = diff('alpha beta gamma\n', 'xx yy zz ww qq\n');
  const row = model.rows[0];
  assert.equal(row.left.kind, 'modified');
  assert.equal(row.left.highlights, undefined);
  assert.equal(row.right.highlights, undefined);
});

test('change at EOF without trailing newline', () => {
  const model = diff('a\nb', 'a\nB');
  const chunk = model.chunks[0];
  assert.equal(chunk.kind, 'modified');
  const row = model.rows[chunk.rowStart];
  assert.equal(row.left.text, 'b');
  assert.equal(row.right.text, 'B');
  // no phantom empty trailing lines
  assert.equal(model.rows.length, 2);
});

test('CRLF input is normalized so highlights never cover a bare CR', () => {
  const model = diff('let x = 1;\r\n', 'let x = 2;\r\n');
  const row = model.rows[0];
  assert.equal(row.right.text, 'let x = 2;');
  const [start, end] = row.right.highlights![0];
  assert.equal('let x = 2;'.slice(start, end), '2');
});

test('empty old text marks the whole file as added', () => {
  const model = diff('', 'a\nb\n');
  assert.equal(model.chunks.length, 1);
  assert.equal(model.chunks[0].kind, 'added');
  assert.equal(model.rows.length, 2);
  assert.ok(model.rows.every((r) => r.left.kind === 'filler' && r.right.kind === 'added'));
});

test('row indices in chunks match grid positions', () => {
  const model = diff('a\nb\nc\nd\n', 'a\nB\nc\nD\n');
  assert.equal(model.chunks.length, 2);
  for (const chunk of model.chunks) {
    for (let i = chunk.rowStart; i < chunk.rowEnd; i++) {
      assert.equal(model.rows[i].chunkId, chunk.id);
    }
  }
  // context rows carry no chunkId
  assert.equal(model.rows[0].chunkId, undefined);
  assert.equal(model.rows[2].chunkId, undefined);
});
