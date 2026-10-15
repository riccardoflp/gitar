import type { Operation, RebaseStep, RepoState, PullAction, Resolution, SyncAction, WorkingState } from '../shared/protocol';
import { canFastForward, refArg } from '../shared/refs';
import type { FileWrite } from './exec';
import type { ConflictPlan } from './repo';

/** A user-visible operation: one or more git commands that change the repository or a remote. */
export interface GitOp {
  title: string;
  commands: string[][];
  /** Can lose work, so it is always confirmed regardless of the preview setting. */
  danger?: boolean;
  /** Always confirmed, like `danger`, but presented as a question rather than a warning. */
  confirm?: boolean;
  /** Extra explanation shown when asking for confirmation. */
  note?: string;
  /** Fed to the standard input of the last command. */
  input?: string;
  /** Files Gitardo writes itself before the commands run, which is said along with them. */
  writes?: FileWrite[];
  /** What to offer when git refuses with a message matching `when`, typically the forced variant. */
  fallback?: { when: RegExp; op: GitOp };
  /** Called after the user agreed and before the commands run, for what they need that is not a file to write. */
  prepare?(): void;
  /** Called once all commands have succeeded. */
  onSuccess?(): void;
}

/** How to take back the last operation: either a checkout to return from, or a branch to move back. */
export type UndoInfo =
  | { kind: 'checkout'; from: string }
  | { kind: 'move'; previous: string; subject: string; mode: 'soft' | 'mixed' | 'keep' };

export type ResetMode = 'soft' | 'mixed' | 'hard';

const short = (ref: string) => (/^[0-9a-f]{40,64}$/.test(ref) ? ref.slice(0, 7) : ref);

/** Refs and names end up as command arguments, so anything that could be read as an option is refused. */
function arg(value: string): string {
  if (!value || value.startsWith('-')) throw new Error(`"${value}" is not a valid name.`);
  return value;
}

/**
 * A file, as an argument for the commands that take patterns. Most names are also the pattern that matches only them;
 * one with a wildcard or brackets is not: `pages/[id].tsx` is also the pattern for `pages/i.tsx` and `pages/d.tsx`,
 * so it is marked to be taken as it is written.
 */
export function pathspec(file: string): string {
  return /[*?[\]\\]|^:/.test(file) ? `:(literal)${file}` : file;
}

