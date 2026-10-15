import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { merge, resolveConflicts } from '../src/git/conflicts';
import { GitError, git, writeFiles } from '../src/git/exec';
import {
  checkoutOp,
  cherryPickOp,
  commitOp,
  continueOp,
  createBranchOp,
  mergeOp,
  rebaseOp,
  resolveConflictsOp,
  restoreConflictsOp,
  stageAllOp,
  stashOp,
  stashPushOp,
  takeSideOp,
  type GitOp,
} from '../src/git/ops';
import { Repo } from '../src/git/repo';

// Conflicts as git itself leaves them, in a throwaway repository, resolved the way the extension does it.

let root: string;
let repo: Repo;

const run = async (op: GitOp) => {
  if (op.writes) await writeFiles(root, op.writes);
  for (const args of op.commands) await git(root, args);
};
const text = (...lines: string[]) => lines.map((line) => `${line}\n`).join('');
const write = (file: string, content: string) => fs.writeFileSync(path.join(root, file), content);
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const state = () => repo.state(100, null, null, true);
const commitAll = async (message: string) => {
  await run(stageAllOp());
  await run(commitOp(message, false, false));
};
const plans = async () => repo.conflictPlans((await state()).working.conflicts.map((file) => file.path));
/** The markers without what they say the sides are: git names them after the operation, and after nothing when it marks them again. */
const unnamed = (content: string) => content.replace(/^([<>|]{7}) .*$/gm, '$1');

/** Leaves `main` and `other` with what each makes of the files of `base`. */
async function divergent(base: Record<string, string>, other: Record<string, string | null>, main: Record<string, string | null>) {
  const apply = (files: Record<string, string | null>) => {
    for (const [file, content] of Object.entries(files)) {
      if (content === null) fs.rmSync(path.join(root, file));
      else write(file, content);
    }
  };
  apply(base);
  await commitAll('base');
  await run(createBranchOp('other', 'HEAD', true));
  apply(other);
  await commitAll('other change');
  await run(checkoutOp('branch', 'main'));
  apply(main);
  await commitAll('main change');
}

