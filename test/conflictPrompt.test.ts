import { describe, expect, it } from 'vitest';
import { answerProposal, fingerprint } from '../src/git/review';
import { resolveConflicts } from '../src/git/conflicts';
import { buildConflictPrompt, parseConflictAnswer, partialResolution } from '../src/shared/conflictPrompt';
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
