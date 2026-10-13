import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMAT, NOT_COMMITTED, ageColor, ago, blameLabels, day, parseColor, parseFormat, type Blamed } from '../src/shared/blameFormat';

const DAY = 86400;
const NOW = 1_800_000_000;
const commit = (hash: string, author: string, daysAgo: number, summary: string): Blamed => ({
  hash: hash.repeat(40),
  author,
  date: NOW - daysAgo * DAY,
  summary,
  committed: true,
});
const none: Blamed = { hash: '0'.repeat(40), author: '', date: 0, summary: '', committed: false };
const ann = commit('a', 'Ann Lee', 3, 'Fix the parser');
const bob = commit('b', 'Bartholomew Montgomery-Smythe', 400, 'Add the parser, which reads what git says of a file');
const labels = (lines: (Blamed | undefined)[], format: string, group = false, count = lines.length) =>
  blameLabels(lines, count, { format: parseFormat(format), group, now: NOW });

describe('the format of the blame of a file', () => {
  it('names things of a commit, with the most letters they may take, among text that is written as it is', () => {
    expect(parseFormat('${date} ${author:20}')).toEqual([{ token: 'date', width: null }, ' ', { token: 'author', width: 20 }]);
    expect(parseFormat('[${hash:10}] ${summary:0} by ${ago}!')).toEqual([
      '[',
      { token: 'hash', width: 10 },
      '] ',
      { token: 'summary', width: 1 },
      ' by ',
      { token: 'ago', width: null },
      '!',
    ]);
  });

  it('takes a name it does not know as text, and a format that names nothing as no format', () => {
    expect(parseFormat('${who} ${author}')).toEqual(['${who} ', { token: 'author', width: null }]);
    expect(parseFormat('')).toEqual(parseFormat(DEFAULT_FORMAT));
    expect(parseFormat('who knows ${what}')).toEqual(parseFormat(DEFAULT_FORMAT));
  });
});

describe('what stands beside the lines of a file', () => {
  it('says the day and the name by default, the name cut at twenty letters', () => {
    expect(labels([ann, bob], DEFAULT_FORMAT)).toEqual([`${day(ann.date)} Ann Lee`, `${day(bob.date)} Bartholomew Montgom…`]);
  });

  it('starts what follows something in one column, and ends where the last thing ends', () => {
    expect(labels([ann, bob, ann], '${author:12} ${ago} ${hash}')).toEqual([
      'Ann Lee      3 days ago aaaaaaa',
      'Bartholomew… 1 year ago bbbbbbb',
      'Ann Lee      3 days ago aaaaaaa',
    ]);
    expect(labels([ann, bob], '${hash:4}: ${summary:16}')).toEqual(['aaaa: Fix the parser', 'bbbb: Add the parser,…']);
  });

  it('says that a line is in no commit, and nothing of a line git said nothing of', () => {
    expect(labels([ann, none, undefined], DEFAULT_FORMAT, false, 5)).toEqual([`${day(ann.date)} Ann Lee`, NOT_COMMITTED, '', '', '']);
  });

  it('says it once for the lines of a commit that follow each other, when they are grouped', () => {
    expect(labels([ann, ann, bob, bob, bob, ann, none, none], '${author:7}', true)).toEqual(['Ann Lee', '', 'Bartho…', '', '', 'Ann Lee', NOT_COMMITTED, '']);
  });
});

describe('how long ago', () => {
  it('counts in the largest unit that has passed', () => {
    expect(ago(NOW - 20, NOW)).toBe('just now');
    expect(ago(NOW - 60, NOW)).toBe('1 minute ago');
    expect(ago(NOW - 3 * 3600, NOW)).toBe('3 hours ago');
    expect(ago(NOW - 45 * DAY, NOW)).toBe('1 month ago');
    expect(ago(NOW - 800 * DAY, NOW)).toBe('2 years ago');
    expect(ago(NOW + 500, NOW)).toBe('just now');
  });
});

describe('the color of the age of a line', () => {
  const colors = { recent: '#ff0000', old: '#0000ff', days: 100 };

  it('reads colors written with three or six digits, and nothing else', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255]);
    expect(parseColor(' #E5534B ')).toEqual([229, 83, 75]);
    expect(parseColor('red')).toBeNull();
    expect(parseColor('#12345')).toBeNull();
  });

  it('goes from the color of now to the color of long ago, and no further', () => {
    expect(ageColor(NOW, NOW, colors)).toBe('#ff0000');
    expect(ageColor(NOW + DAY, NOW, colors)).toBe('#ff0000');
    expect(ageColor(NOW - 100 * DAY, NOW, colors)).toBe('#0000ff');
    expect(ageColor(NOW - 5000 * DAY, NOW, colors)).toBe('#0000ff');
  });

  it('tells a day from a week more than a year from a year and a week', () => {
    const red = (daysAgo: number) => parseColor(ageColor(NOW - daysAgo * DAY, NOW, { ...colors, days: 730 }))![0];
    expect(red(1) - red(7)).toBeGreaterThan(40);
    expect(red(365)).toBe(red(372));
    expect(red(1)).toBeGreaterThan(red(30));
    expect(red(30)).toBeGreaterThan(red(365));
  });

  it('falls back on its own colors for ones it cannot read', () => {
    expect(ageColor(NOW, NOW, { recent: 'warm', old: 'cold', days: 100 })).toBe('#e5534b');
  });
});
