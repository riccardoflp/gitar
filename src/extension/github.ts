import * as vscode from 'vscode';
import { PULLS_QUERY, mapPulls, type GitHubRepo, type PullsResponse } from '../git/github';
import type { PullRequest } from '../shared/protocol';

const SCOPES = ['repo'];

/** The user's GitHub session from VS Code. Only asks them to sign in when `prompt` is set. */
export async function githubSession(prompt: boolean): Promise<vscode.AuthenticationSession | undefined> {
  return vscode.authentication.getSession('github', SCOPES, prompt ? { createIfNone: true } : { silent: true });
}

/** Open pull requests of a repository by branch name, read with one GraphQL request. */
export async function fetchPulls(repo: GitHubRepo, token: string): Promise<Record<string, PullRequest>> {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'gitar-vscode' },
    body: JSON.stringify({ query: PULLS_QUERY, variables: repo }),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText}`);
  return mapPulls((await response.json()) as PullsResponse, repo.owner);
}
