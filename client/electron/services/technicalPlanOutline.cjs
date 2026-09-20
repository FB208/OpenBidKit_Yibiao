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

// Agent 只能沿用已提供的 ID；新节点必须填 null，由程序一次性分配身份。
function acceptAgentOutline(items, knownIds = new Set()) {
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
        ...(branch ? { children: visit(item.children, false) } : {
          content_mode: item.content_mode,
          ...(item.content_mode === 'other' && item.content_mode_note?.trim() ? { content_mode_note: item.content_mode_note.trim() } : {}),
        }),
      };
    });
  }
  return numberOutline(visit(items));
}

module.exports = { NODE_ID_PATTERN, numberOutline, collectOutlineIds, acceptAgentOutline };
