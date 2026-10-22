# Gitardo

Commit graph, history and everyday Git operations in a single VS Code panel.

Gitardo has a view in the bottom panel and five in the Source Control side bar of VS Code:

- **Graph**, in the panel next to the terminal: the commit graph, the references and the commit details, side by side.
- **Commits**, in the side bar under the views of VS Code: the commits of the branch that is checked out, each with whether it is pushed and the files it changed.
- **Gitardo Graph**, **Branches** and **Stashes**, in the side bar too: the same history, references and stashes as the panel, for when it is closed.
- **Gitardo Changes**, hidden until you ask for it: staging and committing, where VS Code has its own.

See [Side bar](#side-bar). Like any VS Code view they can be dragged somewhere else, folded or hidden, and **Gitardo: Open Graph in Editor** opens the graph as an editor tab. So does the **Gitardo** button in the status bar, which is there whenever the workspace has a repository; like any item of the status bar it can be hidden from the menu a right click on the bar opens.

## Installation

Search for **Gitardo** in the Extensions view of VS Code and install it, or run:

```bash
code --install-extension RiccardoFilippozzi.gitardo
```

Gitardo needs VS Code 1.100 or later and `git` on your `PATH`.

To build it yourself instead, pack it and install it from the file:

```bash
npm install
npm run package
code --install-extension gitardo-0.6.0.vsix
```

Reload the VS Code window afterwards. To update, run the last two commands again; to remove it, `code --uninstall-extension RiccardoFilippozzi.gitardo`.

## Features

### Graph

- Commit graph of all branches, remote branches and tags, loaded progressively: the next commits are read while you scroll, long before you get to the end of those shown, so that scrolling does not stop to wait for them. `gitardo.graph.pageSize` says how many are read at a time, 1,000 unless set otherwise.
- The labels of a commit are outlined in the color of its line in the graph; the branch that is checked out is the one filled in.
- Once the pull requests are loaded from GitHub, the label of a branch that has an open one ends with its number, in the color of its checks: passed, failed or running. Hover it for its title, and click it to open it. A remote branch has it on its own label when no local branch tracks it.
- The commits of a local branch that are not in its upstream yet, what the next push of that branch sends, have a ring around their dot; hover the ring for the upstream. It is what the last fetch saw. While the graph leaves the upstream out, as with **Local**, nothing is marked.
- Rest the pointer on the label of a branch, remote branch or tag to see its history: the commits it reaches, as far as the graph has loaded them, and the lines between them, keep their colors, and the rest of the graph fades until the pointer leaves the label. The same works on the branches, tags, stashes and worktrees listed in the references beside the graph, and on the branches, tags and worktrees of the Branches view of the side bar, which bring out their history in the graph and in the Gitardo Graph view while they are open. Hold `Shift` on a label of the graph to bring out only the commits it has that the branch checked out has not: what merging it, or a pull request of it, would bring.
- **Show the author**, **Show the date** and **Show the hash** in the **…** menu of the toolbar, or the setting `gitardo.graph.columns`, choose what is shown beside the message of each commit, and under it where the graph is narrow: what is left out gives its room to the messages.
- A thin line before the first commit of yesterday, of this week, of last week and of each month before has its name at its end, so that you see how far back you are as you scroll. **Separate the days, weeks and months** in the **…** menu of the toolbar, or the setting `gitardo.graph.dateSeparators`, takes them away.
- **Show only the first parent of merges** in the **…** menu of the toolbar, or the setting `gitardo.graph.firstParent`, follows each branch along its own line only: a merge is one commit on it, without the commits it brought in. Each branch still shown has its line, down to where it started.
- The commit selected brings out its history the same way, less strongly, for as long as it is selected: the commits it comes from and the ones made on top of it, with the lines between them, keep their colors, and the rest of the graph is dimmed. A label under the pointer takes its place until the pointer leaves it. **Bring out the history of the selected commit** in the **…** menu of the toolbar, or the setting `gitardo.graph.traceSelected`, switches it off.
- Beside the scroll bar of the graph, marks say where in the commits loaded the one checked out is, in the color of its line, where the one selected is, and where what a search found is.
- With the keyboard on the graph, the arrows go from commit to commit and `Home` goes back to the one checked out. `Alt`+`↓` goes to the first parent of the commit selected and `Alt`+`↑` to the commit made on top of it, on its line, or else to the merge that took it in; with `Shift` too, they go to the next merge down or up.
- Drag the line between the references and the commits, or between the commits and the details, to change their widths; double-click it to go back to the default. In a panel too narrow to have them side by side the details go under the commits, and the line between the two is dragged up and down the same way, as it is in the Commits view of the side bar. The sizes are remembered per workspace.
- The first button of the toolbar puts the references away, to leave their room to the commits, and brings them back. It is remembered too.
- The graph is as wide as its lines need, up to sixteen side by side and a third of the list. With more branches than that open at once it draws the lines closer, and past a point it fades out at its edge rather than push the messages away. Drag that edge to give it less room or more, up to the width at which every line has its place; double-click it to let the graph choose again. This works in the Commits view of the side bar too, and each view remembers its own.
- Uncommitted changes shown as the first row of the graph, also before the first commit of a new repository. Its context menu stashes them, the staged ones alone too, stages or unstages them all, and **Discard all changes…** takes every file back to the last commit, staged changes included, and deletes the untracked files and folders, after a warning; not during a merge or a rebase, which **Abort** takes back. Selected, the row opens its files in the details, as a commit does: each has a button that stashes it and one that discards all its changes, staged or not, and a box to tick; with files ticked, the buttons above them stash or discard those, and without, all of them.
- References tree: local branches with ahead and behind counts, remote branches, tags, stashes, worktrees and submodules. Its sections are all closed when VS Code starts, here and in the Branches view; the ones you open stay open until VS Code is closed. From 15 branches and tags on, a filter box appears above it, and a section with more than 100 entries lists the first 100 and a **Show all** entry.
- Above them, when there are some, two shorter lists. **Recent** has the local branches that were checked out last, the latest first and up to five, without the one that is checked out now: where you were before is one double click away. **Favorites** has the branches you marked with **Add to favorites** in their context menu, local or remote; they also carry a star where they are listed with the others, and are remembered for each repository of the workspace.
- While the graph is narrowed to some branches (see [Filter by branch](#filter-by-branch)) the references list only those, in every section, under a line that says what they are narrowed to and has **Show all** to undo it. The button on that line lists them all instead, with the ones the graph leaves out dimmed, and back.
- Commit details with the list of changed files; selecting a file opens it in the VS Code diff editor, and the button next to the count opens the diffs of all of them in one editor. The two buttons before it choose how the files are listed: one after the other, each with its directory beside its name, or as a tree of directories that fold. The choice is remembered. Each file has the icon your file icon theme gives it in the Explorer, here and in every list of files of Gitardo, and each directory of the tree its own when the theme has icons for folders. With the theme set to **None** there are none.
- A long message shows its first line and four lines of the rest, so that the files stay in sight under it, and **Show more** shows it whole, in place.
- A message written as one paragraph with no title, which git takes whole for the subject, gives the title its first sentence, or its first words when the sentence is longer than a title, and goes on under it as text.
- The lines of a message, written to fit in 72 columns, are put back together and cut again at the width of the details or of the tab, where they would otherwise break twice each. Only a line that was cut is joined to the next: lists, indented lines, quotations, fenced blocks, addresses, lines that end early and the trailers at the end stay as they were written. This is only how the message is shown: the commit is as it was written.
- Double-click a commit to read it whole in an editor tab, with what it changed under its message: see [A commit in an editor tab](#a-commit-in-an-editor-tab). A double click on the label of a branch checks the branch out instead, as it does where the branches are listed.
- Selecting a stash shows what it holds, including the untracked files it took, which git keeps apart from the rest.
- The stashes are in the graph too, each above the commit it was made on, where its date puts it, as long as that commit is in the graph: on the branches shown, and not among what a search finds or in the history of a file. A stash is a square with no fill rather than a dot, joined to its commit by a dashed line, as the uncommitted changes are; its label, `stash@{0}`, has a dotted border, and its message is in italics. Its context menu applies, pops, drops it or makes a branch of it, as in the Stashes view. **Show stashes** in the **…** menu of the toolbar, or the setting `gitardo.graph.showStashes`, takes them out of the graph and brings them back.
- Fetch, pull (merge or `--rebase`), push, push with `--force-with-lease` and push with `--force`.
- **Pull** sets the changes that are not committed aside, pulls with your commits put on top of what comes in instead of merged with it, and puts the changes back: it runs `git pull --rebase --autostash`. Two settings, both on by default, choose what the button runs: `gitardo.pull.rebase` adds `--rebase` and `gitardo.pull.autostash` adds `--autostash`. One that is off leaves its option out, and with it the choice to the configuration of Git. The tooltip of the button says the command, and the menu beside it has the four ways to pull whatever the settings say, with the one of the button marked. Among the commands, **Gitardo: Pull** is the button and **Gitardo: Pull (No Options)** is `git pull` alone.
- What `--autostash` does: Git sets the changes aside in a stash, pulls, and puts them back. When they no longer fit on what came in, it leaves them in conflict in the files and keeps the stash, named `autostash`: Gitardo says so and offers the stashes, where it is dropped once the conflicts are resolved. When the pull itself stops on a conflict, git puts the changes back by itself once the merge or the rebase is finished or given up. Untracked files are not touched.
- A local branch that is not checked out can be brought up to date without switching to it: **Fast-forward to `<upstream>`** in its context menu runs `git fetch <remote> refs/heads/<remote branch>:refs/heads/<branch>`, which fetches the upstream and moves the branch to it in one step. Your files and the branch you are on are not touched. Git only does it when it is a fast-forward, so the entry is offered for a branch that has an upstream and no commits of its own, and is not checked out in another worktree; if the remote has moved in a way that is not a fast-forward since, git refuses and says why. For a branch with commits of its own, check it out and pull.
- Search across the loaded commits or the whole history: see [Search](#search).
- The graph can be narrowed to the branches you choose: see [Filter by branch](#filter-by-branch).
- Refreshes on its own when the repository or its files change, including changes made from the terminal or by another program. While the commits of a filter, of the branches just chosen or of the next page are read, a bar runs along the top of the list; it stops as soon as those commits are there, even when the files go on changing and the graph is read again behind it.
- While Gitardo has been reading a repository, running an operation, comparing two sides or asking GitHub for its pull requests for more than half a second, **Gitardo** with a spinning icon shows in the status bar. Its tooltip says what each of those is and for how long it has run, what asked for a read, such as a file that changed, and how many times in a row the repository was read because something changed during each read. A click lists the same, with the way to the commands Gitardo runs in its output channel, and so does **Gitardo: Show What Is Running**.
- Select several commits with `Ctrl`+click (`Cmd` on macOS) or `Shift`+click to act on them together: see [Several commits at once](#several-commits-at-once).
- The **…** button in the toolbar switches the local branches, the remote branches, the tags and the stashes on and off in the graph, and opens the comparison of two branches, tags or commits, the history of the active file, the reflog, the branch cleanup, the remotes, the identity switch and the pull requests. When the panel is narrow the buttons of the toolbar keep their icons and give up their words, and **Refresh** is left to this menu.
- In a workspace with several repositories, a list in the toolbar chooses the one to show: see [Multiple repositories](#multiple-repositories).

Right-click a commit, a branch, a tag or a stash for the operations that apply to it:

| On | Operations |
| --- | --- |
| Uncommitted changes | Stash, stash the staged changes, stage all, unstage all, discard all, staged changes and untracked files included |
| Commit | Open in an editor tab, check out (detached), create branch, create tag, create worktree, cherry-pick, revert, merge into the current branch, rebase the current branch onto it, edit its message, interactive rebase, fixup, reset (soft, mixed or hard), compare, bisect |
| Local branch | Check out (also by double-click), open in a worktree made for it, or, when another worktree has it, open, rename or remove that worktree (see [Worktrees](#worktrees)), fast-forward to its upstream, merge, rebase onto, compare with the current branch or with anything else, show it in the graph, show only its history or add it to the ones shown, open or create its pull request, create worktree, rename, delete |
| Remote branch | Check out (also by double-click) as a local tracking branch, or in the local branch of its name when there is one, brought up to it: fast-forwarded, or with its own commits rebased onto it if you choose; when another worktree has that branch, that worktree opens instead; open in a worktree on a local tracking branch, merge, rebase onto, compare, show it in the graph, show only its history or add it to the ones shown, open its pull request, delete from the remote |
| Tag | Check out (detached), create branch, compare, show it in the graph, show only its history or add it to the ones shown, push, delete |
| Stash | Apply, pop, create branch, drop |
| Worktree | Open in the Agents window, open in a new window (also by double-click), open a terminal in it, reveal it in the file manager, show what it has checked out in the graph, rename, copy its path, remove (with its branch, if you want), prune missing ones |
| Submodule | Open in a new window (also by double-click), open a terminal in it, reveal it in the file manager, show it in Gitardo, initialize, update to the recorded commit or to the latest of its branch, stage the commit it is on as the recorded one, synchronize URLs, copy its path or URL, deinitialize, remove (see [Submodules](#submodules)) |

**Show in the graph**, in the menu of a branch, tag or worktree in the references tree and in the Branches view, opens the graph at its commit. A commit further back than the history is loaded is loaded, and one that the branches shown or a filter leave out shows all of them again, as going to a commit from the reflog does. A click on a reference in the references tree goes to its commit the same way.

### Several commits at once

`Ctrl`+click (`Cmd` on macOS) adds a commit to the selection or removes it; `Shift`+click selects every commit between the selected one and the clicked one. A bar above the graph counts them, and offers what the context menu of the selection also does:

- **Cherry-pick onto `<current branch>`** runs a single `git cherry-pick` with all of them, oldest first whatever the order you clicked them in. Git treats them as one operation: if one conflicts it stops there, and **Continue**, **Skip** and **Abort** in the banner apply to the whole series. It is not offered when the selection contains a merge commit, which can only be picked on its own.
- **Compare these two commits**, when two are selected.
- **Copy hashes**.

**Undo** right after such a cherry-pick takes back all of its commits at once, also when it had stopped on a conflict and you continued it in Gitardo. If you continued it from the terminal, or did something else in between, Undo goes back one commit at a time like after any other commit.

### Drag and drop

Drag a commit, or a branch from the graph or the references tree, onto a row of the graph. Rows that accept the drop are outlined, and dropping opens a menu with what can be done:

| Drag | Onto | Offers |
| --- | --- | --- |
| A commit | The checked-out commit | Cherry-pick it onto the current branch |
| A branch | The checked-out commit | Merge it into the current branch, or rebase the current branch onto it |
| The current branch | Any other commit | Rebase it onto that commit, or reset it there |
| Another local branch | Any other commit | Rebase it onto that commit |

### Interactive rebase

**Interactive rebase…** on a commit opens an editor with the commits from there up to `HEAD`. Reorder them by dragging, and pick, reword, squash, fixup or drop each one. It is offered when those commits form a single line without merges. A reworded commit gets the subject typed there and keeps the rest of its message.

### Edit a commit message

The pencil beside the message in the details, or **Edit message…** in the context menu of a commit, opens its whole message in a box: **Save** or `Ctrl`+`Enter` gives the commit the new one, **Cancel** or `Escape` leaves it as it was. The last commit is amended with `git commit --amend --only`, which leaves out what is staged. An older one is reworded by an interactive rebase that makes the commits after it again, with new hashes, after asking; the changes that are not committed are set aside and put back with `--autostash`. It is offered on the last commit, merge or not, and on the older ones down to the first merge, while no merge, rebase or bisect is under way. When the commit is on a remote branch already, Gitardo says so first: the branch will have to be force pushed. The commit with its new message is selected after.

### Fixup

**Add staged changes to this commit (fixup)** on an earlier commit folds your staged changes into it, or all your changes when nothing is staged. It runs `git commit --fixup` followed by `git rebase -i --autosquash --autostash`, so the commit and the ones after it are rewritten. It is offered for the commits an interactive rebase can reach, except `HEAD`, which **Amend** already covers. If the changes do not fit the older commit, the rebase stops with conflicts like any other.

### Side bar

Gitardo has no icon of its own in the activity bar: its views are in the **Source Control** side bar, the one VS Code keeps for Git, under **Changes** and **Graph**.

**Commits** lists the commits of what is checked out, newest first, and nothing else: it is apart from the graph, so what the graph is narrowed to, searched for or scrolled to changes nothing here. Its header names the branch.

- Each commit says whether it is pushed. A cloud with an arrow, in color, marks the ones that are not in the upstream of the branch yet: what the next push sends. A plain cloud marks the ones that are. The line above the list counts the first, and the commits there are to pull. A branch with no upstream is compared with every remote branch instead, and in a repository with no remote nothing is marked.
- Click a commit to unfold the files it added, changed, deleted or renamed, and a file to open its diff. Hover a commit for its hash, who made it and when.
- The buttons on a commit open it in an editor tab, with its changes, or show it in the graph. Its context menu also checks it out, creates a branch or a tag on it, reverts it, resets the branch to it and copies its hash or its message.
- Its header has fetch, pull and push, with the other ways to pull and push and undo under **…**.
- The first hundred commits are read, and **Load more commits…** at the end reads the next.

Three other views show what the graph of Gitardo shows, each on its own:

- **Gitardo Graph** is the graph without the references: the search, the commits with their lines and labels, and the details of the selected commit under the list instead of beside it. Its header has the buttons the toolbar of the graph has: fetch, pull, push and compare, with the other ways to pull and push, undo and the reflog under **…**. A list this narrow gives each commit two lines: its message, and under it its labels with their names, who made it and when. A commit with more than three labels names two of them, what is checked out first, and counts the others: hover the count to read them.
- **Branches** is the references tree: the recent branches and the favorites, local branches, remote branches, tags and worktrees, with the same context menus, and only the branches the graph is narrowed to while it is, unless `gitardo.branches.followGraphFilter` is off. Its header names the branch that is checked out and has the buttons to create a branch and to compare; the title of its Worktrees section has one to create a worktree and a **…** with the rest of what concerns worktrees: switching, choosing what new ones get, bringing it into the ones there are and pruning the missing ones. Selecting a reference selects its commit in the Commits view and in the graph, if they are open; **Show in the graph** in its context menu opens the graph at it.
- **Stashes** lists the stashes, and its header counts them. Unfold one to see the files it holds, untracked ones included, and select a file to open its diff. Apply, pop and drop are on each row; the button in the header stashes all changes.

The fifth, **Gitardo Changes**, stages and commits: see [Changes](#changes). VS Code already has a view for that right above, so this one is hidden until you ask for it, with **Gitardo: Show Changes** or by ticking it in the **…** menu of the side bar, and stays until you hide it again. The number on the icon of the side bar is the one VS Code counts.

VS Code shows the views an extension adds to this side bar folded: click the header of one to unfold it, or run **Gitardo: Show Commits in the Side Bar**, **Gitardo: Open Graph in the Side Bar**, **Gitardo: Show Branches** or **Gitardo: Show Stashes**. It remembers what you fold and unfold from then on. The context menus open inside the view they belong to, so in a short one they scroll: drag the border between two views to give one more room, or fold the ones you are not using.

If you had Gitardo before its views moved here and they are still where they were, **View: Reset View Locations** brings them over.

### A commit in an editor tab

The details beside the graph are a summary. To read a commit whole, open it in a tab of the editor:

- double-click it in the graph, in the panel or in the side bar, or press `Enter` on the selected one;
- use the button on its row in the Commits view;
- press the button beside the one that closes its details;
- choose **Open in an editor tab** in its context menu;
- run **Gitardo: Open Commit in Editor…** and type a hash, or anything else git turns into a commit.

The tab has the message in full, the labels of the commit, its author, committer and dates, its hash, which a click copies, and its parents, which open in tabs of their own. **Show in the graph** selects the commit in the graph, and **Open in the diff editor** opens all of its changes in the editor VS Code has for that.

Under them are the files the commit changed, each with the lines it gained and lost, as a tree of directories or as a list: the two buttons beside the count choose, and the choice is remembered for the tabs opened later. Click a file to open it in the diff editor.

**Show the changes** puts the diff of every file in the page, under the list, and **Hide the changes** takes them away again; the eye on the row of a file shows them and goes to that file. Each diff has the number each line has before and after, and its code in the colors your theme gives it in the editor, under a header that stays in sight while its lines scroll. The arrow on the header folds a diff away, and **Fold all** and **Unfold all** do so with all of them. The button at the end of a header opens that file in the diff editor. Once the page is scrolled down, the round button in its corner takes it back to the top.

A file changed in more than 800 lines starts folded, and so do the ones that come after 5,000 lines are showing. A commit is sent to its tab up to 20,000 lines: the files past that say so, with a link to the diff editor. A merge is shown against its first parent, as in the details. `Ctrl`+`F` searches the page with the search box of VS Code.

Each commit has one tab: asking for it again shows the one it has. A tab stays of the repository its commit is in, also after the other views are pointed at another, and **Show in the graph** brings them back to it.

### Compare

**Gitardo: Compare Branches, Tags or Commits…**, also the compare button in the headers of the Gitardo Graph and Branches views and the first entry under **…** in the toolbar, asks for the two sides one after the other. Each is chosen from the list of branches, remote branches and tags, or the **Working tree**, the files as they are with what is not committed, or typed with **Enter a hash or a revision…**: a commit hash, or anything else git turns into a commit, such as `HEAD~3`, `v1.0^` or `main@{yesterday}`. What git does not know is refused while you type. The comparisons opened last are listed first, under **Opened before**, to open one again as it was.

The comparison opens in a tab of the editor, one for each pair: asking for the same two again shows the tab they have.

- At the top are the two sides. A click on one chooses another branch, tag or commit in its place, the hash beside it opens that commit in its tab, and the arrows between them swap the two.
- Under them, how far apart they are: how many commits the second has that the first has not, and the other way round, and the commit where they diverged, which opens in its tab. Then what merging the second into the first would do, worked out with `git merge-tree` without touching anything: fast-forward, merge with no conflict, or conflict in the files it names.
- The box under them narrows the comparison to a file or a folder, its path from the top of the repository: only its files, and only the commits that change it, are listed. The **×** shows all of them again.
- **Since they diverged** shows what the second changed since it left the first, from the commit they have in common, as a pull request shows it (`git diff from...to`). **Everything that differs** shows all that differs between the two (`git diff from to`), what the first changed meanwhile included. Two branches, tags or revisions open with the first, a comparison with a commit given by its hash with the second; one whose histories never meet can only be compared directly.
- **Commits** lists them: the ones only in the second side, then the ones only in the first, newest first, each with who made it and when; a click opens one in its tab. A commit whose change the other side has too, in a commit of its own, because it was cherry-picked or rebased, says **also in** that side and is greyed out: it is not what tells the two apart. With more than 2,000 commits between them they are not looked for on the other side, and the newest 2,000 are listed.
- Then the files, as a tree or as a list with the lines each gained and lost: a click opens one in the diff editor, and **Show the changes** puts the diff of each in the page, in the colors of your theme, as in the [tab of a commit](#a-commit-in-an-editor-tab). **Open in the diff editor** opens all of them in one editor of VS Code. The arrow beside a file takes the version the second side has into the working tree and the index (`git checkout <to> -- <file>`), or deletes the file when the second side has none, after asking, and with a warning when the file has changes that are not committed, which are lost.
- **Copy as patch** copies the changes as a patch that `git apply` takes, binary files included. **Open on GitHub**, when the repository is on GitHub, opens the same comparison there: a branch by the name of its upstream there, a remote branch or a tag by its name, anything else by its commit, which GitHub knows once it is pushed.

A side named by a branch, a tag or a revision such as `HEAD~1` is followed: when the branch moves, the tab shows where it is now, while the views show its repository. A side given by its hash stays that commit, and so does a branch that is deleted, which the tab says.

The **Working tree** as a side shows how the files differ from the other side as they are now, what is not committed included, and is read again as they change; its commits are those of the commit checked out. It is compared directly, as files that git does not track are not part of it. **Compare with Branch, Tag or Commit…** in the context menu of a file or a folder in the Explorer, and of an editor tab, compares it as it is in the working tree with the branch, tag or commit you choose, in a tab narrowed to it.

From the context menu of a commit, branch or tag:

- **Compare with `<current branch>`** compares it with what is checked out.
- **Compare with…** asks only for the other side, and opens the tab.
- To compare two commits of the graph, select one, then right-click the other and choose **Compare with … selected before**.

**Compare with `<current branch>`** and the comparison of two commits show the files that differ in place of the commit details, in the view they were asked from: the graph, or the Branches view under the tree. Selecting a file opens the diff, the button next to the count opens all of them in one editor, **Swap** reverses the direction, and **Open in a tab** opens the same comparison in a tab.

### Filter by branch

The graph shows every branch, remote branch and tag until you tell it which ones. The button before the search box, three lines that get shorter, says what is shown and opens the list to choose from:

- **All**, **Current**, **Upstream**, **Local** and **Remotes** at the top choose with one click: everything, only what is checked out, what is checked out and its upstream, only the local branches, or only the remote ones. **Upstream** shows at a glance what the branch has that its remote has not, and what there is to pull. **Current** and **Upstream** follow you as you switch branch. What is checked out is in the graph whichever you choose.
- Under them, every local branch, remote branch and tag has a tick. Tick the ones to show: the graph changes as you do. From **Current**, **Upstream**, **Local** or **Remotes**, a tick added or taken away starts from the branches those stand for.
- The box above the list leaves in it the names that contain what you type. `Escape` empties it, and closes the list when it is empty.
- **Filter the list of branches too**, at the bottom, chooses what the references beside the graph and the Branches view list while the graph is narrowed: only the branches it shows, or all of them, with the ones it leaves out dimmed. A dimmed one has an eye at the end of its row, under the pointer, that adds its history to the graph. The setting is `gitardo.branches.followGraphFilter`, and the line above the references has the same switch.

**Show local branches**, **Show remote branches** and **Show tags** in the **…** menu of the toolbar switch each kind of reference on and off in the graph, the same choice the list makes: **Local** is the local branches alone, **Remotes** the remote ones alone. One of them is always left on. They are greyed out while branches are ticked one by one, or **Current** or **Upstream** is chosen.

The same can be done from the context menu of a branch or tag, on its label in the graph, in the references and in the Branches view. The references list only the branches that are shown, unless they are set to list them all, so one that is not is added from its label in the graph, or from the list of the button:

| Entry | Does |
| --- | --- |
| **Show only this history** | Narrows the graph to what that reference can reach |
| **Show this history too** | Adds it to the ones shown, when the graph is narrowed already |
| **Hide this history** | Takes it out of the ones shown |
| **Show all branches** | Shows everything again |

While the graph is narrowed the button is pressed in, and a bar above the commits says to what, with **Show all branches** to undo it. The choice is one for the graph in the panel and the one of the side bar, and is remembered for each repository of the workspace. A branch that is deleted is forgotten.

What narrows the graph further works inside the branches shown: the history of a file is the one it has on them, and a search finds only their commits. Going to a commit that is on none of them, by its hash or from the reflog, shows all the branches again. The uncommitted changes are listed above the graph only when the commit they are made on is in it.

### Bisect

To find the commit that broke something, right-click a commit you know is broken and choose **Start bisect: this commit is bad**, then mark one that works as good. Git checks out a commit in between; test it and answer with **Good**, **Bad** or **Skip** in the banner. The marks are shown in the graph, and the banner counts how many commits can still be the culprit. When one is left, Gitardo tells you which. **End** (`git bisect reset`) goes back to where you started.

### Undo

**Undo** in the toolbar takes back the last commit, amend, checkout, merge, pull, rebase or reset, including ones made from the terminal, by reading the reflog. It always shows what it is about to do first. Undoing twice redoes. It also restores a branch deleted or a stash dropped in Gitardo, and the conflicts Gitardo resolved, as long as nothing else happened since.

### Previews before risky operations

- **Merge and cherry-pick**: Gitardo computes the result first, without touching your files, and tells you which files will conflict before it starts.
- **Force push**: the confirmation lists the commits on the remote branch that are not in yours and would be overwritten, as of the last fetch.
- **Apply and pop a stash**: Gitardo asks first and says what the stash would stop on: the files that would be in conflict, computed the same way; the files not committed that it changes, for which git refuses it and changes nothing; or an untracked file it took along that is there again, which git leaves as it is while it applies the rest. A popped stash is dropped only when its changes went in without conflicts.
- **Delete a branch or a tag**: a tag is deleted after asking, and a branch too, saying whether its commits are merged, into its upstream or into the current branch, so that none is lost, or would be lost with it; **Undo** brings the branch back. A remote that has the tag keeps it.

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
| `Ctrl+F` (`Cmd+F` on macOS) | Puts the cursor in the box, from anywhere in the view. While the graph, in the panel or in the side bar, has the keyboard the key is its own, and the editor behind does not open its own search |
| `Escape` | Empties the box |

A match further back than the history is loaded is loaded when you step to it. What a search of the whole history found is found again when the commits change, so a commit made or fetched meanwhile is counted too; a search stops counting at 5,000 commits and says so with a `+`.

The funnel in the box, there for every mode but the first, shows the same search the other way: only the commits found, as a list, until you press it again or choose **Show all commits**. It stays the way you leave it.

#### Go to a commit

Type the hash of a commit in the box, or the first four characters or more of it, with **Loaded** chosen. If the commit is among the loaded ones it is highlighted like any other match; if it is not, the box offers `Enter ↵`, and pressing it asks git for the commit wherever it is:

- further back than the history is loaded: the history is loaded up to it;
- left out by the filter in use, such as the history of a file or of a branch: the filter is removed;
- on no branch or tag, such as a commit lost to a reset or a rebase: the graph shows the history of that commit alone, until you choose **Show all commits**.

**Gitardo: Go to Commit…**, also under **…** in the toolbar and in the header of the Gitardo Graph view, asks for anything git takes for a commit instead: a hash, a branch, a tag, `HEAD~3`, `main@{yesterday}`.

### File history

**Gitardo: Show File History**, also in the context menu of the editor, of its tab and of the Explorer, narrows the graph to the commits that changed a file. The graph stays connected, so you still see on which branches the file changed. The same is offered by the clock button next to each file in the commit details.

Renames are followed: Gitardo first asks git for the names the file had before (`git log --follow`), then shows the commits that changed any of them, and the bar above the graph lists the earlier names. A file that began as a copy of another is not traced back into the original. If an earlier name was later reused for a different file, the commits of that one appear too.

### Blame

The line under the cursor shows who last changed it, when, and the subject of that commit, dimmed at the end of the line. It takes unsaved edits into account. Hover it for a link that shows the commit in the graph. Turn it off with `gitardo.blame.enabled` or **Gitardo: Toggle Inline Blame**.

Wherever the cursor is, **Gitardo: Open Commit of Current Line in Editor** (`Alt+B`) opens the commit that last changed the line in an editor tab, and **Gitardo: Reveal Commit of Current Line in Graph** (`Shift+Alt+B`) shows it in the graph. Both are in the context menu of the editor too.

The button with a person at the top right of an editor shows it for the whole file: beside each line, before its text, the day it was last changed and by whom. The same button, now a closed eye, hides it again, and so do **Gitardo: Toggle File Blame** and the entry in the context menu of the editor. It is switched on file by file, and a file keeps it until it is closed.

- What is beside the line under the cursor stands out on a colored background, and so does what is beside every other line of the same commit: what else it changed in the file is seen at a glance. In a file longer than its editor the scroll bar has a mark where those lines are. The colors are `gitardo.blameHighlightBackground` and `gitardo.blameHighlightForeground`, to change with `workbench.colorCustomizations`.
- At the left of what is beside a line there is a bar in the color of its age: red for a line that was just changed, blue for one changed two years ago or more, and the colors in between for the ages in between. Recent days count more than old ones, so that a day is told from a week. `gitardo.fileBlame.age.enabled` turns it off, and `gitardo.fileBlame.age.recentColor`, `oldColor` and `oldAfterDays` change the two colors and how old is old.
- The commit is said beside the first of the lines it changed that follow each other; the ones after it have its bar, and its background when it stands out. When that first line is scrolled out of sight, the first line in sight says it instead, so the lines at the top of the editor are never left unnamed. `gitardo.fileBlame.groupLines` turns that off, to have it said beside every line.
- What is said is chosen with `gitardo.fileBlame.format`, which is `${date} ${author:20}` unless you change it. `${date}` is the day of the commit, `${ago}` how long ago it was, `${author}` who made it, `${summary}` the first line of its message and `${hash}` its hash; a number after a colon is the most letters it may take, and anything else is written as it is. Each thing starts in one column whatever the lines above and below say. `${ago} ${author:16} ${summary:40}`, for example, gives `3 days ago Ann Lee  Fix the parser`.
- Hover what is beside a line for the subject of the commit, and for links that show it in the graph, open it in an editor tab, or **blame the file as it was before**: the file opens as the commit found it, in a tab that names the commit it is of, with the blame it had then. That tells who had written what the commit replaced, and going on from there walks back through the history of a line, past the commits that only moved or reformatted it. **Gitardo: Blame File Before Commit of Current Line** does the same for the line under the cursor.
- The funnel beside the button leaves a line to who wrote it when all that was changed since is its whitespace or its place in the file (`git blame -w -M`). It is the setting `gitardo.blame.ignoreWhitespaceAndMoves`, which holds for the blame of the line under the cursor too.
- The pin beside it shows the blame in every file that is opened, rather than in the ones it is asked for; the button of the blame still hides it in a file, which then stays without until it is closed. It is the setting `gitardo.fileBlame.everyFile`. Turning it off leaves the blame to the files it was asked for one by one. Like the funnel, the pin is there while the file shows its blame; **Gitardo: Toggle File Blame in Every File** switches it from anywhere.
- Lines that are in no commit yet say so, and have the color of what was just changed. What you type says so at once, and git is asked again a moment after you stop, with the text as it is in the editor, saved or not.
- A file that is in no commit has no one to name: Gitardo says so and shows nothing.
- The button is there for files on disk, whenever the workspace has a repository.
- With word wrap on, a long line is folded inside the editor with what is beside it. VS Code does not count what an extension draws before a line when it folds it, so Gitardo keeps the room with an inlay hint of spaces at the start of each line, which it does count, and draws over it. With inlay hints switched off (`editor.inlayHints.enabled`), written in a font of their own (`editor.inlayHints.fontFamily`) or cut shorter than the room (`editor.inlayHints.maximumLength`), what is beside a line is drawn before it instead, and the first part of a folded line goes past the edge of the editor.

### Reflog

**Gitardo: Browse Reflog** lists the last 200 positions of `HEAD`. Pick one to show it in the graph, create a branch there, reset the current branch to it, check it out or cherry-pick it. This is how to get back commits that no branch reaches any more, for example after a reset or a rebase.

### A format for branch names

When branches are named after a convention, `gitardo.branches.format` writes it down, and Gitardo asks for its parts:

```json
"gitardo.branches.format": "PRJ-${input:ticket}-${input:kind}-rfi-${base}",
"gitardo.branches.inputs": [
  { "id": "ticket", "type": "promptString", "description": "Ticket number", "pattern": "^\\d+$" },
  { "id": "kind", "type": "pickString", "description": "Type of change", "options": ["feat", "fix", "chore"], "allowCustom": true }
]
```

- `${input:<id>}` is asked for as `gitardo.branches.inputs` says, in the order the format has them. A `promptString` is typed, and when it has a `pattern`, a regular expression, what is typed has to match it. A `pickString` is picked from its `options`, and with `allowCustom` the last entry, **Type another value…**, lets you type one. The value used last is proposed first the next time, or `default` before any was used.
- `${base}` is the branch it starts from, without its remote: `origin/feature/login` gives `feature/login`. From the toolbar, the branch checked out; on a tag, the tag. At a commit you choose what it is: the commit, as its short hash, or one of the branches that have it, the ones at the commit first.
- `${repo}` is the name of the repository's folder, and `${date}` today, as `2026-10-15`.

With a format set, **Create branch…**, in the toolbar and on a branch, a tag or a commit, first asks whether to use it, which is where the picker starts, or to type a branch name. The name the format makes is shown, and can be changed, before the branch is created. Creating a worktree asks the same (see [Worktrees](#worktrees)). The format and the inputs can be set for one repository in its `.vscode/settings.json`, for everyone who works on it. The settings were `gitardo.worktrees.branchFormat` and `gitardo.worktrees.inputs` before, and are still read where the new ones are not set.

### Branch cleanup

**Gitardo: Clean Up Branches** lists the local branches that are merged into the current one, or whose upstream branch was deleted from the remote. Merged branches are ticked and deleted with `git branch -d`, which refuses to lose commits. Branches that are not merged are left unticked; if you tick them they are deleted with `git branch -D`, after a warning. The current branch is never listed, nor the branch of the main worktree when this window is another worktree.

A branch that another worktree has checked out is listed with that worktree, and the two go together: the worktree is removed with `git worktree remove` before the branch is deleted, since git deletes no branch that a worktree has, and a folder of the worktrees left empty goes too. A worktree with files not committed is left unticked, like a branch that is not merged, and says how many; if you tick it, it is removed with `--force`, after a warning that those files are deleted. A worktree whose folder is gone is pruned.

### Worktrees

A worktree is another folder checked out from the same repository, on a branch of its own: a place to work on something else, or to let an agent work, without touching the folder you are in.

The **+** on the title of the Worktrees section, in the Branches view or beside the graph, and **Gitardo: Create Worktree…** ask for the branch to start from and a name. The name is that of a new branch, and of the worktree's folder, slashes and all: `feature/login` makes the branch `feature/login` in the folder `login` inside `feature`. While you type, the box says where the folder goes. The new branch has no upstream until it is first pushed, even when it starts from a remote branch, so that it is not pushed onto the branch it came from. **Create worktree…** on a branch puts that branch in a new worktree, in a folder of its name, and on a commit makes a new branch there, or leaves the worktree on a detached HEAD if the name is left empty.

New worktrees go in the folder that `gitardo.worktrees.folder` names, `${repo}.worktrees` next to the repository unless you change it: the worktree `fix-login` of `~/code/app` is `~/code/app.worktrees/fix-login`. `${repo}` is the name of the repository's folder, a relative path starts from the folder that holds it, and `~` is your home folder. A folder left empty when a worktree is renamed or removed goes too.

#### What git ignores, in a new worktree

A new worktree has only what is committed: no `node_modules`, no `.env`. Gitardo can give it what git ignores in the folder you are in, after `git worktree add`, as two settings say:

```json
"gitardo.worktrees.linkFolders": ["node_modules/"],
"gitardo.worktrees.copyFiles": ["/.env", ".vscode/settings.local.json"]
```

- `gitardo.worktrees.linkFolders`: the folders that git ignores and that match these patterns, in `.gitignore` syntax, are linked into the new worktree, the outermost ones only. What changes through a link changes in the folder you are in. On Windows the links are junctions, which need no rights.
- `gitardo.worktrees.copyFiles`: the files and folders that git ignores and that match these patterns are copied, except what is inside a linked folder and what the worktree has from its commit. A folder all of whose files match is copied as a whole.

Where neither place sets one of them, Gitardo follows the matching experimental setting of VS Code's Git extension, `git.worktreeSymlinkFolders` or `git.worktreeIncludeFiles`, which VS Code applies only to the worktrees it creates itself. One of Gitardo's set anywhere, even to an empty list, is the one that applies: the workspace folder's first, then the user's.

**Gitardo: Choose What New Worktrees Get…**, also in the **…** of the Worktrees section and of the Branches view, opens a tab that helps fill them. It lists what git ignores in the folder you are in, with its size, in sections by kind, each with what is proposed for it and why: dependencies such as `node_modules`, `.venv` or `vendor` linked, settings and secrets of this machine such as `.env` or `*.local.json` and the editor's settings copied, and build output, logs and the rest left out. What Gitardo does not know comes first; a section where nothing is proposed or chosen starts closed, and the tab remembers the ones you open or close. What has the same name in several places, such as the `node_modules` or the `.env.local` of each package, is one line, whose buttons choose for all of them by the pattern of the name, `node_modules/` or `.env.local`, which takes the ones to come as well. Unfolded, it lists each place, and choosing for one of them on its own puts a pattern of its path in place of the name's for each. **Use what is proposed** takes all of it; **Link**, **Copy** and **Nothing** on each line change one, at once and without running git. Below, the patterns of the two settings can be edited by hand. Git is asked what the patterns take, each with how many it takes from the folder and the list with what it gets, all of it or part, only when the tab opens and with **Look again**, which also reads again what git ignores; until then the tab says the patterns have changed since. **Save** writes them to the settings of the workspace folder, `.vscode/settings.json`, to share them with everyone who works on it, or to the user's settings, and can write VS Code's own two along with them, so that the worktrees VS Code creates get the same. **Edit in settings.json** opens the file, and **Remove from** takes the two settings out of it again. The tab follows what is changed in the settings elsewhere.

In the Explorer, the context menu of a folder has **Link into New Worktrees**, and that of a file or a folder **Copy into New Worktrees**, for those selected. Each adds the pattern of its path, such as `/packages/api/node_modules/` or `/.env`, to the setting, and takes it out of the other one. Git is asked first what the patterns would then take, and Gitardo says why it changes nothing: git tracks it, and each worktree has it from its commit; git does not ignore it; a pattern such as `node_modules/` gives it that already; or, to copy, it is in a linked folder. Of a folder git tracks part of, what git ignores in it is copied. Where a pattern of its own path gives it something, the menu has **Stop Linking into New Worktrees** or **Stop Copying into New Worktrees** in its place, which takes that pattern out and says if another one still gives it something. The setting is saved where it is set now, in the workspace folder or the user's settings; where it is not set, in the workspace folder, starting from VS Code's patterns when they apply. VS Code's own two settings are not changed.

The first worktree Gitardo creates while neither setting is set offers **Choose What It Gets…**, once. **Bring ignored files…** on a worktree, and **Bring ignored files into the other worktrees…** in the **…** of the Worktrees section, give worktrees that are there already what new ones get, without touching what they have.

Gitardo works the patterns out the way VS Code does and says each one in the log, as `symlink <folder>` and `copy <path>`, before making it. Nothing is made where the worktree has something already. One that fails does not stop the others, and Gitardo says so once they are done. With the command preview on, the question says the patterns of what will be linked and copied, and from where.

On Windows, git deletes what is inside a junction when it removes a worktree: the folder it links to, in the folder you are in. So before **Remove…** and **Gitardo: Clean Up Branches** remove a worktree, Gitardo takes out of it the links to folders outside it, among the files git does not track, each said in the log as `unlink <path>`. A worktree with such links, made by VS Code or by Gitardo, is to be removed from Gitardo, or after deleting the links, not with `git worktree remove` in a terminal.

#### A format for the names

With a format for branch names set (see [A format for branch names](#a-format-for-branch-names)), creating a worktree first asks whether to use it, which is where the picker starts, or to type a branch name; on a branch, whether to use the format for a new branch from it or to put the branch itself in the worktree. The name the format makes is that of the branch and of the worktree's folder, and is shown, and can be changed, before the worktree is created.

Once it is created, Gitardo offers to open it:

- **Open in Agents Window** opens the Agents window of VS Code on the worktree, so that the agent sessions started there work in it, on its branch. It is offered when this VS Code has the Agents window, which works only with its chat agents turned on. Gitardo opens it with a command of VS Code that is not part of its documented API: if it is missing or fails, the worktree opens in a new window instead, and Gitardo says why.
- **Open in New Window** opens it as the folder of a VS Code window of its own.

Each worktree in the Worktrees section says how it stands: its branch, with ↑ and ↓ for the commits it has that its upstream has not and the other way round, a pencil with the number of files not committed in it, and its open pull request. Its tooltip says the same in words. The files are counted with `git status` in each worktree, without taking the lock of its index, when the views are read again: what changes in a worktree that is open elsewhere shows here at the next refresh. A branch that another worktree has shows the same count.

A double click on a worktree opens it where `gitardo.worktrees.openIn` says: a new window (`window`, the default) or the Agents window (`agents`).

The same are in the context menu of a worktree, with **Open in terminal**, **Reveal in File Explorer** (**Reveal in Finder** on macOS), and:

- **Rename…** gives the folder another name, with `git worktree move`: inside the folder where the worktrees go, its name is its path from there, slashes and all; anywhere else, the name of its folder where it is. It offers to rename its branch along with it with `git branch -m`. Git cannot move the main worktree, the folder the repository was created in, nor, on Windows, a folder that another program has open, such as another VS Code window or a terminal: close them first. The worktree open in this window is renamed from another one.
- **Remove…** asks whether to delete its branch too. The folder is removed with `git worktree remove`, which asks again with `--force` when it has changes that are not committed, and the branch with `git branch -d`, which keeps a branch that is not merged and says so.
- **Bring ignored files…** links and copies into it what new worktrees get (see [What git ignores, in a new worktree](#what-git-ignores-in-a-new-worktree)), leaving what it has already.

VS Code's own Git extension opens the worktrees of the repositories it has as repositories of its own, and keeps watching their folders, which on Windows can then be neither moved nor deleted. So before renaming or removing a worktree, or cleaning up branches with theirs, Gitardo has it close the ones it has open, each said in the log as `git.close <path>`. A folder can still be held for a moment after: a move that fails for it is tried again for a few seconds, and when `git worktree remove` could not delete the folder, which git no longer counts as a worktree by then, Gitardo deletes what is left of it, said as `delete <path>`, and goes on with the branch.

#### The branch of a worktree

Git checks a branch out in one worktree at a time, so a branch that another worktree has is worked on there. Gitardo treats it that way:

- It has the worktree's icon instead of the branch's, among the local branches and on its label in the graph, and its tooltip says which worktree has it.
- A double click on it opens its worktree, where `gitardo.worktrees.openIn` says, instead of trying to check it out.
- Its context menu starts with what opens the worktree: **Open worktree in Agents Window**, **Open worktree in new window**, **Open terminal in worktree** and **Reveal worktree in File Explorer**. **Check out** and **Delete**, which git refuses, are not there; **Rename worktree…**, **Remove worktree…** and **Remove worktree and delete branch…** are. What does not touch the branch's files, such as merging it into the current branch, comparing it or opening its pull request, is there as for any branch.
- Dragged onto a commit of the graph, it offers no rebase: that would have to happen in its worktree.

The branch of the main worktree, seen from another worktree, is the same, except that the main worktree can be neither renamed nor removed.

#### Another worktree in this window

**Show in Gitardo**, in the context menu of a worktree, and **Show worktree in Gitardo** in that of its branch, point the views of this window at it: the graph, the changes, the commits and the branches are its own, and what you do there, staging, committing, pulling or pushing, is done in it, without opening another window. A banner at the top of the Graph, Changes and Branches views says which worktree they show, with **Back to** the repository of the window; the repository picker lists it too. The folder of the window, which the views list as another worktree meanwhile, can be neither renamed nor removed from there. The choice is not remembered: the next time the window opens, the views show its own folder.

#### Working in worktrees only

**Open in worktree**, in the context menu of a branch that no worktree has, opens it in a worktree of its own, with nothing asked: the worktree is made in the folder of the worktrees, named after the branch, if it is not there yet, and opens where `gitardo.worktrees.openIn` says. On a remote branch, the worktree has the local branch of the same name, made to track the remote one if there is none.

With `gitardo.branches.openIn` set to `worktree`, that is what a double click on a branch does, and **Open in worktree** comes first in its menu: every branch is worked on in its own worktree, and the folder open in this window stays on its branch. `checkout`, the default, checks the branch out here.

**Gitardo: Switch Worktree…**, also in the **…** menu of the Branches view, lists the worktrees with their branches and how they stand, as the Worktrees section shows them, the one of this window last, and opens the one you pick where `gitardo.worktrees.openIn` says. Its last entry creates a worktree.

### Submodules

A repository with submodules has a **Submodules** section among the references, beside the graph and in the Branches view, with the submodules inside them indented under theirs. Each says, by an icon, where it stands against the commit the repository records for it in its last commit:

- a green check: it has that commit checked out;
- a yellow arrow up, with a number: it has that many commits after it, made in it or pulled into it;
- a yellow arrow down: it is that many commits behind it, as after a pull of the repository that moved it;
- both numbers when each has commits the other has not, and a warning when it does not have the recorded commit at all, which a fetch in it or an update brings;
- a grey sign when it is not initialized, its folder empty, and when it is added but not committed yet.

Beside it are the branch it has checked out, or `detached`, and the number of its files not committed. Hover it for its URL and the two commits.

Its context menu opens it in a new window (also by double-click), in a terminal, in the file manager or in the views of this window with **Show in Gitardo**; **Update to the recorded commit** checks that commit out in it, and in its own submodules theirs, with `git submodule update --init --recursive`, after saying what it would leave behind when it has commits on a detached HEAD or files not committed; **Stage `<commit>` as the recorded commit** stages the commit it has checked out, to commit it in the repository; **Update to the latest of `<branch>`** goes to the last commit of the branch it follows, with `--remote`; **Initialize** clones one that is not initialized. **Deinitialize…** empties its folder and keeps it in `.gitmodules`, after asking, and offers to force it when it has changes; **Remove…** deletes it from the repository with `git submodule deinit` and `git rm`, then deletes its clone in `.git/modules`, after a warning, and the removal is staged with `.gitmodules`, ready to commit.

The **+** on the title of the section, **Add submodule…** in the **…** menu of the graph while there are none, and **Gitardo: Add Submodule…** ask for the URL of a repository, the folder to clone it in, named after it unless you change it, and the branch it follows, if any: `git submodule add` clones it, and its own submodules too. Git does not clone a submodule from a folder on disk unless allowed, since a repository could point one at any folder of the computer: when it refuses, Gitardo offers to allow it for those commands only, with `-c protocol.file.allow=always`. **Synchronize URLs from .gitmodules** copies the URLs of `.gitmodules` to the submodules after they changed there.

Git leaves the submodules where they are on a checkout, so they no longer match the commit checked out. Gitardo updates them to the commits it records once the checkout is done, with `git submodule update --init --recursive`, which also clones the ones that commit adds and the ones inside them: after **Check out**, after creating a branch and checking it out, after **Create branch from stash…** and after undoing a checkout, when the repository has submodules before or after it. When Gitardo asks before the checkout, it shows that command too, and it asks anyway when a submodule has commits on a detached HEAD that no branch would have then; files not committed in a submodule are kept, or stop the update when they are in the way. The setting `gitardo.submodules.updateOnCheckout`, on by default, turns this off.

Gitardo follows what happens in the submodules: a commit or a checkout made in one, in its window or a terminal, updates its icon.

### Remotes

**Gitardo: Manage Remotes** lists the remotes with their URLs. Pick one to fetch it alone (`git fetch --prune <name>`), change its URL, rename it, copy its URL or remove it; or add a new one. Removing a remote always asks first: its remote-tracking branches go with it, and local branches that followed them lose their upstream, though nothing changes on the remote itself.

Fetch, pull and push in a repository without any remote offer to add one instead of failing.

### GitHub

When the main remote is on github.com, Gitardo shows the open pull request of each branch next to it in the references tree, colored by the result of its checks. The context menu of a branch opens its pull request, or GitHub's page to create one. After the first push of a branch Gitardo offers to create its pull request.

Pull requests are read with the GitHub account you signed in to in VS Code. Gitardo asks for it the first time you choose **Load pull requests from GitHub** (**Gitardo: Sign In to GitHub**), and never before. The token is only sent to `api.github.com`. Pull requests opened from forks are not shown.

### Changes

The **Gitardo Changes** view, shown with **Gitardo: Show Changes**:

- One list of the changed files, staged or not, each with a box: ticking it stages the file (`git add`), unticking it unstages it. A file with only some of its changes staged, from the diff editor (**Stage Selected Ranges**) or the [Flow Diff](#flow-diff), has its box half ticked, and ticking it stages the rest. The box on the header of the list stages or unstages everything at once, and is half ticked when some is staged.
- A staged rename unstages with both of its names, and is then listed as git sees it: the old name deleted, the new one untracked. Ticking both stages it as a rename again.
- Files in conflict are listed apart, above, with no box: **Mark as resolved** stages one. While some are there, the box of the list names the other files one by one, so that none of the conflicts is taken as resolved or forgotten.
- A file with edits not saved in an editor has the dot its tab has after its name, and **Save** on its row; **Save all** on the header saves all of them. One that git sees no change in yet, because only its editor has changed it, is in the list too, with its box greyed out until it is saved, and **Compare with the saved file** shows what saving would change. Files of submodules, of worktrees inside the repository and that git ignores are left out.
- Clicking a file opens it, or its diff when `gitardo.changes.openOnClick` is set to `diff`. The buttons on its row open either one: **Open File**, and **Open Changes**, its diff as the list of changes of VS Code opens it: the index against the file on disk while some of it is not staged, `HEAD` against the index once all of it is. A deleted file opens its diff. The setting only changes this view, not the list of changes of VS Code.
- Those diffs are served by VS Code's Git extension when it has the repository open, so that its own commands work in them: **Stage Selected Ranges**, **Unstage Selected Ranges** and **Revert Selected Ranges** in the context menu, and the buttons on the changes in the gutter. Without it, Gitardo serves the same versions, and those commands do nothing there.
- The button on the header of the list shows the files under their directories, which open and close, or one after the other. The view remembers the choice. The next button opens all the diffs in one editor.
- **Discard changes** on a file takes it back to the last commit, staged changes included, and deletes it when it is untracked, after a warning. **Discard all changes** on the header does the same with all of them.
- Commit, or amend the last commit. Committing with nothing staged offers to stage everything first.
- The sparkle button drafts the commit message with a language model available in VS Code, such as GitHub Copilot. It sends the model the staged changes, or all changes when nothing is staged, cut to 20,000 characters, and the subjects of the last commits as an example of style. Nothing is sent until you press it, and the draft is yours to edit.
- Stash all changes, untracked files included; a single file, with the stash button on its row; or only what is staged, with the button on the header shown while something is (`git stash push --staged`, Git 2.35 or later).
- The list of changes of VS Code, in the Source Control view, gets the same three buttons: on each file, on **Staged Changes** and on **Changes**. They are in the context menus there too, where several selected files are stashed together, and they work in the repository of the file, which Gitardo then shows. The setting `gitardo.scm.stashButtons` takes them away.
- Below the commit box is the name and email the commit will be made with. Click it to switch identity.
- A list of more than 300 files shows the first 300 and a **Show all** link, here and in the details of a commit or of a comparison. The counts and the buttons on the header still speak for the whole list.

### Flow Diff

Another way to look at the diff of a file, beside the diff editor of VS Code. The **Open in Flow Diff** button (⇄) in the title of a diff editor opens the same diff in its place, and the same button in the Flow Diff goes back to the diff editor. It works on the diffs Gitardo opens and on those of the Source Control view of VS Code: a file against `HEAD`, the index or a commit, the index against `HEAD`, a commit against its parent. Nothing opens in it unless you ask.

- The two versions side by side in two editors with the colors of your theme and your `editor.*` settings, kept level by blank filler lines, and a band in the gutter between them joining each change to where it lands: green where lines were added, red where they were removed, blue where they changed. Within a changed line, the words that changed are marked.
- The two sides scroll together: line for line through what did not change, and through a long change the shorter side stays in the middle of the screen.
- The gutter is also the line between the two sides: drag it to make one wider, and double-click it to make them even again. The Flow Diff keeps the widths it was left with.
- `F7` and `Shift`+`F7`, or the arrows of the toolbar, go from one change to the next, with how many there are. Past the last one, `F7` again goes on to the next changed file. Long runs of unchanged lines fold into a bar that unfolds them, keeping 3 lines around each change: the toolbar switches that for each diff, the setting `gitardo.flowDiff.collapseUnchanged` for the new ones.
- The buttons in the gutter, on each change: revert it in the file, stage it, or unstage it once it is staged. A change already in the index is drawn dimmed. Staging and unstaging run as Gitardo's operations, in its log and, with the preview on, shown first.
- The file can be edited where it is shown: what is typed goes into the file, unsaved until `Ctrl`+`S`. `F4` opens the file at the line of the cursor.
- The title has **Open File**, the previous and next change, and **Stage File**, **Unstage File** and **Discard Changes** where they apply.

### Flow Merge

The same way to look at a file in conflict, in three columns: what the current side has, the result, and what the incoming side has. The **Open in Flow Merge** button (⇄) in the title of the merge editor opens the file in its place, and the same button in the Flow Merge goes back to the merge editor. **Gitardo: Open in Flow Merge** opens the file of the editor in front. Nothing opens in it unless you ask: a click on a file in conflict still opens the merge editor.

- Each side shows what it changed of the common ancestor, and a band in the gutter joins each of those changes to where it is in the result: green for the current side, blue for the incoming one, grey for a change both sides made the same way, red for a conflict. Within a changed line, the words that changed are marked.
- The result is the file as git wrote it, with what is typed in its editor: the markers of git are marked, and the two parts of a conflict between them are joined to the side each comes from. A conflict resolved in the file is drawn faintly.
- The three columns scroll together, and each gutter can be dragged to make the column on one side of it wider than the other, as in the Flow Diff; a double click on it makes them all even again. `F7` and `Shift`+`F7`, or the arrows over the result, go from one change to the next; beside them is how many conflicts are left. `F4` opens the file at the line of the result the cursor stands for.
- As it opens, the merge editor of VS Code writes its own start of the result in the file without saving it, where the conflicts show the base and the markers are gone. Going to the Flow Merge undoes that, so that the result is the file git wrote; if something was chosen or typed in the merge editor since, it asks first.
- The buttons on a band put a side in place of its region in the result: → takes the current side and ← the incoming one, and on a conflict + takes both, the side of the band first. A button shows only where it would change what the result has. `Ctrl`+`Z` in the result takes a choice back.
- The button with two ticks over the result accepts at once what needs no choice: each change of one side, and each conflict git marked where the two sides wrote the same lines, where the result does not have it already. `Ctrl`+`Z` takes all of it back.
- What the [rules](#conflicts-that-need-no-choice) or the [AI](#resolving-conflicts-with-ai) propose for a conflict still marked is a ✦ button on the band of its current side, whose tooltip gives the reason, and the sparkle over the result accepts all of it at once. `Ctrl`+`Z` takes it back.
- The clock button shows the base, what the two sides started from, in a column at the left of the current side, joined to it by bands. The Flow Merge remembers whether it is shown.
- **Mark as Resolved**, at the bottom of the result as in the merge editor, saves the file and stages it, which tells git that its conflicts are resolved, and closes the Flow Merge. With markers of git still in the file, it asks first.
- The result can be edited as the file is: what is chosen or typed goes into the file and is not saved until `Ctrl`+`S`, in the Flow Merge or in any editor of the file. Closing the Flow Merge with changes not saved shows the file in an editor, so that they are not forgotten. The merge editor of VS Code saves the file as it opens it.

### Identities

**Gitardo: Switch Identity** sets the name and email used for commits in the current repository, with `git config user.name` and `git config user.email`. Choose among the profiles listed in the `gitardo.identities` setting, type a new one, or go back to your global identity:

```json
"gitardo.identities": [
  { "name": "Ada Lovelace", "email": "ada@work.example", "signingKey": "ABCD1234" },
  { "name": "Ada", "email": "ada@home.example" }
]
```

`signingKey` is optional. Switching to a profile without one removes the key the repository had, so that commits are not signed as someone else.

### Multiple repositories

Gitardo shows one repository at a time. It finds the repository of each workspace folder, the repositories directly inside a folder, and their submodules. When there is more than one, a list at the start of the toolbar and at the top of the Changes view switches between them, as does **Gitardo: Select Repository**, and the header of the Commits view names the one that is shown. The choice is remembered per workspace. **Show File History** switches to the repository of the file on its own.

### Conflicts

When a merge, rebase, cherry-pick or revert stops, the Graph and Changes views show a banner with **Continue**, **Skip** and **Abort**. The banner also shows while files are in conflict without such an operation, as after a stash that did not apply cleanly. Conflicting files are listed in the Changes view, and **Mark as resolved** stages one.

Selecting a conflicting file opens it in VS Code's merge editor, with the common ancestor as the base and the two sides labelled by what they are in the operation that stopped: in a rebase, **Current** is what you are rebasing onto and **Incoming** is your own commit. Save the result there, then mark the file as resolved. A file that was added or deleted on one side has no three versions to merge, and opens as a normal file instead. The merge editor is opened through the command VS Code's own Git extension uses, which is not part of the documented API: if a future version changes it, the file opens in the normal editor with its conflict markers.

#### Conflicts that need no choice

> **Experimental.** This is still being tested, and it is off until you turn on `gitardo.conflicts.autoResolve` in the settings, where it carries the **Experimental** mark. While it is off Gitardo does not look into the files in conflict, and nothing of what follows is offered. Look at what it wrote before you commit.

Git stops wherever the two sides changed lines that touch. Many of those stops need no choice between the sides, and Gitardo can resolve them: the banner says how many (**Resolve 2 of 3 automatically**), a file in conflict has the same button on its row in the Changes view, **Gitardo: Resolve Conflicts Automatically** does it from the command palette, and the message that says an operation stopped offers it. The buttons of the banner and of a file open the [review of the resolutions](#the-review-of-the-resolutions), where each one is looked at before it is written. A conflict is resolved when it is one of these:

- **Changes to lines next to each other.** One side changed a line and the other the line after it, or one added or removed lines beside the ones the other changed. Each change is kept where it was made.
- **The same change on both sides**, such as a line both added among lines each changed in its own way. It is written once.
- **Spaces or line endings only.** The two sides have the same lines spaced differently: indented with tabs on one and with spaces on the other, with spaces left at the end of a line, or with other line endings. The current side is written. When one side only touched the spaces at the end of lines the other really changed, the real change is written. A space that parts one word in two is not such a difference: `a=1` and `a = 1` stay a conflict.
- **A change on one side only**, where the other turns out to have the lines as they were.

Everything else is left exactly as git marked it: two different changes to the same line, a line one side removed and the other changed, lines both added at the same place, two conflicts with nothing certain between them, a conflict with markers of its own inside. Every line Gitardo writes is a line of one of the two sides, as it is in the file: it never makes one up. What the lines were before either side changed them is read from the index (`git show :1:<file>`), so the style of the markers does not matter. Binary files, files one side deleted, files larger than 2 MB and files that are not UTF-8 are not touched.

It is also cautious where a file can be read in more than one way. Lines that repeat, such as closing braces and empty lines, can be paired with the ones of the common ancestor in several ways, and git made its choice without saying which. A conflict is resolved only when pairing them from the top and from the bottom gives the same lines, when no new line would end up written twice, when the changes of the two sides do touch as they must have for git to stop, and when the lines around the conflict are lines both sides really have (`git show :2:<file>` and `:3:<file>`). The tests run this against git itself on files made mostly of such lines, and it resolves there nothing that git's own account of the conflict would not.

From the command palette and from the message that says an operation stopped, Gitardo asks before it writes anything, saying for each file how many of its conflicts it would resolve and why, which files it would write and which command it would run. **Review** opens the review of the resolutions instead, where they can be taken one by one. Then the files are written: the ones left without conflicts are staged with `git add`, and the ones that still have some keep the markers of those and stay unstaged, to be finished in the merge editor. What was typed in a file since git stopped is kept, though a conflict right beside lines changed by hand is left alone, and nothing is written if a file changed between the question and the answer.

**Undo**, in the message that follows and in the toolbar, marks every conflict again as git had (`git checkout --merge`), in the files that were staged too.

#### The review of the resolutions

A tab, **Conflicts · \<repository\>**, with every conflict of the files in conflict, one card each: the lines of the current side and of the incoming one, in the colors of the code, the base on demand, and under them what is proposed for it, with the lines around it as they are in the file. **Gitardo: Review the Resolutions of the Conflicts** opens it from the command palette.

- Each proposal says where it comes from: **Rules** for the conflicts that need no choice, with the reason, and **AI** for what the language model wrote, with how sure it said it is and how many of its lines neither side has.
- **Accept** on a card takes that resolution, **Accept the file** takes those of a file, and **Accept all proposed** takes all of them. **Clear** takes the acceptances back. Nothing is written until **Write N resolutions**.
- **Show the result** opens each file beside what the accepted resolutions make of it, in the diff editor.
- **Columns**, beside **Cards** at the top, shows each conflict in three columns as the Flow Merge does: the current side, what is proposed and the incoming side, each with the lines the proposal takes the place of. A band joins each line proposed to the side it comes from, green for the current side and blue for the incoming one; the lines of a side left out are faded, and a line neither side has is marked. The choice is kept with the tab. In a narrow tab the columns stand one above the other.
- **Resolve by hand** opens the conflict in the Flow Merge, and the button beside it in the merge editor of VS Code. The line number opens the file at the conflict.
- Writing is one operation: the files are written, the ones left with no conflict are staged with `git add`, and the log has a `write <file>` line for each, with how many conflicts were resolved and by whom. Nothing is written if a file changed since the review read it. Then a report takes the place of the buttons: how many conflicts were resolved in how many files, how many of them by the AI, how many files were staged and what is left, with **Undo**, which marks the conflicts again as git had, and **Continue** once no file is left in conflict.
- The tab follows the files: a conflict resolved elsewhere leaves it, and a file edited by hand is read again.

#### Resolving conflicts with AI

> **Experimental.** This is off until you turn on `gitardo.conflicts.ai` in the settings. It needs a language model in VS Code, such as GitHub Copilot.

What the rules leave, a language model can propose. **Resolve with AI** in the banner, the sparkle on the row of a file in the Changes view, **Gitardo: Resolve Conflicts with AI** in the command palette and the message that says an operation stopped open the review and ask the model about each conflict that has nothing proposed. In the review, **Ask the AI about the rest** does the same, and **Ask the AI** on a card asks about that one, or again.

- Gitardo sends the model one conflict per question, two questions at a time: the lines of each side, the base when git wrote it, 40 lines before and after it, the name of the file, and what each side is with the subject of its commit. The model is told that other conflicts in those lines are resolved apart. Nothing is sent until you ask, and never a conflict the rules resolve.
- The model is the first one VS Code has, unless you choose one: **Gitardo: Choose the Model That Resolves Conflicts**, or the button with its name in the review, lists the models of VS Code, such as those GitHub Copilot offers, and then asks how much the model thinks before it answers: as it is set up in VS Code, or low, medium, high, extra high or max. More is slower, and often better on hard conflicts; a model without such a setting ignores it. The choices are kept in `gitardo.conflicts.aiModel` and `gitardo.conflicts.aiEffort`, and each proposal of the AI names the model that wrote it. When the model chosen is no longer there, asking says so rather than asking another.
- Small models often write the lines around the conflict again with their answer. Where those lines are as they were sent, Gitardo keeps only what stands in place of the conflict; when nothing is left, the card says the model did not resolve it.
- While the model thinks, the card shows it waiting, then the lines of its answer as they come; a bar over the page counts the conflicts answered, with **Stop**. When it cannot answer, as with no model available, the card says why and offers to ask again.
- An answer becomes a proposal like those of the rules, to accept or not. A model can write lines that neither side has, and can be wrong: the card counts the new lines, and the log says how many resolutions came from the AI. Look at each one before you accept it.
- The answers are kept until VS Code is closed, for as long as nobody edits their conflict, and also after **Undo**.

#### A whole file from one side

In the Changes view a file in conflict also has **Take the current side** and **Take the incoming side**, for when one side is simply right: `git checkout --ours` or `--theirs` followed by `git add`, or `git rm` when that side deleted the file. Gitardo asks first and says what each side is in the operation that stopped. Undo marks the conflicts again, except in a file one side deleted, which git cannot mark again.

## Command preview

Gitardo runs the `git` executable found on your `PATH`, and every command that changes the repository or a remote is written to the **Gitardo** output channel (**Gitardo: Show Command Log**).

Set `gitardo.commandPreview` to `all` to see the exact commands before they run and approve them:

| Value | Behavior |
| --- | --- |
| `off` (default) | Only asks before commands that can lose work or rewrite history: force push, hard reset, discarding changes, applying, popping or dropping a stash, deleting a branch or a tag, deleting a remote branch, removing a remote, removing a worktree, aborting an operation, undo, interactive rebase, fixup, branch cleanup, a merge or cherry-pick that is going to conflict, resolving conflicts automatically (when that is turned on) and taking one side of a file in conflict. |
| `all` | Shows the commands and asks before running anything that changes the repository or a remote, staging included. |

The commands shown are the commands that run: Gitardo adds no hidden flags to them. Where a command would open an editor for a commit message, which cannot work from an extension, the flag that prevents it is part of the command you see (`--no-edit`, or `-c core.editor=true` when continuing an operation).

For the same reason, two things that look odd in a command are there on purpose:

- A file whose name is also a pattern to git (it contains `[`, `]`, `*`, `?` or `\`, or starts with `:`) is passed as `:(literal)<name>`. Without it, staging or discarding `pages/[id].tsx` would also act on `pages/i.tsx` and `pages/d.tsx`.
- A branch that shares its name with a tag or with a remote branch is named in full, as `refs/heads/<name>`, where the short name would mean the other one or be refused: merging it, starting a branch from it, pushing it.

A few operations do more than run commands:

- Resolving conflicts automatically or with AI, which are experimental and off by default, writes the files itself, and then runs `git add`. The confirmation lists the files before the command, and the log has a `write <file>` line for each.
- Creating a worktree, when `gitardo.worktrees.linkFolders` and `gitardo.worktrees.copyFiles`, or VS Code's `git.worktreeSymlinkFolders` and `git.worktreeIncludeFiles`, ask for something, links and copies it after `git worktree add`, with a `symlink <folder>` or `copy <path>` line in the log for each (see [What git ignores, in a new worktree](#what-git-ignores-in-a-new-worktree)). **Bring ignored files…** does the same in a worktree that is there already, and runs no git command that changes anything.
- Renaming or removing a worktree first has VS Code's Git extension close it, when it has it open, with a `git.close <path>` line. On Windows, removing one also takes out of it the links to folders outside it, with an `unlink <path>` line for each, and when Windows held the folder so that git could not delete it, deletes what is left, with a `delete <path>` line (see [Worktrees](#worktrees)).

Two operations pass data that does not fit on a command line, and the confirmation shows it next to the command:

- Staging or unstaging a change in the Flow Diff runs `git apply --cached` with a patch on standard input.
- An interactive rebase runs `git rebase -i` with `sequence.editor` set to copy a prepared todo list from a temporary file. A reworded commit is a `pick` followed by `exec git commit --amend -F <file>`. A fixup uses the todo list git prepares itself, with `sequence.editor=true` to accept it unchanged.

Gitardo needs Git 2.40 or later for the conflict previews; without it the previews are skipped and everything else works. Read-only queries (`git log`, `git status` and similar) never ask; they are logged at the debug level.

## Development

```bash
npm install
npm run build
```

Press `F5` in VS Code to launch an Extension Development Host with Gitardo loaded.

| Script | Purpose |
| --- | --- |
| `npm run build` | Bundles the extension, the webview and the preview server into `dist/`. |
| `npm run watch` | Rebuilds on change. |
| `npm run typecheck` | Type-checks with `tsc`. |
| `npm test` | Runs the tests with Vitest. The integration tests run the real commands against throwaway repositories, and resolve conflicts marked by git itself, hundreds of them made at random. |
| `npm run test:e2e` | Builds, then runs the end-to-end tests inside a real VS Code: see below. |
| `npm run test:ui` | Builds, then uses the extension in a real VS Code window, with real clicks and keys, saving screenshots: see below. |
| `npm run package` | Makes a minified build and packs it into `gitardo-<version>.vsix`. It leaves the minified build in `dist/`; `npm run build` brings the development one back. |
| `npm run test:vsix` | Packages, then runs the end-to-end tests on what the `.vsix` contains instead of on this folder. |
| `npm run preview -- <folder>...` | Serves the webview at `http://localhost:5174` against the repositories found in the folders, read-only, to work on the UI without an Extension Host. Add `?view=changes`, `commits`, `branches` or `stashes` for a view of the side bar, `?view=worktreeSetup` for the tab that chooses what new worktrees get, `?view=commit&commit=<revision>` for the tab of a commit, `?view=compare&from=<revision>&to=<revision>` for the tab of a comparison, and `?theme=light` for the light theme, and `--port=<number>` before the folders to serve a second one beside it. |

### End-to-end tests

`npm run test:e2e` starts the VS Code installed on the machine as a separate instance, with a throwaway profile and a throwaway workspace holding two small repositories and a bare remote, and runs `test/e2e/suite.ts` inside its Extension Host. Your own VS Code window, settings and extensions are not touched; a second window opens for about half a minute and closes by itself. Pass the path of the executable as an argument, or set `VSCODE_PATH`, if it is not in a standard place.

The suite drives the extension through its commands and its controller, with VS Code's dialogs, input boxes and pickers answered by stubs that record what they were asked. It checks, among other things, that the webviews of all five views load, that only the views that list commits are sent them, that a comparison goes to the view that asked for it, that a commit is reached by its hash wherever it is in the history, that a commit opens in one editor tab with its changes and stays of its repository when the others move on, that the graph is narrowed to the branches chosen and remembers them for each repository, that the branches checked out last are listed and the favorites of each repository remembered, that every line of a file is given the commit that changed it last and what is typed is not committed, that the commit of a line opens in a tab and the file opens as it was before it with the blame it had then, that every file shows its blame when that is asked but for the ones it is hidden in, that a pull sets aside the changes that are not committed and says when they do not fit on what came in, that the views follow changes made outside the editor, that the commands shown in a confirmation are the ones that run and the ones logged, that diffs and the merge editor open with the right content, that nothing about resolving conflicts automatically is offered or run until its setting is on, that with it on the conflicts that need no choice are proposed in the review and resolved, the others left marked, and all of them marked again by Undo, and that with a language model standing in for a real one its answers show as they come, are written only when accepted, and are offered in the Flow Merge too.

`npm run test:vsix` runs the same suite on the packaged extension: the `.vsix` is unpacked into the throwaway folder and loaded from there, which catches a file left out of the package or broken by minification.

What that suite cannot see is what only eyes and hands can: how the views look, the blame annotations, drag and drop, the context menus of the webviews, and the real dialogs, which VS Code refuses to show while it runs tests. That is what the next one is for.

### Using it like a person

`npm run test:ui` starts the same throwaway VS Code, this time not in test mode, and drives its window through the DevTools protocol (`test/e2e/ui.mjs`): real clicks and right-clicks at the coordinates of what is on screen, real keystrokes, the real command palette, input boxes, pickers and confirmation dialogs. It checks that:

- the graph shows in the panel with its icons, the colors of the theme and each label in the color of its line;
- it follows the theme, and the buttons of the toolbar have a shape against the panel in each of five: the two dark and the two light ones VS Code comes with, and the high contrast one. Dark themes tend to outline their buttons and light ones to fill them, and a button drawn for one kind is words on the background in the other;
- the toolbar still names the branch and fits when the panel is 1050 and 800 pixels wide;
- the button beside Pull lists the four ways to pull;
- the views of Gitardo are in the Source Control side bar under those of VS Code, folded, with no icon of their own in the activity bar;
- the Changes view of Gitardo is hidden until it is asked for, and lists what changed;
- a file is staged by ticking its box, stays in the one list with the box of the list half ticked, and is committed with a typed message;
- the context menu of a commit stays inside the view with every entry in sight, and creates a branch through the real prompts;
- with the command preview on, the dialog shows the exact command, and Cancel runs nothing;
- the line under the cursor is annotated with who changed it;
- the button of the editor puts beside each line who changed it and when, in one column, with a bar in the color of its age and the lines of the commit under the cursor standing out, and takes it away again; the buttons beside it change state when pressed, and the file opens as it was before the commit of a line, with its own blame;
- with word wrap on, a line too long for the editor is folded inside it with the blame beside it;
- the search counts the commits it finds and steps through them with the keys and the arrows, goes to a commit by its hash even when no branch reaches it, highlights in the graph what git finds in the whole history or lists it alone, and counts a commit made meanwhile;
- the branches shown in the graph are chosen from the list under the button, with one click or one by one, with the box that narrows the list, and from the context menu of a branch; the graph of the side bar has the same button;
- a branch dragged onto the checked out commit offers to merge or rebase;
- the references and the details get wider when the line beside them is dragged, and a double click undoes it;
- a graph of twenty branches side by side keeps to its width by drawing them closer, gets narrower and wider when its edge is dragged, and a double click undoes it;
- the Commits view of the side bar lists the commits of the branch and not those of the others, says which are pushed and how many are left to push, unfolds one to its files, and has its menu and the buttons of its header;
- the graph of the side bar lists the commits on two lines each, with their labels named, the details under them, and its header has the buttons;
- the Branches view compares two branches from its context menu, and a branch with a revision typed in the real picker and input box, which refuses one git does not know; that comparison opens in a tab with the sides, how far apart they are, the commits only on one side and, once asked for, the diffs, compared from where they diverged and then directly, and the one in the view opens in a tab from its button;
- the Stashes view unfolds a stash to its files, and its header counts the stashes;
- the graph opens as an editor tab, with the details of a commit beside it;
- the details keep a message of many lines to five that scroll, list the files with their directories or as a tree that folds, and in a narrow panel are sized by dragging the line over them;
- the references list the favorites and the branches checked out last first, only the branches the graph is narrowed to, and are put away and brought back by the button of the toolbar; the button of the status bar opens the graph in a tab;
- a double click on a commit opens it in an editor tab with its whole message, its files as a tree that folds or as a list, the lines each gained and lost, and, once asked for, their diffs numbered line by line; a click on a file opens its diff in the diff editor; the button in the details opens another the same way, and **Show in the graph** leads back;
- a merge that stops offers nothing more than usual while `gitardo.conflicts.autoResolve` is off, the Settings editor marks that setting as experimental, and once it is on the merge counts in its banner the conflicts that need no choice, opens the review of what the rules propose, writes what is accepted there and stages the file left without conflicts, reports it, and marks them all again from **Undo** in the report;
- a click on a file of the Changes view opens the file and the button of its row its diff, which goes to the Flow Diff and back with the button of its title, its gutter dragged moves the line between the two sides and a double click puts it back, a change staged there leaves it, the file's box in the Changes view is then half ticked, and ticking it stages the rest;
- a file in conflict opens in the merge editor, goes to the Flow Merge with the button of its title, which shows the three columns with their bands, the markers of git and the conflicts left, goes from change to change, takes the incoming side of the conflict from the button of its band without saving it, takes it back with `Ctrl`+`Z`, shows the base in a fourth column, gives the result more width when a gutter is dragged, asks before marking as resolved a file that still has markers, and goes back to the merge editor.

A screenshot of each step is saved to `dist/ui`, or to the folder given with `--out=<folder>`: looking at them is half the point. Errors thrown or logged inside the webviews are printed at the end. The window is sized through the protocol, so the screenshots do not depend on the screen.

Signing in to GitHub, drafting a commit message and asking a real model how to resolve a conflict need an account and a language model, and are not exercised by any of these.

### Large repositories

Three scripts in `test/perf` show how Gitardo behaves when there is a lot of everything. None of them is a test: they print numbers to read.

```bash
node test/perf/big-repo.mjs ../big 50000 2000
git -C ../big pack-refs --all
git -C ../big commit-graph write --reachable
node dist/perf.js ../big
node test/perf/vscode.mjs ../big
```

- `big-repo.mjs <folder> [commits on main] [changed files]` makes a repository with `git fast-import`: a long main line with side branches merged back into it, 250 branches never merged, 2,000 tags, remote branches, and a working tree with that many changed and untracked files. The two git commands after it leave the references and the history the way `git gc` or `git maintenance` leave them in a repository that is looked after; without them git itself takes about three times as long to list the commits.
- `dist/perf.js <repository>` times what Gitardo reads: the state at 1,000, 5,000 and 20,000 commits, the details of a commit, the working tree, each kind of search, the history of a file, blame.
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
| `src/webview` | The React UI, and in `src/webview/highlight` the colors of the code in the changes of a commit or a comparison, loaded only when they are shown. |
| `src/flow` | The Flow Diff: the side-by-side diff in Monaco, its worker and its own webview. |
| `src/dev` | The browser preview server. |
| `test` | Unit and integration tests, and `test/e2e` with the end-to-end suite, the run that uses the window, and the scripts that launch VS Code for them; `test/perf` with the scripts for large repositories. |

## License

Gitardo is released under the [MIT license](LICENSE). Its package includes the [Codicons](https://github.com/microsoft/vscode-codicons) font of Microsoft, under CC BY 4.0, and [React](https://react.dev), under the MIT license.
