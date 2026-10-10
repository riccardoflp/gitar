# Gitar

Commit graph, history and everyday Git operations in a single VS Code panel.

Gitar has two views:

- **Graph**, in the bottom panel next to the terminal: the commit graph, the references and the commit details.
- **Changes**, in the side bar behind the Gitar icon: staging and committing.

Like any VS Code view they can be dragged somewhere else, and **Gitar: Open Graph in Editor** opens the graph as an editor tab.

## Installation

Gitar is not on the Marketplace. Build the package and install it from the file:

```bash
npm install
npm run package
code --install-extension gitar-0.0.1.vsix
```

Reload the VS Code window afterwards. To update, run the last two commands again; to remove it, `code --uninstall-extension pozzi.gitar`. Gitar needs VS Code 1.100 or later and `git` on your `PATH`.

## Features

### Graph

- Commit graph of all branches, remote branches and tags, loaded progressively.
- Uncommitted changes shown as the first row of the graph, also before the first commit of a new repository.
- References tree: local branches with ahead and behind counts, remote branches, tags, stashes and worktrees. From 15 branches and tags on, a filter box appears above it, and a section with more than 100 entries lists the first 100 and a **Show all** entry.
- Commit details with the list of changed files; selecting a file opens it in the VS Code diff editor, and the button next to the count opens the diffs of all of them in one editor.
- Selecting a stash shows what it holds, including the untracked files it took, which git keeps apart from the rest.
- Fetch, pull (merge or `--rebase`), push, push with `--force-with-lease` and push with `--force`.
- Search across the loaded commits or the whole history: see [Search](#search).
- Refreshes on its own when the repository or its files change, including changes made from the terminal or by another program.
- Select several commits with `Ctrl`+click (`Cmd` on macOS) or `Shift`+click to act on them together: see [Several commits at once](#several-commits-at-once).
- The **…** button in the toolbar opens the history of the active file, the reflog, the branch cleanup, the remotes, the identity switch and the pull requests.
- In a workspace with several repositories, a list in the toolbar chooses the one to show: see [Multiple repositories](#multiple-repositories).

Right-click a commit, a branch, a tag or a stash for the operations that apply to it:

| On | Operations |
| --- | --- |
| Commit | Check out (detached), create branch, create tag, create worktree, cherry-pick, revert, merge into the current branch, rebase the current branch onto it, interactive rebase, fixup, reset (soft, mixed or hard), compare, bisect |
| Local branch | Check out (also by double-click), merge, rebase onto, compare with the current branch, show only its history, open or create its pull request, create worktree, rename, delete |
| Remote branch | Check out as a local tracking branch, merge, rebase onto, compare, show only its history, open its pull request, delete from the remote |
| Tag | Check out (detached), create branch, compare, show only its history, push, delete |
| Stash | Apply, pop, create branch, drop |
| Worktree | Open in a new window (also by double-click), remove, prune missing ones |

### Several commits at once

`Ctrl`+click (`Cmd` on macOS) adds a commit to the selection or removes it; `Shift`+click selects every commit between the selected one and the clicked one. A bar above the graph counts them, and offers what the context menu of the selection also does:

- **Cherry-pick onto `<current branch>`** runs a single `git cherry-pick` with all of them, oldest first whatever the order you clicked them in. Git treats them as one operation: if one conflicts it stops there, and **Continue**, **Skip** and **Abort** in the banner apply to the whole series. It is not offered when the selection contains a merge commit, which can only be picked on its own.
- **Compare these two commits**, when two are selected.
- **Copy hashes**.

**Undo** right after such a cherry-pick takes back all of its commits at once, also when it had stopped on a conflict and you continued it in Gitar. If you continued it from the terminal, or did something else in between, Undo goes back one commit at a time like after any other commit.

### Drag and drop

Drag a commit, or a branch from the graph or the references tree, onto a row of the graph. Rows that accept the drop are outlined, and dropping opens a menu with what can be done:

| Drag | Onto | Offers |
| --- | --- | --- |
| A commit | The checked-out commit | Cherry-pick it onto the current branch |
| A branch | The checked-out commit | Merge it into the current branch, or rebase the current branch onto it |
| The current branch | Any other commit | Rebase it onto that commit, or reset it there |
| Another local branch | Any other commit | Rebase it onto that commit |

### Interactive rebase

**Interactive rebase…** on a commit opens an editor with the commits from there up to `HEAD`. Reorder them by dragging, and pick, reword, squash, fixup or drop each one. It is offered when those commits form a single line without merges.

### Fixup

**Add staged changes to this commit (fixup)** on an earlier commit folds your staged changes into it, or all your changes when nothing is staged. It runs `git commit --fixup` followed by `git rebase -i --autosquash --autostash`, so the commit and the ones after it are rewritten. It is offered for the commits an interactive rebase can reach, except `HEAD`, which **Amend** already covers. If the changes do not fit the older commit, the rebase stops with conflicts like any other.

### Compare

**Compare with `<current branch>`** on a commit, branch or tag lists the files that differ between the two, in place of the commit details; selecting a file opens the diff. To compare two arbitrary commits, select one, then right-click the other and choose **Compare with … selected before**. **Swap** reverses the direction.

**Show only this history** on a branch or tag narrows the graph to what that reference can reach.

### Bisect

To find the commit that broke something, right-click a commit you know is broken and choose **Start bisect: this commit is bad**, then mark one that works as good. Git checks out a commit in between; test it and answer with **Good**, **Bad** or **Skip** in the banner. The marks are shown in the graph, and the banner counts how many commits can still be the culprit. When one is left, Gitar tells you which. **End** (`git bisect reset`) goes back to where you started.

### Undo

**Undo** in the toolbar takes back the last commit, amend, checkout, merge, pull, rebase or reset, including ones made from the terminal, by reading the reflog. It always shows what it is about to do first. Undoing twice redoes. It also restores a branch deleted or a stash dropped in Gitar, as long as nothing else happened since.

### Previews before risky operations

- **Merge and cherry-pick**: Gitar computes the result first, without touching your files, and tells you which files will conflict before it starts.
- **Force push**: the confirmation lists the commits on the remote branch that are not in yours and would be overwritten, as of the last fetch.

### Search

The box in the toolbar searches in one of five ways, chosen from the list next to it:

| Mode | Finds | Runs |
| --- | --- | --- |
| Loaded | Message, author or hash among the commits already loaded, highlighted as you type. `Enter` jumps to the next match. | Nothing |
| Message | Commits whose message contains the text, ignoring case | `git log --grep` |
| Author | Commits whose author name or email contains the text, ignoring case | `git log --author` |
| Changes | Commits that add or remove the text | `git log -S` |
| Changes (regex) | Commits with a changed line that matches a POSIX extended regular expression (`[0-9]`, not `\d`) | `git log -G` |

All modes but the first search every branch, remote branch and tag when you press `Enter`, and replace the graph with the list of results until you choose **Show all commits**. The two that look inside the changes read every commit and can take a while on a large repository.

### File history

**Gitar: Show File History**, also in the context menu of the editor, of its tab and of the Explorer, narrows the graph to the commits that changed a file. The graph stays connected, so you still see on which branches the file changed. The same is offered by the clock button next to each file in the commit details.

Renames are followed: Gitar first asks git for the names the file had before (`git log --follow`), then shows the commits that changed any of them, and the bar above the graph lists the earlier names. A file that began as a copy of another is not traced back into the original. If an earlier name was later reused for a different file, the commits of that one appear too.

### Inline blame

The line under the cursor shows who last changed it, when, and the subject of that commit, dimmed at the end of the line. It takes unsaved edits into account. Hover it for a link that shows the commit in the graph. Turn it off with `gitar.blame.enabled` or **Gitar: Toggle Inline Blame**.

### Reflog

**Gitar: Browse Reflog** lists the last 200 positions of `HEAD`. Pick one to show it in the graph, create a branch there, reset the current branch to it, check it out or cherry-pick it. This is how to get back commits that no branch reaches any more, for example after a reset or a rebase.

### Branch cleanup

**Gitar: Clean Up Branches** lists the local branches that are merged into the current one, or whose upstream branch was deleted from the remote. Merged branches are ticked and deleted with `git branch -d`, which refuses to lose commits. Branches that are not merged are left unticked; if you tick them they are deleted with `git branch -D`, after a warning. The current branch and branches checked out in a worktree are never listed.

### Remotes

**Gitar: Manage Remotes** lists the remotes with their URLs. Pick one to fetch it alone (`git fetch --prune <name>`), change its URL, rename it, copy its URL or remove it; or add a new one. Removing a remote always asks first: its remote-tracking branches go with it, and local branches that followed them lose their upstream, though nothing changes on the remote itself.

Fetch, pull and push in a repository without any remote offer to add one instead of failing.

### GitHub

When the main remote is on github.com, Gitar shows the open pull request of each branch next to it in the references tree, colored by the result of its checks. The context menu of a branch opens its pull request, or GitHub's page to create one. After the first push of a branch Gitar offers to create its pull request.

Pull requests are read with the GitHub account you signed in to in VS Code. Gitar asks for it the first time you choose **Load pull requests from GitHub** (**Gitar: Sign In to GitHub**), and never before. The token is only sent to `api.github.com`. Pull requests opened from forks are not shown.

### Changes

- Stage, unstage and discard single files or everything at once.
- Unfold a file to see its hunks, and stage, unstage or discard them one by one.
- Click changed lines of a hunk to select them: the buttons of the hunk then act on those lines only. This works for modified files, not for added or deleted ones.
- Commit, or amend the last commit. Committing with nothing staged offers to stage everything first.
- The sparkle button drafts the commit message with a language model available in VS Code, such as GitHub Copilot. It sends the model the staged changes, or all changes when nothing is staged, cut to 20,000 characters, and the subjects of the last commits as an example of style. Nothing is sent until you press it, and the draft is yours to edit.
- Selecting a file opens the matching diff: staged against `HEAD`, or the working tree against the index. The first button on the header of each list opens all of its diffs in one editor.
- Stash all changes, untracked files included; a single file, with the stash button on its row; or only what is staged, with the one on the **Staged changes** header (`git stash push --staged`, Git 2.35 or later).
- Below the commit box is the name and email the commit will be made with. Click it to switch identity.
- A list of more than 300 files shows the first 300 and a **Show all** link, here and in the details of a commit or of a comparison. The counts and the buttons on the header still speak for the whole list.

### Identities

**Gitar: Switch Identity** sets the name and email used for commits in the current repository, with `git config user.name` and `git config user.email`. Choose among the profiles listed in the `gitar.identities` setting, type a new one, or go back to your global identity:

```json
"gitar.identities": [
  { "name": "Ada Lovelace", "email": "ada@work.example", "signingKey": "ABCD1234" },
  { "name": "Ada", "email": "ada@home.example" }
]
```

`signingKey` is optional. Switching to a profile without one removes the key the repository had, so that commits are not signed as someone else.

### Multiple repositories

Gitar shows one repository at a time. It finds the repository of each workspace folder, the repositories directly inside a folder, and their submodules. When there is more than one, a list at the start of the toolbar and at the top of the Changes view switches between them, as does **Gitar: Select Repository**. The choice is remembered per workspace. **Show File History** switches to the repository of the file on its own.

### Conflicts

When a merge, rebase, cherry-pick or revert stops, both views show a banner with **Continue**, **Skip** and **Abort**. Conflicting files are listed in the Changes view, and **Mark as resolved** stages one.

Selecting a conflicting file opens it in VS Code's merge editor, with the common ancestor as the base and the two sides labelled by what they are in the operation that stopped: in a rebase, **Current** is what you are rebasing onto and **Incoming** is your own commit. Save the result there, then mark the file as resolved. A file that was added or deleted on one side has no three versions to merge, and opens as a normal file instead. The merge editor is opened through the command VS Code's own Git extension uses, which is not part of the documented API: if a future version changes it, the file opens in the normal editor with its conflict markers.

## Command preview

Gitar runs the `git` executable found on your `PATH`, and every command that changes the repository or a remote is written to the **Gitar** output channel (**Gitar: Show Command Log**).

Set `gitar.commandPreview` to `all` to see the exact commands before they run and approve them:

| Value | Behavior |
| --- | --- |
| `off` (default) | Only asks before commands that can lose work or rewrite history: force push, hard reset, discarding changes, dropping a stash, force-deleting a branch, deleting a remote branch, removing a remote, removing a worktree, aborting an operation, undo, interactive rebase, fixup, branch cleanup, and a merge or cherry-pick that is going to conflict. |
| `all` | Shows the commands and asks before running anything that changes the repository or a remote, staging included. |

The commands shown are the commands that run: Gitar adds no hidden flags to them. Where a command would open an editor for a commit message, which cannot work from an extension, the flag that prevents it is part of the command you see (`--no-edit`, or `-c core.editor=true` when continuing an operation).

For the same reason, two things that look odd in a command are there on purpose:

- A file whose name is also a pattern to git (it contains `[`, `]`, `*`, `?` or `\`, or starts with `:`) is passed as `:(literal)<name>`. Without it, staging or discarding `pages/[id].tsx` would also act on `pages/i.tsx` and `pages/d.tsx`.
- A branch that shares its name with a tag or with a remote branch is named in full, as `refs/heads/<name>`, where the short name would mean the other one or be refused: merging it, starting a branch from it, pushing it.

Two operations pass data that does not fit on a command line, and the confirmation shows it next to the command:

- Staging a hunk, or some lines of it, runs `git apply --cached -` with a patch on standard input.
- An interactive rebase runs `git rebase -i` with `sequence.editor` set to copy a prepared todo list from a temporary file. A reworded commit is a `pick` followed by `exec git commit --amend -F <file>`. A fixup uses the todo list git prepares itself, with `sequence.editor=true` to accept it unchanged.

Gitar needs Git 2.40 or later for the conflict previews; without it the previews are skipped and everything else works. Read-only queries (`git log`, `git status` and similar) never ask; they are logged at the debug level.

## Development

```bash
npm install
npm run build
```

Press `F5` in VS Code to launch an Extension Development Host with Gitar loaded.

| Script | Purpose |
| --- | --- |
| `npm run build` | Bundles the extension, the webview and the preview server into `dist/`. |
| `npm run watch` | Rebuilds on change. |
| `npm run typecheck` | Type-checks with `tsc`. |
| `npm test` | Runs the tests with Vitest. The integration tests run the real commands against throwaway repositories. |
| `npm run test:e2e` | Builds, then runs the end-to-end tests inside a real VS Code: see below. |
| `npm run test:ui` | Builds, then uses the extension in a real VS Code window, with real clicks and keys, saving screenshots: see below. |
| `npm run package` | Makes a minified build and packs it into `gitar-<version>.vsix`. It leaves the minified build in `dist/`; `npm run build` brings the development one back. |
| `npm run test:vsix` | Packages, then runs the end-to-end tests on what the `.vsix` contains instead of on this folder. |
| `npm run preview -- <folder>...` | Serves the webview at `http://localhost:5174` against the repositories found in the folders, read-only, to work on the UI without an Extension Host. Add `?view=changes` for the Changes view and `?theme=light` for the light theme, and `--port=<number>` before the folders to serve a second one beside it. |

### End-to-end tests

`npm run test:e2e` starts the VS Code installed on the machine as a separate instance, with a throwaway profile and a throwaway workspace holding two small repositories and a bare remote, and runs `test/e2e/suite.ts` inside its Extension Host. Your own VS Code window, settings and extensions are not touched; a second window opens for about half a minute and closes by itself. Pass the path of the executable as an argument, or set `VSCODE_PATH`, if it is not in a standard place.

The suite drives the extension through its commands and its controller, with VS Code's dialogs, input boxes and pickers answered by stubs that record what they were asked. It checks, among other things, that the webviews load, that the views follow changes made outside the editor, that the commands shown in a confirmation are the ones that run and the ones logged, and that diffs and the merge editor open with the right content.

`npm run test:vsix` runs the same suite on the packaged extension: the `.vsix` is unpacked into the throwaway folder and loaded from there, which catches a file left out of the package or broken by minification. The package has no license file and no repository URL, so it is built with the flags that allow that; add both before publishing it anywhere.

What that suite cannot see is what only eyes and hands can: how the views look, the inline blame annotation, drag and drop, the context menus of the webviews, and the real dialogs, which VS Code refuses to show while it runs tests. That is what the next one is for.

### Using it like a person

`npm run test:ui` starts the same throwaway VS Code, this time not in test mode, and drives its window through the DevTools protocol (`test/e2e/ui.mjs`): real clicks and right-clicks at the coordinates of what is on screen, real keystrokes, the real command palette, input boxes, pickers and confirmation dialogs. It checks that:

- the graph shows in the panel with its icons and the colors of the theme, and follows a change to a light theme;
- the toolbar still names the branch and fits when the panel is 1050 and 800 pixels wide;
- the Changes view lists what changed and its icon in the activity bar counts it;
- a file is staged with a click and committed with a typed message;
- the context menu of a commit stays inside the view with every entry in sight, and creates a branch through the real prompts;
- with the command preview on, the dialog shows the exact command, and Cancel runs nothing;
- the line under the cursor is annotated with who changed it;
- a branch dragged onto the checked out commit offers to merge or rebase;
- the graph opens as an editor tab, with the details of a commit beside it.

A screenshot of each step is saved to `dist/ui`, or to the folder given with `--out=<folder>`: looking at them is half the point. Errors thrown or logged inside the webviews are printed at the end. The window is sized through the protocol, so the screenshots do not depend on the screen.

Signing in to GitHub and drafting a commit message need an account and a language model, and are not exercised by any of these.

### Large repositories

Three scripts in `test/perf` show how Gitar behaves when there is a lot of everything. None of them is a test: they print numbers to read.

```bash
node test/perf/big-repo.mjs ../big 50000 2000
git -C ../big pack-refs --all
git -C ../big commit-graph write --reachable
node dist/perf.js ../big
node test/perf/vscode.mjs ../big
```

- `big-repo.mjs <folder> [commits on main] [changed files]` makes a repository with `git fast-import`: a long main line with side branches merged back into it, 250 branches never merged, 2,000 tags, remote branches, and a working tree with that many changed and untracked files. The two git commands after it leave the references and the history the way `git gc` or `git maintenance` leave them in a repository that is looked after; without them git itself takes about three times as long to list the commits.
- `dist/perf.js <repository>` times what Gitar reads: the state at 1,000, 5,000 and 20,000 commits, the details of a commit, the working tree, each kind of search, the history of a file, blame.
- `vscode.mjs <repository> [--out=<folder>]` opens the repository in the throwaway VS Code of `npm run test:ui` and times what a person waits for: opening the graph, a refresh, a new file showing up, the next pages of commits, selecting a commit, typing a commit message. It saves screenshots to `dist/perf`, and adds and removes one file in the repository.

On one made this way (56,000 commits, 2,375 references, 1,779 changed files), on the machine it was written on, the graph opens in about a second and a half from the command palette, a refresh takes a quarter of a second, each further page of 1,000 commits about 300 ms, and typing in the commit box is not slowed by the list under it. What keeps it so:

- the list of commits only draws the rows in sight, and the lists of references and of files are cut as described above;
- the commits are sent to the graph once: a refresh that finds the same ones, such as after a file is saved, sends everything else and leaves the rows where they are;
- the Changes view is never sent the commits at all.

Measure the views with the minified build (`node esbuild.mjs --production`): the development build of React makes every render several times slower, in proportion to the rows.

`test/awkward.test.ts` is the other half: file names with spaces, accents, brackets and leading dashes, a repository with no commits, a detached `HEAD`, a shallow clone, several root commits, a merge of three parents, a branch and a tag of the same name, a submodule.

### Layout

| Path | Contents |
| --- | --- |
| `src/git` | Running Git, finding the repositories of a workspace, parsing Git's output, building the commands for each operation, and reading GitHub's answers. No VS Code dependency. |
| `src/shared` | Types shared by the extension and the webview, the graph lane layout, how to name a reference that has namesakes, and the commit message prompt. |
| `src/extension` | VS Code integration: views, commands, prompts, file watching, command preview, diff content, inline blame, GitHub sign-in, language model. |
| `src/webview` | The React UI. |
| `src/dev` | The browser preview server. |
| `test` | Unit and integration tests, and `test/e2e` with the end-to-end suite, the run that uses the window, and the scripts that launch VS Code for them; `test/perf` with the scripts for large repositories. |
