const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { dialog } = require('electron');
const { getKnowledgeBaseDir } = require('../utils/paths.cjs');
const { deleteImportedImageBatches } = require('../utils/importedImages.cjs');
const { parseDocumentWithConfig } = require('./fileService.cjs');

const supportedExtensions = new Set(['.doc', '.docx', '.wps', '.pdf', '.md', '.markdown']);
const oversizedBlockChars = 8000;
const semanticMergeTargetChars = 500;
const recoveryMaxAttempts = 2;

function now() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function safeName(name) {
  return String(name || '未命名').replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_').trim() || '未命名';
}

function createEmptyIndex() {
  return { folders: [], documents: [] };
}

function normalizeDocument(document) {
  const documentDir = document?.document_dir || path.join('folders', document?.folder_id || 'unknown', 'documents', document?.id || createId('doc')).replace(/\\/g, '/');
  return {
    ...document,
    document_dir: documentDir,
    source_path: document?.source_path || path.join(documentDir, 'source').replace(/\\/g, '/'),
    markdown_path: document?.markdown_path || path.join(documentDir, 'content.md').replace(/\\/g, '/'),
    blocks_path: document?.blocks_path || path.join(documentDir, 'blocks.json').replace(/\\/g, '/'),
    filtered_blocks_path: document?.filtered_blocks_path || path.join(documentDir, 'filtered_blocks.json').replace(/\\/g, '/'),
    candidate_items_path: document?.candidate_items_path || path.join(documentDir, 'candidate_items.json').replace(/\\/g, '/'),
    match_result_path: document?.match_result_path || path.join(documentDir, 'match_result.json').replace(/\\/g, '/'),
    report_path: document?.report_path || path.join(documentDir, 'report.json').replace(/\\/g, '/'),
    items_path: document?.items_path || path.join(documentDir, 'items.json').replace(/\\/g, '/'),
    item_count: Number(document?.item_count || 0),
    block_count: Number(document?.block_count || 0),
    filtered_block_count: Number(document?.filtered_block_count || 0),
    candidate_item_count: Number(document?.candidate_item_count || 0),
    discarded_block_count: Number(document?.discarded_block_count || 0),
    system_discarded_after_retry_count: Number(document?.system_discarded_after_retry_count || 0),
  };
}

function normalizeIndex(index) {
  return {
    folders: Array.isArray(index?.folders) ? index.folders : [],
    documents: Array.isArray(index?.documents) ? index.documents.map(normalizeDocument) : [],
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function getIndexPath(baseDir) {
  return path.join(baseDir, 'index.json');
}

function getDebugLogsDir(app) {
  return path.join(app.getPath('userData'), 'logs', 'knowledge-base');
}

function getDebugLogPath(app, documentId) {
  return path.join(getDebugLogsDir(app), `${safeName(documentId)}.jsonl`);
}

function fromRelative(baseDir, relativePath) {
  return path.join(baseDir, relativePath || '');
}

function getPromptSummary(messages) {
  return (messages || []).map((message, index) => ({
    index: index + 1,
    role: message.role,
    chars: String(message.content || '').length,
  }));
}

function getItemSample(items) {
  return (items || []).slice(0, 8).map((item) => ({
    id: item.id,
    title: item.title,
    summary_chars: String(item.summary || item.resume || '').length,
  }));
}

function getMatchSummary(matches) {
  return (matches || []).map((match) => ({
    id: match.id,
    range_count: match.ranges?.length || 0,
    block_count: match.block_ids?.length || 0,
  }));
}

function stripMarkdownFence(content) {
  return String(content || '').replace(/^```[\s\S]*?\n/, '').replace(/```$/g, '').trim();
}

function splitOversizedText(text, limit) {
  const parts = [];
  let buffer = '';
  const sentences = String(text || '').split(/(?<=[。！？!?；;])\s*/);
  for (const sentence of sentences) {
    if (!sentence) continue;
    if (buffer && buffer.length + sentence.length > limit) {
      parts.push(buffer.trim());
      buffer = '';
    }
    buffer += sentence;
  }
  if (buffer.trim()) {
    parts.push(buffer.trim());
  }
  return parts.length ? parts : [String(text || '')];
}

function normalizeRepeatedText(text) {
  return String(text || '')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, '')
    .replace(/[\-—_·.。:：|第页共]/g, '')
    .trim()
    .toLowerCase();
}

function isPageNumberBlock(text) {
  const normalized = String(text || '').trim();
  const compact = normalized.replace(/\s+/g, '');
  return /^[-—_]*\d+[-—_]*$/.test(compact)
    || /^第\d+页(共\d+页)?$/.test(compact)
    || /^\d+\/\d+$/.test(compact)
    || /^page\d+(of\d+)?$/i.test(compact);
}

function isCatalogBlock(text) {
  const normalized = String(text || '').trim();
  const compact = normalized.replace(/\s+/g, '');
  if (/^(#+)?(目录|目次|contents)$/i.test(compact)) {
    return true;
  }

  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) {
    return false;
  }

  const catalogLines = lines.filter((line) => /(?:\.{2,}|…{2,}|·{2,}|\s{4,})\s*\d+\s*$/.test(line));
  return catalogLines.length >= Math.ceil(lines.length * 0.6);
}

function isCoverBlock(text, index) {
  if (index > 12) {
    return false;
  }

  const normalized = String(text || '').trim();
  const compact = normalized.replace(/\s+/g, '');
  if (!compact || compact.length > 220) {
    return false;
  }

  const coverMarkers = ['投标文件', '投标书', '正本', '副本', '项目名称', '招标编号', '投标人', '编制日期', '日期：', '日期:'];
  const hasMarker = coverMarkers.some((marker) => compact.includes(marker));
  const hasLongSentence = /[。！？；]/.test(normalized) && normalized.length > 80;
  return hasMarker && !hasLongSentence;
}

function isSignatureBlock(text) {
  const normalized = String(text || '').trim();
  const compact = normalized.replace(/\s+/g, '');
  if (!compact || compact.length > 260) {
    return false;
  }
  if (/(签字确认|用户签字|双方责任人.{0,12}签字)/.test(compact)) {
    return false;
  }
  return /(盖章|签章|签名|法定代表人|授权代表|委托代理人|被授权人|年月日|投标人代表签字|代表签字)/.test(compact)
    && !/[。！？；].{20,}/.test(normalized);
}

function getContentCharCount(text) {
  return String(text || '').replace(/\s+/g, '').length;
}

function stripBoldMarker(text) {
  return String(text || '').trim().replace(/^\*\*(.+)\*\*$/, '$1').trim();
}

function isTableBlock(block) {
  return /^<table[\s>]/i.test(String(block?.content || '').trim());
}

function isSemanticHeadingBlock(block) {
  const original = String(block?.content || '').trim();
  const normalized = stripBoldMarker(original);
  const compactLength = getContentCharCount(normalized);
  if (!normalized || compactLength > 100) {
    return false;
  }
  if (/[。！？；;]$/.test(normalized)) {
    return false;
  }

  return /^\*\*.+\*\*$/.test(original)
    || /^\d+(?:\.\d+)+\s*[^。！？；;]{1,80}$/.test(normalized)
    || /^\d+\.\s*[^。！？；;]{1,80}$/.test(normalized)
    || /^[一二三四五六七八九十]+[、.．]\s*[^。！？；;]{1,80}$/.test(normalized)
    || /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳][、.．]?\s*[^。！？；;]{1,80}$/.test(normalized)
    || /^（[一二三四五六七八九十]+）\s*[^。！？；;]{1,80}$/.test(normalized)
    || /^第[一二三四五六七八九十\d]+[章节部分篇]\s*[^。！？；;]{0,80}$/.test(normalized);
}

