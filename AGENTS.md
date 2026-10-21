# Working on Gitardo

Gitardo is a VS Code extension: a commit graph, history and everyday Git operations, in the bottom panel, in views of the
Source Control side bar and in editor tabs. This file is for whoever changes its code, person or agent. What Gitardo
does for its users is in [README.md](README.md); keep the two apart.

## Ground rules

- Everything in the repository is in English: code, comments, UI text, README, CHANGELOG, commit messages.
- Commit only when asked. When several pieces of work are waiting, make one commit for each, not one for all of them.
  Never push or publish: the maintainer publishes on the Marketplace by hand.
- Gitardo has had other names. Do not write them anywhere, except where the 0.2.0 entry of the CHANGELOG explains the
  change of name.
- A change a user can see goes into the README, where the feature is described, and into the **Unreleased** section of
  the CHANGELOG, in the same commit.
- An idea beyond what was asked is proposed first, not built.

## Commands

```bash
npm install
npm run build        # dist/: the extension, the webviews, the Flow Diff, the preview server, the e2e suite
npm run typecheck    # tsc, over src and test
npm test             # Vitest: unit tests and integration tests against throwaway repositories
npm run test:e2e     # builds, then runs test/e2e/suite.ts inside a real VS Code
npm run test:ui      # builds, then drives a real VS Code window with clicks and keys; screenshots in dist/ui
npm run preview -- <folder>...   # the webviews in a browser, against the repositories in the folders
npm run package      # a minified build packed into gitardo-<version>.vsix
```

`F5` in VS Code launches an Extension Development Host (`.vscode/launch.json`).

When this checkout has worktrees of its own under `.claude/worktrees`, a bare `npm test` also collects their tests. Run
`npx vitest run --exclude '.claude/**' --exclude '**/node_modules/**'` instead.

## How it is built

| Path | What is there |
| --- | --- |
| `src/git` | Git itself, with no VS Code in it: running it (`exec.ts`), reading a repository (`repo.ts`), parsing what git prints (`parse.ts`), the commands of each operation (`ops.ts`), the conflicts that need no choice (`conflicts.ts`), what is proposed for each conflict (`review.ts`), what new worktrees get (`worktreeSetup.ts`), GitHub URLs. |
| `src/shared` | What the extension and the webviews both use: the messages between them (`protocol.ts`), the lanes of the graph, the tree of files, how references and messages are named and shown. |
| `src/extension` | VS Code: activation and commands (`extension.ts`), the `Controller` that owns the state and every webview (`controller.ts`), what an action asks the user and which operation it becomes (`actions.ts`), blame, the content of the diffs (`content.ts`), what is running in the status bar (`activity.ts`), GitHub sign-in, the language model. |
| `src/webview` | The React UI of every view and tab, in one bundle. `main.tsx` picks the component from the `data-view` the host writes on the page. |
| `src/webview/highlight` | The colors of the code in the changes of a commit or a comparison, with shiki: a bundle of its own, imported only when changes are shown. |
| `src/flow` | The Flow Diff, a side-by-side diff in Monaco that the diff editor switches to: host side, a worker that computes the diffs, and its own webview under `src/flow/webview`. |
| `src/dev` | The preview server: the webviews in a browser, against a real repository, read-only. |
| `test` | Vitest tests; `test/flow` for the Flow Diff; `test/e2e` for the suite inside VS Code and the window driver; `test/perf` for large repositories. |

`esbuild.mjs` makes every bundle. The webview bundle is a classic script (`dist/webview.js`); the Flow Diff and the
highlighting are ES modules split in chunks, so that the grammars and themes of shiki load only when a file needs them.
Every new file the extension needs at run time must also be let into the package in `.vscodeignore`.

### From a click to git

1. The webview posts a `WebviewMessage` (`src/shared/protocol.ts`). An operation on the repository is
   `{ type: 'action', action }`, posted by `act()` in `src/webview/menus.ts`.
2. `Controller.onMessage` handles it. An action goes through `resolveAction` in `src/extension/actions.ts`, which asks
   what it needs (names, choices) and returns a `GitOp`, built in `src/git/ops.ts`.
3. `Controller.run` runs the `GitOp`: it shows the exact commands first when `gitardo.commandPreview` asks for that or
   when the operation can lose work (`danger`, `confirm`), logs each command to the **Gitardo** output channel, and keeps
   what **Undo** needs.
4. The repository is read again and a `HostMessage` of type `state` goes to the views. Only the views that show the
   graph are sent its commits (`showsGraph`).

