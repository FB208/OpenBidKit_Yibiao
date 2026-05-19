import { state } from './state.js';

export function normalizeApiBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function saveSettings() {
  localStorage.setItem('analytics_api_base', normalizeApiBase(state.apiBase.value));
  localStorage.setItem('analytics_admin_token', state.adminToken.value.trim());
  localStorage.setItem('analytics_project_name', state.projectName.value);
  localStorage.setItem('analytics_days', state.days.value);
}

export function loadSettings() {
  state.apiBase.value = localStorage.getItem('analytics_api_base') || state.apiBase.value;
  state.adminToken.value = localStorage.getItem('analytics_admin_token') || '';
  state.projectName.value = localStorage.getItem('analytics_project_name') || state.projectName.value;
  state.days.value = localStorage.getItem('analytics_days') || '30';
}

export function getSelectedProjectName() {
  return state.projectName.value.trim();
}

export function getEncodedProjectAndDays() {
  return {
    projectName: encodeURIComponent(getSelectedProjectName()),
    days: encodeURIComponent(state.days.value),
  };
}

export function assertReady() {
  if (!state.adminToken.value.trim()) {
    throw new Error('请先输入 ADMIN_TOKEN');
  }
  if (!getSelectedProjectName()) {
    throw new Error('请先输入项目名');
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
