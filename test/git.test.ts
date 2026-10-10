import { describe, expect, it } from 'vitest';
import { formatCommand } from '../src/git/exec';
import {
  abortOp,
  checkoutOp,
  cherryPickOp,
  bisectOp,
  cleanupBranchesOp,
  clearIdentityOp,
  fixupOp,
  identityOp,
  commitOp,
  continueOp,
  createBranchOp,
  createTagOp,
  deleteBranchOp,
  deleteRemoteBranchOp,
  discardOp,
  hunkOp,
  rebaseInteractiveOp,
  rebaseOp,
  rebaseTodo,
  refNameProblem,
  undoOp,
  worktreeAddOp,
  worktreeRemoveOp,
  resetOp,
  revertOp,
  skipOp,
  stageOp,
  stashOp,
  stashPushOp,
  syncOp,
  unstageAllOp,
  unstageOp,
} from '../src/git/ops';
import { compareUrl, mapPulls, parseGitHubRemote } from '../src/git/github';
import { buildPrompt, cleanMessage } from '../src/shared/commitPrompt';
import {
  allChanges,
  hunkPatch,
  linesPatch,
  parseBisectRefs,
  parseBlameLine,
  parseIdentity,
  parseHunks,
  parseLog,
  parseNameStatus,
  parseRefs,
  parseStatus,
  parseWorktrees,
} from '../src/git/parse';
import type { Branch, RepoState, WorkingState } from '../src/shared/protocol';

const F = '\x1f';

