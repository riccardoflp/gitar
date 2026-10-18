import type { ReactNode } from 'react';
import type { FileChange } from '../shared/protocol';
import { Icon } from './Icon';

export interface FileAction {
  icon: string;
  title: string;
  run(): void;
}

interface Props {
  file: FileChange;
  onOpen(): void;
  actions?: FileAction[];
  /** Said after the name, before the buttons: such as how many lines changed. */
  extra?: ReactNode;
  /** How far in the row is, in a tree. There its directory is left out: the rows above say it. */
  depth?: number;
  /** Set when files can be picked to act on several at once: a box to tick before the name. */
  onPick?(picked: boolean): void;
  picked?: boolean;
  /** The box is half ticked: ticking it picks all of the file. */
  mixed?: boolean;
  /** What ticking the box does to the file, said before its name to a screen reader: `Select` when not given. */
  pickVerb?: string;
  /** What the box does, under the pointer. */
  pickTitle?: string;
}

const STATUS_TITLES: Record<string, string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Conflict',
  '?': 'Untracked',
};

/** The room a level of a tree takes, in pixels: what puts a file under the name of its directory, past the arrow. */
export const INDENT = 18;

export function ActionButtons({ actions }: { actions?: FileAction[] }) {
  return actions?.map((action) => (
    <button key={action.title} className="button icon" title={action.title} aria-label={action.title} onClick={action.run}>
      <Icon name={action.icon} />
    </button>
  ));
}

/** The letter git has for what happened to a file, in the color VS Code gives it. */
export function Status({ file }: { file: FileChange }) {
  return (
    <span className={`status status-${file.status === '?' ? 'untracked' : file.status}`} title={STATUS_TITLES[file.status]}>
      {file.status}
    </span>
  );
}

export const fileTitle = (file: FileChange) => (file.oldPath ? `${file.oldPath} → ${file.path}` : file.path);

interface CheckProps {
  checked: boolean;
  /** Half ticked: neither all nor nothing. A click ticks it. */
  mixed?: boolean;
  label: string;
  title?: string;
  onChange(checked: boolean): void;
}

/** A box to tick, which can also be half ticked. */
export function Check({ checked, mixed = false, label, title, onChange }: CheckProps) {
  return (
    <input
      // Half ticked is not an attribute: it is set on the element, at every render so that it follows.
      ref={(box) => {
        if (box) box.indeterminate = mixed;
      }}
      type="checkbox"
      className="pick"
      checked={checked}
      aria-label={label}
      title={title}
      onChange={(event) => {
        onChange(event.target.checked);
        // React puts back `checked` until the new state comes, but not the half tick that the click took away.
        event.target.indeterminate = mixed;
      }}
    />
  );
}

export function FileRow({ file, onOpen, actions, extra, depth, onPick, picked, mixed, pickVerb = 'Select', pickTitle }: Props) {
  const slash = file.path.lastIndexOf('/');
  return (
    <div className="file" style={depth === undefined ? undefined : { paddingLeft: 12 + depth * INDENT }}>
      {onPick && <Check checked={!!picked} mixed={mixed} label={`${pickVerb} ${file.path}`} title={pickTitle} onChange={onPick} />}
      <button className="file-open" title={fileTitle(file)} onClick={onOpen}>
        <Status file={file} />
        <span className="name">{file.path.slice(slash + 1)}</span>
        {depth === undefined && slash > 0 && (
          <span className="dir">
            {/* Read from the left as it is written, whichever end the line is cut at. */}
            <bdi>{file.path.slice(0, slash)}</bdi>
          </span>
        )}
      </button>
      {extra}
      <ActionButtons actions={actions} />
    </div>
  );
}
