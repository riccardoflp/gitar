import { useEffect, useRef, useState, type ReactNode } from 'react';
import { hunkPatch, linesPatch } from '../git/parse';
import type { DiffSource, FileChange, FileHunks, Hunk, RepoState } from '../shared/protocol';
import { BisectBanner } from './BisectBanner';
import { FILES_LIMIT, useCapped } from './Capped';
import { ActionButtons, FileRow, type FileAction } from './FileRow';
import { Icon } from './Icon';
import { OperationBanner } from './OperationBanner';
import { RepoSelect } from './RepoSelect';
import { act } from './menus';
import { loadUiState, onMessage, post, saveUiState } from './vscode';

/** A staged rename covers two paths: unstaging only the new one would leave the deletion of the old one staged. */
const pathsOf = (file: FileChange) => (file.oldPath ? [file.path, file.oldPath] : [file.path]);

/** Hunks of the files the user unfolded, keyed by list and path. Null while they load. */
type OpenHunks = Record<string, FileHunks | null>;

const hunkKey = (path: string, staged: boolean) => `${staged ? 'staged' : 'unstaged'}:${path}`;

/** The changed lines the user clicked in one hunk, to stage, unstage or discard only those. */
interface Picked {
  key: string;
  header: string;
  lines: ReadonlySet<number>;
}

interface HunkListProps {
  file: FileHunks | null;
  /** `picked` is set when only some lines of the hunk are chosen. */
  actions(hunk: Hunk, picked: ReadonlySet<number> | null): FileAction[];
  pickedIn(hunk: Hunk): ReadonlySet<number> | null;
  /** Absent when single lines cannot be chosen. */
  onPick?(hunk: Hunk, index: number): void;
}

function HunkList({ file, actions, pickedIn, onPick }: HunkListProps) {
  if (!file) return <p className="muted hunk-note">Loading…</p>;
  if (file.binary) return <p className="muted hunk-note">Binary file</p>;
  if (!file.hunks.length) return <p className="muted hunk-note">No text changes</p>;
  return file.hunks.map((hunk) => {
    const picked = pickedIn(hunk);
    return (
      <div className="hunk" key={hunk.header}>
        <header>
          <span className="grow mono">
            {picked ? `${picked.size} ${picked.size === 1 ? 'line' : 'lines'} selected` : hunk.header}
          </span>
          <ActionButtons actions={actions(hunk, picked)} />
        </header>
        <pre>
          {hunk.lines.map((line, index) => {
            const changed = line[0] === '+' || line[0] === '-';
            const pickable = changed && onPick;
            const kind = line[0] === '+' ? 'added' : line[0] === '-' ? 'removed' : '';
            return (
              <span
                key={index}
                className={`${kind}${pickable ? ' pickable' : ''}${picked?.has(index) ? ' picked' : ''}` || undefined}
                title={pickable ? 'Click to select only some lines of this hunk' : undefined}
                onClick={pickable ? () => onPick(hunk, index) : undefined}
              >
                {line.replace(/\r$/, '')}
                {'\n'}
              </span>
            );
          })}
        </pre>
      </div>
    );
  });
}

interface GroupProps {
  title: string;
  files: FileChange[];
  source: DiffSource;
  headerActions?: FileAction[];
  fileActions?(file: FileChange): FileAction[];
  /** Present for lists whose files can be unfolded into hunks. */
  hunks?: {
    staged: boolean;
    open: OpenHunks;
    toggle(file: FileChange): void;
    /** With `picked`, the action applies to those lines of the hunk only. */
    actions(file: FileChange, hunks: FileHunks, hunk: Hunk, picked: ReadonlySet<number> | null): FileAction[];
    picked: Picked | null;
    onPick(file: FileChange, hunk: Hunk, index: number): void;
  };
}

