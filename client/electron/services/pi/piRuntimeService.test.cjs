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
  const monitorEvents = [];
  // 续跑补压缩发生在首个提示词之前，由场景预先提供压缩实现。
  const hooks = {};
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
          compact: (...args) => hooks.compact ? hooks.compact(...args) : Promise.reject(new Error('未提供压缩实现')),
          async prompt(prompt) {
            const response = responses[prompts.length];
            prompts.push(prompt);
            assert.equal(typeof response, 'function', '不应请求额外的模型轮次');
            await response({ prompt, read, write, exists, workspaceDir, session });
            session.messages.push({ role: 'assistant', content: [], stopReason: 'stop' });
          },
        };
        sessions.push(session);
        return { session, snapshot: {} };
      },
    },
  });
  const runtime = createPiRuntimeService({ app: { getPath: () => root }, configStore: { load: () => ({}) }, aiService: {},
    isMonitorActive: () => true, onMonitorEvent: event => monitorEvents.push(event) });
  t.after(async () => {
    await runtime.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, hooks, read, write, exists, prompts, sessions, monitorEvents, getStatus: runtime.getStatus,
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

test('程序交接的真实活动刷新父任务无进展时间，不增加模型调用或创建新 Session', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date('2026-09-26T00:00:00Z') });
  const harness = createHarness(t, [() => {}, () => {}]);
  const activity = [];
  await harness.run({
    task_id: 'parent-task', title: '正文主任务', timeout_ms: 6000,
    onActivity: event => activity.push(event),
    continueTask(_candidate, meta) {
      if (meta.workflow_stage !== 'score-planning') return { complete: true };
      for (let completed = 1; completed <= 3; completed += 1) {
        t.mock.timers.tick(4000);
        assert.equal(meta.signal.aborted, false);
        meta.onActivity({
          task_token: 'child-token', task_id: 'child-task', session_id: 'child-session', title: '子任务', workspace_dir: '子工作区',
          stage: 'restoring', message: `已还原 ${completed}/3`, progress: { completed, total: 3 },
        });
        assert.equal(harness.getStatus().active_task.last_activity_at, new Date().toISOString());
        assert.equal(harness.getStatus().active_task.task_id, 'parent-task');
      }
      return { stage: 'generating', prompt: '依据生效编排生成正文' };
    },
  });
  const forwarded = activity.filter(event => event.stage === 'restoring');
  assert.equal(forwarded.length, 3);
  for (const event of forwarded) {
    assert.notEqual(event.task_token, 'child-token');
    assert.equal(event.task_id, 'parent-task');
    assert.equal(event.session_id, 'session-1');
    assert.equal(event.title, '正文主任务');
    assert.notEqual(event.workspace_dir, '子工作区');
  }
  assert.deepEqual(forwarded.map(event => event.progress.completed), [1, 2, 3]);
  assert.deepEqual(harness.prompts, ['初始阶段', '依据生效编排生成正文']);
  assert.equal(harness.sessions.length, 1);
});

test('程序交接停止产生真实活动后仍会超时，并通过交接 signal 终止等待', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date('2026-09-26T00:00:00Z') });
  const harness = createHarness(t, [() => {}]);
  let childStopped = false;
  await assert.rejects(harness.run({
    timeout_ms: 6000,
    continueTask(_candidate, meta) {
      t.mock.timers.tick(4000);
      meta.onActivity({ message: '本地排版完成一页' });
      return new Promise((_resolve, reject) => {
        meta.signal.addEventListener('abort', () => {
          childStopped = true;
          reject(meta.signal.reason);
        }, { once: true });
        t.mock.timers.tick(4000);
        assert.equal(meta.signal.aborted, false, '真实活动应重新开始无进展计时');
        t.mock.timers.tick(2000);
        assert.equal(meta.signal.aborted, true, '停止活动后仍应按原超时停止');
      });
    },
  }), error => error.code === 'AGENT_STALLED');
  assert.equal(childStopped, true);
  assert.equal(harness.prompts.length, 1);
});

