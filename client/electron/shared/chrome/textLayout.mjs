/**
 * 文字层描述 —— 装饰之外的另一半。
 *
 * 装饰是图片，文字必须留在 Word 原生层：页码要是可刷新的 PAGE 域，
 * 标题要可编辑、可搜索、可被 docx-editor.dev 的 automation 操作。
 *
 * 文字区域以 cm 表示，相对纸张左上角定位；普通段落的 box 为 null。
 * 各区域在透明表格单元格内垂直居中，水平对齐由文字层的 align 指定。
 *
 * 颜色取值来源是 exportService.cjs 里各 build*Header/Footer 的 runOptions，
 * 那是用户实际拿到的产物。
 */
import {
  pxToCm, ptToCm, resolveChromeLayout, FOOTER_COLUMNS, lineHeightCm, chineseSizeToPt,
  HEADER_BADGE_WIDTH_CM, HEADER_SLOT, HEADER_FRAME, FOOTER_FRAME_INSET_CM,
  HEADER_CHROME_HEIGHT_CM, FOOTER_HEIGHT_CM, resolvePaperCm, isDecorative, clampCm,
} from './geometry.mjs';
import { contrastText } from './colors.mjs';

/** rules 的文武线占据的高度，装饰与文字都按它让位。 */
export const RULES_LINE_BAND_CM = ptToCm(1.5 + 2 + 0.75);

/**
 * 公文类样式（rules / footer-badge）文字区的左右内缩。
 *
 * 从前这里直接取 margin_left_cm / margin_right_cm，让页眉文字跟着正文左右沿走。
 * 现在文字位置是用户可配的绝对值，动态跟随会和用户填的数字打架 —— 页面上显示
 * 2.00、改完页边距却悄悄变成 3.00，用户没法理解。改成静态默认（正好等于默认页边距），
 * 需要对齐正文时用户自己调一次。
 */
const CHROME_TEXT_INSET_CM = 2;

/** 页眉文字的完整区域；白槽和内框按装饰边界留出文字净空。 */
function headerTextBox(style, pageWidthCm, heightCm) {
  switch (style) {
    case 'band':
      return { startCm: HEADER_BADGE_WIDTH_CM, endCm: pageWidthCm, topCm: 0, heightCm };
    case 'top-bar':
      return {
        startCm: HEADER_SLOT.leftCm + pxToCm(4), endCm: pageWidthCm - HEADER_SLOT.rightCm - pxToCm(4),
        topCm: heightCm * HEADER_SLOT.topRatio + pxToCm(3),
        heightCm: heightCm * (1 - HEADER_SLOT.topRatio - HEADER_SLOT.bottomRatio) - pxToCm(6),
      };
    case 'slant':
      return { startCm: pxToCm(22), endCm: pageWidthCm * 0.45, topCm: 0, heightCm };
    case 'letterhead':
      return { startCm: pxToCm(56), endCm: pageWidthCm - pxToCm(16), topCm: 0, heightCm: heightCm - pxToCm(8) };
    case 'frame':
      return {
        startCm: HEADER_FRAME.xCm + pxToCm(10), endCm: pageWidthCm - HEADER_FRAME.xCm - pxToCm(10),
        topCm: HEADER_FRAME.yCm + pxToCm(2), heightCm: heightCm - 2 * (HEADER_FRAME.yCm + pxToCm(2)),
      };
    case 'rules':
      // 文武线画在装饰带底部，文字排在线上方的正文宽度内
      return {
        startCm: CHROME_TEXT_INSET_CM, endCm: pageWidthCm - CHROME_TEXT_INSET_CM,
        topCm: 0, heightCm: heightCm - RULES_LINE_BAND_CM,
      };
    case 'footer-badge':
      // 只有一条 1pt 下边框，文字同样排在线上方
      return {
        startCm: CHROME_TEXT_INSET_CM, endCm: pageWidthCm - CHROME_TEXT_INSET_CM,
        topCm: 0, heightCm: heightCm - ptToCm(1),
      };
    default:
      return null;   // plain 无装饰，用配置里的 header_alignment
  }
}

