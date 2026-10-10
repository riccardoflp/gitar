// Makes a large repository to try Gitar on: node test/perf/big-repo.mjs <folder> [commits on main] [changed files]
// A long main line with a side branch forked and merged back every few commits, a few hundred branches never merged,
// thousands of tags, remote branches, and optionally a working tree with many changed and untracked files.

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const [folder, commitsGiven, changedGiven] = process.argv.slice(2);
if (!folder) {
  console.error('Usage: node test/perf/big-repo.mjs <folder> [commits on main] [changed files]');
  process.exit(1);
}
const MAIN_COMMITS = Number(commitsGiven ?? 50_000);
const CHANGED_FILES = Number(changedGiven ?? 0);
const FILES = 3000;
const AUTHORS = ['Ada Lovelace', 'Grace Hopper', 'Linus Torvalds', 'Margaret Hamilton', 'Dennis Ritchie', 'Barbara Liskov', 'José Ñandú', '山田 太郎'];

const root = path.resolve(folder);
fs.mkdirSync(root, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
git('init', '--quiet', '--initial-branch=main');
git('config', 'user.name', 'Gitar Test');
git('config', 'user.email', 'test@gitar.invalid');
git('config', 'core.autocrlf', 'false');

const importer = spawn('git', ['fast-import', '--quiet'], { cwd: root, stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise((resolve, reject) => importer.on('close', (code) => (code ? reject(new Error(`git fast-import exited with ${code}`)) : resolve())));
let buffered = [];
async function write(text) {
  buffered.push(text);
  if (buffered.length < 2000) return;
  const chunk = buffered.join('');
  buffered = [];
  if (!importer.stdin.write(chunk)) await new Promise((resolve) => importer.stdin.once('drain', resolve));
}

// A small generator of repeatable numbers, so that the repository is the same every time.
let seed = 42;
const random = (below) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % below;
};

const file = (index) => `src/mod${String(index % 60).padStart(2, '0')}/part${index % 7}/file${index}.txt`;
let mark = 0;
let time = 1_500_000_000;
let total = 0;

async function commit(ref, subject, parents, body = '') {
  const author = AUTHORS[random(AUTHORS.length)];
  const email = `${author.split(' ')[0].toLowerCase()}@gitar.invalid`;
  const message = body ? `${subject}\n\n${body}\n` : `${subject}\n`;
  const changed = random(FILES);
  const content = `${subject}\nline ${total}\n`;
  time += 60 + random(1200);
  total++;
  await write(
    `commit ${ref}\nmark :${++mark}\nauthor ${author} <${email}> ${time} +0000\ncommitter ${author} <${email}> ${time} +0000\n` +
      `data ${Buffer.byteLength(message)}\n${message}` +
      parents.map((parent, index) => `${index ? 'merge' : 'from'} :${parent}\n`).join('') +
      `M 100644 inline ${file(changed)}\ndata ${Buffer.byteLength(content)}\n${content}\n`,
  );
  return mark;
}

const VERBS = ['Add', 'Fix', 'Refactor', 'Remove', 'Rename', 'Document', 'Speed up', 'Simplify', 'Test'];
const NOUNS = ['parser', 'cache', 'login form', 'scheduler', 'export', 'settings page', 'retry logic', 'index', 'tooltip', 'migration'];
const subject = () => `${VERBS[random(VERBS.length)]} the ${NOUNS[random(NOUNS.length)]}`;

/** Side branches under way: where they are, how many commits they still get, and whether they are merged back at the end. */
let open = [];
let main = await commit('refs/heads/main', 'Initial commit', []);
let topics = 0;
let features = 0;
let tags = 0;

for (let index = 1; index < MAIN_COMMITS; index++) {
  if (index % 25 === 0) {
    const keep = index % 200 === 0;
    const name = keep ? `refs/heads/feature/${String(++features).padStart(3, '0')}-${NOUNS[random(NOUNS.length)].replaceAll(' ', '-')}` : `refs/scratch/${++topics}`;
    open.push({ name, tip: main, left: 1 + random(6), wait: 3 + random(25), keep });
  }
  for (const branch of open) {
    if (branch.left && random(3) === 0) {
      branch.tip = await commit(branch.name, subject(), [branch.tip]);
      branch.left--;
    }
  }
  const ready = open.find((branch) => !branch.keep && !branch.left && --branch.wait <= 0);
  if (ready) {
    main = await commit('refs/heads/main', `Merge branch 'topic-${ready.name.split('/').pop()}'`, [main, ready.tip]);
    open = open.filter((branch) => branch !== ready);
  } else {
    main = await commit('refs/heads/main', subject(), [main], index % 500 === 0 ? 'A longer description.\n'.repeat(40) : '');
  }
  open = open.filter((branch) => !branch.keep || branch.left);
  if (index % 25 === 12) await write(`reset refs/tags/v${Math.floor(tags / 100)}.${tags++ % 100}.0\nfrom :${main}\n\n`);
  if (index % 400 === 0 && features) {
    await write(`reset refs/remotes/origin/feature/${String(features).padStart(3, '0')}\nfrom :${main}\n\n`);
  }
  if (index === MAIN_COMMITS - 4) await write(`reset refs/remotes/origin/main\nfrom :${main}\n\n`);
}
importer.stdin.end(buffered.join(''));
await done;

// The side branches that were merged only needed a name while they were being written.
const scratch = git('for-each-ref', '--format=delete %(refname)', 'refs/scratch');
if (scratch) execFileSync('git', ['update-ref', '--stdin'], { cwd: root, input: scratch });
git('config', 'remote.origin.url', 'https://github.com/gitar-test/big.git');
git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
git('config', 'branch.main.remote', 'origin');
git('config', 'branch.main.merge', 'refs/heads/main');
git('reset', '--hard', '--quiet', 'main');

for (let index = 0; index < CHANGED_FILES; index++) {
  // Two changed files out of three, one new.
  const target = index % 3 === 2 ? path.join(root, `new/dir${index % 40}/untracked${index}.txt`) : path.join(root, file(index));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `changed ${index}\n`);
}

console.log(`${root}: ${total} commits, ${features} unmerged branches, ${tags} tags, ${CHANGED_FILES} changed files`);
