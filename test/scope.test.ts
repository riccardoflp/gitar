import { describe, expect, it } from 'vitest';
import type { Branch, NamedRef } from '../src/shared/protocol';
import { MAX_SCOPE_REFS, kindsScope, pruneScope, scopeChoices, scopeKinds, scopeLabel, scopeRefName, scopeRefs, toggleScopeRef } from '../src/shared/scope';

const branch = (name: string, current = false): Branch => ({ name, hash: 'a'.repeat(40), current });
const named = (name: string): NamedRef => ({ name, hash: 'b'.repeat(40) });

const state = {
  branch: 'main',
  branches: [branch('feature'), branch('main', true)],
  remoteBranches: [named('origin/main')],
  tags: [named('v1.0'), named('main')],
};

describe('the branches the graph is narrowed to', () => {
  it('lists what there is to choose by full name, so that a tag and a branch of the same name are two', () => {
    expect(scopeChoices(state).map((choice) => `${choice.kind} ${choice.ref}${choice.current ? ' *' : ''}`)).toEqual([
      'branch refs/heads/feature',
      'branch refs/heads/main *',
      'remote refs/remotes/origin/main',
      'tag refs/tags/v1.0',
      'tag refs/tags/main',
    ]);
    expect(['refs/heads/a/b', 'refs/remotes/origin/a', 'refs/tags/v1'].map(scopeRefName)).toEqual(['a/b', 'origin/a', 'v1']);
  });

  it('takes nothing for granted of a scope that comes from outside', () => {
    expect(pruneScope(null, state)).toBeNull();
    expect(pruneScope('local', state)).toBeNull();
    expect(pruneScope({ kind: 'everything' }, state)).toBeNull();
    expect(pruneScope({ kind: 'refs' }, state)).toBeNull();
    expect(pruneScope({ kind: 'refs', refs: 'refs/heads/main' }, state)).toBeNull();
    expect(pruneScope({ kind: 'current', refs: ['--all'] }, state)).toEqual({ kind: 'current' });
    // The local branches as they were remembered before the kinds of references could be chosen apart.
    expect(pruneScope({ kind: 'local' }, state)).toEqual({ kind: 'kinds', kinds: ['branch'] });
    expect(pruneScope({ kind: 'kinds', kinds: ['tag', 'remote', 'tag', '--all'] }, state)).toEqual({ kind: 'kinds', kinds: ['remote', 'tag'] });
    // All of them, or none, is the whole history.
    expect(pruneScope({ kind: 'kinds', kinds: ['branch', 'remote', 'tag'] }, state)).toBeNull();
    expect(pruneScope({ kind: 'kinds', kinds: [] }, state)).toBeNull();
    expect(pruneScope({ kind: 'kinds', kinds: 'remote' }, state)).toBeNull();
    // What is not a reference of the repository is not passed on to git, whatever it looks like.
    expect(pruneScope({ kind: 'refs', refs: ['--all', 'main', 7, 'refs/heads/gone', 'refs/heads/main', 'refs/heads/main'] }, state)).toEqual({
      kind: 'refs',
      refs: ['refs/heads/main'],
    });
    // With none of them left, the graph shows everything rather than nothing.
    expect(pruneScope({ kind: 'refs', refs: ['refs/heads/gone'] }, state)).toBeNull();
    expect(pruneScope({ kind: 'refs', refs: [] }, state)).toBeNull();
  });

  it('keeps no more references than fit on a command line', () => {
    const many = { ...state, branches: Array.from({ length: MAX_SCOPE_REFS + 50 }, (_, index) => branch(`b${index}`)) };
    const all = many.branches.map((one) => `refs/heads/${one.name}`);
    expect(pruneScope({ kind: 'refs', refs: all }, many)).toEqual({ kind: 'refs', refs: all.slice(0, MAX_SCOPE_REFS) });
  });

  it('says which references a scope shows', () => {
    expect(scopeRefs({ kind: 'current' }, state)).toEqual(['refs/heads/main']);
    expect(scopeRefs({ kind: 'current' }, { ...state, branch: null })).toEqual([]);
    const upstream = { name: 'origin/main', remote: 'origin', branch: 'main', ahead: 1, behind: 0, gone: false };
    const tracking = { ...state, branches: [branch('feature'), { ...branch('main', true), upstream }] };
    expect(scopeRefs({ kind: 'current', upstream: true }, tracking)).toEqual(['refs/heads/main', 'refs/remotes/origin/main']);
    expect(scopeRefs({ kind: 'current', upstream: true }, state)).toEqual(['refs/heads/main']);
    expect(pruneScope({ kind: 'current', upstream: true }, state)).toEqual({ kind: 'current', upstream: true });
    expect(pruneScope({ kind: 'current', upstream: 'yes' }, state)).toEqual({ kind: 'current' });
    expect(scopeRefs({ kind: 'kinds', kinds: ['branch'] }, state)).toEqual(['refs/heads/feature', 'refs/heads/main']);
    expect(scopeRefs({ kind: 'kinds', kinds: ['remote', 'tag'] }, state)).toEqual(['refs/remotes/origin/main', 'refs/tags/v1.0', 'refs/tags/main']);
    expect(scopeRefs({ kind: 'refs', refs: ['refs/tags/v1.0'] }, state)).toEqual(['refs/tags/v1.0']);
  });

  it('adds a reference and takes it out, starting from whatever was shown', () => {
    const tag = 'refs/tags/v1.0';
    expect(toggleScopeRef(null, tag, state)).toEqual({ kind: 'refs', refs: [tag] });
    expect(toggleScopeRef({ kind: 'refs', refs: [tag] }, tag, state)).toBeNull();
    expect(toggleScopeRef({ kind: 'refs', refs: [tag, 'refs/heads/main'] }, tag, state)).toEqual({ kind: 'refs', refs: ['refs/heads/main'] });
    // The current branch and the local ones become the branches they are now, with the change made to them.
    expect(toggleScopeRef({ kind: 'current' }, tag, state)).toEqual({ kind: 'refs', refs: ['refs/heads/main', tag] });
    expect(toggleScopeRef({ kind: 'current' }, 'refs/heads/main', state)).toBeNull();
    expect(toggleScopeRef({ kind: 'kinds', kinds: ['branch'] }, 'refs/heads/feature', state)).toEqual({ kind: 'refs', refs: ['refs/heads/main'] });
  });

  it('switches the kinds of references on and off', () => {
    expect(kindsScope(['remote'])).toEqual({ kind: 'kinds', kinds: ['remote'] });
    expect(kindsScope(['tag', 'branch'])).toEqual({ kind: 'kinds', kinds: ['branch', 'tag'] });
    expect(kindsScope(['remote', 'tag', 'branch'])).toBeNull();
    expect(kindsScope([])).toBeNull();
    expect(scopeKinds(null)).toEqual(['branch', 'remote', 'tag']);
    expect(scopeKinds({ kind: 'kinds', kinds: ['remote'] })).toEqual(['remote']);
    // Chosen one by one, or what is checked out, they are not shown by kind.
    expect(scopeKinds({ kind: 'current' })).toBeNull();
    expect(scopeKinds({ kind: 'refs', refs: ['refs/heads/main'] })).toBeNull();
  });

  it('names a scope in the few words a button has room for', () => {
    expect(scopeLabel(null)).toBe('All branches');
    expect(scopeLabel({ kind: 'current' })).toBe('Current branch');
    expect(scopeLabel({ kind: 'current', upstream: true })).toBe('Current and upstream');
    expect(scopeLabel({ kind: 'kinds', kinds: ['branch'] })).toBe('Local branches');
    expect(scopeLabel({ kind: 'kinds', kinds: ['remote'] })).toBe('Remote branches');
    expect(scopeLabel({ kind: 'kinds', kinds: ['branch', 'remote'] })).toBe('Branches');
    expect(scopeLabel({ kind: 'kinds', kinds: ['remote', 'tag'] })).toBe('Remote branches and tags');
    expect(scopeLabel({ kind: 'refs', refs: ['refs/remotes/origin/main'] })).toBe('origin/main');
    expect(scopeLabel({ kind: 'refs', refs: ['refs/heads/main', 'refs/tags/v1.0', 'refs/heads/feature'] })).toBe('main +2');
  });
});
