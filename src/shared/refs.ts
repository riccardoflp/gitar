import type { Branch, BranchSort, NamedRef, PullRequest, RepoState, Worktree } from './protocol';

const KINDS = { branch: 'refs/heads/', remote: 'refs/remotes/', tag: 'refs/tags/' } as const;

/**
 * How to name a branch or a tag to git where it expects a commit. The short name will do, unless something else is
 * called the same: of a branch and a tag both called `release`, git takes the tag, whichever was meant.
 */
export function refArg(kind: keyof typeof KINDS, name: string, state: RepoState): string {
  const lists = [state.branches, state.remoteBranches, state.tags];
  const namesakes = lists.filter((list) => list.some((ref) => ref.name === name)).length;
  return namesakes > 1 ? `${KINDS[kind]}${name}` : name;
}

/**
 * The branches, remote branches and tags in the order the settings ask for: by name, as git lists them, or the one
 * committed to last first, and by name among those of the same time.
 */
export function sortRefs<T extends Pick<RepoState, 'branches' | 'remoteBranches' | 'tags'>>(refs: T, sort: BranchSort): T {
  if (sort === 'name') return refs;
  const latest = <R extends NamedRef>(list: R[]) => [...list].sort((one, other) => (other.date ?? 0) - (one.date ?? 0));
  return { ...refs, branches: latest(refs.branches), remoteBranches: latest(refs.remoteBranches), tags: latest(refs.tags) };
}

/**
 * How well a name matches what was typed, the best first: the whole name, its last part after a slash, as
 * `origin/main` for `main`, the start of the name, the start of one of its parts, then anywhere in it. Null when it
 * does not have it at all. Neither the name nor `needle`, already in lower case, cares about case.
 */
export function matchRank(name: string, needle: string): number | null {
  const lower = name.toLowerCase();
  const at = lower.indexOf(needle);
  if (at < 0) return null;
  if (lower === needle) return 0;
  if (lower.endsWith(`/${needle}`)) return 1;
  if (at === 0) return 2;
  if (lower.split(/[/._-]/).some((part) => part.startsWith(needle))) return 3;
  return 4;
}

/** The items whose names have what was typed, the best matches first and in their own order among equals. */
export function byMatch<T>(items: T[], nameOf: (item: T) => string, needle: string): T[] {
  if (!needle) return items;
  return items
    .map((item) => ({ item, rank: matchRank(nameOf(item), needle) }))
    .filter((each): each is { item: T; rank: number } => each.rank !== null)
    .sort((one, other) => one.rank - other.rank)
    .map((each) => each.item);
}

/** A worktree where new ones go by its path from there, slashes and all; any other by the name of its folder. */
export function worktreeLabel(dir: string, root: string | null): string {
  if (root && dir.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return dir.slice(root.length + 1);
  return dir.split('/').pop() ?? dir;
}

/** The worktree that is the folder of this window, while the views show another worktree of its repository. */
export function isHome(dir: string, state: RepoState): boolean {
  const same = (path: string) => path.replace(/\\/g, '/').toLowerCase();
  return !!state.home && same(dir) === same(state.home.root);
}

/** The other worktree that has a branch checked out, where it is to be worked on: git checks it out nowhere else. */
export function worktreeOf(branch: string, state: RepoState): Worktree | undefined {
  return state.worktrees.find((worktree) => worktree.branch === branch && !worktree.current);
}

/**
 * Whether a branch that is not checked out can be moved up to its upstream without a merge: it has no commits of its own.
 * How far behind it is counts only what the last fetch saw, so it is offered whatever that says: the fetch finds out.
 */
export function canFastForward(branch: Branch, state: RepoState): boolean {
  const upstream = branch.upstream;
  if (branch.current || !upstream || upstream.gone || upstream.ahead > 0) return false;
  // Git refuses to move a branch that another worktree has checked out, as its files would no longer match.
  return !state.worktrees.some((worktree) => worktree.branch === branch.name);
}

/** `feature/x` for `origin/feature/x`: the name a remote-tracking branch has on its remote. */
export function nameOnRemote(ref: string, state: RepoState): string | null {
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

const CHECKS = { success: 'checks passed', failure: 'checks failed', pending: 'checks running' };

/** A pull request in a line: `Pull request #12: Add the parser · checks passed`. */
export function pullTitle(pull: PullRequest): string {
  const checks = pull.checks ? ` · ${CHECKS[pull.checks]}` : '';
  return `${pull.draft ? 'Draft pull' : 'Pull'} request #${pull.number}: ${pull.title}${checks}`;
}

/** `↑1 ↓2` for the commits a branch and its upstream have that the other has not, or `gone` when the upstream was deleted. */
export function upstreamHint(branch: Branch): string | undefined {
  const upstream = branch.upstream;
  if (!upstream) return undefined;
  if (upstream.gone) return 'gone';
  return [upstream.ahead && `↑${upstream.ahead}`, upstream.behind && `↓${upstream.behind}`].filter(Boolean).join(' ') || undefined;
}

/** What a worktree has that is not committed, said in words. */
export function changesText(changes: number | null): string | undefined {
  if (changes === null) return undefined;
  if (!changes) return 'Nothing to commit';
  return `${changes} ${changes === 1 ? 'file' : 'files'} not committed`;
}

/** What is known of a worktree beyond its folder: its branch and how it stands against its upstream, and its pull request. */
export function worktreeStatus(worktree: Worktree, state: RepoState): { branch?: Branch; ahead?: string; pull?: PullRequest } {
  const branch = worktree.branch === null ? undefined : state.branches.find((candidate) => candidate.name === worktree.branch);
  if (!branch) return {};
  return { branch, ahead: upstreamHint(branch), pull: pullOf(pushedName(branch, state), state) };
}
