const { buildBidSectionContextHint } = require('../utils/bidSectionContext.cjs');
const { splitUserTextByContextLimit } = require('../utils/userTextSplitter.cjs');

const DEFAULT_CONTEXT_LENGTH_LIMIT = 400000;
const GLOBAL_FACTS_CONTEXT_LIMIT_RATIO = 0.8;
const MIN_GLOBAL_FACTS_SEGMENT_CHARS = 1000;
const GLOBAL_FACTS_SYSTEM_PROMPT = `你是专业的投标技术方案事实变量整理助手。请基于用户提供的上下文，整理后续正文需要统一采用的全局事实变量。

关键定义：
1. 全局事实变量不是招标要求摘录、评分规则摘要或待办事项清单，而是技术方案正文中需要保持一致的确定性方案事实、响应设定、承诺口径或执行安排。
2. 用户资料已经给出明确事实时，优先使用资料中的事实值。
3. 用户资料只给出要求、约束或评价口径时，不要原样摘录为要求句；如果该内容会影响后续正文的一致写法，应转写为本方案已经采用、已经具备或统一承诺的事实表达。
4. 用户资料没有给出具体值，但该信息对全文一致性重要，且当前任务允许补足时，可以根据项目语境模拟生成合理、稳定、不冲突的事实值。

通用要求：
1. 输出必须使用简体中文。
2. 只关注技术方案正文会反复使用、且前后必须一致的事实变量。
3. 每条事实都应能直接指导后续正文统一写法，避免正文各章节自行生成不同口径。
4. 不输出分析过程、来源说明、风险提示、正文草稿或未落地的要求句。`;

function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeFactId(value, index) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || `fact_${String(index + 1).padStart(3, '0')}`;
}

function ensureUniqueId(id, used) {
  let nextId = id;
  let suffix = 2;
  while (used.has(nextId)) {
    nextId = `${id}_${suffix}`;
    suffix += 1;
  }
  used.add(nextId);
  return nextId;
}

function valueToMarkdown(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return `- ${item.trim()}`;
      if (item && typeof item === 'object') {
        const name = singleLine(item.name || item.title || item.fact || item.key || '事实项');
        const detail = singleLine(item.value || item.content || item.detail || item.description || item.requirement || '');
        return `- **${name}**${detail ? `：${detail}` : ''}`;
      }
      return `- ${singleLine(item)}`;
    }).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => `- **${singleLine(key)}**：${singleLine(item)}`).join('\n');
  }
  return singleLine(value);
}

function normalizeGlobalFactsResponse(value) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const rawGroups = Array.isArray(source)
    ? source
    : Array.isArray(source.groups)
      ? source.groups
      : Array.isArray(source.facts)
        ? source.facts
        : Array.isArray(source.items)
          ? source.items
          : [];
  const used = new Set();
  const groups = rawGroups.map((group, index) => {
    const title = singleLine(group?.title || group?.name || group?.category || group?.label);
    const rawContent = group?.content ?? group?.markdown ?? group?.facts ?? group?.items ?? group?.details ?? group?.description;
    const content = valueToMarkdown(rawContent);
    if (!title || !content) return null;
    const id = ensureUniqueId(normalizeFactId(group?.id || group?.group_id || group?.key || title, index), used);
    return { id, title, content };
  }).filter(Boolean);
  return { groups };
}

function validateGlobalFactsResponse(value) {
  if (!Array.isArray(value?.groups) || !value.groups.length) {
    throw new Error('全局事实结果缺少 groups');
  }
  value.groups.forEach((group, index) => {
    if (!group.id || !group.title || !String(group.content || '').trim()) {
      throw new Error(`全局事实第 ${index + 1} 项缺少 id、title 或 content`);
    }
  });
}

function validateGlobalFactsSegmentResponse(value) {
  if (!value || !Array.isArray(value.groups)) {
    throw new Error('全局事实分段结果缺少 groups');
  }
  value.groups.forEach((group, index) => {
    if (!group.id || !group.title || !String(group.content || '').trim()) {
      throw new Error(`全局事实分段第 ${index + 1} 项缺少 id、title 或 content`);
    }
  });
}

function normalizeGlobalFactsPatchResponse(value) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const rawPatches = Array.isArray(source)
    ? source
    : Array.isArray(source.patches)
      ? source.patches
      : Array.isArray(source.supplements)
        ? source.supplements
        : Array.isArray(source.additions)
          ? source.additions
          : Array.isArray(source.items)
            ? source.items
            : [];
  const patches = rawPatches.map((patch, index) => {
    const title = singleLine(patch?.title || patch?.group_title || patch?.target_group_title || patch?.name);
    const content = valueToMarkdown(patch?.content ?? patch?.markdown ?? patch?.facts ?? patch?.items ?? patch?.details ?? patch?.description);
    if (!content) return null;
    const rawMode = singleLine(patch?.mode || patch?.operation || 'append').toLowerCase();
    const mode = ['replace', 'prepend'].includes(rawMode) ? rawMode : 'append';
    return {
      target_group_id: singleLine(patch?.target_group_id || patch?.targetGroupId || patch?.group_id || patch?.id),
      new_group_id: singleLine(patch?.new_group_id || patch?.newGroupId || patch?.id || `patch_${index + 1}`),
      title,
      content,
      mode,
    };
  }).filter(Boolean);
  return { patches };
}

