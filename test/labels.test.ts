import { describe, expect, it } from 'vitest';
import type { Branch, PullRequest, RepoState } from '../src/shared/protocol';
import { buildLabels } from '../src/webview/labels';

const pull = (number: number): PullRequest => ({ number, title: `Change ${number}`, url: `https://github.com/o/r/pull/${number}`, draft: false, checks: 'success' });
const upstream = (name: string) => ({ name, remote: 'origin', branch: name.slice('origin/'.length), ahead: 0, behind: 0, gone: false });

const state = (overrides: Partial<RepoState>) =>
  ({
    head: 'aaa',
    branch: 'main',
    branches: [],
    remoteBranches: [],
    tags: [],
    stashes: [],
    worktrees: [],
    remotes: ['origin'],
    pulls: {},
    github: { owner: 'o', repo: 'r' },
    bisect: null,
    ...overrides,
  }) as Partial<RepoState> as RepoState;

describe('the labels of the commits in the graph', () => {
  const feature: Branch = { name: 'feature', hash: 'bbb', current: false, upstream: upstream('origin/feature') };

  it('puts the pull request of a branch on its label, once, where the local branch tracks the remote one', () => {
    const labels = buildLabels(
      state({
        branches: [feature],
        remoteBranches: [
          { name: 'origin/feature', hash: 'bbb' },
          { name: 'origin/other', hash: 'ccc' },
        ],
        pulls: { feature: pull(7), other: pull(9) },
      }),
    );
    expect(labels.get('bbb')).toEqual([
      { kind: 'branch', name: 'feature', current: false, worktree: undefined, pull: { request: pull(7), branch: 'feature' } },
      { kind: 'remote', name: 'origin/feature', pull: undefined },
    ]);
    // A remote branch no local one tracks has it on its own label.
    expect(labels.get('ccc')?.[0].pull).toEqual({ request: pull(9), branch: 'other' });
  });

  it('has no pull request where the repository is not on GitHub, or the branch was never pushed', () => {
    const pulls = { feature: pull(7) };
    const remoteBranches = [{ name: 'origin/feature', hash: 'ccc' }];
    expect(buildLabels(state({ branches: [{ ...feature, upstream: undefined }], pulls })).get('bbb')?.[0].pull).toBeUndefined();
    expect(buildLabels(state({ remoteBranches, pulls, github: null })).get('ccc')?.[0].pull).toBeUndefined();
  });
});
