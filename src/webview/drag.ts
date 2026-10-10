import type { DragEvent } from 'react';

/** What is being dragged over the graph: a commit to cherry-pick, or a branch to merge or rebase. */
export type DragSource =
  | { kind: 'commit'; hash: string; isMerge: boolean }
  | { kind: 'branch'; name: string; hash: string; local: boolean; current: boolean };

// The browser hides the dragged data until the drop, but targets must decide earlier whether to accept it.
let active: DragSource | null = null;

export const dragging = () => active;

export function startDrag(event: DragEvent, source: DragSource): void {
  active = source;
  event.stopPropagation();
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData('text/plain', source.kind === 'commit' ? source.hash : source.name);
}

export function endDrag(): void {
  active = null;
}
