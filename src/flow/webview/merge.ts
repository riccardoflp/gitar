import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import { applyReplacements } from '../../git/conflicts';
import type { DiffChunk } from '../diff/model';
import {
  applyChoices,
  baseChunks,
  type Choice,
  choiceLines,
  type LineHighlight,
  type LineSpan,
  type MergeModel,
  type MergeRegion,
  paneChunks,
  resultLine,
  resultLines,
  simpleChoices,
} from '../diff/mergeModel';
import type { MergeHostMessage, MergeSettings, MergeWebviewMessage } from '../diff/mergeProtocol';
import type { SyntaxTheme } from '../diff/protocol';
import { minimalReplace, offsetToPosition } from '../diff/textEdit';
import { Columns } from './columns';
import { type ChunkActionsConfig, Connectors } from './connectors';
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
type Pane = 'base' | 'ours' | 'result' | 'theirs';

/** What the page keeps of itself while it is hidden or reloaded. */
interface PageState {
  showBase?: boolean;
  /** The widths of the columns, as they were dragged. */
  widths?: number[];
}

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): PageState | undefined; setState(state: PageState): void };

const vscodeApi = acquireVsCodeApi();
const root = document.getElementById('app') as HTMLElement;
setupMonacoEnvironment(root.dataset.worker ?? '');

interface Layout {
  labels: Record<Pane, HTMLElement>;
  hosts: Record<Pane, HTMLElement>;
  gutters: { base: HTMLElement; left: HTMLElement; right: HTMLElement };
  resultName: HTMLElement;
}

const BASE_LABEL = 'Base — What the two sides started from';
let showBase = vscodeApi.getState()?.showBase ?? false;

function keep(state: PageState): void {
  vscodeApi.setState({ ...vscodeApi.getState(), ...state });
}

let model: MergeModel | undefined;
let layout: Layout | undefined;
let editors: Record<Pane, Editor> | undefined;
const decorations = new Map<Pane, monaco.editor.IEditorDecorationsCollection>();
const active = new Map<Pane, monaco.editor.IEditorDecorationsCollection>();

// The result is the file: what is typed in it goes to the host a moment later, which puts it in the file and sends
// the model again. Text set from the host is not sent back, and keystrokes still on their way are not overwritten.
let applyingRemote = false;
let localDirty = false;
let editTimer: number | undefined;
/** A choice clicked while what was typed was on its way: made once the model of that text is back. */
let pending: (() => void) | undefined;

/**
 * The buttons of the bands: each puts one side, or both, in place of the region in the result, or what the rules or
 * the language model propose for it.
 */
type ChoiceAction = 'acceptOurs' | 'acceptTheirs' | 'acceptOursThenTheirs' | 'acceptTheirsThenOurs';
type MergeAction = ChoiceAction | 'acceptProposal';
const CHOICES: Record<ChoiceAction, Choice> = {
  acceptOurs: 'ours',
  acceptTheirs: 'theirs',
  acceptOursThenTheirs: 'oursThenTheirs',
  acceptTheirsThenOurs: 'theirsThenOurs',
};
const GLYPHS: Record<MergeAction, { glyph: string; title: string }> = {
  acceptOurs: { glyph: '→', title: 'Accept Current' },
  acceptTheirs: { glyph: '←', title: 'Accept Incoming' },
  acceptOursThenTheirs: { glyph: '+', title: 'Accept Both, Current First' },
  acceptTheirsThenOurs: { glyph: '+', title: 'Accept Both, Incoming First' },
  acceptProposal: { glyph: '✦', title: 'Accept the Proposal' },
};

