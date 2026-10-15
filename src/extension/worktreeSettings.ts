import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  cleanPatterns,
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
