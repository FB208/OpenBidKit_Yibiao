const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// 从 Node 启动隔离的 Electron；无需启动客户端、网络服务或真实 AI。
if (!process.versions.electron) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-layout-check-'));
  const env = { ...process.env, YIBIAO_LAYOUT_TEST_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  if (child.status === 0) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  process.exit(child.status ?? 1);
}

const { app } = require('electron');
const { EventEmitter } = require('node:events');
const { createOpenXmlHelperService } = require('../electron/services/openXmlHelperService.cjs');
const { createTechnicalPlanExport } = require('../electron/services/technicalPlanExport.cjs');
const { cloneDefaultExportFormat } = require('../electron/services/exportFormatDefaults.cjs');
const { readWordLayout, analyzeLayout, runContentLayoutCheck } = require('../electron/services/contentGenerationLayout.cjs');
const directory = process.env.YIBIAO_LAYOUT_TEST_DIR;
app.setPath('userData', path.join(directory, 'electron'));
app.on('window-all-closed', () => {});
const fakeApp = new EventEmitter();
fakeApp.isPackaged = true;
fakeApp.getPath = () => path.join(directory, 'helper-data');
fakeApp.getAppPath = () => path.resolve(__dirname, '..');
let helper;

const text = '项目实施期间，现场人员按照核查清单逐项确认设备状态，及时记录发现的问题并提交复核。负责人检查整改情况，形成完整记录，确保实施过程符合项目要求。';
const figure = '<figure id="现场图" data-yb-size="tall"><img data-yb-asset-ref="图.png"><figcaption>现场核查图</figcaption></figure>';
const paras = n => Array.from({ length: n }, (_, i) => `<p>段落${i}：${text}</p>`).join('');
const signal = new AbortController().signal;

