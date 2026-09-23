const fs = require('node:fs');
const { contextBridge } = require('electron');
const { openDocumentForExport } = require('@docx-editor.dev/core/export');
const { resolveDefaultSurfaceMeasurer } = require('@docx-editor.dev/core/layout');

// 自检与页面预览共用真实 Canvas 字体测量，不能采用导出 API 的近似测量默认值。
contextBridge.exposeInMainWorld('wordLayout', {
  async read(file) {
    await document.fonts.ready;
    const metrics = resolveDefaultSurfaceMeasurer(96 / 72, { context: document.createElement('canvas').getContext('2d') });
    if (metrics.producer !== 'canvas-measurer') throw new Error('Word 格式自检未取得 Canvas 字体测量器');
    const opened = openDocumentForExport(new Uint8Array(fs.readFileSync(file)), { measurer: metrics.measurer, producer: metrics.producer });
    if (!opened.ok) throw new Error(`Word 格式自检解析失败：${JSON.stringify(opened)}`);
    try {
      return JSON.parse(JSON.stringify(await opened.session.layout()));
    } finally {
      opened.session.dispose();
    }
  },
});
