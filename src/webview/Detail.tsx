import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { said } from '../shared/message';
import { WORKTREE, type CommitDetail, type DiffSource, type FileChange, type FilesLayout } from '../shared/protocol';
import { fileTree } from '../shared/tree';
import { FILES_LIMIT, useCapped } from './Capped';
import { ActionButtons, Check, FileRow, type FileAction } from './FileRow';
import { FileTree, toggled } from './FileTree';
import { Icon } from './Icon';
import { act } from './menus';
import { fullDate, shortHash } from './util';
import { loadUiState, post, saveUiState } from './vscode';

interface Props {
  hash: string;
  detail: CommitDetail | null;
  /** For the changes that are not committed: whether they can be stashed, and all discarded at once. */
  changes?: { stash: boolean; discardAll: boolean };
  /** Whether the message of the commit can be changed from here, and whether it is being changed. */
  reword?: boolean;
  editing?: boolean;
  onEditing?(editing: boolean): void;
  onJump(hash: string): void;
  onClose(): void;
}

const NONE: ReadonlySet<string> = new Set();

/** A file renamed is passed with its old name, which git needs to put it back or set it aside. */
const pathsOf = (file: FileChange) => (file.oldPath ? [file.path, file.oldPath] : [file.path]);

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

/**
 * The message of a commit in a box to change it: Ctrl+Enter or Save gives it to the commit, Escape or Cancel leaves it
 * as it was.
 */
function MessageEditor({ message, onSave, onCancel }: { message: string; onSave(message: string): void; onCancel(): void }) {
  const [text, setText] = useState(message);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  const unchanged = text.trim() === message.trim();
  const save = () => {
    if (!text.trim()) return;
    if (unchanged) onCancel();
    else onSave(text.trim());
  };
  return (
    <div className="message-editor">
      <textarea
        ref={box}
        value={text}
        rows={Math.min(12, Math.max(3, text.split('\n').length + 1))}
        aria-label="Commit message"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            save();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="message-actions">
        <span className="grow muted">Ctrl+Enter to save</span>
        <button className="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="button primary" disabled={!text.trim() || unchanged} onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}

export function Detail({ hash, detail, changes, reword, editing, onEditing, onJump, onClose }: Props) {
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
  // The uncommitted files ticked to stash or discard together, by their paths; the ones gone are let go.
  const [picked, setPicked] = useState(NONE);
  useEffect(() => setPicked(NONE), [hash]);
  useEffect(() => {
    const present = new Set(detail?.files.map((file) => file.path));
    setPicked((current) => ([...current].every((path) => present.has(path)) ? current : new Set([...current].filter((path) => present.has(path)))));
  }, [detail]);
  const chosen = worktree ? (detail?.files ?? []).filter((file) => picked.has(file.path)) : [];
  const pick = (file: FileChange, on: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(file.path);
      else next.delete(file.path);
      return next;
    });

  const choose = (wanted: FilesLayout) => {
    setLayout(wanted);
    saveUiState({ detailFiles: wanted });
  };
  const fileActions = (file: FileChange): FileAction[] => {
    const history = { icon: 'history', title: 'Show the history of this file', run: () => post({ type: 'setFilter', filter: { kind: 'path', path: file.path } }) };
    if (!worktree) return [history];
    return [
      file.status !== '?' && history,
      changes?.stash && { icon: 'git-stash', title: 'Stash this file…', run: () => act({ kind: 'stashPush', paths: pathsOf(file) }) },
      { icon: 'discard', title: 'Discard all changes in this file, staged too…', run: () => act({ kind: 'discardChanges', paths: pathsOf(file) }) },
    ].filter((action): action is FileAction => Boolean(action));
  };
  // What the buttons above the files do: to the files ticked, or to all of them.
  const changesActions = (): FileAction[] => {
    const paths = chosen.flatMap(pathsOf);
    const some = chosen.length === 1 ? '1 selected file' : `${chosen.length} selected files`;
    return [
      changes?.stash && {
        icon: 'git-stash',
        title: chosen.length ? `Stash ${some}…` : 'Stash all changes…',
        run: () => act(chosen.length ? { kind: 'stashPush', paths } : { kind: 'stashPush' }),
      },
      (chosen.length > 0 || changes?.discardAll) && {
        icon: 'discard',
        title: chosen.length ? `Discard all changes in ${some}…` : 'Discard all changes…',
        run: () => act(chosen.length ? { kind: 'discardChanges', paths } : { kind: 'discardChanges' }),
      },
    ].filter((action): action is FileAction => Boolean(action));
  };
  const row = (file: FileChange, depth?: number) => (
    <FileRow
      key={file.path}
      file={file}
      depth={depth}
      onOpen={() => post({ type: 'openDiff', source, file })}
      actions={fileActions(file)}
      picked={picked.has(file.path)}
      onPick={worktree ? (on) => pick(file, on) : undefined}
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
      {reword && !worktree && detail && !editing && (
        <button className="button icon open-tab" onClick={() => onEditing?.(true)} aria-label="Edit message" title="Edit message">
          <Icon name="edit" />
        </button>
      )}
      {!detail ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {editing && !worktree ? (
            <MessageEditor
              key={hash}
              message={detail.body ? `${detail.subject}\n\n${detail.body}` : detail.subject}
              onSave={(text) => {
                act({ kind: 'reword', hash, message: text });
                onEditing?.(false);
              }}
              onCancel={() => onEditing?.(false)}
            />
          ) : (
            <>
              <h2>{message?.title}</h2>
              {message?.text && <Said key={hash} text={message.text} />}
            </>
          )}
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
            {worktree && detail.files.length > 0 && (
              <Check
                checked={chosen.length === detail.files.length}
                mixed={chosen.length > 0 && chosen.length < detail.files.length}
                label="Select all files"
                onChange={(all) => setPicked(all ? new Set(detail.files.map((file) => file.path)) : NONE)}
              />
            )}
            <span className="grow">
              {detail.files.length} changed {detail.files.length === 1 ? 'file' : 'files'}
              {chosen.length > 0 && <span className="muted">, {chosen.length} selected</span>}
              {detail.parents.length > 1 && <span className="muted"> against the first parent</span>}
            </span>
            {worktree && detail.files.length > 0 && <ActionButtons actions={changesActions()} />}
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
