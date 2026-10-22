import * as fs from 'node:fs';
import * as path from 'node:path';
import { GraphLayout } from '../shared/graph';
import {
  GRAPH_COLUMNS,
  WORKTREE,
  type Bisect,
  type BranchLog,
  type Commit,
  type CommitDetail,
  type CompareMode,
  type CompareView,
  type Comparison,
  type FileChange,
  type FileHunks,
  type FilePatch,
  type Filter,
  type Operation,
  type RepoState,
  type Row,
  type Scope,
  type Search,
  type Stash,
  type Submodule,
  type WorkingState,
  type Worktree,
} from '../shared/protocol';
import { subjectAndBody } from '../shared/message';
import { REF_KINDS, SCOPE_PREFIXES, pruneScope, scopeKinds } from '../shared/scope';
import { resolveConflicts, type Conflict } from './conflicts';
import { GitError, formatCommand, git, type GitResult } from './exec';
import type { UndoInfo } from './ops';
import {
  COMPARE_FORMAT,
  DETAIL_FORMAT,
  LOG_FORMAT,
  REF_FORMAT,
  STASH_FORMAT,
  REFLOG_FORMAT,
  allChanges,
  recentBranches,
  parseBisectRefs,
  parseBlame,
  parseBlameLine,
  parseCherryMarks,
  parseCompareCommits,
  parseHunks,
  parseIdentity,
  parseReflog,
  type BlameLine,
  type ReflogEntry,
  parseLog,
  parseBranchStatus,
  parseGitlinks,
  parseGitmodules,
  parseNameStatus,
  parsePatch,
  parseRefs,
  parseStashes,
  parseStatus,
  parseWorktrees,
} from './parse';

export function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{7,64}$/.test(value);
}

/** A file in conflict as it is in the working tree, and as it would be with the conflicts that need no choice resolved. */
export interface ConflictPlan {
  path: string;
  /** What the file has now, markers and all. */
  text: string;
  resolved: string;
  conflicts: Conflict[];
}

/** How far back in the moves of HEAD the branches checked out last are looked for. */
const RECENT_MOVES = 300;
/** Larger files in conflict are left to the user. */
const CONFLICT_BYTES = 2 * 1024 * 1024;
/** No more files in conflict than this are read to see what can be resolved. */
const CONFLICT_FILES = 200;
/** How deep submodules inside submodules are looked for. */
const SUBMODULE_DEPTH = 4;
/**
 * A diff as plain as git prints it, whatever the configuration says of colors, of other programs to compare with, of
 * files turned into text first or of submodules, which could be listed with their commits.
 */
const PLAIN_DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--submodule=short'];
/** The most commits of a comparison listed in its tab, newest first. */
const COMPARE_COMMITS = 2000;
/** Past this many commits on the two sides together they are not matched with each other: git reads every change. */
const CHERRY_COMMITS = 2000;

/** What a side of a comparison can be: a commit, or the working tree. */
const isSide = (side: string) => side === WORKTREE || isHash(side);

/** What `git diff` is given for the changes from `since` to `to`, either of which can be the working tree. */
function diffSides(since: string, to: string): string[] {
  if (to === WORKTREE) return [since];
  if (since === WORKTREE) return ['-R', to];
  return [since, to];
}

/** What narrows a comparison to a file or a folder, or nothing. */
const within = (path: string | null) => (path ? ['--', `:(literal)${path}`] : ['--']);

export interface BlameOptions {
  /** The text of the file when it has unsaved edits. */
  contents?: string;
  /** The commit to blame the file as it was in, rather than as it is in the working tree. */
  revision?: string;
  /**
   * Whether a line is left to who wrote it when all that was changed since is its whitespace, or where in the file
   * it is: `-w -M`.
   */
  ignoreWhitespace?: boolean;
}

/** What `git blame` is told before the name of the file. */
function blameArgs({ contents, revision, ignoreWhitespace }: BlameOptions): string[] {
  const args: string[] = [];
  if (ignoreWhitespace) args.push('-w', '-M');
  if (contents !== undefined) args.push('--contents', '-');
  if (revision) args.push(revision);
  return args;
}

/** Read-only view of one repository. Everything that changes the repository goes through `ops.ts` instead. */
/** A commit of the graph, or a stash among them. */
type Listed = Commit & Pick<Row, 'stash'>;

export class Repo {
  private gitDir?: string;
  /** Whether the graph follows only the first parent of each merge, as the settings say: what was merged is left out. */
  firstParent = false;

  constructor(
    readonly root: string,
    private readonly onCommand: (command: string) => void = () => {},
  ) {}

