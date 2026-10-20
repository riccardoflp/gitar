import * as vscode from 'vscode';
import type { Answer } from '../git/review';

/**
 * What the language model answered for the conflicts, for as long as VS Code runs: the tab of the review and the Flow
 * Merge show the same. An answer is kept by the file and the fingerprint of its conflict, and so holds as long as
 * nobody edits that conflict.
 */
export class Answers {
  private readonly answers = new Map<string, Answer>();
  private readonly changed = new vscode.EventEmitter<string>();

  /** Fires with the root of the repository whose answers changed. */
  readonly onDidChange = this.changed.event;

  get(root: string, path: string, fingerprint: string): Answer | undefined {
    return this.answers.get(key(root, path, fingerprint));
  }

  set(root: string, path: string, fingerprint: string, answer: Answer): void {
    this.answers.set(key(root, path, fingerprint), answer);
    this.changed.fire(root);
  }

  delete(root: string, path: string, fingerprint: string): void {
    if (this.answers.delete(key(root, path, fingerprint))) this.changed.fire(root);
  }
}

/** The same for a repository however its folder is written: with either slash, in either case. */
const key = (root: string, path: string, fingerprint: string) => `${root.replace(/\\/g, '/').toLowerCase()}\0${path}\0${fingerprint}`;

export const answers = new Answers();
