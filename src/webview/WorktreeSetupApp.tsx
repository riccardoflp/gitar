import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  LARGE_COPY,
  choose,
  cleanPatterns,
  sizeText,
  statusNow,
  type IgnoredEntry,
  type SetupChoice,
  type SetupPatterns,
  type SetupPreview,
  type SetupSource,
  type SetupTarget,
  type WorktreeSetupInfo,
} from '../shared/worktreeSetup';
import { EntryIcon } from './FileIcon';
import { Icon } from './Icon';
import { onMessage, post } from './vscode';

/** How many of what git ignores are listed before asking for the rest. */
const LISTED = 200;

const CHOICES: { choice: SetupChoice; label: string; icon: string; title: string }[] = [
  { choice: 'link', label: 'Link', icon: 'link', title: 'Linked from here: what changes in the worktree changes here too' },
  { choice: 'copy', label: 'Copy', icon: 'copy', title: 'Copied: each worktree has its own' },
  { choice: 'none', label: 'Nothing', icon: 'circle-slash', title: 'Left out: the worktree does without it, or makes its own' },
];

const keyOf = (patterns: SetupPatterns) => JSON.stringify(patterns);
const same = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && a.every((pattern, index) => pattern === b[index]);

function filesText(entry: IgnoredEntry): string {
  if (entry.link) return 'a link';
  if (!entry.folder) return sizeText(entry.bytes);
  const files = `${entry.files.toLocaleString('en')}${entry.more ? '+' : ''} ${entry.files === 1 && !entry.more ? 'file' : 'files'}`;
  return `${entry.more ? 'over ' : ''}${sizeText(entry.bytes)} · ${files}`;
}

function sourceText(source: SetupSource, kind: 'link' | 'copy', info: WorktreeSetupInfo): string {
  if (source === 'workspace') return `the settings of ${info.workspace?.name ?? 'the workspace'}`;
  if (source === 'user') return 'your user settings';
  if (source === 'vscode') return `VS Code's ${kind === 'link' ? 'git.worktreeSymlinkFolders' : 'git.worktreeIncludeFiles'}`;
  return 'nothing set';
}

/** What git said the patterns take, when it was last asked: on opening, and at each look again. */
interface Checked {
  key: string;
  patterns: SetupPatterns;
  preview: SetupPreview;
}

/** What one thing git ignores gets, chosen with three buttons. */
function EntryRow(props: { entry: IgnoredEntry; patterns: SetupPatterns; checked: Checked | null; onChoose(choice: SetupChoice): void }) {
  const { entry, patterns, checked, onChoose } = props;
  const status = statusNow(entry, patterns, checked);
  const notes = [
    entry.link && 'A link already, in this checkout',
    status?.partly && `Only part of it is ${status.choice === 'link' ? 'linked' : 'copied'}, by a pattern below`,
    status?.choice === 'copy' && !status.partly && entry.bytes > LARGE_COPY && 'Large to copy into each worktree: better linked, or made again',
  ].filter(Boolean);
  return (
    <tr>
      <td className="path">
        <EntryIcon path={entry.path} folder={entry.folder} />
        <span className="mono" title={entry.path}>
          {entry.path}
          {entry.folder ? '/' : ''}
        </span>
      </td>
      <td className="size muted">{filesText(entry)}</td>
      <td>
        <div className="choices" role="radiogroup" aria-label={`What new worktrees get of ${entry.path}`}>
          {CHOICES.map(({ choice, label, icon, title }) => {
            const on = status?.choice === choice && !status.partly;
            const disabled = choice === 'link' && !entry.folder;
            return (
              <button
                key={choice}
                role="radio"
                aria-checked={on}
                aria-label={label}
                className={`choice${on ? ' on' : ''}${entry.suggestion === choice ? ' suggested' : ''}`}
                disabled={disabled}
                title={disabled ? 'Only folders are linked' : `${title}${entry.suggestion === choice ? ' (proposed)' : ''}`}
                onClick={() => onChoose(choice)}
              >
                <Icon name={icon} />
                {label}
              </button>
            );
          })}
        </div>
      </td>
      <td className="why">
        <span className="muted">{entry.reason}</span>
        {notes.map((note) => (
          <span key={note as string} className="note">
            <Icon name="warning" />
            {note}
          </span>
        ))}
      </td>
    </tr>
  );
}

