import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { contentUri } from '../extension/content';
import type { AlignedDiffModel } from './diff/model';
import type { DiffEngine } from './engine';
import { type DiffDescriptor, label, marksStaged, readVersion } from './sides';

/** Beyond this many total lines, ask before computing. */
const LARGE_FILE_LINES = 100_000;

/** A line diff still running after this long is abandoned as "too complex". */
const DIFF_TIMEOUT_MS = 5_000;

export interface BuildOptions {
  /** When false (refresh path), guards skip silently instead of prompting. */
  interactive: boolean;
  /** Skip (return undefined) when the inputs hash to this key: nothing changed. */
  unlessInputKey?: string;
}

export interface BuiltModel {
  model: AlignedDiffModel;
  /** Hash of everything the model was computed from. */
  inputKey: string;
}

/**
 * Builds the aligned diff model for a descriptor, or undefined when the diff
 * cannot/should not be shown (binary file, declined large-file prompt, ...)
 * or, with `unlessInputKey`, when its inputs did not change.
 */
export async function buildModel(
  engine: DiffEngine,
  descriptor: DiffDescriptor,
  options: BuildOptions,
): Promise<BuiltModel | undefined> {
  // only meaningful against HEAD: vs another revision, "staged" says nothing
  const markStaged = marksStaged(descriptor);
  const [oldText, newText, indexText, languageId] = await Promise.all([
    readVersion(descriptor, 'left'),
    readVersion(descriptor, 'right'),
    // worktree views also need the index to mark already-staged chunks
    markStaged ? readVersion({ ...descriptor, right: { kind: 'index' } }, 'right') : Promise.resolve(undefined),
    detectLanguageId(descriptor),
  ]);
  // Missing on one side = untracked (no HEAD version) or deleted (no worktree
  // version): diff against empty so the whole file shows as added/removed.
  const left = oldText ?? '';
  const right = newText ?? '';

  const inputKey = hashInputs(left, right, indexText, languageId);
  if (inputKey === options.unlessInputKey) {
    return undefined;
  }

  if (looksBinary(left) || looksBinary(right)) {
    if (options.interactive) {
      void vscode.window.showWarningMessage('Flow Diff: this file looks binary.');
    }
    return undefined;
  }

  if (options.interactive && countLines(left) + countLines(right) > LARGE_FILE_LINES) {
    const choice = await vscode.window.showWarningMessage(
      'Flow Diff: this file is very large and the diff may be slow. Continue?',
      { modal: true },
      'Continue',
    );
    if (choice !== 'Continue') {
      return undefined;
    }
  }

  const result = await engine.run({
    input: {
      oldText: left,
      newText: right,
      leftLabel: label(descriptor.left),
      rightLabel: label(descriptor.right),
      languageId,
      filePath: descriptor.oldPath ? `${descriptor.oldPath} → ${descriptor.path}` : descriptor.path,
      timeoutMs: DIFF_TIMEOUT_MS,
    },
    markStaged,
    indexText,
  });
  if (!result.ok) {
    // on refresh, keep showing the last good model
    if (options.interactive) {
      void vscode.window.showWarningMessage(
        result.tooComplex
          ? 'Flow Diff: this file has too many differences to display.'
          : `Flow Diff: could not compute the diff — ${result.message}`,
      );
    }
    return undefined;
  }
  return { model: result.model, inputKey };
}

/** Recomputes and pushes the model for an existing panel (refresh/post-action path). */
export async function refreshPanel(
  engine: DiffEngine,
  panel: {
    descriptor: DiffDescriptor;
    inputKey: string | undefined;
    setModel(model: AlignedDiffModel, inputKey: string): void;
  },
): Promise<void> {
  const built = await buildModel(engine, panel.descriptor, {
    interactive: false,
    unlessInputKey: panel.inputKey,
  });
  if (built) {
    panel.setModel(built.model, built.inputKey);
  }
}

function hashInputs(left: string, right: string, index: string | undefined, languageId: string): string {
  const hash = createHash('sha1');
  for (const part of [left, right, index ?? '\0untracked', languageId]) {
    hash.update(part).update('\0\0');
  }
  return hash.digest('hex');
}

function looksBinary(text: string): boolean {
  return text.includes('\0');
}

function countLines(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      count++;
    }
  }
  return count;
}

/**
 * The language of the file in the editor, or else the one VS Code gives its name: an empty document of the same name,
 * which costs no read of git, stands in for a file that is no longer on disk.
 */
async function detectLanguageId(descriptor: DiffDescriptor): Promise<string> {
  try {
    return (await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(descriptor.repoRoot, descriptor.path)))).languageId;
  } catch {
    try {
      return (await vscode.workspace.openTextDocument(contentUri(descriptor.repoRoot, '', descriptor.path))).languageId;
    } catch {
      return 'plaintext';
    }
  }
}
