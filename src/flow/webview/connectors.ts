import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { AlignedDiffModel, DiffChunk } from '../diff/model';
import { sideExtent } from './scrollSync';
import './connectors.css';

/** What the bands are drawn from: the chunks of a diff, or of one gutter of a merge. */
type Chunks = Pick<AlignedDiffModel, 'chunks'>;

type Editor = monaco.editor.IStandaloneCodeEditor;

const SVG_NS = 'http://www.w3.org/2000/svg';
export const GUTTER_WIDTH = 28;

export type ChunkActionKind = 'revertChunk' | 'stageChunk' | 'unstageChunk';

export interface ChunkActionsConfig<K extends string = ChunkActionKind> {
  /** Per chunk so staged chunks can offer unstage instead of stage. */
  kindsFor: (chunk: DiffChunk) => K[];
  onAction: (kind: K, chunkId: number) => void;
  /** The glyph and the tooltip of each kind, for kinds other than the Flow Diff's own. */
  glyphs?: Record<K, { glyph: string; title: string }>;
  /** A tooltip of a button that says more about its chunk than the one of its kind. */
  titleFor?: (kind: K, chunk: DiffChunk) => string | undefined;
}

export const ACTION_GLYPHS: Record<ChunkActionKind, { glyph: string; title: string }> = {
  revertChunk: { glyph: '⟲', title: 'Revert chunk' },
  stageChunk: { glyph: '+', title: 'Stage chunk' },
  unstageChunk: { glyph: '−', title: 'Unstage chunk' },
};

/**
 * SVG layer in the center gutter. The panes scroll independently, so each
 * chunk is drawn as a "genie" band: it hugs the block's real extent on each
 * side (a deleted block tapers from N lines on the left to a thin edge on the
 * right, and vice versa). Redrawn on scroll/resize in viewport coordinates.
 * Per-chunk action buttons (revert/stage/unstage) float over the band.
 */
export class Connectors<K extends string = ChunkActionKind> {
  private model: Chunks | undefined;
  private classes: ((chunk: DiffChunk) => string[]) | undefined;
  private gutter: HTMLElement | undefined;
  private left: Editor | undefined;
  private right: Editor | undefined;
  private svg: SVGSVGElement | undefined;
  private actionsLayer: HTMLElement | undefined;
  private actions: ChunkActionsConfig<K> | undefined;
  private activeChunk = -1;
  private rafPending = false;
  private readonly observer = new ResizeObserver(() => this.schedule());

  attach(
    gutter: HTMLElement,
    left: Editor,
    right: Editor,
    model: Chunks,
    actions: ChunkActionsConfig<K> | undefined,
    /** The classes of the band of a chunk, in place of its kind. */
    classes?: (chunk: DiffChunk) => string[]
  ): void {
    this.gutter = gutter;
    this.left = left;
    this.right = right;
    this.model = model;
    this.actions = actions;
    this.classes = classes;

    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('connector-layer');
    this.actionsLayer = document.createElement('div');
    this.actionsLayer.className = 'actions-layer';
    gutter.textContent = '';
    gutter.append(this.svg, this.actionsLayer);

    this.observer.disconnect();
    this.observer.observe(gutter);
    this.schedule();
  }

  setActiveChunk(chunkId: number): void {
    this.activeChunk = chunkId;
    this.schedule();
  }

  schedule(): void {
    if (this.rafPending) {
      return;
    }
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.redraw();
    });
  }

  private redraw(): void {
    if (!this.svg || !this.gutter || !this.model || !this.left || !this.right) {
      return;
    }
    const height = this.gutter.clientHeight;
    this.svg.setAttribute('width', String(GUTTER_WIDTH));
    this.svg.setAttribute('height', String(height));
    this.svg.setAttribute('viewBox', `0 0 ${GUTTER_WIDTH} ${height}`);
    this.svg.textContent = '';
    if (this.actionsLayer) {
      this.actionsLayer.textContent = '';
    }

    const leftScroll = this.left.getScrollTop();
    const rightScroll = this.right.getScrollTop();

    for (const chunk of this.model.chunks) {
      let [lt, lb] = sideExtent(this.left, chunk.leftStart, chunk.leftCount);
      let [rt, rb] = sideExtent(this.right, chunk.rightStart, chunk.rightCount);
      lt -= leftScroll;
      lb -= leftScroll;
      rt -= rightScroll;
      rb -= rightScroll;
      // give zero-height sides a visible thin edge
      if (lb - lt < 2) {
        lt -= 1;
        lb += 1;
      }
      if (rb - rt < 2) {
        rt -= 1;
        rb += 1;
      }
      if ((lb < 0 && rb < 0) || (lt > height && rt > height)) {
        continue;
      }
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', geniePath(lt, lb, rt, rb));
      path.classList.add('connector', ...(this.classes?.(chunk) ?? [chunk.kind]));
      if (chunk.staged) {
        path.classList.add('staged');
        const tooltip = document.createElementNS(SVG_NS, 'title');
        tooltip.textContent = 'Staged';
        path.appendChild(tooltip);
      }
      if (chunk.id === this.activeChunk) {
        path.classList.add('active');
      }
      this.svg.appendChild(path);
      this.renderActions(chunk, (lt + lb + rt + rb) / 4, height);
    }
  }

  private renderActions(chunk: DiffChunk, midY: number, height: number): void {
    if (!this.actions || !this.actionsLayer) {
      return;
    }
    if (midY < 0 || midY > height) {
      return;
    }
    const kinds = this.actions.kindsFor(chunk);
    if (kinds.length === 0) {
      return;
    }
    const group = document.createElement('div');
    group.className = 'chunk-actions';
    group.style.top = `${Math.round(midY - 8)}px`;
    for (const kind of kinds) {
      const { glyph, title } = this.actions.glyphs?.[kind] ?? ACTION_GLYPHS[kind as unknown as ChunkActionKind];
      const button = document.createElement('button');
      button.className = `chunk-btn ${kind}`;
      button.textContent = glyph;
      button.title = chunk.staged && kind === 'unstageChunk' ? 'Staged — unstage chunk' : (this.actions.titleFor?.(kind, chunk) ?? title);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.actions?.onAction(kind, chunk.id);
      });
      group.appendChild(button);
    }
    this.actionsLayer.appendChild(group);
  }
}

/** Band from [lt, lb] at x = 0 to [rt, rb] at x = w, with S-curved edges. */
export function geniePath(
  lt: number,
  lb: number,
  rt: number,
  rb: number,
  w: number = GUTTER_WIDTH
): string {
  const c1 = w * 0.45;
  const c2 = w * 0.55;
  return [
    `M 0 ${lt}`,
    `C ${c1} ${lt}, ${c2} ${rt}, ${w} ${rt}`,
    `L ${w} ${rb}`,
    `C ${c2} ${rb}, ${c1} ${lb}, 0 ${lb}`,
    'Z',
  ].join(' ');
}
