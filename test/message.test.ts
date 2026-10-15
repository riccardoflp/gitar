import { describe, expect, it } from 'vitest';
import { said, subjectAndBody, unwrap } from '../src/shared/message';

const lines = (...text: string[]) => text.join('\n');

describe('unwrap', () => {
  it('puts back together the lines of a paragraph that were cut at a width', () => {
    const body = lines(
      'The Pull button of the graph, the one in the header of the Commits view',
      'and the command "Gitardo: Pull" now run `git pull --rebase --autostash`.',
      'Two settings, both on by default, choose it.',
      '',
      'The tooltip of the button says the command it runs. The menu beside it',
      'keeps the four ways to pull.',
    );
    expect(unwrap(body)).toBe(
      lines(
        'The Pull button of the graph, the one in the header of the Commits view and the command "Gitardo: Pull" now run `git pull --rebase --autostash`. Two settings, both on by default, choose it.',
        '',
        'The tooltip of the button says the command it runs. The menu beside it keeps the four ways to pull.',
      ),
    );
  });

  it('leaves alone a message whose lines are all short: they end where they were meant to', () => {
    const body = lines('With a body that says why,', 'on two lines.');
    expect(unwrap(body)).toBe(body);
    expect(unwrap('')).toBe('');
    expect(unwrap('One line only, however long it is, has nothing to be joined to and stays the way it is.')).toBe(
      'One line only, however long it is, has nothing to be joined to and stays the way it is.',
    );
  });

  it('keeps a line that ends early apart from the next, in a message that is cut elsewhere', () => {
    const body = lines(
      'This paragraph is long enough to have been cut by the editor at its usual',
      'width, and it ends here.',
      'Changed:',
      'the first thing',
      'the second thing',
    );
    expect(unwrap(body)).toBe(
      lines(
        'This paragraph is long enough to have been cut by the editor at its usual width, and it ends here.',
        'Changed:',
        'the first thing',
        'the second thing',
      ),
    );
  });

  it('puts each item of a list back together on its own, indented under it or not', () => {
    const body = lines(
      'What changed, in a sentence that is long enough to reach the width of it:',
      '',
      '- the first item, which says enough to be cut where the others are and so',
      '  goes on under itself',
      '- the second, short',
      '* the third item, which is as long as the first and is cut at the same place',
      'without being indented',
      '  - one inside, of its own',
      '1. a numbered one that also runs up to the width where the lines are cut,',
      '   then stops',
    );
    expect(unwrap(body)).toBe(
      lines(
        'What changed, in a sentence that is long enough to reach the width of it:',
        '',
        '- the first item, which says enough to be cut where the others are and so goes on under itself',
        '- the second, short',
        '* the third item, which is as long as the first and is cut at the same place without being indented',
        '  - one inside, of its own',
        '1. a numbered one that also runs up to the width where the lines are cut, then stops',
      ),
    );
  });

  it('keeps what is laid out on purpose: indented lines, fenced blocks, quotations, headings and trailers', () => {
    const body = lines(
      'A paragraph that comes before the rest and is long enough to have been cut at',
      'the width, as this one was.',
      '',
      '    an indented line that is very long, as a line of code can be, and stays so',
      '    and another under it',
      '',
      '```',
      'a line in a fenced block that is long enough to look like one that was cut ok',
      'and the one after it',
      '```',
      '> a quotation, which is long enough to look like a line that was cut by them',
      '> and goes on',
      '# A heading that is long enough to look like a line the editor has cut there',
      'and the line under it',
      '',
      'Co-Authored-By: Someone With A Very Long Name Indeed <someone@example.invalid>',
      'Signed-off-by: Someone Else <else@example.invalid>',
    );
    expect(unwrap(body)).toBe(
      lines(
        'A paragraph that comes before the rest and is long enough to have been cut at the width, as this one was.',
        '',
        '    an indented line that is very long, as a line of code can be, and stays so',
        '    and another under it',
        '',
        '```',
        'a line in a fenced block that is long enough to look like one that was cut ok',
        'and the one after it',
        '```',
        '> a quotation, which is long enough to look like a line that was cut by them',
        '> and goes on',
        '# A heading that is long enough to look like a line the editor has cut there',
        'and the line under it',
        '',
        'Co-Authored-By: Someone With A Very Long Name Indeed <someone@example.invalid>',
        'Signed-off-by: Someone Else <else@example.invalid>',
      ),
    );
  });

  it('measures the width on the lines that were written, not on an address that could not be cut', () => {
    const body = lines(
      'See the discussion, which went on for a while before this was agreed on,',
      'at the address under this.',
      'https://example.invalid/a/very/long/address/that/no/editor/would/cut/anywhere/because/it/has/no/spaces/in/it',
      'and what was said there.',
    );
    expect(unwrap(body)).toBe(
      lines(
        'See the discussion, which went on for a while before this was agreed on, at the address under this.',
        'https://example.invalid/a/very/long/address/that/no/editor/would/cut/anywhere/because/it/has/no/spaces/in/it',
        'and what was said there.',
      ),
    );
  });

  it('takes the width from the message when its lines are cut before the usual one', () => {
    const body = lines('Lines cut at sixty columns are put back together too, as', 'these two are, in a message with nothing longer.');
    expect(unwrap(body)).toBe('Lines cut at sixty columns are put back together too, as these two are, in a message with nothing longer.');
  });
});

