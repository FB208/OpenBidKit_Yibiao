const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildContentGenerationFiles, readContentGenerationResult } = require('../electron/services/contentGenerationAgent.cjs');
const { runContentGenerationTask } = require('../electron/services/contentGenerationTask.cjs');
const { scanGeneratedSections, convertContentSections } = require('../electron/services/contentGenerationOutput.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64');
const body = '<!-- yibiao:block -->\n<p>施工准备与检查</p>\n<!-- yibiao:block -->\n<table><tbody><tr><td><p>责任</p></td><td><p>项目组</p></td></tr></tbody></table>\n<!-- yibiao:block -->\n<figure id="现场图" data-yb-generation="aiImage" data-yb-size="wide"><template data-yb-role="prompt">复用现场图片</template><img alt="现场" data-yb-asset-ref="原图/现场 图片.png"><figcaption>现场情况</figcaption></figure>';

// 使用真实 Agent 输入格式，目录顺序刻意与文件名排序不同。
function createFixture(directory) {
  const outline = [{ id: '1', title: '施工', content_mode: 'ai-generate', children: [
    { id: '1.2', title: '准备 & 检查', content_mode: 'ai-generate' },
    { id: '1.10', title: '交付', content_mode: 'ai-generate' },
  ] }];
  const inputs = buildContentGenerationFiles({
    outline, targets: outline[0].children.map(item => ({ item })), plans: {},
    projectOverview: '施工项目', globalFacts: [{ title: '工期', content: '六十天' }], globalFactsMode: 'placeholder',
    wordControl: {}, generationOptions: { imageQuantity: 'light', useAiImages: true },
    template: { config: { page: { size: 'A4' } } }, documentIds: [],
  });
  for (const file of inputs) {
    const target = path.join(directory, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf8');
  }
  const targets = JSON.parse(fs.readFileSync(path.join(directory, '正文编排决策.json'), 'utf8')).targets;
  fs.mkdirSync(path.join(directory, '正文'), { recursive: true });
  return { outline, targets };
}

// 手动推进真实任务注册的十秒回调，无需等待或调用外部 AI。
async function checkTask(directory) {
  const { Type } = await import('typebox');
  const { outline, targets } = createFixture(directory);
  const timers = new Map();
  const originalSet = global.setInterval;
  const originalClear = global.clearInterval;
  global.setInterval = (callback, interval) => { const handle = {}; timers.set(handle, { callback, interval }); return handle; };
  global.clearInterval = handle => timers.delete(handle);
  const tick = interval => { for (const timer of [...timers.values()]) if (timer.interval === interval) timer.callback(); };
  let state = {
    outlineData: { outline }, globalFacts: [{ title: '工期', content: '六十天' }], globalFactsTask: { status: 'success' },
    contentGenerationOptions: { imageQuantity: 'none' }, contentGenerationSections: {},
    contentGenerationRuntime: { generation_started: true, completed_stages: ['planning'] },
    contentGenerationTask: { status: 'paused', progress: 18 },
  };
  const updates = [];
  // 模拟 Store 的即时快照，防止后续对象修改掩盖当时的状态。
  const checkpoint = (task, patch) => {
    updates.push(structuredClone(task));
    state = { ...state, ...structuredClone(patch || {}), contentGenerationTask: { ...state.contentGenerationTask, ...structuredClone(task) } };
  };
  let aiRuns = 0;
  let conversions = 0;
  let agentFinished = false;
  let failConversion = true;
  let pauseRequested = false;
  let pauseConversion = false;
  let pauseGeneration = false;
  const args = {
    aiService: { chat: async () => body },
    workspaceStore: { loadTechnicalPlan: () => state },
    taskControl: { signal: new AbortController().signal, isPauseRequested: () => pauseRequested },
    updateTask: checkpoint, checkpointTask: checkpoint,
    agentService: {
      hasPersistentTaskSession: () => true, updatePersistentTask() {},
      async runTask(payload) {
        aiRuns++;
        const [generate] = payload.create_tools({ Type, workspaceDir: directory });
        assert.equal([...timers.values()].filter(timer => timer.interval === 10000).length, 1);
        if (pauseGeneration) {
          pauseRequested = true;
          tick(500);
          payload.signal.throwIfAborted();
        }
        fs.writeFileSync(path.join(directory, '正文/other.html'), body);
        fs.writeFileSync(path.join(directory, '正文/1.10.html.tmp'), body);
        fs.writeFileSync(path.join(directory, '正文/1.10.html'), '  \n');
        assert.equal(scanGeneratedSections(directory, targets), 0);
        for (const [index, section] of targets.entries()) {
          await generate.execute('generate', { sections: [{ section_id: section.id, instructions: '施工', references: '' }] });
          assert.equal(state.contentGenerationTask.stats.content.generation_completed, index);
          tick(10000);
          assert.equal(state.contentGenerationTask.stats.content.generation_completed, index + 1);
          const progress = state.contentGenerationTask.progress;
          tick(10000);
          assert.equal(state.contentGenerationTask.progress, progress);
        }
        assert.equal(state.contentGenerationTask.progress, 80);
        assert.equal(conversions, 0, '仅有 HTML 文件时不能触发转换');
        fs.mkdirSync(path.join(directory, '原图'), { recursive: true });
        fs.writeFileSync(path.join(directory, '原图/现场 图片.png'), png);
        fs.writeFileSync(path.join(directory, '正文生成结果.json'), JSON.stringify({ sections: targets.map(section => ({ section_id: section.id, file: section.file, words: 10 })) }));
        payload.validateOutput(null, { workspace_dir: directory });
        agentFinished = true;
        return { workspace_dir: directory };
      },
    },
    openXmlHelperService: { async createRestrictedHtmlDocx(html, config, options) {
      assert.ok(agentFinished);
      assert.equal([...timers.values()].some(timer => timer.interval === 10000), false);
      assert.equal(options.copyAssets, true);
      assert.equal(options.assetRoot, directory);
      assert.equal(config.page.size, 'A4');
      conversions++;
      if (conversions === 1) assert.match(html, /<h2>准备 &amp; 检查<\/h2>/);
      if (conversions === 2 && failConversion) throw new Error('模拟转换失败');
      if (pauseConversion) { pauseRequested = true; tick(500); }
      return { bytes: Buffer.from('mock-docx') };
    } },
  };
  try {
    await assert.rejects(runContentGenerationTask({ ...args, previousState: structuredClone(state), payload: { resume: true } }), /小节 1.10 转 Word 失败/);
    assert.equal(timers.size, 0);
    assert.equal(state.contentGenerationRuntime.html_output.word_sections.length, 1);
    assert.equal(state.contentGenerationTask.progress, 85);
    failConversion = false;
    const failedState = structuredClone(state);
    // 正式 taskService 先保存新任务初始状态，再把原状态通过 previousState 传入。
    state.contentGenerationTask = { status: 'running', progress: 0 };
    await runContentGenerationTask({ ...args, previousState: failedState, payload: { retryFailedSections: true } });
    assert.equal(aiRuns, 1, '转换重试不得再次调用 Agent');
    assert.equal(conversions, 3, '已完成的第一节不得重复转换');
    assert.equal(timers.size, 0);
    assert.equal(state.contentGenerationTask.status, 'success');
    assert.equal(state.contentGenerationTask.progress, 90);
    assert.equal(state.contentGenerationTask.stats.content.output_progress.phase, 'word-completed');
    assert.ok(updates.every(update => update.progress <= 90));
    assert.ok(updates.slice(1).every((update, index) => update.progress >= updates[index].progress));
    assert.ok(updates.some(update => update.progress_detail.phase === 'sections-completed'));
    assert.deepEqual(state.contentGenerationRuntime.html_output.word_sections.map(item => item.section_id), ['1.2', '1.10']);
    assert.deepEqual(fs.readFileSync(path.join(directory, '原图/现场 图片.png')), png);
    checkProgressView(state.contentGenerationTask);
    // 模拟转换中暂停：不保存刚返回的文件，继续时不调用 AI。
    fs.unlinkSync(path.join(directory, 'Word/1.10.docx'));
    state.contentGenerationRuntime.html_output.word_sections = state.contentGenerationRuntime.html_output.word_sections.slice(0, 1);
    state.contentGenerationTask.status = 'paused';
    pauseConversion = true;
    await runContentGenerationTask({ ...args, previousState: structuredClone(state), payload: { resume: true } });
    assert.equal(state.contentGenerationTask.status, 'paused');
    assert.equal(fs.existsSync(path.join(directory, 'Word/1.10.docx')), false);
    assert.equal(timers.size, 0);
    pauseConversion = pauseRequested = false;
    await runContentGenerationTask({ ...args, previousState: structuredClone(state), payload: { resume: true } });
    assert.equal(aiRuns, 1);
    assert.equal(state.contentGenerationTask.status, 'success');
    // 生成中暂停也必须清理十秒扫描；已有 HTML 不触发转换。
    state.contentGenerationRuntime.html_output = undefined;
    state.contentGenerationRuntime.phase = 'generating';
    state.contentGenerationTask.status = 'paused';
    const convertedBeforePause = conversions;
    pauseGeneration = true;
    await runContentGenerationTask({ ...args, previousState: structuredClone(state), payload: { resume: true } });
    assert.equal(state.contentGenerationTask.status, 'paused');
    assert.equal(timers.size, 0);
    assert.equal(conversions, convertedBeforePause);
    console.log('扫描、十秒回调、进度封顶、页面重开、定时器清理、生成/转换暂停及失败续跑通过。');
  } finally {
    global.setInterval = originalSet;
    global.clearInterval = originalClear;
  }
}

// 执行页面实际进度表达式，模拟从数据库重载后没有独立 progress_detail 的状态。
function checkProgressView(task) {
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../src/features/technical-plan/pages/ContentEditPage.tsx'), 'utf8');
  const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ['contentStats', 'progressDetail', 'htmlOutputProgress', 'currentProgressDetail', 'displayProgress', 'displayProgressLabel', 'displayProgressCount'];
  const statements = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) statements.set(node.name.getText(ast), `const ${node.getText(ast)};`);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const evaluate = new Function('task', `const phaseVisible = false; ${names.map(name => statements.get(name)).join('\n')} return [displayProgress, displayProgressLabel, displayProgressCount];`);
  const reloaded = { ...task };
  delete reloaded.progress_detail;
  assert.deepEqual(evaluate(reloaded), [90, '转换完成', '2/2']);
}

