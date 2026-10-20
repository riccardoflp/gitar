/*
 * What new worktrees get of what git ignores in the checkout they are made from: folders linked, such as
 * node_modules, and files copied, such as .env. Shared by the page that chooses it and the extension behind it.
 */

/** What a new worktree gets of something git ignores. */
export type SetupChoice = 'link' | 'copy' | 'none';

/** What something git ignores is, which says what is proposed for it. */
export type SetupKind = 'unknown' | 'dependencies' | 'local' | 'editor' | 'build' | 'worktrees' | 'noise';

/** The kinds in the order the page shows them: what needs a choice first, what is left out last. */
export const KINDS: SetupKind[] = ['unknown', 'dependencies', 'local', 'editor', 'build', 'worktrees', 'noise'];

/** Something git ignores in the checkout, as git lists it: a folder all of whose content it ignores, or a file. */
export interface IgnoredEntry {
  /** Relative to the checkout, with forward slashes and no slash at the end. */
  path: string;
  folder: boolean;
  /** A link already, as in a worktree made with links: it is not looked into. */
  link: boolean;
  files: number;
  bytes: number;
  /** Counted in part: it has more files than are counted. */
  more: boolean;
  /** What it is, and what is proposed for it. */
  kind: SetupKind;
  suggestion: SetupChoice;
}

/** The patterns of the two settings, in `.gitignore` syntax. */
export interface SetupPatterns {
  link: string[];
  copy: string[];
}

/** What the patterns take from the checkout: the folders linked and the paths copied, with what each pattern takes alone. */
export interface SetupPreview extends SetupPatterns {
  /** For each pattern, how many folders it links, or paths it copies, by itself. */
  counts: { link: Record<string, number>; copy: Record<string, number> };
}

/** Where a value of the settings comes from. */
export type SetupSource = 'workspace' | 'user' | 'vscode' | 'none';

/** Where the page saves: the settings of the workspace folder that has the repository, or of the user. */
export type SetupTarget = 'workspace' | 'user';

/** The values set in one place, each missing where it is not set there. */
export interface SetupLayer {
  link?: string[];
  copy?: string[];
}

/** Everything the page shows. */
export interface WorktreeSetupInfo {
  /** The checkout new worktrees are set up from. */
  root: string;
  entries: IgnoredEntry[];
  user: SetupLayer;
  /** Null when the repository is in no folder of the workspace, where only the settings of the user apply. */
  workspace: (SetupLayer & { name: string; file: string }) | null;
  /** VS Code's own settings, which Gitardo follows where its own are not set. */
  vscode: SetupPatterns;
  /** What applies now, and where each of the two comes from. */
  effective: SetupPatterns & { linkFrom: SetupSource; copyFrom: SetupSource };
  /** The other worktrees of the repository, which can be given what applies now. */
  worktrees: number;
}

/** Dependencies and environments: heavy to make again, and the same in every worktree as long as the branches agree. */
const LINKED = new Set([
  'node_modules',
  'bower_components',
  'jspm_packages',
  '.venv',
  'venv',
  '.pnpm-store',
  'Pods',
  'Carthage',
  'vendor',
  '.yarn/cache',
  '.gradle',
  '.m2',
]);

/** What a build makes, which each worktree makes for its own branch. */
const BUILT = new Set([
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.angular',
  '.turbo',
  '.parcel-cache',
  '.cache',
  'coverage',
  '.nyc_output',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.dart_tool',
  'DerivedData',
  'tmp',
  'temp',
]);

/** Logs, swap files and what the system leaves behind. */
const NOISE = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|\.(log|swp|swo|tmp|bak)$|~$/i;

/** Settings and secrets of this machine, which git is told to ignore so that they stay out of commits. */
const LOCAL = /(^|\/)(\.env(\.[^/]+)?|\.envrc|\.npmrc|\.yarnrc(\.yml)?|\.pypirc|\.tool-versions|local\.properties|appsettings\.(Development|Local)\.json|[^/]+\.local(\.[^/]+)?)$/i;

/** Folders of the editor's settings for this machine. */
const EDITOR = /(^|\/)(\.vscode|\.idea|\.fleet|\.zed)$/;

