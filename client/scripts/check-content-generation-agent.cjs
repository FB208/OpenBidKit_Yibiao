const assert = require('node:assert/strict');
const fs = require('node:fs');
const { NATIVE_AGENT_TOOLS } = require('../electron/services/agent/agentToolEnvironment.cjs');
const os = require('node:os');
const path = require('node:path');
const { CONTENT_GENERATION_AGENT_TASK_KEY, buildContentGenerationFiles, createContentGenerationTools, runContentGenerationAgent, readContentGenerationResult, inspectSectionArtifact, inspectContentArtifacts } = require('../electron/services/contentGenerationAgent.cjs');
const { createContentGenerationImageTools } = require('../electron/services/contentGenerationImageTools.cjs');
const { AI_IMAGE_STYLES, buildImageStylePrompt } = require('../electron/services/aiImageStyles.cjs');
const { taskFilePath, TASK_FILE_SCHEMAS } = require('../electron/services/contentGenerationTaskFiles.cjs');

// 批量工具从任务文件读取；直接调用工具的检查沿用原参数写法，由包装写入任务文件后提交。
const TOOL_TASK_KEYS = { 'generate-sections': 'sections', 'generate-section-images': 'images', 'render-html-image': 'renderHtml', 'render-mermaid-image': 'renderMermaid',
  'apply-section-images': 'applyImages', 'adjust-sections': 'adjust', 'repair-sections': 'repair', 'remove-section-tables': 'tables', 'supplement-layout-sections': 'layout' };
function writeTaskFile(workspaceDir, toolName, params, dir) {
  const file = path.join(workspaceDir, taskFilePath(TOOL_TASK_KEYS[toolName], dir));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(params, null, 2), 'utf8');
}
function taskTools(tools, workspaceDir, dir) {
  return tools.map(tool => TOOL_TASK_KEYS[tool.name] ? { ...tool, execute: (callId, params, ...rest) => {
    writeTaskFile(workspaceDir, tool.name, params, dir);
    return tool.execute(callId, {}, ...rest);
  } } : tool);
}

// 按 Runtime 协议传递验收值；已接受的质量问题必须明确给出。
function submissionContext(payload, workspaceDir, acceptedIssues = []) {
  const context = { workspace_dir: workspaceDir, accepted_issues: acceptedIssues };
  const report = payload.validateOutput({}, context);
  assert.deepEqual(report.issues, acceptedIssues, '仅通过验收或明确接受质量问题后推进');
  context.validation_result = report.value;
  return context;
}

// 进入审计前的小节核对只需返回空台账，这些场景不检查核对内容。
const consistencyAiService = { chat: async () => '', requestJson: async () => ({ issues: [], facts: [] }) };

// 图片工具按清单 image_id 自动回填正文，夹具为每个标识准备同一目标小节中的 figure。
function createImageFixture(workspaceDir, names, section = { id: '配图夹具', file: '配图夹具/配图夹具.html' }) {
  fs.mkdirSync(path.dirname(path.join(workspaceDir, section.file)), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, section.file), names.map(name => `<figure id="${name}" data-yb-size="wide" data-yb-generation="htmlImage"><template data-yb-role="prompt">${name}</template><img alt="${name}"><figcaption>${name}</figcaption></figure>`).join('\n'), 'utf8');
  return {
    sections: [section],
    id: name => `${encodeURIComponent(section.id)}/${encodeURIComponent(name)}`,
    reference: name => require('cheerio').load(fs.readFileSync(path.join(workspaceDir, section.file), 'utf8'), null, false)(`figure[id="${name}"] img`).attr('data-yb-asset-ref'),
  };
}

// 使用真实解析器与范围替换，逐字验证回填只改变指定属性。
async function checkImageManifestTools({ Type, workspaceDir, signal }) {
  const root = fs.mkdtempSync(path.join(workspaceDir, '图片清单-'));
  fs.mkdirSync(path.join(root, '正文'));
  fs.mkdirSync(path.join(root, '图片'));
  fs.mkdirSync(path.join(root, '原图'));
  const ref = "图片/新 & '图.png";
  for (const name of [ref, '图片/另一张.png', '原图/现场.png']) fs.writeFileSync(path.join(root, name), '测试图片');
  const figure = (id, img, kind = 'htmlImage') => `<figure data-yb-size='wide' id='${id}' data-yb-generation='${kind}'><template data-yb-role="prompt">阶段 &amp; 责任</template>${img}<figcaption>标题</figcaption></figure>`;
  const first = '\ufeff<!-- yibiao:block -->\r\n<p>保留 &amp; 原文</p>\r\n<table data-yb-preset="threeImages"><tr><td>'
    + figure('同名/图', '<img alt="标题 > 内容" />') + '</td><td>'
    + figure('第二张', "<img data-yb-asset-ref='' alt='第二张'>") + '</td><td>'
    + figure('原图', '<img alt="现场" data-yb-asset-ref="原图/现场.png">', 'aiImage') + '</td></tr></table>\r\n';
  const second = figure('同名/图', '<img alt="另一节">', 'mermaid');
  const sections = [{ id: '甲', file: '正文/甲.html' }, { id: '乙', file: '正文/乙.html' }];
  const save = (section, html) => fs.writeFileSync(path.join(root, section.file), html, 'utf8');
  const read = section => fs.readFileSync(path.join(root, section.file), 'utf8');
  save(sections[0], first); save(sections[1], second);
  const { createContentImageProtection } = require('../electron/services/contentGenerationEditTools.cjs');
  const protection = createContentImageProtection({ workspaceDir: root, files: sections.map(section => section.file) });
  const tools = taskTools(createContentGenerationImageTools({ htmlImageOptimization: true, aiService: {}, signal, sections,
    beforeApply: () => protection.beforeToolCall({ toolCall: { name: 'apply-section-images' } }),
  }, { Type, workspaceDir: root }), root);
  const list = tools.find(tool => tool.name === 'list-section-images');
  const apply = tools.find(tool => tool.name === 'apply-section-images');
  const listed = (await list.execute('list', {})).details.results;
  assert.ok(listed.every(section => section.status === 'success'));
  const [a, b, original] = listed[0].images;
  const other = listed[1].images[0];
  assert.notEqual(a.image_id, other.image_id, '不同小节同名 figure 不串图');
  assert.equal(a.prompt, '阶段 & 责任');
  assert.equal(a.frame_size, 'wide');
  assert.equal(a.asset_exists, false);
  assert.equal(original.reused_original, true);
  assert.equal(original.asset_exists, true);
  // 分组已给出小节，图片项不重复小节与文件；布局核对和分布统计由程序汇总。
  assert.ok(!('section_id' in a) && !('file' in a) && !('location' in a) && !('table' in a));
  const listOutput = await list.execute('summary', {});
  const { summary } = listOutput.details;
  // 全量清单写入程序清单文件，模型只接收数量统计。
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, listOutput.details.file), 'utf8')).summary, summary);
  assert.deepEqual(JSON.parse(listOutput.content[0].text), { file: '程序清单/正文图片清单.json', summary: {
    new_images: 3, reused_original_images: 1, new_images_by_generation: summary.new_images_by_generation, new_layout_groups: summary.new_layout_groups,
    missing_caption_count: 0, missing_fit_count: 4, missing_asset_count: 3 } });
  assert.deepEqual(summary, {
    new_images: 3, reused_original_images: 1,
    new_images_by_generation: { aiImage: 0, htmlImage: 2, mermaid: 1 },
    new_layout_groups: { single: 1, imageText: 0, threeImages: 1, fourImages: 0 },
    missing_caption: [], missing_fit: [a.image_id, b.image_id, original.image_id, other.image_id],
    missing_asset: [a.image_id, b.image_id, other.image_id],
  });
  const job =(image, asset_ref = ref) => ({ image_id: image.image_id, asset_ref, previous_asset_ref: image.asset_ref });
  // 同节一项失败不写入；其他小节仍成功。
  const partial = (await apply.execute('partial', { images: [job(a), job(b, '图片/不存在.png'), job(other)] })).details.results;
  assert.deepEqual(partial.map(item => item.status), ['error', 'error', 'success']);
  assert.equal(read(sections[0]), first);
  const escaped = `data-yb-asset-ref="图片/新 &amp; '图.png"`;
  assert.equal(read(sections[1]), second.replace('<img alt="另一节">', `<img alt="另一节" ${escaped}>`));
  const done = (await apply.execute('apply', { images: [job(a), job(b, '图片/另一张.png')] })).details.results;
  assert.ok(done.every(item => item.status === 'success'));
  const expected = first.replace('<img alt="标题 > 内容" />', `<img alt="标题 > 内容" ${escaped} />`)
    .replace("data-yb-asset-ref=''", 'data-yb-asset-ref="图片/另一张.png"');
  assert.equal(read(sections[0]), expected, 'BOM、CRLF、其他属性、正文、图注和图组布局逐字不变');
  assert.ok((await apply.execute('retry', { images: [job(a), job(b, '图片/另一张.png')] })).details.results.every(item => item.status === 'success'));
  assert.equal(read(sections[0]), expected);
  const stale = (await apply.execute('stale', { images: [job(a, '图片/另一张.png')] })).details.results[0];
  assert.match(stale.error, /引用已变化/);
  const refreshedOutput = await list.execute('refresh', { section_ids: ['甲'] });
  assert.equal(refreshedOutput.details.file, undefined, '按小节刷新直接返回明细，不改写清单文件');
  assert.equal(JSON.parse(refreshedOutput.content[0].text).results[0].section_id, '甲');
  const refreshed = refreshedOutput.details.results[0].images;
  assert.equal(refreshed[0].asset_ref, ref);
  assert.equal(refreshed[0].asset_exists, true);
  assert.match((await list.execute('outside', { section_ids: ['其他'] })).details.results[0].error, /非目标/);
  assert.equal((await apply.execute('outside', { images: [{ ...job(a), image_id: '其他/图' }] })).details.results[0].status, 'error');
  await assert.rejects(apply.execute('duplicate', { images: [job(a), job(a)] }), /不能重复/);
  fs.writeFileSync(path.join(root, '图片/源码.html'), '<html></html>');
  assert.match((await apply.execute('source', { images: [job(a, '图片/源码.html')] })).details.results[0].error, /不能使用 HTML/);
  for (const broken of [second + second, second.replace("id='同名/图'", ''), '<img alt="孤立图">']) {
    save(sections[1], broken);
    assert.equal((await list.execute('invalid', { section_ids: ['乙'] })).details.results[0].status, 'error');
    assert.equal((await apply.execute('invalid', { images: [job(other)] })).details.results[0].status, 'error');
    assert.equal(read(sections[1]), broken);
  }
  save(sections[1], second);
  const cancel = new AbortController(); cancel.abort(new Error('暂停回填'));
  await assert.rejects(apply.execute('cancel', { images: [job(other)] }, cancel.signal), /暂停回填/);
  assert.equal(read(sections[1]), second);
  protection.enter();
  await assert.rejects(apply.execute('protected', { images: [job(other)] }), /不能调用 apply-section-images/);
  assert.equal(read(sections[1]), second);
  assert.equal(read(sections[0]), expected);
  console.log('图片清单及回填：真实解析、同名隔离、图组原文保留、旧引用冲突、部分失败、重试、取消和保护检查通过。');
}

// 用真实请求队列和受控完成顺序验证跨类型重叠、逐张转图、修复及取消。
async function checkImageSourceGeneration({ Type, workspaceDir, signal }) {
  const { createAiRequestQueue } = require('../electron/utils/aiRequestQueue.cjs');
  const queue = createAiRequestQueue({ getLimit: () => 2 });
  const imageQueue = createAiRequestQueue({ getLimit: () => 1 });
  const pending = new Map(), requests = [], rendering = [], updates = [];
  let finishAi;
  const aiFile = path.join(workspaceDir, '混合AI.png');
  fs.writeFileSync(aiFile, 'AI图片');
  const aiService = {
    chat(request) {
      requests.push(request);
      return queue.enqueue(() => new Promise((resolve, reject) => pending.set(request.messages[1].content, { resolve, reject })), { signal: request.signal, maxAttempts: 1 });
    },
    generateImage(request) {
      return imageQueue.enqueue(() => new Promise(resolve => { finishAi = resolve; }), { signal: request.signal, maxAttempts: 1 });
    },
  };
  const png = { buffer: Buffer.from('图片'), width: 100, height: 80, layout_issues: [] };
  const renderer = {
    async renderHtmlToPng(source, options) { rendering.push({ source, frame: options.frameSize }); return png; },
    async renderMermaidToPng(source) { rendering.push({ source }); return png; },
  };
  const progressEvents = [];
  const fixture = createImageFixture(workspaceDir, ['进度图', '流程图', '失败图', '现场图']);
  const { sections, id } = fixture;
  const tools = taskTools(createContentGenerationImageTools({ htmlImageOptimization: true, aiService, signal, localImageRenderService: renderer, sections,
    onActivity: event => progressEvents.push(structuredClone(event.progress)),
  }, { Type, workspaceDir }), workspaceDir);
  const tool = tools.find(item => item.name === 'generate-section-images');
  // 已有有效图片默认跳过；需要重新生成同一图片时显式 regenerate。
  const again = job => ({ ...job, regenerate: true });
  const jobs = [
    { image_id: id('进度图'), kind: 'html', frame_size: 'wide', prompt: '进度：准备2天，实施3天' },
    { image_id: id('流程图'), kind: 'mermaid', prompt: '流程图：准备后实施' },
    { image_id: id('失败图'), kind: 'mermaid', prompt: '思维导图：实施管理' },
    { image_id: id('现场图'), kind: 'ai', prompt: '现场照片', style: 'realistic_photo', size: '1024x1024' },
  ];
  const html = '<!doctype html><html><body><div>准备2天，实施3天</div></body></html>';
  const mermaid = 'flowchart LR\nA["准备"] --> B["实施"]';
  const operation = tool.execute('mixed', { images: jobs }, undefined, update => updates.push(update.details));
  assert.deepEqual(requests.map(request => request.messages[1].content), jobs.slice(0, 3).map(job => job.prompt));
  assert.equal(pending.size, 2, '源码请求遵守现有文本并发上限');
  assert.equal(typeof finishAi, 'function', 'AI 生图与源码请求已同时启动');
  assert.match(requests[0].messages[0].content, /1240×827px.*40px/);
  assert.match(requests[0].messages[0].content, /Flex\/Grid/);
  assert.match(requests[1].messages[0].content, /flowchart.*mindmap.*erDiagram/);
  pending.get(jobs[1].prompt).resolve(mermaid);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.size, 3, '文本队列独立继续派发');
  assert.equal(rendering[0].source, mermaid, '较慢 HTML 和 AI 图尚未完成时，Mermaid 已进入转图');
  assert.equal(updates[0].result.image_id, id('流程图'));
  assert.equal(updates[0].result.status, 'success');
  assert.equal(fixture.reference('流程图'), updates[0].result.asset_ref, '单张成功后立即回填，不等整批结束');
  assert.equal(fixture.reference('进度图'), undefined);
  pending.get(jobs[2].prompt).reject(new Error('模拟源码生成失败'));
  pending.get(jobs[0].prompt).resolve(html);
  finishAi({ file_path: aiFile });
  const mixedOutput = await operation;
  const results = mixedOutput.details.results;
  assert.deepEqual(results.map(result => result.status), ['success', 'success', 'error', 'success']);
  assert.deepEqual(results.map(result => result.applied), [true, true, undefined, true]);
  for (const [index, name] of ['进度图', '流程图', '失败图', '现场图'].entries()) assert.equal(fixture.reference(name), results[index].asset_ref);
  // 模型文本只列未成功项，成功项已回填且完整结果保留在 details。
  assert.deepEqual(JSON.parse(mixedOutput.content[0].text), { total: 4, applied: 3, skipped: 0, unresolved: [results[2]] });
  assert.equal(mixedOutput.isError, true);
  assert.deepEqual(progressEvents.filter(event => event.step === 'image-apply').at(-1).items,
    [0, 1, 3].map(index => ({ id: results[index].image_id, status: 'success' })));
  assert.match(results[2].error, /模拟源码生成失败/);
  assert.equal(results[0].frame_size, 'wide');
  assert.equal(updates.at(-1).completed, jobs.length);
  const imageEvents = id => progressEvents.filter(event => event.step === 'images').flatMap(event => event.items || []).filter(item => item.id === id);
  assert.deepEqual(imageEvents(id('进度图')).map(item => item.status), ['generating', 'rendering', 'success']);
  assert.equal(imageEvents(id('进度图'))[1].source_ready, true);
  assert.deepEqual(imageEvents(id('失败图')).map(item => item.status), ['generating', 'error']);
  assert.deepEqual(imageEvents(id('现场图')).map(item => item.status), ['generating', 'success']);
  // 重复提交同一任务文件时，已有有效图片跳过且不请求模型，进度按完成展示。
  const originalChat = aiService.chat;
  const originalGenerateImage = aiService.generateImage;
  aiService.chat = async () => assert.fail('已有有效图片不得重新生成源码');
  aiService.generateImage = async () => assert.fail('已有有效图片不得重新生图');
  const repeated = await tool.execute('repeat', { images: [0, 1, 3].map(index => jobs[index]) });
  assert.deepEqual(repeated.details.results.map(item => [item.status, item.asset_ref]), [0, 1, 3].map(index => ['skipped', results[index].asset_ref]));
  assert.deepEqual(JSON.parse(repeated.content[0].text), { total: 3, applied: 0, skipped: 3, unresolved: [] });
  assert.equal(repeated.isError, undefined);
  assert.ok(imageEvents(id('现场图')).at(-1).status === 'success');
  aiService.generateImage = originalGenerateImage;
  // 找不到的图片在请求模型前报错；生成期间引用被改动时保留图片并返回回填错误。
  aiService.chat = async () => assert.fail('正文中不存在的图片不得请求模型');
  const missing = await tool.execute('missing-figure', { images: [{ ...jobs[0], image_id: id('不存在') }, { ...jobs[0], image_id: '其他/图' }] });
  assert.deepEqual(missing.details.results.map(item => item.status), ['error', 'error']);
  assert.match(missing.details.results[0].error, /正文中不存在该图片/);
  assert.match(missing.details.results[1].error, /不属于本次目标小节/);
  const beforeConflict = fixture.reference('进度图');
  aiService.chat = async () => {
    const file = path.join(workspaceDir, sections[0].file);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(`data-yb-asset-ref="${beforeConflict}"`, 'data-yb-asset-ref="图片/他处修改.png"'), 'utf8');
    return html;
  };
  const conflict = await tool.execute('apply-conflict', { images: [again(jobs[0])] });
  const conflicted = conflict.details.results[0];
  assert.equal(conflicted.status, 'success');
  assert.equal(conflicted.applied, false);
  assert.equal(conflicted.previous_asset_ref, beforeConflict);
  assert.match(conflicted.apply_error, /引用已变化/);
  assert.ok(fs.existsSync(path.join(workspaceDir, conflicted.asset_ref)), '回填失败仍保留已生成图片');
  assert.deepEqual(JSON.parse(conflict.content[0].text).unresolved, [conflicted]);
  assert.equal(conflict.isError, true);
  assert.equal(fixture.reference('进度图'), '图片/他处修改.png');
  aiService.chat = originalChat;
  for (const [index, source] of [html, mermaid].entries()) {
    assert.equal(fs.readFileSync(path.join(workspaceDir, results[index].source_file), 'utf8'), source);
    assert.equal(fs.readFileSync(path.join(workspaceDir, results[index].asset_ref), 'utf8'), '图片');
  }
  for (const [frame_size, height] of Object.entries({ square: 1240, tall: 1653, panorama: 698 })) {
    aiService.chat = async request => { assert.ok(request.messages[0].content.includes(`1240×${height}px`)); return html; };
    const retry = (await tool.execute('new-source', { images: [again({ ...jobs[0], frame_size })] })).details.results[0];
    assert.equal(retry.status, 'success');
    assert.notEqual(retry.source_file, results[0].source_file, '重新生成不得覆盖旧源码');
  }
  aiService.chat = async () => `\`\`\`html\n${html}\n\`\`\``;
  renderer.renderHtmlToPng = async () => { throw new Error('模拟转图失败'); };
  const failed = (await tool.execute('render-error', { images: [again(jobs[0])] })).details.results[0];
  assert.equal(failed.stage, 'render');
  assert.equal(fs.readFileSync(path.join(workspaceDir, failed.source_file), 'utf8'), html);
  aiService.chat = async () => assert.fail('已有源码的渲染修复不应再次请求模型');
  renderer.renderHtmlToPng = async () => ({ ...png, layout_issues: ['越界'] });
  const repair = tools.find(item => item.name === 'render-html-image');
  const repairParams = { images: [{ image_id: failed.image_id, source_file: failed.source_file, frame_size: 'wide', regenerate: true }] };
  assert.equal((await repair.execute('layout', repairParams)).details.results[0].status, 'needs_repair');
  assert.equal(imageEvents(failed.image_id).at(-1).status, 'needs_repair');
  renderer.renderHtmlToPng = async () => png;
  assert.equal((await repair.execute('repair', repairParams)).details.results[0].status, 'success');
  assert.equal(imageEvents(failed.image_id).at(-1).status, 'success');
  aiService.chat = async () => html;
  renderer.renderHtmlToPng = async () => ({ ...png, layout_issues: ['越界'] });
  assert.equal((await tool.execute('initial-layout', { images: [again(jobs[0])] })).details.results[0].status, 'needs_repair');
  // 默认关闭二次优化：首次生成及重渲染跳过布局审核，真正的转图失败仍报错。
  aiService.chat = async () => `介绍文字\n\`\`\`html\n${html}\n\`\`\`\n总结说明`;
  const uncheckedTools = taskTools(createContentGenerationImageTools({ aiService, signal, localImageRenderService: renderer, sections }, { Type, workspaceDir }), workspaceDir);
  renderer.renderHtmlToPng = async (_source, options) => {
    assert.equal(options.checkLayout, false);
    return { ...png, layout_issues: [] };
  };
  for (const [name, params] of [['generate-section-images', { images: [again(jobs[0])] }], ['render-html-image', repairParams]]) {
    const result = (await uncheckedTools.find(item => item.name === name).execute('unchecked', params)).details.results[0];
    assert.equal(result.status, 'success');
    assert.deepEqual(result.layout_issues, []);
  }
  renderer.renderHtmlToPng = async () => { throw new Error('模拟转图失败'); };
  assert.equal((await uncheckedTools.find(item => item.name === 'render-html-image').execute('unchecked-error', repairParams)).details.results[0].status, 'error');
  // 从实际生成工具检查源码提取：不重新请求模型，保存和渲染收到同一份源码。
  for (const kind of ['html', 'mermaid']) {
    const source = kind === 'html' ? '<div>中文与行内 ``` 标记</div>\r\n<!-- 行尾 ```\r\n保留注释 -->\r\n  <p>保留缩进</p>'
      : 'flowchart LR\r\n  A["准备"] --> B["交付"]';
    for (const response of [source, `介绍文字\n\`\`\`${kind}\n${source}\n\`\`\``, `\`\`\`${kind}\n${source}\n\`\`\`\n总结说明`, `介绍文字\r\n  \`\`\`${kind}\r\n${source}\r\n  \`\`\`\r\n总结说明`, `\`\`\`${kind}\n${source}\n\`\`\``, `\`\`\`\n${source}\n\`\`\``, ` \r\n\`\`\`${kind.toUpperCase()} \r\n${source}\r\n\`\`\` \r\n`]) {
      let calls = 0, renders = 0;
      aiService.chat = async () => { calls++; return response; };
      renderer[kind === 'html' ? 'renderHtmlToPng' : 'renderMermaidToPng'] = async actual => {
        renders++;
        assert.equal(actual, source);
        return { ...png, layout_issues: [] };
      };
      const result = (await tool.execute('extract-source', { images: [again({ ...jobs[0], kind })] })).details.results[0];
      assert.equal(result.status, 'success', result.error);
      assert.equal(calls, 1);
      assert.equal(renders, 1);
      assert.equal(fs.readFileSync(path.join(workspaceDir, result.source_file), 'utf8'), source);
    }
  }
  renderer.renderHtmlToPng = async () => assert.fail('包装错误不应进入渲染');
  for (const invalid of ['', '```html\n```', '```html\n \n```', '```html\n<div>未闭合</div>',
    '介绍\n```html\n<div>未闭合</div>\n总结', '介绍\n```html\n```\n总结',
    '```html\n<div>内容</div>\n```html', '````html\n<div>内容</div>\n```',
    '```html\n<div>第一段</div>\n```\n```html\n<div>第二段</div>\n```',
    '```mermaid\nflowchart LR\nA-->B\n```', '```json\n{}\n```']) {
    aiService.chat = async () => invalid;
    const result = (await tool.execute('invalid-source', { images: [again(jobs[0])] })).details.results[0];
    assert.equal(result.status, 'error');
    assert.match(result.error, /AI 源码|源码围栏语言/);
    assert.equal(result.source_file, undefined);
  }
  aiService.chat = async () => assert.fail('缺少画布比例不得请求模型');
  // 任务文件结构错误在提交时整体报错，不请求模型。
  await assert.rejects(tool.execute('missing-size', { images: [again({ ...jobs[0], frame_size: undefined })] }), /frame_size/);
  await assert.rejects(tool.execute('duplicate', { images: [jobs[0], jobs[0]] }), /不能重复/);
  for (const cancelTask of [false, true]) {
    const taskCancel = new AbortController(), toolCancel = new AbortController();
    let cancelled = 0;
    aiService.chat = request => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => { cancelled++; reject(request.signal.reason); }, { once: true }));
    const cancelledProgress = [];
    const cancellable = taskTools(createContentGenerationImageTools({ htmlImageOptimization: true, aiService, signal: taskCancel.signal, sections,
      onActivity: event => cancelledProgress.push(...(event.progress.items || [])),
    }, { Type, workspaceDir }), workspaceDir).find(item => item.name === tool.name);
    const before = fs.readdirSync(path.join(workspaceDir, '图片'));
    const running = cancellable.execute('cancel-sources', { images: jobs.slice(0, 3).map(again) }, toolCancel.signal);
    (cancelTask ? taskCancel : toolCancel).abort(new Error('取消源码生成'));
    const output = await running;
    assert.equal(output.isError, true);
    assert.equal(output.details.cancelled, true);
    assert.ok(output.details.results.every(item => item.status === 'cancelled'));
    assert.equal(cancelled, 3);
    assert.equal(cancelledProgress.filter(item => item.status === 'cancelled').length, 3);
    assert.deepEqual(fs.readdirSync(path.join(workspaceDir, '图片')), before);
  }
  console.log('混合配图：生图与源码重叠、源码逐张转图、独立队列、部分失败、布局修复及取消检查通过。');
}

