import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import { shikiToMonaco } from '@shikijs/monaco';
import type * as monacoApi from 'monaco-editor/esm/vs/editor/editor.api.js';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import type { SyntaxTheme } from '../diff/protocol';

/**
 * Shiki (JavaScript regex engine, no WASM) drives Monaco's tokenization via
 * @shikijs/monaco, so both panes get TextMate-quality colors from the user's
 * real theme (resolved host-side), with Dark+/Light+ as fallback.
 */

type LangModule = { default: unknown };

/** VS Code languageId → shiki grammar (lazy esbuild chunk). */
const LANGS: Record<string, { id: string; load: () => Promise<LangModule> }> = {
  typescript: { id: 'typescript', load: () => import('@shikijs/langs/typescript') },
  typescriptreact: { id: 'tsx', load: () => import('@shikijs/langs/tsx') },
  javascript: { id: 'javascript', load: () => import('@shikijs/langs/javascript') },
  javascriptreact: { id: 'jsx', load: () => import('@shikijs/langs/jsx') },
  json: { id: 'json', load: () => import('@shikijs/langs/json') },
  jsonc: { id: 'jsonc', load: () => import('@shikijs/langs/jsonc') },
  css: { id: 'css', load: () => import('@shikijs/langs/css') },
  scss: { id: 'scss', load: () => import('@shikijs/langs/scss') },
  less: { id: 'less', load: () => import('@shikijs/langs/less') },
  html: { id: 'html', load: () => import('@shikijs/langs/html') },
  vue: { id: 'vue', load: () => import('@shikijs/langs/vue') },
  svelte: { id: 'svelte', load: () => import('@shikijs/langs/svelte') },
  python: { id: 'python', load: () => import('@shikijs/langs/python') },
  java: { id: 'java', load: () => import('@shikijs/langs/java') },
  go: { id: 'go', load: () => import('@shikijs/langs/go') },
  rust: { id: 'rust', load: () => import('@shikijs/langs/rust') },
  c: { id: 'c', load: () => import('@shikijs/langs/c') },
  cpp: { id: 'cpp', load: () => import('@shikijs/langs/cpp') },
  csharp: { id: 'csharp', load: () => import('@shikijs/langs/csharp') },
  php: { id: 'php', load: () => import('@shikijs/langs/php') },
  ruby: { id: 'ruby', load: () => import('@shikijs/langs/ruby') },
  yaml: { id: 'yaml', load: () => import('@shikijs/langs/yaml') },
  xml: { id: 'xml', load: () => import('@shikijs/langs/xml') },
  markdown: { id: 'markdown', load: () => import('@shikijs/langs/markdown') },
  shellscript: { id: 'shellscript', load: () => import('@shikijs/langs/shellscript') },
  powershell: { id: 'powershell', load: () => import('@shikijs/langs/powershell') },
  sql: { id: 'sql', load: () => import('@shikijs/langs/sql') },
  kotlin: { id: 'kotlin', load: () => import('@shikijs/langs/kotlin') },
  swift: { id: 'swift', load: () => import('@shikijs/langs/swift') },
  dart: { id: 'dart', load: () => import('@shikijs/langs/dart') },
  lua: { id: 'lua', load: () => import('@shikijs/langs/lua') },
  toml: { id: 'toml', load: () => import('@shikijs/langs/toml') },
  ini: { id: 'ini', load: () => import('@shikijs/langs/ini') },
  dockerfile: { id: 'dockerfile', load: () => import('@shikijs/langs/dockerfile') },
};

let highlighterPromise: Promise<HighlighterCore> | undefined;
let currentThemeName: string | undefined;
const loadedLangs = new Set<string>();
const registeredMonacoLangs = new Set<string>();

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return highlighterPromise;
}

/**
 * Loads theme + grammar into shiki, registers the language with Monaco and
 * activates shiki-driven tokenization. Returns the Monaco language id to use
 * for the editor models ('plaintext' when the language is unsupported).
 */
export async function initHighlighting(
  monaco: typeof monacoApi,
  theme: SyntaxTheme | undefined,
  languageId: string
): Promise<{ monacoLanguage: string }> {
  const highlighter = await getHighlighter();

  try {
    if (theme) {
      await highlighter.loadTheme(theme.raw as never);
      currentThemeName = theme.name;
    } else if (!currentThemeName) {
      const dark = !document.body.classList.contains('vscode-light');
      const fallback = dark
        ? await import('@shikijs/themes/dark-plus')
        : await import('@shikijs/themes/light-plus');
      await highlighter.loadTheme(fallback.default as never);
      currentThemeName = (fallback.default as { name: string }).name;
    }
  } catch (error) {
    console.warn('flow-diff: failed to load syntax theme', error);
  }

  let monacoLanguage = 'plaintext';
  const entry = LANGS[languageId];
  if (entry) {
    try {
      if (!loadedLangs.has(entry.id)) {
        const grammar = await entry.load();
        await highlighter.loadLanguage(grammar.default as never);
        loadedLangs.add(entry.id);
      }
      if (!registeredMonacoLangs.has(entry.id)) {
        monaco.languages.register({ id: entry.id });
        registeredMonacoLangs.add(entry.id);
      }
      monacoLanguage = entry.id;
    } catch (error) {
      console.warn('flow-diff: failed to load grammar', error);
    }
  }

  try {
    shikiToMonaco(highlighter, monaco);
    if (currentThemeName) {
      monaco.editor.setTheme(currentThemeName);
    }
  } catch (error) {
    console.warn('flow-diff: shikiToMonaco failed', error);
  }

  return { monacoLanguage };
}
