const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getRejectionCheckDir, getRejectionCheckDocumentMarkdownPath } = require('../utils/paths.cjs');
const { deleteImportedImageBatches } = require('../utils/importedImages.cjs');

const initialState = {
  tenderDocument: null,
  bidDocument: null,
  activeDocumentTab: 'tender',
  step: 'documents',
  activeResultTab: 'analysis',
  activeCheckResultTab: 'rejection',
  invalidBidAndRejectionItems: { status: 'idle', content: '' },
  customCheckItems: '',
  checkOptions: { rejectionCheck: true, typoCheck: true, logicCheck: true },
  rejectionCheckResult: { status: 'idle', findings: [] },
  typoCheckResult: { status: 'idle', findings: [] },
  logicCheckResult: { status: 'idle', findings: [] },
  extractionTask: undefined,
  checkTask: undefined,
};

const taskFieldTypes = {
  extractionTask: 'rejection-items-extraction',
  checkTask: 'rejection-check-run',
};

const taskTypeFields = Object.fromEntries(Object.entries(taskFieldTypes).map(([field, type]) => [type, field]));

const resultFieldTypes = {
  rejectionCheckResult: 'rejection',
  typoCheckResult: 'typo',
  logicCheckResult: 'logic',
};

const resultTypeFields = Object.fromEntries(Object.entries(resultFieldTypes).map(([field, type]) => [type, field]));

const documentRelativePaths = {
  tender: 'rejection-check/tender.md',
  bid: 'rejection-check/bid.md',
};

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

