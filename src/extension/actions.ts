import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repo } from '../git/repo';
import {
  abortOp,
  bisectOp,
  bisectResetOp,
  fixupOp,
  hunkOp,
  rebaseInteractiveOp,
  rebaseTodo,
  undoOp,
  worktreeAddOp,
  worktreePruneOp,
  worktreeRemoveOp,
  checkoutOp,
  cherryPickManyOp,
  cherryPickOp,
  commitOp,
  continueOp,
  createBranchOp,
  createTagOp,
  deleteBranchOp,
  deleteRemoteBranchOp,
  deleteTagOp,
  discardOp,
  mergeOp,
  pushTagOp,
  rebaseOp,
  refNameProblem,
  renameBranchOp,
  resetOp,
  resolveConflictsOp,
  revertOp,
  skipOp,
  stageAllOp,
  stageOp,
  stashBranchOp,
  stashOp,
  stashPushOp,
  takeSideOp,
  unstageAllOp,
  unstageOp,
  type GitOp,
  type ResetMode,
} from '../git/ops';
import type { Action, RepoState } from '../shared/protocol';

function askName(title: string, state: RepoState, kind: 'branch' | 'tag', value = ''): Thenable<string | undefined> {
  const taken = new Set((kind === 'branch' ? state.branches : state.tags).map((ref) => ref.name));
  return vscode.window.showInputBox({
    title,
    value,
    placeHolder: kind === 'branch' ? 'feature/my-change' : 'v1.0.0',
    validateInput: (name) => refNameProblem(name) ?? (taken.has(name) ? `A ${kind} with that name already exists` : undefined),
  });
}

async function pick<T>(title: string, options: { label: string; description?: string; value: T }[]): Promise<T | undefined> {
  return (await vscode.window.showQuickPick(options, { title }))?.value;
}

function requireOperation(state: RepoState) {
  if (!state.operation) throw new Error('No merge, rebase, cherry-pick or revert is in progress.');
  return state.operation;
}

/** Says up front whether an operation will stop on conflicts, and always asks first when it will. */
function withConflictPreview(op: GitOp, conflicts: string[] | null): GitOp {
  if (!conflicts) return op;
  if (!conflicts.length) return { ...op, note: 'No conflicts expected.' };
  const shown = conflicts.slice(0, 15);
  const more = conflicts.length > shown.length ? `\n…and ${conflicts.length - shown.length} more` : '';
  const files = conflicts.length === 1 ? '1 file' : `${conflicts.length} files`;
  return { ...op, confirm: true, note: `This will stop with conflicts in ${files}:\n${shown.join('\n')}${more}` };
}

/**
 * Turns what the user asked for into git commands, asking for whatever is still missing.
 * Returns undefined when the user backs out of a prompt, or when the action needed no git command.
 */
