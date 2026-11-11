const path = require('node:path');
const { BrowserWindow } = require('electron');

const WORKER_READY_TIMEOUT_MS = 30000;

/**
 * 双层 PDF 的隐藏工作窗口：加载 Renderer 的 ?window=dual-layer-pdf-worker 分支，
 * 在其中用 pdfjs 渲染页面、读取文字并做图片文字识别。一批任务共用一个窗口。
 *
 * 窗口一创建就返回，加载在 ready 里继续进行，这样加载期间的取消和退出也能销毁它。
 */
function createWorkerWindow({ getRendererWindowUrl }) {
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
  const { webContents } = window;

  // 隐藏窗口没有界面，把其中的警告和错误转到主进程日志，便于排查图片文字识别等问题。
  webContents.on('console-message', (details) => {
    if (details.level === 'warning' || details.level === 'error') {
      console.warn('[dual-layer-pdf-worker]', details.message);
    }
  });

  // 窗口被销毁（取消转换）或渲染进程崩溃后，loadURL 和 executeJavaScript 不会自己结束，要在这里主动报错。
  const untilGone = (start) => new Promise((resolve, reject) => {
    const onGone = () => reject(new Error('转换窗口已关闭'));
    webContents.once('destroyed', onGone);
    webContents.once('render-process-gone', onGone);
    start().then(resolve, reject).finally(() => {
      webContents.removeListener('destroyed', onGone);
      webContents.removeListener('render-process-gone', onGone);
    });
  });

  async function load() {
    await window.loadURL(getRendererWindowUrl('dual-layer-pdf-worker'));
    // 工作脚本是按需加载的模块，页面加载完成后还要等它挂到 window 上。
    await webContents.executeJavaScript(`new Promise((resolve) => {
      const check = () => {
        if (window.dualLayerPdfWorker) resolve(true);
        else setTimeout(check, 50);
      };
      check();
    })`);
  }

  // 页面在等待期间被刷新时（开发服务器重新处理依赖后会刷新）executeJavaScript 也不会结束，所以超时在这里计。
  const ready = untilGone(() => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('转换组件加载超时')), WORKER_READY_TIMEOUT_MS);
    load().then(resolve, reject).finally(() => clearTimeout(timer));
  }));

  return {
    webContents,
    /** 页面和工作脚本加载完成；加载失败、超时或窗口被销毁时报错。 */
    ready,
    isDestroyed: () => window.isDestroyed(),
    /** 处理一份单层 PDF，页面结果经 dual-layer-pdf-worker:page 逐页提交，返回页数、书签等汇总。 */
    convert(job) {
      return untilGone(() => webContents.executeJavaScript(`window.dualLayerPdfWorker.convert(${JSON.stringify(job)})`));
    },
    destroy() {
      if (!window.isDestroyed()) window.destroy();
    },
  };
}

module.exports = { createWorkerWindow };
