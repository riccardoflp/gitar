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

/** A span as the stretch from 0 it stands for. */
export function bounds({ start, count }: LineSpan): [number, number] {
  const from = count > 0 ? start - 1 : start;
  return [from, from + count];
}

export function span([from, to]: [number, number]): LineSpan {
  const count = to - from;
  return { start: count > 0 ? from + 1 : from, count };
}

