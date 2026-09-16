// 在 client 目录执行：node scripts/check-original-restore.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, Module } = require('node:module');
const restoration = require('../electron/services/originalPlanRestoration.cjs');
const { countReadableWords } = require('../electron/utils/wordCount.cjs');
const taskFile = path.resolve(__dirname, '../electron/services/contentGenerationTask.cjs');
const taskSource = fs.readFileSync(taskFile, 'utf8');
const context = { module: { exports: {} }, require: createRequire(taskFile) };
vm.runInNewContext(`${taskSource}\nmodule.exports = {
  normalizeOriginalMaterial, parseAgentJsonContent, textMetrics, now,
  formatRestoreTargetsForPrompt, formatBidKeyInfoForPrompt, normalizeLeafContentForSave,
  withSection, updateOutlineItemContent, pruneContentGenerationPlans, createStoredContentPlan,
  normalizeContentGenerationRuntime, CONTENT_PHASE_LABELS, createContentGenerationPausedError,
  buildChapterContentMessages, buildRestoredChapterContentMessages,
  buildAgentRestoredChapterContentPrompt, buildAgentRestoredChapterContentFiles,
};`, context, { filename: taskFile });

// 跨小节来源可重叠，单节范围有序，长表格完整保留，拒绝遗漏和改写。
function checkSourceValidation() {
  const source = restoration.createOriginalSource('项目背景\r\n实施内容😀\r\n<table>\r\n<tr><td>' + '参数'.repeat(4000) + '</td></tr>\r\n</table>\r\n签章');
  const range = (start_line, end_line) => ({ start_line, end_line });
  const assignment = (node_id, start, end) => ({ node_id, source_ranges: [range(start, end)], heading_edits: [], content: restoration.readOriginalRange(source, range(start, end)) });
  const result = { assignments: [assignment('1', 1, 2), assignment('2', 3, 5)], unassigned: [{ ...range(6, 6), reason: '签章栏' }] };
  const validation = { source, allowedNodeIds: new Set(['1', '2']) };
  restoration.validateOriginalRestoration(result, validation);
  const invalid = change => {
    const copy = structuredClone(result);
    change(copy);
    return () => restoration.validateOriginalRestoration(copy, validation);
  };
  const overlapping = structuredClone(result);
  overlapping.assignments[1].source_ranges.unshift(range(2, 2));
  overlapping.assignments[1].content = restoration.restoredAssignmentContent(source, overlapping.assignments[1]);
  restoration.validateOriginalRestoration(overlapping, validation);
  assert.throws(invalid(value => value.assignments[0].source_ranges.push(range(2, 2))), /按原文顺序/);
  assert.throws(invalid(value => value.assignments[1].source_ranges[0].start_line = 4), /表格被切断/);
  assert.throws(invalid(value => value.assignments[0].content += '额外扩写'), /逐字复制/);
  assert.throws(invalid(value => value.assignments[0].node_id = '未知节点'), /ID 无效/);
  assert.throws(invalid(value => value.unassigned = []), /未交代去向/);
  assert.throws(invalid(value => value.unassigned[0].reason = ''), /说明原因/);
  restoration.validateOriginalRestoration(result, { ...validation, coveredRanges: [{ ...range(1, 2), node_id: '已有章节' }] });
  assert.throws(invalid(value => value.unassigned.push({ ...range(2, 2), reason: '未采用' })), /已覆盖/);
  assert.throws(invalid(value => value.assignments.push(value.assignments[0])), /ID 无效或重复/);
  const markdownTable = restoration.createOriginalSource('| 名称 | 参数 |\n| --- | --- |\n| 设备 | 内容 |');
  assert.throws(() => restoration.validateOriginalRestoration({ assignments: [{ node_id: '1', source_ranges: [range(1, 2)], heading_edits: [], content: '' }], unassigned: [] }, { source: markdownTable, allowedNodeIds: new Set(['1']) }), /表格被切断/);
  const stats = restoration.calculateOriginalRestoration(source, [range(1, 5)], 'hash');
  assert.equal(stats.total_words, countReadableWords(source.content));
  assert.equal(stats.restored_words, countReadableWords(result.assignments.map(item => item.content).join('\n\n')));
  assert.deepEqual(restoration.calculateOriginalRestoration(source, overlapping.assignments.flatMap(item => item.source_ranges), 'hash'), stats);
  assert.equal(restoration.calculateOriginalRestoration(source, [range(1, 6)], 'hash').rate, 100);
  assert.equal(restoration.calculateOriginalRestoration(source, [], 'hash').rate, 0);
  assert.equal(restoration.calculateOriginalRestoration(restoration.createOriginalSource(''), [], 'hash').rate, null);
}

