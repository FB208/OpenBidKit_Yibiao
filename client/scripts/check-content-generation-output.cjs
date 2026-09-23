const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildContentGenerationFiles, readContentGenerationResult } = require('../electron/services/contentGenerationAgent.cjs');
const { runContentGenerationTask, prepareContentGenerationStart } = require('../electron/services/contentGenerationTask.cjs');
const { scanGeneratedSections, convertContentSections } = require('../electron/services/contentGenerationOutput.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64');
const body = '<!-- yibiao:block -->\n<p>施工准备与检查</p>\n<!-- yibiao:block -->\n<table><tbody><tr><td><p>责任</p></td><td><p>项目组</p></td></tr></tbody></table>\n<!-- yibiao:block -->\n<figure id="现场图" data-yb-generation="aiImage" data-yb-size="wide"><template data-yb-role="prompt">复用现场图片</template><img alt="现场" data-yb-asset-ref="原图/现场 图片.png"><figcaption>现场情况</figcaption></figure>';

// 使用真实 Agent 输入格式，目录顺序刻意与文件名排序不同。
function createFixture(directory) {
  const outline = [{ id: '10000000-0000-4000-8000-000000000001', number: '1', title: '施工', content_mode: 'ai-generate', children: [
    { id: 'f0000000-0000-4000-8000-000000000012', number: '1.1', title: '准备 & 检查', content_mode: 'ai-generate' },
    { id: 'a0000000-0000-4000-8000-000000000010', number: '1.2', title: '交付', content_mode: 'ai-generate' },
  ] }];
  const inputs = buildContentGenerationFiles({
    outline, targets: outline[0].children.map(item => ({ item })), plans: {},
    projectOverview: '施工项目', globalFacts: [{ title: '工期', content: '六十天' }], globalFactsMode: 'placeholder',
    wordControl: {}, generationOptions: { imageQuantity: 'light', useAiImages: true },
    template: { config: { page: { size: 'A4' } } }, documentIds: [],
  });
  for (const file of inputs) {
    const target = path.join(directory, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf8');
  }
  const targets = JSON.parse(fs.readFileSync(path.join(directory, '正文编排决策.json'), 'utf8')).targets;
  fs.mkdirSync(path.join(directory, '正文'), { recursive: true });
  return { outline, targets };
}

// 手动推进真实任务注册的十秒回调，无需等待或调用外部 AI。
async function checkTask(directory, outputDir) {
  const { Type } = await import('typebox');
  const { outline, targets } = createFixture(directory);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'f0000000-0000-4000-8000-000000000012.docx'), '第一节原结果');
  fs.writeFileSync(path.join(outputDir, 'a0000000-0000-4000-8000-000000000010.docx'), '第二节原结果');
  fs.writeFileSync(path.join(outputDir, 'other.docx'), '其他文件');
  const timers = new Map();
  const originalSet = global.setInterval;
  const originalClear = global.clearInterval;
  global.setInterval = (callback, interval) => { const handle = {}; timers.set(handle, { callback, interval }); return handle; };
  global.clearInterval = handle => timers.delete(handle);
  const tick = interval => { for (const timer of [...timers.values()]) if (timer.interval === interval) timer.callback(); };
  let state = {
    outlineData: { outline }, globalFacts: [{ title: '工期', content: '六十天' }], globalFactsTask: { status: 'success' },
    contentGenerationOptions: { imageQuantity: 'none' }, contentGenerationSections: {},
    contentGenerationRuntime: { generation_started: true, phase: 'generating', completed_stages: ['planning'], pending_item_ids: targets.map(section => section.id) },
    contentGenerationTask: { status: 'paused', progress: 18 },
  };
  const updates = [];
  // 模拟 Store 的即时快照，防止后续对象修改掩盖当时的状态。
  const checkpoint = (task, patch, event) => {
    updates.push(structuredClone(task));
    if (patch?.contentGenerationSections && task.status === 'running' && patch.contentGenerationRuntime?.phase === 'word-converting') {
      assert.deepEqual(event?.technicalPlanPatch?.contentGenerationSections, patch.contentGenerationSections, '转换中的成功状态也要推送页面');
    }
    state = { ...state, ...structuredClone(patch || {}), contentGenerationTask: { ...state.contentGenerationTask, ...structuredClone(task) } };
  };
  let aiRuns = 0;
  let conversions = 0;
  let agentFinished = false;
  let failConversion = true;
  let pauseRequested = false;
  let pauseConversion = false;
  let pauseGeneration = false;
  const args = {
    aiService: { chat: async ({ logTitle }) => logTitle.includes('交付') ? body.replace('施工准备与检查', '交付准备与检查') : body },
    workspaceStore: { loadTechnicalPlan: () => state, getContentWordOutputDir: () => outputDir },
    taskControl: { signal: new AbortController().signal, isPauseRequested: () => pauseRequested },
    updateTask: checkpoint, checkpointTask: checkpoint,
    agentService: {
      hasPersistentTaskSession: () => true, updatePersistentTask() {},
      loadPersistentTask: () => ({ state: {} }),
      async runTask(payload) {
        aiRuns++;
        const tools = payload.create_tools({ Type, workspaceDir: directory });
        const [generate] = tools;
        assert.equal([...timers.values()].filter(timer => timer.interval === 10000).length, 1);
        if (pauseGeneration) {
          pauseRequested = true;
          tick(500);
          payload.signal.throwIfAborted();
        }
        fs.writeFileSync(path.join(directory, '正文/other.html'), body);
        fs.writeFileSync(path.join(directory, '正文/a0000000-0000-4000-8000-000000000010.html.tmp'), body);
        fs.writeFileSync(path.join(directory, '正文/a0000000-0000-4000-8000-000000000010.html'), '  \n');
        assert.equal(scanGeneratedSections(directory, targets), 0);
        for (const [index, section] of targets.entries()) {
          await generate.execute('generate', { sections: [{ section_id: section.id, instructions: '施工', references: '' }] });
          assert.equal(state.contentGenerationTask.stats.content.generation_completed, index);
          tick(10000);
          assert.equal(state.contentGenerationTask.stats.content.generation_completed, index + 1);
          const progress = state.contentGenerationTask.progress;
          tick(10000);
          assert.equal(state.contentGenerationTask.progress, progress);
        }
        assert.equal(state.contentGenerationTask.progress, 70);
        assert.equal(conversions, 0, '仅有 HTML 文件时不能触发转换');
        fs.mkdirSync(path.join(directory, '原图'), { recursive: true });
        fs.writeFileSync(path.join(directory, '原图/现场 图片.png'), png);
        fs.writeFileSync(path.join(directory, '正文生成结果.json'), JSON.stringify({ sections: targets.map(section => ({ section_id: section.id, file: section.file, words: 10 })) }));
        payload.validateOutput(null, { workspace_dir: directory });
        assert.equal(payload.continueTask({}, { workspace_dir: directory }).stage, 'auditing');
        assert.equal(state.contentGenerationTask.stats.content.consistency_round, 1);
        assert.equal(conversions, 0, '审计完成前不得转 Word');
        await tools.find(tool => tool.name === 'complete-consistency-round').execute('done', { summary: '无矛盾', remaining_issues: [] });
        assert.equal(payload.continueTask({}, { workspace_dir: directory }).complete, true);
        assert.equal(state.contentGenerationTask.progress, 80);
        agentFinished = true;
        return { workspace_dir: directory };
      },
    },
    openXmlHelperService: { async createRestrictedHtmlDocx(html, config, options) {
      assert.ok(agentFinished);
      assert.equal([...timers.values()].some(timer => timer.interval === 10000), false);
      assert.equal(options.copyAssets, true);
      assert.equal(options.assetRoot, directory);
      assert.equal(config.page.size, 'A4');
      conversions++;
      assert.ok([body, body.replace('施工准备与检查', '交付准备与检查')].includes(html), '小节转换应直接使用正文，不附加目录标题');
      if (conversions === 2 && failConversion) throw new Error('模拟转换失败');
      if (pauseConversion) { pauseRequested = true; tick(500); }
      return { bytes: Buffer.from(html.includes('交付') ? '交付 Word' : '准备 Word') };
    } },
  };
  try {
    await assert.rejects(runContentGenerationTask({ ...args, previousState: structuredClone(state), payload: { resume: true } }), /小节 1.2 交付 转 Word 失败/);
    assert.equal(timers.size, 0);
    assert.equal(state.contentGenerationRuntime.html_output.word_sections.length, 1);
    assert.equal(state.contentGenerationSections[targets[0].id].status, 'success');
    assert.equal(state.contentGenerationSections[targets[1].id].status, 'idle');
    assert.deepEqual(state.contentGenerationRuntime.pending_item_ids, [targets[1].id]);
    assert.equal(state.contentGenerationTask.stats.content.current_words, 32);
    assert.equal(state.contentGenerationTask.progress, 88);
    assert.equal(state.contentGenerationRuntime.html_output.word_output_dir, outputDir);
    assert.equal(fs.readFileSync(path.join(outputDir, 'f0000000-0000-4000-8000-000000000012.docx'), 'utf8'), '准备 Word', '成功覆盖原结果');
    assert.equal(fs.readFileSync(path.join(outputDir, 'a0000000-0000-4000-8000-000000000010.docx'), 'utf8'), '第二节原结果', '失败保留原结果');
    assert.equal(fs.existsSync(path.join(directory, 'Word')), false, '会话目录不再保存 Word');
    failConversion = false;
    // 转换失败后交换目录顺序：会话快照和已转换记录仍引用原稳定 ID。
    state.outlineData.outline[0].children.reverse();
    state.outlineData.outline[0].children.forEach((item, index) => { item.number = `1.${index + 1}`; });
    const failedState = structuredClone(state);
    // 正式 taskService 先保存新任务初始状态，再把原状态通过 previousState 传入。
    state.contentGenerationTask = { status: 'running', progress: 0 };
    await runContentGenerationTask({ ...args, previousState: failedState, payload: { retryFailedSections: true } });
    assert.equal(aiRuns, 1, '转换重试不得再次调用 Agent');
    assert.equal(fs.readFileSync(path.join(outputDir, `${targets[0].id}.docx`), 'utf8'), '准备 Word', '排序重试不能覆盖另一小节');
    assert.equal(state.outlineData.outline[0].children[0].id, targets[1].id);
    assert.equal(conversions, 3, '已完成的第一节不得重复转换');
    assert.equal(fs.readFileSync(path.join(outputDir, 'a0000000-0000-4000-8000-000000000010.docx'), 'utf8'), '交付 Word');
    assert.equal(fs.readFileSync(path.join(outputDir, 'other.docx'), 'utf8'), '其他文件');
    assert.ok(state.contentGenerationTask.logs.includes(`输出目录：${outputDir}`));
    assert.equal(timers.size, 0);
    assert.equal(state.contentGenerationTask.status, 'success');
    assert.ok(targets.every(section => state.contentGenerationSections[section.id].status === 'success'));
    assert.ok(targets.every(section => state.contentGenerationSections[section.id].content === ''), 'HTML 不写入数据库正文');
    assert.deepEqual(state.contentGenerationRuntime.section_words, Object.fromEntries(targets.map(section => [section.id, 16])));
    assert.deepEqual(state.contentGenerationRuntime.pending_item_ids, []);
    assert.equal(state.contentGenerationTask.stats.content.current_words, 32);
    assert.equal(state.contentGenerationTask.progress, 100);
    assert.equal(state.contentGenerationTask.stats.content.output_progress.phase, 'word-completed');
    assert.ok(updates.every(update => update.status === 'success' ? update.progress === 100 : update.progress < 100));
    assert.ok(updates.slice(1).every((update, index) => update.progress >= updates[index].progress));
    assert.ok(updates.some(update => update.progress_detail.phase === 'sections-completed'));
    assert.deepEqual(state.contentGenerationRuntime.html_output.word_sections.map(item => item.section_id), ['f0000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000010']);
    assert.deepEqual(fs.readFileSync(path.join(directory, '原图/现场 图片.png')), png);
    checkProgressView(state.contentGenerationTask);
    // 模拟转换中暂停：不保存刚返回的文件，继续时不调用 AI。
    fs.unlinkSync(path.join(outputDir, 'a0000000-0000-4000-8000-000000000010.docx'));
    state.contentGenerationRuntime.html_output.word_sections = state.contentGenerationRuntime.html_output.word_sections.slice(0, 1);
    state.contentGenerationTask.status = 'paused';
    pauseConversion = true;
    await runContentGenerationTask({ ...args, previousState: structuredClone(state), payload: { resume: true } });
    assert.equal(state.contentGenerationTask.status, 'paused');
    assert.equal(fs.existsSync(path.join(outputDir, 'a0000000-0000-4000-8000-000000000010.docx')), false);
    assert.equal(timers.size, 0);
    pauseConversion = pauseRequested = false;
    await runContentGenerationTask({ ...args, previousState: structuredClone(state), payload: { resume: true } });
    assert.equal(aiRuns, 1);
    assert.equal(state.contentGenerationTask.status, 'success');
    // 生成中暂停也必须清理十秒扫描；已有 HTML 不触发转换。
    state.contentGenerationRuntime.html_output = undefined;
    state.contentGenerationRuntime.phase = 'generating';
    state.contentGenerationSections = {};
    state.contentGenerationRuntime.section_words = {};
    state.contentGenerationTask.status = 'paused';
    const convertedBeforePause = conversions;
    pauseGeneration = true;
    await runContentGenerationTask({ ...args, previousState: structuredClone(state), payload: { resume: true } });
    assert.equal(state.contentGenerationTask.status, 'paused');
    assert.equal(timers.size, 0);
    assert.equal(conversions, convertedBeforePause);
    // 写作、配图和扩缩写失败后，执行页面实际重试请求，检查同一会话及文件继续使用。
    pauseGeneration = pauseRequested = false;
    const retainedFiles = ['正文编排决策.json', ...targets.map(section => section.file), '原图/现场 图片.png'];
    const retainedBytes = retainedFiles.map(file => fs.readFileSync(path.join(directory, file)));
    for (const stage of ['写作', '配图', '扩缩写']) {
      const persistentState = { word_adjustment_started: stage === '扩缩写' };
      state.contentGenerationSections = {};
      state.contentGenerationRuntime = { generation_started: true, phase: 'generating', completed_stages: ['planning'], pending_item_ids: targets.map(section => section.id) };
      state.contentGenerationTask = { status: 'paused' };
      const failure = new Error(`模拟${stage}最终失败`);
      const retryAgent = { ...args.agentService,
        loadPersistentTask: () => ({ state: persistentState }),
        updatePersistentTask(_key, partial) { Object.assign(persistentState, partial); },
        async runTask() { throw failure; },
      };
      await assert.rejects(runContentGenerationTask({ ...args, agentService: retryAgent,
        previousState: structuredClone(state), payload: { resume: true } }), error => error === failure);
      assert.equal(state.contentGenerationTask.status, 'error');
      assert.equal(state.contentGenerationRuntime.phase, 'generating');
      const request = await checkGenerationRetryButton(state.contentGenerationTask, state.contentGenerationRuntime, '重试正文生成');
      const failed = structuredClone(state);
      state.contentGenerationTask = { status: 'running', progress: 0 };
      let resumed = false;
      await runContentGenerationTask({ ...args, previousState: failed, payload: request, agentService: { ...retryAgent,
        async runTask(payload) {
          resumed = true;
          assert.equal(payload.persistent_task.mode, 'resume');
          assert.equal(payload.initial_stage, 'generating');
          assert.deepEqual(payload.files, [], '重试不得重写输入快照');
          assert.match(payload.prompt, /本次继续原会话/);
          assert.doesNotMatch(payload.prompt, /目录变更后的局部生成任务/);
          assert.equal(persistentState.word_adjustment_started, stage === '扩缩写', '重试不得重置扩缩写保护状态');
          if (stage === '扩缩写') assert.match(payload.prompt, /本次恢复时已处于图片保护阶段/);
          const tools = payload.create_tools({ Type, workspaceDir: directory });
          assert.equal(payload.continueTask({}, { workspace_dir: directory }).stage, 'auditing');
          await tools.find(tool => tool.name === 'complete-consistency-round').execute('done', { summary: '复核通过', remaining_issues: [] });
          assert.equal(payload.continueTask({}, { workspace_dir: directory }).complete, true);
          return { workspace_dir: directory };
        },
      } });
      assert.ok(resumed);
      assert.equal(state.contentGenerationTask.status, 'success');
      retainedFiles.forEach((file, index) => assert.deepEqual(fs.readFileSync(path.join(directory, file)), retainedBytes[index], file));
      assert.equal(timers.size, 0);
    }
    for (const [phase, target, label] of [['generating', targets[0].id, '重试小节修改'], ['auditing', '', '继续一致性审计'], ['word-converting', '', '重试 Word 转换']]) {
      await checkGenerationRetryButton({ status: 'error', stats: { content: { phase } } }, { target_item_id: target }, label);
    }
    console.log('全文写作、配图、扩缩写失败后，页面原会话重试、输入及文件保留、图片保护恢复检查通过。');
    // 已有正文的小节审计失败时，即使没有待生成项，也必须恢复原主会话。
    pauseGeneration = pauseRequested = false;
    state.contentGenerationSections = Object.fromEntries(targets.map(section => [section.id, { id: section.id, status: 'success', content: '已有正文' }]));
    state.contentGenerationRuntime = { generation_started: true, phase: 'auditing', target_item_id: targets[0].id, completed_stages: ['planning'] };
    state.contentGenerationTask = { status: 'error', progress: 74, stats: { content: { phase: 'auditing', consistency_round: 2 } } };
    let resumedAudit = false;
    const persistent = { word_adjustment_started: true, consistency: { round: 2, status: 'running', remaining_issues: ['核实工期'], failed_sections: [] } };
    const previous = structuredClone(state);
    state.contentGenerationTask = { status: 'running', progress: 0 };
    await runContentGenerationTask({ ...args, previousState: previous, payload: { retryFailedSections: true }, agentService: {
      hasPersistentTaskSession: () => true,
      loadPersistentTask: () => ({ state: persistent }),
      updatePersistentTask(_key, partial) { Object.assign(persistent, partial); },
      async runTask(payload) {
        resumedAudit = true;
        assert.equal(payload.initial_stage, 'auditing');
        assert.match(payload.prompt, /第 2\/3 轮/);
        const tools = payload.create_tools({ Type, workspaceDir: directory });
        assert.equal(state.contentGenerationTask.stats.content.consistency_round, 2);
        assert.equal(state.contentGenerationRuntime.target_item_id, targets[0].id);
        await tools.find(tool => tool.name === 'complete-consistency-round').execute('done', { summary: '复核通过', remaining_issues: [] });
        assert.equal(payload.continueTask({}, { workspace_dir: directory }).complete, true);
        return { workspace_dir: directory };
      },
    } });
    assert.equal(resumedAudit, true);
    assert.equal(state.contentGenerationTask.status, 'success');
    assert.equal(timers.size, 0);
    // 仅一个小节待生成：已完成小节即使数据库正文为空，也不重新进入目标。
    state.contentGenerationRuntime = { generation_started: true, phase: 'planning', completed_stages: ['planning'],
      pending_item_ids: [targets[0].id], section_words: { [targets[1].id]: 16 },
      html_output: { workspace_dir: directory, word_output_dir: outputDir, word_sections: [{ section_id: targets[1].id, file: `${targets[1].id}.docx` }] } };
    state.contentGenerationSections = Object.fromEntries(targets.map((section, index) => [section.id,
      { id: section.id, status: index === 0 ? 'idle' : 'success', content: '' }]));
    state.contentGenerationTask = { status: 'paused' };
    const decisionsPath = path.join(directory, '正文编排决策.json');
    const decisions = fs.readFileSync(decisionsPath, 'utf8');
    const manifestPath = path.join(directory, '正文生成结果.json');
    const manifest = fs.readFileSync(manifestPath, 'utf8');
    fs.writeFileSync(decisionsPath, JSON.stringify({ ...JSON.parse(decisions), targets: [targets[0]] }), 'utf8');
    fs.writeFileSync(manifestPath, JSON.stringify({ sections: [{ section_id: targets[0].id, file: targets[0].file, words: 16 }] }), 'utf8');
    const retainedWord = fs.readFileSync(path.join(outputDir, `${targets[1].id}.docx`));
    const retainedHtml = fs.readFileSync(path.join(directory, targets[1].file));
    await runContentGenerationTask({ ...args, previousState: structuredClone(state), payload: { resume: true },
      templateStore: { getTemplate: () => ({ config: { page: { size: 'A4' } } }) }, agentService: {
      ...args.agentService, async runTask(payload) {
        assert.equal(payload.persistent_task.mode, 'resume');
        assert.match(payload.prompt, /目录变更后的局部生成任务/);
        const input = JSON.parse(payload.files.find(file => file.path === '正文编排决策.json').content);
        assert.deepEqual(input.targets.map(section => section.id), [targets[0].id]);
        for (const file of payload.files) fs.writeFileSync(path.join(directory, file.path), file.content, 'utf8');
        assert.equal(state.contentGenerationSections[targets[1].id].status, 'success', '不能把已完成小节改回 idle');
        return { workspace_dir: directory };
      },
    } });
    assert.equal(state.contentGenerationTask.stats.content.current_words, 32, '局部生成保留其他小节字数');
    assert.equal(state.contentGenerationTask.stats.content.generation_total, 1);
    assert.deepEqual(state.contentGenerationRuntime.pending_item_ids, []);
    assert.equal(state.contentGenerationSections[targets[0].id].status, 'success');
    assert.equal(state.contentGenerationRuntime.html_output.word_sections.length, 2);
    assert.equal(state.contentGenerationTask.stats.content.word_conversion_completed, 1, '本轮进度只统计本轮目标');
    assert.deepEqual(fs.readFileSync(path.join(outputDir, `${targets[1].id}.docx`)), retainedWord);
    assert.deepEqual(fs.readFileSync(path.join(directory, targets[1].file)), retainedHtml);
    fs.writeFileSync(decisionsPath, decisions, 'utf8');
    fs.writeFileSync(manifestPath, manifest, 'utf8');
    // 新任务首次落库后立即中断：恢复必须重新编排正确目标，不能续转上一轮 HTML。
    for (const regenerate of [false, true]) {
      state.contentGenerationSections[targets[0].id].status = 'idle';
      state.contentGenerationRuntime = { ...state.contentGenerationRuntime,
        target_item_id: targets[1].id, phase: 'word-converting', completed_stages: ['planning', 'restoring'],
        pending_item_ids: [targets[0].id], section_words: { [targets[1].id]: 16 } };
      state = { ...state, ...prepareContentGenerationStart(state, { regenerate }), contentGenerationTask: { status: 'paused' } };
      const converted = conversions;
      let enteredPlanning = false;
      const stop = new Error('检查到恢复后正确进入编排');
      await assert.rejects(runContentGenerationTask({ ...args, previousState: structuredClone(state), payload: { resume: true },
        agentService: { ...args.agentService, async runTask(payload) {
          enteredPlanning = true;
          assert.equal(payload.initial_stage, 'content-planning');
          assert.equal(state.contentGenerationRuntime.target_item_id, '');
          assert.equal(state.contentGenerationTask.stats.content.planning_total, regenerate ? 2 : 1);
          throw stop;
        } },
      }), error => error === stop);
      assert.ok(enteredPlanning);
      assert.equal(conversions, converted, '不能读取上一轮转换记录继续转换');
      assert.equal(timers.size, 0);
    }
    // 实际生成输入应合计 HTML 字数与还原底稿，排除孤儿和非 AI 正文。
    const restored = '施工底稿';
    const zeroId = '00000000-0000-4000-8000-000000000031';
    const manualId = '00000000-0000-4000-8000-000000000033';
    state.outlineData = { outline: [...targets.map(section => ({ id: section.id, title: section.title, content_mode: 'ai-generate' })),
      { id: zeroId, title: '零字数记录', content_mode: 'ai-generate', content: '不应重复统计旧底稿' },
      { id: manualId, title: '非AI内容', content_mode: 'manual', content: '不应统计' }] };
    state.originalPlanFile = { markdownPath: '原方案.md' };
    state.contentGenerationSections = {
      [targets[0].id]: { status: 'idle', content: restored },
      [targets[1].id]: { status: 'success', content: '' },
      [zeroId]: { status: 'success', content: '不应重复统计旧底稿' },
    };
    state.contentGenerationPlans = { [targets[0].id]: { plan_version: 5, plan: {
      writing_focus: '施工', image_suitability_score: 0, table: { needed: false },
      original_material: { restored: true, source_hash: require('node:crypto').createHash('sha256').update(restored).digest('hex'),
        source_ranges: [{ start_line: 1, end_line: 1 }] },
    } } };
    state.contentGenerationRuntime = { phase: 'planning', completed_stages: ['planning', 'restoring'],
      pending_item_ids: [targets[0].id], section_words: { [targets[1].id]: 10000, [zeroId]: 0, deleted: 300 } };
    state.contentGenerationTask = { status: 'paused' };
    const stopAfterInput = new Error('已检查传给正文 Agent 的字数');
    await assert.rejects(runContentGenerationTask({ ...args, previousState: structuredClone(state), payload: { resume: true },
      workspaceStore: { ...args.workspaceStore, readOriginalPlanMarkdown: () => restored, assertOriginalImageFiles() {} },
      templateStore: { getTemplate: () => ({ config: {} }) },
      agentService: { ...args.agentService, async runTask(payload) {
        assert.equal(payload.initial_stage, 'generating');
        const input = JSON.parse(payload.files.find(file => file.path === '正文编排决策.json').content);
        assert.equal(input.targets[0].restored_content.words, 4);
        assert.match(input.restoration_requirements, /全文已有正文共 10004 字/);
        throw stopAfterInput;
      } },
    }), error => error === stopAfterInput);
    assert.equal(timers.size, 0);
    console.log('已有 HTML 字数与还原底稿汇总、零值及无效节点排除检查通过。');
    console.log('扫描、十秒回调、进度封顶、页面重开、定时器清理、生成/转换暂停、审计原会话重试及失败续跑通过。');
  } finally {
    global.setInterval = originalSet;
    global.clearInterval = originalClear;
  }
}