function normalizeStatus(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeStep(value) {
  return value === 'items' || value === 'results' ? value : 'documents';
}

function normalizeDocumentRole(value) {
  return value === 'bid' ? 'bid' : 'tender';
}

function normalizeResultTab(value) {
  return value === 'custom' ? 'custom' : 'analysis';
}

function normalizeCheckResultTab(value) {
  return ['rejection', 'typo', 'logic'].includes(value) ? value : 'rejection';
}

function normalizeCheckOptions(options) {
  return {
    rejectionCheck: true,
    typoCheck: options?.typoCheck !== false,
    logicCheck: options?.logicCheck !== false,
  };
}

function stripTripleQuoteWrapper(content) {
  const trimmed = String(content || '').trim();
  if (trimmed.startsWith("'''") && trimmed.endsWith("'''")) {
    return trimmed.slice(3, -3).trim();
  }
  return String(content || '');
}

function createDocumentSignature(document) {
  if (!document) return '';
  const content = String(document.content || '').trim();
  return [
    document.source,
    document.fileName,
    content.length,
    content.slice(0, 800),
    content.slice(-800),
  ].join('\n---yibiao-rejection-signature---\n');
}

function createRejectionCheckInputSignature(bidDocument, invalidBidAndRejectionItems, customCheckItems) {
  const bidSignature = createDocumentSignature(bidDocument);
  const analysis = String(invalidBidAndRejectionItems || '').trim();
  if (!bidSignature || !analysis) return '';
  const custom = String(customCheckItems || '').trim();
  return [
    bidSignature,
    analysis.length,
    analysis.slice(0, 800),
    analysis.slice(-800),
    custom.length,
    custom.slice(0, 800),
    custom.slice(-800),
  ].join('\n---yibiao-rejection-check-input---\n');
}

function getTechnicalPlanDiscardedBids(technicalPlan) {
  const task = technicalPlan?.bidAnalysisTasks?.discardedBids;
  return task?.status === 'success' && task.content?.trim() ? stripTripleQuoteWrapper(task.content) : '';
}

function taskFromRow(row) {
  if (!row) return undefined;
  return {
    task_id: row.task_id,
    type: row.type,
    status: normalizeStatus(row.status, ['running', 'success', 'error'], 'running'),
    progress: Number(row.progress || 0),
    logs: safeJsonParse(row.logs_json, []),
    started_at: row.started_at,
    updated_at: row.updated_at,
    error: row.error || undefined,
    stats: safeJsonParse(row.stats_json, undefined),
  };
}

function createRejectionCheckStore({ app, db, fileService, technicalPlanStore }) {
  const rejectionCheckDir = getRejectionCheckDir(app);

  function ensureMetaRow() {
    const existing = db.prepare('SELECT * FROM rejection_check_meta WHERE id = 1').get();
    if (existing) return existing;
    const timestamp = now();
    db.prepare(`
      INSERT INTO rejection_check_meta (
        id, step, active_document_tab, active_result_tab, active_check_result_tab, custom_check_items, check_options_json, created_at, updated_at
      ) VALUES (
        1, 'documents', 'tender', 'analysis', 'rejection', '', @check_options_json, @timestamp, @timestamp
      )
    `).run({ check_options_json: JSON.stringify(initialState.checkOptions), timestamp });
    return db.prepare('SELECT * FROM rejection_check_meta WHERE id = 1').get();
  }

  function updateMeta(fields) {
    ensureMetaRow();
    const entries = Object.entries(fields || {}).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE rejection_check_meta SET ${assignments}, updated_at = @updated_at WHERE id = 1`).run({
      ...Object.fromEntries(entries),
      updated_at: now(),
    });
  }

  function resolveMarkdownPath(relativeOrAbsolutePath, role) {
    const value = String(relativeOrAbsolutePath || '').trim();
    if (!value) return getRejectionCheckDocumentMarkdownPath(app, role);
    return path.isAbsolute(value) ? value : path.join(path.dirname(rejectionCheckDir), value);
  }

  function readDocumentMarkdown(role) {
    const documentRole = normalizeDocumentRole(role);
    const row = db.prepare('SELECT * FROM rejection_check_documents WHERE role = ?').get(documentRole);
    if (!row) return '';
    const filePath = resolveMarkdownPath(row.markdown_path, documentRole);
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
  }

  function writeDocumentMarkdown(role, markdown) {
    const documentRole = normalizeDocumentRole(role);
    const targetPath = getRejectionCheckDocumentMarkdownPath(app, documentRole);
    const tempPath = path.join(path.dirname(targetPath), `${documentRole}-${Date.now()}.tmp.md`);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(tempPath, `${String(markdown || '').trim()}\n`, 'utf-8');
    fs.renameSync(tempPath, targetPath);
    return targetPath;
  }

  function saveDocument(document) {
    if (!document?.role) return;
    const role = normalizeDocumentRole(document.role);
    const markdown = String(document.content || '').trim();
    if (!markdown) return;
    writeDocumentMarkdown(role, markdown);
    const timestamp = now();
    db.prepare(`
      INSERT INTO rejection_check_documents (
        role, source, file_name, markdown_path, content_hash, content_chars, parser_label, imported_at, updated_at
      ) VALUES (
        @role, @source, @file_name, @markdown_path, @content_hash, @content_chars, @parser_label, @imported_at, @updated_at
      ) ON CONFLICT(role) DO UPDATE SET
        source = excluded.source,
        file_name = excluded.file_name,
        markdown_path = excluded.markdown_path,
        content_hash = excluded.content_hash,
        content_chars = excluded.content_chars,
        parser_label = excluded.parser_label,
        imported_at = excluded.imported_at,
        updated_at = excluded.updated_at
    `).run({
      role,
      source: document.source === 'technical-plan' ? 'technical-plan' : 'upload',
      file_name: String(document.fileName || (role === 'bid' ? '投标文件' : '招标文件')),
      markdown_path: documentRelativePaths[role],
      content_hash: stableHash(markdown),
      content_chars: markdown.length,
      parser_label: document.parserLabel ? String(document.parserLabel) : null,
      imported_at: document.importedAt || timestamp,
      updated_at: timestamp,
    });
  }

  function loadDocument(role) {
    const documentRole = normalizeDocumentRole(role);
    const row = db.prepare('SELECT * FROM rejection_check_documents WHERE role = ?').get(documentRole);
    if (!row) return null;
    return {
      role: documentRole,
      fileName: row.file_name,
      content: readDocumentMarkdown(documentRole),
      source: row.source === 'technical-plan' ? 'technical-plan' : 'upload',
      parserLabel: row.parser_label || undefined,
      importedAt: row.imported_at,
    };
  }

  function clearDocument(role) {
    const documentRole = normalizeDocumentRole(role);
    db.prepare('DELETE FROM rejection_check_documents WHERE role = ?').run(documentRole);
    const targetPath = getRejectionCheckDocumentMarkdownPath(app, documentRole);
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true });
    deleteImportedImageBatches(app, `rejection-check-${documentRole}`);
    if (documentRole === 'tender') {
      clearExtractionAndCheckResults();
    } else {
      clearCheckResults();
    }
  }

  function saveTask(type, task) {
    if (!task) {
      db.prepare('DELETE FROM rejection_check_tasks WHERE type = ?').run(type);
      return;
    }
    const timestamp = now();
    db.prepare(`
      INSERT INTO rejection_check_tasks (type, task_id, status, progress, logs_json, stats_json, error, started_at, updated_at)
      VALUES (@type, @task_id, @status, @progress, @logs_json, @stats_json, @error, @started_at, @updated_at)
      ON CONFLICT(type) DO UPDATE SET
        task_id = excluded.task_id,
        status = excluded.status,
        progress = excluded.progress,
        logs_json = excluded.logs_json,
        stats_json = excluded.stats_json,
        error = excluded.error,
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
      started_at: task.started_at || timestamp,
      updated_at: task.updated_at || timestamp,
    });
  }

  function loadTasks() {
    const tasks = {};
    for (const row of db.prepare('SELECT * FROM rejection_check_tasks').all()) {
      const field = taskTypeFields[row.type];
      if (field) tasks[field] = taskFromRow(row);
    }
    return tasks;
  }

  function saveExtraction(extraction) {
    if (!extraction) {
      db.prepare('DELETE FROM rejection_check_extraction WHERE id = 1').run();
      return;
    }
    db.prepare(`
      INSERT INTO rejection_check_extraction (id, status, content, source, tender_signature, error, updated_at)
      VALUES (1, @status, @content, @source, @tender_signature, @error, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        content = excluded.content,
        source = excluded.source,
        tender_signature = excluded.tender_signature,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run({
      status: normalizeStatus(extraction.status, ['idle', 'running', 'success', 'error'], 'idle'),
      content: stripTripleQuoteWrapper(extraction.content || ''),
      source: extraction.source ? String(extraction.source) : null,
      tender_signature: extraction.tenderSignature ? String(extraction.tenderSignature) : null,
      error: extraction.error ? String(extraction.error) : null,
      updated_at: extraction.updatedAt || now(),
    });
  }

  function loadExtraction() {
    const row = db.prepare('SELECT * FROM rejection_check_extraction WHERE id = 1').get();
    if (!row) return { status: 'idle', content: '' };
    return {
      status: normalizeStatus(row.status, ['idle', 'running', 'success', 'error'], 'idle'),
      content: stripTripleQuoteWrapper(row.content || ''),
      source: row.source || undefined,
      tenderSignature: row.tender_signature || undefined,
      error: row.error || undefined,
      updatedAt: row.updated_at || undefined,
    };
  }

  function saveResult(resultType, result) {
    clearFindingRows(resultType);
    if (!result) {
      db.prepare('DELETE FROM rejection_check_results WHERE result_type = ?').run(resultType);
      return;
    }
    db.prepare(`
      INSERT INTO rejection_check_results (result_type, status, input_signature, active_finding_id, progress_message, error, updated_at)
      VALUES (@result_type, @status, @input_signature, @active_finding_id, @progress_message, @error, @updated_at)
      ON CONFLICT(result_type) DO UPDATE SET
        status = excluded.status,
        input_signature = excluded.input_signature,
        active_finding_id = excluded.active_finding_id,
        progress_message = excluded.progress_message,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run({
      result_type: resultType,
      status: normalizeStatus(result.status, ['idle', 'running', 'success', 'error'], 'idle'),
      input_signature: result.inputSignature ? String(result.inputSignature) : null,
      active_finding_id: result.activeFindingId ? String(result.activeFindingId) : null,
      progress_message: result.progressMessage ? String(result.progressMessage) : null,
      error: result.error ? String(result.error) : null,
      updated_at: result.updatedAt || now(),
    });
    saveFindingRows(resultType, result.findings || []);
  }

  function clearFindingRows(resultType) {
    if (resultType === 'rejection') db.prepare('DELETE FROM rejection_check_risk_findings').run();
    if (resultType === 'typo') db.prepare('DELETE FROM rejection_check_typo_findings').run();
    if (resultType === 'logic') db.prepare('DELETE FROM rejection_check_logic_findings').run();
  }

  function saveFindingRows(resultType, findings) {
    const timestamp = now();
    if (resultType === 'rejection') {
      const insert = db.prepare(`
        INSERT INTO rejection_check_risk_findings (
          finding_id, type, severity, title, summary, requirement, bid_evidence, risk_reason, suggestion, sort_order, created_at, updated_at
        ) VALUES (
          @finding_id, @type, @severity, @title, @summary, @requirement, @bid_evidence, @risk_reason, @suggestion, @sort_order, @created_at, @updated_at
        )
      `);
      findings.forEach((item, index) => insert.run({
        finding_id: String(item.id || `rejection-finding-${index + 1}`),
        type: item.type === 'invalidBid' ? 'invalidBid' : 'rejectionItem',
        severity: ['high', 'medium', 'low'].includes(item.severity) ? item.severity : 'medium',
        title: String(item.title || ''),
        summary: String(item.summary || item.title || ''),
        requirement: String(item.requirement || ''),
        bid_evidence: String(item.bidEvidence || ''),
        risk_reason: String(item.riskReason || ''),
        suggestion: String(item.suggestion || ''),
        sort_order: index,
        created_at: timestamp,
        updated_at: timestamp,
      }));
    }
    if (resultType === 'typo') {
      const insert = db.prepare(`
        INSERT INTO rejection_check_typo_findings (
          finding_id, wrong_text, correct_text, original_excerpt, reason, location_hint, sort_order, created_at, updated_at
        ) VALUES (
          @finding_id, @wrong_text, @correct_text, @original_excerpt, @reason, @location_hint, @sort_order, @created_at, @updated_at
        )
      `);
      findings.forEach((item, index) => insert.run({
        finding_id: String(item.id || `typo-finding-${index + 1}`),
        wrong_text: String(item.wrongText || ''),
        correct_text: String(item.correctText || ''),
        original_excerpt: String(item.originalExcerpt || ''),
        reason: String(item.reason || ''),
        location_hint: item.locationHint ? String(item.locationHint) : null,
        sort_order: index,
        created_at: timestamp,
        updated_at: timestamp,
      }));
    }
    if (resultType === 'logic') {
      const insert = db.prepare(`
        INSERT INTO rejection_check_logic_findings (
          finding_id, title, original_text, location_hint, fallacy_reason, suggestion, sort_order, created_at, updated_at
        ) VALUES (
          @finding_id, @title, @original_text, @location_hint, @fallacy_reason, @suggestion, @sort_order, @created_at, @updated_at
        )
      `);
      findings.forEach((item, index) => insert.run({
        finding_id: String(item.id || `logic-finding-${index + 1}`),
        title: String(item.title || ''),
        original_text: String(item.originalText || ''),
        location_hint: String(item.locationHint || ''),
        fallacy_reason: String(item.fallacyReason || ''),
        suggestion: String(item.suggestion || ''),
        sort_order: index,
        created_at: timestamp,
        updated_at: timestamp,
      }));
    }
  }

  function loadResult(resultType) {
    const row = db.prepare('SELECT * FROM rejection_check_results WHERE result_type = ?').get(resultType);
    const base = {
      status: 'idle',
      findings: [],
    };
    if (!row) return base;
    return {
      status: normalizeStatus(row.status, ['idle', 'running', 'success', 'error'], 'idle'),
      findings: loadFindingRows(resultType),
      inputSignature: row.input_signature || undefined,
      activeFindingId: row.active_finding_id || undefined,
      progressMessage: row.progress_message || undefined,
      error: row.error || undefined,
      updatedAt: row.updated_at || undefined,
    };
  }

  function loadFindingRows(resultType) {
    if (resultType === 'rejection') {
      return db.prepare('SELECT * FROM rejection_check_risk_findings ORDER BY sort_order ASC').all().map((item) => ({
        id: item.finding_id,
        type: item.type,
        severity: item.severity,
        title: item.title,
        summary: item.summary,
        requirement: item.requirement,
        bidEvidence: item.bid_evidence,
        riskReason: item.risk_reason,
        suggestion: item.suggestion,
      }));
    }
    if (resultType === 'typo') {
      return db.prepare('SELECT * FROM rejection_check_typo_findings ORDER BY sort_order ASC').all().map((item) => ({
        id: item.finding_id,
        wrongText: item.wrong_text,
        correctText: item.correct_text,
        originalExcerpt: item.original_excerpt,
        reason: item.reason,
        locationHint: item.location_hint || undefined,
      }));
    }
    return db.prepare('SELECT * FROM rejection_check_logic_findings ORDER BY sort_order ASC').all().map((item) => ({
      id: item.finding_id,
      title: item.title,
      originalText: item.original_text,
      locationHint: item.location_hint,
      fallacyReason: item.fallacy_reason,
      suggestion: item.suggestion,
    }));
  }

  function clearCheckResults() {
    db.prepare('DELETE FROM rejection_check_results').run();
    db.prepare('DELETE FROM rejection_check_risk_findings').run();
    db.prepare('DELETE FROM rejection_check_typo_findings').run();
    db.prepare('DELETE FROM rejection_check_logic_findings').run();
    db.prepare("DELETE FROM rejection_check_tasks WHERE type = 'rejection-check-run'").run();
  }

  function clearExtractionAndCheckResults() {
    db.prepare('DELETE FROM rejection_check_extraction').run();
    db.prepare("DELETE FROM rejection_check_tasks WHERE type = 'rejection-items-extraction'").run();
    clearCheckResults();
  }

  const updateRejectionCheckTransaction = db.transaction((partial) => {
    ensureMetaRow();
    const metaUpdates = {};
    if (hasOwn(partial, 'step')) metaUpdates.step = normalizeStep(partial.step);
    if (hasOwn(partial, 'activeDocumentTab')) metaUpdates.active_document_tab = normalizeDocumentRole(partial.activeDocumentTab);
    if (hasOwn(partial, 'activeResultTab')) metaUpdates.active_result_tab = normalizeResultTab(partial.activeResultTab);
    if (hasOwn(partial, 'activeCheckResultTab')) metaUpdates.active_check_result_tab = normalizeCheckResultTab(partial.activeCheckResultTab);
    if (hasOwn(partial, 'customCheckItems')) metaUpdates.custom_check_items = String(partial.customCheckItems || '');
    if (hasOwn(partial, 'checkOptions')) metaUpdates.check_options_json = JSON.stringify(normalizeCheckOptions(partial.checkOptions));
    if (Object.keys(metaUpdates).length) updateMeta(metaUpdates);

    if (hasOwn(partial, 'tenderDocument')) {
      if (partial.tenderDocument) saveDocument(partial.tenderDocument);
      else clearDocument('tender');
    }
    if (hasOwn(partial, 'bidDocument')) {
      if (partial.bidDocument) saveDocument(partial.bidDocument);
      else clearDocument('bid');
    }
    if (hasOwn(partial, 'invalidBidAndRejectionItems')) saveExtraction(partial.invalidBidAndRejectionItems);
    for (const [field, type] of Object.entries(resultFieldTypes)) {
      if (hasOwn(partial, field)) saveResult(type, partial[field]);
    }
    for (const [field, type] of Object.entries(taskFieldTypes)) {
      if (hasOwn(partial, field)) saveTask(type, partial[field]);
    }
  });

  function loadRejectionCheck() {
    const meta = ensureMetaRow();
    const tasks = loadTasks();
    return {
      ...initialState,
      tenderDocument: loadDocument('tender'),
      bidDocument: loadDocument('bid'),
      activeDocumentTab: normalizeDocumentRole(meta.active_document_tab),
      step: normalizeStep(meta.step),
      activeResultTab: normalizeResultTab(meta.active_result_tab),
      activeCheckResultTab: normalizeCheckResultTab(meta.active_check_result_tab),
      invalidBidAndRejectionItems: loadExtraction(),
      customCheckItems: meta.custom_check_items || '',
      checkOptions: normalizeCheckOptions(safeJsonParse(meta.check_options_json, initialState.checkOptions)),
      rejectionCheckResult: loadResult('rejection'),
      typoCheckResult: loadResult('typo'),
      logicCheckResult: loadResult('logic'),
      ...tasks,
    };
  }

  function updateRejectionCheck(partial) {
    updateRejectionCheckTransaction(partial || {});
    return loadRejectionCheck();
  }

  function saveRejectionCheck(state) {
    return updateRejectionCheck(state || {});
  }

  async function importDocument(role) {
    if (!fileService?.importRejectionCheckDocument) {
      throw new Error('文件导入服务尚未初始化');
    }
    const documentRole = normalizeDocumentRole(role);
    const result = await fileService.importRejectionCheckDocument(documentRole);
    if (!result?.success || !result.file_content) {
      return { success: false, message: result?.message || '未导入文件', state: loadRejectionCheck() };
    }
    const document = {
      role: documentRole,
      fileName: result.file_name || (documentRole === 'bid' ? '投标文件' : '招标文件'),
      content: result.file_content,
      source: 'upload',
      parserLabel: result.parser_label || undefined,
      importedAt: now(),
    };
    const transaction = db.transaction(() => {
      saveDocument(document);
      if (documentRole === 'tender') clearExtractionAndCheckResults();
      else clearCheckResults();
      updateMeta({ active_document_tab: documentRole });
    });
    transaction();
    return { success: true, message: result.message || '文件解析完成', state: loadRejectionCheck() };
  }

  async function importTenderFromTechnicalPlan() {
    if (!technicalPlanStore?.readTenderMarkdown || !technicalPlanStore?.loadTechnicalPlan) {
      throw new Error('技术方案缓存接口尚未初始化');
    }
    const markdown = technicalPlanStore.readTenderMarkdown();
    if (!markdown.trim()) {
      return { success: false, message: '技术方案中暂无可读取的招标文件正文', state: loadRejectionCheck() };
    }
    const technicalPlan = technicalPlanStore.loadTechnicalPlan();
    const document = {
      role: 'tender',
      fileName: technicalPlan?.tenderFile?.fileName || '技术方案招标文件',
      content: markdown,
      source: 'technical-plan',
      importedAt: now(),
    };
    const discardedBids = getTechnicalPlanDiscardedBids(technicalPlan);
    const tenderSignature = createDocumentSignature(document);
    const transaction = db.transaction(() => {
      saveDocument(document);
      clearExtractionAndCheckResults();
      if (discardedBids) {
        saveExtraction({
          status: 'success',
          content: discardedBids,
          source: 'technical-plan',
          tenderSignature,
          updatedAt: now(),
        });
      }
      updateMeta({ active_document_tab: 'tender' });
    });
    transaction();
    return { success: true, message: '已从技术方案读取招标文件', state: loadRejectionCheck() };
  }

  function removeDocument(role) {
    const transaction = db.transaction(() => {
      clearDocument(role);
      updateMeta({ active_document_tab: normalizeDocumentRole(role) });
    });
    transaction();
    return loadRejectionCheck();
  }

  function saveUiState(partial = {}) {
    const uiState = {};
    for (const field of ['step', 'activeDocumentTab', 'activeResultTab', 'activeCheckResultTab', 'customCheckItems', 'checkOptions']) {
      if (hasOwn(partial, field)) {
        uiState[field] = partial[field];
      }
    }
    return updateRejectionCheck(uiState);
  }

  function clearRejectionCheck() {
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM rejection_check_tasks').run();
      db.prepare('DELETE FROM rejection_check_extraction').run();
      db.prepare('DELETE FROM rejection_check_results').run();
      db.prepare('DELETE FROM rejection_check_risk_findings').run();
      db.prepare('DELETE FROM rejection_check_typo_findings').run();
      db.prepare('DELETE FROM rejection_check_logic_findings').run();
      db.prepare('DELETE FROM rejection_check_documents').run();
      db.prepare('DELETE FROM rejection_check_meta').run();
      ensureMetaRow();
    });
    transaction();
    if (fs.existsSync(rejectionCheckDir)) {
      fs.rmSync(rejectionCheckDir, { recursive: true, force: true });
    }
    deleteImportedImageBatches(app, 'rejection-check');
    return { success: true, message: '废标项检查缓存已清空', state: loadRejectionCheck() };
  }

  fs.mkdirSync(rejectionCheckDir, { recursive: true });

  return {
    loadRejectionCheck,
    saveRejectionCheck,
    updateRejectionCheck,
    clearRejectionCheck,
    importDocument,
    importTenderFromTechnicalPlan,
    removeDocument,
    readDocumentMarkdown,
    createDocumentSignature,
    createRejectionCheckInputSignature,
    saveUiState,
  };
}

module.exports = {
  createRejectionCheckStore,
};
