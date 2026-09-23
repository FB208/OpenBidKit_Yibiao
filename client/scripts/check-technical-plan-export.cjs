// node scripts/check-technical-plan-export.cjs：隔离中文工作区，调用真实 OpenXmlHelper，不读写用户项目。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const AdmZip = require('adm-zip');
const cheerio = require('cheerio');
const { createTechnicalPlanExport } = require('../electron/services/technicalPlanExport.cjs');
const { createOpenXmlHelperService } = require('../electron/services/openXmlHelperService.cjs');
const { cloneDefaultExportFormat, normalizeExportFormat } = require('../electron/services/exportFormatDefaults.cjs');
const { SYSTEM_EXPORT_TEMPLATES } = require('../electron/services/systemExportTemplates.cjs');

/** 在独立 Electron 窗口走真实 preload、IPC、保存及进度订阅，保存对话框定向到临时目录。 */
async function checkIpc(exporter, directory) {
  const { BrowserWindow, dialog } = require('electron');
  const { createExportService } = require('../electron/services/exportService.cjs');
  const { registerExportIpc } = require('../electron/ipc/exportIpc.cjs');
  const output = path.join(directory, '整本 IPC 导出.docx');
  let canceled = false;
  let recorded = 0;
  const showSaveDialog = dialog.showSaveDialog;
  dialog.showSaveDialog = async () => ({ canceled, filePath: output });
  registerExportIpc({
    exportService: createExportService({ configStore: { load: () => ({}) }, getTechnicalPlanExport: () => exporter }),
    donationService: { recordWordExport() { recorded += 1; }, showPrompt() {} },
  });
  const window = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../electron/preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadURL('data:text/html;charset=utf-8,<html><body>整本导出 IPC 检查</body></html>');
    const result = await window.webContents.executeJavaScript(`(async () => {
      const events = [];
      const unsubscribe = window.yibiao.export.onWordExportProgress(event => events.push(event));
      try { return { result: await window.yibiao.export.exportWord({ source: 'technical-plan', requestId: 'whole-check' }), events }; }
      finally { unsubscribe(); }
    })()`);
    assert.equal(result.result.path, output);
    assert.ok(fs.statSync(output).size > 0);
    assert.ok(result.events.every(event => event.requestId === 'whole-check'));
    assert.deepEqual(result.events.filter(event => event.progress === 100).map(event => event.phase), ['success']);
    assert.ok(result.events.some(event => event.progress === 55));
    assert.ok(result.events.some(event => event.progress === 96));
    const original = fs.readFileSync(output);
    canceled = true;
    assert.equal((await window.webContents.executeJavaScript("window.yibiao.export.exportWord({source:'technical-plan'})")).canceled, true);
    assert.deepEqual(fs.readFileSync(output), original);
    assert.equal(recorded, 2);
    console.log('真实 Electron preload/IPC：导出、进度、取消、取消时保留文件及导出记录通过。');
  } finally {
    window.destroy();
    dialog.showSaveDialog = showSaveDialog;
  }
}

/** 从真实 DOCX 中读取正文和关系，便于按文本检查所属段落。 */
function readWord(buffer) {
  const zip = new AdmZip(buffer);
  const $ = cheerio.load(zip.readAsText('word/document.xml'), { xmlMode: true });
  const rels = cheerio.load(zip.readAsText('word/_rels/document.xml.rels'), { xmlMode: true });
  const paragraph = text => $('w\\:p').filter((_, element) => $(element).text().includes(text)).first();
  return { zip, $, rels, paragraph };
}

