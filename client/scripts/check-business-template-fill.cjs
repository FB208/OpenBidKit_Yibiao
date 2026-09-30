// 在 client 下执行 node scripts/check-business-template-fill.cjs。
// 使用中文临时目录中的真实 SQLite Store 与模拟 Agent/OpenXmlHelper，检查商务模版填写项、结果校验、并行编排、续跑和失效规则。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '商务模版填写检查-'));
  const env = { ...process.env, YIBIAO_BUSINESS_FILL_CHECK_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
} else {
  const { app } = require('electron');
  app.setPath('userData', process.env.YIBIAO_BUSINESS_FILL_CHECK_DIR);
  app.on('window-all-closed', () => {});

  const {
    buildFillUnits, buildFieldsInput, buildCredentialLibraryInput, parseFillResult, validateBusinessTemplateFillResult, FILL_OUTPUT_FILE,
  } = require('../electron/services/businessTemplateFillTask.cjs');
  const { BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY } = require('../electron/services/businessTemplateFillAgentConfig.cjs');
  const { CONTINUE_PROMPT } = require('../electron/services/contentGenerationAgent.cjs');

  const FIELDS = [
    { id: 'f0001', name: '投标人名称', fill_by: 'ai', kind: 'text' },
    { id: 'f0002', name: '投标人名称', fill_by: 'ai', kind: 'text' },
    { id: 'f0003', name: '企业类型', fill_by: 'ai', kind: 'choice', options: ['国有企业', '民营企业'] },
    { id: 'f0004', name: '项目名称', fill_by: 'ai', kind: 'text', table_id: 't7', row: 2 },
    { id: 'f0005', name: '合同金额', fill_by: 'ai', kind: 'text', table_id: 't7', row: 2 },
    { id: 'f0006', name: '项目名称', fill_by: 'ai', kind: 'text', table_id: 't7', row: 3 },
    { id: 'f0007', name: '合同金额', fill_by: 'ai', kind: 'text', table_id: 't7', row: 3 },
    { id: 'f0008', name: '开户银行', fill_by: 'ai', kind: 'text', table_id: 't9', row: 1 },
    { id: 'f0009', name: '法定代表人签字', fill_by: 'manual', kind: 'text' },
    { id: 'f0010', name: '营业执照', fill_by: 'manual', kind: 'attachment' },
  ];
  const VALID_RESULT = {
    values: [
      { name: '投标人名称', value: '某某科技有限公司' },
      { name: '企业类型', selected: ['民营企业'] },
      { name: '开户银行', value: '中国银行北京分行' },
    ],
    rows: [{ table_id: 't7', row: 2, values: [{ name: '项目名称', value: '智慧园区项目' }, { name: '合同金额', value: '128 万元' }] }],
    unresolved: [{ table_id: 't7', row: 3, reason: '资信库业绩不足' }],
  };

  // 普通项与逐行单元格的划分、结果校验和按 id 展开。
  function checkFillUnits() {
    const units = buildFillUnits(FIELDS);
    assert.deepEqual(units.map(unit => unit.key.replace(/\u0000/g, '|')), [
      'name|投标人名称', 'name|企业类型', 'row|t7|2|项目名称', 'row|t7|2|合同金额', 'row|t7|3|项目名称', 'row|t7|3|合同金额', 'name|开户银行',
    ], '表内单次出现的同名字段按普通项处理，附件和人工字段不参与');
    const input = buildFieldsInput(units);
    assert.deepEqual(input.fields.map(item => [item.name, item.count]), [['投标人名称', 2], ['企业类型', 1], ['开户银行', 1]]);
    assert.deepEqual(input.tables, [{ table_id: 't7', columns: [{ name: '项目名称', kind: 'text' }, { name: '合同金额', kind: 'text' }], rows: [2, 3] }]);

    const { entries, stats } = validateBusinessTemplateFillResult(parseFillResult(JSON.stringify(VALID_RESULT)), units);
    assert.deepEqual(entries.f0001, { value: '某某科技有限公司' });
    assert.deepEqual(entries.f0002, { value: '某某科技有限公司' }, '同名字段填同一个值');
    assert.deepEqual(entries.f0003, { selected: ['民营企业'] });
    assert.deepEqual([entries.f0004, entries.f0006], [{ value: '智慧园区项目' }, { unresolved_reason: '资信库业绩不足' }], '逐行填写');
    assert.equal(entries.f0009, undefined, '人工字段不写入');
    assert.deepEqual(stats, {
      field_count: 7,
      filled_count: 5,
      unresolved: [{ label: '项目名称（表格第3行）', reason: '资信库业绩不足' }, { label: '合同金额（表格第3行）', reason: '资信库业绩不足' }],
    });

    const invalid = {
      values: [{ name: '投标人名称', value: 'A' }, { name: '投标人名称', value: 'B' }, { name: '企业类型', value: '民营企业' }, { name: '未知字段', value: 'x' }],
      rows: [{ table_id: 't7', row: 9, values: [] }, { table_id: 't7', row: 2, values: [{ name: '项目名称', selected: ['x'] }] }],
      unresolved: [],
    };
    assert.throws(() => validateBusinessTemplateFillResult(parseFillResult(JSON.stringify(invalid)), units), (error) => {
      for (const pattern of [/“投标人名称” 重复出现/, /“企业类型” 是勾选项/, /“未知字段”不是普通待填字段/, /没有第 9 行/, /是文字字段，必须用 value/, /“开户银行” 尚未填写/]) {
        assert.match(error.message, pattern);
      }
      assert.ok(error.issues.length >= 8, '缺失项逐条计数');
      return true;
    });
    assert.throws(() => validateBusinessTemplateFillResult(parseFillResult(JSON.stringify({
      ...VALID_RESULT, values: VALID_RESULT.values.map(item => item.name === '企业类型' ? { name: '企业类型', selected: ['外资企业'] } : item),
    })), units), /选项不在 options 中：外资企业/);
    assert.throws(() => parseFillResult('{"values":[]}'), /结构无效/);

    const credential = buildCredentialLibraryInput({
      profile: { companyName: '某某科技有限公司', legalRepresentative: '王五', watermarkContent: '仅限投标', bankName: '中国银行', createdAt: '2026-01-01' },
      employees: [{ name: '张三', idValidityMode: 'long-term', createdAt: 'x' }],
      projects: [{ projectName: '智慧园区项目', projectType: 'service' }],
    });
    assert.deepEqual(credential.基本信息, { 公司名称: '某某科技有限公司', 法定代表人: '王五' });
    assert.deepEqual(credential.员工, [{ 姓名: '张三', 身份证有效期: '长期' }]);
    assert.deepEqual(credential.业绩, [{ 项目名称: '智慧园区项目', 项目类型: '服务' }]);
    assert.deepEqual(credential.财务信息, { 开户银行: '中国银行' }, '不含水印和时间戳');
    console.log('填写项与校验：普通项/逐行划分、同名映射、勾选项、缺失/未知/重复/类型不符及资信库输入通过。');
  }

  async function check() {
    checkFillUnits();
    const { createSqliteDatabase } = require('../electron/services/sqliteDatabase.cjs');
    const { createTechnicalPlanStore } = require('../electron/services/technicalPlanStore.cjs');
    const { createTaskLogStore } = require('../electron/services/taskLogStore.cjs');
    const { runContentGenerationTask } = require('../electron/services/contentGenerationTask.cjs');
    const deletedTasks = [];
    const database = createSqliteDatabase(app);
    const store = createTechnicalPlanStore({
      app, db: database.db, fileService: {}, configStore: { load: () => ({}) },
      taskLogStore: createTaskLogStore({ db: database.db }),
      agentService: { deletePersistentTask(key) { deletedTasks.push(key); }, loadPersistentTask() { return null; } },
    });
    const planDir = path.join(app.getPath('userData'), 'workspace', 'technical-plan');
    const templatePath = path.join(planDir, 'bid-template.docx');
    const fieldsPath = path.join(planDir, 'bid-template-fields.json');
    const blankPath = path.join(planDir, 'bid-template-blank.docx');
    const readFields = () => JSON.parse(fs.readFileSync(fieldsPath, 'utf8'));
    const seedTemplate = () => {
      fs.mkdirSync(planDir, { recursive: true });
      for (const file of fs.readdirSync(planDir)) fs.rmSync(path.join(planDir, file), { recursive: true, force: true });
      fs.writeFileSync(templatePath, '空白模版', 'utf8');
      fs.writeFileSync(fieldsPath, `${JSON.stringify({ version: 2, fields: FIELDS }, null, 2)}\n`, 'utf8');
    };
    const tempFiles = () => fs.readdirSync(planDir).filter(file => file.includes('.tmp'));

    // —— Store：底稿、写值和可回滚失效 ——
    seedTemplate();
    store.ensureBidTemplateBlank();
    assert.equal(fs.readFileSync(blankPath, 'utf8'), '空白模版');
    fs.writeFileSync(templatePath, '已填写模版', 'utf8');
    store.ensureBidTemplateBlank();
    assert.equal(fs.readFileSync(blankPath, 'utf8'), '空白模版', '已有底稿不重复复制');
    const units = buildFillUnits(FIELDS);
    store.saveBidTemplateFieldValues(validateBusinessTemplateFillResult(parseFillResult(JSON.stringify(VALID_RESULT)), units).entries);
    assert.equal(readFields().fields.find(field => field.id === 'f0002').value, '某某科技有限公司');
    assert.equal(Object.hasOwn(readFields().fields.find(field => field.id === 'f0009'), 'value'), false, '人工字段不动');
    fs.rmSync(blankPath);
    assert.throws(() => store.ensureBidTemplateBlank(), /缺少空白底稿/, '已填写的模版不能充当底稿');
    fs.writeFileSync(blankPath, '空白模版', 'utf8');

    database.db.exec("CREATE TEMP TRIGGER fail_content_reset BEFORE UPDATE OF content_generation_runtime_json ON technical_plan_meta BEGIN SELECT RAISE(ABORT, '模拟提交失败'); END;");
    assert.throws(() => store.updateTechnicalPlanWithoutReload({ invalidateContentGeneration: true }), /模拟提交失败/);
    assert.equal(fs.readFileSync(templatePath, 'utf8'), '已填写模版', '提交失败时恢复原模版');
    assert.equal(readFields().fields.find(field => field.id === 'f0001').value, '某某科技有限公司', '提交失败时恢复字段值');
    assert.deepEqual(tempFiles(), [], '回滚后不留暂存文件');
    database.db.exec('DROP TRIGGER fail_content_reset');
    store.updateTechnicalPlanWithoutReload({ invalidateContentGeneration: true });
    assert.equal(fs.readFileSync(templatePath, 'utf8'), '空白模版', '正文阶段重置后模版恢复为占位');
    assert.ok(readFields().fields.every(field => !['value', 'selected', 'unresolved_reason'].some(key => Object.hasOwn(field, key))));
    assert.ok(deletedTasks.includes(BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY), '清空正文时删除副 Agent 会话');
    assert.deepEqual(tempFiles(), []);
    fs.writeFileSync(templatePath, '未填写但被改动', 'utf8');
    store.resetBusinessTemplateFill();
    assert.equal(fs.readFileSync(templatePath, 'utf8'), '未填写但被改动', '没有填写值时不碰文件');

    const outline = ids => ({ project_name: '测试项目', project_overview: '', outline: ids.map(id => ({ id, title: `小节${id}`, description: '', content_mode: 'ai-generate' })) });
    store.saveOutline({ outlineData: outline(['a', 'b']), reason: 'replace' });
    store.updateTechnicalPlanWithoutReload({ contentGenerationRuntime: { generation_started: true, business_fill: { phase: 'completed', status: 'success' } } });
    store.saveOutline({ outlineData: outline(['a']), reason: 'delete', affectedNodeIds: ['b'] });
    assert.equal(store.loadTechnicalPlan().contentGenerationRuntime.business_fill.phase, 'completed', '局部目录变更保留商务模版状态');
    store.saveBidTemplateFieldValues({ f0001: { value: '某某科技有限公司' } });
    fs.writeFileSync(templatePath, '已填写模版', 'utf8');
    store.saveOutline({ outlineData: outline(['a']), reason: 'replace' });
    assert.equal(fs.readFileSync(templatePath, 'utf8'), '空白模版', '整目录替换清空正文时模版恢复为占位');
    console.log('Store：底稿复制、写值、提交失败回滚（含新建文件清理）、正文重置与整目录替换失效、未填写不动文件通过。');

    // —— 正文任务编排：仅副 Agent、失败重试、暂停继续、并行等待与中断 ——
    const mainDir = path.join(app.getPath('userData'), '正文会话');
    const outputDir = path.join(app.getPath('userData'), '正文 Word');
    const leafId = '10000000-0000-4000-8000-000000000001';
    const templateLeaf = { id: '20000000-0000-4000-8000-000000000002', number: '2', title: '商务文件', content_mode: 'template-fill' };
    fs.mkdirSync(path.join(mainDir, '正文'), { recursive: true });
    fs.writeFileSync(path.join(mainDir, '正文编排决策.json'), JSON.stringify({ targets: [{ id: leafId, number: '1', title: '施工方案', file: `正文/${leafId}.html` }] }), 'utf8');
    fs.writeFileSync(path.join(mainDir, '正文生成结果.json'), JSON.stringify({ sections: [{ section_id: leafId, file: `正文/${leafId}.html`, words: 6 }] }), 'utf8');
    fs.writeFileSync(path.join(mainDir, `正文/${leafId}.html`), '<!-- yibiao:block -->\n<p>施工准备与检查</p>', 'utf8');
    fs.writeFileSync(path.join(mainDir, '所选模板配置.json'), JSON.stringify({ config: {} }), 'utf8');
    fs.mkdirSync(outputDir, { recursive: true });

    function createHarness({ withAiLeaf, runtime = {}, task, runTask, runJob, convert }) {
      const state = {
        outlineData: { project_name: '测试项目', project_overview: '项目概述', outline: withAiLeaf
          ? [{ id: leafId, number: '1', title: '施工方案', content_mode: 'ai-generate' }, templateLeaf] : [templateLeaf] },
        globalFacts: [{ title: '项目名称', content: '智慧园区项目' }],
        globalFactsTask: { status: 'success' },
        outlineWordControlSnapshot: { enabled: false, minimumWords: 0, maximumWords: 0, sectionWords: 0 },
        contentGenerationOptions: { imageQuantity: 0, tableRequirement: 'heavy' },
        contentGenerationSections: withAiLeaf ? { [leafId]: { id: leafId, title: '施工方案', status: 'success', content: '' } } : {},
        contentGenerationPlans: {},
        contentGenerationRuntime: runtime,
        contentGenerationTask: task,
      };
      const calls = { runTask: [], runJob: [], convert: 0, checkpoints: [] };
      const sessions = new Set(harnessSessions);
      let pauseRequested = false;
      const persistent = harnessPersistent;
      const agentService = {
        hasPersistentTaskSession: key => sessions.has(key),
        loadPersistentTask: key => ({ state: persistent[key] || {} }),
        updatePersistentTask(key, patch) { persistent[key] = { ...(persistent[key] || {}), ...patch }; },
        deletePersistentTask(key) { sessions.delete(key); harnessSessions.delete(key); delete persistent[key]; deletedTasks.push(key); },
        async runTask(payload) {
          calls.runTask.push(payload);
          sessions.add(payload.persistent_task.task_key);
          harnessSessions.add(payload.persistent_task.task_key);
          persistent[payload.persistent_task.task_key] = { prompted_stage: payload.initial_stage };
          return runTask(payload, { pause: () => { pauseRequested = true; } });
        },
      };
      const apply = (partial, workspace) => {
        state.contentGenerationTask = { ...(state.contentGenerationTask || {}), ...partial, status: partial.status || state.contentGenerationTask?.status };
        Object.assign(state, workspace || {});
      };
      const args = {
        aiService: { getConfig: () => ({ concurrency_limit: 10 }) },
        agentService,
        workspaceStore: {
          ...store,
          loadTechnicalPlan: () => structuredClone(state),
          readTenderMarkdown: () => '# 招标文件\n投标有效期 90 天。',
          getContentWordOutputDir: () => outputDir,
        },
        credentialLibraryService: { load: () => ({ profile: { companyName: '某某科技有限公司' }, employees: [], projects: [], certificates: [], otherMaterials: [] }) },
        openXmlHelperService: {
          async runJob(job) {
            calls.runJob.push(job);
            if (runJob) await runJob(job);
            fs.writeFileSync(templatePath, `已填写：${job.request.values.length}`, 'utf8');
            return { ok: true };
          },
          async createRestrictedHtmlDocx() {
            calls.convert += 1;
            if (convert) return convert();
            return { bytes: Buffer.from('正文 Word'), imageWarnings: [] };
          },
        },
        knowledgeBaseService: {},
        templateStore: {},
        updateTask: (partial, workspace) => apply(partial, workspace),
        checkpointTask: (partial, workspace) => {
          calls.checkpoints.push({ status: partial.status, business: structuredClone(workspace?.contentGenerationRuntime?.business_fill) });
          apply(partial, workspace);
        },
        taskControl: { signal: new AbortController().signal, isPauseRequested: () => pauseRequested },
      };
      return { state, calls, args, persistent };
    }
    // 持久会话与其状态跨多次运行保留，模拟 Pi 持久任务目录。
    const harnessSessions = new Set();
    const harnessPersistent = {};
    const resetSessions = () => {
      harnessSessions.clear();
      for (const key of Object.keys(harnessPersistent)) delete harnessPersistent[key];
    };
    // 模拟 Runtime：写结果、按提交校验退回一次后返回结果。
    const agentWrites = result => async (payload) => {
      assert.equal(payload.output_file, FILL_OUTPUT_FILE);
      assert.ok(payload.json_validation_schemas[FILL_OUTPUT_FILE]);
      await assert.rejects(Promise.resolve().then(() => payload.validateOutput({ output_content: JSON.stringify({ ...result, values: [] }) })), /尚未填写或列入 unresolved/);
      const content = JSON.stringify(result);
      payload.validateOutput({ output_content: content });
      return { output_content: content, task_id: payload.task_id };
    };
    const blockUntilAbort = payload => new Promise((_, reject) => {
      payload.signal.addEventListener('abort', () => reject(payload.signal.reason), { once: true });
    });
    const fieldValue = id => readFields().fields.find(field => field.id === id);

    // 1. 仅副 Agent：无 AI 小节时直接填写并回填。
    seedTemplate();
    let harness = createHarness({ withAiLeaf: false, runTask: agentWrites(VALID_RESULT) });
    await runContentGenerationTask({ ...harness.args, payload: {} });
    assert.equal(harness.state.contentGenerationTask.status, 'success');
    assert.equal(harness.state.contentGenerationTask.progress_detail.mode, 'business');
    assert.equal(harness.calls.runTask.length, 1);
    const firstRun = harness.calls.runTask[0];
    assert.equal(firstRun.primary_session, true, '仅副 Agent 时作为主 Session');
    assert.equal(firstRun.persistent_task.mode, 'create');
    assert.deepEqual(firstRun.files.map(file => file.path), ['商务模版待填字段.json', '资信库.json', '招标文件.md', '招标关键信息.md', '全局事实设定.md']);
    assert.match(firstRun.files.find(file => file.path === '全局事实设定.md').content, /## 项目名称\n智慧园区项目/);
    assert.equal(harness.calls.runJob.length, 1);
    assert.equal(harness.calls.runJob[0].action, 'fill-template-fields');
    assert.equal(harness.calls.runJob[0].request.input, 'technical-plan/bid-template-blank.docx');
    assert.deepEqual(harness.calls.runJob[0].request.values.find(item => item.id === 'f0003'), { id: 'f0003', selected: ['民营企业'] });
    assert.equal(harness.calls.runJob[0].request.values.some(item => item.id === 'f0006'), false, '无法确定的字段保留占位');
    assert.equal(fieldValue('f0006').unresolved_reason, '资信库业绩不足');
    const fill = harness.state.contentGenerationRuntime.business_fill;
    assert.deepEqual([fill.phase, fill.status, fill.filled_count, fill.manual_count, fill.unresolved.length], ['completed', 'success', 5, 2, 2]);
    assert.equal(fs.readFileSync(blankPath, 'utf8'), '空白模版', '首轮填写前从刚提取的模版复制底稿');
    assert.equal(fs.readFileSync(templatePath, 'utf8'), '已填写：6');
    const completedState = structuredClone(harness.state);

    // 2. 全文重新生成：重置值、删除旧会话并新建会话。
    deletedTasks.length = 0;
    harness = createHarness({ withAiLeaf: false, runtime: completedState.contentGenerationRuntime, task: completedState.contentGenerationTask,
      runTask: async (payload) => {
        assert.equal(fs.readFileSync(templatePath, 'utf8'), '空白模版', '新一轮开始前模版已恢复为占位');
        assert.equal(Object.hasOwn(fieldValue('f0001'), 'value'), false);
        return agentWrites(VALID_RESULT)(payload);
      } });
    await runContentGenerationTask({ ...harness.args, payload: { regenerate: true } });
    assert.ok(deletedTasks.includes(BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY));
    assert.equal(harness.calls.runTask[0].persistent_task.mode, 'create');
    assert.equal(harness.state.contentGenerationTask.status, 'success');

    // 3. 回填失败：值已保存，重试只重新回填 Word，不再运行副 Agent。
    seedTemplate();
    resetSessions();
    harness = createHarness({ withAiLeaf: false, runTask: agentWrites(VALID_RESULT), runJob: async () => { throw new Error('模拟 Word 占用'); } });
    await assert.rejects(runContentGenerationTask({ ...harness.args, payload: {} }), /商务模版填写失败：模拟 Word 占用/);
    assert.equal(harness.state.contentGenerationTask.status, 'error');
    assert.deepEqual([harness.state.contentGenerationRuntime.business_fill.phase, harness.state.contentGenerationRuntime.business_fill.status], ['rendering', 'error']);
    let failedState = structuredClone(harness.state);
    harness = createHarness({ withAiLeaf: false, runtime: failedState.contentGenerationRuntime, task: failedState.contentGenerationTask,
      runTask: async () => assert.fail('值已保存时不应再运行副 Agent') });
    await runContentGenerationTask({ ...harness.args, previousState: failedState, payload: { retryFailedSections: true } });
    assert.equal(harness.calls.runJob.length, 1);
    assert.equal(harness.state.contentGenerationTask.status, 'success');

    // 4. 副 Agent 失败：重试续接原会话，只发送继续语，不重写输入。
    seedTemplate();
    resetSessions();
    harness = createHarness({ withAiLeaf: false, runTask: async () => { throw new Error('模拟模型失败'); } });
    await assert.rejects(runContentGenerationTask({ ...harness.args, payload: {} }), /商务模版填写失败：模拟模型失败/);
    assert.equal(harness.persistent[BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY].status, 'error');
    failedState = structuredClone(harness.state);
    harness = createHarness({ withAiLeaf: false, runtime: failedState.contentGenerationRuntime, task: failedState.contentGenerationTask, runTask: agentWrites(VALID_RESULT) });
    await runContentGenerationTask({ ...harness.args, previousState: failedState, payload: { retryFailedSections: true } });
    assert.equal(harness.calls.runTask[0].persistent_task.mode, 'resume');
    assert.equal(harness.calls.runTask[0].prompt, CONTINUE_PROMPT);
    assert.deepEqual(harness.calls.runTask[0].files, []);
    assert.equal(harness.state.contentGenerationTask.status, 'success');

    // 5. 暂停与继续：暂停保留会话，继续从原会话接着处理。
    seedTemplate();
    resetSessions();
    harness = createHarness({ withAiLeaf: false, runTask: (payload, control) => {
      setTimeout(control.pause, 10);
      return blockUntilAbort(payload);
    } });
    await runContentGenerationTask({ ...harness.args, payload: {} });
    assert.equal(harness.state.contentGenerationTask.status, 'paused');
    assert.equal(harness.state.contentGenerationRuntime.business_fill.status, 'paused');
    assert.match(harness.state.contentGenerationTask.logs.at(-1), /商务模版填写已暂停/);
    assert.equal(harness.persistent[BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY].status, 'paused');
    const pausedState = structuredClone(harness.state);
    harness = createHarness({ withAiLeaf: false, runtime: pausedState.contentGenerationRuntime, task: pausedState.contentGenerationTask, runTask: agentWrites(VALID_RESULT) });
    await runContentGenerationTask({ ...harness.args, previousState: pausedState, payload: { resume: true } });
    assert.equal(harness.calls.runTask[0].persistent_task.mode, 'resume');
    assert.equal(harness.state.contentGenerationTask.status, 'success');
    console.log('仅副 Agent：填写与回填、全文重生重置、回填失败只重试 Word、Agent 失败续接原会话、暂停继续通过。');

    // 6. 并行：正文已完成 Word 转换，失败重试只续接副 Agent，且等副流程完成后才提交成功。
    fs.writeFileSync(path.join(outputDir, `${encodeURIComponent(leafId)}.docx`), '正文 Word', 'utf8');
    const mainRuntime = {
      generation_started: true, phase: 'word-completed', section_words: { [leafId]: 6 },
      html_output: { workspace_dir: mainDir, word_output_dir: outputDir, word_sections: [{ section_id: leafId, file: `${encodeURIComponent(leafId)}.docx` }] },
      business_fill: { phase: 'filling', status: 'error', field_count: 0, filled_count: 0, manual_count: 0, unresolved: [], error: '模拟模型失败' },
    };
    let resolveAgent;
    harness = createHarness({ withAiLeaf: true, runtime: mainRuntime, task: { status: 'error', stats: { content: { phase: 'word-completed' } } },
      runTask: payload => new Promise((resolve) => { resolveAgent = () => resolve(agentWrites(VALID_RESULT)(payload)); }) });
    const parallelRun = runContentGenerationTask({ ...harness.args, previousState: structuredClone(harness.state), payload: { retryFailedSections: true } });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.notEqual(harness.state.contentGenerationTask.status, 'success', '副流程完成前不提交成功');
    resolveAgent();
    await parallelRun;
    assert.equal(harness.calls.convert, 0, '重试不重跑正文和已完成的 Word 转换');
    assert.equal(harness.calls.runTask[0].persistent_task.mode, 'resume');
    assert.equal(harness.calls.runTask[0].primary_session, false, '并行时副 Agent 不抢占主 Session');
    assert.equal(harness.state.contentGenerationTask.status, 'success');
    assert.equal(harness.calls.checkpoints.at(-1).business.phase, 'completed', '成功与商务模版完成状态同一次提交');

    // 7. 并行：正文转换失败时先中止副流程，记为中断并保留会话。
    fs.rmSync(path.join(outputDir, `${encodeURIComponent(leafId)}.docx`));
    seedTemplate();
    resetSessions();
    harness = createHarness({ withAiLeaf: true, runtime: { ...mainRuntime, business_fill: undefined }, task: { status: 'error', stats: { content: { phase: 'word-converting' } } },
      runTask: payload => blockUntilAbort(payload),
      convert: async () => { await new Promise(resolve => setTimeout(resolve, 20)); throw new Error('模拟转换失败'); } });
    await assert.rejects(runContentGenerationTask({ ...harness.args, previousState: structuredClone(harness.state), payload: { retryFailedSections: true } }), /模拟转换失败/);
    assert.equal(harness.state.contentGenerationTask.status, 'error');
    assert.deepEqual([harness.state.contentGenerationRuntime.business_fill.phase, harness.state.contentGenerationRuntime.business_fill.status], ['filling', 'interrupted']);
    assert.ok(harnessSessions.has(BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY), '中断后保留副 Agent 会话');
    console.log('并行编排：等待副流程后才成功、重试只续接副 Agent、正文失败时副流程中断并保留会话通过。');
    database.close?.();
  }

  app.whenReady().then(check).then(() => {
    console.log('商务模版填写检查通过。');
    app.exit(0);
  }, (error) => {
    console.error(error);
    app.exit(1);
  });
}
