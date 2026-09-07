/**
 * 8 种页眉装饰的 SVG 绘制。
 *
 * 视觉以 exportService.cjs 的正式导出实现为准（那是用户实际拿到的产物），
 * 复杂的 4 种（top-bar / slant / letterhead / frame）逐层复刻自
 * client/electron/resources/header-footer/*.html 的 CSS：
 *   color-mix()  -> colors.mjs 的 mix()，在生成期算成具体色值
 *   clip-path    -> <polygon>
 *   skewX()      -> transform + skewAboutCenter（补 transform-origin 差异）
 *   box-shadow   -> <feDropShadow>
 *
 * 这里只画不依赖文字宽度的部分。文字与页码由 Word 原生层承担，
 * 位置见 textLayout.mjs。
 */
import { cmToSvg, pxToSvg, ptToSvg, HEADER_CHROME_HEIGHT_CM, HEADER_BADGE_WIDTH_CM, HEADER_SLOT, HEADER_FRAME } from './geometry.mjs';
import { mix, contrastText } from './colors.mjs';
import {
  n, svgDoc, rect, polygon, hLine, strokeRect,
  linearGradient, dropShadow, clipRect, skewAboutCenter,
} from './svgUtil.mjs';

/** plain 页眉没有任何装饰 —— 导出侧就是一个纯文字段落。 */
function plainHeader() {
  return null;
}

/**
 * band：左侧强调色徽标块 + 通栏浅底。
 * 对应 buildBandHeader 的三列出血表格 [1.15cm accent | 1fr bar | 1.15cm bar]。
 */
function bandHeader({ accent, bar }, W, H) {
  const badge = cmToSvg(HEADER_BADGE_WIDTH_CM);
  return svgDoc(W / 100, H / 100,
    rect(0, 0, W, H, bar) + rect(0, 0, badge, H, accent));
}

/**
 * rules：公文文武线。粗线在上、细线在下，整体压在页眉文字下方。
 * 对应 buildRulesHeader 的 border { top: size12, bottom: size6 }（eighth-point）。
 */
function rulesHeader({ accent }, W, H) {
  const thick = ptToSvg(12 / 8);   // size 12 = 1.5pt
  const thin = ptToSvg(6 / 8);     // size 6  = 0.75pt
  const gap = ptToSvg(2);
  const y = H - thick - gap - thin;
  return svgDoc(W / 100, H / 100,
    hLine(0, y, W, thick, accent) + hLine(0, y + thick + gap, W, thin, accent));
}

/**
 * footer-badge 页眉：只有一条强调色下边框，无底色。
 * 对应 buildFooterBadgeHeader 的 border.bottom size8 = 1pt。
 */
function footerBadgeHeader({ accent }, W, H) {
  const t = ptToSvg(1);
  return svgDoc(W / 100, H / 100, hLine(0, H - t, W, t, accent));
}

/**
 * top-bar（模板名 slot）：四种里结构最密的一套。
 * 层序照搬 slot-header.html：底渐变 / 斜纹 / 斜高光 / 顶高光 / 底暗边 /
 * 双层斜切耳 / 右刀条 / 嵌板投影 / 中央嵌板 / 四角标。
 */