/** Returns a message if `name` cannot be a branch or tag name. Git has the final say; this catches the common mistakes early. */
export function refNameProblem(name: string): string | undefined {
  if (!name) return 'Enter a name';
  if (/^[-./]|[\s~^:?*[\\]|\.\.|@\{|[/.]$|\.lock$/.test(name)) return 'That is not a valid Git ref name';
  return undefined;
}

const FORCE_FLAGS: Partial<Record<SyncAction, string>> = {
  pushForceWithLease: '--force-with-lease',
  pushForce: '--force',
};

/** The remote a new upstream or a tag is pushed to: `origin` when it exists. */
export function defaultRemote(state: RepoState): string {
  const remote = state.remotes.includes('origin') ? 'origin' : state.remotes[0];
  if (!remote) throw new Error('This repository has no remote.');
  return remote;
}

/** The way to pull that the settings of the Pull button choose. */
export function pullAction(rebase: boolean, autostash: boolean): PullAction {
  if (rebase) return autostash ? 'pullRebaseAutostash' : 'pullRebase';
  return autostash ? 'pullAutostash' : 'pull';
}

/** Builds the commands for a toolbar action. Throws with a message for the user when the action makes no sense right now. */
export function syncOp(action: SyncAction, state: RepoState): GitOp {
  if (action === 'fetch') return { title: 'Fetch', commands: [['fetch', '--all', '--prune']] };
  if (action === 'pull') return { title: 'Pull', commands: [['pull']] };
  if (action === 'pullRebase') return { title: 'Pull (rebase)', commands: [['pull', '--rebase']] };
  // Git stashes what is not committed, pulls, and applies the stash again: when it no longer fits, it keeps it.
  if (action === 'pullAutostash') return { title: 'Pull (autostash)', commands: [['pull', '--autostash']] };
  if (action === 'pullRebaseAutostash') return { title: 'Pull (rebase, autostash)', commands: [['pull', '--rebase', '--autostash']] };

  const branch = state.branches.find((candidate) => candidate.current);
  if (!branch) throw new Error('Cannot push: HEAD is detached. Check out a branch first.');

  const args = ['push'];
  const force = FORCE_FLAGS[action];
  if (force) args.push(force);

  // With a tag of the same name, the short one is refused as matching more than one thing.
  const source = refArg('branch', branch.name, state);
  const upstream = branch.upstream;
  if (upstream) {
    args.push(upstream.remote, upstream.branch === branch.name ? source : `${source}:${upstream.branch}`);
  } else {
    args.push('--set-upstream', defaultRemote(state), source);
  }

  const title = force ? `Push ${branch.name} (${force})` : `Push ${branch.name}`;
  return { title, commands: [args], danger: Boolean(force) };
}

function remoteName(name: string): string {
  const problem = refNameProblem(name);
  if (problem) throw new Error(`"${name}" is not a valid name for a remote.`);
  return name;
}

export function remoteAddOp(name: string, url: string): GitOp {
  return { title: `Add remote ${name}`, commands: [['remote', 'add', remoteName(name), arg(url)]] };
}

export function remoteSetUrlOp(name: string, url: string): GitOp {
  return { title: `Change the URL of ${name}`, commands: [['remote', 'set-url', remoteName(name), arg(url)]] };
}

export function remoteRenameOp(from: string, to: string): GitOp {
  return { title: `Rename remote ${from} to ${to}`, commands: [['remote', 'rename', remoteName(from), remoteName(to)]] };
}

export function remoteRemoveOp(name: string): GitOp {
  return {
    title: `Remove remote ${name}`,
    commands: [['remote', 'remove', remoteName(name)]],
    danger: true,
    note: `Its remote-tracking branches (${name}/…) are deleted from this repository, and local branches that follow them lose their upstream. Nothing changes on the remote itself.`,
  };
}

export function fetchRemoteOp(name: string): GitOp {
  return { title: `Fetch ${name}`, commands: [['fetch', '--prune', remoteName(name)]] };
}

/**
 * Moves a branch that is not checked out up to its upstream, fetching it first: a fetch into the branch itself, which
 * git only does when that is a fast-forward. Without a `+` it refuses when the branch has commits of its own.
 */
export function fastForwardOp(name: string, state: RepoState): GitOp {
  const branch = state.branches.find((candidate) => candidate.name === name);
  if (!branch?.upstream || !canFastForward(branch, state)) {
    throw new Error(`${name} cannot be fast-forwarded: it needs an upstream, no commits of its own, and not to be checked out.`);
  }
  const { remote, branch: source, name: upstream } = branch.upstream;
  // In full, so that a tag called the same is not taken for either branch.
  const refspec = `refs/heads/${arg(source)}:refs/heads/${arg(name)}`;
  // A branch that follows another local branch has `.` for its remote, this repository, which git fetches from as well.
  const from = remote === '.' ? remote : remoteName(remote);
  return { title: `Fast-forward ${name} to ${upstream}`, commands: [['fetch', from, refspec]] };
}

export function checkoutOp(target: 'branch' | 'remote' | 'detached', ref: string): GitOp {
  const flags = target === 'remote' ? ['--track'] : target === 'detached' ? ['--detach'] : [];
  return { title: `Check out ${short(ref)}`, commands: [['checkout', ...flags, arg(ref)]] };
}

export function createBranchOp(name: string, at: string, checkout: boolean): GitOp {
  const command = checkout ? ['checkout', '-b', arg(name), arg(at)] : ['branch', arg(name), arg(at)];
  return { title: `Create branch ${name}`, commands: [command] };
}

export function renameBranchOp(from: string, to: string): GitOp {
  return { title: `Rename ${from} to ${to}`, commands: [['branch', '-m', arg(from), arg(to)]] };
}

/** `git branch -d` refuses unmerged branches; the forced variant is offered when that happens. */
export function deleteBranchOp(name: string, force = false): GitOp {
  if (force) {
    return {
      title: `Delete branch ${name} (force)`,
      commands: [['branch', '-D', arg(name)]],
      danger: true,
      note: 'This branch is not fully merged. Commits that are only on it will no longer be reachable from any branch.',
    };
  }
  return {
    title: `Delete branch ${name}`,
    commands: [['branch', '-d', arg(name)]],
    fallback: { when: /not fully merged/, op: deleteBranchOp(name, true) },
  };
}

/** Deletes several branches at once. `unmerged` ones have commits that are on no other branch, so they need the forced delete. */
export function cleanupBranchesOp(merged: string[], unmerged: string[]): GitOp {
  const commands: string[][] = [];
  if (merged.length) commands.push(['branch', '-d', ...merged.map(arg)]);
  if (unmerged.length) commands.push(['branch', '-D', ...unmerged.map(arg)]);
  if (!commands.length) throw new Error('No branches selected.');
  const count = merged.length + unmerged.length;
  const op: GitOp = { title: count === 1 ? 'Delete 1 branch' : `Delete ${count} branches`, commands, confirm: true };
  if (unmerged.length) {
    op.danger = true;
    op.note = `Not merged into the current branch, so their commits may become unreachable: ${unmerged.join(', ')}`;
  }
  return op;
}

/** `name` is a remote-tracking branch such as `origin/feature/x`. */
export function deleteRemoteBranchOp(name: string, state: RepoState): GitOp {
  // Remote names can contain slashes, so match against the known remotes, longest first.
  const remote = [...state.remotes].sort((a, b) => b.length - a.length).find((candidate) => name.startsWith(`${candidate}/`));
  if (!remote) throw new Error(`Cannot tell which remote ${name} belongs to.`);
  const branch = name.slice(remote.length + 1);
  return {
    title: `Delete ${branch} from ${remote}`,
    commands: [['push', arg(remote), '--delete', arg(branch)]],
    danger: true,
    note: 'This deletes the branch on the remote for everyone.',
  };
}

export function mergeOp(ref: string, into: string | null): GitOp {
  return { title: `Merge ${short(ref)} into ${into ?? 'HEAD'}`, commands: [['merge', arg(ref)]] };
}

/** Rebases the current branch, or `other`, which git checks out first. */
export function rebaseOp(onto: string, current: string | null, other?: string): GitOp {
  const command = ['rebase', arg(onto)];
  if (other) command.push(arg(other));
  return { title: `Rebase ${other ?? current ?? 'HEAD'} onto ${short(onto)}`, commands: [command] };
}

/**
 * The todo list for `git rebase -i`, from steps given oldest first.
 * A reword is a pick followed by an amend that reads the new message from a file, because nothing here can type into an editor.
 */
export function rebaseTodo(steps: RebaseStep[], messageFile: (index: number) => string): string {
  const firstKept = steps.find((step) => step.action !== 'drop');
  if (!firstKept) throw new Error('Every commit is dropped. To remove them all, reset the branch instead.');
  if (firstKept.action === 'squash' || firstKept.action === 'fixup') {
    throw new Error('The oldest commit that is kept has nothing before it to be squashed into.');
  }
  const lines: string[] = [];
  steps.forEach((step, index) => {
    const hash = arg(step.hash);
    if (step.action !== 'reword') lines.push(`${step.action} ${hash}`);
    else lines.push(`pick ${hash}`, `exec git commit --amend -F "${messageFile(index)}"`);
  });
  return `${lines.join('\n')}\n`;
}

/**
 * Runs an interactive rebase with a todo list prepared in advance: git's "editor" for the list is a copy of `todoFile` over it.
 * `base` is the commit the steps sit on, or null to rebase from the root.
 */
export function rebaseInteractiveOp(base: string | null, todoFile: string, todo: string, branch: string | null): GitOp {
  return {
    title: `Interactive rebase of ${branch ?? 'HEAD'}`,
    commands: [
      ['-c', `sequence.editor=cp "${todoFile}"`, '-c', 'core.editor=true', 'rebase', '-i', base ? arg(base) : '--root'],
    ],
    confirm: true,
    note: `This rewrites the commits after ${base ? short(base) : 'the root'} with this todo list:\n\n${todo.trimEnd()}`,
  };
}

/** A merge commit has several parents, so git must be told which one is the mainline: the first. */
const mainline = (isMerge: boolean) => (isMerge ? ['-m', '1'] : []);

export function cherryPickOp(hash: string, isMerge: boolean): GitOp {
  return { title: `Cherry-pick ${short(hash)}`, commands: [['cherry-pick', ...mainline(isMerge), arg(hash)]] };
}

/** Picks several commits with one command, so that git treats them as one operation to continue or abort. `hashes`: oldest first. */
export function cherryPickManyOp(hashes: string[]): GitOp {
  return { title: `Cherry-pick ${hashes.length} commits`, commands: [['cherry-pick', ...hashes.map(arg)]] };
}

export function revertOp(hash: string, isMerge: boolean): GitOp {
  return { title: `Revert ${short(hash)}`, commands: [['revert', '--no-edit', ...mainline(isMerge), arg(hash)]] };
}

export function resetOp(hash: string, mode: ResetMode, branch: string | null): GitOp {
  const op: GitOp = { title: `Reset ${branch ?? 'HEAD'} to ${short(hash)} (${mode})`, commands: [['reset', `--${mode}`, arg(hash)]] };
  if (mode === 'hard') {
    op.danger = true;
    op.note = 'A hard reset throws away all uncommitted changes to tracked files.';
  }
  return op;
}

export function createTagOp(name: string, at: string, message: string): GitOp {
  const command = message ? ['tag', '-a', arg(name), '-m', message, arg(at)] : ['tag', arg(name), arg(at)];
  return { title: `Create tag ${name}`, commands: [command] };
}

export function deleteTagOp(name: string): GitOp {
  return { title: `Delete tag ${name}`, commands: [['tag', '-d', arg(name)]] };
}

export function pushTagOp(name: string, state: RepoState): GitOp {
  const remote = defaultRemote(state);
  return { title: `Push tag ${name} to ${remote}`, commands: [['push', remote, `refs/tags/${arg(name)}`]] };
}

/** Stashes everything, or only some files, or only what is staged. */
export function stashPushOp(message: string, only: { paths?: string[]; staged?: boolean } = {}): GitOp {
  const { paths, staged } = only;
  // Untracked files are never staged, so the two options do not go together.
  const command = ['stash', 'push', staged ? '--staged' : '--include-untracked'];
  if (message) command.push('-m', message);
  if (staged) return { title: 'Stash staged changes', commands: [command] };
  if (!paths?.length) return { title: 'Stash changes', commands: [command] };
  return {
    title: paths.length === 1 ? `Stash ${paths[0]}` : `Stash ${paths.length} files`,
    commands: [[...command, '--', ...paths.map(pathspec)]],
  };
}

function stashRef(ref: string): string {
  if (!/^stash@\{\d+\}$/.test(ref)) throw new Error(`"${ref}" is not a stash.`);
  return ref;
}

export function stashOp(verb: 'apply' | 'pop' | 'drop', ref: string): GitOp {
  const title = { apply: 'Apply', pop: 'Pop', drop: 'Drop' }[verb];
  const op: GitOp = { title: `${title} ${ref}`, commands: [['stash', verb, stashRef(ref)]] };
  if (verb === 'drop') {
    op.danger = true;
    op.note = 'The stashed changes will be deleted.';
  }
  return op;
}

export function stashBranchOp(name: string, ref: string): GitOp {
  return { title: `Create branch ${name} from ${ref}`, commands: [['stash', 'branch', arg(name), stashRef(ref)]] };
}

export function stageOp(paths: string[]): GitOp {
  return { title: paths.length === 1 ? `Stage ${paths[0]}` : `Stage ${paths.length} files`, commands: [['add', '--', ...paths.map(pathspec)]] };
}

export function stageAllOp(): GitOp {
  return { title: 'Stage all changes', commands: [['add', '--all']] };
}

/** Without a first commit there is no HEAD to restore the index from, so the files are removed from the index instead. */
export function unstageOp(paths: string[], hasHead: boolean): GitOp {
  const files = paths.map(pathspec);
  const command = hasHead ? ['restore', '--staged', '--', ...files] : ['rm', '--cached', '-r', '--', ...files];
  return { title: paths.length === 1 ? `Unstage ${paths[0]}` : `Unstage ${paths.length} files`, commands: [command] };
}

export function unstageAllOp(hasHead: boolean): GitOp {
  return { title: 'Unstage all changes', commands: [hasHead ? ['reset'] : ['rm', '--cached', '-r', '--', '.']] };
}

/** Discards unstaged changes: tracked files go back to their staged version, untracked files are deleted. */
export function discardOp(paths: string[], working: WorkingState): GitOp {
  const untracked = new Set(working.unstaged.filter((file) => file.status === '?').map((file) => file.path));
  const restore = paths.filter((file) => !untracked.has(file));
  const remove = paths.filter((file) => untracked.has(file));
  const commands: string[][] = [];
  if (restore.length) commands.push(['restore', '--', ...restore.map(pathspec)]);
  if (remove.length) commands.push(['clean', '-f', '--', ...remove.map(pathspec)]);
  if (!commands.length) throw new Error('There is nothing to discard.');

  const notes: string[] = [];
  if (restore.length) notes.push('Unstaged changes to tracked files will be lost.');
  if (remove.length) notes.push(`${remove.length === 1 ? 'One untracked file' : `${remove.length} untracked files`} will be deleted from disk.`);
  return {
    title: paths.length === 1 ? `Discard changes in ${paths[0]}` : `Discard changes in ${paths.length} files`,
    commands,
    danger: true,
    note: notes.join(' '),
  };
}

/** Applies one hunk of a file's diff, passed to `git apply` on standard input. */
export function hunkOp(kind: 'stageHunk' | 'unstageHunk' | 'discardHunk', file: string, patch: string): GitOp {
  const header = patch.split('\n').find((line) => line.startsWith('@@')) ?? '';
  const note = `The patch on standard input changes this part of ${file}:\n${header}`;
  if (kind === 'stageHunk') return { title: `Stage hunk in ${file}`, commands: [['apply', '--cached', '-']], input: patch, note };
  if (kind === 'unstageHunk') {
    return { title: `Unstage hunk in ${file}`, commands: [['apply', '--cached', '--reverse', '-']], input: patch, note };
  }
  return {
    title: `Discard hunk in ${file}`,
    commands: [['apply', '--reverse', '-']],
    input: patch,
    danger: true,
    note: `${note}\n\nThe change will be removed from the file on disk.`,
  };
}

/**
 * The folder a new worktree goes in, by its name, relative to where the worktrees are: a branch such as
 * `feature/login` makes the folder `login` inside `feature`.
 */
export function worktreeFolderName(name: string): string {
  const parts = name
    .split(/[\\/]+/)
    .map((part) => part.replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60))
    .filter(Boolean);
  return parts.join('/') || 'worktree';
}

/** What a format of worktree names may say besides the inputs: `${base}`, `${repo}` and `${date}`. */
export interface WorktreeNameValues {
  base: string;
  repo: string;
  date: string;
  inputs: Record<string, string>;
}

const VARIABLE = /\$\{([^}]*)\}/g;

