/**
 * 页眉页脚几何 —— 全仓唯一实现。
 *
 * 此前这组常量在三处各写一份且互不一致：
 *   client/src/shared/utils/exportFormatCss.ts:96-107   前端预览
 *   client/electron/services/exportService.cjs:713-765  正式导出
 *   RestrictedHtmlDocumentRenderer.cs:286               C# 样张（Header 硬编码 1.25cm）
 * 现在只有这一份，三条链路都从这里取。
 *
 * SVG 坐标系约定：1 个 SVG 单位 = 0.01cm，即 100 单位 = 1cm。
 * 这样 21cm 宽的页眉 viewBox 就是 "0 0 2100 135"，读起来直接对应物理尺寸。
 */

// ---------- 单位换算 ----------
export const SVG_UNITS_PER_CM = 100;
export const TWIPS_PER_CM = 567;          // 与 C# CmToTwips 一致
export const EMU_PER_CM = 360000;
export const CSS_PX_PER_CM = 96 / 2.54;   // 36.2835，CSS 绝对像素
export const PT_PER_CM = 72 / 2.54;       // 28.3465

export const cmToSvg = (cm) => cm * SVG_UNITS_PER_CM;
export const cmToTwips = (cm) => Math.round(cm * TWIPS_PER_CM);
export const cmToEmu = (cm) => Math.round(cm * EMU_PER_CM);
export const cmToPx = (cm) => cm * CSS_PX_PER_CM;
export const pxToCm = (px) => px / CSS_PX_PER_CM;
export const ptToCm = (pt) => pt / PT_PER_CM;

/** 原 HTML 模板里的 CSS px 换算到 SVG 单位（模板按 96dpi 写的）。 */
export const pxToSvg = (px) => cmToSvg(pxToCm(px));
/** CSS pt 换算到 SVG 单位。页脚的栅格列宽都是 pt。 */
export const ptToSvg = (pt) => cmToSvg(ptToCm(pt));

// ---------- 装饰带尺寸 ----------
/** 页眉装饰带高度，8 种样式统一。 */
export const HEADER_CHROME_HEIGHT_CM = 1.35;

/** 页脚装饰带高度，按样式区分。band/footer-badge 的 0.635 = 360 twips。 */
export const FOOTER_HEIGHT_CM = {
  plain: 0,
  band: 360 / TWIPS_PER_CM,
  rules: 0.9,
  'top-bar': 0.85,
  'footer-badge': 360 / TWIPS_PER_CM,
  slant: 0.85,
  letterhead: 0.8,
  frame: 0.85,
};

/** 装饰与文字共用的页脚分区宽度。barCm 是正文与页码之间的竖条。 */
export const FOOTER_COLUMNS = {
  band: { left: 1.15, right: 2.1 },
  'footer-badge': { left: 0, right: 2.1 },
  'top-bar': { left: 1.15, right: 1.6 },
  slant: { left: 1.35, right: 1.6 },
  frame: { left: 1.0, right: 1.7 },
  letterhead: { left: 0, right: 1.7, barCm: 0.22 },
  rules: { left: 0, right: 0 },
  plain: { left: 0, right: 0 },
};

/**
 * 中文字号名 -> pt，与 src/shared/types/exportFormat.ts 的 SIZE_TO_PT 同表
 * （exportService.cjs 的 SIZE_TO_HALF_PT 是它的两倍）。
 * 文字层要按字号撑开文本框，所以共享模块也得有一份。
 */
export const SIZE_TO_PT = {
  初号: 42, 小初: 36, 一号: 26, 小一: 24, 二号: 22, 小二: 18,
  三号: 16, 小三: 15, 四号: 14, 小四: 12, 五号: 10.5, 小五: 9,
  六号: 7.5, 小六: 6.5,
};

export const chineseSizeToPt = (name) => SIZE_TO_PT[name] ?? 12;

/** 单行行高相对字号的倍数。中文字面加行间余量，取偏宽松的值以免文字顶到框边。 */
export const LINE_HEIGHT_FACTOR = 1.2;

/** 一行文字占用的高度（cm）。 */
export const lineHeightCm = (sizeName) => ptToCm(chineseSizeToPt(sizeName)) * LINE_HEIGHT_FACTOR;

/** 页眉徽标、白槽与框线内边界，供装饰和文字共同定位。 */
export const HEADER_BADGE_WIDTH_CM = 1.15;
export const HEADER_SLOT = { leftCm: pxToCm(78), rightCm: pxToCm(36), topRatio: 0.16, bottomRatio: 0.2 };
export const HEADER_FRAME = { xCm: pxToCm(12), yCm: pxToCm(10) };
export const FOOTER_FRAME_INSET_CM = ptToCm(5);

/**
 * 装饰带上方/下方的留白预算。
 *
 * 注意这不是定位偏移 —— 页眉装饰本身贴页面上边缘（posOffset = 0），
 * 这个值只参与正文边距的计算。原代码里的名字 CHROME_*_FROM_EDGE_CM
 * 有误导性，曾导致在 Word 里凭空多出一条白边。
 */
export const CHROME_EDGE_BUDGET_CM = 0.15;
/** 装饰带与正文之间的净空。 */
export const CHROME_BODY_CLEARANCE_CM = 0.15;

/** 页脚装饰带距页面底边的距离，用户可配。 */
export const DEFAULT_FOOTER_DISTANCE_CM = 1.75;

/** 无装饰时页眉段落距页面顶边的距离，即 Word 默认值。 */
export const DEFAULT_HEADER_DISTANCE_CM = 1.25;

