import type { RefKind, RepoState, Scope } from './protocol';

type Refs = Pick<RepoState, 'branch' | 'branches' | 'remoteBranches' | 'tags'>;

/** A branch, remote branch or tag there is to choose: `ref` is its full name, which is what a scope is made of. */
export interface ScopeChoice {
  ref: string;
  name: string;
  kind: RefKind;
  current: boolean;
}

/** Every kind of reference, in the order they are listed everywhere. */
export const REF_KINDS: RefKind[] = ['branch', 'remote', 'tag'];

/**
 * No more references than this are chosen one by one: each is an argument of `git log`, and a command line has an
 * end. The local branches all together are not counted, being one argument however many they are.
 */
export const MAX_SCOPE_REFS = 200;

export const SCOPE_PREFIXES = ['refs/heads/', 'refs/remotes/', 'refs/tags/'];

/** Every branch, remote branch and tag of the repository, in the order they are listed everywhere else. */
export function scopeChoices(state: Refs): ScopeChoice[] {
  return [
    ...state.branches.map((branch) => ({ ref: `refs/heads/${branch.name}`, name: branch.name, kind: 'branch' as const, current: branch.current })),
    ...state.remoteBranches.map((ref) => ({ ref: `refs/remotes/${ref.name}`, name: ref.name, kind: 'remote' as const, current: false })),
    ...state.tags.map((tag) => ({ ref: `refs/tags/${tag.name}`, name: tag.name, kind: 'tag' as const, current: false })),
  ];
}

/**
 * What a scope that comes from a view or from storage is worth in this repository: nothing is taken for granted of
 * its shape, and the references that are not there, or no longer, are left out. Null when all the history is left.
 */
export function pruneScope(scope: unknown, state: Refs): Scope | null {
  if (!scope || typeof scope !== 'object') return null;
  const { kind, kinds, refs } = scope as { kind?: unknown; kinds?: unknown; refs?: unknown };
  if (kind === 'current') return { kind };
  // Remembered from before the kinds of references could be chosen apart: the local branches alone.
  if (kind === 'local') return { kind: 'kinds', kinds: ['branch'] };
  if (kind === 'kinds') return Array.isArray(kinds) ? kindsScope(REF_KINDS.filter((each) => kinds.includes(each))) : null;
  if (kind !== 'refs' || !Array.isArray(refs)) return null;
  const known = new Set(scopeChoices(state).map((choice) => choice.ref));
  const kept = [...new Set(refs)].filter((ref): ref is string => typeof ref === 'string' && known.has(ref));
  return kept.length ? { kind: 'refs', refs: kept.slice(0, MAX_SCOPE_REFS) } : null;
}

/** The scope that shows these kinds of references: none, and so all the history, when they are all there or none is. */
export function kindsScope(kinds: RefKind[]): Scope | null {
  const kept = REF_KINDS.filter((kind) => kinds.includes(kind));
  return kept.length && kept.length < REF_KINDS.length ? { kind: 'kinds', kinds: kept } : null;
}

/** The kinds of references the graph shows, or null when it shows references chosen one by one, or what is checked out. */
export function scopeKinds(scope: Scope | null): RefKind[] | null {
  if (!scope) return REF_KINDS;
  return scope.kind === 'kinds' ? scope.kinds : null;
}

/** The references whose history a scope shows, by their full names. Checked out with no branch, there is none to name. */
export function scopeRefs(scope: Scope, state: Refs): string[] {
  if (scope.kind === 'refs') return scope.refs;
  if (scope.kind === 'kinds') return scopeChoices(state).flatMap((choice) => (scope.kinds.includes(choice.kind) ? [choice.ref] : []));
  return state.branch ? [`refs/heads/${state.branch}`] : [];
}

/** The scope with a reference added, or taken out if it is there: no scope, and so all the history, when none is left. */
export function toggleScopeRef(scope: Scope | null, ref: string, state: Refs): Scope | null {
  const chosen = scope ? scopeRefs(scope, state) : [];
  const next = chosen.includes(ref) ? chosen.filter((other) => other !== ref) : [...chosen, ref];
  return next.length ? { kind: 'refs', refs: next } : null;
}

/** The name of a reference as it is shown: `main`, `origin/main`, `v1.0`. */
export const scopeRefName = (ref: string) => ref.replace(/^refs\/(heads|remotes|tags)\//, '');

const KINDS_LABELS: Record<string, string> = {
  branch: 'Local branches',
  remote: 'Remote branches',
  tag: 'Tags',
  'branch remote': 'Branches',
  'branch tag': 'Local branches and tags',
  'remote tag': 'Remote branches and tags',
};

/** A scope in a few words, for a button: "Current branch", "Remote branches", "main", "main +2". */
export function scopeLabel(scope: Scope | null): string {
  if (!scope) return 'All branches';
  if (scope.kind === 'current') return 'Current branch';
  if (scope.kind === 'kinds') return KINDS_LABELS[scope.kinds.join(' ')] ?? 'All branches';
  const [first, ...others] = scope.refs.map(scopeRefName);
  return others.length ? `${first} +${others.length}` : first;
}