test('父任务取消传递给程序交接 signal，不再请求下一阶段模型', async t => {
  const controller = new AbortController();
  const reason = new Error('用户暂停正文生成');
  const harness = createHarness(t, [() => {}]);
  let childStopped = false;
  await assert.rejects(harness.run({
    signal: controller.signal,
    continueTask(_candidate, meta) {
      assert.equal(meta.signal.aborted, false);
      return new Promise((_resolve, reject) => {
        meta.signal.addEventListener('abort', () => {
          childStopped = true;
          reject(meta.signal.reason);
        }, { once: true });
        controller.abort(reason);
        assert.equal(meta.signal.reason, reason);
      });
    },
  }), error => error === reason);
  assert.equal(childStopped, true);
  assert.equal(harness.prompts.length, 1);
  assert.equal(harness.sessions.length, 1);
});

test('非主输出缺失返回阻塞报告，在原 Session 修复且只交接本轮有效值', async t => {
  const file = '评分规划.json';
  const harness = createHarness(t, [
    ({ read, workspaceDir }) => {
      assert.equal(read(file), '');
      fs.unlinkSync(path.join(workspaceDir, file));
    },
    ({ prompt, exists, read, write }) => {
      assert.ok(prompt.includes('只补齐 ' + file));
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
      if (!source) return { value: null, issues: [{ severity: 'blocking', message: file + ' 未生成或内容为空' }] };
      accepted = JSON.parse(source);
      return { value: accepted, issues: [] };
    },
    buildRetryPrompt(request, meta) {
      assert.equal(request.kind, 'submission');
      assert.equal(request.mode, 'normal');
      assert.equal(request.report.issues[0].severity, 'blocking');
      assert.equal(meta.workflow_stage, 'score-planning');
      assert.equal(meta.attempt, 1);
      assert.equal(Object.hasOwn(meta, 'max_retries'), false, '提交修复不再有固定上限');
      assert.equal(meta.retry_attempts.length, 0);
      assert.equal(meta.session_id, 'session-1');
      return '只补齐 ' + file;
    },
    continueTask(candidate, meta) {
      handoffs += 1;
      assert.equal(Object.hasOwn(candidate, 'validation_result'), false);
      assert.equal(meta.validation_result, accepted);
      assert.deepEqual(meta.accepted_issues, []);
      return { complete: true };
    },
  });
  assert.equal(result.validation_result, accepted);
  assert.deepEqual(result.accepted_submission_issues, []);
  assert.equal(result.retry_count, 1);
  assert.equal(result.retry_attempts.length, 1);
  assert.equal(harness.prompts.length, 2);
  assert.equal(harness.sessions.length, 1);
  assert.equal(handoffs, 1);
  const retries = harness.monitorEvents.filter(event => event.type === 'retry');
  assert.equal(retries.length, 1);
  assert.equal(Object.hasOwn(retries[0], 'maximum'), false);
});

test('阻塞问题连续两次无进展后只给一轮最低目标修复，仍有阻塞即停止', async t => {
  const counts = [2, 2, 2, 1];
  const harness = createHarness(t, [
    () => {}, () => {}, () => {},
    ({ prompt }) => {
      assert.match(prompt, /最后一轮最低目标修复/);
      assert.match(prompt, /最低完成目标：生成可读取的审核报告/);
    },
  ]);
  const modes = [];
  let checks = 0;
  let handoffs = 0;
  await assert.rejects(harness.run({
    max_retries: 5,
    validateOutput() {
      return {
        value: null,
        issues: Array.from({ length: counts[checks++] }, (_, index) => ({ severity: 'blocking', message: '审核报告缺少字段 ' + (index + 1) })),
        minimumGoal: '生成可读取的审核报告',
      };
    },
    buildRetryPrompt(request, meta) {
      assert.equal(request.kind, 'submission', '最终停止不能被当成执行异常再次重试');
      modes.push(request.mode);
      assert.equal(meta.attempt, modes.length);
      return '补齐审核报告';
    },
    continueTask() { handoffs += 1; },
  }), error => {
    assert.match(error.message, /已按最低完成目标再修复一轮/);
    assert.match(error.message, /审核报告缺少字段 1/);
    assert.equal(error.agentValidationFailed, true);
    assert.equal(error.issues.length, 1, '最后一轮即使有所改善，仍有阻塞就停止');
    assert.equal(error.agentRetryAttempts.length, 3);
    return true;
  });
  assert.deepEqual(modes, ['normal', 'change-strategy', 'minimum']);
  assert.equal(harness.prompts.length, 4);
  assert.equal(handoffs, 0);
  assert.equal(harness.monitorEvents.filter(event => event.type === 'task_error').length, 1);
});

