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
  worktreeDir,
  worktreesRoot,
  expandFormat,
  formatInputs,
  formatProblem,
  withoutRemote,
  worktreeFolderName,
  worktreeMoveOp,
  worktreePruneOp,
  worktreeRemoveOp,
  worktreeTrackOp,
  repoNameOfUrl,
  submoduleAddOp,
  submoduleDeinitOp,
  submoduleRecordOp,
  submoduleRemoveOp,
  submoduleSyncOp,
  submoduleUpdateOp,
  submodulesUpdateOp,
  checkoutLocalOp,
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
  discardChangesOp,
  discardOp,
  fastForwardOp,
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
  type OpLog,
  type ResetMode,
} from '../git/ops';
import { formatCommand, git, type GitError } from '../git/exec';
import { parseWorktrees, samePath } from '../git/parse';
import { setUpWorktree, unlinkFolderLinks } from '../git/worktreeSetup';
import type { SetupPatterns } from '../shared/worktreeSetup';
import { setupPatterns } from './worktreeSettings';
import type { Action, RepoState, Submodule, Worktree } from '../shared/protocol';
import { isHome, refArg, worktreeOf } from '../shared/refs';
import { submoduleFolder } from '../shared/submodules';

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
export async function resolveAction(action: Action, state: RepoState, repo: Repo, memory: vscode.Memento): Promise<GitOp | undefined> {
  const hasHead = state.head !== null;

  switch (action.kind) {
    case 'checkout': {
      const op = action.target === 'remote' ? await checkoutRemote(action.ref, action.rebase ?? false, state, repo) : checkoutOp(action.target, action.ref);
      return updatingSubmodules(op, action.ref, state, repo);
    }

    case 'createBranch': {
      const name = await askName('Create branch', state, 'branch');
      if (!name) return;
      const checkout = await pick(`Create branch ${name}`, [
        { label: 'Create and check out', value: true },
        { label: 'Create only', description: 'Stay on the current branch', value: false },
      ]);
      if (checkout === undefined) return;
      const op = createBranchOp(name, action.at, checkout);
      return checkout ? updatingSubmodules(op, action.at, state, repo) : op;
    }

    case 'renameBranch': {
      const name = await askName(`Rename branch ${action.name}`, state, 'branch', action.name);
      return name ? renameBranchOp(action.name, name) : undefined;
    }

    case 'deleteBranch':
      return deleteBranchOp(action.name);

    case 'fastForward':
      return fastForwardOp(action.name, state);

    case 'deleteRemoteBranch':
      return deleteRemoteBranchOp(action.name, state);

    case 'merge':
      return withConflictPreview(mergeOp(action.ref, state.branch), await repo.conflictsWith(action.ref));

    case 'rebase':
      return rebaseOp(action.onto, state.branch, action.branch);

    case 'rebaseInteractive': {
      // The todo list and the reworded messages live in files that git reads while the rebase runs.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitardo-rebase-'));
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
      const op = undoOp(info, state.branch);
      return info.kind === 'checkout' ? updatingSubmodules(op, info.from, state, repo) : op;
    }

    case 'worktreeAdd':
      return addWorktree(action.ref, action.isBranch ?? false, state, repo, memory);

    case 'worktreeRemove': {
      const worktree = findWorktree(action.path, state);
      if (isHome(worktree.path, state)) throw new Error('This worktree is the folder open in this window: remove it from another one.');
      const leaveNoEmptyFolders = (op: GitOp): GitOp => {
        op.prepare = async (log) => {
          await closeInVSCodeGit([action.path], log);
          await unlinkFolderLinks(action.path, log);
        };
        op.recover = recoverHeldWorktree(state.root);
        op.finish = () => removeEmptyParents(action.path, state);
        if (op.fallback) leaveNoEmptyFolders(op.fallback.op);
        return op;
      };
      // Its branch can go with it, unless another worktree has it checked out too, which git does not allow anyway.
      const branch = worktree.branch;
      if (!branch || action.deleteBranch === false) return leaveNoEmptyFolders(worktreeRemoveOp(action.path));
      if (action.deleteBranch) return leaveNoEmptyFolders(worktreeRemoveOp(action.path, false, branch));
      const deleteBranch = await pick(`Remove worktree ${path.basename(action.path)}`, [
        { label: 'Remove the worktree', description: `Keep the branch ${branch}`, value: false },
        { label: `Remove the worktree and delete ${branch}`, description: 'Only if it is merged', value: true },
      ]);
      return deleteBranch === undefined ? undefined : leaveNoEmptyFolders(worktreeRemoveOp(action.path, false, deleteBranch ? branch : undefined));
    }
    case 'worktreeRename':
      return renameWorktree(findWorktree(action.path, state), state);
    case 'worktreePrune':
      return worktreePruneOp();
    case 'worktreeSetUp':
      if (action.path) findWorktree(action.path, state);
      return setUpExistingOp(state, action.path);
    case 'worktreeOpen':
      await openWorktree(action.path, action.where ?? openIn(state));
      return;
    case 'openInWorktree':
      return openInWorktree(action.name, action.remote ?? false, state);
    case 'worktreeTerminal':
      vscode.window.createTerminal({ name: path.basename(action.path), cwd: action.path }).show();
      return;
    case 'worktreeReveal':
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(action.path));
      return;

    case 'submoduleAdd':
      return addSubmodule(state);
    case 'submoduleUpdate': {
      const submodule = findSubmodule(action.path, state);
      return action.remote ? submoduleUpdateOp(submodule, true) : updateSubmodule(submodule);
    }
    case 'submoduleRecord': {
      const submodule = findSubmodule(action.path, state);
      if (!submodule.head) throw new Error(`${submodule.path} is not initialized.`);
      return submoduleRecordOp(submodule, submodule.head);
    }
    case 'submoduleDeinit':
      return lettingGoOf(submoduleDeinitOp(findSubmodule(action.path, state)), findSubmodule(action.path, state), state);
    case 'submoduleRemove': {
      const submodule = findSubmodule(action.path, state);
      // Its clone is in the git directory of the repository that has it, under its name, which comes from .gitmodules:
      // a name that leads out of there is no clone to delete.
      const modules = path.join(await repo.gitDirAt(submodule.parent), 'modules');
      const gitDir = path.resolve(modules, submodule.name);
      const exists = gitDir.startsWith(modules + path.sep) && fs.existsSync(gitDir);
      const op = lettingGoOf(submoduleRemoveOp(submodule, exists ? gitDir : null), submodule, state);
      if (exists) {
        op.finish = async (log) => {
          log.info(`> delete ${gitDir}`);
          try {
            await fs.promises.rm(gitDir, { recursive: true, force: true, maxRetries: 10, retryDelay: HELD_DELAY });
          } catch (error) {
            log.warn(`${gitDir} could not be deleted: ${error instanceof Error ? error.message : String(error)}`);
          }
        };
      }
      return op;
    }
    case 'submoduleSync':
      return submoduleSyncOp();
    case 'submoduleOpen': {
      const submodule = findSubmodule(action.path, state);
      if (!submodule.head) throw new Error(`${submodule.path} is not initialized: update it first.`);
      await openWorktree(submoduleFolder(submodule, state), 'window');
      return;
    }

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
      // The branch starts at the commit the stash was made on.
      return name ? updatingSubmodules(stashBranchOp(name, action.ref), `${action.ref}^`, state, repo) : undefined;
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
    case 'discardChanges':
      // Going back to the last commit in the middle of a merge or a rebase would leave it to commit nothing.
      if (!action.paths && state.operation) throw new Error(`Abort the ${state.operation} to discard all of it.`);
      return discardChangesOp(action.paths ?? null, state.working, hasHead);

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

/**
 * A remote branch is checked out in the local branch of its name, made to track it when there is none. One there
 * already is checked out and brought up to it; when each has commits the other has not, the user picks between
 * rebasing the local ones onto it and leaving the branch as it is. One that another worktree has opens there.
 */
async function checkoutRemote(ref: string, rebase: boolean, state: RepoState, repo: Repo): Promise<GitOp | undefined> {
  const remote = ref.replace(/^refs\/remotes\//, '');
  const name = withoutRemote(remote, state.remotes);
  const branch = state.branches.find((candidate) => candidate.name === name);
  if (!branch) return checkoutOp('remote', ref);
  // Git checks it out nowhere but in the worktree that has it, which opens instead, to work on it there.
  const worktree = worktreeOf(name, state);
  if (worktree?.prunable) throw new Error(`The worktree of ${name} is missing from ${worktree.path}: prune the worktrees to free the branch.`);
  if (worktree) {
    await openWorktree(worktree.path, openIn(state));
    return;
  }
  const local = { name, current: branch.current, ...(await repo.divergence(`refs/heads/${name}`, ref)) };
  if (rebase || !local.ahead || !local.behind) {
    if (local.current && !local.behind) {
      void vscode.window.showInformationMessage(`${name} is checked out already, with everything ${remote} has.`);
      return;
    }
    return checkoutLocalOp(ref, local, rebase && local.behind > 0);
  }
  const commits = (count: number) => (count === 1 ? '1 commit' : `${count} commits`);
  const choice = await pick(`${name} has ${commits(local.ahead)} that ${remote} has not, which has ${commits(local.behind)} of its own`, [
    { label: `Check out ${name} and rebase it onto ${remote}`, description: `Replay its ${commits(local.ahead)} on top`, value: true },
    { label: `Check out ${name} as it is`, description: 'Leave the two apart', value: false },
  ]);
  if (choice === undefined) return;
  if (!choice && local.current) return;
  return checkoutLocalOp(ref, local, choice);
}

/** The command that opens the Agents window of VS Code. It is not part of the documented API, hence the fallback. */
export const AGENTS_WINDOW = 'workbench.action.openAgentsWindow';

/** Where a worktree opens when nothing says: as the settings choose, in the Agents window only where VS Code has one. */
function openIn(state: RepoState): 'window' | 'agents' {
  const setting = vscode.workspace.getConfiguration('gitardo').get<string>('worktrees.openIn', 'window');
  return setting === 'agents' && state.agentsWindow ? 'agents' : 'window';
}

/** Opens a worktree in a window of its own, or in the Agents window for agent sessions in it. */
export async function openWorktree(dir: string, where: 'window' | 'agents'): Promise<void> {
  const folder = vscode.Uri.file(dir);
  if (where === 'agents') {
    try {
      await vscode.commands.executeCommand(AGENTS_WINDOW, { folderUri: folder });
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(`The Agents window did not open (${reason}), so the worktree opens in a new window.`);
    }
  }
  await vscode.commands.executeCommand('vscode.openFolder', folder, { forceNewWindow: true });
}

/**
 * Opens the worktree of a branch where the settings say, and makes it first when there is none: in the folder of the
 * worktrees, named after the branch, with nothing asked. A remote branch is worked on in a local branch by its name,
 * made to track it unless there is one already.
 */
async function openInWorktree(name: string, remote: boolean, state: RepoState): Promise<GitOp | undefined> {
  const branch = remote ? withoutRemote(name, state.remotes) : name;
  const where = openIn(state);
  const existing = state.worktrees.find((worktree) => worktree.branch === branch);
  if (existing) {
    if (existing.current) throw new Error(`${branch} is checked out in this window.`);
    if (existing.prunable) throw new Error(`The worktree of ${branch} is missing from ${existing.path}: prune the worktrees to free the branch.`);
    await openWorktree(existing.path, where);
    return;
  }
  const { main, folder } = worktreesHome(state);
  const dir = worktreeDir(main, folder, branch);
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists.`);
  // The branch by its bare name: given as `refs/heads/…`, git would check out its commit on a detached HEAD.
  const local = state.branches.some((candidate) => candidate.name === branch);
  const op = remote && !local ? worktreeTrackOp(dir, branch, refArg('remote', name, state)) : worktreeAddOp(dir, branch, null, false);
  op.onSuccess = () => void openWorktree(dir, where);
  return withSetup(op, dir, state);
}

/** Whether creating a worktree has offered once to choose what new worktrees get, and the button that offers it. */
export const SETUP_OFFERED = 'worktreeSetupOffered';
const SET_UP = 'Choose What It Gets…';

/** What the patterns will bring into a worktree, said for who is asked. Undefined when they bring nothing. */
function setupNote(patterns: SetupPatterns, root: string): string | undefined {
  const what = [
    patterns.link.length && `link the folders matching ${patterns.link.join(', ')}`,
    patterns.copy.length && `copy what matches ${patterns.copy.join(', ')}`,
  ].filter(Boolean);
  return what.length ? `Gitardo will ${what.join(', and ')} from ${root}, where git ignores them.` : undefined;
}

/** Brings into the worktrees in `dirs` what the patterns ask for, and says once at the end what failed. */
async function setUpWorktrees(root: string, dirs: string[], patterns: SetupPatterns, log: OpLog): Promise<void> {
  const failures: string[] = [];
  for (const dir of dirs) failures.push(...(await setUpWorktree(root, dir, patterns, log)));
  if (failures.length) {
    const which = failures.length === 1 ? failures[0] : `${failures.length} folders or files`;
    void vscode.window.showWarningMessage(`Gitardo: ${which} failed: the log says why.`);
  }
}

/**
 * Has a new worktree get, once git has made it, what gitardo.worktrees.linkFolders and gitardo.worktrees.copyFiles,
 * or VS Code's own git.worktreeSymlinkFolders and git.worktreeIncludeFiles, bring from this checkout.
 */
function withSetup(op: GitOp, dir: string, state: RepoState): GitOp {
  const patterns = setupPatterns(state.root);
  const note = setupNote(patterns, state.root);
  if (!note) return op;
  op.note = `Then ${note.charAt(0).toLowerCase()}${note.slice(1)}`;
  op.finish = (log) => setUpWorktrees(state.root, [dir], patterns, log);
  return op;
}

/**
 * Brings into worktrees that are there already what new ones get: the one in `dir`, or every other worktree of the
 * repository that is not missing. Nothing is made over what they have.
 */
export function setUpExistingOp(state: RepoState, dir?: string): GitOp {
  const patterns = setupPatterns(state.root);
  const note = setupNote(patterns, state.root);
  if (!note) throw new Error('New worktrees get nothing yet: choose what they get first.');
  const dirs = dir
    ? [dir]
    : state.worktrees.filter((worktree) => !worktree.prunable && !samePath(worktree.path, state.root)).map((worktree) => worktree.path);
  if (!dirs.length) throw new Error('There are no other worktrees to bring it into.');
  if (dirs.some((each) => samePath(each, state.root))) throw new Error('This is the checkout it comes from.');
  const which = dirs.length === 1 ? path.basename(dirs[0]) : `${dirs.length} worktrees`;
  return { title: `Bring ignored files into ${which}`, commands: [], confirm: true, note, finish: (log) => setUpWorktrees(state.root, dirs, patterns, log) };
}

function findSubmodule(folder: string, state: RepoState): Submodule {
  const submodule = state.submodules.find((candidate) => candidate.path === folder);
  if (!submodule) throw new Error(`${folder} is no longer a submodule of this repository.`);
  return submodule;
}

/**
 * What going to the recorded commit leaves behind in a submodule: the commits made in it on a detached HEAD, which no
 * branch has then, and its changes, which git carries along or stops for. `named` says which submodule it is about.
 */
function submoduleRisks(submodule: Submodule, named: boolean): { lost: string[]; changes: string[] } {
  const it = named ? submodule.path : 'It';
  const lost: string[] = [];
  const changes: string[] = [];
  if (submodule.ahead && !submodule.headBranch) {
    const commits = submodule.ahead === 1 ? '1 commit' : `${submodule.ahead} commits`;
    lost.push(`${it} has ${commits} after the recorded one on a detached HEAD: no branch will have them. Create a branch in it first to keep them.`);
  }
  if (submodule.changes) changes.push(`${it} has changes that are not committed: git keeps them, or stops if they are in the way.`);
  return { lost, changes };
}

/** Going back to the recorded commit is asked first when it leaves something behind in the submodule. */
function updateSubmodule(submodule: Submodule): GitOp {
  const op = submoduleUpdateOp(submodule, false);
  const { lost, changes } = submoduleRisks(submodule, false);
  if (lost.length || changes.length) {
    op.confirm = true;
    op.note = [...lost, ...changes].join('\n\n');
  }
  return op;
}

/**
 * A checkout leaves the submodules on what they had, which is not what the commit checked out records: they are updated
 * to it once the checkout is done, unless the settings say not to, and only when there are submodules here or there.
 * What that would leave behind in them is said, and asked first when it is commits that no branch would have.
 */
async function updatingSubmodules(op: GitOp | undefined, to: string, state: RepoState, repo: Repo): Promise<GitOp | undefined> {
  if (!op || !vscode.workspace.getConfiguration('gitardo').get<boolean>('submodules.updateOnCheckout', true)) return op;
  if (!state.submodules.length && !(await repo.hasSubmodulesAt(to))) return op;
  op.then = submodulesUpdateOp();
  const risks = state.submodules.map((submodule) => submoduleRisks(submodule, true));
  const lost = risks.flatMap((risk) => risk.lost);
  const notes = [...lost, ...risks.flatMap((risk) => risk.changes)];
  if (lost.length) op.confirm = true;
  if (notes.length) op.note = [op.note, 'Then the submodules go to the commits recorded for them.', ...notes].filter(Boolean).join('\n\n');
  return op;
}

/** A folder typed, with forward slashes and none at the end. */
const typedFolder = (value: string) => value.trim().replace(/\\/g, '/').replace(/\/+$/, '');

/** Asks for the URL of a repository to add as a submodule, the folder it goes in, and the branch it follows if any. */
async function addSubmodule(state: RepoState): Promise<GitOp | undefined> {
  const title = 'Add submodule';
  const url = (
    await vscode.window.showInputBox({
      title,
      prompt: 'URL of the repository, or its path on disk',
      placeHolder: 'https://github.com/owner/repo.git',
      validateInput: (value) => (!value.trim() ? 'Enter a URL' : value.trim().startsWith('-') ? 'That is not a URL' : undefined),
    })
  )?.trim();
  if (!url) return;
  const taken = new Set(state.submodules.filter((each) => !each.parent).map((each) => each.path));
  const typed = await vscode.window.showInputBox({
    title,
    prompt: 'Folder to clone it in, from the root of the repository',
    value: repoNameOfUrl(url),
    validateInput: (value) => {
      const folder = typedFolder(value);
      if (!folder) return 'Enter a folder';
      if (folder.startsWith('-') || folder.startsWith('/') || /^[a-z]:/i.test(folder) || folder.split('/').includes('..')) {
        return 'Enter a folder inside the repository';
      }
      if (taken.has(folder)) return 'A submodule is there already';
      const full = path.join(state.root, folder);
      if (fs.existsSync(full) && (!fs.statSync(full).isDirectory() || fs.readdirSync(full).length)) {
        return { message: `${full} is not empty`, severity: vscode.InputBoxValidationSeverity.Error };
      }
      return { message: `In ${full}`, severity: vscode.InputBoxValidationSeverity.Info };
    },
  });
  const dir = typed && typedFolder(typed);
  if (!dir) return;
  const branch = await vscode.window.showInputBox({
    title,
    prompt: 'Branch it follows, for updates from its remote. Leave empty for the default branch of the remote.',
    validateInput: (value) => (value.trim() ? refNameProblem(value.trim()) : undefined),
  });
  if (branch === undefined) return;
  return submoduleAddOp(url, dir, branch.trim());
}

function findWorktree(dir: string, state: RepoState): Worktree {
  const worktree = state.worktrees.find((candidate) => candidate.path === dir);
  if (!worktree) throw new Error(`${dir} is no longer a worktree of this repository.`);
  return worktree;
}

/** Said under the name being typed: where it puts the folder, or why it cannot. */
function folderMessage(dir: string): vscode.InputBoxValidationMessage {
  return fs.existsSync(dir)
    ? { message: `${dir} already exists`, severity: vscode.InputBoxValidationSeverity.Error }
    : { message: `In ${dir}`, severity: vscode.InputBoxValidationSeverity.Info };
}

/** Something `${input:<id>}` in the format of branch names asks for, as `gitardo.worktrees.inputs` defines it. */
interface WorktreeInput {
  id: string;
  type: 'promptString' | 'pickString';
  description?: string;
  default?: string;
  pattern?: string;
  options?: string[];
  allowCustom?: boolean;
}

/** Where the values typed or picked for the inputs last are kept, by their ids, to be proposed the next time. */
const LAST_INPUTS = 'worktreeInputs';

/** Where new worktrees go, as `gitardo.worktrees.folder` says, with `~` for the home folder. */
function worktreesHome(state: RepoState): { main: string; folder: string } {
  const main = state.worktrees.find((worktree) => worktree.main)?.path ?? state.root;
  const setting = vscode.workspace.getConfiguration('gitardo').get<string>('worktrees.folder', '');
  return { main, folder: setting.trim().replace(/^~(?=[\\/]|$)/, os.homedir()) };
}

/** Where new worktrees go, for the views to name the ones there by their path from it. */
export function worktreesFolder(state: RepoState): string {
  const { main, folder } = worktreesHome(state);
  return worktreesRoot(main, folder);
}

/**
 * After a worktree is moved or removed, the folders that held only it go too, up to where the worktrees are. On Windows
 * a folder that a process has just left, or that something else looks into, can be held for a moment: it is tried again.
 */
export async function removeEmptyParents(dir: string, state: RepoState): Promise<void> {
  const { main, folder } = worktreesHome(state);
  const home = worktreesRoot(main, folder);
  for (let parent = path.posix.dirname(dir.replace(/\\/g, '/')); parent.startsWith(`${home}/`); parent = path.posix.dirname(parent)) {
    if (!(await removeFolder(parent))) return;
  }
}

/** The little of the API of VS Code's Git extension that Gitardo uses. */
interface VSCodeGit {
  getAPI(version: 1): { repositories: { rootUri: vscode.Uri }[] };
}

/**
 * VS Code's Git extension opens the worktrees of the repositories it has as repositories of their own, runs git in
 * them and watches their folders: on Windows a folder that is watched, or that git runs in, can be neither moved nor
 * removed. Before Gitardo moves or removes worktrees, the extension closes the ones it has open.
 */
export async function closeInVSCodeGit(dirs: string[], log: OpLog): Promise<void> {
  const extension = vscode.extensions.getExtension<VSCodeGit>('vscode.git');
  if (!extension?.isActive) return;
  let repositories: { rootUri: vscode.Uri }[];
  try {
    ({ repositories } = extension.exports.getAPI(1));
  } catch {
    return;
  }
  for (const dir of dirs) {
    // Only one open as that very folder: given another, the command closes the repository that holds it, or asks which.
    const open = repositories.find((repository) => samePath(repository.rootUri.fsPath, dir));
    if (!open) continue;
    log.info(`> git.close ${dir}`);
    try {
      await vscode.commands.executeCommand('git.close', open);
    } catch (error) {
      log.warn(`VS Code's Git extension did not close ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** How many times, and how far apart, a folder that Windows holds is tried again. */
const HELD_RETRIES = 20;
const HELD_DELAY = 100;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Gets past `git worktree remove` and `git worktree move` failing on a folder that Windows holds, as it does for a
 * moment after VS Code's Git extension closes it or a git process in it ends. A move changed nothing, and is run again.
 * A removal cannot be: git lets go of the worktree even when it could not delete its folder, so what is left is deleted.
 */
export function recoverHeldWorktree(root: string): (args: string[], error: GitError, log: OpLog) => Promise<boolean> {
  return async (args, error, log) => {
    if (process.platform !== 'win32' || args[0] !== 'worktree') return false;
    const said = error.message.split('\n')[0];
    if (args[1] === 'move' && /failed to move .*: (Permission denied|Invalid argument|Device or resource busy)/.test(error.message)) {
      log.warn(`${said}: Windows holds the folder, so it is tried again.`);
      for (let attempt = 0; attempt < HELD_RETRIES; attempt++) {
        await wait(HELD_DELAY * 2);
        try {
          await git(root, args);
          log.info(`> ${formatCommand(args)}`);
          return true;
        } catch {
          // Still held, or failing for another reason: the last one says which.
        }
      }
      return false;
    }
    if (args[1] === 'remove' && /failed to delete '/.test(error.message)) {
      const dir = args[args.length - 1];
      const { stdout } = await git(root, ['worktree', 'list', '--porcelain'], { readOnly: true });
      if (parseWorktrees(stdout, root).some((worktree) => samePath(worktree.path, dir))) return false;
      log.warn(`${said}: Windows held the folder. It is no longer a worktree, and Gitardo deletes what is left of it.`);
      log.info(`> delete ${dir}`);
      try {
        // Links are deleted, not followed: the ones to this checkout went before git ran. Each retry waits longer.
        await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: HELD_DELAY });
        return true;
      } catch (failure) {
        log.warn(`${dir} was not deleted: ${failure instanceof Error ? failure.message : String(failure)}`);
        return false;
      }
    }
    return false;
  };
}

/**
 * Has VS Code's Git extension close a submodule, and the ones inside it, before an operation empties or deletes its
 * folder, which Windows would refuse while the extension watches it; a command it still stops on is run again for a
 * while. Git checks and writes its index only once the folder is gone, so running it again is safe.
 */
function lettingGoOf(op: GitOp, submodule: Submodule, state: RepoState): GitOp {
  const inside = state.submodules.filter((each) => each.path === submodule.path || each.path.startsWith(`${submodule.path}/`));
  op.prepare = (log) => closeInVSCodeGit(inside.filter((each) => each.head !== null).map((each) => submoduleFolder(each, state)), log);
  op.recover = async (args, error, log) => {
    if (process.platform !== 'win32' || !/could not remove|Permission denied|Device or resource busy/.test(error.message)) return false;
    log.warn(`${error.message.split('\n')[0]}: Windows holds the folder, so it is tried again.`);
    for (let attempt = 0; attempt < HELD_RETRIES; attempt++) {
      await wait(HELD_DELAY * 2);
      try {
        await git(state.root, args);
        log.info(`> ${formatCommand(args)}`);
        return true;
      } catch {
        // Still held, or failing for another reason: the last one says which.
      }
    }
    return false;
  };
  if (op.fallback) lettingGoOf(op.fallback.op, submodule, state);
  return op;
}

/** Removes an empty folder, trying again for a while when it is held. False when it is not empty, or not removed. */
async function removeFolder(dir: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmdirSync(dir);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= HELD_RETRIES || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) return false;
      await new Promise((resolve) => setTimeout(resolve, HELD_DELAY));
    }
  }
}

