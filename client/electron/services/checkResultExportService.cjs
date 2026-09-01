const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const EXCEL_TEXT_LIMIT = 32767;
const EXCEL_TEXT_PREFIX_LIMIT = 32750;
const EXCEL_TEXT_TRUNCATION_SUFFIX = '……（内容过长，已截断）';

const rejectionSheetNames = ['检查概览', '废标项', '错别字', '逻辑问题'];
const duplicateSheetNames = ['查重概览', '元数据', '目录重复', '文件相似度', '重复句子', '重复图片'];

function normalizeCellText(value) {
  if (value === null || value === undefined) return '';
  const normalized = String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
  if (normalized.length <= EXCEL_TEXT_LIMIT) return normalized;
  return `${normalized.slice(0, EXCEL_TEXT_PREFIX_LIMIT)}${EXCEL_TEXT_TRUNCATION_SUFFIX}`;
}

function normalizeRows(rows) {
  return rows.map((row) => row.map((value) => typeof value === 'number' ? value : normalizeCellText(value)));
}

function sanitizeFileName(fileName) {
  return normalizeCellText(fileName).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
}

function ensureXlsxPath(filePath) {
  const value = String(filePath || '');
  return /\.xlsx$/i.test(value) ? value : `${value}.xlsx`;
}

function formatFileTimestamp(date) {
  const value = date instanceof Date ? date : new Date(date);
  const pad = (number) => String(number).padStart(2, '0');
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}_${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}`;
}

function formatDisplayTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return normalizeCellText(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function createWorksheet(rows, columnWidths, filterHeaderRow) {
  const normalizedRows = normalizeRows(rows);
  const worksheet = XLSX.utils.aoa_to_sheet(normalizedRows);
  worksheet['!cols'] = columnWidths.map((wch) => ({ wch }));
  if (Number.isInteger(filterHeaderRow)) {
    const lastColumn = Math.max(0, (normalizedRows[filterHeaderRow]?.length || 1) - 1);
    const lastRow = Math.max(filterHeaderRow, normalizedRows.length - 1);
    worksheet['!autofilter'] = {
      ref: XLSX.utils.encode_range({ s: { r: filterHeaderRow, c: 0 }, e: { r: lastRow, c: lastColumn } }),
    };
  }
  return worksheet;
}

function appendWorksheet(workbook, name, rows, widths, filterHeaderRow) {
  XLSX.utils.book_append_sheet(workbook, createWorksheet(rows, widths, filterHeaderRow), name);
}

function getRejectionResultDescriptor(result, expectedSignature) {
  const source = result && typeof result === 'object' ? result : { status: 'idle', findings: [] };
  const valid = source.inputSignature === expectedSignature;
  return {
    ...source,
    findings: valid && Array.isArray(source.findings) ? source.findings : [],
    valid,
  };
}

function selectCurrentRejectionResults(state, request) {
  const workspace = state || {};
  const selected = {
    bidDocuments: Array.isArray(workspace.bidDocuments) ? workspace.bidDocuments : [],
    rejectionCheckResult: getRejectionResultDescriptor(
      workspace.rejectionCheckResult,
      request?.rejectionInputSignature,
    ),
    typoCheckResult: getRejectionResultDescriptor(workspace.typoCheckResult, request?.bidSignature),
    logicCheckResult: getRejectionResultDescriptor(workspace.logicCheckResult, request?.bidSignature),
  };
  const results = [selected.rejectionCheckResult, selected.typoCheckResult, selected.logicCheckResult];
  selected.exportable = results.some((result) => result.valid
    && (result.status === 'success' || result.findings.length > 0));
  return selected;
}

function getDuplicateAnalysisDescriptor(analysis, signature) {
  const source = analysis && typeof analysis === 'object' ? analysis : undefined;
  return {
    source,
    valid: Boolean(source) && source.signature === signature,
  };
}

function countDuplicateRows(field, analysis) {
  if (!analysis) return 0;
  if (field === 'metadataAnalysis') return Array.isArray(analysis.rows) ? analysis.rows.length : 0;
  if (field === 'outlineAnalysis') return Array.isArray(analysis.duplicateGroups) ? analysis.duplicateGroups.length : 0;
  if (field === 'contentAnalysis') return Array.isArray(analysis.duplicateSentences) ? analysis.duplicateSentences.length : 0;
  return Array.isArray(analysis.duplicateImages) ? analysis.duplicateImages.length : 0;
}

function hasDuplicateRows(field, analysis) {
  if (countDuplicateRows(field, analysis) > 0) return true;
  return field === 'outlineAnalysis'
    && Array.isArray(analysis?.pairwiseSimilarities)
    && analysis.pairwiseSimilarities.length > 0;
}

function selectCurrentDuplicateResults(state, request) {
  const workspace = state || {};
  const signature = request?.signature;
  const selected = {
    tenderFiles: Array.isArray(workspace.tenderFiles) && workspace.tenderFiles.length
      ? workspace.tenderFiles
      : [workspace.tenderFile].filter(Boolean),
    bidFiles: Array.isArray(workspace.bidFiles) ? workspace.bidFiles : [],
  };
  for (const field of ['metadataAnalysis', 'outlineAnalysis', 'contentAnalysis', 'imageAnalysis']) {
    selected[field] = getDuplicateAnalysisDescriptor(workspace[field], signature);
  }
  selected.exportable = ['metadataAnalysis', 'outlineAnalysis', 'contentAnalysis', 'imageAnalysis']
    .some((field) => {
      const descriptor = selected[field];
      return descriptor.valid
        && (descriptor.source.status === 'success' || hasDuplicateRows(field, descriptor.source));
    });
  return selected;
}

function getResultStatus(descriptor, idleStatus = 'idle') {
  const source = descriptor?.source || descriptor;
  if (!source) return '未执行';
  if (!descriptor.valid) {
    return source.inputSignature || source.signature ? '结果已失效' : '未执行';
  }
  if (source.status === 'success') return '已完成';
  if (source.status === 'error') return '失败';
  if (source.status === idleStatus || source.status === 'pending') return '未执行';
  return '未执行';
}

function getResultMessage(descriptor, resultCount, emptyMessage) {
  const source = descriptor?.source || descriptor;
  if (!source) return '';
  if (!descriptor.valid) {
    return source.inputSignature || source.signature ? '结果签名与当前检查输入不一致' : '';
  }
  if (source.status === 'error') return source.error || source.message || source.progressMessage || '检查失败';
  if (source.status === 'success' && resultCount === 0) return emptyMessage;
  return source.message || source.progressMessage || '';
}

function buildDocumentLookup(documents, idField = 'id', nameField = 'fileName') {
  return new Map((Array.isArray(documents) ? documents : []).map((document, index) => [
    document?.[idField],
    { index: index + 1, name: document?.[nameField] || '' },
  ]));
}

function getDocumentColumns(lookup, documentId) {
  const document = lookup.get(documentId);
  return document ? [document.index, document.name] : ['', ''];
}

function buildRejectionWorkbook(state, request, options = {}) {
  const selected = selectCurrentRejectionResults(state, request);
  const exportedAt = options.exportedAt || new Date();
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: '废标检查结果', CreatedDate: new Date(exportedAt) };

  const bidNames = selected.bidDocuments.map((document) => document.fileName).filter(Boolean).join('；');
  const overviewDefinitions = [
    ['废标项检查', selected.rejectionCheckResult],
    ['错别字检查', selected.typoCheckResult],
    ['逻辑问题检查', selected.logicCheckResult],
  ];
  const overviewRows = [
    ['导出时间', formatDisplayTime(exportedAt)],
    [],
    ['检查类型', '状态', '问题数量', '更新时间', '检查对象', '说明'],
    ...overviewDefinitions.map(([label, result]) => [
      label,
      getResultStatus(result),
      result.valid ? result.findings.length : 0,
      result.updatedAt || '',
      bidNames,
      getResultMessage(result, result.findings.length, '检查已完成，未发现问题'),
    ]),
  ];
  appendWorksheet(workbook, rejectionSheetNames[0], overviewRows, [16, 14, 12, 22, 32, 42]);

  const documentLookup = buildDocumentLookup(selected.bidDocuments);
  const rejectionRows = [
    ['序号', '投标文件序号', '投标文件名', '类型', '风险等级', '标题', '摘要', '招标要求', '投标证据', '风险原因', '修改建议'],
    ...selected.rejectionCheckResult.findings.map((finding, index) => [
      index + 1,
      ...getDocumentColumns(documentLookup, finding.bidDocumentId),
      finding.type === 'invalidBid' ? '无效标' : '废标项',
      ({ high: '高风险', medium: '中风险', low: '低风险' })[finding.severity] || '',
      finding.title,
      finding.summary,
      finding.requirement,
      finding.bidEvidence,
      finding.riskReason,
      finding.suggestion,
    ]),
  ];
  appendWorksheet(workbook, rejectionSheetNames[1], rejectionRows, [8, 14, 28, 12, 12, 24, 36, 42, 42, 42, 42], 0);

  const typoRows = [
    ['序号', '投标文件序号', '投标文件名', '错误文本', '建议改正', '位置', '原文摘录', '判断原因'],
    ...selected.typoCheckResult.findings.map((finding, index) => [
      index + 1,
      ...getDocumentColumns(documentLookup, finding.bidDocumentId),
      finding.wrongText,
      finding.correctText,
      finding.locationHint,
      finding.originalExcerpt,
      finding.reason,
    ]),
  ];
  appendWorksheet(workbook, rejectionSheetNames[2], typoRows, [8, 14, 28, 18, 18, 26, 48, 38], 0);

  const logicRows = [
    ['序号', '投标文件序号', '投标文件名', '标题', '位置', '原文', '问题原因', '修改建议'],
    ...selected.logicCheckResult.findings.map((finding, index) => [
      index + 1,
      ...getDocumentColumns(documentLookup, finding.bidDocumentId),
      finding.title,
      finding.locationHint,
      finding.originalText,
      finding.fallacyReason,
      finding.suggestion,
    ]),
  ];
  appendWorksheet(workbook, rejectionSheetNames[3], logicRows, [8, 14, 28, 24, 28, 48, 42, 42], 0);
  return workbook;
}

function joinFileNames(fileIds, fileNameById) {
  return (Array.isArray(fileIds) ? fileIds : [])
    .map((fileId) => fileNameById.get(fileId) || fileId)
    .filter(Boolean)
    .join('；');
}

function buildDuplicateWorkbook(state, request, options = {}) {
  const selected = selectCurrentDuplicateResults(state, request);
  const exportedAt = options.exportedAt || new Date();
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: '标书查重结果', CreatedDate: new Date(exportedAt) };

  const allFiles = [...selected.tenderFiles, ...selected.bidFiles];
  const fileNameById = new Map(allFiles.map((file) => [file.id, file.file_name || '']));
  const tenderNames = selected.tenderFiles.map((file) => file.file_name).filter(Boolean).join('；');
  const bidNames = selected.bidFiles.map((file) => file.file_name).filter(Boolean).join('；');
  const definitions = [
    ['元数据', 'metadataAnalysis'],
    ['目录', 'outlineAnalysis'],
    ['正文', 'contentAnalysis'],
    ['图片', 'imageAnalysis'],
  ];
  const overviewRows = [
    ['导出时间', formatDisplayTime(exportedAt)],
    [],
    ['分析维度', '状态', '结果数量', '更新时间', '招标文件', '投标文件', '说明'],
    ...definitions.map(([label, field]) => {
      const descriptor = selected[field];
      const count = descriptor.valid ? countDuplicateRows(field, descriptor.source) : 0;
      return [
        label,
        getResultStatus(descriptor, 'pending'),
        count,
        descriptor.source?.updated_at || '',
        tenderNames,
        bidNames,
        getResultMessage(descriptor, count, '分析已完成，未发现重复项'),
      ];
    }),
    [],
    ['统计项', '数值'],
    ['识别图片总数', selected.imageAnalysis.valid ? Number(selected.imageAnalysis.source.totalImageCount || 0) : 0],
    ['招标目录排除数量', selected.outlineAnalysis.valid ? Number(selected.outlineAnalysis.source.tenderMatchedItemCount || 0) : 0],
    ['招标引用句子排除数量', selected.contentAnalysis.valid ? Number(selected.contentAnalysis.source.tenderMatchedSentenceCount || 0) : 0],
    ['正文句子总量', selected.contentAnalysis.valid ? Number(selected.contentAnalysis.source.totalSentenceCount || 0) : 0],
  ];
  appendWorksheet(workbook, duplicateSheetNames[0], overviewRows, [16, 14, 12, 22, 30, 34, 42]);

  const metadata = selected.metadataAnalysis.valid ? selected.metadataAnalysis.source : undefined;
  const metadataRows = [
    ['元数据项', '重复文件', '同日文件', ...selected.bidFiles.map((file, index) => `投标文件${index + 1}：${file.file_name}`)],
    ...(metadata?.rows || []).map((row) => [
      row.label,
      joinFileNames(row.duplicate_file_ids, fileNameById),
      joinFileNames(row.same_day_file_ids, fileNameById),
      ...selected.bidFiles.map((file) => row.values?.[file.id]),
    ]),
  ];
  appendWorksheet(workbook, duplicateSheetNames[1], metadataRows, [24, 32, 32, ...selected.bidFiles.map(() => 32)], 0);

  const outline = selected.outlineAnalysis.valid ? selected.outlineAnalysis.source : undefined;
  const outlineRows = [
    ['序号', '类型', '标题', '相似度', '涉及文件', '路径明细'],
    ...(outline?.duplicateGroups || []).map((group, index) => [
      index + 1,
      group.type === 'duplicate' ? '重复' : '相似',
      group.title,
      Number(group.score || 0),
      joinFileNames(group.file_ids, fileNameById),
      (group.file_ids || []).flatMap((fileId) => (group.paths?.[fileId] || []).map((itemPath) => `${fileNameById.get(fileId) || fileId}：${itemPath}`)).join('；'),
    ]),
  ];
  appendWorksheet(workbook, duplicateSheetNames[2], outlineRows, [8, 10, 32, 12, 34, 64], 0);
  const outlineSheet = workbook.Sheets[duplicateSheetNames[2]];
  for (let row = 1; row < outlineRows.length; row += 1) {
    const cell = outlineSheet[XLSX.utils.encode_cell({ r: row, c: 3 })];
    if (cell) cell.z = '0.00%';
  }

  const pairwiseRows = [
    ['文件 A', '文件 B', '综合相似度', '标题重合度', '路径重合度', '顺序相似度', '共享目录数量', '风险等级'],
    ...(outline?.pairwiseSimilarities || []).map((item) => [
      fileNameById.get(item.file_a_id) || item.file_a_id,
      fileNameById.get(item.file_b_id) || item.file_b_id,
      Number(item.score || 0),
      Number(item.title_overlap || 0),
      Number(item.path_overlap || 0),
      Number(item.order_similarity || 0),
      Number(item.shared_count || 0),
      ({ high: '高', medium: '中', low: '低', none: '无' })[item.risk] || '无',
    ]),
  ];
  appendWorksheet(workbook, duplicateSheetNames[3], pairwiseRows, [28, 28, 14, 14, 14, 14, 14, 12], 0);
  const pairwiseSheet = workbook.Sheets[duplicateSheetNames[3]];
  for (let row = 1; row < pairwiseRows.length; row += 1) {
    for (let column = 2; column <= 5; column += 1) {
      const cell = pairwiseSheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell) cell.z = '0.00%';
    }
  }

  const content = selected.contentAnalysis.valid ? selected.contentAnalysis.source : undefined;
  const contentRows = [
    ['序号', '重复句子', '涉及文件', '各文件出现次数', '总出现次数'],
    ...(content?.duplicateSentences || []).map((item, index) => [
      index + 1,
      item.sentence,
      joinFileNames(item.file_ids, fileNameById),
      (item.file_ids || []).map((fileId) => `${fileNameById.get(fileId) || fileId} × ${Number(item.occurrences?.[fileId] || 0)}`).join('；'),
      Object.values(item.occurrences || {}).reduce((sum, count) => sum + Number(count || 0), 0),
    ]),
  ];
  appendWorksheet(workbook, duplicateSheetNames[4], contentRows, [8, 72, 34, 48, 14], 0);

  const image = selected.imageAnalysis.valid ? selected.imageAnalysis.source : undefined;
  const imageRows = [
    ['序号', '图片 Hash', '涉及文件', '各文件出现次数', '出现位置', '图片前文'],
    ...(image?.duplicateImages || []).map((item, index) => {
      const locationEntries = (item.file_ids || []).flatMap((fileId) => (item.locations?.[fileId] || []).map((location) => ({ fileId, location })));
      return [
        index + 1,
        item.hash,
        joinFileNames(item.file_ids, fileNameById),
        (item.file_ids || []).map((fileId) => `${fileNameById.get(fileId) || fileId} × ${Number(item.occurrences?.[fileId] || 0)}`).join('；'),
        locationEntries.map(({ fileId, location }) => {
          const indexText = Number.isFinite(Number(location.image_index)) ? `（图片 ${Number(location.image_index)}）` : '';
          return `${fileNameById.get(fileId) || fileId}：${location.directory || '未识别目录'}${indexText}`;
        }).join('；'),
        locationEntries.map(({ fileId, location }) => `${fileNameById.get(fileId) || fileId}：${location.previous_sentence || ''}`).join('；'),
      ];
    }),
  ];
  appendWorksheet(workbook, duplicateSheetNames[5], imageRows, [8, 40, 34, 48, 64, 72], 0);
  return workbook;
}

function workbookToBuffer(workbook) {
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer', compression: true });
}

function createCheckResultExportService({
  app,
  dialog,
  rejectionCheckStore,
  duplicateCheckStore,
  fileSystem = fs,
  now = () => new Date(),
}) {
  async function saveWorkbook({ title, defaultFileName, workbook }) {
    const defaultDir = app?.getPath ? app.getPath('downloads') : process.env.USERPROFILE || process.cwd();
    const saveResult = await dialog.showSaveDialog({
      title,
      defaultPath: path.join(defaultDir, sanitizeFileName(defaultFileName)),
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
    });
    if (saveResult.canceled || !saveResult.filePath) {
      return { success: false, canceled: true, message: '已取消导出' };
    }
    const outputPath = ensureXlsxPath(saveResult.filePath);
    fileSystem.writeFileSync(outputPath, workbookToBuffer(workbook));
    return { success: true, path: outputPath, message: 'Excel 已导出' };
  }

  async function exportRejectionExcel(request) {
    try {
      const state = rejectionCheckStore.loadRejectionCheck();
      const selected = selectCurrentRejectionResults(state, request);
      if (!selected.exportable) return { success: false, message: '没有可导出的当前废标检查结果' };
      const exportedAt = now();
      const workbook = buildRejectionWorkbook(state, request, { exportedAt });
      return await saveWorkbook({
        title: '导出废标检查结果',
        defaultFileName: `废标检查结果_${formatFileTimestamp(exportedAt)}.xlsx`,
        workbook,
      });
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : '废标检查结果导出失败' };
    }
  }

  async function exportDuplicateExcel(request) {
    try {
      const state = duplicateCheckStore.loadDuplicateCheck();
      const selected = selectCurrentDuplicateResults(state, request);
      if (!selected.exportable) return { success: false, message: '没有可导出的当前标书查重结果' };
      const exportedAt = now();
      const workbook = buildDuplicateWorkbook(state, request, { exportedAt });
      return await saveWorkbook({
        title: '导出标书查重结果',
        defaultFileName: `标书查重结果_${formatFileTimestamp(exportedAt)}.xlsx`,
        workbook,
      });
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : '标书查重结果导出失败' };
    }
  }

  return { exportRejectionExcel, exportDuplicateExcel };
}

module.exports = {
  createCheckResultExportService,
  __test__: {
    buildRejectionWorkbook,
    buildDuplicateWorkbook,
    selectCurrentRejectionResults,
    selectCurrentDuplicateResults,
    normalizeCellText,
    sanitizeFileName,
    ensureXlsxPath,
    workbookToBuffer,
  },
};
