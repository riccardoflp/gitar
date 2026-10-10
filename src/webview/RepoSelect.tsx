import type { RepoState } from '../shared/protocol';
import { post } from './vscode';

/** Chooses which repository of the workspace every Gitar view shows. Nothing is rendered when there is only one. */
export function RepoSelect({ state, disabled }: { state: RepoState; disabled: boolean }) {
  if (state.repos.length < 2) return null;
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
    </select>
  );
}
