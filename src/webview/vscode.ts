import type { HostMessage, WebviewMessage } from '../shared/protocol';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState<T>(state: T): T;
};

const api = acquireVsCodeApi();

export const post = (message: WebviewMessage) => api.postMessage(message);

export function onMessage(handler: (message: HostMessage) => void): () => void {
  const listener = (event: MessageEvent<HostMessage>) => handler(event.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

/** Small per-view UI state that survives the view being hidden and reloaded. */
export function loadUiState<T extends object>(fallback: T): T {
  return { ...fallback, ...(api.getState() as Partial<T> | undefined) };
}

/** Returns nothing, unlike the function of VS Code which hands the state back: an effect must not return it. */
export function saveUiState(state: object): void {
  api.setState(state);
}