function mergeSemanticBlocks(rawBlocks) {
  const merged = [];
  let buffer = [];

  function bufferText() {
    return buffer.map((block) => block.content).join('\n\n');
  }

  function bufferHasOnlyHeadings() {
    return buffer.length > 0 && buffer.every(isSemanticHeadingBlock);
  }

  function flushBuffer() {
    if (!buffer.length) {
      return;
    }

    merged.push({
      ...buffer[0],
      id: `R${String(merged.length + 1).padStart(6, '0')}`,
      type: buffer.some((block) => block.type === 'list') ? 'list' : 'paragraph',
      content: bufferText().trim(),
    });
    buffer = [];
  }

  function pushStandalone(block) {
    merged.push({
      ...block,
      id: `R${String(merged.length + 1).padStart(6, '0')}`,
    });
  }

  for (const block of rawBlocks) {
    if (isTableBlock(block)) {
      flushBuffer();
      pushStandalone(block);
      continue;
    }

    if (isSemanticHeadingBlock(block)) {
      if (buffer.length && !bufferHasOnlyHeadings() && getContentCharCount(bufferText()) >= 100) {
        flushBuffer();
      }
      buffer.push(block);
      continue;
    }

    const blockChars = getContentCharCount(block.content);
    if (!buffer.length && blockChars >= semanticMergeTargetChars) {
      pushStandalone(block);
      continue;
    }

    buffer.push(block);
    if (getContentCharCount(bufferText()) >= semanticMergeTargetChars) {
      flushBuffer();
    }
  }

  flushBuffer();
  return merged;
}

function createRawBlocks(markdown) {
  const blocks = [];
  const lines = String(markdown || '').split(/\r?\n/);
  let buffer = [];
  let currentType = 'paragraph';
  const headings = [];

  function pushBuffer() {
    const content = buffer.join('\n').trim();
    if (!content) {
      buffer = [];
      return;
    }

    const chunks = content.length > oversizedBlockChars ? splitOversizedText(content, Math.floor(oversizedBlockChars * 0.75)) : [content];
    for (const chunk of chunks) {
      blocks.push({
        id: `R${String(blocks.length + 1).padStart(6, '0')}`,
        type: currentType,
        heading_path: headings.filter(Boolean),
        content: chunk,
      });
    }
    buffer = [];
  }

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      pushBuffer();
      const level = headingMatch[1].length;
      headings.splice(level - 1);
      headings[level - 1] = headingMatch[2].trim();
      currentType = 'heading';
      buffer = [line];
      pushBuffer();
      currentType = 'paragraph';
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      pushBuffer();
      currentType = 'paragraph';
      continue;
    }

    const nextType = /^\s*\|.*\|\s*$/.test(line)
      ? 'table'
      : /^\s*(?:[-*+]\s+|\d+[.)、]\s+)/.test(line)
        ? 'list'
        : 'paragraph';
    if (buffer.length && currentType !== nextType && (currentType !== 'paragraph' || nextType !== 'paragraph')) {
      pushBuffer();
    }
    currentType = nextType;
    buffer.push(line);
  }

  pushBuffer();
  return blocks;
}

function filterBlocks(rawBlocks) {
  const repeatedCounts = new Map();
  rawBlocks.forEach((block) => {
    const key = normalizeRepeatedText(block.content);
    if (key && key.length <= 80) {
      repeatedCounts.set(key, (repeatedCounts.get(key) || 0) + 1);
    }
  });

  const kept = [];
  const filtered = [];

  rawBlocks.forEach((block, index) => {
    const repeatedKey = normalizeRepeatedText(block.content);
    const repeated = repeatedKey && repeatedKey.length <= 80 && repeatedCounts.get(repeatedKey) >= 3;
    const reason = !String(block.content || '').trim()
      ? 'empty'
      : isPageNumberBlock(block.content)
        ? 'page_number'
        : getContentCharCount(block.content) < 100
          ? 'too_short'
          : isCatalogBlock(block.content)
            ? 'catalog'
            : repeated
              ? 'repeated_header_footer'
              : isCoverBlock(block.content, index)
                ? 'cover'
                : isSignatureBlock(block.content)
                  ? 'signature_page'
                  : '';

    if (reason) {
      filtered.push({ ...block, reason });
      return;
    }

    kept.push({
      ...block,
      id: `P${String(kept.length + 1).padStart(6, '0')}`,
    });
  });

  return { blocks: kept, filtered_blocks: filtered };
}

function renderBlocksForPrompt(blocks) {
  return blocks.map((block) => {
    const headingPath = block.heading_path?.length ? block.heading_path.join(' > ') : '无';
    return [
      `[${block.id}]`,
      `type: ${block.type}`,
      `heading_path: ${headingPath}`,
      'text:',
      block.content,
    ].join('\n');
  }).join('\n\n');
}

