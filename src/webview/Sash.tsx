import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

interface Props {
  /** The pane it sizes: the references or the graph before it, or the details after it. */
  pane: 'refs' | 'graph' | 'detail';
  width: number;
  onResize(width: number): void;
  /** A double click: back to the width it had before it was ever dragged. */
  onReset(): void;
}

const MIN = { refs: 120, graph: 20, detail: 200 };
/** The most of the view a pane can take, as in the style sheet, so that the commits never disappear between the two. */
const MAX_SHARE = { refs: 0.35, graph: 0.6, detail: 0.55 };
const LABELS = { refs: 'Resize the references', graph: 'Resize the graph', detail: 'Resize the details' };
const STEP = 16;

/** The line between two panes, dragged to make one wider and the other narrower. */
export function Sash({ pane, width, onResize, onReset }: Props) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // Dragging away from the pane widens it: to the left for the details, which come after the line.
  const direction = pane === 'detail' ? -1 : 1;

  const resize = (element: HTMLElement, wanted: number) => {
    const most = (element.parentElement?.clientWidth ?? Infinity) * MAX_SHARE[pane];
    onResize(Math.round(Math.max(MIN[pane], Math.min(wanted, most))));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // The width in use can be less than the one asked for, when the view is too narrow for it.
    const shown = event.currentTarget.parentElement!.clientWidth * MAX_SHARE[pane];
    drag.current = { x: event.clientX, width: Math.min(width, shown) };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current) resize(event.currentTarget, drag.current.width + (event.clientX - drag.current.x) * direction);
  };
  const stop = () => {
    drag.current = null;
    setDragging(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? STEP : event.key === 'ArrowLeft' ? -STEP : 0;
    if (!step) return;
    event.preventDefault();
    resize(event.currentTarget, width + step * direction);
  };

  return (
    <div
      className={`sash ${pane}-sash${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={LABELS[pane]}
      aria-valuenow={width}
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