/** 检查混合范围、排序编号、图片表格、错误定位，以及源文件不受导出影响。 */
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '整本Word导出检查-'));
  const workspaceDir = path.join(directory, '正文 Agent 会话');
  const app = new EventEmitter();
  app.isPackaged = Boolean(process.env.YIBIAO_OPENXML_HELPER_DIR);
  app.getPath = () => path.join(directory, '独立用户数据');
  app.getAppPath = () => path.resolve(__dirname, '..');
  const helper = createOpenXmlHelperService({ app, configStore: { load: () => ({}) } });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64');
  const firstId = 'ffffffff-0000-4000-8000-000000000001';
  const secondId = 'aaaaaaaa-0000-4000-8000-000000000002';
  const figure = '<figure data-yb-size="wide" data-yb-fit="contain"><img data-yb-asset-ref="原图/现场 图片.png"><figcaption>现场图注</figcaption></figure>';
  const body = `<!-- yibiao:block --><p>现场施工正文</p><ul><li>施工检查清单</li></ul><table><caption>设备表题</caption><thead><tr><th>设备</th><th>数量</th></tr></thead><tbody><tr><td>吊车</td><td>一台</td></tr></tbody></table>${figure}`;
  const state = {
    exportTemplateId: 'current', exportTemplateScope: 'ai-only',
    outlineData: { project_name: '中文 & 项目', outline: [
      { id: 'parent', title: '混合父标题', children: [
        { id: firstId, title: '施工 & 安全', content_mode: 'ai-generate', content: '数据库陈旧正文' },
        { id: 'manual', title: '人工资料', content_mode: 'manual-fill', content: `人工正文\n\n- 人工清单\n\n![人工图](data:image/png;base64,${png.toString('base64')})` },
        { id: secondId, title: '交付节点', content_mode: 'ai-generate' },
      ] },
      { id: 'pending', title: '模板节点', content_mode: 'template-fill' },
    ] },
  };
  const config = cloneDefaultExportFormat();
  const visualTemplates = ['tpl-system-a4-visual', 'tpl-system-a3-landscape-visual'].map(id => SYSTEM_EXPORT_TEMPLATES.find(template => template.template_id === id));
  for (const template of visualTemplates) {
    assert.ok(template);
    assert.equal(template.config.heading_border.heading_top_border_space_pt, 5);
    assert.ok(template.config.headings.every(heading => heading.line_spacing === 1.2 && heading.spacing_before_pt === 0 && heading.spacing_after_pt === 0));
    assert.equal(normalizeExportFormat(template.config).heading_border.heading_top_border_space_pt, 5);
  }
  Object.assign(config.heading_border, visualTemplates[0].config.heading_border);
  config.headings = visualTemplates[0].config.headings.map(heading => ({ ...heading }));
  Object.assign(config.page, { paper_size: 'a3', orientation: 'landscape', two_column: true,
    header_enabled: true, header_text: '当前模板页眉', footer_enabled: true, footer_text: '当前模板页脚',
    page_number_enabled: true, page_number_start: 7, first_page_different: true });
  Object.assign(config.body_text, { font: '楷体', size: '三号', list_style: 'square', list_indent_chars: 3 });
  config.headings.forEach(heading => { heading.numbering_format = 'custom'; heading.numbering_template = '{full}'; });
  config.heading_border.enabled = true;
  const exporter = createTechnicalPlanExport({
    technicalPlanStore: { loadTechnicalPlan: () => state },
    templateStore: { getTemplate: () => ({ config }) },
    agentService: { loadPersistentTask: () => ({ paths: { workspaceDir } }) },
    openXmlHelperService: helper,
  });
  const progress = [];
  const build = () => exporter.build(exporter.prepare(), { onProgress: event => progress.push(event.progress), stats: {} });
  try {
    fs.mkdirSync(path.join(workspaceDir, '正文'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, '原图'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '原图/现场 图片.png'), png);
    fs.writeFileSync(path.join(workspaceDir, `正文/${firstId}.html`), body, 'utf8');
    fs.writeFileSync(path.join(workspaceDir, `正文/${secondId}.html`), '<p>交付验收正文</p><ul><li>交付检查清单</li></ul>', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, '正文/已删除小节.html'), '<p>不能导出的孤儿正文</p><img data-yb-asset-ref="不存在.png">', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, '正文/parent.html'), '<p>父章节不应带出的旧正文</p>', 'utf8');
    // 清单只有最后一次任务的一节；整本导出必须仍包含全部当前目录。
    fs.writeFileSync(path.join(workspaceDir, '正文生成结果.json'), JSON.stringify({ sections: [{ section_id: secondId }] }), 'utf8');
    for (const scope of ['ai-only', 'document']) {
      state.exportTemplateScope = scope;
      const { buffer } = await build();
      const { zip, $, rels, paragraph } = readWord(buffer);
      const text = $('w\\:body').text();
      for (const expected of ['1 混合父标题', '1.1 施工 & 安全', '1.2 人工资料', '1.3 交付节点', '2 模板节点', '待模板填写', '现场图注', '设备表题', '人工正文']) assert.ok(text.includes(expected), expected);
      assert.ok(text.indexOf('施工 & 安全') < text.indexOf('交付节点'));
      assert.ok(!text.includes('数据库陈旧正文'));
      assert.ok(!text.includes('不能导出的孤儿正文'));
      assert.ok(!text.includes('父章节不应带出的旧正文'));
      assert.ok(!text.includes('YIBIAO'));
      assert.equal($('w\\:drawing').length, 2);
      const drawingIds = $('wp\\:docPr').toArray().map(element => $(element).attr('id'));
      assert.equal(new Set(drawingIds).size, drawingIds.length, '各样式范围的绘图编号不可重复');
      assert.equal($('w\\:tbl').length, 1);
      assert.ok(zip.getEntries().some(entry => /(^|\/)media\//.test(entry.entryName)));
      for (const label of ['混合父标题', '人工正文', '待模板填写']) assert.equal(paragraph(label).find('w\\:pBdr').length, scope === 'document' ? 1 : 0, label);
      assert.equal(paragraph('现场施工正文').find('w\\:pBdr').length, 1);
      assert.equal(paragraph('交付验收正文').find('w\\:pBdr').length, 1);
      assert.equal(paragraph('设备表题').find('w\\:top').attr('w:color'), config.heading_border.border_color.slice(1).toUpperCase());
      assert.equal(paragraph('设备表题').find('w\\:bottom').attr('w:color'), config.heading_border.border_color.slice(1).toUpperCase());
      assert.equal(paragraph('设备表题').find('w\\:spacing').attr('w:after'), '0');
      assert.equal(paragraph('设备表题').find('w\\:top').attr('w:space'), '1');
      assert.equal($('w\\:tbl').first().find('w\\:tblPr > w\\:tblBorders > w\\:top').attr('w:val'), 'nil');
      assert.equal(paragraph('1.1 施工 & 安全').find('w\\:top').attr('w:space'), '5');
      assert.equal(paragraph('1.1 施工 & 安全').find('w\\:spacing').attr('w:line'), '288');
      assert.equal(paragraph('现场施工正文').find('w\\:bottom').length, 0);
      assert.equal(paragraph('现场施工正文').find('w\\:rFonts').first().attr('w:eastAsia'), '楷体');
      assert.equal(paragraph('人工正文').find('w\\:rFonts').first().attr('w:eastAsia'), scope === 'document' ? '楷体' : '宋体');
      assert.equal($('w\\:pgNumType[w\\:start="7"]').length, 1);
      assert.equal($('w\\:titlePg').length, 0);
      assert.equal($('w\\:headerReference[w\\:type="first"], w\\:footerReference[w\\:type="first"]').length, 0);
      const headerTexts = $('w\\:sectPr').toArray().map(section => {
        const id = $(section).find('w\\:headerReference[w\\:type="default"]').attr('r:id');
        const target = rels('Relationship').filter((_, element) => rels(element).attr('Id') === id).attr('Target');
        assert.ok(target, `页眉关系 ${id} 不存在：${$.xml(section)}`);
        return zip.readAsText(target.startsWith('/') ? target.slice(1) : path.posix.join('word', target));
      });
      assert.ok(headerTexts.some(header => header.includes('当前模板页眉')));
      assert.equal(headerTexts.some(header => !header.includes('当前模板页眉')), scope === 'ai-only');
      // 列表样式单独引用：人工清单不继承模板方块项目符号。
      const numbering = cheerio.load(zip.readAsText('word/numbering.xml'), { xmlMode: true });
      const bullet = label => {
        const id = paragraph(label).find('w\\:numId').attr('w:val');
        const abstract = numbering(`w\\:num[w\\:numId="${id}"]`).find('w\\:abstractNumId').attr('w:val');
        return numbering(`w\\:abstractNum[w\\:abstractNumId="${abstract}"]`).find('w\\:lvlText').first().attr('w:val');
      };
      assert.equal(bullet('施工检查清单'), bullet('交付检查清单'));
      if (scope === 'ai-only') assert.notEqual(bullet('施工检查清单'), bullet('人工清单'));
      else assert.equal(bullet('施工检查清单'), bullet('人工清单'));
    }
    // 整本导出忽略首页不同：两种范围、商务在前/AI 在前的开关结果均相同。
    const originalOutline = state.outlineData.outline;
    for (const outline of [originalOutline, [...originalOutline].reverse()]) {
      state.outlineData.outline = outline;
      for (const scope of ['ai-only', 'document']) {
        state.exportTemplateScope = scope;
        const outputs = [];
        for (const enabled of [false, true]) {
          config.page.first_page_different = enabled;
          const result = readWord((await build()).buffer);
          assert.equal(config.page.first_page_different, enabled, '导出不得改写用户配置');
          assert.equal(result.$('w\\:titlePg').length, 0);
          assert.equal(result.$('w\\:headerReference[w\\:type="first"], w\\:footerReference[w\\:type="first"]').length, 0);
          outputs.push(result.zip.getEntries()
            .filter(entry => /^word\/(document|header\d+|footer\d+)\.xml$/.test(entry.entryName))
            .sort((a, b) => a.entryName.localeCompare(b.entryName))
            // 关系 ID 每次随机生成，不参与版式比较。
            .map(entry => [entry.entryName, result.zip.readAsText(entry.entryName).replace(/\br:(id|embed|link)="[^"]*"/g, 'r:$1="relationship"')]));
        }
        assert.deepEqual(outputs[0], outputs[1], `${scope} 勾选首页不同不应改变正文和页眉页脚`);
      }
    }
    state.outlineData.outline = originalOutline;
    // 未指定整本导出的样张/小节转换继续遵循原设置。
    const sampleHtml = '<h1>一级样张</h1><h2>二级样张</h2><h3>三级样张</h3><h4>四级样张</h4><h5>五级样张</h5><h6>六级样张</h6><p>正文</p><table><caption>样张表题</caption><thead><tr><th>字段</th></tr></thead><tbody><tr><td>内容</td></tr></tbody></table>';
    const sample = readWord(Buffer.from((await helper.createRestrictedHtmlDocx(sampleHtml, config, { assetRoot: workspaceDir, copyAssets: true })).bytes));
    const preview = readWord(Buffer.from((await helper.renderRestrictedHtmlDocx(sampleHtml, config)).bytes));
    for (const document of [sample, preview]) {
      for (const title of ['一级样张', '二级样张', '三级样张', '四级样张', '五级样张', '六级样张']) {
        const heading = document.paragraph(title);
        assert.equal(heading.find('w\\:top').attr('w:space'), '5');
        assert.equal(heading.find('w\\:spacing').attr('w:line'), '288');
        assert.equal(heading.find('w\\:spacing').attr('w:before'), '0');
        assert.equal(heading.find('w\\:spacing').attr('w:after'), '0');
      }
      assert.equal(document.paragraph('样张表题').find('w\\:top').attr('w:color'), config.heading_border.border_color.slice(1).toUpperCase());
      assert.equal(document.paragraph('样张表题').find('w\\:top').attr('w:space'), '1');
      assert.equal(document.paragraph('样张表题').find('w\\:bottom').attr('w:color'), config.heading_border.border_color.slice(1).toUpperCase());
      assert.equal(document.paragraph('样张表题').find('w\\:spacing').attr('w:after'), '0');
      assert.equal(document.$('w\\:tbl').first().find('w\\:tblPr > w\\:tblBorders > w\\:top').attr('w:val'), 'nil');
    }
    assert.equal(sample.$('w\\:titlePg').length, 1);
    assert.equal(sample.$('w\\:headerReference[w\\:type="first"], w\\:footerReference[w\\:type="first"]').length, 2);
    console.log('首页不同：整本导出忽略设置，商务在前/AI 在前、两种模板范围及原有小节转换检查通过。');
    // 切换导出时模板、重排目录，不依赖生成时的快照与编号。
    const children = state.outlineData.outline[0].children;
    [children[0], children[2]] = [children[2], children[0]];
    config.body_text.font = '仿宋';
    config.heading_border.enabled = false;
    let word = readWord((await build()).buffer);
    assert.ok(word.$('w\\:body').text().includes('1.1 交付节点'));
    assert.equal(word.paragraph('现场施工正文').find('w\\:rFonts').first().attr('w:eastAsia'), '仿宋');
    assert.ok(word.$('w\\:cols[w\\:num="1"]').length > 0);
    assert.ok(word.$('w\\:cols[w\\:num="2"]').length > 0);
    assert.equal(word.$('w\\:pgNumType[w\\:start="7"]').length, 1);
    assert.equal(fs.readFileSync(path.join(workspaceDir, `正文/${firstId}.html`), 'utf8'), body);
    assert.deepEqual(fs.readFileSync(path.join(workspaceDir, '原图/现场 图片.png')), png);
    const original = path.join(workspaceDir, `正文/${secondId}.html`);
    fs.renameSync(original, `${original}.missing`);
    await assert.rejects(build(), /交付节点.*ENOENT/s);
    fs.renameSync(`${original}.missing`, original);
    fs.renameSync(path.join(workspaceDir, '原图/现场 图片.png'), path.join(workspaceDir, '原图/暂存.png'));
    await assert.rejects(build(), /施工 & 安全.*现场 图片/s);
    fs.renameSync(path.join(workspaceDir, '原图/暂存.png'), path.join(workspaceDir, '原图/现场 图片.png'));
    assert.equal(fs.readdirSync(path.join(app.getPath(), 'workspace')).some(name => name.startsWith('restricted-html-assets-')), false);
    assert.ok(progress.includes(55));
    assert.ok(progress.every(value => value < 100));
    if (process.versions.electron) await checkIpc(exporter, directory);
    // 一份较长正文覆盖整本转换，不额外构造多套测试框架。
    fs.writeFileSync(original, '<p>这是长篇技术方案正文，用于检查整本转换时是否完整保留段落。</p>'.repeat(3000), 'utf8');
    const started = performance.now();
    word = readWord((await build()).buffer);
    assert.equal(word.$('w\\:p').filter((_, element) => word.$(element).text().includes('这是长篇技术方案正文')).length, 3000);
    console.log(`整本导出检查通过；3000 段正文转换 ${(performance.now() - started).toFixed(0)} ms。`);
  } finally {
    await helper.close();
    if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('整本Word导出检查-')) fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv.includes('--ipc') && !process.versions.electron) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), '整本导出IPC-'));
  const env = { ...process.env, YIBIAO_WORD_EXPORT_CHECK_DIR: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = require('node:child_process').spawnSync(require('electron'), [__filename, '--ipc'], { env, stdio: 'inherit', windowsHide: true });
    process.exitCode = result.status ?? 1;
  } finally {
    if (path.dirname(userData) === path.resolve(os.tmpdir()) && path.basename(userData).startsWith('整本导出IPC-')) fs.rmSync(userData, { recursive: true, force: true });
  }
} else if (process.versions.electron) {
  const { app } = require('electron');
  app.setPath('userData', process.env.YIBIAO_WORD_EXPORT_CHECK_DIR);
  app.on('window-all-closed', () => {});
  app.whenReady().then(main).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
} else {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
