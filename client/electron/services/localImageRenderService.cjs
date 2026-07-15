const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, app: electronApp } = require('electron');

const DEFAULT_COMPONENT_CONCURRENCY = 5;
const MIN_COMPONENT_CONCURRENCY = 1;
const MAX_COMPONENT_CONCURRENCY = 20;
/** Mermaid 本地渲染参考宽度（约 A4 正文可用宽） */
const WORD_FRIENDLY_RENDER_WIDTH = 680;
/** HTML 配图设计宽度，与生成 Prompt 一致；导出 Word 时再等比缩小 */
const HTML_DESIGN_WIDTH = 1240;
const MERMAID_RENDER_TIMEOUT_MS = 30000;
const HTML_RENDER_TIMEOUT_MS = 120000;
const MAX_CAPTURE_SEGMENT_HEIGHT = 8192;
const LAYOUT_SETTLE_MS = 120;
const PAUSE_POLL_MS = 100;

let serviceInstance = null;

// 若调用方已请求暂停则立即抛出。
function throwIfPaused(options, fallbackMessage = '转图已暂停') {
  if (options?.isPauseRequested?.()) {
    throw options.createPauseError?.() || new Error(fallbackMessage);
  }
}

// 限制组件并发量到合法区间。
function clampConcurrency(value, fallback = DEFAULT_COMPONENT_CONCURRENCY) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_COMPONENT_CONCURRENCY, Math.max(MIN_COMPONENT_CONCURRENCY, Math.round(number)));
}

