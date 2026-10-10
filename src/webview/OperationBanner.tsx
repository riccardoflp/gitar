import type { RepoState } from '../shared/protocol';
import { Icon } from './Icon';
import { act } from './menus';

const NAMES = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' };

/** Shown while a merge, rebase, cherry-pick or revert has stopped and waits for the user. */
export function OperationBanner({ state, busy }: { state: RepoState; busy: boolean }) {
  const { operation } = state;
  if (!operation) return null;
  const conflicts = state.working.conflicts.length;
  return (
    <div className="banner" role="status">
      <Icon name="warning" />
      <span className="grow">
        {NAMES[operation]} in progress
        {conflicts > 0 && ` · ${conflicts} ${conflicts === 1 ? 'file has' : 'files have'} conflicts`}
      </span>
      <button
        className="button"
        disabled={busy || conflicts > 0}
        title={conflicts > 0 ? 'Resolve the conflicts and stage the files first' : undefined}
        onClick={() => act({ kind: 'continue' })}
      >
        Continue
      </button>
      {operation !== 'merge' && (
        <button className="button" disabled={busy} onClick={() => act({ kind: 'skip' })}>
          Skip
        </button>
      )}
      <button className="button" disabled={busy} onClick={() => act({ kind: 'abort' })}>
        Abort
      </button>
    </div>
  );
}