const left = new Connectors<MergeAction>();
const right = new Connectors<MergeAction>();
const baseBands = new Connectors();
const redraw = () => {
  left.schedule();
  right.schedule();
  baseBands.schedule();
};
// The result is the hub: each side scrolls with it, and so with the other side through it. The base, when it is
// shown, scrolls with the current side.
const leftSync = new ScrollSync(redraw);
const rightSync = new ScrollSync(redraw);
const baseSync = new ScrollSync(redraw);
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
        applyPaneOptions(editors.base, message.options, 'reference', true);
        applyPaneOptions(editors.ours, message.options, 'reference', true);
        applyPaneOptions(editors.result, message.options, 'main', false);
        applyPaneOptions(editors.theirs, message.options, 'reference', true);
        redraw();
      }
      break;
  }
});

async function onInit(m: MergeModel, settings: MergeSettings, theme: SyntaxTheme | undefined): Promise<void> {
  layout = createLayout(root);
  const { labels, hosts, gutters } = layout;
  new Columns(
    (['base', 'ours', 'result', 'theirs'] as const).map((pane) => ({ host: hosts[pane], label: labels[pane] })),
    [gutters.base, gutters.left, gutters.right],
    vscodeApi.getState()?.widths,
    (widths, done) => {
      redraw();
      if (done) keep({ widths });
    },
  );
  const user = settings.editorOptions ?? {};
  root.classList.toggle('fm-with-base', showBase);
  editors = {
    base: createPane(layout.hosts.base, user, 'reference'),
    ours: createPane(layout.hosts.ours, user, 'reference'),
    result: createPane(layout.hosts.result, user, 'main'),
    theirs: createPane(layout.hosts.theirs, user, 'reference'),
  };
  const { monacoLanguage } = await initHighlighting(monaco, theme, m.languageId);
  const eds = editors;
  remote(() => {
    for (const pane of PANES) eds[pane].setModel(monaco.editor.createModel(m[pane], monacoLanguage));
  });
  wireEditing(eds.result);
  wireKeys(eds);
  refreshAll(m);
}

function onUpdate(m: MergeModel): void {
  if (!editors) return;
  const eds = editors;
  remote(() => {
    for (const pane of ['base', 'ours', 'theirs'] as const) if (eds[pane].getValue() !== m[pane]) eds[pane].setValue(m[pane]);
    const typed = eds.result.getValue();
    // The same text: the file has what was typed. Another, with nothing typed on its way: the file changed elsewhere.
    if (typed === m.result) localDirty = false;
    else if (!localDirty && editTimer === undefined) eds.result.setValue(m.result);
  });
  // The model of a text older than the one in the pane would put its bands in the wrong places: the next one is coming.
  if (eds.result.getValue() !== m.result) return;
  refreshAll(m);
  const waiting = pending;
  pending = undefined;
  waiting?.();
}

function remote(run: () => void): void {
  applyingRemote = true;
  try {
    run();
  } finally {
    applyingRemote = false;
  }
}

function wireEditing(result: Editor): void {
  result.onDidChangeModelContent(() => {
    if (applyingRemote) return;
    localDirty = true;
    if (editTimer !== undefined) clearTimeout(editTimer);
    editTimer = window.setTimeout(postEdit, 200);
  });
}

function postEdit(): void {
  if (editTimer !== undefined) clearTimeout(editTimer);
  editTimer = undefined;
  if (!editors) return;
  const text = editors.result.getValue();
  // Typed and taken back: the file has it already, and no model will come back to say so.
  if (text === model?.result) localDirty = false;
  else post({ type: 'edit', text });
}

/** Puts a choice in place of a region of the result. */
function choose(regionId: number, choice: Choice): void {
  whenCurrent(() => apply([{ regionId, choice }]), () => choose(regionId, choice));
}

/** Puts every choice that needs no one to make it in the result, as one step that Ctrl+Z takes back. */
function acceptSimple(): void {
  whenCurrent(() => model && apply(simpleChoices(model)), acceptSimple);
}

/**
 * Runs what puts choices in the result once the model is that of the text in the pane. Typed and not yet back as a
 * model, the regions are not where they were: what was typed goes to the host now, and `later` runs with its model.
 */
