import * as fs from 'node:fs';
import * as path from 'node:path';
import { git } from './exec';
import { Repo } from './repo';

/** Two spellings of the same directory compare equal, whatever the slashes and, on Windows, the case. */
const key = (dir: string) => (process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir));

/** The directories of the submodules of a repository that are checked out. */
async function submodules(root: string): Promise<string[]> {
  if (!fs.existsSync(path.join(root, '.gitmodules'))) return [];
  try {
    const args = ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'];
    const { stdout } = await git(root, args, { readOnly: true });
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => path.join(root, line.slice(line.indexOf(' ') + 1)))
      .filter((dir) => fs.existsSync(path.join(dir, '.git')));
  } catch {
    return [];
  }
}

function childDirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * The repositories a set of folders gives access to: the one each folder is in,
 * the ones directly inside a folder, and the submodules of all of these.
 */
export async function discoverRepos(folders: string[]): Promise<string[]> {
  const found = new Map<string, string>();
  const add = async (dir: string): Promise<void> => {
    const root = await Repo.discover(dir);
    if (!root || found.has(key(root))) return;
    found.set(key(root), root);
    for (const submodule of await submodules(root)) await add(submodule);
  };
  for (const folder of folders) {
    await add(folder);
    for (const child of childDirectories(folder)) {
      if (fs.existsSync(path.join(child, '.git'))) await add(child);
    }
  }
  return [...found.values()];
}

/** What to call a repository in a list: its path from the folder that contains it, or just its directory name. */
export function repoName(root: string, folders: string[]): string {
  for (const folder of folders) {
    const relative = path.relative(folder, root);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return `${path.basename(folder)}/${relative.replace(/\\/g, '/')}`;
    }
  }
  return path.basename(root);
}
