import { memo, useState, type ReactNode } from 'react';
import type { PullRequest, RepoState } from '../shared/protocol';
import { useMenu, type MenuEntry } from './ContextMenu';
import { Icon } from './Icon';
import { endDrag, startDrag, type DragSource } from './drag';
import { act, branchMenu, pullOf, pushedName, remoteBranchMenu, stashMenu, tagMenu, worktreeMenu, type Comparing } from './menus';
import { loadUiState, saveUiState } from './vscode';

interface Props {
  state: RepoState;
  selected: string | null;
  onSelect(hash: string): void;
  onCompare(comparing: Comparing): void;
}

interface Item {
  key: string;
  hash: string;
  label: string;
  hint?: string;
  title?: string;
  current?: boolean;
  /** Built when the menu is asked for: a repository can have thousands of tags, and each menu looks through the commits. */
  menu?(): MenuEntry[];
  /** What a double click does, when there is an obvious default. */
  open?(): void;
  /** Set for items that can be dragged onto the graph. */
  drag?: DragSource;
  /** The branch's open pull request on GitHub. */
  pull?: PullRequest;
}

const CHECKS = { success: 'checks passed', failure: 'checks failed', pending: 'checks running' };
/** How many entries of a section are listed before asking. */
const SECTION_LIMIT = 100;
/** With fewer names than this there is nothing to look for, and the box would only take room. */
const FILTER_FROM = 15;

function pullTitle(pull: PullRequest): string {
  const checks = pull.checks ? ` · ${CHECKS[pull.checks]}` : '';
  return `${pull.draft ? 'Draft pull' : 'Pull'} request #${pull.number}: ${pull.title}${checks}`;
}

export const RefsTree = memo(function RefsTree({ state, selected, onSelect, onCompare }: Props) {
  const [collapsed, setCollapsed] = useState(() => loadUiState({ collapsed: {} as Record<string, boolean> }).collapsed);
  // Sections listed in full. Not remembered: the next time the short list is the better start again.
  const [full, setFull] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const openMenu = useMenu();
  const needle = filter.trim().toLowerCase();

  const toggle = (id: string) => {
    const next = { ...collapsed, [id]: !collapsed[id] };
    setCollapsed(next);
    saveUiState({ collapsed: next });
  };

  const section = (id: string, title: string, icon: string, all: Item[]): ReactNode => {
    const items = needle ? all.filter((item) => item.label.toLowerCase().includes(needle)) : all;
    // A filter is there to find something: what it finds shows, whether the section was closed or not.
    const open = needle ? items.length > 0 : !collapsed[id];
    const listed = full[id] ? items : items.slice(0, SECTION_LIMIT);
    // The checked out branch is listed even when it comes after the others.
    const current = items.find((item) => item.current);
    if (current && !listed.includes(current)) listed.push(current);
    return (
      <section key={id}>
        <button className="section" onClick={() => toggle(id)} aria-expanded={open}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <Icon name={icon} />
          <span className="grow">{title}</span>
          <span className="count">{needle ? `${items.length} of ${all.length}` : all.length}</span>
        </button>
        {open &&
          listed.map((item) => (
            <button
              key={item.key}
              className={`ref${item.current ? ' current' : ''}${item.hash === selected ? ' selected' : ''}`}
              title={item.title ?? item.label}
              onClick={() => onSelect(item.hash)}
              onDoubleClick={item.open}
              draggable={item.drag !== undefined}
              onDragStart={(event) => item.drag && startDrag(event, item.drag)}
              onDragEnd={endDrag}
              onContextMenu={(event) => {
                onSelect(item.hash);
                openMenu(event, item.menu?.() ?? []);
              }}
            >
              <span className="grow">{item.label}</span>
              {item.hint && <span className="hint">{item.hint}</span>}
              {item.pull && (
                <span className={`pull ${item.pull.checks ?? ''}`}>
                  <Icon name={item.pull.draft ? 'git-pull-request-draft' : 'git-pull-request'} />
                  {item.pull.number}
                </span>
              )}
            </button>
          ))}
        {open && listed.length < items.length && (
          <button className="ref more" onClick={() => setFull({ ...full, [id]: true })}>
            <span className="grow">Show all {items.length}…</span>
          </button>
        )}
      </section>
    );
  };

  const branches = state.branches.map((branch): Item => {
    const upstream = branch.upstream;
    const hint = upstream
      ? upstream.gone
        ? 'gone'
        : [upstream.ahead && `↑${upstream.ahead}`, upstream.behind && `↓${upstream.behind}`].filter(Boolean).join(' ')
      : undefined;
    const pull = pullOf(pushedName(branch, state), state);
    const tracking = upstream ? `${branch.name} → ${upstream.name}` : `${branch.name} (no upstream)`;
    return {
      key: branch.name,
      hash: branch.hash,
      label: branch.name,
      hint,
      pull,
      title: pull ? `${tracking}\n${pullTitle(pull)}` : tracking,
      current: branch.current,
      menu: () => branchMenu(branch, state, onCompare),
      open: branch.current ? undefined : () => act({ kind: 'checkout', target: 'branch', ref: branch.name }),
      drag: { kind: 'branch', name: branch.name, hash: branch.hash, local: true, current: branch.current },
    };
  });
  const names = state.branches.length + state.remoteBranches.length + state.tags.length + state.stashes.length;

  return (
    <nav className="refs" aria-label="References">
      {(names >= FILTER_FROM || filter) && (
        <div className="refs-filter">
          <Icon name="filter" />
          <input
            type="text"
            value={filter}
            aria-label="Filter branches, tags and stashes"
            placeholder="Filter branches and tags"
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setFilter('')}
          />
          {filter && (
            <button className="clear" onClick={() => setFilter('')} aria-label="Clear the filter" title="Clear the filter">
              <Icon name="close" />
            </button>
          )}
        </div>
      )}
      {section('branches', 'Local', 'git-branch', branches)}
      {section(
        'remotes',
        'Remotes',
        'cloud',
        state.remoteBranches.map((ref) => ({
          key: ref.name,
          hash: ref.hash,
          label: ref.name,
          menu: () => remoteBranchMenu(ref, state, onCompare),
          drag: { kind: 'branch', name: ref.name, hash: ref.hash, local: false, current: false },
        })),
      )}
      {section(
        'tags',
        'Tags',
        'tag',
        state.tags.map((ref) => ({ key: ref.name, hash: ref.hash, label: ref.name, menu: () => tagMenu(ref, state, onCompare) })),
      )}
      {section(
        'stashes',
        'Stashes',
        'git-stash',
        state.stashes.map((stash) => ({
          key: stash.ref,
          hash: stash.hash,
          label: stash.message,
          title: `${stash.ref}: ${stash.message}`,
          menu: () => stashMenu(stash),
        })),
      )}
      {section(
        'worktrees',
        'Worktrees',
        'worktree',
        state.worktrees.map((worktree) => ({
          key: worktree.path,
          hash: worktree.hash,
          label: worktree.path.split('/').pop() ?? worktree.path,
          hint: worktree.prunable ? 'missing' : (worktree.branch ?? 'detached'),
          title: worktree.path,
          current: worktree.current,
          menu: () => worktreeMenu(worktree, state),
          open: worktree.current || worktree.prunable ? undefined : () => act({ kind: 'worktreeOpen', path: worktree.path }),
        })),
      )}
    </nav>
  );
});
