import { useState } from 'react';
import type { CompareCommit, CompareSide, CompareView } from '../shared/protocol';
import { useCapped } from './Capped';
import { Icon } from './Icon';
import { relativeTime, shortHash } from './util';
import { post } from './vscode';

/** How many commits of a side are listed before asking. */
const COMMITS_LIMIT = 300;

const counted = (count: number) => `${count} ${count === 1 ? 'commit' : 'commits'}`;

interface GroupProps {
  side: CompareSide;
  other: CompareSide;
  /** The ones listed, newest first. */
  commits: CompareCommit[];
  /** How many there are, listed or not. */
  count: number;
  /** The file or the folder the commits listed are those of. */
  path: string | null;
}

/** The commits one side has that the other has not. */
function Group({ side, other, commits, count, path }: GroupProps) {
  const [open, setOpen] = useState(true);
  const [listed, more] = useCapped(commits, COMMITS_LIMIT, 'commits');
  const equivalent = commits.filter((commit) => commit.equivalent).length;
  const same = `${other.name} has the same change in a commit of its own: it was cherry-picked, or rebased`;
  return (
    <section className="compare-group" aria-label={`Only in ${side.name}`}>
      <h3>
        <button className="twist" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the commits only in ${side.name}`}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        </button>
        <button className="grow compare-group-title" onClick={() => setOpen(!open)}>
          Only in <strong>{side.name}</strong>
        </button>
        <span className="muted">
          {path ? `${commits.length} of ${counted(count)} change ${path}` : counted(count)}
          {equivalent > 0 && `, ${equivalent} also in ${other.name}`}
        </span>
      </h3>
      {open && (
        <div className="compare-list">
          {listed.map((commit) => (
            <button
              key={commit.hash}
              className={`compare-commit${commit.equivalent ? ' equivalent' : ''}`}
              title="Open this commit in a tab of its own"
              onClick={() => post({ type: 'openCommit', hash: commit.hash })}
            >
              <span className="mono hash">{shortHash(commit.hash)}</span>
              <span className="subject">{commit.subject}</span>
              {commit.equivalent && (
                <span className="same" title={same}>
                  <Icon name="check-all" />
                  also in {other.name}
                </span>
              )}
              <span className="muted author">{commit.author}</span>
              <span className="muted date">{relativeTime(commit.date)}</span>
            </button>
          ))}
          {more}
          {!path && count > commits.length && <p className="muted compare-note">The newest {commits.length} are listed.</p>}
        </div>
      )}
    </section>
  );
}

/**
 * The commits each side of a comparison has that the other has not, the ones whose change the other has too in a
 * commit of its own marked.
 */
export function CompareCommits({ view }: { view: CompareView }) {
  const { from, to, ahead, behind, commits, matched, path } = view;
  if (!ahead && !behind) return null;
  const of = (side: CompareCommit['side']) => commits.filter((commit) => commit.side === side);
  return (
    <section className="compare-commits" aria-label="Commits">
      <h2>
        <span className="grow">Commits</span>
        {!matched && <span className="muted">Too many to look for the same changes on the other side</span>}
      </h2>
      {ahead > 0 && <Group side={to} other={from} commits={of('to')} count={ahead} path={path} />}
      {behind > 0 && <Group side={from} other={to} commits={of('from')} count={behind} path={path} />}
    </section>
  );
}
