import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import chardet from 'chardet';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import mammoth from 'mammoth';
import { lookup as lookupMimeType } from 'mime-types';
import { PDFParse } from 'pdf-parse';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import TurndownService from 'turndown';
import turndownPluginGfm from 'turndown-plugin-gfm';

const MARKDOWN_SUFFIXES = new Set(['.md', '.markdown']);
const DOCX_SUFFIXES = new Set(['.docx']);
const PDF_SUFFIXES = new Set(['.pdf']);
const LEGACY_WORD_SUFFIXES = new Set(['.doc', '.wps']);
const PDF_HEADER = Buffer.from('%PDF-');
const ZIP_LOCAL_FILE_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_COMPOUND_HEADER = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const MARKDOWN_IMAGE_PATTERN = /!\[(?<alt>[^\]]*)\]\((?<target><[^>]+>|[^)\s]+)(?<title>\s+"[^"]*")?\)/gi;
const PDF_POINT_TOLERANCE = 2.5;
const PDF_GRID_MIN_LINE_LENGTH = 12;
const PDF_GRID_MIN_WIDTH = 40;
const PDF_GRID_MIN_HEIGHT = 12;
const PDF_TEXT_DUPLICATE_TOLERANCE = 1;
const PDF_TEXT_LINE_TOLERANCE = 3;

const { gfm } = turndownPluginGfm;
const PDF_OP_NAMES = Object.fromEntries(Object.entries(OPS).map(([name, value]) => [value, name]));

export class ConversionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConversionError';
    this.code = code;
    this.details = details;
  }
}

export async function convertPathToMarkdown(inputPath, options = {}) {
  const resolvedPath = path.resolve(inputPath);
  const includeImages = Boolean(options.includeImages);
  const imageResolver = typeof options.imageResolver === 'function' ? options.imageResolver : null;
  const format = await detectFileFormat(resolvedPath);

  if (format === 'markdown') {
    return convertMarkdownFile(resolvedPath, includeImages, imageResolver);
  }
  if (format === 'docx') {
    return convertDocxFile(resolvedPath, includeImages, imageResolver);
  }
  if (format === 'pdf') {
    return convertPdfFile(resolvedPath, includeImages, imageResolver);
  }
  if (format === 'legacy_word') {
    return convertLegacyWordFile(resolvedPath, includeImages, imageResolver);
  }

  throw new ConversionError('unsupported_format', '不支持的文件格式', {
    inputPath: resolvedPath,
    format,
  });
}

export async function detectFileFormat(inputPath) {
  const suffix = path.extname(inputPath).toLowerCase();
  const header = await readFileHeader(inputPath, 8);

  if (isPdfHeader(header)) {
    return 'pdf';
  }
  if (isZipHeader(header)) {
    return 'docx';
  }
  if (isOleCompoundHeader(header)) {
    return 'legacy_word';
  }
  if (MARKDOWN_SUFFIXES.has(suffix)) {
    return 'markdown';
  }
  if (PDF_SUFFIXES.has(suffix)) {
    return 'pdf';
  }
  if (DOCX_SUFFIXES.has(suffix)) {
    return 'docx';
  }
  if (LEGACY_WORD_SUFFIXES.has(suffix)) {
    return 'legacy_word';
  }
  return 'unknown';
}

function isPdfHeader(header) {
  return header.subarray(0, PDF_HEADER.length).equals(PDF_HEADER);
}

function isZipHeader(header) {
  return header.subarray(0, ZIP_LOCAL_FILE_HEADER.length).equals(ZIP_LOCAL_FILE_HEADER);
}

function isOleCompoundHeader(header) {
  return header.subarray(0, OLE_COMPOUND_HEADER.length).equals(OLE_COMPOUND_HEADER);
}

async function readFileHeader(inputPath, bytes) {
  const buffer = await readFile(inputPath);
  return buffer.subarray(0, bytes);
}