/**
 * 页脚文字的默认区域，坐标已含 footerTopCm（相对纸张左上角）。
 * 从 buildTextLayout 里抽出来，是为了让「取该样式的默认位置」能不经过用户值单独求值。
 */
function footerTextBox(style, pageWidthCm, footerHeightCm, footerTopCm) {
  if (!(footerHeightCm > 0)) return null;
  const cols = FOOTER_COLUMNS[style] || FOOTER_COLUMNS.plain;
  const insetCm = style === 'frame' ? FOOTER_FRAME_INSET_CM + ptToCm(0.75) : 0;
  // rules 的文武线在页脚顶部，文字排在线下方；它不分区，页码与正文同处一块
  if (style === 'rules') {
    return {
      startCm: CHROME_TEXT_INSET_CM, endCm: pageWidthCm - CHROME_TEXT_INSET_CM,
      topCm: footerTopCm + RULES_LINE_BAND_CM,
      heightCm: footerHeightCm - RULES_LINE_BAND_CM,
    };
  }
  if (!(cols.right > 0)) return null;
  return {
    startCm: cols.left + insetCm,
    endCm: pageWidthCm - cols.right - (cols.barCm || 0) - insetCm,
    topCm: footerTopCm + insetCm,
    heightCm: footerHeightCm - insetCm * 2,
  };
}

/** 页眉文字色。HTML 那 4 种由装饰底色决定，其余用用户配置的 header_color。 */
function headerTextColor(style, colors, page) {
  switch (style) {
    case 'band': return colors.onBar;
    case 'top-bar': return colors.accent;      // 白色嵌板上
    case 'slant': return colors.onAccent;      // 深色斜块上
    case 'letterhead':
    case 'frame': return colors.accent;
    default: return page.header_color || '#536176';
  }
}

const HEADER_BOLD = new Set(['band', 'top-bar', 'slant', 'letterhead', 'frame']);

/** 页码的字色与底纹。底纹交给 run 级 w:shd，宽度自动贴合文字。 */
function pageNumberStyle(style, colors) {
  switch (style) {
    case 'band':
      return { color: contrastText(colors.badge), shadingFill: colors.badge };
    case 'top-bar':
    case 'slant':
      return { color: colors.onAccent, shadingFill: colors.badge };
    case 'footer-badge':
      return { color: colors.onAccent, shadingFill: colors.accent };
    case 'letterhead':
    case 'frame':
      return { color: colors.accent, shadingFill: null };
    default:
      return { color: null, shadingFill: null };   // plain / rules 用 footer_color
  }
}

/**
 * 估算一段文字的宽度，单位 em（1em = 一个字号）。
 *
 * 拿不到真实字体度量，只能按字符类别近似：中日韩表意字、全角标点按全角算，
 * 其余按半角算。用于判断分区里会不会折行 —— 折行数只影响文本框高度，
 * 估偏一点不会让文字错位，估少了才会被裁切，所以宁可往大了算。
 */
const FULL_WIDTH = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/;

function textWidthEm(text) {
  let em = 0;
  for (const ch of String(text || '')) em += FULL_WIDTH.test(ch) ? 1 : 0.5;
  return em;
}

/** 分区宽度装不下时会折几行。上限 6 行，避免极窄分区推出荒谬的高度。 */
function estimateLines(text, widthCm, sizeName) {
  const neededCm = textWidthEm(text) * ptToCm(chineseSizeToPt(sizeName));
  if (!(widthCm > 0) || neededCm <= widthCm) return 1;
  return Math.min(6, Math.ceil(neededCm / widthCm));
}

/** 文本框的最小尺寸。再小下去 estimateLines 会按几十行折，推出荒谬的高度。 */
const MIN_TEXT_BOX_WIDTH_CM = 0.5;
const MIN_TEXT_BOX_HEIGHT_CM = 0.2;