function normalizeCandidateItems(parsed) {
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    title: String(item?.title || '').trim(),
    summary: String(item?.summary || item?.resume || '').trim(),
  })).filter((item) => item.title && item.summary);
}

function validateCandidateItems(value) {
  if (!Array.isArray(value?.items)) {
    throw new Error('AI 返回结果缺少 items 数组');
  }
}

function mergeCandidateItems(firstItems, supplementItems) {
  const merged = [];
  const seen = new Set();
  for (const item of [...firstItems, ...supplementItems]) {
    const key = item.title.replace(/\s+/g, '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({
      id: `K${String(merged.length + 1).padStart(6, '0')}`,
      title: item.title,
      summary: item.summary,
    });
  }
  return merged;
}

function buildDocumentBlocksUserMessage(blockText) {
  return {
    role: 'user',
    content: [
      '以下是同一份文档的完整 block 列表。',
      '<document_blocks>',
      blockText,
      '</document_blocks>',
    ].join('\n'),
  };
}

function buildInitialItemMessages(documentName, blockText) {
  return [
    buildDocumentBlocksUserMessage(blockText),
    {
      role: 'user',
      content: [
        `文档名：${documentName}`,
        '你是投标资料知识库分析助手。你只负责从历史投标资料中提取对后续编写标书有复用价值的知识条目。',
        '任务：请从全文中提取有意义的知识条目数组。条目应覆盖技术方案、项目管理、质量、安全、进度、服务、应急、人员设备、类似业绩等可复用内容。',
        '只返回 JSON：{"items":[{"title":"","summary":""}]}',
        '要求：title 简洁明确；summary 说明该条目可如何用于编写投标文件；不要输出 id、content、段落编号、Markdown 或解释文字。',
      ].join('\n'),
    },
  ];
}

function buildSupplementItemMessages(documentName, blockText, firstItems) {
  return [
    buildDocumentBlocksUserMessage(blockText),
    {
      role: 'user',
      content: [
        `文档名：${documentName}`,
        '你是投标资料知识库补漏助手。你只判断已有知识条目是否遗漏了重要主题，并补充缺失条目。',
        '任务：请检查第一轮条目是否遗漏了有复用价值的重要内容。如果有遗漏，只输出新增条目；如果没有遗漏，返回空 items 数组。',
        '只返回 JSON：{"items":[{"title":"","summary":""}]}',
        '如果没有新增条目，必须返回 {"items":[]}，这属于正常结果。',
        '不要重复已有条目，不要输出 id、content、段落编号、Markdown 或解释文字。',
        '',
        '<first_round_items>',
        JSON.stringify(firstItems.map(({ title, summary }) => ({ title, summary })), null, 2),
        '</first_round_items>',
      ].join('\n'),
    },
  ];
}

function buildMatchMessages(documentName, blockText, batchItems) {
  const taskPrompt = [
    `文档名：${documentName}`,
    '你是投标知识库段落匹配助手。你只根据知识条目的标题和摘要，为其匹配强相关 block 范围。',
    '你将收到同一份文档的完整 block 列表，以及本次需要匹配的一小批知识条目。',
    '规则：',
    '1. 只处理本次给出的知识条目。',
    '2. 只匹配与条目强相关、可直接支撑该条目的 block。',
    '3. 如果某些 block 更可能属于其他未提供的条目，不要强行匹配。',
    '4. 只返回 id 和 ranges，不要输出正文，不要解释。',
    '5. ranges 使用闭区间：["P000001","P000003"] 表示连续 block；单个 block 写成 ["P000001","P000001"]。',
    '6. 只允许使用输入中存在的 block 编号和本批条目 id。',
    '输出 JSON：{"matches":[{"id":"K000001","ranges":[["P000001","P000003"]]}]}',
    '',
    '以下是本次需要匹配的知识条目。只处理这些条目：',
    JSON.stringify(batchItems.map(({ id, title, summary }) => ({ id, title, summary })), null, 2),
  ].join('\n');

  return [
    buildDocumentBlocksUserMessage(blockText),
    {
      role: 'user',
      content: taskPrompt,
    },
  ];
}

function buildRecoveryMessages(documentName, items, missingBlocks) {
  return [
    {
      role: 'user',
      content: [
        '以下是当前尚未处理的遗漏 block。',
        '<missing_blocks>',
        renderBlocksForPrompt(missingBlocks),
        '</missing_blocks>',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `文档名：${documentName}`,
        '你是投标知识库遗漏段落补漏助手。必须把所有收到的遗漏 block 明确归入已有条目、新增条目或舍弃段落。',
        '任务：必须覆盖所有遗漏 block。每个遗漏 block 只能进入以下三类之一：',
        '1. matches：归入已有知识条目，只返回已有 id 和 ranges。',
        '2. new_items：如果没有合适的已有条目但内容有复用价值，则新增知识条目，并给出 title、summary、ranges。',
        '3. discarded：如果内容质量低、重复、格式残留或无投标复用价值，则推荐舍弃，并给出 reason。',
        '输出 JSON：{"matches":[{"id":"K000001","ranges":[["P000001","P000003"]]}],"new_items":[{"title":"","summary":"","ranges":[["P000004","P000005"]]}],"discarded":[{"ranges":[["P000006","P000006"]],"reason":""}]}',
        '不要输出正文、Markdown 或解释文字。',
        '',
        '<knowledge_items>',
        JSON.stringify(items.map(({ id, title, summary }) => ({ id, title, summary })), null, 2),
        '</knowledge_items>',
      ].join('\n'),
    },
  ];
}

function getBlockOrder(blocks) {
  return new Map(blocks.map((block, index) => [block.id, index]));
}

function normalizeRangePair(range) {
  if (Array.isArray(range)) {
    const start = String(range[0] || '').trim();
    const end = String(range[1] || range[0] || '').trim();
    return start ? [start, end] : null;
  }

  const id = String(range || '').trim();
  return id ? [id, id] : null;
}

function normalizeRanges(ranges, blockOrder) {
  if (!Array.isArray(ranges)) return [];
  const normalized = [];
  for (const range of ranges) {
    const pair = normalizeRangePair(range);
    if (!pair) continue;
    let [start, end] = pair;
    if (!blockOrder.has(start) || !blockOrder.has(end)) continue;
    if (blockOrder.get(start) > blockOrder.get(end)) {
      [start, end] = [end, start];
    }
    normalized.push([start, end]);
  }
  return normalized;
}

