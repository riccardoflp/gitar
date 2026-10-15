import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { PullAction, RepoState, Search, SyncAction, UiCommand } from '../shared/protocol';
import { useMenu, type MenuEntry } from './ContextMenu';
import { Icon } from './Icon';
import { RepoSelect } from './RepoSelect';
import { ScopeButton } from './ScopeButton';
import { act } from './menus';
import { loadUiState, post, saveUiState } from './vscode';

interface Props {
  state: RepoState;
  busy: string | null;
  /** Only the search and the menu: in the side bar the header of the view has the buttons, and the room is for the commits. */
  compact?: boolean;
  /**
   * The commits the search matches: how many, which of them is selected, counting from 0, and whether there are more
   * than were counted. Null when nothing is searched for.
   */
  matches: { count: number; index: number | null; more: boolean } | null;
  /** Git is looking for them. */
  searching: boolean;
  /** Whether the references beside the commits are put away, and what the button that says so does. */
  refsHidden?: boolean;
  onToggleRefs?(): void;
  /** Highlights the loaded commits that contain the text. */
  onQuery(query: string): void;
  /** A search of the whole history is asked for, or again to go on from its results; null when it no longer holds. */
  onSearch(search: Search | null, by: 1 | -1): void;
  /** To the match after the selected one, or to the one before it. */
  onStep(by: 1 | -1): void;
}

const PULL_VARIANTS: { action: PullAction; label: string; command: string }[] = [
  { action: 'pull', label: 'Pull', command: 'git pull' },
  { action: 'pullRebase', label: 'Pull (rebase)', command: 'git pull --rebase' },
  { action: 'pullAutostash', label: 'Pull (autostash)', command: 'git pull --autostash' },
  { action: 'pullRebaseAutostash', label: 'Pull (rebase, autostash)', command: 'git pull --rebase --autostash' },
];

const PUSH_VARIANTS: { action: SyncAction; label: string }[] = [
  { action: 'push', label: 'Push' },
  { action: 'pushForceWithLease', label: 'Push (force with lease)' },
  { action: 'pushForce', label: 'Push (force)' },
];

/** `loaded` highlights matches among the commits on screen; the others ask git to search the whole history. */
type SearchMode = 'loaded' | Search['kind'];

/** What may be the hash of a commit, or the start of one. */
const HASH = /^[0-9a-f]{4,64}$/i;

const SEARCH_MODES: Record<SearchMode, { label: string; placeholder: string; title: string }> = {
  loaded: {
    label: 'Loaded',
    placeholder: 'Find by message, author or hash',
    title: 'Highlight matches among the loaded commits. Enter on a hash goes to that commit, however far back it is',
  },
  message: { label: 'Message', placeholder: 'Text in the message, then Enter', title: 'git log --grep: search every commit message' },
  author: { label: 'Author', placeholder: 'Author name or email, then Enter', title: 'git log --author: search every commit author' },
  pickaxe: {
    label: 'Changes',
    placeholder: 'Text added or removed, then Enter',
    title: 'git log -S: commits that add or remove this text',
  },
  regex: {
    label: 'Changes (regex)',
    placeholder: 'Regex on changed lines, then Enter',
    title: 'git log -G: commits whose changed lines match this POSIX extended regular expression ([0-9], not \\d)',
  },
};

