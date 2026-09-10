const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPiSession } = require('./piSessionFactory.cjs');
const { runTemplateExtractionTask } = require('../templateExtractionTask.cjs');

// 使用真实 Pi Session 和本地工具，仅以固定响应替代收费模型请求。
async function createTestSession(t, summaryEnabled, options = {}) {
  const workspaceDir = options.workspaceDir || fs.mkdtempSync(path.join(os.tmpdir(), '易标-Pi-总结-'));
  t.after(() => {
    assert.equal(path.dirname(workspaceDir), path.resolve(os.tmpdir()));
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });
  const { session, assertJsonValidationPassed } = await createPiSession({
    workspaceDir,
    environment: {
      layout: { agentDir: path.join(workspaceDir, 'agent') },
      instructions: '将结果写入工作区。',
      shellPath: process.env.ComSpec || '/bin/sh',
    },
    proxyInfo: { baseUrl: 'http://127.0.0.1:1', token: 'local-test' },
    config: {},
    timeoutMs: 10000,
    jsonValidationSchemas: {
      '结果.json': { type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false },
    },
    summaryEnabled,
    ...options,
  });
  t.after(() => session.dispose());
  return { session, workspaceDir, assertJsonValidationPassed };
}

// 为一次模型响应构造真实工具调用结构。
function toolCall(name, args) {
  return { type: 'toolCall', id: `${name}-${Math.random()}`, name, arguments: args };
}

// 记录模型轮数；发生预期之外的请求时立即让检查失败。
function provideResponses(session, responses) {
  let calls = 0;
  session.agent.streamFn = (model) => {
    const content = responses[calls++];
    assert.ok(content, '不应再请求模型生成总结');
    const message = {
      role: 'assistant', content,
      api: model.api, provider: model.provider, model: model.id,
      stopReason: content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: Date.now(),
    };
    const stream = (async function* () {
      yield { type: 'done', reason: message.stopReason, message };
    })();
    stream.result = async () => message;
    return stream;
  };
  return () => calls;
}

test('总结默认开启；显式关闭后省去请求，下一阶段仍能正常运行', async (t) => {
  for (const summaryEnabled of [undefined, true, false]) {
    await t.test(String(summaryEnabled), async (t) => {
      const { session, workspaceDir } = await createTestSession(t, summaryEnabled);
      const disabled = summaryEnabled === false;
      const responses = [[toolCall('write', {
        path: '结果.md', content: '第一阶段结果', ...(disabled ? { task_complete: true } : {}),
      })]];
      if (!disabled) responses.push([{ type: 'text', text: '处理完成的总结' }]);
      const calls = provideResponses(session, responses);
      await session.prompt('写入第一阶段结果。');
      assert.equal(calls(), disabled ? 1 : 2);
      assert.equal(fs.readFileSync(path.join(workspaceDir, '结果.md'), 'utf8'), '第一阶段结果');
      assert.equal(session.messages.at(-1).role, disabled ? 'toolResult' : 'assistant');
      assert.equal(session.agent.state.systemPrompt.includes('本次调用已关闭结束总结'), disabled);
      assert.equal(Boolean(session.getToolDefinition('write').parameters.properties.task_complete), disabled);
      assert.equal(session.getToolDefinition('ask-user').parameters.properties.task_complete, undefined);

      if (disabled) {
        const nextCalls = provideResponses(session, [
          [toolCall('read', { path: '结果.md' })],
          [toolCall('write', { path: '结果.md', content: '第二阶段结果', task_complete: true })],
        ]);
        await session.prompt('读取已有结果后完成第二阶段。');
        assert.equal(nextCalls(), 2);
        assert.equal(fs.readFileSync(path.join(workspaceDir, '结果.md'), 'utf8'), '第二阶段结果');
      }
    });
  }
});

