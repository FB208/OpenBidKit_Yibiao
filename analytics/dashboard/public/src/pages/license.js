import { assertReady, getSelectedProjectName, requestJson, saveSettings } from '../api.js';
import { state } from '../state.js';

let generatedOfflineLicense = null;

function setLicenseStatus(message, type = '') {
  state.licenseStatus.className = type ? `notice-status ${type}` : 'notice-status';
  state.licenseStatus.textContent = message || '';
}

function setOfflineLicenseStatus(message, type = '') {
  state.offlineLicenseStatus.className = type ? `notice-status ${type}` : 'notice-status';
  state.offlineLicenseStatus.textContent = message || '';
}

function defaultOfflineExpiresAt() {
  const date = new Date();
  date.setDate(date.getDate() + 365);
  return date.toISOString().slice(0, 10);
}

function fillLicenseForm(config) {
  const source = config || {};
  state.licenseFreeDays.value = String(source.freeLicenseDays || 30);
  state.licenseExpirePopupEnabled.value = source.expirePopupEnabled === false ? 'false' : 'true';
  state.licenseExpirePopupDismissible.value = source.expirePopupDismissible === false ? 'false' : 'true';
  state.licenseMeta.textContent = `项目：${source.projectName || getSelectedProjectName() || '-'}\n更新时间：${source.updatedAt || '默认配置'}`;
  if (!state.licenseOfflineExpiresAt.value) {
    state.licenseOfflineExpiresAt.value = defaultOfflineExpiresAt();
  }
}

function parseFreeDays() {
  const value = Number(state.licenseFreeDays.value || 30);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('免费授权有效期必须大于 0 天');
  }
  return Math.floor(value);
}

function parseOfflineLicenseInput() {
  const clientId = state.licenseOfflineClientId.value.trim();
  if (!clientId) {
    throw new Error('请先填写 Client ID');
  }
  const expiresAt = state.licenseOfflineExpiresAt.value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
    throw new Error('请先选择授权失效期');
  }
  return {
    clientId,
    expiresAt,
    expirePopupEnabled: state.licenseOfflineExpirePopupEnabled.value !== 'false',
    expirePopupDismissible: state.licenseOfflineExpirePopupDismissible.value === 'true',
  };
}

function buildOfflineLicenseFileName() {
  const clientId = state.licenseOfflineClientId.value.trim().replace(/[^a-zA-Z0-9._-]/g, '_') || 'client';
  const expiresAt = state.licenseOfflineExpiresAt.value.trim() || 'license';
  return `yibiao-offline-license-${clientId}-${expiresAt}.json`;
}

export async function loadLicenseConfig(options = {}) {
  try {
    assertReady();
    saveSettings();
    const projectName = getSelectedProjectName();
    const data = await requestJson(`/api/license-config?projectName=${encodeURIComponent(projectName)}`);
    fillLicenseForm(data.config || null);
    if (!options.quiet) {
      setLicenseStatus('授权配置已读取。', 'ok');
    }
  } catch (error) {
    if (!options.quiet) {
      setLicenseStatus(error?.message || String(error), 'error');
    }
    throw error;
  }
}

export async function saveLicenseConfig() {
  setLicenseStatus('');
  try {
    assertReady();
    state.saveLicenseConfigButton.disabled = true;
    const projectName = getSelectedProjectName();
    const data = await requestJson('/api/license-config', {
      method: 'POST',
      body: {
        projectName,
        freeLicenseDays: parseFreeDays(),
        expirePopupEnabled: state.licenseExpirePopupEnabled.value !== 'false',
        expirePopupDismissible: state.licenseExpirePopupDismissible.value === 'true',
      },
    });
    fillLicenseForm(data.config || null);
    setLicenseStatus('授权配置已保存。客户端下次刷新授权时会接收新配置。', 'ok');
  } catch (error) {
    setLicenseStatus(error?.message || String(error), 'error');
  } finally {
    state.saveLicenseConfigButton.disabled = false;
  }
}

export async function generateOfflineLicense() {
  setOfflineLicenseStatus('');
  try {
    assertReady();
    saveSettings();
    state.generateOfflineLicenseButton.disabled = true;
    state.downloadOfflineLicenseButton.disabled = true;
    generatedOfflineLicense = null;
    state.licenseOfflineCode.value = '';

    const projectName = getSelectedProjectName();
    const input = parseOfflineLicenseInput();
    const data = await requestJson('/api/license/offline', {
      method: 'POST',
      body: {
        projectName,
        ...input,
      },
    });
    generatedOfflineLicense = data.license || null;
    state.licenseOfflineCode.value = data.licenseCode || '';
    state.downloadOfflineLicenseButton.disabled = !generatedOfflineLicense;
    setOfflineLicenseStatus('离线授权已生成，可复制授权码或下载授权文件。', 'ok');
  } catch (error) {
    setOfflineLicenseStatus(error?.message || String(error), 'error');
  } finally {
    state.generateOfflineLicenseButton.disabled = false;
  }
}

export function downloadOfflineLicense() {
  setOfflineLicenseStatus('');
  if (!generatedOfflineLicense) {
    setOfflineLicenseStatus('请先生成离线授权。', 'error');
    return;
  }

  const blob = new Blob([`${JSON.stringify(generatedOfflineLicense, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = buildOfflineLicenseFileName();
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setOfflineLicenseStatus('离线授权文件已开始下载。', 'ok');
}
