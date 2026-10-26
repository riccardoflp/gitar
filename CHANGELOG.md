# Changelog

What changed in each version of Gitardo. The versions follow [Semantic Versioning](https://semver.org).

## Unreleased

### Added

- **Squash into one** in the bar above the graph and **Squash N commits into one…** in the context menu, for commits selected that follow one another before `HEAD`, and **Squash into the commit before it…** in the context menu of a commit: one commit with the changes of them all, under a subject you give and what their messages say. The commits after them are made again, and what is not committed is put back.
- **Compare with…** in the context menu of a file in the details of a commit, in the tab of a commit and in the tab of a comparison: the file as it is in that commit, as the second side of the comparison has it, or in the working tree for the changes not committed, beside the branch, tag, commit or working tree you choose, in the diff editor.

## 0.7.0 - 2026-10-22

### Added

- **Sort by name** and **Sort by date** in the **…** on the title of the Local, Remotes and Tags sections beside the graph and in the Branches view, or the setting `gitardo.branches.sortOrder`: branches, remote branches and tags by name, as before, or the one committed to last first, wherever they are listed. Not set, it is by name, or by date when you set VS Code's `git.branchSortOrder` to `committerdate`.
- **Fold the commits it merged into one row** in the context menu of a merge in the graph, on the arrow after its message and with `←` while it is selected: "3 commits of feature" in their place, which a click, the arrow or `→` opens again. **Fold all merges** and **Unfold all merges** in the **…** menu do it for every merge loaded.
- The names of the branches whose tips are scrolled out of the top of the graph, while their lines go on down it, stay at the top in the colors of their lines. A click goes back up to the tip.
- Marks beside the scroll bar of the graph for the commit checked out, the one selected and what a search found.
- A line in the graph before the first commit of yesterday, of this week, of last week and of each month before, with its name. **Separate the days, weeks and months** in the **…** menu of the toolbar, or the setting `gitardo.graph.dateSeparators`, takes them away.
- `Shift` held with the pointer on a label in the graph brings out only the commits that branch has and the one checked out has not: what merging it would bring.
- Keys to move around the graph: `Home` to the commit checked out, `Alt`+`↓` to the first parent of the commit selected and `Alt`+`↑` to the commit made on top of it, `Alt`+`Shift`+`↓` and `Alt`+`Shift`+`↑` to the next merge and the one before.
- **Show the author**, **Show the date** and **Show the hash** in the **…** menu of the toolbar of the graph, or the setting `gitardo.graph.columns`, switch each of them on and off beside the messages of the commits.
- **Show only the first parent of merges** in the **…** menu of the toolbar of the graph, or the setting `gitardo.graph.firstParent`: each branch along its own line, a merge as one commit without what it brought in.
- **Upstream** in the list of the branches shown in the graph: what is checked out and its upstream, to see what is ahead of it and what is behind. It follows you as you switch branch.
- The commit selected in the graph brings out its history, the commits it comes from and the ones made on top of it, and dims the rest, less than the pointer on a label does. **Bring out the history of the selected commit** in the **…** menu of the toolbar, or the setting `gitardo.graph.traceSelected`, switches it off.
- The label of a branch in the graph ends with the number of its open pull request on GitHub, in the color of its checks, once the pull requests are loaded. A click opens it.
- The commits of a local branch that its upstream does not have yet have a ring around their dot in the graph: what the next push of that branch sends.
- The pointer on the label of a branch, remote branch or tag in the graph, on a branch, tag, stash or worktree in the references beside it, or on a branch, tag or worktree in the Branches view of the side bar, brings out its history in the graph: the commits it reaches and their lines stay as they are, and the rest fades.
- **Show local branches**, **Show remote branches** and **Show tags** in the **…** menu of the toolbar switch each kind of reference on and off in the graph. The list of the branches shown has **Remotes** beside **Local**, for the remote branches alone. What is checked out stays in the graph either way.
- The stashes in the graph, each above the commit it was made on while that commit is shown: a square with no fill, a dashed line down to the commit, and a label with a dotted border. Their context menu applies, pops, drops them or makes a branch of them. **Show stashes** in the **…** menu of the toolbar, or the setting `gitardo.graph.showStashes`, takes them out.
- The references beside the graph and the Branches view can list every branch while the graph is narrowed, with the ones it leaves out dimmed and an eye on each that adds its history to the graph: **Filter the list of branches too** at the bottom of the list of the branches shown, the button on the line above the references, or the setting `gitardo.branches.followGraphFilter`.
- `gitardo.graph.pageSize`: how many commits the graph reads at a time, from 100 to 10,000, 1,000 by default.

### Changed

- The filter of the references beside the graph, of the Branches view and of the list of the branches shown in the graph lists the names that match best first: the name itself, then a remote branch of that name, then the names that start with it, then those with a part that does, then the rest.
- Scrolling down the graph no longer stops at the end of the commits loaded to wait for the next: they are read while there are still hundreds to scroll through. Only the commits that are new are sent to the graph, so the next ones come as quickly however far down it is.

### Fixed

- A context menu opened close to the right edge of a view, such as the one of **…**, could put the words beside an entry under it instead of on its line.

## 0.6.0 - 2026-10-22

### Added

- **Gitardo** with a spinning icon in the status bar while Gitardo reads a repository, runs an operation, compares two sides or asks GitHub for its pull requests. Its tooltip, a click on it and **Gitardo: Show What Is Running** say what each of those is, for how long it has run, what asked for a read, and how many times in a row the repository was read because something changed during each read.
- **Show in the graph** in the context menu of a branch, remote branch, tag or worktree, in the references tree and in the Branches view: it opens the graph at the commit, loading it when it is further back than the history is loaded, and showing all the branches again when the ones shown leave it out.

### Fixed

- A click on a branch or tag in the references tree of the graph did nothing when its commit was further back than the history was loaded. It now loads it and goes to it.
- In a large repository whose files keep changing, such as while it builds, the bar of the graph ran and the commits stayed dimmed for minutes after they were read. The wait is over as soon as the commits asked for are read; the reads that follow update the graph without it.
- With `core.fsmonitor` on and another worktree, Gitardo read the repository again and again: each read left a file of fsmonitor in the folder of git of that worktree, which it took for a change. Those files, and the locks git takes and lets go of, no longer ask for a read.

## 0.5.0 - 2026-10-21

### Added

- The columns of the Flow Diff and of the Flow Merge can be made wider or narrower by dragging the gutter between them, and even again by double-clicking it. The widths are kept with the page.
- The Flow Merge: a file in conflict in three columns, what the current side has, the result and what the incoming side has, with a band joining each change of a side to where it is in the result, in the color of what became of it: taken from one side, made the same way by both, or in conflict. The markers of git are marked in the result, and the parts of a conflict between them are joined to the side each comes from. The buttons on the bands take the current side, the incoming one, or both in either order, in place of a region of the result, and the result can be edited: what is chosen or typed goes into the file, unsaved until `Ctrl`+`S`. One button accepts at once the changes that need no choice, another shows the base in a fourth column, and **Mark as Resolved** saves the file and stages it, asking first when markers of git are left in it. The **Open in Flow Merge** button in the title of the merge editor opens it in its place, and its own button goes back; nothing opens in it otherwise.
- The graph shows that it is loading. While the commits of a filter or of the branches just chosen are read, a bar runs along the top of the list and the commits of before are dimmed. While the next commits are read, as the list is scrolled down, the bar runs too, and the row after the last commit says that more are loading. Switching to another repository shows the same bar while its commits are read.
- The tab of a comparison runs the same bar along its top, and dims the commits and files it showed, while the two are compared again after a side, the way to compare or the path changed. **Load more commits…** in the Commits view says that they are loading until they come.
- The file blame keeps saying whose the lines in sight are when the first line of their commit is scrolled out of sight: with `gitardo.fileBlame.groupLines` on, the first line in sight says it too.
- The code in the diffs of the tab of a commit and of a comparison is in the colors your theme gives it in the editor, or those of Dark+ and Light+ when the theme cannot be read. What colors it is loaded only once diffs are shown.
- Once the tab of a commit or of a comparison is scrolled down, a round button in its corner takes it back to the top.
- Files have the icon your file icon theme gives them in the Explorer: in the Changes view, the details of a commit, the Commits and Stashes views, the tabs of a commit and of a comparison with the headers of their diffs, the files a merge would conflict in, and the page of what new worktrees get. The directories of a tree have theirs too when the theme has icons for folders, without the arrow beside them when the theme hides it. With the theme set to **None**, files are listed as before.
- The review of the resolutions of the conflicts: a tab with every conflict beside what is proposed for it, to accept one by one, by file or all at once, to look at in the diff editor, or to resolve by hand in the Flow Merge or the merge editor. **Columns** shows each conflict in three columns, the current side, what is proposed and the incoming side, with bands joining each line proposed to the side it comes from. Nothing is written until **Write** is pressed; then a report says what was resolved and by whom, what was staged and what is left, with **Undo** and **Continue**. The buttons of the banner and of a file in the Changes view open it.
- Resolving conflicts with AI, experimental and off until `gitardo.conflicts.ai` is on: the language model of VS Code, such as GitHub Copilot, is asked about the conflicts the rules leave, and its answers come into the review as proposals, with the reason, how sure it is and the lines neither side has. The lines around the conflict that a model writes again with its answer are left out of the proposal. **Gitardo: Choose the Model That Resolves Conflicts**, also a button in the review, chooses the model among those of VS Code and how much it thinks, from low to max. Each card shows the model waiting, then its answer as it is written, and a bar counts the conflicts answered. **Resolve with AI** is in the banner, on the row of a file, in the command palette and in the message that says an operation stopped.
- The Flow Merge offers what the rules and the AI propose: a ✦ button on the band of a conflict, with the reason in its tooltip, and one over the result for all of them.
- The Changes view shows the files with edits not saved in an editor, with a dot after their names as on their tabs, and buttons to save one or all of them. The ones git sees no change in yet are in the list too, until they are saved, with a button to compare one with the file on disk.
- In the context menu of the Explorer, **Link into New Worktrees** on a folder and **Copy into New Worktrees** on a file or a folder add the pattern of its path to what new worktrees get, after asking git whether that gives it anything, and say why not when it does not: git tracks it, does not ignore it, or a pattern gives it that already. **Stop Linking into New Worktrees** and **Stop Copying into New Worktrees** take that pattern out again.

### Changed

- The tab that chooses what new worktrees get lists what git ignores in sections by kind: what Gitardo does not know first, then dependencies, settings and secrets, the editor's settings, build output, other worktrees and logs. Each section says what it is, how big and what its files get, and those where nothing is proposed or chosen start closed. What has the same name in several places, such as the `node_modules` of each package, is one line that chooses for all of them by the pattern of the name, and unfolds into each place.
- In the tab of a commit and of a comparison, a click on a file opens it in the diff editor, as it does everywhere else, rather than going to its changes in the page.
- The diffs of the files are in those tabs only once **Show the changes** is pressed, and **Hide the changes** takes them away. The eye on the row of a file shows them and goes to that file.
- Resolving the conflicts that need no choice from the command palette asks **Resolve** or **Review**, which opens the review, in place of the preview in the diff editor and the second question.
- The references beside the graph, in the panel and in an editor tab, start with their sections all closed when VS Code starts, as the Branches view does, and remember the ones opened since until VS Code is closed.

## 0.4.0 - 2026-10-19

### Changed

- The Changes view lists the files staged and not staged together, each once, with a box that stages it when ticked and unstages it when not. A file only partly staged has its box half ticked, and ticking it stages the rest; the box on the header of the list does the same for all of them. Files in conflict are still listed apart, above.
- Clicking a file in the Changes view opens the file. The new setting `gitardo.changes.openOnClick` makes it open its diff instead, as the list of changes of VS Code opens it: the index against the file while some of it is not staged, `HEAD` against the index once all of it is. The buttons **Open File** and **Open Changes** on its row open either one. Files no longer unfold into their hunks there: changes are staged one by one in the diff editor or in the Flow Diff.
- The Changes view shows its files under their directories, or one after the other, with the button on the header of the list.
- **Discard changes** on a file of the Changes view, and **Discard all changes** on its header, take back what is staged too, as in the graph, after a warning.
- On the page of what new worktrees get, **Link**, **Copy** and **Nothing** change only their own line, at once, without waiting for git to work out again what all the patterns take, which took seconds in a large checkout. Git is asked when the tab opens and with **Look again**; until then the tab says the patterns have changed.
- The sections of the Branches view are all closed when VS Code starts. The ones opened or closed since are remembered until VS Code is closed, also when the view is hidden and shown again. The references beside the graph remember theirs as before.

### Fixed

- **Stage Selected Ranges**, **Unstage Selected Ranges** and **Revert Selected Ranges** of VS Code did nothing in the diffs the Changes view opens: they only know the versions of a file that VS Code's Git extension serves. Those diffs now take them from it, when it has the repository open.
- Discarding all the changes of a file taken out of the index with `git rm --cached` and left on disk deleted it, as if it were untracked. It now goes back to the version of the last commit.

## 0.3.0 - 2026-10-16

### Added

- The worktrees Gitardo creates get what git ignores that the new settings `gitardo.worktrees.linkFolders` and `gitardo.worktrees.copyFiles` ask for, or, where they are not set, VS Code's experimental settings `git.worktreeSymlinkFolders` and `git.worktreeIncludeFiles` ask for, as the ones VS Code creates do: the folders that git ignores and that match are linked from the folder you are in, the files copied, each said in the log. On Windows, where the links are junctions and git would delete what is in them along with the worktree, Gitardo takes them out before removing a worktree.
- **Gitardo: Choose What New Worktrees Get…**, also in the new **…** of the Worktrees section: a tab that lists what git ignores, with its size, proposes what to link, what to copy and what to leave, and saves the patterns for the workspace folder or the user, where they can also be edited by hand or in settings.json. The first worktree created while nothing is set offers it once. **Bring ignored files…** gives worktrees that are there already what new ones get.
- Comparisons in a tab of their own. **Compare with…**, **Gitardo: Compare Branches, Tags or Commits…** and the compare buttons open a tab with the two sides, which a click chooses again and a button swaps; how many commits each has that the other has not and where they diverged; those commits, each side's apart, the ones whose change the other side has too, cherry-picked or rebased, marked; the files, as a tree or as a list with the lines each gained and lost; and the diff of each in the page. Two branches are compared from where they diverged, as a pull request shows them, and a button shows everything that differs instead. A side named by a branch follows it as it moves. The comparison in the details has **Open in a tab**.
- In the tab of a comparison: the working tree as a side, read again as the files change; what merging one side into the other would do, fast-forward, merge cleanly or conflict in the files named; a box that narrows it to a file or a folder; a button on each file that takes the other side's version into the working tree; **Copy as patch**; **Open on GitHub**. The comparisons opened last are offered first when one is asked for. **Compare with Branch, Tag or Commit…** in the context menu of the Explorer and of an editor tab compares a file or a folder as it is now with the branch, tag or commit chosen.
- The Flow Diff, from the Flow Diff extension: the diff of a file side by side in two editors, joined by bands that show where each change lands, with buttons to revert, stage and unstage each change, the file editable in place, and `F7` from one change to the next. The **Open in Flow Diff** button in the title of a diff editor opens the same diff in it, in place of the editor, and its own button goes back. Nothing opens in it unless asked.
- A **Submodules** section among the references, beside the graph and in the Branches view, when the repository has submodules, theirs included. An icon says where each stands against the commit recorded for it: a green check on it, a yellow arrow up or down with the number of commits it is ahead or behind, and its branch and files not committed are beside it. Its context menu opens it in a new window, a terminal or the views of this window, initializes it, updates it to the recorded commit or to the latest of its branch, stages the commit it is on as the recorded one, deinitializes and removes it, its clone in `.git/modules` included. The **+** of the section and **Gitardo: Add Submodule…** add one, and offer to allow cloning from a folder on disk when git refuses it.
- The submodules are updated to the commits recorded for them after a checkout, with `git submodule update --init --recursive`, which clones the ones the commit adds. The checkout asks first when that would leave commits in a submodule that no branch has. The setting `gitardo.submodules.updateOnCheckout` turns it off.
- The row of the uncommitted changes in the graph has a context menu: stash them, or the staged ones, stage or unstage them all, and discard them all, staged changes and untracked files included, after a warning. In the details it opens, each file can be stashed or have all its changes discarded, and files ticked are stashed or discarded together.
- **Edit message…** on a commit, and a pencil beside its message in the details: the whole message is edited in place, and saved with `Ctrl`+`Enter`. The last commit is amended without what is staged, an older one reworded by an interactive rebase that sets the changes not committed aside, after asking; a commit pushed already is said first.
- A question before applying or popping a stash, which says what it would stop on: the files that would be in conflict, worked out with `git merge-tree` without touching anything, the files not committed that make git refuse it, or an untracked file it took along that is there again.

### Changed

- The format for the names of new branches is offered by **Create branch…** too, not only by **Create Worktree**, and its settings are now `gitardo.branches.format` and `gitardo.branches.inputs`. `${base}` is the branch or the tag the branch is created at, the branch checked out from the toolbar, and at a commit the commit or a branch that has it. `gitardo.worktrees.branchFormat` and `gitardo.worktrees.inputs` are still read where the new settings are not set.
- Deleting a tag asks first, and so does deleting a branch whose commits are merged, into its upstream or into the current branch: it says that none is lost and that **Undo** brings it back. One that is not merged still warns that its commits would be lost.

### Fixed

- A commit reworded in the interactive rebase lost the body of its message: what is typed there is its new subject, and the body stays.
- Renaming or removing a worktree on Windows while VS Code's Git extension had it open failed, as the extension holds its folder. VS Code's Git now closes the worktree first, a folder held for a moment more is tried again, and when git has already let go of the worktree its folder is deleted by Gitardo.
- A cherry-pick of several commits no longer gets stuck when a conflict is resolved by keeping what the branch has, or when one of the commits is there already: git found nothing to commit and refused to continue, and **Continue** failed each time. That commit is now skipped, as a rebase does, said in the log, and the rest are picked.

## 0.2.0 - 2026-10-15

### Added

- Worktrees you name: the **+** on the Worktrees section and **Gitardo: Create Worktree…** ask for a name and a branch to start from, and make a new branch of that name in a folder of that name, slashes making folders in folders, in the folder that the new setting `gitardo.worktrees.folder` names (`${repo}.worktrees` next to the repository by default). **Create worktree…** on a branch or a commit asks for a name instead of a whole path.
- A branch that another worktree has checked out is shown as that worktree's, with its icon in the list and in the graph. A double click opens the worktree, where the new setting `gitardo.worktrees.openIn` says, and its context menu opens, renames and removes the worktree instead of offering to check out or delete the branch, which git refuses.
- **Open in worktree** on a branch: its worktree opens, made first in the folder of the worktrees and named after the branch when there is none, with nothing asked. On a remote branch, with a local branch that tracks it. The new setting `gitardo.branches.openIn`, set to `worktree`, makes it what a double click on a branch does.
- **Gitardo: Switch Worktree…** lists the worktrees and opens the one picked, or creates another.
- **Show in Gitardo** for a worktree and **Show worktree in Gitardo** for its branch: the views of this window show that worktree, its changes, commits and branches, to work in it from here. A banner says which, with the way back.
- How each worktree stands, in the Worktrees section and in **Switch Worktree…**: its branch against its upstream, the number of files not committed in it, read with `git status` in each worktree, and its pull request.
- A format for the names of the branches of new worktrees, `gitardo.worktrees.branchFormat`, such as `PRJ-${input:ticket}-${input:kind}-rfi-${base}`: the inputs that `gitardo.worktrees.inputs` defines are typed or picked from a list, `${base}` is the branch it starts from without its remote, or at a commit the commit or a branch that has it. Creating a worktree asks whether to use the format, which comes first, or a branch name.
- **Open in Agents Window** for a worktree, once it is created and in its context menu: VS Code's Agents window opens on it, so that agent sessions work in it. Where VS Code has no Agents window it is not offered, and if it fails to open the worktree opens in a new window.
- **Rename…**, **Open in terminal** and **Reveal in File Explorer** in the context menu of a worktree. Renaming moves its folder with `git worktree move` and can rename its branch too; **Remove…** can delete its branch along with it.
- **Gitardo: Clean Up Branches** lists the merged branches and the ones whose upstream is gone that another worktree has, and removes the worktree with the branch. One with files not committed is left unticked, and if ticked is removed with `--force` after a warning.
- **Fast-forward to `<upstream>`** in the context menu of a local branch that is not checked out: it fetches the upstream and moves the branch up to it, without leaving the branch you are on. Git only does it when the branch has no commits of its own.

### Changed

- Gitar is now Gitardo, with an identifier of its own: `RiccardoFilippozzi.gitardo`. On the Marketplace it is another extension, so the one named Gitar is to be uninstalled and this one installed. Its commands and settings are named after it too, `gitardo.*` where they were `gitar.*`: the settings saved under the old names are to be set again.
- A double click on the label of a branch in the graph checks the branch out, as a double click does where the branches are listed, instead of opening its commit; on a remote branch, it checks it out in a local branch. Elsewhere on the row it still opens the commit.
- Checking out a remote branch when a local branch of its name is there already checks that one out, where git refused: fast-forwarded to the remote branch when it has no commits of its own. When each has commits the other has not, you choose between rebasing the local ones onto the remote branch and leaving the branch as it is; the context menu of the remote branch also has **Check out `<branch>` and rebase it onto this** then. When another worktree has that local branch, its worktree opens instead, where it is worked on, and the context menu of the remote branch opens it.

### Fixed

- The blame of a file beside its lines with word wrap on: the first part of a long line went past the edge of the editor, which folded the line without counting what is beside it. The room for it is now kept by an inlay hint, which the editor counts. With inlay hints switched off, in a font of their own or cut shorter than the room, it is drawn before the line as before.

## 0.1.0 - 2026-10-13

The first release.

### Views

- **Graph**, in the bottom panel or in an editor tab: the commit graph, the references beside it and the details of the selected commit.
- **Commits**, in the Source Control side bar: the commits of the branch that is checked out, each with whether it is pushed and the files it changed.
- **Gitardo Graph**, **Branches** and **Stashes**, in the side bar: the graph, the references and the stashes on their own, for when the panel is closed.
- **Gitardo Changes**, hidden until asked for: staging and committing by file, by hunk or by line.
- A commit in an editor tab of its own, with its whole message and what it changed in each file.
- A button in the status bar that opens the graph, wherever the workspace has a repository.

### History

- Search in the loaded commits, or in the whole history by message, author, added or removed text and regular expression.
- The graph narrowed to the branches you choose, to the history of a file, or to one branch, tag or commit.
- Comparison of any two branches, tags or commits, with the files that differ.
- The reflog, to find a commit no branch reaches any more.
- Blame of the line under the cursor, and of a whole file beside its lines, colored by age.

### Operations

- Checkout, branches, tags, worktrees, merge, rebase, cherry-pick of one or several commits, revert and reset, from context menus or by dragging a branch.
- Interactive rebase in an editor of its own: reorder, reword, squash, fixup and drop.
- Fixup of an earlier commit with the changes that are staged.
- Bisect from the graph.
- Undo of the last commit, amend, checkout, merge, pull, rebase or reset, read from the reflog.
- Fetch, pull and push, with the ways to pull and to force a push in a menu. The Pull button rebases and sets the changes that are not committed aside, unless its settings say otherwise.
- Stashes of everything, of one file or of what is staged, also from the list of changes of VS Code.
- Cleanup of the branches that are merged, and management of the remotes.

### Safety

- Every command that Gitardo runs is logged exactly as it was run, and can be shown before it runs.
- The operations that can lose work ask first, and say what would be lost.
- Conflicts open in the merge editor, with continue, skip and abort in a banner. Resolving the ones that need no choice is offered as an experiment, off by default.

### Also

- Several repositories in a workspace, nested ones and submodules included.
- Identities to switch between, for each repository.
- Pull requests of the branches of a GitHub repository, after signing in.