/** Asks for one input of the format. Undefined when the user backs out. */
async function askInput(input: WorktreeInput, title: string, last: string | undefined): Promise<string | undefined> {
  const prompt = input.description || input.id;
  const proposed = last ?? input.default ?? '';
  if (input.type === 'pickString') {
    const options = input.options ?? [];
    const OTHER = 'Type another value…';
    // The value proposed is first, where the picker starts.
    const values = [...new Set([...(options.includes(proposed) || (input.allowCustom && proposed) ? [proposed] : []), ...options])];
    const picked = await vscode.window.showQuickPick(
      [
        ...values.map((value) => ({ label: value, description: options.includes(value) ? undefined : 'Used last' })),
        ...(input.allowCustom ? [{ label: OTHER }] : []),
      ],
      { title, placeHolder: prompt },
    );
    if (!picked) return;
    if (picked.label !== OTHER) return picked.label;
    const typed = await vscode.window.showInputBox({ title, prompt, validateInput: (value) => (value.trim() ? undefined : 'Enter a value') });
    return typed?.trim() || undefined;
  }
  let pattern: RegExp | undefined;
  try {
    pattern = input.pattern ? new RegExp(input.pattern) : undefined;
  } catch {
    throw new Error(`The pattern of the input ${input.id} in gitardo.worktrees.inputs is not a valid regular expression.`);
  }
  const problem = (value: string) =>
    !value.trim() ? 'Enter a value' : pattern && !pattern.test(value.trim()) ? `It has to match ${input.pattern}` : undefined;
  const typed = await vscode.window.showInputBox({ title, prompt, value: proposed, validateInput: problem });
  if (typed === undefined) return;
  const trouble = problem(typed);
  if (trouble) throw new Error(`${prompt}: ${trouble}.`);
  return typed.trim();
}

