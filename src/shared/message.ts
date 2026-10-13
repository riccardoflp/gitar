/**
 * The width under which the longest line of a message says nothing: lines that short end where they were meant to,
 * not where an editor cut them.
 */
const WRAPPED_FROM = 50;
/** The width git asks the lines of a message to stay in. A line that the next word would take past it was cut. */
const USUAL_WIDTH = 72;

const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+\S/;
/** A quotation or a heading: a line of its own. So is an address, or anything else that long with no space to cut it at. */
const APART = /^[>#]|^\S*:\/\/\S*$|^\S{30,}$/;
/** `Co-Authored-By: someone`, as the last lines of a message are when they say such things. */
const TRAILER = /^[A-Za-z0-9][A-Za-z0-9-]*: \S/;

/** Where the last paragraph starts, when every line of it is a trailer; or past the end. */
function trailersFrom(lines: string[]): number {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  let start = end;
  while (start > 0 && lines[start - 1].trim()) start--;
  return end > start && lines.slice(start, end).every((line) => TRAILER.test(line)) ? start : lines.length;
}

/**
 * The body of a commit message with the lines of each paragraph put back together, to be cut again at the width of
 * where it is shown: written to fit in 72 columns, it would break twice a line in anything narrower. Only a line that
 * was cut is joined to the next: one that the first word of the next would have taken past the width. What is laid
 * out on purpose stays as it is: lists, each item of which is put back together on its own, indented lines, quotations,
 * headings, fenced blocks, addresses, short lines, and the trailers at the end.
 */
export function unwrap(body: string): string {
  const lines = body.split('\n');
  const trailers = trailersFrom(lines);
  const prose = lines.filter((line, index) => index < trailers && /\S\s+\S/.test(line));
  const longest = Math.max(0, ...prose.map((line) => line.length));
  if (longest < WRAPPED_FROM) return body;
  const width = Math.min(longest, USUAL_WIDTH);

  const out: string[] = [];
  /** Whether the line written last can take more words, whether it began as an item of a list, and how long its last piece was. */
  let open = false;
  let item = false;
  let last = 0;
  let fenced = false;
  lines.forEach((line, index) => {
    const fence = FENCE.test(line);
    if (fence) fenced = !fenced;
    const text = line.trim();
    const asIs = fenced || fence || index >= trailers || !text || APART.test(text);
    const isItem = !asIs && LIST_ITEM.test(line);
    const indented = /^\s/.test(line);
    // What goes on under an item of a list is often indented to its text; anywhere else an indented line is laid out.
    const joins = open && !asIs && !isItem && (!indented || item) && last + 1 + text.split(/\s+/)[0].length > width;
    if (joins) out[out.length - 1] += ` ${text}`;
    else out.push(line);
    if (!joins) {
      open = !asIs && (isItem || !indented);
      item = isItem;
    }
    last = line.length;
  });
  return out.join('\n');
}