describe('parsers', () => {
  it('parses log records, including root commits and empty subjects', () => {
    const out = [`h2${F}h1 h0${F}Ann${F}ann@x.io${F}1700000000${F}Merge it`, `h1${F}${F}Bob${F}bob@x.io${F}1600000000${F}`].join('\0');
    expect(parseLog(out + '\0')).toEqual([
      { hash: 'h2', parents: ['h1', 'h0'], author: 'Ann', email: 'ann@x.io', date: 1700000000, subject: 'Merge it' },
      { hash: 'h1', parents: [], author: 'Bob', email: 'bob@x.io', date: 1600000000, subject: '' },
    ]);
  });

  it('sorts refs by kind, reads tracking info and peels annotated tags', () => {
    const line = (...fields: string[]) => fields.join(F);
    const refs = parseRefs(
      [
        line('refs/heads/main', 'aaa', '', 'refs/remotes/origin/main', 'origin', 'refs/heads/main', '[ahead 3, behind 2]', '*'),
        line('refs/heads/old', 'bbb', '', 'refs/remotes/origin/old', 'origin', 'refs/heads/old', '[gone]', ' '),
        line('refs/heads/local', 'ccc', '', '', '', '', '', ' '),
        line('refs/remotes/origin/HEAD', 'aaa', '', '', '', '', '', ' '),
        line('refs/remotes/origin/main', 'ddd', '', '', '', '', '', ' '),
        line('refs/tags/v1', 'tagobj', 'eee', '', '', '', '', ' '),
        line('refs/stash', 'fff', '', '', '', '', '', ' '),
      ].join('\n') + '\n',
    );
    expect(refs.branches[0]).toEqual({
      name: 'main',
      hash: 'aaa',
      current: true,
      upstream: { name: 'origin/main', remote: 'origin', branch: 'main', ahead: 3, behind: 2, gone: false },
    });
    expect(refs.branches[1].upstream?.gone).toBe(true);
    expect(refs.branches[2].upstream).toBeUndefined();
    expect(refs.remoteBranches).toEqual([{ name: 'origin/main', hash: 'ddd' }]);
    expect(refs.tags).toEqual([{ name: 'v1', hash: 'eee' }]);
  });

  it('parses name-status output with renames', () => {
    expect(parseNameStatus('M\0a.ts\0R087\0old name.ts\0new name.ts\0A\0b.ts\0')).toEqual([
      { status: 'M', path: 'a.ts' },
      { status: 'R', path: 'new name.ts', oldPath: 'old name.ts' },
      { status: 'A', path: 'b.ts' },
    ]);
  });

  it('splits porcelain status into staged, unstaged and conflicting files', () => {
    const working = parseStatus(' M a.ts\0R  new.ts\0old.ts\0?? c d.ts\0D  e.ts\0MM both.ts\0UU clash.ts\0AA twice.ts\0');
    expect(working).toEqual({
      staged: [
        { status: 'R', path: 'new.ts', oldPath: 'old.ts' },
        { status: 'D', path: 'e.ts' },
        { status: 'M', path: 'both.ts' },
      ],
      unstaged: [
        { status: 'M', path: 'a.ts' },
        { status: '?', path: 'c d.ts' },
        { status: 'M', path: 'both.ts' },
      ],
      conflicts: [
        { status: 'U', path: 'clash.ts' },
        { status: 'U', path: 'twice.ts' },
      ],
    });
    // A file changed in both the index and the working tree still counts once.
    expect(allChanges(working).map((file) => file.path)).toEqual(['clash.ts', 'twice.ts', 'new.ts', 'e.ts', 'both.ts', 'a.ts', 'c d.ts']);
  });

  it('parses worktrees and marks the current one', () => {
    const out = 'worktree C:/prj/app\nHEAD aaa\nbranch refs/heads/main\n\nworktree C:/prj/app-fix\nHEAD bbb\ndetached\n\n';
    expect(parseWorktrees(`${out}worktree C:/prj/gone\nHEAD ccc\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n\n`, 'c:/prj/app')).toEqual([
      { path: 'C:/prj/app', hash: 'aaa', branch: 'main', current: true, prunable: false },
      { path: 'C:/prj/app-fix', hash: 'bbb', branch: null, current: false, prunable: false },
      { path: 'C:/prj/gone', hash: 'ccc', branch: 'x', current: false, prunable: true },
    ]);
  });

  it('cuts a file diff into hunks that are each a complete patch', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      'index 111..222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      '-one',
      '+ONE',
      ' two',
      '@@ -9,2 +9,3 @@ context',
      ' nine',
      '+new',
      ' ten',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const file = parseHunks(diff);
    expect(file.binary).toBe(false);
    expect(file.hunks.map((hunk) => hunk.header)).toEqual(['@@ -1,2 +1,2 @@', '@@ -9,2 +9,3 @@ context']);
    expect(hunkPatch(file, file.hunks[1])).toBe(
      'diff --git a/a.txt b/a.txt\nindex 111..222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -9,2 +9,3 @@ context\n nine\n+new\n ten\n\\ No newline at end of file\n',
    );
    expect(parseHunks('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n')).toMatchObject({ binary: true, hunks: [] });
    expect(parseHunks('')).toEqual({ prelude: '', hunks: [], binary: false });
  });
});

