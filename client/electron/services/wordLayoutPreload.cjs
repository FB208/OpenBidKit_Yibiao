const fs = require('node:fs');
const { contextBridge } = require('electron');
const { openDocumentForExport } = require('@docx-editor.dev/core/export');
const { resolveDefaultSurfaceMeasurer } = require('@docx-editor.dev/core/layout');

// 自检与页面预览共用真实 Canvas 字体测量，不能采用导出 API 的近似测量默认值。
async function readLayout(file, project) {
  await document.fonts.ready;
  const metrics = resolveDefaultSurfaceMeasurer(96 / 72, { context: document.createElement('canvas').getContext('2d') });
  if (metrics.producer !== 'canvas-measurer') throw new Error('Word 格式自检未取得 Canvas 字体测量器');
  const opened = openDocumentForExport(new Uint8Array(fs.readFileSync(file)), { measurer: metrics.measurer, producer: metrics.producer });
  if (!opened.ok) throw new Error(`Word 格式自检解析失败：${JSON.stringify(opened)}`);
  try {
    return project(await opened.session.layout());
  } finally {
    opened.session.dispose();
  }
}

contextBridge.exposeInMainWorld('wordLayout', {
  read(file) {
    return readLayout(file, layout => JSON.parse(JSON.stringify(layout)));
  },
  // 只返回页数、各页显示页码和指定前缀书签所在页，避免整份版式跨进程传输。
  readAnchors(file, prefix) {
    return readLayout(file, layout => ({
      pageCount: layout.pages.length,
      pages: layout.pages.map(page => page.pageFieldSource?.pageNumber ?? page.index + 1),
      destinations: (layout.destinations || [])
        .filter(destination => destination.anchor?.name?.startsWith(prefix))
        .map(destination => [destination.anchor.name, destination.pageIndex]),
    }));
  },
});
