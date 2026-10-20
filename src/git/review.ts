import { createHash } from 'node:crypto';
import type { ConflictAnswer } from '../shared/conflictPrompt';
import { RESOLUTIONS, newLineCount, type Asking, type Proposal, type ReviewConflict, type ReviewFile } from '../shared/resolution';
import type { Conflict } from './conflicts';
import type { ConflictPlan } from './repo';

/** How many lines of the file the tab shows before a conflict and after it. */
const AROUND = 3;

/** What a language model answered for a conflict, wherever the conflict is in its file. */
export type Answer = ConflictAnswer;

/** What is known of the questions to the language model, by file and by the fingerprint of the conflict. */
export interface Asked {
  answer(path: string, fingerprint: string): Answer | undefined;
  asking(path: string, fingerprint: string): Asking | undefined;
}

const linesOf = (text: string) => text.split(/(?<=\n)/);

/**
 * What a conflict is as git marked it: its markers and what is between them. Two conflicts with the same fingerprint
 * are resolved the same way, wherever they are in the file, whatever was edited around them, and however git named
 * the sides on the markers, which changes when Undo puts the conflicts back.
 */
export function fingerprint(text: string, conflict: Pick<Conflict, 'from' | 'to'>): string {
  const marked = linesOf(text)
    .slice(conflict.from, conflict.to)
    .map((line) => line.replace(/\r?\n$|\r$/, '').replace(/^(<{7}|\|{7}|>{7}) .*$/, '$1'));
  return createHash('sha1').update(marked.join('\n')).digest('hex').slice(0, 16);
}

/**
 * An answer of the language model as the lines it replaces in a file: the markers of the conflict and what is between
 * them, with the line endings of the file.
 */
export function answerProposal(text: string, conflict: Conflict, answer: Answer): Proposal {
  const marked = linesOf(text).slice(conflict.from, conflict.to);
  const ending = /\r\n$/.test(marked[0] ?? '') ? '\r\n' : '\n';
  // The last marker may be the last line of the file, without a line break after it.
  const last = marked[marked.length - 1] ?? '';
  const lines = answer.text ? answer.text.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  const ends = /\n$/.test(last) || conflict.to < linesOf(text).length;
  const resolved = lines.length ? lines.join(ending) + (ends ? ending : '') : '';
  return {
    source: 'ai',
    from: conflict.from,
    to: conflict.to,
    text: resolved,
    reason: answer.reason,
    confidence: answer.confidence,
    newLines: newLineCount(resolved, conflict.ours, conflict.theirs, conflict.stretch?.base ?? null),
    ...(answer.model ? { model: answer.model } : {}),
  };
}

/** How many lines around a conflict the language model is shown. */
const ASKED_AROUND = 40;

/** What the language model is shown of a conflict: what is in it and the lines around it. */
export function questionParts(text: string, conflict: Conflict): { before: string; after: string; ours: string; theirs: string; base: string | null } {
  const lines = linesOf(text);
  return {
    before: lines.slice(Math.max(0, conflict.from - ASKED_AROUND), conflict.from).join(''),
    after: lines.slice(conflict.to, conflict.to + ASKED_AROUND).join(''),
    ours: conflict.ours,
    theirs: conflict.theirs,
    base: conflict.stretch?.base ?? null,
  };
}

/** What the rules put in place of a conflict, when they resolve it. */
export function rulesProposal(conflict: Conflict): Proposal | null {
  if (!conflict.patch || !conflict.resolution) return null;
  const reason = RESOLUTIONS[conflict.resolution];
  return { source: 'rules', ...conflict.patch, reason: `${reason[0].toUpperCase()}${reason.slice(1)}`, confidence: null, newLines: 0 };
}

/**
 * The files in conflict as the tab of the review shows them: each conflict with what is around it, and what is
 * proposed for it. The rules are taken first, where `rules`; the language model answers the others.
 */
export function reviewFiles(plans: ConflictPlan[], rules: boolean, asked: Asked): ReviewFile[] {
  return plans.map((plan) => {
    const lines = linesOf(plan.text);
    const conflicts = plan.conflicts.map((conflict, index): ReviewConflict => {
      const print = fingerprint(plan.text, conflict);
      const answer = asked.answer(plan.path, print);
      const proposal = (rules ? rulesProposal(conflict) : null) ?? (answer ? answerProposal(plan.text, conflict, answer) : null);
      // The rules can take some lines around the markers too: what is shown around is what the proposal leaves.
      const [from, to] = proposal ? [proposal.from, proposal.to] : [conflict.from, conflict.to];
      return {
        key: `${index}:${print}`,
        line: conflict.line,
        ours: conflict.ours,
        theirs: conflict.theirs,
        base: conflict.stretch?.base ?? null,
        before: lines.slice(Math.max(0, from - AROUND), from).join(''),
        after: lines.slice(to, to + AROUND).join(''),
        proposal,
        asking: proposal ? null : (asked.asking(plan.path, print) ?? null),
      };
    });
    return { path: plan.path, conflicts };
  });
}
