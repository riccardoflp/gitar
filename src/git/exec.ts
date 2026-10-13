import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} exited with code ${result.code}`);
  }
}

export interface GitOptions {
  /** Read-only queries must not take locks, or they would fight with the user's own git commands. */
  readOnly?: boolean;
  /** Text to feed to the command's standard input, such as a patch for `git apply`. */
  input?: string;
}

/** Runs `git <args>` exactly as given: no extra flags are added, so what gets logged or previewed is what runs. */
export function git(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (options.readOnly) env.GIT_OPTIONAL_LOCKS = '0';

    const child = spawn('git', args, { cwd, env, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    // A command that exits early closes its stdin; that failure is reported through its exit code instead.
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
    child.on('close', (code) => {
      const result = {
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        code: code ?? -1,
      };
      if (result.code === 0) resolve(result);
      else reject(new GitError(args, result));
    });
  });
}

/** A file to write: `expected` is what it had when `content` was made from it. */
export interface FileWrite {
  path: string;
  content: string;
  expected: string;
}

/**
 * Writes files of a repository, all of them or none: when one is no longer what it was when its new content was
 * made, nothing is written.
 */
export async function writeFiles(cwd: string, writes: FileWrite[]): Promise<void> {
  for (const write of writes) {
    const now = await fs.promises.readFile(path.join(cwd, write.path), 'utf8').catch(() => null);
    if (now !== write.expected) throw new Error(`${write.path} has changed since it was read, so nothing was written. Try again.`);
  }
  for (const write of writes) await fs.promises.writeFile(path.join(cwd, write.path), write.content);
}

/** Renders a command line the way you would type it in a shell. */
export function formatCommand(args: string[]): string {
  const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\])/g, '\\$1')}"`);
  return ['git', ...args.map(quote)].join(' ');
}
