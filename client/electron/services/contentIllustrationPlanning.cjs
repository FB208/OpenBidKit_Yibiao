const ILLUSTRATION_PLAN_VERSION = 1;
const ROOT_PARENT_ID = '__root__';
const ILLUSTRATION_KINDS = ['html', 'mermaid', 'ai'];
const ILLUSTRATION_KIND_ORDER = new Map(ILLUSTRATION_KINDS.map((kind, index) => [kind, index]));
const AI_IMAGE_TYPES = new Set(['engineering_diagram', 'realistic_photo']);
const MERMAID_IMAGE_TYPES = new Set(['process', 'hierarchy', 'responsibility']);

function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// 解析用户允许的 HTML 图片类型。
function parseHtmlImageTypes(value) {
  return [...new Set(String(value || '').split(/[\n,，、;；]+/).map(singleLine).filter(Boolean))];
}

function normalizeLimit(value, fallback, sectionCount) {
  const number = Number(value);
  return Math.max(0, Math.min(Number.isFinite(number) ? Math.round(number) : fallback, sectionCount));
}

function resolveSectionContent(item, sections) {
  return String(sections?.[item.id]?.content || item?.content || '').trim();
}

// 从真实目录树构建 Agent 输入和程序校验索引。
function buildIllustrationPlanningContext({ outlineData, sections, options, aiImagesAvailable = false }) {
  const sectionMap = new Map();
  const eligibleSectionIds = [];
  const markdownLines = ['# 技术方案正文', ''];

  function visit(items, parentId = ROOT_PARENT_ID, depth = 1) {
    return (Array.isArray(items) ? items : []).map((item, siblingIndex) => {
      const id = String(item?.id || '').trim();
      const title = singleLine(item?.title || '未命名章节');
      const description = String(item?.description || '').trim();
      const children = Array.isArray(item?.children) ? item.children : [];
      const isLeaf = children.length === 0;
      const content = isLeaf ? resolveSectionContent(item, sections) : '';
      const eligible = Boolean(isLeaf && content && sections?.[id]?.status !== 'error');
      const order = eligibleSectionIds.length;

      markdownLines.push(`${'#'.repeat(Math.min(depth + 1, 6))} ${id} ${title}`.trim());
      markdownLines.push('');
      if (isLeaf) {
        markdownLines.push(`<!-- yibiao-section-start id="${id}" -->`);
        if (content) markdownLines.push(content);
        markdownLines.push(`<!-- yibiao-section-end id="${id}" -->`);
        markdownLines.push('');
      }

      sectionMap.set(id, {
        id,
        parentId,
        siblingIndex,
        order,
        isLeaf,
        eligible,
      });
      if (eligible) eligibleSectionIds.push(id);

      return {
        id,
        title,
        description,
        leaf: isLeaf,
        eligible,
        ...(children.length ? { children: visit(children, id, depth + 1) } : {}),
      };
    });
  }

  const outline = visit(outlineData?.outline || []);
  const eligibleCount = eligibleSectionIds.length;
  const allowedHtmlTypes = parseHtmlImageTypes(options?.htmlImageTypes);
  const config = {
    ai: {
      enabled: Boolean(options?.useAiImages) && Boolean(aiImagesAvailable),
      limit: normalizeLimit(options?.maxAiImages, 6, eligibleCount),
      allowed_types: [...AI_IMAGE_TYPES],
    },
    mermaid: {
      enabled: Boolean(options?.useMermaidImages),
      limit: normalizeLimit(options?.maxMermaidImages, 10, eligibleCount),
      allowed_types: [...MERMAID_IMAGE_TYPES],
    },
    html: {
      enabled: Boolean(options?.useHtmlImages) && allowedHtmlTypes.length > 0,
      limit: normalizeLimit(options?.maxHtmlImages, 10, eligibleCount),
      allowed_types: allowedHtmlTypes,
    },
    eligible_section_ids: eligibleSectionIds,
  };
  for (const kind of ILLUSTRATION_KINDS) {
    if (config[kind].limit <= 0) config[kind].enabled = false;
  }

  return {
    sectionMap,
    eligibleSectionIds,
    config,
    files: [
      { path: 'technical-plan.md', content: markdownLines.join('\n').trim() },
      {
        path: 'outline-tree.json',
        content: JSON.stringify({
          project_name: singleLine(outlineData?.project_name),
          project_overview: String(outlineData?.project_overview || '').trim(),
          outline,
        }, null, 2),
      },
      { path: 'illustration-config.json', content: JSON.stringify(config, null, 2) },
    ],
  };
}

