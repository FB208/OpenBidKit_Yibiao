const { collectOutlineLeaves, numberOutline } = require('./technicalPlanOutline.cjs');

// 规则和页码 Agent 编制的字段；商务填写、确认弹窗和待填统计都不处理。
const RULE_FILL_BY = 'rule';
const NODE_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// 已保存的页码引用标记：程序把 Agent 写的目录编号换成稳定节点 ID，整本导出时换成页码域；|text 为文字写法（第3页至第7页）。
const PAGE_TOKEN_PATTERN = new RegExp(`\\{\\{YBPAGE:(${NODE_ID})(\\|text)?\\}\\}`, 'g');
// Agent 写的页码引用：{{页码:目录编号}} 写数字（3 或 3-7），{{页码文字:目录编号}} 写“第3页”或“第3页至第7页”；允许全角冒号和多余空格。
const AGENT_PAGE_REF_PATTERN = /\{\{\s*页码(文字)?\s*[:：]\s*([^{}]*?)\s*\}\}/g;

function formatPageToken(nodeId, form) {
  return `{{YBPAGE:${nodeId}${form === 'text' ? '|text' : ''}}}`;
}

// 目录编号到节点（含父节点），页码引用按编号指向小节。
function numberedNodes(outline) {
  const nodes = new Map();
  const visit = (items) => {
    for (const item of items || []) {
      nodes.set(item.number, item);
      visit(item.children);
    }
  };
  visit(numberOutline(outline));
  return nodes;
}

/**
 * 把 Agent 写的页码引用换成节点 ID 标记，规则表和商务填写共用；返回换算后的文字和问题（不带位置前缀，由调用方登记）。
 * 只核对编号能否对应到可导出的小节，不判断引用是否合适。
 */
