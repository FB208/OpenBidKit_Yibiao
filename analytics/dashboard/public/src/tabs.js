import { appState, state } from './state.js';

const validTabs = new Set(['overview', 'clients', 'ips', 'traffic', 'config', 'models', 'agent', 'latest', 'notice', 'license', 'resources', 'plugins']);

export function getInitialTab() {
  const tab = window.location.hash.replace(/^#/, '');
  return validTabs.has(tab) ? tab : 'overview';
}

export function activateTab(tab) {
  appState.activeTab = validTabs.has(tab) ? tab : 'overview';
  window.location.hash = appState.activeTab;

  for (const button of state.tabButtons) {
    button.classList.toggle('active', button.dataset.tabButton === appState.activeTab);
  }

  for (const panel of state.tabPanels) {
    panel.classList.toggle('active', panel.dataset.tabPanel === appState.activeTab);
  }
}