// 构建 Agent 全文图片编排任务说明。
function buildIllustrationPlanningPrompt() {
  return `请基于当前工作目录中的三个输入文件完成技术方案全文图片编排：

- technical-plan.md：按真实目录顺序组织的全文正文，叶子小节由 yibiao-section-start / yibiao-section-end 标记。
- outline-tree.json：真实目录树，用于核对小节 ID、父子关系和顺序。
- illustration-config.json：三类图片是否启用、允许类型、上限和可编排小节 ID。

工作要求：
1. 阅读全文后，为所有确实有配图价值的位置给出候选；不要因为配置上限提前截断，程序会统一处理上限和冲突。
2. kind 只能是 html、mermaid、ai；image_type 必须来自对应 allowed_types。
3. AI 图片适合设备、现场、工程空间、实体部署等具象内容；Mermaid 只用于简单流程、层级和职责关系；HTML 用于配置允许的复杂图表类型。
4. AI 和 Mermaid 每项只能引用一个正文叶子小节，placement 必须为 after。
5. HTML 可以引用一个小节，也可以引用同一直接父目录下顺序连续的多个叶子小节；单节 placement 必须为 after。
6. HTML 多节说明类图片使用 before，表示插入组内第一节正文前；总结类图片使用 after，表示插入组内最后一节正文后。
7. priority 只能是 1-5 的整数，5 表示最值得配图。
8. 同一小节允许提出不同 kind 的候选，程序会按 HTML > Mermaid > AI 处理冲突。
9. 输出前必须重新读取 outline-tree.json，确认所有 section_ids 真实存在、属于可编排叶子，并确认 HTML 多节组同父且连续。
10. 只创建 illustration-plan.json，不要修改输入文件，不要输出其他结果文件。

illustration-plan.json 只能使用以下结构，不要增加标题、理由、prompt、代码、scope、id 或其他字段：
{
  "items": [
    {
      "kind": "html",
      "image_type": "进度网络图",
      "section_ids": ["3.2.1", "3.2.2"],
      "placement": "before",
      "priority": 5
    }
  ]
}`;
}

function extractJsonObject(content) {
  const text = String(content || '').trim();
  if (!text) throw new Error('Agent 图片编排结果为空');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const source = fenced ? fenced[1].trim() : text;
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf('{');
    if (start < 0) throw new Error('Agent 图片编排结果不是 JSON 对象');
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) return JSON.parse(source.slice(start, index + 1));
      }
    }
    throw new Error('Agent 图片编排 JSON 不完整');
  }
}

function normalizeCandidate(item, index) {
  const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
  return {
    kind: String(source.kind || '').trim(),
    image_type: singleLine(source.image_type),
    section_ids: Array.isArray(source.section_ids) ? source.section_ids.map((id) => String(id || '').trim()) : [],
    placement: String(source.placement || '').trim(),
    priority: Number(source.priority),
    outputIndex: index,
  };
}

