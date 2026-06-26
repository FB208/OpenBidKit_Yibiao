const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { fileURLToPath } = require('node:url');
const { app, dialog, nativeImage } = require('electron');
const cheerio = require('cheerio');
const { imageSize } = require('image-size');
const { compactLogError, createDeveloperLogger, textMetrics } = require('../utils/developerLog.cjs');
const { getMermaidCacheEntry, saveMermaidCacheImage } = require('../utils/mermaidCache.cjs');
const { getGeneratedImagesDir, getImportedImagesDir } = require('../utils/paths.cjs');
const {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeightRule,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  LevelSuffix,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
} = require('docx');

const MAX_IMAGE_WIDTH = 520;
const NUMBERING_REFERENCE_PREFIX = 'technical-plan-numbering';
const HEADING_NUMBERING_REFERENCE = 'technical-plan-heading-numbering';
const DOCX_TABLE_WIDTH_TWIPS = 9000;
const MERMAID_EXPORT_RETRY_ATTEMPTS = 2;
const MERMAID_EXPORT_RETRY_DELAY_MS = 3000;

// 纸张尺寸 mm（portrait 模式 width × height），与 Renderer exportFormat.ts 保持一致
const PAPER_DIMENSIONS_MM = {
  a4: { width: 210, height: 297 },
  a3: { width: 297, height: 420 },
  a5: { width: 148, height: 210 },
  b4: { width: 250, height: 353 },
  b5: { width: 176, height: 250 },
  letter: { width: 215.9, height: 279.4 },
  legal: { width: 215.9, height: 355.6 },
  '16k': { width: 184, height: 260 },
};

function mmToTwips(mm) {
  return Math.round(mm * 56.6929); // 1mm = 1440 twips ÷ 25.4 mm/inch
}

function encodeMermaidForInk(code) {
  const state = JSON.stringify({
    code: String(code || ''),
    mermaid: { theme: 'default' },
  });
  return `pako:${zlib.deflateSync(Buffer.from(state, 'utf-8')).toString('base64url')}`;
}

function mermaidInkUrl(code) {
  return `https://mermaid.ink/img/${encodeMermaidForInk(code)}?type=png&bgColor=!white`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampPercent(value) {
  return Math.max(0, Math.min(Math.round(Number(value) || 0), 100));
}

function reportProgress(context, progress, message, extra = {}) {
  if (!context?.onProgress) return;
  try {
    context.onProgress({
      phase: extra.phase || 'running',
      progress: clampPercent(progress),
      message,
      warnings: [...(context.warnings || [])],
      ...extra,
    });
  } catch (error) {
    console.warn('[export-word] progress callback failed', error);
  }
}

function reportConversionProgress(context, message) {
  const stats = context?.stats || {};
  const total = Math.max(1, (stats.leafCount || 0) + (stats.mermaidCount || 0));
  const done = Math.min(total, (context.convertedLeafCount || 0) + (context.convertedMermaidCount || 0));
  reportProgress(context, 10 + (done / total) * 78, message);
}

function writeExportLog(context, event, payload = {}) {
  if (!context?.developerLogger?.enabled) return;
  context.developerLogger.write(event, payload);
}

function addWarning(context, message) {
  if (context?.warnings) {
    context.warnings.push(message);
  }
  writeExportLog(context, 'export.warning', { message });
  console.warn(`[export-word] ${message}`);
}

function addUnsupportedHtmlWarning(context, tagName) {
  const tag = String(tagName || '').toLowerCase();
  if (!tag) return;
  if (!context.unsupportedHtmlTags) {
    context.unsupportedHtmlTags = new Set();
  }
  if (context.unsupportedHtmlTags.has(tag)) {
    return;
  }
  context.unsupportedHtmlTags.add(tag);
  addWarning(context, `HTML 标签 <${tag}> 导出时已降级，请核对 Word 内容。`);
}

function compactText(value, maxLength = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function countMermaidBlocks(content) {
  return (String(content || '').match(/```mermaid[\s\S]*?```/gi) || []).length;
}

function countOutlineStats(items = []) {
  let leafCount = 0;
  let mermaidCount = 0;

  for (const item of items || []) {
    if (item.children?.length) {
      const childStats = countOutlineStats(item.children);
      leafCount += childStats.leafCount;
      mermaidCount += childStats.mermaidCount;
    } else {
      leafCount += 1;
      mermaidCount += countMermaidBlocks(item.content);
    }
  }

  return { leafCount, mermaidCount };
}

function collectOutlineContents(items = []) {
  const contents = [];
  for (const item of items || []) {
    if (item.children?.length) {
      contents.push(...collectOutlineContents(item.children));
    } else {
      contents.push(String(item.content || ''));
    }
  }
  return contents;
}

function countOutlineContentMetrics(items = []) {
  const contents = collectOutlineContents(items);
  return {
    ...textMetrics(contents.join('\n\n')),
    leaf_content_count: contents.filter((content) => content.trim()).length,
  };
}

function loadDeveloperConfig(configStore) {
  try {
    return configStore?.load?.() || {};
  } catch {
    return {};
  }
}

function sanitizeFilename(value) {
  return String(value || '标书文档')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || '标书文档';
}

function formatExportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function cleanText(value) {
  return String(value || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function normalizeDocxColor(value, fallback = '536176') {
  const raw = String(value || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(raw)) return raw.toUpperCase();
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return raw.split('').map((char) => `${char}${char}`).join('').toUpperCase();
  }
  return fallback;
}

function textRun(text, options = {}) {
  return new TextRun({
    text: cleanText(text),
    font: options.font || '宋体',
    size: options.size || 24,
    bold: options.bold,
    italics: options.italics,
    strike: options.strike,
    color: options.color,
    underline: options.underline ? { type: UnderlineType.SINGLE } : undefined,
  });
}

function lineBreakRun() {
  return new TextRun({ break: 1 });
}

function textRunsWithBreaks(value, options = {}) {
  const parts = String(value || '').split(/<br\s*\/?\s*>/gi);
  const runs = [];

  parts.forEach((part, index) => {
    if (index > 0) {
      runs.push(lineBreakRun());
    }
    if (part) {
      runs.push(textRun(part, options));
    }
  });

  return runs;
}

function paragraph(children, options = {}) {
  return new Paragraph({
    children: children?.length ? children : [textRun('')],
    heading: options.heading,
    alignment: options.alignment,
    bullet: options.bullet,
    numbering: options.numbering,
    spacing: { before: options.before || 0, after: options.after ?? 160, line: options.line || 360 },
    indent: options.indent,
    border: options.border,
    shading: options.shading,
  });
}

function isFooterEnabled(pageSetup) {
  return pageSetup ? pageSetup.footer_enabled !== false : true;
}

function isPageNumberEnabled(pageSetup) {
  return pageSetup ? pageSetup.page_number_enabled !== false : true;
}

function getChapterFrameConfig(exportFormat) {
  const frame = exportFormat?.heading_border;
  if (!frame?.enabled) return null;
  const color = normalizeDocxColor(frame.border_color || '#2174fd', '2174FD');
  return {
    color,
    fills: [14, 10, 6, 3, 0, 0].map((weight) => mixDocxColor(color, 'FFFFFF', weight)),
  };
}

function hexToRgb(value) {
  const hex = normalizeDocxColor(value, '000000');
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function mixDocxColor(source, target, sourceWeightPercent) {
  const from = hexToRgb(source);
  const to = hexToRgb(target);
  const weight = Math.max(0, Math.min(Number(sourceWeightPercent) || 0, 100)) / 100;
  const channel = (a, b) => Math.round(a * weight + b * (1 - weight)).toString(16).padStart(2, '0').toUpperCase();
  return `${channel(from.r, to.r)}${channel(from.g, to.g)}${channel(from.b, to.b)}`;
}

function chapterHeadingRowStyle(level) {
  const table = [
    { height: 520, top: 120, bottom: 120, left: 180, right: 180 },
    { height: 430, top: 100, bottom: 100, left: 260, right: 180 },
    { height: 360, top: 80, bottom: 80, left: 340, right: 180 },
    { height: 320, top: 70, bottom: 70, left: 420, right: 180 },
    { height: 290, top: 60, bottom: 60, left: 500, right: 180 },
    { height: 270, top: 55, bottom: 55, left: 580, right: 180 },
  ];
  return table[Math.max(0, Math.min(level - 1, table.length - 1))];
}

function buildChapterHeadingRow(exportFormat, headingParagraph, level) {
  const frame = getChapterFrameConfig(exportFormat);
  if (!frame) return undefined;
  const border = { style: BorderStyle.SINGLE, size: 6, color: frame.color };
  const none = { style: BorderStyle.NIL, size: 0, color: 'FFFFFF' };
  const rowStyle = chapterHeadingRowStyle(level);

  return new TableRow({
    cantSplit: true,
    height: { value: rowStyle.height, rule: HeightRule.ATLEAST },
    children: [new TableCell({
      children: [headingParagraph],
      shading: { type: ShadingType.CLEAR, fill: frame.fills[Math.max(0, Math.min(level - 1, 5))] || 'FFFFFF' },
      margins: { top: rowStyle.top, bottom: rowStyle.bottom, left: rowStyle.left, right: rowStyle.right },
      width: { size: DOCX_TABLE_WIDTH_TWIPS, type: WidthType.DXA },
      borders: { top: border, left: border, right: border, bottom: border },
    })],
  });
}

function buildChapterContentRow(exportFormat, bodyChildren) {
  const frame = getChapterFrameConfig(exportFormat);
  if (!frame) return undefined;
  const border = { style: BorderStyle.SINGLE, size: 6, color: frame.color };
  const none = { style: BorderStyle.NIL, size: 0, color: 'FFFFFF' };
  const body = bodyChildren?.length ? bodyChildren : [paragraph([textRun('')], { after: 0 })];

  return new TableRow({
    children: [new TableCell({
      children: body,
      margins: { top: 200, bottom: 220, left: 260, right: 260 },
      width: { size: DOCX_TABLE_WIDTH_TWIPS, type: WidthType.DXA },
      borders: { top: none, left: border, right: border, bottom: border },
    })],
  });
}

function buildChapterFrameTable(exportFormat, rows) {
  const frame = getChapterFrameConfig(exportFormat);
  if (!frame) return undefined;
  const border = { style: BorderStyle.SINGLE, size: 6, color: frame.color };
  const none = { style: BorderStyle.NIL, size: 0, color: 'FFFFFF' };

  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [DOCX_TABLE_WIDTH_TWIPS],
    layout: TableLayoutType.FIXED,
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: none,
    },
  });
}

function createPageNumberRuns(format, runOptions) {
  const parts = String(format || '第{page}页').split('{page}');
  const runs = [];

  if (parts[0]) {
    runs.push(new TextRun({ ...runOptions, text: cleanText(parts[0]) }));
  }
  runs.push(new TextRun({ ...runOptions, children: [PageNumber.CURRENT] }));
  if (parts[1]) {
    runs.push(new TextRun({ ...runOptions, text: cleanText(parts[1]) }));
  }

  return runs;
}

function buildWordHeaders(pageSetup) {
  const enabled = pageSetup ? pageSetup.header_enabled === true : false;
  const headerText = cleanText(pageSetup?.header_text || '').trim();
  if (!enabled || !headerText) return undefined;

  const runOptions = {
    font: pageSetup?.header_font || '宋体',
    size: chineseSizeToHalfPt(pageSetup?.header_size || '小五'),
    color: normalizeDocxColor(pageSetup?.header_color || '#536176'),
  };

  return {
    default: new Header({
      children: [
        new Paragraph({
          alignment: alignmentToWordType(pageSetup?.header_alignment || '居中对齐'),
          children: [new TextRun({ ...runOptions, text: headerText })],
        }),
      ],
    }),
  };
}

function buildWordFooters(pageSetup) {
  const footerEnabled = isFooterEnabled(pageSetup);
  const footerText = footerEnabled ? cleanText(pageSetup?.footer_text || '').trim() : '';
  const pageNumberEnabled = isPageNumberEnabled(pageSetup);
  if (!footerText && !pageNumberEnabled) return undefined;

  const runOptions = {
    font: pageSetup?.footer_font || '宋体',
    size: chineseSizeToHalfPt(pageSetup?.footer_size || '小五'),
    color: normalizeDocxColor(pageSetup?.footer_color || '#536176'),
  };
  const footerChildren = [];

  if (footerText) {
    footerChildren.push(new TextRun({ ...runOptions, text: footerText }));
  }
  if (footerText && pageNumberEnabled) {
    footerChildren.push(new TextRun({ ...runOptions, text: '    ' }));
  }
  if (pageNumberEnabled) {
    footerChildren.push(...createPageNumberRuns(pageSetup?.page_number_format || '第{page}页', runOptions));
  }

  return {
    default: new Footer({
      children: [
        new Paragraph({
          alignment: alignmentToWordType(footerEnabled ? (pageSetup?.footer_alignment || '居中对齐') : '居中对齐'),
          children: footerChildren,
        }),
      ],
    }),
  };
}

function tableBorders() {
  return {
    top: { style: BorderStyle.SINGLE, size: 1, color: 'DCDFF6' },
    bottom: { style: BorderStyle.SINGLE, size: 1, color: 'DCDFF6' },
    left: { style: BorderStyle.SINGLE, size: 1, color: 'DCDFF6' },
    right: { style: BorderStyle.SINGLE, size: 1, color: 'DCDFF6' },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'E8EDF6' },
    insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'E8EDF6' },
  };
}

