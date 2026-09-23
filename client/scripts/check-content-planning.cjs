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
  normalizeStoredContentPlan, buildContentPlanningOutline,
  selectContentImageTargets, pruneContentGenerationPlans, now,
};`, context, { filename: taskFile });
const runtime = context.module.exports;
const validateSchema = new Ajv().compile(runtime.CONTENT_PLANNING_JSON_SCHEMA);

// 覆盖真实结果提取、JSON 保存回读及再次提交给 Agent 的链路。
function checkContentPlanning() {
  const source = [{
    id: '10000000-0000-4000-8000-000000000001', number: '1', title: '实施方案', description: '项目实施方案', attr: '技术', children: [
      { id: 'e0000000-0000-4000-8000-000000000011', number: '1.1', title: '实施流程', description: '说明实施步骤', content_mode: 'ai-generate' },
      { id: 'f0000000-0000-4000-8000-000000000012', number: '1.2', title: '报价', description: '填写报价', content_mode: 'manual-fill' },
    ],
  }];
  const basePlan = { writing_focus: '说明各阶段实施步骤与交接关系。', knowledge: { item_ids: [] }, table: { needed: false, purpose: '' } };
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
    const stored = JSON.parse(JSON.stringify(runtime.createStoredContentPlan(extracted.get('e0000000-0000-4000-8000-000000000011'), 'none')));
    assert.equal(runtime.normalizeStoredContentPlan(stored).plan.image_suitability_score, score);
    const rebuilt = runtime.buildContentPlanningOutline(source, { 'e0000000-0000-4000-8000-000000000011': stored });
    assert.equal(rebuilt[0].children[0].content_plan.image_suitability_score, score);
    assert.equal(Object.hasOwn(rebuilt[0], 'content_plan'), false);
    assert.equal(Object.hasOwn(rebuilt[0].children[1], 'content_plan'), false);
    assert.equal(validateSchema({ outline: rebuilt }), true);
  }
  const oldPlan = runtime.createStoredContentPlan(basePlan, 'none');
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(oldPlan)).plan, 'image_suitability_score'), false);
  const rebuiltOld = runtime.buildContentPlanningOutline(source, { 'e0000000-0000-4000-8000-000000000011': oldPlan });
  assert.equal(Object.hasOwn(rebuiltOld[0].children[0], 'content_plan'), false, '缺少评分的旧编排不复用');
  const partial = { outline: structuredClone(source) };
  assert.equal(runtime.extractContentPlanningPlans(partial, source, new Set(), new Set()).size, 0);
  console.log('正文编排评分：边界检查、保存回读、再次编排、旧编排不复用，全部通过。');
}

checkContentPlanning();

// 检查比例以全文为分母、向下取整、同分顺序及 0 分不足不补足。
function checkImageSelection() {
  for (const [scores, quantity, expected] of [
    [[0, 8, 10, 8, 3, 0, 9], 'none', []],
    [[0, 8, 10, 8, 3, 0, 9], 'light', [2, 6]],
    [[0, 8, 10, 8, 3, 0, 9], 'heavy', [2, 6, 1, 3]],
    [[8, 8, 8, 8, 8], 'heavy', [0, 1, 2]],
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

// 直接执行正式编排保存函数，验证单小节只更新自己的编排和标记，保留其他节点。
function checkImageSelectionPersistence() {
  const leaves = Array.from({ length: 10 }, (_, index) => ({ item: {
    id: String(index), number: String(index + 1), title: '小节' + index, description: '小节说明', content_mode: 'ai-generate', attr: '技术',
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
  assert.deepEqual(Object.keys(saved).filter(id => saved[id].plan.image_needed), ['0', '1', '2', '3', '4', '9']);
  assert.equal(saved['8'], undefined, '不得补写非目标小节，即使 Agent 返回了结果');
  assert.deepEqual(saved['1'], originalOther, '其他小节包括配图标记和保存时间全部不变');
  assert.equal(saved['1'].table_requirement, originalOther.table_requirement);
  assert.equal(scope.contentPlans.get('9').image_needed, true);
  assert.equal(scope.contentPlans.has('1'), false);
  for (const { item } of leaves.filter(({ item }) => saved[item.id])) {
    assert.equal(runtime.createStoredContentPlan(saved[item.id].plan, 'none').plan.image_needed, saved[item.id].plan.image_needed);
  }
  const agentOutline = runtime.buildContentPlanningOutline(leaves.map(({ item }) => item), saved);
  assert.equal(agentOutline.some(item => item.content_plan && Object.hasOwn(item.content_plan, 'image_needed')), false, '标记不交给 Agent 决定');
  assert.equal(validateSchema({ outline: agentOutline }), true);
  scope.imageQuantity = 'none';
  scope.persist([leaves[9]], generatedPlans);
  assert.equal(saved['9'].plan.image_needed, false, '无图只改变本次目标标记');
  assert.deepEqual(saved['1'], originalOther);
  console.log('配图标记：比例、同分、0 分排除、全文计算与局部保存检查通过。');
}

checkImageSelection();
checkImageSelectionPersistence();

// 模拟 Agent 完成时已请求暂停，确认全文和单小节均先保存全部配图标记。
async function checkPlanningPauseOrder() {
  const leaves = [0, 5, 10, 9, 8].map((score, index) => ({ item: {
    id: String(index), number: String(index + 1), title: '小节' + index, description: '小节说明', content_mode: 'ai-generate',
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
      runContentPlanningAgent: async (ids) => {
        assert.deepEqual([...ids], single ? ['3'] : leaves.map(({ item }) => item.id), '仅将本次目标交给 Agent');
        return generatedPlans;
      },
      publishTaskUpdate() {}, progressFor: () => 0, statsSnapshot: () => ({}), syncRuntime: () => ({}),
      checkpointTask: (_task, patch) => { saved = JSON.parse(JSON.stringify(patch.contentGenerationPlans)); },
      pauseIfRequested() {
        assert.ok(saved, '暂停前必须保存编排结果');
        assert.equal(Object.keys(saved).length, single ? 1 : leaves.length);
        assert.ok(Object.values(saved).every(value => typeof value.plan.image_needed === 'boolean'));
        assert.deepEqual(Object.keys(saved).filter(id => saved[id].plan.image_needed), single ? ['3'] : ['2']);
        throw paused;
      },
    };
    const saveStart = taskSource.indexOf('  function persistContentPlans(');
    const allEnd = taskSource.indexOf('  async function restoreOriginalMaterialsIfNeeded(', saveStart);
    const singleStart = taskSource.indexOf('  async function prepareSingleSectionPlan(');
    const singleEnd = taskSource.indexOf('  async function runContentGeneration(', singleStart);
    vm.createContext(scope);
    vm.runInContext(taskSource.slice(saveStart, allEnd) + taskSource.slice(singleStart, singleEnd)
      + '\nthis.run = ' + (single ? 'prepareSingleSectionPlan' : 'planAll') + ';', scope);
    await assert.rejects(scope.run(), error => error === paused);
    assert.equal(scope.contentStats.phase, 'planning', '暂停时仍处于编排步骤');
  }
  console.log('编排暂停顺序：全文和单小节均在配图标记处理并保存后暂停，检查通过。');
}

checkPlanningPauseOrder().catch(error => { console.error(error); process.exitCode = 1; });