// 使用真实 Pi 持久会话，验证暂停结果可恢复且只重做未完成阶段。
async function checkImagePauseSession({ workspaceDir }) {
  const { createPiSession, loadPiModules } = require('../electron/services/pi/piSessionFactory.cjs');
  const { piAi } = await loadPiModules();
  const controller = new AbortController();
  const aiFile = path.join(workspaceDir, '暂停测试.png');
  fs.writeFileSync(aiFile, '已完成AI图');
  let releaseRender, renderStarted, imageSaved;
  const readyToRender = new Promise(resolve => { renderStarted = resolve; });
  const readyToPause = new Promise(resolve => { imageSaved = resolve; });
  const base = {
    workspaceDir, sessionsDir: path.join(workspaceDir, 'pause-sessions'), config: {}, timeoutMs: 60000, summaryEnabled: false,
    environment: { shellPath: process.env.ComSpec, layout: { agentDir: path.join(workspaceDir, 'pause-agent') }, instructions: '图片暂停检查', env: {} },
    proxyInfo: { baseUrl: 'http://127.0.0.1:1', token: 'test' },
  };
  const aiService = {
    async generateImage() { return { file_path: aiFile }; },
    chat(request) {
      if (request.messages[1].content === '待转图') return Promise.resolve('flowchart LR\nA-->B');
      return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
    },
  };
  const renderer = { renderMermaidToPng(_source, options) {
    renderStarted();
    return new Promise((_resolve, reject) => { releaseRender = () => {
      assert.equal(options.isPauseRequested(), true);
      reject(options.createPauseError());
    }; });
  } };
  const fixture = createImageFixture(workspaceDir, ['完成图片', '完成源码', '未完成源码'], { id: '暂停配图', file: '配图夹具/暂停配图.html' });
  const { sections, id } = fixture;
  const created = await createPiSession({ ...base, createTools: context => createContentGenerationImageTools({ htmlImageOptimization: true, aiService, signal: controller.signal, localImageRenderService: renderer, sections }, context) });
  const jobs = [
    { image_id: id('完成图片'), kind: 'ai', prompt: 'AI图', style: '3d_render', size: '1024x1024' },
    { image_id: id('完成源码'), kind: 'mermaid', prompt: '待转图' },
    { image_id: id('未完成源码'), kind: 'html', prompt: '待源码', frame_size: 'wide' },
  ];
  writeTaskFile(workspaceDir, 'generate-section-images', { images: jobs });
  created.session.subscribe(event => {
    if (event.type === 'tool_execution_update' && event.partialResult?.details?.result?.image_id === id('完成图片')) imageSaved();
  });
  created.session.agent.streamFn = (_model, _context, options) => {
    const stream = piAi.createAssistantMessageEventStream();
    const stopReason = options.signal.aborted ? 'aborted' : 'toolUse';
    stream.push({ type: 'done', reason: stopReason, message: { role: 'assistant', stopReason,
      content: options.signal.aborted ? [] : [{ type: 'toolCall', id: 'pause-mixed', name: 'generate-section-images', arguments: {} }],
      api: 'openai-completions', provider: 'yibiao', model: 'default', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
    return stream;
  };
  let resumed;
  try {
    const running = created.session.prompt('生成混合图片');
    await Promise.all([readyToRender, readyToPause]);
    controller.abort(new Error('暂停图片任务'));
    const stopping = created.session.abort();
    releaseRender();
    await Promise.all([running, stopping]);
    const entries = fs.readFileSync(created.sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const saved = entries.findLast(entry => entry.type === 'message' && entry.message.toolName === 'generate-section-images');
    assert.ok(saved, '真实 JSONL 必须记录工具结果，不只是临时进度事件');
    const output = saved.message.details;
    assert.equal(output.cancelled, true);
    assert.deepEqual(output.results.map(item => [item.status, item.stage]), [['success', 'complete'], ['cancelled', 'render'], ['cancelled', 'generate']]);
    const [image, source] = output.results;
    assert.deepEqual(JSON.parse(saved.message.content[0].text), { total: 3, applied: 1, skipped: 0, unresolved: output.results.slice(1), cancelled: true }, '模型文本保留未完成项及源码路径');
    assert.equal(fs.readFileSync(path.join(workspaceDir, image.asset_ref), 'utf8'), '已完成AI图');
    assert.equal(fixture.reference('完成图片'), image.asset_ref, '暂停前完成的图片已回填正文');
    assert.equal(fixture.reference('完成源码'), undefined);
    assert.equal(fs.readFileSync(path.join(workspaceDir, source.source_file), 'utf8'), 'flowchart LR\nA-->B');
    created.session.dispose();
    resumed = await createPiSession({ ...base, sessionFile: created.sessionFile });
    assert.ok(resumed.session.agent.state.messages.some(message => message.role === 'toolResult' && JSON.stringify(message).includes(image.asset_ref)), '重新打开原会话仍能找到已完成图片');
    const { Type } = await import('typebox');
    const repairs = taskTools(createContentGenerationImageTools({ htmlImageOptimization: true,
      aiService: { chat: () => assert.fail('恢复转图不得重新生成源码'), generateImage: () => assert.fail('不重新生成成功图片') },
      signal: new AbortController().signal, sections,
      localImageRenderService: { async renderMermaidToPng() { return { buffer: Buffer.from('恢复图片'), width: 100, height: 80 }; } },
    }, { Type, workspaceDir }), workspaceDir);
    // 恢复时整份原任务文件再次提交：已完成图片跳过，不重新生图。
    const resubmitted = await repairs.find(tool => tool.name === 'generate-section-images').execute('resume-all', { images: [jobs[0]] });
    assert.equal(resubmitted.details.results[0].status, 'skipped');
    const repaired = (await repairs.find(tool => tool.name === 'render-mermaid-image').execute('resume-render', { images: [{ image_id: source.image_id, source_file: source.source_file }] })).details.results[0];
    assert.equal(repaired.status, 'success');
    assert.equal(repaired.source_file, source.source_file);
    assert.equal(fixture.reference('完成源码'), repaired.asset_ref, '恢复转图成功后同样自动回填');
    console.log('真实 Pi 会话：暂停后成功图片及待转图源码持久保存，原会话恢复可复用，源码不重新生成。');
  } finally { created.session.dispose(); resumed?.session.dispose(); }
}

// 真实 Pi 只创建一次 Session，多次 prompt 依次编排、生成、审计、去表格及格式补写。
async function checkPlanningSessionHandoff({ workspaceDir, fileOptions, signal }) {
  const { createPiSession, loadPiModules } = require('../electron/services/pi/piSessionFactory.cjs');
  const { preparePiEnvironment } = require('../electron/services/pi/piEnvironment.cjs');
  const { piAi } = await loadPiModules();
  const { createWorkspaceBaseline } = require('../electron/services/pi/piWorkspaceBaseline.cjs');
  const { BASELINE_GROUPS } = require('../electron/services/contentGenerationAgent.cjs');
  const directory = path.join(workspaceDir, '统一正文会话');
  fs.mkdirSync(path.join(directory, '正文'), { recursive: true });
  // 上一轮已完成的小节不属于本轮目标，新一轮开始即登记保护。
  fs.writeFileSync(path.join(directory, '正文/旧小节.html'), '<!-- yibiao:block --><p>上一轮正文</p>', 'utf8');
  const baseline = createWorkspaceBaseline({ workspaceDir: directory, baselineDir: path.join(workspaceDir, '统一正文会话-原件') });
  const environment = preparePiEnvironment({ isPackaged: false, getPath: () => directory, getAppPath: () => path.resolve(__dirname, '..') });
  const planningResult = { plans: fileOptions.targets.map(({ item }) => ({ id: item.id, content_plan: fileOptions.plans[item.id].plan })) };
  const state = {};
  const phases = [];
  const promptTurns = {};
  const writerRequests = [];
  const consistencyChecks = [];
  let creates = 0, mainCalls = 0, builds = 0, checks = 0;
  const writeFiles = async files => {
    for (const file of files) {
      const target = path.join(directory, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content, 'utf8');
    }
  };
  let plans = structuredClone(fileOptions.plans);
  const service = {
    hasPersistentTaskSession: () => false,
    updatePersistentTask(key, partial) { assert.equal(key, CONTENT_GENERATION_AGENT_TASK_KEY); Object.assign(state, partial); },
    async runTask(payload) {
      if (!payload.primary_session) {
        const file = path.join(directory, payload.output_file);
        fs.appendFileSync(file, '\n<!-- yibiao:block -->\n<p>补充现场执行安排。</p>', 'utf8');
        assert.equal(payload.validateOutput, undefined, '子任务不拥有提交修复轮次');
        return {};
      }
      mainCalls++;
      assert.equal(payload.persistent_task.task_key, CONTENT_GENERATION_AGENT_TASK_KEY);
      assert.equal(payload.initial_stage, 'content-planning');
      await writeFiles(payload.files);
      assert.equal(fs.existsSync(path.join(directory, '正文编排决策.json')), false);
      const created = await createPiSession({
        workspaceDir: directory, sessionsDir: path.join(directory, 'sessions'), config: {}, timeoutMs: 60000,
        environment,
        proxyInfo: { baseUrl: 'http://127.0.0.1:1', token: 'test' }, summaryEnabled: false,
        activeTools: payload.active_tools, createTools: payload.create_tools, fixedToolList: payload.fixed_tool_list,
        beforeToolCall: payload.before_tool_call, jsonValidationSchemas: payload.json_validation_schemas, baseline,
      });
      creates++;
      const gate = name => created.session.agent.beforeToolCall({ toolCall: { name }, args: {} });
      const requestShapes = new Set();
      const gateChecks = [];
      const sessionId = created.session.sessionId;
      const sessionFile = created.sessionFile;
      let current = { stage: payload.initial_stage, prompt: payload.prompt };
      try {
        assert.deepEqual(created.snapshot.active_tools, payload.active_tools, '首次请求仅允许编排工具');
        assert.ok(created.session.getActiveToolNames().includes('generate-sections'), '固定工具清单一次注册全部阶段工具');
        await assert.rejects(gate('generate-sections'), /当前阶段不能调用 generate-sections/);
        assert.throws(() => payload.before_tool_call({ toolCall: { name: 'generate-sections' }, args: {} }), /基础编排尚未完成/);
        assert.equal(Object.hasOwn(payload, 'before_file_write'), false, '写入不在工具层拦截');
        assert.equal(Object.hasOwn(payload, 'auto_validate_json'), false, '结果在提交时统一校验');
        assert.ok(baseline.files(BASELINE_GROUPS.sections).includes('正文/旧小节.html'), '新一轮开始登记已有小节');
        assert.equal(payload.buildRetryPrompt({ kind: 'execution', error: new Error('编排错误') }, { attempt: 1, max_retries: 1 }), null, '编排执行失败沿用不自动重试');
        assert.match(payload.buildRetryPrompt({ kind: 'submission', mode: 'repair', report: { issues: [{ severity: 'blocking', message: '编排格式错误' }] } }, { workspace_dir: directory }),
          /本次结果文件：正文编排结果.json[\s\S]*重新提交/, '编排提交校验不通过时退回修复');
        created.session.agent.streamFn = (_model, context) => {
          const turn = promptTurns[current.stage] = (promptTurns[current.stage] || 0) + 1;
          requestShapes.add(JSON.stringify({ system: context.systemPrompt, tools: context.tools.map(tool => tool.name) }));
          let call;
          const complete = (name, args) => ({ type: 'toolCall', id: current.stage + '-' + turn, name, arguments: { ...args, task_complete: true } });
          if (current.stage === 'content-planning') {
            assert.equal(turn, 1);
            call = complete('write', { path: '正文编排结果.json', content: JSON.stringify(planningResult) });
          } else {
            assert.ok(JSON.stringify(context.messages).includes('基础编排历史标记'), '后续模型请求保留编排历史');
            // 正文生成分两次写入任务文件后提交，格式补写先写任务文件；其余阶段不得额外请求模型。
            assert.ok(turn <= ({ generating: 4, 'layout-checking': 3 })[current.stage] || turn <= 2, '不得为交接或程序检测额外请求模型');
            const targets = JSON.parse(fs.readFileSync(path.join(directory, '正文编排决策.json'), 'utf8')).targets;
            if (current.stage === 'generating') {
              gateChecks.push(gate('generate-sections'));
              assert.equal(targets[0].content_plan.target_words, 900, '执行清单采用程序校正结果');
              assert.ok(current.prompt.includes(`"target_sections":${targets.length}`), '交接只内嵌执行摘要和统计数');
              assert.ok(targets.every(section => !current.prompt.includes(section.id)), '随小节数增长的目标列表不进入提示词');
              assert.match(current.prompt, /基础编排已由程序处理并保存/);
              assert.doesNotMatch(current.prompt, /目录变更后的局部生成任务/);
              // 模型分两次写入任务文件：先 write 首项，再 edit 追加其余项，每次都是完整有效 JSON。
              const jobs = targets.map(section => ({ section_id: section.id, instructions: '', references: '' }));
              const first = JSON.stringify({ sections: jobs.slice(0, 1) }, null, 2);
              const rest = jobs.slice(1).map(job => `    ${JSON.stringify(job)}`).join(',\n');
              call = turn === 1
                ? { type: 'toolCall', id: 'task-write', name: 'write', arguments: { path: '任务/正文生成.json', content: first } }
                : turn === 2
                  ? { type: 'toolCall', id: 'task-edit', name: 'edit', arguments: { path: '任务/正文生成.json', edits: [{ oldText: '\n  ]\n}', newText: `,\n${rest}\n  ]\n}` }] } }
                  : turn === 3
                    ? { type: 'toolCall', id: 'generate', name: 'generate-sections', arguments: {} }
                    : complete('write', { path: payload.output_file, content: JSON.stringify({ sections: targets.map(section => ({ section_id: section.id, file: section.file, words: 1 })) }) });
            } else if (current.stage === 'auditing') {
              // 审计阶段主 Agent 可直接修改少量小节，结果在提交时校验。
              payload.before_tool_call({ toolCall: { name: 'edit' }, args: { path: targets[0].file } });
              payload.before_tool_call({ toolCall: { name: 'write' }, args: { path: '任务/一致性修复.json' } });
              call = complete('complete-consistency-round', { summary: '无冲突', remaining_issues: [] });
            } else if (current.stage === 'table-cleaning') {
              call = complete('complete-table-cleanup', {});
            } else {
              assert.equal(current.stage, 'layout-checking');
              gateChecks.push(assert.rejects(gate('generate-sections'), /当前阶段不能调用/),
                created.session.agent.beforeToolCall({ toolCall: { name: 'write' }, args: { path: '任务/格式补写.json' } }));
              // 文件修改不在写入时拦截，补写结果在提交时校验。
              payload.before_tool_call({ toolCall: { name: 'write' }, args: { path: targets[0].file } });
              payload.before_tool_call({ toolCall: { name: 'write' }, args: { path: '任务/格式补写.json' } });
              call = turn === 1
                ? { type: 'toolCall', id: 'layout-task', name: 'write', arguments: { path: '任务/格式补写.json', content: JSON.stringify({ section_ids: [targets[0].id] }) } }
                : turn === 2
                  ? { type: 'toolCall', id: 'supplement', name: 'supplement-layout-sections', arguments: {} }
                  : complete('complete-layout-supplement', {});
            }
          }
          const stream = piAi.createAssistantMessageEventStream();
          stream.push({ type: 'done', reason: 'toolUse', message: { role: 'assistant', stopReason: 'toolUse', content: [call],
            api: 'openai-completions', provider: 'yibiao', model: 'default', timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
          return stream;
        };
        while (!current.complete) {
          phases.push(current.stage);
          // 每个阶段均通过真实工具执行命令，在中文路径保存并读取临时结果。
          for (const name of NATIVE_AGENT_TOOLS) {
            assert.ok(created.session.getActiveToolNames().includes(name), `${current.stage}: ${name} 已启用`);
            await created.session.agent.beforeToolCall({ toolCall: { name }, args: { path: '任务/格式补写.json' } });
          }
          const script = `const fs = require('node:fs'); fs.mkdirSync('临时处理', { recursive: true }); fs.writeFileSync('临时处理/阶段.txt', '${current.stage}', 'utf8'); console.log(fs.readFileSync('临时处理/阶段.txt', 'utf8'));`;
          const command = `node -e "eval(Buffer.from('${Buffer.from(script).toString('base64')}', 'base64').toString('utf8'))"`;
          const commandResult = await created.session.agent.state.tools.find(tool => tool.name === 'bash').execute(`command-${current.stage}`, { command });
          assert.ok(!commandResult.isError, JSON.stringify(commandResult));
          assert.equal(fs.readFileSync(path.join(directory, '临时处理/阶段.txt'), 'utf8'), current.stage);
          await created.session.prompt(current.prompt);
          await Promise.all(gateChecks.splice(0));
          const toolResults = created.session.messages.filter(message => message.role === 'toolResult');
          assert.ok(toolResults.every(message => !message.isError), JSON.stringify(toolResults.filter(message => message.isError)));
          const assistant = created.session.messages.findLast(message => message.role === 'assistant');
          assert.notEqual(assistant?.stopReason, 'error', assistant?.errorMessage);
          assert.equal(created.session.sessionId, sessionId);
          assert.equal(created.sessionFile, sessionFile);
          const context = { workspace_dir: directory, workflow_stage: current.stage, signal, onActivity() {}, writeFiles, baseline };
          const report = await payload.validateOutput({}, context);
          assert.deepEqual(report.issues, [], '当前阶段的实际产物通过验收');
          context.validation_result = report.value;
          context.accepted_issues = [];
          const previousStage = current.stage;
          current = await payload.continueTask({}, context);
          await current?.await_before_prompt;
          // 进入读写量大的审计、去表格和格式补写前压缩历史；编排交接正文不压缩。
          if (!current.complete) assert.equal(current.compact_before_prompt === true, current.stage !== 'generating', `${previousStage}->${current.stage}`);
          if (current.compact_before_prompt) assert.equal(current.compaction_optional, true);
        }
        assert.equal(requestShapes.size, 1, '全部阶段的 system prompt 与 tools 保持不变');
        return { workspace_dir: directory, validation_result: inspectContentArtifacts(directory).result };
      } finally { created.session.dispose(); }
    },
  };
  const result = await runContentGenerationAgent({
    agentService: service, aiService: {
      async chat(request) {
        if (!request.logTitle.startsWith('一致性核对')) writerRequests.push(request);
        return '<!-- yibiao:block --><p>落实岗位责任与交付要求。</p>';
      },
      // 小节并发核对是审计前的程序步骤，不增加主会话模型请求。
      async requestJson(request) { consistencyChecks.push(request); return { issues: [], facts: [] }; },
    },
    signal, hasKnowledgeBase: false, hasOriginalPlan: false,
    planning: { prompt: '基础编排历史标记：落实责任。', files: [], outputFile: '正文编排结果.json', schema: { type: 'object' },
      validate: content => ({ value: JSON.parse(content), issues: [] }),
      complete(result) { assert.deepEqual(result, planningResult); plans[fileOptions.targets[0].item.id].plan.target_words = 900; },
    },
    async prepareGeneration() {
      builds++;
      return buildContentGenerationFiles({ ...fileOptions, plans, documentIds: [], generationOptions: { imageQuantity: 0, tableRequirement: 'none' } });
    },
    async checkLayout(result, layout) {
      checks++;
      const target = result.sections[0];
      if (!layout.get()) layout.save({ status: 'supplementing', jobs: [{ section_id: target.section_id, file: target.file, gaps: [] }], completed_section_ids: [] });
      else { assert.equal(layout.get().status, 'rechecking'); layout.save({ ...layout.get(), status: 'completed', remaining_gaps: [] }); }
    },
  });
  assert.deepEqual(phases, ['content-planning', 'generating', 'auditing', 'table-cleaning', 'layout-checking']);
  assert.equal(mainCalls, 1);
  assert.equal(creates, 1);
  assert.equal(builds, 1);
  assert.equal(checks, 2);
  assert.equal(state.layout_check.status, 'completed');
  const [warmup, ...sectionRequests] = writerRequests;
  assert.equal(warmup.output_token_limit, 1, '多节并发前先预热公共前缀');
  assert.equal(sectionRequests.length, fileOptions.targets.length);
  assert.equal(consistencyChecks.length, fileOptions.targets.length, '进入审计前逐节并发核对');
  assert.match(sectionRequests[0].messages[1].content, /"target_words": 900/);
  assert.equal(result.sections.length, fileOptions.targets.length);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, '程序清单/格式补写任务.json'), 'utf8')).status, 'completed', '格式补写任务清单随状态写入程序清单');
  // 本轮目标交给 Agent 修改，其他已有小节与台账保持登记；被改动的在提交校验前还原。
  const protectedSections = baseline.files(BASELINE_GROUPS.sections);
  assert.deepEqual(protectedSections, ['正文/旧小节.html']);
  assert.ok(baseline.files(BASELINE_GROUPS.ledger).includes('正文一致性事实台账.md'), '程序生成的台账登记保护');
  fs.writeFileSync(path.join(directory, '正文/旧小节.html'), '<p>被改动</p>', 'utf8');
  fs.rmSync(path.join(directory, '正文一致性事实台账.md'));
  assert.deepEqual(baseline.restore().sort(), ['正文/旧小节.html', '正文一致性事实台账.md'].sort());
  assert.equal(fs.readFileSync(path.join(directory, '正文/旧小节.html'), 'utf8'), '<!-- yibiao:block --><p>上一轮正文</p>');
  assert.ok(fs.existsSync(path.join(directory, '正文一致性事实台账.md')));
  console.log('真实 Pi 单次主调用：空输入注册、编排校正后生成（分批写入任务文件后提交）、审计/去表格/格式补写、同一 Session 多阶段及原历史保留通过。');
}

// 核对清单去重、启动快照及资料索引；统计不改变任何原编排。
function checkExecutionManifest(fileOptions) {
  const leaf = (id, content_mode = 'ai-generate') => ({ id, number: id, title: id, description: '说明', content_mode });
  const items = ['pending', 'unset', 'complete', 'failed'].map(id => leaf(id));
  const outline = [{ ...leaf('parent'), children: [...items, leaf('manual', 'manual-fill')] }];
  const plans = Object.fromEntries(items.map((item, index) => [item.id, { plan: {
    writing_focus: '重点-' + item.id, target_words: index === 1 ? 0 : 1000,
    image_needed: index === 0, image_suitability_score: 8,
    table: { needed: index === 1, purpose: index === 1 ? '措施' : '' }, knowledge: { item_ids: [] },
  } }]));
  const snapshot = JSON.stringify({ outline, plans });
  for (const documentIds of [[], fileOptions.documentIds]) {
    const files = buildContentGenerationFiles({ ...fileOptions, outline, plans, documentIds,
      targets: items.slice(0, 2).reverse().map(item => ({ item })),
      sectionStates: { pending: { status: 'success' }, complete: { status: 'success' }, failed: { status: 'error' },
        manual: { status: 'success' }, parent: { status: 'success' }, deleted: { status: 'success' } },
    });
    const input = JSON.parse(files.find(file => file.path === '正文编排决策.json').content);
    assert.equal(input.outline, undefined, '执行清单不再重复包含完整目录');
    assert.deepEqual(input.targets.map(section => section.id), ['pending', 'unset'], '仍按目录顺序提供本轮目标');
    assert.deepEqual(input.execution_summary, { total_ai_sections: 4, target_sections: 2, completed_before_run: 1,
      target_words: 1000, unspecified_word_target_sections: 1, image_candidate_ids: ['pending'], table_section_ids: ['unset'] });
    assert.deepEqual(input.completed_sections, [{ id: 'complete', number: 'complete', title: 'complete', file: '正文/complete.html' }]);
    assert.deepEqual(input.image_layout_quota, { total_groups: 1, single: 1, imageText: 0, threeImages: 0, fourImages: 0 });
    const reference = JSON.parse(files.find(file => file.path === input.reference_files.outline).content).outline;
    for (const item of reference[0].children) {
      if (['pending', 'unset'].includes(item.id)) assert.equal(item.content_plan, undefined, '目标编排只保存一份');
      if (['complete', 'failed'].includes(item.id)) assert.deepEqual(item.content_plan, plans[item.id].plan, '非目标已有编排仍可按需参考');
    }
    const filePaths = new Set(files.map(file => file.path));
    for (const file of Object.values(input.reference_files)) assert.ok(filePaths.has(file), '索引必须指向本轮提供的文件：' + file);
    assert.equal(Boolean(input.reference_files.knowledge_index), documentIds.length > 0);
    assert.equal(JSON.stringify({ outline, plans }), snapshot, '不能改写原目录和编排');
  }
  const emptyFiles = buildContentGenerationFiles({ ...fileOptions, outline, plans, targets: [], documentIds: [],
    generationOptions: { ...fileOptions.generationOptions, imageQuantity: 0 } });
  const empty = JSON.parse(emptyFiles.find(file => file.path === '正文编排决策.json').content);
  assert.equal(empty.execution_summary.target_words, 0);
  assert.equal(empty.execution_summary.target_sections, 0);
  assert.equal(empty.image_layout_quota.total_groups, 0);
  assert.deepEqual(empty.execution_summary.image_candidate_ids, []);
  console.log('执行清单：目标去重、统计、完成快照、目录参考和资料索引检查通过。');
}

// 经实际输入构建检查布局名额、确定性取整和本轮目标范围，不调用模型。
function checkImageLayoutQuota(fileOptions) {
  const items = Array.from({ length: 12 }, (_, index) => ({ id: `layout-${index}`, number: String(index + 1), title: '配图小节', content_mode: 'ai-generate' }));
  const plans = Object.fromEntries(items.map(item => [item.id, { plan: { image_needed: true } }]));
  const quota = overrides => JSON.parse(buildContentGenerationFiles({ ...fileOptions, outline: items, plans,
    targets: items.map(item => ({ item })), documentIds: [], ...overrides,
  }).find(file => file.path === '正文编排决策.json').content).image_layout_quota;
  for (const [count, mode, expected] of [
    [0, 30, [0, 0, 0, 0]], [1, 30, [1, 0, 0, 0]], [2, 30, [2, 0, 0, 0]],
    [3, 30, [2, 1, 0, 0]], [7, 30, [6, 1, 0, 0]], [10, 30, [8, 2, 0, 0]],
    [1, 60, [1, 0, 0, 0]], [2, 60, [1, 1, 0, 0]], [5, 60, [2, 2, 1, 0]],
    [7, 60, [3, 2, 1, 1]], [10, 60, [4, 3, 2, 1]],
    [10, 10, [10, 0, 0, 0]], [10, 20, [8, 2, 0, 0]],
    [10, 40, [5, 3, 2, 0]], [10, 50, [5, 3, 2, 0]],
    ...[70, 80, 90, 100].map(ratio => [10, ratio, [4, 3, 2, 1]]),
  ]) {
    const result = quota({ targets: items.slice(0, count).map(item => ({ item })),
      generationOptions: { ...fileOptions.generationOptions, imageQuantity: mode } });
    assert.deepEqual(result, { total_groups: count, single: expected[0], imageText: expected[1], threeImages: expected[2], fourImages: expected[3] });
  }
  const zero = { total_groups: 0, single: 0, imageText: 0, threeImages: 0, fourImages: 0 };
  assert.deepEqual(quota({ generationOptions: { ...fileOptions.generationOptions, imageQuantity: 0 } }), zero);
  assert.deepEqual(quota({ generationOptions: { imageQuantity: 60, useAiImages: false, useHtmlImages: false, useMermaidImages: false } }), zero);
  for (const enabledType of ['useAiImages', 'useHtmlImages', 'useMermaidImages']) {
    const result = quota({ generationOptions: { imageQuantity: 60, [enabledType]: true },
      targets: items.slice(0, 3).map(item => ({ item })),
      plans: { ...plans, 'layout-1': { plan: { image_needed: false } }, 'layout-2': { plan: {} } } });
    assert.deepEqual(result, { total_groups: 1, single: 1, imageText: 0, threeImages: 0, fourImages: 0 });
  }
  console.log('布局名额：全部百分比档位、余数和同分取整、零名额、类型开关及局部目标检查通过。');
}

// 三种事实模式经真实输入构建与工具调用传给并发写作和一致性修复，不依赖主 Agent 手动转述。
async function checkFactsRequirements({ Type, workspaceDir, fileOptions, signal }) {
  for (const [mode, expected] of [['fabricate', /允许结合项目背景补充设定/], ['omit', /不依赖未知具体值的概括性表述/], ['placeholder', /以“【待填写】”标记/]]) {
    const directory = path.join(workspaceDir, `事实模式-${mode}`);
    const checkTotalWords = mode !== 'omit';
    const files = buildContentGenerationFiles({ ...fileOptions, globalFactsMode: mode, checkTotalWords,
      globalFacts: [{ title: '班次', content: '岗位实行四班三运转。' }, { title: '维修时限', content: '故障维修时限为两小时。' }],
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
    const facts = files.find(file => file.path === '全局事实设定.md').content;
    assert.equal(decisions.global_facts_mode, mode);
    assert.match(decisions.global_facts_requirements, expected);
    assert.match(decisions.global_facts_requirements, /不得覆盖或改变全局事实/);
    const wordScope = checkTotalWords ? /由主 Agent 统一检查总字数/ : /本次仅统计目标小节字数，不承担全文字数达标/;
    assert.match(decisions.word_requirements, wordScope);
    const sectionHtml = '<!-- yibiao:block -->\r\n<p id="facts">项目实施内容</p>';
    let generated = false;
    let edited = false;
    let generatedPrompt;
    const tools = taskTools(createContentGenerationTools({ signal,
      consistency: { get: () => ({ status: 'running' }), save() {} },
      aiService: { async chat(request) {
        assert.ok(request.messages[0].content.includes(decisions.global_facts_requirements));
        assert.equal(request.messages[1].content.split(facts).length - 1, 1, '参考摘录为空时仍提供全部事实分组');
        assert.match(request.messages[0].content, /写作内容和全局事实不冲突即可，不要求完全引用全局事实/);
        assert.match(request.messages[0].content, /不为覆盖全局事实增加无关段落/);
        assert.ok(request.messages[0].content.includes(imageTypes), '并发正文模型必须收到工作区对照表全文');
        assert.match(request.messages[1].content, wordScope);
        assert.match(request.messages[1].content, /target_words.*750/s);
        assert.match(request.messages[0].content, /按本节 content_plan.target_words 的目标字数生成正文/);
        assert.match(request.messages[0].content, /没有文件检索或图片生成工具，仅核对本次请求提供的材料/);
        generatedPrompt = request.messages[1].content;
        assert.equal(generatedPrompt.split(JSON.stringify(decisions.targets[0], null, 2)).length - 1, 1, '完整小节编排由程序直接提供一次');
        assert.ok(generatedPrompt.includes(files.find(file => file.path === '项目概述.md').content));
        assert.ok(generatedPrompt.includes(files.find(file => file.path === '正文模板.html').content));
        assert.ok(request.messages[0].content.includes(files.find(file => file.path === '受限HTML生成规范.md').content));
        generated = true;
        return mode === 'fabricate' ? sectionHtml : `正文说明\r\n\`\`\`${mode === 'omit' ? 'html' : ''}\r\n${sectionHtml}\r\n\`\`\`\r\n总结说明`;
      } },
      agentService: { async runTask(request) {
        assert.ok(request.prompt.includes(decisions.global_facts_requirements));
        assert.match(request.prompt, /不扩大本次编辑范围/);
        edited = true;
      } },
    }, { Type, workspaceDir: directory }), directory);
    const params = { sections: [{ section_id: decisions.targets[0].id, instructions: '补充实施措施' }] };
    const generate = tools.find(tool => tool.name === 'generate-sections');
    // 空指令仍接收完整编排；配图和纠错只作为补充原样传入，不截断或过滤。
    for (const instructions of ['', '配图：single 1组，组织架构图，htmlImage，表达负责人和专业组的职责关系。', '纠错：上次返回 Markdown，请输出有效受限 HTML。']) {
      const references = instructions ? '补充资料《实施记录》：现场有两个交接点。' : '';
      const generatedResult = await generate.execute('generate', { sections: [{ section_id: decisions.targets[0].id, instructions, references, regenerate: true }] });
      assert.equal(generatedResult.details.results[0].status, 'success');
      assert.ok(generatedPrompt.includes(`本节配图安排与补充要求：\n${instructions || '无补充要求，未分配新增配图；已有原图按本节底稿要求保留。'}`));
      assert.ok(generatedPrompt.includes(`补充参考资料摘录：\n${references || '未提供'}`));
    }
    assert.equal(fs.readFileSync(path.join(directory, decisions.targets[0].file), 'utf8'), sectionHtml, '正文入口只保存提取后的 HTML，内部换行保持原样');
    assert.equal(tools.some(tool => tool.name === 'adjust-sections'), false);
    const editedResult = await tools.find(tool => tool.name === 'repair-sections').execute('repair', params);
    assert.equal(editedResult.details.results[0].status, 'success');
    assert.ok(generated && edited);
    const rules = files.find(file => file.path === '受限HTML生成规范.md').content;
    assert.match(rules, /square 为 1:1.*wide 为 3:2.*tall 为 3:4.*panorama 为 16:9/);
    assert.match(rules, /省略时 Word 转换默认按 cover/);
    assert.match(rules, /需要完整保留的原方案图片应明确使用 contain/);
    assert.match(rules, /流程图使用 flowchart，思维导图使用 mindmap，实体关系图使用 erDiagram/);
    // 批量工具不再接收数组参数，字段规则写在工具说明中，结构由任务文件 Schema 校验。
    const imageTool = tools.find(tool => tool.name === 'generate-section-images');
    assert.deepEqual(imageTool.parameters.properties, {});
    assert.deepEqual(TASK_FILE_SCHEMAS.images.properties.images.items.allOf[0].then.required, ['size', 'style']);
    assert.match(imageTool.description, /逐图依据正文 data-yb-size.*768x1024/);
    assert.match(imageTool.description, /保留与正文画框一致的宽高比例及构图方向/);
    assert.match(rules, /size 必填.*768x1024/);
    assert.match(rules, /本轮待生成的 AI、HTML、Mermaid 图片写入 任务\/配图生成\.json/);
  }
  console.log('事实模式：三种中文要求、并发正文与一致性修复传递，以及图片比例、裁剪和尺寸说明检查通过。');
}

// 保存时校验结构：写作输出、提交结果清单及进入字数检查前发现问题均退回 Agent，仅转换 Word 的读取不受影响。
async function checkSectionStructureGate({ Type, workspaceDir, fileOptions, signal }) {
  const directory = path.join(workspaceDir, '结构校验');
  const files = buildContentGenerationFiles({ ...fileOptions, documentIds: [] });
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(directory, file.path)), { recursive: true });
    fs.writeFileSync(path.join(directory, file.path), file.content, 'utf8');
  }
  const targets = JSON.parse(files.find(file => file.path === '正文编排决策.json').content).targets;
  const unclosed = '<!-- yibiao:block -->\n<p>正文</p>\n<figure id="cut" data-yb-generation="htmlImage" data-yb-size="wide"><template data-yb-role="prompt">流程</template><img alt="流程"><figcaption>截断';
  let output = unclosed;
  const requests = [];
  const tools = taskTools(createContentGenerationTools({ signal, aiService: { async chat(request) {
    requests.push(request);
    return output;
  } } }, { Type, workspaceDir: directory }), directory);
  const generate = tools.find(tool => tool.name === 'generate-sections');
  const rejected = await generate.execute('unclosed', { sections: [{ section_id: targets[0].id, instructions: '', references: '' }] });
  assert.equal(requests[0].reject_truncated_output, true, '写作请求拒收被截断的回复');
  assert.match(requests[0].messages[0].content, /每个 figure 以 <\/figure> 结束并直接包含一个 img/);
  assert.equal(rejected.details.results[0].status, 'error');
  assert.match(rejected.details.results[0].error, /HTML 结构不完整.*第 3 行<figure id="cut"> 缺少结束标签 <\/figure>/);
  assert.equal(fs.existsSync(path.join(directory, targets[0].file)), false, '结构不完整的正文不落盘');

  // 提示词结束标签被写成工具调用标记时程序无损补齐后保存；正文中途出现异常标记则拒收，交回主 Agent 重写。
  const marker = '</｜｜DSML｜｜ parameter>';
  output = `<!-- yibiao:block -->\n<p>正文</p>\n<figure id="marked" data-yb-generation="htmlImage" data-yb-size="wide"><template data-yb-role="prompt">流程${marker}\n<img alt="流程"><figcaption>图注</figcaption></figure>\n<!-- yibiao:block -->\n<p>图后正文</p>`;
  const closed = await generate.execute('marker', { sections: [{ section_id: targets[0].id, instructions: '', references: '' }] });
  assert.equal(closed.details.results[0].status, 'success');
  assert.equal(fs.readFileSync(path.join(directory, targets[0].file), 'utf8'), output.replace(marker, '</template>'), '只补齐提示词结束标签，其余内容不变');
  fs.rmSync(path.join(directory, targets[0].file));
  output = `<!-- yibiao:block -->\n<p>抚育施工与人${marker}\n</｜｜DSML｜｜ invoke>`;
  const interrupted = await generate.execute('interrupted', { sections: [{ section_id: targets[0].id, instructions: '', references: '' }] });
  assert.equal(interrupted.details.results[0].status, 'error');
  assert.match(interrupted.details.results[0].error, /HTML 结构不完整.*第 2 行出现异常结束标记/);
  assert.equal(fs.existsSync(path.join(directory, targets[0].file)), false, '中途中断的正文不落盘');

  output = '<!-- yibiao:block -->\n<p>结构完整的正文</p>';
  await generate.execute('valid', { sections: targets.map(section => ({ section_id: section.id, instructions: '', references: '' })) });
  fs.writeFileSync(path.join(directory, '正文生成结果.json'), JSON.stringify({ sections: targets.map(section => ({ section_id: section.id, file: section.file, words: 7 })) }), 'utf8');
  fs.appendFileSync(path.join(directory, targets[1].file), '\n<ul><li>列表未闭合', 'utf8');
  assert.equal(readContentGenerationResult(directory).sections.length, targets.length, '仅转换 Word 的读取不校验结构');
  assert.throws(() => readContentGenerationResult(directory, { checkStructure: true }), error => {
    assert.match(error.message, /<ul> 缺少结束标签/);
    assert.equal(error.issues[0].severity, 'blocking');
    assert.equal(error.issues.length, 1, '问题清单供退回次数判断进展');
    return true;
  });
  const listed = inspectContentArtifacts(directory).issues;
  assert.deepEqual(listed.map(item => [item.section_id, item.file, item.type, item.fixable]), [[targets[1].id, targets[1].file, 'structure', true]]);
  await assert.rejects(tools.find(tool => tool.name === 'check-word-count').execute(), new RegExp(`${targets[1].file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}：.*<ul> 缺少结束标签`));
  console.log('保存时结构校验：截断回复拒收、未闭合正文不落盘、提示词异常标记无损补齐、中途异常标记拒收、提交及字数检查前退回 Agent 并列出清单、转换读取不受影响。');
}

// 批量请求连续因服务端失败时停止派发剩余项并结束任务，已完成结果保留；暂停时队列丢弃的请求记为已中断，不触发服务端故障。
async function checkUpstreamFailureStop({ Type, workspaceDir, fileOptions, signal }) {
  const { markAiRequestError } = require('../electron/utils/aiRetry.cjs');
  const { createQueueScopePausedError } = require('../electron/utils/aiRequestQueue.cjs');
  const { AI_UPSTREAM_UNAVAILABLE } = require('../electron/utils/aiBatchGuard.cjs');
  const directory = path.join(workspaceDir, '服务端故障');
  const outline = Array.from({ length: 12 }, (_, index) => ({ id: `u${index + 1}`, number: `${index + 1}`, title: `批量${index + 1}`, content_mode: 'ai-generate' }));
  const files = buildContentGenerationFiles({ ...fileOptions, outline, targets: outline.map(item => ({ item })), plans: {}, generationOptions: { imageQuantity: 0 }, documentIds: [] });
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(directory, file.path)), { recursive: true });
    fs.writeFileSync(path.join(directory, file.path), file.content, 'utf8');
  }
  const targets = JSON.parse(files.find(file => file.path === '正文编排决策.json').content).targets;
  // 第 1 项成功，随后 10 项在服务端挂起后失败，最后 1 项等待本批停止。
  const upstreamService = output => {
    let calls = 0;
    return { chat(request) {
      if (request.logTitle.includes('公共前缀预热')) return Promise.resolve('');
      calls += 1;
      if (calls === 1) return Promise.resolve(output);
      if (calls <= 11) return new Promise((_resolve, reject) => setTimeout(() => reject(markAiRequestError(new Error('AI请求结算失败，请求已结束'), { retryable: false })), 20));
      return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
    } };
  };
  const tripped = [];
  const html = '<!-- yibiao:block -->\n<p>结构完整的正文</p>';
  const generate = taskTools(createContentGenerationTools({ signal, failTask: error => tripped.push(error), aiService: upstreamService(html) },
    { Type, workspaceDir: directory }), directory).find(tool => tool.name === 'generate-sections');
  const jobs = targets.map(section => ({ section_id: section.id, instructions: '', references: '' }));
  await assert.rejects(generate.execute('upstream', { sections: jobs }), error => error.code === AI_UPSTREAM_UNAVAILABLE && /连续 10 个请求失败.*最后一次错误：AI请求结算失败，请求已结束/.test(error.message));
  assert.deepEqual(tripped.map(error => error.code), [AI_UPSTREAM_UNAVAILABLE], '服务端故障直接结束任务，不交回 Agent');
  assert.equal(fs.readFileSync(path.join(directory, targets[0].file), 'utf8'), html, '已生成的小节保留');
  assert.equal(targets.slice(1).filter(section => fs.existsSync(path.join(directory, section.file))).length, 0);

  const pausedProgress = [];
  const paused = taskTools(createContentGenerationTools({ signal, failTask: error => tripped.push(error), onActivity: event => pausedProgress.push(...(event.progress?.items || [])),
    aiService: { chat: request => request.logTitle.includes('公共前缀预热') ? Promise.resolve('') : Promise.reject(createQueueScopePausedError()) } },
  { Type, workspaceDir: directory }), directory).find(tool => tool.name === 'generate-sections');
  await paused.execute('paused', { sections: jobs });
  assert.equal(pausedProgress.filter(item => item.status === 'error').length, 0);
  assert.equal(pausedProgress.filter(item => item.status === 'cancelled').length, 11, '暂停丢弃记为已中断，已生成小节跳过');
  assert.equal(tripped.length, 1, '暂停丢弃不计为服务端故障');

  const names = Array.from({ length: 12 }, (_, index) => `图${index + 1}`);
  const fixture = createImageFixture(directory, names);
  const png = { buffer: Buffer.from('图片'), width: 100, height: 80, layout_issues: [] };
  const renderer = { async renderHtmlToPng() { return png; }, async renderMermaidToPng() { return png; } };
  const imageTool = taskTools(createContentGenerationImageTools({ aiService: upstreamService('flowchart LR\nA["准备"] --> B["实施"]'), signal, localImageRenderService: renderer,
    sections: fixture.sections, failTask: error => tripped.push(error) }, { Type, workspaceDir: directory }), directory).find(tool => tool.name === 'generate-section-images');
  const output = await imageTool.execute('upstream-images', { images: names.map(name => ({ image_id: fixture.id(name), kind: 'mermaid', prompt: `${name}流程` })) });
  assert.deepEqual(tripped.map(error => error.code), [AI_UPSTREAM_UNAVAILABLE, AI_UPSTREAM_UNAVAILABLE]);
  assert.equal(output.details.cancelled, true);
  assert.deepEqual(output.details.results.map(item => item.status), ['success', ...Array(10).fill('error'), 'cancelled'], '本批结果保留后再结束任务');
  assert.ok(fixture.reference(names[0]), '已完成图片已回填');
  console.log('服务端连续失败：正文并发写作与批量配图停止派发并结束任务，已完成结果保留，暂停丢弃记为已中断。');
}

