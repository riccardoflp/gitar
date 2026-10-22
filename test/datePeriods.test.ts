import { describe, expect, it } from 'vitest';
import { datePeriods } from '../src/webview/util';

// Thursday 22 October 2026, at noon.
const now = new Date(2026, 9, 22, 12).getTime();
const at = (month: number, day: number, hour = 10) => ({ date: new Date(2026, month - 1, day, hour).getTime() / 1000 });

describe('the separators between the commits of the graph', () => {
  it('names each time further back where its first commit is, and not the first time there is', () => {
    const rows = [at(10, 22), at(10, 22, 8), at(10, 21), at(10, 20), at(10, 19), at(10, 15), at(10, 12), at(10, 11), at(10, 2), at(9, 30), at(8, 1)];
    const starts = datePeriods(rows, now);
    expect([...starts.keys()]).toEqual([2, 3, 5, 7, 9, 10]);
    expect(starts.get(2)).toBe('Yesterday');
    expect(starts.get(3)).toBe('This week');
    expect(starts.get(5)).toBe('Last week');
    // Before last week, each month: October has days left before it.
    expect(starts.get(7)).toBe(new Date(2026, 9, 11).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
    expect(starts.get(9)).toBe(new Date(2026, 8, 30).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
  });

  it('starts nothing for a commit newer than one above it, nor for the uncommitted changes', () => {
    const starts = datePeriods([{ date: 0 }, at(10, 21), at(10, 22), at(10, 21), at(10, 20)], now);
    expect([...starts.entries()]).toEqual([[4, 'This week']]);
  });
});
