import { describe, expect, it } from 'vitest';
import { answerProposal, fingerprint } from '../src/git/review';
import { resolveConflicts } from '../src/git/conflicts';
import { buildConflictPrompt, fitResolution, parseConflictAnswer, partialResolution } from '../src/shared/conflictPrompt';
import { newLineCount } from '../src/shared/resolution';

const question = {
  path: 'src/cart.ts',
  oursLabel: 'The branch checked out',
  theirsLabel: 'The branch being merged',
  oursSubject: 'Take the discount off',
  theirsSubject: null,
  before: 'for (const item of items) {\n',
  after: '}\n',
  ours: '  sum += item.price - item.discount;\n',
  theirs: '  sum += item.price * item.quantity;\n',
  base: '  sum += item.price;\n',
};

describe('the question to the language model about a conflict', () => {
  it('says what each side is, and gives the lines of the file between tags', () => {
    const prompt = buildConflictPrompt(question);
    expect(prompt).toContain('Resolve one merge conflict in the file src/cart.ts.');
    expect(prompt).toContain('"Current" is the branch checked out, in the commit "Take the discount off".');
    expect(prompt).toContain('"Incoming" is the branch being merged.');
    expect(prompt).toContain('<base>\n  sum += item.price;\n</base>\n<current>\n  sum += item.price - item.discount;\n</current>');
    expect(buildConflictPrompt({ ...question, base: null })).not.toContain('<base>');
  });

  it('reads the answer, with what is around it and in whatever order', () => {
    const answer = 'Here it is.\n<resolution>\n  sum += (item.price - item.discount) * item.quantity;\n</resolution>\n<confidence> High </confidence>\n<reason>Both\n changes kept.</reason>';
    expect(parseConflictAnswer(answer)).toEqual({ text: '  sum += (item.price - item.discount) * item.quantity;\n', reason: 'Both changes kept.', confidence: 'high' });
    // Lines deleted on both sides are an empty resolution; a confidence it does not know is taken as medium.
    expect(parseConflictAnswer('<resolution>\n</resolution><confidence>sure</confidence>')).toEqual({ text: '', reason: 'The language model gave no reason.', confidence: 'medium' });
    expect(() => parseConflictAnswer('I cannot.')).toThrow('did not answer with a resolution');
    expect(() => parseConflictAnswer('<resolution>\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n</resolution>')).toThrow('conflict markers');
  });

  it('shows what is written so far, without the start of the closing tag', () => {
    expect(partialResolution('Thinking')).toBe('');
    expect(partialResolution('<resolution>\n  sum += item')).toBe('  sum += item');
    expect(partialResolution('<resolution>\n  sum;\n</reso')).toBe('  sum;\n');
    expect(partialResolution('<resolution>\n  sum;\n</resolution>\n<reason>')).toBe('  sum;\n');
  });

  it('tells the model that the other conflicts around are not its own', () => {
    expect(buildConflictPrompt(question)).toContain('The lines before and after it can hold other conflicts, with their markers: those are resolved');
  });
});