function tableColumnWidths(columnCount) {
  const safeCount = Math.max(1, columnCount || 1);
  const base = Math.floor(DOCX_TABLE_WIDTH_TWIPS / safeCount);
  const widths = Array.from({ length: safeCount }, () => base);
  widths[widths.length - 1] += DOCX_TABLE_WIDTH_TWIPS - (base * safeCount);
  return widths;
}

function tableCellWidth(columnSpan, totalColumns) {
  const safeTotal = Math.max(1, totalColumns || 1);
  const safeSpan = Math.max(1, columnSpan || 1);
  return Math.round((DOCX_TABLE_WIDTH_TWIPS * safeSpan) / safeTotal);
}

function createTableCell({ children, isHeader = false, columnSpan = 1, totalColumns = 1 }) {
  const safeSpan = Math.max(1, columnSpan || 1);
  return new TableCell({
    children,
    shading: isHeader ? { type: ShadingType.CLEAR, fill: 'F1F6FF' } : undefined,
    margins: { top: 120, bottom: 120, left: 140, right: 140 },
    columnSpan: safeSpan > 1 ? safeSpan : undefined,
    width: { size: tableCellWidth(safeSpan, totalColumns), type: WidthType.DXA },
  });
}

function createDocxTable(rows, columnCount) {
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: tableColumnWidths(columnCount),
    layout: TableLayoutType.FIXED,
    borders: tableBorders(),
  });
}

function normalizeColumnSpan(value) {
  const span = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(span) && span > 1 ? span : 1;
}

function isMarkdownTableRowLine(line) {
  return /^\s*\|.*\|\s*$/.test(String(line || ''));
}

function isMarkdownTableDelimiterLine(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(line || ''));
}

function splitMarkdownTableCells(line) {
  let source = String(line || '').trim();
  if (!source.includes('|')) {
    return [];
  }
  if (source.startsWith('|')) {
    source = source.slice(1);
  }
  if (source.endsWith('|')) {
    source = source.slice(0, -1);
  }

  const cells = [];
  let current = '';
  let escaped = false;
  for (const char of source) {
    if (char === '|' && !escaped) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
    escaped = char === '\\' && !escaped;
  }
  cells.push(current.trim());
  return cells;
}

function isMarkdownTableDelimiterCell(cell) {
  return /^:?-{3,}:?$/.test(String(cell || '').trim());
}

function markdownTableRowIndent(line) {
  const match = /^(\s*)\|/.exec(String(line || ''));
  return match ? match[1] : '';
}

function formatMarkdownTableRow(cells, indent = '') {
  return `${indent}| ${cells.map((cell) => String(cell || '').trim()).join(' | ')} |`;
}

function expandCompressedMarkdownTableRows(headerLine, nextLine) {
  if (!isMarkdownTableRowLine(headerLine) || !isMarkdownTableRowLine(nextLine)) {
    return null;
  }

  const headerCells = splitMarkdownTableCells(headerLine);
  const nextCells = splitMarkdownTableCells(nextLine);
  const columnCount = headerCells.length;
  if (columnCount < 2 || nextCells.length <= columnCount) {
    return null;
  }

  const delimiterCells = nextCells.slice(0, columnCount);
  if (!delimiterCells.every(isMarkdownTableDelimiterCell)) {
    return null;
  }

  // 模型有时会把分隔行和后续数据行压成同一行，这里按表头列数拆回 GFM 表格。
  const indent = markdownTableRowIndent(headerLine);
  const lines = [formatMarkdownTableRow(headerCells, indent), formatMarkdownTableRow(delimiterCells, indent)];
  const remainingCells = nextCells.slice(columnCount);
  while (remainingCells.length) {
    if (remainingCells.length > columnCount && !remainingCells[0] && remainingCells.length % columnCount !== 0) {
      remainingCells.shift();
      continue;
    }
    const rowCells = remainingCells.splice(0, columnCount);
    if (rowCells.some((cell) => String(cell || '').trim())) {
      lines.push(formatMarkdownTableRow(rowCells, indent));
    }
  }

  return lines;
}