// 单列表格支持对齐标记，完整回填通过，拆到不同小节或未还原范围均须拒绝。
function checkSingleColumnTables() {
  for (const divider of ['---', ':---', '---:', ':---:']) {
    for (const [left, right] of [['| ', ' |'], ['| ', ''], ['', ' |']]) {
      const source = restoration.createOriginalSource(
        `${left}标题${right}\n${left}${divider}${right}\n${left}内容${right}\n${left}补充内容${right}`);
      assert.deepEqual(source.tables, [{ start_line: 1, end_line: 4 }]);
      const assignment = (node_id, start_line, end_line) => ({
        node_id, source_ranges: [{ start_line, end_line }], heading_edits: [],
        content: restoration.readOriginalRange(source, { start_line, end_line }),
      });
      const validation = { source, allowedNodeIds: new Set(['1', '2']) };
      restoration.validateOriginalRestoration({ assignments: [assignment('1', 1, 4)], unassigned: [] }, validation);
      assert.throws(() => restoration.validateOriginalRestoration({
        assignments: [assignment('1', 1, 2), assignment('2', 3, 4)], unassigned: [],
      }, validation), /表格被切断/);
      assert.throws(() => restoration.validateOriginalRestoration({
        assignments: [assignment('1', 3, 4)], unassigned: [{ start_line: 1, end_line: 2, reason: '表头' }],
      }, validation), /表格被切断/);
    }
  }
  for (const text of ['普通标题\n---\n正文', '| 普通文字 |\n---\n正文', '\n| --- |\n正文']) {
    assert.deepEqual(restoration.createOriginalSource(text).tables, [], '普通分隔线或没有表头时不应识别为表格');
  }
  assert.deepEqual(restoration.createOriginalSource('标题 | 参数\n--- | ---\n内容 | 数值').tables,
    [{ start_line: 1, end_line: 3 }], '保留无首尾竖线的多列表格识别');
  console.log('单列表格：对齐标记、完整回填、拆分拒绝及普通分隔线检查通过。');
}

