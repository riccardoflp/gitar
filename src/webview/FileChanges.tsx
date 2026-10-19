import { memo, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { DiffSource, FileChange, FilePatch, FilesLayout, Hunk } from '../shared/protocol';
import { fileTree } from '../shared/tree';
import { FILES_LIMIT, useCapped } from './Capped';
import { ActionButtons, FileRow, Status, fileTitle, type FileAction } from './FileRow';
import { FileTree, toggled } from './FileTree';
import { Icon } from './Icon';
import { useColors, type Colors, type Token } from './syntax';
import { post } from './vscode';

/** The diff of a file longer than this is left folded until it is asked for, as are the ones after this many lines are shown. */
const FILE_LINES = 800;
const OPEN_LINES = 5000;

const NONE: ReadonlySet<string> = new Set();

const linesOf = (hunks: Hunk[]) => hunks.reduce((sum, hunk) => sum + hunk.lines.length + 1, 0);

/** A file as it is listed: with what changed in it, once that is known. */
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

/** A piece of code in the color the theme gives it. */
function Piece({ token }: { token: Token }) {
  const style = token.style ?? 0;
  if (!token.color && !style) return token.text;
  const decoration = [style & 4 && 'underline', style & 8 && 'line-through'].filter(Boolean).join(' ');
  return (
    <span
      style={{
        color: token.color,
        fontStyle: style & 1 ? 'italic' : undefined,
        fontWeight: style & 2 ? 'bold' : undefined,
        textDecoration: decoration || undefined,
      }}
    >
      {token.text}
    </span>
  );
}

/** The lines of a diff, with the number each has in the file before and after, and their code in color once it is known. */
const Lines = memo(function Lines({ hunks, colors }: { hunks: Hunk[]; colors?: Colors }) {
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
      const pieces = colors?.[at]?.[index];
      return (
        <div key={index} className={sign === '+' ? 'line added' : sign === '-' ? 'line removed' : 'line'}>
          <span className="number">{old}</span>
          <span className="number">{now}</span>
          <span className="code">
            {sign}
            {pieces ? pieces.map((token, piece) => <Piece key={piece} token={token} />) : line.slice(1).replace(/\r$/, '')}
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
  actions?: FileAction[];
}

function FileDiff({ entry, open, onToggle, onOpen, actions }: DiffProps) {
  const { file, patch } = entry;
  // Its code in the colors the editor gives it, once it is unfolded.
  const colors = useColors(file.path, patch?.hunks, open);
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
    else body = <Lines hunks={patch.hunks} colors={colors} />;
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
        <ActionButtons actions={actions} />
        <button className="button icon" title="Open in the diff editor" aria-label={`Open ${file.path} in the diff editor`} onClick={onOpen}>
          <Icon name="diff" />
        </button>
      </header>
      {body}
    </section>
  );
}

interface Props {
  files: FileChange[];
  /** What changed in each of them, in the same order. Undefined while it is asked for; null when git cannot say. */
  patch: FilePatch[] | null | undefined;
  /** The two versions the diff editor compares. */
  source: DiffSource;
  /** The title of the editor that shows all the changes. */
  title: string;
  layout: FilesLayout;
  onLayout(layout: FilesLayout): void;
  /** Said after the count of the files. */
  note?: ReactNode;
  /** Shown under the files, before their changes. */
  children?: ReactNode;
  /** What else can be done with a file, besides opening it in the diff editor. */
  fileActions?(file: FileChange): FileAction[];
  /**
   * Given when the changes are shown only once asked for, with a button: whether they are now. A file listed then
   * opens in the diff editor, rather than at its changes in the page.
   */
  diffs?: boolean;
  onDiffs?(shown: boolean): void;
}

/**
 * The files that changed, as a tree or as a list, and under them what changed in each, file after file: the page of
 * a commit, or of a comparison.
 */
export function FileChanges({ files, patch, source, title, layout, onLayout, note, children, fileActions, diffs, onDiffs }: Props) {
  const onDemand = !!onDiffs;
  const shown = !onDemand || !!diffs;
  const [folded, setFolded] = useState(NONE);
  // The diffs unfolded or folded by hand: the others are as their length says.
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());

  const entries = useMemo<Entry[]>(() => files.map((file, index) => ({ file, patch: patch?.[index], id: `diff-${index}` })), [files, patch]);
  const [listed, more] = useCapped(entries, FILES_LIMIT, 'files');
  const tree = useMemo(() => (layout === 'tree' ? fileTree(listed, (entry) => entry.file.path) : []), [layout, listed]);

  // Short diffs are unfolded as the page opens, until there are a few thousand lines of them.
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

  const added = patch?.reduce((sum, file) => sum + file.added, 0) ?? 0;
  const removed = patch?.reduce((sum, file) => sum + file.removed, 0) ?? 0;
  const allOpen = listed.length > 0 && listed.every(isOpen);

  const openDiff = (entry: Entry) => post({ type: 'openDiff', source, file: entry.file });
  const show = (entry: Entry) => {
    onDiffs?.(true);
    setChosen((current) => new Map(current).set(entry.id, true));
    // Once it is unfolded: the page is as long as its diffs.
    requestAnimationFrame(() => document.getElementById(entry.id)?.scrollIntoView({ block: 'start' }));
  };
  const row = (entry: Entry, depth?: number) => (
    <FileRow
      key={entry.file.path}
      file={entry.file}
      depth={depth}
      onOpen={() => (onDemand ? openDiff(entry) : show(entry))}
      extra={<Stat patch={entry.patch} />}
      actions={[
        ...(fileActions?.(entry.file) ?? []),
        onDemand
          ? { icon: 'eye', title: 'Show its changes in this page', run: () => show(entry) }
          : { icon: 'diff', title: 'Open in the diff editor', run: () => openDiff(entry) },
      ]}
    />
  );

  return (
    <>
      <section className="commit-files" aria-label="Changed files">
        <h2>
          <span className="grow">
            {files.length} changed {files.length === 1 ? 'file' : 'files'}
            {patch && files.length > 0 && (
              <span className="stat">
                <span className="plus">+{added}</span>
                <span className="minus">−{removed}</span>
              </span>
            )}
            {note}
          </span>
          <button className={`button icon${layout === 'tree' ? ' on' : ''}`} aria-pressed={layout === 'tree'} title="Under their directories" aria-label="Files as a tree" onClick={() => onLayout('tree')}>
            <Icon name="list-tree" />
          </button>
          <button className={`button icon${layout === 'list' ? ' on' : ''}`} aria-pressed={layout === 'list'} title="One after the other" aria-label="Files as a list" onClick={() => onLayout('list')}>
            <Icon name="list-flat" />
          </button>
        </h2>
        <div className="files">
          {layout === 'tree' ? (
            <FileTree nodes={tree} folded={folded} onFold={(path) => setFolded((current) => toggled(current, path))} row={row} />
          ) : (
            listed.map((entry) => row(entry))
          )}
          {more}
        </div>
        {children}
      </section>

      {files.length > 0 && (
        <section className="commit-diffs" aria-label="Changes">
          <h2>
            <span className="grow">Changes</span>
            {shown && patch && (
              <button className="button" onClick={() => setChosen(new Map(listed.map((entry) => [entry.id, !allOpen])))}>
                <Icon name={allOpen ? 'fold' : 'unfold'} />
                {allOpen ? 'Fold all' : 'Unfold all'}
              </button>
            )}
            {onDemand && (
              <button className="button show-diffs" aria-pressed={shown} title={shown ? 'Take the changes of the files off the page' : 'Show the changes of every file in this page'} onClick={() => onDiffs(!shown)}>
                <Icon name={shown ? 'eye-closed' : 'eye'} />
                {shown ? 'Hide the changes' : 'Show the changes'}
              </button>
            )}
          </h2>
          {shown && patch === undefined && <p className="muted">Loading the changes…</p>}
          {shown && patch === null && (
            <p className="muted">
              Git lists these changes in a way that cannot be shown here.{' '}
              <button className="link" onClick={() => post({ type: 'openChanges', source, files, title })}>
                Open them in the diff editor
              </button>
            </p>
          )}
          {shown &&
            patch &&
            listed.map((entry) => (
              <FileDiff
                key={entry.id}
                entry={entry}
                open={isOpen(entry)}
                onToggle={() => setChosen((current) => new Map(current).set(entry.id, !isOpen(entry)))}
                onOpen={() => openDiff(entry)}
                actions={fileActions?.(entry.file)}
              />
            ))}
        </section>
      )}
    </>
  );
}
