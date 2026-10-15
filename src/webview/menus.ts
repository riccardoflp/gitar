import {
  WORKTREE,
  type Action,
  type Branch,
  type Commit,
  type Comparing,
  type NamedRef,
  type PullRequest,
  type RepoState,
  type Row,
  type Stash,
  type Worktree,
} from '../shared/protocol';
import { canFastForward, refArg } from '../shared/refs';
import { scopeRefs, toggleScopeRef } from '../shared/scope';
import type { MenuEntry } from './ContextMenu';
import type { DragSource } from './drag';
import { shortHash } from './util';
import { post } from './vscode';

export const act = (action: Action) => post({ type: 'action', action });
const copy = (text: string) => post({ type: 'copy', text });

/** Merging or rebasing only makes sense against something other than the commit already checked out. */
function integrate(ref: string, hash: string, state: RepoState): MenuEntry[] {
  if (!state.head || hash === state.head) return [];
  const current = state.branch ?? 'HEAD';
  return [
    { label: `Merge into ${current}`, run: () => act({ kind: 'merge', ref }) },
    { label: `Rebase ${current} onto this`, run: () => act({ kind: 'rebase', onto: ref }) },
  ];
}

/**
 * The commits from HEAD down to `hash`, newest first, if they form a single line without merges: what an interactive
 * rebase starting at `hash` would rewrite. Returns null when `hash` is not reachable that way among the loaded rows.
 */
export function rebaseRange(hash: string, state: RepoState): Row[] | null {
  const byHash = new Map(state.rows.map((row) => [row.hash, row]));
  const range: Row[] = [];
  for (let at = state.head; at; ) {
    const row = byHash.get(at);
    if (!row || row.parents.length > 1) return null;
    range.push(row);
    if (at === hash) return range;
    at = row.parents[0] ?? null;
  }
  return null;
}

export type { Comparing };

function compareWithHead(name: string, hash: string, state: RepoState, onCompare: (comparing: Comparing) => void): MenuEntry {
  const head = state.head;
  if (!head || hash === head) return null;
  const current = state.branch ?? 'HEAD';
  return { label: `Compare with ${current}`, run: () => onCompare({ from: hash, to: head, fromName: name, toName: current }) };
}

/** Asks what to compare it with: any branch, tag or commit. */
const compareWith = (name: string, hash: string): MenuEntry => ({
  label: 'Compare with…',
  run: () => post({ type: 'compare', from: { name, hash } }),
});

/**
 * Narrows the graph to the history of a branch or tag, by its full name; or, when the graph is narrowed already, adds
 * it to the ones shown or takes it out.
 */
function scopeEntries(ref: string, state: RepoState): MenuEntry[] {
  const { scope } = state;
  const chosen = scope ? scopeRefs(scope, state) : [];
  const all = { label: 'Show all branches', run: () => post({ type: 'setScope', scope: null }) };
  // Taking out the only one shown would leave nothing: what is left to do is to show everything.
  if (chosen.length === 1 && chosen[0] === ref) return [all];
  return [
    { label: 'Show only this history', run: () => post({ type: 'setScope', scope: { kind: 'refs', refs: [ref] } }) },
    scope && {
      label: chosen.includes(ref) ? 'Hide this history' : 'Show this history too',
      run: () => post({ type: 'setScope', scope: toggleScopeRef(scope, ref, state) }),
    },
    scope && all,
  ];
}

/** Marks a branch as a favorite, or no longer: the favorites are listed first among the references. */
function favoriteEntry(ref: string, state: RepoState): MenuEntry {
  const favorite = state.favorites.includes(ref);
  return { label: favorite ? 'Remove from favorites' : 'Add to favorites', run: () => post({ type: 'setFavorite', ref, favorite: !favorite }) };
}

interface CommitMenuTools {
  /** The commit that was selected before this one was clicked, if any. */
  selected: string | null;
  onInteractiveRebase(range: Row[]): void;
  onCompare(comparing: Comparing): void;
}

