import { unpushedCommits, type Ahead } from '../shared/graph';
import type { RepoState } from '../shared/protocol';
import { nameOnRemote, pullOf, pushedName, worktreeOf } from '../shared/refs';
import type { Label } from './CommitList';

/** The branches, tags, stashes and bisect marks of each commit that has some, with the open pull request of a branch. */
export function buildLabels(state: RepoState): Map<string, Label[]> {
  const labels = new Map<string, Label[]>();
  const add = (hash: string, label: Label) => {
    const list = labels.get(hash);
    if (list) list.push(label);
    else labels.set(hash, [label]);
  };
  if (state.head && !state.branch) add(state.head, { kind: 'head', name: 'HEAD', current: true });
  const pullFor = (name: string | null): Label['pull'] => {
    const request = pullOf(name, state);
    return request && name !== null ? { request, branch: name } : undefined;
  };
  for (const branch of state.branches) {
    const worktree = worktreeOf(branch.name, state)?.path;
    add(branch.hash, { kind: 'branch', name: branch.name, current: branch.current, worktree, pull: pullFor(pushedName(branch, state)) });
  }
  // The pull request of a remote branch is said on the local branch that tracks it, when there is one.
  const tracked = new Set(state.branches.map((branch) => branch.upstream?.name));
  for (const remote of state.remoteBranches) {
    const pull = state.github && !tracked.has(remote.name) ? pullFor(nameOnRemote(remote.name, state)) : undefined;
    add(remote.hash, { kind: 'remote', name: remote.name, pull });
  }
  for (const tag of state.tags) add(tag.hash, { kind: 'tag', name: tag.name });
  for (const stash of state.stashes) add(stash.hash, { kind: 'stash', name: stash.ref });
  if (state.bisect) {
    const { good, bad, skipped } = state.bisect;
    for (const hash of good) add(hash, { kind: 'good', name: 'good' });
    if (bad) add(bad, { kind: 'bad', name: 'bad' });
    for (const hash of skipped) add(hash, { kind: 'skipped', name: 'skipped' });
  }
  return labels;
}

/** The commits of each local branch that its upstream has not yet, by hash, with the upstream they would be pushed to. */
export function unpushedOf(state: RepoState): Map<string, string> {
  const ahead: Ahead[] = [];
  for (const branch of state.branches) {
    const upstream = branch.upstream;
    const tip = upstream && !upstream.gone && upstream.ahead ? state.remoteBranches.find((ref) => ref.name === upstream.name) : undefined;
    if (upstream && tip) ahead.push({ tip: branch.hash, upstream: upstream.name, upstreamTip: tip.hash, ahead: upstream.ahead });
  }
  return ahead.length ? unpushedCommits(state.rows, ahead) : new Map();
}
