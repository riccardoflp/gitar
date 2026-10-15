import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from '../src/git/exec';
import {
  repoNameOfUrl,
  submoduleAddOp,
  submoduleDeinitOp,
  submoduleRecordOp,
  submoduleRemoveOp,
  submoduleSyncOp,
  submoduleUpdateOp,
  type GitOp,
} from '../src/git/ops';
import { parseBranchStatus, parseGitlinks, parseGitmodules } from '../src/git/parse';
import { Repo } from '../src/git/repo';
import type { Submodule } from '../src/shared/protocol';
import { submoduleDepth, submoduleFolder, submoduleStatus, submoduleStatusText } from '../src/shared/submodules';

describe('submodule parsers', () => {
  it('reads .gitmodules, names with dots included, and leaves out entries without a path', () => {
    const out = [
      'submodule.vendor/lib.path\nvendor/lib',
      'submodule.vendor/lib.url\nhttps://example.com/lib.git',
      'submodule.v1.2.path\nthird\\party/',
      'submodule.v1.2.url\n../v12.git',
      'submodule.v1.2.branch\nstable',
      'submodule.broken.url\nhttps://example.com/broken.git',
      '',
    ].join('\0');
    expect(parseGitmodules(out)).toEqual([
      { name: 'vendor/lib', path: 'vendor/lib', url: 'https://example.com/lib.git', branch: null },
      { name: 'v1.2', path: 'third/party', url: '../v12.git', branch: 'stable' },
    ]);
  });

  it('keeps the commits recorded for submodules, from the tree or the index', () => {
    const tree = ['100644 blob aaa\tREADME.md', '160000 commit bbb\tvendor/lib', ''].join('\0');
    expect(parseGitlinks(tree, 'tree')).toEqual(new Map([['vendor/lib', 'bbb']]));
    const index = ['100644 aaa 0\tREADME.md', '160000 ccc 0\tvendor/lib', ''].join('\0');
    expect(parseGitlinks(index, 'index')).toEqual(new Map([['vendor/lib', 'ccc']]));
  });

  it('reads the commit, the branch and the changes of a submodule, counting a rename once', () => {
    const out = [
      '# branch.oid 1234567890abcdef',
      '# branch.head (detached)',
      '1 .M N... 100644 100644 100644 aaa aaa a.txt',
      '2 R. N... 100644 100644 100644 bbb bbb R100 new.txt',
      'old.txt',
      '? untracked.txt',
      '',
    ].join('\0');
    expect(parseBranchStatus(out)).toEqual({ head: '1234567890abcdef', branch: null, changes: 3 });
    expect(parseBranchStatus('# branch.oid (initial)\0# branch.head main\0')).toEqual({ head: null, branch: 'main', changes: 0 });
  });

  it('names the folder of a submodule after its URL', () => {
    expect(repoNameOfUrl('https://github.com/owner/lib.git')).toBe('lib');
    expect(repoNameOfUrl('git@github.com:owner/lib.git')).toBe('lib');
    expect(repoNameOfUrl('C:\\repos\\lib\\')).toBe('lib');
  });
});

