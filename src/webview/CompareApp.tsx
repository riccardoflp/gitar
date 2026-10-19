import { useEffect, useRef, useState, type ReactNode } from 'react';
import { WORKTREE, type CompareMode, type CompareSide, type CompareView, type DiffSource, type FileChange, type FilePatch, type FilesLayout, type RepoState } from '../shared/protocol';
import { BackToTop } from './BackToTop';
import { CompareCommits } from './CompareCommits';
import { FileChanges } from './FileChanges';
import { Icon } from './Icon';
import { Progress } from './Progress';
import { shortHash } from './util';
import { onMessage, post } from './vscode';

interface Props {
  /** The repository the comparison is in, which may not be the one the other views show. */
  root: string;
  layout: FilesLayout;
}

const commits = (count: number) => `${count} ${count === 1 ? 'commit' : 'commits'}`;

/** The files a comparison lists, to tell whether the lines sent for them still fit. */
const listed = (view: CompareView | null | undefined) =>
  view ? `${view.path}\n${view.files.map((file) => `${file.status} ${file.oldPath ?? ''} ${file.path}`).join('\n')}` : '';

/** What a side is: a branch, a remote branch, a tag, another revision, or a commit. */
function sideIcon(side: CompareSide, state: RepoState | null): string {
  if (side.hash === WORKTREE) return 'files';
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
  const worktree = side.hash === WORKTREE;
  const followed = worktree
    ? 'The files as they are now, with the changes not committed'
    : side.gone
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
      {!worktree && side.name !== shortHash(side.hash) && (
        <button className="link mono" title="Open this commit in a tab of its own" onClick={() => post({ type: 'openCommit', hash: side.hash })}>
          {shortHash(side.hash)}
        </button>
      )}
      {side.gone && <span className="muted">gone</span>}
    </div>
  );
}

/** How far one is from the other: the commits it has that the other has not, and those it has not. */
function apart(subject: ReactNode, own: number, missing: number, other: ReactNode): ReactNode {
  if (own && missing) {
    return (
      <>
        {subject} is {commits(own)} ahead of {other} and {commits(missing)} behind.
      </>
    );
  }
  if (own) {
    return (
      <>
        {subject} is {commits(own)} ahead of {other}.
      </>
    );
  }
  return (
    <>
      {subject} is {commits(missing)} behind {other}, with none of its own.
    </>
  );
}

/** How far apart the two are: the commits each has that the other has not, and where they diverged. */
function Summary({ view }: { view: CompareView }) {
  const { from, to, ahead, behind, base } = view;
  const name = (side: CompareSide) => <strong>{side.name}</strong>;
  let said: ReactNode;
  if (from.hash === WORKTREE || to.hash === WORKTREE) {
    // The commits of the working tree are those of the commit checked out.
    const [other, own, missing] = from.hash === WORKTREE ? [to, behind, ahead] : [from, ahead, behind];
    said =
      own || missing ? apart('The commit checked out', own, missing, name(other)) : <>The commit checked out is {name(other)}: only the changes not committed differ.</>;
  } else if (from.hash === to.hash) said = <>The two are the same commit.</>;
  else said = apart(name(to), ahead, behind, name(from));
  const met =
    from.hash === to.hash ? null : !base ? (
      <> Their histories never meet.</>
    ) : base !== from.hash && base !== to.hash && from.hash !== WORKTREE && to.hash !== WORKTREE ? (
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
      {said}
      {met}
    </p>
  );
}

/** The most conflicting files named. */
const CONFLICTS_SHOWN = 10;

/** What merging the second side into the first would do: fast-forward, merge cleanly, or conflict in some files. */
function MergePreview({ view }: { view: CompareView }) {
  const { from, to, ahead, behind, conflicts } = view;
  if (from.hash === WORKTREE || to.hash === WORKTREE || !ahead) return null;
  const merging = (
    <>
      Merging <strong>{to.name}</strong> into <strong>{from.name}</strong>
    </>
  );
  if (!behind) {
    return (
      <p className="compare-merge">
        <Icon name="check" /> {merging} would fast-forward it.
      </p>
    );
  }
  if (!conflicts) return null;
  if (!conflicts.length) {
    return (
      <p className="compare-merge">
        <Icon name="check" /> {merging} would not conflict.
      </p>
    );
  }
  const more = conflicts.length - CONFLICTS_SHOWN;
  return (
    <div className="compare-merge conflicts">
      <p>
        <Icon name="warning" /> {merging} would conflict in {conflicts.length} {conflicts.length === 1 ? 'file' : 'files'}:
      </p>
      <ul>
        {conflicts.slice(0, CONFLICTS_SHOWN).map((file) => (
          <li key={file} className="mono">
            {file}
          </li>
        ))}
        {more > 0 && <li className="muted">and {more} more</li>}
      </ul>
    </div>
  );
}

