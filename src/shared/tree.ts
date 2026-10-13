/** A directory in a tree of files, or one of the files: `item` is what the caller listed, and only files have one. */
export interface TreeNode<T> {
  /** What to call it. A directory with nothing in it but another has the names of both, as `src/git`. */
  name: string;
  /** Where it is from the top, which no other node of its kind shares. */
  path: string;
  children: TreeNode<T>[];
  item?: T;
}

const byName = (one: string, other: string) => {
  const [a, b] = [one.toLowerCase(), other.toLowerCase()];
  return a < b ? -1 : a > b ? 1 : one < other ? -1 : one > other ? 1 : 0;
};

/**
 * Lays files out under their directories, given their paths with `/` between the names. Directories come before
 * files, each in the order of their names, and a chain of directories that hold nothing else is one line.
 */
export function fileTree<T>(items: T[], pathOf: (item: T) => string): TreeNode<T>[] {
  const top: TreeNode<T> = { name: '', path: '', children: [] };
  const directories = new Map<string, TreeNode<T>>([['', top]]);
  const parentOf = (path: string) => directory(path.slice(0, Math.max(0, path.lastIndexOf('/'))));
  const directory = (path: string): TreeNode<T> => {
    let node = directories.get(path);
    if (!node) {
      node = { name: path.slice(path.lastIndexOf('/') + 1), path, children: [] };
      directories.set(path, node);
      parentOf(path).children.push(node);
    }
    return node;
  };
  for (const item of items) {
    const path = pathOf(item);
    parentOf(path).children.push({ name: path.slice(path.lastIndexOf('/') + 1), path, children: [], item });
  }

  const tidy = (node: TreeNode<T>): TreeNode<T> => {
    if (node.item !== undefined) return node;
    const children = node.children.map(tidy).sort((one, other) => {
      const files = Number(one.item !== undefined) - Number(other.item !== undefined);
      return files || byName(one.name, other.name);
    });
    const [only] = children;
    // Not the top, which has no name to put before the other's.
    if (children.length === 1 && only.item === undefined && node !== top) return { ...only, name: `${node.name}/${only.name}` };
    return { ...node, children };
  };
  return tidy(top).children;
}
