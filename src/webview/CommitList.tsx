import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { fitGraph, laneCount, laneTips, ownCommits, reachedFrom, reaching, traceGraph, type GraphTrace } from '../shared/graph';
import { WORKTREE, type GraphColumn, type GraphRow, type Loading, type PullRequest, type Row } from '../shared/protocol';
import { pullTitle } from '../shared/refs';
import { Icon } from './Icon';
import { Progress } from './Progress';
import { Sash } from './Sash';
import { endDrag, startDrag, type DragSource } from './drag';
import { datePeriods, fullDate, laneColor, relativeTime, shortHash } from './util';
import { post } from './vscode';

export interface Label {
  /** `good`, `bad` and `skipped` are the marks of a bisect in progress. */
  kind: 'head' | 'branch' | 'remote' | 'tag' | 'stash' | 'good' | 'bad' | 'skipped';
  name: string;
  current?: boolean;
  /** For a branch: the folder of the other worktree that has it checked out. */
  worktree?: string;
  /** For a branch: its open pull request, and the name of the branch on GitHub. */
  pull?: { request: PullRequest; branch: string };
}

/** A plain click selects one commit; with Ctrl or Cmd it adds or removes one; with Shift it selects up to the clicked one. */
export type SelectMode = 'single' | 'toggle' | 'range';

interface Props {
  rows: Row[];
  /** What to say in their place when there are none. */
  empty: string;
  hasMore: boolean;
  /** What the extension is reading the commits for, while it does. */
  loading: Loading | null;
  labels: Map<string, Label[]>;
  /** Hashes matching the search, or null when there is no search. */
  matches: string[] | null;
  /** The width the graph was dragged to, or null while it chooses its own. */
  graphWidth: number | null;
  onGraphWidth(width: number | null): void;
  selected: string | null;
  /** The commits selected together, when there is more than one. */
  marked: ReadonlySet<string>;
  /** A new object each time a row should be scrolled into view. */
  reveal: { hash: string } | null;
  onSelect(hash: string, mode: SelectMode): void;
  /** A commit was double-clicked, to see it whole. */
  onOpen(hash: string): void;
  /** What a double click on a label does instead, when it does something of its own: a branch is checked out. */
  labelOpen(label: Label): (() => void) | undefined;
  /** Two lines to a commit: who made it and when go under its message, where a narrow list has the room for them. */
  tall?: boolean;
  onRowMenu(event: MouseEvent, row: Row): void;
  onLabelMenu(event: MouseEvent, label: Label, row: Row): void;
  /** What dragging a row, or one of its labels, carries. Null when it cannot be dragged. */
  dragSource(label: Label | null, row: Row): DragSource | null;
  canDrop(row: Row): boolean;
  onDrop(event: MouseEvent, row: Row): void;
  /** The commit whose history stands out, while the pointer rests on a label here or on a branch beside the graph. */
  traced: string | null;
  /** The pointer came to a label, with its commit, or left it, with null. */
  onTrace(hash: string | null): void;
  /** The commits a branch has that its upstream has not yet, with the upstream they would be pushed to. */
  unpushed: ReadonlyMap<string, string>;
  /** Whether the history of the selected commit stands out, what it comes from and what was made on top of it. */
  traceSelected: boolean;
  /** What is shown of each commit beside its message. */
  columns: GraphColumn[];
  /** The commit checked out, which `Home` goes back to. */
  head: string | null;
  /** Whether a line with the name of a time further back, a day, a week or a month, comes before its first commit. */
  dateSeparators: boolean;
}

const ROW_HEIGHT = 24;
/** With the author and the date under the message, as in the side bar. */
const TALL_ROW_HEIGHT = 42;
/** What names a line of the graph after the tip it comes from: not the marks of a bisect. */
const LANE_NAMES = new Set<Label['kind']>(['head', 'branch', 'remote', 'tag', 'stash']);

