const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createTaskService } = require('../electron/services/taskService.cjs');
const { createPiSession, loadPiModules } = require('../electron/services/pi/piSessionFactory.cjs');
const { countHtmlWords } = require('../electron/services/contentGenerationWordTools.cjs');

// 模拟模型响应，保留真实持久 Pi Session、原生 edit 和业务任务调度。
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '单节重新生成-'));
  const workspaceDir = path.join(root, '中文会话');
  const outputDir = path.join(root, 'technical-plan');
  const sessionsDir = path.join(root, 'sessions');
  const first = 'b0000000-0000-4000-8000-000000000001';
  const second = 'a0000000-0000-4000-8000-000000000002';
  const file = `正文/${first}.html`;
  const figure = '<figure id="原图" data-yb-generation="aiImage" data-yb-size="wide"><template data-yb-role="prompt">原图</template><img data-yb-asset-ref="图片/原图.png" alt="原图"><figcaption>原图</figcaption></figure>';
  // 所有产物使用独立临时目录，不触碰用户数据。
  function write(relative, content) {
    const destination = path.join(workspaceDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content, 'utf8');
  }
  write(file, `<!-- yibiao:block --><p>原说明</p>${figure}`);
  write(`正文/${second}.html`, '<!-- yibiao:block --><p>其他小节正文</p>');
  write('图片/原图.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64'));
  write('所选模板配置.json', JSON.stringify({ config: { page: { size: 'A4' } } }));
  write('正文编排决策.json', JSON.stringify({ outline: [{ id: first, title: '旧标题' }], targets: [{ id: second }] }));
  write('正文生成结果.json', JSON.stringify({ sections: [{ section_id: second }] }));
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, `${first}.docx`), '目标旧 Word');
  fs.writeFileSync(path.join(outputDir, `${second}.docx`), '其他小节 Word');
  const untouched = [`正文/${second}.html`, '图片/原图.png', '正文编排决策.json', '正文生成结果.json']
    .map(name => [name, fs.readFileSync(path.join(workspaceDir, name))]);
  let state = {
    outlineWordControlSnapshot: { minimumWords: 100000 },
    outlineData: { outline: [{ id: 'root', title: '当前目录', children: [
      { id: second, title: '其他小节', content_mode: 'ai-generate' },
      { id: first, title: '改名后的目标', content_mode: 'ai-generate' },
    ] }] },
    contentGenerationSections: { [first]: { id: first, status: 'success', content: '' }, [second]: { id: second, status: 'success', content: '' } },
    contentGenerationTask: { status: 'success' },
    contentGenerationRuntime: { generation_started: true, phase: 'word-completed',
      section_words: Object.fromEntries([first, second].map(id => [id, countHtmlWords(fs.readFileSync(path.join(workspaceDir, `正文/${id}.html`), 'utf8'))])), html_output: {
      workspace_dir: workspaceDir, word_output_dir: outputDir,
      word_sections: [first, second].map(id => ({ section_id: id, file: `${id}.docx` })),
    } },
  };
  const { piAi } = await loadPiModules();
  const base = { workspaceDir, sessionsDir, environment: { shellPath: process.env.ComSpec, layout: { agentDir: path.join(root, 'agent') }, instructions: '定向检查', env: {} },
    config: {}, timeoutMs: 60000, proxyInfo: { baseUrl: 'http://127.0.0.1:1', token: 'test' } };
  // 测试响应不会访问真实模型。
  function response(content, stopReason) {
    const stream = piAi.createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: stopReason, message: { role: 'assistant', content, stopReason,
      api: 'openai-completions', provider: 'yibiao', model: 'default', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
    return stream;
  }
  const seed = await createPiSession(base);
  seed.session.agent.streamFn = () => response([{ type: 'text', text: '原正文生成完成' }], 'stop');
  await seed.session.prompt('原正文生成任务');
  const sessionFile = seed.sessionFile;
  seed.session.dispose();
  let persistent = { session_file: path.basename(sessionFile), consistency: { status: 'completed', round: 3 }, word_adjustment_started: true };
  let runs = 0;
  let conversions = 0;
  let behavior = 'edit';
  let failConversion = false;
  let terminal;
  const app = Object.assign(new EventEmitter(), { isPackaged: Boolean(process.env.YIBIAO_OPENXML_HELPER_DIR), getPath: () => root, getAppPath: () => path.resolve(__dirname, '..') });
  const realHelper = process.argv.includes('--real-word') ? require('../electron/services/openXmlHelperService.cjs').createOpenXmlHelperService({ app }) : null;
  const agentService = {
    bindTaskContext() { return this; },
    hasPersistentTaskSession: () => true,
    loadPersistentTask: () => ({ paths: { workspaceDir }, state: persistent }),
    updatePersistentTask(_key, patch) { persistent = { ...persistent, ...patch }; },
    deletePersistentTask() { assert.fail('单节修改不得删除原会话'); },
    async runTask(payload) {
      runs++;
      assert.equal(payload.persistent_task.mode, 'resume');
      assert.equal(payload.task_id, persistent.run_id);
      assert.equal(payload.output_file, file);
      assert.match(payload.prompt, /1.2 改名后的目标/);
      assert.match(payload.prompt, /generate-image-sources 的 images 一次提交/);
      assert.match(payload.prompt, /list-section-images/);
      assert.match(payload.prompt, /apply-section-images/);
      assert.ok(!payload.prompt.includes('其他小节正文'));
      assert.equal(payload.continueTask, undefined);
      if (behavior === 'fail') throw new Error('模拟修改失败');
      if (behavior === 'pause') return new Promise((_, reject) => payload.signal.addEventListener('abort', () => reject(payload.signal.reason), { once: true }));
      const created = await createPiSession({ ...base, sessionFile, summaryEnabled: false, activeTools: payload.active_tools, createTools: payload.create_tools });
      try {
        assert.equal(created.sessionFile, sessionFile);
        assert.ok(created.session.agent.state.messages.some(message => JSON.stringify(message).includes('原正文生成任务')));
        for (const name of ['list-section-images', 'apply-section-images', 'generate-image', 'generate-image-sources', 'render-html-image', 'render-mermaid-image']) assert.ok(created.session.getActiveToolNames().includes(name));
        assert.ok(!created.session.getActiveToolNames().includes('adjust-sections'));
        const { Type } = await import('typebox');
        const imageTools = payload.create_tools({ Type, workspaceDir });
        const listImages = imageTools.find(tool => tool.name === 'list-section-images');
        const applyImages = imageTools.find(tool => tool.name === 'apply-section-images');
        const listed = (await listImages.execute('list', {})).details.results;
        assert.deepEqual(listed.map(item => item.section_id), [first], '单节工具不读取旧决策文件中的其他 targets');
        const image = listed[0].images[0];
        const updatedRef = `图片/单节回填${runs}.png`;
        fs.copyFileSync(path.join(workspaceDir, '图片/原图.png'), path.join(workspaceDir, updatedRef));
        const previousHtml = fs.readFileSync(path.join(workspaceDir, file), 'utf8');
        const results = (await applyImages.execute('apply', { images: [
          { image_id: image.image_id, asset_ref: updatedRef, previous_asset_ref: image.asset_ref },
          { image_id: `${second}/原图`, asset_ref: updatedRef, previous_asset_ref: '' },
        ] })).details.results;
        assert.deepEqual(results.map(item => item.status), ['success', 'error']);
        assert.equal(fs.readFileSync(path.join(workspaceDir, file), 'utf8'), previousHtml.replace(image.asset_ref, updatedRef));
        fs.writeFileSync(path.join(workspaceDir, file), previousHtml, 'utf8');
        const original = fs.readFileSync(path.join(workspaceDir, file), 'utf8').match(/<p>(.*?)<\/p>/)[1];
        let sourceRequested = false;
        created.session.agent.streamFn = () => {
          if (!sourceRequested) {
            sourceRequested = true;
            return response([{ type: 'toolCall', id: `source-${runs}`, name: 'generate-image-sources', arguments: {
              images: [{ image_id: '单节流程图', kind: 'mermaid', prompt: '流程图：准备后实施' }],
            } }], 'toolUse');
          }
          const result = created.session.agent.state.messages.findLast(message => message.role === 'toolResult' && message.toolName === 'generate-image-sources');
          const source = JSON.parse(result.content[0].text).results[0];
          assert.equal(source.status, 'success');
          assert.equal(fs.readFileSync(path.join(workspaceDir, source.source_file), 'utf8'), 'flowchart LR\nA["准备"] --> B["实施"]');
          return response([{ type: 'toolCall', id: `edit-${runs}`, name: 'edit', arguments: {
            path: file, edits: [{ oldText: original, newText: `修改后的说明${runs}` }], task_complete: true,
          } }], 'toolUse');
        };
        await created.session.prompt(payload.prompt, { expandPromptTemplates: false });
        payload.validateOutput();
      } finally { created.session.dispose(); }
      return { workspace_dir: workspaceDir };
    },
  };
  const service = createTaskService({ agentService, aiService: { async chat(request) {
    assert.equal(request.messages[1].content, '流程图：准备后实施');
    return 'flowchart LR\nA["准备"] --> B["实施"]';
  } }, autoConfirmationService: { unregister() {} },
    technicalPlanStore: {
      loadTechnicalPlan: () => structuredClone(state), getContentWordOutputDir: () => outputDir,
      updateTechnicalPlanWithoutReload(patch) {
        const { contentGenerationItem, ...rest } = structuredClone(patch);
        state = { ...state, ...rest };
        if (contentGenerationItem) state.contentGenerationSections[contentGenerationItem.nodeId] = contentGenerationItem.section;
      },
    }, rejectionCheckStore: { loadRejectionCheck: () => ({}) }, duplicateCheckStore: { loadDuplicateCheck: () => ({}) },
    openXmlHelperService: { async createRestrictedHtmlDocx(html, config, options) {
      conversions++;
      assert.equal(html, fs.readFileSync(path.join(workspaceDir, file), 'utf8'), '单节转换应直接使用正文，不附加新旧目录标题');
      assert.equal(options.assetRoot, workspaceDir);
      if (failConversion) throw new Error('模拟转换失败');
      return realHelper ? realHelper.createRestrictedHtmlDocx(html, config, options) : { bytes: Buffer.from(html) };
    } },
  });
  service.subscribeCallback(({ task }) => {
    if (['success', 'error', 'paused'].includes(task.status)) setImmediate(() => terminal?.(task));
  });
  // 等待业务任务完成并释放互斥，不用固定延迟猜测状态。
  function start(payload) {
    return new Promise((resolve, reject) => {
      terminal = resolve;
      try { service.startContentGeneration(payload); } catch (error) { reject(error); }
    });
  }
  try {
    const initial = start({ targetItemId: first, requirement: '整理表达', regenerate: true });
    assert.throws(() => service.startContentGeneration({ targetItemId: second }), /正在执行/);
    assert.equal((await initial).status, 'success');
    assert.equal(runs, 1);
    assert.equal(conversions, 1);
    assert.equal(state.contentGenerationRuntime.html_output.word_sections.length, 2);
    const editedWords = countHtmlWords(fs.readFileSync(path.join(workspaceDir, file), 'utf8'));
    assert.equal(state.contentGenerationRuntime.section_words[first], editedWords);
    assert.equal(state.contentGenerationRuntime.section_words[second], 6);
    assert.equal(state.contentGenerationTask.stats.content.current_words, editedWords + 6);
    assert.equal(state.contentGenerationSections[first].content, '');
    const savedTaskId = state.contentGenerationTask.task_id;
    assert.equal((await start({})).task_id, savedTaskId, '没有待生成项时直接返回已有任务');
    assert.equal(runs, 1, '普通生成不得重新调用 Agent 或删除原会话');
    assert.deepEqual(persistent.consistency, { status: 'completed', round: 3 });
    assert.equal(persistent.word_adjustment_started, true);
    assert.match(fs.readFileSync(path.join(workspaceDir, file), 'utf8'), /修改后的说明1/);
    if (realHelper) {
      const zip = new (require('adm-zip'))(path.join(outputDir, `${first}.docx`));
      assert.match(zip.readAsText('word/document.xml'), /修改后的说明1/);
      assert.doesNotMatch(zip.readAsText('word/document.xml'), /改名后的目标|旧标题/, '小节 Word 不插入目录标题');
    }
    const previousWord = fs.readFileSync(path.join(outputDir, `${first}.docx`));
    failConversion = true;
    assert.equal((await start({ targetItemId: first, requirement: '再整理一次' })).status, 'error');
    assert.deepEqual(fs.readFileSync(path.join(outputDir, `${first}.docx`)), previousWord);
    assert.deepEqual(state.contentGenerationRuntime.html_output.word_sections.map(item => item.section_id), [second]);
    failConversion = false;
    const runsBeforeRetry = runs;
    assert.equal((await start({ retryFailedSections: true })).status, 'success');
    assert.equal(runs, runsBeforeRetry, '转换失败重试不能再次调用 Agent');
    assert.equal(state.contentGenerationTask.stats.content.current_words,
      Object.values(state.contentGenerationRuntime.section_words).reduce((sum, value) => sum + value, 0));
    behavior = 'pause';
    const pausing = start({ targetItemId: first, requirement: '暂停后继续修改' });
    service.pauseContentGeneration();
    assert.equal((await pausing).status, 'paused');
    assert.throws(() => service.startContentGeneration({ targetItemId: second }), /已暂停/);
    behavior = 'edit';
    assert.equal((await start({ resume: true })).status, 'success');
    behavior = 'fail';
    assert.equal((await start({ targetItemId: first, requirement: '失败后继续修改' })).status, 'error');
    behavior = 'edit';
    assert.equal((await start({ retryFailedSections: true })).status, 'success');
    for (const [name, bytes] of untouched) assert.deepEqual(fs.readFileSync(path.join(workspaceDir, name)), bytes, name);
    assert.equal(fs.readFileSync(path.join(outputDir, `${second}.docx`), 'utf8'), '其他小节 Word');
    console.log('单节修改检查通过：同一 Session、原生 edit、三类图片工具、互斥、暂停续接、失败重试、目标 Word 更新和其他产物保留。');
  } finally {
    await realHelper?.close?.();
    // root 仅由本脚本 mkdtemp 创建，清理限制在该独立临时目录。
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 在开发服务器中挂载真实正文页，桥接仅使用测试数据，检查按钮互斥及 Word 刷新。
async function checkPage() {
  const { BrowserWindow } = require('electron');
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadURL('http://127.0.0.1:5173');
    const result = await window.webContents.executeJavaScript(`(async () => {
      const React = (await import('/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
      const { default: Page } = await import('/src/features/technical-plan/pages/ContentEditPage.tsx');
      const { ToastProvider } = await import('/src/shared/ui/ToastProvider.tsx');
      const { DEFAULT_CONTENT_GENERATION_OPTIONS } = await import('/src/features/technical-plan/contentGenerationOptions.ts');
      const tick = () => new Promise(resolve => setTimeout(resolve, 80));
      const check = (value, message) => { if (!value) throw new Error(message); };
      let resolveStart;
      let reads = 0;
      window.yibiao = { config: { load: async () => ({}) }, technicalPlan: { readContentWord: async () => { reads++; return null; } },
        tasks: { startContentGeneration: () => new Promise(resolve => { resolveStart = resolve; }) } };
      const container = document.createElement('div');
      container.style.height = '900px';
      document.body.replaceChildren(container);
      const root = createRoot(container);
      const items = ['one', 'two'].map((id, index) => ({ id, title: '小节' + id, number: String(index + 1), content_mode: 'ai-generate' }));
      let props = { stepNumber: '05', hasOriginalPlan: false, outlineData: { outline: items },
        exportTemplateId: 'template', contentGenerationOptions: DEFAULT_CONTENT_GENERATION_OPTIONS,
        sections: Object.fromEntries(items.map(item => [item.id, { id: item.id, status: 'success', content: '' }])),
        task: { task_id: 'original', status: 'success', logs: [] },
        contentGenerationRuntime: { section_words: { one: 11, two: 21 }, html_output: { word_sections: items.map(item => ({ section_id: item.id, file: item.id + '.docx' })) } },
        onOpenGenerationSettingsAppearance() {}, onContentGenerationReset() {}, onContentSaved() {} };
      const render = async patch => { props = { ...props, ...patch }; root.render(React.createElement(ToastProvider, null, React.createElement(Page, props))); await tick(); };
      const triggers = () => [...container.querySelectorAll('em')].filter(node => node.textContent === '重新生成');
      await render({});
      check(triggers().length === 2, '应显示两节重新生成入口');
      check(container.textContent.includes('共 32 字'), '页面重开后应从持久统计显示全文字数');
      triggers()[0].click(); await tick();
      [...document.querySelectorAll('button')].find(node => node.textContent === '是').click(); await tick();
      [...document.querySelectorAll('button')].find(node => node.textContent === '开始重新生成').click(); await tick();
      check(triggers().every(node => node.getAttribute('aria-disabled') === 'true'), '提交期间应锁住所有入口');
      resolveStart({}); await tick();
      const output = { word_sections: [{ section_id: 'two', file: 'two.docx' }] };
      for (const status of ['running', 'pausing', 'paused']) {
        await render({ task: { task_id: 'modified', status, logs: [] }, contentGenerationRuntime: { target_item_id: 'one', html_output: output } });
        check(triggers().every(node => node.getAttribute('aria-disabled') === 'true'), status + ' 应锁住所有入口');
        triggers()[1].click(); await tick();
        check(!document.querySelector('.content-regenerate-popover'), '锁定期间不能打开其他小节确认框');
      }
      const before = reads;
      await render({ task: { task_id: 'modified', status: 'success', logs: [] }, contentGenerationRuntime: { target_item_id: 'one', html_output: { word_sections: [...output.word_sections, { section_id: 'one', file: 'one.docx' }] } } });
      check(reads > before, '目标转换完成后应重新读取 Word');
      check(triggers().every(node => node.getAttribute('aria-disabled') === 'false'), '完成后应解锁');
      root.unmount();
      return '真实正文页检查通过：提交、运行、暂停锁定全部入口，转换成功重新读取 Word。';
    })()`);
    console.log(result);
  } finally { window.destroy(); }
}

if (process.argv.includes('--ui')) {
  if (process.versions.electron) {
    const { app } = require('electron');
    app.setPath('userData', process.env.YIBIAO_SECTION_UI_DIR);
    app.on('window-all-closed', () => {});
    app.whenReady().then(checkPage).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
  } else {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), '小节页面检查-'));
    const env = { ...process.env, YIBIAO_SECTION_UI_DIR: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      process.exitCode = require('node:child_process').spawnSync(require('electron'), [__filename, '--ui'], { env, windowsHide: true, stdio: 'inherit' }).status || 0;
    } finally {
      assert.equal(path.dirname(directory), os.tmpdir());
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
} else main().catch(error => { console.error(error); process.exitCode = 1; });