/** The inputs a format asks for, by their ids, in the order they first appear. */
export function formatInputs(format: string): string[] {
  const ids = [...format.matchAll(VARIABLE)].flatMap(([, name]) => (name.startsWith('input:') ? [name.slice(6)] : []));
  return [...new Set(ids)];
}

/** Says what is wrong with a format, given the ids of the inputs defined for it. */
export function formatProblem(format: string, defined: string[]): string | undefined {
  for (const [whole, name] of format.matchAll(VARIABLE)) {
    if (name.startsWith('input:') ? !defined.includes(name.slice(6)) : !['base', 'repo', 'date'].includes(name)) {
      return name.startsWith('input:')
        ? `The format uses ${whole}, which gitardo.worktrees.inputs does not define.`
        : `The format uses ${whole}, which is not one of \${base}, \${repo}, \${date} or \${input:<id>}.`;
    }
  }
  return undefined;
}

/** Fills a format of worktree names in. */
export function expandFormat(format: string, values: WorktreeNameValues): string {
  return format.replace(VARIABLE, (_, name: string) =>
    name.startsWith('input:') ? (values.inputs[name.slice(6)] ?? '') : (values[name as 'base' | 'repo' | 'date'] ?? ''),
  );
}

/** A branch by its own name: `origin/feature/login` is `feature/login`. A remote's name can have slashes in it too. */
export function withoutRemote(ref: string, remotes: string[]): string {
  const remote = remotes.filter((name) => ref.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0];
  return remote ? ref.slice(remote.length + 1) : ref;
}

