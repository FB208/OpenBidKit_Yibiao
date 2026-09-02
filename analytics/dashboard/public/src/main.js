import { loadSettings, saveSettings } from './api.js';
import { loadAgentRuntime } from './pages/agentRuntime.js';
import { loadAgentErrors, setupAgentErrorsPage } from './pages/agentErrors.js';
import { loadClients, loadClientDetail, loadIpStats, setupIpStatsActions } from './pages/clients.js';
import { loadConfigUsage, loadModelUsage } from './pages/configUsage.js';
import { loadLatest } from './pages/latest.js';
import { loadBlockRules, setupBlockRulesPage } from './pages/ipBlocks.js';
import { loadModelInfoCache, setupModelInfoCachePage, syncModelInfoCache } from './pages/modelInfoCache.js';
import { downloadOfflineLicense, generateOfflineLicense, loadLicenseConfig, saveLicenseConfig } from './pages/license.js';
import { bindNoticeEvents, loadNotices } from './pages/notice.js';
import { loadOverview } from './pages/overview.js';
import { bindResourceEvents, loadResources } from './pages/resources.js';
import { loadPlugins, setupPluginsPage } from './pages/plugins.js';
import { loadTraffic } from './pages/traffic.js';
import { setError, setStatus, updateClientsPager, updateIpPager, updateLatestPager } from './render.js';
import { appState, state } from './state.js';
import { activateTab, getInitialTab } from './tabs.js';

const tabLoaders = {
  overview: () => loadOverview(),
  clients: (options = {}) => loadClients(options),
  ips: (options = {}) => loadIpStats(options),
  traffic: () => loadTraffic(),
  config: () => loadConfigUsage(),
  models: () => loadModelUsage(),
  agent: (options = {}) => Promise.all([loadAgentRuntime(), loadAgentErrors({ resetPage: options.resetAgentErrorPage })]),
  latest: (options = {}) => loadLatest(options),
  'ip-blocks': () => loadBlockRules(),
  notice: () => loadNotices(),
  license: () => loadLicenseConfig(),
  resources: () => loadResources(),
  plugins: () => loadPlugins(),
  'model-info-cache': () => loadModelInfoCache(),
};

const dataTabCacheTtl = 60_000;
const cacheableTabs = new Set(['overview', 'clients', 'ips', 'traffic', 'config', 'models', 'agent', 'latest']);
const tabLoadedAt = new Map();

// 判断统计页现有内容是否仍可直接复用。
function isTabCacheFresh(tab) {
  return cacheableTabs.has(tab) && Date.now() - (tabLoadedAt.get(tab) || 0) < dataTabCacheTtl;
}

// 数据源变化后清空统计页缓存，避免展示上一项目或上一凭据的数据。
function saveSettingsAndClearCache() {
  saveSettings();
  tabLoadedAt.clear();
  appState.agentErrorPage = 1;
  appState.clientsPage = 1;
}

function getLatestTotalPages() {
  return Math.max(1, Math.ceil(appState.latestTotal / appState.latestPageSize));
}

function getIpTotalPages() {
  return Math.max(1, Math.ceil(appState.ipTotal / appState.ipPageSize));
}

// 计算客户端统计总页数。
function getClientsTotalPages() {
  return Math.max(1, Math.ceil(appState.clientsTotal / appState.clientsPageSize));
}

function jumpLatestPage() {
  const value = Number(state.latestPageInput.value || appState.latestPage);
  if (!Number.isFinite(value)) {
    return;
  }

  appState.latestPage = Math.min(Math.max(1, Math.floor(value)), getLatestTotalPages());
  void refreshActiveTab({ forceRefresh: true });
}

function jumpIpPage() {
  const value = Number(state.ipPageInput.value || appState.ipPage);
  if (!Number.isFinite(value)) {
    return;
  }

  appState.ipPage = Math.min(Math.max(1, Math.floor(value)), getIpTotalPages());
  void refreshActiveTab({ forceRefresh: true });
}

// 跳转到客户端统计指定页。
function jumpClientsPage() {
  const value = Number(state.clientsPageInput.value || appState.clientsPage);
  if (!Number.isFinite(value)) {
    return;
  }

  appState.clientsPage = Math.min(Math.max(1, Math.floor(value)), getClientsTotalPages());
  void refreshActiveTab({ forceRefresh: true });
}

async function refreshActiveTab(options = {}) {
  setError('');
  const activeTab = appState.activeTab;
  if (!options.forceRefresh && isTabCacheFresh(activeTab)) {
    setStatus('ok', '已连接');
    updateClientsPager();
    updateLatestPager();
    updateIpPager();
    return;
  }

  setStatus('', '加载中');
  state.refreshButton.disabled = true;

  try {
    const loader = tabLoaders[activeTab] || tabLoaders.overview;
    await loader(options);
    if (cacheableTabs.has(activeTab)) {
      tabLoadedAt.set(activeTab, Date.now());
    }
    setStatus('ok', '已连接');
  } catch (error) {
    setStatus('error', '连接失败');
    setError(error?.message || String(error));
  } finally {
    state.refreshButton.disabled = false;
    updateClientsPager();
    updateLatestPager();
    updateIpPager();
  }
}

