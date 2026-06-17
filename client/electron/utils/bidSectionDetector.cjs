/**
 * 标段检测工具
 * 纯规则驱动，从招标文件 Markdown 中检测多标段信息。
 * 只返回检测到的标段列表，不做切分，下游根据用户选择的标段注入 AI 上下文。
 */

const chineseDigits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function chineseToDigit(ch) {
  const idx = chineseDigits.indexOf(ch);
  return idx >= 1 ? idx : null;
}

const chineseSmallMap = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
  '壹': 1, '贰': 2, '叁': 3, '肆': 4, '伍': 5,
};

function normalizeChineseNumber(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  // Arabic digit
  const digit = Number(trimmed);
  if (Number.isFinite(digit) && digit >= 1 && digit <= 99) {
    return Math.floor(digit);
  }
  // Single Chinese digit (一～十 / 壹～伍)
  if (chineseSmallMap[trimmed] !== undefined) {
    return chineseSmallMap[trimmed];
  }
  // Compound: 十一～十九
  if (trimmed.length === 2 && trimmed[0] === '十') {
    const ones = chineseToDigit(trimmed[1]);
    if (ones !== null) return 10 + ones;
    return 10; // 十 alone maps to 10
  }
  // 二十～九十九
  if (trimmed.length === 3 && trimmed[1] === '十') {
    const tens = chineseToDigit(trimmed[0]);
    const ones = chineseToDigit(trimmed[2]);
    if (tens !== null && ones !== null) return tens * 10 + ones;
  }
  // 二十 (2-char form without ones digit)
  if (trimmed.length === 2 && trimmed[1] === '十') {
    const tens = chineseToDigit(trimmed[0]);
    if (tens !== null) return tens * 10;
  }
  return null;
}

function formatChineseNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 1) return String(value);
  if (num <= 10) return chineseDigits[num];
  if (num < 20) return `十${chineseDigits[num - 10]}`;
  if (num <= 99) {
    const tens = Math.floor(num / 10);
    const ones = num % 10;
    const tensStr = chineseDigits[tens];
    const onesStr = ones > 0 ? chineseDigits[ones] : '';
    return `${tensStr}十${onesStr}`;
  }
  return String(num); // fallback for >= 100 (extremely unlikely for 标段)
}

const totalSectionPattern = /(?:本?项目)?(?:共|总计|共计|合计)?(?:划分|分|设|拆|分拆)?为?\s*(\d+|[一二三四五六七八九十]+)\s*个?\s*(?:标段|包|分包|标包|标的|子项目)/g;

function detectTotalSectionCount(markdown) {
  const text = String(markdown || '');
  const matches = [...text.matchAll(totalSectionPattern)];
  if (!matches.length) return null;

  // Collect all valid counts, noting whether each refers to 标段 specifically
  let sectionCount = null;
  let anyCount = null;
  for (const match of matches) {
    const count = normalizeChineseNumber(match[1]);
    if (count && count >= 2) {
      anyCount = anyCount === null ? count : Math.max(anyCount, count);
      // Prefer counts from matches that explicitly say 标段 (not 标的/包/etc.)
      const fullMatch = match[0];
      if (/标段/.test(fullMatch)) {
        sectionCount = sectionCount === null ? count : Math.max(sectionCount, count);
      }
    }
  }
  // Return 标段 count first, then fall back to any valid count
  return sectionCount ?? anyCount;
}

const sectionDefinitionPatterns = [
  { pattern: /([一二三四五六七八九十壹贰叁肆伍]+)标段[：:；;]/g, unit: '标段' },
  { pattern: /(\d+)标段[：:；;]/g, unit: '标段' },
  { pattern: /第([一二三四五六七八九十壹贰叁肆伍\d]+)标段[：:；;]/g, unit: '标段' },
  { pattern: /标段([一二三四五六七八九十壹贰叁肆伍\d]+)[：:；;]/g, unit: '标段' },
  { pattern: /([一二三四五六七八九十壹贰叁肆伍]+)标包[：:；;]/g, unit: '标包' },
  { pattern: /(\d+)标包[：:；;]/g, unit: '标包' },
  { pattern: /第([一二三四五六七八九十壹贰叁肆伍\d]+)标包[：:；;]/g, unit: '标包' },
  { pattern: /标包([一二三四五六七八九十壹贰叁肆伍\d]+)[：:；;]/g, unit: '标包' },
  { pattern: /([一二三四五六七八九十壹贰叁肆伍]+)分包[：:；;]/g, unit: '分包' },
  { pattern: /(\d+)分包[：:；;]/g, unit: '分包' },
  { pattern: /第([一二三四五六七八九十壹贰叁肆伍\d]+)分包[：:；;]/g, unit: '分包' },
  { pattern: /分包([一二三四五六七八九十壹贰叁肆伍\d]+)[：:；;]/g, unit: '分包' },
  { pattern: /([一二三四五六七八九十壹贰叁肆伍]+)包[：:；;]/g, unit: '包' },
  { pattern: /(\d+)包[：:；;]/g, unit: '包' },
  { pattern: /第([一二三四五六七八九十壹贰叁肆伍\d]+)包[：:；;]/g, unit: '包' },
  { pattern: /包([一二三四五六七八九十壹贰叁肆伍\d]+)[：:；;]/g, unit: '包' },
];

