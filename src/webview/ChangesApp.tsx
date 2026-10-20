import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { workingChanges, type WorkingChange } from '../git/parse';
import type { FileChange, FilesLayout, RepoState } from '../shared/protocol';
import { fileTree } from '../shared/tree';
import { BisectBanner } from './BisectBanner';
import { FILES_LIMIT, useCapped } from './Capped';
import { ActionButtons, Check, FileRow, type FileAction } from './FileRow';
import { FileTree, toggled } from './FileTree';
import { Icon } from './Icon';
import { OperationBanner, resolvableConflicts } from './OperationBanner';
import { RepoSelect } from './RepoSelect';
import { WorktreeBanner } from './WorktreeBanner';
import { act } from './menus';
import { loadUiState, onMessage, post, saveUiState } from './vscode';

/** A staged rename covers two paths: unstaging only the new one would leave the deletion of the old one staged. */
const pathsOf = (file: FileChange) => (file.oldPath ? [file.path, file.oldPath] : [file.path]);

/** A diff as VS Code's list of changes opens it: what is not staged yet, or what is, when all of the file is. */
const SOURCE = { kind: 'change' } as const;

/**
 * A file of the list: a change git sees, or one only an editor has, not saved yet (`staged` null), which git sees
 * nothing of until it is saved.
 */
type Listed = WorkingChange | { file: FileChange; staged: null };

/** Where a file of the list is, for the tree. Stable, so that the tree is not made again at every render. */
const changePath = (change: Listed) => change.file.path;

const PICK_TITLES: Record<WorkingChange['staged'], string> = {
  all: 'Staged: click to unstage',
  some: 'Partly staged: click to stage all of it',
  none: 'Click to stage',
};

interface GroupProps<T> {
  title: string;
  items: T[];
  /** Before the title, such as the box that ticks every file. */
  lead?: ReactNode;
  headerActions?: FileAction[];
  /** `depth` is how far in the row is, when the files are under their directories. */
  row(item: T, depth?: number): ReactNode;
  /** Set to show the files under their directories, which open and close. */
  tree?: { path(item: T): string; folded: ReadonlySet<string>; onFold(path: string): void };
}

function Group<T>({ title, items, lead, headerActions, row, tree }: GroupProps<T>): ReactNode {
  const [listed, more] = useCapped(items, FILES_LIMIT, 'files');
  const nodes = useMemo(() => (tree ? fileTree(listed, tree.path) : []), [listed, tree?.path]);
  if (!items.length) return null;
  return (
    <section className="group" aria-label={title}>
      <header>
        {lead}
        <span className="grow">{title}</span>
        <ActionButtons actions={headerActions} />
        <span className="count">{items.length}</span>
      </header>
      {tree ? <FileTree nodes={nodes} folded={tree.folded} onFold={tree.onFold} row={row} /> : listed.map((item) => row(item))}
      {more}
    </section>
  );
}

/**
 * The message, and the button that commits. It keeps the message to itself, so that typing it does not draw the
 * lists of files again at every key: they can be long.
 */
function CommitBox({ state, busy }: { state: RepoState; busy: boolean }) {
  const [message, setMessage] = useState(() => loadUiState({ message: '' }).message);
  const [amend, setAmend] = useState(false);
  const [drafting, setDrafting] = useState(false);

  useEffect(
    () =>
      onMessage((incoming) => {
        if (incoming.type === 'committed') {
          setMessage('');
          setAmend(false);
        } else if (incoming.type === 'drafting') {
          setDrafting(incoming.active);
          if (incoming.message) setMessage(incoming.message);
        }
      }),
    [],
  );

  useEffect(() => {
    saveUiState({ message });
  }, [message]);

  const { identity } = state;
  const changes = state.working.staged.length + state.working.unstaged.length;
  const canCommit = !busy && (amend || (message.trim() !== '' && changes > 0));
  const commit = () => canCommit && act({ kind: 'commit', message, amend });

  return (
    <div className="commit-box">
      <textarea
        value={message}
        rows={3}
        placeholder={`Message (Ctrl+Enter to commit on ${state.branch ?? 'detached HEAD'})`}
        aria-label="Commit message"
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && (event.ctrlKey || event.metaKey) && commit()}
      />
      <div className="commit-actions">
        <button className="button primary" disabled={!canCommit} onClick={commit}>
          <Icon name="check" />
          {amend ? 'Amend' : 'Commit'}
        </button>
        <button
          className="button icon"
          disabled={drafting || changes === 0}
          title="Draft a message from the changes with the language model set up in VS Code"
          aria-label="Draft commit message"
          onClick={() => post({ type: 'command', command: 'draftMessage' })}
        >
          <Icon name={drafting ? 'loading' : 'sparkle'} spin={drafting} />
        </button>
        <label title="Replace the last commit instead of adding a new one. Leave the message empty to keep it.">
          <input type="checkbox" checked={amend} disabled={!state.head} onChange={(event) => setAmend(event.target.checked)} />
          Amend last commit
        </label>
      </div>
      <button
        className="link identity"
        title="Who commits in this repository are made as. Click to switch identity."
        onClick={() => post({ type: 'command', command: 'switchIdentity' })}
      >
        <Icon name="account" />
        <span className="grow">{identity.name || identity.email ? `${identity.name} <${identity.email}>` : 'No identity configured'}</span>
      </button>
    </div>
  );
}

