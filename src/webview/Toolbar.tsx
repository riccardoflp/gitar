import { useState, type MouseEvent } from 'react';
import type { Filter, RepoState, SyncAction, UiCommand } from '../shared/protocol';
import { useMenu, type MenuEntry } from './ContextMenu';
import { Icon } from './Icon';
import { RepoSelect } from './RepoSelect';
import { act } from './menus';
import { post } from './vscode';

interface Props {
  state: RepoState;
  busy: string | null;
  matchCount: number | null;
  /** Highlights the loaded commits that contain the text. */
  onQuery(query: string): void;
  onNextMatch(): void;
}

const PULL_VARIANTS: { action: SyncAction; label: string }[] = [
  { action: 'pull', label: 'Pull' },
  { action: 'pullRebase', label: 'Pull (rebase)' },
];

const PUSH_VARIANTS: { action: SyncAction; label: string }[] = [
  { action: 'push', label: 'Push' },
  { action: 'pushForceWithLease', label: 'Push (force with lease)' },
  { action: 'pushForce', label: 'Push (force)' },
];

/** `loaded` highlights matches among the commits on screen; the others ask git to search the whole history. */
type SearchMode = 'loaded' | Exclude<Filter['kind'], 'path' | 'ref'>;

const SEARCH_MODES: Record<SearchMode, { label: string; placeholder: string; title: string }> = {
  loaded: {
    label: 'Loaded',
    placeholder: 'Find by message, author or hash',
    title: 'Highlight matches among the loaded commits',
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

export function Toolbar({ state, busy, matchCount, onQuery, onNextMatch }: Props) {
  const [mode, setMode] = useState<SearchMode>('loaded');
  const [text, setText] = useState('');
  const openMenu = useMenu();
  const upstream = state.branches.find((branch) => branch.current)?.upstream;
  const sync = (action: SyncAction) => post({ type: 'sync', action });
  const variants = (list: typeof PUSH_VARIANTS) => (event: MouseEvent) =>
    openMenu(
      event,
      list.map(({ action, label }) => ({ label, run: () => sync(action) })),
    );

  const changeText = (value: string) => {
    setText(value);
    if (mode === 'loaded') onQuery(value);
  };
  const changeMode = (next: SearchMode) => {
    setMode(next);
    onQuery(next === 'loaded' ? text : '');
  };
  const submit = () => {
    if (mode === 'loaded') return onNextMatch();
    const query = text.trim();
    if (query) post({ type: 'setFilter', filter: { kind: mode, query } });
  };

  const run = (command: UiCommand) => () => post({ type: 'command', command });
  const more: MenuEntry[] = [
    { label: 'History of the active file', run: run('activeFileHistory') },
    { label: 'Browse reflog…', run: run('reflog') },
    { label: 'Clean up branches…', run: run('cleanupBranches') },
    { label: 'Manage remotes…', run: run('remotes') },
    state.repos.length > 1 && { label: 'Select repository…', run: run('selectRepository') },
    'separator',
    { label: 'Switch identity…', run: run('switchIdentity') },
    state.github && 'separator',
    state.github && { label: 'Load pull requests from GitHub', run: run('signInGitHub') },
  ];

  return (
    <div className="toolbar">
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
        <button className="button" disabled={!!busy} onClick={() => sync('pull')} title="Pull: git pull" aria-label="Pull">
          <Icon name="repo-pull" />
          <span className="label">Pull</span>
          {!!upstream?.behind && <span className="count">{upstream.behind}</span>}
        </button>
        <button className="button" disabled={!!busy} onClick={variants(PULL_VARIANTS)} aria-label="More pull options">
          <Icon name="chevron-down" />
        </button>
      </div>
      <div className="split">
        <button className="button" disabled={!!busy} onClick={() => sync('push')} title="Push: git push" aria-label="Push">
          <Icon name="repo-push" />
          <span className="label">Push</span>
          {!!upstream?.ahead && <span className="count">{upstream.ahead}</span>}
        </button>
        <button className="button" disabled={!!busy} onClick={variants(PUSH_VARIANTS)} aria-label="More push options">
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

      {busy && (
        <span className="busy" title={`${busy}…`}>
          <Icon name="loading" spin />
          <span className="label">{busy}…</span>
        </span>
      )}

      <span className="spacer" />

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
          type="text"
          value={text}
          aria-label="Search commits"
          placeholder={SEARCH_MODES[mode].placeholder}
          onChange={(event) => changeText(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && submit()}
        />
        {matchCount !== null && <span className="count">{matchCount}</span>}
      </div>
      <button className="button icon" onClick={() => post({ type: 'refresh' })} aria-label="Refresh" title="Refresh">
        <Icon name="refresh" />
      </button>
      <button className="button icon" onClick={(event) => openMenu(event, more)} aria-label="More actions" title="More actions">
        <Icon name="ellipsis" />
      </button>
    </div>
  );
}
