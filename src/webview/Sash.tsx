import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

interface Props {
  /**
   * The pane it sizes: the references or the graph before it, the details after it, or, with `stack`, the details
   * when they are under the commits, which are sized by their height.
   */
  pane: 'refs' | 'graph' | 'detail' | 'stack';
  /** In pixels. Null for a pane that has not been given a size yet, and takes the share it starts with. */
  width: number | null;
  onResize(width: number): void;
  /** A double click: back to the size it had before it was ever dragged. */
  onReset(): void;
}

const MIN = { refs: 120, graph: 20, detail: 200, stack: 80 };
/** The most of the view a pane can take, as in the style sheet, so that the commits never disappear between the two. */
const MAX_SHARE = { refs: 0.35, graph: 0.6, detail: 0.55, stack: 0.8 };
/** What a pane takes before it is given a size, for the ones that can go without. */
const START_SHARE = 0.5;
const LABELS = { refs: 'Resize the references', graph: 'Resize the graph', detail: 'Resize the details', stack: 'Resize the details' };
const STEP = 16;

/** The line between two panes, dragged to make one larger and the other smaller. */
export function Sash({ pane, width, onResize, onReset }: Props) {
  const drag = useRef<{ at: number; size: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // One pane over the other is sized up and down.
  const stacked = pane === 'stack';
  // Dragging away from the pane makes it larger: to the left, or up, for the details, which come after the line.
  const direction = pane === 'detail' || stacked ? -1 : 1;
  const room = (element: HTMLElement) => (stacked ? element.parentElement?.clientHeight : element.parentElement?.clientWidth) ?? Infinity;
  const where = (event: PointerEvent) => (stacked ? event.clientY : event.clientX);
  /** The size in use, which can be less than the one asked for when the view is too small for it. */
  const shown = (element: HTMLElement) => Math.min(width ?? room(element) * START_SHARE, room(element) * MAX_SHARE[pane]);

  const resize = (element: HTMLElement, wanted: number) => {
    onResize(Math.round(Math.max(MIN[pane], Math.min(wanted, room(element) * MAX_SHARE[pane]))));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { at: where(event), size: shown(event.currentTarget) };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current) resize(event.currentTarget, drag.current.size + (where(event) - drag.current.at) * direction);
  };
  const stop = () => {
    drag.current = null;
    setDragging(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const [more, less] = stacked ? ['ArrowDown', 'ArrowUp'] : ['ArrowRight', 'ArrowLeft'];
    const step = event.key === more ? STEP : event.key === less ? -STEP : 0;
    if (!step) return;
    event.preventDefault();
    resize(event.currentTarget, shown(event.currentTarget) + step * direction);
  };

  return (
    <div
      className={`sash ${pane}-sash${dragging ? ' dragging' : ''}`}
      role="separator"
      // Of the line itself: the one between two panes side by side stands up.
      aria-orientation={stacked ? 'horizontal' : 'vertical'}
      aria-label={LABELS[pane]}
      aria-valuenow={width ?? undefined}
      aria-valuemin={MIN[pane]}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
