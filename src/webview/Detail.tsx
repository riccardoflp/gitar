import { useEffect, useMemo, useState } from 'react';
import { WORKTREE, type CommitDetail, type DiffSource, type FileChange, type FilesLayout } from '../shared/protocol';
import { fileTree } from '../shared/tree';
import { FILES_LIMIT, useCapped } from './Capped';
import { FileRow } from './FileRow';
import { FileTree, toggled } from './FileTree';
import { Icon } from './Icon';
import { fullDate, shortHash } from './util';
import { loadUiState, post, saveUiState } from './vscode';

interface Props {
  hash: string;
  detail: CommitDetail | null;
  onJump(hash: string): void;
  onClose(): void;
}

const NONE: ReadonlySet<string> = new Set();

export function Detail({ hash, detail, onJump, onClose }: Props) {
  const worktree = hash === WORKTREE;
  const source: DiffSource = worktree
    ? { kind: 'worktree' }
    : { kind: 'commit', hash, parent: detail?.parents[0] ?? null };
  const [files, moreFiles] = useCapped(detail?.files ?? [], FILES_LIMIT, 'files', hash);
  // One after the other, each with its directory beside its name, or under their directories: as the view was left.
  const [layout, setLayout] = useState(() => loadUiState({ detailFiles: 'list' as FilesLayout }).detailFiles);
  const [folded, setFolded] = useState(NONE);
  const tree = useMemo(() => (layout === 'tree' ? fileTree(files, (file) => file.path) : []), [layout, files]);
  // The directories of another commit are other directories.
  useEffect(() => setFolded(NONE), [hash]);

  const choose = (wanted: FilesLayout) => {
    setLayout(wanted);
    saveUiState({ detailFiles: wanted });
  };
  const row = (file: FileChange, depth?: number) => (
    <FileRow
      key={file.path}
      file={file}
      depth={depth}
      onOpen={() => post({ type: 'openDiff', source, file })}
      actions={[
        {
          icon: 'history',
          title: 'Show the history of this file',
          run: () => post({ type: 'setFilter', filter: { kind: 'path', path: file.path } }),
        },
      ]}
    />
  );

  return (
    <aside className="detail" aria-label="Commit details">
      <button className="button icon close" onClick={onClose} aria-label="Close details" title="Close">
        <Icon name="close" />
      </button>
      {!worktree && (
        <button
          className="button icon open-tab"
          onClick={() => post({ type: 'openCommit', hash })}
          aria-label="Open in an editor tab"
          title="Open in an editor tab, with its changes"
        >
          <Icon name="link-external" />
        </button>
      )}
      {!detail ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {/* A long message scrolls in the few lines it has, and leaves the files in sight: the tab of the commit has it whole. */}
          <div className="said">
            <h2>{detail.subject}</h2>
            {detail.body && <pre className="body">{detail.body}</pre>}
          </div>
          {!worktree && (
            <dl>
              <dt>Author</dt>
              <dd title={detail.email}>{detail.author}</dd>
              <dt>Date</dt>
              <dd>{fullDate(detail.date)}</dd>
              {(detail.committer !== detail.author || detail.commitDate !== detail.date) && (
                <>
                  <dt>Committer</dt>
                  <dd title={detail.committerEmail}>
                    {detail.committer}, {fullDate(detail.commitDate)}
                  </dd>
                </>
              )}
              <dt>Commit</dt>
              <dd>
                <button
                  className="link mono"
                  title="Copy full hash"
                  onClick={() => post({ type: 'copy', text: detail.hash })}
                >
                  {shortHash(detail.hash)} <Icon name="copy" />
                </button>
              </dd>
              {detail.parents.length > 0 && (
                <>
                  <dt>{detail.parents.length > 1 ? 'Parents' : 'Parent'}</dt>
                  <dd>
                    {detail.parents.map((parent) => (
                      <button key={parent} className="link mono" onClick={() => onJump(parent)}>
                        {shortHash(parent)}
                      </button>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          )}
          <h3>
            <span className="grow">
              {detail.files.length} changed {detail.files.length === 1 ? 'file' : 'files'}
              {detail.parents.length > 1 && <span className="muted"> against the first parent</span>}
            </span>
            {detail.files.length > 0 && (
              <>
                <button
                  className={`button icon${layout === 'tree' ? ' on' : ''}`}
                  aria-pressed={layout === 'tree'}
                  title="Under their directories"
                  aria-label="Files as a tree"
                  onClick={() => choose('tree')}
                >
                  <Icon name="list-tree" />
                </button>
                <button
                  className={`button icon${layout === 'list' ? ' on' : ''}`}
                  aria-pressed={layout === 'list'}
                  title="One after the other, each with its directory"
                  aria-label="Files as a list"
                  onClick={() => choose('list')}
                >
                  <Icon name="list-flat" />
                </button>
              </>
            )}
            {detail.files.length > 1 && (
              <button
                className="button icon"
                title="Open all changes in one editor"
                aria-label="Open all changes in one editor"
                onClick={() =>
                  post({
                    type: 'openChanges',
                    source,
                    files: detail.files,
                    title: worktree ? 'Uncommitted changes' : `${shortHash(detail.hash)} ${detail.subject}`,
                  })
                }
              >
                <Icon name="diff-multiple" />
              </button>
            )}
          </h3>
          <div className={`files ${layout}`}>
            {layout === 'tree' ? (
              <FileTree nodes={tree} folded={folded} onFold={(path) => setFolded((current) => toggled(current, path))} row={row} />
            ) : (
              files.map((file) => row(file))
            )}
            {moreFiles}
          </div>
          {detail.untracked && (
            <>
              <h3>
                {detail.untracked.files.length} untracked {detail.untracked.files.length === 1 ? 'file' : 'files'}
              </h3>
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
        </>
      )}
    </aside>
  );
}
