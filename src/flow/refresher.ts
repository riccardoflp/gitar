import * as vscode from 'vscode';
import { git } from '../git/exec';
import type { DiffPanel, PanelRegistry } from './panel';
import { fileUri } from './sides';

const DEBOUNCE_MS = 250;

const rootKey = (root: string) => root.replace(/\\/g, '/').toLowerCase();

/**
 * Keeps open diff panels in sync with the working tree and the index.
 *
 * Only the panels affected by an event are refreshed (same file, or same
 * repository for git state changes), runs never overlap, and a panel whose
 * inputs did not change skips the diff entirely (see `refreshPanel`).
 */
export class Refresher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /** The git folders watched, by repository: what moves the index or HEAD, whoever does it. */
  private readonly watched = new Map<string, Promise<vscode.Disposable | undefined>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly pendingFiles = new Set<string>();
  private readonly pendingRepos = new Set<string>();
  private running = false;
  private rerun = false;

  constructor(
    private readonly registry: PanelRegistry,
    private readonly refresh: (panel: DiffPanel) => Promise<void>,
  ) {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => this.schedule(this.pendingFiles, document.uri.toString())),
      // live diff while typing (incl. echoes of webview edits): only for files
      // that actually have an open diff panel
      vscode.workspace.onDidChangeTextDocument((event) => {
        const changed = event.document.uri.toString();
        if (this.registry.all().some((panel) => fileUri(panel.descriptor).toString() === changed)) {
          this.schedule(this.pendingFiles, changed);
        }
      }),
    );
  }

  /** Something changed in a repository, as Gitardo has just read it. */
  repositoryChanged(root: string): void {
    this.schedule(this.pendingRepos, rootKey(root));
  }

  /** Starts watching the git folder of a repository that has a panel open. */
  watch(root: string): void {
    const key = rootKey(root);
    if (this.watched.has(key)) return;
    this.watched.set(
      key,
      git(root, ['rev-parse', '--absolute-git-dir'], { readOnly: true }).then(
        ({ stdout }) => {
          const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(stdout.trim()), '{index,HEAD}'));
          const changed = () => this.repositoryChanged(root);
          return vscode.Disposable.from(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed));
        },
        () => undefined,
      ),
    );
  }

  private schedule(pending: Set<string>, key: string): void {
    pending.add(key);
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.run(), DEBOUNCE_MS);
  }

  private async run(): Promise<void> {
    this.timer = undefined;
    if (this.running) {
      this.rerun = true; // picked up when the current run ends
      return;
    }
    this.running = true;
    try {
      const files = new Set(this.pendingFiles);
      const repos = new Set(this.pendingRepos);
      this.pendingFiles.clear();
      this.pendingRepos.clear();
      const affected = (panel: DiffPanel) =>
        files.has(fileUri(panel.descriptor).toString()) || repos.has(rootKey(panel.descriptor.repoRoot));
      for (const panel of this.registry.all().filter(affected)) {
        await this.refresh(panel);
      }
    } finally {
      this.running = false;
      if (this.rerun) {
        this.rerun = false;
        void this.run();
      }
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.disposables.forEach((d) => d.dispose());
    for (const watcher of this.watched.values()) void watcher.then((disposable) => disposable?.dispose());
  }
}
