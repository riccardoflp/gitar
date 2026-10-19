import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { AlignedDiffModel, DiffChunk } from '../diff/model';

/**
 * Workers cannot be created cross-origin from a webview, so the bundled
 * worker is loaded through a same-origin blob shim (CSP: worker-src blob:).
 * If creation fails, Monaco falls back to running services on the main thread.
 */
export function setupMonacoEnvironment(workerUri: string): void {
  (globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    getWorker: () => {
      const blob = new Blob([`importScripts('${workerUri}');`], {
        type: 'application/javascript',
      });
      return new Worker(URL.createObjectURL(blob));
    },
  };
}

export interface DiffEditors {
  left: monaco.editor.IStandaloneCodeEditor;
  right: monaco.editor.IStandaloneCodeEditor;
}

/** Plain-JSON `editor.*` user settings forwarded from the extension host. */
export type UserEditorOptions = Record<string, unknown>;

type EditorOptions = monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions;

/**
 * The user's `editor.*` configuration maps 1:1 onto Monaco options (Monaco is
 * the VS Code editor core; unknown keys are ignored), so the panes behave like
 * the regular editor. Only keys the diff layout must own are dropped here.
 */
function sanitizedUserOptions(user: UserEditorOptions): EditorOptions {
  const options = { ...user };
  delete options.readOnly;
  delete options.automaticLayout;
  delete options.scrollbar; // merged separately to keep alwaysConsumeMouseWheel
  return options as EditorOptions;
}

function scrollbarOptions(
  user: UserEditorOptions,
  overrides?: monaco.editor.IEditorScrollbarOptions
): monaco.editor.IEditorScrollbarOptions {
  return {
    ...(user.scrollbar as monaco.editor.IEditorScrollbarOptions | undefined),
    // nested editors: the page must keep receiving wheel events at the edges
    alwaysConsumeMouseWheel: false,
    ...overrides,
  };
}

/** The left pane is the read-only reference: minimal chrome at the gutter edge. */
function leftOverrides(user: UserEditorOptions): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    readOnly: true,
    // one visible vertical scrollbar (far right); wheel still scrolls the left
    scrollbar: scrollbarOptions(user, { vertical: 'hidden' }),
    minimap: { enabled: false },
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
  };
}

export function createEditors(
  leftHost: HTMLElement,
  rightHost: HTMLElement,
  user: UserEditorOptions
): DiffEditors {
  return { left: createPane(leftHost, user, 'reference'), right: createPane(rightHost, user, 'main') };
}

/**
 * One Monaco pane: a read-only 'reference' with minimal chrome, or the 'main'
 * one, which has the only visible scrollbar.
 */
export function createPane(
  host: HTMLElement,
  user: UserEditorOptions,
  role: 'reference' | 'main'
): monaco.editor.IStandaloneCodeEditor {
  const style = getComputedStyle(document.body);
  const fontFamily = style.getPropertyValue('--vscode-editor-font-family').trim() || 'monospace';
  const fontSize = parseInt(style.getPropertyValue('--vscode-editor-font-size'), 10) || 13;

  const common: monaco.editor.IStandaloneEditorConstructionOptions = {
    // CSS-var fallbacks; the host-provided configuration normally wins
    fontFamily,
    fontSize,
    ...sanitizedUserOptions(user),
    automaticLayout: true,
    fixedOverflowWidgets: true,
  };
  return monaco.editor.create(host, { ...common, ...paneOverrides(user, role) });
}

function paneOverrides(user: UserEditorOptions, role: 'reference' | 'main'): monaco.editor.IStandaloneEditorConstructionOptions {
  return role === 'reference' ? leftOverrides(user) : { scrollbar: scrollbarOptions(user) };
}

/** Re-applies user settings to one live pane after a configuration change. */
export function applyPaneOptions(
  editor: monaco.editor.IStandaloneCodeEditor,
  user: UserEditorOptions,
  role: 'reference' | 'main',
  readOnly: boolean
): void {
  editor.updateOptions({ ...sanitizedUserOptions(user), ...paneOverrides(user, role), readOnly });
}

/** Re-applies user settings to live editors after a configuration change. */
export function applyUserOptions(
  editors: DiffEditors,
  user: UserEditorOptions,
  rightReadOnly: boolean
): void {
  const common = sanitizedUserOptions(user);
  editors.left.updateOptions({ ...common, ...leftOverrides(user) });
  editors.right.updateOptions({
    ...common,
    scrollbar: scrollbarOptions(user),
    readOnly: rightReadOnly,
  });
}

