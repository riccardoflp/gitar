// End-to-end checks that run inside a real Extension Host, against the repositories test/e2e/run.mjs prepared.
// They drive the extension through its commands and its controller, with VS Code's prompts answered by stubs.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CONFLICT, INDEX, contentUri } from '../../src/extension/content';
import type { GitardoApi } from '../../src/extension/extension';
import { type DiffDescriptor, describeDiff } from '../../src/flow/sides';
import { git } from '../../src/git/exec';
import { samePath } from '../../src/git/parse';
import { Repo } from '../../src/git/repo';
import { WORKTREE, type CompareMode, type CompareSide, type Filter, type HostMessage, type RebaseStep, type RepoState, type ViewKind, type WebviewMessage } from '../../src/shared/protocol';
import type { ConflictReview } from '../../src/shared/resolution';

/** The parts of the controller that are private to everyone but these tests. */
interface Internals {
  state: RepoState | null;
  /** How many commits are asked of git, and what narrows them. */
  limit: number;
  filter: Filter | null;
  views: Map<unknown, ViewKind>;
  compareTabs: Map<unknown, CompareTab>;
  github: { owner: string; repo: string } | null;
  githubRemote: string | null;
  onMessage(webview: unknown, message: WebviewMessage): Promise<void>;
  post(message: HostMessage, to?: unknown): void;
  scheduleRefresh(cause: string, delay?: number): void;
}

/** A comparison open in a tab, as the controller keeps it. */
interface CompareTab {
  panel: vscode.WebviewPanel;
  from: CompareSide;
  to: CompareSide;
  mode: CompareMode;
  path: string | null;
}

interface Result {
  name: string;
  ok: boolean;
  error?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, check: () => T | undefined | null | false, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** The API of VS Code's Git extension, which opens worktrees as repositories of their own. */
interface VSCodeGitApi {
  repositories: { rootUri: vscode.Uri }[];
  openRepository(root: vscode.Uri): Promise<unknown>;
}

async function vscodeGit(): Promise<VSCodeGitApi> {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): VSCodeGitApi }>('vscode.git');
  assert.ok(extension, "VS Code's Git extension");
  return (await extension.activate()).getAPI(1);
}

