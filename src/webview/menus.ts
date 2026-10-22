import {
  WORKTREE,
  type Action,
  type Branch,
  type Commit,
  type Comparing,
  type NamedRef,
  type RepoState,
  type Row,
  type Stash,
  type Submodule,
  type Worktree,
} from '../shared/protocol';
import { canFastForward, isHome, nameOnRemote, pullOf, pushedName, refArg, worktreeOf } from '../shared/refs';
import { submoduleFolder, submoduleStatus } from '../shared/submodules';

export { pullOf, pushedName };
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

/**
 * Goes to the commit in the graph, which loads it when it is further back than the history is loaded or left out of
 * what the graph shows. Only where the reference is listed apart from its commit: on a label of the graph it is there.
 */
function revealEntry(hash: string, onReveal: ((hash: string) => void) | undefined): MenuEntry {
  return onReveal ? { label: 'Show in the graph', run: () => onReveal(hash) } : null;
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
  /** Opens the message of the commit in the details, to change it. */
  onEditMessage(): void;
  /** For a merge whose commits can be folded into one row in the graph: folds them. */
  onFold?(): void;
}

/**
 * Whether the message of a commit can be changed: the last one by amending it, merge or not, an older one by a rebase
 * of it and the line of commits after it, which has no merge, while nothing else is going on.
 */
export function canReword(hash: string, state: RepoState): boolean {
  if (hash === WORKTREE || state.operation || state.bisect) return false;
  return hash === state.head || rebaseRange(hash, state) !== null;
}

/** What can be done with the changes that are not committed, all at once. */
export function changesMenu(state: RepoState): MenuEntry[] {
  const { staged, unstaged, conflicts } = state.working;
  return [
    // Git has nothing to stash onto before the first commit.
    state.head !== null && { label: 'Stash changes…', run: () => act({ kind: 'stashPush' }) },
    state.head !== null && staged.length > 0 && { label: 'Stash staged changes…', run: () => act({ kind: 'stashPush', staged: true }) },
    'separator',
    // Staging everything would mark the conflicts resolved, markers and all.
    unstaged.length > 0 && !conflicts.length && { label: 'Stage all changes', run: () => act({ kind: 'stageAll' }) },
    staged.length > 0 && { label: 'Unstage all changes', run: () => act({ kind: 'unstageAll' }) },
    'separator',
    // In the middle of a merge or a rebase, aborting it is what goes back.
    !state.operation && { label: 'Discard all changes…', danger: true, run: () => act({ kind: 'discardChanges' }) },
  ];
}