/**
 * 把文本框放到用户指定的位置上。
 *
 * 位置是**绝对值**，不是相对默认位置的增量：left 相对纸张左沿，top 相对装饰带的上沿
 * （不是纸张上沿）—— 页脚文字若按纸张算，值会随纸张尺寸、页脚距底边一起漂移，
 * 27.32 这种数字用户没法读也没法填；相对装饰带则恒为 0~0.2 的小数，稳定且直观。
 *
 * 非数字表示「这一项跟随样式默认」。注意不能用 0 表示跟随 —— footer-badge 的
 * 默认左沿本来就是 0，那是个合法位置。
 *
 * 右沿保持样式默认：它是装饰结构的一部分（band 的徽标格、frame 的双线框），
 * 不该跟着左沿跑。框宽因此等于「默认右沿 − 用户左沿」。
 * 高度同理仍由样式函数按装饰带高度算，只是再按 top 收一下，免得溢出装饰带。
 */
function placeBox(box, leftCm, topCm, chromeTopCm, chromeHeightCm, pageWidthCm) {
  if (!box) return box;
  // 只认真正的 number：Number(null) 是 0 不是 NaN，用 Number.isFinite 判会把
  // 「跟随默认」的 null 当成「用户把位置设成了 0」，文字直接跑到纸张最左沿。
  const left = typeof leftCm === 'number' && Number.isFinite(leftCm) ? leftCm : null;
  const top = typeof topCm === 'number' && Number.isFinite(topCm) ? topCm : null;
  const hasLeft = left !== null;
  const hasTop = top !== null;
  if (!hasLeft && !hasTop) return box;

  const startCm = hasLeft
    ? clampCm(left, { min: 0, max: Math.max(0, pageWidthCm - MIN_TEXT_BOX_WIDTH_CM) })
    : box.startCm;
  const endCm = Math.min(pageWidthCm, Math.max(box.endCm, startCm + MIN_TEXT_BOX_WIDTH_CM));

  const relTopCm = hasTop
    ? clampCm(top, { min: 0, max: Math.max(0, chromeHeightCm - MIN_TEXT_BOX_HEIGHT_CM) })
    : box.topCm - chromeTopCm;
  const heightCm = Math.max(
    MIN_TEXT_BOX_HEIGHT_CM,
    Math.min(box.heightCm, chromeHeightCm - relTopCm),
  );

  return { startCm, endCm, topCm: chromeTopCm + relTopCm, heightCm };
}

/**
 * 让文本框装得下实际文字。
 *
 * 装饰带高度是样式的固有结构（色条多高就是多高），文字高度由字号和折行数决定，
 * 两者本来就是两个尺寸。之前直接把装饰带高度当成文本框高度，选大字号或文字
 * 折行时会溢出装饰带甚至越过纸张边缘 —— 原实现的表格行是 HeightRule.ATLEAST，
 * 会随内容撑开，这里要把这个能力补回来。
 *
 * 扩张以装饰带的竖直中心为轴，文字与色块的相对关系不变；最后钳进纸张，
 * 避免距底边设成 0 时越出页面。
 */
function fitTextBox(box, sizeName, pageHeightCm, text = '') {
  if (!box) return box;
  // 没有内容的框两端都不会渲染，撑高它只会白白挤掉正文空间。
  if (!String(text || '').length) return box;
  const lines = estimateLines(text, box.endCm - box.startCm, sizeName);
  const neededCm = lineHeightCm(sizeName) * lines;
  if (neededCm <= box.heightCm) return box;
  const centerCm = box.topCm + box.heightCm / 2;
  const topCm = Math.min(
    Math.max(0, centerCm - neededCm / 2),
    Math.max(0, pageHeightCm - neededCm),
  );
  return { ...box, topCm, heightCm: neededCm };
}