// 执行正式保存、来源读取与还原函数，覆盖暂停续跑、失败和无原方案短路。
async function checkOriginalRestore() {
  for (const mode of ['success', 'partial', 'failure', 'pause', 'invalid-recovered-output']) {
    const targetMarkdown = '# 实施方案\n原文内容\n<table><tr><td>参数</td></tr></table>';
    const originalPlanMarkdown = targetMarkdown + (mode === 'partial' ? '\n![已覆盖图片](yibiao-asset://imported-images/方案/现场.png)' : '');
    const originalSource = restoration.createOriginalSource(originalPlanMarkdown);
    const target = { item: { id: '1', title: '实施方案' } };
    const existing = { item: { id: '2', title: '现场服务' } };
    const existingContent = originalSource.lines.slice(1).join('\n');
    const existingPlan = { original_material: { restored: true, optimized: false, source_hash: 'hash', source_ranges: [{ start_line: 2, end_line: 4 }] } };
    const saved = [];
    let calls = 0;
    const scope = {
      ...context.module.exports, ...restoration, countReadableWords,
      hasOriginalPlan: true, originalPlanMarkdown, originalSource, originalPlanSourceHash: 'hash',
      leaves: mode === 'partial' ? [target, existing] : [target],
      sections: mode === 'partial' ? { '2': { status: 'success', content: existingContent } } : {},
      outlineData: { outline: [target.item] },
      contentPlans: new Map(mode === 'partial' ? [['2', existingPlan]] : []), storedContentPlans: {},
      completedStages: new Set(), contentStats: {}, logs: [], tableRequirement: 'none',
      projectOverview: '', bidAnalysisFactsText: '', globalFactTitlesText: '',
      getStoredContentPlan: () => null,
      getContentPlanForItem: () => ({ writing_focus: '实施方案', image_needed: true, image_suitability_score: 10 }),
      runContentAgentTask: async options => {
        calls += 1;
        assert.equal(options.files.find(file => file.path === 'original-plan.md').content, originalPlanMarkdown);
        assert.ok(!options.files.some(file => file.path === 'original-segments.md'));
        assert.ok(!options.files.some(file => file.path === 'reserved-ranges.json'));
        const coveredRanges = JSON.parse(options.files.find(file => file.path === 'covered-ranges.json').content);
        assert.equal(coveredRanges.length, mode === 'partial' ? 1 : 0);
        if (mode === 'failure') throw new Error('Agent 失败');
        const result = { assignments: [{ node_id: '1', source_ranges: [{ start_line: 1, end_line: 3 }], heading_edits: [{ line: 1, content: '**实施方案**' }], content: targetMarkdown.replace('# 实施方案', '**实施方案**') }], unassigned: [] };
        if (mode === 'invalid-recovered-output') result.assignments[0].content = '压缩摘要';
        const outputContent = JSON.stringify(result);
        if (mode !== 'invalid-recovered-output') options.validateOutput({ output_content: outputContent });
        return { outputContent, agentResult: {} };
      },
      pauseIfRequested() { if (mode === 'pause') throw new Error('已暂停'); },
      writeDeveloperLog() {}, updateContentWordCount() {},
      checkpointTask(task, patch) {
        if (patch?.contentGenerationItem) saved.push(patch.contentGenerationItem);
        if (task.stats?.original_restoration) assert.equal(saved.length, 1, '必须先保存再统计');
      },
      syncRuntime: () => ({}), statsSnapshot: () => ({ ...scope.contentStats }), progressFor: () => 0,
    };
    const stateStart = taskSource.indexOf('  function getOriginalMaterialRuntimeState(');
    const saveEnd = taskSource.indexOf('  // 只更新本轮目标', stateStart);
    const statsStart = taskSource.indexOf('  function updateOriginalRestorationStats(');
    const restoreEnd = taskSource.indexOf('  async function prepareSingleSectionPlan(', statsStart);
    vm.createContext(scope);
    vm.runInContext(taskSource.slice(stateStart, saveEnd) + taskSource.slice(statsStart, restoreEnd), scope);
    if (mode === 'success' || mode === 'partial') {
      await scope.restoreOriginalMaterialsIfNeeded([target]);
      assert.equal(saved[0].section.content, targetMarkdown.replace('# 实施方案', '**实施方案**'), '保存调整后的内部标题并完整保留表格');
      assert.equal(saved[0].storedPlan.plan.image_needed, true);
      assert.equal(saved[0].storedPlan.plan.original_material.source_ranges[0].end_line, 3);
      assert.equal(scope.contentStats.original_restoration.rate, 100);
      if (mode === 'partial') {
        assert.equal(scope.sections['2'].content, existingContent, '部分还原不改写其他小节');
        assert.equal(scope.contentStats.original_restoration.restored_images, 1, '其他小节已覆盖图片不必重新分配');
      }
      assert.equal(scope.getOriginalMaterialRuntimeState(target.item).needsOptimization, true);
      scope.completedStages.add('restoring');
      scope.sections['1'].content = '已经扩写的正文';
      await scope.restoreOriginalMaterialsIfNeeded([target]);
      assert.equal(calls, 1, '完成阶段继续执行不得重跑还原');
      assert.equal(scope.sections['1'].content, '已经扩写的正文');
    } else {
      await assert.rejects(scope.restoreOriginalMaterialsIfNeeded([target]), /失败|暂停|逐字复制/);
      assert.equal(saved.length, 0);
    }
    scope.hasOriginalPlan = false;
    scope.leaves = new Proxy([], { get() { assert.fail('没有原方案不得扫描目录'); } });
    scope.contentPlans = new Proxy(new Map(), { get() { assert.fail('没有原方案不得扫描记录'); } });
    assert.equal(scope.getOriginalMaterialRuntimeState(target.item).needsOptimization, false);
    scope.updateOriginalRestorationStats();
    await scope.restoreOriginalMaterialsIfNeeded([target]);
    assert.equal(calls, 1);
  }
}

