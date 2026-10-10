import type { GraphLine, GraphRow } from './protocol';

/**
 * Assigns commits to lanes one row at a time. Feed it commits in an order where
 * children come before their parents (`git log --date-order` or `--topo-order`).
 */
export class GraphLayout {
  /** For each lane, the hash it is waiting to reach, or null when the lane is free. */
  private lanes: (string | null)[] = [];
  private colors: number[] = [];
  private nextColor = 0;

  next(hash: string, parents: string[]): GraphRow {
    const top: GraphLine[] = [];
    const bottom: GraphLine[] = [];

    let col = this.lanes.indexOf(hash);
    const isTip = col === -1;
    if (isTip) col = this.alloc(hash);
    const color = this.colors[col];

    this.lanes.forEach((awaited, lane) => {
      if (awaited === null || (isTip && lane === col)) return;
      const line = { from: lane, to: lane, color: this.colors[lane] };
      if (awaited === hash) {
        top.push({ ...line, to: col });
        this.lanes[lane] = null;
      } else {
        top.push(line);
        bottom.push(line);
      }
    });
    this.lanes[col] = null;

    parents.forEach((parent, index) => {
      if (index === 0) {
        // The first parent continues straight down, even if another lane already waits for it:
        // the two lanes join at the parent's row, so a branch visibly forks from its base commit.
        this.lanes[col] = parent;
        bottom.push({ from: col, to: col, color });
        return;
      }
      let lane = this.lanes.indexOf(parent);
      if (lane === -1) lane = this.alloc(parent);
      bottom.push({ from: col, to: lane, color: this.colors[lane] });
    });

    while (this.lanes.length && this.lanes[this.lanes.length - 1] === null) this.lanes.pop();
    return { col, color, top, bottom };
  }

  private alloc(hash: string): number {
    let lane = this.lanes.indexOf(null);
    if (lane === -1) lane = this.lanes.length;
    this.lanes[lane] = hash;
    this.colors[lane] = this.nextColor++;
    return lane;
  }
}

export function laneCount(row: GraphRow): number {
  let max = row.col;
  for (const line of row.top) max = Math.max(max, line.from, line.to);
  for (const line of row.bottom) max = Math.max(max, line.from, line.to);
  return max + 1;
}
