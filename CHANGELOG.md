# Changelog

What changed in each version of Gitardo. The versions follow [Semantic Versioning](https://semver.org).

## 0.2.0

### Added

- **Fast-forward to `<upstream>`** in the context menu of a local branch that is not checked out: it fetches the upstream and moves the branch up to it, without leaving the branch you are on. Git only does it when the branch has no commits of its own.

### Changed

- Gitar is now Gitardo, with an identifier of its own: `RiccardoFilippozzi.gitardo`. On the Marketplace it is another extension, so the one named Gitar is to be uninstalled and this one installed. Its commands and settings are named after it too, `gitardo.*` where they were `gitar.*`: the settings saved under the old names are to be set again.

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
