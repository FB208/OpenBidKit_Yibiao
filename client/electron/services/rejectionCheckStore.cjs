const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getRejectionCheckDir, getRejectionCheckDocumentMarkdownPath } = require('../utils/paths.cjs');
const {
  deleteImportedImageBatchesAsync,
  deleteImportedImageBatchesForExactScopeAsync,
} = require('../utils/importedImages.cjs');

const initialState = {
  tenderDocument: null,
  tenderDocuments: [],
  bidDocuments: [],
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

const tenderDocumentId = 'tender';

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

function normalizeDocumentTab(value) {
  const tab = String(value || '').trim();
  return tab || 'tender';
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
  const signatureId = document.role === 'bid' && document.id === 'bid-1' ? 'bid' : document.id || document.role;
  return [
    signatureId,
    document.source,
    document.fileName,
    content.length,
    content.slice(0, 800),
    content.slice(-800),
  ].join('\n---yibiao-rejection-signature---\n');
}

function createRejectionCheckInputSignature(bidDocuments, invalidBidAndRejectionItems, customCheckItems) {
  const documents = Array.isArray(bidDocuments) ? bidDocuments : [bidDocuments].filter(Boolean);
  const bidSignature = documents.map(createDocumentSignature).filter(Boolean).join('\n---yibiao-rejection-bid-document---\n');
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

function taskFromRow(row, taskLogStore) {
  if (!row) return undefined;
  return {
    task_id: row.task_id,
    type: row.type,
    status: normalizeStatus(row.status, ['running', 'success', 'error'], 'running'),
    progress: Number(row.progress || 0),
    logs: taskLogStore.list('rejection-check', row.type, row.task_id),
    started_at: row.started_at,
    updated_at: row.updated_at,
    error: row.error || undefined,
    stats: safeJsonParse(row.stats_json, undefined),
  };
}

function createRejectionCheckStore({ app, db, fileService, technicalPlanStore, taskLogStore }) {
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

  function createBidDocumentId(fileName, markdown) {
    const hash = stableHash(`${String(fileName || '')}\n${String(markdown || '')}`).slice(0, 16);
    return `bid-${hash}`;
  }

  function createTenderSourceDocumentId(fileName, markdown, index) {
    const hash = stableHash(`${String(fileName || '')}\n${String(markdown || '')}`).slice(0, 12);
    return `tender-${String(index + 1).padStart(2, '0')}-${hash}`;
  }

  function combineTenderMarkdown(documents) {
    return (Array.isArray(documents) ? documents : [])
      .map((document) => String(document?.file_content || document?.content || '').trim())
      .filter(Boolean)
      .join('\n\n');
  }

  function getDocumentMarkdownRelativePath(role, documentId) {
    if (role === 'bid') {
      const safeDocumentId = String(documentId || 'bid').replace(/[^a-zA-Z0-9_-]/g, '_');
      return `rejection-check/bids/${safeDocumentId}.md`;
    }
    if (String(documentId || '') && String(documentId) !== tenderDocumentId) {
      const safeDocumentId = String(documentId).replace(/[^a-zA-Z0-9_-]/g, '_');
      return `rejection-check/tenders/${safeDocumentId}.md`;
    }
    return 'rejection-check/tender.md';
  }

  function resolveMarkdownPath(relativeOrAbsolutePath, role, documentId) {
    const value = String(relativeOrAbsolutePath || '').trim();
    if (!value) return getRejectionCheckDocumentMarkdownPath(app, role, documentId);
    return path.isAbsolute(value) ? value : path.join(path.dirname(rejectionCheckDir), value);
  }

  function loadDocumentRow(roleOrDocumentId, documentId) {
    if (documentId) {
      return db.prepare('SELECT * FROM rejection_check_documents WHERE document_id = ? AND role = ?').get(String(documentId), normalizeDocumentRole(roleOrDocumentId));
    }
    const value = String(roleOrDocumentId || '').trim();
    if (value === 'tender') {
      return db.prepare("SELECT * FROM rejection_check_documents WHERE role = 'tender' ORDER BY sort_order ASC LIMIT 1").get();
    }
    if (value === 'bid') {
      return db.prepare("SELECT * FROM rejection_check_documents WHERE role = 'bid' ORDER BY sort_order ASC LIMIT 1").get();
    }
    return db.prepare('SELECT * FROM rejection_check_documents WHERE document_id = ?').get(value);
  }

  function readDocumentMarkdown(roleOrDocumentId, documentId) {
    const row = loadDocumentRow(roleOrDocumentId, documentId);
    if (!row) return '';
    const filePath = resolveMarkdownPath(row.markdown_path, row.role, row.document_id);
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
  }

  function createPreparedDocument(document, sortOrder = 0) {
    if (!document?.role) return null;
    const role = normalizeDocumentRole(document.role);
    const markdown = String(document.content || '').trim();
    if (!markdown) return null;
    const documentId = role === 'tender'
      ? String(document.id || tenderDocumentId)
      : String(document.id || createBidDocumentId(document.fileName, markdown));
    const timestamp = now();
    const safeDocumentId = documentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const directory = role === 'bid' ? 'bids' : documentId === tenderDocumentId ? '' : 'tenders';
    const fileName = `${safeDocumentId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.md`;
    const markdownPath = path.posix.join('rejection-check', directory, fileName);
    return {
      content: `${markdown}\n`,
      absolutePath: path.join(path.dirname(rejectionCheckDir), ...markdownPath.split('/')),
      values: {
        document_id: documentId,
        role,
        source: document.source === 'technical-plan' ? 'technical-plan' : 'upload',
        file_name: String(document.fileName || (role === 'bid' ? '投标文件' : '招标文件')),
        markdown_path: markdownPath,
        content_hash: stableHash(markdown),
        content_chars: markdown.length,
        parser_label: document.parserLabel ? String(document.parserLabel) : null,
        sort_order: Number(sortOrder || 0),
        imported_at: document.importedAt || timestamp,
        updated_at: timestamp,
      },
    };
  }

  function savePreparedDocument(prepared) {
    if (!prepared) return '';
    db.prepare(`
      INSERT INTO rejection_check_documents (
        document_id, role, source, file_name, markdown_path, content_hash, content_chars, parser_label, sort_order, imported_at, updated_at
      ) VALUES (
        @document_id, @role, @source, @file_name, @markdown_path, @content_hash, @content_chars, @parser_label, @sort_order, @imported_at, @updated_at
      ) ON CONFLICT(document_id) DO UPDATE SET
        role = excluded.role,
        source = excluded.source,
        file_name = excluded.file_name,
        markdown_path = excluded.markdown_path,
        content_hash = excluded.content_hash,
        content_chars = excluded.content_chars,
        parser_label = excluded.parser_label,
        sort_order = excluded.sort_order,
        imported_at = excluded.imported_at,
        updated_at = excluded.updated_at
    `).run(prepared.values);
    return prepared.values.document_id;
  }

  function writePreparedDocumentsSync(preparedDocuments) {
    const written = [];
    try {
      for (const prepared of preparedDocuments) {
        fs.mkdirSync(path.dirname(prepared.absolutePath), { recursive: true });
        fs.writeFileSync(prepared.absolutePath, prepared.content, 'utf-8');
        written.push(prepared);
      }
    } catch (error) {
      written.forEach((prepared) => runCleanupSync(
        `回收未写完 Markdown 失败：${prepared.absolutePath}`,
        () => fs.rmSync(prepared.absolutePath, { force: true }),
      ));
      throw error;
    }
  }

  async function writePreparedDocuments(preparedDocuments) {
    const written = [];
    try {
      for (const prepared of preparedDocuments) {
        await fs.promises.mkdir(path.dirname(prepared.absolutePath), { recursive: true });
        await fs.promises.writeFile(prepared.absolutePath, prepared.content, 'utf-8');
        written.push(prepared);
      }
    } catch (error) {
      await Promise.all(written.map((prepared) => runCleanup(
        `回收未写完 Markdown 失败：${prepared.absolutePath}`,
        () => fs.promises.rm(prepared.absolutePath, { force: true }),
      )));
      throw error;
    }
  }

  function loadTenderSourceDocuments() {
    return db.prepare("SELECT * FROM rejection_check_documents WHERE role = 'tender' AND document_id != ? ORDER BY sort_order ASC, imported_at ASC").all(tenderDocumentId)
      .map(documentFromRow)
      .filter(Boolean);
  }

  function documentFromRow(row) {
    if (!row) return null;
    const filePath = resolveMarkdownPath(row.markdown_path, row.role, row.document_id);
    return {
      id: row.document_id || row.role,
      role: normalizeDocumentRole(row.role),
      fileName: row.file_name,
      content: fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '',
      source: row.source === 'technical-plan' ? 'technical-plan' : 'upload',
      parserLabel: row.parser_label || undefined,
      importedAt: row.imported_at,
    };
  }

  function resequenceBidDocuments() {
    const rows = db.prepare("SELECT document_id FROM rejection_check_documents WHERE role = 'bid' ORDER BY sort_order ASC, imported_at ASC").all();
    const update = db.prepare('UPDATE rejection_check_documents SET sort_order = ?, updated_at = ? WHERE document_id = ?');
    const timestamp = now();
    rows.forEach((row, index) => update.run(index, timestamp, row.document_id));
  }

  function reportCleanupError(label, error) {
    console.warn(`[rejection-check] ${label}`, error);
  }

  function runCleanupSync(label, cleanup) {
    try {
      cleanup();
    } catch (error) {
      reportCleanupError(label, error);
    }
  }

  async function runCleanup(label, cleanup) {
    try {
      await cleanup();
    } catch (error) {
      reportCleanupError(label, error);
    }
  }

  function removeMarkdownRowsSync(rows) {
    for (const row of rows || []) {
      const targetPath = resolveMarkdownPath(row.markdown_path, row.role, row.document_id);
      runCleanupSync(`清理 Markdown 失败：${targetPath}`, () => fs.rmSync(targetPath, { force: true }));
    }
  }

  async function removeMarkdownRows(rows) {
    await Promise.all((rows || []).map((row) => {
      const targetPath = resolveMarkdownPath(row.markdown_path, row.role, row.document_id);
      return runCleanup(`清理 Markdown 失败：${targetPath}`, () => fs.promises.rm(targetPath, { force: true }));
    }));
  }

  function clearDocumentRows(role, documentId) {
    const documentRole = normalizeDocumentRole(role);
    if (documentRole === 'tender') {
      const rows = db.prepare("SELECT * FROM rejection_check_documents WHERE role = 'tender'").all();
      db.prepare("DELETE FROM rejection_check_documents WHERE role = 'tender'").run();
      clearExtractionAndCheckResults();
      return rows;
    } else {
      const rows = documentId
        ? db.prepare("SELECT * FROM rejection_check_documents WHERE role = 'bid' AND document_id = ?").all(String(documentId))
        : db.prepare("SELECT * FROM rejection_check_documents WHERE role = 'bid'").all();
      if (documentId) {
        db.prepare("DELETE FROM rejection_check_documents WHERE role = 'bid' AND document_id = ?").run(String(documentId));
      } else {
        db.prepare("DELETE FROM rejection_check_documents WHERE role = 'bid'").run();
      }
      resequenceBidDocuments();
      clearCheckResults();
      return rows;
    }
  }

  function createDocumentMutation(partial) {
    const mutation = {
      preparedDocuments: [],
      oldRows: [],
      clearTender: false,
      clearBid: false,
    };
    if (hasOwn(partial, 'tenderDocuments')) {
      mutation.clearTender = true;
      mutation.oldRows.push(...db.prepare("SELECT * FROM rejection_check_documents WHERE role = 'tender'").all());
      const documents = Array.isArray(partial.tenderDocuments) ? partial.tenderDocuments : [];
      const mainDocument = hasOwn(partial, 'tenderDocument')
        ? partial.tenderDocument
        : {
          id: tenderDocumentId,
          role: 'tender',
          fileName: documents.length > 1 ? `${documents.length} 份招标文件` : documents[0]?.fileName || '招标文件',
          content: combineTenderMarkdown(documents),
          source: documents[0]?.source || 'upload',
          parserLabel: documents.length > 1 ? undefined : documents[0]?.parserLabel,
          importedAt: now(),
        };
      const preparedMainDocument = createPreparedDocument(mainDocument, 0);
      if (preparedMainDocument) {
        mutation.preparedDocuments.push(preparedMainDocument);
      }
      documents.forEach((document, index) => {
        mutation.preparedDocuments.push(createPreparedDocument(document, index + 1));
      });
    } else if (hasOwn(partial, 'tenderDocument')) {
      if (partial.tenderDocument) {
        const prepared = createPreparedDocument(partial.tenderDocument);
        if (prepared) {
          const oldRow = db.prepare('SELECT * FROM rejection_check_documents WHERE document_id = ?').get(prepared.values.document_id);
          if (oldRow) mutation.oldRows.push(oldRow);
          mutation.preparedDocuments.push(prepared);
        }
      } else {
        mutation.clearTender = true;
        mutation.oldRows.push(...db.prepare("SELECT * FROM rejection_check_documents WHERE role = 'tender'").all());
      }
    }
    if (hasOwn(partial, 'bidDocuments')) {
      mutation.clearBid = true;
      mutation.oldRows.push(...db.prepare("SELECT * FROM rejection_check_documents WHERE role = 'bid'").all());
      (Array.isArray(partial.bidDocuments) ? partial.bidDocuments : []).forEach((document, index) => {
        mutation.preparedDocuments.push(createPreparedDocument(document, index));
      });
    }
    mutation.preparedDocuments = mutation.preparedDocuments.filter(Boolean);
    return mutation;
  }

  function applyDocumentMutation(mutation) {
    if (mutation.clearTender) clearDocumentRows('tender');
    if (mutation.clearBid) clearDocumentRows('bid');
    mutation.preparedDocuments.forEach(savePreparedDocument);
  }

  async function cleanupDocumentMutation(mutation) {
    await removeMarkdownRows(mutation.oldRows);
    if (mutation.clearTender) {
      await runCleanup('清理招标文件图片失败', () => deleteImportedImageBatchesAsync(app, 'rejection-check-tender'));
    }
    if (mutation.clearBid) {
      await runCleanup('清理投标文件图片失败', () => deleteImportedImageBatchesAsync(app, 'rejection-check-bid'));
    }
  }

  function saveTask(type, task) {
    if (!task) {
      db.prepare('DELETE FROM rejection_check_tasks WHERE type = ?').run(type);
      return;
    }
    const timestamp = now();
    db.prepare(`
      INSERT INTO rejection_check_tasks (type, task_id, status, progress, stats_json, error, started_at, updated_at)
      VALUES (@type, @task_id, @status, @progress, @stats_json, @error, @started_at, @updated_at)
      ON CONFLICT(type) DO UPDATE SET
        task_id = excluded.task_id,
        status = excluded.status,
        progress = excluded.progress,
        stats_json = excluded.stats_json,
        error = excluded.error,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `).run({
      type,
      task_id: String(task.task_id || ''),
      status: String(task.status || 'running'),
      progress: Math.max(0, Math.min(100, Math.round(Number(task.progress || 0)))),
      stats_json: jsonOrNull(task.stats),
      error: task.error ? String(task.error) : null,
      started_at: task.started_at || timestamp,
      updated_at: task.updated_at || timestamp,
    });
    taskLogStore.sync('rejection-check', type, String(task.task_id || ''), task.logs, task.updated_at || timestamp);
  }

  function loadTasks() {
    const tasks = {};
    for (const row of db.prepare('SELECT * FROM rejection_check_tasks').all()) {
      const field = taskTypeFields[row.type];
      if (field) tasks[field] = taskFromRow(row, taskLogStore);
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
    if (!result) {
      clearFindingRows(resultType);
      db.prepare('DELETE FROM rejection_check_results WHERE result_type = ?').run(resultType);
      return;
    }
    const existing = db.prepare('SELECT * FROM rejection_check_results WHERE result_type = ?').get(resultType);
    const timestamp = now();
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
      status: hasOwn(result, 'status')
        ? normalizeStatus(result.status, ['idle', 'running', 'success', 'error'], 'idle')
        : existing?.status || 'idle',
      input_signature: hasOwn(result, 'inputSignature')
        ? result.inputSignature ? String(result.inputSignature) : null
        : existing?.input_signature || null,
      active_finding_id: hasOwn(result, 'activeFindingId')
        ? result.activeFindingId ? String(result.activeFindingId) : null
        : existing?.active_finding_id || null,
      progress_message: hasOwn(result, 'progressMessage')
        ? result.progressMessage ? String(result.progressMessage) : null
        : existing?.progress_message || null,
      error: hasOwn(result, 'error')
        ? result.error ? String(result.error) : null
        : existing?.error || null,
      updated_at: result.updatedAt || timestamp,
    });
    if (hasOwn(result, 'findings')) {
      clearFindingRows(resultType);
      saveFindingRows(resultType, result.findings || []);
    }
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
          finding_id, bid_document_id, type, severity, title, summary, requirement, bid_evidence, risk_reason, suggestion, sort_order, created_at, updated_at
        ) VALUES (
          @finding_id, @bid_document_id, @type, @severity, @title, @summary, @requirement, @bid_evidence, @risk_reason, @suggestion, @sort_order, @created_at, @updated_at
        )
      `);
      findings.forEach((item, index) => insert.run({
        finding_id: String(item.id || `rejection-finding-${index + 1}`),
        bid_document_id: item.bidDocumentId ? String(item.bidDocumentId) : null,
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
          finding_id, bid_document_id, wrong_text, correct_text, original_excerpt, reason, location_hint, sort_order, created_at, updated_at
        ) VALUES (
          @finding_id, @bid_document_id, @wrong_text, @correct_text, @original_excerpt, @reason, @location_hint, @sort_order, @created_at, @updated_at
        )
      `);
      findings.forEach((item, index) => insert.run({
        finding_id: String(item.id || `typo-finding-${index + 1}`),
        bid_document_id: item.bidDocumentId ? String(item.bidDocumentId) : null,
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
          finding_id, bid_document_id, title, original_text, location_hint, fallacy_reason, suggestion, sort_order, created_at, updated_at
        ) VALUES (
          @finding_id, @bid_document_id, @title, @original_text, @location_hint, @fallacy_reason, @suggestion, @sort_order, @created_at, @updated_at
        )
      `);
      findings.forEach((item, index) => insert.run({
        finding_id: String(item.id || `logic-finding-${index + 1}`),
        bid_document_id: item.bidDocumentId ? String(item.bidDocumentId) : null,
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
    const fallbackBidDocumentId = db.prepare("SELECT document_id FROM rejection_check_documents WHERE role = 'bid' ORDER BY sort_order ASC LIMIT 1").get()?.document_id || '';
    if (resultType === 'rejection') {
      return db.prepare('SELECT * FROM rejection_check_risk_findings ORDER BY sort_order ASC').all().map((item) => ({
        id: item.finding_id,
        bidDocumentId: item.bid_document_id || fallbackBidDocumentId,
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
        bidDocumentId: item.bid_document_id || fallbackBidDocumentId,
        wrongText: item.wrong_text,
        correctText: item.correct_text,
        originalExcerpt: item.original_excerpt,
        reason: item.reason,
        locationHint: item.location_hint || undefined,
      }));
    }
    return db.prepare('SELECT * FROM rejection_check_logic_findings ORDER BY sort_order ASC').all().map((item) => ({
      id: item.finding_id,
      bidDocumentId: item.bid_document_id || fallbackBidDocumentId,
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

  const updateRejectionCheckTransaction = db.transaction((partial, documentMutation) => {
    ensureMetaRow();
    const metaUpdates = {};
    if (hasOwn(partial, 'step')) metaUpdates.step = normalizeStep(partial.step);
    if (hasOwn(partial, 'activeDocumentTab')) metaUpdates.active_document_tab = normalizeDocumentTab(partial.activeDocumentTab);
    if (hasOwn(partial, 'activeResultTab')) metaUpdates.active_result_tab = normalizeResultTab(partial.activeResultTab);
    if (hasOwn(partial, 'activeCheckResultTab')) metaUpdates.active_check_result_tab = normalizeCheckResultTab(partial.activeCheckResultTab);
    if (hasOwn(partial, 'customCheckItems')) metaUpdates.custom_check_items = String(partial.customCheckItems || '');
    if (hasOwn(partial, 'checkOptions')) metaUpdates.check_options_json = JSON.stringify(normalizeCheckOptions(partial.checkOptions));
    if (Object.keys(metaUpdates).length) updateMeta(metaUpdates);

    applyDocumentMutation(documentMutation);
    if (hasOwn(partial, 'invalidBidAndRejectionItems')) saveExtraction(partial.invalidBidAndRejectionItems);
    for (const [field, type] of Object.entries(resultFieldTypes)) {
      if (hasOwn(partial, field)) saveResult(type, partial[field]);
    }
    for (const [field, type] of Object.entries(taskFieldTypes)) {
      if (hasOwn(partial, field)) saveTask(type, partial[field]);
    }
  });

  function loadRejectionCheck() {
    const meta = db.prepare('SELECT * FROM rejection_check_meta WHERE id = 1').get();
    if (!meta) throw new Error('废标项检查数据库尚未初始化');
    const tasks = loadTasks();
    const documents = db.prepare('SELECT * FROM rejection_check_documents ORDER BY role ASC, sort_order ASC, imported_at ASC').all();
    const tenderRows = documents.filter((row) => row.role === 'tender');
    const tenderDocument = documentFromRow(tenderRows.find((row) => row.document_id === tenderDocumentId) || tenderRows[0]);
    const tenderDocuments = tenderRows.filter((row) => row.document_id !== tenderDocumentId).map(documentFromRow).filter(Boolean);
    const bidDocuments = documents.filter((row) => row.role === 'bid').map(documentFromRow).filter(Boolean);
    const activeDocumentTab = normalizeDocumentTab(meta.active_document_tab);
    const validActiveDocumentTab = activeDocumentTab === 'tender'
      || tenderDocuments.some((document) => document.id === activeDocumentTab)
      || bidDocuments.some((document) => document.id === activeDocumentTab)
      ? activeDocumentTab
      : tenderDocument
        ? 'tender'
        : bidDocuments[0]?.id || 'tender';
    return {
      ...initialState,
      tenderDocument,
      tenderDocuments,
      bidDocuments,
      activeDocumentTab: validActiveDocumentTab,
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

  function updateRejectionCheckWithoutReload(partial) {
    const nextPartial = partial || {};
    const documentMutation = createDocumentMutation(nextPartial);
    writePreparedDocumentsSync(documentMutation.preparedDocuments);
    try {
      updateRejectionCheckTransaction(nextPartial, documentMutation);
    } catch (error) {
      removeMarkdownRowsSync(documentMutation.preparedDocuments.map((prepared) => ({
        markdown_path: prepared.values.markdown_path,
        role: prepared.values.role,
        document_id: prepared.values.document_id,
      })));
      throw error;
    }
    void cleanupDocumentMutation(documentMutation);
  }

  async function updateRejectionCheckWithAsyncFiles(partial) {
    const nextPartial = partial || {};
    const documentMutation = createDocumentMutation(nextPartial);
    await writePreparedDocuments(documentMutation.preparedDocuments);
    try {
      updateRejectionCheckTransaction(nextPartial, documentMutation);
    } catch (error) {
      await removeMarkdownRows(documentMutation.preparedDocuments.map((prepared) => ({
        markdown_path: prepared.values.markdown_path,
        role: prepared.values.role,
        document_id: prepared.values.document_id,
      })));
      throw error;
    }
    await cleanupDocumentMutation(documentMutation);
  }

  function updateRejectionCheck(partial) {
    updateRejectionCheckWithoutReload(partial);
  }

  function saveRejectionCheck(state) {
    return updateRejectionCheck(state || {});
  }

  async function importDocument(role, filePaths) {
    if (!fileService?.importRejectionCheckDocument) {
      throw new Error('文件导入服务尚未初始化');
    }
    const documentRole = normalizeDocumentRole(role);
    const result = await fileService.importRejectionCheckDocument(documentRole, filePaths);
    const importedDocuments = Array.isArray(result?.documents)
      ? result.documents
      : result?.file_content
        ? [result]
        : [];
    if (!result?.success || !importedDocuments.length) {
      return { success: false, message: result?.message || '未导入文件' };
    }
    let addedCount = 0;
    let skippedCount = 0;
    let firstAddedBidDocumentId = '';
    if (documentRole === 'tender') {
      const existingDocuments = loadTenderSourceDocuments();
      const existingKeys = new Set(existingDocuments.map((document) => `${document.fileName}\u0000${stableHash(document.content)}`));
      const addedDocuments = [];
      importedDocuments.forEach((item) => {
        const markdown = String(item.file_content || '').trim();
        if (!markdown) return;
        const fileName = item.file_name || '招标文件';
        const key = `${fileName}\u0000${stableHash(markdown)}`;
        if (existingKeys.has(key)) {
          skippedCount += 1;
          return;
        }
        existingKeys.add(key);
        addedDocuments.push({
          id: createTenderSourceDocumentId(fileName, markdown, existingDocuments.length + addedDocuments.length),
          role: 'tender',
          fileName,
          content: markdown,
          source: 'upload',
          parserLabel: item.parser_label || undefined,
          importedAt: now(),
        });
      });
      addedCount = addedDocuments.length;
      if (addedCount > 0) {
        await updateRejectionCheckWithAsyncFiles({
          tenderDocuments: [...existingDocuments, ...addedDocuments],
          activeDocumentTab: 'tender',
        });
      }
    } else {
      const existingRows = db.prepare("SELECT document_id, file_name, content_hash FROM rejection_check_documents WHERE role = 'bid'").all();
      const existingKeys = new Set(existingRows.map((row) => `${row.file_name}\u0000${row.content_hash}`));
      const preparedDocuments = [];
      let sortOrder = existingRows.length;
      for (const item of importedDocuments) {
        const markdown = String(item.file_content || '').trim();
        if (!markdown) continue;
        const fileName = item.file_name || '投标文件';
        const contentHash = stableHash(markdown);
        const key = `${fileName}\u0000${contentHash}`;
        if (existingKeys.has(key)) {
          skippedCount += 1;
          continue;
        }
        const prepared = createPreparedDocument({
          id: createBidDocumentId(fileName, markdown),
          role: 'bid',
          fileName,
          content: markdown,
          source: 'upload',
          parserLabel: item.parser_label || undefined,
          importedAt: now(),
        }, sortOrder);
        preparedDocuments.push(prepared);
        existingKeys.add(key);
        if (!firstAddedBidDocumentId) firstAddedBidDocumentId = prepared.values.document_id;
        sortOrder += 1;
      }
      await writePreparedDocuments(preparedDocuments);
      const transaction = db.transaction(() => {
        preparedDocuments.forEach(savePreparedDocument);
        if (preparedDocuments.length) {
          clearCheckResults();
          updateMeta({ active_document_tab: firstAddedBidDocumentId || 'tender' });
        }
      });
      try {
        transaction();
      } catch (error) {
        await Promise.all(preparedDocuments.map((prepared) => runCleanup(
          `回收未提交 Markdown 失败：${prepared.absolutePath}`,
          () => fs.promises.rm(prepared.absolutePath, { force: true }),
        )));
        throw error;
      }
      addedCount = preparedDocuments.length;
    }
    const failedCount = Array.isArray(result?.errors) ? result.errors.length : 0;
    const fallbackToLocal = importedDocuments.some((item) => item?.fallback_to_local) || String(result?.message || '').includes('自动使用本地解析');
    if (addedCount === 0) {
      const messageParts = [];
      if (skippedCount > 0) messageParts.push(`已跳过 ${skippedCount} 份重复文件`);
      if (failedCount > 0) messageParts.push(`失败 ${failedCount} 份`);
      const message = messageParts.length ? messageParts.join('，') : result.message || '未导入文件';
      return { success: false, message };
    }
    const documentLabel = documentRole === 'bid' ? '投标文件' : '招标文件';
    const messageParts = [`已解析 ${addedCount} 份${documentLabel}`];
    if (fallbackToLocal) messageParts.push('当前格式已自动使用本地解析');
    if (skippedCount > 0) messageParts.push(`跳过 ${skippedCount} 份重复文件`);
    if (failedCount > 0) messageParts.push(`失败 ${failedCount} 份`);
    return { success: true, message: messageParts.join('，') };
  }

  async function importTenderFromTechnicalPlan() {
    if (!technicalPlanStore?.readTenderMarkdown || !technicalPlanStore?.loadTechnicalPlan) {
      throw new Error('技术方案缓存接口尚未初始化');
    }
    const markdown = technicalPlanStore.readTenderMarkdown();
    if (!markdown.trim()) {
      return { success: false, message: '技术方案中暂无可读取的招标文件正文' };
    }
    const technicalPlan = technicalPlanStore.loadTechnicalPlan();
    const sourceFiles = Array.isArray(technicalPlan?.tenderFiles) ? technicalPlan.tenderFiles : [];
    const sourceDocuments = sourceFiles
      .map((file, index) => {
        const content = typeof technicalPlanStore.readTenderSourceMarkdown === 'function'
          ? String(technicalPlanStore.readTenderSourceMarkdown(file.id) || '').trim()
          : '';
        if (!content) return null;
        return {
          id: createTenderSourceDocumentId(file.fileName || '技术方案招标文件', content, index),
          role: 'tender',
          fileName: file.fileName || '技术方案招标文件',
          content,
          source: 'technical-plan',
          parserLabel: file.parserLabel || undefined,
          importedAt: file.importedAt || now(),
        };
      })
      .filter(Boolean);
    const documentsToSave = sourceDocuments.length
      ? sourceDocuments
      : [{
        id: 'tender-technical-plan',
        role: 'tender',
        fileName: technicalPlan?.tenderFile?.fileName || '技术方案招标文件',
        content: markdown,
        source: 'technical-plan',
        importedAt: now(),
      }];
    const discardedBids = getTechnicalPlanDiscardedBids(technicalPlan);
    const mainDocument = {
      id: tenderDocumentId,
      role: 'tender',
      fileName: documentsToSave.length > 1 ? `${documentsToSave.length} 份技术方案招标文件` : documentsToSave[0]?.fileName || '技术方案招标文件',
      content: markdown,
      source: 'technical-plan',
      importedAt: now(),
    };
    const tenderSignature = createDocumentSignature(mainDocument);
    await updateRejectionCheckWithAsyncFiles({
      tenderDocument: mainDocument,
      tenderDocuments: documentsToSave,
      activeDocumentTab: 'tender',
      ...(discardedBids ? {
        invalidBidAndRejectionItems: {
          status: 'success',
          content: discardedBids,
          source: 'technical-plan',
          tenderSignature,
          updatedAt: now(),
        },
      } : {}),
    });
    return { success: true, message: '已从技术方案读取招标文件' };
  }

  async function removeDocument(role, documentId) {
    const documentRole = normalizeDocumentRole(role);
    if (documentRole === 'tender' && documentId && String(documentId) !== tenderDocumentId) {
      const remaining = loadTenderSourceDocuments().filter((document) => document.id !== String(documentId));
      await updateRejectionCheckWithAsyncFiles({
        tenderDocuments: remaining,
        activeDocumentTab: 'tender',
      });
      return;
    }
    let removedRows = [];
    const transaction = db.transaction(() => {
      removedRows = clearDocumentRows(role, documentId);
      if (normalizeDocumentRole(role) === 'bid') {
        const nextBid = db.prepare("SELECT document_id FROM rejection_check_documents WHERE role = 'bid' ORDER BY sort_order ASC LIMIT 1").get();
        updateMeta({ active_document_tab: nextBid?.document_id || 'tender' });
      } else {
        updateMeta({ active_document_tab: 'tender' });
      }
    });
    transaction();
    await removeMarkdownRows(removedRows);
    if (normalizeDocumentRole(role) === 'tender') {
      await runCleanup('清理招标文件图片失败', () => deleteImportedImageBatchesAsync(app, 'rejection-check-tender'));
    } else if (documentId) {
      await runCleanup(`清理投标文件图片失败：${documentId}`, () => deleteImportedImageBatchesAsync(app, `rejection-check-bid-${documentId}`));
      if (documentId === 'bid-1') {
        await runCleanup('清理旧投标文件图片失败', () => deleteImportedImageBatchesForExactScopeAsync(app, 'rejection-check-bid'));
      }
    } else {
      await runCleanup('清理投标文件图片失败', () => deleteImportedImageBatchesAsync(app, 'rejection-check-bid'));
    }
  }

  function saveUiState(partial = {}) {
    const uiState = {};
    for (const field of ['step', 'activeDocumentTab', 'activeResultTab', 'activeCheckResultTab', 'customCheckItems', 'checkOptions']) {
      if (hasOwn(partial, field)) {
        uiState[field] = partial[field];
      }
    }
    updateRejectionCheckWithoutReload(uiState);
  }

  async function clearRejectionCheck() {
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
    await runCleanup('清理废标检查目录失败', () => fs.promises.rm(rejectionCheckDir, { recursive: true, force: true }));
    await runCleanup('清理废标检查图片失败', () => deleteImportedImageBatchesAsync(app, 'rejection-check'));
    return { success: true, message: '废标项检查缓存已清空' };
  }

  fs.mkdirSync(rejectionCheckDir, { recursive: true });
  ensureMetaRow();

  return {
    loadRejectionCheck,
    saveRejectionCheck,
    updateRejectionCheck,
    updateRejectionCheckWithoutReload,
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