export function commitMenu(row: Row, state: RepoState, tools: CommitMenuTools): MenuEntry[] {
  // Git has nothing to stash onto before the first commit.
  if (row.hash === WORKTREE) return state.head ? [{ label: 'Stash changes…', run: () => act({ kind: 'stashPush' }) }] : [];

  const { hash } = row;
  const { selected, onInteractiveRebase, onCompare } = tools;
  const short = shortHash(hash);
  const isMerge = row.parents.length > 1;
  const isHead = hash === state.head;
  const range = state.operation || state.bisect ? null : rebaseRange(hash, state);
  const { staged, unstaged, conflicts } = state.working;
  const pending = staged.length ? 'staged' : unstaged.length ? 'all' : null;
  const mark = (which: 'good' | 'bad') => ({
    label: state.bisect ? `Bisect: mark as ${which}` : `Start bisect: this commit is ${which}`,
    run: () => act({ kind: 'bisect', mark: which, hash }),
  });
  return [
    { label: 'Open in an editor tab', run: () => post({ type: 'openCommit', hash }) },
    'separator',
    !isHead && { label: 'Check out commit (detached)', run: () => act({ kind: 'checkout', target: 'detached', ref: hash }) },
    { label: 'Create branch here…', run: () => act({ kind: 'createBranch', at: hash }) },
    { label: 'Create tag here…', run: () => act({ kind: 'createTag', at: hash }) },
    { label: 'Create worktree here…', run: () => act({ kind: 'worktreeAdd', ref: hash, isBranch: false }) },
    'separator',
    !isHead && { label: `Cherry-pick ${short}`, run: () => act({ kind: 'cherryPick', hash, isMerge }) },
    { label: `Revert ${short}`, run: () => act({ kind: 'revert', hash, isMerge }) },
    'separator',
    ...integrate(hash, hash, state),
    range && {
      label: range.length === 1 ? 'Edit this commit (interactive rebase)…' : `Interactive rebase of ${range.length} commits…`,
      run: () => onInteractiveRebase(range),
    },
    // Folding changes into HEAD is what amending does, so that is not offered here.
    range && !isHead && pending && !conflicts.length && {
      label: `Add ${pending} changes to this commit (fixup)`,
      run: () => act({ kind: 'fixup', hash, isRoot: row.parents.length === 0 }),
    },
    { label: `Reset ${state.branch ?? 'HEAD'} to here…`, run: () => act({ kind: 'reset', hash }) },
    'separator',
    compareWithHead(short, hash, state, onCompare),
    selected !== null && selected !== hash && selected !== WORKTREE && {
      label: `Compare with ${shortHash(selected)}, selected before`,
      run: () => onCompare({ from: selected, to: hash, fromName: shortHash(selected), toName: short }),
    },
    compareWith(short, hash),
    'separator',
    !state.operation && mark('good'),
    !state.operation && mark('bad'),
    'separator',
    { label: 'Copy hash', run: () => copy(hash) },
    { label: 'Copy message', run: () => copy(row.subject) },
  ];
}

/** What can be done with a commit of what is checked out, where they are listed apart from the graph. */
export function logMenu(commit: Commit, state: RepoState): MenuEntry[] {
  const { hash } = commit;
  const isHead = hash === state.head;
  return [
    { label: 'Open in an editor tab', run: () => post({ type: 'openCommit', hash }) },
    { label: 'Show in the graph', run: () => post({ type: 'reveal', hash }) },
    'separator',
    !isHead && { label: 'Check out commit (detached)', run: () => act({ kind: 'checkout', target: 'detached', ref: hash }) },
    { label: 'Create branch here…', run: () => act({ kind: 'createBranch', at: hash }) },
    { label: 'Create tag here…', run: () => act({ kind: 'createTag', at: hash }) },
    'separator',
    { label: `Revert ${shortHash(hash)}`, run: () => act({ kind: 'revert', hash, isMerge: commit.parents.length > 1 }) },
    !isHead && { label: `Reset ${state.branch ?? 'HEAD'} to here…`, run: () => act({ kind: 'reset', hash }) },
    'separator',
    { label: 'Copy hash', run: () => copy(hash) },
    { label: 'Copy message', run: () => copy(commit.subject) },
  ];
}

/** Whether these commits can be cherry-picked in one go: git picks a merge only when told which parent to follow. */
export const canCherryPick = (rows: Row[], state: RepoState) =>
  rows.length > 1 && !state.operation && !state.bisect && rows.every((row) => row.parents.length < 2);