/** How many labels a commit shows there, the last of which counts the others when there are more. */
const TALL_LABELS = 3;
const OVERSCAN = 8;
/**
 * How many commits are kept loaded below the last one on screen. Scrolling fast covers a few hundred commits in a
 * second or two, about as long as reading the next ones takes in a large repository: it should never catch up.
 */
const AHEAD = 500;
/** How long the pointer rests on a label before its history stands out, so that passing over labels does not flash the graph. */
const TRACE_DELAY = 150;
/** How long the history stays after the pointer leaves, so that going from one label to the next does not flash it either. */
const UNTRACE_DELAY = 100;
export const LABEL_ICONS = {
  head: 'target',
  branch: 'git-branch',
  remote: 'cloud',
  tag: 'tag',
  stash: 'git-stash',
  good: 'check',
  bad: 'close',
  skipped: 'debug-step-over',
} as const;

interface GraphProps {
  graph: GraphRow;
  width: number;
  height: number;
  /** The room each lane has: less than usual when the graph is squeezed. */
  lane: number;
  /** A dot for a commit, a ring for the uncommitted changes, a square for a stash. */
  node: 'commit' | 'worktree' | 'stash';
  /** While the history of a label stands out: which parts of the cell are in it. The others fade. */
  trace?: GraphTrace;
  /** For a commit not pushed yet, the upstream it would be pushed to: its dot has a ring around it. */
  unpushed?: string;
}

/** Whether Shift is held down, wherever the focus is in the page. */
function useShiftKey(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => setHeld(event.shiftKey);
    const pointer = (event: PointerEvent) => setHeld(event.shiftKey);
    // Let go of while the page had not the focus, it would otherwise stay held.
    const release = () => setHeld(false);
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    window.addEventListener('pointerover', pointer);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', key);
      window.removeEventListener('pointerover', pointer);
      window.removeEventListener('blur', release);
    };
  }, []);
  return held;
}

/**
 * The commit whose history stands out in the graph, from a label or a branch the pointer rests on, and what to call
 * when the pointer comes to one or leaves it.
 */
export function useTrace(): [string | null, (hash: string | null) => void] {
  const [traced, setTraced] = useState<string | null>(null);
  const shown = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const traceLater = useCallback((hash: string | null) => {
    const show = (next: string | null) => {
      shown.current = next;
      setTraced(next);
    };
    clearTimeout(timer.current);
    if (hash && shown.current) show(hash);
    else timer.current = setTimeout(() => show(hash), hash ? TRACE_DELAY : UNTRACE_DELAY);
  }, []);
  return [traced, traceLater];
}

const Graph = memo(function Graph({ graph, width, height, lane, node, trace, unpushed }: GraphProps) {
  const mid = height / 2;
  const laneX = (index: number) => lane / 2 + 3 + index * lane;
  const x = laneX(graph.col);
  // Smaller dots where the lines are close, or they would sit on the lines beside them.
  const radius = lane < 11 ? 3 : 4;
  const nodeClass = trace && !trace.node ? ' faded' : '';
  return (
    <svg className="graph" width={width} height={height} aria-hidden="true">
      {graph.top.map((line, index) => {
        const from = laneX(line.from);
        const to = laneX(line.to);
        const d = from === to ? `M${from} 0V${mid}` : `M${from} 0C${from} ${mid} ${to} 0 ${to} ${mid}`;
        return <path key={`t${index}`} className={trace && !trace.top[index] ? 'faded' : undefined} d={d} stroke={laneColor(line.color)} strokeDasharray={line.dashed ? '3 3' : undefined} />;
      })}
      {graph.bottom.map((line, index) => {
        const from = laneX(line.from);
        const to = laneX(line.to);
        const d =
          from === to
            ? `M${from} ${mid}V${height}`
            : `M${from} ${mid}C${from} ${height} ${to} ${mid} ${to} ${height}`;
        return <path key={`b${index}`} className={trace && !trace.bottom[index] ? 'faded' : undefined} d={d} stroke={laneColor(line.color)} strokeDasharray={line.dashed ? '3 3' : undefined} />;
      })}
      {node === 'worktree' && <circle className={`hollow${nodeClass}`} cx={x} cy={mid} r={radius - 0.5} stroke={laneColor(graph.color)} />}
      {node === 'stash' && (
        <rect className={`hollow${nodeClass}`} x={x - radius + 0.5} y={mid - radius + 0.5} width={radius * 2 - 1} height={radius * 2 - 1} rx={1} stroke={laneColor(graph.color)} />
      )}
      {node === 'commit' && <circle className={nodeClass.trim() || undefined} cx={x} cy={mid} r={radius} fill={laneColor(graph.color)} />}
      {node === 'commit' && unpushed && (
        <circle className={`unpushed${nodeClass}`} cx={x} cy={mid} r={radius + 2.5} stroke={laneColor(graph.color)}>
          <title>{`Not pushed to ${unpushed}`}</title>
        </circle>
      )}
    </svg>
  );
});