async function convertMarkdownFile(inputPath, includeImages, imageResolver) {
  const raw = await readFile(inputPath);
  const detected = chardet.detect(raw) || 'UTF-8';
  let text = iconv.decode(raw, normalizeEncoding(detected));
  text = text.replace(/^\uFEFF/, '');
  text = normalizeNewlinesOnly(text);

  if (includeImages) {
    text = await inlineLocalMarkdownImages(text, path.dirname(inputPath), imageResolver);
  } else {
    text = stripMarkdownImages(text);
  }
  return ensureTrailingNewline(text.trimEnd());
}

function normalizeEncoding(value) {
  const normalized = String(value).toLowerCase();
  if (normalized === 'utf-8' || normalized === 'utf8') {
    return 'utf8';
  }
  if (normalized === 'gb18030' || normalized === 'gbk' || normalized === 'gb2312') {
    return 'gb18030';
  }
  return value;
}

async function convertDocxFile(inputPath, includeImages, imageResolver) {
  const result = await mammoth.convertToHtml(
    { path: inputPath },
    { convertImage: buildMammothImageConverter(includeImages, imageResolver) }
  );
  const html = cleanHtml(result.value, includeImages);
  const { html: htmlWithoutTables, placeholders } = preserveTables(html);
  let markdown = htmlToMarkdown(htmlWithoutTables);
  markdown = restoreTables(markdown, placeholders);
  return normalizeGeneratedMarkdown(includeImages ? markdown : stripMarkdownImages(markdown));
}

function buildMammothImageConverter(includeImages, imageResolver) {
  return mammoth.images.imgElement(async (image) => {
    if (!includeImages) {
      return { src: '' };
    }

    if (imageResolver) {
      const buffer = await image.readAsBuffer();
      const src = await imageResolver({ buffer, mime: image.contentType, sourceName: 'docx-image' });
      return { src: src || '' };
    }

    const base64 = await image.readAsBase64String();
    return { src: `data:${image.contentType};base64,${base64}` };
  });
}

function cleanHtml(html, includeImages) {
  const $ = cheerio.load(html, { decodeEntities: false });

  $('a').each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr('href') || '';
    if (!anchor.text().trim() && anchor.find('img').length === 0) {
      anchor.remove();
      return;
    }
    if (href.startsWith('#')) {
      anchor.replaceWith(anchor.contents());
    }
  });

  $('img').each((_, element) => {
    const image = $(element);
    if (!image.attr('src')) {
      image.remove();
    }
  });

  if (!includeImages) {
    $('img').remove();
  }

  return $.root().html() || '';
}

function htmlToMarkdown(html) {
  const turndownService = new TurndownService({
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    headingStyle: 'atx',
  });
  turndownService.use(gfm);
  return turndownService.turndown(html);
}

function preserveTables(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const placeholders = new Map();
  $('table').each((index, element) => {
    const placeholder = `TABLEPLACEHOLDER${String(index + 1).padStart(4, '0')}`;
    placeholders.set(placeholder, $.html(element));
    $(element).replaceWith(placeholder);
  });
  return { html: $.root().html() || '', placeholders };
}

function restoreTables(markdown, placeholders) {
  let restored = markdown;
  for (const [placeholder, tableHtml] of placeholders.entries()) {
    restored = restored.replaceAll(placeholder, `\n\n${tableHtml}\n\n`);
  }
  return restored;
}

async function convertPdfFile(inputPath, includeImages, imageResolver) {
  const buffer = await readFile(inputPath);
  const parser = new PDFParse({ data: buffer });

  try {
    const textResult = await parser.getText({ parseHyperlinks: true });
    const tableResult = await safePdfCall(() => parser.getTable());
    const pdfJsTableResult = await safePdfCall(() => extractPdfJsTables(buffer));
    const imageResult = includeImages ? await safePdfCall(() => parser.getImage()) : null;
    const markdown = await renderPdfMarkdown(textResult, tableResult, pdfJsTableResult, imageResult, includeImages, imageResolver);

    if (!hasInformativeText(markdown)) {
      throw new ConversionError('pdf_text_layer_missing', 'PDF 未检测到可选中文字层', {
        inputPath,
      });
    }

    return normalizeGeneratedMarkdown(markdown);
  } finally {
    await parser.destroy();
  }
}