export async function resolveAction(action: Action, state: RepoState, repo: Repo): Promise<GitOp | undefined> {
  const hasHead = state.head !== null;

  switch (action.kind) {
    case 'checkout':
      return checkoutOp(action.target, action.ref);

    case 'createBranch': {
      const name = await askName('Create branch', state, 'branch');
      if (!name) return;
      const checkout = await pick(`Create branch ${name}`, [
        { label: 'Create and check out', value: true },
        { label: 'Create only', description: 'Stay on the current branch', value: false },
      ]);
      return checkout === undefined ? undefined : createBranchOp(name, action.at, checkout);
    }

    case 'renameBranch': {
      const name = await askName(`Rename branch ${action.name}`, state, 'branch', action.name);
      return name ? renameBranchOp(action.name, name) : undefined;
    }

    case 'deleteBranch':
      return deleteBranchOp(action.name);

    case 'deleteRemoteBranch':
      return deleteRemoteBranchOp(action.name, state);

    case 'merge':
      return withConflictPreview(mergeOp(action.ref, state.branch), await repo.conflictsWith(action.ref));

    case 'rebase':
      return rebaseOp(action.onto, state.branch, action.branch);

    case 'rebaseInteractive': {
      // The todo list and the reworded messages live in files that git reads while the rebase runs.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitar-rebase-'));
      const file = (name: string) => path.join(dir, name).replace(/\\/g, '/');
      const messageFile = (index: number) => file(`message-${index}.txt`);
      action.steps.forEach((step, index) => {
        if (step.action === 'reword') fs.writeFileSync(messageFile(index), `${(step.message ?? '').trim()}\n`);
      });
      const todo = rebaseTodo(action.steps, messageFile);
      fs.writeFileSync(file('todo'), todo);
      const op = rebaseInteractiveOp(action.base, file('todo'), todo, state.branch);
      // If the rebase stops half way the files are still needed, so they are only removed after a clean finish.
      op.onSuccess = () => fs.rmSync(dir, { recursive: true, force: true });
      return op;
    }

    case 'cherryPick': {
      const op = cherryPickOp(action.hash, action.isMerge);
      // Picking a commit is a merge of it into HEAD with the commit's parent as the common base.
      return action.isMerge ? op : withConflictPreview(op, await repo.conflictsWith(action.hash, `${action.hash}^`));
    }

    case 'cherryPickMany': {
      if (state.operation) throw new Error(`Finish or abort the ${state.operation} first.`);
      // The graph lists commits newest first, and a commit must be picked after the ones it builds on.
      const wanted = new Set(action.hashes);
      const rows = state.rows.filter((row) => wanted.has(row.hash)).reverse();
      if (rows.length < 2 || rows.length !== wanted.size) throw new Error('Select the commits to cherry-pick in the graph.');
      if (rows.some((row) => row.parents.length > 1)) throw new Error('A merge commit can only be cherry-picked on its own.');
      const shown = rows.slice(0, 15).map((row) => `${row.hash.slice(0, 7)} ${row.subject}`);
      const more = rows.length > shown.length ? `\n…and ${rows.length - shown.length} more` : '';
      return {
        ...cherryPickManyOp(rows.map((row) => row.hash)),
        note: `In this order:\n${shown.join('\n')}${more}\n\nIf one of them conflicts, git stops there: resolve it and continue, skip that commit, or abort them all.`,
      };
    }

    case 'undo': {
      if (state.operation) throw new Error(`Finish or abort the ${state.operation} first.`);
      // Every step of a bisect is a checkout: undoing one would fight with it.
      if (state.bisect) throw new Error('End the bisect first.');
      const info = await repo.undoInfo(state.branch, state.working);
      if (!info) throw new Error('There is nothing to undo.');
      return undoOp(info, state.branch);
    }

    case 'worktreeAdd': {
      const suggestion = path.join(path.dirname(state.root), `${state.name}-${action.ref.replace(/[^\w.-]+/g, '-').slice(0, 40)}`);
      const dir = await vscode.window.showInputBox({
        title: `Create worktree for ${action.ref}`,
        prompt: 'Directory for the new worktree',
        value: suggestion,
        validateInput: (value) => (!value.trim() ? 'Enter a directory' : fs.existsSync(value) ? 'That path already exists' : undefined),
      });
      if (!dir) return;
      let newBranch: string | null = null;
      if (!action.isBranch) {
        const name = await vscode.window.showInputBox({
          title: `Create worktree for ${action.ref}`,
          prompt: 'Name of a new branch to create there. Leave empty for a detached HEAD.',
          validateInput: (value) => (value ? refNameProblem(value) : undefined),
        });
        if (name === undefined) return;
        newBranch = name || null;
      }
      const op = worktreeAddOp(dir.trim(), action.ref, newBranch, !action.isBranch);
      op.onSuccess = () =>
        void vscode.window.showInformationMessage(`Worktree created in ${dir}`, 'Open in New Window').then((choice) => {
          if (choice) void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), { forceNewWindow: true });
        });
      return op;
    }

    case 'worktreeRemove':
      return worktreeRemoveOp(action.path);
    case 'worktreePrune':
      return worktreePruneOp();
    case 'worktreeOpen':
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(action.path), { forceNewWindow: true });
      return;

    case 'stageHunk':
    case 'unstageHunk':
    case 'discardHunk':
      return hunkOp(action.kind, action.path, action.patch);

    case 'revert':
      return revertOp(action.hash, action.isMerge);

    case 'reset': {
      const mode = await pick<ResetMode>(`Reset ${state.branch ?? 'HEAD'} to ${action.hash.slice(0, 7)}`, [
        { label: 'Soft', description: 'Keep all changes, staged', value: 'soft' },
        { label: 'Mixed', description: 'Keep all changes, unstaged', value: 'mixed' },
        { label: 'Hard', description: 'Discard all changes', value: 'hard' },
      ]);
      return mode ? resetOp(action.hash, mode, state.branch) : undefined;
    }

    case 'createTag': {
      const name = await askName('Create tag', state, 'tag');
      if (!name) return;
      const message = await vscode.window.showInputBox({
        title: `Create tag ${name}`,
        prompt: 'Message for an annotated tag. Leave empty for a lightweight tag.',
      });
      return message === undefined ? undefined : createTagOp(name, action.at, message.trim());
    }

    case 'deleteTag':
      return deleteTagOp(action.name);

    case 'pushTag':
      return pushTagOp(action.name, state);

    case 'stashPush': {
      const { paths, staged } = action;
      const { title } = stashPushOp('', { paths, staged });
      const message = await vscode.window.showInputBox({
        title,
        prompt: staged
          ? 'Optional message. Only what is staged is stashed; the rest stays where it is.'
          : paths?.length
            ? 'Optional message. Every change to the file is stashed, staged or not.'
            : 'Optional message. Untracked files are stashed too.',
      });
      return message === undefined ? undefined : stashPushOp(message.trim(), { paths, staged });
    }

    case 'stashApply':
      return stashOp('apply', action.ref);
    case 'stashPop':
      return stashOp('pop', action.ref);
    case 'stashDrop':
      return stashOp('drop', action.ref);

    case 'stashBranch': {
      const name = await askName(`Create branch from ${action.ref}`, state, 'branch');
      return name ? stashBranchOp(name, action.ref) : undefined;
    }

    case 'stage':
      return stageOp(action.paths);
    case 'resolveConflicts': {
      const files = state.working.conflicts.map((file) => file.path);
      return resolveConflictsOp(await repo.conflictPlans(action.paths ? files.filter((file) => action.paths?.includes(file)) : files));
    }
    case 'takeSide':
      return takeSideOp(action.path, action.side, await repo.conflictStages(action.path), state.operation);
    case 'stageAll':
      return stageAllOp();
    case 'unstage':
      return unstageOp(action.paths, hasHead);
    case 'unstageAll':
      return unstageAllOp(hasHead);
    case 'discard':
      return discardOp(action.paths, state.working);
    case 'discardAll':
      return discardOp(
        state.working.unstaged.map((file) => file.path),
        state.working,
      );

    case 'commit': {
      const message = action.message.trim();
      let stageAll = false;
      // An amend with nothing staged is fine: it only rewords or re-dates the last commit.
      if (!action.amend && !state.working.staged.length) {
        if (!state.working.unstaged.length) throw new Error('There are no changes to commit.');
        const choice = await vscode.window.showWarningMessage(
          'There are no staged changes. Stage all changes and commit them?',
          { modal: true },
          'Stage All and Commit',
        );
        if (!choice) return;
        stageAll = true;
      }
      return commitOp(message, action.amend, stageAll);
    }

    case 'fixup': {
      if (state.operation) throw new Error(`Finish or abort the ${state.operation} first.`);
      const { staged, unstaged } = state.working;
      if (!staged.length && !unstaged.length) throw new Error('There are no changes to add to that commit.');
      return fixupOp(action.hash, action.isRoot, staged.length === 0);
    }

    case 'bisect':
      return bisectOp(action.mark, action.hash, state.bisect !== null);
    case 'bisectReset':
      return bisectResetOp();

    case 'continue':
      return continueOp(requireOperation(state));
    case 'skip':
      return skipOp(requireOperation(state));
    case 'abort':
      return abortOp(requireOperation(state));
  }
}