export async function run(): Promise<void> {
  const results: Result[] = [];
  const report = () => {
    const file = process.env.GITARDO_E2E_RESULTS;
    if (file) fs.writeFileSync(file, JSON.stringify(results, null, 2));
  };
  const step = async (name: string, body: () => Promise<void>) => {
    try {
      await body();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    }
    report();
  };

  const workspace = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const app = path.join(workspace, 'app');
  const lib = path.join(workspace, 'lib');
  const write = (file: string, content: string) => fs.writeFileSync(path.join(app, file), content);

  // By its name, whoever publishes it.
  const extension = vscode.extensions.all.find((candidate) => candidate.packageJSON.name === 'gitardo') as vscode.Extension<GitardoApi> | undefined;
  assert.ok(extension, 'the extension is installed');
  const { controller, log, fileBlame, flowDiff } = await extension.activate();
  const internals = controller as unknown as Internals;
  const state = () => {
    assert.ok(internals.state, 'a repository is loaded');
    return internals.state;
  };
  const subjects = () => state().rows.map((row) => row.subject);

  // Everything the webviews say to the extension, and the extension to them.
  const received: WebviewMessage[] = [];
  const posted: HostMessage[] = [];
  /** The view each of them was for, or nothing when it was for all. */
  const addressed: unknown[] = [];
  /** What the views ask that a step wants left unanswered for a while. */
  const unanswered = new Set<WebviewMessage['type']>();
  const onMessage = internals.onMessage.bind(controller);
  internals.onMessage = (webview, message) => {
    received.push(message);
    return unanswered.has(message.type) ? Promise.resolve() : onMessage(webview, message);
  };
  const post = internals.post.bind(controller);
  internals.post = (message, to) => {
    posted.push(message);
    addressed.push(to);
    post(message, to);
  };
  const fromWebview = (message: WebviewMessage) => internals.onMessage([...internals.views.keys()][0], message);
  const kinds = () => [...internals.views.values()].sort();
  const view = (kind: ViewKind) => {
    const found = [...internals.views.entries()].find(([, candidate]) => candidate === kind);
    assert.ok(found, `the ${kind} view is open`);
    return found[0] as vscode.Webview;
  };

  // The command log, which must show every command exactly as it was run.
  const logged: string[] = [];
  const logInfo = log.info.bind(log);
  log.info = (message: string, ...rest: unknown[]) => {
    logged.push(message);
    logInfo(message, ...rest);
  };

  // What the extension logs as an error, and shows as one.
  const errors: string[] = [];
  const logError = log.error.bind(log);
  log.error = (message: string | Error, ...rest: unknown[]) => {
    errors.push(String(message));
    logError(message, ...rest);
  };

  /** What the tab of the review of the conflicts was sent last. */
  const lastReview = () => posted.reduce<ConflictReview | null | undefined>((last, message) => (message.type === 'review' ? message.review : last), undefined);

  // Prompts are answered by these, which each test sets as it needs.
  const ui = vscode.window as unknown as Record<string, (...args: never[]) => unknown>;
  const asked: { message: string; detail: string; items: string[] }[] = [];
  let answer: (message: string, detail: string, items: string[]) => string | undefined = () => undefined;
  const run = (_message: string, _detail: string, items: string[]) => (items.includes('Run') ? 'Run' : undefined);
  const message = (text: string, ...rest: unknown[]) => {
    const options = typeof rest[0] === 'object' && rest[0] !== null ? (rest.shift() as { detail?: string }) : {};
    const items = rest as string[];
    asked.push({ message: text, detail: options.detail ?? '', items });
    return Promise.resolve(answer(text, options.detail ?? '', items));
  };
  ui.showInformationMessage = message as never;
  ui.showWarningMessage = message as never;
  ui.showErrorMessage = ((text: string) => {
    errors.push(text);
    return Promise.resolve(undefined);
  }) as never;
  let inputs: string[] = [];
  ui.showInputBox = (() => Promise.resolve(inputs.shift())) as never;
  type Item = vscode.QuickPickItem;
  let choose: (items: Item[], options: vscode.QuickPickOptions) => Item | Item[] | undefined = () => undefined;
  ui.showQuickPick = ((items: Item[], options: vscode.QuickPickOptions = {}) => Promise.resolve(choose(items, options))) as never;
  const byLabel = (label: string | RegExp) => (items: Item[]) => {
    const found = items.find((item) => (typeof label === 'string' ? item.label === label : label.test(item.label)));
    assert.ok(found, `"${label}" is among ${items.map((item) => item.label).join(', ')}`);
    return found;
  };

  await step('registers every command it contributes', async () => {
    const contributed = (extension.packageJSON.contributes.commands as { command: string }[]).map((entry) => entry.command);
    const registered = new Set(await vscode.commands.getCommands(true));
    assert.deepEqual(
      contributed.filter((command) => !registered.has(command)),
      [],
    );
    assert.ok(contributed.length >= 20);
  });

  await step('the graph view loads its UI and gets the state of the first repository', async () => {
    await vscode.commands.executeCommand('gitardo.openGraph');
    // The UI says `ready` once React has mounted, which proves the bundle ran under the content security policy.
    await until('the graph webview to say it is ready', () => received.some((incoming) => incoming.type === 'ready'));
    await until('the repository state', () => internals.state);
    assert.equal(state().name, 'app');
    assert.equal(state().branch, 'main');
    assert.deepEqual(subjects(), ['Add feature', 'Change a', 'Add b', 'Add a']);
    assert.deepEqual(
      state().repos.map((repo) => repo.name),
      ['workspace/app', 'workspace/lib'],
    );
    assert.deepEqual([...internals.views.values()], ['graph']);
  });

  await step('the five views of the side bar load too, and the graph opens as an editor tab', async () => {
    const before = received.filter((incoming) => incoming.type === 'ready').length;
    // The stashes start folded, and a folded view is not loaded: its command unfolds it.
    for (const name of ['Changes', 'Commits', 'SideGraph', 'Branches', 'Stashes']) await vscode.commands.executeCommand(`gitardo.open${name}`);
    await until('the webviews of the side bar', () => kinds().join() === 'branches,changes,commits,graph,sideGraph,stashes');
    await vscode.commands.executeCommand('gitardo.openInEditor');
    await until('the new webviews to say they are ready', () => received.filter((incoming) => incoming.type === 'ready').length >= before + 6);
    assert.deepEqual(kinds(), ['branches', 'changes', 'commits', 'graph', 'graph', 'sideGraph', 'stashes']);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await until('the editor tab to detach', () => internals.views.size === 6);
  });

  await step('notices commits and files that come from outside the editor', async () => {
    await git(app, ['commit', '--allow-empty', '-m', 'From the terminal']);
    await until('the new commit', () => subjects()[0] === 'From the terminal');
    write('outside.txt', 'written by another program\n');
    await until('the new file', () => state().changes === 1);
    assert.equal(state().rows[0].subject, 'Uncommitted changes (1)');
  });

  await step('stages and commits without asking when the preview is off', async () => {
    asked.length = 0;
    await controller.action({ kind: 'stageAll' });
    assert.deepEqual(state().working.staged, [{ status: 'A', path: 'outside.txt' }]);
    await controller.action({ kind: 'commit', message: 'Add a file', amend: false });
    assert.equal(subjects()[0], 'Add a file');
    assert.equal(state().changes, 0);
    assert.ok(posted.some((outgoing) => outgoing.type === 'committed'));
    assert.deepEqual(asked, []);
  });

  await step('shows the exact commands and waits when the preview is on', async () => {
    await vscode.workspace.getConfiguration('gitardo').update('commandPreview', 'all', vscode.ConfigurationTarget.Global);
    try {
      write('a.txt', 'one\ntwo\nthree\n');
      await vscode.commands.executeCommand('gitardo.refresh');
      asked.length = 0;
      // Declined: nothing runs.
      answer = () => undefined;
      await controller.action({ kind: 'stage', paths: ['a.txt'] });
      assert.equal(state().working.staged.length, 0);
      assert.equal(asked.length, 1);
      assert.equal(asked[0].message, 'Stage a.txt?');
      assert.match(asked[0].detail, /git add -- a\.txt$/);
      assert.ok(asked[0].detail.includes(state().root));
      // Approved: it runs.
      assert.ok(!logged.includes('> git add -- a.txt'), 'nothing ran while the question was open');
      answer = run;
      await controller.action({ kind: 'stage', paths: ['a.txt'] });
      assert.equal(state().working.staged.length, 1);
      // What was shown is what ran, and what the log says ran.
      assert.ok(logged.includes('> git add -- a.txt'));
      await controller.action({ kind: 'unstageAll' });
    } finally {
      await vscode.workspace.getConfiguration('gitardo').update('commandPreview', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  await step('always asks before an operation that loses work', async () => {
    asked.length = 0;
    answer = () => undefined;
    await controller.action({ kind: 'discardAll' });
    assert.equal(asked.length, 1);
    assert.match(asked[0].detail, /will be lost[\s\S]*git restore -- a\.txt/);
    assert.equal(state().changes, 1);
    answer = run;
    await controller.action({ kind: 'discardAll' });
    assert.equal(state().changes, 0);
    assert.equal(fs.readFileSync(path.join(app, 'a.txt'), 'utf8'), 'one\ntwo\n');
  });

  await step('asks for names and options with input boxes and pickers', async () => {
    inputs = ['topic'];
    choose = byLabel('Create only');
    await controller.action({ kind: 'createBranch', at: 'HEAD' });
    assert.ok(state().branches.some((branch) => branch.name === 'topic' && !branch.current));

    inputs = ['v1', 'First release'];
    await controller.action({ kind: 'createTag', at: 'HEAD' });
    assert.deepEqual(
      state().tags.map((tag) => tag.name),
      ['v1'],
    );

    // Backing out of a prompt does nothing.
    inputs = [];
    await controller.action({ kind: 'createBranch', at: 'HEAD' });
    assert.equal(state().branches.length, 4);
  });

  await step('creates a worktree by name, renames it with its branch and removes both', async () => {
    const branches = state().branches.length;
    const home = path.join(workspace, 'app.worktrees').replace(/\\/g, '/');
    assert.equal(typeof state().agentsWindow, 'boolean');
    try {
      asked.length = 0;
      answer = () => undefined;
      inputs = ['agents/first'];
      choose = byLabel('main');
      await controller.action({ kind: 'worktreeAdd' });
      const created = state().worktrees.find((worktree) => worktree.branch === 'agents/first');
      assert.ok(created, JSON.stringify(state().worktrees));
      // A folder in a folder, as the name of the branch has it.
      assert.equal(created.path.toLowerCase(), `${home}/agents/first`.toLowerCase());
      // The views name it by its path from there.
      assert.equal(state().worktreesRoot?.toLowerCase(), home.toLowerCase());
      assert.ok(!created.main && !created.current);
      assert.ok(state().worktrees.find((worktree) => worktree.current)?.main);
      // It offers to open it, in the Agents window where VS Code has one, and this first time to choose what new worktrees get.
      const offer = await until('the offer to open it', () => asked.find((question) => /^Worktree created in /.test(question.message)));
      assert.deepEqual(offer.items, [...(state().agentsWindow ? ['Open in Agents Window'] : []), 'Open in New Window', 'Choose What It Gets…']);

      // Renamed, with the branch taking the name as it was typed.
      inputs = ['agents-two', 'agents-two'];
      choose = byLabel('Rename the branch agents/first too');
      await controller.action({ kind: 'worktreeRename', path: created.path });
      const renamed = state().worktrees.find((worktree) => worktree.branch === 'agents-two');
      assert.ok(renamed, JSON.stringify(state().worktrees));
      assert.equal(renamed.path.toLowerCase(), `${home}/agents-two`.toLowerCase());
      assert.ok(!fs.existsSync(created.path));
      // The folder that held only it went with it.
      assert.ok(!fs.existsSync(`${home}/agents`));

      // The main worktree cannot be renamed, which is said rather than tried.
      errors.length = 0;
      await controller.action({ kind: 'worktreeRename', path: state().worktrees.find((worktree) => worktree.main)!.path });
      assert.ok(errors.some((text) => /cannot move the main worktree/.test(text)), JSON.stringify(errors));
      errors.length = 0;

      // Removed with its branch, which is merged: it was made from main and has nothing of its own.
      choose = byLabel(/and delete agents-two/);
      answer = run;
      await controller.action({ kind: 'worktreeRemove', path: renamed.path });
      assert.equal(state().worktrees.length, 1);
      assert.equal(state().branches.length, branches);
      assert.ok(!fs.existsSync(renamed.path));
    } finally {
      answer = () => undefined;
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });

  await step('names a new branch from the format, at the branch checked out, a tag or a commit, or as it is typed', async () => {
    const config = vscode.workspace.getConfiguration('gitardo');
    const global = vscode.ConfigurationTarget.Global;
    // Answers to the input boxes, where KEEP takes what the box proposes, and the labels to pick in turn.
    const KEEP = Symbol('keep');
    let typed: (string | typeof KEEP)[] = [];
    const showInputBox = ui.showInputBox;
    ui.showInputBox = ((options: vscode.InputBoxOptions = {}) => {
      const next = typed.shift();
      return Promise.resolve(next === KEEP ? options.value : next);
    }) as never;
    let picks: (string | RegExp)[] = [];
    choose = (items) => byLabel(picks.shift()!)(items);
    const made: string[] = [];
    const created = (name: string) => {
      made.push(name);
      assert.ok(
        state().branches.some((branch) => branch.name === name && !branch.current),
        JSON.stringify(state().branches.map((branch) => branch.name)),
      );
    };
    await config.update('branches.format', '${input:kind}/${base}-${input:ticket}', global);
    await config.update(
      'branches.inputs',
      [
        { id: 'ticket', type: 'promptString', description: 'Ticket number', pattern: '^\\d+$' },
        { id: 'kind', type: 'pickString', description: 'Type of change', options: ['feat', 'fix'] },
      ],
      global,
    );
    try {
      // From the toolbar, ${base} is the branch checked out.
      picks = ['Use the format', 'feat', 'Create only'];
      typed = ['1', KEEP];
      await controller.action({ kind: 'createBranch', at: 'HEAD' });
      created('feat/main-1');

      // On a tag, the tag; the ticket used last is proposed.
      picks = ['Use the format', 'fix', 'Create only'];
      typed = [KEEP, KEEP];
      await controller.action({ kind: 'createBranch', at: 'v1' });
      created('fix/v1-1');

      // At a commit, the commit or one of the branches that have it.
      const short = state().head!.slice(0, 7);
      picks = ['Use the format', short, 'feat', 'Create only'];
      typed = ['2', KEEP];
      await controller.action({ kind: 'createBranch', at: state().head! });
      created(`feat/${short}-2`);

      // Or the name is typed, as without a format.
      picks = ['Type a branch name', 'Create only'];
      typed = ['typed-branch'];
      await controller.action({ kind: 'createBranch', at: 'HEAD' });
      created('typed-branch');

      // The settings the format had before, among the worktrees, are still read where the new ones are not set.
      await config.update('branches.format', undefined, global);
      await config.update('branches.inputs', undefined, global);
      await config.update('worktrees.branchFormat', 'old-${input:ticket}', global);
      await config.update('worktrees.inputs', [{ id: 'ticket', type: 'promptString' }], global);
      picks = ['Use the format', 'Create only'];
      typed = ['3', KEEP];
      await controller.action({ kind: 'createBranch', at: 'HEAD' });
      created('old-3');
    } finally {
      ui.showInputBox = showInputBox;
      choose = () => undefined;
      for (const key of ['branches.format', 'branches.inputs', 'worktrees.branchFormat', 'worktrees.inputs']) await config.update(key, undefined, global);
      if (made.length) await git(app, ['branch', '-D', ...made]);
      await vscode.commands.executeCommand('gitardo.refresh');
    }
  });

  await step('names the branch of a new worktree from the format, asking for its inputs, or as it is typed', async () => {
    const config = vscode.workspace.getConfiguration('gitardo');
    const home = path.join(workspace, 'app.worktrees').replace(/\\/g, '/');
    const branches = state().branches.length;
    // Answers to the input boxes, where KEEP takes what the box proposes, and the labels to pick in turn.
    const KEEP = Symbol('keep');
    let typed: (string | typeof KEEP)[] = [];
    const proposed: string[] = [];
    const showInputBox = ui.showInputBox;
    ui.showInputBox = ((options: vscode.InputBoxOptions = {}) => {
      proposed.push(options.value ?? '');
      const next = typed.shift();
      return Promise.resolve(next === KEEP ? options.value : next);
    }) as never;
    let picks: (string | RegExp)[] = [];
    const titles: string[] = [];
    choose = (items, options) => {
      titles.push(options.title ?? '');
      return byLabel(picks.shift()!)(items);
    };
    await config.update('branches.format', 'PRJ-${input:ticket}-${input:kind}-rfi-${base}', vscode.ConfigurationTarget.Global);
    await config.update(
      'branches.inputs',
      [
        { id: 'ticket', type: 'promptString', description: 'Ticket number', pattern: '^\\d+$' },
        { id: 'kind', type: 'pickString', description: 'Type of change', options: ['feat', 'fix'], allowCustom: true },
      ],
      vscode.ConfigurationTarget.Global,
    );
    try {
      answer = () => undefined;
      // The format, picked first, from main: the ticket typed, the kind picked, and the name it makes kept.
      picks = ['Use the format', 'main', 'fix'];
      typed = ['123', KEEP];
      await controller.action({ kind: 'worktreeAdd' });
      const made = state().worktrees.find((worktree) => worktree.branch === 'PRJ-123-fix-rfi-main');
      assert.ok(made, JSON.stringify(state().worktrees));
      assert.equal(made.path.toLowerCase(), `${home}/PRJ-123-fix-rfi-main`.toLowerCase());

      // From a remote branch, ${base} has no remote; the ticket used last is proposed, and a kind can be typed.
      picks = ['Use the format', 'origin/main', 'Type another value…'];
      proposed.length = 0;
      typed = [KEEP, 'hotfix', KEEP];
      await controller.action({ kind: 'worktreeAdd' });
      assert.equal(proposed[0], '123');
      assert.ok(state().worktrees.some((worktree) => worktree.branch === 'PRJ-123-hotfix-rfi-main'), JSON.stringify(state().worktrees));

      // A typed ticket that is not a number is refused.
      errors.length = 0;
      picks = ['Use the format', 'main'];
      typed = ['12a'];
      await controller.action({ kind: 'worktreeAdd' });
      assert.ok(errors.some((text) => /Ticket number: It has to match/.test(text)), JSON.stringify(errors));
      errors.length = 0;

      // At a commit, ${base} is the commit or one of the branches that have it.
      const head = state().head!;
      picks = ['Use the format', head.slice(0, 7), 'feat'];
      typed = ['7', KEEP];
      await controller.action({ kind: 'worktreeAdd', ref: head, isBranch: false });
      assert.ok(state().worktrees.some((worktree) => worktree.branch === `PRJ-7-feat-rfi-${head.slice(0, 7)}`), JSON.stringify(state().worktrees));
      assert.ok(titles.includes(`Create worktree at ${head.slice(0, 7)}: what \${base} is`), JSON.stringify(titles));

      // Or the name is typed, as without a format.
      picks = ['Type a branch name', 'main'];
      typed = ['typed/name'];
      await controller.action({ kind: 'worktreeAdd' });
      assert.ok(state().worktrees.some((worktree) => worktree.branch === 'typed/name'), JSON.stringify(state().worktrees));

      // On a branch, the branch itself, in a folder of its name, or a new branch from the format.
      await git(app, ['branch', 'side/work']);
      await vscode.commands.executeCommand('gitardo.refresh');
      picks = ['Use the branch side/work'];
      typed = [KEEP];
      await controller.action({ kind: 'worktreeAdd', ref: 'side/work', isBranch: true });
      const side = state().worktrees.find((worktree) => worktree.branch === 'side/work');
      assert.ok(side, JSON.stringify(state().worktrees));
      assert.equal(side.path.toLowerCase(), `${home}/side/work`.toLowerCase());

      // Removed from the menu of its branch, which says whether the branch goes too: here it stays, without a question.
      answer = run;
      picks = [];
      await controller.action({ kind: 'worktreeRemove', path: side.path, deleteBranch: false });
      assert.ok(!state().worktrees.some((worktree) => worktree.branch === 'side/work'));
      assert.ok(state().branches.some((branch) => branch.name === 'side/work'));
      assert.ok(!fs.existsSync(`${home}/side`), 'the folder that held only it went too');
      answer = () => undefined;
    } finally {
      ui.showInputBox = showInputBox;
      choose = () => undefined;
      await config.update('branches.format', undefined, vscode.ConfigurationTarget.Global);
      await config.update('branches.inputs', undefined, vscode.ConfigurationTarget.Global);
      // Windows can hold a folder that was just made for a moment: it is deleted with retries, and git forgets it after.
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      await git(app, ['worktree', 'prune']);
      const made = (await git(app, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).stdout.split('\n');
      for (const branch of made) {
        if (/^(PRJ-|typed\/|side\/)/.test(branch)) await git(app, ['branch', '-D', branch]);
      }
      await vscode.commands.executeCommand('gitardo.refresh');
      fs.rmSync(home, { recursive: true, force: true });
    }
    assert.equal(state().branches.length, branches);
    assert.equal(state().worktrees.length, 1);
  });

  await step('links and copies into a new worktree what the settings of VS Code ask, and unlinks before removing it', async () => {
    const config = vscode.workspace.getConfiguration('git');
    const home = path.join(workspace, 'app.worktrees').replace(/\\/g, '/');
    const exclude = path.join(app, '.git', 'info', 'exclude');
    const excluded = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : null;
    const branches = state().branches.length;
    let made: string | undefined;
    // Ignored through the repository's own exclude file, which leaves what is committed alone.
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(exclude, `${excluded ?? ''}\nnode_modules/\n.env\n`);
    fs.mkdirSync(path.join(app, 'node_modules', 'pkg'), { recursive: true });
    write('node_modules/pkg/index.js', 'module\n');
    write('.env', 'SECRET=1\n');
    await config.update('worktreeSymlinkFolders', ['node_modules'], vscode.ConfigurationTarget.Global);
    await config.update('worktreeIncludeFiles', ['.env'], vscode.ConfigurationTarget.Global);
    try {
      logged.length = 0;
      answer = () => undefined;
      inputs = ['linked/one'];
      choose = byLabel('main');
      await controller.action({ kind: 'worktreeAdd' });
      made = state().worktrees.find((worktree) => worktree.branch === 'linked/one')?.path;
      assert.ok(made, JSON.stringify(state().worktrees));
      // After git made it, each one said in the log as it is made.
      const steps = logged.filter((line) => line.startsWith('> '));
      assert.match(steps[0], /^> git worktree add /);
      assert.deepEqual(steps.slice(1), ['> symlink node_modules', '> copy .env']);
      assert.ok(fs.lstatSync(path.join(made, 'node_modules')).isSymbolicLink());
      assert.equal(fs.readFileSync(path.join(made, 'node_modules/pkg/index.js'), 'utf8'), 'module\n');
      assert.ok(!fs.lstatSync(path.join(made, '.env')).isSymbolicLink());
      assert.equal(fs.readFileSync(path.join(made, '.env'), 'utf8'), 'SECRET=1\n');

      // VS Code's Git extension opens worktrees as repositories, and watches their folders, which Windows then keeps:
      // it closes this one first.
      const vscodeRepos = await vscodeGit();
      await vscodeRepos.openRepository(vscode.Uri.file(made));
      const openInGit = () => vscodeRepos.repositories.some((repository) => samePath(repository.rootUri.fsPath, made!));
      await until('the worktree open in VS Code', () => openInGit());
      // Git for Windows would delete what is in the junction with the worktree, in this checkout: it goes first.
      logged.length = 0;
      answer = run;
      await controller.action({ kind: 'worktreeRemove', path: made, deleteBranch: true });
      const removal = logged.filter((line) => /^> (git\.close|unlink|git worktree remove) /.test(line)).map((line) => line.toLowerCase());
      const unlinked = process.platform === 'win32' ? [`> unlink ${made}/node_modules`] : [];
      assert.deepEqual(removal, [`> git.close ${made}`, ...unlinked, `> git worktree remove ${made}`].map((line) => line.toLowerCase()));
      assert.ok(!openInGit());
      assert.ok(!state().worktrees.some((worktree) => worktree.branch === 'linked/one'));
      assert.ok(!fs.existsSync(made), JSON.stringify({ logged, errors }));
      assert.equal(fs.readFileSync(path.join(app, 'node_modules/pkg/index.js'), 'utf8'), 'module\n');
      assert.equal(state().branches.length, branches);
    } finally {
      answer = () => undefined;
      choose = () => undefined;
      await config.update('worktreeSymlinkFolders', undefined, vscode.ConfigurationTarget.Global);
      await config.update('worktreeIncludeFiles', undefined, vscode.ConfigurationTarget.Global);
      // The link goes before its folder does, so that nothing of this checkout goes with it.
      const link = made && path.join(made, 'node_modules');
      if (link && fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(link);
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      await git(app, ['worktree', 'prune']);
      await git(app, ['branch', '-D', 'linked/one']).catch(() => undefined);
      fs.rmSync(path.join(app, 'node_modules'), { recursive: true, force: true });
      fs.rmSync(path.join(app, '.env'), { force: true });
      if (excluded === null) fs.rmSync(exclude, { force: true });
      else fs.writeFileSync(exclude, excluded);
      await vscode.commands.executeCommand('gitardo.refresh');
    }
  });

  await step('chooses what new worktrees get in a tab of its own, saves it for the workspace folder, and brings it into worktrees', async () => {
    const gitardo = () => vscode.workspace.getConfiguration('gitardo', vscode.Uri.file(app));
    const exclude = path.join(app, '.git', 'info', 'exclude');
    const excluded = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : null;
    const home = path.join(workspace, 'app.worktrees').replace(/\\/g, '/');
    let made: string | undefined;
    fs.writeFileSync(exclude, `${excluded ?? ''}\nnode_modules/\n.env\n*.log\n`);
    fs.mkdirSync(path.join(app, 'node_modules', 'pkg'), { recursive: true });
    write('node_modules/pkg/index.js', 'module\n');
    write('.env', 'SECRET=2\n');
    write('build.log', 'not wanted\n');
    try {
      posted.length = 0;
      await vscode.commands.executeCommand('gitardo.worktreeSetup');
      const tab = (await until('the tab', () => [...internals.views].find(([, kind]) => kind === 'worktreeSetup')))[0];
      // The page asks for what it shows as it loads: what git ignores, each with what is proposed for it.
      type Setup = Extract<HostMessage, { type: 'worktreeSetup' }>;
      const shown = await until('what the tab shows', () => posted.find((message): message is Setup => message.type === 'worktreeSetup' && !!message.info));
      const proposed = Object.fromEntries(shown.info!.entries.map((entry) => [entry.path, entry.suggestion]));
      assert.deepEqual(proposed, { '.env': 'copy', 'build.log': 'none', node_modules: 'link' });
      assert.deepEqual(shown.info!.effective, { link: [], copy: [], linkFrom: 'none', copyFrom: 'none' });
      assert.equal(shown.info!.workspace?.name, path.basename(workspace));

      // What the patterns take, as the page asks while they are typed.
      const patterns = { link: ['node_modules/'], copy: ['/.env', '*.missing'] };
      await internals.onMessage(tab, { type: 'previewWorktreeSetup', patterns });
      type Preview = Extract<HostMessage, { type: 'worktreeSetupPreview' }>;
      // The page asks for its own as well, so the answer is the one to these patterns.
      const answered = (message: HostMessage): message is Preview =>
        message.type === 'worktreeSetupPreview' && JSON.stringify(message.patterns) === JSON.stringify(patterns);
      const preview = (await until('what the patterns take', () => posted.find(answered))).preview!;
      assert.deepEqual([preview.link, preview.copy, preview.counts.copy], [['node_modules'], ['.env'], { '/.env': 1, '*.missing': 0 }]);

      // Saved for the workspace folder: Gitardo's settings, which apply from then on.
      posted.length = 0;
      await internals.onMessage(tab, { type: 'saveWorktreeSetup', target: 'workspace', patterns });
      assert.deepEqual(gitardo().inspect('worktrees.linkFolders')?.workspaceFolderValue, ['node_modules/']);
      assert.deepEqual(gitardo().inspect('worktrees.copyFiles')?.workspaceFolderValue, ['/.env', '*.missing']);
      const saved = await until('the tab to show what is saved', () => posted.find((message): message is Setup => message.type === 'worktreeSetup' && !!message.info));
      assert.deepEqual([saved.info!.effective.linkFrom, saved.info!.effective.copyFrom], ['workspace', 'workspace']);

      // A new worktree gets it, and no longer offers to choose it.
      logged.length = 0;
      asked.length = 0;
      answer = () => undefined;
      inputs = ['setup/one'];
      choose = byLabel('main');
      await controller.action({ kind: 'worktreeAdd' });
      made = state().worktrees.find((worktree) => worktree.branch === 'setup/one')?.path;
      assert.ok(made, JSON.stringify(state().worktrees));
      assert.deepEqual(
        logged.filter((line) => line.startsWith('> ') && !line.startsWith('> git ')),
        ['> symlink node_modules', '> copy .env'],
      );
      assert.ok(!fs.existsSync(path.join(made, 'build.log')));
      const offer = await until('the offer to open it', () => asked.find((question) => /^Worktree created in /.test(question.message)));
      assert.ok(!offer.items.includes('Choose What It Gets…'), JSON.stringify(offer.items));

      // Brought again into it, from its context menu: only what it no longer has.
      fs.rmSync(path.join(made, '.env'));
      logged.length = 0;
      answer = run;
      await controller.action({ kind: 'worktreeSetUp', path: made });
      assert.equal(fs.readFileSync(path.join(made, '.env'), 'utf8'), 'SECRET=2\n');
      assert.ok(logged.includes('> copy .env'), JSON.stringify(logged));
      assert.ok(logged.includes('node_modules is in the worktree already.'), JSON.stringify(logged));

      await controller.action({ kind: 'worktreeRemove', path: made, deleteBranch: true });
      assert.ok(!fs.existsSync(made), JSON.stringify({ logged, errors }));
      assert.equal(fs.readFileSync(path.join(app, 'node_modules/pkg/index.js'), 'utf8'), 'module\n');

      // Taken out of the workspace folder, nothing is set there any more.
      await internals.onMessage(tab, { type: 'saveWorktreeSetup', target: 'workspace', patterns: null });
      assert.equal(gitardo().inspect('worktrees.linkFolders')?.workspaceFolderValue, undefined);
      assert.equal(gitardo().inspect('worktrees.copyFiles')?.workspaceFolderValue, undefined);
    } finally {
      answer = () => undefined;
      choose = () => undefined;
      await gitardo().update('worktrees.linkFolders', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      await gitardo().update('worktrees.copyFiles', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      const link = made && path.join(made, 'node_modules');
      if (link && fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(link);
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      await git(app, ['worktree', 'prune']);
      await git(app, ['branch', '-D', 'setup/one']).catch(() => undefined);
      for (const file of ['node_modules', '.env', 'build.log']) fs.rmSync(path.join(app, file), { recursive: true, force: true });
      if (excluded === null) fs.rmSync(exclude, { force: true });
      else fs.writeFileSync(exclude, excluded);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('gitardo.refresh');
    }
  });

  await step('shows another worktree in the views of this window, works in it there and goes back', async () => {
    const home = path.join(workspace, 'app.worktrees').replace(/\\/g, '/');
    const dir = `${home}/shown`;
    const same = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
    const branches = state().branches.length;
    const back = state().repos[0];
    await git(app, ['worktree', 'add', '-b', 'shown/one', dir, 'main']);
    await vscode.commands.executeCommand('gitardo.refresh');
    try {
      await controller.selectRepo(dir);
      assert.ok(same(state().root, dir), state().root);
      assert.equal(state().branch, 'shown/one');
      assert.deepEqual(state().home, back);
      // The window's own folder is listed as another worktree, which is neither renamed nor removed from here.
      const window = state().worktrees.find((worktree) => same(worktree.path, app));
      assert.ok(window && !window.current);
      errors.length = 0;
      await controller.action({ kind: 'worktreeRemove', path: window.path, deleteBranch: false });
      assert.ok(errors.some((text) => /folder open in this window/.test(text)), JSON.stringify(errors));
      errors.length = 0;

      // What is done in the views is done in that worktree.
      fs.writeFileSync(path.join(dir, 'shown.txt'), 'shown\n');
      await vscode.commands.executeCommand('gitardo.refresh');
      assert.deepEqual(state().working.unstaged.map((file) => file.path), ['shown.txt']);
      await controller.action({ kind: 'stage', paths: ['shown.txt'] });
      assert.equal((await git(dir, ['diff', '--cached', '--name-only'])).stdout.trim(), 'shown.txt');
      assert.equal((await git(app, ['diff', '--cached', '--name-only'])).stdout.trim(), '');

      // And back to the folder of the window.
      await controller.selectRepo(back.root);
      assert.equal(state().root, back.root);
      assert.equal(state().home, null);
    } finally {
      if (!same(state().root, back.root)) await controller.selectRepo(back.root);
      await git(app, ['worktree', 'remove', '--force', dir]).catch(() => undefined);
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      await git(app, ['worktree', 'prune']);
      await git(app, ['branch', '-D', 'shown/one']).catch(() => undefined);
      await vscode.commands.executeCommand('gitardo.refresh');
    }
    assert.equal(state().branches.length, branches);
    assert.equal(state().worktrees.length, 1);
  });

  await step('opens a branch in its worktree, made for it with nothing asked, and switches between worktrees', async () => {
    const home = path.join(workspace, 'app.worktrees').replace(/\\/g, '/');
    const branches = state().branches.length;
    // The windows that would open are only noted.
    const commands = vscode.commands as unknown as Record<string, (...args: unknown[]) => Thenable<unknown>>;
    const executeCommand = commands.executeCommand;
    const opened: string[] = [];
    commands.executeCommand = (id: unknown, ...args: unknown[]) => {
      if (id !== 'vscode.openFolder') return executeCommand(id, ...args);
      opened.push((args[0] as vscode.Uri).fsPath.replace(/\\/g, '/').toLowerCase());
      return Promise.resolve();
    };
    const head = state().head!;
    try {
      await git(app, ['push', 'origin', `${head}:refs/heads/remote/only`]);
      await vscode.commands.executeCommand('gitardo.refresh');
      assert.ok(state().remoteBranches.some((ref) => ref.name === 'origin/remote/only'));

      // A local branch: its worktree is made, named after it, and opened.
      asked.length = 0;
      await controller.action({ kind: 'openInWorktree', name: 'merged' });
      const merged = state().worktrees.find((worktree) => worktree.branch === 'merged');
      assert.ok(merged, JSON.stringify(state().worktrees));
      assert.equal(merged.path.toLowerCase(), `${home}/merged`.toLowerCase());
      await until('the worktree to open', () => opened.includes(`${home}/merged`.toLowerCase()));
      assert.equal(asked.length, 0, JSON.stringify(asked));

      // Again: it is there, so it only opens.
      opened.length = 0;
      await controller.action({ kind: 'openInWorktree', name: 'merged' });
      assert.deepEqual(opened, [`${home}/merged`.toLowerCase()]);
      assert.equal(state().worktrees.length, 2);

      // A remote branch: a local branch by its name tracks it there.
      await controller.action({ kind: 'openInWorktree', name: 'origin/remote/only', remote: true });
      const remote = state().worktrees.find((worktree) => worktree.branch === 'remote/only');
      assert.ok(remote, JSON.stringify(state().worktrees));
      assert.equal(remote.path.toLowerCase(), `${home}/remote/only`.toLowerCase());
      assert.equal(state().branches.find((branch) => branch.name === 'remote/only')?.upstream?.name, 'origin/remote/only');

      // The branch checked out here has no worktree to open.
      errors.length = 0;
      await controller.action({ kind: 'openInWorktree', name: state().branch! });
      assert.ok(errors.some((text) => /checked out in this window/.test(text)), JSON.stringify(errors));
      errors.length = 0;

      // What is not committed in a worktree is counted.
      fs.writeFileSync(path.join(merged.path, 'new.txt'), 'new\n');
      await vscode.commands.executeCommand('gitardo.refresh');
      assert.equal(state().worktrees.find((worktree) => worktree.branch === 'merged')?.changes, 1);

      // Switch Worktree lists them all with how they stand, the one of this window last, and creates another from there.
      opened.length = 0;
      let listed: string[] = [];
      let described: string[] = [];
      choose = (items) => {
        listed = items.map((item) => item.label);
        described = items.map((item) => item.description ?? '');
        return byLabel(/ merged$/)(items);
      };
      await vscode.commands.executeCommand('gitardo.switchWorktree');
      assert.deepEqual(listed, ['$(worktree) merged', '$(worktree) remote/only', '$(home) app', '', '$(add) Create worktree…']);
      assert.equal(described[0], 'merged · $(edit) 1');
      assert.match(described[2], / · this window$/);
      assert.deepEqual(opened, [`${home}/merged`.toLowerCase()]);
      opened.length = 0;
      choose = byLabel(/ app$/);
      await vscode.commands.executeCommand('gitardo.switchWorktree');
      assert.deepEqual(opened, []);
    } finally {
      commands.executeCommand = executeCommand;
      choose = () => undefined;
      // Each removal makes the views refresh, which runs `git status` in the other worktrees: on Windows a folder that a process
      // runs in cannot be deleted, so a removal can fail. What it leaves is deleted with retries and pruned below.
      for (const worktree of state().worktrees.filter((each) => !each.main)) {
        await git(app, ['worktree', 'remove', '--force', worktree.path]).catch(() => undefined);
      }
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      await git(app, ['worktree', 'prune']);
      await git(app, ['branch', '-D', 'remote/only']).catch(() => undefined);
      await git(app, ['push', 'origin', '--delete', 'remote/only']);
      await vscode.commands.executeCommand('gitardo.refresh');
    }
    assert.equal(state().branches.length, branches);
    assert.equal(state().worktrees.length, 1);
  });

  await step('serves file contents at a commit and in the index, and opens diffs', async () => {
    const head = state().head!;
    const at = async (ref: string) => (await vscode.workspace.openTextDocument(contentUri(state().root, ref, 'a.txt'))).getText();
    assert.equal(await at(head), 'one\ntwo\n');
    assert.equal(await at(state().rows.at(-1)!.hash), 'one\n');
    write('a.txt', 'one\ntwo\nstaged\n');
    await controller.action({ kind: 'stage', paths: ['a.txt'] });
    assert.equal(await at(INDEX), 'one\ntwo\nstaged\n');

    // The diffs of the changes view are VS Code's, served by its Git extension once it has the repository, so that its
    // own commands know them. A file with all of it staged shows HEAD against the index.
    const vscodeGit = vscode.extensions.getExtension<{ getAPI(version: 1): { repositories: { rootUri: vscode.Uri }[] } }>('vscode.git')!;
    await until("the repository in VS Code's Git", () =>
      vscodeGit.isActive && vscodeGit.exports.getAPI(1).repositories.some((repository) => samePath(repository.rootUri.fsPath, app)),
    );
    await fromWebview({ type: 'openDiff', source: { kind: 'change' }, file: { status: 'M', path: 'a.txt' } });
    const tab = await until('the diff editor', () => vscode.window.tabGroups.activeTabGroup.activeTab);
    assert.ok(tab.input instanceof vscode.TabInputTextDiff, 'a diff editor is open');
    assert.deepEqual([tab.input.original.scheme, JSON.parse(tab.input.original.query).ref], ['git', 'HEAD']);
    assert.deepEqual([tab.input.modified.scheme, JSON.parse(tab.input.modified.query).ref], ['git', '~']);
    assert.match(tab.label, /a\.txt \(Index\)/);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    // With changes not staged, the index against the file: VS Code's Stage Selected Ranges stages the lines selected.
    write('a.txt', 'one\ntwo\nstaged\nnot staged\n');
    await until('the change read', () => state().working.unstaged.some((file) => file.path === 'a.txt'));
    await fromWebview({ type: 'openDiff', source: { kind: 'change' }, file: { status: 'M', path: 'a.txt' } });
    const unstaged = await until('the diff editor', () => vscode.window.tabGroups.activeTabGroup.activeTab);
    assert.ok(unstaged.input instanceof vscode.TabInputTextDiff, 'a diff editor is open');
    assert.deepEqual([unstaged.input.original.scheme, JSON.parse(unstaged.input.original.query).ref], ['git', '~']);
    assert.equal((await vscode.workspace.openTextDocument(unstaged.input.original)).getText(), 'one\ntwo\nstaged\n');
    assert.equal(unstaged.input.modified.scheme, 'file');
    assert.match(unstaged.label, /a\.txt \(Working Tree\)/);
    const index = async () => (await git(app, ['show', ':a.txt'])).stdout;
    const editor = await until('the file in the diff editor', () =>
      vscode.window.activeTextEditor?.document.uri.fsPath === path.join(app, 'a.txt') ? vscode.window.activeTextEditor : undefined,
    );
    editor.selection = new vscode.Selection(3, 0, 3, 0);
    // The diff of the editor is worked out a moment after it opens: until then the command finds no change there.
    for (let tries = 0; ; tries++) {
      await vscode.commands.executeCommand('git.stageSelectedRanges');
      if ((await index()) === 'one\ntwo\nstaged\nnot staged\n') break;
      assert.ok(tries < 50, `the selected line staged: ${JSON.stringify(await index())}`);
      await sleep(200);
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    // A click in the changes view opens the file, or its diff when the settings say so; the button of the row, the file.
    const active = () => until('an editor', () => vscode.window.tabGroups.activeTabGroup.activeTab);
    await fromWebview({ type: 'openChange', file: { status: 'M', path: 'a.txt' } });
    const opened = await active();
    assert.ok(opened.input instanceof vscode.TabInputText && opened.input.uri.fsPath === path.join(app, 'a.txt'), 'the file is open');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.getConfiguration('gitardo').update('changes.openOnClick', 'diff', vscode.ConfigurationTarget.Global);
    try {
      await fromWebview({ type: 'openChange', file: { status: 'M', path: 'a.txt' } });
      assert.ok((await active()).input instanceof vscode.TabInputTextDiff, 'its diff is open');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fromWebview({ type: 'openFile', file: { status: 'M', path: 'a.txt' } });
      assert.ok((await active()).input instanceof vscode.TabInputText, 'the button opens the file');
    } finally {
      await vscode.workspace.getConfiguration('gitardo').update('changes.openOnClick', undefined, vscode.ConfigurationTarget.Global);
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await controller.action({ kind: 'unstageAll' });
    answer = run;
    await controller.action({ kind: 'discardAll' });
  });

  await step('switches a diff between the diff editor and the Flow Diff, which stages and unstages a change of it', async () => {
    interface Panel {
      descriptor: DiffDescriptor;
      currentModel: { chunks: { staged?: boolean }[] } | undefined;
      initSent: boolean;
      onMessage(message: { type: string; chunkId?: number }): void;
    }
    const index = async () => (await git(app, ['show', ':a.txt'])).stdout;
    const diffTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputTextDiff);
    write('a.txt', 'one\ntwo\nthree\n');
    try {
      await fromWebview({ type: 'openDiff', source: { kind: 'worktree' }, file: { status: 'M', path: 'a.txt' } });
      await until('the diff editor', () => diffTabs().length === 1);

      await vscode.commands.executeCommand('gitardo.openInFlowDiff');
      const panel = await until('the Flow Diff', () => flowDiff.panels()[0] as unknown as Panel | undefined);
      assert.equal(diffTabs().length, 0, 'the Flow Diff takes the place of the diff editor');
      // Gitardo names HEAD by its hash: it is HEAD again, which lets the index take part.
      assert.deepEqual(panel.descriptor.left, { kind: 'commit', ref: 'HEAD' });
      assert.deepEqual(panel.descriptor.right, { kind: 'worktree' });
      // The page says it is ready once its module ran, which proves the Monaco bundle loads under the content security policy.
      await until('the Flow Diff page to load', () => panel.initSent);

      panel.onMessage({ type: 'stageChunk', chunkId: 0 });
      await until('the change to show as staged', () => panel.currentModel?.chunks[0]?.staged === true);
      assert.equal(await index(), 'one\ntwo\nthree\n');
      // As Gitardo's own operations: in its log, exactly as it ran.
      assert.ok(logged.includes('> git apply --cached --unidiff-zero --whitespace=nowarn -'));

      panel.onMessage({ type: 'unstageChunk', chunkId: 0 });
      await until('the change to show as unstaged again', () => panel.currentModel?.chunks[0]?.staged === false);
      assert.equal(await index(), 'one\ntwo\n');

      await vscode.commands.executeCommand('gitardo.flowDiff.openInDiffEditor');
      const [tab] = await until('the diff editor again', () => (diffTabs().length ? diffTabs() : undefined));
      assert.equal(flowDiff.panels().length, 0);
      const input = tab.input as vscode.TabInputTextDiff;
      assert.equal(input.original.scheme, 'gitardo');
      assert.equal(input.modified.fsPath, path.join(app, 'a.txt'));

      // A diff of the Source Control view of VS Code: the index against the file.
      const fromGit = vscode.Uri.from({ scheme: 'git', path: input.modified.path, query: JSON.stringify({ path: input.modified.fsPath, ref: '~' }) });
      const described = await describeDiff(fromGit, input.modified);
      assert.deepEqual(described && { left: described.left, right: described.right, path: described.path }, {
        left: { kind: 'index' },
        right: { kind: 'worktree' },
        path: 'a.txt',
      });
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      answer = run;
      await controller.action({ kind: 'discardAll' });
    }
  });

  await step('answers the webviews: commit details and comparisons', async () => {
    const [newest, older] = state().rows;
    posted.length = 0;
    await fromWebview({ type: 'getDetail', hash: newest.hash });
    const detail = posted.find((outgoing) => outgoing.type === 'detail');
    assert.ok(detail?.type === 'detail' && detail.detail);
    assert.deepEqual(detail.detail.files, [{ status: 'A', path: 'outside.txt' }]);

    await fromWebview({ type: 'getComparison', from: state().rows.at(-1)!.hash, to: older.hash });
    const comparison = posted.find((outgoing) => outgoing.type === 'comparison');
    assert.ok(comparison?.type === 'comparison');
    assert.ok(comparison.comparison.files.some((file) => file.path === 'b.txt' && file.status === 'A'));
  });

  await step('gives the commits of the graph to the views that show it, and spares the others', async () => {
    const told = async (kind: ViewKind) => {
      const webview = view(kind);
      const sent: Extract<HostMessage, { type: 'state' }>[] = [];
      const postMessage = webview.postMessage.bind(webview);
      webview.postMessage = (outgoing: HostMessage) => {
        if (outgoing.type === 'state') sent.push(outgoing);
        return postMessage(outgoing);
      };
      try {
        // What a view says when it has just loaded, and has nothing.
        await internals.onMessage(webview, { type: 'ready' });
        return (await until(`the state for the ${kind} view`, () => sent.find((outgoing) => outgoing.state))).state!;
      } finally {
        webview.postMessage = postMessage;
      }
    };
    const commits = state().rows.length;
    assert.ok(commits >= 5);
    assert.equal((await told('sideGraph')).rows.length, commits);
    // The view of the commits asks for its own, which are not the ones of the graph.
    for (const kind of ['commits', 'branches', 'stashes', 'changes'] as const) {
      const seen = await told(kind);
      assert.deepEqual(seen.rows, [], `no commits for the ${kind} view`);
      assert.deepEqual(
        seen.branches.map((branch) => branch.name),
        ['feature', 'main', 'merged', 'topic'],
      );
    }
  });

  // The comparisons open in tabs.
  const tabs = () => [...internals.compareTabs.values()];
  /** The sides of the comparison opened last, and how it compares them. */
  const compared = () => {
    const tab = tabs().at(-1);
    return tab ? { from: tab.from, to: tab.to, mode: tab.mode } : null;
  };
  /** What the page of a comparison was told last, of what it shows or of its lines. */
  const told = <T extends 'compareView' | 'comparePatch' = 'compareView'>(tab: CompareTab, type = 'compareView' as T) => {
    for (let at = posted.length - 1; at >= 0; at--) {
      const outgoing = posted[at];
      if (outgoing.type === type && addressed[at] === tab.panel.webview) return outgoing as Extract<HostMessage, { type: T }>;
    }
  };
  const closeAll = async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await until('the tabs to close', () => tabs().length === 0);
  };
  const forget = () => {
    posted.length = 0;
    addressed.length = 0;
  };

  await step('compares branches, tags and typed revisions in a tab of their own, which follows the branches as they move', async () => {
    const head = state().head!;
    const hashOf = (name: string) => state().branches.find((branch) => branch.name === name)!.hash;
    const tag = state().tags[0];
    const revParse = async (revision: string) => (await git(app, ['rev-parse', revision])).stdout.trim();

    // The command: both sides are asked, and a tab shows how they compare.
    const titles: string[] = [];
    let offered: string[] = [];
    choose = (items, options) => {
      titles.push(options.title ?? '');
      offered = items.map((item) => item.label);
      return byLabel(titles.length === 1 ? '$(git-branch) feature' : '$(target) main')(items);
    };
    forget();
    await vscode.commands.executeCommand('gitardo.compare');
    assert.deepEqual(titles, ['Compare', 'Compare feature with']);
    // Everything but the side that is already chosen.
    assert.deepEqual(offered, [
      '$(edit) Enter a hash or a revision…',
      '$(target) main',
      '$(files) Working tree',
      'Branches',
      '$(git-branch) merged',
      '$(git-branch) topic',
      'Remote branches',
      '$(cloud) origin/main',
      'Tags',
      '$(tag) v1',
    ]);
    const tab = await until('the tab of the comparison', () => tabs()[0]);
    assert.equal(tab.panel.title, 'feature ↔ main');
    // The page is told the session of VS Code, for what it remembers only until VS Code is closed.
    assert.match(tab.panel.webview.html, new RegExp(`data-view="compare" data-session="${vscode.env.sessionId}" data-root="[^"]+" data-files="tree"`));
    // Two branches are followed, and compared from where they diverged.
    assert.deepEqual(compared(), {
      from: { name: 'feature', hash: hashOf('feature'), live: true },
      to: { name: 'main', hash: head, live: true },
      mode: 'diverged',
    });
    // The page asks for what it shows: how far apart the two are and the files that differ, then their lines.
    const base = (await git(app, ['merge-base', 'feature', 'main'])).stdout.trim();
    const [behind, ahead] = (await git(app, ['rev-list', '--left-right', '--count', 'feature...main'])).stdout.trim().split(/\s+/).map(Number);
    const shown = await until('the comparison', () => told(tab));
    assert.ok(shown.view);
    assert.deepEqual([shown.view.base, shown.view.since, shown.view.ahead, shown.view.behind], [base, base, ahead, behind]);
    // And the commits each has that the other has not, matched with the other side's.
    const onlyIn = (side: 'from' | 'to') => shown.view!.commits.filter((commit) => commit.side === side).map((commit) => commit.hash);
    const only = async (range: string) => (await git(app, ['rev-list', range])).stdout.trim().split('\n').filter(Boolean);
    assert.deepEqual(onlyIn('to').sort(), (await only('feature..main')).sort());
    assert.deepEqual(onlyIn('from').sort(), (await only('main..feature')).sort());
    assert.ok(shown.view.matched);
    const changed = (await git(app, ['diff', '--name-only', base, head])).stdout.trim().split('\n');
    assert.deepEqual(shown.view.files.map((file) => file.path), changed);
    const lines = await until('the lines', () => posted.find((outgoing, at) => outgoing.type === 'comparePatch' && addressed[at] === tab.panel.webview));
    assert.ok(lines.type === 'comparePatch' && lines.patch?.length === changed.length);

    // Everything that differs, and the other way round.
    forget();
    await internals.onMessage(tab.panel.webview, { type: 'setCompareMode', mode: 'direct' });
    assert.equal(told(tab)?.view?.since, hashOf('feature'));
    await internals.onMessage(tab.panel.webview, { type: 'swapCompare' });
    assert.deepEqual([told(tab)?.view?.from.name, told(tab)?.view?.to.name, told(tab)?.view?.since], ['main', 'feature', head]);
    assert.equal(tab.panel.title, 'main ↔ feature');
    // While the two are compared again the tab is told to wait, and that the wait is over before the answer.
    forget();
    await internals.onMessage(tab.panel.webview, { type: 'swapCompare' });
    const waited = posted.flatMap((outgoing, at) => {
      if (addressed[at] !== tab.panel.webview) return [];
      if (outgoing.type === 'loading') return [`loading ${outgoing.what}`];
      return outgoing.type === 'compareView' ? ['compareView'] : [];
    });
    assert.deepEqual(waited, ['loading filter', 'loading null', 'compareView']);

    // Asked for again, from the button of a comparison in a view, the two have their tab: that one is shown.
    await internals.onMessage(view('branches'), { type: 'openCompare', from: { name: 'feature', hash: hashOf('feature') }, to: { name: 'main', hash: head } });
    assert.equal(tabs().length, 1);

    // One side chosen again in the page.
    choose = (items, options) => {
      titles.push(options.title ?? '');
      return byLabel('$(git-branch) topic')(items);
    };
    await internals.onMessage(tab.panel.webview, { type: 'pickCompareSide', side: 'to' });
    assert.equal(titles.at(-1), 'Compare feature with');
    assert.deepEqual(compared()?.to, { name: 'topic', hash: hashOf('topic'), live: true });
    assert.equal(told(tab)?.view?.to.name, 'topic');
    assert.equal(tab.panel.title, 'feature ↔ topic');

    // A branch that moves is followed; one that is deleted stays where it was.
    const before = await revParse('HEAD~1');
    await git(app, ['branch', 'compared', before]);
    // Named by a branch that git gives another commit, a side is the commit it was chosen at.
    await internals.onMessage(view('branches'), { type: 'openCompare', from: { name: 'feature', hash: hashOf('feature') }, to: { name: 'compared', hash: head } });
    const fixed = await until('the tab of the comparison', () => tabs()[1]);
    assert.deepEqual([fixed.to.live, fixed.mode], [false, 'direct']);
    await internals.onMessage(view('branches'), { type: 'openCompare', from: { name: 'feature', hash: hashOf('feature') }, to: { name: 'compared', hash: before } });
    const followed = await until('the other tab', () => tabs()[2]);
    assert.deepEqual([followed.to.live, followed.mode], [true, 'diverged']);
    await until('its comparison', () => told(followed));
    await git(app, ['branch', '--force', 'compared', head]);
    await controller.refresh();
    await until('the comparison of where the branch is now', () => told(followed)?.view?.to.hash === head);
    await git(app, ['branch', '--delete', '--force', 'compared']);
    await controller.refresh();
    await until('the branch to be gone', () => told(followed)?.view?.to.gone);
    assert.equal(followed.to.hash, head);
    // A tab closed while git answers for it is left alone.
    errors.length = 0;
    const answering = internals.onMessage(followed.panel.webview, { type: 'setCompareMode', mode: 'direct' });
    followed.panel.dispose();
    await answering;
    assert.deepEqual(errors, []);
    await closeAll();

    // Asked by the branches, with something typed: a revision is followed as well.
    choose = (items, options) => byLabel(options.title === 'Compare' ? /Enter a hash/ : '$(git-branch) topic')(items);
    inputs = ['HEAD~1'];
    await internals.onMessage(view('branches'), { type: 'compare' });
    const parent = (await git(app, ['rev-parse', 'HEAD~1'])).stdout.trim();
    await until('the tab', () => tabs().length === 1);
    assert.deepEqual(compared(), {
      from: { name: 'HEAD~1', hash: parent, live: true },
      to: { name: 'topic', hash: hashOf('topic'), live: true },
      mode: 'diverged',
    });

    // "Compare with…" in a menu gives one side; a hash that is typed is named by its short form, and stays that commit.
    choose = byLabel(/Enter a hash/);
    inputs = [parent];
    await internals.onMessage(view('sideGraph'), { type: 'compare', from: { name: tag.name, hash: tag.hash } });
    await until('the tab', () => tabs().length === 2);
    assert.deepEqual(compared(), {
      from: { name: 'v1', hash: tag.hash, live: true },
      to: { name: parent.slice(0, 7), hash: parent, live: false },
      mode: 'direct',
    });
    await closeAll();

    // What git does not know is said, and backing out does nothing.
    choose = byLabel(/Enter a hash/);
    inputs = ['no-such-thing'];
    asked.length = 0;
    await vscode.commands.executeCommand('gitardo.compare');
    assert.deepEqual(
      asked.map((question) => question.message),
      ['Gitardo: "no-such-thing" is not a commit of this repository.'],
    );
    choose = () => undefined;
    await vscode.commands.executeCommand('gitardo.compare');
    assert.equal(tabs().length, 0);

    // A branch clicked in the side bar is shown where the commits are, and nowhere else.
    forget();
    await internals.onMessage(view('branches'), { type: 'show', hash: hashOf('feature') });
    assert.deepEqual(posted, [
      { type: 'reveal', hash: hashOf('feature') },
      { type: 'reveal', hash: hashOf('feature') },
    ]);
    assert.deepEqual(addressed.map((webview) => internals.views.get(webview)).sort(), ['graph', 'sideGraph']);
  });

  await step('compares a file with the working tree from the Explorer, takes it from the other side, copies a patch, opens GitHub and the comparisons opened before', async () => {
    const hashOf = (name: string) => state().branches.find((branch) => branch.name === name)!.hash;
    const show = async (revision: string) => (await git(app, ['show', revision])).stdout;
    const original = fs.readFileSync(path.join(app, 'a.txt'), 'utf8');

    // From the Explorer: the file as it is now, with what is not committed, compared with a branch.
    write('a.txt', `${original}local\n`);
    await controller.refresh();
    const titles: string[] = [];
    let offered: string[] = [];
    choose = (items, options) => {
      titles.push(options.title ?? '');
      offered = items.map((item) => item.label);
      return byLabel('$(git-branch) feature')(items);
    };
    forget();
    await vscode.commands.executeCommand('gitardo.compareWith', vscode.Uri.file(path.join(app, 'a.txt')));
    assert.deepEqual(titles, ['Compare a.txt with']);
    assert.ok(!offered.includes('$(files) Working tree'));
    const tab = await until('the tab of the comparison', () => tabs()[0]);
    assert.equal(tab.panel.title, 'feature ↔ Working tree · a.txt');
    // How the files differ from it, not what the branch did since the two diverged.
    assert.deepEqual([tab.from, tab.to, tab.mode, tab.path], [{ name: 'feature', hash: hashOf('feature'), live: true }, { name: 'Working tree', hash: WORKTREE, live: true }, 'direct', 'a.txt']);
    const shown = await until('the comparison', () => told(tab));
    assert.deepEqual([shown.view?.path, shown.view?.conflicts, shown.view?.files.map((file) => file.path)], ['a.txt', null, ['a.txt']]);
    const added = (patch?: Extract<HostMessage, { type: 'comparePatch' }>) => patch?.patch?.[0]?.hunks?.flatMap((hunk) => hunk.lines).filter((line) => line.startsWith('+'));
    assert.ok(added(await until('the lines', () => told(tab, 'comparePatch')))?.includes('+local'));
    // Followed as the files change.
    write('a.txt', `${original}local\nmore\n`);
    await controller.refresh();
    await until('the lines of the file as it is now', () => added(told(tab, 'comparePatch'))?.includes('+more'));

    // Narrowed in the page: to nothing, which is all of it, and to a file however it is written.
    await internals.onMessage(tab.panel.webview, { type: 'setComparePath', path: ' ./ ' });
    assert.deepEqual([tab.path, told(tab)?.view?.path, tab.panel.title], [null, null, 'feature ↔ Working tree']);
    await internals.onMessage(tab.panel.webview, { type: 'setComparePath', path: '.\\a.txt' });
    assert.deepEqual([tab.path, told(tab)?.view?.files.map((file) => file.path)], ['a.txt', ['a.txt']]);

    // The other way round, the file taken from the branch: what is not committed in it is lost, so it is asked first.
    await internals.onMessage(tab.panel.webview, { type: 'swapCompare' });
    asked.length = 0;
    answer = run;
    await internals.onMessage(tab.panel.webview, { type: 'takeCompareFile', file: { status: 'M', path: 'a.txt' } });
    answer = () => undefined;
    assert.deepEqual(
      asked.map((question) => question.message),
      ['Take a.txt from feature?'],
    );
    assert.match(asked[0].detail, /changes that are not committed are lost/);
    assert.equal(fs.readFileSync(path.join(app, 'a.txt'), 'utf8'), await show('feature:a.txt'));
    await until('the file to be the same', () => told(tab)?.view?.files.length === 0);
    await git(app, ['checkout', 'HEAD', '--', 'a.txt']);
    await controller.refresh();
    // The working tree has no version to give.
    await internals.onMessage(tab.panel.webview, { type: 'swapCompare' });
    asked.length = 0;
    await internals.onMessage(tab.panel.webview, { type: 'takeCompareFile', file: { status: 'M', path: 'a.txt' } });
    assert.equal(asked.length, 0);
    await closeAll();

    // Two branches: the changes copied as a patch, and the comparison opened on GitHub, each side by its name there.
    forget();
    await internals.onMessage(view('branches'), { type: 'openCompare', from: { name: 'origin/main', hash: (await git(app, ['rev-parse', 'origin/main'])).stdout.trim() }, to: { name: 'topic', hash: hashOf('topic') } });
    const branches = await until('the tab of the comparison', () => tabs()[0]);
    await until('the comparison', () => told(branches));
    asked.length = 0;
    await internals.onMessage(branches.panel.webview, { type: 'copyComparePatch' });
    const text = await vscode.env.clipboard.readText();
    const files = text.match(/^diff --git /gm)?.length ?? 0;
    assert.equal(files, told(branches)?.view?.files.length);
    assert.deepEqual(
      asked.map((question) => question.message),
      [`Gitardo: copied the changes of ${files} ${files === 1 ? 'file' : 'files'} as a patch.`],
    );
    const opened: string[] = [];
    const env = vscode.env as unknown as Record<string, unknown>;
    const openExternal = env.openExternal;
    env.openExternal = (uri: vscode.Uri) => {
      opened.push(uri.toString(true));
      return Promise.resolve(true);
    };
    const github = internals.github;
    const githubRemote = internals.githubRemote;
    internals.github = { owner: 'octo', repo: 'app' };
    internals.githubRemote = 'origin';
    try {
      await internals.onMessage(branches.panel.webview, { type: 'openCompareOnGitHub' });
      // A branch with no upstream there is not on GitHub by its name: its commit is, once pushed.
      await internals.onMessage(branches.panel.webview, { type: 'swapCompare' });
      await internals.onMessage(branches.panel.webview, { type: 'setCompareMode', mode: 'direct' });
      await internals.onMessage(branches.panel.webview, { type: 'openCompareOnGitHub' });
    } finally {
      env.openExternal = openExternal;
      internals.github = github;
      internals.githubRemote = githubRemote;
    }
    assert.deepEqual(opened, [`https://github.com/octo/app/compare/main...${hashOf('topic')}`, `https://github.com/octo/app/compare/${hashOf('topic')}..main`]);
    await closeAll();

    // The comparisons opened last come first when one is asked for, the two ways of one as one, and open as they were.
    let first: string[] = [];
    choose = (items, options) => {
      if (options.title === 'Compare') first = items.map((item) => `${item.label}${item.description ? ` · ${item.description}` : ''}`);
      return byLabel('$(history) feature ↔ Working tree')(items);
    };
    await vscode.commands.executeCommand('gitardo.compare');
    assert.deepEqual(first.slice(0, 4), ['Opened before', '$(history) topic ↔ origin/main', '$(history) feature ↔ Working tree · a.txt', '$(history) feature ↔ Working tree']);
    const again = await until('the tab of the comparison', () => tabs()[0]);
    assert.deepEqual([again.from.name, again.to.hash, again.path], ['feature', WORKTREE, 'a.txt']);
    await closeAll();
  });

  await step('narrows the graph to the history of a file, switching repository if needed', async () => {
    await vscode.commands.executeCommand('gitardo.fileHistory', vscode.Uri.file(path.join(app, 'b.txt')));
    assert.deepEqual(state().filter, { kind: 'path', path: 'b.txt' });
    // On every branch: `feature` changes the file too.
    assert.deepEqual(subjects(), ['Add feature', 'Add b']);
    await controller.setFilter(null);
    assert.equal(state().filter, null);

    await vscode.commands.executeCommand('gitardo.fileHistory', vscode.Uri.file(path.join(lib, 'lib.txt')));
    assert.equal(state().name, 'lib');
    assert.deepEqual(subjects(), ['Add lib']);
    await controller.selectRepo(state().repos[0].root);
    assert.equal(state().name, 'app');
    assert.equal(state().filter, null);
  });

  await step('narrows the graph to the branches chosen, remembers them for each repository, and shows them all for a commit elsewhere', async () => {
    const graph = view('graph');
    const everything = subjects();
    assert.equal(state().scope, null);
    assert.ok(everything.includes('Add feature'));

    // As a view asks: only what is checked out.
    await internals.onMessage(graph, { type: 'setScope', scope: { kind: 'current' } });
    assert.deepEqual(state().scope, { kind: 'current' });
    assert.ok(!subjects().includes('Add feature') && subjects().includes('Add b'), `current: ${subjects()}`);

    // Or the branches chosen one by one, of which only the ones that are there are taken.
    await internals.onMessage(graph, { type: 'setScope', scope: { kind: 'refs', refs: ['refs/heads/feature', 'refs/heads/gone', '--all'] } });
    assert.deepEqual(state().scope, { kind: 'refs', refs: ['refs/heads/feature'] });
    assert.equal(subjects()[0], 'Add feature');

    // The history of a file is the one it has among them, and leaves them as they were when it is closed.
    await controller.setFilter({ kind: 'path', path: 'b.txt' });
    assert.deepEqual(subjects(), ['Add feature', 'Add b']);
    await internals.onMessage(graph, { type: 'setScope', scope: { kind: 'current' } });
    assert.deepEqual(subjects(), ['Add b']);
    assert.deepEqual(state().filter, { kind: 'path', path: 'b.txt' });
    await controller.setFilter(null);
    assert.deepEqual(state().scope, { kind: 'current' });

    // Each repository has its own, and finds it again.
    await controller.selectRepo(state().repos[1].root);
    assert.equal(state().name, 'lib');
    assert.equal(state().scope, null);
    await controller.selectRepo(state().repos[0].root);
    assert.equal(state().name, 'app');
    assert.deepEqual(state().scope, { kind: 'current' });

    // A commit on a branch that is not shown is not hidden from who asks for it: the branches are all shown again.
    const feature = (await git(app, ['rev-parse', 'feature'])).stdout.trim();
    await internals.onMessage(graph, { type: 'goTo', revision: feature });
    assert.equal(state().scope, null);
    assert.ok(state().rows.some((row) => row.hash === feature));

    // A branch deleted while it is one of those shown is no longer one of them.
    await git(app, ['branch', 'scoped', 'HEAD~1']);
    await vscode.commands.executeCommand('gitardo.refresh');
    await internals.onMessage(graph, { type: 'setScope', scope: { kind: 'refs', refs: ['refs/heads/scoped', 'refs/heads/main'] } });
    assert.deepEqual(state().scope, { kind: 'refs', refs: ['refs/heads/scoped', 'refs/heads/main'] });
    await git(app, ['branch', '-D', 'scoped']);
    await vscode.commands.executeCommand('gitardo.refresh');
    assert.deepEqual(state().scope, { kind: 'refs', refs: ['refs/heads/main'] });

    await internals.onMessage(graph, { type: 'setScope', scope: null });
    assert.equal(state().scope, null);
    assert.deepEqual(subjects(), everything);
  });

  await step('lists the branches checked out last, and remembers the favorites of each repository', async () => {
    const graph = view('graph');
    // What was checked out before is where one is likely to go back to: not what is checked out now.
    await git(app, ['checkout', '-q', 'feature']);
    await git(app, ['checkout', '-q', 'main']);
    await vscode.commands.executeCommand('gitardo.refresh');
    assert.equal(state().recentBranches[0], 'feature');
    assert.ok(!state().recentBranches.includes('main'), `recent: ${state().recentBranches}`);

    // A favorite is told to the views at once, with the rows they already have, and only a branch that is there is one.
    assert.deepEqual(state().favorites, []);
    posted.length = 0;
    await internals.onMessage(graph, { type: 'setFavorite', ref: 'refs/heads/feature', favorite: true });
    await internals.onMessage(graph, { type: 'setFavorite', ref: 'refs/remotes/origin/main', favorite: true });
    await internals.onMessage(graph, { type: 'setFavorite', ref: 'refs/heads/nowhere', favorite: true });
    assert.deepEqual(state().favorites, ['refs/heads/feature', 'refs/remotes/origin/main']);
    assert.ok(posted.some((outgoing) => outgoing.type === 'state'));

    // Each repository has its own, and finds them again.
    await controller.selectRepo(state().repos[1].root);
    assert.deepEqual(state().favorites, []);
    await controller.selectRepo(state().repos[0].root);
    assert.deepEqual(state().favorites, ['refs/heads/feature', 'refs/remotes/origin/main']);

    // A branch that is deleted is no longer one, and the others stay when one is taken out.
    await git(app, ['branch', 'liked']);
    await vscode.commands.executeCommand('gitardo.refresh');
    await internals.onMessage(graph, { type: 'setFavorite', ref: 'refs/heads/liked', favorite: true });
    assert.equal(state().favorites.length, 3);
    await git(app, ['branch', '-D', 'liked']);
    await vscode.commands.executeCommand('gitardo.refresh');
    assert.deepEqual(state().favorites, ['refs/heads/feature', 'refs/remotes/origin/main']);
    await internals.onMessage(graph, { type: 'setFavorite', ref: 'refs/heads/feature', favorite: false });
    await internals.onMessage(graph, { type: 'setFavorite', ref: 'refs/remotes/origin/main', favorite: false });
    assert.deepEqual(state().favorites, []);
  });

  /** The commits of what is checked out, as their view in the side bar is given them when it asks. */
  const branchLog = async () => {
    const commits = view('commits');
    posted.length = 0;
    addressed.length = 0;
    await internals.onMessage(commits, { type: 'getLog', limit: 100 });
    const index = posted.findIndex((outgoing) => outgoing.type === 'log');
    const answer = posted[index];
    assert.ok(answer?.type === 'log', 'the view is answered');
    assert.equal(addressed[index], commits);
    return answer.log;
  };

  await step('lists the commits of what is checked out apart from the graph, with their files and the ones that are not pushed', async () => {
    const history = (await git(app, ['log', '--format=%H', 'HEAD'])).stdout.split('\n').filter(Boolean);
    assert.ok(history.length >= 5);
    const log = await branchLog();
    assert.equal(log.root, state().root);
    assert.deepEqual(
      log.commits.map((commit) => commit.hash),
      history,
    );
    assert.equal(log.hasMore, false);
    assert.equal(log.upstream, 'origin/main');
    assert.equal(state().branches.find((branch) => branch.current)!.upstream!.ahead, 2);
    assert.deepEqual(log.unpushed, history.slice(0, 2));

    // What the graph is narrowed to is nothing to them.
    await controller.setFilter({ kind: 'path', path: 'b.txt' });
    try {
      assert.ok(state().rows.length < history.length, 'the graph has fewer commits');
      assert.deepEqual(
        (await branchLog()).commits.map((commit) => commit.hash),
        history,
      );
    } finally {
      await controller.setFilter(null);
    }

    // A commit unfolds to the files it changed.
    const first = log.commits.at(-1)!;
    posted.length = 0;
    await internals.onMessage(view('commits'), { type: 'getDetail', hash: first.hash });
    const detail = posted.find((outgoing) => outgoing.type === 'detail');
    assert.ok(detail?.type === 'detail' && detail.detail);
    assert.deepEqual(detail.detail.files, [{ status: 'A', path: 'a.txt' }]);
    assert.deepEqual(errors, []);
  });

  await step('pushes, fetches and pulls with a rebase against the remote', async () => {
    assert.equal(state().branches.find((branch) => branch.current)!.upstream!.ahead, 2);
    await controller.sync('push');
    assert.equal(state().branches.find((branch) => branch.current)!.upstream!.ahead, 0);
    assert.deepEqual((await branchLog()).unpushed, []);
    await controller.sync('fetch');
    await controller.sync('pullRebase');
    assert.deepEqual(errors, []);
  });

  await step('pulls with the changes that are not committed set aside, and says when they do not fit on what came in', async () => {
    const start = state().head!;
    const stashes = state().stashes.length;
    const remote = path.join(workspace, '..', 'remote.git');
    const other = path.join(workspace, '..', 'other');
    await git(workspace, ['clone', remote, other]);
    /** Someone else changes a file and pushes. */
    const theirs = async (file: string, content: string, message: string) => {
      fs.writeFileSync(path.join(other, file), content);
      await git(other, ['add', '--all']);
      await git(other, ['-c', 'user.name=Someone Else', '-c', 'user.email=else@gitardo.invalid', 'commit', '-m', message]);
      await git(other, ['push', 'origin', 'HEAD:main']);
    };
    const read = (file: string) => fs.readFileSync(path.join(app, file), 'utf8');
    const original = read('a.txt');
    try {
      // A change in a file the pull does not touch is there after it.
      await theirs('theirs.txt', 'theirs\n', 'Their file');
      write('a.txt', `${original}mine\n`);
      logged.length = 0;
      asked.length = 0;
      await controller.sync('pullAutostash');
      assert.ok(logged.includes('> git pull --autostash'), logged.join('\n'));
      assert.equal(subjects().filter((subject) => subject === 'Their file').length, 1);
      assert.equal(read('a.txt'), `${original}mine\n`);
      assert.equal(state().stashes.length, stashes);
      assert.equal(asked.length, 0);

      // A change where the pull changes too is left in conflict and in the stash git made, which is said.
      write('a.txt', original);
      write('theirs.txt', 'mine\n');
      await theirs('theirs.txt', 'THEIRS\n', 'Their change');
      await controller.sync('pullRebaseAutostash');
      assert.ok(logged.includes('> git pull --rebase --autostash'), logged.join('\n'));
      assert.equal(subjects().filter((subject) => subject === 'Their change').length, 1);
      assert.equal(state().stashes.length, stashes + 1);
      assert.match(state().stashes[0].message, /autostash/);
      assert.match(read('theirs.txt'), /<<<<<<</);
      assert.ok(asked.some((question) => /do not fit on what came in/.test(question.message) && question.items.includes('Show Stashes')), JSON.stringify(asked));
      assert.deepEqual(errors, []);
    } finally {
      // As it was before, here and on the remote, for the steps that follow.
      await git(app, ['reset', '--hard', start]);
      if (state().stashes.length > stashes) await git(app, ['stash', 'drop']);
      await git(app, ['push', '--force', 'origin', `${start}:main`]);
      await vscode.commands.executeCommand('gitardo.refresh');
    }
    assert.equal(state().head, start);
    assert.equal(state().branches.find((branch) => branch.current)!.upstream!.ahead, 0);
  });

  await step('fast-forwards a branch that is not checked out to what its upstream has on the remote', async () => {
    const start = state().head!;
    const remote = path.join(workspace, '..', 'remote.git');
    const other = path.join(workspace, '..', 'fast-forward');
    await git(app, ['push', 'origin', `${start}:refs/heads/lagging`]);
    await git(app, ['branch', '--track', 'lagging', 'origin/lagging']);
    // Someone else pushes to it, and nothing is fetched here before the fast-forward.
    await git(workspace, ['clone', '--branch', 'lagging', remote, other]);
    fs.writeFileSync(path.join(other, 'lagging.txt'), 'theirs\n');
    await git(other, ['add', '--all']);
    await git(other, ['-c', 'user.name=Someone Else', '-c', 'user.email=else@gitardo.invalid', 'commit', '-m', 'On lagging']);
    await git(other, ['push', 'origin', 'lagging']);
    const theirs = (await git(other, ['rev-parse', 'HEAD'])).stdout.trim();
    await vscode.commands.executeCommand('gitardo.refresh');
    try {
      logged.length = 0;
      await controller.action({ kind: 'fastForward', name: 'lagging' });
      assert.ok(logged.includes('> git fetch origin refs/heads/lagging:refs/heads/lagging'), logged.join('\n'));
      assert.equal(state().branches.find((branch) => branch.name === 'lagging')!.hash, theirs);
      assert.equal(state().branch, 'main');
      assert.equal(state().head, start);
      assert.deepEqual(errors, []);
    } finally {
      await git(app, ['branch', '-D', 'lagging']);
      await git(app, ['push', 'origin', '--delete', 'lagging']);
      await vscode.commands.executeCommand('gitardo.refresh');
    }
  });

  await step('the Pull button pulls the way the settings choose: with a rebase and the changes set aside, unless told otherwise', async () => {
    const setting = (name: string, value: boolean | undefined) =>
      vscode.workspace.getConfiguration('gitardo').update(name, value, vscode.ConfigurationTarget.Global);
    /** What the button is set to, once the views were told. */
    const chosen = (action: string) => until(`the button set to ${action}`, () => state().defaultPull === action);
    /** The pull that the command of the button runs. */
    const pulled = async () => {
      logged.length = 0;
      await vscode.commands.executeCommand('gitardo.pull');
      return logged.filter((line) => line.startsWith('> git pull'));
    };
    try {
      assert.equal(state().defaultPull, 'pullRebaseAutostash');
      assert.deepEqual(await pulled(), ['> git pull --rebase --autostash']);
      await setting('pull.rebase', false);
      await chosen('pullAutostash');
      assert.deepEqual(await pulled(), ['> git pull --autostash']);
      await setting('pull.autostash', false);
      await chosen('pull');
      assert.deepEqual(await pulled(), ['> git pull']);
      await setting('pull.rebase', undefined);
      await chosen('pullRebase');
      assert.deepEqual(await pulled(), ['> git pull --rebase']);
      // The pull with no option stays a command of its own, whatever the button is set to.
      await setting('pull.autostash', undefined);
      await chosen('pullRebaseAutostash');
      logged.length = 0;
      await vscode.commands.executeCommand('gitardo.pullPlain');
      assert.deepEqual(logged.filter((line) => line.startsWith('> git pull')), ['> git pull']);
      assert.deepEqual(errors, []);
    } finally {
      await setting('pull.rebase', undefined);
      await setting('pull.autostash', undefined);
    }
  });

  await step('warns about what a force push overwrites', async () => {
    // Rewrite the last commit, so that the remote has one the local branch does not.
    await git(app, ['commit', '--amend', '--allow-empty', '-m', 'Add a file, reworded']);
    await vscode.commands.executeCommand('gitardo.refresh');
    asked.length = 0;
    answer = () => undefined;
    await controller.sync('pushForceWithLease');
    assert.equal(asked.length, 1);
    assert.match(asked[0].detail, /will be overwritten:\n\w+ Add a file\n/);
    assert.match(asked[0].detail, /git push --force-with-lease origin main$/);
    answer = run;
    await controller.sync('pushForceWithLease');
    assert.deepEqual(state().branches.find((branch) => branch.current)!.upstream, {
      name: 'origin/main',
      remote: 'origin',
      branch: 'main',
      ahead: 0,
      behind: 0,
      gone: false,
    });
  });

  await step('undoes the last commit, and restores a deleted branch', async () => {
    write('undo.txt', 'x\n');
    await controller.action({ kind: 'stageAll' });
    await controller.action({ kind: 'commit', message: 'To be undone', amend: false });
    answer = run;
    await controller.action({ kind: 'undo' });
    assert.notEqual(subjects()[1], 'To be undone');
    assert.deepEqual(state().working.staged, [{ status: 'A', path: 'undo.txt' }]);
    await controller.action({ kind: 'unstageAll' });
    await controller.action({ kind: 'discardAll' });

    await controller.action({ kind: 'deleteBranch', name: 'topic' });
    assert.ok(!state().branches.some((branch) => branch.name === 'topic'));
    await controller.action({ kind: 'undo' });
    assert.ok(state().branches.some((branch) => branch.name === 'topic'));
  });

  await step('offers the forced delete when git refuses an unmerged branch', async () => {
    asked.length = 0;
    answer = run;
    await controller.action({ kind: 'deleteBranch', name: 'feature' });
    assert.equal(asked.length, 1);
    assert.match(asked[0].detail, /not fully merged[\s\S]*git branch -D feature$/);
    assert.ok(!state().branches.some((branch) => branch.name === 'feature'));
    await controller.action({ kind: 'undo' });
    assert.ok(state().branches.some((branch) => branch.name === 'feature'));
  });

  await step('cleans up merged branches from a picker, with their worktrees', async () => {
    // `merged` has a worktree, which goes with it.
    const home = path.join(workspace, 'app.worktrees').replace(/\\/g, '/');
    const dir = `${home}/merged`;
    await git(app, ['worktree', 'add', dir, 'merged']);
    await vscode.commands.executeCommand('gitardo.refresh');
    let offered: string[] = [];
    choose = (items) => {
      offered = items.map((item) => `${item.label}${item.picked ? ' (ticked)' : ''}: ${item.description}`);
      return items.filter((item) => item.picked);
    };
    answer = run;
    try {
      await vscode.commands.executeCommand('gitardo.cleanupBranches');
      // `topic` points at the commit that was reworded since, so it is not merged and not offered.
      assert.deepEqual(offered, ['merged (ticked): merged into main · with its worktree merged']);
      assert.deepEqual(
        state().branches.map((branch) => branch.name),
        ['feature', 'main', 'topic'],
      );
      assert.equal(state().worktrees.length, 1);
      assert.ok(!fs.existsSync(dir));
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      await git(app, ['worktree', 'prune']);
    }
  });

  await step('browses the reflog and shows the chosen commit in the graph', async () => {
    let entries = 0;
    choose = (items, options) => {
      if (options.title?.startsWith('Reflog')) {
        entries = items.length;
        return items[1];
      }
      return byLabel('Show in the graph')(items);
    };
    posted.length = 0;
    await vscode.commands.executeCommand('gitardo.reflog');
    assert.ok(entries > 5, `the reflog has entries (${entries})`);
    assert.ok(posted.some((outgoing) => outgoing.type === 'reveal'));
  });

  await step('goes to a commit by its hash: one that is loaded, one further back, one that is filtered out, one no branch reaches', async () => {
    const graph = view('graph');
    const loaded = (hash: string) => state().rows.some((row) => row.hash === hash);
    /** The commits the views were told to select, and the kinds of the views that were told. */
    const revealed = () =>
      posted.flatMap((outgoing, index) => (outgoing.type === 'reveal' ? [`${outgoing.hash} in ${internals.views.get(addressed[index])}`] : []));
    const forget = () => {
      posted.length = 0;
      addressed.length = 0;
      asked.length = 0;
    };
    const oldest = state().rows.at(-1)!.hash;
    const pages = internals.limit;

    // The start of a hash is enough, as typed in the search box of a view: only that view goes there.
    forget();
    await internals.onMessage(graph, { type: 'goTo', revision: oldest.slice(0, 8) });
    assert.deepEqual(revealed(), [`${oldest} in graph`]);

    // Further back than the history is loaded: it is loaded up to there, in whole pages. The views, whose short
    // lists end in sight, would ask for the rest themselves: they are not answered, to see who loads it.
    unanswered.add('loadMore');
    try {
      internals.limit = 2;
      await vscode.commands.executeCommand('gitardo.refresh');
      assert.ok(!loaded(oldest) && state().hasMore, 'only the last commits are loaded');
      forget();
      await internals.onMessage(view('sideGraph'), { type: 'goTo', revision: oldest });
      assert.ok(loaded(oldest), 'the history is loaded up to the commit');
      assert.deepEqual(revealed(), [`${oldest} in sideGraph`]);
      assert.equal(internals.limit, pages);
    } finally {
      unanswered.delete('loadMore');
      internals.limit = pages;
    }

    // In a list that leaves it out, the list gives way; in one that has it, the list stays.
    await controller.setFilter({ kind: 'path', path: 'b.txt' });
    const inFile = state().rows[0].hash;
    assert.ok(!loaded(oldest));
    await internals.onMessage(graph, { type: 'goTo', revision: inFile });
    assert.deepEqual(state().filter, { kind: 'path', path: 'b.txt' });
    await internals.onMessage(graph, { type: 'goTo', revision: oldest });
    assert.equal(state().filter, null);
    assert.ok(loaded(oldest));

    // A commit that no branch or tag reaches is shown with its own history.
    const lost = (await git(app, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Lost'])).stdout.trim();
    forget();
    await internals.onMessage(graph, { type: 'goTo', revision: lost.slice(0, 12) });
    assert.deepEqual(state().filter, { kind: 'ref', ref: lost, lost: true });
    assert.equal(subjects()[0], 'Lost');
    assert.deepEqual(revealed(), [`${lost} in graph`]);
    await controller.setFilter(null);

    // What is not a commit is said, and nothing moves.
    forget();
    await internals.onMessage(graph, { type: 'goTo', revision: 'fffffffffff' });
    assert.deepEqual(revealed(), []);
    assert.match(asked[0].message, /"fffffffffff" is not a commit of this repository/);

    // The command asks for anything git understands, and shows it in the graph.
    const third = (await git(app, ['rev-parse', 'HEAD~2'])).stdout.trim();
    inputs = ['HEAD~2'];
    forget();
    await vscode.commands.executeCommand('gitardo.goToCommit');
    assert.ok(revealed().includes(`${third} in graph`), `revealed: ${revealed()}`);
  });

  await step('finds commits in the whole history for a view to highlight where they are, without replacing the graph', async () => {
    const commits = view('sideGraph');
    const find = async (search: Extract<Filter, { query: string }>) => {
      posted.length = 0;
      addressed.length = 0;
      await internals.onMessage(commits, { type: 'find', search });
      const index = posted.findIndex((outgoing) => outgoing.type === 'found');
      const found = posted[index];
      assert.ok(found?.type === 'found', 'the view is answered');
      assert.equal(addressed[index], commits);
      assert.deepEqual(found.search, search);
      return found;
    };
    const hashes = (wanted: (subject: string) => boolean = () => true) =>
      state()
        .rows.filter((row) => wanted(row.subject))
        .map((row) => row.hash);
    const everything = hashes().length;

    const added = await find({ kind: 'message', query: 'ADD' });
    assert.ok(added.hashes.length > 2 && !added.more);
    assert.deepEqual(added.hashes, hashes((subject) => /add/i.test(subject)));
    // The graph is as it was.
    assert.equal(state().filter, null);
    assert.equal(hashes().length, everything);

    // In the history of a file, only the commits of that history.
    await controller.setFilter({ kind: 'path', path: 'b.txt' });
    assert.ok(hashes().length < everything);
    assert.deepEqual((await find({ kind: 'author', query: 'gitardo test' })).hashes, hashes());
    assert.deepEqual(state().filter, { kind: 'path', path: 'b.txt' });

    // A list of results gives way to the graph the new ones are shown in.
    await controller.setFilter({ kind: 'message', query: 'feature' });
    const two = await find({ kind: 'pickaxe', query: 'two' });
    assert.equal(state().filter, null);
    assert.ok(two.hashes.length > 0 && two.hashes.every((hash) => hashes().includes(hash)));

    // A search git refuses is said, and finds nothing.
    const before = errors.length;
    assert.deepEqual((await find({ kind: 'regex', query: '[' })).hashes, []);
    assert.match(errors.at(-1)!, /the search failed/);
    // Provoked on purpose.
    errors.length = before;
  });

  await step('switches identity for the repository', async () => {
    choose = byLabel('Enter a name and email…');
    inputs = ['Other Me', 'other@gitardo.invalid'];
    await vscode.commands.executeCommand('gitardo.switchIdentity');
    assert.deepEqual(state().identity, { name: 'Other Me', email: 'other@gitardo.invalid' });
  });

  await step('opens all the changes between two commits in one editor', async () => {
    const from = state().rows.at(-1)!.hash;
    const to = state().head!;
    const { files } = (await new Repo(app).compare(from, to))!;
    assert.ok(files.length > 1);
    await fromWebview({ type: 'openChanges', source: { kind: 'commit', hash: to, parent: from }, files, title: 'Everything since the start' });
    const tab = await until('the editor with all the changes', () => vscode.window.tabGroups.activeTabGroup.activeTab);
    assert.equal(tab.label, `Everything since the start (${files.length} files)`);
    // Not one diff, and not a file: the stable API has no type of its own for this editor either.
    assert.ok(!(tab.input instanceof vscode.TabInputTextDiff) && !(tab.input instanceof vscode.TabInputText));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  await step('opens a commit in an editor tab of its own, with what it changed, whichever repository the views show by then', async () => {
    const hashes = (await git(app, ['log', '--all', '--format=%H %P', '--grep=^Change a$'])).stdout.trim().split('\n');
    const [hash, parent] = hashes.at(-1)!.split(' ');
    const short = hash.slice(0, 7);
    const tabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview);
    const commitViews = () => [...internals.views.entries()].filter(([, kind]) => kind === 'commit').map(([webview]) => webview as vscode.Webview);
    const told = (type: HostMessage['type'], to: unknown) => posted.filter((outgoing, index) => outgoing.type === type && addressed[index] === to);

    received.length = 0;
    posted.length = 0;
    addressed.length = 0;
    // As a double click on its row asks.
    await fromWebview({ type: 'openCommit', hash });
    const tab = await until('the tab of the commit', () => tabs().find((candidate) => candidate.label.startsWith(short)));
    assert.equal(tab.label, `${short} Change a`);
    assert.ok(tab.isActive);
    const [webview] = commitViews();
    assert.match(webview.html, new RegExp(`data-view="commit" data-session="${vscode.env.sessionId}" data-commit="${hash}" data-root="[^"]+" data-files="tree"`));

    // The page asks for its commit by itself: it loaded under the content security policy, and read which one it is of.
    await until('the page to ask for the changes', () => received.some((incoming) => incoming.type === 'getPatch' && incoming.hash === hash));
    const detail = await until('the details', () => told('detail', webview)[0]);
    assert.ok(detail.type === 'detail' && detail.detail);
    assert.deepEqual([detail.detail.subject, detail.detail.parents], ['Change a', [parent]]);
    const patch = await until('the changes', () => told('patch', webview)[0]);
    assert.ok(patch.type === 'patch' && patch.patch);
    assert.deepEqual(
      patch.patch.map((file) => [file.file.status, file.file.path, file.added, file.removed, file.hunks?.[0].lines]),
      [['M', 'a.txt', 1, 0, [' one', '+two']]],
    );
    // It is told the state as well, for the labels of its commit.
    assert.equal(told('state', webview).length, 1);

    // Asked for again, the commit has its tab: that one is shown.
    await vscode.commands.executeCommand('gitardo.openGraph');
    await controller.openCommit(hash);
    assert.equal(commitViews().length, 1);
    assert.equal(tabs().filter((candidate) => candidate.label.startsWith(short)).length, 1);

    // Its parent, from the link in the page, has another. So has a revision typed in the prompt of the command.
    await internals.onMessage(webview, { type: 'openCommit', hash: parent });
    await until('the tab of the parent', () => tabs().some((candidate) => candidate.label === `${parent.slice(0, 7)} Add b`));
    await internals.onMessage(webview, { type: 'setFilesLayout', layout: 'list' });
    inputs = ['feature'];
    await vscode.commands.executeCommand('gitardo.openCommit');
    await until('the tab of the typed revision', () => tabs().some((candidate) => /^\w{7} Add feature$/.test(candidate.label)));
    assert.equal(commitViews().length, 3);
    // The layout chosen in one tab is the one the next opens with.
    assert.match(commitViews()[2].html, /data-files="list"/);
    await internals.onMessage(webview, { type: 'setFilesLayout', layout: 'tree' });

    // The other views move on to another repository: the tab is still of its own.
    await controller.selectRepo(state().repos[1].root);
    assert.equal(state().name, 'lib');
    posted.length = 0;
    addressed.length = 0;
    await internals.onMessage(webview, { type: 'getDetail', hash });
    const [again] = told('detail', webview);
    assert.ok(again.type === 'detail' && again.detail?.subject === 'Change a');
    await internals.onMessage(webview, { type: 'openDiff', source: { kind: 'commit', hash, parent }, file: { status: 'M', path: 'a.txt' } });
    const diff = await until('the diff editor', () => {
      const active = vscode.window.tabGroups.activeTabGroup.activeTab;
      return active?.input instanceof vscode.TabInputTextDiff ? active.input : undefined;
    });
    assert.equal((await vscode.workspace.openTextDocument(diff.modified)).getText(), 'one\ntwo\n');
    assert.equal((await vscode.workspace.openTextDocument(diff.original)).getText(), 'one\n');

    // And its button for the graph brings the graph back to the repository of the commit.
    await internals.onMessage(webview, { type: 'reveal', hash });
    assert.equal(state().name, 'app');
    assert.ok(posted.some((outgoing) => outgoing.type === 'reveal' && outgoing.hash === hash));

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await until('the tabs to detach', () => commitViews().length === 0);
    // A closed tab is not kept for the next time.
    await controller.openCommit(hash);
    await until('a new tab', () => commitViews().length === 1);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await until('the tab to detach', () => commitViews().length === 0);

    // What is not a commit of the repository is said, and opens nothing.
    asked.length = 0;
    await controller.openCommit('0123456789abcdef0123456789abcdef01234567');
    assert.match(asked.at(-1)!.message, /0123456 is not a commit of this repository/);
    assert.equal(commitViews().length, 0);
  });

  await step('adds, renames and removes a remote, and offers to add one when there is none', async () => {
    const pickRemote = (name: string, then: string) => (items: Item[], options: vscode.QuickPickOptions) =>
      byLabel(options.title?.startsWith('Remotes of') ? name : then)(items);

    choose = byLabel('Add remote…');
    inputs = ['backup', 'https://example.invalid/backup.git'];
    await vscode.commands.executeCommand('gitardo.remotes');
    assert.deepEqual(state().remotes, ['backup', 'origin']);
    assert.ok(logged.includes('> git remote add backup https://example.invalid/backup.git'));

    choose = pickRemote('backup', 'Rename…');
    inputs = ['mirror'];
    await vscode.commands.executeCommand('gitardo.remotes');
    assert.deepEqual(state().remotes, ['mirror', 'origin']);

    choose = pickRemote('mirror', 'Remove');
    asked.length = 0;
    answer = run;
    await vscode.commands.executeCommand('gitardo.remotes');
    assert.equal(asked[0].message, 'Remove remote mirror?');
    assert.deepEqual(state().remotes, ['origin']);

    await controller.selectRepo(state().repos[1].root);
    assert.deepEqual(state().remotes, []);
    asked.length = 0;
    answer = () => undefined;
    await controller.sync('push');
    assert.deepEqual(asked, [{ message: 'Gitardo: this repository has no remote.', detail: '', items: ['Add Remote…'] }]);
    await controller.selectRepo(state().repos[0].root);
  });

  await step('stashes a single file and leaves the rest alone', async () => {
    write('a.txt', 'one\ntwo\nstash me\n');
    write('keep.txt', 'stays\n');
    await vscode.commands.executeCommand('gitardo.refresh');
    inputs = ['only a'];
    await controller.action({ kind: 'stashPush', paths: ['a.txt'] });
    assert.equal(state().stashes.length, 1);
    assert.match(state().stashes[0].message, /only a$/);
    assert.deepEqual(state().working.unstaged, [{ status: '?', path: 'keep.txt' }]);
    assert.equal(fs.readFileSync(path.join(app, 'a.txt'), 'utf8'), 'one\ntwo\n');

    // Asked first, with what it would stop on.
    asked.length = 0;
    answer = run;
    await controller.action({ kind: 'stashPop', ref: 'stash@{0}' });
    assert.deepEqual(
      asked.map((question) => question.message),
      ['Pop stash@{0}?'],
    );
    assert.ok(asked[0].detail.includes('No conflicts expected.'), asked[0].detail);
    assert.equal(state().stashes.length, 0);
    assert.equal(state().changes, 2);
    await controller.action({ kind: 'discardAll' });
    assert.equal(state().changes, 0);
  });

  await step('the buttons added to the list of changes of VS Code stash a file, what is staged or everything, in the repository of the file', async () => {
    // What VS Code hands to the command of a button: the file it is on, or the group with its files.
    const file = (root: string, name: string) => ({ resourceUri: vscode.Uri.file(path.join(root, name)) });
    const stashed = () => logged.filter((line) => line.startsWith('> git stash push'));
    const before = errors.length;
    const pop = () => {
      answer = run;
      return controller.action({ kind: 'stashPop', ref: 'stash@{0}' });
    };
    write('a.txt', 'one\ntwo\nstash me\n');
    write('keep.txt', 'stays\n');
    await vscode.commands.executeCommand('gitardo.refresh');
    try {
      logged.length = 0;
      inputs = ['from the list'];
      await vscode.commands.executeCommand('gitardo.scmStashFile', file(app, 'a.txt'));
      assert.deepEqual(stashed(), ['> git stash push --include-untracked -m "from the list" -- a.txt']);
      assert.equal(state().stashes.length, 1);
      assert.deepEqual(state().working.unstaged, [{ status: '?', path: 'keep.txt' }]);
      await pop();
      assert.equal(state().changes, 2);

      // On the group of the changes: everything, untracked files too.
      logged.length = 0;
      inputs = [''];
      await vscode.commands.executeCommand('gitardo.scmStashAll', { resourceStates: [file(app, 'a.txt'), file(app, 'keep.txt')] });
      assert.deepEqual(stashed(), ['> git stash push --include-untracked']);
      assert.equal(state().changes, 0);
      await pop();
      assert.equal(state().changes, 2);

      // On the group of what is staged: that, and nothing else.
      await controller.action({ kind: 'stage', paths: ['a.txt'] });
      logged.length = 0;
      inputs = ['staged'];
      await vscode.commands.executeCommand('gitardo.scmStashStaged', { resourceStates: [file(app, 'a.txt')] });
      assert.deepEqual(stashed(), ['> git stash push --staged -m staged']);
      assert.deepEqual(state().working.staged, []);
      assert.deepEqual(state().working.unstaged, [{ status: '?', path: 'keep.txt' }]);
      await pop();
      assert.equal(state().changes, 2);

      // A file of the other repository is stashed there, which the views then show.
      fs.writeFileSync(path.join(lib, 'lib.txt'), 'lib\nmore\n');
      inputs = ['in lib'];
      await vscode.commands.executeCommand('gitardo.scmStashFile', file(lib, 'lib.txt'));
      assert.equal(state().name, 'lib');
      assert.equal(state().stashes.length, 1);
      assert.equal(state().changes, 0);
      await pop();
      await git(lib, ['checkout', '--', 'lib.txt']);
      assert.equal(errors.length, before);
    } finally {
      await controller.selectRepo(state().repos[0].root);
      answer = run;
      await controller.action({ kind: 'discardAll' });
    }
    assert.equal(state().name, 'app');
    assert.equal(state().changes, 0);
    assert.equal(state().stashes.length, 0);
  });

  await step('cherry-picks several commits oldest first, whatever order they were selected in', async () => {
    await git(app, ['checkout', '-b', 'picks']);
    const made: string[] = [];
    for (const name of ['one', 'two']) {
      write(`pick-${name}.txt`, `${name}\n`);
      await git(app, ['add', '--all']);
      await git(app, ['commit', '-m', `Pick ${name}`]);
      made.push((await git(app, ['rev-parse', 'HEAD'])).stdout.trim());
    }
    await git(app, ['checkout', 'main']);
    await vscode.commands.executeCommand('gitardo.refresh');
    assert.equal(state().branch, 'main');
    const before = state().head!;

    await vscode.workspace.getConfiguration('gitardo').update('commandPreview', 'all', vscode.ConfigurationTarget.Global);
    try {
      asked.length = 0;
      answer = run;
      await controller.action({ kind: 'cherryPickMany', hashes: [made[1], made[0]] });
      assert.equal(asked[0].message, 'Cherry-pick 2 commits?');
      assert.match(asked[0].detail, /In this order:\n\w{7} Pick one\n\w{7} Pick two\n/);
      assert.ok(asked[0].detail.endsWith(`git cherry-pick ${made[0]} ${made[1]}`));
    } finally {
      await vscode.workspace.getConfiguration('gitardo').update('commandPreview', undefined, vscode.ConfigurationTarget.Global);
    }
    assert.equal(state().operation, null);
    const log = async () => (await git(app, ['log', '--format=%s', '-2', 'main'])).stdout.trim().split('\n');
    assert.deepEqual(await log(), ['Pick two', 'Pick one']);

    // Undo takes back the whole series, not just its last commit; undoing again brings it back.
    asked.length = 0;
    await controller.action({ kind: 'undo' });
    assert.equal(asked[0].message, 'Undo "Cherry-pick 2 commits"?');
    assert.match(asked[0].detail, new RegExp(`git reset --keep ${before}$`));
    assert.equal(state().head, before);
    await controller.action({ kind: 'undo' });
    assert.deepEqual(await log(), ['Pick two', 'Pick one']);
    await git(app, ['branch', '-D', 'picks']);
    await vscode.commands.executeCommand('gitardo.refresh');
  });

  await step('continues a series of cherry-picks past a conflict resolved by keeping what the branch has', async () => {
    const before = state().head!;
    await git(app, ['checkout', '-b', 'clashing']);
    const made: string[] = [];
    for (const [name, content] of [['clash', 'theirs'], ['after', 'after']]) {
      write(`${name}.txt`, `${content}\n`);
      await git(app, ['add', '--all']);
      await git(app, ['commit', '-m', `Pick ${name}`]);
      made.push((await git(app, ['rev-parse', 'HEAD'])).stdout.trim());
    }
    await git(app, ['checkout', 'main']);
    write('clash.txt', 'ours\n');
    await git(app, ['add', '--all']);
    await git(app, ['commit', '-m', 'Clash on main']);
    await vscode.commands.executeCommand('gitardo.refresh');
    try {
      answer = run;
      await controller.action({ kind: 'cherryPickMany', hashes: made });
      assert.equal(state().operation, 'cherry-pick');
      assert.deepEqual(state().working.conflicts.map((file) => file.path), ['clash.txt']);
      const failed = errors.length;

      // Keeping main's side leaves the first commit with nothing to commit: continuing skips it and picks the next.
      await controller.action({ kind: 'takeSide', path: 'clash.txt', side: 'ours' });
      await controller.action({ kind: 'continue' });
      assert.equal(state().operation, null);
      assert.equal(errors.length, failed, errors.slice(failed).join('\n'));
      assert.deepEqual((await git(app, ['log', '--format=%s', '-2', 'main'])).stdout.trim().split('\n'), ['Pick after', 'Clash on main']);
    } finally {
      await git(app, ['cherry-pick', '--abort']).catch(() => undefined);
      await git(app, ['reset', '--hard', before]);
      await git(app, ['branch', '-D', 'clashing']);
      await vscode.commands.executeCommand('gitardo.refresh');
    }
  });

  await step('follows a renamed file in its history', async () => {
    await git(app, ['mv', 'pick-one.txt', 'renamed.txt']);
    await git(app, ['commit', '-m', 'Rename a file']);
    await vscode.commands.executeCommand('gitardo.fileHistory', vscode.Uri.file(path.join(app, 'renamed.txt')));
    assert.deepEqual(state().filter, { kind: 'path', path: 'renamed.txt', renamedFrom: ['pick-one.txt'] });
    assert.deepEqual(subjects(), ['Rename a file', 'Pick one']);
    await controller.setFilter(null);
  });

  await step('bisects from the graph and reports the first bad commit', async () => {
    const rows = state().rows;
    asked.length = 0;
    answer = () => undefined;
    await controller.action({ kind: 'bisect', mark: 'bad', hash: rows[0].hash });
    await controller.action({ kind: 'bisect', mark: 'good', hash: rows.at(-1)!.hash });
    assert.ok(state().bisect?.suspects);
    for (let guard = 0; state().bisect!.suspects! > 1 && guard < 10; guard++) {
      // "Bad" from the commit that added b.txt onwards.
      const bad = fs.existsSync(path.join(app, 'b.txt'));
      await controller.action({ kind: 'bisect', mark: bad ? 'bad' : 'good' });
    }
    const found = state().rows.find((row) => row.hash === state().bisect!.bad);
    assert.equal(found?.subject, 'Add b');
    assert.ok(asked.some((question) => /first bad commit is \w{7} "Add b"/.test(question.message)));
    await vscode.commands.executeCommand('gitardo.bisectReset');
    assert.equal(state().bisect, null);
    assert.equal(state().branch, 'main');
  });

  await step('stops on a conflicting merge, says so first, opens the merge editor and aborts cleanly', async () => {
    write('b.txt', 'bee\nmain\n');
    await controller.action({ kind: 'stageAll' });
    await controller.action({ kind: 'commit', message: 'Conflicting change', amend: false });
    asked.length = 0;
    errors.length = 0;
    answer = run;
    await controller.action({ kind: 'merge', ref: 'feature' });
    assert.match(asked[0].detail, /stop with conflicts in 1 file:\nb\.txt/);
    assert.equal(state().operation, 'merge');
    assert.deepEqual(state().working.conflicts, [{ status: 'U', path: 'b.txt' }]);
    assert.ok(asked.some((question) => /Merge feature into main stopped: 1 file has conflicts/.test(question.message)));

    await fromWebview({ type: 'openDiff', source: { kind: 'conflict' }, file: state().working.conflicts[0] });
    const tab = await until('the merge editor', () => vscode.window.tabGroups.activeTabGroup.activeTab);
    // The stable API has no type for a merge editor: its tab is recognised by not being a plain text editor on the file.
    assert.ok(!(tab.input instanceof vscode.TabInputText), `a merge editor is open, not a text editor (${tab.label})`);
    assert.match(tab.label, /^Merging: b\.txt/);
    const side = async (ref: string) => (await vscode.workspace.openTextDocument(contentUri(state().root, ref, 'b.txt'))).getText();
    assert.equal(await side(CONFLICT.base), 'bee\n');
    assert.equal(await side(CONFLICT.ours), 'bee\nmain\n');
    assert.equal(await side(CONFLICT.theirs), 'bee\nfeature\n');
    // The merge editor starts its own resolution in the result, which counts as an unsaved change.
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    assert.equal(vscode.window.tabGroups.all.flatMap((group) => group.tabs).length, 0);

    await controller.action({ kind: 'abort' });
    assert.equal(state().operation, null);
    assert.equal(state().changes, 0);
  });

  await step('switches a file in conflict between the merge editor and the Flow Merge, which joins each side to the result as git wrote it', async () => {
    interface Panel {
      initSent: boolean;
      currentModel: { result: string; regions: { kind: string; unresolved: boolean; resultOurs: { start: number; count: number }; resultTheirs: { start: number; count: number } }[] } | undefined;
    }
    const file = path.join(app, 'b.txt');
    const marked = 'bee\n<<<<<<< HEAD\nmain\n=======\nfeature\n>>>>>>> feature\n';
    const document = () => vscode.workspace.textDocuments.find((each) => samePath(each.uri.fsPath, file));
    const mergeTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => /^Merging: b\.txt/.test(tab.label));
    const panels = () => flowDiff.merge.all() as unknown as Panel[];
    const openMergeEditor = async () => {
      await fromWebview({ type: 'openDiff', source: { kind: 'conflict' }, file: state().working.conflicts[0] });
      await until('the merge editor', () => mergeTabs().length === 1);
      // As it opens, the merge editor writes its own start of the result in the file, without saving it.
      await until('the merge editor to start the result', () => document()?.isDirty && document()?.getText() === 'bee\n');
    };
    answer = run;
    await controller.action({ kind: 'merge', ref: 'feature' });
    assert.equal(fs.readFileSync(file, 'utf8'), marked);
    try {
      await openMergeEditor();
      // Nothing chosen in it yet: it closes without a question, and its start of the result is undone.
      asked.length = 0;
      await vscode.commands.executeCommand('gitardo.openInFlowMerge');
      const [panel] = await until('the Flow Merge', () => (panels().length ? panels() : undefined));
      assert.equal(mergeTabs().length, 0, 'the Flow Merge takes the place of the merge editor');
      assert.equal(asked.length, 0);
      assert.equal(document()?.isDirty ?? false, false);
      assert.equal(fs.readFileSync(file, 'utf8'), marked);
      // The page says it is ready once its module ran: the Monaco bundle loads under the content security policy.
      await until('the Flow Merge page to load', () => panel.initSent);
      const model = panel.currentModel;
      assert.equal(model?.result, marked);
      assert.deepEqual(
        model?.regions.map((region) => [region.kind, region.unresolved, region.resultOurs, region.resultTheirs]),
        [['conflict', true, { start: 3, count: 1 }, { start: 5, count: 1 }]],
      );

      // What becomes of the file shows in the result.
      fs.writeFileSync(file, 'bee\nmain and feature\n');
      await until('the result to follow the file', () => panel.currentModel?.result === 'bee\nmain and feature\n');
      assert.deepEqual(
        panel.currentModel?.regions.map((region) => [region.kind, region.unresolved]),
        [['conflict', false]],
      );
      fs.writeFileSync(file, marked);
      await until('the conflict to show again', () => panel.currentModel?.regions[0]?.unresolved === true);

      // A side chosen in the page, as its band button sends it: in the file, not saved until Ctrl+S.
      const send = (message: { type: 'edit'; text: string } | { type: 'saveFile' }) => (panel as unknown as { onMessage(message: unknown): void }).onMessage(message);
      send({ type: 'edit', text: 'bee\nmain\n' });
      await until('the choice in the file', () => document()?.isDirty && document()?.getText() === 'bee\nmain\n');
      assert.equal(fs.readFileSync(file, 'utf8'), marked, 'a choice is not saved');
      await until('the model of the choice', () => panel.currentModel?.result === 'bee\nmain\n');
      assert.deepEqual(
        panel.currentModel?.regions.map((region) => [region.kind, region.unresolved, (region as { state?: string }).state]),
        [['conflict', false, 'ours']],
      );
      send({ type: 'saveFile' });
      await until('the file saved', () => !document()?.isDirty);
      assert.equal(fs.readFileSync(file, 'utf8'), 'bee\nmain\n');
      fs.writeFileSync(file, marked);
      await until('the conflict to show again', () => panel.currentModel?.regions[0]?.unresolved === true);

      // And back: the merge editor again, in place of the Flow Merge.
      await vscode.commands.executeCommand('gitardo.flowMerge.openInMergeEditor');
      await until('the merge editor again', () => mergeTabs().length === 1);
      assert.equal(panels().length, 0);
      await until('the merge editor to start the result', () => document()?.isDirty && document()?.getText() === 'bee\n');
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await until('the file as it is saved', () => !document()?.isDirty);
      assert.equal(fs.readFileSync(file, 'utf8'), marked);

      // What was typed in the merge editor is not lost without asking.
      await openMergeEditor();
      // Typed in an editor beside it: a workspace edit of a file open in no text editor would be saved at once.
      const beside = await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: false });
      await beside.edit((builder) => builder.insert(new vscode.Position(1, 0), 'chosen\n'));
      assert.equal(document()?.getText(), 'bee\nchosen\n');
      asked.length = 0;
      answer = () => undefined;
      await vscode.commands.executeCommand('gitardo.openInFlowMerge', vscode.Uri.file(file));
      assert.match(asked[0]?.message ?? '', /The merge editor has changes to b\.txt that are not saved/);
      assert.equal(mergeTabs().length, 1, 'the merge editor stays when the question is not answered');
      assert.equal(panels().length, 0);
      answer = (_message, _detail, items) => (items.includes('Discard and Open') ? 'Discard and Open' : undefined);
      await vscode.commands.executeCommand('gitardo.openInFlowMerge', vscode.Uri.file(file));
      await until('the Flow Merge', () => panels().length === 1);
      assert.equal(mergeTabs().length, 0);
      assert.equal(document()?.isDirty ?? false, false);
      assert.equal(fs.readFileSync(file, 'utf8'), marked);

      // The command works on a file in conflict open in a text editor too, and reveals the panel it has already.
      await vscode.window.showTextDocument(vscode.Uri.file(file));
      await vscode.commands.executeCommand('gitardo.openInFlowMerge');
      assert.equal(panels().length, 1);

      // Closed with a choice not saved: the file shows in an editor, for the change not to be forgotten.
      const [last] = panels();
      await until('the Flow Merge page to load', () => last.initSent);
      await vscode.commands.executeCommand('workbench.action.closeOtherEditors');
      (last as unknown as { onMessage(message: unknown): void }).onMessage({ type: 'edit', text: 'bee\nfeature\n' });
      await until('the choice in the file', () => document()?.isDirty && document()?.getText() === 'bee\nfeature\n');
      (last as unknown as { panel: vscode.WebviewPanel }).panel.dispose();
      const shown = await until('the file in an editor', () => vscode.window.visibleTextEditors.find((editor) => samePath(editor.document.uri.fsPath, file)));
      assert.ok(shown.document.isDirty);
      await vscode.window.showTextDocument(shown.document);
      await vscode.commands.executeCommand('workbench.action.files.revert');
      assert.equal(fs.readFileSync(file, 'utf8'), marked);

      // Mark as Resolved: with the markers still in, only after a question; then saved, staged, and the page closed.
      await vscode.commands.executeCommand('gitardo.openInFlowMerge', vscode.Uri.file(file));
      const [resolving] = await until('the Flow Merge', () => (panels().length ? panels() : undefined));
      await until('the Flow Merge page to load', () => resolving.initSent);
      const sendTo = (message: unknown) => (resolving as unknown as { onMessage(message: unknown): void }).onMessage(message);
      asked.length = 0;
      answer = () => undefined;
      sendTo({ type: 'markResolved' });
      await until('the question about the markers', () => asked.length > 0);
      assert.match(asked[0].message, /b\.txt still has a conflict marked by git\. Mark it as resolved all the same/);
      assert.equal(panels().length, 1, 'not resolved without an answer');
      assert.deepEqual(state().working.conflicts, [{ status: 'U', path: 'b.txt' }]);
      // An edit and the button right after it, as the page sends them: the edit is in the file before it is saved.
      answer = run;
      sendTo({ type: 'edit', text: 'bee\nmain\nfeature\n' });
      sendTo({ type: 'markResolved' });
      await until('the page closed', () => panels().length === 0);
      assert.equal(fs.readFileSync(file, 'utf8'), 'bee\nmain\nfeature\n');
      assert.equal(document()?.isDirty ?? false, false);
      await until('the file staged', () => state().working.conflicts.length === 0);
      assert.equal(state().operation, 'merge');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      answer = run;
      await controller.action({ kind: 'abort' });
    }
    assert.equal(state().operation, null);
    assert.equal(state().changes, 0);
    assert.equal(panels().length, 0);
  });

  await step('offers nothing about resolving conflicts until its setting is on, then resolves the ones that need no choice after showing what it would write, leaves the others, and takes it back', async () => {
    const lines = (changes: Record<number, string> = {}) => Array.from({ length: 12 }, (_, index) => `${changes[index] ?? `line ${index}`}\n`).join('');
    const read = (file: string) => fs.readFileSync(path.join(app, file), 'utf8');
    write('c.txt', lines());
    write('d.txt', 'one\ntwo\n');
    await git(app, ['add', '--', 'c.txt', 'd.txt']);
    await git(app, ['commit', '-m', 'Add c and d']);
    await git(app, ['checkout', '-b', 'beside']);
    // In c.txt each side changes a line next to one the other changes, and both change line 9; in d.txt only the first.
    write('c.txt', lines({ 2: 'two, theirs', 9: 'nine, theirs' }));
    write('d.txt', 'one\nTWO\n');
    await git(app, ['commit', '-am', 'Beside, theirs']);
    await git(app, ['checkout', 'main']);
    write('c.txt', lines({ 3: 'three, ours', 9: 'nine, ours' }));
    write('d.txt', 'ONE\ntwo\n');
    await git(app, ['commit', '-am', 'Beside, ours']);
    await controller.refresh();

    // Experimental, and off until it is switched on: the conflicts are not looked into, nothing is offered and nothing runs.
    const autoResolve = (value: boolean | undefined) =>
      vscode.workspace.getConfiguration('gitardo').update('conflicts.autoResolve', value, vscode.ConfigurationTarget.Global);
    assert.equal(vscode.workspace.getConfiguration('gitardo').get('conflicts.autoResolve'), false);
    asked.length = 0;
    answer = run;
    await controller.action({ kind: 'merge', ref: 'beside' });
    assert.equal(state().operation, 'merge');
    assert.deepEqual(state().conflictFiles, []);
    const plain = asked.find((question) => /stopped: 2 files have conflicts/.test(question.message));
    assert.match(plain?.message ?? '', /Resolve them, then continue or abort the merge\.$/);
    assert.deepEqual(plain?.items, ['Show Log']);
    const untouched = read('c.txt');
    asked.length = 0;
    await vscode.commands.executeCommand('gitardo.resolveConflicts');
    assert.deepEqual(
      asked.map((question) => question.message),
      ['Gitardo: resolving conflicts automatically is experimental, and it is switched off in the settings.'],
    );
    assert.deepEqual(asked[0].items, ['Open Settings']);
    assert.equal(read('c.txt'), untouched);

    await autoResolve(true);
    try {
      // The views follow the setting by themselves.
      await until('the conflicts looked into', () => state().conflictFiles.length === 2);
      await controller.action({ kind: 'abort' });
      assert.equal(state().operation, null);

      asked.length = 0;
      answer = run;
      await controller.action({ kind: 'merge', ref: 'beside' });
      assert.equal(state().operation, 'merge');
      const both = [
        { path: 'c.txt', conflicts: 2, resolvable: ['separate'] },
        { path: 'd.txt', conflicts: 1, resolvable: ['separate'] },
      ];
      assert.deepEqual(state().conflictFiles, both);
      const stopped = asked.find((question) => /stopped: 2 files have conflicts/.test(question.message));
      assert.match(stopped?.message ?? '', /Gitardo can resolve 2 of the 3 conflicts automatically\.$/);
      assert.deepEqual(stopped?.items, ['Resolve Automatically', 'Show Log']);

      // It asks first, saying the files it writes and the command it runs; each resolution can be looked at in the review.
      const marked = read('c.txt');
      asked.length = 0;
      posted.length = 0;
      addressed.length = 0;
      answer = (_text, _detail, items) => (items.includes('Review') ? 'Review' : undefined);
      await vscode.commands.executeCommand('gitardo.resolveConflicts');
      assert.equal(asked[0].message, 'Resolve 2 of 3 conflicts automatically?');
      assert.deepEqual(asked[0].items, ['Resolve', 'Review']);
      assert.match(asked[0].detail, /^c\.txt: 1 of 2 conflicts \(changes to lines next to each other\)\nd\.txt: 1 of 1 conflict \(/);
      assert.match(asked[0].detail, /1 conflict will be left to resolve by hand/);
      assert.match(asked[0].detail, /Gitardo will write in [^\n]+:\n\nc\.txt\nd\.txt\n\nand then run:\n\ngit add -- d\.txt$/);
      const tab = await until('the review', () => vscode.window.tabGroups.activeTabGroup.activeTab);
      assert.equal(tab.label, 'Conflicts · app');
      const shown = await until('the review sent', () => lastReview());
      assert.deepEqual(
        shown.files.map((file) => [file.path, file.conflicts.map((conflict) => conflict.proposal?.source ?? null)]),
        [
          ['c.txt', ['rules', null]],
          ['d.txt', ['rules']],
        ],
      );
      assert.equal(shown.files[1].conflicts[0].proposal?.text, 'ONE\nTWO\n');
      // Nothing is written until a resolution is accepted there.
      assert.equal(read('c.txt'), marked);
      assert.deepEqual(state().conflictFiles, both);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');

      asked.length = 0;
      logged.length = 0;
      answer = (_text, _detail, items) => (items.includes('Resolve') ? 'Resolve' : undefined);
      await fromWebview({ type: 'action', action: { kind: 'resolveConflicts' } });
      assert.deepEqual(
        logged.filter((line) => line.startsWith('> ')),
        ['> write c.txt', '> write d.txt', '> git add -- d.txt'],
      );
      assert.equal(read('d.txt'), 'ONE\nTWO\n');
      const left = '<<<<<<< HEAD\nnine, ours\n=======\nnine, theirs\n>>>>>>> beside\n';
      assert.equal(read('c.txt'), lines({ 2: 'two, theirs', 3: 'three, ours', 9: 'LEFT' }).replace('LEFT\n', left));
      assert.deepEqual(state().working.conflicts, [{ status: 'U', path: 'c.txt' }]);
      assert.deepEqual(state().conflictFiles, [{ path: 'c.txt', conflicts: 1, resolvable: [] }]);
      const done = asked.find((question) => question.message.startsWith('Gitardo resolved conflicts'));
      assert.equal(done?.message, 'Gitardo resolved conflicts in 2 files. 1 file still has conflicts to resolve by hand.');
      assert.deepEqual(done?.items, ['Undo']);

      // Undo puts every conflict back, in the file that was staged too.
      asked.length = 0;
      answer = run;
      await controller.action({ kind: 'undo' });
      assert.equal(asked[0].message, 'Undo: restore the conflicts of 2 files?');
      assert.match(asked[0].detail, /git checkout --merge -- c\.txt d\.txt$/);
      assert.deepEqual(state().conflictFiles, both);
      assert.deepEqual(state().working.staged, []);

      // A whole file for one side, which can be taken back the same way.
      asked.length = 0;
      await controller.action({ kind: 'takeSide', path: 'd.txt', side: 'theirs' });
      assert.equal(asked[0].message, 'Take the incoming side of d.txt?');
      assert.match(asked[0].detail, /The incoming side is the branch being merged\./);
      assert.match(asked[0].detail, /git checkout --theirs -- d\.txt\ngit add -- d\.txt$/);
      assert.equal(read('d.txt'), 'one\nTWO\n');
      assert.deepEqual(state().working.conflicts, [{ status: 'U', path: 'c.txt' }]);
      await controller.action({ kind: 'undo' });
      assert.deepEqual(state().conflictFiles, both);

      // One file only, as from its row in the Changes view; with nothing left in conflict the merge is offered to continue.
      write('c.txt', lines({ 2: 'two, theirs', 3: 'three, ours', 9: 'nine, both' }));
      await controller.action({ kind: 'stage', paths: ['c.txt'] });
      asked.length = 0;
      answer = (_text, _detail, items) => (items.includes('Resolve') ? 'Resolve' : undefined);
      await controller.action({ kind: 'resolveConflicts', paths: ['d.txt'] });
      assert.equal(asked[0].message, 'Resolve the conflict automatically?');
      const whole = asked.find((question) => question.message.startsWith('Gitardo resolved conflicts'));
      assert.equal(whole?.message, 'Gitardo resolved conflicts in 1 file. No file is left in conflict: the merge can continue.');
      assert.deepEqual(whole?.items, ['Continue', 'Undo']);
      assert.deepEqual(state().working.conflicts, []);

      // With nothing to resolve it says so and asks nothing.
      asked.length = 0;
      const before = errors.length;
      await controller.action({ kind: 'resolveConflicts' });
      assert.match(errors[before], /There are no conflicts marked in the files to resolve\./);
      errors.length = before;
      assert.deepEqual(asked, []);

      answer = run;
      await controller.action({ kind: 'continue' });
      assert.equal(state().operation, null);
      assert.equal(state().rows[0].parents.length, 2);
      assert.equal(read('d.txt'), 'ONE\nTWO\n');
    } finally {
      await autoResolve(undefined);
    }
  });

  await step('shows what the rules and the AI propose for each conflict, writes only what is accepted, and takes it back', async () => {
    const lines = (changes: Record<number, string> = {}) => Array.from({ length: 12 }, (_, index) => `${changes[index] ?? `line ${index}`}\n`).join('');
    const read = (file: string) => fs.readFileSync(path.join(app, file), 'utf8');
    write('e.txt', lines());
    await git(app, ['add', '--', 'e.txt']);
    await git(app, ['commit', '-m', 'Add e']);
    await git(app, ['checkout', '-b', 'aside']);
    write('e.txt', lines({ 2: 'two, theirs', 9: 'nine, theirs' }));
    await git(app, ['commit', '-am', 'Aside, theirs']);
    await git(app, ['checkout', 'main']);
    write('e.txt', lines({ 3: 'three, ours', 9: 'nine, ours' }));
    await git(app, ['commit', '-am', 'Aside, ours']);

    // No language model can be signed in to here: one that answers as a model would takes its place.
    const lm = vscode.lm as unknown as Record<string, unknown>;
    const select = lm.selectChatModels;
    const prompts: string[] = [];
    const reply = ['<resolution>\n', 'nine, ours', ' and theirs\n', '</resolution>\n<reason>Both sides renamed line nine.</reason>\n', '<confidence>high</confidence>'];
    // Two models: the one chosen in the settings is asked, with how much it thinks.
    const requests: { configuration?: Record<string, unknown> }[] = [];
    const first = {
      id: 'test-first',
      name: 'First model',
      vendor: 'test',
      family: 'first',
      sendRequest: async () => {
        throw new Error('The first model was asked.');
      },
    };
    const model = {
      id: 'test-chosen',
      name: 'Chosen model',
      vendor: 'test',
      family: 'chosen',
      sendRequest: async (messages: vscode.LanguageModelChatMessage[], options: { configuration?: Record<string, unknown> }) => {
        requests.push(options);
        prompts.push(messages.map((each) => each.content.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : '')).join('')).join('\n'));
        return {
          text: (async function* () {
            for (const chunk of reply) {
              await sleep(150);
              yield chunk;
            }
          })(),
        };
      },
    };
    let models: unknown[] = [first, model];
    lm.selectChatModels = async () => models;
    const settings = () => vscode.workspace.getConfiguration('gitardo');
    const set = (key: string, value: boolean | string | undefined) => settings().update(key, value, vscode.ConfigurationTarget.Global);
    await set('conflicts.autoResolve', true);
    await set('conflicts.ai', true);
    try {
      await until('the setting of the AI in the state', () => state().resolveWithAI);

      // The model is chosen among those VS Code has, then how much it thinks.
      const offered: string[][] = [];
      choose = (items, options) => {
        offered.push(items.map((item) => item.label));
        return options.title === 'The model that resolves conflicts' ? byLabel('Chosen model')(items) : byLabel('High')(items);
      };
      await vscode.commands.executeCommand('gitardo.chooseConflictModel');
      assert.deepEqual(offered, [
        ['$(check) The first model of VS Code', 'First model', 'Chosen model'],
        ['$(check) As the model is set up in VS Code', 'Low', 'Medium', 'High', 'Extra high', 'Max'],
      ]);
      assert.equal(settings().get('conflicts.aiModel'), 'test-chosen');
      assert.equal(settings().get('conflicts.aiEffort'), 'high');
      asked.length = 0;
      answer = run;
      await controller.action({ kind: 'merge', ref: 'aside' });
      const stopped = asked.find((question) => /stopped: 1 file has conflicts/.test(question.message));
      assert.deepEqual(stopped?.items, ['Resolve Automatically', 'Resolve with AI', 'Show Log']);
      const marked = read('e.txt');

      // The rules propose for the first conflict; the model is asked about the second, and its answer shows as it comes.
      posted.length = 0;
      addressed.length = 0;
      await fromWebview({ type: 'reviewConflicts', ai: true });
      const answered = await until('the answer of the model', () => {
        const review = lastReview();
        return review?.files[0]?.conflicts[1]?.proposal?.source === 'ai' && review;
      });
      const thinking = posted.flatMap((message) => (message.type === 'review' && message.review ? message.review.files[0].conflicts[1].asking ?? [] : []));
      assert.ok(thinking.some((asking) => asking.state === 'waiting' || asking.state === 'thinking'));
      assert.ok(thinking.some((asking) => asking.state === 'thinking' && asking.text === 'nine, ours'));
      assert.equal(prompts.length, 1);
      assert.match(prompts[0], /^Resolve one merge conflict in the file e\.txt\./);
      assert.match(prompts[0], /"Incoming" is the branch being merged, in the commit "Aside, theirs"\./);
      assert.match(prompts[0], /<current>\nnine, ours\n<\/current>\n<incoming>\nnine, theirs\n<\/incoming>/);
      const [rules, ai] = answered.files[0].conflicts;
      assert.equal(rules.proposal?.source, 'rules');
      assert.deepEqual(ai.proposal, {
        source: 'ai',
        from: 14,
        to: 19,
        text: 'nine, ours and theirs\n',
        reason: 'Both sides renamed line nine.',
        confidence: 'high',
        newLines: 1,
        model: 'Chosen model',
      });
      assert.equal(answered.model, 'Chosen model · high effort');
      assert.deepEqual(requests[0].configuration, { reasoningEffort: 'high' });
      assert.equal(answered.asking, false);
      assert.equal(read('e.txt'), marked);

      // The same answer shows in the Flow Merge, beside the proposal of the rules.
      interface Panel {
        initSent: boolean;
        currentModel: { proposals?: { proposal: { source: string } }[] } | undefined;
      }
      const panels = () => flowDiff.merge.all() as unknown as Panel[];
      await vscode.commands.executeCommand('gitardo.openInFlowMerge', vscode.Uri.file(path.join(app, 'e.txt')));
      const [panel] = await until('the Flow Merge', () => (panels().length ? panels() : undefined));
      assert.deepEqual(
        panel.currentModel?.proposals?.map((each) => each.proposal.source),
        ['rules', 'ai'],
      );
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');

      // Only what is accepted is written: the file left with no conflict is staged, and the review says what it did.
      await fromWebview({ type: 'reviewConflicts' });
      const tab = view('conflicts');
      logged.length = 0;
      posted.length = 0;
      addressed.length = 0;
      await internals.onMessage(tab, { type: 'writeResolutions', accepted: [{ path: 'e.txt', key: rules.key }, { path: 'e.txt', key: ai.key }] });
      assert.deepEqual(
        logged.filter((line) => line.startsWith('> ')),
        ['> write e.txt', '> git add -- e.txt'],
      );
      assert.equal(read('e.txt'), lines({ 2: 'two, theirs', 3: 'three, ours', 9: 'nine, ours and theirs' }));
      assert.deepEqual(state().working.conflicts, []);
      const after = await until('the report', () => lastReview()?.report && lastReview());
      assert.deepEqual(after.report, { resolved: 2, files: 1, staged: 1, fromAI: 1 });
      assert.equal(after.conflicted, 0);

      // Undo puts the conflicts back, with the sides named as git names them then.
      answer = run;
      await controller.action({ kind: 'undo' });
      const unnamed = (text: string) => text.replace(/^(<{7}|>{7}) .*$/gm, '$1');
      assert.equal(unnamed(read('e.txt')), unnamed(marked));
      assert.equal(state().working.conflicts.length, 1);

      // Without the model chosen, or without any, asking says why it could not.
      models = [first];
      posted.length = 0;
      addressed.length = 0;
      await internals.onMessage(tab, { type: 'askAI', conflicts: [{ path: 'e.txt', key: ai.key }] });
      const gone = await until('the failure without the model chosen', () => {
        const asking = lastReview()?.files[0]?.conflicts[1]?.asking;
        return asking?.state === 'failed' && asking;
      });
      assert.match(gone.state === 'failed' ? gone.error : '', /The model chosen to resolve conflicts, test-chosen, is not available in VS Code/);
      models = [];
      posted.length = 0;
      addressed.length = 0;
      await internals.onMessage(tab, { type: 'askAI', conflicts: [{ path: 'e.txt', key: ai.key }] });
      const failed = await until('the failure', () => {
        const asking = lastReview()?.files[0]?.conflicts[1]?.asking;
        return asking?.state === 'failed' && asking;
      });
      assert.match(failed.state === 'failed' ? failed.error : '', /No language model is available in VS Code/);
    } finally {
      lm.selectChatModels = select;
      choose = () => undefined;
      await set('conflicts.aiModel', undefined);
      await set('conflicts.aiEffort', undefined);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await set('conflicts.autoResolve', undefined);
      await set('conflicts.ai', undefined);
      answer = run;
      if (state().operation) await controller.action({ kind: 'abort' });
    }
    assert.equal(state().operation, null);
    assert.deepEqual(
      vscode.workspace.textDocuments.filter((document) => document.isDirty).map((document) => document.uri.toString()),
      [],
    );
  });

  await step('names who changed each line of a file, what is typed as not committed, and stops when asked', async () => {
    const before = errors.length;
    const uri = vscode.Uri.file(path.join(app, 'a.txt'));
    const editor = await vscode.window.showTextDocument(uri);
    const count = editor.document.getText().split('\n').filter(Boolean).length;
    assert.equal(fileBlame.linesOf(uri), undefined);
    await vscode.commands.executeCommand('gitardo.toggleFileBlame');
    const lines = await until('the blame', () => fileBlame.linesOf(uri));
    assert.equal(lines.length, count);
    assert.ok(lines.every((line) => line?.committed && line.author === 'Gitardo Test' && line.summary), JSON.stringify(lines));

    // A line that is typed is not committed, at once and when git has been asked.
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), 'typed\n'));
    const typed = () => fileBlame.linesOf(uri)?.map((line) => line?.committed);
    const after = [false, ...Array<boolean>(count).fill(true)].join();
    // Whole lines leave the ones after them as they were, with no need to ask.
    assert.equal(typed()?.join(), after);
    await until('the blame of what is not saved', () => typed()?.join() === after);
    await sleep(1000);
    assert.equal(typed()?.join(), after);

    // The button of the editor names the file.
    await vscode.commands.executeCommand('gitardo.hideFileBlame', uri);
    assert.equal(fileBlame.linesOf(uri), undefined);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    // A file that is in no commit has no one to name, and is told so rather than shown empty.
    write('fresh.txt', 'x\n');
    try {
      const fresh = vscode.Uri.file(path.join(app, 'fresh.txt'));
      await vscode.window.showTextDocument(fresh);
      await vscode.commands.executeCommand('gitardo.toggleFileBlame');
      assert.equal(fileBlame.linesOf(fresh), undefined);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(path.join(app, 'fresh.txt'));
    }
    assert.equal(errors.length, before);
  });

  await step('opens the commit of a line and the file as it was before it, blames every file when asked, and re-reads when whitespace is ignored', async () => {
    const before = errors.length;
    const setting = (name: string) => vscode.workspace.getConfiguration('gitardo').get(name);
    const tabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    const uri = vscode.Uri.file(path.join(app, 'a.txt'));
    const show = async (index: number) => {
      const editor = await vscode.window.showTextDocument(uri);
      editor.selection = new vscode.Selection(index, 0, index, 0);
    };
    await show(0);
    await vscode.commands.executeCommand('gitardo.showFileBlame', uri);
    const lines = await until('the blame', () => fileBlame.linesOf(uri));
    const index = lines.findIndex((line) => line?.previous);
    const changed = lines[index];
    assert.ok(changed?.previous, 'a line changed by a commit that came after the one that added the file');

    // The commit of the line, in a tab of its own.
    await show(index);
    await vscode.commands.executeCommand('gitardo.openLineCommit');
    await until('the tab of the commit', () =>
      tabs().some((tab) => tab.input instanceof vscode.TabInputWebview && tab.label.startsWith(changed.hash.slice(0, 7))),
    );

    // The file as it was before that commit, named after the commit it is of, with the blame it had then.
    await show(index);
    await vscode.commands.executeCommand('gitardo.blamePrevious');
    const past = await until('the file as it was', () => {
      const active = vscode.window.activeTextEditor;
      return active?.document.uri.scheme === 'gitardo' ? active.document : undefined;
    });
    assert.ok(past.uri.path.endsWith(`a (${changed.previous.hash.slice(0, 7)}).txt`), past.uri.path);
    assert.equal(past.getText(), (await git(app, ['show', `${changed.previous.hash}:a.txt`])).stdout);
    const earlier = await until('its blame', () => fileBlame.linesOf(past.uri));
    assert.ok(earlier.length > 0 && earlier.every((line) => line?.committed && line.hash !== changed.hash), JSON.stringify(earlier));

    // Every file that comes in sight, but for the ones it is hidden in.
    const name = (await git(app, ['ls-files'])).stdout.split('\n').find((tracked) => tracked && tracked !== 'a.txt');
    assert.ok(name, 'another file in a commit');
    const other = vscode.Uri.file(path.join(app, name));
    await vscode.commands.executeCommand('gitardo.toggleBlameEveryFile');
    try {
      assert.equal(setting('fileBlame.everyFile'), true);
      await vscode.window.showTextDocument(other);
      await until('the blame of a file it was not asked for', () => fileBlame.linesOf(other));
      await vscode.commands.executeCommand('gitardo.hideFileBlame', other);
      await show(index);
      await vscode.window.showTextDocument(other);
      await sleep(800);
      assert.equal(fileBlame.linesOf(other), undefined);
      // Shown again when asked, as a file that only has it because every file does.
      await vscode.commands.executeCommand('gitardo.showFileBlame', other);
      await until('the blame it was asked for', () => fileBlame.linesOf(other));
    } finally {
      await vscode.commands.executeCommand('gitardo.toggleBlameEveryFile');
    }
    assert.equal(setting('fileBlame.everyFile'), false);
    // The ones that were asked for keep their blame.
    await sleep(500);
    assert.ok(fileBlame.linesOf(uri) && fileBlame.linesOf(other));

    // Whitespace: git is asked again, and the file still has its blame.
    await vscode.commands.executeCommand('gitardo.toggleBlameWhitespace');
    try {
      assert.equal(setting('blame.ignoreWhitespaceAndMoves'), true);
      await sleep(1500);
      assert.equal(fileBlame.linesOf(uri)?.length, lines.length);
    } finally {
      await vscode.commands.executeCommand('gitardo.toggleBlameWhitespace');
    }
    assert.equal(setting('blame.ignoreWhitespaceAndMoves'), false);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.equal(errors.length, before);
  });

  await step('blames the line under the cursor without errors, and can be switched off', async () => {
    const before = errors.length;
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(path.join(app, 'a.txt')));
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    // The annotation is a decoration, which the API gives no way to read back: this only shows that making it does not fail.
    await sleep(1500);
    await vscode.commands.executeCommand('gitardo.toggleBlame');
    assert.equal(vscode.workspace.getConfiguration('gitardo').get('blame.enabled'), false);
    await vscode.commands.executeCommand('gitardo.toggleBlame');
    assert.equal(vscode.workspace.getConfiguration('gitardo').get('blame.enabled'), true);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.equal(errors.length, before);
  });

  await step('sends the commits to the graph once, not again each time a file changes', async () => {
    const graph = view('graph');
    const sent: Extract<HostMessage, { type: 'state' }>[] = [];
    const postMessage = graph.postMessage.bind(graph);
    graph.postMessage = (outgoing: HostMessage) => {
      if (outgoing.type === 'state') sent.push(outgoing);
      return postMessage(outgoing);
    };
    const latest = (what: string, wanted: (sent: RepoState) => boolean) =>
      until(what, () => [...sent].reverse().find((outgoing) => outgoing.state && wanted(outgoing.state)));
    try {
      const commits = state().rows.length;
      write('first.txt', '1\n');
      let outgoing = await latest('the state with one change', (told) => told.changes === 1);
      // The row of the uncommitted changes is new, and moves the lines of the graph: everything is sent.
      assert.equal(outgoing.sameRows, undefined);
      assert.equal(outgoing.state!.rows.length, commits + 1);

      write('second.txt', '2\n');
      outgoing = await latest('the state with two changes', (told) => told.changes === 2);
      assert.equal(outgoing.sameRows, true);
      assert.deepEqual(
        outgoing.state!.rows.map((row) => row.subject),
        ['Uncommitted changes (2)'],
      );
      // What the controller itself knows is whole.
      assert.equal(state().rows.length, commits + 1);

      await git(app, ['add', '.']);
      await git(app, ['commit', '-m', 'Two files']);
      outgoing = await latest('the state with the new commit', (told) => told.changes === 0);
      assert.equal(outgoing.sameRows, undefined);
      assert.equal(outgoing.state!.rows[0].subject, 'Two files');
      assert.equal(outgoing.state!.rows.length, commits + 1);
    } finally {
      graph.postMessage = postMessage;
    }
  });

  await step('tells the Changes view which files are not saved in an editor, and saves them', async () => {
    const exclude = path.join(app, '.git', 'info', 'exclude');
    const excluded = fs.readFileSync(exclude, 'utf8');
    fs.writeFileSync(exclude, `${excluded}\n*.log\n`);
    write('notes.log', 'ignored\n');
    const from = posted.length;
    const changes = view('changes');
    const told = (what: string, paths: string[]) =>
      until(what, () =>
        posted
          .slice(from)
          .some(
            (message, index) => message.type === 'unsaved' && JSON.stringify(message.paths) === JSON.stringify(paths) && addressed[from + index] === changes,
          ),
      );
    const edit = async (file: string) => {
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(path.join(app, file)));
      await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), 'edited\n'));
    };
    try {
      // A file git sees no change in, one that git ignores, and another.
      await edit('first.txt');
      await told('first.txt not saved', ['first.txt']);
      await edit('notes.log');
      await edit('second.txt');
      await told('both not saved, and not the ignored one', ['first.txt', 'second.txt']);

      await fromWebview({ type: 'save', paths: ['first.txt'] });
      await told('first.txt saved', ['second.txt']);
      assert.equal(fs.readFileSync(path.join(app, 'first.txt'), 'utf8'), 'edited\n1\n');
      await until('first.txt changed on disk', () => state().working.unstaged.some((file) => file.path === 'first.txt'));

      for (const file of ['second.txt', 'notes.log']) {
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(app, file)));
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      await told('nothing left unsaved', []);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await git(app, ['checkout', '--', 'first.txt']);
      fs.rmSync(path.join(app, 'notes.log'), { force: true });
      fs.writeFileSync(exclude, excluded);
      // The reads that the files put back ask for, also once VS Code's Git extension has looked at them, happen here and
      // not in the next step: it goes on when the views have been told nothing for two seconds.
      for (let seen = -1; seen !== posted.length; ) {
        seen = posted.length;
        await sleep(2000);
      }
    }
  });

  await step('tells the views the graph is loading while a filter, a scope or the next page is read', async () => {
    const graph = view('graph');
    /** What the views were told from then on: the loading, and which filter each state was for. */
    const told = (from: number) =>
      posted.slice(from).flatMap((message) => {
        if (message.type === 'loading') return [`loading ${message.what}`];
        if (message.type === 'state') return [`state ${message.state?.filter?.kind ?? 'none'}`];
        return [];
      });
    const sequence = async (message: WebviewMessage) => {
      const from = posted.length;
      await internals.onMessage(graph, message);
      return told(from);
    };
    assert.deepEqual(await sequence({ type: 'setFilter', filter: { kind: 'path', path: 'b.txt' } }), ['loading filter', 'state path', 'loading null']);
    assert.deepEqual(await sequence({ type: 'loadMore' }), ['loading more', 'state path', 'loading null']);
    assert.deepEqual(await sequence({ type: 'setFilter', filter: null }), ['loading filter', 'state none', 'loading null']);
    assert.deepEqual(await sequence({ type: 'setScope', scope: { kind: 'kinds', kinds: ['branch'] } }), ['loading filter', 'state none', 'loading null']);
    await controller.setScope(null);

    // Another repository: the views wait for its commits as for those of a filter.
    const home = state().root;
    const other = state().repos.find((repo) => repo.root !== home);
    assert.ok(other, 'the workspace has another repository');
    const switched = await sequence({ type: 'selectRepo', root: other.root });
    assert.deepEqual(switched.filter((line) => line.startsWith('loading')), ['loading filter', 'loading null']);
    assert.ok(switched.indexOf('state none') < switched.indexOf('loading null'), switched.join(', '));
    assert.ok(switched.includes('state none'), switched.join(', '));
    await controller.selectRepo(home);

    // Reads that overlap are one wait, over when the last one is.
    const from = posted.length;
    await Promise.all([internals.onMessage(graph, { type: 'loadMore' }), internals.onMessage(graph, { type: 'loadMore' })]);
    const loading = told(from).filter((line) => line.startsWith('loading'));
    assert.deepEqual(loading, ['loading more', 'loading null']);

    // In a repository that keeps changing, as a large one does while it builds, the reads follow one another: the wait
    // is over with the first that started after it, not with the last of them.
    let changing = true;
    const stop = setTimeout(() => (changing = false), 10_000);
    const changes = (async () => {
      while (changing) {
        void controller.refresh();
        await sleep(5);
      }
    })();
    try {
      const searched = await sequence({ type: 'setFilter', filter: { kind: 'path', path: 'b.txt' } });
      assert.ok(changing, 'the wait went on for as long as the repository changed');
      const over = searched.indexOf('loading null');
      assert.ok(over > searched.indexOf('state path') && searched.indexOf('state path') >= 0, searched.join(', '));
      assert.ok(
        controller.activity.running.some((task) => task.detail?.startsWith('Read ')),
        'the status bar says the repository is read again and again',
      );
    } finally {
      changing = false;
      clearTimeout(stop);
      await changes;
      await controller.setFilter(null);
    }
    await until('the status bar shows nothing running', () => !controller.activity.running.length);
  });

  await step('reads nothing again for what git writes for itself, such as the files of fsmonitor in a worktree', async () => {
    const home = path.join(workspace, 'app.worktrees').replace(/\\/g, '/');
    const dir = `${home}/monitored`;
    /** What each read that was asked for since the start was asked for. */
    const causes: string[] = [];
    const schedule = internals.scheduleRefresh;
    internals.scheduleRefresh = (cause, delay) => {
      causes.push(cause);
      schedule.call(controller, cause, delay);
    };
    await git(app, ['config', 'core.fsmonitor', 'true']);
    await git(app, ['worktree', 'add', '-b', 'monitored', dir, 'main']);
    try {
      // Each read runs git status in the other worktree, which has the daemon of fsmonitor leave a file in its folder
      // of git: that is no change, and does not ask for another read, which would leave one again.
      await vscode.commands.executeCommand('gitardo.refresh');
      await vscode.commands.executeCommand('gitardo.refresh');
      const cookies = path.join(app, '.git', 'worktrees', 'monitored', 'fsmonitor--daemon');
      assert.ok(fs.existsSync(cookies), 'git status in the worktree started the daemon of fsmonitor');
      // Reads asked for by what VS Code's Git extension does in the new worktree are over in a while; these never were.
      const end = Date.now() + 20_000;
      for (let before = -1; before !== causes.length; await sleep(2000)) {
        assert.ok(Date.now() < end, `the reads went on: ${causes.slice(-3).join(', ')}`);
        before = causes.length;
      }
      assert.deepEqual(
        causes.filter((cause) => /fsmonitor--daemon|\.lock /.test(cause)),
        [],
      );
    } finally {
      internals.scheduleRefresh = schedule;
      await git(app, ['config', '--unset', 'core.fsmonitor']).catch(() => undefined);
      for (const cwd of [app, dir]) await git(cwd, ['fsmonitor--daemon', 'stop']).catch(() => undefined);
      await git(app, ['worktree', 'remove', '--force', dir]).catch(() => undefined);
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      await git(app, ['worktree', 'prune']);
      await git(app, ['branch', '-D', 'monitored']).catch(() => undefined);
      await vscode.commands.executeCommand('gitardo.refresh');
    }
  });

  await step('updates the submodules after a checkout, cloning from a folder on disk once allowed, unless the settings say not to', async () => {
    const home = state().branch!;
    const config = vscode.workspace.getConfiguration('gitardo');
    const submodule = () => state().submodules.find((each) => each.path === 'vendor/lib');
    // Two branches that record two commits of lib, made in a terminal without cloning it: here there is no submodule yet.
    const first = (await git(lib, ['rev-parse', 'HEAD'])).stdout.trim();
    fs.writeFileSync(path.join(lib, 'two.txt'), 'two\n');
    await git(lib, ['add', 'two.txt']);
    await git(lib, ['commit', '-m', 'Lib two']);
    const second = (await git(lib, ['rev-parse', 'HEAD'])).stdout.trim();
    await git(app, ['checkout', '-b', 'with-lib']);
    fs.writeFileSync(path.join(app, '.gitmodules'), `[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = ${lib.replace(/\\/g, '/')}\n`);
    await git(app, ['add', '.gitmodules']);
    await git(app, ['update-index', '--add', '--cacheinfo', `160000,${first},vendor/lib`]);
    await git(app, ['commit', '-m', 'Add lib']);
    await git(app, ['checkout', '-b', 'with-lib-2']);
    await git(app, ['update-index', '--cacheinfo', `160000,${second},vendor/lib`]);
    await git(app, ['commit', '-m', 'Move lib']);
    await git(app, ['checkout', home]);
    await controller.refresh();
    try {
      // Git leaves the submodule out; the update clones it and checks out what the branch records, but git refuses to
      // clone from a folder on disk: that is asked.
      asked.length = 0;
      answer = run;
      logged.length = 0;
      const before = errors.length;
      await controller.action({ kind: 'checkout', target: 'branch', ref: 'with-lib' });
      // The refusal is logged, as every failure of git is.
      assert.ok(errors.slice(before).every((text) => text.includes("transport 'file' not allowed")), errors.slice(before).join('\n'));
      errors.length = before;
      assert.equal(state().branch, 'with-lib');
      assert.deepEqual(
        asked.map((question) => question.message),
        ['Update the submodules from a folder on disk?'],
      );
      assert.ok(logged.includes('> git checkout with-lib'), logged.join('\n'));
      assert.ok(logged.includes('> git -c protocol.file.allow=always submodule update --init --recursive'), logged.join('\n'));
      assert.deepEqual([submodule()?.head, submodule()?.ahead, submodule()?.behind], [first, 0, 0]);

      // Switched off, the submodule stays on what it had, one behind what the other branch records.
      await config.update('submodules.updateOnCheckout', false, vscode.ConfigurationTarget.Global);
      logged.length = 0;
      await controller.action({ kind: 'checkout', target: 'branch', ref: 'with-lib-2' });
      assert.ok(!logged.some((line) => line.includes('submodule update')), logged.join('\n'));
      assert.deepEqual([submodule()?.recorded, submodule()?.head, submodule()?.behind], [second, first, 1]);
    } finally {
      answer = () => undefined;
      await config.update('submodules.updateOnCheckout', undefined, vscode.ConfigurationTarget.Global);
      await git(app, ['submodule', 'deinit', '--force', '--all']);
      await git(app, ['checkout', home]);
      fs.rmSync(path.join(app, 'vendor'), { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      // VS Code's own git extension keeps the submodule open, and on Windows its clone with it: what is left of it stays
      // with the workspace, which is thrown away.
      try {
        fs.rmSync(path.join(app, '.git', 'modules'), { recursive: true, force: true });
      } catch {}
      await git(app, ['branch', '-D', 'with-lib', 'with-lib-2']);
      await git(lib, ['reset', '--hard', first]);
      await controller.refresh();
    }
    assert.deepEqual(state().submodules, []);
  });

  await step('changes the message of the last commit, of an older one after asking, and warns when it is pushed', async () => {
    const home = state().branch!;
    const message = async (ref: string) => (await git(app, ['log', '-1', '--format=%B', ref])).stdout.trimEnd();
    await git(app, ['checkout', '-b', 'reword']);
    for (const [file, text] of [['one', 'Reword one\n\nIts body.'], ['two', 'Reword two\n\nKept under the new subject.'], ['three', 'Reword three']]) {
      fs.writeFileSync(path.join(app, `${file}.txt`), `${file}\n`);
      await git(app, ['add', `${file}.txt`]);
      await git(app, ['commit', '-m', text]);
    }
    await controller.refresh();
    try {
      // The last one is amended, without a question, and what is staged stays out of it.
      fs.writeFileSync(path.join(app, 'three.txt'), 'staged\n');
      await git(app, ['add', 'three.txt']);
      asked.length = 0;
      answer = run;
      await controller.action({ kind: 'reword', hash: state().head!, message: 'Reword three, new\n\nWith a body now.' });
      assert.equal(asked.length, 0, JSON.stringify(asked));
      assert.equal(await message('HEAD'), 'Reword three, new\n\nWith a body now.');
      assert.deepEqual(state().working.staged, [{ status: 'M', path: 'three.txt' }]);

      // An older one is asked first, and the changes not committed come back after.
      const one = (await git(app, ['rev-parse', 'HEAD~2'])).stdout.trim();
      await controller.action({ kind: 'reword', hash: one, message: 'Reword one, new\n\nIts body.' });
      assert.deepEqual(
        asked.map((question) => question.message),
        [`Edit the message of ${one.slice(0, 7)}?`],
      );
      assert.ok(asked[0].detail.includes('the 2 commits after it are made again'), asked[0].detail);
      assert.equal(await message('HEAD~2'), 'Reword one, new\n\nIts body.');
      assert.equal(await message('HEAD'), 'Reword three, new\n\nWith a body now.');
      assert.equal(fs.readFileSync(path.join(app, 'three.txt'), 'utf8'), 'staged\n');
      assert.equal(state().operation, null);

      // From the interactive rebase a new subject keeps the body.
      const two = (await git(app, ['rev-parse', 'HEAD~1'])).stdout.trim();
      const steps: RebaseStep[] = [
        { action: 'reword', hash: two, message: 'Reword two, new', keepBody: true },
        { action: 'pick', hash: state().head! },
      ];
      // The interactive rebase does not set the changes aside on its own.
      await git(app, ['stash', 'push', '--quiet']);
      await controller.action({ kind: 'rebaseInteractive', base: (await git(app, ['rev-parse', `${two}~1`])).stdout.trim(), steps });
      assert.equal(await message('HEAD~1'), 'Reword two, new\n\nKept under the new subject.');

      // Once pushed, the force push it takes is said, and asked.
      await git(app, ['push', '--quiet', 'origin', 'reword']);
      await controller.refresh();
      asked.length = 0;
      await controller.action({ kind: 'reword', hash: state().head!, message: 'Reword three, again' });
      assert.equal(asked.length, 1);
      assert.ok(asked[0].detail.includes('is pushed already, on origin/reword'), asked[0].detail);
      assert.equal(await message('HEAD'), 'Reword three, again');
    } finally {
      answer = () => undefined;
      await git(app, ['checkout', '--force', home]);
      await git(app, ['stash', 'drop', '--quiet']).catch(() => undefined);
      await git(app, ['branch', '-D', 'reword']);
      await git(app, ['push', '--quiet', 'origin', '--delete', 'reword']).catch(() => undefined);
      await controller.refresh();
    }
  });

  await step('asks before applying a stash, saying what it would stop on, and before deleting a tag or a merged branch', async () => {
    const start = state().head!;
    const apply = async () => {
      asked.length = 0;
      await controller.action({ kind: 'stashApply', ref: 'stash@{0}' });
      assert.deepEqual(
        asked.map((question) => question.message),
        ['Apply stash@{0}?'],
      );
      return asked[0].detail;
    };
    write('preview.txt', 'one\n');
    await git(app, ['add', 'preview.txt']);
    await git(app, ['commit', '-m', 'Add preview']);
    write('preview.txt', 'stashed\n');
    write('along.txt', 'along\n');
    await git(app, ['stash', 'push', '--include-untracked', '--quiet', '-m', 'preview']);
    await controller.refresh();
    try {
      // Against a commit that changed the same line, cancelled.
      write('preview.txt', 'committed\n');
      await git(app, ['commit', '-am', 'Change preview']);
      await controller.refresh();
      answer = () => undefined;
      let detail = await apply();
      assert.ok(detail.includes('This will stop with conflicts in 1 file:\npreview.txt'), detail);
      assert.equal(state().changes, 0);

      // With the file changed and not committed, git would refuse.
      await git(app, ['reset', '--hard', '--quiet', 'HEAD~1']);
      write('preview.txt', 'dirty\n');
      await controller.refresh();
      detail = await apply();
      assert.ok(detail.includes('Git will refuse it and change nothing, as 1 file it changes has changes that are not committed'), detail);

      // Its untracked file there again is left alone.
      await git(app, ['checkout', '--', 'preview.txt']);
      write('along.txt', 'here\n');
      await controller.refresh();
      detail = await apply();
      assert.ok(detail.includes('An untracked file it took along is there again') && detail.includes('along.txt'), detail);

      // Nothing in the way: no conflicts, and it runs.
      fs.rmSync(path.join(app, 'along.txt'));
      await controller.refresh();
      answer = run;
      detail = await apply();
      assert.ok(detail.includes('No conflicts expected.') && detail.includes('it stays in the list'), detail);
      assert.equal(fs.readFileSync(path.join(app, 'preview.txt'), 'utf8'), 'stashed\n');
      assert.equal(state().stashes.length, 1);

      // A tag, and a branch whose commits are merged.
      await git(app, ['tag', 'to-delete']);
      await git(app, ['branch', 'merged-here']);
      await controller.refresh();
      asked.length = 0;
      await controller.action({ kind: 'deleteTag', name: 'to-delete' });
      await controller.action({ kind: 'deleteBranch', name: 'merged-here' });
      assert.deepEqual(
        asked.map((question) => question.message),
        ['Delete tag to-delete?', 'Delete branch merged-here?'],
      );
      assert.ok(asked[0].detail.includes('A remote that has it keeps it.'), asked[0].detail);
      assert.ok(asked[1].detail.includes('none is lost') && asked[1].detail.endsWith('git branch -d merged-here'), asked[1].detail);
      assert.ok(!state().tags.some((tag) => tag.name === 'to-delete'));
      assert.ok(!state().branches.some((branch) => branch.name === 'merged-here'));
    } finally {
      answer = () => undefined;
      await git(app, ['reset', '--hard', '--quiet', start]);
      fs.rmSync(path.join(app, 'along.txt'), { force: true });
      await git(app, ['stash', 'drop', '--quiet']).catch(() => undefined);
      await git(app, ['tag', '-d', 'to-delete']).catch(() => undefined);
      await git(app, ['branch', '-D', 'merged-here']).catch(() => undefined);
      await controller.refresh();
    }
    assert.equal(state().changes, 0);
  });

  await step('logged no unexpected errors', async () => {
    // The conflicting merge is the one failure the tests provoke on purpose.
    assert.deepEqual(
      errors.filter((text) => !/CONFLICT|Automatic merge failed/.test(text)),
      [],
    );
  });

  if (results.some((result) => !result.ok)) throw new Error('Some end-to-end checks failed.');
}
