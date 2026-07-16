const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { dialog } = require('electron');
const { getKnowledgeBaseDir } = require('../utils/paths.cjs');
const { deleteImportedImageBatches } = require('../utils/importedImages.cjs');
const { splitUserTextByContextLimit } = require('../utils/userTextSplitter.cjs');
const { parseDocumentWithConfig } = require('./fileService.cjs');

const supportedExtensions = new Set(['.doc', '.docx', '.wps', '.pdf', '.md', '.markdown', '.xls', '.xlsx']);
const oversizedBlockChars = 8000;
const semanticMergeTargetChars = 500;
const recoveryMaxAttempts = 2;
const DEFAULT_CONTEXT_LENGTH_LIMIT = 400000;
const KNOWLEDGE_CONTEXT_LIMIT_RATIO = 0.8;
const PROMPT_CACHE_WARMUP_DELAY_MS = 5000;

function now() {
  return new Date().toISOString();
}

/** 等待服务商写入提示词前缀缓存后再 fan-out */
function waitForPromptCacheWarmup() {
  return new Promise((resolve) => setTimeout(resolve, PROMPT_CACHE_WARMUP_DELAY_MS));
}

/** 并发执行任务，全部结束后若有失败则抛出首个错误 */
async function runParallelAndThrowAfterSettled(taskFns) {
  const results = await Promise.allSettled((taskFns || []).map((fn) => fn()));
  const rejected = results.find((item) => item.status === 'rejected');
  if (rejected) {
    throw rejected.reason instanceof Error ? rejected.reason : new Error(String(rejected.reason || '并发分段失败'));
  }
  return results.map((item) => item.value);
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function safeName(name) {
  return String(name || '未命名').replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_').trim() || '未命名';
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function rebaseDocumentRelativePath(value, oldDocumentDir, newDocumentDir) {
  const normalized = normalizeRelativePath(value);
  const oldPrefix = normalizeRelativePath(oldDocumentDir).replace(/\/+$/, '');
  const nextPrefix = normalizeRelativePath(newDocumentDir).replace(/\/+$/, '');
  if (normalized === oldPrefix) return nextPrefix;
  if (normalized.startsWith(`${oldPrefix}/`)) return `${nextPrefix}${normalized.slice(oldPrefix.length)}`;
  return normalizeRelativePath(path.join(nextPrefix, path.basename(normalized)));
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
  return splitUserTextByContextLimit(String(text || ''), {}, {
    contextLengthLimit: limit,
    limitRatio: 1,
    maxSegmentLimitRatio: 1,
  }).map((part) => part.trim()).filter(Boolean);
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

/** 估算 messages 总字符（role + content + 少量开销） */
function getMessagesContentLength(messages) {
  return (messages || []).reduce((sum, message) => (
    sum + String(message?.role || 'user').length + String(message?.content || '').length + 64
  ), 0);
}

/** 计算本段可塞入的用户不可控正文上限 */
function getKnowledgeBaseSegmentLimit(aiService, fixedMessages) {
  const config = typeof aiService?.getConfig === 'function' ? aiService.getConfig() : {};
  const rawLimit = Number(config?.context_length_limit);
  const contextLengthLimit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.floor(rawLimit)
    : DEFAULT_CONTEXT_LENGTH_LIMIT;
  const requestBudget = Math.floor(contextLengthLimit * KNOWLEDGE_CONTEXT_LIMIT_RATIO);
  return Math.max(1, requestBudget - getMessagesContentLength(fixedMessages));
}

/** 将 block 按渲染长度连续打包成段（不拆单 block） */
function packBlocksIntoSegments(blocks, segmentLimit) {
  const limit = Math.max(1, Math.floor(Number(segmentLimit) || 1));
  const source = Array.isArray(blocks) ? blocks : [];
  if (!source.length) return [];

  const segments = [];
  let currentBlocks = [];
  let currentChars = 0;

  const flush = () => {
    if (!currentBlocks.length) return;
    const text = renderBlocksForPrompt(currentBlocks);
    segments.push({
      blocks: currentBlocks,
      blockIds: currentBlocks.map((block) => block.id),
      text,
      chars: text.length,
    });
    currentBlocks = [];
    currentChars = 0;
  };

  for (const block of source) {
    const blockText = renderBlocksForPrompt([block]);
    const blockChars = blockText.length;
    const nextChars = currentChars + (currentBlocks.length ? 2 : 0) + blockChars;
    if (currentBlocks.length && nextChars > limit) {
      flush();
    }
    currentBlocks.push(block);
    currentChars += (currentBlocks.length > 1 ? 2 : 0) + blockChars;
  }
  flush();

  return segments.map((segment, index) => ({
    ...segment,
    index: index + 1,
    total: segments.length,
  }));
}

/** 将条目按 JSON 渲染长度打包成段（仅条目超预算时兜底） */
function packItemsIntoSegments(items, segmentLimit) {
  const limit = Math.max(1, Math.floor(Number(segmentLimit) || 1));
  const source = Array.isArray(items) ? items : [];
  if (!source.length) return [];

  const segments = [];
  let currentItems = [];
  let currentChars = 0;

  const renderItems = (list) => JSON.stringify(
    list.map(({ id, title, summary }) => ({ id, title, summary })),
    null,
    2,
  );

  const flush = () => {
    if (!currentItems.length) return;
    const text = renderItems(currentItems);
    segments.push({
      items: currentItems,
      itemIds: currentItems.map((item) => item.id),
      text,
      chars: text.length,
    });
    currentItems = [];
    currentChars = 0;
  };

  for (const item of source) {
    const itemText = renderItems([item]);
    const itemChars = itemText.length;
    const nextChars = currentChars + (currentItems.length ? 2 : 0) + itemChars;
    if (currentItems.length && nextChars > limit) {
      flush();
    }
    currentItems.push(item);
    currentChars += (currentItems.length > 1 ? 2 : 0) + itemChars;
  }
  flush();

  return segments.map((segment, index) => ({
    ...segment,
    index: index + 1,
    total: segments.length,
  }));
}

/** 合并同 id 的匹配 ranges / block_ids */
function mergeMatchResults(matchLists) {
  const byId = new Map();
  for (const match of (matchLists || []).flat()) {
    if (!match?.id) continue;
    const current = byId.get(match.id) || { id: match.id, ranges: [], block_ids: [] };
    if (Array.isArray(match.ranges)) current.ranges.push(...match.ranges);
    if (Array.isArray(match.block_ids)) current.block_ids.push(...match.block_ids);
    byId.set(match.id, current);
  }
  return [...byId.values()].map((match) => ({
    id: match.id,
    ranges: match.ranges,
    block_ids: [...new Set(match.block_ids)],
  }));
}

/** 补漏多子批时，每个 block 只保留一种归属：matches > new_items > discarded */
function mergeRecoverySegmentResults(parsedList, itemIds, blocks, blockOrder) {
  const ownership = new Map();
  const matchRangesByItem = new Map();
  const newItems = [];
  const discarded = [];
  const sourceList = parsedList || [];

  const claimBlock = (blockId, kind, payload) => {
    if (!blockId || ownership.has(blockId)) return false;
    ownership.set(blockId, { kind, payload });
    return true;
  };

  // 必须全局按优先级认领，避免子批顺序导致 discarded 抢先占住 matches
  for (const parsed of sourceList) {
    for (const match of parsed.matches || []) {
      const claimedIds = [];
      for (const blockId of match.block_ids || []) {
        if (claimBlock(blockId, 'match', match.id)) claimedIds.push(blockId);
      }
      if (!claimedIds.length) continue;
      const current = matchRangesByItem.get(match.id) || { ranges: [], block_ids: [] };
      current.ranges.push(...(match.ranges || []));
      current.block_ids.push(...claimedIds);
      matchRangesByItem.set(match.id, current);
    }
  }

  for (const parsed of sourceList) {
    for (const item of parsed.new_items || []) {
      const claimedIds = [];
      for (const blockId of item.block_ids || []) {
        if (claimBlock(blockId, 'new_item', item)) claimedIds.push(blockId);
      }
      if (!claimedIds.length) continue;
      newItems.push({
        title: item.title,
        summary: item.summary,
        ranges: item.ranges || [],
        block_ids: claimedIds,
      });
    }
  }

  for (const parsed of sourceList) {
    for (const item of parsed.discarded || []) {
      const claimedIds = [];
      for (const blockId of item.block_ids || []) {
        if (claimBlock(blockId, 'discarded', item)) claimedIds.push(blockId);
      }
      if (!claimedIds.length) continue;
      discarded.push({
        ranges: item.ranges || [],
        block_ids: claimedIds,
        reason: item.reason || 'AI 建议舍弃',
      });
    }
  }

  // 以认领后的 block_ids 为权威，再压成 ranges，避免脏 ranges 再展开串段
  const matches = [...matchRangesByItem.entries()]
    .map(([id, value]) => {
      if (!itemIds.has(id)) return null;
      const blockIds = [...new Set(value.block_ids)].filter(
        (blockId) => ownership.get(blockId)?.kind === 'match' && ownership.get(blockId)?.payload === id,
      );
      const ranges = compressBlockIdsToRanges(blockIds, blockOrder);
      return ranges.length && blockIds.length ? { id, ranges, block_ids: blockIds } : null;
    })
    .filter(Boolean);

  return {
    matches,
    new_items: newItems.map((item) => {
      const blockIds = [...new Set(item.block_ids)];
      const ranges = compressBlockIdsToRanges(blockIds, blockOrder);
      return {
        title: item.title,
        summary: item.summary,
        ranges,
        block_ids: blockIds,
      };
    }).filter((item) => item.ranges.length && item.block_ids.length),
    discarded: discarded.map((item) => {
      const blockIds = [...new Set(item.block_ids)];
      const ranges = compressBlockIdsToRanges(blockIds, blockOrder);
      return {
        ranges,
        block_ids: blockIds,
        reason: item.reason,
      };
    }).filter((item) => item.ranges.length && item.block_ids.length),
  };
}

function renderCandidateItemsJson(items) {
  return JSON.stringify(
    (items || []).map(({ title, summary }) => ({ title, summary })),
    null,
    2,
  );
}

function renderKnowledgeItemsJson(items) {
  return JSON.stringify(
    (items || []).map(({ id, title, summary }) => ({ id, title, summary })),
    null,
    2,
  );
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

/** 分段提取结果按标题去重合并（仅 title/summary，不含 id） */
function mergeTitleSummaryItems(itemLists) {
  const merged = [];
  const seen = new Set();
  for (const item of (itemLists || []).flat()) {
    const title = String(item?.title || '').trim();
    const summary = String(item?.summary || item?.resume || '').trim();
    const key = title.replace(/\s+/g, '').toLowerCase();
    if (!key || !summary || seen.has(key)) continue;
    seen.add(key);
    merged.push({ title, summary });
  }
  return merged;
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

/** 本段可变 block 后缀（段号只放此处，便于前缀缓存） */
function buildDocumentBlocksUserMessage(blockText, segmentMeta = null) {
  const segmentHint = segmentMeta?.total > 1
    ? `当前是第 ${segmentMeta.index}/${segmentMeta.total} 段 block 列表。只能基于本段内容处理，只能使用本段出现的 block id。`
    : '以下是当前需要处理的 block 列表。只能基于这些 block 处理，只能使用其中出现的 block id。';
  return {
    role: 'user',
    content: [
      segmentHint,
      '<document_blocks>',
      blockText,
      '</document_blocks>',
    ].join('\n'),
  };
}

/** 本段可变遗漏 block 后缀 */
function buildMissingBlocksUserMessage(missingBlocks, segmentMeta = null) {
  const segmentHint = segmentMeta?.total > 1
    ? `当前是第 ${segmentMeta.index}/${segmentMeta.total} 段遗漏 block。必须覆盖本段收到的全部遗漏 block。`
    : '必须覆盖本段收到的全部遗漏 block。';
  return {
    role: 'user',
    content: [
      segmentHint,
      '<missing_blocks>',
      renderBlocksForPrompt(missingBlocks),
      '</missing_blocks>',
    ].join('\n'),
  };
}

/** 首次提取：固定任务说明（跨段共享前缀） */
function buildInitialItemSharedMessages(documentName) {
  return [{
    role: 'user',
    content: [
      `文档名：${documentName}`,
      '你是投标资料知识库分析助手。你只负责从历史投标资料中提取对后续编写标书有复用价值的知识条目。',
      '任务：从后面给出的本段 block 中提取有意义的知识条目数组。条目应覆盖技术方案、项目管理、质量、安全、进度、服务、应急、人员设备、类似业绩等可复用内容。',
      '本段没有可复用知识时必须返回 {"items":[]}。',
      '只返回 JSON：{"items":[{"title":"","summary":""}]}',
      '要求：title 简洁明确；summary 说明该条目可如何用于编写投标文件；不要输出 id、content、段落编号、Markdown 或解释文字。',
      '不要假设未见过的其它段内容；只能使用本段出现的 block id。',
    ].join('\n'),
  }];
}

function buildInitialItemMessages(documentName, blockText, segmentMeta = null) {
  return [
    ...buildInitialItemSharedMessages(documentName),
    buildDocumentBlocksUserMessage(blockText, segmentMeta),
  ];
}

function buildInitialItemFixedMessages(documentName) {
  return buildInitialItemSharedMessages(documentName);
}

/** 补充遗漏：固定任务 + 完整首轮条目（跨段共享） */
function buildSupplementItemSharedMessages(documentName, firstItems) {
  return [{
    role: 'user',
    content: [
      `文档名：${documentName}`,
      '你是投标资料知识库补漏助手。你只判断已有知识条目是否遗漏了重要主题，并补充缺失条目。',
      'first_round_items 是全文已有结果，不要重复首轮已有条目。',
      '任务：只输出后面本段 block 可见、且首轮未覆盖的新增条目；如果没有遗漏，返回空 items 数组。',
      '只返回 JSON：{"items":[{"title":"","summary":""}]}',
      '如果没有新增条目，必须返回 {"items":[]}，这属于正常结果。',
      '不要重复已有条目，不要输出 id、content、段落编号、Markdown 或解释文字。',
      '只能使用本段出现的 block id。',
      '',
      '<first_round_items>',
      renderCandidateItemsJson(firstItems),
      '</first_round_items>',
    ].join('\n'),
  }];
}

function buildSupplementItemMessages(documentName, blockText, firstItems, segmentMeta = null) {
  return [
    ...buildSupplementItemSharedMessages(documentName, firstItems),
    buildDocumentBlocksUserMessage(blockText, segmentMeta),
  ];
}

function buildSupplementItemFixedMessages(documentName, firstItems) {
  return buildSupplementItemSharedMessages(documentName, firstItems);
}

/** 匹配：纯规则（跨请求稳定） */
function buildMatchRuleMessages(documentName) {
  return [{
    role: 'user',
    content: [
      `文档名：${documentName}`,
      '你是投标知识库段落匹配助手。你只根据知识条目的标题和摘要，为其匹配强相关 block 范围。',
      '规则：',
      '1. 只处理本次给出的知识条目。',
      '2. 只匹配与条目强相关、可直接支撑该条目的 block。',
      '3. 如果某些 block 更可能属于其他主题或条目，不要强行匹配。',
      '4. 只返回 id 和 ranges，不要输出正文，不要解释。',
      '5. ranges 使用闭区间：["P000001","P000003"] 表示连续 block；单个 block 写成 ["P000001","P000001"]。',
      '6. 只允许使用本段存在的 block 编号和本次条目 id。',
      '输出 JSON：{"matches":[{"id":"K000001","ranges":[["P000001","P000003"]]}]}',
    ].join('\n'),
  }];
}

function buildMatchItemsUserMessage(batchItems) {
  return {
    role: 'user',
    content: [
      '以下是本次需要匹配的知识条目。只处理这些条目：',
      renderKnowledgeItemsJson(batchItems),
    ].join('\n'),
  };
}

/**
 * 匹配 messages
 * - 整包条目：规则 → 条目 → 本段 block（跨段共享规则+条目）
 * - 条目子批：规则 → 本段 block → 子批条目（同段共享规则+block）
 */
function buildMatchMessages(documentName, blockText, batchItems, segmentMeta = null, options = {}) {
  const itemSplit = Boolean(options.itemSplit);
  const ruleMessages = buildMatchRuleMessages(documentName);
  const itemsMessage = buildMatchItemsUserMessage(batchItems);
  const blocksMessage = buildDocumentBlocksUserMessage(blockText, segmentMeta);
  if (itemSplit) {
    return [...ruleMessages, blocksMessage, itemsMessage];
  }
  return [...ruleMessages, itemsMessage, blocksMessage];
}

/** 匹配预算用 fixed：规则 + 整包条目（不含 block 后缀） */
function buildMatchFixedMessages(documentName, items) {
  return [
    ...buildMatchRuleMessages(documentName),
    buildMatchItemsUserMessage(items),
  ];
}

/** 补漏：纯规则 */
function buildRecoveryRuleMessages(documentName) {
  return [{
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
      '只能使用本段存在的 block 编号和本次给出的条目 id。',
    ].join('\n'),
  }];
}

function buildRecoveryItemsUserMessage(items) {
  return {
    role: 'user',
    content: [
      '<knowledge_items>',
      renderKnowledgeItemsJson(items),
      '</knowledge_items>',
    ].join('\n'),
  };
}

/**
 * 补漏 messages
 * - 整包条目：规则 → 条目 → missing
 * - 条目子批：规则 → missing → 子批条目
 */
function buildRecoveryMessages(documentName, items, missingBlocks, segmentMeta = null, options = {}) {
  const itemSplit = Boolean(options.itemSplit);
  const ruleMessages = buildRecoveryRuleMessages(documentName);
  const itemsMessage = buildRecoveryItemsUserMessage(items);
  const missingMessage = buildMissingBlocksUserMessage(missingBlocks, segmentMeta);
  if (itemSplit) {
    return [...ruleMessages, missingMessage, itemsMessage];
  }
  return [...ruleMessages, itemsMessage, missingMessage];
}

/** 补漏预算用 fixed：规则 + 全部条目（不含 missing 后缀） */
function buildRecoveryFixedMessages(documentName, items) {
  return [
    ...buildRecoveryRuleMessages(documentName),
    buildRecoveryItemsUserMessage(items),
  ];
}

function getRequestBudget(aiService) {
  const config = typeof aiService?.getConfig === 'function' ? aiService.getConfig() : {};
  const rawLimit = Number(config?.context_length_limit);
  const contextLengthLimit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.floor(rawLimit)
    : DEFAULT_CONTEXT_LENGTH_LIMIT;
  return Math.floor(contextLengthLimit * KNOWLEDGE_CONTEXT_LIMIT_RATIO);
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

/** 将已排序的 block id 列表压缩为闭区间 ranges */
function compressBlockIdsToRanges(blockIds, blockOrder) {
  const ordered = [...new Set(blockIds || [])]
    .filter((id) => blockOrder.has(id))
    .sort((a, b) => blockOrder.get(a) - blockOrder.get(b));
  if (!ordered.length) return [];

  const ranges = [];
  let start = ordered[0];
  let prev = ordered[0];
  for (let i = 1; i < ordered.length; i += 1) {
    const id = ordered[i];
    if (blockOrder.get(id) === blockOrder.get(prev) + 1) {
      prev = id;
      continue;
    }
    ranges.push([start, prev]);
    start = id;
    prev = id;
  }
  ranges.push([start, prev]);
  return ranges;
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

function createKnowledgeBaseService({ app, aiService, configStore, knowledgeBaseStore }) {
  const baseDir = getKnowledgeBaseDir(app);
  const activePreparations = new Set();
  const activeMatches = new Set();

  if (!knowledgeBaseStore) {
    throw new Error('知识库数据库服务尚未初始化');
  }

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

  function emitProgress(webContents, document) {
    if (!webContents?.isDestroyed()) {
      webContents.send('knowledge-base:event', { document });
    }
  }

  function updateDocument(documentId, partial, webContents) {
    const document = knowledgeBaseStore.updateDocument(documentId, { ...partial, updated_at: now() });
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
    return knowledgeBaseStore.getDocument(documentId);
  }

  function getActiveDocumentIds() {
    return [...new Set([...activePreparations, ...activeMatches])];
  }

  function recoverInterruptedDocuments() {
    const recovered = knowledgeBaseStore.recoverInterruptedDocuments(getActiveDocumentIds());
    recovered.forEach((document) => debugLog(document.id, 'document:recover-interrupted', { status: document.status, message: document.message }));
    return recovered;
  }

  function isSamePath(a, b) {
    return path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();
  }

  function getStep(documentId, stepKey) {
    return knowledgeBaseStore.getDocumentStep(documentId, stepKey);
  }

  function stepCanReuse(step, hasArtifact) {
    return Boolean(hasArtifact && (!step || step.status === 'success'));
  }

  function getStepItems(documentId, stepKey) {
    const result = getStep(documentId, stepKey)?.result;
    return Array.isArray(result?.items) ? result.items : null;
  }

  function isSameStringList(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => String(value) === String(b[index]));
  }

  function isRecoveryStepResult(value) {
    return Boolean(value
      && Array.isArray(value.items)
      && Array.isArray(value.matches)
      && Array.isArray(value.discarded)
      && Array.isArray(value.system_discarded)
      && Array.isArray(value.recovery_attempts));
  }

  async function runDocumentStep(documentId, stepKey, worker) {
    knowledgeBaseStore.saveDocumentStep(documentId, stepKey, { status: 'running' });
    try {
      const result = await worker();
      knowledgeBaseStore.saveDocumentStep(documentId, stepKey, { status: 'success', result });
      debugLog(documentId, `step:${stepKey}:success`);
      return result;
    } catch (error) {
      knowledgeBaseStore.saveDocumentStep(documentId, stepKey, { status: 'error', error: error.message || String(error) });
      debugLog(documentId, `step:${stepKey}:error`, { message: error.message || String(error) });
      throw error;
    }
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
      const config = configStore ? configStore.load() : { components: { file_parser: { provider: 'local' } } };
      const documentDir = fromRelative(baseDir, document.document_dir);
      const sourcePath = fromRelative(baseDir, document.source_path);
      const markdownPath = fromRelative(baseDir, document.markdown_path);
      let markdown = fs.existsSync(markdownPath) ? fs.readFileSync(markdownPath, 'utf-8').trim() : '';
      let blocks = knowledgeBaseStore.readBlocks(documentId);
      let filteredBlocks = knowledgeBaseStore.readFilteredBlocks(documentId);
      let firstItems = getStepItems(documentId, 'extract_first_items');
      let supplementItems = getStepItems(documentId, 'extract_supplement_items');
      let candidateItems = knowledgeBaseStore.readCandidateItems(documentId);

      const copyStep = getStep(documentId, 'copy_source');
      if (stepCanReuse(copyStep, fs.existsSync(sourcePath))) {
        if (!copyStep) knowledgeBaseStore.saveDocumentStep(documentId, 'copy_source', { status: 'success', result: { source_path: document.source_path } });
        debugLog(documentId, 'prepare:reuse-source', { source_path: sourcePath });
      } else {
        if (!fs.existsSync(sourceFilePath)) {
          throw new Error('原始文件不存在，请重新上传');
        }
        knowledgeBaseStore.clearDocumentProcessingFromStep(documentId, 'copy_source');
        updateDocument(documentId, { status: 'copying', progress: 5, message: '正在复制原始文件', error: null }, webContents);
        await runDocumentStep(documentId, 'copy_source', async () => {
          ensureDir(documentDir);
          if (!isSamePath(sourceFilePath, sourcePath)) {
            await fsp.copyFile(sourceFilePath, sourcePath);
          }
          debugLog(documentId, 'prepare:copied-source', { source_path: sourcePath });
          return { source_path: document.source_path };
        });
      }

      const convertStep = getStep(documentId, 'convert_markdown');
      if (stepCanReuse(convertStep, Boolean(markdown))) {
        if (!convertStep) knowledgeBaseStore.saveDocumentStep(documentId, 'convert_markdown', { status: 'success', result: { markdown_chars: markdown.length } });
        debugLog(documentId, 'prepare:reuse-markdown', { markdown_chars: markdown.length });
      } else {
        knowledgeBaseStore.clearDocumentProcessingFromStep(documentId, 'convert_markdown');
        blocks = [];
        filteredBlocks = [];
        firstItems = null;
        supplementItems = null;
        candidateItems = [];
        updateDocument(documentId, { status: 'converting', progress: 15, message: '正在转换为 Markdown', error: null }, webContents);
        const result = await runDocumentStep(documentId, 'convert_markdown', async () => {
          const parsedMarkdown = stripMarkdownFence((await parseDocumentWithConfig(app, sourcePath, config, { assetScope: `knowledge-${documentId}`, preserveImages: false })).trim());
          if (!parsedMarkdown) throw new Error('文档未解析出有效 Markdown 内容');
          await fsp.writeFile(markdownPath, `${parsedMarkdown}\n`, 'utf-8');
          knowledgeBaseStore.updateMarkdownMetadata(documentId, parsedMarkdown);
          debugLog(documentId, 'prepare:converted-markdown', { markdown_path: markdownPath, markdown_chars: parsedMarkdown.length });
          return { markdown_chars: parsedMarkdown.length };
        });
        markdown = fs.readFileSync(markdownPath, 'utf-8').trim();
        if (!result?.markdown_chars || !markdown) throw new Error('文档未解析出有效 Markdown 内容');
      }

      const blockStep = getStep(documentId, 'build_blocks');
      if (stepCanReuse(blockStep, blocks.length > 0)) {
        if (!blockStep) knowledgeBaseStore.saveDocumentStep(documentId, 'build_blocks', { status: 'success', result: { block_count: blocks.length, filtered_block_count: filteredBlocks.length } });
        debugLog(documentId, 'prepare:reuse-blocks', { block_count: blocks.length, filtered_block_count: filteredBlocks.length });
      } else {
        knowledgeBaseStore.clearDocumentProcessingFromStep(documentId, 'build_blocks');
        firstItems = null;
        supplementItems = null;
        candidateItems = [];
        const result = await runDocumentStep(documentId, 'build_blocks', async () => {
          const rawBlocks = createRawBlocks(markdown);
          const semanticBlocks = mergeSemanticBlocks(rawBlocks);
          const filtered = filterBlocks(semanticBlocks);
          if (!filtered.blocks.length) throw new Error('筛选后没有可分析的正文内容');
          knowledgeBaseStore.saveBlocks(documentId, filtered.blocks, filtered.filtered_blocks);
          debugLog(documentId, 'prepare:blocks-ready', {
            raw_block_count: rawBlocks.length,
            semantic_block_count: semanticBlocks.length,
            block_count: filtered.blocks.length,
            filtered_block_count: filtered.filtered_blocks.length,
            block_text_chars: renderBlocksForPrompt(filtered.blocks).length,
            filtered_reasons: filtered.filtered_blocks.reduce((acc, block) => {
              acc[block.reason] = (acc[block.reason] || 0) + 1;
              return acc;
            }, {}),
          });
          return { block_count: filtered.blocks.length, filtered_block_count: filtered.filtered_blocks.length };
        });
        blocks = knowledgeBaseStore.readBlocks(documentId);
        filteredBlocks = knowledgeBaseStore.readFilteredBlocks(documentId);
        updateDocument(documentId, { block_count: result.block_count, filtered_block_count: result.filtered_block_count }, webContents);
      }

      if (candidateItems.length > 0
        && !getStep(documentId, 'extract_first_items')
        && !getStep(documentId, 'extract_supplement_items')
        && !getStep(documentId, 'merge_candidates')) {
        const legacyItems = candidateItems.map(({ title, summary }) => ({ title, summary }));
        firstItems = legacyItems;
        supplementItems = [];
        knowledgeBaseStore.saveDocumentStep(documentId, 'extract_first_items', { status: 'success', result: { items: firstItems } });
        knowledgeBaseStore.saveDocumentStep(documentId, 'extract_supplement_items', { status: 'success', result: { items: supplementItems } });
        knowledgeBaseStore.saveDocumentStep(documentId, 'merge_candidates', { status: 'success', result: { candidate_item_count: candidateItems.length } });
        debugLog(documentId, 'prepare:reuse-legacy-candidates', { candidate_item_count: candidateItems.length });
      }
      const firstStep = getStep(documentId, 'extract_first_items');
      if (stepCanReuse(firstStep, Array.isArray(firstItems))) {
        if (!firstStep) knowledgeBaseStore.saveDocumentStep(documentId, 'extract_first_items', { status: 'success', result: { items: firstItems } });
        debugLog(documentId, 'prepare:reuse-first-items', { item_count: firstItems.length });
      } else {
        knowledgeBaseStore.clearDocumentProcessingFromStep(documentId, 'extract_first_items');
        supplementItems = null;
        candidateItems = [];
        updateDocument(documentId, {
          status: 'extracting',
          progress: 35,
          message: 'AI 正在首次提取知识条目',
          block_count: blocks.length,
          filtered_block_count: filteredBlocks.length,
          error: null,
        }, webContents);
        const result = await runDocumentStep(documentId, 'extract_first_items', async () => {
          const fixedShell = buildInitialItemFixedMessages(document.file_name);
          const segmentLimit = getKnowledgeBaseSegmentLimit(aiService, fixedShell);
          const segments = packBlocksIntoSegments(blocks, segmentLimit);
          debugLog(documentId, 'ai:first-items:plan', {
            segment_total: segments.length,
            segment_limit: segmentLimit,
            block_count: blocks.length,
            execution_mode: segments.length > 1 ? 'warmup_parallel' : 'serial',
            prefix_chars: getMessagesContentLength(fixedShell),
          });

          let completedSegments = 0;
          const runSegment = async (segment) => {
            const firstMessages = buildInitialItemMessages(document.file_name, segment.text, segment);
            debugLog(documentId, 'ai:first-items:start', {
              segment_index: segment.index,
              segment_total: segment.total,
              segment_chars: segment.chars,
              segment_limit: segmentLimit,
              block_ids: segment.blockIds,
              prefix_chars: getMessagesContentLength(fixedShell),
              suffix_chars: getMessagesContentLength([firstMessages[firstMessages.length - 1]]),
              prompt: getPromptSummary(firstMessages),
            });
            const first = await aiService.collectJsonResponse({
              messages: firstMessages,
              temperature: 0.2,
              response_format: { type: 'json_object' },
              logTitle: segments.length > 1
                ? `知识库条目提取-${document.file_name}-第${segment.index}段`
                : `知识库条目提取-${document.file_name}`,
              normalizer: (value) => ({ items: normalizeCandidateItems(value) }),
              validator: validateCandidateItems,
              failureMessage: '知识库条目提取失败，AI 未返回有效 JSON',
              progressLabel: '知识库条目提取',
            });
            const items = Array.isArray(first?.items) ? first.items : [];
            completedSegments += 1;
            updateDocument(documentId, {
              status: 'extracting',
              progress: Math.min(54, 35 + Math.round((completedSegments / segments.length) * 18)),
              message: segments.length > 1
                ? `AI 正在首次提取知识条目，已完成 ${completedSegments}/${segments.length} 段`
                : 'AI 正在首次提取知识条目',
            }, webContents);
            debugLog(documentId, 'ai:first-items:segment-done', {
              segment_index: segment.index,
              item_count: items.length,
              sample: getItemSample(items),
            });
            return items;
          };

          const firstSegmentItems = await runSegment(segments[0]);
          if (segments.length > 1) {
            debugLog(documentId, 'ai:first-items:warmup-wait', { delay_ms: PROMPT_CACHE_WARMUP_DELAY_MS });
            updateDocument(documentId, {
              status: 'extracting',
              progress: Math.min(54, 35 + Math.round((1 / segments.length) * 18)),
              message: `提示词缓存预热完成，等待后并发提取剩余 ${segments.length - 1} 段`,
            }, webContents);
            await waitForPromptCacheWarmup();
          }
          const remainingItems = segments.length > 1
            ? await runParallelAndThrowAfterSettled(segments.slice(1).map((segment) => () => runSegment(segment)))
            : [];
          const items = mergeTitleSummaryItems([firstSegmentItems, ...remainingItems]);
          debugLog(documentId, 'ai:first-items:done', {
            item_count: items.length,
            segment_total: segments.length,
            sample: getItemSample(items),
          });
          return { items, segment_count: segments.length };
        });
        firstItems = result.items;
      }

      const supplementStep = getStep(documentId, 'extract_supplement_items');
      if (stepCanReuse(supplementStep, Array.isArray(supplementItems))) {
        if (!supplementStep) knowledgeBaseStore.saveDocumentStep(documentId, 'extract_supplement_items', { status: 'success', result: { items: supplementItems } });
        debugLog(documentId, 'prepare:reuse-supplement-items', { item_count: supplementItems.length });
      } else {
        knowledgeBaseStore.clearDocumentProcessingFromStep(documentId, 'extract_supplement_items');
        candidateItems = [];
        updateDocument(documentId, { status: 'extracting', progress: 55, message: 'AI 正在补充遗漏知识条目', error: null }, webContents);
        const result = await runDocumentStep(documentId, 'extract_supplement_items', async () => {
          const fixedShell = buildSupplementItemFixedMessages(document.file_name, firstItems);
          const segmentLimit = getKnowledgeBaseSegmentLimit(aiService, fixedShell);
          const segments = packBlocksIntoSegments(blocks, segmentLimit);
          debugLog(documentId, 'ai:supplement-items:plan', {
            first_item_count: firstItems.length,
            segment_total: segments.length,
            segment_limit: segmentLimit,
            execution_mode: segments.length > 1 ? 'warmup_parallel' : 'serial',
            prefix_chars: getMessagesContentLength(fixedShell),
          });

          let completedSegments = 0;
          const runSegment = async (segment) => {
            const supplementMessages = buildSupplementItemMessages(document.file_name, segment.text, firstItems, segment);
            debugLog(documentId, 'ai:supplement-items:start', {
              segment_index: segment.index,
              segment_total: segment.total,
              segment_chars: segment.chars,
              segment_limit: segmentLimit,
              first_item_count: firstItems.length,
              block_ids: segment.blockIds,
              prefix_chars: getMessagesContentLength(fixedShell),
              suffix_chars: getMessagesContentLength([supplementMessages[supplementMessages.length - 1]]),
              prompt: getPromptSummary(supplementMessages),
            });
            const supplement = await aiService.collectJsonResponse({
              messages: supplementMessages,
              temperature: 0.2,
              response_format: { type: 'json_object' },
              logTitle: segments.length > 1
                ? `知识库条目补充-${document.file_name}-第${segment.index}段`
                : `知识库条目补充-${document.file_name}`,
              normalizer: (value) => ({ items: normalizeCandidateItems(value) }),
              validator: validateCandidateItems,
              failureMessage: '知识库条目补充失败，AI 未返回有效 JSON',
              progressLabel: '知识库条目补充',
            });
            const items = Array.isArray(supplement?.items) ? supplement.items : [];
            completedSegments += 1;
            updateDocument(documentId, {
              status: 'extracting',
              progress: Math.min(64, 55 + Math.round((completedSegments / segments.length) * 8)),
              message: segments.length > 1
                ? `AI 正在补充遗漏知识条目，已完成 ${completedSegments}/${segments.length} 段`
                : 'AI 正在补充遗漏知识条目',
            }, webContents);
            debugLog(documentId, 'ai:supplement-items:segment-done', {
              segment_index: segment.index,
              item_count: items.length,
              sample: getItemSample(items),
            });
            return items;
          };

          const firstSegmentItems = await runSegment(segments[0]);
          if (segments.length > 1) {
            debugLog(documentId, 'ai:supplement-items:warmup-wait', { delay_ms: PROMPT_CACHE_WARMUP_DELAY_MS });
            updateDocument(documentId, {
              status: 'extracting',
              progress: Math.min(64, 55 + Math.round((1 / segments.length) * 8)),
              message: `提示词缓存预热完成，等待后并发补充剩余 ${segments.length - 1} 段`,
            }, webContents);
            await waitForPromptCacheWarmup();
          }
          const remainingItems = segments.length > 1
            ? await runParallelAndThrowAfterSettled(segments.slice(1).map((segment) => () => runSegment(segment)))
            : [];
          const items = mergeTitleSummaryItems([firstSegmentItems, ...remainingItems]);
          debugLog(documentId, 'ai:supplement-items:done', {
            item_count: items.length,
            segment_total: segments.length,
            sample: getItemSample(items),
          });
          return { items, segment_count: segments.length };
        });
        supplementItems = result.items;
      }

      const mergeStep = getStep(documentId, 'merge_candidates');
      if (stepCanReuse(mergeStep, candidateItems.length > 0)) {
        if (!mergeStep) knowledgeBaseStore.saveDocumentStep(documentId, 'merge_candidates', { status: 'success', result: { candidate_item_count: candidateItems.length } });
        debugLog(documentId, 'prepare:reuse-candidates', { candidate_item_count: candidateItems.length });
      } else {
        knowledgeBaseStore.clearDocumentProcessingFromStep(documentId, 'merge_candidates');
        const result = await runDocumentStep(documentId, 'merge_candidates', async () => {
          const mergedItems = mergeCandidateItems(firstItems, supplementItems);
          if (!mergedItems.length) throw new Error('AI 未提取出可用知识条目');
          knowledgeBaseStore.saveCandidateItems(documentId, mergedItems);
          debugLog(documentId, 'prepare:candidates-saved', { candidate_item_count: mergedItems.length, sample: getItemSample(mergedItems) });
          return { candidate_item_count: mergedItems.length };
        });
        candidateItems = knowledgeBaseStore.readCandidateItems(documentId);
        if (!result?.candidate_item_count || !candidateItems.length) throw new Error('AI 未提取出可用知识条目');
      }

      updateDocument(documentId, {
        status: 'ready_for_matching',
        progress: 65,
        message: isDeveloperMode()
          ? `已提取 ${candidateItems.length} 条候选知识，可开始自动分段匹配`
          : `已提取 ${candidateItems.length} 条候选知识，正在自动匹配段落`,
        candidate_item_count: candidateItems.length,
        item_count: 0,
      }, webContents);

      if (!isDeveloperMode()) {
        debugLog(documentId, 'prepare:auto-match');
        await matchDocument(documentId, webContents);
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

  async function matchDocument(documentId, webContents, options = {}) {
    if (activeMatches.has(documentId)) {
      debugLog(documentId, 'match:skip-active');
      return;
    }
    activeMatches.add(documentId);
    const force = Boolean(options.force);
    debugLog(documentId, 'match:start', { force });

    try {
      const document = getDocument(documentId);
      if (force) {
        knowledgeBaseStore.clearDocumentProcessingFromStep(documentId, 'match_batches');
      }
      const blocks = knowledgeBaseStore.readBlocks(documentId);
      const filteredBlocks = knowledgeBaseStore.readFilteredBlocks(documentId);
      const initialItems = knowledgeBaseStore.readCandidateItems(documentId);
      if (!blocks.length) throw new Error('缺少正文 block，请重新上传文档');
      if (!initialItems.length) throw new Error('缺少候选知识条目，请等待条目提取完成');

      const blockOrder = getBlockOrder(blocks);
      const candidateItemIds = new Set(initialItems.map((item) => item.id));
      const allItemIds = initialItems.map((item) => item.id);
      const matchFixedMessages = buildMatchFixedMessages(document.file_name, initialItems);
      const blockSegmentLimit = getKnowledgeBaseSegmentLimit(aiService, matchFixedMessages);
      const blockSegments = packBlocksIntoSegments(blocks, blockSegmentLimit);
      const requestBudget = getRequestBudget(aiService);

      debugLog(documentId, 'match:inputs-ready', {
        block_count: blocks.length,
        filtered_block_count: filteredBlocks.length,
        initial_item_count: initialItems.length,
        segment_total: blockSegments.length,
        segment_limit: blockSegmentLimit,
        execution_mode: 'serial',
        prefix_chars: getMessagesContentLength(matchFixedMessages),
      });

      // 指纹：本段 block_ids + 全部候选条目 id；任一已存段不一致则清空整步重跑
      const buildMatchFingerprint = (blockIds, itemIds) => ({
        block_ids: [...(blockIds || [])],
        item_ids: [...(itemIds || [])],
      });
      const readMatchFingerprint = (raw) => {
        if (!raw || Array.isArray(raw) || !Array.isArray(raw.block_ids) || !Array.isArray(raw.item_ids)) {
          return null;
        }
        return { block_ids: raw.block_ids.map(String), item_ids: raw.item_ids.map(String) };
      };
      const isSameFingerprint = (left, right) => (
        left
        && right
        && isSameStringList(left.block_ids, right.block_ids)
        && isSameStringList(left.item_ids, right.item_ids)
      );

      const existingBatches = force ? [] : knowledgeBaseStore.readMatchBatches(documentId);
      const plannedFingerprints = new Map(
        blockSegments.map((segment) => [
          segment.index,
          buildMatchFingerprint(segment.blockIds, allItemIds),
        ]),
      );
      const fingerprintMismatch = existingBatches.some((batch) => {
        const planned = plannedFingerprints.get(batch.batch_index);
        const saved = readMatchFingerprint(batch.item_ids);
        if (!planned || !saved) return true;
        return !isSameFingerprint(saved, planned);
      });
      if (fingerprintMismatch && existingBatches.length) {
        knowledgeBaseStore.clearMatchBatches(documentId);
        debugLog(documentId, 'match:clear-batches', {
          reason: 'fingerprint_mismatch',
          previous_batch_count: existingBatches.length,
          planned_segment_total: blockSegments.length,
        });
      }

      const matches = [];
      const matchBatches = [];
      knowledgeBaseStore.saveDocumentStep(documentId, 'match_batches', { status: 'running' });
      updateDocument(documentId, {
        status: 'matching',
        progress: 66,
        message: blockSegments.length > 1
          ? `开始按上下文自动分段匹配，共 ${blockSegments.length} 段`
          : '开始匹配段落',
        last_batch_size: blockSegments.length,
      }, webContents);

      for (const segment of blockSegments) {
        const segmentIndex = segment.index;
        const segmentBlockIds = segment.blockIds;
        const segmentBlocks = segment.blocks;
        const segmentBlockOrder = getBlockOrder(segmentBlocks);
        const fingerprint = buildMatchFingerprint(segmentBlockIds, allItemIds);
        const savedBatch = knowledgeBaseStore.getMatchBatch(documentId, segmentIndex);
        const canReuse = savedBatch?.status === 'success'
          && isSameFingerprint(readMatchFingerprint(savedBatch.item_ids), fingerprint)
          && Array.isArray(savedBatch.matches);

        if (canReuse) {
          debugLog(documentId, 'match:reuse-segment', {
            segment_index: segmentIndex,
            match_count: savedBatch.matches.length,
            block_ids: segmentBlockIds,
          });
          const batchResult = {
            batch_index: segmentIndex,
            item_ids: allItemIds,
            block_ids: segmentBlockIds,
            matches: savedBatch.matches,
          };
          matchBatches.push(batchResult);
          matches.push(...savedBatch.matches);
          continue;
        }

        const progress = Math.min(88, 66 + Math.round((segmentIndex / blockSegments.length) * 22));
        updateDocument(documentId, {
          status: 'matching',
          progress,
          message: blockSegments.length > 1
            ? `AI 正在匹配段落 第 ${segmentIndex}/${blockSegments.length} 段`
            : 'AI 正在匹配段落',
        }, webContents);
        knowledgeBaseStore.saveMatchBatch(documentId, segmentIndex, {
          status: 'running',
          itemIds: fingerprint,
          matches: [],
        });

        try {
          // 整包：规则+条目+block；超预算则同段 item-split：规则+block+子批条目
          const fullItemMessages = buildMatchMessages(document.file_name, segment.text, initialItems, segment);
          const fullItemLength = getMessagesContentLength(fullItemMessages);
          let segmentMatches = [];

          if (fullItemLength <= requestBudget) {
            debugLog(documentId, 'ai:match-segment:start', {
              segment_index: segmentIndex,
              segment_total: segment.total,
              segment_chars: segment.chars,
              item_count: initialItems.length,
              item_mode: 'full',
              prefix_chars: getMessagesContentLength(matchFixedMessages),
              prompt: getPromptSummary(fullItemMessages),
            });
            const parsed = await aiService.collectJsonResponse({
              messages: fullItemMessages,
              temperature: 0.1,
              response_format: { type: 'json_object' },
              logTitle: blockSegments.length > 1
                ? `知识库段落匹配-${document.file_name}-第${segmentIndex}段`
                : `知识库段落匹配-${document.file_name}`,
              normalizer: (value) => normalizeMatchResult(value, candidateItemIds, segmentBlocks, segmentBlockOrder),
              validator: validateMatchResult,
              failureMessage: '知识库段落匹配失败，AI 未返回有效 JSON',
              progressLabel: '知识库段落匹配',
            });
            segmentMatches = parsed.matches;
          } else {
            const itemSplitPrefix = [
              ...buildMatchRuleMessages(document.file_name),
              buildDocumentBlocksUserMessage(segment.text, segment),
            ];
            const itemSegmentLimit = Math.max(1, requestBudget - getMessagesContentLength(itemSplitPrefix));
            const itemSegments = packItemsIntoSegments(initialItems, itemSegmentLimit);
            debugLog(documentId, 'ai:match-segment:item-split', {
              segment_index: segmentIndex,
              item_segment_total: itemSegments.length,
              item_segment_limit: itemSegmentLimit,
            });
            const subMatchLists = [];
            for (const itemSegment of itemSegments) {
              const itemIds = new Set(itemSegment.itemIds);
              const matchMessages = buildMatchMessages(
                document.file_name,
                segment.text,
                itemSegment.items,
                segment,
                { itemSplit: true },
              );
              debugLog(documentId, 'ai:match-segment:start', {
                segment_index: segmentIndex,
                segment_total: segment.total,
                segment_chars: segment.chars,
                item_count: itemSegment.items.length,
                item_mode: 'sub_batch',
                item_segment_index: itemSegment.index,
                item_segment_total: itemSegment.total,
                prefix_chars: getMessagesContentLength(itemSplitPrefix),
                prompt: getPromptSummary(matchMessages),
              });
              const parsed = await aiService.collectJsonResponse({
                messages: matchMessages,
                temperature: 0.1,
                response_format: { type: 'json_object' },
                logTitle: `知识库段落匹配-${document.file_name}-第${segmentIndex}段-条目${itemSegment.index}`,
                normalizer: (value) => normalizeMatchResult(value, itemIds, segmentBlocks, segmentBlockOrder),
                validator: validateMatchResult,
                failureMessage: '知识库段落匹配失败，AI 未返回有效 JSON',
                progressLabel: '知识库段落匹配',
              });
              subMatchLists.push(parsed.matches);
            }
            segmentMatches = mergeMatchResults(subMatchLists).map((match) => {
              const blockIds = [...new Set(match.block_ids || [])].filter((id) => segmentBlockOrder.has(id));
              const ranges = compressBlockIdsToRanges(blockIds, segmentBlockOrder);
              return ranges.length ? { id: match.id, ranges, block_ids: blockIds } : null;
            }).filter(Boolean);
          }

          knowledgeBaseStore.saveMatchBatch(documentId, segmentIndex, {
            status: 'success',
            itemIds: fingerprint,
            matches: segmentMatches,
          });
          debugLog(documentId, 'ai:match-segment:done', {
            segment_index: segmentIndex,
            match_count: segmentMatches.length,
            matches: getMatchSummary(segmentMatches),
          });
          const batchResult = {
            batch_index: segmentIndex,
            item_ids: allItemIds,
            block_ids: segmentBlockIds,
            matches: segmentMatches,
          };
          matchBatches.push(batchResult);
          matches.push(...segmentMatches);
        } catch (error) {
          knowledgeBaseStore.saveMatchBatch(documentId, segmentIndex, {
            status: 'error',
            itemIds: fingerprint,
            error: error.message || String(error),
          });
          knowledgeBaseStore.saveDocumentStep(documentId, 'match_batches', {
            status: 'error',
            error: error.message || String(error),
          });
          throw error;
        }
      }

      const mergedMatches = mergeMatchResults(matches).map((match) => {
        const ranges = normalizeRanges(match.ranges, blockOrder);
        return {
          id: match.id,
          ranges,
          block_ids: expandRanges(ranges, blocks, blockOrder),
        };
      }).filter((match) => match.ranges.length);

      knowledgeBaseStore.saveDocumentStep(documentId, 'match_batches', {
        status: 'success',
        result: {
          batch_size: blockSegments.length,
          batch_count: blockSegments.length,
          segment_count: blockSegments.length,
        },
      });

      const recoveryStep = getStep(documentId, 'recover_missing');
      let recoveryResult = recoveryStep?.result;
      if (!force && recoveryStep?.status === 'success' && isRecoveryStepResult(recoveryResult)) {
        debugLog(documentId, 'recovery:reuse', {
          item_count: recoveryResult.items.length,
          match_count: recoveryResult.matches.length,
          recovery_attempt_count: recoveryResult.recovery_attempts.length,
        });
      } else {
        knowledgeBaseStore.clearDocumentProcessingFromStep(documentId, 'recover_missing');
        recoveryResult = await runDocumentStep(documentId, 'recover_missing', async () => {
          const items = [...initialItems];
          const recoveredMatches = [...mergedMatches];
          const discarded = [];
          const systemDiscarded = [];
          const recoveryAttempts = [];

          for (let attempt = 0; attempt < recoveryMaxAttempts; attempt += 1) {
            const missingBlocks = getMissingBlocks(blocks, recoveredMatches, discarded, systemDiscarded);
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
            const recoveryFixed = buildRecoveryFixedMessages(document.file_name, items);
            const missingSegmentLimit = getKnowledgeBaseSegmentLimit(aiService, recoveryFixed);
            const missingSegments = packBlocksIntoSegments(missingBlocks, missingSegmentLimit);
            const recoveryRequestBudget = getRequestBudget(aiService);

            debugLog(documentId, 'ai:recovery:plan', {
              attempt: attempt + 1,
              missing_block_count: missingBlocks.length,
              segment_total: missingSegments.length,
              segment_limit: missingSegmentLimit,
              item_count: items.length,
              execution_mode: missingSegments.length > 1 ? 'warmup_parallel' : 'serial',
              prefix_chars: getMessagesContentLength(recoveryFixed),
            });

            const runMissingSegment = async (missingSegment) => {
              const segmentBlocks = missingSegment.blocks;
              const segmentBlockOrder = getBlockOrder(segmentBlocks);
              const fullMessages = buildRecoveryMessages(document.file_name, items, segmentBlocks, missingSegment);
              const fullLength = getMessagesContentLength(fullMessages);
              let segmentParsed;

              if (fullLength <= recoveryRequestBudget) {
                debugLog(documentId, 'ai:recovery:start', {
                  attempt: attempt + 1,
                  segment_index: missingSegment.index,
                  segment_total: missingSegment.total,
                  segment_chars: missingSegment.chars,
                  missing_block_count: segmentBlocks.length,
                  item_count: items.length,
                  item_mode: 'full',
                  prefix_chars: getMessagesContentLength(recoveryFixed),
                  prompt: getPromptSummary(fullMessages),
                });
                segmentParsed = await aiService.collectJsonResponse({
                  messages: fullMessages,
                  temperature: 0.1,
                  response_format: { type: 'json_object' },
                  logTitle: missingSegments.length > 1
                    ? `知识库遗漏补漏-${document.file_name}-第${attempt + 1}轮-第${missingSegment.index}段`
                    : `知识库遗漏补漏-${document.file_name}-第${attempt + 1}轮`,
                  normalizer: (value) => normalizeRecoveryResult(value, currentItemIds, segmentBlocks, segmentBlockOrder),
                  validator: validateRecoveryResult,
                  failureMessage: '知识库遗漏段落补漏失败，AI 未返回有效 JSON',
                  progressLabel: '知识库遗漏补漏',
                });
              } else {
                const itemSplitPrefix = [
                  ...buildRecoveryRuleMessages(document.file_name),
                  buildMissingBlocksUserMessage(segmentBlocks, missingSegment),
                ];
                const itemSegmentLimit = Math.max(1, recoveryRequestBudget - getMessagesContentLength(itemSplitPrefix));
                const itemSegments = packItemsIntoSegments(items, itemSegmentLimit);
                const subParsedList = [];
                debugLog(documentId, 'ai:recovery:item-split', {
                  attempt: attempt + 1,
                  segment_index: missingSegment.index,
                  item_segment_total: itemSegments.length,
                  item_segment_limit: itemSegmentLimit,
                });
                for (const itemSegment of itemSegments) {
                  const itemIds = new Set(itemSegment.itemIds);
                  const recoveryMessages = buildRecoveryMessages(
                    document.file_name,
                    itemSegment.items,
                    segmentBlocks,
                    missingSegment,
                    { itemSplit: true },
                  );
                  debugLog(documentId, 'ai:recovery:start', {
                    attempt: attempt + 1,
                    segment_index: missingSegment.index,
                    segment_total: missingSegment.total,
                    item_segment_index: itemSegment.index,
                    item_segment_total: itemSegment.total,
                    item_count: itemSegment.items.length,
                    item_mode: 'sub_batch',
                    prefix_chars: getMessagesContentLength(itemSplitPrefix),
                    prompt: getPromptSummary(recoveryMessages),
                  });
                  const subParsed = await aiService.collectJsonResponse({
                    messages: recoveryMessages,
                    temperature: 0.1,
                    response_format: { type: 'json_object' },
                    logTitle: `知识库遗漏补漏-${document.file_name}-第${attempt + 1}轮-第${missingSegment.index}段-条目${itemSegment.index}`,
                    normalizer: (value) => normalizeRecoveryResult(value, itemIds, segmentBlocks, segmentBlockOrder),
                    validator: validateRecoveryResult,
                    failureMessage: '知识库遗漏段落补漏失败，AI 未返回有效 JSON',
                    progressLabel: '知识库遗漏补漏',
                  });
                  subParsedList.push(subParsed);
                }
                segmentParsed = mergeRecoverySegmentResults(subParsedList, currentItemIds, segmentBlocks, segmentBlockOrder);
              }

              debugLog(documentId, 'ai:recovery:segment-done', {
                attempt: attempt + 1,
                segment_index: missingSegment.index,
                match_count: segmentParsed.matches.length,
                new_item_count: segmentParsed.new_items.length,
                discarded_group_count: segmentParsed.discarded.length,
              });
              return segmentParsed;
            };

            const firstSegmentParsed = await runMissingSegment(missingSegments[0]);
            if (missingSegments.length > 1) {
              debugLog(documentId, 'ai:recovery:warmup-wait', {
                attempt: attempt + 1,
                delay_ms: PROMPT_CACHE_WARMUP_DELAY_MS,
              });
              updateDocument(documentId, {
                status: 'recovering',
                progress: Math.min(96, 90 + attempt * 3),
                message: `补漏预热完成，等待后并发处理剩余 ${missingSegments.length - 1} 段遗漏 block`,
              }, webContents);
              await waitForPromptCacheWarmup();
            }
            const remainingParsed = missingSegments.length > 1
              ? await runParallelAndThrowAfterSettled(
                missingSegments.slice(1).map((segment) => () => runMissingSegment(segment)),
              )
              : [];
            const attemptMatchLists = [];
            const attemptNewItems = [];
            const attemptDiscarded = [];
            for (const segmentParsed of [firstSegmentParsed, ...remainingParsed]) {
              attemptMatchLists.push(segmentParsed.matches);
              attemptNewItems.push(...segmentParsed.new_items);
              attemptDiscarded.push(...segmentParsed.discarded);
            }

            // 以上游过滤后的 block_ids 为准，再压 ranges；禁止用脏 ranges 再展开
            const parsedMatches = mergeMatchResults(attemptMatchLists).map((match) => {
              if (!currentItemIds.has(match.id)) return null;
              const blockIds = [...new Set(match.block_ids || [])].filter((id) => blockOrder.has(id));
              const ranges = compressBlockIdsToRanges(blockIds, blockOrder);
              return ranges.length ? { id: match.id, ranges, block_ids: blockIds } : null;
            }).filter(Boolean);

            const newItemsWithIds = attemptNewItems.map((item) => {
              const blockIds = [...new Set(item.block_ids || [])].filter((id) => blockOrder.has(id));
              const ranges = compressBlockIdsToRanges(blockIds, blockOrder);
              if (!ranges.length) return null;
              const id = nextKnowledgeItemId(items);
              const next = { id, title: item.title, summary: item.summary };
              items.push(next);
              recoveredMatches.push({ id, ranges, block_ids: blockIds });
              return { ...next, ranges, block_ids: blockIds };
            }).filter(Boolean);

            const parsedDiscarded = attemptDiscarded.map((item) => {
              const blockIds = [...new Set(item.block_ids || [])].filter((id) => blockOrder.has(id));
              const ranges = compressBlockIdsToRanges(blockIds, blockOrder);
              return ranges.length ? {
                ranges,
                block_ids: blockIds,
                reason: item.reason || 'AI 建议舍弃',
                source: `recovery_${attempt + 1}`,
              } : null;
            }).filter(Boolean);

            recoveredMatches.push(...parsedMatches);
            discarded.push(...parsedDiscarded);
            recoveryAttempts.push({
              attempt: attempt + 1,
              missing_before_count: missingBlocks.length,
              segment_count: missingSegments.length,
              matches: parsedMatches,
              new_items: newItemsWithIds,
              discarded: parsedDiscarded,
            });
            debugLog(documentId, 'ai:recovery:done', {
              attempt: attempt + 1,
              match_count: parsedMatches.length,
              new_item_count: newItemsWithIds.length,
              discarded_group_count: parsedDiscarded.length,
              matches: getMatchSummary(parsedMatches),
            });
          }

          const remaining = getMissingBlocks(blocks, recoveredMatches, discarded, systemDiscarded);
          debugLog(documentId, 'match:remaining-after-recovery', { remaining_block_count: remaining.length });
          if (remaining.length) {
            systemDiscarded.push({
              block_ids: remaining.map((block) => block.id),
              reason: 'system_discarded_after_retry',
            });
          }

          return {
            items,
            matches: recoveredMatches,
            discarded,
            system_discarded: systemDiscarded,
            recovery_attempts: recoveryAttempts,
          };
        });
      }

      const savedItems = knowledgeBaseStore.readItems(documentId);
      const saveStep = getStep(documentId, 'save_result');
      if (!force && saveStep?.status === 'success' && savedItems.length) {
        debugLog(documentId, 'save:reuse', { item_count: savedItems.length });
        updateDocument(documentId, {
          status: 'success',
          progress: 100,
          message: `整理完成，共 ${savedItems.length} 条`,
          item_count: savedItems.length,
        }, webContents);
        return;
      }

      updateDocument(documentId, { status: 'saving', progress: 98, message: '正在回填正文并保存知识条目' }, webContents);
      const saveResult = await runDocumentStep(documentId, 'save_result', async () => {
        const finalItems = createFinalItems(recoveryResult.items, recoveryResult.matches, blocks, document.file_name);
        const report = createReport({
          blocks,
          filteredBlocks,
          candidateItems: recoveryResult.items,
          finalItems,
          matches: recoveryResult.matches,
          discarded: recoveryResult.discarded,
          systemDiscarded: recoveryResult.system_discarded,
          recoveryAttempts: recoveryResult.recovery_attempts,
          batchSize: blockSegments.length,
        });
        const matchResult = {
          candidate_items: recoveryResult.items,
          match_batches: matchBatches,
          recovery_attempts: recoveryResult.recovery_attempts,
          final_matches: recoveryResult.matches,
          discarded: recoveryResult.discarded,
          system_discarded_after_retry: recoveryResult.system_discarded,
          report,
        };

        knowledgeBaseStore.saveMatchResult(documentId, {
          candidateItems: recoveryResult.items,
          matchResult,
          report,
          finalItems,
        });
        debugLog(documentId, 'match:saved', {
          final_item_count: finalItems.length,
          report,
        });
        return { final_item_count: finalItems.length, report };
      });
      updateDocument(documentId, {
        status: 'success',
        progress: 100,
        message: `整理完成，共 ${saveResult.final_item_count} 条，覆盖率 ${Math.round(saveResult.report.coverage_rate * 100)}%`,
        item_count: saveResult.final_item_count,
        candidate_item_count: recoveryResult.items.length,
        discarded_block_count: saveResult.report.discarded_blocks_count,
        system_discarded_after_retry_count: saveResult.report.system_discarded_after_retry_count,
      }, webContents);
    } catch (error) {
      debugLog(documentId, 'match:error', {
        message: error.message || String(error),
        stack: error.stack,
      });
      updateDocument(documentId, {
        status: 'error',
        progress: 100,
        message: error.message || '匹配失败',
        error: error.message || '匹配失败',
      }, webContents);
    } finally {
      activeMatches.delete(documentId);
      debugLog(documentId, 'match:finish');
    }
  }

  return {
    getMigrationStatus() {
      recoverInterruptedDocuments();
      return knowledgeBaseStore.getMigrationStatus();
    },

    migrateLegacy() {
      const result = knowledgeBaseStore.migrateLegacy();
      recoverInterruptedDocuments();
      return { ...result, index: knowledgeBaseStore.list() };
    },

    list() {
      recoverInterruptedDocuments();
      return knowledgeBaseStore.list();
    },

    createFolder(name) {
      return knowledgeBaseStore.createFolder(name);
    },

    renameFolder(folderId, name) {
      return knowledgeBaseStore.renameFolder(folderId, name);
    },

    reorderFolder(draggedFolderId, targetFolderId, position) {
      return { success: true, message: '文件夹排序已保存', index: knowledgeBaseStore.reorderFolders(draggedFolderId, targetFolderId, position) };
    },

    deleteFolder(folderId) {
      const index = knowledgeBaseStore.list();
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
      knowledgeBaseStore.deleteFolder(folderId);
      return { success: true, message: `已删除文件夹“${folder.name}”及 ${documentsToDelete.length} 个文档` };
    },

    deleteDocument(documentId) {
      const document = getDocument(documentId);
      if (activePreparations.has(documentId) || activeMatches.has(documentId)) {
        throw new Error('该文档正在处理中，请完成后再删除');
      }

      deleteImportedImageBatches(app, `knowledge-${documentId}`);
      fs.rmSync(fromRelative(baseDir, document.document_dir), { recursive: true, force: true });
      fs.rmSync(getDebugLogPath(app, documentId), { force: true });
      knowledgeBaseStore.deleteDocument(documentId);
      return { success: true, message: `已删除文档“${document.file_name}”` };
    },

    moveDocument(documentId, targetFolderId, targetDocumentId, position) {
      const document = getDocument(documentId);
      if (activePreparations.has(documentId) || activeMatches.has(documentId)) {
        throw new Error('该文档正在处理中，请完成后再移动');
      }
      if (!['ready_for_matching', 'success', 'error'].includes(document.status)) {
        throw new Error('该文档正在处理中，请完成后再移动');
      }

      const index = knowledgeBaseStore.list();
      const targetFolder = index.folders.find((folder) => folder.id === targetFolderId);
      if (!targetFolder) throw new Error('目标知识库文件夹不存在');

      let moveOptions = { targetDocumentId, position };
      let oldDir = '';
      let newDir = '';
      if (document.folder_id !== targetFolderId) {
        const newDocumentDir = path.join('folders', targetFolderId, 'documents', documentId).replace(/\\/g, '/');
        oldDir = fromRelative(baseDir, document.document_dir);
        newDir = fromRelative(baseDir, newDocumentDir);
        if (!fs.existsSync(oldDir)) {
          throw new Error('文档文件不存在，无法移动');
        }
        if (fs.existsSync(newDir)) {
          throw new Error('目标文件夹中已存在同名文档目录，无法移动');
        }
        ensureDir(path.dirname(newDir));
        fs.renameSync(oldDir, newDir);
        moveOptions = {
          ...moveOptions,
          documentDir: newDocumentDir,
          sourcePath: rebaseDocumentRelativePath(document.source_path, document.document_dir, newDocumentDir),
          markdownPath: rebaseDocumentRelativePath(document.markdown_path, document.document_dir, newDocumentDir),
        };
      }

      try {
        const result = knowledgeBaseStore.moveDocument(documentId, targetFolderId, moveOptions);
        return { success: true, message: `已移动文档“${document.file_name}”`, index: result.index, document: result.document };
      } catch (error) {
        if (oldDir && newDir && fs.existsSync(newDir) && !fs.existsSync(oldDir)) {
          try {
            fs.renameSync(newDir, oldDir);
          } catch {
            // 回滚失败时保留原始错误，避免掩盖数据库更新问题。
          }
        }
        throw error;
      }
    },

    async uploadDocuments(folderId, webContents) {
      const currentIndex = knowledgeBaseStore.list();
      const folder = currentIndex.folders.find((item) => item.id === folderId);
      if (!folder) throw new Error('请先选择知识库文件夹');

      const result = await dialog.showOpenDialog({
        title: '选择知识库文档',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '知识库文档', extensions: ['doc', 'docx', 'wps', 'pdf', 'md', 'markdown', 'xls', 'xlsx'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePaths.length) {
        return { success: false, message: '已取消选择' };
      }

      const created = [];
      for (const filePath of result.filePaths) {
        const ext = path.extname(filePath).toLowerCase();
        if (!supportedExtensions.has(ext)) continue;
        const documentId = createId('doc');
        const documentDir = path.join('folders', folderId, 'documents', documentId).replace(/\\/g, '/');
        const sourceName = `source${ext}`;
        const document = {
          id: documentId,
          folder_id: folderId,
          file_name: path.basename(filePath),
          document_dir: documentDir,
          source_path: path.join(documentDir, sourceName).replace(/\\/g, '/'),
          markdown_path: path.join(documentDir, 'content.md').replace(/\\/g, '/'),
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
        };
        const savedDocument = knowledgeBaseStore.createDocument(document);
        created.push(savedDocument);
        emitProgress(webContents, savedDocument);
        prepareDocument(documentId, filePath, webContents);
      }

      return { success: Boolean(created.length), message: created.length ? `已加入 ${created.length} 个文档处理任务` : '未选择支持的文档类型', documents: created };
    },

    retryDocument(documentId, webContents) {
      const document = getDocument(documentId);
      debugLog(documentId, 'ipc:retry-document', { current_status: document.status });
      if (activePreparations.has(documentId) || activeMatches.has(documentId)) {
        return { success: false, message: '该文档正在处理中', document };
      }
      if (document.status !== 'error') {
        return { success: false, message: '只有解析失败的文档可以重试', document };
      }

      const sourcePath = fromRelative(baseDir, document.source_path);
      if (!fs.existsSync(sourcePath)) {
        return { success: false, message: '原始文件不存在，请重新上传', document };
      }

      prepareDocument(documentId, sourcePath, webContents);
      return { success: true, message: '已重新开始解析', document: getDocument(documentId) };
    },

    startMatching(documentId, _batchSize, webContents) {
      const document = getDocument(documentId);
      debugLog(documentId, 'ipc:start-matching', { current_status: document.status });
      if (activeMatches.has(documentId)) {
        return { success: false, message: '该文档正在匹配中', document };
      }
      if (!['ready_for_matching', 'success', 'error'].includes(document.status)) {
        return { success: false, message: '请等待候选知识条目提取完成', document };
      }
      // batchSize 已忽略，按模型上下文自动分段匹配
      matchDocument(documentId, webContents, { force: document.status === 'success' });
      return { success: true, message: '已开始自动分段匹配段落', document };
    },

    getOutlineReferences(documentIds) {
      return knowledgeBaseStore.getOutlineReferences(documentIds);
    },

    readMarkdown(documentId) {
      return knowledgeBaseStore.readMarkdown(documentId);
    },

    readItems(documentId) {
      return knowledgeBaseStore.readItems(documentId);
    },

    readAnalysis(documentId) {
      return knowledgeBaseStore.readAnalysis(documentId, { debugLogPath: isDeveloperMode() ? getDebugLogPath(app, documentId) : '' });
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
    packBlocksIntoSegments,
    packItemsIntoSegments,
    getKnowledgeBaseSegmentLimit,
    mergeTitleSummaryItems,
    mergeMatchResults,
    normalizeCandidateItems,
    normalizeMatchResult,
    normalizeRecoveryResult,
  },
};
