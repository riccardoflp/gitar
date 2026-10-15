import type { AlignedDiffModel } from '../diff/model';

export interface Layout {
  leftLabel: HTMLElement;
  rightLabel: HTMLElement;
  leftHost: HTMLElement;
  gutter: HTMLElement;
  rightHost: HTMLElement;
}

/** Static scaffold: header labels + [monaco host | gutter | monaco host]. */
export function createLayout(root: HTMLElement): Layout {
  root.textContent = '';

  const header = el('div', 'header');
  const leftLabel = el('div', 'pane-label');
  const gutterSpacer = el('div', 'gutter-spacer');
  const rightLabel = el('div', 'pane-label');
  header.append(leftLabel, gutterSpacer, rightLabel);

  const body = el('div', 'diff-body');
  const leftHost = el('div', 'editor-host');
  const gutter = el('div', 'gutter');
  const rightHost = el('div', 'editor-host');
  body.append(leftHost, gutter, rightHost);

  root.append(header, body);
  return { leftLabel, rightLabel, leftHost, gutter, rightHost };
}

export function setHeaderLabels(layout: Layout, model: AlignedDiffModel): void {
  layout.leftLabel.textContent = `${model.filePath} — ${model.leftLabel}`;
  layout.rightLabel.textContent = model.rightLabel;
}

/** Full text of one side, reconstructed from the aligned model (fillers skipped). */
export function sideText(model: AlignedDiffModel, side: 'left' | 'right'): string {
  const lines: string[] = [];
  for (const row of model.rows) {
    const cell = side === 'left' ? row.left : row.right;
    if (cell.kind !== 'filler') {
      lines.push(cell.text ?? '');
    }
  }
  return lines.join('\n');
}

function el(tag: string, className: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}