describe('syncOp', () => {
  const state = (branch: Partial<Branch> | null, remotes = ['origin'], tags: string[] = []): RepoState =>
    ({
      branches: branch ? [{ name: 'work', hash: 'aaa', current: true, ...branch }] : [],
      remoteBranches: [],
      tags: tags.map((name) => ({ name, hash: 'bbb' })),
      remotes,
    }) as Partial<RepoState> as RepoState;
  const upstream = (branch: string) => ({ name: `up/${branch}`, remote: 'up', branch, ahead: 0, behind: 0, gone: false });

  it('pushes to the upstream of the current branch', () => {
    expect(syncOp('push', state({ upstream: upstream('work') })).commands).toEqual([['push', 'up', 'work']]);
  });

  it('spells out the remote branch when its name differs', () => {
    expect(syncOp('push', state({ upstream: upstream('main') })).commands).toEqual([['push', 'up', 'work:main']]);
  });

  it('sets the upstream on the first push', () => {
    expect(syncOp('push', state({})).commands).toEqual([['push', '--set-upstream', 'origin', 'work']]);
  });

  it('names the branch in full when a tag is called the same, which git would not tell apart', () => {
    expect(syncOp('push', state({}, ['origin'], ['work'])).commands).toEqual([['push', '--set-upstream', 'origin', 'refs/heads/work']]);
    expect(syncOp('push', state({ upstream: upstream('main') }, ['origin'], ['work'])).commands).toEqual([
      ['push', 'up', 'refs/heads/work:main'],
    ]);
  });

  it('marks force pushes as dangerous', () => {
    const lease = syncOp('pushForceWithLease', state({ upstream: upstream('work') }));
    expect(lease.commands).toEqual([['push', '--force-with-lease', 'up', 'work']]);
    expect(lease.danger).toBe(true);
    expect(syncOp('pushForce', state({})).commands).toEqual([['push', '--force', '--set-upstream', 'origin', 'work']]);
    expect(syncOp('push', state({})).danger).toBeFalsy();
  });

  it('refuses to push without a branch or a remote', () => {
    expect(() => syncOp('push', state(null))).toThrow(/detached/);
    expect(() => syncOp('push', state({}, []))).toThrow(/no remote/);
  });
});

