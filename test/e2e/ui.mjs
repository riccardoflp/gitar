// Looks at Gitar inside a real VS Code, and uses it the way a person does: node test/e2e/ui.mjs [--out=<folder>] [path to VS Code]
// VS Code starts as a separate instance with a throwaway profile and is driven through the DevTools protocol:
// real clicks, real keys, the real dialogs and pickers. A screenshot of each step is saved to the output folder.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sleep, until } from './cdp.mjs';
import { createWorkspace, git, remove, source } from './fixture.mjs';
import { CTRL, startWindow } from './window.mjs';

const options = process.argv.slice(2).filter((argument) => argument.startsWith('--'));
const [codePath] = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const out = path.resolve(options.find((option) => option.startsWith('--out='))?.slice(6) ?? path.join(source, 'dist', 'ui'));
const TIMEOUT = 240_000;
const WIDTH = 1500;
const HEIGHT = 950;

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitar-ui-'));
const { workspace, app } = createWorkspace(temp);
const window = await startWindow({ workspace, temp, out, codePath, width: WIDTH, height: HEIGHT });
const { shot, setting, mouse, clickText, key, type, prompt, command, webview, problems } = window;

const results = [];
const timer = setTimeout(() => finish(new Error(`Timed out after ${TIMEOUT / 1000}s.`)), TIMEOUT);

async function finish(error) {
  clearTimeout(timer);
  if (error) console.error(error.stack ?? String(error));
  for (const result of results) {
    console.log(`${result.ok ? '  ok  ' : ' FAIL '} ${result.name}`);
    if (!result.ok) console.log(result.error.replace(/^/gm, '        '));
  }
  const failed = results.filter((result) => !result.ok).length;
  if (problems.length) console.log(`\nErrors inside the views:\n${problems.join('\n')}`);
  console.log(`\n${results.length - failed} passed, ${failed} failed. Screenshots are in ${out}`);
  await window.close();
  remove(temp);
  process.exit(!error && results.length && !failed ? 0 : 1);
}

async function step(name, body) {
  try {
    await body();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.stack ?? String(error) });
    await shot(`failed-${name.replace(/\W+/g, '-').slice(0, 40)}`).catch(() => {});
    // Whatever was left open would be in the way of the next step.
    await key('Escape').catch(() => {});
    await key('Escape').catch(() => {});
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