test('问题持续减少时可超过三次提交修复，执行错误预算不受影响', async t => {
  const counts = [6, 5, 4, 3, 2, 1, 0];
  const harness = createHarness(t, counts.map(() => () => {}));
  const repairs = [];
  let checks = 0;
  const result = await harness.run({
    max_retries: 0,
    validateOutput() {
      const count = counts[checks++];
      return {
        value: { count },
        issues: Array.from({ length: count }, (_, index) => ({ severity: 'blocking', message: '缺少字段 ' + index })),
      };
    },
    buildRetryPrompt(request, meta) {
      repairs.push([meta.attempt, request.mode, request.report.issues.length]);
      return '继续修复';
    },
  });
  assert.deepEqual(repairs, counts.slice(0, -1).map((count, index) => [index + 1, 'normal', count]));
  assert.equal(result.retry_count, 6);
  assert.deepEqual(result.validation_result, { count: 0 });
  assert.equal(harness.prompts.length, 7);
});

test('质量问题连续两次无进展后以本轮真实结果继续，未解决项随交接和最终结果返回', async t => {
  const harness = createHarness(t, [1, 2, 3].map(round => ({ write }) => write('outline.json', JSON.stringify({ round }))));
  const issue = { severity: 'quality', message: '仍有一处术语不一致', section_id: 'section-1' };
  const activity = [];
  let lastValue;
  let handoffs = 0;
  const result = await harness.run({
    max_retries: 0,
    onActivity: event => activity.push(event),
    validateOutput(candidate) {
      lastValue = JSON.parse(candidate.output_content);
      return { value: lastValue, issues: [issue] };
    },
    continueTask(candidate, meta) {
      handoffs += 1;
      assert.deepEqual(JSON.parse(candidate.output_content), { round: 3 });
      assert.equal(meta.validation_result, lastValue);
      assert.deepEqual(meta.accepted_issues, [issue]);
      return { complete: true };
    },
  });
  assert.deepEqual(result.validation_result, { round: 3 });
  assert.deepEqual(result.accepted_submission_issues, [{ stage: 'score-planning', issues: [issue] }]);
  assert.equal(result.retry_count, 2);
  assert.equal(handoffs, 1);
  assert.equal(harness.prompts.length, 3);
  assert.ok(activity.some(event => event.source === 'pi.submission.accepted' && event.message.includes('保留当前结果')));
});

test('最低目标轮阻塞已解决时直接接受质量问题，不再增加质量修复轮', async t => {
  const harness = createHarness(t, [() => {}, () => {}, () => {}, () => {}]);
  const blocking = { severity: 'blocking', message: '结果清单不是合法 JSON' };
  const quality = { severity: 'quality', message: '字数仍偏少' };
  let checks = 0;
  const result = await harness.run({
    max_retries: 0,
    validateOutput() {
      checks += 1;
      return { value: { readable: checks === 4 }, issues: checks < 4 ? [blocking, quality] : [quality] };
    },
  });
  assert.match(harness.prompts[3], /结果清单不是合法 JSON/);
  assert.doesNotMatch(harness.prompts[3], /字数仍偏少/, '最低目标提示不再列出具体质量问题');
  assert.equal(result.retry_count, 3);
  assert.deepEqual(result.validation_result, { readable: true });
  assert.deepEqual(result.accepted_submission_issues[0].issues, [quality]);
});

test('字数问题按剩余差额判断进展，条数不变但差额减少时继续修复', async t => {
  const gaps = [5000, 3000, 1000, 1000, 1000];
  const harness = createHarness(t, gaps.map(() => () => {}));
  const modes = [];
  let checks = 0;
  const result = await harness.run({
    max_retries: 0,
    validateOutput() {
      const gap = gaps[checks++];
      return { value: { gap }, issues: [{ severity: 'quality', message: '还差 ' + gap + ' 字' }], progress: gap };
    },
    buildRetryPrompt(request) { modes.push(request.mode); return '调整现有正文'; },
  });
  assert.deepEqual(modes, ['normal', 'normal', 'normal', 'change-strategy']);
  assert.deepEqual(result.validation_result, { gap: 1000 });
  assert.equal(result.retry_count, 4);
  assert.equal(result.accepted_submission_issues.length, 1);
});