/**
 * Where new worktrees go. `folder` is the setting: `${repo}` in it is the name of the main worktree's folder, and a
 * relative path starts from the folder that holds the main worktree.
 */
export function worktreesRoot(main: string, folder: string): string {
  // With forward slashes, as git lists worktrees on every system.
  const slashes = (text: string) => text.replace(/\\/g, '/').replace(/\/+$/, '');
  const home = slashes(main);
  const repo = home.slice(home.lastIndexOf('/') + 1);
  const where = slashes((folder.trim() || '${repo}.worktrees').replace(/\$\{repo\}/g, repo));
  const absolute = /^([a-zA-Z]:)?\//.test(where);
  return absolute ? where : `${home.slice(0, home.lastIndexOf('/'))}/${where.replace(/^\.\//, '')}`;
}

/** Where a new worktree named `name` goes: in the folder of the setting, in a folder named after it. */
export function worktreeDir(main: string, folder: string, name: string): string {
  return `${worktreesRoot(main, folder)}/${worktreeFolderName(name)}`;
}

export function worktreeAddOp(dir: string, ref: string, newBranch: string | null, detach: boolean): GitOp {
  const command = ['worktree', 'add'];
  // A new branch starts a line of work of its own: one made from a remote branch would otherwise push to it.
  if (newBranch) command.push('--no-track', '-b', arg(newBranch));
  else if (detach) command.push('--detach');
  command.push(arg(dir), arg(ref));
  return { title: `Create worktree for ${newBranch ?? short(ref)}`, commands: [command] };
}