test('结束批次中的校验失败或工具异常必须继续修复，整批成功才结束', async (t) => {
  const { session, workspaceDir } = await createTestSession(t, false);
  fs.writeFileSync(path.join(workspaceDir, '结果.json'), '{"ok":false}', 'utf8');
  const calls = provideResponses(session, [
    [
      toolCall('json-validation', { file_path: '结果.json' }),
      toolCall('ls', { path: '.', task_complete: true }),
    ],
    [toolCall('write', { path: '结果.json', content: '{"ok":true}' })],
    [
      toolCall('json-validation', { file_path: '结果.json', task_complete: true }),
      toolCall('read', { path: '尚未生成.md' }),
    ],
    [toolCall('write', { path: '尚未生成.md', content: '补齐文件' })],
    [
      toolCall('json-validation', { file_path: '结果.json' }),
      toolCall('read', { path: '尚未生成.md', task_complete: true }),
    ],
  ]);
  await session.prompt('校验结果并补齐文件。');
  assert.equal(calls(), 5);
  assert.equal(session.messages.at(-1).role, 'toolResult');
  assert.equal(fs.readFileSync(path.join(workspaceDir, '尚未生成.md'), 'utf8'), '补齐文件');
});

test('自动校验默认关闭，未启用时保持原生写入行为', async (t) => {
  for (const autoValidateJson of [undefined, false]) {
    const { session, assertJsonValidationPassed } = await createTestSession(t, false, { autoValidateJson });
    const calls = provideResponses(session, [[toolCall('write', {
      path: '结果.json', content: '{未完成的 JSON', task_complete: true,
    })]]);
    await session.prompt('写入文件。');
    assert.equal(calls(), 1);
    assert.equal(session.messages.at(-1).isError, false);
    assert.equal(session.messages.at(-1).details?.validation, undefined);
    assert.doesNotThrow(assertJsonValidationPassed);
  }
});

test('自动校验通过即可结束并继续下一阶段，普通文件不受影响，总结开关独立生效', async (t) => {
  for (const summaryEnabled of [false, true]) {
    const { session, workspaceDir, assertJsonValidationPassed } = await createTestSession(t, summaryEnabled, {
      autoValidateJson: true,
      jsonValidationSchemas: { '结果.json': { type: 'object' }, '后续阶段.json': { type: 'array' } },
    });
    const complete = summaryEnabled ? {} : { task_complete: true };
    const responses = [[toolCall('write', { path: '结果.json', content: '{}', ...complete })]];
    if (summaryEnabled) responses.push([{ type: 'text', text: '已完成总结' }]);
    const calls = provideResponses(session, responses);
    await session.prompt('完成第一阶段。');
    assert.equal(calls(), summaryEnabled ? 2 : 1);
    const result = session.messages.find((message) => message.role === 'toolResult');
    assert.equal(result.details.validation.valid, true);
    assert.equal(fs.existsSync(path.join(workspaceDir, '后续阶段.json')), false);
    assert.doesNotThrow(assertJsonValidationPassed);

    const nextResponses = [[
      toolCall('write', { path: '普通说明.md', content: '中文说明' }),
      toolCall('write', { path: '无规则.json', content: '不是 JSON' }),
      toolCall('write', { path: '后续阶段.json', content: '[]', ...complete }),
    ]];
    if (summaryEnabled) nextResponses.push([{ type: 'text', text: '已完成第二阶段总结' }]);
    const nextCalls = provideResponses(session, nextResponses);
    await session.prompt('完成第二阶段。');
    assert.equal(nextCalls(), summaryEnabled ? 2 : 1);
    assert.doesNotThrow(assertJsonValidationPassed);
    const results = session.messages.filter((message) => message.role === 'toolResult').slice(-3);
    assert.ok(results.every((message) => !message.isError));
    assert.equal(results[0].details?.validation, undefined);
    assert.equal(results[1].details?.validation, undefined);
    assert.equal(results[2].details.validation.valid, true);
  }
});