function expandInlineMarkdownTableRows(line) {
  const source = String(line || '');
  if (!/\|\s*:?-{3,}:?\s*\|/.test(source)) {
    return [source];
  }

  const firstPipeIndex = source.indexOf('|');
  if (firstPipeIndex < 0) {
    return [source];
  }

  const prefix = source.slice(0, firstPipeIndex);
  const isIndentedTableLine = /^\s*$/.test(prefix);
  const tableText = source.slice(firstPipeIndex).trim();
  const tableRows = tableText
    .replace(/\|\s+\|/g, '|\n|')
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean);

  if (isIndentedTableLine) {
    return tableRows.map((row) => `${prefix}${row}`);
  }

  return [prefix.trimEnd(), ...tableRows];
}

function normalizeMarkdownTablesForDocx(content) {
  const expandedLines = String(content || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap(expandInlineMarkdownTableRows);
  const lines = [];

  for (let index = 0; index < expandedLines.length; index += 1) {
    const line = expandedLines[index];
    const nextLine = expandedLines[index + 1] || '';
    const compressedTableRows = expandCompressedMarkdownTableRows(line, nextLine);
    const startsCompressedTable = Boolean(compressedTableRows);
    const startsTable = isMarkdownTableRowLine(line) && isMarkdownTableDelimiterLine(nextLine);
    const previousLine = lines[lines.length - 1] || '';

    if ((startsTable || startsCompressedTable) && previousLine.trim() && !isMarkdownTableRowLine(previousLine)) {
      lines.push('');
    }
    if (compressedTableRows) {
      lines.push(...compressedTableRows);
      index += 1;
      continue;
    }
    lines.push(line);
  }

  return lines.join('\n');
}

function createOrderedListReference(context) {
  if (!context.numberingReferences) {
    context.numberingReferences = [];
  }
  context.numberingIndex = (context.numberingIndex || 0) + 1;
  const reference = `${NUMBERING_REFERENCE_PREFIX}-${context.numberingIndex}`;
  context.numberingReferences.push(reference);
  return reference;
}

function headingLevel(level) {
  if (level <= 1) return HeadingLevel.HEADING_1;
  if (level === 2) return HeadingLevel.HEADING_2;
  if (level === 3) return HeadingLevel.HEADING_3;
  if (level === 4) return HeadingLevel.HEADING_4;
  if (level === 5) return HeadingLevel.HEADING_5;
  return HeadingLevel.HEADING_6;
}

// ── 导出格式工具函数 ────────────────────────────

const SIZE_TO_HALF_PT = {
  '初号': 84, '小初': 72, '一号': 52, '小一': 48, '二号': 44, '小二': 36,
  '三号': 32, '小三': 30, '四号': 28, '小四': 24, '五号': 21, '小五': 18,
  '六号': 15, '小六': 13,
};

function chineseSizeToHalfPt(sizeName) {
  return SIZE_TO_HALF_PT[sizeName] || 24;
}

function cmToTwips(cm) {
  return Math.round((cm || 0) * 567);
}

function alignmentToWordType(align) {
  const map = {
    '居中对齐': AlignmentType.CENTER,
    '两端对齐': AlignmentType.JUSTIFIED,
    '左对齐': AlignmentType.LEFT,
    '右对齐': AlignmentType.RIGHT,
  };
  return map[align] || AlignmentType.JUSTIFIED;
}

function numberToChinese(num) {
  const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const tens = ['', '十', '二十', '三十', '四十', '五十', '六十', '七十', '八十', '九十'];
  const n = Math.max(1, Math.min(9999, Math.floor(Number(num) || 1)));
  if (n <= 9) return digits[n];
  if (n <= 19) return `十${n === 10 ? '' : digits[n - 10]}`;
  if (n <= 99) {
    const t = Math.floor(n / 10);
    const o = n % 10;
    return `${tens[t]}${o ? digits[o] : ''}`;
  }
  if (n <= 999) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return `${digits[h]}百${r === 0 ? '' : r <= 9 ? `零${digits[r]}` : r <= 19 ? `一${numberToChinese(r)}` : numberToChinese(r)}`;
  }
  const th = Math.floor(n / 1000);
  const r = n % 1000;
  return `${digits[th]}千${r === 0 ? '' : r < 100 ? `零${numberToChinese(r)}` : numberToChinese(r)}`;
}

function outlineNumberParts(id) {
  return String(id || '')
    .split('.')
    .map((part) => parseInt(part, 10))
    .filter((part) => Number.isFinite(part) && part > 0);
}

function formatOutlineNumber(id, headingStyle) {
  const parts = outlineNumberParts(id);
  if (!parts.length) return '';

  if (headingStyle?.numbering_format === 'outline-decimal') {
    return parts.join('.');
  }

  if (headingStyle?.numbering_format !== 'custom') return '';

  const lastPart = parts[parts.length - 1];
  const cn = numberToChinese(lastPart);
  return String(headingStyle.numbering_template || '')
    .replace(/\{zh\}/g, cn)
    .replace(/\{num\}/g, String(lastPart))
    .trim();
}

function formatOutlineTitle(id, title, headingStyle) {
  const prefix = formatOutlineNumber(id, headingStyle);
  return prefix ? `${prefix} ${title || ''}` : String(title || '');
}

function getHeadingStyle(exportFormat, level) {
  const headings = (exportFormat && Array.isArray(exportFormat.headings)) ? exportFormat.headings : [];
  const idx = Math.min(level - 1, 5);
  return headings[idx] || null;
}

function usesNativeHeadingNumbering(headingStyle) {
  return headingStyle?.numbering_format === 'outline-decimal';
}

function imageTypeFromMime(mime) {
  if (!mime) return null;
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('bmp')) return 'bmp';
  if (mime.includes('webp')) return 'webp';
  return null;
}

function imageTypeFromPath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase().replace('.', '');
  if (ext === 'jpeg') return 'jpg';
  return ['png', 'jpg', 'gif', 'bmp', 'webp'].includes(ext) ? ext : null;
}

function describeImageSourceForLog(source) {
  const value = String(source || '').trim();
  if (!value) return { kind: 'empty' };
  if (/^data:/i.test(value)) return { kind: 'data-url' };
  try {
    const url = new URL(value);
    if (url.protocol === 'yibiao-asset:') {
      return { kind: 'asset', host: url.hostname, extension: path.extname(url.pathname || '').toLowerCase() };
    }
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return { kind: 'remote', protocol: url.protocol.replace(':', ''), host: url.hostname, extension: path.extname(url.pathname || '').toLowerCase() };
    }
    if (url.protocol === 'file:') {
      return { kind: 'local-file-url', extension: path.extname(url.pathname || '').toLowerCase() };
    }
    return { kind: 'url', protocol: url.protocol.replace(':', '') };
  } catch {
    return { kind: path.isAbsolute(value) ? 'local-path' : 'relative-path', extension: path.extname(value).toLowerCase() };
  }
}

function normalizeImageForDocx(loaded) {
  if (!loaded?.buffer || !loaded.type) {
    return loaded;
  }

  if (loaded.type !== 'webp') {
    return loaded;
  }

  const image = nativeImage?.createFromBuffer ? nativeImage.createFromBuffer(loaded.buffer) : null;
  if (!image || image.isEmpty()) {
    throw new Error('WebP 图片转换失败');
  }

  return { buffer: image.toPNG(), type: 'png' };
}

function resolveAssetImagePath(url) {
  if (!app?.getPath) return null;

  const assetUrl = new URL(url);
  const assetRoots = {
    'generated-images': getGeneratedImagesDir(app),
    'imported-images': getImportedImagesDir(app),
  };
  const rootDir = assetRoots[assetUrl.hostname];
  if (!rootDir) return null;

  const relativePath = decodeURIComponent(assetUrl.pathname.replace(/^\/+/, ''));
  if (!relativePath) return null;

  const baseDir = path.resolve(rootDir);
  const resolvedPath = path.resolve(baseDir, relativePath);
  if (resolvedPath !== baseDir && !resolvedPath.startsWith(`${baseDir}${path.sep}`)) {
    return null;
  }

  return resolvedPath;
}

