import type { ReactNode } from 'react';
import type { Filter, RepoState } from '../shared/protocol';
import { Icon } from './Icon';
import { post } from './vscode';

function describe(filter: Filter): ReactNode {
  if (filter.kind === 'path') {
    return (
      <>
        History of <b>{filter.path}</b>
        {filter.renamedFrom?.length ? <span className="muted"> · earlier {filter.renamedFrom.join(', ')}</span> : null}
      </>
    );
  }
  if (filter.kind === 'ref') {
    return (
      <>
        Only the history of <b>{filter.ref.replace(/^refs\/(heads|remotes|tags)\//, '')}</b>
      </>
    );
  }
  const what = {
    message: 'Commits whose message contains',
    author: 'Commits by authors matching',
    pickaxe: 'Commits that add or remove',
    regex: 'Commits whose changed lines match',
  }[filter.kind];
  return (
    <>
      {what} <b>{filter.query}</b>
    </>
  );
}

/** Shown while the graph is narrowed to the history of a file or to the results of a search. */
export function FilterBar({ state }: { state: RepoState }) {
  const { filter } = state;
  if (!filter) return null;
  const count = state.rows.length;
  return (
    <div className="filterbar" role="status">
      <Icon name="filter" />
      <span className="grow">
        {describe(filter)}
        <span className="muted">
          {' · '}
          {count}
          {state.hasMore ? '+' : ''} {count === 1 ? 'commit' : 'commits'}
        </span>
      </span>
      <button className="button" onClick={() => post({ type: 'setFilter', filter: null })}>
        <Icon name="close" />
        Show all commits
      </button>
    </div>
  );
}
