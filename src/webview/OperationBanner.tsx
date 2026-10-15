import type { RepoState } from '../shared/protocol';
import { Icon } from './Icon';
import { act } from './menus';

const NAMES = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' };

const RESOLVE_TITLE =
  'Resolve the conflicts that need no choice between the two sides: changes to lines next to each other, the same change made by both, ' +
  'differences in spaces or line endings only. Gitardo asks first and can show what it would write; the other conflicts stay as they are.';

/** How many of the conflicts marked in the files need no choice between their two sides, and how many there are. */
export function resolvableConflicts(state: RepoState, path?: string): [resolvable: number, marked: number] {
  const files = state.conflictFiles.filter((file) => path === undefined || file.path === path);
  return [files.reduce((sum, file) => sum + file.resolvable.length, 0), files.reduce((sum, file) => sum + file.conflicts, 0)];
}

/**
 * Shown while a merge, rebase, cherry-pick or revert has stopped and waits for the user, and while files are in
 * conflict without one, as after a stash was applied.
 */
export function OperationBanner({ state, busy }: { state: RepoState; busy: boolean }) {
  const { operation } = state;
  const conflicts = state.working.conflicts.length;
  if (!operation && !conflicts) return null;
  const [resolvable, marked] = resolvableConflicts(state);
  const files = `${conflicts} ${conflicts === 1 ? 'file has' : 'files have'} conflicts`;
  return (
    <div className="banner" role="status">
      <Icon name="warning" />
      <span className="grow">
        {operation ? `${NAMES[operation]} in progress${conflicts > 0 ? ` · ${files}` : ''}` : files}
      </span>
      {resolvable > 0 && (
        <button className="button resolve" disabled={busy} title={RESOLVE_TITLE} onClick={() => act({ kind: 'resolveConflicts' })}>
          <Icon name="wand" />
          Resolve {resolvable === marked ? (marked === 1 ? 'it' : `all ${marked}`) : `${resolvable} of ${marked}`} automatically
        </button>
      )}
      {operation && (
        <button
          className="button"
          disabled={busy || conflicts > 0}
          title={conflicts > 0 ? 'Resolve the conflicts and stage the files first' : undefined}
          onClick={() => act({ kind: 'continue' })}
        >
          Continue
        </button>
      )}
      {operation && operation !== 'merge' && (
        <button className="button" disabled={busy} onClick={() => act({ kind: 'skip' })}>
          Skip
        </button>
      )}
      {operation && (
        <button className="button" disabled={busy} onClick={() => act({ kind: 'abort' })}>
          Abort
        </button>
      )}
    </div>
  );
}