test('混合问题优先比较阻塞数量，阻塞清零后按质量剩余量继续', async t => {
  const counts = [[2, 1], [1, 10], [1, 3], [0, 10], [0, 9], [0, 9], [0, 9]];
  const harness = createHarness(t, counts.map(() => () => {}));
  const modes = [];
  let checks = 0;
  const result = await harness.run({
    max_retries: 0,
    validateOutput() {
      const [blocking, quality] = counts[checks++];
      return {
        value: { blocking, quality },
        issues: [
          ...Array.from({ length: blocking }, (_, index) => ({ severity: 'blocking', message: '阻塞问题 ' + index })),
          ...Array.from({ length: quality }, (_, index) => ({ severity: 'quality', message: '质量问题 ' + index })),
        ],
      };
    },
    buildRetryPrompt(request) { modes.push(request.mode); return '修复当前问题'; },
  });
  assert.deepEqual(modes, ['normal', 'normal', 'change-strategy', 'normal', 'normal', 'change-strategy']);
  assert.deepEqual(result.validation_result, { blocking: 0, quality: 9 });
});

test('同阶段续接不重置提交策略，短暂无问题也不重新给予已有问题的修复预算', async t => {
  const harness = createHarness(t, [() => {}, () => {}, () => {}, () => {}]);
  const issue = { severity: 'quality', message: '仍有表格' };
  const repairs = [];
  let checks = 0;
  let handoffs = 0;
  const result = await harness.run({
    max_retries: 0,
    validateOutput() {
      checks += 1;
      return { value: { round: checks }, issues: checks === 3 ? [] : [issue] };
    },
    buildRetryPrompt(request, meta) { repairs.push([meta.attempt, request.mode]); return '处理表格'; },
    continueTask(_candidate, meta) {
      handoffs += 1;
      return handoffs === 1
        ? { stage: meta.workflow_stage, prompt: '提交阶段结论' }
        : { complete: true };
    },
  });
  assert.deepEqual(repairs, [[1, 'normal'], [2, 'change-strategy']]);
  assert.equal(harness.prompts.length, 4);
  assert.deepEqual(result.validation_result, { round: 4 });
  assert.deepEqual(result.accepted_submission_issues[0].issues, [issue]);
});

test('真正切换业务阶段后重新计数，各阶段放行问题都保留在最终结果', async t => {
  const harness = createHarness(t, Array.from({ length: 6 }, () => () => {}));
  const repairs = [];
  const result = await harness.run({
    max_retries: 0,
    validateOutput(_candidate, meta) {
      return { value: { stage: meta.workflow_stage }, issues: [{ severity: 'quality', message: meta.workflow_stage + ' 的质量问题' }] };
    },
    buildRetryPrompt(request, meta) { repairs.push([meta.workflow_stage, meta.attempt, request.mode]); return '修复当前问题'; },
    continueTask(_candidate, meta) {
      return meta.workflow_stage === 'score-planning'
        ? { stage: 'outline_review', prompt: '审核目录' }
        : { complete: true };
    },
  });
  assert.deepEqual(repairs, [
    ['score-planning', 1, 'normal'], ['score-planning', 2, 'change-strategy'],
    ['outline_review', 1, 'normal'], ['outline_review', 2, 'change-strategy'],
  ]);
  assert.deepEqual(result.accepted_submission_issues.map(item => item.stage), ['score-planning', 'outline_review']);
  assert.equal(result.retry_count, 4);
});

test('执行失败穿插于提交修复时不重置停滞计数，两类修复各自计数并共用遥测', async t => {
  const harness = createHarness(t, [() => {}, () => { throw new Error('模型执行失败'); }, () => {}, () => {}]);
  const requests = [];
  const result = await harness.run({
    max_retries: 1,
    validateOutput() {
      return { value: { ready: true }, issues: [{ severity: 'quality', message: '仍有表格' }] };
    },
    buildRetryPrompt(request, meta) {
      requests.push([request.kind, meta.attempt, request.mode]);
      if (request.kind === 'execution') {
        assert.equal(request.error.message, '模型执行失败');
        assert.equal(meta.max_retries, 1);
        return '继续之前的任务';
      }
      return '处理剩余表格';
    },
  });
  assert.deepEqual(requests, [
    ['submission', 1, 'normal'], ['execution', 1, undefined], ['submission', 2, 'change-strategy'],
  ]);
  assert.equal(result.retry_count, 3);
  const retries = harness.monitorEvents.filter(event => event.type === 'retry');
  assert.deepEqual(retries.map(event => event.maximum), [undefined, 1, undefined]);
  assert.equal(result.retry_attempts[1].error, '模型执行失败');
});

