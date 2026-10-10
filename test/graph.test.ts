import { describe, expect, it } from 'vitest';
import { GraphLayout, laneCount } from '../src/shared/graph';

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

  it('draws nothing above a branch tip', () => {
    const [tip] = layout([['tip', 'parent']]);
    expect(tip.top).toEqual([]);
  });
});
