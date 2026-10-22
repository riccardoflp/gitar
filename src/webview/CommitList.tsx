import {
  memo,
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
import { fitGraph, laneCount } from '../shared/graph';
import { WORKTREE, type GraphRow, type Loading, type Row } from '../shared/protocol';
import { Icon } from './Icon';
import { Progress } from './Progress';
import { Sash } from './Sash';
import { endDrag, startDrag, type DragSource } from './drag';
import { fullDate, laneColor, relativeTime, shortHash } from './util';
import { post } from './vscode';

export interface Label {
  /** `good`, `bad` and `skipped` are the marks of a bisect in progress. */
  kind: 'head' | 'branch' | 'remote' | 'tag' | 'stash' | 'good' | 'bad' | 'skipped';
  name: string;
  current?: boolean;
  /** For a branch: the folder of the other worktree that has it checked out. */
  worktree?: string;
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
}

const ROW_HEIGHT = 24;
/** With the author and the date under the message, as in the side bar. */
const TALL_ROW_HEIGHT = 42;
/** How many labels a commit shows there, the last of which counts the others when there are more. */
const TALL_LABELS = 3;
const OVERSCAN = 8;
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
}

const Graph = memo(function Graph({ graph, width, height, lane, node }: GraphProps) {
  const mid = height / 2;
  const laneX = (index: number) => lane / 2 + 3 + index * lane;
  const x = laneX(graph.col);
  // Smaller dots where the lines are close, or they would sit on the lines beside them.
  const radius = lane < 11 ? 3 : 4;
  return (
    <svg className="graph" width={width} height={height} aria-hidden="true">
      {graph.top.map((line, index) => {
        const from = laneX(line.from);
        const to = laneX(line.to);
        const d = from === to ? `M${from} 0V${mid}` : `M${from} 0C${from} ${mid} ${to} 0 ${to} ${mid}`;
        return <path key={`t${index}`} d={d} stroke={laneColor(line.color)} strokeDasharray={line.dashed ? '3 3' : undefined} />;
      })}
      {graph.bottom.map((line, index) => {
        const from = laneX(line.from);
        const to = laneX(line.to);
        const d =
          from === to
            ? `M${from} ${mid}V${height}`
            : `M${from} ${mid}C${from} ${height} ${to} ${mid} ${to} ${height}`;
        return <path key={`b${index}`} d={d} stroke={laneColor(line.color)} strokeDasharray={line.dashed ? '3 3' : undefined} />;
      })}
      {node === 'worktree' && <circle className="hollow" cx={x} cy={mid} r={radius - 0.5} stroke={laneColor(graph.color)} />}
      {node === 'stash' && (
        <rect className="hollow" x={x - radius + 0.5} y={mid - radius + 0.5} width={radius * 2 - 1} height={radius * 2 - 1} rx={1} stroke={laneColor(graph.color)} />
      )}
      {node === 'commit' && <circle cx={x} cy={mid} r={radius} fill={laneColor(graph.color)} />}
    </svg>
  );
});

export function CommitList(props: Props) {
  const { rows, empty, hasMore, loading, labels, matches, selected, marked, reveal, onSelect, onRowMenu, onLabelMenu } = props;
  const { dragSource, canDrop, onDrop, onOpen, labelOpen, tall } = props;
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

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / rowHeight) + OVERSCAN);

  // Ask for the next page once per loaded length, when the end of the list gets close.
  const requestedAt = useRef(0);
  useEffect(() => {
    if (hasMore && end >= rows.length - 50 && requestedAt.current !== rows.length) {
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

  const onKeyDown = (event: KeyboardEvent) => {
    // Enter does what a double click does.
    if (event.key === 'Enter' && selected && selected !== WORKTREE) return onOpen(selected);
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step || !rows.length) return;
    event.preventDefault();
    const current = rows.findIndex((row) => row.hash === selected);
    const next = Math.min(rows.length - 1, Math.max(0, current + step));
    onSelect(rows[next].hash, 'single');
    scrollTo(next, false);
  };

  const listClasses = ['commits'];
  if (fit.cut) listClasses.push('cut');
  // The commits of the filter before stay until those of the new one come, but they are no longer what is asked for.
  if (loading === 'filter') listClasses.push('stale');

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
            </span>
          ));
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
              <Graph graph={row.graph} width={fit.width} height={rowHeight} lane={fit.lane} node={worktree ? 'worktree' : row.stash ? 'stash' : 'commit'} />
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
                        <span className="who">{row.author}</span>
                        <span className="when" title={fullDate(row.date)}>
                          {relativeTime(row.date)}
                        </span>
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
                  <div className="author">{row.author}</div>
                  <div className="date" title={fullDate(row.date)}>
                    {relativeTime(row.date)}
                  </div>
                  <div className="hash">{shortHash(row.hash)}</div>
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