/**
 * 某个样式下六个可配几何量的真实默认值。
 *
 * UI 用它把「跟随默认」具象化成真实数字填进输入框 —— 输入框里显示 0 对用户没有信息量，
 * 他看不出这条色带到底多高、文字从哪里起排，也就无从判断该往哪个方向调。
 *
 * 必须绕开用户已填的值单独求：否则「切换样式 -> 写入默认值」会把上一个样式的
 * 用户值算进来，形成自激。
 *
 * top 是相对装饰带上沿的，与 placeBox 的入参语义一致。
 */
export function resolveChromeGeometryDefaults(page = {}) {
  const style = page.header_footer_style || 'plain';
  const { widthCm } = resolvePaperCm(page.paper_size, page.orientation);
  const headerHeightCm = isDecorative(style) ? HEADER_CHROME_HEIGHT_CM : 0;
  const footerHeightCm = FOOTER_HEIGHT_CM[style] ?? 0;

  const header = headerHeightCm > 0 ? headerTextBox(style, widthCm, headerHeightCm) : null;
  // footerTopCm 传 0，拿到的 topCm 就已经是相对装饰带上沿的值
  const footer = footerTextBox(style, widthCm, footerHeightCm, 0);

  const round = (v) => Math.round(v * 100) / 100;
  return {
    header_chrome_height_cm: round(headerHeightCm),
    footer_chrome_height_cm: round(footerHeightCm),
    header_text_left_cm: header ? round(header.startCm) : 0,
    header_text_top_cm: header ? round(header.topCm) : 0,
    footer_text_left_cm: footer ? round(footer.startCm) : 0,
    footer_text_top_cm: footer ? round(footer.topCm) : 0,
  };
}

/**
 * 算出一份配置对应的文字层。
 * @param {object} page   PageSetupConfig
 * @param {object} colors resolveChromeColors 的结果
 */
