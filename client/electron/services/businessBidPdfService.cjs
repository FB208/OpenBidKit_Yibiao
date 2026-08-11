const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

function statusLabelClass(status) {
  const map = {
    '已响应': 'status-ok',
    '待确认': 'status-warn',
    '需复核': 'status-danger',
    '不满足': 'status-muted',
  };
  return map[status] || 'status-muted';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPdfHtml(clauseItems) {
  const groups = new Map();
  for (const item of clauseItems) {
    const list = groups.get(item.category) || [];
    list.push(item);
    groups.set(item.category, list);
  }

  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const groupHtmls = [];
  for (const [category, items] of groups) {
    const rows = items.map((item) => {
      const isImportant = item.isImportant === true;
      const starMark = isImportant ? '★ ' : '';

      return `
        <tr class="${isImportant ? 'row-important' : ''}">
          <td class="col-title">
            <div class="title-text">${starMark}${escapeHtml(item.title)}</div>
          </td>
          <td class="col-requirement">${escapeHtml(item.requirement)}</td>
          <td class="col-response">${escapeHtml(item.response_detail)}</td>
          <td class="col-status"><span class="status-badge ${statusLabelClass(item.response_status)}">${item.response_status}</span></td>
        </tr>`;
    }).join('');

    groupHtmls.push(`
      <div class="category-group">
        <div class="category-header">${escapeHtml(category)}</div>
        <table class="clause-table">
          <thead>
            <tr>
              <th class="col-title">条款名称</th>
              <th class="col-requirement">招标要求</th>
              <th class="col-response">响应内容</th>
              <th class="col-status">状态</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>`);
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  @page { margin: 15mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'SimSun', '宋体', serif; font-size: 10.5pt; color: #243048; line-height: 1.6; }
  .pdf-header { text-align: center; margin-bottom: 20px; padding-bottom: 15px; border-bottom: 2px solid #1a3a5c; }
  .pdf-header h1 { font-family: 'SimHei', '黑体', sans-serif; font-size: 18pt; color: #1a3a5c; margin-bottom: 4px; }
  .pdf-header .subtitle { font-size: 9pt; color: #888; }
  .category-group { margin-bottom: 20px; page-break-inside: avoid; }
  .category-header { font-family: 'SimHei', '黑体', sans-serif; font-size: 12pt; color: #fff; background: #1a3a5c; padding: 6px 12px; border-radius: 3px 3px 0 0; }
  .clause-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .clause-table thead th { background: #eef2f7; font-family: 'SimHei', '黑体', sans-serif; font-size: 10pt; color: #1a3a5c; padding: 8px 10px; text-align: left; border: 1px solid #d4d8e0; position: sticky; top: 0; }
  .clause-table tbody td { padding: 8px 10px; border: 1px solid #d4d8e0; vertical-align: top; font-size: 10pt; }
  .clause-table tbody tr:nth-child(even) { background: #f8f9fa; }
  .clause-table tbody tr:nth-child(odd) { background: #ffffff; }
  .clause-table tbody tr.row-important { background: #fff5f5; }
  .clause-table tbody tr.row-important:nth-child(even) { background: #fff0f0; }
  .clause-table tbody tr.row-important td:first-child { border-left: 3px solid #e02020; }
  .col-title { width: 22%; }
  .col-requirement { width: 32%; }
  .col-response { width: 32%; }
  .col-status { width: 14%; text-align: center; }
  .title-text { font-weight: 600; color: #1a3a5c; }
  .row-important .title-text { color: #c41e1e; }
  .status-badge { display: inline-block; padding: 2px 10px; border-radius: 3px; font-size: 9pt; font-weight: 600; }
  .status-ok { background: #f0fff4; color: #389e0d; border: 1px solid #b7eb8f; }
  .status-warn { background: #fffbe6; color: #d48806; border: 1px solid #ffe58f; }
  .status-danger { background: #fff1f0; color: #cf1322; border: 1px solid #ffa39e; }
  .status-muted { background: #fafafa; color: #999; border: 1px solid #d9d9d9; }
  .pdf-footer { text-align: center; font-size: 8pt; color: #aaa; margin-top: 30px; border-top: 1px solid #eee; padding-top: 10px; }
</style>
</head>
<body>
<div class="pdf-header">
  <h1>商务响应矩阵</h1>
  <div class="subtitle">生成时间：${dateStr} ｜ 共 ${clauseItems.length} 项条款</div>
</div>
${groupHtmls.join('\n')}
<div class="pdf-footer">由 OpenBidKit 生成，内容仅供参考</div>
</body>
</html>`;
}

async function exportPdf(clauseItems) {
  const items = Array.isArray(clauseItems) ? clauseItems : [];
  if (!items.length) {
    throw new Error('没有可导出的商务条款数据');
  }

  const defaultFilename = `商务响应矩阵_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.pdf`;
  const defaultDir = app?.getPath ? app.getPath('downloads') : process.env.USERPROFILE || process.cwd();
  const saveResult = await dialog.showSaveDialog({
    title: '导出商务响应矩阵 PDF',
    defaultPath: path.join(defaultDir, defaultFilename),
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
  });

  if (saveResult.canceled || !saveResult.filePath) {
    return { success: false, canceled: true, message: '已取消导出' };
  }

  const html = buildPdfHtml(items);

  const pdfWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      javascript: false,
      images: false,
      sandbox: true,
    },
  });

  try {
    await pdfWindow.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdfBuffer = await pdfWindow.webContents.printToPDF({
      printBackground: true,
      printSelectionOnly: false,
      landscape: false,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      pageSize: 'A4',
    });

    fs.writeFileSync(saveResult.filePath, pdfBuffer);
    return { success: true, path: saveResult.filePath, message: 'PDF 已导出' };
  } finally {
    if (!pdfWindow.isDestroyed()) {
      pdfWindow.close();
    }
  }
}

module.exports = { exportPdf };
