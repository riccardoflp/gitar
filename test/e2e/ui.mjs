// Looks at Gitar inside a real VS Code, and uses it the way a person does: node test/e2e/ui.mjs [--out=<folder>] [path to VS Code]
// VS Code starts as a separate instance with a throwaway profile and is driven through the DevTools protocol:
// real clicks, real keys, the real dialogs and pickers. A screenshot of each step is saved to the output folder.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sleep, until } from './cdp.mjs';
import { createWorkspace, git, remove, source } from './fixture.mjs';
import { CTRL, SHIFT, startWindow } from './window.mjs';

const options = process.argv.slice(2).filter((argument) => argument.startsWith('--'));
const [codePath] = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const out = path.resolve(options.find((option) => option.startsWith('--out='))?.slice(6) ?? path.join(source, 'dist', 'ui'));
const TIMEOUT = 360_000;
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
      outlines: [...document.querySelectorAll('.row .label')].map((label) => getComputedStyle(label).borderTopColor),
      dots: [...document.querySelectorAll('.row .label')].map((label) => getComputedStyle(label.closest('.row').querySelector('circle')).fill),
    })`);
    assert(look.icons, 'the icon font is loaded');
    assert(look.labels.join() === 'feature,main,merged,origin/main', `labels: ${look.labels}`);
    // Each label is outlined in the color of the line its commit is on.
    assert(look.outlines.join() === look.dots.join(), `outlines ${look.outlines} for dots ${look.dots}`);
    // The dark theme VS Code starts with has light text.
    assert(/rgb\((2\d\d|1[5-9]\d), /.test(look.color), `text color ${look.color}`);
    const bar = await toolbar(graph);
    assert(bar.branch === 'main' && !bar.clipped && bar.fits, `toolbar: ${JSON.stringify(bar)}`);
  });

  /**
   * Takes the pointer off the status bar, where opening a command leaves it: in a narrow window what is under it there
   * is an item that opens over the panel when it is pointed at.
   */
  const aside = () => page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 300 });

  await step('the toolbar still names the branch and fits when the panel is narrow', async () => {
    try {
      await aside();
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

  /** The headers of the views in the side bar, top to bottom, and whether each view is unfolded. */
  const panes = () =>
    page.evaluate(`[...document.querySelectorAll('.sidebar .pane-header')].map((header) => ({
      title: header.querySelector('.title')?.textContent ?? '',
      open: header.getAttribute('aria-expanded') === 'true',
    }))`);
  /** Folds a view of the side bar with a click on its header, as one does to make room for the others. */
  const fold = async (title) => {
    const at = await page.evaluate(`(() => {
      const header = [...document.querySelectorAll('.sidebar .pane-header')].find(
        (candidate) => candidate.querySelector('.title')?.textContent === ${JSON.stringify(title)} && candidate.getAttribute('aria-expanded') === 'true',
      );
      const rect = header?.querySelector('.title').getBoundingClientRect();
      return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
    })()`);
    if (!at) return;
    await mouse(at.x, at.y);
    await sleep(500);
  };

  await step('the views are in the Source Control side bar of VS Code, folded under its own, and the one of the changes is hidden until asked for', async () => {
    // With a click on its icon in the activity bar.
    const icon = await page.evaluate(`(() => {
      const icon = [...document.querySelectorAll('.activitybar .action-item a')].find((candidate) => candidate.getAttribute('aria-label')?.startsWith('Source Control'));
      const rect = icon?.getBoundingClientRect();
      return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
    })()`);
    assert(icon, 'the activity bar has the icon of Source Control');
    await mouse(icon.x, icon.y);
    const first = await until('the views of Gitar', async () => {
      const now = await panes();
      return now.some((pane) => pane.title === 'Commits') ? now : null;
    });
    await shot('source-control');
    const titles = first.map((pane) => pane.title);
    // Under the views of VS Code, in this order, and none of them open before it is wanted.
    assert(titles.slice(-3).join() === 'Commits,Branches,Stashes', `views: ${titles}`);
    assert(first.slice(-3).every((pane) => !pane.open), `folded: ${JSON.stringify(first)}`);
    assert(!titles.includes('Gitar Changes'), `the changes of Gitar are not shown: ${titles}`);
    // Gitar has no icon of its own in the activity bar: the graph is in the panel, and the rest is here.
    const icons = await page.evaluate(`[...document.querySelectorAll('.activitybar .action-item a')].map((icon) => icon.getAttribute('aria-label') ?? '')`);
    assert(!icons.some((label) => label.startsWith('Gitar')), `activity bar: ${icons}`);
  });

  await step('the changes view of Gitar shows when it is asked for, and lists what changed', async () => {
    fs.writeFileSync(path.join(app, 'b.txt'), 'bee\nbuzz\n');
    fs.writeFileSync(path.join(app, 'new.txt'), 'new\n');
    await command('Gitar: Show Changes');
    await until('the view', async () => (await panes()).some((pane) => pane.title === 'Gitar Changes' && pane.open));
    // The views of VS Code above it take most of the side bar: they are folded, to give the room to the ones under test.
    await fold('Changes');
    await fold('Graph');
    const changes = await webview('changes');
    await until('the two changed files', () => changes.evaluate(`document.querySelectorAll('.group .file').length === 2`));
    await shot('changes');
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

  await step('the button of the editor shows who changed each line beside it, with the color of its age and the lines of the commit under the cursor standing out, and the file as it was before a commit', async () => {
    /** What stands before each line of the editor, and where the text of the line starts. */
    const beside = () =>
      page.evaluate(`[...document.querySelectorAll('.editor-instance .view-line')]
        .map((line) => {
          const span = [...line.querySelectorAll('span span')].find((candidate) => getComputedStyle(candidate, '::before').content !== 'none');
          const before = span ? getComputedStyle(span, '::before') : null;
          return {
            top: line.getBoundingClientRect().top,
            label: before ? before.content.replace(/^"|"$/g, '').replace(/\u00a0/g, ' ') : null,
            width: before ? Math.round(parseFloat(before.width)) : 0,
            lit: before ? !['rgba(0, 0, 0, 0)', 'transparent'].includes(before.backgroundColor) : false,
            bar: before ? before.borderLeftWidth + ' ' + before.borderLeftColor : null,
            height: Math.round(line.getBoundingClientRect().height),
            text: line.textContent,
          };
        })
        .sort((one, other) => one.top - other.top)`);
    const plain = await beside();
    assert(plain.length >= 2 && plain.every((line) => line.label === null), `before: ${JSON.stringify(plain)}`);
    // The buttons that are about a blame that is shown are not there while none is.
    const about = () =>
      page.evaluate(`[...document.querySelectorAll('.editor-actions .action-label')].map((label) => label.getAttribute('aria-label') ?? '').filter((name) => /Blame/.test(name)).map((name) => name.replace(/ \\(.*$/, ''))`);
    assert((await about()).join() === 'Show File Blame', `buttons: ${await about()}`);

    await page.evaluate(`document.querySelector('.editor-actions .action-label[aria-label^="Show File Blame"]').click()`);
    const lines = await until('the blame beside the lines', async () => {
      const now = await beside();
      return now.length && now.every((line) => line.label) ? now : null;
    });
    await shot('file-blame');
    await until('the buttons of a blame that is shown', async () =>
      (await about()).join() === 'Hide File Blame,Ignore Whitespace and Moved Lines in Blame,Keep File Blame On in Every File',
    );
    // The day and the name beside the lines that are in a commit, and room beside the empty one that ends the file.
    assert(
      lines.every((line) => (line.text ? /^\d{4}-\d\d-\d\d Gitar Test$/.test(line.label) : line.label === ' ')),
      `labels: ${JSON.stringify(lines)}`,
    );
    // As wide for every line, no wider than what it says, and the lines as tall as they were.
    const letter = lines[0].width / '2026-10-13 Gitar Test'.length;
    assert(lines.every((line) => line.width === lines[0].width) && letter > 5 && letter < 12, `widths: ${JSON.stringify(lines)}`);
    assert(lines.every((line, index) => line.height === plain[index].height), `heights: ${JSON.stringify(lines)} were ${JSON.stringify(plain)}`);
    // At the left of each a line in the color of its age: the one of what was just changed, which all of this was.
    // About three pixels wide, as near as the screen draws them.
    assert(
      lines.every((line) => parseFloat(line.bar) >= 2 && parseFloat(line.bar) <= 4 && line.bar.endsWith(line.text ? ' rgb(229, 83, 75)' : ' rgba(0, 0, 0, 0)')),
      `ages: ${JSON.stringify(lines)}`,
    );

    // What is beside the line under the cursor stands out, and not what is beside a line of another commit.
    const lit = async () => (await beside()).map((line) => (line.lit ? line.text : '')).filter(Boolean).join();
    assert((await lit()) === 'two', `standing out: ${await lit()}`);
    await clickText('.editor-instance .view-line', 'one');
    await until('the other commit standing out', async () => (await lit()) === 'one');
    // The lines of one commit stand out together: here the ones that are in none yet, written by something else.
    const file = path.join(app, 'a.txt');
    const original = fs.readFileSync(file, 'utf8');
    try {
      fs.writeFileSync(file, `${original}three\nfour\n`);
      // Said once for the lines that follow each other.
      await until('the lines written', async () => (await beside()).map((line) => line.label).slice(2, 4).join('|') === 'Not committed yet| ');
      assert((await lit()) === 'one', `standing out: ${await lit()}`);
      await clickText('.editor-instance .view-line', 'three');
      await until('the lines of no commit standing out', async () => (await lit()) === 'three,four');
      await shot('file-blame-commit');
    } finally {
      fs.writeFileSync(file, original);
    }
    await until('the file as it was', async () => (await beside()).length === lines.length);

    // The buttons beside it: one leaves lines to who wrote them when only their whitespace changed, one shows the blame in every file.
    const button = (name) => `.editor-actions .action-label[aria-label^="${name}"]`;
    const press = async (name, becomes) => {
      await page.evaluate(`document.querySelector(${JSON.stringify(button(name))}).click()`);
      await until(`the button "${becomes}"`, () => page.evaluate(`!!document.querySelector(${JSON.stringify(button(becomes))})`));
    };
    await press('Ignore Whitespace and Moved Lines in Blame', 'Stop Ignoring Whitespace and Moved Lines in Blame');
    await press('Keep File Blame On in Every File', 'Stop Keeping File Blame On in Every File');
    await shot('file-blame-buttons');
    await press('Stop Ignoring Whitespace and Moved Lines in Blame', 'Ignore Whitespace and Moved Lines in Blame');
    await press('Stop Keeping File Blame On in Every File', 'Keep File Blame On in Every File');
    // The file had its blame asked for, and keeps it.
    assert((await beside()).every((line) => line.label), 'the blame stays');

    // The file as it was before the commit of a line, in a tab that says of which commit, with the blame it had then.
    await clickText('.editor-instance .view-line', 'two');
    await until('the line under the cursor', async () => (await lit()) === 'two');
    await command('Gitar: Blame File Before Commit of Current Line');
    const tab = await until('the tab of the file as it was', () =>
      page.evaluate(`[...document.querySelectorAll('.tabs-container .tab.active')].map((tab) => tab.textContent).find((name) => /^a \\([0-9a-f]{7}\\)\\.txt/.test(name)) ?? null`),
    );
    const past = await until('its blame', async () => {
      const now = (await beside()).filter((line) => line.text);
      return now.length === 1 && now[0].label ? now : null;
    });
    await shot('file-blame-before');
    assert(past[0].text === 'one' && /^\d{4}-\d\d-\d\d Gitar Test$/.test(past[0].label), `${tab}: ${JSON.stringify(past)}`);
    // By the keyboard: the palette puts the commands used last first, and one of them closes every editor.
    await clickText('.editor-instance .view-line', 'one');
    await key('W', CTRL);
    await until('the file again', async () => (await beside()).filter((line) => line.text).length === 2);

    // The button is now the one that hides it.
    await until('the button that hides it', () => page.evaluate(`!!document.querySelector('.editor-actions .action-label[aria-label^="Hide File Blame"]')`));
    await page.evaluate(`document.querySelector('.editor-actions .action-label[aria-label^="Hide File Blame"]').click()`);
    await until('the lines alone', async () => (await beside()).every((line) => line.label === null));
    await until('the button that shows it alone', async () => (await about()).join() === 'Show File Blame');
  });

  await step('the search counts what it finds and steps through it, in the loaded commits and in the whole history', async () => {
    const graph = await webview('graph');
    /** What the search box says, which commit is selected, and how the commits are shown. */
    const seen = () =>
      graph.evaluate(`({
        count: document.querySelector('.search .count')?.textContent ?? null,
        hint: document.querySelector('.search .hint')?.textContent.trim() ?? null,
        selected: document.querySelector('.row.selected .subject')?.textContent ?? null,
        rows: document.querySelectorAll('.row').length,
        dimmed: document.querySelectorAll('.row.dimmed').length,
        filter: document.querySelector('.filterbar')?.textContent ?? null,
      })`);
    const says = (what, count, selected) => until(what, async () => {
      const now = await seen();
      return now.count === count && now.selected === selected ? now : null;
    });
    const write = async (text) => {
      await graph.click('.search input');
      await graph.evaluate(`document.querySelector('.search input').select()`);
      await type(text);
    };
    /** The list beside the box, set the way a choice from it sets it. */
    const mode = (value) =>
      graph.evaluate(`(() => {
        const list = document.querySelector('.search select');
        list.value = ${JSON.stringify(value)};
        list.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    // Nothing selected, to begin with.
    if ((await seen()).selected) await graph.click('.detail .close');
    const everything = (await seen()).rows;

    // Among the loaded commits, as it is typed.
    await write('Add');
    const typed = await says('the matches', '3', null);
    assert(typed.dimmed === everything - 3, `the others are dimmed: ${JSON.stringify(typed)}`);
    await key('Enter');
    await says('the first match', '1/3', 'Add feature');
    await graph.click('.search .step[aria-label="Next match"]');
    await says('the second match', '2/3', 'Add b');
    assert(await graph.evaluate(`document.activeElement === document.querySelector('.search input')`), 'the focus stays in the box');
    // A key sent on the heels of a click can get to the window before the view has the keyboard back.
    await sleep(300);
    await key('F3');
    await says('the third match', '3/3', 'Add a');
    await key('Enter');
    await says('the first match again', '1/3', 'Add feature');
    await key('Enter', SHIFT);
    await says('the last match, going back', '3/3', 'Add a');
    await key('F3', SHIFT);
    await says('the one before it', '2/3', 'Add b');
    await shot('search-steps');

    // A hash, also of a commit that is not in the graph because no branch reaches it.
    const second = git(app, 'log', '--format=%H', '--grep=Change a', 'main').toString().trim();
    await write(second.slice(0, 9));
    const hashed = await says('the commit with that hash', '1', 'Add b');
    assert(hashed.hint === null, 'a hash that is loaded is not looked for elsewhere');
    await key('Enter');
    await says('the commit with that hash, selected', '1/1', 'Change a');
    const lost = git(app, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Lost and found').toString().trim();
    await write(lost.slice(0, 9));
    const asked = await until('the offer to look for it', async () => ((await seen()).hint ? seen() : null));
    assert(asked.hint === 'Enter ↵' && asked.count === null, `hint: ${JSON.stringify(asked)}`);
    await key('Enter');
    const found = await until('the lost commit', async () => ((await seen()).selected === 'Lost and found' ? seen() : null));
    await shot('search-lost-commit');
    assert(/Only the history of \w{7} · on no branch or tag/.test(found.filter), `bar: ${found.filter}`);
    await graph.click('.filterbar .button', 'Show all commits');
    await until('the whole graph again', async () => (await seen()).filter === null);

    // In the whole history: the graph stays, and the commits found are the ones not dimmed.
    await mode('message');
    await write('the ui');
    await key('Enter');
    const whole = await says('what git found', '1/1', 'Commit from the UI');
    await shot('search-history');
    assert(whole.filter === null && whole.rows === everything && whole.dimmed === everything - 1, `highlighted: ${JSON.stringify(whole)}`);

    // Or, with the button pressed, only what it found: the same search, shown the other way and back.
    await graph.click('.search .only');
    const only = await until('the list of results', async () => {
      const now = await seen();
      return now.filter && now.rows === 1 ? now : null;
    });
    await shot('search-only');
    assert(only.filter.includes('Commits whose message contains the ui') && only.count === null, `list: ${JSON.stringify(only)}`);
    await graph.click('.search .only');
    const back = await says('the graph again, with what was found', '1/1', 'Commit from the UI');
    assert(back.filter === null && back.rows === everything, `graph: ${JSON.stringify(back)}`);

    // What is found follows the history: a commit made meanwhile is found too.
    await write('Add');
    await key('Enter');
    await says('the commits added', '1/3', 'Add feature');
    git(app, 'commit', '--allow-empty', '-m', 'Add nothing');
    await says('one more', '2/4', 'Add feature');
    git(app, 'reset', '--soft', 'HEAD~1');
    await says('one less', '1/3', 'Add feature');

    // Ctrl+F brings the cursor back to the box from the list, with its text selected to type over.
    await mode('loaded');
    await write('Change');
    await graph.click('.row', 'Add b');
    await says('one match, and another commit selected', '1', 'Add b');
    const inBox = () => graph.evaluate(`document.activeElement === document.querySelector('.search input')`);
    assert(!(await inBox()), 'the focus is in the list');
    await key('F', CTRL);
    await until('the cursor in the box', inBox);
    await sleep(300);
    // The key is the view's: the editor behind it does not open its own search.
    assert(!(await page.evaluate(`!!document.querySelector('.editor-instance .find-widget.visible')`)), 'the editor does not search too');
    await type('Add');
    await says('the matches of what was typed over', '2/3', 'Add b');

    // Escape empties the box, and with it the search.
    await key('Escape');
    const emptied = await until('nothing searched', async () => ((await seen()).count === null ? seen() : null));
    assert(emptied.dimmed === 0, `nothing is dimmed: ${JSON.stringify(emptied)}`);
    await graph.click('.detail .close');
  });

  await step('the branches shown in the graph are chosen from a list, with one click or one by one, and from the menus of the branches', async () => {
    const graph = await webview('graph');
    const seen = () =>
      graph.evaluate(`({
        shown: document.querySelector('.button.scope').getAttribute('aria-label'),
        on: document.querySelector('.button.scope').classList.contains('on'),
        bar: document.querySelector('.filterbar')?.textContent ?? null,
        subjects: [...document.querySelectorAll('.row .subject')].map((row) => row.textContent),
        listed: [...document.querySelectorAll('.scope-picker label')].map((label) => label.textContent),
        ticked: [...document.querySelectorAll('.scope-picker label')].filter((label) => label.querySelector('input').checked).map((label) => label.textContent),
        quick: document.querySelector('.scope-picker .quick [aria-checked="true"]')?.textContent ?? null,
        open: !!document.querySelector('.scope-picker'),
      })`);
    const shows = (what, check) => until(what, async () => {
      const now = await seen();
      return check(now) ? now : null;
    });
    /**
     * The entries of the menu of a branch, which is left open: asked on its label in the graph, since the list of
     * references has only the branches that are shown.
     */
    const menuOf = async (branch) => {
      const at = await graph.locate('.row .label', branch);
      await mouse(at.x, at.y, 'right');
      return until('the menu', () =>
        graph.evaluate(`(() => { const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent); return items.length ? items : null; })()`),
      );
    };

    await graph.click('.button.scope');
    const all = await shows('the list of branches', (now) => now.open);
    assert(all.shown === 'Branches shown: All branches' && !all.on && all.quick === 'All' && !all.ticked.length && all.bar === null, `all: ${JSON.stringify(all)}`);
    assert(['feature', 'from-ui', 'main', 'merged', 'origin/main'].every((name) => all.listed.includes(name)), `listed: ${all.listed}`);
    const list = await graph.evaluate(`(() => {
      const box = document.querySelector('.scope-picker').getBoundingClientRect();
      return {
        inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
        focused: document.activeElement === document.querySelector('.scope-picker .refs-filter input'),
      };
    })()`);
    assert(list.inside && list.focused, `the list is inside the view, with the cursor in its box: ${JSON.stringify(list)}`);
    await shot('branches-list');

    // One click: what is checked out, whichever branch that is.
    await graph.click('.scope-picker .quick button', 'Current');
    const current = await shows('only the current branch', (now) => now.on && !now.subjects.includes('Add feature'));
    assert(current.shown === 'Branches shown: Current branch' && current.quick === 'Current' && current.ticked.join() === 'main', `current: ${JSON.stringify(current)}`);
    assert(current.bar.startsWith('Only the history of the current branch · 4 commits'), `bar: ${current.bar}`);
    assert(current.subjects[0].startsWith('Uncommitted changes'), `rows: ${current.subjects}`);

    // The box leaves the names that have what is typed, and a tick adds a branch to the ones shown.
    await graph.click('.scope-picker .refs-filter input');
    await type('feat');
    await shows('the branches of that name', (now) => now.listed.join() === 'feature');
    await graph.click('.scope-picker label', 'feature');
    const two = await shows('main and feature', (now) => now.subjects.includes('Add feature'));
    assert(two.shown === 'Branches shown: main +1' && two.quick === null, `two: ${JSON.stringify(two)}`);
    assert(two.bar.startsWith('Only the history of main, feature · 5 commits'), `bar: ${two.bar}`);
    await shot('branches-two');

    // Escape empties the box before it closes the list; a tick taken away takes the branch away.
    await key('Escape');
    await shows('all the names again', (now) => now.open && now.listed.length > 1);
    await graph.click('.scope-picker label', 'main');
    const one = await shows('feature alone', (now) => !now.subjects.includes('Commit from the UI'));
    assert(one.shown === 'Branches shown: feature' && one.ticked.join() === 'feature', `one: ${JSON.stringify(one)}`);
    // The changes are not shown above a graph that leaves out the commit they are made on.
    assert(one.subjects[0] === 'Add feature', `rows: ${one.subjects}`);
    await key('Escape');
    await shows('the list closed', (now) => !now.open);

    // From the menu of a branch: that one too, not that one any more, and all of them when it is the only one.
    let items = await menuOf('merged');
    assert(['Show only this history', 'Show this history too', 'Show all branches'].every((item) => items.includes(item)), `menu: ${items}`);
    await graph.click('[role="menuitem"]', 'Show this history too');
    await shows('feature and merged', (now) => now.shown === 'Branches shown: feature +1');
    items = await menuOf('feature');
    assert(items.includes('Hide this history') && !items.includes('Show this history too'), `menu: ${items}`);
    await graph.click('[role="menuitem"]', 'Hide this history');
    const merged = await shows('merged alone', (now) => now.shown === 'Branches shown: merged');
    assert(merged.bar.startsWith('Only the history of merged · 3 commits'), `bar: ${merged.bar}`);
    items = await menuOf('merged');
    assert(items.includes('Show all branches') && !items.includes('Show only this history') && !items.includes('Hide this history'), `menu: ${items}`);
    await key('Escape');

    // And the bar that says what is shown has the way back.
    await graph.click('.filterbar .button', 'Show all branches');
    const back = await shows('all the branches', (now) => now.bar === null);
    assert(back.shown === 'Branches shown: All branches' && !back.on && back.subjects.includes('Add feature'), `back: ${JSON.stringify(back)}`);
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

  await step('the references and the details get wider when the line beside them is dragged, and a double click undoes it', async () => {
    const graph = await webview('graph');
    await graph.click('.row', 'Add a');
    await until('the details', () => graph.evaluate(`document.querySelector('.detail h2')?.textContent === 'Add a'`));
    const widths = () => graph.evaluate(`['.refs', '.detail'].map((pane) => Math.round(document.querySelector(pane).getBoundingClientRect().width))`);
    const before = await widths();
    const pull = async (sash, by) => {
      const at = await graph.locate(sash);
      await window.drag(at, { x: at.x + by, y: at.y });
    };
    await pull('.refs-sash', 60);
    await pull('.detail-sash', -80);
    const after = await widths();
    await shot('resized');
    assert(after[0] === before[0] + 60 && after[1] === before[1] + 80, `from ${before} to ${after}`);
    for (const sash of ['.refs-sash', '.detail-sash']) {
      const at = await graph.locate(sash);
      await mouse(at.x, at.y);
      await mouse(at.x, at.y, 'left', 2);
    }
    await until('the widths they had', async () => (await widths()).join() === before.join());
    await graph.click('.detail .close');
  });

  await step('follows the theme, and its buttons have a shape in each: dark, light and high contrast', async () => {
    const graph = await webview('graph');
    /**
     * How the toolbar looks against the panel. A button has a shape when its outline or its filling, painted over
     * the background of the panel, comes out as another color: the number is how far apart the two are, of 765.
     */
    const look = () =>
      graph.evaluate(`(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const behind = getComputedStyle(document.documentElement).getPropertyValue('--vscode-panel-background');
        const over = (color) => {
          context.fillStyle = behind;
          context.fillRect(0, 0, 1, 1);
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const apart = (color) => over(color).reduce((sum, channel, index) => sum + Math.abs(channel - over('transparent')[index]), 0);
        const buttons = [...document.querySelectorAll('.toolbar .button:not(.icon)')].map((button) => {
          const style = getComputedStyle(button);
          // A border of no width still has a color, that of the text.
          const outline = style.borderTopWidth === '0px' ? 0 : apart(style.borderTopColor);
          return { name: button.getAttribute('aria-label'), apart: Math.max(outline, apart(style.backgroundColor)) };
        });
        return {
          behind,
          text: over(getComputedStyle(document.body).color).reduce((sum, channel) => sum + channel, 0),
          faintest: buttons.sort((one, other) => one.apart - other.apart)[0],
          boxed: [...document.querySelectorAll('.toolbar .button .label')].filter((label) => getComputedStyle(label).borderTopWidth !== '0px').length,
        };
      })()`);
    let { behind } = await look();
    try {
      // The one VS Code starts with comes first; its name is not set.
      for (const [theme, dark] of [[undefined, true], ['Dark Modern', true], ['Light 2026', false], ['Default Light Modern', false], ['Default High Contrast', true]]) {
        if (theme) {
          setting('workbench.colorTheme', theme);
          const previous = behind;
          await until(`the theme ${theme}`, async () => (await look()).behind !== previous);
          await sleep(600);
        }
        const seen = await look();
        behind = seen.behind;
        await shot(`theme-${(theme ?? 'default').replace(/\W+/g, '-').toLowerCase()}`);
        assert(dark ? seen.text > 450 : seen.text < 320, `${theme}: the text is ${seen.text} of 765`);
        assert(seen.faintest.apart >= 30, `${theme}: the button ${seen.faintest.name} is ${seen.faintest.apart} apart from what is behind it`);
        assert(seen.boxed === 0, `${theme}: ${seen.boxed} of the words in the buttons are boxed`);
      }
    } finally {
      setting('workbench.colorTheme', undefined);
      await until('the dark theme', () => page.evaluate(`document.querySelector('.monaco-workbench').classList.contains('vs-dark')`));
    }
  });

  /** What the header of a view of the side bar says after its name, and the buttons it has. */
  const header = (title) =>
    page.evaluate(`(() => {
      const header = [...document.querySelectorAll('.pane-header')].find((candidate) => candidate.querySelector('.title')?.textContent === ${JSON.stringify(title)});
      if (!header) return null;
      return {
        description: header.querySelector('.description')?.textContent ?? '',
        actions: [...header.querySelectorAll('.actions .action-label')].map((action) => action.getAttribute('aria-label') ?? ''),
      };
    })()`);
  const menuItems = (view) =>
    until('the context menu', () =>
      view.evaluate(`(() => { const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent); return items.length ? items : null; })()`),
    );
  const compared = (view) =>
    view.evaluate(`({
      heading: document.querySelector('.detail h2')?.textContent ?? null,
      sides: [...document.querySelectorAll('.detail dd')].map((side) => side.textContent),
      files: [...document.querySelectorAll('.detail .file .name')].map((file) => file.textContent),
    })`);

  await step('the side bar lists the commits too, with the details under them and the buttons in the header of the view', async () => {
    // The changes had their turn: their room goes to the views under them.
    await fold('Gitar Changes');
    await command('Gitar: Show Commits in the Side Bar');
    await until('the view', async () => (await panes()).some((pane) => pane.title === 'Commits' && pane.open));
    await sleep(500);
    const commits = await webview('commits');
    await until('the commits', async () => (await subjects(commits)).includes('Add a'));
    // A list this narrow gives each commit two lines: its message, and under it its labels, who made it and when.
    const rows = await commits.evaluate(`[...document.querySelectorAll('.row')].map((row) => ({
      subject: row.querySelector('.subject').textContent,
      height: row.getBoundingClientRect().height,
      under: row.querySelector('.message').getBoundingClientRect().top >= row.querySelector('.subject').getBoundingClientRect().bottom - 1,
      who: row.querySelector('.who')?.textContent,
      when: row.querySelector('.when')?.textContent,
      labels: [...row.querySelectorAll('.label')].map((label) => ({
        name: label.textContent,
        read: label.querySelector('.text').scrollWidth <= label.querySelector('.text').clientWidth + 1,
      })),
    }))`);
    assert(rows.length >= 4 && rows.every((row) => row.height === 42 && row.under), `two lines to a commit: ${JSON.stringify(rows)}`);
    assert(rows.filter((row) => row.who === 'Gitar Test' && row.when).length >= 4, `who and when: ${JSON.stringify(rows)}`);
    const labelled = rows.find((row) => row.labels.length > 1);
    // Side by side on the line of their own, the labels of a commit keep their names.
    assert(labelled && labelled.labels.every((label) => label.read), `labels with their names: ${JSON.stringify(rows.map((row) => row.labels))}`);
    await commits.click('.row', 'Add b');
    await until('the details', () => commits.evaluate(`document.querySelector('.detail h2')?.textContent === 'Add b'`));
    await shot('side-commits');
    const layout = await commits.evaluate(`(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      return {
        references: !!document.querySelector('.refs'),
        buttons: document.querySelectorAll('.toolbar .button:not(.icon)').length,
        search: Math.round(box('.search').width),
        under: box('.detail').top >= box('.commits').bottom - 1,
        detail: Math.round(box('.detail').width),
        width: innerWidth,
        wider: document.documentElement.scrollWidth > innerWidth,
      };
    })()`);
    assert(!layout.references && layout.buttons === 0, `only the search and the commits: ${JSON.stringify(layout)}`);
    assert(layout.under && layout.detail === layout.width && !layout.wider, `the details are under the commits: ${JSON.stringify(layout)}`);
    assert(layout.search >= 150, `the search box is ${layout.search}px wide`);

    // And the way to choose the branches, which narrows this list as it does the graph.
    await commits.click('.toolbar .button.scope');
    await until('the list of branches', () => commits.evaluate(`!!document.querySelector('.scope-picker')`));
    const inside = await commits.evaluate(`(() => {
      const box = document.querySelector('.scope-picker').getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
    })()`);
    assert(inside, 'the list of branches is inside the view');
    await commits.click('.scope-picker .quick button', 'Local');
    await until('only the local branches', () =>
      commits.evaluate(`!!document.querySelector('.filterbar')?.textContent.startsWith('Only the history of the local branches')`),
    );
    await shot('side-branches-shown');
    await commits.click('.scope-picker .quick button', 'All');
    await until('all the branches again', () => commits.evaluate(`!document.querySelector('.filterbar')`));
    await key('Escape');
    await until('the list closed', () => commits.evaluate(`!document.querySelector('.scope-picker')`));

    const { actions } = await header('Commits');
    for (const wanted of ['Fetch', 'Pull', 'Push', 'Compare Branches, Tags or Commits…', 'Refresh']) {
      assert(actions.some((action) => action.startsWith(wanted)), `the header has ${wanted}: ${actions}`);
    }
    await commits.click('.detail .close');
  });

  await step('the branches in the side bar compare two of them, or one with a revision typed in the real prompts', async () => {
    // A view as short as the others leave it has little room for its menu: the commits make way.
    await fold('Commits');
    await command('Gitar: Show Branches');
    await until('the view', async () => (await panes()).some((pane) => pane.title === 'Branches' && pane.open));
    await sleep(500);
    const branches = await webview('branches');
    await until('the branches', () => branches.evaluate(`document.querySelectorAll('.refs .ref').length >= 4`));
    const sections = await branches.evaluate(`[...document.querySelectorAll('.refs .section')].map((section) => section.textContent)`);
    // The stashes have a view of their own.
    assert(
      sections.join().startsWith('Recent1,Local4,Remotes1') && !sections.some((section) => section.startsWith('Stashes')),
      `sections: ${sections}`,
    );
    assert((await header('Branches')).description === 'main', `the header names the branch: ${JSON.stringify(await header('Branches'))}`);

    let at = await branches.locate('.refs .ref', 'feature');
    await mouse(at.x, at.y, 'right');
    const items = await menuItems(branches);
    await shot('side-branch-menu');
    assert(items.includes('Compare with main') && items.includes('Compare with…'), `menu: ${items}`);
    const menu = await branches.evaluate(`(() => { const rect = document.querySelector('[role="menu"]').getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight }; })()`);
    assert(menu.left >= 0 && menu.top >= 0 && menu.right <= menu.width && menu.bottom <= menu.height, `the menu is inside the view: ${JSON.stringify(menu)}`);
    await branches.click('[role="menuitem"]', 'Compare with main');
    await until('the files that differ', async () => (await compared(branches)).files.length > 0);
    let seen = await compared(branches);
    await shot('side-compare');
    assert(seen.heading === 'Comparison' && seen.sides.length === 2, `comparison: ${JSON.stringify(seen)}`);
    assert(seen.sides[0].startsWith('feature') && seen.sides[1].startsWith('main'), `sides: ${seen.sides}`);
    assert(seen.files.includes('feature.txt'), `files: ${seen.files}`);

    // The comparison took some of the room of the branches, and a list that is still settling closes the menu opened on it.
    await until('the menu to stay open', async () => {
      await branches.evaluate(`[...document.querySelectorAll('.refs .ref')].find((ref) => ref.textContent.includes('feature')).scrollIntoView({ block: 'center' })`);
      await sleep(300);
      at = await branches.locate('.refs .ref', 'feature');
      await mouse(at.x, at.y, 'right');
      await sleep(500);
      return branches.evaluate(`!!document.querySelector('[role="menuitem"]')`);
    });
    await branches.click('[role="menuitem"]', 'Compare with…');
    const pick = await until('the choice of the other side', async () => {
      const open = await prompt();
      return open?.title === 'Compare feature with' && open.items.length ? open : null;
    });
    await shot('compare-pick');
    assert(pick.items.some((item) => item.includes('Enter a hash')) && pick.items.some((item) => item.includes('from-ui')), `offered: ${pick.items}`);
    assert(!pick.items.some((item) => item.trim() === 'feature'), `feature is not offered against itself: ${pick.items}`);
    await clickText('.quick-input-list .monaco-list-row', 'Enter a hash');
    await until('the box for the revision', async () => {
      const open = await prompt();
      return open?.title === 'Compare feature with' && !open.items.length;
    });
    await type('no-such-thing');
    const unknown = 'Git does not know a commit by this name';
    const refused = await until('what git says of it', async () => ((await prompt())?.message.includes(unknown) ? prompt() : null));
    await shot('compare-revision');
    assert(refused.kind === 'quick', `prompt: ${JSON.stringify(refused)}`);
    // Typing over what is selected replaces it.
    await page.evaluate(`document.querySelector('.quick-input-widget input').select()`);
    await type('HEAD~2');
    await until('the revision to be accepted', async () => !(await prompt())?.message.includes(unknown));
    await key('Enter');
    await until('the other comparison', async () => (await compared(branches)).sides[1]?.startsWith('HEAD~2'));
    seen = await compared(branches);
    assert(seen.sides[0].startsWith('feature') && seen.files.length > 0, `comparison: ${JSON.stringify(seen)}`);
    await branches.click('.detail .close');
  });

  await step('the stashes in the side bar unfold to their files, and their header counts them', async () => {
    git(app, 'stash', 'push', '--include-untracked', '-m', 'Put aside');
    await command('Gitar: Show Stashes');
    const stashes = await webview('stashes');
    await until('the stash', () => stashes.evaluate(`document.querySelectorAll('.stash').length === 1`));
    await stashes.click('.stash .file-open');
    const files = await until('its files', () =>
      stashes.evaluate(`(() => { const files = [...document.querySelectorAll('.stash-files .file .name')].map((file) => file.textContent); return files.length ? files : null; })()`),
    );
    const at = await stashes.locate('.stash');
    await mouse(at.x, at.y, 'right');
    const items = await menuItems(stashes);
    await shot('side-bar');
    await key('Escape');
    assert((await stashes.evaluate(`document.querySelector('.stash .name').textContent`)).includes('Put aside'), 'the stash is named by its message');
    assert(files.join() === 'new.txt', `files: ${files}`);
    assert(items.some((item) => item.startsWith('Apply')) && items.some((item) => item.startsWith('Drop')), `menu: ${items}`);
    await until('the count in the header', async () => (await header('Stashes'))?.description === '1');
    // Four views, one under the other, and each still has its place.
    for (const kind of ['changes', 'commits', 'branches', 'stashes']) {
      const { frame } = await webview(kind);
      assert(frame.height >= 60, `the ${kind} view is ${frame.height}px tall`);
    }
  });

  await step('a graph of twenty branches is drawn closer to leave room to the messages, and its edge can be dragged', async () => {
    // Twenty branches that start from the same commit: twenty lines side by side.
    const names = Array.from({ length: 20 }, (_, index) => `side-${String(index + 1).padStart(2, '0')}`);
    const tree = git(app, 'rev-parse', 'HEAD^{tree}').toString().trim();
    for (const name of names) git(app, 'branch', name, git(app, 'commit-tree', tree, '-p', 'HEAD', '-m', `On ${name}`).toString().trim());
    const graph = await webview('graph');
    const added = async () => (await subjects(graph)).filter((subject) => subject.startsWith('On side-')).length;
    const seen = () =>
      graph.evaluate(`(() => {
        const dots = [...document.querySelectorAll('.row svg.graph circle')].map((dot) => Number(dot.getAttribute('cx')));
        return {
          width: Number(document.querySelector('.row svg.graph').getAttribute('width')),
          cut: document.querySelector('.commits').classList.contains('cut'),
          lanes: new Set(dots).size,
          farthest: Math.round(Math.max(...dots)),
          message: Math.round(document.querySelector('.row .message').getBoundingClientRect().left),
        };
      })()`);
    const pull = async (by) => {
      const at = await graph.locate('.graph-sash');
      await window.drag(at, { x: at.x + by, y: at.y });
    };

    try {
      // Only the rows in sight are drawn, which in the panel are fewer than twenty.
      await until('the new commits', async () => (await added()) >= 8);
      if (await graph.evaluate(`!!document.querySelector('.detail .close')`)) await graph.click('.detail .close');
      // The branches were made one at a time, and the graph may have been read with only some of them: it has to stop changing.
      let last = '';
      await until('the graph as it stays', async () => {
        const now = JSON.stringify(await seen());
        const same = now === last;
        last = now;
        if (!same) await sleep(1500);
        return same;
      });

      // On its own: no wider than sixteen lanes at their ease, with all twenty in it.
      const auto = await seen();
      await shot('many-branches');
      assert(auto.lanes >= 8 && auto.width === 230 && !auto.cut && auto.farthest < auto.width, `on its own: ${JSON.stringify(auto)}`);

      await pull(-100);
      const narrow = await seen();
      await shot('graph-narrower');
      assert(narrow.width === 130 && narrow.cut && narrow.message === auto.message - 100, `narrower: ${JSON.stringify(narrow)}`);

      // As wide as it takes to give every lane its room, and no wider.
      await pull(400);
      const wide = await seen();
      await shot('graph-wider');
      assert(wide.width >= 20 * 14 + 6 && (wide.width - 6) % 14 === 0 && !wide.cut, `wider: ${JSON.stringify(wide)}`);
      assert(wide.farthest < wide.width, `every dot is inside: ${JSON.stringify(wide)}`);

      const at = await graph.locate('.graph-sash');
      await mouse(at.x, at.y);
      await mouse(at.x, at.y, 'left', 2);
      await until('the width it chooses on its own', async () => (await seen()).width === 230);
    } finally {
      // The steps after this one look for the commits that were there before.
      git(app, 'branch', '-D', ...names);
      await until('the graph as it was', async () => (await added()) === 0);
    }
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

  await step('a commit opens in an editor tab, with its whole message, its files as a tree or as a list, and what it changed in each', async () => {
    // A commit with something to show: a message of several lines, directories, and a file changed as well as added ones.
    const file = (name, content) => {
      fs.mkdirSync(path.dirname(path.join(app, name)), { recursive: true });
      fs.writeFileSync(path.join(app, name), content);
    };
    file('notes.txt', 'one\ntwo\nthree\n');
    git(app, 'add', 'notes.txt');
    git(app, 'commit', '-m', 'Add notes');
    file('notes.txt', 'one\n2\nthree\nfour\n');
    file('src/main.txt', 'main\n');
    file('src/parts/list.txt', 'first\nsecond\n');
    git(app, 'add', 'notes.txt', 'src');
    git(app, 'commit', '-m', 'Add parts\n\nWith a body that says why,\non two lines.');

    // The graph of the panel, under the one that is an editor tab.
    const graph = await webview('graph', (frame) => frame.y >= 300);
    await until('the new commit', async () => (await subjects(graph)).includes('Add parts'));
    const row = await graph.locate('.row', 'Add parts');
    await mouse(row.x, row.y);
    await mouse(row.x, row.y, 'left', 2);

    const commit = await webview('commit');
    await until('the commit', () => commit.evaluate(`document.querySelector('.commit-head h1')?.textContent === 'Add parts'`));
    await until('its changes', () => commit.evaluate(`document.querySelectorAll('.file-diff .diff-lines').length === 3`));
    await shot('commit-tab');
    const files = () => commit.evaluate(`[...document.querySelectorAll('.commit-files .file')].map((file) => file.textContent)`);
    const seen = await commit.evaluate(`({
      body: document.querySelector('.commit-head .body').textContent,
      current: document.querySelector('.commit-labels .label.current')?.textContent,
      author: document.querySelector('.commit-head dd').textContent,
      hash: document.querySelector('.commit-head dd .mono').textContent.trim(),
      total: document.querySelector('.commit-files h2 .grow').textContent,
      pressed: [...document.querySelectorAll('.commit-files h2 button')].map((button) => button.getAttribute('aria-pressed')).join(),
      diffs: [...document.querySelectorAll('.file-diff')].map((diff) => diff.querySelector('.path').textContent + ' ' + diff.querySelector('.stat').textContent),
      lines: [...document.querySelector('.file-diff').querySelectorAll('.line:not(.at)')].map((line) => [...line.children].map((cell) => cell.textContent).join('|')),
      wider: document.documentElement.scrollWidth > innerWidth,
    })`);
    assert(seen.body === 'With a body that says why,\non two lines.', `body: ${seen.body}`);
    assert(seen.current === 'main', `the label of the branch: ${seen.current}`);
    assert(seen.author.startsWith('Gitar Test') && seen.author.includes('@'), `author: ${seen.author}`);
    assert(/^[0-9a-f]{40}$/.test(seen.hash), `hash: ${seen.hash}`);
    assert(seen.total === '3 changed files+5−1', `total: ${seen.total}`);
    assert(seen.diffs.join() === 'notes.txt +2−1,src/main.txt +1,src/parts/list.txt +2', `diffs: ${seen.diffs}`);
    // Each line with the number it has before and after.
    assert(seen.lines.join() === '1|1| one,2||-two,|2|+2,3|3| three,|4|+four', `lines: ${seen.lines}`);
    assert(!seen.wider, 'the page is as wide as the tab');
    // The tab is named after the commit.
    const tabs = await page.evaluate(`[...document.querySelectorAll('.tabs-container .tab')].map((tab) => tab.textContent)`);
    assert(tabs.some((tab) => tab.includes(`${seen.hash.slice(0, 7)} Add parts`)), `tabs: ${tabs}`);

    // Under their directories first, which fold.
    assert(seen.pressed === 'true,false', `layout: ${seen.pressed}`);
    assert((await files()).join() === 'src,parts,Alist.txt+2,Amain.txt+1,Mnotes.txt+2−1', `tree: ${await files()}`);
    await commit.click('.commit-files .file.directory', 'parts');
    await until('the directory folded', async () => (await files()).join() === 'src,parts,Amain.txt+1,Mnotes.txt+2−1');
    await commit.click('.commit-files .file.directory', 'parts');
    // Then one after the other, each with where it is.
    await commit.click('.commit-files h2 button[aria-label="Files as a list"]');
    await until('the list', async () => (await files()).join() === 'Mnotes.txt+2−1,Amain.txtsrc+1,Alist.txtsrc/parts+2');
    await shot('commit-tab-list');

    // The changes of a file fold away, and all of them come back at once.
    await commit.click('.file-diff .twist');
    await until('one diff folded', () => commit.evaluate(`document.querySelectorAll('.file-diff .diff-lines').length === 2`));
    await commit.click('.commit-diffs h2 .button', 'Unfold all');
    await until('all the diffs', () => commit.evaluate(`document.querySelectorAll('.file-diff .diff-lines').length === 3`));

    // The button in the details of a commit does what the double click does, for another commit: its tab opens with the layout chosen last.
    // The page is searched with the box VS Code has for the pages of extensions.
    await commit.click('.commit-head h1');
    await key('F', CTRL);
    await until('the search box of the tab', () => page.evaluate(`!!document.querySelector('.simple-find-part.visible')`));
    await shot('commit-tab-find');
    await key('Escape');

    // The first tab is closed before: a tab that is behind another keeps its page, and would be taken for the new one.
    await command('View: Close Editor');
    await until('the tab closed', async () => !(await page.evaluate(`[...document.querySelectorAll('.tabs-container .tab')].some((tab) => tab.textContent.includes('Add parts'))`)));
    await graph.click('.row', 'Add notes');
    await graph.click('.detail .open-tab');
    await until('the tab of the other commit', () => page.evaluate(`[...document.querySelectorAll('.tabs-container .tab')].some((tab) => tab.textContent.includes('Add notes'))`));
    const other = await webview('commit');
    await until('the other commit', () => other.evaluate(`document.querySelector('.commit-head h1')?.textContent === 'Add notes'`));
    await until('the list again', () => other.evaluate(`document.querySelector('.commit-files h2 button[aria-label="Files as a list"]')?.getAttribute('aria-pressed') === 'true'`));
    await other.click('.commit-files h2 button[aria-label="Files as a tree"]');

    // And from the tab back to the graph, where its commit is selected.
    await other.click('.commit-actions .button', 'Show in the graph');
    await until('the commit selected in the graph', () => graph.evaluate(`document.querySelector('.row.selected .subject')?.textContent === 'Add notes'`));
  });

  await step('the details keep a long message to a few lines, list the files with their directories or as a tree, and are sized from above when they are under the commits', async () => {
    await command('View: Close All Editors');
    const file = (name, content) => {
      fs.mkdirSync(path.dirname(path.join(app, name)), { recursive: true });
      fs.writeFileSync(path.join(app, name), content);
    };
    file('docs/guide/intro.txt', 'intro\n');
    file('docs/guide/setup.txt', 'setup\n');
    file('lib/util.txt', 'util\n');
    git(app, 'add', 'docs', 'lib');
    const lines = Array.from({ length: 14 }, (_, index) => `Line ${index + 1} of the message.`);
    git(app, 'commit', '-m', `Add the guide\n\n${lines.join('\n')}`);
    const graph = await webview('graph');
    await until('the commit', async () => (await subjects(graph)).includes('Add the guide'));
    await graph.click('.row', 'Add the guide');
    await until('the details', () => graph.evaluate(`document.querySelector('.detail h2')?.textContent === 'Add the guide'`));
    await until('the files', () => graph.evaluate(`document.querySelectorAll('.detail .files .file').length === 3`));

    // The message: five lines of it, the rest a scroll away, and the files in sight under it.
    const message = await graph.evaluate(`(() => {
      const box = document.querySelector('.detail .said');
      const body = box.querySelector('.body');
      const detail = document.querySelector('.detail').getBoundingClientRect();
      return {
        line: body.scrollHeight / ${lines.length},
        height: box.clientHeight,
        whole: box.scrollHeight,
        scrolls: getComputedStyle(box).overflowY,
        files: document.querySelector('.detail .files').getBoundingClientRect().top < detail.bottom,
      };
    })()`);
    assert(message.height > message.line * 4 && message.height < message.line * 6, `the message takes ${JSON.stringify(message)}`);
    assert(message.whole > message.height * 2 && message.scrolls === 'auto' && message.files, `the message: ${JSON.stringify(message)}`);

    // One after the other, each file says where it is.
    const rows = () =>
      graph.evaluate(`[...document.querySelectorAll('.detail .files .file')].map((row) => {
        const dir = row.querySelector('.dir');
        return (row.classList.contains('directory') ? '> ' : '') + row.querySelector('.name').textContent + (dir ? ' in ' + dir.textContent + (dir.getBoundingClientRect().width > 8 ? '' : ' (hidden)') : '');
      })`);
    assert((await rows()).join() === 'intro.txt in docs/guide,setup.txt in docs/guide,util.txt in lib', `list: ${await rows()}`);
    await shot('details-list');

    // Or under their directories, which fold: and it stays so for the next commit.
    await graph.click('.detail h3 button[aria-label="Files as a tree"]');
    await until('the tree', async () => (await rows()).join() === '> docs/guide,intro.txt,setup.txt,> lib,util.txt');
    await shot('details-tree');
    await graph.click('.detail .files .directory', 'docs/guide');
    await until('a directory folded', async () => (await rows()).join() === '> docs/guide,> lib,util.txt');
    await graph.click('.row', 'Add parts');
    await until('the tree of another commit', async () => (await rows()).join() === '> src,> parts,list.txt,main.txt,notes.txt');
    await graph.click('.detail h3 button[aria-label="Files as a list"]');
    await until('the list again', async () => (await rows()).join() === 'notes.txt,main.txt in src,list.txt in src/parts');

    // In a narrow panel the details are under the commits, and the line between the two is dragged up and down.
    try {
      await aside();
      await page.send('Emulation.setDeviceMetricsOverride', { width: 800, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
      await sleep(700);
      await graph.click('.row', 'Add the guide');
      const sizes = () =>
        graph.evaluate(`(() => {
          const [commits, detail] = ['.commits', '.detail'].map((pane) => document.querySelector(pane).getBoundingClientRect());
          return { under: detail.top >= commits.bottom - 1, commits: Math.round(commits.height), detail: Math.round(detail.height) };
        })()`);
      const before = await until('the details under the commits', async () => {
        const now = await sizes();
        return now.under ? now : null;
      });
      assert(Math.abs(before.commits - before.detail) <= 2, `half each to start with: ${JSON.stringify(before)}`);
      const at = await graph.locate('.stack-sash');
      await window.drag(at, { x: at.x, y: at.y - 40 });
      const after = await sizes();
      await until('the details of the commit', () => graph.evaluate(`document.querySelector('.detail h2')?.textContent === 'Add the guide'`));
      await shot('details-under');
      assert(after.detail === before.detail + 40 && after.commits === before.commits - 40, `from ${JSON.stringify(before)} to ${JSON.stringify(after)}`);
      const line = await graph.locate('.stack-sash');
      await mouse(line.x, line.y);
      await mouse(line.x, line.y, 'left', 2);
      await until('the height they had', async () => (await sizes()).detail === before.detail);
    } finally {
      await page.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
      await sleep(700);
    }
    await graph.click('.detail .close');
  });

  await step('the branches list the favorites and the ones checked out last first, only the ones the graph is narrowed to, and can be put away; the status bar opens the graph', async () => {
    const graph = await webview('graph');
    const sections = (view) =>
      view.evaluate(`Object.fromEntries([...document.querySelectorAll('.refs section')].map((section) => [
        section.dataset.section,
        [...section.querySelectorAll('.ref')].map((ref) => ref.querySelector('.grow').textContent + (ref.querySelector('.codicon-star-full') ? '*' : '')),
      ]))`);
    const menuOf = async (branch) => {
      const at = await graph.locate('.refs section[data-section="branches"] .ref', branch);
      await mouse(at.x, at.y, 'right');
      return until('the menu', () =>
        graph.evaluate(`(() => { const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent); return items.length ? items : null; })()`),
      );
    };

    // What was checked out before what is now comes first among the recent ones, and what is checked out is not one of them.
    git(app, 'checkout', '-q', 'feature');
    git(app, 'checkout', '-q', 'main');
    const recent = await until('the branch left last', async () => {
      const now = await sections(graph);
      return now.recent?.[0] === 'feature' ? now : null;
    });
    assert(!recent.recent.includes('main') && !('favorites' in recent), `sections: ${JSON.stringify(recent)}`);

    // A favorite, from the menu of a branch: it has a group of its own, and a mark where it is listed with the others.
    assert((await menuOf('merged')).includes('Add to favorites'), 'the menu of a branch has the favorites');
    await graph.click('[role="menuitem"]', 'Add to favorites');
    const liked = await until('the favorites', async () => {
      const now = await sections(graph);
      return now.favorites?.join() === 'merged' ? now : null;
    });
    assert(liked.branches.includes('merged*') && liked.branches.includes('feature'), `branches: ${liked.branches}`);
    assert(Object.keys(liked).slice(0, 3).join() === 'favorites,recent,branches', `order: ${Object.keys(liked)}`);
    await shot('branches-groups');
    // The Branches view of the side bar lists them the same way.
    const side = await webview('branches');
    await until('the favorites in the side bar', async () => (await sections(side)).favorites?.join() === 'merged');

    // Narrowed to a branch, the graph leaves only that one here too, and says so with the way back.
    await menuOf('feature');
    await graph.click('[role="menuitem"]', 'Show only this history');
    const narrowed = await until('only the branch shown', async () => {
      const now = await sections(graph);
      return now.branches.join() === 'feature' ? now : null;
    });
    assert(narrowed.recent.join() === 'feature' && !('favorites' in narrowed) && !narrowed.remotes.length, `narrowed: ${JSON.stringify(narrowed)}`);
    assert((await graph.evaluate(`document.querySelector('.refs-scope .grow').textContent`)) === 'feature', 'the references say what they are narrowed to');
    await shot('branches-narrowed');
    await graph.click('.refs-scope button');
    await until('all the branches again', async () => (await sections(graph)).branches.includes('main'));
    assert((await menuOf('merged')).includes('Remove from favorites'), 'a favorite can be taken out');
    await graph.click('[role="menuitem"]', 'Remove from favorites');
    await until('no favorites', async () => !('favorites' in (await sections(graph))));

    // Put away, the references leave their room to the commits; the button brings them back.
    const commits = () => graph.evaluate(`Math.round(document.querySelector('.commits').getBoundingClientRect().width)`);
    const narrow = await commits();
    await graph.click('.refs-toggle');
    await until('the references gone', () => graph.evaluate(`!document.querySelector('.refs') && document.querySelector('.refs-toggle').getAttribute('aria-pressed') === 'false'`));
    assert((await commits()) > narrow + 100, `the commits went from ${narrow} to ${await commits()}`);
    await shot('branches-hidden');
    await graph.click('.refs-toggle');
    await until('the references back', async () => (await commits()) === narrow);

    // The button of the status bar opens the graph in a tab of the editor.
    const tabs = () => page.evaluate(`[...document.querySelectorAll('.tabs-container .tab')].map((tab) => tab.textContent)`);
    assert(!(await tabs()).some((tab) => tab.includes('Gitar')), `tabs: ${await tabs()}`);
    await clickText('.statusbar-item', 'Gitar');
    await until('the graph in a tab', async () => (await tabs()).some((tab) => tab.includes('Gitar')));
    await shot('status-bar');
    await command('View: Close All Editors');
  });

  await step('a merge that stops offers to resolve the conflicts that need no choice, shows what it would write first, and can take it back', async () => {
    await command('View: Close All Editors');
    const numbered = (changes = {}) => Array.from({ length: 12 }, (_, index) => `${changes[index] ?? `line ${index}`}\n`).join('');
    const file = (name, content) => fs.writeFileSync(path.join(app, name), content);
    const read = (name) => fs.readFileSync(path.join(app, name), 'utf8');
    const status = () => git(app, 'status', '--porcelain').toString();
    file('c.txt', numbered());
    file('d.txt', 'one\ntwo\n');
    git(app, 'add', 'c.txt', 'd.txt');
    git(app, 'commit', '-m', 'Add c and d');
    git(app, 'checkout', '-b', 'beside');
    // In c.txt each side changes a line next to one the other changes, and both change line 9; in d.txt only the first.
    file('c.txt', numbered({ 2: 'two, theirs', 9: 'nine, theirs' }));
    file('d.txt', 'one\nTWO\n');
    git(app, 'commit', '-m', 'Beside, theirs', '--', 'c.txt', 'd.txt');
    git(app, 'checkout', 'main');
    file('c.txt', numbered({ 3: 'three, ours', 9: 'nine, ours' }));
    file('d.txt', 'ONE\ntwo\n');
    git(app, 'commit', '-m', 'Beside, ours', '--', 'c.txt', 'd.txt');
    let stopped = false;
    try {
      git(app, 'merge', 'beside');
    } catch {
      stopped = true;
    }
    assert(stopped && /^UU c\.txt$/m.test(status()) && /^UU d\.txt$/m.test(status()), `the merge stopped on both files: ${status()}`);

    // Resolving them is experimental, and off until it is switched on: the banner has nothing to offer.
    const graph = await webview('graph');
    const banner = () => graph.evaluate(`({ text: document.querySelector('.banner .grow')?.textContent, resolve: document.querySelector('.banner .resolve')?.textContent ?? null })`);
    await until('the banner', async () => (await banner()).text === 'Merge in progress · 2 files have conflicts');
    await sleep(1500);
    assert((await banner()).resolve === null, `banner with the setting off: ${JSON.stringify(await banner())}`);
    await shot('conflicts-banner-off');

    // The settings say so beside its name.
    await command('Preferences: Open Settings (UI)');
    await until('the settings', () => page.evaluate(`Boolean(document.querySelector('.settings-editor .suggest-input-container'))`));
    await sleep(500);
    await type('gitar.conflicts.autoResolve');
    const found = await until('the setting', async () => {
      const items = await page.evaluate(`[...document.querySelectorAll('.settings-editor .setting-item-contents')].map((item) => ({
        text: item.textContent,
        badge: item.querySelector('.setting-item-preview')?.textContent ?? null,
        checked: item.querySelector('.setting-value-checkbox')?.getAttribute('aria-checked') ?? null,
      }))`);
      return items.length === 1 && items[0].text.includes('Auto Resolve') ? items[0] : null;
    });
    assert(found.badge === 'Experimental' && found.checked === 'false', `the setting: ${JSON.stringify(found)}`);
    await shot('conflicts-setting');
    await command('View: Close All Editors');

    // Switched on, the banner counts what can be resolved without a choice.
    setting('gitar.conflicts.autoResolve', true);
    await until('the banner', async () => (await banner()).resolve === 'Resolve 2 of 3 automatically');
    assert((await banner()).text === 'Merge in progress · 2 files have conflicts', `banner: ${JSON.stringify(await banner())}`);
    await shot('conflicts-banner');

    // It asks first, with the files it writes and the command it runs.
    await graph.click('.banner .resolve');
    let dialog = await until('the question', async () => ((await prompt())?.kind === 'dialog' ? prompt() : null));
    await shot('conflicts-ask');
    assert(dialog.text.includes('Resolve 2 of 3 conflicts automatically?'), `dialog: ${JSON.stringify(dialog)}`);
    assert(dialog.text.includes('c.txt: 1 of 2 conflicts (changes to lines next to each other)'), `dialog: ${dialog.text}`);
    assert(/and then run:\s+git add -- d\.txt\s*$/.test(dialog.text), `dialog: ${dialog.text}`);
    assert([...dialog.buttons].sort().join() === 'Cancel,Preview,Resolve', `buttons: ${dialog.buttons}`);

    // The preview puts each file beside what it would become, and nothing is written until the answer.
    await clickText('.monaco-dialog-box .monaco-button', 'Preview');
    const tabs = () => page.evaluate(`[...document.querySelectorAll('.tabs-container .tab')].map((tab) => tab.textContent)`);
    await until('the preview', async () => (await tabs()).some((tab) => tab.includes('Preview of the conflicts resolved automatically')));
    const toasts = () => page.evaluate(`[...document.querySelectorAll('.notification-toast .notification-list-item-message')].map((toast) => toast.textContent)`);
    await until('the second question', async () => (await toasts()).some((toast) => toast.includes('Resolve 2 of 3 conflicts automatically, as in the preview?')));
    await until('the diffs', () => page.evaluate(`document.querySelectorAll('.multiDiffEntry, .multi-diff-entry, .monaco-diff-editor').length > 0`));
    await sleep(1500);
    await shot('conflicts-preview');
    assert(read('c.txt').split('<<<<<<<').length === 3 && read('d.txt').includes('<<<<<<<'), 'nothing is written yet');

    await clickText('.notification-toast .monaco-button', 'Resolve');
    await until('the files written', () => !read('d.txt').includes('<<<<<<<'));
    assert(read('d.txt') === 'ONE\nTWO\n', `d.txt: ${read('d.txt')}`);
    const left = '<<<<<<< HEAD\nnine, ours\n=======\nnine, theirs\n>>>>>>> beside\n';
    assert(read('c.txt') === numbered({ 2: 'two, theirs', 3: 'three, ours', 9: 'LEFT' }).replace('LEFT\n', left), `c.txt: ${read('c.txt')}`);
    await until('the file without conflicts staged', () => /^M  d\.txt$/m.test(status()) && /^UU c\.txt$/m.test(status()));
    await until('the banner to follow', async () => {
      const now = await banner();
      return now.text === 'Merge in progress · 1 file has conflicts' && now.resolve === null;
    });
    await until('what is left to do', async () =>
      (await toasts()).some((toast) => toast.includes('Gitar resolved conflicts in 2 files. 1 file still has conflicts to resolve by hand.')),
    );
    await command('View: Close All Editors');
    await sleep(500);
    await shot('conflicts-resolved');

    // The way back is in the same message: the conflicts are marked again, in the file that was staged too.
    await clickText('.notification-toast .monaco-button', 'Undo');
    dialog = await until('the confirmation', async () => ((await prompt())?.kind === 'dialog' ? prompt() : null));
    assert(dialog.text.includes('Undo: restore the conflicts of 2 files?') && /git checkout --merge -- c\.txt d\.txt\s*$/.test(dialog.text), `dialog: ${dialog.text}`);
    await clickText('.monaco-dialog-box .monaco-button', 'Run');
    await until('the conflicts back', () => /^UU c\.txt$/m.test(status()) && /^UU d\.txt$/m.test(status()));
    await until('the banner as it was', async () => (await banner()).resolve === 'Resolve 2 of 3 automatically');
    assert(read('d.txt').includes('<<<<<<<') && read('c.txt').split('<<<<<<<').length === 3, 'every conflict is marked again');

    // The files in conflict have their buttons in the changes view: what can be resolved, a whole side, or done by hand.
    await fold('Branches');
    await fold('Stashes');
    await clickText('.sidebar .pane-header[aria-expanded="false"] .title', 'Gitar Changes');
    await until('the view unfolded', async () => (await panes()).some((pane) => pane.title === 'Gitar Changes' && pane.open));
    const changes = await webview('changes');
    const buttons = (name) =>
      changes.evaluate(`[...[...document.querySelectorAll('.group .file')].find((row) => row.textContent.includes(${JSON.stringify(name)}))?.querySelectorAll('button[title]') ?? []].map((button) => button.title).filter((title) => !title.includes('.txt')).join(' | ')`);
    await until('the files in conflict listed', async () => (await buttons('d.txt')).includes('Mark as resolved'));
    assert(
      (await buttons('d.txt')) === 'Resolve its conflict automatically | Take the current side for the whole file | Take the incoming side for the whole file | Mark as resolved',
      `d.txt: ${await buttons('d.txt')}`,
    );
    assert((await buttons('c.txt')).startsWith('Resolve 1 of its 2 conflicts automatically | '), `c.txt: ${await buttons('c.txt')}`);
    await shot('conflicts-changes');

    git(app, 'merge', '--abort');
    await until('the banner gone', () => graph.evaluate(`!document.querySelector('.banner:not(.bisect)')`));
    setting('gitar.conflicts.autoResolve', undefined);
  });
} catch (error) {
  await finish(error);
}
await finish();