// 从审计接入去表格，实际 runner 检查失败重试、暂停继续及转换所用的最新 HTML。
async function checkTableCleanupTask(directory, outputDir) {
  const { Type } = await import('typebox');
  const { countHtmlWords } = require('../electron/services/contentGenerationWordTools.cjs');
  const { outline, targets } = createFixture(directory);
  const decisionsFile = path.join(directory, '正文编排决策.json');
  const decisions = JSON.parse(fs.readFileSync(decisionsFile, 'utf8'));
  decisions.table_requirement = 'none';
  fs.writeFileSync(decisionsFile, JSON.stringify(decisions), 'utf8');
  for (const target of targets) fs.writeFileSync(path.join(directory, target.file), body, 'utf8');
  fs.mkdirSync(path.join(directory, '原图'), { recursive: true });
  fs.writeFileSync(path.join(directory, '原图/现场 图片.png'), png);
  fs.writeFileSync(path.join(directory, '正文生成结果.json'), JSON.stringify({ sections: targets.map(section => ({ section_id: section.id, file: section.file, words: 1 })) }), 'utf8');
  let state = {
    outlineData: { outline }, globalFacts: [{ title: '工期', content: '六十天' }], globalFactsTask: { status: 'success' },
    contentGenerationOptions: { tableRequirement: 'none', imageQuantity: 'none' }, contentGenerationSections: {},
    contentGenerationRuntime: { generation_started: true, phase: 'auditing', pending_item_ids: targets.map(section => section.id) },
    contentGenerationTask: { status: 'paused', progress: 80 },
  };
  let persistent = { word_adjustment_started: true, consistency: { status: 'completed', round: 1, remaining_issues: [] } };
  let pauseRequested = false;
  let mode = 'fail';
  let conversions = 0;
  const childCalls = [];
  const updates = [];
  const save = (task, patch) => {
    updates.push(structuredClone(task));
    state = { ...state, ...structuredClone(patch || {}), contentGenerationTask: { ...state.contentGenerationTask, ...structuredClone(task) } };
  };
  const args = {
    aiService: {}, workspaceStore: { loadTechnicalPlan: () => state, getContentWordOutputDir: () => outputDir },
    updateTask: save, checkpointTask: save,
    taskControl: { signal: new AbortController().signal, isPauseRequested: () => pauseRequested },
    agentService: {
      hasPersistentTaskSession: () => true, loadPersistentTask: () => ({ state: persistent }),
      updatePersistentTask(_key, patch) { persistent = { ...persistent, ...structuredClone(patch) }; },
      async runTask(payload) {
        if (!payload.primary_session) {
          childCalls.push(payload.output_file);
          if (mode === 'fail' && payload.output_file === targets[0].file) throw new Error('模拟表格改写失败');
          const file = path.join(directory, payload.output_file);
          const original = fs.readFileSync(file, 'utf8');
          const html = original.replace(/<table>.*?<\/table>/s, '<p>本节责任由项目组承担。</p>');
          payload.before_file_write({ filePath: file, content: html, originalContent: original, toolName: 'edit' });
          fs.writeFileSync(file, html, 'utf8');
          payload.validateOutput({ output_content: html });
          return {};
        }
        assert.equal(payload.persistent_task.mode, 'resume');
        assert.deepEqual(payload.files, []);
        const tools = payload.create_tools({ Type, workspaceDir: directory });
        assert.equal(payload.continueTask({}, { workspace_dir: directory }).stage, 'table-cleaning');
        assert.equal(state.contentGenerationRuntime.phase, 'table-cleaning');
        assert.equal(conversions, 0, '去表格完成前不能转换');
        if (mode === 'pause') {
          pauseRequested = true;
          throw Object.assign(new Error('模拟去表格暂停'), { name: 'AbortError' });
        }
        const pending = targets.filter(section => !persistent.table_cleanup.completed_section_ids.includes(section.id));
        await tools.find(tool => tool.name === 'remove-section-tables').execute('clean', { sections: pending.map(section => ({ section_id: section.id, instructions: '完整转成普通文字' })) });
        if (mode === 'fail') throw new Error('主 Agent 本次去表格最终失败');
        await tools.find(tool => tool.name === 'complete-table-cleanup').execute();
        assert.equal(payload.continueTask({}, { workspace_dir: directory }).complete, true);
        assert.equal(persistent.consistency.round, 1);
        return { workspace_dir: directory };
      },
    },
    openXmlHelperService: { async createRestrictedHtmlDocx(html) {
      assert.equal(persistent.table_cleanup.status, 'completed');
      assert.doesNotMatch(html, /<table/);
      assert.match(html, /本节责任由项目组承担/);
      conversions++;
      return { bytes: Buffer.from('已去表格 Word') };
    } },
  };
  const run = payload => runContentGenerationTask({ ...args, payload, previousState: structuredClone(state) });
  await assert.rejects(run({ resume: true }), /最终失败/);
  assert.equal(state.contentGenerationTask.status, 'error');
  assert.equal(state.contentGenerationTask.stats.content.table_cleanup_completed, 1);
  assert.equal(state.contentGenerationTask.stats.content.table_cleanup_total, 2);
  const retry = await checkGenerationRetryButton(state.contentGenerationTask, state.contentGenerationRuntime, '重试去表格');
  const retained = fs.readFileSync(path.join(directory, targets[1].file));
  mode = 'pause';
  await run(retry);
  assert.equal(state.contentGenerationTask.status, 'paused');
  assert.equal(state.contentGenerationRuntime.phase, 'table-cleaning');
  mode = 'success';
  pauseRequested = false;
  await run({ resume: true });
  assert.equal(conversions, 2);
  assert.equal(state.contentGenerationTask.status, 'success');
  assert.equal(childCalls.filter(file => file === targets[1].file).length, 1);
  assert.deepEqual(fs.readFileSync(path.join(directory, targets[1].file)), retained);
  const expectedWords = targets.reduce((sum, section) => sum + countHtmlWords(fs.readFileSync(path.join(directory, section.file), 'utf8')), 0);
  assert.equal(state.contentGenerationTask.stats.content.current_words, expectedWords);
  assert.deepEqual(state.contentGenerationRuntime.pending_item_ids, []);
  assert.ok(updates.some(task => task.progress_detail?.phase === 'table-cleaning' && task.progress > 80 && task.progress < 100));
  console.log('去表格 runner：阶段衔接、页面重试、暂停续接、成功小节复用、最新字数和转换输入通过。');
}

