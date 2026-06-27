import { state } from './state.js';

const productionApiBase = 'https://analytics.agnet.top';

function isLocalDashboard() {
  return ['localhost', '127.0.0.1', ''].includes(window.location.hostname) || window.location.protocol === 'file:';
}

export function normalizeApiBase(value) {
  const normalized = String(value || '').trim().replace(/\/+$/, '') || productionApiBase;
  if (isLocalDashboard()) {
    return normalized;
  }

  const sameOrigin = window.location.origin.replace(/\/+$/, '');
  return normalized === sameOrigin ? sameOrigin : productionApiBase;
}

export function saveSettings() {
  localStorage.setItem('analytics_api_base', normalizeApiBase(state.apiBase.value));
  localStorage.setItem('analytics_project_name', state.projectName.value);
  localStorage.setItem('analytics_traffic_range', state.trafficRange.value);
  localStorage.setItem('analytics_config_range', state.configRange.value);
  localStorage.setItem('analytics_model_range', state.modelRange.value);
  localStorage.setItem('analytics_agent_range', state.agentRange.value);
  localStorage.setItem('analytics_model_provider_filter', state.modelProviderFilter.value);
  localStorage.setItem('analytics_model_endpoint_filter', state.modelEndpointFilter.value);
  localStorage.setItem('analytics_model_name_filter', state.modelNameFilter.value);
  localStorage.setItem('analytics_latest_event_filter', state.latestEventFilter.value);

  const token = state.adminToken.value.trim();
  sessionStorage.setItem('analytics_admin_token', token);
  if (state.rememberToken.checked) {
    localStorage.setItem('analytics_remember_token', 'true');
    localStorage.setItem('analytics_admin_token', token);
  } else {
    localStorage.removeItem('analytics_remember_token');
    localStorage.removeItem('analytics_admin_token');
  }
}

export function loadSettings() {
  state.apiBase.value = normalizeApiBase(localStorage.getItem('analytics_api_base') || state.apiBase.value);
  state.apiBase.disabled = !isLocalDashboard();
  state.rememberToken.checked = localStorage.getItem('analytics_remember_token') === 'true';
  state.adminToken.value = sessionStorage.getItem('analytics_admin_token') || (state.rememberToken.checked ? localStorage.getItem('analytics_admin_token') : '') || '';
  state.projectName.value = localStorage.getItem('analytics_project_name') || state.projectName.value;
  state.trafficRange.value = localStorage.getItem('analytics_traffic_range') || 'history';
  state.configRange.value = localStorage.getItem('analytics_config_range') || 'history';
  state.modelRange.value = localStorage.getItem('analytics_model_range') || 'history';
  state.agentRange.value = localStorage.getItem('analytics_agent_range') || 'history';
  state.modelProviderFilter.value = localStorage.getItem('analytics_model_provider_filter') || '';
  state.modelEndpointFilter.value = localStorage.getItem('analytics_model_endpoint_filter') || '';
  state.modelNameFilter.value = localStorage.getItem('analytics_model_name_filter') || '';
  state.latestEventFilter.value = localStorage.getItem('analytics_latest_event_filter') || '';
}

export function getSelectedProjectName() {
  return state.projectName.value.trim();
}

export function getEncodedProjectAndDays(daysValue = '30') {
  return {
    projectName: encodeURIComponent(getSelectedProjectName()),
    days: encodeURIComponent(daysValue),
  };
}

export function buildRangeQuery(rangeValue) {
  const range = String(rangeValue || 'history');
  return `range=${encodeURIComponent(range)}`;
}

export function assertReady() {
  assertAdminToken();
  if (!getSelectedProjectName()) {
    throw new Error('请先输入项目名');
  }
}

export function assertAdminToken() {
  if (!state.adminToken.value.trim()) {
    throw new Error('请先输入 ADMIN_TOKEN');
  }
}

export async function requestJson(path, options = {}) {
  const apiBase = normalizeApiBase(state.apiBase.value);
  const headers = {
    Authorization: `Bearer ${state.adminToken.value.trim()}`,
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${apiBase}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.code !== 0) {
    throw new Error(data?.message || `请求失败：${response.status}`);
  }
  return data;
}

export async function requestFormData(path, formData, options = {}) {
  const apiBase = normalizeApiBase(state.apiBase.value);
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method || 'POST',
    headers: {
      Authorization: `Bearer ${state.adminToken.value.trim()}`,
    },
    body: formData,
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.code !== 0) {
    throw new Error(data?.message || `请求失败：${response.status}`);
  }
  return data;
}

export async function loadProjectOptions() {
  try {
    const data = await requestJson('/api/projects');
    state.projectOptions.innerHTML = '';

    for (const project of data.projects || []) {
      const option = document.createElement('option');
      option.value = project;
      state.projectOptions.appendChild(option);
    }
  } catch {
    // 项目列表只是输入提示，失败不影响按项目名查询。
  }
}
