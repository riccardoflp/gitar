import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { RepoState, Scope } from '../shared/protocol';
import { scopeChoices, scopeLabel, scopeRefName, scopeRefs, toggleScopeRef, type ScopeChoice } from '../shared/scope';
import { Icon } from './Icon';
import { post } from './vscode';

const same = (one: Scope | null, other: Scope | null) => JSON.stringify(one) === JSON.stringify(other);

const GROUPS: { kind: ScopeChoice['kind']; title: string }[] = [
  { kind: 'branch', title: 'Local' },
  { kind: 'remote', title: 'Remotes' },
  { kind: 'tag', title: 'Tags' },
];

const QUICK: { scope: Scope | null; label: string; title: string }[] = [
  { scope: null, label: 'All', title: 'Every branch, remote branch and tag' },
  { scope: { kind: 'current' }, label: 'Current', title: 'Only what is checked out, whichever branch that is as you switch' },
  {
    scope: { kind: 'current', upstream: true },
    label: 'Upstream',
    title: 'What is checked out and its upstream, whichever branch that is as you switch: what is ahead of it and what is behind',
  },
  { scope: { kind: 'kinds', kinds: ['branch'] }, label: 'Local', title: 'Only the local branches, and what is checked out' },
  { scope: { kind: 'kinds', kinds: ['remote'] }, label: 'Remotes', title: 'Only the remote branches, and what is checked out' },
];

function Picker({ state, anchor, onClose }: { state: RepoState; anchor: HTMLElement; onClose(): void }) {
  const element = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [place, setPlace] = useState<CSSProperties>({ left: 0, top: 0 });
  // What was last chosen here, until the graph shows it: a second tick does not wait for the first to come back.
  const [wanted, setWanted] = useState<{ scope: Scope | null } | null>(null);
  const scope = wanted && !same(wanted.scope, state.scope) ? wanted.scope : state.scope;
  const latest = useRef(scope);
  latest.current = scope;
  const setScope = (next: Scope | null) => {
    latest.current = next;
    setWanted({ scope: next });
    post({ type: 'setScope', scope: next });
  };
  // The same for the switch of the list of branches, which waits for the settings to change.
  const [follow, setFollow] = useState<boolean | null>(null);
  const follows = follow ?? state.branchesFollowScope;
  useEffect(() => setFollow(null), [state.branchesFollowScope]);

  // Under the button and inside the view: as tall as the room there is, which in the panel is little.
  // Placed before it is painted, and never hidden, or the box could not take the focus.
  useLayoutEffect(() => {
    const button = anchor.getBoundingClientRect();
    const box = element.current!.getBoundingClientRect();
    const top = button.bottom + 2;
    setPlace({
      left: Math.max(4, Math.min(button.left, window.innerWidth - box.width - 4)),
      top,
      maxHeight: Math.max(120, window.innerHeight - top - 4),
    });
    input.current!.focus();
  }, [anchor]);

  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target as Node;
      // A click on the button is the button's to answer: it closes what it opened.
      if (!element.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    // The first Escape empties the box, wherever in the list the focus is; the second closes the list.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (text) setText('');
      else onClose();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose, text]);

  const chosen = new Set(scope ? scopeRefs(scope, state) : []);
  const needle = text.trim().toLowerCase();
  const choices = scopeChoices(state).filter((choice) => choice.name.toLowerCase().includes(needle));

  return createPortal(
    <div className="popover scope-picker" role="dialog" aria-label="Branches shown in the graph" ref={element} style={place}>
      <div className="quick" role="radiogroup" aria-label="Which branches">
        {QUICK.map((quick) => (
          <button
            key={quick.label}
            role="radio"
            aria-checked={same(scope, quick.scope)}
            title={quick.title}
            onClick={() => setScope(quick.scope)}
          >
            {quick.label}
          </button>
        ))}
      </div>
      <div className="refs-filter">
        <Icon name="filter" />
        <input
          ref={input}
          type="text"
          value={text}
          aria-label="Filter branches and tags"
          placeholder="Filter branches and tags"
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      <div className="choices">
        {GROUPS.map(({ kind, title }) => {
          const group = choices.filter((choice) => choice.kind === kind);
          if (!group.length) return null;
          return (
            <div key={kind} role="group" aria-label={title}>
              <div className="heading">{title}</div>
              {group.map((choice) => (
                <label key={choice.ref} className={choice.current ? 'current' : undefined} title={choice.name}>
                  <input type="checkbox" checked={chosen.has(choice.ref)} onChange={() => setScope(toggleScopeRef(latest.current, choice.ref, state))} />
                  <span>{choice.name}</span>
                </label>
              ))}
            </div>
          );
        })}
        {!choices.length && <div className="none">{needle ? 'No branch or tag has that in its name' : 'No branches or tags yet'}</div>}
      </div>
      <label className="follow" title="Beside the graph and in the Branches view: only the branches the graph shows, or all of them with the others dimmed">
        <input
          type="checkbox"
          checked={follows}
          onChange={() => {
            setFollow(!follows);
            post({ type: 'setBranchesFollowScope', follow: !follows });
          }}
        />
        <span>Filter the list of branches too</span>
      </label>
    </div>,
    document.body,
  );
}

/** Says which branches the graph shows, and opens the list to choose them from. */
export function ScopeButton({ state, compact }: { state: RepoState; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const label = scopeLabel(state.scope);
  const refs = state.scope?.kind === 'refs' ? state.scope.refs : [];
  const classes = ['button', 'scope'];
  if (compact) classes.push('icon');
  if (state.scope) classes.push('on');
  return (
    <>
      <button
        ref={button}
        className={classes.join(' ')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Branches shown: ${label}`}
        title={`Branches shown in the graph: ${label}`}
        onClick={() => setOpen(!open)}
      >
        <Icon name="list-filter" />
        {/* The count apart from the name, which is cut when it is long. */}
        {!compact && <span className="label">{refs.length ? scopeRefName(refs[0]) : label}</span>}
        {!compact && refs.length > 1 && <span className="label more">+{refs.length - 1}</span>}
        {!compact && <Icon name="chevron-down" />}
      </button>
      {open && button.current && <Picker state={state} anchor={button.current} onClose={() => setOpen(false)} />}
    </>
  );
}
