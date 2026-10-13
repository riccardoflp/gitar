import '@vscode/codicons/dist/codicon.css';
import './styles.css';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ViewKind } from '../shared/protocol';
import { App } from './App';
import { BranchesApp } from './BranchesApp';
import { ChangesApp } from './ChangesApp';
import { CommitApp } from './CommitApp';
import { CommitsApp } from './CommitsApp';
import { MenuProvider } from './ContextMenu';
import { StashesApp } from './StashesApp';

// What the extension wrote on the page for the view it is.
const { view: kind, commit = '', root = '', files } = document.body.dataset;

const VIEWS: Record<ViewKind, () => ReactNode> = {
  graph: () => <App />,
  commits: () => <CommitsApp />,
  // The graph as it fits beside the editor: without the references, which have a view of their own there.
  sideGraph: () => <App compact />,
  changes: () => <ChangesApp />,
  branches: () => <BranchesApp />,
  stashes: () => <StashesApp />,
  commit: () => <CommitApp hash={commit} root={root} layout={files === 'list' ? 'list' : 'tree'} />,
};
const view = (VIEWS[kind as ViewKind] ?? VIEWS.graph)();

createRoot(document.getElementById('root')!).render(<MenuProvider>{view}</MenuProvider>);