/** A worktree on a new local branch that tracks the remote branch `remote`, to work on it and push it back. */
export function worktreeTrackOp(dir: string, branch: string, remote: string): GitOp {
  return { title: `Create worktree for ${branch}`, commands: [['worktree', 'add', '--track', '-b', arg(branch), arg(dir), arg(remote)]] };
}

/**
 * Git refuses to remove a worktree with uncommitted changes; the forced variant is offered when that happens.
 * `branch` is deleted after it, and only when merged: `git branch -d` keeps one whose commits are on no other branch.
 */
export function worktreeRemoveOp(dir: string, force = false, branch?: string): GitOp {
  const deleteBranch = branch ? [['branch', '-d', arg(branch)]] : [];
  const also = branch ? ` and branch ${branch}` : '';
  const kept = branch
    ? `The branch ${branch} is deleted too if it is merged; if it is not, git keeps it and says so.`
    : 'Its branch and commits stay in the repository.';
  if (force) {
    return {
      title: `Remove worktree ${dir}${also} (force)`,
      commands: [['worktree', 'remove', '--force', arg(dir)], ...deleteBranch],
      danger: true,
      note: `This worktree has modified or untracked files. They will be deleted with it. ${kept}`,
    };
  }
  return {
    title: `Remove worktree ${dir}${also}`,
    commands: [['worktree', 'remove', arg(dir)], ...deleteBranch],
    confirm: true,
    note: `The directory is deleted. ${kept}`,
    fallback: { when: /modified or untracked files|--force/, op: worktreeRemoveOp(dir, true, branch) },
  };
}