function validateGlobalFactsPatchResponse(value) {
  if (!value || !Array.isArray(value.patches)) {
    throw new Error('全局事实补充结果缺少 patches');
  }
  value.patches.forEach((patch, index) => {
    if (!String(patch.content || '').trim()) {
      throw new Error(`全局事实补充第 ${index + 1} 项缺少 content`);
    }
  });
}

function mergeGlobalFactPatches(groups, patches) {
  const used = new Set(groups.map((group) => group.id));
  const nextGroups = groups.map((group) => ({ ...group }));

  for (const patch of patches || []) {
    const targetIndex = nextGroups.findIndex((group) => (
      group.id === patch.target_group_id
      || (patch.title && group.title === patch.title)
    ));

    if (targetIndex >= 0) {
      const current = nextGroups[targetIndex];
      const patchContent = String(patch.content || '').trim();
      const currentContent = String(current.content || '').trim();
      nextGroups[targetIndex] = {
        ...current,
        content: patch.mode === 'replace'
          ? patchContent
          : patch.mode === 'prepend'
            ? `${patchContent}\n\n${currentContent}`.trim()
            : `${currentContent}\n\n${patchContent}`.trim(),
      };
      continue;
    }

    const title = patch.title || '补充事实变量';
    const id = ensureUniqueId(normalizeFactId(patch.new_group_id || title, nextGroups.length), used);
    nextGroups.push({ id, title, content: String(patch.content || '').trim() });
  }

  return nextGroups;
}

function formatOutlineForPrompt(items, level = 1, lines = []) {
  for (const item of items || []) {
    const id = singleLine(item?.id || 'unknown');
    const title = singleLine(item?.title || '未命名章节');
    const description = singleLine(item?.description || '');
    lines.push(`${'  '.repeat(Math.max(0, level - 1))}- ${id} ${title}${description ? `：${description}` : ''}`);
    if (item?.children?.length) formatOutlineForPrompt(item.children, level + 1, lines);
  }
  return lines.join('\n');
}

function normalizeReferenceDocumentIds(storedPlan) {
  const raw = storedPlan?.referenceKnowledgeDocumentIds || [];
  return Array.isArray(raw) ? [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))] : [];
}

function loadKnowledgeItems(knowledgeBaseService, documentIds, log) {
  if (!documentIds.length) {
    log('未选择参考知识库，本次只基于招标文件、Step02 解析结果和目录预设关键信息。', 12);
    return [];
  }
  if (!knowledgeBaseService?.readItems) {
    log('未找到知识库读取服务，本次不使用知识库条目。', 12);
    return [];
  }

  const items = [];
  for (const documentId of documentIds) {
    try {
      const documentItems = knowledgeBaseService.readItems(documentId);
      for (const item of Array.isArray(documentItems) ? documentItems : []) {
        const title = singleLine(item?.title);
        const content = String(item?.content || '').trim();
        if (!title || !content) continue;
        items.push({
          id: `${documentId}::${singleLine(item?.id)}`,
          title,
          resume: singleLine(item?.resume),
          content,
        });
      }
    } catch (error) {
      log(`读取知识库条目失败，已跳过文档 ${documentId}：${error.message || String(error)}`, 12);
    }
  }
  log(items.length ? `已读取 ${items.length} 条知识库完整条目。` : '未读取到可用知识库完整条目。', 14);
  return items;
}

function formatKnowledgeItemForPrompt(item, index) {
  return `<knowledge_item index="${index + 1}" id="${singleLine(item?.id)}">
标题：${singleLine(item?.title)}
简介：${singleLine(item?.resume)}
正文：
${String(item?.content || '').trim()}
</knowledge_item>`;
}

function formatBidAnalysisFactForPrompt(storedPlan, itemId, label) {
  const item = storedPlan?.bidAnalysisTasks?.[itemId];
  const content = item?.status === 'success' ? String(item.content || '').trim() : '';
  return content ? `## ${label}\n${content}` : '';
}

function formatBidAnalysisFactsForPrompt(storedPlan) {
  return [
    formatBidAnalysisFactForPrompt(storedPlan, 'projectInfo', '项目信息'),
    formatBidAnalysisFactForPrompt(storedPlan, 'partAInfo', '甲方信息'),
    formatBidAnalysisFactForPrompt(storedPlan, 'deliveryAndServiceRequirements', '交货和服务要求'),
  ].filter(Boolean).join('\n\n') || '未提供 Step02 关键解析结果。';
}

function getMessagesContentLength(messages) {
  return (messages || []).reduce((sum, message) => sum + String(message?.role || 'user').length + String(message?.content || '').length + 64, 0);
}

function getGlobalFactsSegmentLimit(aiService, fixedMessages) {
  const config = typeof aiService?.getConfig === 'function' ? aiService.getConfig() : {};
  const contextLengthLimit = normalizePositiveInteger(config?.context_length_limit, DEFAULT_CONTEXT_LENGTH_LIMIT);
  const requestBudget = Math.floor(contextLengthLimit * GLOBAL_FACTS_CONTEXT_LIMIT_RATIO);
  return Math.max(MIN_GLOBAL_FACTS_SEGMENT_CHARS, requestBudget - getMessagesContentLength(fixedMessages));
}

