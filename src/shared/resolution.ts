import type { Operation, Resolution } from './protocol';

// What can be proposed for the conflicts of a merge, and the tab where the proposals are looked at before anything is
// written. The proposals come from the rules of Gitardo, which never write a line that neither side has, or from the
// language model the user has set up in VS Code, which can.

/** The cases the rules resolve, said as the tab and the questions say them. */
export const RESOLUTIONS: Record<Resolution, string> = {
  separate: 'changes to lines next to each other',
  same: 'the same change on both sides',
  whitespace: 'spaces or line endings only',
  oneSide: 'a change on one side only',
};

/** Where a proposal comes from. */
export type ProposalSource = 'rules' | 'ai';

/** How sure the language model says it is of what it proposes. */
export type Confidence = 'high' | 'medium' | 'low';

/** What a conflict could be resolved to: lines `from` to `to` of the file, from 0, with `text` in their place. */
export interface Proposal {
  source: ProposalSource;
  from: number;
  to: number;
  text: string;
  /** Why, in a few words: the case for the rules, what the model said for the AI. */
  reason: string;
  confidence: Confidence | null;
  /** How many lines of `text` neither side nor the base has: the rules never write any. */
  newLines: number;
  /** The name of the model that wrote it, for the AI. */
  model?: string;
}

/** Where the question to the language model about a conflict is: waiting for its turn, answered in part, or failed. */
export type Asking = { state: 'waiting' } | { state: 'thinking'; text: string } | { state: 'failed'; error: string };

export interface ReviewConflict {
  /** The same for the same conflict as long as nobody edits it, whatever is written elsewhere in the file. */
  key: string;
  /** The line of its first marker, from 1. */
  line: number;
  /** What each side has between the markers. */
  ours: string;
  theirs: string;
  /** What it was before either side changed it, when that can be told. */
  base: string | null;
  /** A few lines of the file before the markers and after them. */
  before: string;
  after: string;
  /**
   * The lines the proposal takes the place of, as each side has them: what is between the markers, and the lines
   * around them that the rules take too. Without a proposal, what is between the markers.
   */
  region: { ours: string; theirs: string };
  proposal: Proposal | null;
  asking: Asking | null;
}

export interface ReviewFile {
  path: string;
  conflicts: ReviewConflict[];
}

/** What the last resolutions written did. */
export interface ReviewReport {
  /** How many conflicts were resolved, and in how many files. */
  resolved: number;
  files: number;
  /** How many of those files were left with no conflict, and staged. */
  staged: number;
  /** Of them, how many were proposed by the language model. */
  fromAI: number;
}

/** What the tab of the review of the conflicts shows. */
export interface ConflictReview {
  root: string;
  operation: Operation | null;
  /** What the two sides are, as the Flow Merge names them. */
  oursLabel: string;
  theirsLabel: string;
  files: ReviewFile[];
  /** The files in conflict without markers to look at here: binary ones, the ones a side deleted, the very large ones. */
  others: string[];
  /** Whether the rules propose resolutions, and whether the language model can be asked: each has its setting. */
  rules: boolean;
  ai: boolean;
  /** Whether questions to the language model are under way. */
  asking: boolean;
  /** The model the questions go to, and how much it thinks, in words; null when VS Code has none. */
  model: string | null;
  report: ReviewReport | null;
  /** How many files are still in conflict in the repository, here or not. */
  conflicted: number;
}

/** Which conflict of which file: what the tab sends back to say which proposals were accepted. */
export interface ConflictRef {
  path: string;
  key: string;
}

/** The lines of a text, without what ends them. */
const linesOf = (text: string) => (text ? text.replace(/\r?\n$/, '').split(/\r?\n/) : []);

/** How many lines of a proposal none of these texts has: what a language model wrote of its own. */
export function newLineCount(text: string, ...from: (string | null)[]): number {
  const known = new Set(from.flatMap((each) => linesOf(each ?? '').map((line) => line.trim())));
  return linesOf(text).filter((line) => line.trim() && !known.has(line.trim())).length;
}

/** What the tab and the questions call a conflict of a file. */
export const conflictName = (path: string, line: number) => `${path}:${line}`;
