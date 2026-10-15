import { useEffect, useState, type ReactNode } from 'react';
import type { CompareMode, CompareSide, CompareView, DiffSource, FilePatch, FilesLayout, RepoState } from '../shared/protocol';
import { FileChanges } from './FileChanges';
import { Icon } from './Icon';
import { shortHash } from './util';
import { onMessage, post } from './vscode';

interface Props {
  /** The repository the comparison is in, which may not be the one the other views show. */
  root: string;
  layout: FilesLayout;
}

const commits = (count: number) => `${count} ${count === 1 ? 'commit' : 'commits'}`;

/** What a side is: a branch, a remote branch, a tag, another revision, or a commit. */
function sideIcon(side: CompareSide, state: RepoState | null): string {
  if (!side.live) return 'git-commit';
  if (state?.branches.some((branch) => branch.name === side.name)) return 'git-branch';
  if (state?.remoteBranches.some((ref) => ref.name === side.name)) return 'cloud';
  if (state?.tags.some((ref) => ref.name === side.name)) return 'tag';
  return 'target';
}

interface SideProps {
  label: string;
  side: CompareSide;
  state: RepoState | null;
  which: 'from' | 'to';
}

function Side({ label, side, state, which }: SideProps) {
  const followed = side.gone
    ? `${side.name} no longer stands for a commit: the comparison stays where it was`
    : side.live
      ? `The comparison follows ${side.name} as it moves`
      : 'This commit';
  return (
    <div className="compare-side">
      <span className="compare-label">{label}</span>
      <button className="button compare-pick" title={`${followed}. Choose another branch, tag or commit`} onClick={() => post({ type: 'pickCompareSide', side: which })}>
        <Icon name={sideIcon(side, state)} />
        <span className="name">{side.name}</span>
        <Icon name="chevron-down" />
      </button>
      {side.name !== shortHash(side.hash) && (
        <button className="link mono" title="Open this commit in a tab of its own" onClick={() => post({ type: 'openCommit', hash: side.hash })}>
          {shortHash(side.hash)}
        </button>
      )}
      {side.gone && <span className="muted">gone</span>}
    </div>
  );
}

/** How far apart the two are: the commits each has that the other has not, and where they diverged. */
function Summary({ view }: { view: CompareView }) {
  const { from, to, ahead, behind, base } = view;
  const name = (side: CompareSide) => <strong>{side.name}</strong>;
  let apart: ReactNode;
  if (from.hash === to.hash) apart = <>The two are the same commit.</>;
  else if (ahead && behind) {
    apart = (
      <>
        {name(to)} is {commits(ahead)} ahead of {name(from)} and {commits(behind)} behind.
      </>
    );
  } else if (ahead) {
    apart = (
      <>
        {name(to)} is {commits(ahead)} ahead of {name(from)}.
      </>
    );
  } else {
    apart = (
      <>
        {name(to)} is {commits(behind)} behind {name(from)}, with none of its own.
      </>
    );
  }
  const met =
    from.hash === to.hash ? null : !base ? (
      <> Their histories never meet.</>
    ) : base !== from.hash && base !== to.hash ? (
      <>
        {' '}
        They diverged at{' '}
        <button className="link mono" title="Open this commit in a tab of its own" onClick={() => post({ type: 'openCommit', hash: base })}>
          {shortHash(base)}
        </button>
        .
      </>
    ) : null;
  return (
    <p className="compare-summary">
      {apart}
      {met}
    </p>
  );
}

/** Two branches, tags or commits compared in an editor tab: how far apart they are, and the files that differ. */
export function CompareApp({ root, layout: remembered }: Props) {
  // Undefined while it is asked for; null when git could not compare the two.
  const [view, setView] = useState<CompareView | null>();
  const [error, setError] = useState<string>();
  const [patch, setPatch] = useState<{ since: string; to: string; patch: FilePatch[] | null }>();
  const [state, setState] = useState<RepoState | null>(null);
  const [layout, setLayout] = useState(remembered);

  useEffect(() => {
    const stop = onMessage((message) => {
      // The branches are those of the repository the other views show, which may be another.
      if (message.type === 'state') setState(message.state?.root === root ? message.state : null);
      else if (message.type === 'compareView') {
        setView(message.view);
        setError(message.error);
      } else if (message.type === 'comparePatch') setPatch(message);
    });
    post({ type: 'ready' });
    return stop;
  }, [root]);

  if (view === undefined) return <div className="empty">Comparing…</div>;
  if (!view) return <div className="empty">The two could not be compared. {error}</div>;

  const { from, to, mode, base, since, files } = view;
  const source: DiffSource = { kind: 'commit', hash: to.hash, parent: since };
  const diverged = mode === 'diverged' && !!base;
  const title = diverged ? `${from.name}...${to.name}` : `${from.name} ↔ ${to.name}`;
  // The lines that came are for what is shown, or not yet.
  const lines = patch && patch.since === since && patch.to === to.hash ? patch.patch : undefined;
  const setMode = (wanted: CompareMode) => wanted !== mode && post({ type: 'setCompareMode', mode: wanted });
  const choose = (wanted: FilesLayout) => {
    setLayout(wanted);
    post({ type: 'setFilesLayout', layout: wanted });
  };

  return (
    <main className="commit-page compare-page">
      <header className="commit-head">
        <h1>Comparison</h1>
        <div className="compare-sides">
          <Side label="From" side={from} state={state} which="from" />
          <button className="button icon" title="Compare in the other direction" aria-label="Swap the two sides" onClick={() => post({ type: 'swapCompare' })}>
            <Icon name="arrow-swap" />
          </button>
          <Side label="To" side={to} state={state} which="to" />
        </div>
        <Summary view={view} />
        <div className="commit-actions">
          <div className="segmented" role="group" aria-label="What to compare">
            <button
              className={`button${diverged ? ' on' : ''}`}
              aria-pressed={diverged}
              disabled={!base}
              title={
                base
                  ? `What ${to.name} changed since it left ${from.name}, as a pull request shows it: git diff ${from.name}...${to.name}`
                  : 'Their histories never meet'
              }
              onClick={() => setMode('diverged')}
            >
              <Icon name="git-merge" />
              Since they diverged
            </button>
            <button
              className={`button${diverged ? '' : ' on'}`}
              aria-pressed={!diverged}
              title={`Everything that differs between the two: git diff ${from.name} ${to.name}`}
              onClick={() => setMode('direct')}
            >
              <Icon name="git-compare" />
              Everything that differs
            </button>
          </div>
          {files.length > 0 && (
            <button className="button" onClick={() => post({ type: 'openChanges', source, files, title })}>
              <Icon name="diff-multiple" />
              Open in the diff editor
            </button>
          )}
        </div>
      </header>

      {/* Other sides are another list: what was folded or unfolded in it does not carry over. */}
      <FileChanges
        key={`${since} ${to.hash}`}
        files={files}
        patch={lines}
        source={source}
        title={title}
        layout={layout}
        onLayout={choose}
        note={diverged && files.length > 0 && base !== from.hash && <span className="muted"> since they diverged</span>}
      >
        {!files.length && diverged && from.hash !== to.hash && (
          <p className="muted">
            {to.name} has changed nothing since it left {from.name}.{' '}
            <button className="link" onClick={() => setMode('direct')}>
              Show everything that differs
            </button>
          </p>
        )}
      </FileChanges>
    </main>
  );
}