// ---------- 纸张 ----------
/** 单位 cm，与 C# PaperSizes 字典对齐。 */
export const PAPER_SIZES_CM = {
  a4: [21.0, 29.7],
  a3: [29.7, 42.0],
  a5: [14.8, 21.0],
  b4: [25.0, 35.3],
  b5: [17.6, 25.0],
  letter: [21.59, 27.94],
  legal: [21.59, 35.56],
  '16k': [18.4, 26.0],
};

export function resolvePaperCm(paperSize, orientation) {
  const [w, h] = PAPER_SIZES_CM[paperSize] || PAPER_SIZES_CM.a4;
  return orientation === 'landscape' ? { widthCm: h, heightCm: w } : { widthCm: w, heightCm: h };
}

// ---------- 显示判定 ----------
/** plain 之外都算「有装饰」。 */
export const isDecorative = (style) => style !== 'plain';

export function showsHeader(page) {
  if (!page?.header_enabled) return false;
  if (isDecorative(page.header_footer_style)) return true;
  return Boolean(String(page.header_text || '').trim());
}

export function showsFooter(page) {
  const hasText = Boolean(page?.footer_enabled && String(page.footer_text || '').trim());
  return Boolean(hasText || page?.page_number_enabled);
}

// ---------- 布局推导 ----------
/**
 * 正文边距至少要让开装饰带：edge 预算 + 装饰高 + 净空。
 * 装饰高为 0 时不占位。
 */
function minBodyMarginCm(chromeHeightCm, edgeBudgetCm) {
  if (!(chromeHeightCm > 0)) return 0;
  return edgeBudgetCm + chromeHeightCm + CHROME_BODY_CLEARANCE_CM;
}

/**
 * 把文字层实际占到的范围并进正文边距。
 *
 * resolveChromeLayout 只知道装饰带的固有高度；文本框会按字号和折行撑得更高
 * （见 textLayout.mjs 的 fitTextBox），撑出去的部分同样要让正文避开。
 * 这些文本框是 wrapNone 的浮动对象，Word 不会自动为它们让位，边距不跟着调整
 * 就会直接压在正文上。
 *
 * @param {object} layout resolveChromeLayout 的结果
 * @param {object} textLayout buildTextLayout 的结果
 */
export function expandMarginsForText(layout, textLayout) {
  const headerBoxes = [textLayout?.header?.box, textLayout?.header?.badge?.box].filter(Boolean);
  const footerBoxes = [textLayout?.footer?.box, textLayout?.footer?.pageNumber?.box].filter(Boolean);

  let marginTopCm = layout.marginTopCm;
  for (const box of headerBoxes) {
    marginTopCm = Math.max(marginTopCm, box.topCm + box.heightCm + CHROME_BODY_CLEARANCE_CM);
  }

  let marginBottomCm = layout.marginBottomCm;
  for (const box of footerBoxes) {
    marginBottomCm = Math.max(marginBottomCm, layout.heightCm - box.topCm + CHROME_BODY_CLEARANCE_CM);
  }

  // 正文至少要留一行的空间，避免极端配置把上下边距顶到一起。
  const maxTotalCm = Math.max(0, layout.heightCm - 1);
  if (marginTopCm + marginBottomCm > maxTotalCm) {
    const scale = maxTotalCm / (marginTopCm + marginBottomCm);
    marginTopCm *= scale;
    marginBottomCm *= scale;
  }
  return { ...layout, marginTopCm, marginBottomCm };
}

/**
 * 算出一份页面配置对应的完整几何。
 * 三条链路（前端缩略图 / C# 样张 / 正式导出）都调这一个函数，
 * 保证装饰位置和正文边距不会再各算各的。
 */
export function resolveChromeLayout(page = {}) {
  const style = page.header_footer_style || 'plain';
  const { widthCm, heightCm } = resolvePaperCm(page.paper_size, page.orientation);

  const headerVisible = showsHeader(page);
  const footerVisible = showsFooter(page);
  // plain 不生成装饰图，不能占装饰带高度 —— 否则会无故抬高用户设的正文上边距。
  const headerHeightCm = headerVisible && isDecorative(style) ? HEADER_CHROME_HEIGHT_CM : 0;
  const footerHeightCm = footerVisible ? (FOOTER_HEIGHT_CM[style] ?? 0) : 0;

  const footerDistanceCm = Math.max(0, page.footer_distance_cm ?? DEFAULT_FOOTER_DISTANCE_CM);

  const marginTopCm = Math.max(
    page.margin_top_cm ?? 2,
    minBodyMarginCm(headerHeightCm, CHROME_EDGE_BUDGET_CM),
  );
  const marginBottomCm = Math.max(
    page.margin_bottom_cm ?? 2,
    minBodyMarginCm(footerHeightCm, footerDistanceCm),
  );

  return {
    style,
    widthCm,
    heightCm,
    marginTopCm,
    marginBottomCm,
    marginLeftCm: page.margin_left_cm ?? 2,
    marginRightCm: page.margin_right_cm ?? 2,

    headerVisible,
    footerVisible,
    headerHeightCm,
    footerHeightCm,

    // 页眉贴顶；页脚装饰底边按用户配置的距离定位。
    headerTopCm: 0,
    footerTopCm: heightCm - footerDistanceCm - footerHeightCm,

    // 有装饰时页眉贴顶，文字由浮动文本框定位，段落距顶取 0；
    // plain 没有装饰，页眉文字走普通段落流，沿用 Word 默认的 1.25cm 距顶。
    headerDistanceCm: headerHeightCm > 0 ? 0 : DEFAULT_HEADER_DISTANCE_CM,
    footerDistanceCm,

    // 用户配置的页脚距离，同时用于定位和正文下边距推导。
    configuredFooterDistanceCm: footerDistanceCm,
  };
}
