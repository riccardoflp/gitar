import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';
import { computeMerge, mergeEditorStart } from '../../src/flow/diff/merge3';
import { type MergeModel, paneChunks, resultLine } from '../../src/flow/diff/mergeModel';

const labels = { languageId: 'plaintext', filePath: 'sample.txt', oursLabel: 'Current', theirsLabel: 'Incoming', resultLabel: 'Result' };
const merge = (base: string, ours: string, theirs: string, result: string) => computeMerge({ base, ours, theirs, result, ...labels });
const text = (...lines: string[]) => lines.map((line) => `${line}\n`).join('');
/** The lines of a pane in a span, to read what a region points at. */
const at = (model: MergeModel, pane: 'ours' | 'theirs' | 'result', { start, count }: { start: number; count: number }) =>
  model[pane].split('\n').slice(start - 1, start - 1 + count);

test('a change of one side is a region of that side, at the same place in the result', () => {
  const base = text('a', 'b', 'c', 'd', 'e');
  const ours = text('a', 'B', 'c', 'd', 'e');
  const theirs = text('a', 'b', 'c', 'd', 'E', 'f');
  const model = merge(base, ours, theirs, text('a', 'B', 'c', 'd', 'E', 'f'));
  assert.deepEqual(
    model.regions.map((region) => region.kind),
    ['ours', 'theirs'],
  );
  const [mine, other] = model.regions;
  assert.deepEqual(at(model, 'ours', mine.ours), ['B']);
  assert.deepEqual(at(model, 'result', mine.result), ['B']);
  assert.deepEqual(at(model, 'theirs', other.theirs), ['E', 'f']);
  assert.deepEqual(at(model, 'result', other.result), ['E', 'f']);
  assert.ok(model.regions.every((region) => !region.unresolved));
});

test('the same change on both sides is one region of both, not a conflict', () => {
  const model = merge(text('a', 'b', 'c'), text('a', 'X', 'c'), text('a', 'X', 'c'), text('a', 'X', 'c'));
  assert.deepEqual(
    model.regions.map((region) => region.kind),
    ['both'],
  );
});

test('a conflict points at the two parts between the markers of the result', () => {
  const base = text('one', 'two', 'three', 'four');
  const ours = text('one', 'mine', 'three', 'four');
  const theirs = text('one', 'yours', 'more', 'three', 'four');
  const result = text('one', '<<<<<<< HEAD', 'mine', '=======', 'yours', 'more', '>>>>>>> other', 'three', 'four');
  const model = merge(base, ours, theirs, result);
  assert.equal(model.regions.length, 1);
  const [conflict] = model.regions;
  assert.equal(conflict.kind, 'conflict');
  assert.ok(conflict.unresolved);
  assert.deepEqual(at(model, 'result', conflict.result), ['<<<<<<< HEAD', 'mine', '=======', 'yours', 'more', '>>>>>>> other']);
  assert.deepEqual(at(model, 'result', conflict.resultOurs), ['mine']);
  assert.deepEqual(at(model, 'result', conflict.resultTheirs), ['yours', 'more']);
  assert.deepEqual(at(model, 'ours', conflict.ours), ['mine']);
  assert.deepEqual(at(model, 'theirs', conflict.theirs), ['yours', 'more']);
  assert.deepEqual(model.markerLines, [2, 4, 7]);
});

test('the base part of diff3 markers is left out of both sides', () => {
  const result = text('one', '<<<<<<< ours', 'mine', '||||||| base', 'two', '=======', 'yours', '>>>>>>> theirs', 'three');
  const model = merge(text('one', 'two', 'three'), text('one', 'mine', 'three'), text('one', 'yours', 'three'), result);
  const [conflict] = model.regions;
  assert.deepEqual(at(model, 'result', conflict.resultOurs), ['mine']);
  assert.deepEqual(at(model, 'result', conflict.resultTheirs), ['yours']);
  assert.deepEqual(model.markerLines, [2, 4, 6, 8]);
});

test('a conflict resolved by hand is still a conflict region, over what took its place', () => {
  const model = merge(text('one', 'two', 'three'), text('one', 'mine', 'three'), text('one', 'yours', 'three'), text('one', 'mine and yours', 'three'));
  const [conflict] = model.regions;
  assert.equal(conflict.kind, 'conflict');
  assert.equal(conflict.unresolved, false);
  assert.deepEqual(at(model, 'result', conflict.result), ['mine and yours']);
  assert.deepEqual(conflict.resultOurs, conflict.result);
});