function expandRanges(ranges, blocks, blockOrder) {
  const ids = [];
  for (const [start, end] of ranges) {
    const startIndex = blockOrder.get(start);
    const endIndex = blockOrder.get(end);
    if (startIndex === undefined || endIndex === undefined) continue;
    for (let index = startIndex; index <= endIndex; index += 1) {
      ids.push(blocks[index].id);
    }
  }
  return [...new Set(ids)];
}

function normalizeMatchResult(parsed, itemIds, blocks, blockOrder) {
  const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];
  return {
    matches: matches.map((match) => {
      const id = String(match?.id || '').trim();
      const ranges = normalizeRanges(match?.ranges || match?.paragraph_ranges || match?.block_ranges || [], blockOrder);
      return itemIds.has(id) && ranges.length ? { id, ranges, block_ids: expandRanges(ranges, blocks, blockOrder) } : null;
    }).filter(Boolean),
  };
}

function validateMatchResult(value) {
  if (!Array.isArray(value?.matches)) {
    throw new Error('AI 返回结果缺少 matches 数组');
  }
}

function normalizeRecoveryResult(parsed, itemIds, blocks, blockOrder) {
  const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];
  const newItems = Array.isArray(parsed?.new_items) ? parsed.new_items : [];
  const discarded = Array.isArray(parsed?.discarded) ? parsed.discarded : [];

  return {
    matches: matches.map((match) => {
      const id = String(match?.id || '').trim();
      const ranges = normalizeRanges(match?.ranges || [], blockOrder);
      return itemIds.has(id) && ranges.length ? { id, ranges, block_ids: expandRanges(ranges, blocks, blockOrder) } : null;
    }).filter(Boolean),
    new_items: newItems.map((item) => {
      const title = String(item?.title || '').trim();
      const summary = String(item?.summary || item?.resume || '').trim();
      const ranges = normalizeRanges(item?.ranges || [], blockOrder);
      return title && summary && ranges.length ? { title, summary, ranges, block_ids: expandRanges(ranges, blocks, blockOrder) } : null;
    }).filter(Boolean),
    discarded: discarded.map((item) => {
      const ranges = normalizeRanges(item?.ranges || [], blockOrder);
      return ranges.length ? {
        ranges,
        block_ids: expandRanges(ranges, blocks, blockOrder),
        reason: String(item?.reason || 'AI 建议舍弃').trim() || 'AI 建议舍弃',
      } : null;
    }).filter(Boolean),
  };
}

function validateRecoveryResult(value) {
  if (!Array.isArray(value?.matches) || !Array.isArray(value?.new_items) || !Array.isArray(value?.discarded)) {
    throw new Error('AI 返回结果缺少 matches/new_items/discarded 数组');
  }
}

function collectHandledBlockIds(matches, discarded, systemDiscarded) {
  const handled = new Set();
  matches.forEach((match) => match.block_ids.forEach((id) => handled.add(id)));
  discarded.forEach((item) => item.block_ids.forEach((id) => handled.add(id)));
  systemDiscarded.forEach((item) => item.block_ids.forEach((id) => handled.add(id)));
  return handled;
}

function getMissingBlocks(blocks, matches, discarded, systemDiscarded) {
  const handled = collectHandledBlockIds(matches, discarded, systemDiscarded);
  return blocks.filter((block) => !handled.has(block.id));
}

function nextKnowledgeItemId(items) {
  let max = 0;
  items.forEach((item) => {
    const match = /^K(\d+)$/.exec(item.id || '');
    if (match) max = Math.max(max, Number(match[1]));
  });
  return `K${String(max + 1).padStart(6, '0')}`;
}

function createFinalItems(items, matches, blocks, fileName) {
  const blockMap = new Map(blocks.map((block) => [block.id, block]));
  const blocksByItem = new Map();
  matches.forEach((match) => {
    const current = blocksByItem.get(match.id) || [];
    blocksByItem.set(match.id, [...new Set([...current, ...match.block_ids])]);
  });

  return items.map((item) => {
    const sourceBlockIds = blocksByItem.get(item.id) || [];
    const content = sourceBlockIds.map((id) => blockMap.get(id)?.content || '').filter(Boolean).join('\n\n').trim();
    return {
      id: item.id,
      title: item.title,
      resume: item.summary,
      content,
      source_block_ids: sourceBlockIds,
      source_file: fileName,
    };
  }).filter((item) => item.content);
}

function sumContentChars(items) {
  return items.reduce((sum, item) => sum + getContentCharCount(item.content), 0);
}

function countCoveredUniqueBlockChars(items, blocks) {
  const blockMap = new Map(blocks.map((block) => [block.id, block]));
  const covered = new Set();
  items.forEach((item) => {
    if (!Array.isArray(item?.source_block_ids)) return;
    item.source_block_ids.forEach((id) => covered.add(String(id)));
  });
  return Array.from(covered).reduce((sum, id) => sum + getContentCharCount(blockMap.get(id)?.content || ''), 0);
}

function createReport({ blocks, filteredBlocks, candidateItems, finalItems, matches, discarded, systemDiscarded, recoveryAttempts, batchSize }) {
  const matched = new Set();
  matches.forEach((match) => match.block_ids.forEach((id) => matched.add(id)));
  const discardedSet = new Set();
  discarded.forEach((item) => item.block_ids.forEach((id) => discardedSet.add(id)));
  const systemSet = new Set();
  systemDiscarded.forEach((item) => item.block_ids.forEach((id) => systemSet.add(id)));
  const handled = new Set([...matched, ...discardedSet, ...systemSet]);
  const total = blocks.length || 1;

  return {
    total_blocks: blocks.length,
    filtered_blocks_count: filteredBlocks.length,
    candidate_items_count: candidateItems.length,
    final_items_count: finalItems.length,
    matched_blocks_count: matched.size,
    discarded_blocks_count: discardedSet.size,
    system_discarded_after_retry_count: systemSet.size,
    new_items_from_recovery_count: recoveryAttempts.reduce((sum, attempt) => sum + attempt.new_items.length, 0),
    recovery_attempt_count: recoveryAttempts.length,
    batch_size: batchSize,
    coverage_rate: Number((handled.size / total).toFixed(4)),
    matched_rate: Number((matched.size / total).toFixed(4)),
    created_at: now(),
  };
}