function whenCurrent(now: () => void, later: () => void): void {
  if (!editors || !model) return;
  if (editors.result.getValue() === model.result) {
    now();
    return;
  }
  pending = later;
  postEdit();
}

/**
 * Puts choices in place of their regions, as one edit of the pane that Ctrl+Z takes back. The model is moved along
 * at once, and the text goes to the host without waiting.
 */
function apply(choices: { regionId: number; choice: Choice }[]): void {
  if (!editors || !model || choices.length === 0) return;
  const next = applyChoices(model, choices);
  if (replaceResult(next.result)) refreshAll(next);
}

/** What is proposed for a region still marked, if anything. */
const proposalOf = (regionId: number) => model?.proposals?.find((each) => each.region === regionId && model?.regions[regionId]?.unresolved)?.proposal;

/**
 * Puts what is proposed in place of these conflicts, or of all of them, as one edit that Ctrl+Z takes back. The host
 * sends the model of the new text, with the regions where they now are.
 */
function acceptProposals(regionIds?: number[]): void {
  whenCurrent(
    () => {
      const chosen = (model?.proposals ?? []).filter((each) => (!regionIds || regionIds.includes(each.region)) && proposalOf(each.region));
      if (editors && chosen.length) replaceResult(applyReplacements(editors.result.getValue(), chosen.map((each) => each.proposal)));
    },
    () => acceptProposals(regionIds),
  );
}

/** Makes the result this text, as one edit of the pane, and sends it to the host. Whether it changed. */
function replaceResult(next: string): boolean {
  if (!editors) return false;
  const editor = editors.result;
  const before = editor.getValue();
  const change = minimalReplace(before, next);
  if (!change) return false;
  const [start, end] = [offsetToPosition(before, change.start), offsetToPosition(before, change.end)];
  editor.pushUndoStop();
  editor.executeEdits('flowMerge', [{ range: new monaco.Range(start.line + 1, start.character + 1, end.line + 1, end.character + 1), text: change.text }]);
  editor.pushUndoStop();
  postEdit();
  return true;
}

/**
 * The buttons of the bands of a side: its choices that would change what the result has in the region, and on the
 * side of the current one what is proposed for a conflict still marked.
 */
function bandActions(side: 'ours' | 'theirs'): ChunkActionsConfig<MergeAction> {
  const offered: ChoiceAction[] = side === 'ours' ? ['acceptOurs', 'acceptOursThenTheirs'] : ['acceptTheirs', 'acceptTheirsThenOurs'];
  return {
    glyphs: GLYPHS,
    kindsFor: (chunk) => {
      const m = model;
      const region = m?.regions[chunk.id];
      if (!m || !region) return [];
      const now = resultLines(m, region);
      const same = (other: string[]) => other.length === now.length && other.every((line, index) => line === now[index]);
      // Both sides together only where they differ: elsewhere it would be the same lines twice.
      const choices: MergeAction[] = offered.filter(
        (action) => (region.kind === 'conflict' || CHOICES[action] === side) && !same(choiceLines(m, region, CHOICES[action])),
      );
      return side === 'ours' && proposalOf(region.id) ? ['acceptProposal', ...choices] : choices;
    },
    onAction: (action, regionId) => (action === 'acceptProposal' ? acceptProposals([regionId]) : choose(regionId, CHOICES[action])),
    titleFor: (action, chunk) => {
      const proposal = action === 'acceptProposal' ? proposalOf(chunk.id) : undefined;
      if (!proposal) return undefined;
      const from = proposal.source === 'ai' ? `of ${proposal.model ?? 'the AI'}${proposal.confidence ? `, with ${proposal.confidence} confidence` : ''}` : 'of the Rules';
      const count = proposal.newLines;
      const fresh = count ? ` ${count === 1 ? 'One line is new: neither side has it.' : `${count} lines are new: neither side has them.`}` : '';
      return `Accept the Proposal ${from} — ${proposal.reason}${fresh}`;
    },
  };
}

