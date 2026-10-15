/**
 * Round-trips the stage / unstage patches through a real `git apply --cached`
 * in a throwaway repository. Skipped when git is not on the PATH.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';
import { stagePatch, unstagePatch } from '../../src/flow/diff/chunkPatch';
import { computeDiff } from '../../src/flow/diff/computeDiff';
import type { DiffChunk } from '../../src/flow/diff/model';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const FILE = 'sample.txt';

/** A repo where `sample.txt` has the given HEAD, index and worktree contents. */
function repo(head: string, index: string, worktree: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-diff-test-'));
  const git = (args: string[], input?: string) =>
    execFileSync('git', args, { cwd: root, input, encoding: 'utf8' });
  git(['init', '--quiet']);
  git(['config', 'user.name', 'test']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'commit.gpgsign', 'false']);
  const file = path.join(root, FILE);
  fs.writeFileSync(file, head);
  git(['add', FILE]);
  git(['commit', '--quiet', '-m', 'head']);
  fs.writeFileSync(file, index);
  git(['add', FILE]);
  fs.writeFileSync(file, worktree);
  return {
    apply(patch: string | undefined) {
      assert.ok(patch, 'expected a patch');
      git(['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-'], patch);
    },
    index: () => git(['show', `:${FILE}`]),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function chunks(oldText: string, newText: string): DiffChunk[] {
  return computeDiff({
    oldText,
    newText,
    leftLabel: 'HEAD',
    rightLabel: 'Working Tree',
    languageId: 'plaintext',
    filePath: FILE,
  }).chunks;
}

/** Stages chunk `n` of the HEAD↔worktree diff, returns the resulting index. */
function stage(head: string, index: string, worktree: string, n: number): string {
  const r = repo(head, index, worktree);
  try {
    const chunk = chunks(head, worktree)[n];
    r.apply(stagePatch(FILE, index, worktree, { start: chunk.rightStart, count: chunk.rightCount }));
    return r.index();
  } finally {
    r.cleanup();
  }
}

const gitTest = (name: string, fn: () => void) => test.skipIf(!hasGit)(name, fn);

gitTest('stage one chunk out of two', () => {
  assert.equal(stage('a\nb\nc\nd\n', 'a\nb\nc\nd\n', 'A\nb\nc\nD\n', 1), 'a\nb\nc\nD\n');
});

gitTest('stage the rest of a partially staged chunk', () => {
  // HEAD b,c → worktree B,C is one chunk; the index already has B
  assert.equal(stage('a\nb\nc\n', 'a\nB\nc\n', 'a\nB\nC\n', 0), 'a\nB\nC\n');
});

gitTest('stage below a staged insertion that shifts the index lines', () => {
  assert.equal(stage('1\n2\n3\n', 'X\n1\n2\n3\n', 'X\n1\n2\nTHREE\n', 1), 'X\n1\n2\nTHREE\n');
});

gitTest('stage a pure insertion and a pure deletion', () => {
  assert.equal(stage('a\nc\n', 'a\nc\n', 'a\nb\nc\n', 0), 'a\nb\nc\n');
  assert.equal(stage('a\nb\nc\n', 'a\nb\nc\n', 'a\nc\n', 0), 'a\nc\n');
});

gitTest('stage keeps a CRLF index CRLF', () => {
  assert.equal(stage('a\r\nb\r\n', 'a\r\nb\r\n', 'a\r\nB\r\n', 0), 'a\r\nB\r\n');
});

gitTest('stage keeps an LF index LF when the worktree is CRLF (autocrlf)', () => {
  assert.equal(stage('a\nb\n', 'a\nb\n', 'a\r\nB\r\n', 0), 'a\nB\n');
});

gitTest('stage around a missing final newline', () => {
  assert.equal(stage('a\nb', 'a\nb', 'a\nB', 0), 'a\nB');
  assert.equal(stage('a', 'a', 'a\nb\n', 0), 'a\nb\n');
  assert.equal(stage('a\nb\n', 'a\nb\n', 'a\nb', 0), 'a\nb');
});

gitTest('unstage from the worktree view, with an unstaged insertion above', () => {
  const head = 'a\nb\nc\n';
  const index = 'a\nb\nC\n';
  const worktree = 'NEW\na\nb\nC\n';
  const r = repo(head, index, worktree);
  try {
    const staged = chunks(head, worktree)[1]; // c → C, left side in HEAD lines
    r.apply(unstagePatch(FILE, index, head, { start: staged.leftStart, count: staged.leftCount }, 'head'));
    assert.equal(r.index(), head);
  } finally {
    r.cleanup();
  }
});

gitTest('unstage one chunk from the index view', () => {
  const head = 'a\nb\nc\nd\n';
  const index = 'A\nb\nc\nD\n';
  const r = repo(head, index, index);
  try {
    const chunk = chunks(head, index)[1]; // HEAD↔index: right side in index lines
    r.apply(unstagePatch(FILE, index, head, { start: chunk.rightStart, count: chunk.rightCount }, 'index'));
    assert.equal(r.index(), 'A\nb\nc\nd\n');
  } finally {
    r.cleanup();
  }
});

test('nothing to stage when the region already matches the index', () => {
  const head = 'a\nb\n';
  const worktree = 'a\nB\n';
  const chunk = chunks(head, worktree)[0];
  assert.equal(
    stagePatch(FILE, worktree, worktree, { start: chunk.rightStart, count: chunk.rightCount }),
    undefined
  );
});
