import type { RepoState } from '../shared/protocol';
import { worktreeLabel } from '../shared/refs';
import { Icon } from './Icon';
import { post } from './vscode';

/** Says that the views show a worktree other than the folder of this window, and goes back to it. */
export function WorktreeBanner({ state, busy }: { state: RepoState; busy: boolean }) {
  const { home } = state;
  if (!home) return null;
  const on = state.branch ? ` on ${state.branch}` : '';
  return (
    <div className="banner worktree" role="status">
      <Icon name="worktree" />
      <span className="grow" title={state.root}>
        Showing the worktree {worktreeLabel(state.root, state.worktreesRoot)}
        {on}
      </span>
      <button className="button" disabled={busy} onClick={() => post({ type: 'selectRepo', root: home.root })} title={home.root}>
        Back to {home.name}
      </button>
    </div>
  );
}