/** More than this to copy is better linked, or made again. */
export const LARGE_COPY = 100 * 1024 * 1024;

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** What something git ignores is, and what to propose for it. */
export function suggest(entry: Pick<IgnoredEntry, 'path' | 'folder' | 'bytes'>): { kind: SetupKind; suggestion: SetupChoice } {
  const name = base(entry.path);
  if (entry.folder && (LINKED.has(name) || LINKED.has(entry.path))) return { kind: 'dependencies', suggestion: 'link' };
  if (entry.folder && BUILT.has(name)) return { kind: 'build', suggestion: 'none' };
  if (entry.folder && /^\.?worktrees$/.test(name)) return { kind: 'worktrees', suggestion: 'none' };
  if (NOISE.test(entry.path)) return { kind: 'noise', suggestion: 'none' };
  if (!entry.folder && LOCAL.test(entry.path)) return { kind: 'local', suggestion: 'copy' };
  if (entry.folder && EDITOR.test(entry.path)) return { kind: 'editor', suggestion: 'copy' };
  return { kind: 'unknown', suggestion: 'none' };
}

/** The pattern that takes everything of the name of `entry`, wherever it is: `node_modules/`, `.env.local`. */
export function namePattern(entry: Pick<IgnoredEntry, 'path' | 'folder'>): string {
  return `${base(entry.path)}${entry.folder ? '/' : ''}`;
}

/** The pattern that takes `entry` alone, by its path from the top of the checkout. */
export function pathPattern(entry: Pick<IgnoredEntry, 'path' | 'folder'>): string {
  return `/${entry.path}${entry.folder ? '/' : ''}`;
}

/**
 * The pattern that takes `entry`: a folder of dependencies by its name, wherever it is, as each package of a
 * repository can have one; anything else by its path from the top of the checkout.
 */
export function patternFor(entry: Pick<IgnoredEntry, 'path' | 'folder'>): string {
  return entry.folder && LINKED.has(base(entry.path)) ? namePattern(entry) : pathPattern(entry);
}

/** The patterns that name `entry` itself: by its path, and by its name. */
const ownPatterns = (entry: Pick<IgnoredEntry, 'path' | 'folder'>) => [pathPattern(entry), namePattern(entry)];

/** What git ignores of one kind and one name: in several places, or in one. */
export interface SetupGroup {
  kind: SetupKind;
  name: string;
  folder: boolean;
  entries: IgnoredEntry[];
}

/** What git ignores, by kind in the order of `KINDS`, with what has the same name in several places together. */
export function groupEntries(entries: IgnoredEntry[]): { kind: SetupKind; groups: SetupGroup[] }[] {
  const byKind = new Map<SetupKind, Map<string, SetupGroup>>();
  for (const entry of entries) {
    let groups = byKind.get(entry.kind);
    if (!groups) byKind.set(entry.kind, (groups = new Map()));
    const key = namePattern(entry);
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { kind: entry.kind, name: base(entry.path), folder: entry.folder, entries: [entry] });
  }
  return KINDS.filter((kind) => byKind.has(kind)).map((kind) => ({ kind, groups: [...byKind.get(kind)!.values()] }));
}

/** What `entry` gets under the patterns, and whether only some of what is inside it gets that. */
export function statusOf(entry: Pick<IgnoredEntry, 'path'>, preview: SetupPatterns): { choice: SetupChoice; partly: boolean } {
  const covers = (taken: string[]) => taken.some((path) => entry.path === path || entry.path.startsWith(`${path}/`));
  const inside = (taken: string[]) => taken.some((path) => path.startsWith(`${entry.path}/`));
  if (covers(preview.link)) return { choice: 'link', partly: false };
  if (covers(preview.copy)) return { choice: 'copy', partly: false };
  if (inside(preview.link)) return { choice: 'link', partly: true };
  if (inside(preview.copy)) return { choice: 'copy', partly: true };
  return { choice: 'none', partly: false };
}

type Checked = { patterns: SetupPatterns; preview: SetupPatterns } | null;

/**
 * What `entry` gets under `patterns`, without asking git: by a pattern of its own path or name where they have one, as
 * chosen on the page; otherwise as git said when `checked` was looked at. A pattern of its own taken out since leaves it
 * nothing. Null when nothing was looked at yet.
 */
export function statusNow(entry: Pick<IgnoredEntry, 'path' | 'folder'>, patterns: SetupPatterns, checked: Checked): { choice: SetupChoice; partly: boolean } | null {
  const own = ownPatterns(entry);
  if (patterns.link.some((pattern) => own.includes(pattern))) return { choice: 'link', partly: false };
  if (patterns.copy.some((pattern) => own.includes(pattern))) return { choice: 'copy', partly: false };
  if (!checked) return null;
  if ([...checked.patterns.link, ...checked.patterns.copy].some((pattern) => own.includes(pattern))) return { choice: 'none', partly: false };
  return statusOf(entry, checked.preview);
}