test('自动校验失败保留文件供 edit 修复，多文件未修复错误阻止结束，编辑差异保持完整', async (t) => {
  const filePath = process.platform === 'win32' ? '.\\中文目录\\RESULT.JSON' : '中文目录/Result.json';
  const schema = { type: 'object', properties: { ok: { const: true } }, required: ['ok'] };
  const { session, workspaceDir, assertJsonValidationPassed } = await createTestSession(t, false, {
    autoValidateJson: true,
    jsonValidationSchemas: { '中文目录/Result.json': schema, '另一个.json': schema },
  });
  const calls = provideResponses(session, [
    [toolCall('write', { path: filePath, content: '{"ok":', task_complete: true })],
    [toolCall('edit', { path: filePath, edits: [{ oldText: '{"ok":', newText: '{"ok":false}' }], task_complete: true })],
    [toolCall('write', { path: '另一个.json', content: '{"ok":true}', task_complete: true })],
    [toolCall('edit', { path: filePath, edits: [{ oldText: 'false', newText: 'true' }], task_complete: true })],
  ]);
  await session.prompt('修复两份 JSON。');
  assert.equal(calls(), 4);
  const results = session.messages.filter((message) => message.role === 'toolResult');
  assert.deepEqual(results.map((message) => message.isError), [true, true, true, false]);
  assert.deepEqual(results.map((message) => message.details.validation.stage), ['parse', 'validation', 'success', 'success']);
  assert.match(results[0].content.map((part) => part.text).join('\n'), /文件已写入，但 JSON 校验未通过/);
  assert.match(results[2].content.map((part) => part.text).join('\n'), /尚未通过校验/);
  for (const result of [results[1], results[3]]) {
    assert.ok(result.details.diff);
    assert.ok(result.details.patch);
    assert.equal(result.details.firstChangedLine, 1);
  }
  assert.equal(fs.readFileSync(path.join(workspaceDir, filePath), 'utf8'), '{"ok":true}');
  assert.doesNotThrow(assertJsonValidationPassed);
});

test('直接文字结束仍拒绝未修复结果，独立校验已有文件可以清除错误且不重写文件', async (t) => {
  for (const summaryEnabled of [false, true]) {
    const { session, workspaceDir, assertJsonValidationPassed } = await createTestSession(t, summaryEnabled, { autoValidateJson: true });
    const complete = summaryEnabled ? {} : { task_complete: true };
    const calls = provideResponses(session, [
      [toolCall('write', { path: '结果.json', content: '{"ok":false}', ...complete })],
      [{ type: 'text', text: '直接结束' }],
    ]);
    await session.prompt('生成结果。');
    assert.equal(calls(), 2);
    assert.equal(session.messages.find((message) => message.role === 'toolResult').isError, true);
    assert.throws(assertJsonValidationPassed, { agentValidationFailed: true });
    const resultPath = path.join(workspaceDir, '结果.json');
    fs.writeFileSync(resultPath, '{"ok":true}', 'utf8');
    assert.throws(assertJsonValidationPassed, { agentValidationFailed: true }, 'Main 写入不应隐式触发自动校验');
    const before = fs.statSync(resultPath).mtimeMs;
    const retryResponses = [[toolCall('json-validation', { file_path: '结果.json', ...complete })]];
    if (summaryEnabled) retryResponses.push([{ type: 'text', text: '已检查现有文件' }]);
    const retryCalls = provideResponses(session, retryResponses);
    await session.prompt('仅检查已有结果。');
    assert.equal(retryCalls(), summaryEnabled ? 2 : 1);
    assert.doesNotThrow(assertJsonValidationPassed);
    assert.equal(fs.statSync(resultPath).mtimeMs, before);
  }
});

test('同文件并行写入复用原生串行队列，每次返回对应内容的校验结果', async (t) => {
  const { session, workspaceDir, assertJsonValidationPassed } = await createTestSession(t, false, { autoValidateJson: true });
  const write = session.getToolDefinition('write');
  const results = await Promise.all([
    write.execute('invalid', { path: '结果.json', content: '{"ok":false}' }),
    write.execute('valid', { path: '结果.json', content: '{"ok":true}' }),
  ]);
  assert.equal(results[0].isError, true);
  assert.equal(results[0].details.validation.valid, false);
  assert.equal(results[1].details.validation.valid, true);
  assert.equal(fs.readFileSync(path.join(workspaceDir, '结果.json'), 'utf8'), '{"ok":true}');
  assert.doesNotThrow(assertJsonValidationPassed);
});