async function loadImage(source, context = {}) {
  const url = String(source || '').trim();
  if (!url) return null;

  const dataUrlMatch = /^data:([^;,]+);base64,(.+)$/i.exec(url);
  if (dataUrlMatch) {
    return {
      buffer: Buffer.from(dataUrlMatch[2], 'base64'),
      type: imageTypeFromMime(dataUrlMatch[1]),
    };
  }

  if (/^yibiao-asset:\/\//i.test(url)) {
    const assetPath = resolveAssetImagePath(url);
    if (!assetPath || !fs.existsSync(assetPath)) {
      return null;
    }

    return {
      buffer: fs.readFileSync(assetPath),
      type: imageTypeFromPath(assetPath),
    };
  }

  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`图片下载失败：${url}`);
    }
    const type = imageTypeFromMime(response.headers.get('content-type')) || imageTypeFromPath(new URL(url).pathname);
    return { buffer: Buffer.from(await response.arrayBuffer()), type };
  }

  const fileUrlPrefix = 'file://';
  const rawPath = url.startsWith(fileUrlPrefix) ? fileURLToPath(url) : url;
  const resolvedPath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(context.baseDir || process.cwd(), rawPath);

  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  return {
    buffer: fs.readFileSync(resolvedPath),
    type: imageTypeFromPath(resolvedPath),
  };
}

async function loadImageWithRetry(source, context = {}, options = {}) {
  const retryAttempts = Math.max(0, Number(options.retryAttempts) || 0);
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs) || 0);
  let attempt = 0;

  while (attempt <= retryAttempts) {
    try {
      return await loadImage(source, context);
    } catch (error) {
      if (attempt >= retryAttempts) {
        throw error;
      }

      attempt += 1;
      if (typeof options.onRetry === 'function') {
        options.onRetry(attempt, error);
      }
      if (retryDelayMs > 0) {
        await delay(retryDelayMs);
      }
    }
  }

  return null;
}

async function resolveMermaidImageForExport(code, context = {}, options = {}) {
  const cacheEntry = options.cacheEntry || getMermaidCacheEntry(app, code);
  if (cacheEntry.exists) {
    return {
      source: cacheEntry.assetUrl,
      cacheHit: true,
      cacheHash: cacheEntry.hash,
    };
  }

  const loaded = await loadImageWithRetry(mermaidInkUrl(cacheEntry.code), context, options.loadRetry);
  if (loaded?.buffer?.length) {
    try {
      saveMermaidCacheImage(app, cacheEntry.hash, loaded.buffer);
    } catch (error) {
      writeExportLog(context, 'export.mermaid.cache_write_failed', {
        cache_hash: cacheEntry.hash,
        error: compactLogError(error),
      });
    }
  }

  return {
    source: cacheEntry.assetUrl,
    loaded,
    cacheHit: false,
    cacheHash: cacheEntry.hash,
  };
}

async function imageRunFromNode(node, context, options = {}) {
  let loaded = null;
  const imageLabel = compactText(node.alt || node.url || '未知图片');
  const imageIndex = (context.imageCount || 0) + 1;
  context.imageCount = imageIndex;
  writeExportLog(context, 'export.image.started', {
    image_index: imageIndex,
    label: imageLabel,
    source: describeImageSourceForLog(node.url),
  });
  try {
    loaded = Object.prototype.hasOwnProperty.call(options, 'loadedImage')
      ? options.loadedImage
      : await loadImageWithRetry(node.url, context, options.loadRetry);
  } catch (error) {
    const message = `图片无法导出：${imageLabel}，${compactText(error.message || '下载失败', 120)}`;
    addWarning(context, message);
    writeExportLog(context, 'export.image.error', {
      image_index: imageIndex,
      label: imageLabel,
      phase: 'load',
      error: compactLogError(error),
    });
    return textRun(`[${message}]`, { color: 'C83220' });
  }
  if (!loaded?.buffer || !loaded.type) {
    const message = `图片无法导出：${imageLabel}，未找到可用图片数据`;
    addWarning(context, message);
    writeExportLog(context, 'export.image.error', {
      image_index: imageIndex,
      label: imageLabel,
      phase: 'load',
      reason: 'missing_image_data',
    });
    return textRun(`[${message}]`, { color: 'C83220' });
  }

  try {
    loaded = normalizeImageForDocx(loaded);
  } catch (error) {
    const message = `图片无法导出：${imageLabel}，${error.message || '图片格式转换失败'}`;
    addWarning(context, message);
    writeExportLog(context, 'export.image.error', {
      image_index: imageIndex,
      label: imageLabel,
      phase: 'normalize',
      source_type: loaded.type,
      error: compactLogError(error),
    });
    return textRun(`[${message}]`, { color: 'C83220' });
  }

  let size;
  try {
    size = imageSize(loaded.buffer);
  } catch (error) {
    const message = `图片无法导出：${imageLabel}，图片尺寸识别失败`;
    addWarning(context, message);
    writeExportLog(context, 'export.image.error', {
      image_index: imageIndex,
      label: imageLabel,
      phase: 'size',
      type: loaded.type,
      bytes: loaded.buffer.length,
      error: compactLogError(error),
    });
    return textRun(`[${message}]`, { color: 'C83220' });
  }
  const sourceWidth = size.width || MAX_IMAGE_WIDTH;
  const sourceHeight = size.height || Math.round(MAX_IMAGE_WIDTH * 0.62);
  const ratio = Math.min(1, MAX_IMAGE_WIDTH / sourceWidth);
  const width = Math.round(sourceWidth * ratio);
  const height = Math.round(sourceHeight * ratio);
  context.imageSuccessCount = (context.imageSuccessCount || 0) + 1;
  writeExportLog(context, 'export.image.completed', {
    image_index: imageIndex,
    label: imageLabel,
    type: loaded.type,
    bytes: loaded.buffer.length,
    source_width: sourceWidth,
    source_height: sourceHeight,
    output_width: width,
    output_height: height,
  });

  return new ImageRun({
    type: loaded.type,
    data: loaded.buffer,
    transformation: { width, height },
    altText: {
      title: cleanText(node.alt || '图片'),
      description: cleanText(node.alt || node.url || 'Markdown 图片'),
      name: cleanText(node.alt || 'image'),
    },
  });
}

async function imageParagraphFromSource(source, alt, context, options = {}) {
  return paragraph([await imageRunFromNode({ url: source, alt }, context, options)], { alignment: AlignmentType.CENTER });
}

async function imageParagraphFromLoadedImage(source, alt, loadedImage, context, options = {}) {
  return paragraph([
    await imageRunFromNode({ url: source, alt }, context, { ...options, loadedImage }),
  ], { alignment: AlignmentType.CENTER });
}

async function inlineRuns(nodes = [], context = {}, marks = {}) {
  // 正文样式作为基础，调用方显式传入的 font/size 覆盖（如标题、代码）
  if (context.bodyRunFont && !('font' in marks)) {
    marks = { font: context.bodyRunFont, ...marks };
  }
  if (context.bodyRunSize && !('size' in marks)) {
    marks = { size: context.bodyRunSize, ...marks };
  }
  const runs = [];

  for (const node of nodes) {
    if (node.type === 'text') {
      runs.push(...textRunsWithBreaks(node.value, marks));
    } else if (node.type === 'strong') {
      runs.push(...await inlineRuns(node.children, context, { ...marks, bold: true }));
    } else if (node.type === 'emphasis') {
      runs.push(...await inlineRuns(node.children, context, { ...marks, italics: true }));
    } else if (node.type === 'delete') {
      runs.push(...await inlineRuns(node.children, context, { ...marks, strike: true }));
    } else if (node.type === 'inlineCode') {
      runs.push(new TextRun({ text: cleanText(node.value), font: 'Consolas', size: 22, color: '155BD7' }));
    } else if (node.type === 'break') {
      runs.push(lineBreakRun());
    } else if (node.type === 'html' && /^<br\s*\/?\s*>$/i.test(String(node.value || '').trim())) {
      runs.push(lineBreakRun());
    } else if (node.type === 'html') {
      const $ = cheerio.load(String(node.value || ''), null, false);
      runs.push(...await htmlInlineRuns($, $.root().contents().toArray(), context, marks));
    } else if (node.type === 'link') {
      const children = await inlineRuns(node.children, context, { ...marks, color: '2174FD', underline: true });
      runs.push(new ExternalHyperlink({ link: node.url, children }));
    } else if (node.type === 'image') {
      runs.push(await imageRunFromNode(node, context));
    } else if (node.children) {
      runs.push(...await inlineRuns(node.children, context, marks));
    }
  }

  return runs;
}

