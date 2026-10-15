import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { AlignedDiffModel } from '../diff/model';
import { type UnchangedRegion, unchangedRegions } from '../diff/unchanged';
import type { DiffEditors } from './editors';

type Editor = monaco.editor.IStandaloneCodeEditor;

/**
 * `setHiddenAreas` is not in Monaco's public typings, but it is what Monaco's
 * own diff editor uses to hide unchanged regions — feature-detected, so a
 * Monaco without it simply shows every line.
 */
type HidingEditor = Editor & {
  setHiddenAreas(ranges: monaco.IRange[], source?: unknown): void;
};

/** Our slot in Monaco's per-source hidden areas. */
const SOURCE = {};

/**
 * Hides long runs of unchanged lines on both panes (same rows on each side,
 * so the panes stay aligned) behind a clickable "⋯ N unchanged lines" bar.
 * Expanded regions are remembered by their HEAD-side start line, which does
 * not move while the working tree is edited.
 */
export class Collapser {
  private enabled: boolean;
  private readonly expanded = new Set<number>();
  private regions: UnchangedRegion[] = [];
  private editors: DiffEditors | undefined;
  /** Live view zone ids per editor → the region they stand for. */
  private readonly zones = new Map<Editor, Map<string, UnchangedRegion>>();
  private listeners: monaco.IDisposable[] = [];

  constructor(enabled: boolean, private readonly onLayoutChange: () => void) {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  attach(editors: DiffEditors): void {
    if (this.editors === editors) {
      return;
    }
    this.listeners.forEach((d) => d.dispose());
    this.editors = editors;
    this.listeners = [editors.left, editors.right].flatMap((editor) => [
      editor.onMouseDown((event) => {
        if (event.target.type === monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE) {
          const region = this.zones.get(editor)?.get(event.target.detail.viewZoneId);
          if (region) {
            this.expand(region);
          }
        }
      }),
      // find, go-to-line, F7 into hidden lines: reveal them
      editor.onDidChangeCursorPosition((event) => {
        // only explicit moves: not the cursor reset of setValue/setModel, nor
        // Monaco nudging it out of lines we just hid
        if (
          !['keyboard', 'mouse', 'api'].includes(event.source) ||
          event.reason === monaco.editor.CursorChangeReason.ContentFlush
        ) {
          return;
        }
        const side = editor === editors.left ? 'left' : 'right';
        const region = this.hiddenRegions().find((r) => {
          const start = side === 'left' ? r.leftStart : r.rightStart;
          return event.position.lineNumber >= start && event.position.lineNumber < start + r.count;
        });
        if (region) {
          this.expand(region);
        }
      }),
    ]);
  }

  /** Recomputes the regions for a (new) model and re-applies them. */
  update(model: AlignedDiffModel): void {
    this.regions = unchangedRegions(model);
    this.apply();
  }

  toggle(): void {
    this.enabled = !this.enabled;
    this.expanded.clear();
    this.apply();
  }

  private expand(region: UnchangedRegion): void {
    this.expanded.add(region.leftStart);
    this.apply();
  }

  private hiddenRegions(): UnchangedRegion[] {
    return this.enabled ? this.regions.filter((r) => !this.expanded.has(r.leftStart)) : [];
  }

  private apply(): void {
    const editors = this.editors;
    if (!editors) {
      return;
    }
    const hidden = this.hiddenRegions();
    this.applySide(editors.left, hidden, (r) => r.leftStart);
    this.applySide(editors.right, hidden, (r) => r.rightStart);
    this.onLayoutChange();
  }

  private applySide(editor: Editor, hidden: UnchangedRegion[], start: (r: UnchangedRegion) => number): void {
    const hiding = editor as HidingEditor;
    if (typeof hiding.setHiddenAreas !== 'function') {
      return;
    }
    const lineCount = editor.getModel()?.getLineCount() ?? 0;
    const valid = hidden.filter((r) => start(r) + r.count - 1 <= lineCount);
    hiding.setHiddenAreas(
      valid.map((r) => new monaco.Range(start(r), 1, start(r) + r.count - 1, 1)),
      SOURCE
    );
    const ids = new Map<string, UnchangedRegion>();
    editor.changeViewZones((accessor) => {
      for (const id of this.zones.get(editor)?.keys() ?? []) {
        accessor.removeZone(id);
      }
      for (const region of valid) {
        const domNode = document.createElement('div');
        domNode.className = 'bd-collapsed';
        domNode.textContent = `⋯ ${region.count} unchanged lines`;
        domNode.title = 'Click to expand';
        const zone = { afterLineNumber: start(region) - 1, heightInLines: 1, domNode, showInHiddenAreas: true };
        ids.set(accessor.addZone(zone), region);
      }
    });
    this.zones.set(editor, ids);
  }
}
