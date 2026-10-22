import { describe, expect, it } from 'vitest';
import { formatCommand } from '../src/git/exec';
import {
  abortOp,
  checkoutLocalOp,
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
  deleteTagOp,
  deleteRemoteBranchOp,
  discardOp,
  fastForwardOp,
  hunkOp,
  rebaseInteractiveOp,
  rebaseOp,
  rebaseTodo,
  refNameProblem,
  undoOp,
  worktreeAddOp,
  worktreeDir,
  worktreesRoot,
  expandFormat,
  formatInputs,
  formatProblem,
  withoutRemote,
  worktreeFolderName,
  worktreeMoveOp,
  worktreeRemoveOp,
  worktreeTrackOp,
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
import { compareRangeUrl, compareUrl, mapPulls, parseGitHubRemote } from '../src/git/github';
import { buildPrompt, cleanMessage } from '../src/shared/commitPrompt';
import {
  allChanges,
  hunkPatch,
  linesPatch,
  parseBisectRefs,
  parseBlame,
  parseBlameLine,
  parseCherryMarks,
  parseCompareCommits,
  unquotePath,
  parseIdentity,
  parseHunks,
  parseLog,
  parseNameStatus,
  parsePatch,
  parseRefs,
  parseStatus,
  parseWorktrees,
  recentBranches,
  workingChanges,
} from '../src/git/parse';
import type { Branch, RepoState, Upstream, WorkingState, Worktree } from '../src/shared/protocol';
import { canFastForward, sortRefs } from '../src/shared/refs';

const F = '\x1f';

describe('parsers', () => {
  it('parses the commits of a comparison, with the side of each and the ones whose change the other side has too', () => {
    const R = '\x1e';
    const out = [`>${F}h3${F}Ann${F}1700000300${F}Fix: a${F}b`, `\n<${F}h2${F}Bob${F}1700000200${F}Main`, `\n>${F}h1${F}Ann${F}1700000100${F}`].join(R) + `${R}\n`;
    const marks = parseCherryMarks('+h3\n=h2\n=h1\n');
    expect([...marks]).toEqual(['h2', 'h1']);
    expect(parseCompareCommits(out, marks)).toEqual([
      { hash: 'h3', subject: `Fix: a${F}b`, author: 'Ann', date: 1700000300, side: 'to', equivalent: false },
      { hash: 'h2', subject: 'Main', author: 'Bob', date: 1700000200, side: 'from', equivalent: true },
      { hash: 'h1', subject: '', author: 'Ann', date: 1700000100, side: 'to', equivalent: true },
    ]);
    expect(parseCompareCommits('')).toEqual([]);
  });

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
        line('refs/heads/main', 'aaa', '', 'refs/remotes/origin/main', 'origin', 'refs/heads/main', '[ahead 3, behind 2]', '*', '1700000000'),
        line('refs/heads/old', 'bbb', '', 'refs/remotes/origin/old', 'origin', 'refs/heads/old', '[gone]', ' ', '1600000000'),
        line('refs/heads/local', 'ccc', '', '', '', '', '', ' ', '1650000000'),
        line('refs/remotes/origin/HEAD', 'aaa', '', '', '', '', '', ' ', '1700000000'),
        line('refs/remotes/origin/main', 'ddd', '', '', '', '', '', ' ', '1690000000'),
        line('refs/tags/v1', 'tagobj', 'eee', '', '', '', '', ' ', '1680000000'),
        line('refs/stash', 'fff', '', '', '', '', '', ' ', '1710000000'),
      ].join('\n') + '\n',
    );
    expect(refs.branches[0]).toEqual({
      name: 'main',
      hash: 'aaa',
      date: 1700000000,
      current: true,
      upstream: { name: 'origin/main', remote: 'origin', branch: 'main', ahead: 3, behind: 2, gone: false },
    });
    expect(refs.branches[1].upstream?.gone).toBe(true);
    expect(refs.branches[2].upstream).toBeUndefined();
    expect(refs.remoteBranches).toEqual([{ name: 'origin/main', hash: 'ddd', date: 1690000000 }]);
    expect(refs.tags).toEqual([{ name: 'v1', hash: 'eee', date: 1680000000 }]);

    // By date the latest come first; by name they stay as git lists them.
    expect(sortRefs(refs, 'date').branches.map((branch) => branch.name)).toEqual(['main', 'local', 'old']);
    expect(sortRefs(refs, 'name').branches.map((branch) => branch.name)).toEqual(['main', 'old', 'local']);
  });

  it('keeps the order of the names among branches committed to at the same time', () => {
    const refs = {
      branches: [
        { name: 'a', hash: '1', date: 5, current: false },
        { name: 'b', hash: '2', date: 9, current: false },
        { name: 'c', hash: '3', date: 5, current: true },
      ],
      remoteBranches: [],
      tags: [
        { name: 'v1', hash: '4', date: 1 },
        { name: 'v2', hash: '5', date: 2 },
      ],
    };
    const sorted = sortRefs(refs, 'date');
    expect(sorted.branches.map((branch) => branch.name)).toEqual(['b', 'a', 'c']);
    expect(sorted.tags.map((tag) => tag.name)).toEqual(['v2', 'v1']);
    expect(refs.branches[0].name).toBe('a');
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

  it('lists staged and unstaged files together, each with how much of it is staged and what it is next to HEAD', () => {
    const working = parseStatus(
      [' M a.ts', 'R  new.ts', 'old.ts', '?? c d.ts', 'D  e.ts', 'MM both.ts', 'UU clash.ts', 'AM added.ts', 'MD gone.ts', 'D  kept.ts', '?? kept.ts', 'AD never.ts', ''].join('\0'),
    );
    expect(workingChanges(working)).toEqual([
      { file: { status: 'M', path: 'a.ts' }, staged: 'none' },
      { file: { status: 'A', path: 'added.ts' }, staged: 'some' },
      { file: { status: 'M', path: 'both.ts' }, staged: 'some' },
      { file: { status: '?', path: 'c d.ts' }, staged: 'none' },
      { file: { status: 'D', path: 'e.ts' }, staged: 'all' },
      // Deleted from disk after it was staged: HEAD has it, the working tree does not.
      { file: { status: 'D', path: 'gone.ts' }, staged: 'some' },
      // Taken out of the index and left on disk: both HEAD and the working tree have it.
      { file: { status: 'M', path: 'kept.ts' }, staged: 'some' },
      { file: { status: 'A', path: 'never.ts' }, staged: 'some' },
      { file: { status: 'R', path: 'new.ts', oldPath: 'old.ts' }, staged: 'all' },
    ]);
  });

  it('parses worktrees and marks the current one', () => {
    const out = 'worktree C:/prj/app\nHEAD aaa\nbranch refs/heads/main\n\nworktree C:/prj/app-fix\nHEAD bbb\ndetached\n\n';
    expect(parseWorktrees(`${out}worktree C:/prj/gone\nHEAD ccc\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n\n`, 'c:/prj/app')).toEqual([
      { path: 'C:/prj/app', hash: 'aaa', branch: 'main', current: true, main: true, prunable: false, changes: null },
      { path: 'C:/prj/app-fix', hash: 'bbb', branch: null, current: false, main: false, prunable: false, changes: null },
      { path: 'C:/prj/gone', hash: 'ccc', branch: 'x', current: false, main: false, prunable: true, changes: null },
    ]);
    // A bare repository is listed first, and has no main worktree.
    expect(parseWorktrees(`worktree C:/prj/app.git\nbare\n\n${out}`, 'c:/prj/app-fix').map((worktree) => worktree.main)).toEqual([false, false]);
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

  it('cuts the diff of a commit into its files, and counts the lines each one gained and lost', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      'index 111..222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,3 @@',
      '-one',
      '+ONE',
      '+more',
      ' two',
      'diff --git a/logo.png b/logo.png',
      'index 333..444 100644',
      'Binary files a/logo.png and b/logo.png differ',
      'diff --git a/old.txt b/new.txt',
      'similarity index 100%',
      'rename from old.txt',
      'rename to new.txt',
      'diff --git a/z.txt b/z.txt',
      'new file mode 100644',
      'index 000..555',
      '--- /dev/null',
      '+++ b/z.txt',
      '@@ -0,0 +1 @@',
      // A line of a file that looks like the start of another is still a line: it has its sign before it.
      '+diff --git a/fake b/fake',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const files = [
      { status: 'M', path: 'a.txt' },
      { status: 'M', path: 'logo.png' },
      { status: 'R', path: 'new.txt', oldPath: 'old.txt' },
      { status: 'A', path: 'z.txt' },
    ];
    const patch = parsePatch(files, diff, 1000)!;
    expect(patch.map((file) => [file.file.path, file.added, file.removed, file.binary, file.hunks?.length])).toEqual([
      ['a.txt', 2, 1, false, 1],
      ['logo.png', 0, 0, true, 0],
      ['new.txt', 0, 0, false, 0],
      ['z.txt', 1, 0, false, 1],
    ]);
    expect(patch[0].hunks![0]).toEqual({ header: '@@ -1,2 +1,3 @@', lines: ['-one', '+ONE', '+more', ' two'] });
    expect(patch[3].hunks![0].lines).toEqual(['+diff --git a/fake b/fake', '\\ No newline at end of file']);

    // Past the lines that are sent a file keeps its counts and loses its hunks; a shorter one after it is still sent.
    const short = parsePatch(files, diff, 4)!;
    expect(short.map((file) => [file.added, file.removed, file.hunks?.length ?? null])).toEqual([
      [2, 1, null],
      [0, 0, 0],
      [0, 0, 0],
      [1, 0, 1],
    ]);

    // A diff of other files than the ones listed is not guessed at.
    expect(parsePatch(files.slice(1), diff, 1000)).toBeNull();
    expect(parsePatch([...files, { status: 'A', path: 'more.txt' }], diff, 1000)).toBeNull();
    expect(parsePatch([], '', 1000)).toEqual([]);
  });

  it('reads a file that became a link, which git prints as one deleted and one added, as one file', () => {
    const diff = [
      'diff --git a/link b/link',
      'deleted file mode 100644',
      'index 111..000',
      '--- a/link',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-a file',
      'diff --git a/link b/link',
      'new file mode 120000',
      'index 000..222',
      '--- /dev/null',
      '+++ b/link',
      '@@ -0,0 +1 @@',
      '+target',
      '\\ No newline at end of file',
      'diff --git a/z.txt b/z.txt',
      'index 333..444 100644',
      '--- a/z.txt',
      '+++ b/z.txt',
      '@@ -1 +1 @@',
      '-z',
      '+Z',
      '',
    ].join('\n');
    const patch = parsePatch(
      [
        { status: 'T', path: 'link' },
        { status: 'M', path: 'z.txt' },
      ],
      diff,
      1000,
    )!;
    expect(patch.map((file) => [file.file.path, file.added, file.removed, file.hunks?.length])).toEqual([
      ['link', 1, 1, 2],
      ['z.txt', 1, 1, 1],
    ]);
  });
});

describe('recent branches', () => {
  const moves = [
    'checkout: moving from feature to main',
    'commit: Change a',
    'checkout: moving from main to feature',
    'rebase (finish): returning to refs/heads/main',
    'checkout: moving from fix to main',
    'checkout: moving from 1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d to fix',
    'checkout: moving from gone to main',
    'checkout: moving from old to gone',
  ].join('\n');

  it('are the ones checked out last, the latest first, without the current one and the ones that are gone', () => {
    expect(recentBranches(moves, ['feature', 'fix', 'main', 'old', 'never'], 'main')).toEqual(['feature', 'fix', 'old']);
  });

  it('count the one just left when no branch is checked out, and stop at the limit', () => {
    expect(recentBranches(moves, ['feature', 'fix', 'main', 'old'], null)).toEqual(['main', 'feature', 'fix', 'old']);
    expect(recentBranches(moves, ['feature', 'fix', 'main', 'old'], null, 2)).toEqual(['main', 'feature']);
    expect(recentBranches('', ['main'], 'main')).toEqual([]);
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

describe('fast-forward', () => {
  const upstream = (overrides: Partial<Upstream> = {}): Upstream => ({
    name: 'up/main',
    remote: 'up',
    branch: 'main',
    ahead: 0,
    behind: 2,
    gone: false,
    ...overrides,
  });
  const state = (branch: Partial<Branch>, worktrees: Partial<Worktree>[] = []): RepoState =>
    ({
      branches: [
        { name: 'work', hash: 'aaa', current: true },
        { name: 'feature', hash: 'bbb', current: false, ...branch },
      ],
      worktrees,
    }) as Partial<RepoState> as RepoState;
  const offered = (branch: Partial<Branch>, worktrees: Partial<Worktree>[] = []) => {
    const repo = state(branch, worktrees);
    return canFastForward(repo.branches[1], repo);
  };

  it('fetches the remote branch of the upstream into the branch, named in full', () => {
    expect(fastForwardOp('feature', state({ upstream: upstream() }))).toMatchObject({
      title: 'Fast-forward feature to up/main',
      commands: [['fetch', 'up', 'refs/heads/main:refs/heads/feature']],
    });
    // Without a `+`, git refuses anything but a fast-forward.
    expect(fastForwardOp('feature', state({ upstream: upstream() })).commands[0][2]).not.toMatch(/^\+/);
  });

  it('fetches from this repository when the upstream is a local branch', () => {
    const local = upstream({ name: 'main', remote: '.' });
    expect(fastForwardOp('feature', state({ upstream: local })).commands).toEqual([['fetch', '.', 'refs/heads/main:refs/heads/feature']]);
  });

  it('is offered for a branch with no commits of its own, even when the last fetch saw nothing new', () => {
    expect(offered({ upstream: upstream() })).toBe(true);
    expect(offered({ upstream: upstream({ behind: 0 }) })).toBe(true);
  });

  it('is not offered for what git would refuse or what Pull already does', () => {
    expect(offered({})).toBe(false);
    expect(offered({ upstream: upstream({ ahead: 1 }) })).toBe(false);
    expect(offered({ upstream: upstream({ gone: true }) })).toBe(false);
    expect(offered({ current: true, upstream: upstream() })).toBe(false);
    expect(offered({ upstream: upstream() }, [{ branch: 'feature', current: false }])).toBe(false);
    expect(() => fastForwardOp('feature', state({ upstream: upstream({ ahead: 1 }) }))).toThrow(/cannot be fast-forwarded/);
    expect(() => fastForwardOp('missing', state({ upstream: upstream() }))).toThrow(/cannot be fast-forwarded/);
  });
});

describe('operations', () => {
  const hash = 'a'.repeat(40);

  it('checks out branches, remote branches and detached commits differently', () => {
    expect(checkoutOp('branch', 'dev').commands).toEqual([['checkout', 'dev']]);
    expect(checkoutOp('remote', 'origin/dev').commands).toEqual([['checkout', '--track', 'origin/dev']]);
    expect(checkoutOp('detached', hash).commands).toEqual([['checkout', '--detach', hash]]);
  });

  it('checks out a remote branch in the local branch of its name, brought up to it', () => {
    const local = { name: 'dev', current: false, ahead: 0, behind: 0 };
    expect(checkoutLocalOp('origin/dev', local).commands).toEqual([['checkout', 'dev']]);
    expect(checkoutLocalOp('origin/dev', { ...local, behind: 2 }).commands).toEqual([['checkout', 'dev'], ['merge', '--ff-only', 'origin/dev']]);
    expect(checkoutLocalOp('origin/dev', { ...local, current: true, behind: 2 }).commands).toEqual([['merge', '--ff-only', 'origin/dev']]);
    // With commits of its own, it is only checked out, unless they are to be rebased.
    expect(checkoutLocalOp('origin/dev', { ...local, ahead: 1, behind: 2 }).commands).toEqual([['checkout', 'dev']]);
    expect(checkoutLocalOp('origin/dev', { ...local, ahead: 1, behind: 2 }, true)).toMatchObject({
      title: 'Check out dev and rebase it onto origin/dev',
      commands: [['rebase', '--autostash', 'origin/dev', 'dev']],
    });
  });

  it('creates branches and tags at a given commit', () => {
    expect(createBranchOp('fix', hash, true).commands).toEqual([['checkout', '-b', 'fix', hash]]);
    expect(createBranchOp('fix', hash, false).commands).toEqual([['branch', 'fix', hash]]);
    expect(createTagOp('v1', hash, '').commands).toEqual([['tag', 'v1', hash]]);
    expect(createTagOp('v1', hash, 'First release').commands).toEqual([['tag', '-a', 'v1', '-m', 'First release', hash]]);
  });

  it('asks before deleting a branch, and only treats the forced delete as dangerous', () => {
    expect(deleteBranchOp('old', false)).toMatchObject({ commands: [['branch', '-d', 'old']], confirm: true });
    expect(deleteBranchOp('old', false).danger).toBeFalsy();
    expect(deleteBranchOp('old', true)).toMatchObject({ commands: [['branch', '-D', 'old']], danger: true });
  });

  it('warns before deleting a tag that it stays on the remotes', () => {
    expect(deleteTagOp('v1', hash)).toMatchObject({ commands: [['tag', '-d', 'v1']], danger: true });
    expect(deleteTagOp('v1', hash).note).toContain('on aaaaaaa');
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
    // Applying is asked too, and popping says when the stash stays.
    expect(stashOp('apply', 'stash@{0}')).toMatchObject({ confirm: true, note: expect.stringContaining('stays in the list') });
    expect(stashOp('pop', 'stash@{0}')).toMatchObject({ confirm: true, note: expect.stringContaining('with conflicts it stays') });
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
    // With its branch, which goes only if it is merged, forced or not.
    const both = worktreeRemoveOp('C:/prj/app-fix', false, 'fix');
    expect(both.commands).toEqual([['worktree', 'remove', 'C:/prj/app-fix'], ['branch', '-d', 'fix']]);
    expect(both.fallback?.op.commands).toEqual([['worktree', 'remove', '--force', 'C:/prj/app-fix'], ['branch', '-d', 'fix']]);
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
    expect(worktreeAddOp('../wt', hash, 'fix', true).commands).toEqual([['worktree', 'add', '--no-track', '-b', 'fix', '../wt', hash]]);
    expect(worktreeAddOp('../wt', hash, null, true).commands).toEqual([['worktree', 'add', '--detach', '../wt', hash]]);
    expect(worktreeTrackOp('../wt', 'feature', 'origin/feature').commands).toEqual([['worktree', 'add', '--track', '-b', 'feature', '../wt', 'origin/feature']]);
  });

  it('names branches from a format, with inputs, the base without its remote, the repository and the date', () => {
    const format = 'PRJ-${input:ticket}-${input:kind}-rfi-${base}';
    expect(formatInputs(`${format}-\${input:ticket}`)).toEqual(['ticket', 'kind']);
    expect(formatProblem(format, ['ticket', 'kind'])).toBeUndefined();
    expect(formatProblem(format, ['ticket'])).toMatch(/\$\{input:kind\}, which gitardo\.branches\.inputs does not define/);
    expect(formatProblem('${branch}-x', [])).toMatch(/\$\{branch\}, which is not one of/);
    const values = { base: 'feature/login', repo: 'app', date: '2026-10-15', inputs: { ticket: '123', kind: 'feat' } };
    expect(expandFormat(format, values)).toBe('PRJ-123-feat-rfi-feature/login');
    expect(expandFormat('${repo}/${date}', values)).toBe('app/2026-10-15');
    expect(withoutRemote('origin/feature/login', ['origin'])).toBe('feature/login');
    expect(withoutRemote('team/fork/fix', ['team', 'team/fork'])).toBe('fix');
    expect(withoutRemote('main', ['origin'])).toBe('main');
  });

  it('puts new worktrees in the folder the setting names, each in a folder named after it', () => {
    // Slashes make folders in folders, as they do in the names of branches.
    expect(worktreeDir('C:/prj/app', '${repo}.worktrees', 'feature/login')).toBe('C:/prj/app.worktrees/feature/login');
    expect(worktreesRoot('C:/prj/app', '')).toBe('C:/prj/app.worktrees');
    expect(worktreeFolderName('a\\b//c d')).toBe('a/b/c-d');
    expect(worktreeDir('C:\\prj\\app\\', '', 'fix')).toBe('C:/prj/app.worktrees/fix');
    expect(worktreeDir('/home/me/app', './trees/${repo}', 'fix')).toBe('/home/me/trees/app/fix');
    expect(worktreeDir('/home/me/app', '/tmp/wt/', 'fix')).toBe('/tmp/wt/fix');
    expect(worktreeDir('C:/prj/app', 'D:\\wt', 'fix')).toBe('D:/wt/fix');
    expect(worktreeFolderName('-odd name!/')).toBe('odd-name');
    expect(worktreeFolderName('///')).toBe('worktree');
  });

  it('renames a worktree, and its branch when asked', () => {
    expect(worktreeMoveOp('C:/prj/wt/fix', 'C:/prj/wt/auth').commands).toEqual([['worktree', 'move', 'C:/prj/wt/fix', 'C:/prj/wt/auth']]);
    expect(worktreeMoveOp('C:/prj/wt/fix', 'C:/prj/wt/auth', { from: 'fix', to: 'auth' })).toMatchObject({
      title: 'Rename worktree to auth and branch fix to auth',
      commands: [
        ['worktree', 'move', 'C:/prj/wt/fix', 'C:/prj/wt/auth'],
        ['branch', '-m', 'fix', 'auth'],
      ],
    });
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

  it('removes the worktrees of the branches it cleans up first, forcing only the ones with files not committed', () => {
    const op = cleanupBranchesOp(['done', 'gone'], ['wip'], [
      { path: 'C:/wt/done', dirty: false, prunable: false },
      { path: 'C:/wt/wip', dirty: true, prunable: false },
      { path: 'C:/wt/gone', dirty: false, prunable: true },
    ]);
    expect(op.commands).toEqual([
      ['worktree', 'prune'],
      ['worktree', 'remove', 'C:/wt/done'],
      ['worktree', 'remove', '--force', 'C:/wt/wip'],
      ['branch', '-d', 'done', 'gone'],
      ['branch', '-D', 'wip'],
    ]);
    expect(op.title).toBe('Delete 3 branches and 3 worktrees');
    expect(op).toMatchObject({ danger: true, note: expect.stringContaining('files not committed, which are deleted with them: C:/wt/wip') });
    const clean = cleanupBranchesOp(['done'], [], [{ path: 'C:/wt/done', dirty: false, prunable: false }]);
    expect(clean).toMatchObject({ title: 'Delete 1 branch and 1 worktree', confirm: true });
    expect(clean.danger).toBeUndefined();
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

describe('blame of a whole file', () => {
  const [first, second, none] = ['a'.repeat(40), 'b'.repeat(40), '0'.repeat(40)];
  const about = (author: string, time: number, summary: string) => [
    `author ${author}`,
    'author-mail <someone@x.io>',
    `author-time ${time}`,
    'author-tz +0100',
    'committer Bob',
    'committer-time 1700000500',
    `summary ${summary}`,
  ];
  const incremental = [
    `${second} 2 2 1`,
    ...about('Bob Ray', 1700000400, 'Shout'),
    `previous ${first} a.txt`,
    'filename a.txt',
    `${none} 5 5 1`,
    ...about('Not Committed Yet', 1700000900, 'Version of a.txt from standard input'),
    'filename a.txt',
    `${first} 1 1 1`,
    ...about('Ann Lee', 1700000000, 'author of nothing'),
    'boundary',
    'filename a.txt',
    // A commit that was described already is only named.
    `${first} 3 3 2`,
    'filename a.txt',
    '',
  ].join('\n');

  it('gives each line the commit that changed it last, whatever the order they are told in', () => {
    const lines = parseBlame(incremental);
    expect(lines.map((line) => line.hash)).toEqual([first, second, first, first, none]);
    expect(lines[0]).toEqual({ hash: first, author: 'Ann Lee', date: 1700000000, summary: 'author of nothing', committed: true });
    expect(lines[1]).toMatchObject({ author: 'Bob Ray', summary: 'Shout', committed: true, previous: { hash: first, file: 'a.txt' } });
    expect(lines[0].previous).toBeUndefined();
    expect(lines[4].committed).toBe(false);
    // The lines of a commit are told apart from the others by being the same object.
    expect(lines[3]).toBe(lines[0]);
  });

  it('reads the name a file had before, as git writes names that are not plain', () => {
    const renamed = incremental.replace(`previous ${first} a.txt`, `previous ${first} "caff\\303\\250 \\"old\\"\\tname.txt"`);
    expect(parseBlame(renamed)[1].previous).toEqual({ hash: first, file: 'caffè "old"\tname.txt' });
    expect(unquotePath('plain name.txt')).toBe('plain name.txt');
    expect(unquotePath('"back\\\\slash"')).toBe('back\\slash');
  });

  it('has no lines for output that is not a blame', () => {
    expect(parseBlame('')).toEqual([]);
    expect(parseBlame('fatal: no such path')).toEqual([]);
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

  it('builds the page that compares two branches, tags or commits', () => {
    expect(compareRangeUrl({ owner: 'octo', repo: 'repo' }, 'main', 'feature/a#1', '...')).toBe('https://github.com/octo/repo/compare/main...feature/a%231');
    expect(compareRangeUrl({ owner: 'octo', repo: 'repo' }, 'v1.0', '1a2b3c4', '..')).toBe('https://github.com/octo/repo/compare/v1.0..1a2b3c4');
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
