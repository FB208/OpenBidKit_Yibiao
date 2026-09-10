/**
 * 页眉页脚装饰 —— 三条链路的唯一入口。
 *
 *   前端样式选择器   直接用 headerSvg/footerSvg 渲染缩略图（矢量，不栅格化）
 *   C# 模板预览      栅格化成 PNG 落工作区，C# 嵌成锚定浮动图
 *   正式 Word 导出   栅格化成 PNG，docx 的 ImageRun floating
 *
 * 三处吃同一份 SVG、同一套几何、同一套配色，视觉才可能一致。
 */
import { resolveChromeColors } from './colors.mjs';
import { resolveChromeLayout, expandMarginsForText } from './geometry.mjs';
import { buildHeaderSvg } from './headerSvg.mjs';
import { buildFooterSvg } from './footerSvg.mjs';
import { buildTextLayout } from './textLayout.mjs';

export * from './colors.mjs';
export * from './geometry.mjs';
export { buildHeaderSvg } from './headerSvg.mjs';
export { buildFooterSvg } from './footerSvg.mjs';
export { buildTextLayout, formatPageNumber, resolveChromeGeometryDefaults } from './textLayout.mjs';

/**
 * 由页面配置产出完整的装饰描述。
 *
 * @param {object} page PageSetupConfig（export_format.page）
 * @returns {{
 *   style: string,
 *   layout: object,
 *   colors: object,
 *   headerSvg: string|null,
 *   footerSvg: string|null,
 *   textLayout: object,
 * }}
 *   headerSvg / footerSvg 为 null 表示该处无装饰（plain，或页眉页脚未启用），
 *   调用方就不要创建图片部件。
 */
/**
 * 几何 + 文字层，两趟推导。
 *
 * 第一趟按装饰带的固有高度定几何，第二趟据此排文字；文本框会按字号和折行
 * 撑得比装饰带高，撑出去的部分要回填进正文边距，否则不参与环绕的浮动文字
 * 会压在正文上。文本框的左右边界只依赖左右边距，不依赖上下边距，所以两趟
 * 就收敛，不会来回迭代。
 *
 * 只要边距的调用方（导出、C# 样张）都走这个函数，就不会再出现装饰位置和
 * 正文边距各算一套的情况。
 */
export function resolveChromeLayoutWithText(page = {}, colors = resolveChromeColors(page)) {
  const base = resolveChromeLayout(page);
  const textLayout = buildTextLayout(page, colors, base);
  return { layout: expandMarginsForText(base, textLayout), textLayout };
}

export function buildChrome(page = {}) {
  const colors = resolveChromeColors(page);
  const { layout, textLayout } = resolveChromeLayoutWithText(page, colors);

  const headerSvg = layout.headerVisible
    ? buildHeaderSvg(layout.style, colors, layout.widthCm, layout.headerHeightCm)
    : null;

  const footerSvg = layout.footerVisible
    ? buildFooterSvg(layout.style, colors, layout.widthCm, layout.footerHeightCm)
    : null;

  return {
    style: layout.style,
    layout,
    colors,
    headerSvg,
    footerSvg,
    textLayout,
  };
}
