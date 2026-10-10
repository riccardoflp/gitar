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

export function ActionButtons({ actions }: { actions?: FileAction[] }) {
  return actions?.map((action) => (
    <button key={action.title} className="button icon" title={action.title} aria-label={action.title} onClick={action.run}>
      <Icon name={action.icon} />
    </button>
  ));
}

export function FileRow({ file, onOpen, actions, expanded, onToggle }: Props) {
  const slash = file.path.lastIndexOf('/');
  const title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return (
    <div className="file">
      {onToggle && (
        <button className="twist" onClick={onToggle} aria-expanded={!!expanded} aria-label={`${expanded ? 'Hide' : 'Show'} hunks of ${file.path}`}>
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
        </button>
      )}
      <button className="file-open" title={title} onClick={onOpen}>
        <span className={`status status-${file.status === '?' ? 'untracked' : file.status}`} title={STATUS_TITLES[file.status]}>
          {file.status}
        </span>
        <span className="name">{file.path.slice(slash + 1)}</span>
        <span className="dir">{file.path.slice(0, Math.max(0, slash))}</span>
      </button>
      <ActionButtons actions={actions} />
    </div>
  );
}
