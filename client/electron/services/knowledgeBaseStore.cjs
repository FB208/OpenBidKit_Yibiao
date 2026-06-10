const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getKnowledgeBaseDir } = require('../utils/paths.cjs');

const documentStatuses = ['pending', 'copying', 'converting', 'extracting', 'ready_for_matching', 'matching', 'recovering', 'analyzing', 'saving', 'success', 'error'];
const documentStepKeys = ['copy_source', 'convert_markdown', 'build_blocks', 'extract_first_items', 'extract_supplement_items', 'merge_candidates', 'match_batches', 'recover_missing', 'save_result'];
const stepStatuses = ['idle', 'running', 'success', 'error'];
const legacyResultJsonFiles = [
  'blocks.json',
  'filtered_blocks.json',
  'candidate_items.json',
  'match_result.json',
  'report.json',
  'items.json',
];

function now() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function safeName(name) {
  return String(name || '未命名').replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_').trim() || '未命名';
}

function normalizeStatus(value) {
  return documentStatuses.includes(value) ? value : 'pending';
}

function normalizeStepStatus(value) {
  return stepStatuses.includes(value) ? value : 'idle';
}

function normalizeDropPosition(value) {
  return value === 'before' ? 'before' : 'after';
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function jsonOrNull(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function stableHash(content) {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

function hashFileIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return stableHash(fs.readFileSync(filePath, 'utf-8'));
}

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function getContentCharCount(text) {
  return String(text || '').replace(/\s+/g, '').length;
}

function getArrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function createEmptyIndex() {
  return { folders: [], documents: [] };
}

function defaultDocumentDir(folderId, documentId) {
  return path.join('folders', folderId || 'unknown', 'documents', documentId || createId('doc')).replace(/\\/g, '/');
}

function normalizeDocument(document) {
  const documentId = String(document?.id || document?.document_id || createId('doc'));
  const folderId = String(document?.folder_id || document?.folderId || 'unknown');
  const documentDir = normalizeRelativePath(document?.document_dir || defaultDocumentDir(folderId, documentId));
  const sourceExtension = String(document?.source_extension || document?.extension || path.extname(document?.source_path || document?.file_name || '') || '').toLowerCase();
  const sourcePath = normalizeRelativePath(document?.source_path || path.join(documentDir, sourceExtension ? `source${sourceExtension}` : 'source'));
  const markdownPath = normalizeRelativePath(document?.markdown_path || path.join(documentDir, 'content.md'));
  const hasSortOrder = hasOwn(document, 'sort_order') || hasOwn(document, 'sortOrder');
  return {
    id: documentId,
    folder_id: folderId,
    file_name: String(document?.file_name || document?.fileName || '未命名文档'),
    document_dir: documentDir,
    source_path: sourcePath,
    markdown_path: markdownPath,
    source_extension: sourceExtension,
    status: normalizeStatus(document?.status),
    progress: Math.max(0, Math.min(100, Math.round(Number(document?.progress || 0)))),
    message: String(document?.message || '等待处理'),
    error: document?.error ? String(document.error) : undefined,
    item_count: Number(document?.item_count || 0),
    block_count: Number(document?.block_count || 0),
    filtered_block_count: Number(document?.filtered_block_count || 0),
    candidate_item_count: Number(document?.candidate_item_count || 0),
    discarded_block_count: Number(document?.discarded_block_count || 0),
    system_discarded_after_retry_count: Number(document?.system_discarded_after_retry_count || 0),
    last_batch_size: document?.last_batch_size === undefined || document?.last_batch_size === null ? undefined : Number(document.last_batch_size || 0),
    parser_label: document?.parser_label ? String(document.parser_label) : undefined,
    sort_order: hasSortOrder ? Number(document.sort_order ?? document.sortOrder ?? 0) : undefined,
    created_at: document?.created_at || now(),
    updated_at: document?.updated_at || now(),
  };
}

function normalizeIndex(index) {
  const folders = Array.isArray(index?.folders) ? index.folders.map((folder, index) => ({
    id: String(folder?.id || folder?.folder_id || createId('folder')),
    name: safeName(folder?.name),
    sort_order: Number(folder?.sort_order ?? index),
    created_at: folder?.created_at || now(),
    updated_at: folder?.updated_at || now(),
  })) : [];
  const folderIds = new Set(folders.map((folder) => folder.id));
  const orderByFolder = new Map();
  const documents = Array.isArray(index?.documents) ? index.documents.map((document) => {
    const normalized = normalizeDocument(document);
    if (normalized.sort_order === undefined) {
      const nextOrder = orderByFolder.get(normalized.folder_id) || 0;
      normalized.sort_order = nextOrder;
      orderByFolder.set(normalized.folder_id, nextOrder + 1);
    }
    return normalized;
  }) : [];
  for (const document of documents) {
    if (!folderIds.has(document.folder_id)) {
      folderIds.add(document.folder_id);
      folders.push({
        id: document.folder_id,
        name: '未分类',
        sort_order: folders.length,
        created_at: document.created_at || now(),
        updated_at: document.updated_at || now(),
      });
    }
  }
  return { folders, documents };
}

function createKnowledgeBaseStore({ app, db }) {
  const baseDir = getKnowledgeBaseDir(app);
  const legacyIndexPath = path.join(baseDir, 'index.json');

  function ensureBaseDir() {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  function resolvePath(relativeOrAbsolutePath) {
    const value = String(relativeOrAbsolutePath || '').trim();
    if (!value) return baseDir;
    return path.isAbsolute(value) ? value : path.join(baseDir, value);
  }

  function documentFromRow(row) {
    if (!row) return null;
    return {
      id: row.document_id,
      folder_id: row.folder_id,
      file_name: row.file_name,
      document_dir: row.document_dir,
      source_path: row.source_path,
      markdown_path: row.markdown_path,
      status: normalizeStatus(row.status),
      progress: Number(row.progress || 0),
      message: row.message || '',
      item_count: Number(row.item_count || 0),
      block_count: Number(row.block_count || 0),
      filtered_block_count: Number(row.filtered_block_count || 0),
      candidate_item_count: Number(row.candidate_item_count || 0),
      discarded_block_count: Number(row.discarded_block_count || 0),
      system_discarded_after_retry_count: Number(row.system_discarded_after_retry_count || 0),
      last_batch_size: row.last_batch_size === null || row.last_batch_size === undefined ? undefined : Number(row.last_batch_size || 0),
      parser_label: row.parser_label || undefined,
      sort_order: Number(row.sort_order || 0),
      created_at: row.created_at,
      updated_at: row.updated_at,
      error: row.error || undefined,
    };
  }

  function folderFromRow(row) {
    return {
      id: row.folder_id,
      name: row.name,
      sort_order: Number(row.sort_order || 0),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  function insertOrUpdateFolder(folder) {
    db.prepare(`
      INSERT INTO knowledge_folders (folder_id, name, sort_order, created_at, updated_at)
      VALUES (@folder_id, @name, @sort_order, @created_at, @updated_at)
      ON CONFLICT(folder_id) DO UPDATE SET
        name = excluded.name,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
    `).run({
      folder_id: folder.id,
      name: safeName(folder.name),
      sort_order: Number(folder.sort_order || 0),
      created_at: folder.created_at || now(),
      updated_at: folder.updated_at || now(),
    });
  }

  function insertOrUpdateDocument(document, markdownInfo = {}) {
    const normalized = normalizeDocument(document);
    const markdownPath = resolvePath(normalized.markdown_path);
    const markdownHash = markdownInfo.markdownHash !== undefined ? markdownInfo.markdownHash : hashFileIfExists(markdownPath);
    const markdownChars = markdownInfo.markdownChars !== undefined
      ? Number(markdownInfo.markdownChars || 0)
      : fs.existsSync(markdownPath)
        ? fs.readFileSync(markdownPath, 'utf-8').length
        : 0;
    db.prepare(`
      INSERT INTO knowledge_documents (
        document_id, folder_id, file_name, document_dir, source_path, markdown_path, markdown_hash, markdown_chars,
        source_extension, status, progress, message, error, item_count, block_count, filtered_block_count,
        candidate_item_count, discarded_block_count, system_discarded_after_retry_count, last_batch_size, parser_label, sort_order,
        created_at, updated_at
      ) VALUES (
        @document_id, @folder_id, @file_name, @document_dir, @source_path, @markdown_path, @markdown_hash, @markdown_chars,
        @source_extension, @status, @progress, @message, @error, @item_count, @block_count, @filtered_block_count,
        @candidate_item_count, @discarded_block_count, @system_discarded_after_retry_count, @last_batch_size, @parser_label, @sort_order,
        @created_at, @updated_at
      ) ON CONFLICT(document_id) DO UPDATE SET
        folder_id = excluded.folder_id,
        file_name = excluded.file_name,
        document_dir = excluded.document_dir,
        source_path = excluded.source_path,
        markdown_path = excluded.markdown_path,
        markdown_hash = excluded.markdown_hash,
        markdown_chars = excluded.markdown_chars,
        source_extension = excluded.source_extension,
        status = excluded.status,
        progress = excluded.progress,
        message = excluded.message,
        error = excluded.error,
        item_count = excluded.item_count,
        block_count = excluded.block_count,
        filtered_block_count = excluded.filtered_block_count,
        candidate_item_count = excluded.candidate_item_count,
        discarded_block_count = excluded.discarded_block_count,
        system_discarded_after_retry_count = excluded.system_discarded_after_retry_count,
        last_batch_size = excluded.last_batch_size,
        parser_label = excluded.parser_label,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
    `).run({
      document_id: normalized.id,
      folder_id: normalized.folder_id,
      file_name: normalized.file_name,
      document_dir: normalized.document_dir,
      source_path: normalized.source_path,
      markdown_path: normalized.markdown_path,
      markdown_hash: markdownHash,
      markdown_chars: markdownChars,
      source_extension: normalized.source_extension,
      status: normalized.status,
      progress: normalized.progress,
      message: normalized.message,
      error: normalized.error || null,
      item_count: normalized.item_count,
      block_count: normalized.block_count,
      filtered_block_count: normalized.filtered_block_count,
      candidate_item_count: normalized.candidate_item_count,
      discarded_block_count: normalized.discarded_block_count,
      system_discarded_after_retry_count: normalized.system_discarded_after_retry_count,
      last_batch_size: normalized.last_batch_size === undefined ? null : normalized.last_batch_size,
      parser_label: normalized.parser_label || null,
      sort_order: Number(normalized.sort_order || 0),
      created_at: normalized.created_at,
      updated_at: normalized.updated_at,
    });
    return getDocument(normalized.id);
  }

  function list() {
    ensureBaseDir();
    const folders = db.prepare('SELECT * FROM knowledge_folders ORDER BY sort_order ASC, created_at ASC').all().map(folderFromRow);
    const documents = db.prepare(`
      SELECT d.*
      FROM knowledge_documents d
      LEFT JOIN knowledge_folders f ON f.folder_id = d.folder_id
      ORDER BY COALESCE(f.sort_order, 0) ASC, d.folder_id ASC, d.sort_order ASC, d.created_at DESC, d.document_id ASC
    `).all().map(documentFromRow);
    return { folders, documents };
  }

  function recoverInterruptedDocuments(activeDocumentIds = []) {
    const activeIds = new Set((Array.isArray(activeDocumentIds) ? activeDocumentIds : []).map((id) => String(id || '')).filter(Boolean));
    const legacyRows = db.prepare(`
      SELECT d.document_id
      FROM knowledge_documents d
      WHERE d.status != 'success'
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_document_steps s WHERE s.document_id = d.document_id LIMIT 1
        )
    `).all();
    const interruptedStatuses = ['pending', 'copying', 'converting', 'extracting', 'matching', 'recovering', 'analyzing', 'saving'];
    const placeholders = interruptedStatuses.map(() => '?').join(', ');
    const interruptedRows = db.prepare(`
      SELECT d.document_id
      FROM knowledge_documents d
      WHERE d.status IN (${placeholders})
        AND EXISTS (
          SELECT 1 FROM knowledge_document_steps s WHERE s.document_id = d.document_id LIMIT 1
        )
    `).all(...interruptedStatuses);
    const legacyIds = legacyRows.map((row) => row.document_id).filter((documentId) => !activeIds.has(documentId));
    const interruptedIds = interruptedRows.map((row) => row.document_id).filter((documentId) => !activeIds.has(documentId));
    if (!legacyIds.length && !interruptedIds.length) return [];
    const timestamp = now();
    const updateLegacy = db.prepare(`
      UPDATE knowledge_documents
      SET status = 'error', progress = 0, message = @message, error = @message, updated_at = @updated_at
      WHERE document_id = @document_id
    `);
    const updateInterrupted = db.prepare(`
      UPDATE knowledge_documents
      SET status = 'error', message = @message, error = @message, updated_at = @updated_at
      WHERE document_id = @document_id
    `);
    const legacyMessage = '上次任务未完成，请点击重试重新解析';
    const interruptedMessage = '上次任务中断，请点击重试继续处理';
    legacyIds.forEach((documentId) => updateLegacy.run({ document_id: documentId, message: legacyMessage, updated_at: timestamp }));
    interruptedIds.forEach((documentId) => updateInterrupted.run({ document_id: documentId, message: interruptedMessage, updated_at: timestamp }));
    return [...new Set([...legacyIds, ...interruptedIds])].map((documentId) => getDocument(documentId));
  }

  function getDocument(documentId) {
    const row = db.prepare('SELECT * FROM knowledge_documents WHERE document_id = ?').get(documentId);
    if (!row) throw new Error('知识库文档不存在');
    return documentFromRow(row);
  }

  function createFolder(name) {
    const timestamp = now();
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS value FROM knowledge_folders').get()?.value ?? -1;
    const folder = { id: createId('folder'), name: safeName(name), sort_order: Number(maxOrder) + 1, created_at: timestamp, updated_at: timestamp };
    insertOrUpdateFolder(folder);
    return folderFromRow(db.prepare('SELECT * FROM knowledge_folders WHERE folder_id = ?').get(folder.id));
  }

  function renameFolder(folderId, name) {
    const folder = db.prepare('SELECT * FROM knowledge_folders WHERE folder_id = ?').get(folderId);
    if (!folder) throw new Error('知识库文件夹不存在');
    db.prepare('UPDATE knowledge_folders SET name = ?, updated_at = ? WHERE folder_id = ?').run(safeName(name), now(), folderId);
    return folderFromRow(db.prepare('SELECT * FROM knowledge_folders WHERE folder_id = ?').get(folderId));
  }

  function deleteFolder(folderId) {
    const folder = db.prepare('SELECT * FROM knowledge_folders WHERE folder_id = ?').get(folderId);
    if (!folder) throw new Error('知识库文件夹不存在');
    db.prepare('DELETE FROM knowledge_folders WHERE folder_id = ?').run(folderId);
    return folderFromRow(folder);
  }

  function deleteDocument(documentId) {
    const document = getDocument(documentId);
    db.prepare('DELETE FROM knowledge_documents WHERE document_id = ?').run(documentId);
    return document;
  }

  function getNextDocumentSortOrder(folderId) {
    return Number(db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS value FROM knowledge_documents WHERE folder_id = ?').get(folderId)?.value ?? -1) + 1;
  }

  function reorderIds(ids, draggedId, targetId, position) {
    const draggedIndex = ids.indexOf(draggedId);
    const targetIndex = ids.indexOf(targetId);
    if (draggedIndex < 0 || targetIndex < 0 || draggedId === targetId) return ids;
    const next = [...ids];
    const [dragged] = next.splice(draggedIndex, 1);
    const adjustedTargetIndex = next.indexOf(targetId);
    next.splice(position === 'before' ? adjustedTargetIndex : adjustedTargetIndex + 1, 0, dragged);
    return next;
  }

  function resequenceFolderIds(folderIds) {
    const timestamp = now();
    const update = db.prepare('UPDATE knowledge_folders SET sort_order = ?, updated_at = ? WHERE folder_id = ?');
    folderIds.forEach((folderId, index) => update.run(index, timestamp, folderId));
  }

  function resequenceDocumentIds(folderId, documentIds, timestamp = now()) {
    const update = db.prepare('UPDATE knowledge_documents SET sort_order = ?, updated_at = ? WHERE document_id = ? AND folder_id = ?');
    documentIds.forEach((documentId, index) => update.run(index, timestamp, documentId, folderId));
  }

  function getOrderedDocumentIds(folderId, excludedDocumentId) {
    const rows = db.prepare(`
      SELECT document_id
      FROM knowledge_documents
      WHERE folder_id = ? AND document_id != ?
      ORDER BY sort_order ASC, created_at DESC, document_id ASC
    `).all(folderId, excludedDocumentId || '');
    return rows.map((row) => row.document_id);
  }

  function createDocument(document) {
    const withOrder = hasOwn(document, 'sort_order') || hasOwn(document, 'sortOrder')
      ? document
      : { ...document, sort_order: getNextDocumentSortOrder(document?.folder_id || document?.folderId || 'unknown') };
    return insertOrUpdateDocument(withOrder);
  }

  function reorderFolders(draggedFolderId, targetFolderId, position) {
    const normalizedPosition = normalizeDropPosition(position);
    const folderIds = db.prepare('SELECT folder_id FROM knowledge_folders ORDER BY sort_order ASC, created_at ASC').all().map((row) => row.folder_id);
    if (!folderIds.includes(draggedFolderId) || !folderIds.includes(targetFolderId)) {
      throw new Error('知识库文件夹不存在');
    }
    if (draggedFolderId === targetFolderId) return list();
    db.transaction(() => resequenceFolderIds(reorderIds(folderIds, draggedFolderId, targetFolderId, normalizedPosition)))();
    return list();
  }

  function moveDocument(documentId, targetFolderId, options = {}) {
    const document = getDocument(documentId);
    const folder = db.prepare('SELECT * FROM knowledge_folders WHERE folder_id = ?').get(targetFolderId);
    if (!folder) throw new Error('目标知识库文件夹不存在');

    const targetDocumentId = options.targetDocumentId ? String(options.targetDocumentId) : '';
    const normalizedPosition = normalizeDropPosition(options.position);
    const targetDocument = targetDocumentId ? getDocument(targetDocumentId) : null;
    if (targetDocument && targetDocument.folder_id !== targetFolderId) {
      throw new Error('目标文档不在目标文件夹中');
    }

    const timestamp = now();
    const targetIds = getOrderedDocumentIds(targetFolderId, documentId);
    const insertIndex = targetDocumentId
      ? Math.max(0, targetIds.indexOf(targetDocumentId)) + (normalizedPosition === 'after' ? 1 : 0)
      : targetIds.length;
    if (targetDocumentId && !targetIds.includes(targetDocumentId)) {
      throw new Error('目标文档不存在');
    }
    const nextTargetIds = [...targetIds];
    nextTargetIds.splice(insertIndex, 0, documentId);

    const updateDocumentLocation = db.prepare(`
      UPDATE knowledge_documents
      SET folder_id = @folder_id,
        document_dir = COALESCE(@document_dir, document_dir),
        source_path = COALESCE(@source_path, source_path),
        markdown_path = COALESCE(@markdown_path, markdown_path),
        sort_order = @sort_order,
        updated_at = @updated_at
      WHERE document_id = @document_id
    `);
    const transaction = db.transaction(() => {
      if (document.folder_id !== targetFolderId) {
        resequenceDocumentIds(document.folder_id, getOrderedDocumentIds(document.folder_id, documentId), timestamp);
      }
      updateDocumentLocation.run({
        document_id: documentId,
        folder_id: targetFolderId,
        document_dir: options.documentDir || null,
        source_path: options.sourcePath || null,
        markdown_path: options.markdownPath || null,
        sort_order: insertIndex,
        updated_at: timestamp,
      });
      resequenceDocumentIds(targetFolderId, nextTargetIds, timestamp);
    });
    transaction();
    return { index: list(), document: getDocument(documentId) };
  }

  function updateDocument(documentId, partial = {}) {
    getDocument(documentId);
    const columnByField = {
      file_name: 'file_name',
      status: 'status',
      progress: 'progress',
      message: 'message',
      error: 'error',
      item_count: 'item_count',
      block_count: 'block_count',
      filtered_block_count: 'filtered_block_count',
      candidate_item_count: 'candidate_item_count',
      discarded_block_count: 'discarded_block_count',
      system_discarded_after_retry_count: 'system_discarded_after_retry_count',
      last_batch_size: 'last_batch_size',
      parser_label: 'parser_label',
    };
    const values = { document_id: documentId, updated_at: now() };
    const assignments = [];
    for (const [field, column] of Object.entries(columnByField)) {
      if (!Object.prototype.hasOwnProperty.call(partial, field)) continue;
      let value = partial[field];
      if (field === 'status') value = normalizeStatus(value);
      if (field === 'progress') value = Math.max(0, Math.min(100, Math.round(Number(value || 0))));
      if (['item_count', 'block_count', 'filtered_block_count', 'candidate_item_count', 'discarded_block_count', 'system_discarded_after_retry_count', 'last_batch_size'].includes(field)) {
        value = value === undefined || value === null ? null : Number(value || 0);
      }
      if (field === 'message') value = String(value || '');
      if (field === 'error' || field === 'parser_label') value = value ? String(value) : null;
      values[column] = value;
      assignments.push(`${column} = @${column}`);
    }
    if (!assignments.length) return getDocument(documentId);
    db.prepare(`UPDATE knowledge_documents SET ${assignments.join(', ')}, updated_at = @updated_at WHERE document_id = @document_id`).run(values);
    return getDocument(documentId);
  }

  function updateMarkdownMetadata(documentId, markdown, parserLabel) {
    const content = String(markdown || '');
    db.prepare(`
      UPDATE knowledge_documents
      SET markdown_hash = @markdown_hash, markdown_chars = @markdown_chars, parser_label = COALESCE(@parser_label, parser_label), updated_at = @updated_at
      WHERE document_id = @document_id
    `).run({
      document_id: documentId,
      markdown_hash: stableHash(content),
      markdown_chars: content.length,
      parser_label: parserLabel ? String(parserLabel) : null,
      updated_at: now(),
    });
    return getDocument(documentId);
  }

  function replaceBlocks(documentId, blocks, filteredBlocks) {
    db.prepare('DELETE FROM knowledge_blocks WHERE document_id = ?').run(documentId);
    const insert = db.prepare(`
      INSERT INTO knowledge_blocks (
        document_id, block_id, type, heading_path_json, content, content_chars, is_filtered, filter_reason, sort_order
      ) VALUES (
        @document_id, @block_id, @type, @heading_path_json, @content, @content_chars, @is_filtered, @filter_reason, @sort_order
      )
    `);
    (Array.isArray(blocks) ? blocks : []).forEach((block, index) => {
      const content = String(block?.content || '');
      insert.run({
        document_id: documentId,
        block_id: String(block?.id || `P${String(index + 1).padStart(6, '0')}`),
        type: String(block?.type || 'paragraph'),
        heading_path_json: jsonOrNull(Array.isArray(block?.heading_path) ? block.heading_path : []),
        content,
        content_chars: getContentCharCount(content),
        is_filtered: 0,
        filter_reason: null,
        sort_order: index,
      });
    });
    (Array.isArray(filteredBlocks) ? filteredBlocks : []).forEach((block, index) => {
      const content = String(block?.content || '');
      insert.run({
        document_id: documentId,
        block_id: String(block?.id || `F${String(index + 1).padStart(6, '0')}`),
        type: String(block?.type || 'paragraph'),
        heading_path_json: jsonOrNull(Array.isArray(block?.heading_path) ? block.heading_path : []),
        content,
        content_chars: getContentCharCount(content),
        is_filtered: 1,
        filter_reason: block?.reason ? String(block.reason) : null,
        sort_order: index,
      });
    });
    updateDocument(documentId, { block_count: Array.isArray(blocks) ? blocks.length : 0, filtered_block_count: Array.isArray(filteredBlocks) ? filteredBlocks.length : 0 });
  }

  const saveBlocksTransaction = db.transaction(replaceBlocks);

  function blockFromRow(row) {
    const block = {
      id: row.block_id,
      type: row.type,
      heading_path: safeJsonParse(row.heading_path_json, []),
      content: row.content || '',
    };
    if (row.is_filtered) block.reason = row.filter_reason || '';
    return block;
  }

  function readBlocks(documentId) {
    getDocument(documentId);
    return db.prepare('SELECT * FROM knowledge_blocks WHERE document_id = ? AND is_filtered = 0 ORDER BY sort_order ASC, id ASC').all(documentId).map(blockFromRow);
  }

  function readFilteredBlocks(documentId) {
    getDocument(documentId);
    return db.prepare('SELECT * FROM knowledge_blocks WHERE document_id = ? AND is_filtered = 1 ORDER BY sort_order ASC, id ASC').all(documentId).map(blockFromRow);
  }

  function replaceCandidateItems(documentId, items, source = null) {
    db.prepare('DELETE FROM knowledge_candidate_items WHERE document_id = ?').run(documentId);
    const timestamp = now();
    const insert = db.prepare(`
      INSERT INTO knowledge_candidate_items (document_id, item_id, title, summary, source, sort_order, created_at, updated_at)
      VALUES (@document_id, @item_id, @title, @summary, @source, @sort_order, @created_at, @updated_at)
    `);
    (Array.isArray(items) ? items : []).forEach((item, index) => {
      if (!item?.id && !item?.item_id) return;
      insert.run({
        document_id: documentId,
        item_id: String(item.id || item.item_id),
        title: String(item.title || ''),
        summary: String(item.summary || item.resume || ''),
        source: item.source ? String(item.source) : source,
        sort_order: index,
        created_at: timestamp,
        updated_at: timestamp,
      });
    });
    updateDocument(documentId, { candidate_item_count: Array.isArray(items) ? items.length : 0 });
  }

  const saveCandidateItemsTransaction = db.transaction(replaceCandidateItems);

  function readCandidateItems(documentId) {
    getDocument(documentId);
    return db.prepare('SELECT * FROM knowledge_candidate_items WHERE document_id = ? ORDER BY sort_order ASC, id ASC').all(documentId).map((row) => ({
      id: row.item_id,
      title: row.title,
      summary: row.summary,
    }));
  }

  function replaceFinalItems(documentId, finalItems) {
    db.prepare('DELETE FROM knowledge_item_blocks WHERE document_id = ?').run(documentId);
    db.prepare('DELETE FROM knowledge_items WHERE document_id = ?').run(documentId);
    const timestamp = now();
    const itemInsert = db.prepare(`
      INSERT INTO knowledge_items (document_id, item_id, title, resume, content, source_file, content_chars, sort_order, created_at, updated_at)
      VALUES (@document_id, @item_id, @title, @resume, @content, @source_file, @content_chars, @sort_order, @created_at, @updated_at)
    `);
    const blockInsert = db.prepare(`
      INSERT OR IGNORE INTO knowledge_item_blocks (document_id, item_id, block_id, sort_order)
      VALUES (@document_id, @item_id, @block_id, @sort_order)
    `);
    (Array.isArray(finalItems) ? finalItems : []).forEach((item, index) => {
      if (!item?.id) return;
      const content = String(item.content || '');
      itemInsert.run({
        document_id: documentId,
        item_id: String(item.id),
        title: String(item.title || ''),
        resume: String(item.resume || item.summary || ''),
        content,
        source_file: item.source_file ? String(item.source_file) : null,
        content_chars: getContentCharCount(content),
        sort_order: index,
        created_at: timestamp,
        updated_at: timestamp,
      });
      (Array.isArray(item.source_block_ids) ? item.source_block_ids : []).forEach((blockId, blockIndex) => {
        blockInsert.run({ document_id: documentId, item_id: String(item.id), block_id: String(blockId), sort_order: blockIndex });
      });
    });
    updateDocument(documentId, { item_count: Array.isArray(finalItems) ? finalItems.length : 0 });
  }

  function replaceDiscardedGroups(documentId, matchResult) {
    db.prepare('DELETE FROM knowledge_discarded_groups WHERE document_id = ?').run(documentId);
    const insert = db.prepare(`
      INSERT INTO knowledge_discarded_groups (document_id, source, reason, block_ids_json, sort_order)
      VALUES (@document_id, @source, @reason, @block_ids_json, @sort_order)
    `);
    let order = 0;
    for (const item of Array.isArray(matchResult?.discarded) ? matchResult.discarded : []) {
      insert.run({
        document_id: documentId,
        source: 'ai',
        reason: String(item?.reason || 'AI 建议舍弃'),
        block_ids_json: JSON.stringify(Array.isArray(item?.block_ids) ? item.block_ids : []),
        sort_order: order,
      });
      order += 1;
    }
    for (const item of Array.isArray(matchResult?.system_discarded_after_retry) ? matchResult.system_discarded_after_retry : []) {
      insert.run({
        document_id: documentId,
        source: 'system',
        reason: String(item?.reason || 'system_discarded_after_retry'),
        block_ids_json: JSON.stringify(Array.isArray(item?.block_ids) ? item.block_ids : []),
        sort_order: order,
      });
      order += 1;
    }
  }

  function saveReport(documentId, report) {
    if (!report) {
      db.prepare('DELETE FROM knowledge_reports WHERE document_id = ?').run(documentId);
      return;
    }
    db.prepare(`
      INSERT INTO knowledge_reports (
        document_id, total_blocks, filtered_blocks_count, candidate_items_count, final_items_count,
        matched_blocks_count, discarded_blocks_count, system_discarded_after_retry_count,
        new_items_from_recovery_count, recovery_attempt_count, batch_size, coverage_rate, matched_rate, created_at
      ) VALUES (
        @document_id, @total_blocks, @filtered_blocks_count, @candidate_items_count, @final_items_count,
        @matched_blocks_count, @discarded_blocks_count, @system_discarded_after_retry_count,
        @new_items_from_recovery_count, @recovery_attempt_count, @batch_size, @coverage_rate, @matched_rate, @created_at
      ) ON CONFLICT(document_id) DO UPDATE SET
        total_blocks = excluded.total_blocks,
        filtered_blocks_count = excluded.filtered_blocks_count,
        candidate_items_count = excluded.candidate_items_count,
        final_items_count = excluded.final_items_count,
        matched_blocks_count = excluded.matched_blocks_count,
        discarded_blocks_count = excluded.discarded_blocks_count,
        system_discarded_after_retry_count = excluded.system_discarded_after_retry_count,
        new_items_from_recovery_count = excluded.new_items_from_recovery_count,
        recovery_attempt_count = excluded.recovery_attempt_count,
        batch_size = excluded.batch_size,
        coverage_rate = excluded.coverage_rate,
        matched_rate = excluded.matched_rate,
        created_at = excluded.created_at
    `).run({
      document_id: documentId,
      total_blocks: Number(report.total_blocks || 0),
      filtered_blocks_count: Number(report.filtered_blocks_count || 0),
      candidate_items_count: Number(report.candidate_items_count || 0),
      final_items_count: Number(report.final_items_count || 0),
      matched_blocks_count: Number(report.matched_blocks_count || 0),
      discarded_blocks_count: Number(report.discarded_blocks_count || 0),
      system_discarded_after_retry_count: Number(report.system_discarded_after_retry_count || 0),
      new_items_from_recovery_count: Number(report.new_items_from_recovery_count || 0),
      recovery_attempt_count: Number(report.recovery_attempt_count || 0),
      batch_size: Number(report.batch_size || 20),
      coverage_rate: Number(report.coverage_rate || 0),
      matched_rate: Number(report.matched_rate || 0),
      created_at: report.created_at || now(),
    });
  }

  function saveMatchResult(documentId, { candidateItems, finalItems, matchResult, report } = {}) {
    const transaction = db.transaction(() => {
      replaceCandidateItems(documentId, Array.isArray(candidateItems) ? candidateItems : [], 'merged');
      replaceFinalItems(documentId, Array.isArray(finalItems) ? finalItems : []);
      replaceDiscardedGroups(documentId, matchResult || {});
      saveReport(documentId, report || matchResult?.report || null);
      updateDocument(documentId, {
        item_count: Array.isArray(finalItems) ? finalItems.length : 0,
        candidate_item_count: Array.isArray(candidateItems) ? candidateItems.length : 0,
        discarded_block_count: Number((report || matchResult?.report)?.discarded_blocks_count || 0),
        system_discarded_after_retry_count: Number((report || matchResult?.report)?.system_discarded_after_retry_count || 0),
      });
    });
    transaction();
  }

  function stepFromRow(row) {
    if (!row) return null;
    return {
      document_id: row.document_id,
      step_key: row.step_key,
      status: normalizeStepStatus(row.status),
      result: safeJsonParse(row.result_json, null),
      error: row.error || undefined,
      started_at: row.started_at || undefined,
      completed_at: row.completed_at || undefined,
      updated_at: row.updated_at,
    };
  }

  function assertDocumentStepKey(stepKey) {
    if (!documentStepKeys.includes(stepKey)) {
      throw new Error(`未知知识库处理步骤：${stepKey}`);
    }
  }

  function getDocumentStep(documentId, stepKey) {
    getDocument(documentId);
    assertDocumentStepKey(stepKey);
    return stepFromRow(db.prepare('SELECT * FROM knowledge_document_steps WHERE document_id = ? AND step_key = ?').get(documentId, stepKey));
  }

  function saveDocumentStep(documentId, stepKey, fields = {}) {
    getDocument(documentId);
    assertDocumentStepKey(stepKey);
    const timestamp = now();
    const current = db.prepare('SELECT * FROM knowledge_document_steps WHERE document_id = ? AND step_key = ?').get(documentId, stepKey);
    const status = normalizeStepStatus(fields.status || current?.status || 'idle');
    let startedAt = current?.started_at || null;
    let completedAt = current?.completed_at || null;
    let error = hasOwn(fields, 'error') ? fields.error ? String(fields.error) : null : current?.error || null;

    if (status === 'running') {
      startedAt = timestamp;
      completedAt = null;
      error = null;
    } else if (status === 'success') {
      startedAt = startedAt || timestamp;
      completedAt = timestamp;
      error = null;
    } else if (status === 'error') {
      startedAt = startedAt || timestamp;
      completedAt = timestamp;
      error = error || '处理失败';
    } else {
      startedAt = null;
      completedAt = null;
      error = null;
    }

    const resultJson = hasOwn(fields, 'result') ? jsonOrNull(fields.result) : current?.result_json || null;
    db.prepare(`
      INSERT INTO knowledge_document_steps (document_id, step_key, status, result_json, error, started_at, completed_at, updated_at)
      VALUES (@document_id, @step_key, @status, @result_json, @error, @started_at, @completed_at, @updated_at)
      ON CONFLICT(document_id, step_key) DO UPDATE SET
        status = excluded.status,
        result_json = excluded.result_json,
        error = excluded.error,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `).run({
      document_id: documentId,
      step_key: stepKey,
      status,
      result_json: resultJson,
      error,
      started_at: startedAt,
      completed_at: completedAt,
      updated_at: timestamp,
    });
    return getDocumentStep(documentId, stepKey);
  }

  function batchFromRow(row) {
    if (!row) return null;
    return {
      document_id: row.document_id,
      batch_index: Number(row.batch_index || 0),
      status: normalizeStepStatus(row.status),
      item_ids: safeJsonParse(row.item_ids_json, []),
      matches: safeJsonParse(row.matches_json, []),
      error: row.error || undefined,
      started_at: row.started_at || undefined,
      completed_at: row.completed_at || undefined,
      updated_at: row.updated_at,
    };
  }

  function getMatchBatch(documentId, batchIndex) {
    getDocument(documentId);
    return batchFromRow(db.prepare('SELECT * FROM knowledge_match_batches WHERE document_id = ? AND batch_index = ?').get(documentId, Number(batchIndex || 0)));
  }

  function readMatchBatches(documentId) {
    getDocument(documentId);
    return db.prepare('SELECT * FROM knowledge_match_batches WHERE document_id = ? ORDER BY batch_index ASC').all(documentId).map(batchFromRow);
  }

  function saveMatchBatch(documentId, batchIndex, fields = {}) {
    getDocument(documentId);
    const index = Number(batchIndex || 0);
    const timestamp = now();
    const current = db.prepare('SELECT * FROM knowledge_match_batches WHERE document_id = ? AND batch_index = ?').get(documentId, index);
    const status = normalizeStepStatus(fields.status || current?.status || 'idle');
    let startedAt = current?.started_at || null;
    let completedAt = current?.completed_at || null;
    let error = hasOwn(fields, 'error') ? fields.error ? String(fields.error) : null : current?.error || null;

    if (status === 'running') {
      startedAt = timestamp;
      completedAt = null;
      error = null;
    } else if (status === 'success') {
      startedAt = startedAt || timestamp;
      completedAt = timestamp;
      error = null;
    } else if (status === 'error') {
      startedAt = startedAt || timestamp;
      completedAt = timestamp;
      error = error || '处理失败';
    } else {
      startedAt = null;
      completedAt = null;
      error = null;
    }

    const itemIdsJson = hasOwn(fields, 'itemIds') ? jsonOrNull(fields.itemIds) || '[]' : current?.item_ids_json || '[]';
    const matchesJson = hasOwn(fields, 'matches') ? jsonOrNull(fields.matches) : current?.matches_json || null;
    db.prepare(`
      INSERT INTO knowledge_match_batches (document_id, batch_index, status, item_ids_json, matches_json, error, started_at, completed_at, updated_at)
      VALUES (@document_id, @batch_index, @status, @item_ids_json, @matches_json, @error, @started_at, @completed_at, @updated_at)
      ON CONFLICT(document_id, batch_index) DO UPDATE SET
        status = excluded.status,
        item_ids_json = excluded.item_ids_json,
        matches_json = excluded.matches_json,
        error = excluded.error,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `).run({
      document_id: documentId,
      batch_index: index,
      status,
      item_ids_json: itemIdsJson,
      matches_json: matchesJson,
      error,
      started_at: startedAt,
      completed_at: completedAt,
      updated_at: timestamp,
    });
    return getMatchBatch(documentId, index);
  }

  function deleteDocumentStepsFrom(documentId, stepKey) {
    assertDocumentStepKey(stepKey);
    const startIndex = documentStepKeys.indexOf(stepKey);
    const keys = documentStepKeys.slice(startIndex);
    if (!keys.length) return;
    const placeholders = keys.map(() => '?').join(', ');
    db.prepare(`DELETE FROM knowledge_document_steps WHERE document_id = ? AND step_key IN (${placeholders})`).run(documentId, ...keys);
  }

  function clearFinalArtifacts(documentId) {
    db.prepare('DELETE FROM knowledge_item_blocks WHERE document_id = ?').run(documentId);
    db.prepare('DELETE FROM knowledge_items WHERE document_id = ?').run(documentId);
    db.prepare('DELETE FROM knowledge_discarded_groups WHERE document_id = ?').run(documentId);
    db.prepare('DELETE FROM knowledge_reports WHERE document_id = ?').run(documentId);
  }

  function clearMatchBatches(documentId) {
    getDocument(documentId);
    db.prepare('DELETE FROM knowledge_match_batches WHERE document_id = ?').run(documentId);
  }

  function clearDocumentProcessingFromStep(documentId, stepKey) {
    getDocument(documentId);
    assertDocumentStepKey(stepKey);
    const startIndex = documentStepKeys.indexOf(stepKey);
    const transaction = db.transaction(() => {
      deleteDocumentStepsFrom(documentId, stepKey);
      if (startIndex <= documentStepKeys.indexOf('convert_markdown')) {
        db.prepare(`
          UPDATE knowledge_documents
          SET markdown_hash = NULL, markdown_chars = 0, parser_label = NULL, updated_at = ?
          WHERE document_id = ?
        `).run(now(), documentId);
      }
      if (startIndex <= documentStepKeys.indexOf('build_blocks')) {
        db.prepare('DELETE FROM knowledge_blocks WHERE document_id = ?').run(documentId);
      }
      if (startIndex <= documentStepKeys.indexOf('merge_candidates')) {
        db.prepare('DELETE FROM knowledge_candidate_items WHERE document_id = ?').run(documentId);
      }
      if (startIndex <= documentStepKeys.indexOf('match_batches')) {
        db.prepare('DELETE FROM knowledge_match_batches WHERE document_id = ?').run(documentId);
      }
      if (startIndex <= documentStepKeys.indexOf('save_result')) {
        clearFinalArtifacts(documentId);
      }

      const resetFields = {
        error: null,
        last_batch_size: null,
      };
      if (startIndex <= documentStepKeys.indexOf('build_blocks')) {
        Object.assign(resetFields, { block_count: 0, filtered_block_count: 0 });
      }
      if (startIndex <= documentStepKeys.indexOf('merge_candidates')) {
        Object.assign(resetFields, { candidate_item_count: 0 });
      }
      if (startIndex <= documentStepKeys.indexOf('save_result')) {
        Object.assign(resetFields, { item_count: 0, discarded_block_count: 0, system_discarded_after_retry_count: 0 });
      }
      updateDocument(documentId, resetFields);
    });
    transaction();
    return getDocument(documentId);
  }

  function readItems(documentId) {
    getDocument(documentId);
    const blockRows = db.prepare('SELECT * FROM knowledge_item_blocks WHERE document_id = ? ORDER BY item_id ASC, sort_order ASC').all(documentId);
    const blocksByItem = new Map();
    for (const row of blockRows) {
      const list = blocksByItem.get(row.item_id) || [];
      list.push(row.block_id);
      blocksByItem.set(row.item_id, list);
    }
    return db.prepare('SELECT * FROM knowledge_items WHERE document_id = ? ORDER BY sort_order ASC, id ASC').all(documentId).map((row) => ({
      id: row.item_id,
      title: row.title,
      resume: row.resume,
      content: row.content,
      source_block_ids: blocksByItem.get(row.item_id) || [],
      source_file: row.source_file || undefined,
    }));
  }

  function readMarkdown(documentId) {
    const document = getDocument(documentId);
    const markdownPath = resolvePath(document.markdown_path);
    return fs.existsSync(markdownPath) ? fs.readFileSync(markdownPath, 'utf-8') : '';
  }

  function reportFromRow(row) {
    if (!row) return null;
    return {
      total_blocks: Number(row.total_blocks || 0),
      filtered_blocks_count: Number(row.filtered_blocks_count || 0),
      candidate_items_count: Number(row.candidate_items_count || 0),
      final_items_count: Number(row.final_items_count || 0),
      matched_blocks_count: Number(row.matched_blocks_count || 0),
      discarded_blocks_count: Number(row.discarded_blocks_count || 0),
      system_discarded_after_retry_count: Number(row.system_discarded_after_retry_count || 0),
      new_items_from_recovery_count: Number(row.new_items_from_recovery_count || 0),
      recovery_attempt_count: Number(row.recovery_attempt_count || 0),
      batch_size: Number(row.batch_size || 20),
      coverage_rate: Number(row.coverage_rate || 0),
      matched_rate: Number(row.matched_rate || 0),
      created_at: row.created_at,
    };
  }

  function readAnalysis(documentId, options = {}) {
    const document = getDocument(documentId);
    const markdown = readMarkdown(documentId);
    const blocks = readBlocks(documentId);
    const filteredBlocks = readFilteredBlocks(documentId);
    const candidateItems = readCandidateItems(documentId);
    const items = readItems(documentId);
    const blockRows = db.prepare('SELECT block_id, content_chars FROM knowledge_blocks WHERE document_id = ? AND is_filtered = 0').all(documentId);
    const charsByBlock = new Map(blockRows.map((row) => [row.block_id, Number(row.content_chars || 0)]));
    const covered = new Set();
    items.forEach((item) => (item.source_block_ids || []).forEach((id) => covered.add(id)));
    const coveredUniqueContentChars = Array.from(covered).reduce((sum, id) => sum + Number(charsByBlock.get(id) || 0), 0);
    const report = reportFromRow(db.prepare('SELECT * FROM knowledge_reports WHERE document_id = ?').get(documentId));
    const discardedRows = db.prepare('SELECT * FROM knowledge_discarded_groups WHERE document_id = ? ORDER BY sort_order ASC').all(documentId);
    const toDiscarded = (row) => ({ block_ids: safeJsonParse(row.block_ids_json, []), reason: row.reason, source: row.source === 'ai' ? undefined : row.source });
    const markdownChars = getContentCharCount(markdown);
    return {
      document,
      block_count: blocks.length,
      filtered_blocks_count: filteredBlocks.length,
      markdown_chars: markdownChars,
      kept_block_chars: blockRows.reduce((sum, row) => sum + Number(row.content_chars || 0), 0),
      covered_unique_content_chars: coveredUniqueContentChars,
      coverage_rate_vs_markdown: markdownChars ? Number((coveredUniqueContentChars / markdownChars).toFixed(4)) : 0,
      candidate_items: candidateItems,
      report,
      discarded: discardedRows.filter((row) => row.source === 'ai').map(toDiscarded),
      system_discarded_after_retry: discardedRows.filter((row) => row.source === 'system').map(toDiscarded),
      debug_log_path: options.debugLogPath || '',
    };
  }

  function getOutlineReferences(documentIds) {
    const ids = Array.isArray(documentIds) ? documentIds.map((id) => String(id || '').trim()).filter(Boolean) : [];
    if (!ids.length) return { items: [] };
    const seen = new Set();
    const items = [];
    for (const documentId of ids) {
      const document = db.prepare('SELECT document_id, status FROM knowledge_documents WHERE document_id = ?').get(documentId);
      if (!document || document.status !== 'success') continue;
      for (const item of readItems(documentId)) {
        const itemId = String(item?.id || '').trim();
        const title = String(item?.title || '').trim();
        const resume = String(item?.resume || item?.summary || '').trim();
        if (!itemId || !title || !resume) continue;
        const referenceId = `${documentId}::${itemId}`;
        if (seen.has(referenceId)) continue;
        seen.add(referenceId);
        items.push({ id: referenceId, title, resume });
      }
    }
    return { items };
  }

  function getMigrationMeta() {
    return db.prepare('SELECT * FROM knowledge_migration_meta WHERE id = 1').get();
  }

  function updateMigrationMeta(fields) {
    const current = getMigrationMeta();
    const timestamp = now();
    if (!current) {
      db.prepare(`
        INSERT INTO knowledge_migration_meta (
          id, legacy_index_hash, status, migrated_folder_count, migrated_document_count, started_at, completed_at, cleanup_completed_at, error
        ) VALUES (
          1, @legacy_index_hash, @status, @migrated_folder_count, @migrated_document_count, @started_at, @completed_at, @cleanup_completed_at, @error
        )
      `).run({
        legacy_index_hash: fields.legacy_index_hash || null,
        status: fields.status || 'idle',
        migrated_folder_count: Number(fields.migrated_folder_count || 0),
        migrated_document_count: Number(fields.migrated_document_count || 0),
        started_at: fields.started_at || timestamp,
        completed_at: fields.completed_at || null,
        cleanup_completed_at: fields.cleanup_completed_at || null,
        error: fields.error || null,
      });
      return;
    }
    const entries = Object.entries(fields || {}).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE knowledge_migration_meta SET ${assignments} WHERE id = 1`).run(Object.fromEntries(entries));
  }

  function readLegacyIndex() {
    if (!fs.existsSync(legacyIndexPath)) return createEmptyIndex();
    return normalizeIndex(readJson(legacyIndexPath, createEmptyIndex()));
  }

  function cleanupLegacyJson(index) {
    const normalized = normalizeIndex(index || readLegacyIndex());
    for (const document of normalized.documents) {
      const documentDir = resolvePath(document.document_dir);
      for (const fileName of legacyResultJsonFiles) {
        fs.rmSync(path.join(documentDir, fileName), { force: true });
      }
    }
    fs.rmSync(legacyIndexPath, { force: true });
    updateMigrationMeta({ cleanup_completed_at: now(), error: null });
  }

  function countRows(sql, ...params) {
    return Number(db.prepare(sql).get(...params)?.value || 0);
  }

  function assertMigratedCount(label, actual, expected) {
    if (actual !== expected) {
      throw new Error(`迁移校验失败，${label} 数量不一致：期望 ${expected}，实际 ${actual}`);
    }
  }

  function countExpectedItemBlocks(items) {
    const pairs = new Set();
    (Array.isArray(items) ? items : []).forEach((item) => {
      if (!item?.id) return;
      (Array.isArray(item.source_block_ids) ? item.source_block_ids : []).forEach((blockId) => {
        pairs.add(`${item.id}\u0000${String(blockId)}`);
      });
    });
    return pairs.size;
  }

  function getSuccessfulLegacyDocuments(legacy) {
    return (Array.isArray(legacy?.documents) ? legacy.documents : []).filter((document) => document.status === 'success');
  }

  function getLegacyMigrationCounts(legacy) {
    const total = Array.isArray(legacy?.documents) ? legacy.documents.length : 0;
    const success = getSuccessfulLegacyDocuments(legacy).length;
    return { total, success, skipped: Math.max(0, total - success) };
  }

  function validateMigratedLegacy(legacy, expectedByDocumentId) {
    for (const folder of legacy.folders) {
      const exists = db.prepare('SELECT 1 FROM knowledge_folders WHERE folder_id = ?').get(folder.id);
      if (!exists) {
        throw new Error(`迁移校验失败，未找到文件夹：${folder.name || folder.id}`);
      }
    }

    for (const document of legacy.documents) {
      const exists = db.prepare('SELECT 1 FROM knowledge_documents WHERE document_id = ?').get(document.id);
      if (!exists) {
        throw new Error(`迁移校验失败，未找到文档：${document.file_name || document.id}`);
      }
      const expected = expectedByDocumentId.get(document.id) || {};
      const label = document.file_name || document.id;
      assertMigratedCount(`${label} 有效 block`, countRows('SELECT COUNT(*) AS value FROM knowledge_blocks WHERE document_id = ? AND is_filtered = 0', document.id), expected.blockCount || 0);
      assertMigratedCount(`${label} 筛除 block`, countRows('SELECT COUNT(*) AS value FROM knowledge_blocks WHERE document_id = ? AND is_filtered = 1', document.id), expected.filteredBlockCount || 0);
      assertMigratedCount(`${label} 候选条目`, countRows('SELECT COUNT(*) AS value FROM knowledge_candidate_items WHERE document_id = ?', document.id), expected.candidateItemCount || 0);
      assertMigratedCount(`${label} 最终条目`, countRows('SELECT COUNT(*) AS value FROM knowledge_items WHERE document_id = ?', document.id), expected.finalItemCount || 0);
      assertMigratedCount(`${label} 条目来源关系`, countRows('SELECT COUNT(*) AS value FROM knowledge_item_blocks WHERE document_id = ?', document.id), expected.itemBlockCount || 0);
      assertMigratedCount(`${label} 舍弃记录`, countRows('SELECT COUNT(*) AS value FROM knowledge_discarded_groups WHERE document_id = ?', document.id), expected.discardedGroupCount || 0);
      assertMigratedCount(`${label} 报告`, countRows('SELECT COUNT(*) AS value FROM knowledge_reports WHERE document_id = ?', document.id), expected.reportCount || 0);
    }
  }

  function getMigrationStatus() {
    ensureBaseDir();
    const meta = getMigrationMeta();
    const legacyExists = fs.existsSync(legacyIndexPath);
    if (!legacyExists) {
      if (meta?.status === 'success' && !meta.cleanup_completed_at) {
        updateMigrationMeta({ cleanup_completed_at: now() });
      }
      return {
        needsMigration: false,
        legacyFolderCount: 0,
        legacyDocumentCount: 0,
        legacyCompletedDocumentCount: 0,
        legacySkippedDocumentCount: 0,
        migrationCompleted: meta?.status === 'success',
        cleanupPending: false,
      };
    }

    let legacy = createEmptyIndex();
    try {
      legacy = readLegacyIndex();
    } catch (error) {
      return {
        needsMigration: true,
        legacyFolderCount: 0,
        legacyDocumentCount: 0,
        legacyCompletedDocumentCount: 0,
        legacySkippedDocumentCount: 0,
        migrationCompleted: false,
        cleanupPending: false,
        message: `读取旧知识库索引失败：${error.message || String(error)}`,
      };
    }

    const counts = getLegacyMigrationCounts(legacy);
    if (meta?.status === 'success') {
      try {
        cleanupLegacyJson(legacy);
        return {
          needsMigration: false,
          legacyFolderCount: 0,
          legacyDocumentCount: 0,
          legacyCompletedDocumentCount: 0,
          legacySkippedDocumentCount: 0,
          migrationCompleted: true,
          cleanupPending: false,
        };
      } catch (error) {
        updateMigrationMeta({ error: error.message || String(error) });
        return {
          needsMigration: false,
          legacyFolderCount: legacy.folders.length,
          legacyDocumentCount: legacy.documents.length,
          legacyCompletedDocumentCount: counts.success,
          legacySkippedDocumentCount: counts.skipped,
          migrationCompleted: true,
          cleanupPending: true,
          message: `旧知识库 JSON 清理未完成：${error.message || String(error)}`,
        };
      }
    }

    return {
      needsMigration: true,
      legacyFolderCount: legacy.folders.length,
      legacyDocumentCount: legacy.documents.length,
      legacyCompletedDocumentCount: counts.success,
      legacySkippedDocumentCount: counts.skipped,
      migrationCompleted: false,
      cleanupPending: false,
    };
  }

  function migrateLegacy() {
    ensureBaseDir();
    if (!fs.existsSync(legacyIndexPath)) {
      return { success: true, message: '未发现需要迁移的旧知识库数据', index: list(), migratedFolderCount: 0, migratedDocumentCount: 0, skippedDocumentCount: 0 };
    }
    const startedAt = now();

    try {
      const rawIndexContent = fs.readFileSync(legacyIndexPath, 'utf-8');
      const legacyIndexHash = stableHash(rawIndexContent);
      const legacy = normalizeIndex(JSON.parse(rawIndexContent || '{}'));
      const successfulDocuments = getSuccessfulLegacyDocuments(legacy);
      const skippedDocumentCount = legacy.documents.length - successfulDocuments.length;
      const migrationLegacy = { folders: legacy.folders, documents: successfulDocuments };
      const expectedByDocumentId = new Map();
      const migrateTransaction = db.transaction(() => {
        updateMigrationMeta({
          legacy_index_hash: legacyIndexHash,
          status: 'running',
          migrated_folder_count: 0,
          migrated_document_count: 0,
          started_at: startedAt,
          completed_at: null,
          cleanup_completed_at: null,
          error: null,
        });
        legacy.folders.forEach(insertOrUpdateFolder);
        for (const document of successfulDocuments) {
          const documentDir = resolvePath(document.document_dir);
          const markdownPath = resolvePath(document.markdown_path);
          const blocks = readJson(path.join(documentDir, 'blocks.json'), []);
          const filteredBlocks = readJson(path.join(documentDir, 'filtered_blocks.json'), []);
          const matchResult = readJson(path.join(documentDir, 'match_result.json'), null);
          const report = readJson(path.join(documentDir, 'report.json'), matchResult?.report || null);
          const candidateItems = readJson(path.join(documentDir, 'candidate_items.json'), matchResult?.candidate_items || []);
          const finalItems = readJson(path.join(documentDir, 'items.json'), []);
          const markdownChars = fs.existsSync(markdownPath) ? fs.readFileSync(markdownPath, 'utf-8').length : 0;
          expectedByDocumentId.set(document.id, {
            blockCount: getArrayLength(blocks),
            filteredBlockCount: getArrayLength(filteredBlocks),
            candidateItemCount: getArrayLength(candidateItems),
            finalItemCount: getArrayLength(finalItems),
            itemBlockCount: countExpectedItemBlocks(finalItems),
            discardedGroupCount: getArrayLength(matchResult?.discarded) + getArrayLength(matchResult?.system_discarded_after_retry),
            reportCount: report ? 1 : 0,
          });
          insertOrUpdateDocument({
            ...document,
            block_count: blocks.length,
            filtered_block_count: filteredBlocks.length,
            candidate_item_count: candidateItems.length,
            item_count: finalItems.length,
            discarded_block_count: Number(report?.discarded_blocks_count || document.discarded_block_count || 0),
            system_discarded_after_retry_count: Number(report?.system_discarded_after_retry_count || document.system_discarded_after_retry_count || 0),
          }, {
            markdownHash: hashFileIfExists(markdownPath),
            markdownChars,
          });
          replaceBlocks(document.id, blocks, filteredBlocks);
          replaceCandidateItems(document.id, candidateItems, 'legacy');
          replaceFinalItems(document.id, finalItems);
          replaceDiscardedGroups(document.id, matchResult || {});
          saveReport(document.id, report);
        }
        validateMigratedLegacy(migrationLegacy, expectedByDocumentId);
        updateMigrationMeta({
          status: 'success',
          migrated_folder_count: legacy.folders.length,
          migrated_document_count: successfulDocuments.length,
          completed_at: now(),
          error: null,
        });
      });
      migrateTransaction();

      let cleanupPending = false;
      try {
        cleanupLegacyJson(legacy);
      } catch (error) {
        cleanupPending = true;
        updateMigrationMeta({ error: error.message || String(error) });
      }

      const summary = `知识库迁移完成，共迁移 ${legacy.folders.length} 个文件夹、${successfulDocuments.length} 个已完成文档${skippedDocumentCount ? `，跳过 ${skippedDocumentCount} 个未完成文档` : ''}`;

      return {
        success: true,
        message: cleanupPending ? `${summary}；旧 JSON 清理将在下次进入时继续` : summary,
        index: list(),
        migratedFolderCount: legacy.folders.length,
        migratedDocumentCount: successfulDocuments.length,
        skippedDocumentCount,
        cleanupPending,
      };
    } catch (error) {
      updateMigrationMeta({ status: 'error', started_at: startedAt, error: error.message || String(error) });
      throw error;
    }
  }

  ensureBaseDir();

  return {
    list,
    createFolder,
    reorderFolders,
    renameFolder,
    deleteFolder,
    deleteDocument,
    createDocument,
    moveDocument,
    updateDocument,
    updateMarkdownMetadata,
    getDocument,
    recoverInterruptedDocuments,
    getDocumentStep,
    saveDocumentStep,
    clearDocumentProcessingFromStep,
    clearMatchBatches,
    getMatchBatch,
    readMatchBatches,
    saveMatchBatch,
    readMarkdown,
    saveBlocks: saveBlocksTransaction,
    readBlocks,
    readFilteredBlocks,
    saveCandidateItems: saveCandidateItemsTransaction,
    readCandidateItems,
    saveMatchResult,
    readItems,
    readAnalysis,
    getOutlineReferences,
    getMigrationStatus,
    migrateLegacy,
    resolvePath,
  };
}

module.exports = {
  createKnowledgeBaseStore,
  _internals: {
    normalizeIndex,
    normalizeDocument,
  },
};