describe('operations', () => {
  const hash = 'a'.repeat(40);

  it('checks out branches, remote branches and detached commits differently', () => {
    expect(checkoutOp('branch', 'dev').commands).toEqual([['checkout', 'dev']]);
    expect(checkoutOp('remote', 'origin/dev').commands).toEqual([['checkout', '--track', 'origin/dev']]);
    expect(checkoutOp('detached', hash).commands).toEqual([['checkout', '--detach', hash]]);
  });

  it('creates branches and tags at a given commit', () => {
    expect(createBranchOp('fix', hash, true).commands).toEqual([['checkout', '-b', 'fix', hash]]);
    expect(createBranchOp('fix', hash, false).commands).toEqual([['branch', 'fix', hash]]);
    expect(createTagOp('v1', hash, '').commands).toEqual([['tag', 'v1', hash]]);
    expect(createTagOp('v1', hash, 'First release').commands).toEqual([['tag', '-a', 'v1', '-m', 'First release', hash]]);
  });

  it('only treats the forced branch delete as dangerous', () => {
    expect(deleteBranchOp('old', false)).toMatchObject({ commands: [['branch', '-d', 'old']] });
    expect(deleteBranchOp('old', false).danger).toBeFalsy();
    expect(deleteBranchOp('old', true)).toMatchObject({ commands: [['branch', '-D', 'old']], danger: true });
  });

  it('finds the remote of a remote branch even when names contain slashes', () => {
    const state = { remotes: ['team', 'team/fork'] } as RepoState;
    expect(deleteRemoteBranchOp('team/fork/feature/x', state)).toMatchObject({
      commands: [['push', 'team/fork', '--delete', 'feature/x']],
      danger: true,
    });
    expect(deleteRemoteBranchOp('team/main', state).commands).toEqual([['push', 'team', '--delete', 'main']]);
    expect(() => deleteRemoteBranchOp('other/main', state)).toThrow(/which remote/);
  });

  it('picks the first parent as mainline for merge commits', () => {
    expect(cherryPickOp(hash, false).commands).toEqual([['cherry-pick', hash]]);
    expect(cherryPickOp(hash, true).commands).toEqual([['cherry-pick', '-m', '1', hash]]);
    expect(revertOp(hash, true).commands).toEqual([['revert', '--no-edit', '-m', '1', hash]]);
  });

  it('only treats a hard reset as dangerous', () => {
    expect(resetOp(hash, 'soft', 'main')).toMatchObject({ title: 'Reset main to aaaaaaa (soft)', commands: [['reset', '--soft', hash]] });
    expect(resetOp(hash, 'mixed', 'main').danger).toBeFalsy();
    expect(resetOp(hash, 'hard', 'main').danger).toBe(true);
  });

  it('builds stash commands and rejects anything that is not a stash', () => {
    expect(stashPushOp('').commands).toEqual([['stash', 'push', '--include-untracked']]);
    expect(stashPushOp('wip').commands).toEqual([['stash', 'push', '--include-untracked', '-m', 'wip']]);
    expect(stashOp('pop', 'stash@{2}').commands).toEqual([['stash', 'pop', 'stash@{2}']]);
    expect(stashOp('drop', 'stash@{0}').danger).toBe(true);
    expect(() => stashOp('drop', '--all')).toThrow();
  });

  it('unstages without HEAD by removing from the index', () => {
    expect(unstageOp(['a.ts'], true).commands).toEqual([['restore', '--staged', '--', 'a.ts']]);
    expect(unstageOp(['a.ts'], false).commands).toEqual([['rm', '--cached', '-r', '--', 'a.ts']]);
    expect(unstageAllOp(true).commands).toEqual([['reset']]);
  });

  it('marks a file name that is also a pattern to be taken as it is written, and leaves plain names alone', () => {
    expect(stageOp(['src/app.ts', 'pages/[id].tsx', 'what?.md']).commands).toEqual([
      ['add', '--', 'src/app.ts', ':(literal)pages/[id].tsx', ':(literal)what?.md'],
    ]);
    expect(unstageOp(['a*.ts'], true).commands).toEqual([['restore', '--staged', '--', ':(literal)a*.ts']]);
    const working = { staged: [], unstaged: [{ status: '?' as const, path: '[new].ts' }], conflicts: [] };
    expect(discardOp(['[id].ts', '[new].ts'], working).commands).toEqual([
      ['restore', '--', ':(literal)[id].ts'],
      ['clean', '-f', '--', ':(literal)[new].ts'],
    ]);
    expect(stashPushOp('', { paths: ['a b.ts', '[id].ts'] }).commands).toEqual([
      ['stash', 'push', '--include-untracked', '--', 'a b.ts', ':(literal)[id].ts'],
    ]);
  });

  it('restores tracked files and deletes untracked ones when discarding', () => {
    const working: WorkingState = {
      staged: [],
      unstaged: [
        { status: 'M', path: 'a.ts' },
        { status: '?', path: 'new.ts' },
      ],
      conflicts: [],
    };
    const op = discardOp(['a.ts', 'new.ts'], working);
    expect(op.commands).toEqual([
      ['restore', '--', 'a.ts'],
      ['clean', '-f', '--', 'new.ts'],
    ]);
    expect(op.danger).toBe(true);
    expect(discardOp(['a.ts'], working).commands).toEqual([['restore', '--', 'a.ts']]);
    expect(() => discardOp([], working)).toThrow();
  });

  it('commits, amends, and stages everything first when asked', () => {
    expect(commitOp('Fix it', false, false).commands).toEqual([['commit', '-m', 'Fix it']]);
    expect(commitOp('Fix it', false, true).commands).toEqual([['add', '--all'], ['commit', '-m', 'Fix it']]);
    expect(commitOp('Reword', true, false).commands).toEqual([['commit', '--amend', '-m', 'Reword']]);
    expect(commitOp('', true, false).commands).toEqual([['commit', '--amend', '--no-edit']]);
    expect(() => commitOp('', false, false)).toThrow(/message/);
  });

  it('continues, skips and aborts the operation in progress', () => {
    expect(continueOp('rebase').commands).toEqual([['-c', 'core.editor=true', 'rebase', '--continue']]);
    expect(skipOp('cherry-pick').commands).toEqual([['cherry-pick', '--skip']]);
    expect(() => skipOp('merge')).toThrow();
    expect(abortOp('merge')).toMatchObject({ commands: [['merge', '--abort']], danger: true });
  });

  it('offers the forced variant when git refuses to delete', () => {
    const remove = deleteBranchOp('old');
    expect(remove.fallback?.when.test("error: the branch 'old' is not fully merged")).toBe(true);
    expect(remove.fallback?.op).toMatchObject({ commands: [['branch', '-D', 'old']], danger: true });
    const worktree = worktreeRemoveOp('C:/prj/app-fix');
    expect(worktree.fallback?.when.test("fatal: 'C:/prj/app-fix' contains modified or untracked files, use --force to delete it")).toBe(true);
    expect(worktree.fallback?.op.commands).toEqual([['worktree', 'remove', '--force', 'C:/prj/app-fix']]);
  });

  it('rebases the current branch or another one', () => {
    expect(rebaseOp('main', 'work').commands).toEqual([['rebase', 'main']]);
    expect(rebaseOp(hash, 'work', 'other')).toMatchObject({ title: 'Rebase other onto aaaaaaa', commands: [['rebase', hash, 'other']] });
  });

  it('writes a rebase todo list where a reword is a pick plus an amend from a file', () => {
    const todo = rebaseTodo(
      [
        { action: 'pick', hash: 'c1' },
        { action: 'reword', hash: 'c2', message: 'Better' },
        { action: 'fixup', hash: 'c3' },
        { action: 'drop', hash: 'c4' },
      ],
      (index) => `/tmp/message-${index}.txt`,
    );
    expect(todo).toBe('pick c1\npick c2\nexec git commit --amend -F "/tmp/message-1.txt"\nfixup c3\ndrop c4\n');
    expect(() => rebaseTodo([{ action: 'drop', hash: 'c1' }, { action: 'squash', hash: 'c2' }], String)).toThrow(/nothing before it/);
    expect(() => rebaseTodo([{ action: 'drop', hash: 'c1' }], String)).toThrow(/dropped/);
    expect(rebaseInteractiveOp(null, '/tmp/todo', todo, 'work').commands[0].slice(-3)).toEqual(['rebase', '-i', '--root']);
  });

  it('creates worktrees for an existing branch, a new branch or a detached commit', () => {
    expect(worktreeAddOp('../wt', 'feature', null, false).commands).toEqual([['worktree', 'add', '../wt', 'feature']]);
    expect(worktreeAddOp('../wt', hash, 'fix', true).commands).toEqual([['worktree', 'add', '-b', 'fix', '../wt', hash]]);
    expect(worktreeAddOp('../wt', hash, null, true).commands).toEqual([['worktree', 'add', '--detach', '../wt', hash]]);
  });

  it('undoes a checkout by going back, and anything else by moving the branch back', () => {
    expect(undoOp({ kind: 'checkout', from: 'main' }, 'dev').commands).toEqual([['checkout', 'main']]);
    expect(undoOp({ kind: 'checkout', from: hash }, 'dev').commands).toEqual([['checkout', '--detach', hash]]);
    const undo = undoOp({ kind: 'move', previous: hash, subject: 'commit: Oops', mode: 'soft' }, 'dev');
    expect(undo).toMatchObject({ title: 'Undo "commit: Oops"', commands: [['reset', '--soft', hash]], confirm: true });
  });

  it('passes a hunk to git apply on standard input', () => {
    const patch = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n';
    expect(hunkOp('stageHunk', 'a', patch)).toMatchObject({ commands: [['apply', '--cached', '-']], input: patch });
    expect(hunkOp('unstageHunk', 'a', patch).commands).toEqual([['apply', '--cached', '--reverse', '-']]);
    expect(hunkOp('discardHunk', 'a', patch)).toMatchObject({ commands: [['apply', '--reverse', '-']], danger: true });
  });

  it('deletes merged branches safely and asks before forcing the others', () => {
    expect(cleanupBranchesOp(['a', 'b'], [])).toMatchObject({
      title: 'Delete 2 branches',
      commands: [['branch', '-d', 'a', 'b']],
      confirm: true,
    });
    expect(cleanupBranchesOp(['a', 'b'], []).danger).toBeUndefined();
    const forced = cleanupBranchesOp(['a'], ['wip']);
    expect(forced.commands).toEqual([
      ['branch', '-d', 'a'],
      ['branch', '-D', 'wip'],
    ]);
    expect(forced).toMatchObject({ danger: true, note: expect.stringContaining('wip') });
    expect(cleanupBranchesOp([], ['wip']).title).toBe('Delete 1 branch');
    expect(() => cleanupBranchesOp([], [])).toThrow(/No branches/);
    expect(() => cleanupBranchesOp(['--all'], [])).toThrow(/not a valid name/);
  });

  it('refuses names that git could read as options', () => {
    expect(() => checkoutOp('branch', '--force')).toThrow(/not a valid name/);
    expect(() => createBranchOp('-D', hash, false)).toThrow(/not a valid name/);
  });

  it('validates ref names before git sees them', () => {
    for (const name of ['feature/x', 'v1.2.3', 'fix_bug-2']) expect(refNameProblem(name)).toBeUndefined();
    for (const name of ['', '-x', 'a b', 'a..b', 'x.lock', 'end/', '.hidden', 'a~1', 'a:b', 'x@{1}']) {
      expect(refNameProblem(name)).toBeTruthy();
    }
  });
});