function nodeText(node) {
  if (!node) return '';
  if (node.type === 'text' || node.type === 'inlineCode') return String(node.value || '');
  return (node.children || []).map(nodeText).join('');
}

function isImageOnlyParagraph(node) {
  return (node.children || []).filter((child) => child.type !== 'text' || String(child.value || '').trim()).length === 1
    && (node.children || []).some((child) => child.type === 'image');
}

function isFigureCaptionParagraph(node) {
  return /^图[:：]/.test(nodeText(node).trim());
}

function htmlTagName(node) {
  return String(node?.name || '').toLowerCase();
}

function hasBlockHtmlChildren($, node) {
  return $(node).contents().toArray().some((child) => ['table', 'ul', 'ol', 'blockquote', 'pre', 'div', 'section', 'article', 'img'].includes(htmlTagName(child)));
}

async function htmlInlineRuns($, nodes = [], context = {}, marks = {}) {
  // 正文样式作为基础，调用方显式传入的 font/size 覆盖
  if (context.bodyRunFont && !('font' in marks)) {
    marks = { font: context.bodyRunFont, ...marks };
  }
  if (context.bodyRunSize && !('size' in marks)) {
    marks = { size: context.bodyRunSize, ...marks };
  }
  const runs = [];

  for (const node of nodes) {
    if (node.type === 'text') {
      runs.push(...textRunsWithBreaks(node.data || '', marks));
      continue;
    }

    if (node.type !== 'tag') {
      continue;
    }

    const tag = htmlTagName(node);
    if (tag === 'br') {
      runs.push(lineBreakRun());
    } else if (tag === 'strong' || tag === 'b') {
      runs.push(...await htmlInlineRuns($, $(node).contents().toArray(), context, { ...marks, bold: true }));
    } else if (tag === 'em' || tag === 'i') {
      runs.push(...await htmlInlineRuns($, $(node).contents().toArray(), context, { ...marks, italics: true }));
    } else if (tag === 'code') {
      runs.push(new TextRun({ text: cleanText($(node).text()), font: 'Consolas', size: 22, color: '155BD7' }));
    } else if (tag === 'a') {
      const href = $(node).attr('href') || '';
      const children = await htmlInlineRuns($, $(node).contents().toArray(), context, { ...marks, color: '2174FD', underline: true });
      if (href) {
        runs.push(new ExternalHyperlink({ link: href, children }));
      } else {
        runs.push(...children);
      }
    } else if (tag === 'img') {
      runs.push(await imageRunFromNode({ url: $(node).attr('src'), alt: $(node).attr('alt') || 'HTML 图片' }, context));
    } else {
      if (!['span', 'small', 'sub', 'sup'].includes(tag)) {
        addUnsupportedHtmlWarning(context, tag);
      }
      runs.push(...await htmlInlineRuns($, $(node).contents().toArray(), context, marks));
    }
  }

  return runs;
}

async function htmlTableToDocx($, tableNode, context) {
  const rows = [];
  const rowDescriptors = $(tableNode).find('tr').toArray().map((rowNode) => {
    const cells = $(rowNode).children('th,td').toArray().map((cellNode) => ({
      node: cellNode,
      columnSpan: normalizeColumnSpan($(cellNode).attr('colspan')),
    }));
    return {
      cells,
      columnCount: cells.reduce((sum, cell) => sum + cell.columnSpan, 0),
    };
  }).filter((row) => row.cells.length);
  const maxColumns = Math.max(1, ...rowDescriptors.map((row) => row.columnCount));

  for (const row of rowDescriptors) {
    const cells = [];
    for (const [cellIndex, cell] of row.cells.entries()) {
      const cellNode = cell.node;
      const isHeader = htmlTagName(cellNode) === 'th';
      const remainingSpan = cellIndex === row.cells.length - 1 ? maxColumns - row.columnCount : 0;
      cells.push(createTableCell({
        children: [paragraph(await htmlInlineRuns($, $(cellNode).contents().toArray(), context, { bold: isHeader }), { after: 80 })],
        isHeader,
        columnSpan: cell.columnSpan + Math.max(0, remainingSpan),
        totalColumns: maxColumns,
      }));
    }
    rows.push(new TableRow({ children: cells }));
  }

  if (!rows.length) {
    return [];
  }

  return [createDocxTable(rows, maxColumns)];
}

async function htmlListToDocx($, listNode, context, options = {}) {
  const blocks = [];
  const ordered = htmlTagName(listNode) === 'ol';
  const numberingReference = ordered ? createOrderedListReference(context) : null;

  for (const itemNode of $(listNode).children('li').toArray()) {
    const inlineNodes = $(itemNode).contents().toArray().filter((child) => !['ul', 'ol'].includes(htmlTagName(child)));
    const listOptions = ordered
      ? { numbering: { reference: numberingReference, level: Math.min(options.listLevel || 0, 2) } }
      : { bullet: { level: Math.min(options.listLevel || 0, 2) } };
    // 列表项继承正文行距和段后间距
    if (context.bodyLineSpacing) listOptions.line = context.bodyLineSpacing;
    if (context.bodyAfterSpacing != null) listOptions.after = context.bodyAfterSpacing;
    blocks.push(paragraph(await htmlInlineRuns($, inlineNodes, context), listOptions));

    for (const childList of $(itemNode).children('ul,ol').toArray()) {
      blocks.push(...await htmlListToDocx($, childList, context, { ...options, listLevel: (options.listLevel || 0) + 1 }));
    }
  }

  return blocks;
}

/** 从 context 提取正文段落选项，供 HTML 正文段落使用 */
function buildHtmlBodyParaOpts(context) {
  const opts = {};
  if (context.bodyAfterSpacing != null) opts.after = context.bodyAfterSpacing;
  if (context.bodyLineSpacing) opts.line = context.bodyLineSpacing;
  if (context.bodyAlignment) opts.alignment = context.bodyAlignment;
  if (context.bodyIndent) opts.indent = context.bodyIndent;
  if (context.bodyBeforeSpacing) opts.before = context.bodyBeforeSpacing;
  return opts;
}

async function htmlNodeToDocxBlocks($, node, context, options = {}) {
  if (node.type === 'text') {
    const text = String(node.data || '').trim();
    if (!text) return [];
    const runOpts = {};
    if (context.bodyRunFont) runOpts.font = context.bodyRunFont;
    if (context.bodyRunSize) runOpts.size = context.bodyRunSize;
    const paraOpts = buildHtmlBodyParaOpts(context);
    return [paragraph([textRun(text, runOpts)], paraOpts)];
  }

  if (node.type !== 'tag') {
    return [];
  }

  const tag = htmlTagName(node);
  if (tag === 'table') {
    return htmlTableToDocx($, node, context);
  }
  if (tag === 'img') {
    return [await imageParagraphFromSource($(node).attr('src'), $(node).attr('alt') || 'HTML 图片', context)];
  }
  if (tag === 'ul' || tag === 'ol') {
    return htmlListToDocx($, node, context, options);
  }
  if (tag === 'blockquote') {
    return [paragraph(await htmlInlineRuns($, $(node).contents().toArray(), context, { color: '536176' }), {
      indent: { left: 360 },
      border: { left: { style: BorderStyle.SINGLE, size: 12, color: '2174FD' } },
      shading: { type: ShadingType.CLEAR, fill: 'F6F9FF' },
    })];
  }
  if (tag === 'pre') {
    return [paragraph([new TextRun({ text: cleanText($(node).text()), font: 'Consolas', size: 21, color: '243048' })], {
      shading: { type: ShadingType.CLEAR, fill: 'F6F9FF' },
      indent: { left: 260, right: 260 },
    })];
  }
  if (tag === 'br') {
    return [paragraph([lineBreakRun()])];
  }
  if (['div', 'section', 'article'].includes(tag) && hasBlockHtmlChildren($, node)) {
    return htmlNodesToDocxBlocks($, $(node).contents().toArray(), context, options);
  }
  if (tag === 'p' && hasBlockHtmlChildren($, node)) {
    return htmlNodesToDocxBlocks($, $(node).contents().toArray(), context, options);
  }
  if (['p', 'div', 'section', 'article', 'span', 'strong', 'b', 'em', 'i', 'a', 'code'].includes(tag)) {
    const isFigureCaption = /^图[:：]/.test($(node).text().trim());
    const htmlParaOpts = buildHtmlBodyParaOpts(context);
    if (isFigureCaption) {
      htmlParaOpts.alignment = AlignmentType.CENTER;
      delete htmlParaOpts.indent;
    }
    return [paragraph(await htmlInlineRuns($, $(node).contents().toArray(), context), htmlParaOpts)];
  }

  addUnsupportedHtmlWarning(context, tag);
  return htmlNodesToDocxBlocks($, $(node).contents().toArray(), context, options);
}

