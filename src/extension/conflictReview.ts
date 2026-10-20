import * as path from 'node:path';
import * as vscode from 'vscode';
import { applyReplacements } from '../git/conflicts';
import { CONFLICT_SIDES, writeResolutionsOp, type GitOp } from '../git/ops';
import { samePath } from '../git/parse';
import type { ConflictPlan, Repo } from '../git/repo';
import { fingerprint, questionParts, reviewFiles } from '../git/review';
import { partialResolution } from '../shared/conflictPrompt';
import type { HostMessage, Operation, ViewKind } from '../shared/protocol';
import type { Asking, ConflictRef, ConflictReview, Proposal, ReviewReport } from '../shared/resolution';
import { askResolution } from './ai';
import { proposalUri } from './content';
import { answers } from './answers';

/** How many conflicts the language model is asked about at the same time. */
const AT_ONCE = 2;
/** How often the tab is sent what the language model has written so far, at most. */
const SEND_EVERY = 120;

/** What the tab of the review needs of the controller. */
export interface ReviewHost {
  attach(webview: vscode.Webview, kind: ViewKind, data: Record<string, string>): vscode.Disposable;
  post(message: HostMessage, webview: vscode.Webview): void;
  /** Runs an operation that writes resolutions, with Undo to put back the conflicts of these files. */
  write(repo: Repo, op: GitOp, paths: string[]): Promise<boolean>;
  /** Whether the rules propose resolutions, and whether the language model can be asked. */
  settings(): { rules: boolean; ai: boolean };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The tab where what is proposed for the conflicts of a repository is looked at, accepted all at once or one by one,
 * and written. The rules propose first; the language model is asked about the others when the user wants it.
 */
export class ConflictReviewTab implements vscode.Disposable {
  readonly panel: vscode.WebviewPanel;
  /** Kept apart from the panel, which no longer gives it once it is closed. */
  readonly webview: vscode.Webview;
  private plans: ConflictPlan[] = [];
  private others: string[] = [];
  private operation: Operation | null = null;
  private report: ReviewReport | null = null;
  /** How many files of the repository are in conflict, in the review or not. */
  private conflicted = 0;
  private error: string | undefined;
  /** Where each question to the language model is, by file and fingerprint of the conflict. */
  private readonly asking = new Map<string, Asking>();
  private readonly queue: { path: string; print: string }[] = [];
  private running = 0;
  private cancel?: vscode.CancellationTokenSource;
  private timer?: NodeJS.Timeout;
  private reading?: Promise<void>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly host: ReviewHost,
    readonly repo: Repo,
    /** The files the review is of, or all the files in conflict. */
    private paths: string[] | undefined,
    onDispose: () => void,
  ) {
    this.panel = vscode.window.createWebviewPanel('gitardo.conflicts', `Conflicts · ${path.basename(repo.root)}`, vscode.ViewColumn.Active, {
      retainContextWhenHidden: true,
    });
    this.webview = this.panel.webview;
    this.disposables.push(
      host.attach(this.webview, 'conflicts', { root: repo.root }),
      answers.onDidChange((root) => samePath(root, repo.root) && this.schedule()),
    );
    this.panel.onDidDispose(() => {
      this.stop();
      clearTimeout(this.timer);
      this.disposables.forEach((disposable) => disposable.dispose());
      onDispose();
    });
  }

  /** Shows the tab again, of other files when `paths` says so. */
  reveal(paths: string[] | undefined): void {
    if (paths) this.paths = paths;
    this.panel.reveal();
    void this.reload();
  }

  dispose(): void {
    this.panel.dispose();
  }

  /** Reads the files in conflict again, and sends the tab what it shows. */
  reload(): Promise<void> {
    // One read at a time: a second one asked for while one runs follows it.
    const next = (this.reading ?? Promise.resolve()).then(() => this.read());
    this.reading = next.finally(() => {
      if (this.reading === next) this.reading = undefined;
    });
    return next;
  }

  private async read(): Promise<void> {
    try {
      const conflicted = await this.repo.conflicted();
      const files = this.paths ? conflicted.filter((file) => this.paths?.includes(file)) : conflicted;
      this.plans = await this.repo.conflictPlans(files);
      this.others = files.filter((file) => !this.plans.some((plan) => plan.path === file));
      this.operation = await this.repo.operation().catch(() => null);
      this.conflicted = conflicted.length;
      this.error = undefined;
    } catch (error) {
      this.error = errorText(error);
    }
    this.send();
  }

  /** What the tab shows, from the files as they were read last. */
  private review(): ConflictReview {
    const { rules, ai } = this.host.settings();
    const [oursLabel, theirsLabel] = CONFLICT_SIDES[this.operation ?? 'none'];
    const asked = {
      answer: (file: string, print: string) => answers.get(this.repo.root, file, print),
      asking: (file: string, print: string) => this.asking.get(`${file}\0${print}`),
    };
    return {
      root: this.repo.root,
      operation: this.operation,
      oursLabel,
      theirsLabel,
      files: reviewFiles(this.plans, rules, asked),
      others: this.others,
      rules,
      ai,
      asking: this.running > 0 || this.queue.length > 0,
      report: this.report,
      conflicted: this.conflicted,
    };
  }

