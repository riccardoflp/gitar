import { Fragment, type ReactNode } from 'react';
import type { TreeNode } from '../shared/tree';
import { INDENT } from './FileRow';
import { Icon } from './Icon';

interface Props<T> {
  nodes: TreeNode<T>[];
  /** How far in these are: 0 at the top. */
  depth?: number;
  /** The directories that are closed, by their paths. */
  folded: ReadonlySet<string>;
  onFold(path: string): void;
  /** The row of a file, that far in. */
  row(item: T, depth: number): ReactNode;
}

/** A set with a value added, or taken out if it is there. */
export const toggled = (set: ReadonlySet<string>, value: string) => {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
};

/** Files under their directories, each of which opens and closes. */
export function FileTree<T>({ nodes, depth = 0, folded, onFold, row }: Props<T>) {
  return nodes.map((node) => {
    if (node.item !== undefined) return <Fragment key={`file:${node.path}`}>{row(node.item, depth)}</Fragment>;
    const open = !folded.has(node.path);
    return (
      <div key={`directory:${node.path}`}>
        <button className="file directory" style={{ paddingLeft: 12 + depth * INDENT }} aria-expanded={open} onClick={() => onFold(node.path)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <span className="name">{node.name}</span>
        </button>
        {open && <FileTree nodes={node.children} depth={depth + 1} folded={folded} onFold={onFold} row={row} />}
      </div>
    );
  });
}
