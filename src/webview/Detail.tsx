import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { said } from '../shared/message';
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

/**
 * What a message says under its title. A long one shows its first lines, which leaves the files in sight, and
 * the rest when asked: in place, so that nothing scrolls inside the details but the details.
 */
function Said({ text }: { text: string }) {
  const [whole, setWhole] = useState(false);
  // Whether there is more than the lines shown: known once they are laid out, and again when the width changes.
  const [cut, setCut] = useState(false);
  const element = useRef<HTMLPreElement>(null);

  useLayoutEffect(() => {
    const shown = element.current;
    if (!shown || whole) return;
    const measure = () => setCut(shown.scrollHeight > shown.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shown);
    return () => observer.disconnect();
  }, [text, whole]);

  return (
    <div className="said">
      <pre ref={element} className={whole ? 'body' : 'body clamped'}>
        {text}
      </pre>
      {(cut || whole) && (
        <button className="link more" aria-expanded={whole} onClick={() => setWhole(!whole)}>
          {whole ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

export function Detail({ hash, detail, onJump, onClose }: Props) {
  const worktree = hash === WORKTREE;
  const message = useMemo(() => (detail ? said(detail.subject, detail.body) : null), [detail]);
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
          <h2>{message?.title}</h2>
          {message?.text && <Said key={hash} text={message.text} />}
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