function convertAgentPageRefs(text, nodes, outlineFile) {
  const problems = [];
  const value = String(text).replace(AGENT_PAGE_REF_PATTERN, (match, textForm, number) => {
    const node = nodes.get(number);
    if (!node) {
      problems.push(`页码引用 ${match} 中的目录编号不存在，编号须取自 ${outlineFile}`);
      return match;
    }
    if (!node.children?.length && node.content_mode === 'directory-generate') {
      problems.push(`页码引用 ${match} 指向投标文件目录，请指向响应该项的小节`);
      return match;
    }
    return formatPageToken(node.id, textForm ? 'text' : undefined);
  });
  if (!problems.length && /\{\{(?!YBPAGE:)/.test(value)) problems.push('含有无法识别的 {{…}}，页码引用只能写 {{页码:目录编号}} 或 {{页码文字:目录编号}}');
  return { value, problems };
}

// 已保存的标记换回 Agent 写法，供确认弹窗显示和修改；节点已删除的保留原标记。
function toAgentPageRefs(text, numbersById) {
  return String(text).replace(PAGE_TOKEN_PATTERN, (match, id, textForm) => (
    numbersById.has(id) ? `{{页码${textForm ? '文字' : ''}:${numbersById.get(id)}}}` : match
  ));
}

// 文字中引用到的目录节点 ID。
function collectPageRefNodeIds(texts, ids = new Set()) {
  for (const text of texts) {
    for (const match of String(text).matchAll(PAGE_TOKEN_PATTERN)) ids.add(match[1]);
  }
  return ids;
}

function isRuleField(field) {
  return field?.fill_by === RULE_FILL_BY;
}

// 一行结果中的全部文字：清单表的格子、新建或重建表的各列和分组行。
function rowTexts(row) {
  return [...(row?.values || []), ...(row?.cells || []).map(cell => cell.value), ...(row?.group !== undefined ? [row.group] : [])];
}

// 编制结果中引用到的全部目录节点 ID。
function collectReferencedNodeIds(result) {
  const ids = new Set();
  for (const table of result?.tables || []) {
    for (const row of table.rows || []) collectPageRefNodeIds(rowTexts(row), ids);
  }
  return ids;
}

// 回填用的页码标记：合并相邻小节后写成 {{YBPAGE:起点ID:终点ID}}，整本导出时取起点小节开头到终点小节结尾。
const PAGE_RANGE_PATTERN = new RegExp(`\\{\\{YBPAGE:(${NODE_ID})(?::(${NODE_ID}))?(\\|text)?\\}\\}`, 'g');
// 同一格中只以顿号、逗号、分号或空白隔开的连续引用。
const PAGE_TOKEN_SERIES_PATTERN = new RegExp(`${PAGE_TOKEN_PATTERN.source}(?:[、，,；;\\s]*${PAGE_TOKEN_PATTERN.source})+`, 'g');

/**
 * 合并相邻小节的引用：后一小节的首个叶子在目录叶子顺序上紧接前一小节的末个叶子时，
 * 两者在文档中首尾相接，合并为一段页码，避免连续章节被拆成“9-11、11-13”。按当前目录计算，排序后同样成立。
 */
function mergeAdjacentReferences(cell, leafSpans) {
  return String(cell).replace(PAGE_TOKEN_SERIES_PATTERN, (series) => {
    const groups = [];
    let previousEnd = 0;
    for (const match of series.matchAll(PAGE_TOKEN_PATTERN)) {
      const id = match[1];
      const form = match[2] || '';
      const last = groups.at(-1);
      // 只合并同一写法的引用。
      if (last && last.form === form && leafSpans.get(id)?.first === leafSpans.get(last.end)?.last + 1) last.end = id;
      else groups.push({ separator: series.slice(previousEnd, match.index), start: id, end: id, form });
      previousEnd = match.index + match[0].length;
    }
    return groups.map(({ separator, start, end, form }) => `${separator}{{YBPAGE:${start === end ? start : `${start}:${end}`}${form}}}`).join('');
  });
}

/**
 * 回填 Word 时的页码标记：相邻小节的引用先合并，预览把标记换成“〔页码：小节标题〕”，导出保留标记，
 * 由整本导出换成页码域并回填测量的页码。规则表和商务字段值共用。
 */
function createPageRefDisplay(outline, { forExport = false } = {}) {
  const titles = new Map();
  const leafSpans = new Map();
  let leafCount = 0;
  const visit = (items) => {
    for (const item of items || []) {
      const first = leafCount;
      titles.set(item.id, item.title);
      if (item.children?.length) visit(item.children);
      else leafCount += 1;
      leafSpans.set(item.id, { first, last: leafCount - 1 });
    }
  };
  visit(outline);
  const title = id => titles.get(id) || '已删除的小节';
  return (cell) => {
    const merged = mergeAdjacentReferences(cell, leafSpans);
    return forExport
      ? merged
      : merged.replace(PAGE_RANGE_PATTERN, (_, start, end) => `〔页码：${end ? `${title(start)}～${title(end)}` : title(start)}〕`);
  };
}

/**
 * 规则表编制结果转为 fill-template-fields 的 rule_tables，页码标记见 createPageRefDisplay。
 * 清单表的 from / like 和按网格列的格子、重建和分组行原样传给助手。
 */
function buildRuleTableFills(result, outline, { forExport = false } = {}) {
  if (!result?.tables?.length) return [];
  const display = createPageRefDisplay(outline, { forExport });
  return result.tables.map(table => ({
    ...(table.slot ? { slot: table.slot } : { field_ids: table.field_ids }),
    ...(table.rebuild ? { rebuild: true } : {}),
    columns: table.columns || [],
    rows: table.rows.map(row => ({
      ...(row.from !== undefined ? { from: row.from } : {}),
      ...(row.like !== undefined ? { like: row.like } : {}),
      ...(row.group !== undefined ? { group: display(row.group) } : {}),
      values: (row.values || []).map(display),
      cells: (row.cells || []).map(cell => ({ column: cell.column, value: display(cell.value) })),
    })),
  }));
}

// 当前目录中带规则字段的规则和页码章节；没有时不运行规则和页码 Agent。
function collectRulePageChapterIds(outline, template) {
  const leaves = new Set(collectOutlineLeaves(outline)
    .filter(({ item }) => item.content_mode === 'rule-page')
    .map(({ item }) => item.id));
  return (template?.chapters || [])
    .filter(chapter => chapter.rule_page && leaves.has(chapter.id))
    .map(chapter => chapter.id);
}

module.exports = {
  RULE_FILL_BY,
  PAGE_TOKEN_PATTERN,
  formatPageToken,
  numberedNodes,
  convertAgentPageRefs,
  toAgentPageRefs,
  collectPageRefNodeIds,
  createPageRefDisplay,
  isRuleField,
  collectReferencedNodeIds,
  buildRuleTableFills,
  collectRulePageChapterIds,
};