// 执行页面真实按钮文案、点击分支和重试函数，普通生成分支会被检查捕获。
async function checkGenerationRetryButton(task, contentGenerationRuntime, expectedLabel) {
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../src/features/technical-plan/pages/ContentEditPage.tsx'), 'utf8');
  const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ['retryingWordConversion', 'retryingConsistency', 'retryingSectionModification', 'retryingBodyGeneration', 'retryingTableCleanup', 'generationButtonLabel', 'retryFailedSections', 'handleGenerationButtonClick'];
  const statements = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) statements.set(node.name.getText(ast), `const ${node.getText(ast)};`);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(statements.size, names.length);
  const calls = [];
  const evaluate = new Function('task', 'contentGenerationRuntime', 'calls', ts.transpile(`
    const taskFailed = task.status === 'error', contentStats = task.stats.content;
    const pausing = false, running = false, paused = false, taskBlocksGeneration = false;
    const completedCount = 0, leaves = [{}];
    const window = { yibiao: { tasks: { startContentGeneration: async request => { calls.push(request); } } } };
    const trackConfigUsage = () => {}, showToast = () => {};
    const startGeneration = () => calls.push({ ordinary: true });
    ${names.map(name => statements.get(name)).join('\n')}
    return { label: generationButtonLabel, click: handleGenerationButtonClick };
  `, { target: ts.ScriptTarget.ES2022 }));
  const button = evaluate(task, contentGenerationRuntime, calls);
  assert.equal(button.label, expectedLabel);
  button.click();
  await Promise.resolve();
  assert.deepEqual(calls, [{ retryFailedSections: true }]);
  return calls[0];
}

