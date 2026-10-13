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
import { WORKTREE, type GraphRow, type Row } from '../shared/protocol';
import { Icon } from './Icon';
import { Sash } from './Sash';
import { endDrag, startDrag, type DragSource } from './drag';
import { fullDate, laneColor, relativeTime, shortHash } from './util';
import { post } from './vscode';

export interface Label {
  /** `good`, `bad` and `skipped` are the marks of a bisect in progress. */
  kind: 'head' | 'branch' | 'remote' | 'tag' | 'good' | 'bad' | 'skipped';
  name: string;
  current?: boolean;
}

/** A plain click selects one commit; with Ctrl or Cmd it adds or removes one; with Shift it selects up to the clicked one. */
export type SelectMode = 'single' | 'toggle' | 'range';

interface Props {
  rows: Row[];
  /** What to say in their place when there are none. */
  empty: string;
  hasMore: boolean;
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
  onRowMenu(event: MouseEvent, row: Row): void;
  onLabelMenu(event: MouseEvent, label: Label, row: Row): void;
  /** What dragging a row, or one of its labels, carries. Null when it cannot be dragged. */
  dragSource(label: Label | null, row: Row): DragSource | null;
  canDrop(row: Row): boolean;
  onDrop(event: MouseEvent, row: Row): void;
}

const ROW_HEIGHT = 24;
const OVERSCAN = 8;
const LABEL_ICONS = {
  head: 'target',
  branch: 'git-branch',
  remote: 'cloud',
  tag: 'tag',
  good: 'check',
  bad: 'close',
  skipped: 'debug-step-over',
} as const;

interface GraphProps {
  graph: GraphRow;
  width: number;
  /** The room each lane has: less than usual when the graph is squeezed. */
  lane: number;
  hollow: boolean;
}

const Graph = memo(function Graph({ graph, width, lane, hollow }: GraphProps) {
  const mid = ROW_HEIGHT / 2;
  const laneX = (index: number) => lane / 2 + 3 + index * lane;
  const x = laneX(graph.col);
  // Smaller dots where the lines are close, or they would sit on the lines beside them.
  const radius = lane < 11 ? 3 : 4;
  return (
    <svg className="graph" width={width} height={ROW_HEIGHT} aria-hidden="true">
      {graph.top.map((line, index) => {
        const from = laneX(line.from);
        const to = laneX(line.to);
        const d = from === to ? `M${from} 0V${mid}` : `M${from} 0C${from} ${mid} ${to} 0 ${to} ${mid}`;
        return <path key={`t${index}`} d={d} stroke={laneColor(line.color)} />;
      })}
      {graph.bottom.map((line, index) => {
        const from = laneX(line.from);
        const to = laneX(line.to);
        const d =
          from === to
            ? `M${from} ${mid}V${ROW_HEIGHT}`
            : `M${from} ${mid}C${from} ${ROW_HEIGHT} ${to} ${mid} ${to} ${ROW_HEIGHT}`;
        return <path key={`b${index}`} d={d} stroke={laneColor(line.color)} strokeDasharray={hollow ? '3 3' : undefined} />;
      })}
      {hollow ? (
        <circle className="hollow" cx={x} cy={mid} r={radius - 0.5} stroke={laneColor(graph.color)} />
      ) : (
        <circle cx={x} cy={mid} r={radius} fill={laneColor(graph.color)} />
      )}
    </svg>
  );
});

export function CommitList(props: Props) {
  const { rows, empty, hasMore, labels, matches, selected, marked, reveal, onSelect, onRowMenu, onLabelMenu } = props;
  const { dragSource, canDrop, onDrop } = props;
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

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

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
    const top = index * ROW_HEIGHT;
    if (center) element.scrollTop = top - element.clientHeight / 2 + ROW_HEIGHT / 2;
    else if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
    }
  };

  useEffect(() => {
    if (reveal) scrollTo(rows.findIndex((row) => row.hash === reveal.hash), true);
    // Only a new reveal request should move the scroll position, not every refresh of the rows.
  }, [reveal]);

  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step || !rows.length) return;
    event.preventDefault();
    const current = rows.findIndex((row) => row.hash === selected);
    const next = Math.min(rows.length - 1, Math.max(0, current + step));
    onSelect(rows[next].hash, 'single');
    scrollTo(next, false);
  };

  return (
    <div
      className={fit.cut ? 'commits cut' : 'commits'}
      ref={scroller}
      tabIndex={0}
      role="listbox"
      aria-label="Commits"
      aria-multiselectable="true"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      {!rows.length && <div className="empty">{empty}</div>}
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
      <div className="spacer" style={{ height: rows.length * ROW_HEIGHT }}>
        {rows.slice(start, end).map((row, offset) => {
          const index = start + offset;
          const worktree = row.hash === WORKTREE;
          const classes = ['row'];
          const isSelected = row.hash === selected || marked.has(row.hash);
          if (isSelected) classes.push('selected');
          if (worktree) classes.push('worktree');
          if (matchSet && !matchSet.has(row.hash)) classes.push('dimmed');
          if (row.hash === dropTarget) classes.push('drop-target');
          return (
            <div
              key={row.hash}
              className={classes.join(' ')}
              style={{ top: index * ROW_HEIGHT }}
              role="option"
              aria-selected={isSelected}
              onClick={(event) => onSelect(row.hash, event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'single')}
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
              <Graph graph={row.graph} width={fit.width} lane={fit.lane} hollow={worktree} />
              <div className="message" style={{ '--lane': laneColor(row.graph.color) } as CSSProperties}>
                {labels.get(row.hash)?.map((label) => (
                  <span
                    key={`${label.kind}:${label.name}`}
                    className={`label ${label.kind}${label.current ? ' current' : ''}`}
                    title={label.name}
                    onContextMenu={(event) => onLabelMenu(event, label, row)}
                    {...drag(label, row)}
                  >
                    <Icon name={LABEL_ICONS[label.kind]} />
                    {label.name}
                  </span>
                ))}
                <span className="subject">{row.subject}</span>
              </div>
              {!worktree && (
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
      </div>
    </div>
  );
}
