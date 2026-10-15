import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { git, GitError } from './exec';
import type { OpLog } from './ops';

/*
 * VS Code's experimental settings git.worktreeSymlinkFolders and git.worktreeIncludeFiles bring into a new worktree
 * what git ignores in the checkout it is made from, such as node_modules or .env, but VS Code's Git extension applies
 * them only to the worktrees it creates itself. What follows works out the same folders and files the way it does
 * (VS Code 1.141), so the worktrees Gitardo creates get them too.
 */

/** The patterns of a setting, in `.gitignore` syntax. Like VS Code, those with a line break are left out. */
export function setupPatterns(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((pattern): pattern is string => typeof pattern === 'string' && !/[\r\n]/.test(pattern)) : [];
}

const paths = (output: string) => output.split('\0').filter(Boolean);

/** The output of a read-only git command; for `git check-ignore`, nothing matching is not a failure. */
async function read(cwd: string, args: string[], input?: string): Promise<string> {
  try {
    return (await git(cwd, args, { readOnly: true, input })).stdout;
  } catch (error) {
    if (input !== undefined && error instanceof GitError && error.result.code === 1) return '';
    throw error;
  }
}

/** Gives `use` a file holding the patterns, in a folder of its own that is removed afterwards. */
async function withPatterns<T>(patterns: string[], use: (file: string, folder: string) => Promise<T>): Promise<T> {
  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gitardo-worktree-'));
  try {
    const file = path.join(folder, 'patterns');
    await fs.promises.writeFile(file, `${patterns.join('\n')}\n`, 'utf8');
    return await use(file, folder);
  } finally {
    await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

/** The first folder of `folders` (each ending with a slash) that `file` is inside of. */
function folderOf(file: string, folders: Set<string>): string | undefined {
  for (let at = file.indexOf('/'); at !== -1; at = file.indexOf('/', at + 1)) {
    if (folders.has(file.slice(0, at + 1))) return file.slice(0, at + 1);
  }
  return undefined;
}

/** Whether one of `folders` (each ending with a slash) is `folder` itself, unless `strict`, or a folder it is inside of. */
function within(folder: string, folders: Set<string>, strict = false): boolean {
  for (let at = strict ? folder.lastIndexOf('/') : folder.length; at > 0; at = folder.lastIndexOf('/', at - 1)) {
    if (folders.has(`${folder.slice(0, at)}/`)) return true;
  }
  return false;
}

/**
 * The folders of the checkout in `root` to link into a new worktree: the outermost ones that git ignores and that
 * match the patterns of git.worktreeSymlinkFolders, relative to `root` with forward slashes.
 */
export async function foldersToLink(root: string, patterns: string[]): Promise<string[]> {
  if (!patterns.length) return [];
  return withPatterns(patterns, async (file, folder) => {
    const others = ['ls-files', '--others', '--ignored', '-z'];
    const [ignored, matching, collapsed] = await Promise.all([
      read(root, [...others, '--exclude-standard']),
      read(root, [...others, `--exclude-from=${file}`]),
      read(root, [...others, '--exclude-standard', '--directory']),
    ]);
    // Every folder that holds an ignored file matching the patterns.
    const matched = new Set(paths(matching));
    const candidates = new Set<string>();
    for (const entry of paths(ignored)) {
      if (!matched.has(entry)) continue;
      for (let at = entry.lastIndexOf('/'); at !== -1; at = entry.lastIndexOf('/', at - 1)) candidates.add(entry.slice(0, at));
    }
    if (!candidates.size) return [];

    // Those that git ignores as folders, and that the patterns name as folders, asked of a repository with no rules of its own.
    const matcher = path.join(folder, 'matcher');
    await fs.promises.mkdir(matcher);
    await read(matcher, ['init', '--quiet']);
    const input = [...candidates].map((candidate) => `${candidate}/`).join('\0');
    const [ignoredFolders, namedFolders] = await Promise.all([
      read(root, ['check-ignore', '--no-index', '-z', '--stdin'], input),
      read(matcher, ['-c', `core.excludesFile=${file}`, 'check-ignore', '--no-index', '-z', '--stdin'], input),
    ]);
    const ignoredSet = new Set(paths(ignoredFolders));
    const namedSet = new Set(paths(namedFolders));
    const ignoredWhole = new Set(paths(collapsed).filter((entry) => entry.endsWith('/')));
    const linked = [...candidates].filter(
      (candidate) => ignoredSet.has(`${candidate}/`) && namedSet.has(`${candidate}/`) && within(candidate, ignoredWhole),
    );
    const outer = new Set(linked.map((candidate) => `${candidate}/`));
    return linked.filter((candidate) => !within(candidate, outer, true));
  });
}

/**
 * The files and folders of the checkout in `root` to copy into the new worktree in `worktree`: those git ignores that
 * match the patterns of git.worktreeIncludeFiles, leaving out what is inside the folders `linked`, and what the worktree
 * has from its commit. A folder all of whose files are copied is copied as a whole.
 */
export async function pathsToCopy(root: string, worktree: string, patterns: string[], linked: string[]): Promise<string[]> {
  if (!patterns.length) return [];
  return withPatterns(patterns, async (file) => {
    const others = ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'];
    const [ignoredOutput, collapsedOutput, matchingOutput, trackedOutput] = await Promise.all([
      read(root, others),
      read(root, [...others, '--directory', '--no-empty-directory']),
      read(root, ['ls-files', '--others', '--ignored', `--exclude-from=${file}`, '-z']),
      read(worktree, ['ls-files', '-z']),
    ]);
    const ignored = paths(ignoredOutput);
    if (!ignored.length) return [];
    const matching = new Set(paths(matchingOutput));
    const collapsed = new Set(paths(collapsedOutput).filter((entry) => entry.endsWith('/')));
    const tracked = new Set(paths(trackedOutput));
    const linkedFolders = new Set(linked.map((folder) => (folder.endsWith('/') ? folder : `${folder}/`)));
    const trackedFolders = new Set<string>();
    for (const entry of tracked) {
      for (let at = entry.indexOf('/'); at !== -1; at = entry.indexOf('/', at + 1)) trackedFolders.add(entry.slice(0, at + 1));
    }
    // A file the worktree has, a folder it has files in, or a path under a file it has.
    const clashes = (entry: string) => {
      if (tracked.has(entry) || trackedFolders.has(`${entry}/`)) return true;
      for (let at = entry.indexOf('/'); at !== -1; at = entry.indexOf('/', at + 1)) if (tracked.has(entry.slice(0, at))) return true;
      return false;
    };

    const files: string[] = [];
    const partly = new Set<string>();
    for (const entry of ignored) {
      if (matching.has(entry) && folderOf(entry, linkedFolders) === undefined && !clashes(entry)) files.push(entry);
      else if (collapsed.size) {
        const folder = folderOf(entry, collapsed);
        if (folder !== undefined) partly.add(folder);
      }
    }
    if (!files.length) return [];
    const whole = new Set([...collapsed].filter((folder) => !partly.has(folder)));
    return [...[...whole].map((folder) => folder.slice(0, -1)), ...files.filter((entry) => folderOf(entry, whole) === undefined)];
  });
}

const sameOrInside = (parent: string, child: string) => {
  const fold = (text: string) => (process.platform === 'win32' || process.platform === 'darwin' ? text.toLowerCase() : text);
  const [outer, inner] = [fold(parent), fold(child)];
  return inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : `${outer}${path.sep}`);
};

/** Whether something is at `target` already, a broken link included: then nothing is made in its place. */
async function exists(target: string): Promise<boolean> {
  try {
    await fs.promises.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Refuses to make anything under a folder of the worktree that is a link, which would put it in the checkout. */
async function checkParents(worktree: string, relative: string): Promise<void> {
  let at = worktree;
  for (const part of path.dirname(relative).split(path.sep).filter((part) => part !== '.')) {
    at = path.join(at, part);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`${at} is a symbolic link.`);
    if (!stat.isDirectory()) throw new Error(`${at} is not a folder.`);
  }
}

/**
 * Links the folder `folder` of the checkout in `root` into the worktree in `worktree`, as a junction on Windows, which
 * needs no rights there. Says why when it does not: the worktree has it already, or is inside it.
 */
export async function linkFolder(root: string, worktree: string, folder: string): Promise<'linked' | 'exists' | 'contains'> {
  const relative = folder.split('/').join(path.sep);
  const source = path.join(root, relative);
  const target = path.join(worktree, relative);
  const [realSource, realWorktree] = await Promise.all([fs.promises.realpath(source), fs.promises.realpath(worktree)]);
  if (sameOrInside(realSource, realWorktree)) return 'contains';
  await checkParents(worktree, relative);
  if (await exists(target)) return 'exists';
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  return 'linked';
}

/** Copies the file or folder `relative` of the checkout in `root` into the worktree in `worktree`, unless it has it. */
export async function copyPath(root: string, worktree: string, relative: string): Promise<boolean> {
  const local = relative.split('/').join(path.sep);
  const target = path.join(worktree, local);
  await checkParents(worktree, local);
  if (await exists(target)) return false;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.cp(path.join(root, local), target, { recursive: true, force: true, verbatimSymlinks: true });
  return true;
}

/** Whether the link `link` leads to a folder outside `worktree`. */
async function folderOutside(link: string, worktree: string): Promise<boolean> {
  try {
    const [target, home] = await Promise.all([fs.promises.realpath(link), fs.promises.realpath(worktree)]);
    return !sameOrInside(home, target) && (await fs.promises.stat(target)).isDirectory();
  } catch {
    // A link to nothing has nothing to lose.
    return false;
  }
}

/**
 * Takes out of the worktree in `worktree` the links to folders outside it, such as those of git.worktreeSymlinkFolders,
 * before git removes it: git for Windows deletes what is inside a junction, which is the folder of the checkout it
 * links to. Only what git does not track is looked into, and nothing past a link. Each one goes to the log, as
 * `unlink <path>`, before it is taken out. Elsewhere git removes the link itself, so nothing is done.
 */
export async function unlinkFolderLinks(worktree: string, log: OpLog): Promise<void> {
  if (process.platform !== 'win32' || !fs.existsSync(worktree)) return;
  const others = ['ls-files', '--others', '--directory', '-z'];
  const [untracked, ignored] = await Promise.all([
    read(worktree, others),
    read(worktree, [...others, '--ignored', '--exclude-standard']),
  ]);
  const unlink = async (link: string) => {
    log.info(`> unlink ${link.split(path.sep).join('/')}`);
    await fs.promises.unlink(link);
  };
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
      const at = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) {
        if (await folderOutside(at, worktree)) await unlink(at);
      } else if (entry.isDirectory()) await walk(at);
    }
  };
  for (const entry of new Set([...paths(untracked), ...paths(ignored)])) {
    const at = path.join(worktree, entry.replace(/\/$/, '').split('/').join(path.sep));
    const stat = await fs.promises.lstat(at).catch(() => null);
    if (stat?.isSymbolicLink()) {
      if (await folderOutside(at, worktree)) await unlink(at);
    } else if (stat?.isDirectory()) await walk(at);
  }
}