// 执行页面实际进度表达式，模拟从数据库重载后没有独立 progress_detail 的状态。
function checkProgressView(task) {
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../src/features/technical-plan/pages/ContentEditPage.tsx'), 'utf8');
  const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ['contentStats', 'progressDetail', 'htmlOutputProgress', 'currentProgressDetail', 'displayProgress', 'displayProgressLabel', 'displayProgressCount'];
  const statements = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) statements.set(node.name.getText(ast), `const ${node.getText(ast)};`);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const evaluate = new Function('task', `const phaseVisible = false; const auditing = false; ${names.map(name => statements.get(name)).join('\n')} return [displayProgress, displayProgressLabel, displayProgressCount];`);
  const reloaded = { ...task };
  delete reloaded.progress_detail;
  assert.deepEqual(evaluate(reloaded), [100, '转换完成', '2/2']);
}

// 已删除阶段不能留下进度空档，覆盖审计埋点也必须固定为关闭。
function checkRetiredStageCleanup() {
  const taskSource = fs.readFileSync(path.join(__dirname, '../electron/services/contentGenerationTask.cjs'), 'utf8').replace(/\r\n/g, '\n');
  const profileStart = taskSource.indexOf('const CONTENT_PROGRESS_PROFILES = ');
  const profileEnd = taskSource.indexOf('\n\nfunction clampPercentage', profileStart);
  assert.ok(profileStart >= 0 && profileEnd > profileStart);
  const profiles = new Function(`${taskSource.slice(profileStart, profileEnd)}\nreturn CONTENT_PROGRESS_PROFILES;`)();
  const phaseOrders = {
    full: ['planning', 'restoring', 'generating', 'auditing', 'table-cleaning'],
    single: ['planning', 'restoring', 'generating', 'auditing', 'table-cleaning'],
    correction: ['auditing', 'table-cleaning'],
  };
  for (const [mode, phases] of Object.entries(phaseOrders)) {
    assert.equal(profiles[mode][phases[0]][0], 0, `${mode} 首阶段必须从 0 开始`);
    for (let index = 1; index < phases.length; index++) {
      assert.equal(profiles[mode][phases[index - 1]][1], profiles[mode][phases[index]][0], `${mode} 进度阶段不能留空档`);
    }
    assert.equal(profiles[mode]['table-cleaning'][1], 99, `${mode} 完成前最多到 99%`);
    assert.deepEqual(profiles[mode].done, [100, 100]);
  }

  const pageSource = fs.readFileSync(path.join(__dirname, '../src/features/technical-plan/pages/ContentEditPage.tsx'), 'utf8');
  assert.equal((pageSource.match(/enable_original_plan_coverage_audit:\s*false/g) || []).length, 2);
  assert.equal(pageSource.includes('original_plan_coverage_repair_mode:'), false);
}

