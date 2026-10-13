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

/**
 * URI of a file as it was in a commit, for an editor of its own rather than a side of a diff: its tab says which
 * commit, before the extension that tells VS Code what language the file is in.
 */
export function revisionUri(root: string, hash: string, file: string): vscode.Uri {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const short = hash.slice(0, 7);
  const label = dot > 0 ? `${name.slice(0, dot)} (${short})${name.slice(dot)}` : `${name} (${short})`;
  const directory = file.slice(0, file.length - name.length);
  return vscode.Uri.from({ scheme: SCHEME, path: `/${directory}${label}`, query: JSON.stringify({ root, ref: hash, file }) });
}

/** What a URI of a file as it was in a commit stands for, or nothing for one of the index or of a proposal. */
export function revisionOf(uri: vscode.Uri): { root: string; revision: string; file: string } | undefined {
  if (uri.scheme !== SCHEME) return undefined;
  try {
    const { root, ref, file } = JSON.parse(uri.query) as { root: string; ref: string; file?: string };
    return /^[0-9a-f]{7,64}$/.test(ref) ? { root, revision: ref, file: file ?? uri.path.slice(1) } : undefined;
  } catch {
    return undefined;
  }
}

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, ref, file } = JSON.parse(uri.query) as { root: string; ref: string; file?: string };
    if (!ref) return '';
    if (ref === PROPOSAL) return proposals.get(`${root}\n${uri.path.slice(1)}`) ?? '';
    // The path is the name of the file, but for the URIs whose tab says more than the name.
    return new Repo(root).show(ref, file ?? uri.path.slice(1));
  }
}