function bindEvents() {
  state.refreshButton.addEventListener('click', () => refreshActiveTab({ resetClientsPage: true, resetLatestPage: true, resetIpPage: true, forceRefresh: true }));
  bindNoticeEvents();
  state.loadLicenseConfigButton.addEventListener('click', () => loadLicenseConfig().catch(() => undefined));
  state.saveLicenseConfigButton.addEventListener('click', saveLicenseConfig);
  state.generateOfflineLicenseButton.addEventListener('click', generateOfflineLicense);
  state.downloadOfflineLicenseButton.addEventListener('click', downloadOfflineLicense);
  bindResourceEvents();
  setupPluginsPage();
  setupModelInfoCachePage();
  setupAgentErrorsPage();
  setupBlockRulesPage();
  setupIpStatsActions();
  state.syncModelInfoCacheButton.addEventListener('click', syncModelInfoCache);
  state.prevLatestPage.addEventListener('click', () => {
    appState.latestPage = Math.max(1, appState.latestPage - 1);
    void refreshActiveTab({ forceRefresh: true });
  });
  state.nextLatestPage.addEventListener('click', () => {
    appState.latestPage += 1;
    void refreshActiveTab({ forceRefresh: true });
  });
  state.jumpLatestPage.addEventListener('click', jumpLatestPage);
  state.latestPageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      jumpLatestPage();
    }
  });
  state.prevIpPage.addEventListener('click', () => {
    appState.ipPage = Math.max(1, appState.ipPage - 1);
    void refreshActiveTab({ forceRefresh: true });
  });
  state.nextIpPage.addEventListener('click', () => {
    appState.ipPage += 1;
    void refreshActiveTab({ forceRefresh: true });
  });
  state.jumpIpPage.addEventListener('click', jumpIpPage);
  state.ipPageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      jumpIpPage();
    }
  });
  state.prevClientsPage.addEventListener('click', () => {
    appState.clientsPage = Math.max(1, appState.clientsPage - 1);
    void refreshActiveTab({ forceRefresh: true });
  });
  state.nextClientsPage.addEventListener('click', () => {
    appState.clientsPage += 1;
    void refreshActiveTab({ forceRefresh: true });
  });
  state.jumpClientsPage.addEventListener('click', jumpClientsPage);
  state.clientsPageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      jumpClientsPage();
    }
  });
  state.clientsFilterForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void refreshActiveTab({ resetClientsPage: true, forceRefresh: true });
  });
  state.resetClientFilters.addEventListener('click', () => {
    state.clientsFilterForm.reset();
    void refreshActiveTab({ resetClientsPage: true, forceRefresh: true });
  });

  for (const button of state.tabButtons) {
    button.addEventListener('click', () => {
      activateTab(button.dataset.tabButton);
      void refreshActiveTab({ resetClientsPage: true, resetLatestPage: true, resetIpPage: true, resetAgentErrorPage: true });
    });
  }

  state.apiBase.addEventListener('change', saveSettingsAndClearCache);
  state.adminToken.addEventListener('change', saveSettingsAndClearCache);
  state.rememberToken.addEventListener('change', saveSettings);
  state.projectName.addEventListener('change', saveSettingsAndClearCache);
  state.ipDate.addEventListener('change', () => refreshActiveTab({ resetIpPage: true, forceRefresh: true }));
  state.allIpDatesButton.addEventListener('click', () => {
    state.ipDate.value = '';
    void refreshActiveTab({ resetIpPage: true, forceRefresh: true });
  });
  state.trafficRange.addEventListener('change', () => refreshActiveTab({ resetLatestPage: true, forceRefresh: true }));
  state.configRange.addEventListener('change', () => refreshActiveTab({ resetLatestPage: true, forceRefresh: true }));
  state.modelRange.addEventListener('change', () => refreshActiveTab({ resetLatestPage: true, forceRefresh: true }));
  state.agentRange.addEventListener('change', () => refreshActiveTab({ resetLatestPage: true, forceRefresh: true }));
  state.modelProviderFilter.addEventListener('change', () => refreshActiveTab({ resetLatestPage: true, forceRefresh: true }));
  state.modelEndpointFilter.addEventListener('change', () => refreshActiveTab({ resetLatestPage: true, forceRefresh: true }));
  state.modelNameFilter.addEventListener('change', () => refreshActiveTab({ resetLatestPage: true, forceRefresh: true }));
  state.latestEventFilter.addEventListener('change', () => refreshActiveTab({ resetLatestPage: true, forceRefresh: true }));
  state.closeClientDetail.addEventListener('click', () => state.clientDetailDialog.close());
  state.clientDetailRange.addEventListener('change', () => loadClientDetail().catch((error) => setError(error?.message || String(error))));
}

loadSettings();
activateTab(getInitialTab());
updateLatestPager();
updateIpPager();
updateClientsPager();
bindEvents();

if (state.adminToken.value.trim()) {
  void refreshActiveTab({ resetClientsPage: true, resetLatestPage: true, resetIpPage: true });
}