/**
 * The name of a new branch made from the format of `gitardo.worktrees.branchFormat`: each input is asked for, and the
 * name it makes can be changed before it is used.
 */
async function nameFromFormat(
  format: string,
  base: string,
  title: string,
  state: RepoState,
  memory: vscode.Memento,
  validate: (name: string) => string | vscode.InputBoxValidationMessage | undefined,
): Promise<string | undefined> {
  const inputs = vscode.workspace.getConfiguration('gitardo').get<WorktreeInput[]>('worktrees.inputs', []);
  const problem = formatProblem(format, inputs.map((input) => input.id));
  if (problem) throw new Error(`${problem} Change it in the settings.`);
  const last = memory.get<Record<string, string>>(LAST_INPUTS, {});
  const values: Record<string, string> = {};
  for (const id of formatInputs(format)) {
    const value = await askInput(inputs.find((input) => input.id === id)!, title, last[id]);
    if (value === undefined) return;
    values[id] = value;
  }
  await memory.update(LAST_INPUTS, { ...last, ...values });
  const date = new Date();
  const name = expandFormat(format, {
    base,
    repo: path.basename(worktreesHome(state).main),
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    inputs: values,
  });
  return (await vscode.window.showInputBox({ title, prompt: 'Name of the new branch, and of the folder of the worktree', value: name, validateInput: validate }))?.trim();
}

