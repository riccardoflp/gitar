import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Hunk } from '../shared/protocol';
import type * as Highlight from './highlight';
import { onMessage, post } from './vscode';

type Api = typeof Highlight;
export type { Colors, Token } from './highlight';

/** Where the script of the page is: the one that colors code is next to it, read when the address is resolved. */
const base = (document.currentScript as HTMLScriptElement | null)?.src ?? location.href;

let loading: Promise<Api> | undefined;
/** Counts the themes taken since the first: the lines are colored again with each. */
let themes = 0;
const listeners = new Set<() => void>();

const dark = () => !['vscode-light', 'vscode-high-contrast-light'].some((name) => document.body.classList.contains(name));

/** The script that colors code, once it has the colors of the theme, which the host sends now and when they change. */
function load(): Promise<Api> {
  loading ??= new Promise<Api>((resolve, reject) => {
    const api: Promise<Api> = import(new URL('highlight/index.js', base).href);
    api.catch(reject);
    let first = true;
    onMessage((message) => {
      if (message.type !== 'syntaxTheme') return;
      void api
        .then((loaded) => loaded.setTheme(message.theme, dark()).then(() => loaded))
        .then((loaded) => {
          if (first) {
            first = false;
            return resolve(loaded);
          }
          themes++;
          for (const listener of listeners) listener();
        })
        .catch(reject);
    });
    post({ type: 'syntaxTheme' });
  });
  return loading;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * The colors of the lines of a file's hunks, as the editor colors its code: undefined until they are known, and for a
 * language with no grammar here, or while `wanted` is false.
 */
export function useColors(path: string, hunks: Hunk[] | null | undefined, wanted: boolean): Highlight.Colors | undefined {
  const theme = useSyncExternalStore(subscribe, () => themes);
  const [colored, setColored] = useState<{ hunks: Hunk[]; colors: Highlight.Colors | null }>();
  useEffect(() => {
    if (!wanted || !hunks?.length) return;
    let gone = false;
    load()
      .then((api) => api.colorHunks(path, hunks, () => !gone))
      .then((colors) => !gone && setColored({ hunks, colors }))
      // Without its colors, the code is shown in one.
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [path, hunks, wanted, theme]);
  return colored && colored.hunks === hunks ? (colored.colors ?? undefined) : undefined;
}
