/**
 * Worker thread entry: runs diff jobs off the extension host's main thread,
 * so a huge or pathological diff never freezes other extensions.
 */
import { parentPort } from 'node:worker_threads';
import { type DiffJob, runDiffJob } from './diff/diffJob';

parentPort?.on('message', ({ id, job }: { id: number; job: DiffJob }) => {
  parentPort?.postMessage({ id, result: runDiffJob(job) });
});