/** Narrows the comparison to a file or a folder. */
function PathFilter({ path }: { path: string | null }) {
  const [draft, setDraft] = useState(path ?? '');
  // What the host narrowed it to, such as from the Explorer, is what the box says.
  useEffect(() => setDraft(path ?? ''), [path]);
  const apply = (wanted: string | null) => post({ type: 'setComparePath', path: wanted?.trim() || null });
  return (
    <form
      className="compare-path"
      onSubmit={(event) => {
        event.preventDefault();
        apply(draft);
      }}
    >
      <Icon name="filter" />
      <input
        type="text"
        className="mono"
        value={draft}
        aria-label="Only the changes of this file or folder"
        placeholder="Only a file or a folder, such as src/app"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && setDraft(path ?? '')}
      />
      {draft.trim() !== (path ?? '') && (
        <button type="submit" className="link">
          Apply
        </button>
      )}
      {path && (
        <button type="button" className="clear" title="Show the changes of every file" aria-label="Show the changes of every file" onClick={() => apply(null)}>
          <Icon name="close" />
        </button>
      )}
    </form>
  );
}

/** Makes the file in the working tree what the second side has. */
const takeAction = (file: FileChange, to: CompareSide) => ({
  icon: 'arrow-circle-down',
  title: file.status === 'D' ? `Delete it from the working tree, as ${to.name} has no such file` : `Take the version of ${to.name} into the working tree`,
  run: () => post({ type: 'takeCompareFile', file }),
});

/** Two branches, tags or commits compared in an editor tab: how far apart they are, and the files that differ. */
export function CompareApp({ root, layout: remembered }: Props) {
  // Undefined while it is asked for; null when git could not compare the two.
  const [view, setView] = useState<CompareView | null>();
  const [error, setError] = useState<string>();
  const [patch, setPatch] = useState<{ since: string; to: string; patch: FilePatch[] | null }>();
  const [state, setState] = useState<RepoState | null>(null);
  const [layout, setLayout] = useState(remembered);
  // The sides, the way or the path just changed, while git compares them again.
  const [comparing, setComparing] = useState(false);
  // The changes of the files are in the page only once asked for, and stay as the sides change.
  const [diffs, setDiffs] = useState(false);
  const shown = useRef<CompareView | null | undefined>(undefined);
  const page = useRef<HTMLElement>(null);

  useEffect(() => {
    const stop = onMessage((message) => {
      // The branches are those of the repository the other views show, which may be another.
      if (message.type === 'state') setState(message.state?.root === root ? message.state : null);
      else if (message.type === 'compareView') {
        // The working tree is compared again as it changes: the lines shown stay until the new ones come, as long as
        // they are of the same files.
        if (listed(message.view) !== listed(shown.current)) setPatch(undefined);
        shown.current = message.view;
        setView(message.view);
        setError(message.error);
      } else if (message.type === 'comparePatch') setPatch(message);
      else if (message.type === 'loading') setComparing(message.what !== null);
    });
    post({ type: 'ready' });
    return stop;
  }, [root]);

  const progress = comparing && <Progress page label="Comparing" />;
  if (view === undefined) return <div className="empty">Comparing…</div>;
  if (!view) {
    return (
      <>
        {progress}
        <div className="empty">The two could not be compared. {error}</div>
      </>
    );
  }

  const { from, to, mode, base, since, files, path } = view;
  const worktree = from.hash === WORKTREE || to.hash === WORKTREE;
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
    <>
      {progress}
      <main ref={page} className={comparing ? 'commit-page compare-page stale' : 'commit-page compare-page'}>
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
          <MergePreview view={view} />
          <PathFilter path={path} />
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
            {files.length > 0 && (
              <button className="button" title="Copy the changes as a patch that git apply takes" onClick={() => post({ type: 'copyComparePatch' })}>
                <Icon name="copy" />
                Copy as patch
              </button>
            )}
            {state?.github && !worktree && from.hash !== to.hash && (
              <button className="button" title="Compare the two on GitHub, once they are pushed" onClick={() => post({ type: 'openCompareOnGitHub' })}>
                <Icon name="github" />
                Open on GitHub
              </button>
            )}
          </div>
        </header>
  
        <CompareCommits key={`${from.hash} ${to.hash}`} view={view} />
  
        {/* Other sides are another list: what was folded or unfolded in it does not carry over. */}
        <FileChanges
          key={`${since} ${to.hash} ${path}`}
          files={files}
          patch={lines}
          source={source}
          title={title}
          layout={layout}
          onLayout={choose}
          note={
            <>
              {path && <span className="muted"> in {path}</span>}
              {diverged && files.length > 0 && base !== from.hash && <span className="muted"> since they diverged</span>}
            </>
          }
          fileActions={to.hash === WORKTREE ? undefined : (file) => [takeAction(file, to)]}
          diffs={diffs}
          onDiffs={setDiffs}
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
      <BackToTop page={page} />
    </>
  );
}