describe('single lines of a hunk', () => {
  const file = { prelude: 'diff --git a/a b/a\n--- a/a\n+++ b/a\n', hunks: [], binary: false };
  const hunk = { header: '@@ -10,4 +10,5 @@ function x() {', lines: [' keep', '-old', '+new', '+extra', ' tail', ' end'] };

  it('leaves out added lines and keeps removed ones as context when the patch is applied forwards', () => {
    expect(linesPatch(file, hunk, new Set([3]), false)).toBe(
      `${file.prelude}@@ -10,4 +10,5 @@ function x() {\n keep\n old\n+extra\n tail\n end\n`,
    );
    expect(linesPatch(file, hunk, new Set([1]), false)).toBe(`${file.prelude}@@ -10,4 +10,3 @@ function x() {\n keep\n-old\n tail\n end\n`);
  });

  it('does the opposite when the patch is applied backwards', () => {
    expect(linesPatch(file, hunk, new Set([3]), true)).toBe(
      `${file.prelude}@@ -10,4 +10,5 @@ function x() {\n keep\n new\n+extra\n tail\n end\n`,
    );
    expect(linesPatch(file, hunk, new Set([1]), true)).toBe(
      `${file.prelude}@@ -10,6 +10,5 @@ function x() {\n keep\n-old\n new\n extra\n tail\n end\n`,
    );
  });

  it('is the whole hunk when every changed line is picked', () => {
    expect(linesPatch(file, hunk, new Set([1, 2, 3]), false)).toBe(hunkPatch({ ...file, hunks: [hunk] }, hunk));
  });

  it('keeps the missing-newline marker with its line, and drops it with it', () => {
    const last = { header: '@@ -1,2 +1,2 @@', lines: [' a', '-b', '\\ No newline at end of file', '+c', '\\ No newline at end of file'] };
    expect(linesPatch(file, last, new Set([1]), false)).toBe(`${file.prelude}@@ -1,2 +1,1 @@\n a\n-b\n\\ No newline at end of file\n`);
    expect(() => linesPatch(file, { header: 'nonsense', lines: [] }, new Set(), false)).toThrow(/hunk header/);
  });
});