function getSectionUnit(title) {
  const match = String(title || '').match(/(标段|标包|分包|包)$/);
  return match?.[1] || '标段';
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/<[^>]*$/g, '')    // partial tag at truncation boundary
    .replace(/\s+/g, ' ')
    .trim();
}

function stripSectionPrefix(headLine) {
  return stripHtml(String(headLine || ''))
    .replace(/^.*?(?:标段|标包|分包|包)[：:；;]\s*/, '');
}

function extractLineContext(markdown, matchIndex, maxLength = 240) {
  const text = String(markdown || '');
  let lineStart = matchIndex;
  while (lineStart > 0 && text[lineStart - 1] !== '\n') {
    lineStart -= 1;
  }
  let lineEnd = matchIndex;
  while (lineEnd < text.length && text[lineEnd] !== '\n') {
    lineEnd += 1;
  }
  const rawHeadLine = text.slice(lineStart, lineEnd).trim();
  // Extract description: up to 3 extra lines, but stop before next section header
  const nextSectionPattern = /(?:\d{3}\s+)?(?:第[一二三四五六七八九十\d]+|[一二三四五六七八九十]+)\s*(?:标段|标包|分包|包)[：:；;]/g;
  let descriptionEnd = lineEnd;
  let extraLines = 0;
  while (descriptionEnd < text.length && extraLines < 3) {
    const nextBreak = text.indexOf('\n', descriptionEnd + 1);
    const chunkEnd = nextBreak === -1 ? Math.min(text.length, descriptionEnd + maxLength) : nextBreak;
    // Check for next section header within the upcoming chunk
    const ahead = text.slice(descriptionEnd, Math.min(descriptionEnd + maxLength, text.length));
    nextSectionPattern.lastIndex = 0;
    const nextMatch = nextSectionPattern.exec(ahead);
    if (nextMatch && nextMatch.index > 0) {
      descriptionEnd = descriptionEnd + nextMatch.index;
      break;
    }
    if (nextBreak === -1) {
      descriptionEnd = Math.min(text.length, descriptionEnd + maxLength);
      break;
    }
    descriptionEnd = nextBreak;
    extraLines += 1;
    if (descriptionEnd - lineStart >= maxLength) {
      break;
    }
  }
  const rawDescription = text.slice(lineStart, Math.min(descriptionEnd, lineStart + maxLength));
  const headLine = stripHtml(rawHeadLine);
  const description = stripHtml(rawDescription);
  return { headLine, description };
}

function dedupeSections(sections) {
  const seen = new Map();
  const result = [];
  for (const section of sections) {
    if (!seen.has(section.index)) {
      seen.set(section.index, section);
      result.push(section);
    } else {
      const existing = seen.get(section.index);
      if (section.description.length > existing.description.length) {
        seen.set(section.index, section);
        const existingIndex = result.findIndex((item) => item.index === section.index);
        if (existingIndex >= 0) {
          result[existingIndex] = section;
        }
      }
    }
  }
  return result.sort((a, b) => a.index - b.index);
}

// 【X-Y】/【X】 bracket patterns, common in 南方电网 / 国家电网 bidding documents.
// Only matches at line start to avoid false positives from in-text document numbers.
const bracketPattern = /^【(\d+)(?:-(\d+))?】/gm;

function isDocumentNumberLine(headLine) {
  // Skip lines that look like government document numbers: 【2021】7号文, etc.
  return /[号文]$|^\s*【\d+】\d+\s*号/.test(headLine) || /号文/.test(headLine);
}

