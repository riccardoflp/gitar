import type { Comparison, DiffSource } from '../shared/protocol';
import { FILES_LIMIT, useCapped } from './Capped';
import { FileRow } from './FileRow';
import { Icon } from './Icon';
import type { Comparing } from './menus';
import { shortHash } from './util';
import { post } from './vscode';

interface Props {
  comparing: Comparing;
  /** Null while the list of files loads. */
  comparison: Comparison | null;
  onSwap(): void;
  onJump(hash: string): void;
  onClose(): void;
}

/** The files that differ between two commits, in place of the details of one. */
export function Compare({ comparing, comparison, onSwap, onJump, onClose }: Props) {
  const { from, to, fromName, toName } = comparing;
  const source: DiffSource = { kind: 'commit', hash: to, parent: from };
  const [files, moreFiles] = useCapped(comparison?.files ?? [], FILES_LIMIT, 'files', `${from}..${to}`);
  const side = (name: string, hash: string) => (
    <dd>
      {name !== shortHash(hash) && name}
      <button className="link mono" title="Show this commit" onClick={() => onJump(hash)}>
        {shortHash(hash)}
      </button>
    </dd>
  );
  return (
    <aside className="detail" aria-label="Comparison">
      <button className="button icon close" onClick={onClose} aria-label="Close comparison" title="Close">
        <Icon name="close" />
      </button>
      <h2>Comparison</h2>
      <dl>
        <dt>From</dt>
        {side(fromName, from)}
        <dt>To</dt>
        {side(toName, to)}
      </dl>
      <button className="button swap" onClick={onSwap} title="Compare in the other direction">
        <Icon name="arrow-swap" />
        Swap
      </button>
      {!comparison ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <h3>
            <span className="grow">
              {comparison.files.length} changed {comparison.files.length === 1 ? 'file' : 'files'}
            </span>
            {comparison.files.length > 1 && (
              <button
                className="button icon"
                title="Open all changes in one editor"
                aria-label="Open all changes in one editor"
                onClick={() => post({ type: 'openChanges', source, files: comparison.files, title: `${fromName} ↔ ${toName}` })}
              >
                <Icon name="diff-multiple" />
              </button>
            )}
          </h3>
          <div className="files">
            {files.map((file) => (
              <FileRow key={file.path} file={file} onOpen={() => post({ type: 'openDiff', source, file })} />
            ))}
            {moreFiles}
          </div>
        </>
      )}
    </aside>
  );
}