/**
 * Brings into the new worktree in `worktree` what the settings ask for from the checkout in `root`: the folders to link
 * first, then the files to copy. Each one goes to the log, as `symlink <folder>` or `copy <path>`, before it is made.
 * Returns what could not be made, said for the user; one that fails does not stop the others.
 */
export async function setUpWorktree(
  root: string,
  worktree: string,
  patterns: { link: string[]; include: string[] },
  log: OpLog,
): Promise<string[]> {
  const failures: string[] = [];
  const fail = (what: string, error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn(`${what}: ${reason}`);
    failures.push(what);
  };

  let folders: string[] = [];
  try {
    folders = await foldersToLink(root, patterns.link);
  } catch (error) {
    fail('Finding the folders of git.worktreeSymlinkFolders', error);
  }
  const linked: string[] = [];
  for (const folder of folders) {
    log.info(`> symlink ${folder}`);
    try {
      const outcome = await linkFolder(root, worktree, folder);
      // What the worktree has there already is left alone, by the copies too.
      if (outcome !== 'contains') linked.push(folder);
      if (outcome !== 'linked') log.info(outcome === 'exists' ? `${folder} is in the worktree already.` : `${folder} holds the worktree, so it is not linked.`);
    } catch (error) {
      fail(`Linking ${folder}`, error);
    }
  }

  let copies: string[] = [];
  try {
    copies = await pathsToCopy(root, worktree, patterns.include, linked);
  } catch (error) {
    fail('Finding the files of git.worktreeIncludeFiles', error);
  }
  for (const relative of copies) {
    log.info(`> copy ${relative}`);
    try {
      if (!(await copyPath(root, worktree, relative))) log.info(`${relative} is in the worktree already.`);
    } catch (error) {
      fail(`Copying ${relative}`, error);
    }
  }
  return failures;
}
