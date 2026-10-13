import * as fs from 'node:fs';
import * as path from 'node:path';
import { GraphLayout } from '../shared/graph';
import {
  WORKTREE,
  type Bisect,
  type CommitDetail,
  type Comparison,
  type FileHunks,
  type FilePatch,
  type Filter,
  type Operation,
  type RepoState,
  type Row,
  type Scope,
  type Search,
  type WorkingState,
} from '../shared/protocol';
import { SCOPE_PREFIXES, pruneScope } from '../shared/scope';
import { resolveConflicts, type Conflict } from './conflicts';
import { GitError, formatCommand, git, type GitResult } from './exec';
import type { UndoInfo } from './ops';
import {
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
  parseHunks,
  parseIdentity,
  parseReflog,
  type BlameLine,
  type ReflogEntry,
  parseLog,
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

/** Larger files in conflict are left to the user. */
/** How far back in the moves of HEAD the branches checked out last are looked for. */
const RECENT_MOVES = 300;
const CONFLICT_BYTES = 2 * 1024 * 1024;
/** No more files in conflict than this are read to see what can be resolved. */
const CONFLICT_FILES = 200;

/** Read-only view of one repository. Everything that changes the repository goes through `ops.ts` instead. */
export class Repo {
  private gitDir?: string;

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

  async working(): Promise<WorkingState> {
    return parseStatus(await this.read(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
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

  /** With `resolve`, the files with conflicts are read to say which of the conflicts need no choice between the two sides. */
  async state(limit: number, filter: Filter | null = null, scope: Scope | null = null, resolve = false): Promise<RepoState> {
    const [refsOut, headOut, branchOut, stashOut, worktreeOut, remoteOut, identityOut, movesOut, working, operation, bisect] = await Promise.all([
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
        graph: layout.next(WORKTREE, parents),
      });
    }
    for (const commit of commits) {
      rows.push({ ...commit, graph: layout.next(commit.hash, connected ? commit.parents : []) });
    }

    return {
      root: this.root,
      name: path.basename(this.root),
      head,
      branch,
      ...refs,
      stashes: parseStashes(stashOut),
      worktrees: parseWorktrees(worktreeOut, this.root),
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
      repos: [],
      github: null,
      pulls: {},
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
    } else if (scope?.kind === 'refs') {
      // Full names, which cannot be taken for options. One deleted since it was chosen is passed over.
      args.push('--ignore-missing', ...scope.refs.filter((ref) => SCOPE_PREFIXES.some((prefix) => ref.startsWith(prefix))));
    } else {
      // refs/stash is left out on purpose: stashes have their own list and their internal commits clutter the graph.
      args.push('--branches');
      if (scope?.kind !== 'local') args.push('--remotes', '--tags');
      if (head) args.push('HEAD');
    }
    // A file is followed under the names it had before, or its history would end at the commit that renamed it.
    const names = filter?.kind === 'path' ? await this.pathNames(filter.path) : [];
    if (names.length) args.push('--', ...names.map((name) => `:(literal)${name}`));
    return { args, names };
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

  /** Who last changed a line (1-based). `contents` is the text of the file when it has unsaved edits. */
  async blameLine(file: string, line: number, contents?: string): Promise<BlameLine | null> {
    const args = ['blame', '--porcelain', '-L', `${line},${line}`];
    if (contents !== undefined) args.push('--contents', '-');
    this.onCommand(formatCommand([...args, '--', file]));
    try {
      const { stdout } = await git(this.root, [...args, '--', file], { readOnly: true, input: contents });
      return parseBlameLine(stdout);
    } catch {
      // Untracked files, and lines past the end of the committed file, have no blame.
      return null;
    }
  }

  /**
   * Who last changed each line of a file, the first one at 0, or null for a file that is in no commit. `contents` is
   * the text of the file when it has unsaved edits.
   */
  async blame(file: string, contents?: string): Promise<BlameLine[] | null> {
    const args = ['blame', '--incremental'];
    if (contents !== undefined) args.push('--contents', '-');
    this.onCommand(formatCommand([...args, '--', file]));
    try {
      const { stdout } = await git(this.root, [...args, '--', file], { readOnly: true, input: contents });
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
    const [subject, ...body] = message.join('\x1f').trim().split('\n');

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
      body: body.join('\n').trim(),
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
    // As plain as git prints it, whatever the configuration says of colors, of other programs to compare with, of
    // files turned into text first or of submodules, which could be listed with their commits.
    const plain = ['--no-color', '--no-ext-diff', '--no-textconv', '--submodule=short'];
    const [parent] = detail.parents;
    // The same two commands that list the files, asked for the lines this time.
    const out = parent
      ? await this.read(['diff', ...plain, '-M', parent, detail.hash])
      : await this.read(['diff-tree', '--root', '--no-commit-id', '-r', '-p', ...plain, detail.hash]);
    return parsePatch(detail.files, out, limit);
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
  async conflictsWith(theirs: string, base?: string): Promise<string[] | null> {
    const args = ['merge-tree', '--write-tree', '--no-messages', '--name-only', '-z'];
    if (base) args.push(`--merge-base=${base}`);
    const result = await this.query([...args, 'HEAD', theirs]);
    if (result.code !== 0 && result.code !== 1) return null;
    // The first record is the resulting tree; conflicted paths follow.
    return [...new Set(result.stdout.split('\0').slice(1).filter(Boolean))];
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