test('校验函数抛出的程序异常仍按执行预算重试，不自动转为产物问题', async t => {
  const harness = createHarness(t, [() => {}, () => {}]);
  const failure = new Error('程序读取失败');
  let checks = 0;
  const result = await harness.run({
    max_retries: 1,
    validateOutput() {
      checks += 1;
      if (checks === 1) throw failure;
      return { value: { ready: true }, issues: [] };
    },
    buildRetryPrompt(request, meta) {
      assert.equal(request.kind, 'execution');
      assert.equal(request.error, failure);
      assert.equal(request.error.agentValidationFailed, undefined);
      assert.equal(meta.attempt, 1);
      return '继续之前的任务';
    },
  });
  assert.deepEqual(result.validation_result, { ready: true });
  assert.equal(result.retry_count, 1);
});

test('提交修复过程中执行预算耗尽时保留原执行错误，不执行最低目标修复', async t => {
  const failure = new Error('模型连续失败');
  const harness = createHarness(t, [() => {}, () => { throw failure; }, () => { throw failure; }]);
  const kinds = [];
  await assert.rejects(harness.run({
    max_retries: 1,
    validateOutput() { return { value: null, issues: [{ severity: 'blocking', message: '结果为空' }] }; },
    buildRetryPrompt(request) { kinds.push(request.kind); return '继续'; },
  }), error => {
    assert.equal(error, failure);
    assert.equal(error.agentValidationFailed, undefined);
    assert.equal(error.agentRetryAttempts.length, 2);
    return true;
  });
  assert.deepEqual(kinds, ['submission', 'execution']);
});

test('业务回调不能用 null 否决提交修复，换方案与最低目标仍由公共策略控制', async t => {
  const harness = createHarness(t, [() => {}, () => {}, () => {}]);
  let checks = 0;
  const result = await harness.run({
    max_retries: 0,
    validateOutput() {
      checks += 1;
      return { value: checks, issues: [{ severity: 'quality', message: '一处表格未转换' }] };
    },
    buildRetryPrompt(request) { assert.equal(request.kind, 'submission'); return null; },
  });
  assert.match(harness.prompts[1], /本轮待修复问题/);
  assert.match(harness.prompts[2], /更换具体处理方法/);
  assert.equal(result.validation_result, 3);
});

test('提交校验前还原被改动的输入文件，Agent 结果文件不登记保护', async t => {
  const harness = createHarness(t, [
    ({ write }) => {
      write('资料/项目概述.md', '被 Agent 改写');
      write('结果.json', '{"改":true}');
      write('outline.json', '{"目录":true}');
    },
    ({ prompt, read }) => {
      assert.match(prompt, /^程序已还原被改动的文件：资料\/项目概述.md。/);
      assert.equal(read('资料/项目概述.md'), '原始概述');
      assert.equal(read('结果.json'), '{"改":true}');
    },
  ]);
  const checked = [];
  const result = await harness.run({
    files: [
      { path: '资料/项目概述.md', content: '原始概述' },
      { path: '结果.json', content: '{}' },
      { path: 'outline.json', content: '{}' },
    ],
    json_validation_schemas: { '结果.json': { type: 'object' } },
    async validateOutput(candidate, meta) {
      checked.push(await meta.readFile('资料/项目概述.md'));
      return {
        value: JSON.parse(candidate.output_content),
        issues: checked.length === 1 ? [{ severity: 'blocking', message: '需要再确认一次' }] : [],
      };
    },
    buildRetryPrompt: request => request.report.issues.map(issue => issue.message).join('\n'),
  });
  assert.deepEqual(checked, ['原始概述', '原始概述'], '还原发生在业务校验之前');
  assert.deepEqual(result.validation_result, { 目录: true });
});