const PANES: Pane[] = ['base', 'ours', 'result', 'theirs'];

function refreshAll(m: MergeModel): void {
  model = m;
  if (!editors || !layout) return;
  layout.labels.base.textContent = BASE_LABEL;
  layout.labels.base.title = BASE_LABEL;
  layout.labels.ours.textContent = m.oursLabel;
  layout.resultName.textContent = `${m.filePath} — ${m.resultLabel}`;
  layout.labels.theirs.textContent = m.theirsLabel;
  layout.labels.ours.title = m.oursLabel;
  layout.labels.theirs.title = m.theirsLabel;
  setDecorations(m);

  // Every region anchors the scroll; the bands of a gutter are the changes of its own side.
  leftSync.attach(editors.ours, editors.result, { chunks: paneChunks(m.regions, 'ours', 'result') });
  rightSync.attach(editors.result, editors.theirs, { chunks: paneChunks(m.regions, 'result', 'theirs') });
  // Hidden, the base has no height: following it would pull the current side to its top.
  if (showBase) baseSync.attach(editors.base, editors.ours, { chunks: baseChunks(m.regions) });
  else baseSync.detach();
  const band = (chunk: DiffChunk) => bandClasses(m.regions[chunk.id]);
  left.attach(layout.gutters.left, editors.ours, editors.result, { chunks: paneChunks(m.regions, 'ours', 'result', (region) => region.kind !== 'theirs') }, bandActions('ours'), band);
  right.attach(layout.gutters.right, editors.result, editors.theirs, { chunks: paneChunks(m.regions, 'result', 'theirs', (region) => region.kind !== 'ours') }, bandActions('theirs'), band);
  baseBands.attach(layout.gutters.base, editors.base, editors.ours, { chunks: baseChunks(m.regions, (region) => region.kind !== 'theirs') }, undefined, band);
  navigation.setModel({ chunks: paneChunks(m.regions, 'ours', 'result') });

  const open = m.regions.filter((region) => region.unresolved).length;
  const conflicts = m.regions.filter((region) => region.kind === 'conflict').length;
  toolbar.conflicts.textContent =
    open > 0 ? `${open} ${open === 1 ? 'conflict' : 'conflicts'} left` : conflicts > 0 ? 'No conflicts left' : 'No conflicts';
  toolbar.conflicts.classList.toggle('done', open === 0);
  const proposed = (m.proposals ?? []).filter((each) => m.regions[each.region]?.unresolved);
  const fromAI = proposed.filter((each) => each.proposal.source === 'ai').length;
  const which = proposed.length === 1 ? 'the conflict' : `the ${proposed.length} conflicts`;
  const by = fromAI === 0 ? 'by the rules' : fromAI === proposed.length ? 'by the AI' : `${fromAI} of them by the AI`;
  toolbar.proposals.hidden = !m.proposals?.length;
  toolbar.proposals.disabled = proposed.length === 0;
  toolbar.proposals.title = proposed.length === 0 ? 'Nothing is proposed for the conflicts left' : `Accept what is proposed for ${which}, ${by}`;
  const simple = simpleChoices(m).length;
  toolbar.simple.disabled = simple === 0;
  toolbar.simple.title =
    simple === 0 ? 'No changes to accept without a choice' : `Accept ${simple === 1 ? 'the change' : `the ${simple} changes`} that need no choice: of one side, or the same on both`;
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
  // The base is what every region changed.
  set('base', m.regions.flatMap((region) => lineDecorations(region.base, `fm-${region.kind}`)));
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
  baseBands.setActiveChunk(current);
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
  if (showBase) baseSync.setScrollTop(eds.base, center(eds.base, region.base));
  leftSync.setScrollTop(eds.ours, center(eds.ours, region.ours));
  leftSync.setScrollTop(eds.result, center(eds.result, region.result));
  rightSync.setScrollTop(eds.theirs, center(eds.theirs, region.theirs));
  redraw();
}

