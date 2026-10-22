import { describe, expect, it } from 'vitest';
import { GraphLayout, fitGraph, laneCount } from '../src/shared/graph';

function layout(commits: [hash: string, ...parents: string[]][]) {
  const graph = new GraphLayout();
  return commits.map(([hash, ...parents]) => graph.next(hash, parents));
}

const edges = (lines: { from: number; to: number }[]) => lines.map((line) => `${line.from}>${line.to}`);

describe('GraphLayout', () => {
  it('keeps a linear history in one lane with one color', () => {
    const rows = layout([['c', 'b'], ['b', 'a'], ['a']]);
    expect(rows.map((row) => row.col)).toEqual([0, 0, 0]);
    expect(new Set(rows.map((row) => row.color)).size).toBe(1);
    expect(edges(rows[0].top)).toEqual([]);
    expect(edges(rows[0].bottom)).toEqual(['0>0']);
    expect(edges(rows[1].top)).toEqual(['0>0']);
    expect(edges(rows[2].bottom)).toEqual([]);
  });

  it('opens a lane for a merged branch and closes it at the fork point', () => {
    const [merge, main, feature, base] = layout([['m', 'a', 'b'], ['a', 'c'], ['b', 'c'], ['c']]);

    expect(merge.col).toBe(0);
    expect(edges(merge.bottom)).toEqual(['0>0', '0>1']);

    expect(main.col).toBe(0);
    expect(edges(main.top)).toEqual(['0>0', '1>1']);
    expect(edges(main.bottom)).toEqual(['1>1', '0>0']);

    expect(feature.col).toBe(1);
    expect(feature.color).not.toBe(main.color);
    expect(edges(feature.bottom)).toEqual(['0>0', '1>1']);

    // The branch runs straight down and joins the main lane at the commit it forked from, in its own color.
    expect(base.col).toBe(0);
    expect(edges(base.top)).toEqual(['0>0', '1>0']);
    expect(base.top[1].color).toBe(feature.color);
    expect(base.color).toBe(main.color);
    expect(laneCount(base)).toBe(2);
  });

  it('joins every lane waiting for the same commit', () => {
    const [, , base] = layout([['x', 'base'], ['y', 'base'], ['base']]);
    expect(base.col).toBe(0);
    expect(edges(base.top)).toEqual(['0>0', '1>0']);
  });

  it('reuses a freed lane for the next branch tip', () => {
    const rows = layout([['x', 'base'], ['y', 'base'], ['base', 'root'], ['z', 'root'], ['root']]);
    expect(rows[3].col).toBe(1);
    expect(edges(rows[3].top)).toEqual(['0>0']);
    expect(rows[3].color).not.toBe(rows[1].color);
  });

  it('dashes the line of a stash down to its commit, and keeps that commit on the lane of the history', () => {
    const graph = new GraphLayout();
    const stash = graph.next('stash', ['base'], true);
    const tip = graph.next('tip', ['base']);
    const between = graph.next('other', ['base']);
    const base = graph.next('base', ['root']);
    expect(stash.bottom).toEqual([{ from: 0, to: 0, color: stash.color, dashed: true }]);
    expect(tip.col).toBe(1);
    expect(between.top.find((line) => line.from === 0)?.dashed).toBe(true);
    // The commit goes where its branch is, and the dashed line comes to it.
    expect(base.col).toBe(1);
    expect(base.color).toBe(tip.color);
    expect(base.top.filter((line) => line.dashed).map((line) => `${line.from}>${line.to}`)).toEqual(['0>1']);
    // Below it the line is history again.
    expect(base.bottom.every((line) => !line.dashed)).toBe(true);
    expect(graph.next('root', []).top.every((line) => !line.dashed)).toBe(true);
  });

  it('draws nothing above a branch tip', () => {
    const [tip] = layout([['tip', 'parent']]);
    expect(tip.top).toEqual([]);
  });
});

describe('fitGraph', () => {
  it('gives every lane its room when there is enough of it', () => {
    expect(fitGraph(1, null, 900)).toEqual({ width: 20, lane: 14, cut: false, natural: 20 });
    expect(fitGraph(4, null, 900)).toEqual({ width: 62, lane: 14, cut: false, natural: 62 });
    // Before the list has been measured.
    expect(fitGraph(4, null, 0).width).toBe(62);
  });

  it('draws many lanes closer on its own, and cuts off only what still does not fit', () => {
    // Twenty lanes in the room of sixteen.
    const twenty = fitGraph(20, null, 900);
    expect(twenty).toMatchObject({ width: 230, cut: false, natural: 286 });
    expect(twenty.lane).toBeCloseTo(11.2);
    expect(fitGraph(40, null, 900)).toMatchObject({ width: 230, lane: 8, cut: true });
    // In a list as narrow as the side bar it leaves most of the room to the messages.
    expect(fitGraph(20, null, 300)).toMatchObject({ width: 100, lane: 8, cut: true });
  });

  it('takes the width it was dragged to, between one lane and all of them at their ease', () => {
    expect(fitGraph(20, 100, 900)).toMatchObject({ width: 100, lane: 8, cut: true });
    expect(fitGraph(20, 286, 900)).toEqual({ width: 286, lane: 14, cut: false, natural: 286 });
    expect(fitGraph(20, 5, 900).width).toBe(20);
    // Dragged wide for a history that has few lanes now: the graph does not keep the room empty.
    expect(fitGraph(2, 286, 900)).toEqual({ width: 34, lane: 14, cut: false, natural: 34 });
    // Nor more than the list can spare, however wide it was dragged when the view was larger.
    expect(fitGraph(40, 500, 400).width).toBe(240);
  });
});
