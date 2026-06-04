const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getBidAnalysisTasks } = require('./bidAnalysisTask.cjs');
const { getTechnicalPlanTenderMarkdownPath } = require('../utils/paths.cjs');
const { deleteImportedImageBatches } = require('../utils/importedImages.cjs');

const tenderMarkdownRelativePath = path.join('technical-plan', 'tender.md').replace(/\\/g, '/');

const initialState = {
  step: 'document-analysis',
  tenderFile: null,
  projectOverview: '',
  techRequirements: '',
  bidAnalysisMode: 'key',
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
  return value === 'key' || value === 'full';
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

function createTechnicalPlanStore({ app, db, fileService }) {
  const tenderMarkdownPath = getTechnicalPlanTenderMarkdownPath(app);

  function ensureMetaRow() {
    const existing = db.prepare('SELECT * FROM technical_plan_meta WHERE id = 1').get();
    if (existing) return existing;
    const timestamp = now();
    db.prepare(`
      INSERT INTO technical_plan_meta (id, step, bid_analysis_mode, outline_mode, created_at, updated_at)
      VALUES (1, 'document-analysis', 'key', 'aligned', @timestamp, @timestamp)
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

  function getBidItemSortOrder(itemId, mode) {
    const fullTasks = getBidAnalysisTasks(mode === 'full' ? 'full' : 'key');
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

  function calculateBidProgress(mode, bidTasks) {
    const selectedTasks = getBidAnalysisTasks(mode);
    if (!selectedTasks.length) return 0;
    const done = selectedTasks.filter((task) => ['success', 'error'].includes(bidTasks[task.id]?.status)).length;
    return Math.round((done / selectedTasks.length) * 100);
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
      outline_mode: 'aligned',
      outline_project_name: null,
      outline_project_overview: null,
      content_generation_options_json: null,
      content_generation_runtime_json: null,
    });
  }

  function clearContentGenerationState() {
    db.prepare("UPDATE technical_plan_outline_nodes SET content = '', updated_at = ?").run(now());
    db.prepare('DELETE FROM technical_plan_content_sections').run();
    db.prepare('DELETE FROM technical_plan_content_plans').run();
    db.prepare("DELETE FROM technical_plan_tasks WHERE type = 'content-generation'").run();
    updateMeta({ content_generation_runtime_json: null });
  }

  function clearGlobalFactsAndContentState() {
    db.prepare('DELETE FROM technical_plan_global_fact_groups').run();
    db.prepare("DELETE FROM technical_plan_tasks WHERE type = 'global-facts-generation'").run();
    clearContentGenerationState();
  }

  function applyPartial(partial) {
    const meta = ensureMetaRow();
    const metaUpdates = {};

    if (hasOwn(partial, 'step') && isValidStep(partial.step)) metaUpdates.step = partial.step;
    if (hasOwn(partial, 'bidAnalysisMode') && isValidBidMode(partial.bidAnalysisMode)) metaUpdates.bid_analysis_mode = partial.bidAnalysisMode;
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
      updatedAt: meta.updated_at,
    } : null;

    return {
      ...initialState,
      step: isValidStep(meta.step) ? meta.step : 'document-analysis',
      tenderFile,
      projectOverview: bidAnalysisTasks.projectOverview?.status === 'success' ? bidAnalysisTasks.projectOverview.content : '',
      techRequirements: bidAnalysisTasks.techRequirements?.status === 'success' ? bidAnalysisTasks.techRequirements.content : '',
      bidAnalysisMode,
      bidAnalysisTasks,
      bidAnalysisProgress: calculateBidProgress(bidAnalysisMode, bidAnalysisTasks),
      outlineMode: isValidOutlineMode(meta.outline_mode) ? meta.outline_mode : 'aligned',
      referenceKnowledgeDocumentIds: loadReferenceDocumentIds(),
      ...tasks,
      globalFacts: loadGlobalFacts(),
      contentGenerationOptions: safeJsonParse(meta.content_generation_options_json, undefined),
      contentGenerationRuntime: safeJsonParse(meta.content_generation_runtime_json, undefined),
      contentGenerationSections: loadContentSections(outlineData),
      contentGenerationPlans: loadContentPlans(),
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

  function saveOutlineConfig({ outlineMode, referenceKnowledgeDocumentIds } = {}) {
    return updateTechnicalPlan({ outlineMode, referenceKnowledgeDocumentIds });
  }

  function saveOutline(outlineData) {
    const transaction = db.transaction(() => {
      saveOutlineData(clearOutlineDataContent(outlineData));
      clearGlobalFactsAndContentState();
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

  // ============================================================
  // 附件管理
  // ============================================================

  function getAttachmentsDir() {
    return path.join(path.dirname(tenderMarkdownPath), 'attachments');
  }

  async function importAttachment() {
    if (!fileService?.importDocument) {
      throw new Error('文件导入服务尚未初始化');
    }

    const result = await fileService.importDocument();
    if (!result?.success || !result.file_content) {
      return {
        success: false,
        message: result?.message || '未导入文件',
        attachment: null,
      };
    }

    const markdown = String(result.file_content || '').trim();
    const attachmentId = `att-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const attachmentDir = path.join(getAttachmentsDir(), attachmentId);
    const sourcePath = path.join(attachmentDir, 'source');
    const markdownPath = path.join(attachmentDir, 'content.md');
    fs.mkdirSync(attachmentDir, { recursive: true });

    const sourceFilePath = result.file_path || result.filePath;
    if (sourceFilePath && fs.existsSync(sourceFilePath)) {
      fs.copyFileSync(sourceFilePath, sourcePath);
    }
    fs.writeFileSync(markdownPath, `${markdown}\n`, 'utf-8');

    const timestamp = now();
    const extension = (result.file_name || '').split('.').pop()?.toLowerCase() || '';
    const relativeSourcePath = path.relative(path.dirname(path.dirname(tenderMarkdownPath)), sourcePath).replace(/\\/g, '/');
    const relativeMarkdownPath = path.relative(path.dirname(path.dirname(tenderMarkdownPath)), markdownPath).replace(/\\/g, '/');

    db.prepare(`
      INSERT INTO technical_plan_attachments (
        attachment_id, file_name, source_path, markdown_path, markdown_chars, content_hash,
        parser_label, attachment_type, file_size, extension, created_at, updated_at
      ) VALUES (
        @attachment_id, @file_name, @source_path, @markdown_path, @markdown_chars, @content_hash,
        @parser_label, @attachment_type, @file_size, @extension, @created_at, @updated_at
      )
    `).run({
      attachment_id: attachmentId,
      file_name: result.file_name || '未命名附件',
      source_path: relativeSourcePath,
      markdown_path: relativeMarkdownPath,
      markdown_chars: markdown.length,
      content_hash: stableHash(markdown),
      parser_label: result.parser_label || null,
      attachment_type: 'reference',
      file_size: Number(result.file_size || 0),
      extension,
      created_at: timestamp,
      updated_at: timestamp,
    });

    return {
      success: true,
      message: '附件已导入',
      attachment: db.prepare('SELECT * FROM technical_plan_attachments WHERE attachment_id = ?').get(attachmentId),
    };
  }

  function listAttachments(bidSectionId) {
    if (bidSectionId) {
      return db.prepare(`
        SELECT * FROM technical_plan_attachments
        WHERE bid_section_id = ? OR bid_section_id IS NULL
        ORDER BY sort_order ASC, created_at ASC
      `).all(bidSectionId);
    }
    return db.prepare('SELECT * FROM technical_plan_attachments ORDER BY sort_order ASC, created_at ASC').all();
  }

  function readAttachmentMarkdown(attachmentId) {
    const attachment = db.prepare('SELECT * FROM technical_plan_attachments WHERE attachment_id = ?').get(attachmentId);
    if (!attachment?.markdown_path) return '';
    const resolvedPath = resolveMarkdownPath(attachment.markdown_path);
    if (!fs.existsSync(resolvedPath)) return '';
    return fs.readFileSync(resolvedPath, 'utf-8');
  }

  function deleteAttachment(attachmentId) {
    const attachment = db.prepare('SELECT * FROM technical_plan_attachments WHERE attachment_id = ?').get(attachmentId);
    if (!attachment) throw new Error('未找到该附件');
    db.prepare('DELETE FROM technical_plan_attachments WHERE attachment_id = ?').run(attachmentId);
    const attachmentDir = path.dirname(resolveMarkdownPath(attachment.source_path || attachment.markdown_path || ''));
    if (fs.existsSync(attachmentDir)) {
      fs.rmSync(attachmentDir, { recursive: true, force: true });
    }
  }

  function setAttachmentType(attachmentId, attachmentType) {
    if (!['procurement_list', 'technical_spec', 'reference'].includes(attachmentType)) {
      throw new Error('附件分类无效');
    }
    db.prepare('UPDATE technical_plan_attachments SET attachment_type = ?, updated_at = ? WHERE attachment_id = ?')
      .run(attachmentType, now(), attachmentId);
  }

  function setAttachmentBidSection(attachmentId, bidSectionId) {
    if (bidSectionId) {
      const section = db.prepare('SELECT section_id FROM technical_plan_bid_sections WHERE section_id = ?').get(bidSectionId);
      if (!section) throw new Error('未找到该标段');
    }
    db.prepare('UPDATE technical_plan_attachments SET bid_section_id = ?, updated_at = ? WHERE attachment_id = ?')
      .run(bidSectionId || null, now(), attachmentId);
  }

  // ============================================================
  // 采购清单
  // ============================================================

  function saveProcurementItems(attachmentId, items) {
    const attachment = db.prepare('SELECT attachment_id FROM technical_plan_attachments WHERE attachment_id = ?').get(attachmentId);
    if (!attachment) throw new Error('未找到该附件');

    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM technical_plan_procurement_items WHERE attachment_id = ?').run(attachmentId);
      if (!Array.isArray(items) || !items.length) return;

      const timestamp = now();
      const insert = db.prepare(`
        INSERT INTO technical_plan_procurement_items (
          item_id, attachment_id, item_number, item_name, model_spec, unit, quantity,
          is_core, params_json, notes, sort_order, created_at, updated_at
        ) VALUES (
          @item_id, @attachment_id, @item_number, @item_name, @model_spec, @unit, @quantity,
          @is_core, @params_json, @notes, @sort_order, @created_at, @updated_at
        )
      `);

      items.forEach((item, index) => {
        const itemId = `proc-${attachmentId}-${index + 1}`;
        insert.run({
          item_id: itemId,
          attachment_id: attachmentId,
          item_number: Number(item.item_number || item.itemNumber || (index + 1)),
          item_name: String(item.item_name || item.itemName || ''),
          model_spec: item.model_spec || item.modelSpec || null,
          unit: item.unit || null,
          quantity: Number(item.quantity) || null,
          is_core: item.is_core || item.isCore ? 1 : 0,
          params_json: Array.isArray(item.params) ? JSON.stringify(item.params) : (item.params_json || item.paramsJson || null),
          notes: item.notes || null,
          sort_order: index,
          created_at: timestamp,
          updated_at: timestamp,
        });
      });
    });
    transaction();
  }

  function listProcurementItems(bidSectionId) {
    if (bidSectionId) {
      return db.prepare(`
        SELECT pi.* FROM technical_plan_procurement_items pi
        WHERE pi.bid_section_id = ? OR pi.bid_section_id IS NULL
        ORDER BY pi.sort_order ASC
      `).all(bidSectionId);
    }
    return db.prepare('SELECT * FROM technical_plan_procurement_items ORDER BY sort_order ASC').all();
  }

  function getProcurementItemsForSection(bidSectionId) {
    if (!bidSectionId) return [];
    return db.prepare(`
      SELECT DISTINCT pi.* FROM technical_plan_procurement_items pi
      LEFT JOIN technical_plan_attachments a ON a.attachment_id = pi.attachment_id
      WHERE pi.bid_section_id = ?
         OR (pi.bid_section_id IS NULL AND (a.bid_section_id = ? OR a.bid_section_id IS NULL))
      ORDER BY pi.sort_order ASC
    `).all(bidSectionId, bidSectionId);
  }

  // ============================================================
  // 标段管理
  // ============================================================

  function extractBidSections(sections) {
    if (!Array.isArray(sections) || !sections.length) {
      updateMeta({ bid_sections_extracted: 1 });
      return [];
    }

    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM technical_plan_bid_sections').run();
      const timestamp = now();
      const insert = db.prepare(`
        INSERT INTO technical_plan_bid_sections (section_id, label, title, description, budget, status, sort_order, created_at, updated_at)
        VALUES (@section_id, @label, @title, @description, @budget, @status, @sort_order, @created_at, @updated_at)
      `);

      const result = sections.map((section, index) => {
        const sectionId = `bid-sec-${index + 1}`;
        insert.run({
          section_id: sectionId,
          label: String(section.label || `标段${index + 1}`).trim(),
          title: String(section.title || '').trim(),
          description: String(section.description || '').trim() || null,
          budget: section.budget ? String(section.budget).trim() : null,
          status: 'idle',
          sort_order: index,
          created_at: timestamp,
          updated_at: timestamp,
        });
        return sectionId;
      });

      updateMeta({ bid_sections_extracted: 1 });
      return result;
    });

    return transaction();
  }

  function listBidSections() {
    return db.prepare('SELECT * FROM technical_plan_bid_sections ORDER BY sort_order ASC, section_id ASC').all();
  }

  function hasMultipleSections() {
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM technical_plan_bid_sections').get();
    return (count?.cnt || 0) >= 2;
  }

  function selectBidSections(sectionIds) {
    const allSections = listBidSections();
    const selectedSet = new Set((Array.isArray(sectionIds) ? sectionIds : []).map(String));

    const transaction = db.transaction(() => {
      for (const section of allSections) {
        const nextStatus = selectedSet.has(section.section_id) ? 'selected' : 'idle';
        db.prepare('UPDATE technical_plan_bid_sections SET status = ?, updated_at = ? WHERE section_id = ?')
          .run(nextStatus, now(), section.section_id);
      }

      const firstSelected = allSections.find((s) => selectedSet.has(s.section_id));
      if (firstSelected) {
        updateMeta({ current_bid_section_id: firstSelected.section_id });
      }
    });
    transaction();

    return allSections.filter((s) => selectedSet.has(s.section_id));
  }

  // ============================================================
  // 工作区快照（多标段切换用）
  // ============================================================

  function _snapshotWorkspaceState(sectionId) {
    const bidItems = db.prepare('SELECT * FROM technical_plan_bid_items ORDER BY sort_order ASC').all();
    const outlineNodes = db.prepare('SELECT * FROM technical_plan_outline_nodes ORDER BY level ASC, parent_node_id ASC, sort_order ASC').all();
    const tasks = db.prepare('SELECT * FROM technical_plan_tasks').all();
    const contentSections = db.prepare('SELECT * FROM technical_plan_content_sections').all();
    const contentPlans = db.prepare('SELECT * FROM technical_plan_content_plans').all();
    const globalFacts = db.prepare('SELECT * FROM technical_plan_global_fact_groups ORDER BY sort_order ASC').all();
    const referenceDocs = db.prepare('SELECT * FROM technical_plan_reference_docs ORDER BY sort_order ASC').all();
    const meta = db.prepare('SELECT * FROM technical_plan_meta WHERE id = 1').get();

    db.prepare(`
      INSERT INTO technical_plan_bid_section_state (
        section_id, bid_items_json, outline_data_json, tasks_json,
        content_sections_json, content_plans_json, global_facts_json,
        reference_doc_ids_json, content_generation_options_json,
        content_generation_runtime_json, updated_at
      ) VALUES (
        @section_id, @bid_items_json, @outline_data_json, @tasks_json,
        @content_sections_json, @content_plans_json, @global_facts_json,
        @reference_doc_ids_json, @content_generation_options_json,
        @content_generation_runtime_json, @updated_at
      )
      ON CONFLICT(section_id) DO UPDATE SET
        bid_items_json = excluded.bid_items_json,
        outline_data_json = excluded.outline_data_json,
        tasks_json = excluded.tasks_json,
        content_sections_json = excluded.content_sections_json,
        content_plans_json = excluded.content_plans_json,
        global_facts_json = excluded.global_facts_json,
        reference_doc_ids_json = excluded.reference_doc_ids_json,
        content_generation_options_json = excluded.content_generation_options_json,
        content_generation_runtime_json = excluded.content_generation_runtime_json,
        updated_at = excluded.updated_at
    `).run({
      section_id: sectionId,
      bid_items_json: JSON.stringify(bidItems),
      outline_data_json: JSON.stringify(outlineNodes),
      tasks_json: JSON.stringify(tasks),
      content_sections_json: JSON.stringify(contentSections),
      content_plans_json: JSON.stringify(contentPlans),
      global_facts_json: JSON.stringify(globalFacts),
      reference_doc_ids_json: JSON.stringify(referenceDocs),
      content_generation_options_json: meta?.content_generation_options_json || null,
      content_generation_runtime_json: meta?.content_generation_runtime_json || null,
      updated_at: now(),
    });
  }

  function _clearWorkspaceTables() {
    db.prepare('DELETE FROM technical_plan_tasks').run();
    db.prepare('DELETE FROM technical_plan_bid_items').run();
    db.prepare('DELETE FROM technical_plan_reference_docs').run();
    db.prepare('DELETE FROM technical_plan_outline_nodes').run();
    db.prepare('DELETE FROM technical_plan_content_sections').run();
    db.prepare('DELETE FROM technical_plan_content_plans').run();
    db.prepare('DELETE FROM technical_plan_global_fact_groups').run();
  }

  function _restoreWorkspaceState(sectionId) {
    const snapshot = db.prepare('SELECT * FROM technical_plan_bid_section_state WHERE section_id = ?').get(sectionId);
    if (!snapshot) return;

    _clearWorkspaceTables();

    const timestamp = now();

    const bidItems = safeJsonParse(snapshot.bid_items_json, []);
    if (bidItems.length) {
      const insert = db.prepare(`
        INSERT INTO technical_plan_bid_items (item_id, label, status, content, error, sort_order, updated_at)
        VALUES (@item_id, @label, @status, @content, @error, @sort_order, @updated_at)
      `);
      for (const row of bidItems) {
        insert.run({ ...row, updated_at: row.updated_at || timestamp });
      }
    }

    const outlineNodes = safeJsonParse(snapshot.outline_data_json, []);
    if (outlineNodes.length) {
      const insert = db.prepare(`
        INSERT INTO technical_plan_outline_nodes (node_id, parent_node_id, sort_order, level, title, description, source_requirement_id, source_requirement_title, knowledge_item_ids_json, content, created_at, updated_at)
        VALUES (@node_id, @parent_node_id, @sort_order, @level, @title, @description, @source_requirement_id, @source_requirement_title, @knowledge_item_ids_json, @content, @created_at, @updated_at)
      `);
      for (const row of outlineNodes) {
        insert.run({ ...row, created_at: row.created_at || timestamp, updated_at: row.updated_at || timestamp });
      }
    }

    const tasks = safeJsonParse(snapshot.tasks_json, []);
    if (tasks.length) {
      const insert = db.prepare(`
        INSERT INTO technical_plan_tasks (type, task_id, status, progress, logs_json, stats_json, error, pause_requested, started_at, updated_at)
        VALUES (@type, @task_id, @status, @progress, @logs_json, @stats_json, @error, @pause_requested, @started_at, @updated_at)
      `);
      for (const row of tasks) {
        insert.run({ ...row, updated_at: row.updated_at || timestamp });
      }
    }

    const contentSections = safeJsonParse(snapshot.content_sections_json, []);
    if (contentSections.length) {
      const insert = db.prepare('INSERT INTO technical_plan_content_sections (node_id, status, error, updated_at) VALUES (@node_id, @status, @error, @updated_at)');
      for (const row of contentSections) {
        insert.run({ ...row, updated_at: row.updated_at || timestamp });
      }
    }

    const contentPlans = safeJsonParse(snapshot.content_plans_json, []);
    if (contentPlans.length) {
      const insert = db.prepare('INSERT INTO technical_plan_content_plans (node_id, plan_json, illustration_type, updated_at) VALUES (@node_id, @plan_json, @illustration_type, @updated_at)');
      for (const row of contentPlans) {
        insert.run({ ...row, updated_at: row.updated_at || timestamp });
      }
    }

    const globalFacts = safeJsonParse(snapshot.global_facts_json, []);
    if (globalFacts.length) {
      const insert = db.prepare(`
        INSERT INTO technical_plan_global_fact_groups (group_id, title, content, sort_order, created_at, updated_at)
        VALUES (@group_id, @title, @content, @sort_order, @created_at, @updated_at)
      `);
      for (const row of globalFacts) {
        insert.run({ ...row, created_at: row.created_at || timestamp, updated_at: row.updated_at || timestamp });
      }
    }

    const referenceDocs = safeJsonParse(snapshot.reference_doc_ids_json, []);
    if (referenceDocs.length) {
      const insert = db.prepare('INSERT INTO technical_plan_reference_docs (document_id, sort_order) VALUES (@document_id, @sort_order)');
      for (const row of referenceDocs) {
        insert.run({ ...row });
      }
    }

    updateMeta({
      current_bid_section_id: sectionId,
      content_generation_options_json: snapshot.content_generation_options_json || null,
      content_generation_runtime_json: snapshot.content_generation_runtime_json || null,
    });
  }

  function switchToBidSection(sectionId) {
    const section = db.prepare('SELECT * FROM technical_plan_bid_sections WHERE section_id = ?').get(sectionId);
    if (!section) throw new Error('未找到该标段');

    const meta = ensureMetaRow();
    const currentSectionId = meta.current_bid_section_id;

    if (currentSectionId && currentSectionId !== sectionId) {
      _snapshotWorkspaceState(currentSectionId);
    }

    _restoreWorkspaceState(sectionId);
    return loadTechnicalPlan();
  }

  function getSelectedBidSections() {
    return db.prepare("SELECT * FROM technical_plan_bid_sections WHERE status = 'selected' ORDER BY sort_order ASC").all();
  }

  function getCurrentBidSectionId() {
    const meta = ensureMetaRow();
    return meta.current_bid_section_id || null;
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
          tender_file_name: result.file_name || '未命名文件',
          tender_markdown_path: tenderMarkdownRelativePath,
          tender_markdown_hash: stableHash(markdown),
          tender_markdown_chars: markdown.length,
          tender_parser_label: result.parser_label || null,
          tender_imported_at: timestamp,
        });
      });
      transaction();
      return {
        success: true,
        message: result.message || '招标文件已导入',
        state: loadTechnicalPlan(),
        markdown,
      };
    } catch (error) {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }

  function clearTechnicalPlan() {
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM technical_plan_tasks').run();
      db.prepare('DELETE FROM technical_plan_bid_items').run();
      db.prepare('DELETE FROM technical_plan_reference_docs').run();
      db.prepare('DELETE FROM technical_plan_outline_nodes').run();
      db.prepare('DELETE FROM technical_plan_global_fact_groups').run();
      db.prepare('DELETE FROM technical_plan_meta').run();
      ensureMetaRow();
    });
    transaction();
    if (fs.existsSync(tenderMarkdownPath)) {
      fs.rmSync(tenderMarkdownPath, { force: true });
    }
    deleteImportedImageBatches(app, 'technical-plan');
    return { success: true, message: '技术方案缓存已清空', state: loadTechnicalPlan() };
  }

  return {
    loadTechnicalPlan,
    updateTechnicalPlan,
    clearTechnicalPlan,
    importTenderDocument,
    readTenderMarkdown,
    updateStep,
    saveOutlineConfig,
    saveOutline,
    saveGlobalFacts,
    saveContentGenerationOptions,
    saveChapterContent,
    // 附件
    importAttachment,
    listAttachments,
    readAttachmentMarkdown,
    deleteAttachment,
    setAttachmentType,
    setAttachmentBidSection,
    // 采购清单
    saveProcurementItems,
    listProcurementItems,
    getProcurementItemsForSection,
    // 标段
    extractBidSections,
    listBidSections,
    hasMultipleSections,
    selectBidSections,
    switchToBidSection,
    getSelectedBidSections,
    getCurrentBidSectionId,
  };
}

module.exports = {
  createTechnicalPlanStore,
};