export const cherryPickMany = (rows: Row[]) => act({ kind: 'cherryPickMany', hashes: rows.map((row) => row.hash) });

/** What can be done with several selected commits. `rows` are in the order of the graph, newest first. */
export function selectionMenu(rows: Row[], state: RepoState, onCompare: (comparing: Comparing) => void): MenuEntry[] {
  const newest = rows[0];
  const oldest = rows[rows.length - 1];
  return [
    canCherryPick(rows, state) && {
      label: `Cherry-pick ${rows.length} commits onto ${state.branch ?? 'HEAD'}`,
      run: () => cherryPickMany(rows),
    },
    rows.length === 2 && {
      label: 'Compare these two commits',
      run: () => onCompare({ from: oldest.hash, to: newest.hash, fromName: shortHash(oldest.hash), toName: shortHash(newest.hash) }),
    },
    'separator',
    { label: 'Copy hashes', run: () => copy(rows.map((row) => row.hash).join('\n')) },
  ];
}

/** `feature/x` for `origin/feature/x`: the name a remote-tracking branch has on its remote. */
function nameOnRemote(ref: string, state: RepoState): string | null {
  const remote = state.remotes.find((name) => ref.startsWith(`${name}/`));
  return remote ? ref.slice(remote.length + 1) : null;
}

/** The name a local branch was pushed under, when it has been pushed to a repository on GitHub. */
export function pushedName(branch: Branch, state: RepoState): string | null {
  const upstream = branch.upstream;
  return state.github && upstream && !upstream.gone ? nameOnRemote(upstream.name, state) : null;
}

/** The open pull request of a branch on GitHub, by the name the branch has there. */
export function pullOf(name: string | null, state: RepoState): PullRequest | undefined {
  return name !== null && Object.hasOwn(state.pulls, name) ? state.pulls[name] : undefined;
}

function pullEntry(name: string | null, state: RepoState, offerNew: boolean): MenuEntry {
  const pull = pullOf(name, state);
  if (name === null || (!pull && !offerNew)) return null;
  return {
    label: pull ? `Open pull request #${pull.number}` : 'Create pull request…',
    run: () => post({ type: 'pullRequest', branch: name }),
  };
}

export function branchMenu(branch: Branch, state: RepoState, onCompare: (comparing: Comparing) => void): MenuEntry[] {
  const { name } = branch;
  const checkedOut = state.worktrees.some((worktree) => worktree.branch === name);
  return [
    !branch.current && { label: `Check out ${name}`, run: () => act({ kind: 'checkout', target: 'branch', ref: name }) },
    canFastForward(branch, state) && {
      label: `Fast-forward to ${branch.upstream?.name}`,
      run: () => act({ kind: 'fastForward', name }),
    },
    ...(branch.current ? [] : integrate(refArg('branch', name, state), branch.hash, state)),
    'separator',
    compareWithHead(name, branch.hash, state, onCompare),
    compareWith(name, branch.hash),
    ...scopeEntries(`refs/heads/${name}`, state),
    pullEntry(pushedName(branch, state), state, true),
    favoriteEntry(`refs/heads/${name}`, state),
    'separator',
    { label: 'Create branch here…', run: () => act({ kind: 'createBranch', at: refArg('branch', name, state) }) },
    !checkedOut && { label: 'Create worktree…', run: () => act({ kind: 'worktreeAdd', ref: name, isBranch: true }) },
    { label: 'Rename…', run: () => act({ kind: 'renameBranch', name }) },
    !branch.current && { label: 'Delete', danger: true, run: () => act({ kind: 'deleteBranch', name }) },
    'separator',
    { label: 'Copy name', run: () => copy(name) },
  ];
}

