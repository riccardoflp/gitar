import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from '../src/git/exec';
import {
  checkoutOp,
  commitOp,
  createBranchOp,
  createTagOp,
  deleteBranchOp,
  discardOp,
  hunkOp,
  mergeOp,
  rebaseOp,
  remoteAddOp,
  stageAllOp,
  stageOp,
  stashOp,
  stashPushOp,
  syncOp,
  unstageOp,
  type GitOp,
} from '../src/git/ops';
import { hunkPatch } from '../src/git/parse';
import { Repo } from '../src/git/repo';
import { laneCount } from '../src/shared/graph';
import { refArg } from '../src/shared/refs';

// Repositories that are not like the tidy ones of the other tests: names that mean something to git or to a shell,
// histories with holes, several roots, three parents. On Windows a file name cannot hold quotes, colons or newlines,
// so those are left to other systems.

let dir: string;
let root: string;
let repo: Repo;

const run = async (op: GitOp, cwd = root) => {
  for (const [index, args] of op.commands.entries()) {
    await git(cwd, args, { input: index === op.commands.length - 1 ? op.input : undefined });
  }
};
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
};
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const state = () => repo.state(100);
const commitAll = async (message: string) => {
  await run(stageAllOp());
  await run(commitOp(message, false, false));
  return (await state()).head!;
};
const paths = (files: { path: string }[]) => files.map((file) => file.path).sort();

async function init(folder: string) {
  fs.mkdirSync(folder, { recursive: true });
  await git(folder, ['init', '--initial-branch=main']);
  await git(folder, ['config', 'user.name', 'Gitar Test']);
  await git(folder, ['config', 'user.email', 'test@gitar.invalid']);
  await git(folder, ['config', 'commit.gpgsign', 'false']);
  await git(folder, ['config', 'core.autocrlf', 'false']);
}