export function ChangesApp() {
  const [state, setState] = useState<RepoState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [layout, setLayout] = useState(() => loadUiState({ changesFiles: 'list' as FilesLayout }).changesFiles);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  /** The files with edits not saved in an editor, by their paths. */
  const [unsaved, setUnsaved] = useState<string[]>([]);

  useEffect(() => {
    const stop = onMessage((incoming) => {
      if (incoming.type === 'state') {
        setState(incoming.state);
        setLoaded(true);
      } else if (incoming.type === 'busy') {
        setBusy(incoming.title !== null);
      } else if (incoming.type === 'unsaved') {
        setUnsaved(incoming.paths);
      }
    });
    post({ type: 'ready' });
    return stop;
  }, []);

  const working = state?.working;
  const changes = useMemo(() => (working ? workingChanges(working) : []), [working]);
  const isUnsaved = useMemo(() => new Set(unsaved), [unsaved]);
  // The files not saved that git sees no change in join the list, in the order of the paths.
  const listed = useMemo(() => {
    const known = new Set([...(working?.conflicts ?? []), ...changes.map((change) => change.file)].map((file) => file.path));
    const others = unsaved.filter((path) => !known.has(path)).map((path): Listed => ({ file: { status: '', path }, staged: null }));
    if (!others.length) return changes;
    return [...changes, ...others].sort((one, other) => (one.file.path < other.file.path ? -1 : one.file.path > other.file.path ? 1 : 0));
  }, [unsaved, changes, working]);

  if (!loaded) return <div className="empty">Loading repository…</div>;
  if (!state) {
    return (
      <div className="empty">
        <p>No Git repository in this workspace</p>
        <button className="button" onClick={() => post({ type: 'refresh' })}>
          Check again
        </button>
      </div>
    );
  }

  const { staged, conflicts } = state.working;
  const switchLayout = () => {
    const wanted = layout === 'tree' ? 'list' : 'tree';
    setLayout(wanted);
    saveUiState({ changesFiles: wanted });
  };
  // Files changed only in their editors have nothing to stage: with no others, the box of the list cannot be ticked.
  const allStaged = changes.length > 0 && changes.every((change) => change.staged === 'all');
  const noneStaged = changes.every((change) => change.staged === 'none');
  // With files in conflict, `git add --all` would take them as resolved and `git reset` would forget their conflicts:
  // the other files are named one by one instead.
  const stageAll = () =>
    act(
      conflicts.length
        ? { kind: 'stage', paths: changes.filter((change) => change.staged !== 'all').map((change) => change.file.path) }
        : { kind: 'stageAll' },
    );
  const unstageAll = () =>
    act(
      conflicts.length
        ? { kind: 'unstage', paths: changes.filter((change) => change.staged !== 'none').flatMap((change) => pathsOf(change.file)) }
        : { kind: 'unstageAll' },
    );

  return (
    <div className="changes">
      <RepoSelect state={state} disabled={busy} />
      <WorktreeBanner state={state} busy={busy} />
      <OperationBanner state={state} busy={busy} />
      <BisectBanner state={state} busy={busy} />
      <CommitBox state={state} busy={busy} />

      <div className="groups">
        <Group
          title="Conflicts"
          items={conflicts}
          row={(file) => {
            const [resolvable, marked] = resolvableConflicts(state, file.path);
            const some = resolvable === marked ? (marked === 1 ? 'its conflict' : `its ${marked} conflicts`) : `${resolvable} of its ${marked} conflicts`;
            return (
              <FileRow
                key={file.path}
                file={file}
                unsaved={isUnsaved.has(file.path)}
                onOpen={() => post({ type: 'openDiff', source: { kind: 'conflict' }, file })}
                actions={[
                  ...(resolvable
                    ? [{ icon: 'wand', title: `Resolve ${some} automatically`, run: () => act({ kind: 'resolveConflicts', paths: [file.path] }) }]
                    : []),
                  { icon: 'arrow-left', title: 'Take the current side for the whole file', run: () => act({ kind: 'takeSide', path: file.path, side: 'ours' }) },
                  { icon: 'arrow-right', title: 'Take the incoming side for the whole file', run: () => act({ kind: 'takeSide', path: file.path, side: 'theirs' }) },
                  { icon: 'add', title: 'Mark as resolved', run: () => act({ kind: 'stage', paths: [file.path] }) },
                ]}
              />
            );
          }}
        />
        <Group
          title="Changes"
          items={listed}
          lead={
            <Check
              checked={allStaged}
              mixed={!allStaged && !noneStaged}
              disabled={!changes.length}
              label={allStaged ? 'Unstage all changes' : 'Stage all changes'}
              title={allStaged ? 'All staged: click to unstage all changes' : 'Click to stage all changes'}
              onChange={(checked) => (checked ? stageAll() : unstageAll())}
            />
          }
          tree={layout === 'tree' ? { path: changePath, folded, onFold: (path) => setFolded((current) => toggled(current, path)) } : undefined}
          headerActions={[
            layout === 'tree'
              ? { icon: 'list-flat', title: 'View as list', run: switchLayout }
              : { icon: 'list-tree', title: 'View as tree', run: switchLayout },
            {
              icon: 'diff-multiple',
              title: 'Open all changes in one editor',
              run: () => post({ type: 'openChanges', source: SOURCE, files: changes.map((change) => change.file), title: 'Changes' }),
            },
            ...(staged.length ? [{ icon: 'git-stash', title: 'Stash only the staged changes…', run: () => act({ kind: 'stashPush', staged: true }) }] : []),
            { icon: 'git-stash', title: 'Stash all changes…', run: () => act({ kind: 'stashPush' }) },
            ...(unsaved.length ? [{ icon: 'save-all', title: 'Save all', run: () => post({ type: 'save', paths: unsaved }) }] : []),
            {
              icon: 'discard',
              title: 'Discard all changes',
              // What is staged goes back to HEAD too. With nothing staged the index is HEAD, and the files go back to it.
              run: () =>
                act(staged.length ? { kind: 'discardChanges', paths: changes.flatMap((change) => pathsOf(change.file)) } : { kind: 'discardAll' }),
            },
          ]}
          row={({ file, staged: done }, depth) => {
            const save = { icon: 'save', title: 'Save', run: () => post({ type: 'save', paths: [file.path] }) };
            // Only its editor has changed it: there is nothing for git to stage, stash or discard until it is saved.
            if (done === null) {
              return (
                <FileRow
                  key={file.path}
                  file={file}
                  depth={depth}
                  unsaved
                  onOpen={() => post({ type: 'openFile', file })}
                  onPick={() => undefined}
                  pickDisabled
                  pickVerb="Stage"
                  pickTitle="Not saved: save it to stage it"
                  actions={[
                    { icon: 'git-compare', title: 'Compare with the saved file', run: () => post({ type: 'compareWithSaved', path: file.path }) },
                    save,
                  ]}
                />
              );
            }
            return (
              <FileRow
                key={file.path}
                file={file}
                depth={depth}
                unsaved={isUnsaved.has(file.path)}
                // The file, or its diff: as the settings say.
                onOpen={() => post({ type: 'openChange', file })}
                // A half ticked box is ticked by the click: all of the file is staged.
                onPick={(checked) => act(checked ? { kind: 'stage', paths: [file.path] } : { kind: 'unstage', paths: pathsOf(file) })}
                picked={done === 'all'}
                mixed={done === 'some'}
                pickVerb={done === 'all' ? 'Unstage' : 'Stage'}
                pickTitle={PICK_TITLES[done]}
                actions={[
                  ...(file.status === 'D' ? [] : [{ icon: 'go-to-file', title: 'Open File', run: () => post({ type: 'openFile', file }) }]),
                  { icon: 'git-compare', title: 'Open Changes', run: () => post({ type: 'openDiff', source: SOURCE, file }) },
                  ...(isUnsaved.has(file.path) ? [save] : []),
                  { icon: 'git-stash', title: 'Stash this file…', run: () => act({ kind: 'stashPush', paths: pathsOf(file) }) },
                  {
                    icon: 'discard',
                    title: 'Discard changes',
                    // With some of it staged, all of it goes back to HEAD.
                    run: () => act(done === 'none' ? { kind: 'discard', paths: [file.path] } : { kind: 'discardChanges', paths: pathsOf(file) }),
                  },
                ]}
              />
            );
          }}
        />
        {state.changes === 0 && !unsaved.length && <p className="muted none">No changes</p>}
      </div>
    </div>
  );
}