// 解析 mermaid 浏览器脚本路径。
function resolveMermaidBrowserScript() {
  try {
    return require.resolve('mermaid/dist/mermaid.min.js');
  } catch {
    const candidates = [
      path.join(electronApp.getAppPath(), 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
      path.join(__dirname, '..', '..', 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error('未找到 mermaid 浏览器脚本，无法本地渲染 Mermaid');
  }
}

// 简易异步并发池。
function createConcurrencyPool(getLimit) {
  let active = 0;
  const queue = [];

  function pump() {
    const limit = Math.max(1, Number(getLimit()) || DEFAULT_COMPONENT_CONCURRENCY);
    while (active < limit && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  return function run(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
  };
}

// 等待指定毫秒。
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 创建隐藏渲染窗口。
function createRenderWindow(width, height) {
  const win = new BrowserWindow({
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  return win;
}

// 确保页面调试器已附着。
async function ensureDebugger(webContents) {
  if (!webContents.debugger.isAttached()) {
    webContents.debugger.attach('1.3');
  }
}

// 设置设备视口尺寸。
async function setDeviceMetrics(webContents, width, height) {
  await ensureDebugger(webContents);
  await webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    deviceScaleFactor: 1,
    mobile: false,
  });
}

// 截取指定矩形区域 PNG。
async function captureClip(webContents, clip) {
  await ensureDebugger(webContents);
  const result = await webContents.debugger.sendCommand('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    clip: {
      x: clip.x,
      y: clip.y,
      width: clip.width,
      height: clip.height,
      scale: 1,
    },
  });
  if (!result?.data) throw new Error('页面截图失败：未返回图像数据');
  return Buffer.from(result.data, 'base64');
}

// 用 nativeImage 纵向无缝拼接多段 PNG。
function stitchPngVertically(buffers, totalWidth, totalHeight) {
  const { nativeImage } = require('electron');
  const canvas = Buffer.alloc(totalWidth * totalHeight * 4, 255);
  let offsetY = 0;
  for (const buffer of buffers) {
    const image = nativeImage.createFromBuffer(buffer);
    const size = image.getSize();
    const bitmap = image.toBitmap();
    const rowBytes = size.width * 4;
    for (let y = 0; y < size.height; y += 1) {
      const srcStart = y * rowBytes;
      const destStart = ((offsetY + y) * totalWidth) * 4;
      bitmap.copy(canvas, destStart, srcStart, srcStart + rowBytes);
    }
    offsetY += size.height;
  }
  const stitched = nativeImage.createFromBitmap(canvas, { width: totalWidth, height: totalHeight });
  const png = stitched.toPNG();
  if (!png?.length) throw new Error('拼接截图失败');
  return png;
}

// 按内容高度完整截图，必要时分段后无缝拼接。
async function captureFullContent(webContents, width, height, options = {}) {
  throwIfPaused(options);
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  if (safeHeight <= MAX_CAPTURE_SEGMENT_HEIGHT) {
    await setDeviceMetrics(webContents, safeWidth, safeHeight);
    throwIfPaused(options);
    const buffer = await captureClip(webContents, {
      x: 0,
      y: 0,
      width: safeWidth,
      height: safeHeight,
    });
    return { buffer, width: safeWidth, height: safeHeight };
  }

  const segments = [];
  let y = 0;
  while (y < safeHeight) {
    throwIfPaused(options);
    const segmentHeight = Math.min(MAX_CAPTURE_SEGMENT_HEIGHT, safeHeight - y);
    await setDeviceMetrics(webContents, safeWidth, Math.min(safeHeight, y + segmentHeight));
    const buffer = await captureClip(webContents, {
      x: 0,
      y,
      width: safeWidth,
      height: segmentHeight,
    });
    segments.push(buffer);
    y += segmentHeight;
  }
  const buffer = stitchPngVertically(segments, safeWidth, safeHeight);
  return { buffer, width: safeWidth, height: safeHeight };
}

// 轮询页面资源与布局状态（单次不阻塞，便于主进程响应暂停）。
// contentOnly：只量 #yibiao-capture-root 内容包围盒，避免 body 固定宽导致右侧留白。
async function probeLayoutMetrics(webContents, minWidth, contentOnly = false) {
  const floorWidth = Math.max(1, Math.round(Number(minWidth) || 1));
  return webContents.executeJavaScript(`(() => {
    const contentOnly = ${contentOnly ? 'true' : 'false'};
    const root = document.documentElement;
    const body = document.body;
    const target = document.getElementById('yibiao-capture-root') || body || root;
    if (!target) return { ready: false, width: 0, height: 0 };
    const images = Array.from(document.images || []);
    const imagesReady = images.every((img) => img.complete);
    const fontsReady = !document.fonts || document.fonts.status === 'loaded' || document.fonts.status === 'idle';
    const rect = target.getBoundingClientRect();
    let width;
    let height;
    if (contentOnly) {
      // 仅量捕获根节点（含 padding）；SVG 异常小时回退 viewBox / getBBox。
      width = Math.ceil(Math.max(rect.width, target.scrollWidth || 0, 1));
      height = Math.ceil(Math.max(rect.height, target.scrollHeight || 0, 1));
      const svg = target.querySelector && target.querySelector('svg');
      if (svg && (width < 24 || height < 24)) {
        let svgW = 0;
        let svgH = 0;
        const attrW = parseFloat(svg.getAttribute('width') || '');
        const attrH = parseFloat(svg.getAttribute('height') || '');
        if (Number.isFinite(attrW) && Number.isFinite(attrH) && attrW > 0 && attrH > 0) {
          svgW = attrW;
          svgH = attrH;
        } else {
          const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\\s,]+/).map(Number);
          if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
            svgW = vb[2];
            svgH = vb[3];
          } else {
            try {
              const box = svg.getBBox();
              if (box && box.width > 0 && box.height > 0) {
                svgW = box.width;
                svgH = box.height;
              }
            } catch {}
          }
        }
        if (svgW > 0 && svgH > 0) {
          width = Math.ceil(svgW + 16);
          height = Math.ceil(svgH + 16);
        }
      }
    } else {
      width = Math.ceil(Math.max(
        rect.width,
        target.scrollWidth || 0,
        body?.scrollWidth || 0,
        root?.scrollWidth || 0,
        ${floorWidth},
      ));
      height = Math.ceil(Math.max(
        rect.height,
        target.scrollHeight || 0,
        body?.scrollHeight || 0,
        root?.scrollHeight || 0,
        1,
      ));
    }
    return { ready: imagesReady && fontsReady && width > 0 && height > 0, width, height };
  })()`, true);
}

// 等待页面布局与资源稳定，并返回内容真实宽高；等待期间响应暂停。
async function waitForLayoutReady(webContents, timeoutMs, minWidth = 1, options = {}) {
  const contentOnly = options.contentOnly === true;
  const started = Date.now();
  let stableSince = 0;
  let lastKey = '';

  while (Date.now() - started < timeoutMs) {
    throwIfPaused(options);
    try {
      const metrics = await probeLayoutMetrics(webContents, minWidth, contentOnly);
      if (metrics?.ready && metrics.width > 0 && metrics.height > 0) {
        const key = `${metrics.width}x${metrics.height}`;
        if (key !== lastKey) {
          lastKey = key;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= LAYOUT_SETTLE_MS) {
          return { width: metrics.width, height: metrics.height };
        }
      } else {
        lastKey = '';
        stableSince = 0;
      }
    } catch {
      lastKey = '';
      stableSince = 0;
    }
    await delay(PAUSE_POLL_MS);
  }
  throw new Error('等待页面布局稳定超时');
}

// 包装 HTML：按设计宽度 1240 渲染，完整保留内容，导出时再缩放。
function buildHtmlDocument(html) {
  const source = String(html || '').trim();
  const baseStyles = `
html, body {
  margin: 0 !important;
  padding: 0 !important;
  background: #ffffff !important;
  width: ${HTML_DESIGN_WIDTH}px !important;
  min-width: ${HTML_DESIGN_WIDTH}px !important;
  overflow-x: visible !important;
  box-sizing: border-box !important;
}
*, *::before, *::after { box-sizing: border-box; }
#yibiao-capture-root {
  display: block;
  width: ${HTML_DESIGN_WIDTH}px;
  min-width: ${HTML_DESIGN_WIDTH}px;
  margin: 0;
  padding: 0;
  background: #ffffff;
  overflow: visible;
}
img, svg, canvas, video { max-width: 100%; height: auto; }
`;
  const styleTag = `<style id="yibiao-capture-style">${baseStyles}</style>`;
  const wrapScript = `<script>
(() => {
  const body = document.body;
  if (!body || document.getElementById('yibiao-capture-root')) return;
  const root = document.createElement('div');
  root.id = 'yibiao-capture-root';
  while (body.firstChild) root.appendChild(body.firstChild);
  body.appendChild(root);
})();
</script>`;

  if (/<html[\s>]/i.test(source)) {
    let next = source;
    if (/<head[\s>]/i.test(next)) {
      next = next.replace(/<head([^>]*)>/i, `<head$1><meta charset="utf-8">${styleTag}`);
    } else {
      next = next.replace(/<html([^>]*)>/i, `<html$1><head><meta charset="utf-8">${styleTag}</head>`);
    }
    if (/<\/body>/i.test(next)) {
      next = next.replace(/<\/body>/i, `${wrapScript}</body>`);
    } else {
      next = `${next}${wrapScript}`;
    }
    return next;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  ${styleTag}
</head>
<body>
  <div id="yibiao-capture-root">${source}</div>
</body>
</html>`;
}

// 构建 Mermaid 本地渲染页面：保留 SVG 真实尺寸，过宽时等比缩小，页面随内容收缩。
function buildMermaidDocument(code, mermaidScriptUrl) {
  const escaped = JSON.stringify(String(code || ''));
  const maxContentWidth = WORD_FRIENDLY_RENDER_WIDTH - 16;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      width: fit-content;
      height: fit-content;
      overflow: hidden;
    }
    #yibiao-capture-root {
      display: inline-block;
      margin: 0;
      padding: 8px;
      background: #ffffff;
      width: fit-content;
      height: fit-content;
      min-width: 1px;
      min-height: 1px;
      line-height: 0;
    }
    #yibiao-capture-root svg {
      display: block;
    }
  </style>
  <script src="${mermaidScriptUrl}"></script>
</head>
<body>
  <div id="yibiao-capture-root"></div>
  <script>
    (async () => {
      try {
        const code = ${escaped};
        const maxW = ${maxContentWidth};
        window.__yibiaoMermaidReady = false;
        window.__yibiaoMermaidError = '';
        mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
        const id = 'mermaid-' + Date.now();
        const { svg } = await mermaid.render(id, code);
        const root = document.getElementById('yibiao-capture-root');
        root.innerHTML = svg;
        const svgEl = root.querySelector('svg');
        if (svgEl) {
          // 解析 mermaid 给出的固有尺寸；禁止直接删除 width/height，否则会塌成白图小黑点。
          const parseSize = (value) => {
            const n = parseFloat(String(value || '').replace('px', '').trim());
            return Number.isFinite(n) && n > 0 ? n : 0;
          };
          let w = parseSize(svgEl.getAttribute('width'));
          let h = parseSize(svgEl.getAttribute('height'));
          if (!w || !h) {
            const vb = String(svgEl.getAttribute('viewBox') || '').trim().split(/[\\s,]+/).map(Number);
            if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
              w = vb[2];
              h = vb[3];
            }
          }
          if (!w || !h) {
            try {
              const box = svgEl.getBBox();
              if (box && box.width > 0 && box.height > 0) {
                w = box.width;
                h = box.height;
              }
            } catch {}
          }
          if (w > 0 && h > 0) {
            const scale = w > maxW ? (maxW / w) : 1;
            const outW = Math.max(1, Math.round(w * scale));
            const outH = Math.max(1, Math.round(h * scale));
            svgEl.setAttribute('width', String(outW));
            svgEl.setAttribute('height', String(outH));
            svgEl.style.width = outW + 'px';
            svgEl.style.height = outH + 'px';
            svgEl.style.maxWidth = 'none';
          }
        }
        window.__yibiaoMermaidReady = true;
      } catch (error) {
        window.__yibiaoMermaidError = error && error.message ? error.message : String(error || 'Mermaid 渲染失败');
        window.__yibiaoMermaidReady = true;
      }
    })();
  </script>
</body>
</html>`;
}

// 写入临时 HTML 文件并加载，便于引用本地 mermaid 脚本；加载期间响应暂停。
async function loadHtmlDocument(win, html, timeoutMs, options = {}) {
  throwIfPaused(options);
  const tempDir = path.join(os.tmpdir(), 'yibiao-local-image-render');
  fs.mkdirSync(tempDir, { recursive: true });
  const tempFile = path.join(tempDir, `render-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(tempFile, html, 'utf-8');
  const fileUrl = pathToFileURL(tempFile).href;

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error('加载渲染页面超时')), timeoutMs);
      const pauseWatcher = options.isPauseRequested
        ? setInterval(() => {
          if (options.isPauseRequested?.() && !settled) {
            try {
              win.webContents.stop();
            } catch {
              // ignore
            }
            finish(options.createPauseError?.() || new Error('转图已暂停'));
          }
        }, PAUSE_POLL_MS)
        : null;

      const cleanup = () => {
        clearTimeout(timer);
        if (pauseWatcher) clearInterval(pauseWatcher);
        win.webContents.removeListener('did-finish-load', onLoad);
        win.webContents.removeListener('did-fail-load', onFail);
      };

      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };

      const onLoad = () => finish(null);
      const onFail = (_event, code, description) => {
        if (options.isPauseRequested?.()) {
          finish(options.createPauseError?.() || new Error('转图已暂停'));
          return;
        }
        finish(new Error(`加载渲染页面失败：${description || code}`));
      };

      win.webContents.once('did-finish-load', onLoad);
      win.webContents.once('did-fail-load', onFail);
      win.loadURL(fileUrl).catch((error) => {
        if (options.isPauseRequested?.()) {
          finish(options.createPauseError?.() || new Error('转图已暂停'));
          return;
        }
        finish(error);
      });
    });
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // ignore
    }
  }
}

// 关闭窗口并拆卸调试器。
function destroyWindow(win) {
  if (!win || win.isDestroyed()) return;
  try {
    if (win.webContents?.debugger?.isAttached?.()) {
      win.webContents.debugger.detach();
    }
  } catch {
    // ignore
  }
  win.destroy();
}

// 在超时控制下执行任务。
async function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 创建本地图片渲染服务。
function createLocalImageRenderService({ configStore } = {}) {
  const runMermaid = createConcurrencyPool(() => clampConcurrency(
    configStore?.load?.()?.components?.mermaid_concurrency_limit,
    DEFAULT_COMPONENT_CONCURRENCY,
  ));
  const runHtml = createConcurrencyPool(() => clampConcurrency(
    configStore?.load?.()?.components?.html_concurrency_limit,
    DEFAULT_COMPONENT_CONCURRENCY,
  ));

  // 本地渲染 Mermaid 为 PNG。
  async function renderMermaidToPng(code, options = {}) {
    return runMermaid(async () => {
      throwIfPaused(options, 'Mermaid 转图已暂停');
      const mermaidScriptPath = resolveMermaidBrowserScript();
      const mermaidScriptUrl = pathToFileURL(mermaidScriptPath).href;
      const html = buildMermaidDocument(code, mermaidScriptUrl);
      const win = createRenderWindow(WORD_FRIENDLY_RENDER_WIDTH, 480);
      try {
        await withTimeout(
          loadHtmlDocument(win, html, MERMAID_RENDER_TIMEOUT_MS, options),
          MERMAID_RENDER_TIMEOUT_MS,
          'Mermaid 页面加载超时',
        );
        // 先给足够视口，让 SVG 按固有尺寸排版后再量内容包围盒。
        await setDeviceMetrics(win.webContents, WORD_FRIENDLY_RENDER_WIDTH, 1200);
        const ready = await withTimeout((async () => {
          const started = Date.now();
          while (Date.now() - started < MERMAID_RENDER_TIMEOUT_MS) {
            throwIfPaused(options, 'Mermaid 转图已暂停');
            const state = await win.webContents.executeJavaScript(`({
              ready: Boolean(window.__yibiaoMermaidReady),
              error: String(window.__yibiaoMermaidError || ''),
            })`, true);
            if (state.ready) return state;
            await delay(PAUSE_POLL_MS);
          }
          throw new Error('Mermaid 渲染超时');
        })(), MERMAID_RENDER_TIMEOUT_MS, 'Mermaid 渲染超时');
        if (ready.error) throw new Error(ready.error);
        const metrics = await waitForLayoutReady(win.webContents, MERMAID_RENDER_TIMEOUT_MS, 1, {
          ...options,
          contentOnly: true,
        });
        // 按内容包围盒截图，不强制铺满 680；过宽已在页面内等比缩小。
        const rawWidth = Math.ceil(metrics.width || 0);
        const rawHeight = Math.ceil(metrics.height || 0);
        if (rawWidth < 24 || rawHeight < 24) {
          throw new Error(`Mermaid 内容尺寸异常（${rawWidth}x${rawHeight}），可能未正确渲染`);
        }
        const width = Math.min(WORD_FRIENDLY_RENDER_WIDTH, Math.max(1, rawWidth));
        const height = Math.max(1, rawHeight);
        return await captureFullContent(win.webContents, width, height, options);
      } finally {
        destroyWindow(win);
      }
    });
  }

  // 本地将 HTML 按设计宽度完整截取为 PNG（导出 Word 时再缩放）。
  async function renderHtmlToPng(html, options = {}) {
    return runHtml(async () => {
      throwIfPaused(options, 'HTML 转图已暂停');
      const documentHtml = buildHtmlDocument(html);
      const win = createRenderWindow(HTML_DESIGN_WIDTH, 900);
      try {
        await withTimeout(
          loadHtmlDocument(win, documentHtml, HTML_RENDER_TIMEOUT_MS, options),
          HTML_RENDER_TIMEOUT_MS,
          'HTML 页面加载超时',
        );
        throwIfPaused(options, 'HTML 转图已暂停');
        // 先按设计宽设置视口，避免窄窗把 1240 布局挤乱。
        await setDeviceMetrics(win.webContents, HTML_DESIGN_WIDTH, 900);
        const metrics = await withTimeout(
          waitForLayoutReady(win.webContents, HTML_RENDER_TIMEOUT_MS, HTML_DESIGN_WIDTH, options),
          HTML_RENDER_TIMEOUT_MS,
          'HTML 布局等待超时',
        );
        const width = Math.max(HTML_DESIGN_WIDTH, Math.ceil(metrics.width || 0));
        const height = Math.max(1, Math.ceil(metrics.height || 0));
        throwIfPaused(options, 'HTML 转图已暂停');
        return await captureFullContent(win.webContents, width, height, options);
      } finally {
        destroyWindow(win);
      }
    });
  }

  return {
    renderMermaidToPng,
    renderHtmlToPng,
    wordFriendlyRenderWidth: WORD_FRIENDLY_RENDER_WIDTH,
    htmlDesignWidth: HTML_DESIGN_WIDTH,
  };
}

// 初始化全局本地转图服务。
function initLocalImageRenderService(options = {}) {
  serviceInstance = createLocalImageRenderService(options);
  return serviceInstance;
}

// 获取全局本地转图服务。
function getLocalImageRenderService() {
  if (!serviceInstance) {
    serviceInstance = createLocalImageRenderService();
  }
  return serviceInstance;
}

module.exports = {
  HTML_DESIGN_WIDTH,
  WORD_FRIENDLY_RENDER_WIDTH,
  createLocalImageRenderService,
  getLocalImageRenderService,
  initLocalImageRenderService,
};
