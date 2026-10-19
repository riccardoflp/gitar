/**
 * Worker thread entry: runs diff jobs off the extension host's main thread,
 * so a huge or pathological diff never freezes other extensions.
 */
import { parentPort } from 'node:worker_threads';
import { type DiffJob, runDiffJob, runMergeJob } from './diff/diffJob';
import type { MergeInput } from './diff/merge3';

parentPort?.on('message', ({ id, job, merge }: { id: number; job?: DiffJob; merge?: MergeInput }) => {
  parentPort?.postMessage({ id, result: merge ? runMergeJob(merge) : runDiffJob(job as DiffJob) });
});
