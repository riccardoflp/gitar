import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import { shikiToMonaco } from '@shikijs/monaco';
import type * as monacoApi from 'monaco-editor/esm/vs/editor/editor.api.js';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import type { SyntaxTheme } from '../diff/protocol';
import { LANGS } from './languages';

/**
 * Shiki (JavaScript regex engine, no WASM) drives Monaco's tokenization via
 * @shikijs/monaco, so both panes get TextMate-quality colors from the user's
 * real theme (resolved host-side), with Dark+/Light+ as fallback.
 */

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
