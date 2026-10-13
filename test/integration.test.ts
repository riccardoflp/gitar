import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverRepos, repoName } from '../src/git/discover';
import { git } from '../src/git/exec';
import {
  abortOp,
  bisectOp,
  bisectResetOp,
  checkoutOp,
  cherryPickManyOp,
  cherryPickOp,
  cleanupBranchesOp,
  clearIdentityOp,
  commitOp,
  continueOp,
  createBranchOp,
  createTagOp,
  deleteBranchOp,
  discardOp,
  fetchRemoteOp,
  fixupOp,
  hunkOp,
  identityOp,
  mergeOp,
  rebaseInteractiveOp,
  rebaseOp,
  rebaseTodo,
  remoteAddOp,
  remoteRemoveOp,
  remoteRenameOp,
  remoteSetUrlOp,
  renameBranchOp,
  resetOp,
  restoreBranchOp,
  restoreStashOp,
  revertOp,
  skipOp,
  stageAllOp,
  stageOp,
  stashOp,
  stashPushOp,
  syncOp,
  undoOp,
  unstageAllOp,
  unstageOp,
  worktreeAddOp,
  worktreeRemoveOp,
  type GitOp,
} from '../src/git/ops';
import { hunkPatch, linesPatch } from '../src/git/parse';
import { Repo } from '../src/git/repo';
import { WORKTREE } from '../src/shared/protocol';

// Runs the real commands against a throwaway repository, the way the extension does.

let root: string;
let repo: Repo;

const run = async (op: GitOp) => {
  for (const [index, args] of op.commands.entries()) {
    await git(root, args, { input: index === op.commands.length - 1 ? op.input : undefined });
  }
};
const subjects = async () => (await state()).rows.map((row) => row.subject);
const undo = async () => {
  const current = await state();
  const info = await repo.undoInfo(current.branch, current.working);
  if (info) await run(undoOp(info, current.branch));
  return info;
};
const write = (file: string, content: string) => fs.writeFileSync(path.join(root, file), content);
const exists = (file: string) => fs.existsSync(path.join(root, file));
const state = () => repo.state(100);
const commitAll = async (message: string) => {
  await run(stageAllOp());
  await run(commitOp(message, false, false));
  return (await state()).head!;
};

