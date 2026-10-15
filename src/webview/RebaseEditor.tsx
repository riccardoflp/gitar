import { useState } from 'react';
import type { RebaseAction, Row } from '../shared/protocol';
import { Icon } from './Icon';
import { act } from './menus';
import { shortHash } from './util';

interface Props {
  /** The commits to rewrite, newest first, as in the graph. */
  range: Row[];
  branch: string | null;
  onClose(): void;
}

interface Step {
  row: Row;
  action: RebaseAction;
  message: string;
}

const ACTIONS: { value: RebaseAction; label: string }[] = [
  { value: 'pick', label: 'Pick' },
  { value: 'reword', label: 'Reword' },
  { value: 'squash', label: 'Squash' },
  { value: 'fixup', label: 'Fixup' },
  { value: 'drop', label: 'Drop' },
];

const HELP: Record<RebaseAction, string> = {
  pick: 'Keep the commit as it is',
  reword: 'Keep the changes, change the message',
  squash: 'Meld into the commit below, keeping both messages',
  fixup: 'Meld into the commit below, discarding this message',
  drop: 'Remove the commit',
};

/** Why the plan cannot run as it stands, if it cannot. */
function problem(steps: Step[]): string | null {
  const kept = steps.filter((step) => step.action !== 'drop');
  if (!kept.length) return 'Every commit is dropped. To remove them all, reset the branch instead.';
  const oldest = kept[kept.length - 1];
  if (oldest.action === 'squash' || oldest.action === 'fixup') return 'The oldest commit that is kept has nothing below it to meld into.';
  if (steps.some((step) => step.action === 'reword' && !step.message.trim())) return 'Enter a message for each reworded commit.';
  return null;
}

export function RebaseEditor({ range, branch, onClose }: Props) {
  const [steps, setSteps] = useState<Step[]>(() => range.map((row) => ({ row, action: 'pick', message: row.subject })));
  const [dragged, setDragged] = useState<number | null>(null);

  const update = (index: number, patch: Partial<Step>) =>
    setSteps(steps.map((step, at) => (at === index ? { ...step, ...patch } : step)));

  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length || from === to) return;
    const next = [...steps];
    next.splice(to, 0, ...next.splice(from, 1));
    setSteps(next);
  };

  const issue = problem(steps);
  const unchanged = steps.every((step, index) => step.action === 'pick' && step.row === range[index]);
  const oldest = range[range.length - 1];

  const start = () => {
    // Git wants the list oldest first.
    const ordered = [...steps].reverse();
    act({
      kind: 'rebaseInteractive',
      base: oldest.parents[0] ?? null,
      steps: ordered.map((step) => ({
        action: step.action,
        hash: step.row.hash,
        message: step.action === 'reword' ? step.message : undefined,
        // The box is a line: what is typed in it is the subject, and the body stays.
        keepBody: step.action === 'reword' || undefined,
      })),
    });
    onClose();
  };

  return (
    <div className="overlay" role="dialog" aria-label="Interactive rebase">
      <header>
        <strong className="grow">
          Interactive rebase of {branch ?? 'HEAD'}: {range.length} {range.length === 1 ? 'commit' : 'commits'}
        </strong>
        <span className="muted">Newest first. Drag to reorder.</span>
      </header>
      <ol className="steps">
        {steps.map((step, index) => (
          <li
            key={step.row.hash}
            className={`step ${step.action}${dragged === index ? ' dragged' : ''}`}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              setDragged(index);
            }}
            onDragEnd={() => setDragged(null)}
            onDragOver={(event) => {
              if (dragged === null) return;
              event.preventDefault();
              if (dragged !== index) {
                move(dragged, index);
                setDragged(index);
              }
            }}
          >
            <Icon name="gripper" />
            <select
              value={step.action}
              title={HELP[step.action]}
              aria-label={`Action for ${shortHash(step.row.hash)}`}
              onChange={(event) => update(index, { action: event.target.value as RebaseAction })}
            >
              {ACTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="hash">{shortHash(step.row.hash)}</span>
            {step.action === 'reword' ? (
              <input
                className="grow"
                type="text"
                value={step.message}
                aria-label="New subject"
                onChange={(event) => update(index, { message: event.target.value })}
              />
            ) : (
              <span className="grow subject">{step.row.subject}</span>
            )}
            <button className="button icon" disabled={index === 0} onClick={() => move(index, index - 1)} aria-label="Move up" title="Move up">
              <Icon name="arrow-up" />
            </button>
            <button
              className="button icon"
              disabled={index === steps.length - 1}
              onClick={() => move(index, index + 1)}
              aria-label="Move down"
              title="Move down"
            >
              <Icon name="arrow-down" />
            </button>
          </li>
        ))}
      </ol>
      <footer>
        <span className="grow problem">{issue}</span>
        <button className="button" onClick={onClose}>
          Cancel
        </button>
        <button className="button primary" disabled={issue !== null || unchanged} onClick={start}>
          Start rebase
        </button>
      </footer>
    </div>
  );
}