test('a file both sides added has an empty base, and is one conflict', () => {
  const result = text('<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> other');
  const model = merge('', text('a'), text('b'), result);
  assert.deepEqual(
    model.regions.map((region) => [region.kind, region.unresolved]),
    [['conflict', true]],
  );
  assert.deepEqual(at(model, 'result', model.regions[0].resultTheirs), ['b']);
});

test('the gutters have a chunk for each change of their side, and the scroll map one for every region', () => {
  const base = text('a', 'b', 'c', 'd', 'e');
  const model = merge(base, text('a', 'B', 'c', 'd', 'e'), text('a', 'b', 'c', 'd', 'E'), text('a', 'B', 'c', 'd', 'E'));
  const left = paneChunks(model.regions, 'ours', 'result', (region) => region.kind !== 'theirs');
  assert.deepEqual(
    left.map((chunk) => [chunk.leftStart, chunk.leftCount, chunk.rightStart, chunk.rightCount]),
    [[2, 1, 2, 1]],
  );
  const right = paneChunks(model.regions, 'result', 'theirs');
  assert.equal(right.length, 2);
  assert.deepEqual([right[1].leftStart, right[1].rightStart], [5, 5]);
});

test('a line of a side opens the result at the line it stands for', () => {
  const base = text('a', 'b', 'c');
  const ours = text('a', 'b', 'c');
  const theirs = text('x', 'y', 'a', 'b', 'c');
  const model = merge(base, ours, theirs, text('x', 'y', 'a', 'b', 'c'));
  assert.equal(resultLine(model, 'ours', 3), 5);
  assert.equal(resultLine(model, 'theirs', 1), 1);
  assert.equal(resultLine(model, 'theirs', 4), 4);
});

test('CRLF line endings are read as LF', () => {
  const model = merge('a\r\nb\r\n', 'a\r\nB\r\n', 'a\r\nb\r\n', 'a\r\nB\r\n');
  assert.equal(model.ours, 'a\nB\n');
  assert.deepEqual(
    model.regions.map((region) => region.kind),
    ['ours'],
  );
});

test('what git writes for a real merge is found region by region', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitardo-merge3-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8' });
  const file = path.join(dir, 'f.txt');
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  const write = (edit: (list: string[]) => void) => {
    const list = [...lines];
    edit(list);
    fs.writeFileSync(file, text(...list));
  };
  try {
    git('init', '-q', '-b', 'main');
    write(() => {});
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'other');
    write((list) => {
      list[1] = 'theirs 2';
      list[14] = 'theirs 15';
      list.splice(25, 0, 'theirs added');
    });
    git('commit', '-qam', 'theirs');
    git('checkout', '-q', 'main');
    write((list) => {
      list[14] = 'ours 15';
      list[20] = 'ours 21';
    });
    git('commit', '-qam', 'ours');
    try {
      git('merge', '-q', 'other');
    } catch {
      // stops on the conflict, which is the point
    }
    const show = (stage: number) => git('show', `:${stage}:f.txt`);
    const model = merge(show(1), show(2), show(3), fs.readFileSync(file, 'utf8'));
    assert.deepEqual(
      model.regions.map((region) => region.kind),
      ['theirs', 'conflict', 'ours', 'theirs'],
    );
    const conflict = model.regions[1];
    assert.ok(conflict.unresolved);
    assert.deepEqual(at(model, 'result', conflict.resultOurs), ['ours 15']);
    assert.deepEqual(at(model, 'result', conflict.resultTheirs), ['theirs 15']);
    assert.deepEqual(at(model, 'result', model.regions[0].result), ['theirs 2']);
    assert.deepEqual(at(model, 'result', model.regions[2].result), ['ours 21']);
    assert.deepEqual(at(model, 'result', model.regions[3].result), ['theirs added']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the merge editor starts from the base with the changes that do not conflict, and the base where they do', () => {
  // What the merge editor of VS Code had written in the file, without saving it, in the end-to-end suite.
  assert.equal(mergeEditorStart('bee\n', 'bee\nmain\n', 'bee\nfeature\n'), 'bee\n');
  const base = text('a', 'b', 'c', 'd', 'e');
  assert.equal(mergeEditorStart(base, text('A', 'b', 'c', 'X', 'e'), text('a', 'b', 'C', 'Y', 'e')), text('A', 'b', 'c', 'd', 'e'));
});
