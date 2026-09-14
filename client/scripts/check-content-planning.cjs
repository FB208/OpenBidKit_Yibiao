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
vm.runInNewContext(`${fs.readFileSync(taskFile, 'utf8')}\nmodule.exports = {
  CONTENT_PLANNING_JSON_SCHEMA, extractContentPlanningPlans, createStoredContentPlan,
  normalizeStoredContentPlan, buildContentPlanningOutline, formatContentPlanForPrompt,
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
