import { useEffect, useRef, useState } from 'react';
import { said } from '../shared/message';
import type { CommitDetail, DiffSource, FilePatch, FilesLayout, RepoState } from '../shared/protocol';
import { buildLabels } from './labels';
import { BackToTop } from './BackToTop';
import { LABEL_ICONS } from './CommitList';
import { FileChanges } from './FileChanges';
import { FileRow } from './FileRow';
import { Icon } from './Icon';
import { fileMenu } from './menus';
import { fullDate, shortHash } from './util';
import { onMessage, post } from './vscode';

interface Props {
  /** The full hash of the commit this tab is of. */
  hash: string;
  /** The repository it is in, which may not be the one the other views show. */
  root: string;
  layout: FilesLayout;
}

/** One commit in an editor tab: its whole message, the files it changed and what it changed in each. */
export function CommitApp({ hash, root, layout: remembered }: Props) {
  // Undefined while they are asked for; null when git has none to give.
  const [detail, setDetail] = useState<CommitDetail | null>();
  const [patch, setPatch] = useState<FilePatch[] | null>();
  const [state, setState] = useState<RepoState | null>(null);
  const [layout, setLayout] = useState(remembered);
  // The changes of the files are in the page only once asked for.
  const [diffs, setDiffs] = useState(false);
  const page = useRef<HTMLElement>(null);

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

  if (detail === undefined) return <div className="empty">Loading the commit…</div>;
  if (!detail) return <div className="empty">This commit is not in the repository any more.</div>;

  const source: DiffSource = { kind: 'commit', hash: detail.hash, parent: detail.parents[0] ?? null };
  const title = `${shortHash(detail.hash)} ${detail.subject}`;
  const message = said(detail.subject, detail.body);
  // The labels are those of the repository the other views show, which may be another by now.
  const labels = state?.root === root ? (buildLabels(state).get(detail.hash) ?? []) : [];
  const choose = (wanted: FilesLayout) => {
    setLayout(wanted);
    post({ type: 'setFilesLayout', layout: wanted });
  };

  return (
    <>
      <main ref={page} className="commit-page">
        <header className="commit-head">
          <h1>{message.title}</h1>
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
          {message.text && <pre className="body">{message.text}</pre>}
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

        <FileChanges
          files={detail.files}
          patch={patch}
          source={source}
          title={title}
          layout={layout}
          onLayout={choose}
          note={detail.parents.length > 1 && <span className="muted"> against the first parent</span>}
          fileMenu={(file) => fileMenu(file, source)}
          shown={diffs}
          onShown={setDiffs}
        >
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
        </FileChanges>
      </main>
      <BackToTop page={page} />
    </>
  );
}