/** What all of `entries` get under `patterns`: what they all get, when it is the same, or `mixed`. */
export function statusOfAll(
  entries: Pick<IgnoredEntry, 'path' | 'folder'>[],
  patterns: SetupPatterns,
  checked: Checked,
): { choice: SetupChoice | 'mixed'; partly: boolean } | null {
  const statuses = entries.map((entry) => statusNow(entry, patterns, checked));
  if (statuses.some((status) => status === null)) return null;
  const first = statuses[0]!;
  return statuses.every((status) => status!.choice === first.choice && status!.partly === first.partly) ? first : { choice: 'mixed', partly: false };
}

/** The patterns without those of `own`, and with `pattern` among those of `choice`. */
function put(patterns: SetupPatterns, own: string[], pattern: string, choice: SetupChoice): SetupPatterns {
  const link = patterns.link.filter((each) => !own.includes(each));
  const copy = patterns.copy.filter((each) => !own.includes(each));
  if (choice === 'link') link.push(pattern);
  if (choice === 'copy') copy.push(pattern);
  return { link, copy };
}

/**
 * The patterns with what `entry` gets set to `choice`, by its own pattern; the others of its path or name go. Patterns
 * that take more than it are left.
 */
export function choose(patterns: SetupPatterns, entry: Pick<IgnoredEntry, 'path' | 'folder'>, choice: SetupChoice): SetupPatterns {
  return put(patterns, ownPatterns(entry), patternFor(entry), choice);
}

/**
 * The patterns with what `entries`, all of one name, get set to `choice`, by the pattern of that name: it takes them
 * wherever they are, and what of that name comes later. The patterns of their paths go.
 */
export function chooseAll(patterns: SetupPatterns, entries: Pick<IgnoredEntry, 'path' | 'folder'>[], choice: SetupChoice): SetupPatterns {
  return put(patterns, entries.flatMap(ownPatterns), namePattern(entries[0]), choice);
}

/**
 * The patterns with `entry`, one of `entries` of its name, set to `choice` by the pattern of its path. When the pattern
 * of their name took them all, it gives way to one for each of the others, so that they keep what they got.
 */
export function chooseOne(
  patterns: SetupPatterns,
  entries: Pick<IgnoredEntry, 'path' | 'folder'>[],
  entry: Pick<IgnoredEntry, 'path' | 'folder'>,
  choice: SetupChoice,
): SetupPatterns {
  const name = namePattern(entry);
  const held = patterns.link.includes(name) ? 'link' : patterns.copy.includes(name) ? 'copy' : null;
  // What their name gives them: the pattern of its path is not needed.
  if (held === choice) return put(patterns, [pathPattern(entry)], '', 'none');
  let next = patterns;
  if (held) for (const other of entries) if (other !== entry) next = put(next, ownPatterns(other), pathPattern(other), held);
  return put(next, ownPatterns(entry), pathPattern(entry), choice);
}

/** The patterns that name the file or folder at `path` by its path, with a slash at the end and without. */
const pathPatterns = (path: string) => [`/${path}`, `/${path}/`];

/**
 * The patterns with what `entry` gets set to `choice` by the pattern of its path, as the context menu of the Explorer
 * sets it: the patterns of its path go, and those of its name, which take others as well, are left.
 */
export function chooseByPath(patterns: SetupPatterns, entry: Pick<IgnoredEntry, 'path' | 'folder'>, choice: SetupChoice): SetupPatterns {
  return put(patterns, pathPatterns(entry.path), pathPattern(entry), choice);
}

/** The paths that `patterns` name one by one, from the top of the checkout, as `/.env` or `/packages/api/node_modules/`. */
export function namedPaths(patterns: string[]): string[] {
  return patterns.filter((pattern) => /^\/[^*?[\\!]+$/.test(pattern)).map((pattern) => pattern.slice(1).replace(/\/$/, ''));
}

/** The patterns of a setting as they are kept: trimmed, without empty ones, line breaks or the same one twice. */
export function cleanPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const kept = value.filter((pattern): pattern is string => typeof pattern === 'string').map((pattern) => pattern.trim());
  return [...new Set(kept.filter((pattern) => pattern && !/[\r\n]/.test(pattern)))];
}

/** A size as people read it. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