function Group({ title, files, source, headerActions, fileActions, hunks }: GroupProps): ReactNode {
  const [listed, more] = useCapped(files, FILES_LIMIT, 'files');
  if (!files.length) return null;
  return (
    <section className="group">
      <header>
        <span className="grow">{title}</span>
        <ActionButtons actions={headerActions} />
        <span className="count">{files.length}</span>
      </header>
      {listed.map((file) => {
        // An untracked file has no diff to cut into hunks.
        const foldable = hunks && file.status !== '?';
        const key = hunkKey(file.path, hunks?.staged ?? false);
        const expanded = foldable && key in hunks.open;
        return (
          <div key={file.path}>
            <FileRow
              file={file}
              actions={fileActions?.(file)}
              onOpen={() => post({ type: 'openDiff', source, file })}
              expanded={expanded}
              onToggle={foldable ? () => hunks.toggle(file) : undefined}
            />
            {expanded && (
              <HunkList
                file={hunks.open[key]}
                actions={(hunk, picked) => hunks.actions(file, hunks.open[key]!, hunk, picked)}
                pickedIn={(hunk) => (hunks.picked?.key === key && hunks.picked.header === hunk.header ? hunks.picked.lines : null)}
                // Only part of a hunk can be applied when both versions of the file exist.
                onPick={file.status === 'M' ? (hunk, index) => hunks.onPick(file, hunk, index) : undefined}
              />
            )}
          </div>
        );
      })}
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
  const [picked, setPicked] = useState<Picked | null>(null);
  const [open, setOpen] = useState<OpenHunks>({});
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const stop = onMessage((incoming) => {
      if (incoming.type === 'state') {
        setState(incoming.state);
        setLoaded(true);
        // Unfolded files may have changed: reload the ones still listed, fold the rest.
        const working = incoming.state?.working;
        const kept: OpenHunks = {};
        for (const staged of [true, false]) {
          for (const file of (staged ? working?.staged : working?.unstaged) ?? []) {
            const key = hunkKey(file.path, staged);
            if (!(key in openRef.current)) continue;
            kept[key] = openRef.current[key];
            post({ type: 'getHunks', path: file.path, staged });
          }
        }
        setOpen(kept);
        // The hunks are about to be read again, and line numbers chosen in the old ones would point elsewhere.
        setPicked(null);
      } else if (incoming.type === 'busy') {
        setBusy(incoming.title !== null);
      } else if (incoming.type === 'hunks') {
        const key = hunkKey(incoming.path, incoming.staged);
        setOpen((current) => (key in current ? { ...current, [key]: incoming.hunks } : current));
      }
    });
    post({ type: 'ready' });
    return stop;
  }, []);

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

  const { staged, unstaged, conflicts } = state.working;

  const toggle = (isStaged: boolean) => (file: FileChange) => {
    const key = hunkKey(file.path, isStaged);
    if (key in open) {
      const { [key]: _closed, ...rest } = open;
      setOpen(rest);
    } else {
      setOpen({ ...open, [key]: null });
      post({ type: 'getHunks', path: file.path, staged: isStaged });
    }
  };

  const pick = (isStaged: boolean) => (file: FileChange, hunk: Hunk, index: number) => {
    const key = hunkKey(file.path, isStaged);
    const lines = new Set(picked?.key === key && picked.header === hunk.header ? picked.lines : []);
    if (!lines.delete(index)) lines.add(index);
    setPicked(lines.size ? { key, header: hunk.header, lines } : null);
  };
  /** The patch for a whole hunk, or for the chosen lines of it. `reverse`: the patch will be applied backwards. */
  const patchOf = (hunks: FileHunks, hunk: Hunk, lines: ReadonlySet<number> | null, reverse: boolean) =>
    lines ? linesPatch(hunks, hunk, lines, reverse) : hunkPatch(hunks, hunk);

  return (
    <div className="changes">
      <RepoSelect state={state} disabled={busy} />
      <OperationBanner state={state} busy={busy} />
      <BisectBanner state={state} busy={busy} />
      <CommitBox state={state} busy={busy} />

      <div className="groups">
        <Group
          title="Conflicts"
          files={conflicts}
          source={{ kind: 'conflict' }}
          fileActions={(file) => [{ icon: 'add', title: 'Mark as resolved', run: () => act({ kind: 'stage', paths: [file.path] }) }]}
        />
        <Group
          title="Staged changes"
          files={staged}
          source={{ kind: 'staged' }}
          headerActions={[
            {
              icon: 'diff-multiple',
              title: 'Open all staged changes in one editor',
              run: () => post({ type: 'openChanges', source: { kind: 'staged' }, files: staged, title: 'Staged changes' }),
            },
            { icon: 'git-stash', title: 'Stash only the staged changes…', run: () => act({ kind: 'stashPush', staged: true }) },
            { icon: 'remove', title: 'Unstage all changes', run: () => act({ kind: 'unstageAll' }) },
          ]}
          fileActions={(file) => [{ icon: 'remove', title: 'Unstage', run: () => act({ kind: 'unstage', paths: pathsOf(file) }) }]}
          hunks={{
            staged: true,
            open,
            toggle: toggle(true),
            picked,
            onPick: pick(true),
            actions: (file, hunks, hunk, lines) => [
              {
                icon: 'remove',
                title: lines ? 'Unstage selected lines' : 'Unstage hunk',
                run: () => act({ kind: 'unstageHunk', path: file.path, patch: patchOf(hunks, hunk, lines, true) }),
              },
            ],
          }}
        />
        <Group
          title="Changes"
          files={unstaged}
          source={{ kind: 'unstaged' }}
          headerActions={[
            {
              icon: 'diff-multiple',
              title: 'Open all changes in one editor',
              run: () => post({ type: 'openChanges', source: { kind: 'unstaged' }, files: unstaged, title: 'Changes' }),
            },
            { icon: 'git-stash', title: 'Stash all changes…', run: () => act({ kind: 'stashPush' }) },
            { icon: 'discard', title: 'Discard all changes', run: () => act({ kind: 'discardAll' }) },
            { icon: 'add', title: 'Stage all changes', run: () => act({ kind: 'stageAll' }) },
          ]}
          fileActions={(file) => [
            { icon: 'git-stash', title: 'Stash this file…', run: () => act({ kind: 'stashPush', paths: pathsOf(file) }) },
            { icon: 'discard', title: 'Discard changes', run: () => act({ kind: 'discard', paths: [file.path] }) },
            { icon: 'add', title: 'Stage', run: () => act({ kind: 'stage', paths: [file.path] }) },
          ]}
          hunks={{
            staged: false,
            open,
            toggle: toggle(false),
            picked,
            onPick: pick(false),
            actions: (file, hunks, hunk, lines) => [
              {
                icon: 'discard',
                title: lines ? 'Discard selected lines' : 'Discard hunk',
                run: () => act({ kind: 'discardHunk', path: file.path, patch: patchOf(hunks, hunk, lines, true) }),
              },
              {
                icon: 'add',
                title: lines ? 'Stage selected lines' : 'Stage hunk',
                run: () => act({ kind: 'stageHunk', path: file.path, patch: patchOf(hunks, hunk, lines, false) }),
              },
            ],
          }}
        />
        {state.changes === 0 && <p className="muted none">No changes</p>}
      </div>
    </div>
  );
}