export function buildTextLayout(page, colors, geometry = resolveChromeLayout(page)) {
  const style = page.header_footer_style || 'plain';
  const { widthCm, heightCm: pageHeightCm, headerHeightCm, footerHeightCm, footerTopCm } = geometry;

  const headerSize = page.header_size || '小五';
  const headerText = String(page.header_text || '').trim();
  // 短标记只有 band 有落点，其余样式一律清空 —— 从 band 切走后配置里仍留着旧值。
  const headerBadgeText = style === 'band' ? String(page.header_badge_text || '').trim().slice(0, 4) : '';

  const headerLeftCm = page.header_text_left_cm;
  const headerTopCm = page.header_text_top_cm;
  const footerLeftCm = page.footer_text_left_cm;
  const footerTopCmConfig = page.footer_text_top_cm;

  // 页眉装饰带贴纸张顶边，所以它的「装饰带上沿」就是 0
  const box = fitTextBox(
    placeBox(
      headerHeightCm > 0 ? headerTextBox(style, widthCm, headerHeightCm) : null,
      headerLeftCm, headerTopCm, 0, headerHeightCm, widthCm,
    ),
    headerSize, pageHeightCm, headerText,
  );
  const header = {
    text: headerText,
    badgeText: headerBadgeText,
    color: headerTextColor(style, colors, page),
    bold: HEADER_BOLD.has(style),
    font: page.header_font || '宋体',
    size: headerSize,
    // 样式对齐统一使用现有两端都支持的中文值。
    align: box
      ? (['top-bar', 'frame'].includes(style) ? '居中对齐'
        : ['rules', 'footer-badge'].includes(style) ? (page.header_alignment || '居中对齐') : '左对齐')
      : (page.header_alignment || '居中对齐'),
    box,
    // band 的徽标文字单独一块，落在左侧 accent 块上。
    // 只吃上偏移不吃左偏移：徽标压在装饰里那块 1.15cm 的实色块上，左移就脱离色块了；
    // 竖直方向整条带子是满高的，跟着下移才能与页眉正文保持同一基线。
    badge: style === 'band' && box
      ? {
        color: colors.onAccent, bold: true, align: '居中对齐',
        box: fitTextBox(
          placeBox(
            { startCm: 0, endCm: HEADER_BADGE_WIDTH_CM, topCm: 0, heightCm: headerHeightCm },
            undefined, headerTopCm, 0, headerHeightCm, widthCm,
          ),
          headerSize, pageHeightCm, headerBadgeText,
        ),
      }
      : null,
  };

  const cols = FOOTER_COLUMNS[style] || FOOTER_COLUMNS.plain;
  const pn = pageNumberStyle(style, colors);
  const hasDecoration = cols.right > 0;
  const insetCm = style === 'frame' ? FOOTER_FRAME_INSET_CM + ptToCm(0.75) : 0;
  const rulesFooter = style === 'rules' && footerHeightCm > 0;
  const footerBox = footerTextBox(style, widthCm, footerHeightCm, footerTopCm);

  const footerSize = page.footer_size || '小五';
  const footerText = String(page.footer_enabled ? page.footer_text || '' : '').trim();
  const pageNumberFormat = page.page_number_format || '第{page}页';
  const pageNumberPad = Number(page.page_number_pad) || 0;
  // PAGE 域的实际位数要到 Word 里才知道，按至少两位估宽，避免页数上百时估窄。
  const pageNumberSample = formatPageNumber('0'.repeat(Math.max(2, pageNumberPad)), pageNumberFormat, 0);

  const pageNumberEnabled = page.page_number_enabled === true;

  // 页码关掉时两条链路都不会渲染页码框，这里也不能留着 —— 否则它会被
  // expandMarginsForText 计进正文下边距，凭空缩小正文区。
  const pageNumberBox = footerBox && !rulesFooter && pageNumberEnabled
    ? { ...footerBox, startCm: widthCm - cols.right + insetCm, endCm: widthCm - insetCm }
    : null;

  // rules 不分区，正文与页码合排在同一个框里（两条链路都用 4 个空格相连），
  // 估高必须按合排后的完整内容来，只按正文算会少估一行。
  const mergedFooterText = pageNumberBox
    ? footerText
    : [footerText, pageNumberEnabled ? pageNumberSample : ''].filter(Boolean).join('    ');

  // 页码区比正文区窄得多，折行判断必须各按各的宽度来，不能共用一个撑好的框。
  //
  // 落位在这里才发生，而 pageNumberBox 是从上面**未落位**的 footerBox 派生的，
  // 这样它的左右分区边界始终是样式默认值。页码只跟随 top：页码格是 FOOTER_COLUMNS
  // 右锚定的那块色格（band 的暗格、footer-badge 的 accent 格），左移就脱格了。
  const fittedFooterBox = fitTextBox(
    placeBox(footerBox, footerLeftCm, footerTopCmConfig, footerTopCm, footerHeightCm, widthCm),
    footerSize, pageHeightCm, mergedFooterText,
  );
  const fittedPageNumberBox = fitTextBox(
    placeBox(pageNumberBox, undefined, footerTopCmConfig, footerTopCm, footerHeightCm, widthCm),
    footerSize, pageHeightCm, pageNumberSample,
  );

  const footer = {
    text: footerText,
    color: page.footer_color || '#536176',
    font: page.footer_font || '宋体',
    size: footerSize,
    align: page.footer_alignment || '居中对齐',
    box: fittedFooterBox,
    pageNumber: {
      enabled: pageNumberEnabled,
      format: pageNumberFormat,
      pad: pageNumberPad,
      start: Math.max(1, Number(page.page_number_start) || 1),
      color: pn.color || page.footer_color || '#536176',
      shadingFill: pn.shadingFill,
      bold: hasDecoration,
      align: '居中对齐',
      // box 为 null 表示页码不单独占区，跟正文合排在 footer.box 里（rules 与无装饰样式）
      box: fittedPageNumberBox,
    },
  };

  return { style, header, footer };
}

/** 把 {page} 占位符换成实际页码（仅用于前端缩略图/预览的静态展示）。 */
export function formatPageNumber(pageNumber, format = '第{page}页', pad = 0) {
  const token = pad > 0 ? String(pageNumber).padStart(pad, '0') : String(pageNumber);
  return String(format).replace('{page}', token);
}
