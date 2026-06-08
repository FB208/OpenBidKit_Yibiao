const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getBidAnalysisTasks } = require('./bidAnalysisTask.cjs');
const { getTechnicalPlanOriginalPlanMarkdownPath, getTechnicalPlanTenderMarkdownPath } = require('../utils/paths.cjs');
const { deleteImportedImageBatches } = require('../utils/importedImages.cjs');
const { detectBidSections } = require('../utils/bidSectionDetector.cjs');

const tenderMarkdownRelativePath = path.join('technical-plan', 'tender.md').replace(/\\/g, '/');
const originalPlanMarkdownRelativePath = path.join('technical-plan', 'original-plan.md').replace(/\\/g, '/');

const initialState = {
  workflowKind: 'technical-plan',
  step: 'document-analysis',
  tenderFile: null,
  originalPlanFile: null,
  projectOverview: '',
  techRequirements: '',
  bidAnalysisMode: 'key',
  bidAnalysisSelectedTaskIds: [],
  bidAnalysisTasks: {},
  bidAnalysisProgress: 0,
  outlineMode: 'aligned',
  referenceKnowledgeDocumentIds: [],
  bidAnalysisTask: undefined,
  outlineGenerationTask: undefined,
  globalFactsTask: undefined,
  globalFacts: [],
  contentGenerationTask: undefined,
  contentGenerationOptions: undefined,
  contentGenerationSections: {},
  contentGenerationPlans: {},
  contentGenerationRuntime: undefined,
  outlineData: null,
  pendingSectionSelection: null,
};

const taskFieldTypes = {
  bidAnalysisTask: 'bid-analysis',
  outlineGenerationTask: 'outline-generation',
  globalFactsTask: 'global-facts-generation',
  contentGenerationTask: 'content-generation',
};

const taskTypeFields = Object.fromEntries(Object.entries(taskFieldTypes).map(([field, type]) => [type, field]));

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
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

function toDbBool(value) {
  return value ? 1 : 0;
}

function fromDbBool(value) {
  return Number(value) === 1;
}

function normalizeStatus(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeWorkflowKind(value) {
  return value === 'existing-plan-expansion' ? 'existing-plan-expansion' : 'technical-plan';
}

function isValidStep(value) {
  return ['document-analysis', 'bid-analysis', 'outline-generation', 'global-facts', 'content-edit', 'expand'].includes(value);
}

function normalizeGlobalFactId(value, index) {
  const id = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return id || `fact_${String(index + 1).padStart(3, '0')}`;
}

function isValidBidMode(value) {
  return value === 'key' || value === 'full' || value === 'custom';
}

function getAllBidAnalysisTasks() {
  return getBidAnalysisTasks('full');
}

function getRequiredBidAnalysisTaskIds() {
  return getBidAnalysisTasks('key').map((task) => task.id);
}

function normalizeBidAnalysisTaskIds(taskIds) {
  const requestedIds = new Set((Array.isArray(taskIds) ? taskIds : [])
    .map((taskId) => String(taskId || '').trim())
    .filter(Boolean));
  return getAllBidAnalysisTasks()
    .filter((task) => requestedIds.has(task.id))
    .map((task) => task.id);
}

function normalizeBidAnalysisConfig(mode, selectedTaskIds) {
  const allTaskIds = getAllBidAnalysisTasks().map((task) => task.id);
  const requiredTaskIds = getRequiredBidAnalysisTaskIds();
  const requiredSet = new Set(requiredTaskIds);
  const selectedSet = new Set([...requiredTaskIds, ...normalizeBidAnalysisTaskIds(selectedTaskIds)]);
  const selectedIds = allTaskIds.filter((taskId) => selectedSet.has(taskId));
  const hasOptional = selectedIds.some((taskId) => !requiredSet.has(taskId));
  const hasAll = selectedIds.length === allTaskIds.length;

  if (mode === 'full' || hasAll) {
    return { mode: 'full', selectedTaskIds: allTaskIds };
  }
  if (mode === 'custom' || hasOptional) {
    return { mode: 'custom', selectedTaskIds: selectedIds };
  }
  return { mode: 'key', selectedTaskIds: requiredTaskIds };
}

function getBidAnalysisTaskIdsForConfig(mode, selectedTaskIds) {
  return normalizeBidAnalysisConfig(mode, selectedTaskIds).selectedTaskIds;
}

function isValidOutlineMode(value) {
  return value === 'free' || value === 'aligned';
}

function collectLeafItems(items) {
  return (items || []).flatMap((item) => item?.children?.length ? collectLeafItems(item.children) : [item]);
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
      source_requirement_id: item?.source_requirement_id ? String(item.source_requirement_id) : null,
      source_requirement_title: item?.source_requirement_title ? String(item.source_requirement_title) : null,
      knowledge_item_ids_json: Array.isArray(item?.knowledge_item_ids) && item.knowledge_item_ids.length ? JSON.stringify(item.knowledge_item_ids) : null,
      content: String(item?.content || ''),
    });
    if (item?.children?.length) {
      flattenOutlineItems(item.children, nodeId, level + 1, rows);
    }
  });
  return rows;
}

function clearOutlineItemContent(items) {
  return (items || []).map((item) => ({
    ...item,
    content: '',
    children: item?.children?.length ? clearOutlineItemContent(item.children) : item.children,
  }));
}

function clearOutlineDataContent(outlineData) {
  if (!outlineData?.outline?.length) return outlineData;
  return { ...outlineData, outline: clearOutlineItemContent(outlineData.outline) };
}

const outlineSaveReasons = new Set(['sort', 'edit', 'delete', 'add-root', 'add-child', 'replace']);

function normalizeOutlineSaveReason(value) {
  return outlineSaveReasons.has(value) ? value : 'replace';
}

function normalizeStringMap(value) {
  const entries = value && typeof value === 'object' ? Object.entries(value) : [];
  const map = new Map();
  for (const [from, to] of entries) {
    const fromId = String(from || '').trim();
    const toId = String(to || '').trim();
    if (fromId && toId) map.set(fromId, toId);
  }
  return map;
}

function normalizeStringSet(value) {
  return new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean));
}

