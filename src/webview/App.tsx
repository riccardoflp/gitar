import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { WORKTREE, type CommitDetail, type Comparison, type RepoState, type Row, type Search } from '../shared/protocol';
import { BisectBanner } from './BisectBanner';
import { CommitList, type Label, type SelectMode } from './CommitList';
import { Compare } from './Compare';
import { useMenu } from './ContextMenu';
import { Detail } from './Detail';
import { FilterBar } from './FilterBar';
import { Icon } from './Icon';
import { OperationBanner } from './OperationBanner';
import { RebaseEditor } from './RebaseEditor';
import { RefsTree } from './RefsTree';
import { Sash } from './Sash';
import { Toolbar } from './Toolbar';
import { dragging } from './drag';
import {
  branchMenu,
  canCherryPick,
  cherryPickMany,
  commitMenu,
  dropMenu,
  remoteBranchMenu,
  selectionMenu,
  tagMenu,
  type Comparing,
} from './menus';
import { loadUiState, onMessage, post, saveUiState } from './vscode';

const NONE: ReadonlySet<string> = new Set();
/** The widths of the panes beside the commits, in pixels, until they are dragged to others. The graph chooses its own. */
const WIDTHS: { refsWidth: number; detailWidth: number; graphWidth: number | null } = { refsWidth: 210, detailWidth: 320, graphWidth: null };

function buildLabels(state: RepoState): Map<string, Label[]> {
  const labels = new Map<string, Label[]>();
  const add = (hash: string, label: Label) => {
    const list = labels.get(hash);
    if (list) list.push(label);
    else labels.set(hash, [label]);
  };
  if (state.head && !state.branch) add(state.head, { kind: 'head', name: 'HEAD', current: true });
  for (const branch of state.branches) add(branch.hash, { kind: 'branch', name: branch.name, current: branch.current });
  for (const remote of state.remoteBranches) add(remote.hash, { kind: 'remote', name: remote.name });
  for (const tag of state.tags) add(tag.hash, { kind: 'tag', name: tag.name });
  if (state.bisect) {
    const { good, bad, skipped } = state.bisect;
    for (const hash of good) add(hash, { kind: 'good', name: 'good' });
    if (bad) add(bad, { kind: 'bad', name: 'bad' });
    for (const hash of skipped) add(hash, { kind: 'skipped', name: 'skipped' });
  }
  return labels;
}

/** A state that came without its commits, because they are the ones this view already has, given those of the state before. */
function withRowsOf(previous: RepoState | null, next: RepoState): RepoState {
  const rows = previous?.rows ?? [];
  // Only the row of the uncommitted changes comes again, for the number of changes in its text.
  const [worktree] = next.rows;
  if (worktree && rows[0]?.hash === WORKTREE && rows[0].subject !== worktree.subject) return { ...next, rows: [worktree, ...rows.slice(1)] };
  return { ...next, rows };
}

/** A search of the whole history, and the commits git found for it: null while it is looking. */
interface Find {
  search: Search;
  hashes: string[] | null;
  more: boolean;
  /** Git refused it: asking again would only be refused again. */
  failed?: boolean;
}

const sameSearch = (one: Search, other: Search) => one.kind === other.kind && one.query === other.query;

