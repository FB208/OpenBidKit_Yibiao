const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getFeasibilityReportDir, getFeasibilityReportSourcesDir, getWorkspaceDir } = require('../utils/paths.cjs');

const taskFieldByType = {
  'feasibility-analysis': 'analysisTask',
  'feasibility-outline': 'outlineTask',
  'feasibility-parameters': 'parametersTask',
  'feasibility-content': 'contentTask',
  'feasibility-human-writing': 'humanWritingTask',
};

const defaultProjectInfo = {
  projectName: '',
  projectType: 'government',
  industry: '',
  constructionLocation: '',
  constructionScale: '',
  constructionPeriod: 2,
  operationPeriod: 20,
  totalInvestment: '',
  fundingSource: '',
  projectUnit: '',
};

function now() {
  return new Date().toISOString();
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function safeJsonParse(value, fallback) {
  try {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function stableHash(content) {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

function normalizeProjectInfo(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ...defaultProjectInfo,
    ...source,
    projectName: String(source.projectName || '').trim(),
    projectType: source.projectType === 'enterprise' ? 'enterprise' : 'government',
    constructionPeriod: Math.max(0, Math.floor(Number(source.constructionPeriod ?? 2) || 0)),
    operationPeriod: Math.max(1, Math.floor(Number(source.operationPeriod ?? 20) || 20)),
  };
}

function normalizeSourceReferences(refs) {
  if (!Array.isArray(refs)) return undefined;
  const valid = refs.map((ref) => {
    if (!ref || typeof ref !== 'object') return null;
    const id = String(ref.id || '').trim();
    const name = String(ref.name || '').trim();
    const type = ['uploaded_doc', 'knowledge_base', 'key_parameter'].includes(ref.type) ? ref.type : 'uploaded_doc';
    if (!name) return null;
    return {
      id: id || crypto.randomUUID(),
      type,
      name,
      ...(ref.detail ? { detail: String(ref.detail).trim() } : {}),
    };
  }).filter(Boolean);
  return valid.length ? valid : undefined;
}

function normalizeOutlineItem(item, index, parentId = '') {
  const id = String(item?.id || `${parentId ? `${parentId}-` : ''}${index + 1}`).trim();
  const children = Array.isArray(item?.children)
    ? item.children.map((child, childIndex) => normalizeOutlineItem(child, childIndex, id))
    : [];
  return {
    id,
    title: String(item?.title || '').trim(),
    description: String(item?.description || '').trim(),
    ...(Array.isArray(item?.knowledge_item_ids) && item.knowledge_item_ids.length
      ? { knowledge_item_ids: [...new Set(item.knowledge_item_ids.map((value) => String(value || '').trim()).filter(Boolean))] }
      : {}),
    ...(Array.isArray(item?.source_references) && item.source_references.length
      ? { source_references: normalizeSourceReferences(item.source_references) }
      : {}),
    ...(children.length ? { children } : {}),
    ...(String(item?.content || '').trim() ? { content: String(item.content).trim() } : {}),
  };
}

function normalizeOutlineData(value, projectInfo) {
  if (!value || !Array.isArray(value.outline)) return null;
  return {
    project_name: String(value.project_name || projectInfo?.projectName || '').trim(),
    project_overview: String(value.project_overview || '').trim(),
    outline: value.outline
      .map((item, index) => normalizeOutlineItem(item, index))
      .filter((item) => item.title),
  };
}

function clearOutlineContent(items) {
  return (items || []).map((item) => ({
    ...item,
    content: undefined,
    ...(item.children?.length ? { children: clearOutlineContent(item.children) } : {}),
  }));
}

function updateOutlineItemContent(items, nodeId, content) {
  return (items || []).map((item) => {
    if (item.id === nodeId) return { ...item, content: String(content || '') };
    if (!item.children?.length) return item;
    return { ...item, children: updateOutlineItemContent(item.children, nodeId, content) };
  });
}

function createFeasibilityReportStore({ app, db, fileService }) {
  const baseDir = getFeasibilityReportDir(app);
  const sourcesDir = getFeasibilityReportSourcesDir(app);

  function ensureDirectories() {
    fs.mkdirSync(sourcesDir, { recursive: true });
  }

  function ensureMetaRow() {
    const existing = db.prepare('SELECT * FROM feasibility_report_meta WHERE id = 1').get();
    if (existing) return existing;
    const timestamp = now();
    db.prepare(`
      INSERT INTO feasibility_report_meta (
        id, step, project_info_json, source_files_json, analysis_markdown, outline_template,
        target_words, reference_document_ids_json, key_parameters_markdown, outline_json,
        created_at, updated_at
      ) VALUES (1, 'materials', @projectInfo, '[]', '', 'government', 30000, '[]', '', NULL, @timestamp, @timestamp)
    `).run({ projectInfo: JSON.stringify(defaultProjectInfo), timestamp });
    return db.prepare('SELECT * FROM feasibility_report_meta WHERE id = 1').get();
  }

  function loadTasks() {
    const result = {};
    const rows = db.prepare('SELECT * FROM feasibility_report_tasks').all();
    for (const row of rows) {
      const field = taskFieldByType[row.type];
      if (!field) continue;
      result[field] = {
        task_id: row.task_id,
        type: row.type,
        status: row.status,
        progress: Number(row.progress || 0),
        logs: safeJsonParse(row.logs_json, []),
        error: row.error || undefined,
        started_at: row.started_at,
        updated_at: row.updated_at,
      };
    }
    return result;
  }

const VALID_OUTLINE_TEMPLATES = [
  'government',
  'enterprise',
  'industrial',
  'hi_tech',
  'infrastructure',
  'eco_environmental',
  'commercial_realestate',
];

  function loadFeasibilityReport() {
    const meta = ensureMetaRow();
    const projectInfo = normalizeProjectInfo(safeJsonParse(meta.project_info_json, defaultProjectInfo));
    const financialData = safeJsonParse(meta.financial_data_json, null);
    return {
      step: ['materials', 'analysis', 'outline', 'parameters', 'content', 'financial'].includes(meta.step) ? meta.step : 'materials',
      projectInfo,
      sourceFiles: safeJsonParse(meta.source_files_json, []),
      analysisMarkdown: String(meta.analysis_markdown || ''),
      outlineTemplate: VALID_OUTLINE_TEMPLATES.includes(meta.outline_template) ? meta.outline_template : 'government',
      targetWords: Math.max(1000, Number(meta.target_words || 30000) || 30000),
      referenceKnowledgeDocumentIds: safeJsonParse(meta.reference_document_ids_json, []),
      keyParametersMarkdown: String(meta.key_parameters_markdown || ''),
      outlineData: normalizeOutlineData(safeJsonParse(meta.outline_json, null), projectInfo),
      financialData,
      ...loadTasks(),
    };
  }

  function saveTask(type, task) {
    if (!task) {
      db.prepare('DELETE FROM feasibility_report_tasks WHERE type = ?').run(type);
      return;
    }
    db.prepare(`
      INSERT INTO feasibility_report_tasks (type, task_id, status, progress, logs_json, error, started_at, updated_at)
      VALUES (@type, @taskId, @status, @progress, @logs, @error, @startedAt, @updatedAt)
      ON CONFLICT(type) DO UPDATE SET
        task_id = excluded.task_id,
        status = excluded.status,
        progress = excluded.progress,
        logs_json = excluded.logs_json,
        error = excluded.error,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `).run({
      type,
      taskId: String(task.task_id || ''),
      status: String(task.status || 'running'),
      progress: Math.max(0, Math.min(100, Number(task.progress || 0) || 0)),
      logs: JSON.stringify(Array.isArray(task.logs) ? task.logs : []),
      error: task.error ? String(task.error) : null,
      startedAt: String(task.started_at || now()),
      updatedAt: String(task.updated_at || now()),
    });
  }

  function updateFeasibilityReport(partial = {}) {
    ensureMetaRow();
    const columnValues = {};
    if (hasOwn(partial, 'step')) columnValues.step = String(partial.step || 'materials');
    if (hasOwn(partial, 'projectInfo')) columnValues.project_info_json = JSON.stringify(normalizeProjectInfo(partial.projectInfo));
    if (hasOwn(partial, 'sourceFiles')) columnValues.source_files_json = JSON.stringify(Array.isArray(partial.sourceFiles) ? partial.sourceFiles : []);
    if (hasOwn(partial, 'analysisMarkdown')) columnValues.analysis_markdown = String(partial.analysisMarkdown || '');
    if (hasOwn(partial, 'outlineTemplate')) columnValues.outline_template = VALID_OUTLINE_TEMPLATES.includes(partial.outlineTemplate) ? partial.outlineTemplate : 'government';
    if (hasOwn(partial, 'targetWords')) columnValues.target_words = Math.max(1000, Number(partial.targetWords || 30000) || 30000);
    if (hasOwn(partial, 'referenceKnowledgeDocumentIds')) columnValues.reference_document_ids_json = JSON.stringify(Array.isArray(partial.referenceKnowledgeDocumentIds) ? partial.referenceKnowledgeDocumentIds : []);
    if (hasOwn(partial, 'keyParametersMarkdown')) columnValues.key_parameters_markdown = String(partial.keyParametersMarkdown || '');
    if (hasOwn(partial, 'financialData')) columnValues.financial_data_json = partial.financialData ? JSON.stringify(partial.financialData) : null;
    if (hasOwn(partial, 'outlineData')) {
      const projectInfo = hasOwn(partial, 'projectInfo') ? normalizeProjectInfo(partial.projectInfo) : loadFeasibilityReport().projectInfo;
      const outlineData = normalizeOutlineData(partial.outlineData, projectInfo);
      columnValues.outline_json = outlineData ? JSON.stringify(outlineData) : null;
    }

    const transaction = db.transaction(() => {
      const entries = Object.entries(columnValues);
      if (entries.length) {
        const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
        db.prepare(`UPDATE feasibility_report_meta SET ${assignments}, updated_at = @updated_at WHERE id = 1`).run({
          ...columnValues,
          updated_at: now(),
        });
      }
      for (const [type, field] of Object.entries(taskFieldByType)) {
        if (hasOwn(partial, field)) saveTask(type, partial[field]);
      }
    });
    transaction();
    return loadFeasibilityReport();
  }

  function resolveSourcePath(relativePath) {
    const workspaceRoot = path.resolve(getWorkspaceDir(app));
    const resolved = path.resolve(baseDir, String(relativePath || ''));
    if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new Error('项目资料路径超出工作区');
    }
    return resolved;
  }

  function readSourceMarkdown(sourceId) {
    const state = loadFeasibilityReport();
    const source = state.sourceFiles.find((item) => item.id === sourceId);
    if (!source) return '';
    const filePath = resolveSourcePath(source.markdownPath);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  }

  function readCombinedSourceMarkdown() {
    const state = loadFeasibilityReport();
    return state.sourceFiles.map((source, index) => {
      const content = readSourceMarkdown(source.id).trim();
      return content ? `# 项目资料 ${index + 1}：${source.fileName}\n\n${content}` : '';
    }).filter(Boolean).join('\n\n---\n\n');
  }

  async function importSourceDocuments() {
    const importer = fileService?.importTechnicalPlanDocument;
    if (!importer) throw new Error('文件导入服务尚未初始化');
    const result = await importer('项目资料', { multiple: true, assetScopePrefix: 'feasibility-report' });
    if (!result?.success || !result.file_content) {
      return { success: false, message: result?.message || '未导入文件', state: loadFeasibilityReport(), markdown: '' };
    }

    ensureDirectories();
    const imported = Array.isArray(result.documents) && result.documents.length ? result.documents : [result];
    const nextFiles = [];
    const createdPaths = [];
    try {
      for (const document of imported) {
        const id = crypto.randomUUID();
        const relativePath = path.join('sources', `${id}.md`).replace(/\\/g, '/');
        const targetPath = resolveSourcePath(relativePath);
        const markdown = String(document.file_content || '').trim();
        fs.writeFileSync(targetPath, `${markdown}\n`, 'utf-8');
        createdPaths.push(targetPath);
        nextFiles.push({
          id,
          fileName: String(document.file_name || '未命名资料'),
          markdownPath: relativePath,
          markdownChars: markdown.length,
          contentHash: stableHash(markdown),
          parserLabel: document.parser_label || '本地解析',
          importedAt: now(),
        });
      }

      const previousFiles = loadFeasibilityReport().sourceFiles;
      const state = updateFeasibilityReport({
        sourceFiles: nextFiles,
        analysisMarkdown: '',
        outlineData: null,
        keyParametersMarkdown: '',
        referenceKnowledgeDocumentIds: [],
        analysisTask: undefined,
        outlineTask: undefined,
        parametersTask: undefined,
        contentTask: undefined,
        humanWritingTask: undefined,
        step: 'materials',
      });
      for (const source of previousFiles) {
        const oldPath = resolveSourcePath(source.markdownPath);
        if (fs.existsSync(oldPath)) fs.rmSync(oldPath, { force: true });
      }
      return {
        success: true,
        message: result.message || `已导入 ${nextFiles.length} 份项目资料`,
        state,
        markdown: readCombinedSourceMarkdown(),
      };
    } catch (error) {
      for (const filePath of createdPaths) {
        if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
      }
      throw error;
    }
  }

  function saveProjectInfo(projectInfo) {
    const state = loadFeasibilityReport();
    const normalized = normalizeProjectInfo(projectInfo);
    const changed = JSON.stringify(normalized) !== JSON.stringify(state.projectInfo);
    return updateFeasibilityReport(changed ? {
      projectInfo: normalized,
      analysisMarkdown: '',
      outlineData: null,
      keyParametersMarkdown: '',
      analysisTask: undefined,
      outlineTask: undefined,
      parametersTask: undefined,
      contentTask: undefined,
      humanWritingTask: undefined,
    } : { projectInfo: normalized });
  }

  function saveAnalysis(analysisMarkdown) {
    return updateFeasibilityReport({
      analysisMarkdown,
      outlineData: null,
      keyParametersMarkdown: '',
      outlineTask: undefined,
      parametersTask: undefined,
      contentTask: undefined,
      humanWritingTask: undefined,
    });
  }

  function saveOutlineConfig(payload = {}) {
    return updateFeasibilityReport({
      outlineTemplate: payload.outlineTemplate,
      targetWords: payload.targetWords,
      referenceKnowledgeDocumentIds: payload.referenceKnowledgeDocumentIds,
    });
  }

  function saveOutline(outlineData) {
    const normalized = normalizeOutlineData(outlineData, loadFeasibilityReport().projectInfo);
    return updateFeasibilityReport({
      outlineData: normalized ? { ...normalized, outline: clearOutlineContent(normalized.outline) } : null,
      keyParametersMarkdown: '',
      parametersTask: undefined,
      contentTask: undefined,
      humanWritingTask: undefined,
    });
  }

  function saveKeyParameters(keyParametersMarkdown) {
    const state = loadFeasibilityReport();
    return updateFeasibilityReport({
      keyParametersMarkdown,
      outlineData: state.outlineData ? { ...state.outlineData, outline: clearOutlineContent(state.outlineData.outline) } : null,
      contentTask: undefined,
      humanWritingTask: undefined,
    });
  }

  function saveChapterContent({ nodeId, content }) {
    const state = loadFeasibilityReport();
    if (!state.outlineData?.outline?.length) throw new Error('请先生成报告目录');
    return updateFeasibilityReport({
      outlineData: {
        ...state.outlineData,
        outline: updateOutlineItemContent(state.outlineData.outline, String(nodeId || ''), content),
      },
    });
  }

  function updateStep(step) {
    return updateFeasibilityReport({ step });
  }

  function clearFeasibilityReport() {
    const resolvedBase = path.resolve(baseDir);
    const resolvedWorkspace = path.resolve(getWorkspaceDir(app));
    if (!resolvedBase.startsWith(`${resolvedWorkspace}${path.sep}`)) {
      throw new Error('可研工作区路径异常，已停止清理');
    }
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM feasibility_report_tasks').run();
      db.prepare('DELETE FROM feasibility_report_meta').run();
      ensureMetaRow();
    });
    transaction();
    if (fs.existsSync(resolvedBase)) fs.rmSync(resolvedBase, { recursive: true, force: true });
    ensureDirectories();
    return { success: true, message: '可行性研究报告工作区已清空', state: loadFeasibilityReport() };
  }

  ensureDirectories();
  ensureMetaRow();

  return {
    loadFeasibilityReport,
    updateFeasibilityReport,
    importSourceDocuments,
    readSourceMarkdown,
    readCombinedSourceMarkdown,
    saveProjectInfo,
    saveAnalysis,
    saveOutlineConfig,
    saveOutline,
    saveKeyParameters,
    saveChapterContent,
    updateStep,
    clearFeasibilityReport,
  };
}

module.exports = {
  createFeasibilityReportStore,
};
