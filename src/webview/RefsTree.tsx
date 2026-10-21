import { memo, useMemo, useState, type ReactNode } from 'react';
import type { PullRequest, RepoState, Submodule } from '../shared/protocol';
import { changesText, pullOf, pushedName, upstreamHint, worktreeLabel, worktreeOf, worktreeStatus } from '../shared/refs';
import { scopeLabel, scopeRefs } from '../shared/scope';
import { submoduleDepth, submoduleStatus, submoduleStatusText } from '../shared/submodules';
import { useMenu, type MenuEntry } from './ContextMenu';
import { Icon } from './Icon';
import { endDrag, startDrag, type DragSource } from './drag';
import {
  act,
  branchMenu,
  openBranch,
  openRemoteBranch,
  remoteBranchMenu,
  stashMenu,
  submoduleMenu,
  tagMenu,
  worktreeMenu,
  worktreesMenu,
  type Comparing,
} from './menus';
import { loadUiState, post, saveUiState } from './vscode';

/** The start of VS Code the page is shown in. */
const SESSION = document.body.dataset.session ?? '';

export type SectionId = 'favorites' | 'recent' | 'branches' | 'remotes' | 'tags' | 'stashes' | 'worktrees' | 'submodules';

interface Props {
  state: RepoState;
  selected: string | null;
  onSelect(hash: string): void;
  onCompare(comparing: Comparing): void;
  /** Goes to the commit of a branch, tag or worktree in the graph, from their menus. */
  onReveal(hash: string): void;
  /** The sections to list, when not all of them. */
  sections?: SectionId[];
}

/** Where a submodule stands against the commit recorded for it, as an icon with the number of commits beside it. */
interface Badge {
  icon: string;
  tone: 'ok' | 'moved' | 'off';
  text: string;
  count?: string;
}

interface Item {
  key: string;
  /** The commit to select in the graph when it is clicked. None for what is not a commit of the repository. */
  hash?: string;
  label: string;
  hint?: string;
  title?: string;
  current?: boolean;
  /** Marked as a favorite, which is said beside its name where it is listed with the others. */
  favorite?: boolean;
  /** Built when the menu is asked for: a repository can have thousands of tags, and each menu looks through the commits. */
  menu?(): MenuEntry[];
  /** What a double click does, when there is an obvious default. */
  open?(): void;
  /** Set for items that can be dragged onto the graph. */
  drag?: DragSource;
  /** The branch's open pull request on GitHub. */
  pull?: PullRequest;
  /** The folder of the other worktree that has the branch checked out. */
  worktree?: string;
  /** How many files are not committed in the worktree, when there are any. */
  changes?: number;
  /** How far it is indented under the one it is in. */
  depth?: number;
  badge?: Badge;
}

