import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { CommitDetail, DiffSource, FileChange, FilePatch, FilesLayout, Hunk, RepoState } from '../shared/protocol';
import { fileTree, type TreeNode } from '../shared/tree';
import { buildLabels } from './App';
import { FILES_LIMIT, useCapped } from './Capped';
import { LABEL_ICONS } from './CommitList';
import { FileRow, INDENT, Status, fileTitle } from './FileRow';
import { Icon } from './Icon';
import { fullDate, shortHash } from './util';
import { onMessage, post } from './vscode';

interface Props {
  /** The full hash of the commit this tab is of. */
  hash: string;
  /** The repository it is in, which may not be the one the other views show. */
  root: string;
  layout: FilesLayout;
}

/** The diff of a file longer than this is left folded until it is asked for, as are the ones after this many lines are shown. */
const FILE_LINES = 800;
const OPEN_LINES = 5000;

const NONE: ReadonlySet<string> = new Set();

const linesOf = (hunks: Hunk[]) => hunks.reduce((sum, hunk) => sum + hunk.lines.length + 1, 0);

/** A file of the commit as it is listed: with what changed in it, once that is known. */
interface Entry {
  file: FileChange;
  patch?: FilePatch;
  /** Where its diff is in the page. */
  id: string;
}

function Stat({ patch }: { patch?: FilePatch }) {
  if (!patch) return null;
  if (patch.binary) return <span className="stat muted">binary</span>;
  return (
    <span className="stat" title={`${patch.added} added, ${patch.removed} removed`}>
      {patch.added > 0 && <span className="plus">+{patch.added}</span>}
      {patch.removed > 0 && <span className="minus">−{patch.removed}</span>}
    </span>
  );
}

/** The lines of a diff, with the number each has in the file before and after. */
const Lines = memo(function Lines({ hunks }: { hunks: Hunk[] }) {
  let last = 0;
  const rows = hunks.map((hunk, at) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk.header);
    let before = Number(match?.[1] ?? 0);
    let after = Number(match?.[2] ?? 0);
    const lines = hunk.lines.map((line, index) => {
      const sign = line[0];
      // What git says of a file that does not end with a line break.
      if (sign === '\\') {
        return (
          <div key={index} className="line note">
            <span className="number" />
            <span className="number" />
            <span className="code">{line.slice(2)}</span>
          </div>
        );
      }
      const old = sign === '+' ? '' : before++;
      const now = sign === '-' ? '' : after++;
      return (
        <div key={index} className={sign === '+' ? 'line added' : sign === '-' ? 'line removed' : 'line'}>
          <span className="number">{old}</span>
          <span className="number">{now}</span>
          <span className="code">
            {sign}
            {line.slice(1).replace(/\r$/, '')}
          </span>
        </div>
      );
    });
    last = Math.max(last, before, after);
    return (
      <div key={at} className="hunk-lines">
        <div className="line at">
          <span className="number" />
          <span className="number" />
          <span className="code">{hunk.header}</span>
        </div>
        {lines}
      </div>
    );
  });
  // The numbers get the room the longest of them needs.
  return (
    <div className="diff-lines" style={{ '--digits': String(last).length } as CSSProperties}>
      {rows}
    </div>
  );
});

interface DiffProps {
  entry: Entry;
  open: boolean;
  onToggle(): void;
  onOpen(): void;
}

