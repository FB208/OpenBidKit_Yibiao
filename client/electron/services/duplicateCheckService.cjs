const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const AdmZip = require('adm-zip');
const CFB = require('cfb');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { PDFParse } = require('pdf-parse');
const { getDuplicateCheckDir, getGeneratedImagesDir, getImportedImagesDir } = require('../utils/paths.cjs');
const { parseDocumentWithConfig } = require('./fileService.cjs');

const metadataLabels = {
  file_name: '文件名',
  extension: '扩展名',
  size: '文件大小',
  created_at: '文件创建时间',
  modified_at: '文件修改时间',
  accessed_at: '文件访问时间',
  title: '标题',
  subject: '主题',
  author: '作者',
  last_modified_by: '最后修改人',
  revision: '修订号',
  created: '创建时间',
  modified: '修改时间',
  last_printed: '最后打印时间',
  keywords: '关键词',
  category: '类别',
  description: '描述',
  content_status: '内容状态',
  content_type: '内容类型',
  identifier: '标识符',
  language: '语言',
  application: '应用程序',
  app_version: '应用程序版本',
  company: '公司',
  manager: '管理者',
  template: '模板',
  presentation_format: '演示格式',
  pages: '页数',
  words: '字数',
  characters: '字符数',
  characters_with_spaces: '含空格字符数',
  bytes: '字节数',
  lines: '行数',
  paragraphs: '段落数',
  slides: '幻灯片数',
  notes: '备注数',
  hidden_slides: '隐藏幻灯片数',
  multimedia_clips: '多媒体剪辑数',
  total_time: '编辑时长',
  code_page: '代码页',
  document_version: '文档版本',
  doc_security: '文档安全状态',
  shared_doc: '共享文档',
  links_dirty: '链接已变更',
  hlinks_changed: '超链接已变更',
  creator: '创建工具',
  producer: '生成工具',
  pdf_version: 'PDF 版本',
  pdf_permissions: 'PDF 权限',
  fingerprints: 'PDF 指纹',
};

const comparableKeys = new Set([
  'title', 'subject', 'author', 'last_modified_by', 'revision', 'created', 'modified', 'last_printed', 'keywords',
  'category', 'description', 'content_status', 'content_type', 'identifier', 'language', 'application', 'app_version',
  'company', 'manager', 'template', 'presentation_format', 'pages', 'words', 'characters', 'characters_with_spaces',
  'bytes', 'lines', 'paragraphs', 'slides', 'notes', 'hidden_slides', 'multimedia_clips', 'total_time', 'creator',
  'producer', 'pdf_version', 'pdf_permissions', 'fingerprints', 'document_version', 'doc_security', 'shared_doc',
  'links_dirty', 'hlinks_changed',
]);

const dateComparableKeys = new Set(['created_at', 'modified_at', 'accessed_at', 'created', 'modified', 'last_printed']);
const markdownImagePattern = /!\[(?<alt>[^\]]*)\]\((?<target><[^>]+>|[^)\s]+)(?<title>\s+"[^"]*")?\)/gi;
const htmlImageSrcPattern = /<img\b[^>]*?\bsrc=["'](?<src>[^"']+)["'][^>]*>/gi;
const htmlImagePattern = /<img\b[^>]*>/gi;
const htmlTablePattern = /<table\b[\s\S]*?<\/table>/gi;
const contentTableTokenPrefix = 'YIBIAO_CONTENT_TABLE_';

function now() {
  return new Date().toISOString();
}

function stableFileId(file) {
  return file?.id || crypto.createHash('sha1').update(String(file?.file_path || file?.file_name || '')).digest('hex');
}

function createSignature(payload = {}) {
  const files = [payload.tenderFile, ...(Array.isArray(payload.bidFiles) ? payload.bidFiles : [])]
    .filter(Boolean)
    .map((file) => `${file.file_path}|${file.size}|${file.modified_at}`);
  return crypto.createHash('sha1').update(files.join('\n')).digest('hex');
}

function normalizeValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue).filter(Boolean).join('；');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeComparable(value) {
  const text = normalizeValue(value).toLowerCase();
  if (!text || ['没有提及', '原文未提及', '-', '无', 'null', 'undefined'].includes(text)) return '';
  const date = new Date(text.replace(/^d:/i, '').replace(/([+-]\d{2})'(\d{2})'$/, '$1:$2'));
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return text.replace(/[\s　\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]+/g, '');
}

function normalizeDateDay(value) {
  const text = normalizeValue(value);
  if (!text) return '';
  const date = new Date(text.replace(/^d:/i, '').replace(/([+-]\d{2})'(\d{2})'$/, '$1:$2'));
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  const match = text.match(/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/);
  return match ? match[0].replace(/[年月/.]/g, '-').replace(/日/g, '') : '';
}

function addField(fields, key, value) {
  const text = normalizeValue(value);
  if (!text) return;
  fields.set(key, text);
}

function addFieldIfAbsent(fields, key, value) {
  if (fields.has(key)) return;
  addField(fields, key, value);
}

function addListField(fields, key, value) {
  const text = normalizeValue(value);
  if (!text) return;
  const current = fields.get(key);
  if (!current) {
    fields.set(key, text);
    return;
  }
  const parts = current.split('；').map((item) => item.trim()).filter(Boolean);
  if (!parts.includes(text)) fields.set(key, `${current}；${text}`);
}

function safeMetadataKey(value) {
  return normalizeValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'field';
}

function formatMetadataKey(key) {
  return String(key || '').replace(/[_:]+/g, ' ').trim() || String(key || '');
}

function getMetadataLabel(key) {
  if (metadataLabels[key]) return metadataLabels[key];
  if (key.startsWith('converted_docx:')) return `转换 DOCX：${getMetadataLabel(key.slice('converted_docx:'.length))}`;
  if (key.startsWith('custom:') && key.endsWith(':base64_decoded')) return `自定义：${key.slice('custom:'.length, -':base64_decoded'.length)}（Base64 解码）`;
  if (key.startsWith('custom:')) return `自定义：${key.slice('custom:'.length)}`;
  if (key.endsWith(':base64_decoded')) return `${getMetadataLabel(key.slice(0, -':base64_decoded'.length))}（Base64 解码）`;
  if (key.startsWith('pdf_info:')) return `PDF Info：${formatMetadataKey(key.slice('pdf_info:'.length))}`;
  if (key.startsWith('pdf_xmp:')) return `PDF XMP：${formatMetadataKey(key.slice('pdf_xmp:'.length))}`;
  if (key.startsWith('pdf_raw:')) return `PDF 原始记录：${formatMetadataKey(key.slice('pdf_raw:'.length))}`;
  if (key.startsWith('ole_signal:')) return `OLE 疑似痕迹：${formatMetadataKey(key.slice('ole_signal:'.length))}`;
  if (key.startsWith('wps:')) return `疑似 WPS 用户/账号：${formatMetadataKey(key.slice('wps:'.length))}`;
  return formatMetadataKey(key);
}

function isDateComparableKey(key) {
  if (dateComparableKeys.has(key)) return true;
  const normalized = String(key || '').toLowerCase();
  if (/last[_-]?modified[_-]?by|lastmodifiedby/.test(normalized)) return false;
  return /(^|[:_])(created|modified|last_printed|creationdate|moddate|createdate|modifydate|metadatadate|lastsaved|lastprinted)([:_]|$)/.test(normalized);
}

function isComparableKey(key) {
  return comparableKeys.has(key)
    || isDateComparableKey(key)
    || key.startsWith('custom:')
    || key.startsWith('converted_docx:')
    || key.startsWith('pdf_info:')
    || key.startsWith('pdf_xmp:')
    || key.startsWith('pdf_raw:')
    || key.startsWith('ole_signal:')
    || key.startsWith('wps:');
}

function tryDecodeBase64Text(value) {
  const text = normalizeValue(value);
  if (!text || text.length < 12 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return '';
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8').replace(/^\uFEFF/, '').trim();
    if (!decoded || decoded === text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded)) return '';
    try {
      return JSON.stringify(JSON.parse(decoded));
    } catch {
      return decoded;
    }
  } catch {
    return '';
  }
}

function addDecodedBase64Fields(fields) {
  for (const [key, value] of Array.from(fields.entries())) {
    if (key.endsWith(':base64_decoded')) continue;
    const decoded = tryDecodeBase64Text(value);
    if (decoded) addField(fields, `${key}:base64_decoded`, decoded);
  }
}

