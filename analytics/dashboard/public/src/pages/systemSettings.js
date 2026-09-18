import { assertAdminToken, requestFormData, requestJson } from '../api.js';
import { state } from '../state.js';

let previewObjectUrl = '';

function setStatus(message, type = '') {
  state.systemSettingsStatus.className = type ? `notice-status ${type}` : 'notice-status';
  state.systemSettingsStatus.textContent = message || '';
}

// 展示远程二维码或刚选择的本地图片。
function showPreview(url) {
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = url?.startsWith('blob:') ? url : '';
  state.systemGroupChatQrPreview.replaceChildren();
  if (!url) {
    state.systemGroupChatQrPreview.textContent = '尚未配置远程二维码';
    return;
  }

  const image = document.createElement('img');
  image.src = url;
  image.alt = '当前加群二维码';
  state.systemGroupChatQrPreview.appendChild(image);
}

export async function loadSystemSettings(options = {}) {
  try {
    const data = await requestJson('/system-settings');
    showPreview(data.settings?.groupChatQrUrl || '');
    if (!options.quiet) setStatus(data.settings?.groupChatQrUrl ? '已读取当前二维码。' : '尚未配置远程二维码。', 'ok');
  } catch (error) {
    if (!options.quiet) setStatus(error?.message || String(error), 'error');
    throw error;
  }
}

async function saveSystemSettings(event) {
  event.preventDefault();
  try {
    assertAdminToken();
    const image = state.systemGroupChatQr.files?.[0];
    if (!image) throw new Error('请先选择二维码图片');

    state.saveSystemSettingsButton.disabled = true;
    const formData = new FormData();
    formData.append('image', image);
    const data = await requestFormData('/api/system-settings', formData);
    state.systemGroupChatQr.value = '';
    showPreview(data.settings?.groupChatQrUrl || '');
    setStatus('加群二维码已保存。', 'ok');
  } catch (error) {
    setStatus(error?.message || String(error), 'error');
  } finally {
    state.saveSystemSettingsButton.disabled = false;
  }
}

export function bindSystemSettingsEvents() {
  state.loadSystemSettingsButton.addEventListener('click', () => loadSystemSettings().catch(() => undefined));
  state.systemSettingsForm.addEventListener('submit', saveSystemSettings);
  state.systemGroupChatQr.addEventListener('change', () => {
    const image = state.systemGroupChatQr.files?.[0];
    if (image) showPreview(URL.createObjectURL(image));
  });
}
