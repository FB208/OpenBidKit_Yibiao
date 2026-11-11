const fs = require('node:fs');
const path = require('node:path');
const { contextBridge, ipcRenderer } = require('electron');

const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));

// 双层 PDF 隐藏工作窗口的桥：只提供读本地文件和提交页面结果，不暴露主窗口的 window.yibiao。
contextBridge.exposeInMainWorld('dualLayerPdfHost', {
  /** 读取 pdfjs-dist 自带的字符映射表、标准字体等资源（相对其包目录的路径），不必另外打包一份。 */
  readPdfjsAsset(relativePath) {
    return new Uint8Array(fs.readFileSync(path.join(PDFJS_DIR, relativePath)));
  },

  getFileSize(filePath) {
    return fs.statSync(filePath).size;
  },

  /** 读取文件的 [begin, end) 字节，供 pdfjs 按需加载大文件。 */
  readFileRange(filePath, begin, end) {
    const buffer = Buffer.alloc(end - begin);
    const fd = fs.openSync(filePath, 'r');
    try {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, begin);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  },

  /** 读取依赖目录里的文件；文件不存在时返回 null。 */
  readFile(filePath) {
    try {
      return new Uint8Array(fs.readFileSync(filePath));
    } catch {
      return null;
    }
  },

  /** 提交一页的图片和文字，等 Main 写入完成后再处理下一页。 */
  submitPage(payload) {
    return ipcRenderer.invoke('dual-layer-pdf-worker:page', payload);
  },
});
