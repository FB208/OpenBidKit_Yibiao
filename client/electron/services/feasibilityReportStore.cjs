const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getWorkspaceDir } = require('../utils/paths.cjs');
const { deleteImportedImageBatches } = require('../utils/importedImages.cjs');
const { FEASIBILITY_OUTLINE_AGENT_TASK_KEY } = require('./feasibilityOutlineAgentConfig.cjs');

const SOURCE_FILES_RELATIVE_DIR = path.join('feasibility-report', 'sources').replace(/\\/g, '/');
const TASK_FIELD_TYPES = {
  analysisTask: 'feasibility-analysis',
  outlineTask: 'feasibility-outline',
  outlineAdjustmentTask: 'feasibility-outline-adjustment',
  parametersTask: 'feasibility-parameters',
  contentTask: 'feasibility-content',
  humanWritingTask: 'feasibility-human-writing',
};
const TASK_TYPE_FIELDS = Object.fromEntries(Object.entries(TASK_FIELD_TYPES).map(([field, type]) => [type, field]));
const ALL_TASK_TYPES = Object.values(TASK_FIELD_TYPES);
const STEPS = new Set(['materials', 'sources', 'analysis', 'outline', 'parameters', 'content']);
const PROJECT_TYPES = new Set(['government', 'enterprise']);
const OUTLINE_TEMPLATES = new Set([
  'government',
  'enterprise',
  'industrial',
  'hi_tech',
  'infrastructure',
  'eco_environmental',
  'commercial_realestate',
]);
const OUTLINE_SAVE_REASONS = new Set(['sort', 'edit', 'delete', 'add-root', 'add-child', 'replace']);
const emptyProjectInfo = Object.freeze({
  projectName: '',
  projectType: 'government',
  industry: '',
  constructionUnit: '',
  location: '',
  constructionContent: '',
  constructionPeriodYears: '',
  operationPeriodYears: '',
  totalInvestment: '',
  fundingSource: '',
});

function now() {
  return new Date().toISOString();
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value || {}, field);
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonOrNull(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function stableHash(content) {
  return crypto.createHash('sha1').update(String(content || ''), 'utf8').digest('hex');
}

function toDbBool(value) {
  return value ? 1 : 0;
}

function fromDbBool(value) {
  return Boolean(value);
}

function normalizeStatus(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeStep(value) {
  return STEPS.has(value) ? value : 'materials';
}

function normalizeTemplate(value) {
  return OUTLINE_TEMPLATES.has(value) ? value : 'government';
}

function normalizeTargetWords(value) {
  const words = Math.round(Number(value) || 0);
  return words >= 1000 ? words : 30000;
}

function normalizeProjectInfo(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    projectName: String(source.projectName || '').trim(),
    projectType: PROJECT_TYPES.has(source.projectType) ? source.projectType : 'government',
    industry: String(source.industry || '').trim(),
    constructionUnit: String(source.constructionUnit || '').trim(),
    location: String(source.location || '').trim(),
    constructionContent: String(source.constructionContent || '').trim(),
    constructionPeriodYears: String(source.constructionPeriodYears || '').trim(),
    operationPeriodYears: String(source.operationPeriodYears || '').trim(),
    totalInvestment: String(source.totalInvestment || '').trim(),
    fundingSource: String(source.fundingSource || '').trim(),
  };
}

function normalizeDocumentIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function normalizeOutlineSaveReason(value) {
  return OUTLINE_SAVE_REASONS.has(value) ? value : 'replace';
}

function normalizeStringMap(value) {
  const map = new Map();
  const entries = value && typeof value === 'object' ? Object.entries(value) : [];
  for (const [from, to] of entries) {
    const fromId = String(from || '').trim();
    const toId = String(to || '').trim();
    if (fromId && toId) map.set(fromId, toId);
  }
  return map;
}

function normalizeStringSet(value) {
  return new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean));
}

