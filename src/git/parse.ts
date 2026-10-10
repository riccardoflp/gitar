import type {
  Bisect,
  Branch,
  Commit,
  FileChange,
  FileHunks,
  Hunk,
  Identity,
  NamedRef,
  Stash,
  WorkingState,
  Worktree,
} from '../shared/protocol';

const FIELD = '\x1f';

export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%s'].join('%x1f');
export const DETAIL_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%B'].join('%x1f');
export const STASH_FORMAT = ['%H', '%gd', '%gs', '%at'].join('%x1f');
export const REF_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(*objectname)',
  // In full, like `refname`: git lengthens the short form of a name that something else has too.
  '%(upstream)',
  '%(upstream:remotename)',
  '%(upstream:remoteref)',
  '%(upstream:track)',
  '%(HEAD)',
].join('%1f');

const records = (out: string) => out.split('\0').filter(Boolean);

/** Parses `git log -z --format=LOG_FORMAT`. */
export function parseLog(out: string): Commit[] {
  return records(out).map((record) => {
    const [hash, parents, author, email, date, subject = ''] = record.split(FIELD);
    return { hash, parents: parents ? parents.split(' ') : [], author, email, date: Number(date), subject };
  });
}

export interface Refs {
  branches: Branch[];
  remoteBranches: NamedRef[];
  tags: NamedRef[];
}

/** Parses `git for-each-ref --format=REF_FORMAT`. */
export function parseRefs(out: string): Refs {
  const refs: Refs = { branches: [], remoteBranches: [], tags: [] };
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [refname, hash, peeled, upstream, remote, remoteRef, track, head] = line.split(FIELD);
    if (refname.startsWith('refs/heads/')) {
      const branch: Branch = { name: refname.slice('refs/heads/'.length), hash, current: head === '*' };
      if (upstream) {
        branch.upstream = {
          name: upstream.replace(/^refs\/(remotes|heads)\//, ''),
          remote,
          branch: remoteRef.replace(/^refs\/heads\//, ''),
          ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
          behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
          gone: track.includes('gone'),
        };
      }
      refs.branches.push(branch);
    } else if (refname.startsWith('refs/remotes/')) {
      const name = refname.slice('refs/remotes/'.length);
      if (!name.endsWith('/HEAD')) refs.remoteBranches.push({ name, hash });
    } else if (refname.startsWith('refs/tags/')) {
      // Annotated tags point at a tag object; the commit is the peeled hash.
      refs.tags.push({ name: refname.slice('refs/tags/'.length), hash: peeled || hash });
    }
  }
  return refs;
}

/** Parses `git stash list -z --format=STASH_FORMAT`. */
export function parseStashes(out: string): Stash[] {
  return records(out).map((record) => {
    const [hash, ref, message, date] = record.split(FIELD);
    return { hash, ref, message, date: Number(date) };
  });
}

const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

/** Parses `git worktree list --porcelain`. */
export function parseWorktrees(out: string, root: string): Worktree[] {
  const worktrees: Worktree[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const space = line.indexOf(' ');
      fields.set(space === -1 ? line : line.slice(0, space), space === -1 ? '' : line.slice(space + 1));
    }
    const path = fields.get('worktree');
    if (!path || fields.has('bare')) continue;
    worktrees.push({
      path,
      hash: fields.get('HEAD') ?? '',
      branch: fields.get('branch')?.replace(/^refs\/heads\//, '') ?? null,
      current: samePath(path, root),
      prunable: fields.has('prunable'),
    });
  }
  return worktrees;
}

/** Parses the diff of a single file, as printed by `git diff -- <path>`. */
export function parseHunks(out: string): FileHunks {
  const lines = out.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const first = lines.findIndex((line) => line.startsWith('@@'));
  const header = first === -1 ? lines : lines.slice(0, first);
  const result: FileHunks = {
    prelude: header.length ? `${header.join('\n')}\n` : '',
    hunks: [],
    binary: header.some((line) => line.startsWith('Binary files') || line.startsWith('GIT binary patch')),
  };
  if (first === -1) return result;
  for (const line of lines.slice(first)) {
    if (line.startsWith('@@')) result.hunks.push({ header: line, lines: [] });
    else result.hunks[result.hunks.length - 1].lines.push(line);
  }
  return result;
}

/** The patch that applies only `hunk`. */
export function hunkPatch(file: FileHunks, hunk: Hunk): string {
  return `${file.prelude}${hunk.header}\n${hunk.lines.join('\n')}\n`;
}

/**
 * The patch that applies only the picked changed lines of `hunk`, given as indexes into its lines.
 * `reverse` says the patch will be applied backwards, as unstaging and discarding do.
 */
export function linesPatch(file: FileHunks, hunk: Hunk, picked: ReadonlySet<number>, reverse: boolean): string {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(hunk.header);
  if (!match) throw new Error(`Cannot read the hunk header "${hunk.header}".`);
  // A change that is left out must look as if it were not there. In the file the patch is applied to,
  // a line that is left out is either missing, so it is dropped, or present, so it becomes context.
  const missing = reverse ? '-' : '+';
  const lines: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  let dropped = false;
  hunk.lines.forEach((original, index) => {
    let line = original;
    if (line.startsWith('\\')) {
      // "\ No newline at end of file" belongs to the line before it.
      if (!dropped) lines.push(line);
      return;
    }
    dropped = false;
    if ((line[0] === '+' || line[0] === '-') && !picked.has(index)) {
      if (line[0] === missing) {
        dropped = true;
        return;
      }
      line = ` ${line.slice(1)}`;
    }
    if (line[0] !== '+') oldCount++;
    if (line[0] !== '-') newCount++;
    lines.push(line);
  });
  return `${file.prelude}@@ -${match[1]},${oldCount} +${match[2]},${newCount} @@${match[3]}\n${lines.join('\n')}\n`;
}

/** Parses `git config --get-regexp` for `user.name` and `user.email`. As for git, the last value of a setting wins. */
export function parseIdentity(out: string): Identity {
  const identity: Identity = { name: '', email: '' };
  for (const line of out.split('\n')) {
    const match = /^user\.(name|email) (.*)$/.exec(line);
    if (match) identity[match[1] as keyof Identity] = match[2];
  }
  return identity;
}

/** Parses `git for-each-ref --format='%(refname) %(objectname)' refs/bisect`: the commits marked so far. */
export function parseBisectRefs(out: string): Pick<Bisect, 'good' | 'bad' | 'skipped'> {
  const marks: Pick<Bisect, 'good' | 'bad' | 'skipped'> = { good: [], bad: null, skipped: [] };
  for (const line of out.split('\n')) {
    const [refname, hash] = line.split(' ');
    if (refname === 'refs/bisect/bad') marks.bad = hash;
    else if (refname?.startsWith('refs/bisect/good-')) marks.good.push(hash);
    else if (refname?.startsWith('refs/bisect/skip-')) marks.skipped.push(hash);
  }
  return marks;
}

export interface ReflogEntry {
  hash: string;
  subject: string;
  /** Such as `HEAD@{3}`. */
  selector: string;
  date: number;
}

export const REFLOG_FORMAT = ['%H', '%gs', '%gd', '%ct'].join('%x1f');

/** Parses `git reflog --format=REFLOG_FORMAT`. */
export function parseReflog(out: string): ReflogEntry[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, subject = '', selector = '', date = '0'] = line.split(FIELD);
      return { hash, subject, selector, date: Number(date) };
    });
}

