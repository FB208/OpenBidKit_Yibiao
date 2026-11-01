const { collectOutlineLeaves } = require('./technicalPlanOutline.cjs');

// 规则和页码 Agent 编制的字段；商务填写、确认弹窗和待填统计都不处理。
const RULE_FILL_BY = 'rule';
// 已保存的页码引用标记：程序把 Agent 写的目录编号换成稳定节点 ID，整本导出时换成页码域。
const PAGE_TOKEN_PATTERN = /\{\{YBPAGE:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}\}/g;

function formatPageToken(nodeId) {
  return `{{YBPAGE:${nodeId}}}`;
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
    for (const row of table.rows || []) {
      for (const text of rowTexts(row)) {
        for (const match of String(text).matchAll(PAGE_TOKEN_PATTERN)) ids.add(match[1]);
      }
    }
  }
  return ids;
}

// 回填用的页码标记：合并相邻小节后写成 {{YBPAGE:起点ID:终点ID}}，整本导出时取起点小节开头到终点小节结尾。
const PAGE_RANGE_PATTERN = /\{\{YBPAGE:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?\}\}/g;
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
      const last = groups.at(-1);
      if (last && leafSpans.get(id)?.first === leafSpans.get(last.end)?.last + 1) last.end = id;
      else groups.push({ separator: series.slice(previousEnd, match.index), start: id, end: id });
      previousEnd = match.index + match[0].length;
    }
    return groups.map(({ separator, start, end }) => `${separator}{{YBPAGE:${start === end ? start : `${start}:${end}`}}}`).join('');
  });
}

/**
 * 规则表编制结果转为 fill-template-fields 的 rule_tables：相邻小节的引用先合并，预览把页码标记换成“〔页码：小节标题〕”，
 * 导出保留标记，由整本导出换成页码域并回填测量的页码。清单表的 from / like 和按网格列的格子、重建和分组行原样传给助手。
 */
function buildRuleTableFills(result, outline, { forExport = false } = {}) {
  if (!result?.tables?.length) return [];
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
  const display = (cell) => {
    const merged = mergeAdjacentReferences(cell, leafSpans);
    return forExport
      ? merged
      : merged.replace(PAGE_RANGE_PATTERN, (_, start, end) => `〔页码：${end ? `${title(start)}～${title(end)}` : title(start)}〕`);
  };
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
  isRuleField,
  collectReferencedNodeIds,
  buildRuleTableFills,
  collectRulePageChapterIds,
};
