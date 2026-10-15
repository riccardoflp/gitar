/*
 * What new worktrees get of what git ignores in the checkout they are made from: folders linked, such as
 * node_modules, and files copied, such as .env. Shared by the page that chooses it and the extension behind it.
 */

/** What a new worktree gets of something git ignores. */
export type SetupChoice = 'link' | 'copy' | 'none';

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
  /** What is proposed for it, and why. */
  suggestion: SetupChoice;
  reason: string;
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

/** What to propose for something git ignores, and why. */
export function suggest(entry: Pick<IgnoredEntry, 'path' | 'folder' | 'bytes'>): { suggestion: SetupChoice; reason: string } {
  const name = base(entry.path);
  if (entry.folder && (LINKED.has(name) || LINKED.has(entry.path))) {
    return { suggestion: 'link', reason: 'Dependencies: the same in every worktree, as long as the branches agree on them' };
  }
  if (entry.folder && BUILT.has(name)) return { suggestion: 'none', reason: 'Build output: each worktree makes its own' };
  if (entry.folder && /^\.?worktrees$/.test(name)) return { suggestion: 'none', reason: 'Other worktrees, which are not to be inside one' };
  if (NOISE.test(entry.path)) return { suggestion: 'none', reason: 'Logs and files the system leaves' };
  if (!entry.folder && LOCAL.test(entry.path)) return { suggestion: 'copy', reason: 'Settings or secrets of this machine' };
  if (entry.folder && EDITOR.test(entry.path)) return { suggestion: 'copy', reason: 'Settings of the editor' };
  return { suggestion: 'none', reason: 'Not one Gitardo knows' };
}

/**
 * The pattern that takes `entry`: a folder of dependencies by its name, wherever it is, as each package of a
 * repository can have one; anything else by its path from the top of the checkout.
 */
export function patternFor(entry: Pick<IgnoredEntry, 'path' | 'folder'>): string {
  if (entry.folder && LINKED.has(base(entry.path))) return `${base(entry.path)}/`;
  return `/${entry.path}${entry.folder ? '/' : ''}`;
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

/** The patterns with what `entry` gets set to `choice`, by its own pattern. Other patterns that take it are left. */
export function choose(patterns: SetupPatterns, entry: Pick<IgnoredEntry, 'path' | 'folder'>, choice: SetupChoice): SetupPatterns {
  const pattern = patternFor(entry);
  const link = patterns.link.filter((each) => each !== pattern);
  const copy = patterns.copy.filter((each) => each !== pattern);
  if (choice === 'link') link.push(pattern);
  if (choice === 'copy') copy.push(pattern);
  return { link, copy };
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