/** The patterns of one of the two settings, each with what it takes, and a box to add one. */
function PatternList(props: {
  title: string;
  hint: string;
  kind: 'link' | 'copy';
  patterns: string[];
  counts: Record<string, number> | null;
  placeholder: string;
  onChange(patterns: string[]): void;
}) {
  const { title, hint, kind, patterns, counts, placeholder, onChange } = props;
  const [typed, setTyped] = useState('');
  const add = (event: FormEvent) => {
    event.preventDefault();
    const added = cleanPatterns([...patterns, ...typed.split(',')]);
    if (added.length !== patterns.length) onChange(added);
    setTyped('');
  };
  const takes = (count: number) =>
    kind === 'link' ? `${count} ${count === 1 ? 'folder' : 'folders'}` : `${count} ${count === 1 ? 'file or folder' : 'files or folders'}`;
  return (
    <div className="patterns" aria-label={title}>
      <h3>{title}</h3>
      <p className="muted">{hint}</p>
      {patterns.length === 0 && <p className="muted none">None.</p>}
      <ul>
        {patterns.map((pattern) => {
          const count = counts?.[pattern];
          return (
            <li key={pattern}>
              <span className="mono grow">{pattern}</span>
              {count === 0 ? (
                <span className="note" title="Nothing that git ignores here matches it, or a link takes it first">
                  <Icon name="warning" />
                  takes nothing here
                </span>
              ) : (
                count !== undefined && <span className="muted">{takes(count)}</span>
              )}
              <button className="button icon" title={`Remove ${pattern}`} aria-label={`Remove ${pattern}`} onClick={() => onChange(patterns.filter((each) => each !== pattern))}>
                <Icon name="close" />
              </button>
            </li>
          );
        })}
      </ul>
      <form className="add" onSubmit={add}>
        <input
          className="mono"
          value={typed}
          placeholder={placeholder}
          aria-label={`A pattern to add to ${title}`}
          spellCheck={false}
          onChange={(event) => setTyped(event.target.value)}
        />
        <button className="button" type="submit" disabled={!typed.trim()}>
          <Icon name="add" />
          Add
        </button>
      </form>
    </div>
  );
}

/**
 * The tab where what new worktrees get of what git ignores in this checkout is chosen: what git ignores, each with
 * what it gets, the patterns that say so, and where they are saved.
 */