/** Leaves `main` and `other` with different content on the same line of the same file. */
async function divergent() {
  write('a.txt', 'base\n');
  await commitAll('base');
  await run(createBranchOp('other', 'HEAD', true));
  write('a.txt', 'other\n');
  const other = await commitAll('other change');
  await run(checkoutOp('branch', 'main'));
  write('a.txt', 'main\n');
  await commitAll('main change');
  return other;
}

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitar-'));
  await git(dir, ['init', '--initial-branch=main']);
  await git(dir, ['config', 'user.name', 'Gitar Test']);
  await git(dir, ['config', 'user.email', 'test@gitar.invalid']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  root = (await Repo.discover(dir))!;
  repo = new Repo(root);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('against a real repository', { timeout: 60_000 }, () => {
  it('stages, unstages and commits in a repository with no commits yet', async () => {
    expect(await state()).toMatchObject({ head: null, branch: 'main', rows: [], changes: 0, operation: null });

    write('a.txt', 'one\n');
    expect((await state()).working.unstaged).toEqual([{ status: '?', path: 'a.txt' }]);

    await run(stageOp(['a.txt']));
    expect((await state()).working.staged).toEqual([{ status: 'A', path: 'a.txt' }]);

    await run(unstageOp(['a.txt'], false));
    expect((await state()).working).toEqual({ staged: [], unstaged: [{ status: '?', path: 'a.txt' }], conflicts: [] });

    const head = await commitAll('First commit');
    const after = await state();
    expect(after.rows.map((row) => row.subject)).toEqual(['First commit']);
    expect(after.branches).toMatchObject([{ name: 'main', hash: head, current: true }]);
    expect(after.changes).toBe(0);
  });

  it('shows uncommitted changes as the first row and discards them', async () => {
    write('a.txt', 'one\n');
    await commitAll('First commit');
    write('a.txt', 'two\n');
    write('new.txt', 'untracked\n');

    const dirty = await state();
    expect(dirty.rows[0]).toMatchObject({ hash: WORKTREE, parents: [dirty.head] });
    expect(dirty.changes).toBe(2);

    await run(discardOp(['a.txt', 'new.txt'], dirty.working));
    expect((await state()).changes).toBe(0);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('one\n');
    expect(exists('new.txt')).toBe(false);
  });

  it('unstages both sides of a staged rename', async () => {
    write('old.txt', 'content that is long enough to be detected as a rename\n');
    await commitAll('Add file');
    await git(root, ['mv', 'old.txt', 'new.txt']);

    const [renamed] = (await state()).working.staged;
    expect(renamed).toEqual({ status: 'R', path: 'new.txt', oldPath: 'old.txt' });

    await run(unstageOp([renamed.path, renamed.oldPath!], true));
    expect((await state()).working.staged).toEqual([]);
  });

  it('creates, renames, merges and deletes branches', async () => {
    write('a.txt', 'one\n');
    await commitAll('First commit');

    await run(createBranchOp('feature', 'HEAD', true));
    expect((await state()).branch).toBe('feature');
    write('b.txt', 'feature\n');
    const tip = await commitAll('Feature work');

    await run(checkoutOp('branch', 'main'));
    await expect(run(deleteBranchOp('feature', false))).rejects.toThrow(/not fully merged/);

    await run(mergeOp('feature', 'main'));
    expect(await state()).toMatchObject({ branch: 'main', head: tip });

    await run(renameBranchOp('feature', 'done'));
    await run(deleteBranchOp('done', false));
    expect((await state()).branches.map((branch) => branch.name)).toEqual(['main']);
  });

  it('reports a conflicted merge, aborts it, then resolves and continues it', async () => {
    await divergent();

    await expect(run(mergeOp('other', 'main'))).rejects.toThrow();
    expect(await state()).toMatchObject({ operation: 'merge', working: { conflicts: [{ status: 'U', path: 'a.txt' }] } });

    await run(abortOp('merge'));
    expect(await state()).toMatchObject({ operation: null, changes: 0 });

    await expect(run(mergeOp('other', 'main'))).rejects.toThrow();
    write('a.txt', 'resolved\n');
    await run(stageOp(['a.txt']));
    expect((await state()).working.conflicts).toEqual([]);
    await run(continueOp('merge'));

    const merged = await state();
    expect(merged.operation).toBeNull();
    expect(merged.rows[0].parents).toHaveLength(2);
    expect(merged.rows[0].graph.bottom).toHaveLength(2);
  });

  it('reports a conflicted rebase and can skip the conflicting commit', async () => {
    const other = await divergent();

    await expect(run(rebaseOp('other', 'main'))).rejects.toThrow();
    expect(await state()).toMatchObject({ operation: 'rebase', branch: null });

    await run(skipOp('rebase'));
    expect(await state()).toMatchObject({ operation: null, branch: 'main', head: other });
  });

  it('cherry-picks, reverts and resets', async () => {
    write('a.txt', 'one\n');
    const first = await commitAll('First commit');
    await run(createBranchOp('feature', 'HEAD', true));
    write('b.txt', 'feature\n');
    const picked = await commitAll('Feature work');
    await run(checkoutOp('branch', 'main'));

    await run(cherryPickOp(picked, false));
    expect(exists('b.txt')).toBe(true);
    const afterPick = await state();
    expect(afterPick.rows.find((row) => row.hash === afterPick.head)).toMatchObject({ subject: 'Feature work', parents: [first] });

    await run(revertOp(afterPick.head!, false));
    expect(exists('b.txt')).toBe(false);
    expect((await repo.commitDetail((await state()).head!))!.subject).toBe('Revert "Feature work"');

    await run(resetOp(first, 'hard', 'main'));
    expect((await state()).head).toBe(first);
  });

  it('stashes tracked and untracked changes and pops them back', async () => {
    write('a.txt', 'one\n');
    await commitAll('First commit');
    write('a.txt', 'two\n');
    write('new.txt', 'untracked\n');

    await run(stashPushOp('work in progress'));
    const stashed = await state();
    expect(stashed.changes).toBe(0);
    expect(stashed.stashes).toMatchObject([{ ref: 'stash@{0}', message: 'On main: work in progress' }]);
    // Stashes have their own list; their commits must stay out of the graph.
    expect(stashed.rows).toHaveLength(1);
    expect((await repo.commitDetail(stashed.stashes[0].hash))!.files).toEqual([{ status: 'M', path: 'a.txt' }]);

    await run(stashOp('pop', 'stash@{0}'));
    expect(await state()).toMatchObject({ changes: 2, stashes: [] });
  });

  it('points annotated tags at their commit', async () => {
    write('a.txt', 'one\n');
    const head = await commitAll('First commit');
    await run(createTagOp('v1', 'HEAD', 'First release'));
    await run(createTagOp('light', 'HEAD', ''));
    expect((await state()).tags).toEqual([
      { name: 'light', hash: head },
      { name: 'v1', hash: head },
    ]);
  });

  it('stages, unstages and discards single hunks', async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    write('a.txt', `${lines.join('\n')}\n`);
    await commitAll('First commit');
    const edited = [...lines];
    edited[1] = 'TOP';
    edited[27] = 'BOTTOM';
    write('a.txt', `${edited.join('\n')}\n`);

    const unstaged = await repo.hunks('a.txt', false);
    expect(unstaged.hunks).toHaveLength(2);

    await run(hunkOp('stageHunk', 'a.txt', hunkPatch(unstaged, unstaged.hunks[0])));
    expect(await repo.show(':0', 'a.txt')).toContain('TOP');
    expect(await repo.show(':0', 'a.txt')).not.toContain('BOTTOM');
    expect((await repo.hunks('a.txt', false)).hunks).toHaveLength(1);

    const staged = await repo.hunks('a.txt', true);
    await run(hunkOp('unstageHunk', 'a.txt', hunkPatch(staged, staged.hunks[0])));
    expect((await state()).working.staged).toEqual([]);

    const again = await repo.hunks('a.txt', false);
    await run(hunkOp('discardHunk', 'a.txt', hunkPatch(again, again.hunks[1])));
    const onDisk = fs.readFileSync(path.join(root, 'a.txt'), 'utf8');
    expect(onDisk).toContain('TOP');
    expect(onDisk).not.toContain('BOTTOM');
  });

  it('predicts conflicts of a merge and of a cherry-pick without touching anything', async () => {
    const other = await divergent();
    expect(await repo.conflictsWith('other')).toEqual(['a.txt']);
    expect(await repo.conflictsWith(other, `${other}^`)).toEqual(['a.txt']);

    await run(createBranchOp('clean', 'HEAD', true));
    write('b.txt', 'no clash\n');
    const clean = await commitAll('clean change');
    await run(checkoutOp('branch', 'main'));
    expect(await repo.conflictsWith('clean')).toEqual([]);
    expect(await repo.conflictsWith(clean, `${clean}^`)).toEqual([]);
    expect(await state()).toMatchObject({ changes: 0, operation: null, branch: 'main' });

    expect(await repo.commitsOnlyIn('other', 10)).toEqual([`${other.slice(0, 7)} other change`]);
    expect(await repo.commitsOnlyIn('main', 10)).toEqual([]);
  });

  it('undoes commits, checkouts, resets and rebases', async () => {
    write('a.txt', 'one\n');
    const first = await commitAll('First commit');
    expect(await undo()).toBeNull();

    write('a.txt', 'two\n');
    const second = await commitAll('Second commit');
    expect(await undo()).toMatchObject({ kind: 'move', previous: first, mode: 'soft' });
    expect(await state()).toMatchObject({ head: first, working: { staged: [{ status: 'M', path: 'a.txt' }] } });
    // Undoing the undo brings the commit back.
    expect(await undo()).toMatchObject({ kind: 'move', previous: second });
    expect(await state()).toMatchObject({ head: second, changes: 0 });

    await run(resetOp(first, 'hard', 'main'));
    expect(await undo()).toMatchObject({ previous: second, mode: 'keep' });
    expect((await state()).head).toBe(second);

    await run(resetOp(first, 'mixed', 'main'));
    expect(await undo()).toMatchObject({ previous: second, mode: 'mixed' });
    expect(await state()).toMatchObject({ head: second, changes: 0 });

    await run(createBranchOp('side', first, true));
    expect(await undo()).toEqual({ kind: 'checkout', from: 'main' });
    expect((await state()).branch).toBe('main');

    await run(checkoutOp('branch', 'side'));
    write('b.txt', 'side\n');
    const side = await commitAll('Side commit');
    await run(rebaseOp('main', 'side'));
    expect((await state()).head).not.toBe(side);
    expect(await undo()).toMatchObject({ kind: 'move', previous: side });
    expect(await state()).toMatchObject({ head: side, branch: 'side' });
  });

  it('restores a deleted branch and a dropped stash', async () => {
    write('a.txt', 'one\n');
    const first = await commitAll('First commit');
    await run(createBranchOp('gone', 'HEAD', false));
    await run(deleteBranchOp('gone'));
    await run(restoreBranchOp('gone', first));
    expect((await state()).branches.map((branch) => branch.name)).toEqual(['gone', 'main']);

    write('a.txt', 'two\n');
    await run(stashPushOp('keep me'));
    const [stash] = (await state()).stashes;
    await run(stashOp('drop', stash.ref));
    expect((await state()).stashes).toEqual([]);
    await run(restoreStashOp(stash.message, stash.hash));
    expect((await state()).stashes).toMatchObject([{ hash: stash.hash, message: 'On main: keep me' }]);
  });

  it('reorders, rewords, melds and drops commits in an interactive rebase', async () => {
    const hashes: Record<string, string> = {};
    for (const name of ['base', 'b', 'c', 'd', 'e']) {
      write(`${name}.txt`, `${name}\n`);
      hashes[name] = await commitAll(`Add ${name}`);
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitar-todo-'));
    const file = (name: string) => path.join(dir, name).replace(/\\/g, '/');
    fs.writeFileSync(file('message-1.txt'), 'Add b and d\n\nReworded.\n');
    const todo = rebaseTodo(
      [
        { action: 'pick', hash: hashes.c },
        { action: 'reword', hash: hashes.b, message: 'Add b and d\n\nReworded.' },
        { action: 'fixup', hash: hashes.d },
        { action: 'drop', hash: hashes.e },
      ],
      (index) => file(`message-${index}.txt`),
    );
    fs.writeFileSync(file('todo'), todo);
    await run(rebaseInteractiveOp(hashes.base, file('todo'), todo, 'main'));
    fs.rmSync(dir, { recursive: true, force: true });

    expect(await state()).toMatchObject({ operation: null, branch: 'main', changes: 0 });
    expect(await subjects()).toEqual(['Add b and d', 'Add c', 'Add base']);
    const top = await repo.commitDetail((await state()).head!);
    expect(top).toMatchObject({ body: 'Reworded.', files: [{ status: 'A', path: 'b.txt' }, { status: 'A', path: 'd.txt' }] });
    expect(exists('e.txt')).toBe(false);

    // One undo takes back the whole rebase.
    await undo();
    expect((await state()).head).toBe(hashes.e);
  });

  it('adds, lists and removes worktrees', async () => {
    write('a.txt', 'one\n');
    await commitAll('First commit');
    await run(createBranchOp('feature', 'HEAD', false));
    const dir = `${root}-worktree`;

    await run(worktreeAddOp(dir, 'feature', null, false));
    expect((await state()).worktrees).toMatchObject([
      { current: true, branch: 'main' },
      { current: false, branch: 'feature', prunable: false },
    ]);

    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted\n');
    const remove = worktreeRemoveOp(dir);
    const refusal = await run(remove).then(
      () => '',
      (error: Error) => error.message,
    );
    expect(remove.fallback!.when.test(refusal)).toBe(true);
    await run(remove.fallback!.op);
    expect((await state()).worktrees).toHaveLength(1);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('reads commit details and file contents at a commit and in the index', async () => {
    write('a.txt', 'one\n');
    const first = await commitAll('First commit');
    write('a.txt', 'two\n');
    write('b.txt', 'new\n');
    const second = await commitAll('Second commit\n\nWith a body.');

    expect(await repo.commitDetail(second)).toMatchObject({
      hash: second,
      parents: [first],
      subject: 'Second commit',
      body: 'With a body.',
      author: 'Gitar Test',
      files: [
        { status: 'M', path: 'a.txt' },
        { status: 'A', path: 'b.txt' },
      ],
    });
    expect((await repo.commitDetail(first))!.files).toEqual([{ status: 'A', path: 'a.txt' }]);

    write('a.txt', 'three\n');
    await run(stageOp(['a.txt']));
    write('a.txt', 'four\n');
    expect(await repo.show(first, 'a.txt')).toBe('one\n');
    expect(await repo.show(second, 'a.txt')).toBe('two\n');
    expect(await repo.show(':0', 'a.txt')).toBe('three\n');
    expect(await repo.show(first, 'b.txt')).toBe('');
  });

  it('narrows the graph to the history of a file and keeps it connected', async () => {
    write('a.txt', 'one\n');
    const first = await commitAll('Add a');
    write('b.txt', 'other file\n');
    await commitAll('Add b');
    write('a.txt', 'two\n');
    const third = await commitAll('Change a');
    write('b.txt', 'not committed\n');

    const history = await repo.state(100, { kind: 'path', path: 'a.txt' });
    expect(history.filter).toEqual({ kind: 'path', path: 'a.txt' });
    // Neither the commit that only touched b.txt nor the uncommitted changes belong to the history of a.txt.
    expect(history.rows.map((row) => row.subject)).toEqual(['Change a', 'Add a']);
    expect(history.rows[0]).toMatchObject({ hash: third, parents: [first] });
    expect(history.rows[0].graph.bottom).toHaveLength(1);
    expect((await state()).rows[0].hash).toBe(WORKTREE);
    expect((await repo.state(100, { kind: 'path', path: 'missing.txt' })).rows).toEqual([]);
    // The path is a file name, not a pattern.
    expect((await repo.state(100, { kind: 'path', path: '*.txt' })).rows).toEqual([]);
  });

  it('searches the whole history by message, author and changed text', async () => {
    write('a.txt', 'alpha\n');
    await commitAll('Add the Parser');
    write('a.txt', 'alpha\nconst limit = 42;\n');
    await commitAll('Tune limits');
    write('a.txt', 'alpha\nconst limit = 42; // why\n');
    await commitAll('Explain [the] number');
    await git(root, ['-c', 'user.name=Someone Else', 'commit', '--allow-empty', '-m', 'Empty one']);

    const found = async (kind: 'message' | 'author' | 'pickaxe' | 'regex', query: string) =>
      (await repo.state(100, { kind, query })).rows.map((row) => row.subject);
    expect(await found('message', 'parser')).toEqual(['Add the Parser']);
    // The text is taken literally, not as a pattern.
    expect(await found('message', '[the]')).toEqual(['Explain [the] number']);
    expect(await found('author', 'someone')).toEqual(['Empty one']);
    // -S finds the commits where the number of occurrences changed; -G every commit with a changed line that matches.
    expect(await found('pickaxe', 'limit = 42')).toEqual(['Tune limits']);
    expect(await found('regex', 'limit = [0-9]+')).toEqual(['Explain [the] number', 'Tune limits']);
    expect(await found('message', 'nothing like this')).toEqual([]);
    await expect(found('regex', 'limit(')).rejects.toThrow();

    // Results are unrelated commits, so no lines are drawn between them.
    const rows = (await repo.state(100, { kind: 'regex', query: 'limit' })).rows;
    expect(rows.every((row) => row.graph.top.length === 0 && row.graph.bottom.length === 0)).toBe(true);
  });

  it('blames single lines, including in content that is not saved yet', async () => {
    write('a.txt', 'one\ntwo\n');
    const first = await commitAll('Add a');
    write('a.txt', 'one\nTWO\n');
    const second = await commitAll('Shout');

    expect(await repo.blameLine('a.txt', 1)).toMatchObject({ hash: first, author: 'Gitar Test', summary: 'Add a', committed: true });
    expect(await repo.blameLine('a.txt', 2)).toMatchObject({ hash: second, summary: 'Shout', committed: true });
    const unsaved = 'zero\none\nTWO\n';
    expect(await repo.blameLine('a.txt', 1, unsaved)).toMatchObject({ committed: false });
    expect(await repo.blameLine('a.txt', 2, unsaved)).toMatchObject({ hash: first, committed: true });
    expect(await repo.blameLine('a.txt', 9)).toBeNull();
    write('new.txt', 'x\n');
    expect(await repo.blameLine('new.txt', 1)).toBeNull();
  });

  it('finds the branches that are safe to clean up and deletes them', async () => {
    write('a.txt', 'one\n');
    await commitAll('base');
    await run(createBranchOp('done', 'HEAD', false));
    await run(createBranchOp('wip', 'HEAD', true));
    write('a.txt', 'two\n');
    await commitAll('unfinished');
    await run(checkoutOp('branch', 'main'));

    expect((await repo.mergedBranches()).sort()).toEqual(['done', 'main']);
    await run(cleanupBranchesOp(['done'], ['wip']));
    expect((await state()).branches.map((branch) => branch.name)).toEqual(['main']);
  });

  it('stages, unstages and discards single lines of a hunk', async () => {
    write('a.txt', 'one\ntwo\nthree\nfour\n');
    await commitAll('base');
    // One hunk: "two" is replaced and a line is added after "three".
    write('a.txt', 'one\nTWO\nthree\nextra\nfour\n');
    const unstaged = await repo.hunks('a.txt', false);
    const [hunk] = unstaged.hunks;
    const index = (text: string) => hunk.lines.indexOf(text);

    // Stage only the added line: the replacement of "two" stays unstaged.
    await run(hunkOp('stageHunk', 'a.txt', linesPatch(unstaged, hunk, new Set([index('+extra')]), false)));
    expect(await repo.show(':0', 'a.txt')).toBe('one\ntwo\nthree\nextra\nfour\n');

    // Stage the replacement too, then unstage only its removed half.
    const rest = await repo.hunks('a.txt', false);
    await run(hunkOp('stageHunk', 'a.txt', linesPatch(rest, rest.hunks[0], new Set([0, 1, 2, 3, 4, 5]), false)));
    expect(await repo.show(':0', 'a.txt')).toBe('one\nTWO\nthree\nextra\nfour\n');
    const staged = await repo.hunks('a.txt', true);
    const removed = staged.hunks[0].lines.indexOf('-two');
    await run(hunkOp('unstageHunk', 'a.txt', linesPatch(staged, staged.hunks[0], new Set([removed]), true)));
    expect(await repo.show(':0', 'a.txt')).toBe('one\ntwo\nTWO\nthree\nextra\nfour\n');

    // Discard one line from the file on disk.
    await run(unstageAllOp(true));
    const again = await repo.hunks('a.txt', false);
    const extra = again.hunks[0].lines.indexOf('+extra');
    await run(hunkOp('discardHunk', 'a.txt', linesPatch(again, again.hunks[0], new Set([extra]), true)));
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\nfour\n');
  });

  it('folds changes into an earlier commit', async () => {
    write('a.txt', 'one\n');
    await commitAll('Add a');
    write('b.txt', 'bee\n');
    const target = await commitAll('Add b');
    write('c.txt', 'sea\n');
    await commitAll('Add c');

    write('b.txt', 'bee, fixed\n');
    write('later.txt', 'not part of it\n');
    await run(stageOp(['b.txt']));
    await run(fixupOp(target, false, false));

    expect(await subjects()).toEqual(['Uncommitted changes (1)', 'Add c', 'Add b', 'Add a']);
    const rewritten = (await state()).rows[2].hash;
    expect(rewritten).not.toBe(target);
    expect(await repo.show(rewritten, 'b.txt')).toBe('bee, fixed\n');
    // What was not staged survives the rebase untouched.
    expect(exists('later.txt')).toBe(true);

    // The first commit of the repository can be fixed up too, with everything that is pending.
    const rootCommit = (await state()).rows[3].hash;
    write('a.txt', 'one, fixed\n');
    await run(fixupOp(rootCommit, true, true));
    expect(await subjects()).toEqual(['Add c', 'Add b', 'Add a']);
    expect(await repo.show((await state()).rows[2].hash, 'a.txt')).toBe('one, fixed\n');
  });

  it('bisects down to the first bad commit', async () => {
    const hashes: string[] = [];
    for (let i = 1; i <= 6; i++) {
      write('a.txt', `${i >= 4 ? 'broken' : 'fine'} ${i}\n`);
      hashes.push(await commitAll(`commit ${i}`));
    }
    expect((await state()).bisect).toBeNull();
    expect(() => bisectOp('skip', undefined, false)).toThrow(/No bisect/);

    await run(bisectOp('bad', hashes[5], false));
    expect((await state()).bisect).toEqual({ good: [], bad: hashes[5], skipped: [], suspects: null });
    await run(bisectOp('good', hashes[0], true));
    let bisect = (await state()).bisect!;
    expect(bisect).toMatchObject({ good: [hashes[0]], bad: hashes[5], suspects: 5 });

    // Answer for whatever commit git checks out, until one suspect is left.
    for (let step = 0; bisect.suspects! > 1 && step < 10; step++) {
      const broken = fs.readFileSync(path.join(root, 'a.txt'), 'utf8').startsWith('broken');
      await run(bisectOp(broken ? 'bad' : 'good', undefined, true));
      bisect = (await state()).bisect!;
    }
    expect(bisect).toMatchObject({ bad: hashes[3], suspects: 1 });

    await run(bisectResetOp());
    expect(await state()).toMatchObject({ bisect: null, branch: 'main', head: hashes[5] });
  });

  it('switches the identity of the repository and back to the inherited one', async () => {
    expect((await state()).identity).toEqual({ name: 'Gitar Test', email: 'test@gitar.invalid' });
    expect((await repo.localIdentityKeys()).sort()).toEqual(['user.email', 'user.name']);

    await run(identityOp({ name: 'Work Me', email: 'me@work.example', signingKey: 'ABC123' }, await repo.localIdentityKeys()));
    expect((await state()).identity).toEqual({ name: 'Work Me', email: 'me@work.example' });
    expect((await repo.localIdentityKeys()).sort()).toEqual(['user.email', 'user.name', 'user.signingkey']);

    // An identity without a key must not keep signing with the previous one.
    await run(identityOp({ name: 'Home Me', email: 'me@home.example' }, await repo.localIdentityKeys()));
    expect((await repo.localIdentityKeys()).sort()).toEqual(['user.email', 'user.name']);
    write('a.txt', 'one\n');
    const hash = await commitAll('As home');
    expect(await repo.commitDetail(hash)).toMatchObject({ author: 'Home Me', email: 'me@home.example' });

    await run(clearIdentityOp(await repo.localIdentityKeys()));
    expect(await repo.localIdentityKeys()).toEqual([]);
    expect(() => clearIdentityOp([])).toThrow(/already uses the global/);
  });

  it('shows only what one branch can reach, and compares two commits', async () => {
    const other = await divergent();
    const main = (await state()).head!;

    const only = await repo.state(100, { kind: 'ref', ref: 'other' });
    expect(only.rows.map((row) => row.subject)).toEqual(['other change', 'base']);
    expect(only.rows[0].graph.bottom).toHaveLength(1);
    await expect(repo.state(100, { kind: 'ref', ref: '--all' })).rejects.toThrow(/not a valid name/);

    write('new.txt', 'x\n');
    const next = await commitAll('Add a file');
    expect(await repo.compare(other, next)).toEqual({
      from: other,
      to: next,
      files: [
        { status: 'M', path: 'a.txt' },
        { status: 'A', path: 'new.txt' },
      ],
    });
    expect((await repo.compare(main, main))!.files).toEqual([]);
    expect(await repo.compare('HEAD; rm -rf', main)).toBeNull();

    // Either side can be typed: a name, a short hash, or an expression git turns into a commit.
    expect(await repo.resolve('other')).toBe(other);
    expect(await repo.resolve(next.slice(0, 7))).toBe(next);
    expect(await repo.resolve('HEAD~1')).toBe(main);
    await git(root, ['tag', '-a', 'v1', '-m', 'First', main]);
    expect(await repo.resolve('v1')).toBe(main);
    for (const nothing of ['', 'no-such-thing', '--all', 'other..HEAD', `${next}:new.txt`]) expect(await repo.resolve(nothing)).toBeNull();
  });

  it('says how far back a commit is, and which commits a search finds', async () => {
    const other = await divergent();
    const main = (await state()).head!;
    write('notes.txt', 'remember the milk\n');
    const notes = await commitAll('Add notes');
    const all = (await state()).rows.map((row) => row.hash);
    expect(all).toHaveLength(4);

    // In the order of the list, whatever that is for commits of the same second.
    for (const [index, hash] of all.entries()) expect(await repo.position(hash)).toBe(index);
    expect(await repo.position(other, { kind: 'ref', ref: 'main' })).toBe(-1);
    expect(await repo.position(main, { kind: 'path', path: 'notes.txt' })).toBe(-1);
    expect(await repo.position(notes, { kind: 'path', path: 'notes.txt' })).toBe(0);
    expect(await repo.position('0'.repeat(40))).toBe(-1);
    expect(await repo.position('HEAD')).toBe(-1);

    // A commit that no branch reaches is not in the history, and still has one of its own to show.
    const lost = (await git(root, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Lost'])).stdout.trim();
    expect(await repo.resolve(lost.slice(0, 10))).toBe(lost);
    expect(await repo.position(lost)).toBe(-1);
    expect((await repo.state(100, { kind: 'ref', ref: lost, lost: true })).rows.map((row) => row.subject)).toEqual([
      'Lost',
      'Add notes',
      'main change',
      'base',
    ]);

    const changes = all.filter((hash) => hash === main || hash === other);
    expect(await repo.matches({ kind: 'message', query: 'CHANGE' }, null, 10)).toEqual({ hashes: changes, more: false });
    expect(await repo.matches({ kind: 'message', query: 'change' }, null, 1)).toEqual({ hashes: [changes[0]], more: true });
    expect(await repo.matches({ kind: 'message', query: 'change' }, { kind: 'ref', ref: 'main' }, 10)).toEqual({ hashes: [main], more: false });
    expect(await repo.matches({ kind: 'pickaxe', query: 'milk' }, null, 10)).toEqual({ hashes: [notes], more: false });
    expect(await repo.matches({ kind: 'author', query: 'gitar' }, { kind: 'path', path: 'notes.txt' }, 10)).toEqual({ hashes: [notes], more: false });
    expect(await repo.matches({ kind: 'author', query: 'nobody' }, null, 10)).toEqual({ hashes: [], more: false });
    await expect(repo.matches({ kind: 'regex', query: '[' }, null, 10)).rejects.toThrow();
  });

  it('pulls with a rebase', async () => {
    write('a.txt', 'one\n');
    await commitAll('base');
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'gitar-remote-'));
    try {
      await git(remote, ['init', '--bare', '--initial-branch=main']);
      await git(root, ['remote', 'add', 'origin', remote]);
      await run(syncOp('push', await state()));
      // Someone else pushes a commit, while this clone makes one of its own.
      const base = (await state()).head!;
      write('theirs.txt', 'theirs\n');
      await commitAll('Their commit');
      await git(root, ['push', 'origin', 'main']);
      await git(root, ['reset', '--hard', base]);
      write('mine.txt', 'mine\n');
      await commitAll('My commit');

      await run(syncOp('fetch', await state()));
      expect((await state()).branches[0].upstream).toMatchObject({ ahead: 1, behind: 1 });
      await run(syncOp('pullRebase', await state()));
      // A rebase leaves a straight line; a merge would have added a third commit on top.
      expect(await subjects()).toEqual(['My commit', 'Their commit', 'base']);
    } finally {
      fs.rmSync(remote, { recursive: true, force: true });
    }
  });

  it('finds the repositories of a workspace, nested ones and submodules included', async () => {
    write('a.txt', 'one\n');
    await commitAll('base');
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gitar-workspace-'));
    try {
      // A folder that is not a repository itself but has two inside, plus a plain directory.
      for (const name of ['app', 'lib']) {
        fs.mkdirSync(path.join(workspace, name));
        await git(path.join(workspace, name), ['init', '--initial-branch=main']);
      }
      fs.mkdirSync(path.join(workspace, 'docs'));
      await git(path.join(workspace, 'app'), ['-c', 'protocol.file.allow=always', 'submodule', 'add', root, 'vendor/dep']);

      const found = await discoverRepos([workspace, path.join(workspace, 'app', 'vendor')]);
      const names = found.map((repoRoot) => repoName(repoRoot, [workspace]));
      const base = path.basename(workspace);
      expect(names).toEqual([`${base}/app`, `${base}/app/vendor/dep`, `${base}/lib`]);
      expect(repoName(found[0], [found[0]])).toBe('app');
      expect(await discoverRepos([path.join(workspace, 'docs')])).toEqual([]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('reads the staged and the unstaged changes as patches', async () => {
    write('a.txt', 'one\n');
    await commitAll('base');
    write('a.txt', 'staged\n');
    await run(stageOp(['a.txt']));
    write('a.txt', 'unstaged\n');

    expect(await repo.diffText(true)).toMatch(/-one\n\+staged\n/);
    expect(await repo.diffText(false)).toMatch(/-staged\n\+unstaged\n/);
  });

  it('stashes only some files, or only what is staged', async () => {
    write('a.txt', 'one\n');
    write('b.txt', 'one\n');
    await commitAll('base');
    write('a.txt', 'two\n');
    write('b.txt', 'two\n');
    write('new.txt', 'new\n');

    await run(stashPushOp('just two', { paths: ['a.txt', 'new.txt'] }));
    let current = await state();
    expect(current.working.unstaged).toEqual([{ status: 'M', path: 'b.txt' }]);
    expect(exists('new.txt')).toBe(false);
    expect(current.stashes[0].message).toContain('just two');
    await run(stashOp('pop', 'stash@{0}'));
    expect(exists('new.txt')).toBe(true);

    await run(stageOp(['a.txt']));
    await run(stashPushOp('', { staged: true }));
    current = await state();
    expect(current.working.staged).toEqual([]);
    expect(current.working.unstaged.map((file) => file.path).sort()).toEqual(['b.txt', 'new.txt']);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('one\n');
    await run(stashOp('pop', 'stash@{0}'));
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('two\n');
  });

  it('cherry-picks several commits as one operation, which stops on a conflict and can be continued', async () => {
    write('a.txt', 'base\n');
    await commitAll('base');
    await run(createBranchOp('other', 'HEAD', true));
    write('b.txt', 'b\n');
    const first = await commitAll('add b');
    write('a.txt', 'other\n');
    const second = await commitAll('change a');
    write('c.txt', 'c\n');
    const third = await commitAll('add c');
    await run(checkoutOp('branch', 'main'));
    write('a.txt', 'main\n');
    await commitAll('main change');

    await expect(run(cherryPickManyOp([first, second, third]))).rejects.toThrow();
    let current = await state();
    expect(current.operation).toBe('cherry-pick');
    expect(current.working.conflicts.map((file) => file.path)).toEqual(['a.txt']);
    expect(exists('b.txt')).toBe(true);
    expect(exists('c.txt')).toBe(false);

    // The three sides the merge editor is given.
    expect(await repo.conflictStages('a.txt')).toEqual([1, 2, 3]);
    expect(await repo.show(':1', 'a.txt')).toBe('base\n');
    expect(await repo.show(':2', 'a.txt')).toBe('main\n');
    expect(await repo.show(':3', 'a.txt')).toBe('other\n');

    // Committing the resolution by hand leaves the rest of the series to do: that still counts as a cherry-pick in progress.
    write('a.txt', 'resolved\n');
    await run(stageOp(['a.txt']));
    await git(root, ['commit', '--no-edit']);
    current = await state();
    expect(current.operation).toBe('cherry-pick');
    expect(current.working.conflicts).toEqual([]);

    await run(continueOp('cherry-pick'));
    current = await state();
    expect(current.operation).toBeNull();
    expect((await git(root, ['log', '--format=%s', 'main'])).stdout.trim().split('\n')).toEqual([
      'add c',
      'change a',
      'add b',
      'main change',
      'base',
    ]);
  });

  it('undoes a whole series of cherry-picks by aborting it', async () => {
    write('a.txt', 'base\n');
    await commitAll('base');
    await run(createBranchOp('other', 'HEAD', true));
    write('b.txt', 'b\n');
    const first = await commitAll('add b');
    write('a.txt', 'other\n');
    const second = await commitAll('change a');
    await run(checkoutOp('branch', 'main'));
    write('a.txt', 'main\n');
    const before = await commitAll('main change');

    await expect(run(cherryPickManyOp([first, second]))).rejects.toThrow();
    await run(abortOp('cherry-pick'));
    const current = await state();
    expect(current.operation).toBeNull();
    expect(current.head).toBe(before);
    expect(exists('b.txt')).toBe(false);
  });

  it('tells which sides of a conflict there are', async () => {
    write('a.txt', 'base\n');
    write('gone.txt', 'base\n');
    await commitAll('base');
    await run(createBranchOp('other', 'HEAD', true));
    write('a.txt', 'other\n');
    write('gone.txt', 'other\n');
    await commitAll('other change');
    await run(checkoutOp('branch', 'main'));
    write('a.txt', 'main\n');
    fs.rmSync(path.join(root, 'gone.txt'));
    await commitAll('main change');

    await expect(run(mergeOp('other', 'main'))).rejects.toThrow();
    expect(await repo.conflictStages('a.txt')).toEqual([1, 2, 3]);
    // Deleted on one side: there is nothing to put in the "current" pane of a merge editor.
    expect(await repo.conflictStages('gone.txt')).toEqual([1, 3]);
    expect(await repo.conflictStages('missing.txt')).toEqual([]);
  });

  it('lists what a stash holds, untracked files included', async () => {
    write('a.txt', 'one\n');
    await commitAll('base');
    write('a.txt', 'two\n');
    write('new.txt', 'new\n');
    await run(stashPushOp('with a new file'));

    const [stash] = (await state()).stashes;
    const detail = (await repo.commitDetail(stash.hash))!;
    expect(detail.files).toEqual([{ status: 'M', path: 'a.txt' }]);
    expect(detail.untracked?.files).toEqual([{ status: 'A', path: 'new.txt' }]);
    expect(await repo.show(detail.untracked!.hash, 'new.txt')).toBe('new\n');

    // With tracked changes only, git still makes the commit for untracked files, with nothing in it.
    await run(stashOp('pop', 'stash@{0}'));
    fs.rmSync(path.join(root, 'new.txt'));
    await run(stashPushOp(''));
    expect((await repo.commitDetail((await state()).stashes[0].hash))!.untracked).toBeUndefined();
  });

  it('adds, repoints, renames, fetches and removes remotes', async () => {
    write('a.txt', 'one\n');
    await commitAll('base');
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gitar-remote-'));
    try {
      await git(bare, ['init', '--bare', '--initial-branch=main']);
      await run(remoteAddOp('origin', 'https://example.invalid/nowhere.git'));
      expect(await repo.remotes()).toEqual([{ name: 'origin', url: 'https://example.invalid/nowhere.git' }]);

      await run(remoteSetUrlOp('origin', bare));
      await run(syncOp('push', await state()));
      await run(remoteRenameOp('origin', 'upstream'));
      let current = await state();
      expect(current.remotes).toEqual(['upstream']);
      expect(current.remoteBranches.map((branch) => branch.name)).toEqual(['upstream/main']);
      expect(current.branches[0].upstream?.name).toBe('upstream/main');

      await run(fetchRemoteOp('upstream'));
      await run(remoteRemoveOp('upstream'));
      current = await state();
      expect(current.remotes).toEqual([]);
      expect(current.remoteBranches).toEqual([]);
      expect(current.branches[0].upstream).toBeUndefined();

      expect(() => remoteAddOp('--upload-pack=x', bare)).toThrow();
      expect(() => remoteAddOp('origin', '--upload-pack=x')).toThrow();
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('follows a file through its renames', async () => {
    write('old.txt', 'one\ntwo\nthree\n');
    await commitAll('add old');
    write('other.txt', 'x\n');
    await commitAll('unrelated');
    await git(root, ['mv', 'old.txt', 'new.txt']);
    await commitAll('rename');
    write('new.txt', 'one\ntwo\nthree\nfour\n');
    await commitAll('change new');

    expect(await repo.pathNames('new.txt')).toEqual(['new.txt', 'old.txt']);
    expect(await repo.pathNames('other.txt')).toEqual(['other.txt']);

    // A file that started as a copy of another has its own history: git would go on into the original's.
    fs.copyFileSync(path.join(root, 'new.txt'), path.join(root, 'copy.txt'));
    await commitAll('copy');
    expect((await git(root, ['log', '--follow', '--format=%s', '--', 'copy.txt'])).stdout.trim().split('\n').length).toBeGreaterThan(1);
    expect(await repo.pathNames('copy.txt')).toEqual(['copy.txt']);

    const followed = await repo.state(100, { kind: 'path', path: 'new.txt' });
    expect(followed.rows.map((row) => row.subject)).toEqual(['change new', 'rename', 'add old']);
    expect(followed.filter).toEqual({ kind: 'path', path: 'new.txt', renamedFrom: ['old.txt'] });
    // The commit in between is skipped, and the line of the graph goes straight on.
    expect(followed.rows[1].parents).toEqual([followed.rows[2].hash]);

    const plain = await repo.state(100, { kind: 'path', path: 'other.txt' });
    expect(plain.rows.map((row) => row.subject)).toEqual(['unrelated']);
    expect(plain.filter).toEqual({ kind: 'path', path: 'other.txt' });
  });
});