/** `compact` is the graph as it fits in the side bar: the commits and their details, with the references left to the view beside it. */
export function App({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<RepoState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // The commits selected together with Ctrl or Shift. Empty when only `selected` is.
  const [marked, setMarked] = useState<ReadonlySet<string>>(NONE);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [find, setFind] = useState<Find | null>(null);
  const [reveal, setReveal] = useState<{ hash: string } | null>(null);
  const [rebase, setRebase] = useState<Row[] | null>(null);
  const [comparing, setComparing] = useState<Comparing | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [{ refsWidth, detailWidth, graphWidth }, setWidths] = useState(() => loadUiState(WIDTHS));
  const resize = (changed: Partial<typeof WIDTHS>) => setWidths((widths) => ({ ...widths, ...changed }));
  const openMenu = useMenu();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const comparingRef = useRef(comparing);
  comparingRef.current = comparing;
  const rootRef = useRef<string | null>(null);
  const findRef = useRef(find);
  findRef.current = find;
  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = state?.rows ?? [];
  // Whether the first commit of what a search finds is to be shown: of a search just asked, not of one repeated.
  const jumpRef = useRef(false);

  /** Shows a commit in the detail pane, leaving alone whatever else is selected with it. */
  const show = useCallback((hash: string | null) => {
    setSelected(hash);
    setDetail(null);
    setComparing(null);
    if (hash) post({ type: 'getDetail', hash });
  }, []);

  const select = useCallback(
    (hash: string | null) => {
      setMarked(NONE);
      show(hash);
    },
    [show],
  );

  const compare = useCallback((next: Comparing) => {
    setComparing(next);
    setComparison(null);
    post({ type: 'getComparison', from: next.from, to: next.to });
  }, []);

  useEffect(() => {
    const stop = onMessage((message) => {
      if (message.type === 'state') {
        const next = message.state;
        setState(next && message.sameRows ? (previous) => withRowsOf(previous, next) : next);
        setLoaded(true);
        const root = message.state?.root ?? null;
        if (root !== rootRef.current) {
          // Another repository: what was selected or being edited belongs to the previous one.
          rootRef.current = root;
          select(null);
          setRebase(null);
          setFind(null);
        } else if (selectedRef.current === WORKTREE) {
          // The list of uncommitted files is the only detail that goes stale.
          if (message.state?.changes) post({ type: 'getDetail', hash: WORKTREE });
          else select(null);
        }
      } else if (message.type === 'detail') {
        if (message.hash === selectedRef.current) setDetail(message.detail);
      } else if (message.type === 'busy') {
        setBusy(message.title);
      } else if (message.type === 'comparison') {
        const { from, to } = message.comparison;
        if (from === comparingRef.current?.from && to === comparingRef.current.to) setComparison(message.comparison);
      } else if (message.type === 'reveal') {
        select(message.hash);
        setReveal({ hash: message.hash });
      } else if (message.type === 'compare') {
        compare(message.comparing);
      } else if (message.type === 'found') {
        const asked = findRef.current?.search;
        if (asked && sameSearch(asked, message.search)) {
          setFind({ search: asked, hashes: message.hashes, more: message.more, failed: message.failed });
        }
      }
    });
    post({ type: 'ready' });
    return stop;
  }, [select, compare]);

  useEffect(() => {
    saveUiState({ refsWidth, detailWidth, graphWidth });
  }, [refsWidth, detailWidth, graphWidth]);

  const labels = useMemo(() => (state ? buildLabels(state) : new Map<string, Label[]>()), [state]);

  const highlighted = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!state || !needle) return null;
    const found: string[] = [];
    // A hash is matched from its start, and by four characters at least: "add" and "bed" are words before they are
    // hexadecimal digits, and somewhere in forty of those they are bound to turn up.
    const hash = /^[0-9a-f]{4,}$/.test(needle);
    for (const row of state.rows) {
      // The uncommitted changes are a row of the list, not a commit to find.
      if (row.hash === WORKTREE) continue;
      const haystack = `${row.subject}\n${row.author}`.toLowerCase();
      if (haystack.includes(needle) || (hash && row.hash.startsWith(needle))) found.push(row.hash);
    }
    return found;
  }, [state, query]);
  // What git found in the whole history, or what the loaded commits have of the text being typed.
  const matches = find ? find.hashes : highlighted;

  const jump = useCallback(
    (hash: string) => {
      select(hash);
      setReveal({ hash });
    },
    [select],
  );

  /** A commit a search found can be further back than the history is loaded: then it is asked for. */
  const goTo = useCallback(
    (hash: string) => {
      if (rowsRef.current.some((row) => row.hash === hash)) jump(hash);
      else post({ type: 'goTo', revision: hash });
    },
    [jump],
  );

  const step = useCallback(
    (by: 1 | -1) => {
      if (!matches?.length) return;
      const index = selected ? matches.indexOf(selected) : -1;
      const first = by > 0 ? 0 : matches.length - 1;
      goTo(matches[index < 0 ? first : (index + by + matches.length) % matches.length]);
    },
    [matches, selected, goTo],
  );

  const search = useCallback(
    (wanted: Search | null, by: 1 | -1) => {
      const current = findRef.current;
      if (!wanted) return setFind(null);
      // Asked again, it goes on from what it found; and while git is looking there is nothing to add.
      if (current && sameSearch(current.search, wanted)) return current.hashes ? step(by) : undefined;
      jumpRef.current = true;
      setFind({ search: wanted, hashes: null, more: false });
      post({ type: 'find', search: wanted });
    },
    [step],
  );

  // The first of what a search found is shown as soon as it is known, unless the selected commit is one of them.
  const found = find?.hashes;
  useEffect(() => {
    if (!found || !jumpRef.current) return;
    jumpRef.current = false;
    if (found.length && !found.includes(selectedRef.current ?? '')) goTo(found[0]);
  }, [found, goTo]);

  // What was found is of the history as it was: when the commits change, a commit, a fetch or a filter later, it is found again.
  const rows = state?.rows;
  useEffect(() => {
    const current = findRef.current;
    if (rows && current?.hashes && !current.failed) post({ type: 'find', search: current.search });
  }, [rows]);

  if (!loaded) return <div className="empty">Loading repository…</div>;
  if (!state) {
    return (
      <div className="empty">
        <p>No Git repository in this workspace</p>
        <button className="button" onClick={() => post({ type: 'refresh' })}>
          Check again
        </button>
      </div>
    );
  }

  const markedRows = marked.size > 1 ? state.rows.filter((row) => marked.has(row.hash)) : [];
  const at = matches && selected ? matches.indexOf(selected) : -1;
  const hasDetail = !!(selected || comparing);

  const onRowSelect = (hash: string, mode: SelectMode) => {
    // The uncommitted changes are not a commit, and cannot be selected along with some.
    const anchor = selected === WORKTREE ? null : selected;
    if (mode === 'single' || hash === WORKTREE || !anchor) return select(hash);
    if (mode === 'range') {
      const from = state.rows.findIndex((row) => row.hash === anchor);
      const to = state.rows.findIndex((row) => row.hash === hash);
      if (from < 0 || to < 0) return select(hash);
      const range = state.rows.slice(Math.min(from, to), Math.max(from, to) + 1).filter((row) => row.hash !== WORKTREE);
      setMarked(range.length > 1 ? new Set(range.map((row) => row.hash)) : NONE);
      return;
    }
    const next = new Set(marked.size ? marked : [anchor]);
    const added = !next.delete(hash);
    if (added) next.add(hash);
    if (next.size < 2) return select([...next][0] ?? null);
    setMarked(next);
    if (added || hash === selected) show(added ? hash : [...next][0]);
  };

  const onRowMenu = (event: MouseEvent, row: Row) => {
    if (markedRows.length > 1 && marked.has(row.hash)) return openMenu(event, selectionMenu(markedRows, state, compare));
    const before = selected;
    select(row.hash);
    openMenu(event, commitMenu(row, state, { selected: before, onInteractiveRebase: setRebase, onCompare: compare }));
  };

  const dropEntries = (row: Row) => {
    const source = dragging();
    return source ? dropMenu(source, row, state) : [];
  };

  const onLabelMenu = (event: MouseEvent, label: Label, row: Row) => {
    const branch = label.kind === 'branch' && state.branches.find((candidate) => candidate.name === label.name);
    const remote = label.kind === 'remote' && state.remoteBranches.find((candidate) => candidate.name === label.name);
    const tag = label.kind === 'tag' && state.tags.find((candidate) => candidate.name === label.name);
    if (branch) openMenu(event, branchMenu(branch, state, compare));
    else if (remote) openMenu(event, remoteBranchMenu(remote, state, compare));
    else if (tag) openMenu(event, tagMenu(tag, state, compare));
    else onRowMenu(event, row);
  };

  return (
    <div className="app">
      <Toolbar
        state={state}
        busy={busy}
        compact={compact}
        matches={matches && { count: matches.length, index: at < 0 ? null : at, more: !!find?.more }}
        searching={!!find && !find.hashes}
        onQuery={setQuery}
        onSearch={search}
        onStep={step}
      />
      {/* In the side bar the Changes view, right above, already says what is under way. */}
      {!compact && <OperationBanner state={state} busy={busy !== null} />}
      {!compact && <BisectBanner state={state} busy={busy !== null} onShow={jump} />}
      <FilterBar state={state} />
      {markedRows.length > 1 && (
        <div className="filterbar" role="status">
          <Icon name="checklist" />
          <span className="grow">
            {markedRows.length} commits selected
            <span className="muted"> · Ctrl+click adds or removes one, Shift+click selects up to there</span>
          </span>
          {canCherryPick(markedRows, state) && (
            <button
              className="button"
              disabled={busy !== null}
              title="Applies them oldest first, as one operation"
              onClick={() => {
                cherryPickMany(markedRows);
                setMarked(NONE);
              }}
            >
              <Icon name="git-commit" />
              Cherry-pick onto {state.branch ?? 'HEAD'}
            </button>
          )}
          <button className="button" onClick={() => setMarked(NONE)}>
            <Icon name="close" />
            Clear selection
          </button>
        </div>
      )}
      <div
        className={`main${hasDetail ? ' has-detail' : ''}${compact ? ' compact' : ''}`}
        style={{ '--refs-width': `${refsWidth}px`, '--detail-width': `${detailWidth}px` } as CSSProperties}
      >
        {!compact && <RefsTree state={state} selected={selected} onSelect={jump} onCompare={compare} />}
        {!compact && (
          <Sash pane="refs" width={refsWidth} onResize={(width) => resize({ refsWidth: width })} onReset={() => resize({ refsWidth: WIDTHS.refsWidth })} />
        )}
        <CommitList
          rows={state.rows}
          empty={state.filter ? 'No commits found' : state.head ? 'No commits to show' : 'No commits yet'}
          hasMore={state.hasMore}
          labels={labels}
          matches={matches}
          graphWidth={graphWidth}
          onGraphWidth={(width) => resize({ graphWidth: width })}
          selected={selected}
          marked={marked}
          reveal={reveal}
          onSelect={onRowSelect}
          onRowMenu={onRowMenu}
          onLabelMenu={onLabelMenu}
          dragSource={(label, row) => {
            if (!label) return row.hash === WORKTREE ? null : { kind: 'commit', hash: row.hash, isMerge: row.parents.length > 1 };
            if (label.kind !== 'branch' && label.kind !== 'remote') return null;
            return { kind: 'branch', name: label.name, hash: row.hash, local: label.kind === 'branch', current: !!label.current };
          }}
          canDrop={(row) => dropEntries(row).length > 0}
          onDrop={(event, row) => openMenu(event, dropEntries(row))}
        />
        {hasDetail && !compact && (
          <Sash
            pane="detail"
            width={detailWidth}
            onResize={(width) => resize({ detailWidth: width })}
            onReset={() => resize({ detailWidth: WIDTHS.detailWidth })}
          />
        )}
        {comparing ? (
          <Compare
            comparing={comparing}
            comparison={comparison}
            onSwap={() => compare({ from: comparing.to, to: comparing.from, fromName: comparing.toName, toName: comparing.fromName })}
            onJump={jump}
            onClose={() => setComparing(null)}
          />
        ) : (
          selected && <Detail hash={selected} detail={detail} onJump={jump} onClose={() => select(null)} />
        )}
        {rebase && <RebaseEditor range={rebase} branch={state.branch} onClose={() => setRebase(null)} />}
      </div>
    </div>
  );
}
