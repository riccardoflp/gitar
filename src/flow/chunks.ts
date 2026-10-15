import * as vscode from 'vscode';
import { type GitOp, stageOp, unstageOp } from '../git/ops';
import { Repo } from '../git/repo';
import { stagePatch, unstagePatch } from './diff/chunkPatch';
import { normalizeEol } from './diff/hunks';
import type { AlignedDiffModel, DiffChunk } from './diff/model';
import type { DiffHost } from './panel';
import { canStage, fileUri, readVersion } from './sides';

export type ChunkActionKind = 'revertChunk' | 'stageChunk' | 'unstageChunk';

/**
 * Runs a git operation in a repository the way Gitardo runs its own: logged, shown first when the user asked for
 * that, and followed by a refresh. Resolves to whether it ran and succeeded; a failure has already been reported.
 */
export type RunOp = (root: string, op: GitOp) => Promise<boolean>;

/** Host-side handlers for the per-chunk gutter buttons. */
export class ChunkActions {
  constructor(
    private readonly runOp: RunOp,
    private readonly refresh: (panel: DiffHost) => Promise<void>,
  ) {}

  async handle(panel: DiffHost, action: ChunkActionKind, chunkId: number): Promise<void> {
    const model = panel.currentModel;
    const chunk = model?.chunks.find((c) => c.id === chunkId);
    if (!model || !chunk) {
      return;
    }
    if (action !== 'revertChunk' && !canStage(panel.descriptor)) {
      return; // the webview never offers these when the index has no part in the diff
    }
    try {
      switch (action) {
        case 'revertChunk':
          await this.revertChunk(panel, model, chunk);
          break;
        case 'stageChunk':
          await this.stageChunk(panel, model, chunk);
          break;
        case 'unstageChunk':
          await this.unstageChunk(panel, model, chunk);
          break;
      }
      await this.refresh(panel);
    } catch (error) {
      void vscode.window.showWarningMessage(
        `Flow Diff: ${actionLabel(action)} failed — ${String((error as Error).message ?? error)}`,
      );
    }
  }

  /** Restores the left side's version of the chunk in the working tree (undoable edit + save). */
  private async revertChunk(panel: DiffHost, model: AlignedDiffModel, chunk: DiffChunk): Promise<void> {
    if (panel.descriptor.right.kind !== 'worktree') {
      return;
    }
    const uri = fileUri(panel.descriptor);
    const document = await vscode.workspace.openTextDocument(uri);
    if (!rightSideMatches(document, model, chunk)) {
      throw new Error('the file changed since the diff was computed, retry');
    }

    const leftLines = sideLines(model, chunk, 'left');
    const edit = new vscode.WorkspaceEdit();
    if (chunk.rightCount > 0) {
      const startLine = chunk.rightStart - 1;
      const endLineExclusive = startLine + chunk.rightCount;
      if (endLineExclusive < document.lineCount) {
        edit.replace(uri, new vscode.Range(startLine, 0, endLineExclusive, 0), leftLines.map((l) => l + '\n').join(''));
      } else {
        // chunk reaches a final line without trailing newline
        const lastLine = document.lineCount - 1;
        edit.replace(uri, new vscode.Range(startLine, 0, lastLine, document.lineAt(lastLine).text.length), leftLines.join('\n'));
      }
    } else {
      // pure deletion: re-insert the left lines (rightStart = line before, 1-based)
      if (chunk.rightStart < document.lineCount) {
        edit.insert(uri, new vscode.Position(chunk.rightStart, 0), leftLines.join('\n') + '\n');
      } else {
        const lastLine = document.lineCount - 1;
        edit.insert(uri, new vscode.Position(lastLine, document.lineAt(lastLine).text.length), '\n' + leftLines.join('\n'));
      }
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error('the edit could not be applied');
    }
    await document.save();
  }

  /** Moves the index towards the worktree on the chunk's region. */
  private async stageChunk(panel: DiffHost, model: AlignedDiffModel, chunk: DiffChunk): Promise<void> {
    const { descriptor } = panel;
    const index = await readVersion({ ...descriptor, right: { kind: 'index' } }, 'right');
    if (index === undefined) {
      // untracked file: there is no index entry to patch — stage it whole
      await this.runOp(descriptor.repoRoot, stageOp([descriptor.path]));
      return;
    }
    const worktree = (await readVersion({ ...descriptor, right: { kind: 'worktree' } }, 'right')) ?? '';
    assertSideMatches(model, 'right', worktree);
    const patch = stagePatch(descriptor.path, index, worktree, {
      start: chunk.rightStart,
      count: chunk.rightCount,
    });
    if (patch) {
      await this.applyToIndex(panel, patch, 'Stage');
    }
  }