// 接受 Agent 的标题处理结果；原图在还原、扩写保存和整篇审计中均不能丢失或重复。
function checkHeadingsAndImages() {
  const first = 'yibiao-asset://imported-images/方案/image-1.png';
  const second = 'yibiao-asset://imported-images/方案/image-2.png';
  const raw = `2.2所投核心产品检测报告\n![第一页](${first})\n![第二页](${second})`;
  const source = restoration.createOriginalSource(raw);
  const assignment = { node_id: '15.4.4', source_ranges: [{ start_line: 1, end_line: 3 }], heading_edits: [{ line: 1, content: '**15.4.4.1 所投核心产品检测报告**' }], content: raw.replace('2.2所投核心产品检测报告', '**15.4.4.1 所投核心产品检测报告**') };
  const input = { source, allowedNodeIds: new Set(['15.4.4']) };
  restoration.validateOriginalRestoration({ assignments: [assignment], unassigned: [] }, input);
  const shared = { ...assignment, node_id: '15.5.1' };
  restoration.validateOriginalRestoration({ assignments: [assignment, shared], unassigned: [] }, { ...input, allowedNodeIds: new Set([assignment.node_id, shared.node_id]) });
  const stats = restoration.calculateOriginalRestoration(source, assignment.source_ranges, 'hash');
  assert.equal(stats.total_images, 2);
  assert.equal(stats.restored_images, 2);
  assert.deepEqual(restoration.calculateOriginalRestoration(source, [...assignment.source_ranges, ...shared.source_ranges], 'hash'), stats);
  assert.throws(() => restoration.validateOriginalRestoration({ assignments: [], unassigned: [{ start_line: 1, end_line: 3, reason: '不要图片' }] }, input), /图片不得遗漏/);
  assert.throws(() => restoration.validateOriginalRestoration({ assignments: [{ ...assignment, content: assignment.content.replace('报告', '新报告') }], unassigned: [] }, input), /逐字复制/);
  assert.throws(() => restoration.validateOriginalRestoration({ assignments: [{ ...assignment, heading_edits: [...assignment.heading_edits, { line: 2, content: '' }] }], unassigned: [] }, input), /独立文字标题/);
  const item = { id: '15.4.4', title: '产品技术支持材料' };
  const section = { status: 'success', content: assignment.content };
  const plan = { original_material: { source_hash: 'hash', source_ranges: assignment.source_ranges } };
  const scope = { ...context.module.exports, ...restoration,
    hasOriginalPlan: true, originalSource: source, originalPlanSourceHash: 'hash',
    contentPlans: new Map([[item.id, plan]]), sections: { [item.id]: section },
    outlineData: { outline: [item] }, getStoredContentPlan: () => null,
  };
  const start = taskSource.indexOf('  function validateSectionOriginalImages(');
  const end = taskSource.indexOf('  function getStoredContentPlan(', start);
  const auditStart = taskSource.indexOf('  function validateAgentConsistencySections(');
  const auditEnd = taskSource.indexOf('  function applyAgentConsistencySections(', auditStart);
  vm.createContext(scope);
  vm.runInContext(taskSource.slice(start, end) + taskSource.slice(auditStart, auditEnd), scope);
  scope.validateSectionOriginalImages(item.id, assignment.content + '\n补充说明');
  const bad = `![第一页](${first})`;
  assert.throws(() => scope.saveSection(item, { content: bad }, bad), /图片遗漏/);
  assert.equal(scope.sections[item.id], section, '拒绝保存之前不能修改内存正文');
  assert.throws(() => scope.validateSectionOriginalImages(item.id, assignment.content + `\n![重复](${first})`), /图片遗漏、重复/);
  assert.throws(() => scope.validateAgentConsistencySections(new Map([[item.id, bad]]), new Map([[item.id, { originalContent: assignment.content }]])), /图片遗漏/);
  scope.hasOriginalPlan = false;
  scope.validateSectionOriginalImages(item.id, '没有原方案时不做图片检查');
}

