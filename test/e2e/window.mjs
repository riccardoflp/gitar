// A real VS Code window, started on its own with a throwaway profile and driven through the DevTools protocol:
// real clicks, real keys, the real dialogs and pickers, and a way into Gitar's webviews.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Session, freePort, sleep, targets, until } from './cdp.mjs';
import { environment, findCode, isolated, source } from './fixture.mjs';

export const CTRL = 2;
export const SHIFT = 8;
const KEYS = {
  P: { key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80 },
  F: { key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70 },
  W: { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 },
  F1: { key: 'F1', code: 'F1', windowsVirtualKeyCode: 112 },
  F3: { key: 'F3', code: 'F3', windowsVirtualKeyCode: 114 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
};

/**
 * Starts VS Code on `workspace`, with its profile inside `temp` and the extension loaded from this folder.
 * Nothing can be done with the window until `ready()` has resolved. Screenshots go to `out`.
 */
export async function startWindow({ workspace, temp, out, codePath, settings: extra = {}, width = 1500, height = 950 }) {
  // Dialogs drawn by VS Code itself rather than by the operating system, so that they can be seen and clicked from here.
  const settings = {
    'window.dialogStyle': 'custom',
    'window.titleBarStyle': 'custom',
    'window.restoreWindows': 'none',
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'telemetry.telemetryLevel': 'off',
    'editor.minimap.enabled': false,
    'gitar.commandPreview': 'off',
    ...extra,
  };
  const settingsFile = path.join(temp, 'user-data', 'User', 'settings.json');
  const writeSettings = () => fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  writeSettings();
  fs.mkdirSync(out, { recursive: true });

  const port = await freePort();
  const child = spawn(
    findCode(codePath),
    // The folder for extensions is empty anyway, and disabling them all leaves a notification over the window.
    [workspace, `--extensionDevelopmentPath=${source}`, `--remote-debugging-port=${port}`, ...isolated(temp)].filter(
      (argument) => argument !== '--disable-extensions',
    ),
    { env: environment(), stdio: 'ignore' },
  );

  let page;
  let shots = 0;
  const sessions = {};
  /** Errors thrown or logged inside the webviews. */
  const problems = [];

  async function ready() {
    const workbench = await until(
      'VS Code to start',
      async () => (await targets(port)).find((target) => target.type === 'page' && target.url.includes('workbench')),
      60_000,
    );
    page = await Session.open(workbench.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await resize(width, height);
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await until('the workbench', () => page.evaluate(`!!document.querySelector('.monaco-workbench .statusbar')`), 60_000);
    await sleep(3000);
    return page;
  }

  /** The size of the window as the page sees it, which is also the size of the screenshots. */
  const resize = (toWidth, toHeight) =>
    page.send('Emulation.setDeviceMetricsOverride', { width: toWidth, height: toHeight, deviceScaleFactor: 1, mobile: false });

  /** Saves what the window shows. */
  async function shot(name) {
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(out, `${String(++shots).padStart(2, '0')}-${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  /** Changes a setting of the user, by writing the file VS Code reads them from and watches. */
  function setting(name, value) {
    settings[name] = value;
    writeSettings();
  }

  async function mouse(x, y, button = 'left', clickCount = 1) {
    const buttons = button === 'left' ? 1 : 2;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
  }

  /** Presses at one point and lets go at another, getting there in a few moves as a hand does. */
  async function drag(from, to, moves = 5) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let move = 1; move <= moves; move++) {
      const x = from.x + ((to.x - from.x) * move) / moves;
      const y = from.y + ((to.y - from.y) * move) / moves;
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    }
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
  }

  /** Clicks the first element of the workbench that matches the selector and contains the text. */
  async function clickText(selector, text) {
    const at = await until(`"${text}" to click`, () =>
      page.evaluate(`(() => {
        const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find((candidate) => candidate.textContent.includes(${JSON.stringify(text)}));
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return rect.width ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
      })()`),
    );
    await mouse(at.x, at.y);
  }

  async function key(name, modifiers = 0) {
    const { text, ...rest } = KEYS[name];
    await page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', modifiers, text, ...rest });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...rest });
  }

  const type = (text) => page.send('Input.insertText', { text });

  /** The text of what VS Code is asking, in whichever of its prompts is open. */
  const prompt = () =>
    page.evaluate(`(() => {
      const dialog = document.querySelector('.monaco-dialog-box');
      if (dialog) return { kind: 'dialog', text: dialog.querySelector('.dialog-message-container')?.innerText ?? '', buttons: [...dialog.querySelectorAll('.dialog-buttons .monaco-button')].map((button) => button.innerText) };
      const quick = document.querySelector('.quick-input-widget');
      if (quick && quick.style.display !== 'none') return { kind: 'quick', title: quick.querySelector('.quick-input-title')?.innerText ?? '', items: [...quick.querySelectorAll('.monaco-list-row .label-name')].map((row) => row.innerText), message: quick.querySelector('.quick-input-message')?.innerText ?? '' };
      return null;
    })()`);

  /** Runs a command from the command palette, by typing its name. */
  async function command(title) {
    await until('the command palette', async () => {
      if ((await prompt())?.kind === 'quick') return true;
      // A key goes to whatever has the focus, which may be a webview: a click on the empty part of the status bar takes it back.
      const bar = await page.evaluate(`(() => { const rect = document.querySelector('.part.statusbar').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`);
      await mouse(bar.x, bar.y);
      await key('F1');
      await sleep(700);
      return false;
    });
    await type(title);
    await until(`the command "${title}"`, () =>
      page.evaluate(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].some((row) => row.textContent.includes(${JSON.stringify(title)}))`),
    );
    await key('Enter');
    await sleep(300);
  }

  /** One of Gitar's webviews: where it is in the window, and a way to run code inside it. `accept` chooses among several by their place. */
  async function webview(kind, accept = () => true) {
    // The identifier VS Code gives the extension: who publishes it and its name, as its package says.
    const { publisher, name } = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    const extensionId = `${publisher}.${name}`.toLowerCase();
    return until(`the ${kind} view`, async () => {
      for (const target of await targets(port)) {
        if (!target.url.startsWith('vscode-webview://') || !target.url.toLowerCase().includes(`extensionid=${extensionId}`)) continue;
        const session = (sessions[target.id] ??= await Session.open(target.webSocketDebuggerUrl));
        if (!session.enabled) {
          session.enabled = true;
          // What goes wrong inside the views would otherwise only show as something missing on screen.
          session.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
            problems.push(exceptionDetails.exception?.description ?? exceptionDetails.text),
          );
          session.on('Runtime.consoleAPICalled', ({ type: level, args }) => {
            if (level === 'error') problems.push(args.map((argument) => argument.value ?? argument.description).join(' '));
          });
          await session.send('Runtime.enable');
          await sleep(200);
        }
        // The page of the extension is a frame inside the one VS Code makes: find the context that has its DOM.
        for (const context of session.contexts.values()) {
          const view = await session.evaluate('document.body?.dataset.view ?? null', context.id).catch(() => null);
          if (view !== kind) continue;
          const id = new URL(target.url).searchParams.get('id');
          const frame = await page.evaluate(`(() => {
            const frame = [...document.querySelectorAll('iframe.webview')].find((candidate) => candidate.src.includes(${JSON.stringify(`id=${id}`)}));
            const rect = frame?.getBoundingClientRect();
            return rect && rect.width > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
          })()`);
          if (!frame || !accept(frame)) continue;
          const evaluate = (expression) => session.evaluate(expression, context.id);
          /** The middle of the first element matching the selector, optionally among those containing a text, in window coordinates. */
          const locate = async (selector, text) => {
            const rect = await until(`${selector}${text ? ` with "${text}"` : ''} in the ${kind} view`, () =>
              evaluate(`(() => {
                const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find((candidate) => ${text === undefined ? 'true' : `candidate.textContent.includes(${JSON.stringify(text)})`});
                if (!element) return null;
                const rect = element.getBoundingClientRect();
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
              })()`),
            );
            return { x: frame.x + rect.x, y: frame.y + rect.y };
          };
          const click = async (selector, text, button) => {
            const { x, y } = await locate(selector, text);
            await mouse(x, y, button);
          };
          return { frame, evaluate, locate, click };
        }
      }
      return null;
    });
  }

  async function close() {
    child.kill();
    await sleep(1500);
  }

  return { ready, resize, shot, setting, mouse, drag, clickText, key, type, prompt, command, webview, close, problems };
}