async function safePdfCall(callback) {
  try {
    return await callback();
  } catch {
    return null;
  }
}

async function extractPdfJsTables(buffer) {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
  });
  const document = await loadingTask.promise;

  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const [textContent, operatorList] = await Promise.all([
        page.getTextContent(),
        page.getOperatorList(),
      ]);
      const textItems = normalizePdfJsTextItems(textContent.items || []);
      const rectangles = extractPdfJsRectangles(operatorList);
      pages.push({ tables: buildPdfJsTables(rectangles, textItems) });
    }
    return { pages };
  } finally {
    await document.destroy();
  }
}

function normalizePdfJsTextItems(items) {
  const normalized = items
    .map((item) => {
      const text = collapsePdfWhitespace(item.str || '');
      if (!text) {
        return null;
      }
      const transform = Array.isArray(item.transform) ? item.transform : [];
      const x = Number(transform[4] || 0);
      const y = Number(transform[5] || 0);
      const width = Number(item.width || 0);
      const height = Number(item.height || Math.abs(transform[3] || 0));
      return {
        text,
        x,
        y,
        width,
        height,
        centerX: x + width / 2,
        centerY: y + height / 2,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.y - left.y || left.x - right.x);

  const kept = [];
  for (const item of normalized) {
    const duplicate = kept.some((previous) => previous.text === item.text
      && Math.abs(previous.x - item.x) <= PDF_TEXT_DUPLICATE_TOLERANCE
      && Math.abs(previous.y - item.y) <= PDF_TEXT_DUPLICATE_TOLERANCE);
    if (!duplicate) {
      kept.push(item);
    }
  }
  return kept;
}

function extractPdfJsRectangles(operatorList) {
  const rectangles = [];
  const stack = [];
  let matrix = [1, 0, 0, 1, 0, 0];

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const name = PDF_OP_NAMES[operatorList.fnArray[index]];
    const args = operatorList.argsArray[index];

    if (name === 'save') {
      stack.push(matrix.slice());
    } else if (name === 'restore') {
      matrix = stack.pop() || [1, 0, 0, 1, 0, 0];
    } else if (name === 'transform') {
      matrix = multiplyPdfMatrix(matrix, args || [1, 0, 0, 1, 0, 0]);
    } else if (name === 'constructPath') {
      rectangles.push(...extractPdfJsPathRectangles(args?.[1] || [], matrix));
    }
  }

  return rectangles;
}

function multiplyPdfMatrix(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function transformPdfPoint(matrix, x, y) {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  };
}

function extractPdfJsPathRectangles(paths, matrix) {
  const rectangles = [];
  for (const pathChunk of paths) {
    const points = [];
    for (let index = 0; index < pathChunk.length;) {
      const op = pathChunk[index];
      index += 1;
      if (op === 0 || op === 1) {
        points.push(transformPdfPoint(matrix, pathChunk[index], pathChunk[index + 1]));
        index += 2;
      } else if (op === 3) {
        // closePath has no coordinates.
      } else {
        break;
      }
    }

    if (points.length < 2) {
      continue;
    }
    const xValues = points.map((point) => point.x);
    const yValues = points.map((point) => point.y);
    const x1 = Math.min(...xValues);
    const x2 = Math.max(...xValues);
    const y1 = Math.min(...yValues);
    const y2 = Math.max(...yValues);
    rectangles.push({
      x1,
      x2,
      y1,
      y2,
      width: x2 - x1,
      height: y2 - y1,
    });
  }
  return rectangles;
}

function buildPdfJsTables(rectangles, textItems) {
  const horizontalLines = [];
  const verticalLines = [];

  for (const rectangle of rectangles) {
    if (rectangle.width >= PDF_GRID_MIN_LINE_LENGTH && rectangle.height <= PDF_POINT_TOLERANCE) {
      horizontalLines.push({
        x1: rectangle.x1,
        x2: rectangle.x2,
        y: (rectangle.y1 + rectangle.y2) / 2,
      });
    }
    if (rectangle.height >= PDF_GRID_MIN_LINE_LENGTH && rectangle.width <= PDF_POINT_TOLERANCE) {
      verticalLines.push({
        x: (rectangle.x1 + rectangle.x2) / 2,
        y1: rectangle.y1,
        y2: rectangle.y2,
      });
    }
  }

  return buildPdfJsLineComponents(horizontalLines, verticalLines)
    .map((component) => buildPdfJsTableFromComponent(component, textItems))
    .filter(Boolean)
    .sort((left, right) => right.bounds.y2 - left.bounds.y2 || left.bounds.x1 - right.bounds.x1)
    .map((table) => table.rows);
}

function buildPdfJsLineComponents(horizontalLines, verticalLines) {
  const lines = [
    ...horizontalLines.map((line) => ({ kind: 'h', line })),
    ...verticalLines.map((line) => ({ kind: 'v', line })),
  ];
  const parent = lines.map((_, index) => index);

  for (let hIndex = 0; hIndex < horizontalLines.length; hIndex += 1) {
    for (let vIndex = 0; vIndex < verticalLines.length; vIndex += 1) {
      if (pdfJsLinesIntersect(horizontalLines[hIndex], verticalLines[vIndex])) {
        union(parent, hIndex, horizontalLines.length + vIndex);
      }
    }
  }

  const groups = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const root = find(parent, index);
    if (!groups.has(root)) {
      groups.set(root, { horizontalLines: [], verticalLines: [] });
    }
    const group = groups.get(root);
    if (lines[index].kind === 'h') {
      group.horizontalLines.push(lines[index].line);
    } else {
      group.verticalLines.push(lines[index].line);
    }
  }

  return [...groups.values()];
}