async function htmlNodesToDocxBlocks($, nodes = [], context = {}, options = {}) {
  const blocks = [];
  for (const node of nodes) {
    blocks.push(...await htmlNodeToDocxBlocks($, node, context, options));
  }
  return blocks;
}

async function htmlToDocxBlocks(html, context = {}, options = {}) {
  const source = String(html || '').trim();
  if (!source) {
    return [];
  }

  const $ = cheerio.load(source, null, false);
  const blocks = await htmlNodesToDocxBlocks($, $.root().contents().toArray(), context, options);
  if (!blocks.length) {
    addWarning(context, '部分 HTML 内容未能导出，请核对 Word 内容。');
  }
  return blocks;
}

async function tableCellParagraphs(cell, context, isHeader = false) {
  const phrasingNodes = (cell.children || []).filter((child) => child.type !== 'paragraph');
  if (phrasingNodes.length) {
    return [paragraph(await inlineRuns(phrasingNodes, context, { bold: isHeader }), { after: 80 })];
  }

  const blocks = await markdownNodesToDocx(cell.children || [], context, { inTable: true });
  if (!blocks.length) return [paragraph([textRun('')], { after: 80 })];
  return blocks.filter((block) => block instanceof Paragraph);
}

async function markdownNodesToDocx(nodes = [], context = {}, options = {}) {
  const blocks = [];

  for (const node of nodes) {
    if (node.type === 'heading') {
      const mdLevel = Math.min(node.depth || 1, 6);
      const style = getHeadingStyle(context.exportFormat, mdLevel);
      const headingOpts = {
        heading: headingLevel(mdLevel),
        before: style ? style.spacing_before_pt * 20 : (mdLevel === 1 ? 280 : 180),
        after: style ? style.spacing_after_pt * 20 : 120,
      };
      if (style) {
        headingOpts.alignment = alignmentToWordType(style.alignment);
        if (style.line_spacing) {
          headingOpts.line = 240 * style.line_spacing;
        }
        if (style.first_line_indent_chars > 0) {
          headingOpts.indent = { firstLine: style.first_line_indent_chars * 240 };
        }
      }
      const runMarks = {};
      if (style) {
        runMarks.font = style.font || '黑体';
        runMarks.size = chineseSizeToHalfPt(style.size || '小四');
        runMarks.bold = false;
      } else {
        runMarks.bold = true;
      }
      blocks.push(paragraph(await inlineRuns(node.children, context, runMarks), headingOpts));
    } else if (node.type === 'paragraph') {
      const isImagePara = !options.inTable && (isImageOnlyParagraph(node) || isFigureCaptionParagraph(node));
      const bodyParaOpts = {
        after: options.inTable ? 80 : (context.bodyAfterSpacing ?? 160),
        alignment: isImagePara ? AlignmentType.CENTER : (context.bodyAlignment || undefined),
      };
      if (!options.inTable && context.bodyLineSpacing) {
        bodyParaOpts.line = context.bodyLineSpacing;
      }
      if (!options.inTable && !isImagePara && context.bodyIndent) {
        bodyParaOpts.indent = context.bodyIndent;
      }
      if (!options.inTable && context.bodyBeforeSpacing) {
        bodyParaOpts.before = context.bodyBeforeSpacing;
      }
      blocks.push(paragraph(await inlineRuns(node.children, context), bodyParaOpts));
    } else if (node.type === 'list') {
      const numberingReference = node.ordered ? createOrderedListReference(context) : null;
      for (const item of node.children || []) {
        const firstParagraph = (item.children || []).find((child) => child.type === 'paragraph');
        const restChildren = (item.children || []).filter((child) => child !== firstParagraph);
        const listOptions = node.ordered
          ? { numbering: { reference: numberingReference, level: Math.min(options.listLevel || 0, 2) } }
          : { bullet: { level: Math.min(options.listLevel || 0, 2) } };
        // 列表项继承正文行距和段后间距
        if (context.bodyLineSpacing) listOptions.line = context.bodyLineSpacing;
        if (context.bodyAfterSpacing != null) listOptions.after = context.bodyAfterSpacing;
        blocks.push(paragraph(await inlineRuns(firstParagraph?.children || [], context), listOptions));
        blocks.push(...await markdownNodesToDocx(restChildren, context, { ...options, listLevel: (options.listLevel || 0) + 1 }));
      }
    } else if (node.type === 'table') {
      const rows = [];
      const maxColumns = Math.max(1, ...(node.children || []).map((row) => row.children?.length || 0));
      for (const [rowIndex, row] of (node.children || []).entries()) {
        const cells = [];
        const rowCells = row.children || [];
        for (const [cellIndex, cell] of rowCells.entries()) {
          const columnSpan = cellIndex === rowCells.length - 1
            ? Math.max(1, maxColumns - rowCells.length + 1)
            : 1;
          cells.push(createTableCell({
            children: await tableCellParagraphs(cell, context, rowIndex === 0),
            isHeader: rowIndex === 0,
            columnSpan,
            totalColumns: maxColumns,
          }));
        }
        rows.push(new TableRow({ children: cells }));
      }
      if (rows.length) {
        blocks.push(createDocxTable(rows, maxColumns));
      }
    } else if (node.type === 'blockquote') {
      for (const child of node.children || []) {
        if (child.type === 'paragraph') {
          blocks.push(paragraph(await inlineRuns(child.children, context, { color: '536176' }), {
            indent: { left: 360 },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: '2174FD' } },
            shading: { type: ShadingType.CLEAR, fill: 'F6F9FF' },
          }));
        } else {
          blocks.push(...await markdownNodesToDocx([child], context, options));
        }
      }
    } else if (node.type === 'code') {
      if (String(node.lang || '').toLowerCase() === 'mermaid') {
        const nextIndex = (context.convertedMermaidCount || 0) + 1;
        const total = context.stats?.mermaidCount || nextIndex;
        const cacheEntry = getMermaidCacheEntry(app, node.value);
        writeExportLog(context, 'export.mermaid.started', {
          mermaid_index: nextIndex,
          total,
          cache_hash: cacheEntry.hash,
          cache_hit: cacheEntry.exists,
          code_metrics: textMetrics(node.value),
        });
        reportConversionProgress(context, cacheEntry.exists
          ? `Mermaid 图 ${nextIndex}/${total} 已命中本地缓存。`
          : `正在转换 Mermaid 图 ${nextIndex}/${total}，可能需要联网等待。`);
        const loadRetry = {
          retryAttempts: MERMAID_EXPORT_RETRY_ATTEMPTS,
          retryDelayMs: MERMAID_EXPORT_RETRY_DELAY_MS,
          onRetry: (attempt) => {
            reportConversionProgress(context, `Mermaid 图 ${nextIndex}/${total} 转换失败，3 秒后第 ${attempt} 次重试。`);
          },
        };
        try {
          const mermaidImage = await resolveMermaidImageForExport(node.value, context, { cacheEntry, loadRetry });
          blocks.push(mermaidImage.loaded === undefined
            ? await imageParagraphFromSource(mermaidImage.source, 'Mermaid 图', context)
            : await imageParagraphFromLoadedImage(mermaidImage.source, 'Mermaid 图', mermaidImage.loaded, context));
          writeExportLog(context, 'export.mermaid.completed', {
            mermaid_index: nextIndex,
            total,
            cache_hash: mermaidImage.cacheHash,
            cache_hit: mermaidImage.cacheHit,
          });
          reportConversionProgress(context, mermaidImage.cacheHit
            ? `Mermaid 图 ${nextIndex}/${total} 已使用本地缓存。`
            : `Mermaid 图 ${nextIndex}/${total} 已转换并缓存。`);
        } catch (error) {
          const message = `Mermaid 图无法导出：${compactText(error.message || '转换失败', 120)}`;
          addWarning(context, message);
          writeExportLog(context, 'export.mermaid.error', {
            mermaid_index: nextIndex,
            total,
            cache_hash: cacheEntry.hash,
            error: compactLogError(error),
          });
          blocks.push(paragraph([textRun(`[${message}]`, { color: 'C83220' })], { alignment: AlignmentType.CENTER }));
          reportConversionProgress(context, `Mermaid 图 ${nextIndex}/${total} 转换失败。`);
        }
        context.convertedMermaidCount = nextIndex;
      } else {
        blocks.push(paragraph([new TextRun({ text: cleanText(node.value), font: 'Consolas', size: 21, color: '243048' })], {
          shading: { type: ShadingType.CLEAR, fill: 'F6F9FF' },
          indent: { left: 260, right: 260 },
        }));
      }
    } else if (node.type === 'html') {
      blocks.push(...await htmlToDocxBlocks(node.value, context, options));
    } else if (node.type === 'thematicBreak') {
      blocks.push(paragraph([textRun('────────────────────────', { color: 'DCDFF6' })], { alignment: AlignmentType.CENTER }));
    } else if (node.children) {
      blocks.push(...await markdownNodesToDocx(node.children, context, options));
    }
  }

  return blocks;
}

