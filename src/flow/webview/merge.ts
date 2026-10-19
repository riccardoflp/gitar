import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import type { DiffChunk } from '../diff/model';
import { type LineHighlight, type LineSpan, type MergeModel, type MergeRegion, paneChunks, resultLine } from '../diff/mergeModel';
import type { MergeHostMessage, MergeSettings, MergeWebviewMessage } from '../diff/mergeProtocol';
import type { SyntaxTheme } from '../diff/protocol';
import { Connectors } from './connectors';
import { applyPaneOptions, createPane, setupMonacoEnvironment } from './editors';
import { initHighlighting } from './highlight';
import { Navigation } from './navigation';
import { ScrollSync, sideExtent } from './scrollSync';
import './styles.css';
import './merge.css';

/**
 * The Flow Merge: a file in conflict in three Monaco panes, what the current side has, the result and what the
 * incoming side has, with the changes of each side joined by bands to where they are in the result.
 */

type Editor = monaco.editor.IStandaloneCodeEditor;
type Pane = 'ours' | 'result' | 'theirs';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscodeApi = acquireVsCodeApi();
const root = document.getElementById('app') as HTMLElement;
setupMonacoEnvironment(root.dataset.worker ?? '');

interface Layout {
  labels: Record<Pane, HTMLElement>;
  hosts: Record<Pane, HTMLElement>;
  gutters: { left: HTMLElement; right: HTMLElement };
  resultName: HTMLElement;
}

let model: MergeModel | undefined;
let layout: Layout | undefined;
let editors: Record<Pane, Editor> | undefined;
const decorations = new Map<Pane, monaco.editor.IEditorDecorationsCollection>();
const active = new Map<Pane, monaco.editor.IEditorDecorationsCollection>();

const left = new Connectors();
const right = new Connectors();
const redraw = () => {
  left.schedule();
  right.schedule();
};
// The result is the hub: each side scrolls with it, and so with the other side through it.
const leftSync = new ScrollSync(redraw);
const rightSync = new ScrollSync(redraw);
const toolbar = createToolbar();
const navigation = new Navigation({ onChange: onNavChange, onHint: () => {}, onFileJump: () => {} });

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as MergeHostMessage;
  switch (message.type) {
    case 'init':
      void onInit(message.model, message.settings, message.syntaxTheme);
      break;
    case 'update':
      onUpdate(message.model);
      break;
    case 'navigate':
      if (message.direction === 'next') navigation.next();
      else navigation.prev();
      break;
    case 'theme':
      if (model) {
        void initHighlighting(monaco, message.syntaxTheme, model.languageId);
        setDecorations(model); // ruler colors are resolved, not CSS vars
      }
      break;
    case 'editorConfig':
      if (editors) {
        applyPaneOptions(editors.ours, message.options, 'reference', true);
        applyPaneOptions(editors.result, message.options, 'main', true);
        applyPaneOptions(editors.theirs, message.options, 'reference', true);
        redraw();
      }
      break;
  }
});

async function onInit(m: MergeModel, settings: MergeSettings, theme: SyntaxTheme | undefined): Promise<void> {
  layout = createLayout(root);
  const user = settings.editorOptions ?? {};
  editors = {
    ours: createPane(layout.hosts.ours, user, 'reference'),
    result: createPane(layout.hosts.result, user, 'main'),
    theirs: createPane(layout.hosts.theirs, user, 'reference'),
  };
  // Phase one shows the merge: the result is edited in the editor of the file.
  editors.result.updateOptions({ readOnly: true });
  const { monacoLanguage } = await initHighlighting(monaco, theme, m.languageId);
  for (const pane of PANES) editors[pane].setModel(monaco.editor.createModel(m[pane], monacoLanguage));
  wireKeys(editors);
  refreshAll(m);
}

function onUpdate(m: MergeModel): void {
  if (!editors) return;
  for (const pane of PANES) {
    if (editors[pane].getValue() !== m[pane]) editors[pane].setValue(m[pane]);
  }
  refreshAll(m);
}

const PANES: Pane[] = ['ours', 'result', 'theirs'];

