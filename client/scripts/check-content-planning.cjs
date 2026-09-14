// 在 client 目录执行：node scripts/check-content-planning.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Ajv = require('ajv');

// 在检查进程内读取正式编排函数，不增加产品导出或复制业务实现。
const taskFile = path.resolve(__dirname, '../electron/services/contentGenerationTask.cjs');
const context = { module: { exports: {} }, require: createRequire(taskFile), Set, Map };
const taskSource = fs.readFileSync(taskFile, 'utf8');
vm.runInNewContext(`${taskSource}\nmodule.exports = {
  CONTENT_PLANNING_JSON_SCHEMA, extractContentPlanningPlans, createStoredContentPlan,
  normalizeStoredContentPlan, buildContentPlanningOutline, formatContentPlanForPrompt,
  selectContentImageTargets, pruneContentGenerationPlans, now,
};`, context, { filename: taskFile });
const runtime = context.module.exports;
const validateSchema = new Ajv().compile(runtime.CONTENT_PLANNING_JSON_SCHEMA);

// 覆盖真实结果提取、JSON 保存回读及再次提交给 Agent 的链路。
function checkContentPlanning() {
  const source = [{
    id: '1', title: '实施方案', description: '项目实施方案', attr: '技术', children: [
      { id: '1.1', title: '实施流程', description: '说明实施步骤', content_mode: 'ai-generate' },
      { id: '1.2', title: '报价', description: '填写报价', content_mode: 'manual-fill' },
    ],
  }];
  const basePlan = { writing_focus: '说明各阶段实施步骤与交接关系。', knowledge: { item_ids: [] }, table: { needed: false, purpose: '' } };
  const promptBefore = runtime.formatContentPlanForPrompt(basePlan);
  for (const score of [0, 5, 10, undefined, null, -1, 11, 2.5, '8']) {
    const output = { outline: structuredClone(source) };
    const plan = { ...basePlan, ...(score === undefined ? {} : { image_suitability_score: score }) };
    output.outline[0].children[0].content_plan = plan;
    const valid = Number.isInteger(score) && score >= 0 && score <= 10;
    assert.equal(validateSchema(output), valid, `Schema score=${score}`);
    if (!valid) {
      assert.throws(() => runtime.extractContentPlanningPlans(output, source, new Set()), /配图适配性评分必须是 0-10 的整数/);
      assert.equal(runtime.normalizeStoredContentPlan(runtime.createStoredContentPlan(plan, 'none')), null);
      continue;
    }
    const extracted = runtime.extractContentPlanningPlans(output, source, new Set());
    assert.equal(extracted.size, 1);
    const stored = JSON.parse(JSON.stringify(runtime.createStoredContentPlan(extracted.get('1.1'), 'none')));
    assert.equal(runtime.normalizeStoredContentPlan(stored).plan.image_suitability_score, score);
    const rebuilt = runtime.buildContentPlanningOutline(source, { '1.1': stored });
    assert.equal(rebuilt[0].children[0].content_plan.image_suitability_score, score);
    assert.equal(Object.hasOwn(rebuilt[0], 'content_plan'), false);
    assert.equal(Object.hasOwn(rebuilt[0].children[1], 'content_plan'), false);
    assert.equal(validateSchema({ outline: rebuilt }), true);
    assert.equal(runtime.formatContentPlanForPrompt(stored.plan), promptBefore, '评分不得改变后续正文提示词');
  }
  const oldPlan = runtime.createStoredContentPlan(basePlan, 'none');
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(oldPlan)).plan, 'image_suitability_score'), false);
  const rebuiltOld = runtime.buildContentPlanningOutline(source, { '1.1': oldPlan });
  assert.equal(Object.hasOwn(rebuiltOld[0].children[0], 'content_plan'), false, '缺少评分的旧编排不复用');
  console.log('正文编排评分：边界检查、保存回读、再次编排、旧编排不复用及后续提示词不变，全部通过。');
}

checkContentPlanning();

