import { WORKTREE, type GraphLine, type GraphRow, type Row } from './protocol';

/**
 * Assigns commits to lanes one row at a time. Feed it commits in an order where
 * children come before their parents (`git log --date-order` or `--topo-order`).
 */
export class GraphLayout {
  /** For each lane, the hash it is waiting to reach, or null when the lane is free. */
  private lanes: (string | null)[] = [];
  private colors: number[] = [];
  /** For each lane, whether it is drawn dashed down to the commit it waits for. */
  private dashed: boolean[] = [];
  private nextColor = 0;

  /** `dashed` for what is not part of the history, the uncommitted changes and the stashes: their line is dashed. */
  next(hash: string, parents: string[], dashed = false): GraphRow {
    const top: GraphLine[] = [];
    const bottom: GraphLine[] = [];

    // The commit goes on a lane of the history that waits for it rather than on the dashed one of a stash, which ends there.
    let col = this.lanes.findIndex((awaited, lane) => awaited === hash && !this.dashed[lane]);
    if (col === -1) col = this.lanes.indexOf(hash);
    const isTip = col === -1;
    if (isTip) col = this.alloc(hash);
    const color = this.colors[col];

    this.lanes.forEach((awaited, lane) => {
      if (awaited === null || (isTip && lane === col)) return;
      const line: GraphLine = { from: lane, to: lane, color: this.colors[lane] };
      if (this.dashed[lane]) line.dashed = true;
      if (awaited === hash) {
        top.push({ ...line, to: col });
        this.lanes[lane] = null;
        this.dashed[lane] = false;
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
        this.dashed[col] = dashed;
        bottom.push(dashed ? { from: col, to: col, color, dashed } : { from: col, to: col, color });
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
    this.dashed[lane] = false;
    return lane;
  }
}

/** The commits a commit reaches among the rows, itself included: its history, as far as it is loaded. */
export function reachedFrom(rows: Pick<Row, 'hash' | 'parents'>[], tip: string): Set<string> {
  const reached = new Set([tip]);
  // Children come before their parents, so one pass down the rows finds them all.
  for (const row of rows) if (reached.has(row.hash)) for (const parent of row.parents) reached.add(parent);
  return reached;
}

/**
 * The commits among the rows that `tip` reaches and `base` does not: what a branch would bring to the one checked
 * out, as a pull request would. Null when `base` is not among the rows, and what it reaches is not known.
 */
export function ownCommits(rows: Pick<Row, 'hash' | 'parents'>[], tip: string, base: string | null): Set<string> | null {
  if (!base || !rows.some((row) => row.hash === base)) return null;
  const own = reachedFrom(rows, tip);
  for (const hash of reachedFrom(rows, base)) own.delete(hash);
  return own;
}

/** A local branch with commits its upstream has not, as far as the last fetch saw. */
export interface Ahead {
  tip: string;
  /** The name of the upstream, `origin/main`, and its commit. */
  upstream: string;
  upstreamTip: string;
  /** How many commits git counts that the branch has and its upstream has not. */
  ahead: number;
}

/**
 * The commits among the rows that a branch has and its upstream has not: what pushing it would send, by hash, with
 * the upstream it would go to. An upstream that is not among the rows is further down than all of them, so that it
 * reaches none of them, unless the graph leaves it out: then the commits of the branch are more than git counts, and
 * which of them are pushed is not known, so none is said to be.
 */
export function unpushedCommits(rows: Pick<Row, 'hash' | 'parents'>[], branches: Ahead[]): Map<string, string> {
  const unpushed = new Map<string, string>();
  const listed = new Set(rows.map((row) => row.hash));
  for (const branch of branches) {
    if (!branch.ahead || !listed.has(branch.tip)) continue;
    // The parents of the last commits loaded are not listed yet: only what is listed is counted.
    const own = new Set([...reachedFrom(rows, branch.tip)].filter((hash) => listed.has(hash)));
    if (listed.has(branch.upstreamTip)) for (const hash of reachedFrom(rows, branch.upstreamTip)) own.delete(hash);
    else if (own.size > branch.ahead) continue;
    for (const hash of own) if (!unpushed.has(hash)) unpushed.set(hash, branch.upstream);
  }
  return unpushed;
}

/** Which parts of the graph cell of a row belong to a history: its commit, and each of its lines on top and at the bottom. */
export interface GraphTrace {
  node: boolean;
  top: boolean[];
  bottom: boolean[];
}

/** The commits among the rows that reach a commit, itself included: the ones made on top of it, as far as they are loaded. */
export function reaching(rows: Pick<Row, 'hash' | 'parents'>[], base: string): Set<string> {
  const found = new Set([base]);
  // Parents come after their children, so one pass up the rows finds them all.
  for (let index = rows.length - 1; index >= 0; index--) {
    if (rows[index].parents.some((parent) => found.has(parent))) found.add(rows[index].hash);
  }
  return found;
}

/**
 * For each row, which parts of its graph cell lead along the history of the commits reached: a line belongs to it when
 * the commit it comes down from does, and so does the parent it goes to. Where two lines run into one lane, the lane
 * belongs to it if either does.
 */
export function traceGraph(rows: Pick<Row, 'hash' | 'graph' | 'parents'>[], reached: ReadonlySet<string>): GraphTrace[] {
  // For each lane, whether what runs down it comes from a commit reached.
  const lit: boolean[] = [];
  return rows.map(({ hash, graph, parents }) => {
    const node = reached.has(hash);
    const top = graph.top.map((line) => !!lit[line.from]);
    // The lines that end at this commit leave their lanes free.
    for (const line of graph.top) if (line.to === graph.col) lit[line.from] = false;
    // The lines that leave the commit go to its parents in their order, after the ones that only pass by.
    let parent = 0;
    const bottom = graph.bottom.map((line) => (line.from === graph.col ? node && reached.has(parents[parent++]) : !!lit[line.from]));
    graph.bottom.forEach((line, index) => {
      if (line.from === graph.col) lit[line.to] = !!lit[line.to] || bottom[index];
    });
    return { node, top, bottom };
  });
}

/**
 * For each row, and each line that comes down into it from above, the row of the tip of the branch that line is the
 * history of: the first commit up the line that has a name, `named` says which, or that nothing comes down to. A
 * line to the other parent of a merge has none, until a named commit is on it: which branch was merged is not known.
 */
export function laneTips(rows: Pick<Row, 'graph'>[], named: (index: number) => boolean): (number | null)[][] {
  // For each lane, the tip of what runs down it.
  const lanes: (number | null)[] = [];
  return rows.map(({ graph }, index) => {
    const above = graph.top.map((line) => lanes[line.from] ?? null);
    // The line it comes down on, the one of its own lane first.
    const into = graph.top.find((line) => line.to === graph.col && line.from === graph.col) ?? graph.top.find((line) => line.to === graph.col);
    const incoming = into ? (lanes[into.from] ?? null) : null;
    const tip = incoming ?? (into && !named(index) ? null : index);
    for (const line of graph.top) if (line.to === graph.col) lanes[line.from] = null;
    let first = true;
    for (const line of graph.bottom) {
      if (line.from !== graph.col) continue;
      if (first) lanes[line.to] = tip;
      // Another lane may already wait for that parent, and keeps what it is.
      else if (lanes[line.to] === undefined) lanes[line.to] = null;
      first = false;
    }
    return above;
  });
}

/** The commits among the rows that a merge brought in: what its other parents reach and its first parent does not. */
export function mergedCommits(rows: Pick<Row, 'hash' | 'parents'>[], merge: string): Set<string> {
  const row = rows.find((candidate) => candidate.hash === merge);
  const merged = new Set<string>();
  if (!row || row.parents.length < 2) return merged;
  const listed = new Set(rows.map((candidate) => candidate.hash));
  const main = reachedFrom(rows, row.parents[0]);
  for (const parent of row.parents.slice(1)) {
    for (const hash of reachedFrom(rows, parent)) if (listed.has(hash) && !main.has(hash)) merged.add(hash);
  }
  return merged;
}

/** The name of the branch a merge brought in, as git writes it in the message of the merge. */
export function mergedBranch(subject: string): string | null {
  const found = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject) ?? /^Merge pull request #\d+ from (\S+)/.exec(subject);
  return found ? found[1] : null;
}

/** A row of the graph, or one that stands for the commits a merge brought in, folded. */
export interface ShownRow extends Row {
  folded?: { merge: string; count: number };
}

/**
 * The rows with the commits the merges in `folded` brought in each put away under one row, and the lines of the graph
 * drawn again for what is left. The folded row goes where the first of its commits was, or under the commits made on
 * top of them when some are further down; a merge whose commits cannot have one row there, with the history they
 * come from above it, stays unfolded. `hiddenBy` says which merge put away each commit.
 */
export function foldMerges(rows: Row[], folded: ReadonlySet<string>): { rows: ShownRow[]; hiddenBy: Map<string, string> } {
  const hiddenBy = new Map<string, string>();
  if (!folded.size) return { rows, hiddenBy };
  const at = new Map(rows.map((row, index) => [row.hash, index]));
  // The row of each merge, before the row at its index.
  const holders = new Map<number, ShownRow[]>();
  for (const row of rows) {
    if (!folded.has(row.hash) || hiddenBy.has(row.hash)) continue;
    const merged = [...mergedCommits(rows, row.hash)].filter((hash) => !hiddenBy.has(hash));
    if (!merged.length) continue;
    const inside = new Set(merged);
    const first = Math.min(...merged.map((hash) => at.get(hash)!));
    let lowestChild = -1;
    rows.forEach((other, index) => {
      if (!inside.has(other.hash) && other.parents.some((parent) => inside.has(parent))) lowestChild = Math.max(lowestChild, index);
    });
    // What the commits come from, in the order of the rows.
    const parents = [...new Set(merged.flatMap((hash) => rows[at.get(hash)!].parents.filter((parent) => !inside.has(parent) && at.has(parent))))];
    parents.sort((one, other) => at.get(one)! - at.get(other)!);
    const place = Math.max(first, lowestChild + 1);
    if (parents.length && place > at.get(parents[0])!) continue;
    for (const hash of merged) hiddenBy.set(hash, row.hash);
    const holder: ShownRow = { ...rows[first], hash: `fold:${row.hash}`, parents, author: '', email: '', subject: '', stash: undefined };
    holder.folded = { merge: row.hash, count: merged.length };
    holders.set(place, [...(holders.get(place) ?? []), holder]);
  }

  const standFor = (hash: string) => (hiddenBy.has(hash) ? `fold:${hiddenBy.get(hash)}` : hash);
  const shown: ShownRow[] = [];
  rows.forEach((row, index) => {
    for (const holder of holders.get(index) ?? []) shown.push({ ...holder, parents: [...new Set(holder.parents.map(standFor))] });
    if (!hiddenBy.has(row.hash)) shown.push({ ...row, parents: [...new Set(row.parents.map(standFor))] });
  });

  const layout = new GraphLayout();
  for (const row of shown) row.graph = layout.next(row.hash, row.parents, row.hash === WORKTREE || row.stash !== undefined);
  return { rows: shown, hiddenBy };
}

export function laneCount(row: GraphRow): number {
  let max = row.col;
  for (const line of row.top) max = Math.max(max, line.from, line.to);
  for (const line of row.bottom) max = Math.max(max, line.from, line.to);
  return max + 1;
}

/** The room a lane takes when there is plenty of it, and the least it is given: closer than that, the lines run together. */
export const LANE_WIDTH = 14;
export const MIN_LANE_WIDTH = 8;
const GRAPH_PADDING = 6;
/** As wide as the graph gets on its own: sixteen lanes at their ease. */
const AUTO_WIDTH = 16 * LANE_WIDTH + GRAPH_PADDING;
/** The most of the list the graph takes on its own, and the most it can be dragged to. */
const AUTO_SHARE = 1 / 3;
const MAX_SHARE = 0.6;

export interface GraphFit {
  /** The width the graph is drawn in. */
  width: number;
  /** The room each lane gets in it. */
  lane: number;
  /** Whether some lanes are left out, past the edge. */
  cut: boolean;
  /** The width at which every lane has all its room: there is nothing to gain past it. */
  natural: number;
}

/**
 * How a graph of so many lanes is drawn in the room it has. `wanted` is the width it was dragged to, or null to let
 * it choose; `available` is the width of the list, or 0 while that is not known. A graph too wide for its room has
 * its lanes drawn closer first, and only then is cut off: the messages beside it matter more than its far end.
 */
export function fitGraph(lanes: number, wanted: number | null, available: number): GraphFit {
  const natural = lanes * LANE_WIDTH + GRAPH_PADDING;
  const share = available > 0 ? available * (wanted === null ? AUTO_SHARE : MAX_SHARE) : Infinity;
  const width = Math.max(LANE_WIDTH + GRAPH_PADDING, Math.round(Math.min(natural, wanted ?? AUTO_WIDTH, share)));
  const lane = Math.max(MIN_LANE_WIDTH, Math.min(LANE_WIDTH, (width - GRAPH_PADDING) / lanes));
  return { width, lane, cut: lanes * lane + GRAPH_PADDING > width + 0.5, natural };
}