function refreshAll(m: MergeModel): void {
  model = m;
  if (!editors || !layout) return;
  layout.labels.ours.textContent = m.oursLabel;
  layout.resultName.textContent = `${m.filePath} — ${m.resultLabel}`;
  layout.labels.theirs.textContent = m.theirsLabel;
  layout.labels.ours.title = m.oursLabel;
  layout.labels.theirs.title = m.theirsLabel;
  setDecorations(m);

  // Every region anchors the scroll; the bands of a gutter are the changes of its own side.
  leftSync.attach(editors.ours, editors.result, { chunks: paneChunks(m.regions, 'ours', 'result') });
  rightSync.attach(editors.result, editors.theirs, { chunks: paneChunks(m.regions, 'result', 'theirs') });
  const band = (chunk: DiffChunk) => bandClasses(m.regions[chunk.id]);
  left.attach(layout.gutters.left, editors.ours, editors.result, { chunks: paneChunks(m.regions, 'ours', 'result', (region) => region.kind !== 'theirs') }, undefined, band);
  right.attach(layout.gutters.right, editors.result, editors.theirs, { chunks: paneChunks(m.regions, 'result', 'theirs', (region) => region.kind !== 'ours') }, undefined, band);
  navigation.setModel({ chunks: paneChunks(m.regions, 'ours', 'result') });

  const open = m.regions.filter((region) => region.unresolved).length;
  const conflicts = m.regions.filter((region) => region.kind === 'conflict').length;
  toolbar.conflicts.textContent =
    open > 0 ? `${open} ${open === 1 ? 'conflict' : 'conflicts'} left` : conflicts > 0 ? 'No conflicts left' : 'No conflicts';
  toolbar.conflicts.classList.toggle('done', open === 0);
}

function bandClasses(region: MergeRegion | undefined): string[] {
  if (!region) return ['modified'];
  return ['fm-band', `fm-${region.kind}`, ...(region.unresolved ? ['fm-unresolved'] : [])];
}

function setDecorations(m: MergeModel): void {
  if (!editors) return;
  const set = (pane: Pane, list: monaco.editor.IModelDeltaDecoration[]) => {
    let collection = decorations.get(pane);
    if (!collection) decorations.set(pane, (collection = editors![pane].createDecorationsCollection([])));
    collection.set(list);
  };
  set('ours', sideDecorations(m.regions.filter((region) => region.kind !== 'theirs'), 'ours', m.oursHighlights));
  set('theirs', sideDecorations(m.regions.filter((region) => region.kind !== 'ours'), 'theirs', m.theirsHighlights));
  set('result', [...resultDecorations(m), ...rulerDecorations(m)]);
}

/** The lines a side changed, in the color of what became of them, and the characters it changed in them. */
function sideDecorations(regions: MergeRegion[], pane: 'ours' | 'theirs', highlights: LineHighlight[]): monaco.editor.IModelDeltaDecoration[] {
  const list = regions.flatMap((region) => lineDecorations(region[pane], `fm-${region.kind}`));
  const changed = new Set(regions.flatMap((region) => linesOf(region[pane])));
  for (const { line, ranges } of highlights) {
    if (!changed.has(line)) continue;
    for (const [start, end] of ranges) {
      if (end > start) list.push({ range: new monaco.Range(line, start + 1, line, end + 1), options: { inlineClassName: `fm-inline fm-inline-${pane}` } });
    }
  }
  return list;
}

/** Every region in the result, the markers of git, and which side each part of a conflict still marked comes from. */
function resultDecorations(m: MergeModel): monaco.editor.IModelDeltaDecoration[] {
  const list = m.regions.flatMap((region) => lineDecorations(region.result, `fm-${region.kind}${region.unresolved ? ' fm-unresolved' : ''}`));
  for (const region of m.regions.filter((each) => each.unresolved)) {
    for (const [part, side] of [
      [region.resultOurs, 'ours'],
      [region.resultTheirs, 'theirs'],
    ] as const) {
      for (const line of linesOf(part)) list.push(whole(line, { marginClassName: `fm-part-${side}` }));
    }
  }
  for (const line of m.markerLines) list.push(whole(line, { className: 'fm-marker' }));
  return list;
}

const RULER: Record<MergeRegion['kind'], [cssVar: string, fallback: string]> = {
  ours: ['--vscode-merge-currentHeaderBackground', 'rgba(64, 200, 174, 0.5)'],
  theirs: ['--vscode-merge-incomingHeaderBackground', 'rgba(64, 166, 255, 0.5)'],
  both: ['--vscode-merge-commonHeaderBackground', 'rgba(96, 96, 96, 0.4)'],
  conflict: ['--vscode-gitDecoration-conflictingResourceForeground', '#e4676b'],
};

/** The regions on the scrollbar of the result. Colors are resolved here: the ruler is canvas, CSS vars don't apply. */
function rulerDecorations(m: MergeModel): monaco.editor.IModelDeltaDecoration[] {
  const style = getComputedStyle(document.body);
  return m.regions.map((region) => {
    const [cssVar, fallback] = RULER[region.kind];
    const color = style.getPropertyValue(cssVar).trim() || fallback;
    const start = Math.max(1, region.result.start);
    const end = region.result.count > 0 ? region.result.start + region.result.count - 1 : start;
    return {
      range: new monaco.Range(start, 1, end, 1),
      options: {
        overviewRuler: { color, position: monaco.editor.OverviewRulerLane.Full },
        minimap: { color, position: monaco.editor.MinimapPosition.Gutter },
      },
    };
  });
}