function splitGlobalFactsSourceText(text, aiService, fixedMessages) {
  const source = String(text || '').trim();
  if (!source) return [];
  return splitUserTextByContextLimit(source, {}, {
    contextLengthLimit: getGlobalFactsSegmentLimit(aiService, fixedMessages),
    limitRatio: 1,
    maxSegmentLimitRatio: 1,
  }).map((content) => String(content || '').trim()).filter(Boolean);
}

function createTextSegments(text, aiService, fixedMessages) {
  const parts = splitGlobalFactsSourceText(text, aiService, fixedMessages);
  return parts.map((content, index) => ({ index: index + 1, total: parts.length, content }));
}

function createKnowledgeItemSegments(knowledgeItems, aiService, fixedMessages) {
  const segmentLimit = getGlobalFactsSegmentLimit(aiService, fixedMessages);
  const blocks = (knowledgeItems || [])
    .map((item, index) => formatKnowledgeItemForPrompt(item, index))
    .filter((block) => block.trim());
  const segments = [];
  let current = [];
  let currentLength = 0;

  const flush = () => {
    if (!current.length) return;
    segments.push({ content: current.join('\n\n'), itemCount: current.length });
    current = [];
    currentLength = 0;
  };

  for (const block of blocks) {
    const nextLength = currentLength + block.length + (current.length ? 2 : 0);
    if (current.length && nextLength > segmentLimit) {
      flush();
    }
    current.push(block);
    currentLength += block.length + (current.length > 1 ? 2 : 0);
  }
  flush();

  return segments.map((segment, index) => ({ ...segment, index: index + 1, total: segments.length }));
}

function buildGlobalFactsLightContextMessages({ projectOverview, outlineData, bidAnalysisFactsText, knowledgeItems, sectionHint }) {
  const messages = [{ role: 'system', content: GLOBAL_FACTS_SYSTEM_PROMPT }];
  if (sectionHint) {
    messages.push({ role: 'system', content: sectionHint });
  }
  messages.push(
    { role: 'user', content: `项目概述：\n${String(projectOverview || '').trim() || '未提供'}` },
    { role: 'user', content: `Step02 关键解析结果：\n${bidAnalysisFactsText}` },
    { role: 'user', content: `已生成技术方案目录：\n${formatOutlineForPrompt(outlineData.outline || [])}` },
    { role: 'user', content: (knowledgeItems || []).length ? `用户已选择 ${(knowledgeItems || []).length} 条知识库条目；知识库正文将在独立分段步骤中处理。` : '用户未选择参考知识库。' },
  );
  return messages;
}

function buildGroupsJsonExample() {
  return `请返回 JSON，格式如下：
{
  "groups": [
    {
      "id": "project_team",
      "title": "项目角色变量",
      "content": "- 项目经理：张伟，负责总体协调。\n- 技术负责人：李明，负责方案设计和联调验收。"
    }
  ]
}`;
}

function buildPatchesJsonExample() {
  return `请返回 JSON，格式如下：
{
  "patches": [
    {
      "target_group_id": "project_team",
      "title": "项目角色变量",
      "mode": "append",
      "content": "- 现场负责人：王强，负责现场实施协调。"
    }
  ]
}`;
}

function buildTenderSegmentGlobalFactsMessages(context) {
  const { tenderSegment } = context;
  return [
    ...buildGlobalFactsLightContextMessages(context),
    { role: 'user', content: `招标文件分段 ${tenderSegment.index}/${tenderSegment.total}：\n${tenderSegment.content}` },
    {
      role: 'user',
      content: `招标文件分段全局事实提取任务：

请只基于当前招标文件分段，识别后续技术方案正文必须保持一致的全局事实变量候选。

要求：
1. 当前分段没有提及，不代表整份招标文件没有提及；不要因为本段缺失就输出“没有提及”。
2. 当前分段直接给出明确事实时，提取为可复用的事实值。
3. 当前分段给出的是要求、约束或评价口径时，不要原样摘录为要求句；请判断它是否会影响后续正文的一致写法，必要时转写为本方案可统一采用的响应事实候选。
4. 每条 content 只写短 bullet，内容应是正文可直接引用或遵循的稳定事实、响应设定、承诺口径或执行安排。
5. 当前分段无法支持形成事实候选时，返回 {"groups":[]}；不要为了凑内容编造与本段无关的具体值。
6. 不要输出商务报价、资格材料、正文草稿、分析过程或来源说明。
7. 只返回 JSON。`,
    },
    { role: 'user', content: buildGroupsJsonExample() },
  ];
}

function formatSegmentGroupResultForPrompt(result) {
  return `## 第 ${result.index}/${result.total} 段候选
${JSON.stringify(result.groups || [], null, 2)}`;
}

function formatSegmentGroupsForPrompt(segmentResults) {
  return (segmentResults || []).map(formatSegmentGroupResultForPrompt).join('\n\n');
}

