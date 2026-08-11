/**
 * 上下文相关性筛选工具
 *
 * 在注入知识库条目或技术方案文本前，按关键词匹配度筛选最相关片段，
 * 避免全量灌入导致上下文膨胀。基于轻量关键词重叠评分，无需向量模型。
 */

function buildQueryKeywords(query) {
  return [
    ...new Set(
      String(query || '')
        .toLowerCase()
        .split(/[\s,，、;；]+/)
        .map((word) => word.trim())
        .filter(Boolean)
    ),
  ];
}

function scoreItem(item, keywords) {
  const target = `${item.title || ''} ${item.resume || ''} ${item.content || ''}`.toLowerCase();
  return keywords.reduce((score, keyword) => {
    if (!keyword) return score;
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const count = (target.match(new RegExp(escaped, 'g')) || []).length;
    return score + count;
  }, 0);
}

/**
 * 从知识库条目数组中选出与查询主题最相关的 N 条。
 *
 * @param {string} query         相关性查询关键词（空格分隔）
 * @param {Array} items          待筛选条目 [{id,title,resume,content}]
 * @param {{maxItems?:number}}   选项
 * @returns {Array}
 */
function selectRelevantItems(query, items, options = {}) {
  const maxItems = Math.max(1, Math.floor(Number(options?.maxItems) || 14));
  if (!Array.isArray(items) || !items.length) return [];
  if (!String(query || '').trim()) return items.slice(0, maxItems);

  const keywords = buildQueryKeywords(query);
  if (!keywords.length) return items.slice(0, maxItems);

  const scored = items
    .map((item) => ({ item, score: scoreItem(item, keywords) }))
    .sort((a, b) => b.score - a.score || 0);

  return scored.slice(0, maxItems).map((entry) => entry.item);
}

/**
 * 从长文本中选出与查询主题最相关的 N 个段落。
 *
 * @param {string} query         相关性查询关键词（空格分隔）
 * @param {string} text          待筛选文本
 * @param {{maxParagraphs?:number}} 选项
 * @returns {string}
 */
function selectRelevantParagraphs(query, text, options = {}) {
  const maxParagraphs = Math.max(1, Math.floor(Number(options?.maxParagraphs) || 12));
  const source = String(text || '').trim();
  if (!source) return '';

  const paragraphs = source.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const finalParagraphs = paragraphs.length > 1 ? paragraphs : source.split('\n').map((p) => p.trim()).filter(Boolean);

  if (!String(query || '').trim()) return finalParagraphs.slice(0, maxParagraphs).join('\n\n');

  const keywords = buildQueryKeywords(query);
  if (!keywords.length) return finalParagraphs.slice(0, maxParagraphs).join('\n\n');

  const scored = finalParagraphs
    .map((paragraph) => {
      const lower = paragraph.toLowerCase();
      const score = keywords.reduce((sum, keyword) => {
        if (!keyword) return sum;
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const count = (lower.match(new RegExp(escaped, 'g')) || []).length;
        return sum + count;
      }, 0);
      return { paragraph, score };
    })
    .sort((a, b) => b.score - a.score || 0);

  return scored.slice(0, maxParagraphs).map((entry) => entry.paragraph).join('\n\n');
}

module.exports = { selectRelevantItems, selectRelevantParagraphs };
