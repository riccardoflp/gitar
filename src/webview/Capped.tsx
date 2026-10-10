import { useState, type ReactNode } from 'react';

/** How many files of a commit, of a comparison or of the working tree are listed before asking. */
export const FILES_LIMIT = 300;

/**
 * The first `limit` items of a list that may be very long, and the button that asks for the rest, or null when
 * everything is listed. A commit or a working tree can touch thousands of files, and a row for each makes the view slow.
 * `scope` says what the list is of: asking for everything holds for that one, not for the next one shown in its place.
 */
export function useCapped<T>(items: T[], limit: number, what: string, scope = ''): [T[], ReactNode] {
  const [fullFor, setFullFor] = useState<string | null>(null);
  if (fullFor === scope || items.length <= limit) return [items, null];
  return [
    items.slice(0, limit),
    <button className="link show-all" onClick={() => setFullFor(scope)}>
      Show all {items.length} {what}…
    </button>,
  ];
}