function pdfJsLinesIntersect(horizontalLine, verticalLine) {
  return verticalLine.x >= horizontalLine.x1 - PDF_POINT_TOLERANCE
    && verticalLine.x <= horizontalLine.x2 + PDF_POINT_TOLERANCE
    && horizontalLine.y >= verticalLine.y1 - PDF_POINT_TOLERANCE
    && horizontalLine.y <= verticalLine.y2 + PDF_POINT_TOLERANCE;
}

function find(parent, index) {
  if (parent[index] !== index) {
    parent[index] = find(parent, parent[index]);
  }
  return parent[index];
}

function union(parent, left, right) {
  const leftRoot = find(parent, left);
  const rightRoot = find(parent, right);
  if (leftRoot !== rightRoot) {
    parent[rightRoot] = leftRoot;
  }
}

function buildPdfJsTableFromComponent(component, textItems) {
  const xCoordinates = clusterPdfCoordinates(component.verticalLines.map((line) => line.x)).sort((left, right) => left - right);
  const yCoordinates = clusterPdfCoordinates(component.horizontalLines.map((line) => line.y)).sort((left, right) => right - left);
  if (xCoordinates.length < 2 || yCoordinates.length < 2) {
    return null;
  }

  const bounds = {
    x1: xCoordinates[0],
    x2: xCoordinates[xCoordinates.length - 1],
    y1: yCoordinates[yCoordinates.length - 1],
    y2: yCoordinates[0],
  };
  if (bounds.x2 - bounds.x1 < PDF_GRID_MIN_WIDTH || bounds.y2 - bounds.y1 < PDF_GRID_MIN_HEIGHT) {
    return null;
  }

  const rows = [];
  for (let rowIndex = 0; rowIndex < yCoordinates.length - 1; rowIndex += 1) {
    const top = yCoordinates[rowIndex];
    const bottom = yCoordinates[rowIndex + 1];
    const row = [];
    for (let columnIndex = 0; columnIndex < xCoordinates.length - 1; columnIndex += 1) {
      const left = xCoordinates[columnIndex];
      const right = xCoordinates[columnIndex + 1];
      const cellItems = textItems.filter((item) => item.centerX >= left - PDF_POINT_TOLERANCE
        && item.centerX <= right + PDF_POINT_TOLERANCE
        && item.centerY <= top + PDF_POINT_TOLERANCE
        && item.centerY >= bottom - PDF_POINT_TOLERANCE);
      row.push(renderPdfJsCellText(cellItems));
    }
    rows.push(row);
  }

  const nonEmptyCells = rows.flat().filter(Boolean).length;
  if (nonEmptyCells < 2) {
    return null;
  }
  return { bounds, rows };
}

