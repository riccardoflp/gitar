/**
 * Synthesizes a unified-diff patch for a subset of the hunks between two
 * texts, suitable for `git apply --cached --unidiff-zero` (zero context
 * lines: the hunk headers are authoritative). The old side is the exact
 * current index content, so the patch always applies at the stated lines.
 * Pure module (no `vscode` import) — unit-tested with `node --test`.
 */
import type { Hunk } from './hunks';

export interface PatchOptions {
  /**
   * Line endings for added lines: 'raw' copies them from `newText` byte for
   * byte; 'lf' / 'crlf' rewrite them (staging worktree lines into an index
   * that stores a different EOL style, e.g. with `core.autocrlf`).
   */
  addedEol: 'raw' | 'lf' | 'crlf';
}

const NO_EOL_MARKER = '\\ No newline at end of file';

export function synthesizePatch(
  repoRelativePath: string,
  oldText: string,
  newText: string,
  hunks: Hunk[],
  options: PatchOptions
): string {
  const oldFile = splitRaw(oldText);
  const newFile = splitRaw(newText);
  const p = repoRelativePath.replace(/\\/g, '/');
  const out = [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`];

  // only the selected hunks get applied: each shifts the lines after it
  let delta = 0;
  for (const hunk of [...hunks].sort((a, b) => a.oldStart - b.oldStart)) {
    const firstAffected = hunk.oldCount > 0 ? hunk.oldStart : hunk.oldStart + 1;
    const newStart = (hunk.newCount > 0 ? firstAffected : firstAffected - 1) + delta;
    out.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${newStart},${hunk.newCount} @@`);
    for (let i = hunk.oldStart - 1; i < hunk.oldStart - 1 + hunk.oldCount; i++) {
      out.push(`-${oldFile.lines[i]}`);
      if (i === oldFile.lines.length - 1 && !oldFile.endsWithNewline) {
        out.push(NO_EOL_MARKER);
      }
    }
    for (let i = hunk.newStart - 1; i < hunk.newStart - 1 + hunk.newCount; i++) {
      if (i === newFile.lines.length - 1 && !newFile.endsWithNewline) {
        out.push(`+${newFile.lines[i]}`, NO_EOL_MARKER);
      } else {
        out.push(`+${withEol(newFile.lines[i], options.addedEol)}`);
      }
    }
    delta += hunk.newCount - hunk.oldCount;
  }
  return out.join('\n') + '\n';
}

/** Lines split on LF, each keeping a trailing CR if the file has one there. */
function splitRaw(text: string): { lines: string[]; endsWithNewline: boolean } {
  if (text.length === 0) {
    return { lines: [], endsWithNewline: true };
  }
  const lines = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  if (endsWithNewline) {
    lines.pop();
  }
  return { lines, endsWithNewline };
}

function withEol(rawLine: string, eol: PatchOptions['addedEol']): string {
  if (eol === 'raw') {
    return rawLine;
  }
  const bare = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  return eol === 'crlf' ? bare + '\r' : bare;
}
