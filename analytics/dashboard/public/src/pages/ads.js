import { assertAdminToken, requestFormData, requestJson, saveSettings } from '../api.js';
import { escapeHtml } from '../render.js';
import { appState, state } from '../state.js';

function setAdsStatus(message, type = '') {
  state.adsStatus.className = type ? `notice-status ${type}` : 'notice-status';
  state.adsStatus.textContent = message || '';
}

function truncate(value, maxLength = 80) {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function renderAdImage(ad) {
  if (ad.imageUrl) {
    return `<img class="resource-thumb" src="${escapeHtml(ad.imageUrl)}" alt="" />`;
  }

  return '<span class="resource-thumb-placeholder">无图片</span>';
}

function getNextAdSortOrder() {
  const maxOrder = (appState.ads || []).reduce((max, ad) => {
    const order = Number(ad.sortOrder);
    return Number.isFinite(order) ? Math.max(max, Math.trunc(order)) : max;
  }, 0);
  return maxOrder + 1;
}

function isBlankNewAdForm() {
  return !state.adId.value.trim() && !state.adLinkUrl.value.trim();
}

function renderAdsTable() {
  const ads = appState.ads || [];
  if (!ads.length) {
    state.adsTable.innerHTML = '<div class="empty">暂无广告，请先新增一条广告。</div>';
    return;
  }

  const rows = ads.map((ad) => `
    <tr>
      <td class="resource-image-cell">${renderAdImage(ad)}</td>
      <td class="resource-title-cell"><strong>${escapeHtml(truncate(ad.linkUrl, 70) || '-')}</strong><br /><small>${escapeHtml(ad.enabled ? '启用' : '停用')} · 排序 ${escapeHtml(ad.sortOrder)}</small></td>
      <td>${escapeHtml(ad.updatedAt || '-')}</td>
      <td class="resource-row-actions">
        <button type="button" class="secondary-button" data-ad-action="edit" data-ad-id="${escapeHtml(ad.id)}">编辑</button>
        <button type="button" class="danger-button" data-ad-action="delete" data-ad-id="${escapeHtml(ad.id)}">删除</button>
      </td>
    </tr>
  `).join('');

  state.adsTable.innerHTML = `
    <table class="resource-table">
      <thead>
        <tr>
          <th>图片</th>
          <th>跳转链接</th>
          <th>更新时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function updateImagePreview(ad) {
  if (ad?.imageUrl) {
    state.adImagePreview.innerHTML = `<img src="${escapeHtml(ad.imageUrl)}" alt="" />`;
    return;
  }

  const file = state.adImage.files?.[0];
  if (file) {
    state.adImagePreview.textContent = `待上传：${file.name}`;
    return;
  }

  state.adImagePreview.textContent = '无图片';
}

export function resetAdForm() {
  state.adForm.reset();
  state.adId.value = '';
  state.adEnabled.value = 'true';
  state.adSortOrder.value = String(getNextAdSortOrder());
  updateImagePreview(null);
  setAdsStatus('已清空表单，可新增广告。', 'ok');
}

function fillAdForm(ad) {
  state.adId.value = ad?.id || '';
  state.adLinkUrl.value = ad?.linkUrl || '';
  state.adEnabled.value = ad?.enabled === false ? 'false' : 'true';
  state.adSortOrder.value = String(ad?.sortOrder ?? 0);
  state.adImage.value = '';
  updateImagePreview(ad);
}

export async function loadAds(options = {}) {
  try {
    assertAdminToken();
    saveSettings();
    const data = await requestJson('/api/ads');
    appState.ads = data.ads || [];
    renderAdsTable();
    if (isBlankNewAdForm()) {
      state.adSortOrder.value = String(getNextAdSortOrder());
    }
    if (!options.quiet) {
      setAdsStatus(`已读取 ${appState.ads.length} 条广告。`, 'ok');
    }
  } catch (error) {
    if (!options.quiet) {
      setAdsStatus(error?.message || String(error), 'error');
    }
    throw error;
  }
}

export async function saveAd(event) {
  event.preventDefault();
  setAdsStatus('');
  try {
    assertAdminToken();
    const linkUrl = state.adLinkUrl.value.trim();
    if (!linkUrl) {
      throw new Error('请先填写跳转链接');
    }

    const file = state.adImage.files?.[0];
    const isNew = !state.adId.value.trim();
    if (isNew && !file) {
      throw new Error('新增广告请先选择图片');
    }

    state.saveAdButton.disabled = true;
    const formData = new FormData();
    formData.append('id', state.adId.value.trim());
    formData.append('linkUrl', linkUrl);
    formData.append('enabled', state.adEnabled.value);
    formData.append('sortOrder', state.adSortOrder.value || '0');
    if (file) {
      formData.append('image', file);
    }

    const data = await requestFormData('/api/ads', formData);
    await loadAds({ quiet: true });
    fillAdForm(data.ad || null);
    setAdsStatus('广告已保存。', 'ok');
  } catch (error) {
    setAdsStatus(error?.message || String(error), 'error');
  } finally {
    state.saveAdButton.disabled = false;
  }
}

async function deleteAd(id) {
  const ad = (appState.ads || []).find((item) => item.id === id);
  const link = ad?.linkUrl || id;
  if (!window.confirm(`确认删除广告“${link}”？`)) {
    return;
  }

  setAdsStatus('');
  try {
    await requestJson(`/api/ads?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (state.adId.value === id) {
      resetAdForm();
    }
    await loadAds({ quiet: true });
    setAdsStatus('广告已删除。', 'ok');
  } catch (error) {
    setAdsStatus(error?.message || String(error), 'error');
  }
}

export function bindAdEvents() {
  state.loadAdsButton.addEventListener('click', () => loadAds().catch(() => undefined));
  state.newAdButton.addEventListener('click', resetAdForm);
  state.resetAdButton.addEventListener('click', resetAdForm);
  state.adForm.addEventListener('submit', saveAd);
  state.adImage.addEventListener('change', () => updateImagePreview(null));
  state.adsTable.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest('[data-ad-action]');
    if (!button) {
      return;
    }

    const action = button.dataset.adAction;
    const id = button.dataset.adId;
    if (action === 'edit') {
      const ad = (appState.ads || []).find((item) => item.id === id);
      fillAdForm(ad || null);
      setAdsStatus(ad ? '已载入广告，可编辑后保存。' : '未找到广告。', ad ? 'ok' : 'error');
    }
    if (action === 'delete' && id) {
      void deleteAd(id);
    }
  });
}