function buildTenderSegmentMergeMessages(context) {
  return [
    ...buildGlobalFactsLightContextMessages(context),
    { role: 'user', content: `招标文件分段候选全局事实：\n${formatSegmentGroupsForPrompt(context.segmentResults)}` },
    {
      role: 'user',
      content: `招标文件全局事实合并任务：

请把所有分段候选合并为后续技术方案正文可直接使用的全局事实变量。

要求：
1. 分段候选只代表对应片段，合并时要综合所有片段，删除重复、空泛和互相矛盾的表述。
2. 合并后的结果必须是稳定的方案事实、响应设定、承诺口径或执行安排，不保留未落地的要求句、评分规则或资料清单。
3. 对招标文件中的硬性要求和约束，应判断其是否会影响后续正文的一致写法；会影响的，应转写为本方案统一采用的事实、安排或承诺口径。
4. 资料中已有明确事实值时使用明确值；资料没有明确值但该信息对全文一致性重要时，可以根据项目语境补足一套合理、稳定、不冲突的事实值。
5. 必须包含工期、运维期或交货时间中的至少一个相关变量；如果分段候选不足，但项目概述或 Step02 关键解析结果中已有明确内容，应补入。
6. 每条 bullet 都应回答“后续正文遇到这个事项时统一写什么”，而不是回答“招标文件要求什么”。
7. 仅编写技术方案部分，不要涉及商务报价或资格材料。
8. 只返回 JSON。`,
    },
    { role: 'user', content: buildGroupsJsonExample() },
  ];
}

function buildKnowledgeSegmentPatchMessages(context) {
  const { knowledgeSegment, groups } = context;
  return [
    ...buildGlobalFactsLightContextMessages(context),
    { role: 'user', content: `当前全局事实变量：\n${JSON.stringify(groups || [], null, 2)}` },
    { role: 'user', content: `知识库完整条目分段 ${knowledgeSegment.index}/${knowledgeSegment.total}：\n${knowledgeSegment.content}` },
    {
      role: 'user',
      content: `知识库全局事实补充任务：

请基于当前知识库分段，判断是否需要补充或修正全局事实变量。

要求：
1. 只返回需要补充或替换的 patches，不要重新生成全部 groups。
2. 只处理与项目概述、技术评分信息、目录和技术方案正文强相关，且能够沉淀为稳定方案事实的内容。
3. 知识库内容如果只是通用要求、规范说明、写作建议或参考素材，不要原样补充为事实变量；只有能够转为本项目统一采用的事实、安排、承诺口径或技术设定时才返回 patch。
4. 不要用知识库内容覆盖招标文件中的明确硬性要求；只有知识库提供更具体且不冲突的事实值时才补充。
5. 如果补充内容属于已有大项，target_group_id 必须使用已有 id。
6. 如果确实需要新增大项，提供 title 和 content。
7. mode 只能是 append、prepend 或 replace；默认使用 append。
8. 没有可补充内容时返回 {"patches":[]}。
9. 只返回 JSON。`,
    },
    { role: 'user', content: buildPatchesJsonExample() },
  ];
}

function buildOriginalPlanSegmentPatchMessages(context) {
  const { originalPlanSegment, groups } = context;
  return [
    ...buildGlobalFactsLightContextMessages(context),
    { role: 'user', content: `当前全局事实变量：\n${JSON.stringify(groups || [], null, 2)}` },
    { role: 'user', content: `原方案正文分段 ${originalPlanSegment.index}/${originalPlanSegment.total}：\n${originalPlanSegment.content}` },
    {
      role: 'user',
      content: `原方案全局事实补充任务：

当前是“已有方案扩写”模式。用户提供的原方案是本次要扩写的投标技术方案核心草稿，已有内容必须在后续扩写正文中被保留。

请基于当前原方案分段，补充或替换全局事实变量。

要求：
1. 原方案中已经写成投标方实际安排、既有承诺、统一配置、技术路线、服务口径或实施做法的内容，优先补充到全局事实变量中。
2. 原方案如果只是转述招标要求、评分规则、格式要求或资料提交要求，不要原样作为事实变量；只有能够转为后续正文统一采用的方案事实时才补充。
3. 只返回需要补充或替换的 patches，不要重新生成全部 groups。
4. 如果补充内容属于已有大项，target_group_id 必须使用已有 id。
5. 如果确实需要新增大项，提供 title 和 content。
6. mode 只能是 append、prepend 或 replace；当原方案明确事实与当前变量冲突且原方案应优先时使用 replace 或 prepend。
7. 每条 content 只写短 bullet，直接给可复用的变量值，不要写分析过程、来源说明、风险提示或正文草稿。
8. 没有可补充内容时返回 {"patches":[]}。
9. 只返回 JSON。`,
    },
    { role: 'user', content: buildPatchesJsonExample() },
  ];
}

function formatPatchResultForPrompt(result) {
  return `## 第 ${result.index}/${result.total} 段补充
${JSON.stringify(result.patches || [], null, 2)}`;
}

function formatPatchResultsForPrompt(patchResults) {
  return (patchResults || []).map(formatPatchResultForPrompt).join('\n\n');
}

