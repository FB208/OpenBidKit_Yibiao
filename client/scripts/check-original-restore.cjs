// 在 client 目录执行：node scripts/check-original-restore.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, Module } = require('node:module');

const taskFile = path.resolve(__dirname, '../electron/services/contentGenerationTask.cjs');
const taskSource = fs.readFileSync(taskFile, 'utf8');
const context = { module: { exports: {} }, require: createRequire(taskFile) };
vm.runInNewContext(`${taskSource}\nmodule.exports = {
  buildAgentOriginalMaterialRestorePrompt, buildAgentOriginalMaterialRestoreFiles,
  normalizeOriginalRestoreAssignments, validateOriginalRestoreAssignments,
  normalizeOriginalMaterial, parseAgentJsonContent, textMetrics, now,
};`, context, { filename: taskFile });
const start = taskSource.indexOf('  async function restoreOriginalMaterialsIfNeeded(');
const end = taskSource.indexOf('  async function prepareSingleSectionPlan(', start);
const materialStart = taskSource.indexOf('  function buildOriginalMaterialFromSegments(');
const materialEnd = taskSource.indexOf('  function saveSectionAndContentPlan(', materialStart);
const statsStart = taskSource.indexOf('  function updateOriginalRestorationStats(');
assert.ok(start >= 0 && end > start && materialStart >= 0 && materialEnd > materialStart);
assert.ok(statsStart >= 0 && statsStart < start);

// 执行正式还原函数，验证长短原文均调用 Agent、回写来源，以及失败时不转普通请求。
async function checkOriginalRestore() {
  for (const [chars, fail] of [[30, false], [300000, false], [30, true]]) {
    const segment = { id: 'P001', title_path: ['实施方案'], content: '文'.repeat(chars), hash: 'source-hash', chars };
    const target = { item: { id: '1.1', title: '实施方案', description: '实施方法' } };
    const saved = [];
    let agentCalls = 0;
    const agentError = new Error('Agent 失败');
    const scope = {
      ...context.module.exports,
      hasOriginalPlan: true, originalPlanSegments: [segment], originalPlanSourceHash: 'plan-hash',
      originalPlanSegmentById: new Map([[segment.id, segment]]),
      targetItemId: '', regenerate: false, logs: [], contentStats: {}, leaves: [target], sections: {},
      projectOverview: '项目概述', bidAnalysisFactsText: '', globalFactTitlesText: '',
      getOriginalMaterialRuntimeState: () => ({ validRestored: saved.length > 0, sourceSegments: [segment], canRebuildRestoredContent: false }),
      getContentPlanForItem: () => ({ image_needed: true }),
      aiService: {
        getConfig: () => ({ context_length_limit: 400000 }),
        collectJsonResponse: () => assert.fail('还原映射不应调用普通 AI'),
      },
      runContentAgentTask: async (options) => {
        agentCalls += 1;
        assert.equal(options.outputFile, 'original-restore-result.json');
        assert.equal(options.files.find(file => file.path === 'original-segments.md').content.includes(segment.content), true);
        assert.match(options.files.find(file => file.path === 'restore-targets.md').content, /1\.1/);
        if (fail) throw agentError;
        const outputContent = JSON.stringify({ assignments: [{ node_id: target.item.id, source_ids: [segment.id] }] });
        options.validateOutput({ output_content: outputContent });
        return { agentResult: {}, outputContent };
      },
      saveSectionAndContentPlan: (item, section, content, plan) => saved.push({ item, section, content, plan }),
      writeDeveloperLog() {}, publishTaskUpdate() {}, pauseIfRequested() {},
      checkpointTask(task) {
        if (task.stats.original_restoration) {
          assert.equal(saved.length, 1, '统计必须在原文保存后持久化');
          assert.equal(task.stats.original_restoration.rate, 100);
        }
      },
      syncRuntime: () => ({}), statsSnapshot: () => ({ ...scope.contentStats }), progressFor: () => 0,
    };
    vm.createContext(scope);
    vm.runInContext(taskSource.slice(materialStart, materialEnd) + taskSource.slice(statsStart, end), scope);
    if (fail) {
      await assert.rejects(scope.restoreOriginalMaterialsIfNeeded([target]), error => error === agentError);
      assert.equal(saved.length, 0);
    } else {
      await scope.restoreOriginalMaterialsIfNeeded([target]);
      assert.equal(saved.length, 1);
      assert.equal(saved[0].content, segment.content);
      assert.equal(saved[0].section.status, 'idle');
      assert.equal(saved[0].plan.image_needed, true);
      assert.equal(saved[0].plan.original_material.source_ids[0], segment.id);
      assert.equal(saved[0].plan.original_material.source_hashes[0], segment.hash);
      assert.equal(saved[0].plan.original_material.restored, true);
      assert.equal(saved[0].plan.original_material.optimized, false);
      assert.equal(scope.contentStats.original_restoration.total_chars, chars);
    }
    assert.equal(agentCalls, 1);
  }
  console.log('原方案还原：长短输入统一 Agent、来源保存和失败传播检查通过。');
}

