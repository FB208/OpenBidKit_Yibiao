// 在 client 目录执行：node scripts/check-original-restore.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, Module } = require('node:module');
const restoration = require('../electron/services/originalPlanRestoration.cjs');
const { ORIGINAL_RESTORATION_AGENT_TASK_KEY } = require('../electron/services/originalPlanRestorationAgentConfig.cjs');
const { createPiJsonValidator } = require('../electron/services/pi/piJsonValidationTool.cjs');
const { countReadableWords } = require('../electron/utils/wordCount.cjs');
const { numberMarkdownLines } = require('../electron/utils/markdownLineView.cjs');
const taskFile = path.resolve(__dirname, '../electron/services/contentGenerationTask.cjs');
const taskSource = fs.readFileSync(taskFile, 'utf8');
const context = { module: { exports: {} }, require: createRequire(taskFile) };
vm.runInNewContext(`${taskSource}\nmodule.exports = {
  normalizeOriginalMaterial, parseAgentJsonContent, textMetrics, now,
  formatRestoreTargetsForPrompt, formatBidKeyInfoForPrompt, normalizeLeafContentForSave,
  withSection, updateOutlineItemContent, pruneContentGenerationPlans, createStoredContentPlan,
  normalizeContentGenerationRuntime, CONTENT_PHASE_LABELS, createContentGenerationPausedError, isPauseLikeError,
};`, context, { filename: taskFile });

