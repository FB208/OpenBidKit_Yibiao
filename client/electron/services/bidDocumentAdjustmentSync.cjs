const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { load } = require('cheerio');
const { adjustmentSections, CONTENT_TASK_KEY } = require('./bidDocumentAdjustmentContext.cjs');
const { countHtmlWords } = require('./contentGenerationWordTools.cjs');
const { convertContentSections } = require('./contentGenerationOutput.cjs');
const { findHtmlStructureIssues } = require('../utils/htmlStructure.cjs');
const { renderBusinessTemplate, summarizeFillStats, loadBusinessFillScope } = require('./businessTemplateFillTask.cjs');

// 内容指纹也覆盖图片字节；不保存正式文件的副本。
function fileHash(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

// 目录结构指纹：节点集合、层级、标题、描述和处理方式，不含同级顺序（与 Store 排序不失效的口径一致）。
function outlineStructureKey(items = [], parent = '') {
  return items.flatMap(item => [
    { id: item.id, parent, title: item.title || '', description: item.description || '',
      content_mode: item.content_mode || '', rule_basis: item.rule_basis || '' },
    ...outlineStructureKey(item.children, item.id),
  ]);
}

// 读取当前正式状态和引用资源，给提交、异常收尾及中断恢复共用。
function captureAdjustmentState(workspaceStore, agentService) {
  const plan = workspaceStore.loadTechnicalPlan();
  const bodyDir = agentService.loadPersistentTask(CONTENT_TASK_KEY)?.paths.workspaceDir;
  const files = {};
  const sections = adjustmentSections(plan.outlineData?.outline);
  for (const section of sections.filter(item => item.content_mode === 'ai-generate')) {
    if (!bodyDir) continue;
    const file = path.join(bodyDir, section.file);
    files[file] = fileHash(file);
    if (!files[file]) continue;
    const $ = load(fs.readFileSync(file, 'utf8'), null, false);
    for (const element of $('img').toArray()) {
      const ref = $(element).attr('data-yb-asset-ref');
      if (ref) files[path.resolve(bodyDir, ref)] = fileHash(path.resolve(bodyDir, ref));
    }
  }
  const projectDir = workspaceStore.getContentWordOutputDir();
  const business = ['bid-template-blank.docx', 'bid-template-base.docx', 'bid-template-fields.json', 'rule-page-tables.json'];
  for (const file of business) files[path.join(projectDir, file)] = fileHash(path.join(projectDir, file));
  const outlineStructure = JSON.stringify(outlineStructureKey(plan.outlineData?.outline).sort((a, b) => a.id.localeCompare(b.id)));
  return { files, outline: JSON.stringify(plan.outlineData), outlineStructure, facts: JSON.stringify(plan.globalFacts), bodyDir, sections };
}

// 只刷新受影响派生产物；保存最新 Store 状态，不复写启动时的业务快照。
async function synchronizeAdjustment({ workspaceStore, agentService, openXmlHelperService, credentialLibraryService,
  before, signal, checkpointTask, onActivity, onOutlineStructureChanged, convert = true }) {
  signal.throwIfAborted();
  const after = captureAdjustmentState(workspaceStore, agentService);
  const changed = new Set([...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter(file => before.files[file] !== after.files[file]));
  const outlineChanged = before.outline !== after.outline;
  if (!changed.size && !outlineChanged && before.facts === after.facts) return { snapshot: after, changedNodeIds: [] };
  // 目录结构变化使规则和页码失效，变为待编制，由调整结束后的重新编制补齐；仅排序不失效。
  // 立即回调登记，后续格式检查抛错时调整任务仍会安排重新编制。
  if (before.outlineStructure !== undefined && before.outlineStructure !== after.outlineStructure) {
    if (workspaceStore.readRulePageTables() || workspaceStore.loadTechnicalPlan().contentGenerationRuntime?.rule_page) {
      workspaceStore.invalidateRulePage();
    }
    onOutlineStructureChanged?.();
  }
  const plan = workspaceStore.loadTechnicalPlan();
  const revision = crypto.randomUUID();
  const runtime = { ...(plan.contentGenerationRuntime || {}), section_words: { ...(plan.contentGenerationRuntime?.section_words || {}) },
    content_revision: revision, updated_at: new Date().toISOString() };
  const states = { ...plan.contentGenerationSections };
  const changedSections = after.sections.filter(section => {
    if (section.content_mode !== 'ai-generate' || !after.bodyDir) return false;
    const file = path.join(after.bodyDir, section.file);
    if (changed.has(file)) return true;
    if (!fs.existsSync(file)) return false;
    const $ = load(fs.readFileSync(file, 'utf8'), null, false);
    return $('img').toArray().some(element => {
      const ref = $(element).attr('data-yb-asset-ref');
      return ref && changed.has(path.resolve(after.bodyDir, ref));
    });
  });
  const targets = [];
  const formatIssues = [];
  for (const section of changedSections) {
    const issueStart = formatIssues.length;
    const file = path.join(after.bodyDir, section.file);
    const html = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!html.trim() && before.files[file]) formatIssues.push(`${section.number} ${section.title}：正文已删除但目录仍引用该小节`);
    if (html.trim()) {
      formatIssues.push(...findHtmlStructureIssues(html, { checkSourceCompleteness: true }).map(issue => `${section.number} ${section.title}：${issue}`));
      const $ = load(html, null, false);
      for (const element of $('img').toArray()) {
        const ref = $(element).attr('data-yb-asset-ref');
        if (!ref || !fs.existsSync(path.resolve(after.bodyDir, ref))) formatIssues.push(`${section.number} ${section.title}：图片引用不存在 ${ref || ''}`);
      }
    }
    // 新增后尚未写正文的小节保持待生成；正文被删除或格式有问题时记为失败。
    if (html.trim()) runtime.section_words[section.id] = countHtmlWords(html);
    else delete runtime.section_words[section.id];
    const sectionIssues = formatIssues.slice(issueStart);
    states[section.id] = { ...states[section.id], id: section.id, content: section.content || '',
      status: sectionIssues.length ? 'error' : html.trim() ? 'success' : 'idle',
      error: sectionIssues.join('；') || undefined, updated_at: runtime.updated_at };
    if (html.trim()) targets.push({ section_id: section.id, number: section.number, title: section.title,
      file: section.file, words: runtime.section_words[section.id] });
  }
  const currentIds = new Set(after.sections.map(section => section.id));
  const aiIds = new Set(after.sections.filter(section => section.content_mode === 'ai-generate').map(section => section.id));
  for (const id of Object.keys(runtime.section_words)) if (!aiIds.has(id)) delete runtime.section_words[id];
  for (const id of Object.keys(states)) if (!currentIds.has(id)) delete states[id];
  const changedIds = new Set(changedSections.map(section => section.id));
  if (runtime.html_output) runtime.html_output = { ...runtime.html_output,
    word_sections: (runtime.html_output.word_sections || []).filter(item => aiIds.has(item.section_id) && !changedIds.has(item.section_id)) };
  // 先使旧预览与转换记录失效，回填或转换出错时界面也不会继续使用旧版本。
  const publish = () => {
    const previousTask = workspaceStore.loadTechnicalPlan().contentGenerationTask;
    const contentTask = previousTask?.stats?.content ? { ...previousTask, stats: { ...previousTask.stats,
      content: { ...previousTask.stats.content, current_words: Object.values(runtime.section_words).reduce((sum, words) => sum + words, 0),
        preview_ready_section_ids: Object.entries(states).filter(([, item]) => item.status === 'success').map(([id]) => id),
        ...(runtime.html_output ? { word_conversion_completed: runtime.html_output.word_sections.length } : {}),
        business_fill: runtime.business_fill, rule_page: runtime.rule_page,
      } } } : previousTask;
    const patch = { contentGenerationRuntime: runtime, contentGenerationSections: states,
      ...(contentTask ? { contentGenerationTask: contentTask } : {}) };
    checkpointTask({}, patch, { technicalPlanPatch: { ...patch, outlineData: plan.outlineData, globalFacts: plan.globalFacts,
      bidTemplateExists: plan.bidTemplateExists, bidTemplateChapterIds: plan.bidTemplateChapterIds } });
  };
  publish();
  if (convert && formatIssues.length) throw new Error(formatIssues.join('\n'));
  if (workspaceStore.hasBidTemplate() && (outlineChanged || [...changed].some(file => path.dirname(file) === workspaceStore.getContentWordOutputDir()))) {
    await renderBusinessTemplate({ workspaceStore, credentialLibraryService, openXmlHelperService,
      fields: workspaceStore.readBidTemplateFields().fields || [], signal });
    signal.throwIfAborted();
    const scope = await loadBusinessFillScope({ workspaceStore, openXmlHelperService, signal });
    runtime.business_fill = { ...runtime.business_fill, ...summarizeFillStats(scope.fields), phase: 'completed', updated_at: runtime.updated_at };
    const rules = workspaceStore.readRulePageTables();
    if (rules) runtime.rule_page = { ...runtime.rule_page, phase: 'completed', status: 'success', error: null,
      table_count: rules.tables?.length || 0,
      row_count: (rules.tables || []).reduce((sum, table) => sum + (table.rows?.length || 0), 0), updated_at: runtime.updated_at };
    else if (runtime.rule_page) runtime.rule_page = undefined;
    publish();
  }
  if (convert && targets.length) {
    await convertContentSections({ result: { workspaceDir: after.bodyDir, sections: targets },
      outputDir: workspaceStore.getContentWordOutputDir(), openXmlHelperService, signal, onActivity,
      onProgress(items) {
        runtime.html_output = { ...runtime.html_output, workspace_dir: after.bodyDir,
          word_output_dir: workspaceStore.getContentWordOutputDir(),
          word_sections: [...(runtime.html_output?.word_sections || []).filter(item => !changedIds.has(item.section_id)), ...items] };
        publish();
      } });
  }
  return { snapshot: captureAdjustmentState(workspaceStore, agentService), changedNodeIds: [...changedIds], revision };
}

module.exports = { captureAdjustmentState, synchronizeAdjustment };
