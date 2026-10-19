import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import type { SyntaxTheme } from '../../flow/diff/protocol';
import { LANGS } from '../../flow/webview/languages';
import type { Hunk } from '../../shared/protocol';

/**
 * Colors the lines of a diff as the editor colors the code, with shiki and the theme of VS Code. A bundle of its own,
 * which the page imports only once it shows changes: shiki and its grammars are far larger than the page.
 */

/** A piece of a line in one color. `style` has the bits of shiki: 1 italic, 2 bold, 4 underline, 8 struck through. */
export interface Token {
  text: string;
  color?: string;
  style?: number;
}

/** The pieces of each line of each hunk; null for a line that is not code, such as git's note of a missing line break. */
export type Colors = (Token[] | null)[][];

/** The language of a file by its extension, as VS Code names it; its grammar is then the one of the Flow Diff. */
const EXTENSIONS: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascriptreact',
  json: 'json',
  jsonc: 'jsonc',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  py: 'python',
  java: 'java',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  csproj: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  sql: 'sql',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  dart: 'dart',
  lua: 'lua',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  dockerfile: 'dockerfile',
};

/** Lines longer than this are left in one color: a minified file would take seconds. */
const LONGEST_LINE = 1000;

let highlighter: Promise<HighlighterCore> | undefined;
let themeName: string | undefined;
const loaded = new Map<string, Promise<boolean>>();

const getHighlighter = () => (highlighter ??= createHighlighterCore({ themes: [], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) }));

/** The grammar of a file, loaded: its name in shiki, or undefined when there is none for it. */
async function grammarOf(path: string): Promise<string | undefined> {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const extension = name === 'dockerfile' ? 'dockerfile' : name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const entry = LANGS[EXTENSIONS[extension] ?? ''];
  if (!entry) return undefined;
  if (!loaded.has(entry.id)) {
    loaded.set(
      entry.id,
      (async () => {
        const grammar = await entry.load();
        await (await getHighlighter()).loadLanguage(grammar.default as never);
        return true;
      })().catch(() => false),
    );
  }
  return (await loaded.get(entry.id)) ? entry.id : undefined;
}

/** Takes the colors of the theme of VS Code, or those of Dark+ or Light+ when it could not be read. */
export async function setTheme(theme: SyntaxTheme | null, dark: boolean): Promise<void> {
  const shiki = await getHighlighter();
  try {
    if (theme) {
      await shiki.loadTheme(theme.raw as never);
      themeName = theme.name;
      return;
    }
  } catch {
    // Its own colors could not be read: the ones VS Code has by default instead.
  }
  const fallback = dark ? await import('@shikijs/themes/dark-plus') : await import('@shikijs/themes/light-plus');
  await shiki.loadTheme(fallback.default as never);
  themeName = (fallback.default as { name: string }).name;
}

/** One after the other, with a pause between: a page with many files still answers while they are colored. */
let queue: Promise<unknown> = Promise.resolve();
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The colors of the lines of a file's hunks, or null when its language has no grammar here. The lines before and the
 * lines after are colored apart, each hunk as a piece of code of its own, for a line to be colored as it is in its
 * version of the file. Nothing is done when `wanted` says no by the time its turn comes.
 */
export function colorHunks(path: string, hunks: Hunk[], wanted: () => boolean = () => true): Promise<Colors | null> {
  const run = queue.then(async () => {
    if (!wanted()) return null;
    const lang = await grammarOf(path);
    if (!lang || !themeName) return null;
    const shiki = await getHighlighter();
    const theme = themeName;
    const tokenize = (lines: string[]) =>
      shiki
        .codeToTokensBase(lines.join('\n'), { lang, theme, tokenizeMaxLineLength: LONGEST_LINE })
        .map((line) => line.map((token) => ({ text: token.content, color: token.color, style: token.fontStyle && token.fontStyle > 0 ? token.fontStyle : undefined })));
    const colors = hunks.map((hunk) => {
      const before: string[] = [];
      const after: string[] = [];
      for (const line of hunk.lines) {
        const sign = line[0];
        if (sign === '\\') continue;
        const code = line.slice(1).replace(/\r$/, '');
        if (sign !== '+') before.push(code);
        if (sign !== '-') after.push(code);
      }
      const old = before.length ? tokenize(before) : [];
      const now = after.length ? tokenize(after) : [];
      let inOld = 0;
      let inNew = 0;
      return hunk.lines.map((line) => {
        const sign = line[0];
        if (sign === '\\') return null;
        if (sign === '-') return old[inOld++] ?? null;
        if (sign !== '+') inOld++;
        return now[inNew++] ?? null;
      });
    });
    await pause();
    return colors;
  });
  queue = run.catch(() => undefined);
  return run;
}
