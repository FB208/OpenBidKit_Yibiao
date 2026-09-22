const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildContentGenerationFiles, runContentGenerationAgent } = require('../electron/services/contentGenerationAgent.cjs');
const { createPiSession } = require('../electron/services/pi/piSessionFactory.cjs');

// 使用真实输入与业务工具，只模拟主 Agent 的决策，子任务执行真实 Pi 原生 edit。
async function check() {
  const { Type } = await import('typebox');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '正文一致性-'));
  const workspaceDir = path.join(root, '中文工作区');
  const targets = ['one', 'two'].map((id, index) => ({ item: { id, number: `1.${index + 1}`, title: `小节${index + 1}`, content_mode: 'ai-generate' } }));
  const files = buildContentGenerationFiles({ outline: targets.map(target => target.item), targets, plans: {},
    projectOverview: '工期六十天', globalFacts: [{ title: '工期', content: '六十天' }], globalFactsMode: 'placeholder',
    wordControl: {}, generationOptions: { imageQuantity: 'none' }, template: { config: {} }, documentIds: [],
  });
  const figure = '<figure id="图" data-yb-generation="aiImage" data-yb-size="wide"><template data-yb-role="prompt">保留原图</template><img alt="图" data-yb-asset-ref="图片/原图.png"><figcaption>现场</figcaption></figure>';
  let savedState;
  let action;
  let childAction;
  let activeTools;
  const progress = [];
  const pause = new Error('模拟暂停');

  // 各场景共用相同的最小文件输入，避免依赖用户数据库或外部模型。
  function reset() {
    savedState = {};
    for (const file of files) {
      const destination = path.join(workspaceDir, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.content, 'utf8');
    }
    fs.mkdirSync(path.join(workspaceDir, '图片'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '图片/原图.png'), Buffer.from([1]));
    fs.mkdirSync(path.join(workspaceDir, '正文'), { recursive: true });
    for (const { item } of targets) fs.writeFileSync(path.join(workspaceDir, `正文/${item.id}.html`), `<!-- yibiao:block --><p>工期六十天</p>${figure}`, 'utf8');
    fs.writeFileSync(path.join(workspaceDir, '正文生成结果.json'), JSON.stringify({ sections: targets.map(({ item }) => ({ section_id: item.id, file: `正文/${item.id}.html`, words: 8 })) }), 'utf8');
  }
  const service = {
    hasPersistentTaskSession: () => true,
    loadPersistentTask: () => ({ state: savedState }),
    updatePersistentTask(_key, partial) { savedState = { ...savedState, ...structuredClone(partial) }; },
    async runTask(payload) {
      if (!payload.primary_session) return childAction(payload);
      const tools = payload.create_tools({ Type, workspaceDir, setActiveTools: names => { activeTools = names; } });
      const next = () => { payload.validateOutput({}, { workspace_dir: workspaceDir }); return payload.continueTask({}, { workspace_dir: workspaceDir }); };
      const finish = issues => tools.find(tool => tool.name === 'complete-consistency-round').execute('finish', { summary: '检查了工期和跨节承诺', remaining_issues: issues });
      await action({ payload, tools, next, finish });
      return { workspace_dir: workspaceDir };
    },
  };
  const run = resume => runContentGenerationAgent({ agentService: service, aiService: {}, signal: new AbortController().signal, resume,
    hasKnowledgeBase: false, buildFiles: () => files, onConsistencyProgress: state => progress.push(structuredClone(state)),
  });
  try {
    reset();
    action = async ({ payload, next, finish }) => {
      const start = next();
      assert.equal(start.stage, 'auditing');
      assert.match(start.prompt, /小节内部/);
      assert.match(start.prompt, /global_facts_requirements（当前事实模式的中文要求）/);
      assert.match(start.prompt, /不能在审计时重新猜一个值解决冲突或覆盖已有设定/);
      assert.doesNotMatch(start.prompt, /知识库/);
      assert.equal(savedState.consistency.round, 1);
      assert.equal(next().stage, 'auditing', '提前结束不能跳过本轮结论');
      assert.equal(savedState.consistency.round, 1);
      for (const name of ['check-word-count', 'adjust-sections', 'generate-sections', 'generate-image', 'bash']) {
        assert.equal(activeTools.includes(name), false);
        assert.throws(() => payload.before_tool_call({ toolCall: { name }, args: {} }), /正文编辑期间不能/);
      }
      // 审计修复使字数变多，即使移除字数配置，完成分支也不能再访问字数检查。
      const decisionFile = path.join(workspaceDir, '正文编排决策.json');
      const decisions = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
      delete decisions.word_control;
      fs.writeFileSync(decisionFile, JSON.stringify(decisions), 'utf8');
      fs.appendFileSync(path.join(workspaceDir, '正文/one.html'), '<p>补充统一的项目承诺。</p>', 'utf8');
      await finish([]);
      assert.throws(() => payload.before_tool_call({ toolCall: { name: 'edit' }, args: { path: '正文/one.html' } }), /结论已经提交/);
      assert.equal(next().complete, true);
    };
    await run(false);
    assert.equal(savedState.consistency.round, 1);
    assert.equal(savedState.consistency.status, 'completed');

    reset();
    action = async ({ next, finish }) => {
      next();
      await finish(['第一轮仍存在跨节工期冲突']);
      next();
      assert.equal(savedState.consistency.round, 2);
      throw pause;
    };
    await assert.rejects(run(false), error => error === pause);
    action = async ({ payload, next, finish }) => {
      assert.equal(payload.initial_stage, 'auditing');
      assert.match(payload.prompt, /第 2\/3 轮/);
      assert.equal(payload.files.length, 0);
      await finish(['第二轮尚无明确依据']);
      next();
      assert.equal(savedState.consistency.round, 3);
      await finish(['第三轮仍缺少依据']);
      throw pause; // 结论提交后、阶段推进前暂停。
    };
    await assert.rejects(run(true), error => error === pause);
    action = async ({ next, finish }) => {
      await assert.rejects(finish([]), /不在可编辑/);
      assert.equal(next().complete, true);
    };
    await run(true);
    assert.equal(savedState.consistency.round, 3);
    assert.deepEqual(savedState.consistency.remaining_issues, ['第三轮仍缺少依据']);
    action = async ({ payload, next }) => {
      assert.match(payload.prompt, /已经结束/);
      assert.equal(next().complete, true);
    };
    await run(true);
    assert.equal(savedState.consistency.round, 3, '再次恢复不能增加第四轮');

    reset();
    let started = 0;
    let release;
    let bothStarted;
    const gate = new Promise(resolve => { release = resolve; });
    const startedGate = new Promise(resolve => { bothStarted = resolve; });
    let failOne = true;
    childAction = async payload => {
      assert.equal(payload.failure_handled_by_parent, true);
      assert.equal(payload.workspace_dir, workspaceDir);
      assert.deepEqual(payload.active_tools, ['read', 'edit', 'report-failure']);
      const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
      assert.ok(payload.prompt.includes(decisions.global_facts_requirements));
      assert.match(payload.prompt, /不确定事实使用【待填写】/);
      assert.match(payload.prompt, /不扩大本次编辑范围/);
      assert.match(payload.prompt, /只修复主 Agent 指定的矛盾/);
      started++;
      if (started === 2) bothStarted();
      await gate;
      if (failOne && payload.output_file.endsWith('one.html')) throw new Error('模拟可恢复子任务失败');
      const created = await createPiSession({ workspaceDir, environment: { shellPath: process.env.ComSpec, layout: { agentDir: path.join(root, 'agent') }, instructions: '测试原生编辑', env: {} },
        config: {}, timeoutMs: 60000, summaryEnabled: false, proxyInfo: { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        activeTools: payload.active_tools, beforeFileWrite: payload.before_file_write, beforeToolCall: payload.before_tool_call,
      });
      try {
        const edit = created.session.agent.state.tools.find(tool => tool.name === 'edit');
        const original = fs.readFileSync(path.join(workspaceDir, payload.output_file), 'utf8');
        await assert.rejects(edit.execute('bad', { path: payload.output_file, edits: [{ oldText: figure, newText: '' }] }), /受保护图片/);
        assert.equal(fs.readFileSync(path.join(workspaceDir, payload.output_file), 'utf8'), original);
        await edit.execute('fix', { path: payload.output_file, edits: [{ oldText: '工期六十天', newText: '工期统一为六十天' }] });
        payload.validateOutput({ output_content: fs.readFileSync(path.join(workspaceDir, payload.output_file), 'utf8') });
      } finally { created.session.dispose(); }
      return {};
    };
    action = async ({ next, tools, finish }) => {
      next();
      const repair = tools.find(tool => tool.name === 'repair-sections');
      await assert.rejects(repair.execute('invalid', { sections: [{ section_id: 'outside', instructions: '' }] }), /本次目标/);
      const batch = repair.execute('batch', { sections: targets.map(({ item }) => ({ section_id: item.id, instructions: '统一工期六十天' })) });
      await startedGate;
      await assert.rejects(finish([]), /等待全部/);
      release();
      assert.deepEqual((await batch).details.results.map(item => item.status), ['error', 'success']);
      await assert.rejects(finish([]), /修复任务未成功/);
      throw pause;
    };
    await assert.rejects(run(false), error => error === pause);
    assert.deepEqual(savedState.consistency.failed_sections, ['one']);
    failOne = false;
    action = async ({ next, tools, finish }) => {
      await assert.rejects(finish([]), /修复任务未成功/);
      const result = await tools.find(tool => tool.name === 'repair-sections').execute('retry', { sections: [{ section_id: 'one', instructions: '统一工期六十天' }] });
      assert.equal(result.details.results[0].status, 'success');
      await finish([]);
      assert.equal(next().complete, true);
    };
    await run(true);
    assert.ok(progress.some(state => state.round === 3 && state.status === 'completed' && state.remaining_issues.length));
    console.log('通过：主会话审计、三轮上限、暂停与结论恢复、审计后不查字数、真实并发修复、原生 edit 图片保护及子任务失败重试。');
  } finally {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

check().catch(error => { console.error(error); process.exitCode = 1; });