// 调用真实助手服务，解包确认正文、表格、图片及中转目录清理。
async function checkRealWord(directory, outputDir, hasTables = true) {
  const { EventEmitter } = require('node:events');
  const { createOpenXmlHelperService } = require('../electron/services/openXmlHelperService.cjs');
  const AdmZip = require('adm-zip');
  const app = new EventEmitter();
  // 可使用独立助手构建目录，避免测试重编译占用中的开发版程序。
  app.isPackaged = Boolean(process.env.YIBIAO_OPENXML_HELPER_DIR);
  app.getPath = () => path.dirname(path.dirname(outputDir));
  app.getAppPath = () => path.resolve(__dirname, '..');
  const service = createOpenXmlHelperService({ app, configStore: { load: () => ({}) } });
  try {
    const result = readContentGenerationResult(directory);
    const outputs = await convertContentSections({ result, outputDir, openXmlHelperService: service, signal: new AbortController().signal });
    for (const output of outputs) {
      const zip = new AdmZip(path.join(outputDir, output.file));
      const xml = zip.readAsText('word/document.xml');
      assert.match(xml, /(?:施工|交付)准备与检查/);
      assert.doesNotMatch(xml, /准备 &amp; 检查|<w:t\b[^>]*>交付<\/w:t>/, '小节 Word 不应带目录标题');
      if (hasTables) assert.match(xml, /<w:tbl[ >]/);
      else {
        assert.doesNotMatch(xml, /<w:tbl[ >]/);
        assert.match(xml, /本节责任由项目组承担/);
      }
      assert.match(xml, /<w:drawing[ >]/);
      assert.ok(zip.getEntries().some(entry => /(^|\/)media\/.+\.png$/i.test(entry.entryName)));
    }
    await assert.rejects(service.createRestrictedHtmlDocx(body.replace('原图/现场 图片.png', '原图/不存在.png'), { page: {} }, { assetRoot: directory, copyAssets: true }));
    assert.equal(fs.readdirSync(path.join(app.getPath(), 'workspace')).some(name => name.startsWith('restricted-html-assets-')), false);
    assert.deepEqual(fs.readFileSync(path.join(directory, '原图/现场 图片.png')), png);
    console.log(`真实 OpenXmlHelper：两个独立 Word、${hasTables ? '数据表格保留' : '数据表格已转为普通文字'}、图片、中文路径及成功/失败中转清理通过。`);
  } finally {
    await service.close();
  }
}