describe('submodule operations', () => {
  const nested: Submodule = {
    path: 'vendor/lib/inner',
    parent: 'vendor/lib',
    name: 'inner',
    url: '',
    branch: null,
    recorded: 'a'.repeat(40),
    staged: null,
    head: 'b'.repeat(40),
    headBranch: null,
    ahead: 1,
    behind: 0,
    changes: 0,
  };

  it('runs the commands about a submodule inside another from that one', () => {
    expect(submoduleUpdateOp(nested, false).commands).toEqual([['-C', 'vendor/lib', 'submodule', 'update', '--init', '--recursive', '--', 'inner']]);
    expect(submoduleRecordOp(nested, nested.head!).commands).toEqual([['-C', 'vendor/lib', 'add', '--', 'inner']]);
    expect(submoduleRemoveOp(nested, null).commands).toEqual([
      ['-C', 'vendor/lib', 'submodule', 'deinit', '--force', '--', 'inner'],
      ['-C', 'vendor/lib', 'rm', '--force', '--', 'inner'],
    ]);
  });

  it('confirms what loses work, and offers to force a deinit git refuses', () => {
    expect(submoduleRemoveOp(nested, 'C:/repo/.git/modules/inner')).toMatchObject({ danger: true, note: expect.stringContaining('.git/modules/inner') });
    const deinit = submoduleDeinitOp(nested);
    expect(deinit).toMatchObject({ confirm: true, commands: [['-C', 'vendor/lib', 'submodule', 'deinit', '--', 'inner']] });
    expect(deinit.fallback?.when.test("error: the following file has local modifications: ...")).toBe(true);
    expect(deinit.fallback?.op).toMatchObject({ danger: true, commands: [['-C', 'vendor/lib', 'submodule', 'deinit', '--force', '--', 'inner']] });
  });

  it('offers to clone from a folder on disk, which git refuses for submodules, for its commands only', () => {
    const op = submoduleUpdateOp(nested, false);
    expect(op.fallback?.when.test("fatal: transport 'file' not allowed")).toBe(true);
    expect(op.fallback?.op).toMatchObject({
      confirm: true,
      commands: [['-c', 'protocol.file.allow=always', '-C', 'vendor/lib', 'submodule', 'update', '--init', '--recursive', '--', 'inner']],
    });
  });

  it('refuses a URL or a folder that git would take for an option', () => {
    expect(() => submoduleAddOp('--upload-pack=evil', 'lib', '')).toThrow();
    expect(() => submoduleAddOp('https://example.com/lib.git', '-lib', '')).toThrow();
    expect(submoduleAddOp('https://example.com/lib.git', 'lib', 'main').commands[0]).toEqual([
      'submodule',
      'add',
      '-b',
      'main',
      '--',
      'https://example.com/lib.git',
      'lib',
    ]);
  });

  it('says where a submodule stands, and how deep it is', () => {
    expect(submoduleStatus(nested)).toBe('ahead');
    expect(submoduleStatusText(nested)).toBe('1 commit ahead of the recorded commit aaaaaaa');
    expect(submoduleStatus({ ...nested, ahead: 2, behind: 3 })).toBe('diverged');
    expect(submoduleStatus({ ...nested, ahead: null, behind: null })).toBe('unknown');
    expect(submoduleStatus({ ...nested, head: null })).toBe('uninitialized');
    expect(submoduleStatus({ ...nested, recorded: null })).toBe('added');
    const outer = { ...nested, path: 'vendor/lib', parent: '' };
    expect(submoduleDepth(nested, [outer, nested])).toBe(1);
    expect(submoduleDepth(outer, [outer, nested])).toBe(0);
    expect(submoduleFolder(nested, { root: 'C:/repos/app' })).toBe('C:/repos/app/vendor/lib/inner');
  });
});

// Real repositories: an app with the submodule lib, which has the submodule inner.

let base: string;
let app: string;
let lib: string;
let repo: Repo;