/** Moves a worktree to another folder, and renames its branch along with it when `branch` says to. */
export function worktreeMoveOp(dir: string, to: string, branch?: { from: string; to: string }): GitOp {
  const commands = [['worktree', 'move', arg(dir), arg(to)]];
  if (branch) commands.push(['branch', '-m', arg(branch.from), arg(branch.to)]);
  const name = to.replace(/\\/g, '/').split('/').pop();
  return {
    title: `Rename worktree to ${name}${branch ? ` and branch ${branch.from} to ${branch.to}` : ''}`,
    commands,
    note: 'Git cannot move a folder that another program has open, such as another VS Code window or a terminal in it.',
  };
}

export function worktreePruneOp(): GitOp {
  return { title: 'Prune worktrees', commands: [['worktree', 'prune']] };
}

/** Undoes a branch deletion. The upstream setting of the branch is not restored. */
export function restoreBranchOp(name: string, hash: string): GitOp {
  return { title: `Undo: restore branch ${name}`, commands: [['branch', arg(name), arg(hash)]], confirm: true };
}

/** Undoes a stash drop, while the stash commit has not been garbage collected. */
export function restoreStashOp(message: string, hash: string): GitOp {
  return { title: 'Undo: restore dropped stash', commands: [['stash', 'store', '-m', message, arg(hash)]], confirm: true };
}

export function undoOp(info: UndoInfo, branch: string | null): GitOp {
  if (info.kind === 'checkout') {
    const detached = /^[0-9a-f]{40,64}$/.test(info.from);
    const command = detached ? ['checkout', '--detach', info.from] : ['checkout', arg(info.from)];
    return { title: `Undo checkout: go back to ${short(info.from)}`, commands: [command], confirm: true };
  }
  const target = `${branch ?? 'HEAD'} goes back to ${short(info.previous)}.`;
  const notes = {
    soft: `${target} The changes of the undone commit stay staged.`,
    mixed: `${target} Your files are not touched.`,
    keep: `${target} Git refuses if that would overwrite uncommitted changes.`,
  };
  return {
    title: `Undo "${info.subject}"`,
    commands: [['reset', `--${info.mode}`, info.previous]],
    confirm: true,
    note: notes[info.mode],
  };
}

