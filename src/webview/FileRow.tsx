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
  /** Set when the row can be unfolded to show something below it; undefined hides the arrow. */
  expanded?: boolean;
  onToggle?(): void;
  /** Said after the name, before the buttons: such as how many lines changed. */
  extra?: ReactNode;
  /** How far in the row is, in a tree. There its directory is left out: the rows above say it. */
  depth?: number;
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

export function FileRow({ file, onOpen, actions, expanded, onToggle, extra, depth }: Props) {
  const slash = file.path.lastIndexOf('/');
  return (
    <div className="file" style={depth === undefined ? undefined : { paddingLeft: 12 + depth * INDENT }}>
      {onToggle && (
        <button className="twist" onClick={onToggle} aria-expanded={!!expanded} aria-label={`${expanded ? 'Hide' : 'Show'} hunks of ${file.path}`}>
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
        </button>
      )}
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
