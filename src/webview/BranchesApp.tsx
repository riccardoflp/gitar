import { useCallback, useEffect, useRef, useState } from 'react';
import type { Comparing, Comparison, RepoState } from '../shared/protocol';
import { Compare } from './Compare';
import { Placeholder } from './Placeholder';
import { RefsTree, type SectionId } from './RefsTree';
import { onMessage, post } from './vscode';
import { WorktreeBanner } from './WorktreeBanner';

/** The stashes have a view of their own beside this one. */
const SECTIONS: SectionId[] = ['favorites', 'recent', 'branches', 'remotes', 'tags', 'worktrees'];

/** The branches, tags and worktrees in the side bar, with a comparison under them when one is asked for. */
export function BranchesApp() {
  const [state, setState] = useState<RepoState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [comparing, setComparing] = useState<Comparing | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const comparingRef = useRef(comparing);
  comparingRef.current = comparing;
  const rootRef = useRef<string | null>(null);

  const compare = useCallback((next: Comparing) => {
    setComparing(next);
    setComparison(null);
    post({ type: 'getComparison', from: next.from, to: next.to });
  }, []);

  /** There are no commits here to go to: the views that list them show it, if they are open. */
  const show = useCallback((hash: string) => {
    setSelected(hash);
    post({ type: 'show', hash });
  }, []);

  useEffect(() => {
    const stop = onMessage((message) => {
      if (message.type === 'state') {
        setState(message.state);
        setLoaded(true);
        const root = message.state?.root ?? null;
        if (root !== rootRef.current) {
          // Another repository: what was selected or compared belongs to the previous one.
          rootRef.current = root;
          setSelected(null);
          setComparing(null);
        }
      } else if (message.type === 'comparison') {
        const { from, to } = message.comparison;
        if (from === comparingRef.current?.from && to === comparingRef.current.to) setComparison(message.comparison);
      } else if (message.type === 'compare') {
        compare(message.comparing);
      }
    });
    post({ type: 'ready' });
    return stop;
  }, [compare]);

  if (!state) return <Placeholder loaded={loaded} />;

  return (
    <div className="side">
      <WorktreeBanner state={state} busy={false} />
      <RefsTree state={state} selected={selected} onSelect={show} onCompare={compare} sections={SECTIONS} />
      {comparing && (
        <Compare
          comparing={comparing}
          comparison={comparison}
          onSwap={() => compare({ from: comparing.to, to: comparing.from, fromName: comparing.toName, toName: comparing.fromName })}
          onJump={show}
          onClose={() => setComparing(null)}
        />
      )}
    </div>
  );
}
