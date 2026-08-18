import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AppProviders from './app/providers/AppProviders';
import WorkspaceDatabaseGate from './app/WorkspaceDatabaseGate';
import DeveloperTokenStatsWindow from './features/developer/pages/DeveloperTokenStatsWindow';
import PiAgentMonitorWindow from './features/developer/pages/PiAgentMonitorWindow';
import './styles.css';

const windowMode = new URLSearchParams(window.location.search).get('window');

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {windowMode === 'token-stats' ? (
      <DeveloperTokenStatsWindow />
    ) : windowMode === 'agent-monitor' ? (
      <PiAgentMonitorWindow />
    ) : (
      <AppProviders>
        <WorkspaceDatabaseGate>
          <App />
        </WorkspaceDatabaseGate>
      </AppProviders>
    )}
  </React.StrictMode>
);