function reverseIdMap(idMap) {
  const reversed = new Map();
  for (const [oldId, newId] of idMap.entries()) {
    reversed.set(newId, oldId);
  }
  return reversed;
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

function createTechnicalPlanStore({ app, db, fileService }) {
  const tenderMarkdownPath = getTechnicalPlanTenderMarkdownPath(app);
  const originalPlanMarkdownPath = getTechnicalPlanOriginalPlanMarkdownPath(app);
  const workspaceRootPath = path.dirname(path.dirname(tenderMarkdownPath));
  let pendingTenderSelection = null;

  function toWorkspaceRelativePath(filePath) {
    return path.relative(workspaceRootPath, filePath).replace(/\\/g, '/');
  }

  function resolvePendingTenderMarkdownPath(filePath) {
    return path.resolve(resolveMarkdownPath(filePath));
  }

  function isPendingTenderMarkdownPath(filePath) {
    const resolvedPath = resolvePendingTenderMarkdownPath(filePath);
    const expectedDir = path.resolve(path.dirname(tenderMarkdownPath));
    return path.dirname(resolvedPath).toLowerCase() === expectedDir.toLowerCase()
      && /^tender-pending-\d+\.tmp\.md$/.test(path.basename(resolvedPath));
  }

  function normalizePendingSections(value) {
    return (Array.isArray(value) ? value : [])
      .map((section) => ({
        id: String(section?.id || '').trim(),
        index: Number(section?.index || 0),
        unit: String(section?.unit || '标段').trim() || '标段',
        title: String(section?.title || '').trim(),
        headLine: String(section?.headLine || ''),
        description: String(section?.description || ''),
      }))
      .filter((section) => section.id && section.title);
  }

  function clearPendingTenderMeta() {
    updateMeta({
      pending_tender_markdown_path: null,
      pending_tender_file_name: null,
      pending_tender_parser_label: null,
      pending_tender_sections_json: null,
      pending_tender_total_declared: null,
      pending_tender_created_at: null,
    });
  }

  function cleanupOrphanPendingTenderFiles(activeMarkdownPath = '') {
    const targetDir = path.dirname(tenderMarkdownPath);
    if (!fs.existsSync(targetDir)) {
      return;
    }
    const activePath = activeMarkdownPath ? path.resolve(activeMarkdownPath).toLowerCase() : '';
    for (const fileName of fs.readdirSync(targetDir)) {
      if (!/^tender-pending-\d+\.tmp\.md$/.test(fileName)) {
        continue;
      }
      const filePath = path.join(targetDir, fileName);
      if (activePath && path.resolve(filePath).toLowerCase() === activePath) {
        continue;
      }
      try {
        const stats = fs.lstatSync(filePath);
        if (stats.isFile()) fs.rmSync(filePath, { force: true });
      } catch {
        // 清理孤儿临时文件失败不影响主流程
      }
    }
  }

  function loadPendingTenderSelection(meta = ensureMetaRow()) {
    const pendingPath = String(meta.pending_tender_markdown_path || '').trim();
    const sections = normalizePendingSections(safeJsonParse(meta.pending_tender_sections_json, []));
    if (!pendingPath || !sections.length) {
      cleanupOrphanPendingTenderFiles();
      return null;
    }

    const markdownPath = resolvePendingTenderMarkdownPath(pendingPath);
    if (!isPendingTenderMarkdownPath(markdownPath) || !fs.existsSync(markdownPath)) {
      clearPendingTenderMeta();
      cleanupOrphanPendingTenderFiles();
      return null;
    }

    try {
      const stats = fs.lstatSync(markdownPath);
      if (!stats.isFile()) {
        clearPendingTenderMeta();
        cleanupOrphanPendingTenderFiles();
        return null;
      }
    } catch {
      clearPendingTenderMeta();
      cleanupOrphanPendingTenderFiles();
      return null;
    }

    cleanupOrphanPendingTenderFiles(markdownPath);
    return {
      markdownPath,
      fileName: meta.pending_tender_file_name || '未命名文件',
      parserLabel: meta.pending_tender_parser_label || null,
      sections,
      totalDeclared: meta.pending_tender_total_declared === null || meta.pending_tender_total_declared === undefined
        ? null
        : Number(meta.pending_tender_total_declared),
      createdAt: meta.pending_tender_created_at || undefined,
    };
  }

  function toPendingSectionSelectionState(pendingSelection) {
    if (!pendingSelection) return null;
    return {
      fileName: pendingSelection.fileName,
      parserLabel: pendingSelection.parserLabel || undefined,
      sections: pendingSelection.sections,
      totalDeclared: pendingSelection.totalDeclared,
      createdAt: pendingSelection.createdAt,
    };
  }

  function removePendingTenderMarkdown(markdownPath) {
    const resolvedPath = markdownPath ? resolvePendingTenderMarkdownPath(markdownPath) : '';
    if (!resolvedPath || !isPendingTenderMarkdownPath(resolvedPath) || !fs.existsSync(resolvedPath)) {
      return;
    }
    try {
      const stats = fs.lstatSync(resolvedPath);
      if (stats.isFile()) fs.rmSync(resolvedPath, { force: true });
    } catch {
      // 清理临时文件失败不影响主流程
    }
  }

  function getPendingTenderSelection() {
    const pendingSelection = loadPendingTenderSelection();
    if (!pendingSelection) {
      throw new Error('待选择的招标文件已过期，请重新导入');
    }
    return pendingSelection;
  }

  function cleanupPendingTenderSelection() {
    const meta = ensureMetaRow();
    const pendingPath = meta.pending_tender_markdown_path || pendingTenderSelection?.markdownPath || '';
    const markdownPath = pendingPath ? resolvePendingTenderMarkdownPath(pendingPath) : '';
    pendingTenderSelection = null;
    clearPendingTenderMeta();
    if (!markdownPath || !isPendingTenderMarkdownPath(markdownPath) || !fs.existsSync(markdownPath)) {
      cleanupOrphanPendingTenderFiles();
      return;
    }
    removePendingTenderMarkdown(markdownPath);
    cleanupOrphanPendingTenderFiles();
  }

  function ensureMetaRow() {
    const existing = db.prepare('SELECT * FROM technical_plan_meta WHERE id = 1').get();
    if (existing) return existing;
    const timestamp = now();
    db.prepare(`
      INSERT INTO technical_plan_meta (id, workflow_kind, step, bid_analysis_mode, outline_mode, created_at, updated_at)
      VALUES (1, 'technical-plan', 'document-analysis', 'key', 'aligned', @timestamp, @timestamp)
    `).run({ timestamp });
    return db.prepare('SELECT * FROM technical_plan_meta WHERE id = 1').get();
  }

  function updateMeta(fields) {
    ensureMetaRow();
    const entries = Object.entries(fields || {}).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE technical_plan_meta SET ${assignments}, updated_at = @updated_at WHERE id = 1`).run({
      ...Object.fromEntries(entries),
      updated_at: now(),
    });
  }

  function resolveMarkdownPath(relativeOrAbsolutePath) {
    const value = String(relativeOrAbsolutePath || '').trim();
    if (!value) return tenderMarkdownPath;
    return path.isAbsolute(value) ? value : path.join(path.dirname(path.dirname(tenderMarkdownPath)), value);
  }

  function readTenderMarkdown() {
    const meta = ensureMetaRow();
    const filePath = resolveMarkdownPath(meta.tender_markdown_path || tenderMarkdownRelativePath);
    if (!meta.tender_markdown_path || !fs.existsSync(filePath)) {
      return '';
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  function readOriginalPlanMarkdown() {
    const meta = ensureMetaRow();
    const filePath = resolveMarkdownPath(meta.original_plan_markdown_path || originalPlanMarkdownRelativePath);
    if (!meta.original_plan_markdown_path || !fs.existsSync(filePath)) {
      return '';
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  function loadReferenceDocumentIds() {
    return db.prepare('SELECT document_id FROM technical_plan_reference_docs ORDER BY sort_order ASC').all()
      .map((row) => row.document_id);
  }

  function replaceReferenceDocumentIds(documentIds) {
    db.prepare('DELETE FROM technical_plan_reference_docs').run();
    const insert = db.prepare('INSERT INTO technical_plan_reference_docs (document_id, sort_order) VALUES (@document_id, @sort_order)');
    [...new Set((Array.isArray(documentIds) ? documentIds : []).map((id) => String(id || '').trim()).filter(Boolean))]
      .forEach((documentId, index) => insert.run({ document_id: documentId, sort_order: index }));
  }

  function taskFromRow(row) {
    if (!row) return undefined;
    return {
      task_id: row.task_id,
      type: row.type,
      status: normalizeStatus(row.status, ['running', 'pausing', 'paused', 'success', 'error'], 'running'),
      progress: Number(row.progress || 0),
      logs: safeJsonParse(row.logs_json, []),
      started_at: row.started_at,
      updated_at: row.updated_at,
      error: row.error || undefined,
      stats: safeJsonParse(row.stats_json, undefined),
      pause_requested: fromDbBool(row.pause_requested),
    };
  }

  function saveTask(type, task) {
    if (!task) {
      db.prepare('DELETE FROM technical_plan_tasks WHERE type = ?').run(type);
      return;
    }
    const timestamp = now();
    db.prepare(`
      INSERT INTO technical_plan_tasks (type, task_id, status, progress, logs_json, stats_json, error, pause_requested, started_at, updated_at)
      VALUES (@type, @task_id, @status, @progress, @logs_json, @stats_json, @error, @pause_requested, @started_at, @updated_at)
      ON CONFLICT(type) DO UPDATE SET
        task_id = excluded.task_id,
        status = excluded.status,
        progress = excluded.progress,
        logs_json = excluded.logs_json,
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
      logs_json: JSON.stringify(Array.isArray(task.logs) ? task.logs : []),
      stats_json: jsonOrNull(task.stats),
      error: task.error ? String(task.error) : null,
      pause_requested: toDbBool(task.pause_requested),
      started_at: task.started_at || timestamp,
      updated_at: task.updated_at || timestamp,
    });
  }

  function loadTasks() {
    const rows = db.prepare('SELECT * FROM technical_plan_tasks').all();
    const tasks = {};
    for (const row of rows) {
      const field = taskTypeFields[row.type];
      if (field) tasks[field] = taskFromRow(row);
    }
    return tasks;
  }

  function loadBidItems() {
    const rows = db.prepare('SELECT * FROM technical_plan_bid_items ORDER BY sort_order ASC, item_id ASC').all();
    return rows.reduce((acc, row) => {
      acc[row.item_id] = {
        id: row.item_id,
        label: row.label,
        status: normalizeStatus(row.status, ['idle', 'running', 'success', 'error'], 'idle'),
        content: row.content || '',
        error: row.error || undefined,
      };
      return acc;
    }, {});
  }

  function getBidItemSortOrder(itemId) {
    const fullTasks = getAllBidAnalysisTasks();
    const index = fullTasks.findIndex((task) => task.id === itemId);
    return index >= 0 ? index : 9999;
  }

  function getBidItemLabel(itemId, fallbackLabel) {
    const task = getBidAnalysisTasks('full').find((item) => item.id === itemId) || getBidAnalysisTasks('key').find((item) => item.id === itemId);
    return fallbackLabel || task?.label || itemId;
  }

  function saveBidItems(tasks, mode) {
    const entries = Object.entries(tasks || {});
    if (!entries.length) {
      db.prepare('DELETE FROM technical_plan_bid_items').run();
      return;
    }

    const upsert = db.prepare(`
      INSERT INTO technical_plan_bid_items (item_id, label, status, content, error, sort_order, updated_at)
      VALUES (@item_id, @label, @status, @content, @error, @sort_order, @updated_at)
      ON CONFLICT(item_id) DO UPDATE SET
        label = excluded.label,
        status = excluded.status,
        content = excluded.content,
        error = excluded.error,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
    `);
    const timestamp = now();
    for (const [itemId, task] of entries) {
      upsert.run({
        item_id: itemId,
        label: getBidItemLabel(itemId, task?.label),
        status: normalizeStatus(task?.status, ['idle', 'running', 'success', 'error'], 'idle'),
        content: String(task?.content || ''),
        error: task?.error ? String(task.error) : null,
        sort_order: getBidItemSortOrder(itemId, mode),
        updated_at: task?.updated_at || timestamp,
      });
    }
  }

  function upsertDerivedBidItem(itemId, content, mode) {
    const label = getBidItemLabel(itemId);
    const value = String(content || '');
    db.prepare(`
      INSERT INTO technical_plan_bid_items (item_id, label, status, content, error, sort_order, updated_at)
      VALUES (@item_id, @label, @status, @content, NULL, @sort_order, @updated_at)
      ON CONFLICT(item_id) DO UPDATE SET
        label = excluded.label,
        status = excluded.status,
        content = excluded.content,
        error = NULL,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
    `).run({
      item_id: itemId,
      label,
      status: value.trim() ? 'success' : 'idle',
      content: value,
      sort_order: getBidItemSortOrder(itemId, mode),
      updated_at: now(),
    });
  }

  function calculateBidProgress(mode, bidTasks, selectedTaskIds) {
    const selectedIds = getBidAnalysisTaskIdsForConfig(mode, selectedTaskIds);
    if (!selectedIds.length) return 0;
    const done = selectedIds.filter((taskId) => ['success', 'error'].includes(bidTasks[taskId]?.status)).length;
    return Math.round((done / selectedIds.length) * 100);
  }

  function loadOutlineData(meta) {
    const rows = db.prepare('SELECT * FROM technical_plan_outline_nodes ORDER BY level ASC, parent_node_id ASC, sort_order ASC').all();
    if (!rows.length) return null;

    const map = new Map();
    for (const row of rows) {
      map.set(row.node_id, {
        id: row.node_id,
        title: row.title,
        description: row.description || '',
        source_requirement_id: row.source_requirement_id || undefined,
        source_requirement_title: row.source_requirement_title || undefined,
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
      if (!item.children.length) {
        delete item.children;
      } else {
        item.children.forEach(cleanup);
      }
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
      db.prepare('DELETE FROM technical_plan_outline_nodes').run();
      updateMeta({ outline_project_name: null, outline_project_overview: null });
      return;
    }

    const rows = flattenOutlineItems(outlineData.outline);
    const nextIds = new Set(rows.map((row) => row.node_id));
    const upsert = db.prepare(`
      INSERT INTO technical_plan_outline_nodes (
        node_id, parent_node_id, sort_order, level, title, description, source_requirement_id,
        source_requirement_title, knowledge_item_ids_json, content, created_at, updated_at
      ) VALUES (
        @node_id, @parent_node_id, @sort_order, @level, @title, @description, @source_requirement_id,
        @source_requirement_title, @knowledge_item_ids_json, @content, @created_at, @updated_at
      ) ON CONFLICT(node_id) DO UPDATE SET
        parent_node_id = excluded.parent_node_id,
        sort_order = excluded.sort_order,
        level = excluded.level,
        title = excluded.title,
        description = excluded.description,
        source_requirement_id = excluded.source_requirement_id,
        source_requirement_title = excluded.source_requirement_title,
        knowledge_item_ids_json = excluded.knowledge_item_ids_json,
        content = excluded.content,
        updated_at = excluded.updated_at
    `);
    const timestamp = now();
    for (const row of rows) {
      upsert.run({ ...row, created_at: timestamp, updated_at: timestamp });
    }

    const existingIds = db.prepare('SELECT node_id FROM technical_plan_outline_nodes').all().map((row) => row.node_id);
    const deleteNode = db.prepare('DELETE FROM technical_plan_outline_nodes WHERE node_id = ?');
    for (const nodeId of existingIds) {
      if (!nextIds.has(nodeId)) deleteNode.run(nodeId);
    }

    updateMeta({
      outline_project_name: outlineData.project_name || null,
      outline_project_overview: outlineData.project_overview || null,
    });
  }

  function loadContentSections(outlineData) {
    const rows = db.prepare(`
      SELECT s.node_id, s.status, s.error, s.updated_at, n.title, n.content
      FROM technical_plan_content_sections s
      JOIN technical_plan_outline_nodes n ON n.node_id = s.node_id
    `).all();
    const sections = rows.reduce((acc, row) => {
      acc[row.node_id] = {
        id: row.node_id,
        title: row.title || '未命名章节',
        status: normalizeStatus(row.status, ['idle', 'running', 'success', 'error'], 'idle'),
        content: row.content || '',
        error: row.error || undefined,
        updated_at: row.updated_at || undefined,
      };
      return acc;
    }, {});

    for (const item of collectLeafItems(outlineData?.outline || [])) {
      if (!sections[item.id] && item.content?.trim()) {
        sections[item.id] = {
          id: item.id,
          title: item.title || '未命名章节',
          status: 'success',
          content: item.content,
        };
      }
    }

    return sections;
  }

  function saveContentSections(sections) {
    const entries = Object.entries(sections || {});
    if (!entries.length) {
      db.prepare('DELETE FROM technical_plan_content_sections').run();
      return;
    }

    const nextIds = new Set(entries.map(([nodeId]) => nodeId));
    const upsert = db.prepare(`
      INSERT INTO technical_plan_content_sections (node_id, status, error, updated_at)
      VALUES (@node_id, @status, @error, @updated_at)
      ON CONFLICT(node_id) DO UPDATE SET
        status = excluded.status,
        error = excluded.error,
        updated_at = excluded.updated_at
    `);
    const updateContent = db.prepare('UPDATE technical_plan_outline_nodes SET content = @content, updated_at = @updated_at WHERE node_id = @node_id');
    const timestamp = now();
    for (const [nodeId, section] of entries) {
      upsert.run({
        node_id: nodeId,
        status: normalizeStatus(section?.status, ['idle', 'running', 'success', 'error'], 'idle'),
        error: section?.error ? String(section.error) : null,
        updated_at: section?.updated_at || timestamp,
      });
      if (hasOwn(section, 'content')) {
        updateContent.run({ node_id: nodeId, content: String(section.content || ''), updated_at: timestamp });
      }
    }

    const deleteSection = db.prepare('DELETE FROM technical_plan_content_sections WHERE node_id = ?');
    for (const row of db.prepare('SELECT node_id FROM technical_plan_content_sections').all()) {
      if (!nextIds.has(row.node_id)) deleteSection.run(row.node_id);
    }
  }

  function loadContentPlans() {
    return db.prepare('SELECT * FROM technical_plan_content_plans').all().reduce((acc, row) => {
      const plan = safeJsonParse(row.plan_json, null);
      if (plan) {
        acc[row.node_id] = {
          plan,
          illustration_type: row.illustration_type || 'none',
          updated_at: row.updated_at || undefined,
        };
      }
      return acc;
    }, {});
  }

  function normalizeGlobalFactGroups(groups) {
    const seen = new Set();
    return (Array.isArray(groups) ? groups : []).map((group, index) => {
      const title = String(group?.title || '').trim();
      const content = String(group?.content || '').trim();
      if (!title || !content) return null;
      let id = normalizeGlobalFactId(group?.id || group?.group_id || title, index);
      let suffix = 2;
      while (seen.has(id)) {
        id = `${id}_${suffix}`;
        suffix += 1;
      }
      seen.add(id);
      return {
        id,
        title,
        content,
        updated_at: group?.updated_at || group?.updatedAt || now(),
      };
    }).filter(Boolean);
  }

  function loadGlobalFacts() {
    return db.prepare('SELECT * FROM technical_plan_global_fact_groups ORDER BY sort_order ASC, group_id ASC').all().map((row) => ({
      id: row.group_id,
      title: row.title,
      content: row.content || '',
      updated_at: row.updated_at || undefined,
    }));
  }

  function replaceGlobalFacts(groups) {
    const normalized = normalizeGlobalFactGroups(groups);
    db.prepare('DELETE FROM technical_plan_global_fact_groups').run();
    if (!normalized.length) return;

    const insert = db.prepare(`
      INSERT INTO technical_plan_global_fact_groups (group_id, title, content, sort_order, created_at, updated_at)
      VALUES (@group_id, @title, @content, @sort_order, @created_at, @updated_at)
    `);
    const timestamp = now();
    normalized.forEach((group, index) => insert.run({
      group_id: group.id,
      title: group.title,
      content: group.content,
      sort_order: index,
      created_at: timestamp,
      updated_at: group.updated_at || timestamp,
    }));
  }

  function saveContentPlans(plans) {
    const entries = Object.entries(plans || {});
    if (!entries.length) {
      db.prepare('DELETE FROM technical_plan_content_plans').run();
      return;
    }

    const nextIds = new Set(entries.map(([nodeId]) => nodeId));
    const upsert = db.prepare(`
      INSERT INTO technical_plan_content_plans (node_id, plan_json, illustration_type, updated_at)
      VALUES (@node_id, @plan_json, @illustration_type, @updated_at)
      ON CONFLICT(node_id) DO UPDATE SET
        plan_json = excluded.plan_json,
        illustration_type = excluded.illustration_type,
        updated_at = excluded.updated_at
    `);
    const timestamp = now();
    for (const [nodeId, value] of entries) {
      if (!value?.plan) continue;
      upsert.run({
        node_id: nodeId,
        plan_json: JSON.stringify(value.plan),
        illustration_type: value.illustration_type || 'none',
        updated_at: value.updated_at || timestamp,
      });
    }

    const deletePlan = db.prepare('DELETE FROM technical_plan_content_plans WHERE node_id = ?');
    for (const row of db.prepare('SELECT node_id FROM technical_plan_content_plans').all()) {
      if (!nextIds.has(row.node_id)) deletePlan.run(row.node_id);
    }
  }

  function clearDownstreamFromTender() {
    db.prepare('DELETE FROM technical_plan_tasks').run();
    db.prepare('DELETE FROM technical_plan_bid_items').run();
    db.prepare('DELETE FROM technical_plan_reference_docs').run();
    db.prepare('DELETE FROM technical_plan_outline_nodes').run();
    db.prepare('DELETE FROM technical_plan_global_fact_groups').run();
    updateMeta({
      step: 'document-analysis',
      bid_analysis_mode: 'key',
      bid_analysis_selected_task_ids_json: null,
      outline_mode: 'aligned',
      outline_project_name: null,
      outline_project_overview: null,
      content_generation_options_json: null,
      content_generation_runtime_json: null,
      pending_tender_markdown_path: null,
      pending_tender_file_name: null,
      pending_tender_parser_label: null,
      pending_tender_sections_json: null,
      pending_tender_total_declared: null,
      pending_tender_created_at: null,
      selected_section_id: null,
      selected_section_title: null,
      selected_section_head_line: null,
    });
  }

  function clearContentGenerationState() {
    db.prepare("UPDATE technical_plan_outline_nodes SET content = '', updated_at = ?").run(now());
    db.prepare('DELETE FROM technical_plan_content_sections').run();
    db.prepare('DELETE FROM technical_plan_content_plans').run();
    db.prepare("DELETE FROM technical_plan_tasks WHERE type = 'content-generation'").run();
    updateMeta({ content_generation_runtime_json: null });
  }

  function clearDownstreamFromOriginalPlan() {
    db.prepare("DELETE FROM technical_plan_tasks WHERE type IN ('outline-generation', 'global-facts-generation', 'content-generation')").run();
    db.prepare('DELETE FROM technical_plan_outline_nodes').run();
    db.prepare('DELETE FROM technical_plan_global_fact_groups').run();
    db.prepare('DELETE FROM technical_plan_content_sections').run();
    db.prepare('DELETE FROM technical_plan_content_plans').run();
    updateMeta({
      step: 'document-analysis',
      outline_project_name: null,
      outline_project_overview: null,
      content_generation_runtime_json: null,
    });
  }

  function assertNoTechnicalPlanTaskRunning() {
    const row = db.prepare("SELECT type FROM technical_plan_tasks WHERE status IN ('running', 'pausing') LIMIT 1").get();
    if (row) {
      throw new Error('当前有技术方案任务正在运行，请等待任务结束后再切换模式');
    }
  }

  function clearWorkflowSpecificState(workflowKind) {
    db.prepare("DELETE FROM technical_plan_tasks WHERE type IN ('outline-generation', 'global-facts-generation', 'content-generation')").run();
    db.prepare('DELETE FROM technical_plan_content_sections').run();
    db.prepare('DELETE FROM technical_plan_content_plans').run();
    db.prepare('DELETE FROM technical_plan_outline_nodes').run();
    db.prepare('DELETE FROM technical_plan_global_fact_groups').run();
    updateMeta({
      workflow_kind: normalizeWorkflowKind(workflowKind),
      step: 'document-analysis',
      original_plan_file_name: null,
      original_plan_markdown_path: null,
      original_plan_markdown_hash: null,
      original_plan_markdown_chars: 0,
      original_plan_parser_label: null,
      original_plan_imported_at: null,
      outline_project_name: null,
      outline_project_overview: null,
      content_generation_options_json: null,
      content_generation_runtime_json: null,
    });
  }

  function loadOutlinePersistenceSnapshot() {
    return {
      nodes: db.prepare('SELECT node_id, content FROM technical_plan_outline_nodes').all().reduce((acc, row) => {
        acc[row.node_id] = { content: row.content || '' };
        return acc;
      }, {}),
      sections: db.prepare('SELECT node_id, status, error, updated_at FROM technical_plan_content_sections').all(),
      plans: db.prepare('SELECT node_id, plan_json, illustration_type, updated_at FROM technical_plan_content_plans').all(),
    };
  }

  function assertOutlineMutationAllowed() {
    const task = db.prepare("SELECT status FROM technical_plan_tasks WHERE type = 'content-generation'").get();
    if (['running', 'pausing', 'paused'].includes(task?.status)) {
      throw new Error('正文生成任务正在运行或暂停中，请结束后再调整目录');
    }
  }

  function shouldClearSavedNode({ clearAll, oldId, newId, affectedIds }) {
    return clearAll || affectedIds.has(oldId) || (!oldId && affectedIds.has(newId));
  }

  function buildOutlineWithPersistedContent(outlineData, { snapshot, reverseMap, affectedIds, clearAll }) {
    if (!outlineData?.outline?.length) return outlineData;
    return {
      ...outlineData,
      outline: mapOutlineItems(outlineData.outline, (item) => {
        const newId = String(item?.id || '').trim();
        const oldId = reverseMap.get(newId) || newId;
        const clearContent = shouldClearSavedNode({ clearAll, oldId, newId, affectedIds });
        const oldContent = snapshot.nodes[oldId]?.content;
        return {
          ...item,
          content: clearContent ? '' : String(oldContent ?? item?.content ?? ''),
        };
      }),
    };
  }

  function restoreMappedContentRows({ snapshot, idMap, affectedIds, nextIds, clearAll }) {
    db.prepare('DELETE FROM technical_plan_content_sections').run();
    db.prepare('DELETE FROM technical_plan_content_plans').run();

    if (clearAll || !nextIds.size) return;

    const insertSection = db.prepare(`
      INSERT INTO technical_plan_content_sections (node_id, status, error, updated_at)
      VALUES (@node_id, @status, @error, @updated_at)
    `);
    const seenSections = new Set();
    for (const row of snapshot.sections) {
      const oldId = String(row.node_id || '').trim();
      const newId = idMap.get(oldId) || oldId;
      if (!newId || !nextIds.has(newId) || seenSections.has(newId)) continue;
      if (shouldClearSavedNode({ clearAll, oldId, newId, affectedIds })) continue;
      seenSections.add(newId);
      insertSection.run({
        node_id: newId,
        status: normalizeStatus(row.status, ['idle', 'running', 'success', 'error'], 'idle'),
        error: row.error || null,
        updated_at: row.updated_at || now(),
      });
    }

    const insertPlan = db.prepare(`
      INSERT INTO technical_plan_content_plans (node_id, plan_json, illustration_type, updated_at)
      VALUES (@node_id, @plan_json, @illustration_type, @updated_at)
    `);
    const seenPlans = new Set();
    for (const row of snapshot.plans) {
      const oldId = String(row.node_id || '').trim();
      const newId = idMap.get(oldId) || oldId;
      if (!newId || !nextIds.has(newId) || seenPlans.has(newId)) continue;
      if (shouldClearSavedNode({ clearAll, oldId, newId, affectedIds })) continue;
      if (!row.plan_json) continue;
      seenPlans.add(newId);
      insertPlan.run({
        node_id: newId,
        plan_json: row.plan_json,
        illustration_type: row.illustration_type || 'none',
        updated_at: row.updated_at || now(),
      });
    }
  }

  function applyPartial(partial) {
    const meta = ensureMetaRow();
    const metaUpdates = {};

    if (hasOwn(partial, 'workflowKind')) metaUpdates.workflow_kind = normalizeWorkflowKind(partial.workflowKind);
    if (hasOwn(partial, 'step') && isValidStep(partial.step)) metaUpdates.step = partial.step;
    if (hasOwn(partial, 'bidAnalysisMode') && isValidBidMode(partial.bidAnalysisMode)) metaUpdates.bid_analysis_mode = partial.bidAnalysisMode;
    if (hasOwn(partial, 'bidAnalysisSelectedTaskIds')) metaUpdates.bid_analysis_selected_task_ids_json = jsonOrNull(normalizeBidAnalysisTaskIds(partial.bidAnalysisSelectedTaskIds));
    if (hasOwn(partial, 'outlineMode') && isValidOutlineMode(partial.outlineMode)) metaUpdates.outline_mode = partial.outlineMode;
    if (hasOwn(partial, 'contentGenerationOptions')) metaUpdates.content_generation_options_json = jsonOrNull(partial.contentGenerationOptions);
    if (hasOwn(partial, 'contentGenerationRuntime')) metaUpdates.content_generation_runtime_json = jsonOrNull(partial.contentGenerationRuntime);

    if (Object.keys(metaUpdates).length) updateMeta(metaUpdates);

    const nextBidMode = isValidBidMode(partial.bidAnalysisMode) ? partial.bidAnalysisMode : meta.bid_analysis_mode;
    if (hasOwn(partial, 'referenceKnowledgeDocumentIds')) replaceReferenceDocumentIds(partial.referenceKnowledgeDocumentIds);
    if (hasOwn(partial, 'bidAnalysisTasks')) saveBidItems(partial.bidAnalysisTasks, nextBidMode);
    if (hasOwn(partial, 'projectOverview')) upsertDerivedBidItem('projectOverview', partial.projectOverview, nextBidMode);
    if (hasOwn(partial, 'techRequirements')) upsertDerivedBidItem('techRequirements', partial.techRequirements, nextBidMode);
    if (hasOwn(partial, 'globalFacts')) {
      replaceGlobalFacts(partial.globalFacts);
      clearContentGenerationState();
    }

    for (const [field, type] of Object.entries(taskFieldTypes)) {
      if (hasOwn(partial, field)) saveTask(type, partial[field]);
    }

    if (hasOwn(partial, 'outlineData')) {
      if (partial.outlineData === null) {
        db.prepare('DELETE FROM technical_plan_outline_nodes').run();
        updateMeta({ outline_project_name: null, outline_project_overview: null });
      } else {
        saveOutlineData(partial.outlineData);
      }
    }

    if (hasOwn(partial, 'contentGenerationSections')) saveContentSections(partial.contentGenerationSections);
    if (hasOwn(partial, 'contentGenerationPlans')) saveContentPlans(partial.contentGenerationPlans);
  }

  function loadTechnicalPlan() {
    const meta = ensureMetaRow();
    const bidAnalysisMode = isValidBidMode(meta.bid_analysis_mode) ? meta.bid_analysis_mode : 'key';
    const bidAnalysisSelectedTaskIds = getBidAnalysisTaskIdsForConfig(
      bidAnalysisMode,
      safeJsonParse(meta.bid_analysis_selected_task_ids_json, []),
    );
    const bidAnalysisTasks = loadBidItems();
    const outlineData = loadOutlineData(meta);
    const tasks = loadTasks();
    const tenderFile = meta.tender_markdown_path ? {
      fileName: meta.tender_file_name || '技术方案招标文件',
      markdownPath: meta.tender_markdown_path,
      markdownChars: Number(meta.tender_markdown_chars || 0),
      contentHash: meta.tender_markdown_hash || '',
      parserLabel: meta.tender_parser_label || undefined,
      importedAt: meta.tender_imported_at || undefined,
      selectedSectionId: meta.selected_section_id || undefined,
      selectedSectionTitle: meta.selected_section_title || undefined,
      selectedSectionHeadLine: meta.selected_section_head_line || undefined,
      updatedAt: meta.updated_at,
    } : null;
    const originalPlanFile = meta.original_plan_markdown_path ? {
      fileName: meta.original_plan_file_name || '原方案',
      markdownPath: meta.original_plan_markdown_path,
      markdownChars: Number(meta.original_plan_markdown_chars || 0),
      contentHash: meta.original_plan_markdown_hash || '',
      parserLabel: meta.original_plan_parser_label || undefined,
      importedAt: meta.original_plan_imported_at || undefined,
      updatedAt: meta.updated_at,
    } : null;

    return {
      ...initialState,
      workflowKind: normalizeWorkflowKind(meta.workflow_kind),
      step: isValidStep(meta.step) ? meta.step : 'document-analysis',
      tenderFile,
      originalPlanFile,
      projectOverview: bidAnalysisTasks.projectOverview?.status === 'success' ? bidAnalysisTasks.projectOverview.content : '',
      techRequirements: bidAnalysisTasks.techRequirements?.status === 'success' ? bidAnalysisTasks.techRequirements.content : '',
      bidAnalysisMode,
      bidAnalysisSelectedTaskIds,
      bidAnalysisTasks,
      bidAnalysisProgress: calculateBidProgress(bidAnalysisMode, bidAnalysisTasks, bidAnalysisSelectedTaskIds),
      outlineMode: isValidOutlineMode(meta.outline_mode) ? meta.outline_mode : 'aligned',
      referenceKnowledgeDocumentIds: loadReferenceDocumentIds(),
      ...tasks,
      globalFacts: loadGlobalFacts(),
      contentGenerationOptions: safeJsonParse(meta.content_generation_options_json, undefined),
      contentGenerationRuntime: safeJsonParse(meta.content_generation_runtime_json, undefined),
      contentGenerationSections: loadContentSections(outlineData),
      contentGenerationPlans: loadContentPlans(),
      pendingSectionSelection: toPendingSectionSelectionState(loadPendingTenderSelection(meta)),
      outlineData,
    };
  }

  const updateTechnicalPlanTransaction = db.transaction((partial) => {
    applyPartial(partial || {});
  });

  function updateTechnicalPlan(partial) {
    updateTechnicalPlanTransaction(partial || {});
    return loadTechnicalPlan();
  }

  function updateStep(step) {
    return updateTechnicalPlan({ step });
  }

  function setWorkflowKind(workflowKind) {
    return updateTechnicalPlan({ workflowKind: normalizeWorkflowKind(workflowKind) });
  }

  function switchWorkflowKind(workflowKind) {
    const nextWorkflowKind = normalizeWorkflowKind(workflowKind);
    const meta = ensureMetaRow();
    if (normalizeWorkflowKind(meta.workflow_kind) === nextWorkflowKind) {
      return loadTechnicalPlan();
    }

    const originalPlanFilePath = meta.original_plan_markdown_path
      ? resolveMarkdownPath(meta.original_plan_markdown_path)
      : originalPlanMarkdownPath;
    const transaction = db.transaction(() => {
      assertNoTechnicalPlanTaskRunning();
      clearWorkflowSpecificState(nextWorkflowKind);
    });
    transaction();
    if (fs.existsSync(originalPlanFilePath)) {
      fs.rmSync(originalPlanFilePath, { force: true });
    }
    return loadTechnicalPlan();
  }

  function saveOutlineConfig({ outlineMode, referenceKnowledgeDocumentIds } = {}) {
    return updateTechnicalPlan({ outlineMode, referenceKnowledgeDocumentIds });
  }

  function saveBidAnalysisConfig({ mode, selectedTaskIds } = {}) {
    const config = normalizeBidAnalysisConfig(mode, selectedTaskIds);
    return updateTechnicalPlan({
      bidAnalysisMode: config.mode,
      bidAnalysisSelectedTaskIds: config.selectedTaskIds,
    });
  }

  function saveOutline(payload) {
    const request = payload?.outlineData ? payload : { outlineData: payload, reason: 'replace' };
    const outlineData = request?.outlineData;
    const reason = normalizeOutlineSaveReason(request?.reason);
    const idMap = normalizeStringMap(request?.idMap);
    const reverseMap = reverseIdMap(idMap);
    const affectedIds = normalizeStringSet(request?.affectedNodeIds);
    const clearAll = reason === 'replace';
    const invalidatesContentTask = reason !== 'sort';

    const transaction = db.transaction(() => {
      assertOutlineMutationAllowed();
      const snapshot = loadOutlinePersistenceSnapshot();
      const outlineToSave = buildOutlineWithPersistedContent(outlineData, { snapshot, reverseMap, affectedIds, clearAll });
      saveOutlineData(outlineToSave);
      const rows = flattenOutlineItems(outlineToSave?.outline || []);
      const nextIds = new Set(rows.map((row) => row.node_id));
      restoreMappedContentRows({ snapshot, idMap, affectedIds, nextIds, clearAll });
      if (invalidatesContentTask) {
        db.prepare("DELETE FROM technical_plan_tasks WHERE type = 'content-generation'").run();
        updateMeta({ content_generation_runtime_json: null });
      }
    });
    transaction();
    return loadTechnicalPlan();
  }

  function saveGlobalFacts(globalFacts) {
    const transaction = db.transaction(() => {
      replaceGlobalFacts(globalFacts);
      clearContentGenerationState();
      const timestamp = now();
      saveTask('global-facts-generation', {
        task_id: `manual-global-facts-${Date.now()}`,
        type: 'global-facts-generation',
        status: 'success',
        progress: 100,
        logs: ['全局事实已保存。'],
        started_at: timestamp,
        updated_at: timestamp,
      });
    });
    transaction();
    return loadTechnicalPlan();
  }

  function saveContentGenerationOptions(contentGenerationOptions) {
    return updateTechnicalPlan({ contentGenerationOptions });
  }

  function saveChapterContent({ nodeId, content }) {
    const transaction = db.transaction(() => {
      const timestamp = now();
      const node = db.prepare('SELECT node_id, title FROM technical_plan_outline_nodes WHERE node_id = ?').get(nodeId);
      if (!node) throw new Error('当前目录中未找到该章节');
      const nextContent = String(content || '');
      db.prepare('UPDATE technical_plan_outline_nodes SET content = ?, updated_at = ? WHERE node_id = ?').run(nextContent, timestamp, nodeId);
      db.prepare(`
        INSERT INTO technical_plan_content_sections (node_id, status, error, updated_at)
        VALUES (?, ?, NULL, ?)
        ON CONFLICT(node_id) DO UPDATE SET status = excluded.status, error = NULL, updated_at = excluded.updated_at
      `).run(nodeId, nextContent.trim() ? 'success' : 'idle', timestamp);
    });
    transaction();
    return loadTechnicalPlan();
  }

  async function importTenderDocument() {
    if (!fileService?.importDocument) {
      throw new Error('文件导入服务尚未初始化');
    }

    const result = await fileService.importDocument();
    if (!result?.success || !result.file_content) {
      return {
        success: false,
        message: result?.message || '未导入文件',
        state: loadTechnicalPlan(),
        markdown: '',
      };
    }

    const markdown = String(result.file_content || '').trim();
    const fileName = result.file_name || '未命名文件';
    const parserLabel = result.parser_label || null;
    cleanupPendingTenderSelection();
    const sectionDetection = detectBidSections(markdown);

    if (sectionDetection.hasMultiple && sectionDetection.sections.length >= 2) {
      const targetDir = path.dirname(tenderMarkdownPath);
      fs.mkdirSync(targetDir, { recursive: true });
      const pendingPath = path.join(targetDir, `tender-pending-${Date.now()}.tmp.md`);
      fs.writeFileSync(pendingPath, `${markdown}\n`, 'utf-8');
      pendingTenderSelection = {
        markdownPath: pendingPath,
        fileName,
        parserLabel,
        sections: sectionDetection.sections,
        totalDeclared: sectionDetection.totalDeclared,
        createdAt: now(),
      };
      updateMeta({
        pending_tender_markdown_path: toWorkspaceRelativePath(pendingPath),
        pending_tender_file_name: fileName,
        pending_tender_parser_label: parserLabel,
        pending_tender_sections_json: JSON.stringify(sectionDetection.sections),
        pending_tender_total_declared: sectionDetection.totalDeclared,
        pending_tender_created_at: pendingTenderSelection.createdAt,
      });
      return {
        success: true,
        needsSectionSelection: true,
        sections: sectionDetection.sections,
        totalDeclared: sectionDetection.totalDeclared,
        fileName,
        parserLabel,
        message: result.message || '检测到多个标段，请选择投标标段',
        state: loadTechnicalPlan(),
      };
    }

    return saveTenderMarkdownAndState(markdown, {
      fileName,
      parserLabel,
      message: result.message || '招标文件已导入',
      fallbackToLocal: result.fallbackToLocal === true,
    });
  }

  async function importOriginalPlanDocument() {
    const importer = fileService?.importTechnicalPlanDocument || fileService?.importDocument;
    if (!importer) {
      throw new Error('文件导入服务尚未初始化');
    }

    const result = fileService.importTechnicalPlanDocument
      ? await fileService.importTechnicalPlanDocument('原方案')
      : await importer();
    if (!result?.success || !result.file_content) {
      return {
        success: false,
        message: result?.message || '未导入文件',
        state: loadTechnicalPlan(),
        markdown: '',
      };
    }

    const markdown = String(result.file_content || '').trim();
    const fileName = result.file_name || '未命名文件';
    const parserLabel = result.parser_label || null;
    const targetDir = path.dirname(originalPlanMarkdownPath);
    const tempPath = path.join(targetDir, `original-plan-${Date.now()}.tmp.md`);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(tempPath, `${markdown}\n`, 'utf-8');

    try {
      fs.renameSync(tempPath, originalPlanMarkdownPath);
      const timestamp = now();
      const transaction = db.transaction(() => {
        updateMeta({
          workflow_kind: 'existing-plan-expansion',
          original_plan_file_name: fileName,
          original_plan_markdown_path: originalPlanMarkdownRelativePath,
          original_plan_markdown_hash: stableHash(markdown),
          original_plan_markdown_chars: markdown.length,
          original_plan_parser_label: parserLabel || null,
          original_plan_imported_at: timestamp,
        });
        clearDownstreamFromOriginalPlan();
      });
      transaction();
      return {
        success: true,
        message: result.message || '原方案已导入',
        state: loadTechnicalPlan(),
        markdown,
      };
    } catch (error) {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }

  function saveTenderMarkdownAndState(markdown, { fileName, parserLabel, message, selectedSection, fallbackToLocal }) {
    const targetDir = path.dirname(tenderMarkdownPath);
    const tempPath = path.join(targetDir, `tender-${Date.now()}.tmp.md`);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(tempPath, `${markdown}\n`, 'utf-8');

    try {
      fs.renameSync(tempPath, tenderMarkdownPath);
      const timestamp = now();
      const transaction = db.transaction(() => {
        clearDownstreamFromTender();
        updateMeta({
          tender_file_name: fileName || '未命名文件',
          tender_markdown_path: tenderMarkdownRelativePath,
          tender_markdown_hash: stableHash(markdown),
          tender_markdown_chars: markdown.length,
          tender_parser_label: parserLabel || null,
          tender_imported_at: timestamp,
          selected_section_id: selectedSection?.id || null,
          selected_section_title: selectedSection?.title || null,
          selected_section_head_line: selectedSection?.headLine || null,
        });
      });
      transaction();
      return {
        success: true,
        needsSectionSelection: false,
        message: message || (fallbackToLocal ? '文件解析完成，当前格式已自动使用本地解析' : '招标文件已导入'),
        state: loadTechnicalPlan(),
        markdown,
      };
    } catch (error) {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }

  function selectBidSection(selectedSection) {
    const pendingSelection = getPendingTenderSelection();
    pendingTenderSelection = pendingSelection;
    const fullMarkdown = fs.readFileSync(pendingSelection.markdownPath, 'utf-8').trim();
    if (!fullMarkdown) {
      throw new Error('待选择的招标文件内容为空');
    }
    const selected = selectedSection || {};

    const result = saveTenderMarkdownAndState(fullMarkdown, {
      fileName: pendingSelection.fileName,
      parserLabel: pendingSelection.parserLabel,
      message: `已选择【${selected.title || '投标范围'}】，招标文件已导入`,
      selectedSection: selected,
    });
    removePendingTenderMarkdown(pendingSelection.markdownPath);
    cleanupPendingTenderSelection();
    return result;
  }

  function cancelBidSectionSelection() {
    cleanupPendingTenderSelection();
    return { success: true, message: '已取消标段选择', state: loadTechnicalPlan() };
  }

  function clearTechnicalPlan() {
    cleanupPendingTenderSelection();
    const workflowKind = normalizeWorkflowKind(ensureMetaRow().workflow_kind);
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM technical_plan_tasks').run();
      db.prepare('DELETE FROM technical_plan_bid_items').run();
      db.prepare('DELETE FROM technical_plan_reference_docs').run();
      db.prepare('DELETE FROM technical_plan_outline_nodes').run();
      db.prepare('DELETE FROM technical_plan_global_fact_groups').run();
      db.prepare('DELETE FROM technical_plan_meta').run();
      ensureMetaRow();
      updateMeta({ workflow_kind: workflowKind });
    });
    transaction();
    if (fs.existsSync(tenderMarkdownPath)) {
      fs.rmSync(tenderMarkdownPath, { force: true });
    }
    if (fs.existsSync(originalPlanMarkdownPath)) {
      fs.rmSync(originalPlanMarkdownPath, { force: true });
    }
    deleteImportedImageBatches(app, 'technical-plan');
    return { success: true, message: '技术方案缓存已清空', state: loadTechnicalPlan() };
  }

  return {
    loadTechnicalPlan,
    updateTechnicalPlan,
    clearTechnicalPlan,
    importTenderDocument,
    importOriginalPlanDocument,
    selectBidSection,
    cancelBidSectionSelection,
    readTenderMarkdown,
    readOriginalPlanMarkdown,
    updateStep,
    setWorkflowKind,
    switchWorkflowKind,
    saveBidAnalysisConfig,
    saveOutlineConfig,
    saveOutline,
    saveGlobalFacts,
    saveContentGenerationOptions,
    saveChapterContent,
  };
}

module.exports = {
  createTechnicalPlanStore,
};
