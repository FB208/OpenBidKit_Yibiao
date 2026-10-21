const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getBlindCheckDir, getBlindCheckFixedDir, getBlindCheckSourceDir, getBlindCheckTenderDir, getWorkspaceDir } = require('../utils/paths.cjs');
const { DEFAULT_PRESET_ID, findBuiltinPreset, listBuiltinPresets, normalizeFixRules, normalizeProfile } = require('./blindCheckPresets.cjs');
const { buildIssueList, reviewForResult } = require('./blindCheckReview.cjs');

const TASK_DOMAIN = 'blind-check';
const CHECK_TASK_TYPE = 'blind-check-run';
const FIX_TASK_TYPE = 'blind-check-fix';
const EXTRACTION_TASK_TYPE = 'blind-check-preset-extraction';
const MAX_PRESET_NAME_LENGTH = 30;
const STEPS = ['upload', 'preset', 'results', 'fix'];
const PRESET_TABS = ['page', 'body', 'headings', 'table', 'privacy', 'source'];
const RESULT_TABS = ['all', 'privacy', 'structure', 'page', 'paragraph', 'font', 'text', 'table', 'consistency', 'image', 'other'];
const RESULT_STATUSES = ['idle', 'running', 'success', 'error'];
// AI 复核状态：skipped 表示本次检查关闭了 AI 复核。
const REVIEW_STATUSES = ['idle', 'running', 'success', 'error', 'skipped'];
// 非候选问题组保存的定位条目上限，与交给 Agent 的数量一致。
const MAX_STORED_ITEMS = 30;

// 资信库中可直接识别本单位的字段，作为暗标敏感词。
const CREDENTIAL_FIELDS = [
  ['companyName', '企业名称'],
  ['unifiedSocialCreditCode', '统一社会信用代码'],
  ['legalRepresentative', '法定代表人'],
  ['phone', '联系电话'],
  ['email', '电子邮箱'],
  ['address', '注册地址'],
  ['bankAccountName', '开户名称'],
  ['bankAccountNumber', '银行账号'],
];
const COMPANY_SUFFIXES = ['股份有限公司', '有限责任公司', '集团有限公司', '集团股份有限公司', '有限公司'];

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

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function taskFromRow(row, taskLogStore) {
  if (!row) return undefined;
  return {
    task_id: row.task_id,
    type: row.type,
    status: pick(row.status, ['running', 'success', 'error'], 'running'),
    progress: Number(row.progress || 0),
    logs: taskLogStore.list(TASK_DOMAIN, row.type, row.task_id),
    started_at: row.started_at,
    updated_at: row.updated_at,
    error: row.error || undefined,
    stats: safeJsonParse(row.stats_json, undefined),
  };
}

