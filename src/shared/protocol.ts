import type { SyntaxTheme } from '../flow/diff/protocol';
import type { FileIconTheme } from './fileIcons';
import type { ConflictRef, ConflictReview } from './resolution';
import type { SetupPatterns, SetupPreview, SetupTarget, WorktreeSetupInfo } from './worktreeSetup';

/** Pseudo-hash of the row that stands for uncommitted changes. */
export const WORKTREE = 'WORKTREE';

export interface GraphLine {
  from: number;
  to: number;
  color: number;
  /** A line that is not history: from the uncommitted changes or a stash down to the commit they are made on. */
  dashed?: boolean;
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
  /** The name of the stash the row is, `stash@{0}`, when it is one rather than a commit of the history. */
  stash?: string;
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
  /** The one the repository was cloned or created in, which git cannot move or remove. */
  main: boolean;
  /** Its directory is gone, so `git worktree prune` would forget it. */
  prunable: boolean;
  /** How many of its files are not committed: staged, not staged or untracked. Null when they could not be read. */
  changes: number | null;
}

/** A submodule of the repository, or of one of its submodules. */
export interface Submodule {
  /** Its folder from the root of the repository shown, with forward slashes. */
  path: string;
  /** The folder of the submodule it is in, from the same root: empty for one of the repository itself. */
  parent: string;
  /** Its name in `.gitmodules`, which is usually its path. */
  name: string;
  url: string;
  /** The branch `.gitmodules` says it follows, which an update from its remote goes to. */
  branch: string | null;
  /** The commit the repository that has it records for it in HEAD. Null when it is added but not committed yet. */
  recorded: string | null;
  /** The commit staged for it, when that is not the one recorded. */
  staged: string | null;
  /** The commit checked out in it. Null when it is not initialized: its folder has no repository. */
  head: string | null;
  /** The branch checked out in it, or null on a detached HEAD. */
  headBranch: string | null;
  /**
   * The commits it has checked out that the recorded one has not, and the other way round. Null when that cannot be
   * told: the recorded commit is not in it, which a fetch in it would bring.
   */
  ahead: number | null;
  behind: number | null;
  /** How many of its files are not committed. Null when they could not be read. */
  changes: number | null;
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

/** The kinds of references whose histories the graph can show: local branches, remote branches and tags. */
export type RefKind = 'branch' | 'remote' | 'tag';

/**
 * Which histories the graph shows, when not those of every branch, remote branch and tag: of what is checked out, of
 * some kinds of references, or of the references chosen one by one, by their full names (`refs/heads/main`). It is
 * apart from the filter, which narrows what is left of it.
 */
/** `upstream` with what is checked out: its upstream too, to see what is ahead of it and what is behind. */
export type Scope = { kind: 'current'; upstream?: true } | { kind: 'kinds'; kinds: RefKind[] } | { kind: 'refs'; refs: string[] };

/** What the graph waits for: the commits of another filter, scope or repository, or the ones after the last that is loaded. */
export type Loading = 'filter' | 'more';

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
  /** Its submodules and theirs, each after the one it is in. */
  submodules: Submodule[];
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
  /** Whether this VS Code has the Agents window, where a worktree can be opened for agent sessions. */
  agentsWindow: boolean;
  /** Where new worktrees go, as the settings say: the ones in it are named by their path from there. */
  worktreesRoot: string | null;
  /** What a double click on a branch does, as the settings say: check it out here, or open its worktree. */
  openBranches: 'checkout' | 'worktree';
  /** Whether the graph shows the stashes, each above the commit it was made on, as the settings say. */
  showStashes: boolean;
  /** Whether the history of the commit selected in the graph stands out, as the settings say. */
  traceSelected: boolean;
  /** Whether the graph follows only the first parent of each merge, as the settings say. */
  firstParent: boolean;
  /**
   * Whether the branches listed beside the graph and in the Branches view are only the ones the graph is narrowed
   * to, as the settings say. When not, they are all listed, and the ones the graph leaves out are dimmed.
   */
  branchesFollowScope: boolean;
  /** Whether a language model can be asked how to resolve the conflicts, as the settings say. */
  resolveWithAI: boolean;
  /**
   * The repository of the workspace the views go back to, while they show a worktree of it that is not in the
   * workspace. Null when they show a repository of the workspace.
   */
  home: RepoInfo | null;
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

/** One side of a comparison: a commit, or the working tree (`WORKTREE`), and the branch, tag or short hash to call it by. */
export interface ComparedRef {
  name: string;
  hash: string;
}

/**
 * How the tab of a comparison compares: `diverged` shows what `to` changed since it left `from`, from the commit the two
 * have in common, as a pull request does (`git diff from...to`); `direct` everything that differs (`git diff from to`).
 */
export type CompareMode = 'diverged' | 'direct';

/** One side of a comparison in its tab. */
export interface CompareSide {
  name: string;
  hash: string;
  /** Named by a branch, a tag or a revision: its commit is looked up again when the repository changes. */
  live: boolean;
  /** The name no longer stands for a commit, a branch that was deleted: the side stays where it was. */
  gone?: boolean;
}

/** A commit that one side of a comparison has and the other has not. */
export interface CompareCommit {
  hash: string;
  subject: string;
  author: string;
  date: number;
  side: 'from' | 'to';
  /** The other side has the same change in a commit of its own: it was cherry-picked, or rebased. */
  equivalent: boolean;
}

/** What the tab of a comparison shows, but the lines of its files. */
export interface CompareView {
  from: CompareSide;
  to: CompareSide;
  mode: CompareMode;
  /** The commit the two have in common, null when their histories never met. */
  base: string | null;
  /** The commit the files are compared from: `base` when `diverged`, `from` when `direct` or when there is no base. */
  since: string;
  /** The commits `to` has that `from` has not, and the other way round. */
  ahead: number;
  behind: number;
  /** The commits each side has that the other has not, newest first: no more than a few thousand of them. */
  commits: CompareCommit[];
  /** Whether the commits were matched with those of the other side, which is not done when there are too many. */
  matched: boolean;
  /**
   * The files that would conflict if `to` were merged into `from`. Null when nothing would be merged with a merge
   * commit, when a side is the working tree, or when git cannot tell.
   */
  conflicts: string[] | null;
  /** The file or the folder the comparison is narrowed to, from the top of the repository. */
  path: string | null;
  files: FileChange[];
}

/**
 * What a view shows. `graph` is everything, in the panel or in an editor tab. `changes`, `commits`, `sideGraph`,
 * `branches` and `stashes` are the views of the side bar: `commits` lists the commits of what is checked out, each
 * with its files, apart from the graph, and `sideGraph` is the graph without the references beside it. `commit` is
 * one commit in an editor tab, with its message, its files and what it changed in them. `compare` is two branches,
 * tags or commits compared in an editor tab. `worktreeSetup` is the tab where what new worktrees get of what git
 * ignores is chosen. `conflicts` is the tab where what is proposed for the conflicts is looked at before it is written.
 */
export type ViewKind = 'graph' | 'changes' | 'commits' | 'sideGraph' | 'branches' | 'stashes' | 'commit' | 'compare' | 'worktreeSetup' | 'conflicts';

/** The views that show the graph, and so are sent its commits. */
export const showsGraph = (kind: ViewKind) => kind === 'graph' || kind === 'sideGraph';

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
  /** Set when `message` is only a new subject: the body the commit has stays under it. */
  keepBody?: boolean;
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
  /** A file of the Changes view, as VS Code's list of changes opens it: `unstaged` when it has unstaged changes, else `staged`. */
  | { kind: 'change' }
  | { kind: 'conflict' };

/** Something the user asked for in the UI. The extension asks for any missing input, then turns it into git commands. */
export type Action =
  /**
   * A remote branch is checked out in the local branch of its name. One there already with commits of its own has them
   * rebased onto the remote branch with `rebase`; without it, the user is asked.
   */
  | { kind: 'checkout'; target: 'branch' | 'remote' | 'detached'; ref: string; rebase?: boolean }
  | { kind: 'createBranch'; at: string }
  | { kind: 'renameBranch'; name: string }
  | { kind: 'deleteBranch'; name: string }
  /** Moves a branch that is not checked out up to its upstream, which is fetched first. */
  | { kind: 'fastForward'; name: string }
  | { kind: 'deleteRemoteBranch'; name: string }
  | { kind: 'merge'; ref: string }
  /** Rebases `branch`, or the current branch when it is left out. */
  | { kind: 'rebase'; onto: string; branch?: string }
  /** `steps` are oldest first; `base` is the commit they sit on, or null when they start at the root. */
  | { kind: 'rebaseInteractive'; base: string | null; steps: RebaseStep[] }
  /**
   * Gives a commit a new message: the last one by amending it, an older one by an interactive rebase that makes the
   * commits after it again.
   */
  | { kind: 'reword'; hash: string; message: string }
  | { kind: 'undo' }
  /** On an existing branch or at a commit, or, without `ref`, on a new branch from a base asked for. */
  | { kind: 'worktreeAdd'; ref?: string; isBranch?: boolean }
  /**
   * In a new window, or in the Agents window of VS Code, which starts agent sessions in it. Without `where`, where
   * `gitardo.worktrees.openIn` says.
   */
  | { kind: 'worktreeOpen'; path: string; where?: 'window' | 'agents' }
  /** Opens the worktree of a branch, made for it first in the folder of the worktrees when it has none. */
  | { kind: 'openInWorktree'; name: string; remote?: boolean }
  /** Asks whether to delete its branch too, unless `deleteBranch` says. */
  | { kind: 'worktreeRemove'; path: string; deleteBranch?: boolean }
  | { kind: 'worktreeRename' | 'worktreeTerminal' | 'worktreeReveal'; path: string }
  | { kind: 'worktreePrune' }
  /** Brings into the worktree in `path`, or into every other worktree, what new worktrees get of what git ignores here. */
  | { kind: 'worktreeSetUp'; path?: string }
  /** Asks for the URL, the folder and the branch of a new submodule. */
  | { kind: 'submoduleAdd' }
  /**
   * Checks out in a submodule, and in the ones inside it, the commit that is recorded for it, cloning it first when it
   * is not initialized. With `remote`, the last commit of the branch it follows instead.
   */
  | { kind: 'submoduleUpdate'; path: string; remote?: boolean }
  /** Stages the commit checked out in a submodule as the one recorded for it. */
  | { kind: 'submoduleRecord'; path: string }
  /** Removes the folder of a submodule and forgets it locally, keeping it in `.gitmodules` and in the commits. */
  | { kind: 'submoduleDeinit'; path: string }
  /** Removes a submodule from the repository: its folder, its entry in `.gitmodules` and its clone in the git directory. */
  | { kind: 'submoduleRemove'; path: string }
  /** Copies the URLs of `.gitmodules` to the configuration of the submodules, after they changed there. */
  | { kind: 'submoduleSync' }
  /** Opens the folder of a submodule in a new window. */
  | { kind: 'submoduleOpen'; path: string }
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
  /**
   * Takes files back to the last commit, staged or not, and deletes the untracked ones: all of them without `paths`.
   * `discard` and `discardAll` leave what is staged alone.
   */
  | { kind: 'discardChanges'; paths?: string[] }
  | { kind: 'commit'; message: string; amend: boolean }
  /** Folds the staged changes, or all changes when nothing is staged, into an earlier commit. `isRoot`: that commit has no parent. */
  | { kind: 'fixup'; hash: string; isRoot: boolean }
  /** Marks a commit for `git bisect`, starting one if needed. Without `hash` it marks the commit being tested. */
  | { kind: 'bisect'; mark: 'good' | 'bad' | 'skip'; hash?: string }
  | { kind: 'bisectReset' }
  | { kind: 'continue' | 'skip' | 'abort' };

export type HostMessage =
  /**
   * With `kept` the first `kept` rows are the ones sent before, and are not sent again: `state.rows` only has the rows
   * after them, which are none when the commits are the same, and before those the row of the uncommitted changes, if
   * there is one, because the number of changes it tells may be another.
   */
  | { type: 'state'; state: RepoState | null; kept?: number }
  /** The commits of what is checked out, for the view that asked. */
  | { type: 'log'; log: BranchLog }
  | { type: 'detail'; hash: string; detail: CommitDetail | null }
  /** What a commit changed, file by file in the order of its details. Null when git and the list of files disagree. */
  | { type: 'patch'; hash: string; patch: FilePatch[] | null }
  | { type: 'comparison'; comparison: Comparison }
  /** What the tab of a comparison shows. Null, with `error`, when git could not compare the two. */
  | { type: 'compareView'; view: CompareView | null; error?: string }
  /**
   * The lines of the files of the comparison from `since` to `to`, in the order of its files. Null when git and the
   * list of files disagree.
   */
  | { type: 'comparePatch'; since: string; to: string; patch: FilePatch[] | null }
  /**
   * The colors the theme of VS Code gives the code, once the page asked for them, and again whenever the theme changes.
   * Null when the theme cannot be read: the page then takes those of Dark+ or Light+.
   */
  | { type: 'syntaxTheme'; theme: SyntaxTheme | null }
  /**
   * The icons of the file icon theme of VS Code, once the page asked for them, and again whenever they change. Null when
   * the user chose none, or when it cannot be read: the files are then shown with no icons, as in VS Code.
   */
  | { type: 'fileIcons'; theme: FileIconTheme | null }
  | { type: 'busy'; title: string | null }
  /**
   * The graph is being read again: for a filter, a scope or a repository just chosen (`filter`), or for the commits
   * after the last (`more`). Null once the state it was read for has been sent.
   */
  | { type: 'loading'; what: Loading | null }
  | { type: 'committed' }
  /** The files of the repository shown that have edits not saved in an editor, by their paths from its root. */
  | { type: 'unsaved'; paths: string[] }
  /** Select a commit and scroll to it. */
  | { type: 'reveal'; hash: string }
  /** Bring out the history of a commit in the graph while the pointer rests on its branch in another view; null when it leaves. */
  | { type: 'trace'; hash: string | null }
  /**
   * The commits a search found in the history that is shown, newest first. `more` when there are others after the last,
   * `failed` when git refused the search.
   */
  | { type: 'found'; search: Search; hashes: string[]; more: boolean; failed?: boolean }
  /** A commit message is being drafted, or has been (`message`). */
  | { type: 'drafting'; active: boolean; message?: string }
  /** What the tab of the setup of new worktrees shows. Null, with `error`, when it could not be read. */
  | { type: 'worktreeSetup'; info: WorktreeSetupInfo | null; error?: string }
  /** What the patterns take from the checkout. Null when git could not say. */
  | { type: 'worktreeSetupPreview'; patterns: SetupPatterns; preview: SetupPreview | null; error?: string }
  /** What the tab of the review of the conflicts shows. Null, with `error`, when the files could not be read. */
  | { type: 'review'; review: ConflictReview | null; error?: string };

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
  | 'goToCommit'
  | 'switchWorktree'
  | 'worktreeSetup';

export type WebviewMessage =
  | { type: 'ready' }
  /** The page colors code: it is sent the colors of the theme, now and whenever they change. */
  | { type: 'syntaxTheme' }
  /** The page shows files: it is sent the icons of the file icon theme, now and whenever they change. */
  | { type: 'fileIcons' }
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
  /** Asks the user what to compare, or what to compare `from` with, and opens the comparison in a tab. */
  | { type: 'compare'; from?: ComparedRef }
  /** Opens the comparison of these two in a tab, or shows the tab it has. */
  | { type: 'openCompare'; from: ComparedRef; to: ComparedRef }
  /** In the tab of a comparison: asks for the user to choose one of its sides again. */
  | { type: 'pickCompareSide'; side: 'from' | 'to' }
  | { type: 'swapCompare' }
  | { type: 'setCompareMode'; mode: CompareMode }
  /** Narrows the comparison of the tab to a file or a folder, or no longer when null. */
  | { type: 'setComparePath'; path: string | null }
  /** Writes the version of a file that the second side of the comparison has in the working tree and the index. */
  | { type: 'takeCompareFile'; file: FileChange }
  /** Copies the changes of the comparison as a patch. */
  | { type: 'copyComparePatch' }
  /** Opens the comparison on GitHub. */
  | { type: 'openCompareOnGitHub' }
  /** Selects a commit in the views that list commits and are open, without opening one. */
  | { type: 'show'; hash: string }
  /** The pointer came to a branch, with its commit, whose history the views of the graph bring out; or left it, with null. */
  | { type: 'trace'; hash: string | null }
  | { type: 'selectRepo'; root: string }
  | { type: 'openDiff'; source: DiffSource; file: FileChange }
  /** Opens the file as it is in the working tree; one that is deleted opens its diff instead. */
  | { type: 'openFile'; file: FileChange }
  /** A click on a file of the Changes view: it opens the file or its diff against HEAD, as `gitardo.changes.openOnClick` says. */
  | { type: 'openChange'; file: FileChange }
  /** Opens the diffs of all these files in one editor. */
  | { type: 'openChanges'; source: DiffSource; files: FileChange[]; title: string }
  /** Saves the edits of these files, by their paths from the root of the repository, that are not saved in an editor. */
  | { type: 'save'; paths: string[] }
  /** Opens what an editor has of the file, not saved yet, against the file on disk. */
  | { type: 'compareWithSaved'; path: string }
  | { type: 'sync'; action: SyncAction }
  | { type: 'action'; action: Action }
  | { type: 'setFilter'; filter: Filter | null }
  | { type: 'setScope'; scope: Scope | null }
  /** Lists only the branches the graph is narrowed to beside it and in the Branches view, or all of them. */
  | { type: 'setBranchesFollowScope'; follow: boolean }
  /** Shows the stashes in the graph, or no longer. */
  | { type: 'setShowStashes'; show: boolean }
  | { type: 'setTraceSelected'; trace: boolean }
  | { type: 'setFirstParent'; only: boolean }
  | { type: 'setFavorite'; ref: string; favorite: boolean }
  /** Selects the commit a hash or another revision stands for, loading the history as far back as it is. */
  | { type: 'goTo'; revision: string }
  /** Asks for the commits a search finds, to highlight them in the graph rather than replace it with them. */
  | { type: 'find'; search: Search }
  | { type: 'command'; command: UiCommand }
  /** Opens the pull request of a branch, or the page to create one. */
  | { type: 'pullRequest'; branch: string }
  /** Asks for what the tab of the setup of new worktrees shows, looking again at what git ignores when `rescan`. */
  | { type: 'getWorktreeSetup'; rescan?: boolean }
  | { type: 'previewWorktreeSetup'; patterns: SetupPatterns }
  /** Saves the patterns there, and in VS Code's settings too when `alsoVSCode`; null takes Gitardo's out of there. */
  | { type: 'saveWorktreeSetup'; target: SetupTarget; patterns: SetupPatterns | null; alsoVSCode?: boolean }
  /** Opens the file of the settings there. */
  | { type: 'editWorktreeSetup'; target: SetupTarget }
  /**
   * Opens the tab of the review of the conflicts, of these files or of all of them, or shows the one open. With `ai`
   * the language model is asked about the conflicts the rules leave.
   */
  | { type: 'reviewConflicts'; paths?: string[]; ai?: boolean }
  | { type: 'getReview' }
  /** Writes the proposals accepted in the review. */
  | { type: 'writeResolutions'; accepted: ConflictRef[] }
  /** Shows each file in conflict beside what the proposals accepted would make of it, in a multi-file diff editor. */
  | { type: 'previewResolutions'; accepted: ConflictRef[] }
  /** Asks the language model about these conflicts, or about all the ones with nothing proposed. */
  | { type: 'askAI'; conflicts?: ConflictRef[] }
  | { type: 'stopAsking' }
  /** Asks which language model resolves conflicts, and how much it thinks. */
  | { type: 'chooseConflictModel' }
  /** Opens a file in conflict in the Flow Merge, or in the merge editor, at the line of a conflict. */
  | { type: 'openConflict'; path: string; line: number; editor: 'flowMerge' | 'mergeEditor' | 'text' }
  | { type: 'copy'; text: string };