function createKnowledgeBaseService({ app, aiService, configStore }) {
  const baseDir = getKnowledgeBaseDir(app);
  const indexPath = getIndexPath(baseDir);
  const activePreparations = new Set();
  const activeMatches = new Set();

  function isDeveloperMode() {
    try {
      return Boolean(configStore?.load()?.developer_mode);
    } catch {
      return false;
    }
  }

  function debugLog(documentId, event, payload = {}) {
    if (!isDeveloperMode()) {
      return;
    }

    try {
      const logPath = getDebugLogPath(app, documentId || 'unknown');
      ensureDir(path.dirname(logPath));
      const entry = {
        time: now(),
        event,
        ...payload,
      };
      fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf-8');
      console.info(`[knowledge-base] ${event}`, entry);
    } catch (error) {
      console.warn('[knowledge-base] 写入调试日志失败', error);
    }
  }

  function loadIndex() {
    ensureDir(baseDir);
    return normalizeIndex(readJson(indexPath, createEmptyIndex()));
  }

  function saveIndex(index) {
    writeJson(indexPath, normalizeIndex(index));
    return normalizeIndex(index);
  }

  function emitProgress(webContents, document) {
    if (!webContents?.isDestroyed()) {
      webContents.send('knowledge-base:event', { document });
    }
  }

  function updateDocument(documentId, partial, webContents) {
    const index = loadIndex();
    const documents = index.documents.map((document) => (
      document.id === documentId ? normalizeDocument({ ...document, ...partial, updated_at: now() }) : document
    ));
    const next = saveIndex({ ...index, documents });
    const document = next.documents.find((item) => item.id === documentId);
    if (document) emitProgress(webContents, document);
    debugLog(documentId, 'document:update', {
      status: partial.status,
      progress: partial.progress,
      message: partial.message,
      error: partial.error,
      candidate_item_count: partial.candidate_item_count,
      item_count: partial.item_count,
      block_count: partial.block_count,
      filtered_block_count: partial.filtered_block_count,
    });
    return document;
  }

  function getDocument(documentId) {
    const index = loadIndex();
    const document = index.documents.find((item) => item.id === documentId);
    if (!document) throw new Error('知识库文档不存在');
    return document;
  }

  async function prepareDocument(documentId, sourceFilePath, webContents) {
    if (activePreparations.has(documentId)) {
      debugLog(documentId, 'prepare:skip-active');
      return;
    }
    activePreparations.add(documentId);
    debugLog(documentId, 'prepare:start', { source_file_path: sourceFilePath });

    try {
      const document = getDocument(documentId);
      const config = configStore ? configStore.load() : { file_parser: { provider: 'local', preserve_images: true } };
      const documentDir = fromRelative(baseDir, document.document_dir);
      const sourcePath = fromRelative(baseDir, document.source_path);
      const markdownPath = fromRelative(baseDir, document.markdown_path);
      const blocksPath = fromRelative(baseDir, document.blocks_path);
      const filteredBlocksPath = fromRelative(baseDir, document.filtered_blocks_path);
      const candidateItemsPath = fromRelative(baseDir, document.candidate_items_path);

      updateDocument(documentId, { status: 'copying', progress: 5, message: '正在复制原始文件' }, webContents);
      ensureDir(documentDir);
      await fsp.copyFile(sourceFilePath, sourcePath);
      debugLog(documentId, 'prepare:copied-source', { source_path: sourcePath });

      updateDocument(documentId, { status: 'converting', progress: 15, message: '正在转换为 Markdown' }, webContents);
      const markdown = stripMarkdownFence((await parseDocumentWithConfig(app, sourcePath, config, { assetScope: `knowledge-${documentId}` })).trim());
      if (!markdown) throw new Error('文档未解析出有效 Markdown 内容');
      await fsp.writeFile(markdownPath, `${markdown}\n`, 'utf-8');
      debugLog(documentId, 'prepare:converted-markdown', { markdown_path: markdownPath, markdown_chars: markdown.length });

      const rawBlocks = createRawBlocks(markdown);
      const semanticBlocks = mergeSemanticBlocks(rawBlocks);
      const { blocks, filtered_blocks: filteredBlocks } = filterBlocks(semanticBlocks);
      if (!blocks.length) throw new Error('筛选后没有可分析的正文内容');
      writeJson(blocksPath, blocks);
      writeJson(filteredBlocksPath, filteredBlocks);
      debugLog(documentId, 'prepare:blocks-ready', {
        raw_block_count: rawBlocks.length,
        semantic_block_count: semanticBlocks.length,
        block_count: blocks.length,
        filtered_block_count: filteredBlocks.length,
        block_text_chars: renderBlocksForPrompt(blocks).length,
        filtered_reasons: filteredBlocks.reduce((acc, block) => {
          acc[block.reason] = (acc[block.reason] || 0) + 1;
          return acc;
        }, {}),
      });

      const blockText = renderBlocksForPrompt(blocks);
      updateDocument(documentId, {
        status: 'extracting',
        progress: 35,
        message: 'AI 正在首次提取知识条目',
        block_count: blocks.length,
        filtered_block_count: filteredBlocks.length,
      }, webContents);
      const firstMessages = buildInitialItemMessages(document.file_name, blockText);
      debugLog(documentId, 'ai:first-items:start', {
        prompt: getPromptSummary(firstMessages),
      });
      const first = await aiService.collectJsonResponse({
        messages: firstMessages,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        normalizer: (value) => ({ items: normalizeCandidateItems(value) }),
        validator: validateCandidateItems,
        failureMessage: '知识库条目提取失败，AI 未返回有效 JSON',
        progressLabel: '知识库条目提取',
      });
      const firstItems = Array.isArray(first?.items) ? first.items : [];
      debugLog(documentId, 'ai:first-items:done', {
        item_count: firstItems.length,
        sample: getItemSample(firstItems),
      });

      updateDocument(documentId, { status: 'extracting', progress: 55, message: 'AI 正在补充遗漏知识条目' }, webContents);
      const supplementMessages = buildSupplementItemMessages(document.file_name, blockText, firstItems);
      debugLog(documentId, 'ai:supplement-items:start', {
        first_item_count: firstItems.length,
        prompt: getPromptSummary(supplementMessages),
      });
      const supplement = await aiService.collectJsonResponse({
        messages: supplementMessages,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        normalizer: (value) => ({ items: normalizeCandidateItems(value) }),
        validator: validateCandidateItems,
        failureMessage: '知识库条目补充失败，AI 未返回有效 JSON',
        progressLabel: '知识库条目补充',
      });
      const supplementItems = Array.isArray(supplement?.items) ? supplement.items : [];
      debugLog(documentId, 'ai:supplement-items:done', {
        item_count: supplementItems.length,
        sample: getItemSample(supplementItems),
      });

      const candidateItems = mergeCandidateItems(firstItems, supplementItems);
      if (!candidateItems.length) throw new Error('AI 未提取出可用知识条目');
      writeJson(candidateItemsPath, candidateItems);
      debugLog(documentId, 'prepare:candidates-saved', {
        candidate_item_count: candidateItems.length,
        candidate_items_path: candidateItemsPath,
        sample: getItemSample(candidateItems),
      });
      updateDocument(documentId, {
        status: 'ready_for_matching',
        progress: 65,
        message: `已提取 ${candidateItems.length} 条候选知识，请设置批次开始匹配`,
        candidate_item_count: candidateItems.length,
        item_count: 0,
      }, webContents);

      if (!isDeveloperMode()) {
        debugLog(documentId, 'prepare:auto-match', { batch_size: 20 });
        await matchDocument(documentId, 20, webContents);
      }
    } catch (error) {
      debugLog(documentId, 'prepare:error', {
        message: error.message || String(error),
        stack: error.stack,
      });
      updateDocument(documentId, { status: 'error', progress: 100, message: error.message || '处理失败', error: error.message || '处理失败' }, webContents);
    } finally {
      activePreparations.delete(documentId);
      debugLog(documentId, 'prepare:finish');
    }
  }

  async function matchDocument(documentId, batchSize, webContents) {
    if (activeMatches.has(documentId)) {
      debugLog(documentId, 'match:skip-active');
      return;
    }
    activeMatches.add(documentId);
    debugLog(documentId, 'match:start', { requested_batch_size: batchSize });

    try {
      const document = getDocument(documentId);
      const normalizedBatchSize = Math.max(1, Math.min(100, Math.floor(Number(batchSize) || 1)));
      const blocks = readJson(fromRelative(baseDir, document.blocks_path), []);
      const filteredBlocks = readJson(fromRelative(baseDir, document.filtered_blocks_path), []);
      const initialItems = readJson(fromRelative(baseDir, document.candidate_items_path), []);
      if (!blocks.length) throw new Error('缺少正文 block，请重新上传文档');
      if (!initialItems.length) throw new Error('缺少候选知识条目，请等待条目提取完成');
      debugLog(documentId, 'match:inputs-ready', {
        block_count: blocks.length,
        filtered_block_count: filteredBlocks.length,
        initial_item_count: initialItems.length,
        normalized_batch_size: normalizedBatchSize,
      });

      const blockText = renderBlocksForPrompt(blocks);
      const blockOrder = getBlockOrder(blocks);
      const itemIds = new Set(initialItems.map((item) => item.id));
      const batches = [];
      for (let index = 0; index < initialItems.length; index += normalizedBatchSize) {
        batches.push(initialItems.slice(index, index + normalizedBatchSize));
      }

      const matches = [];
      const matchBatches = [];
      updateDocument(documentId, { status: 'matching', progress: 66, message: `开始匹配段落，共 ${batches.length} 批`, last_batch_size: normalizedBatchSize }, webContents);
      for (let index = 0; index < batches.length; index += 1) {
        const progress = Math.min(88, 66 + Math.round(((index + 1) / batches.length) * 22));
        updateDocument(documentId, { status: 'matching', progress, message: `AI 正在匹配段落 ${index + 1}/${batches.length}` }, webContents);
        const matchMessages = buildMatchMessages(document.file_name, blockText, batches[index]);
        debugLog(documentId, 'ai:match-batch:start', {
          batch_index: index + 1,
          batch_count: batches.length,
          item_ids: batches[index].map((item) => item.id),
          prompt: getPromptSummary(matchMessages),
        });
        const parsed = await aiService.collectJsonResponse({
          messages: matchMessages,
          temperature: 0.1,
          response_format: { type: 'json_object' },
          normalizer: (value) => normalizeMatchResult(value, itemIds, blocks, blockOrder),
          validator: validateMatchResult,
          failureMessage: '知识库段落匹配失败，AI 未返回有效 JSON',
          progressLabel: '知识库段落匹配',
        });
        debugLog(documentId, 'ai:match-batch:done', {
          batch_index: index + 1,
          match_count: parsed.matches.length,
          matches: getMatchSummary(parsed.matches),
        });
        const batchResult = { batch_index: index + 1, item_ids: batches[index].map((item) => item.id), matches: parsed.matches };
        matchBatches.push(batchResult);
        matches.push(...parsed.matches);
      }

      const items = [...initialItems];
      const discarded = [];
      const systemDiscarded = [];
      const recoveryAttempts = [];

      for (let attempt = 0; attempt < recoveryMaxAttempts; attempt += 1) {
        const missingBlocks = getMissingBlocks(blocks, matches, discarded, systemDiscarded);
        debugLog(documentId, 'recovery:missing-check', {
          attempt: attempt + 1,
          missing_block_count: missingBlocks.length,
        });
        if (!missingBlocks.length) break;

        updateDocument(documentId, {
          status: 'recovering',
          progress: Math.min(96, 90 + attempt * 3),
          message: `AI 正在补漏遗漏段落 ${attempt + 1}/${recoveryMaxAttempts}，剩余 ${missingBlocks.length} 个 block`,
        }, webContents);
        const currentItemIds = new Set(items.map((item) => item.id));
        const recoveryMessages = buildRecoveryMessages(document.file_name, items, missingBlocks);
        debugLog(documentId, 'ai:recovery:start', {
          attempt: attempt + 1,
          missing_block_count: missingBlocks.length,
          item_count: items.length,
          prompt: getPromptSummary(recoveryMessages),
        });
        const parsed = await aiService.collectJsonResponse({
          messages: recoveryMessages,
          temperature: 0.1,
          response_format: { type: 'json_object' },
          normalizer: (value) => normalizeRecoveryResult(value, currentItemIds, blocks, blockOrder),
          validator: validateRecoveryResult,
          failureMessage: '知识库遗漏段落补漏失败，AI 未返回有效 JSON',
          progressLabel: '知识库遗漏补漏',
        });
        debugLog(documentId, 'ai:recovery:done', {
          attempt: attempt + 1,
          match_count: parsed.matches.length,
          new_item_count: parsed.new_items.length,
          discarded_group_count: parsed.discarded.length,
          matches: getMatchSummary(parsed.matches),
        });

        const newItemsWithIds = parsed.new_items.map((item) => {
          const id = nextKnowledgeItemId(items);
          const next = { id, title: item.title, summary: item.summary };
          items.push(next);
          matches.push({ id, ranges: item.ranges, block_ids: item.block_ids });
          return { ...next, ranges: item.ranges, block_ids: item.block_ids };
        });
        matches.push(...parsed.matches);
        discarded.push(...parsed.discarded.map((item) => ({ ...item, source: `recovery_${attempt + 1}` })));
        recoveryAttempts.push({
          attempt: attempt + 1,
          missing_before_count: missingBlocks.length,
          matches: parsed.matches,
          new_items: newItemsWithIds,
          discarded: parsed.discarded,
        });
      }

      const remaining = getMissingBlocks(blocks, matches, discarded, systemDiscarded);
      debugLog(documentId, 'match:remaining-after-recovery', { remaining_block_count: remaining.length });
      if (remaining.length) {
        systemDiscarded.push({
          block_ids: remaining.map((block) => block.id),
          reason: 'system_discarded_after_retry',
        });
      }

      updateDocument(documentId, { status: 'saving', progress: 98, message: '正在回填正文并保存知识条目' }, webContents);
      const finalItems = createFinalItems(items, matches, blocks, document.file_name);
      const report = createReport({
        blocks,
        filteredBlocks,
        candidateItems: items,
        finalItems,
        matches,
        discarded,
        systemDiscarded,
        recoveryAttempts,
        batchSize: normalizedBatchSize,
      });
      const matchResult = {
        candidate_items: items,
        match_batches: matchBatches,
        recovery_attempts: recoveryAttempts,
        final_matches: matches,
        discarded,
        system_discarded_after_retry: systemDiscarded,
        report,
      };

      writeJson(fromRelative(baseDir, document.candidate_items_path), items);
      writeJson(fromRelative(baseDir, document.match_result_path), matchResult);
      writeJson(fromRelative(baseDir, document.report_path), report);
      writeJson(fromRelative(baseDir, document.items_path), finalItems);
      debugLog(documentId, 'match:saved', {
        final_item_count: finalItems.length,
        report,
        items_path: fromRelative(baseDir, document.items_path),
        report_path: fromRelative(baseDir, document.report_path),
        match_result_path: fromRelative(baseDir, document.match_result_path),
      });
      updateDocument(documentId, {
        status: 'success',
        progress: 100,
        message: `整理完成，共 ${finalItems.length} 条，覆盖率 ${Math.round(report.coverage_rate * 100)}%`,
        item_count: finalItems.length,
        candidate_item_count: items.length,
        discarded_block_count: report.discarded_blocks_count,
        system_discarded_after_retry_count: report.system_discarded_after_retry_count,
      }, webContents);
    } catch (error) {
      debugLog(documentId, 'match:error', {
        message: error.message || String(error),
        stack: error.stack,
      });
      updateDocument(documentId, { status: 'error', progress: 100, message: error.message || '匹配失败', error: error.message || '匹配失败' }, webContents);
    } finally {
      activeMatches.delete(documentId);
      debugLog(documentId, 'match:finish');
    }
  }

  return {
    list() {
      return loadIndex();
    },

    createFolder(name) {
      const index = loadIndex();
      const folder = { id: createId('folder'), name: safeName(name), created_at: now(), updated_at: now() };
      saveIndex({ ...index, folders: [...index.folders, folder] });
      return folder;
    },

    renameFolder(folderId, name) {
      const nextName = safeName(name);
      const index = loadIndex();
      const folder = index.folders.find((item) => item.id === folderId);
      if (!folder) throw new Error('知识库文件夹不存在');

      const folders = index.folders.map((item) => (
        item.id === folderId ? { ...item, name: nextName, updated_at: now() } : item
      ));
      saveIndex({ ...index, folders });
      return folders.find((item) => item.id === folderId);
    },

    deleteFolder(folderId) {
      const index = loadIndex();
      const folder = index.folders.find((item) => item.id === folderId);
      if (!folder) throw new Error('知识库文件夹不存在');

      const documentsToDelete = index.documents.filter((document) => document.folder_id === folderId);
      const runningDocument = documentsToDelete.find((document) => activePreparations.has(document.id) || activeMatches.has(document.id));
      if (runningDocument) {
        throw new Error(`文档“${runningDocument.file_name}”正在处理中，请完成后再删除文件夹`);
      }

      for (const document of documentsToDelete) {
        deleteImportedImageBatches(app, `knowledge-${document.id}`);
        fs.rmSync(fromRelative(baseDir, document.document_dir), { recursive: true, force: true });
        fs.rmSync(getDebugLogPath(app, document.id), { force: true });
      }
      fs.rmSync(fromRelative(baseDir, path.join('folders', folderId)), { recursive: true, force: true });
      saveIndex({
        folders: index.folders.filter((item) => item.id !== folderId),
        documents: index.documents.filter((document) => document.folder_id !== folderId),
      });
      return { success: true, message: `已删除文件夹“${folder.name}”及 ${documentsToDelete.length} 个文档` };
    },

    deleteDocument(documentId) {
      const index = loadIndex();
      const document = index.documents.find((item) => item.id === documentId);
      if (!document) throw new Error('知识库文档不存在');
      if (activePreparations.has(documentId) || activeMatches.has(documentId)) {
        throw new Error('该文档正在处理中，请完成后再删除');
      }

      deleteImportedImageBatches(app, `knowledge-${documentId}`);
      fs.rmSync(fromRelative(baseDir, document.document_dir), { recursive: true, force: true });
      fs.rmSync(getDebugLogPath(app, documentId), { force: true });
      saveIndex({ ...index, documents: index.documents.filter((item) => item.id !== documentId) });
      return { success: true, message: `已删除文档“${document.file_name}”` };
    },

    async uploadDocuments(folderId, webContents) {
      const currentIndex = loadIndex();
      const folder = currentIndex.folders.find((item) => item.id === folderId);
      if (!folder) throw new Error('请先选择知识库文件夹');

      const result = await dialog.showOpenDialog({
        title: '选择知识库文档',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '知识库文档', extensions: ['doc', 'docx', 'wps', 'pdf', 'md', 'markdown'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePaths.length) {
        return { success: false, message: '已取消选择' };
      }

      const created = [];
      let index = loadIndex();
      for (const filePath of result.filePaths) {
        const ext = path.extname(filePath).toLowerCase();
        if (!supportedExtensions.has(ext)) continue;
        const documentId = createId('doc');
        const documentDir = path.join('folders', folderId, 'documents', documentId).replace(/\\/g, '/');
        const sourceName = `source${ext}`;
        const document = normalizeDocument({
          id: documentId,
          folder_id: folderId,
          file_name: path.basename(filePath),
          document_dir: documentDir,
          source_path: path.join(documentDir, sourceName).replace(/\\/g, '/'),
          markdown_path: path.join(documentDir, 'content.md').replace(/\\/g, '/'),
          blocks_path: path.join(documentDir, 'blocks.json').replace(/\\/g, '/'),
          filtered_blocks_path: path.join(documentDir, 'filtered_blocks.json').replace(/\\/g, '/'),
          candidate_items_path: path.join(documentDir, 'candidate_items.json').replace(/\\/g, '/'),
          match_result_path: path.join(documentDir, 'match_result.json').replace(/\\/g, '/'),
          report_path: path.join(documentDir, 'report.json').replace(/\\/g, '/'),
          items_path: path.join(documentDir, 'items.json').replace(/\\/g, '/'),
          status: 'pending',
          progress: 0,
          message: '等待处理',
          item_count: 0,
          block_count: 0,
          filtered_block_count: 0,
          candidate_item_count: 0,
          discarded_block_count: 0,
          system_discarded_after_retry_count: 0,
          created_at: now(),
          updated_at: now(),
        });
        index = saveIndex({ ...index, documents: [...index.documents, document] });
        created.push(document);
        emitProgress(webContents, document);
        prepareDocument(documentId, filePath, webContents);
      }

      return { success: Boolean(created.length), message: created.length ? `已加入 ${created.length} 个文档处理任务` : '未选择支持的文档类型', documents: created };
    },

    startMatching(documentId, batchSize, webContents) {
      const document = getDocument(documentId);
      debugLog(documentId, 'ipc:start-matching', { batch_size: batchSize, current_status: document.status });
      if (activeMatches.has(documentId)) {
        return { success: false, message: '该文档正在匹配中', document };
      }
      if (!['ready_for_matching', 'success', 'error'].includes(document.status)) {
        return { success: false, message: '请等待候选知识条目提取完成', document };
      }
      matchDocument(documentId, batchSize, webContents);
      return { success: true, message: '已开始分批匹配段落', document };
    },

    getOutlineReferences(documentIds) {
      const ids = Array.isArray(documentIds) ? documentIds.map((id) => String(id || '').trim()).filter(Boolean) : [];
      if (!ids.length) {
        return { items: [] };
      }

      const index = loadIndex();
      const seen = new Set();
      const items = [];
      ids.forEach((documentId) => {
        const document = index.documents.find((item) => item.id === documentId);
        if (!document || document.status !== 'success') {
          return;
        }

        let documentItems = [];
        try {
          documentItems = readJson(fromRelative(baseDir, document.items_path), []);
        } catch (error) {
          console.warn('[knowledge-base] 读取知识库目录引用失败', { documentId, message: error.message || String(error) });
          return;
        }

        (Array.isArray(documentItems) ? documentItems : []).forEach((item) => {
          const itemId = String(item?.id || '').trim();
          const title = String(item?.title || '').trim();
          const resume = String(item?.resume || item?.summary || '').trim();
          if (!itemId || !title || !resume) {
            return;
          }
          const referenceId = `${document.id}::${itemId}`;
          if (seen.has(referenceId)) {
            return;
          }
          seen.add(referenceId);
          items.push({ id: referenceId, title, resume });
        });
      });

      return { items };
    },

    readMarkdown(documentId) {
      const document = getDocument(documentId);
      const filePath = fromRelative(baseDir, document.markdown_path);
      return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    },

    readItems(documentId) {
      const document = getDocument(documentId);
      return readJson(fromRelative(baseDir, document.items_path), []);
    },

    readAnalysis(documentId) {
      const document = getDocument(documentId);
      const markdownPath = fromRelative(baseDir, document.markdown_path);
      const markdown = fs.existsSync(markdownPath) ? fs.readFileSync(markdownPath, 'utf-8') : '';
      const blocks = readJson(fromRelative(baseDir, document.blocks_path), []);
      const filteredBlocks = readJson(fromRelative(baseDir, document.filtered_blocks_path), []);
      const candidateItems = readJson(fromRelative(baseDir, document.candidate_items_path), []);
      const items = readJson(fromRelative(baseDir, document.items_path), []);
      const report = readJson(fromRelative(baseDir, document.report_path), null);
      const matchResult = readJson(fromRelative(baseDir, document.match_result_path), null);
      const markdown_chars = getContentCharCount(markdown);
      const kept_block_chars = sumContentChars(blocks);
      const covered_unique_content_chars = countCoveredUniqueBlockChars(items, blocks);
      return {
        document,
        block_count: blocks.length,
        filtered_blocks_count: filteredBlocks.length,
        markdown_chars,
        kept_block_chars,
        covered_unique_content_chars,
        coverage_rate_vs_markdown: markdown_chars ? Number((covered_unique_content_chars / markdown_chars).toFixed(4)) : 0,
        candidate_items: candidateItems,
        report,
        discarded: matchResult?.discarded || [],
        system_discarded_after_retry: matchResult?.system_discarded_after_retry || [],
        debug_log_path: isDeveloperMode() ? getDebugLogPath(app, documentId) : '',
      };
    },
  };
}

module.exports = {
  createKnowledgeBaseService,
  _internals: {
    createRawBlocks,
    mergeSemanticBlocks,
    filterBlocks,
    renderBlocksForPrompt,
    normalizeCandidateItems,
    normalizeMatchResult,
    normalizeRecoveryResult,
  },
};