/** 文件内容指纹：分块读取，大文档不整份进内存。 */
function hashFile(filePath) {
  const hash = crypto.createHash('sha1');
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

/** 去掉"有限公司"等后缀得到常用简称，过短的不作为敏感词。 */
function companyShortName(name) {
  const suffix = COMPANY_SUFFIXES.find((item) => name.endsWith(item));
  if (!suffix) return '';
  const shortName = name.slice(0, -suffix.length).trim();
  return shortName.length >= 4 ? shortName : '';
}

function createBlindCheckStore({ app, db, taskLogStore, credentialLibraryService, fileService, technicalPlanStore }) {
  const blindCheckDir = getBlindCheckDir(app);
  const sourceDir = getBlindCheckSourceDir(app);
  const fixedDir = getBlindCheckFixedDir(app);
  const tenderDir = getBlindCheckTenderDir(app);

  /** AI 提取预设时保存的招标文件正文，按预设 ID 命名。 */
  function tenderPath(presetId) {
    return path.join(tenderDir, `${String(presetId).replace(/[^a-zA-Z0-9_-]/g, '_')}.md`);
  }

  function ensureMetaRow() {
    const existing = db.prepare('SELECT * FROM blind_check_meta WHERE id = 1').get();
    if (existing) return existing;
    const timestamp = now();
    db.prepare(`
      INSERT INTO blind_check_meta (id, step, preset_id, preset_tab, result_tab, use_credential_words, created_at, updated_at)
      VALUES (1, 'upload', @preset_id, 'page', 'all', 1, @timestamp, @timestamp)
    `).run({ preset_id: DEFAULT_PRESET_ID, timestamp });
    return db.prepare('SELECT * FROM blind_check_meta WHERE id = 1').get();
  }

  function updateMeta(fields) {
    ensureMetaRow();
    const entries = Object.entries(fields || {}).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE blind_check_meta SET ${assignments}, updated_at = @updated_at WHERE id = 1`).run({
      ...Object.fromEntries(entries),
      updated_at: now(),
    });
  }

  function saveTask(type, task) {
    if (!task) {
      db.prepare('DELETE FROM blind_check_tasks WHERE type = ?').run(type);
      return;
    }
    const timestamp = now();
    db.prepare(`
      INSERT INTO blind_check_tasks (type, task_id, status, progress, stats_json, error, started_at, updated_at)
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
    taskLogStore.sync(TASK_DOMAIN, type, String(task.task_id || ''), task.logs, task.updated_at || timestamp);
  }

  function clearResultRows() {
    db.prepare('DELETE FROM blind_check_finding_groups').run();
    db.prepare('DELETE FROM blind_check_results').run();
    db.prepare('DELETE FROM blind_check_reviews').run();
  }

  /** AI 复核结果：运行中只记状态和签名，完成时整体替换复核内容。 */
  function saveReview(review) {
    if (!review) {
      db.prepare('DELETE FROM blind_check_reviews').run();
      return;
    }
    const existing = db.prepare('SELECT * FROM blind_check_reviews WHERE id = 1').get();
    const value = (field, column, transform = (item) => item) => (hasOwn(review, field) ? transform(review[field]) : existing?.[column] ?? null);
    db.prepare(`
      INSERT INTO blind_check_reviews (id, status, input_signature, tender_name, review_json, error, updated_at)
      VALUES (1, @status, @input_signature, @tender_name, @review_json, @error, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        input_signature = excluded.input_signature,
        tender_name = excluded.tender_name,
        review_json = excluded.review_json,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run({
      status: pick(review.status, REVIEW_STATUSES, existing?.status || 'idle'),
      input_signature: value('inputSignature', 'input_signature'),
      tender_name: value('tenderName', 'tender_name'),
      review_json: value('review', 'review_json', jsonOrNull),
      error: value('error', 'error', (item) => (item ? String(item) : null)),
      updated_at: review.updatedAt || now(),
    });
  }

  function loadReview() {
    const row = db.prepare('SELECT * FROM blind_check_reviews WHERE id = 1').get();
    if (!row) return { status: 'idle' };
    return {
      status: pick(row.status, REVIEW_STATUSES, 'idle'),
      inputSignature: row.input_signature || undefined,
      tenderName: row.tender_name || '',
      review: safeJsonParse(row.review_json, undefined),
      error: row.error || undefined,
      updatedAt: row.updated_at || undefined,
    };
  }

  /** 结果写入：运行中只记状态和签名，成功时整体替换问题分组。 */
  function saveResult(result) {
    if (!result) {
      clearResultRows();
      return;
    }
    const existing = db.prepare('SELECT * FROM blind_check_results WHERE id = 1').get();
    const status = pick(result.status, RESULT_STATUSES, existing?.status || 'idle');
    const value = (field, column, transform = (item) => item) => (hasOwn(result, field) ? transform(result[field]) : existing?.[column] ?? null);
    db.prepare(`
      INSERT INTO blind_check_results (id, status, input_signature, preset_name, summary_json, stats_json, rule_errors_json, error, updated_at)
      VALUES (1, @status, @input_signature, @preset_name, @summary_json, @stats_json, @rule_errors_json, @error, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        input_signature = excluded.input_signature,
        preset_name = excluded.preset_name,
        summary_json = excluded.summary_json,
        stats_json = excluded.stats_json,
        rule_errors_json = excluded.rule_errors_json,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run({
      status,
      input_signature: value('inputSignature', 'input_signature'),
      preset_name: value('presetName', 'preset_name'),
      summary_json: value('summary', 'summary_json', jsonOrNull),
      stats_json: value('stats', 'stats_json', jsonOrNull),
      rule_errors_json: value('ruleErrors', 'rule_errors_json', jsonOrNull),
      error: value('error', 'error', (item) => (item ? String(item) : null)),
      updated_at: result.updatedAt || now(),
    });

    if (!hasOwn(result, 'groups')) return;
    db.prepare('DELETE FROM blind_check_finding_groups').run();
    const insert = db.prepare(`
      INSERT INTO blind_check_finding_groups (group_id, rule_id, rule_title, category, severity, message, finding_count, samples_json, sort_order, candidate, items_json)
      VALUES (@group_id, @rule_id, @rule_title, @category, @severity, @message, @finding_count, @samples_json, @sort_order, @candidate, @items_json)
    `);
    // 组编号与 AI 复核里的 g 编号一致。定位条目供重新复核和修复阶段的 Agent 使用：
    // 候选组保存全部条目（逐条显示复核结论），其余组只存前若干条。
    (Array.isArray(result.groups) ? result.groups : []).forEach((group, index) => {
      const items = Array.isArray(group.items) ? group.items : [];
      insert.run({
        group_id: group.id || `g${index}`,
        rule_id: String(group.ruleId || ''),
        rule_title: String(group.ruleTitle || ''),
        category: String(group.category || ''),
        severity: pick(group.severity, ['high', 'medium', 'low'], 'low'),
        message: String(group.message || ''),
        finding_count: Number(group.count || 0),
        samples_json: JSON.stringify(Array.isArray(group.samples) ? group.samples : []),
        sort_order: index,
        candidate: group.candidate ? 1 : 0,
        items_json: JSON.stringify(group.candidate ? items : items.slice(0, MAX_STORED_ITEMS)),
      });
    });
  }

  function clearFixRows() {
    db.prepare('DELETE FROM blind_check_fix_groups').run();
    db.prepare('DELETE FROM blind_check_fix_results').run();
  }

  /** 修复结果写入：与检查结果同样只在提交时整体替换复查后的问题分组。 */
  function saveFixResult(result) {
    if (!result) {
      clearFixRows();
      return;
    }
    const existing = db.prepare('SELECT * FROM blind_check_fix_results WHERE id = 1').get();
    const value = (field, column, transform = (item) => item) => (hasOwn(result, field) ? transform(result[field]) : existing?.[column] ?? null);
    db.prepare(`
      INSERT INTO blind_check_fix_results (
        id, status, input_signature, fix_rules_json, output_path, source_bytes, output_bytes, fixes_json, notes_json, validation_json,
        before_summary_json, before_rule_counts_json, after_summary_json, after_stats_json, error, updated_at,
        items_json, new_groups_json, clauses_json, agent_json
      )
      VALUES (
        1, @status, @input_signature, @fix_rules_json, @output_path, @source_bytes, @output_bytes, @fixes_json, @notes_json, @validation_json,
        @before_summary_json, @before_rule_counts_json, @after_summary_json, @after_stats_json, @error, @updated_at,
        @items_json, @new_groups_json, @clauses_json, @agent_json
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        input_signature = excluded.input_signature,
        fix_rules_json = excluded.fix_rules_json,
        output_path = excluded.output_path,
        source_bytes = excluded.source_bytes,
        output_bytes = excluded.output_bytes,
        fixes_json = excluded.fixes_json,
        notes_json = excluded.notes_json,
        validation_json = excluded.validation_json,
        before_summary_json = excluded.before_summary_json,
        before_rule_counts_json = excluded.before_rule_counts_json,
        after_summary_json = excluded.after_summary_json,
        after_stats_json = excluded.after_stats_json,
        error = excluded.error,
        updated_at = excluded.updated_at,
        items_json = excluded.items_json,
        new_groups_json = excluded.new_groups_json,
        clauses_json = excluded.clauses_json,
        agent_json = excluded.agent_json
    `).run({
      status: pick(result.status, RESULT_STATUSES, existing?.status || 'idle'),
      input_signature: value('inputSignature', 'input_signature'),
      fix_rules_json: value('fixRules', 'fix_rules_json', jsonOrNull),
      output_path: value('output', 'output_path'),
      source_bytes: Number(value('sourceBytes', 'source_bytes') || 0),
      output_bytes: Number(value('outputBytes', 'output_bytes') || 0),
      fixes_json: value('fixes', 'fixes_json', jsonOrNull),
      notes_json: value('notes', 'notes_json', jsonOrNull),
      validation_json: value('validation', 'validation_json', jsonOrNull),
      before_summary_json: value('beforeSummary', 'before_summary_json', jsonOrNull),
      before_rule_counts_json: null,
      after_summary_json: value('afterSummary', 'after_summary_json', jsonOrNull),
      after_stats_json: value('afterStats', 'after_stats_json', jsonOrNull),
      error: value('error', 'error', (item) => (item ? String(item) : null)),
      updated_at: result.updatedAt || now(),
      items_json: value('items', 'items_json', jsonOrNull),
      new_groups_json: null,
      clauses_json: null,
      agent_json: value('agent', 'agent_json', jsonOrNull),
    });

    if (!hasOwn(result, 'groups')) return;
    db.prepare('DELETE FROM blind_check_fix_groups').run();
    const insert = db.prepare(`
      INSERT INTO blind_check_fix_groups (group_id, rule_id, rule_title, category, severity, message, finding_count, samples_json, sort_order)
      VALUES (@group_id, @rule_id, @rule_title, @category, @severity, @message, @finding_count, @samples_json, @sort_order)
    `);
    (Array.isArray(result.groups) ? result.groups : []).forEach((group, index) => {
      insert.run({
        group_id: `f${index}`,
        rule_id: String(group.ruleId || ''),
        rule_title: String(group.ruleTitle || ''),
        category: String(group.category || ''),
        severity: pick(group.severity, ['high', 'medium', 'low'], 'low'),
        message: String(group.message || ''),
        finding_count: Number(group.count || 0),
        samples_json: JSON.stringify(Array.isArray(group.samples) ? group.samples : []),
        sort_order: index,
      });
    });
  }

  function loadFixResult() {
    const row = db.prepare('SELECT * FROM blind_check_fix_results WHERE id = 1').get();
    if (!row) return { status: 'idle', groups: [] };
    const items = safeJsonParse(row.items_json, []);
    // 旧版修复结果的条目没有 pendingOccurrences，口径也不同（含"无需处理"、不分修复范围），按没有修复结果处理，重新修复即可。
    if (items.some((item) => !Array.isArray(item?.pendingOccurrences))) return { status: 'idle', groups: [] };
    const outputPath = row.output_path ? path.join(getWorkspaceDir(app), row.output_path) : '';
    return {
      status: pick(row.status, RESULT_STATUSES, 'idle'),
      inputSignature: row.input_signature || undefined,
      fixRules: safeJsonParse(row.fix_rules_json, []),
      outputPath: outputPath && fs.existsSync(outputPath) ? outputPath : undefined,
      sourceBytes: Number(row.source_bytes || 0),
      outputBytes: Number(row.output_bytes || 0),
      fixes: safeJsonParse(row.fixes_json, {}),
      notes: safeJsonParse(row.notes_json, []),
      validation: safeJsonParse(row.validation_json, undefined),
      beforeSummary: safeJsonParse(row.before_summary_json, undefined),
      afterSummary: safeJsonParse(row.after_summary_json, undefined),
      afterStats: safeJsonParse(row.after_stats_json, undefined),
      error: row.error || undefined,
      updatedAt: row.updated_at || undefined,
      items,
      agent: safeJsonParse(row.agent_json, undefined),
      groups: db.prepare('SELECT * FROM blind_check_fix_groups ORDER BY sort_order ASC').all().map((group) => ({
        id: group.group_id,
        ruleId: group.rule_id,
        ruleTitle: group.rule_title,
        category: group.category,
        severity: group.severity,
        message: group.message,
        count: Number(group.finding_count || 0),
        samples: safeJsonParse(group.samples_json, []),
      })),
    };
  }

  function loadResult() {
    const row = db.prepare('SELECT * FROM blind_check_results WHERE id = 1').get();
    if (!row) return { status: 'idle', groups: [] };
    const groups = db.prepare('SELECT * FROM blind_check_finding_groups ORDER BY sort_order ASC').all().map((group) => ({
      id: group.group_id,
      ruleId: group.rule_id,
      ruleTitle: group.rule_title,
      category: group.category,
      severity: group.severity,
      message: group.message,
      candidate: Number(group.candidate) === 1,
      count: Number(group.finding_count || 0),
      samples: safeJsonParse(group.samples_json, []),
      items: safeJsonParse(group.items_json, []),
    }));
    return {
      status: pick(row.status, RESULT_STATUSES, 'idle'),
      inputSignature: row.input_signature || undefined,
      presetName: row.preset_name || undefined,
      summary: safeJsonParse(row.summary_json, undefined),
      stats: safeJsonParse(row.stats_json, undefined),
      ruleErrors: safeJsonParse(row.rule_errors_json, []),
      error: row.error || undefined,
      updatedAt: row.updated_at || undefined,
      groups,
    };
  }

  function fileFromMeta(meta) {
    if (!meta?.file_id || !meta.source_path) return null;
    return {
      id: meta.file_id,
      fileName: meta.file_name || '',
      size: Number(meta.file_size || 0),
      modifiedAt: meta.file_modified_at || '',
      importedAt: meta.imported_at || '',
    };
  }

  function loadBlindCheck() {
    const meta = db.prepare('SELECT * FROM blind_check_meta WHERE id = 1').get();
    if (!meta) throw new Error('暗标合规检查数据库尚未初始化');
    const result = loadResult();
    const review = loadReview();
    return {
      step: pick(meta.step, STEPS, 'upload'),
      presetId: resolvePreset(meta.preset_id).id,
      presetTab: pick(meta.preset_tab, PRESET_TABS, 'page'),
      resultTab: pick(meta.result_tab, RESULT_TABS, 'all'),
      useCredentialWords: Number(meta.use_credential_words) === 1,
      aiReviewEnabled: Number(meta.ai_review_enabled ?? 1) === 1,
      fixAiEnabled: Number(meta.fix_ai_enabled ?? 1) === 1,
      file: fileFromMeta(meta),
      result,
      review,
      // 最终问题清单是派生数据，不入库：检查成功且复核不在进行时按复核后的结论现算；复核失败或跳过时就是程序结果。
      issues: result.status === 'success' && review.status !== 'running' ? buildIssueList(result.groups, reviewForResult(result, review)) : [],
      checkTask: taskFromRow(db.prepare('SELECT * FROM blind_check_tasks WHERE type = ?').get(CHECK_TASK_TYPE), taskLogStore),
      fixRules: normalizeFixRules(safeJsonParse(meta.fix_rules_json, null)),
      fixResult: loadFixResult(),
      fixTask: taskFromRow(db.prepare('SELECT * FROM blind_check_tasks WHERE type = ?').get(FIX_TASK_TYPE), taskLogStore),
      extractionTask: taskFromRow(db.prepare('SELECT * FROM blind_check_tasks WHERE type = ?').get(EXTRACTION_TASK_TYPE), taskLogStore),
    };
  }

  const updateTransaction = db.transaction((partial) => {
    ensureMetaRow();
    const meta = {};
    if (hasOwn(partial, 'step')) meta.step = pick(partial.step, STEPS, 'upload');
    if (hasOwn(partial, 'presetTab')) meta.preset_tab = pick(partial.presetTab, PRESET_TABS, 'page');
    if (hasOwn(partial, 'resultTab')) meta.result_tab = pick(partial.resultTab, RESULT_TABS, 'all');
    if (Object.keys(meta).length) updateMeta(meta);
    if (hasOwn(partial, 'checkTask')) saveTask(CHECK_TASK_TYPE, partial.checkTask);
    if (hasOwn(partial, 'result')) saveResult(partial.result);
    if (hasOwn(partial, 'review')) saveReview(partial.review);
    if (hasOwn(partial, 'fixTask')) saveTask(FIX_TASK_TYPE, partial.fixTask);
    if (hasOwn(partial, 'fixResult')) saveFixResult(partial.fixResult);
    if (hasOwn(partial, 'extractionTask')) saveTask(EXTRACTION_TASK_TYPE, partial.extractionTask);
  });

  function updateBlindCheckWithoutReload(partial) {
    updateTransaction(partial || {});
  }

  function saveUiState({ step, presetTab, resultTab } = {}) {
    updateBlindCheckWithoutReload({ step, presetTab, resultTab });
  }

  function removeSourceFiles(keepFileName) {
    if (!fs.existsSync(sourceDir)) return;
    for (const name of fs.readdirSync(sourceDir)) {
      if (name !== keepFileName) fs.rmSync(path.join(sourceDir, name), { recursive: true, force: true });
    }
  }

  function removeFixedFiles(keepFileName) {
    if (!fs.existsSync(fixedDir)) return;
    for (const name of fs.readdirSync(fixedDir)) {
      if (name !== keepFileName) fs.rmSync(path.join(fixedDir, name), { recursive: true, force: true });
    }
  }

  /**
   * 导入待检文档：先复制到工作区，再取消正在运行的检查并提交，最后清理旧副本。
   * 检查只针对副本进行，用户原文件不会被改动或占用。
   */
  async function importFile(filePath, options = {}) {
    const originalPath = String(filePath || '').trim();
    if (path.extname(originalPath).toLowerCase() !== '.docx') {
      throw new Error('暗标合规检查仅支持 .docx，请先在 Word / WPS 中另存为 .docx');
    }
    const fileId = crypto.randomUUID();
    const storedName = `${fileId}.docx`;
    fs.mkdirSync(sourceDir, { recursive: true });
    const storedPath = path.join(sourceDir, storedName);
    let stats;
    try {
      stats = fs.statSync(originalPath);
      fs.copyFileSync(originalPath, storedPath);
    } catch (error) {
      fs.rmSync(storedPath, { force: true });
      if (error?.code === 'ENOENT') throw new Error(`找不到文件「${path.basename(originalPath)}」，可能已被移动或删除，请重新选择`);
      throw new Error(`无法读取「${path.basename(originalPath)}」，请关闭正在使用该文件的程序后重试（${error?.message || error}）`);
    }
    try {
      const contentHash = hashFile(storedPath);
      if (typeof options.beforeCommit === 'function') await options.beforeCommit();
      const transaction = db.transaction(() => {
        updateMeta({
          file_id: fileId,
          file_name: path.basename(originalPath),
          source_path: path.relative(getWorkspaceDir(app), storedPath).split(path.sep).join('/'),
          original_path: originalPath,
          file_size: stats.size,
          file_modified_at: stats.mtime.toISOString(),
          content_hash: contentHash,
          imported_at: now(),
        });
        saveTask(CHECK_TASK_TYPE, undefined);
        saveTask(FIX_TASK_TYPE, undefined);
        clearResultRows();
        clearFixRows();
      });
      transaction();
    } catch (error) {
      fs.rmSync(storedPath, { force: true });
      throw error;
    }
    removeSourceFiles(storedName);
    removeFixedFiles();
    return loadBlindCheck();
  }

  async function removeFile(options = {}) {
    if (typeof options.beforeCommit === 'function') await options.beforeCommit();
    const transaction = db.transaction(() => {
      updateMeta({
        file_id: null,
        file_name: null,
        source_path: null,
        original_path: null,
        file_size: 0,
        file_modified_at: null,
        content_hash: null,
        imported_at: null,
        step: 'upload',
      });
      saveTask(CHECK_TASK_TYPE, undefined);
      saveTask(FIX_TASK_TYPE, undefined);
      clearResultRows();
      clearFixRows();
    });
    transaction();
    removeSourceFiles();
    removeFixedFiles();
    return loadBlindCheck();
  }

  function userPresetFromRow(row) {
    return {
      id: row.preset_id,
      name: row.name,
      description: row.description || '',
      builtin: false,
      profile: normalizeProfile(safeJsonParse(row.profile_json, {})),
      source: safeJsonParse(row.source_json, undefined),
    };
  }

  function listPresets() {
    const rows = db.prepare('SELECT * FROM blind_check_presets ORDER BY sort_order ASC, created_at ASC').all();
    return [...listBuiltinPresets(), ...rows.map(userPresetFromRow)];
  }

  /** 取预设；已被删除或不存在时回退到通用预设。 */
  function resolvePreset(presetId) {
    const builtin = findBuiltinPreset(presetId);
    if (builtin) return builtin;
    const row = presetId ? db.prepare('SELECT * FROM blind_check_presets WHERE preset_id = ?').get(presetId) : null;
    return row ? userPresetFromRow(row) : findBuiltinPreset(DEFAULT_PRESET_ID);
  }

  function assertUserPreset(presetId) {
    if (findBuiltinPreset(presetId)) throw new Error('内置预设不能修改，请先复制为我的预设');
    const row = db.prepare('SELECT * FROM blind_check_presets WHERE preset_id = ?').get(presetId);
    if (!row) throw new Error('预设不存在，请刷新后重试');
    return row;
  }

  function createPreset({ name, basePresetId } = {}) {
    const base = resolvePreset(basePresetId);
    const presetId = `preset-${crypto.randomUUID()}`;
    const timestamp = now();
    const sortOrder = Number(db.prepare('SELECT MAX(sort_order) AS value FROM blind_check_presets').get()?.value ?? -1) + 1;
    const transaction = db.transaction(() => {
      db.prepare(`
        INSERT INTO blind_check_presets (preset_id, name, description, profile_json, sort_order, created_at, updated_at)
        VALUES (@preset_id, @name, @description, @profile_json, @sort_order, @timestamp, @timestamp)
      `).run({
        preset_id: presetId,
        name: String(name || '').trim() || uniquePresetName(`${base.name.replace(/（参考）$/, '')} 副本`),
        description: `基于「${base.name}」创建`,
        profile_json: JSON.stringify(base.profile),
        sort_order: sortOrder,
        timestamp,
      });
      updateMeta({ preset_id: presetId });
    });
    transaction();
    return resolvePreset(presetId);
  }

  /** 预设名不重复：重名时依次加"（2）""（3）"，总长不超过页面允许的长度。 */
  function uniquePresetName(baseName) {
    const names = new Set(listPresets().map((preset) => preset.name));
    const base = String(baseName || '').trim().slice(0, MAX_PRESET_NAME_LENGTH) || '招标文件格式要求';
    if (!names.has(base)) return base;
    for (let index = 2; ; index += 1) {
      const suffix = `（${index}）`;
      const name = `${base.slice(0, MAX_PRESET_NAME_LENGTH - suffix.length)}${suffix}`;
      if (!names.has(name)) return name;
    }
  }

  /**
   * AI 提取生成的预设：新建一份"我的预设"并选中，出处信息随预设保存，已有预设不覆盖。
   * 招标文件正文另存一份，AI 复核逐条对照招标原文时使用。
   */
  function createExtractedPreset({ tenderName, profile, source, tenderContent }) {
    const presetId = `preset-${crypto.randomUUID()}`;
    if (tenderContent) {
      fs.mkdirSync(tenderDir, { recursive: true });
      fs.writeFileSync(tenderPath(presetId), String(tenderContent), 'utf8');
    }
    const timestamp = now();
    const fieldCount = Object.keys(source?.fields || {}).length;
    const baseName = `${path.parse(String(tenderName || '招标文件')).name}（AI 提取）`;
    const sortOrder = Number(db.prepare('SELECT MAX(sort_order) AS value FROM blind_check_presets').get()?.value ?? -1) + 1;
    const transaction = db.transaction(() => {
      db.prepare(`
        INSERT INTO blind_check_presets (preset_id, name, description, profile_json, sort_order, created_at, updated_at, source_json)
        VALUES (@preset_id, @name, @description, @profile_json, @sort_order, @timestamp, @timestamp, @source_json)
      `).run({
        preset_id: presetId,
        name: uniquePresetName(baseName),
        description: `由 AI 从「${tenderName || '招标文件'}」提取 ${fieldCount} 项格式要求，请逐项核对`,
        profile_json: JSON.stringify(normalizeProfile(profile)),
        sort_order: sortOrder,
        timestamp,
        source_json: JSON.stringify(source || {}),
      });
      updateMeta({ preset_id: presetId });
    });
    transaction();
    return resolvePreset(presetId);
  }

  /** 技术方案招标文件的展示名：多份时显示份数。 */
  function technicalPlanTenderName(available) {
    const files = technicalPlanStore?.listTenderSourceFiles?.() || [];
    return files.length > 1 ? `${files.length} 份招标文件` : files[0]?.fileName || (available ? '技术方案招标文件' : '');
  }

  /** 招标文件来源：技术方案里是否已有解析好的招标文件。 */
  function getTenderSources() {
    const available = Boolean(technicalPlanStore?.readTenderMarkdown?.().trim());
    return { technicalPlan: { available, fileName: technicalPlanTenderName(available) } };
  }

  function readTechnicalPlanTender() {
    const content = String(technicalPlanStore?.readTenderMarkdown?.() || '');
    if (!content.trim()) throw new Error('技术方案中暂无招标文件，请先在技术方案中上传招标文件，或选择招标文件');
    return { fileName: technicalPlanTenderName(true), content };
  }

  function parseTenderFile(filePath) {
    if (!fileService?.parseBlindCheckTender) throw new Error('文件解析服务尚未初始化');
    return fileService.parseBlindCheckTender(filePath);
  }

  function updatePreset(presetId, patch = {}) {
    const row = assertUserPreset(presetId);
    db.prepare(`
      UPDATE blind_check_presets
      SET name = @name, description = @description, profile_json = @profile_json, updated_at = @updated_at
      WHERE preset_id = @preset_id
    `).run({
      preset_id: presetId,
      name: hasOwn(patch, 'name') ? String(patch.name || '').trim() || row.name : row.name,
      description: hasOwn(patch, 'description') ? String(patch.description || '').trim() : row.description,
      profile_json: JSON.stringify(hasOwn(patch, 'profile') ? normalizeProfile(patch.profile) : normalizeProfile(safeJsonParse(row.profile_json, {}))),
      updated_at: now(),
    });
    return resolvePreset(presetId);
  }

  function deletePreset(presetId) {
    assertUserPreset(presetId);
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM blind_check_presets WHERE preset_id = ?').run(presetId);
      const meta = ensureMetaRow();
      if (meta.preset_id === presetId) updateMeta({ preset_id: DEFAULT_PRESET_ID });
    });
    transaction();
    fs.rmSync(tenderPath(presetId), { force: true });
    return listPresets();
  }

  /** 预设对应的招标文件正文；内置预设、手工预设和早期提取的预设没有。 */
  function readPresetTender(presetId) {
    const filePath = tenderPath(presetId);
    if (!fs.existsSync(filePath)) return null;
    const preset = resolvePreset(presetId);
    return { fileName: preset.source?.tenderName || '招标文件', content: fs.readFileSync(filePath, 'utf8') };
  }

  /** 记住本次检查、修复是否带 AI，作为下次弹窗的默认选项。 */
  function setAiReviewEnabled(enabled) {
    updateMeta({ ai_review_enabled: enabled ? 1 : 0 });
  }

  function setFixAiEnabled(enabled) {
    updateMeta({ fix_ai_enabled: enabled ? 1 : 0 });
  }

  function selectPreset(presetId) {
    updateMeta({ preset_id: resolvePreset(presetId).id });
    return loadBlindCheck();
  }

  function setUseCredentialWords(enabled) {
    updateMeta({ use_credential_words: enabled ? 1 : 0 });
    return loadBlindCheck();
  }

  /** 资信库里可识别本单位的信息，按字段列出供页面展示，同时作为检查时的敏感词。 */
  function getCredentialWords() {
    const profile = credentialLibraryService?.load?.().profile || {};
    const words = [];
    for (const [field, label] of CREDENTIAL_FIELDS) {
      const value = String(profile[field] || '').trim();
      if (value.length < 2) continue;
      words.push({ label, value });
      if (field === 'companyName' && companyShortName(value)) words.push({ label: '企业简称', value: companyShortName(value) });
    }
    return words;
  }

  /** 组装一次检查的输入：工作区内的文档副本、规范后的预设和敏感词，以及输入签名。 */
  function prepareCheckInput() {
    const meta = ensureMetaRow();
    const preset = resolvePreset(meta.preset_id);
    const sensitiveWords = [
      ...preset.profile.privacy.keywords.map((text) => ({ text, source: 'custom' })),
      ...(Number(meta.use_credential_words) === 1 ? getCredentialWords().map((item) => ({ text: item.value, source: 'credential' })) : []),
    ];
    // 预设 ID 代表招标依据：复核对照的招标原文和出处随预设保存、不会替换，格式配置相同的两份预设也要区分。
    const signature = meta.content_hash
      ? crypto.createHash('sha1')
        .update(String(meta.content_hash))
        .update('\0').update(preset.id)
        .update('\0').update(JSON.stringify(preset.profile))
        .update('\0').update(JSON.stringify(sensitiveWords))
        .digest('hex')
      : null;
    return {
      source: meta.source_path || '',
      sourcePath: meta.source_path ? path.join(getWorkspaceDir(app), meta.source_path) : '',
      fileName: meta.file_name || '',
      presetId: preset.id,
      presetName: preset.name,
      presetSource: preset.source,
      profile: preset.profile,
      sensitiveWords,
      signature,
    };
  }

  function getInputSignature() {
    return prepareCheckInput().signature;
  }

  function saveFixRules(rules) {
    updateMeta({ fix_rules_json: JSON.stringify(normalizeFixRules(rules)) });
    return loadBlindCheck();
  }

  /** 修复输入：在检查输入之上加勾选的修复项和副本路径；副本按文档 ID 命名，重新修复时覆盖。 */
  function prepareFixInput() {
    const meta = ensureMetaRow();
    const output = meta.file_id ? `blind-check/fixed/${meta.file_id}.docx` : '';
    return {
      ...prepareCheckInput(),
      fixRules: normalizeFixRules(safeJsonParse(meta.fix_rules_json, null)),
      output,
      outputPath: output ? path.join(getWorkspaceDir(app), output) : '',
    };
  }

  /** 当前可导出的修复副本：修复成功、检查条件未变化且文件仍在。 */
  function getFixedDocument() {
    const meta = ensureMetaRow();
    const result = loadFixResult();
    if (result.status !== 'success' || !result.outputPath || result.inputSignature !== getInputSignature()) return null;
    return { path: result.outputPath, fileName: meta.file_name || '修复副本.docx', originalPath: meta.original_path || '' };
  }

  function removeStaleFixedFiles() {
    const output = prepareFixInput().output;
    removeFixedFiles(output ? path.basename(output) : undefined);
  }

  function clearBlindCheck() {
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM blind_check_tasks').run();
      clearResultRows();
      clearFixRows();
      db.prepare('DELETE FROM task_logs WHERE task_domain = ?').run(TASK_DOMAIN);
      updateMeta({
        step: 'upload',
        result_tab: 'all',
        file_id: null,
        file_name: null,
        source_path: null,
        original_path: null,
        file_size: 0,
        file_modified_at: null,
        content_hash: null,
        imported_at: null,
      });
    });
    transaction();
    if (fs.existsSync(blindCheckDir)) fs.rmSync(blindCheckDir, { recursive: true, force: true });
    fs.mkdirSync(sourceDir, { recursive: true });
    return loadBlindCheck();
  }

  fs.mkdirSync(sourceDir, { recursive: true });
  ensureMetaRow();

  return {
    loadBlindCheck,
    updateBlindCheckWithoutReload,
    saveUiState,
    importFile,
    removeFile,
    listPresets,
    createPreset,
    updatePreset,
    deletePreset,
    selectPreset,
    setUseCredentialWords,
    setAiReviewEnabled,
    setFixAiEnabled,
    readPresetTender,
    getCredentialWords,
    prepareCheckInput,
    getInputSignature,
    saveFixRules,
    createExtractedPreset,
    getTenderSources,
    readTechnicalPlanTender,
    parseTenderFile,
    prepareFixInput,
    getFixedDocument,
    removeStaleFixedFiles,
    clearBlindCheck,
  };
}

module.exports = {
  createBlindCheckStore,
};