  /** Returns the top-level directory of the repository containing `dir`, or null if there is none. */
  static async discover(dir: string): Promise<string | null> {
    try {
      const { stdout } = await git(dir, ['rev-parse', '--show-toplevel'], { readOnly: true });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async read(args: string[], allowFail = false): Promise<string> {
    this.onCommand(formatCommand(args));
    try {
      return (await git(this.root, args, { readOnly: true })).stdout;
    } catch (error) {
      if (allowFail) return '';
      throw error;
    }
  }

  /** The directory shared by all worktrees, where refs live. */
  async commonDir(): Promise<string> {
    const out = await this.read(['rev-parse', '--git-common-dir']);
    return path.resolve(this.root, out.trim());
  }

  /** The git directory of the repository in a folder, from the root: a submodule has its own inside the one that has it. */
  async gitDirAt(folder: string): Promise<string> {
    return (await this.read([...(folder ? ['-C', folder] : []), 'rev-parse', '--absolute-git-dir'])).trim();
  }

  /** Whether a commit has submodules: a `.gitmodules` file. */
  async hasSubmodulesAt(revision: string): Promise<boolean> {
    if (!revision || revision.startsWith('-')) return false;
    return (await this.query(['cat-file', '-e', `${revision}:.gitmodules`])).code === 0;
  }

  /**
   * The commits after `hash` up to HEAD, newest first, when they make one line without merges: what rewriting `hash`
   * by an interactive rebase rewrites too. Null when `hash` is not before HEAD that way.
   */
  async lineAfter(hash: string): Promise<string[] | null> {
    if (!isHash(hash) || (await this.query(['merge-base', '--is-ancestor', hash, 'HEAD'])).code !== 0) return null;
    const lines = (await this.read(['rev-list', '--topo-order', '--parents', `${hash}..HEAD`])).split('\n').filter(Boolean);
    const commits = lines.map((line) => line.split(' '));
    if (commits.some((commit) => commit.length > 2)) return null;
    // Each is the parent of the one before it, down to `hash`.
    const chain = [...commits.map((commit) => commit[0]), hash];
    if (commits.some((commit, index) => commit[1] !== chain[index + 1])) return null;
    // Nor can a merge be made again by a rebase that picks it.
    if ((await this.read(['rev-list', '--parents', '-n', '1', hash])).trim().split(' ').length > 2) return null;
    return commits.map((commit) => commit[0]);
  }

  /** The remote branches that have a commit: where it was pushed. */
  async remoteBranchesWith(hash: string): Promise<string[]> {
    if (!isHash(hash)) return [];
    const out = await this.read(['for-each-ref', '--contains', hash, '--format=%(refname:short)', 'refs/remotes'], true);
    return out.split('\n').filter((name) => name && !name.endsWith('/HEAD') && name.includes('/'));
  }

  /** The files a stash changes, and the untracked files it took along, if any. */
  async stashFiles(ref: string): Promise<{ changed: string[]; untracked: string[] }> {
    if (!/^stash@\{\d+\}$/.test(ref)) throw new Error(`"${ref}" is not a stash.`);
    const list = (out: string) => out.split('\0').filter(Boolean);
    const changed = list(await this.read(['diff', '--name-only', '-z', `${ref}^1`, ref]));
    // A stash made without its untracked files has no third parent.
    const untracked = list(await this.read(['ls-tree', '-r', '-z', '--name-only', `${ref}^3`], true));
    return { changed, untracked };
  }

  /**
   * Whether `git branch -d` deletes a branch without forcing: when its upstream has its commits, or HEAD when it has no
   * upstream.
   */
  async isMergedForDelete(name: string, upstream: string | null): Promise<boolean> {
    const into = upstream ?? 'HEAD';
    return (await this.query(['merge-base', '--is-ancestor', `refs/heads/${name}`, into])).code === 0;
  }

  /** The message of a commit, as it was written: its subject and its body. */
  async commitMessage(hash: string): Promise<string> {
    if (!isHash(hash)) throw new Error(`"${hash}" is not a commit.`);
    return (await this.read(['log', '-1', '--format=%B', hash])).trimEnd();
  }

  async working(): Promise<WorkingState> {
    return parseStatus(await this.read(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  }

  /** Those of these files, by their paths from the root, that git ignores. A tracked file is never ignored. */
  async ignored(paths: string[]): Promise<Set<string>> {
    if (!paths.length) return new Set();
    const args = ['check-ignore', '-z', '--stdin'];
    this.onCommand(formatCommand(args));
    try {
      const { stdout } = await git(this.root, args, { readOnly: true, input: paths.map((file) => `${file}\0`).join('') });
      return new Set(stdout.split('\0').filter(Boolean));
    } catch {
      // Git ends with an error when none of them is ignored.
      return new Set();
    }
  }

  /** Whether git left a marker file of that name in this worktree's git directory. */
  private async hasMarker(...names: string[]): Promise<boolean> {
    this.gitDir ??= (await this.read(['rev-parse', '--absolute-git-dir'])).trim();
    return names.some((name) => fs.existsSync(path.join(this.gitDir!, name)));
  }

  /** The operation that stopped half way, if any. */
  async operation(): Promise<Operation | null> {
    // A rebase replays commits by cherry-picking, so its markers must be checked first.
    if (await this.hasMarker('rebase-merge', 'rebase-apply')) return 'rebase';
    if (await this.hasMarker('MERGE_HEAD')) return 'merge';
    if (await this.hasMarker('CHERRY_PICK_HEAD')) return 'cherry-pick';
    if (await this.hasMarker('REVERT_HEAD')) return 'revert';
    // Between two commits of a series there is no such marker, only the list of what is left to do.
    if (await this.hasMarker('sequencer/todo')) {
      const todo = fs.readFileSync(path.join(this.gitDir!, 'sequencer', 'todo'), 'utf8');
      return todo.startsWith('revert') ? 'revert' : 'cherry-pick';
    }
    return null;
  }

  /** Every name a file has had, the given one first: renames are followed back through the history of HEAD. */
  async pathNames(file: string): Promise<string[]> {
    const out = await this.read(['log', '--follow', '-M', '--name-status', '-z', '--format=', '--', `:(literal)${file}`], true);
    const names = new Set([file]);
    for (const change of parseNameStatus(out.replaceAll('\n', ''))) {
      // `--follow` also goes on into the file this one was copied from, or just resembled when it was added.
      // That is another file with its own history, so the search ends where this one first appeared.
      if (change.status === 'C' || change.status === 'A') break;
      names.add(change.path);
      if (change.oldPath) names.add(change.oldPath);
    }
    return [...names];
  }

  /** Which sides of a conflict the index has for a file: 1 is the common ancestor, 2 "ours", 3 "theirs". */
  /** The files in conflict, from the root of the repository. */
  async conflicted(): Promise<string[]> {
    const out = await this.read(['diff', '--name-only', '--diff-filter=U', '-z'], true);
    return [...new Set(out.split('\0').filter(Boolean))];
  }

  /**
   * The subjects of the commit checked out and of the one coming in, for whoever is asked to resolve a conflict
   * between them. Null where there is no such commit.
   */
  async conflictSubjects(): Promise<[ours: string | null, theirs: string | null]> {
    const incoming = { merge: 'MERGE_HEAD', 'cherry-pick': 'CHERRY_PICK_HEAD', revert: 'REVERT_HEAD', rebase: 'REBASE_HEAD' };
    const operation = await this.operation().catch(() => null);
    const subject = async (ref: string) => (await this.read(['log', '-1', '--format=%s', ref, '--'], true)).trim() || null;
    return [await subject('HEAD'), operation ? await subject(incoming[operation]) : null];
  }

  async conflictStages(file: string): Promise<number[]> {
    const out = await this.read(['ls-files', '--unmerged', '-z', '--', `:(literal)${file}`], true);
    // Each record is "<mode> <object> <stage>\t<path>".
    return out
      .split('\0')
      .filter(Boolean)
      .map((record) => Number(record.split('\t')[0].split(' ')[2]));
  }

  /**
   * What can be resolved without a choice in each of these files in conflict. Left out are the files without the
   * markers of git: binary ones, the ones a side deleted, and the ones that are not text that can be written as read.
   */
  async conflictPlans(files: string[]): Promise<ConflictPlan[]> {
    const plans: ConflictPlan[] = [];
    for (const file of files.slice(0, CONFLICT_FILES)) {
      try {
        const full = path.join(this.root, file);
        const stat = await fs.promises.lstat(full);
        if (!stat.isFile() || stat.size > CONFLICT_BYTES) continue;
        const bytes = await fs.promises.readFile(full);
        const text = bytes.toString('utf8');
        if (!text.includes('<<<<<<<') || text.includes('\0') || !Buffer.from(text, 'utf8').equals(bytes)) continue;
        // The file before either side changed it: there is none when both added it.
        const [base, ours, theirs] = await Promise.all([':1', ':2', ':3'].map((stage) => this.show(stage, file)));
        const { text: resolved, conflicts } = resolveConflicts(text, base, { ours, theirs });
        if (conflicts.length) plans.push({ path: file, text, resolved, conflicts });
      } catch {
        // A file that cannot be read is one to resolve by hand.
      }
    }
    return plans;
  }

  /** The bisect in progress, if any, with the commits marked so far. */
  async bisect(): Promise<Bisect | null> {
    if (!(await this.hasMarker('BISECT_START'))) return null;
    const marks = parseBisectRefs(await this.read(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/bisect'], true));
    let suspects: number | null = null;
    if (marks.bad && marks.good.length) {
      // The first bad commit is `bad` or one of its ancestors that no good commit can reach.
      const count = (await this.read(['rev-list', '--count', marks.bad, '--not', ...marks.good], true)).trim();
      if (count) suspects = Number(count);
    }
    return { ...marks, suspects };
  }

  /** The `user.*` settings this repository has of its own, rather than inheriting them. */
  async localIdentityKeys(): Promise<string[]> {
    const out = await this.read(['config', '--local', '--get-regexp', '^user\\.'], true);
    return [...new Set(out.split('\n').filter(Boolean).map((line) => line.split(' ')[0].toLowerCase()))];
  }

  /** The commit that a branch, a tag, a hash or any other expression git understands stands for. Null when there is none. */
  async resolve(revision: string): Promise<string | null> {
    // What starts with a dash would be read as an option.
    if (!revision || revision.startsWith('-')) return null;
    const out = await this.read(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], true);
    return out.trim() || null;
  }

  /** The files that differ between two commits. */
  async compare(from: string, to: string): Promise<Comparison | null> {
    if (!isHash(from) || !isHash(to)) return null;
    return { from, to, files: parseNameStatus(await this.read(['diff', '--name-status', '-z', '-M', from, to], true)) };
  }

  /** The commit two others have in common, the nearest when there are several. Null when their histories never met. */
  async mergeBase(a: string, b: string): Promise<string | null> {
    if (!isHash(a) || !isHash(b)) return null;
    return (await this.read(['merge-base', a, b], true)).trim() || null;
  }

  /**
   * Two commits, or a commit and the working tree, compared as the tab of a comparison shows them: the commits each has
   * that the other has not, those of the working tree being HEAD's, the files that differ, from the commit the two have
   * in common when `diverged` or else from `from`, and whether merging `to` into `from` would conflict. With `path`,
   * only the files and the commits of that file or folder.
   */
  async compareSides(from: string, to: string, mode: CompareMode, path: string | null = null): Promise<Omit<CompareView, 'from' | 'to' | 'mode'> | null> {
    if (!isSide(from) || !isSide(to) || (from === WORKTREE && to === WORKTREE)) return null;
    const head = from === WORKTREE || to === WORKTREE ? await this.resolve('HEAD') : null;
    const ours = from === WORKTREE ? head : from;
    const theirs = to === WORKTREE ? head : to;
    if (!ours || !theirs) return null;
    const [base, { ahead, behind }] = await Promise.all([this.mergeBase(ours, theirs), this.divergence(theirs, ours)]);
    const since = mode === 'diverged' && base ? base : from;
    const matched = ahead + behind <= CHERRY_COMMITS;
    const range = `${ours}...${theirs}`;
    // Only two commits that each have commits of their own merge with a merge commit, and so can conflict.
    const merging = !head && ahead > 0 && behind > 0;
    const [files, log, marks, conflicts] = await Promise.all([
      this.read(['diff', '--name-status', '-z', '-M', ...diffSides(since, to), ...within(path)]),
      this.read(['log', '--left-right', `--max-count=${COMPARE_COMMITS}`, `--format=${COMPARE_FORMAT}`, range, ...within(path)]),
      matched ? this.read(['rev-list', '--cherry-mark', range, ...within(path)]) : '',
      merging ? this.conflictsWith(theirs, undefined, ours) : null,
    ]);
    const commits = parseCompareCommits(log, parseCherryMarks(marks));
    return { base, since, ahead, behind, commits, matched, conflicts, path, files: parseNameStatus(files) };
  }

  /**
   * What changed in each of these files from one commit to another, either of which can be the working tree: the files
   * `compare` or `compareSides` listed, in the same order, and no more than `limit` lines of them. Null when the two do
   * not match.
   */
  async comparePatch(files: FileChange[], since: string, to: string, limit: number, path: string | null = null): Promise<FilePatch[] | null> {
    if (!isSide(since) || !isSide(to)) return null;
    return parsePatch(files, await this.read(['diff', ...PLAIN_DIFF, '-M', ...diffSides(since, to), ...within(path)]), limit);
  }

  /** The changes from one commit to another, either of which can be the working tree, as a patch `git apply` takes. */
  async compareText(since: string, to: string, path: string | null = null): Promise<string> {
    if (!isSide(since) || !isSide(to)) return '';
    return this.read(['diff', ...PLAIN_DIFF, '--binary', '-M', ...diffSides(since, to), ...within(path)]);
  }

  /**
   * Counts what is not committed in each worktree: in this one it is known already, in the others `git status` is run in
   * their folders, all at once and without taking the lock of their index.
   */
  private async worktreeChanges(worktrees: Worktree[], here: number): Promise<Worktree[]> {
    return Promise.all(
      worktrees.map(async (worktree) => {
        if (worktree.current) return { ...worktree, changes: here };
        if (worktree.prunable) return worktree;
        try {
          const { stdout } = await git(worktree.path, ['status', '--porcelain', '--untracked-files=all'], { readOnly: true });
          return { ...worktree, changes: stdout.split('\n').filter(Boolean).length };
        } catch {
          return worktree;
        }
      }),
    );
  }

  /**
   * The submodules of the repository in the folder `parent` (from the root, empty for the root itself), and theirs, each
   * after the one it is in. Each initialized one is asked what it has checked out, all of them at once.
   */
  async submodules(parent = '', depth = 0): Promise<Submodule[]> {
    if (depth > SUBMODULE_DEPTH || !fs.existsSync(path.join(this.root, parent, '.gitmodules'))) return [];
    // Run in the repository that has them, which for a submodule inside another is that other one.
    const at = (folder: string) => (folder ? ['-C', folder] : []);
    const entries = parseGitmodules(await this.read([...at(parent), 'config', '-z', '--file', '.gitmodules', '--get-regexp', '^submodule\\.'], true));
    if (!entries.length) return [];
    const paths = entries.map((entry) => entry.path);
    const [treeOut, indexOut] = await Promise.all([
      // Before the first commit there is no HEAD, and nothing recorded.
      this.read([...at(parent), 'ls-tree', '-z', 'HEAD', '--', ...paths], true),
      this.read([...at(parent), 'ls-files', '-s', '-z', '--', ...paths.map((file) => `:(literal)${file}`)], true),
    ]);
    const recorded = parseGitlinks(treeOut, 'tree');
    const staged = parseGitlinks(indexOut, 'index');
    const found = await Promise.all(
      entries.map(async (entry): Promise<Submodule[]> => {
        const folder = parent ? `${parent}/${entry.path}` : entry.path;
        const commit = recorded.get(entry.path) ?? null;
        const inIndex = staged.get(entry.path) ?? null;
        const submodule: Submodule = {
          path: folder,
          parent,
          name: entry.name,
          url: entry.url,
          branch: entry.branch,
          recorded: commit,
          staged: inIndex && inIndex !== commit ? inIndex : null,
          head: null,
          headBranch: null,
          ahead: null,
          behind: null,
          changes: null,
        };
        // Without a repository of its own, git would run in the one around it.
        if (!fs.existsSync(path.join(this.root, folder, '.git'))) return [submodule];
        try {
          const status = parseBranchStatus(await this.read([...at(folder), 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']));
          submodule.head = status.head;
          submodule.headBranch = status.branch;
          submodule.changes = status.changes;
        } catch {
          return [submodule];
        }
        if (commit && submodule.head === commit) {
          submodule.ahead = 0;
          submodule.behind = 0;
        } else if (commit && submodule.head) {
          // Fails when the recorded commit is not in it yet.
          const counts = (await this.read([...at(folder), 'rev-list', '--left-right', '--count', `${commit}...${submodule.head}`, '--'], true)).trim();
          if (counts) [submodule.behind, submodule.ahead] = counts.split(/\s+/).map(Number);
        }
        return [submodule, ...(await this.submodules(folder, depth + 1))];
      }),
    );
    return found.flat();
  }

  /**
   * With `resolve`, the files with conflicts are read to say which of the conflicts need no choice between the two
   * sides. With `stashes`, the stashes are among the commits.
   */
  async state(limit: number, filter: Filter | null = null, scope: Scope | null = null, resolve = false, stashes = false): Promise<RepoState> {
    const [refsOut, headOut, branchOut, stashOut, worktreeOut, remoteOut, identityOut, movesOut, working, operation, bisect, submodules] = await Promise.all([
      this.read(['for-each-ref', `--format=${REF_FORMAT}`]),
      this.read(['rev-parse', '--verify', '--quiet', 'HEAD'], true),
      // Asked in full: the short form of a branch that shares its name with a tag is `heads/<name>`.
      this.read(['symbolic-ref', '--quiet', 'HEAD'], true),
      this.read(['stash', 'list', '-z', `--format=${STASH_FORMAT}`], true),
      this.read(['worktree', 'list', '--porcelain']),
      this.read(['remote']),
      this.read(['config', '--get-regexp', '^user\\.(name|email)$'], true),
      // Where HEAD has been, for the branches that were checked out last. There is none before the first commit.
      this.read(['reflog', `--max-count=${RECENT_MOVES}`, '--format=%gs', 'HEAD'], true),
      this.working(),
      this.operation(),
      this.bisect(),
      this.submodules(),
    ]);
    const head = headOut.trim() || null;
    const changes = allChanges(working);
    const plans = resolve && working.conflicts.length ? await this.conflictPlans(working.conflicts.map((file) => file.path)) : [];
    const refs = parseRefs(refsOut);
    const branch = branchOut.trim().replace(/^refs\/heads\//, '') || null;
    // A branch chosen for the graph may have been deleted since.
    const shown = pruneScope(scope, { ...refs, branch });

    const { args, names } = await this.selection(filter, head, shown);
    // A search can be one git refuses, such as an invalid regular expression: that must be reported, not shown as no results.
    const commits = parseLog(await this.read(['log', '-z', `--format=${LOG_FORMAT}`, `--max-count=${limit + 1}`, ...args], !filter));
    const hasMore = commits.length > limit;
    if (hasMore) commits.length = limit;
    // The other parents of a merge are not followed: a line to them would lead nowhere.
    if (this.firstParent) for (const commit of commits) commit.parents.length = Math.min(commit.parents.length, 1);
    const stashList = parseStashes(stashOut);
    // Not among the results of a search, nor in the history of a file or of a commit, which they are no part of.
    const listed: Listed[] = stashes && !filter && stashList.length ? await this.withStashes(commits, stashList) : commits;

    const layout = new GraphLayout();
    const rows: Row[] = [];
    // Search results are unrelated commits: drawing lines between them would suggest a history that is not there.
    const connected = !filter || filter.kind === 'path' || filter.kind === 'ref';
    // Nor are the changes shown above a graph that leaves out the commit they are made on.
    const headListed = !shown || !head || commits.some((commit) => commit.hash === head);
    if (changes.length && !filter && headListed) {
      // Before the first commit there is no HEAD to hang the changes on, and they are all there is to show.
      const parents = head ? [head] : [];
      rows.push({
        hash: WORKTREE,
        parents,
        author: '',
        email: '',
        date: 0,
        subject: `Uncommitted changes (${changes.length})`,
        graph: layout.next(WORKTREE, parents, true),
      });
    }
    for (const commit of listed) {
      rows.push({ ...commit, graph: layout.next(commit.hash, connected ? commit.parents : [], commit.stash !== undefined) });
    }

    return {
      root: this.root,
      name: path.basename(this.root),
      head,
      branch,
      ...refs,
      stashes: stashList,
      worktrees: await this.worktreeChanges(parseWorktrees(worktreeOut, this.root), changes.length),
      submodules,
      remotes: remoteOut.split('\n').filter(Boolean),
      rows,
      hasMore,
      changes: changes.length,
      working,
      conflictFiles: plans.map((plan) => ({
        path: plan.path,
        conflicts: plan.conflicts.length,
        resolvable: plan.conflicts.flatMap((conflict) => conflict.resolution ?? []),
      })),
      operation,
      bisect,
      identity: parseIdentity(identityOut),
      filter: filter?.kind === 'path' && names.length > 1 ? { ...filter, renamedFrom: names.slice(1) } : filter,
      scope: shown,
      recentBranches: recentBranches(
        movesOut,
        refs.branches.map((each) => each.name),
        branch,
      ),
      favorites: [],
      defaultPull: 'pullRebaseAutostash',
      repos: [],
      github: null,
      pulls: {},
      agentsWindow: false,
      worktreesRoot: null,
      openBranches: 'checkout',
      showStashes: stashes,
      firstParent: this.firstParent,
      graphColumns: GRAPH_COLUMNS,
      traceSelected: true,
      branchesFollowScope: true,
      resolveWithAI: false,
      home: null,
    };
  }

  /**
   * The arguments of `git log` that say which commits are listed and in which order: all of them but the format and
   * the count. `scope` says whose history, `filter` narrows it and `search` narrows it further.
   */
  private async selection(
    filter: Filter | null,
    head: string | null,
    scope: Scope | null,
    search?: Search,
  ): Promise<{ args: string[]; names: string[] }> {
    const args = ['--date-order'];
    if (this.firstParent) args.push('--first-parent');
    for (const text of [filter, search]) {
      if (text?.kind === 'message') args.push('--fixed-strings', '--regexp-ignore-case', `--grep=${text.query}`);
      if (text?.kind === 'author') args.push('--fixed-strings', '--regexp-ignore-case', `--author=${text.query}`);
      if (text?.kind === 'pickaxe') args.push(`-S${text.query}`);
      if (text?.kind === 'regex') args.push(`-G${text.query}`);
    }
    // With --parents git reports each commit's nearest listed ancestors as its parents, so the filtered graph stays connected.
    if (filter?.kind === 'path') args.push('--parents');
    if (filter?.kind === 'ref') {
      if (filter.ref.startsWith('-')) throw new Error(`"${filter.ref}" is not a valid name.`);
      args.push(filter.ref);
    } else if (scope?.kind === 'current' && head) {
      args.push('HEAD');
      // Git has no upstream to give for a branch that has none, or with nothing checked out.
      const upstream = scope.upstream ? (await this.read(['rev-parse', '--symbolic-full-name', '@{upstream}'], true)).trim() : '';
      if (upstream.startsWith('refs/')) args.push(upstream);
    } else if (scope?.kind === 'refs') {
      // Full names, which cannot be taken for options. One deleted since it was chosen is passed over.
      args.push('--ignore-missing', ...scope.refs.filter((ref) => SCOPE_PREFIXES.some((prefix) => ref.startsWith(prefix))));
    } else {
      // refs/stash is left out on purpose: stashes have their own list and their internal commits clutter the graph.
      const kinds = scopeKinds(scope) ?? REF_KINDS;
      if (kinds.includes('branch')) args.push('--branches');
      if (kinds.includes('remote')) args.push('--remotes');
      if (kinds.includes('tag')) args.push('--tags');
      // What is checked out is always there, whichever kinds of references are left out.
      if (head) args.push('HEAD');
    }
    // A file is followed under the names it had before, or its history would end at the commit that renamed it.
    const names = filter?.kind === 'path' ? await this.pathNames(filter.path) : [];
    if (names.length) args.push('--', ...names.map((name) => `:(literal)${name}`));
    return { args, names };
  }

  /**
   * The commits with the stashes among them, each above the commit it was made on and where its date puts it, when
   * that commit is listed. A stash is a commit whose other parents keep the index and the untracked files it took:
   * they are left out, as the stash stands for them.
   */
  private async withStashes(commits: Commit[], stashes: Stash[]): Promise<Listed[]> {
    const names = new Map(stashes.map((stash) => [stash.hash, stash.ref]));
    const found = parseLog(await this.read(['log', '--no-walk=unsorted', '-z', `--format=${LOG_FORMAT}`, ...names.keys(), '--'], true));
    const listed: Listed[] = [...commits];
    // The newest first: the stashes made on the same commit are listed as they were made.
    for (const commit of found.sort((one, other) => other.date - one.date)) {
      const base = listed.findIndex((other) => other.hash === commit.parents[0]);
      if (base < 0) continue;
      const newer = listed.findIndex((other) => other.date <= commit.date);
      listed.splice(newer < 0 ? base : Math.min(newer, base), 0, { ...commit, parents: [commit.parents[0]], stash: names.get(commit.hash) });
    }
    return listed;
  }

  private async head(): Promise<string | null> {
    return (await this.read(['rev-parse', '--verify', '--quiet', 'HEAD'], true)).trim() || null;
  }

  /**
   * How many commits come before this one in the history that is listed, or -1 when it is not part of it: which is
   * how far the list has to be loaded for the commit to be in it. `hash` is the full one.
   */
  async position(hash: string, filter: Filter | null = null, scope: Scope | null = null): Promise<number> {
    if (!isHash(hash)) return -1;
    const { args } = await this.selection(filter, await this.head(), scope);
    const out = await this.read(['log', '--format=%H', ...args], true);
    // Every line is a hash, and they are all as long.
    const at = out.indexOf(hash);
    return at < 0 ? -1 : at / (hash.length + 1);
  }

  /**
   * The commits of the listed history that a search finds, newest first, and whether there are more than `limit`.
   * Throws when git refuses the search, as it does an invalid regular expression.
   */
  async matches(search: Search, filter: Filter | null, limit: number, scope: Scope | null = null): Promise<{ hashes: string[]; more: boolean }> {
    const { args } = await this.selection(filter, await this.head(), scope, search);
    const hashes = (await this.read(['log', '--format=%H', `--max-count=${limit + 1}`, ...args])).split('\n').filter(Boolean);
    const more = hashes.length > limit;
    if (more) hashes.length = limit;
    return { hashes, more };
  }

  /**
   * The commits of what is checked out, newest first and `limit` at most, whatever the graph is narrowed to; and which
   * of them are not pushed: not in the upstream of the branch, or in no remote branch when it has none.
   */
  async branchLog(limit: number): Promise<BranchLog> {
    const [logOut, upstreamOut, remoteOut] = await Promise.all([
      // Before the first commit there is nothing to list.
      this.read(['log', '-z', `--format=${LOG_FORMAT}`, `--max-count=${limit + 1}`, 'HEAD', '--'], true),
      // Git has no answer without an upstream, or with one whose branch is gone from the remote.
      this.read(['rev-parse', '--symbolic-full-name', '@{upstream}'], true),
      this.read(['remote']),
    ]);
    const commits = parseLog(logOut);
    const hasMore = commits.length > limit;
    if (hasMore) commits.length = limit;
    const upstream = upstreamOut.trim().startsWith('refs/') ? upstreamOut.trim() : null;
    if (!commits.length || (!upstream && !remoteOut.trim())) return { root: this.root, commits, hasMore, unpushed: null, upstream: null };
    // In the order of the list, so that the ones of the commits listed are among the first as many.
    const unpushed = await this.read(['rev-list', `--max-count=${limit}`, 'HEAD', '--not', ...(upstream ? [upstream] : ['--remotes']), '--']);
    return {
      root: this.root,
      commits,
      hasMore,
      unpushed: unpushed.split('\n').filter(Boolean),
      upstream: upstream && upstream.replace(/^refs\/(remotes|heads)\//, ''),
    };
  }

  /** Who last changed a line (1-based). */
  async blameLine(file: string, line: number, options: BlameOptions = {}): Promise<BlameLine | null> {
    const args = ['blame', '--porcelain', '-L', `${line},${line}`, ...blameArgs(options)];
    this.onCommand(formatCommand([...args, '--', file]));
    try {
      const { stdout } = await git(this.root, [...args, '--', file], { readOnly: true, input: options.contents });
      return parseBlameLine(stdout);
    } catch {
      // Untracked files, and lines past the end of the committed file, have no blame.
      return null;
    }
  }

  /** Who last changed each line of a file, the first one at 0, or null for a file that is in no commit. */
  async blame(file: string, options: BlameOptions = {}): Promise<BlameLine[] | null> {
    const args = ['blame', '--incremental', ...blameArgs(options)];
    this.onCommand(formatCommand([...args, '--', file]));
    try {
      const { stdout } = await git(this.root, [...args, '--', file], { readOnly: true, input: options.contents });
      return parseBlame(stdout);
    } catch {
      return null;
    }
  }

  /** Local branches whose commits are all reachable from HEAD. */
  async mergedBranches(): Promise<string[]> {
    const out = await this.read(['branch', '--merged', 'HEAD', '--format=%(refname:short)'], true);
    return out.split('\n').filter(Boolean);
  }

  /** The local and remote branches that have this commit, by their full names. */
  async branchesContaining(hash: string): Promise<string[]> {
    const out = await this.read(['for-each-ref', '--contains', hash, '--format=%(refname)', 'refs/heads', 'refs/remotes'], true);
    return out.split('\n').filter((ref) => ref && !ref.endsWith('/HEAD'));
  }

  async remoteUrl(remote: string): Promise<string> {
    return (await this.read(['remote', 'get-url', remote], true)).trim();
  }

  /** The remotes with the URL each is fetched from. */
  async remotes(): Promise<{ name: string; url: string }[]> {
    const names = (await this.read(['remote'], true)).split('\n').filter(Boolean);
    return Promise.all(names.map(async (name) => ({ name, url: await this.remoteUrl(name) })));
  }

  /** The staged changes as a patch, or the unstaged ones. */
  async diffText(staged: boolean): Promise<string> {
    return this.read(staged ? ['diff', '--cached', '--no-color', '--no-ext-diff'] : ['diff', '--no-color', '--no-ext-diff'], true);
  }

  /** Details of a commit, with the files it changed relative to its first parent. */
  async commitDetail(hash: string): Promise<CommitDetail | null> {
    if (hash === WORKTREE) {
      const files = allChanges(await this.working());
      return {
        hash,
        parents: [],
        author: '',
        email: '',
        date: 0,
        committer: '',
        committerEmail: '',
        commitDate: 0,
        subject: 'Uncommitted changes',
        body: '',
        files,
      };
    }
    if (!isHash(hash)) return null;

    const meta = await this.read(['show', '--no-patch', `--format=${DETAIL_FORMAT}`, hash], true);
    const [full, parentList, author, email, date, committer, committerEmail, commitDate, ...message] = meta.split('\x1f');
    if (!full) return null;
    const parents = parentList ? parentList.split(' ') : [];
    const { subject, body } = subjectAndBody(message.join('\x1f'));

    const rootFiles = (commit: string) => this.read(['diff-tree', '--root', '--no-commit-id', '-r', '--name-status', '-z', commit]);
    const files = parents.length ? await this.read(['diff', '--name-status', '-z', '-M', parents[0], full]) : await rootFiles(full);

    // A stash keeps the untracked files it took in a commit of their own, with no parent, as its third parent.
    let untracked: CommitDetail['untracked'];
    if (parents.length === 3) {
      const third = await this.read(['show', '--no-patch', '--format=%P%x1f%s', parents[2]], true);
      if (third.startsWith('\x1funtracked files on ')) {
        // The commit is there even when there was nothing untracked to take.
        const taken = parseNameStatus(await rootFiles(parents[2]));
        if (taken.length) untracked = { hash: parents[2], files: taken };
      }
    }

    return {
      hash: full,
      parents,
      author,
      email,
      date: Number(date),
      committer,
      committerEmail,
      commitDate: Number(commitDate),
      subject,
      body,
      files: parseNameStatus(files),
      untracked,
    };
  }

  /**
   * What a commit changed in each of its files, relative to its first parent: the lines of the files `commitDetail`
   * lists, in the same order, and no more than `limit` of them. Null when the two do not match.
   */
  async commitPatch(detail: CommitDetail, limit: number): Promise<FilePatch[] | null> {
    if (!isHash(detail.hash)) return null;
    const [parent] = detail.parents;
    // The same two commands that list the files, asked for the lines this time.
    if (parent) return this.comparePatch(detail.files, parent, detail.hash, limit);
    return parsePatch(detail.files, await this.read(['diff-tree', '--root', '--no-commit-id', '-r', '-p', ...PLAIN_DIFF, detail.hash]), limit);
  }

  /** The unstaged diff of a file, or its staged diff, split into hunks. */
  async hunks(file: string, staged: boolean): Promise<FileHunks> {
    const args = ['diff', '--no-color', '--no-ext-diff'];
    if (staged) args.push('--cached');
    // The name alone would be a pattern, which other files may match as well.
    return parseHunks(await this.read([...args, '--', `:(literal)${file}`], true));
  }

  /** Runs a query whose exit code is part of the answer. */
  private async query(args: string[]): Promise<GitResult> {
    this.onCommand(formatCommand(args));
    try {
      return await git(this.root, args, { readOnly: true });
    } catch (error) {
      if (error instanceof GitError) return error.result;
      throw error;
    }
  }

  /**
   * Files that would conflict if `theirs` were merged into HEAD, found without touching the index or the working tree.
   * With `base`, the merge is computed from that commit instead of the common ancestor, which is what a cherry-pick does.
   * Returns null when git cannot tell (it is too old, or the histories are unrelated).
   */
  async conflictsWith(theirs: string, base?: string, ours = 'HEAD'): Promise<string[] | null> {
    const args = ['merge-tree', '--write-tree', '--no-messages', '--name-only', '-z'];
    if (base) args.push(`--merge-base=${base}`);
    const result = await this.query([...args, ours, theirs]);
    if (result.code !== 0 && result.code !== 1) return null;
    // The first record is the resulting tree; conflicted paths follow.
    return [...new Set(result.stdout.split('\0').slice(1).filter(Boolean))];
  }

  /** The commits `ours` has that `theirs` has not, and the other way round. */
  async divergence(ours: string, theirs: string): Promise<{ ahead: number; behind: number }> {
    const [ahead, behind] = (await this.read(['rev-list', '--left-right', '--count', `${ours}...${theirs}`, '--'])).trim().split(/\s+/).map(Number);
    return { ahead, behind };
  }

  /** Commits reachable from `theirs` but not from HEAD, newest first: what a force push over `theirs` would throw away. */
  async commitsOnlyIn(theirs: string, limit: number): Promise<string[]> {
    const out = await this.read(['log', `--max-count=${limit}`, '--format=%h %s', `HEAD..${theirs}`], true);
    return out.split('\n').filter(Boolean);
  }

  async reflog(ref: string, count: number): Promise<ReflogEntry[]> {
    return parseReflog(await this.read(['reflog', `--max-count=${count}`, `--format=${REFLOG_FORMAT}`, ref], true));
  }

  /** Works out how to take back the last thing that moved HEAD, whoever did it. Returns null when there is nothing to undo. */
  async undoInfo(branch: string | null, working: WorkingState): Promise<UndoInfo | null> {
    const head = await this.reflog('HEAD', 2);
    if (!head.length) return null;
    const checkout = /^checkout: moving from (\S+) to /.exec(head[0].subject);
    if (checkout) return { kind: 'checkout', from: checkout[1] };

    // A rebase moves HEAD many times but the branch only once, so the branch's own log gives the right "before".
    const log = branch ? await this.reflog(`refs/heads/${branch}`, 2) : head;
    if (log.length < 2) return null;
    const [{ subject }, { hash: previous }] = log;

    let mode: 'soft' | 'mixed' | 'keep';
    const dirty = working.staged.length > 0 || working.unstaged.some((file) => file.status !== '?');
    if (/^commit(?: \(amend\))?: /.test(subject)) mode = 'soft';
    // After a soft or mixed reset the files already look like `previous`: only HEAD and the index need to go back.
    else if (dirty && (await this.query(['diff', '--quiet', previous])).code === 0) mode = 'mixed';
    else mode = 'keep';
    return { kind: 'move', previous, subject, mode };
  }

  /** Contents of a file at a commit, or an empty string if it does not exist there. */
  async show(ref: string, file: string): Promise<string> {
    return this.read(['show', `${ref}:${file}`], true);
  }
}