function detectBracketSections(markdown) {
  const text = String(markdown || '');
  bracketPattern.lastIndex = 0;

  const raw = [];
  let match;
  while ((match = bracketPattern.exec(text)) !== null) {
    const parentNum = parseInt(match[1], 10);
    const childNum = match[2] ? parseInt(match[2], 10) : null;
    if (!parentNum || parentNum < 1) continue;
    const { headLine, description } = extractLineContext(text, match.index);
    // Skip government document number lines (e.g. 【2021】7号)
    if (isDocumentNumberLine(headLine)) continue;
    if (!childNum) {
      raw.push({
        index: parentNum,
        id: `section-${parentNum}`,
        unit: '标的',
        title: `标的${parentNum}`,
        headLine,
        description,
        matchIndex: match.index,
        bracketParent: parentNum,
        bracketChild: null,
        isBracketGroup: true,
      });
    } else {
      raw.push({
        index: parentNum * 100 + childNum,
        id: `section-${parentNum}-${childNum}`,
        unit: '标段',
        title: `标段${parentNum}-${childNum}`,
        headLine,
        description,
        matchIndex: match.index,
        bracketParent: parentNum,
        bracketChild: childNum,
        isBracketGroup: false,
      });
    }
  }

  // If we have child sections (X-Y), exclude the parent group headings (X only)
  const childSections = raw.filter((s) => !s.isBracketGroup);
  if (childSections.length >= 2) {
    return childSections;
  }
  // If only group headings exist (no children), return them as sections
  const groupSections = raw.filter((s) => s.isBracketGroup);
  if (groupSections.length >= 2 && childSections.length === 0) {
    return groupSections;
  }
  // Mixed or single: prefer children
  return childSections.length >= 2 ? childSections : [];
}

function detectBidSections(markdown) {
  const text = String(markdown || '');
  if (!text.trim()) {
    return { hasMultiple: false, sections: [], totalDeclared: null };
  }

  const totalDeclared = detectTotalSectionCount(text);
  if (totalDeclared === 1) {
    return { hasMultiple: false, sections: [], totalDeclared };
  }

  // Detect via explicit section label patterns (e.g. 一标段：, 第1标段：)
  const rawSections = [];
  for (const { pattern, unit } of sectionDefinitionPatterns) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      const index = normalizeChineseNumber(match[1]);
      if (index && index >= 1) {
        const { headLine, description } = extractLineContext(text, match.index);
        // Skip combined references like "第一、三标段" where the match
        // is part of a multi-section mention separated by 、or 、.
        if (/[一二三四五六七八九十\d]+[、,]\s*[一二三四五六七八九十\d]+\s*(?:标段|标包|分包|包)/.test(headLine)) {
          match = pattern.exec(text);
          continue;
        }
        rawSections.push({
          index,
          id: `section-${index}`,
          unit,
          title: `${formatChineseNumber(index)}${unit}`,
          headLine,
          description,
          matchIndex: match.index,
        });
      }
      match = pattern.exec(text);
    }
  }

  // Detect via 【X-Y】/【X】 bracket notation (common in 南方电网/国家电网 documents)
  const bracketSections = detectBracketSections(text);
  // Merge bracket and pattern results; deduplication handles overlaps.
  // Bracket child sections (X-Y) are more specific and should take priority
  // when they cover the same index range as pattern sections.
  const bracketHasChildren = bracketSections.some((s) => s.unit === '标段');
  const allSections = bracketHasChildren && bracketSections.length >= rawSections.length
    ? bracketSections
    : [...rawSections, ...bracketSections];

  if (!allSections.length) {
    return { hasMultiple: false, sections: [], totalDeclared };
  }

  const deduped = dedupeSections(allSections);
  if (deduped.length < 2) {
    return { hasMultiple: false, sections: deduped.map(toSectionOutput), totalDeclared };
  }

  const hasMultiple = totalDeclared ? totalDeclared >= 2 : deduped.length >= 2;
  return {
    hasMultiple,
    sections: deduped.map(toSectionOutput),
    totalDeclared,
  };
}

function toSectionOutput(section) {
  return {
    id: section.id,
    index: section.index,
    unit: section.unit,
    title: section.title,
    headLine: section.headLine,
    description: section.description,
  };
}

function buildSectionContextHint(selectedSection) {
  if (!selectedSection?.title) {
    return '';
  }
  const unit = getSectionUnit(selectedSection.title);
  const detail = selectedSection.headLine ? stripSectionPrefix(selectedSection.headLine) : '';
  return `本项目包含多个${unit}，投标人只投【${selectedSection.title}${detail ? `（${detail}）` : ''}】。请仅关注与【${selectedSection.title}】相关的评分标准、报价要求、采购清单、投标保证金、入围数量等内容，忽略其他${unit}特有的内容。通用条款（资格要求、合同条款、评标流程、投标文件格式等）正常参考。`;
}

module.exports = {
  detectBidSections,
  buildSectionContextHint,
};
