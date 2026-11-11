const path = require('node:path');
const { BrowserWindow } = require('electron');

const WORKER_READY_TIMEOUT_MS = 30000;

/**
 * 双层 PDF 的隐藏工作窗口：加载 Renderer 的 ?window=dual-layer-pdf-worker 分支，
 * 在其中用 pdfjs 渲染页面、读取文字并做图片文字识别。一批任务共用一个窗口。
 */
async function createWorkerWindow({ getRendererWindowUrl }) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'workerPreload.cjs'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  const destroy = () => {
    if (!window.isDestroyed()) window.destroy();
  };

  // 隐藏窗口没有界面，把其中的警告和错误转到主进程日志，便于排查图片文字识别等问题。
  window.webContents.on('console-message', (details) => {
    if (details.level === 'warning' || details.level === 'error') {
      console.warn('[dual-layer-pdf-worker]', details.message);
    }
  });

  try {
    await window.loadURL(getRendererWindowUrl('dual-layer-pdf-worker'));
    // 工作脚本是按需加载的模块，页面加载完成后还要等它挂到 window 上。
    const ready = await window.webContents.executeJavaScript(`new Promise((resolve) => {
      const deadline = Date.now() + ${WORKER_READY_TIMEOUT_MS};
      const check = () => {
        if (window.dualLayerPdfWorker) resolve(true);
        else if (Date.now() > deadline) resolve(false);
        else setTimeout(check, 50);
      };
      check();
    })`);
    if (!ready) throw new Error('转换组件加载超时');
  } catch (error) {
    destroy();
    throw error;
  }

  return {
    webContents: window.webContents,
    isDestroyed: () => window.isDestroyed(),
    /** 处理一份单层 PDF，页面结果经 dual-layer-pdf-worker:page 逐页提交，返回页数、书签等汇总。 */
    convert(job) {
      const { webContents } = window;
      return new Promise((resolve, reject) => {
        // 窗口被销毁（取消转换）或渲染进程崩溃时，executeJavaScript 不会自己结束，要在这里主动报错。
        const onGone = () => reject(new Error('转换窗口已关闭'));
        webContents.once('destroyed', onGone);
        webContents.once('render-process-gone', onGone);
        webContents.executeJavaScript(`window.dualLayerPdfWorker.convert(${JSON.stringify(job)})`)
          .then(resolve, reject)
          .finally(() => {
            webContents.removeListener('destroyed', onGone);
            webContents.removeListener('render-process-gone', onGone);
          });
      });
    },
    destroy,
  };
}

module.exports = { createWorkerWindow };