/** Runs as the extension does: when git refuses, what it offers instead, such as cloning from a folder on disk. */
const run = async (op: GitOp): Promise<void> => {
  try {
    for (const args of op.commands) await git(app, args);
  } catch (error) {
    if (!op.fallback || !op.fallback.when.test(String(error))) throw error;
    await run(op.fallback.op);
  }
};
const commit = async (dir: string, file: string, content: string, message: string) => {
  fs.writeFileSync(path.join(dir, file), content);
  await git(dir, ['add', '--all']);
  await git(dir, ['commit', '-m', message]);
  return (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
};
const init = async (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  await git(dir, ['init', '--initial-branch=main']);
  await git(dir, ['config', 'user.name', 'Gitardo Test']);
  await git(dir, ['config', 'user.email', 'test@gitardo.invalid']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
};
const submodules = async () => (await repo.state(10)).submodules;
const one = async (folder: string) => (await submodules()).find((each) => each.path === folder)!;

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitardo-sub-')));
  const inner = path.join(base, 'inner');
  lib = path.join(base, 'lib');
  app = path.join(base, 'app');
  await init(inner);
  await commit(inner, 'inner.txt', 'inner\n', 'inner');
  await init(lib);
  await commit(lib, 'lib.txt', 'one\n', 'lib one');
  await git(lib, ['-c', 'protocol.file.allow=always', 'submodule', 'add', inner, 'inner']);
  await git(lib, ['commit', '-m', 'add inner']);
  await init(app);
  await commit(app, 'app.txt', 'app\n', 'app');
  app = (await Repo.discover(app))!;
  repo = new Repo(app);
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('submodules of a real repository', { timeout: 60_000 }, () => {
  it('has none without .gitmodules', async () => {
    expect(await submodules()).toEqual([]);
  });

  it('adds a submodule with the ones inside it, and follows it against the commit recorded for it', async () => {
    await run(submoduleAddOp(lib, 'vendor/lib', ''));
    const added = await one('vendor/lib');
    expect(added).toMatchObject({ parent: '', name: 'vendor/lib', url: lib, recorded: null, headBranch: 'main', changes: 0 });
    expect(added.staged).toBe(added.head);
    expect(submoduleStatus(added)).toBe('added');
    // The one inside it is cloned too, and listed after it.
    expect((await submodules()).map((each) => [each.path, each.parent])).toEqual([
      ['vendor/lib', ''],
      ['vendor/lib/inner', 'vendor/lib'],
    ]);
    expect(submoduleStatus(await one('vendor/lib/inner'))).toBe('synced');

    await git(app, ['commit', '-m', 'add lib']);
    const recorded = (await one('vendor/lib')).head!;
    expect(await one('vendor/lib')).toMatchObject({ recorded, staged: null, ahead: 0, behind: 0 });

    // A commit made in it puts it ahead of the commit recorded.
    const folder = path.join(app, 'vendor/lib');
    const next = await commit(folder, 'lib.txt', 'two\n', 'lib two');
    expect(await one('vendor/lib')).toMatchObject({ head: next, ahead: 1, behind: 0 });

    // Staging it records that commit once committed.
    await run(submoduleRecordOp(await one('vendor/lib'), next));
    expect(await one('vendor/lib')).toMatchObject({ recorded, staged: next });
    await git(app, ['commit', '-m', 'move lib']);
    expect(await one('vendor/lib')).toMatchObject({ recorded: next, staged: null, ahead: 0 });

    // Back on an earlier commit, it is behind; an update brings it to the recorded one.
    await git(folder, ['checkout', '--detach', recorded]);
    expect(await one('vendor/lib')).toMatchObject({ headBranch: null, ahead: 0, behind: 1 });
    await run(submoduleUpdateOp(await one('vendor/lib'), false));
    expect(await one('vendor/lib')).toMatchObject({ head: next, ahead: 0, behind: 0 });

    // A file changed in it is counted.
    fs.writeFileSync(path.join(folder, 'lib.txt'), 'changed\n');
    expect((await one('vendor/lib')).changes).toBe(1);
  });

  it('deinitializes a submodule, initializes it again, and removes it with its clone', async () => {
    await run(submoduleAddOp(lib, 'vendor/lib', ''));
    await git(app, ['commit', '-m', 'add lib']);

    await run(submoduleDeinitOp(await one('vendor/lib')));
    const gone = await one('vendor/lib');
    expect(submoduleStatus(gone)).toBe('uninitialized');
    expect(gone.recorded).not.toBeNull();
    // What was inside it is not listed while it is not initialized.
    expect((await submodules()).map((each) => each.path)).toEqual(['vendor/lib']);

    await run(submoduleUpdateOp(gone, false));
    expect(submoduleStatus(await one('vendor/lib'))).toBe('synced');
    expect(submoduleStatus(await one('vendor/lib/inner'))).toBe('synced');

    const gitDir = path.join(await repo.gitDirAt(''), 'modules', 'vendor', 'lib');
    expect(fs.existsSync(gitDir)).toBe(true);
    await run(submoduleRemoveOp(await one('vendor/lib'), gitDir));
    expect(await submodules()).toEqual([]);
    expect(fs.existsSync(path.join(app, 'vendor/lib'))).toBe(false);
    const staged = (await repo.state(10)).working.staged.map((file) => file.path).sort();
    expect(staged).toEqual(['.gitmodules', 'vendor/lib']);
  });

  it('cannot compare a submodule with a recorded commit it does not have', async () => {
    await run(submoduleAddOp(lib, 'vendor/lib', ''));
    await git(app, ['commit', '-m', 'add lib']);
    // The recorded commit moves to one made in a clone of lib that this one has never fetched.
    const other = path.join(base, 'other');
    await git(base, ['-c', 'protocol.file.allow=always', 'clone', lib, other]);
    await git(other, ['config', 'user.name', 'Gitardo Test']);
    await git(other, ['config', 'user.email', 'test@gitardo.invalid']);
    const elsewhere = await commit(other, 'lib.txt', 'elsewhere\n', 'elsewhere');
    await git(app, ['update-index', '--cacheinfo', `160000,${elsewhere},vendor/lib`]);
    await git(app, ['commit', '-m', 'point lib elsewhere']);
    const lost = await one('vendor/lib');
    expect(lost).toMatchObject({ recorded: elsewhere, ahead: null, behind: null });
    expect(submoduleStatus(lost)).toBe('unknown');
  });

  it('synchronizes the URLs of .gitmodules', async () => {
    await run(submoduleAddOp(lib, 'vendor/lib', ''));
    await git(app, ['config', '--file', '.gitmodules', 'submodule.vendor/lib.url', 'https://example.com/lib.git']);
    await run(submoduleSyncOp());
    const url = (await git(app, ['config', 'submodule.vendor/lib.url'])).stdout.trim();
    expect(url).toBe('https://example.com/lib.git');
  });
});
