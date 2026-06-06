import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AppProviders from './app/providers/AppProviders';
import WorkspaceDatabaseGate from './app/WorkspaceDatabaseGate';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AppProviders>
      <WorkspaceDatabaseGate>
        <App />
      </WorkspaceDatabaseGate>
    </AppProviders>
  </React.StrictMode>
);
