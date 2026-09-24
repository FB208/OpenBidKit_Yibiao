const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CONTENT_GENERATION_AGENT_TASK_KEY, buildContentGenerationFiles, createContentGenerationTools, runContentGenerationAgent, runContentLayoutAgent, readContentGenerationResult } = require('../electron/services/contentGenerationAgent.cjs');
const { createContentGenerationImageTools } = require('../electron/services/contentGenerationImageTools.cjs');

// 用真实文本队列核对源码并发、独立落盘和渲染交接，不请求外部模型。
async function checkImageSourceGeneration({ Type, workspaceDir, signal }) {
  const { createAiRequestQueue } = require('../electron/utils/aiRequestQueue.cjs');
  const queue = createAiRequestQueue({ getLimit: () => 2 });
  const pending = new Map();
  const requests = [];
  const aiService = { chat(request) {
    requests.push(request);
    return queue.enqueue(() => new Promise((resolve, reject) => pending.set(request.messages[1].content, { resolve, reject })), { signal: request.signal, maxAttempts: 1 });
  } };
  const renderer = {};
  const tools = createContentGenerationImageTools({ aiService, signal, localImageRenderService: renderer }, { Type, workspaceDir });
  const tool = tools.find(item => item.name === 'generate-image-sources');
  const jobs = [
    { image_id: '进度图', kind: 'html', frame_size: 'wide', prompt: '进度：准备2天，实施3天' },
    { image_id: '流程图', kind: 'mermaid', prompt: '流程图：准备后实施' },
    { image_id: '失败图', kind: 'mermaid', prompt: '思维导图：实施管理' },
  ];
  const html = '<!doctype html><html><body><div>准备2天，实施3天</div></body></html>';
  const mermaid = 'flowchart LR\nA["准备"] --> B["实施"]';
  const operation = tool.execute('sources', { images: jobs });
  assert.deepEqual(requests.map(request => request.messages[1].content), jobs.map(job => job.prompt));
  assert.equal(pending.size, 2, '源码请求遵守现有文本并发上限');
  assert.match(requests[0].messages[0].content, /1240×827px.*40px/);
  assert.match(requests[0].messages[0].content, /Flex\/Grid/);
  assert.match(requests[0].messages[0].content, /不在底部留下大块空白/);
  assert.match(requests[1].messages[0].content, /flowchart.*mindmap.*erDiagram/);
  assert.ok(requests.every(request => request.signal && request.logTitle.startsWith('Agent 配图源码-')));
  pending.get(jobs[1].prompt).resolve(mermaid);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.size, 3, '成功项完成后启动下一张');
  pending.get(jobs[2].prompt).reject(new Error('模拟源码生成失败'));
  pending.get(jobs[0].prompt).resolve(html);
  const results = (await operation).details.results;
  assert.deepEqual(results.map(result => [result.image_id, result.status]), [['进度图', 'success'], ['流程图', 'success'], ['失败图', 'error']]);
  assert.match(results[2].error, /模拟源码生成失败/);
  assert.equal(results[0].frame_size, 'wide');
  for (const [index, source] of [html, mermaid].entries()) {
    const result = results[index];
    assert.match(result.source_file, index === 0 ? /^图片\/[^/]+\.html$/ : /^图片\/[^/]+\.mmd$/);
    assert.equal(fs.readFileSync(path.join(workspaceDir, result.source_file), 'utf8'), source);
    renderer[index === 0 ? 'renderHtmlToPng' : 'renderMermaidToPng'] = async (text, options) => {
      assert.equal(text, source);
      if (index === 0) assert.equal(options.frameSize, 'wide');
      return { buffer: Buffer.from('图片'), width: 100, height: 80, layout_issues: [] };
    };
    const rendered = await tools.find(item => item.name === `render-${result.kind}-image`).execute('render-source', result);
    assert.equal(fs.readFileSync(path.join(workspaceDir, rendered.details.asset_ref), 'utf8'), '图片');
  }
  for (const [frame_size, height] of Object.entries({ square: 1240, tall: 1653, panorama: 698 })) {
    aiService.chat = async request => { assert.ok(request.messages[0].content.includes(`1240×${height}px`)); return html; };
    const retry = (await tool.execute('new-source', { images: [{ ...jobs[0], frame_size }] })).details.results[0];
    assert.equal(retry.status, 'success');
    assert.notEqual(retry.source_file, results[0].source_file, '重新生成不得覆盖旧源码');
  }
  assert.equal(fs.readFileSync(path.join(workspaceDir, results[0].source_file), 'utf8'), html);
  aiService.chat = async request => { assert.equal(request.messages[1].content, jobs[2].prompt); return 'mindmap\n  root((实施管理))'; };
  assert.equal((await tool.execute('retry', { images: [jobs[2]] })).details.results[0].status, 'success');
  for (const invalid of ['', '```html\n<div>围栏</div>\n```']) {
    aiService.chat = async () => invalid;
    assert.equal((await tool.execute('invalid-source', { images: [jobs[0]] })).details.results[0].status, 'error');
  }
  aiService.chat = async () => assert.fail('缺少画布比例不得请求模型');
  assert.match((await tool.execute('missing-size', { images: [{ ...jobs[0], frame_size: undefined }] })).details.results[0].error, /frame_size/);
  await assert.rejects(tool.execute('duplicate-source', { images: [jobs[0], jobs[0]] }), /不能重复/);
  for (const cancelTask of [false, true]) {
    const taskCancel = new AbortController(), toolCancel = new AbortController();
    let cancelled = 0;
    aiService.chat = request => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => { cancelled++; reject(request.signal.reason); }, { once: true }));
    const cancellable = createContentGenerationImageTools({ aiService, signal: taskCancel.signal }, { Type, workspaceDir }).find(item => item.name === tool.name);
    const before = fs.readdirSync(path.join(workspaceDir, '图片'));
    const running = cancellable.execute('cancel-sources', { images: jobs }, toolCancel.signal);
    const reason = new Error('取消源码生成');
    (cancelTask ? taskCancel : toolCancel).abort(reason);
    await assert.rejects(running, error => error === reason);
    assert.equal(cancelled, 3);
    assert.deepEqual(fs.readdirSync(path.join(workspaceDir, '图片')), before);
  }
  console.log('配图源码：真实文本队列并发、规范传递、混合类型、独立落盘、渲染交接、部分失败及取消检查通过。');
}

// 经实际输入构建检查布局名额、确定性取整和本轮目标范围，不调用模型。
function checkImageLayoutQuota(fileOptions) {
  const items = Array.from({ length: 12 }, (_, index) => ({ id: `layout-${index}`, number: String(index + 1), title: '配图小节', content_mode: 'ai-generate' }));
  const plans = Object.fromEntries(items.map(item => [item.id, { plan: { image_needed: true } }]));
  const quota = overrides => JSON.parse(buildContentGenerationFiles({ ...fileOptions, outline: items, plans,
    targets: items.map(item => ({ item })), documentIds: [], ...overrides,
  }).find(file => file.path === '正文编排决策.json').content).image_layout_quota;
  for (const [count, mode, expected] of [
    [0, 'light', [0, 0, 0, 0]], [1, 'light', [1, 0, 0, 0]], [2, 'light', [1, 1, 0, 0]],
    [3, 'light', [1, 1, 1, 0]], [7, 'light', [3, 3, 1, 0]], [10, 'light', [4, 4, 2, 0]],
    [1, 'heavy', [0, 0, 1, 0]], [2, 'heavy', [0, 0, 1, 1]], [5, 'heavy', [1, 1, 2, 1]],
    [7, 'heavy', [2, 1, 2, 2]], [10, 'heavy', [2, 2, 3, 3]],
  ]) {
    const result = quota({ targets: items.slice(0, count).map(item => ({ item })),
      generationOptions: { ...fileOptions.generationOptions, imageQuantity: mode } });
    assert.deepEqual(result, { total_groups: count, single: expected[0], imageText: expected[1], threeImages: expected[2], fourImages: expected[3] });
  }
  const zero = { total_groups: 0, single: 0, imageText: 0, threeImages: 0, fourImages: 0 };
  assert.deepEqual(quota({ generationOptions: { ...fileOptions.generationOptions, imageQuantity: 'none' } }), zero);
  assert.deepEqual(quota({ generationOptions: { imageQuantity: 'heavy', useAiImages: false, useHtmlImages: false, useMermaidImages: false } }), zero);
  for (const enabledType of ['useAiImages', 'useHtmlImages', 'useMermaidImages']) {
    const result = quota({ generationOptions: { imageQuantity: 'heavy', [enabledType]: true },
      targets: items.slice(0, 3).map(item => ({ item })),
      plans: { ...plans, 'layout-1': { plan: { image_needed: false } }, 'layout-2': { plan: {} } } });
    assert.deepEqual(result, { total_groups: 1, single: 0, imageText: 0, threeImages: 1, fourImages: 0 });
  }
  console.log('布局名额：少图/多图比例、余数和同分取整、零名额、类型开关及局部目标检查通过。');
}