function validateCandidate(candidate, context) {
  const config = context.config[candidate.kind];
  if (!ILLUSTRATION_KIND_ORDER.has(candidate.kind) || !config?.enabled) {
    throw new Error(`图片候选类型未启用或无效：${candidate.kind || 'empty'}`);
  }
  if (!config.allowed_types.includes(candidate.image_type)) {
    throw new Error(`图片候选 image_type 无效：${candidate.image_type || 'empty'}`);
  }
  if (!Number.isInteger(candidate.priority) || candidate.priority < 1 || candidate.priority > 5) {
    throw new Error('图片候选 priority 必须是 1-5 的整数');
  }
  if (!['before', 'after'].includes(candidate.placement)) {
    throw new Error('图片候选 placement 必须是 before 或 after');
  }
  if (!candidate.section_ids.length || new Set(candidate.section_ids).size !== candidate.section_ids.length) {
    throw new Error('图片候选 section_ids 不能为空或重复');
  }
  const sections = candidate.section_ids.map((id) => context.sectionMap.get(id));
  if (sections.some((section) => !section?.eligible)) {
    throw new Error(`图片候选包含无效正文小节：${candidate.section_ids.join(', ')}`);
  }
  if (candidate.kind !== 'html' && candidate.section_ids.length !== 1) {
    throw new Error(`${candidate.kind} 图片只能编排到一个小节`);
  }
  if (candidate.section_ids.length === 1 && candidate.placement !== 'after') {
    throw new Error('单节图片 placement 必须为 after');
  }
  if (candidate.kind === 'html' && candidate.section_ids.length > 1) {
    const parentId = sections[0].parentId;
    if (!parentId || sections.some((section) => section.parentId !== parentId)) {
      throw new Error('HTML 多节图片必须属于同一直接父目录');
    }
    for (let index = 1; index < sections.length; index += 1) {
      if (sections[index].siblingIndex !== sections[index - 1].siblingIndex + 1) {
        throw new Error('HTML 多节图片的小节必须按目录顺序连续');
      }
    }
  }
  return { ...candidate, firstOrder: sections[0].order };
}

// 解析、严格校验并按 HTML > Mermaid > AI 处理上限和冲突。
function resolveIllustrationPlan(content, context) {
  const parsed = typeof content === 'string' ? extractJsonObject(content) : content;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
    throw new Error('Agent 图片编排结果缺少 items 数组');
  }
  const extraRootFields = Object.keys(parsed).filter((key) => key !== 'items');
  if (extraRootFields.length) throw new Error(`Agent 图片编排结果包含多余字段：${extraRootFields.join(', ')}`);

  const allowedFields = new Set(['kind', 'image_type', 'section_ids', 'placement', 'priority']);
  const candidates = parsed.items.map((item, index) => {
    const extraFields = Object.keys(item || {}).filter((key) => !allowedFields.has(key));
    if (extraFields.length) throw new Error(`图片候选包含多余字段：${extraFields.join(', ')}`);
    return validateCandidate(normalizeCandidate(item, index), context);
  });

  const occupiedSectionIds = new Set();
  const selected = [];
  const candidateStats = { ai: 0, mermaid: 0, html: 0 };
  const selectedStats = { ai: 0, mermaid: 0, html: 0 };
  for (const candidate of candidates) candidateStats[candidate.kind] += 1;

  for (const kind of ILLUSTRATION_KINDS) {
    const sorted = candidates
      .filter((candidate) => candidate.kind === kind)
      .sort((a, b) => b.priority - a.priority || a.firstOrder - b.firstOrder || a.outputIndex - b.outputIndex);
    for (const candidate of sorted) {
      if (selectedStats[kind] >= context.config[kind].limit) continue;
      if (candidate.section_ids.some((id) => occupiedSectionIds.has(id))) continue;
      selected.push(candidate);
      selectedStats[kind] += 1;
      for (const id of candidate.section_ids) occupiedSectionIds.add(id);
    }
  }

  selected.sort((a, b) => a.firstOrder - b.firstOrder
    || ILLUSTRATION_KIND_ORDER.get(a.kind) - ILLUSTRATION_KIND_ORDER.get(b.kind)
    || a.outputIndex - b.outputIndex);
  return {
    plan: {
      plan_version: ILLUSTRATION_PLAN_VERSION,
      items: selected.map(({ kind, image_type, section_ids, placement, priority }) => ({
        kind,
        image_type,
        section_ids,
        placement,
        priority,
      })),
      updated_at: new Date().toISOString(),
    },
    stats: { candidate: candidateStats, selected: selectedStats },
  };
}

module.exports = {
  ILLUSTRATION_PLAN_VERSION,
  buildIllustrationPlanningContext,
  buildIllustrationPlanningPrompt,
  parseHtmlImageTypes,
  resolveIllustrationPlan,
};
