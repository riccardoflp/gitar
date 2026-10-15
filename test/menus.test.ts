import { describe, expect, it, vi } from 'vitest';
import type { Branch, RepoState, Row, Worktree } from '../src/shared/protocol';
import { changesText, upstreamHint, worktreeOf, worktreeStatus } from '../src/shared/refs';

// The menus post what is chosen to the extension; here they are only read.
const posted = vi.hoisted(() => [] as unknown[]);
vi.mock('../src/webview/vscode', () => ({ post: (message: unknown) => posted.push(message) }));
const { branchMenu, dropMenu, worktreeMenu } = await import('../src/webview/menus');

const worktree = (overrides: Partial<Worktree>): Worktree => ({
  path: 'C:/prj/app',
  hash: 'aaa',
  branch: 'main',
  current: true,
  main: true,
  prunable: false,
  changes: 0,
  ...overrides,
});

const state = (worktrees: Worktree[], branches: Branch[], agentsWindow = true, openBranches: RepoState['openBranches'] = 'checkout') =>
  ({
    head: 'aaa',
    branch: 'main',
    branches,
    remoteBranches: [],
    tags: [],
    worktrees,
    remotes: [],
    favorites: [],
    pulls: {},
    github: null,
    scope: null,
    operation: null,
    agentsWindow,
    openBranches,
  }) as Partial<RepoState> as RepoState;

const labels = (entries: ReturnType<typeof branchMenu>) =>
  entries.flatMap((entry) => (entry && entry !== 'separator' ? [entry.label] : []));

describe('menus of branches that a worktree has', () => {
  const main: Branch = { name: 'main', hash: 'aaa', current: true };
  const login: Branch = { name: 'feature/login', hash: 'bbb', current: false };
  const plain: Branch = { name: 'plain', hash: 'ccc', current: false };
  const here = worktree({});
  const there = worktree({ path: 'C:/prj/app.worktrees/feature/login', hash: 'bbb', branch: 'feature/login', current: false, main: false });
  const repo = state([here, there], [main, login, plain]);

  it('finds the other worktree that has a branch, and not this one', () => {
    expect(worktreeOf('feature/login', repo)).toBe(there);
    expect(worktreeOf('main', repo)).toBeUndefined();
    expect(worktreeOf('plain', repo)).toBeUndefined();
  });

  it('opens the worktree of a branch instead of checking it out, and removes it instead of deleting the branch', () => {
    const menu = labels(branchMenu(login, repo, () => {}));
    expect(menu.slice(0, 4)).toEqual(['Open worktree in Agents Window', 'Open worktree in new window', 'Open terminal in worktree', expect.stringMatching(/worktree/)]);
    expect(menu).not.toContain('Check out feature/login');
    expect(menu).not.toContain('Delete');
    expect(menu).not.toContain('Create worktree…');
    expect(menu).toEqual(expect.arrayContaining(['Rename branch…', 'Rename worktree…', 'Remove worktree…', 'Remove worktree and delete branch…']));

    posted.length = 0;
    const entries = branchMenu(login, repo, () => {});
    for (const entry of entries) if (entry && entry !== 'separator' && entry.label.startsWith('Remove worktree')) entry.run();
    expect(posted).toEqual([
      { type: 'action', action: { kind: 'worktreeRemove', path: there.path, deleteBranch: false } },
      { type: 'action', action: { kind: 'worktreeRemove', path: there.path, deleteBranch: true } },
    ]);
  });

  it('checks out a branch without a worktree, or opens it in one made for it, first as a double click does', () => {
    const menu = labels(branchMenu(plain, repo, () => {}));
    expect(menu.slice(0, 2)).toEqual(['Check out plain', 'Open in worktree']);
    expect(menu).toEqual(expect.arrayContaining(['Create worktree…', 'Rename…', 'Delete']));
    expect(menu.some((label) => /worktree in|Remove worktree/.test(label))).toBe(false);

    const worktrees = state([here, there], [main, login, plain], true, 'worktree');
    expect(labels(branchMenu(plain, worktrees, () => {})).slice(0, 2)).toEqual(['Open in worktree', 'Check out plain']);
    posted.length = 0;
    const open = branchMenu(plain, worktrees, () => {}).find((entry) => entry && entry !== 'separator' && entry.label === 'Open in worktree');
    if (open && open !== 'separator') open.run();
    expect(posted).toEqual([{ type: 'action', action: { kind: 'openInWorktree', name: 'plain' } }]);
    // The branch checked out here has no worktree to open.
    expect(labels(branchMenu(main, worktrees, () => {}))).not.toContain('Open in worktree');
  });

  it('opens the main worktree from another one, which cannot be removed', () => {
    const elsewhere = state([worktree({ current: false }), worktree({ ...there, current: true })], [{ ...main, current: false }, { ...login, current: true }], false);
    const menu = labels(branchMenu({ ...main, current: false }, elsewhere, () => {}));
    expect(menu[0]).toBe('Open worktree in new window');
    expect(menu.some((label) => /Remove worktree|Rename worktree/.test(label))).toBe(false);
  });

  it('offers no rebase of a branch another worktree has, by dragging it onto a commit', () => {
    const row = { hash: 'ddd', parents: [], subject: '', graph: {} } as unknown as Row;
    expect(dropMenu({ kind: 'branch', name: 'feature/login', hash: 'bbb', local: true, current: false }, row, repo)).toEqual([]);
    expect(labels(dropMenu({ kind: 'branch', name: 'plain', hash: 'ccc', local: true, current: false }, row, repo))).toEqual(['Rebase plain onto ddd']);
  });

  it('says what a worktree menu opens without naming the worktree', () => {
    expect(labels(worktreeMenu(there, repo)).slice(0, 3)).toEqual(['Open in Agents Window', 'Open in new window', 'Open in terminal']);
  });

  it('shows another worktree in the views of this window, and keeps the folder of the window from being removed there', () => {
    expect(labels(worktreeMenu(there, repo))).toContain('Show in Gitardo');
    expect(labels(worktreeMenu(here, repo))).not.toContain('Show in Gitardo');
    expect(labels(branchMenu(login, repo, () => {}))).toContain('Show worktree in Gitardo');
    posted.length = 0;
    const show = worktreeMenu(there, repo).find((entry) => entry && entry !== 'separator' && entry.label === 'Show in Gitardo');
    if (show && show !== 'separator') show.run();
    expect(posted).toEqual([{ type: 'selectRepo', root: there.path }]);

    // Seen from the worktree of feature/login, the folder of the window is a worktree like another, but its own.
    const window = worktree({ path: 'C:/prj/feature', branch: 'feature', current: false, main: false });
    const shown = { ...state([worktree({}), { ...there, current: true }, window], [main, login]), home: { root: 'C:\\prj\\feature', name: 'feature' } } as RepoState;
    expect(labels(worktreeMenu(window, shown))).not.toEqual(expect.arrayContaining(['Rename…']));
    expect(labels(worktreeMenu(window, shown))).not.toContain('Remove…');
    expect(labels(branchMenu({ name: 'feature', hash: 'aaa', current: false }, shown, () => {}))).not.toContain('Remove worktree…');
  });
});