// 调用真实助手服务，解包确认正文、表格、图片及中转目录清理。
async function checkRealWord(directory) {
  const { EventEmitter } = require('node:events');
  const { createOpenXmlHelperService } = require('../electron/services/openXmlHelperService.cjs');
  const AdmZip = require('adm-zip');
  const app = new EventEmitter();
  app.isPackaged = false;
  app.getPath = () => path.join(directory, '独立用户数据');
  app.getAppPath = () => path.resolve(__dirname, '..');
  const service = createOpenXmlHelperService({ app, configStore: { load: () => ({}) } });
  try {
    const result = readContentGenerationResult(directory);
    const outputs = await convertContentSections({ result, openXmlHelperService: service, signal: new AbortController().signal });
    for (const output of outputs) {
      const zip = new AdmZip(path.join(directory, output.file));
      const xml = zip.readAsText('word/document.xml');
      assert.match(xml, /施工准备与检查/);
      assert.match(xml, /<w:tbl[ >]/);
      assert.match(xml, /<w:drawing[ >]/);
      assert.ok(zip.getEntries().some(entry => /(^|\/)media\/.+\.png$/i.test(entry.entryName)));
    }
    await assert.rejects(service.createRestrictedHtmlDocx(body.replace('原图/现场 图片.png', '原图/不存在.png'), { page: {} }, { assetRoot: directory, copyAssets: true }));
    assert.equal(fs.readdirSync(path.join(app.getPath(), 'workspace')).some(name => name.startsWith('restricted-html-assets-')), false);
    assert.deepEqual(fs.readFileSync(path.join(directory, '原图/现场 图片.png')), png);
    console.log('真实 OpenXmlHelper：两个独立 Word、表格、图片、中文路径及成功/失败中转清理通过。');
  } finally {
    await service.close();
  }
}

// 所有产物位于独立中文临时目录，不读取或修改用户项目数据。
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '正文转Word检查-'));
  try {
    await checkTask(directory);
    if (process.argv.includes('--real-word')) await checkRealWord(directory);
  } finally {
    if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('正文转Word检查-')) fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
