function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
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
        const source = singleLine(item.source || item.evidence || item.basis || '');
        return [`- **${name}**${detail ? `：${detail}` : ''}`, source ? `  - 依据：${source}` : ''].filter(Boolean).join('\n');
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

    const title = patch.title || '补充事实';
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
    log('未选择参考知识库，本次只基于招标文件和目录分析全局事实。', 12);
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

function formatKnowledgeItemsForPrompt(items) {
  if (!items.length) return '未提供知识库条目。';
  return JSON.stringify(items.map((item) => ({
    title: item.title,
    resume: item.resume,
    content: item.content,
  })), null, 2);
}

function buildFirstRoundMessages({ tenderMarkdown, outlineData, knowledgeItems }) {
  return [
    {
      role: 'system',
      content: `你是严格的投标技术方案全文一致性事实规划专家。请识别后续撰写正文时必须全篇保持一致的事实口径。

必须覆盖但不限于：项目名称、甲方/招标人、交付范围、实施周期/供货周期、交付地点、验收、质保、售后响应、培训、资料交付、人员名单与资质、组织角色、金额数字、品牌型号、技术参数、关键时间节点、标准规范、系统名称和专有名词。

要求：
1. 只基于输入材料提取或归纳，不要编造。
2. 第一轮就要尽量完整，输出全局事实大项和每项内容。
3. 每个大项 content 使用 Markdown，写清“统一口径”“依据/来源”“正文使用提醒”。
4. 不要输出正文段落，不要写投标承诺之外的新事实。
5. 只返回 JSON。`,
    },
    { role: 'user', content: `招标文件 Markdown 原文：\n${tenderMarkdown}` },
    { role: 'user', content: `已生成技术方案目录：\n${formatOutlineForPrompt(outlineData.outline || [])}` },
    { role: 'user', content: `用户选中的知识库完整条目：\n${formatKnowledgeItemsForPrompt(knowledgeItems)}` },
    {
      role: 'user',
      content: `请返回 JSON，格式如下：
{
  "groups": [
    {
      "id": "delivery_schedule",
      "title": "交付周期与服务时限",
      "content": "Markdown 内容"
    }
  ]
}`,
    },
  ];
}

function buildSecondRoundMessages({ tenderMarkdown, outlineData, knowledgeItems, groups }) {
  return [
    {
      role: 'system',
      content: `你是严格的投标技术方案全文一致性事实审校专家。请基于完整输入和第一轮全局事实大项，查漏补缺。

要求：
1. 不要返回全部内容，只返回需要补充或替换的 patch。
2. 优先补充遗漏的人员资质、时间、金额、品牌型号、技术参数、地点、验收质保售后等高冲突事实。
3. 如果某个补充属于已有大项，target_group_id 必须使用已有 id。
4. 如确实需要新增大项，提供 title 和 content。
5. 没有可补充内容时返回 {"patches":[]}。
6. 只返回 JSON。`,
    },
    { role: 'user', content: `招标文件 Markdown 原文：\n${tenderMarkdown}` },
    { role: 'user', content: `已生成技术方案目录：\n${formatOutlineForPrompt(outlineData.outline || [])}` },
    { role: 'user', content: `用户选中的知识库完整条目：\n${formatKnowledgeItemsForPrompt(knowledgeItems)}` },
    { role: 'user', content: `第一轮全局事实大项：\n${JSON.stringify(groups, null, 2)}` },
    {
      role: 'user',
      content: `请返回 JSON，格式如下：
{
  "patches": [
    {
      "target_group_id": "delivery_schedule",
      "title": "交付周期与服务时限",
      "mode": "append",
      "content": "仅补充内容 Markdown"
    }
  ]
}`,
    },
  ];
}

async function collectJson(aiService, options) {
  return aiService.collectJsonResponse ? aiService.collectJsonResponse(options) : aiService.requestJson(options);
}

async function runGlobalFactsTask({ aiService, workspaceStore, knowledgeBaseService, updateTask }) {
  let logs = ['开始生成全局事实。'];
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
  log('正在读取招标文件、目录和参考知识库。', 10);
  const knowledgeItems = loadKnowledgeItems(knowledgeBaseService, referenceKnowledgeDocumentIds, log);

  log('第一轮：正在生成全局事实大项和完整内容。', 25);
  const firstRound = await collectJson(aiService, {
    messages: buildFirstRoundMessages({ tenderMarkdown, outlineData, knowledgeItems }),
    temperature: 0.2,
    logTitle: '全局事实-第一轮',
    progressLabel: '全局事实第一轮',
    failureMessage: '模型返回的全局事实格式无效',
    normalizer: normalizeGlobalFactsResponse,
    validator: validateGlobalFactsResponse,
    progressCallback: (message) => log(message, 32),
  });
  let groups = firstRound.groups;
  technicalPlan = workspaceStore.updateTechnicalPlan({ globalFacts: groups });
  updateTask({ status: 'running', progress: 62, logs }, technicalPlan);

  log('第二轮：正在根据已有大项查漏补缺。', 68);
  const secondRound = await collectJson(aiService, {
    messages: buildSecondRoundMessages({ tenderMarkdown, outlineData, knowledgeItems, groups }),
    temperature: 0.2,
    logTitle: '全局事实-第二轮补充',
    progressLabel: '全局事实第二轮',
    failureMessage: '模型返回的全局事实补充格式无效',
    normalizer: normalizeGlobalFactsPatchResponse,
    validator: validateGlobalFactsPatchResponse,
    progressCallback: (message) => log(message, 74),
  });

  groups = mergeGlobalFactPatches(groups, secondRound.patches || []);
  log(`全局事实合并完成：${groups.length} 个大项，补充 ${secondRound.patches?.length || 0} 条。`, 92);
  technicalPlan = workspaceStore.updateTechnicalPlan({
    globalFacts: groups,
    globalFactsTask: updateTask({ status: 'success', progress: 100, logs: [...logs, '全局事实生成完成。'] }),
  });
  updateTask({ status: 'success', progress: 100, logs: [...logs, '全局事实生成完成。'] }, technicalPlan);
}

module.exports = {
  mergeGlobalFactPatches,
  normalizeGlobalFactsPatchResponse,
  normalizeGlobalFactsResponse,
  runGlobalFactsTask,
};
