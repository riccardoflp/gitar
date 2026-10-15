import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { discoverRepos, repoName } from '../git/discover';
import { parseGitHubRemote } from '../git/github';
import { samePath } from '../git/parse';
import { Repo } from '../git/repo';
import type { Filter, HostMessage, Scope, ViewKind, WebviewMessage } from '../shared/protocol';

// Usage: node dist/dev-server.js [--port=5174] [folder...]   (every repository found in the folders can be chosen in the page)
// Read-only: actions that would change the repository or open an editor are only logged.

const PAGE_SIZE = 1000;
const options = process.argv.slice(2).filter((argument) => argument.startsWith('--'));
const port = Number(options.find((option) => option.startsWith('--port='))?.slice(7) ?? process.env.PORT ?? 5174);
const assets = __dirname;

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

const VIEWS: ViewKind[] = ['graph', 'changes', 'commits', 'sideGraph', 'branches', 'stashes', 'commit'];

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
<body ${attributes}>
<div id="root"></div>
<script>
window.acquireVsCodeApi = () => ({
  async postMessage(message) {
    const response = await fetch('/message', { method: 'POST', body: JSON.stringify(message) });
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
  /** Kept while the server runs, for each repository. */
  const favorites = new Map<string, string[]>();
  /** The worktrees of the repository shown, which the views can be pointed at, and the repository to go back to. */
  let worktrees: string[] = [];
  let home: (typeof repos)[number] | null = null;
  const inRoots = (dir: string) => roots.find((root) => samePath(root, dir));

  async function state(): Promise<HostMessage[]> {
    if (!repo) return [{ type: 'state', state: null }];
    const github = parseGitHubRemote(await repo.remoteUrl('origin'));
    const read = await repo.state(limit, filter, scope, true);
    scope = read.scope;
    worktrees = read.worktrees.filter((worktree) => !worktree.prunable).map((worktree) => worktree.path);
    const away = inRoots(read.root) ? null : home;
    return [{ type: 'state', state: { ...read, favorites: favorites.get(read.root) ?? [], defaultPull: 'pullRebaseAutostash', repos, github, agentsWindow: true, worktreesRoot: null, openBranches: 'checkout', home: away } }];
  }

  async function handle(message: WebviewMessage): Promise<HostMessage[]> {
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
      case 'setFavorite': {
        if (!repo) return [];
        const others = (favorites.get(repo.root) ?? []).filter((ref) => ref !== message.ref);
        favorites.set(repo.root, message.favorite ? [...others, message.ref] : others);
        return state();
      }
      case 'loadMore':
        limit += PAGE_SIZE;
      // falls through
      case 'focus':
        return [];
      case 'ready':
      case 'refresh':
        return state();
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
      case 'getHunks': {
        const { path: file, staged } = message;
        return [{ type: 'hunks', path: file, staged, hunks: (await repo?.hunks(file, staged)) ?? null }];
      }
      default:
        console.log('not available in the preview:', JSON.stringify(message));
        return [];
    }
  }

  const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' };

  http
    .createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      try {
        if (request.method === 'POST' && url.pathname === '/message') {
          let body = '';
          for await (const chunk of request) body += chunk;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(await handle(JSON.parse(body))));
        } else if (url.pathname === '/') {
          response.setHeader('Content-Type', 'text/html');
          const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark';
          const view = VIEWS.find((candidate) => candidate === url.searchParams.get('view')) ?? 'graph';
          // The tab of a commit: of the one asked for with `commit=`, or of the last.
          const commit = view === 'commit' ? await repo?.resolve(url.searchParams.get('commit') ?? 'HEAD') : null;
          const files = url.searchParams.get('files') === 'list' ? 'list' : 'tree';
          response.end(page(theme, commit && repo ? { view, commit, root: repo.root, files } : { view }));
        } else {
          const file = path.join(assets, path.basename(url.pathname));
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
