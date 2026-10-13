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

/**
 * A message as its subject and what follows it. The subject is the first line, with the lines after it that it was
 * cut into: git takes the whole first paragraph for it, which would take in a list written right under the first line.
 */
export function subjectAndBody(message: string): { subject: string; body: string } {
  const text = message.trim();
  const end = text.search(/\n[ \t]*\n/);
  const first = (end < 0 ? text : text.slice(0, end)).split('\n');
  const whole = unwrap(first.join('\n')).split('\n')[0];
  let subject = first[0];
  let taken = 1;
  while (subject.length < whole.length && taken < first.length) subject += ` ${first[taken++].trim()}`;
  return { subject, body: (first.slice(taken).join('\n') + (end < 0 ? '' : text.slice(end))).trim() };
}

/** The longest a subject is shown whole as a title: one that goes on is a paragraph, not a title. */
const TITLE_LENGTH = 100;
/** How short a first sentence can be and still make a title, and how far past the usual length one may end. */
const SHORTEST_TITLE = 20;
const LONGEST_TITLE = 120;
/** The end of a sentence: its mark, what may close it, and the capital letter or the digit the next one starts with. */
const SENTENCE_END = /[.!?]["')\]]?(?=\s+[\p{Lu}\d])/gu;

/**
 * What a commit says, as a title and the text under it. Git calls subject the whole first paragraph, and some
 * messages are one paragraph: shown as a title it would fill the details with bold text. A subject that long gives
 * its first sentence to the title, or its first words when the sentence is as long, and the rest opens the text.
 */
export function said(subject: string, body: string): { title: string; text: string } {
  const text = unwrap(body);
  if (subject.length <= TITLE_LENGTH) return { title: subject, text };
  let cut = 0;
  for (const end of subject.matchAll(SENTENCE_END)) {
    const at = end.index + end[0].length;
    if (at > LONGEST_TITLE) break;
    if (at >= SHORTEST_TITLE) {
      cut = at;
      break;
    }
  }
  const sentence = cut > 0;
  if (!sentence) cut = subject.lastIndexOf(' ', TITLE_LENGTH - 20);
  if (cut <= 0) return { title: subject, text };
  const title = subject.slice(0, cut).trimEnd();
  const rest = subject.slice(cut).trimStart();
  return { title: sentence ? title : `${title}…`, text: [sentence ? rest : `…${rest}`, text].filter(Boolean).join('\n\n') };
}

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
