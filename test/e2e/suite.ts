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
import type { HostMessage, RepoState, ViewKind, WebviewMessage } from '../../src/shared/protocol';

/** The parts of the controller that are private to everyone but these tests. */
interface Internals {
  state: RepoState | null;
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
  const onMessage = internals.onMessage.bind(controller);
  internals.onMessage = (webview, message) => {
    received.push(message);
    return onMessage(webview, message);
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