interface MarksProps {
  rows: Row[];
  /** How many rows high the list is, the one that says more are loading included. */
  total: number;
  /** How high the list is on the screen, and so its scroll bar. */
  height: number;
  head: string | null;
  selected: string | null;
  matches: ReadonlySet<string> | null;
}

/**
 * Beside the scroll bar, where in the list the commit checked out is, in the color of its line, the one selected,
 * and what a search found. Marks closer than a pixel are one.
 */
const ScrollMarks = memo(function ScrollMarks({ rows, total, height, head, selected, matches }: MarksProps) {
  const at = (index: number) => Math.round(((index + 0.5) / total) * height);
  const found = useMemo(() => {
    const tops = new Set<number>();
    if (matches) rows.forEach((row, index) => matches.has(row.hash) && tops.add(at(index)));
    return [...tops];
  }, [rows, matches, total, height]);
  const headAt = rows.findIndex((row) => row.hash === head);
  const selectedAt = selected === null ? -1 : rows.findIndex((row) => row.hash === selected);
  return (
    <div className="scroll-marks" aria-hidden="true">
      <div style={{ height }}>
        {found.map((top) => (
          <span key={top} className="found" style={{ top }} />
        ))}
        {headAt >= 0 && <span className="head" style={{ top: at(headAt), background: laneColor(rows[headAt].graph.color) }} />}
        {selectedAt >= 0 && <span className="selected" style={{ top: at(selectedAt) }} />}
      </div>
    </div>
  );
});

/** The first row from `start` on, going down or up, that is what is looked for, not counting the one at `start`; -1 when none is. */
function nearest(rows: Row[], start: number, step: number, wanted: (row: Row) => boolean): number {
  for (let index = start + step; index >= 0 && index < rows.length; index += step) if (wanted(rows[index])) return index;
  return -1;
}

