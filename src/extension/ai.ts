import * as vscode from 'vscode';
import type { Repo } from '../git/repo';
import { buildPrompt, cleanMessage } from '../shared/commitPrompt';
import { buildConflictPrompt, parseConflictAnswer, type ConflictAnswer, type ConflictQuestion } from '../shared/conflictPrompt';
import type { RepoState } from '../shared/protocol';

/**
 * Drafts a commit message with whichever language model the user has set up in VS Code.
 * It describes the staged changes, or all changes when nothing is staged, as the Commit button would commit them.
 */
export async function draftCommitMessage(repo: Repo, state: RepoState, token: vscode.CancellationToken): Promise<string> {
  const { staged, unstaged } = state.working;
  if (!staged.length && !unstaged.length) throw new Error('There are no changes to describe.');

  const [model] = await vscode.lm.selectChatModels();
  if (!model) {
    throw new Error('No language model is available in VS Code. Install an extension that provides one, such as GitHub Copilot.');
  }

  const useStaged = staged.length > 0;
  const diff = await repo.diffText(useStaged);
  const untracked = useStaged ? [] : unstaged.filter((file) => file.status === '?').map((file) => file.path);
  const subjects = (await repo.state(10)).rows.filter((row) => row.author).map((row) => row.subject);

  const messages = [vscode.LanguageModelChatMessage.User(buildPrompt(diff, untracked, subjects))];
  const options = { justification: 'Gitardo sends your uncommitted changes to the model to draft a commit message.' };
  const response = await model.sendRequest(messages, options, token);
  let text = '';
  for await (const chunk of response.text) text += chunk;
  return cleanMessage(text);
}

/**
 * Asks the language model the user has set up in VS Code how to resolve one conflict of a merge. `onText` is called
 * with the whole answer so far, each time more of it comes.
 */
export async function askResolution(question: ConflictQuestion, token: vscode.CancellationToken, onText: (text: string) => void): Promise<ConflictAnswer> {
  const [model] = await vscode.lm.selectChatModels();
  if (!model) {
    throw new Error('No language model is available in VS Code. Install an extension that provides one, such as GitHub Copilot.');
  }
  const messages = [vscode.LanguageModelChatMessage.User(buildConflictPrompt(question))];
  const options = { justification: 'Gitardo sends the conflicts of the merge, and the lines around them, to the model to propose how to resolve them.' };
  const response = await model.sendRequest(messages, options, token);
  let text = '';
  for await (const chunk of response.text) {
    text += chunk;
    onText(text);
  }
  return parseConflictAnswer(text);
}