export function commitOp(message: string, amend: boolean, stageAll: boolean): GitOp {
  const commit = ['commit'];
  if (amend) commit.push('--amend');
  if (message) commit.push('-m', message);
  else if (amend) commit.push('--no-edit');
  else throw new Error('Enter a commit message.');
  return { title: amend ? 'Amend last commit' : 'Commit', commands: stageAll ? [['add', '--all'], commit] : [commit] };
}

/**
 * Folds changes into an earlier commit: a `fixup!` commit, then a rebase that moves it next to its target and melds them.
 * The todo list git prepares is already right, so its "editor" is a command that accepts it as it is.
 */
export function fixupOp(hash: string, isRoot: boolean, stageAll: boolean): GitOp {
  const commands: string[][] = stageAll ? [['add', '--all']] : [];
  commands.push(
    ['commit', `--fixup=${arg(hash)}`],
    ['-c', 'sequence.editor=true', 'rebase', '-i', '--autosquash', '--autostash', isRoot ? '--root' : `${hash}^`],
  );
  return {
    title: `Add ${stageAll ? 'all' : 'staged'} changes to ${short(hash)}`,
    commands,
    confirm: true,
    note: `This rewrites ${short(hash)} and every commit after it. If the changes do not fit there, the rebase stops with conflicts.`,
  };
}

/** Marks a commit for `git bisect`, or the commit being tested when `hash` is left out. The first mark also starts the bisect. */
export function bisectOp(mark: 'good' | 'bad' | 'skip', hash: string | undefined, active: boolean): GitOp {
  if (!active && mark === 'skip') throw new Error('No bisect is in progress.');
  const command = ['bisect', mark];
  if (hash) command.push(arg(hash));
  return {
    title: `${active ? 'Bisect' : 'Start bisect'}: ${hash ? short(hash) : 'this commit'} is ${mark === 'skip' ? 'skipped' : mark}`,
    commands: active ? [command] : [['bisect', 'start'], command],
  };
}

export function bisectResetOp(): GitOp {
  return { title: 'End bisect', commands: [['bisect', 'reset']] };
}

export interface IdentityProfile {
  name: string;
  email: string;
  signingKey?: string;
}

const IDENTITY_KEYS = ['user.name', 'user.email', 'user.signingkey'];

/** Sets who commits are made as in this repository. `localKeys` are the `user.*` settings the repository already has of its own. */
export function identityOp(profile: IdentityProfile, localKeys: string[]): GitOp {
  const commands = [
    ['config', 'user.name', arg(profile.name.trim())],
    ['config', 'user.email', arg(profile.email.trim())],
  ];
  // A signing key left over from another identity would sign for the wrong person.
  if (profile.signingKey) commands.push(['config', 'user.signingkey', arg(profile.signingKey)]);
  else if (localKeys.includes('user.signingkey')) commands.push(['config', '--unset-all', 'user.signingkey']);
  return {
    title: `Commit as ${profile.name} <${profile.email}>`,
    commands,
    note: 'This is saved in the configuration of this repository only.',
  };
}

/** Removes the repository's own identity, so that the global one applies again. */
export function clearIdentityOp(localKeys: string[]): GitOp {
  const keys = IDENTITY_KEYS.filter((key) => localKeys.includes(key));
  if (!keys.length) throw new Error('This repository already uses the global identity.');
  return { title: 'Use the global identity', commands: keys.map((key) => ['config', '--unset-all', key]) };
}

/** What the two sides of a conflict are, which depends on the operation that stopped: a rebase swaps them. */
export const CONFLICT_SIDES: Record<Operation | 'none', [current: string, incoming: string]> = {
  merge: ['The branch checked out', 'The branch being merged'],
  rebase: ['What the branch is being rebased onto', 'Your commit being replayed'],
  'cherry-pick': ['The branch checked out', 'The commit being picked'],
  revert: ['The branch checked out', 'The state before the reverted commit'],
  none: ['Your files', 'The changes being applied'],
};

const RESOLUTIONS: Record<Resolution, string> = {
  separate: 'changes to lines next to each other',
  same: 'the same change on both sides',
  whitespace: 'spaces or line endings only',
  oneSide: 'a change on one side only',
};

const plural = (count: number, one: string) => (count === 1 ? `1 ${one}` : `${count} ${one}s`);