async function parseMarkdown(content) {
  const [{ unified }, remarkParse, remarkGfm] = await Promise.all([
    import('unified'),
    import('remark-parse'),
    import('remark-gfm'),
  ]);
  return unified().use(remarkParse.default).use(remarkGfm.default).parse(normalizeMarkdownTablesForDocx(content));
}

async function markdownToDocxBlocks(content, context = {}) {
  const tree = await parseMarkdown(content);
  return markdownNodesToDocx(tree.children || [], context);
}

async function addMarkdownContent(children, content, context) {
  children.push(...await markdownToDocxBlocks(content, context));
}

function buildOutlineHeadingParagraph(item, context, level, options = {}) {
  const style = getHeadingStyle(context.exportFormat, level);
  const nativeHeadingNumbering = usesNativeHeadingNumbering(style);
  const displayTitle = nativeHeadingNumbering
    ? String(item.title || '')
    : formatOutlineTitle(item.id, item.title, style);

  const runOptions = { bold: false };
  if (style) {
    runOptions.font = style.font || '黑体';
    runOptions.size = chineseSizeToHalfPt(style.size || '小四');
    if (style.font === '楷体') {
      runOptions.bold = false;
    }
  } else {
    runOptions.bold = true;
  }

  const paraOptions = {
    heading: headingLevel(level),
    alignment: style ? alignmentToWordType(style.alignment) : undefined,
    before: options.compact ? 0 : (style ? style.spacing_before_pt * 20 : (level === 1 ? 320 : 200)),
    after: options.compact ? 0 : (style ? style.spacing_after_pt * 20 : 120),
    line: style ? 240 * (style.line_spacing || 1) : undefined,
  };
  if (style && style.first_line_indent_chars > 0) {
    paraOptions.indent = { firstLine: style.first_line_indent_chars * 240 };
  }
  if (nativeHeadingNumbering) {
    context.usesHeadingNumbering = true;
    paraOptions.numbering = { reference: HEADING_NUMBERING_REFERENCE, level: Math.min(level - 1, 5) };
  }

  return paragraph([textRun(displayTitle, runOptions)], paraOptions);
}

async function addChapterFrameRows(rows, items, context, level = 1) {
  for (const item of items || []) {
    rows.push(buildChapterHeadingRow(
      context.exportFormat,
      buildOutlineHeadingParagraph(item, context, level, { compact: true }),
      level,
    ));

    if (!item.children?.length) {
      if (String(item.content || '').trim()) {
        const bodyChildren = [];
        await addMarkdownContent(bodyChildren, item.content, context);
        rows.push(buildChapterContentRow(context.exportFormat, bodyChildren));
      }
      context.convertedLeafCount = (context.convertedLeafCount || 0) + 1;
      reportConversionProgress(context, `已处理 ${context.convertedLeafCount}/${context.stats?.leafCount || context.convertedLeafCount} 个正文小节。`);
      continue;
    }

    await addChapterFrameRows(rows, item.children, context, level + 1);
  }
}

async function addOutlineItems(children, items, context, level = 1) {
  for (const item of items || []) {
    const useChapterFrame = level === 1 && getChapterFrameConfig(context.exportFormat);
    if (useChapterFrame) {
      const rows = [];
      await addChapterFrameRows(rows, [item], context, level);
      children.push(buildChapterFrameTable(context.exportFormat, rows));
      continue;
    }

    children.push(buildOutlineHeadingParagraph(item, context, level));

    if (!item.children?.length) {
      if (String(item.content || '').trim()) {
        await addMarkdownContent(children, item.content, context);
      }
      context.convertedLeafCount = (context.convertedLeafCount || 0) + 1;
      reportConversionProgress(context, `已处理 ${context.convertedLeafCount}/${context.stats?.leafCount || context.convertedLeafCount} 个正文小节。`);
      continue;
    }

    await addOutlineItems(children, item.children, context, level + 1);
  }
}

function createHeadingNumberingConfig() {
  return {
    reference: HEADING_NUMBERING_REFERENCE,
    levels: [0, 1, 2, 3, 4, 5].map((level) => ({
      level,
      format: LevelFormat.DECIMAL,
      start: 1,
      text: Array.from({ length: level + 1 }, (_, index) => `%${index + 1}`).join('.'),
      alignment: AlignmentType.START,
      suffix: LevelSuffix.TAB,
      style: {
        paragraph: {
          indent: { left: 360 + level * 360, hanging: 360 },
        },
      },
    })),
  };
}

function createNumberingConfig(context) {
  const references = context.numberingReferences || [];
  if (!references.length && !context.usesHeadingNumbering) {
    return undefined;
  }

  const config = [];
  if (context.usesHeadingNumbering) {
    config.push(createHeadingNumberingConfig());
  }
  config.push(...references.map((reference) => ({
    reference,
    levels: [0, 1, 2].map((level) => ({
      level,
      format: LevelFormat.DECIMAL,
      text: `%${level + 1}.`,
      alignment: AlignmentType.START,
      style: {
        paragraph: {
          indent: { left: 720 + level * 420, hanging: 260 },
        },
      },
    })),
  })));

  return {
    config,
  };
}

function buildHeadingParagraphStyles(exportFormat) {
  const styles = [];
  const names = ['Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6'];
  const ids = ['Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6'];

  for (let i = 0; i < 6; i += 1) {
    const style = getHeadingStyle(exportFormat, i + 1);
    if (!style) {
      styles.push({
        id: ids[i],
        name: names[i],
        basedOn: 'Normal',
        run: { bold: false },
        paragraph: { spacing: { before: 200, after: 120 } },
      });
      continue;
    }

    const halfPt = chineseSizeToHalfPt(style.size);
    const lineSpacing = 240 * (style.line_spacing || 1);
    const indentOpts = {};
    if (style.first_line_indent_chars > 0) {
      indentOpts.firstLine = style.first_line_indent_chars * 240;
    }

    styles.push({
      id: ids[i],
      name: names[i],
      basedOn: 'Normal',
      run: {
        font: style.font || 'SimHei',
        size: halfPt,
        bold: false,
      },
      paragraph: {
        spacing: {
          before: (style.spacing_before_pt || 10) * 20,
          after: (style.spacing_after_pt || 10) * 20,
          line: lineSpacing,
        },
        alignment: alignmentToWordType(style.alignment),
        ...(Object.keys(indentOpts).length ? { indent: indentOpts } : {}),
      },
    });
  }

  return styles;
}

