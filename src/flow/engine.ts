import { Worker } from 'node:worker_threads';
import { type DiffJob, type DiffJobResult, runDiffJob } from './diff/diffJob';

/**
 * Runs diff jobs on a lazily started worker thread (falls back to inline if
 * the worker cannot start). Jobs are answered in order; a crashed worker
 * fails its pending jobs and is restarted on the next one.
 */
export class DiffEngine {
  private worker: Worker | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, (result: DiffJobResult) => void>();

  /** `script` is the bundled `worker.ts`. */
  constructor(private readonly script: string) {}

  run(job: DiffJob): Promise<DiffJobResult> {
    const worker = this.ensureWorker();
    if (!worker) {
      return Promise.resolve(runDiffJob(job));
    }
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      worker.ref(); // keep the thread alive while a job is in flight
      worker.postMessage({ id, job });
    });
  }

  private ensureWorker(): Worker | undefined {
    if (this.worker) {
      return this.worker;
    }
    try {
      const worker = new Worker(this.script);
      worker.on('message', ({ id, result }: { id: number; result: DiffJobResult }) => {
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
