import { assertReady, getSelectedProjectName, requestJson, saveSettings } from '../api.js';
import { state } from '../state.js';

function setLicenseStatus(message, type = '') {
  state.licenseStatus.className = type ? `notice-status ${type}` : 'notice-status';
  state.licenseStatus.textContent = message || '';
}

function fillLicenseForm(config) {
  const source = config || {};
  state.licenseFreeDays.value = String(source.freeLicenseDays || 30);
  state.licenseExpirePopupEnabled.value = source.expirePopupEnabled === false ? 'false' : 'true';
  state.licenseExpirePopupDismissible.value = source.expirePopupDismissible === true ? 'true' : 'false';
  state.licenseMeta.textContent = `项目：${source.projectName || getSelectedProjectName() || '-'}\n更新时间：${source.updatedAt || '默认配置'}`;
}

function parseFreeDays() {
  const value = Number(state.licenseFreeDays.value || 30);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('免费授权有效期必须大于 0 天');
  }
  return Math.floor(value);
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
