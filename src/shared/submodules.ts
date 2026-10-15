import type { RepoState, Submodule } from './protocol';

/**
 * Where a submodule stands against the commit recorded for it: on it, with commits of its own after it, behind it, or
 * both. `uninitialized` has no repository in its folder, `added` has nothing recorded yet, and `unknown` does not have
 * the recorded commit, so cannot be compared with it.
 */
export type SubmoduleStatus = 'uninitialized' | 'added' | 'unknown' | 'synced' | 'ahead' | 'behind' | 'diverged';

export function submoduleStatus(submodule: Submodule): SubmoduleStatus {
  if (!submodule.head) return 'uninitialized';
  if (!submodule.recorded) return 'added';
  if (submodule.ahead === null || submodule.behind === null) return 'unknown';
  if (submodule.ahead && submodule.behind) return 'diverged';
  if (submodule.ahead) return 'ahead';
  if (submodule.behind) return 'behind';
  return 'synced';
}

const short = (hash: string) => hash.slice(0, 7);
const commits = (count: number) => (count === 1 ? '1 commit' : `${count} commits`);

/** What its status icon says, in a sentence. */
export function submoduleStatusText(submodule: Submodule): string {
  const recorded = submodule.recorded ? short(submodule.recorded) : '';
  switch (submoduleStatus(submodule)) {
    case 'uninitialized':
      return 'Not initialized: its folder has no checkout';
    case 'added':
      return 'Added, not committed yet';
    case 'unknown':
      return `The recorded commit ${recorded} is not in it: fetch in it, or update it`;
    case 'synced':
      return `On the recorded commit ${recorded}`;
    case 'ahead':
      return `${commits(submodule.ahead!)} ahead of the recorded commit ${recorded}`;
    case 'behind':
      return `${commits(submodule.behind!)} behind the recorded commit ${recorded}`;
    case 'diverged':
      return `${commits(submodule.ahead!)} ahead of and ${commits(submodule.behind!)} behind the recorded commit ${recorded}`;
  }
}

/** Its folder on disk, with forward slashes as the root has them. */
export const submoduleFolder = (submodule: Submodule, state: Pick<RepoState, 'root'>) => `${state.root.replace(/[\\/]+$/, '')}/${submodule.path}`;

/** How many submodules it is inside: 0 for one of the repository itself. */
export function submoduleDepth(submodule: Submodule, all: Submodule[]): number {
  let depth = 0;
  for (let parent = submodule.parent; parent; parent = all.find((each) => each.path === parent)?.parent ?? '') depth++;
  return depth;
}
