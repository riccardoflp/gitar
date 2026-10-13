import { describe, expect, it } from 'vitest';
import { fileTree, type TreeNode } from '../src/shared/tree';

/** The tree as it would be read on the page: a line for each node, further in at each level, files with their path after their name. */
const drawn = (nodes: TreeNode<string>[], depth = 0): string[] =>
  nodes.flatMap((node) => [
    `${'  '.repeat(depth)}${node.item === undefined ? `${node.name}/` : `${node.name} (${node.item})`}`,
    ...drawn(node.children, depth + 1),
  ]);
const tree = (paths: string[]) => drawn(fileTree(paths, (path) => path));

describe('the files of a commit under their directories', () => {
  it('puts directories before files, each in the order of their names whatever their case', () => {
    expect(tree(['b.txt', 'src/z.ts', 'README.md', 'src/App.ts', 'docs/intro.md', 'a.txt'])).toEqual([
      'docs/',
      '  intro.md (docs/intro.md)',
      'src/',
      '  App.ts (src/App.ts)',
      '  z.ts (src/z.ts)',
      'a.txt (a.txt)',
      'b.txt (b.txt)',
      'README.md (README.md)',
    ]);
  });

  it('makes one line of the directories that hold nothing but another, down to where they part', () => {
    expect(tree(['src/webview/a.tsx', 'src/webview/parts/b.tsx', 'test/e2e/deep/down/c.ts'])).toEqual([
      'src/webview/',
      '  parts/',
      '    b.tsx (src/webview/parts/b.tsx)',
      '  a.tsx (src/webview/a.tsx)',
      'test/e2e/deep/down/',
      '  c.ts (test/e2e/deep/down/c.ts)',
    ]);
  });

  it('keeps a file and a directory of the same name apart, as when one took the place of the other', () => {
    const nodes = fileTree(['lib', 'lib/index.ts'], (path) => path);
    expect(drawn(nodes)).toEqual(['lib/', '  index.ts (lib/index.ts)', 'lib (lib)']);
    // They share a path, and are told apart by what they are.
    expect(nodes.map((node) => [node.path, node.item === undefined])).toEqual([
      ['lib', true],
      ['lib', false],
    ]);
  });

  it('has nothing to show for no files, and no directory for files at the top', () => {
    expect(tree([])).toEqual([]);
    expect(tree(['only.txt'])).toEqual(['only.txt (only.txt)']);
  });

  it('gives the path of each directory in full, for the page to remember which are folded', () => {
    const [top] = fileTree(['a/b/c/one.txt', 'a/b/d/two.txt'], (path) => path);
    expect(top).toMatchObject({ name: 'a/b', path: 'a/b' });
    expect(top.children.map((node) => node.path)).toEqual(['a/b/c', 'a/b/d']);
  });
});
