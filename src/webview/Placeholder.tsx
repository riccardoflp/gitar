import { post } from './vscode';

/** What a view shows in place of a repository: that it is being read, or that there is none. */
export function Placeholder({ loaded }: { loaded: boolean }) {
  if (!loaded) return <div className="empty">Loading repository…</div>;
  return (
    <div className="empty">
      <p>No Git repository in this workspace</p>
      <button className="button" onClick={() => post({ type: 'refresh' })}>
        Check again
      </button>
    </div>
  );
}