  /**
   * Moves the index back towards HEAD on the chunk's region. In the index
   * view the chunk's right side is the index; in the worktree view (staged
   * chunk) its left side is HEAD.
   */
  private async unstageChunk(panel: DiffHost, model: AlignedDiffModel, chunk: DiffChunk): Promise<void> {
    const { descriptor } = panel;
    const [index, head] = await Promise.all([
      readVersion({ ...descriptor, right: { kind: 'index' } }, 'right'),
      readVersion({ ...descriptor, right: { kind: 'commit', ref: 'HEAD' } }, 'right'),
    ]);
    if (index === undefined) {
      return; // nothing staged
    }
    if (head === undefined) {
      // added in the index, not in HEAD: the whole file is the one chunk
      const hasHead = (await new Repo(descriptor.repoRoot).resolve('HEAD')) !== null;
      await this.runOp(descriptor.repoRoot, unstageOp([descriptor.path], hasHead));
      return;
    }
    const fromIndexView = descriptor.right.kind === 'index';
    assertSideMatches(model, fromIndexView ? 'right' : 'left', fromIndexView ? index : head);
    const patch = fromIndexView
      ? unstagePatch(descriptor.path, index, head, { start: chunk.rightStart, count: chunk.rightCount }, 'index')
      : unstagePatch(descriptor.path, index, head, { start: chunk.leftStart, count: chunk.leftCount }, 'head');
    if (patch) {
      await this.applyToIndex(panel, patch, 'Unstage');
    }
  }

  /**
   * The patch is built from decoded text and reaches git as UTF-8, so it must
   * mean the same bytes as the file: refuse instead of corrupting the index.
   */
  private async applyToIndex(panel: DiffHost, patch: string, verb: 'Stage' | 'Unstage'): Promise<void> {
    const { repoRoot, path: file } = panel.descriptor;
    const uri = fileUri(panel.descriptor);
    const encoding = vscode.workspace.getConfiguration('files', uri).get<string>('encoding', 'utf8');
    if (encoding !== 'utf8' && encoding !== 'utf8bom' && /[^\x00-\x7f]/.test(patch)) {
      throw new Error(`chunk staging needs UTF-8 text, this file is ${encoding} — stage the whole file`);
    }
    // git's decoder strips a UTF-8 BOM: a hunk on line 1 would lose or misplace it
    if (/^@@ -[01],/m.test(patch) && (await startsWithBom(uri))) {
      throw new Error('the first line of a file with a BOM cannot be staged per chunk — stage the whole file');
    }
    await this.runOp(repoRoot, chunkOp(verb, file, patch));
  }
}

/**
 * Writes one chunk of a file into the index. The patches carry no line of context, which `--unidiff-zero` allows, and
 * always go forward from the exact content of the index: unstaging is a patch from the index towards HEAD.
 */
export function chunkOp(verb: 'Stage' | 'Unstage', file: string, patch: string): GitOp {
  const header = patch.split('\n').find((line) => line.startsWith('@@')) ?? '';
  return {
    title: `${verb} change in ${file}`,
    commands: [['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-']],
    input: patch,
    note: `The patch on standard input changes this part of ${file} in the index:\n${header}`,
  };
}

async function startsWithBom(uri: vscode.Uri): Promise<boolean> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  } catch {
    return false;
  }
}

/** Race guard: the chunk coordinates are only valid for the text the model was built from. */
function assertSideMatches(model: AlignedDiffModel, side: 'left' | 'right', text: string): void {
  const expected: string[] = [];
  for (const row of model.rows) {
    const cell = side === 'left' ? row.left : row.right;
    if (cell.kind !== 'filler' && cell.text !== undefined) {
      expected.push(cell.text);
    }
  }
  const actual = normalizeEol(text).split('\n');
  if (actual[actual.length - 1] === '') {
    actual.pop();
  }
  if (actual.length !== expected.length || actual.some((line, i) => line !== expected[i])) {
    throw new Error('the file changed since the diff was computed, retry');
  }
}

function sideLines(model: AlignedDiffModel, chunk: DiffChunk, side: 'left' | 'right'): string[] {
  const lines: string[] = [];
  for (let i = chunk.rowStart; i < chunk.rowEnd; i++) {
    const cell = side === 'left' ? model.rows[i].left : model.rows[i].right;
    if (cell.kind !== 'filler' && cell.text !== undefined) {
      lines.push(cell.text);
    }
  }
  return lines;
}

/** Race guard: the document must still contain what the model says it does. */
function rightSideMatches(document: vscode.TextDocument, model: AlignedDiffModel, chunk: DiffChunk): boolean {
  if (chunk.rightCount === 0) {
    return true;
  }
  const expected = sideLines(model, chunk, 'right');
  const startLine = chunk.rightStart - 1;
  if (startLine + chunk.rightCount > document.lineCount) {
    return false;
  }
  for (let j = 0; j < expected.length; j++) {
    if (document.lineAt(startLine + j).text !== expected[j]) {
      return false;
    }
  }
  return true;
}

function actionLabel(action: ChunkActionKind): string {
  switch (action) {
    case 'revertChunk':
      return 'revert chunk';
    case 'stageChunk':
      return 'stage chunk';
    case 'unstageChunk':
      return 'unstage chunk';
  }
}