// 三种事实模式经真实输入构建与工具调用传给并发写作和扩缩写，不依赖主 Agent 手动转述。
async function checkFactsRequirements({ Type, workspaceDir, fileOptions, signal }) {
  for (const [mode, expected] of [['fabricate', /允许结合项目背景补充设定/], ['omit', /不依赖未知具体值的概括性表述/], ['placeholder', /以“【待填写】”标记/]]) {
    const directory = path.join(workspaceDir, `事实模式-${mode}`);
    const checkTotalWords = mode !== 'omit';
    const files = buildContentGenerationFiles({ ...fileOptions, globalFactsMode: mode, checkTotalWords,
      targets: fileOptions.targets.slice(0, 1), wordControl: { minimumWords: 20000 }, documentIds: [],
    });
    for (const file of files) {
      const target = path.join(directory, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content, 'utf8');
    }
    const decisions = JSON.parse(files.find(file => file.path === '正文编排决策.json').content);
    const imageTypes = files.find(file => file.path === '配图类型对照表.md').content;
    assert.equal(imageTypes, fs.readFileSync(path.join(__dirname, '../electron/resources/content-generation/配图类型对照表.md'), 'utf8'));
    for (const mapping of ['思维导图=mermaid', '组织架构图=html', '时序图=html', '状态图=html', '原理示意图=ai', '其他=ai']) {
      assert.ok(imageTypes.split(/\r?\n/).includes(mapping));
    }
    assert.equal(decisions.global_facts_mode, mode);
    assert.match(decisions.global_facts_requirements, expected);
    assert.match(decisions.global_facts_requirements, /不得覆盖或改变全局事实/);
    const wordScope = checkTotalWords ? /由主 Agent 统一检查总字数/ : /本次仅统计目标小节字数，不依据全文上下限扩缩写/;
    assert.match(decisions.word_requirements, wordScope);
    let generated = false;
    let edited = false;
    const tools = createContentGenerationTools({ signal,
      aiService: { async chat(request) {
        assert.ok(request.messages[0].content.includes(decisions.global_facts_requirements));
        assert.ok(request.messages[0].content.includes(imageTypes), '并发正文模型必须收到工作区对照表全文');
        assert.match(request.messages[1].content, wordScope);
        assert.match(request.messages[1].content, /没有文件检索或图片生成工具，仅核对本次请求提供的材料/);
        generated = true;
        return '<!-- yibiao:block -->\n<p id="facts">项目实施内容</p>';
      } },
      agentService: { async runTask(request) {
        assert.ok(request.prompt.includes(decisions.global_facts_requirements));
        assert.match(request.prompt, /不扩大本次编辑范围/);
        edited = true;
      } },
    }, { Type, workspaceDir: directory });
    const params = { sections: [{ section_id: decisions.targets[0].id, instructions: '补充实施措施', references: '' }] };
    const generatedResult = await tools.find(tool => tool.name === 'generate-sections').execute('generate', params);
    assert.equal(generatedResult.details.results[0].status, 'success');
    const editedResult = await tools.find(tool => tool.name === 'adjust-sections').execute('adjust', params);
    assert.equal(editedResult.details.results[0].status, 'success');
    assert.ok(generated && edited);
    const rules = files.find(file => file.path === '受限HTML生成规范.md').content;
    assert.match(rules, /square 为 1:1.*wide 为 3:2.*tall 为 3:4.*panorama 为 16:9/);
    assert.match(rules, /省略时 Word 转换默认按 cover/);
    assert.match(rules, /需要完整保留的原方案图片应明确使用 contain/);
    assert.match(rules, /流程图使用 flowchart，思维导图使用 mindmap，实体关系图使用 erDiagram/);
    const imageSchema = tools.find(tool => tool.name === 'generate-image').parameters.properties.images.items;
    assert.ok(imageSchema.required.includes('size'));
    assert.match(imageSchema.properties.size.description, /逐图依据.*data-yb-size.*768x1024/);
    assert.match(imageSchema.properties.prompt.description, /保留.*比例.*构图/);
    assert.match(rules, /size 必填.*768x1024/);
    assert.match(rules, /通过 images 列表批量提交/);
  }
  console.log('事实模式：三种中文要求、并发正文与扩缩写传递，以及图片比例、裁剪和尺寸说明检查通过。');
}

// 执行预览模块，确认与 Agent 共用样张，且只有预览版本带示例图片引用。
function checkSharedTemplate(files) {
  const ts = require('typescript');
  const { load } = require('cheerio');
  const sourceFile = path.join(__dirname, '../src/shared/bodyHtml/documentTemplate.ts');
  const code = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function('require', 'exports', code)(specifier => {
    const file = path.resolve(path.dirname(sourceFile), specifier.replace(/\?raw$/, ''));
    assert.ok(fs.existsSync(file), `样张资源不存在：${file}`);
    return { default: specifier.endsWith('?raw') ? fs.readFileSync(file, 'utf8') : `/preview/${path.basename(file)}` };
  }, exports);
  const preview = load(exports.DOCUMENT_DISPLAY_TEMPLATE_HTML, {}, false);
  const agent = load(files.find(file => file.path === '正文模板.html').content, {}, false);
  assert.equal(preview('img').length, 5);
  preview('img').each((_, img) => {
    const image = preview(img);
    assert.equal(image.attr('src'), `/preview/${path.posix.basename(image.attr('data-yb-asset-ref'))}`);
  });
  assert.equal(agent('img[src], img[data-yb-asset-ref]').length, 0);
  assert.equal(agent('figure > template[data-yb-role="prompt"]').length, 5);
  agent('figure[data-yb-generation="htmlImage"] > template, figure[data-yb-generation="mermaid"] > template').each((_, element) => {
    assert.match(agent(element).text(), /中文标签/);
    assert.doesNotMatch(agent(element).text(), /不使用文字/);
  });
  assert.match(agent('figure[data-yb-generation="aiImage"] > template').text(), /无文字、标志和水印/);
  agent('figure > template').each((_, element) => assert.ok(agent(element).text().trim()));
  assert.equal(agent('figcaption').length, 5);
  for (let level = 1; level <= 6; level++) assert.ok(agent(`h${level}`).length);
  for (const preset of ['imageText', 'threeImages']) assert.equal(agent(`table[data-yb-preset="${preset}"]`).length, 1);
  preview('img').removeAttr('src').removeAttr('data-yb-asset-ref');
  assert.equal(agent.html(), preview.html(), '移除示例图片引用后，两端样张结构和内容必须完全一致');
  assert.deepEqual(JSON.parse(files.find(file => file.path === '所选模板配置.json').content), { template_id: 'chosen', config: { paper_size: 'A3' } });
  console.log('共用样张：预览图片、Agent 图片引用移除、标题和图组结构及所选模板配置检查通过。');
}

