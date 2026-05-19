import { loadSettings, saveSettings } from './api.js';
import { loadConfigUsage } from './pages/configUsage.js';
import { loadLatest } from './pages/latest.js';
import { disableNotice, loadNotice, publishNotice } from './pages/notice.js';
import { loadOverview } from './pages/overview.js';
import { loadTraffic } from './pages/traffic.js';
import { setError, setStatus, updateLatestPager } from './render.js';
import { appState, state } from './state.js';
import { activateTab, getInitialTab } from './tabs.js';

const tabLoaders = {
  overview: () => loadOverview(),
  traffic: () => loadTraffic(),
  config: () => loadConfigUsage(),
  latest: (options = {}) => loadLatest(options),
  notice: () => loadNotice(),
};

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
  }
}

function bindEvents() {
  state.refreshButton.addEventListener('click', () => refreshActiveTab({ resetLatestPage: true }));
  state.loadNoticeButton.addEventListener('click', () => loadNotice().catch(() => undefined));
  state.publishNoticeButton.addEventListener('click', publishNotice);
  state.disableNoticeButton.addEventListener('click', disableNotice);
  state.prevLatestPage.addEventListener('click', () => {
    appState.latestPage = Math.max(1, appState.latestPage - 1);
    void refreshActiveTab();
  });
  state.nextLatestPage.addEventListener('click', () => {
    appState.latestPage += 1;
    void refreshActiveTab();
  });

  for (const button of state.tabButtons) {
    button.addEventListener('click', () => {
      activateTab(button.dataset.tabButton);
      void refreshActiveTab({ resetLatestPage: true });
    });
  }

  state.apiBase.addEventListener('change', saveSettings);
  state.adminToken.addEventListener('change', saveSettings);
  state.projectName.addEventListener('change', saveSettings);
  state.days.addEventListener('change', saveSettings);
}

loadSettings();
activateTab(getInitialTab());
updateLatestPager();
bindEvents();

if (state.adminToken.value.trim()) {
  void refreshActiveTab({ resetLatestPage: true });
}