/** What `${base}` is for a worktree made at a commit: the commit, or one of the branches that have it. */
async function commitBase(hash: string, title: string, state: RepoState, repo: Repo): Promise<string | undefined> {
  const short = hash.slice(0, 7);
  const at = new Set([...state.branches, ...state.remoteBranches].filter((ref) => ref.hash === hash).map((ref) => ref.name));
  const names = (await repo.branchesContaining(hash)).map((ref) =>
    ref.startsWith('refs/heads/') ? ref.slice(11) : ref.slice(13),
  );
  const branches = new Map<string, boolean>();
  // The ones at the commit first, then the others that have it, each by its own name: a remote branch without its remote.
  for (const name of [...names.filter((name) => at.has(name)), ...names.filter((name) => !at.has(name))].slice(0, 50)) {
    const own = state.remoteBranches.some((ref) => ref.name === name) ? withoutRemote(name, state.remotes) : name;
    if (!branches.has(own)) branches.set(own, at.has(name));
  }
  const atCommit = [...branches].filter(([, exact]) => exact);
  const containing = [...branches].filter(([, exact]) => !exact);
  return pick(`${title}: what \${base} is`, [
    ...atCommit.map(([name]) => ({ label: name, description: 'Branch at this commit', value: name })),
    { label: short, description: 'This commit', value: short },
    ...containing.map(([name]) => ({ label: name, description: 'Branch that has this commit', value: name })),
  ]);
}