function buildSegmentPatchMergeMessages(context) {
  return [
    ...buildGlobalFactsLightContextMessages(context),
    { role: 'user', content: `当前全局事实变量：\n${JSON.stringify(context.groups || [], null, 2)}` },
    { role: 'user', content: `${context.sourceLabel}分段补充 patches：\n${formatPatchResultsForPrompt(context.patchResults)}` },
    {
      role: 'user',
      content: `${context.sourceLabel}全局事实补充合并任务：

请把所有分段 patches 合并成一份可应用的 patches。

要求：
1. 删除重复、空泛、互相矛盾或仍停留在要求摘录层面的补充项。
2. 能合并到同一变量组的内容尽量合并，避免对同一事实反复 append。
3. 合并后的 patch 内容必须是正文可直接统一使用的方案事实、响应设定、承诺口径或执行安排。
4. target_group_id 必须优先使用当前全局事实变量中已有的 id；确实需要新增大项时再提供 title 和 content。
5. mode 只能是 append、prepend 或 replace。
6. 没有可补充内容时返回 {"patches":[]}。
7. 只返回 JSON。`,
    },
    { role: 'user', content: buildPatchesJsonExample() },
  ];
}

function buildFinalGlobalFactsReviewMessages(context) {
  return [
    ...buildGlobalFactsLightContextMessages(context),
    { role: 'user', content: `待最终整理的全局事实变量：\n${JSON.stringify(context.groups || [], null, 2)}` },
    {
      role: 'user',
      content: `全局事实变量最终整理任务：

请在不提交完整招标文件、完整原方案和知识库正文的前提下，基于当前轻量上下文整理最终全局事实变量。

要求：
1. 最终结果必须全部是后续技术方案正文可直接统一使用的事实变量。
2. 保留所有具体、可复用、会影响全文一致性的方案事实、响应设定、承诺口径和执行安排。
3. 合并同义或重复大项，删除空泛内容、明显重复 bullet，以及仍停留在招标要求、评分规则、资料清单、待办事项层面的内容。
4. 如果某条内容表达的是“需要满足什么要求”，请改写为“本方案统一采用什么事实、安排、承诺或响应口径”；无法形成稳定事实且不能帮助正文保持一致的，应删除。
5. 不要新增与当前事实相冲突的具体值、服务承诺或技术边界。
6. 必须保留工期、运维期或交货时间中的至少一个相关变量。
7. 每个 group 必须包含 id、title、content。
8. ${context.isExpansionWorkflow ? '当前是已有方案扩写模式，原方案分段补充后的事实优先保留，不要在最终整理时弱化或删除原方案已有承诺。' : '只返回 JSON。'}
${context.isExpansionWorkflow ? '9. 只返回 JSON。' : ''}`,
    },
    { role: 'user', content: buildGroupsJsonExample() },
  ];
}

async function collectJson(aiService, options) {
  return aiService.collectJsonResponse ? aiService.collectJsonResponse(options) : aiService.requestJson(options);
}

async function waitAllOrThrow(tasks) {
  const results = await Promise.allSettled(tasks);
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected) {
    throw rejected.reason;
  }
  return results.map((result) => result.value);
}

function batchRenderedItems(items, renderItem, limit) {
  const batches = [];
  let current = [];
  let currentLength = 0;

  const flush = () => {
    if (!current.length) return;
    batches.push(current);
    current = [];
    currentLength = 0;
  };

  for (const item of items || []) {
    const length = renderItem(item).length;
    const nextLength = currentLength + length + (current.length ? 2 : 0);
    if (current.length && nextLength > limit) {
      flush();
    }
    current.push(item);
    currentLength += length + (current.length > 1 ? 2 : 0);
  }
  flush();
  return batches;
}

async function collectGroupMerge(aiService, context, segmentResults, mergeMessagesBuilder, sourceLabel, log, progress, labelSuffix = '') {
  return collectJson(aiService, {
    messages: mergeMessagesBuilder({ ...context, segmentResults }),
    temperature: 0.2,
    logTitle: `全局事实变量-${sourceLabel}-合并${labelSuffix}`,
    progressLabel: `${sourceLabel}全局事实合并${labelSuffix}`,
    failureMessage: `模型返回的${sourceLabel}全局事实合并结果格式无效`,
    normalizer: normalizeGlobalFactsResponse,
    validator: validateGlobalFactsResponse,
    progressCallback: (message) => log(message, progress),
  });
}