function xmlText(xml, tagName) {
  const pattern = new RegExp(`<[^:>]*:?${tagName}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${tagName}>`, 'i');
  const match = String(xml || '').match(pattern);
  return match ? decodeXml(match[1]) : '';
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function readZipText(zip, entryName) {
  const entry = zip.getEntry(entryName);
  return entry ? entry.getData().toString('utf8') : '';
}

const SUMMARY_PROPERTY_MAP = {
  0x01: { key: 'code_page' },
  0x02: { key: 'title' },
  0x03: { key: 'subject' },
  0x04: { key: 'author' },
  0x05: { key: 'keywords' },
  0x06: { key: 'description' },
  0x07: { key: 'template' },
  0x08: { key: 'last_modified_by' },
  0x09: { key: 'revision' },
  0x0a: { key: 'total_time', kind: 'duration_filetime' },
  0x0b: { key: 'last_printed' },
  0x0c: { key: 'created' },
  0x0d: { key: 'modified' },
  0x0e: { key: 'pages' },
  0x0f: { key: 'words' },
  0x10: { key: 'characters' },
  0x12: { key: 'application' },
  0x13: { key: 'doc_security' },
};

const DOC_SUMMARY_PROPERTY_MAP = {
  0x01: { key: 'code_page' },
  0x02: { key: 'category' },
  0x03: { key: 'presentation_format' },
  0x04: { key: 'bytes' },
  0x05: { key: 'lines' },
  0x06: { key: 'paragraphs' },
  0x07: { key: 'slides' },
  0x08: { key: 'notes' },
  0x09: { key: 'hidden_slides' },
  0x0a: { key: 'multimedia_clips' },
  0x0b: { key: 'scale_crop' },
  0x0c: { key: 'heading_pairs' },
  0x0d: { key: 'titles_of_parts' },
  0x0e: { key: 'manager' },
  0x0f: { key: 'company' },
  0x10: { key: 'links_dirty' },
  0x11: { key: 'characters_with_spaces' },
  0x13: { key: 'shared_doc' },
  0x16: { key: 'hlinks_changed' },
  0x17: { key: 'app_version', kind: 'version' },
  0x1a: { key: 'content_type' },
  0x1b: { key: 'content_status' },
  0x1c: { key: 'language' },
  0x1d: { key: 'document_version' },
};

function align4(value) {
  return value + ((4 - (value % 4)) % 4);
}

function readUInt16LE(buffer, offset) {
  return offset + 2 <= buffer.length ? buffer.readUInt16LE(offset) : 0;
}

function readInt16LE(buffer, offset) {
  return offset + 2 <= buffer.length ? buffer.readInt16LE(offset) : 0;
}

function readUInt32LE(buffer, offset) {
  return offset + 4 <= buffer.length ? buffer.readUInt32LE(offset) : 0;
}

function readInt32LE(buffer, offset) {
  return offset + 4 <= buffer.length ? buffer.readInt32LE(offset) : 0;
}

function codePageToEncoding(codePage) {
  const value = Number(codePage) || 1252;
  if (value === 936 || value === 54936) return 'gb18030';
  if (value === 950) return 'big5';
  if (value === 932) return 'shift_jis';
  if (value === 949) return 'euc-kr';
  if (value === 65001) return 'utf8';
  if (value === 1200 || value === 1201) return 'utf16le';
  if (value >= 1250 && value <= 1258) return `windows${value}`;
  return 'latin1';
}

function decodeCodePageBuffer(buffer, codePage) {
  const encoding = codePageToEncoding(codePage);
  try {
    return iconv.decode(buffer, encoding);
  } catch {
    return buffer.toString('latin1');
  }
}

function cleanOleString(value) {
  return String(value || '').replace(/\u0000+$/g, '').replace(/\u0000/g, '').trim();
}

function parseFileTimeValue(buffer, offset) {
  const low = readUInt32LE(buffer, offset);
  const high = readUInt32LE(buffer, offset + 4);
  if (!low && !high) return '';
  const ticks = (BigInt(high) << 32n) + BigInt(low);
  const unixMs = ticks / 10000n - 11644473600000n;
  const date = new Date(Number(unixMs));
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function parseFileTimeDuration(buffer, offset) {
  const low = readUInt32LE(buffer, offset);
  const high = readUInt32LE(buffer, offset + 4);
  const ticks = (BigInt(high) << 32n) + BigInt(low);
  if (!ticks) return '';
  const seconds = Number(ticks / 10000000n);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`;
}

function parseLpstr(buffer, offset, codePage, padded = true) {
  const length = readUInt32LE(buffer, offset);
  const start = offset + 4;
  const byteLength = Math.max(0, Math.min(length, buffer.length - start));
  const raw = buffer.subarray(start, start + byteLength);
  return {
    value: cleanOleString(decodeCodePageBuffer(raw, codePage)),
    nextOffset: padded ? align4(start + byteLength) : start + byteLength,
  };
}

function parseLpwstr(buffer, offset, padded = true) {
  const charLength = readUInt32LE(buffer, offset);
  const start = offset + 4;
  const byteLength = Math.max(0, Math.min(charLength * 2, buffer.length - start));
  const raw = buffer.subarray(start, start + byteLength);
  return {
    value: cleanOleString(raw.toString('utf16le')),
    nextOffset: padded ? align4(start + byteLength) : start + byteLength,
  };
}

function parseVectorStringValue(buffer, offset, type, codePage) {
  const count = readUInt32LE(buffer, offset);
  let cursor = offset + 4;
  const values = [];
  for (let index = 0; index < count && cursor < buffer.length; index += 1) {
    const parsed = type === 0x101f ? parseLpwstr(buffer, cursor, true) : parseLpstr(buffer, cursor, codePage, false);
    if (parsed.value) values.push(parsed.value);
    cursor = parsed.nextOffset;
  }
  return { value: values, nextOffset: cursor };
}

function parseVectorVariantValue(buffer, offset, codePage) {
  const count = readUInt32LE(buffer, offset);
  let cursor = offset + 4;
  const values = [];
  for (let index = 0; index < count && cursor < buffer.length; index += 1) {
    const parsed = parseTypedPropertyValue(buffer, cursor, codePage);
    if (parsed.value !== '') values.push(parsed.value);
    cursor = parsed.nextOffset;
  }
  return { value: values, nextOffset: cursor };
}

function parseTypedPropertyValue(buffer, offset, codePage = 1252) {
  const type = readUInt16LE(buffer, offset);
  const valueOffset = offset + 4;
  if (!type || valueOffset > buffer.length) return { type, value: '', nextOffset: valueOffset };

  if (type === 0x02) return { type, value: readInt16LE(buffer, valueOffset), nextOffset: align4(valueOffset + 2) };
  if (type === 0x03) return { type, value: readInt32LE(buffer, valueOffset), nextOffset: valueOffset + 4 };
  if (type === 0x05) return { type, value: buffer.readDoubleLE(valueOffset), nextOffset: valueOffset + 8 };
  if (type === 0x0b) return { type, value: readUInt32LE(buffer, valueOffset) !== 0, nextOffset: valueOffset + 4 };
  if (type === 0x13) return { type, value: readUInt32LE(buffer, valueOffset), nextOffset: valueOffset + 4 };
  if (type === 0x1e) return { type, ...parseLpstr(buffer, valueOffset, codePage, true) };
  if (type === 0x1f) return { type, ...parseLpwstr(buffer, valueOffset, true) };
  if (type === 0x40) return { type, value: parseFileTimeValue(buffer, valueOffset), nextOffset: valueOffset + 8 };
  if (type === 0x50) return { type, ...parseLpwstr(buffer, valueOffset, true) };
  if (type === 0x51) return { type, ...parseLpwstr(buffer, valueOffset, false) };
  if (type === 0x101e || type === 0x101f) return { type, ...parseVectorStringValue(buffer, valueOffset, type, codePage) };
  if (type === 0x100c) return { type, ...parseVectorVariantValue(buffer, valueOffset, codePage) };
  if (type === 0x41) {
    const size = readUInt32LE(buffer, valueOffset);
    return { type, value: size ? `BLOB ${size} bytes` : '', nextOffset: align4(valueOffset + 4 + size) };
  }
  return { type, value: '', nextOffset: valueOffset + 4 };
}

function parsePropertyDictionary(buffer, offset, codePage) {
  const count = readUInt32LE(buffer, offset);
  const dictionary = new Map();
  let cursor = offset + 4;
  for (let index = 0; index < count && cursor + 8 <= buffer.length; index += 1) {
    const propertyId = readUInt32LE(buffer, cursor);
    const length = readUInt32LE(buffer, cursor + 4);
    cursor += 8;
    let byteLength = codePage === 1200 ? length * 2 : length;
    if (cursor + byteLength > buffer.length) byteLength = Math.max(0, Math.min(length, buffer.length - cursor));
    const raw = buffer.subarray(cursor, cursor + byteLength);
    const value = codePage === 1200 ? cleanOleString(raw.toString('utf16le')) : cleanOleString(decodeCodePageBuffer(raw, codePage));
    if (value) dictionary.set(propertyId, value.replace(/^\u0005/, '!'));
    cursor = align4(cursor + byteLength);
  }
  return dictionary;
}

function formatVersionNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return `${number >>> 16}.${String(number & 0xffff).padStart(4, '0')}`;
}

function parsePropertySet(buffer, offset, propertyMap = {}) {
  const size = readUInt32LE(buffer, offset);
  const count = readUInt32LE(buffer, offset + 4);
  const entries = [];
  for (let index = 0; index < count && offset + 8 + index * 8 + 8 <= buffer.length; index += 1) {
    entries.push({ id: readUInt32LE(buffer, offset + 8 + index * 8), offset: offset + readUInt32LE(buffer, offset + 12 + index * 8) });
  }

  let codePage = 1252;
  const codePageEntry = entries.find((entry) => entry.id === 0x01);
  if (codePageEntry) {
    const parsedCodePage = parseTypedPropertyValue(buffer, codePageEntry.offset, codePage).value;
    if (parsedCodePage) codePage = Number(parsedCodePage) || codePage;
  }

  const dictionaryEntry = entries.find((entry) => entry.id === 0x00);
  const dictionary = dictionaryEntry ? parsePropertyDictionary(buffer, dictionaryEntry.offset, codePage) : new Map();
  const fields = new Map();
  const endOffset = size ? offset + size : buffer.length;

  for (const entry of entries) {
    if (entry.id === 0x00 || entry.offset >= endOffset || entry.offset >= buffer.length) continue;
    const propertyInfo = propertyMap[entry.id];
    const parsed = parseTypedPropertyValue(buffer, entry.offset, codePage);
    let value = propertyInfo?.kind === 'duration_filetime' && parsed.type === 0x40
      ? parseFileTimeDuration(buffer, entry.offset + 4)
      : parsed.value;
    if (propertyInfo?.kind === 'version') value = formatVersionNumber(value);
    const name = propertyInfo?.key || (dictionary.get(entry.id) ? `custom:${dictionary.get(entry.id)}` : `ole_prop_${entry.id}`);
    addField(fields, name, value);
  }
  return fields;
}

function parsePropertySetStream(content, propertyMap) {
  const buffer = Buffer.from(content || []);
  const fields = new Map();
  if (buffer.length < 48 || readUInt16LE(buffer, 0) !== 0xfffe) return fields;
  const setCount = readUInt32LE(buffer, 24);
  for (let index = 0; index < setCount && 28 + index * 20 + 20 <= buffer.length; index += 1) {
    const setOffset = readUInt32LE(buffer, 28 + index * 20 + 16);
    if (!setOffset || setOffset >= buffer.length) continue;
    const parsed = parsePropertySet(buffer, setOffset, index === 0 ? propertyMap : {});
    for (const [key, value] of parsed.entries()) addField(fields, key, value);
  }
  return fields;
}

function findCfbEntry(cfb, streamName) {
  const bangName = streamName.replace(/^\u0005/, '!');
  const candidates = [streamName, `/${streamName}`, bangName, `/${bangName}`];
  for (const candidate of candidates) {
    const entry = CFB.find(cfb, candidate);
    if (entry?.content) return entry;
  }
  return null;
}

const rawSignalPattern = /(kingsoft|wps office|\bwps\b|\bkso\b|account|e-mail|email|mail|userid|user id|user_id|uid|账号|金山)/ig;

function collectSignalSnippets(value, limit = 5) {
  const text = String(value || '').replace(/\u0000/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]+/g, ' ');
  const snippets = [];
  rawSignalPattern.lastIndex = 0;
  let match;
  while ((match = rawSignalPattern.exec(text)) && snippets.length < limit) {
    const start = Math.max(0, (match.index || 0) - 40);
    const end = Math.min(text.length, (match.index || 0) + match[0].length + 80);
    const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (isReadableSignalSnippet(snippet) && !snippets.includes(snippet)) snippets.push(snippet);
  }
  return snippets;
}

function isReadableSignalSnippet(value) {
  const text = String(value || '').trim();
  if (!text || text.includes('�')) return false;
  const chars = Array.from(text);
  const readable = chars.filter((char) => /[\p{Script=Han}A-Za-z0-9\s.,:;_@/\\\-()[\]{}"'，。：；（）【】《》、]/u.test(char)).length;
  return readable / Math.max(chars.length, 1) >= 0.75;
}

function collectBinarySignalSnippets(content) {
  const buffer = Buffer.from(content || []).subarray(0, 1024 * 1024);
  const candidates = [buffer.toString('utf16le'), decodeCodePageBuffer(buffer, 936), buffer.toString('utf8')];
  const snippets = [];
  for (const text of candidates) {
    for (const snippet of collectSignalSnippets(text, 3)) {
      if (!snippets.includes(snippet)) snippets.push(snippet);
      if (snippets.length >= 5) return snippets;
    }
  }
  return snippets;
}

function addOleSignalFields(fields, cfb) {
  for (let index = 0; index < cfb.FileIndex.length; index += 1) {
    const entry = cfb.FileIndex[index];
    const fullPath = cfb.FullPaths[index] || entry.name || `stream_${index}`;
    const signalKey = `ole_signal:${safeMetadataKey(fullPath)}`;
    for (const snippet of collectSignalSnippets(fullPath, 2)) addListField(fields, signalKey, snippet);
    if (entry?.content?.length && !isOlePropertySetStreamName(fullPath)) {
      for (const snippet of collectBinarySignalSnippets(entry.content)) addListField(fields, signalKey, snippet);
    }
  }
}

function isOlePropertySetStreamName(value) {
  return /(?:summaryinformation|documentsummaryinformation)$/i.test(String(value || '').replace(/^.*[\\/]/, '').replace(/^\u0005|^!/, ''));
}

function addWpsSignalFields(fields) {
  const entries = Array.from(fields.entries());
  for (const [key, value] of entries) {
    if (key.startsWith('wps:')) continue;
    const haystack = `${key} ${value}`;
    if (!collectSignalSnippets(haystack, 1).length) continue;
    addListField(fields, `wps:${safeMetadataKey(key)}`, value);
  }
}

async function extractDocxMetadata(filePath) {
  const zip = new AdmZip(filePath);
  const fields = new Map();
  const core = readZipText(zip, 'docProps/core.xml');
  const app = readZipText(zip, 'docProps/app.xml');
  const custom = readZipText(zip, 'docProps/custom.xml');

  addField(fields, 'title', xmlText(core, 'title'));
  addField(fields, 'subject', xmlText(core, 'subject'));
  addField(fields, 'author', xmlText(core, 'creator'));
  addField(fields, 'last_modified_by', xmlText(core, 'lastModifiedBy'));
  addField(fields, 'revision', xmlText(core, 'revision'));
  addField(fields, 'created', xmlText(core, 'created'));
  addField(fields, 'modified', xmlText(core, 'modified'));
  addField(fields, 'keywords', xmlText(core, 'keywords'));
  addField(fields, 'category', xmlText(core, 'category'));
  addField(fields, 'description', xmlText(core, 'description'));
  addField(fields, 'application', xmlText(app, 'Application'));
  addField(fields, 'app_version', xmlText(app, 'AppVersion'));
  addField(fields, 'company', xmlText(app, 'Company'));
  addField(fields, 'manager', xmlText(app, 'Manager'));
  addField(fields, 'template', xmlText(app, 'Template'));
  addField(fields, 'pages', xmlText(app, 'Pages'));
  addField(fields, 'words', xmlText(app, 'Words'));
  addField(fields, 'characters', xmlText(app, 'Characters'));
  addField(fields, 'lines', xmlText(app, 'Lines'));
  addField(fields, 'paragraphs', xmlText(app, 'Paragraphs'));
  addField(fields, 'total_time', xmlText(app, 'TotalTime'));

  for (const match of custom.matchAll(/<property\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/property>/gi)) {
    const key = `custom:${decodeXml(match[1])}`;
    const valueMatch = match[2].match(/<[^>]+>([\s\S]*?)<\/[^>]+>/);
    addField(fields, key, valueMatch ? decodeXml(valueMatch[1]) : decodeXml(match[2]));
  }

  addWpsSignalFields(fields);
  return fields;
}

async function extractOleMetadata(filePath) {
  const buffer = await fs.readFile(filePath);
  const cfb = CFB.read(buffer, { type: 'buffer' });
  const fields = new Map();
  const summary = findCfbEntry(cfb, '\u0005SummaryInformation');
  const documentSummary = findCfbEntry(cfb, '\u0005DocumentSummaryInformation');

  if (summary) {
    for (const [key, value] of parsePropertySetStream(summary.content, SUMMARY_PROPERTY_MAP).entries()) addField(fields, key, value);
  }
  if (documentSummary) {
    for (const [key, value] of parsePropertySetStream(documentSummary.content, DOC_SUMMARY_PROPERTY_MAP).entries()) addField(fields, key, value);
  }
  addOleSignalFields(fields, cfb);
  addWpsSignalFields(fields);
  return fields;
}

async function extractConvertedDocxMetadata(filePath) {
  const converterUrl = pathToFileURL(path.join(__dirname, 'doc2markdown', 'convert.mjs')).href;
  const { withLegacyWordDocxFile } = await import(converterUrl);
  return withLegacyWordDocxFile(filePath, (docxPath) => extractDocxMetadata(docxPath));
}

function mergeMetadataFields(target, source, options = {}) {
  for (const [key, value] of source.entries()) {
    if (options.fillOnlyIfAbsent) addFieldIfAbsent(target, key, value);
    else addField(target, key, value);
    if (options.prefix) addField(target, `${options.prefix}:${key}`, value);
  }
}

async function hasZipHeader(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4);
    const result = await handle.read(buffer, 0, 4, 0);
    return result.bytesRead >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
  } finally {
    await handle.close();
  }
}

async function extractLegacyWordMetadata(filePath) {
  const fields = new Map();
  const errors = [];
  try {
    mergeMetadataFields(fields, await extractOleMetadata(filePath));
  } catch (error) {
    errors.push(`OLE 元数据读取失败：${error.message || error}`);
  }

  try {
    mergeMetadataFields(fields, await extractConvertedDocxMetadata(filePath), {
      fillOnlyIfAbsent: true,
      prefix: 'converted_docx',
    });
  } catch (error) {
    errors.push(`转换 DOCX 元数据读取失败：${error.message || error}`);
  }

  if (errors.length) addListField(fields, 'metadata_error', errors.join('；'));
  addWpsSignalFields(fields);
  return fields;
}

const PDF_INFO_KEY_MAP = {
  Title: 'title',
  Author: 'author',
  Subject: 'subject',
  Keywords: 'keywords',
  Creator: 'creator',
  Producer: 'producer',
  CreationDate: 'created',
  ModDate: 'modified',
  PDFFormatVersion: 'pdf_version',
};

function getPdfMetadataValue(metadata, ...names) {
  if (!metadata) return '';
  for (const name of names) {
    if (typeof metadata.get === 'function') {
      const value = metadata.get(name);
      if (normalizeValue(value)) return value;
    }
    if (Object.prototype.hasOwnProperty.call(metadata, name) && normalizeValue(metadata[name])) return metadata[name];
  }
  return '';
}

function getPdfMetadataEntries(metadata) {
  if (!metadata) return [];
  if (typeof metadata[Symbol.iterator] === 'function') return Array.from(metadata);
  return Object.entries(metadata).filter(([, value]) => normalizeValue(value));
}

function canonicalPdfXmpKey(rawKey) {
  const key = String(rawKey || '').toLowerCase();
  if (/(^|:)title$/.test(key)) return 'title';
  if (/(^|:)creator$/.test(key)) return 'author';
  if (/creatortool$/.test(key)) return 'creator';
  if (/producer$/.test(key)) return 'producer';
  if (/(^|:)subject$/.test(key)) return 'subject';
  if (/keywords$/.test(key)) return 'keywords';
  if (/description$/.test(key)) return 'description';
  if (/createdate$/.test(key)) return 'created';
  if (/(modifydate|metadatadate)$/.test(key)) return 'modified';
  return '';
}

function addPdfInfoFields(fields, info) {
  for (const [rawKey, value] of Object.entries(info || {})) {
    const text = normalizeValue(value);
    if (!text) continue;
    if (PDF_INFO_KEY_MAP[rawKey]) addField(fields, PDF_INFO_KEY_MAP[rawKey], text);
    addField(fields, `pdf_info:${safeMetadataKey(rawKey)}`, text);
  }
}

function addPdfXmpFields(fields, metadata) {
  for (const [rawKey, value] of getPdfMetadataEntries(metadata)) {
    const text = normalizeValue(value);
    if (!text) continue;
    const canonical = canonicalPdfXmpKey(rawKey);
    if (canonical) addFieldIfAbsent(fields, canonical, text);
    addField(fields, `pdf_xmp:${safeMetadataKey(rawKey)}`, text);
  }

  const raw = typeof metadata?.getRaw === 'function' ? metadata.getRaw() : '';
  for (const snippet of collectSignalSnippets(raw, 5)) addListField(fields, 'pdf_xmp:raw_signals', snippet);
}

function decodeUtf16Be(buffer) {
  const chars = [];
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const code = buffer.readUInt16BE(offset);
    if (code) chars.push(String.fromCharCode(code));
  }
  return chars.join('');
}

function decodePdfStringBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return decodeUtf16Be(buffer.subarray(2));
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  const utf8 = buffer.toString('utf8').trim();
  return utf8 || buffer.toString('latin1').trim();
}

function decodePdfLiteralString(value) {
  let text = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '\\') {
      text += char;
      continue;
    }
    const next = value[index + 1];
    if (!next) continue;
    index += 1;
    if (next === 'n') text += '\n';
    else if (next === 'r') text += '\r';
    else if (next === 't') text += '\t';
    else if (next === 'b') text += '\b';
    else if (next === 'f') text += '\f';
    else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let count = 0; count < 2 && /[0-7]/.test(value[index + 1] || ''); count += 1) octal += value[++index];
      text += String.fromCharCode(parseInt(octal, 8));
    } else {
      text += next;
    }
  }
  return decodePdfStringBuffer(Buffer.from(text, 'latin1'));
}

function decodePdfHexString(value) {
  const hex = value.replace(/\s+/g, '');
  if (!hex || hex.length % 2 !== 0) return '';
  try {
    return decodePdfStringBuffer(Buffer.from(hex, 'hex'));
  } catch {
    return '';
  }
}

function addPdfRawFields(fields, buffer) {
  const text = buffer.toString('latin1');
  const pattern = /\/(Title|Author|Subject|Keywords|Creator|Producer|CreationDate|ModDate)\s*(\((?:\\.|[^\\)]){0,1000}\)|<([0-9a-fA-F\s]{2,2000})>)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const rawKey = match[1];
    const rawValue = match[3] ? decodePdfHexString(match[3]) : decodePdfLiteralString(match[2].slice(1, -1));
    addListField(fields, `pdf_raw:${safeMetadataKey(rawKey)}`, rawValue);
  }
  for (const snippet of collectBinarySignalSnippets(buffer)) addListField(fields, 'pdf_raw:signals', snippet);
}

async function extractPdfMetadata(filePath) {
  const buffer = await fs.readFile(filePath);
  const parser = new PDFParse({ data: buffer });
  const fields = new Map();
  try {
    const result = await parser.getInfo();
    const info = result.info || {};
    const metadata = result.metadata || null;
    addPdfInfoFields(fields, info);
    addPdfXmpFields(fields, metadata);
    addFieldIfAbsent(fields, 'title', getPdfMetadataValue(metadata, 'dc:title', 'Title'));
    addFieldIfAbsent(fields, 'author', getPdfMetadataValue(metadata, 'dc:creator', 'Author'));
    addFieldIfAbsent(fields, 'subject', getPdfMetadataValue(metadata, 'dc:subject', 'Subject'));
    addFieldIfAbsent(fields, 'keywords', getPdfMetadataValue(metadata, 'pdf:Keywords', 'Keywords'));
    addFieldIfAbsent(fields, 'creator', getPdfMetadataValue(metadata, 'xmp:CreatorTool', 'Creator'));
    addFieldIfAbsent(fields, 'producer', getPdfMetadataValue(metadata, 'pdf:Producer', 'Producer'));
    addFieldIfAbsent(fields, 'created', getPdfMetadataValue(metadata, 'xmp:CreateDate', 'CreationDate'));
    addFieldIfAbsent(fields, 'modified', getPdfMetadataValue(metadata, 'xmp:ModifyDate', 'xmp:MetadataDate', 'ModDate'));
    addField(fields, 'pages', result.total || result.pages || result.numpages);
    addField(fields, 'pdf_version', result.version || info.PDFFormatVersion);
    addField(fields, 'fingerprints', result.fingerprints);
    addField(fields, 'pdf_permissions', result.permission);
    addPdfRawFields(fields, buffer);
    addWpsSignalFields(fields);
  } finally {
    await parser.destroy();
  }
  return fields;
}

async function extractMetadata(file) {
  const fields = new Map();
  const stats = await fs.stat(file.file_path);
  addField(fields, 'file_name', file.file_name);
  addField(fields, 'extension', file.extension);
  addField(fields, 'size', file.size || stats.size);
  addField(fields, 'created_at', stats.birthtime.toISOString());
  addField(fields, 'modified_at', stats.mtime.toISOString());
  addField(fields, 'accessed_at', stats.atime.toISOString());

  try {
    const extension = String(file.extension || '').toLowerCase();
    if (extension === '.docx' || ((extension === '.doc' || extension === '.wps') && await hasZipHeader(file.file_path))) {
      mergeMetadataFields(fields, await extractDocxMetadata(file.file_path));
    } else if (extension === '.doc' || extension === '.wps') {
      mergeMetadataFields(fields, await extractLegacyWordMetadata(file.file_path));
    } else if (extension === '.pdf') {
      mergeMetadataFields(fields, await extractPdfMetadata(file.file_path));
    }
  } catch (error) {
    addField(fields, 'metadata_error', error.message || '元数据读取失败');
  }

  addDecodedBase64Fields(fields);
  return Array.from(fields.entries()).map(([key, value]) => ({
    key,
    label: getMetadataLabel(key),
    value,
    normalized: normalizeComparable(value),
    date_day: normalizeDateDay(value),
    comparable: isComparableKey(key),
    date_comparable: isDateComparableKey(key),
  }));
}

function buildRows(files) {
  const keyOrder = [];
  const rowsByKey = new Map();
  for (const file of files) {
    for (const item of file.metadata || []) {
      if (!rowsByKey.has(item.key)) {
        keyOrder.push(item.key);
        rowsByKey.set(item.key, { key: item.key, label: item.label, values: {}, duplicate_file_ids: [], same_day_file_ids: [] });
      }
      rowsByKey.get(item.key).values[file.file_id] = item.value;
    }
  }

  for (const key of keyOrder) {
    const row = rowsByKey.get(key);
    const normalizedToFiles = new Map();
    const dayToFiles = new Map();
    for (const file of files) {
      const item = (file.metadata || []).find((entry) => entry.key === key);
      if (!item?.comparable || !item.normalized) continue;
      if (item.date_comparable) {
        if (!item.date_day) continue;
        const list = dayToFiles.get(item.date_day) || [];
        list.push(file.file_id);
        dayToFiles.set(item.date_day, list);
        continue;
      }
      const list = normalizedToFiles.get(item.normalized) || [];
      list.push(file.file_id);
      normalizedToFiles.set(item.normalized, list);
    }
    row.duplicate_file_ids = Array.from(new Set(Array.from(normalizedToFiles.values()).filter((ids) => ids.length > 1).flat()));
    row.same_day_file_ids = Array.from(new Set(Array.from(dayToFiles.values()).filter((ids) => ids.length > 1).flat()));
  }

  return keyOrder.map((key) => rowsByKey.get(key));
}

function stripMarkdownForOutline(markdown) {
  return String(markdown || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~]/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function normalizeOutlineTitle(value) {
  return normalizeValue(stripMarkdownForOutline(value))
    .replace(/^(?:#{1,6}\s*)/, '')
    .replace(/^[-*+>]\s*/, '')
    .replace(/^(?:第[一二三四五六七八九十百千万\d]+[章节篇部分]|\d+(?:\.\d+)*[.)、．]?|[一二三四五六七八九十]+[、.．]|（[一二三四五六七八九十\d]+）|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])[\s、.．-]*/, '')
    .replace(/[\s　]+/g, '')
    .replace(/[，。！？；：、“”‘’'"《》〈〉（）()\[\]【】{}.,!?;:|/\\_-]+/g, '')
    .toLowerCase();
}

function cleanOutlineTitle(value) {
  return normalizeValue(stripMarkdownForOutline(value))
    .replace(/^(?:#{1,6}\s*)/, '')
    .replace(/^[-*+>]\s*/, '')
    .replace(/(?:\.{2,}|…{2,}|·{2,}|\s{3,})\s*\d+\s*$/g, '')
    .replace(/\s+\d{1,4}\s*$/g, '')
    .trim();
}

function splitTenderSentences(markdown) {
  const text = stripMarkdownForOutline(markdown)
    .replace(/\|/g, '\n')
    .replace(/\r?\n/g, '\n')
    .replace(/[\t ]+/g, ' ');
  const parts = text
    .split(/[。！？!?；;\n]+/)
    .map((item) => cleanOutlineTitle(item))
    .filter(Boolean);
  const seen = new Set();
  const sentences = [];
  for (const part of parts) {
    const normalized = normalizeOutlineTitle(part);
    if (normalized.length < 6 || normalized.length > 160 || seen.has(normalized)) continue;
    seen.add(normalized);
    sentences.push({ text: part, normalized });
  }
  return sentences;
}

function matchTenderSentence(title, tenderSentences) {
  const normalized = normalizeOutlineTitle(title);
  if (normalized.length < 6) return null;
  for (const sentence of tenderSentences) {
    if (sentence.normalized === normalized) return sentence;
    if (normalized.length >= 10 && sentence.normalized.includes(normalized)) return sentence;
    if (sentence.normalized.length >= 10 && normalized.includes(sentence.normalized) && sentence.normalized.length / normalized.length >= 0.8) return sentence;
  }
  return null;
}

function parseOutlineMarker(line) {
  const text = cleanOutlineTitle(line);
  const patterns = [
    { pattern: /^(?<number>\d+(?:\.\d+)*)(?:[.)、．])?\s*(?<title>.+)$/u },
    { pattern: /^(?<number>第[一二三四五六七八九十百千万\d]+[章节篇部分])\s*(?<title>.*)$/u },
    { pattern: /^(?<number>[一二三四五六七八九十]+[、.．])\s*(?<title>.+)$/u },
    { pattern: /^(?<number>（[一二三四五六七八九十\d]+）)\s*(?<title>.+)$/u },
    { pattern: /^(?<number>[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*(?<title>.+)$/u },
  ];
  for (const { pattern } of patterns) {
    const match = text.match(pattern);
    if (!match?.groups) continue;
    const number = match.groups.number.trim();
    const title = cleanOutlineTitle(match.groups.title || number);
    if (!title || normalizeOutlineTitle(title).length < 2) continue;
    return { number, title, level: inferOutlineLevel(number) };
  }
  return null;
}

function inferOutlineLevel(number) {
  const marker = String(number || '').trim();
  if (/^\d+(?:\.\d+)+/.test(marker)) return marker.split('.').filter(Boolean).length;
  if (/^\d+/.test(marker) || /^第.+[章节篇部分]$/.test(marker) || /^[一二三四五六七八九十]+[、.．]$/.test(marker)) return 1;
  if (/^（.+）$/.test(marker) || /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]$/.test(marker)) return 2;
  return 1;
}

function isCatalogTitleLine(line) {
  return /^(?:#{1,6}\s*)?(目录|目次|contents)$/i.test(String(line || '').replace(/\s+/g, ''));
}

function parseCatalogLine(line) {
  const raw = cleanOutlineTitle(String(line || '').replace(/^\|+|\|+$/g, '').replace(/\|/g, ' '));
  if (!raw || /^[-:|\s]+$/.test(raw) || isCatalogTitleLine(raw)) return null;
  const hasPageTrail = /(?:\.{2,}|…{2,}|·{2,}|\s{3,})\s*\d+\s*$/.test(raw) || /\s\d{1,4}$/.test(raw);
  const marker = parseOutlineMarker(raw);
  if (marker) return marker;
  if (!hasPageTrail) return null;
  const title = cleanOutlineTitle(raw.replace(/(?:\.{2,}|…{2,}|·{2,}|\s{3,})\s*\d+\s*$/g, '').replace(/\s+\d{1,4}\s*$/g, ''));
  return title && normalizeOutlineTitle(title).length >= 2 ? { title, level: 1 } : null;
}

function extractCatalogOutline(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const start = lines.findIndex(isCatalogTitleLine);
  if (start < 0) return [];
  const items = [];
  let misses = 0;
  for (let index = start + 1; index < Math.min(lines.length, start + 180); index += 1) {
    const parsed = parseCatalogLine(lines[index]);
    if (!parsed) {
      if (items.length) misses += 1;
      if (misses >= 10) break;
      continue;
    }
    misses = 0;
    items.push({ ...parsed, source: 'catalog', confidence: 0.92 });
  }
  return items;
}

function extractHeadingOutline(markdown) {
  const items = [];
  const lines = String(markdown || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (!match) continue;
    const title = cleanOutlineTitle(match[2]);
    if (!title || isCatalogTitleLine(title)) continue;
    const marker = parseOutlineMarker(title);
    items.push({ number: marker?.number, title: marker?.title || title, level: Math.min(match[1].length, 6), source: 'heading', confidence: 0.82 });
  }
  return items;
}

function extractSemanticOutline(markdown) {
  const items = [];
  const lines = String(markdown || '').split(/\r?\n/);
  for (const line of lines) {
    const text = cleanOutlineTitle(line);
    if (!text || text.length > 90 || /[。！？；;]$/.test(text) || /^\|/.test(text) || isCatalogTitleLine(text)) continue;
    const marker = parseOutlineMarker(text);
    const bold = /^\s*\*\*.+\*\*\s*$/.test(line);
    if (!marker && !bold) continue;
    items.push({ number: marker?.number, title: marker?.title || text, level: marker?.level || 2, source: 'semantic', confidence: marker ? 0.68 : 0.55 });
  }
  return items.slice(0, 260);
}

function buildOutlineItems(markdown, tenderSentences = []) {
  const candidates = [extractCatalogOutline(markdown), extractHeadingOutline(markdown), extractSemanticOutline(markdown)];
  const selected = candidates.find((items) => items.length >= 3) || candidates.find((items) => items.length) || [];
  const stack = [];
  const items = [];
  const seen = new Set();
  for (const candidate of selected) {
    let level = Math.max(1, Math.min(Number(candidate.level) || 1, 6));
    if (level > stack.length + 1) level = stack.length + 1;
    const title = cleanOutlineTitle(candidate.title);
    const normalized = normalizeOutlineTitle(title);
    if (!title || normalized.length < 2) continue;
    const key = `${level}:${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stack.splice(level - 1);
    const parent = stack[level - 2] || null;
    const pathTitles = [...(parent?.path_titles || []), title];
    const matched = matchTenderSentence(title, tenderSentences);
    const item = {
      id: `O${String(items.length + 1).padStart(5, '0')}`,
      level,
      number: candidate.number,
      title,
      normalized_title: normalized,
      path_titles: pathTitles,
      normalized_path: pathTitles.map(normalizeOutlineTitle).filter(Boolean).join('>'),
      source: candidate.source,
      confidence: candidate.confidence,
      order: items.length,
      parent_id: parent?.id,
      from_tender: Boolean(matched),
      matched_tender_sentence: matched?.text,
      duplicate_group_ids: [],
      similar_group_ids: [],
    };
    items.push(item);
    stack[level - 1] = item;
  }
  return { items, source: selected[0]?.source, confidence: selected.length ? Number((selected.reduce((sum, item) => sum + item.confidence, 0) / selected.length).toFixed(2)) : 0 };
}

function intersectSize(a, b) {
  let count = 0;
  for (const item of a) if (b.has(item)) count += 1;
  return count;
}

function bigramSimilarity(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right) return 0;
  if (left === right) return 1;
  const toBigrams = (value) => {
    const chars = Array.from(value);
    if (chars.length <= 1) return new Set(chars);
    return new Set(chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`));
  };
  const leftSet = toBigrams(left);
  const rightSet = toBigrams(right);
  const shared = intersectSize(leftSet, rightSet);
  return (2 * shared) / (leftSet.size + rightSet.size || 1);
}

function lcsSimilarity(left, right) {
  if (!left.length || !right.length) return 0;
  const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      dp[i][j] = left[i - 1] === right[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[left.length][right.length] / Math.max(left.length, right.length);
}

function riskFromScore(score) {
  if (score >= 0.75) return 'high';
  if (score >= 0.55) return 'medium';
  if (score >= 0.35) return 'low';
  return 'none';
}

function buildOutlineComparison(files) {
  const groups = [];
  const byTitle = new Map();
  const byPath = new Map();
  const successful = files.filter((file) => file.status === 'success');
  for (const file of successful) {
    for (const item of file.items || []) {
      if (item.from_tender) continue;
      const titleList = byTitle.get(item.normalized_title) || [];
      titleList.push({ file, item });
      byTitle.set(item.normalized_title, titleList);
      const pathList = byPath.get(item.normalized_path) || [];
      pathList.push({ file, item });
      byPath.set(item.normalized_path, pathList);
    }
  }

  function addGroup(type, entries, title, score) {
    const fileIds = Array.from(new Set(entries.map((entry) => entry.file.file_id)));
    if (fileIds.length < 2) return null;
    const id = `G${String(groups.length + 1).padStart(4, '0')}`;
    const group = { id, type, title, score, file_ids: fileIds, item_ids: {}, paths: {} };
    for (const entry of entries) {
      group.item_ids[entry.file.file_id] = [...(group.item_ids[entry.file.file_id] || []), entry.item.id];
      group.paths[entry.file.file_id] = [...(group.paths[entry.file.file_id] || []), entry.item.path_titles.join(' > ')];
      if (type === 'duplicate') entry.item.duplicate_group_ids.push(id);
      else entry.item.similar_group_ids.push(id);
    }
    groups.push(group);
    return group;
  }

  for (const entries of byPath.values()) addGroup('duplicate', entries, entries[0]?.item.path_titles.join(' > ') || entries[0]?.item.title || '', 1);
  for (const entries of byTitle.values()) {
    const alreadyGrouped = entries.every((entry) => entry.item.duplicate_group_ids.length);
    if (!alreadyGrouped) addGroup('duplicate', entries, entries[0]?.item.title || '', 0.95);
  }

  const seenSimilar = new Set();
  for (let i = 0; i < successful.length; i += 1) {
    for (let j = i + 1; j < successful.length; j += 1) {
      for (const left of successful[i].items.filter((item) => !item.from_tender && !item.duplicate_group_ids.length)) {
        for (const right of successful[j].items.filter((item) => !item.from_tender && !item.duplicate_group_ids.length && Math.abs(item.level - left.level) <= 1)) {
          const score = bigramSimilarity(left.normalized_title, right.normalized_title);
          if (score < 0.86) continue;
          const key = [successful[i].file_id, left.id, successful[j].file_id, right.id].join(':');
          if (seenSimilar.has(key)) continue;
          seenSimilar.add(key);
          addGroup('similar', [{ file: successful[i], item: left }, { file: successful[j], item: right }], left.title, Number(score.toFixed(2)));
        }
      }
    }
  }

  const pairwiseSimilarities = [];
  for (let i = 0; i < successful.length; i += 1) {
    for (let j = i + 1; j < successful.length; j += 1) {
      const leftItems = successful[i].items.filter((item) => !item.from_tender);
      const rightItems = successful[j].items.filter((item) => !item.from_tender);
      const leftTitles = new Set(leftItems.map((item) => item.normalized_title));
      const rightTitles = new Set(rightItems.map((item) => item.normalized_title));
      const leftPaths = new Set(leftItems.map((item) => item.normalized_path));
      const rightPaths = new Set(rightItems.map((item) => item.normalized_path));
      const titleShared = intersectSize(leftTitles, rightTitles);
      const pathShared = intersectSize(leftPaths, rightPaths);
      const titleOverlap = titleShared / Math.max(Math.min(leftTitles.size, rightTitles.size), 1);
      const pathOverlap = pathShared / Math.max(Math.min(leftPaths.size, rightPaths.size), 1);
      const orderSimilarity = lcsSimilarity(leftItems.map((item) => item.normalized_title), rightItems.map((item) => item.normalized_title));
      const score = Number((pathOverlap * 0.45 + titleOverlap * 0.35 + orderSimilarity * 0.2).toFixed(2));
      pairwiseSimilarities.push({
        file_a_id: successful[i].file_id,
        file_b_id: successful[j].file_id,
        score,
        title_overlap: Number(titleOverlap.toFixed(2)),
        path_overlap: Number(pathOverlap.toFixed(2)),
        order_similarity: Number(orderSimilarity.toFixed(2)),
        shared_count: Math.max(titleShared, pathShared),
        risk: riskFromScore(score),
      });
    }
  }

  return { duplicateGroups: groups.sort((a, b) => b.score - a.score || b.file_ids.length - a.file_ids.length), pairwiseSimilarities };
}

function stripImagesFromMarkdown(markdown) {
  return String(markdown || '')
    .replace(markdownImagePattern, ' ')
    .replace(htmlImageSrcPattern, ' ')
    .replace(htmlImagePattern, ' ');
}

function codePointToString(value, fallback) {
  try {
    const codePoint = Number.parseInt(value, 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : fallback;
  } catch {
    return fallback;
  }
}

function hexCodePointToString(value, fallback) {
  try {
    const codePoint = Number.parseInt(value, 16);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : fallback;
  } catch {
    return fallback;
  }
}

function decodeBasicHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => hexCodePointToString(hex, match))
    .replace(/&#(\d+);/g, (match, code) => codePointToString(code, match));
}

function normalizeContentLineBreaks(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function addContentTextBlock(blocks, value) {
  const text = cleanContentSentence(decodeBasicHtmlEntities(value));
  for (const line of normalizeContentLineBreaks(text).split(/\n+/)) {
    const cleaned = cleanContentSentence(line);
    if (cleaned) blocks.push(cleaned);
  }
}

function extractHtmlCellTextBlocks($, cell) {
  const blocks = [];
  const node = $(cell).clone();
  node.find('img').remove();
  node.find('br').replaceWith('\n');

  node.find('p, li, h1, h2, h3, h4, h5, h6, blockquote, div').each((_, element) => {
    const block = $(element).clone();
    block.find('img').remove();
    block.find('br').replaceWith('\n');
    addContentTextBlock(blocks, block.text());
    $(element).remove();
  });

  addContentTextBlock(blocks, node.text());
  return blocks;
}

function extractHtmlTableTextBlocks(tableHtml) {
  const $ = cheerio.load(tableHtml, { decodeEntities: false });
  const blocks = [];
  $('tr').each((_, row) => {
    $(row).children('th, td').each((__, cell) => {
      for (const block of extractHtmlCellTextBlocks($, cell)) {
        addContentTextBlock(blocks, block);
      }
    });
  });
  if (!blocks.length) addContentTextBlock(blocks, $.root().text());
  return blocks;
}

function splitMarkdownTableRow(line) {
  let text = String(line || '').trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);

  const cells = [];
  let current = '';
  let escaped = false;
  for (const char of text) {
    if (char === '\\' && !escaped) {
      escaped = true;
      current += char;
      continue;
    }
    if (char === '|' && !escaped) {
      cells.push(current.replace(/\\\|/g, '|').trim());
      current = '';
      continue;
    }
    current += char;
    escaped = false;
  }
  cells.push(current.replace(/\\\|/g, '|').trim());
  return cells;
}

function isMarkdownTableSeparator(line) {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s+/g, '')));
}

function isMarkdownTableRow(line) {
  return splitMarkdownTableRow(line).length > 1;
}

function cleanMarkdownInlineText(value) {
  return decodeBasicHtmlEntities(String(value || '')
    .replace(markdownImagePattern, ' ')
    .replace(htmlImageSrcPattern, ' ')
    .replace(htmlImagePattern, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|blockquote|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1'));
}

function cleanMarkdownLine(value) {
  return cleanMarkdownInlineText(value)
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]|>)\s+/, '')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

function extractMarkdownTextBlocks(markdown) {
  const lines = normalizeContentLineBreaks(String(markdown || '').replace(/```[\s\S]*?```/g, '\n')).split('\n');
  const blocks = [];
  const paragraph = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    addContentTextBlock(blocks, paragraph.join(' '));
    paragraph.length = 0;
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (index + 1 < lines.length && isMarkdownTableRow(lines[index]) && isMarkdownTableSeparator(lines[index + 1])) {
      flushParagraph();
      const tableRows = [splitMarkdownTableRow(lines[index])];
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        if (!isMarkdownTableSeparator(lines[index])) tableRows.push(splitMarkdownTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      for (const row of tableRows) {
        for (const cell of row) {
          addContentTextBlock(blocks, cleanMarkdownInlineText(cell));
        }
      }
      continue;
    }

    const rawLine = lines[index];
    const cleaned = cleanMarkdownLine(rawLine);
    if (!cleaned) {
      flushParagraph();
      continue;
    }

    const standalone = /^\s{0,3}#{1,6}\s+/.test(rawLine)
      || /^\s*(?:[-*+]|>)\s+/.test(rawLine)
      || /^\s*(?:\d+(?:\.\d+)*[.)、．]|[一二三四五六七八九十]+[、.．]|（[一二三四五六七八九十\d]+）|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s+/.test(rawLine);
    const fieldLine = /^[^：:\s]{1,18}[：:]/.test(cleaned);
    const sentenceLine = /[。！？!?；;]$/.test(cleaned);
    if (standalone || fieldLine || sentenceLine) {
      flushParagraph();
      addContentTextBlock(blocks, cleaned);
    } else {
      paragraph.push(cleaned);
    }
  }
  flushParagraph();
  return blocks;
}

function extractContentTextBlocks(markdown) {
  const source = stripImagesFromMarkdown(markdown);
  const tableBlocks = [];
  const withMarkers = source.replace(htmlTablePattern, (tableHtml) => {
    const index = tableBlocks.length;
    tableBlocks.push(extractHtmlTableTextBlocks(tableHtml));
    return `\n\n${contentTableTokenPrefix}${index}\n\n`;
  });
  const tokenPattern = new RegExp(`(${contentTableTokenPrefix}\\d+)`, 'g');
  const blocks = [];
  for (const chunk of withMarkers.split(tokenPattern)) {
    const tokenMatch = chunk.match(new RegExp(`^${contentTableTokenPrefix}(\\d+)$`));
    if (tokenMatch) {
      blocks.push(...(tableBlocks[Number(tokenMatch[1])] || []));
    } else {
      blocks.push(...extractMarkdownTextBlocks(chunk));
    }
  }
  return blocks;
}

function normalizeContentSentence(value) {
  return stripLeadingContentSequence(String(value || ''))
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/[\s　]+/g, ' ')
    .trim();
}

function stripLeadingContentSequence(value) {
  let text = String(value || '').trim();
  const patterns = [
    /^\s*[\d０-９]+(?:\\?[.．][\d０-９]+)*\s*(?:\\?[.．]|[)）、])\s*/u,
    /^\s*[\d０-９]+(?:\\?[.．][\d０-９]+)*\s+(?=[A-Za-z\u4e00-\u9fff（(])/u,
    /^\s*\((?:[\d０-９]+(?:\\?[.．][\d０-９]+)*|[一二三四五六七八九十百千万]+)\)\s*(?:\\?[.．]|[、])?\s*/u,
    /^\s*[一二三四五六七八九十百千万]+\s*(?:\\?[.．]|[、)）])\s*/u,
    /^\s*（(?:[一二三四五六七八九十百千万]+|[\d０-９]+(?:\\?[.．][\d０-９]+)*)）\s*(?:\\?[.．]|[、])?\s*/u,
    /^\s*[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]\s*(?:\\?[.．]|[、])?\s*/u,
    /^\s*第(?:[\d０-９]+|[一二三四五六七八九十百千万]+)[章节篇部分卷]\s*/u,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      const next = text.replace(pattern, '');
      if (next !== text) {
        text = next.trimStart();
        changed = true;
        break;
      }
    }
  }
  return text;
}

function cleanContentSentence(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/[　]+/g, ' ')
    .trim();
}

function splitContentBlockSentences(block) {
  const text = cleanContentSentence(block);
  if (!text) return [];

  const parts = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const currentLength = text.slice(start, index + 1).replace(/\s+/g, '').length;
    const strongBoundary = /[。！？!?]/.test(char);
    const clauseBoundary = /[；;]/.test(char) && currentLength >= 20;
    if (strongBoundary || clauseBoundary) {
      parts.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

function isInformativeContentSentence(sentence) {
  const compact = String(sentence || '').replace(/\s+/g, '');
  if (!compact || /^\d+$/.test(compact)) return false;
  const contentChars = compact.match(/[A-Za-z0-9\u4e00-\u9fff]/g) || [];
  if (contentChars.length < 4) return false;
  if (compact.length >= 12) return true;
  if (compact.length >= 6 && /[：:]/.test(compact) && /[A-Za-z\u4e00-\u9fff]{2,}/.test(compact)) return true;
  return compact.length >= 6
    && /[\u4e00-\u9fff]/.test(compact)
    && /(?:日历天|个月|万元|GHz|MHz|GB|MB|kg|mm|cm|天|年|元|%|％)/i.test(compact);
}

function splitContentSentences(markdown) {
  const sentences = [];
  for (const block of extractContentTextBlocks(markdown)) {
    for (const part of splitContentBlockSentences(block)) {
      const sentence = cleanContentSentence(part);
      const normalized = normalizeContentSentence(sentence);
      if (!normalized) continue;
      if (!isInformativeContentSentence(normalized)) continue;
      sentences.push({ sentence: sentence.length > 600 ? `${sentence.slice(0, 600)}...` : sentence, normalized });
    }
  }
  return sentences;
}

function buildDuplicateSentences(globalSentences) {
  return Array.from(globalSentences.values())
    .filter((item) => item.file_ids.length > 1)
    .sort((a, b) => b.file_ids.length - a.file_ids.length || b.sentence.length - a.sentence.length || a.first_order - b.first_order)
    .map((item, index) => ({ ...item, id: `S${String(index + 1).padStart(6, '0')}` }));
}

function extractImageTargets(markdown) {
  const targets = [];
  for (const match of String(markdown || '').matchAll(markdownImagePattern)) {
    const target = String(match.groups?.target || '').trim().replace(/^<|>$/g, '');
    if (target) targets.push(target);
  }
  for (const match of String(markdown || '').matchAll(htmlImageSrcPattern)) {
    const target = String(match.groups?.src || '').trim();
    if (target) targets.push(target);
  }
  return targets;
}

function isPathInsideDirectory(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveAssetPath(app, value) {
  const url = new URL(value);
  const roots = {
    'generated-images': getGeneratedImagesDir(app),
    'imported-images': getImportedImagesDir(app),
  };
  const rootDir = roots[url.hostname];
  if (!rootDir) return '';
  const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!relativePath) return '';
  const baseDir = path.resolve(rootDir);
  const filePath = path.resolve(baseDir, relativePath);
  return isPathInsideDirectory(baseDir, filePath) && filePath !== baseDir ? filePath : '';
}

async function readImageTargetBuffer(app, target) {
  const value = String(target || '').trim();
  if (!value) return null;
  const dataMatch = value.match(/^data:image\/[^;]+;base64,(?<data>[A-Za-z0-9+/=\s]+)$/i);
  if (dataMatch?.groups?.data) return Buffer.from(dataMatch.groups.data.replace(/\s+/g, ''), 'base64');
  if (/^yibiao-asset:\/\//i.test(value)) {
    const filePath = resolveAssetPath(app, value);
    return filePath ? fs.readFile(filePath) : null;
  }
  if (/^file:\/\//i.test(value)) {
    return fs.readFile(new URL(value));
  }
  return null;
}

function buildDuplicateImages(globalImages) {
  return Array.from(globalImages.values())
    .filter((item) => item.file_ids.length > 1)
    .sort((a, b) => b.file_ids.length - a.file_ids.length || Object.values(b.occurrences).reduce((sum, count) => sum + count, 0) - Object.values(a.occurrences).reduce((sum, count) => sum + count, 0))
    .map((item, index) => ({ ...item, id: `I${String(index + 1).padStart(6, '0')}` }));
}

function createInitialAnalysis(signature, bidFiles) {
  const total = bidFiles.length;
  return {
    status: 'running',
    progress: 0,
    message: '正在启动元数据分析',
    signature,
    started_at: now(),
    updated_at: now(),
    contentExtraction: { status: 'running', completed: 0, total: 0 },
    metadataExtraction: { status: total ? 'running' : 'success', completed: 0, total },
    files: [],
    rows: [],
    contentFiles: [],
    logs: [],
  };
}

function createInitialOutlineAnalysis(signature, bidFiles) {
  return {
    status: 'pending',
    progress: 0,
    message: '等待元数据提取完成后开始目录分析',
    signature,
    started_at: now(),
    updated_at: now(),
    tenderSentenceCount: 0,
    tenderMatchedItemCount: 0,
    extraction: { status: bidFiles.length ? 'pending' : 'success', completed: 0, total: bidFiles.length },
    files: [],
    duplicateGroups: [],
    pairwiseSimilarities: [],
  };
}

function createInitialContentAnalysis(signature, bidFiles) {
  return {
    status: 'pending',
    progress: 0,
    message: '等待正文内容提取完成后开始正文比对',
    signature,
    started_at: now(),
    updated_at: now(),
    tenderSentenceCount: 0,
    tenderMatchedSentenceCount: 0,
    totalSentenceCount: 0,
    extraction: { status: bidFiles.length ? 'pending' : 'success', completed: 0, total: bidFiles.length },
    duplicateSentences: [],
  };
}

function createInitialImageAnalysis(signature, bidFiles) {
  return {
    status: 'pending',
    progress: 0,
    message: '等待正文内容提取完成后开始图片比对',
    signature,
    started_at: now(),
    updated_at: now(),
    extraction: { status: bidFiles.length ? 'pending' : 'success', completed: 0, total: bidFiles.length },
    totalImageCount: 0,
    files: [],
    duplicateImages: [],
  };
}

function createDuplicateCheckService({ app, configStore, workspaceStore } = {}) {
  const running = new Map();

  function emit(webContents, state) {
    if (webContents && !webContents.isDestroyed()) {
      webContents.send('duplicate-check:event', { duplicateCheck: state });
    }
  }

  function isCurrentDuplicateCheckSignature(signature) {
    if (!signature) return true;
    const current = workspaceStore.loadDuplicateCheck() || {};
    const currentSignature = createSignature({
      tenderFile: current.tenderFile || null,
      bidFiles: Array.isArray(current.bidFiles) ? current.bidFiles : [],
    });
    return currentSignature === signature;
  }

  function updateAnalysis(partial, webContents, signature) {
    if (!isCurrentDuplicateCheckSignature(signature)) return null;
    const prev = workspaceStore.loadDuplicateCheck() || {};
    const prevAnalysis = prev.metadataAnalysis || {};
    const metadataAnalysis = { ...prevAnalysis, ...partial, updated_at: now() };
    const next = workspaceStore.updateDuplicateCheck({ metadataAnalysis });
    emit(webContents, next);
    return next;
  }

  function updateOutlineAnalysis(partial, webContents, signature) {
    if (!isCurrentDuplicateCheckSignature(signature)) return null;
    const prev = workspaceStore.loadDuplicateCheck() || {};
    const prevAnalysis = prev.outlineAnalysis || {};
    const outlineAnalysis = { ...prevAnalysis, ...partial, updated_at: now() };
    const next = workspaceStore.updateDuplicateCheck({ outlineAnalysis });
    emit(webContents, next);
    return next;
  }

  function updateContentAnalysis(partial, webContents, signature) {
    if (!isCurrentDuplicateCheckSignature(signature)) return null;
    const prev = workspaceStore.loadDuplicateCheck() || {};
    const prevAnalysis = prev.contentAnalysis || {};
    const contentAnalysis = { ...prevAnalysis, ...partial, updated_at: now() };
    const next = workspaceStore.updateDuplicateCheck({ contentAnalysis });
    emit(webContents, next);
    return next;
  }

  function updateImageAnalysis(partial, webContents, signature) {
    if (!isCurrentDuplicateCheckSignature(signature)) return null;
    const prev = workspaceStore.loadDuplicateCheck() || {};
    const prevAnalysis = prev.imageAnalysis || {};
    const imageAnalysis = { ...prevAnalysis, ...partial, updated_at: now() };
    const next = workspaceStore.updateDuplicateCheck({ imageAnalysis });
    emit(webContents, next);
    return next;
  }

  async function runContentExtraction(allFiles, webContents, signature) {
    const config = configStore ? configStore.load() : { file_parser: { provider: 'local' } };
    const dir = path.join(getDuplicateCheckDir(app), 'contents');
    await fs.mkdir(dir, { recursive: true });
    const results = [];
    updateAnalysis({ contentExtraction: { status: 'running', completed: 0, total: allFiles.length }, message: '正在提取正文内容' }, webContents, signature);

    for (const file of allFiles) {
      const fileId = stableFileId(file);
      try {
        const markdown = (await parseDocumentWithConfig(app, file.file_path, config, {
          assetScope: `duplicate-check-content-${fileId}`,
          preserveImages: true,
        })).trim();
        const contentPath = path.join(dir, `${fileId}.md`);
        await fs.writeFile(contentPath, markdown, 'utf-8');
        results.push({ file_id: fileId, file_name: file.file_name, status: 'success', content_path: contentPath, content_length: markdown.length });
      } catch (error) {
        results.push({ file_id: fileId, file_name: file.file_name, status: 'error', error: error.message || '正文提取失败' });
      }
      updateAnalysis({ contentExtraction: { status: 'running', completed: results.length, total: allFiles.length }, contentFiles: results, message: `正文内容提取 ${results.length}/${allFiles.length}` }, webContents, signature);
    }

    const status = results.some((item) => item.status === 'error') ? 'error' : 'success';
    updateAnalysis({ contentExtraction: { status, completed: results.length, total: allFiles.length }, contentFiles: results }, webContents, signature);
    return results;
  }

  async function runMetadataExtraction(bidFiles, webContents, signature) {
    const results = [];
    updateAnalysis({ metadataExtraction: { status: 'running', completed: 0, total: bidFiles.length }, message: '正在提取投标文件元数据' }, webContents, signature);

    for (const file of bidFiles) {
      const fileId = stableFileId(file);
      try {
        results.push({ file_id: fileId, file_name: file.file_name, status: 'success', metadata: await extractMetadata(file) });
      } catch (error) {
        results.push({ file_id: fileId, file_name: file.file_name, status: 'error', error: error.message || '元数据提取失败', metadata: [] });
      }
      const rows = buildRows(results);
      updateAnalysis({ metadataExtraction: { status: 'running', completed: results.length, total: bidFiles.length }, files: results, rows, message: `元数据提取 ${results.length}/${bidFiles.length}` }, webContents, signature);
    }

    const rows = buildRows(results);
    const status = results.some((item) => item.status === 'error') ? 'error' : 'success';
    updateAnalysis({ metadataExtraction: { status, completed: results.length, total: bidFiles.length }, files: results, rows }, webContents, signature);
    return results;
  }

  async function readContentMarkdown(contentFiles, file) {
    const fileId = stableFileId(file);
    const item = contentFiles.find((entry) => entry.file_id === fileId && entry.status === 'success' && entry.content_path);
    if (!item) throw new Error('正文内容尚未成功提取，无法进行目录分析');
    return fs.readFile(item.content_path, 'utf-8');
  }

  async function runOutlineAnalysis(tenderFile, bidFiles, contentFiles, signature, webContents) {
    updateOutlineAnalysis({ status: 'running', progress: 5, extraction: { status: 'running', completed: 0, total: bidFiles.length }, message: '正在准备目录分析' }, webContents, signature);
    const results = [];
    let tenderSentences = [];
    if (tenderFile) {
      try {
        const tenderMarkdown = await readContentMarkdown(contentFiles, tenderFile);
        tenderSentences = splitTenderSentences(tenderMarkdown);
      } catch (error) {
        updateOutlineAnalysis({ message: `招标文件句子白名单生成失败，继续对比投标文件目录：${error.message || error}` }, webContents, signature);
      }
    }

    updateOutlineAnalysis({ tenderSentenceCount: tenderSentences.length, message: '正在提取投标文件目录' }, webContents, signature);
    for (const file of bidFiles) {
      const fileId = stableFileId(file);
      try {
        const markdown = await readContentMarkdown(contentFiles, file);
        const extracted = buildOutlineItems(markdown, tenderSentences);
        const tenderMatchedCount = extracted.items.filter((item) => item.from_tender).length;
        results.push({
          file_id: fileId,
          file_name: file.file_name,
          status: 'success',
          source: extracted.source,
          confidence: extracted.confidence,
          item_count: extracted.items.length,
          tender_matched_count: tenderMatchedCount,
          items: extracted.items,
        });
      } catch (error) {
        results.push({ file_id: fileId, file_name: file.file_name, status: 'error', item_count: 0, tender_matched_count: 0, items: [], error: error.message || '目录提取失败' });
      }
      updateOutlineAnalysis({
        status: 'running',
        progress: bidFiles.length ? Math.round((results.length / bidFiles.length) * 80) : 80,
        extraction: { status: 'running', completed: results.length, total: bidFiles.length },
        files: results,
        tenderSentenceCount: tenderSentences.length,
        tenderMatchedItemCount: results.reduce((sum, item) => sum + (item.tender_matched_count || 0), 0),
        message: `目录提取 ${results.length}/${bidFiles.length}`,
      }, webContents, signature);
    }

    const comparison = buildOutlineComparison(results);
    const failed = results.some((item) => item.status === 'error');
    updateOutlineAnalysis({
      status: failed ? 'error' : 'success',
      progress: 100,
      message: failed ? '部分文件目录分析失败' : '目录分析完成',
      signature,
      extraction: { status: failed ? 'error' : 'success', completed: results.length, total: bidFiles.length },
      files: results,
      tenderSentenceCount: tenderSentences.length,
      tenderMatchedItemCount: results.reduce((sum, item) => sum + (item.tender_matched_count || 0), 0),
      duplicateGroups: comparison.duplicateGroups,
      pairwiseSimilarities: comparison.pairwiseSimilarities,
    }, webContents, signature);
    return results;
  }

  async function runContentDuplicateAnalysis(tenderFile, bidFiles, contentFiles, signature, webContents) {
    updateContentAnalysis({ status: 'running', progress: 5, extraction: { status: 'running', completed: 0, total: bidFiles.length }, message: '正在准备正文比对' }, webContents, signature);
    let tenderSentenceSet = new Set();
    if (tenderFile) {
      try {
        const tenderMarkdown = await readContentMarkdown(contentFiles, tenderFile);
        tenderSentenceSet = new Set(splitContentSentences(tenderMarkdown).map((item) => item.normalized));
      } catch (error) {
        updateContentAnalysis({ message: `招标文件句子白名单生成失败，继续比对投标正文：${error.message || error}` }, webContents, signature);
      }
    }

    const globalSentences = new Map();
    let totalSentenceCount = 0;
    let tenderMatchedSentenceCount = 0;
    let firstOrder = 0;

    for (const file of bidFiles) {
      const fileId = stableFileId(file);
      try {
        const markdown = await readContentMarkdown(contentFiles, file);
        const sentences = splitContentSentences(markdown);
        totalSentenceCount += sentences.length;
        const local = new Map();
        for (const sentence of sentences) {
          if (tenderSentenceSet.has(sentence.normalized)) {
            tenderMatchedSentenceCount += 1;
            continue;
          }
          const current = local.get(sentence.normalized) || { sentence: sentence.sentence, count: 0, order: firstOrder++ };
          current.count += 1;
          local.set(sentence.normalized, current);
        }

        for (const [normalized, item] of local.entries()) {
          const global = globalSentences.get(normalized) || { sentence: item.sentence, normalized, file_ids: [], occurrences: {}, first_order: item.order };
          if (!global.file_ids.includes(fileId)) global.file_ids.push(fileId);
          global.occurrences[fileId] = item.count;
          globalSentences.set(normalized, global);
        }
      } catch (error) {
        updateContentAnalysis({ message: `${file.file_name} 正文比对失败：${error.message || error}` }, webContents, signature);
      }

      updateContentAnalysis({
        status: 'running',
        progress: bidFiles.length ? Math.round((globalSentences.size ? 10 : 5) + (bidFiles.indexOf(file) + 1) / bidFiles.length * 80) : 85,
        tenderSentenceCount: tenderSentenceSet.size,
        tenderMatchedSentenceCount,
        totalSentenceCount,
        extraction: { status: 'running', completed: bidFiles.indexOf(file) + 1, total: bidFiles.length },
        message: `正文比对 ${bidFiles.indexOf(file) + 1}/${bidFiles.length}`,
      }, webContents, signature);
    }

    const duplicateSentences = buildDuplicateSentences(globalSentences);
    updateContentAnalysis({
      status: 'success',
      progress: 100,
      message: '正文比对完成',
      signature,
      tenderSentenceCount: tenderSentenceSet.size,
      tenderMatchedSentenceCount,
      totalSentenceCount,
      extraction: { status: 'success', completed: bidFiles.length, total: bidFiles.length },
      duplicateSentences,
    }, webContents, signature);
    return { status: 'success', duplicateSentences };
  }

  async function runImageDuplicateAnalysis(bidFiles, contentFiles, signature, webContents) {
    updateImageAnalysis({ status: 'running', progress: 5, extraction: { status: 'running', completed: 0, total: bidFiles.length }, message: '正在准备图片比对' }, webContents, signature);
    const results = [];
    const globalImages = new Map();
    let totalImageCount = 0;

    for (const file of bidFiles) {
      const fileId = stableFileId(file);
      try {
        const markdown = await readContentMarkdown(contentFiles, file);
        const targets = extractImageTargets(markdown);
        totalImageCount += targets.length;
        const local = new Map();
        for (const target of targets) {
          try {
            const buffer = await readImageTargetBuffer(app, target);
            if (!buffer?.length) continue;
            const hash = crypto.createHash('sha256').update(buffer).digest('hex');
            const current = local.get(hash) || { count: 0, preview_url: target };
            current.count += 1;
            local.set(hash, current);
          } catch {
            // Ignore individual unreadable images; other images in the same file can still be compared.
          }
        }

        for (const [hash, item] of local.entries()) {
          const global = globalImages.get(hash) || { hash, preview_url: item.preview_url, file_ids: [], occurrences: {} };
          if (!global.file_ids.includes(fileId)) global.file_ids.push(fileId);
          global.occurrences[fileId] = item.count;
          globalImages.set(hash, global);
        }
        results.push({ file_id: fileId, file_name: file.file_name, status: 'success', image_count: targets.length, unique_image_count: local.size });
      } catch (error) {
        results.push({ file_id: fileId, file_name: file.file_name, status: 'error', image_count: 0, unique_image_count: 0, error: error.message || '图片比对失败' });
      }

      updateImageAnalysis({
        status: 'running',
        progress: bidFiles.length ? Math.round((results.length / bidFiles.length) * 85) : 85,
        extraction: { status: 'running', completed: results.length, total: bidFiles.length },
        files: results,
        totalImageCount,
        message: `图片比对 ${results.length}/${bidFiles.length}`,
      }, webContents, signature);
    }

    const duplicateImages = buildDuplicateImages(globalImages);
    const failed = results.some((item) => item.status === 'error');
    updateImageAnalysis({
      status: failed ? 'error' : 'success',
      progress: 100,
      message: failed ? '部分文件图片比对失败' : '图片比对完成',
      signature,
      extraction: { status: failed ? 'error' : 'success', completed: results.length, total: bidFiles.length },
      files: results,
      totalImageCount,
      duplicateImages,
    }, webContents, signature);
    return { status: failed ? 'error' : 'success', duplicateImages };
  }

  async function run(signature, payload, webContents) {
    const tenderFile = payload.tenderFile || null;
    const bidFiles = Array.isArray(payload.bidFiles) ? payload.bidFiles : [];
    const allFiles = [tenderFile, ...bidFiles].filter(Boolean);

    try {
      const contentPromise = runContentExtraction(allFiles, webContents, signature);
      const metadataFiles = await runMetadataExtraction(bidFiles, webContents, signature);
      updateOutlineAnalysis({ status: 'running', progress: 1, message: '元数据提取完成，等待正文内容用于目录分析', extraction: { status: 'running', completed: 0, total: bidFiles.length } }, webContents, signature);
      updateContentAnalysis({ status: 'running', progress: 1, message: '元数据提取完成，等待正文内容用于正文比对', extraction: { status: 'running', completed: 0, total: bidFiles.length } }, webContents, signature);
      updateImageAnalysis({ status: 'running', progress: 1, message: '元数据提取完成，等待正文内容用于图片比对', extraction: { status: 'running', completed: 0, total: bidFiles.length } }, webContents, signature);
      const contentFiles = await contentPromise;
      const [outlineFiles, contentResult, imageResult] = await Promise.all([
        runOutlineAnalysis(tenderFile, bidFiles, contentFiles, signature, webContents),
        runContentDuplicateAnalysis(tenderFile, bidFiles, contentFiles, signature, webContents),
        runImageDuplicateAnalysis(bidFiles, contentFiles, signature, webContents),
      ]);
      const failed = contentFiles.some((item) => item.status === 'error')
        || metadataFiles.some((item) => item.status === 'error')
        || outlineFiles.some((item) => item.status === 'error')
        || contentResult.status === 'error'
        || imageResult.status === 'error';
      updateAnalysis({ status: failed ? 'error' : 'success', progress: 100, message: failed ? '部分文件分析失败' : '元数据分析完成' }, webContents, signature);
    } catch (error) {
      updateAnalysis({ status: 'error', progress: 100, message: error.message || '元数据分析失败' }, webContents, signature);
    } finally {
      running.delete(signature);
    }
  }

  return {
    startMetadataAnalysis(payload = {}, webContents) {
      const signature = createSignature(payload);
      const force = payload.force === true;
      const current = workspaceStore.loadDuplicateCheck() || {};
      if (!force
        && current.metadataAnalysis?.signature === signature && current.metadataAnalysis?.status === 'success'
        && current.outlineAnalysis?.signature === signature && current.outlineAnalysis?.status === 'success'
        && current.contentAnalysis?.signature === signature && current.contentAnalysis?.status === 'success'
        && current.imageAnalysis?.signature === signature && current.imageAnalysis?.status === 'success') {
        emit(webContents, current);
        return current.metadataAnalysis;
      }
      if (!force && running.has(signature)) {
        emit(webContents, current);
        return current.metadataAnalysis || { status: 'running', signature };
      }

      const bidFiles = Array.isArray(payload.bidFiles) ? payload.bidFiles : [];
      const metadataAnalysis = createInitialAnalysis(signature, bidFiles);
      const outlineAnalysis = createInitialOutlineAnalysis(signature, bidFiles);
      const contentAnalysis = createInitialContentAnalysis(signature, bidFiles);
      const imageAnalysis = createInitialImageAnalysis(signature, bidFiles);
      const next = workspaceStore.updateDuplicateCheck({ tenderFile: payload.tenderFile || null, bidFiles, metadataAnalysis, outlineAnalysis, contentAnalysis, imageAnalysis });
      emit(webContents, next);
      const promise = run(signature, payload, webContents);
      running.set(signature, promise);
      return metadataAnalysis;
    },
  };
}

module.exports = { createDuplicateCheckService };
