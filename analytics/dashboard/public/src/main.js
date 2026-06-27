import { loadSettings, saveSettings } from './api.js';
import { loadAgentRuntime } from './pages/agentRuntime.js';
import { loadClients, loadClientDetail, loadIpStats } from './pages/clients.js';
import { loadConfigUsage, loadModelUsage } from './pages/configUsage.js';
import { loadLatest } from './pages/latest.js';
import { disableNotice, loadNotice, publishNotice } from './pages/notice.js';
import { loadOverview } from './pages/overview.js';
import { bindResourceEvents, loadResources } from './pages/resources.js';
import { loadTraffic } from './pages/traffic.js';
import { setError, setStatus, updateIpPager, updateLatestPager } from './render.js';
import { appState, state } from './state.js';
import { activateTab, getInitialTab } from './tabs.js';

const tabLoaders = {
  overview: () => loadOverview(),
  clients: () => loadClients(),
  ips: (options = {}) => loadIpStats(options),
  traffic: () => loadTraffic(),
  config: () => loadConfigUsage(),
  models: () => loadModelUsage(),
  agent: () => loadAgentRuntime(),
  latest: (options = {}) => loadLatest(options),
  notice: () => loadNotice(),
  resources: () => loadResources(),
};

function getLatestTotalPages() {
  return Math.max(1, Math.ceil(appState.latestTotal / appState.latestPageSize));
}

function getIpTotalPages() {
  return Math.max(1, Math.ceil(appState.ipTotal / appState.ipPageSize));
}

function jumpLatestPage() {
  const value = Number(state.latestPageInput.value || appState.latestPage);
  if (!Number.isFinite(value)) {
    return;
  }

  appState.latestPage = Math.min(Math.max(1, Math.floor(value)), getLatestTotalPages());
  void refreshActiveTab();
}

function jumpIpPage() {
  const value = Number(state.ipPageInput.value || appState.ipPage);
  if (!Number.isFinite(value)) {
    return;
  }

  appState.ipPage = Math.min(Math.max(1, Math.floor(value)), getIpTotalPages());
  void refreshActiveTab();
}

async function refreshActiveTab(options = {}) {
  setError('');
  setStatus('', '加载中');
  state.refreshButton.disabled = true;

  try {
    const loader = tabLoaders[appState.activeTab] || tabLoaders.overview;
    await loader(options);
    setStatus('ok', '已连接');
  } catch (error) {
    setStatus('error', '连接失败');
    setError(error?.message || String(error));
  } finally {
    state.refreshButton.disabled = false;
    updateLatestPager();
    updateIpPager();
  }
}

function bindEvents() {
  state.refreshButton.addEventListener('click', () => refreshActiveTab({ resetLatestPage: true, resetIpPage: true }));
  state.loadNoticeButton.addEventListener('click', () => loadNotice().catch(() => undefined));
  state.publishNoticeButton.addEventListener('click', publishNotice);
  state.disableNoticeButton.addEventListener('click', disableNotice);
  bindResourceEvents();
  state.prevLatestPage.addEventListener('click', () => {
    appState.latestPage = Math.max(1, appState.latestPage - 1);
    void refreshActiveTab();
  });
  state.nextLatestPage.addEventListener('click', () => {
    appState.latestPage += 1;
    void refreshActiveTab();
  });
  state.jumpLatestPage.addEventListener('click', jumpLatestPage);
  state.latestPageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      jumpLatestPage();
    }
  });
  state.prevIpPage.addEventListener('click', () => {
    appState.ipPage = Math.max(1, appState.ipPage - 1);
    void refreshActiveTab();
  });
  state.nextIpPage.addEventListener('click', () => {
    appState.ipPage += 1;
    void refreshActiveTab();
  });
  state.jumpIpPage.addEventListener('click', jumpIpPage);
  state.ipPageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      jumpIpPage();
    }
  });

  for (const button of state.tabButtons) {
    button.addEventListener('click', () => {
      activateTab(button.dataset.tabButton);
      void refreshActiveTab({ resetLatestPage: true, resetIpPage: true });
    });
  }

  state.apiBase.addEventListener('change', saveSettings);
  state.adminToken.addEventListener('change', saveSettings);
  state.rememberToken.addEventListener('change', saveSettings);
  state.projectName.addEventListener('change', saveSettings);
  state.trafficRange.addEventListener('change', () => refreshActiveTab({ resetLatestPage: true }));
  state.configRange.addEventListener('change', () => refreshActiveTab({ resetLatestPage: true }));
  state.modelRange.addEventListener('change', () => refreshActiveTab({ resetLatestPage: true }));
  state.agentRange.addEventListener('change', () => refreshActiveTab({ resetLatestPage: true }));
  state.modelProviderFilter.addEventListener('change', () => refreshActiveTab({ resetLatestPage: true }));
  state.modelEndpointFilter.addEventListener('change', () => refreshActiveTab({ resetLatestPage: true }));
  state.modelNameFilter.addEventListener('change', () => refreshActiveTab({ resetLatestPage: true }));
  state.latestEventFilter.addEventListener('change', () => refreshActiveTab({ resetLatestPage: true }));
  state.closeClientDetail.addEventListener('click', () => state.clientDetailDialog.close());
  state.clientDetailRange.addEventListener('change', () => loadClientDetail().catch((error) => setError(error?.message || String(error))));
}

loadSettings();
activateTab(getInitialTab());
updateLatestPager();
updateIpPager();
bindEvents();

if (state.adminToken.value.trim()) {
  void refreshActiveTab({ resetLatestPage: true, resetIpPage: true });
}