/** The open pull request of a branch, on its label: its number, in the color of its checks. A click opens it. */
function PullBadge({ request, branch }: { request: PullRequest; branch: string }) {
  return (
    <span
      className={`pull ${request.checks ?? ''}`}
      role="link"
      title={`${pullTitle(request)}\nClick to open it on GitHub`}
      onClick={(event) => {
        // Not the selection of the commit as well.
        event.stopPropagation();
        post({ type: 'pullRequest', branch });
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Icon name={request.draft ? 'git-pull-request-draft' : 'git-pull-request'} />
      {request.number}
    </span>
  );
}

export function CommitList(props: Props) {
  const { rows, empty, hasMore, loading, labels, matches, selected, marked, reveal, onSelect, onRowMenu, onLabelMenu } = props;
  const { dragSource, canDrop, onDrop, onOpen, labelOpen, tall, traced, onTrace, unpushed, traceSelected, columns } = props;
  const shows = (column: GraphColumn) => columns.includes(column);
  const rowHeight = tall ? TALL_ROW_HEIGHT : ROW_HEIGHT;
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const drag = (label: Label | null, row: Row) => {
    const source = dragSource(label, row);
    return {
      draggable: source !== null,
      onDragStart: (event: DragEvent) => source && startDrag(event, source),
      onDragEnd: () => {
        endDrag();
        setDropTarget(null);
      },
    };
  };
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const element = scroller.current!;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  const lanes = useMemo(() => {
    let most = 1;
    for (const row of rows) most = Math.max(most, laneCount(row.graph));
    return most;
  }, [rows]);
  const fit = fitGraph(lanes, props.graphWidth, width);
  const matchSet = useMemo(() => (matches ? new Set(matches) : null), [matches]);
  const periods = useMemo(() => (props.dateSeparators ? datePeriods(rows) : null), [rows, props.dateSeparators]);
  // The branches whose tips are above the top of the list, on the lines that go on down it.
  const laneName = (row: Row) => labels.get(row.hash)?.find((label) => LANE_NAMES.has(label.kind))?.name ?? row.stash ?? null;
  const tips = useMemo(() => laneTips(rows, (index) => laneName(rows[index]) !== null), [rows, labels]);
  // What the history of the commit traced does not reach fades. Without one, what the selected commit comes from and
  // what was made on top of it stand out, less: it stays while the commits are read.
  const hovered = traced !== null && rows.some((row) => row.hash === traced);
  // With Shift held, only what it would bring to what is checked out.
  const shift = useShiftKey();
  const own = useMemo(() => (hovered && shift ? ownCommits(rows, traced, props.head) : null), [rows, traced, hovered, shift, props.head]);
  const chosen = traceSelected && !hovered && marked.size < 2 && selected !== null && selected !== WORKTREE ? selected : null;
  const trace = useMemo(() => {
    if (hovered) return traceGraph(rows, own?.size ? own : reachedFrom(rows, traced));
    if (!chosen || !rows.some((row) => row.hash === chosen)) return null;
    return traceGraph(rows, new Set([...reachedFrom(rows, chosen), ...reaching(rows, chosen)]));
  }, [rows, traced, hovered, chosen, own]);

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / rowHeight) + OVERSCAN);

  // Ask for the next page once per loaded length, well before the end of the list comes into sight. With small pages
  // one follows the other until there are enough ahead.
  const requestedAt = useRef(0);
  useEffect(() => {
    if (hasMore && end >= rows.length - AHEAD && requestedAt.current !== rows.length) {
      requestedAt.current = rows.length;
      post({ type: 'loadMore' });
    }
  }, [hasMore, end, rows.length]);

  const scrollTo = (index: number, center: boolean) => {
    const element = scroller.current;
    if (!element || index < 0) return;
    const top = index * rowHeight;
    if (center) element.scrollTop = top - element.clientHeight / 2 + rowHeight / 2;
    else if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + rowHeight - element.clientHeight;
    }
  };

  useEffect(() => {
    if (reveal) scrollTo(rows.findIndex((row) => row.hash === reveal.hash), true);
    // Only a new reveal request should move the scroll position, not every refresh of the rows.
  }, [reveal]);

  const first = Math.floor(scrollTop / rowHeight);
  const offscreen: { tip: number; name: string; color: number }[] = [];
  if (first > 0 && first < rows.length) {
    rows[first].graph.top.forEach((line, index) => {
      const tip = tips[first][index];
      const name = tip === null ? null : laneName(rows[tip]);
      if (tip !== null && name && !offscreen.some((other) => other.tip === tip)) offscreen.push({ tip, name, color: line.color });
    });
  }

  const go = (index: number) => {
    if (index < 0) return;
    onSelect(rows[index].hash, 'single');
    scrollTo(index, false);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // Enter does what a double click does.
    if (event.key === 'Enter' && selected && selected !== WORKTREE) return onOpen(selected);
    if (!rows.length) return;
    const current = rows.findIndex((row) => row.hash === selected);
    if (event.key === 'Home' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      return go(rows.findIndex((row) => row.hash === props.head));
    }
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    if (event.altKey && current >= 0) {
      // With Shift, the next merge or the one before; without, the first parent, or the commit made on top of this one:
      // on its line when there is one, or else the merge that took it.
      const row = rows[current];
      if (event.shiftKey) return go(nearest(rows, current, step, (other) => other.parents.length > 1));
      if (step > 0) return go(rows.findIndex((other) => other.hash === row.parents[0]));
      const child = nearest(rows, current, -1, (other) => other.parents[0] === row.hash);
      return go(child >= 0 ? child : nearest(rows, current, -1, (other) => other.parents.includes(row.hash)));
    }
    go(Math.min(rows.length - 1, Math.max(0, current + step)));
  };

  const listClasses = ['commits'];
  if (fit.cut) listClasses.push('cut');
  // The commits of the filter before stay until those of the new one come, but they are no longer what is asked for.
  if (loading === 'filter') listClasses.push('stale');
  if (trace && !hovered) listClasses.push('selection-traced');

  return (
    <div
      className={listClasses.join(' ')}
      ref={scroller}
      tabIndex={0}
      role="listbox"
      aria-label="Commits"
      aria-multiselectable="true"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      {loading && <Progress label={loading === 'more' ? 'Loading more commits' : 'Loading commits'} />}
      {!rows.length && <div className="empty">{loading === 'filter' ? 'Loading commits…' : empty}</div>}
      {/* It stays where it is while the commits scroll under it. */}
      {rows.length > 0 && (
        <div className="graph-edge" style={{ '--graph': `${fit.width}px`, '--list-height': `${height}px` } as CSSProperties}>
          <Sash
            pane="graph"
            width={fit.width}
            // Wider than all of its lanes at their ease, the graph would only be empty.
            onResize={(wanted) => props.onGraphWidth(Math.min(wanted, fit.natural))}
            onReset={() => props.onGraphWidth(null)}
          />
        </div>
      )}
      {rows.length > 0 && height > 0 && (
        <ScrollMarks rows={rows} total={rows.length + (hasMore ? 1 : 0)} height={height} head={props.head} selected={selected} matches={matchSet} />
      )}
      {offscreen.length > 0 && (
        <div className="lane-names" style={{ '--graph': `${fit.width}px` } as CSSProperties}>
          <div>
            {offscreen.map(({ tip, name, color }) => (
              <button
                key={tip}
                className="lane-name"
                style={{ '--lane': laneColor(color) } as CSSProperties}
                title={`Go up to ${name}`}
                onClick={() => {
                  onSelect(rows[tip].hash, 'single');
                  scrollTo(tip, true);
                }}
                onMouseEnter={() => onTrace(rows[tip].hash)}
                onMouseLeave={() => onTrace(null)}
              >
                <Icon name="arrow-up" />
                <span>{name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {/* With more to load, one more row says so at the end, where scrolling gets before they come. */}
      <div className="spacer" style={{ height: (rows.length + (hasMore ? 1 : 0)) * rowHeight }}>
        {rows.slice(start, end).map((row, offset) => {
          const index = start + offset;
          const worktree = row.hash === WORKTREE;
          const classes = tall ? ['row', 'tall'] : ['row'];
          const isSelected = row.hash === selected || marked.has(row.hash);
          if (isSelected) classes.push('selected');
          if (worktree) classes.push('worktree');
          if (row.stash) classes.push('stash');
          if (matchSet && !matchSet.has(row.hash)) classes.push('dimmed');
          if (trace && !trace[index].node) classes.push('unreached');
          if (row.hash === dropTarget) classes.push('drop-target');
          const all = labels.get(row.hash) ?? [];
          // Squeezed side by side, many labels would be left with a letter each: a few keep their names, what is
          // checked out before the others, and the rest are counted.
          const named = tall && all.length > TALL_LABELS ? [...all].sort((one, other) => Number(!!other.current) - Number(!!one.current)).slice(0, TALL_LABELS - 1) : all;
          const counted = all.filter((label) => !named.includes(label));
          const chips = named.map((label) => (
            <span
              key={`${label.kind}:${label.name}`}
              className={`label ${label.kind}${label.current ? ' current' : ''}`}
              title={label.worktree ? `${label.name}\nIn the worktree ${label.worktree}` : label.name}
              onContextMenu={(event) => onLabelMenu(event, label, row)}
              onMouseEnter={() => onTrace(row.hash)}
              onMouseLeave={() => onTrace(null)}
              onDoubleClick={(event) => {
                const open = labelOpen(label);
                if (!open) return;
                // Not the commit's own double click as well.
                event.stopPropagation();
                open();
              }}
              {...drag(label, row)}
            >
              <Icon name={label.worktree ? 'worktree' : LABEL_ICONS[label.kind]} />
              <span className="text">{label.name}</span>
              {label.pull && <PullBadge {...label.pull} />}
            </span>
          ));
          const pushTo = unpushed.get(row.hash);
          if (counted.length) {
            chips.push(
              <span key="more" className="label more" title={counted.map((label) => label.name).join(', ')}>
                +{counted.length}
              </span>,
            );
          }
          return (
            <div
              key={row.hash}
              className={classes.join(' ')}
              style={{ top: index * rowHeight, height: rowHeight }}
              role="option"
              aria-selected={isSelected}
              onClick={(event) => onSelect(row.hash, event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'single')}
              onDoubleClick={worktree ? undefined : () => onOpen(row.hash)}
              onContextMenu={(event) => onRowMenu(event, row)}
              {...drag(null, row)}
              onDragOver={(event) => {
                if (!canDrop(row)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                setDropTarget(row.hash);
              }}
              onDragLeave={() => setDropTarget((current) => (current === row.hash ? null : current))}
              onDrop={(event) => {
                setDropTarget(null);
                onDrop(event, row);
                endDrag();
              }}
            >
              {periods?.has(index) && (
                <span className="period" style={{ left: fit.width }}>
                  <span>{periods.get(index)}</span>
                </span>
              )}
              <Graph graph={row.graph} width={fit.width} height={rowHeight} lane={fit.lane} node={worktree ? 'worktree' : row.stash ? 'stash' : 'commit'} trace={trace?.[index]} unpushed={pushTo} />
              {tall ? (
                <div className="lines">
                  <span className="subject">{row.subject}</span>
                  {/* Under the message the labels have the room to keep their names. */}
                  <div className="message" style={{ '--lane': laneColor(row.graph.color) } as CSSProperties}>
                    {chips}
                    {worktree ? (
                      <span className="who">Not committed yet</span>
                    ) : (
                      <>
                        {shows('author') && <span className="who">{row.author}</span>}
                        {shows('date') && (
                          <span className="when" title={fullDate(row.date)}>
                            {relativeTime(row.date)}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div className="message" style={{ '--lane': laneColor(row.graph.color) } as CSSProperties}>
                  {chips}
                  <span className="subject">{row.subject}</span>
                </div>
              )}
              {!worktree && !tall && (
                <>
                  {shows('author') && <div className="author">{row.author}</div>}
                  {shows('date') && (
                    <div className="date" title={fullDate(row.date)}>
                      {relativeTime(row.date)}
                    </div>
                  )}
                  {shows('hash') && <div className="hash">{shortHash(row.hash)}</div>}
                </>
              )}
            </div>
          );
        })}
        {hasMore && rows.length > 0 && (
          <div className="row more" style={{ top: rows.length * rowHeight, height: rowHeight }} aria-hidden="true">
            <Icon name="loading" spin />
            Loading more commits…
          </div>
        )}
      </div>
    </div>
  );
}
