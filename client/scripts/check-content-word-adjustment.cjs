const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createContentImageProtection } = require('../electron/services/contentGenerationEditTools.cjs');
const { checkWordCount, countHtmlWords, createContentGenerationWordTools } = require('../electron/services/contentGenerationWordTools.cjs');
const { createContentGenerationTools, runContentGenerationAgent } = require('../electron/services/contentGenerationAgent.cjs');
const { createPiSession, loadPiModules } = require('../electron/services/pi/piSessionFactory.cjs');

// 仅替换测试所需的外部环境；运行真实业务模块，不修改 require 全局缓存。
function loadWithMocks(relative, mocks) {
  const filename = path.resolve(__dirname, relative);
  const localRequire = createRequire(filename);
  const mod = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`, { filename })(
    name => Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name), mod, mod.exports,
  );
  return mod.exports;
}

// 真实 Pi 自动执行模型工具调用；只替换模型响应，不替换编辑、钩子或文件写入。
async function checkImageProtection(root, piAi) {
  const workspaceDir = path.join(root, '图片写入保护');
  fs.mkdirSync(path.join(workspaceDir, '正文'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, '图片'), { recursive: true });
  const file = '正文/小节一.html';
  const absoluteFile = path.join(workspaceDir, file);
  const figure = n => `<figure id="图${n}" data-yb-generation="aiImage" data-yb-size="square"><template data-yb-role="prompt">图片提示${n}</template><img alt="图片${n}" data-yb-asset-ref="图片/${n}.png"><figcaption>图注${n}</figcaption></figure>`;
  const figures = Array.from({ length: 9 }, (_, i) => figure(i));
  figures.forEach((_value, i) => fs.writeFileSync(path.join(workspaceDir, `图片/${i}.png`), Buffer.from([0, i, 255])));
  const original = `<!-- yibiao:block -->\n<p id="text">普通说明</p>\n${figures[0]}\n<table id="图文" data-yb-preset="imageText"><tbody><tr><td>${figures[1]}</td><td><p>右侧说明</p></td></tr></tbody></table>\n<table id="三列" data-yb-preset="threeImages"><tbody><tr>${figures.slice(2, 5).map(item => `<td>${item}</td>`).join('')}</tr></tbody></table>\n<table id="四宫" data-yb-preset="fourImages"><tbody><tr><td>${figures[5]}</td><td>${figures[6]}</td></tr><tr><td>${figures[7]}</td><td>${figures[8]}</td></tr></tbody></table>`;
  const initialBytes = Buffer.from(`\uFEFF${original.replace(/\n/g, '\r\n')}`, 'utf8');
  fs.writeFileSync(absoluteFile, initialBytes);
  fs.writeFileSync(path.join(workspaceDir, '正文编排决策.json'), JSON.stringify({
    targets: [{ id: 'one', number: '1', title: '测试', file }], word_control: { minimumWords: 0, maximumWords: 0, checkTotalWords: true },
  }), 'utf8');
  const environment = { shellPath: process.env.ComSpec, layout: { agentDir: path.join(root, 'image-agent') }, instructions: '检查图片保护', env: {} };
  const base = { workspaceDir, environment, config: {}, timeoutMs: 60000, summaryEnabled: false, proxyInfo: { baseUrl: 'http://127.0.0.1:1', token: 'test' } };
  const childProtection = createContentImageProtection({ workspaceDir, files: [file], active: true });
  const child = await createPiSession({ ...base, activeTools: ['read', 'edit', 'report-failure'], beforeFileWrite: childProtection.beforeWrite, beforeToolCall: childProtection.beforeToolCall });
  try {
    const edit = child.session.agent.state.tools.find(tool => tool.name === 'edit');
    const candidates = [
      original.replace(figures[0], ''),
      original.replace('图片/0.png', '图片/1.png'),
      original.replace('alt="图片0"', 'alt="替换图片"'),
      original.replace('图注0', '新图注'),
      original.replace('图片提示0', '新提示'),
      original.replace(figures[0], `${figures[0]}${figures[0]}`),
      original.replace(figures[2], '临时').replace(figures[3], figures[2]).replace('临时', figures[3]),
      original.replace('data-yb-preset="threeImages"', 'data-yb-preset="fourImages"'),
      original.replace(`<td>${figures[1]}</td><td><p>右侧说明</p></td>`, `<td><p>右侧说明</p></td><td>${figures[1]}</td>`),
      original.replace(`<td>${figures[7]}</td><td>${figures[8]}</td>`, `<td colspan="2">${figures[7]}${figures[8]}</td>`),
      original.replace(figures[0], `<template>${figures[0]}</template>`),
    ];
    for (const [index, content] of candidates.entries()) {
      await assert.rejects(edit.execute('protected', { path: file, edits: [{ oldText: original, newText: content }] }), /受保护图片/, `图片保护样例 ${index}`);
      assert.deepEqual(fs.readFileSync(absoluteFile), initialBytes, '拒绝必须发生在落盘前，包括原有 BOM 和 CRLF');
    }
    const secondFile = path.join(workspaceDir, '正文/小节二.html');
    fs.writeFileSync(secondFile, '<p>其他小节</p>', 'utf8');
    for (const target of ['正文/小节二.html', '图片/0.png']) {
      const oldText = fs.readFileSync(path.join(workspaceDir, target), 'utf8');
      await assert.rejects(edit.execute('other-file', { path: target, edits: [{ oldText, newText: '修改' }] }), /正文编辑只能/);
    }
    assert.equal(fs.readFileSync(secondFile, 'utf8'), '<p>其他小节</p>');
    assert.deepEqual(fs.readFileSync(path.join(workspaceDir, '图片/0.png')), Buffer.from([0, 0, 255]));
    // 一次完整替换经过图片但保持图片不变，应允许修改图文表格的说明文字。
    await edit.execute('allowed', { path: file, edits: [{ oldText: original, newText: original.replace('<p>右侧说明</p>', '<ul><li>扩写后的右侧说明</li></ul>') }] });
    assert.match(fs.readFileSync(absoluteFile, 'utf8'), /扩写后的右侧说明/);
  } finally { child.session.dispose(); }
  fs.writeFileSync(absoluteFile, initialBytes);

  let protection;
  let entered = 0;
  const main = await createPiSession({ ...base, autoValidateJson: true,
    jsonValidationSchemas: { '正文生成结果.json': { type: 'object', required: ['sections'], properties: { sections: { type: 'array' } }, additionalProperties: false } },
    beforeFileWrite: context => protection.beforeWrite(context), beforeToolCall: context => protection.beforeToolCall(context),
    createTools(context) {
      protection = createContentImageProtection({ workspaceDir, files: [file], allowManifest: true, setActiveTools: context.setActiveTools, onEnter: () => { entered++; } });
      return createContentGenerationWordTools({ activity: { pending: 0 }, imageProtection: protection,
        validateHtml: require('../electron/services/contentGenerationImageTools.cjs').validateContentImageReferences,
      }, context);
    },
  });
  try {
    let calls = 0;
    const events = [];
    main.session.subscribe(event => { if (event.type === 'tool_execution_end') events.push(event); });
    const call = (name, args) => ({ type: 'toolCall', id: `call-${calls}-${name}`, name, arguments: args });
    main.session.agent.streamFn = () => {
      calls++;
      assert.ok(calls <= 2, '错误后应继续一次并在成功编辑后完成，不能额外请求真实模型');
      const content = calls === 1 ? [
        call('check-word-count', {}),
        call('edit', { path: file, edits: [{ oldText: figures[0], newText: '' }], task_complete: true }),
        call('write', { path: file, content: '<p>覆盖正文</p>' }),
        call('bash', { command: 'echo should-not-run' }),
      ] : [call('edit', { path: file, edits: [{ oldText: '普通说明', newText: '扩写后的普通说明' }], task_complete: true })];
      const message = { role: 'assistant', content, api: 'openai-completions', provider: 'yibiao', model: 'default', stopReason: 'toolUse', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = piAi.createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'toolUse', message });
      return stream;
    };
    await main.session.prompt('检查字数后调整文字，不修改图片', { expandPromptTemplates: false });
    assert.equal(calls, 2);
    assert.equal(entered, 1);
    assert.deepEqual(events.map(event => [event.toolName, event.isError]), [['check-word-count', false], ['edit', true], ['write', true], ['bash', true], ['edit', false]]);
    assert.match(fs.readFileSync(absoluteFile, 'utf8'), /扩写后的普通说明/);
    figures.forEach(item => assert.ok(fs.readFileSync(absoluteFile, 'utf8').includes(item)));
    assert.equal(main.session.getActiveToolNames().includes('bash'), false);
    const write = main.session.agent.state.tools.find(tool => tool.name === 'write');
    const badJson = await write.execute('bad-json', { path: '正文生成结果.json', content: '{}' });
    assert.equal(badJson.isError, true, '图片写入保护不能覆盖原有 JSON 自动校验');
    await write.execute('good-json', { path: '正文生成结果.json', content: '{"sections":[]}' });
    main.assertJsonValidationPassed();
    await assert.rejects(write.execute('input', { path: '正文编排决策.json', content: '{}' }), /正文编辑只能/);
  } finally { main.session.dispose(); }
}

// 使用中文临时工作区验证边界、原生编辑和父子任务生命周期，不请求真实模型。
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '正文字数检查-'));
  const workspaceDir = path.join(root, '主会话');
  const targets = ['一', '二'].map((title, i) => ({ id: `section-${i}`, number: `1.${i + 1}`, title, file: `正文/section-${i}.html` }));
  const write = (file, text) => {
    const target = path.join(workspaceDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, 'utf8');
  };
  const html = count => `<!-- yibiao:block -->\n<p id="body">${'文'.repeat(count)}</p>`;
  const decisions = { targets, has_knowledge_base: false, word_control: { minimumWords: 0, maximumWords: 0, checkTotalWords: true } };
  const saveDecisions = () => write('正文编排决策.json', JSON.stringify(decisions));
  let service;
  try {
    const { typebox: { Type }, codingAgent, piAi } = await loadPiModules();
    await checkImageProtection(root, piAi);
    targets.forEach(section => write(section.file, html(10)));
    assert.equal(countHtmlWords('<p>中文 English</p><template>不应统计这些提示词</template>'), 3);
    for (const [minimumWords, maximumWords, difference, direction, adjustment] of [
      [0, 0, 0, 'none', 'none'], [20, 20, 0, 'none', 'none'],
      [21, 0, 1, 'expand', 'main'], [0, 19, 1, 'shrink', 'main'],
      [10020, 0, 10000, 'expand', 'main'], [10021, 20000, 10001, 'expand', 'parallel'],
    ]) {
      decisions.word_control = { minimumWords, maximumWords, checkTotalWords: true };
      saveDecisions();
      const result = checkWordCount(workspaceDir);
      assert.deepEqual([result.difference, result.direction, result.adjustment], [difference, direction, adjustment]);
    }
    write(targets[0].file, html(20001));
    decisions.word_control = { minimumWords: 0, maximumWords: 10010, checkTotalWords: true };
    saveDecisions();
    assert.equal(checkWordCount(workspaceDir).adjustment, 'parallel');
    decisions.word_control.checkTotalWords = false;
    saveDecisions();
    assert.equal(checkWordCount(workspaceDir).in_range, true);
    fs.unlinkSync(path.join(workspaceDir, targets[1].file));
    assert.equal(checkWordCount(workspaceDir).complete, false);
    write(targets[1].file, '<p></p>');
    assert.equal(checkWordCount(workspaceDir).in_range, false);
    targets.forEach(section => write(section.file, html(10)));
    write('受限HTML生成规范.md', '保留段落和图片');
    write('全局事实设定.md', '保留事实');
    write('项目概述.md', '测试项目');
    write('正文模板.html', '<p>样张</p>');
    write('配图类型对照表.md', '思维导图=mermaid');
    write('所选模板配置.json', '{}');
    write('正文生成结果.json', JSON.stringify({ sections: targets.map(section => ({ section_id: section.id, file: section.file, words: 10 })) }));

    // 真实 Pi SDK 工具注册与编辑：未命中不写文件，读取最新原文后可以继续。
    const created = await createPiSession({
      workspaceDir, config: {}, timeoutMs: 60000, summaryEnabled: false,
      activeTools: ['read', 'edit', 'report-failure'],
      environment: { shellPath: process.env.ComSpec, layout: { agentDir: path.join(root, 'agent') }, instructions: '检查原生编辑', env: {} },
      proxyInfo: { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    });
    assert.deepEqual(created.snapshot.active_tools.sort(), ['edit', 'read', 'report-failure']);
    created.session.dispose();
    const edit = codingAgent.createEditToolDefinition(workspaceDir);
    await assert.rejects(edit.execute('miss', { path: targets[0].file, edits: [{ oldText: '不存在的原文', newText: '替换' }] }), /./);
    assert.equal(fs.readFileSync(path.join(workspaceDir, targets[0].file), 'utf8'), html(10));
    const read = codingAgent.createReadToolDefinition(workspaceDir);
    assert.match(JSON.stringify(await read.execute('read', { path: targets[0].file })), /文文文/);

    // 保留真实 Runtime 的继续/清理流程，仅将模型会话替换为确定性操作。
    let promptAction = async () => {};
    const sessions = [];
    const runtimeEvents = [];
    const failureReports = [];
    const layout = { runtimeRoot: path.join(root, 'runtime'), tasksRoot: path.join(root, 'runtime/tasks'), workspaceDir: path.join(root, 'service') };
    const runtimeModule = loadWithMocks('../electron/services/pi/piRuntimeService.cjs', {
      './piEnvironment.cjs': { preparePiEnvironment: () => ({ layout }) },
      '../agent/agentRuntimeAnalytics.cjs': { trackAgentRuntime(_app, _config, event) { runtimeEvents.push(event); } },
      '../agent/agentOpenAiProxy.cjs': { createAgentOpenAiProxy: () => ({ async start() { return {}; }, async close() {} }) },
      './piSessionFactory.cjs': { loadPiModules, async createPiSession(options) {
        assert.equal(options.workspaceDir, workspaceDir);
        assert.ok(options.sessionsDir.startsWith(layout.tasksRoot));
        fs.mkdirSync(options.sessionsDir, { recursive: true });
        fs.writeFileSync(path.join(options.sessionsDir, 'session.jsonl'), '{}', 'utf8');
        options.businessTools = options.createTools?.({ Type, workspaceDir, setActiveTools() {} });
        const session = { sessionId: `session-${sessions.length}`, messages: [], subscribe: () => () => {}, dispose() {}, async abort() {},
          prompt: prompt => promptAction(options, prompt) };
        sessions.push(session);
        return { session, snapshot: {}, assertJsonValidationPassed() {} };
      } },
    });
    const { createAgentService } = loadWithMocks('../electron/services/agentService.cjs', {
      electron: { dialog: {} }, './pi/piRuntimeService.cjs': runtimeModule,
      './agent/agentErrorReporter.cjs': { createAgentErrorReporter: () => ({ async reportFailure(report) { failureReports.push(report); }, async close() {} }) },
    });
    service = createAgentService({ app: { getPath: () => root }, configStore: { load: () => ({}) }, aiService: {} });
    const cancellation = new AbortController();
    const scoped = service.bindTaskContext(() => ({}), { queueScopeId: 'body-queue', primary_session: true, signal: cancellation.signal });
    await scoped.runTask({ task_id: 'parent', workspace_dir: workspaceDir, output_file: targets[0].file, summary_enabled: false });
    const primary = service.getPrimarySession();
    assert.equal(primary.task_id, 'parent');
    let releaseBatch;
    const batchGate = new Promise(resolve => { releaseBatch = resolve; });
    let started = 0;
    let allStarted;
    const startedGate = new Promise(resolve => { allStarted = resolve; });
    promptAction = async (options, prompt) => {
      assert.deepEqual(options.activeTools, ['read', 'edit', 'report-failure']);
      started += 1;
      if (started === 2) allStarted();
      await batchGate;
      const section = targets.find(section => prompt.includes(`文件为 ${section.file}`));
      await edit.execute('edit', { path: section.file, edits: [{ oldText: '文'.repeat(10), newText: '文'.repeat(15) }] });
    };
    const activity = { pending: 0 };
    const [check, adjust] = createContentGenerationWordTools({
      agentService: { runTask(payload) {
        assert.equal(payload.primary_session, false);
        assert.equal(payload.failure_handled_by_parent, true);
        assert.equal(payload.workspace_dir, workspaceDir);
        return scoped.runTask(payload);
      } }, signal: cancellation.signal, activity, validateHtml: (_root, content) => assert.ok(countHtmlWords(content) > 0),
    }, { Type, workspaceDir });
    const pending = adjust.execute('batch', { sections: targets.map(section => ({ section_id: section.id, instructions: '扩写五字' })) });
    await startedGate;
    await assert.rejects(check.execute(), /仍有/);
    assert.equal(service.getPrimarySession().session_id, primary.session_id);
    releaseBatch();
    assert.ok((await pending).details.results.every(result => result.status === 'success'));
    assert.equal((await check.execute()).details.total_words, 30);
    assert.equal(fs.existsSync(path.join(workspaceDir, '正文生成结果.json')), true);
    assert.deepEqual(fs.readdirSync(layout.tasksRoot), []);

    // 一节失败会返回明确错误，其他小节仍完成，主会话文件不会被失败清理删除。
    let failedSession;
    promptAction = async (options, prompt) => {
      if (prompt.includes(`文件为 ${targets[0].file}`)) failedSession = options;
      if (failedSession === options) throw new Error('模型不可用');
    };
    const failedBatch = await adjust.execute('partial-error', { sections: targets.map(section => ({ section_id: section.id, instructions: '失败检查' })) });
    assert.deepEqual(failedBatch.details.results.map(result => result.status), ['error', 'success']);
    assert.match(failedBatch.details.results[0].error, /模型不可用/);
    assert.equal(fs.readFileSync(path.join(workspaceDir, targets[0].file), 'utf8'), html(15));
    assert.equal(failureReports.length, 0, '主 Agent 可处理的子任务错误不应启动最终诊断上报');
    assert.equal(runtimeEvents.filter(event => event === 'failed').length, 1, '子任务真实失败仍须计入运行统计');

    // 同批多个失败不重复上报；重试成功仍保留成功统计。
    promptAction = async () => { throw new Error('批次失败'); };
    const failedAll = await adjust.execute('all-error', { sections: targets.map(section => ({ section_id: section.id, instructions: '批次失败检查' })) });
    assert.ok(failedAll.details.results.every(result => result.status === 'error'));
    assert.equal(failureReports.length, 0);
    assert.equal(runtimeEvents.filter(event => event === 'failed').length, 3);
    promptAction = async () => {};
    const successCount = runtimeEvents.filter(event => event === 'success').length;
    const retried = await adjust.execute('retry', { sections: [{ section_id: targets[0].id, instructions: '重试检查' }] });
    assert.equal(retried.details.results[0].status, 'success');
    assert.equal(runtimeEvents.filter(event => event === 'success').length, successCount + 1);
    assert.equal(failureReports.length, 0);

    // 关闭字数修复时停用主流程入口；扩缩写工具及子任务仍保留。
    decisions.word_control = { minimumWords: 35, maximumWords: 35, checkTotalWords: true };
    saveDecisions();
    let rounds = 0;
    promptAction = async (options, prompt) => {
      if (prompt.includes('现在执行第')) {
        await options.businessTools.find(tool => tool.name === 'complete-consistency-round').execute('done', { summary: '无矛盾', remaining_issues: [] });
        return;
      }
      rounds += 1;
      assert.ok(!options.businessTools.some(tool => tool.name === 'adjust-sections'));
      assert.match(prompt, /统计完成后保持正文不变/);
    };
    await runContentGenerationAgent({
      signal: cancellation.signal, hasKnowledgeBase: false, buildFiles: () => [], aiService: {},
      agentService: { hasPersistentTaskSession: () => false, updatePersistentTask() {}, runTask(payload) {
        const { persistent_task, ...transient } = payload;
        return scoped.runTask({ ...transient, workspace_dir: workspaceDir }).then(result => ({ ...result, workspace_dir: workspaceDir }));
      } },
    });
    assert.equal(rounds, 1);
    assert.equal(checkWordCount(workspaceDir).in_range, false);
    assert.equal(checkWordCount(workspaceDir).total_words, 30, '不达标时不修改首稿，直接审计');

    // 主任务最终失败和普通任务失败仍上报，保留原错误和工作区诊断范围。
    const finalError = new Error('主任务最终失败');
    promptAction = async () => { throw finalError; };
    await assert.rejects(runContentGenerationAgent({
      signal: cancellation.signal, hasKnowledgeBase: false, buildFiles: () => [], aiService: {},
      agentService: { hasPersistentTaskSession: () => false, updatePersistentTask() {}, runTask(payload) {
        const { persistent_task, ...transient } = payload;
        return scoped.runTask({ ...transient, workspace_dir: workspaceDir });
      } },
    }), error => error === finalError);
    assert.equal(failureReports.length, 1);
    assert.equal(failureReports[0].payload.title, '投标文件正文生成');
    assert.equal(failureReports[0].error, finalError);
    assert.equal(failureReports[0].error.agentWorkspaceDir, workspaceDir);
    const ordinaryError = new Error('普通任务失败');
    promptAction = async () => { throw ordinaryError; };
    await assert.rejects(service.runTask({
      title: '普通任务', primary_session: false, workspace_dir: workspaceDir,
      output_file: targets[0].file, summary_enabled: false,
    }), error => error === ordinaryError);
    assert.equal(failureReports.length, 2);
    assert.equal(failureReports[1].payload.title, '普通任务');
    assert.equal(runtimeEvents.filter(event => event === 'failed').length, 5);
    assert.equal(fs.existsSync(path.join(workspaceDir, '正文生成结果.json')), true);

    // 生成未完成时不能计数；取消并发编辑后保留主工作区和已完成编辑。
    let finishGeneration;
    const tools = createContentGenerationTools({ signal: cancellation.signal, aiService: { chat: () => new Promise(resolve => { finishGeneration = resolve; }) } }, { Type, workspaceDir });
    const generating = tools[0].execute('generate', { sections: [{ section_id: targets[0].id, instructions: '', references: '' }] });
    await assert.rejects(tools.find(tool => tool.name === 'check-word-count').execute(), /仍有/);
    finishGeneration(html(20));
    await generating;
    const beforeCancel = fs.readFileSync(path.join(workspaceDir, targets[0].file), 'utf8');
    let entered;
    const enteredGate = new Promise(resolve => { entered = resolve; });
    promptAction = () => new Promise((resolve, reject) => {
      entered();
      cancellation.signal.addEventListener('abort', () => reject(cancellation.signal.reason), { once: true });
    });
    const cancelPending = adjust.execute('cancel', { sections: [{ section_id: targets[0].id, instructions: '取消检查' }] });
    await enteredGate;
    cancellation.abort(new Error('用户暂停'));
    await assert.rejects(cancelPending, /用户暂停/);
    assert.equal(activity.pending, 0);
    assert.equal(fs.readFileSync(path.join(workspaceDir, targets[0].file), 'utf8'), beforeCancel);
    assert.equal(failureReports.length, 2, '取消不应增加失败诊断');
    console.log('通过：边界、10000字分界、等待整批、原生编辑、首稿跳过扩缩写、取消、共享工作区生命周期、子任务错误处理与最终失败诊断及运行统计');
  } finally {
    await service?.close();
    // 只删除本检查创建的临时根目录，不接触真实业务工作区。
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('正文字数检查-')) fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
