const { countReadableWords } = require('../utils/wordCount.cjs');
const { numberMarkdownLines } = require('../utils/markdownLineView.cjs');

const ORIGINAL_PLAN_HEADING_INSTRUCTION = '方案中的编号应该遵循新生成的目录结构，原方案中的标题根据实际情况保留或去除，保留的话要注意重新编号，以保证序号合理连贯。当前小节的外层标题由程序生成，不要重复输出。年份、型号及“3D”等属于标题含义的文字必须保留，不得当作编号删除。保留的内部标题用单行加粗文字表示。';

// 提取导入图片引用，保留出现顺序和次数，兼容正文及 HTML 表格内图片。
function originalImageReferences(content) {
  const references = [];
  const pattern = /!\[[^\]]*\]\(<?(yibiao-asset:\/\/imported-images\/[^\s<>)]*)>?(?:\s+"[^"]*")?\)|<img\b[^>]*\bsrc=["'](yibiao-asset:\/\/imported-images\/[^"']+)["'][^>]*>/gi;
  for (const match of String(content || '').matchAll(pattern)) references.push(match[1] || match[2]);
  return references;
}

// 已有原图必须原序保留，不能引入属于其他小节的原图；生成图片不参与本检查。
function validateOriginalImages(expected, content, sourceImages = expected) {
  const known = new Set([...sourceImages, ...expected]);
  const actual = originalImageReferences(content).filter(url => known.has(url));
  if (actual.length !== expected.length || actual.some((url, index) => url !== expected[index])) {
    throw new Error('原方案图片遗漏、重复或顺序/归属改变，请原样保留本小节全部原图引用');
  }
}

// 标题内容由 Agent 决定；按声明重建结果，只核对改动范围，不推算或删除编号。
function restoredAssignmentContent(source, assignment) {
  if (!Array.isArray(assignment.heading_edits)) throw new Error('还原项必须提供 heading_edits 数组，无标题时填 []');
  const headings = new Map();
  for (const edit of assignment.heading_edits) {
    const { line, content } = edit || {};
    if (!Number.isInteger(line) || headings.has(line)
      || !assignment.source_ranges.some(range => line >= range.start_line && line <= range.end_line)
      || source.tables.some(table => line >= table.start_line && line <= table.end_line)) {
      throw new Error(`标题行无效、重复或位于表格中：${line}`);
    }
    if (!source.lines[line - 1].trim() || /[<>]|!\[/.test(source.lines[line - 1])
      || typeof content !== 'string' || /[<>\n\r]|!\[/.test(content)) {
      throw new Error('标题调整只能处理独立文字标题，内容须为单行文字或空字符串');
    }
    headings.set(line, content);
  }
  const bodyLines = assignment.source_ranges.flatMap(range => source.lines.slice(range.start_line - 1, range.end_line)
    .filter((line, index) => !headings.has(range.start_line + index) && line.trim()));
  if (!bodyLines.length) throw new Error('仅有标题、没有正文或图片的范围应列入 unassigned');
  return assignment.source_ranges.map(range => source.lines.slice(range.start_line - 1, range.end_line)
    .flatMap((line, index) => {
      const lineNumber = range.start_line + index;
      if (!headings.has(lineNumber)) return [line];
      const heading = headings.get(lineNumber);
      return heading === '' ? [] : [heading];
    }).join('\n')).join('\n\n').trim();
}

// 完整文件只建立行索引，不预先切分语义段落；行号从 1 开始，首尾均包含。
function createOriginalSource(markdown) {
  const content = String(markdown || '').replace(/\r\n?/g, '\n');
  const lines = content.split('\n');
  const tables = [];
  let depth = 0;
  let tableStart = 0;
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(/<\/?table\b[^>]*>/gi)) {
      if (/^<\//.test(match[0])) {
        if (depth > 0 && --depth === 0) tables.push({ start_line: tableStart, end_line: index + 1 });
      } else if (depth++ === 0) tableStart = index + 1;
    }
    // 分隔行可只有一列；表头和分隔行须含竖线，避免把普通 --- 当成表格。
    if (index > 0 && lines[index - 1].includes('|') && lines[index].includes('|')
      && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[index])) {
      let end = index;
      while (end + 1 < lines.length && lines[end + 1].trim() && lines[end + 1].includes('|')) end += 1;
      tables.push({ start_line: index, end_line: end + 1 });
    }
  }
  if (depth) tables.push({ start_line: tableStart, end_line: lines.length });
  return { content, lines, tables, images: originalImageReferences(content) };
}

// 按 Agent 指定的原文行范围取回原文，供保存和后续覆盖检查复用。
function readOriginalRange(source, range) {
  return source.lines.slice(range.start_line - 1, range.end_line).join('\n');
}

