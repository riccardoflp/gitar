import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { discoverRepos, repoName } from '../git/discover';
import { parseGitHubRemote } from '../git/github';
import { samePath } from '../git/parse';
import type { Conflict } from '../git/conflicts';
import { CONFLICT_SIDES } from '../git/ops';
import { Repo } from '../git/repo';
import { fingerprint, reviewFiles, type Answer } from '../git/review';
import { previewSetup, scanIgnored } from '../git/worktreeSetup';
import { addressed, languageMap, readFileIconTheme } from '../extension/fileIconTheme';
import { GRAPH_COLUMNS, WORKTREE, type CompareMode, type Filter, type HostMessage, type Scope, type ViewKind, type WebviewMessage } from '../shared/protocol';
import type { Asking } from '../shared/resolution';
import { cleanPatterns, type SetupLayer, type SetupSource } from '../shared/worktreeSetup';

// Usage: node dist/dev-server.js [--port=5174] [--icon-theme=<file>] [folder...]   (every repository found in the folders can be chosen in the page)
// Read-only: actions that would change the repository or open an editor are only logged.

const PAGE_SIZE = 1000;
const options = process.argv.slice(2).filter((argument) => argument.startsWith('--'));
const port = Number(options.find((option) => option.startsWith('--port='))?.slice(7) ?? process.env.PORT ?? 5174);
const assets = __dirname;

/** Where VS Code keeps its own extensions, in the places it is installed in: newer versions on Windows in a folder of their own. */
function builtInExtensions(): string | undefined {
  const windows = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code');
  const versions = fs.existsSync(windows) ? fs.readdirSync(windows).map((name) => path.join(windows, name)) : [];
  const apps = [windows, ...versions, '/usr/share/code'].map((folder) => path.join(folder, 'resources', 'app'));
  apps.push('/Applications/Visual Studio Code.app/Contents/Resources/app');
  return apps.map((app) => path.join(app, 'extensions')).find((folder) => fs.existsSync(path.join(folder, 'theme-seti')));
}

/**
 * The file icon theme of the preview: the one given with `--icon-theme=` (its JSON file, or `none`), else Seti, the
 * theme VS Code starts with, from where VS Code is installed. Its files are served from the folder of its extension.
 */
const extensions = builtInExtensions();
const iconThemeOption = options.find((option) => option.startsWith('--icon-theme='))?.slice(13);
const iconThemeFile =
  iconThemeOption === 'none'
    ? undefined
    : iconThemeOption
      ? path.resolve(iconThemeOption)
      : extensions && path.join(extensions, 'theme-seti', 'icons', 'vs-seti-icon-theme.json');
const iconThemeRoot = iconThemeFile && extensionFolder(iconThemeFile);

/** The folder of the extension a file is in: the nearest with a manifest, else the file's own. */
function extensionFolder(file: string): string {
  for (let folder = path.dirname(file); folder !== path.dirname(folder); folder = path.dirname(folder)) {
    if (fs.existsSync(path.join(folder, 'package.json'))) return folder;
  }
  return path.dirname(file);
}

/** The languages of the extensions of VS Code, for the icons a theme gives a language. */
const languages = languageMap(
  (extensions ? fs.readdirSync(extensions) : []).flatMap((name) => {
    try {
      return [JSON.parse(fs.readFileSync(path.join(extensions!, name, 'package.json'), 'utf8'))];
    } catch {
      return [];
    }
  }),
);

const THEMES = {
  dark: {
    foreground: '#cccccc',
    background: '#181818',
    description: '#9d9d9d',
    border: '#2b2b2b',
    hover: '#2a2d2e',
    selection: '#04395e',
    inactiveSelection: '#37373d',
    button: '#313131',
    buttonHover: '#3c3c3c',
    input: '#313131',
    badge: '#616161',
    menu: '#1f1f1f',
    link: '#4daafc',
  },
  light: {
    foreground: '#3b3b3b',
    background: '#f8f8f8',
    description: '#717171',
    border: '#e5e5e5',
    hover: '#f2f2f2',
    selection: '#e8e8e8',
    inactiveSelection: '#e4e6f1',
    button: '#e5e5e5',
    buttonHover: '#cccccc',
    input: '#ffffff',
    badge: '#cccccc',
    menu: '#ffffff',
    link: '#005fb8',
  },
};