export function commitMenu(row: Row, state: RepoState, tools: CommitMenuTools): MenuEntry[] {
  if (row.hash === WORKTREE) return changesMenu(state);

  const { hash } = row;
  const { selected, onInteractiveRebase, onCompare, onEditMessage, onFold } = tools;
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
    onFold && { label: 'Fold the commits it merged into one row', run: onFold },
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
    canReword(hash, state) && { label: 'Edit message…', run: onEditMessage },
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

function pullEntry(name: string | null, state: RepoState, offerNew: boolean): MenuEntry {
  const pull = pullOf(name, state);
  if (name === null || (!pull && !offerNew)) return null;
  return {
    label: pull ? `Open pull request #${pull.number}` : 'Create pull request…',
    run: () => post({ type: 'pullRequest', branch: name }),
  };
}

/**
 * A branch that another worktree has checked out is worked on there: its menu opens that worktree first, and git
 * neither checks it out here nor deletes it while the worktree has it.
 */
export function branchMenu(branch: Branch, state: RepoState, onCompare: (comparing: Comparing) => void, onReveal?: (hash: string) => void): MenuEntry[] {
  const { name } = branch;
  const checkedOut = state.worktrees.some((worktree) => worktree.branch === name);
  const worktree = worktreeOf(name, state);
  const removable = worktree && !worktree.main && !isHome(worktree.path, state);
  // What a double click does comes first.
  const here: MenuEntry[] =
    branch.current || worktree
      ? []
      : [
          { label: `Check out ${name}`, run: () => act({ kind: 'checkout', target: 'branch', ref: name }) },
          { label: 'Open in worktree', run: () => act({ kind: 'openInWorktree', name }) },
        ];
  if (state.openBranches === 'worktree') here.reverse();
  return [
    ...(worktree ? worktreeOpenEntries(worktree, state, true) : []),
    'separator',
    ...here,
    canFastForward(branch, state) && {
      label: `Fast-forward to ${branch.upstream?.name}`,
      run: () => act({ kind: 'fastForward', name }),
    },
    ...(branch.current ? [] : integrate(refArg('branch', name, state), branch.hash, state)),
    'separator',
    compareWithHead(name, branch.hash, state, onCompare),
    compareWith(name, branch.hash),
    revealEntry(branch.hash, onReveal),
    ...scopeEntries(`refs/heads/${name}`, state),
    pullEntry(pushedName(branch, state), state, true),
    favoriteEntry(`refs/heads/${name}`, state),
    'separator',
    { label: 'Create branch here…', run: () => act({ kind: 'createBranch', at: refArg('branch', name, state) }) },
    !checkedOut && { label: 'Create worktree…', run: () => act({ kind: 'worktreeAdd', ref: name, isBranch: true }) },
    { label: worktree ? 'Rename branch…' : 'Rename…', run: () => act({ kind: 'renameBranch', name }) },
    removable && !worktree.prunable && { label: 'Rename worktree…', run: () => act({ kind: 'worktreeRename', path: worktree.path }) },
    !branch.current && !worktree && { label: 'Delete', danger: true, run: () => act({ kind: 'deleteBranch', name }) },
    removable && { label: 'Remove worktree…', danger: true, run: () => act({ kind: 'worktreeRemove', path: worktree.path, deleteBranch: false }) },
    removable && {
      label: 'Remove worktree and delete branch…',
      danger: true,
      run: () => act({ kind: 'worktreeRemove', path: worktree.path, deleteBranch: true }),
    },
    'separator',
    { label: 'Copy name', run: () => copy(name) },
  ];
}

/**
 * What a double click on a branch does, where it is listed and where it labels its commit. Git checks it out nowhere
 * but in its worktree, which opens instead; working only in worktrees, one is made for it. Undefined when it is
 * checked out here already.
 */
export function openBranch(branch: Branch, state: RepoState): (() => void) | undefined {
  if (branch.current) return undefined;
  const worktree = worktreeOf(branch.name, state);
  if (worktree) return worktree.prunable ? undefined : () => act({ kind: 'worktreeOpen', path: worktree.path });
  if (state.openBranches === 'worktree') return () => act({ kind: 'openInWorktree', name: branch.name });
  return () => act({ kind: 'checkout', target: 'branch', ref: branch.name });
}

/**
 * What a double click on a remote branch does: it is checked out, or opened in a worktree, in the local branch of its
 * name. When another worktree has that branch, it is worked on there, and that worktree opens, as a double click on
 * the branch itself does.
 */
export function openRemoteBranch(ref: NamedRef, state: RepoState): (() => void) | undefined {
  const worktree = worktreeOf(nameOnRemote(ref.name, state) ?? ref.name, state);
  if (worktree) return worktree.prunable ? undefined : () => act({ kind: 'worktreeOpen', path: worktree.path });
  if (state.openBranches === 'worktree') return () => act({ kind: 'openInWorktree', name: ref.name, remote: true });
  return () => act({ kind: 'checkout', target: 'remote', ref: refArg('remote', ref.name, state) });
}

export function remoteBranchMenu(ref: NamedRef, state: RepoState, onCompare: (comparing: Comparing) => void, onReveal?: (hash: string) => void): MenuEntry[] {
  const { name } = ref;
  const remoteRef = refArg('remote', name, state);
  // The local branch of its name, which a check out goes to when there is one.
  const ownName = nameOnRemote(name, state) ?? name;
  const local = state.branches.find((branch) => branch.name === ownName);
  const upstream = local?.upstream;
  // How far it is from this one is only known when it follows it.
  const diverged = !!upstream && upstream.name === name && !upstream.gone && upstream.ahead > 0 && upstream.behind > 0;
  // Another worktree has the local branch: that worktree opens, to work on it there, where it would be checked out.
  const worktree = worktreeOf(ownName, state);
  // What a double click does comes first.
  const here: MenuEntry[] = worktree
    ? worktreeOpenEntries(worktree, state, true)
    : [
        { label: local ? `Check out ${ownName}` : 'Check out as local branch', run: () => act({ kind: 'checkout', target: 'remote', ref: remoteRef }) },
        { label: 'Open in worktree', run: () => act({ kind: 'openInWorktree', name, remote: true }) },
      ];
  if (!worktree && state.openBranches === 'worktree') here.reverse();
  return [
    ...here,
    worktree && 'separator',
    // Checked out already, it is rebased by the entry that rebases what is checked out.
    diverged && !local.current && !worktree && {
      label: `Check out ${ownName} and rebase it onto this`,
      run: () => act({ kind: 'checkout', target: 'remote', ref: remoteRef, rebase: true }),
    },
    ...integrate(remoteRef, ref.hash, state),
    'separator',
    compareWithHead(name, ref.hash, state, onCompare),
    compareWith(name, ref.hash),
    revealEntry(ref.hash, onReveal),
    ...scopeEntries(`refs/remotes/${name}`, state),
    pullEntry(state.github ? nameOnRemote(name, state) : null, state, false),
    favoriteEntry(`refs/remotes/${name}`, state),
    'separator',
    { label: 'Delete from remote', danger: true, run: () => act({ kind: 'deleteRemoteBranch', name }) },
    'separator',
    { label: 'Copy name', run: () => copy(name) },
  ];
}

export function tagMenu(tag: NamedRef, state: RepoState, onCompare: (comparing: Comparing) => void, onReveal?: (hash: string) => void): MenuEntry[] {
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
    revealEntry(tag.hash, onReveal),
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

/** What VS Code calls showing a file in the file manager of the system. */
const REVEAL = /Windows/.test(navigator.userAgent)
  ? 'Reveal in File Explorer'
  : /Mac/.test(navigator.userAgent)
    ? 'Reveal in Finder'
    : 'Open containing folder';

/** What opens a worktree. In the menu of its branch they say that they are about the worktree. */
function worktreeOpenEntries(worktree: Worktree, state: RepoState, ofBranch = false): MenuEntry[] {
  const { path } = worktree;
  if (worktree.prunable) return [];
  const it = ofBranch ? ' worktree' : '';
  return [
    state.agentsWindow && { label: `Open${it} in Agents Window`, run: () => act({ kind: 'worktreeOpen', path, where: 'agents' }) },
    !worktree.current && { label: `Open${it} in new window`, run: () => act({ kind: 'worktreeOpen', path, where: 'window' }) },
    { label: ofBranch ? 'Open terminal in worktree' : 'Open in terminal', run: () => act({ kind: 'worktreeTerminal', path }) },
    {
      label: !ofBranch ? REVEAL : REVEAL.startsWith('Reveal') ? REVEAL.replace('Reveal', 'Reveal worktree') : 'Open folder of worktree',
      run: () => act({ kind: 'worktreeReveal', path }),
    },
    // The views of this window go to it, for its changes, commits and branches.
    !worktree.current && { label: ofBranch ? 'Show worktree in Gitardo' : 'Show in Gitardo', run: () => post({ type: 'selectRepo', root: path }) },
  ];
}

export function worktreeMenu(worktree: Worktree, state: RepoState, onReveal?: (hash: string) => void): MenuEntry[] {
  const { path } = worktree;
  // The folder of this window, while the views show another worktree.
  const home = isHome(path, state);
  return [
    ...worktreeOpenEntries(worktree, state),
    // What it has checked out. A missing worktree may have had a commit that is no longer there.
    !worktree.prunable && revealEntry(worktree.hash, onReveal),
    'separator',
    !worktree.prunable && !worktree.main && !worktree.current && !home && { label: 'Rename…', run: () => act({ kind: 'worktreeRename', path }) },
    { label: 'Copy path', run: () => copy(path) },
    // From the checkout of the views, into another: what new worktrees get of what git ignores, as they are now.
    !worktree.prunable && !worktree.current && !home && { label: 'Bring ignored files…', run: () => act({ kind: 'worktreeSetUp', path }) },
    'separator',
    !worktree.current && !worktree.main && !home && { label: 'Remove…', danger: true, run: () => act({ kind: 'worktreeRemove', path }) },
    state.worktrees.some((candidate) => candidate.prunable) && {
      label: 'Prune missing worktrees',
      run: () => act({ kind: 'worktreePrune' }),
    },
  ];
}

/** What the "…" beside the title of the Worktrees section offers, and a right click on that title. */
export function worktreesMenu(state: RepoState): MenuEntry[] {
  return [
    { label: 'Create worktree…', run: () => act({ kind: 'worktreeAdd' }) },
    { label: 'Switch worktree…', run: () => post({ type: 'command', command: 'switchWorktree' }) },
    'separator',
    { label: 'Choose what new worktrees get…', run: () => post({ type: 'command', command: 'worktreeSetup' }) },
    state.worktrees.some((worktree) => !worktree.prunable && !worktree.current) && {
      label: 'Bring ignored files into the other worktrees…',
      run: () => act({ kind: 'worktreeSetUp' }),
    },
    'separator',
    state.worktrees.some((candidate) => candidate.prunable) && { label: 'Prune missing worktrees', run: () => act({ kind: 'worktreePrune' }) },
  ];
}

/**
 * What can be done with a submodule. One that is not initialized can only be cloned; the others open like a worktree,
 * and the commit they have checked out can be recorded when it is not the one recorded.
 */
export function submoduleMenu(submodule: Submodule, state: RepoState): MenuEntry[] {
  const { path, recorded, head } = submodule;
  const folder = submoduleFolder(submodule, state);
  const initialized = head !== null;
  const status = submoduleStatus(submodule);
  const moved = status === 'ahead' || status === 'behind' || status === 'diverged' || status === 'unknown';
  return [
    initialized && { label: 'Open in new window', run: () => act({ kind: 'submoduleOpen', path }) },
    initialized && { label: 'Open in terminal', run: () => act({ kind: 'worktreeTerminal', path: folder }) },
    initialized && { label: REVEAL, run: () => act({ kind: 'worktreeReveal', path: folder }) },
    initialized && { label: 'Show in Gitardo', run: () => post({ type: 'selectRepo', root: folder }) },
    'separator',
    !initialized && { label: 'Initialize', run: () => act({ kind: 'submoduleUpdate', path }) },
    moved && recorded !== null && {
      label: `Update to the recorded commit ${shortHash(recorded)}`,
      run: () => act({ kind: 'submoduleUpdate', path }),
    },
    moved && head !== null && {
      label: `Stage ${shortHash(head)} as the recorded commit`,
      run: () => act({ kind: 'submoduleRecord', path }),
    },
    initialized && {
      label: submodule.branch ? `Update to the latest of ${submodule.branch}` : 'Update to the latest of its remote',
      run: () => act({ kind: 'submoduleUpdate', path, remote: true }),
    },
    { label: 'Synchronize URLs from .gitmodules', run: () => act({ kind: 'submoduleSync' }) },
    'separator',
    { label: 'Copy path', run: () => copy(path) },
    !!submodule.url && { label: 'Copy URL', run: () => copy(submodule.url) },
    'separator',
    initialized && { label: 'Deinitialize…', danger: true, run: () => act({ kind: 'submoduleDeinit', path }) },
    { label: 'Remove…', danger: true, run: () => act({ kind: 'submoduleRemove', path }) },
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

  // A branch another worktree has checked out is rebased there, not from here.
  if (!source.local || source.hash === target.hash || (!source.current && worktreeOf(name, state))) return [];
  const onto = target.hash;
  const short = shortHash(onto);
  if (!source.current) return [{ label: `Rebase ${name} onto ${short}`, run: () => act({ kind: 'rebase', onto, branch: name }) }];
  return [
    { label: `Rebase ${name} onto ${short}`, run: () => act({ kind: 'rebase', onto }) },
    { label: `Reset ${name} to ${short}…`, run: () => act({ kind: 'reset', hash: onto }) },
  ];
}
