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
    const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
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
  // 关闭测试窗口后仍等待异步清理和断言完成，由脚本统一设置退出码。
  app.on('window-all-closed', () => {});

  // 覆盖真实目录保存、稳定身份排序、父子转换和数据库重新打开。
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
        outlineData: { outline: [{ id: '00000000-0000-4000-8000-000000000001', title: '章一', description: '说明', children: [leaf('00000000-0000-4000-8000-000000000004', '正文甲'), leaf('00000000-0000-4000-8000-000000000005', '正文乙')] }, leaf('00000000-0000-4000-8000-000000000002', '正文丙')] },
        contentGenerationSections: Object.fromEntries(['00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000002'].map(id => [id, { status: 'success' }])),
        contentGenerationPlans: Object.fromEntries(['00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000002'].map(id => [id, plan(id)])),
        contentGenerationTask: { task_id: 'check-content', type: 'content-generation', status: 'success', progress: 100 },
        contentGenerationRuntime: { generation_started: true, completed_stages: ['planning', 'restoring', 'generating'] },
      });
    };
    const save = (outline, reason, affectedNodeIds = []) => store.saveOutline({ outlineData: { outline }, reason, affectedNodeIds });
    open();
    try {
      // Word 读取只依赖业务目录，不依赖当前任务清单；每次读取都取得最新文件。
      const wordSectionId = '读取检查 中文';
      const wordPath = path.join(store.getContentWordOutputDir(), `${encodeURIComponent(wordSectionId)}.docx`);
      assert.equal(await store.readContentWord(wordSectionId), null);
      fs.mkdirSync(path.dirname(wordPath), { recursive: true });
      const firstWord = Buffer.from([0x50, 0x4b, 0, 255, 128]);
      fs.writeFileSync(wordPath, firstWord);
      assert.deepEqual(await store.readContentWord(wordSectionId), firstWord);
      const updatedWord = Buffer.from([0x50, 0x4b, 3, 4, 7]);
      fs.writeFileSync(wordPath, updatedWord);
      assert.deepEqual(await store.readContentWord(wordSectionId), updatedWord);
      fs.unlinkSync(wordPath);
      assert.equal(await store.readContentWord(wordSectionId), null);
      fs.mkdirSync(wordPath);
      await assert.rejects(store.readContentWord(wordSectionId), '读取失败不能伪装成文件缺失');
      fs.rmdirSync(wordPath);
      await checkWordSort(store, database.db);
      await checkWordInvalidation(store, database.db);
      await checkWorkflowRefresh(store);
      checkWholeWorkflowReset(store, database.db);
      seed();
      let restorationRoot = seedRestorationSession();
      clearStalePiTaskArchives(app);
      assert.ok(fs.existsSync(restorationRoot), '启动清理必须保留还原持久工作区');
      let before = store.loadTechnicalPlan();
      let outline = structuredClone(before.outlineData.outline);
      outline[0].children[0].title = '修改后的标题';
      let result = save(outline, 'edit');
      assert.equal(result.contentGenerationSections['00000000-0000-4000-8000-000000000004'].title, '修改后的标题');
      assert.equal(result.contentGenerationSections['00000000-0000-4000-8000-000000000004'].content, '正文甲');
      assert.deepEqual(result.contentGenerationPlans, before.contentGenerationPlans);
      assert.deepEqual(result.contentGenerationRuntime, before.contentGenerationRuntime);
      assert.ok(fs.existsSync(restorationRoot), '仅改名不清理还原会话');

      outline.push(leaf('00000000-0000-4000-8000-000000000003'));
      result = save(outline, 'add-root');
      assert.equal(fs.existsSync(restorationRoot), false, '目录结构变化清理旧还原会话');
      assert.deepEqual(result.contentGenerationPlans, before.contentGenerationPlans);
      assert.equal(result.contentGenerationSections['00000000-0000-4000-8000-000000000002'].content, '正文丙');
      assert.deepEqual(result.contentGenerationRuntime.pending_item_ids, ['00000000-0000-4000-8000-000000000003']);
      assert.deepEqual(result.contentGenerationRuntime.direct_generation_item_ids, ['00000000-0000-4000-8000-000000000003']);
      database.close();
      open();
      assert.equal(store.loadTechnicalPlan().contentGenerationRuntime.generation_started, true, '目录变更与重启均不得解除锁定');
      assert.deepEqual(store.loadTechnicalPlan().contentGenerationRuntime.pending_item_ids, ['00000000-0000-4000-8000-000000000003']);

      // 已有叶子下添加子节点只清空父叶子；再添加同级子节点不得清空第一个子节点。
      outline = store.loadTechnicalPlan().outlineData.outline;
      outline[1].children = [leaf('00000000-0000-4000-8000-000000000007')];
      delete outline[1].content_mode;
      result = save(outline, 'add-child', ['00000000-0000-4000-8000-000000000002']);
      assert.equal(result.outlineData.outline[1].content, '');
      assert.equal(result.contentGenerationPlans['00000000-0000-4000-8000-000000000002'], undefined);
      assert.equal(result.contentGenerationSections['00000000-0000-4000-8000-000000000004'].content, '正文甲');
      assert.ok(result.contentGenerationRuntime.pending_item_ids.includes('00000000-0000-4000-8000-000000000007'));
      store.saveChapterContent({ nodeId: '00000000-0000-4000-8000-000000000007', content: '新增子节正文' });
      outline = store.loadTechnicalPlan().outlineData.outline;
      outline[1].children.push(leaf('00000000-0000-4000-8000-000000000008'));
      result = save(outline, 'add-child');
      assert.equal(result.contentGenerationSections['00000000-0000-4000-8000-000000000007'].content, '新增子节正文');

      // 删除最后一个子节点后，父节点重新成为需要编排、跳过还原的 AI 叶子。
      outline = result.outlineData.outline;
      outline[1] = leaf('00000000-0000-4000-8000-000000000002');
      result = save(outline, 'delete', ['00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000008']);
      assert.equal(result.contentGenerationPlans['00000000-0000-4000-8000-000000000002'], undefined);
      assert.ok(result.contentGenerationRuntime.pending_item_ids.includes('00000000-0000-4000-8000-000000000002'));
      assert.ok(result.contentGenerationRuntime.direct_generation_item_ids.includes('00000000-0000-4000-8000-000000000002'));
      assert.ok(!result.contentGenerationRuntime.pending_item_ids.includes('00000000-0000-4000-8000-000000000007'));
      assert.equal(result.contentGenerationSections['00000000-0000-4000-8000-000000000005'].content, '正文乙');

      // 删除后编号复用：被删除节点的待生成标记不得转移到占用该编号的旧正文。
      seed();
      store.updateTechnicalPlanWithoutReload({ contentGenerationRuntime: { generation_started: true, direct_generation_item_ids: ['00000000-0000-4000-8000-000000000004'], pending_item_ids: ['00000000-0000-4000-8000-000000000004'] } });
      before = store.loadTechnicalPlan();
      outline = structuredClone(before.outlineData.outline);
      outline[0].children = [outline[0].children[1]];
      result = save(outline, 'delete', ['00000000-0000-4000-8000-000000000004']);
      assert.equal(result.contentGenerationSections['00000000-0000-4000-8000-000000000005'].content, '正文乙');
      assert.deepEqual(result.contentGenerationPlans['00000000-0000-4000-8000-000000000005'], before.contentGenerationPlans['00000000-0000-4000-8000-000000000005']);
      assert.deepEqual(result.contentGenerationRuntime.pending_item_ids, []);
      assert.deepEqual(result.contentGenerationRuntime.direct_generation_item_ids, []);
      assert.equal(result.contentGenerationSections['00000000-0000-4000-8000-000000000002'].content, '正文丙');

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
      if (process.argv.includes('--word-preview')) await checkWordPreview(store);
      console.log('目录状态：改名保留、增删局部影响、父子转换、稳定身份排序、重启锁定及清空确认检查通过。');
    } finally {
      database.close();
    }
  }

  // 交换、循环排序以及提交失败都不改变身份和 Word 文件。
  async function checkWordSort(store, db) {
    const { randomUUID } = require('node:crypto');
    const rootId = randomUUID();
    const leaves = ['甲', '乙', '丙'].map(title => ({ id: randomUUID(), title, content: `正文${title}`, content_mode: 'ai-generate' }));
    const directory = store.getContentWordOutputDir();
    const file = id => path.join(directory, `${id}.docx`);
    const runtime = { html_output: { workspace_dir: '会话目录', word_output_dir: directory, word_sections: leaves.map(item => ({ section_id: item.id, file: `${item.id}.docx` })) } };
    store.updateTechnicalPlanWithoutReload({
      outlineData: { outline: [{ id: rootId, title: '根目录', children: leaves }] },
      contentGenerationTask: { task_id: 'sort-word', type: 'content-generation', status: 'success', progress: 90 },
      contentGenerationRuntime: runtime,
      contentGenerationSections: Object.fromEntries(leaves.map(item => [item.id, { status: 'success' }])),
    });
    fs.mkdirSync(directory, { recursive: true });
    leaves.forEach(item => fs.writeFileSync(file(item.id), `Word ${item.title}`, 'utf8'));
    const sort = order => store.saveOutline({ outlineData: { outline: [{ id: rootId, title: '根目录', children: order.map(index => leaves[index]) }] }, reason: 'sort' });
    const assertWords = async () => {
      for (const item of leaves) assert.equal((await store.readContentWord(item.id)).toString(), `Word ${item.title}`);
    };
    try {
      for (const order of [[1, 0, 2], [2, 0, 1]]) {
        const rename = fs.renameSync;
        fs.renameSync = () => assert.fail('排序不得移动任何 Word 文件');
        let result;
        try { result = sort(order); } finally { fs.renameSync = rename; }
        assert.deepEqual(result.outlineData.outline[0].children.map(item => item.id), order.map(index => leaves[index].id));
        assert.deepEqual(result.outlineData.outline[0].children.map(item => item.number), ['1.1', '1.2', '1.3']);
        assert.deepEqual(result.contentGenerationRuntime, runtime);
        for (const item of leaves) assert.equal(result.contentGenerationSections[item.id].content, item.content);
        await assertWords();
      }
      const before = store.loadTechnicalPlan();
      db.exec("CREATE TRIGGER fail_word_sort BEFORE UPDATE OF sort_order ON technical_plan_outline_nodes BEGIN SELECT RAISE(ABORT, 'sort-failure'); END");
      try { assert.throws(() => sort([0, 1, 2]), /sort-failure/); } finally { db.exec('DROP TRIGGER fail_word_sort'); }
      assert.deepEqual(store.loadTechnicalPlan(), before);
      await assertWords();
      fs.unlinkSync(file(leaves[0].id));
      sort([0, 1, 2]);
      assert.equal(await store.readContentWord(leaves[0].id), null, '排序不得为缺失文件关联其他小节');
    } finally {
      leaves.forEach(item => { if (fs.existsSync(file(item.id))) fs.unlinkSync(file(item.id)); });
    }
  }

  // 正文失效与 Word 使用同一生命周期，保留无关原件及仍有效的小节。
  async function checkWordInvalidation(store, db) {
    const directory = store.getContentWordOutputDir();
    const file = id => path.join(directory, `${id}.docx`);
    const leaf = id => ({ id, title: `小节${id}`, content: `正文${id}`, content_mode: 'ai-generate' });
    const seed = () => {
      store.updateTechnicalPlanWithoutReload({
        outlineData: { outline: [leaf('00000000-0000-4000-8000-000000000001'), leaf('00000000-0000-4000-8000-000000000002')] },
        contentGenerationTask: { task_id: 'word-clear', type: 'content-generation', status: 'success', progress: 90 },
        contentGenerationRuntime: { generation_started: true, html_output: { workspace_dir: '会话目录', word_output_dir: directory, word_sections: [{ section_id: '00000000-0000-4000-8000-000000000001', file: '00000000-0000-4000-8000-000000000001.docx' }] } },
      });
      fs.mkdirSync(directory, { recursive: true });
      for (const id of ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']) fs.writeFileSync(file(id), `Word ${id}`, 'utf8');
      fs.writeFileSync(file('用户原件'), '原件保留', 'utf8');
    };
    const save = (outline, reason, affectedNodeIds = []) => store.saveOutline({ outlineData: { outline }, reason, affectedNodeIds });
    const assertCleared = async () => {
      for (const id of ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']) assert.equal(await store.readContentWord(id), null);
      assert.equal(fs.readFileSync(file('用户原件'), 'utf8'), '原件保留');
      assert.equal(fs.readdirSync(directory).some(name => name.startsWith('__content_word_')), false);
    };
    try {
      for (const clear of [
        () => store.updateTechnicalPlanWithoutReload({ invalidateContentGeneration: true }),
        () => store.saveGlobalFacts([{ id: 'facts', title: '事实', content: '已修改' }]),
        () => save([leaf('00000000-0000-4000-8000-000000000001')], 'replace'),
        () => store.updateTechnicalPlanWithoutReload({ outlineData: null }),
        () => store.updateTechnicalPlanWithoutReload({ outlineData: { outline: [] } }),
        () => store.saveGenerationConfig({ bidSectionMode: store.loadGenerationConfig().bidSectionMode === 'single' ? 'multiple' : 'single' }),
      ]) {
        seed();
        clear();
        await assertCleared();
      }
      seed();
      fs.writeFileSync(file('bid-template'), '模板保留', 'utf8');
      store.updateTechnicalPlanWithoutReload({ invalidateContentGeneration: true });
      assert.equal(fs.readFileSync(file('bid-template'), 'utf8'), '模板保留');
      fs.unlinkSync(file('bid-template'));

      seed();
      for (const status of ['running', 'paused', 'error']) {
        store.updateTechnicalPlanWithoutReload({ contentGenerationTask: { task_id: 'regenerate', type: 'content-generation', status } });
        assert.equal((await store.readContentWord('00000000-0000-4000-8000-000000000001')).toString(), 'Word 00000000-0000-4000-8000-000000000001', '普通生成、暂停和失败应保留旧 Word');
      }
      seed();
      const remaining = save([leaf('00000000-0000-4000-8000-000000000002')], 'delete', ['00000000-0000-4000-8000-000000000001']);
      assert.equal(await store.readContentWord('00000000-0000-4000-8000-000000000001'), null);
      assert.equal((await store.readContentWord('00000000-0000-4000-8000-000000000002')).toString(), 'Word 00000000-0000-4000-8000-000000000002');
      assert.equal(remaining.outlineData.outline[0].number, '1');
      save([leaf('00000000-0000-4000-8000-000000000003'), leaf('00000000-0000-4000-8000-000000000002')], 'add-root');
      assert.equal(await store.readContentWord('00000000-0000-4000-8000-000000000003'), null, '新节点占用相同显示编号也不能继承被删节点的 Word');
      assert.equal((await store.readContentWord('00000000-0000-4000-8000-000000000002')).toString(), 'Word 00000000-0000-4000-8000-000000000002');

      seed();
      save([{ id: '00000000-0000-4000-8000-000000000001', title: '变成分组', children: [leaf('00000000-0000-4000-8000-000000000004')] }, leaf('00000000-0000-4000-8000-000000000002')], 'add-child');
      assert.equal(await store.readContentWord('00000000-0000-4000-8000-000000000001'), null);
      assert.equal((await store.readContentWord('00000000-0000-4000-8000-000000000002')).toString(), 'Word 00000000-0000-4000-8000-000000000002');
      fs.writeFileSync(file('00000000-0000-4000-8000-000000000004'), '子节 Word', 'utf8');
      save([leaf('00000000-0000-4000-8000-000000000001'), leaf('00000000-0000-4000-8000-000000000002')], 'delete', ['00000000-0000-4000-8000-000000000004']);
      assert.equal(await store.readContentWord('00000000-0000-4000-8000-000000000004'), null);
      assert.equal(await store.readContentWord('00000000-0000-4000-8000-000000000001'), null, '重新成为叶子后等待生成，不能复用旧 Word');

      seed();
      const before = store.loadTechnicalPlan();
      const rename = fs.renameSync;
      let moves = 0;
      fs.renameSync = (...args) => {
        if (++moves === 2) throw new Error('模拟清理时 Word 被占用');
        return rename(...args);
      };
      try { assert.throws(() => store.updateTechnicalPlanWithoutReload({ invalidateContentGeneration: true }), /模拟清理/); }
      finally { fs.renameSync = rename; }
      assert.deepEqual(store.loadTechnicalPlan(), before);
      for (const id of ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']) assert.equal((await store.readContentWord(id)).toString(), `Word ${id}`);
      db.exec("CREATE TRIGGER fail_word_clear BEFORE DELETE ON technical_plan_content_plans BEGIN SELECT RAISE(ABORT, 'word-clear-failure'); END");
      // 插入一条编排使触发器在 Word 全部暂存之后执行。
      db.prepare("INSERT INTO technical_plan_content_plans(node_id, plan_json, updated_at) VALUES ('00000000-0000-4000-8000-000000000001', '{}', 'check')").run();
      try { assert.throws(() => store.saveGlobalFacts([]), /word-clear-failure/); }
      finally { db.exec('DROP TRIGGER fail_word_clear'); }
      for (const id of ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']) assert.equal((await store.readContentWord(id)).toString(), `Word ${id}`);
      console.log('Word 失效：全量清空、局部清理、稳定身份、新增节点隔离、原件保护及失败恢复通过。');
    } finally {
      for (const id of ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', '用户原件']) if (fs.existsSync(file(id))) fs.unlinkSync(file(id));
    }
  }

  // 执行真实页面入口并复现提交后删暂存文件失败，验证异常不会跳过状态刷新。
  async function checkWorkflowRefresh(store) {
    const ts = require('typescript');
    const source = fs.readFileSync(path.join(__dirname, '../src/features/technical-plan/pages/TechnicalPlanHome.tsx'), 'utf8');
    const refreshStart = source.indexOf('  const runAndRefreshTechnicalPlan =');
    const refreshEnd = source.indexOf('  const saveContentGenerationOptions =', refreshStart);
    const saveStart = source.indexOf('  const resetContentGeneration =');
    const saveEnd = source.indexOf('  const saveOutlineSelection =', saveStart);
    assert.ok(refreshStart >= 0 && refreshEnd > refreshStart && saveStart >= 0 && saveEnd > saveStart);
    const id = '00000000-0000-4000-8000-000000000091';
    const wordPath = path.join(store.getContentWordOutputDir(), `${id}.docx`);
    let pageState;
    let loads = 0;
    const messages = [];
    const api = {
      async loadState() { loads += 1; return store.loadTechnicalPlan(); },
      async clear() { return store.clearTechnicalPlan(); },
      async resetContentGeneration() { store.updateTechnicalPlanWithoutReload({ invalidateContentGeneration: true }); },
      async saveGlobalFacts(facts) { return store.saveGlobalFacts(facts); },
      async saveOutline(request) { return store.saveOutline(request); },
    };
    const scope = {
      window: { yibiao: { technicalPlan: api }, confirm: () => true },
      isResetting: false, setIsResetting() {},
      setState(value) { pageState = value; },
      showToast(message, type) { messages.push({ message, type }); },
    };
    vm.createContext(scope);
    vm.runInContext(ts.transpile(
      source.slice(refreshStart, refreshEnd) + source.slice(saveStart, saveEnd)
        + '\nthis.actions = { runAndRefreshTechnicalPlan, resetTechnicalPlan, resetContentGeneration, saveGlobalFacts, saveOutline };',
      { target: ts.ScriptTarget.ES2022 },
    ), scope);
    const seed = () => {
      store.updateTechnicalPlanWithoutReload({ outlineData: { outline: [{ id, title: '刷新检查', content: '旧正文', content_mode: 'ai-generate' }] } });
      fs.mkdirSync(path.dirname(wordPath), { recursive: true });
      fs.writeFileSync(wordPath, '旧 Word', 'utf8');
      pageState = store.loadTechnicalPlan();
      messages.length = 0;
      loads = 0;
    };
    const { actions } = scope;
    for (const action of [
      () => actions.resetContentGeneration(),
      () => actions.saveGlobalFacts([{ id: 'facts', title: '事实', content: '新事实' }]),
      () => actions.saveOutline({ outlineData: { outline: [] }, reason: 'delete', affectedNodeIds: [id] }),
    ]) {
      seed();
      const oldOutline = pageState.outlineData;
      const unlink = fs.unlinkSync;
      fs.unlinkSync = (file, ...args) => {
        if (path.basename(file).startsWith('__content_word_')) throw new Error('模拟暂存清理失败');
        return unlink(file, ...args);
      };
      try { await assert.rejects(action(), /模拟暂存清理失败/); }
      finally { fs.unlinkSync = unlink; }
      assert.equal(loads, 1);
      assert.deepEqual(pageState, store.loadTechnicalPlan());
      assert.notEqual(pageState.outlineData, oldOutline, '新快照必须使 Word 预览上下文失效');
      assert.equal(await store.readContentWord(id), null);
      assert.ok(fs.readdirSync(path.dirname(wordPath)).some(name => name.startsWith('__content_word_')));
    }

    seed();
    await actions.resetContentGeneration();
    assert.equal(loads, 1, '成功同样刷新');
    assert.deepEqual(pageState, store.loadTechnicalPlan());
    const synchronousError = new Error('同步异常');
    await assert.rejects(actions.runAndRefreshTechnicalPlan(() => { throw synchronousError; }), error => error === synchronousError);
    assert.equal(loads, 2, '同步抛出也刷新');

    const clear = api.clear;
    for (const fails of [false, true]) {
      seed();
      api.clear = async () => { const result = store.clearTechnicalPlan(); if (fails) throw new Error('重置返回异常'); return result; };
      await actions.resetTechnicalPlan();
      assert.equal(loads, 1);
      assert.deepEqual(pageState, store.loadTechnicalPlan());
      assert.equal(pageState.outlineData, null);
      assert.equal(messages.some(item => item.type === 'success'), !fails);
    }
    seed();
    api.clear = async () => ({ success: false, message: '接口返回失败' });
    await actions.resetTechnicalPlan();
    assert.equal(loads, 1);
    assert.ok(messages.some(item => item.type === 'error' && item.message === '接口返回失败'));
    assert.equal(messages.some(item => item.type === 'success'), false);

    const load = api.loadState;
    api.loadState = async () => { throw new Error('读取失败'); };
    api.clear = clear;
    messages.length = 0;
    await actions.resetTechnicalPlan();
    assert.ok(messages.some(item => item.type === 'error' && item.message.includes('刷新技术方案状态失败')));
    assert.equal(messages.some(item => item.type === 'success'), false, '刷新失败不能提示重置成功');
    await assert.rejects(actions.runAndRefreshTechnicalPlan(() => { throw synchronousError; }), error => error === synchronousError);
    api.loadState = load;
    console.log('状态刷新：成功、接口失败、抛出异常、提交后清理失败及读取失败检查通过。');
  }

  // 全流程重置删除整个专属目录及会话；公共资源和其他业务保持不变。
  function checkWholeWorkflowReset(store, db) {
    const { getGeneratedImagesDir, getImportedImagesDir, getWorkspaceDir } = require('../electron/utils/paths.cjs');
    const { createPersistentAgentTask, getPersistentAgentTaskPaths } = require('../electron/services/pi/piPersistentTaskStore.cjs');
    const { OUTLINE_AGENT_TASK_KEY, TEMPLATE_EXTRACTION_AGENT_TASK_KEY } = require('../electron/services/outlineGenerationAgentV2Config.cjs');
    const { GLOBAL_FACTS_AGENT_TASK_KEY } = require('../electron/services/globalFactsAgentV2Config.cjs');
    const { CONTENT_PLANNING_AGENT_TASK_KEY } = require('../electron/services/contentPlanningAgentConfig.cjs');
    const { ORIGINAL_RESTORATION_AGENT_TASK_KEY } = require('../electron/services/originalPlanRestorationAgentConfig.cjs');
    const { CONTENT_GENERATION_AGENT_TASK_KEY } = require('../electron/services/contentGenerationAgent.cjs');
    const taskKeys = [OUTLINE_AGENT_TASK_KEY, TEMPLATE_EXTRACTION_AGENT_TASK_KEY, GLOBAL_FACTS_AGENT_TASK_KEY, CONTENT_PLANNING_AGENT_TASK_KEY, ORIGINAL_RESTORATION_AGENT_TASK_KEY, CONTENT_GENERATION_AGENT_TASK_KEY];
    const write = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '检查内容', 'utf8'); };
    const directory = store.getContentWordOutputDir();
    const generated = path.join(getGeneratedImagesDir(app), 'technical-plan');
    const imported = path.join(getImportedImagesDir(app), 'technical-plan-original-123');
    const id = '00000000-0000-4000-8000-000000000092';
    store.updateTechnicalPlanWithoutReload({
      outlineData: { outline: [{ id, title: '重置检查', content: '正文', content_mode: 'ai-generate' }] },
      globalFacts: [{ id: 'facts', title: '事实', content: '事实内容' }],
      contentGenerationTask: { task_id: 'whole-reset', type: 'content-generation', status: 'success', progress: 90 },
      contentGenerationRuntime: { generation_started: true },
    });
    const preserved = [
      path.join(getWorkspaceDir(app), '其他业务', '文件.docx'),
      path.join(getGeneratedImagesDir(app), 'other-feature', '图片.png'),
      path.join(getImportedImagesDir(app), 'other-feature-123', '原图.png'),
      path.join(app.getPath('userData'), 'user_config.json'),
    ];
    for (const name of [`${id}.docx`, '未登记小节.docx', '__content_word_残留.tmp', 'tender.md', 'original-plan.md', 'bid-template.docx', 'bid-template-fields.json', 'tender-originals/原件.docx', 'illustrations/图片.html']) write(path.join(directory, name));
    write(path.join(generated, 'illustrations/图片.png'));
    write(path.join(imported, '图片.png'));
    preserved.forEach(write);
    for (const key of taskKeys) {
      const task = createPersistentAgentTask(app, key);
      write(path.join(task.paths.workspaceDir, '正文', '小节.html'));
    }
    const otherTask = createPersistentAgentTask(app, 'other-feature-test');
    write(path.join(otherTask.paths.workspaceDir, '保留.txt'));
    // 若仍按小节暂存，立即失败；完整目录删除无需给任何 Word 改名。
    const rename = fs.renameSync;
    fs.renameSync = () => { throw new Error('全流程重置不应暂存小节 Word'); };
    try { assert.equal(store.clearTechnicalPlan().success, true); }
    finally { fs.renameSync = rename; }
    for (const target of [directory, generated, imported, ...taskKeys.map(key => getPersistentAgentTaskPaths(app, key).taskRoot)]) assert.equal(fs.existsSync(target), false, target);
    for (const target of [...preserved, path.join(otherTask.paths.workspaceDir, '保留.txt')]) assert.equal(fs.readFileSync(target, 'utf8'), '检查内容', target);
    const state = store.loadTechnicalPlan();
    assert.equal(state.outlineData, null);
    assert.equal(state.tenderFile, null);
    assert.equal(state.originalPlanFile, null);
    assert.equal(state.contentGenerationRuntime, undefined);
    assert.equal(state.bidTemplateExists, false);
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'technical_plan_*'").all()) {
      if (name === 'technical_plan_meta' || name === 'technical_plan_generation_config') continue;
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count, 0, name);
    }
    assert.equal(store.clearTechnicalPlan().success, true, '空目录可再次重置');
    console.log('全流程重置：孤儿 Word、暂存文件、导入副本、图片及持久会话整体清理，公共资源保留检查通过。');
  }

  // 用真实 preload、IPC 和正文页验证只读预览，文件及服务均在隔离测试环境中。
  async function checkWordPreview(store) {
    const { BrowserWindow, ipcMain } = require('electron');
    const { Document, Packer, Paragraph, Table, TableRow, TableCell } = require('docx');
    const { createServer } = await import('vite');
    const { registerTechnicalPlanIpc } = require('../electron/ipc/technicalPlanIpc.cjs');
    store.updateTechnicalPlanWithoutReload({ outlineData: { outline: ['预览甲', '预览乙', '缺失', '损坏'].map(id => ({ id, title: id, content_mode: 'ai-generate' })) } });
    registerTechnicalPlanIpc({ technicalPlanStore: store, taskService: {} });
    ipcMain.handle('config:load', () => ({}));
    const writeWord = async (id, text) => {
      const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [
        new Paragraph(text),
        new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('表格内容')] })] })] }),
      ] }] }));
      fs.mkdirSync(store.getContentWordOutputDir(), { recursive: true });
      fs.writeFileSync(path.join(store.getContentWordOutputDir(), `${encodeURIComponent(id)}.docx`), bytes);
    };
    await writeWord('预览甲', '小节甲初稿');
    await writeWord('预览乙', '小节乙正文');
    fs.writeFileSync(path.join(store.getContentWordOutputDir(), `${encodeURIComponent('损坏')}.docx`), 'invalid-docx');
    const html = `<html><body><div id="root" style="height:100vh"></div><script type="module">
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import Page from '/src/features/technical-plan/pages/ContentEditPage.tsx';
      import {ToastProvider} from '/src/shared/ui/ToastProvider.tsx';
      import '/src/styles.css';
      const root = createRoot(document.getElementById('root'));
      const props = { stepNumber:'05', hasOriginalPlan:false, sections:{},
        outlineData:{outline:['预览甲','预览乙','缺失','损坏'].map(id=>({id,title:id,content_mode:'ai-generate'}))},
        task:{task_id:'preview-task',type:'content-generation',status:'running',progress:80},
        onContentGenerationReset:async()=>{},onContentSaved:async()=>{} };
      window.renderPreview = patch => { Object.assign(props, patch); root.render(React.createElement(ToastProvider,null,React.createElement(Page,props))); };
      window.renderPreview({});
    </script></body></html>`;
    const server = await createServer({
      root: path.join(__dirname, '..'), server: { port: 5199, strictPort: false, open: false },
      plugins: [{ name: 'word-preview-check', configureServer(devServer) {
        devServer.middlewares.use(async (req, res, next) => {
          if (req.url !== '/__word-preview-check.html') return next();
          try { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(await devServer.transformIndexHtml(req.url, html)); }
          catch (error) { next(error); }
        });
      } }],
    });
    let window;
    try {
      await server.listen();
      window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload: path.join(__dirname, '../electron/preload.cjs'), contextIsolation: true, nodeIntegration: false } });
      const evaluate = code => window.webContents.executeJavaScript(code);
      const waitFor = async (expression) => {
        for (let attempt = 0; attempt < 160; attempt += 1) {
          if (await evaluate(expression)) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`页面未出现预期状态：${expression}\n${await evaluate('document.body.innerText')}`);
      };
      const select = id => evaluate(`Array.from(document.querySelectorAll('.content-outline-item')).find(button=>button.textContent.includes(${JSON.stringify(id)})).click()`);
      const hasText = text => `document.querySelector('.content-word-preview')?.textContent.includes(${JSON.stringify(text)})`;
      await window.loadURL(`http://127.0.0.1:${server.httpServer.address().port}/__word-preview-check.html`);
      await waitFor(hasText('小节甲初稿'));
      assert.equal(await evaluate(hasText('表格内容')), true);
      assert.equal(await evaluate("document.querySelector('.content-reader-actions').textContent.includes('编辑')"), false);
      assert.equal(await evaluate("!!document.querySelector('.content-word-preview [contenteditable=true]')"), false);
      assert.equal(await evaluate("document.querySelector('.content-word-editor').getBoundingClientRect().height > 200"), true);
      await writeWord('预览甲', '小节甲更新稿');
      await evaluate("window.renderPreview({contentGenerationRuntime:{html_output:{word_sections:[{section_id:'预览甲',file:'预览甲.docx'}]}}})");
      await waitFor(hasText('小节甲更新稿'));
      await select('预览乙');
      await waitFor(hasText('小节乙正文'));
      assert.equal(await evaluate(hasText('小节甲更新稿')), false);
      // 甲的读取故意晚于乙返回，不能把乙的展示覆盖为甲。
      const readWord = store.readContentWord;
      let releaseRead;
      let readStarted;
      const started = new Promise(resolve => { readStarted = resolve; });
      store.readContentWord = async id => {
        const bytes = await readWord(id);
        if (id === '预览甲') await new Promise(resolve => { releaseRead = resolve; readStarted(); });
        return bytes;
      };
      await select('预览甲');
      await started;
      await select('预览乙');
      await waitFor(hasText('小节乙正文'));
      releaseRead();
      store.readContentWord = readWord;
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(await evaluate(hasText('小节甲更新稿')), false);
      await select('缺失');
      await waitFor(hasText('该小节尚未生成 Word'));
      await select('损坏');
      await waitFor(hasText('Word 加载失败'));
      await writeWord('损坏', '修复后正文');
      await evaluate("Array.from(document.querySelectorAll('.content-word-preview button')).find(button=>button.textContent==='重新加载').click()");
      await waitFor(hasText('修复后正文'));
      await window.loadURL(window.webContents.getURL());
      await waitFor(hasText('小节甲更新稿'));
      // 同一小节正在刷新时发生正文清空，旧文档及清空前的迟到响应都必须失效。
      let releaseOldRead;
      let oldReadStarted;
      let delayOnce = true;
      const oldStarted = new Promise(resolve => { oldReadStarted = resolve; });
      store.readContentWord = async id => {
        const bytes = await readWord(id);
        if (id === '预览甲' && delayOnce) {
          delayOnce = false;
          await new Promise(resolve => { releaseOldRead = resolve; oldReadStarted(); });
        }
        return bytes;
      };
      await evaluate("window.renderPreview({task:{task_id:'regenerating',type:'content-generation',status:'running'}})");
      await oldStarted;
      assert.equal(await evaluate(hasText('小节甲更新稿')), true, '普通重新生成期间保留已有 Word');
      const unlink = fs.unlinkSync;
      fs.unlinkSync = (file, ...args) => {
        if (path.basename(file).startsWith('__content_word_')) throw new Error('预览暂存清理失败');
        return unlink(file, ...args);
      };
      try { assert.throws(() => store.saveGlobalFacts([]), /预览暂存清理失败/); }
      finally { fs.unlinkSync = unlink; }
      const latestState = store.loadTechnicalPlan();
      await evaluate(`window.renderPreview({outlineData:${JSON.stringify(latestState.outlineData)},task:undefined,contentGenerationRuntime:undefined})`);
      await waitFor(hasText('该小节尚未生成 Word'));
      releaseOldRead();
      store.readContentWord = readWord;
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(await evaluate(hasText('小节甲更新稿')), false);

      await writeWord('预览甲', '重新生成的正文');
      await evaluate("window.renderPreview({task:{task_id:'new-task',type:'content-generation',status:'success'},contentGenerationRuntime:{html_output:{word_sections:[{section_id:'预览甲',file:'预览甲.docx'}]}}})");
      await waitFor(hasText('重新生成的正文'));
      const replacement = { outline: [{ id: '预览甲', title: '同编号的新小节', content_mode: 'ai-generate' }] };
      store.saveOutline({ outlineData: replacement, reason: 'replace' });
      await evaluate(`window.renderPreview({outlineData:${JSON.stringify(replacement)}})`);
      await waitFor(hasText('该小节尚未生成 Word'));
      assert.equal(await evaluate(hasText('重新生成的正文')), false);
      await writeWord('预览甲', '尺寸检查正文');
      await evaluate("Array.from(document.querySelectorAll('.content-word-preview button')).find(button=>button.textContent==='重新加载').click()");
      await waitFor(hasText('尺寸检查正文'));
      window.setSize(960, 720);
      assert.equal(await evaluate("document.querySelector('.content-word-editor').getBoundingClientRect().height > 100"), true);
      console.log('Word 页面：只读、切换、转换刷新、异常重试、重进、清空缓存、迟到响应及同编号新小节检查通过。');
    } finally {
      window?.destroy();
      await server.close();
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
        ORIGINAL_RESTORATION_AGENT_TASK_KEY: 'technical-plan-original-restoration',
        CONTENT_GENERATION_AGENT_TASK_KEY: 'technical-plan-content-generation', runContentGenerationTask() {},
        technicalPlanStore: { loadTechnicalPlan: () => ({ outlineWordControlSnapshot: {}, originalPlanFile: hasOriginal ? { markdownPath: 'original.md' } : null }) },
        agentService: { deletePersistentTask(key) { if (key === scope.ORIGINAL_RESTORATION_AGENT_TASK_KEY) deletes += 1; } },
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
