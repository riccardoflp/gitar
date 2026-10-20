import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SetupChange } from '../git/worktreeSetup';
import {
  cleanPatterns,
  namedPaths,
  type SetupChoice,
  type SetupLayer,
  type SetupPatterns,
  type SetupSource,
  type SetupTarget,
  type WorktreeSetupInfo,
} from '../shared/worktreeSetup';

/** Gitardo's settings, under `gitardo`, and VS Code's, under `git`, which apply where Gitardo's are not set. */
const OURS = { link: 'worktrees.linkFolders', copy: 'worktrees.copyFiles' } as const;
const THEIRS = { link: 'worktreeSymlinkFolders', copy: 'worktreeIncludeFiles' } as const;

type Kind = keyof typeof OURS;

const config = (section: 'gitardo' | 'git', root: string) => vscode.workspace.getConfiguration(section, vscode.Uri.file(root));

/**
 * The patterns that new worktrees of the repository in `root` get, and where each of the two comes from: Gitardo's
 * setting wherever it is set, even empty, or else VS Code's.
 */
export function setupPatterns(root: string): SetupPatterns & { linkFrom: SetupSource; copyFrom: SetupSource } {
  const one = (kind: Kind): [string[], SetupSource] => {
    const set = config('gitardo', root).inspect<unknown>(OURS[kind]);
    const workspace = set?.workspaceFolderValue ?? set?.workspaceValue;
    if (workspace !== undefined) return [cleanPatterns(workspace), 'workspace'];
    if (set?.globalValue !== undefined) return [cleanPatterns(set.globalValue), 'user'];
    const theirs = cleanPatterns(config('git', root).get(THEIRS[kind]));
    return [theirs, theirs.length ? 'vscode' : 'none'];
  };
  const [link, linkFrom] = one('link');
  const [copy, copyFrom] = one('copy');
  return { link, copy, linkFrom, copyFrom };
}

/** What is set in one place, each of the two missing where it is not set there. */
function layer(root: string, place: 'globalValue' | 'workspaceFolderValue'): SetupLayer {
  const value = (kind: Kind) => {
    const set = config('gitardo', root).inspect<unknown>(OURS[kind]);
    const found = place === 'globalValue' ? set?.globalValue : (set?.workspaceFolderValue ?? set?.workspaceValue);
    return found === undefined ? undefined : cleanPatterns(found);
  };
  return { link: value('link'), copy: value('copy') };
}

/**
 * What the page shows of the settings of the repository in `root`, whose other worktrees are `worktrees`: all but what
 * git ignores, which takes longer to look at.
 */
export function worktreeSetupInfo(root: string, worktrees: number): Omit<WorktreeSetupInfo, 'entries'> {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
  const { link, copy, linkFrom, copyFrom } = setupPatterns(root);
  return {
    root,
    user: layer(root, 'globalValue'),
    workspace: folder
      ? { ...layer(root, 'workspaceFolderValue'), name: folder.name, file: path.join(folder.uri.fsPath, '.vscode', 'settings.json') }
      : null,
    vscode: { link: cleanPatterns(config('git', root).get(THEIRS.link)), copy: cleanPatterns(config('git', root).get(THEIRS.copy)) },
    effective: { link, copy, linkFrom, copyFrom },
    worktrees,
  };
}

const targetOf = (target: SetupTarget) =>
  target === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.WorkspaceFolder;

/**
 * Saves the patterns in the settings of the user or of the workspace folder that has the repository, and in VS Code's
 * own settings there too when `alsoVSCode`, for the worktrees VS Code creates. Null patterns take the settings out of
 * that place, so that what is set elsewhere applies again.
 */
export async function saveSetup(root: string, target: SetupTarget, patterns: SetupPatterns | null, alsoVSCode: boolean): Promise<void> {
  const where = targetOf(target);
  for (const kind of ['link', 'copy'] as const) {
    const value = patterns ? cleanPatterns(patterns[kind]) : undefined;
    await config('gitardo', root).update(OURS[kind], value, where);
    if (alsoVSCode && value) await config('git', root).update(THEIRS[kind], value, where);
  }
}

/**
 * Saves the patterns of the folders to link, or of the files to copy, where what applies now comes from: the settings
 * of the user or of the workspace folder that has the repository. Where VS Code's setting applies, or none, Gitardo's
 * goes in the workspace folder, or in the user's settings when the repository is in no folder of the workspace. Returns
 * where it went.
 */
export async function savePatterns(root: string, kind: Kind, patterns: string[], from: SetupSource): Promise<SetupTarget> {
  const target = from === 'user' || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root)) ? 'user' : 'workspace';
  await config('gitardo', root).update(OURS[kind], cleanPatterns(patterns), targetOf(target));
  return target;
}

/** Opens the file of the settings of the user or of the workspace folder, at Gitardo's setting of the folders to link. */
export async function editSetupJson(root: string, target: SetupTarget): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
  if (target === 'user' || !folder) {
    await vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key: `gitardo.${OURS.link}` } });
    return;
  }
  const file = vscode.Uri.joinPath(folder.uri, '.vscode', 'settings.json');
  try {
    await vscode.workspace.fs.stat(file);
    await vscode.window.showTextDocument(file);
  } catch {
    // Not there yet: VS Code makes it, as it does from its own Settings editor.
    await vscode.commands.executeCommand('workbench.action.openFolderSettingsFile', folder.uri);
  }
}

/** What became of `name`, a file or a folder of the checkout, given to new worktrees or taken from them, said for the user. */
export function setupChangeText(name: string, folder: boolean, choice: SetupChoice, change: SetupChange): string {
  const done = (taken: 'link' | 'copy') => (taken === 'link' ? 'linked' : 'copied');
  switch (change.kind) {
    case 'done':
      if (choice === 'none') return `New worktrees will no longer get ${name}.`;
      return change.partly ? `What git ignores in ${name} will be copied into new worktrees.` : `${name} will be ${done(choice)} into new worktrees.`;
    case 'still':
      return `${name} is still ${done(change.choice)} into new worktrees, by the pattern ${change.by}.`;
    case 'already':
      return `${name} is ${choice === 'copy' ? 'copied' : 'linked'} into new worktrees already, by the pattern ${change.by}.`;
    case 'tracked':
      return folder ? `Git tracks files in ${name}: each worktree has them from its commit.` : `Git tracks ${name}: each worktree has it from its commit.`;
    case 'notIgnored':
      return `Git ${change.partly ? 'ignores only part of' : 'does not ignore'} ${name}: only what it ignores is linked or copied into new worktrees.`;
    case 'linked':
      return change.folder === name
        ? `${name} is linked into new worktrees by the pattern ${change.by}, which comes before copying.`
        : `${name} is in ${change.folder}, which the pattern ${change.by} links into new worktrees: nothing in it is copied.`;
  }
}

/**
 * Tells the context menu of the Explorer which files and folders of the repositories in `roots` new worktrees get by a
 * pattern of their own path, for it to offer to stop it.
 */
export function showSetupInMenus(roots: string[]): void {
  const named = { link: {} as Record<string, true>, copy: {} as Record<string, true> };
  for (const root of roots) {
    const patterns = setupPatterns(root);
    for (const kind of ['link', 'copy'] as const) {
      for (const relative of namedPaths(patterns[kind])) named[kind][vscode.Uri.file(path.join(root, relative)).fsPath] = true;
    }
  }
  void vscode.commands.executeCommand('setContext', 'gitardo.linkedIntoWorktrees', named.link);
  void vscode.commands.executeCommand('setContext', 'gitardo.copiedIntoWorktrees', named.copy);
}