  send(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.error !== undefined) return this.host.post({ type: 'review', review: null, error: this.error }, this.webview);
    this.host.post({ type: 'review', review: this.review() }, this.webview);
  }

  /** Sends the tab what it shows soon, once for many changes that come close together. */
  private schedule(): void {
    this.timer ??= setTimeout(() => this.send(), SEND_EVERY);
  }

  /** The proposals as they are now for these conflicts, by file. */
  private proposals(refs: ConflictRef[]): Map<string, Proposal[]> {
    const chosen = new Map<string, Proposal[]>();
    for (const file of this.review().files) {
      for (const conflict of file.conflicts) {
        if (!conflict.proposal || !refs.some((ref) => ref.path === file.path && ref.key === conflict.key)) continue;
        chosen.set(file.path, [...(chosen.get(file.path) ?? []), conflict.proposal]);
      }
    }
    return chosen;
  }

  /** Writes the proposals accepted, and says what that did. */
  async write(refs: ConflictRef[]): Promise<void> {
    await this.reading;
    const chosen = this.proposals(refs);
    const files = this.plans.map((plan) => ({ path: plan.path, text: plan.text, conflicts: plan.conflicts.length, proposals: chosen.get(plan.path) ?? [] }));
    let op: GitOp;
    try {
      op = writeResolutionsOp(files);
    } catch (error) {
      void vscode.window.showErrorMessage(`Gitardo: ${errorText(error)}`);
      return;
    }
    const written = files.filter((file) => file.proposals.length);
    const staged = op.commands.length ? op.commands[0].length - 2 : 0;
    if (!(await this.host.write(this.repo, op, written.map((file) => file.path)))) return this.reload();
    const all = written.flatMap((file) => file.proposals);
    this.report = { resolved: all.length, files: written.length, staged, fromAI: all.filter((proposal) => proposal.source === 'ai').length };
    await this.reload();
  }

  /** Shows each file beside what the proposals accepted would make of it. */
  async preview(refs: ConflictRef[]): Promise<void> {
    await this.reading;
    const chosen = this.proposals(refs);
    const resources = this.plans
      .filter((plan) => chosen.has(plan.path))
      .map((plan) => {
        const onDisk = vscode.Uri.file(path.join(this.repo.root, plan.path));
        return [onDisk, onDisk, proposalUri(this.repo.root, plan.path, applyReplacements(plan.text, chosen.get(plan.path) ?? []))];
      });
    if (resources.length) await vscode.commands.executeCommand('vscode.changes', 'Conflicts resolved as accepted', resources);
  }

  /** Asks the language model about these conflicts, or about all the ones that have nothing proposed. */
  async ask(refs?: ConflictRef[]): Promise<void> {
    await this.reading;
    if (!this.host.settings().ai) {
      void vscode.window
        .showInformationMessage('Gitardo: resolving conflicts with AI is experimental, and it is switched off in the settings.', 'Open Settings')
        .then((choice) => choice && vscode.commands.executeCommand('workbench.action.openSettings', 'gitardo.conflicts.ai'));
      return;
    }
    this.report = null;
    for (const file of this.review().files) {
      for (const conflict of file.conflicts) {
        const wanted = refs ? refs.some((ref) => ref.path === file.path && ref.key === conflict.key) : !conflict.proposal;
        // What the rules resolve, they resolve without inventing a line: the model is not asked about it.
        if (!wanted || conflict.proposal?.source === 'rules') continue;
        const print = conflict.key.slice(conflict.key.indexOf(':') + 1);
        const id = `${file.path}\0${print}`;
        if (this.queue.some((job) => `${job.path}\0${job.print}` === id) || this.asking.get(id)?.state === 'thinking') continue;
        // Asked again: the answer before gives way to the new one.
        answers.delete(this.repo.root, file.path, print);
        this.asking.set(id, { state: 'waiting' });
        this.queue.push({ path: file.path, print });
      }
    }
    this.cancel ??= new vscode.CancellationTokenSource();
    this.send();
    while (this.running < AT_ONCE && this.queue.length) void this.next(this.cancel.token);
  }

  /** Stops the questions under way, and drops the ones waiting. */
  stop(): void {
    this.cancel?.cancel();
    this.cancel?.dispose();
    this.cancel = undefined;
    for (const job of this.queue.splice(0)) this.asking.delete(`${job.path}\0${job.print}`);
    for (const [id, asking] of this.asking) if (asking.state !== 'failed') this.asking.delete(id);
    this.schedule();
  }

  /** Asks the next question waiting, and the ones after it. */
  private async next(token: vscode.CancellationToken): Promise<void> {
    const job = this.queue.shift();
    if (!job) return;
    this.running++;
    const id = `${job.path}\0${job.print}`;
    try {
      const plan = this.plans.find((each) => each.path === job.path);
      const conflict = plan?.conflicts.find((each) => fingerprint(plan.text, each) === job.print);
      if (!plan || !conflict) throw new Error('The conflict is no longer in the file.');
      const [current, incoming] = CONFLICT_SIDES[this.operation ?? 'none'];
      const [oursSubject, theirsSubject] = await this.repo.conflictSubjects();
      const question = { path: plan.path, oursLabel: current, theirsLabel: incoming, oursSubject, theirsSubject, ...questionParts(plan.text, conflict) };
      this.asking.set(id, { state: 'thinking', text: '' });
      this.schedule();
      const answer = await askResolution(question, token, (text) => {
        if (token.isCancellationRequested) return;
        this.asking.set(id, { state: 'thinking', text: partialResolution(text) });
        this.schedule();
      });
      if (token.isCancellationRequested) return;
      this.asking.delete(id);
      answers.set(this.repo.root, job.path, job.print, answer);
    } catch (error) {
      if (token.isCancellationRequested) this.asking.delete(id);
      else this.asking.set(id, { state: 'failed', error: errorText(error) });
    } finally {
      this.running--;
      this.schedule();
      if (!token.isCancellationRequested) void this.next(token);
    }
  }
}
