import { loadSettings, saveSettings } from './api.js';
import { loadAgentRuntime } from './pages/agentRuntime.js';
import { loadAgentErrors, setupAgentErrorsPage } from './pages/agentErrors.js';
import { loadClients, loadClientDetail, loadIpStats } from './pages/clients.js';
import { loadConfigUsage, loadModelUsage } from './pages/configUsage.js';
import { loadLatest } from './pages/latest.js';
import { loadIpBlocks, setupIpBlocksPage } from './pages/ipBlocks.js';
import { loadModelInfoCache, setupModelInfoCachePage, syncModelInfoCache } from './pages/modelInfoCache.js';
import { downloadOfflineLicense, generateOfflineLicense, loadLicenseConfig, saveLicenseConfig } from './pages/license.js';
import { disableNotice, loadNotice, publishNotice } from './pages/notice.js';
import { loadOverview } from './pages/overview.js';
import { bindResourceEvents, loadResources } from './pages/resources.js';
import { loadPlugins, setupPluginsPage } from './pages/plugins.js';
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
  agent: (options = {}) => Promise.all([loadAgentRuntime(), loadAgentErrors({ resetPage: options.resetAgentErrorPage })]),
  latest: (options = {}) => loadLatest(options),
  'ip-blocks': () => loadIpBlocks(),
  notice: () => loadNotice(),
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
}

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

async function refreshActiveTab(options = {}) {
  setError('');
  const activeTab = appState.activeTab;
  if (!options.forceRefresh && isTabCacheFresh(activeTab)) {
    setStatus('ok', '已连接');
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
    updateLatestPager();
    updateIpPager();
  }
}

function bindEvents() {
  state.refreshButton.addEventListener('click', () => refreshActiveTab({ resetLatestPage: true, resetIpPage: true, forceRefresh: true }));
  state.loadNoticeButton.addEventListener('click', () => loadNotice().catch(() => undefined));
  state.publishNoticeButton.addEventListener('click', publishNotice);
  state.disableNoticeButton.addEventListener('click', disableNotice);
  state.loadLicenseConfigButton.addEventListener('click', () => loadLicenseConfig().catch(() => undefined));
  state.saveLicenseConfigButton.addEventListener('click', saveLicenseConfig);
  state.generateOfflineLicenseButton.addEventListener('click', generateOfflineLicense);
  state.downloadOfflineLicenseButton.addEventListener('click', downloadOfflineLicense);
  bindResourceEvents();
  setupPluginsPage();
  setupModelInfoCachePage();
  setupAgentErrorsPage();
  setupIpBlocksPage();
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

  for (const button of state.tabButtons) {
    button.addEventListener('click', () => {
      activateTab(button.dataset.tabButton);
      void refreshActiveTab({ resetLatestPage: true, resetIpPage: true, resetAgentErrorPage: true });
    });
  }

  state.apiBase.addEventListener('change', saveSettingsAndClearCache);
  state.adminToken.addEventListener('change', saveSettingsAndClearCache);
  state.rememberToken.addEventListener('change', saveSettings);
  state.projectName.addEventListener('change', saveSettingsAndClearCache);
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
bindEvents();

if (state.adminToken.value.trim()) {
  void refreshActiveTab({ resetLatestPage: true, resetIpPage: true });
}
