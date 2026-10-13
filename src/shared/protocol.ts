/** Pseudo-hash of the row that stands for uncommitted changes. */
export const WORKTREE = 'WORKTREE';

export interface GraphLine {
  from: number;
  to: number;
  color: number;
}

/** What to draw in the graph cell of one row: `top` runs from the row's top edge to its middle, `bottom` from the middle down. */
export interface GraphRow {
  col: number;
  color: number;
  top: GraphLine[];
  bottom: GraphLine[];
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: number;
  subject: string;
}

export interface Row extends Commit {
  graph: GraphRow;
}

export interface Upstream {
  name: string;
  remote: string;
  branch: string;
  ahead: number;
  behind: number;
  gone: boolean;
}

export interface Branch {
  name: string;
  hash: string;
  current: boolean;
  upstream?: Upstream;
}

export interface NamedRef {
  name: string;
  hash: string;
}

export interface Stash {
  ref: string;
  hash: string;
  message: string;
  date: number;
}

export interface Worktree {
  path: string;
  hash: string;
  branch: string | null;
  current: boolean;
  /** Its directory is gone, so `git worktree prune` would forget it. */
  prunable: boolean;
}

export interface FileChange {
  status: string;
  path: string;
  oldPath?: string;
}

/** The working tree split the way `git status` reports it. Untracked files are in `unstaged` with the status `?`. */
export interface WorkingState {
  staged: FileChange[];
  unstaged: FileChange[];
  conflicts: FileChange[];
}

/**
 * Narrows the graph to some commits. A path filter keeps the graph connected, because git can skip over
 * the commits in between; the search filters return unrelated commits, shown as a plain list.
 */
export type Filter =
  /** `renamedFrom`: the names the file had before, which the extension finds and adds to the state it sends back. */
  | { kind: 'path'; path: string; renamedFrom?: string[] }
  /** Only what is reachable from one branch, tag or commit. `lost` when it is a commit that no branch or tag reaches any more. */
  | { kind: 'ref'; ref: string; lost?: boolean }
  /** `message` and `author` match text; `pickaxe` finds commits that add or remove the text; `regex` matches changed lines. */
  | { kind: 'message' | 'author' | 'pickaxe' | 'regex'; query: string };

/**
 * Which histories the graph shows, when not those of every branch, remote branch and tag: of what is checked out, of
 * the local branches, or of the references chosen one by one, by their full names (`refs/heads/main`). It is apart
 * from the filter, which narrows what is left of it.
 */
export type Scope = { kind: 'current' } | { kind: 'local' } | { kind: 'refs'; refs: string[] };

/** A search that git runs, in the whole history rather than in the commits that are loaded. */
export type Search = Extract<Filter, { query: string }>;

/** A `git bisect` in progress. HEAD is the commit git wants tested next. */
export interface Bisect {
  good: string[];
  bad: string | null;
  skipped: string[];
  /** How many commits can still be the first bad one, counting `bad` itself. Null until both a good and a bad commit are known. */
  suspects: number | null;
}

/** One of the repositories of the workspace. */
export interface RepoInfo {
  root: string;
  name: string;
}

/** Who git will record as the author of a commit made here. Empty strings when nothing is configured. */
export interface Identity {
  name: string;
  email: string;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  /** Combined result of the checks on its last commit, or null when there are none. */
  checks: 'success' | 'failure' | 'pending' | null;
}

/**
 * Why a conflict needs no choice between its two sides: they changed lines next to each other (`separate`), they made
 * the same change (`same`), they differ in spaces or line endings only (`whitespace`), or only one of them changed
 * the lines after all (`oneSide`).
 */
export type Resolution = 'separate' | 'same' | 'whitespace' | 'oneSide';

/** A file in conflict whose text has the markers of git: how many conflicts it has, and how the ones that need no choice resolve. */
export interface ConflictFile {
  path: string;
  conflicts: number;
  resolvable: Resolution[];
}