export function WorktreeSetupApp() {
  // Undefined while it is read.
  const [info, setInfo] = useState<WorktreeSetupInfo | null>();
  const [error, setError] = useState<string>();
  // The patterns as changed here, until they are saved; null while they are what applies.
  const [draft, setDraft] = useState<SetupPatterns | null>(null);
  const [target, setTarget] = useState<SetupTarget>();
  const [alsoVSCode, setAlsoVSCode] = useState(false);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [checkError, setCheckError] = useState<string>();
  const [scanning, setScanning] = useState(false);
  const [all, setAll] = useState(false);
  // The patterns git was last asked about, whose answer is awaited.
  const wanted = useRef('');
  // Git is asked what the patterns take once what it ignores is read: on opening, and when asked to look again.
  const look = useRef(true);
  // Saved: the changes made here are dropped once the settings come back with them.
  const saving = useRef(false);

  useEffect(() => {
    const stop = onMessage((message) => {
      if (message.type === 'worktreeSetup') {
        setInfo(message.info);
        if (saving.current) setDraft(null);
        saving.current = false;
        setError(message.error);
        if (!message.info) setScanning(false);
      } else if (message.type === 'worktreeSetupPreview') {
        const key = keyOf(message.patterns);
        if (key !== wanted.current) return;
        if (message.preview) setChecked({ key, patterns: message.patterns, preview: message.preview });
        setCheckError(message.error);
        setScanning(false);
      }
    });
    post({ type: 'getWorktreeSetup' });
    return stop;
  }, []);

  const effective = useMemo<SetupPatterns>(() => ({ link: info?.effective.link ?? [], copy: info?.effective.copy ?? [] }), [info]);
  const patterns = draft ?? effective;
  const key = keyOf(patterns);

  // What the patterns take, asked once what git ignores is read. Choosing changes only what is chosen, without git.
  useEffect(() => {
    if (!info || !look.current) return;
    look.current = false;
    wanted.current = key;
    post({ type: 'previewWorktreeSetup', patterns: JSON.parse(key) as SetupPatterns });
  }, [info, key]);

  if (info === undefined) return <div className="empty">Looking at what git ignores…</div>;
  if (info === null) return <div className="empty">Gitardo could not read this repository. {error}</div>;

  // Saved where it applies from, unless that is VS Code's own or nothing, when the workspace folder is the first choice.
  const from = info.effective.linkFrom === 'user' || info.effective.copyFrom === 'user' ? 'user' : 'workspace';
  const where: SetupTarget = target ?? (info.workspace ? from : 'user');
  const layer = where === 'workspace' ? info.workspace : info.user;
  const savedHere = !!layer && same(layer.link, patterns.link) && same(layer.copy, patterns.copy);
  const setHere = !!layer && (layer.link !== undefined || layer.copy !== undefined);
  const changed = draft !== null && keyOf(draft) !== keyOf(effective);
  const counts = (kind: 'link' | 'copy') =>
    checked && Object.fromEntries(patterns[kind].filter((pattern) => pattern in checked.preview.counts[kind]).map((pattern) => [pattern, checked.preview.counts[kind][pattern]]));
  const listed = all ? info.entries : info.entries.slice(0, LISTED);
  const update = (next: SetupPatterns) => setDraft(keyOf(next) === keyOf(effective) ? null : next);
  const save = (saved: SetupPatterns | null) => {
    saving.current = true;
    post({ type: 'saveWorktreeSetup', target: where, patterns: saved, alsoVSCode: saved !== null && alsoVSCode });
  };

  return (
    <main className="setup-page">
      <header>
        <h1>What new worktrees get</h1>
        <p className="muted">
          A new worktree has only what is committed. Of what git ignores in <span className="mono">{info.root}</span>, it can get folders linked from here,
          such as <span className="mono">node_modules</span>, and files copied, such as <span className="mono">.env</span>. Gitardo does it each time it creates
          a worktree, and says each one in its log.
        </p>
        <dl className="applies">
          <dt>Linked now</dt>
          <dd>
            {info.effective.link.length ? <span className="mono">{info.effective.link.join(', ')}</span> : <span className="muted">nothing</span>}
            <span className="muted"> · from {sourceText(info.effective.linkFrom, 'link', info)}</span>
          </dd>
          <dt>Copied now</dt>
          <dd>
            {info.effective.copy.length ? <span className="mono">{info.effective.copy.join(', ')}</span> : <span className="muted">nothing</span>}
            <span className="muted"> · from {sourceText(info.effective.copyFrom, 'copy', info)}</span>
          </dd>
        </dl>
      </header>

      <section aria-label="What git ignores">
        <h2>
          <span className="grow">
            What git ignores here <span className="count">{info.entries.length}</span>
          </span>
          <button
            className="button"
            disabled={!info.entries.length}
            title="Each one gets what is proposed for it"
            aria-label="Use what is proposed"
            onClick={() => update(info.entries.reduce((next, entry) => choose(next, entry, entry.suggestion), patterns))}
          >
            <Icon name="sparkle" />
            Use what is proposed
          </button>
          <button
            className="button"
            disabled={scanning}
            title="Reads again what git ignores, and asks git what the patterns take"
            onClick={() => {
              setScanning(true);
              look.current = true;
              post({ type: 'getWorktreeSetup', rescan: true });
            }}
          >
            <Icon name="refresh" />
            {scanning ? 'Looking…' : 'Look again'}
          </button>
        </h2>
        {checked && checked.key !== key && (
          <p className="muted changed">
            <Icon name="info" />
            Changed since Gitardo last looked: each line shows what is chosen for it, and Look again checks what the patterns take as a whole.
          </p>
        )}
        {info.entries.length === 0 ? (
          <p className="muted">Git ignores nothing here, so new worktrees have all there is.</p>
        ) : (
          <table className="ignored">
            <thead>
              <tr>
                <th>Path</th>
                <th>Size</th>
                <th>New worktrees get</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((entry) => (
                <EntryRow key={entry.path} entry={entry} patterns={patterns} checked={checked} onChoose={(choice) => update(choose(patterns, entry, choice))} />
              ))}
            </tbody>
          </table>
        )}
        {listed.length < info.entries.length && (
          <button className="link more" onClick={() => setAll(true)}>
            Show the other {info.entries.length - listed.length}
          </button>
        )}
        {checkError && (
          <p className="note">
            <Icon name="warning" />
            Git could not say what the patterns take: {checkError}
          </p>
        )}
      </section>

      <section aria-label="Patterns">
        <h2>Patterns</h2>
        <p className="muted">
          In <span className="mono">.gitignore</span> syntax: <span className="mono">node_modules/</span> is a folder of that name anywhere,{' '}
          <span className="mono">/.env</span> the file at the top only, <span className="mono">*.local</span> every file that ends so. Only what git ignores is
          taken, and nothing is made where the worktree has something already.
        </p>
        <div className="pattern-lists">
          <PatternList
            title="Folders to link"
            hint="gitardo.worktrees.linkFolders · On Windows, junctions."
            kind="link"
            patterns={patterns.link}
            counts={counts('link')}
            placeholder="node_modules/"
            onChange={(link) => update({ ...patterns, link })}
          />
          <PatternList
            title="Files and folders to copy"
            hint="gitardo.worktrees.copyFiles · Not what is inside a linked folder."
            kind="copy"
            patterns={patterns.copy}
            counts={counts('copy')}
            placeholder="/.env"
            onChange={(copy) => update({ ...patterns, copy })}
          />
        </div>
      </section>

      <footer className="setup-actions">
        <div className="where">
          <span>Save in</span>
          <div className="choices" role="radiogroup" aria-label="Where to save">
            {info.workspace && (
              <button role="radio" aria-checked={where === 'workspace'} aria-label={info.workspace.name} className={`choice${where === 'workspace' ? ' on' : ''}`} title={info.workspace.file} onClick={() => setTarget('workspace')}>
                <Icon name="folder" />
                {info.workspace.name}
              </button>
            )}
            <button role="radio" aria-checked={where === 'user'} aria-label="User" className={`choice${where === 'user' ? ' on' : ''}`} title="Every repository you open" onClick={() => setTarget('user')}>
              <Icon name="account" />
              User
            </button>
          </div>
          <span className="muted">
            {where === 'workspace' && info.workspace ? `${info.workspace.file}, for everyone who works on it` : 'For every repository'}
          </span>
        </div>
        <label className="check">
          <input type="checkbox" checked={alsoVSCode} onChange={(event) => setAlsoVSCode(event.target.checked)} />
          Also in VS Code's git.worktreeSymlinkFolders and git.worktreeIncludeFiles, for the worktrees VS Code creates
        </label>
        <div className="buttons">
          <button className="button primary" disabled={savedHere && !alsoVSCode} onClick={() => save(patterns)}>
            <Icon name="save" />
            Save
          </button>
          <button className="button" disabled={!changed} onClick={() => setDraft(null)}>
            <Icon name="discard" />
            Discard changes
          </button>
          <button
            className="button"
            disabled={changed || !info.worktrees || (!info.effective.link.length && !info.effective.copy.length)}
            title={changed ? 'Save first: the worktrees get what is saved' : 'Nothing is made where a worktree has something already'}
            aria-label={`Bring into the ${info.worktrees === 1 ? 'other worktree' : `other ${info.worktrees} worktrees`}`}
            onClick={() => post({ type: 'action', action: { kind: 'worktreeSetUp' } })}
          >
            <Icon name="worktree" />
            Bring into the {info.worktrees === 1 ? 'other worktree' : `other ${info.worktrees} worktrees`}
          </button>
          <span className="grow" />
          {setHere && (
            <button className="button" title="What is set elsewhere applies again" aria-label={`Remove from ${where === 'user' ? 'User' : info.workspace?.name}`} onClick={() => save(null)}>
              <Icon name="trash" />
              Remove from {where === 'user' ? 'User' : info.workspace?.name}
            </button>
          )}
          <button className="button" onClick={() => post({ type: 'editWorktreeSetup', target: where })}>
            <Icon name="json" />
            Edit in settings.json
          </button>
        </div>
      </footer>
    </main>
  );
}