describe('subjectAndBody', () => {
  it('takes the first line for the subject and the rest for the body', () => {
    expect(subjectAndBody('Second commit\n\nWith a body.\n')).toEqual({ subject: 'Second commit', body: 'With a body.' });
    expect(subjectAndBody('Only a subject\n')).toEqual({ subject: 'Only a subject', body: '' });
    expect(subjectAndBody('')).toEqual({ subject: '', body: '' });
  });

  it('puts back together a subject that was cut into lines', () => {
    const message = lines(
      'The old reading no longer jumps: its path counts the ticks it really',
      'moves in, not the clock. Before, the clock went on all the same and it',
      'showed up where it should have been.',
      '',
      'Co-Authored-By: Someone <someone@example.com>',
    );
    expect(subjectAndBody(message)).toEqual({
      subject:
        'The old reading no longer jumps: its path counts the ticks it really moves in, not the clock. Before, the clock went on all the same and it showed up where it should have been.',
      body: 'Co-Authored-By: Someone <someone@example.com>',
    });
  });

  it('leaves under the subject what was written right under it on lines of its own', () => {
    expect(subjectAndBody(lines('Tidy up', '- the names of the views', '- the order of the commands'))).toEqual({
      subject: 'Tidy up',
      body: lines('- the names of the views', '- the order of the commands'),
    });
    const cut = lines(
      'A subject that was cut where the line ended, as the next word would not',
      'fit, and then stops.',
      'Something else, on a line of its own, that says more about what the commit does.',
    );
    expect(subjectAndBody(cut)).toEqual({
      subject: 'A subject that was cut where the line ended, as the next word would not fit, and then stops.',
      body: 'Something else, on a line of its own, that says more about what the commit does.',
    });
  });
});

describe('said', () => {
  it('keeps a subject of the usual length as the title, over the body put back together', () => {
    expect(said('Fix the chart on narrow screens', '')).toEqual({ title: 'Fix the chart on narrow screens', text: '' });
    const body = lines('The API of the tide service times out a few times a day, and the chart', 'was left empty until the next refresh.');
    expect(said('Retry on timeouts', body)).toEqual({ title: 'Retry on timeouts', text: unwrap(body) });
  });

  it('gives the title the first sentence of a subject that is a whole paragraph', () => {
    const first = 'The old reading no longer jumps: its path counts the ticks it really moves in, not the clock.';
    const rest = 'Before, held still by the surprise of seeing you, the clock went on all the same, and it showed up where it should have been.';
    expect(said(`${first} ${rest}`, '')).toEqual({ title: first, text: rest });
    expect(said(`${first} ${rest}`, 'Co-Authored-By: Someone <someone@example.com>')).toEqual({
      title: first,
      text: `${rest}\n\nCo-Authored-By: Someone <someone@example.com>`,
    });
  });

  it('does not take for a sentence what stops at an abbreviation or a version', () => {
    const subject = 'Handle the case of e.g. empty lists in v1.2. Then go on for a long while about everything else that this very long commit happens to change';
    expect(said(subject, '').title).toBe('Handle the case of e.g. empty lists in v1.2.');
  });

  it('cuts at a word a subject whose first sentence is as long, and says so on both sides', () => {
    const subject = Array.from({ length: 30 }, (_, index) => `word${index}`).join(' ');
    const { title, text } = said(subject, 'More.');
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith('…') && text.startsWith('…') && text.endsWith('\n\nMore.')).toBe(true);
    expect(`${title.slice(0, -1)} ${text.slice(1, -7)}`).toBe(subject);
  });

  it('leaves whole a long subject with nowhere to cut it', () => {
    const subject = 'x'.repeat(150);
    expect(said(subject, '')).toEqual({ title: subject, text: '' });
  });
});