/** Diff line backgrounds + intra-line word highlights as Monaco decorations. */
export function buildDiffDecorations(
  model: AlignedDiffModel,
  side: 'left' | 'right'
): monaco.editor.IModelDeltaDecoration[] {
  const decorations: monaco.editor.IModelDeltaDecoration[] = [];
  const inlineClass = side === 'left' ? 'bd-inline-removed' : 'bd-inline-added';
  for (const row of model.rows) {
    const cell = side === 'left' ? row.left : row.right;
    if (cell.kind === 'filler' || cell.kind === 'context' || cell.lineNumber === undefined) {
      continue;
    }
    // staged chunks render dimmed so pending work stands out
    const staged = row.chunkId !== undefined && model.chunks[row.chunkId]?.staged === true;
    const line = cell.lineNumber;
    const lineClass = `bd-line-${cell.kind}${staged ? ' bd-staged' : ''}`;
    decorations.push({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: lineClass,
        // the line numbers share the change color, like VS Code's diff editor
        marginClassName: lineClass,
      },
    });
    for (const [start, end] of cell.highlights ?? []) {
      if (end > start) {
        decorations.push({
          range: new monaco.Range(line, start + 1, line, end + 1),
          options: { inlineClassName: `${inlineClass}${staged ? ' bd-inline-staged' : ''}` },
        });
      }
    }
  }
  // a chunk absent on this side (pure insertion/deletion) leaves no colored
  // lines here — mark the boundary with a divider where the connector lands
  for (const chunk of model.chunks) {
    const count = side === 'left' ? chunk.leftCount : chunk.rightCount;
    if (count !== 0) {
      continue;
    }
    const start = side === 'left' ? chunk.leftStart : chunk.rightStart;
    // hunk-header convention: `start` is the line before the boundary,
    // 0 meaning a change before the first line
    const edge = start === 0 ? 'top' : 'bottom';
    const line = Math.max(1, start);
    const dividerClass = `bd-divider-${edge} bd-divider-${chunk.kind}${
      chunk.staged ? ' bd-divider-staged' : ''
    }`;
    decorations.push({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: dividerClass,
        marginClassName: dividerClass,
      },
    });
  }
  return decorations;
}

/** Overview-ruler / minimap colors per chunk kind: CSS var + fallback. */
const RULER_COLORS: Record<DiffChunk['kind'], [cssVar: string, fallback: string]> = {
  added: ['--vscode-editorOverviewRuler-addedForeground', 'rgba(72, 126, 2, 0.6)'],
  removed: ['--vscode-editorOverviewRuler-deletedForeground', 'rgba(241, 76, 76, 0.6)'],
  modified: ['--vscode-editorOverviewRuler-modifiedForeground', 'rgba(27, 129, 168, 0.6)'],
};

/** Multiplies a hex/rgb(a) color's alpha — the canvas ruler cannot use CSS opacity. */
function faded(color: string, factor: number): string {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (hex) {
    const alpha = Math.round((hex[2] ? parseInt(hex[2], 16) : 255) * factor);
    return `#${hex[1]}${alpha.toString(16).padStart(2, '0')}`;
  }
  const rgb = /^rgba?\((.+?)(?:,\s*([\d.]+))?\)$/.exec(color.replace(/\s/g, ' '));
  if (rgb) {
    const parts = rgb[1].split(',').slice(0, 3).join(',');
    const alpha = (rgb[2] !== undefined ? parseFloat(rgb[2]) : 1) * factor;
    return `rgba(${parts}, ${alpha})`;
  }
  return color;
}

/**
 * Chunk markers for the right pane's scrollbar (overview ruler) and minimap,
 * so the change locations are visible at a glance. The panes scroll in sync,
 * so the single visible scrollbar represents both sides; a pure deletion
 * (no lines on the right) gets a one-line marker at its boundary.
 * Colors must be resolved here: the ruler is canvas, CSS vars don't apply.
 */
export function buildOverviewRulerDecorations(
  model: AlignedDiffModel
): monaco.editor.IModelDeltaDecoration[] {
  const style = getComputedStyle(document.body);
  return model.chunks.map((chunk) => {
    const [cssVar, fallback] = RULER_COLORS[chunk.kind];
    let color = style.getPropertyValue(cssVar).trim() || fallback;
    if (chunk.staged) {
      color = faded(color, 0.35);
    }
    const start = Math.max(1, chunk.rightStart);
    const end = chunk.rightCount > 0 ? chunk.rightStart + chunk.rightCount - 1 : start;
    return {
      range: new monaco.Range(start, 1, end, 1),
      options: {
        overviewRuler: { color, position: monaco.editor.OverviewRulerLane.Full },
        minimap: { color, position: monaco.editor.MinimapPosition.Gutter },
      },
    };
  });
}

/** Focus outline on the lines of the currently navigated chunk. */
export function buildActiveChunkDecorations(
  model: AlignedDiffModel,
  chunkId: number,
  side: 'left' | 'right'
): monaco.editor.IModelDeltaDecoration[] {
  const chunk = chunkId >= 0 ? model.chunks[chunkId] : undefined;
  if (!chunk) {
    return [];
  }
  const start = side === 'left' ? chunk.leftStart : chunk.rightStart;
  const count = side === 'left' ? chunk.leftCount : chunk.rightCount;
  if (count === 0) {
    return [];
  }
  return [
    {
      range: new monaco.Range(start, 1, start + count - 1, 1),
      options: { isWholeLine: true, className: 'bd-active-chunk' },
    },
  ];
}