function reverseIdMap(idMap) {
  const reversed = new Map();
  for (const [oldId, newId] of idMap.entries()) {
    reversed.set(newId, oldId);
  }
  return reversed;
}

function flattenOutlineItems(items, parentNodeId = null, level = 1, rows = []) {
  (items || []).forEach((item, index) => {
    const nodeId = String(item?.id || '').trim();
    if (!nodeId) return;
    rows.push({
      node_id: nodeId,
      parent_node_id: parentNodeId,
      sort_order: index,
      level,
      title: String(item?.title || '未命名章节').trim() || '未命名章节',
      description: String(item?.description || '').trim(),
      knowledge_item_ids_json: Array.isArray(item?.knowledge_item_ids) && item.knowledge_item_ids.length
        ? JSON.stringify(item.knowledge_item_ids)
        : null,
      content: String(item?.content || ''),
    });
    if (item?.children?.length) {
      flattenOutlineItems(item.children, nodeId, level + 1, rows);
    }
  });
  return rows;
}

function mapOutlineItems(items, mapper) {
  return (items || []).map((item) => {
    const nextItem = mapper(item);
    if (item?.children?.length) {
      nextItem.children = mapOutlineItems(item.children, mapper);
    }
    return nextItem;
  });
}

function clearOutlineItemContent(items) {
  return (items || []).map((item) => ({
    ...item,
    content: '',
    children: item?.children?.length ? clearOutlineItemContent(item.children) : item.children,
  }));
}

async function runBeforeCommit(beforeCommit) {
  if (typeof beforeCommit === 'function') {
    await beforeCommit();
  }
}