// 用真实来源有效性判断覆盖部分还原、重复来源、失效来源和已还原正文重建。
async function checkRestorationStats() {
  const segments = [100, 300].map((chars, index) => ({
    id: `P00${index + 1}`, content: '文'.repeat(chars), chars, hash: `hash-${index}`, title_path: [],
  }));
  const leaves = ['1', '2', '3'].map(id => ({ item: { id, content: '正文' } }));
  const plans = new Map();
  const scope = {
    ...context.module.exports,
    hasOriginalPlan: true, originalPlanSegments: segments, originalPlanSourceHash: 'plan-hash',
    originalPlanSegmentById: new Map(segments.map(segment => [segment.id, segment])),
    leaves, sections: {}, contentPlans: plans, contentStats: {},
    targetItemId: '', regenerate: false, logs: [],
    getStoredContentPlan: () => assert.fail('测试应提供明确的当前编排'),
    writeDeveloperLog() {}, publishTaskUpdate() {},
    runContentAgentTask: () => assert.fail('有效来源复用和重建不应执行 Agent'),
    checkpointTask: (task) => { scope.persistedStats = JSON.parse(JSON.stringify(task.stats)); },
    statsSnapshot: () => ({ ...scope.contentStats }), progressFor: () => 0, syncRuntime: () => ({}),
    saveSectionAndContentPlan(item, section, content, plan) {
      item.content = content;
      scope.sections[item.id] = section;
      plans.set(item.id, plan);
    },
  };
  const stateStart = taskSource.indexOf('  function getOriginalMaterialRuntimeState(');
  vm.createContext(scope);
  vm.runInContext(taskSource.slice(stateStart, materialEnd) + taskSource.slice(statsStart, end), scope);
  for (const { item } of leaves) plans.set(item.id, { original_material: scope.buildOriginalMaterialFromSegments([segments[0]]) });
  // 同一来源被三个小节引用仍只有 25%；正文扩写长度不改变统计。
  leaves[0].item.content = '扩写'.repeat(10000);
  scope.updateOriginalRestorationStats();
  assert.equal(scope.contentStats.original_restoration.rate, 25);
  assert.equal(scope.contentStats.original_restoration.restored_chars, 100);
  plans.set('3', { original_material: scope.buildOriginalMaterialFromSegments([segments[1]]) });
  await scope.restoreOriginalMaterialsIfNeeded([leaves[0]]);
  assert.equal(scope.persistedStats.original_restoration.rate, 100, '单小节操作仍统计全文来源');
  plans.get('3').original_material.source_hashes[0] = 'changed';
  scope.updateOriginalRestorationStats();
  assert.equal(scope.contentStats.original_restoration.rate, 25, '来源变化后不算有效回填');
  for (const { item } of leaves) item.content = '';
  scope.updateOriginalRestorationStats();
  assert.equal(scope.contentStats.original_restoration.rate, 0, '只有来源记录、没有正文不算回填');
  await scope.restoreOriginalMaterialsIfNeeded([leaves[0]]);
  assert.equal(scope.persistedStats.original_restoration.rate, 25, '重建保存后更新统计');
  scope.originalPlanSegments = [];
  scope.leaves = [];
  scope.updateOriginalRestorationStats();
  assert.equal(scope.contentStats.original_restoration.rate, null, '无可统计字符时不能显示 100%');
  scope.hasOriginalPlan = false;
  scope.contentStats = {};
  scope.leaves = new Proxy([], { get() { assert.fail('没有原方案时不能扫描小节'); } });
  scope.originalPlanSegments = new Proxy([], { get() { assert.fail('没有原方案时不能扫描原文'); } });
  scope.contentPlans = new Proxy(new Map(), { get() { assert.fail('没有原方案时不能读取来源记录'); } });
  assert.equal(scope.getOriginalMaterialRuntimeState(leaves[0].item).needsRestoreRepair, false);
  scope.updateOriginalRestorationStats();
  await scope.restoreOriginalMaterialsIfNeeded(leaves);
  assert.equal(scope.contentStats.original_restoration, undefined);
}

