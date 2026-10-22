// Opens a repository in a real VS Code and times what a person waits for: node test/perf/vscode.mjs <repository> [--out=<folder>] [path to VS Code]
// Meant for a large one, such as test/perf/big-repo.mjs makes. The only thing it changes there is a file it adds and removes.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sleep, until } from '../e2e/cdp.mjs';
import { remove, source } from '../e2e/fixture.mjs';
import { startWindow } from '../e2e/window.mjs';

const options = process.argv.slice(2).filter((argument) => argument.startsWith('--'));
const [repository, codePath] = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
if (!repository) {
  console.error('Usage: node test/perf/vscode.mjs <repository> [--out=<folder>] [path to VS Code]');
  process.exit(1);
}
const out = path.resolve(options.find((option) => option.startsWith('--out='))?.slice(6) ?? path.join(source, 'dist', 'perf'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitardo-perf-'));
const window = await startWindow({ workspace: path.resolve(repository), temp, out, codePath });
const { shot, command, webview, problems } = window;
const timer = setTimeout(() => finish(new Error('Timed out.')), 240_000);
const probe = path.join(path.resolve(repository), 'gitardo-perf.txt');

const report = (what, value) => console.log(`${String(value).padStart(10)}  ${what}`);

async function finish(error) {
  clearTimeout(timer);
  fs.rmSync(probe, { force: true });
  if (error) console.error(error.stack ?? String(error));
  if (problems.length) console.log(`\nErrors inside the views:\n${problems.join('\n')}`);
  console.log(`\nScreenshots are in ${out}`);
  await window.close();
  remove(temp);
  process.exit(error || problems.length ? 1 : 0);
}

/** Runs inside a view: does something, and times the state that comes back and how long the view takes to show it. */
const TIMED = `(act) => new Promise((resolve) => {
  const started = performance.now();
  const listener = (event) => {
    if (event.data?.type !== 'state') return;
    removeEventListener('message', listener);
    const received = performance.now();
    requestAnimationFrame(() => setTimeout(() => resolve({
      wait: Math.round(received - started),
      draw: Math.round(performance.now() - received),
      sent: event.data.state.rows.length,
      kept: event.data.kept ?? 0,
    }), 0));
  };
  addEventListener('message', listener);
  act();
})`;

try {
  await window.ready();
  const started = Date.now();
  await command('Gitardo: Show Graph');
  const graph = await webview('graph');
  await until('the commits', () => graph.evaluate(`document.querySelectorAll('.row').length > 5`), 60_000);
  report('to open the graph from the command palette', `${Date.now() - started} ms`);
  const count = (selector) => graph.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  report('elements in the graph view', await count('*'));
  report('references listed', `${await count('.refs .ref')} of ${await graph.evaluate(`[...document.querySelectorAll('.refs .count')].reduce((sum, badge) => sum + Number(badge.textContent), 0)`)}`);
  await shot('graph');

  const describe = (timing) => `${timing.wait} ms + ${timing.draw} ms to draw (${timing.kept ? `${timing.kept} rows not sent again, ${timing.sent} sent` : `${timing.sent} commits sent`})`;
  const refresh = () => graph.evaluate(`(${TIMED})(() => document.querySelector('button[aria-label="Refresh"]').click())`);
  await refresh();
  report('refresh', describe(await refresh()));

  const subject = () => graph.evaluate(`document.querySelector('.row .subject')?.textContent ?? ''`);
  const before = await subject();
  const changed = Date.now();
  fs.writeFileSync(probe, 'changed\n');
  await until('the view to notice the new file', async () => (await subject()) !== before, 30_000);
  report(`for a new file to show: "${await subject()}"`, `${Date.now() - changed} ms`);

  for (let page = 0; page < 4; page++) {
    const timing = await graph.evaluate(`(${TIMED})(() => { const list = document.querySelector('.commits'); list.scrollTop = list.scrollHeight; })`);
    report(`next page of commits, ${timing.sent} loaded`, describe(timing));
  }
  report('refresh with those loaded', describe(await refresh()));
  const selected = await graph.evaluate(`new Promise((resolve) => {
    const started = performance.now();
    document.querySelectorAll('.row')[4].click();
    requestAnimationFrame(() => setTimeout(() => resolve(Math.round(performance.now() - started)), 0));
  })`);
  report('to select a commit', `${selected} ms`);
  await until('the details', () => graph.evaluate(`!!document.querySelector('.detail h2')`));
  await shot('details');

  // The filter of the references, typed the way a person does.
  const filterAt = await graph.locate('.refs-filter input');
  await window.mouse(filterAt.x, filterAt.y);
  await window.type('feature/00');
  await until('the filtered references', async () => (await count('.refs .ref')) < 30);
  report('references matching "feature/00"', await count('.refs .ref'));
  await shot('filter');

  await command('Gitardo: Show Changes');
  const changes = await webview('changes');
  await until('the changed files', () => changes.evaluate(`document.querySelectorAll('.group .file').length > 0`), 30_000);
  report('changed files listed', `${await changes.evaluate(`document.querySelectorAll('.group .file').length`)} of ${await changes.evaluate(`[...document.querySelectorAll('.group .count')].reduce((sum, badge) => sum + Number(badge.textContent), 0)`)}`);
  const box = await changes.locate('.commit-box textarea');
  await window.mouse(box.x, box.y);
  const typing = Date.now();
  for (const letter of 'A message typed letter by letter') await window.type(letter);
  await until('the typed message', () => changes.evaluate(`document.querySelector('.commit-box textarea').value === 'A message typed letter by letter'`));
  report('to type a message of 32 letters', `${Date.now() - typing} ms`);
  await shot('changes');
  await sleep(300);
} catch (error) {
  await finish(error);
}
await finish();
