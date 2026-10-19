import * as path from 'node:path';
import * as vscode from 'vscode';
import { git } from '../git/exec';
import { samePath } from '../git/parse';
import { Repo } from '../git/repo';
import { INDEX, SCHEME, contentUri } from '../extension/content';

/** A version of a file, on one side of a diff. */
export type Version =
  /** The file in the editor: unsaved changes included. */
  | { kind: 'worktree' }
  | { kind: 'index' }
  /** `HEAD`, or the hash of a commit. */
  | { kind: 'commit'; ref: string }
  /** The file does not exist on this side, such as before a commit with no parent. */
  | { kind: 'none' };

/** What a Flow Diff shows: a file of a repository, as it is on each side. */
export interface DiffDescriptor {
  repoRoot: string;
  /** The file as it is named on the right, relative to the repository and with forward slashes. */
  path: string;
  /** Its name on the left, when it was renamed. */
  oldPath?: string;
  left: Version;
  right: Version;
}

const HEAD: Version = { kind: 'commit', ref: 'HEAD' };

export function fileUri(d: DiffDescriptor): vscode.Uri {
  return vscode.Uri.file(path.join(d.repoRoot, d.path));
}

const isHead = (version: Version) => version.kind === 'commit' && version.ref === 'HEAD';

/** What the right side is, for the chunk actions the webview offers: the file can be edited, the index unstaged, or neither. */
export function rightSide(d: DiffDescriptor): 'worktree' | 'index' | 'ref' {
  return d.right.kind === 'worktree' ? 'worktree' : d.right.kind === 'index' ? 'index' : 'ref';
}

/**
 * Chunks can be staged and unstaged between the stages of the uncommitted changes: HEAD, the index and the file. A
 * renamed file is left out: its patches would name one path for both sides.
 */
export function canStage(d: DiffDescriptor): boolean {
  if (d.oldPath && d.oldPath !== d.path) return false;
  if (d.right.kind === 'worktree') return isHead(d.left) || d.left.kind === 'index';
  return d.right.kind === 'index' && isHead(d.left);
}

/** Only against HEAD does a chunk of the file say whether it is in the index already. */
export function marksStaged(d: DiffDescriptor): boolean {
  return canStage(d) && d.right.kind === 'worktree' && isHead(d.left);
}

/** The changed files F7 moves on to, past the last chunk: those that differ between the same two sides. */
export function changedFiles(d: DiffDescriptor, working: { staged: { path: string }[]; unstaged: { path: string }[] }): string[] | undefined {
  if (!canStage(d)) return undefined;
  const files =
    d.right.kind === 'index' ? working.staged : d.left.kind === 'index' ? working.unstaged : [...working.staged, ...working.unstaged];
  return [...new Set(files.map((file) => file.path))];
}

export function label(version: Version): string {
  switch (version.kind) {
    case 'worktree':
      return 'Working Tree';
    case 'index':
      return 'Index';
    case 'commit':
      return /^[0-9a-f]{12,}$/i.test(version.ref) ? version.ref.slice(0, 7) : version.ref;
    case 'none':
      return 'Empty';
  }
}

export function title(d: DiffDescriptor): string {
  return `${path.posix.basename(d.path)} (${label(d.left)} ↔ ${label(d.right)})`;
}

/** Identifies a diff: opening it again reveals the panel that has it. */
export function diffKey(d: DiffDescriptor): string {
  return JSON.stringify([d.repoRoot.replace(/\\/g, '/').toLowerCase(), d.path, d.oldPath ?? '', d.left, d.right]);
}

/**
 * The text of a version of the file, or nothing when the file is not there. The working tree is read through its
 * document, decoded the way the editor does and with what has not been saved yet.
 */
export async function readVersion(d: DiffDescriptor, side: 'left' | 'right'): Promise<string | undefined> {
  const version = d[side];
  const file = side === 'left' ? (d.oldPath ?? d.path) : d.path;
  switch (version.kind) {
    case 'none':
      return undefined;
    case 'worktree': {
      const uri = vscode.Uri.file(path.join(d.repoRoot, file));
      try {
        return (await vscode.workspace.openTextDocument(uri)).getText();
      } catch {
        // Deleted, or refused as text (binary, too large): the raw bytes, if any, still reach the binary guard.
        try {
          return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        } catch {
          return undefined;
        }
      }
    }
    case 'index':
    case 'commit': {
      const object = `${version.kind === 'index' ? '' : version.ref}:${file}`;
      try {
        return (await git(d.repoRoot, ['show', object], { readOnly: true })).stdout;
      } catch {
        return undefined;
      }
    }
  }
}