function createFeasibilityReportStore({ app, db, fileService, taskLogStore, agentService }) {
  const workspaceDir = getWorkspaceDir(app);
  let agentWorkspaceChangeListener = null;
  let lastAgentWorkspaceSignal = null;

  function deleteFeasibilityOutlineAgentTask() {
    agentService?.deletePersistentTask?.(FEASIBILITY_OUTLINE_AGENT_TASK_KEY);
  }

  function setAgentWorkspaceChangeListener(listener) {
    agentWorkspaceChangeListener = typeof listener === 'function' ? listener : null;
  }

  function getAgentWorkspaceSignal() {
    const meta = ensureMetaRow();
    const hasOutline = Boolean(db.prepare('SELECT 1 FROM feasibility_report_outline_nodes LIMIT 1').get());
    return `${meta.step || ''}|${hasOutline ? 1 : 0}`;
  }

  function notifyAgentWorkspaceChange(options = {}) {
    const signal = getAgentWorkspaceSignal();
    if (!options.force && signal === lastAgentWorkspaceSignal) return;
    lastAgentWorkspaceSignal = signal;
    if (!agentWorkspaceChangeListener) return;
    try {
      agentWorkspaceChangeListener();
    } catch (error) {
      console.error('[feasibility-report] Agent 工作空间变更通知失败:', error);
    }
  }

  function ensureMetaRow() {
    const existing = db.prepare('SELECT * FROM feasibility_report_meta WHERE id = 1').get();
    if (existing) return existing;
    const timestamp = now();
    db.prepare(`
      INSERT INTO feasibility_report_meta (
        id, step, project_info_json, source_files_json, analysis_markdown, outline_template, target_words,
        reference_document_ids_json, key_parameters_markdown, outline_project_name, outline_project_overview, created_at, updated_at
      ) VALUES (1, 'materials', NULL, NULL, NULL, 'government', 30000, NULL, NULL, NULL, NULL, @created_at, @updated_at)
    `).run({ created_at: timestamp, updated_at: timestamp });
    return db.prepare('SELECT * FROM feasibility_report_meta WHERE id = 1').get();
  }

  function updateMeta(partial) {
    const current = ensureMetaRow();
    const next = { ...current, ...partial, updated_at: now() };
    db.prepare(`
      UPDATE feasibility_report_meta SET
        step = @step,
        project_info_json = @project_info_json,
        source_files_json = @source_files_json,
        analysis_markdown = @analysis_markdown,
        outline_template = @outline_template,
        target_words = @target_words,
        reference_document_ids_json = @reference_document_ids_json,
        key_parameters_markdown = @key_parameters_markdown,
        outline_project_name = @outline_project_name,
        outline_project_overview = @outline_project_overview,
        updated_at = @updated_at
      WHERE id = 1
    `).run(next);
  }

  function taskFromRow(row) {
    if (!row) return undefined;
    return {
      task_id: row.task_id,
      type: row.type,
      status: normalizeStatus(row.status, ['running', 'pausing', 'paused', 'success', 'error'], 'running'),
      progress: Number(row.progress || 0),
      logs: taskLogStore.list('feasibility-report', row.type, row.task_id),
      started_at: row.started_at,
      updated_at: row.updated_at,
      error: row.error || undefined,
      stats: safeJsonParse(row.stats_json, undefined),
      pause_requested: fromDbBool(row.pause_requested),
    };
  }

  function saveTask(type, task) {
    if (!task) {
      db.prepare('DELETE FROM feasibility_report_tasks WHERE type = ?').run(type);
      taskLogStore.sync('feasibility-report', type, '', [], now());
      return;
    }
    const timestamp = now();
    db.prepare(`
      INSERT INTO feasibility_report_tasks (type, task_id, status, progress, stats_json, error, pause_requested, started_at, updated_at)
      VALUES (@type, @task_id, @status, @progress, @stats_json, @error, @pause_requested, @started_at, @updated_at)
      ON CONFLICT(type) DO UPDATE SET
        task_id = excluded.task_id,
        status = excluded.status,
        progress = excluded.progress,
        stats_json = excluded.stats_json,
        error = excluded.error,
        pause_requested = excluded.pause_requested,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `).run({
      type,
      task_id: String(task.task_id || ''),
      status: String(task.status || 'running'),
      progress: Math.max(0, Math.min(100, Math.round(Number(task.progress || 0)))),
      stats_json: jsonOrNull(task.stats),
      error: task.error ? String(task.error) : null,
      pause_requested: toDbBool(task.pause_requested),
      started_at: task.started_at || timestamp,
      updated_at: task.updated_at || timestamp,
    });
    taskLogStore.sync('feasibility-report', type, String(task.task_id || ''), task.logs, task.updated_at || timestamp);
  }

  function loadTasks() {
    const tasks = {};
    for (const row of db.prepare('SELECT * FROM feasibility_report_tasks').all()) {
      const field = TASK_TYPE_FIELDS[row.type];
      if (field) tasks[field] = taskFromRow(row);
    }
    return tasks;
  }

  function deleteTasks(types = ALL_TASK_TYPES) {
    for (const type of types) saveTask(type, null);
  }

  function loadOutlineData(meta) {
    const rows = db.prepare('SELECT * FROM feasibility_report_outline_nodes ORDER BY level ASC, parent_node_id ASC, sort_order ASC').all();
    if (!rows.length) return null;
    const map = new Map();
    for (const row of rows) {
      map.set(row.node_id, {
        id: row.node_id,
        title: row.title,
        description: row.description || '',
        knowledge_item_ids: safeJsonParse(row.knowledge_item_ids_json, undefined),
        content: row.content || '',
        children: [],
      });
    }
    const roots = [];
    for (const row of rows) {
      const item = map.get(row.node_id);
      if (!item) continue;
      if (row.parent_node_id && map.has(row.parent_node_id)) {
        map.get(row.parent_node_id).children.push(item);
      } else {
        roots.push(item);
      }
    }
    function cleanup(item) {
      if (!item.children.length) delete item.children;
      else item.children.forEach(cleanup);
      if (!item.knowledge_item_ids?.length) delete item.knowledge_item_ids;
      if (!item.content) delete item.content;
      return item;
    }
    return {
      outline: roots.map(cleanup),
      project_name: meta.outline_project_name || undefined,
      project_overview: meta.outline_project_overview || undefined,
    };
  }

  function saveOutlineData(outlineData) {
    if (!outlineData?.outline?.length) {
      db.prepare('DELETE FROM feasibility_report_outline_nodes').run();
      updateMeta({ outline_project_name: null, outline_project_overview: null });
      return;
    }
    const rows = flattenOutlineItems(outlineData.outline);
    const nextIds = new Set(rows.map((row) => row.node_id));
    const timestamp = now();
    const upsert = db.prepare(`
      INSERT INTO feasibility_report_outline_nodes (
        node_id, parent_node_id, sort_order, level, title, description, knowledge_item_ids_json, content, created_at, updated_at
      ) VALUES (
        @node_id, @parent_node_id, @sort_order, @level, @title, @description, @knowledge_item_ids_json, @content, @created_at, @updated_at
      ) ON CONFLICT(node_id) DO UPDATE SET
        parent_node_id = excluded.parent_node_id,
        sort_order = excluded.sort_order,
        level = excluded.level,
        title = excluded.title,
        description = excluded.description,
        knowledge_item_ids_json = excluded.knowledge_item_ids_json,
        content = excluded.content,
        updated_at = excluded.updated_at
    `);
    for (const row of rows) {
      upsert.run({ ...row, created_at: timestamp, updated_at: timestamp });
    }
    const existing = db.prepare('SELECT node_id FROM feasibility_report_outline_nodes').all();
    for (const row of existing) {
      if (!nextIds.has(row.node_id)) {
        db.prepare('DELETE FROM feasibility_report_outline_nodes WHERE node_id = ?').run(row.node_id);
      }
    }
    updateMeta({
      outline_project_name: outlineData.project_name || null,
      outline_project_overview: outlineData.project_overview || null,
    });
  }

  function loadOutlineSnapshot() {
    const rows = db.prepare('SELECT node_id, content FROM feasibility_report_outline_nodes').all();
    return new Map(rows.map((row) => [row.node_id, { content: row.content || '' }]));
  }

  function loadSourceFiles(meta) {
    return Array.isArray(safeJsonParse(meta.source_files_json, [])) ? safeJsonParse(meta.source_files_json, []) : [];
  }

  function sourceFilePath(file) {
    const relativePath = String(file?.markdownPath || '').replace(/\//g, path.sep).trim();
    return relativePath ? path.join(workspaceDir, relativePath) : '';
  }

  function removeSourceFiles(files) {
    for (const file of files || []) {
      const filePath = sourceFilePath(file);
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  }

  function clearDownstreamFromMaterials() {
    deleteFeasibilityOutlineAgentTask();
    db.prepare('DELETE FROM feasibility_report_outline_nodes').run();
    deleteTasks();
    updateMeta({
      analysis_markdown: null,
      key_parameters_markdown: null,
      outline_project_name: null,
      outline_project_overview: null,
    });
    notifyAgentWorkspaceChange({ force: true });
  }

  function clearDownstreamFromAnalysis() {
    deleteFeasibilityOutlineAgentTask();
    db.prepare('DELETE FROM feasibility_report_outline_nodes').run();
    deleteTasks(['feasibility-outline', 'feasibility-outline-adjustment', 'feasibility-parameters', 'feasibility-content', 'feasibility-human-writing']);
    updateMeta({
      key_parameters_markdown: null,
      outline_project_name: null,
      outline_project_overview: null,
    });
    notifyAgentWorkspaceChange({ force: true });
  }

  function clearDownstreamFromOutline() {
    deleteTasks(['feasibility-parameters', 'feasibility-content', 'feasibility-human-writing']);
    updateMeta({ key_parameters_markdown: null });
  }

  function clearDownstreamFromParameters() {
    deleteTasks(['feasibility-content', 'feasibility-human-writing']);
    const outlineData = loadOutlineData(ensureMetaRow());
    if (outlineData?.outline?.length) {
      saveOutlineData({ ...outlineData, outline: clearOutlineItemContent(outlineData.outline) });
    }
  }

  function assertContentUnlocked() {
    const tasks = loadTasks();
    const locked = [tasks.contentTask, tasks.humanWritingTask].some((task) => ['running', 'pausing', 'paused'].includes(task?.status));
    if (locked) {
      throw new Error('正文生成或审校任务正在运行或已暂停，当前不能修改目录或手工改正文');
    }
  }

  function loadFeasibilityReport() {
    const meta = ensureMetaRow();
    const tasks = loadTasks();
    return {
      step: normalizeStep(meta.step),
      projectInfo: normalizeProjectInfo(safeJsonParse(meta.project_info_json, emptyProjectInfo)),
      sourceFiles: loadSourceFiles(meta),
      analysisMarkdown: String(meta.analysis_markdown || ''),
      outlineTemplate: normalizeTemplate(meta.outline_template),
      targetWords: normalizeTargetWords(meta.target_words),
      referenceDocumentIds: normalizeDocumentIds(safeJsonParse(meta.reference_document_ids_json, [])),
      keyParametersMarkdown: String(meta.key_parameters_markdown || ''),
      outlineData: loadOutlineData(meta),
      ...tasks,
    };
  }

  function updateFeasibilityReportWithoutReload(partial = {}) {
    const transaction = db.transaction(() => {
      const metaPatch = {};
      if (hasOwn(partial, 'step')) metaPatch.step = normalizeStep(partial.step);
      if (hasOwn(partial, 'projectInfo')) metaPatch.project_info_json = JSON.stringify(normalizeProjectInfo(partial.projectInfo));
      if (hasOwn(partial, 'sourceFiles')) metaPatch.source_files_json = jsonOrNull(partial.sourceFiles);
      if (hasOwn(partial, 'analysisMarkdown')) metaPatch.analysis_markdown = partial.analysisMarkdown ? String(partial.analysisMarkdown) : null;
      if (hasOwn(partial, 'outlineTemplate')) metaPatch.outline_template = normalizeTemplate(partial.outlineTemplate);
      if (hasOwn(partial, 'targetWords')) metaPatch.target_words = normalizeTargetWords(partial.targetWords);
      if (hasOwn(partial, 'referenceDocumentIds')) metaPatch.reference_document_ids_json = jsonOrNull(normalizeDocumentIds(partial.referenceDocumentIds));
      if (hasOwn(partial, 'keyParametersMarkdown')) metaPatch.key_parameters_markdown = partial.keyParametersMarkdown ? String(partial.keyParametersMarkdown) : null;
      if (Object.keys(metaPatch).length) updateMeta(metaPatch);
      if (hasOwn(partial, 'outlineData')) saveOutlineData(partial.outlineData);
      for (const [field, type] of Object.entries(TASK_FIELD_TYPES)) {
        if (hasOwn(partial, field)) saveTask(type, partial[field] || null);
      }
    });
    transaction();
    const deletedAgentSessions = hasOwn(partial, 'outlineData') && partial.outlineData === null;
    if (deletedAgentSessions) {
      deleteFeasibilityOutlineAgentTask();
    }
    if (deletedAgentSessions || hasOwn(partial, 'step') || hasOwn(partial, 'outlineData')) {
      notifyAgentWorkspaceChange({ force: deletedAgentSessions });
    }
  }

  function updateStep(step) {
    updateMeta({ step: normalizeStep(step) });
    notifyAgentWorkspaceChange();
  }

  function saveProjectInfo(projectInfo, options = {}) {
    const next = normalizeProjectInfo(projectInfo);
    if (!next.projectName) throw new Error('请填写项目名称');
    const transaction = db.transaction(() => {
      updateMeta({ project_info_json: JSON.stringify(next) });
      if (options.clearDownstream) clearDownstreamFromMaterials();
    });
    transaction();
    return loadFeasibilityReport();
  }

  function saveAnalysis(markdown) {
    const analysisMarkdown = String(markdown || '').trim();
    const transaction = db.transaction(() => {
      updateMeta({ analysis_markdown: analysisMarkdown || null });
      clearDownstreamFromAnalysis();
    });
    transaction();
    return loadFeasibilityReport();
  }

  function saveOutlineConfig(payload = {}) {
    updateMeta({
      outline_template: normalizeTemplate(payload.outlineTemplate),
      target_words: normalizeTargetWords(payload.targetWords),
      reference_document_ids_json: jsonOrNull(normalizeDocumentIds(payload.referenceDocumentIds)),
    });
    return loadFeasibilityReport();
  }

  function saveOutline(payload) {
    const request = payload?.outlineData ? payload : { outlineData: payload, reason: 'replace' };
    const reason = normalizeOutlineSaveReason(request.reason);
    const idMap = normalizeStringMap(request.idMap);
    const reverseMap = reverseIdMap(idMap);
    const affectedIds = normalizeStringSet(request.affectedNodeIds);
    const clearAll = reason === 'replace';
    assertContentUnlocked();
    let savedOutlineData = request.outlineData;
    const transaction = db.transaction(() => {
      if (reason === 'sort') {
        saveOutlineData(request.outlineData);
        savedOutlineData = loadOutlineData(ensureMetaRow());
        return;
      }
      const snapshot = loadOutlineSnapshot();
      const outlineToSave = {
        ...request.outlineData,
        outline: mapOutlineItems(request.outlineData?.outline || [], (item) => {
          const oldId = reverseMap.get(item.id) || item.id;
          const affected = clearAll || affectedIds.has(item.id) || affectedIds.has(oldId);
          const previous = snapshot.get(oldId) || snapshot.get(item.id);
          return {
            ...item,
            content: affected ? '' : (item.content || previous?.content || ''),
          };
        }),
      };
      saveOutlineData(outlineToSave);
      savedOutlineData = loadOutlineData(ensureMetaRow());
      if (reason !== 'sort') clearDownstreamFromOutline();
    });
    transaction();
    notifyAgentWorkspaceChange({ force: true });
    return {
      outlineData: savedOutlineData,
      keyParametersMarkdown: reason === 'sort' ? String(ensureMetaRow().key_parameters_markdown || '') : '',
      parametersTask: undefined,
      contentTask: undefined,
      humanWritingTask: undefined,
    };
  }

  function saveKeyParameters(markdown) {
    const keyParametersMarkdown = String(markdown || '').trim();
    const transaction = db.transaction(() => {
      updateMeta({ key_parameters_markdown: keyParametersMarkdown || null });
      clearDownstreamFromParameters();
    });
    transaction();
    return loadFeasibilityReport();
  }

  function saveChapterContent({ nodeId, content }) {
    assertContentUnlocked();
    const id = String(nodeId || '').trim();
    if (!id) throw new Error('缺少章节编号');
    const timestamp = now();
    const result = db.prepare(`
      UPDATE feasibility_report_outline_nodes SET content = ?, updated_at = ? WHERE node_id = ?
    `).run(String(content || ''), timestamp, id);
    if (!result.changes) throw new Error('未找到要保存的章节');
    return { outlineData: loadOutlineData(ensureMetaRow()) };
  }

  async function importSourceDocuments(filePaths, options = {}) {
    if (!fileService?.importTechnicalPlanDocument) {
      throw new Error('文件导入服务尚未初始化');
    }
    const result = await fileService.importTechnicalPlanDocument('可研资料', {
      filePaths,
      multiple: true,
      assetScopePrefix: 'feasibility-report',
    });
    if (!result?.success) {
      return { success: false, message: result?.message || '未导入文件' };
    }
    const documents = Array.isArray(result.documents) && result.documents.length
      ? result.documents
      : [{ file_content: result.file_content, file_name: result.file_name, parser_label: result.parser_label }];
    await runBeforeCommit(options.beforeCommit);
    const previous = loadSourceFiles(ensureMetaRow());
    removeSourceFiles(previous);
    deleteImportedImageBatches(app, 'feasibility-report');
    const timestamp = now();
    const sourceFiles = documents.map((document) => {
      const id = crypto.randomUUID();
      const relativePath = `${SOURCE_FILES_RELATIVE_DIR}/${id}.md`;
      const filePath = sourceFilePath({ markdownPath: relativePath });
      const markdown = String(document.file_content || '').trim();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${markdown}\n`, 'utf-8');
      return {
        id,
        fileName: document.file_name || '未命名文件',
        markdownPath: relativePath,
        markdownChars: markdown.length,
        contentHash: stableHash(markdown),
        parserLabel: document.parser_label || null,
        importedAt: timestamp,
      };
    });
    const transaction = db.transaction(() => {
      updateMeta({ source_files_json: JSON.stringify(sourceFiles) });
      clearDownstreamFromMaterials();
    });
    transaction();
    return {
      success: true,
      message: result.message || `已导入 ${sourceFiles.length} 份资料`,
      sourceFiles,
    };
  }

  async function removeSourceDocument(sourceId, options = {}) {
    const id = String(sourceId || '').trim();
    const current = loadSourceFiles(ensureMetaRow());
    const target = current.find((file) => file.id === id);
    if (!target) return { success: false, message: '未找到要移除的资料' };
    await runBeforeCommit(options.beforeCommit);
    removeSourceFiles([target]);
    const remaining = current.filter((file) => file.id !== id);
    const transaction = db.transaction(() => {
      updateMeta({ source_files_json: remaining.length ? JSON.stringify(remaining) : null });
      clearDownstreamFromMaterials();
    });
    transaction();
    return { success: true, message: '已移除资料', sourceFiles: remaining };
  }

  function readSourceMarkdown(sourceId) {
    const file = loadSourceFiles(ensureMetaRow()).find((item) => item.id === String(sourceId || '').trim());
    if (!file) return '';
    const filePath = sourceFilePath(file);
    return filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  }

  function readCombinedSourceMarkdown() {
    return loadSourceFiles(ensureMetaRow()).map((file) => {
      const markdown = String(readSourceMarkdown(file.id) || '').trim();
      return markdown ? `## ${file.fileName}\n\n${markdown}` : '';
    }).filter(Boolean).join('\n\n');
  }

  function clearFeasibilityReport() {
    const files = loadSourceFiles(ensureMetaRow());
    removeSourceFiles(files);
    deleteImportedImageBatches(app, 'feasibility-report');
    deleteFeasibilityOutlineAgentTask();
    const timestamp = now();
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM feasibility_report_outline_nodes').run();
      deleteTasks();
      db.prepare(`
        UPDATE feasibility_report_meta SET
          step = 'materials',
          project_info_json = NULL,
          source_files_json = NULL,
          analysis_markdown = NULL,
          outline_template = 'government',
          target_words = 30000,
          reference_document_ids_json = NULL,
          key_parameters_markdown = NULL,
          outline_project_name = NULL,
          outline_project_overview = NULL,
          updated_at = ?
        WHERE id = 1
      `).run(timestamp);
    });
    transaction();
    notifyAgentWorkspaceChange({ force: true });
    return { success: true, message: '已重置可研报告工作区' };
  }

  return {
    loadFeasibilityReport,
    updateFeasibilityReportWithoutReload,
    updateStep,
    saveProjectInfo,
    saveAnalysis,
    saveOutlineConfig,
    saveOutline,
    saveKeyParameters,
    saveChapterContent,
    importSourceDocuments,
    removeSourceDocument,
    readSourceMarkdown,
    readCombinedSourceMarkdown,
    clearFeasibilityReport,
    setAgentWorkspaceChangeListener,
  };
}

module.exports = {
  createFeasibilityReportStore,
  feasibilityReportTaskTypes: ALL_TASK_TYPES,
};
