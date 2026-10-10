import type { RepoState } from '../shared/protocol';
import { Icon } from './Icon';
import { act } from './menus';
import { shortHash } from './util';

/** Shown while a bisect is in progress: says what git needs next and takes the answer for the commit that is checked out. */
export function BisectBanner({ state, busy, onShow }: { state: RepoState; busy: boolean; onShow?(hash: string): void }) {
  const { bisect, head } = state;
  if (!bisect) return null;
  const { good, bad, suspects } = bisect;
  const found = suspects === 1 && bad !== null;
  const waiting = !bad ? 'mark a bad commit to begin' : !good.length ? 'mark a good commit to begin' : null;
  const answer = (mark: 'good' | 'bad' | 'skip') => () => act({ kind: 'bisect', mark });
  return (
    <div className="banner bisect" role="status">
      <Icon name="search" />
      <span className="grow">
        {found
          ? `Bisect: the first bad commit is ${shortHash(bad)}`
          : waiting
            ? `Bisect: ${waiting}`
            : `Bisect: test ${head ? shortHash(head) : 'this commit'} · ${suspects} commits can still be the first bad one`}
      </span>
      {found && onShow && (
        <button className="button" onClick={() => onShow(bad)}>
          Show
        </button>
      )}
      {!found && !waiting && (
        <>
          <button className="button" disabled={busy} onClick={answer('good')} title="git bisect good">
            Good
          </button>
          <button className="button" disabled={busy} onClick={answer('bad')} title="git bisect bad">
            Bad
          </button>
          <button className="button" disabled={busy} onClick={answer('skip')} title="git bisect skip: this commit cannot be tested">
            Skip
          </button>
        </>
      )}
      <button className="button" disabled={busy} onClick={() => act({ kind: 'bisectReset' })} title="git bisect reset">
        End
      </button>
    </div>
  );
}