describe('identity and bisect', () => {
  const hash = 'c'.repeat(40);

  it('reads the name and email git would use, the last value winning', () => {
    expect(parseIdentity('user.name Global Me\nuser.email me@x.io\nuser.name Local Me\n')).toEqual({ name: 'Local Me', email: 'me@x.io' });
    expect(parseIdentity('')).toEqual({ name: '', email: '' });
  });

  it('builds the commands that set and clear the identity of a repository', () => {
    expect(identityOp({ name: ' Ann ', email: 'ann@x.io' }, ['user.name']).commands).toEqual([
      ['config', 'user.name', 'Ann'],
      ['config', 'user.email', 'ann@x.io'],
    ]);
    expect(identityOp({ name: 'Ann', email: 'ann@x.io' }, ['user.signingkey']).commands[2]).toEqual(['config', '--unset-all', 'user.signingkey']);
    expect(identityOp({ name: 'Ann', email: 'ann@x.io', signingKey: 'KEY' }, []).commands[2]).toEqual(['config', 'user.signingkey', 'KEY']);
    expect(() => identityOp({ name: '--global', email: 'x' }, [])).toThrow(/not a valid name/);
    expect(() => identityOp({ name: 'Ann', email: ' ' }, [])).toThrow(/not a valid name/);
    expect(clearIdentityOp(['user.email', 'user.name', 'user.other']).commands).toEqual([
      ['config', '--unset-all', 'user.name'],
      ['config', '--unset-all', 'user.email'],
    ]);
  });

  it('reads the marks of a bisect from its refs', () => {
    const out = ['refs/bisect/bad bbb', 'refs/bisect/good-aaa aaa', 'refs/bisect/good-ccc ccc', 'refs/bisect/skip-ddd ddd', ''].join('\n');
    expect(parseBisectRefs(out)).toEqual({ good: ['aaa', 'ccc'], bad: 'bbb', skipped: ['ddd'] });
    expect(parseBisectRefs('')).toEqual({ good: [], bad: null, skipped: [] });
  });

  it('starts a bisect with the first mark and only marks afterwards', () => {
    expect(bisectOp('bad', hash, false)).toMatchObject({
      title: `Start bisect: ${hash.slice(0, 7)} is bad`,
      commands: [
        ['bisect', 'start'],
        ['bisect', 'bad', hash],
      ],
    });
    expect(bisectOp('good', undefined, true)).toMatchObject({ title: 'Bisect: this commit is good', commands: [['bisect', 'good']] });
    expect(bisectOp('skip', undefined, true).title).toBe('Bisect: this commit is skipped');
    expect(() => bisectOp('good', '--all', true)).toThrow(/not a valid name/);
  });

  it('folds changes into a commit with a fixup commit and an autosquash rebase', () => {
    expect(fixupOp(hash, false, false)).toMatchObject({
      title: `Add staged changes to ${hash.slice(0, 7)}`,
      commands: [
        ['commit', `--fixup=${hash}`],
        ['-c', 'sequence.editor=true', 'rebase', '-i', '--autosquash', '--autostash', `${hash}^`],
      ],
      confirm: true,
    });
    const all = fixupOp(hash, true, true);
    expect(all.commands[0]).toEqual(['add', '--all']);
    expect(all.commands[2].at(-1)).toBe('--root');
    expect(() => fixupOp('-x', false, false)).toThrow(/not a valid name/);
  });
});