// 主 Agent 的决策使用模拟，子任务实际执行 Pi edit，检查并发、原表格转换和图片保护。
async function checkTableCleanup({ Type, workspaceDir, fileOptions, signal }) {
  const { createPiSession } = require('../electron/services/pi/piSessionFactory.cjs');
  const { hasDataTables } = require('../electron/services/contentGenerationTableTools.cjs');
  const files = buildContentGenerationFiles({ ...fileOptions, wordControl: {}, generationOptions: { tableRequirement: 'none', imageQuantity: 'none' }, documentIds: [] });
  for (const file of files) {
    const target = path.join(workspaceDir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf8');
  }
  const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
  assert.equal(decisions.table_requirement, 'none');
  const targets = decisions.targets;
  const table = '<table id="data" data-yb-preset="headerRow"><caption>设备配置</caption><thead><tr><th>设备</th><th>数量</th></tr></thead><tbody><tr><td>服务器</td><td>2台（备用）</td></tr></tbody></table>';
  const text = '<p id="data">设备配置：服务器数量为2台，用途为备用。</p>';
  const figure = '<figure id="photo" data-yb-generation="aiImage" data-yb-size="wide"><template data-yb-role="prompt">复用原图</template><img alt="原图" data-yb-asset-ref="原图.png"><figcaption>原图说明</figcaption></figure>';
  const layouts = ['imageText', 'threeImages', 'fourImages'].map((preset, index) => `<table id="image${index}" data-yb-preset="${preset}"><caption>图片</caption><tbody>${Array.from({ length: preset === 'fourImages' ? 2 : 1 }, (_, row) => `<tr>${Array.from({ length: preset === 'threeImages' ? 3 : 2 }, (_, col) => `<td>${preset === 'imageText' && col === 1 ? '<p>原图说明文字</p>' : figure.replace('id="photo"', `id="photo${index}_${row}_${col}"`)}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('\n<!-- yibiao:block -->\n');
  fs.writeFileSync(path.join(workspaceDir, '原图.png'), Buffer.from([1]));
  fs.mkdirSync(path.join(workspaceDir, '正文'), { recursive: true });
  for (const target of targets) fs.writeFileSync(path.join(workspaceDir, target.file), `<!-- yibiao:block -->\n${table}\n<!-- yibiao:block -->\n${layouts}`, 'utf8');
  fs.writeFileSync(path.join(workspaceDir, '正文/孤儿.html'), table, 'utf8');
  fs.writeFileSync(path.join(workspaceDir, '正文生成结果.json'), JSON.stringify({ sections: targets.map(section => ({ section_id: section.id, file: section.file, words: 1 })) }), 'utf8');
  assert.equal(hasDataTables(layouts), false);
  assert.equal(hasDataTables(table), true);
  let savedState = {};
  let mainAction;
  let activeTools;
  let childrenStarted = 0;
  let release;
  let bothStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const startedGate = new Promise(resolve => { bothStarted = resolve; });
  let failFirst = true;
  const service = {
    hasPersistentTaskSession: () => true,
    loadPersistentTask: () => ({ state: savedState }),
    updatePersistentTask(_key, patch) { savedState = { ...savedState, ...structuredClone(patch) }; },
    async runTask(payload) {
      if (payload.primary_session) {
        const tools = payload.create_tools({ Type, workspaceDir, setActiveTools: names => { activeTools = names; } });
        await mainAction(payload, tools, () => payload.continueTask({}, { workspace_dir: workspaceDir }));
        return { workspace_dir: workspaceDir };
      }
      assert.equal(payload.failure_handled_by_parent, true);
      assert.match(payload.prompt, /包括原方案表格/);
      assert.ok(payload.prompt.includes(JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8')).global_facts_requirements));
      assert.match(payload.prompt, /不扩大本次编辑范围/);
      assert.match(payload.prompt, /仅改变表达形式，不删减信息、不作无关改写/);
      assert.doesNotMatch(payload.prompt, /引用、原表格、/);
      childrenStarted++;
      if (childrenStarted === 2) bothStarted();
      await gate;
      if (failFirst && payload.output_file === targets[0].file) throw new Error('模拟子任务失败');
      const created = await createPiSession({ workspaceDir, environment: { shellPath: process.env.ComSpec, layout: { agentDir: path.join(workspaceDir, 'agent') }, instructions: '测试去表格', env: {} },
        config: {}, timeoutMs: 60000, summaryEnabled: false, proxyInfo: { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        activeTools: payload.active_tools, beforeFileWrite: payload.before_file_write, beforeToolCall: payload.before_tool_call,
      });
      try {
        const edit = created.session.agent.state.tools.find(tool => tool.name === 'edit');
        const file = path.join(workspaceDir, payload.output_file);
        const before = fs.readFileSync(file, 'utf8');
        await assert.rejects(edit.execute('image', { path: payload.output_file, edits: [{ oldText: layouts, newText: '<p>图片已删除</p>' }] }), /受保护图片/);
        assert.equal(fs.readFileSync(file, 'utf8'), before);
        await edit.execute('table', { path: payload.output_file, edits: [{ oldText: table, newText: text }] });
        const html = fs.readFileSync(file, 'utf8');
        assert.equal(html, before.replace(table, text));
        payload.validateOutput({ output_content: html });
      } finally { created.session.dispose(); }
      return {};
    },
  };
  const run = resume => runContentGenerationAgent({ agentService: service, aiService: {}, resume, signal, buildFiles: () => files });
  const interrupted = new Error('模拟暂停主会话');
  mainAction = async (payload, tools, next) => {
    const remove = tools.find(tool => tool.name === 'remove-section-tables');
    const finish = tools.find(tool => tool.name === 'complete-table-cleanup');
    await assert.rejects(remove.execute('early', { sections: [] }), /不在去表格/);
    assert.equal(next().stage, 'auditing');
    await tools.find(tool => tool.name === 'complete-consistency-round').execute('audit', { summary: '无冲突', remaining_issues: [] });
    assert.equal(next().stage, 'table-cleaning');
    assert.ok(activeTools.includes('remove-section-tables'));
    assert.ok(!activeTools.includes('check-word-count'));
    payload.before_tool_call({ toolCall: { name: 'edit' }, args: { path: targets[0].file } });
    await assert.rejects(finish.execute(), /仍有数据表格/);
    const batch = remove.execute('batch', { sections: targets.map(section => ({ section_id: section.id, instructions: '转成普通文字' })) });
    await startedGate;
    await assert.rejects(finish.execute(), /等待全部/);
    release();
    assert.deepEqual((await batch).details.results.map(item => item.status), ['error', 'success']);
    assert.deepEqual(savedState.table_cleanup.completed_section_ids, [targets[1].id]);
    await assert.rejects(finish.execute(), /尚未成功/);
    throw interrupted;
  };
  await assert.rejects(run(false), error => error === interrupted);
  failFirst = false;
  mainAction = async (payload, tools, next) => {
    assert.equal(payload.initial_stage, 'table-cleaning');
    assert.deepEqual(payload.files, []);
    assert.equal(next().stage, 'table-cleaning');
    const result = await tools.find(tool => tool.name === 'remove-section-tables').execute('retry', { sections: [{ section_id: targets[0].id, instructions: '重试未完成小节' }] });
    assert.equal(result.details.results[0].status, 'success');
    // 去表格完成后不因字数不满足而返回扩缩写。
    decisions.word_control = { minimumWords: 999999, checkTotalWords: true };
    fs.writeFileSync(path.join(workspaceDir, '正文编排决策.json'), JSON.stringify(decisions), 'utf8');
    await tools.find(tool => tool.name === 'complete-table-cleanup').execute();
    assert.equal(next().complete, true);
    assert.throws(() => payload.before_tool_call({ toolCall: { name: 'edit' }, args: { path: targets[0].file } }), /已经完成/);
  };
  const result = await run(true);
  assert.equal(childrenStarted, 3, '只重试失败小节');
  assert.ok(result.sections.every(section => section.words > 1));
  assert.equal(fs.readFileSync(path.join(workspaceDir, '正文/孤儿.html'), 'utf8'), table);
  // 已完成阶段恢复不再次清理；无表格时无需启动子任务。
  mainAction = async (payload, _tools, next) => { assert.match(payload.prompt, /已经完成/); assert.equal(next().complete, true); };
  await run(true);
  savedState.table_cleanup = null;
  mainAction = async (_payload, tools, next) => {
    assert.equal(next().stage, 'table-cleaning');
    await tools.find(tool => tool.name === 'complete-table-cleanup').execute();
    assert.equal(next().complete, true);
  };
  await run(true);
  assert.equal(childrenStarted, 3);
  console.log('去表格：真实并发 Pi edit、原表格数据保留、三类图片表格保护、失败续接、无表格跳过、无二次字数调整通过。');
}

// 在中文临时目录验证输入、真实并发、失败隔离、取消和原会话恢复，不调用外部模型。
async function main() {
  const { Type } = await import('typebox');
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), '正文生成检查-'));
  const controller = new AbortController();
  const signal = controller.signal;
  try {
    // 执行页面实际的档位切换处理，验证三类开关在同一次保存中联动。
    const ts = require('typescript');
    const page = ts.createSourceFile('settings.tsx', fs.readFileSync(path.join(__dirname, '../src/features/technical-plan/pages/GenerationSettingsPage.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let changeHandler;
    function findImageQuantitySelect(node) {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(page) === 'select'
        && node.attributes.properties.some(prop => prop.name?.getText(page) === 'value' && prop.initializer?.expression?.getText(page) === 'draftIllustrationOptions.imageQuantity')) {
        changeHandler = node.attributes.properties.find(prop => prop.name?.getText(page) === 'onChange').initializer.expression.getText(page);
      }
      ts.forEachChild(node, findImageQuantitySelect);
    }
    findImageQuantitySelect(page);
    assert.ok(changeHandler);
    const handlerCode = ts.transpileModule(`const handler = ${changeHandler};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    for (const available of [false, true]) {
      for (const imageQuantity of ['none', 'light', 'heavy']) {
        let saved;
        const handler = new Function('draftIllustrationOptions', 'draftTableRequirement', 'imageModelAvailable', 'saveContentOptions', `${handlerCode}\nreturn handler;`)({ htmlImageTypes: '甘特图', useAiImages: false, useHtmlImages: false, useMermaidImages: false }, 'heavy', available, value => { saved = value; });
        handler({ target: { value: imageQuantity } });
        assert.deepEqual(saved, { imageQuantity, htmlImageTypes: '甘特图', tableRequirement: 'heavy', useAiImages: imageQuantity !== 'none' && available, useHtmlImages: imageQuantity !== 'none', useMermaidImages: imageQuantity !== 'none' });
      }
    }
    const outline = [
      { id: '10000000-0000-4000-8000-000000000001', number: '1', title: '实施', content_mode: 'ai-generate', children: [
        { id: 'e0000000-0000-4000-8000-000000000011', number: '1.1', title: '准备', content_mode: 'ai-generate' },
        { id: 'f0000000-0000-4000-8000-000000000012', number: '1.2', title: '交付', content_mode: 'ai-generate' },
      ] },
      { id: '20000000-0000-4000-8000-000000000002', number: '2', title: '报价', content_mode: 'manual-fill' },
    ];
    const targets = outline[0].children.map(item => ({ item }));
    const fileOptions = {
      outline, targets, plans: Object.fromEntries(targets.map(({ item }) => [item.id, { plan: { writing_focus: '落实责任', knowledge: { item_ids: ['doc::k1'] }, table: { needed: false, purpose: '' }, image_needed: true, image_suitability_score: 8 } }])),
      generationOptions: { imageQuantity: 'light', useAiImages: true, useHtmlImages: true, useMermaidImages: false, htmlImageTypes: '甘特图、风险矩阵' },
      projectOverview: '某地建设项目', globalFacts: [{ title: '工期', content: '六十天' }], globalFactsMode: 'placeholder',
      wordControl: { minimumWords: 1000, maximumWords: 2000, sectionWords: 800 },
      requirement: '突出交付', template: { template_id: 'chosen', config: { paper_size: 'A3' } }, documentIds: ['doc'],
      knowledgeBaseService: { readReferences(ids, options) {
        assert.deepEqual(ids, ['doc']);
        assert.deepEqual(options, { includeMarkdown: true, includeItems: true });
        return [{ document: { id: 'doc', file_name: '完整知识库' }, markdown: '选中条目和未选中条目全文', items: [{ id: 'k1', title: '准备工作', resume: '准备摘要' }] }];
      } },
    };
    checkImageLayoutQuota(fileOptions);
    await checkRestoredContent({ Type, workspaceDir, fileOptions, signal });
    await checkFactsRequirements({ Type, workspaceDir, fileOptions, signal });
    await checkImageSourceGeneration({ Type, workspaceDir, signal });
    // 未选知识库：不读取服务、不创建目录，主会话和并发正文提示只保留全局事实。
    const noKnowledgeDir = path.join(workspaceDir, '无知识库任务');
    const noKnowledgeFiles = buildContentGenerationFiles({ ...fileOptions, documentIds: [], knowledgeBaseService: {
      readReferences() { assert.fail('未选择知识库时不应读取服务'); },
    } });
    assert.equal(noKnowledgeFiles.some(file => file.path.startsWith('知识库/')), false);
    assert.equal(JSON.parse(noKnowledgeFiles.find(file => file.path === '正文编排决策.json').content).has_knowledge_base, false);
    for (const file of noKnowledgeFiles) {
      const target = path.join(noKnowledgeDir, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content, 'utf8');
    }
    for (const resume of [false, true]) {
      await runContentGenerationAgent({
        resume, hasKnowledgeBase: false, signal,
        buildFiles: () => { assert.equal(resume, false); return noKnowledgeFiles; },
        aiService: { async chat(request) {
          assert.doesNotMatch(JSON.stringify(request.messages), /知识库|索引/);
          assert.match(JSON.stringify(request.messages), /工期六十天/);
          return '<!-- yibiao:block -->\n<p id="no_knowledge">具体实施措施</p>';
        } },
        agentService: {
          hasPersistentTaskSession: () => resume,
          loadPersistentTask: () => ({ state: {} }),
          updatePersistentTask() {},
          async runTask(payload) {
            assert.doesNotMatch(payload.prompt, /知识库|索引|编排知识条目/);
            assert.match(payload.prompt, /全局事实设定.md是参考项/);
            assert.equal(payload.files.length, resume ? 0 : noKnowledgeFiles.length);
            const [tool] = payload.create_tools({ Type, workspaceDir: noKnowledgeDir });
            assert.doesNotMatch(tool.description, /知识库/);
            assert.doesNotMatch(JSON.stringify(tool.parameters), /知识库/);
            assert.match(JSON.stringify(tool.parameters), /全局事实/);
            if (!resume) {
              const result = await tool.execute('without-knowledge', { sections: targets.map(({ item }) => ({ section_id: item.id, instructions: '落实责任', references: '全局事实：工期六十天' })) });
              assert.ok(result.details.results.every(section => section.status === 'success'));
              fs.writeFileSync(path.join(noKnowledgeDir, '正文生成结果.json'), JSON.stringify({ sections: result.details.results.map(({ section_id, file, words }) => ({ section_id, file, words })) }), 'utf8');
            }
            payload.validateOutput({}, { workspace_dir: noKnowledgeDir });
            return { workspace_dir: noKnowledgeDir };
          },
        },
      });
      assert.equal(fs.existsSync(path.join(noKnowledgeDir, '知识库')), false);
    }
    const files = buildContentGenerationFiles(fileOptions);
    checkSharedTemplate(files);
    for (const file of files) {
      const target = path.join(workspaceDir, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content, 'utf8');
    }
    const input = JSON.parse(files.find(file => file.path === '正文编排决策.json').content);
    assert.equal(input.restoration_requirements, undefined);
    assert.equal(input.targets.some(section => section.restored_content), false);
    assert.equal(files.some(file => file.path.startsWith('已还原内容/')), false);
    assert.equal(input.has_knowledge_base, true);
    assert.deepEqual(input.targets.map(item => item.id), ['e0000000-0000-4000-8000-000000000011', 'f0000000-0000-4000-8000-000000000012']);
    assert.equal(input.outline[1].content_mode, 'manual-fill');
    assert.match(input.word_requirements, /1000.*2000/);
    assert.match(input.word_requirements, /建议约 800 字.*不设小节硬性上下限/);
    assert.equal(input.targets[0].content_plan.image_suitability_score, 8);
    assert.match(input.image_requirements, /少图：按本轮布局名额/);
    assert.deepEqual(input.image_layout_quota, { total_groups: 2, single: 1, imageText: 1, threeImages: 0, fourImages: 0 });
    assert.match(input.image_requirements, /Mermaid 图片（mermaid）不允许/);
    assert.match(input.image_requirements, /甘特图、风险矩阵/);
    assert.match(input.image_requirements, /各小节及全文均无须覆盖全部已开启类型/);
    assert.match(input.image_requirements, /AI 图片目标占比为 60%/);
    assert.match(input.image_requirements, /单张图片和图片表格各 1 张，三列图片 3 张，四宫格 4 张/);
    assert.match(input.image_requirements, /原方案图片不计入分子或分母，即使格式属性为 aiImage/);
    assert.match(input.image_requirements, /局部生成只统计本轮新增图片，单节修改不追补全文比例/);
    assert.match(files.find(file => file.path === '知识库/doc.md').content, /未选中条目全文/);
    assert.equal(JSON.parse(files.find(file => file.path === '知识库/索引.json').content)[0].file, '知识库/doc.md');
    assert.match(files.find(file => file.path === '全局事实设定.md').content, /六十天/);

    // 各档位和单独类型开关只改变模型需求，不裁剪工具；并发正文模型收到同一份需求。
    for (const [imageQuantity, enabled, expected, otherEnabled = enabled] of [
      ['none', true, /无图：不安排配图、不留图片占位、不调用配图工具/],
      ['light', false, /少图：按本轮布局名额/], ['light', false, /少图：按本轮布局名额/, true],
      ['light', true, /少图：按本轮布局名额/], ['heavy', true, /多图：按本轮布局名额/],
    ]) {
      const scenarioFiles = buildContentGenerationFiles({ ...fileOptions, generationOptions: { ...fileOptions.generationOptions, imageQuantity, useAiImages: enabled, useHtmlImages: otherEnabled, useMermaidImages: otherEnabled } });
      const decisionFile = scenarioFiles.find(file => file.path === '正文编排决策.json');
      const decisions = JSON.parse(decisionFile.content);
      assert.match(decisions.image_requirements, expected);
      assert.match(decisions.image_requirements, /不用于取消本轮名额/);
      assert.doesNotMatch(decisions.image_requirements, /1～3|1～6|建议张数|张数范围仅作建议/);
      assert.match(decisions.image_requirements, /查阅配图类型对照表.md.*用途、结构相近.*仍无法归类时，使用 AI 生图/);
      if (!enabled && !otherEnabled) assert.match(decisions.image_requirements, /AI 图片（aiImage）不允许；HTML 图片（htmlImage）不允许；Mermaid 图片（mermaid）不允许/);
      if (enabled && imageQuantity !== 'none') {
        assert.match(decisions.image_requirements, /AI 图片目标占比为 60%/);
        assert.match(decisions.image_requirements, /优先从正文中寻找适合实物、场景、效果、物理结构、工艺、操作/);
        assert.match(decisions.image_requirements, /并发写作模型只执行本节分配，不独立承担占比目标/);
      } else {
        assert.doesNotMatch(decisions.image_requirements, /60%/);
        assert.match(decisions.image_requirements, /本轮不应用 AI 图片占比目标/);
      }
      assert.doesNotMatch(decisions.image_requirements, /不规定必须使用的类型或比例/);
      fs.writeFileSync(path.join(workspaceDir, decisionFile.path), decisionFile.content, 'utf8');
      let received = false;
      const allocation = !decisions.image_layout_quota.total_groups ? '本节不新增配图'
        : imageQuantity === 'heavy' ? '本节布局：四宫格1组，四张均为操作示意图，表达四个施工阶段，生成方式 aiImage'
        : enabled ? '本节布局：单张图片1组，场景示意图，表达实施现场，生成方式 aiImage'
        : '本节布局：单张图片1组，甘特图，表达施工进度，生成方式 htmlImage';
      const scenarioTools = createContentGenerationTools({ signal, aiService: { async chat(request) {
        received = true;
        assert.ok(request.messages[0].content.includes(decisions.image_requirements));
        assert.ok(request.messages[1].content.includes(allocation));
        assert.match(request.messages[1].content, /不自行分配全局名额/);
        assert.match(request.messages[1].content, /不自行改变生成方式/);
        assert.match(request.messages[1].content, /不自行分配全局名额或独立承担 AI 图片占比目标/);
        assert.ok(!JSON.stringify(request.messages).includes('"total_groups"'), '并发小节不接收整轮名额数值');
        return '<!-- yibiao:block -->\n<p id="scenario">项目实施内容</p>';
      } } }, { Type, workspaceDir });
      assert.deepEqual(scenarioTools.map(tool => tool.name), ['generate-sections', 'repair-sections', 'complete-consistency-round', 'remove-section-tables', 'complete-table-cleanup', 'check-word-count', 'adjust-sections', 'generate-image', 'generate-image-sources', 'render-html-image', 'render-mermaid-image']);
      const result = await scenarioTools[0].execute('settings', { sections: [{ section_id: 'e0000000-0000-4000-8000-000000000011', instructions: allocation, references: '' }] });
      assert.ok(received);
      assert.equal(result.details.results[0].status, 'success');
      fs.unlinkSync(path.join(workspaceDir, input.targets[0].file));
    }
    fs.writeFileSync(path.join(workspaceDir, '正文编排决策.json'), files.find(file => file.path === '正文编排决策.json').content, 'utf8');

    // 使用已安装的真实 Pi SDK 建立 Session，检查业务工具可被模型调用。
    const { createPiSession } = require('../electron/services/pi/piSessionFactory.cjs');
    const created = await createPiSession({
      workspaceDir, config: {}, timeoutMs: 60000,
      environment: { shellPath: process.env.ComSpec, layout: { agentDir: path.join(workspaceDir, 'agent') }, instructions: '正文检查', env: {} },
      proxyInfo: { baseUrl: 'http://127.0.0.1:1', token: 'local-test' },
      summaryEnabled: false,
      createTools: context => createContentGenerationTools({ aiService: {}, signal }, context),
    });
    assert.ok(created.snapshot.active_tools.includes('generate-sections'));
    assert.ok(created.snapshot.active_tools.includes('generate-image'));
    assert.ok(created.snapshot.active_tools.includes('generate-image-sources'));
    assert.ok(created.snapshot.active_tools.includes('render-html-image'));
    assert.ok(created.snapshot.active_tools.includes('render-mermaid-image'));
    created.session.dispose();

    // AI 图沿用原服务并保存工作区副本，任务与工具取消信号均须传递。
    const imageParams = { prompt: '设备维护现场', title: '维护现场', style: 'realistic_photo', size: '1024x1024' };
    const imageResult = { success: true, file_path: path.join(workspaceDir, '现场.png'), asset_url: 'yibiao-asset://generated-images/test.png', mime_type: 'image/png' };
    fs.writeFileSync(imageResult.file_path, Buffer.from('模拟图片内容'));
    const imageService = { async generateImage({ signal: requestSignal, ...params }) {
      assert.deepEqual(params, imageParams);
      assert.equal(requestSignal.aborted, false);
      return imageResult;
    } };
    const imageTool = createContentGenerationTools({ aiService: imageService, signal }, { Type, workspaceDir }).find(tool => tool.name === 'generate-image');
    const imageBatch = { images: [{ image_id: '现场图', ...imageParams }] };
    const imageOutput = await imageTool.execute('image', imageBatch);
    const savedImage = imageOutput.details.results[0];
    assert.deepEqual(savedImage, { ...imageResult, image_id: '现场图', status: 'success', asset_ref: savedImage.asset_ref });
    assert.deepEqual(JSON.parse(imageOutput.content[0].text), imageOutput.details);
    assert.deepEqual(fs.readFileSync(path.join(workspaceDir, savedImage.asset_ref)), fs.readFileSync(imageResult.file_path));
    imageService.generateImage = async () => assert.fail('缺少尺寸时不得请求生图或使用默认方图');
    for (const size of [undefined, '', '   ']) {
      const missing = await imageTool.execute('image-missing-size', { images: [{ ...imageBatch.images[0], size }] });
      assert.equal(missing.details.results[0].status, 'error');
      assert.match(missing.details.results[0].error, /补充.*size/);
    }
    const imageError = new Error('生图模型不可用');
    imageService.generateImage = async () => { throw imageError; };
    assert.deepEqual((await imageTool.execute('image-error', imageBatch)).details.results,
      [{ image_id: '现场图', status: 'error', error: imageError.message }]);

    // 真实请求队列限制为 2：三张一起提交，乱序完成且一张失败，结果仍按标识对应。
    const { createAiRequestQueue } = require('../electron/utils/aiRequestQueue.cjs');
    const imageQueue = createAiRequestQueue({ getLimit: () => 2 });
    const imagePending = new Map();
    const imageRequests = [];
    imageService.generateImage = ({ signal: requestSignal, prompt, size }) => {
      imageRequests.push({ prompt, size });
      return imageQueue.enqueue(() => new Promise((resolve, reject) => imagePending.set(prompt, { resolve, reject })), { signal: requestSignal, maxAttempts: 1 });
    };
    const concurrentImages = { images: ['甲', '乙', '丙'].map((id, index) => ({ image_id: id, prompt: id, size: ['768x1024', '1024x1024', '1536x1024'][index] })) };
    const batchPromise = imageTool.execute('image-batch', concurrentImages);
    assert.deepEqual(imageRequests, concurrentImages.images.map(({ prompt, size }) => ({ prompt, size })), '整批提交且逐张透传独立尺寸');
    assert.deepEqual([...imagePending.keys()], ['甲', '乙'], '实际并发由现有队列限制');
    imagePending.get('乙').reject(imageError);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(imagePending.has('丙'), '一个请求结束后应启动排队图片');
    const thirdFile = path.join(workspaceDir, '图片丙.png');
    fs.writeFileSync(thirdFile, '图片丙', 'utf8');
    imagePending.get('丙').resolve({ ...imageResult, file_path: thirdFile });
    imagePending.get('甲').resolve(imageResult);
    const batchResults = (await batchPromise).details.results;
    assert.deepEqual(batchResults.map(result => [result.image_id, result.status]), [['甲', 'success'], ['乙', 'error'], ['丙', 'success']]);
    assert.equal(batchResults[1].error, imageError.message);
    assert.deepEqual(fs.readFileSync(path.join(workspaceDir, batchResults[0].asset_ref)), fs.readFileSync(imageResult.file_path));
    assert.equal(fs.readFileSync(path.join(workspaceDir, batchResults[2].asset_ref), 'utf8'), '图片丙');
    const successfulRefs = [batchResults[0].asset_ref, batchResults[2].asset_ref];
    imageService.generateImage = async ({ prompt }) => { assert.equal(prompt, '乙'); return imageResult; };
    assert.equal((await imageTool.execute('image-retry', { images: [concurrentImages.images[1]] })).details.results[0].status, 'success');
    assert.ok(successfulRefs.every(ref => fs.existsSync(path.join(workspaceDir, ref))));
    await assert.rejects(imageTool.execute('image-duplicate', { images: [concurrentImages.images[0], concurrentImages.images[0]] }), /不能重复/);
    for (const cancelTask of [false, true]) {
      const taskCancel = new AbortController();
      const toolCancel = new AbortController();
      let cancelled = 0;
      imageService.generateImage = ({ signal: requestSignal }) => new Promise((resolve, reject) => {
        requestSignal.addEventListener('abort', () => { cancelled++; reject(requestSignal.reason); }, { once: true });
      });
      const cancellableTool = createContentGenerationTools({ aiService: imageService, signal: taskCancel.signal }, { Type, workspaceDir }).find(tool => tool.name === 'generate-image');
      const savedFiles = fs.readdirSync(path.join(workspaceDir, '图片'));
      const request = cancellableTool.execute('image-cancel', concurrentImages, toolCancel.signal);
      const reason = new Error('取消生图');
      (cancelTask ? taskCancel : toolCancel).abort(reason);
      await assert.rejects(request, error => error === reason);
      assert.equal(cancelled, 3, '任务或工具取消须传递到整批图片');
      assert.deepEqual(fs.readdirSync(path.join(workspaceDir, '图片')), savedFiles, '取消后不得保存新图片或删除已有图片');
    }
    console.log('批量 AI 生图：真实队列并发上限、乱序结果、部分失败、单项重试及整批取消检查通过。');

    // 两种转图读取已有 UTF-8 源码，保留错误与取消行为，不调用文本模型。
    for (const kind of ['html', 'mermaid']) {
      const sourceFile = `图片/实施流程.${kind === 'html' ? 'html' : 'mmd'}`;
      const source = kind === 'html' ? '<div>实施流程</div>' : 'flowchart LR\nA["准备"] --> B["实施"]';
      fs.writeFileSync(path.join(workspaceDir, sourceFile), source, 'utf8');
      const renderer = {};
      const method = kind === 'html' ? 'renderHtmlToPng' : 'renderMermaidToPng';
      const pause = new AbortController();
      const renderTool = createContentGenerationImageTools({ aiService: {}, signal, localImageRenderService: renderer }, { Type, workspaceDir }).find(tool => tool.name === `render-${kind}-image`);
      const renderParams = { source_file: sourceFile, ...(kind === 'html' ? { frame_size: 'wide' } : {}) };
      assert.equal(renderTool.parameters.required.includes('frame_size'), kind === 'html');
      renderer[method] = async (text, options) => {
        assert.equal(text, source);
        assert.equal(options.isPauseRequested(), false);
        assert.equal(options.frameSize, kind === 'html' ? 'wide' : undefined);
        return { buffer: Buffer.from('PNG'), width: 100, height: 80, layout_issues: [] };
      };
      const rendered = (await renderTool.execute('render', renderParams)).details;
      assert.equal(rendered.width, 100);
      assert.equal(rendered.height, 80);
      assert.equal(rendered.source_file, sourceFile);
      assert.equal(fs.readFileSync(path.join(workspaceDir, rendered.asset_ref), 'utf8'), 'PNG');
      const renderError = new Error('模拟渲染错误');
      renderer[method] = async () => { throw renderError; };
      await assert.rejects(renderTool.execute('error', renderParams), error => error === renderError);
      assert.equal(fs.readFileSync(path.join(workspaceDir, sourceFile), 'utf8'), source);
      const savedFiles = fs.readdirSync(path.join(workspaceDir, '图片'));
      renderer[method] = async (_text, options) => {
        pause.abort(new Error('停止转图'));
        assert.equal(options.isPauseRequested(), true);
        assert.equal(options.createPauseError(), pause.signal.reason);
        return { buffer: Buffer.from('未完成图片') };
      };
      await assert.rejects(renderTool.execute('cancel', renderParams, pause.signal), /停止转图/);
      assert.deepEqual(fs.readdirSync(path.join(workspaceDir, '图片')), savedFiles, '取消后不得保存新图片');
    }

    const jobs = input.targets.map(item => ({ section_id: item.id, instructions: '落实责任', references: '全局事实：工期六十天' }));
    const html = '<!-- yibiao:block -->\n<p id="s_1_p001">具体实施措施</p>';
    const pending = [];
    const progress = [];
    const aiService = { chat(request) {
      assert.equal(request.signal.aborted, false);
      assert.match(request.messages[0].content, /【待填写】/);
      assert.match(request.messages[0].content, /不在正文中提及知识库/);
      assert.ok(request.messages[0].content.includes(input.image_requirements));
      assert.match(request.messages[1].content, /六十天/);
      assert.match(request.messages[1].content, /A3/);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    } };
    const [tool] = createContentGenerationTools({ aiService, signal, onProgress: event => progress.push(event) }, { Type, workspaceDir });
    assert.match(tool.description, /知识库和全局事实/);
    assert.match(JSON.stringify(tool.parameters), /知识库、全局事实/);
    const batch = tool.execute('batch', { sections: jobs }, signal);
    assert.equal(pending.length, 2, '两个请求必须同时启动，不能等第一节完成才开始第二节');
    pending[0].resolve(html);
    pending[1].reject(new Error('模拟模型失败'));
    const first = (await batch).details.results;
    assert.deepEqual(first.map(item => item.status), ['success', 'error']);
    const firstFile = path.join(workspaceDir, first[0].file);
    assert.equal(fs.readFileSync(firstFile, 'utf8'), html);
    assert.equal(progress[0].completed, 1);
    await assert.rejects(tool.execute('invalid', { sections: [{ ...jobs[0], section_id: '20000000-0000-4000-8000-000000000002' }] }), /只能提交/);

    // 暂停时未完成的请求不得落盘；上一批成功文件继续保留。
    const cancel = new AbortController();
    const interrupted = tool.execute('cancel', { sections: [jobs[1]] }, cancel.signal);
    cancel.abort(new Error('暂停生成'));
    pending[2].resolve(html);
    await assert.rejects(interrupted, /暂停生成/);
    assert.equal(fs.existsSync(path.join(workspaceDir, input.targets[1].file)), false);
    assert.equal(fs.readFileSync(firstFile, 'utf8'), html);
    const [resumedTool] = createContentGenerationTools({ aiService, signal, onProgress: event => progress.push(event) }, { Type, workspaceDir });
    const retried = resumedTool.execute('retry', { sections: [jobs[1]] }, signal);
    pending[3].resolve(html.replace('s_1_', 's_2_'));
    await retried;
    assert.equal(progress.at(-1).completed, 2);
    const manifest = { sections: input.targets.map(item => ({ section_id: item.id, file: item.file, words: 6 })) };
    fs.writeFileSync(path.join(workspaceDir, '正文生成结果.json'), JSON.stringify(manifest), 'utf8');
    assert.equal(readContentGenerationResult(workspaceDir).sections.length, 2);
    fs.writeFileSync(firstFile, `${html}<img alt="实施图">`, 'utf8');
    assert.throws(() => readContentGenerationResult(workspaceDir), /尚未生成/);
    fs.writeFileSync(firstFile, `${html}<img alt="实施图" data-yb-asset-ref="图片/缺失.png">`, 'utf8');
    assert.throws(() => readContentGenerationResult(workspaceDir), /图片文件不存在/);
    fs.writeFileSync(firstFile, `${html}<img alt="实施图" data-yb-asset-ref="../越界.png">`, 'utf8');
    assert.throws(() => readContentGenerationResult(workspaceDir), /相对路径/);
    fs.writeFileSync(firstFile, `${html}<img alt="实施图" data-yb-asset-ref="${savedImage.asset_ref}">`, 'utf8');
    assert.equal(readContentGenerationResult(workspaceDir).sections.length, 2);

    // 真实业务适配器的新建/恢复协议：恢复不重建输入快照，也不删除已有产物。
    for (const resume of [false, true]) {
      let built = 0;
      let updates = 0;
      const result = await runContentGenerationAgent({
        resume, hasKnowledgeBase: true, signal, aiService, buildFiles: () => { built++; return files; },
        agentService: {
          hasPersistentTaskSession: () => resume,
          loadPersistentTask: () => ({ state: {} }),
          updatePersistentTask() { updates++; },
          async runTask(payload) {
            assert.equal(payload.persistent_task.mode, resume ? 'resume' : 'create');
            assert.equal(payload.primary_session, true);
            assert.equal(payload.auto_validate_json, true);
            assert.equal(payload.files.length, resume ? 0 : files.length);
            assert.match(payload.prompt, /三个文件必须完整阅读/);
            assert.match(payload.prompt, /配图前完整阅读配图类型对照表.md/);
            assert.match(payload.prompt, /size 必填.*768x1024/);
            assert.match(payload.prompt, /prompt 中保留.*比例.*构图方向/);
            assert.match(payload.prompt, /HTML\/Mermaid 图使用 generate-image-sources/);
            assert.match(payload.prompt, /工具只生成并保存源码，不渲染、不回填正文/);
            assert.match(payload.prompt, /通过 images 列表一次提交已确定且相互独立的多张配图需求/);
            assert.match(payload.prompt, /按 image_id.*仅重新提交失败项/);
            assert.match(payload.prompt, /global_facts_requirements（当前事实模式的中文要求）/);
            assert.doesNotMatch(payload.prompt, /本次使用已还原底稿/);
            assert.match(payload.prompt, /知识库\/索引.json定位参考文档/);
            assert.match(payload.prompt, /image_requirements（用户配图要求）/);
            assert.match(payload.prompt, /image_layout_quota（本轮新增布局名额）/);
            assert.match(payload.prompt, /在各节 instructions 中写明布局、组数和每组表达目的/);
            assert.match(payload.prompt, /并逐图指定图片类型和生成方式/);
            assert.match(payload.prompt, /在并发写作前规划每张图的表达目的、图片类型及生成方式/);
            assert.match(payload.prompt, /核对本轮新增图片的生成方式分布/);
            assert.match(payload.prompt, /暂停、失败重试沿用本轮名额，已完成的布局计入完成数量/);
            assert.deepEqual(payload.create_tools({ Type, workspaceDir }).map(tool => tool.name), ['generate-sections', 'repair-sections', 'complete-consistency-round', 'remove-section-tables', 'complete-table-cleanup', 'check-word-count', 'adjust-sections', 'generate-image', 'generate-image-sources', 'render-html-image', 'render-mermaid-image']);
            payload.validateOutput({}, { workspace_dir: workspaceDir });
            return { workspace_dir: workspaceDir };
          },
        },
      });
      assert.equal(built, resume ? 0 : 1);
      assert.equal(updates, resume ? 2 : 1);
      assert.equal(result.sections[0].words, 6);
    }
    await checkImageProtectionLifecycle({ Type, workspaceDir, files, signal });
    await checkTableCleanup({ Type, workspaceDir: path.join(workspaceDir, '去表格'), fileOptions, signal });
    await checkLayoutSupplement({ Type, workspaceDir, signal });
    fs.unlinkSync(firstFile);
    assert.throws(() => readContentGenerationResult(workspaceDir), /ENOENT/);
    console.log('正文 Agent：还原底稿及原图、知识库有无选择、页面图片设置联动、配图需求传递、输入、并发、暂停恢复、三类图片工具及最终图片引用检查通过。');
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

// 使用真实正文适配器核对保护启用、提前提交及暂停恢复，不启动模型或改动输入快照。
async function checkImageProtectionLifecycle({ Type, workspaceDir, files, signal }) {
  const decisions = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));
  const sectionFile = path.join(workspaceDir, decisions.targets[0].file);
  const original = fs.readFileSync(sectionFile, 'utf8');
  const pauseError = new Error('模拟暂停');
  let state = {};
  let activeTools;
  let action;
  const agentService = {
    hasPersistentTaskSession: () => true,
    loadPersistentTask: () => ({ state }),
    updatePersistentTask(_key, partial) { state = { ...state, ...partial }; },
    async runTask(payload) {
      const tools = payload.create_tools({ Type, workspaceDir, setActiveTools: names => { activeTools = names; } });
      await action(payload, tools);
      return { workspace_dir: workspaceDir };
    },
  };
  const run = resume => runContentGenerationAgent({ resume, hasKnowledgeBase: true, signal, aiService: {}, agentService, buildFiles: () => files });
  const checkBlocked = payload => {
    for (const name of ['bash', 'generate-sections', 'generate-image', 'generate-image-sources', 'render-html-image', 'render-mermaid-image']) {
      assert.equal(activeTools.includes(name), false);
      assert.throws(() => payload.before_tool_call({ toolCall: { name }, args: {} }), /正文编辑期间不能/);
    }
    assert.throws(() => payload.before_file_write({ toolName: 'write', filePath: sectionFile, content: '<p>覆盖正文</p>' }), /正文编辑只能/);
  };
  action = async (payload, tools) => {
    // 生成阶段没有图片写入限制；未完成配图不能提前锁定工具。
    payload.before_tool_call({ toolCall: { name: 'generate-image' }, args: {} });
    payload.before_file_write({ toolName: 'write', filePath: sectionFile, content: '<p>仍在生成</p>' });
    const check = tools.find(tool => tool.name === 'check-word-count');
    fs.writeFileSync(sectionFile, `${original}<img alt="未完成图片">`, 'utf8');
    try {
      await assert.rejects(check.execute(), /尚未生成/);
      assert.equal(state.word_adjustment_started, false);
      assert.equal(activeTools, undefined);
    } finally { fs.writeFileSync(sectionFile, original, 'utf8'); }
    await check.execute();
    assert.equal(state.word_adjustment_started, true);
    checkBlocked(payload);
    throw pauseError;
  };
  await assert.rejects(run(false), error => error === pauseError);
  action = async payload => {
    assert.equal(payload.files.length, 0);
    assert.match(payload.prompt, /本次恢复时已处于图片保护阶段/);
    checkBlocked(payload);
    payload.validateOutput({}, { workspace_dir: workspaceDir });
  };
  await run(true);
  assert.equal(state.word_adjustment_started, true);
  assert.equal(fs.readFileSync(sectionFile, 'utf8'), original);

  // 未调用字数工具便提前提交，程序要求继续调整时也必须先启用保护。
  state = {};
  activeTools = undefined;
  action = async payload => {
    payload.validateOutput({}, { workspace_dir: workspaceDir });
    assert.equal(state.word_adjustment_started, false);
    const continuation = payload.continueTask({}, { workspace_dir: workspaceDir });
    assert.ok(continuation.prompt);
    assert.equal(state.word_adjustment_started, true);
    checkBlocked(payload);
    throw pauseError;
  };
  await assert.rejects(run(false), error => error === pauseError);
  // 上一轮已完成：相同 Session 的新目标必须从生成开始，不能继承审计完成或编辑保护。
  state = { word_adjustment_started: true, consistency: { round: 3, status: 'completed', remaining_issues: [] } };
  activeTools = undefined;
  action = async (payload, tools) => {
    assert.equal(payload.persistent_task.mode, 'resume');
    assert.equal(payload.initial_stage, 'generating');
    assert.equal(payload.files.length, files.length);
    assert.match(payload.prompt, /重新读取已更新的输入文件/);
    assert.equal(state.word_adjustment_started, false);
    assert.equal(state.consistency, null);
    payload.before_tool_call({ toolCall: { name: 'generate-sections' }, args: {} });
    payload.before_tool_call({ toolCall: { name: 'generate-image' }, args: {} });
    assert.ok(tools.some(tool => tool.name === 'generate-sections'));
  };
  await run(false);
}

// 原图样例供正文请求模拟和真实受限 HTML 校验共同使用。
function restoredFigure(assetRef) {
  return `<!-- yibiao:block -->\n<figure id="restored_image" data-yb-generation="aiImage" data-yb-size="square"><template data-yb-role="prompt">复用原方案现场图片，不重新生成。</template><img alt="现场" data-yb-asset-ref="${assetRef}"><figcaption>现场</figcaption></figure>`;
}

// 使用混合小节检查底稿全文传递、只整理要求、原图字节及恢复时不再读取原文件。
async function checkRestoredContent({ Type, workspaceDir, fileOptions, signal }) {
  const reference = 'yibiao-asset://imported-images/原方案批次/现场.png';
  const imagePath = path.join(workspaceDir, '原方案现场.png');
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(imagePath, imageBytes);
  const source = `工期三十天。保留设备编号ABC-123。\n\n|设备|数量|\n|---|---|\n|服务器|2|\n\n![现场](${reference})\n\n末尾验收措施必须完整传递。`;
  const { countReadableWords } = require('../electron/utils/wordCount.cjs');
  const restoredDir = path.join(workspaceDir, '还原输入检查');
  const options = { ...fileOptions, hasOriginalPlan: true, restoredContents: { 'e0000000-0000-4000-8000-000000000011': source }, existingTotalWords: 2100,
    generationOptions: { ...fileOptions.generationOptions, imageQuantity: 'none', useAiImages: false, useHtmlImages: false, useMermaidImages: false },
    wordControl: { ...fileOptions.wordControl, sectionWords: 10 },
  };
  const files = buildContentGenerationFiles(options);
  const decisions = JSON.parse(files.find(file => file.path === '正文编排决策.json').content);
  const restored = decisions.targets[0].restored_content;
  assert.equal(restored.words, countReadableWords(source));
  assert.equal(restored.words > options.wordControl.sectionWords, true);
  assert.equal(decisions.targets[1].restored_content, undefined);
  assert.equal(files.filter(file => file.path.startsWith('已还原内容/')).length, 1);
  assert.equal(files.find(file => file.path === restored.file).content, source);
  assert.match(decisions.restoration_requirements, /2100 字，全文上限 2000/);
  assert.match(decisions.restoration_requirements, /只整理，不扩写/);
  assert.match(decisions.restoration_requirements, /以全局事实设定为准/);
  assert.match(decisions.restoration_requirements, /原图不受无图/);
  assert.match(decisions.restoration_requirements, /data-yb-generation="aiImage"/);
  assert.match(decisions.restoration_requirements, /唯一、非空的 template/);
  assert.match(decisions.restoration_requirements, /该标记不构成调用 AI 生图的指令/);
  const underLimit = JSON.parse(buildContentGenerationFiles({ ...options, existingTotalWords: 100, wordControl: fileOptions.wordControl }).find(file => file.path === '正文编排决策.json').content);
  assert.match(underLimit.restoration_requirements, /100 字，全文上限 2000/);
  assert.match(underLimit.restoration_requirements, /每小节目标 800/);
  assert.match(underLimit.restoration_requirements, /未超过时按现有要求适当扩写/);
  let copied = 0;
  for (const resume of [false, true]) {
    await runContentGenerationAgent({
      resume, hasOriginalPlan: true, hasKnowledgeBase: true, signal,
      buildFiles: () => { assert.equal(resume, false); return files; },
      resolveOriginalImagePath(ref) { assert.equal(resume, false); assert.equal(ref, reference); copied++; return imagePath; },
      aiService: { async chat(request) {
        const [system, user] = request.messages;
        if (request.logTitle.includes('准备')) {
          assert.ok(user.content.includes(source));
          assert.match(user.content, /六十天/);
          assert.match(user.content, /原图\//);
          assert.match(system.content, /只整理，不扩写/);
          assert.match(system.content, /以全局事实设定为准/);
          return `<!-- yibiao:block -->\n<p id="restored_p">工期六十天。设备编号ABC-123。</p>\n<!-- yibiao:block -->\n<table id="restored_table" data-yb-preset="plain"><caption>设备</caption><tbody><tr><td>服务器</td><td>2</td></tr></tbody></table>\n${restoredFigure(restored.images[0].asset_ref)}`;
        }
        assert.doesNotMatch(user.content, /本节已还原底稿|ABC-123/);
        assert.doesNotMatch(system.content, /本节还原处理要求/);
        return '<!-- yibiao:block -->\n<p id="normal_p">正常生成交付措施</p>';
      } },
      agentService: {
        hasPersistentTaskSession: () => resume,
          loadPersistentTask: () => ({ state: {} }),
        updatePersistentTask() {},
        async runTask(payload) {
          assert.match(payload.prompt, /本次使用已还原底稿/);
          assert.equal(payload.files.length, resume ? 0 : files.length);
          for (const file of payload.files) {
            const target = path.join(restoredDir, file.path);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, file.content, 'utf8');
          }
          const [tool] = payload.create_tools({ Type, workspaceDir: restoredDir });
          assert.deepEqual(fs.readFileSync(path.join(restoredDir, restored.images[0].asset_ref)), imageBytes);
          if (!resume) {
            const result = await tool.execute('restored', { sections: decisions.targets.map(section => ({ section_id: section.id, instructions: '落实责任', references: '' })) });
            assert.deepEqual(result.details.results.map(section => section.status), ['success', 'success']);
            fs.writeFileSync(path.join(restoredDir, '正文生成结果.json'), JSON.stringify({ sections: result.details.results.map(({ section_id, file, words }) => ({ section_id, file, words })) }), 'utf8');
          }
          payload.validateOutput({}, { workspace_dir: restoredDir });
          return { workspace_dir: restoredDir };
        },
      },
    });
    assert.equal(fs.readFileSync(path.join(restoredDir, restored.file), 'utf8'), source);
    if (!resume) fs.unlinkSync(imagePath);
  }
  assert.equal(copied, 1);
}

// Electron Node 模式下验证真实 Store 的原图定位，数据库与图片均放临时目录。
function checkOriginalImageStore() {
  const { EventEmitter } = require('node:events');
  const { createSqliteDatabase } = require('../electron/services/sqliteDatabase.cjs');
  const { createTechnicalPlanStore } = require('../electron/services/technicalPlanStore.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '原图定位检查-'));
  let database;
  try {
    const app = Object.assign(new EventEmitter(), { getPath: () => directory });
    database = createSqliteDatabase(app);
    const store = createTechnicalPlanStore({ app, db: database.db });
    const image = path.join(directory, 'workspace', 'imported-images', '原图批次', '现场 图片.png');
    fs.mkdirSync(path.dirname(image), { recursive: true });
    fs.writeFileSync(image, Buffer.from('原图字节'));
    const reference = 'yibiao-asset://imported-images/原图批次/现场%20图片.png';
    assert.equal(store.resolveOriginalImagePath(reference), image);
    store.assertOriginalImageFiles(`![现场](${reference})`);
    fs.unlinkSync(image);
    assert.throws(() => store.resolveOriginalImagePath(reference), /原方案图片资源缺失/);
    assert.throws(() => store.assertOriginalImageFiles(`![现场](${reference})`), /原方案图片资源缺失/);
    console.log('真实 Store：原图定位、中文路径及缺失原图检查通过。');
  } finally {
    database?.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// 在隐藏 Electron 窗口中执行现有校验器，覆盖原图结构及缺失、空白、重复模板。
async function checkRestrictedHtml() {
  const { BrowserWindow } = require('electron');
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../src/shared/bodyHtml/restrictedHtml.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const html = restoredFigure('原图/现场.png');
  const prompt = '<template data-yb-role="prompt">复用原方案现场图片，不重新生成。</template>';
  const rules = fs.readFileSync(path.join(__dirname, '../electron/resources/content-generation/受限HTML生成规范.md'), 'utf8');
  const example = [...rules.matchAll(/```html\s*([\s\S]*?)```/g)].map(match => match[1]).find(fragment => fragment.includes('original_fig_001'));
  assert.ok(example);
  const cases = [html, example, html.replace(' data-yb-generation="aiImage"', ''), html.replace(prompt, ''), html.replace(prompt, '<template data-yb-role="prompt"> </template>'), html.replace(prompt, prompt + prompt)];
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  try {
    await window.loadURL('about:blank');
    const results = await window.webContents.executeJavaScript(`(() => { const exports = {}; ${code}\n return ${JSON.stringify(cases)}.map(html => exports.parseRestrictedHtml(html)); })()`);
    for (const result of results.slice(0, 2)) {
      assert.notEqual(result.normalizedHtml, null, JSON.stringify(result.issues));
      assert.equal(result.issues.filter(issue => issue.level === 'error').length, 0);
      assert.match(result.normalizedHtml, /data-yb-asset-ref="原图\//);
    }
    for (const [index, message] of [[2, /data-yb-generation/], [3, /必须包含一个配图提示 template/], [4, /非空文字/], [5, /必须包含一个配图提示 template/]]) {
      assert.equal(results[index].normalizedHtml, null);
      assert.ok(results[index].issues.some(issue => issue.level === 'error' && message.test(issue.message)));
    }
    console.log('真实受限 HTML 校验：原图样例和规范示例通过，缺少类型或模板、空白或重复模板均正确报错。');
  } finally {
    window.destroy();
  }
}

// 真实 Electron 本地转图检查，产物及用户数据均位于独立临时目录。
async function checkLocalRendering(workspaceDir) {
  const { Type } = await import('typebox');
  const { nativeImage } = require('electron');
  const renderer = require('../electron/services/localImageRenderService.cjs').getLocalImageRenderService();
  const tools = createContentGenerationImageTools({ aiService: {}, signal: new AbortController().signal }, { Type, workspaceDir });
  const htmlTool = tools.find(tool => tool.name === 'render-html-image');
  const styles = `<style>
    *{box-sizing:border-box}body{margin:0;padding:88px;background:#f8fafc;font:28px "Microsoft YaHei",sans-serif;color:#24344b;display:flex;flex-direction:column}
    header{flex:none;border-bottom:3px solid #2563eb;padding-bottom:20px;margin-bottom:24px;font-size:38px;font-weight:bold}
    main{flex:1;min-height:0;display:flex;flex-direction:column}
    .grid{flex:1;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:24px}
    .card{background:#e8f0fe;border:2px solid #bed0ed;border-radius:12px;padding:24px;display:flex;flex-direction:column;justify-content:center}
    h2{font-size:30px;margin:0 0 18px;color:#2457a6}p{margin:0;line-height:1.5}
  </style>`;
  const content = `<header>项目实施管理体系</header><main><div class="grid">${[
    ['准备与核查','明确实施条件、责任分工和交付要求。'],['组织与实施','按计划开展工作，协调现场资源。'],
    ['质量与验收','核对成果和验收标准，记录检查结果。'],['交付与维护','完成资料归档，落实持续维护责任。'],
  ].map(([title, text]) => `<section class="card"><h2>${title}</h2><p>${text}</p></section>`).join('')}</div></main>`;
  for (const [frameSize, height] of Object.entries({ square: 1240, wide: 827, tall: 1653, panorama: 698 })) {
    // 同一Flex/Grid结构同时覆盖完整文档和HTML片段，source中的88px边距应由画布统一为40px。
    const html = frameSize === 'panorama' ? styles + content
      : `<!DOCTYPE html><html><head><meta charset="utf-8">${styles}</head><body>${content}</body></html>`;
    const sourceFile = `布局-${frameSize}.html`;
    fs.writeFileSync(path.join(workspaceDir, sourceFile), html, 'utf8');
    const result = (await htmlTool.execute(frameSize, { source_file: sourceFile, frame_size: frameSize })).details;
    const png = fs.readFileSync(path.join(workspaceDir, result.asset_ref));
    const image = nativeImage.createFromBuffer(png);
    assert.deepEqual(image.getSize(), { width: 2480, height: height * 2 });
    assert.deepEqual({ width: result.width, height: result.height }, image.getSize());
    assert.deepEqual(result.layout_issues, [], JSON.stringify(result.layout_issues));
    const bitmap = image.toBitmap();
    const pixel = (x, y) => [...bitmap.subarray(((y * 2) * 2480 + x * 2) * 4, ((y * 2) * 2480 + x * 2) * 4 + 3)];
    assert.deepEqual(pixel(20, 20), [252, 250, 248], '保留源码的背景与顶部边距');
    assert.deepEqual(pixel(20, height - 60), [252, 250, 248], '左侧40px边距');
    assert.deepEqual(pixel(1220, height - 60), [252, 250, 248], '右侧40px边距');
    assert.deepEqual(pixel(100, height - 20), [252, 250, 248], '底部40px边距');
    assert.deepEqual(pixel(100, height - 50), [254, 240, 232], '卡片延伸到主体底部，不因包装打断flex而留下空白');
    assert.deepEqual(pixel(50, height - 60), [254, 240, 232], '主体从40px边距内开始，未重复添加外层边距');
    assert.equal(fs.readFileSync(path.join(workspaceDir, sourceFile), 'utf8'), html);
    fs.writeFileSync(path.join(workspaceDir, `预览-${frameSize}.png`), png);
    const probe = await renderer.probeHtmlLayoutOnly(html, { frameSize });
    assert.deepEqual(probe, { width: 1240, height, layout_issues: [] });
    console.log(`HTML ${frameSize}：${result.width}×${result.height}，边距、背景、Flex/Grid铺满及质检通过。`);
  }
  const overflow = styles + content + '<div style="position:absolute;left:40px;top:1300px;width:100px;height:80px;background:red"></div>';
  const overflowResult = await renderer.renderHtmlToPng(overflow, { frameSize: 'square' });
  assert.deepEqual({ width: overflowResult.width, height: overflowResult.height }, { width: 2480, height: 2480 });
  assert.ok(overflowResult.layout_issues.some(issue => issue.includes('元素超出画布内容区域')), '无文字图形的纵向越界也应反馈，且不扩大截图');
  const clipped = '<div style="height:32px;overflow:hidden;font-size:32px">第一行<br>第二行</div>';
  const clippedResult = await renderer.probeHtmlLayoutOnly(clipped, { frameSize: 'wide' });
  assert.ok(clippedResult.layout_issues.some(issue => issue.includes('裁切')), '隐藏溢出的文字仍应反馈裁切');
  fs.writeFileSync(path.join(workspaceDir, '实施流程.mmd'), 'flowchart LR\nA["准备"] --> B["实施"] --> C["交付"]', 'utf8');
  const mermaid = (await tools.find(tool => tool.name === 'render-mermaid-image').execute('mermaid', { source_file: '实施流程.mmd' })).details;
  assert.ok(mermaid.width > 24 && mermaid.height > 24);
  assert.deepEqual(nativeImage.createFromPath(path.join(workspaceDir, mermaid.asset_ref)).getSize(), { width: mermaid.width, height: mermaid.height });
  console.log('固定画布越界、隐藏溢出裁切与Mermaid原有转图检查通过。');
}

// 格式自检先对齐运行编号再续接主会话；跨次失败重试保留成功项和图片保护。
async function checkLayoutSupplement({ Type, workspaceDir, signal }) {
  const targets = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8')).targets;
  let state = { status: 'supplementing', jobs: targets.map(section => ({ section_id: section.id, file: section.file, gaps: [{ figure_ids: ['图'], suggested_words: 50 }] })), completed_section_ids: [] };
  const sessionFile = '原正文会话.jsonl';
  const persistent = { run_id: '原正文轮次', session_file: sessionFile, layout_check: state };
  const layout = { get: () => state, save: next => { state = next; persistent.layout_check = next; } };
  const inputBefore = fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8');
  const interrupted = new Error('模拟格式自检主会话失败');
  const runIds = [];
  const checkpoints = [];
  let running = 0;
  let peak = 0;
  let failFirst = true;
  const calls = [];
  const agentService = { updatePersistentTask(key, patch) {
    assert.equal(key, CONTENT_GENERATION_AGENT_TASK_KEY);
    Object.assign(persistent, patch);
  }, async runTask(payload) {
    if (!payload.primary_session) {
      assert.equal(payload.failure_handled_by_parent, true);
      assert.deepEqual(payload.active_tools, ['read', 'edit', 'report-failure']);
      running++;
      peak = Math.max(peak, running);
      calls.push(payload.output_file);
      try {
        await new Promise(resolve => setTimeout(resolve, 15));
        if (payload.output_file === targets[0].file && failFirst) throw new Error('可恢复的补写失败');
        const file = path.join(workspaceDir, payload.output_file);
        const original = fs.readFileSync(file, 'utf8');
        assert.throws(() => payload.before_file_write({ filePath: file, originalContent: original, content: original + '<figure><img></figure>', toolName: 'edit' }), /受保护图片/);
        const html = original + '\n<!-- yibiao:block -->\n<p>补充现场复核工作安排。</p>';
        payload.before_file_write({ filePath: file, originalContent: original, content: html, toolName: 'edit' });
        fs.writeFileSync(file, html, 'utf8');
        payload.validateOutput({ output_content: html });
        return {};
      } finally { running--; }
    }
    // 与 Runtime 的恢复门槛一致，不能仅断言 mode=resume 而忽略任务归属。
    assert.equal(persistent.run_id, payload.task_id, '持久 Agent 任务与当前业务任务必须匹配');
    assert.ok(!runIds.includes(payload.task_id));
    runIds.push(payload.task_id);
    assert.equal(persistent.session_file, sessionFile);
    assert.equal(persistent.layout_check, state);
    assert.equal(persistent.error, null, '开始本次执行时应清除上次错误');
    payload.onCheckpoint({ status: 'running', phase: 'layout-checking', session_file: sessionFile });
    assert.equal(checkpoints.at(-1).run_id, payload.task_id);
    assert.equal(checkpoints.at(-1).task_key, CONTENT_GENERATION_AGENT_TASK_KEY);
    assert.equal(checkpoints.at(-1).session_file, sessionFile);
    assert.equal(payload.persistent_task.mode, 'resume');
    assert.equal(payload.initial_stage, 'layout-checking');
    assert.deepEqual(payload.files, []);
    assert.ok(!payload.active_tools.includes('write'));
    assert.match(payload.prompt, /不再调整全文字数/);
    const tools = payload.create_tools({ Type, workspaceDir });
    const supplement = tools.find(tool => tool.name === 'supplement-layout-sections');
    const complete = tools.find(tool => tool.name === 'complete-layout-supplement');
    if (failFirst) {
      const results = (await supplement.execute('batch', { section_ids: targets.map(section => section.id) })).details.results;
      assert.equal(results.filter(item => item.status === 'error').length, 1);
      assert.throws(() => complete.execute(), /未完成/);
      Object.assign(persistent, { status: 'error', error: interrupted.message });
      throw interrupted;
    }
    assert.deepEqual(state.completed_section_ids, [targets[1].id]);
    await assert.rejects(supplement.execute('again', { section_ids: [targets[1].id] }), /未完成的格式补写/);
    await supplement.execute('retry', { section_ids: [targets[0].id] });
    complete.execute();
    assert.deepEqual(payload.continueTask(), { complete: true });
    payload.validateOutput({}, { workspace_dir: workspaceDir });
    return { workspace_dir: workspaceDir };
  } };
  const run = () => runContentLayoutAgent({ agentService, signal, layout, onCheckpoint: checkpoint => checkpoints.push(checkpoint) });
  await assert.rejects(run(), error => error === interrupted);
  assert.equal(persistent.error, interrupted.message);
  assert.equal(state.status, 'supplementing');
  const completedFile = path.join(workspaceDir, targets[1].file);
  const completedBefore = fs.readFileSync(completedFile, 'utf8');
  failFirst = false;
  await run();
  assert.equal(runIds.length, 2);
  assert.equal(persistent.session_file, sessionFile);
  assert.equal(persistent.status, 'success');
  assert.equal(persistent.error, null);
  assert.equal(fs.readFileSync(completedFile, 'utf8'), completedBefore);
  assert.equal(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'), inputBefore);
  assert.equal(peak, 2);
  assert.equal(calls.filter(file => file === targets[1].file).length, 1);
  assert.equal(state.status, 'rechecking');
  console.log('格式补写：运行编号与检查点一致、失败后原会话续接、并发、图片保护和成功项复用通过。');
}

if (process.argv.includes('--original-store')) {
  checkOriginalImageStore();
} else if (!process.argv.includes('--render-images') && !process.argv.includes('--validate-html')) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
} else if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '正文真实转图-'));
  const env = { ...process.env, YIBIAO_CONTENT_IMAGE_TEST_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(require('electron'), [__filename, process.argv.includes('--validate-html') ? '--validate-html' : '--render-images'], { env, windowsHide: true, stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    // 只清理本次创建的临时目录，Electron 退出后再删除其缓存。
    if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('正文真实转图-')) fs.rmSync(directory, { recursive: true, force: true });
  }
} else {
  const { app } = require('electron');
  const directory = process.env.YIBIAO_CONTENT_IMAGE_TEST_DIR;
  app.setPath('userData', path.join(directory, 'electron-data'));
  app.on('window-all-closed', () => {});
  app.whenReady().then(() => process.argv.includes('--validate-html') ? checkRestrictedHtml() : checkLocalRendering(directory)).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
}