async function mergeGroupResultsInBatches({ aiService, context, segmentResults, mergeMessagesBuilder, sourceLabel, log, progress }) {
  let pending = segmentResults || [];
  let round = 1;
  while (true) {
    const fixedMessages = mergeMessagesBuilder({ ...context, segmentResults: [] });
    const limit = getGlobalFactsSegmentLimit(aiService, fixedMessages);
    const batches = batchRenderedItems(pending, formatSegmentGroupResultForPrompt, limit);
    if (batches.length <= 1) {
      return collectGroupMerge(aiService, context, batches[0] || [], mergeMessagesBuilder, sourceLabel, log, progress, round > 1 ? `-第${round}轮` : '');
    }

    log(`${sourceLabel}分段候选较多，正在分 ${batches.length} 批合并。`, progress);
    const first = await collectGroupMerge(aiService, context, batches[0], mergeMessagesBuilder, sourceLabel, log, progress, `-第${round}轮-第1批`);
    const rest = await waitAllOrThrow(batches.slice(1).map((batch, index) => (
      collectGroupMerge(aiService, context, batch, mergeMessagesBuilder, sourceLabel, log, progress, `-第${round}轮-第${index + 2}批`)
    )));
    const merged = [first, ...rest];
    const nextPending = merged.map((result, index) => ({ index: index + 1, total: merged.length, groups: result.groups || [] }));
    if (nextPending.length >= pending.length) {
      return collectGroupMerge(aiService, context, nextPending, mergeMessagesBuilder, sourceLabel, log, progress, `-第${round + 1}轮`);
    }
    pending = nextPending;
    round += 1;
  }
}

async function collectPatchMerge(aiService, context, patchResults, sourceLabel, log, progress, labelSuffix = '') {
  return collectJson(aiService, {
    messages: buildSegmentPatchMergeMessages({ ...context, patchResults, sourceLabel }),
    temperature: 0.2,
    logTitle: `全局事实变量-${sourceLabel}-补充合并${labelSuffix}`,
    progressLabel: `${sourceLabel}全局事实补充合并${labelSuffix}`,
    failureMessage: `模型返回的${sourceLabel}全局事实补充合并结果格式无效`,
    normalizer: normalizeGlobalFactsPatchResponse,
    validator: validateGlobalFactsPatchResponse,
    progressCallback: (message) => log(message, progress),
  });
}

async function mergePatchResultsInBatches({ aiService, context, patchResults, sourceLabel, log, progress }) {
  let pending = patchResults || [];
  let round = 1;
  while (true) {
    const fixedMessages = buildSegmentPatchMergeMessages({ ...context, patchResults: [], sourceLabel });
    const limit = getGlobalFactsSegmentLimit(aiService, fixedMessages);
    const batches = batchRenderedItems(pending, formatPatchResultForPrompt, limit);
    if (batches.length <= 1) {
      return collectPatchMerge(aiService, context, batches[0] || [], sourceLabel, log, progress, round > 1 ? `-第${round}轮` : '');
    }

    log(`${sourceLabel}分段补充项较多，正在分 ${batches.length} 批合并。`, progress);
    const first = await collectPatchMerge(aiService, context, batches[0], sourceLabel, log, progress, `-第${round}轮-第1批`);
    const rest = await waitAllOrThrow(batches.slice(1).map((batch, index) => (
      collectPatchMerge(aiService, context, batch, sourceLabel, log, progress, `-第${round}轮-第${index + 2}批`)
    )));
    const merged = [first, ...rest];
    const nextPending = merged.map((result, index) => ({ index: index + 1, total: merged.length, patches: result.patches || [] }));
    if (nextPending.length >= pending.length) {
      return collectPatchMerge(aiService, context, nextPending, sourceLabel, log, progress, `-第${round + 1}轮`);
    }
    pending = nextPending;
    round += 1;
  }
}

async function runSegmentedGroupExtraction({ aiService, context, sourceText, buildMessages, mergeMessagesBuilder, log, sourceLabel, startProgress, segmentProgress, mergeProgress }) {
  const fixedMessages = buildMessages({ ...context, segment: { index: 999, total: 999, content: '' } });
  const segments = createTextSegments(sourceText, aiService, fixedMessages);
  if (!segments.length) {
    throw new Error(`${sourceLabel}内容为空，无法提取全局事实变量`);
  }

  log(`${sourceLabel}已拆分为 ${segments.length} 段，开始分段提取全局事实变量。`, startProgress);
  let completed = 0;
  const runSegment = async (segment) => {
    const response = await collectJson(aiService, {
      messages: buildMessages({ ...context, segment }),
      temperature: 0.2,
      logTitle: `全局事实变量-${sourceLabel}-第${segment.index}段`,
      progressLabel: `${sourceLabel}全局事实 ${segment.index}/${segment.total}`,
      failureMessage: `模型返回的${sourceLabel}全局事实分段结果格式无效`,
      normalizer: normalizeGlobalFactsResponse,
      validator: validateGlobalFactsSegmentResponse,
      progressCallback: (message) => log(message, segmentProgress),
    });
    completed += 1;
    if (segments.length > 1) {
      log(`${sourceLabel}全局事实分段已完成 ${completed}/${segments.length}。`, segmentProgress);
    }
    return { index: segment.index, total: segment.total, groups: response.groups || [] };
  };

  const firstResult = await runSegment(segments[0]);
  const remainingResults = segments.length > 1
    ? await waitAllOrThrow(segments.slice(1).map((segment) => runSegment(segment)))
    : [];
  const segmentResults = [firstResult, ...remainingResults].sort((left, right) => left.index - right.index);

  log(`${sourceLabel}分段提取完成，正在合并全局事实变量。`, mergeProgress);
  return mergeGroupResultsInBatches({ aiService, context, segmentResults, mergeMessagesBuilder, sourceLabel, log, progress: mergeProgress });
}

