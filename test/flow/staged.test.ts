import * as assert from 'node:assert/strict';
import { test } from 'vitest';
import { computeDiff } from '../../src/flow/diff/computeDiff';
import { markStagedChunks } from '../../src/flow/diff/staged';

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

function stagedFlags(head: string, index: string | undefined, worktree: string): boolean[] {
  const model = diff(head, worktree);
  markStagedChunks(model, index, worktree);
  return model.chunks.map((c) => c.staged === true);
}

test('index equal to worktree marks every chunk staged', () => {
  assert.deepEqual(stagedFlags('a\nb\nc\n', 'a\nB\nc\n', 'a\nB\nc\n'), [true]);
});

test('index equal to HEAD marks every chunk unstaged', () => {
  assert.deepEqual(stagedFlags('a\nb\nc\n', 'a\nb\nc\n', 'a\nB\nc\n'), [false]);
});

test('mixed file: only the chunk present in the index is staged', () => {
  const head = 'a\nb\nc\nd\ne\n';
  const worktree = 'a\nB\nc\nd\nE\n'; // two modified chunks
  const index = 'a\nB\nc\nd\ne\n'; // only the first one staged
  assert.deepEqual(stagedFlags(head, index, worktree), [true, false]);
});

test('staged pure deletion', () => {
  const head = 'a\nb\nc\n';
  const worktree = 'a\nc\n';
  assert.deepEqual(stagedFlags(head, 'a\nc\n', worktree), [true]);
  assert.deepEqual(stagedFlags(head, 'a\nb\nc\n', worktree), [false]);
});

test('staged pure insertion', () => {
  const head = 'a\nc\n';
  const worktree = 'a\nb\nc\n';
  assert.deepEqual(stagedFlags(head, 'a\nb\nc\n', worktree), [true]);
  assert.deepEqual(stagedFlags(head, 'a\nc\n', worktree), [false]);
});

test('missing index content (untracked file) leaves chunks unmarked', () => {
  const model = diff('', 'a\n');
  markStagedChunks(model, undefined, 'a\n');
  assert.equal(model.chunks[0].staged, undefined);
});

test('untracked file staged whole: index matches worktree', () => {
  assert.deepEqual(stagedFlags('', 'a\nb\n', 'a\nb\n'), [true]);
});

test('partially staged chunk stays unstaged', () => {
  const head = 'a\nb\nc\n';
  const worktree = 'a\nX\nY\nc\n'; // one modified chunk spanning two lines
  const index = 'a\nX\nb\nc\n'; // only part of it staged
  assert.deepEqual(stagedFlags(head, index, worktree), [false]);
});

test('unstaged insertion adjacent to a staged chunk does not bleed into it', () => {
  const head = 'a\nb\nc\nd\n';
  const worktree = 'a\nB\nnew\nc\nd\n'; // modified b→B, then an insertion after it
  const index = 'a\nB\nc\nd\n'; // only the modification staged
  const flags = stagedFlags(head, index, worktree);
  // computeDiff merges adjacent changes or not depending on jsdiff; assert on
  // whatever chunks exist: none may claim staged unless fully in the index
  const model = diff(head, worktree);
  markStagedChunks(model, index, worktree);
  for (const chunk of model.chunks) {
    if (chunk.staged) {
      // a staged chunk must not cover the unstaged 'new' line
      const lines: string[] = [];
      for (let i = chunk.rowStart; i < chunk.rowEnd; i++) {
        const cell = model.rows[i].right;
        if (cell.kind !== 'filler' && cell.text !== undefined) {
          lines.push(cell.text);
        }
      }
      assert.ok(!lines.includes('new'));
    }
  }
  assert.ok(flags.length > 0);
});

test('CRLF worktree against LF index still detects staged chunks', () => {
  assert.deepEqual(stagedFlags('a\nb\n', 'a\nB\n', 'a\r\nB\r\n'), [true]);
});