// 运行正式导出编号逻辑，UUID 的字典顺序不能影响自定义标题编号。
function checkExportNumbering() {
  const { createRequire } = require('node:module');
  const vm = require('node:vm');
  const sourcePath = path.resolve(__dirname, '../electron/services/exportService.cjs');
  const scope = { module: { exports: {} }, require: createRequire(sourcePath), __dirname: path.dirname(sourcePath) };
  vm.runInNewContext(`${fs.readFileSync(sourcePath, 'utf8')}\nmodule.exports = { collectOutlineExportEntries, formatOutlineTitle };`, scope);
  const outline = [{ id: 'ffffffff-0000-4000-8000-000000000001', title: '甲', children: [{ id: 'aaaaaaaa-0000-4000-8000-000000000002', title: '乙', content_mode: 'ai-generate' }] }];
  const entries = scope.module.exports.collectOutlineExportEntries(outline, true);
  assert.equal(entries[0].item.id, outline[0].id);
  assert.equal(entries[1].item.number, '1.1');
  assert.equal(entries[1].level, 2);
  assert.equal(scope.module.exports.formatOutlineTitle(entries[1].item.number, '乙', { numbering_format: 'custom', numbering_template: '{full}' }), '1.1 乙');
}

// 执行真实启动入口，确认只读取已保存状态，拦截发生在运行态准备和会话清理前。
function checkImageModelStartup() {
  const source = fs.readFileSync(path.join(__dirname, '../electron/services/taskService.cjs'), 'utf8');
  const start = source.indexOf('    startContentGeneration(payload) {');
  const end = source.indexOf('    pauseContentGeneration()', start);
  assert.ok(start >= 0 && end > start);
  for (const status of ['available', 'unavailable', 'untested', undefined]) {
    for (const [imageQuantity, useAiImages] of [['light', true], ['heavy', true], ['light', false], ['none', true]]) {
      const calls = [];
      const plan = { outlineWordControlSnapshot: {}, contentGenerationOptions: { imageQuantity, useAiImages } };
      const scope = {
        technicalPlanStore: { loadTechnicalPlan: () => plan },
        aiService: { getConfig() { calls.push('config'); return { image_model: { status } }; } },
        prepareContentGenerationStart() { calls.push('prepare'); return {}; },
        runContentGenerationTask() {}, runContentSectionRegenerationTask() {},
        startManagedTask() { calls.push('start'); },
        activeTasks: new Map(), isActiveTaskStatus: () => false,
      };
      require('node:vm').runInNewContext(`this.service = {${source.slice(start, end)}};`, scope);
      for (const payload of [{}, { regenerate: true }, { targetItemId: 'section' }, { resume: true }, { retryFailedSections: true }]) {
        calls.length = 0;
        if (imageQuantity !== 'none' && useAiImages && status !== 'available') {
          assert.throws(() => scope.service.startContentGeneration(payload), /已开启 AI 生图.*去设置-生图模型中点击测试，并配置可用渠道/);
          assert.deepEqual(calls, ['config']);
        } else {
          scope.service.startContentGeneration(payload);
          assert.equal(calls.at(-1), 'start');
          assert.equal(calls.includes('config'), imageQuantity !== 'none' && useAiImages);
        }
      }
    }
  }
  console.log('正文启动：读取已保存生图状态、不可用提前拦截、可用及关闭 AI/无图放行检查通过。');
}

