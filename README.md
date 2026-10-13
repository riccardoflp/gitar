# Gitar

Commit graph, history and everyday Git operations in a single VS Code panel.

Gitar has a view in the bottom panel and four in the Source Control side bar of VS Code:

- **Graph**, in the panel next to the terminal: the commit graph, the references and the commit details, side by side.
- **Commits**, **Branches** and **Stashes**, in the side bar under the views of VS Code: the same history, references and stashes, for when the panel is closed.
- **Gitar Changes**, hidden until you ask for it: staging and committing, where VS Code has its own.

See [Side bar](#side-bar). Like any VS Code view they can be dragged somewhere else, folded or hidden, and **Gitar: Open Graph in Editor** opens the graph as an editor tab. So does the **Gitar** button in the status bar, which is there whenever the workspace has a repository; like any item of the status bar it can be hidden from the menu a right click on the bar opens.

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
- The labels of a commit are outlined in the color of its line in the graph; the branch that is checked out is the one filled in.
- Drag the line between the references and the commits, or between the commits and the details, to change their widths; double-click it to go back to the default. In a panel too narrow to have them side by side the details go under the commits, and the line between the two is dragged up and down the same way, as it is in the Commits view of the side bar. The sizes are remembered per workspace.
- The first button of the toolbar puts the references away, to leave their room to the commits, and brings them back. It is remembered too.
- The graph is as wide as its lines need, up to sixteen side by side and a third of the list. With more branches than that open at once it draws the lines closer, and past a point it fades out at its edge rather than push the messages away. Drag that edge to give it less room or more, up to the width at which every line has its place; double-click it to let the graph choose again. This works in the Commits view of the side bar too, and each view remembers its own.
- Uncommitted changes shown as the first row of the graph, also before the first commit of a new repository.
- References tree: local branches with ahead and behind counts, remote branches, tags, stashes and worktrees. From 15 branches and tags on, a filter box appears above it, and a section with more than 100 entries lists the first 100 and a **Show all** entry.
- Above them, when there are some, two shorter lists. **Recent** has the local branches that were checked out last, the latest first and up to five, without the one that is checked out now: where you were before is one double click away. **Favorites** has the branches you marked with **Add to favorites** in their context menu, local or remote; they also carry a star where they are listed with the others, and are remembered for each repository of the workspace.
- While the graph is narrowed to some branches (see [Filter by branch](#filter-by-branch)) the references list only those, in every section, under a line that says what they are narrowed to and has **Show all** to undo it.
- Commit details with the list of changed files; selecting a file opens it in the VS Code diff editor, and the button next to the count opens the diffs of all of them in one editor. The two buttons before it choose how the files are listed: one after the other, each with its directory beside its name, or as a tree of directories that fold. The choice is remembered.
- A message of more than five lines scrolls in the room of five, so that the files stay in sight under it. The tab of the commit has it whole.
- Double-click a commit to read it whole in an editor tab, with what it changed under its message: see [A commit in an editor tab](#a-commit-in-an-editor-tab).
- Selecting a stash shows what it holds, including the untracked files it took, which git keeps apart from the rest.
- Fetch, pull (merge or `--rebase`), push, push with `--force-with-lease` and push with `--force`.
- Pull with changes that are not committed: **Pull (autostash)** and **Pull (rebase, autostash)**, in the menu beside **Pull**, run `git pull --autostash` and `git pull --rebase --autostash`. Git sets the changes aside in a stash, pulls, and puts them back. When they no longer fit on what came in, it leaves them in conflict in the files and keeps the stash, named `autostash`: Gitar says so and offers the stashes, where it is dropped once the conflicts are resolved. When the pull itself stops on a conflict, git puts the changes back by itself once the merge or the rebase is finished or given up. Untracked files are not touched.
- Search across the loaded commits or the whole history: see [Search](#search).
- The graph can be narrowed to the branches you choose: see [Filter by branch](#filter-by-branch).
- Refreshes on its own when the repository or its files change, including changes made from the terminal or by another program.
- Select several commits with `Ctrl`+click (`Cmd` on macOS) or `Shift`+click to act on them together: see [Several commits at once](#several-commits-at-once).
- The **…** button in the toolbar opens the comparison of two branches, tags or commits, the history of the active file, the reflog, the branch cleanup, the remotes, the identity switch and the pull requests. When the panel is narrow the buttons of the toolbar keep their icons and give up their words, and **Refresh** is left to this menu.
- In a workspace with several repositories, a list in the toolbar chooses the one to show: see [Multiple repositories](#multiple-repositories).

Right-click a commit, a branch, a tag or a stash for the operations that apply to it:

| On | Operations |
| --- | --- |
| Commit | Open in an editor tab, check out (detached), create branch, create tag, create worktree, cherry-pick, revert, merge into the current branch, rebase the current branch onto it, interactive rebase, fixup, reset (soft, mixed or hard), compare, bisect |
| Local branch | Check out (also by double-click), merge, rebase onto, compare with the current branch or with anything else, show only its history or add it to the ones shown, open or create its pull request, create worktree, rename, delete |
| Remote branch | Check out as a local tracking branch, merge, rebase onto, compare, show only its history or add it to the ones shown, open its pull request, delete from the remote |
| Tag | Check out (detached), create branch, compare, show only its history or add it to the ones shown, push, delete |
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

### Side bar

Gitar has no icon of its own in the activity bar: its views are in the **Source Control** side bar, the one VS Code keeps for Git, under **Changes** and **Graph**. Three of them show what the graph of Gitar shows, each on its own:

- **Commits** is the graph without the references: the search, the commits with their lines and labels, and the details of the selected commit under the list instead of beside it. Its header has the buttons the toolbar of the graph has: fetch, pull, push and compare, with the other ways to pull and push, undo and the reflog under **…**. A list this narrow gives each commit two lines: its message, and under it its labels with their names, who made it and when. A commit with more than three labels names two of them, what is checked out first, and counts the others: hover the count to read them.
- **Branches** is the references tree: the recent branches and the favorites, local branches, remote branches, tags and worktrees, with the same context menus, and only the branches the graph is narrowed to while it is. Its header names the branch that is checked out and has the buttons to create a branch and to compare. Selecting a reference selects its commit in the Commits view and in the graph, if they are open.
- **Stashes** lists the stashes, and its header counts them. Unfold one to see the files it holds, untracked ones included, and select a file to open its diff. Apply, pop and drop are on each row; the button in the header stashes all changes.

The fourth, **Gitar Changes**, stages and commits: see [Changes](#changes). VS Code already has a view for that right above, so this one is hidden until you ask for it, with **Gitar: Show Changes** or by ticking it in the **…** menu of the side bar, and stays until you hide it again. The number on the icon of the side bar is the one VS Code counts.

VS Code shows the views an extension adds to this side bar folded: click the header of one to unfold it, or run **Gitar: Show Commits in the Side Bar**, **Gitar: Show Branches** or **Gitar: Show Stashes**. It remembers what you fold and unfold from then on. The context menus open inside the view they belong to, so in a short one they scroll: drag the border between two views to give one more room, or fold the ones you are not using.

If you had Gitar before its views moved here and they are still where they were, **View: Reset View Locations** brings them over.

### A commit in an editor tab

The details beside the graph are a summary. To read a commit whole, open it in a tab of the editor:

- double-click it in the graph or in the Commits view, or press `Enter` on the selected one;
- press the button beside the one that closes its details;
- choose **Open in an editor tab** in its context menu;
- run **Gitar: Open Commit in Editor…** and type a hash, or anything else git turns into a commit.

The tab has the message in full, the labels of the commit, its author, committer and dates, its hash, which a click copies, and its parents, which open in tabs of their own. **Show in the graph** selects the commit in the graph, and **Open in the diff editor** opens all of its changes in the editor VS Code has for that.

Under them are the files the commit changed, each with the lines it gained and lost, as a tree of directories or as a list: the two buttons beside the count choose, and the choice is remembered for the tabs opened later. Click a file to go to its changes, further down in the same page: every file has its diff there, with the number each line has before and after, under a header that stays in sight while its lines scroll. The arrow on the header folds a diff away, and **Fold all** and **Unfold all** do so with all of them. The button at the end of a header, or on the row of a file, opens that file in the diff editor.

A file changed in more than 800 lines starts folded, and so do the ones that come after 5,000 lines are showing. A commit is sent to its tab up to 20,000 lines: the files past that say so, with a link to the diff editor. A merge is shown against its first parent, as in the details. `Ctrl`+`F` searches the page with the search box of VS Code.

Each commit has one tab: asking for it again shows the one it has. A tab stays of the repository its commit is in, also after the other views are pointed at another, and **Show in the graph** brings them back to it.

### Compare

**Gitar: Compare Branches, Tags or Commits…**, also the compare button in the headers of the Commits and Branches views and the first entry under **…** in the toolbar, asks for the two sides one after the other. Each is chosen from the list of branches, remote branches and tags, or typed with **Enter a hash or a revision…**: a commit hash, or anything else git turns into a commit, such as `HEAD~3`, `v1.0^` or `main@{yesterday}`. What git does not know is refused while you type.

The files that differ between the two are listed in place of the commit details; selecting a file opens the diff, and the button next to the count opens all of them in one editor. **Swap** reverses the direction. The comparison shows in the view it was asked from: the graph, the Commits view, or the Branches view, under the tree. Asked from the command palette, it shows in the graph.

From the context menu of a commit, branch or tag:

- **Compare with `<current branch>`** compares it with what is checked out.
- **Compare with…** asks only for the other side.
- To compare two commits of the graph, select one, then right-click the other and choose **Compare with … selected before**.

### Filter by branch

The graph shows every branch, remote branch and tag until you tell it which ones. The button before the search box, three lines that get shorter, says what is shown and opens the list to choose from:

- **All**, **Current** and **Local** at the top choose with one click: everything, only what is checked out, or only the local branches. **Current** follows you as you switch branch.
- Under them, every local branch, remote branch and tag has a tick. Tick the ones to show: the graph changes as you do. From **Current** or **Local**, a tick added or taken away starts from the branches those stand for.
- The box above the list leaves in it the names that contain what you type. `Escape` empties it, and closes the list when it is empty.

The same can be done from the context menu of a branch or tag, on its label in the graph, in the references and in the Branches view. The references list only the branches that are shown, so one that is not is added from its label in the graph, or from the list of the button:

| Entry | Does |
| --- | --- |
| **Show only this history** | Narrows the graph to what that reference can reach |
| **Show this history too** | Adds it to the ones shown, when the graph is narrowed already |
| **Hide this history** | Takes it out of the ones shown |
| **Show all branches** | Shows everything again |

While the graph is narrowed the button is pressed in, and a bar above the commits says to what, with **Show all branches** to undo it. The choice is one for the graph and the Commits view of the side bar, and is remembered for each repository of the workspace. A branch that is deleted is forgotten.

What narrows the graph further works inside the branches shown: the history of a file is the one it has on them, and a search finds only their commits. Going to a commit that is on none of them, by its hash or from the reflog, shows all the branches again. The uncommitted changes are listed above the graph only when the commit they are made on is in it.

### Bisect

To find the commit that broke something, right-click a commit you know is broken and choose **Start bisect: this commit is bad**, then mark one that works as good. Git checks out a commit in between; test it and answer with **Good**, **Bad** or **Skip** in the banner. The marks are shown in the graph, and the banner counts how many commits can still be the culprit. When one is left, Gitar tells you which. **End** (`git bisect reset`) goes back to where you started.

### Undo

**Undo** in the toolbar takes back the last commit, amend, checkout, merge, pull, rebase or reset, including ones made from the terminal, by reading the reflog. It always shows what it is about to do first. Undoing twice redoes. It also restores a branch deleted or a stash dropped in Gitar, and the conflicts Gitar resolved, as long as nothing else happened since.

### Previews before risky operations

- **Merge and cherry-pick**: Gitar computes the result first, without touching your files, and tells you which files will conflict before it starts.
- **Force push**: the confirmation lists the commits on the remote branch that are not in yours and would be overwritten, as of the last fetch.

### Search

The box in the toolbar searches in one of five ways, chosen from the list next to it:

| Mode | Finds | Runs |
| --- | --- | --- |
| Loaded | Message or author among the commits already loaded, highlighted as you type; or the start of a hash, from its fourth character on | Nothing |
| Message | Commits whose message contains the text, ignoring case | `git log --grep` |
| Author | Commits whose author name or email contains the text, ignoring case | `git log --author` |
| Changes | Commits that add or remove the text | `git log -S` |
| Changes (regex) | Commits with a changed line that matches a POSIX extended regular expression (`[0-9]`, not `\d`) | `git log -G` |

All modes but the first search the whole history that is shown when you press `Enter`: every branch, remote branch and tag, or what a filter leaves of them. The two that look inside the changes read every commit and can take a while on a large repository.

The commits found stay where they are in the graph and the others are dimmed. The box counts them, `2/14` when the selected commit is the second of fourteen, and steps through them:

| Key | Does |
| --- | --- |
| `Enter`, `F3` or the arrow down | Selects the next match, and starts again from the first after the last |
| `Shift+Enter`, `Shift+F3` or the arrow up | Selects the previous one |
| `Ctrl+F` (`Cmd+F` on macOS) | Puts the cursor in the box, from anywhere in the view. While the graph or the Commits view has the keyboard the key is theirs, and the editor behind does not open its own search |
| `Escape` | Empties the box |

A match further back than the history is loaded is loaded when you step to it. What a search of the whole history found is found again when the commits change, so a commit made or fetched meanwhile is counted too; a search stops counting at 5,000 commits and says so with a `+`.

The funnel in the box, there for every mode but the first, shows the same search the other way: only the commits found, as a list, until you press it again or choose **Show all commits**. It stays the way you leave it.

#### Go to a commit

Type the hash of a commit in the box, or the first four characters or more of it, with **Loaded** chosen. If the commit is among the loaded ones it is highlighted like any other match; if it is not, the box offers `Enter ↵`, and pressing it asks git for the commit wherever it is:

- further back than the history is loaded: the history is loaded up to it;
- left out by the filter in use, such as the history of a file or of a branch: the filter is removed;
- on no branch or tag, such as a commit lost to a reset or a rebase: the graph shows the history of that commit alone, until you choose **Show all commits**.

**Gitar: Go to Commit…**, also under **…** in the toolbar and in the header of the Commits view, asks for anything git takes for a commit instead: a hash, a branch, a tag, `HEAD~3`, `main@{yesterday}`.

### File history

**Gitar: Show File History**, also in the context menu of the editor, of its tab and of the Explorer, narrows the graph to the commits that changed a file. The graph stays connected, so you still see on which branches the file changed. The same is offered by the clock button next to each file in the commit details.

Renames are followed: Gitar first asks git for the names the file had before (`git log --follow`), then shows the commits that changed any of them, and the bar above the graph lists the earlier names. A file that began as a copy of another is not traced back into the original. If an earlier name was later reused for a different file, the commits of that one appear too.

### Blame

The line under the cursor shows who last changed it, when, and the subject of that commit, dimmed at the end of the line. It takes unsaved edits into account. Hover it for a link that shows the commit in the graph. Turn it off with `gitar.blame.enabled` or **Gitar: Toggle Inline Blame**.

Wherever the cursor is, **Gitar: Open Commit of Current Line in Editor** (`Alt+B`) opens the commit that last changed the line in an editor tab, and **Gitar: Reveal Commit of Current Line in Graph** (`Shift+Alt+B`) shows it in the graph. Both are in the context menu of the editor too.

The button with a person at the top right of an editor shows it for the whole file: beside each line, before its text, the day it was last changed and by whom. The same button, now a closed eye, hides it again, and so do **Gitar: Toggle File Blame** and the entry in the context menu of the editor. It is switched on file by file, and a file keeps it until it is closed.

- What is beside the line under the cursor stands out on a colored background, and so does what is beside every other line of the same commit: what else it changed in the file is seen at a glance. In a file longer than its editor the scroll bar has a mark where those lines are. The colors are `gitar.blameHighlightBackground` and `gitar.blameHighlightForeground`, to change with `workbench.colorCustomizations`.
- At the left of what is beside a line there is a bar in the color of its age: red for a line that was just changed, blue for one changed two years ago or more, and the colors in between for the ages in between. Recent days count more than old ones, so that a day is told from a week. `gitar.fileBlame.age.enabled` turns it off, and `gitar.fileBlame.age.recentColor`, `oldColor` and `oldAfterDays` change the two colors and how old is old.
- The commit is said beside the first of the lines it changed that follow each other; the ones after it have its bar, and its background when it stands out. `gitar.fileBlame.groupLines` turns that off, to have it said beside every line.
- What is said is chosen with `gitar.fileBlame.format`, which is `${date} ${author:20}` unless you change it. `${date}` is the day of the commit, `${ago}` how long ago it was, `${author}` who made it, `${summary}` the first line of its message and `${hash}` its hash; a number after a colon is the most letters it may take, and anything else is written as it is. Each thing starts in one column whatever the lines above and below say. `${ago} ${author:16} ${summary:40}`, for example, gives `3 days ago Ann Lee  Fix the parser`.
- Hover what is beside a line for the subject of the commit, and for links that show it in the graph, open it in an editor tab, or **blame the file as it was before**: the file opens as the commit found it, in a tab that names the commit it is of, with the blame it had then. That tells who had written what the commit replaced, and going on from there walks back through the history of a line, past the commits that only moved or reformatted it. **Gitar: Blame File Before Commit of Current Line** does the same for the line under the cursor.
- The funnel beside the button leaves a line to who wrote it when all that was changed since is its whitespace or its place in the file (`git blame -w -M`). It is the setting `gitar.blame.ignoreWhitespaceAndMoves`, which holds for the blame of the line under the cursor too.
- The pin beside it shows the blame in every file that is opened, rather than in the ones it is asked for; the button of the blame still hides it in a file, which then stays without until it is closed. It is the setting `gitar.fileBlame.everyFile`. Turning it off leaves the blame to the files it was asked for one by one. Like the funnel, the pin is there while the file shows its blame; **Gitar: Toggle File Blame in Every File** switches it from anywhere.
- Lines that are in no commit yet say so, and have the color of what was just changed. What you type says so at once, and git is asked again a moment after you stop, with the text as it is in the editor, saved or not.
- A file that is in no commit has no one to name: Gitar says so and shows nothing.
- The button is there for files on disk, whenever the workspace has a repository.

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

The **Gitar Changes** view, shown with **Gitar: Show Changes**:

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

Gitar shows one repository at a time. It finds the repository of each workspace folder, the repositories directly inside a folder, and their submodules. When there is more than one, a list at the start of the toolbar and at the top of the Changes view switches between them, as does **Gitar: Select Repository**, and the header of the Commits view names the one that is shown. The choice is remembered per workspace. **Show File History** switches to the repository of the file on its own.

### Conflicts

When a merge, rebase, cherry-pick or revert stops, the Graph and Changes views show a banner with **Continue**, **Skip** and **Abort**. The banner also shows while files are in conflict without such an operation, as after a stash that did not apply cleanly. Conflicting files are listed in the Changes view, and **Mark as resolved** stages one.

Selecting a conflicting file opens it in VS Code's merge editor, with the common ancestor as the base and the two sides labelled by what they are in the operation that stopped: in a rebase, **Current** is what you are rebasing onto and **Incoming** is your own commit. Save the result there, then mark the file as resolved. A file that was added or deleted on one side has no three versions to merge, and opens as a normal file instead. The merge editor is opened through the command VS Code's own Git extension uses, which is not part of the documented API: if a future version changes it, the file opens in the normal editor with its conflict markers.

#### Conflicts that need no choice

> **Experimental.** This is still being tested, and it is off until you turn on `gitar.conflicts.autoResolve` in the settings, where it carries the **Experimental** mark. While it is off Gitar does not look into the files in conflict, and nothing of what follows is offered. Look at what it wrote before you commit.

Git stops wherever the two sides changed lines that touch. Many of those stops need no choice between the sides, and Gitar can resolve them: the banner says how many (**Resolve 2 of 3 automatically**), a file in conflict has the same button on its row in the Changes view, **Gitar: Resolve Conflicts Automatically** does it from the command palette, and the message that says an operation stopped offers it. A conflict is resolved when it is one of these:

- **Changes to lines next to each other.** One side changed a line and the other the line after it, or one added or removed lines beside the ones the other changed. Each change is kept where it was made.
- **The same change on both sides**, such as a line both added among lines each changed in its own way. It is written once.
- **Spaces or line endings only.** The two sides have the same lines spaced differently: indented with tabs on one and with spaces on the other, with spaces left at the end of a line, or with other line endings. The current side is written. When one side only touched the spaces at the end of lines the other really changed, the real change is written. A space that parts one word in two is not such a difference: `a=1` and `a = 1` stay a conflict.
- **A change on one side only**, where the other turns out to have the lines as they were.

Everything else is left exactly as git marked it: two different changes to the same line, a line one side removed and the other changed, lines both added at the same place, two conflicts with nothing certain between them, a conflict with markers of its own inside. Every line Gitar writes is a line of one of the two sides, as it is in the file: it never makes one up. What the lines were before either side changed them is read from the index (`git show :1:<file>`), so the style of the markers does not matter. Binary files, files one side deleted, files larger than 2 MB and files that are not UTF-8 are not touched.

It is also cautious where a file can be read in more than one way. Lines that repeat, such as closing braces and empty lines, can be paired with the ones of the common ancestor in several ways, and git made its choice without saying which. A conflict is resolved only when pairing them from the top and from the bottom gives the same lines, when no new line would end up written twice, when the changes of the two sides do touch as they must have for git to stop, and when the lines around the conflict are lines both sides really have (`git show :2:<file>` and `:3:<file>`). The tests run this against git itself on files made mostly of such lines, and it resolves there nothing that git's own account of the conflict would not.

Before it writes anything Gitar asks, saying for each file how many of its conflicts it would resolve and why, which files it would write and which command it would run. **Preview** opens the files beside what they would become, and asks again. Then the files are written: the ones left without conflicts are staged with `git add`, and the ones that still have some keep the markers of those and stay unstaged, to be finished in the merge editor. What was typed in a file since git stopped is kept, though a conflict right beside lines changed by hand is left alone, and nothing is written if a file changed between the question and the answer.

**Undo**, in the message that follows and in the toolbar, marks every conflict again as git had (`git checkout --merge`), in the files that were staged too.

#### A whole file from one side

In the Changes view a file in conflict also has **Take the current side** and **Take the incoming side**, for when one side is simply right: `git checkout --ours` or `--theirs` followed by `git add`, or `git rm` when that side deleted the file. Gitar asks first and says what each side is in the operation that stopped. Undo marks the conflicts again, except in a file one side deleted, which git cannot mark again.

## Command preview

Gitar runs the `git` executable found on your `PATH`, and every command that changes the repository or a remote is written to the **Gitar** output channel (**Gitar: Show Command Log**).

Set `gitar.commandPreview` to `all` to see the exact commands before they run and approve them:

| Value | Behavior |
| --- | --- |
| `off` (default) | Only asks before commands that can lose work or rewrite history: force push, hard reset, discarding changes, dropping a stash, force-deleting a branch, deleting a remote branch, removing a remote, removing a worktree, aborting an operation, undo, interactive rebase, fixup, branch cleanup, a merge or cherry-pick that is going to conflict, resolving conflicts automatically (when that is turned on) and taking one side of a file in conflict. |
| `all` | Shows the commands and asks before running anything that changes the repository or a remote, staging included. |

The commands shown are the commands that run: Gitar adds no hidden flags to them. Where a command would open an editor for a commit message, which cannot work from an extension, the flag that prevents it is part of the command you see (`--no-edit`, or `-c core.editor=true` when continuing an operation).

For the same reason, two things that look odd in a command are there on purpose:

- A file whose name is also a pattern to git (it contains `[`, `]`, `*`, `?` or `\`, or starts with `:`) is passed as `:(literal)<name>`. Without it, staging or discarding `pages/[id].tsx` would also act on `pages/i.tsx` and `pages/d.tsx`.
- A branch that shares its name with a tag or with a remote branch is named in full, as `refs/heads/<name>`, where the short name would mean the other one or be refused: merging it, starting a branch from it, pushing it.

One operation does more than run commands: resolving conflicts automatically, which is experimental and off by default, writes the files itself, and then runs `git add`. The confirmation lists the files before the command, and the log has a `write <file>` line for each.

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
| `npm test` | Runs the tests with Vitest. The integration tests run the real commands against throwaway repositories, and resolve conflicts marked by git itself, hundreds of them made at random. |
| `npm run test:e2e` | Builds, then runs the end-to-end tests inside a real VS Code: see below. |
| `npm run test:ui` | Builds, then uses the extension in a real VS Code window, with real clicks and keys, saving screenshots: see below. |
| `npm run package` | Makes a minified build and packs it into `gitar-<version>.vsix`. It leaves the minified build in `dist/`; `npm run build` brings the development one back. |
| `npm run test:vsix` | Packages, then runs the end-to-end tests on what the `.vsix` contains instead of on this folder. |
| `npm run preview -- <folder>...` | Serves the webview at `http://localhost:5174` against the repositories found in the folders, read-only, to work on the UI without an Extension Host. Add `?view=changes`, `commits`, `branches` or `stashes` for a view of the side bar, `?view=commit&commit=<revision>` for the tab of a commit, and `?theme=light` for the light theme, and `--port=<number>` before the folders to serve a second one beside it. |

### End-to-end tests

`npm run test:e2e` starts the VS Code installed on the machine as a separate instance, with a throwaway profile and a throwaway workspace holding two small repositories and a bare remote, and runs `test/e2e/suite.ts` inside its Extension Host. Your own VS Code window, settings and extensions are not touched; a second window opens for about half a minute and closes by itself. Pass the path of the executable as an argument, or set `VSCODE_PATH`, if it is not in a standard place.

The suite drives the extension through its commands and its controller, with VS Code's dialogs, input boxes and pickers answered by stubs that record what they were asked. It checks, among other things, that the webviews of all five views load, that only the views that list commits are sent them, that a comparison goes to the view that asked for it, that a commit is reached by its hash wherever it is in the history, that a commit opens in one editor tab with its changes and stays of its repository when the others move on, that the graph is narrowed to the branches chosen and remembers them for each repository, that the branches checked out last are listed and the favorites of each repository remembered, that every line of a file is given the commit that changed it last and what is typed is not committed, that the commit of a line opens in a tab and the file opens as it was before it with the blame it had then, that every file shows its blame when that is asked but for the ones it is hidden in, that a pull sets aside the changes that are not committed and says when they do not fit on what came in, that the views follow changes made outside the editor, that the commands shown in a confirmation are the ones that run and the ones logged, that diffs and the merge editor open with the right content, that nothing about resolving conflicts automatically is offered or run until its setting is on, and that with it on the conflicts that need no choice are resolved after the preview, the others left marked, and all of them marked again by Undo.

`npm run test:vsix` runs the same suite on the packaged extension: the `.vsix` is unpacked into the throwaway folder and loaded from there, which catches a file left out of the package or broken by minification. The package has no license file and no repository URL, so it is built with the flags that allow that; add both before publishing it anywhere.

What that suite cannot see is what only eyes and hands can: how the views look, the blame annotations, drag and drop, the context menus of the webviews, and the real dialogs, which VS Code refuses to show while it runs tests. That is what the next one is for.

### Using it like a person

`npm run test:ui` starts the same throwaway VS Code, this time not in test mode, and drives its window through the DevTools protocol (`test/e2e/ui.mjs`): real clicks and right-clicks at the coordinates of what is on screen, real keystrokes, the real command palette, input boxes, pickers and confirmation dialogs. It checks that:

- the graph shows in the panel with its icons, the colors of the theme and each label in the color of its line;
- it follows the theme, and the buttons of the toolbar have a shape against the panel in each of five: the two dark and the two light ones VS Code comes with, and the high contrast one. Dark themes tend to outline their buttons and light ones to fill them, and a button drawn for one kind is words on the background in the other;
- the toolbar still names the branch and fits when the panel is 1050 and 800 pixels wide;
- the button beside Pull lists the four ways to pull;
- the views of Gitar are in the Source Control side bar under those of VS Code, folded, with no icon of their own in the activity bar;
- the Changes view of Gitar is hidden until it is asked for, and lists what changed;
- a file is staged with a click and committed with a typed message;
- the context menu of a commit stays inside the view with every entry in sight, and creates a branch through the real prompts;
- with the command preview on, the dialog shows the exact command, and Cancel runs nothing;
- the line under the cursor is annotated with who changed it;
- the button of the editor puts beside each line who changed it and when, in one column, with a bar in the color of its age and the lines of the commit under the cursor standing out, and takes it away again; the buttons beside it change state when pressed, and the file opens as it was before the commit of a line, with its own blame;
- the search counts the commits it finds and steps through them with the keys and the arrows, goes to a commit by its hash even when no branch reaches it, highlights in the graph what git finds in the whole history or lists it alone, and counts a commit made meanwhile;
- the branches shown in the graph are chosen from the list under the button, with one click or one by one, with the box that narrows the list, and from the context menu of a branch; the Commits view of the side bar has the same button;
- a branch dragged onto the checked out commit offers to merge or rebase;
- the references and the details get wider when the line beside them is dragged, and a double click undoes it;
- a graph of twenty branches side by side keeps to its width by drawing them closer, gets narrower and wider when its edge is dragged, and a double click undoes it;
- the Commits view of the side bar lists the commits on two lines each, with their labels named, the details under them, and its header has the buttons;
- the Branches view compares two branches from its context menu, and a branch with a revision typed in the real picker and input box, which refuses one git does not know;
- the Stashes view unfolds a stash to its files, and its header counts the stashes;
- the graph opens as an editor tab, with the details of a commit beside it;
- the details keep a message of many lines to five that scroll, list the files with their directories or as a tree that folds, and in a narrow panel are sized by dragging the line over them;
- the references list the favorites and the branches checked out last first, only the branches the graph is narrowed to, and are put away and brought back by the button of the toolbar; the button of the status bar opens the graph in a tab;
- a double click on a commit opens it in an editor tab with its whole message, its files as a tree that folds or as a list, the lines each gained and lost and their diffs numbered line by line; the button in the details opens another the same way, and **Show in the graph** leads back;
- a merge that stops offers nothing more than usual while `gitar.conflicts.autoResolve` is off, the Settings editor marks that setting as experimental, and once it is on the merge counts in its banner the conflicts that need no choice, asks in a real dialog before resolving them, shows the files beside what they would become, writes them and stages the one left without conflicts, and marks them all again from **Undo**.

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
- the Changes, Branches and Stashes views are never sent the commits at all.

Measure the views with the minified build (`node esbuild.mjs --production`): the development build of React makes every render several times slower, in proportion to the rows.

`test/awkward.test.ts` is the other half: file names with spaces, accents, brackets and leading dashes, a repository with no commits, a detached `HEAD`, a shallow clone, several root commits, a merge of three parents, a branch and a tag of the same name, a submodule.

### Layout

| Path | Contents |
| --- | --- |
| `src/git` | Running Git, finding the repositories of a workspace, parsing Git's output, building the commands for each operation, resolving the conflicts that need no choice (`conflicts.ts`), and reading GitHub's answers. No VS Code dependency. |
| `src/shared` | Types shared by the extension and the webview, the graph lane layout, the tree the files of a commit are laid out in, how to name a reference that has namesakes, what the blame of a file says beside a line and in what color, and the commit message prompt. |
| `src/extension` | VS Code integration: views, commands, prompts, file watching, command preview, diff content, blame, GitHub sign-in, language model. |
| `src/webview` | The React UI. |
| `src/dev` | The browser preview server. |
| `test` | Unit and integration tests, and `test/e2e` with the end-to-end suite, the run that uses the window, and the scripts that launch VS Code for them; `test/perf` with the scripts for large repositories. |
