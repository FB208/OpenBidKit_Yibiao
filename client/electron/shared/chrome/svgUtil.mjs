/**
 * SVG 绘制原语。坐标单位见 geometry.mjs：100 单位 = 1cm。
 *
 * 这里只提供拼字符串的小工具，不引任何依赖 —— 生成器要能同时跑在
 * 渲染进程（vite）、Electron 主进程（动态 import）两边。
 */
import { cmToSvg } from './geometry.mjs';

/** 保留一位小数，避免坐标串里出现一长串浮点尾数。 */
export const n = (v) => Math.round(v * 10) / 10;

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 包一层 <svg>。宽高用 cm，viewBox 用 SVG 单位。 */
export function svgDoc(widthCm, heightCm, inner, defs = '') {
  const w = n(cmToSvg(widthCm));
  const h = n(cmToSvg(heightCm));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    (defs ? `<defs>${defs}</defs>` : '') +
    inner +
    '</svg>'
  );
}

export function rect(x, y, w, h, fill, extra = '') {
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}"${extra ? ' ' + extra : ''}/>`;
}

export function polygon(points, fill, extra = '') {
  const p = points.map(([x, y]) => `${n(x)},${n(y)}`).join(' ');
  return `<polygon points="${p}" fill="${fill}"${extra ? ' ' + extra : ''}/>`;
}

/** 水平线。用 rect 画而不是 <line>，避免 stroke 对齐到半像素。 */
export function hLine(x, y, w, thickness, color, opacity) {
  return rect(x, y, w, thickness, color, opacity != null ? `fill-opacity="${opacity}"` : '');
}

export function vLine(x, y, h, thickness, color) {
  return rect(x, y, thickness, h, color);
}

/** 描边矩形（不填充）。 */
export function strokeRect(x, y, w, h, color, thickness) {
  return (
    `<rect x="${n(x + thickness / 2)}" y="${n(y + thickness / 2)}" ` +
    `width="${n(w - thickness)}" height="${n(h - thickness)}" ` +
    `fill="none" stroke="${color}" stroke-width="${n(thickness)}"/>`
  );
}

export function linearGradient(id, stops, x1 = 0, y1 = 0, x2 = 0, y2 = 1) {
  const body = stops
    .map(([offset, color, opacity]) =>
      `<stop offset="${offset}" stop-color="${color}"` +
      (opacity != null ? ` stop-opacity="${opacity}"` : '') + '/>')
    .join('');
  return `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${body}</linearGradient>`;
}

export function dropShadow(id, dx, dy, blur, opacity) {
  return (
    `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">` +
    `<feDropShadow dx="${n(dx)}" dy="${n(dy)}" stdDeviation="${n(blur / 2)}" ` +
    `flood-color="#000000" flood-opacity="${opacity}"/></filter>`
  );
}

export function clipRect(id, w, h) {
  return `<clipPath id="${id}"><rect x="0" y="0" width="${n(w)}" height="${n(h)}"/></clipPath>`;
}

/**
 * CSS transform 的原点是元素中心，SVG 的是坐标原点。
 * 复刻原 HTML 模板的 skewX 时必须把这个差补回来，否则整块会平移。
 */
export function skewAboutCenter(x, y, w, h, deg) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  return `translate(${n(cx)} ${n(cy)}) skewX(${deg}) translate(${n(-cx)} ${n(-cy)})`;
}

/**
 * 把 24×24 的图标 SVG 内联进来并缩放到指定边长。
 * 页脚图标资产（footer-*.svg）都是 24×24 viewBox、单一 {{mark}} 占位符。
 */
export function placeIcon(iconSource, markColor, x, y, sizeSvgUnits) {
  const filled = String(iconSource).replace(/\{\{mark\}\}/g, markColor);
  const inner = filled
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .trim();
  const scale = sizeSvgUnits / 24;
  return `<g transform="translate(${n(x)} ${n(y)}) scale(${n(scale * 1000) / 1000})" fill="none">${inner}</g>`;
}
