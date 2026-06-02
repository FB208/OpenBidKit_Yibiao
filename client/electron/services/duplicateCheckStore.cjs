const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDuplicateCheckContentDir, getDuplicateCheckDir } = require('../utils/paths.cjs');
const { deleteImportedImageBatches } = require('../utils/importedImages.cjs');

const initialState = {
  tenderFile: null,
  bidFiles: [],
  step: 'upload',
  activeAnalysisTab: 'metadata',
  analysisTask: undefined,
  metadataAnalysis: undefined,
  outlineAnalysis: undefined,
  contentAnalysis: undefined,
  imageAnalysis: undefined,
};

const sectionFields = {
  metadata: 'metadataAnalysis',
  outline: 'outlineAnalysis',
  content: 'contentAnalysis',
  image: 'imageAnalysis',
};

const fieldSections = Object.fromEntries(Object.entries(sectionFields).map(([section, field]) => [field, section]));

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

function hashContent(content) {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

function hashFileIfReadable(filePath) {
  const targetPath = String(filePath || '').trim();
  if (!targetPath || !fs.existsSync(targetPath)) return null;
  return hashContent(fs.readFileSync(targetPath, 'utf-8'));
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

function stableFileId(file) {
  return file?.id || crypto.createHash('sha1').update(String(file?.file_path || file?.file_name || '')).digest('hex');
}

function createSignature({ tenderFile, bidFiles } = {}) {
  const files = [tenderFile, ...(Array.isArray(bidFiles) ? bidFiles : [])]
    .filter(Boolean)
    .map((file) => `${file.file_path}|${file.size}|${file.modified_at}`);
  return crypto.createHash('sha1').update(files.join('\n')).digest('hex');
}

function scopedOutlineItemId(fileId, itemId) {
  return `${fileId}::${itemId}`;
}

function unscopedOutlineItemId(itemId) {
  return String(itemId || '').includes('::') ? String(itemId).split('::').slice(1).join('::') : String(itemId || '');
}

function normalizeStep(value) {
  return value === 'analysis' ? 'analysis' : 'upload';
}

function normalizeTab(value) {
  return ['metadata', 'outline', 'content', 'image'].includes(value) ? value : 'metadata';
}

function normalizeFile(file) {
  if (!file || typeof file !== 'object') return null;
  const fileId = stableFileId(file);
  const fileName = String(file.file_name || '').trim();
  const filePath = String(file.file_path || '').trim();
  if (!fileId || !fileName || !filePath) return null;
  return {
    id: fileId,
    file_name: fileName,
    file_path: filePath,
    extension: String(file.extension || path.extname(fileName) || '').toLowerCase(),
    size: Number(file.size || 0),
    modified_at: String(file.modified_at || ''),
  };
}

function fileFromRow(row) {
  return {
    id: row.file_id,
    file_name: row.file_name,
    file_path: row.file_path,
    extension: row.extension,
    size: Number(row.size || 0),
    modified_at: row.modified_at || '',
  };
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
    payload_signature: row.payload_signature || undefined,
  };
}

function createEmptyProgress(status = 'pending', total = 0) {
  return { status, completed: 0, total };
}

function buildRows(files) {
  const keyOrder = [];
  const rowsByKey = new Map();
  for (const file of files) {
    for (const item of file.metadata || []) {
      if (!rowsByKey.has(item.key)) {
        keyOrder.push(item.key);
        rowsByKey.set(item.key, { key: item.key, label: item.label, values: {}, duplicate_file_ids: [], same_day_file_ids: [] });
      }
      rowsByKey.get(item.key).values[file.file_id] = item.value;
    }
  }

  for (const key of keyOrder) {
    const row = rowsByKey.get(key);
    const normalizedToFiles = new Map();
    const dayToFiles = new Map();
    for (const file of files) {
      const item = (file.metadata || []).find((entry) => entry.key === key);
      if (!item?.comparable || !item.normalized) continue;
      if (item.date_comparable) {
        if (!item.date_day) continue;
        const list = dayToFiles.get(item.date_day) || [];
        list.push(file.file_id);
        dayToFiles.set(item.date_day, list);
        continue;
      }
      const list = normalizedToFiles.get(item.normalized) || [];
      list.push(file.file_id);
      normalizedToFiles.set(item.normalized, list);
    }
    row.duplicate_file_ids = Array.from(new Set(Array.from(normalizedToFiles.values()).filter((ids) => ids.length > 1).flat()));
    row.same_day_file_ids = Array.from(new Set(Array.from(dayToFiles.values()).filter((ids) => ids.length > 1).flat()));
  }

  return keyOrder.map((key) => rowsByKey.get(key));
}

function createSectionStats(section, analysis) {
  if (section === 'metadata') {
    return {
      contentExtraction: analysis.contentExtraction,
      metadataExtraction: analysis.metadataExtraction,
      logs: analysis.logs,
      files: Array.isArray(analysis.files)
        ? analysis.files.map((file) => ({ file_id: file.file_id, file_name: file.file_name, status: file.status, error: file.error }))
        : [],
    };
  }
  if (section === 'outline') {
    return {
      tenderSentenceCount: analysis.tenderSentenceCount,
      tenderMatchedItemCount: analysis.tenderMatchedItemCount,
      extraction: analysis.extraction,
      files: Array.isArray(analysis.files)
        ? analysis.files.map((file) => ({
            file_id: file.file_id,
            file_name: file.file_name,
            status: file.status,
            source: file.source,
            confidence: file.confidence,
            item_count: file.item_count,
            tender_matched_count: file.tender_matched_count,
            error: file.error,
          }))
        : [],
    };
  }
  if (section === 'content') {
    return {
      tenderSentenceCount: analysis.tenderSentenceCount,
      tenderMatchedSentenceCount: analysis.tenderMatchedSentenceCount,
      totalSentenceCount: analysis.totalSentenceCount,
      extraction: analysis.extraction,
    };
  }
  if (section === 'image') {
    return {
      extraction: analysis.extraction,
      totalImageCount: analysis.totalImageCount,
    };
  }
  return undefined;
}

function createDuplicateCheckStore({ app, db }) {
  const duplicateCheckDir = getDuplicateCheckDir(app);
  const contentDir = getDuplicateCheckContentDir(app);

  function ensureMetaRow() {
    const existing = db.prepare('SELECT * FROM duplicate_check_meta WHERE id = 1').get();
    if (existing) return existing;
    const timestamp = now();
    db.prepare(`
      INSERT INTO duplicate_check_meta (id, step, active_analysis_tab, created_at, updated_at)
      VALUES (1, 'upload', 'metadata', @timestamp, @timestamp)
    `).run({ timestamp });
    return db.prepare('SELECT * FROM duplicate_check_meta WHERE id = 1').get();
  }

  function updateMeta(fields) {
    ensureMetaRow();
    const entries = Object.entries(fields || {}).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE duplicate_check_meta SET ${assignments}, updated_at = @updated_at WHERE id = 1`).run({
      ...Object.fromEntries(entries),
      updated_at: now(),
    });
  }

  function loadFiles() {
    const rows = db.prepare('SELECT * FROM duplicate_check_files ORDER BY role ASC, sort_order ASC').all();
    const tenderRow = rows.find((row) => row.role === 'tender');
    const bidRows = rows.filter((row) => row.role === 'bid').sort((a, b) => a.sort_order - b.sort_order);
    return {
      tenderFile: tenderRow ? fileFromRow(tenderRow) : null,
      bidFiles: bidRows.map(fileFromRow),
    };
  }

  function replaceFiles(tenderFile, bidFiles) {
    db.prepare('DELETE FROM duplicate_check_files').run();
    const insert = db.prepare(`
      INSERT INTO duplicate_check_files (
        file_id, role, file_name, file_path, extension, size, modified_at, sort_order, content_hash, created_at, updated_at
      ) VALUES (
        @file_id, @role, @file_name, @file_path, @extension, @size, @modified_at, @sort_order, @content_hash, @created_at, @updated_at
      )
    `);
    const timestamp = now();
    const normalizedTender = normalizeFile(tenderFile);
    if (normalizedTender) {
      insert.run({
        file_id: normalizedTender.id,
        role: 'tender',
        file_name: normalizedTender.file_name,
        file_path: normalizedTender.file_path,
        extension: normalizedTender.extension,
        size: normalizedTender.size,
        modified_at: normalizedTender.modified_at,
        sort_order: 0,
        content_hash: null,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }
    (Array.isArray(bidFiles) ? bidFiles : []).map(normalizeFile).filter(Boolean).forEach((file, index) => {
      insert.run({
        file_id: file.id,
        role: 'bid',
        file_name: file.file_name,
        file_path: file.file_path,
        extension: file.extension,
        size: file.size,
        modified_at: file.modified_at,
        sort_order: index,
        content_hash: null,
        created_at: timestamp,
        updated_at: timestamp,
      });
    });
    updateMeta({ current_signature: createSignature({ tenderFile: normalizedTender, bidFiles }) });
  }

  function saveTask(type, task) {
    if (!task) {
      db.prepare('DELETE FROM duplicate_check_tasks WHERE type = ?').run(type);
      return;
    }
    const timestamp = now();
    db.prepare(`
      INSERT INTO duplicate_check_tasks (type, task_id, status, progress, logs_json, stats_json, error, payload_signature, started_at, updated_at)
      VALUES (@type, @task_id, @status, @progress, @logs_json, @stats_json, @error, @payload_signature, @started_at, @updated_at)
      ON CONFLICT(type) DO UPDATE SET
        task_id = excluded.task_id,
        status = excluded.status,
        progress = excluded.progress,
        logs_json = excluded.logs_json,
        stats_json = excluded.stats_json,
        error = excluded.error,
        payload_signature = excluded.payload_signature,
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
      payload_signature: task.payload_signature ? String(task.payload_signature) : null,
      started_at: task.started_at || timestamp,
      updated_at: task.updated_at || timestamp,
    });
  }

  function loadTask(type) {
    return taskFromRow(db.prepare('SELECT * FROM duplicate_check_tasks WHERE type = ?').get(type));
  }

  function saveSection(section, analysis) {
    if (!analysis) {
      clearSection(section);
      return;
    }

    const timestamp = now();
    db.prepare(`
      INSERT INTO duplicate_check_analysis_sections (section, status, progress, message, signature, stats_json, started_at, updated_at)
      VALUES (@section, @status, @progress, @message, @signature, @stats_json, @started_at, @updated_at)
      ON CONFLICT(section) DO UPDATE SET
        status = excluded.status,
        progress = excluded.progress,
        message = excluded.message,
        signature = excluded.signature,
        stats_json = excluded.stats_json,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `).run({
      section,
      status: String(analysis.status || 'pending'),
      progress: Math.max(0, Math.min(100, Math.round(Number(analysis.progress || 0)))),
      message: String(analysis.message || ''),
      signature: analysis.signature ? String(analysis.signature) : null,
      stats_json: jsonOrNull(createSectionStats(section, analysis)),
      started_at: analysis.started_at || timestamp,
      updated_at: analysis.updated_at || timestamp,
    });

    if (section === 'metadata') saveMetadataAnalysisDetails(analysis);
    if (section === 'outline') saveOutlineAnalysisDetails(analysis);
    if (section === 'content') saveContentAnalysisDetails(analysis);
    if (section === 'image') saveImageAnalysisDetails(analysis);
  }

  function clearSection(section) {
    db.prepare('DELETE FROM duplicate_check_analysis_sections WHERE section = ?').run(section);
    if (section === 'metadata') {
      db.prepare('DELETE FROM duplicate_check_content_files').run();
      db.prepare('DELETE FROM duplicate_check_metadata_items').run();
      db.prepare('UPDATE duplicate_check_files SET content_hash = NULL, updated_at = ?').run(now());
    }
    if (section === 'outline') {
      db.prepare('DELETE FROM duplicate_check_outline_items').run();
      db.prepare('DELETE FROM duplicate_check_outline_groups').run();
      db.prepare('DELETE FROM duplicate_check_outline_pairwise').run();
    }
    if (section === 'content') {
      db.prepare('DELETE FROM duplicate_check_content_occurrences').run();
      db.prepare('DELETE FROM duplicate_check_content_duplicates').run();
    }
    if (section === 'image') {
      db.prepare('DELETE FROM duplicate_check_image_occurrences').run();
      db.prepare('DELETE FROM duplicate_check_duplicate_images').run();
      db.prepare('DELETE FROM duplicate_check_image_files').run();
    }
  }

  function clearAnalysisState() {
    Object.keys(sectionFields).forEach(clearSection);
    db.prepare('DELETE FROM duplicate_check_tasks').run();
  }

  function saveMetadataAnalysisDetails(analysis) {
    db.prepare('DELETE FROM duplicate_check_content_files').run();
    db.prepare('DELETE FROM duplicate_check_metadata_items').run();
    const timestamp = now();
    db.prepare('UPDATE duplicate_check_files SET content_hash = NULL, updated_at = ?').run(timestamp);
    const contentInsert = db.prepare(`
      INSERT INTO duplicate_check_content_files (file_id, status, content_path, content_length, parser_label, error, updated_at)
      VALUES (@file_id, @status, @content_path, @content_length, @parser_label, @error, @updated_at)
    `);
    for (const item of Array.isArray(analysis.contentFiles) ? analysis.contentFiles : []) {
      if (!item?.file_id) continue;
      const contentHash = item.content_hash ? String(item.content_hash) : hashFileIfReadable(item.content_path);
      contentInsert.run({
        file_id: String(item.file_id),
        status: String(item.status || 'pending'),
        content_path: item.content_path ? String(item.content_path) : null,
        content_length: Number(item.content_length || 0),
        parser_label: item.parser_label ? String(item.parser_label) : null,
        error: item.error ? String(item.error) : null,
        updated_at: item.updated_at || timestamp,
      });
      db.prepare('UPDATE duplicate_check_files SET content_hash = @content_hash, updated_at = @updated_at WHERE file_id = @file_id').run({
        file_id: String(item.file_id),
        content_hash: contentHash,
        updated_at: item.updated_at || timestamp,
      });
    }

    const metadataInsert = db.prepare(`
      INSERT INTO duplicate_check_metadata_items (
        file_id, key, label, value, normalized, date_day, comparable, date_comparable, sort_order
      ) VALUES (
        @file_id, @key, @label, @value, @normalized, @date_day, @comparable, @date_comparable, @sort_order
      )
    `);
    for (const file of Array.isArray(analysis.files) ? analysis.files : []) {
      if (!file?.file_id) continue;
      (Array.isArray(file.metadata) ? file.metadata : []).forEach((item, index) => {
        if (!item?.key) return;
        metadataInsert.run({
          file_id: String(file.file_id),
          key: String(item.key),
          label: String(item.label || item.key),
          value: String(item.value || ''),
          normalized: item.normalized ? String(item.normalized) : null,
          date_day: item.date_day ? String(item.date_day) : null,
          comparable: toDbBool(item.comparable),
          date_comparable: toDbBool(item.date_comparable),
          sort_order: index,
        });
      });
    }
  }

  function saveOutlineAnalysisDetails(analysis) {
    db.prepare('DELETE FROM duplicate_check_outline_items').run();
    db.prepare('DELETE FROM duplicate_check_outline_groups').run();
    db.prepare('DELETE FROM duplicate_check_outline_pairwise').run();
    const itemInsert = db.prepare(`
      INSERT INTO duplicate_check_outline_items (
        item_id, file_id, parent_item_id, level, number, title, normalized_title, path_titles_json,
        normalized_path, source, confidence, sort_order, from_tender, matched_tender_sentence
      ) VALUES (
        @item_id, @file_id, @parent_item_id, @level, @number, @title, @normalized_title, @path_titles_json,
        @normalized_path, @source, @confidence, @sort_order, @from_tender, @matched_tender_sentence
      )
    `);
    for (const file of Array.isArray(analysis.files) ? analysis.files : []) {
      for (const item of Array.isArray(file.items) ? file.items : []) {
        if (!item?.id || !file?.file_id) continue;
        itemInsert.run({
          item_id: scopedOutlineItemId(file.file_id, item.id),
          file_id: String(file.file_id),
          parent_item_id: item.parent_id ? scopedOutlineItemId(file.file_id, item.parent_id) : null,
          level: Number(item.level || 1),
          number: item.number ? String(item.number) : null,
          title: String(item.title || ''),
          normalized_title: String(item.normalized_title || ''),
          path_titles_json: JSON.stringify(Array.isArray(item.path_titles) ? item.path_titles : []),
          normalized_path: String(item.normalized_path || ''),
          source: String(item.source || file.source || 'semantic'),
          confidence: Number(item.confidence ?? file.confidence ?? 0),
          sort_order: Number(item.order || 0),
          from_tender: toDbBool(item.from_tender),
          matched_tender_sentence: item.matched_tender_sentence ? String(item.matched_tender_sentence) : null,
        });
      }
    }

    const groupInsert = db.prepare(`
      INSERT INTO duplicate_check_outline_groups (group_id, type, title, score, file_ids_json, item_ids_json, paths_json, sort_order)
      VALUES (@group_id, @type, @title, @score, @file_ids_json, @item_ids_json, @paths_json, @sort_order)
    `);
    (Array.isArray(analysis.duplicateGroups) ? analysis.duplicateGroups : []).forEach((group, index) => {
      if (!group?.id) return;
      groupInsert.run({
        group_id: String(group.id),
        type: String(group.type || 'duplicate'),
        title: String(group.title || ''),
        score: Number(group.score || 0),
        file_ids_json: JSON.stringify(Array.isArray(group.file_ids) ? group.file_ids : []),
        item_ids_json: JSON.stringify(group.item_ids || {}),
        paths_json: JSON.stringify(group.paths || {}),
        sort_order: index,
      });
    });

    const pairwiseInsert = db.prepare(`
      INSERT INTO duplicate_check_outline_pairwise (
        file_a_id, file_b_id, score, title_overlap, path_overlap, order_similarity, shared_count, risk
      ) VALUES (
        @file_a_id, @file_b_id, @score, @title_overlap, @path_overlap, @order_similarity, @shared_count, @risk
      )
    `);
    for (const item of Array.isArray(analysis.pairwiseSimilarities) ? analysis.pairwiseSimilarities : []) {
      if (!item?.file_a_id || !item?.file_b_id) continue;
      pairwiseInsert.run({
        file_a_id: String(item.file_a_id),
        file_b_id: String(item.file_b_id),
        score: Number(item.score || 0),
        title_overlap: Number(item.title_overlap || 0),
        path_overlap: Number(item.path_overlap || 0),
        order_similarity: Number(item.order_similarity || 0),
        shared_count: Number(item.shared_count || 0),
        risk: String(item.risk || 'none'),
      });
    }
  }

  function saveContentAnalysisDetails(analysis) {
    db.prepare('DELETE FROM duplicate_check_content_occurrences').run();
    db.prepare('DELETE FROM duplicate_check_content_duplicates').run();
    const duplicateInsert = db.prepare(`
      INSERT INTO duplicate_check_content_duplicates (duplicate_id, sentence, normalized, file_ids_json, first_order)
      VALUES (@duplicate_id, @sentence, @normalized, @file_ids_json, @first_order)
    `);
    const occurrenceInsert = db.prepare(`
      INSERT INTO duplicate_check_content_occurrences (duplicate_id, file_id, occurrence_count)
      VALUES (@duplicate_id, @file_id, @occurrence_count)
    `);
    (Array.isArray(analysis.duplicateSentences) ? analysis.duplicateSentences : []).forEach((item, index) => {
      const duplicateId = item?.id || `C${String(index + 1).padStart(6, '0')}`;
      duplicateInsert.run({
        duplicate_id: duplicateId,
        sentence: String(item?.sentence || ''),
        normalized: String(item?.normalized || ''),
        file_ids_json: JSON.stringify(Array.isArray(item?.file_ids) ? item.file_ids : []),
        first_order: Number(item?.first_order ?? index),
      });
      for (const [fileId, count] of Object.entries(item?.occurrences || {})) {
        occurrenceInsert.run({ duplicate_id: duplicateId, file_id: fileId, occurrence_count: Number(count || 0) });
      }
    });
  }

  function saveImageAnalysisDetails(analysis) {
    db.prepare('DELETE FROM duplicate_check_image_occurrences').run();
    db.prepare('DELETE FROM duplicate_check_duplicate_images').run();
    db.prepare('DELETE FROM duplicate_check_image_files').run();
    const timestamp = now();
    const fileInsert = db.prepare(`
      INSERT INTO duplicate_check_image_files (file_id, status, image_count, unique_image_count, error, updated_at)
      VALUES (@file_id, @status, @image_count, @unique_image_count, @error, @updated_at)
    `);
    for (const file of Array.isArray(analysis.files) ? analysis.files : []) {
      if (!file?.file_id) continue;
      fileInsert.run({
        file_id: String(file.file_id),
        status: String(file.status || 'pending'),
        image_count: Number(file.image_count || 0),
        unique_image_count: Number(file.unique_image_count || 0),
        error: file.error ? String(file.error) : null,
        updated_at: file.updated_at || timestamp,
      });
    }

    const imageInsert = db.prepare(`
      INSERT INTO duplicate_check_duplicate_images (image_id, hash, preview_url, file_ids_json, sort_order)
      VALUES (@image_id, @hash, @preview_url, @file_ids_json, @sort_order)
    `);
    const occurrenceInsert = db.prepare(`
      INSERT INTO duplicate_check_image_occurrences (image_id, file_id, occurrence_count, locations_json)
      VALUES (@image_id, @file_id, @occurrence_count, @locations_json)
    `);
    (Array.isArray(analysis.duplicateImages) ? analysis.duplicateImages : []).forEach((item, index) => {
      const imageId = item?.id || `I${String(index + 1).padStart(6, '0')}`;
      imageInsert.run({
        image_id: imageId,
        hash: String(item?.hash || ''),
        preview_url: String(item?.preview_url || ''),
        file_ids_json: JSON.stringify(Array.isArray(item?.file_ids) ? item.file_ids : []),
        sort_order: index,
      });
      for (const [fileId, count] of Object.entries(item?.occurrences || {})) {
        occurrenceInsert.run({
          image_id: imageId,
          file_id: fileId,
          occurrence_count: Number(count || 0),
          locations_json: jsonOrNull(item?.locations?.[fileId]),
        });
      }
    });
  }

  function loadMetadataAnalysis(row) {
    if (!row) return undefined;
    const stats = safeJsonParse(row.stats_json, {});
    const contentFiles = db.prepare('SELECT * FROM duplicate_check_content_files ORDER BY file_id ASC').all().map((item) => ({
      file_id: item.file_id,
      file_name: loadFileName(item.file_id),
      status: normalizeStatus(item.status, ['pending', 'running', 'success', 'error'], 'pending'),
      content_path: item.content_path || undefined,
      content_length: Number(item.content_length || 0),
      parser_label: item.parser_label || undefined,
      error: item.error || undefined,
    }));
    const metadataRows = db.prepare('SELECT * FROM duplicate_check_metadata_items ORDER BY file_id ASC, sort_order ASC, id ASC').all();
    const statusByFile = new Map((stats.files || []).map((file) => [file.file_id, file]));
    const filesById = new Map();
    for (const file of loadFiles().bidFiles) {
      const summary = statusByFile.get(file.id) || {};
      filesById.set(file.id, { file_id: file.id, file_name: file.file_name, status: summary.status || 'pending', metadata: [], error: summary.error });
    }
    for (const item of metadataRows) {
      if (!filesById.has(item.file_id)) {
        const summary = statusByFile.get(item.file_id) || {};
        filesById.set(item.file_id, { file_id: item.file_id, file_name: loadFileName(item.file_id), status: summary.status || 'success', metadata: [], error: summary.error });
      }
      filesById.get(item.file_id).metadata.push({
        key: item.key,
        label: item.label,
        value: item.value || '',
        normalized: item.normalized || undefined,
        date_day: item.date_day || undefined,
        comparable: fromDbBool(item.comparable),
        date_comparable: fromDbBool(item.date_comparable),
      });
    }
    const files = Array.from(filesById.values());
    return {
      status: normalizeStatus(row.status, ['pending', 'running', 'success', 'error'], 'pending'),
      progress: Number(row.progress || 0),
      message: row.message || '',
      signature: row.signature || undefined,
      started_at: row.started_at || undefined,
      updated_at: row.updated_at || undefined,
      contentExtraction: stats.contentExtraction || createEmptyProgress('pending', contentFiles.length),
      metadataExtraction: stats.metadataExtraction || createEmptyProgress('pending', files.length),
      files,
      rows: buildRows(files),
      contentFiles,
      logs: Array.isArray(stats.logs) ? stats.logs : [],
    };
  }

  function loadOutlineAnalysis(row) {
    if (!row) return undefined;
    const stats = safeJsonParse(row.stats_json, {});
    const itemsByFile = new Map();
    for (const item of db.prepare('SELECT * FROM duplicate_check_outline_items ORDER BY file_id ASC, sort_order ASC').all()) {
      const list = itemsByFile.get(item.file_id) || [];
      list.push({
        id: unscopedOutlineItemId(item.item_id),
        level: Number(item.level || 1),
        number: item.number || undefined,
        title: item.title,
        normalized_title: item.normalized_title,
        path_titles: safeJsonParse(item.path_titles_json, []),
        normalized_path: item.normalized_path,
        source: item.source,
        confidence: Number(item.confidence || 0),
        order: Number(item.sort_order || 0),
        parent_id: item.parent_item_id ? unscopedOutlineItemId(item.parent_item_id) : undefined,
        from_tender: fromDbBool(item.from_tender),
        matched_tender_sentence: item.matched_tender_sentence || undefined,
        duplicate_group_ids: [],
        similar_group_ids: [],
      });
      itemsByFile.set(item.file_id, list);
    }
    const groupRows = db.prepare('SELECT * FROM duplicate_check_outline_groups ORDER BY sort_order ASC').all();
    const duplicateGroups = groupRows.map((group) => ({
      id: group.group_id,
      type: group.type,
      title: group.title,
      score: Number(group.score || 0),
      file_ids: safeJsonParse(group.file_ids_json, []),
      item_ids: safeJsonParse(group.item_ids_json, {}),
      paths: safeJsonParse(group.paths_json, {}),
    }));
    for (const group of duplicateGroups) {
      for (const [fileId, itemIds] of Object.entries(group.item_ids || {})) {
        const items = itemsByFile.get(fileId) || [];
        for (const itemId of Array.isArray(itemIds) ? itemIds : []) {
          const item = items.find((entry) => entry.id === itemId);
          if (item) {
            const field = group.type === 'similar' ? 'similar_group_ids' : 'duplicate_group_ids';
            if (!item[field].includes(group.id)) item[field].push(group.id);
          }
        }
      }
    }
    const summaryByFile = new Map((stats.files || []).map((file) => [file.file_id, file]));
    const files = loadFiles().bidFiles.map((file) => {
      const summary = summaryByFile.get(file.id) || {};
      const items = itemsByFile.get(file.id) || [];
      return {
        file_id: file.id,
        file_name: file.file_name,
        status: summary.status || (items.length ? 'success' : 'pending'),
        source: summary.source || items[0]?.source,
        confidence: Number(summary.confidence ?? items[0]?.confidence ?? 0),
        item_count: Number(summary.item_count ?? items.length),
        tender_matched_count: Number(summary.tender_matched_count ?? items.filter((item) => item.from_tender).length),
        items,
        error: summary.error,
      };
    });
    const pairwiseSimilarities = db.prepare('SELECT * FROM duplicate_check_outline_pairwise ORDER BY score DESC, id ASC').all().map((item) => ({
      file_a_id: item.file_a_id,
      file_b_id: item.file_b_id,
      score: Number(item.score || 0),
      title_overlap: Number(item.title_overlap || 0),
      path_overlap: Number(item.path_overlap || 0),
      order_similarity: Number(item.order_similarity || 0),
      shared_count: Number(item.shared_count || 0),
      risk: item.risk || 'none',
    }));
    return {
      status: normalizeStatus(row.status, ['pending', 'running', 'success', 'error'], 'pending'),
      progress: Number(row.progress || 0),
      message: row.message || '',
      signature: row.signature || undefined,
      started_at: row.started_at || undefined,
      updated_at: row.updated_at || undefined,
      tenderSentenceCount: Number(stats.tenderSentenceCount || 0),
      tenderMatchedItemCount: Number(stats.tenderMatchedItemCount || 0),
      extraction: stats.extraction || createEmptyProgress('pending', files.length),
      files,
      duplicateGroups,
      pairwiseSimilarities,
    };
  }

  function loadContentAnalysis(row) {
    if (!row) return undefined;
    const stats = safeJsonParse(row.stats_json, {});
    const occurrenceRows = db.prepare('SELECT * FROM duplicate_check_content_occurrences').all();
    const occurrenceMap = new Map();
    for (const rowItem of occurrenceRows) {
      const occurrences = occurrenceMap.get(rowItem.duplicate_id) || {};
      occurrences[rowItem.file_id] = Number(rowItem.occurrence_count || 0);
      occurrenceMap.set(rowItem.duplicate_id, occurrences);
    }
    const duplicateSentences = db.prepare('SELECT * FROM duplicate_check_content_duplicates ORDER BY first_order ASC').all().map((item) => ({
      id: item.duplicate_id,
      sentence: item.sentence,
      normalized: item.normalized,
      file_ids: safeJsonParse(item.file_ids_json, []),
      occurrences: occurrenceMap.get(item.duplicate_id) || {},
      first_order: Number(item.first_order || 0),
    }));
    return {
      status: normalizeStatus(row.status, ['pending', 'running', 'success', 'error'], 'pending'),
      progress: Number(row.progress || 0),
      message: row.message || '',
      signature: row.signature || undefined,
      started_at: row.started_at || undefined,
      updated_at: row.updated_at || undefined,
      tenderSentenceCount: Number(stats.tenderSentenceCount || 0),
      tenderMatchedSentenceCount: Number(stats.tenderMatchedSentenceCount || 0),
      totalSentenceCount: Number(stats.totalSentenceCount || 0),
      extraction: stats.extraction || createEmptyProgress('pending', loadFiles().bidFiles.length),
      duplicateSentences,
    };
  }

  function loadImageAnalysis(row) {
    if (!row) return undefined;
    const stats = safeJsonParse(row.stats_json, {});
    const files = db.prepare('SELECT * FROM duplicate_check_image_files ORDER BY file_id ASC').all().map((item) => ({
      file_id: item.file_id,
      file_name: loadFileName(item.file_id),
      status: normalizeStatus(item.status, ['pending', 'running', 'success', 'error'], 'pending'),
      image_count: Number(item.image_count || 0),
      unique_image_count: Number(item.unique_image_count || 0),
      error: item.error || undefined,
    }));
    const occurrenceRows = db.prepare('SELECT * FROM duplicate_check_image_occurrences').all();
    const occurrenceMap = new Map();
    const locationMap = new Map();
    for (const item of occurrenceRows) {
      const occurrences = occurrenceMap.get(item.image_id) || {};
      occurrences[item.file_id] = Number(item.occurrence_count || 0);
      occurrenceMap.set(item.image_id, occurrences);
      const locations = locationMap.get(item.image_id) || {};
      locations[item.file_id] = safeJsonParse(item.locations_json, []);
      locationMap.set(item.image_id, locations);
    }
    const duplicateImages = db.prepare('SELECT * FROM duplicate_check_duplicate_images ORDER BY sort_order ASC').all().map((item) => ({
      id: item.image_id,
      hash: item.hash,
      preview_url: item.preview_url,
      file_ids: safeJsonParse(item.file_ids_json, []),
      occurrences: occurrenceMap.get(item.image_id) || {},
      locations: locationMap.get(item.image_id) || {},
    }));
    return {
      status: normalizeStatus(row.status, ['pending', 'running', 'success', 'error'], 'pending'),
      progress: Number(row.progress || 0),
      message: row.message || '',
      signature: row.signature || undefined,
      started_at: row.started_at || undefined,
      updated_at: row.updated_at || undefined,
      extraction: stats.extraction || createEmptyProgress('pending', loadFiles().bidFiles.length),
      totalImageCount: Number(stats.totalImageCount || 0),
      files,
      duplicateImages,
    };
  }

  function loadFileName(fileId) {
    const row = db.prepare('SELECT file_name FROM duplicate_check_files WHERE file_id = ?').get(fileId);
    return row?.file_name || fileId;
  }

  function loadAnalysisSections() {
    const rows = db.prepare('SELECT * FROM duplicate_check_analysis_sections').all();
    const bySection = new Map(rows.map((row) => [row.section, row]));
    return {
      metadataAnalysis: loadMetadataAnalysis(bySection.get('metadata')),
      outlineAnalysis: loadOutlineAnalysis(bySection.get('outline')),
      contentAnalysis: loadContentAnalysis(bySection.get('content')),
      imageAnalysis: loadImageAnalysis(bySection.get('image')),
    };
  }

  const updateDuplicateCheckTransaction = db.transaction((partial) => {
    ensureMetaRow();
    const metaUpdates = {};
    if (hasOwn(partial, 'step')) metaUpdates.step = normalizeStep(partial.step);
    if (hasOwn(partial, 'activeAnalysisTab')) metaUpdates.active_analysis_tab = normalizeTab(partial.activeAnalysisTab);
    if (Object.keys(metaUpdates).length) updateMeta(metaUpdates);

    if (hasOwn(partial, 'tenderFile') || hasOwn(partial, 'bidFiles')) {
      const currentFiles = loadFiles();
      replaceFiles(
        hasOwn(partial, 'tenderFile') ? partial.tenderFile : currentFiles.tenderFile,
        hasOwn(partial, 'bidFiles') ? partial.bidFiles : currentFiles.bidFiles,
      );
    }

    if (hasOwn(partial, 'analysisTask')) saveTask('duplicate-analysis', partial.analysisTask);
    for (const [field, section] of Object.entries(fieldSections)) {
      if (hasOwn(partial, field)) saveSection(section, partial[field]);
    }
  });

  function loadDuplicateCheck() {
    const meta = ensureMetaRow();
    const files = loadFiles();
    return {
      ...initialState,
      ...files,
      step: normalizeStep(meta.step),
      activeAnalysisTab: normalizeTab(meta.active_analysis_tab),
      analysisTask: loadTask('duplicate-analysis'),
      ...loadAnalysisSections(),
    };
  }

  function updateDuplicateCheck(partial) {
    updateDuplicateCheckTransaction(partial || {});
    return loadDuplicateCheck();
  }

  function saveDuplicateCheck(state) {
    return updateDuplicateCheck(state || {});
  }

  function saveFiles({ tenderFile, bidFiles, step, activeAnalysisTab } = {}) {
    const transaction = db.transaction(() => {
      ensureMetaRow();
      replaceFiles(tenderFile || null, Array.isArray(bidFiles) ? bidFiles : []);
      clearAnalysisState();
      updateMeta({
        step: normalizeStep(step),
        active_analysis_tab: normalizeTab(activeAnalysisTab),
      });
    });
    transaction();
    clearDuplicateContentArtifacts();
    return loadDuplicateCheck();
  }

  function saveUiState({ step, activeAnalysisTab } = {}) {
    return updateDuplicateCheck({ step, activeAnalysisTab });
  }

  function clearDuplicateCheck() {
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM duplicate_check_tasks').run();
      db.prepare('DELETE FROM duplicate_check_analysis_sections').run();
      db.prepare('DELETE FROM duplicate_check_image_occurrences').run();
      db.prepare('DELETE FROM duplicate_check_duplicate_images').run();
      db.prepare('DELETE FROM duplicate_check_image_files').run();
      db.prepare('DELETE FROM duplicate_check_content_occurrences').run();
      db.prepare('DELETE FROM duplicate_check_content_duplicates').run();
      db.prepare('DELETE FROM duplicate_check_outline_pairwise').run();
      db.prepare('DELETE FROM duplicate_check_outline_groups').run();
      db.prepare('DELETE FROM duplicate_check_outline_items').run();
      db.prepare('DELETE FROM duplicate_check_metadata_items').run();
      db.prepare('DELETE FROM duplicate_check_content_files').run();
      db.prepare('DELETE FROM duplicate_check_files').run();
      db.prepare('DELETE FROM duplicate_check_meta').run();
      ensureMetaRow();
    });
    transaction();
    if (fs.existsSync(duplicateCheckDir)) {
      fs.rmSync(duplicateCheckDir, { recursive: true, force: true });
    }
    deleteImportedImageBatches(app, 'duplicate-check-content');
    ensureDirectories();
    return { success: true, message: '标书查重缓存已清空', state: loadDuplicateCheck() };
  }

  function clearDuplicateContentArtifacts() {
    if (fs.existsSync(contentDir)) {
      fs.rmSync(contentDir, { recursive: true, force: true });
    }
    fs.mkdirSync(contentDir, { recursive: true });
    deleteImportedImageBatches(app, 'duplicate-check-content');
  }

  function ensureDirectories() {
    fs.mkdirSync(duplicateCheckDir, { recursive: true });
    fs.mkdirSync(contentDir, { recursive: true });
  }

  ensureDirectories();

  return {
    loadDuplicateCheck,
    saveDuplicateCheck,
    updateDuplicateCheck,
    clearDuplicateCheck,
    saveFiles,
    saveUiState,
  };
}

module.exports = {
  createDuplicateCheckStore,
};
