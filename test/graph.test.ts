import { describe, expect, it } from 'vitest';
import { GraphLayout, fitGraph, laneCount, reachedFrom, reaching, traceGraph, unpushedCommits } from '../src/shared/graph';

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

describe('traceGraph', () => {
  function rows(commits: [hash: string, ...parents: string[]][]) {
    const graph = new GraphLayout();
    return commits.map(([hash, ...parents]) => ({ hash, parents, graph: graph.next(hash, parents) }));
  }

  it('reaches the parents of a commit down the rows, and nothing above it', () => {
    const listed = rows([['m', 'a', 'b'], ['a', 'c'], ['b', 'c'], ['c']]);
    expect([...reachedFrom(listed, 'b')].sort()).toEqual(['b', 'c']);
    expect([...reachedFrom(listed, 'm')].sort()).toEqual(['a', 'b', 'c', 'm']);
  });

  it('lights the lines of a branch down to where it forks, and the main line only from there', () => {
    // main: d - a - c, feature: b - c, both tips shown.
    const listed = rows([['d', 'a'], ['a', 'c'], ['b', 'c'], ['c']]);
    const [tip, main, feature, base] = traceGraph(listed, reachedFrom(listed, 'b'));

    expect(tip).toEqual({ node: false, top: [], bottom: [false] });
    expect(main.node).toBe(false);
    expect(main.bottom).toEqual([false]);
    // The branch starts on its own lane, the main line still passing beside it.
    expect(feature.node).toBe(true);
    expect(edges(listed[2].graph.bottom)).toEqual(['0>0', '1>1']);
    expect(feature.bottom).toEqual([false, true]);
    // At the fork point the main line arrives unlit and the branch lit; below it, all is history.
    expect(edges(listed[3].graph.top)).toEqual(['0>0', '1>0']);
    expect(base).toEqual({ node: true, top: [false, true], bottom: [] });
  });

  it('lights a merged branch from the merge down', () => {
    const listed = rows([['m', 'a', 'b'], ['a', 'c'], ['b', 'c'], ['c']]);
    const traced = traceGraph(listed, reachedFrom(listed, 'm'));
    expect(traced.every((row) => row.node && row.top.every(Boolean) && row.bottom.every(Boolean))).toBe(true);
  });

  it('finds the commits made on top of a commit up the rows, and nothing below it', () => {
    const listed = rows([['d', 'm'], ['m', 'a', 'b'], ['a', 'c'], ['b', 'c'], ['c']]);
    expect([...reaching(listed, 'b')].sort()).toEqual(['b', 'd', 'm']);
    expect([...reaching(listed, 'c')].sort()).toEqual(['a', 'b', 'c', 'd', 'm']);
  });

  it('lights the line from a merge to the branch it merged, and not the one to its other parent', () => {
    const listed = rows([['m', 'a', 'b'], ['a', 'c'], ['b', 'c'], ['c']]);
    const [merge, main, feature, base] = traceGraph(listed, new Set([...reachedFrom(listed, 'b'), ...reaching(listed, 'b')]));
    expect(edges(listed[0].graph.bottom)).toEqual(['0>0', '0>1']);
    expect(merge).toEqual({ node: true, top: [], bottom: [false, true] });
    expect(main.node).toBe(false);
    expect(main.bottom.every((lit, index) => lit === (listed[1].graph.bottom[index].from === 1))).toBe(true);
    expect(feature.node).toBe(true);
    expect(base.node).toBe(true);
    expect(base.top).toEqual(listed[3].graph.top.map((line) => line.from === 1));
  });
});

describe('unpushedCommits', () => {
  const commits = (list: [hash: string, ...parents: string[]][]) => list.map(([hash, ...parents]) => ({ hash, parents }));
  // main has two commits of its own over origin/main, which has one main has not.
  const listed = commits([['m2', 'm1'], ['o1', 'base'], ['m1', 'base'], ['base', 'root'], ['root']]);
  const main = { tip: 'm2', upstream: 'origin/main', upstreamTip: 'o1', ahead: 2 };

  it('says which commits a branch has that its upstream has not', () => {
    expect(unpushedCommits(listed, [main])).toEqual(new Map([['m2', 'origin/main'], ['m1', 'origin/main']]));
    expect(unpushedCommits(listed, [{ ...main, ahead: 0 }])).toEqual(new Map());
  });

  it('takes every commit of the branch for unpushed when its upstream is further down than those loaded', () => {
    const loaded = listed.slice(0, 3).filter((row) => row.hash !== 'o1');
    expect([...unpushedCommits(loaded, [{ ...main, upstreamTip: 'base' }]).keys()]).toEqual(['m2', 'm1']);
  });

  it('says nothing when the graph leaves the upstream out and the commits of the branch are more than git counts', () => {
    const local = listed.filter((row) => row.hash !== 'o1');
    expect(unpushedCommits(local, [main])).toEqual(new Map());
  });
});
