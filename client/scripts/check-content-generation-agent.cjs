const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildContentGenerationFiles, createContentGenerationTools, runContentGenerationAgent, readContentGenerationResult } = require('../electron/services/contentGenerationAgent.cjs');
const { createContentGenerationImageTools } = require('../electron/services/contentGenerationImageTools.cjs');

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
      { id: '1', title: '实施', content_mode: 'ai-generate', children: [
        { id: '1.1', title: '准备', content_mode: 'ai-generate' },
        { id: '1.2', title: '交付', content_mode: 'ai-generate' },
      ] },
      { id: '2', title: '报价', content_mode: 'manual-fill' },
    ];
    const targets = outline[0].children.map(item => ({ item }));
    const fileOptions = {
      outline, targets, plans: Object.fromEntries(targets.map(({ item }) => [item.id, { plan: { writing_focus: '落实责任', knowledge: { item_ids: ['doc::k1'] }, table: { needed: false, purpose: '' }, image_needed: true, image_suitability_score: 8 } }])),
      generationOptions: { imageQuantity: 'light', useAiImages: true, useHtmlImages: true, useMermaidImages: false, htmlImageTypes: '甘特图、风险矩阵' },
      projectOverview: '某地建设项目', globalFacts: [{ title: '工期', content: '六十天' }], globalFactsMode: 'placeholder',
      wordControl: { minimumWords: 1000, maximumWords: 2000, sectionWords: 800, sectionMinimumWords: 640, sectionMaximumWords: 960, strictSectionWords: true },
      requirement: '突出交付', template: { template_id: 'chosen', config: { paper_size: 'A3' } }, documentIds: ['doc'],
      knowledgeBaseService: { readReferences(ids, options) {
        assert.deepEqual(ids, ['doc']);
        assert.deepEqual(options, { includeMarkdown: true, includeItems: true });
        return [{ document: { id: 'doc', file_name: '完整知识库' }, markdown: '选中条目和未选中条目全文', items: [{ id: 'k1', title: '准备工作', resume: '准备摘要' }] }];
      } },
    };
    await checkRestoredContent({ Type, workspaceDir, fileOptions, signal });
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
    assert.deepEqual(input.targets.map(item => item.id), ['1.1', '1.2']);
    assert.equal(input.outline[1].content_mode, 'manual-fill');
    assert.match(input.word_requirements, /1000.*2000/);
    assert.match(input.word_requirements, /640～960.*800/);
    assert.equal(input.targets[0].content_plan.image_suitability_score, 8);
    assert.match(input.image_requirements, /少图.*1～3/);
    assert.match(input.image_requirements, /Mermaid 图片（mermaid）不允许/);
    assert.match(input.image_requirements, /甘特图、风险矩阵/);
    assert.match(input.image_requirements, /不要求每节或全文覆盖所有类型/);
    assert.match(files.find(file => file.path === '知识库/doc.md').content, /未选中条目全文/);
    assert.equal(JSON.parse(files.find(file => file.path === '知识库/索引.json').content)[0].file, '知识库/doc.md');
    assert.match(files.find(file => file.path === '全局事实设定.md').content, /六十天/);

    // 各档位和单独类型开关只改变模型需求，不裁剪工具；并发正文模型收到同一份需求。
    for (const [imageQuantity, enabled, expected] of [['none', true, /无图：不安排配图、不留图片占位、不调用配图工具/], ['light', false, /少图.*1～3/], ['heavy', true, /多图.*1～6/]]) {
      const scenarioFiles = buildContentGenerationFiles({ ...fileOptions, generationOptions: { ...fileOptions.generationOptions, imageQuantity, useAiImages: enabled, useHtmlImages: enabled, useMermaidImages: enabled, maxAiImages: 999 } });
      const decisionFile = scenarioFiles.find(file => file.path === '正文编排决策.json');
      const decisions = JSON.parse(decisionFile.content);
      assert.match(decisions.image_requirements, expected);
      assert.match(decisions.image_requirements, /高分不等于必须多图/);
      assert.match(decisions.image_requirements, /不设比例或强制顺序/);
      assert.equal(decisions.image_requirements.includes('999'), false);
      if (!enabled) assert.match(decisions.image_requirements, /AI 图片（aiImage）不允许；HTML 图片（htmlImage）不允许；Mermaid 图片（mermaid）不允许/);
      fs.writeFileSync(path.join(workspaceDir, decisionFile.path), decisionFile.content, 'utf8');
      let received = false;
      const scenarioTools = createContentGenerationTools({ signal, aiService: { async chat(request) {
        received = true;
        assert.ok(request.messages[0].content.includes(decisions.image_requirements));
        return '<!-- yibiao:block -->\n<p id="scenario">项目实施内容</p>';
      } } }, { Type, workspaceDir });
      assert.deepEqual(scenarioTools.map(tool => tool.name), ['generate-sections', 'generate-image', 'render-html-image', 'render-mermaid-image']);
      const result = await scenarioTools[0].execute('settings', { sections: [{ section_id: '1.1', instructions: '落实责任', references: '' }] });
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
    const imageOutput = await imageTool.execute('image', imageParams);
    assert.deepEqual(imageOutput.details, { ...imageResult, asset_ref: imageOutput.details.asset_ref });
    assert.deepEqual(JSON.parse(imageOutput.content[0].text), imageOutput.details);
    assert.deepEqual(fs.readFileSync(path.join(workspaceDir, imageOutput.details.asset_ref)), fs.readFileSync(imageResult.file_path));
    const imageError = new Error('生图模型不可用');
    imageService.generateImage = async () => { throw imageError; };
    await assert.rejects(imageTool.execute('image-error', imageParams), error => error === imageError);
    for (const cancelTask of [false, true]) {
      const taskCancel = new AbortController();
      const toolCancel = new AbortController();
      imageService.generateImage = ({ signal: requestSignal }) => new Promise((resolve, reject) => {
        requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
      });
      const cancellableTool = createContentGenerationTools({ aiService: imageService, signal: taskCancel.signal }, { Type, workspaceDir }).find(tool => tool.name === 'generate-image');
      const request = cancellableTool.execute('image-cancel', imageParams, toolCancel.signal);
      const reason = new Error('取消生图');
      (cancelTask ? taskCancel : toolCancel).abort(reason);
      await assert.rejects(request, error => error === reason);
    }

    // 两种转图读取已有 UTF-8 源码，保留错误与取消行为，不调用文本模型。
    for (const kind of ['html', 'mermaid']) {
      const sourceFile = `图片/实施流程.${kind === 'html' ? 'html' : 'mmd'}`;
      const source = kind === 'html' ? '<div>实施流程</div>' : 'flowchart LR\nA["准备"] --> B["实施"]';
      fs.writeFileSync(path.join(workspaceDir, sourceFile), source, 'utf8');
      const renderer = {};
      const method = kind === 'html' ? 'renderHtmlToPng' : 'renderMermaidToPng';
      const pause = new AbortController();
      const renderTool = createContentGenerationImageTools({ aiService: {}, signal, localImageRenderService: renderer }, { Type, workspaceDir }).find(tool => tool.name === `render-${kind}-image`);
      renderer[method] = async (text, options) => {
        assert.equal(text, source);
        assert.equal(options.isPauseRequested(), false);
        return { buffer: Buffer.from('PNG'), width: 100, height: 80, layout_issues: [] };
      };
      const rendered = (await renderTool.execute('render', { source_file: sourceFile })).details;
      assert.equal(rendered.width, 100);
      assert.equal(rendered.height, 80);
      assert.equal(rendered.source_file, sourceFile);
      assert.equal(fs.readFileSync(path.join(workspaceDir, rendered.asset_ref), 'utf8'), 'PNG');
      const renderError = new Error('模拟渲染错误');
      renderer[method] = async () => { throw renderError; };
      await assert.rejects(renderTool.execute('error', { source_file: sourceFile }), error => error === renderError);
      assert.equal(fs.readFileSync(path.join(workspaceDir, sourceFile), 'utf8'), source);
      const savedFiles = fs.readdirSync(path.join(workspaceDir, '图片'));
      renderer[method] = async (_text, options) => {
        pause.abort(new Error('停止转图'));
        assert.equal(options.isPauseRequested(), true);
        assert.equal(options.createPauseError(), pause.signal.reason);
        return { buffer: Buffer.from('未完成图片') };
      };
      await assert.rejects(renderTool.execute('cancel', { source_file: sourceFile }, pause.signal), /停止转图/);
      assert.deepEqual(fs.readdirSync(path.join(workspaceDir, '图片')), savedFiles, '取消后不得保存新图片');
    }

    const jobs = input.targets.map(item => ({ section_id: item.id, instructions: '落实责任', references: '全局事实：工期六十天' }));
    const html = '<!-- yibiao:block -->\n<p id="s_1_p001">具体实施措施</p>';
    const pending = [];
    const progress = [];
    const aiService = { chat(request) {
      assert.equal(request.signal.aborted, false);
      assert.match(request.messages[0].content, /【待填写】/);
      assert.match(request.messages[0].content, /不提及知识库/);
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
    await assert.rejects(tool.execute('invalid', { sections: [{ ...jobs[0], section_id: '2' }] }), /只能提交/);

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
    fs.writeFileSync(firstFile, `${html}<img alt="实施图" data-yb-asset-ref="${imageOutput.details.asset_ref}">`, 'utf8');
    assert.equal(readContentGenerationResult(workspaceDir).sections.length, 2);

    // 真实业务适配器的新建/恢复协议：恢复不重建输入快照，也不删除已有产物。
    for (const resume of [false, true]) {
      let built = 0;
      let updates = 0;
      const result = await runContentGenerationAgent({
        resume, hasKnowledgeBase: true, signal, aiService, buildFiles: () => { built++; return files; },
        agentService: {
          hasPersistentTaskSession: () => resume,
          updatePersistentTask() { updates++; },
          async runTask(payload) {
            assert.equal(payload.persistent_task.mode, resume ? 'resume' : 'create');
            assert.equal(payload.primary_session, true);
            assert.equal(payload.auto_validate_json, true);
            assert.equal(payload.files.length, resume ? 0 : files.length);
            assert.match(payload.prompt, /三个文件必须完整阅读/);
            assert.doesNotMatch(payload.prompt, /本次使用已还原底稿/);
            assert.match(payload.prompt, /知识库\/包含用户选中的全部文档/);
            assert.match(payload.prompt, /image_requirements（用户配图要求）/);
            assert.deepEqual(payload.create_tools({ Type, workspaceDir }).map(tool => tool.name), ['generate-sections', 'generate-image', 'render-html-image', 'render-mermaid-image']);
            payload.validateOutput({}, { workspace_dir: workspaceDir });
            return { workspace_dir: workspaceDir };
          },
        },
      });
      assert.equal(built, resume ? 0 : 1);
      assert.equal(updates, resume ? 2 : 1);
      assert.equal(result.sections[0].words, 6);
    }
    fs.unlinkSync(firstFile);
    assert.throws(() => readContentGenerationResult(workspaceDir), /ENOENT/);
    console.log('正文 Agent：还原底稿及原图、知识库有无选择、页面图片设置联动、配图需求传递、输入、并发、暂停恢复、三类图片工具及最终图片引用检查通过。');
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
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
  const options = { ...fileOptions, hasOriginalPlan: true, restoredContents: { '1.1': source }, existingTotalWords: 2100,
    generationOptions: { ...fileOptions.generationOptions, imageQuantity: 'none', useAiImages: false, useHtmlImages: false, useMermaidImages: false },
    wordControl: { ...fileOptions.wordControl, sectionWords: 10, sectionMinimumWords: 8, sectionMaximumWords: 12 },
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
  assert.match(decisions.restoration_requirements, /不得因该属性调用生图工具/);
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
        if (request.logTitle.includes('1.1')) {
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
  const tools = createContentGenerationImageTools({ aiService: {}, signal: new AbortController().signal }, { Type, workspaceDir });
  for (const [kind, source] of [
    ['html', '<!DOCTYPE html><html><head><style>body{font:32px sans-serif}main{padding:40px;background:#dfeafb}</style></head><body><main>项目实施流程：准备 → 实施 → 交付</main></body></html>'],
    ['mermaid', 'flowchart LR\nA["准备"] --> B["实施"] --> C["交付"]'],
  ]) {
    const sourceFile = `实施流程.${kind === 'html' ? 'html' : 'mmd'}`;
    fs.writeFileSync(path.join(workspaceDir, sourceFile), source, 'utf8');
    const result = (await tools.find(tool => tool.name === `render-${kind}-image`).execute(kind, { source_file: sourceFile })).details;
    const png = fs.readFileSync(path.join(workspaceDir, result.asset_ref));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const size = nativeImage.createFromBuffer(png).getSize();
    assert.ok(size.width > 24 && size.height > 24);
    assert.deepEqual(size, { width: result.width, height: result.height });
    assert.equal(fs.readFileSync(path.join(workspaceDir, sourceFile), 'utf8'), source);
    if (kind === 'html') assert.deepEqual(result.layout_issues, []);
    console.log(`${kind} 本地转图通过：${size.width}×${size.height}，PNG 及源码保留。`);
  }
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