/** A multi-step git operation that stopped and waits for the user. */
export type Operation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface RepoState {
  root: string;
  name: string;
  head: string | null;
  branch: string | null;
  branches: Branch[];
  remoteBranches: NamedRef[];
  tags: NamedRef[];
  stashes: Stash[];
  worktrees: Worktree[];
  remotes: string[];
  rows: Row[];
  hasMore: boolean;
  /** Number of files with uncommitted changes. */
  changes: number;
  working: WorkingState;
  /** The files in conflict that have the markers of git in them, with what can be resolved of each without a choice. */
  conflictFiles: ConflictFile[];
  operation: Operation | null;
  bisect: Bisect | null;
  identity: Identity;
  filter: Filter | null;
  /** The branches the graph is narrowed to, without the ones that are no longer there. Null when it shows them all. */
  scope: Scope | null;
  /** The local branches that were checked out last, the latest first, without the one that is checked out now. */
  recentBranches: string[];
  /** The branches and remote branches the user marked as favorites, by their full names, in the order they were marked. */
  favorites: string[];
  /** What the Pull button runs, which the settings choose. The menu beside it has every way to pull. */
  defaultPull: PullAction;
  /** Every repository found in the workspace, when there is more than this one to choose from. */
  repos: RepoInfo[];
  /** Set when the main remote is a GitHub repository. */
  github: { owner: string; repo: string } | null;
  /** Open pull requests by the name of their branch. Empty until the user signs in to GitHub. */
  pulls: Record<string, PullRequest>;
}

/** The commits of what is checked out, for the view that lists them apart from the graph. */
export interface BranchLog {
  /** The repository they are of. */
  root: string;
  /** Newest first. */
  commits: Commit[];
  hasMore: boolean;
  /** The ones among them that are not pushed. Null where there is no remote to push to. */
  unpushed: string[] | null;
  /** What they are not in: the upstream of the branch, by its short name. Null when it is every remote branch. */
  upstream: string | null;
}

export interface CommitDetail extends Commit {
  committer: string;
  committerEmail: string;
  commitDate: number;
  body: string;
  files: FileChange[];
  /** For a stash made with its untracked files: those files, and the commit inside the stash that holds them. */
  untracked?: { hash: string; files: FileChange[] };
}

export type SyncAction =
  | 'fetch'
  | 'pull'
  | 'pullRebase'
  /** The two ways to pull, with the changes that are not committed set aside first and put back after. */
  | 'pullAutostash'
  | 'pullRebaseAutostash'
  | 'push'
  | 'pushForceWithLease'
  | 'pushForce';

/** The ways to pull. */
export type PullAction = Extract<SyncAction, `pull${string}`>;

/** The files that differ between two commits, going from `from` to `to`. */
export interface Comparison {
  from: string;
  to: string;
  files: FileChange[];
}

/** Two commits to compare, with the names to show for them. */
export interface Comparing {
  from: string;
  to: string;
  fromName: string;
  toName: string;
}

/** One side of a comparison: a commit, and the branch, tag or short hash to call it by. */
export interface ComparedRef {
  name: string;
  hash: string;
}

/**
 * What a view shows. `graph` is everything, in the panel or in an editor tab. `changes`, `commits`, `sideGraph`,
 * `branches` and `stashes` are the views of the side bar: `commits` lists the commits of what is checked out, each
 * with its files, apart from the graph, and `sideGraph` is the graph without the references beside it. `commit` is
 * one commit in an editor tab, with its message, its files and what it changed in them.
 */
export type ViewKind = 'graph' | 'changes' | 'commits' | 'sideGraph' | 'branches' | 'stashes' | 'commit';

/** The views that show the graph, and so are sent its commits. */
export const showsGraph = (kind: ViewKind) => kind === 'graph' || kind === 'sideGraph';
/** The views that can show the files that differ between two commits. */
export const showsComparisons = (kind: ViewKind) => kind === 'graph' || kind === 'sideGraph' || kind === 'branches';

/** How the files of a commit are laid out in its editor tab: under their directories, or one after the other. */
export type FilesLayout = 'tree' | 'list';