/** A button beside the title of a section: what adds to it, or a menu of what else there is to do with it. */
interface SectionAction {
  icon: string;
  title: string;
  run?(): void;
  /** Opened by the button, and by a right click on the title of the section. */
  menu?(): MenuEntry[];
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

function submoduleBadge(submodule: Submodule): Badge {
  const text = submoduleStatusText(submodule);
  const { ahead, behind } = submodule;
  switch (submoduleStatus(submodule)) {
    case 'synced':
      return { icon: 'pass-filled', tone: 'ok', text };
    case 'ahead':
      return { icon: 'arrow-up', tone: 'moved', text, count: String(ahead) };
    case 'behind':
      return { icon: 'arrow-down', tone: 'moved', text, count: String(behind) };
    case 'diverged':
      return { icon: 'arrow-swap', tone: 'moved', text, count: `${ahead}↑ ${behind}↓` };
    case 'unknown':
      return { icon: 'warning', tone: 'moved', text };
    case 'added':
      return { icon: 'diff-added', tone: 'off', text };
    case 'uninitialized':
      return { icon: 'circle-slash', tone: 'off', text };
  }
}

export const RefsTree = memo(function RefsTree({ state, selected, onSelect, onCompare, onReveal, sections }: Props) {
  // The sections are all closed each time VS Code starts; the ones opened since are remembered until it is closed.
  const [opened, setOpened] = useState(() => {
    const saved = loadUiState({ opened: {} as Record<string, boolean>, openedIn: '' });
    return saved.openedIn === SESSION ? saved.opened : {};
  });
  // Sections listed in full. Not remembered: the next time the short list is the better start again.
  const [full, setFull] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const openMenu = useMenu();
  const needle = filter.trim().toLowerCase();
  // What the graph is narrowed to is what is listed here: the branches, remote branches and tags whose history it shows.
  const scoped = useMemo(() => (state.scope ? new Set(scopeRefs(state.scope, state)) : null), [state]);
  const within = (ref: string) => !scoped || scoped.has(ref);

  const toggle = (id: string) => {
    // From what is open now, not from the last render: two sections opened before it are both kept.
    setOpened((now) => {
      const next = { ...now, [id]: !now[id] };
      saveUiState({ opened: next, openedIn: SESSION });
      return next;
    });
  };

  /** `optional` is a section that is not there at all while it has nothing to list. */
  const section = (id: SectionId, title: string, icon: string, all: Item[], optional = false, actions: SectionAction[] = []): ReactNode => {
    if (sections && !sections.includes(id)) return null;
    if (optional && !all.length) return null;
    const items = needle ? all.filter((item) => item.label.toLowerCase().includes(needle)) : all;
    // A filter is there to find something: what it finds shows, whether the section was closed or not.
    const open = needle ? items.length > 0 : !!opened[id];
    const listed = full[id] ? items : items.slice(0, SECTION_LIMIT);
    const menu = actions.find((action) => action.menu);
    // The checked out branch is listed even when it comes after the others.
    const current = items.find((item) => item.current);
    if (current && !listed.includes(current)) listed.push(current);
    return (
      <section key={id} data-section={id}>
        <div className="section-head" onContextMenu={menu ? (event) => openMenu(event, menu.menu!()) : undefined}>
          <button className="section" onClick={() => toggle(id)} aria-expanded={open}>
            <Icon name={open ? 'chevron-down' : 'chevron-right'} />
            <Icon name={icon} />
            <span className="grow">{title}</span>
            <span className="count">{needle ? `${items.length} of ${all.length}` : all.length}</span>
          </button>
          {actions.map((action) => (
            <button
              key={action.title}
              className="section-action"
              onClick={(event) => (action.menu ? openMenu(event, action.menu()) : action.run?.())}
              title={action.title}
              aria-label={action.title}
              aria-haspopup={action.menu ? 'menu' : undefined}
            >
              <Icon name={action.icon} />
            </button>
          ))}
        </div>
        {open &&
          listed.map((item) => (
            <button
              key={item.key}
              className={`ref${item.current ? ' current' : ''}${item.hash && item.hash === selected ? ' selected' : ''}`}
              style={item.depth ? { paddingLeft: 26 + item.depth * 12 } : undefined}
              title={item.title ?? item.label}
              onClick={() => item.hash && onSelect(item.hash)}
              onDoubleClick={item.open}
              draggable={item.drag !== undefined}
              onDragStart={(event) => item.drag && startDrag(event, item.drag)}
              onDragEnd={endDrag}
              onContextMenu={(event) => {
                if (item.hash) onSelect(item.hash);
                openMenu(event, item.menu?.() ?? []);
              }}
            >
              <span className="grow">{item.label}</span>
              {item.favorite && id !== 'favorites' && <Icon name="star-full" />}
              {item.worktree && <Icon name="worktree" />}
              {item.hint && <span className="hint">{item.hint}</span>}
              {item.changes !== undefined && (
                <span className="dirty">
                  <Icon name="edit" />
                  {item.changes}
                </span>
              )}
              {item.badge && (
                <span className={`badge ${item.badge.tone}`} aria-label={item.badge.text}>
                  <Icon name={item.badge.icon} />
                  {item.badge.count}
                </span>
              )}
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

  const favorites = new Set(state.favorites);
  const branches = state.branches
    .filter((branch) => within(`refs/heads/${branch.name}`))
    .map((branch): Item => {
      const upstream = branch.upstream;
      const pull = pullOf(pushedName(branch, state), state);
      const tracking = upstream ? `${branch.name} → ${upstream.name}` : `${branch.name} (no upstream)`;
      const worktree = worktreeOf(branch.name, state);
      const about = [tracking, worktree && `In the worktree ${worktree.path}`, worktree && changesText(worktree.changes), pull && pullTitle(pull)]
        .filter(Boolean)
        .join('\n');
      return {
        key: branch.name,
        hash: branch.hash,
        label: branch.name,
        hint: upstreamHint(branch),
        pull,
        title: about,
        worktree: worktree?.path,
        changes: worktree?.changes || undefined,
        current: branch.current,
        favorite: favorites.has(`refs/heads/${branch.name}`),
        menu: () => branchMenu(branch, state, onCompare, onReveal),
        open: openBranch(branch, state),
        drag: { kind: 'branch', name: branch.name, hash: branch.hash, local: true, current: branch.current },
      };
    });
  const remotes = state.remoteBranches
    .filter((ref) => within(`refs/remotes/${ref.name}`))
    .map(
      (ref): Item => ({
        key: ref.name,
        hash: ref.hash,
        label: ref.name,
        favorite: favorites.has(`refs/remotes/${ref.name}`),
        menu: () => remoteBranchMenu(ref, state, onCompare, onReveal),
        open: openRemoteBranch(ref, state),
        drag: { kind: 'branch', name: ref.name, hash: ref.hash, local: false, current: false },
      }),
    );
  // The same lines the branches have where they are listed with the others, under a key of their own.
  const again = (prefix: string, item: Item | undefined): Item[] => (item ? [{ ...item, key: `${prefix}:${item.key}` }] : []);
  const favoriteItems = state.favorites.flatMap((ref) =>
    ref.startsWith('refs/heads/')
      ? again(
          'favorite',
          branches.find((item) => `refs/heads/${item.key}` === ref),
        )
      : again(
          'favorite:remote',
          remotes.find((item) => `refs/remotes/${item.key}` === ref),
        ),
  );
  const recentItems = state.recentBranches.flatMap((name) =>
    again(
      'recent',
      branches.find((item) => item.key === name),
    ),
  );
  // Only the names that are listed here count towards having a filter.
  const shown = (id: SectionId, count: number) => (!sections || sections.includes(id) ? count : 0);
  const names =
    shown('branches', state.branches.length) +
    shown('remotes', state.remoteBranches.length) +
    shown('tags', state.tags.length) +
    shown('stashes', state.stashes.length);

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
      {scoped && (
        <div className="refs-scope" role="status" title="Only the branches the graph is narrowed to are listed">
          <Icon name="filter-filled" />
          <span className="grow">{scopeLabel(state.scope)}</span>
          <button className="link" onClick={() => post({ type: 'setScope', scope: null })}>
            Show all
          </button>
        </div>
      )}
      {section('favorites', 'Favorites', 'star-full', favoriteItems, true)}
      {section('recent', 'Recent', 'history', recentItems, true)}
      {section('branches', 'Local', 'git-branch', branches)}
      {section('remotes', 'Remotes', 'cloud', remotes)}
      {section(
        'tags',
        'Tags',
        'tag',
        state.tags
          .filter((ref) => within(`refs/tags/${ref.name}`))
          .map((ref) => ({ key: ref.name, hash: ref.hash, label: ref.name, menu: () => tagMenu(ref, state, onCompare, onReveal) })),
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
        state.worktrees.map((worktree): Item => {
          // Its branch as it stands against its upstream, what is not committed in it and its pull request.
          const { branch, ahead, pull } = worktreeStatus(worktree, state);
          const tracking = branch?.upstream && `${branch.name} → ${branch.upstream.name}`;
          return {
            key: worktree.path,
            hash: worktree.hash,
            label: worktreeLabel(worktree.path, state.worktreesRoot),
            hint: worktree.prunable ? 'missing' : [worktree.branch ?? 'detached', ahead].filter(Boolean).join(' '),
            title: [worktree.path, tracking, changesText(worktree.changes), pull && pullTitle(pull)].filter(Boolean).join('\n'),
            changes: worktree.changes || undefined,
            pull,
            current: worktree.current,
            menu: () => worktreeMenu(worktree, state, onReveal),
            open: worktree.current || worktree.prunable ? undefined : () => act({ kind: 'worktreeOpen', path: worktree.path }),
          };
        }),
        false,
        [
          { icon: 'add', title: 'Create worktree…', run: () => act({ kind: 'worktreeAdd' }) },
          { icon: 'ellipsis', title: 'More actions for worktrees', menu: () => worktreesMenu(state) },
        ],
      )}
      {section(
        'submodules',
        'Submodules',
        'file-submodule',
        state.submodules.map((submodule): Item => {
          const badge = submoduleBadge(submodule);
          const where = submodule.headBranch ?? (submodule.head ? 'detached' : undefined);
          return {
            key: submodule.path,
            label: submodule.parent ? submodule.path.slice(submodule.parent.length + 1) : submodule.path,
            hint: where,
            title: [
              submodule.path,
              submodule.url,
              badge.text,
              submodule.head && `Checked out: ${where} at ${submodule.head.slice(0, 7)}`,
              submodule.staged && `Staged as the recorded commit: ${submodule.staged.slice(0, 7)}`,
              changesText(submodule.changes),
            ]
              .filter(Boolean)
              .join('\n'),
            changes: submodule.changes || undefined,
            depth: submoduleDepth(submodule, state.submodules),
            badge,
            menu: () => submoduleMenu(submodule, state),
            open: submodule.head ? () => act({ kind: 'submoduleOpen', path: submodule.path }) : undefined,
          };
        }),
        true,
        [{ icon: 'add', title: 'Add submodule…', run: () => act({ kind: 'submoduleAdd' }) }],
      )}
    </nav>
  );
});
