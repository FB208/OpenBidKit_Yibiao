/**
 * 标段检测工具。
 * 只用于快速判断招标文件是否疑似多标段，不生成最终标段列表。
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
  const digit = Number(trimmed);
  if (Number.isFinite(digit) && digit >= 1 && digit <= 99) {
    return Math.floor(digit);
  }
  if (chineseSmallMap[trimmed] !== undefined) {
    return chineseSmallMap[trimmed];
  }
  if (trimmed.length === 2 && trimmed[0] === '十') {
    const ones = chineseToDigit(trimmed[1]);
    return ones !== null ? 10 + ones : 10;
  }
  if (trimmed.length === 3 && trimmed[1] === '十') {
    const tens = chineseToDigit(trimmed[0]);
    const ones = chineseToDigit(trimmed[2]);
    if (tens !== null && ones !== null) return tens * 10 + ones;
  }
  if (trimmed.length === 2 && trimmed[1] === '十') {
    const tens = chineseToDigit(trimmed[0]);
    if (tens !== null) return tens * 10;
  }
  return null;
}

const totalSectionPattern = /(?:本?项目)?(?:共|总计|共计|合计)?(?:划分|分|设|拆|分拆)?为?\s*(\d+|[一二三四五六七八九十]+)\s*个?\s*(?:标段|包|分包|标包|标的|子项目)/g;

function detectTotalSectionCount(markdown) {
  const text = String(markdown || '');
  const matches = [...text.matchAll(totalSectionPattern)];
  if (!matches.length) return null;

  let sectionCount = null;
  let anyCount = null;
  for (const match of matches) {
    const count = normalizeChineseNumber(match[1]);
    if (count && count >= 2) {
      anyCount = anyCount === null ? count : Math.max(anyCount, count);
      if (/标段/.test(match[0])) {
        sectionCount = sectionCount === null ? count : Math.max(sectionCount, count);
      }
    }
  }
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

function getLineAt(text, index) {
  let lineStart = index;
  while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart -= 1;
  let lineEnd = index;
  while (lineEnd < text.length && text[lineEnd] !== '\n') lineEnd += 1;
  return text.slice(lineStart, lineEnd).trim();
}

function isCombinedSectionMention(line) {
  return /[一二三四五六七八九十\d]+[、,]\s*[一二三四五六七八九十\d]+\s*(?:标段|标包|分包|包)/.test(line);
}

function countDefinitionSections(text) {
  const detected = new Set();
  for (const { pattern, unit } of sectionDefinitionPatterns) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      const index = normalizeChineseNumber(match[1]);
      if (index && index >= 1 && !isCombinedSectionMention(getLineAt(text, match.index))) {
        detected.add(`${unit}:${index}`);
      }
      match = pattern.exec(text);
    }
  }
  return detected.size;
}

const bracketPattern = /^【(\d+)(?:-(\d+))?】/gm;

function isDocumentNumberLine(line) {
  return /[号文]$|^\s*【\d+】\d+\s*号/.test(line) || /号文/.test(line);
}

function countBracketSections(text) {
  bracketPattern.lastIndex = 0;
  const groups = new Set();
  const children = new Set();
  let match;
  while ((match = bracketPattern.exec(text)) !== null) {
    const parentNum = parseInt(match[1], 10);
    const childNum = match[2] ? parseInt(match[2], 10) : null;
    if (!parentNum || parentNum < 1 || isDocumentNumberLine(getLineAt(text, match.index))) continue;
    if (childNum) {
      children.add(`${parentNum}-${childNum}`);
    } else {
      groups.add(String(parentNum));
    }
  }
  return children.size >= 2 ? children.size : groups.size;
}

function detectBidSections(markdown) {
  const text = String(markdown || '');
  if (!text.trim()) {
    return { hasMultiple: false, totalDeclared: null };
  }

  const totalDeclared = detectTotalSectionCount(text);
  if (totalDeclared === 1) {
    return { hasMultiple: false, totalDeclared };
  }
  if (totalDeclared && totalDeclared >= 2) {
    return { hasMultiple: true, totalDeclared };
  }

  const detectedCount = Math.max(countDefinitionSections(text), countBracketSections(text));
  return {
    hasMultiple: detectedCount >= 2,
    totalDeclared,
  };
}

module.exports = {
  detectBidSections,
};
