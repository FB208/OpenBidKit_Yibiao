const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createContentImageProtection, imageStructure } = require('../electron/services/contentGenerationEditTools.cjs');
const { taskFilePath } = require('../electron/services/contentGenerationTaskFiles.cjs');
const { checkWordCount, countHtmlWords, createContentGenerationWordTools } = require('../electron/services/contentGenerationWordTools.cjs');
const { createContentGenerationTools, runContentGenerationAgent } = require('../electron/services/contentGenerationAgent.cjs');
const { createPiSession, loadPiModules } = require('../electron/services/pi/piSessionFactory.cjs');
const { NATIVE_AGENT_TOOLS } = require('../electron/services/agent/agentToolEnvironment.cjs');

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

// 真实 Pi 自动执行模型工具调用；只替换模型响应。图片保护不再拦截写入，改为提交时比对保护开始时的图片结构。
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
  // 提交时比对图片结构：删除、替换、复制、调序、改图注或提示词、改图片表格布局及移入不可见容器都能识别。
  const expected = imageStructure(original);
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
  for (const [index, content] of candidates.entries()) assert.notEqual(imageStructure(content), expected, `图片保护样例 ${index}`);
  assert.equal(imageStructure(initialBytes.toString('utf8')), expected, 'BOM 和 CRLF 不影响比对');
  assert.equal(imageStructure(original.replace('<p>右侧说明</p>', '<ul><li>扩写后的右侧说明</li></ul>')), expected, '图文表格中的说明文字可以调整');

  let protection;
  let entered = 0;
  const records = {};
  const main = await createPiSession({ ...base,
    jsonValidationSchemas: { '正文生成结果.json': { type: 'object', required: ['sections'], properties: { sections: { type: 'array' } }, additionalProperties: false } },
    beforeToolCall: context => protection.beforeToolCall(context),
    createTools(context) {
      protection = createContentImageProtection({ workspaceDir, files: [file], setActiveTools: context.setActiveTools, onEnter: () => { entered++; },
        baseline: { saveRecord: (name, value) => { records[name] = value; }, loadRecord: name => records[name] || null } });
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
      assert.ok(calls <= 2, '不能额外请求真实模型');
      const content = calls === 1 ? [
        call('check-word-count', {}),
        call('edit', { path: file, edits: [{ oldText: figures[0], newText: '' }] }),
        call('bash', { command: 'echo 命令可用' }),
      ] : [call('edit', { path: file, edits: [{ oldText: '普通说明', newText: '扩写后的普通说明' }], task_complete: true })];
      const message = { role: 'assistant', content, api: 'openai-completions', provider: 'yibiao', model: 'default', stopReason: 'toolUse', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = piAi.createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'toolUse', message });
      return stream;
    };
    await main.session.prompt('检查字数后调整文字，不修改图片', { expandPromptTemplates: false });
    assert.equal(calls, 2);
    assert.equal(entered, 1);
    // 保护阶段写入照常执行，图片块改动留给提交校验按保护开始时的记录退回。
    assert.deepEqual(events.map(event => [event.toolName, event.isError]), [['check-word-count', false], ['edit', false], ['bash', false], ['edit', false]]);
    const recorded = protection.recorded(file);
    assert.equal(recorded.structure, expected, '记录保护开始时的图片结构');
    assert.equal(recorded.blocks[0], figures[0], '原始图片块按出现顺序保存');
    assert.equal(recorded.blocks.length, 4, '含图片的表格整体作为一块');
    assert.deepEqual(records['content-images'][file], recorded, '图片记录保存到任务目录供暂停恢复');
    const current = fs.readFileSync(absoluteFile, 'utf8');
    assert.match(current, /扩写后的普通说明/);
    assert.notEqual(imageStructure(current), recorded.structure, '删掉的图片在提交时识别');
    assert.ok(main.session.getActiveToolNames().includes('bash'), '保护阶段仍可执行命令');
    assert.throws(() => protection.beforeToolCall({ toolCall: { name: 'generate-section-images' } }), /正文编辑期间不能调用/);
    const write = main.session.agent.state.tools.find(tool => tool.name === 'write');
    const unchecked = await write.execute('unchecked-json', { path: '正文生成结果.json', content: '{}' });
    assert.ok(!unchecked.isError, '结果清单在提交时统一校验，写入时不拦截');
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
  const decisions = { execution_summary: {}, targets, has_knowledge_base: false, word_control: { minimumWords: 0, maximumWords: 0, checkTotalWords: true } };
  // 与正式入口一致提供执行清单，交接摘要从中整理。
  const decisionFiles = () => [{ path: '正文编排决策.json', content: JSON.stringify(decisions) }];
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
    assert.deepEqual(created.snapshot.active_tools.sort(), [...NATIVE_AGENT_TOOLS, 'report-failure'].sort(), '原生工具始终启用');
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
        return { session, snapshot: {} };
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
      assert.deepEqual(options.activeTools, [...NATIVE_AGENT_TOOLS, 'report-failure']);
      started += 1;
      if (started === 2) allStarted();
      await batchGate;
      const section = targets.find(section => prompt.includes(`文件为 ${section.file}`));
      await edit.execute('edit', { path: section.file, edits: [{ oldText: '文'.repeat(10), newText: '文'.repeat(15) }] });
    };
    const activity = { pending: 0 };
    // 批量工具读取固定任务文件：写入后无参数提交，工具在调用时同步读取文件。
    const submit = (tool, key, callId, params, ...rest) => {
      const target = path.join(workspaceDir, taskFilePath(key));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(params), 'utf8');
      return tool.execute(callId, {}, ...rest);
    };
    const [check, adjust] = createContentGenerationWordTools({
      agentService: { runTask(payload) {
        assert.equal(payload.primary_session, false);
        assert.equal(payload.failure_handled_by_parent, true);
        assert.equal(payload.workspace_dir, workspaceDir);
        return scoped.runTask(payload);
      } }, signal: cancellation.signal, activity, validateHtml: (_root, content) => assert.ok(countHtmlWords(content) > 0),
    }, { Type, workspaceDir });
    const pending = submit(adjust, 'adjust', 'batch', { sections: targets.map(section => ({ section_id: section.id, instructions: '扩写五字' })) });
    await startedGate;
    await assert.rejects(check.execute(), /仍有/);
    assert.equal(service.getPrimarySession().session_id, primary.session_id);
    releaseBatch();
    const adjusted = await pending;
    assert.ok(adjusted.details.results.every(result => result.status === 'success'));
    assert.deepEqual(JSON.parse(adjusted.content[0].text), { total: 2, success: 2, skipped: 0, unresolved: [] });
    const counted = await check.execute();
    assert.equal(counted.details.total_words, 30);
    // 各节字数写入程序清单，模型只接收总数和差额。
    const brief = JSON.parse(counted.content[0].text);
    assert.equal(brief.total_words, 30);
    assert.equal(brief.detail_file, '程序清单/正文字数统计.json');
    assert.equal(brief.sections, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspaceDir, brief.detail_file), 'utf8')).sections, counted.details.sections);
    assert.equal(fs.existsSync(path.join(workspaceDir, '正文生成结果.json')), true);
    assert.deepEqual(fs.readdirSync(layout.tasksRoot), []);

    // 一节失败会返回明确错误，其他小节仍完成，主会话文件不会被失败清理删除。
    let failedSession;
    promptAction = async (options, prompt) => {
      if (prompt.includes(`文件为 ${targets[0].file}`)) failedSession = options;
      if (failedSession === options) throw new Error('模型不可用');
    };
    const failedBatch = await submit(adjust, 'adjust', 'partial-error', { sections: targets.map(section => ({ section_id: section.id, instructions: '失败检查' })) });
    assert.deepEqual(failedBatch.details.results.map(result => result.status), ['error', 'success']);
    assert.match(failedBatch.details.results[0].error, /模型不可用/);
    assert.equal(fs.readFileSync(path.join(workspaceDir, targets[0].file), 'utf8'), html(15));
    assert.equal(failureReports.length, 0, '主 Agent 可处理的子任务错误不应启动最终诊断上报');
    assert.equal(runtimeEvents.filter(event => event === 'failed').length, 1, '子任务真实失败仍须计入运行统计');

    // 同批多个失败不重复上报；重试成功仍保留成功统计。
    promptAction = async () => { throw new Error('批次失败'); };
    const failedAll = await submit(adjust, 'adjust', 'all-error', { sections: targets.map(section => ({ section_id: section.id, instructions: '批次失败检查' })) });
    assert.ok(failedAll.details.results.every(result => result.status === 'error'));
    assert.equal(failureReports.length, 0);
    assert.equal(runtimeEvents.filter(event => event === 'failed').length, 3);
    promptAction = async () => {};
    const successCount = runtimeEvents.filter(event => event === 'success').length;
    const retried = await submit(adjust, 'adjust', 'retry', { sections: [{ section_id: targets[0].id, instructions: '重试检查' }] });
    assert.equal(retried.details.results[0].status, 'success');
    assert.equal(runtimeEvents.filter(event => event === 'success').length, successCount + 1);
    assert.equal(failureReports.length, 0);

    // 关闭字数修复时停用主流程入口；扩缩写工具及子任务仍保留。
    decisions.word_control = { minimumWords: 35, maximumWords: 35, checkTotalWords: true };
    saveDecisions();
    let rounds = 0;
    promptAction = async (options, prompt) => {
      if (prompt.includes('现在执行全文一致性审计')) {
        await options.businessTools.find(tool => tool.name === 'complete-consistency-round').execute('done', { summary: '无矛盾', remaining_issues: [] });
        return;
      }
      rounds += 1;
      assert.ok(!options.businessTools.some(tool => tool.name === 'adjust-sections'));
      assert.match(prompt, /统计完成后保持正文不变/);
    };
    await runContentGenerationAgent({
      signal: cancellation.signal, hasKnowledgeBase: false, buildFiles: decisionFiles, aiService: { chat: async () => '', requestJson: async () => ({ issues: [], facts: [] }) },
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
      signal: cancellation.signal, hasKnowledgeBase: false, buildFiles: decisionFiles, aiService: { chat: async () => '', requestJson: async () => ({ issues: [], facts: [] }) },
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
    const generating = submit(tools[0], 'sections', 'generate', { sections: [{ section_id: targets[0].id, instructions: '', references: '', regenerate: true }] });
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
    const cancelPending = submit(adjust, 'adjust', 'cancel', { sections: [{ section_id: targets[0].id, instructions: '取消检查' }] });
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