/** One `@@` block of a diff. `header` is the `@@ -a,b +c,d @@` line, `lines` the context, `+` and `-` lines after it. */
export interface Hunk {
  header: string;
  lines: string[];
}

/** The diff of one file, cut up so that each hunk can be applied on its own: `prelude + header + lines` is a valid patch. */
export interface FileHunks {
  prelude: string;
  hunks: Hunk[];
  binary: boolean;
}

/** What a commit changed in one of its files. */
export interface FilePatch {
  file: FileChange;
  /** Lines added and removed: both 0 for a binary file, whose lines are not counted. */
  added: number;
  removed: number;
  binary: boolean;
  /** Null when the commit changes more lines than are sent to a view: the diff editor shows those. */
  hunks: Hunk[] | null;
}

export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop';

export interface RebaseStep {
  action: RebaseAction;
  hash: string;
  /** The new message of a reworded commit. */
  message?: string;
}

/** Which two versions of a file a diff compares. */
export type DiffSource =
  | { kind: 'commit'; hash: string; parent: string | null }
  /** HEAD against the working tree. */
  | { kind: 'worktree' }
  /** HEAD against the index. */
  | { kind: 'staged' }
  /** The index against the working tree. */
  | { kind: 'unstaged' }
  | { kind: 'conflict' };

/** Something the user asked for in the UI. The extension asks for any missing input, then turns it into git commands. */
export type Action =
  | { kind: 'checkout'; target: 'branch' | 'remote' | 'detached'; ref: string }
  | { kind: 'createBranch'; at: string }
  | { kind: 'renameBranch'; name: string }
  | { kind: 'deleteBranch'; name: string }
  | { kind: 'deleteRemoteBranch'; name: string }
  | { kind: 'merge'; ref: string }
  /** Rebases `branch`, or the current branch when it is left out. */
  | { kind: 'rebase'; onto: string; branch?: string }
  /** `steps` are oldest first; `base` is the commit they sit on, or null when they start at the root. */
  | { kind: 'rebaseInteractive'; base: string | null; steps: RebaseStep[] }
  | { kind: 'undo' }
  | { kind: 'worktreeAdd'; ref: string; isBranch: boolean }
  | { kind: 'worktreeRemove' | 'worktreeOpen'; path: string }
  | { kind: 'worktreePrune' }
  | { kind: 'stageHunk' | 'unstageHunk' | 'discardHunk'; path: string; patch: string }
  | { kind: 'cherryPick'; hash: string; isMerge: boolean }
  /** Several commits in one go, in any order: they are applied oldest first. */
  | { kind: 'cherryPickMany'; hashes: string[] }
  | { kind: 'revert'; hash: string; isMerge: boolean }
  | { kind: 'reset'; hash: string }
  | { kind: 'createTag'; at: string }
  | { kind: 'deleteTag'; name: string }
  | { kind: 'pushTag'; name: string }
  /** Everything, or only these files, or only what is staged. */
  | { kind: 'stashPush'; paths?: string[]; staged?: boolean }
  | { kind: 'stashApply' | 'stashPop' | 'stashDrop' | 'stashBranch'; ref: string }
  | { kind: 'stage' | 'unstage' | 'discard'; paths: string[] }
  /** Resolves the conflicts that need no choice between the two sides, in these files or in all of them. */
  | { kind: 'resolveConflicts'; paths?: string[] }
  /** Makes a file in conflict what one side has, whole: `ours` is what is checked out, `theirs` what is coming in. */
  | { kind: 'takeSide'; path: string; side: 'ours' | 'theirs' }
  | { kind: 'stageAll' | 'unstageAll' | 'discardAll' }
  | { kind: 'commit'; message: string; amend: boolean }
  /** Folds the staged changes, or all changes when nothing is staged, into an earlier commit. `isRoot`: that commit has no parent. */
  | { kind: 'fixup'; hash: string; isRoot: boolean }
  /** Marks a commit for `git bisect`, starting one if needed. Without `hash` it marks the commit being tested. */
  | { kind: 'bisect'; mark: 'good' | 'bad' | 'skip'; hash?: string }
  | { kind: 'bisectReset' }
  | { kind: 'continue' | 'skip' | 'abort' };

