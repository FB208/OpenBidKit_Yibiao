const DEFAULT_MAX_LINE_CHARS = 2000;
const MIN_NATURAL_FRAGMENT_RATIO = 0.55;

// 合并重叠区间，供长行切分时保护 Markdown 图片和 HTML 标签。
function mergeRanges(ranges) {
  const sorted = ranges
    .filter(([start, end]) => Number.isInteger(start) && Number.isInteger(end) && end > start)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range[0] >= previous[1]) {
      merged.push([...range]);
    } else {
      previous[1] = Math.max(previous[1], range[1]);
    }
  }
  return merged;
}

// 判断当前位置是否被奇数个反斜杠转义。
function isEscaped(text, index) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

// 查找支持嵌套和转义的 Markdown 方括号结束位置。
function findClosingSquareBracket(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (isEscaped(text, index)) continue;
    if (text[index] === '[') depth += 1;
    if (text[index] === ']' && --depth === 0) return index;
  }
  return -1;
}

// 查找支持嵌套括号、引号和转义的 Markdown 图片目标结束位置。
function findClosingParenthesis(text, start) {
  let depth = 0;
  let quote = '';
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (isEscaped(text, index)) continue;
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if ((character === '"' || character === "'")
      && depth === 1
      && /\s/u.test(text[index - 1] || '')) {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')' && --depth === 0) {
      return index;
    }
  }
  return -1;
}

// 收集内联、引用式和快捷引用 Markdown 图片的完整范围。
function collectMarkdownImageRanges(line) {
  const ranges = [];
  for (let index = 0; index < line.length - 1; index += 1) {
    if (line[index] !== '!' || line[index + 1] !== '[' || isEscaped(line, index)) continue;
    const altEnd = findClosingSquareBracket(line, index + 1);
    if (altEnd < 0) continue;
    let end = altEnd + 1;
    if (line[end] === '(') {
      const targetEnd = findClosingParenthesis(line, end);
      if (targetEnd < 0) continue;
      end = targetEnd + 1;
    } else if (line[end] === '[') {
      const referenceEnd = findClosingSquareBracket(line, end);
      if (referenceEnd < 0) continue;
      end = referenceEnd + 1;
    }
    ranges.push([index, end]);
    index = end - 1;
  }
  return ranges;
}

// 收集 HTML 标签范围，属性引号内的 > 不视为标签结束。
function collectHtmlTagRanges(line) {
  const ranges = [];
  let start = line.indexOf('<');
  while (start >= 0) {
    if (line.startsWith('<!--', start)) {
      const commentEnd = line.indexOf('-->', start + 4);
      if (commentEnd < 0) break;
      ranges.push([start, commentEnd + 3]);
      start = line.indexOf('<', commentEnd + 3);
      continue;
    }
    let quote = '';
    let end = -1;
    for (let index = start + 1; index < line.length; index += 1) {
      const character = line[index];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        end = index + 1;
        break;
      }
    }
    if (end < 0) break;
    ranges.push([start, end]);
    start = line.indexOf('<', end);
  }
  return ranges;
}

// 找出不应在中间断开的 Markdown 图片和 HTML 标签。
function collectProtectedRanges(line) {
  return mergeRanges([
    ...collectMarkdownImageRanges(line),
    ...collectHtmlTagRanges(line),
  ]);
}

// 判断切点是否落在受保护内容内部；区间首尾允许作为切点。
function protectedRangeAt(ranges, cut) {
  let left = 0;
  let right = ranges.length - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const range = ranges[middle];
    if (cut <= range[0]) {
      right = middle - 1;
    } else if (cut >= range[1]) {
      left = middle + 1;
    } else {
      return range;
    }
  }
  return undefined;
}

// 避免在 UTF-16 代理对中间切开字符。
function safeUnicodeCut(line, cut, start) {
  if (cut <= start || cut >= line.length) return cut;
  const previous = line.charCodeAt(cut - 1);
  const next = line.charCodeAt(cut);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    return cut - 1 > start ? cut - 1 : Math.min(line.length, cut + 1);
  }
  return cut;
}

// 在上限附近优先寻找表格、HTML 或自然语言边界。
function findPreferredCut(line, start, target, ranges) {
  const minimum = start + Math.max(1, Math.floor((target - start) * MIN_NATURAL_FRAGMENT_RATIO));
  const isAvailable = cut => !protectedRangeAt(ranges, cut);
  for (let cut = target; cut >= minimum; cut -= 1) {
    if (!isAvailable(cut)) continue;
    const before = line[cut - 1] || '';
    const around = line.slice(Math.max(start, cut - 6), cut).toLowerCase();
    if ((before === '|' && line[cut - 2] !== '\\')
      || before === '>'
      || around.endsWith('</td>')
      || around.endsWith('</th>')
      || around.endsWith('</tr>')) {
      return safeUnicodeCut(line, cut, start);
    }
  }
  for (let cut = target; cut >= minimum; cut -= 1) {
    if (!isAvailable(cut)) continue;
    if (/\s|[。！？!?；;，,、：:]/u.test(line[cut - 1] || '')) {
      return safeUnicodeCut(line, cut, start);
    }
  }
  const protectedRange = protectedRangeAt(ranges, target);
  if (protectedRange) {
    return protectedRange[0] > start ? protectedRange[0] : protectedRange[1];
  }
  return safeUnicodeCut(line, target, start);
}

// 将一个物理原文行拆成可展示片段，所有字符保持原顺序且不丢失。
function splitLongLine(line, maxLineChars) {
  if (line.length <= maxLineChars) return [line];
  const ranges = collectProtectedRanges(line);
  const parts = [];
  let start = 0;
  while (start < line.length) {
    const target = Math.min(line.length, start + maxLineChars);
    if (target >= line.length) {
      parts.push(line.slice(start));
      break;
    }
    let cut = findPreferredCut(line, start, target, ranges);
    if (cut <= start) cut = safeUnicodeCut(line, target, start);
    parts.push(line.slice(start, cut));
    start = cut;
  }
  return parts;
}

// 为 Markdown 的真实物理行添加稳定行号；超长行使用同一行号和分片序号展示。
function numberMarkdownLines(markdown, options = {}) {
  const requestedLimit = Number(options?.maxLineChars);
  const maxLineChars = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.max(1, Math.floor(requestedLimit))
    : DEFAULT_MAX_LINE_CHARS;
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  return lines.flatMap((line, index) => {
    const lineId = `L${String(index + 1).padStart(6, '0')}`;
    const parts = splitLongLine(line, maxLineChars);
    if (parts.length === 1) return `${lineId} | ${parts[0]}`;
    return parts.map((part, partIndex) => `${lineId}[${partIndex + 1}/${parts.length}] | ${part}`);
  }).join('\n');
}

module.exports = {
  numberMarkdownLines,
};