async function buildDocxResult(payload, options = {}) {
  const exportFormat = (payload && payload.export_format) || null;
  const stats = countOutlineStats(payload.outline || []);
  const context = {
    baseDir: payload.base_dir || payload.baseDir,
    onProgress: options.onProgress,
    warnings: options.warnings || [],
    stats,
    convertedLeafCount: 0,
    convertedMermaidCount: 0,
    imageCount: 0,
    imageSuccessCount: 0,
    numberingReferences: [],
    numberingIndex: 0,
    usesHeadingNumbering: false,
    unsupportedHtmlTags: new Set(),
    developerLogger: options.developerLogger,
    exportFormat,
  };
  writeExportLog(context, 'export.docx.build.started', {
    stats,
    content_metrics: countOutlineContentMetrics(payload.outline || []),
  });

  // 正文默认样式
  const bodyStyle = (exportFormat && exportFormat.body_text) ? exportFormat.body_text : null;
  const bodyFont = bodyStyle ? (bodyStyle.font || '宋体') : '宋体';
  const bodySizeHalfPt = bodyStyle ? chineseSizeToHalfPt(bodyStyle.size || '小四') : 24;
  const bodyLineSpacing = bodyStyle ? 240 * (bodyStyle.line_spacing_multiple || 1.2) : 360;
  const bodyAfterSpacing = bodyStyle ? (bodyStyle.spacing_after_pt || 0) * 20 : 160;

  // 注入正文样式到 context，供正文段落/文本渲染时使用
  context.bodyRunFont = bodyFont;
  context.bodyRunSize = bodySizeHalfPt;
  context.bodyLineSpacing = bodyLineSpacing;
  context.bodyAfterSpacing = bodyAfterSpacing;
  if (bodyStyle) {
    context.bodyAlignment = alignmentToWordType(bodyStyle.alignment);
    if (bodyStyle.first_line_indent_chars > 0) {
      context.bodyIndent = { firstLine: bodyStyle.first_line_indent_chars * 240 };
    }
    if (bodyStyle.spacing_before_pt > 0) {
      context.bodyBeforeSpacing = bodyStyle.spacing_before_pt * 20;
    }
  }

  const children = [
    paragraph([textRun('内容由 AI 生成', { italics: true, size: 18 })], { alignment: AlignmentType.CENTER, after: 120 }),
    paragraph([textRun(payload.project_name || '投标技术文件', { bold: true, size: 34 })], { alignment: AlignmentType.CENTER, after: 300 }),
  ];

  reportProgress(context, 10, stats.mermaidCount
    ? `准备导出正文，并转换 ${stats.mermaidCount} 张 Mermaid 图。`
    : '准备导出正文。');
  await addOutlineItems(children, payload.outline || [], context);
  reportProgress(context, 90, '正在生成 Word 文件。');

  // 页面设置
  const pageSetup = (exportFormat && exportFormat.page) ? exportFormat.page : null;
  const pageMargin = pageSetup ? {
    top: cmToTwips(pageSetup.margin_top_cm ?? 2),
    bottom: cmToTwips(pageSetup.margin_bottom_cm ?? 2),
    left: cmToTwips(pageSetup.margin_left_cm ?? 2),
    right: cmToTwips(pageSetup.margin_right_cm ?? 2),
    footer: cmToTwips(pageSetup.footer_distance_cm ?? 1.75),
  } : { top: 1440, right: 1440, bottom: 1440, left: 1440, footer: cmToTwips(1.75) };
  const firstPageDifferent = pageSetup ? pageSetup.first_page_different === true : false;

  // 纸张尺寸与方向
  const pageSizeConfig = {};
  if (pageSetup && pageSetup.paper_size) {
    const dims = PAPER_DIMENSIONS_MM[pageSetup.paper_size];
    if (dims) {
      const isLandscape = pageSetup.orientation === 'landscape';
      pageSizeConfig.size = {
        width: mmToTwips(dims.width),
        height: mmToTwips(dims.height),
        orientation: isLandscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
      };
    }
  }

  // 页眉 / 页脚 / 页码
  const sectionChildren = [...children];
  const pageNumberEnabled = isPageNumberEnabled(pageSetup);
  const pageNumberStart = Math.max(1, Math.floor(Number(pageSetup ? pageSetup.page_number_start : 1) || 1));
  const headers = buildWordHeaders(pageSetup);
  const footers = buildWordFooters(pageSetup);

  const numbering = createNumberingConfig(context);
  const headingStyles = buildHeadingParagraphStyles(exportFormat);
  const sectionProperties = {
    page: {
      margin: pageMargin,
      ...pageSizeConfig,
      ...(pageNumberEnabled ? { pageNumbers: { start: pageNumberStart } } : {}),
    },
    ...(firstPageDifferent ? { titlePage: true } : {}),
  };
  const doc = new Document({
    ...(numbering ? { numbering } : {}),
    styles: {
      default: {
        document: {
          run: { font: bodyFont, size: bodySizeHalfPt },
          paragraph: { spacing: { line: bodyLineSpacing, after: bodyAfterSpacing } },
        },
      },
      paragraphStyles: headingStyles,
    },
    sections: [{
      properties: sectionProperties,
      headers,
      footers,
      children: sectionChildren,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  writeExportLog(context, 'export.docx.build.completed', {
    stats,
    warning_count: context.warnings.length,
    converted_leaf_count: context.convertedLeafCount,
    converted_mermaid_count: context.convertedMermaidCount,
    image_count: context.imageCount,
    image_success_count: context.imageSuccessCount,
    image_failure_count: Math.max(0, context.imageCount - context.imageSuccessCount),
    buffer_bytes: buffer.length,
  });
  return { buffer, warnings: context.warnings, stats };
}

async function buildDocxBuffer(payload, options = {}) {
  const result = await buildDocxResult(payload, options);
  return result.buffer;
}

function createExportService({ configStore } = {}) {
  return {
    async exportWord(payload = {}, onProgress) {
      const stats = countOutlineStats(Array.isArray(payload.outline) ? payload.outline : []);
      const developerLogger = createDeveloperLogger({
        app,
        config: loadDeveloperConfig(configStore),
        moduleName: 'export',
        name: 'word-export',
        meta: {
          project_name: sanitizeFilename(payload.project_name || '投标技术文件'),
          stats,
        },
      });
      developerLogger.write('export.word.started', {
        project_name: sanitizeFilename(payload.project_name || '投标技术文件'),
        stats,
        content_metrics: countOutlineContentMetrics(Array.isArray(payload.outline) ? payload.outline : []),
      });
      if (!Array.isArray(payload.outline) || !payload.outline.length) {
        const error = new Error('没有可导出的目录内容');
        developerLogger.write('export.word.error', { error: compactLogError(error) });
        throw error;
      }

      const progressContext = { onProgress, warnings: [], stats };
      reportProgress(progressContext, 2, stats.mermaidCount
        ? `检测到 ${stats.mermaidCount} 张 Mermaid 图，导出时会转换为 Word 图片。`
        : '正在准备 Word 导出。');
      const defaultFilename = `${sanitizeFilename(payload.project_name || '标书文档')}_${formatExportTimestamp()}.docx`;
      const defaultDir = app?.getPath ? app.getPath('downloads') : process.env.USERPROFILE || process.cwd();
      const result = await dialog.showSaveDialog({
        title: '导出 Word 文档',
        defaultPath: path.join(defaultDir, defaultFilename),
        filters: [{ name: 'Word 文档', extensions: ['docx'] }],
      });

      if (result.canceled || !result.filePath) {
        reportProgress(progressContext, 0, '已取消导出。', { phase: 'canceled' });
        developerLogger.write('export.word.canceled', { stats });
        return { success: false, canceled: true, message: '已取消导出' };
      }

      try {
        const warnings = [];
        const buildResult = await buildDocxResult(payload, { onProgress, warnings, developerLogger });
        reportProgress({ onProgress, warnings: buildResult.warnings, stats: buildResult.stats }, 96, '正在写入 Word 文件。');
        developerLogger.write('export.word.write.started', {
          output_file_name: path.basename(result.filePath),
          output_extension: path.extname(result.filePath).toLowerCase(),
          buffer_bytes: buildResult.buffer.length,
        });
        fs.writeFileSync(result.filePath, buildResult.buffer);
        const message = buildResult.warnings.length
          ? `Word 已导出，但有 ${buildResult.warnings.length} 处图片未能插入，请打开文档核对。`
          : 'Word 已导出，请打开文档核对图片、表格和版式。';
        reportProgress({ onProgress, warnings: buildResult.warnings, stats: buildResult.stats }, 100, message, { phase: 'success' });
        developerLogger.write('export.word.completed', {
          output_file_name: path.basename(result.filePath),
          output_extension: path.extname(result.filePath).toLowerCase(),
          buffer_bytes: buildResult.buffer.length,
          warning_count: buildResult.warnings.length,
          stats: buildResult.stats,
        });
        return { success: true, path: result.filePath, message, warnings: buildResult.warnings };
      } catch (error) {
        developerLogger.write('export.word.error', {
          output_file_name: path.basename(result.filePath),
          output_extension: path.extname(result.filePath).toLowerCase(),
          error: compactLogError(error),
        });
        throw error;
      }
    },
  };
}

module.exports = {
  buildDocxBuffer,
  buildDocxResult,
  createExportService,
};