// 构建完整原方案、目录和背景输入；其他小节的来源仅用于核对全文覆盖情况。
function buildOriginalRestorationFiles({ source, targetsText, contextText, coveredRanges }) {
  return [
    { path: 'original-plan-numbered.md', content: numberMarkdownLines(source.content) },
    { path: 'original-plan.md', content: source.content },
    { path: 'restore-targets.md', content: targetsText },
    { path: 'context.md', content: contextText },
    { path: 'covered-ranges.json', content: JSON.stringify(coveredRanges) },
  ];
}

// 由 Agent 按语义还原原文；程序校验来源和完整性。
function buildOriginalRestorationPrompt({ resume = false } = {}) {
  return `${resume ? '继续同一次原方案还原任务。先检查工作区已有输出文件，接着完成未完成的工作，并重新校验完整结果。\n' : ''}你负责将已有技术方案原文还原到新目录，供后续扩写使用。
先阅读 original-plan-numbered.md 行号视图、restore-targets.md 目标叶子小节、context.md 项目背景和 covered-ranges.json 其他小节已覆盖的原文范围。original-plan.md 是无行号的完整原方案，需要核对原始 Markdown 结构时可以读取。
行号视图的普通行格式为“L000001 | 原文”；超长原文行会显示为“L000001[1/3] | 第一段”等多个分片。相同 L 编号的所有分片仍属于同一个真实原文行，不得拆给不同小节；source_ranges 和 heading_edits 只填写不带 L 前缀及分片序号的真实行号。
不要依赖固定长度切块。自行分析主题、章节职责和上下文，将不同主题的原文分别放到最合适的小节。
HTML 和 Markdown 表格必须完整保留，禁止切断表格。
尽可能完整还原实质内容，保留原文措辞、数据和格式，不总结、不压缩、不扩写。${ORIGINAL_PLAN_HEADING_INSTRUCTION}
识别原文中的独立标题行，在 heading_edits 中逐项记录原文件行号 line 和处理后的完整标题 content；删除标题时 content 填空字符串。标题的去留、层级和编号由你按新目录判断，保留标题的原意。不得将正文、参数、列表步骤、表格或图片行声明成标题。只有标题没有正文或图片时，不要当作实质正文还原，填写未还原原因。
原方案图片是已有内容，必须随对应文字/证书标题一起还原，保留完整图片引用、顺序和原位置，不使用生图替代，不受新增配图数量设置影响；图片本身也属于实质内容。不得把图片列入 unassigned。
node_id 必须来自目标小节。原文范围用 start_line 和 end_line，行号从 1 开始且包含首尾。公共行号视图已由程序生成，通常不需要自行编写脚本计算行号；如果判断或修正需要，仍可使用 read、find 或 bash 核对工作区文件。
每个小节只输出一条 assignment；source_ranges 按原文顺序排列。heading_edits 必须提供，无标题时填 []，其中每项的标题 content 仍须填写。程序会根据 source_ranges 和 heading_edits 从无行号原文逐字重建小节正文，不要在 assignment 顶层输出正文 content 字段。
covered-ranges.json 仅用于核对全文覆盖情况。所有非空原文行须由已有覆盖范围或本次 assignments 覆盖；尚未覆盖的原文列入 unassigned 并说明原因，不能静默遗漏。
最终写入 original-restore-result.json，格式：
{"assignments":[{"node_id":"1.1","source_ranges":[{"start_line":1,"end_line":8}],"heading_edits":[{"line":1,"content":"**1.1.1 实施安排**"}]}],"unassigned":[{"start_line":9,"end_line":10,"reason":"不适用于正文的签章栏"}]}
程序已为 original-restore-result.json 预置 JSON Schema，write/edit 会自动校验。完成后调用 json-validation，只传 {"file_path":"original-restore-result.json"}；失败时按工具反馈修正文件。
不要修改输入文件或业务数据库。JSON 格式通过后，程序还会检查原文、表格、图片和覆盖范围；如有错误，按反馈在当前会话中修正输出文件。`;
}

