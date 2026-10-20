/**
 * The columns of a page, whose widths are dragged by the gutters between them, as the sashes of VS Code: the gutter
 * between two columns gives to one what it takes from the other, and a double click makes them all the same width
 * again. The header label of each column takes the width its column has: with their padding, labels shared by weight
 * would be a few pixels off their columns.
 */

export interface Column {
  host: HTMLElement;
  label: HTMLElement;
}

/** No column is dragged narrower than this. */
const MIN_WIDTH = 80;

export class Columns {
  private weights: number[];
  private readonly observer = new ResizeObserver(() => this.alignLabels());

  constructor(
    private readonly columns: Column[],
    /** The gutter at `index` is the one between the columns at `index` and `index + 1`. */
    gutters: HTMLElement[],
    /** The widths as they were left, from the state of the page. */
    weights: unknown,
    /** While a gutter is dragged, and with `done` once it is let go, with the widths to keep. */
    private readonly onChange: (weights: number[], done: boolean) => void,
  ) {
    const kept = Array.isArray(weights) && weights.length === columns.length && weights.every((weight) => typeof weight === 'number' && weight > 0 && Number.isFinite(weight));
    this.weights = kept ? [...(weights as number[])] : columns.map(() => 1);
    this.apply();
    for (const { host, label } of columns) {
      label.style.boxSizing = 'border-box';
      this.observer.observe(host);
    }
    gutters.forEach((gutter, index) => {
      gutter.classList.add('column-sash');
      gutter.addEventListener('pointerdown', (event) => this.drag(event, gutter, index));
      gutter.addEventListener('dblclick', (event) => {
        if (!onButton(event)) this.reset();
      });
    });
  }

  /** Every column the same width. */
  reset(): void {
    this.weights = this.columns.map(() => 1);
    this.apply();
    this.onChange([...this.weights], true);
  }

  private apply(): void {
    this.columns.forEach(({ host }, index) => {
      host.style.flexGrow = String(this.weights[index]);
    });
  }

  private alignLabels(): void {
    for (const { host, label } of this.columns) label.style.flex = `0 0 ${host.getBoundingClientRect().width}px`;
  }

  private drag(event: PointerEvent, gutter: HTMLElement, index: number): void {
    // The buttons of the bands are clicked, not dragged.
    if (event.button !== 0 || onButton(event)) return;
    const [one, two] = [this.columns[index].host, this.columns[index + 1].host];
    const [first, second] = [one.getBoundingClientRect().width, two.getBoundingClientRect().width];
    const both = first + second;
    if (both < 2 * MIN_WIDTH) return;
    event.preventDefault();
    // The two columns share their weights as they share their pixels; the others keep theirs.
    const perPixel = (this.weights[index] + this.weights[index + 1]) / both;
    const from = event.clientX;
    gutter.setPointerCapture(event.pointerId);
    gutter.classList.add('dragging');
    document.body.classList.add('columns-resizing');
    const move = (moved: PointerEvent) => {
      const width = Math.min(Math.max(first + moved.clientX - from, MIN_WIDTH), both - MIN_WIDTH);
      this.weights[index] = width * perPixel;
      this.weights[index + 1] = (both - width) * perPixel;
      this.apply();
      this.onChange([...this.weights], false);
    };
    const end = () => {
      gutter.removeEventListener('pointermove', move);
      gutter.removeEventListener('pointerup', end);
      gutter.removeEventListener('pointercancel', end);
      gutter.classList.remove('dragging');
      document.body.classList.remove('columns-resizing');
      this.onChange([...this.weights], true);
    };
    gutter.addEventListener('pointermove', move);
    gutter.addEventListener('pointerup', end);
    gutter.addEventListener('pointercancel', end);
  }
}

function onButton(event: Event): boolean {
  return event.target instanceof Element && event.target.closest('button') !== null;
}