/**
 * A worktree goes in the folder the settings name, in a folder named after it, slashes and all. Without `ref` it is on a
 * new branch made from a base the user picks; on a branch, on that branch or on a new one made from it; at a commit, on a
 * new branch made there, or on a detached HEAD. A new branch is named from the format, when the settings have one and the
 * user keeps it, or typed.
 */
async function addWorktree(
  ref: string | undefined,
  isBranch: boolean,
  state: RepoState,
  repo: Repo,
  memory: vscode.Memento,
): Promise<GitOp | undefined> {
  const { main, folder } = worktreesHome(state);
  const dirOf = (name: string) => worktreeDir(main, folder, name);
  const taken = new Set(state.branches.map((branch) => branch.name));
  // Git keeps a branch as a file: `feature/login` cannot be made beside a branch `feature`, nor `feature` beside it.
  const clash = (name: string) => state.branches.find((branch) => branch.name.startsWith(`${name}/`) || name.startsWith(`${branch.name}/`));
  const branchName = (name: string) =>
    refNameProblem(name) ??
    (taken.has(name) ? 'A branch with that name already exists' : undefined) ??
    (clash(name) ? `Git cannot have it beside the branch ${clash(name)!.name}` : undefined) ??
    folderMessage(dirOf(name));
  const commit = ref && !isBranch ? ref.slice(0, 7) : undefined;
  const title = `Create worktree${!ref ? '' : isBranch ? ` for ${ref}` : ` at ${commit}`}`;

  // The format is the first choice, where the picker starts.
  const format = vscode.workspace.getConfiguration('gitardo').get<string>('worktrees.branchFormat', '').trim();
  let useFormat = false;
  if (format) {
    const how = await pick(title, [
      { label: 'Use the format', description: format, value: true },
      isBranch
        ? { label: `Use the branch ${ref}`, description: 'Check it out in the worktree', value: false }
        : { label: 'Type a branch name', value: false },
    ]);
    if (how === undefined) return;
    useFormat = how;
  }

  // What it starts from: the branch or the commit it was made on, or a base the user picks.
  let base = ref;
  let baseName = ref ?? '';
  if (!base) {
    const current = state.branches.find((branch) => branch.current);
    const picked = await pick(`${title} from`, [
      ...(current
        ? [{ label: current.name, description: 'Checked out', value: { arg: refArg('branch', current.name, state), name: current.name } }]
        : state.head
          ? [{ label: 'HEAD', description: 'Detached', value: { arg: state.head, name: state.head.slice(0, 7) } }]
          : []),
      ...state.branches
        .filter((branch) => !branch.current)
        .map((branch) => ({ label: branch.name, value: { arg: refArg('branch', branch.name, state), name: branch.name } })),
      ...state.remoteBranches.map((remote) => ({
        label: remote.name,
        description: 'Remote',
        value: { arg: refArg('remote', remote.name, state), name: withoutRemote(remote.name, state.remotes) },
      })),
    ]);
    if (!picked) return;
    base = picked.arg;
    baseName = picked.name;
  } else if (commit && useFormat && /\$\{base\}/.test(format)) {
    const chosen = await commitBase(ref!, title, state, repo);
    if (chosen === undefined) return;
    baseName = chosen;
  }

  let newBranch: string | null = null;
  let dir: string;
  if (useFormat) {
    const name = await nameFromFormat(format, baseName, title, state, memory, branchName);
    if (!name) return;
    newBranch = name;
    dir = dirOf(name);
  } else if (isBranch) {
    const name = (
      await vscode.window.showInputBox({
        title,
        prompt: 'Name of the folder of the worktree',
        value: ref,
        validateInput: (value) => (value.trim() ? folderMessage(dirOf(value.trim())) : 'Enter a name'),
      })
    )?.trim();
    if (!name) return;
    dir = dirOf(name);
  } else {
    const name = await vscode.window.showInputBox({
      title,
      prompt: commit
        ? 'Name of a new branch, and of the folder of the worktree. Leave empty for a detached HEAD.'
        : 'Name of the new branch, and of the folder of the worktree',
      placeHolder: 'feature/my-change',
      validateInput: (value) => (value ? branchName(value) : commit ? folderMessage(dirOf(commit)) : 'Enter a name'),
    });
    if (name === undefined || (!name.trim() && !commit)) return;
    newBranch = name.trim() || null;
    dir = dirOf(newBranch ?? commit!);
  }
  if (newBranch) {
    const problem = branchName(newBranch);
    if (typeof problem === 'string') throw new Error(`${newBranch}: ${problem}.`);
  }
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists.`);

  const op = worktreeAddOp(dir, base!, newBranch, !isBranch);
  // While new worktrees get nothing of what git ignores, the first one created says it can be chosen, once.
  const offerSetup = !setupNote(setupPatterns(state.root), state.root) && !memory.get(SETUP_OFFERED);
  op.onSuccess = () => {
    if (offerSetup) void memory.update(SETUP_OFFERED, true);
    const choices = [...(state.agentsWindow ? ['Open in Agents Window'] : []), 'Open in New Window', ...(offerSetup ? [SET_UP] : [])];
    void vscode.window.showInformationMessage(`Worktree created in ${dir}`, ...choices).then((choice) => {
      if (choice === SET_UP) void vscode.commands.executeCommand('gitardo.worktreeSetup');
      else if (choice) void openWorktree(dir, choice === 'Open in Agents Window' ? 'agents' : 'window');
    });
  };
  return withSetup(op, dir, state);
}

/**
 * Renames the folder of a worktree, and its branch along with it if the user wants. Inside the folder where the worktrees
 * go, its name is its path from there, slashes and all; anywhere else, the name of its folder where it is.
 */
async function renameWorktree(worktree: Worktree, state: RepoState): Promise<GitOp | undefined> {
  if (worktree.main) throw new Error('Git cannot move the main worktree, the folder the repository was created in.');
  if (worktree.current || isHome(worktree.path, state)) throw new Error('This worktree is the folder open in this window: rename it from another one.');
  const dir = worktree.path.replace(/\\/g, '/');
  const { main, folder } = worktreesHome(state);
  const home = worktreesRoot(main, folder);
  const inside = dir.toLowerCase().startsWith(`${home.toLowerCase()}/`);
  const parent = inside ? home : dir.slice(0, dir.lastIndexOf('/'));
  const old = dir.slice(parent.length + 1);
  const name = (
    await vscode.window.showInputBox({
      title: `Rename worktree ${old}`,
      prompt: inside ? 'New name of its folder, which can have slashes' : 'New name of its folder',
      value: old,
      validateInput: (value) => {
        if (!value.trim()) return 'Enter a name';
        const renamed = inside ? worktreeFolderName(value.trim()) : worktreeFolderName(value.trim()).replace(/\//g, '-');
        return renamed === old ? undefined : folderMessage(`${parent}/${renamed}`);
      },
    })
  )?.trim();
  if (!name) return;
  const renamed = inside ? worktreeFolderName(name) : worktreeFolderName(name).replace(/\//g, '-');
  if (renamed === old) return;
  const to = `${parent}/${renamed}`;
  if (fs.existsSync(to)) throw new Error(`${to} already exists.`);

  let branch: { from: string; to: string } | undefined;
  if (worktree.branch) {
    const from = worktree.branch;
    const rename = await pick(`Rename worktree ${old} to ${renamed}`, [
      { label: `Rename the branch ${from} too`, value: true },
      { label: `Keep the branch ${from}`, value: false },
    ]);
    if (rename === undefined) return;
    if (rename) {
      // The branch the folder was named after takes the new name as it was typed.
      const named = worktreeFolderName(from) === old && !refNameProblem(name) && !state.branches.some((each) => each.name === name);
      const next = await askName(`Rename branch ${from}`, state, 'branch', named ? name : from);
      if (!next) return;
      if (next !== from) branch = { from, to: next };
    }
  }
  const op = worktreeMoveOp(worktree.path, to, branch);
  // Git moves a worktree into a folder that is there already.
  op.prepare = async (log) => {
    await closeInVSCodeGit([worktree.path], log);
    fs.mkdirSync(path.dirname(to), { recursive: true });
  };
  op.recover = recoverHeldWorktree(state.root);
  op.finish = () => removeEmptyParents(dir, state);
  return op;
}
