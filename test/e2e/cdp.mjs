// A minimal client for the Chrome DevTools Protocol, which VS Code speaks when started with --remote-debugging-port.

import * as net from 'node:net';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `check` returns something truthy, and returns it. */
export async function until(what, check, timeout = 20_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** The pages and frames that can be debugged: the workbench window, and one per webview. */
export async function targets(port) {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    // Not listening yet.
    return [];
  }
}

/** A connection to one target. */
export class Session {
  #socket;
  #next = 0;
  #pending = new Map();
  #listeners = new Map();
  /** Execution contexts by id, kept up to date once `Runtime.enable` has been sent. */
  contexts = new Map();

  static open(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new Session(socket)), { once: true });
      socket.addEventListener('error', () => reject(new Error(`Could not connect to ${url}`)), { once: true });
    });
  }

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const waiting = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) waiting?.reject(new Error(`${waiting.method}: ${message.error.message}`));
        else waiting?.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.executionContextCreated') this.contexts.set(message.params.context.id, message.params.context);
      if (message.method === 'Runtime.executionContextDestroyed') this.contexts.delete(message.params.executionContextId);
      if (message.method === 'Runtime.executionContextsCleared') this.contexts.clear();
      for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params);
    });
  }

  send(method, params = {}) {
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    this.#listeners.set(method, [...(this.#listeners.get(method) ?? []), listener]);
  }

  /** Evaluates an expression, in the main world of the target or in the given execution context, and returns its value. */
  async evaluate(expression, contextId) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      contextId,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  close() {
    this.#socket.close();
  }
}
