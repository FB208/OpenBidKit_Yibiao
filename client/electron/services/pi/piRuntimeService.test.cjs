const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// 运行真实 Runtime，仅替换外部环境、模型会话和埋点，不访问网络或用户数据。
function loadRuntime(mocks) {
  const filename = path.join(__dirname, 'piRuntimeService.cjs');
  const localRequire = createRequire(filename);
  const mod = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`, { filename })(
    name => Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name), mod, mod.exports,
  );
  return mod.exports;
}

// 每次 prompt 使用固定操作，保留 Runtime 的文件读取、校验、修复和交接循环。
function createHarness(t, responses) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '易标-Runtime-'));
  const workspaceDir = path.join(root, '工作区');
  fs.mkdirSync(workspaceDir);
  const prompts = [];
  const sessions = [];
  const layout = { runtimeRoot: root, tasksRoot: path.join(root, 'tasks'), workspaceDir };
  const read = file => fs.readFileSync(path.join(workspaceDir, file), 'utf8');
  const write = (file, content) => fs.writeFileSync(path.join(workspaceDir, file), content, 'utf8');
  const exists = file => fs.existsSync(path.join(workspaceDir, file));
  const { createPiRuntimeService } = loadRuntime({
    './piEnvironment.cjs': { preparePiEnvironment: () => ({ layout }) },
    '../agent/agentRuntimeAnalytics.cjs': { trackAgentRuntime() {} },
    '../agent/agentOpenAiProxy.cjs': {
      createAgentOpenAiProxy: () => ({ async start() { return {}; }, async close() {} }),
    },
    './piSessionFactory.cjs': {
      async loadPiModules() { return { codingAgent: { VERSION: 'test' } }; },
      async createPiSession(options) {
        assert.equal(options.workspaceDir, workspaceDir);
        const session = {
          sessionId: `session-${sessions.length + 1}`,
          messages: [],
          subscribe: () => () => {},
          dispose() {},
          async abort() {},
          async prompt(prompt) {
            const response = responses[prompts.length];
            prompts.push(prompt);
            assert.equal(typeof response, 'function', '不应请求额外的模型轮次');
            await response({ prompt, read, write, exists, workspaceDir, session });
            session.messages.push({ role: 'assistant', content: [], stopReason: 'stop' });
          },
        };
        sessions.push(session);
        return { session, snapshot: {}, assertJsonValidationPassed() {} };
      },
    },
  });
  const runtime = createPiRuntimeService({ app: { getPath: () => root }, configStore: { load: () => ({}) }, aiService: {} });
  t.after(async () => {
    await runtime.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    read, write, exists, prompts, sessions,
    run: payload => runtime.runTask({
      workspace_dir: workspaceDir,
      output_file: 'outline.json',
      prompt: '初始阶段',
      initial_stage: 'score-planning',
      summary_enabled: false,
      ...payload,
    }),
  };
}

test('初始及后续阶段先写输入再预建空白文件，保留已有内容和中文路径', async t => {
  const harness = createHarness(t, [
    ({ read, write, exists }) => {
      assert.equal(read('outline.json'), '{"输入":true}');
      assert.equal(read('已有.json'), '已有输出');
      assert.equal(read('中文目录/空白.json'), '');
      assert.equal(exists('下一阶段.json'), false);
      write('outline.json', '{"第一阶段":true}');
    },
    ({ read }) => {
      assert.equal(read('outline.json'), '{"第一阶段":true}');
      assert.equal(read('已有.json'), '已有输出');
      assert.equal(read('下一阶段.json'), '');
      assert.equal(read('阶段输入.json'), '{"输入":2}');
    },
  ]);
  harness.write('已有.json', '已有输出');
  let handoffs = 0;
  await harness.run({
    files: [{ path: 'outline.json', content: '{"输入":true}' }],
    prepare_output_files: ['outline.json', '已有.json', '中文目录/空白.json'],
    continueTask() {
      handoffs += 1;
      return handoffs === 1 ? {
        stage: 'children_generation', prompt: '下一阶段',
        files: [{ path: '阶段输入.json', content: '{"输入":2}' }],
        prepare_output_files: ['outline.json', '已有.json', '阶段输入.json', '下一阶段.json'],
      } : { complete: true };
    },
  });
  assert.equal(handoffs, 2);
  assert.equal(harness.sessions.length, 1);
});

test('非主输出缺失在原 Session 修复一次，重试不预建、不清空现场，交接只接收通过的结果', async t => {
  const file = '评分规划.json';
  const harness = createHarness(t, [
    ({ read, workspaceDir }) => {
      assert.equal(read(file), '');
      fs.unlinkSync(path.join(workspaceDir, file));
    },
    ({ prompt, exists, read, write }) => {
      assert.equal(prompt, `只补齐 ${file}`);
      assert.equal(exists(file), false, '修复前不得再次预建已删除的文件');
      assert.equal(read('outline.json'), '{"保留":true}');
      write(file, '{"通过":true}');
    },
  ]);
  let handoffs = 0;
  let accepted;
  const result = await harness.run({
    files: [{ path: 'outline.json', content: '{"保留":true}' }],
    prepare_output_files: [file],
    max_retries: 1,
    async validateOutput(candidate, meta) {
      assert.equal(candidate.output_content, '{"保留":true}');
      assert.equal(meta.workflow_stage, 'score-planning');
      const source = await meta.readFile(file);
      if (!source) throw new Error(`${file} 未生成或内容为空`);
      accepted = JSON.parse(source);
      return accepted;
    },
    buildRetryPrompt(error, meta) {
      assert.equal(error.agentValidationFailed, true);
      assert.equal(meta.workflow_stage, 'score-planning');
      assert.equal(meta.attempt, 1);
      assert.equal(meta.max_retries, 1);
      assert.equal(meta.retry_attempts.length, 0);
      assert.equal(meta.session_id, 'session-1');
      return `只补齐 ${file}`;
    },
    continueTask(candidate, meta) {
      handoffs += 1;
      assert.equal(Object.hasOwn(candidate, 'validation_result'), false);
      assert.equal(meta.validation_result, accepted);
      return { complete: true };
    },
  });
  assert.equal(result.validation_result, accepted);
  assert.equal(result.retry_count, 1);
  assert.equal(result.retry_attempts.length, 1);
  assert.equal(harness.prompts.length, 2);
  assert.equal(harness.sessions.length, 1);
  assert.equal(handoffs, 1);
});

test('一次修复后仍不合格立即失败，不进入阶段交接', async t => {
  const harness = createHarness(t, [() => {}, () => {}]);
  let repairs = 0;
  let handoffs = 0;
  await assert.rejects(harness.run({
    max_retries: 1,
    validateOutput() { throw new Error('审核报告为空'); },
    buildRetryPrompt() { repairs += 1; return '补齐审核报告'; },
    continueTask() { handoffs += 1; },
  }), error => {
    assert.equal(error.message, '审核报告为空');
    assert.equal(error.agentRetryAttempts.length, 1);
    return true;
  });
  assert.equal(harness.prompts.length, 2);
  assert.equal(repairs, 1);
  assert.equal(handoffs, 0);
});

test('每个阶段独立拥有一次修复机会，保持同一 Session 和正确的阶段结果', async t => {
  const harness = createHarness(t, [
    () => {},
    ({ write }) => write('第一阶段.json', '{"阶段":"score-planning"}'),
    ({ read }) => assert.equal(read('第二阶段.json'), ''),
    ({ write }) => write('第二阶段.json', '{"阶段":"outline_review"}'),
  ]);
  const repairs = [];
  const handoffs = [];
  const result = await harness.run({
    prepare_output_files: ['第一阶段.json'],
    max_retries: 1,
    async validateOutput(_candidate, meta) {
      const file = meta.workflow_stage === 'score-planning' ? '第一阶段.json' : '第二阶段.json';
      const source = await meta.readFile(file);
      if (!source) throw new Error(`${file} 为空`);
      return JSON.parse(source);
    },
    buildRetryPrompt(_error, meta) {
      repairs.push([meta.workflow_stage, meta.attempt]);
      return `修复 ${meta.workflow_stage}`;
    },
    continueTask(_candidate, meta) {
      assert.equal(meta.validation_result.阶段, meta.workflow_stage);
      handoffs.push(meta.workflow_stage);
      return meta.workflow_stage === 'score-planning' ? {
        stage: 'outline_review', prompt: '审核阶段', prepare_output_files: ['第二阶段.json'],
      } : { complete: true };
    },
  });
  assert.deepEqual(repairs, [['score-planning', 1], ['outline_review', 1]]);
  assert.deepEqual(handoffs, ['score-planning', 'outline_review']);
  assert.equal(result.retry_count, 2);
  assert.equal(harness.prompts.length, 4);
  assert.equal(harness.sessions.length, 1);
});

test('阶段交接失败不进入修复循环，不重放写回或发布等副作用', async t => {
  const harness = createHarness(t, [() => {}]);
  let handoffs = 0;
  let repairs = 0;
  await assert.rejects(harness.run({
    max_retries: 1,
    validateOutput() { return { ready: true }; },
    buildRetryPrompt() { repairs += 1; return '不应修复'; },
    continueTask(_candidate, meta) {
      assert.deepEqual(meta.validation_result, { ready: true });
      handoffs += 1;
      throw new Error('交接写回失败');
    },
  }), error => {
    assert.equal(error.message, '交接写回失败');
    assert.equal(error.agentRetryAttempts.length, 0);
    return true;
  });
  assert.equal(handoffs, 1);
  assert.equal(repairs, 0);
  assert.equal(harness.prompts.length, 1);
});

test('定制回调返回 null 时普通执行错误立即失败且不登记修复', async t => {
  const harness = createHarness(t, [() => { throw new Error('模型执行失败'); }]);
  let decisions = 0;
  await assert.rejects(harness.run({
    max_retries: 1,
    buildRetryPrompt(error, meta) {
      decisions += 1;
      assert.equal(error.agentValidationFailed, undefined);
      assert.equal(meta.retry_attempts.length, 0);
      return null;
    },
  }), error => {
    assert.equal(error.message, '模型执行失败');
    assert.equal(error.agentRetryAttempts.length, 0);
    return true;
  });
  assert.equal(decisions, 1);
  assert.equal(harness.prompts.length, 1);
});

test('未启用新选项的调用保留默认一次重试和原修复提示，不主动预建文件', async t => {
  const harness = createHarness(t, [
    ({ exists }) => {
      assert.equal(exists('outline.json'), false);
      throw new Error('临时执行错误');
    },
    ({ prompt, write }) => {
      assert.match(prompt, /本次结果文件：outline\.json/);
      assert.match(prompt, /第 1\/1 次自动修复机会/);
      write('outline.json', '{"完成":true}');
    },
  ]);
  const result = await harness.run({});
  assert.equal(result.output_content, '{"完成":true}');
  assert.equal(result.retry_count, 1);
  assert.equal(harness.prompts.length, 2);
});