describe('blame', () => {
  const porcelain = (hash: string) =>
    [
      `${hash} 3 7 1`,
      'author Ann Lee',
      'author-mail <ann@x.io>',
      'author-time 1700000000',
      'author-tz +0100',
      'committer Bob',
      'committer-time 1700000500',
      'summary Fix the author parser',
      'filename src/a.ts',
      '\tauthor of this line is not Ann',
      '',
    ].join('\n');

  it('reads the commit of a line and ignores the content of the line itself', () => {
    expect(parseBlameLine(porcelain('a'.repeat(40)))).toEqual({
      hash: 'a'.repeat(40),
      author: 'Ann Lee',
      date: 1700000000,
      summary: 'Fix the author parser',
      committed: true,
    });
  });

  it('recognizes lines that are not committed yet, and output that is not a blame', () => {
    expect(parseBlameLine(porcelain('0'.repeat(40)))).toMatchObject({ committed: false });
    expect(parseBlameLine('')).toBeNull();
    expect(parseBlameLine('fatal: no such path')).toBeNull();
  });
});

describe('GitHub', () => {
  it('recognizes the forms of a github.com remote', () => {
    const expected = { owner: 'octo', repo: 'my.repo' };
    for (const url of [
      'https://github.com/octo/my.repo.git',
      'https://github.com/octo/my.repo',
      'https://user@github.com/octo/my.repo.git/',
      'git@github.com:octo/my.repo.git',
      'ssh://git@github.com/octo/my.repo\n',
    ]) {
      expect(parseGitHubRemote(url), url).toEqual(expected);
    }
    for (const url of ['', 'https://gitlab.com/octo/repo.git', 'https://github.com.evil.io/octo/repo', '/srv/git/repo.git']) {
      expect(parseGitHubRemote(url), url).toBeNull();
    }
  });

  it('builds the page that opens a pull request for a branch', () => {
    expect(compareUrl({ owner: 'octo', repo: 'repo' }, 'feature/a#1')).toBe('https://github.com/octo/repo/compare/feature/a%231?expand=1');
  });

  it('maps open pull requests to branch names, skipping forks and older duplicates', () => {
    const node = (number: number, headRefName: string, login: string, state: string | null, isDraft = false) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/octo/repo/pull/${number}`,
      isDraft,
      headRefName,
      headRepositoryOwner: { login },
      commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] },
    });
    const nodes = [
      node(9, 'feature', 'Octo', 'SUCCESS'),
      node(8, 'feature', 'octo', 'FAILURE'),
      node(7, 'main', 'someone-else', 'SUCCESS'),
      node(6, 'draft', 'octo', 'PENDING', true),
      node(5, 'broken', 'octo', 'ERROR'),
      node(4, 'constructor', 'octo', null),
    ];
    const pulls = mapPulls({ data: { repository: { pullRequests: { nodes } } } }, 'octo');
    expect(Object.keys(pulls)).toEqual(['feature', 'draft', 'broken', 'constructor']);
    expect(pulls.feature).toEqual({ number: 9, title: 'PR 9', url: 'https://github.com/octo/repo/pull/9', draft: false, checks: 'success' });
    expect(pulls.draft).toMatchObject({ draft: true, checks: 'pending' });
    expect(pulls.broken.checks).toBe('failure');
    // A branch named like something every object inherits is still just a branch.
    expect(Object.entries(pulls)[3][1].checks).toBeNull();
  });

  it('reports what GitHub refused, and copes with a repository it cannot see', () => {
    expect(() => mapPulls({ errors: [{ message: 'Bad credentials' }] }, 'octo')).toThrow('Bad credentials');
    expect(mapPulls({ data: { repository: null } }, 'octo')).toEqual({});
  });
});

describe('commit message prompt', () => {
  it('includes the diff, the new files and the style to follow', () => {
    const prompt = buildPrompt('diff --git a/a b/a\n+x\n', ['notes.md'], ['Add parser', 'Fix typo']);
    expect(prompt).toContain('- Add parser\n- Fix typo');
    expect(prompt).toContain('New files that are not in the diff:\n- notes.md');
    expect(prompt.endsWith('Diff:\ndiff --git a/a b/a\n+x\n')).toBe(true);
    expect(buildPrompt('+x', [], [])).not.toMatch(/recent commits|New files/);
  });

  it('cuts a diff that is too long to send, and says so', () => {
    const prompt = buildPrompt('x'.repeat(50_000), [], []);
    expect(prompt).toContain('Diff (truncated):');
    expect(prompt.length).toBeLessThan(21_000);
  });

  it('unwraps an answer that came in a code fence', () => {
    expect(cleanMessage('```text\nAdd parser\n\nBody.\n```\n')).toBe('Add parser\n\nBody.');
    expect(cleanMessage('  Add parser\n')).toBe('Add parser');
  });
});

describe('formatCommand', () => {
  it('quotes only the arguments that need it', () => {
    expect(formatCommand(['push', '--force-with-lease', 'origin', 'feature/x'])).toBe('git push --force-with-lease origin feature/x');
    expect(formatCommand(['commit', '-m', 'say "hi"'])).toBe('git commit -m "say \\"hi\\""');
  });
});
