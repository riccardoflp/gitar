import * as vscode from 'vscode';
import { Repo } from '../git/repo';

export const SCHEME = 'gitar';

/** Stands for the staged version of a file: `git show :0:<path>`. */
export const INDEX = ':0';

/** The three sides of a file in conflict, as the index keeps them: `git show :1:<path>` and so on. */
export const CONFLICT = { base: ':1', ours: ':2', theirs: ':3' } as const;

/** Stands for what Gitar proposes to write in a file, shown beside what the file has before anything is written. */
const PROPOSAL = 'proposal';
const proposals = new Map<string, string>();

/** URI of the text proposed for a file. The latest proposal for a file is the one kept. */
export function proposalUri(root: string, file: string, text: string): vscode.Uri {
  proposals.set(`${root}\n${file}`, text);
  return vscode.Uri.from({ scheme: SCHEME, path: `/${file}`, query: JSON.stringify({ root, ref: PROPOSAL, at: Date.now() }) });
}

/**
 * URI of a file as it was at `ref`. An empty ref stands for "the file does not exist on this side of the diff".
 * The index changes over time, so its URIs carry a timestamp to keep VS Code from showing a cached copy.
 */
export function contentUri(root: string, ref: string, file: string): vscode.Uri {
  const query = ref.startsWith(':') ? { root, ref, at: Date.now() } : { root, ref };
  return vscode.Uri.from({ scheme: SCHEME, path: `/${file}`, query: JSON.stringify(query) });
}

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, ref } = JSON.parse(uri.query) as { root: string; ref: string };
    if (!ref) return '';
    if (ref === PROPOSAL) return proposals.get(`${root}\n${uri.path.slice(1)}`) ?? '';
    return new Repo(root).show(ref, uri.path.slice(1));
  }
}
