import { useEffect, useRef, useState } from 'react';
import type { CommitDetail, DiffSource, RepoState, Stash } from '../shared/protocol';
import { useMenu } from './ContextMenu';
import { ActionButtons, FileRow } from './FileRow';
import { Icon } from './Icon';
import { Placeholder } from './Placeholder';
import { act, stashMenu } from './menus';
import { fullDate, relativeTime } from './util';
import { onMessage, post } from './vscode';

/** What the unfolded stashes hold, by the hash of each. Null while it is being read. */
type Open = Record<string, CommitDetail | null>;

/** The stashes in the side bar. Each unfolds to the files it holds, which open as diffs. */
export function StashesApp() {
  const [state, setState] = useState<RepoState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Open>({});
  const openRef = useRef(open);
  openRef.current = open;
  const openMenu = useMenu();

  useEffect(() => {
    const stop = onMessage((message) => {
      if (message.type === 'state') {
        setState(message.state);
        setLoaded(true);
        // A stash never changes, so what was read of the ones still there holds; the others are gone.
        const hashes = new Set(message.state?.stashes.map((stash) => stash.hash));
        setOpen((current) => Object.fromEntries(Object.entries(current).filter(([hash]) => hashes.has(hash))));
      } else if (message.type === 'detail') {
        if (message.hash in openRef.current) setOpen((current) => ({ ...current, [message.hash]: message.detail }));
      } else if (message.type === 'busy') {
        setBusy(message.title !== null);
      }
    });
    post({ type: 'ready' });
    return stop;
  }, []);

  if (!state) return <Placeholder loaded={loaded} />;

  const toggle = (stash: Stash) => {
    if (stash.hash in open) {
      const { [stash.hash]: _closed, ...rest } = open;
      setOpen(rest);
    } else {
      setOpen({ ...open, [stash.hash]: null });
      post({ type: 'getDetail', hash: stash.hash });
    }
  };

  const files = (stash: Stash, detail: CommitDetail) => {
    const source: DiffSource = { kind: 'commit', hash: stash.hash, parent: detail.parents[0] ?? null };
    // Git keeps the untracked files a stash took in a commit of their own, with nothing before it.
    const untracked: DiffSource | null = detail.untracked ? { kind: 'commit', hash: detail.untracked.hash, parent: null } : null;
    return (
      <div className="stash-files">
        {detail.files.map((file) => (
          <FileRow key={file.path} file={file} onOpen={() => post({ type: 'openDiff', source, file })} />
        ))}
        {untracked &&
          detail.untracked!.files.map((file) => (
            <FileRow key={`?${file.path}`} file={file} onOpen={() => post({ type: 'openDiff', source: untracked, file })} />
          ))}
        {!detail.files.length && !detail.untracked?.files.length && <p className="none muted">No files</p>}
      </div>
    );
  };

  return (
    <div className="side stashes">
      {!state.stashes.length && (
        <p className="none muted">
          No stashes. Put your changes aside with the button above, or from the Changes view: one file, what is staged, or everything.
        </p>
      )}
      {state.stashes.map((stash) => {
        const unfolded = stash.hash in open;
        const detail = open[stash.hash];
        return (
          <section key={stash.hash}>
            <div className="file stash" onContextMenu={(event) => openMenu(event, stashMenu(stash))}>
              <button
                className="twist"
                onClick={() => toggle(stash)}
                aria-expanded={unfolded}
                aria-label={`${unfolded ? 'Hide' : 'Show'} the files of ${stash.ref}`}
              >
                <Icon name={unfolded ? 'chevron-down' : 'chevron-right'} />
              </button>
              <button className="file-open" title={`${stash.ref}: ${stash.message}\n${fullDate(stash.date)}`} onClick={() => toggle(stash)}>
                <span className="name">{stash.message}</span>
                <span className="dir">{relativeTime(stash.date)}</span>
              </button>
              {!busy && (
                <ActionButtons
                  actions={[
                    { icon: 'git-stash-apply', title: 'Apply: bring the changes back and keep the stash', run: () => act({ kind: 'stashApply', ref: stash.ref }) },
                    { icon: 'git-stash-pop', title: 'Pop: bring the changes back and drop the stash', run: () => act({ kind: 'stashPop', ref: stash.ref }) },
                    { icon: 'trash', title: 'Drop…', run: () => act({ kind: 'stashDrop', ref: stash.ref }) },
                  ]}
                />
              )}
            </div>
            {unfolded && (detail ? files(stash, detail) : <p className="none muted">Loading…</p>)}
          </section>
        );
      })}
    </div>
  );
}