function FileDiff({ entry, open, onToggle, onOpen }: DiffProps) {
  const { file, patch } = entry;
  const inEditor = (
    <button className="link" onClick={onOpen}>
      Open it in the diff editor
    </button>
  );
  let body = null;
  if (open && patch) {
    if (patch.binary) body = <p className="muted diff-note">Binary file. {inEditor}</p>;
    else if (!patch.hunks) body = <p className="muted diff-note">Too long to show with the others. {inEditor}</p>;
    else if (!patch.hunks.length) body = <p className="muted diff-note">{file.status === 'R' ? 'Renamed, with no change to its text.' : 'No change to its text.'}</p>;
    else body = <Lines hunks={patch.hunks} />;
  }
  return (
    <section className="file-diff" id={entry.id} aria-label={file.path}>
      <header>
        <button className="twist" onClick={onToggle} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the changes of ${file.path}`}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        </button>
        <Status file={file} />
        <button className="path grow mono" title={fileTitle(file)} onClick={onToggle}>
          {fileTitle(file)}
        </button>
        <Stat patch={patch} />
        <button className="button icon" title="Open in the diff editor" aria-label={`Open ${file.path} in the diff editor`} onClick={onOpen}>
          <Icon name="diff" />
        </button>
      </header>
      {body}
    </section>
  );
}

interface TreeProps {
  nodes: TreeNode<Entry>[];
  depth: number;
  folded: ReadonlySet<string>;
  onFold(path: string): void;
  onShow(entry: Entry): void;
  onOpen(entry: Entry): void;
}

function Tree({ nodes, depth, folded, onFold, onShow, onOpen }: TreeProps) {
  return nodes.map((node) => {
    if (node.item) {
      const entry = node.item;
      return (
        <FileRow
          key={`file:${node.path}`}
          file={entry.file}
          depth={depth}
          onOpen={() => onShow(entry)}
          extra={<Stat patch={entry.patch} />}
          actions={[{ icon: 'diff', title: 'Open in the diff editor', run: () => onOpen(entry) }]}
        />
      );
    }
    const open = !folded.has(node.path);
    return (
      <div key={`directory:${node.path}`}>
        <button className="file directory" style={{ paddingLeft: 12 + depth * INDENT }} aria-expanded={open} onClick={() => onFold(node.path)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <span className="name">{node.name}</span>
        </button>
        {open && <Tree nodes={node.children} depth={depth + 1} folded={folded} onFold={onFold} onShow={onShow} onOpen={onOpen} />}
      </div>
    );
  });
}

const toggled = (set: ReadonlySet<string>, value: string) => {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
};

/** One commit in an editor tab: its whole message, the files it changed and what it changed in each. */
export function CommitApp({ hash, root, layout: remembered }: Props) {
  // Undefined while they are asked for; null when git has none to give.
  const [detail, setDetail] = useState<CommitDetail | null>();
  const [patch, setPatch] = useState<FilePatch[] | null>();
  const [state, setState] = useState<RepoState | null>(null);
  const [layout, setLayout] = useState(remembered);
  const [folded, setFolded] = useState(NONE);
  // The diffs unfolded or folded by hand: the others are as their length says.
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());

  useEffect(() => {
    const stop = onMessage((message) => {
      if (message.type === 'state') setState(message.state);
      else if (message.type === 'detail' && message.hash === hash) setDetail(message.detail);
      else if (message.type === 'patch' && message.hash === hash) setPatch(message.patch);
    });
    post({ type: 'ready' });
    post({ type: 'getDetail', hash });
    post({ type: 'getPatch', hash });
    return stop;
  }, [hash]);

  const entries = useMemo<Entry[]>(
    () => (detail?.files ?? []).map((file, index) => ({ file, patch: patch?.[index], id: `diff-${index}` })),
    [detail, patch],
  );
  const [listed, more] = useCapped(entries, FILES_LIMIT, 'files');
  const tree = useMemo(() => (layout === 'tree' ? fileTree(listed, (entry) => entry.file.path) : []), [layout, listed]);

  // Short diffs are unfolded as the tab opens, until there are a few thousand lines of them.
  const unfolded = useMemo(() => {
    const open = new Set<string>();
    let lines = 0;
    for (const entry of entries) {
      const own = entry.patch?.hunks ? linesOf(entry.patch.hunks) : 0;
      if (own > FILE_LINES || lines + own > OPEN_LINES) continue;
      lines += own;
      open.add(entry.id);
    }
    return open;
  }, [entries]);
  const isOpen = (entry: Entry) => chosen.get(entry.id) ?? unfolded.has(entry.id);

  if (detail === undefined) return <div className="empty">Loading the commit…</div>;
  if (!detail) return <div className="empty">This commit is not in the repository any more.</div>;

  const source: DiffSource = { kind: 'commit', hash: detail.hash, parent: detail.parents[0] ?? null };
  const title = `${shortHash(detail.hash)} ${detail.subject}`;
  // The labels are those of the repository the other views show, which may be another by now.
  const labels = state?.root === root ? (buildLabels(state).get(detail.hash) ?? []) : [];
  const added = patch?.reduce((sum, file) => sum + file.added, 0) ?? 0;
  const removed = patch?.reduce((sum, file) => sum + file.removed, 0) ?? 0;
  const allOpen = listed.length > 0 && listed.every(isOpen);

  const openDiff = (entry: Entry) => post({ type: 'openDiff', source, file: entry.file });
  const show = (entry: Entry) => {
    setChosen((current) => new Map(current).set(entry.id, true));
    // Once it is unfolded: the page is as long as its diffs.
    requestAnimationFrame(() => document.getElementById(entry.id)?.scrollIntoView({ block: 'start' }));
  };
  const choose = (wanted: FilesLayout) => {
    setLayout(wanted);
    post({ type: 'setFilesLayout', layout: wanted });
  };

  return (
    <main className="commit-page">
      <header className="commit-head">
        <h1>{detail.subject}</h1>
        {labels.length > 0 && (
          <div className="message commit-labels">
            {labels.map((label) => (
              <span key={`${label.kind}:${label.name}`} className={`label ${label.kind}${label.current ? ' current' : ''}`} title={label.name}>
                <Icon name={LABEL_ICONS[label.kind]} />
                {label.name}
              </span>
            ))}
          </div>
        )}
        {detail.body && <pre className="body">{detail.body}</pre>}
        <dl>
          <dt>Author</dt>
          <dd>
            {detail.author} <span className="muted">&lt;{detail.email}&gt;</span>
          </dd>
          <dt>Date</dt>
          <dd>{fullDate(detail.date)}</dd>
          {(detail.committer !== detail.author || detail.commitDate !== detail.date) && (
            <>
              <dt>Committer</dt>
              <dd>
                {detail.committer} <span className="muted">&lt;{detail.committerEmail}&gt;</span>, {fullDate(detail.commitDate)}
              </dd>
            </>
          )}
          <dt>Commit</dt>
          <dd>
            <button className="link mono" title="Copy the hash" onClick={() => post({ type: 'copy', text: detail.hash })}>
              {detail.hash} <Icon name="copy" />
            </button>
          </dd>
          {detail.parents.length > 0 && (
            <>
              <dt>{detail.parents.length > 1 ? 'Parents' : 'Parent'}</dt>
              <dd>
                {detail.parents.map((parent) => (
                  <button key={parent} className="link mono" title="Open this commit in a tab of its own" onClick={() => post({ type: 'openCommit', hash: parent })}>
                    {shortHash(parent)}
                  </button>
                ))}
              </dd>
            </>
          )}
        </dl>
        <div className="commit-actions">
          <button className="button" onClick={() => post({ type: 'reveal', hash: detail.hash })}>
            <Icon name="git-commit" />
            Show in the graph
          </button>
          {detail.files.length > 0 && (
            <button className="button" onClick={() => post({ type: 'openChanges', source, files: detail.files, title })}>
              <Icon name="diff-multiple" />
              Open in the diff editor
            </button>
          )}
        </div>
      </header>

      <section className="commit-files" aria-label="Changed files">
        <h2>
          <span className="grow">
            {detail.files.length} changed {detail.files.length === 1 ? 'file' : 'files'}
            {patch && (
              <span className="stat">
                <span className="plus">+{added}</span>
                <span className="minus">−{removed}</span>
              </span>
            )}
            {detail.parents.length > 1 && <span className="muted"> against the first parent</span>}
          </span>
          <button className={`button icon${layout === 'tree' ? ' on' : ''}`} aria-pressed={layout === 'tree'} title="Under their directories" aria-label="Files as a tree" onClick={() => choose('tree')}>
            <Icon name="list-tree" />
          </button>
          <button className={`button icon${layout === 'list' ? ' on' : ''}`} aria-pressed={layout === 'list'} title="One after the other" aria-label="Files as a list" onClick={() => choose('list')}>
            <Icon name="list-flat" />
          </button>
        </h2>
        <div className="files">
          {layout === 'tree' ? (
            <Tree nodes={tree} depth={0} folded={folded} onFold={(path) => setFolded((current) => toggled(current, path))} onShow={show} onOpen={openDiff} />
          ) : (
            listed.map((entry) => (
              <FileRow
                key={entry.file.path}
                file={entry.file}
                onOpen={() => show(entry)}
                extra={<Stat patch={entry.patch} />}
                actions={[{ icon: 'diff', title: 'Open in the diff editor', run: () => openDiff(entry) }]}
              />
            ))
          )}
          {more}
        </div>
        {detail.untracked && (
          <>
            <h2>
              {detail.untracked.files.length} untracked {detail.untracked.files.length === 1 ? 'file' : 'files'}
            </h2>
            <div className="files">
              {detail.untracked.files.map((file) => (
                <FileRow
                  key={file.path}
                  file={file}
                  onOpen={() => post({ type: 'openDiff', source: { kind: 'commit', hash: detail.untracked!.hash, parent: null }, file })}
                />
              ))}
            </div>
          </>
        )}
      </section>

      {detail.files.length > 0 && (
        <section className="commit-diffs" aria-label="Changes">
          <h2>
            <span className="grow">Changes</span>
            {patch && (
              <button
                className="button"
                onClick={() => setChosen(new Map(listed.map((entry) => [entry.id, !allOpen])))}
              >
                <Icon name={allOpen ? 'fold' : 'unfold'} />
                {allOpen ? 'Fold all' : 'Unfold all'}
              </button>
            )}
          </h2>
          {patch === undefined && <p className="muted">Loading the changes…</p>}
          {patch === null && (
            <p className="muted">
              Git lists these changes in a way that cannot be shown here.{' '}
              <button className="link" onClick={() => post({ type: 'openChanges', source, files: detail.files, title })}>
                Open them in the diff editor
              </button>
            </p>
          )}
          {patch &&
            listed.map((entry) => (
              <FileDiff
                key={entry.id}
                entry={entry}
                open={isOpen(entry)}
                onToggle={() => setChosen((current) => new Map(current).set(entry.id, !isOpen(entry)))}
                onOpen={() => openDiff(entry)}
              />
            ))}
        </section>
      )}
    </main>
  );
}
