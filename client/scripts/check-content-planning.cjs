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
  selectContentImageTargets, pruneContentGenerationPlans, getContentWordTarget, now,
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
  const basePlan = { target_words: 3000, writing_focus: '说明各阶段实施步骤与交接关系。', knowledge: { item_ids: [] }, table: { needed: false, purpose: '' } };
  for (const score of [0, 5, 10, undefined, null, -1, 11, 2.5, '8']) {
    const plan = { ...basePlan, ...(score === undefined ? {} : { image_suitability_score: score }) };
    const output = { plans: [{ id: source[0].children[0].id, content_plan: plan }] };
    const valid = Number.isInteger(score) && score >= 0 && score <= 10;
    assert.equal(validateSchema(output), valid, `Schema score=${score}`);
    if (!valid) {
      assert.throws(() => runtime.extractContentPlanningPlans(output, source, new Set()), /正文编排结果格式错误/);
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
    assert.equal(validateSchema({ plans: [{ id: rebuilt[0].children[0].id, content_plan: rebuilt[0].children[0].content_plan }] }), true);
  }
  const oldPlan = runtime.createStoredContentPlan(basePlan, 'none');
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(oldPlan)).plan, 'image_suitability_score'), false);
  const rebuiltOld = runtime.buildContentPlanningOutline(source, { 'e0000000-0000-4000-8000-000000000011': oldPlan });
  assert.equal(Object.hasOwn(rebuiltOld[0].children[0], 'content_plan'), false, '缺少评分的旧编排不复用');
  const partial = { plans: [] };
  assert.equal(runtime.extractContentPlanningPlans(partial, source, new Set(), new Set()).size, 0);
  console.log('正文编排评分：边界检查、保存回读、再次编排、旧编排不复用，全部通过。');
}

// 验证精简结果的目标完整性、身份关联和字段边界，目录只作为参考。
function checkPlanningResultContract() {
  const source = [{ id: 'parent', children: [
    { id: 'a', content_mode: 'ai-generate' }, { id: 'b', content_mode: 'ai-generate' },
    { id: 'manual', content_mode: 'manual-fill' },
  ] }];
  const snapshot = JSON.stringify(source);
  const plan = { writing_focus: '实施步骤', target_words: 3000, image_suitability_score: 5,
    knowledge: { item_ids: ['knowledge'] }, table: { needed: false, purpose: '' } };
  const row = id => ({ id, content_plan: structuredClone(plan) });
  const extract = (plans, ids = ['a', 'b']) => runtime.extractContentPlanningPlans({ plans }, source, new Set(['knowledge']), new Set(ids));
  const result = extract([row('b'), row('a')]);
  assert.deepEqual([...result.keys()], ['a', 'b'], '乱序返回仍按目录顺序关联，保证字数取整顺序稳定');
  assert.equal(extract([row('b')], ['b']).size, 1, '局部编排只提交目标节点');
  assert.throws(() => extract([row('a')]), /缺少目标节点：b/);
  assert.throws(() => extract([row('a'), row('a')]), /重复提交小节：a/);
  for (const id of ['unknown', 'parent', 'manual', 'b']) {
    assert.throws(() => extract([row('a'), row(id)], ['a']), /非目标 AI 小节/);
  }
  const checkInvalid = (change, pattern) => {
    const item = row('a');
    change(item);
    assert.throws(() => extract([item], ['a']), pattern);
  };
  checkInvalid(item => { item.content_plan.knowledge.item_ids = ['missing']; }, /不存在的知识库条目/);
  checkInvalid(item => { item.content_plan.table = { needed: true, purpose: ' ' }; }, /缺少表格用途/);
  checkInvalid(item => { item.content_plan.table.purpose = '不应提供'; }, /无表格目录/);
  for (const change of [
    item => { delete item.content_plan.target_words; },
    item => { item.content_plan.target_words = -1; },
    item => { item.content_plan.table.needed = 'false'; },
    item => { item.content_plan.image_needed = true; },
    item => { item.content_plan.knowledge.item_ids = ['knowledge', 'knowledge']; },
    item => { item.title = '不输出标题'; },
  ]) checkInvalid(change, /格式错误/);
  assert.throws(() => runtime.extractContentPlanningPlans({ outline: source }, source, new Set()), /格式错误/, '不兼容整棵目录输出');
  assert.equal(JSON.stringify(source), snapshot, '提取结果不改写参考目录');
  console.log('精简编排结果：目标完整性、乱序 ID、局部提交和非法字段检查通过。');
}

checkPlanningResultContract();

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
    target_words: 3000, writing_focus: item.title, image_suitability_score: 9 - index, image_needed: index < 5,
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
    wordControl: {}, tableRequirement: 'none', imageQuantity: 'light', logs: [], sections: {},
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
  assert.equal(validateSchema({ plans: agentOutline.filter(item => item.content_plan).map(({ id, content_plan }) => ({ id, content_plan })) }), true);
  scope.imageQuantity = 'none';
  scope.persist([leaves[9]], generatedPlans);
  assert.equal(saved['9'].plan.image_needed, false, '无图只改变本次目标标记');
  assert.deepEqual(saved['1'], originalOther);
  console.log('配图标记：比例、同分、0 分排除、全文计算与局部保存检查通过。');
}

checkImageSelection();
checkImageSelectionPersistence();

// 模拟 Agent 完成时已请求暂停，确认全文和单目标局部编排均先保存配图标记。
async function checkPlanningPauseOrder() {
  const leaves = [0, 5, 10, 9, 8].map((score, index) => ({ item: {
    id: String(index), number: String(index + 1), title: '小节' + index, description: '小节说明', content_mode: 'ai-generate',
  } }));
  const generatedPlans = new Map(leaves.map(({ item }, index) => [item.id, {
    target_words: 3000, writing_focus: item.title, image_suitability_score: [0, 5, 10, 9, 8][index],
    knowledge: { item_ids: [] }, table: { needed: false, purpose: '' },
  }]));
  for (const single of [false, true]) {
    const paused = new Error('requested pause');
    let saved;
    const scope = {
      ...runtime, leaves, tasksToRun: single ? [leaves[3]] : leaves,
      contentPlans: new Map(), storedContentPlans: {}, contentStats: {}, logs: [], sections: {},
      wordControl: {}, tableRequirement: 'heavy', imageQuantity: 'light', runLimits: { maxTablesForRun: null },
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
    vm.createContext(scope);
    vm.runInContext(taskSource.slice(saveStart, allEnd) + '\nthis.run = planAll;', scope);
    await assert.rejects(scope.run(), error => error === paused);
    assert.equal(scope.contentStats.phase, 'planning', '暂停时仍处于编排步骤');
  }
  console.log('编排暂停顺序：全文和单小节均在配图标记处理并保存后暂停，检查通过。');
}

checkPlanningPauseOrder().catch(error => { console.error(error); process.exitCode = 1; });