// 检查比例以全文为分母、向下取整、同分顺序及 0 分不足不补足。
function checkImageSelection() {
  for (const [scores, quantity, expected] of [
    [[0, 8, 10, 8, 3, 0, 9], 'none', []],
    [[0, 8, 10, 8, 3, 0, 9], 'light', [2]],
    [[0, 8, 10, 8, 3, 0, 9], 'heavy', [2, 6, 1]],
    [[8, 8, 8, 8, 8], 'heavy', [0, 1]],
    [[1, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'heavy', [0]],
    [[0, 0, 0, 0, 0], 'heavy', []],
    [[10], 'light', []],
    [[10], 'heavy', []],
    [[], 'none', []],
  ]) {
    const leaves = scores.map((score, index) => ({ item: { id: String(index) } }));
    const plans = Object.fromEntries(scores.map((score, index) => [String(index), { plan: { image_suitability_score: score } }]));
    assert.deepEqual([...runtime.selectContentImageTargets(leaves, plans, quantity)], expected.map(String));
    assert.deepEqual(leaves.map(({ item }) => item.id), scores.map((_, index) => String(index)), '不得改变目录顺序');
  }
}

// 直接执行正式编排保存函数，验证单小节更新会重算全文标记并保留其他编排字段。
function checkImageSelectionPersistence() {
  const leaves = Array.from({ length: 10 }, (_, index) => ({ item: {
    id: String(index), title: '小节' + index, description: '小节说明', content_mode: 'ai-generate', attr: '技术',
  } }));
  const storedPlans = Object.fromEntries(leaves.map(({ item }, index) => [item.id, runtime.createStoredContentPlan({
    writing_focus: item.title, image_suitability_score: 9 - index, image_needed: index < 5,
    knowledge: { item_ids: ['knowledge-1'] }, table: { needed: false, purpose: '' },
    original_material: { restored: true, source_ids: ['source-' + index], restored_chars: 100 },
  }, 'none')]));
  const originalOther = JSON.parse(JSON.stringify(storedPlans['1']));
  const generatedPlans = new Map([['8', storedPlans['8'].plan]]);
  delete storedPlans['8'];
  const changedPlan = { ...storedPlans['9'].plan, image_suitability_score: 10 };
  let saved;
  const scope = {
    ...runtime, leaves, storedContentPlans: storedPlans, contentPlans: new Map([['9', changedPlan]]),
    tableRequirement: 'none', imageQuantity: 'light', logs: [], sections: {},
    syncRuntime: () => ({}), statsSnapshot: () => ({}), progressFor: () => 0,
    checkpointTask: (_task, patch) => { saved = JSON.parse(JSON.stringify(patch.contentGenerationPlans)); },
  };
  const start = taskSource.indexOf('  function persistContentPlans(');
  const end = taskSource.indexOf('  async function planAll()', start);
  assert.ok(start > 0 && end > start);
  vm.createContext(scope);
  vm.runInContext(taskSource.slice(start, end) + '\nthis.persist = persistContentPlans;', scope);
  scope.persist([leaves[9]], generatedPlans);
  assert.deepEqual(Object.keys(saved).filter(id => saved[id].plan.image_needed), ['0', '9']);
  assert.equal(saved['8'].plan.image_suitability_score, 1, '保留本轮补齐的小节评分');
  assert.deepEqual({ ...saved['1'].plan, image_needed: originalOther.plan.image_needed }, originalOther.plan, '其他小节只改变配图标记');
  assert.equal(saved['1'].table_requirement, originalOther.table_requirement);
  assert.equal(scope.contentPlans.get('9').image_needed, true);
  assert.equal(scope.contentPlans.get('1').image_needed, false);
  for (const { item } of leaves) {
    assert.equal(runtime.createStoredContentPlan(saved[item.id].plan, 'none').plan.image_needed, saved[item.id].plan.image_needed);
  }
  const agentOutline = runtime.buildContentPlanningOutline(leaves.map(({ item }) => item), saved);
  assert.equal(agentOutline.some(item => Object.hasOwn(item.content_plan, 'image_needed')), false, '标记不交给 Agent 决定');
  assert.equal(validateSchema({ outline: agentOutline }), true);
  scope.imageQuantity = 'none';
  scope.persist([leaves[9]], generatedPlans);
  assert.ok(Object.values(saved).every(value => value.plan.image_needed === false), '无图应清除之前选中的标记');
  console.log('配图标记：比例、同分、0 分排除、全文保存及单小节重算检查通过。');
}

checkImageSelection();
checkImageSelectionPersistence();

// 模拟 Agent 完成时已请求暂停，确认全文和单小节均先保存全部配图标记。
async function checkPlanningPauseOrder() {
  const leaves = [0, 5, 10, 9, 8].map((score, index) => ({ item: {
    id: String(index), title: '小节' + index, description: '小节说明', content_mode: 'ai-generate',
  } }));
  const generatedPlans = new Map(leaves.map(({ item }, index) => [item.id, {
    writing_focus: item.title, image_suitability_score: [0, 5, 10, 9, 8][index],
    knowledge: { item_ids: [] }, table: { needed: false, purpose: '' },
  }]));
  for (const single of [false, true]) {
    const paused = new Error('requested pause');
    let saved;
    const scope = {
      ...runtime, leaves, tasksToRun: single ? [leaves[3]] : leaves,
      contentPlans: new Map(), storedContentPlans: {}, contentStats: {}, logs: [], sections: {},
      tableRequirement: 'heavy', imageQuantity: 'light', runLimits: { maxTablesForRun: null },
      resume: false, storedPlan: {},
      refreshRunLimits() {}, getReusableStoredContentPlan: () => null,
      getOriginalMaterialRuntimeState: () => ({ originalMaterial: {} }),
      agentService: { hasPersistentTaskSession: () => false },
      CONTENT_PLANNING_AGENT_TASK_KEY: 'test',
      runContentPlanningAgent: async () => generatedPlans,
      publishTaskUpdate() {}, progressFor: () => 0, statsSnapshot: () => ({}), syncRuntime: () => ({}),
      checkpointTask: (_task, patch) => { saved = JSON.parse(JSON.stringify(patch.contentGenerationPlans)); },
      pauseIfRequested() {
        assert.ok(saved, '暂停前必须保存编排结果');
        assert.equal(Object.keys(saved).length, leaves.length);
        assert.ok(Object.values(saved).every(value => typeof value.plan.image_needed === 'boolean'));
        assert.deepEqual(Object.keys(saved).filter(id => saved[id].plan.image_needed), ['2']);
        throw paused;
      },
    };
    const saveStart = taskSource.indexOf('  function persistContentPlans(');
    const allEnd = taskSource.indexOf('  async function restoreOriginalMaterialsIfNeeded(', saveStart);
    const singleStart = taskSource.indexOf('  async function prepareSingleSectionPlan(');
    const singleEnd = taskSource.indexOf('  async function runOne(', singleStart);
    vm.createContext(scope);
    vm.runInContext(taskSource.slice(saveStart, allEnd) + taskSource.slice(singleStart, singleEnd)
      + '\nthis.run = ' + (single ? 'prepareSingleSectionPlan' : 'planAll') + ';', scope);
    await assert.rejects(scope.run(), error => error === paused);
    assert.equal(scope.contentStats.phase, 'planning', '暂停时仍处于编排步骤');
  }
  console.log('编排暂停顺序：全文和单小节均在配图标记处理并保存后暂停，检查通过。');
}

checkPlanningPauseOrder().catch(error => { console.error(error); process.exitCode = 1; });