test('每个阶段分别修复必需产物，保持同一 Session 和正确的阶段结果', async t => {
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
      return source
        ? { value: JSON.parse(source), issues: [] }
        : { value: null, issues: [{ severity: 'blocking', message: file + ' 为空' }] };
    },
    buildRetryPrompt(_request, meta) {
      repairs.push([meta.workflow_stage, meta.attempt]);
      return '修复 ' + meta.workflow_stage;
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
    validateOutput() { return { value: { ready: true }, issues: [] }; },
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
    buildRetryPrompt(request, meta) {
      decisions += 1;
      assert.equal(request.kind, 'execution');
      assert.equal(request.error.message, '模型执行失败');
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

test('没有提交校验的任务保留默认一次执行重试，不主动预建文件', async t => {
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
  assert.equal(result.validation_result, null);
  assert.deepEqual(result.accepted_submission_issues, []);
  assert.equal(result.retry_count, 1);
  assert.equal(harness.prompts.length, 2);
});

test('可选上下文压缩失败时按原上下文继续下一阶段，必需压缩失败仍终止任务', async t => {
  for (const optional of [true, false]) {
    const compactions = [];
    const harness = createHarness(t, [
      ({ write, session }) => {
        session.compact = async instructions => { compactions.push(instructions); throw new Error('摘要请求失败'); };
        write('outline.json', '{}');
      },
      () => {},
    ]);
    const activity = [];
    let handoffs = 0;
    const running = harness.run({
      onActivity: event => activity.push(event),
      continueTask() {
        handoffs += 1;
        return handoffs === 1 ? {
          stage: 'auditing', prompt: '下一阶段', compact_before_prompt: true, compaction_optional: optional,
          compaction_instructions: '保留审计结论',
        } : { complete: true };
      },
    });
    if (optional) {
      await running;
      assert.deepEqual(harness.prompts, ['初始阶段', '下一阶段']);
      assert.ok(activity.some(event => String(event.message || '').includes('上下文压缩失败，按原上下文继续')));
    } else {
      await assert.rejects(running, /摘要请求失败/);
      assert.deepEqual(harness.prompts, ['初始阶段']);
    }
    assert.deepEqual(compactions, ['保留审计结论']);
    assert.equal(harness.sessions.length, 1);
  }
});

test('交接前置步骤与上下文压缩并行，两者都结束后才发送下一阶段提示词', async t => {
  const order = [];
  let finishStep;
  let finishCompaction;
  const harness = createHarness(t, [
    ({ session }) => {
      session.compact = () => new Promise(resolve => {
        order.push('compaction-start');
        finishCompaction = () => { order.push('compaction-end'); resolve(); };
      });
    },
    () => { order.push('prompt'); },
  ]);
  let handoffs = 0;
  const running = harness.run({
    continueTask() {
      handoffs += 1;
      if (handoffs > 1) return { complete: true };
      order.push('step-start');
      const step = new Promise(resolve => { finishStep = () => { order.push('step-end'); resolve(); }; });
      return { stage: 'auditing', prompt: '下一阶段', compact_before_prompt: true, compaction_optional: true, await_before_prompt: step };
    },
  });
  while (!finishCompaction) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['step-start', 'compaction-start'], '压缩不等待前置步骤');
  finishCompaction();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.prompts.length, 1, '前置步骤未完成时不发送提示词');
  finishStep();
  await running;
  assert.deepEqual(order, ['step-start', 'compaction-start', 'compaction-end', 'step-end', 'prompt']);
  assert.deepEqual(harness.prompts, ['初始阶段', '下一阶段']);
});

test('交接前置步骤失败或任务取消时不发送提示词，压缩期间失败不产生未处理异常', async t => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  // 前置步骤在压缩进行中先失败，压缩结束后按该错误终止任务。
  let finishCompaction;
  const failed = createHarness(t, [({ session }) => {
    session.compact = () => new Promise(resolve => { finishCompaction = resolve; });
  }]);
  const failure = new Error('小节核对失败');
  const running = failed.run({
    continueTask: () => ({ stage: 'auditing', prompt: '下一阶段', compact_before_prompt: true, compaction_optional: true, await_before_prompt: Promise.reject(failure) }),
  });
  while (!finishCompaction) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 20));
  finishCompaction();
  await assert.rejects(running, error => error === failure);
  assert.deepEqual(failed.prompts, ['初始阶段']);
  // 取消信号同时终止前置步骤，任务按取消原因结束。
  const controller = new AbortController();
  const reason = new Error('用户暂停');
  const cancelled = createHarness(t, [() => {}]);
  let stepStopped = false;
  await assert.rejects(cancelled.run({
    signal: controller.signal,
    continueTask(_candidate, meta) {
      const step = new Promise((_resolve, reject) => meta.signal.addEventListener('abort', () => { stepStopped = true; reject(new Error('请求已取消')); }, { once: true }));
      setImmediate(() => controller.abort(reason));
      return { stage: 'auditing', prompt: '下一阶段', await_before_prompt: step };
    },
  }), error => error === reason);
  assert.equal(stepStopped, true);
  assert.deepEqual(cancelled.prompts, ['初始阶段']);
  assert.deepEqual(unhandled, []);
});

