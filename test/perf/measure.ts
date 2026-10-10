// Times what Gitar reads from a repository: node dist/perf.js <repository>
// Make a large one to try it on with test/perf/big-repo.mjs.

import { Repo } from '../../src/git/repo';
import { laneCount } from '../../src/shared/graph';

const [root] = process.argv.slice(2);
if (!root) {
  console.error('Usage: node dist/perf.js <repository>');
  process.exit(1);
}

async function timed<T>(what: string, run: () => Promise<T>, describe: (result: T) => string = () => ''): Promise<T> {
  const start = performance.now();
  const result = await run();
  console.log(`${`${Math.round(performance.now() - start)} ms`.padStart(9)}  ${what}  ${describe(result)}`);
  return result;
}

const kb = (value: unknown) => `${Math.round(JSON.stringify(value).length / 1024)} KB`;

async function main() {
  const commands: string[] = [];
  const repo = new Repo(root, (command) => commands.push(command));

  for (const limit of [1000, 5000, 20000]) {
    const state = await timed(
      `state, ${limit} commits`,
      () => repo.state(limit),
      (result) =>
        `${result.rows.length} rows, ${kb(result)} (rows ${kb(result.rows)}), ` +
        `widest ${Math.max(...result.rows.map((row) => laneCount(row.graph)))} lanes, ` +
        `${result.branches.length} branches, ${result.tags.length} tags, ${result.working.unstaged.length + result.working.staged.length} changes`,
    );
    if (limit === 1000) {
      const commit = state.rows.find((row) => row.parents.length === 1)!;
      await timed('details of a commit', () => repo.commitDetail(commit.hash), (detail) => `${detail?.files.length} files`);
      const merge = state.rows.find((row) => row.parents.length === 2)!;
      await timed('details of a merge', () => repo.commitDetail(merge.hash), (detail) => `${detail?.files.length} files`);
    }
  }
  await timed('working tree', () => repo.working(), (working) => `${working.unstaged.length} unstaged, ${working.staged.length} staged`);
  await timed('search by message', () => repo.state(1000, { kind: 'message', query: 'tooltip' }), (state) => `${state.rows.length} rows`);
  await timed('search by author', () => repo.state(1000, { kind: 'author', query: 'hopper' }), (state) => `${state.rows.length} rows`);
  await timed('search by change', () => repo.state(1000, { kind: 'pickaxe', query: 'line 4242' }), (state) => `${state.rows.length} rows`);
  const tracked = (await repo.show('HEAD', 'src/mod00/part0/file0.txt').catch(() => null)) !== null ? 'src/mod00/part0/file0.txt' : null;
  if (tracked) {
    await timed('history of a file', () => repo.state(1000, { kind: 'path', path: tracked }), (state) => `${state.rows.length} rows`);
    await timed('blame of a line', () => repo.blameLine(tracked, 1), (line) => line?.summary ?? 'none');
  }
  await timed('merged branches', () => repo.mergedBranches(), (branches) => `${branches.length}`);
  console.log(`\n${commands.length} git commands in all`);
}

void main();