// 标题由 Agent 决定去留和编号，校验只核对声明范围及非标题内容。
function checkAgentHeadingEdits() {
  for (const [original, edited] of [
    ['2024年施工计划', '**2024年施工计划**'], ['3D建模方案', '**3D建模方案**'],
    ['2.2所投核心产品检测报告', '**15.4.4.1 所投核心产品检测报告**'],
    ['## **（二）检测报告**', '**15.4.4.2 检测报告**'], ['**3\\. 物力投入计划**', ''],
  ]) {
    const source = restoration.createOriginalSource(`${original}\n工期为30天。`);
    const assignment = { node_id: '15.4.4', source_ranges: [{ start_line: 1, end_line: 2 }],
      heading_edits: [{ line: 1, content: edited }], content: edited ? `${edited}\n工期为30天。` : '工期为30天。' };
    const input = { source, allowedNodeIds: new Set(['15.4.4']) };
    restoration.validateOriginalRestoration({ assignments: [assignment], unassigned: [] }, input);
    assert.equal(restoration.restoredAssignmentContent(source, assignment), assignment.content);
    assert.throws(() => restoration.validateOriginalRestoration({ assignments: [{ ...assignment, content: assignment.content.replace('30天', '60天') }], unassigned: [] }, input), /逐字复制/);
    assert.throws(() => restoration.restoredAssignmentContent(source, { ...assignment, heading_edits: [assignment.heading_edits[0], assignment.heading_edits[0]] }), /标题行无效/);
    assert.throws(() => restoration.restoredAssignmentContent(source, { ...assignment, heading_edits: [{ line: 3, content: edited }] }), /标题行无效/);
    assert.throws(() => restoration.restoredAssignmentContent(source, { ...assignment, heading_edits: [{ line: 1, content: '标题\n额外正文' }] }), /单行文字/);
  }
  const table = restoration.createOriginalSource('| 标题 |\n| --- |\n| 内容 |');
  assert.throws(() => restoration.restoredAssignmentContent(table, {
    source_ranges: [{ start_line: 1, end_line: 3 }], heading_edits: [{ line: 1, content: '' }],
  }), /位于表格中/);
  assert.throws(() => restoration.restoredAssignmentContent(restoration.createOriginalSource('标题'), {
    source_ranges: [{ start_line: 1, end_line: 1 }], heading_edits: [{ line: 1, content: '**标题**' }],
  }), /仅有标题/);

  const args = { chapter: { id: '15.4.4', title: '产品技术支持材料' }, wordControl: {}, restoredContent: '**15.4.4.1 检测报告**\n原文' };
  const ordinary = context.module.exports.buildChapterContentMessages(args).map(message => message.content).join('\n');
  const expanded = context.module.exports.buildRestoredChapterContentMessages(args).map(message => message.content).join('\n');
  const agentPrompt = context.module.exports.buildAgentRestoredChapterContentPrompt();
  assert.ok(ordinary.includes('加粗引导语只允许写简短主题词，禁止使用任何形式的编号。'), '普通生成规则保持不变');
  for (const prompt of [restoration.buildOriginalRestorationPrompt(), expanded, agentPrompt]) {
    assert.ok(prompt.includes(restoration.ORIGINAL_PLAN_HEADING_INSTRUCTION));
    assert.ok(!/无编号内部标题|这些只作为章节定位线索|禁止使用任何形式的编号|不要包含标题或说明/.test(prompt), '原方案相关提示不能与标题重新编号冲突');
  }
  const chapterContext = context.module.exports.buildAgentRestoredChapterContentFiles(args)[0].content;
  assert.ok(chapterContext.includes('内部层级和编号应合理连贯'));
  assert.ok(!chapterContext.includes('不要重复输出章节标题、Markdown 标题或编号标题'));
  console.log('Agent 标题处理：年份/型号保留、重新编号、删除、正文及图片保护、扩写提示一致性检查通过。');
}