export interface BlameLine {
  hash: string;
  author: string;
  date: number;
  summary: string;
  /** False for lines that are not in any commit yet. */
  committed: boolean;
}

/** Parses `git blame --porcelain` for a single line. */
export function parseBlameLine(out: string): BlameLine | null {
  const lines = out.split('\n');
  const hash = /^[0-9a-f]{40,64}/.exec(lines[0])?.[0];
  if (!hash) return null;
  const field = (name: string) => lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1) ?? '';
  return {
    hash,
    author: field('author'),
    date: Number(field('author-time')),
    summary: field('summary'),
    committed: !/^0+$/.test(hash),
  };
}

/** Parses the `-z --name-status` output of `git diff` and `git diff-tree`. */
export function parseNameStatus(out: string): FileChange[] {
  const tokens = out.split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (!status) continue;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const oldPath = tokens[i++];
      files.push({ status: code, path: tokens[i++], oldPath });
    } else {
      files.push({ status: code, path: tokens[i++] });
    }
  }
  return files;
}

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** Parses `git status --porcelain=v1 -z`. A file changed in both the index and the working tree appears in both lists. */
export function parseStatus(out: string): WorkingState {
  const tokens = out.split('\0');
  const working: WorkingState = { staged: [], unstaged: [], conflicts: [] };
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (entry.length < 4) continue;
    const [index, worktree] = entry;
    const path = entry.slice(3);
    // A rename lists the new path first, then the old one as a separate token.
    const oldPath = index === 'R' || index === 'C' ? tokens[++i] : undefined;

    if (index === '?') working.unstaged.push({ status: '?', path });
    else if (CONFLICT_CODES.has(index + worktree)) working.conflicts.push({ status: 'U', path });
    else {
      if (index !== ' ') working.staged.push(oldPath ? { status: index, path, oldPath } : { status: index, path });
      if (worktree !== ' ') working.unstaged.push({ status: worktree, path });
    }
  }
  return working;
}

/** Every changed file once, for views that do not care about the index. */
export function allChanges(working: WorkingState): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const file of [...working.conflicts, ...working.staged, ...working.unstaged]) {
    if (!byPath.has(file.path)) byPath.set(file.path, file);
  }
  return [...byPath.values()];
}