test('模版提取按文件提交分类，失败后修正同一文件，成功自动结束且只应用一次', async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), '易标-Pi-模版-'));
  const businessDir = path.join(workspaceDir, '业务目录');
  fs.mkdirSync(businessDir);
  const sourcePath = path.join(businessDir, '源模版.docx');
  const templatePath = path.join(businessDir, 'bid-template.docx');
  const fieldsPath = path.join(businessDir, 'bid-template-fields.json');
  fs.writeFileSync(sourcePath, '测试源模版', 'utf8');
  const fieldsFile = '投标模版字段分类.json';
  const selections = {
    fields: [{ candidate_id: 'c_1', name: '企业名称', fill_by: 'ai' }],
    ignored_candidate_ids: ['c_2'],
  };
  const validContent = JSON.stringify(selections);
  let helperCalls = 0;
  let successfulApplications = 0;
  const workspaceStore = {
    listTenderSourceDocxRelativePaths: () => ['原件.docx'],
    resolveTenderSourceDocxPath: () => ['原件.docx'],
    getBidTemplateSourcePath: () => sourcePath,
    getBidTemplateSourceRelativePath: () => '业务目录/源模版.docx',
    getBidTemplatePath: () => templatePath,
    getBidTemplateRelativePath: () => '业务目录/bid-template.docx',
    getBidTemplateFieldsPath: () => fieldsPath,
    getBidTemplateFieldsRelativePath: () => '业务目录/bid-template-fields.json',
    hasBidTemplate: () => fs.existsSync(templatePath) && fs.existsSync(fieldsPath),
  };
  const result = await runTemplateExtractionTask({
    workspaceStore,
    taskId: '模板文件提交检查',
    outline: [],
    openXmlHelperService: {
      // 只替代未改动的 C# 助手，验证文件内容原样送入其完整分类接口。
      async runJob({ action, request }) {
        helperCalls += 1;
        assert.equal(action, 'apply-template-fields');
        if (!request.ignored_candidate_ids.length) throw new Error('尚未分类：c_2');
        assert.deepEqual(request.fields, selections.fields);
        assert.deepEqual(request.ignored_candidate_ids, selections.ignored_candidate_ids);
        fs.writeFileSync(templatePath, '已应用的测试模版', 'utf8');
        fs.writeFileSync(fieldsPath, JSON.stringify({
          version: 1, fields: [{ id: 'f0001', name: '企业名称', fill_by: 'ai' }],
        }), 'utf8');
        successfulApplications += 1;
        return { blockCount: 1 };
      },
    },
    agentService: {
      async runTask(payload) {
        const { session } = await createTestSession(t, payload.summary_enabled, {
          workspaceDir,
          openXmlTool: payload.open_xml_tool,
          isFinalToolCall: payload.is_final_tool_call,
        });
        const properties = session.getToolDefinition('openxml').parameters.properties;
        assert.ok(properties.fields_file);
        assert.equal(properties.fields, undefined);
        assert.equal(properties.task_complete, undefined);
        assert.equal(payload.is_final_tool_call(toolCall('openxml', { action: 'scan-template-fields' })), false);
        fs.writeFileSync(path.join(workspaceDir, fieldsFile), validContent.replace('"ai"', '"无效类型"'), 'utf8');
        const apply = () => toolCall('openxml', { action: 'apply-template-fields', fields_file: fieldsFile });
        const calls = provideResponses(session, [
          [apply()],
          [toolCall('write', { path: fieldsFile, content: JSON.stringify({ ...selections, ignored_candidate_ids: [] }) })],
          [apply()],
          [toolCall('write', { path: fieldsFile, content: validContent })],
          [apply()],
        ]);
        await session.prompt(payload.prompt);
        assert.equal(calls(), 5, '成功后不得再请求模型检查、总结或重复应用字段');
        assert.equal(session.messages.filter((message) => message.role === 'toolResult' && message.isError).length, 2);
        assert.equal(session.messages.at(-1).role, 'toolResult');
        assert.equal(fs.readFileSync(path.join(workspaceDir, 'bid-template.docx'), 'utf8'), '已应用的测试模版');
        const candidate = {
          task_id: payload.task_id,
          session_id: session.sessionId,
          output_content: fs.readFileSync(path.join(workspaceDir, payload.output_file), 'utf8'),
        };
        assert.deepEqual(payload.validateOutput(candidate), { field_count: 1 });
        return candidate;
      },
      updatePersistentTask() {},
    },
  });
  assert.equal(result.status, 'success');
  assert.equal(result.field_count, 1);
  assert.equal(helperCalls, 2, '结构无效的文件不应提交给助手');
  assert.equal(successfulApplications, 1);
});