async function runTenderGlobalFactsExtraction(aiService, context, tenderMarkdown, log) {
  return runSegmentedGroupExtraction({
    aiService,
    context,
    sourceText: tenderMarkdown,
    sourceLabel: '招标文件',
    startProgress: 24,
    segmentProgress: 34,
    mergeProgress: 44,
    buildMessages: ({ segment, ...rest }) => buildTenderSegmentGlobalFactsMessages({ ...rest, tenderSegment: segment }),
    mergeMessagesBuilder: buildTenderSegmentMergeMessages,
    log,
  });
}

async function runSegmentedPatchExtraction({ aiService, context, segments, buildMessages, mergeSourceLabel, log, startProgress, segmentProgress, mergeProgress }) {
  if (!segments.length) return { patches: [] };

  log(`${mergeSourceLabel}已拆分为 ${segments.length} 段，开始分段补充全局事实变量。`, startProgress);
  let completed = 0;
  const runSegment = async (segment) => {
    const response = await collectJson(aiService, {
      messages: buildMessages({ ...context, segment }),
      temperature: 0.2,
      logTitle: `全局事实变量-${mergeSourceLabel}-第${segment.index}段`,
      progressLabel: `${mergeSourceLabel}全局事实补充 ${segment.index}/${segment.total}`,
      failureMessage: `模型返回的${mergeSourceLabel}全局事实补充结果格式无效`,
      normalizer: normalizeGlobalFactsPatchResponse,
      validator: validateGlobalFactsPatchResponse,
      progressCallback: (message) => log(message, segmentProgress),
    });
    completed += 1;
    if (segments.length > 1) {
      log(`${mergeSourceLabel}全局事实补充分段已完成 ${completed}/${segments.length}。`, segmentProgress);
    }
    return { index: segment.index, total: segment.total, patches: response.patches || [] };
  };

  const firstResult = await runSegment(segments[0]);
  const remainingResults = segments.length > 1
    ? await waitAllOrThrow(segments.slice(1).map((segment) => runSegment(segment)))
    : [];
  const patchResults = [firstResult, ...remainingResults].sort((left, right) => left.index - right.index);
  const patchCount = patchResults.reduce((sum, result) => sum + (result.patches || []).length, 0);
  if (!patchCount) return { patches: [] };

  log(`${mergeSourceLabel}分段补充完成，正在合并补充项。`, mergeProgress);
  return mergePatchResultsInBatches({ aiService, context, patchResults, sourceLabel: mergeSourceLabel, log, progress: mergeProgress });
}

async function runKnowledgeGlobalFactPatches(aiService, context, knowledgeItems, log) {
  if (!knowledgeItems.length) return { patches: [] };
  const fixedMessages = buildKnowledgeSegmentPatchMessages({ ...context, knowledgeSegment: { index: 999, total: 999, content: '' } });
  const segments = createKnowledgeItemSegments(knowledgeItems, aiService, fixedMessages);
  return runSegmentedPatchExtraction({
    aiService,
    context,
    segments,
    mergeSourceLabel: '知识库',
    startProgress: 52,
    segmentProgress: 58,
    mergeProgress: 64,
    buildMessages: ({ segment, ...rest }) => buildKnowledgeSegmentPatchMessages({ ...rest, knowledgeSegment: segment }),
    log,
  });
}

async function runOriginalPlanGlobalFactPatches(aiService, context, originalPlanMarkdown, log) {
  const fixedMessages = buildOriginalPlanSegmentPatchMessages({ ...context, originalPlanSegment: { index: 999, total: 999, content: '' } });
  const segments = createTextSegments(originalPlanMarkdown, aiService, fixedMessages);
  return runSegmentedPatchExtraction({
    aiService,
    context,
    segments,
    mergeSourceLabel: '原方案',
    startProgress: 70,
    segmentProgress: 77,
    mergeProgress: 84,
    buildMessages: ({ segment, ...rest }) => buildOriginalPlanSegmentPatchMessages({ ...rest, originalPlanSegment: segment }),
    log,
  });
}

async function finalizeGlobalFacts(aiService, context, log) {
  log('正在最终整理全局事实变量。', 90);
  return collectJson(aiService, {
    messages: buildFinalGlobalFactsReviewMessages(context),
    temperature: 0.2,
    logTitle: '全局事实变量-最终整理',
    progressLabel: '全局事实变量最终整理',
    failureMessage: '模型返回的全局事实变量最终结果格式无效',
    normalizer: normalizeGlobalFactsResponse,
    validator: validateGlobalFactsResponse,
    progressCallback: (message) => log(message, 90),
  });
}

