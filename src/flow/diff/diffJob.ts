/**
 * One unit of diff work, runnable in the diff worker thread or inline.
 * No `vscode` import: inputs and results are structured-clone friendly.
 */
import { computeDiff, type ComputeDiffInput, DiffTooComplexError } from './computeDiff';
import { type MergeInput, computeMerge } from './merge3';
import type { MergeModel } from './mergeModel';
import type { AlignedDiffModel } from './model';
import { markStagedChunks } from './staged';

export interface DiffJob {
  input: ComputeDiffInput;
  /** Worktree views: mark the chunks the index already contains. */
  markStaged: boolean;
  /** Index content for `markStaged` (undefined: untracked file). */
  indexText?: string;
}

export type DiffJobResult =
  | { ok: true; model: AlignedDiffModel }
  | { ok: false; tooComplex: boolean; message: string };

export function runDiffJob(job: DiffJob): DiffJobResult {
  try {
    const model = computeDiff(job.input);
    if (job.markStaged) {
      markStagedChunks(model, job.indexText, job.input.newText);
    }
    return { ok: true, model };
  } catch (error) {
    return {
      ok: false,
      tooComplex: error instanceof DiffTooComplexError,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export type MergeJobResult = { ok: true; model: MergeModel } | { ok: false; tooComplex: boolean; message: string };

/** The three-way model of a file in conflict, for the Flow Merge. */
export function runMergeJob(input: MergeInput): MergeJobResult {
  try {
    return { ok: true, model: computeMerge(input) };
  } catch (error) {
    return {
      ok: false,
      tooComplex: error instanceof DiffTooComplexError,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
