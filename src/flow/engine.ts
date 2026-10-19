import { Worker } from 'node:worker_threads';
import { type DiffJob, type DiffJobResult, type MergeJobResult, runDiffJob, runMergeJob } from './diff/diffJob';
import type { MergeInput } from './diff/merge3';

type Result = DiffJobResult | MergeJobResult;

/**
 * Runs diff jobs on a lazily started worker thread (falls back to inline if
 * the worker cannot start). Jobs are answered in order; a crashed worker
 * fails its pending jobs and is restarted on the next one.
 */
export class DiffEngine {
  private worker: Worker | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, (result: Result) => void>();

  /** `script` is the bundled `worker.ts`. */
  constructor(private readonly script: string) {}

  run(job: DiffJob): Promise<DiffJobResult> {
    return this.post({ job }, () => runDiffJob(job)) as Promise<DiffJobResult>;
  }

  /** The three-way model of a file in conflict, for the Flow Merge. */
  runMerge(merge: MergeInput): Promise<MergeJobResult> {
    return this.post({ merge }, () => runMergeJob(merge)) as Promise<MergeJobResult>;
  }

  private post(message: { job: DiffJob } | { merge: MergeInput }, inline: () => Result): Promise<Result> {
    const worker = this.ensureWorker();
    if (!worker) {
      return Promise.resolve(inline());
    }
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      worker.ref(); // keep the thread alive while a job is in flight
      worker.postMessage({ id, ...message });
    });
  }

  private ensureWorker(): Worker | undefined {
    if (this.worker) {
      return this.worker;
    }
    try {
      const worker = new Worker(this.script);
      worker.on('message', ({ id, result }: { id: number; result: Result }) => {
        this.pending.get(id)?.(result);
        this.pending.delete(id);
        if (this.pending.size === 0) {
          worker.unref(); // idle: never holds the process open on shutdown
        }
      });
      worker.on('error', (error: Error) => this.fail(worker, error.message));
      worker.on('exit', () => this.fail(worker, 'diff worker exited'));
      this.worker = worker;
      return worker;
    } catch {
      return undefined;
    }
  }

  private fail(worker: Worker, message: string): void {
    if (this.worker !== worker) {
      return;
    }
    this.worker = undefined;
    for (const resolve of this.pending.values()) {
      resolve({ ok: false, tooComplex: false, message });
    }
    this.pending.clear();
  }

  dispose(): void {
    const worker = this.worker;
    if (worker) {
      this.fail(worker, 'diff engine disposed');
      void worker.terminate();
    }
  }
}
