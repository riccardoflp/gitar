import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { AlignedDiffModel } from '../diff/model';
import { buildAnchors, mapPosition, type ScrollAnchors } from '../diff/scrollMap';

type Editor = monaco.editor.IStandaloneCodeEditor;

/**
 * Absolute pixel extent [top, bottom] of one side of a chunk, in the editor's
 * content coordinates. Asking the editor (instead of line × lineHeight
 * arithmetic) keeps the geometry correct under word wrap and code folding.
 * A zero-count side collapses to a point at the insertion line boundary
 * (`start` follows the hunk-header convention: line before the insertion).
 */
export function sideExtent(editor: Editor, start: number, count: number): [number, number] {
  // Chunks of a text before an edit can point past the end of the one after it, until they are computed again.
  const last = Math.max(1, editor.getModel()?.getLineCount() ?? 1);
  const line = (number: number) => Math.min(Math.max(1, number), last);
  if (count === 0) {
    const y = start === 0 ? 0 : editor.getBottomForLineNumber(line(start));
    return [y, y];
  }
  return [editor.getTopForLineNumber(line(start)), editor.getBottomForLineNumber(line(start + count - 1))];
}

/**
 * Keeps the two Monaco editors' vertical scroll positions in sync through a
 * piecewise linear mapping anchored at chunk boundaries: context regions
 * scroll 1:1, changed regions of different heights stretch.
 *
 * The mapping is applied to the viewport *center*, not the top edge. While
 * traversing a chunk much taller on one side, the shorter side then keeps its
 * counterpart near mid-viewport — context stays visible above and below —
 * instead of pinning it against the top of the pane. It also agrees with
 * chunk navigation, which centers both sides.
 */
export class ScrollSync {
  private left: Editor | undefined;
  private right: Editor | undefined;
  private model: Pick<AlignedDiffModel, 'chunks'> | undefined;
  private anchors: ScrollAnchors = buildAnchors([]);
  /** Suppresses feedback loops: scroll positions we set programmatically. */
  private readonly expected = new Map<Editor, number>();
  private listeners: monaco.IDisposable[] = [];

  constructor(private readonly onAnyScroll: () => void) {}

  attach(left: Editor, right: Editor, model: Pick<AlignedDiffModel, 'chunks'>): void {
    this.listeners.forEach((d) => d.dispose());
    this.left = left;
    this.right = right;
    this.model = model;
    this.setAnchors();
    // wrapping, folding, or font changes move lines around: rebuild the map
    const remap = () => {
      this.setAnchors();
      this.onAnyScroll();
    };
    this.listeners = [
      left.onDidScrollChange((event) => {
        if (event.scrollTopChanged) {
          this.onScroll(left, right, true);
        } else {
          this.onAnyScroll();
        }
      }),
      right.onDidScrollChange((event) => {
        if (event.scrollTopChanged) {
          this.onScroll(right, left, false);
        } else {
          this.onAnyScroll();
        }
      }),
      left.onDidContentSizeChange(remap),
      right.onDidContentSizeChange(remap),
    ];
  }

  private setAnchors(): void {
    const { left, right, model } = this;
    if (!left || !right || !model) {
      return;
    }
    const pairs: Array<[number, number]> = [];
    for (const chunk of model.chunks) {
      const [lt, lb] = sideExtent(left, chunk.leftStart, chunk.leftCount);
      const [rt, rb] = sideExtent(right, chunk.rightStart, chunk.rightCount);
      pairs.push([lt, rt], [lb, rb]);
    }
    const leftModel = left.getModel();
    const rightModel = right.getModel();
    if (leftModel && rightModel) {
      pairs.push([
        left.getBottomForLineNumber(leftModel.getLineCount()),
        right.getBottomForLineNumber(rightModel.getLineCount()),
      ]);
    }
    this.anchors = buildAnchors(pairs);
  }

  /** Scroll one editor without triggering a counter-sync from its scroll event. */
  setScrollTop(editor: Editor, value: number): void {
    const max = Math.max(0, editor.getScrollHeight() - editor.getLayoutInfo().height);
    const clamped = Math.max(0, Math.min(value, max));
    this.expected.set(editor, clamped);
    editor.setScrollTop(clamped);
  }

  private onScroll(source: Editor, target: Editor, fromLeft: boolean): void {
    const expected = this.expected.get(source);
    if (expected !== undefined && Math.abs(source.getScrollTop() - expected) < 1.5) {
      this.expected.delete(source);
      this.onAnyScroll();
      return;
    }
    this.expected.delete(source);
    const sourceCenter = source.getScrollTop() + source.getLayoutInfo().height / 2;
    const mapped = this.map(sourceCenter, fromLeft) - target.getLayoutInfo().height / 2;
    if (Math.abs(target.getScrollTop() - mapped) >= 1) {
      this.setScrollTop(target, mapped);
    }
    this.onAnyScroll();
  }

  private map(y: number, fromLeft: boolean): number {
    const { left, right } = this.anchors;
    return fromLeft ? mapPosition(y, left, right) : mapPosition(y, right, left);
  }
}