function topBarHeader({ accent, bar }, W, H) {
  const earW = pxToSvg(66);
  const earBackW = pxToSvg(64);
  const bladeW = pxToSvg(16);
  const plateL = cmToSvg(HEADER_SLOT.leftCm);
  const plateR = cmToSvg(HEADER_SLOT.rightCm);
  const plateT = HEADER_SLOT.topRatio * H;
  const plateB = HEADER_SLOT.bottomRatio * H;
  const castL = pxToSvg(86);
  const castR = pxToSvg(24);
  const castT = 0.22 * H + pxToSvg(5);
  const castH = 0.62 * H;
  const hatchStep = pxToSvg(7);

  const defs =
    linearGradient('bg', [
      ['0%', mix(accent, '#000000', 0.72)],
      ['38%', accent],
      ['100%', mix(accent, '#ffffff', 0.86)],
    ]) +
    // CSS: repeating-linear-gradient(135deg, #fff20% 0 1px, transparent 1px 7px)
    // 135deg 的渐变方向指向右下，条纹垂直于它 → 沿左下-右上，对应 rotate(-45)
    `<pattern id="hatch" width="${n(hatchStep)}" height="${n(hatchStep)}" ` +
    `patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">` +
    rect(0, 0, pxToSvg(1), hatchStep, '#ffffff', 'fill-opacity="0.20"') + '</pattern>' +
    linearGradient('flare', [
      ['0%', '#ffffff', 0], ['42%', '#ffffff', 0.22], ['100%', '#ffffff', 0],
    ], 0, 0, 1, 0) +
    linearGradient('sheen', [
      ['0%', mix('#ffffff', accent, 0.18)],
      ['50%', mix('#ffffff', accent, 0.62)],
      ['100%', mix('#ffffff', accent, 0.22)],
    ], 0, 0, 1, 0) +
    linearGradient('ear', [
      ['0%', mix(accent, '#000000', 0.58)],
      ['100%', mix(accent, '#000000', 0.74)],
    ]) +
    linearGradient('blade', [
      ['0%', mix(accent, '#000000', 0.42)],
      ['100%', mix(accent, '#000000', 0.62)],
    ]) +
    dropShadow('earShadow', pxToSvg(8), 0, pxToSvg(14), 0.32) +
    dropShadow('plateShadow', 0, pxToSvg(4), pxToSvg(10), 0.16) +
    clipRect('clipTopBar', W, H);

  const flareX = 0.28 * W;
  const flareY = -0.3 * H;
  const flareW = 0.46 * W;
  const flareH = 1.6 * H;

  const plateW = W - plateR - plateL;
  const plateH = H - plateT - plateB;

  // 四角 L 形角标（CSS 里是 border-width 拼出来的）
  const tickLen = pxToSvg(13);
  const tickW = pxToSvg(2);
  const tl = plateL + pxToSvg(4);
  const tr = W - plateR - pxToSvg(4);
  const tt = plateT + pxToSvg(3);
  const tb = H - plateB - pxToSvg(3);
  const corner = (x, y, dx, dy) =>
    `<path d="M ${n(x + dx * tickLen)} ${n(y)} H ${n(x)} V ${n(y + dy * tickLen)}" ` +
    `fill="none" stroke="${accent}" stroke-width="${n(tickW)}"/>`;

  const inner =
    rect(0, 0, W, H, 'url(#bg)') +
    rect(0, 0, W, H, 'url(#hatch)') +
    rect(flareX, flareY, flareW, flareH, 'url(#flare)',
      `transform="${skewAboutCenter(flareX, flareY, flareW, flareH, -22)}"`) +
    rect(0, 0, W, pxToSvg(2), 'url(#sheen)') +
    rect(0, H - pxToSvg(3), W, pxToSvg(3), mix(accent, '#000000', 0.58)) +
    polygon([
      [pxToSvg(16), pxToSvg(10)],
      [pxToSvg(16) + earBackW, pxToSvg(10)],
      [pxToSvg(16) + earBackW * 0.58, H + pxToSvg(4)],
      [pxToSvg(16), H + pxToSvg(4)],
    ], mix(accent, '#000000', 0.38)) +
    polygon([[0, 0], [earW, 0], [earW * 0.62, H], [0, H]],
      'url(#ear)', 'filter="url(#earShadow)"') +
    rect(pxToSvg(10), pxToSvg(10), pxToSvg(18), pxToSvg(2), mix('#ffffff', accent, 0.42)) +
    rect(W - bladeW, 0, bladeW, H, 'url(#blade)') +
    rect(W - bladeW - pxToSvg(6), 0, pxToSvg(6), H, mix('#ffffff', accent, 0.38)) +
    polygon([
      [castL + pxToSvg(10), castT],
      [W - castR, castT],
      [W - castR - pxToSvg(12), castT + castH],
      [castL, castT + castH],
    ], mix(accent, '#000000', 0.28), 'opacity="0.7"') +
    rect(plateL, plateT, plateW, plateH, mix('#ffffff', bar, 0.88), 'filter="url(#plateShadow)"') +
    strokeRect(plateL, plateT, plateW, plateH, mix(accent, '#ffffff', 0.18), pxToSvg(1)) +
    corner(tl, tt, 1, 1) + corner(tr, tt, -1, 1) +
    corner(tl, tb, 1, -1) + corner(tr, tb, -1, -1);

  return svgDoc(W / 100, H / 100, `<g clip-path="url(#clipTopBar)">${inner}</g>`, defs);
}

/**
 * slant：双层斜切色块 + 竖向高光条 + 右上斜切小标。
 * 复刻 slant-header.html 的 cast / panel / slash / chip 四层。
 */