const VIEWS: ViewKind[] = ['graph', 'changes', 'commits', 'sideGraph', 'branches', 'stashes', 'commit', 'compare', 'worktreeSetup', 'conflicts'];

/** How long the language model the preview pretends to ask waits for its turn, and then writes. */
const PRETEND_WAIT = 1500;
const PRETEND_WRITE = 6000;
/** What the preview calls the language model it pretends. */
const PRETEND_MODEL = 'A pretended model';

/** `data` is what the extension would write on the page: the view it is, and for a commit which one. */
function page(theme: keyof typeof THEMES, data: Record<string, string>): string {
  const attributes = Object.entries(data).map(([name, value]) => `data-${name}="${value.replace(/[&<>"]/g, '')}"`).join(' ');
  const t = THEMES[theme];
  const dark = theme === 'dark';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gitardo preview</title>
<style>
:root {
  --vscode-font-family: "Segoe UI", system-ui, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Consolas, monospace;
  --vscode-foreground: ${t.foreground};
  --vscode-descriptionForeground: ${t.description};
  --vscode-panel-border: ${t.border};
  --vscode-focusBorder: #0078d4;
  --vscode-progressBar-background: #0078d4;
  --vscode-list-hoverBackground: ${t.hover};
  --vscode-list-activeSelectionBackground: ${t.selection};
  --vscode-list-activeSelectionForeground: ${dark ? '#ffffff' : '#000000'};
  --vscode-list-inactiveSelectionBackground: ${t.inactiveSelection};
  --vscode-button-secondaryBackground: ${t.button};
  --vscode-button-secondaryForeground: ${t.foreground};
  --vscode-button-secondaryHoverBackground: ${t.buttonHover};
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #026ec1;
  --vscode-errorForeground: ${dark ? '#f85149' : '#c72e0f'};
  --vscode-editor-background: ${dark ? '#1f1f1f' : '#ffffff'};
  --vscode-editorWidget-background: ${dark ? '#202020' : '#f3f3f3'};
  --vscode-testing-iconPassed: ${dark ? '#73c991' : '#388a34'};
  --vscode-testing-iconFailed: ${dark ? '#f14c4c' : '#e51400'};
  --vscode-testing-iconQueued: ${dark ? '#cca700' : '#bf8803'};
  --vscode-diffEditor-insertedLineBackground: ${dark ? '#9bb95533' : '#9ccc2c40'};
  --vscode-diffEditor-removedLineBackground: ${dark ? '#ff000033' : '#ff000033'};
  --vscode-editorLineNumber-foreground: ${dark ? '#6e7681' : '#6e7681'};
  --vscode-editorGroupHeader-tabsBackground: ${dark ? '#181818' : '#f8f8f8'};
  --vscode-list-dropBackground: ${dark ? '#383b3d' : '#d6ebff'};
  --vscode-inputValidation-warningBackground: ${dark ? '#352a05' : '#f6f5d2'};
  --vscode-inputValidation-warningBorder: #b89500;
  --vscode-toolbar-hoverBackground: ${t.hover};
  --vscode-input-background: ${t.input};
  --vscode-input-foreground: ${t.foreground};
  --vscode-input-placeholderForeground: ${t.description};
  --vscode-badge-background: ${t.badge};
  --vscode-badge-foreground: ${dark ? '#f8f8f8' : '#3b3b3b'};
  --vscode-menu-background: ${t.menu};
  --vscode-menu-foreground: ${t.foreground};
  --vscode-menu-selectionBackground: #0078d4;
  --vscode-menu-selectionForeground: #ffffff;
  --vscode-textLink-foreground: ${t.link};
  --vscode-gitDecoration-addedResourceForeground: ${dark ? '#81b88b' : '#587c0c'};
  --vscode-gitDecoration-modifiedResourceForeground: ${dark ? '#e2c08d' : '#895503'};
  --vscode-gitDecoration-deletedResourceForeground: ${dark ? '#c74e39' : '#ad0707'};
  --vscode-gitDecoration-renamedResourceForeground: ${dark ? '#73c991' : '#007100'};
  --vscode-gitDecoration-untrackedResourceForeground: ${dark ? '#73c991' : '#007100'};
  --vscode-gitDecoration-conflictingResourceForeground: ${dark ? '#e4676b' : '#ad0707'};
}
body { background: ${t.background}; }
</style>
<link href="/webview.css" rel="stylesheet">
</head>
<body class="vscode-${theme}" ${attributes}>
<div id="root"></div>
<script>
window.acquireVsCodeApi = () => ({
  async postMessage(message) {
    const response = await fetch('/message?theme=${theme}', { method: 'POST', body: JSON.stringify(message) });
    for (const reply of await response.json()) window.postMessage(reply, '*');
  },
  getState: () => JSON.parse(sessionStorage.getItem('gitardo') || 'null'),
  // Hands the state back, as the one of VS Code does.
  setState: (state) => (sessionStorage.setItem('gitardo', JSON.stringify(state)), state),
});
</script>
<script src="/webview.js"></script>
</body>
</html>`;
}

async function main() {
  const given = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
  const folders = (given.length ? given : ['.']).map((folder) => path.resolve(folder));
  const roots = await discoverRepos(folders);
  const repos = roots.map((root) => ({ root, name: repoName(root, folders) }));
  let repo = roots.length ? new Repo(roots[0]) : null;
  let limit = PAGE_SIZE;
  let filter: Filter | null = null;
  let scope: Scope | null = null;
  /** What `gitardo.branches.followGraphFilter` and the settings of the graph would say, kept while the server runs. */
  let branchesFollowScope = true;
  let showStashes = true;
  let traceSelected = true;
  let firstParent = false;
  let graphColumns = GRAPH_COLUMNS;
  /** Kept while the server runs, for each repository. */
  const favorites = new Map<string, string[]>();
  /** The worktrees of the repository shown, which the views can be pointed at, and the repository to go back to. */
  let worktrees: string[] = [];
  let home: (typeof repos)[number] | null = null;
  const inRoots = (dir: string) => roots.find((root) => samePath(root, dir));
  /** The settings of new worktrees, kept while the server runs, as the page saves them. */
  const setup: { user: SetupLayer; workspace: SetupLayer } = { user: {}, workspace: {} };
  /** The two sides of the tab of a comparison, as `from=` and `to=` name them, once the page of one was asked for. */
  let compared: { from: string; to: string; mode: CompareMode; path: string | null } | null = null;
  /** Whether the page is the review of the conflicts, which is sent the review when it is ready. */
  let reviewing = false;
  /**
   * When each conflict was asked about, by file and fingerprint. There is no language model here: the preview pretends,
   * and answers a little more each time the page asks for the review again.
   */
  const pretended = new Map<string, number>();

  async function review(): Promise<HostMessage[]> {
    if (!repo) return [{ type: 'review', review: null, error: 'No repository.' }];
    const conflicted = await repo.conflicted();
    const plans = await repo.conflictPlans(conflicted);
    const operation = await repo.operation().catch(() => null);
    const [oursLabel, theirsLabel] = CONFLICT_SIDES[operation ?? 'none'];
    const sides = new Map(plans.flatMap((plan) => plan.conflicts.map((conflict): [string, Conflict] => [`${plan.path}\0${fingerprint(plan.text, conflict)}`, conflict])));
    const now = Date.now();
    const pretend = (id: string) => {
      const conflict = sides.get(id);
      return conflict && `${conflict.ours}${conflict.theirs}`;
    };
    const asked = {
      answer: (file: string, print: string): Answer | undefined => {
        const id = `${file}\0${print}`;
        const at = pretended.get(id);
        const text = pretend(id);
        if (at === undefined || text === undefined || now - at < PRETEND_WAIT + PRETEND_WRITE) return undefined;
        return { text, reason: 'The preview has no language model: it puts the two sides one after the other.', confidence: 'low', model: PRETEND_MODEL };
      },
      asking: (file: string, print: string): Asking | undefined => {
        const id = `${file}\0${print}`;
        const at = pretended.get(id);
        const text = pretend(id) ?? '';
        if (at === undefined) return undefined;
        if (now - at < PRETEND_WAIT) return { state: 'waiting' };
        return { state: 'thinking', text: text.slice(0, Math.floor((text.length * (now - at - PRETEND_WAIT)) / PRETEND_WRITE)) };
      },
    };
    const files = reviewFiles(plans, true, asked);
    const busy = files.some((file) => file.conflicts.some((conflict) => conflict.asking && conflict.asking.state !== 'failed'));
    const others = conflicted.filter((file) => !plans.some((plan) => plan.path === file));
    const shown = { root: repo.root, operation, oursLabel, theirsLabel, files, others, rules: true, ai: true, asking: busy, model: PRETEND_MODEL, report: null, conflicted: conflicted.length };
    return [{ type: 'review', review: shown }];
  }

  async function comparison(): Promise<HostMessage[]> {
    if (!repo || !compared) return [];
    const side = async (name: string) => {
      if (name === WORKTREE) return { name: 'Working tree', hash: WORKTREE, live: true };
      const hash = await repo!.resolve(name);
      return hash && { name: hash.startsWith(name) ? hash.slice(0, 7) : name, hash, live: !hash.startsWith(name) };
    };
    const [from, to] = await Promise.all([side(compared.from), side(compared.to)]);
    if (!from || !to) return [{ type: 'compareView', view: null, error: 'Git does not know these.' }];
    const found = await repo.compareSides(from.hash, to.hash, compared.mode, compared.path);
    if (!found) return [{ type: 'compareView', view: null }];
    const patch = await repo.comparePatch(found.files, found.since, to.hash, 20_000, compared.path);
    return [
      { type: 'compareView', view: { from, to, mode: compared.mode, ...found } },
      { type: 'comparePatch', since: found.since, to: to.hash, patch },
    ];
  }

  async function worktreeSetup(): Promise<HostMessage[]> {
    if (!repo) return [{ type: 'worktreeSetup', info: null, error: 'No repository.' }];
    const one = (kind: 'link' | 'copy'): [string[], SetupSource] =>
      setup.workspace[kind] ? [setup.workspace[kind]!, 'workspace'] : setup.user[kind] ? [setup.user[kind]!, 'user'] : [[], 'none'];
    const [link, linkFrom] = one('link');
    const [copy, copyFrom] = one('copy');
    const others = (await repo.state(1)).worktrees.filter((worktree) => !worktree.prunable && !samePath(worktree.path, repo!.root)).length;
    const info = {
      root: repo.root,
      entries: await scanIgnored(repo.root),
      user: setup.user,
      workspace: { ...setup.workspace, name: path.basename(repo.root), file: path.join(repo.root, '.vscode', 'settings.json') },
      vscode: { link: [], copy: [] },
      effective: { link, copy, linkFrom, copyFrom },
      worktrees: others,
    };
    return [{ type: 'worktreeSetup', info }];
  }

  async function state(): Promise<HostMessage[]> {
    if (!repo) return [{ type: 'state', state: null }];
    const github = parseGitHubRemote(await repo.remoteUrl('origin'));
    repo.firstParent = firstParent;
    const read = await repo.state(limit, filter, scope, true, showStashes);
    scope = read.scope;
    worktrees = read.worktrees.filter((worktree) => !worktree.prunable).map((worktree) => worktree.path);
    const away = inRoots(read.root) ? null : home;
    return [{ type: 'state', state: { ...read, favorites: favorites.get(read.root) ?? [], defaultPull: 'pullRebaseAutostash', repos, github, agentsWindow: true, worktreesRoot: null, openBranches: 'checkout', branchesFollowScope, traceSelected, graphColumns, resolveWithAI: true, home: away } }];
  }

  /** `light` for a page in the light theme, which can have other file icons. */
  async function handle(message: WebviewMessage, light: boolean): Promise<HostMessage[]> {
    switch (message.type) {
      case 'selectRepo': {
        const root = inRoots(message.root) ?? worktrees.find((dir) => samePath(dir, message.root));
        if (!root) return [];
        const shown = repo && inRoots(repo.root);
        if (shown) home = repos.find((each) => each.root === shown) ?? home;
        repo = new Repo(root);
        filter = null;
        scope = null;
        limit = PAGE_SIZE;
        return state();
      }
      case 'setFilter':
        filter = message.filter;
        limit = PAGE_SIZE;
        return state();
      case 'setScope':
        scope = message.scope;
        limit = PAGE_SIZE;
        return state();
      case 'setBranchesFollowScope':
        branchesFollowScope = message.follow === true;
        return state();
      case 'setShowStashes':
        showStashes = message.show === true;
        return state();
      case 'setGraphColumns':
        graphColumns = GRAPH_COLUMNS.filter((column) => message.columns.includes(column));
        return state();
      case 'setFirstParent':
        firstParent = message.only === true;
        return state();
      case 'setTraceSelected':
        traceSelected = message.trace === true;
        return state();
      case 'setFavorite': {
        if (!repo) return [];
        const others = (favorites.get(repo.root) ?? []).filter((ref) => ref !== message.ref);
        favorites.set(repo.root, message.favorite ? [...others, message.ref] : others);
        return state();
      }
      case 'loadMore':
        limit += PAGE_SIZE;
        return state();
      case 'focus':
        return [];
      // No editors here: nothing is ever unsaved.
      case 'save':
      case 'compareWithSaved':
        return [];
      case 'ready':
        return [...(await state()), ...(await comparison()), ...(reviewing ? await review() : [])];
      case 'getReview':
        return review();
      case 'askAI': {
        const [shown] = await review();
        const files = shown.type === 'review' ? (shown.review?.files ?? []) : [];
        for (const file of files) {
          for (const conflict of file.conflicts) {
            const wanted = message.conflicts ? message.conflicts.some((ref) => ref.path === file.path && ref.key === conflict.key) : !conflict.proposal;
            if (wanted && conflict.proposal?.source !== 'rules') pretended.set(`${file.path}\0${conflict.key.slice(conflict.key.indexOf(':') + 1)}`, Date.now());
          }
        }
        return review();
      }
      case 'stopAsking':
        pretended.clear();
        return review();
      case 'chooseConflictModel':
        // The preview has no language model to choose.
        return [];
      case 'refresh':
        return state();
      case 'swapCompare':
        if (compared) compared = { ...compared, from: compared.to, to: compared.from };
        return comparison();
      case 'setCompareMode':
        if (compared) compared = { ...compared, mode: message.mode };
        return comparison();
      case 'setComparePath':
        if (compared) compared = { ...compared, path: message.path };
        return comparison();
      case 'getLog': {
        const log = await repo?.branchLog(message.limit);
        return log ? [{ type: 'log', log }] : [];
      }
      case 'getComparison': {
        const comparison = await repo?.compare(message.from, message.to);
        return comparison ? [{ type: 'comparison', comparison }] : [];
      }
      case 'show':
        return [{ type: 'reveal', hash: message.hash }];
      case 'trace':
        // A page of the preview is one view: there is no graph beside the branches to bring the history out in.
        return [];
      case 'goTo': {
        const hash = await repo?.resolve(message.revision);
        if (!repo || !hash) return [];
        const shown = filter;
        const among = scope;
        let index = await repo.position(hash, shown, among);
        if (index < 0 && shown) {
          filter = null;
          index = await repo.position(hash, null, among);
        }
        if (index < 0 && among) {
          scope = null;
          index = await repo.position(hash);
        }
        if (index < 0) {
          filter = { kind: 'ref', ref: hash, lost: true };
          index = 0;
        }
        limit = Math.max(filter === shown && scope === among ? limit : PAGE_SIZE, (Math.floor(index / PAGE_SIZE) + 1) * PAGE_SIZE);
        return [...(await state()), { type: 'reveal', hash }];
      }
      case 'find': {
        const { search } = message;
        const found = await repo?.matches(search, filter && 'query' in filter ? null : filter, 5000, scope).catch(() => null);
        return [{ type: 'found', search, ...(found ?? { hashes: [], more: false, failed: true }) }];
      }
      case 'getDetail':
        return [{ type: 'detail', hash: message.hash, detail: (await repo?.commitDetail(message.hash)) ?? null }];
      case 'getPatch': {
        const detail = await repo?.commitDetail(message.hash);
        return [{ type: 'patch', hash: message.hash, patch: (detail && (await repo?.commitPatch(detail, 20_000))) ?? null }];
      }
      case 'getWorktreeSetup':
        return worktreeSetup();
      case 'previewWorktreeSetup': {
        if (!repo) return [];
        const patterns = { link: cleanPatterns(message.patterns.link), copy: cleanPatterns(message.patterns.copy) };
        return [{ type: 'worktreeSetupPreview', patterns: message.patterns, preview: await previewSetup(repo.root, patterns) }];
      }
      // No theme of VS Code here: the page takes the colors of Dark+ or Light+.
      case 'syntaxTheme':
        return [{ type: 'syntaxTheme', theme: null }];
      case 'fileIcons': {
        if (!iconThemeFile || !iconThemeRoot) return [{ type: 'fileIcons', theme: null }];
        const theme = await readFileIconTheme(iconThemeFile, light ? 'light' : 'dark');
        const address = (file: string) => `/icon-theme/${path.relative(iconThemeRoot, file).split(path.sep).map(encodeURIComponent).join('/')}`;
        return [{ type: 'fileIcons', theme: addressed(theme, languages, address) }];
      }
      case 'saveWorktreeSetup':
        setup[message.target] = message.patterns ? { link: cleanPatterns(message.patterns.link), copy: cleanPatterns(message.patterns.copy) } : {};
        return worktreeSetup();
      default:
        console.log('not available in the preview:', JSON.stringify(message));
        return [];
    }
  }

  const types: Record<string, string> = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  };

  http
    .createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      try {
        if (request.method === 'POST' && url.pathname === '/message') {
          let body = '';
          for await (const chunk of request) body += chunk;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(await handle(JSON.parse(body), url.searchParams.get('theme') === 'light')));
        } else if (url.pathname === '/') {
          response.setHeader('Content-Type', 'text/html');
          const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark';
          const view = VIEWS.find((candidate) => candidate === url.searchParams.get('view')) ?? 'graph';
          reviewing = view === 'conflicts';
          // The tab of a commit: of the one asked for with `commit=`, or of the last.
          const commit = view === 'commit' ? await repo?.resolve(url.searchParams.get('commit') ?? 'HEAD') : null;
          const files = url.searchParams.get('files') === 'list' ? 'list' : 'tree';
          // The tab of a comparison: of `from=` and `to=`, the branch checked out and the one before it when not given.
          if (view === 'compare' && repo) {
            const mode = url.searchParams.get('mode') === 'direct' ? 'direct' : 'diverged';
            compared = { from: url.searchParams.get('from') ?? 'HEAD~1', to: url.searchParams.get('to') ?? 'HEAD', mode, path: url.searchParams.get('path') };
            response.end(page(theme, { view, root: repo.root, files }));
          } else response.end(page(theme, commit && repo ? { view, commit, root: repo.root, files } : { view }));
        } else if (url.pathname.startsWith('/icon-theme/') && iconThemeRoot) {
          // The files of the file icon theme, never out of its extension.
          const parts = url.pathname.slice(12).split('/').map(decodeURIComponent);
          const file = path.join(iconThemeRoot, ...parts.filter((part) => part && part !== '..'));
          if (!file.startsWith(iconThemeRoot + path.sep)) throw new Error(`Not a file of the icon theme: ${url.pathname}`);
          response.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
          response.end(fs.readFileSync(file));
        } else {
          // In folders too, such as the script that colors code and its chunks: never out of the build.
          const file = path.join(assets, ...url.pathname.split('/').filter((part) => part && part !== '..'));
          response.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
          response.end(fs.readFileSync(file));
        }
      } catch (error) {
        response.statusCode = 500;
        response.end(String(error));
      }
    })
    .listen(port, '127.0.0.1', () => console.log(`Gitardo preview of ${roots.join(', ') || 'no repository'} on http://localhost:${port}`));
}

void main();
