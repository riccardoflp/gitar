import '@vscode/codicons/dist/codicon.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ChangesApp } from './ChangesApp';
import { MenuProvider } from './ContextMenu';

const view = document.body.dataset.view === 'changes' ? <ChangesApp /> : <App />;

createRoot(document.getElementById('root')!).render(<MenuProvider>{view}</MenuProvider>);