export function remoteBranchMenu(ref: NamedRef, state: RepoState, onCompare: (comparing: Comparing) => void): MenuEntry[] {
  const { name } = ref;
  return [
    { label: 'Check out as local branch', run: () => act({ kind: 'checkout', target: 'remote', ref: refArg('remote', name, state) }) },
    ...integrate(refArg('remote', name, state), ref.hash, state),
    'separator',
    compareWithHead(name, ref.hash, state, onCompare),
    compareWith(name, ref.hash),
    ...scopeEntries(`refs/remotes/${name}`, state),
    pullEntry(state.github ? nameOnRemote(name, state) : null, state, false),
    favoriteEntry(`refs/remotes/${name}`, state),
    'separator',
    { label: 'Delete from remote', danger: true, run: () => act({ kind: 'deleteRemoteBranch', name }) },
    'separator',
    { label: 'Copy name', run: () => copy(name) },
  ];
}

export function tagMenu(tag: NamedRef, state: RepoState, onCompare: (comparing: Comparing) => void): MenuEntry[] {
  const { name } = tag;
  return [
    tag.hash !== state.head && {
      label: 'Check out tag (detached)',
      run: () => act({ kind: 'checkout', target: 'detached', ref: refArg('tag', name, state) }),
    },
    { label: 'Create branch here…', run: () => act({ kind: 'createBranch', at: refArg('tag', name, state) }) },
    'separator',
    compareWithHead(name, tag.hash, state, onCompare),
    compareWith(name, tag.hash),
    ...scopeEntries(`refs/tags/${name}`, state),
    'separator',
    state.remotes.length > 0 && { label: 'Push tag', run: () => act({ kind: 'pushTag', name }) },
    { label: 'Delete', danger: true, run: () => act({ kind: 'deleteTag', name }) },
    'separator',
    { label: 'Copy name', run: () => copy(name) },
  ];
}

export function stashMenu(stash: Stash): MenuEntry[] {
  const { ref } = stash;
  return [
    { label: 'Apply', run: () => act({ kind: 'stashApply', ref }) },
    { label: 'Pop', run: () => act({ kind: 'stashPop', ref }) },
    { label: 'Create branch from stash…', run: () => act({ kind: 'stashBranch', ref }) },
    'separator',
    { label: 'Drop', danger: true, run: () => act({ kind: 'stashDrop', ref }) },
  ];
}

export function worktreeMenu(worktree: Worktree, state: RepoState): MenuEntry[] {
  const { path } = worktree;
  return [
    !worktree.current && !worktree.prunable && { label: 'Open in new window', run: () => act({ kind: 'worktreeOpen', path }) },
    { label: 'Copy path', run: () => copy(path) },
    'separator',
    !worktree.current && { label: 'Remove', danger: true, run: () => act({ kind: 'worktreeRemove', path }) },
    state.worktrees.some((candidate) => candidate.prunable) && {
      label: 'Prune missing worktrees',
      run: () => act({ kind: 'worktreePrune' }),
    },
  ];
}

/** What dropping `source` on the row `target` offers. An empty menu means the row is not a drop target. */
export function dropMenu(source: DragSource, target: Row, state: RepoState): MenuEntry[] {
  if (!state.head || state.operation) return [];
  const current = state.branch ?? 'HEAD';
  const onHead = target.hash === state.head || target.hash === WORKTREE;

  if (source.kind === 'commit') {
    // A cherry-pick always lands on what is checked out, so that is the only place a commit can be dropped.
    if (!onHead || source.hash === state.head) return [];
    const { hash, isMerge } = source;
    return [{ label: `Cherry-pick ${shortHash(hash)} onto ${current}`, run: () => act({ kind: 'cherryPick', hash, isMerge }) }];
  }

  const { name } = source;
  if (onHead) {
    if (source.current || source.hash === state.head) return [];
    const ref = refArg(source.local ? 'branch' : 'remote', name, state);
    return [
      { label: `Merge ${name} into ${current}`, run: () => act({ kind: 'merge', ref }) },
      { label: `Rebase ${current} onto ${name}`, run: () => act({ kind: 'rebase', onto: ref }) },
    ];
  }

  if (!source.local || source.hash === target.hash) return [];
  const onto = target.hash;
  const short = shortHash(onto);
  if (!source.current) return [{ label: `Rebase ${name} onto ${short}`, run: () => act({ kind: 'rebase', onto, branch: name }) }];
  return [
    { label: `Rebase ${name} onto ${short}`, run: () => act({ kind: 'rebase', onto }) },
    { label: `Reset ${name} to ${short}…`, run: () => act({ kind: 'reset', hash: onto }) },
  ];
}
