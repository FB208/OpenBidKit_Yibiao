const { randomUUID } = require('node:crypto');

const NODE_ID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

// 编号只反映当前树的位置，绝不修改节点身份。
function numberOutline(items, prefix = '') {
  return (items || []).map((item, index) => {
    const number = prefix ? `${prefix}.${index + 1}` : String(index + 1);
    return { ...item, number, ...(item.children?.length ? { children: numberOutline(item.children, number) } : {}) };
  });
}

// 收集当前目录身份，用于接受下一阶段 Agent 输出。
function collectOutlineIds(items, ids = new Set()) {
  for (const item of items || []) {
    ids.add(item.id);
    collectOutlineIds(item.children, ids);
  }
  return ids;
}

// Agent 只能沿用已提供的 ID；新节点必须填 null，由程序一次性分配身份。keepFields 只用于一级目录阶段保留原文位置等候选信息。
function acceptAgentOutline(items, knownIds = new Set(), { keepFields = [] } = {}) {
  const seen = new Set();
  function visit(nodes, root = true) {
    return (nodes || []).map(item => {
      if (item.id !== null && !knownIds.has(item.id)) throw new Error(`目录包含未知 ID：${item.id}；新节点请使用 id:null`);
      const id = item.id === null ? randomUUID() : item.id;
      if (seen.has(id)) throw new Error(`目录 ID 重复：${id}`);
      seen.add(id);
      const branch = Boolean(item.children?.length);
      return {
        id, title: String(item.title || '').trim(), description: String(item.description || '').trim(),
        ...(root ? { attr: item.attr } : {}),
        ...Object.fromEntries(keepFields.filter((field) => item[field] !== undefined).map((field) => [field, item[field]])),
        ...(branch ? { children: visit(item.children, false) } : {
          content_mode: item.content_mode,
          ...(item.content_mode === 'other' && item.content_mode_note?.trim() ? { content_mode_note: item.content_mode_note.trim() } : {}),
        }),
      };
    });
  }
  return numberOutline(visit(items));
}

// 在整棵目录树中按稳定 ID 查找节点。
function findOutlineNode(items, id) {
  for (const item of items || []) {
    if (item.id === id) return item;
    const found = findOutlineNode(item.children, id);
    if (found) return found;
  }
  return null;
}

// 按先序收集叶子节点，path 为从一级目录到本节点的标题链。
function collectOutlineLeaves(items, parentTitles = [], leaves = []) {
  for (const item of items || []) {
    const titles = [...parentTitles, item.title];
    if (item.children?.length) collectOutlineLeaves(item.children, titles, leaves);
    else leaves.push({ item, path: titles });
  }
  return leaves;
}

// 按用户勾选裁剪目录树；父节点只在仍有选中子节点时保留，避免出现没有处理方式的空父节点。
function filterSelectedOutline(items, selectedIds) {
  return (items || []).flatMap((item) => {
    if (!selectedIds.has(item.id)) return [];
    if (!item.children?.length) return [item];
    const children = filterSelectedOutline(item.children, selectedIds);
    return children.length ? [{ ...item, children }] : [];
  });
}

// 去掉只在确认阶段使用的字段，后续阶段沿用通用目录结构。
function stripOutlineFields(items, fields) {
  return (items || []).map((item) => {
    const next = Object.fromEntries(Object.entries(item).filter(([key]) => !fields.includes(key)));
    return item.children?.length ? { ...next, children: stripOutlineFields(item.children, fields) } : next;
  });
}

module.exports = {
  NODE_ID_PATTERN,
  numberOutline,
  collectOutlineIds,
  acceptAgentOutline,
  findOutlineNode,
  collectOutlineLeaves,
  filterSelectedOutline,
  stripOutlineFields,
};
