/** Enough to describe a change; a longer diff costs more and adds little. */
const MAX_DIFF_CHARS = 20_000;

/** The request sent to the language model to draft a commit message. */
export function buildPrompt(diff: string, untracked: string[], recentSubjects: string[]): string {
  const truncated = diff.length > MAX_DIFF_CHARS;
  const parts = [
    'Write a Git commit message for the changes below.',
    'First line: a summary of at most 72 characters, in the imperative mood, with no trailing period.',
    'If the change needs explaining, add a blank line and a short body that says what changed and why.',
    'Reply with the commit message only: no code fences, no quotes, no commentary.',
  ];
  if (recentSubjects.length) {
    parts.push('', 'Match the style of the recent commits in this repository:', ...recentSubjects.map((subject) => `- ${subject}`));
  }
  if (untracked.length) parts.push('', 'New files that are not in the diff:', ...untracked.map((file) => `- ${file}`));
  parts.push('', truncated ? 'Diff (truncated):' : 'Diff:', diff.slice(0, MAX_DIFF_CHARS));
  return parts.join('\n');
}

/** Models sometimes wrap the answer in a code fence despite being told not to. */
export function cleanMessage(text: string): string {
  return text
    .trim()
    .replace(/^```[\w-]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
}