async function runGlobalFactsTask({ aiService, workspaceStore, knowledgeBaseService, updateTask }) {
  let logs = ['开始生成全局事实变量。'];
  let currentProgress = 5;
  function log(message, progress = currentProgress) {
    currentProgress = Math.max(currentProgress, Math.min(progress, 99));
    logs = [...logs, message];
    const technicalPlan = workspaceStore.updateTechnicalPlan({ globalFactsTask: updateTask({ status: 'running', progress: currentProgress, logs }) });
    updateTask({ status: 'running', progress: currentProgress, logs }, technicalPlan);
  }

  const storedPlan = workspaceStore.loadTechnicalPlan() || {};
  const tenderMarkdown = workspaceStore.readTenderMarkdown();
  if (!String(tenderMarkdown || '').trim()) {
    throw new Error('请先上传招标文件，再生成全局事实');
  }
  const isExpansionWorkflow = storedPlan.workflowKind === 'existing-plan-expansion';
  let originalPlanMarkdown = '';
  if (isExpansionWorkflow) {
    if (!storedPlan.originalPlanFile) {
      throw new Error('请先上传原方案，再生成全局事实');
    }
    if (!workspaceStore.readOriginalPlanMarkdown) {
      throw new Error('原方案读取服务尚未初始化');
    }
    originalPlanMarkdown = workspaceStore.readOriginalPlanMarkdown();
    if (!String(originalPlanMarkdown || '').trim()) {
      throw new Error('请先上传原方案，再生成全局事实');
    }
  }
  const outlineData = storedPlan.outlineData;
  if (!outlineData?.outline?.length) {
    throw new Error('请先生成目录，再生成全局事实');
  }

  let technicalPlan = workspaceStore.updateTechnicalPlan({
    globalFacts: [],
    contentGenerationTask: undefined,
    contentGenerationSections: {},
    contentGenerationPlans: {},
    contentGenerationRuntime: undefined,
    globalFactsTask: updateTask({ status: 'running', progress: 5, logs }),
  });
  updateTask({ status: 'running', progress: 5, logs }, technicalPlan);

  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(storedPlan);
  const bidAnalysisFactsText = formatBidAnalysisFactsForPrompt(storedPlan);
  log('正在读取招标文件、Step02 解析结果、目录和参考知识库。', 10);
  if (isExpansionWorkflow) {
    log('已读取原方案，本次将优先从原方案抽取全局事实变量。', 18);
  }
  const knowledgeItems = loadKnowledgeItems(knowledgeBaseService, referenceKnowledgeDocumentIds, log);

  const selectedSectionId = storedPlan.tenderFile?.selectedSectionId;
  const selectedSection = selectedSectionId && Array.isArray(storedPlan.bidSections)
    ? storedPlan.bidSections.find((section) => section.id === selectedSectionId)
    : null;
  const sectionHint = buildBidSectionContextHint(selectedSection, {
    hasSelectedSection: storedPlan.bidSectionMode === 'multiple' && Boolean(selectedSectionId),
  });

  const baseContext = {
    projectOverview: storedPlan.projectOverview || '',
    outlineData,
    bidAnalysisFactsText,
    knowledgeItems,
    sectionHint,
    isExpansionWorkflow,
  };

  log('第一步：正在按招标文件分段提取全局事实变量。', 22);
  const tenderFacts = await runTenderGlobalFactsExtraction(aiService, baseContext, tenderMarkdown, log);
  let groups = tenderFacts.groups;
  technicalPlan = workspaceStore.updateTechnicalPlan({ globalFacts: groups });
  updateTask({ status: 'running', progress: 48, logs }, technicalPlan);

  const knowledgePatch = await runKnowledgeGlobalFactPatches(aiService, { ...baseContext, groups }, knowledgeItems, log);
  if (knowledgePatch.patches?.length) {
    groups = mergeGlobalFactPatches(groups, knowledgePatch.patches);
    technicalPlan = workspaceStore.updateTechnicalPlan({ globalFacts: groups });
    updateTask({ status: 'running', progress: 66, logs }, technicalPlan);
    log(`知识库全局事实补充已应用：${knowledgePatch.patches.length} 条。`, 66);
  } else if (knowledgeItems.length) {
    log('知识库未返回需要补充的全局事实变量。', 66);
  }

  if (isExpansionWorkflow) {
    const originalPatch = await runOriginalPlanGlobalFactPatches(aiService, { ...baseContext, groups }, originalPlanMarkdown, log);
    if (originalPatch.patches?.length) {
      groups = mergeGlobalFactPatches(groups, originalPatch.patches);
      technicalPlan = workspaceStore.updateTechnicalPlan({ globalFacts: groups });
      updateTask({ status: 'running', progress: 86, logs }, technicalPlan);
      log(`原方案全局事实补充已应用：${originalPatch.patches.length} 条。`, 86);
    } else {
      log('原方案未返回需要补充的全局事实变量。', 86);
    }
  }

  const finalFacts = await finalizeGlobalFacts(aiService, { ...baseContext, groups }, log);
  groups = finalFacts.groups;
  log(`全局事实变量合并完成：${groups.length} 个大项。`, 92);
  technicalPlan = workspaceStore.updateTechnicalPlan({
    globalFacts: groups,
    globalFactsTask: updateTask({ status: 'success', progress: 100, logs: [...logs, '全局事实变量生成完成。'] }),
  });
  updateTask({ status: 'success', progress: 100, logs: [...logs, '全局事实变量生成完成。'] }, technicalPlan);
}

module.exports = {
  mergeGlobalFactPatches,
  normalizeGlobalFactsPatchResponse,
  normalizeGlobalFactsResponse,
  runGlobalFactsTask,
};