export function Toolbar({ state, busy, compact, matches, searching, refsHidden, onToggleRefs, onQuery, onSearch, onStep }: Props) {
  const [mode, setMode] = useState<SearchMode>('loaded');
  const [text, setText] = useState('');
  // Whether a search of the whole history replaces the graph with what it finds, rather than highlight it there.
  const [only, setOnly] = useState(() => loadUiState({ searchOnly: false }).searchOnly);
  const input = useRef<HTMLInputElement>(null);
  const openMenu = useMenu();
  const upstream = state.branches.find((branch) => branch.current)?.upstream;
  const sync = (action: SyncAction) => post({ type: 'sync', action });
  // What the button runs, among the ways to pull: the settings choose it.
  const pull = PULL_VARIANTS.find(({ action }) => action === state.defaultPull) ?? PULL_VARIANTS[0];
  /** A menu of the ways to pull or push, which says which one the button beside it runs. */
  const variants = (list: typeof PUSH_VARIANTS, button: SyncAction) => (event: MouseEvent) =>
    openMenu(
      event,
      list.map(({ action, label }) => ({ label, hint: action === button ? 'default' : undefined, run: () => sync(action) })),
    );

  const typed = text.trim();
  // Not among the loaded commits, it may still be the hash of one further back, or of one no branch reaches.
  const lookup = mode === 'loaded' && matches?.count === 0 && HASH.test(typed);

  const changeText = (value: string) => {
    setText(value);
    if (mode === 'loaded') onQuery(value);
    else onSearch(null, 1);
  };
  const changeMode = (next: SearchMode) => {
    setMode(next);
    onQuery(next === 'loaded' ? text : '');
    onSearch(null, 1);
  };
  const submit = (by: 1 | -1) => {
    if (mode === 'loaded') {
      if (matches?.count) onStep(by);
      else if (lookup) post({ type: 'goTo', revision: typed.toLowerCase() });
    } else if (typed) {
      if (only) post({ type: 'setFilter', filter: { kind: mode, query: typed } });
      else onSearch({ kind: mode, query: typed }, by);
    }
  };
  /** Shows the search in the box the other way: as a list of what it finds, or highlighted in the graph. */
  const toggleOnly = () => {
    if (mode === 'loaded') return;
    saveUiState({ searchOnly: !only });
    setOnly(!only);
    if (only) {
      // The list gives way to the graph when it is searched; with nothing to search, it is left here.
      if (typed) onSearch({ kind: mode, query: typed }, 1);
      else if (state.filter && 'query' in state.filter) post({ type: 'setFilter', filter: null });
    } else {
      onSearch(null, 1);
      if (typed) post({ type: 'setFilter', filter: { kind: mode, query: typed } });
    }
  };

  // The keys of a search work wherever the focus is in the view.
  const onKey = useRef<(event: KeyboardEvent) => void>(() => {});
  onKey.current = (event) => {
    if (event.key === 'F3') {
      event.preventDefault();
      submit(event.shiftKey ? -1 : 1);
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey.current(event);
    // The extension is told while the view has the keyboard, to keep the key that searches from the editor behind it.
    const focus = () => post({ type: 'focus', focused: true });
    const blur = () => post({ type: 'focus', focused: false });
    window.addEventListener('keydown', listener);
    window.addEventListener('focus', focus);
    window.addEventListener('blur', blur);
    if (document.hasFocus()) focus();
    return () => {
      window.removeEventListener('keydown', listener);
      window.removeEventListener('focus', focus);
      window.removeEventListener('blur', blur);
    };
  }, []);

  /** A click on a button of the search leaves the focus in the box, where Enter and Shift+Enter go on from it. */
  const keepFocus = (event: MouseEvent) => event.preventDefault();

  const run = (command: UiCommand) => () => post({ type: 'command', command });
  const more: MenuEntry[] = [
    // Its button is the first to go when the toolbar is short of room.
    !compact && { label: 'Refresh', run: () => post({ type: 'refresh' }) },
    !compact && 'separator',
    { label: 'Compare branches, tags or commits…', run: () => post({ type: 'compare' }) },
    { label: 'Go to commit…', run: run('goToCommit') },
    { label: 'History of the active file', run: run('activeFileHistory') },
    { label: 'Browse reflog…', run: run('reflog') },
    { label: 'Clean up branches…', run: run('cleanupBranches') },
    { label: 'Manage remotes…', run: run('remotes') },
    // With submodules, their section has the same button.
    !state.submodules.length && { label: 'Add submodule…', run: () => act({ kind: 'submoduleAdd' }) },
    (state.repos.length > 1 || state.home) && { label: 'Select repository…', run: run('selectRepository') },
    'separator',
    { label: 'Switch identity…', run: run('switchIdentity') },
    state.github && 'separator',
    state.github && { label: 'Load pull requests from GitHub', run: run('signInGitHub') },
  ];

  const search = (
    <div className="search">
      <Icon name="search" />
      <select
        value={mode}
        aria-label="Where to search"
        title={SEARCH_MODES[mode].title}
        onChange={(event) => changeMode(event.target.value as SearchMode)}
      >
        {Object.entries(SEARCH_MODES).map(([key, { label }]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      <input
        ref={input}
        type="text"
        value={text}
        aria-label="Search commits"
        placeholder={SEARCH_MODES[mode].placeholder}
        onChange={(event) => changeText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit(event.shiftKey ? -1 : 1);
          else if (event.key === 'Escape' && text) changeText('');
        }}
      />
      {searching && <Icon name="loading" spin />}
      {lookup ? (
        <span className="hint" title="Press Enter to go to the commit with this hash, wherever it is in the history">
          Enter ↵
        </span>
      ) : (
        matches && (
          <span className="count" role="status" title={matches.more ? 'Only the first matches were counted' : undefined}>
            {matches.index !== null && `${matches.index + 1}/`}
            {matches.count}
            {matches.more && '+'}
          </span>
        )
      )}
      {!!matches?.count && (
        <>
          <button
            className="step"
            onMouseDown={keepFocus}
            onClick={() => onStep(-1)}
            aria-label="Previous match"
            title="Previous match (Shift+Enter, Shift+F3)"
          >
            <Icon name="arrow-up" />
          </button>
          <button className="step" onMouseDown={keepFocus} onClick={() => onStep(1)} aria-label="Next match" title="Next match (Enter, F3)">
            <Icon name="arrow-down" />
          </button>
        </>
      )}
      {mode !== 'loaded' && (
        <button
          className="only"
          onMouseDown={keepFocus}
          onClick={toggleOnly}
          aria-pressed={only}
          aria-label="Show only the commits found"
          title="Show only the commits found, as a list, instead of highlighting them in the graph"
        >
          <Icon name="filter" />
        </button>
      )}
    </div>
  );
  const moreButton = (
    <button className="button icon" onClick={(event) => openMenu(event, more)} aria-label="More actions" title="More actions">
      <Icon name="ellipsis" />
    </button>
  );
  const working = busy && (
    <span className="busy" title={`${busy}…`}>
      <Icon name="loading" spin />
      <span className="label">{busy}…</span>
    </span>
  );

  if (compact) {
    return (
      <div className="toolbar compact">
        {search}
        <ScopeButton state={state} compact />
        {working}
        {moreButton}
      </div>
    );
  }

  return (
    <div className="toolbar">
      {onToggleRefs && (
        <button
          className={`button icon refs-toggle${refsHidden ? '' : ' on'}`}
          aria-pressed={!refsHidden}
          aria-label={refsHidden ? 'Show the branches' : 'Hide the branches'}
          title={refsHidden ? 'Show the branches, tags and stashes beside the commits' : 'Hide the branches, tags and stashes beside the commits'}
          onClick={onToggleRefs}
        >
          <Icon name={refsHidden ? 'layout-sidebar-left-off' : 'layout-sidebar-left'} />
        </button>
      )}
      <RepoSelect state={state} disabled={!!busy} />
      <span className="current" title={state.root}>
        <Icon name="git-branch" />
        <span className="name">{state.branch ?? (state.head ? `detached at ${state.head.slice(0, 7)}` : 'no commits yet')}</span>
      </span>

      {/* The words are hidden when the panel is narrow, so each button also says what it is in its tooltip. */}
      <button className="button" disabled={!!busy} onClick={() => sync('fetch')} title="Fetch: git fetch --all --prune" aria-label="Fetch">
        <Icon name="repo-fetch" />
        <span className="label">Fetch</span>
      </button>
      <div className="split">
        <button className="button" disabled={!!busy} onClick={() => sync(pull.action)} title={`Pull: ${pull.command}`} aria-label="Pull">
          <Icon name="repo-pull" />
          <span className="label">Pull</span>
          {!!upstream?.behind && <span className="count">{upstream.behind}</span>}
        </button>
        <button className="button" disabled={!!busy} onClick={variants(PULL_VARIANTS, pull.action)} aria-label="More pull options">
          <Icon name="chevron-down" />
        </button>
      </div>
      <div className="split">
        <button className="button" disabled={!!busy} onClick={() => sync('push')} title="Push: git push" aria-label="Push">
          <Icon name="repo-push" />
          <span className="label">Push</span>
          {!!upstream?.ahead && <span className="count">{upstream.ahead}</span>}
        </button>
        <button className="button" disabled={!!busy} onClick={variants(PUSH_VARIANTS, 'push')} aria-label="More push options">
          <Icon name="chevron-down" />
        </button>
      </div>

      <button
        className="button"
        disabled={!!busy || !state.head}
        onClick={() => act({ kind: 'createBranch', at: 'HEAD' })}
        title="Branch: create a branch at HEAD"
        aria-label="Branch"
      >
        <Icon name="git-branch" />
        <span className="label">Branch</span>
      </button>
      <button
        className="button"
        disabled={!!busy || !state.changes || !state.head}
        onClick={() => act({ kind: 'stashPush' })}
        title="Stash: git stash push --include-untracked"
        aria-label="Stash"
      >
        <Icon name="git-stash" />
        <span className="label">Stash</span>
      </button>

      <button
        className="button"
        disabled={!!busy || !state.head}
        onClick={() => act({ kind: 'undo' })}
        title="Undo the last commit, checkout, merge, rebase, reset, branch deletion or stash drop"
        aria-label="Undo"
      >
        <Icon name="discard" />
        <span className="label">Undo</span>
      </button>

      {working}

      <span className="spacer" />

      <ScopeButton state={state} />
      {search}
      <button className="button icon refresh" onClick={() => post({ type: 'refresh' })} aria-label="Refresh" title="Refresh">
        <Icon name="refresh" />
      </button>
      {moreButton}
    </div>
  );
}