// 所有产物位于独立中文临时目录，不读取或修改用户项目数据。
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '正文转Word检查-'));
  try {
    checkImageModelStartup();
    checkRetiredStageCleanup();
    checkExportNumbering();
    const agentDir = path.join(directory, 'agent-runtime', '正文会话');
    const outputDir = path.join(directory, '独立用户数据', 'workspace', 'technical-plan');
    await checkTask(agentDir, outputDir);
    if (process.argv.includes('--real-word')) await checkRealWord(agentDir, outputDir);
    const cleanupDir = path.join(directory, '去表格会话');
    const cleanupOutput = path.join(directory, '去表格用户数据', 'workspace', 'technical-plan');
    await checkTableCleanupTask(cleanupDir, cleanupOutput);
    if (process.argv.includes('--real-word')) await checkRealWord(cleanupDir, cleanupOutput, false);
    // 删除的仅是本检查创建的会话目录，正式输出目录必须位于它之外。
    assert.equal(path.dirname(agentDir), path.join(directory, 'agent-runtime'));
    fs.rmSync(agentDir, { recursive: true, force: true });
    assert.ok(fs.statSync(path.join(outputDir, 'f0000000-0000-4000-8000-000000000012.docx')).size > 0);
    assert.ok(fs.statSync(path.join(outputDir, 'a0000000-0000-4000-8000-000000000010.docx')).size > 0);
    console.log('Word 新保存位置、成功覆盖、失败保留、重试复用及删除会话后文件保留通过。');
  } finally {
    if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('正文转Word检查-')) fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
