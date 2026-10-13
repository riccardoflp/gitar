import '@vscode/codicons/dist/codicon.css';
import './styles.css';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ViewKind } from '../shared/protocol';
import { App } from './App';
import { BranchesApp } from './BranchesApp';
import { ChangesApp } from './ChangesApp';
import { MenuProvider } from './ContextMenu';
import { StashesApp } from './StashesApp';

const VIEWS: Record<ViewKind, () => ReactNode> = {
  graph: () => <App />,
  // The graph as it fits beside the editor: without the references, which have a view of their own there.
  commits: () => <App compact />,
  changes: () => <ChangesApp />,
  branches: () => <BranchesApp />,
  stashes: () => <StashesApp />,
};
const kind = document.body.dataset.view as ViewKind;
const view = (VIEWS[kind] ?? VIEWS.graph)();

createRoot(document.getElementById('root')!).render(<MenuProvider>{view}</MenuProvider>);
