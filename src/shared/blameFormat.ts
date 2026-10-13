/** What the blame of a line says of the commit that changed it last. */
export interface Blamed {
  hash: string;
  author: string;
  /** In seconds. */
  date: number;
  summary: string;
  committed: boolean;
}

/** What stands beside a line unless the settings say otherwise: the day, and a name of up to 20 letters. */
export const DEFAULT_FORMAT = '${date} ${author:20}';
export const NOT_COMMITTED = 'Not committed yet';

const TOKENS = ['date', 'ago', 'author', 'summary', 'hash'] as const;
export type BlameToken = (typeof TOKENS)[number];
/** A piece of a format: text that is written as it is, or something of the commit, with the most letters it may take. */
export type FormatPart = string | { token: BlameToken; width: number | null };

const HASH_LENGTH = 7;
const DAY = 86400;

/** How long ago, in the largest unit that has passed at least once. */
export function ago(seconds: number, now = Date.now() / 1000): string {
  const elapsed = Math.max(0, now - seconds);
  const units: [number, string][] = [
    [31536000, 'year'],
    [2592000, 'month'],
    [DAY, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    const count = Math.floor(elapsed / size);
    if (count >= 1) return `${count} ${name}${count === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

const two = (value: number) => String(value).padStart(2, '0');

/** The day of a commit, as wide whatever the day. */
export function day(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/**
 * Reads a format such as `${date} ${author:20}`: `${name}` stands for something of the commit, and a number after a
 * colon is the most letters it may take. A name that is not known is text like any other, and a format that names
 * nothing is not one: the default is used instead.
 */
export function parseFormat(template: string): FormatPart[] {
  const parts: FormatPart[] = [];
  let last = 0;
  for (const match of template.matchAll(/\$\{(\w+)(?::(\d+))?\}/g)) {
    const token = TOKENS.find((name) => name === match[1]);
    if (!token) continue;
    if (match.index > last) parts.push(template.slice(last, match.index));
    parts.push({ token, width: match[2] ? Math.max(1, Number(match[2])) : null });
    last = match.index + match[0].length;
  }
  if (last < template.length) parts.push(template.slice(last));
  return parts.some((part) => typeof part !== 'string') ? parts : parseFormat(DEFAULT_FORMAT);
}

function value(line: Blamed, token: BlameToken, width: number | null, now: number): string {
  // A hash is cut where it is told to be, and says nothing of what was cut.
  if (token === 'hash') return line.hash.slice(0, width ?? HASH_LENGTH);
  const text = token === 'date' ? day(line.date) : token === 'ago' ? ago(line.date, now) : token === 'author' ? line.author : line.summary;
  return width !== null && text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

export interface LabelOptions {
  format: FormatPart[];
  /** Whether the lines that follow one of the same commit are left with nothing beside them. */
  group: boolean;
  /** In seconds. */
  now: number;
}

/**
 * What stands beside each of the `count` lines of a file. Each thing of a commit is as wide as the widest it is in
 * the file, so that what follows it starts in one column, but for the last one, which has nothing after it. A line
 * git said nothing of has nothing.
 */
export function blameLabels(lines: readonly (Blamed | undefined)[], count: number, { format, group, now }: LabelOptions): string[] {
  const values = new Map<string, string[]>();
  const widths = format.map(() => 0);
  for (const line of lines) {
    if (!line?.committed || values.has(line.hash)) continue;
    const told = format.map((part) => (typeof part === 'string' ? part : value(line, part.token, part.width, now)));
    values.set(line.hash, told);
    told.forEach((text, index) => (widths[index] = Math.max(widths[index], text.length)));
  }
  const texts = new Map<string, string>();
  for (const [hash, told] of values) {
    texts.set(hash, told.map((text, index) => (index < told.length - 1 ? text.padEnd(widths[index]) : text)).join('').trimEnd());
  }

  return Array.from({ length: count }, (_, index) => {
    const line = lines[index];
    if (!line || (group && index > 0 && lines[index - 1]?.hash === line.hash)) return '';
    return line.committed ? (texts.get(line.hash) ?? '') : NOT_COMMITTED;
  });
}

export interface AgeColors {
  /** The color of a line changed now, and of one changed `days` ago or before, as `#rrggbb`. */
  recent: string;
  old: string;
  days: number;
}

export const DEFAULT_AGE: AgeColors = { recent: '#e5534b', old: '#316dca', days: 730 };
/** How many colors there are between the two: lines changed about as long ago have the same one. */
const STEPS = 10;

/** The red, green and blue of `#rgb` or `#rrggbb`, or null for anything else. */
export function parseColor(text: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim())?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)) as [number, number, number];
}

/**
 * The color that says how long ago a line was changed, between the one of now and the one of long ago. Time counts
 * less the further back it is: a week is told from a day more than a year and a week from a year.
 */
export function ageColor(date: number, now: number, colors: AgeColors): string {
  const recent = parseColor(colors.recent) ?? parseColor(DEFAULT_AGE.recent)!;
  const old = parseColor(colors.old) ?? parseColor(DEFAULT_AGE.old)!;
  const days = Math.max(0, (now - date) / DAY);
  const share = Math.min(1, Math.log1p(days) / Math.log1p(Math.max(1, colors.days)));
  const step = Math.round(share * STEPS) / STEPS;
  return `#${recent.map((from, index) => two16(Math.round(from + (old[index] - from) * step))).join('')}`;
}

const two16 = (value: number) => value.toString(16).padStart(2, '0');