try {
  const page = await window.ready();

  const subjects = (graph) => graph.evaluate(`[...document.querySelectorAll('.row .subject')].map((row) => row.textContent)`);
  /** What the toolbar looks like: whether the name of the branch can be read, and whether everything fits. */
  const toolbar = (graph) =>
    graph.evaluate(`(() => {
      const bar = document.querySelector('.toolbar');
      const name = document.querySelector('.current .name');
      const last = bar.lastElementChild.getBoundingClientRect();
      return {
        branch: name.textContent,
        branchWidth: Math.round(name.getBoundingClientRect().width),
        clipped: name.scrollWidth > name.clientWidth,
        fits: last.right <= bar.getBoundingClientRect().right + 1 && bar.scrollWidth <= bar.clientWidth + 1,
        width: Math.round(bar.getBoundingClientRect().width),
        search: Math.round(document.querySelector('.search').getBoundingClientRect().width),
      };
    })()`);

  await step('the graph shows in the panel, with icons, in the colors of the theme', async () => {
    await command('Gitar: Show Graph');
    const graph = await webview('graph');
    await until('the commits', () => graph.evaluate(`document.querySelectorAll('.row').length >= 4`));
    await shot('graph');
    assert((await subjects(graph)).join() === 'Add feature,Change a,Add b,Add a', `commits: ${await subjects(graph)}`);
    const look = await graph.evaluate(`({
      icons: document.fonts.check('16px codicon'),
      color: getComputedStyle(document.body).color,
      labels: [...document.querySelectorAll('.row .label')].map((label) => label.textContent),
    })`);
    assert(look.icons, 'the icon font is loaded');
    assert(look.labels.join() === 'feature,main,merged,origin/main', `labels: ${look.labels}`);
    // The dark theme VS Code starts with has light text.
    assert(/rgb\((2\d\d|1[5-9]\d), /.test(look.color), `text color ${look.color}`);
    const bar = await toolbar(graph);
    assert(bar.branch === 'main' && !bar.clipped && bar.fits, `toolbar: ${JSON.stringify(bar)}`);
  });

  await step('the toolbar still names the branch and fits when the panel is narrow', async () => {
    try {
      for (const width of [1050, 800]) {
        await page.send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
        await sleep(700);
        const graph = await webview('graph');
        const bar = await toolbar(graph);
        await shot(`narrow-${width}`);
        assert(bar.branch === 'main' && bar.branchWidth > 20 && bar.fits, `at ${width}px: ${JSON.stringify(bar)}`);
        assert(bar.search >= 150, `the search box is ${bar.search}px wide at ${width}px`);
      }
    } finally {
      await page.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
      await sleep(700);
    }
  });

  await step('the changes view lists what changed, and the icon in the activity bar counts it', async () => {
    fs.writeFileSync(path.join(app, 'b.txt'), 'bee\nbuzz\n');
    fs.writeFileSync(path.join(app, 'new.txt'), 'new\n');
    await command('Gitar: Show Changes');
    const changes = await webview('changes');
    await until('the two changed files', () => changes.evaluate(`document.querySelectorAll('.group .file').length === 2`));
    await shot('changes');
    const badge = await until('the badge', () =>
      page.evaluate(`[...document.querySelectorAll('.activitybar .badge-content')].map((badge) => badge.textContent).find((text) => text === '2')`),
    );
    assert(badge === '2', 'the badge says 2');
    const graph = await webview('graph');
    assert((await subjects(graph))[0] === 'Uncommitted changes (2)', 'the graph shows the uncommitted changes first');
    // One more change: the commits are the same, so they are not sent again, and only the count of the first row moves.
    fs.writeFileSync(path.join(app, 'third.txt'), 'third\n');
    await until('the count to follow', async () => (await subjects(graph))[0] === 'Uncommitted changes (3)');
    assert((await subjects(graph)).join() === 'Uncommitted changes (3),Add feature,Change a,Add b,Add a', `rows: ${await subjects(graph)}`);
    fs.rmSync(path.join(app, 'third.txt'));
    await until('the count to go back', async () => (await subjects(graph))[0] === 'Uncommitted changes (2)');
    await until('the two changed files again', () => changes.evaluate(`document.querySelectorAll('.group .file').length === 2`));
  });

  await step('stages a file with a click and commits it with a typed message', async () => {
    const changes = await webview('changes');
    await changes.click('.group .file', 'b.txt');
    await sleep(300);
    // The row buttons only show under the pointer, which is now there.
    const stage = await changes.evaluate(`(() => {
      const row = [...document.querySelectorAll('.group .file')].find((file) => file.textContent.includes('b.txt'));
      const rect = row.querySelector('button[title="Stage"]').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await mouse(changes.frame.x + stage.x, changes.frame.y + stage.y);
    await until('the staged file', () =>
      changes.evaluate(`[...document.querySelectorAll('.group header .grow')].map((header) => header.textContent).includes('Staged changes')`),
    );
    await changes.click('.commit-box textarea');
    await type('Commit from the UI');
    await shot('before-commit');
    await changes.click('.commit-actions .button.primary');
    const graph = await webview('graph');
    await until('the new commit in the graph', async () => (await subjects(graph))[1] === 'Commit from the UI');
    assert((await subjects(graph))[0] === 'Uncommitted changes (1)', 'the untracked file is still to commit');
    // Told apart from the new state, a moment after it.
    await until('the message box to be empty again', () => changes.evaluate(`document.querySelector('.commit-box textarea').value === ''`), 5000);
    assert(git(app, 'log', '--format=%s', '-1').toString().trim() === 'Commit from the UI', 'git has the commit');
  });

  await step('the context menu of a commit opens where it was clicked, and creates a branch through the real prompts', async () => {
    const graph = await webview('graph');
    const at = await graph.locate('.row', 'Add b');
    await mouse(at.x, at.y, 'right');
    const items = await until('the context menu', () =>
      graph.evaluate(`(() => { const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent); return items.length ? items : null; })()`),
    );
    await shot('context-menu');
    const short = git(app, 'log', '--format=%h', '--abbrev=7', '--grep=Add b', 'main').toString().trim();
    assert(items.includes('Create branch here…') && items.includes(`Cherry-pick ${short}`), `menu: ${items}`);
    const menu = await graph.evaluate(`(() => {
      const element = document.querySelector('[role="menu"]');
      const rect = element.getBoundingClientRect();
      const inside = (item) => { const box = item.getBoundingClientRect(); return box.top >= rect.top && box.bottom <= rect.bottom && box.left >= rect.left && box.right <= rect.right; };
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight, hidden: [...element.querySelectorAll('[role="menuitem"]')].filter((item) => !inside(item)).length };
    })()`);
    assert(menu.right <= menu.width && menu.bottom <= menu.height && menu.x >= 0 && menu.y >= 0, `the menu is inside the view: ${JSON.stringify(menu)}`);
    // The panel is too short for the entries one under the other.
    assert(menu.hidden === 0, `every entry can be seen without scrolling: ${JSON.stringify(menu)}`);

    await graph.click('[role="menuitem"]', 'Create branch here…');
    await until('the prompt for the name', async () => (await prompt())?.title === 'Create branch');
    await type('from-ui');
    await shot('input-box');
    await key('Enter');
    const pick = await until('the choice of what to do with it', async () => {
      const open = await prompt();
      return open?.items?.includes('Create only') ? open : null;
    });
    assert(pick.title === 'Create branch from-ui', `title: ${pick.title}`);
    await shot('quick-pick');
    await clickText('.quick-input-list .monaco-list-row', 'Create only');
    await until('the label of the new branch', () =>
      graph.evaluate(`[...document.querySelectorAll('.row')].find((row) => row.textContent.includes('Add b'))?.querySelector('.label.branch')?.textContent === 'from-ui'`),
    );
    assert(git(app, 'branch', '--list', 'from-ui').toString().includes('from-ui'), 'git has the branch');
    assert(git(app, 'symbolic-ref', '--short', 'HEAD').toString().trim() === 'main', 'main is still checked out');
  });

  await step('with the command preview on, a real dialog shows the exact command and Cancel runs nothing', async () => {
    setting('gitar.commandPreview', 'all');
    await sleep(1500);
    const changes = await webview('changes');
    const stage = async () => {
      await changes.click('.group .file', 'new.txt');
      await sleep(200);
      const rect = await changes.evaluate(`(() => { const rect = document.querySelector('.group .file button[title="Stage"]').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`);
      await mouse(changes.frame.x + rect.x, changes.frame.y + rect.y);
      return until('the confirmation', async () => ((await prompt())?.kind === 'dialog' ? prompt() : null));
    };
    let dialog = await stage();
    await shot('command-preview');
    assert(dialog.text.includes('Stage new.txt?') && /git add -- new\.txt\s*$/.test(dialog.text), `dialog: ${JSON.stringify(dialog)}`);
    assert(dialog.buttons.join() === 'Run,Cancel', `buttons: ${dialog.buttons}`);
    await clickText('.monaco-dialog-box .monaco-button', 'Cancel');
    await sleep(800);
    assert(git(app, 'status', '--porcelain').toString().trim() === '?? new.txt', 'nothing was staged');

    dialog = await stage();
    await clickText('.monaco-dialog-box .monaco-button', 'Run');
    await until('the file to be staged', () => git(app, 'status', '--porcelain').toString().trim() === 'A  new.txt');
    setting('gitar.commandPreview', 'off');
    await sleep(1000);
    // Close the diff that selecting the file opened.
    await command('View: Close All Editors');
  });

  await step('the line under the cursor is annotated with who changed it', async () => {
    await key('P', CTRL);
    await until('quick open', async () => (await prompt())?.kind === 'quick');
    await type('a.txt');
    await until('the file in the list', async () => (await prompt())?.items?.some((item) => item.includes('a.txt')));
    await key('Enter');
    await until('the editor', () => page.evaluate(`document.querySelectorAll('.editor-instance .view-line').length >= 2`));
    await clickText('.editor-instance .view-line', 'two');
    const blame = await until('the annotation', () =>
      page.evaluate(`[...document.querySelectorAll('.editor-instance .view-line span')].map((span) => getComputedStyle(span, '::after').content).find((content) => content.includes('Change a')) ?? null`),
    );
    await shot('blame');
    assert(/Gitar Test, .+ • Change a/.test(blame), `annotation: ${blame}`);
  });

  await step('a branch dragged onto the checked out commit offers to merge or rebase', async () => {
    const graph = await webview('graph');
    const from = await graph.locate('.row .label.branch', 'feature');
    const to = await graph.locate('.row', 'Commit from the UI');
    const dragged = new Promise((resolve) => page.on('Input.dragIntercepted', resolve));
    await page.send('Input.setInterceptDrags', { enabled: true });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let moved = 1; moved <= 5; moved++) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + moved * 6, y: from.y + moved * 4, button: 'left', buttons: 1 });
    }
    const { data } = await Promise.race([dragged, sleep(5000).then(() => ({}))]);
    assert(data, 'the drag started');
    for (const kind of ['dragEnter', 'dragOver', 'dragOver']) {
      await page.send('Input.dispatchDragEvent', { type: kind, x: to.x, y: to.y, data });
      await sleep(100);
    }
    await shot('drag-over');
    const outlined = await graph.evaluate(`document.querySelector('.row.drop-target .subject')?.textContent ?? null`);
    await page.send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left' });
    await page.send('Input.setInterceptDrags', { enabled: false });
    const items = await until('the menu of the drop', () =>
      graph.evaluate(`(() => { const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent); return items.length ? items : null; })()`),
    );
    await shot('drop-menu');
    assert(outlined === 'Commit from the UI', `outlined row: ${outlined}`);
    assert(items.join() === 'Merge feature into main,Rebase main onto feature', `menu: ${items}`);
    await key('Escape');
  });

  await step('follows the theme when it changes to a light one', async () => {
    setting('workbench.colorTheme', 'Default Light Modern');
    await until('the light theme', () => page.evaluate(`document.querySelector('.monaco-workbench').classList.contains('vs')`));
    await sleep(800);
    const graph = await webview('graph');
    const color = await graph.evaluate(`getComputedStyle(document.body).color`);
    await shot('light');
    assert(/rgb\((\d|[1-9]\d|1[0-2]\d), /.test(color), `text color ${color}`);
    setting('workbench.colorTheme', undefined);
    await until('the dark theme', () => page.evaluate(`document.querySelector('.monaco-workbench').classList.contains('vs-dark')`));
  });

  await step('opens the graph as an editor tab, with the details of a commit beside it', async () => {
    await command('Gitar: Open Graph in Editor');
    // The one in the panel is still there, lower down.
    const graph = await webview('graph', (frame) => frame.y < 300);
    await graph.click('.row', 'Add feature');
    await until('the details', () => graph.evaluate(`document.querySelector('.detail h2')?.textContent === 'Add feature'`));
    await until('the files', () => graph.evaluate(`document.querySelectorAll('.detail .file').length === 2`));
    await shot('editor-tab');
    const bar = await toolbar(graph);
    assert(bar.fits && bar.branch === 'main', `toolbar: ${JSON.stringify(bar)}`);
  });
} catch (error) {
  await finish(error);
}
await finish();