// 提交校验逐节汇总问题：图片块与保护开始时比对并附原始图片块，涉及小节较多时并发修复，子任务只改分配的小节。
async function checkSubmissionIssues({ Type, workspaceDir, signal }) {
  const { createContentImageProtection, formatImageBlocks } = require('../electron/services/contentGenerationEditTools.cjs');
  const directory = path.join(workspaceDir, '提交校验');
  for (const dir of ['正文', '图片']) fs.mkdirSync(path.join(directory, dir), { recursive: true });
  fs.writeFileSync(path.join(directory, '图片/甲.png'), '图片', 'utf8');
  fs.writeFileSync(path.join(directory, '受限HTML生成规范.md'), '受限规范', 'utf8');
  const targets = Array.from({ length: 7 }, (_item, index) => ({ id: `s${index + 1}`, number: `1.${index + 1}`, title: `小节${index + 1}`, file: `正文/s${index + 1}.html` }));
  fs.writeFileSync(path.join(directory, '正文编排决策.json'), JSON.stringify({ targets, global_facts_requirements: '按全局事实' }), 'utf8');
  fs.writeFileSync(path.join(directory, '正文生成结果.json'), JSON.stringify({ sections: targets.map(section => ({ section_id: section.id, file: section.file, words: 3 })) }), 'utf8');
  const figure = alt => `<figure id="f" data-yb-generation="aiImage" data-yb-size="wide"><template data-yb-role="prompt">示意</template><img alt="${alt}" data-yb-asset-ref="图片/甲.png"><figcaption>图注</figcaption></figure>`;
  const html = (text, alt = '原图') => `<!-- yibiao:block -->\n<p>${text}</p>\n${figure(alt)}`;
  const file = section => path.join(directory, section.file);
  for (const section of targets) fs.writeFileSync(file(section), html(`${section.id} 正文`), 'utf8');
  const records = {};
  const protection = createContentImageProtection({ workspaceDir: directory, files: targets.map(section => section.file),
    baseline: { saveRecord: (name, value) => { records[name] = value; }, loadRecord: name => records[name] || null } });
  assert.equal(protection.recorded(targets[0].file), null, '进入图片保护前不比对图片');
  protection.enter();
  const original = protection.recorded(targets[0].file).blocks;
  assert.equal(original.length, 1);
  assert.equal(readContentGenerationResult(directory, { checkStructure: true, imageProtection: protection }).sections.length, 7);

  // 6 个小节改动了图片，其中 s6 的图片文件引用失效，子任务无法处理。
  for (const section of targets.slice(0, 6)) fs.writeFileSync(file(section), html(`${section.id} 正文已修改`, '被改的图'), 'utf8');
  fs.writeFileSync(file(targets[5]), html('s6 正文').replace('图片/甲.png', '图片/丢失.png'), 'utf8');
  let submitted;
  assert.throws(() => readContentGenerationResult(directory, { checkStructure: true, imageProtection: protection }), error => {
    submitted = error;
    assert.equal(error.issues.length, 7);
    assert.ok(error.issues.every(item => item.severity === 'blocking'));
    return true;
  });
  const listed = submitted.issues;
  fs.mkdirSync(path.join(directory, '程序清单'), { recursive: true });
  fs.writeFileSync(path.join(directory, '程序清单/提交校验问题.json'), JSON.stringify({ issues: listed }), 'utf8');
  assert.deepEqual(listed.find(item => item.section_id === 's1').original_image_blocks, original, '清单附上保护开始时的原始图片块');
  assert.deepEqual(listed.filter(item => !item.fixable).map(item => [item.section_id, item.type]), [['s6', 'image-ref']]);

  // 并发修复：子任务按原始图片块恢复图片并保留文字修改；越界改动其他小节在批次结束后被还原。
  const dispatched = [];
  const agentService = { async runTask(payload) {
    const section = targets.find(item => item.file === payload.output_file);
    dispatched.push(section.id);
    assert.match(payload.prompt, /【原始图片块 1】/);
    assert.match(payload.prompt, /本小节启动时的完整 HTML/);
    assert.match(payload.prompt, /保留原有图片及引用、原表格、/, '去表格完成前保留原表格');
    if (section.id === 's2') {
      assert.equal(payload.validateOutput, undefined, '子任务不重复建立修复轮次');
      const inspected = inspectSectionArtifact(directory, section, { recordedImages: protection.recorded(section.file) });
      assert.deepEqual(inspected.issues.map(item => item.type), ['image-block']);
      assert.deepEqual(inspected.issues[0].original_image_blocks, original);
      fs.writeFileSync(file(targets[6]), '<p>子任务越界改动</p>', 'utf8');
    }
    const fixed = `<!-- yibiao:block -->\n<p>${section.id} 正文已修改</p>\n${original[0]}`;
    fs.writeFileSync(file(section), fixed, 'utf8');
    assert.deepEqual(inspectSectionArtifact(directory, section, { recordedImages: protection.recorded(section.file) }).issues, []);
    return {};
  } };
  const tools = createContentGenerationTools({ signal, agentService, aiService: {}, onActivity() {}, submissionOptions: () => ({ imageProtection: protection }) }, { Type, workspaceDir: directory });
  const fix = tools.find(tool => tool.name === 'fix-submission-issues');
  fs.writeFileSync(file(targets[0]), html('s1 正文已修改'), 'utf8');
  const fixedResult = await fix.execute('fix', {});
  const summary = JSON.parse(fixedResult.content[0].text);
  assert.deepEqual(dispatched.sort(), ['s2', 's3', 's4', 's5'], '已修好的小节跳过，子任务无法处理的不派发');
  assert.deepEqual([summary.total, summary.success, summary.skipped], [6, 4, 1]);
  assert.match(summary.unresolved[0].error, /子任务无法处理，请直接修复：正文引用的图片文件不存在/);
  assert.deepEqual(summary.restored_files, [targets[6].file]);
  assert.equal(fs.readFileSync(file(targets[6]), 'utf8'), html('s7 正文'), '本批以外的小节恢复为派发前内容');
  assert.equal(fs.readFileSync(file(targets[1]), 'utf8'), `<!-- yibiao:block -->\n<p>s2 正文已修改</p>\n${original[0]}`, '保留文字修改并恢复图片块');
  assert.match(formatImageBlocks([]), /删除新增的图片块/);

  // 剩余 1 个小节时由主 Agent 直接修改。
  assert.throws(() => readContentGenerationResult(directory, { checkStructure: true, imageProtection: protection }),
    error => error.issues.length === 2 && error.issues.every(item => item.section_id === targets[5].id));
  fs.writeFileSync(file(targets[5]), html('s6 正文'), 'utf8');
  assert.equal(readContentGenerationResult(directory, { checkStructure: true, imageProtection: protection }).sections.length, 7);

  // 去表格完成后仍有数据表格：子任务不再被要求保留原表格，留下表格时由主阶段报告质量问题。
  const table = '<table><tr><th>项目</th><th>数值</th></tr><tr><td>工期</td><td>60天</td></tr></table>';
  const withTable = section => `<!-- yibiao:block -->\n<p>${section.id} 正文</p>\n${table}\n${original[0]}`;
  const converted = section => `<!-- yibiao:block -->\n<p>${section.id} 正文</p>\n<p>项目工期为60天。</p>\n${original[0]}`;
  for (const section of targets.slice(0, 6)) fs.writeFileSync(file(section), withTable(section), 'utf8');
  const tableOptions = { imageProtection: protection, requireNoDataTables: true };
  assert.throws(() => readContentGenerationResult(directory, { checkStructure: true, ...tableOptions }), error => {
    assert.equal(error.issues.length, 6);
    assert.ok(error.issues.every(item => item.type === 'table' && item.severity === 'quality'));
    fs.writeFileSync(path.join(directory, '程序清单/提交校验问题.json'), JSON.stringify({ issues: error.issues }), 'utf8');
    return true;
  });
  const tableRejected = [];
  const tableTools = createContentGenerationTools({ signal, aiService: {}, onActivity() {}, submissionOptions: () => tableOptions, agentService: { async runTask(payload) {
    const section = targets.find(item => item.file === payload.output_file);
    assert.doesNotMatch(payload.prompt, /保留原有图片及引用、原表格、/);
    assert.match(payload.prompt, /保留原有图片及引用、表格中的全部数据和含义、/);
    assert.match(payload.prompt, /仍有数据表格，需要转换为段落或列表并保留全部信息/);
    assert.equal(payload.validateOutput, undefined, '表格质量由主阶段统一判断');
    const inspected = inspectSectionArtifact(directory, section);
    assert.deepEqual(inspected.issues, []);
    assert.equal(inspected.facts.has_data_tables, true);
    tableRejected.push(section.id);
    fs.writeFileSync(file(section), converted(section), 'utf8');
    assert.equal(inspectSectionArtifact(directory, section).facts.has_data_tables, false);
    return {};
  } } }, { Type, workspaceDir: directory });
  const tableSummary = JSON.parse((await tableTools.find(tool => tool.name === 'fix-submission-issues').execute('tables', {})).content[0].text);
  assert.deepEqual([tableSummary.total, tableSummary.success], [6, 6]);
  assert.deepEqual(tableRejected.sort(), ['s1', 's2', 's3', 's4', 's5', 's6'], '真实表格事实交由主阶段统一判断');
  assert.equal(readContentGenerationResult(directory, { checkStructure: true, ...tableOptions }).sections.length, 7);
  console.log('提交校验：逐节汇总问题与原始图片块、按小节数选择并发修复或直接修改、修复前复查跳过、子任务单次图片检查、越界改动还原、主阶段表格质量检查通过。');
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
  const files = buildContentGenerationFiles({ ...fileOptions, wordControl: {}, generationOptions: { tableRequirement: 'none', imageQuantity: 0 }, documentIds: [] });
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
  let checkingSubmissionFix = false;
  let submissionFixCalls = 0;
  const service = {
    hasPersistentTaskSession: () => true,
    loadPersistentTask: () => ({ state: savedState, paths: { workspaceDir } }),
    updatePersistentTask(_key, patch) { savedState = { ...savedState, ...structuredClone(patch) }; },
    async runTask(payload) {
      if (payload.primary_session) {
        const tools = payload.create_tools({ Type, workspaceDir, setActiveTools: names => { activeTools = names; } });
        await mainAction(payload, tools, () => payload.continueTask({}, submissionContext(payload, workspaceDir)));
        return { workspace_dir: workspaceDir, validation_result: submissionContext(payload, workspaceDir).validation_result };
      }
      assert.equal(payload.failure_handled_by_parent, true);
      if (checkingSubmissionFix) {
        submissionFixCalls++;
        assert.match(payload.prompt, /仍有数据表格，需要转换为段落或列表并保留全部信息/);
        assert.doesNotMatch(payload.prompt, /保留原有图片及引用、原表格、/);
        assert.equal(payload.validateOutput, undefined);
        return {};
      }
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
        activeTools: payload.active_tools, beforeToolCall: payload.before_tool_call,
      });
      try {
        const edit = created.session.agent.state.tools.find(tool => tool.name === 'edit');
        const file = path.join(workspaceDir, payload.output_file);
        const before = fs.readFileSync(file, 'utf8');
        // 写入不再拦截；共享产物检查发现图片表格被删，并附上派发时的原始图片块。
        await edit.execute('image', { path: payload.output_file, edits: [{ oldText: layouts, newText: '<p>图片已删除</p>' }] });
        assert.equal(payload.validateOutput, undefined, '编辑子任务只在返回父阶段后检查一次');
        const inspected = inspectSectionArtifact(workspaceDir, targets.find(section => section.file === payload.output_file), {
          recordedImages: { structure: require('../electron/services/contentGenerationEditTools.cjs').imageStructure(before), blocks: [layouts] },
        });
        assert.ok(inspected.issues.some(item => item.type === 'image-block' && item.original_image_blocks[0] === layouts));
        fs.writeFileSync(file, before, 'utf8');
        await edit.execute('table', { path: payload.output_file, edits: [{ oldText: table, newText: text }] });
        const html = fs.readFileSync(file, 'utf8');
        assert.equal(html, before.replace(table, text));
        assert.deepEqual(inspectSectionArtifact(workspaceDir, targets.find(section => section.file === payload.output_file)).issues, []);
      } finally { created.session.dispose(); }
      return {};
    },
  };
  const run = resume => runContentGenerationAgent({ agentService: service, aiService: consistencyAiService, resume, signal, buildFiles: () => files });
  const interrupted = new Error('模拟暂停主会话');
  mainAction = async (payload, rawTools, next) => {
    const tools = taskTools(rawTools, workspaceDir);
    const remove = tools.find(tool => tool.name === 'remove-section-tables');
    const finish = tools.find(tool => tool.name === 'complete-table-cleanup');
    await assert.rejects(remove.execute('early', { sections: [] }), /不在去表格/);
    const audit = await next();
    await audit.await_before_prompt;
    assert.equal(audit.stage, 'auditing');
    await tools.find(tool => tool.name === 'complete-consistency-round').execute('audit', { summary: '无冲突', remaining_issues: [] });
    assert.equal(next().stage, 'table-cleaning');
    assert.ok(activeTools.includes('remove-section-tables'));
    assert.ok(!activeTools.includes('check-word-count'));
    payload.before_tool_call({ toolCall: { name: 'edit' }, args: { path: targets[0].file } });
    await finish.execute();
    assert.equal(savedState.table_cleanup.status, 'running');
    const report = payload.validateOutput({}, { workspace_dir: workspaceDir });
    assert.equal(report.issues.length, targets.length);
    assert.ok(report.issues.every(item => item.type === 'table' && item.severity === 'quality'));
    // 去表格仍在运行时，并发修复也必须按当前阶段复查表格，不能错误跳过。
    payload.buildRetryPrompt({ kind: 'submission', mode: 'repair', report }, { workspace_dir: workspaceDir });
    checkingSubmissionFix = true;
    try {
      const fixed = await tools.find(tool => tool.name === 'fix-submission-issues').execute('submission-fix', {});
      assert.equal(submissionFixCalls, targets.length);
      assert.ok(fixed.details.results.every(item => item.status === 'success' && item.facts.has_data_tables));
      assert.equal(payload.validateOutput({}, { workspace_dir: workspaceDir }).issues.length, targets.length, '子任务真实残表继续由主报告判断');
    } finally { checkingSubmissionFix = false; }
    const batch = remove.execute('batch', { sections: targets.map(section => ({ section_id: section.id, instructions: '转成普通文字' })) });
    await startedGate;
    await assert.rejects(finish.execute(), /等待全部/);
    release();
    const batchResults = (await batch).details.results;
    assert.deepEqual(batchResults.map(item => item.status), ['error', 'success'], JSON.stringify(batchResults));
    assert.deepEqual(savedState.table_cleanup.completed_section_ids, [targets[1].id]);
    const progressList = JSON.parse(fs.readFileSync(path.join(workspaceDir, '程序清单/去表格进度.json'), 'utf8'));
    assert.deepEqual(progressList.pending_section_ids, [targets[0].id], '去表格进度写入程序清单');
    await finish.execute();
    assert.ok(payload.validateOutput({}, { workspace_dir: workspaceDir }).issues.some(item => item.type === 'table' && item.section_id === targets[0].id));
    throw interrupted;
  };
  await assert.rejects(run(false), error => error === interrupted);
  failFirst = false;
  mainAction = async (payload, rawTools, next) => {
    const tools = taskTools(rawTools, workspaceDir);
    assert.equal(payload.initial_stage, 'table-cleaning');
    assert.deepEqual(payload.files, []);
    assert.ok(payload.validateOutput({}, { workspace_dir: workspaceDir }).issues.some(item => item.type === 'table'));
    assert.match(payload.prompt, /已提交 2 个小节，已完成 1 个，尚未成功 1 个/);
    // 整份任务文件再次提交：已完成小节跳过，只重试失败小节。
    const result = await tools.find(tool => tool.name === 'remove-section-tables').execute('retry', { sections: targets.map(section => ({ section_id: section.id, instructions: '重试未完成小节' })) });
    assert.deepEqual(result.details.results.map(item => item.status), ['success', 'skipped']);
    assert.deepEqual(JSON.parse(result.content[0].text), { total: 2, success: 1, skipped: 1, unresolved: [] });
    // 去表格完成后不因字数不满足而返回扩缩写。
    decisions.word_control = { minimumWords: 999999, checkTotalWords: true };
    fs.writeFileSync(path.join(workspaceDir, '正文编排决策.json'), JSON.stringify(decisions), 'utf8');
    await tools.find(tool => tool.name === 'complete-table-cleanup').execute();
    assert.equal(next().complete, true);
    assert.throws(() => payload.before_tool_call({ toolCall: { name: 'remove-section-tables' }, args: {} }), /已经完成/);
    payload.before_tool_call({ toolCall: { name: 'edit' }, args: { path: targets[0].file } });
    // 去表格完成后提交时仍核对数据表格，重新出现的表格退回修复。
    payload.validateOutput({}, { workspace_dir: workspaceDir });
    const sectionPath = path.join(workspaceDir, targets[0].file);
    const converted = fs.readFileSync(sectionPath, 'utf8');
    fs.writeFileSync(sectionPath, `${converted}\n<!-- yibiao:block -->\n${table}`, 'utf8');
    try {
      assert.ok(payload.validateOutput({}, { workspace_dir: workspaceDir }).issues.some(item => item.type === 'table' && item.severity === 'quality' && item.section_id === targets[0].id));
    } finally { fs.writeFileSync(sectionPath, converted, 'utf8'); }
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
      for (const imageQuantity of Array.from({ length: 11 }, (_, index) => index * 10)) {
        let saved;
        const handler = new Function('draftIllustrationOptions', 'draftTableRequirement', 'imageModelAvailable', 'saveContentOptions', `${handlerCode}\nreturn handler;`)({ htmlImageTypes: '甘特图', useAiImages: false, useHtmlImages: false, useMermaidImages: false }, 'heavy', available, value => { saved = value; });
        handler({ target: { value: String(imageQuantity) } });
        assert.deepEqual(saved, { imageQuantity, htmlImageTypes: '甘特图', tableRequirement: 'heavy', useAiImages: imageQuantity > 0 && available, useHtmlImages: imageQuantity > 0, useMermaidImages: imageQuantity > 0 });
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
      outline, targets, plans: Object.fromEntries(targets.map(({ item }) => [item.id, { plan: { target_words: 750, writing_focus: '落实责任', knowledge: { item_ids: ['doc::k1'] }, table: { needed: false, purpose: '' }, image_needed: true, image_suitability_score: 8 } }])),
      generationOptions: { imageQuantity: 30, useAiImages: true, useHtmlImages: true, useMermaidImages: false, htmlImageTypes: '甘特图、风险矩阵' },
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
    checkExecutionManifest(fileOptions);
    await checkImageManifestTools({ Type, workspaceDir, signal });
    await checkRestoredContent({ Type, workspaceDir, fileOptions, signal });
    await checkFactsRequirements({ Type, workspaceDir, fileOptions, signal });
    await checkSectionStructureGate({ Type, workspaceDir, fileOptions, signal });
    await checkUpstreamFailureStop({ Type, workspaceDir, fileOptions, signal });
    await checkSubmissionIssues({ Type, workspaceDir, signal });
    await checkImageSourceGeneration({ Type, workspaceDir, signal });
    await checkImagePauseSession({ workspaceDir });
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
          assert.ok(request.messages[1].content.includes(noKnowledgeFiles.find(file => file.path === '全局事实设定.md').content));
          return '<!-- yibiao:block -->\n<p id="no_knowledge">具体实施措施</p>';
        } },
        agentService: {
          hasPersistentTaskSession: () => resume,
          loadPersistentTask: () => ({ state: {}, paths: { workspaceDir: noKnowledgeDir } }),
          updatePersistentTask() {},
          async runTask(payload) {
            assert.doesNotMatch(payload.prompt, /知识库|索引|编排知识条目/);
            assert.match(payload.prompt, /程序自动向每个小节写作请求提供全局事实设定.md的完整内容/);
            assert.match(payload.prompt, /直接使用已保存编排，不逐节重写写作重点或扩展详细提纲/);
            assert.match(payload.prompt, /没有新增配图和补充要求时 instructions 填空字符串/);
            assert.equal(payload.files.length, resume ? 0 : noKnowledgeFiles.length);
            const [tool] = taskTools(payload.create_tools({ Type, workspaceDir: noKnowledgeDir }), noKnowledgeDir);
            assert.doesNotMatch(tool.description, /知识库/);
            assert.match(tool.description, /完整全局事实由程序提供/);
            if (!resume) {
              const result = await tool.execute('without-knowledge', { sections: targets.map(({ item }) => ({ section_id: item.id, instructions: '', references: '' })) });
              assert.ok(result.details.results.every(section => section.status === 'success'));
              fs.writeFileSync(path.join(noKnowledgeDir, '正文生成结果.json'), JSON.stringify({ sections: result.details.results.map(({ section_id, file, words }) => ({ section_id, file, words })) }), 'utf8');
            }
            return { workspace_dir: noKnowledgeDir, validation_result: submissionContext(payload, noKnowledgeDir).validation_result };
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
    const referenceOutline = JSON.parse(files.find(file => file.path === input.reference_files.outline).content).outline;
    assert.equal(referenceOutline[1].content_mode, 'manual-fill');
    assert.equal(input.outline, undefined);
    assert.ok(referenceOutline[0].children.every(item => !Object.hasOwn(item, 'content_plan')));
    assert.match(input.word_requirements, /1000.*2000/);
    assert.match(input.word_requirements, /content_plan.target_words/);
    assert.equal(input.targets[0].content_plan.target_words, 750);
    assert.match(input.word_requirements, /由主 Agent 统一检查总字数/);
    assert.equal(input.targets[0].content_plan.image_suitability_score, 8);
    assert.match(input.image_requirements, /配图：按本轮布局名额/);
    assert.deepEqual(input.image_layout_quota, { total_groups: 2, single: 2, imageText: 0, threeImages: 0, fourImages: 0 });
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
      [0, true, /无图：不安排配图、不留图片占位、不调用配图工具/],
      [30, false, /配图：按本轮布局名额/], [30, false, /配图：按本轮布局名额/, true],
      [30, true, /配图：按本轮布局名额/], [60, true, /配图：按本轮布局名额/],
    ]) {
      const scenarioFiles = buildContentGenerationFiles({ ...fileOptions, generationOptions: { ...fileOptions.generationOptions, imageQuantity, useAiImages: enabled, useHtmlImages: otherEnabled, useMermaidImages: otherEnabled } });
      const decisionFile = scenarioFiles.find(file => file.path === '正文编排决策.json');
      const decisions = JSON.parse(decisionFile.content);
      assert.match(decisions.image_requirements, expected);
      assert.match(decisions.image_requirements, /不用于取消本轮名额/);
      assert.match(decisions.image_requirements, /分别按分配组数执行，不互换名额/);
      assert.doesNotMatch(decisions.image_requirements, /1～3|1～6|建议张数|张数范围仅作建议/);
      assert.match(decisions.image_requirements, /查阅配图类型对照表.md.*用途、结构相近.*仍无法归类时，使用 AI 生图/);
      if (!enabled && !otherEnabled) assert.match(decisions.image_requirements, /AI 图片（aiImage）不允许；HTML 图片（htmlImage）不允许；Mermaid 图片（mermaid）不允许/);
      if (enabled && imageQuantity > 0) {
        assert.match(decisions.image_requirements, /AI 图片目标占比为 60%/);
        assert.match(decisions.image_requirements, /优先从正文中寻找适合实物、场景、效果、物理结构、工艺、操作/);
        assert.match(decisions.image_requirements, /并发写作模型只执行本节分配，不独立承担占比目标/);
        assert.match(decisions.image_requirements, /AI 图片画面差异化：每张新增 AI 图片确定画面类型.*主体、视角景别.*画面形式/);
        assert.match(decisions.image_requirements, /按步骤拆分时同时变换景别和主体/);
        for (const { label } of Object.values(AI_IMAGE_STYLES)) assert.ok(decisions.image_requirements.includes(label), `画面形式缺少：${label}`);
      } else {
        assert.doesNotMatch(decisions.image_requirements, /AI 图片画面差异化/);
        assert.doesNotMatch(decisions.image_requirements, /60%/);
        assert.match(decisions.image_requirements, /本轮不应用 AI 图片占比目标/);
      }
      assert.doesNotMatch(decisions.image_requirements, /不规定必须使用的类型或比例/);
      fs.writeFileSync(path.join(workspaceDir, decisionFile.path), decisionFile.content, 'utf8');
      let received = false;
      const allocation = !decisions.image_layout_quota.total_groups ? '本节不新增配图'
        : imageQuantity >= 60 ? '本节布局：图片表格1组，操作示意图，表达施工阶段，生成方式 aiImage'
        : enabled ? '本节布局：单张图片1组，场景示意图，表达实施现场，生成方式 aiImage'
        : '本节布局：单张图片1组，甘特图，表达施工进度，生成方式 htmlImage';
      const scenarioTools = taskTools(createContentGenerationTools({ signal, aiService: { async chat(request) {
        received = true;
        assert.ok(request.messages[0].content.includes(decisions.image_requirements));
        assert.ok(request.messages[1].content.includes(allocation));
        assert.match(request.messages[0].content, /不自行分配全局名额/);
        assert.match(request.messages[0].content, /不自行改变生成方式/);
        assert.match(request.messages[0].content, /不自行分配全局名额或独立承担 AI 图片占比目标/);
        assert.ok(!JSON.stringify(request.messages).includes('"total_groups"'), '并发小节不接收整轮名额数值');
        return '<!-- yibiao:block -->\n<p id="scenario">项目实施内容</p>';
      } } }, { Type, workspaceDir }), workspaceDir);
      assert.deepEqual(scenarioTools.map(tool => tool.name), ['generate-sections', 'search-sections', 'recheck-sections', 'repair-sections', 'complete-consistency-round', 'remove-section-tables', 'complete-table-cleanup', 'check-word-count', 'list-section-images', 'apply-section-images', 'generate-section-images', 'render-html-image', 'render-mermaid-image', 'fix-submission-issues']);
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
    assert.ok(created.snapshot.active_tools.includes('generate-section-images'));
    assert.ok(!created.snapshot.active_tools.includes('generate-image-sources'));
    assert.ok(!created.snapshot.active_tools.includes('generate-image'));
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
    // 正文工具从正文编排决策读取目标，夹具写入第一个目标小节，检查结束后删除。
    const aiFixture = createImageFixture(workspaceDir, ['现场图', '甲', '乙', '丙'], input.targets[0]);
    const imageTool = taskTools(createContentGenerationTools({ aiService: imageService, signal }, { Type, workspaceDir }), workspaceDir).find(tool => tool.name === 'generate-section-images');
    const imageBatch = { images: [{ image_id: aiFixture.id('现场图'), kind: 'ai', ...imageParams }] };
    const imageOutput = await imageTool.execute('image', imageBatch);
    const savedImage = imageOutput.details.results[0];
    assert.deepEqual(savedImage, { image_id: aiFixture.id('现场图'), kind: 'ai', stage: 'complete', status: 'success', asset_ref: savedImage.asset_ref, applied: true }, '生图服务的本地路径和预览地址不写入模型上下文');
    assert.deepEqual(JSON.parse(imageOutput.content[0].text), { total: 1, applied: 1, skipped: 0, unresolved: [] });
    assert.equal(aiFixture.reference('现场图'), savedImage.asset_ref);
    assert.deepEqual(fs.readFileSync(path.join(workspaceDir, savedImage.asset_ref)), fs.readFileSync(imageResult.file_path));
    imageService.generateImage = async () => assert.fail('缺少尺寸时不得请求生图或使用默认方图');
    // 缺少或空白尺寸在任务文件校验时报错，不请求生图。
    for (const size of [undefined, '', '   ']) {
      await assert.rejects(imageTool.execute('image-missing-size', { images: [{ ...imageBatch.images[0], size, regenerate: true }] }), /size/);
    }
    imageService.generateImage = async () => assert.fail('缺少或非法画面形式时不得请求生图或使用默认风格');
    for (const style of [undefined, '', 'engineering_diagram']) {
      await assert.rejects(imageTool.execute('image-missing-style', { images: [{ ...imageBatch.images[0], style, regenerate: true }] }), /style/);
    }
    const styleSchema = TASK_FILE_SCHEMAS.images.properties.images.items;
    assert.ok(styleSchema.allOf[0].then.required.includes('style'), 'AI 图片 style 必填');
    assert.deepEqual(styleSchema.properties.style.enum, Object.keys(AI_IMAGE_STYLES));
    for (const style of Object.keys(AI_IMAGE_STYLES)) assert.ok(imageTool.description.includes(`${style}=`), `工具说明缺少画面形式：${style}`);
    // 风格说明只来自画面形式定义；未指定时不再追加默认工程图示风格。
    for (const [style, { hint }] of Object.entries(AI_IMAGE_STYLES)) assert.ok(buildImageStylePrompt('画面', style).includes(hint));
    assert.equal(buildImageStylePrompt('画面'), '画面\n\n避免出现品牌标识、水印、夸张营销元素和无关文字。');
    const htmlRules = fs.readFileSync(path.join(__dirname, '../electron/resources/content-generation/受限HTML生成规范.md'), 'utf8');
    for (const style of Object.keys(AI_IMAGE_STYLES)) assert.ok(htmlRules.includes(`${style}=`), `规范缺少画面形式：${style}`);
    const imageError = new Error('生图模型不可用');
    imageService.generateImage = async () => { throw imageError; };
    assert.deepEqual((await imageTool.execute('image-error', { images: [{ ...imageBatch.images[0], regenerate: true }] })).details.results,
      [{ image_id: aiFixture.id('现场图'), kind: 'ai', stage: 'generate', status: 'error', error: imageError.message }]);

    // 真实请求队列限制为 2：三张一起提交，乱序完成且一张失败，结果仍按标识对应。
    const { createAiRequestQueue } = require('../electron/utils/aiRequestQueue.cjs');
    const imageQueue = createAiRequestQueue({ getLimit: () => 2 });
    const imagePending = new Map();
    const imageRequests = [];
    imageService.generateImage = ({ signal: requestSignal, prompt, size }) => {
      imageRequests.push({ prompt, size });
      return imageQueue.enqueue(() => new Promise((resolve, reject) => imagePending.set(prompt, { resolve, reject })), { signal: requestSignal, maxAttempts: 1 });
    };
    const concurrentImages = { images: ['甲', '乙', '丙'].map((id, index) => ({ image_id: aiFixture.id(id), kind: 'ai', prompt: id, style: 'realistic_photo', size: ['768x1024', '1024x1024', '1536x1024'][index] })) };
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
    assert.deepEqual(batchResults.map(result => [result.image_id, result.status]), [[aiFixture.id('甲'), 'success'], [aiFixture.id('乙'), 'error'], [aiFixture.id('丙'), 'success']]);
    assert.deepEqual(['甲', '乙', '丙'].map(aiFixture.reference), [batchResults[0].asset_ref, undefined, batchResults[2].asset_ref], '乱序完成仍回填到各自图片');
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
      const cancellableTool = taskTools(createContentGenerationTools({ aiService: imageService, signal: taskCancel.signal }, { Type, workspaceDir }), workspaceDir).find(tool => tool.name === 'generate-section-images');
      const savedFiles = fs.readdirSync(path.join(workspaceDir, '图片'));
      const request = cancellableTool.execute('image-cancel', { images: concurrentImages.images.map(image => ({ ...image, regenerate: true })) }, toolCancel.signal);
      const reason = new Error('取消生图');
      (cancelTask ? taskCancel : toolCancel).abort(reason);
      assert.equal((await request).details.cancelled, true);
      assert.equal(cancelled, 3, '任务或工具取消须传递到整批图片');
      assert.deepEqual(fs.readdirSync(path.join(workspaceDir, '图片')), savedFiles, '取消后不得保存新图片或删除已有图片');
    }
    fs.unlinkSync(path.join(workspaceDir, input.targets[0].file));
    console.log('批量 AI 生图：真实队列并发上限、乱序结果、部分失败、单项重试及整批取消检查通过。');

    // 两种转图读取已有 UTF-8 源码，保留错误与取消行为，不调用文本模型。
    for (const kind of ['html', 'mermaid']) {
      const sourceFile = `图片/实施流程.${kind === 'html' ? 'html' : 'mmd'}`;
      const source = kind === 'html' ? '<div>实施流程</div>' : 'flowchart LR\nA["准备"] --> B["实施"]';
      fs.writeFileSync(path.join(workspaceDir, sourceFile), source, 'utf8');
      const renderer = {};
      const method = kind === 'html' ? 'renderHtmlToPng' : 'renderMermaidToPng';
      const pause = new AbortController();
      const renderFixture = createImageFixture(workspaceDir, ['实施图', '甲', '乙', '丙'], { id: `转图-${kind}`, file: `配图夹具/转图-${kind}.html` });
      const { sections, id } = renderFixture;
      const name = imageId => decodeURIComponent(imageId.split('/')[1]);
      const renderTool = taskTools(createContentGenerationImageTools({ htmlImageOptimization: true, aiService: {}, signal, localImageRenderService: renderer, sections }, { Type, workspaceDir }), workspaceDir).find(tool => tool.name === `render-${kind}-image`);
      const renderParams = { images: [{ image_id: id('实施图'), source_file: sourceFile, ...(kind === 'html' ? { frame_size: 'wide' } : {}) }] };
      const rerenderParams = { images: renderParams.images.map(image => ({ ...image, regenerate: true })) };
      assert.deepEqual(renderTool.parameters.properties, {});
      assert.equal(TASK_FILE_SCHEMAS[kind === 'html' ? 'renderHtml' : 'renderMermaid'].properties.images.items.required.includes('frame_size'), kind === 'html');
      renderer[method] = async (text, options) => {
        assert.equal(text, source);
        assert.equal(options.isPauseRequested(), false);
        assert.equal(options.frameSize, kind === 'html' ? 'wide' : undefined);
        return { buffer: Buffer.from('PNG'), width: 100, height: 80, layout_issues: [] };
      };
      const rendered = (await renderTool.execute('render', renderParams)).details.results[0];
      assert.equal(rendered.status, 'success');
      assert.equal(rendered.image_id, id('实施图'));
      assert.equal(rendered.applied, true);
      assert.equal(renderFixture.reference('实施图'), rendered.asset_ref, '转图成功后自动回填');
      assert.equal(rendered.width, 100);
      assert.equal(rendered.height, 80);
      assert.equal(rendered.source_file, sourceFile);
      assert.equal(fs.readFileSync(path.join(workspaceDir, rendered.asset_ref), 'utf8'), 'PNG');
      const renderError = new Error('模拟渲染错误');
      renderer[method] = async () => { throw renderError; };
      // 已有有效图片再次提交时跳过，需要重新转图时显式 regenerate。
      assert.equal((await renderTool.execute('skip', renderParams)).details.results[0].status, 'skipped');
      assert.equal((await renderTool.execute('error', rerenderParams)).details.results[0].error, renderError.message);
      assert.equal(fs.readFileSync(path.join(workspaceDir, sourceFile), 'utf8'), source);
      const savedFiles = fs.readdirSync(path.join(workspaceDir, '图片'));
      renderer[method] = async (_text, options) => {
        pause.abort(new Error('停止转图'));
        assert.equal(options.isPauseRequested(), true);
        assert.equal(options.createPauseError(), pause.signal.reason);
        return { buffer: Buffer.from('未完成图片') };
      };
      assert.equal((await renderTool.execute('cancel', rerenderParams, pause.signal)).details.results[0].status, 'cancelled');
      assert.deepEqual(fs.readdirSync(path.join(workspaceDir, '图片')), savedFiles, '取消后不得保存新图片');

      // 三项同时派发，乱序结束仍对应各自标识，部分失败保留成功项及布局反馈。
      const batchImages = ['甲', '乙', '丙'].map(image => ({ ...renderParams.images[0], image_id: id(image) }));
      const renderPending = [];
      renderer[method] = (_text, options) => new Promise((resolve, reject) => renderPending.push({ resolve, reject, options }));
      const batchRender = renderTool.execute('batch-render', { images: batchImages });
      assert.equal(renderPending.length, 3, '所有转图一次交给组件，由组件队列控制实际并发');
      renderPending[2].resolve({ buffer: Buffer.from('丙'), width: 300, height: 80, layout_issues: ['模拟布局问题'] });
      renderPending[1].reject(new Error('仅乙转图失败'));
      renderPending[0].resolve({ buffer: Buffer.from('甲'), width: 100, height: 80, layout_issues: [] });
      const batchResults = (await batchRender).details.results;
      assert.deepEqual(batchResults.map(item => [name(item.image_id), item.status]), [['甲', 'success'], ['乙', 'error'], ['丙', kind === 'html' ? 'needs_repair' : 'success']]);
      assert.deepEqual(['甲', '乙', '丙'].map(renderFixture.reference), [batchResults[0].asset_ref, undefined, kind === 'html' ? undefined : batchResults[2].asset_ref], '待修复和失败项不回填');
      assert.match(batchResults[1].error, /仅乙转图失败/);
      for (const item of [batchResults[0], batchResults[2]]) {
        assert.equal(fs.readFileSync(path.join(workspaceDir, item.asset_ref), 'utf8'), name(item.image_id));
        assert.equal(item.source_file, sourceFile);
      }
      if (kind === 'html') assert.deepEqual(batchResults[2].layout_issues, ['模拟布局问题']);
      await assert.rejects(renderTool.execute('duplicate-render', { images: [batchImages[0], batchImages[0]] }), /不能重复/);
      renderer[method] = async () => ({ buffer: Buffer.from('乙'), width: 200, height: 80, layout_issues: [] });
      const retryResult = (await renderTool.execute('retry-render', { images: [batchImages[1]] })).details.results;
      assert.deepEqual(retryResult.map(item => [name(item.image_id), item.status]), [['乙', 'success']]);
      assert.equal(renderFixture.reference('乙'), retryResult[0].asset_ref);
      assert.equal(fs.readFileSync(path.join(workspaceDir, batchResults[0].asset_ref), 'utf8'), '甲');

      // 主任务或工具取消时，已保存项保留，尚未完成项不落盘。
      for (const cancelTask of [false, true]) {
        const taskCancel = new AbortController(), toolCancel = new AbortController();
        const inFlight = [];
        renderer[method] = (_text, options) => new Promise(resolve => inFlight.push({ resolve, options }));
        const cancellable = taskTools(createContentGenerationImageTools({ htmlImageOptimization: true, aiService: {}, signal: taskCancel.signal, localImageRenderService: renderer, sections }, { Type, workspaceDir }), workspaceDir).find(item => item.name === renderTool.name);
        const running = cancellable.execute('cancel-batch', { images: batchImages.map(image => ({ ...image, regenerate: true })) }, toolCancel.signal);
        inFlight[0].resolve({ buffer: Buffer.from('已完成'), width: 100, height: 80, layout_issues: [] });
        await new Promise(resolve => setImmediate(resolve));
        const beforeCancel = fs.readdirSync(path.join(workspaceDir, '图片'));
        const reason = new Error('取消整批转图');
        (cancelTask ? taskCancel : toolCancel).abort(reason);
        for (const pending of inFlight.slice(1)) {
          assert.equal(pending.options.isPauseRequested(), true);
          assert.equal(pending.options.createPauseError(), reason);
          pending.resolve({ buffer: Buffer.from('不得保存'), width: 100, height: 80 });
        }
        const pausedResults = (await running).details;
        assert.equal(pausedResults.cancelled, true);
        assert.deepEqual(pausedResults.results.map(item => item.status), ['success', 'cancelled', 'cancelled']);
        assert.deepEqual(fs.readdirSync(path.join(workspaceDir, '图片')), beforeCancel);
      }
    }
    console.log('批量转图：全量派发、乱序结果对应、部分失败、布局反馈、单项重试及取消保留成功项通过。');

    const facts = files.find(file => file.path === '全局事实设定.md').content;
    const jobs = input.targets.map(item => ({ section_id: item.id, instructions: '落实责任', references: '' }));
    const html = '<!-- yibiao:block -->\n<p id="s_1_p001">具体实施措施</p>';
    const pending = [];
    const progress = [];
    const warmups = [];
    const aiService = { chat(request) {
      assert.equal(request.signal.aborted, false);
      // 预热失败只记录活动，不阻止随后的并发正文请求。
      if (request.logTitle.includes('公共前缀预热')) { warmups.push(request); return Promise.reject(new Error('预热不可用')); }
      assert.match(request.messages[0].content, /【待填写】/);
      assert.match(request.messages[0].content, /不在正文中提及知识库/);
      assert.ok(request.messages[0].content.includes(input.image_requirements));
      assert.equal(request.messages[1].content.split(facts).length - 1, 1, '普通生成及失败、暂停重试均完整注入一次全局事实');
      assert.match(request.messages[1].content, /A3/);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    } };
    const [tool] = taskTools(createContentGenerationTools({ aiService, hasKnowledgeBase: true, signal, onProgress: event => progress.push(event) }, { Type, workspaceDir }), workspaceDir);
    assert.match(tool.description, /读取 任务\/正文生成\.json 中的全部小节/);
    assert.match(tool.description, /写完再调用对应工具提交/);
    assert.match(tool.description, /超出上限的任务自动排队/);
    assert.match(tool.description, /程序自动提供本节编排、完整全局事实及公共材料/);
    assert.match(tool.description, /知识库等补充资料/);
    const batch = tool.execute('batch', { sections: jobs }, signal);
    for (let tick = 0; tick < 5 && pending.length < 2; tick++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(warmups.length, 1);
    assert.equal(pending.length, 2, '两个请求必须同时启动，不能等第一节完成才开始第二节');
    pending[0].resolve(html);
    pending[1].reject(new Error('模拟模型失败'));
    const batchOutput = await batch;
    const first = batchOutput.details.results;
    assert.deepEqual(first.map(item => item.status), ['success', 'error']);
    assert.deepEqual(JSON.parse(batchOutput.content[0].text), { total: 2, success: 1, skipped: 0, unresolved: [first[1]] }, '模型只接收统计和失败小节');
    const firstFile = path.join(workspaceDir, first[0].file);
    assert.equal(fs.readFileSync(firstFile, 'utf8'), html);
    assert.equal(progress[0].completed, 1);
    await assert.rejects(tool.execute('invalid', { sections: [{ ...jobs[0], section_id: '20000000-0000-4000-8000-000000000002' }] }), /只能包含本次目标小节/);

    // 暂停时未完成的请求不得落盘；上一批成功文件继续保留。
    const cancel = new AbortController();
    const interrupted = tool.execute('cancel', { sections: [jobs[1]] }, cancel.signal);
    cancel.abort(new Error('暂停生成'));
    pending[2].resolve(html);
    await assert.rejects(interrupted, /暂停生成/);
    assert.equal(fs.existsSync(path.join(workspaceDir, input.targets[1].file)), false);
    assert.equal(fs.readFileSync(firstFile, 'utf8'), html);
    const [resumedTool] = taskTools(createContentGenerationTools({ aiService, hasKnowledgeBase: true, signal, onProgress: event => progress.push(event) }, { Type, workspaceDir }), workspaceDir);
    const retried = resumedTool.execute('retry', { sections: [jobs[1]] }, signal);
    pending[3].resolve(html.replace('s_1_', 's_2_'));
    await retried;
    assert.equal(warmups.length, 1, '单节提交不预热公共前缀');
    assert.equal(progress.at(-1).completed, 2);
    // 暂停恢复时整份任务文件再次提交：已生成小节跳过，不请求模型。
    const repeated = await resumedTool.execute('repeat', { sections: jobs }, signal);
    assert.deepEqual(JSON.parse(repeated.content[0].text), { total: 2, success: 0, skipped: 2, unresolved: [] });
    assert.equal(pending.length, 4, '已生成小节不再请求模型');
    const manifest = { sections: input.targets.map(item => ({ section_id: item.id, file: item.file, words: 6 })) };
    fs.writeFileSync(path.join(workspaceDir, '正文生成结果.json'), JSON.stringify(manifest), 'utf8');
    assert.equal(readContentGenerationResult(workspaceDir).sections.length, 2);

    // 全量提交可超过实际并发上限，后续请求由现有队列补入，无需 Agent 再调用工具。
    const queue = createAiRequestQueue({ getLimit: () => 1 });
    const queuedRequests = [];
    let submitted = 0;
    const [queuedTool] = taskTools(createContentGenerationTools({ signal, aiService: { chat(request) {
      if (request.logTitle.includes('公共前缀预热')) return Promise.reject(new Error('跳过预热'));
      submitted++;
      return queue.enqueue(() => new Promise(resolve => queuedRequests.push(resolve)), { signal: request.signal });
    } } }, { Type, workspaceDir }), workspaceDir);
    const queuedBatch = queuedTool.execute('all-targets', { sections: jobs.map(job => ({ ...job, regenerate: true })) }, signal);
    for (let tick = 0; tick < 5 && submitted < jobs.length; tick++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(submitted, jobs.length, '一次提交应立即将任务文件中的全部小节交给队列');
    assert.equal(queue.getStatus().active, 1);
    assert.equal(queue.getStatus().queued, 1);
    queuedRequests[0](html);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queuedRequests.length, 2, '首项完成后队列自动启动下一项');
    assert.equal(queue.getStatus().active, 1);
    assert.equal(queue.getStatus().queued, 0);
    queuedRequests[1](html.replace('s_1_', 's_2_'));
    assert.deepEqual((await queuedBatch).details.results.map(item => item.status), ['success', 'success']);
    fs.writeFileSync(firstFile, `${html}<img alt="实施图">`, 'utf8');
    assert.throws(() => readContentGenerationResult(workspaceDir), /尚未生成/);
    fs.writeFileSync(firstFile, `${html}<img alt="实施图" data-yb-asset-ref="图片/缺失.png">`, 'utf8');
    assert.throws(() => readContentGenerationResult(workspaceDir), /图片文件不存在/);
    fs.writeFileSync(firstFile, `${html}<img alt="实施图" data-yb-asset-ref="../越界.png">`, 'utf8');
    assert.throws(() => readContentGenerationResult(workspaceDir), /相对路径/);
    fs.writeFileSync(firstFile, `${html}<figure id="s_1_fig1" data-yb-generation="aiImage" data-yb-size="wide"><template data-yb-role="prompt">实施图</template><img alt="实施图" data-yb-asset-ref="${savedImage.asset_ref}"></figure>`, 'utf8');
    assert.equal(readContentGenerationResult(workspaceDir).sections.length, 2);

    // 真实业务适配器的新建/恢复协议：恢复不重建输入快照，也不删除已有产物。
    for (const resume of [false, true]) {
      let built = 0;
      let updates = 0;
      const result = await runContentGenerationAgent({
        resume, hasKnowledgeBase: true, signal, aiService, buildFiles: () => { built++; return files; },
        agentService: {
          hasPersistentTaskSession: () => resume,
          loadPersistentTask: () => ({ state: {}, paths: { workspaceDir } }),
          updatePersistentTask() { updates++; },
          async runTask(payload) {
            assert.equal(payload.persistent_task.mode, resume ? 'resume' : 'create');
            assert.equal(payload.primary_session, true);
            assert.equal(Object.hasOwn(payload, 'auto_validate_json'), false, '结果在提交时统一校验');
            assert.equal(payload.files.length, resume ? 0 : files.length);
            assert.match(payload.prompt, /受限HTML生成规范.md 篇幅固定，须完整阅读/);
            assert.match(payload.prompt, /"execution_summary"/);
            assert.ok(input.targets.every(section => !payload.prompt.includes(section.id)), '目标列表不进入提示词，按需读取');
            assert.match(payload.prompt, /可用 read 分页，也可用 rg、jq 等命令筛选/);
            assert.match(payload.prompt, /以 list-section-images 返回的 summary 为准/);
            assert.match(payload.prompt, /不另写脚本或中间文件重复这些统计和格式检查/);
            assert.doesNotMatch(payload.prompt, /不要编写临时脚本|bash 只用于|一次性|小批次|单张也使用一项数组|必须完整阅读/);
            assert.equal(payload.fixed_tool_list, true, '正文主会话固定工具清单');
            assert.match(payload.prompt, /如发现信息不一致，可读取相关文件核实/);
            assert.match(payload.prompt, /completed_sections 仅记录本轮启动前/);
            assert.match(payload.prompt, /将本轮待生成小节写入 任务\/正文生成\.json/);
            assert.match(payload.prompt, /已预置 Schema，可用 json-validation 自查，提交工具读取时校验。写完再调用对应工具提交/);
            assert.match(payload.prompt, /标记完成后程序统一提交校验.*问题涉及的小节超过 5 个时调用 fix-submission-issues 并发修复，5 个及以下直接修改/);
            assert.doesNotMatch(payload.prompt, /最多退回 3 次/);
            assert.doesNotMatch(payload.prompt, /自动校验|本次修改未写入/);
            assert.match(payload.prompt, /超出上限的任务自动排队/);
            assert.match(payload.prompt, /每项都必须包含 section_id、instructions 和 references/);
            assert.match(payload.prompt, /已生成正文的小节自动跳过，确需整节重写时给该项加 "regenerate": true/);
            assert.match(payload.prompt, /配图前完整阅读配图类型对照表.md/);
            assert.match(payload.prompt, /size 必填.*768x1024/);
            assert.match(payload.prompt, /prompt 中保留.*比例.*构图方向/);
            assert.match(payload.prompt, /本轮待生成的 AI、HTML、Mermaid 图片写入 任务\/配图生成\.json/);
            assert.match(payload.prompt, /已有有效图片的项自动跳过/);
            assert.match(payload.prompt, /每张源码生成完成立即本地转图/);
            assert.match(payload.prompt, /有 source_file 的失败或未完成项直接读取/);
            assert.match(payload.prompt, /写入 任务\/HTML转图\.json 或 任务\/Mermaid转图\.json/);
            assert.match(payload.prompt, /每张成功图片由程序立即回填正文；提交结束后按返回的 unresolved 逐项检查/);
            assert.match(payload.prompt, /无须再调用 apply-section-images.*仅对返回 applied=false 的项/);
            assert.match(payload.prompt, /global_facts_requirements（当前事实模式的中文要求）/);
            assert.doesNotMatch(payload.prompt, /本次使用已还原底稿/);
            assert.match(payload.prompt, /知识库\/索引.json定位参考文档/);
            assert.match(payload.prompt, /image_requirements（用户配图要求）/);
            assert.match(payload.prompt, /image_layout_quota（本轮新增布局名额）/);
            assert.match(payload.prompt, /instructions 只补充本节配图布局、组数、逐图表达目的/);
            assert.match(payload.prompt, /逐图表达目的、图片类型和生成方式/);
            assert.match(payload.prompt, /在并发写作前规划每张图的表达目的、图片类型及生成方式/);
            assert.match(payload.prompt, /核对本轮新增图片的生成方式分布/);
            assert.match(payload.prompt, /暂停、失败重试沿用本轮名额，已完成的布局计入完成数量/);
            const { createPiSession } = require('../electron/services/pi/piSessionFactory.cjs');
            const created = await createPiSession({ workspaceDir,
              environment: { shellPath: process.env.ComSpec, layout: { agentDir: path.join(workspaceDir, 'agent') }, instructions: '检查正文初始工具', env: {} },
              config: {}, timeoutMs: 60000, proxyInfo: { baseUrl: 'http://127.0.0.1:1', token: 'test' },
              activeTools: payload.active_tools, createTools: payload.create_tools, beforeToolCall: payload.before_tool_call,
            });
            try {
              assert.ok(created.snapshot.active_tools.includes('generate-sections'), '新建和恢复正文均启用生成工具');
              assert.ok(created.snapshot.active_tools.includes('fix-submission-issues'), '生成阶段即可并发修复提交问题');
              assert.ok(!created.snapshot.active_tools.includes('supplement-layout-sections'), '生成阶段不提前启用补写工具');
              assert.ok(!created.snapshot.active_tools.includes('complete-layout-supplement'));
            } finally { created.session.dispose(); }
            return { workspace_dir: workspaceDir, validation_result: submissionContext(payload, workspaceDir).validation_result };
          },
        },
      });
      assert.equal(built, resume ? 0 : 1);
      assert.equal(updates, resume ? 1 : 0);
      assert.equal(result.sections[0].words, 6);
    }
    await checkPlanningSessionHandoff({ workspaceDir, fileOptions, signal });
    await checkRepairOptions({ Type, workspaceDir, files, signal });
    await checkImageProtectionLifecycle({ Type, workspaceDir, files, signal });
    await checkTableCleanup({ Type, workspaceDir: path.join(workspaceDir, '去表格'), fileOptions, signal });
    await checkLayoutSupplement({ Type, workspaceDir, signal });
    fs.unlinkSync(firstFile);
    assert.throws(() => readContentGenerationResult(workspaceDir), error => error.issues.some(item => item.type === 'missing' && item.severity === 'blocking'));
    console.log('正文 Agent：还原底稿及原图、知识库有无选择、页面图片设置联动、配图需求传递、输入、并发、暂停恢复、三类图片工具及最终图片引用检查通过。');
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

// 验证两项开关由程序独立控制；模型只接收当前有效的指令和工具。
async function checkRepairOptions({ Type, workspaceDir, files, signal }) {
  const file = path.join(workspaceDir, '正文编排决策.json');
  const original = fs.readFileSync(file, 'utf8');
  try {
    const decisions = JSON.parse(original);
    decisions.word_control = { minimumWords: 1000000, maximumWords: 0, checkTotalWords: true };
    const content = JSON.stringify(decisions);
    fs.writeFileSync(file, content, 'utf8');
    const snapshot = files.map(item => item.path === '正文编排决策.json' ? { ...item, content } : item);
    for (const wordCountRepair of [false, true]) for (const htmlImageOptimization of [false, true]) {
      for (const resume of [false, true]) {
        const service = {
          hasPersistentTaskSession: () => resume,
          loadPersistentTask: () => ({ state: {}, paths: { workspaceDir } }),
          updatePersistentTask() {},
          async runTask(payload) {
            const tools = payload.create_tools({ Type, workspaceDir });
            assert.equal(tools.some(tool => tool.name === 'adjust-sections'), wordCountRepair);
            assert.equal(payload.prompt.includes('差额大于10000字时，将各节增减要求写入 任务/扩缩写.json'), wordCountRepair);
            for (const name of ['generate-section-images', 'render-html-image']) {
              assert.equal(tools.find(tool => tool.name === name).description.includes('needs_repair'), htmlImageOptimization);
            }
            assert.doesNotMatch(tools.find(tool => tool.name === 'render-mermaid-image').description, /needs_repair|layout_issues/);
            const modelInput = [payload.prompt, ...snapshot.map(item => item.content), ...tools.map(tool => tool.description)].join('\n');
            assert.doesNotMatch(modelInput, /word_count_repair|html_image_optimization|字数不达标修复|HTML图片二次优化|关闭后不审核/);
            const report = payload.validateOutput({}, { workspace_dir: workspaceDir });
            assert.equal(report.issues.length, wordCountRepair ? 1 : 0);
            if (wordCountRepair) {
              assert.equal(report.issues[0].type, 'word-count');
              assert.equal(report.issues[0].severity, 'quality');
              assert.ok(report.progress > 0, '以真实字数差额跟踪进展');
              assert.match(report.issues[0].message, /"detail_file":"程序清单\/正文字数统计.json"/);
              assert.doesNotMatch(report.issues[0].message, /"sections":\[/, '各节字数写入程序清单，不进入提示词');
            }
            const next = await payload.continueTask({}, submissionContext(payload, workspaceDir, report.issues));
            await next.await_before_prompt;
            assert.equal(next.stage, 'auditing', '公共策略接受字数偏差后继续审计');
            return { workspace_dir: workspaceDir, validation_result: submissionContext(payload, workspaceDir).validation_result };
          },
        };
        await runContentGenerationAgent({ agentService: service, aiService: consistencyAiService, signal, resume,
          generationOptions: { wordCountRepair, htmlImageOptimization },
          buildFiles: () => { assert.equal(resume, false, '恢复不重建输入'); return snapshot; } });
      }
    }
  } finally { fs.writeFileSync(file, original, 'utf8'); }
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
    loadPersistentTask: () => ({ state, paths: { workspaceDir } }),
    updatePersistentTask(_key, partial) { state = { ...state, ...partial }; },
    async runTask(payload) {
      const tools = payload.create_tools({ Type, workspaceDir, setActiveTools: names => { activeTools = names; } });
      await action(payload, tools);
      return { workspace_dir: workspaceDir, validation_result: submissionContext(payload, workspaceDir).validation_result };
    },
  };
  const run = resume => runContentGenerationAgent({ resume, hasKnowledgeBase: true, signal, aiService: consistencyAiService, agentService, buildFiles: () => files });
  const checkBlocked = payload => {
    assert.ok(activeTools.includes('bash'), '图片保护启用和恢复后仍可执行命令');
    payload.before_tool_call({ toolCall: { name: 'bash' }, args: { command: 'pwd' } });
    for (const name of ['adjust-sections', 'list-section-images', 'apply-section-images', 'generate-sections', 'generate-section-images', 'render-html-image', 'render-mermaid-image']) {
      assert.equal(activeTools.includes(name), false);
      assert.throws(() => payload.before_tool_call({ toolCall: { name }, args: {} }), /正文编辑期间不能|当前阶段仅统计字数/);
    }
    // 文件修改不在写入时拦截：正文和任务文件都可写，图片块在提交时核对。
    payload.before_tool_call({ toolCall: { name: 'write' }, args: { path: decisions.targets[0].file } });
    payload.before_tool_call({ toolCall: { name: 'write' }, args: { path: '任务/扩缩写.json' } });
  };
  // 保护开始后改动图片块在提交时退回并列入问题清单，恢复后通过。
  const checkImageSubmission = payload => {
    fs.writeFileSync(sectionFile, `${original}<figure id="新增" data-yb-generation="htmlImage" data-yb-size="wide"><template data-yb-role="prompt">新增</template><img alt="新增"><figcaption>新增</figcaption></figure>`, 'utf8');
    try {
      assert.ok(payload.validateOutput({}, { workspace_dir: workspaceDir }).issues.some(item => item.type === 'image-block' && item.file === decisions.targets[0].file && Array.isArray(item.original_image_blocks)));
    } finally { fs.writeFileSync(sectionFile, original, 'utf8'); }
    payload.validateOutput({}, { workspace_dir: workspaceDir });
  };
  action = async (payload, tools) => {
    // 生成阶段没有图片写入限制；未完成配图不能提前锁定工具。
    payload.before_tool_call({ toolCall: { name: 'generate-section-images' }, args: {} });
    payload.before_tool_call({ toolCall: { name: 'write' }, args: { path: decisions.targets[0].file } });
    const check = tools.find(tool => tool.name === 'check-word-count');
    fs.writeFileSync(sectionFile, `${original}<img alt="未完成图片">`, 'utf8');
    try {
      await assert.rejects(check.execute(), /尚未生成/);
      assert.equal(state.word_adjustment_started, false);
      assert.ok(activeTools.includes('generate-sections'), '图片未完成时仍保留生成工具');
      assert.ok(!activeTools.includes('supplement-layout-sections'));
    } finally { fs.writeFileSync(sectionFile, original, 'utf8'); }
    // 未开启字数修复时只报告实际字数，不给出调整方式。
    const reported = JSON.parse((await check.execute()).content[0].text);
    assert.equal(reported.adjustment, 'none');
    assert.match(reported.note, /不以任何方式（包括脚本批量删改）调整字数/);
    assert.match(check.description, /本次只统计实际字数/);
    assert.equal(state.word_adjustment_started, true);
    checkBlocked(payload);
    checkImageSubmission(payload);
    await assert.rejects(tools.find(tool => tool.name === 'apply-section-images').execute('protected-direct', {}), /不能调用 apply-section-images/);
    throw pauseError;
  };
  await assert.rejects(run(false), error => error === pauseError);
  // 生成要求已由 Runtime 记录为已发出：续跑只发送“继续之前的任务”，执行失败同样续接，提交校验不通过仍完整退回问题。
  state = { ...state, prompted_stage: 'generating' };
  action = async payload => {
    assert.equal(payload.files.length, 0);
    assert.equal(payload.prompt, '继续之前的任务');
    assert.equal(payload.buildRetryPrompt({ kind: 'execution', error: new Error('AI Client调用失败') }, { attempt: 1, max_retries: 1 }), '继续之前的任务');
    const invalid = { kind: 'submission', mode: 'repair', report: { issues: [{ type: 'manifest', severity: 'blocking', message: '缺少小节结果' }] } };
    assert.match(payload.buildRetryPrompt(invalid, { workspace_dir: workspaceDir }), /本次结果文件：正文生成结果.json[\s\S]*重新提交/);
    checkBlocked(payload);
    checkImageSubmission(payload);
  };
  await run(true);
  assert.equal(state.word_adjustment_started, true);
  assert.equal(fs.readFileSync(sectionFile, 'utf8'), original);

  // 未调用字数工具便提前提交，进入审计时也必须先启用保护。
  state = {};
  activeTools = undefined;
  action = async payload => {
    payload.validateOutput({}, { workspace_dir: workspaceDir });
    assert.equal(state.word_adjustment_started, false);
    const continuation = await payload.continueTask({}, submissionContext(payload, workspaceDir));
    await continuation.await_before_prompt;
    assert.equal(continuation.stage, 'auditing');
    assert.equal(state.word_adjustment_started, true);
    checkBlocked(payload);
    throw pauseError;
  };
  await assert.rejects(run(false), error => error === pauseError);
  // 上一轮已完成：相同 Session 的新目标必须从生成开始，不能继承审计完成或编辑保护。
  state = { word_adjustment_started: true, consistency: { status: 'completed', remaining_issues: [] }, prompted_stage: 'generating', compaction_pending: { stage: 'auditing' } };
  activeTools = undefined;
  action = async (payload, tools) => {
    assert.equal(payload.persistent_task.mode, 'resume');
    assert.equal(payload.initial_stage, 'generating');
    assert.equal(payload.files.length, files.length);
    assert.match(payload.prompt, /重新读取已更新的输入文件/);
    assert.equal(state.word_adjustment_started, false);
    assert.equal(state.consistency, null);
    assert.equal(state.prompted_stage, null, '新一轮清除上一轮的阶段要求记录');
    assert.equal(state.compaction_pending, null, '新一轮清除上一轮的待补压缩');
    payload.before_tool_call({ toolCall: { name: 'generate-sections' }, args: {} });
    payload.before_tool_call({ toolCall: { name: 'generate-section-images' }, args: {} });
    assert.ok(tools.some(tool => tool.name === 'generate-sections'));
  };
  await run(false);
  state = { phase: 'content-planning', word_adjustment_started: true, consistency: { status: 'completed' }, table_cleanup: { status: 'completed' }, layout_check: { status: 'completed' } };
  action = async payload => {
    assert.equal(payload.files.length, files.length);
    assert.match(payload.prompt, /基础编排已由程序处理并保存/);
    assert.doesNotMatch(payload.prompt, /目录变更后的局部生成任务|本次恢复时已处于图片保护阶段/);
    assert.equal(state.word_adjustment_started, false);
    for (const field of ['consistency', 'table_cleanup', 'layout_check']) assert.equal(state[field], null);
  };
  await run(true);
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
    generationOptions: { ...fileOptions.generationOptions, imageQuantity: 0, useAiImages: false, useHtmlImages: false, useMermaidImages: false },
    wordControl: { ...fileOptions.wordControl, sectionWords: 10 },
  };
  const files = buildContentGenerationFiles(options);
  const decisions = JSON.parse(files.find(file => file.path === '正文编排决策.json').content);
  const restored = decisions.targets[0].restored_content;
  assert.equal(files.find(file => file.path === decisions.reference_files.outline).content.includes('restored_content'), false, '还原引用不重复放进目录参考');
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
  assert.match(underLimit.restoration_requirements, /每小节目标见本节 content_plan.target_words/);
  assert.match(underLimit.restoration_requirements, /未超过时按现有要求适当扩写/);
  let copied = 0;
  const requests = [];
  const warmups = [];
  for (const resume of [false, true]) {
    await runContentGenerationAgent({
      resume, hasOriginalPlan: true, hasKnowledgeBase: true, signal,
      buildFiles: () => { assert.equal(resume, false); return files; },
      resolveOriginalImagePath(ref) { assert.equal(resume, false); assert.equal(ref, reference); copied++; return imagePath; },
      aiService: { async chat(request) {
        const [system, user] = request.messages;
        if (request.logTitle.includes('公共前缀预热')) {
          warmups.push({ system: system.content, user: user.content, limit: request.output_token_limit, order: requests.length });
          return '';
        }
        requests.push({ system: system.content, user: user.content });
        const facts = files.find(file => file.path === '全局事实设定.md').content;
        assert.equal(user.content.split(facts).length - 1, 1, '还原小节和普通小节均只注入一次完整事实');
        if (request.logTitle.includes('准备')) {
          assert.ok(user.content.includes(source));
          assert.match(user.content, /六十天/);
          assert.match(user.content, /原图\//);
          assert.match(user.content, /本节还原处理要求[\s\S]*只整理，不扩写/);
          assert.match(user.content, /本节还原处理要求[\s\S]*以全局事实设定为准/);
          return `<!-- yibiao:block -->\n<p id="restored_p">工期六十天。设备编号ABC-123。</p>\n<!-- yibiao:block -->\n<table id="restored_table" data-yb-preset="plain"><caption>设备</caption><tbody><tr><td>服务器</td><td>2</td></tr></tbody></table>\n${restoredFigure(restored.images[0].asset_ref)}`;
        }
        assert.doesNotMatch(user.content, /本节已还原底稿|ABC-123/);
        assert.doesNotMatch(user.content, /本节还原处理要求/);
        return '<!-- yibiao:block -->\n<p id="normal_p">正常生成交付措施</p>';
      } },
      agentService: {
        hasPersistentTaskSession: () => resume,
        loadPersistentTask: () => ({ state: {}, paths: { workspaceDir: restoredDir } }),
        updatePersistentTask() {},
        async runTask(payload) {
          assert.match(payload.prompt, /本次使用已还原底稿/);
          assert.match(payload.prompt, /各节 restored_content.file 按需阅读/);
          assert.equal(payload.files.length, resume ? 0 : files.length);
          for (const file of payload.files) {
            const target = path.join(restoredDir, file.path);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, file.content, 'utf8');
          }
          const [tool] = taskTools(payload.create_tools({ Type, workspaceDir: restoredDir }), restoredDir);
          assert.deepEqual(fs.readFileSync(path.join(restoredDir, restored.images[0].asset_ref)), imageBytes);
          if (!resume) {
            const result = await tool.execute('restored', { sections: decisions.targets.map(section => ({ section_id: section.id, instructions: '落实责任', references: '' })) });
            assert.deepEqual(result.details.results.map(section => section.status), ['success', 'success'], JSON.stringify(result.details.results));
            fs.writeFileSync(path.join(restoredDir, '正文生成结果.json'), JSON.stringify({ sections: result.details.results.map(({ section_id, file, words }) => ({ section_id, file, words })) }), 'utf8');
          }
          return { workspace_dir: restoredDir, validation_result: submissionContext(payload, restoredDir).validation_result };
        },
      },
    });
    assert.equal(fs.readFileSync(path.join(restoredDir, restored.file), 'utf8'), source);
    if (!resume) fs.unlinkSync(imagePath);
  }
  assert.equal(copied, 1);
  // 各节 system 完全相同，user 的公共材料位于本节编排之前，保证请求前缀可复用。
  assert.equal(requests.length, 2);
  assert.equal(requests[0].system, requests[1].system);
  assert.doesNotMatch(requests[0].system, /本节还原处理要求/);
  const shared = requests.map(request => request.user.slice(0, request.user.indexOf('本节编排决策：')));
  assert.equal(shared[0], shared[1]);
  for (const label of ['项目概述：', '全局事实设定（完整内容）：', '字数要求：', '用户额外要求：', '受限 HTML 模板：', '所选模板配置：']) assert.ok(shared[0].includes(label), label);
  // 多节并发前先用完全相同的公共前缀发一次单 token 请求，完成后才放开正文请求。
  assert.deepEqual(warmups, [{ system: requests[0].system, user: shared[0].replace(/\n\n$/, ''), limit: 1, order: 0 }]);
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
  const frames = { square: 1240, wide: 827, tall: 1653, panorama: 698 };
  const { sections, id } = createImageFixture(workspaceDir, [...Object.keys(frames), '流程图', '同源第二图'], { id: '本地转图', file: '配图夹具/本地转图.html' });
  const tools = taskTools(createContentGenerationImageTools({ htmlImageOptimization: true, aiService: { async chat(request) {
    const kind = request.messages[0].content.includes('生成 Mermaid 源码') ? 'mermaid' : 'html';
    return `\`\`\`${kind}\n${request.messages[1].content}\n\`\`\``;
  } }, signal: new AbortController().signal, sections }, { Type, workspaceDir }), workspaceDir);
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
  const renderJobs = [];
  for (const frameSize of Object.keys(frames)) {
    // 同一Flex/Grid结构同时覆盖完整文档和HTML片段，source中的88px边距应由画布统一为40px。
    const html = frameSize === 'panorama' ? styles + content
      : `<!DOCTYPE html><html><head><meta charset="utf-8">${styles}</head><body>${content}</body></html>`;
    const sourceFile = `布局-${frameSize}.html`;
    fs.writeFileSync(path.join(workspaceDir, sourceFile), html, 'utf8');
    renderJobs.push({ image_id: id(frameSize), source_file: sourceFile, frame_size: frameSize });
  }
  const renderedFrames = (await tools.find(tool => tool.name === 'generate-section-images').execute('all-frames', { images: renderJobs.map(job => ({ image_id: job.image_id, kind: 'html', frame_size: job.frame_size, prompt: fs.readFileSync(path.join(workspaceDir, job.source_file), 'utf8') })) })).details.results;
  assert.deepEqual(renderedFrames.map(item => [item.image_id, item.status]), Object.keys(frames).map(frame => [id(frame), 'success']));
  for (const result of renderedFrames) {
    const frameSize = decodeURIComponent(result.image_id.split('/')[1]), height = frames[frameSize], sourceFile = result.source_file;
    const html = fs.readFileSync(path.join(workspaceDir, sourceFile), 'utf8');
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
  const unchecked = await renderer.renderHtmlToPng(overflow, { frameSize: 'square', checkLayout: false });
  assert.deepEqual(unchecked.layout_issues, [], '关闭二次优化时跳过实际布局检测');
  assert.deepEqual({ width: unchecked.width, height: unchecked.height }, { width: overflowResult.width, height: overflowResult.height });
  const clipped = '<div style="height:32px;overflow:hidden;font-size:32px">第一行<br>第二行</div>';
  const clippedResult = await renderer.probeHtmlLayoutOnly(clipped, { frameSize: 'wide' });
  assert.ok(clippedResult.layout_issues.some(issue => issue.includes('裁切')), '隐藏溢出的文字仍应反馈裁切');
  const mermaidSource = 'flowchart LR\nA["准备"] --> B["实施"] --> C["交付"]';
  const generatedMermaid = (await tools.find(tool => tool.name === 'generate-section-images').execute('fenced-mermaid', {
    images: [{ image_id: id('流程图'), kind: 'mermaid', prompt: mermaidSource }],
  })).details.results[0];
  assert.equal(generatedMermaid.status, 'success', generatedMermaid.error);
  assert.equal(fs.readFileSync(path.join(workspaceDir, generatedMermaid.source_file), 'utf8'), mermaidSource);
  const mermaidResults = (await tools.find(tool => tool.name === 'render-mermaid-image').execute('mermaid', { images: [
    { image_id: id('流程图'), source_file: generatedMermaid.source_file, regenerate: true }, { image_id: id('同源第二图'), source_file: generatedMermaid.source_file },
  ] })).details.results;
  assert.deepEqual(mermaidResults.map(item => item.status), ['success', 'success']);
  assert.notEqual(mermaidResults[0].asset_ref, mermaidResults[1].asset_ref);
  const mermaid = mermaidResults[0];
  assert.ok(mermaid.width > 24 && mermaid.height > 24);
  assert.deepEqual(nativeImage.createFromPath(path.join(workspaceDir, mermaid.asset_ref)).getSize(), { width: mermaid.width, height: mermaid.height });
  console.log('固定画布越界、隐藏溢出裁切与Mermaid原有转图检查通过。');
}

// 格式自检先对齐运行编号再续接主会话；跨次失败重试保留成功项和图片保护。
async function checkLayoutSupplement({ Type, workspaceDir, signal }) {
  const { createPiSession } = require('../electron/services/pi/piSessionFactory.cjs');
  const targets = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8')).targets;
  let state = { status: 'supplementing', jobs: targets.map(section => ({ section_id: section.id, file: section.file, gaps: [{ figure_ids: ['图'], suggested_words: 50 }] })), completed_section_ids: [] };
  const sessionFile = '原正文会话.jsonl';
  const persistent = { phase: 'layout-checking', run_id: '原正文轮次', session_file: sessionFile, layout_check: state };
  const layout = { get: () => state, save: next => { state = next; persistent.layout_check = next; } };
  const inputBefore = fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8');
  const interrupted = new Error('模拟格式自检主会话失败');
  const runIds = [];
  const checkpoints = [];
  let running = 0;
  let peak = 0;
  let failFirst = true;
  let interruptCorrection = true;
  const calls = [];
  const agentService = {
    hasPersistentTaskSession: () => true,
    loadPersistentTask: () => ({ state: persistent, paths: { workspaceDir } }),
    updatePersistentTask(key, patch) {
    assert.equal(key, CONTENT_GENERATION_AGENT_TASK_KEY);
    Object.assign(persistent, patch);
  }, async runTask(payload) {
    if (!payload.primary_session) {
      assert.equal(payload.failure_handled_by_parent, true);
      assert.deepEqual(payload.active_tools, [...NATIVE_AGENT_TOOLS, 'report-failure']);
      payload.before_tool_call({ toolCall: { name: 'bash' }, args: { command: 'pwd' } });
      running++;
      peak = Math.max(peak, running);
      calls.push(payload.output_file);
      try {
        await new Promise(resolve => setTimeout(resolve, 15));
        if (payload.output_file === targets[0].file && failFirst) throw new Error('可恢复的补写失败');
        const file = path.join(workspaceDir, payload.output_file);
        const original = fs.readFileSync(file, 'utf8');
        // 子任务无独立提交循环，返回后由共享产物检查汇报给主阶段。
        assert.equal(payload.validateOutput, undefined);
        const html = original + '\n<!-- yibiao:block -->\n<p>补充现场复核工作安排。</p>';
        fs.writeFileSync(file, html, 'utf8');
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
    // 文件修改不在写入时拦截，补写结果在提交时校验。
    assert.ok(payload.active_tools.includes('write'));
    assert.ok(payload.active_tools.includes('edit'));
    assert.match(payload.prompt, /不再调整全文字数/);
    assert.match(payload.prompt, /完整任务见 程序清单\/格式补写任务\.json/);
    assert.doesNotMatch(payload.prompt, /figure_ids":/, '补写任务明细不进入提示词');
    const rawTools = payload.create_tools({ Type, workspaceDir });
    const tools = taskTools(rawTools, workspaceDir);
    payload.before_tool_call({ toolCall: { name: 'write' }, args: { path: targets[0].file } });
    payload.before_tool_call({ toolCall: { name: 'edit' }, args: { path: '任务/格式补写.json' } });
    const supplement = tools.find(tool => tool.name === 'supplement-layout-sections');
    const complete = tools.find(tool => tool.name === 'complete-layout-supplement');
    const editCall = { toolCall: { name: 'edit' }, args: { path: targets[0].file } };
    const correctionFile = path.join(workspaceDir, targets[0].file);
    if (failFirst) {
      const batch = supplement.execute('batch', { section_ids: targets.map(section => section.id) });
      assert.ok(running > 0);
      const results = (await batch).details.results;
      assert.equal(results.filter(item => item.status === 'error').length, 1);
      complete.execute();
      assert.equal(state.status, 'supplementing');
      assert.ok(payload.validateOutput({}, { workspace_dir: workspaceDir }).issues.some(item => item.type === 'layout-supplement' && item.severity === 'quality'));
      Object.assign(persistent, { status: 'error', error: interrupted.message });
      throw interrupted;
    }
    // 已完成补写的小节再次提交时跳过，不重复追加；不在任务中的小节报错。
    const again = await supplement.execute('again', { section_ids: [targets[1].id] });
    assert.deepEqual(JSON.parse(again.content[0].text), { total: 1, success: 0, skipped: 1, unresolved: [] });
    await assert.rejects(supplement.execute('unknown', { section_ids: ['不存在的小节'] }), /不在本次格式补写任务中/);
    if (!state.completed_section_ids.includes(targets[0].id)) {
      await supplement.execute('retry', { section_ids: [targets[0].id] });
    }
    payload.before_tool_call(editCall);
    if (interruptCorrection) {
      const html = fs.readFileSync(correctionFile, 'utf8');
      fs.writeFileSync(correctionFile, html.replace(/<\/p>$/, ''), 'utf8');
    }
    const created = await createPiSession({ workspaceDir,
      environment: { shellPath: process.env.ComSpec, layout: { agentDir: path.join(workspaceDir, 'agent') }, instructions: '检查格式补写收尾编辑', env: {} },
      config: {}, timeoutMs: 60000, summaryEnabled: false, proxyInfo: { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      activeTools: payload.active_tools, createTools: () => rawTools, beforeToolCall: payload.before_tool_call,
    });
    try {
      assert.deepEqual(created.snapshot.active_tools, payload.active_tools, '恢复补写时只启用当前阶段工具');
      await created.session.agent.beforeToolCall({ toolCall: { name: 'bash' }, args: { command: 'pwd' } });
      assert.ok(created.snapshot.active_tools.includes('supplement-layout-sections'));
      assert.ok(created.snapshot.active_tools.includes('complete-layout-supplement'));
      assert.ok(!created.snapshot.active_tools.includes('generate-sections'));
      const edit = created.session.agent.state.tools.find(tool => tool.name === 'edit');
      assert.ok(edit, '主会话实际注册原生 edit');
      const original = fs.readFileSync(correctionFile, 'utf8');
      // 收尾纠错改动图片块时写入照常，提交时退回并附原始图片块。
      await edit.execute('image', { path: targets[0].file, edits: [{ oldText: original, newText: original + '<figure><img></figure>' }] });
      assert.ok(payload.validateOutput({}, { workspace_dir: workspaceDir }).issues.some(item => item.type === 'image-block' && item.severity === 'blocking' && item.file === targets[0].file));
      fs.writeFileSync(correctionFile, original, 'utf8');
      const paragraph = '<p>补充现场复核工作安排。';
      if (interruptCorrection) {
        assert.ok(original.endsWith(paragraph));
        await edit.execute('close-paragraph', { path: targets[0].file, edits: [{ oldText: paragraph, newText: paragraph + '</p>' }] });
        assert.equal(fs.readFileSync(correctionFile, 'utf8'), original + '</p>');
        interruptCorrection = false;
        throw interrupted;
      }
      assert.ok(original.endsWith(paragraph + '</p>'), '恢复保留已经写入的纠错');
      complete.execute();
      assert.equal(fs.readFileSync(correctionFile, 'utf8'), original);
    } finally { created.session.dispose(); }
    assert.deepEqual(payload.continueTask({}, submissionContext(payload, workspaceDir)), { complete: true });
    return { workspace_dir: workspaceDir, validation_result: submissionContext(payload, workspaceDir).validation_result };
  } };
  const run = () => runContentGenerationAgent({ agentService, signal, resume: true, onLayoutProgress: next => { state = next; }, onCheckpoint: checkpoint => checkpoints.push(checkpoint) });
  await assert.rejects(run(), error => error === interrupted);
  assert.equal(persistent.error, interrupted.message);
  assert.equal(state.status, 'supplementing');
  const completedFile = path.join(workspaceDir, targets[1].file);
  const completedBefore = fs.readFileSync(completedFile, 'utf8');
  failFirst = false;
  await assert.rejects(run(), error => error === interrupted);
  assert.equal(state.status, 'supplementing');
  assert.equal(state.completed_section_ids.length, targets.length);
  await run();
  assert.equal(runIds.length, 3);
  assert.equal(persistent.session_file, sessionFile);
  assert.equal(persistent.status, 'running');
  assert.equal(persistent.error, null);
  assert.equal(fs.readFileSync(completedFile, 'utf8'), completedBefore);
  assert.equal(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'), inputBefore);
  assert.equal(peak, 2);
  assert.equal(calls.filter(file => file === targets[1].file).length, 1);
  assert.equal(state.status, 'rechecking');
  console.log('格式补写：运行编号与检查点一致、失败后原会话续接、原生 edit 修复、子任务与收尾纠错的图片块提交校验、纠错恢复通过。');
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