// 使用正式输入与统计恢复代码，验证无原方案不读文件、同源续跑保留统计。
function checkRestorationStatsResume() {
  const inputStart = taskSource.indexOf('  const hasOriginalPlan = Boolean(');
  const inputEnd = taskSource.indexOf('  const projectOverview =', inputStart);
  vm.runInNewContext(taskSource.slice(inputStart, inputEnd), {
    storedPlan: { originalPlanFile: { markdownPath: '' } },
    workspaceStore: { readOriginalPlanMarkdown: () => assert.fail('无路径时不能读取原方案') },
    createOriginalSource: () => assert.fail('无路径时不能建立行索引'),
    textHash: () => assert.fail('无路径时不能计算指纹'),
  });
  const start = taskSource.indexOf('  const previousOriginalRestoration =');
  const end = taskSource.indexOf('  contentRuntime = normalizeContentGenerationRuntime(', start);
  const saved = { source_hash: 'hash', total_words: 400, restored_words: 100, rate: 25 };
  for (const [hasOriginalPlan, fullRegenerate, hash, expected] of [[true, false, 'hash', 25], [true, true, 'hash', undefined], [true, false, 'changed', undefined], [false, false, 'hash', undefined]]) {
    const scope = { hasOriginalPlan, fullRegenerate, originalPlanSourceHash: hash, contentStats: {}, previousState: { contentGenerationTask: { stats: { content: { original_restoration: saved } } } } };
    vm.runInNewContext(taskSource.slice(start, end), scope);
    assert.equal(scope.contentStats.original_restoration?.rate, expected);
  }
}

// 执行正式阶段衔接分支，验证进入预热/工作池之前已落库并推送生成阶段。
async function checkGenerationStageTransition() {
  const helpersStart = taskSource.indexOf('  function syncRuntime(');
  const helpersEnd = taskSource.indexOf('  // 所有正文请求结束后存在失败时', helpersStart);
  const flowStart = taskSource.indexOf('    if (!runOnlyIllustrationStage && tasksToRun.length)');
  const flowEnd = taskSource.indexOf('    if (!runOnlyIllustrationStage && !targetItemId && !retryContentCorrection', flowStart);
  for (const targetItemId of ['', '1']) {
    for (const mode of ['original', 'new-leaf', 'no-original', 'resume-restored', 'resume-generating', 'developer-gate', 'completed']) {
      const checkpoints = [];
      let generationCalls = 0;
      let restorationCalls = 0;
      const completed = mode === 'original' || mode === 'new-leaf' || mode === 'no-original' ? []
        : mode === 'developer-gate' ? ['planning']
          : mode === 'completed' ? ['planning', 'restoring', 'generating'] : ['planning', 'restoring'];
      const scope = {
        ...context.module.exports,
        contentStats: { phase: 'planning' },
        contentRuntime: { phase: mode === 'resume-generating' ? 'generating' : 'restoring', completed_stages: completed },
        directGenerationIds: new Set(mode === 'new-leaf' ? ['1'] : []),
        completedStages: new Set(completed), touchedItemIds: new Set(), logs: [],
        developerModeEnabled: mode === 'developer-gate', hasOriginalPlan: mode !== 'no-original',
        targetItemId, runOnlyIllustrationStage: false, tasksToRun: [{ item: { id: '1' } }],
        leaves: [], sections: {}, outlineData: {}, storedContentPlans: {}, contentConcurrency: 1,
        progressFor: () => 25, isUnresolvedContentSection: () => false,
        pauseIfRequested() {}, runOne() {},
        planAll() {}, prepareSingleSectionPlan() {},
        restoreOriginalMaterialsIfNeeded() { restorationCalls += 1; scope.contentStats.phase = 'restoring'; },
        statsSnapshot: () => ({ content: { ...scope.contentStats } }),
        checkpointTask(task, patch, event) { checkpoints.push(structuredClone({ task, patch, event })); },
      };
      // 两种生成入口均在第一次调用时检查持久化值和页面事件，避免只测辅助函数。
      const generate = () => {
        generationCalls += 1;
        const last = checkpoints.at(-1);
        assert.equal(last.task.stats.content.phase, 'generating');
        assert.equal(last.patch.contentGenerationRuntime.phase, 'generating');
        assert.equal(last.event.contentRuntime.phase, 'generating');
        assert.equal(last.patch.contentGenerationRuntime.developer_stage_gate, '');
        scope.persistPausedContentGeneration();
        assert.equal(checkpoints.at(-1).patch.contentGenerationRuntime.phase, 'generating', '生成中暂停须保存生成阶段');
      };
      scope.runItemsWithWorkerPool = generate;
      scope.runContentTargetsWithWarmup = generate;
      vm.createContext(scope);
      vm.runInContext(taskSource.slice(helpersStart, helpersEnd), scope);
      const run = () => vm.runInContext(`(async () => {${taskSource.slice(flowStart, flowEnd)}})()`, scope);
      if (mode === 'developer-gate') {
        await assert.rejects(run(), /CONTENT_GENERATION_PAUSED/);
        assert.equal(generationCalls, 0, '还原检查点不可提前启动生成');
        assert.equal(checkpoints.at(-1).task.status, 'paused');
        assert.equal(checkpoints.at(-1).patch.contentGenerationRuntime.phase, 'restoring');
        assert.equal(checkpoints.at(-1).patch.contentGenerationRuntime.developer_stage_gate, 'restoring');
        // 继续时还原已完成，只运行生成入口；生成结束仍保留原有开发者检查点。
        await assert.rejects(run(), /CONTENT_GENERATION_PAUSED/);
      } else {
        await run();
      }
      assert.equal(generationCalls, mode === 'completed' ? 0 : 1);
      if (mode === 'new-leaf') {
        assert.equal(restorationCalls, 0, '新增叶子跳过原方案还原');
        assert.ok(!scope.completedStages.has('restoring'), '跳过的还原阶段不产生检查点');
      }
    }
  }
  console.log('阶段切换：全文/单节、无原方案、暂停恢复及还原检查点检查通过。');
}

