import { WORKTREE, type CommitDetail, type DiffSource } from '../shared/protocol';
import { FILES_LIMIT, useCapped } from './Capped';
import { FileRow } from './FileRow';
import { Icon } from './Icon';
import { fullDate, shortHash } from './util';
import { post } from './vscode';

interface Props {
  hash: string;
  detail: CommitDetail | null;
  onJump(hash: string): void;
  onClose(): void;
}

export function Detail({ hash, detail, onJump, onClose }: Props) {
  const worktree = hash === WORKTREE;
  const source: DiffSource = worktree
    ? { kind: 'worktree' }
    : { kind: 'commit', hash, parent: detail?.parents[0] ?? null };
  const [files, moreFiles] = useCapped(detail?.files ?? [], FILES_LIMIT, 'files', hash);
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
          <h2>{detail.subject}</h2>
          {detail.body && <pre className="body">{detail.body}</pre>}
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
          <div className="files">
            {files.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                onOpen={() => post({ type: 'openDiff', source, file })}
                actions={[
                  {
                    icon: 'history',
                    title: 'Show the history of this file',
                    run: () => post({ type: 'setFilter', filter: { kind: 'path', path: file.path } }),
                  },
                ]}
              />
            ))}
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
