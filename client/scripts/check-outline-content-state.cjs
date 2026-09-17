// 在 client 下执行 node scripts/check-outline-content-state.cjs，使用系统临时目录和真实 SQLite。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-outline-check-'));
  const env = { ...process.env, YIBIAO_OUTLINE_CHECK_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('yibiao-outline-check-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
} else {
  const { app } = require('electron');
  app.setPath('userData', process.env.YIBIAO_OUTLINE_CHECK_DIR);

  // 覆盖真实目录保存、编号重映射、父子转换和数据库重新打开。
  async function check() {
    const { createSqliteDatabase } = require('../electron/services/sqliteDatabase.cjs');
    const { createTechnicalPlanStore } = require('../electron/services/technicalPlanStore.cjs');
    const { createTaskLogStore } = require('../electron/services/taskLogStore.cjs');
    const { ORIGINAL_RESTORATION_AGENT_TASK_KEY } = require('../electron/services/originalPlanRestorationAgentConfig.cjs');
    const { createPersistentAgentTask, deletePersistentAgentTask } = require('../electron/services/pi/piPersistentTaskStore.cjs');
    const { clearStalePiTaskArchives } = require('../electron/services/storageCleanupService.cjs');
    // 在隔离 userData 创建真实任务目录，检查启动保留和业务重置清理。
    const seedRestorationSession = () => {
      const task = createPersistentAgentTask(app, ORIGINAL_RESTORATION_AGENT_TASK_KEY, { session_file: 'session.jsonl' });
      fs.writeFileSync(path.join(task.paths.sessionsDir, 'session.jsonl'), '{}\n', 'utf8');
      fs.writeFileSync(path.join(task.paths.workspaceDir, 'original-restore-result.json'), '{}', 'utf8');
      return task.paths.taskRoot;
    };
    let database;
    let store;
    const open = () => {
      database = createSqliteDatabase(app);
      store = createTechnicalPlanStore({
        app, db: database.db, fileService: {}, configStore: { load: () => ({}) },
        taskLogStore: createTaskLogStore({ db: database.db }), agentService: { deletePersistentTask(key) { deletePersistentAgentTask(app, key); } },
      });
    };
    const leaf = (id, content = '') => ({ id, title: `小节${id}`, description: '原说明', content_mode: 'ai-generate', content });
    const plan = id => ({ plan_version: 5, table_requirement: 'none', updated_at: '2026-09-01T00:00:00.000Z', plan: {
      writing_focus: `重点${id}`, image_suitability_score: 8, image_needed: true,
      knowledge: { item_ids: [] }, table: { needed: false, purpose: '' },
    } });
    const seed = () => {
      store.updateTechnicalPlanWithoutReload({
        outlineData: { outline: [{ id: '1', title: '章一', description: '说明', children: [leaf('1.1', '正文甲'), leaf('1.2', '正文乙')] }, leaf('2', '正文丙')] },
        contentGenerationSections: Object.fromEntries(['1.1', '1.2', '2'].map(id => [id, { status: 'success' }])),
        contentGenerationPlans: Object.fromEntries(['1.1', '1.2', '2'].map(id => [id, plan(id)])),
        contentGenerationTask: { task_id: 'check-content', type: 'content-generation', status: 'success', progress: 100 },
        contentGenerationRuntime: { generation_started: true, completed_stages: ['planning', 'restoring', 'generating'] },
      });
    };
    const ids = outline => Object.fromEntries(outline.flatMap(item => [[item.id, item.id], ...Object.entries(ids(item.children || []))]));
    const save = (outline, reason, affectedNodeIds = [], idMap = ids(outline)) => store.saveOutline({ outlineData: { outline }, reason, affectedNodeIds, idMap });
    open();
    try {
      seed();
      let restorationRoot = seedRestorationSession();
      clearStalePiTaskArchives(app);
      assert.ok(fs.existsSync(restorationRoot), '启动清理必须保留还原持久工作区');
      let before = store.loadTechnicalPlan();
      let outline = structuredClone(before.outlineData.outline);
      outline[0].children[0].title = '修改后的标题';
      let result = save(outline, 'edit');
      assert.equal(result.contentGenerationSections['1.1'].title, '修改后的标题');
      assert.equal(result.contentGenerationSections['1.1'].content, '正文甲');
      assert.deepEqual(result.contentGenerationPlans, before.contentGenerationPlans);
      assert.deepEqual(result.contentGenerationRuntime, before.contentGenerationRuntime);
      assert.ok(fs.existsSync(restorationRoot), '仅改名不清理还原会话');

      outline.push(leaf('3'));
      result = save(outline, 'add-root');
      assert.equal(fs.existsSync(restorationRoot), false, '目录结构变化清理旧还原会话');
      assert.deepEqual(result.contentGenerationPlans, before.contentGenerationPlans);
      assert.equal(result.contentGenerationSections['2'].content, '正文丙');
      assert.deepEqual(result.contentGenerationRuntime.pending_item_ids, ['3']);
      assert.deepEqual(result.contentGenerationRuntime.direct_generation_item_ids, ['3']);
      database.close();
      open();
      assert.equal(store.loadTechnicalPlan().contentGenerationRuntime.generation_started, true, '目录变更与重启均不得解除锁定');
      assert.deepEqual(store.loadTechnicalPlan().contentGenerationRuntime.pending_item_ids, ['3']);

      // 已有叶子下添加子节点只清空父叶子；再添加同级子节点不得清空第一个子节点。
      outline = store.loadTechnicalPlan().outlineData.outline;
      outline[1].children = [leaf('2.1')];
      delete outline[1].content_mode;
      result = save(outline, 'add-child', ['2']);
      assert.equal(result.outlineData.outline[1].content, '');
      assert.equal(result.contentGenerationPlans['2'], undefined);
      assert.equal(result.contentGenerationSections['1.1'].content, '正文甲');
      assert.ok(result.contentGenerationRuntime.pending_item_ids.includes('2.1'));
      store.saveChapterContent({ nodeId: '2.1', content: '新增子节正文' });
      outline = store.loadTechnicalPlan().outlineData.outline;
      outline[1].children.push(leaf('2.2'));
      result = save(outline, 'add-child');
      assert.equal(result.contentGenerationSections['2.1'].content, '新增子节正文');

      // 删除最后一个子节点后，父节点重新成为需要编排、跳过还原的 AI 叶子。
      outline = result.outlineData.outline;
      outline[1] = leaf('2');
      result = save(outline, 'delete', ['2.1', '2.2']);
      assert.equal(result.contentGenerationPlans['2'], undefined);
      assert.ok(result.contentGenerationRuntime.pending_item_ids.includes('2'));
      assert.ok(result.contentGenerationRuntime.direct_generation_item_ids.includes('2'));
      assert.ok(!result.contentGenerationRuntime.pending_item_ids.includes('2.1'));
      assert.equal(result.contentGenerationSections['1.2'].content, '正文乙');

      // 删除后编号复用：被删除节点的待生成标记不得转移到占用该编号的旧正文。
      seed();
      store.updateTechnicalPlanWithoutReload({ contentGenerationRuntime: { generation_started: true, direct_generation_item_ids: ['1.1'], pending_item_ids: ['1.1'] } });
      before = store.loadTechnicalPlan();
      outline = structuredClone(before.outlineData.outline);
      outline[0].children = [{ ...outline[0].children[1], id: '1.1' }];
      result = save(outline, 'delete', ['1.1'], { '1': '1', '1.2': '1.1', '2': '2' });
      assert.equal(result.contentGenerationSections['1.1'].content, '正文乙');
      assert.deepEqual(result.contentGenerationPlans['1.1'], before.contentGenerationPlans['1.2']);
      assert.deepEqual(result.contentGenerationRuntime.pending_item_ids, []);
      assert.deepEqual(result.contentGenerationRuntime.direct_generation_item_ids, []);
      assert.equal(result.contentGenerationSections['2'].content, '正文丙');

      restorationRoot = seedRestorationSession();
      store.saveGlobalFacts([{ id: 'facts', title: '项目事实', content: '确认后的新事实' }]);
      result = store.loadTechnicalPlan();
      assert.equal(result.outlineData.outline[0].children[0].content || '', '');
      assert.deepEqual(result.contentGenerationPlans, {});
      assert.equal(result.contentGenerationRuntime, undefined, '清空正文后解除锁定');
      assert.equal(result.contentGenerationTask, undefined);
      assert.equal(fs.existsSync(restorationRoot), false, '修改全局事实清理还原会话');
      seed();
      restorationRoot = seedRestorationSession();
      store.updateTechnicalPlanWithoutReload({ invalidateContentGeneration: true });
      assert.equal(fs.existsSync(restorationRoot), false, '重置正文清理还原会话');
      assert.equal(store.loadTechnicalPlan().contentGenerationRuntime, undefined, '正文重置清除锁定');
      await checkFactsConfirmation();
      checkRestorationStart();
      console.log('目录状态：改名保留、增删局部影响、父子转换、编号重映射、重启锁定及清空确认检查通过。');
    } finally {
      database.close();
    }
  }

  // 执行正式任务启动入口，确保新一轮清理、暂停继续保留、无原方案不访问还原工作区。
  function checkRestorationStart() {
    const source = fs.readFileSync(path.join(__dirname, '../electron/services/taskService.cjs'), 'utf8');
    const start = source.indexOf('    startContentGeneration(payload) {');
    const end = source.indexOf('    pauseContentGeneration()', start);
    for (const [payload, hasOriginal, expectedDeletes] of [[{}, true, 1], [{ regenerate: true }, true, 1], [{ resume: true }, true, 0], [{ retryContentCorrection: true }, true, 0], [{ rerunIllustrations: true }, true, 0], [{}, false, 0]]) {
      let deletes = 0;
      const scope = {
        ORIGINAL_RESTORATION_AGENT_TASK_KEY: 'technical-plan-original-restoration', runContentGenerationTask() {},
        technicalPlanStore: { loadTechnicalPlan: () => ({ outlineWordControlSnapshot: {}, originalPlanFile: hasOriginal ? { markdownPath: 'original.md' } : null }) },
        agentService: { deletePersistentTask() { deletes += 1; } },
        startManagedTask(_type, _payload, _runner, _initial, options) { options.beforeStart(); },
      };
      vm.createContext(scope);
      vm.runInContext(`this.service = {${source.slice(start, end)}};`, scope);
      scope.service.startContentGeneration(payload);
      assert.equal(deletes, expectedDeletes);
    }
  }

  // 直接执行页面保存入口，确认有正文时先询问，取消不写入，确认后才保存。
  async function checkFactsConfirmation() {
    const ts = require('typescript');
    const source = fs.readFileSync(path.join(__dirname, '../src/features/technical-plan/pages/GlobalFactsPage.tsx'), 'utf8');
    const start = source.indexOf('  const saveFacts = async');
    const end = source.indexOf('  const saveActiveGroup =', start);
    let writes = 0;
    let pending;
    const scope = {
      mutationLocked: false, aiAdjustmentRunning: false, needsClearConfirmation: true,
      globalFacts: [], setPendingAction: value => { pending = value; },
      setSaving() {}, setSelectedGroupId() {}, showToast() {},
      onGlobalFactsSaved: async () => { writes += 1; },
    };
    vm.createContext(scope);
    const javascript = ts.transpile(source.slice(start, end) + '\nthis.saveFacts = saveFacts;', { target: ts.ScriptTarget.ES2022 });
    vm.runInContext(javascript, scope);
    await scope.saveFacts([{ id: 'new', title: '事实', content: '事实内容' }]);
    assert.equal(writes, 0);
    assert.equal(pending.facts[0].id, 'new');
    pending = null;
    assert.equal(writes, 0, '取消对话框不得写入');
    await scope.saveFacts([{ id: 'new', title: '事实', content: '事实内容' }], '已保存', true);
    assert.equal(writes, 1);
    scope.needsClearConfirmation = false;
    await scope.saveFacts([]);
    assert.equal(writes, 2, '无正文时直接保存');
  }

  app.whenReady().then(check).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
}
