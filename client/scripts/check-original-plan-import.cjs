// 在 client 下运行 node scripts/check-original-plan-import.cjs；使用独立 Electron/SQLite 工作区。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const clientDir = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const testDir = fs.mkdtempSync(path.join(clientDir, '.original-plan-check-'));
  env.YIBIAO_ORIGINAL_IMPORT_TEST_DIR = testDir;
  try {
    const result = spawnSync(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    // Electron 退出后清理，避免进程仍在写入缓存；仅删除本次创建的目录。
    const resolved = path.resolve(testDir);
    if (path.dirname(resolved) === clientDir && path.basename(resolved).startsWith('.original-plan-check-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
} else {
  const { app } = require('electron');
  const testDir = process.env.YIBIAO_ORIGINAL_IMPORT_TEST_DIR;
  app.setPath('userData', testDir);

  // 使用真实 Word 解析、Store 和导出器，检查图片字节及正文引用，而非只验证扩展名。
  async function check() {
    const { Document, Paragraph, ImageRun, Packer } = require('docx');
    const AdmZip = require('adm-zip');
    const { createFileService } = require('../electron/services/fileService.cjs');
    const { createSqliteDatabase } = require('../electron/services/sqliteDatabase.cjs');
    const { createTechnicalPlanStore } = require('../electron/services/technicalPlanStore.cjs');
    const { createTaskLogStore } = require('../electron/services/taskLogStore.cjs');
    const { buildDocxBuffer } = require('../electron/services/exportService.cjs');
    const { originalImageReferences } = require('../electron/services/originalPlanRestoration.cjs');
    const configStore = { load: () => ({ components: { file_parser: { provider: 'local' } } }) };
    const fileService = createFileService({ app, configStore });
    const database = createSqliteDatabase(app);
    try {
      const taskLogStore = createTaskLogStore({ db: database.db });
      const store = createTechnicalPlanStore({ app, db: database.db, fileService, configStore, taskLogStore, agentService: { deletePersistentTask() {} } });
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64');
      const input = path.join(testDir, '中文原方案.docx');
      const doc = new Document({ sections: [{ children: [
        new Paragraph('2.2所投核心产品检测报告'),
        new Paragraph({ children: [new ImageRun({ data: png, type: 'png', transformation: { width: 30, height: 30 } })] }),
        new Paragraph('报告第二页'),
        new Paragraph({ children: [new ImageRun({ data: png, type: 'png', transformation: { width: 40, height: 20 } })] }),
      ] }] });
      fs.writeFileSync(input, await Packer.toBuffer(doc));
      const imported = await store.importOriginalPlanDocument([input]);
      assert.equal(imported.success, true);
      const markdown = store.readOriginalPlanMarkdown();
      const images = originalImageReferences(markdown);
      assert.equal(images.length, 2);
      store.assertOriginalImageFiles(markdown);
      const imagePath = url => path.join(testDir, 'workspace/imported-images', decodeURIComponent(new URL(url).pathname.slice(1)));
      for (const url of images) assert.deepEqual(fs.readFileSync(imagePath(url)), png);
      const tender = await fileService.importTechnicalPlanDocument('招标文件', { filePaths: [input] });
      assert.equal(originalImageReferences(tender.file_content).length, 0, '其他入口保持不提取图片');

      const output = await buildDocxBuffer({ outline: [{ id: '15.4.4', title: '产品技术支持材料', content_mode: 'ai-generate', content: markdown }] });
      const zip = new AdmZip(output);
      const documentXml = zip.readAsText('word/document.xml');
      assert.equal((documentXml.match(/<a:blip\b/g) || []).length, 2, '正式导出须包含两处原图');
      const media = zip.getEntries().filter(entry => entry.entryName.startsWith('word/media/') && !entry.isDirectory);
      assert.ok(media.some(entry => entry.getData().equals(png)), '导出图片字节须与原图一致');

      // 原方案移除后，仍在正文中使用的图片必须能继续显示和导出。
      store.saveOutline({ outline: [{ id: '15.4.4', title: '产品技术支持材料', content_mode: 'ai-generate', content: markdown }] });
      store.saveChapterContent({ nodeId: '15.4.4', content: markdown });
      assert.equal(database.db.prepare('SELECT content FROM technical_plan_outline_nodes WHERE node_id = ?').get('15.4.4').content, markdown);
      await store.removeOriginalPlanDocument();
      for (const url of images) assert.ok(fs.existsSync(imagePath(url)), '正文引用中的旧图片不能清理');
      await store.importOriginalPlanDocument([input]);
      const replacementImages = originalImageReferences(store.readOriginalPlanMarkdown());
      await store.removeOriginalPlanDocument();
      for (const url of replacementImages) assert.ok(!fs.existsSync(imagePath(url)), '未被正文引用的替换图片应清理');
      for (const url of images) assert.ok(fs.existsSync(imagePath(url)));
      // 模拟真实正文 checkpoint：替换原方案、写回新正文、暂停续跑，最后提交终态或重置。
      let previousImages = images;
      for (const outcome of ['success', 'error', 'reset']) {
        const task = { task_id: `cleanup-${outcome}`, status: 'running', progress: 0 };
        store.updateTechnicalPlanWithoutReload({ contentGenerationTask: task });
        await store.importOriginalPlanDocument([input]);
        const nextMarkdown = store.readOriginalPlanMarkdown();
        const nextImages = originalImageReferences(nextMarkdown);
        store.updateTechnicalPlanWithoutReload({
          contentGenerationItem: { nodeId: '15.4.4', section: { status: 'success', content: nextMarkdown } },
          contentGenerationTask: task,
        });
        for (const url of previousImages) assert.ok(fs.existsSync(imagePath(url)), '运行中的旧快照图片须保留');
        store.updateTechnicalPlanWithoutReload({ contentGenerationTask: { ...task, status: 'paused' } });
        for (const url of previousImages) assert.ok(fs.existsSync(imagePath(url)), '暂停时不能清理旧快照');

        // 普通进度提交不扫描图片目录。
        const readdirSync = fs.readdirSync;
        let imageScans = 0;
        fs.readdirSync = function (directory, ...args) {
          if (path.resolve(directory) === path.join(testDir, 'workspace/imported-images')) imageScans += 1;
          return readdirSync.call(this, directory, ...args);
        };
        try {
          store.updateTechnicalPlanWithoutReload({ contentGenerationTask: { ...task, progress: 50 } });
          assert.equal(imageScans, 0);
        } finally {
          fs.readdirSync = readdirSync;
        }

        if (outcome === 'success') {
          store.updateTechnicalPlanWithoutReload({ globalFactsTask: { task_id: 'other-paused', status: 'paused' } });
          store.updateTechnicalPlanWithoutReload({ contentGenerationTask: { ...task, status: outcome } });
          for (const url of previousImages) assert.ok(fs.existsSync(imagePath(url)), '其他暂停任务仍可能使用旧图');
          store.updateTechnicalPlanWithoutReload({ globalFactsTask: { task_id: 'other-paused', status: 'error' } });
        } else {
          store.updateTechnicalPlanWithoutReload(outcome === 'reset'
            ? { invalidateContentGeneration: true }
            : { contentGenerationTask: { ...task, status: outcome } });
        }
        for (const url of previousImages) assert.ok(!fs.existsSync(imagePath(url)), '任务结束或重置后须补清理旧批次');
        for (const url of nextImages) assert.ok(fs.existsSync(imagePath(url)), '当前原方案引用的图片须保留');
        if (outcome === 'reset') store.saveChapterContent({ nodeId: '15.4.4', content: nextMarkdown });
        previousImages = nextImages;
      }

      // 手动正文保存及目录删除都应在提交后回收；仍有任何正文引用时必须保留。
      await store.removeOriginalPlanDocument();
      for (const url of previousImages) assert.ok(fs.existsSync(imagePath(url)));
      store.saveChapterContent({ nodeId: '15.4.4', content: '已移除报告图片' });
      for (const url of previousImages) assert.ok(!fs.existsSync(imagePath(url)), '手动去掉引用后须清理');
      await store.importOriginalPlanDocument([input]);
      const lastMarkdown = store.readOriginalPlanMarkdown();
      const lastImages = originalImageReferences(lastMarkdown);
      store.saveChapterContent({ nodeId: '15.4.4', content: lastMarkdown });
      await store.removeOriginalPlanDocument();
      store.saveOutline({ outlineData: { outline: [] }, reason: 'delete', affectedNodeIds: ['15.4.4'] });
      for (const url of lastImages) assert.ok(!fs.existsSync(imagePath(url)), '删除目录解除引用后须清理');
      assert.throws(() => store.assertOriginalImageFiles('![缺失](yibiao-asset://imported-images/missing/image.png)'), /图片资源缺失/);
      console.log('带图原方案：真实导入/导出、引用保护、任务结束/重置补清理、暂停保留及正文/目录更新清理检查通过。');
    } finally {
      database.close();
    }
  }

  app.whenReady().then(check).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
}