// 行号视图直接供 Agent 定位；Agent 只声明范围，程序从无行号原文重建正文。
function checkNumberedInputAndSchema() {
  const image = '![现场图](yibiao-asset://imported-images/方案/现场.png)';
  const source = restoration.createOriginalSource(
    `# 1 实施方案\r\n${'技术参数😀'.repeat(4000)} ${image}\r\n**项目目标**\r\n一、实施内容\r\n第1节 实施要求\r\n1.这是带逗号，属于正文说明。\r\n| 名称 | 参数 |\n| --- | --- |\n| 设备 | ${'规格'.repeat(1200)} |\r\n<table><tr><td>验收参数</td></tr></table>`);
  const files = restoration.buildOriginalRestorationFiles({
    source, targetsText: '1 实施方案', contextText: '项目背景', coveredRanges: [],
  });
  const numbered = files.find(file => file.path === 'original-plan-numbered.md');
  const numberedParts = files.filter(file => /^original-plan-numbered-part-\d+\.md$/u.test(file.path));
  const index = files.find(file => file.path === 'original-plan-index.md');
  assert.equal(numbered?.content, numberMarkdownLines(source.content));
  assert.ok(numberedParts.length > 1, '超长行号视图应生成多个固定读取分片');
  assert.equal(numberedParts.map(file => file.content).join('\n'), numbered.content, '固定分片拼接后必须与完整行号视图逐字一致');
  assert.ok(numberedParts.every(file => Buffer.byteLength(file.content, 'utf8') <= 40 * 1024), '测试样本的每个分片应小于等于 40KB');
  const partRanges = numberedParts.map((file) => {
    const displayLines = file.content.split('\n');
    return {
      start: Number(/^L(\d+)/u.exec(displayLines[0])[1]),
      end: Number(/^L(\d+)/u.exec(displayLines[displayLines.length - 1])[1]),
    };
  });
  assert.ok(partRanges.some((range, index) => index > 0 && range.start === partRanges[index - 1].end), '同一真实长行应允许跨相邻读取分片');
  assert.match(index.content, /分片行号范围允许重叠/u);
  assert.match(numbered.content, /L000002\[1\/\d+\] \|/u, '超长原文行应使用同一真实行号分片');
  assert.equal(files.find(file => file.path === 'original-plan.md')?.content, source.content);
  for (const part of numberedParts) assert.ok(index.content.includes(part.path), `导航索引缺少分片：${part.path}`);
  assert.match(index.content, /仅用于快速定位/u);
  assert.match(index.content, /L000002：1 个图片引用/u);
  assert.match(index.content, /L000007-L000009：Markdown 表格/u);
  assert.match(index.content, /L000010-L000010：HTML 表格/u);
  assert.match(index.content, /L000001 \| # 1 实施方案/u);
  assert.match(index.content, /L000003 \| \*\*项目目标\*\*/u);
  assert.match(index.content, /L000004 \| 一、实施内容/u);
  assert.match(index.content, /L000005 \| 第1节 实施要求/u);
  assert.doesNotMatch(index.content, /L000006 \|/u, '带句读的编号正文不应进入标题候选');

  const validator = createPiJsonValidator({
    workspaceDir: __dirname, trackFailures: false,
    validationSchemas: { 'original-restore-result.json': restoration.ORIGINAL_RESTORATION_JSON_SCHEMA },
  });
  const output = {
    assignments: [{
      node_id: '1', source_ranges: [{ start_line: 1, end_line: 10 }],
      heading_edits: [{ line: 1, content: '**1 实施方案**' }],
    }],
    unassigned: [],
  };
  assert.equal(validator.validateContent('original-restore-result.json', JSON.stringify(output)).details.valid, true);
  assert.equal(validator.validateContent('original-restore-result.json', JSON.stringify({
    ...output, assignments: [{ ...output.assignments[0], content: '旧版正文' }],
  })).details.valid, false, '新协议不兼容包含 content 的旧输出');
  const validated = restoration.validateOriginalRestoration(output, { source, allowedNodeIds: new Set(['1']) });
  assert.equal(validated.assignments[0].content,
    source.content.replace('# 1 实施方案', '**1 实施方案**'), '正文应由程序从原始行逐字重建');
  const prompt = restoration.buildOriginalRestorationPrompt({ numberedPartPaths: numberedParts.map(file => file.path) });
  assert.ok(prompt.includes('original-plan-numbered.md'));
  for (const part of numberedParts) assert.ok(prompt.includes(part.path), `Prompt 缺少分片：${part.path}`);
  assert.ok(prompt.includes('具体工具调用和读取节奏由你自行安排'));
  assert.ok(prompt.includes('通常无需先执行 ls'));
  assert.ok(!prompt.includes('第一批工具调用中一起读取'));
  assert.ok(prompt.indexOf('1. restore-targets.md') < prompt.indexOf('4. original-plan-index.md'));
  assert.ok(prompt.indexOf('4. original-plan-index.md') < prompt.indexOf(numberedParts[0].path));
  assert.ok(prompt.includes('仅在分片读取异常或需要连续复核时读取'));
  assert.ok(prompt.includes('仅在需要核对原始 Markdown 结构时读取'));
  assert.ok(prompt.includes('相同 L 编号的所有分片仍属于同一个真实原文行'));
  assert.ok(prompt.includes('不要在 assignment 顶层输出正文 content 字段'));
  assert.ok(prompt.includes('每项的标题 content 仍须填写'));
  assert.ok(prompt.includes('不要求每个目标均分配材料'));
  assert.ok(prompt.includes('大型表格、成组图片、证书和清单等大块材料'));
  assert.ok(prompt.includes('只有多个目标小节确实都需要完整保留该材料时'));
  assert.ok(prompt.includes('纯空白签字、职务、日期、盖章栏'));
  assert.ok(prompt.includes('将结果直接写入 original-restore-result.json'));
  assert.ok(prompt.includes('不重复输出逐行原文'));
  assert.ok(prompt.includes('使用 read、find 或 bash 补充核对并修正'));
  assert.ok(prompt.includes('工具返回校验通过后无需再调用 json-validation'));
  assert.ok(!prompt.includes('完成后调用 json-validation'));
  const resumePrompt = restoration.buildOriginalRestorationPrompt({
    resume: true, numberedPartPaths: numberedParts.map(file => file.path),
  });
  assert.ok(resumePrompt.includes('优先利用当前 Session 已有上下文'));
  assert.ok(resumePrompt.includes('具体工具调用和读取节奏由你自行安排'));
  assert.ok(!resumePrompt.includes('通常无需先执行 ls'), '继续任务仍需允许 Agent 检查已有输出');
  assert.ok(!resumePrompt.includes('第一批工具调用中一起读取'));

  const protectedSource = restoration.createOriginalSource(
    `<img alt="${'超长图片说明'.repeat(5000)}" src="yibiao-asset://imported-images/方案/超长图片.png">`);
  const protectedFiles = restoration.buildOriginalRestorationFiles({
    source: protectedSource, targetsText: '1 图片材料', contextText: '', coveredRanges: [],
  });
  const protectedView = protectedFiles.find(file => file.path === 'original-plan-numbered.md').content;
  const protectedParts = protectedFiles.filter(file => /^original-plan-numbered-part-\d+\.md$/u.test(file.path));
  assert.equal(protectedParts.length, 1, '不可拆的超长 HTML 标签应独占一个读取分片');
  assert.ok(Buffer.byteLength(protectedParts[0].content, 'utf8') > 40 * 1024, '单个不可拆展示行允许超过软上限');
  assert.equal(protectedParts[0].content, protectedView, '超限独占分片仍须逐字保留行号视图');
}

// 跨小节来源可重叠，单节范围有序，长表格完整保留，拒绝遗漏和改写。
function checkSourceValidation() {
  const source = restoration.createOriginalSource('项目背景\r\n实施内容😀\r\n<table>\r\n<tr><td>' + '参数'.repeat(4000) + '</td></tr>\r\n</table>\r\n签章');
  const range = (start_line, end_line) => ({ start_line, end_line });
  const assignment = (node_id, start, end) => ({ node_id, source_ranges: [range(start, end)], heading_edits: [] });
  const result = { assignments: [assignment('1', 1, 2), assignment('2', 3, 5)], unassigned: [{ ...range(6, 6), reason: '签章栏' }] };
  const validation = { source, allowedNodeIds: new Set(['1', '2', '没有匹配原文']) };
  const validatedResult = restoration.validateOriginalRestoration(result, validation);
  const invalid = change => {
    const copy = structuredClone(result);
    change(copy);
    return () => restoration.validateOriginalRestoration(copy, validation);
  };
  const overlapping = structuredClone(result);
  overlapping.assignments[1].source_ranges.unshift(range(2, 2));
  restoration.validateOriginalRestoration(overlapping, validation);
  assert.throws(invalid(value => value.assignments[0].source_ranges.push(range(2, 2))), /按原文顺序/);
  assert.throws(invalid(value => value.assignments[1].source_ranges[0].start_line = 4), /表格被切断/);
  assert.throws(invalid(value => value.assignments[0].node_id = '未知节点'), /ID 无效/);
  assert.throws(invalid(value => value.unassigned = []), /未交代去向/);
  assert.throws(invalid(value => value.unassigned[0].reason = ''), /说明原因/);
  restoration.validateOriginalRestoration(result, { ...validation, coveredRanges: [{ ...range(1, 2), node_id: '已有章节' }] });
  assert.throws(invalid(value => value.unassigned.push({ ...range(2, 2), reason: '未采用' })), /已覆盖/);
  assert.throws(invalid(value => value.assignments.push(value.assignments[0])), /ID 无效或重复/);
  const markdownTable = restoration.createOriginalSource('| 名称 | 参数 |\n| --- | --- |\n| 设备 | 内容 |');
  assert.throws(() => restoration.validateOriginalRestoration({ assignments: [{ node_id: '1', source_ranges: [range(1, 2)], heading_edits: [] }], unassigned: [] }, { source: markdownTable, allowedNodeIds: new Set(['1']) }), /表格被切断/);
  const stats = restoration.calculateOriginalRestoration(source, [range(1, 5)], 'hash');
  assert.equal(stats.total_words, countReadableWords(source.content));
  assert.equal(stats.restored_words, countReadableWords(validatedResult.assignments.map(item => item.content).join('\n\n')));
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
  for (const mode of ['success', 'partial', 'failure', 'pause-before', 'pause-during', 'resume', 'repair', 'invalid-output']) {
    const targetMarkdown = '# 实施方案\n原文内容\n<table><tr><td>参数</td></tr></table>';
    const originalPlanMarkdown = targetMarkdown + (mode === 'partial' ? '\n![已覆盖图片](yibiao-asset://imported-images/方案/现场.png)' : '');
    const originalSource = restoration.createOriginalSource(originalPlanMarkdown);
    const target = { item: { id: '1', number: '1', title: '实施方案' } };
    const existing = { item: { id: '2', number: '2', title: '现场服务' } };
    const existingContent = originalSource.lines.slice(1).join('\n');
    const existingPlan = { original_material: { restored: true, optimized: false, source_hash: 'hash', source_ranges: [{ start_line: 2, end_line: 4 }] } };
    const saved = [];
    let calls = 0;
    let pauseRequested = mode === 'pause-before';
    let tick;
    let sessionState = mode === 'resume' ? { session_file: 'original-session.jsonl', status: 'paused' } : null;
    const originalSessionFile = 'original-session.jsonl';
    const validator = createPiJsonValidator({
      workspaceDir: __dirname, trackFailures: true,
      validationSchemas: { 'original-restore-result.json': restoration.ORIGINAL_RESTORATION_JSON_SCHEMA },
    });
    const scope = {
      ...context.module.exports, ...restoration, countReadableWords, ORIGINAL_RESTORATION_AGENT_TASK_KEY,
      crypto: require('node:crypto'), AbortController, AbortSignal,
      resume: mode === 'resume', taskControl: { signal: new AbortController().signal },
      isPauseRequested: () => pauseRequested,
      setInterval(callback) { tick = callback; return 1; }, clearInterval() { tick = null; },
      updateContentAgentState(partial) { scope.agentState = { ...scope.agentState, ...partial }; },
      createAgentActivityProgressHandler: () => () => {}, publishTaskUpdate() {}, agentErrorDiagnostics: () => ({}),
      persistPausedContentGeneration() { scope.paused = true; },
      hasOriginalPlan: true, originalPlanMarkdown, originalSource, originalPlanSourceHash: 'hash',
      leaves: mode === 'partial' ? [target, existing] : [target],
      sections: mode === 'partial' ? { '2': { status: 'success', content: existingContent } } : {},
      outlineData: { outline: [target.item] },
      contentPlans: new Map(mode === 'partial' ? [['2', existingPlan]] : []), storedContentPlans: {},
      completedStages: new Set(), contentStats: {}, logs: [], tableRequirement: 'none',
      projectOverview: '', bidAnalysisFactsText: '', globalFactTitlesText: '',
      getStoredContentPlan: () => null,
      getContentPlanForItem: () => ({ writing_focus: '实施方案', image_needed: true, image_suitability_score: 10 }),
      runContentAgentTask() { assert.fail('还原不得再调用临时包装'); },
      agentService: {
        hasPersistentTaskSession: () => Boolean(sessionState?.session_file),
        loadPersistentTask: () => ({ state: sessionState }),
        updatePersistentTask(key, partial) {
          assert.equal(key, ORIGINAL_RESTORATION_AGENT_TASK_KEY);
          assert.ok(sessionState);
          sessionState = { ...sessionState, ...partial };
          return { state: sessionState };
        },
        async runTask(options) {
          calls += 1;
          assert.equal(options.primary_session, true);
          assert.equal(options.summary_enabled, false, '还原结果写入成功后应直接结束，不生成总结');
          assert.equal(options.persistent_task.task_key, ORIGINAL_RESTORATION_AGENT_TASK_KEY);
          assert.equal(options.persistent_task.mode, scope.resume ? 'resume' : 'create');
          if (scope.resume) {
            assert.equal(sessionState.session_file, originalSessionFile);
            assert.equal(sessionState.run_id, options.task_id, '恢复前同步本轮运行 ID');
            assert.ok(options.prompt.startsWith('继续同一次'));
          } else sessionState = { run_id: options.task_id, session_file: originalSessionFile };
          options.onCheckpoint(sessionState);
          assert.equal(options.auto_validate_json, true);
          assert.equal(options.json_validation_schemas['original-restore-result.json'], restoration.ORIGINAL_RESTORATION_JSON_SCHEMA);
          assert.equal(options.files.find(file => file.path === 'original-plan.md').content, originalPlanMarkdown);
          assert.equal(options.files.find(file => file.path === 'original-plan-numbered.md').content, numberMarkdownLines(originalPlanMarkdown));
          const numberedParts = options.files.filter(file => /^original-plan-numbered-part-\d+\.md$/u.test(file.path));
          assert.ok(numberedParts.length > 0);
          assert.equal(numberedParts.map(file => file.content).join('\n'), numberMarkdownLines(originalPlanMarkdown));
          assert.ok(options.files.some(file => file.path === 'original-plan-index.md'));
          for (const part of numberedParts) assert.ok(options.prompt.includes(part.path));
          assert.ok(!options.files.some(file => ['original-segments.md', 'reserved-ranges.json', 'original-restore-result.json'].includes(file.path)), '恢复时不得覆盖已有输出文件');
          const coveredRanges = JSON.parse(options.files.find(file => file.path === 'covered-ranges.json').content);
          assert.equal(coveredRanges.length, mode === 'partial' ? 1 : 0);
          if (mode === 'failure') throw new Error('Agent 失败');
          if (mode === 'pause-during' && calls === 1) {
            pauseRequested = true;
            tick();
            assert.equal(options.signal.aborted, true);
            throw options.signal.reason;
          }
          const result = { assignments: [{ node_id: '1', source_ranges: [{ start_line: 1, end_line: 3 }], heading_edits: [{ line: 1, content: '**实施方案**' }] }], unassigned: [] };
          if (mode === 'repair') {
            const bad = structuredClone(result);
            bad.assignments[0].source_ranges[0].start_line = '1';
            assert.equal(validator.validateContent('original-restore-result.json', JSON.stringify(bad)).details.valid, false);
            assert.throws(() => validator.assertValid(), /尚未通过校验/);
            bad.assignments[0].source_ranges[0].start_line = 1;
            bad.assignments[0].source_ranges[0].end_line = 2;
            assert.throws(() => options.validateOutput({ output_content: JSON.stringify(bad) }), /未交代去向/);
            assert.equal(options.max_retries, 1, '保留同一 Session 内的业务校验修正机会');
          }
          if (mode === 'invalid-output') result.assignments[0].source_ranges[0].end_line = 2;
          const outputContent = JSON.stringify(result);
          assert.equal(validator.validateContent('original-restore-result.json', outputContent).details.valid, true);
          validator.assertValid();
          if (mode !== 'invalid-output') options.validateOutput({ output_content: outputContent });
          return { output_content: outputContent, task_id: options.task_id, session_id: 'original-session' };
        },
      },
      pauseIfRequested() { if (pauseRequested) throw scope.createContentGenerationPausedError(); },
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
    if (mode === 'pause-during') {
      await assert.rejects(scope.restoreOriginalMaterialsIfNeeded([target]), /CONTENT_GENERATION_PAUSED/);
      assert.equal(saved.length, 0);
      assert.equal(scope.paused, true);
      assert.equal(sessionState.status, 'paused');
      assert.equal(sessionState.session_file, originalSessionFile);
      pauseRequested = false;
      scope.resume = true;
    }
    if (['success', 'partial', 'pause-during', 'resume', 'repair'].includes(mode)) {
      await scope.restoreOriginalMaterialsIfNeeded([target]);
      assert.equal(saved[0].section.content, targetMarkdown.replace('# 实施方案', '**实施方案**'));
      assert.equal(saved[0].storedPlan.plan.image_needed, true);
      assert.equal(saved[0].storedPlan.plan.original_material.source_ranges[0].end_line, 3);
      assert.equal(scope.contentStats.original_restoration.rate, 100);
      assert.equal(sessionState.status, 'success');
      assert.equal(scope.agentState.task_key, ORIGINAL_RESTORATION_AGENT_TASK_KEY);
      assert.equal(scope.agentState.session_file, originalSessionFile);
      if (mode === 'partial') {
        assert.equal(scope.sections['2'].content, existingContent);
        assert.equal(scope.contentStats.original_restoration.restored_images, 1);
      }
      assert.equal(scope.getOriginalMaterialRuntimeState(target.item).needsOptimization, true);
      scope.completedStages.add('restoring');
      scope.sections['1'].content = '已经扩写的正文';
      const completedCalls = calls;
      await scope.restoreOriginalMaterialsIfNeeded([target]);
      assert.equal(calls, completedCalls, '完成阶段继续不得重跑还原');
      assert.equal(scope.sections['1'].content, '已经扩写的正文');
    } else {
      await assert.rejects(scope.restoreOriginalMaterialsIfNeeded([target]), /失败|CONTENT_GENERATION_PAUSED|未交代去向/);
      assert.equal(saved.length, 0);
    }
    assert.ok(tick == null, '本轮结束清除暂停定时器');
    const previousCalls = calls;
    scope.hasOriginalPlan = false;
    scope.leaves = new Proxy([], { get() { assert.fail('没有原方案不得扫描目录'); } });
    scope.contentPlans = new Proxy(new Map(), { get() { assert.fail('没有原方案不得扫描记录'); } });
    assert.equal(scope.getOriginalMaterialRuntimeState(target.item).needsOptimization, false);
    scope.updateOriginalRestorationStats();
    await scope.restoreOriginalMaterialsIfNeeded([target]);
    assert.equal(calls, previousCalls);
  }
  console.log('持久还原：新建/恢复、暂停保留 Session、预置 Schema 修正、主会话及回写检查通过。');
}

// 接受 Agent 的标题处理结果；原图在还原、扩写保存和整篇审计中均不能丢失或重复。
function checkHeadingsAndImages() {
  const first = 'yibiao-asset://imported-images/方案/image-1.png';
  const second = 'yibiao-asset://imported-images/方案/image-2.png';
  const raw = `2.2所投核心产品检测报告\n![第一页](${first})\n![第二页](${second})`;
  const source = restoration.createOriginalSource(raw);
  const assignment = { node_id: '15.4.4', source_ranges: [{ start_line: 1, end_line: 3 }], heading_edits: [{ line: 1, content: '**15.4.4.1 所投核心产品检测报告**' }] };
  const input = { source, allowedNodeIds: new Set(['15.4.4']) };
  const restoredAssignment = restoration.validateOriginalRestoration({ assignments: [assignment], unassigned: [] }, input).assignments[0];
  const shared = { ...assignment, node_id: '15.5.1' };
  restoration.validateOriginalRestoration({ assignments: [assignment, shared], unassigned: [] }, { ...input, allowedNodeIds: new Set([assignment.node_id, shared.node_id]) });
  const stats = restoration.calculateOriginalRestoration(source, assignment.source_ranges, 'hash');
  assert.equal(stats.total_images, 2);
  assert.equal(stats.restored_images, 2);
  assert.deepEqual(restoration.calculateOriginalRestoration(source, [...assignment.source_ranges, ...shared.source_ranges], 'hash'), stats);
  assert.throws(() => restoration.validateOriginalRestoration({ assignments: [], unassigned: [{ start_line: 1, end_line: 3, reason: '不要图片' }] }, input), /图片不得遗漏/);
  assert.throws(() => restoration.validateOriginalRestoration({ assignments: [{ ...assignment, heading_edits: [...assignment.heading_edits, { line: 2, content: '' }] }], unassigned: [] }, input), /独立文字标题/);
  const item = { id: '15.4.4', number: '15.4.4', title: '产品技术支持材料' };
  const section = { status: 'success', content: restoredAssignment.content };
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
  scope.validateSectionOriginalImages(item.id, restoredAssignment.content + '\n补充说明');
  const bad = `![第一页](${first})`;
  assert.throws(() => scope.saveSection(item, { content: bad }, bad), /图片遗漏/);
  assert.equal(scope.sections[item.id], section, '拒绝保存之前不能修改内存正文');
  assert.throws(() => scope.validateSectionOriginalImages(item.id, restoredAssignment.content + `\n![重复](${first})`), /图片遗漏、重复/);
  assert.throws(() => scope.validateAgentConsistencySections(new Map([[item.id, bad]]), new Map([[item.id, { originalContent: restoredAssignment.content }]])), /图片遗漏/);
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
      heading_edits: [{ line: 1, content: edited }] };
    const expected = edited ? `${edited}\n工期为30天。` : '工期为30天。';
    const input = { source, allowedNodeIds: new Set(['15.4.4']) };
    const validated = restoration.validateOriginalRestoration({ assignments: [assignment], unassigned: [] }, input);
    assert.equal(validated.assignments[0].content, expected);
    assert.equal(restoration.restoredAssignmentContent(source, assignment), expected);
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

  const prompt = restoration.buildOriginalRestorationPrompt();
  assert.ok(prompt.includes(restoration.ORIGINAL_PLAN_HEADING_INSTRUCTION));
  assert.ok(!/无编号内部标题|这些只作为章节定位线索|禁止使用任何形式的编号|不要包含标题或说明/.test(prompt), '还原提示不能与标题重新编号冲突');
  console.log('Agent 标题处理：年份/型号保留、重新编号、删除、正文及图片保护、还原提示一致性检查通过。');
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

// 执行正式阶段衔接分支，验证进入统一生成入口之前已落库并推送生成阶段。
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
        leaves: [], sections: {}, outlineData: {}, storedContentPlans: {},
        progressFor: () => 25, isUnresolvedContentSection: () => false,
        pauseIfRequested() {},
        planAll() {}, prepareSingleSectionPlan() {},
        restoreOriginalMaterialsIfNeeded() { restorationCalls += 1; scope.contentStats.phase = 'restoring'; },
        statsSnapshot: () => ({ content: { ...scope.contentStats } }),
        checkpointTask(task, patch, event) { checkpoints.push(structuredClone({ task, patch, event })); },
      };
      // 全文和单节均在统一入口第一次调用时检查持久化值和页面事件。
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
      scope.runContentGeneration = generate;
      vm.createContext(scope);
      vm.runInContext(taskSource.slice(helpersStart, helpersEnd), scope);
      const run = () => vm.runInContext(`(async () => {${taskSource.slice(flowStart, flowEnd)}throw new Error("不得进入后续流程");})()`, scope);
      if (mode === 'developer-gate') {
        await assert.rejects(run(), /CONTENT_GENERATION_PAUSED/);
        assert.equal(generationCalls, 0, '还原检查点不可提前启动生成');
        assert.equal(checkpoints.at(-1).task.status, 'paused');
        assert.equal(checkpoints.at(-1).patch.contentGenerationRuntime.phase, 'restoring');
        assert.equal(checkpoints.at(-1).patch.contentGenerationRuntime.developer_stage_gate, 'restoring');
        // 继续时还原已完成；HTML 生成完成后本轮直接结束。
        await run();
      } else {
        await run();
      }
      assert.equal(generationCalls, 1);
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
  // 还原提示分别携带身份和显示编号；去除外层标题也只比较显示编号。
  const node = { id: '10000000-0000-4000-8000-000000000001', number: '3.2', title: '实施安排' };
  const prompt = context.module.exports.formatRestoreTargetsForPrompt([{ item: node, parentChapters: [], siblingChapters: [] }]);
  assert.ok(prompt.includes(`node_id: ${node.id}`));
  assert.ok(prompt.includes('显示编号: 3.2'));
  assert.equal(context.module.exports.normalizeLeafContentForSave('## 3.2 实施安排\n\n实际正文', node), '实际正文');
  checkNumberedInputAndSchema();
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