Anything that changes the repository is a `GitOp`, also what Gitardo does itself rather than git (`writes`, `prepare`,
`finish`): that is how it gets the preview, the log and Undo. The Flow Diff runs its index writes through
`Controller.runIn` for the same reason. Reads go through `Repo` and never take locks (`exec.ts`).

The reads of the repository and the operations show in the status bar while they run, through the `Activity` of the
controller (`activity.ts`). Anything else the user may wait for, such as a comparison or a request to GitHub, goes
through `activity.track` too, so that the status bar and **Gitardo: Show What Is Running** say what it is.

### Adding to the UI

- A new message is a case in `HostMessage` or `WebviewMessage`, a case in `Controller.onMessage`, and, for the
  preview, a case in `handle` of `src/dev/server.ts`, which logs the messages it does not know.
- A new view kind is a `ViewKind`, an entry in `VIEWS` of `src/webview/main.tsx`, and its registration in
  `extension.ts` or its tab in the controller.
- The webviews use VS Code's CSS variables and the Codicons (`<Icon name="…" />`); `src/webview/styles.css` is the one
  stylesheet. Check a change in a dark and a light theme.
- The pages of a commit and of a comparison share `FileChanges`: a change there is a change to both.
- State that a view should keep while it is hidden goes through `loadUiState` and `saveUiState` in
  `src/webview/vscode.ts`. Never return what `setState` of VS Code returns from an effect: it crashes the page.

## How the code is written

- Comments are sentences in plain words. They say what a thing is or why it is so, from what the user sees, not how
  the code does it: `/** The commits of what is checked out, for the view that asked. */`. Read the comments around a
  change and write the same way.
- Names are words, not abbreviations: `entry`, `listed`, `shown`, not `e`, `lst`, `vis`.
- UI text is short, plain and in sentence case, and says what will happen: **Show the changes**, **Open in the diff
  editor**, **Take the version of main into the working tree**. A tooltip finishes the thought of its button.
- A commit message is one sentence that says what changed for the user, in the imperative, with no prefix:
  `Show progress while switching repository, comparing again, and loading more of the Commits view`.
- Code is laid out as Prettier lays it out with a width of 160: single quotes, semicolons, trailing commas, two
  spaces. Comments wrap at about 120 columns. There is no formatter in the project: match the file you are in.
- Files use LF line endings. On Windows, check `git ls-files --eol` after a script rewrote a file.

## Checking a change

From cheapest to most real; pick the one that can see what changed.

1. `npm run typecheck` and `npm test` for anything in `src/git` or `src/shared`. Integration tests make real
   repositories in a temporary folder: add one when an operation changes.
2. The preview, for anything a webview shows: `node dist/dev-server.js --port=<n> <folder>` and open
   `http://localhost:<n>/?view=<kind>`. Views: `graph`, `changes`, `commits`, `sideGraph`, `branches`, `stashes`,
   `worktreeSetup`, `commit&commit=<revision>`, `compare&from=<revision>&to=<revision>`. Add `&theme=light` for the
   light theme. The server serves the build it started with: rebuild and restart it after a change.
3. `npm run test:e2e`, for commands, the controller and what VS Code is asked. VS Code's dialogs are stubbed there.
4. `npm run test:ui`, for what only a real window shows: context menus, real dialogs, clicks at coordinates, the
   Content Security Policy of the webviews. Look at the screenshots in `dist/ui`, not only at the count.

Things learned the slow way:

- Measure rendering only on the minified build (`node esbuild.mjs --production`): React's development build is several
  times slower, in proportion to the rows. That build, and `npm run package`, leave `dist/` minified until the next
  `npm run build`.
- When the browser pane of a preview is hidden, `requestAnimationFrame` never fires and timers run once a second.
- `0 passed, 0 failed (VS Code exited with code 1)` from the e2e or UI run is usually a VS Code update waiting for a
  restart, not the code: VS Code then refuses new instances until it is restarted.
- On Windows, worktrees removed during the tests can be held by VS Code's own Git extension: see `closeInVSCodeGit` and
  `recoverHeldWorktree` in `src/extension/actions.ts`. Also on Windows, `git worktree remove` deletes what is behind a
  junction; Gitardo unlinks such links first (`unlinkFolderLinks`).
- Signing in to GitHub, the Agents window of VS Code and drafting a commit message need a signed-in account: no test
  can reach them. Never sign in on the user's behalf.
