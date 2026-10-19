/**
 * The three-way model of a file in conflict, as the Flow Merge page reads it. Must stay free of `vscode` imports and
 * of the diff library: it is bundled into the webview.
 */
import type { CharRange, DiffChunk } from './model';

/** Lines of a file, hunk-header style: from 1, and when `count` is 0 `start` is the line before the place meant. */
export interface LineSpan {
  start: number;
  count: number;
}

/**
 * What a stretch of the base became: changed by one side (`ours`, `theirs`), changed the same way by both (`both`),
 * or changed differently by both (`conflict`), which is what git asks a person to choose for.
 */
export type RegionKind = 'ours' | 'theirs' | 'both' | 'conflict';

/** What the result can be given in place of a region. */
export type Choice = 'ours' | 'theirs' | 'oursThenTheirs' | 'theirsThenOurs' | 'base';

/** What the result has in a region: one of the choices, the markers of git still, or something else typed there. */
export type RegionState = Choice | 'unresolved' | 'edited';

export interface MergeRegion {
  id: number;
  kind: RegionKind;
  base: LineSpan;
  ours: LineSpan;
  theirs: LineSpan;
  /** Where the region is in the result: the file as git wrote it, with what was edited since. */
  result: LineSpan;
  /** The lines of the result that came from ours: between the markers of a conflict still marked, else `result`. */
  resultOurs: LineSpan;
  /** The same for theirs. */
  resultTheirs: LineSpan;
  /** A conflict whose markers are still in the result. */
  unresolved: boolean;
  /** What the result has there. */
  state: RegionState;
}

/** The changed characters of a line of a side, against the base. */
export interface LineHighlight {
  line: number;
  ranges: CharRange[];
}

export interface MergeModel {
  /** The texts of the three panes, with LF line endings. */
  ours: string;
  result: string;
  theirs: string;
  /** The common ancestor, which the regions can be taken back to. */
  base: string;
  regions: MergeRegion[];
  oursHighlights: LineHighlight[];
  theirsHighlights: LineHighlight[];
  /** The lines of the result that are markers of git: `<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`. */
  markerLines: number[];
  languageId: string;
  filePath: string;
  oursLabel: string;
  theirsLabel: string;
  resultLabel: string;
}

/**
 * The line of the result that a line of a pane stands for, for opening the file there: the same line past the
 * regions before it, and the start of the region it is in.
 */
export function resultLine(model: Pick<MergeModel, 'regions'>, pane: 'ours' | 'theirs', line: number): number {
  let shift = 0;
  for (const region of model.regions) {
    const side = region[pane];
    const [from, to] = bounds(side);
    if (line <= from) break;
    if (line <= to) return Math.max(1, bounds(pane === 'ours' ? region.resultOurs : region.resultTheirs)[0] + 1);
    shift = bounds(region.result)[1] - to;
  }
  return Math.max(1, line + shift);
}

/** The chunks of a gutter between two panes, for the connectors, the scroll map and the navigation. */
export function paneChunks(regions: MergeRegion[], left: 'ours' | 'result', right: 'result' | 'theirs', only?: (region: MergeRegion) => boolean): DiffChunk[] {
  const sideOf = (region: MergeRegion, pane: 'ours' | 'result' | 'theirs', other: 'ours' | 'theirs') =>
    pane === 'result' ? (other === 'ours' ? region.resultOurs : region.resultTheirs) : region[pane];
  const other = left === 'ours' ? 'ours' : 'theirs';
  return regions
    .filter((region) => !only || only(region))
    .map((region): DiffChunk => {
      const [l, r] = [sideOf(region, left, other), sideOf(region, right, other)];
      return {
        id: region.id,
        kind: l.count === 0 ? 'added' : r.count === 0 ? 'removed' : 'modified',
        rowStart: 0,
        rowEnd: 0,
        leftStart: l.start,
        leftCount: l.count,
        rightStart: r.start,
        rightCount: r.count,
      };
    });
}

/** The lines a choice puts in place of a region. */
export function choiceLines(model: Pick<MergeModel, 'base' | 'ours' | 'theirs'>, region: MergeRegion, choice: Choice): string[] {
  const of = (pane: 'base' | 'ours' | 'theirs') => lines(model[pane]).slice(...bounds(region[pane]));
  switch (choice) {
    case 'ours':
    case 'theirs':
    case 'base':
      return of(choice);
    case 'oursThenTheirs':
      return [...of('ours'), ...of('theirs')];
    case 'theirsThenOurs':
      return [...of('theirs'), ...of('ours')];
  }
}

/**
 * The text with `replacement` in place of the lines of `at`. A text that does not end with a line break keeps not
 * ending with one.
 */
export function replaceLines(text: string, at: LineSpan, replacement: string[]): string {
  const list = lines(text);
  const [from, to] = bounds(at);
  const next = [...list.slice(0, from), ...replacement, ...list.slice(to)];
  const closed = text === '' || text.endsWith('\n');
  return next.join('\n') + (closed && next.length ? '\n' : '');
}

/**
 * The model once a choice is put in place of a region of the result: the lines of the region are the choice, and
 * what is after it moves by as many lines as the region grew. Done in the page so that it shows the choice at once;
 * the model the host computes again from the file comes after.
 */
export function applyChoice(model: MergeModel, regionId: number, choice: Choice): MergeModel {
  const region = model.regions.find((each) => each.id === regionId);
  if (!region) return model;
  const replacement = choiceLines(model, region, choice);
  const [from, to] = bounds(region.result);
  const shift = replacement.length - (to - from);
  const moved = (at: LineSpan): LineSpan => (bounds(at)[0] >= to ? { start: at.start + shift, count: at.count } : at);
  const chosen = span([from, from + replacement.length]);
  return {
    ...model,
    result: replaceLines(model.result, region.result, replacement),
    regions: model.regions.map((each) =>
      each === region
        ? { ...each, result: chosen, resultOurs: chosen, resultTheirs: chosen, unresolved: false, state: choice }
        : { ...each, result: moved(each.result), resultOurs: moved(each.resultOurs), resultTheirs: moved(each.resultTheirs) },
    ),
    markerLines: model.markerLines.filter((line) => line <= from || line > to).map((line) => (line > to ? line + shift : line)),
  };
}

/** The lines of the result in a region, to tell whether a choice would change them. */
export function resultLines(model: Pick<MergeModel, 'result'>, region: MergeRegion): string[] {
  return lines(model.result).slice(...bounds(region.result));
}

/** The lines of a text without what ends them; the end of the last line does not make one more. */
export function lines(value: string): string[] {
  if (!value) return [];
  return (value.endsWith('\n') ? value.slice(0, -1) : value).split('\n');
}

/** A span as the stretch from 0 it stands for. */
export function bounds({ start, count }: LineSpan): [number, number] {
  const from = count > 0 ? start - 1 : start;
  return [from, from + count];
}

export function span([from, to]: [number, number]): LineSpan {
  const count = to - from;
  return { start: count > 0 ? from + 1 : from, count };
}