export type HostMessage =
  /**
   * With `sameRows` the commits are the ones sent before, and are not sent again: `state.rows` only has the row of the
   * uncommitted changes, if there is one, because the number of changes it tells may be another.
   */
  | { type: 'state'; state: RepoState | null; sameRows?: true }
  /** The commits of what is checked out, for the view that asked. */
  | { type: 'log'; log: BranchLog }
  | { type: 'detail'; hash: string; detail: CommitDetail | null }
  /** What a commit changed, file by file in the order of its details. Null when git and the list of files disagree. */
  | { type: 'patch'; hash: string; patch: FilePatch[] | null }
  | { type: 'comparison'; comparison: Comparison }
  | { type: 'busy'; title: string | null }
  | { type: 'committed' }
  | { type: 'hunks'; path: string; staged: boolean; hunks: FileHunks | null }
  /** Select a commit and scroll to it. */
  | { type: 'reveal'; hash: string }
  /**
   * The commits a search found in the history that is shown, newest first. `more` when there are others after the last,
   * `failed` when git refused the search.
   */
  | { type: 'found'; search: Search; hashes: string[]; more: boolean; failed?: boolean }
  /** Show the files that differ between two commits. */
  | { type: 'compare'; comparing: Comparing }
  /** A commit message is being drafted, or has been (`message`). */
  | { type: 'drafting'; active: boolean; message?: string };

/** Things the UI can ask for that need the extension to prompt, pick or open something. */
export type UiCommand =
  | 'reflog'
  | 'cleanupBranches'
  | 'activeFileHistory'
  | 'signInGitHub'
  | 'draftMessage'
  | 'switchIdentity'
  | 'selectRepository'
  | 'remotes'
  | 'goToCommit';

export type WebviewMessage =
  | { type: 'ready' }
  /** A view with a search box has the keyboard, or no longer: while it does, the key that searches is its own. */
  | { type: 'focus'; focused: boolean }
  | { type: 'refresh' }
  | { type: 'loadMore' }
  /** Asks for the commits of what is checked out, that many at most, and which of them are pushed. */
  | { type: 'getLog'; limit: number }
  | { type: 'getDetail'; hash: string }
  | { type: 'getPatch'; hash: string }
  /** Opens a commit in an editor tab of its own, or shows the tab it already has. */
  | { type: 'openCommit'; hash: string }
  /** Selects a commit in the graph, opening the graph for it. */
  | { type: 'reveal'; hash: string }
  /** The layout the tabs of the commits open with from now on. */
  | { type: 'setFilesLayout'; layout: FilesLayout }
  | { type: 'getComparison'; from: string; to: string }
  /** Asks the user what to compare, or what to compare `from` with, and shows the comparison in this view. */
  | { type: 'compare'; from?: ComparedRef }
  /** Selects a commit in the views that list commits and are open, without opening one. */
  | { type: 'show'; hash: string }
  | { type: 'selectRepo'; root: string }
  | { type: 'getHunks'; path: string; staged: boolean }
  | { type: 'openDiff'; source: DiffSource; file: FileChange }
  /** Opens the diffs of all these files in one editor. */
  | { type: 'openChanges'; source: DiffSource; files: FileChange[]; title: string }
  | { type: 'sync'; action: SyncAction }
  | { type: 'action'; action: Action }
  | { type: 'setFilter'; filter: Filter | null }
  | { type: 'setScope'; scope: Scope | null }
  | { type: 'setFavorite'; ref: string; favorite: boolean }
  /** Selects the commit a hash or another revision stands for, loading the history as far back as it is. */
  | { type: 'goTo'; revision: string }
  /** Asks for the commits a search finds, to highlight them in the graph rather than replace it with them. */
  | { type: 'find'; search: Search }
  | { type: 'command'; command: UiCommand }
  /** Opens the pull request of a branch, or the page to create one. */
  | { type: 'pullRequest'; branch: string }
  | { type: 'copy'; text: string };