// 执行正式任务的统计恢复片段，检查暂停后恢复、全文重生和原方案替换。
function checkRestorationStatsResume() {
  const inputStart = taskSource.indexOf('  const hasOriginalPlan = Boolean(');
  const inputEnd = taskSource.indexOf('  const projectOverview =', inputStart);
  // 对象存在但原方案路径为空时，也不能读取文件、分段或计算指纹。
  vm.runInNewContext(taskSource.slice(inputStart, inputEnd), {
    storedPlan: { originalPlanFile: { markdownPath: '' } },
    workspaceStore: { readOriginalPlanMarkdown: () => assert.fail('无路径时不能读取原方案') },
    splitOriginalPlanSegments: () => assert.fail('无路径时不能分段'),
    textHash: () => assert.fail('无路径时不能计算指纹'),
  });
  const restoreStart = taskSource.indexOf('  const previousOriginalRestoration =');
  const restoreEnd = taskSource.indexOf('  contentRuntime = normalizeContentGenerationRuntime(', restoreStart);
  const saved = { source_hash: 'plan-hash', total_chars: 400, restored_chars: 100, rate: 25 };
  for (const [hasOriginalPlan, fullRegenerate, hash, expected] of [
    [true, false, 'plan-hash', 25], [true, true, 'plan-hash', undefined],
    [true, false, 'new-plan-hash', undefined], [false, false, 'plan-hash', undefined],
  ]) {
    const scope = { hasOriginalPlan, fullRegenerate, originalPlanSourceHash: hash, contentStats: {},
      previousState: { contentGenerationTask: { stats: { content: { original_restoration: saved } } } } };
    vm.runInNewContext(taskSource.slice(restoreStart, restoreEnd), scope);
    assert.equal(scope.contentStats.original_restoration?.rate, expected);
  }
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
      source_hash: sourceHash, total_chars: rate === null ? 0 : 400,
      restored_chars: rate === null ? 0 : rate * 4, rate,
    };
    const html = compiled.exports.render({ hasOriginalPlan, originalPlanContentHash: 'plan-hash',
      task: { status: 'success', stats: { content: { phase: 'done', original_restoration: stats } } } });
    if (expected === null) assert.ok(!html.includes('原方案还原率'));
    else assert.ok(html.includes(`原方案还原率 <strong>${expected}</strong>`));
    if (expected === '25.0%') assert.ok(html.includes('已回填 100 / 原文共 400 字符'));
  }
  console.log('正文页面：还原率、待统计、空内容、原方案替换和移除显示检查通过。');
}

// 顺序执行还原行为和统计检查，避免测试共享运行状态。
async function main() {
  await checkOriginalRestore();
  await checkRestorationStats();
  checkRestorationStatsResume();
  await checkRestorationStatsPage();
  console.log('原方案还原率：去重、全文统计、保存、重建、继续任务和无原方案跳过，检查通过。');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
