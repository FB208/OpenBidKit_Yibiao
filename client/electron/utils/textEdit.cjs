function normalizeNewlines(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function detectLineEnding(text) {
  return String(text || '').includes('\r\n') ? '\r\n' : '\n';
}

function convertToContentLineEnding(text, content) {
  const normalized = normalizeNewlines(text);
  const lineEnding = detectLineEnding(content);
  return lineEnding === '\n' ? normalized : normalized.replace(/\n/g, '\r\n');
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function splitLinesWithRanges(content) {
  const text = String(content || '');
  const lines = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '\r' && char !== '\n') {
      continue;
    }

    const lineEnd = index;
    const newlineEnd = char === '\r' && text[index + 1] === '\n' ? index + 2 : index + 1;
    lines.push({ text: text.slice(start, lineEnd), start, end: lineEnd, newlineEnd });
    start = newlineEnd;
    if (newlineEnd > index + 1) {
      index += 1;
    }
  }

  if (start < text.length || !lines.length) {
    lines.push({ text: text.slice(start), start, end: text.length, newlineEnd: text.length });
  }

  return lines;
}

function searchLines(text) {
  const lines = normalizeNewlines(text).split('\n');
  while (lines.length && lines[0].trim() === '') {
    lines.shift();
  }
  while (lines.length && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines;
}

function createMatch(strategy, content, start, end) {
  return {
    strategy,
    start,
    end,
    length: Math.max(0, end - start),
    text: String(content || '').slice(start, end),
  };
}

function dedupeMatches(matches) {
  const seen = new Set();
  const result = [];
  for (const match of matches || []) {
    const key = `${match.start}:${match.end}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(match);
  }
  return result.sort((a, b) => a.start - b.start || a.end - b.end);
}

function findExactMatches(content, oldText) {
  const text = String(content || '');
  const needle = convertToContentLineEnding(oldText, text);
  const matches = [];
  if (!needle) {
    return matches;
  }

  let startIndex = 0;
  while (startIndex <= text.length) {
    const index = text.indexOf(needle, startIndex);
    if (index < 0) {
      break;
    }
    matches.push(createMatch('exact', text, index, index + needle.length));
    startIndex = index + Math.max(needle.length, 1);
  }
  return matches;
}

function findTrimmedBoundaryMatches(content, oldText) {
  const trimmed = String(oldText || '').trim();
  if (!trimmed || trimmed === String(oldText || '')) {
    return [];
  }
  return findExactMatches(content, trimmed).map((match) => ({ ...match, strategy: 'trimmed-boundary' }));
}

function findLineTrimmedMatches(content, oldText) {
  const lines = splitLinesWithRanges(content);
  const wantedLines = searchLines(oldText);
  if (!wantedLines.length) {
    return [];
  }

  const matches = [];
  for (let startLine = 0; startLine <= lines.length - wantedLines.length; startLine += 1) {
    let matched = true;
    for (let offset = 0; offset < wantedLines.length; offset += 1) {
      if (lines[startLine + offset].text.trim() !== wantedLines[offset].trim()) {
        matched = false;
        break;
      }
    }
    if (!matched) {
      continue;
    }
    const start = lines[startLine].start;
    const end = lines[startLine + wantedLines.length - 1].end;
    matches.push(createMatch('line-trimmed', content, start, end));
  }

  return matches;
}

function findWhitespaceNormalizedMatches(content, oldText) {
  const lines = splitLinesWithRanges(content);
  const wantedLines = searchLines(oldText);
  const wanted = normalizeWhitespace(wantedLines.join('\n'));
  if (!wanted) {
    return [];
  }

  const matches = [];
  const blockSize = Math.max(1, wantedLines.length);
  for (let startLine = 0; startLine <= lines.length - blockSize; startLine += 1) {
    const block = lines.slice(startLine, startLine + blockSize).map((line) => line.text).join('\n');
    if (normalizeWhitespace(block) !== wanted) {
      continue;
    }
    const start = lines[startLine].start;
    const end = lines[startLine + blockSize - 1].end;
    matches.push(createMatch('whitespace-normalized', content, start, end));
  }
  return matches;
}

function levenshtein(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right) {
    return Math.max(left.length, right.length);
  }

  const previous = Array.from({ length: right.length + 1 }, (_item, index) => index);
  const current = Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
    }
    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = current[j];
    }
  }
  return previous[right.length];
}

function lineSimilarity(a, b) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  const maxLength = Math.max(left.length, right.length);
  if (!maxLength) {
    return 1;
  }
  return 1 - (levenshtein(left, right) / maxLength);
}

function blockSimilarity(actualLines, wantedLines) {
  const count = Math.min(actualLines.length, wantedLines.length);
  if (count <= 2) {
    return 1;
  }

  let total = 0;
  let compared = 0;
  for (let index = 1; index < count - 1; index += 1) {
    total += lineSimilarity(actualLines[index], wantedLines[index]);
    compared += 1;
  }
  return compared ? total / compared : 1;
}

function findBlockAnchorMatches(content, oldText, options = {}) {
  const wantedLines = searchLines(oldText);
  if (wantedLines.length < 3) {
    return [];
  }

  const lines = splitLinesWithRanges(content);
  const first = wantedLines[0].trim();
  const last = wantedLines[wantedLines.length - 1].trim();
  const maxLineDelta = Math.max(1, Math.floor(wantedLines.length * 0.25));
  const threshold = Number.isFinite(options.blockAnchorSimilarityThreshold)
    ? options.blockAnchorSimilarityThreshold
    : 0.65;
  const matches = [];

  for (let startLine = 0; startLine < lines.length; startLine += 1) {
    if (lines[startLine].text.trim() !== first) {
      continue;
    }

    for (let endLine = startLine + 2; endLine < lines.length; endLine += 1) {
      if (lines[endLine].text.trim() !== last) {
        continue;
      }

      const actualSize = endLine - startLine + 1;
      if (Math.abs(actualSize - wantedLines.length) > maxLineDelta) {
        continue;
      }

      const actualLines = lines.slice(startLine, endLine + 1).map((line) => line.text);
      if (blockSimilarity(actualLines, wantedLines) < threshold) {
        continue;
      }

      matches.push(createMatch('block-anchor', content, lines[startLine].start, lines[endLine].end));
      break;
    }
  }

  return matches;
}

function findTextMatches(content, oldText, options = {}) {
  const source = String(content || '');
  const wanted = String(oldText || '');
  if (!wanted) {
    return {
      found: false,
      unique: false,
      count: 0,
      strategy: '',
      matches: [],
      errors: ['oldText 不能为空'],
    };
  }

  const strategies = [
    () => findExactMatches(source, wanted),
    () => findLineTrimmedMatches(source, wanted),
    () => findWhitespaceNormalizedMatches(source, wanted),
    () => findTrimmedBoundaryMatches(source, wanted),
    () => findBlockAnchorMatches(source, wanted, options),
  ];

  for (const find of strategies) {
    const matches = dedupeMatches(find());
    if (!matches.length) {
      continue;
    }
    return {
      found: true,
      unique: matches.length === 1,
      count: matches.length,
      strategy: matches[0].strategy,
      matches,
      errors: [],
    };
  }

  return {
    found: false,
    unique: false,
    count: 0,
    strategy: '',
    matches: [],
    errors: ['Could not find oldText in content. It must match exactly or include enough surrounding context.'],
  };
}

function isDisproportionateMatch(matchText, oldText) {
  const matchLines = normalizeNewlines(matchText).split('\n').length;
  const oldLines = normalizeNewlines(oldText).split('\n').length;
  if (matchLines >= Math.max(oldLines + 3, oldLines * 2)) {
    return true;
  }
  if (oldLines === 1) {
    return false;
  }
  return String(matchText || '').trim().length > Math.max(String(oldText || '').trim().length + 500, String(oldText || '').trim().length * 4);
}

function createEditSummary(edit, match, index) {
  return {
    status: 'applied',
    index,
    strategy: match.strategy || 'range',
    start: match.start,
    end: match.end,
    oldLength: Math.max(0, match.end - match.start),
    newLength: String(edit.newText ?? '').length,
  };
}

function createResult(content, changed, edits = [], errors = []) {
  return { content, changed, edits, errors };
}

function validateTextEdit(edit) {
  const oldText = String(edit?.oldText ?? edit?.old_text ?? '');
  const newText = String(edit?.newText ?? edit?.new_text ?? '');
  if (!oldText) {
    return { oldText, newText, error: 'oldText 不能为空' };
  }
  if (oldText === newText) {
    return { oldText, newText, error: 'oldText 和 newText 不能相同' };
  }
  return { oldText, newText, error: '' };
}

function validateNonOverlapping(matches) {
  const ordered = [...matches].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start < ordered[index - 1].end) {
      return `edit ranges overlap: ${ordered[index - 1].start}-${ordered[index - 1].end} and ${ordered[index].start}-${ordered[index].end}`;
    }
  }
  return '';
}

function planTextEdits(content, edits, options = {}) {
  const planned = [];
  const errors = [];
  const source = String(content || '');

  for (const [index, edit] of (edits || []).entries()) {
    const { oldText, newText, error } = validateTextEdit(edit);
    if (error) {
      errors.push(`edit[${index}] ${error}`);
      continue;
    }

    const result = findTextMatches(source, oldText, options);
    if (!result.found) {
      errors.push(`edit[${index}] ${result.errors[0] || 'oldText 未命中'}`);
      continue;
    }
    if (!edit?.replaceAll && result.matches.length > 1) {
      errors.push(`edit[${index}] Found multiple matches for oldText. Provide more surrounding context to make the match unique.`);
      continue;
    }

    const normalizedNewText = convertToContentLineEnding(newText, source);
    for (const match of result.matches) {
      if (isDisproportionateMatch(match.text, oldText)) {
        errors.push(`edit[${index}] Refusing replacement because the matched span is much larger than oldText.`);
        continue;
      }
      planned.push({ index, oldText, newText: normalizedNewText, match });
    }
  }

  const overlapError = validateNonOverlapping(planned.map((item) => item.match));
  if (overlapError) {
    errors.push(overlapError);
  }
  return { planned, errors };
}

function applyPlannedEdits(content, planned) {
  let nextContent = String(content || '');
  const applied = [];
  const ordered = [...planned].sort((a, b) => b.match.start - a.match.start || b.match.end - a.match.end);
  for (const item of ordered) {
    nextContent = `${nextContent.slice(0, item.match.start)}${item.newText}${nextContent.slice(item.match.end)}`;
    applied.unshift(createEditSummary({ newText: item.newText }, item.match, item.index));
  }
  return { content: nextContent, applied };
}

function applyTextEdit(content, edit, options = {}) {
  return applyTextEdits(content, [edit], options);
}

function applyTextEdits(content, edits, options = {}) {
  const source = String(content || '');
  const { planned, errors } = planTextEdits(source, edits, options);
  if (errors.length) {
    return createResult(source, false, [], errors);
  }
  if (!planned.length) {
    return createResult(source, false, [], []);
  }

  const result = applyPlannedEdits(source, planned);
  return createResult(result.content, result.content !== source, result.applied, []);
}

function normalizeRangeEdit(content, edit, index = 0) {
  const source = String(content || '');
  const start = Number(edit?.start);
  const end = Number(edit?.end);
  const newText = String(edit?.newText ?? edit?.new_text ?? '');
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { error: `rangeEdit[${index}] start/end 必须是整数` };
  }
  if (start < 0 || end < start || end > source.length) {
    return { error: `rangeEdit[${index}] range 越界或无效：${start}-${end}` };
  }
  const normalizedNewText = convertToContentLineEnding(newText, source);
  if (source.slice(start, end) === normalizedNewText) {
    return { error: `rangeEdit[${index}] 替换内容没有变化` };
  }
  return { start, end, newText: normalizedNewText, error: '' };
}

function applyRangeEdit(content, edit) {
  return applyRangeEdits(content, [edit]);
}

function applyRangeEdits(content, edits) {
  const source = String(content || '');
  const planned = [];
  const errors = [];
  for (const [index, edit] of (edits || []).entries()) {
    const normalized = normalizeRangeEdit(source, edit, index);
    if (normalized.error) {
      errors.push(normalized.error);
      continue;
    }
    planned.push({ index, match: createMatch('range', source, normalized.start, normalized.end), newText: normalized.newText });
  }

  const overlapError = validateNonOverlapping(planned.map((item) => item.match));
  if (overlapError) {
    errors.push(overlapError);
  }
  if (errors.length) {
    return createResult(source, false, [], errors);
  }
  if (!planned.length) {
    return createResult(source, false, [], []);
  }

  const result = applyPlannedEdits(source, planned);
  return createResult(result.content, result.content !== source, result.applied, []);
}

module.exports = {
  findTextMatches,
  applyTextEdit,
  applyTextEdits,
  applyRangeEdit,
  applyRangeEdits,
};