/** The lines of a span in a color, or a divider where it has none: the place the band lands. */
function lineDecorations(span: LineSpan, classes: string): monaco.editor.IModelDeltaDecoration[] {
  if (span.count > 0) return linesOf(span).map((line) => whole(line, { className: `fm-line ${classes}`, marginClassName: `fm-line ${classes}` }));
  const edge = span.start === 0 ? 'top' : 'bottom';
  const divider = `fm-divider-${edge} ${classes}`;
  return [whole(Math.max(1, span.start), { className: divider, marginClassName: divider })];
}

function linesOf({ start, count }: LineSpan): number[] {
  return Array.from({ length: count }, (_, index) => start + index);
}

function whole(line: number, options: monaco.editor.IModelDecorationOptions): monaco.editor.IModelDeltaDecoration {
  return { range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, ...options } };
}

function onNavChange(current: number, total: number, scroll: boolean): void {
  toolbar.counter.textContent = total === 0 ? 'No changes' : `${current >= 0 ? current + 1 : '–'} / ${total}`;
  left.setActiveChunk(current);
  right.setActiveChunk(current);
  const region = current >= 0 ? model?.regions[current] : undefined;
  if (!editors) return;
  for (const pane of PANES) {
    let collection = active.get(pane);
    if (!collection) active.set(pane, (collection = editors[pane].createDecorationsCollection([])));
    const span = region?.[pane];
    collection.set(span && span.count > 0 ? [{ range: new monaco.Range(span.start, 1, span.start + span.count - 1, 1), options: { isWholeLine: true, className: 'bd-active-chunk' } }] : []);
  }
  if (region && scroll) scrollToRegion(editors, region);
}

function scrollToRegion(eds: Record<Pane, Editor>, region: MergeRegion): void {
  const center = (editor: Editor, span: LineSpan) => {
    const [top, bottom] = sideExtent(editor, span.start, span.count);
    return (top + bottom) / 2 - editor.getLayoutInfo().height / 2;
  };
  leftSync.setScrollTop(eds.ours, center(eds.ours, region.ours));
  leftSync.setScrollTop(eds.result, center(eds.result, region.result));
  rightSync.setScrollTop(eds.theirs, center(eds.theirs, region.theirs));
  redraw();
}

function wireKeys(eds: Record<Pane, Editor>): void {
  for (const pane of PANES) {
    const editor = eds[pane];
    editor.addCommand(monaco.KeyCode.F7, () => navigation.next());
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => navigation.prev());
    // F4: open the file at the line of the result the cursor stands for
    editor.addAction({
      id: 'flowMerge.jumpToSource',
      label: 'Jump to Source',
      keybindings: [monaco.KeyCode.F4],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0,
      run: (ed) => {
        const line = ed.getPosition()?.lineNumber ?? 1;
        if (model) post({ type: 'openAt', line: pane === 'result' ? line : resultLine(model, pane, line) });
      },
    });
  }
}

/** Header labels over [ours | gutter | result | gutter | theirs]. */
function createLayout(container: HTMLElement): Layout {
  container.textContent = '';
  const header = el('div', 'header');
  const body = el('div', 'diff-body');
  const labels = { ours: el('div', 'pane-label fm-label-ours'), result: el('div', 'pane-label fm-result-label'), theirs: el('div', 'pane-label fm-label-theirs') };
  // The toolbar sits in the header of the result: floating over the panes, it would hide the code of the one under it.
  const resultName = el('span', 'fm-result-name');
  labels.result.append(resultName, toolbar.element);
  const hosts = { ours: el('div', 'editor-host'), result: el('div', 'editor-host'), theirs: el('div', 'editor-host') };
  const gutters = { left: el('div', 'gutter'), right: el('div', 'gutter') };
  header.append(labels.ours, el('div', 'gutter-spacer'), labels.result, el('div', 'gutter-spacer'), labels.theirs);
  body.append(hosts.ours, gutters.left, hosts.result, gutters.right, hosts.theirs);
  container.append(header, body);
  return { labels, hosts, gutters, resultName };
}

function createToolbar(): { element: HTMLElement; counter: HTMLElement; conflicts: HTMLElement } {
  const element = el('div', 'toolbar');
  const prev = document.createElement('button');
  prev.textContent = '▲';
  prev.title = 'Previous Change (Shift+F7)';
  prev.addEventListener('click', () => navigation.prev());
  const counter = el('span', 'counter');
  const next = document.createElement('button');
  next.textContent = '▼';
  next.title = 'Next Change (F7)';
  next.addEventListener('click', () => navigation.next());
  const conflicts = el('span', 'fm-conflicts');
  element.append(prev, counter, next, conflicts);
  return { element, counter, conflicts };
}

function el(tag: string, className: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function post(message: MergeWebviewMessage): void {
  vscodeApi.postMessage(message);
}

post({ type: 'ready' });