function slantHeader({ accent, bar }, W, H) {
  const onAccent = contrastText(accent);
  const cast = { x: -0.08 * W, y: -0.18 * H, w: 0.64 * W, h: 1.4 * H };
  const panel = { x: -0.1 * W, y: -0.18 * H, w: 0.61 * W, h: 1.4 * H };
  const slash = { x: 0.48 * W, y: -0.2 * H, w: pxToSvg(5), h: 1.5 * H };
  const chipW = pxToSvg(42);
  const chipH = pxToSvg(10);
  const chipX = W - pxToSvg(18) - chipW;
  const chipY = pxToSvg(10);

  const defs =
    linearGradient('slantPanel', [
      ['0%', mix(accent, '#000000', 0.78)],
      ['55%', accent],
      ['100%', mix(accent, '#ffffff', 0.88)],
    ]) +
    linearGradient('slantSlash', [
      ['0%', onAccent, 0.35], ['50%', onAccent, 1], ['100%', onAccent, 0.35],
    ]) +
    dropShadow('slantShadow', pxToSvg(10), 0, pxToSvg(18), 0.22) +
    clipRect('clipSlant', W, H);

  const inner =
    rect(0, 0, W, H, bar) +
    rect(cast.x, cast.y, cast.w, cast.h, mix(accent, '#000000', 0.46),
      `transform="${skewAboutCenter(cast.x, cast.y, cast.w, cast.h, -18)}"`) +
    rect(panel.x, panel.y, panel.w, panel.h, 'url(#slantPanel)',
      `filter="url(#slantShadow)" transform="${skewAboutCenter(panel.x, panel.y, panel.w, panel.h, -18)}"`) +
    rect(slash.x, slash.y, slash.w, slash.h, 'url(#slantSlash)',
      `transform="${skewAboutCenter(slash.x, slash.y, slash.w, slash.h, -18)}"`) +
    polygon([
      [chipX + 0.18 * chipW, chipY],
      [chipX + chipW, chipY],
      [chipX + 0.82 * chipW, chipY + chipH],
      [chipX, chipY + chipH],
    ], accent);

  return svgDoc(W / 100, H / 100, `<g clip-path="url(#clipSlant)">${inner}</g>`, defs);
}

/**
 * letterhead：左侧信头色块（含两条白色标记线）+ 底部发丝线 + 底边强调条。
 * 复刻 letterhead-header.html 的 logo / hair / bar 三层。
 */
function letterheadHeader({ accent, bar }, W, H) {
  const logoW = pxToSvg(42);
  const logoH = H - pxToSvg(8);
  const onAccent = contrastText(accent);
  const barH = pxToSvg(5);
  const hairH = pxToSvg(1);
  const hairY = H - pxToSvg(7) - hairH;

  const defs = linearGradient('letterLogo', [
    ['0%', mix(accent, '#000000', 0.82)],
    ['100%', accent],
  ]);

  const inner =
    rect(0, 0, W, H, mix('#ffffff', bar, 0.9)) +
    rect(0, 0, logoW, logoH, 'url(#letterLogo)') +
    rect(pxToSvg(10), pxToSvg(12), pxToSvg(22), pxToSvg(2.4), onAccent) +
    rect(pxToSvg(10), pxToSvg(18), pxToSvg(14), pxToSvg(2.4), onAccent, 'fill-opacity="0.7"') +
    hLine(0, hairY, W, hairH, accent, 0.38) +
    rect(0, H - barH, W, barH, accent);

  return svgDoc(W / 100, H / 100, inner, defs);
}

/**
 * frame：双线圈框 + 四角实心角码。
 * 复刻 frame-header.html 的 outer / inner / 4×mark。
 */
function frameHeader({ accent, bar }, W, H) {
  const outer = { x: pxToSvg(6), y: pxToSvg(4), t: pxToSvg(2.6) };
  const inner = { x: cmToSvg(HEADER_FRAME.xCm), y: cmToSvg(HEADER_FRAME.yCm), t: pxToSvg(1) };
  const mk = pxToSvg(7);
  const mkX = pxToSvg(9);
  const mkY = pxToSvg(7);

  const body =
    rect(0, 0, W, H, mix('#ffffff', bar, 0.92)) +
    strokeRect(outer.x, outer.y, W - outer.x * 2, H - outer.y * 2, accent, outer.t) +
    strokeRect(inner.x, inner.y, W - inner.x * 2, H - inner.y * 2, accent, inner.t) +
    rect(mkX, mkY, mk, mk, accent) +
    rect(W - mkX - mk, mkY, mk, mk, accent) +
    rect(mkX, H - mkY - mk, mk, mk, accent) +
    rect(W - mkX - mk, H - mkY - mk, mk, mk, accent);

  return svgDoc(W / 100, H / 100, body);
}

const HEADERS = {
  plain: plainHeader,
  band: bandHeader,
  rules: rulesHeader,
  'top-bar': topBarHeader,
  'footer-badge': footerBadgeHeader,
  slant: slantHeader,
  letterhead: letterheadHeader,
  frame: frameHeader,
};

/**
 * 生成页眉装饰 SVG。
 * @returns {string|null} plain 无装饰时返回 null（不生成图片部件）
 */
export function buildHeaderSvg(style, colors, widthCm, heightCm = HEADER_CHROME_HEIGHT_CM) {
  const draw = HEADERS[style] || HEADERS.plain;
  return draw(colors, cmToSvg(widthCm), cmToSvg(heightCm));
}