/** The URI of a version of the file in the diff editor of VS Code. */
function versionUri(d: DiffDescriptor, side: 'left' | 'right'): vscode.Uri {
  const version = d[side];
  const file = side === 'left' ? (d.oldPath ?? d.path) : d.path;
  switch (version.kind) {
    case 'worktree':
      return vscode.Uri.file(path.join(d.repoRoot, file));
    case 'index':
      return contentUri(d.repoRoot, INDEX, file);
    case 'commit':
      return contentUri(d.repoRoot, version.ref, file);
    case 'none':
      return contentUri(d.repoRoot, '', file);
  }
}

/** Opens the same diff in the diff editor of VS Code. */
export async function openInDiffEditor(d: DiffDescriptor, viewColumn?: vscode.ViewColumn): Promise<void> {
  await vscode.commands.executeCommand('vscode.diff', versionUri(d, 'left'), versionUri(d, 'right'), title(d), { viewColumn, preview: false });
}

/**
 * What a diff editor of VS Code shows, in Flow Diff's terms: the diffs Gitardo opens, those of the Git extension of
 * VS Code (its Source Control view, its timeline, the gutter of an editor) and a file against its own version on disk.
 * Nothing for the rest, such as two unrelated files.
 */
export async function describeDiff(original: vscode.Uri, modified: vscode.Uri): Promise<DiffDescriptor | undefined> {
  const left = await locate(original);
  const right = await locate(modified);
  if (!left || !right || !samePath(left.root, right.root) || left.version.kind === 'worktree') return undefined;
  // Gitardo names HEAD by its hash in the diffs of uncommitted changes, and a new file has nothing on the left. HEAD
  // is what lets the index take part: a file that is not in it reads as empty all the same.
  const uncommitted = right.version.kind === 'worktree' || right.version.kind === 'index';
  if (uncommitted && left.version.kind === 'none') left.version = HEAD;
  if (uncommitted && left.version.kind === 'commit' && /^[0-9a-f]{40,64}$/.test(left.version.ref)) {
    const head = await new Repo(left.root).resolve('HEAD').catch(() => null);
    if (head === left.version.ref) left.version = HEAD;
  }
  return {
    repoRoot: left.root,
    path: right.path,
    oldPath: left.path !== right.path ? left.path : undefined,
    left: left.version,
    right: right.version,
  };
}

interface Located {
  root: string;
  path: string;
  version: Version;
}

async function locate(uri: vscode.Uri): Promise<Located | undefined> {
  if (uri.scheme === SCHEME) {
    try {
      const { root, ref, file } = JSON.parse(uri.query) as { root: string; ref: string; file?: string };
      const name = file ?? uri.path.slice(1);
      if (ref === '') return { root, path: name, version: { kind: 'none' } };
      if (ref === INDEX) return { root, path: name, version: { kind: 'index' } };
      // The other stages of the index are the sides of a conflict, and a proposal is not in git at all.
      if (ref.startsWith(':') || ref === 'proposal') return undefined;
      return { root, path: name, version: { kind: 'commit', ref } };
    } catch {
      return undefined;
    }
  }
  if (uri.scheme === 'git') {
    // The Git extension of VS Code: `~` and the empty ref both stand for the index.
    try {
      const { path: file, ref } = JSON.parse(uri.query) as { path: string; ref: string };
      const at = await inRepository(file);
      if (!at) return undefined;
      return { ...at, version: ref === '' || ref === '~' ? { kind: 'index' } : { kind: 'commit', ref } };
    } catch {
      return undefined;
    }
  }
  if (uri.scheme === 'file') {
    const at = await inRepository(uri.fsPath);
    return at && { ...at, version: { kind: 'worktree' } };
  }
  return undefined;
}

/** The repository a file is in, and its path there with forward slashes. */
export async function inRepository(file: string): Promise<{ root: string; path: string } | undefined> {
  // The folder of the file can be gone with it: the repository is looked for higher up.
  let dir = path.dirname(file);
  for (;;) {
    const root = await Repo.discover(dir).catch(() => null);
    if (root) return { root, path: path.relative(root, file).split(path.sep).join('/') };
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
