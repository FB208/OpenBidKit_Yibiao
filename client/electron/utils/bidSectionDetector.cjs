/**
 * 标段检测工具
 * 纯规则驱动，从招标文件 Markdown 中检测多标段信息。
 * 只返回检测到的标段列表，不做切分，下游根据用户选择的标段注入 AI 上下文。
 */

const chineseNumMap = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
  '壹': 1, '贰': 2, '叁': 3, '肆': 4, '伍': 5,
};

const arabicToChinese = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function normalizeChineseNumber(value) {
  const trimmed = String(value || '').trim();
  if (chineseNumMap[trimmed] !== undefined) {
    return chineseNumMap[trimmed];
  }
  const digit = Number(trimmed);
  if (Number.isFinite(digit) && digit >= 1 && digit <= 20) {
    return Math.floor(digit);
  }
  return null;
}

function formatChineseNumber(value) {
  return arabicToChinese[value] || String(value);
}

const totalSectionPattern = /(?:本?项目)?(?:共|总计|共计|合计)?(?:划分|分|设|拆|分拆)为?\s*(\d+|[一二三四五六七八九十]+)\s*个?\s*(?:标段|包|分包|标包|子项目)/g;

function detectTotalSectionCount(markdown) {
  const matches = [...String(markdown || '').matchAll(totalSectionPattern)];
  for (const match of matches) {
    const count = normalizeChineseNumber(match[1]);
    if (count && count >= 2) {
      return count;
    }
  }
  return null;
}

const sectionDefinitionPatterns = [
  /([一二三四五六七八九十壹贰叁肆伍]+)标段[：:]/g,
  /(\d+)标段[：:]/g,
  /第([一二三四五六七八九十壹贰叁肆伍\d]+)标段[：:]/g,
  /标段([一二三四五六七八九十壹贰叁肆伍\d]+)[：:]/g,
  /([一二三四五六七八九十壹贰叁肆伍]+)包[：:]/g,
  /(\d+)包[：:]/g,
  /第([一二三四五六七八九十壹贰叁肆伍\d]+)包[：:]/g,
  /包([一二三四五六七八九十壹贰叁肆伍\d]+)[：:]/g,
  /([一二三四五六七八九十壹贰叁肆伍]+)分包[：:]/g,
  /(\d+)分包[：:]/g,
  /第([一二三四五六七八九十壹贰叁肆伍\d]+)分包[：:]/g,
  /分包([一二三四五六七八九十壹贰叁肆伍\d]+)[：:]/g,
  /([一二三四五六七八九十壹贰叁肆伍]+)标包[：:]/g,
  /(\d+)标包[：:]/g,
];

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
  const headLine = text.slice(lineStart, lineEnd).trim();
  let descriptionEnd = lineEnd;
  let extraLines = 0;
  while (descriptionEnd < text.length && extraLines < 3) {
    const nextBreak = text.indexOf('\n', descriptionEnd + 1);
    if (nextBreak === -1) {
      descriptionEnd = text.length;
      break;
    }
    descriptionEnd = nextBreak;
    extraLines += 1;
    if (descriptionEnd - lineStart >= maxLength) {
      break;
    }
  }
  const description = text.slice(lineStart, Math.min(descriptionEnd, lineStart + maxLength))
    .replace(/\s+/g, ' ')
    .trim();
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

function detectBidSections(markdown) {
  const text = String(markdown || '');
  if (!text.trim()) {
    return { hasMultiple: false, sections: [], totalDeclared: null };
  }

  const totalDeclared = detectTotalSectionCount(text);
  if (totalDeclared === 1) {
    return { hasMultiple: false, sections: [], totalDeclared };
  }

  const rawSections = [];
  for (const pattern of sectionDefinitionPatterns) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      const index = normalizeChineseNumber(match[1]);
      if (index && index >= 1) {
        const { headLine, description } = extractLineContext(text, match.index);
        rawSections.push({
          index,
          id: `section-${index}`,
          title: `${formatChineseNumber(index)}标段`,
          headLine,
          description,
          matchIndex: match.index,
        });
      }
      match = pattern.exec(text);
    }
  }

  if (!rawSections.length) {
    return { hasMultiple: false, sections: [], totalDeclared };
  }

  const deduped = dedupeSections(rawSections);
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
    title: section.title,
    headLine: section.headLine,
    description: section.description,
  };
}

function buildSectionContextHint(selectedSection) {
  if (!selectedSection?.title) {
    return '';
  }
  return `本项目包含多个标段，投标人只投【${selectedSection.title}${selectedSection.headLine ? `（${selectedSection.headLine.replace(/^.*?标段[：:]\s*/, '')}）` : ''}】。请仅关注与【${selectedSection.title}】相关的评分标准、报价要求、采购清单、投标保证金、入围数量等内容，忽略其他标段特有的内容。通用条款（资格要求、合同条款、评标流程、投标文件格式等）正常参考。`;
}

module.exports = {
  detectBidSections,
  buildSectionContextHint,
};
