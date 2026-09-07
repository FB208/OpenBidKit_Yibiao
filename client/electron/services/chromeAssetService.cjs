/**
 * 页眉页脚装饰资产：把共享 SVG 生成器的产物栅格化成 PNG，落到工作区供 C# 助手嵌图。
 *
 * 装饰是 SVG 画的（矢量、体积小），但交付格式必须是 PNG——SVG 直嵌在 Word 端
 * 支持不确定，EMF/WMF 在 docx-editor.dev 里显示占位符，WebP 不是 OOXML 认可格式
 * （项目自己的 normalizeImageForDocx 就在规避这点）。PNG 是唯一两端都稳的选择。
 *
 * 按内容 hash 命名并复用：配置没变就不重新截图。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { getWorkspaceDir } = require('../utils/paths.cjs');
const { getLocalImageRenderService } = require('./localImageRenderService.cjs');

/** 装饰图落地目录（工作区内，相对路径传给 C#）。 */
const CHROME_ASSET_ROOT = 'chrome-assets';

/** 栅格化倍率：SVG 按 cm 尺寸生成，这里换算到 ~300dpi。 */
const RASTER_DPI = 300;
const CSS_DPI = 96;
const RASTER_SCALE = RASTER_DPI / CSS_DPI;   // 3.125

let chromeModulePromise = null;
let chromeModule = null;

/** 栅格化结果缓存，键是 SVG 内容 hash。 */
const pngMemo = new Map();
const PNG_MEMO_MAX = 16;

/** 共享模块是 ESM，主进程侧走动态 import（与 fileService.cjs 引 convert.mjs 同一模式）。 */
function loadChromeModule() {
  if (!chromeModulePromise) {
    const url = pathToFileURL(
      path.join(__dirname, '..', 'shared', 'chrome', 'index.mjs'),
    ).href;
    chromeModulePromise = import(url).then((m) => {
      chromeModule = m;
      return m;
    });
  }
  return chromeModulePromise;
}

/**
 * 同步取页面几何。调用前必须先 await loadChromeModule()。
 *
 * 之所以要同步版本：导出流程里算图片最大高度这类地方是同步的，但页边距必须和
 * 装饰用的是同一套推导，不能各算一份 —— 前后端几何不同源正是这次要修的问题。
 * 模块没加载时返回 null，调用方回退到配置原值。
 */
function resolveChromeLayoutSync(page) {
  if (!chromeModule) return null;
  // 用带文字层的版本：正文边距要让开撑开后的文本框，不能只按装饰带高度算。
  return chromeModule.resolveChromeLayoutWithText(page || {}).layout;
}

function cmToCssPx(cm) {
  return Math.max(1, Math.round((cm * CSS_DPI) / 2.54));
}

/**
 * 把一段 SVG 栅格化成 PNG buffer。
 * renderExactHtmlToPng 接受任意 HTML 片段，内联 SVG 即可（用法同 exportService.cjs:1003）。
 */
async function rasterizeSvg(svg, widthCm, heightCm) {
  const width = cmToCssPx(widthCm);
  const height = cmToCssPx(heightCm);
  const html =
    `<div style="width:${width}px;height:${height}px;overflow:hidden;line-height:0">` +
    // 让 SVG 精确铺满容器，避免 max-width 规则改动比例
    svg.replace('<svg ', `<svg style="display:block;width:${width}px;height:${height}px" `) +
    '</div>';
  const png = await getLocalImageRenderService().renderExactHtmlToPng({
    html,
    width,
    height,
    scale: RASTER_SCALE,
  });
  return png.buffer;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 生成一份页面配置对应的页眉/页脚装饰 PNG。
 *
 * @param {object} app        Electron app
 * @param {object} pageConfig export_format.page
 * @returns {Promise<{assetRoot: string, header: string|null, footer: string|null, layout: object, textLayout: object}>}
 *   header / footer 是相对 assetRoot 的文件名；无装饰（plain）时为 null。
 */
async function buildChromeAssets(app, pageConfig) {
  const { buildChrome } = await loadChromeModule();
  const chrome = buildChrome(pageConfig || {});

  const result = {
    assetRoot: CHROME_ASSET_ROOT,
    header: null,
    footer: null,
    layout: chrome.layout,
    textLayout: chrome.textLayout,
  };
  if (!chrome.headerSvg && !chrome.footerSvg) return result;

  const targetDir = ensureDir(path.join(getWorkspaceDir(app), CHROME_ASSET_ROOT));

  const emit = async (svg, heightCm, tag) => {
    if (!svg || !(heightCm > 0)) return null;
    const hash = crypto.createHash('sha256').update(svg).digest('hex').slice(0, 16);
    const name = `${tag}-${hash}.png`;
    const file = path.join(targetDir, name);
    // 同一份 SVG 只截一次图
    if (!fs.existsSync(file)) {
      const buffer = await rasterizeSvg(svg, chrome.layout.widthCm, heightCm);
      fs.writeFileSync(file, buffer);
    }
    return name;
  };

  result.header = await emit(chrome.headerSvg, chrome.layout.headerHeightCm, 'header');
  result.footer = await emit(chrome.footerSvg, chrome.layout.footerHeightCm, 'footer');
  return result;
}

/**
 * 直接拿装饰 PNG 的字节，不落盘 —— 给正式导出用。
 * 导出侧的 docx 库直接吃 buffer，不需要工作区文件。
 *
 * @returns {Promise<{
 *   header: {buffer: Buffer, widthCm: number, heightCm: number}|null,
 *   footer: {buffer: Buffer, widthCm: number, heightCm: number}|null,
 *   layout: object, textLayout: object, colors: object,
 * }>}
 */
async function renderChromePngs(pageConfig) {
  const { buildChrome } = await loadChromeModule();
  const chrome = buildChrome(pageConfig || {});
  const widthCm = chrome.layout.widthCm;

  const emit = async (svg, heightCm) => {
    if (!svg || !(heightCm > 0)) return null;
    // 页眉和页脚是分两次构建的，同一份 SVG 不重复截图
    const key = crypto.createHash('sha256').update(svg).digest('hex');
    let buffer = pngMemo.get(key);
    if (!buffer) {
      buffer = await rasterizeSvg(svg, widthCm, heightCm);
      pngMemo.set(key, buffer);
      // 只保留最近若干份，避免反复改配色时无限占内存
      if (pngMemo.size > PNG_MEMO_MAX) {
        pngMemo.delete(pngMemo.keys().next().value);
      }
    }
    return { buffer, widthCm, heightCm };
  };

  return {
    header: await emit(chrome.headerSvg, chrome.layout.headerHeightCm),
    footer: await emit(chrome.footerSvg, chrome.layout.footerHeightCm),
    layout: chrome.layout,
    textLayout: chrome.textLayout,
    colors: chrome.colors,
  };
}

/** 清掉不再被引用的旧装饰图，避免工作区无限增长。 */
function pruneChromeAssets(app, keepNames, maxKeep = 40) {
  try {
    const dir = path.join(getWorkspaceDir(app), CHROME_ASSET_ROOT);
    if (!fs.existsSync(dir)) return;
    const keep = new Set((keepNames || []).filter(Boolean));
    const entries = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.png'))
      .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const [i, e] of entries.entries()) {
      if (keep.has(e.n) || i < maxKeep) continue;
      fs.rmSync(path.join(dir, e.n), { force: true });
    }
  } catch {
    // 清理失败不影响主流程
  }
}

module.exports = {
  CHROME_ASSET_ROOT,
  buildChromeAssets,
  renderChromePngs,
  resolveChromeLayoutSync,
  pruneChromeAssets,
  loadChromeModule,
};