beforeEach(async () => {
  // The folder itself has a space and an accent in its name.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitar è '));
  await init(path.join(dir, 'my repo'));
  root = (await Repo.discover(path.join(dir, 'my repo')))!;
  repo = new Repo(root);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('awkward repositories', { timeout: 60_000 }, () => {
  it('shows what is waiting for the first commit, in a repository that has none', async () => {
    let before = await state();
    expect(before).toMatchObject({ head: null, branch: 'main', rows: [], changes: 0 });

    write('first file.txt', 'hello\n');
    before = await state();
    expect(before.rows).toMatchObject([{ hash: 'WORKTREE', parents: [], subject: 'Uncommitted changes (1)' }]);
    expect(laneCount(before.rows[0].graph)).toBe(1);
    expect(paths((await repo.commitDetail('WORKTREE'))!.files)).toEqual(['first file.txt']);

    const head = await commitAll('First');
    expect((await state()).rows.map((row) => row.hash)).toEqual([head]);
  });

  const NAMES = ['with space.txt', 'città/日本語.txt', '-dash.txt', "it's.txt", 'a&b #1 %20 (copy).txt', 'pages/[id].txt', '$HOME.txt'];

  it('stages, unstages, cuts into hunks, discards and stashes files whatever their names', async () => {
    for (const name of NAMES) write(name, 'one\n');
    expect(paths((await state()).working.unstaged)).toEqual([...NAMES].sort());
    await commitAll('Add awkward files');

    const detail = await repo.commitDetail((await state()).head!);
    expect(paths(detail!.files)).toEqual([...NAMES].sort());

    for (const name of NAMES) write(name, 'one\ntwo\n');
    for (const name of NAMES) {
      await run(stageOp([name]));
      expect(paths((await state()).working.staged), name).toEqual([name]);
      expect(await repo.show(':0', name), name).toBe('one\ntwo\n');
      expect((await repo.hunks(name, true)).hunks, name).toHaveLength(1);
      await run(unstageOp([name], true));
      expect((await state()).working.staged, name).toEqual([]);

      const hunks = await repo.hunks(name, false);
      expect(hunks.hunks, name).toHaveLength(1);
      await run(hunkOp('stageHunk', name, hunkPatch(hunks, hunks.hunks[0])));
      expect(paths((await state()).working.staged), name).toEqual([name]);
      await run(unstageOp([name], true));

      expect((await repo.blameLine(name, 1))?.summary, name).toBe('Add awkward files');
      expect((await repo.state(100, { kind: 'path', path: name })).rows.map((row) => row.subject), name).toEqual(['Add awkward files']);
    }

    await run(stashPushOp('one file', { paths: ['pages/[id].txt'] }));
    expect(paths((await state()).working.unstaged)).toEqual(NAMES.filter((name) => name !== 'pages/[id].txt').sort());
    await run(stashOp('pop', 'stash@{0}'));

    for (const name of NAMES) {
      await run(discardOp([name], (await state()).working));
      expect(read(name), name).toBe('one\n');
    }
    expect((await state()).changes).toBe(0);
  });

  it('takes a name with brackets as that file, not as a pattern that other files match too', async () => {
    // What a framework with routes in the file names has: `[id]` is also the pattern for a file called `i` or `d`.
    for (const name of ['pages/[id].txt', 'pages/i.txt', 'pages/d.txt']) write(name, 'one\n');
    await commitAll('Add pages');
    for (const name of ['pages/[id].txt', 'pages/i.txt', 'pages/d.txt']) write(name, 'changed\n');
    write('pages/[new].txt', 'untracked\n');
    write('pages/n.txt', 'untracked\n');

    await run(stageOp(['pages/[id].txt']));
    expect(paths((await state()).working.staged)).toEqual(['pages/[id].txt']);
    expect((await repo.hunks('pages/[id].txt', true)).hunks).toHaveLength(1);
    await run(unstageOp(['pages/[id].txt'], true));
    expect((await state()).working.staged).toEqual([]);

    expect((await repo.hunks('pages/[id].txt', false)).hunks).toHaveLength(1);

    await run(stashPushOp('one page', { paths: ['pages/[id].txt'] }));
    expect(read('pages/i.txt')).toBe('changed\n');
    await run(stashOp('pop', 'stash@{0}'));

    // The one that loses work if it reaches further than it was asked to.
    await run(discardOp(['pages/[id].txt', 'pages/[new].txt'], (await state()).working));
    expect(read('pages/[id].txt')).toBe('one\n');
    expect(read('pages/i.txt')).toBe('changed\n');
    expect(read('pages/d.txt')).toBe('changed\n');
    expect(fs.existsSync(path.join(root, 'pages/[new].txt'))).toBe(false);
    expect(read('pages/n.txt')).toBe('untracked\n');
  });

  it('reads every state a file can be in at once', async () => {
    write('renamed-from.txt', 'a file long enough for git to recognize it after it has been renamed\n');
    write('both.txt', 'one\n');
    write('gone.txt', 'one\n');
    write('staged-gone.txt', 'one\n');
    write('image.bin', Buffer.from([0, 1, 2, 3, 0, 255]).toString('latin1'));
    await commitAll('Base');

    await git(root, ['mv', 'renamed-from.txt', 'renamed-to.txt']);
    fs.appendFileSync(path.join(root, 'renamed-to.txt'), 'and changed after the rename\n');
    write('both.txt', 'staged\n');
    await run(stageOp(['both.txt']));
    write('both.txt', 'staged\nand not\n');
    fs.rmSync(path.join(root, 'gone.txt'));
    await git(root, ['rm', '--quiet', 'staged-gone.txt']);
    write('added-then-deleted.txt', 'x\n');
    await run(stageOp(['added-then-deleted.txt']));
    fs.rmSync(path.join(root, 'added-then-deleted.txt'));
    fs.writeFileSync(path.join(root, 'image.bin'), Buffer.from([9, 9, 0, 9]));

    const { working } = await state();
    expect(working.staged).toEqual(
      expect.arrayContaining([
        { status: 'R', path: 'renamed-to.txt', oldPath: 'renamed-from.txt' },
        { status: 'M', path: 'both.txt' },
        { status: 'D', path: 'staged-gone.txt' },
        { status: 'A', path: 'added-then-deleted.txt' },
      ]),
    );
    expect(working.unstaged).toEqual(
      expect.arrayContaining([
        { status: 'M', path: 'renamed-to.txt' },
        { status: 'M', path: 'both.txt' },
        { status: 'D', path: 'gone.txt' },
        { status: 'D', path: 'added-then-deleted.txt' },
        { status: 'M', path: 'image.bin' },
      ]),
    );
    expect((await repo.hunks('image.bin', false)).binary).toBe(true);
    expect((await repo.hunks('gone.txt', false)).hunks).toHaveLength(1);

    await run(discardOp(['gone.txt', 'both.txt'], working));
    expect(read('gone.txt')).toBe('one\n');
    // Back to what is staged, not to the last commit.
    expect(read('both.txt')).toBe('staged\n');
  });

  it('works on a detached HEAD, and on one in a history that was cut short', async () => {
    write('a.txt', 'one\n');
    const first = await commitAll('First');
    write('a.txt', 'two\n');
    await commitAll('Second');
    write('a.txt', 'three\n');
    const third = await commitAll('Third');

    await run(checkoutOp('detached', first));
    let now = await state();
    expect(now).toMatchObject({ head: first, branch: null });
    expect(now.rows.map((row) => row.subject)).toEqual(['Third', 'Second', 'First']);
    write('a.txt', 'detached\n');
    const loose = await commitAll('On no branch');
    now = await state();
    expect(now.head).toBe(loose);
    // A commit that no branch has still shows, for as long as it is the one checked out.
    expect(now.rows.find((row) => row.hash === loose)).toMatchObject({ subject: 'On no branch', parents: [first] });
    await run(checkoutOp('branch', 'main'));

    // A clone that only has the last commit: its parent is named but not there.
    const shallow = path.join(dir, 'shallow');
    await git(dir, ['clone', '--quiet', '--depth', '1', `file://${root}`, shallow]);
    const cut = new Repo((await Repo.discover(shallow))!);
    const cutState = await cut.state(100);
    expect(cutState.rows.map((row) => row.subject)).toEqual(['Third']);
    expect(cutState.head).toBe(third);
    const detail = await cut.commitDetail(third);
    expect(detail).toMatchObject({ subject: 'Third' });
    // Nothing to compare it with: every file it has counts as added.
    expect(detail!.files).toEqual([{ status: 'A', path: 'a.txt' }]);
    expect((await cut.blameLine('a.txt', 1))?.summary).toBe('Third');
  });

  it('draws histories with several roots and merges of three branches', async () => {
    write('a.txt', 'a\n');
    await commitAll('Root of main');
    for (const name of ['one', 'two']) {
      await run(createBranchOp(name, 'main', true));
      write(`${name}.txt`, `${name}\n`);
      await commitAll(`On ${name}`);
      await run(checkoutOp('branch', 'main'));
    }
    write('main.txt', 'main\n');
    await commitAll('On main');
    await git(root, ['merge', '--quiet', '-m', 'Merge three', 'one', 'two']);
    await git(root, ['checkout', '--quiet', '--orphan', 'unrelated']);
    await git(root, ['rm', '-rf', '--quiet', '.']);
    write('other.txt', 'other\n');
    await commitAll('Another root');

    const now = await state();
    const merge = now.rows.find((row) => row.subject === 'Merge three')!;
    expect(merge.parents).toHaveLength(3);
    expect(now.rows.filter((row) => row.parents.length === 0).map((row) => row.subject).sort()).toEqual(['Another root', 'Root of main']);
    // Every line of the graph ends: nothing is left waiting below the last row.
    const last = now.rows.at(-1)!;
    expect(last.graph.bottom).toEqual([]);
    expect(Math.max(...now.rows.map((row) => laneCount(row.graph)))).toBeLessThanOrEqual(4);

    const detail = await repo.commitDetail(merge.hash);
    // Against the first parent, a merge brings what the other branches added.
    expect(paths(detail!.files)).toEqual(['one.txt', 'two.txt']);
  });

  it('means the branch when a tag has the same name', async () => {
    write('a.txt', 'one\n');
    const first = await commitAll('First');
    await run(createTagOp('release', first, ''));
    await run(createBranchOp('release', 'HEAD', true));
    write('a.txt', 'two\n');
    const onBranch = await commitAll('On the branch');
    await run(checkoutOp('branch', 'main'));
    write('b.txt', 'main\n');
    await commitAll('On main');

    const now = await state();
    expect(now.branches.find((branch) => branch.name === 'release')?.hash).toBe(onBranch);
    expect(now.tags.find((tag) => tag.name === 'release')?.hash).toBe(first);

    expect(refArg('branch', 'release', now)).toBe('refs/heads/release');
    expect(refArg('tag', 'release', now)).toBe('refs/tags/release');
    // A name that only one thing has stays as it is.
    expect(refArg('branch', 'main', now)).toBe('main');

    // By its short name git would merge the tag, which is already part of main: nothing would happen.
    await run(mergeOp(refArg('branch', 'release', now), 'main'));
    expect(read('a.txt')).toBe('two\n');

    await run(checkoutOp('detached', refArg('tag', 'release', now)));
    expect((await state()).head).toBe(first);
    await run(checkoutOp('branch', 'release'));
    expect(await state()).toMatchObject({ branch: 'release', head: onBranch });

    // A push by the short name is refused, as it could be either.
    const remote = path.join(dir, 'remote.git');
    await git(dir, ['init', '--quiet', '--bare', remote]);
    await run(remoteAddOp('origin', remote.replaceAll('\\', '/')));
    const push = syncOp('push', await state());
    expect(push.commands).toEqual([['push', '--set-upstream', 'origin', 'refs/heads/release']]);
    await run(push);
    expect((await git(remote, ['rev-parse', 'refs/heads/release'])).stdout.trim()).toBe(onBranch);
    expect((await state()).branches.find((branch) => branch.current)?.upstream).toMatchObject({ name: 'origin/release', ahead: 0 });
    write('a.txt', 'three\n');
    await commitAll('More on the branch');
    await run(syncOp('push', await state()));
    expect((await git(remote, ['rev-parse', 'refs/heads/release'])).stdout.trim()).toBe((await state()).head);

    await run(checkoutOp('branch', 'main'));
    await run(rebaseOp(refArg('branch', 'release', await state()), 'main'));
    expect(read('a.txt')).toBe('three\n');
    await run(deleteBranchOp('release'));
    expect((await state()).branches.map((branch) => branch.name)).toEqual(['main']);
    expect((await state()).tags.map((tag) => tag.name)).toEqual(['release']);
  });

  it('keeps messages whole: long ones, empty ones, and ones with characters of every kind', async () => {
    const subject = 'Fix “quotes” — naïve café 日本語 🎉\tand a tab';
    const body = `${'A long line of the body.'.repeat(400)}\n\n- a list\n- with <tags> & "quotes"\n`;
    write('a.txt', 'one\n');
    await run(stageAllOp());
    await run(commitOp(`${subject}\n\n${body}`, false, false));
    write('a.txt', 'two\n');
    await run(stageAllOp());
    await git(root, ['commit', '--quiet', '--allow-empty-message', '-m', '']);

    const now = await state();
    expect(now.rows.map((row) => row.subject)).toEqual(['', subject]);
    const detail = await repo.commitDetail(now.rows[1].hash);
    expect(detail!.subject).toBe(subject);
    expect(detail!.body.trim()).toBe(body.trim());
    expect((await repo.state(100, { kind: 'message', query: 'café 日本語' })).rows).toHaveLength(1);
  });

  it('lists a submodule as one entry, changed when it points elsewhere', async () => {
    const library = path.join(dir, 'library');
    await init(library);
    fs.writeFileSync(path.join(library, 'lib.txt'), 'one\n');
    await git(library, ['add', '.']);
    await git(library, ['commit', '--quiet', '-m', 'Library']);

    write('a.txt', 'one\n');
    await commitAll('First');
    await git(root, ['-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', `file://${library.replaceAll('\\', '/')}`, 'vendor/lib']);
    expect(paths((await state()).working.staged)).toEqual(['.gitmodules', 'vendor/lib']);
    const added = await commitAll('Add the library');
    expect(paths((await repo.commitDetail(added))!.files)).toEqual(['.gitmodules', 'vendor/lib']);

    const inside = path.join(root, 'vendor', 'lib');
    fs.writeFileSync(path.join(inside, 'lib.txt'), 'two\n');
    await git(inside, ['-c', 'user.name=Gitar Test', '-c', 'user.email=test@gitar.invalid', 'commit', '--quiet', '-am', 'Library moves on']);

    const now = await state();
    expect(now.working.unstaged).toEqual([{ status: 'M', path: 'vendor/lib' }]);
    const hunks = await repo.hunks('vendor/lib', false);
    expect(hunks.hunks).toHaveLength(1);
    expect(hunks.hunks[0].lines.join('\n')).toMatch(/-Subproject commit \w+\n\+Subproject commit \w+/);
    await run(stageOp(['vendor/lib']));
    expect((await state()).working.staged).toEqual([{ status: 'M', path: 'vendor/lib' }]);

    // In the tab of a commit a submodule is one file with two lines, however git is set up to print it.
    await git(root, ['config', 'diff.submodule', 'log']);
    const moved = await commitAll('Move the library on');
    const patch = await repo.commitPatch((await repo.commitDetail(moved))!, 1000);
    expect(patch).toMatchObject([{ file: { status: 'M', path: 'vendor/lib' }, added: 1, removed: 1, binary: false }]);
    expect(patch![0].hunks![0].lines.join('\n')).toMatch(/^-Subproject commit \w+\n\+Subproject commit \w+$/);
  });

  it('says what a commit changed in each of its files, whatever they are called and however git is told to print', async () => {
    // What a user may have in their configuration, each of which changes what `git diff` prints.
    for (const [key, value] of [
      ['color.ui', 'always'],
      ['diff.noprefix', 'true'],
      ['diff.mnemonicPrefix', 'true'],
      ['diff.renames', 'copies'],
      ['core.quotePath', 'true'],
    ]) {
      await git(root, ['config', key, value]);
    }

    for (const name of NAMES) write(name, 'one\ntwo\nthree\n');
    write('logo.bin', '\0\x01\x02binary');
    write('gone.txt', 'going\n');
    write('old name.txt', `${'a line that stays\n'.repeat(20)}`);
    const first = await commitAll('Add awkward files');

    // The first commit of all: every file is added, and none is taken for the copy of another.
    const added = await repo.commitPatch((await repo.commitDetail(first))!, 10_000);
    expect(added!.map((file) => file.file)).toEqual((await repo.commitDetail(first))!.files);
    expect(added!.every((file) => file.file.status === 'A' && file.removed === 0)).toBe(true);
    expect(added!.find((file) => file.file.path === 'logo.bin')).toMatchObject({ binary: true, added: 0, hunks: [] });
    expect(added!.find((file) => file.file.path === 'città/日本語.txt')).toMatchObject({ added: 3, hunks: [{ lines: ['+one', '+two', '+three'] }] });

    for (const name of NAMES) write(name, 'one\n2\nthree\nfour\n');
    write('logo.bin', '\0\x01\x03other');
    fs.rmSync(path.join(root, 'gone.txt'));
    fs.renameSync(path.join(root, 'old name.txt'), path.join(root, 'new name.txt'));
    write('empty.txt', '');
    const second = await commitAll('Change them all');

    const detail = (await repo.commitDetail(second))!;
    const patch = (await repo.commitPatch(detail, 10_000))!;
    // File by file as the details list them, which is what the tab shows them by.
    expect(patch.map((file) => file.file)).toEqual(detail.files);
    for (const name of NAMES) {
      expect(patch.find((file) => file.file.path === name), name).toMatchObject({
        file: { status: 'M' },
        added: 2,
        removed: 1,
        binary: false,
        hunks: [{ header: '@@ -1,3 +1,4 @@', lines: [' one', '-two', '+2', ' three', '+four'] }],
      });
    }
    expect(patch.find((file) => file.file.path === 'logo.bin')).toMatchObject({ file: { status: 'M' }, binary: true, hunks: [] });
    expect(patch.find((file) => file.file.path === 'gone.txt')).toMatchObject({ file: { status: 'D' }, added: 0, removed: 1 });
    expect(patch.find((file) => file.file.path === 'new name.txt')).toMatchObject({ file: { status: 'R', oldPath: 'old name.txt' }, added: 0, removed: 0, hunks: [] });
    expect(patch.find((file) => file.file.path === 'empty.txt')).toMatchObject({ file: { status: 'A' }, added: 0, removed: 0, hunks: [] });

    // With room for a few lines only, the first files are sent whole and the others counted.
    const few = (await repo.commitPatch(detail, 12))!;
    expect(few.filter((file) => file.hunks?.length).length).toBe(2);
    expect(few.filter((file) => !file.hunks).length).toBe(NAMES.length - 2 + 1);
    expect(few.reduce((sum, file) => sum + file.added, 0)).toBe(NAMES.length * 2);
  });

  it('shows a merge by what it changed against its first parent, in the lines as in the list of files', async () => {
    write('a.txt', 'base\n');
    await commitAll('Base');
    await run(createBranchOp('feature', 'HEAD', true));
    write('b.txt', 'from the feature\n');
    await commitAll('Feature');
    await run(checkoutOp('branch', 'main'));
    write('a.txt', 'base\nmain\n');
    await commitAll('Main');
    await run(mergeOp('feature', 'main'));

    const detail = (await repo.commitDetail((await state()).head!))!;
    expect(detail.parents).toHaveLength(2);
    expect(await repo.commitPatch(detail, 1000)).toMatchObject([{ file: { status: 'A', path: 'b.txt' }, added: 1, removed: 0 }]);
  });
});