/**
 * Resolves the conflicts that need no choice between their two sides. The files are written with those resolved; the
 * ones left without conflicts are staged, and the others keep the markers of what is left.
 */
export function resolveConflictsOp(plans: ConflictPlan[]): GitOp {
  const solved = (plan: ConflictPlan) => plan.conflicts.filter((conflict) => conflict.resolution).length;
  const total = plans.reduce((sum, plan) => sum + plan.conflicts.length, 0);
  const count = plans.reduce((sum, plan) => sum + solved(plan), 0);
  if (!total) throw new Error('There are no conflicts marked in the files to resolve.');
  if (!count) throw new Error(`None of the ${plural(total, 'conflict')} can be resolved without choosing a side.`);

  const changed = plans.filter((plan) => solved(plan) > 0);
  const done = changed.filter((plan) => solved(plan) === plan.conflicts.length);
  const files = changed.map((plan) => {
    const kinds = new Set(plan.conflicts.flatMap((conflict) => (conflict.resolution ? RESOLUTIONS[conflict.resolution] : [])));
    return `${plan.path}: ${solved(plan)} of ${plural(plan.conflicts.length, 'conflict')} (${[...kinds].join(', ')})`;
  });
  const left = total - count;
  const rest = left ? `${plural(left, 'conflict')} will be left to resolve by hand, with the markers as they are.` : 'No conflict will be left.';
  const all = total === 1 ? 'the conflict' : `all ${total} conflicts`;
  return {
    title: `Resolve ${count === total ? all : `${count} of ${total} conflicts`} automatically`,
    writes: changed.map((plan) => ({ path: plan.path, content: plan.resolved, expected: plan.text })),
    commands: done.length ? [['add', '--', ...done.map((plan) => pathspec(plan.path))]] : [],
    confirm: true,
    note: `${files.join('\n')}\n\nEvery line written is a line of one of the two sides. ${rest}`,
  };
}

/** Takes back a resolution: the files are as git left them when it stopped, in conflict and with all their markers. */
export function restoreConflictsOp(files: string[]): GitOp {
  return {
    title: `Undo: restore the conflicts of ${files.length === 1 ? files[0] : `${files.length} files`}`,
    commands: [['checkout', '--merge', '--', ...files.map(pathspec)]],
    danger: true,
    note: 'The files go back to how git left them when it stopped, with every conflict marked. What was changed in them since is lost.',
  };
}

/** Resolves a whole file for one side. `stages` are the sides the index has for it: a side without it deleted the file. */
export function takeSideOp(file: string, side: 'ours' | 'theirs', stages: number[], operation: Operation | null): GitOp {
  if (!stages.length) throw new Error(`${file} is not in conflict.`);
  const sides = CONFLICT_SIDES[operation ?? 'none'];
  const [name, what] = side === 'ours' ? ['current', sides[0]] : ['incoming', sides[1]];
  const which = `${what[0].toLowerCase()}${what.slice(1)}`;
  if (!stages.includes(side === 'ours' ? 2 : 3)) {
    return {
      title: `Delete ${file}, as the ${name} side did`,
      commands: [['rm', '--', pathspec(file)]],
      confirm: true,
      note: `The ${name} side is ${which}, which has no such file. The changes the other side made to it are left out.`,
    };
  }
  return {
    title: `Take the ${name} side of ${file}`,
    commands: [
      ['checkout', `--${side}`, '--', pathspec(file)],
      ['add', '--', pathspec(file)],
    ],
    confirm: true,
    note: `The ${name} side is ${which}. The whole file becomes what that side has: the changes the other side made to it are left out.`,
  };
}

/** Continuing would open an editor for the commit message, which cannot work here, so the prepared message is kept as is. */
export function continueOp(operation: Operation): GitOp {
  return { title: `Continue ${operation}`, commands: [['-c', 'core.editor=true', operation, '--continue']] };
}

export function skipOp(operation: Operation): GitOp {
  if (operation === 'merge') throw new Error('A merge has no steps to skip.');
  return { title: `Skip this step of the ${operation}`, commands: [[operation, '--skip']] };
}

export function abortOp(operation: Operation): GitOp {
  return {
    title: `Abort ${operation}`,
    commands: [[operation, '--abort']],
    danger: true,
    note: `This goes back to the state before the ${operation} started. Conflicts you already resolved will be lost.`,
  };
}