// 结构校验交给新版 JSON 工具；范围、标题和覆盖完整性仍由业务校验检查。
const ORIGINAL_RESTORATION_JSON_SCHEMA = {
  type: 'object', required: ['assignments', 'unassigned'], additionalProperties: false,
  $defs: {
    range: {
      type: 'object', required: ['start_line', 'end_line'], additionalProperties: false,
      properties: { start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } },
    },
  },
  properties: {
    assignments: {
      type: 'array', items: {
        type: 'object', required: ['node_id', 'source_ranges', 'heading_edits'], additionalProperties: false,
        properties: {
          node_id: { type: 'string', minLength: 1 },
          source_ranges: { type: 'array', minItems: 1, items: { $ref: '#/$defs/range' } },
          heading_edits: {
            type: 'array', items: {
              type: 'object', required: ['line', 'content'], additionalProperties: false,
              properties: { line: { type: 'integer', minimum: 1 }, content: { type: 'string' } },
            },
          },
        },
      },
    },
    unassigned: {
      type: 'array', items: {
        type: 'object', required: ['start_line', 'end_line', 'reason'], additionalProperties: false,
        properties: {
          start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 },
          reason: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};

// 验证范围、标题和表格完整性，按原始行重建正文并检查全文覆盖情况。
function validateOriginalRestoration(value, { source, allowedNodeIds, coveredRanges = [] }) {
  if (!Array.isArray(value?.assignments) || !Array.isArray(value?.unassigned)) {
    throw new Error('原方案还原结果必须包含 assignments 和 unassigned 数组');
  }
  const restoredLines = new Set();
  const unassignedLines = new Set();
  const nodeIds = new Set();
  const assignments = [];
  // 汇总已覆盖与未还原的行，未还原记录不能与已有覆盖相矛盾。
  function claim(range, unassigned = false) {
    const { start_line: start, end_line: end } = range || {};
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > source.lines.length) {
      throw new Error(`原文行范围无效：${JSON.stringify(range)}`);
    }
    for (let index = start - 1; index < end; index += 1) {
      if (unassigned && (restoredLines.has(index) || unassignedLines.has(index))) {
        throw new Error(`原文第 ${index + 1} 行已覆盖或重复列入未还原范围`);
      }
      (unassigned ? unassignedLines : restoredLines).add(index);
    }
    for (const table of source.tables) {
      if (start <= table.end_line && end >= table.start_line && (start > table.start_line || end < table.end_line)) {
        throw new Error(`第 ${table.start_line}-${table.end_line} 行表格被切断，请完整分配`);
      }
    }
  }
  for (const range of coveredRanges) claim(range);
  for (const assignment of value.assignments) {
    if (!allowedNodeIds.has(assignment.node_id) || nodeIds.has(assignment.node_id)) {
      throw new Error(`还原小节 ID 无效或重复：${assignment.node_id}`);
    }
    nodeIds.add(assignment.node_id);
    if (!Array.isArray(assignment.source_ranges) || !assignment.source_ranges.length) {
      throw new Error(`小节 ${assignment.node_id} 缺少 source_ranges`);
    }
    let lastEnd = 0;
    for (const range of assignment.source_ranges) {
      claim(range);
      if (range.start_line <= lastEnd) throw new Error(`小节 ${assignment.node_id} 的原文范围须按原文顺序排列`);
      lastEnd = range.end_line;
    }
    assignments.push({ ...assignment, content: restoredAssignmentContent(source, assignment) });
  }
  for (const range of value.unassigned) {
    if (typeof range.reason !== 'string' || !range.reason.trim()) throw new Error('未还原原文必须说明原因');
    claim(range, true);
    if (originalImageReferences(readOriginalRange(source, range)).length) throw new Error('原方案图片不得遗漏，请将图片还原到对应小节');
  }
  const missing = source.lines.findIndex((line, index) => line.trim() && !restoredLines.has(index) && !unassignedLines.has(index));
  if (missing >= 0) throw new Error(`原文第 ${missing + 1} 行未交代去向，请还原或填写未还原原因`);
  return { ...value, assignments };
}

// 使用项目统一可读字数口径，分子只计算已经验证并保存的原文范围。
function calculateOriginalRestoration(source, ranges, sourceHash) {
  const selected = new Set();
  for (const range of ranges) {
    for (let line = range.start_line; line <= range.end_line; line += 1) selected.add(line);
  }
  const totalWords = countReadableWords(source.content);
  const restoredWords = countReadableWords(source.lines.map((line, index) => selected.has(index + 1) ? line : '').join('\n'));
  const restoredImages = originalImageReferences(source.lines.map((line, index) => selected.has(index + 1) ? line : '').join('\n')).length;
  return {
    source_hash: sourceHash,
    total_words: totalWords,
    restored_words: restoredWords,
    rate: totalWords > 0 ? restoredWords / totalWords * 100 : null,
    total_images: source.images.length,
    restored_images: restoredImages,
  };
}

module.exports = {
  createOriginalSource, readOriginalRange, buildOriginalRestorationFiles,
  buildOriginalRestorationPrompt, validateOriginalRestoration, calculateOriginalRestoration,
  originalImageReferences, validateOriginalImages, restoredAssignmentContent, ORIGINAL_PLAN_HEADING_INSTRUCTION,
  ORIGINAL_RESTORATION_JSON_SCHEMA,
};
