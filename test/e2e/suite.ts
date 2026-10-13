// End-to-end checks that run inside a real Extension Host, against the repositories test/e2e/run.mjs prepared.
// They drive the extension through its commands and its controller, with VS Code's prompts answered by stubs.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CONFLICT, INDEX, contentUri } from '../../src/extension/content';
import type { GitarApi } from '../../src/extension/extension';
import { git } from '../../src/git/exec';
import { Repo } from '../../src/git/repo';
import type { Filter, HostMessage, RepoState, ViewKind, WebviewMessage } from '../../src/shared/protocol';

/** The parts of the controller that are private to everyone but these tests. */
interface Internals {
  state: RepoState | null;
  /** How many commits are asked of git, and what narrows them. */
  limit: number;
  filter: Filter | null;
  views: Map<unknown, ViewKind>;
  onMessage(webview: unknown, message: WebviewMessage): Promise<void>;
  post(message: HostMessage, to?: unknown): void;
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

export async function run(): Promise<void> {
  const results: Result[] = [];
  const report = () => {
    const file = process.env.GITAR_E2E_RESULTS;
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

  const extension = vscode.extensions.getExtension<GitarApi>('pozzi.gitar');
  assert.ok(extension, 'the extension is installed');
  const { controller, log } = await extension.activate();
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
    await vscode.commands.executeCommand('gitar.openGraph');
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

  await step('the four views of the side bar load too, and the graph opens as an editor tab', async () => {
    const before = received.filter((incoming) => incoming.type === 'ready').length;
    // The stashes start folded, and a folded view is not loaded: its command unfolds it.
    for (const name of ['Changes', 'Commits', 'Branches', 'Stashes']) await vscode.commands.executeCommand(`gitar.open${name}`);
    await until('the webviews of the side bar', () => kinds().join() === 'branches,changes,commits,graph,stashes');
    await vscode.commands.executeCommand('gitar.openInEditor');
    await until('the new webviews to say they are ready', () => received.filter((incoming) => incoming.type === 'ready').length >= before + 5);
    assert.deepEqual(kinds(), ['branches', 'changes', 'commits', 'graph', 'graph', 'stashes']);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await until('the editor tab to detach', () => internals.views.size === 5);
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
    await vscode.workspace.getConfiguration('gitar').update('commandPreview', 'all', vscode.ConfigurationTarget.Global);
    try {
      write('a.txt', 'one\ntwo\nthree\n');
      await vscode.commands.executeCommand('gitar.refresh');
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
      await vscode.workspace.getConfiguration('gitar').update('commandPreview', undefined, vscode.ConfigurationTarget.Global);
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

  await step('serves file contents at a commit and in the index, and opens diffs', async () => {
    const head = state().head!;
    const at = async (ref: string) => (await vscode.workspace.openTextDocument(contentUri(state().root, ref, 'a.txt'))).getText();
    assert.equal(await at(head), 'one\ntwo\n');
    assert.equal(await at(state().rows.at(-1)!.hash), 'one\n');
    write('a.txt', 'one\ntwo\nstaged\n');
    await controller.action({ kind: 'stage', paths: ['a.txt'] });
    assert.equal(await at(INDEX), 'one\ntwo\nstaged\n');

    await fromWebview({ type: 'openDiff', source: { kind: 'staged' }, file: { status: 'M', path: 'a.txt' } });
    const tab = await until('the diff editor', () => vscode.window.tabGroups.activeTabGroup.activeTab);
    assert.ok(tab.input instanceof vscode.TabInputTextDiff, 'a diff editor is open');
    assert.equal(tab.input.original.scheme, 'gitar');
    assert.match(tab.label, /a\.txt/);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await controller.action({ kind: 'unstageAll' });
    answer = run;
    await controller.action({ kind: 'discardAll' });
  });

  await step('answers the webviews: commit details, hunks and comparisons', async () => {
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

  await step('gives the commits to the views that list them, and spares the others', async () => {
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
    assert.equal((await told('commits')).rows.length, commits);
    for (const kind of ['branches', 'stashes', 'changes'] as const) {
      const seen = await told(kind);
      assert.deepEqual(seen.rows, [], `no commits for the ${kind} view`);
      assert.deepEqual(
        seen.branches.map((branch) => branch.name),
        ['feature', 'main', 'merged', 'topic'],
      );
    }
  });

  await step('compares branches, tags and typed revisions, in the view that asked or in the graph', async () => {
    const head = state().head!;
    const hashOf = (name: string) => state().branches.find((branch) => branch.name === name)!.hash;
    const tag = state().tags[0];
    /** The comparison that was sent, and the view it was sent to. */
    const compared = () => {
      const index = posted.findIndex((outgoing) => outgoing.type === 'compare');
      const outgoing = posted[index];
      return outgoing?.type === 'compare' ? { ...outgoing.comparing, view: internals.views.get(addressed[index]) } : null;
    };
    const forget = () => {
      posted.length = 0;
      addressed.length = 0;
    };

    // The command: both sides are asked, and the graph in the panel shows the answer.
    const titles: string[] = [];
    let offered: string[] = [];
    choose = (items, options) => {
      titles.push(options.title ?? '');
      offered = items.map((item) => item.label);
      return byLabel(titles.length === 1 ? '$(git-branch) feature' : '$(target) main')(items);
    };
    forget();
    await vscode.commands.executeCommand('gitar.compare');
    assert.deepEqual(titles, ['Compare', 'Compare feature with']);
    // Everything but the side that is already chosen.
    assert.deepEqual(offered, [
      '$(edit) Enter a hash or a revision…',
      '$(target) main',
      'Branches',
      '$(git-branch) merged',
      '$(git-branch) topic',
      'Remote branches',
      '$(cloud) origin/main',
      'Tags',
      '$(tag) v1',
    ]);
    assert.deepEqual(compared(), { from: hashOf('feature'), to: head, fromName: 'feature', toName: 'main', view: 'graph' });

    // Asked by the branches, with something typed: they show it themselves.
    choose = (items, options) => byLabel(options.title === 'Compare' ? /Enter a hash/ : '$(git-branch) topic')(items);
    inputs = ['HEAD~1'];
    forget();
    await internals.onMessage(view('branches'), { type: 'compare' });
    const parent = (await git(app, ['rev-parse', 'HEAD~1'])).stdout.trim();
    assert.deepEqual(compared(), { from: parent, to: hashOf('topic'), fromName: 'HEAD~1', toName: 'topic', view: 'branches' });

    // "Compare with…" in a menu gives one side; a hash that is typed is named by its short form.
    choose = byLabel(/Enter a hash/);
    inputs = [parent];
    forget();
    await internals.onMessage(view('commits'), { type: 'compare', from: { name: tag.name, hash: tag.hash } });
    assert.deepEqual(compared(), { from: tag.hash, to: parent, fromName: 'v1', toName: parent.slice(0, 7), view: 'commits' });

    // The stashes have no room for it: it goes to the graph.
    choose = byLabel('$(git-branch) merged');
    forget();
    await internals.onMessage(view('stashes'), { type: 'compare', from: { name: 'main', hash: head } });
    assert.deepEqual(compared(), { from: head, to: hashOf('merged'), fromName: 'main', toName: 'merged', view: 'graph' });

    // What git does not know is said, and backing out does nothing.
    choose = byLabel(/Enter a hash/);
    inputs = ['no-such-thing'];
    forget();
    asked.length = 0;
    await vscode.commands.executeCommand('gitar.compare');
    assert.deepEqual(
      asked.map((question) => question.message),
      ['Gitar: "no-such-thing" is not a commit of this repository.'],
    );
    choose = () => undefined;
    await vscode.commands.executeCommand('gitar.compare');
    assert.equal(compared(), null);

    // A branch clicked in the side bar is shown where the commits are, and nowhere else.
    forget();
    await internals.onMessage(view('branches'), { type: 'show', hash: hashOf('feature') });
    assert.deepEqual(posted, [
      { type: 'reveal', hash: hashOf('feature') },
      { type: 'reveal', hash: hashOf('feature') },
    ]);
    assert.deepEqual(addressed.map((webview) => internals.views.get(webview)).sort(), ['commits', 'graph']);
  });

  await step('narrows the graph to the history of a file, switching repository if needed', async () => {
    await vscode.commands.executeCommand('gitar.fileHistory', vscode.Uri.file(path.join(app, 'b.txt')));
    assert.deepEqual(state().filter, { kind: 'path', path: 'b.txt' });
    // On every branch: `feature` changes the file too.
    assert.deepEqual(subjects(), ['Add feature', 'Add b']);
    await controller.setFilter(null);
    assert.equal(state().filter, null);

    await vscode.commands.executeCommand('gitar.fileHistory', vscode.Uri.file(path.join(lib, 'lib.txt')));
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
    await vscode.commands.executeCommand('gitar.refresh');
    await internals.onMessage(graph, { type: 'setScope', scope: { kind: 'refs', refs: ['refs/heads/scoped', 'refs/heads/main'] } });
    assert.deepEqual(state().scope, { kind: 'refs', refs: ['refs/heads/scoped', 'refs/heads/main'] });
    await git(app, ['branch', '-D', 'scoped']);
    await vscode.commands.executeCommand('gitar.refresh');
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
    await vscode.commands.executeCommand('gitar.refresh');
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
    await vscode.commands.executeCommand('gitar.refresh');
    await internals.onMessage(graph, { type: 'setFavorite', ref: 'refs/heads/liked', favorite: true });
    assert.equal(state().favorites.length, 3);
    await git(app, ['branch', '-D', 'liked']);
    await vscode.commands.executeCommand('gitar.refresh');
    assert.deepEqual(state().favorites, ['refs/heads/feature', 'refs/remotes/origin/main']);
    await internals.onMessage(graph, { type: 'setFavorite', ref: 'refs/heads/feature', favorite: false });
    await internals.onMessage(graph, { type: 'setFavorite', ref: 'refs/remotes/origin/main', favorite: false });
    assert.deepEqual(state().favorites, []);
  });

  await step('pushes, fetches and pulls with a rebase against the remote', async () => {
    assert.equal(state().branches.find((branch) => branch.current)!.upstream!.ahead, 2);
    await controller.sync('push');
    assert.equal(state().branches.find((branch) => branch.current)!.upstream!.ahead, 0);
    await controller.sync('fetch');
    await controller.sync('pullRebase');
    assert.deepEqual(errors, []);
  });

  await step('warns about what a force push overwrites', async () => {
    // Rewrite the last commit, so that the remote has one the local branch does not.
    await git(app, ['commit', '--amend', '--allow-empty', '-m', 'Add a file, reworded']);
    await vscode.commands.executeCommand('gitar.refresh');
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

  await step('cleans up merged branches from a picker', async () => {
    let offered: string[] = [];
    choose = (items) => {
      offered = items.map((item) => `${item.label}${item.picked ? ' (ticked)' : ''}`);
      return items.filter((item) => item.picked);
    };
    answer = run;
    await vscode.commands.executeCommand('gitar.cleanupBranches');
    // `topic` points at the commit that was reworded since, so it is not merged and not offered.
    assert.deepEqual(offered, ['merged (ticked)']);
    assert.deepEqual(
      state().branches.map((branch) => branch.name),
      ['feature', 'main', 'topic'],
    );
  });

  await step('browses the reflog and shows the chosen commit in the graph', async () => {
    let entries = 0;
    choose = (items, options) => {
      if (options.title?.startsWith('Reflog')) {
        entries = items.length;
        return items[1];
      }
      return byLabel('Show in graph')(items);
    };
    posted.length = 0;
    await vscode.commands.executeCommand('gitar.reflog');
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
      await vscode.commands.executeCommand('gitar.refresh');
      assert.ok(!loaded(oldest) && state().hasMore, 'only the last commits are loaded');
      forget();
      await internals.onMessage(view('commits'), { type: 'goTo', revision: oldest });
      assert.ok(loaded(oldest), 'the history is loaded up to the commit');
      assert.deepEqual(revealed(), [`${oldest} in commits`]);
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
    await vscode.commands.executeCommand('gitar.goToCommit');
    assert.ok(revealed().includes(`${third} in graph`), `revealed: ${revealed()}`);
  });

  await step('finds commits in the whole history for a view to highlight where they are, without replacing the graph', async () => {
    const commits = view('commits');
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
    assert.deepEqual((await find({ kind: 'author', query: 'gitar test' })).hashes, hashes());
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
    inputs = ['Other Me', 'other@gitar.invalid'];
    await vscode.commands.executeCommand('gitar.switchIdentity');
    assert.deepEqual(state().identity, { name: 'Other Me', email: 'other@gitar.invalid' });
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
    assert.match(webview.html, new RegExp(`data-view="commit" data-commit="${hash}" data-root="[^"]+" data-files="tree"`));

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
    await vscode.commands.executeCommand('gitar.openGraph');
    await controller.openCommit(hash);
    assert.equal(commitViews().length, 1);
    assert.equal(tabs().filter((candidate) => candidate.label.startsWith(short)).length, 1);

    // Its parent, from the link in the page, has another. So has a revision typed in the prompt of the command.
    await internals.onMessage(webview, { type: 'openCommit', hash: parent });
    await until('the tab of the parent', () => tabs().some((candidate) => candidate.label === `${parent.slice(0, 7)} Add b`));
    await internals.onMessage(webview, { type: 'setFilesLayout', layout: 'list' });
    inputs = ['feature'];
    await vscode.commands.executeCommand('gitar.openCommit');
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
    await vscode.commands.executeCommand('gitar.remotes');
    assert.deepEqual(state().remotes, ['backup', 'origin']);
    assert.ok(logged.includes('> git remote add backup https://example.invalid/backup.git'));

    choose = pickRemote('backup', 'Rename…');
    inputs = ['mirror'];
    await vscode.commands.executeCommand('gitar.remotes');
    assert.deepEqual(state().remotes, ['mirror', 'origin']);

    choose = pickRemote('mirror', 'Remove');
    asked.length = 0;
    answer = run;
    await vscode.commands.executeCommand('gitar.remotes');
    assert.equal(asked[0].message, 'Remove remote mirror?');
    assert.deepEqual(state().remotes, ['origin']);

    await controller.selectRepo(state().repos[1].root);
    assert.deepEqual(state().remotes, []);
    asked.length = 0;
    answer = () => undefined;
    await controller.sync('push');
    assert.deepEqual(asked, [{ message: 'Gitar: this repository has no remote.', detail: '', items: ['Add Remote…'] }]);
    await controller.selectRepo(state().repos[0].root);
  });

  await step('stashes a single file and leaves the rest alone', async () => {
    write('a.txt', 'one\ntwo\nstash me\n');
    write('keep.txt', 'stays\n');
    await vscode.commands.executeCommand('gitar.refresh');
    inputs = ['only a'];
    await controller.action({ kind: 'stashPush', paths: ['a.txt'] });
    assert.equal(state().stashes.length, 1);
    assert.match(state().stashes[0].message, /only a$/);
    assert.deepEqual(state().working.unstaged, [{ status: '?', path: 'keep.txt' }]);
    assert.equal(fs.readFileSync(path.join(app, 'a.txt'), 'utf8'), 'one\ntwo\n');

    await controller.action({ kind: 'stashPop', ref: 'stash@{0}' });
    assert.equal(state().stashes.length, 0);
    assert.equal(state().changes, 2);
    answer = run;
    await controller.action({ kind: 'discardAll' });
    assert.equal(state().changes, 0);
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
    await vscode.commands.executeCommand('gitar.refresh');
    assert.equal(state().branch, 'main');
    const before = state().head!;

    await vscode.workspace.getConfiguration('gitar').update('commandPreview', 'all', vscode.ConfigurationTarget.Global);
    try {
      asked.length = 0;
      answer = run;
      await controller.action({ kind: 'cherryPickMany', hashes: [made[1], made[0]] });
      assert.equal(asked[0].message, 'Cherry-pick 2 commits?');
      assert.match(asked[0].detail, /In this order:\n\w{7} Pick one\n\w{7} Pick two\n/);
      assert.ok(asked[0].detail.endsWith(`git cherry-pick ${made[0]} ${made[1]}`));
    } finally {
      await vscode.workspace.getConfiguration('gitar').update('commandPreview', undefined, vscode.ConfigurationTarget.Global);
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
    await vscode.commands.executeCommand('gitar.refresh');
  });

  await step('follows a renamed file in its history', async () => {
    await git(app, ['mv', 'pick-one.txt', 'renamed.txt']);
    await git(app, ['commit', '-m', 'Rename a file']);
    await vscode.commands.executeCommand('gitar.fileHistory', vscode.Uri.file(path.join(app, 'renamed.txt')));
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
    await vscode.commands.executeCommand('gitar.bisectReset');
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
      vscode.workspace.getConfiguration('gitar').update('conflicts.autoResolve', value, vscode.ConfigurationTarget.Global);
    assert.equal(vscode.workspace.getConfiguration('gitar').get('conflicts.autoResolve'), false);
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
    await vscode.commands.executeCommand('gitar.resolveConflicts');
    assert.deepEqual(
      asked.map((question) => question.message),
      ['Gitar: resolving conflicts automatically is experimental, and it is switched off in the settings.'],
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
      assert.match(stopped?.message ?? '', /Gitar can resolve 2 of the 3 conflicts automatically\.$/);
      assert.deepEqual(stopped?.items, ['Resolve Automatically', 'Show Log']);

      // It asks first, saying the files it writes and the command it runs, and shows each file beside what it would become.
      const marked = read('c.txt');
      asked.length = 0;
      answer = (_text, _detail, items) => (items.includes('Preview') ? 'Preview' : undefined);
      await vscode.commands.executeCommand('gitar.resolveConflicts');
      assert.equal(asked[0].message, 'Resolve 2 of 3 conflicts automatically?');
      assert.deepEqual(asked[0].items, ['Resolve', 'Preview']);
      assert.match(asked[0].detail, /^c\.txt: 1 of 2 conflicts \(changes to lines next to each other\)\nd\.txt: 1 of 1 conflict \(/);
      assert.match(asked[0].detail, /1 conflict will be left to resolve by hand/);
      assert.match(asked[0].detail, /Gitar will write in [^\n]+:\n\nc\.txt\nd\.txt\n\nand then run:\n\ngit add -- d\.txt$/);
      assert.equal(asked[1].message, 'Resolve 2 of 3 conflicts automatically, as in the preview?');
      assert.deepEqual(asked[1].items, ['Resolve']);
      const tab = await until('the preview', () => vscode.window.tabGroups.activeTabGroup.activeTab);
      assert.match(tab.label, /^Preview of the conflicts resolved automatically/);
      const proposed = await until('what is proposed for d.txt', () =>
        vscode.workspace.textDocuments.find((document) => document.uri.scheme === 'gitar' && document.uri.path === '/d.txt' && /proposal/.test(document.uri.query)),
      );
      assert.equal(proposed.getText(), 'ONE\nTWO\n');
      // The second question was left without an answer: nothing is written.
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
      const done = asked.find((question) => question.message.startsWith('Gitar resolved conflicts'));
      assert.equal(done?.message, 'Gitar resolved conflicts in 2 files. 1 file still has conflicts to resolve by hand.');
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
      const whole = asked.find((question) => question.message.startsWith('Gitar resolved conflicts'));
      assert.equal(whole?.message, 'Gitar resolved conflicts in 1 file. No file is left in conflict: the merge can continue.');
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

  await step('blames the line under the cursor without errors, and can be switched off', async () => {
    const before = errors.length;
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(path.join(app, 'a.txt')));
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    // The annotation is a decoration, which the API gives no way to read back: this only shows that making it does not fail.
    await sleep(1500);
    await vscode.commands.executeCommand('gitar.toggleBlame');
    assert.equal(vscode.workspace.getConfiguration('gitar').get('blame.enabled'), false);
    await vscode.commands.executeCommand('gitar.toggleBlame');
    assert.equal(vscode.workspace.getConfiguration('gitar').get('blame.enabled'), true);
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

  await step('logged no unexpected errors', async () => {
    // The conflicting merge is the one failure the tests provoke on purpose.
    assert.deepEqual(
      errors.filter((text) => !/CONFLICT|Automatic merge failed/.test(text)),
      [],
    );
  });

  if (results.some((result) => !result.ok)) throw new Error('Some end-to-end checks failed.');
}
