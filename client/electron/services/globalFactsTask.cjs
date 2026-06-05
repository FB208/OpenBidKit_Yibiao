const { buildSectionContextHint } = require('../utils/bidSectionDetector.cjs');

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

function formatKnowledgeItemsForPrompt(items) {
  if (!items.length) return '未提供知识库条目。';
  return JSON.stringify(items.map((item) => ({
    title: item.title,
    resume: item.resume,
    content: item.content,
  })), null, 2);
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

function buildFirstRoundMessages({ tenderMarkdown, outlineData, bidAnalysisFactsText, knowledgeItems, sectionHint }) {
  const messages = [
    {
      role: 'system',
      content: `用户正在编写投标书中的技术方案，在编写之前，为了保持全文关键变量一致，需要提前根据招标文件内容和已列出的投标技术方案提纲，把需要全文保持一致的关键变量编辑好。

工作方式：
1. 以”已生成技术方案目录”为主，判断在这些目录的正文写作时，哪些变量一旦随机生成就会导致全文前后不一致。
2. 必须要包含的变量类别：工期、运维期或交货时间，这三个至少有一个，根据项目类型判断用哪个。其他变量类别由你自行判断，比如；人名、时间、品牌、型号、质保期等根据用户提交内容仔细分析。
3. 招标文件、关键解析结果和知识库可以作为参考，如果里面有能用到的信息，优先使用。
4. 如果用户提交的材料中没有可用信息，但是你分析某变量对全文一致性很重要，你需要根据你的专业能力来编辑，允许出现虚拟内容，但必须合情合理。
5. 仅编写技术方案部分，不要涉及商务部分所需要的内容。

输出要求：
1. 只返回有价值的变量组。
3. 优先输出具体变量，例如”项目经理：张伟，负责总体协调”，不要输出”严格按照招标文件执行”这类空话。
5. 不要输出长段落、分析过程、来源说明、风险提示或正文草稿。
6. 只返回 JSON。`,
    },
  ];
  if (sectionHint) {
    messages.push({ role: 'system', content: sectionHint });
  }
  messages.push(
    { role: 'user', content: `招标文件原文：\n${tenderMarkdown}` },
    { role: 'user', content: `关键解析结果：\n${bidAnalysisFactsText}` },
    { role: 'user', content: `已生成技术方案目录：\n${formatOutlineForPrompt(outlineData.outline || [])}` },
    { role: 'user', content: `用户选中的知识库完整条目：\n${formatKnowledgeItemsForPrompt(knowledgeItems)}` },
    {
      role: 'user',
      content: `请返回 JSON，格式如下：
{
  “groups”: [
    {
      “id”: “project_team”,
      “title”: “项目角色变量”,
      “content”: “- 项目经理：张伟，负责总体协调。\n- 技术负责人：李明，负责方案设计和联调验收。”
    }
  ]
}`,
    },
  );
  return messages;
}

function buildSecondRoundMessages({ tenderMarkdown, outlineData, bidAnalysisFactsText, knowledgeItems, groups, sectionHint }) {
  const messages = [
    {
      role: 'system',
      content: `你的任务是帮用户补充”全局变量”的细节。用户会发给你一份全局事实变量。请基于用户输入信息，检查是否还有投标文件技术方案写作时会反复用到、且必须全文保持全文一致的变量需要补充。

要求：
1. 不要重新生成全部内容，只返回需要补充或替换的 patches。
2. 重点查漏补缺遗漏的变量，不要重复第一轮已有内容。
3. 如果补充内容属于已有大项，target_group_id 必须使用已有 id。
4. 如果确实需要新增大项，提供 title 和 content。
5. mode 只能是 append、prepend 或 replace；默认使用 append。只有已有大项明显不适合作为变量表时才使用 replace。
6. 每条 content 只写短 bullet，直接给可复用的变量值，不要写分析过程、来源说明、风险提示或正文草稿。
7. 没有可补充内容时返回 {"patches":[]}。
8. 只返回 JSON。`,
    },
  ];
  if (sectionHint) {
    messages.push({ role: 'system', content: sectionHint });
  }
  messages.push(
    { role: 'user', content: `招标文件原文：\n${tenderMarkdown}` },
    { role: 'user', content: `关键解析结果：\n${bidAnalysisFactsText}` },
    { role: 'user', content: `已生成技术方案目录：\n${formatOutlineForPrompt(outlineData.outline || [])}` },
    { role: 'user', content: `用户选中的知识库完整条目：\n${formatKnowledgeItemsForPrompt(knowledgeItems)}` },
    { role: 'user', content: `全局事实变量：\n${JSON.stringify(groups, null, 2)}` },
    {
      role: 'user',
      content: `请返回 JSON，格式如下：
{
  "patches": [
    {
      "target_group_id": "project_team",
      "title": "项目角色变量",
      "mode": "append",
      "content": "- 现场负责人：王强，负责现场实施协调。"
    }
  ]
}`,
    },
  );
  return messages;
}

async function collectJson(aiService, options) {
  return aiService.collectJsonResponse ? aiService.collectJsonResponse(options) : aiService.requestJson(options);
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
  const knowledgeItems = loadKnowledgeItems(knowledgeBaseService, referenceKnowledgeDocumentIds, log);

  const selectedSection = storedPlan.tenderFile?.selectedSectionTitle ? {
    title: storedPlan.tenderFile.selectedSectionTitle,
    headLine: storedPlan.tenderFile.selectedSectionHeadLine || '',
  } : null;
  const sectionHint = selectedSection ? buildSectionContextHint(selectedSection) : '';

  log('正在预设后续正文会反复用到的全局事实变量。', 25);
  const firstRound = await collectJson(aiService, {
    messages: buildFirstRoundMessages({ tenderMarkdown, outlineData, bidAnalysisFactsText, knowledgeItems, sectionHint }),
    temperature: 0.2,
    logTitle: '全局事实变量',
    progressLabel: '全局事实变量',
    failureMessage: '模型返回的全局事实变量格式无效',
    normalizer: normalizeGlobalFactsResponse,
    validator: validateGlobalFactsResponse,
    progressCallback: (message) => log(message, 45),
  });
  let groups = firstRound.groups;
  technicalPlan = workspaceStore.updateTechnicalPlan({ globalFacts: groups });
  updateTask({ status: 'running', progress: 62, logs }, technicalPlan);

  log('第二轮：正在根据第一轮大项补充遗漏的全局事实变量。', 68);
  const secondRound = await collectJson(aiService, {
    messages: buildSecondRoundMessages({ tenderMarkdown, outlineData, bidAnalysisFactsText, knowledgeItems, groups, sectionHint }),
    temperature: 0.2,
    logTitle: '全局事实变量-第二轮补充',
    progressLabel: '全局事实变量第二轮',
    failureMessage: '模型返回的全局事实变量补充格式无效',
    normalizer: normalizeGlobalFactsPatchResponse,
    validator: validateGlobalFactsPatchResponse,
    progressCallback: (message) => log(message, 74),
  });

  groups = mergeGlobalFactPatches(groups, secondRound.patches || []);
  log(`全局事实变量合并完成：${groups.length} 个大项，补充 ${secondRound.patches?.length || 0} 条。`, 92);
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
