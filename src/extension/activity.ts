import * as vscode from 'vscode';

/** The command of the item in the status bar: what is running, in a list. */
export const SHOW_ACTIVITY = 'gitardo.showActivity';

/** How long something runs before the status bar shows it: what is over sooner would only flicker there. */
const SHOWN_AFTER = 500;

/** Something Gitardo is doing that takes time: what it is, and since when. */
export class Task {
  readonly started = Date.now();

  constructor(
    private readonly activity: Activity,
    public title: string,
    /** What else there is to know about it, such as what asked for it. */
    public detail?: string,
  ) {}

  /** Says something else about it while it runs. */
  describe(detail: string | undefined, title = this.title): void {
    this.detail = detail;
    this.title = title;
    this.activity.render();
  }

  end(): void {
    this.activity.remove(this);
  }
}

/**
 * What Gitardo is doing that takes time, in the status bar for as long as it lasts: reading a repository, running an
 * operation, asking GitHub. The tooltip says what each thing is and for how long it has run, and so does a click.
 */
export class Activity implements vscode.Disposable {
  private readonly tasks = new Set<Task>();
  // Beside the item that opens the graph.
  private readonly item = vscode.window.createStatusBarItem('gitardo.activity', vscode.StatusBarAlignment.Left, -0.5);
  /** Ticks while something runs, for the times in the tooltip and for showing the item once it has run long enough. */
  private ticking?: ReturnType<typeof setInterval>;
  /** The list a click opened, kept up to date while it is open. */
  private picker?: vscode.QuickPick<vscode.QuickPickItem>;

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.item.name = 'Gitardo Activity';
    this.item.text = '$(loading~spin) Gitardo';
    this.item.command = SHOW_ACTIVITY;
  }

  /** What is running now, the oldest first. */
  get running(): readonly Task[] {
    return [...this.tasks];
  }

  /** Marks the start of something; it lasts until its `end`. */
  start(title: string, detail?: string): Task {
    const task = new Task(this, title, detail);
    this.tasks.add(task);
    this.ticking ??= setInterval(() => this.render(), SHOWN_AFTER);
    this.render();
    return task;
  }

  /** Shows `title` for as long as `work` runs. */
  async track<T>(title: string, work: () => Promise<T>): Promise<T> {
    const task = this.start(title);
    try {
      return await work();
    } finally {
      task.end();
    }
  }

  remove(task: Task): void {
    this.tasks.delete(task);
    if (!this.tasks.size) {
      clearInterval(this.ticking);
      this.ticking = undefined;
    }
    this.render();
  }

  render(): void {
    const now = Date.now();
    const tasks = this.running;
    if (!tasks.some((task) => now - task.started >= SHOWN_AFTER)) this.item.hide();
    else {
      const tooltip = new vscode.MarkdownString('', true);
      for (const task of tasks) {
        tooltip.appendMarkdown('**').appendText(task.title).appendMarkdown('**').appendText(` · ${duration(now - task.started)}`);
        if (task.detail) tooltip.appendMarkdown('  \n').appendText(task.detail);
        tooltip.appendMarkdown('\n\n');
      }
      tooltip.appendMarkdown('Click to see what Gitardo is doing in a list.');
      // Set only when it changes: an open tooltip is drawn again each time it is set.
      if ((this.item.tooltip as vscode.MarkdownString | undefined)?.value !== tooltip.value) this.item.tooltip = tooltip;
      this.item.show();
    }
    if (this.picker) this.picker.items = this.items(now);
  }

  /** Lists what is running, with the way to the log of the commands that Gitardo runs. */
  show(): void {
    if (this.picker) return;
    const picker = vscode.window.createQuickPick();
    picker.title = 'Gitardo';
    picker.placeholder = 'What Gitardo is doing now';
    picker.items = this.items(Date.now());
    // The times in it go on while it is open, even when nothing else changes.
    const ticking = setInterval(() => this.render(), 1000);
    picker.onDidAccept(() => {
      if (picker.selectedItems[0]?.label === LOG_ITEM.label) this.log.show();
      picker.hide();
    });
    picker.onDidHide(() => {
      clearInterval(ticking);
      picker.dispose();
      this.picker = undefined;
    });
    this.picker = picker;
    picker.show();
  }

  private items(now: number): vscode.QuickPickItem[] {
    const tasks = this.running.map((task) => ({ label: task.title, description: duration(now - task.started), detail: task.detail }));
    const idle = { label: 'Nothing is running now', description: 'Gitardo is not reading or changing anything' };
    return [...(tasks.length ? tasks : [idle]), { label: '', kind: vscode.QuickPickItemKind.Separator }, LOG_ITEM];
  }

  dispose(): void {
    clearInterval(this.ticking);
    this.picker?.dispose();
    this.item.dispose();
  }
}

const LOG_ITEM: vscode.QuickPickItem = { label: '$(output) Show the commands Gitardo runs', description: 'The Gitardo output channel' };

/** How long something has run, as the status bar can say it. */
function duration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
