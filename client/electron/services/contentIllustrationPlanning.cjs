const crypto = require('node:crypto');

const ILLUSTRATION_PLAN_VERSION = 2;
const ROOT_PARENT_ID = '__root__';
const ILLUSTRATION_KINDS = ['html', 'mermaid', 'ai'];
const ILLUSTRATION_KIND_ORDER = new Map(ILLUSTRATION_KINDS.map((kind, index) => [kind, index]));
const AI_IMAGE_TYPES = new Set(['engineering_diagram', 'realistic_photo']);
const MERMAID_IMAGE_TYPES = new Set(['process', 'hierarchy', 'responsibility']);
const AI_IMAGE_TYPE_DESCRIPTIONS = {
  engineering_diagram: '专业工程图示：用于展示设备、系统组件、部署位置、连接关系或工程实施场景，强调结构与关系；不用于步骤流转、组织层级或职责分工。',
  realistic_photo: '专业实景图片：用于表现设备、机房、监控中心、施工、巡检或维护现场等可真实拍摄的对象和环境；不用于抽象系统架构、流程或组织关系。',
};
const MERMAID_IMAGE_TYPE_DESCRIPTIONS = {
  process: '流程图：用于表达按先后顺序发生的步骤、判断、流转和闭环处理过程；不用于静态系统拓扑或人员层级。',
  hierarchy: '层级图：用于表达组织、系统模块、资源分类等上下级或包含关系；不用于时间顺序或职责矩阵。',
  responsibility: '职责关系图：用于表达角色、岗位、责任边界和协作关系；不用于设备拓扑或纯流程步骤。',
};

function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
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
      type_descriptions: AI_IMAGE_TYPE_DESCRIPTIONS,
    },
    mermaid: {
      enabled: Boolean(options?.useMermaidImages),
      limit: normalizeLimit(options?.maxMermaidImages, 10, eligibleCount),
      allowed_types: [...MERMAID_IMAGE_TYPES],
      type_descriptions: MERMAID_IMAGE_TYPE_DESCRIPTIONS,
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
  return `请基于当前工作目录中的三个输入文件完成投标文件技术方案的全文图片编排，即按要求设计投标文件应该在哪个位置，添加什么样的图片：

- technical-plan.md：投标文件全文，叶子小节由 yibiao-section-start / yibiao-section-end 标记。
- outline-tree.json：目录树，用于核对小节 ID、父子关系和顺序，要确保配图的位置一定是真实存在于目录树中的。
- illustration-config.json：三类图片是否启用、允许类型、类型中文说明、上限和可编排小节 ID。

工作要求：
1. 图片有三类：AI生成图片、mermaid图片、html生成类图网页，具体应用哪种，可以查看illustration-config.json的配置，自行判断。
2. illustration-config.json中limit是每类图片的配图上限，如果投标文件实在不适合配图，可以低于limit，但绝不能高于limit。
3. 避免在不同章节编排相同或相似图片。
2. kind 只能是 html、mermaid、ai；image_type 必须来自对应 allowed_types。遇到英文类型标识时，必须先阅读对应 type_descriptions 的中文含义、适用场景和不适用场景，再决定是否选用，不得仅按英文单词猜测。
3. AI 图片适合设备、现场、工程空间、实体部署等具象内容；Mermaid 只用于简单流程、层级和职责关系；HTML 用于配置允许的复杂图表类型。
4. AI 和 Mermaid 每项只能引用一个正文叶子小节，placement 必须为 after。
5. HTML 可以引用一个小节，也可以引用同一直接父目录下顺序连续的多个叶子小节；单节 placement 必须为 after。
6. HTML 多节说明类图片使用 before，表示插入组内第一节正文前；总结类图片使用 after，表示插入组内最后一节正文后。
7. priority 只能是 1-5 的整数，5 表示最值得配图。
8. 同一小节只允许编排一张图片，包含在html多节图都组中，也算已编排。
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
  const planItems = selected.map(({ kind, image_type, section_ids, placement, priority }) => ({
    kind,
    image_type,
    section_ids,
    placement,
    priority,
  }));
  const revision = stableHash(planItems).slice(0, 24);
  return {
    plan: {
      plan_version: ILLUSTRATION_PLAN_VERSION,
      revision,
      items: planItems.map((item) => ({
        item_id: stableHash(item).slice(0, 24),
        ...item,
        generation: { status: 'pending' },
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