function wireKeys(eds: Record<Pane, Editor>): void {
  // Ctrl+S in the result: what was typed goes to the file first, then the file is saved.
  eds.result.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    if (editTimer !== undefined) postEdit();
    post({ type: 'saveFile' });
  });
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
  const labels = {
    base: el('div', 'pane-label fm-base fm-label-base'),
    ours: el('div', 'pane-label fm-label-ours'),
    result: el('div', 'pane-label fm-result-label'),
    theirs: el('div', 'pane-label fm-label-theirs'),
  };
  // The toolbar sits in the header of the result: floating over the panes, it would hide the code of the one under it.
  const resultName = el('span', 'fm-result-name');
  labels.result.append(resultName, toolbar.element);
  const hosts = { base: el('div', 'editor-host fm-base'), ours: el('div', 'editor-host'), result: el('div', 'editor-host fm-result-host'), theirs: el('div', 'editor-host') };
  const gutters = { base: el('div', 'gutter fm-base'), left: el('div', 'gutter'), right: el('div', 'gutter') };
  // Over the bottom of the result, as in the merge editor of VS Code.
  hosts.result.append(toolbar.resolve);
  header.append(labels.base, el('div', 'gutter-spacer fm-base'), labels.ours, el('div', 'gutter-spacer'), labels.result, el('div', 'gutter-spacer'), labels.theirs);
  body.append(hosts.base, gutters.base, hosts.ours, gutters.left, hosts.result, gutters.right, hosts.theirs);
  container.append(header, body);
  return { labels, hosts, gutters, resultName };
}

function createToolbar(): {
  element: HTMLElement;
  counter: HTMLElement;
  conflicts: HTMLElement;
  simple: HTMLButtonElement;
  proposals: HTMLButtonElement;
  base: HTMLButtonElement;
  resolve: HTMLButtonElement;
} {
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
  const simple = iconButton('check-all', 'fm-accept-simple');
  simple.addEventListener('click', acceptSimple);
  const proposals = iconButton('sparkle', 'fm-accept-proposals');
  proposals.hidden = true;
  proposals.addEventListener('click', () => acceptProposals());
  const base = iconButton('history', 'fm-toggle-base');
  base.title = showBase ? 'Hide the Base' : 'Show the Base';
  base.classList.toggle('toggled', showBase);
  base.addEventListener('click', () => toggleBase(base));
  element.append(prev, counter, next, conflicts, simple, proposals, base);
  const resolve = document.createElement('button');
  resolve.className = 'fm-resolve';
  resolve.textContent = 'Mark as Resolved';
  resolve.title = 'Save the file and stage it, which tells git that its conflicts are resolved';
  resolve.addEventListener('click', () => {
    // What was typed goes first: the host saves what the file has when this gets there.
    if (editTimer !== undefined) postEdit();
    post({ type: 'markResolved' });
  });
  return { element, counter, conflicts, simple, proposals, base, resolve };
}

function iconButton(icon: string, className: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = className;
  button.innerHTML = `<span class="codicon codicon-${icon}"></span>`;
  return button;
}

/** Shows or hides the column of the base, at the left of the current side. */
function toggleBase(button: HTMLButtonElement): void {
  showBase = !showBase;
  keep({ showBase });
  root.classList.toggle('fm-with-base', showBase);
  button.classList.toggle('toggled', showBase);
  button.title = showBase ? 'Hide the Base' : 'Show the Base';
  if (model) refreshAll(model);
  // Once it has its size, the base comes to where the current side is.
  if (showBase && editors) {
    const eds = editors;
    requestAnimationFrame(() => {
      eds.base.layout();
      baseSync.alignTo(eds.ours);
    });
  }
  redraw();
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
