import type { RepoState } from '../shared/protocol';
import { post } from './vscode';

/**
 * Chooses which repository of the workspace every Gitardo view shows. Nothing is rendered when there is only one, unless
 * the views show a worktree that is not in the workspace, which is listed too.
 */
export function RepoSelect({ state, disabled }: { state: RepoState; disabled: boolean }) {
  if (state.repos.length < 2 && !state.home) return null;
  return (
    <select
      className="repo"
      value={state.root}
      disabled={disabled}
      aria-label="Repository"
      title={state.root}
      onChange={(event) => post({ type: 'selectRepo', root: event.target.value })}
    >
      {state.repos.map((repo) => (
        <option key={repo.root} value={repo.root}>
          {repo.name}
        </option>
      ))}
      {state.home && <option value={state.root}>{state.name} (worktree)</option>}
    </select>
  );
}