// 内存中编译并渲染正式页面，验证原方案移除、替换和统计边界的显示。
async function checkRestorationStatsPage() {
  const result = await require('esbuild').build({
    stdin: {
      contents: `import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import ContentEditPage from './src/features/technical-plan/pages/ContentEditPage';
        import { ToastProvider } from './src/shared/ui/ToastProvider';
        export function render(props) {
          return renderToStaticMarkup(<ToastProvider><ContentEditPage stepNumber="05" sections={{}}
            outlineData={{outline:[{id:'1',title:'实施方案',content_mode:'ai-generate'}]}}
            {...props}/></ToastProvider>);
        }`,
      loader: 'tsx', resolveDir: path.resolve(__dirname, '..'),
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  const compiled = new Module(path.join(__dirname, 'virtual-restore-ui.cjs'), module);
  compiled.filename = path.join(__dirname, 'virtual-restore-ui.cjs');
  compiled.paths = module.paths;
  compiled._compile(result.outputFiles[0].text, compiled.filename);
  for (const [hasOriginalPlan, sourceHash, rate, expected] of [
    [true, 'plan-hash', 25, '25.0%'], [true, 'plan-hash', 0, '0.0%'],
    [true, 'plan-hash', null, '—'], [true, 'changed-hash', 25, '待统计'],
    [true, 'plan-hash', undefined, '待统计'], [false, 'plan-hash', 25, null],
  ]) {
    const stats = rate === undefined ? undefined : {
      source_hash: sourceHash, total_words: rate === null ? 0 : 400,
      restored_words: rate === null ? 0 : rate * 4, rate, total_images: 2, restored_images: 2,
    };
    const html = compiled.exports.render({ hasOriginalPlan, originalPlanContentHash: 'plan-hash',
      task: { status: 'success', stats: { content: { phase: 'done', original_restoration: stats } } } });
    if (expected === null) { assert.ok(!html.includes('原方案还原率')); assert.ok(!html.includes('原方案图片')); }
    else assert.ok(html.includes(`原方案还原率 <strong>${expected}</strong>`));
    if (expected === '25.0%') { assert.ok(html.includes('已回填 100 / 原文共 400 字')); assert.ok(html.includes('原方案图片 <strong>2/2</strong>')); }
  }
  console.log('正文页面：还原率、待统计、空内容、原方案替换和移除显示检查通过。');
}

// 顺序执行一组聚焦检查，不调用真实 AI 或写入用户业务数据库。
async function main() {
  checkSourceValidation();
  checkSingleColumnTables();
  checkHeadingsAndImages();
  checkAgentHeadingEdits();
  await checkOriginalRestore();
  checkRestorationStatsResume();
  await checkGenerationStageTransition();
  await checkRestorationStatsPage();
  console.log('原方案还原：完整输入、跨小节来源、部分重生、表格、保存、去重统计、暂停继续和无原方案跳过检查通过。');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