describe('the status of a worktree', () => {
  const upstream = { name: 'origin/feature/login', remote: 'origin', branch: 'feature/login', ahead: 2, behind: 1, gone: false };
  const login: Branch = { name: 'feature/login', hash: 'bbb', current: false, upstream };
  const there = worktree({ path: 'C:/prj/app.worktrees/feature/login', hash: 'bbb', branch: 'feature/login', current: false, main: false, changes: 3 });
  const pull = { number: 12, title: 'Login', url: '', draft: false, checks: null };

  it('says how its branch stands against its upstream and what is not committed', () => {
    expect(upstreamHint(login)).toBe('↑2 ↓1');
    expect(upstreamHint({ ...login, upstream: { ...upstream, ahead: 0, behind: 0 } })).toBeUndefined();
    expect(upstreamHint({ ...login, upstream: { ...upstream, gone: true } })).toBe('gone');
    expect(upstreamHint({ ...login, upstream: undefined })).toBeUndefined();
    expect([changesText(null), changesText(0), changesText(1), changesText(3)]).toEqual([
      undefined,
      'Nothing to commit',
      '1 file not committed',
      '3 files not committed',
    ]);
  });

  it('finds its branch and the pull request of the branch', () => {
    const repo = { ...state([worktree({}), there], [login]), remotes: ['origin'], github: { owner: 'me', repo: 'app' }, pulls: { 'feature/login': pull } } as RepoState;
    expect(worktreeStatus(there, repo)).toEqual({ branch: login, ahead: '↑2 ↓1', pull });
    expect(worktreeStatus({ ...there, branch: null }, repo)).toEqual({});
  });
});