describe('an answer that writes again the lines around its conflict', () => {
  // The middle conflict of a file with three, as a small model was asked about it and answered.
  const lines = (...each: string[]) => each.map((line) => `${line}\n`).join('');
  const around = {
    before: lines(
      'export interface Item {',
      '  id: string;',
      '  price: number;',
      '<<<<<<< HEAD',
      '  discount?: number;',
      '=======',
      '  quantity: number;',
      '>>>>>>> beside',
      '}',
      '',
      'export function total(items: Item[]): number {',
      '  let sum = 0;',
      '  for (const item of items) {',
    ),
    after: lines(
      '  }',
      '  return sum;',
      '}',
      '',
      'export function label(items: Item[]): string {',
      '<<<<<<< HEAD',
      '  return `${items.length} items in the cart`;',
      '=======',
      '  return `${items.length} articles`;',
      '>>>>>>> beside',
      '}',
    ),
    ours: '    sum += item.price - (item.discount ?? 0);\n',
    theirs: '    sum += item.price * item.quantity;\n',
  };
  const answer = (text: string) => ({ text, reason: 'Kept both.', confidence: 'high' as const });

  it('keeps only what stands in place of the conflict', () => {
    const echoed = lines(
      'export interface Item {',
      '  id: string;',
      '  price: number;',
      '  discount?: number;',
      '}',
      '',
      'export function total(items: Item[]): number {',
      '  let sum = 0;',
      '  for (const item of items) {',
      '    sum += item.price * item.quantity - (item.discount ?? 0);',
      '  }',
      '  return sum;',
      '}',
      '',
      'export function label(items: Item[]): string {',
      '  return `${items.length} items in the cart`;',
      '}',
    );
    expect(fitResolution(answer(echoed), around).text).toBe('    sum += item.price * item.quantity - (item.discount ?? 0);\n');
    // Only the lines after it, or only the ones before.
    const after = answer(lines('    sum += 1;', '  }', '  return sum;', '}', '', 'export function label(items: Item[]): string {'));
    expect(fitResolution(after, around).text).toBe('    sum += 1;\n');
    expect(fitResolution(answer(lines('  let sum = 0;', '  for (const item of items) {', '    sum += 1;')), around).text).toBe('    sum += 1;\n');
  });

  it('takes away the closing brace that ends the file, once the lines before the conflict were written again', () => {
    const last = { ...around, before: lines('  return sum;', '}', '', 'export function label(items: Item[]): string {'), after: lines('}') };
    const echoed = answer(lines('  return sum;', '}', '', 'export function label(items: Item[]): string {', '  return `${items.length} items`;', '}', ''));
    expect(fitResolution(echoed, last).text).toBe('  return `${items.length} items`;\n');
  });

  it('leaves alone an answer that is only the conflict, or that has lines of its own beside the ones it repeats', () => {
    const own = answer('    sum += item.price * item.quantity;\n');
    expect(fitResolution(own, around)).toBe(own);
    // The two lines that come before the conflict, after lines the model made up: they are part of what it wrote.
    const made = answer(lines('  const rate = 2;', '  let sum = 0;', '  for (const item of items) {', '    sum += rate;'));
    expect(fitResolution(made, around)).toBe(made);
  });

  it('is refused when nothing is left in place of the conflict', () => {
    const nothing = lines('export function label(items: Item[]): string {', '  return `${items.length} articles`;', '}');
    const after = lines('', 'export function label(items: Item[]): string {', '  return `${items.length} articles`;', '}');
    expect(() => fitResolution(answer(nothing), { ...around, after })).toThrow('wrote the lines around the conflict again');
  });
});

describe('an answer of the language model in its file', () => {
  const file = (...lines: string[]) => lines.map((line) => `${line}\n`).join('');
  const marked = file('top', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature', 'end');
  const answer = { text: 'ours\nnew line\n', reason: 'Both.', confidence: 'low' as const };

  it('replaces the markers and what is between them, and counts the lines neither side has', () => {
    const [conflict] = resolveConflicts(marked, file('top', 'old', 'end')).conflicts;
    expect(answerProposal(marked, conflict, answer)).toEqual({
      source: 'ai',
      from: 1,
      to: 6,
      text: 'ours\nnew line\n',
      reason: 'Both.',
      confidence: 'low',
      newLines: 1,
    });
    expect(newLineCount('  a\n\nb\n', 'a\n', null)).toBe(1);
  });

  it('takes the line endings of the file, also at its very end', () => {
    const windows = marked.replaceAll('\n', '\r\n');
    const [conflict] = resolveConflicts(windows, '').conflicts;
    expect(answerProposal(windows, conflict, answer).text).toBe('ours\r\nnew line\r\n');
    const last = file('top', '<<<<<<< HEAD', 'ours', '=======', 'theirs').concat('>>>>>>> feature');
    const [atEnd] = resolveConflicts(last, '').conflicts;
    expect(answerProposal(last, atEnd, answer).text).toBe('ours\nnew line');
  });

  it('knows a conflict by its text, wherever it is in the file', () => {
    const [conflict] = resolveConflicts(marked, '').conflicts;
    const moved = `${file('added above')}${marked}`;
    const [again] = resolveConflicts(moved, '').conflicts;
    expect(fingerprint(moved, again)).toBe(fingerprint(marked, conflict));
    expect(fingerprint(marked.replaceAll('\n', '\r\n'), conflict)).toBe(fingerprint(marked, conflict));
    expect(fingerprint(marked.replace('ours', 'edited'), conflict)).not.toBe(fingerprint(marked, conflict));
  });

  it('knows a conflict again when git names its sides otherwise, as after Undo', () => {
    const [conflict] = resolveConflicts(marked, '').conflicts;
    const renamed = marked.replace(/^<{7} .*$/m, '<<<<<<< ours').replace(/^>{7} .*$/m, '>>>>>>> theirs');
    expect(renamed).not.toBe(marked);
    expect(fingerprint(renamed, conflict)).toBe(fingerprint(marked, conflict));
  });
});