test('持久任务记录已发出的阶段；交接压缩未完成时，续跑在该阶段要求发出前补做，已发出后不再补做', async t => {
  const store = require('./piPersistentTaskStore.cjs');
  const taskKey = 'runtime-prompted-stage';
  const persistentPrompts = [];
  const harness = createHarness(t, [
    () => {},
    ({ prompt }) => { persistentPrompts.push(prompt); },
    ({ prompt }) => { persistentPrompts.push(prompt); },
  ]);
  const app = { getPath: () => harness.root };
  const load = () => store.loadPersistentAgentTask(app, taskKey).state;
  // 第一次运行：生成要求发出后交接审计，压缩失败并在前置步骤期间暂停，审计要求尚未发出。
  const controller = new AbortController();
  const pause = new Error('用户暂停');
  const compactions = [];
  harness.hooks.compact = async instructions => {
    compactions.push(instructions);
    setImmediate(() => controller.abort(pause));
    throw new Error('客户端连接已关闭');
  };
  await assert.rejects(harness.run({
    task_id: 'run-1', signal: controller.signal, initial_stage: 'generating', prompt: '生成要求',
    persistent_task: { task_key: taskKey, mode: 'create' },
    continueTask: (_candidate, meta) => ({
      stage: 'auditing', prompt: '审计要求', compact_before_prompt: true, compaction_optional: true, compaction_instructions: '保留审计结论',
      await_before_prompt: new Promise((_resolve, reject) => meta.signal.addEventListener('abort', () => reject(new Error('核对已取消')), { once: true })),
    }),
  }), error => error === pause);
  assert.deepEqual(harness.prompts, ['生成要求']);
  assert.equal(load().prompted_stage, 'generating', '发出提示词前记录阶段');
  assert.deepEqual(load().compaction_pending, {
    stage: 'auditing', compaction_stage: 'auditing_compaction', compaction_instructions: '保留审计结论', compaction_optional: true,
  }, '压缩失败时保留待补压缩');
  // 第二次运行：审计要求尚未发出，先补做压缩再发送；发出后清除待补记录。
  store.updatePersistentAgentTask(app, taskKey, { run_id: 'run-2', session_file: 'session.jsonl' });
  const order = [];
  harness.hooks.compact = async instructions => { order.push(`compact:${instructions}`); };
  await harness.run({
    task_id: 'run-2', initial_stage: 'auditing', prompt: '审计要求', persistent_task: { task_key: taskKey, mode: 'resume' },
    onCheckpoint: state => { if (state.prompted_stage === 'auditing' && !order.includes('prompted')) order.push('prompted'); },
  });
  assert.deepEqual(order, ['compact:保留审计结论', 'prompted']);
  assert.deepEqual(persistentPrompts, ['审计要求']);
  assert.equal(load().prompted_stage, 'auditing');
  assert.equal(load().compaction_pending, null);
  // 第三次运行：该阶段要求已发出，即使残留待补记录也不中途压缩，发送时清除记录。
  store.updatePersistentAgentTask(app, taskKey, { run_id: 'run-3', compaction_pending: { stage: 'auditing', compaction_optional: true } });
  harness.hooks.compact = async () => { throw new Error('已发出的阶段不应补压缩'); };
  await harness.run({ task_id: 'run-3', initial_stage: 'auditing', prompt: '继续之前的任务', persistent_task: { task_key: taskKey, mode: 'resume' } });
  assert.deepEqual(persistentPrompts, ['审计要求', '继续之前的任务']);
  assert.equal(load().compaction_pending, null);
});
