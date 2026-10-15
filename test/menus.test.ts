import { describe, expect, it, vi } from 'vitest';
import type { Branch, RepoState, Row, Worktree } from '../src/shared/protocol';
import { worktreeOf } from '../src/shared/refs';

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
  ...overrides,
});

const state = (worktrees: Worktree[], branches: Branch[], agentsWindow = true) =>
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

  it('leaves the menu of a branch without a worktree as it was', () => {
    const menu = labels(branchMenu(plain, repo, () => {}));
    expect(menu[0]).toBe('Check out plain');
    expect(menu).toEqual(expect.arrayContaining(['Create worktree…', 'Rename…', 'Delete']));
    expect(menu.some((label) => /worktree in|Remove worktree/.test(label))).toBe(false);
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
});
