import { assertAdminToken, buildRangeQuery, getEncodedProjectAndDays, requestFormData, requestJson, saveSettings } from '../api.js';
import { escapeHtml, formatNumber } from '../render.js';
import { appState, state } from '../state.js';

function setResourcesStatus(message, type = '') {
  state.resourcesStatus.className = type ? `notice-status ${type}` : 'notice-status';
  state.resourcesStatus.textContent = message || '';
}

function truncate(value, maxLength = 80) {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function renderResourceImage(resource) {
  if (resource.imageUrl) {
    return `<img class="resource-thumb" src="${escapeHtml(resource.imageUrl)}" alt="" />`;
  }

  return '<span class="resource-thumb-placeholder">无图片</span>';
}

function renderResourceTags(resource) {
  const tags = resource.tags?.length ? resource.tags : splitTags(resource.tagsText);
  if (!tags.length) {
    return '-';
  }

  return `<div class="resource-tag-list">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>`;
}

function getNextResourceSortOrder() {
  const maxOrder = (appState.resources || []).reduce((max, resource) => {
    const order = Number(resource.sortOrder);
    return Number.isFinite(order) ? Math.max(max, Math.trunc(order)) : max;
  }, 0);
  return maxOrder + 1;
}

function isBlankNewResourceForm() {
  return !state.resourceId.value.trim() && !state.resourceTitle.value.trim();
}

function splitTags(value) {
  return String(value || '')
    .split(/[，,;；\n\r]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderResourcesTable() {
  const resources = appState.resources || [];
  if (!resources.length) {
    state.resourcesTable.innerHTML = '<div class="empty">暂无资源，请先新增一条资源。</div>';
    return;
  }

  const rows = resources.map((resource) => `
    <tr>
      <td class="resource-image-cell">${renderResourceImage(resource)}</td>
      <td class="resource-title-cell"><strong>${escapeHtml(resource.title)}</strong><br /><small>${escapeHtml(resource.enabled ? '启用' : '停用')} · 排序 ${escapeHtml(resource.sortOrder)}</small></td>
      <td class="resource-tags-cell">${renderResourceTags(resource)}</td>
      <td>${escapeHtml(formatNumber(resource.clickCount))}</td>
      <td class="resource-description-cell">${escapeHtml(truncate(resource.description, 90) || '-')}</td>
      <td class="resource-modal-cell">${escapeHtml(truncate(resource.modalContent, 80) || '-')}</td>
      <td class="resource-row-actions">
        <button type="button" class="secondary-button" data-resource-action="edit" data-resource-id="${escapeHtml(resource.id)}">编辑</button>
        <button type="button" class="danger-button" data-resource-action="delete" data-resource-id="${escapeHtml(resource.id)}">删除</button>
      </td>
    </tr>
  `).join('');

  state.resourcesTable.innerHTML = `
    <table class="resource-table">
      <thead>
        <tr>
          <th>图片</th>
          <th>标题</th>
          <th>标签</th>
          <th>点击量</th>
          <th>介绍</th>
          <th>弹窗内容</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function updateImagePreview(resource) {
  if (resource?.imageUrl) {
    state.resourceImagePreview.innerHTML = `<img src="${escapeHtml(resource.imageUrl)}" alt="" />`;
    return;
  }

  const file = state.resourceImage.files?.[0];
  if (file) {
    state.resourceImagePreview.textContent = `待上传：${file.name}`;
    return;
  }

  state.resourceImagePreview.textContent = '无图片';
}

export function resetResourceForm() {
  state.resourceForm.reset();
  state.resourceId.value = '';
  state.resourceEnabled.value = 'true';
  state.resourceSortOrder.value = String(getNextResourceSortOrder());
  state.resourceRemoveImage.checked = false;
  updateImagePreview(null);
  setResourcesStatus('已清空表单，可新增资源。', 'ok');
}

function fillResourceForm(resource) {
  state.resourceId.value = resource?.id || '';
  state.resourceTitle.value = resource?.title || '';
  state.resourceTags.value = resource?.tagsText || (resource?.tags || []).join(', ');
  state.resourceEnabled.value = resource?.enabled === false ? 'false' : 'true';
  state.resourceSortOrder.value = String(resource?.sortOrder ?? 0);
  state.resourceDescription.value = resource?.description || '';
  state.resourceModalContent.value = resource?.modalContent || '';
  state.resourceImage.value = '';
  state.resourceRemoveImage.checked = false;
  updateImagePreview(resource);
}

export async function loadResources(options = {}) {
  try {
    assertAdminToken();
    saveSettings();
    const range = state.resourceClickRange.value;
    const { projectName, days } = getEncodedProjectAndDays(range === 'history' ? '30' : range);
    const data = await requestJson(`/api/resources?projectName=${projectName}&${range === 'history' ? buildRangeQuery(range) : `days=${days}`}`);
    appState.resources = data.resources || [];
    renderResourcesTable();
    if (isBlankNewResourceForm()) {
      state.resourceSortOrder.value = String(getNextResourceSortOrder());
    }
    if (!options.quiet) {
      setResourcesStatus(`已读取 ${appState.resources.length} 条资源。`, 'ok');
    }
  } catch (error) {
    if (!options.quiet) {
      setResourcesStatus(error?.message || String(error), 'error');
    }
    throw error;
  }
}

export async function saveResource(event) {
  event.preventDefault();
  setResourcesStatus('');
  try {
    assertAdminToken();
    const title = state.resourceTitle.value.trim();
    if (!title) {
      throw new Error('请先填写标题');
    }

    state.saveResourceButton.disabled = true;
    const formData = new FormData();
    formData.append('id', state.resourceId.value.trim());
    formData.append('title', title);
    formData.append('tags', state.resourceTags.value.trim());
    formData.append('enabled', state.resourceEnabled.value);
    formData.append('sortOrder', state.resourceSortOrder.value || '0');
    formData.append('description', state.resourceDescription.value.trim());
    formData.append('modalContent', state.resourceModalContent.value.trim());
    formData.append('removeImage', state.resourceRemoveImage.checked ? 'true' : 'false');

    const file = state.resourceImage.files?.[0];
    if (file) {
      formData.append('image', file);
    }

    const data = await requestFormData('/api/resources', formData);
    await loadResources({ quiet: true });
    fillResourceForm(data.resource || null);
    setResourcesStatus('资源已保存。', 'ok');
  } catch (error) {
    setResourcesStatus(error?.message || String(error), 'error');
  } finally {
    state.saveResourceButton.disabled = false;
  }
}

async function deleteResource(id) {
  const resource = (appState.resources || []).find((item) => item.id === id);
  const title = resource?.title || id;
  if (!window.confirm(`确认删除资源“${title}”？`)) {
    return;
  }

  setResourcesStatus('');
  try {
    await requestJson(`/api/resources?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (state.resourceId.value === id) {
      resetResourceForm();
    }
    await loadResources({ quiet: true });
    setResourcesStatus('资源已删除。', 'ok');
  } catch (error) {
    setResourcesStatus(error?.message || String(error), 'error');
  }
}

export function bindResourceEvents() {
  state.loadResourcesButton.addEventListener('click', () => loadResources().catch(() => undefined));
  state.newResourceButton.addEventListener('click', resetResourceForm);
  state.resetResourceButton.addEventListener('click', resetResourceForm);
  state.resourceForm.addEventListener('submit', saveResource);
  state.resourceImage.addEventListener('change', () => updateImagePreview(null));
  state.resourcesTable.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest('[data-resource-action]');
    if (!button) {
      return;
    }

    const action = button.dataset.resourceAction;
    const id = button.dataset.resourceId;
    if (action === 'edit') {
      const resource = (appState.resources || []).find((item) => item.id === id);
      fillResourceForm(resource || null);
      setResourcesStatus(resource ? '已载入资源，可编辑后保存。' : '未找到资源。', resource ? 'ok' : 'error');
    }
    if (action === 'delete' && id) {
      void deleteResource(id);
    }
  });
}