function clusterPdfCoordinates(values) {
  const sortedValues = [...values].sort((left, right) => left - right);
  const clusters = [];
  for (const value of sortedValues) {
    const previous = clusters[clusters.length - 1];
    if (previous && Math.abs(previous.values[previous.values.length - 1] - value) <= PDF_POINT_TOLERANCE) {
      previous.values.push(value);
    } else {
      clusters.push({ values: [value] });
    }
  }
  return clusters.map((cluster) => cluster.values.reduce((sum, value) => sum + value, 0) / cluster.values.length);
}

function renderPdfJsCellText(items) {
  if (items.length === 0) {
    return '';
  }

  const lines = [];
  for (const item of [...items].sort((left, right) => right.y - left.y || left.x - right.x)) {
    let line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= PDF_TEXT_LINE_TOLERANCE);
    if (!line) {
      line = { y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }

  return lines
    .sort((left, right) => right.y - left.y)
    .map((line) => collapsePdfWhitespace(line.items
      .sort((left, right) => left.x - right.x)
      .map((item) => item.text)
      .join('')))
    .filter(Boolean)
    .map((line) => line.replace(/\|/g, '\\|'))
    .join('<br>');
}

async function renderPdfMarkdown(textResult, tableResult, pdfJsTableResult, imageResult, includeImages, imageResolver) {
  const textPages = Array.isArray(textResult?.pages) ? textResult.pages : [];
  const tablePages = Array.isArray(tableResult?.pages) ? tableResult.pages : [];
  const pdfJsTablePages = Array.isArray(pdfJsTableResult?.pages) ? pdfJsTableResult.pages : [];
  const imagePages = Array.isArray(imageResult?.pages) ? imageResult.pages : [];
  const pageCount = Math.max(textPages.length, tablePages.length, pdfJsTablePages.length, imagePages.length, 1);
  const parts = [];

  for (let index = 0; index < pageCount; index += 1) {
    const pageParts = [];
    const pageText = normalizePdfPlainText(textPages[index]?.text || '');
    const tables = [
      ...(tablePages[index]?.tables || []),
      ...(pdfJsTablePages[index]?.tables || []),
    ];
    const tableMarkdownList = [];
    for (const table of tables) {
      const tableMarkdown = renderMarkdownTable(table);
      if (tableMarkdown && !hasSimilarPdfTable(tableMarkdownList, tableMarkdown)) {
        tableMarkdownList.push(tableMarkdown);
      }
    }

    const dedupedText = removePdfTableDuplicateText(pageText, tableMarkdownList);
    if (dedupedText) {
      pageParts.push(dedupedText);
    }
    pageParts.push(...tableMarkdownList);

    if (includeImages) {
      const images = imagePages[index]?.images || [];
      for (let imageIndex = 0; imageIndex < images.length; imageIndex += 1) {
        const dataUrl = images[imageIndex]?.dataUrl;
        if (dataUrl) {
          const assetUrl = imageResolver ? await resolveDataUrlImage(dataUrl, imageResolver, `pdf-page-${index + 1}-image-${imageIndex + 1}`) : null;
          pageParts.push(`![Page ${index + 1} Image ${imageIndex + 1}](${assetUrl || dataUrl})`);
        }
      }
    }

    if (pageParts.length > 0) {
      parts.push(pageParts.join('\n\n'));
    }
  }

  if (parts.length === 0 && textResult?.text) {
    return normalizePdfPlainText(textResult.text);
  }
  return parts.join('\n\n');
}

function removePdfTableDuplicateText(pageText, tableMarkdownList) {
  if (!pageText || tableMarkdownList.length === 0) {
    return pageText;
  }

  const tableProbe = compactForDedup(tableMarkdownList.join('\n'));
  const keptLines = [];
  for (const line of pageText.split('\n')) {
    const trimmed = collapsePdfWhitespace(line);
    if (!trimmed) {
      continue;
    }
    const probe = compactForDedup(trimmed);
    if (!probe) {
      continue;
    }
    const collapsedProbe = collapseRepeatedPdfProbe(probe);
    if (isPdfLineCoveredByTables(probe, tableProbe)
      || (collapsedProbe !== probe && isPdfLineCoveredByTables(collapsedProbe, tableProbe))) {
      continue;
    }
    keptLines.push(trimmed);
  }

  return keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function hasSimilarPdfTable(existingTables, nextTable) {
  const nextProbe = compactForDedup(nextTable);
  if (!nextProbe) {
    return true;
  }
  return existingTables.some((table) => {
    const probe = compactForDedup(table);
    if (!probe) {
      return false;
    }
    return probe.includes(nextProbe) || nextProbe.includes(probe);
  });
}

function isPdfLineCoveredByTables(lineProbe, tableProbe) {
  if (lineProbe.length <= 2) {
    return tableProbe.includes(lineProbe);
  }
  if (tableProbe.includes(lineProbe)) {
    return true;
  }
  if (lineProbe.length < 8) {
    return false;
  }

  const chunkSize = Math.min(12, Math.max(6, Math.floor(lineProbe.length / 2)));
  let covered = 0;
  let total = 0;
  for (let index = 0; index < lineProbe.length; index += chunkSize) {
    const chunk = lineProbe.slice(index, index + chunkSize);
    if (chunk.length < 4) {
      continue;
    }
    total += 1;
    if (tableProbe.includes(chunk)) {
      covered += 1;
    }
  }
  return total > 0 && covered / total >= 0.75;
}

function compactForDedup(text) {
  return String(text || '')
    .replace(/<br\s*\/?\s*>/gi, '')
    .replace(/[|\\`*_#\-\s，。；：！？、,.!:;?%（）()\[\]{}《》<>]/g, '')
    .toLowerCase();
}

function renderMarkdownTable(table) {
  const rows = normalizePdfTableRows(table);
  if (rows.length === 0) {
    return '';
  }

  const width = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => row.concat(Array(Math.max(0, width - row.length)).fill('')));
  const header = normalizedRows[0];
  const body = normalizedRows.slice(1);
  const lines = [renderMarkdownTableRow(header), renderMarkdownTableRow(Array(width).fill('---'))];
  for (const row of body) {
    lines.push(renderMarkdownTableRow(row));
  }
  return lines.join('\n');
}

function normalizePdfTableRows(table) {
  if (!Array.isArray(table)) {
    return [];
  }
  return table
    .map((row) => (Array.isArray(row) ? row : []))
    .map((row) => row.map((cell) => normalizeTableCell(cell)))
    .filter((row) => row.some((cell) => cell));
}

function normalizeTableCell(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return collapsePdfWhitespace(String(value).replace(/\n+/g, '<br>')).replace(/\|/g, '\\|');
}

function renderMarkdownTableRow(row) {
  return `|${row.join('|')}|`;
}

export async function withLegacyWordDocxFile(inputPath, callback) {
  const soffice = await findLibreOfficeCommand();
  if (!soffice) {
    throw new ConversionError('office_backend_missing', '未找到 LibreOffice，无法转换 DOC/WPS 文件', {
      inputPath,
    });
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'doc2md-node-'));
  try {
    const legacyInput = path.join(tempDir, `${safeStem(inputPath)}${await getLegacyConversionSuffix(inputPath)}`);
    await copyFile(inputPath, legacyInput);
    await runLibreOfficeConvert(soffice, legacyInput, tempDir);
    const files = await readdir(tempDir);
    const docxName = files.find((file) => path.extname(file).toLowerCase() === '.docx');
    if (!docxName) {
      throw new ConversionError('office_conversion_failed', 'LibreOffice 未生成 DOCX 文件', {
        inputPath,
      });
    }
    return await callback(path.join(tempDir, docxName), tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function convertLegacyWordFile(inputPath, includeImages, imageResolver) {
  return withLegacyWordDocxFile(inputPath, (docxPath) => convertDocxFile(docxPath, includeImages, imageResolver));
}

async function getLegacyConversionSuffix(inputPath) {
  const suffix = path.extname(inputPath).toLowerCase();
  const header = await readFileHeader(inputPath, 8);
  if (DOCX_SUFFIXES.has(suffix) && isOleCompoundHeader(header)) {
    return '.doc';
  }
  return suffix || '.doc';
}

async function findLibreOfficeCommand() {
  const candidates = [
    process.env.LIBREOFFICE_PATH,
    'soffice',
    'libreoffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (existsSync(candidate)) {
        return candidate;
      }
      continue;
    }
    if (await canRunCommand(candidate, ['--version'])) {
      return candidate;
    }
  }
  return null;
}

async function canRunCommand(command, args) {
  try {
    await runProcess(command, args, { timeoutMs: 10000 });
    return true;
  } catch {
    return false;
  }
}

async function runLibreOfficeConvert(soffice, inputPath, outputDir) {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'doc2md-lo-profile-'));
  try {
    const profileUri = pathToFileUri(profileDir);
    const args = [
      '--headless',
      '--nologo',
      '--nolockcheck',
      '--nodefault',
      '--nofirststartwizard',
      `-env:UserInstallation=${profileUri}`,
      '--convert-to',
      'docx',
      '--outdir',
      outputDir,
      inputPath,
    ];
    await runProcess(soffice, args, { timeoutMs: 180000 });
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(`命令执行超时: ${command}`));
        }, options.timeoutMs)
      : null;

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`命令执行失败(${code}): ${command}\n${stderr || stdout}`));
      }
    });
  });
}

function normalizePdfPlainText(text) {
  const lines = normalizeNewlinesOnly(String(text || '').replace(/\f/g, '\n\n'))
    .split('\n')
    .map((line) => collapseRepeatedPdfText(collapsePdfWhitespace(line)));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function collapseRepeatedPdfText(text) {
  return collapseRepeatedPdfChunks(text, 2, true)
    .replace(/([\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9（）()：:、，,。.．\-]{1,29})\s+\1/g, '$1')
    .replace(/^([一二三四五六七八九十])\1(?=[.、．])/u, '$1');
}

function collapseRepeatedPdfProbe(text) {
  return collapseRepeatedPdfChunks(text, 1, false);
}

function collapseRepeatedPdfChunks(text, minLength, requireCjk) {
  let result = text;
  let changed = true;
  let rounds = 0;
  while (changed && rounds < 4) {
    changed = false;
    rounds += 1;
    const maxLength = Math.min(30, Math.floor(result.length / 2));
    for (let length = minLength; length <= maxLength; length += 1) {
      for (let index = 0; index + length * 2 <= result.length; index += 1) {
        const chunk = result.slice(index, index + length);
        if (!chunk.trim() || (requireCjk && !/[\u4e00-\u9fff]/.test(chunk))) {
          continue;
        }
        if (chunk === result.slice(index + length, index + length * 2)) {
          result = `${result.slice(0, index + length)}${result.slice(index + length * 2)}`;
          changed = true;
          break;
        }
      }
      if (changed) {
        break;
      }
    }
  }
  return result;
}

function collapsePdfWhitespace(text) {
  return String(text || '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '')
    .replace(/\s+([,.;:!?%])/g, '$1')
    .replace(/\s+([，。；：！？、％])/g, '$1');
}

function hasInformativeText(markdown) {
  const probe = stripMarkdownImages(markdown);
  return /[A-Za-z0-9\u4e00-\u9fff]{10,}/.test(probe.replace(/\s+/g, ''));
}

function normalizeGeneratedMarkdown(markdown) {
  const normalized = normalizeNewlinesOnly(markdown).replace(/\n{3,}/g, '\n\n').trim();
  return ensureTrailingNewline(normalized);
}

function normalizeNewlinesOnly(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function ensureTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function stripMarkdownImages(text) {
  return String(text || '')
    .replace(MARKDOWN_IMAGE_PATTERN, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}

async function inlineLocalMarkdownImages(text, baseDir, imageResolver) {
  const replacements = [];
  for (const match of text.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    replacements.push(replaceMarkdownImage(match, baseDir, imageResolver));
  }

  let result = text;
  for (const replacement of await Promise.all(replacements)) {
    if (replacement) {
      result = result.replace(replacement.original, replacement.next);
    }
  }
  return result;
}

async function replaceMarkdownImage(match, baseDir, imageResolver) {
  const target = match.groups?.target || '';
  const cleanTarget = target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
  if (isRemoteOrDataUrl(cleanTarget)) {
    return null;
  }

  const localPath = resolveLocalPath(baseDir, cleanTarget);
  if (!localPath) {
    return null;
  }

  const dataUri = imageResolver
    ? await pathToAssetUri(localPath, imageResolver)
    : await pathToDataUri(localPath);
  if (!dataUri) {
    return null;
  }
  const alt = match.groups?.alt || '';
  const title = match.groups?.title || '';
  return { original: match[0], next: `![${alt}](${dataUri}${title})` };
}

function isRemoteOrDataUrl(value) {
  return /^(https?:|data:)/i.test(value);
}

function resolveLocalPath(baseDir, target) {
  let decodedTarget = target;
  try {
    decodedTarget = decodeURIComponent(target);
  } catch {
    decodedTarget = target;
  }
  if (path.isAbsolute(decodedTarget)) {
    return null;
  }
  const resolvedBaseDir = path.resolve(baseDir);
  const candidate = path.resolve(resolvedBaseDir, decodedTarget);
  const relative = path.relative(resolvedBaseDir, candidate);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
    return null;
  }
  return existsSync(candidate) ? candidate : null;
}

async function pathToAssetUri(inputPath, imageResolver) {
  const mimeType = lookupMimeType(inputPath) || 'application/octet-stream';
  const buffer = await readFile(inputPath);
  return imageResolver({ buffer, mime: mimeType, sourceName: inputPath });
}

async function pathToDataUri(inputPath) {
  const mimeType = lookupMimeType(inputPath) || 'application/octet-stream';
  const data = await readFile(inputPath);
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

async function resolveDataUrlImage(dataUrl, imageResolver, sourceName) {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!match) return null;
  return imageResolver({ buffer: Buffer.from(match[2], 'base64'), mime: match[1], sourceName });
}

function safeStem(inputPath) {
  const stem = path.basename(inputPath, path.extname(inputPath));
  return stem.replace(/[^A-Za-z0-9._-]+/g, '_') || 'upload';
}

function pathToFileUri(value) {
  return pathToFileURL(path.resolve(value)).href;
}