const BASE = text('one', 'two', 'three', 'four', 'five');
/** Each side changed a line, and the two lines are next to each other: git stops there. */
const beside = () => divergent({ 'a.txt': BASE }, { 'a.txt': BASE.replace('two', 'TWO') }, { 'a.txt': BASE.replace('three', 'THREE') });
const BESIDE = text('one', 'TWO', 'THREE', 'four', 'five');

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitardo-'));
  await git(dir, ['init', '--initial-branch=main']);
  await git(dir, ['config', 'user.name', 'Gitardo Test']);
  await git(dir, ['config', 'user.email', 'test@gitardo.invalid']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await git(dir, ['config', 'core.autocrlf', 'false']);
  root = (await Repo.discover(dir))!;
  repo = new Repo(root);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('conflicts of a real repository', { timeout: 120_000 }, () => {
  it('resolves a merge that stopped on changes to lines next to each other, and lets it continue', async () => {
    await beside();
    await expect(run(mergeOp('other', 'main'))).rejects.toThrow();
    expect(read('a.txt')).toContain('<<<<<<< HEAD');
    expect((await state()).conflictFiles).toEqual([{ path: 'a.txt', conflicts: 1, resolvable: ['separate'] }]);
    // Unless asked, the files in conflict are not read at all.
    expect(await repo.state(100)).toMatchObject({ working: { conflicts: [{ path: 'a.txt' }] }, conflictFiles: [] });

    const op = resolveConflictsOp(await plans());
    expect(op).toMatchObject({ title: 'Resolve the conflict automatically', commands: [['add', '--', 'a.txt']], confirm: true });
    expect(op.note).toContain('a.txt: 1 of 1 conflict (changes to lines next to each other)');
    expect(op.note).toContain('No conflict will be left.');
    await run(op);

    expect(read('a.txt')).toBe(BESIDE);
    expect(await state()).toMatchObject({ operation: 'merge', conflictFiles: [], working: { conflicts: [], staged: [{ status: 'M', path: 'a.txt' }] } });
    await run(continueOp('merge'));
    expect(await state()).toMatchObject({ operation: null, changes: 0 });
    expect((await state()).rows[0].parents).toHaveLength(2);
  });

  it('does the same for a rebase, a cherry-pick and a stash that stopped', async () => {
    await beside();
    await expect(run(rebaseOp('other', 'main'))).rejects.toThrow();
    expect((await state()).conflictFiles).toEqual([{ path: 'a.txt', conflicts: 1, resolvable: ['separate'] }]);
    await run(resolveConflictsOp(await plans()));
    expect(read('a.txt')).toBe(BESIDE);
    await run(continueOp('rebase'));
    expect(await state()).toMatchObject({ operation: null, changes: 0, branch: 'main' });

    // The same change of `three`, picked onto a branch that changed `two` in a way of its own.
    const picked = (await state()).head!;
    await git(root, ['checkout', '-B', 'again', 'other^']);
    write('a.txt', BASE.replace('two', 'Two'));
    await commitAll('two, another way');
    await expect(run(cherryPickOp(picked, false))).rejects.toThrow();
    expect(await state()).toMatchObject({ operation: 'cherry-pick', conflictFiles: [{ path: 'a.txt', conflicts: 1, resolvable: ['separate'] }] });
    await run(resolveConflictsOp(await plans()));
    expect(read('a.txt')).toBe(text('one', 'Two', 'THREE', 'four', 'five'));
    await run(continueOp('cherry-pick'));
    expect(await state()).toMatchObject({ operation: null, changes: 0 });

    // And changes put away before the line above them was changed.
    await git(root, ['checkout', '-B', 'stashing', 'other']);
    write('a.txt', BASE.replace('two', 'TWO').replace('three', 'THREE!'));
    await run(stashPushOp('three'));
    write('a.txt', BASE.replace('two', 'Two'));
    await commitAll('two again');
    await expect(run(stashOp('pop', 'stash@{0}'))).rejects.toThrow();
    expect(await state()).toMatchObject({ operation: null, conflictFiles: [{ path: 'a.txt', conflicts: 1, resolvable: ['separate'] }] });
    await run(resolveConflictsOp(await plans()));
    expect(read('a.txt')).toBe(text('one', 'Two', 'THREE!', 'four', 'five'));
    expect((await state()).working.conflicts).toEqual([]);
  });

  it('resolves what it can of a file and leaves the rest marked, and unstaged', async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    const change = (changes: Record<number, string>) => text(...lines.map((line, index) => changes[index] ?? line));
    await divergent(
      { 'a.txt': change({}), 'b.txt': BASE, 'c.txt': BASE },
      { 'a.txt': change({ 2: 'two, theirs', 15: 'fifteen, theirs', 25: 'x  =  1' }), 'b.txt': BASE.replace('two', 'TWO'), 'c.txt': BASE.replace('one', 'theirs') },
      { 'a.txt': change({ 3: 'three, ours', 15: 'fifteen, ours', 25: 'x = 1' }), 'b.txt': BASE.replace('three', 'THREE'), 'c.txt': BASE.replace('one', 'ours') },
    );
    await expect(run(mergeOp('other', 'main'))).rejects.toThrow();
    expect((await state()).conflictFiles).toEqual([
      { path: 'a.txt', conflicts: 3, resolvable: ['separate', 'whitespace'] },
      { path: 'b.txt', conflicts: 1, resolvable: ['separate'] },
      { path: 'c.txt', conflicts: 1, resolvable: [] },
    ]);

    const before = read('a.txt');
    const op = resolveConflictsOp(await plans());
    expect(op.title).toBe('Resolve 3 of 5 conflicts automatically');
    expect(op.writes?.map((file) => file.path)).toEqual(['a.txt', 'b.txt']);
    // Only the file left without conflicts is staged.
    expect(op.commands).toEqual([['add', '--', 'b.txt']]);
    expect(op.note).toContain('a.txt: 2 of 3 conflicts (changes to lines next to each other, spaces or line endings only)');
    expect(op.note).toContain('2 conflicts will be left to resolve by hand');
    await run(op);

    const marked = /<<<<<<< HEAD\nfifteen, ours\n=======\nfifteen, theirs\n>>>>>>> other\n/;
    expect(read('a.txt')).toBe(change({ 2: 'two, theirs', 3: 'three, ours', 15: 'MARKED', 25: 'x = 1' }).replace('MARKED\n', marked.source.replaceAll('\\n', '\n')));
    expect(before).toMatch(marked);
    expect(read('b.txt')).toBe(BESIDE);
    const after = await state();
    expect(after.working.conflicts.map((file) => file.path)).toEqual(['a.txt', 'c.txt']);
    expect(after.conflictFiles).toEqual([
      { path: 'a.txt', conflicts: 1, resolvable: [] },
      { path: 'c.txt', conflicts: 1, resolvable: [] },
    ]);
    expect(() => resolveConflictsOp([])).toThrow('no conflicts marked');
    await expect(plans().then(resolveConflictsOp)).rejects.toThrow('None of the 2 conflicts can be resolved without choosing a side.');

    // Only the files asked for.
    await run(restoreConflictsOp(['a.txt', 'b.txt']));
    expect((await state()).working.conflicts.map((file) => file.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    const only = resolveConflictsOp(await repo.conflictPlans(['b.txt']));
    expect(only).toMatchObject({ title: 'Resolve the conflict automatically', commands: [['add', '--', 'b.txt']] });
  });

  it('puts the conflicts back as git left them, also in a file that was staged since', async () => {
    await beside();
    for (const start of [mergeOp('other', 'main'), rebaseOp('other', 'main')]) {
      await expect(run(start)).rejects.toThrow();
      const marked = read('a.txt');
      await run(resolveConflictsOp(await plans()));
      expect((await state()).working.conflicts).toEqual([]);

      const restore = restoreConflictsOp(['a.txt']);
      expect(restore).toMatchObject({ title: 'Undo: restore the conflicts of a.txt', commands: [['checkout', '--merge', '--', 'a.txt']], danger: true });
      await run(restore);
      expect(unnamed(read('a.txt'))).toBe(unnamed(marked));
      expect(await state()).toMatchObject({ working: { conflicts: [{ path: 'a.txt' }], staged: [] }, conflictFiles: [{ path: 'a.txt', conflicts: 1 }] });
      await git(root, [(await state()).operation!, '--abort']);
    }
  });

  it('takes a whole file from one side, which for a side that deleted it is deleting it', async () => {
    const [ours, theirs] = [BASE.replace('one', 'ours'), BASE.replace('one', 'theirs')];
    await divergent({ 'a.txt': BASE, 'gone.txt': BASE }, { 'a.txt': theirs, 'gone.txt': theirs }, { 'a.txt': ours, 'gone.txt': null });
    await expect(run(mergeOp('other', 'main'))).rejects.toThrow();
    // A file one side deleted has no markers: there is nothing in it to resolve line by line.
    expect((await state()).conflictFiles).toEqual([{ path: 'a.txt', conflicts: 1, resolvable: [] }]);

    const incoming = takeSideOp('a.txt', 'theirs', await repo.conflictStages('a.txt'), 'merge');
    expect(incoming).toMatchObject({
      title: 'Take the incoming side of a.txt',
      commands: [
        ['checkout', '--theirs', '--', 'a.txt'],
        ['add', '--', 'a.txt'],
      ],
      confirm: true,
    });
    expect(incoming.note).toContain('The incoming side is the branch being merged.');
    await run(incoming);
    expect(read('a.txt')).toBe(theirs);
    expect((await state()).working.conflicts.map((file) => file.path)).toEqual(['gone.txt']);

    await run(restoreConflictsOp(['a.txt']));
    expect(read('a.txt')).toContain('<<<<<<<');
    await run(takeSideOp('a.txt', 'ours', await repo.conflictStages('a.txt'), 'merge'));
    expect(read('a.txt')).toBe(ours);

    const stages = await repo.conflictStages('gone.txt');
    const deleted = takeSideOp('gone.txt', 'ours', stages, 'merge');
    expect(deleted).toMatchObject({ title: 'Delete gone.txt, as the current side did', commands: [['rm', '--', 'gone.txt']], confirm: true });
    await run(deleted);
    expect(fs.existsSync(path.join(root, 'gone.txt'))).toBe(false);
    expect((await state()).working.conflicts).toEqual([]);

    // The other way round, in the same merge started again.
    await git(root, ['merge', '--abort']);
    await expect(run(mergeOp('other', 'main'))).rejects.toThrow();
    await run(takeSideOp('gone.txt', 'theirs', await repo.conflictStages('gone.txt'), 'merge'));
    expect(read('gone.txt')).toBe(theirs);
    expect((await state()).working.conflicts.map((file) => file.path)).toEqual(['a.txt']);

    expect(() => takeSideOp('a.txt', 'ours', [], 'merge')).toThrow('not in conflict');
    expect(takeSideOp('a.txt', 'ours', [1, 2, 3], 'rebase').note).toContain('The current side is what the branch is being rebased onto.');
  });

  it('keeps the line endings of a file checked out with the ones of Windows', async () => {
    await git(root, ['config', 'core.autocrlf', 'true']);
    const windows = (content: string) => content.replaceAll('\n', '\r\n');
    await divergent({ 'a.txt': windows(BASE) }, { 'a.txt': windows(BASE.replace('two', 'TWO')) }, { 'a.txt': windows(BASE.replace('three', 'THREE')) });
    await expect(run(mergeOp('other', 'main'))).rejects.toThrow();
    expect(read('a.txt')).toContain('<<<<<<< HEAD\r\n');

    await run(resolveConflictsOp(await plans()));
    expect(read('a.txt')).toBe(windows(BESIDE));
    // What is staged has the line endings of the repository.
    expect(await repo.show(':0', 'a.txt')).toBe(BESIDE);
    expect((await state()).working.conflicts).toEqual([]);
  });

  it('leaves alone the files it cannot read as text, and writes nothing over a file that changed in the meantime', async () => {
    const binary = (byte: number) => Buffer.from([0x3c, 0x3c, 0, byte, 0xff, 10]).toString('latin1');
    const latin = (word: string) => Buffer.from(`caf\xe9\n${word}\nthree\n`, 'latin1');
    fs.writeFileSync(path.join(root, 'latin.txt'), latin('two'));
    await divergent({ 'a.txt': BASE, 'b.bin': binary(1) }, { 'a.txt': BASE.replace('two', 'TWO'), 'b.bin': binary(2) }, { 'a.txt': BASE.replace('three', 'THREE'), 'b.bin': binary(3) });
    await git(root, ['checkout', 'other']);
    fs.writeFileSync(path.join(root, 'latin.txt'), latin('TWO'));
    await commitAll('latin, other');
    await git(root, ['checkout', 'main']);
    fs.writeFileSync(path.join(root, 'latin.txt'), latin('two').toString('latin1').replace('three', 'THREE'), 'latin1');
    await commitAll('latin, main');

    await expect(run(mergeOp('other', 'main'))).rejects.toThrow();
    expect((await state()).working.conflicts.map((file) => file.path)).toEqual(['a.txt', 'b.bin', 'latin.txt']);
    // The file in another encoding has markers, but could not be written back byte for byte.
    expect(fs.readFileSync(path.join(root, 'latin.txt'), 'latin1')).toContain('<<<<<<<');
    expect((await state()).conflictFiles).toEqual([{ path: 'a.txt', conflicts: 1, resolvable: ['separate'] }]);

    const op = resolveConflictsOp(await plans());
    write('a.txt', `${read('a.txt')}typed in the meantime\n`);
    await expect(run(op)).rejects.toThrow('a.txt has changed since it was read, so nothing was written.');
    expect(read('a.txt')).toContain('<<<<<<<');
    // Read again, it resolves with what was typed.
    await run(resolveConflictsOp(await plans()));
    expect(read('a.txt')).toBe(`${BESIDE}typed in the meantime\n`);
  });

  it('agrees with what the two sides did, on conflicts marked by git in each of its styles', async () => {
    // Numbers that are the same each time.
    let seed = 99;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const file = (name: string, lines: string[]) => fs.writeFileSync(path.join(root, name), text(...lines));
    let [files, conflicts, resolved, whole] = [0, 0, 0, 0];

    for (let round = 0; round < 120; round++) {
      const base = Array.from({ length: 12 + Math.floor(next() * 30) }, (_, index) => `line ${index}`);
      const [ours, theirs, expected]: string[][] = [[], [], []];
      // Each line is left alone, changed or removed by one side, or by both the same way; then a line may be added after it.
      base.forEach((line, index) => {
        const roll = next();
        const [mine, other] =
          roll < 0.7
            ? [line, line]
            : roll < 0.8
              ? [`${line} ours`, line]
              : roll < 0.9
                ? [line, `${line} theirs`]
                : roll < 0.93
                  ? [null, line]
                  : roll < 0.96
                    ? [line, null]
                    : roll < 0.99
                      ? [`${line} both`, `${line} both`]
                      : [null, null];
        if (mine !== null) ours.push(mine);
        if (other !== null) theirs.push(other);
        if (mine !== null && other !== null) expected.push(mine === line ? other : mine);
        const added = next();
        if (added < 0.03) [ours, expected].forEach((list) => list.push(`added ${index} ours`));
        else if (added < 0.06) [theirs, expected].forEach((list) => list.push(`added ${index} theirs`));
        else if (added < 0.09) [ours, theirs, expected].forEach((list) => list.push(`added ${index} both`));
      });
      file('base', base);
      file('ours', ours);
      file('theirs', theirs);

      const style = ['--merge', '--diff3', '--zdiff3'][round % 3];
      // It exits with the number of conflicts it marked.
      const marked = await git(root, ['merge-file', '-p', style, 'ours', 'base', 'theirs']).then(
        (result) => result.stdout,
        (error: unknown) => (error as GitError).result.stdout,
      );
      const result = resolveConflicts(marked, text(...base), { ours: text(...ours), theirs: text(...theirs) });
      const left = result.conflicts.filter((conflict) => !conflict.resolution).length;
      if (!result.conflicts.length) continue;
      files++;
      conflicts += result.conflicts.length;
      resolved += result.conflicts.length - left;
      const context = `${style}\n${marked}\n--- base\n${text(...base)}`;
      if (left) {
        // What is left is as git wrote it, and what was resolved around it is what the two sides did there.
        expect(result.text.match(/^<<<<<<< /gm), context).toHaveLength(left);
        const again = resolveConflicts(result.text, text(...base));
        expect(again.text, context).toBe(result.text);
      } else {
        whole++;
        expect(result.text, context).toBe(text(...expected));
      }
    }
    // Most of what a model like this makes is changes side by side.
    expect(files).toBeGreaterThan(60);
    expect(resolved).toBeGreaterThan(conflicts / 2);
    expect(whole).toBeGreaterThan(files / 4);
  });

  it('is never bolder than the lines git says were there before, in files full of lines that repeat', async () => {
    // Braces and empty lines can be paired with the ones of the base in more than one way, and git made its choice.
    // Told to, it writes in each conflict the lines that were there before: a conflict resolved from the whole file,
    // where those have to be found, must resolve from them too, and to the same lines.
    let seed = 4242;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const common = ['}', '', '  return x;', '{', 'end'];
    const some = () => common[Math.floor(next() * common.length)];
    const file = (name: string, lines: string[]) => fs.writeFileSync(path.join(root, name), text(...lines));
    let [blocks, both, cautious] = [0, 0, 0];

    for (let round = 0; round < 150; round++) {
      const base = Array.from({ length: 10 + Math.floor(next() * 25) }, (_, index) => (next() < 0.45 ? some() : `line ${index}`));
      const [ours, theirs]: string[][] = [[], []];
      base.forEach((line, index) => {
        const roll = next();
        const [mine, other] =
          roll < 0.7
            ? [line, line]
            : roll < 0.8
              ? [`${line} ours${index}`, line]
              : roll < 0.9
                ? [line, `${line} theirs${index}`]
                : roll < 0.93
                  ? [null, line]
                  : roll < 0.96
                    ? [line, null]
                    : roll < 0.99
                      ? [`${line} both${index}`, `${line} both${index}`]
                      : [null, null];
        if (mine !== null) ours.push(mine);
        if (other !== null) theirs.push(other);
        const added = next();
        const what = next() < 0.5 ? some() : `added ${index}`;
        if (added < 0.03) ours.push(what);
        else if (added < 0.06) theirs.push(what);
        else if (added < 0.09) [ours, theirs].forEach((list) => list.push(what));
      });
      file('base', base);
      file('ours', ours);
      file('theirs', theirs);
      const marked = await git(root, ['merge-file', '-p', '--diff3', 'ours', 'base', 'theirs']).then(
        (result) => result.stdout,
        (error: unknown) => (error as GitError).result.stdout,
      );

      // Each conflict resolved from the three parts git wrote of it.
      const reference: string[] = [];
      const decided: boolean[] = [];
      let part: 'out' | 'ours' | 'base' | 'theirs' = 'out';
      let parts: Record<'ours' | 'base' | 'theirs', string[]> = { ours: [], base: [], theirs: [] };
      let block: string[] = [];
      for (const line of marked.split(/(?<=\n)/)) {
        if (part === 'out' && line.startsWith('<<<<<<< ')) {
          part = 'ours';
          parts = { ours: [], base: [], theirs: [] };
          block = [line];
        } else if (part === 'out') {
          reference.push(line);
        } else {
          block.push(line);
          if (part === 'ours' && line.startsWith('||||||| ')) part = 'base';
          else if (part === 'base' && line === '=======\n') part = 'theirs';
          else if (part === 'theirs' && line.startsWith('>>>>>>> ')) {
            const merged = merge(parts.base, parts.ours, parts.theirs);
            decided.push(merged !== null);
            reference.push(...(merged ? merged.lines : block));
            part = 'out';
          } else parts[part].push(line);
        }
      }

      const result = resolveConflicts(marked, text(...base), { ours: text(...ours), theirs: text(...theirs) });
      const context = `${marked}\n--- base\n${text(...base)}`;
      expect(result.conflicts, context).toHaveLength(decided.length);
      let agree = true;
      result.conflicts.forEach((conflict, index) => {
        blocks++;
        if (conflict.resolution) {
          expect(decided[index], `conflict ${index + 1} of\n${context}`).toBe(true);
          both++;
        } else if (decided[index]) {
          agree = false;
          cautious++;
        }
      });
      if (agree) expect(result.text, context).toBe(reference.join(''));
    }
    // Caution has a price, which is not most of what could be resolved.
    expect(blocks).toBeGreaterThan(150);
    expect(both).toBeGreaterThan(blocks / 2);
    expect(cautious).toBeLessThan(both / 4);
  });
});
