import type {
  Bisect,
  Branch,
  Commit,
  FileChange,
  FileHunks,
  FilePatch,
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

export const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

/** Parses `git worktree list --porcelain`. */
export function parseWorktrees(out: string, root: string): Worktree[] {
  const worktrees: Worktree[] = [];
  for (const [index, block] of out.split(/\r?\n\r?\n/).entries()) {
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
      // Git lists the main worktree first. In a bare repository that is the repository itself, skipped above.
      main: index === 0,
      prunable: fields.has('prunable'),
      changes: null,
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

/**
 * Cuts the diff of several files, as printed by `git diff <from> <to>`, into what each file changed. `files` are the
 * ones `--name-status` lists for the same two commits, which git prints in the same order. Hunks are left out, as null,
 * from the file that would take the lines sent past `limit`, and counted all the same.
 * Null when the diff is not of those files.
 */
export function parsePatch(files: FileChange[], out: string, limit: number): FilePatch[] | null {
  // No line of a hunk starts like this: they all start with a space, a sign or a backslash.
  const parts = out.split(/^(?=diff --git )/m).filter((part) => part.startsWith('diff --git '));
  let next = 0;
  let sent = 0;
  const patches: FilePatch[] = [];
  for (const file of files) {
    // A file that became a link, or the other way round, is printed as one deleted and one added.
    const own = parts.slice(next, (next += file.status === 'T' ? 2 : 1)).map(parseHunks);
    if (!own.length) return null;
    const hunks = own.flatMap((part) => part.hunks);
    let added = 0;
    let removed = 0;
    let lines = hunks.length;
    for (const hunk of hunks) {
      lines += hunk.lines.length;
      for (const line of hunk.lines) {
        if (line[0] === '+') added++;
        else if (line[0] === '-') removed++;
      }
    }
    const fits = sent + lines <= limit;
    if (fits) sent += lines;
    patches.push({ file, added, removed, binary: own.some((part) => part.binary), hunks: fits ? hunks : null });
  }
  return next === parts.length ? patches : null;
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

/** How many branches are listed as checked out recently. */
export const RECENT_BRANCHES = 5;

/**
 * The local branches that were checked out last, the latest first, from the subjects of the reflog of HEAD, which
 * come with the latest first too. The one checked out now is left out: it is where the others are looked for from.
 */
export function recentBranches(subjects: string, branches: string[], current: string | null, limit = RECENT_BRANCHES): string[] {
  const known = new Set(branches);
  const recent: string[] = [];
  for (const subject of subjects.split('\n')) {
    const moved = /^checkout: moving from (\S+) to (\S+)$/.exec(subject);
    if (!moved) continue;
    // Arrived at before it was left for the other: the one moved to is the more recent of the two.
    for (const name of [moved[2], moved[1]]) {
      if (name !== current && known.has(name) && !recent.includes(name)) recent.push(name);
    }
    if (recent.length >= limit) break;
  }
  return recent.slice(0, limit);
}

export interface BlameLine {
  hash: string;
  author: string;
  date: number;
  summary: string;
  /** False for lines that are not in any commit yet. */
  committed: boolean;
  /** The commit the file was in before this one changed it, and the name it had there. A commit that added the file has none. */
  previous?: { hash: string; file: string };
}

/**
 * A path as git writes it where it ends a line: as it is, or between quotes with what is not plain ASCII told byte
 * by byte, when `core.quotePath` is left as it comes.
 */
export function unquotePath(text: string): string {
  if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) return text;
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  const bytes: number[] = [];
  const inner = text.slice(1, -1);
  for (let at = 0; at < inner.length; at++) {
    if (inner[at] !== '\\') {
      bytes.push(...Buffer.from(inner[at], 'utf8'));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(inner.slice(at + 1))?.[0];
    if (octal) {
      bytes.push(parseInt(octal, 8));
      at += 3;
    } else {
      const next = inner[++at];
      bytes.push(escapes[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
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

/**
 * Parses `git blame --incremental` for a whole file: who last changed each of its lines, the first one at 0. The
 * lines of one commit share one object. A commit is described the first time it is named, and only named after that.
 */
export function parseBlame(out: string): BlameLine[] {
  const commits = new Map<string, BlameLine>();
  const lines: BlameLine[] = [];
  let current: BlameLine | undefined;
  for (const line of out.split('\n')) {
    // The commit, the line its lines had in it, the line they have now, and how many they are.
    const group = /^([0-9a-f]{40,64}) \d+ (\d+) (\d+)$/.exec(line);
    if (group) {
      const hash = group[1];
      current = commits.get(hash);
      if (!current) {
        current = { hash, author: '', date: 0, summary: '', committed: !/^0+$/.test(hash) };
        commits.set(hash, current);
      }
      const first = Number(group[2]) - 1;
      for (let index = first; index < first + Number(group[3]); index++) lines[index] = current;
    } else if (current) {
      if (line.startsWith('author ')) current.author = line.slice(7);
      else if (line.startsWith('author-time ')) current.date = Number(line.slice(12));
      else if (line.startsWith('summary ')) current.summary = line.slice(8);
      else if (line.startsWith('previous ')) {
        const [, hash, file] = /^previous ([0-9a-f]{40,64}) (.+)$/.exec(line) ?? [];
        if (hash) current.previous = { hash, file: unquotePath(file) };
      }
    }
  }
  return lines;
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

/** A submodule as `.gitmodules` describes it. */
export interface GitmodulesEntry {
  name: string;
  path: string;
  url: string;
  branch: string | null;
}

/**
 * Parses `git config -z --file .gitmodules --get-regexp ^submodule\.`: a key, a line break and a value in each record.
 * The name of a submodule can have dots in it, the name of the key after it cannot. One without a path is no submodule.
 */
export function parseGitmodules(out: string): GitmodulesEntry[] {
  const byName = new Map<string, Partial<GitmodulesEntry>>();
  for (const record of out.split('\0')) {
    const newline = record.indexOf('\n');
    const key = newline === -1 ? record : record.slice(0, newline);
    const match = /^submodule\.(.+)\.(path|url|branch)$/.exec(key);
    if (!match) continue;
    const [, name, field] = match;
    const entry = byName.get(name) ?? { name };
    entry[field as 'path' | 'url' | 'branch'] = newline === -1 ? '' : record.slice(newline + 1);
    byName.set(name, entry);
  }
  return [...byName.values()]
    .filter((entry) => entry.path)
    .map((entry) => ({
      name: entry.name!,
      path: entry.path!.replace(/\\/g, '/').replace(/\/+$/, ''),
      url: entry.url ?? '',
      branch: entry.branch || null,
    }));
}

/**
 * The commits recorded for submodules, by their paths: from `git ls-tree -z` (`<mode> <type> <object>\t<path>`) or
 * `git ls-files -s -z` (`<mode> <object> <stage>\t<path>`). Only the entries of submodules, mode 160000, are kept.
 */
export function parseGitlinks(out: string, from: 'tree' | 'index'): Map<string, string> {
  const links = new Map<string, string>();
  for (const record of out.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const fields = record.slice(0, tab).split(' ');
    if (fields[0] !== '160000') continue;
    links.set(record.slice(tab + 1), from === 'tree' ? fields[2] : fields[1]);
  }
  return links;
}

/**
 * Parses `git status --porcelain=v2 --branch -z`: the commit checked out (null before the first one), the branch
 * (null when detached), and how many files are not committed.
 */
export function parseBranchStatus(out: string): { head: string | null; branch: string | null; changes: number } {
  let head: string | null = null;
  let branch: string | null = null;
  let changes = 0;
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice('# branch.oid '.length);
      head = oid === '(initial)' ? null : oid;
    } else if (record.startsWith('# branch.head ')) {
      const name = record.slice('# branch.head '.length);
      branch = name === '(detached)' ? null : name;
    } else if (!record.startsWith('#')) {
      changes++;
      // A rename or a copy has the path it came from as a record of its own.
      if (record.startsWith('2 ')) i++;
    }
  }
  return { head, branch, changes };
}