// 真实全书转换与 Canvas 测量验证书签、双栏、补写量和正常章节末尾排除。
async function main() {
  const binaryDir = path.join(directory, 'helper');
  const built = spawnSync('dotnet', ['build', path.resolve(__dirname, '../../openxmlhelper/src/OpenXmlHelper/OpenXmlHelper.csproj'), '--no-restore', '-o', binaryDir, '-v', 'quiet'], { encoding: 'utf8', windowsHide: true });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  process.env.YIBIAO_OPENXML_HELPER_DIR = binaryDir;
  helper = createOpenXmlHelperService({ app: fakeApp, configStore: { load: () => ({}) } });
  fs.mkdirSync(path.join(directory, '正文'));
  fs.writeFileSync(path.join(directory, '图.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64'));
  const format = cloneDefaultExportFormat();
  format.heading_level1_page_break_before = true;
  const outline = [{ id: 'chapter', number: '1', title: '现场核查', content_mode: 'ai-generate', children: [
    { id: 'section', number: '1.1', title: '核查要求', content_mode: 'ai-generate' },
  ] }];
  const persistent = {};
  const agentService = { loadPersistentTask: () => ({ paths: { workspaceDir: directory }, state: persistent }), updatePersistentTask: (_key, state) => Object.assign(persistent, state) };
  const exporter = createTechnicalPlanExport({ technicalPlanStore: { loadTechnicalPlan: () => ({ outlineData: { outline }, exportTemplateScope: 'all' }) },
    templateStore: { getTemplate: () => ({ config: format }) }, agentService, openXmlHelperService: helper });
  const file = path.join(directory, '正文/section.html');
  const inspect = async html => {
    fs.writeFileSync(file, html, 'utf8');
    const output = await exporter.build(exporter.prepare(), { layoutCheck: true });
    const doc = path.join(directory, '检测.docx');
    fs.writeFileSync(doc, output.buffer);
    const layout = await readWordLayout(doc, signal);
    assert.ok(layout.destinations.some(item => item.anchor.name === output.layoutSources[0].name), JSON.stringify(layout.destinations).slice(0,2000));
    return { layout, gaps: analyzeLayout(layout, output.layoutSources, new Set(['section']), format.page.two_column), sources: output.layoutSources };
  };
  const before = paras(11);
  const after = figure + paras(24);
  let initial = await inspect(before + after);
  assert.equal(initial.gaps.length, 1, JSON.stringify(initial.gaps));
  assert.ok(initial.gaps[0].gap_cm >= 3);
  assert.deepEqual(initial.gaps[0].figure_ids, ['现场图']);
  const gap = initial.gaps[0];
  const plain = await exporter.build(exporter.prepare(), {});
  const plainFile = path.join(directory, '正式导出.docx');
  fs.writeFileSync(plainFile, plain.buffer);
  const plainLayout = await readWordLayout(plainFile, signal);
  const boxes = layout => layout.pages.map(page => page.fragments.map(block => ({ kind: block.kind, box: block.box })));
  assert.deepEqual(boxes(initial.layout), boxes(plainLayout), '自检书签不得改变正式文档分页');
  // 按实际正文统计口径生成近似指定字数，模拟子 Agent 写入连贯段落。
  const fill = n => '现场检查人员依次核对设备状态并记录核查结果及时组织复核落实整改责任形成完整记录'.repeat(100).slice(0, n);
  const fixed = await inspect(before + `<p>${fill(gap.suggested_words)}</p>` + after);
  assert.equal(fixed.gaps.length, 0, '按测量建议补写后应消除该明显留白');
  assert.equal(analyzeLayout(initial.layout, initial.sources, new Set(['other'])).length, 0, '局部生成不能补写既有小节');
  assert.equal((await inspect(paras(2))).gaps.length, 0, '文档结尾允许留白');

  const imageText = `<table data-yb-preset="imageText"><tbody><tr><td>${figure}</td><td><p>${text}</p></td></tr></tbody></table>`;
  for (const framed of [false, true]) {
    format.heading_border.enabled = framed;
    const leading = paras(framed ? 11 : 13);
    const image = framed ? figure : imageText;
    const measured = await inspect(leading + image + paras(24));
    assert.equal(measured.gaps.length, 1, `图片表格/章节页框：${JSON.stringify(measured.gaps)}`);
    assert.equal((await inspect(leading + `<p>${fill(measured.gaps[0].suggested_words)}</p>` + image + paras(24))).gaps.length, 0);
  }
  format.heading_border.enabled = false;

  Object.assign(format.page, { paper_size: 'a3', orientation: 'landscape', two_column: true });
  initial = await inspect(paras(11) + figure + paras(45));
  assert.ok(initial.layout.pages.some(page => page.fragments.some(block => block.outlineLevel === 0)
    && page.fragments.some(block => block.styleId === 'Normal' && block.box.width < page.contentBox.width * 0.6)), '通栏一级标题后必须在同页开始双栏正文');
  assert.equal(initial.gaps.length, 1, JSON.stringify(initial.gaps));
  assert.equal(initial.gaps[0].column, 1, '左栏留白必须单独识别');
  const dualFixed = await inspect(paras(11) + `<p>${fill(initial.gaps[0].suggested_words)}</p>` + figure + paras(45));
  assert.equal(dualFixed.gaps.length, 0);
  const rightGap = await inspect(paras(33) + figure + paras(45));
  assert.ok(rightGap.gaps.some(item => item.column === 2), `右栏流向下一页左栏：${JSON.stringify(rightGap.gaps)}`);
  outline.push({ id: 'next', number: '2', title: '下一章', content_mode: 'ai-generate' });
  fs.writeFileSync(path.join(directory, '正文/next.html'), figure + paras(2), 'utf8');
  const chapterEnd = await inspect(paras(2));
  assert.equal(analyzeLayout(chapterEnd.layout, chapterEnd.sources, new Set(['section', 'next']), true).length, 0, '下一章另起页及双栏章节末尾留白不补写');
  outline.pop();
  console.log('通过：真实 Word 转换、Canvas 布局、不可见书签、单栏/双栏定位、补写量和局部范围。');

  // 恢复只继续未成功任务，复查即使仍有留白也不再开启第二轮补写。
  let supplementRuns = 0;
  let measures = 0;
  const output = { buffer: Buffer.from('test'), layoutSources: initial.sources };
  const args = { exporter: { prepare: () => ({ export_format: format }), build: async () => output }, taskKey: 'test', agentService,
    result: { sections: [{ section_id: 'section', file: '正文/section.html', words: 10 }] }, signal,
    layoutDocument: async () => { measures++; return initial.layout; }, onProgress() {},
    supplement: async controller => {
      supplementRuns++;
      controller.save({ ...controller.get(), completed_section_ids: ['section'] });
    },
  };
  await runContentLayoutCheck({ ...args, resume: false });
  assert.equal(supplementRuns, 1);
  assert.equal(measures, 2);
  assert.equal(persistent.layout_check.remaining_gaps.length, 1);
  await runContentLayoutCheck({ ...args, resume: true });
  assert.equal(measures, 2);
  persistent.layout_check.status = 'supplementing';
  await runContentLayoutCheck({ ...args, resume: true });
  assert.equal(supplementRuns, 1, '暂停前完成的小节不应重复补写');
  assert.equal(measures, 3);
  console.log('通过：一轮补写一轮复查、完成与暂停恢复不重复补写。');
}

app.whenReady().then(main).then(async () => {
  await helper?.close();
  app.exit(0);
}, async error => {
  console.error(error);
  console.error(`测试产物：${directory}`);
  await helper?.close();
  app.exit(1);
});
