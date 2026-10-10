import type { RepoState } from './protocol';

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
