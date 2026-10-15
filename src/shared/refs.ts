import type { Branch, PullRequest, RepoState, Worktree } from './protocol';

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
