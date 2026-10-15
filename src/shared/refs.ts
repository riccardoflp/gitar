import type { Branch, RepoState, Worktree } from './protocol';

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

/** A worktree where new ones go by its path from there, slashes and all; any other by the name of its folder. */
export function worktreeLabel(dir: string, root: string | null): string {
  if (root && dir.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return dir.slice(root.length + 1);
  return dir.split('/').pop() ?? dir;
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
