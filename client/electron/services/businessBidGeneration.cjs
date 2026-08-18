// 商务标生成逻辑（条款解析 / 目录生成 / 全局事实 / 正文生成）。
// 与技术方案不同，这里不再引入 illustrate、mermaid 缓存、多标段等复杂链路，保持商务标语义精简。
// 注入知识库/技术方案时按章节相关性筛选，压缩上下文（见 contextSelection.cjs）。

const { selectRelevantItems, selectRelevantParagraphs } = require('./contextSelection.cjs');

// 单次调用注入知识库/技术方案的预算上限，避免全量灌入导致上下文膨胀。
const MAX_KNOWLEDGE_ITEMS = 14;
const MAX_TECH_PARAGRAPHS = 12;
// 各阶段相关性筛选的查询主题（用于从知识库/技术方案中抽取商务相关片段）。
const BUSINESS_CLAUSE_QUERY = '商务 投标 报价 付款条件 履约保证金 质保 运维 报价有效期 合同偏离 资信 业绩 交付 供货 违约责任 保函 合同条款 法定代表人';
const BUSINESS_OUTLINE_QUERY = '投标函 报价说明 报价汇总 合同条款偏离 资格审查 资信业绩 供货 交付 售后服务 付款 履约 投标保证金 商务标目录 偏离表';
const BUSINESS_FACTS_QUERY = '公司资质 注册资本 业绩 同类项目 报价口径 付款条件 履约 质保 保函 交付 售后 承诺 投标 保证金 资信';

function singleLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function now() {
  return new Date().toISOString();
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value || {}, field);
}

function collectLeafItems(items) {
  return (items || []).flatMap((item) => item?.children?.length ? collectLeafItems(item.children) : [item]);
}

function mapOutlineItems(items, mapper) {
  return (items || []).map((item) => {
    const nextItem = mapper(item);
    if (item?.children?.length) {
      nextItem.children = mapOutlineItems(item.children, mapper);
    }
    return nextItem;
  });
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

function normalizeReferenceDocumentIds(state) {
  const raw = state?.referenceKnowledgeDocumentIds || [];
  return Array.isArray(raw) ? [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))] : [];
}

function normalizeReferenceSnippetIds(state) {
  const raw = state?.referenceKnowledgeSnippetIds || [];
  return Array.isArray(raw) ? [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))] : [];
}

// 与 globalFactsTask.cjs 中同名函数保持一致（该模块未导出此函数，故在本地定义）。
function normalizeReferenceItemIds(state) {
  const raw = state?.referenceKnowledgeItemIds || [];
  return Array.isArray(raw) ? [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))] : [];
}

function loadKnowledgeItems(knowledgeBaseService, documentIds, snippetIds, itemIds, log) {
  const normalizedItemIds = Array.isArray(itemIds) ? itemIds : [];
  if (!documentIds.length && !snippetIds.length && !normalizedItemIds.length) {
    log('未选择参考知识库，本次仅基于招标文件与技术方案上下文。', 12);
    return [];
  }
  if (!knowledgeBaseService?.readItems) {
    log('未找到知识库读取服务，本次不使用知识库条目。', 12);
    return [];
  }

  const items = [];
  const seen = new Set();
  const pushItem = (item) => {
    if (!item?.id || seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  };

  // 优先读取用户勾选的具体知识条目（勾选成功时不再按文档全量读取）。
  let itemLoadSucceeded = false;
  if (normalizedItemIds.length && knowledgeBaseService?.readItemContents && knowledgeBaseService?.getItemReferences) {
    try {
      const contents = knowledgeBaseService.readItemContents(normalizedItemIds);
      const result = knowledgeBaseService.getItemReferences(normalizedItemIds);
      for (const meta of Array.isArray(result?.items) ? result.items : []) {
        const title = singleLine(meta?.title);
        const content = String(contents.get(meta?.id)?.content || '').trim();
        if (!title || !content) continue;
        pushItem({ id: singleLine(meta?.id), title, resume: singleLine(meta?.resume), content });
      }
      itemLoadSucceeded = true;
    } catch (error) {
      log(`读取勾选知识条目失败，将按文档全量读取：${error.message || String(error)}`, 12);
    }
  }
  if ((!normalizedItemIds.length || !itemLoadSucceeded) && documentIds.length) {
    for (const documentId of documentIds) {
      try {
        const documentItems = knowledgeBaseService.readItems(documentId);
        for (const item of Array.isArray(documentItems) ? documentItems : []) {
          const title = singleLine(item?.title);
          const content = String(item?.content || '').trim();
          if (!title || !content) continue;
          pushItem({ id: `${documentId}::${singleLine(item?.id)}`, title, resume: singleLine(item?.resume), content });
        }
      } catch (error) {
        log(`读取知识库条目失败，已跳过文档 ${documentId}：${error.message || String(error)}`, 12);
      }
    }
  }
  if (snippetIds.length && knowledgeBaseService?.getSnippetReferences) {
    try {
      const snippetResult = knowledgeBaseService.getSnippetReferences(snippetIds);
      for (const item of Array.isArray(snippetResult?.items) ? snippetResult.items : []) {
        const title = singleLine(item?.title);
        const content = String(item?.resume || '').trim();
        if (!title || !content) continue;
        pushItem({ id: singleLine(item?.id), title, resume: singleLine(content), content });
      }
    } catch (error) {
      log(`读取知识库片段失败，已跳过：${error.message || String(error)}`, 12);
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

function formatKnowledgeItems(items) {
  if (!items.length) return '未选择参考知识库。';
  return items.map((item, index) => formatKnowledgeItemForPrompt(item, index)).join('\n\n');
}

function formatClauseMatrix(clauseItems) {
  const items = Array.isArray(clauseItems) ? clauseItems : [];
  if (!items.length) return '尚未生成商务响应矩阵。';
  return items.map((clause) => `## ${singleLine(clause.category)} / ${singleLine(clause.title)}
- 招标要求：${singleLine(clause.requirement)}
- 响应状态：${singleLine(clause.response_status)}
- 响应内容：${singleLine(clause.response_detail)}
- 偏离说明：${singleLine(clause.deviation)}`).join('\n\n');
}

function formatGlobalFacts(groups) {
  const items = Array.isArray(groups) ? groups : [];
  if (!items.length) return '尚未生成商务全局事实。';
  return items.map((group) => `## ${singleLine(group.title)}\n${singleLine(group.content)}`).join('\n\n');
}

async function collectJson(aiService, options) {
  return aiService.collectJsonResponse ? aiService.collectJsonResponse(options) : aiService.requestJson(options);
}

function normalizeClauseStatus(value) {
  if (value === '已响应') return 'success';
  if (value === '不满足') return 'error';
  return 'idle';
}

function normalizeClauseItems(value) {
  const source = value?.clauses || value?.result?.clauses || [];
  if (!Array.isArray(source)) return [];
  return source.map((item, index) => {
    const id = singleLine(item?.id || `clause_${String(index + 1).padStart(2, '0')}`);
    const responseStatus = ['已响应', '待确认', '需复核', '不满足'].includes(item?.response_status) ? item.response_status : '待确认';
    return {
      id,
      category: singleLine(item?.category || '商务条款'),
      title: singleLine(item?.title || `商务条款 ${index + 1}`),
      requirement: singleLine(item?.requirement),
      response_status: responseStatus,
      response_detail: singleLine(item?.response_detail),
      deviation: singleLine(item?.deviation),
    };
  }).filter((item) => item.id && item.title);
}

function normalizeOutlineResponse(value) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const outline = Array.isArray(source.outline) ? source.outline : [];
  const projectName = source.project_name ? singleLine(source.project_name) : undefined;
  return { outline, projectName };
}

function normalizeGlobalFactGroups(value) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const rawGroups = Array.isArray(source.groups) ? source.groups : [];
  const used = new Set();
  const groups = rawGroups.map((group, index) => {
    const title = singleLine(group?.title || group?.name || `事实 ${index + 1}`);
    const content = Array.isArray(group?.content)
      ? group.content.map((line) => singleLine(line)).filter(Boolean).join('\n')
      : singleLine(group?.content ?? group?.markdown ?? group?.facts);
    const rawId = singleLine(group?.id || group?.group_id || title).toLowerCase().replace(/[^a-z0-9_\-]+/g, '_').replace(/^_+|_+$/g, '');
    let id = rawId || `fact_${String(index + 1).padStart(3, '0')}`;
    let suffix = 2;
    while (used.has(id)) {
      id = `${rawId}_${suffix}`;
      suffix += 1;
    }
    used.add(id);
    return { id, title, content };
  }).filter((group) => group.title && group.content);
  return { groups };
}

function renumberOutlineItems(items, parentPrefix = '') {
  return (items || []).map((item, index) => {
    const id = parentPrefix ? `${parentPrefix}.${index + 1}` : `${index + 1}`;
    const children = item.children?.length ? renumberOutlineItems(item.children, id) : undefined;
    return { ...item, id, children };
  });
}

// ── 模板识别与填充 ────────────────────────────────

// 描述中包含这些关键词且超过一定长度时，认为是模板描述
const TEMPLATE_KEYWORDS = ['投标函', '致：', '报价', '工期', '项目负责人', '付款', '质保', '履约保证金', '保函', '售后服务', '交付'];

function isTemplateCandidate(description) {
  const text = String(description || '').trim();
  if (text.length < 60) return false;
  const matched = TEMPLATE_KEYWORDS.filter((keyword) => text.includes(keyword));
  return matched.length >= 2;
}

// 变量→全局事实的关联映射（同义词表）
const VARIABLE_SYNONYMS = {
  '招标人': ['招标人', '业主', '建设单位', '甲方', '采购方', '发包方', '委托人'],
  '投标人': ['投标人', '投标单位', '我方', '本公司', '我单位'],
  '报价': ['报价', '投标报价', '投标总价', '报价总金额', '金额', '总价'],
  '项目负责人': ['项目负责人', '项目经理', '项目总工'],
  '工期': ['工期', '交付期', '交货期', '完成期限'],
  '质保': ['质保期', '保修期', '保修期限'],
  '付款': ['付款', '付款条件', '付款方式', '支付'],
  '履约保证金': ['履约保证金', '履约担保'],
  '保函': ['保函', '银行保函'],
  '售后服务': ['售后服务', '售后'],
  '交付': ['交付', '交货', '供货'],
  '投标保证金': ['投标保证金'],
  '合同': ['合同', '签约'],
};

function buildSynonymSearch(name) {
  return VARIABLE_SYNONYMS[name] || [name];
}

function extractValueFromText(text, keywords) {
  // 按行搜索，找到包含任意keyword的行，取其后的值
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    for (const keyword of keywords) {
      const idx = trimmed.indexOf(keyword);
      if (idx < 0) continue;
      const after = trimmed.slice(idx + keyword.length).replace(/^[:：\s]+/, '').trim();
      if (after && after.length > 0 && after.length < 200) return after;
    }
  }
  // 全文搜索
  for (const keyword of keywords) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`${escaped}[:：]\\s*([^\\n]{1,200})`, 'i');
    const match = text.match(regex);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

async function identifyTemplate(aiService, description) {
  const messages = [
    {
      role: 'system',
      content: `分析下面的章节描述，判断它是否包含具体的标书格式框架（模板），而不是简短的说明文字。

模板的特征：
- 包含章节的具体段落结构（如投标函的致、我方、报价、工期等）
- 包含需要填充的实际变量（如招标人名称、报价金额等）
- 格式相对完整，可直接填充后作为标书正文

请返回 JSON：
{
  "has_template": true/false,
  "reason": "判断理由",
  "fixed_content": "提取的固定内容骨架，变量用 __变量名__ 标记",
  "variables": [
    {"name": "变量名", "anchor": "变量在描述中的上下文，如'致：'"}
  ]
}

如果 has_template 为 false，只返回 {"has_template": false, "reason": "..."}`,
    },
    { role: 'user', content: `章节描述：\n${description}` },
  ];

  try {
    const response = await collectJson(aiService, {
      messages,
      temperature: 0.3,
      logTitle: '模板识别',
      progressLabel: '模板识别',
      failureMessage: '模板识别失败',
      normalizer: (value) => {
        const result = value?.result && typeof value.result === 'object' ? value.result : value || {};
        return {
          has_template: Boolean(result.has_template),
          reason: String(result.reason || ''),
          fixed_content: String(result.fixed_content || ''),
          variables: Array.isArray(result.variables) ? result.variables : [],
        };
      },
      validator: (value) => {
        if (value.has_template && (!Array.isArray(value.variables) || !value.fixed_content)) {
          throw new Error('模板识别结果缺少 variables 或 fixed_content');
        }
      },
    });
    return response;
  } catch (error) {
    console.error('[businessBid] 模板识别失败', error?.message || String(error));
    return { has_template: false, reason: '识别失败', fixed_content: '', variables: [] };
  }
}

async function fillVariables(variables, globalFacts, clauseItems, tenderMarkdown, aiService) {
  if (!Array.isArray(variables)) return variables;
  const globalFactsText = `${formatGlobalFacts(globalFacts)}\n${formatClauseMatrix(clauseItems)}`;

  for (const v of variables) {
    if (!v?.name) continue;
    const keywords = buildSynonymSearch(v.name);
    // 一级：精确匹配
    let value = extractValueFromText(globalFactsText, keywords);
    // 二级：从招标文件搜索
    if (!value && tenderMarkdown) {
      value = extractValueFromText(tenderMarkdown, keywords);
    }
    // 三级：LLM推理
    if (!value && aiService) {
      try {
        const response = await collectJson(aiService, {
          messages: [
            {
              role: 'system',
              content: `从以下上下文中提取"${v.name}"的精确值返回。如果找不到明确值，返回 null 而不是猜测。
返回 JSON：{"value": "精确值字符串" | null}`,
            },
            { role: 'user', content: `上下文：\n${globalFactsText.slice(0, 3000)}` },
          ],
          temperature: 0.2,
          logTitle: '变量补全',
          progressLabel: '变量补全',
          failureMessage: '变量提取失败',
          normalizer: (value) => {
            const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
            return { value: String(source.value || '') || null };
          },
          validator: () => {},
        });
        value = response?.value || null;
      } catch {
        value = null;
      }
    }
    v.extracted_value = value || null;
  }
  return variables;
}

function applyTemplate(fixedContent, variables) {
  let result = String(fixedContent || '');
  for (const v of Array.isArray(variables) ? variables : []) {
    if (!v?.name) continue;
    if (!v.extracted_value) continue;
    const escapedName = v.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`__${escapedName}__`, 'g'), v.extracted_value);
  }
  return result;
}

function fillCheck(variables, content) {
  const missing = [];
  for (const v of Array.isArray(variables) ? variables : []) {
    if (!v?.name) continue;
    const value = v.extracted_value || null;
    // value 应在正文中出现
    if (!value || !content.includes(value)) {
      missing.push(v);
    }
  }
  return missing;
}

async function aiRepairMissing(aiService, content, missing, globalFacts) {
  const missingDesc = missing.map((v) => `- ${v.name}（期望值：${v.extracted_value || v.name}）`).join('\n');
  const messages = [
    {
      role: 'system',
      content: '请将模板中遗漏的变量值补充到正文中合适的位置。只返回完整的正文（Markdown），不要加解释。',
    },
    { role: 'user', content: `当前正文：\n${content}\n\n需要补充的变量：\n${missingDesc}\n\n参考上下文：\n${formatGlobalFacts(globalFacts).slice(0, 2000)}` },
  ];
  try {
    const response = await aiService.chat({ messages, temperature: 0.4 });
    return String(response || '').trim() || content;
  } catch {
    return content;
  }
}

function outlineDepth(items) {
  if (!items.length) return 0;
  return 1 + Math.max(...items.map((item) => outlineDepth(item.children || [])));
}

function validateBusinessOutline(outline) {
  if (!Array.isArray(outline) || !outline.length) {
    throw new Error('商务标目录不能为空');
  }
  if (outlineDepth(outline) < 3) {
    throw new Error('商务标目录至少需要三级结构');
  }
}

// ── 步骤 1：扫描招标文件，识别"商务标应包含内容"清单 ──────────────
async function detectBusinessContentList(aiService, tenderMarkdown) {
  const messages = [
    {
      role: 'system',
      content: `你是严谨的招标文件分析专家。请仔细阅读招标文件，找出其中明确列出的"商务标应包括以下内容"或类似要求的清单。

判断规则：
1. 查找章节标题/说明中明确写道"商务标应包括""商务部分应包括""商务标书应包含""商务标内容"等字样的段落。
2. 这些内容通常以列表形式出现（序号列表、bullet 列表或明确的段落枚举）。
3. 只识别**商务标**的内容要求，不包括技术标、资格审查资料等。
4. 如果招标文件中没有明确列出商务标应包含的内容清单，hasExplicitList 返回 false。
5. 只返回 JSON，不要输出分析过程。`,
    },
    { role: 'user', content: `招标文件正文：\n${String(tenderMarkdown || '').trim().slice(0, 30000)}` },
    { role: 'user', content: `{
  "hasExplicitList": true/false,
  "sourceText": "招标文件中列明商务标应包含内容的具体原文段落（如有多段，完整摘录），无明确清单时返回空字符串",
  "requiredItems": ["逐项列出招标文件要求的商务标内容，每项一条"]
}
判断为 false 时，requiredItems 返回空数组。` },
  ];

  try {
    const response = await collectJson(aiService, {
      messages,
      temperature: 0.1,
      logTitle: '商务标内容清单识别',
      progressLabel: '识别商务标内容清单',
      failureMessage: '模型返回的清单识别结果格式无效',
      normalizer: (value) => {
        const result = value?.result && typeof value.result === 'object' ? value.result : value || {};
        return {
          hasExplicitList: Boolean(result.hasExplicitList),
          sourceText: String(result.sourceText || ''),
          requiredItems: Array.isArray(result.requiredItems) ? result.requiredItems.map((item) => String(item || '').trim()).filter(Boolean) : [],
        };
      },
      validator: () => {},
    });
    return response;
  } catch (error) {
    console.error('[businessBid] 商务标内容清单识别失败', error?.message || String(error));
    return { hasExplicitList: false, sourceText: '', requiredItems: [] };
  }
}

// ── 根据清单或模板补充的 prompt 片段构造 ──────────────
function buildContentListContext(hasExplicitList, requiredItems, sourceText, templateContent) {
  const parts = [];
  if (hasExplicitList && requiredItems.length > 0) {
    parts.push(`招标文件明确要求商务标应包含以下内容（以此为准生成响应矩阵，确保每条均有响应）：`);
    requiredItems.forEach((item, index) => parts.push(`  ${index + 1}. ${item}`));
    if (sourceText) parts.push(`\n原文依据：\n${sourceText}`);
  }
  if (templateContent && templateContent.trim()) {
    parts.push(`\n参考以下商务标模板中的内容清单，确保矩阵覆盖模板中列出的所有条款：`);
    parts.push(String(templateContent).trim());
  }
  return parts.join('\n');
}

async function loadTemplateContents(knowledgeBaseService, templateItemIds, log) {
  if (!Array.isArray(templateItemIds) || !templateItemIds.length) return '';
  if (!knowledgeBaseService?.readItems && !knowledgeBaseService?.getSnippetReferences) {
    log('未找到知识库读取服务，无法加载模板内容。', 12);
    return '';
  }
  const contents = [];
  for (const id of templateItemIds) {
    try {
      // 先尝试作为文档 ID 读取（读取文档的所有条目）
      if (knowledgeBaseService.readItems) {
        const documentItems = await knowledgeBaseService.readItems(id);
        if (Array.isArray(documentItems) && documentItems.length > 0) {
          for (const item of documentItems) {
            const title = singleLine(item?.title);
            const content = String(item?.content || '').trim();
            if (title && content) {
              contents.push(`## ${title}\n${content}`);
            }
          }
          continue; // 成功作为文档读取，跳过后续处理
        }
      }
      // 如果作为文档 ID 读取失败（无条目），尝试作为 snippet ID
      if (knowledgeBaseService.getSnippetReferences) {
        const result = knowledgeBaseService.getSnippetReferences([id]);
        for (const item of Array.isArray(result?.items) ? result.items : []) {
          const title = singleLine(item?.title);
          const content = String(item?.resume || item?.content || '').trim();
          if (title && content) {
            contents.push(`## ${title}\n${content}`);
          }
        }
      }
    } catch (error) {
      log(`加载模板 ${id} 失败：${error.message || String(error)}`, 12);
    }
  }
  log(contents.length ? `已加载 ${contents.length} 条模板内容。` : '未找到模板内容。', 12);
  return contents.join('\n\n---\n\n');
}

async function runBusinessClauseAnalysisTask({ aiService, workspaceStore, knowledgeBaseService, updateTask, payload }) {
  let logs = ['开始解析商务条款。'];
  let currentProgress = 5;
  function log(message, progress = currentProgress) {
    currentProgress = Math.max(currentProgress, Math.min(progress, 99));
    logs = [...logs, message];
    updateTask({ status: 'running', progress: currentProgress, logs });
    workspaceStore.updateBusinessBid({ clauseAnalysisTask: { task_id: '', type: 'business-clause-analysis', status: 'running', progress: currentProgress, logs, started_at: now(), updated_at: now() } });
  }

  const storedPlan = workspaceStore.loadBusinessBid() || {};
  const tenderMarkdown = workspaceStore.readTenderMarkdown();
  if (!String(tenderMarkdown || '').trim()) {
    throw new Error('请先导入招标文件，再解析商务条款');
  }

  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(storedPlan);
  const referenceKnowledgeSnippetIds = normalizeReferenceSnippetIds(storedPlan);
  const technicalPlanSummary = storedPlan.referenceTechnicalPlanSummary || '';
  log('正在读取招标文件与参考知识库。', 10);
  const knowledgeItems = loadKnowledgeItems(knowledgeBaseService, referenceKnowledgeDocumentIds, referenceKnowledgeSnippetIds, normalizeReferenceItemIds(storedPlan), log);
  const relevantKnowledge = selectRelevantItems(BUSINESS_CLAUSE_QUERY, knowledgeItems, { maxItems: MAX_KNOWLEDGE_ITEMS });
  log(`按商务相关性筛选：知识库 ${relevantKnowledge.length}/${knowledgeItems.length} 条用于条款解析。`, 12);

  // ── 步骤 1：扫描招标文件，识别商务标应包含内容清单 ─────────
  updateTask({ status: 'running', progress: 15, logs });
  log('正在扫描招标文件中的商务标内容清单。', 15);
  const contentList = await detectBusinessContentList(aiService, tenderMarkdown);
  const hasExplicitList = contentList.hasExplicitList;
  const requiredItems = contentList.requiredItems || [];
  const sourceText = contentList.sourceText || '';

  if (hasExplicitList) {
    log(`招标文件中已识别到明确的商务标内容清单：${requiredItems.length} 项。`, 18);
  } else {
    log('招标文件中未识别到明确的商务标应包含内容清单。生成后将提示您补充模板。', 18);
  }

  // ── 加载用户先前选择的模板条目内容（如有） ────────────────
  const selectedTemplateItemIds = Array.isArray(storedPlan.selectedTemplateItemIds) ? storedPlan.selectedTemplateItemIds : [];
  let templateContent = '';
  if (selectedTemplateItemIds.length > 0) {
    templateContent = await loadTemplateContents(knowledgeBaseService, selectedTemplateItemIds, log);
  }

  updateTask({ status: 'running', progress: 25, logs });

  // ── 步骤 2：构造 prompt ──────────────────────────────
  const contentListContext = buildContentListContext(hasExplicitList, requiredItems, sourceText, templateContent);
  const hasContentGuide = (hasExplicitList && requiredItems.length > 0) || templateContent.trim().length > 0;

  const systemContent = hasContentGuide
    ? `你是专业的商务标书编制助手，擅长从招标文件中抽取商务条款并形成可复核的响应矩阵。

招标文件对商务标应包含的内容有明确要求。请严格按照以下内容清单逐项生成响应矩阵条目，确保不遗漏任何要求。

输出要求：
1. 只使用简体中文。
2. 对内容清单中的每一项，生成对应的矩阵条目（category/title/requirement/response）。
3. 此外，如果招标文件中还有其他商务条款（付款条件、履约保证金、质保/运维、报价有效期、合同条款偏离、资信与业绩要求、交付与供货周期、违约责任等），也继续补充生成。
4. 技术参数、施工/实施细节等纯技术内容不要纳入商务响应矩阵。
5. 对每条商务条款给出明确的响应状态：已响应 / 待确认 / 需复核 / 不满足，并写出可落到标书中的响应内容与偏离说明。
6. 只返回 JSON，不要输出分析过程。`
    : `你是专业的商务标书编制助手，擅长从招标文件中抽取商务条款并形成可复核的响应矩阵。

输出要求：
1. 只使用简体中文。
2. 聚焦商务维度：付款条件、履约保证金、质保/运维、报价有效期、合同条款偏离、资信与业绩要求、交付与供货周期、违约责任等。
3. 技术参数、施工/实施细节等纯技术内容不要纳入商务响应矩阵。
4. 对每条商务条款给出明确的响应状态：已响应 / 待确认 / 需复核 / 不满足，并写出可落到标书中的响应内容与偏离说明。
5. 只返回 JSON，不要输出分析过程。`;

  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: `招标文件正文：\n${String(tenderMarkdown || '').trim()}` },
    {
      role: 'user',
      content: technicalPlanSummary.trim()
        ? `已生成技术方案（作为可选参考上下文，已按商务相关性筛选）：\n${selectRelevantParagraphs(BUSINESS_CLAUSE_QUERY, technicalPlanSummary.trim(), { maxParagraphs: MAX_TECH_PARAGRAPHS })}`
        : '未关联技术方案，本次仅基于招标文件与知识库。',
    },
    { role: 'user', content: `参考知识库条目（按商务相关性筛选）：\n${formatKnowledgeItems(relevantKnowledge)}` },
  ];

  // 如果有内容清单/模板约束，添加上下文
  if (hasContentGuide) {
    messages.push({ role: 'user', content: contentListContext });
  }

  messages.push({
    role: 'user',
    content: `请识别招标文件中的商务条款，并输出商务响应矩阵，JSON 格式如下：
{
  "clauses": [
    {
      "id": "clause_01",
      "category": "付款条件",
      "title": "进度款支付比例",
      "requirement": "按月考评合格后支付至已完成工程量 80%",
      "response_status": "已响应",
      "response_detail": "承诺按月计量，验收合格后 30 日内支付至已完成工程量 80%。",
      "deviation": "无偏离，完全响应。"
    }
  ]
}
要求：clauses 至少覆盖付款、履约/质保、报价有效期、合同偏离、资信业绩、交付周期等核心商务主题；响应状态必须如实判断；响应内容应当具体、可用于标书。${hasContentGuide ? '\n特别注意：必须按招标文件要求的内容清单逐项生成对应的矩阵条目，不可遗漏。' : ''}`,
  });

  const response = await collectJson(aiService, {
    messages,
    temperature: 0.3,
    logTitle: '商务条款响应矩阵',
    progressLabel: '商务条款解析',
    failureMessage: '模型返回的商务响应矩阵格式无效',
    normalizer: (value) => ({ clauses: normalizeClauseItems(value) }),
    validator: (value) => {
      if (!Array.isArray(value?.clauses) || !value.clauses.length) {
        throw new Error('商务响应矩阵缺少 clauses');
      }
    },
    progressCallback: (message) => log(message, 60),
  });

  const clauseItems = response.clauses || [];
  const clauseAnalysisTasks = {};
  for (const item of clauseItems) {
    clauseAnalysisTasks[item.id] = {
      id: item.id,
      label: `${item.category} / ${item.title}`,
      status: normalizeClauseStatus(item.response_status),
      content: [`招标要求：${item.requirement}`, `响应内容：${item.response_detail}`, `偏离说明：${item.deviation}`].filter(Boolean).join('\n'),
    };
  }

  const state = workspaceStore.updateBusinessBid({
    clauseItems,
    clauseAnalysisTasks,
    clauseAnalysisProgress: 100,
    hasExplicitContentList: hasExplicitList,
    requiredBusinessContents: requiredItems,
    clauseAnalysisTask: { task_id: '', type: 'business-clause-analysis', status: 'success', progress: 100, logs: [...logs, `商务响应矩阵已生成：${clauseItems.length} 项。`], started_at: now(), updated_at: now() },
  });
  updateTask({ status: 'success', progress: 100, logs: [...logs, `商务响应矩阵已生成：${clauseItems.length} 项。`] }, state);
}

// ── 用知识库模板重新生成商务响应矩阵 ─────────────────
async function runBusinessClauseRegenerationTask({ aiService, workspaceStore, knowledgeBaseService, updateTask, payload }) {
  const templateItemIds = Array.isArray(payload?.templateItemIds) ? payload.templateItemIds : [];
  if (!templateItemIds.length) {
    throw new Error('请选择包含商务标模板的知识库条目');
  }

  let logs = ['开始基于模板重新生成商务响应矩阵。'];
  let currentProgress = 5;
  function log(message, progress = currentProgress) {
    currentProgress = Math.max(currentProgress, Math.min(progress, 99));
    logs = [...logs, message];
    updateTask({ status: 'running', progress: currentProgress, logs });
    workspaceStore.updateBusinessBid({ clauseAnalysisTask: { task_id: '', type: 'business-clause-analysis', status: 'running', progress: currentProgress, logs, started_at: now(), updated_at: now() } });
  }

  const storedPlan = workspaceStore.loadBusinessBid() || {};
  const tenderMarkdown = workspaceStore.readTenderMarkdown();
  if (!String(tenderMarkdown || '').trim()) {
    throw new Error('请先导入招标文件，再重新生成商务响应矩阵');
  }

  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(storedPlan);
  const referenceKnowledgeSnippetIds = normalizeReferenceSnippetIds(storedPlan);
  const technicalPlanSummary = storedPlan.referenceTechnicalPlanSummary || '';
  log('正在读取招标文件与模板内容。', 10);
  const knowledgeItems = loadKnowledgeItems(knowledgeBaseService, referenceKnowledgeDocumentIds, referenceKnowledgeSnippetIds, normalizeReferenceItemIds(storedPlan), log);
  const relevantKnowledge = selectRelevantItems(BUSINESS_CLAUSE_QUERY, knowledgeItems, { maxItems: MAX_KNOWLEDGE_ITEMS });
  log(`按商务相关性筛选：知识库 ${relevantKnowledge.length}/${knowledgeItems.length} 条用于条款解析。`, 12);

  // 加载用户选择的模板条目
  log('正在加载商务标模板内容。', 15);
  const templateContent = await loadTemplateContents(knowledgeBaseService, templateItemIds, log);
  if (!templateContent.trim()) {
    throw new Error('所选模板条目内容为空，请选择包含有效商务标模板内容的条目');
  }
  log(`已加载模板内容（${templateContent.length} 字），将按模板约束重新生成。`, 18);

  // 重新检测招标文件中的商务标内容清单，合并作为约束
  log('正在扫描招标文件中的商务标内容清单。', 18);
  const contentList = await detectBusinessContentList(aiService, tenderMarkdown);
  const hasExplicitList = contentList.hasExplicitList;
  const requiredItems = contentList.requiredItems || [];
  const sourceText = contentList.sourceText || '';
  if (hasExplicitList) {
    log(`招标文件中已识别到明确的商务标内容清单：${requiredItems.length} 项，将合并约束。`, 19);
  }
  const contentListContext = buildContentListContext(hasExplicitList, requiredItems, sourceText, templateContent);

  // 保存用户选择的模板 ID
  workspaceStore.updateBusinessBid({ selectedTemplateItemIds: templateItemIds, templateApplied: true, hasExplicitContentList: hasExplicitList, requiredBusinessContents: requiredItems });
  updateTask({ status: 'running', progress: 20, logs });

  const messages = [
    {
      role: 'system',
      content: `你是专业的商务标书编制助手，擅长从招标文件中抽取商务条款并形成可复核的响应矩阵。

用户已选择商务标模板来约束矩阵生成。请严格按照以下模板中的内容清单逐项生成响应矩阵条目，确保不遗漏任何要求。

输出要求：
1. 只使用简体中文。
2. 对模板中列出的每一项商务标内容，生成对应的矩阵条目（category/title/requirement/response）。
3. 此外，如果招标文件中还有其他商务条款（付款条件、履约保证金、质保/运维、报价有效期、合同条款偏离、资信与业绩要求、交付与供货周期、违约责任等），也继续补充生成。
4. 技术参数、施工/实施细节等纯技术内容不要纳入商务响应矩阵。
5. 对每条商务条款给出明确的响应状态：已响应 / 待确认 / 需复核 / 不满足，并写出可落到标书中的响应内容与偏离说明。
6. 只返回 JSON，不要输出分析过程。`,
    },
    { role: 'user', content: `招标文件正文：\n${String(tenderMarkdown || '').trim()}` },
    {
      role: 'user',
      content: technicalPlanSummary.trim()
        ? `已生成技术方案（作为可选参考上下文，已按商务相关性筛选）：\n${selectRelevantParagraphs(BUSINESS_CLAUSE_QUERY, technicalPlanSummary.trim(), { maxParagraphs: MAX_TECH_PARAGRAPHS })}`
        : '未关联技术方案，本次仅基于招标文件与知识库。',
    },
    { role: 'user', content: `参考知识库条目（按商务相关性筛选）：\n${formatKnowledgeItems(relevantKnowledge)}` },
    { role: 'user', content: `用户选择的商务标模板内容（请以此作为矩阵生成的骨架，逐项响应）：
${templateContent}` },
  ];

  // 如果有招标文件中的内容清单，追加约束（与模板合并）
  if (hasExplicitList && requiredItems.length > 0) {
    messages.push({ role: 'user', content: contentListContext });
  }

  messages.push({
    role: 'user',
    content: `请识别招标文件中的商务条款，并输出商务响应矩阵，JSON 格式如下：
{
  "clauses": [
    {
      "id": "clause_01",
      "category": "付款条件",
      "title": "进度款支付比例",
      "requirement": "按月考评合格后支付至已完成工程量 80%",
      "response_status": "已响应",
      "response_detail": "承诺按月计量，验收合格后 30 日内支付至已完成工程量 80%。",
      "deviation": "无偏离，完全响应。"
    }
  ]
}
特别注意：必须按模板中的内容清单逐项生成对应的矩阵条目，不可遗漏。${hasExplicitList && requiredItems.length > 0 ? '\n\t同时必须覆盖招标文件中明确要求的商务标内容，模板与招标文件要求须合并处理。' : ''}`,
    });

  const response = await collectJson(aiService, {
    messages,
    temperature: 0.3,
    logTitle: '商务条款响应矩阵（模板约束）',
    progressLabel: '商务条款解析（模板）',
    failureMessage: '模型返回的商务响应矩阵格式无效',
    normalizer: (value) => ({ clauses: normalizeClauseItems(value) }),
    validator: (value) => {
      if (!Array.isArray(value?.clauses) || !value.clauses.length) {
        throw new Error('商务响应矩阵缺少 clauses');
      }
    },
    progressCallback: (message) => log(message, 60),
  });

  const clauseItems = response.clauses || [];
  const clauseAnalysisTasks = {};
  for (const item of clauseItems) {
    clauseAnalysisTasks[item.id] = {
      id: item.id,
      label: `${item.category} / ${item.title}`,
      status: normalizeClauseStatus(item.response_status),
      content: [`招标要求：${item.requirement}`, `响应内容：${item.response_detail}`, `偏离说明：${item.deviation}`].filter(Boolean).join('\n'),
    };
  }

  const state = workspaceStore.updateBusinessBid({
    clauseItems,
    clauseAnalysisTasks,
    clauseAnalysisProgress: 100,
    hasExplicitContentList: hasExplicitList,
    selectedTemplateItemIds: templateItemIds,
    templateApplied: true,
    clauseAnalysisTask: { task_id: '', type: 'business-clause-analysis', status: 'success', progress: 100, logs: [...logs, `商务响应矩阵已基于模板重新生成：${clauseItems.length} 项。`], started_at: now(), updated_at: now() },
  });
  updateTask({ status: 'success', progress: 100, logs: [...logs, `商务响应矩阵已基于模板重新生成：${clauseItems.length} 项。`] }, state);
}

function normalizeWordControlOptionsForBusiness(value) {
  const sectionWords = Number.isFinite(Number(value?.sectionWords)) && Number(value.sectionWords) >= 0 ? Math.floor(Number(value.sectionWords)) : 0;
  return {
    minimumWords: Number.isFinite(Number(value?.minimumWords)) && Number(value.minimumWords) >= 0 ? Math.floor(Number(value.minimumWords)) : 0,
    maximumWords: Number.isFinite(Number(value?.maximumWords)) && Number(value.maximumWords) >= 0 ? Math.floor(Number(value.maximumWords)) : 0,
    sectionWords,
    strictSectionWords: sectionWords > 0 && Boolean(value?.strictSectionWords),
  };
}

function buildBusinessRootOutlineMessages({ storedPlan, tenderMarkdown, clauseItems, technicalPlanSummary, relevantKnowledge }) {
  const outlineQuery = `${BUSINESS_OUTLINE_QUERY} ${singleLine(storedPlan.tenderFile?.fileName) || ''} ${(clauseItems || []).map((c) => `${c.category} ${c.title}`).join(' ')}`;
  return [
    { role: 'system', content: `你是专业的商务标书目录设计助手。请基于商务响应矩阵与招标文件，先设计一级目录（章）候选，供用户确认。

要求：
1. 只使用简体中文。
2. 一级目录（章）覆盖：投标函与法定代表人身份证明、商务响应表、报价说明与报价汇总、合同条款偏离表、资格审查与资信业绩材料、供货/交付与售后服务承诺、付款与履约保障等。
3. 至少 6 个一级章，最多 10 个。
4. 只返回 JSON。` },
    { role: 'user', content: `项目/标段名称：${singleLine(storedPlan.tenderFile?.fileName) || '未提供'}` },
    { role: 'user', content: `商务响应矩阵：\n${formatClauseMatrix(clauseItems)}` },
    { role: 'user', content: `招标文件正文：\n${String(tenderMarkdown || '').trim().slice(0, 20000)}` },
    { role: 'user', content: technicalPlanSummary.trim() ? `已生成技术方案（可选参考上下文，已按目录主题筛选）：\n${selectRelevantParagraphs(outlineQuery, technicalPlanSummary.trim(), { maxParagraphs: MAX_TECH_PARAGRAPHS })}` : '未关联技术方案。' },
    { role: 'user', content: `参考知识库条目（按目录主题筛选）：\n${formatKnowledgeItems(relevantKnowledge)}` },
    { role: 'user', content: `请输出一级目录 JSON 格式如下：
{
  "outline": [
    { "id": "1", "title": "投标函及投标函附录", "description": "投标承诺与法定代表人身份证明" }
  ]
}` },
  ];
}

function buildBusinessChildrenMessages({ storedPlan, clauseItems, confirmedRoots, relevantKnowledge, sectionWords }) {
  return [
    { role: 'system', content: `你是专业的商务标书目录设计助手。基于已确认的一级目录，生成完整的商务标三级目录。

要求：
1. 只使用简体中文。
2. 目录应为三级结构：章（1.）→ 节（1.1）→ 点（1.1.1）。
3. 只对用户确认的一级目录生成子目录。
4. 不要照搬技术实施方案的细节，聚焦商务与合同维度。
5. 每小节正文目标字数约 ${sectionWords} 字。
6. 只返回 JSON。` },
    { role: 'user', content: `项目/标段名称：${singleLine(storedPlan.tenderFile?.fileName) || '未提供'}` },
    { role: 'user', content: `商务响应矩阵：\n${formatClauseMatrix(clauseItems)}` },
    { role: 'user', content: `已确认的一级目录：\n${confirmedRoots.map((item) => `${item.id} ${item.title}：${item.description}`).join('\n')}` },
    { role: 'user', content: `参考知识库条目（按目录主题筛选）：\n${formatKnowledgeItems(relevantKnowledge)}` },
    { role: 'user', content: `请输出完整商务标目录，JSON 格式如下：
{
  "outline": [
    {
      "id": "1",
      "title": "投标函及投标函附录",
      "description": "投标承诺与法定代表人身份证明",
      "children": [
        { "id": "1.1", "title": "投标函", "description": "投标报价与工期承诺" },
        { "id": "1.2", "title": "法定代表人身份证明", "description": "法人资格与授权" }
      ]
    }
  ]
}
要求：每个一级章至少 2 个二级节，每节至少 2 个三级点。` },
  ];
}

async function runBusinessOutlineGenerationTask({ aiService, workspaceStore, knowledgeBaseService, updateTask, checkpointTask, taskControl, payload }) {
  let logs = ['开始生成商务标目录。'];
  let currentProgress = 5;
  function log(message, progress = currentProgress) {
    currentProgress = Math.max(currentProgress, Math.min(progress, 99));
    logs = [...logs, message];
    workspaceStore.updateBusinessBid({ outlineGenerationTask: { task_id: '', type: 'business-outline-generation', status: 'running', progress: currentProgress, logs, started_at: now(), updated_at: now() } });
  }

  const storedPlan = workspaceStore.loadBusinessBid() || {};
  const tenderMarkdown = workspaceStore.readTenderMarkdown();
  if (!String(tenderMarkdown || '').trim()) {
    throw new Error('请先导入招标文件，再生成目录');
  }
  const clauseItems = storedPlan.clauseItems || [];
  if (!clauseItems.length) {
    throw new Error('请先完成商务条款解析，再生成目录');
  }

  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(storedPlan);
  const referenceKnowledgeSnippetIds = normalizeReferenceSnippetIds(storedPlan);
  const referenceKnowledgeItemIds = normalizeReferenceItemIds(storedPlan);
  const wordControlOptions = normalizeWordControlOptionsForBusiness(storedPlan.outlineWordControlOptions);
  const technicalPlanSummary = storedPlan.referenceTechnicalPlanSummary || '';
  const knowledgeItems = loadKnowledgeItems(knowledgeBaseService, referenceKnowledgeDocumentIds, referenceKnowledgeSnippetIds, referenceKnowledgeItemIds, log);
  const outlineQuery = `${BUSINESS_OUTLINE_QUERY} ${singleLine(storedPlan.tenderFile?.fileName) || ''} ${(clauseItems || []).map((c) => `${c.category} ${c.title}`).join(' ')}`;
  const relevantKnowledge = selectRelevantItems(outlineQuery, knowledgeItems, { maxItems: MAX_KNOWLEDGE_ITEMS });
  log(`按目录主题筛选：知识库 ${relevantKnowledge.length}/${knowledgeItems.length} 条用于目录生成。`, 12);

  // ── 阶段一：生成一级目录候选，等待用户确认 ─────────────────
  const rootMessages = buildBusinessRootOutlineMessages({ storedPlan, tenderMarkdown, clauseItems, technicalPlanSummary, relevantKnowledge });
  log('正在生成一级目录候选。', 25);
  const rootResponse = await collectJson(aiService, {
    messages: rootMessages,
    temperature: 0.4,
    logTitle: '商务标一级目录生成',
    progressLabel: '商务一级目录生成',
    failureMessage: '模型返回的商务标一级目录格式无效',
    normalizer: (value) => normalizeOutlineResponse(value),
    validator: (value) => {
      if (!Array.isArray(value?.outline) || !value.outline.length) throw new Error('商务标一级目录缺少 outline');
    },
    progressCallback: (message) => log(message, 40),
  });
  const rootItems = (rootResponse.outline || []).map((item, index) => ({
    id: String(index + 1),
    title: singleLine(item.title),
    description: singleLine(item.description),
    attr: '商务',
    content_mode: 'ai-generate',
  }));
  const selection = { items: rootItems, selected_ids: rootItems.map((item) => item.id), confirmed: false };
  log('一级目录已生成，等待确认。', 45);
  checkpointTask({ status: 'waiting-outline-selection', progress: 45, logs, stats: { outline_selection: selection } });

  const confirmed = await taskControl.waitForOutlineSelection();
  const selectedIdSet = new Set(confirmed.selectedIds || []);
  const confirmedRoots = rootItems.filter((item) => selectedIdSet.has(item.id));
  if (!confirmedRoots.length) throw new Error('未选择任何一级目录，已取消生成');
  checkpointTask({
    status: 'running',
    progress: 50,
    logs: [...logs, `已确认 ${confirmedRoots.length} 个一级目录，开始生成子目录。`],
    stats: { outline_selection: { items: confirmed.items, selected_ids: confirmed.selectedIds, confirmed: true } },
  });

  // ── 阶段二：基于已确认的一级目录生成完整三级目录 ───────────
  const sectionWords = wordControlOptions.sectionWords > 0 ? wordControlOptions.sectionWords : 3000;
  const childrenMessages = buildBusinessChildrenMessages({ storedPlan, clauseItems, confirmedRoots, relevantKnowledge, sectionWords });
  const fullResponse = await collectJson(aiService, {
    messages: childrenMessages,
    temperature: 0.4,
    logTitle: '商务标子目录生成',
    progressLabel: '商务子目录生成',
    failureMessage: '模型返回的商务标目录格式无效',
    normalizer: (value) => normalizeOutlineResponse(value),
    validator: (value) => {
      if (!Array.isArray(value?.outline) || !value.outline.length) throw new Error('商务标目录缺少 outline');
    },
    progressCallback: (message) => log(message, 80),
  });

  const outline = renumberOutlineItems(fullResponse.outline || []);
  validateBusinessOutline(outline);
  const outlineData = { outline, project_name: fullResponse.projectName || storedPlan.tenderFile?.fileName };
  const outlineWordControlSnapshot = wordControlOptions;

  const state = workspaceStore.updateBusinessBid({
    outlineData,
    outlineWordControlSnapshot,
    contentGenerationSections: {},
    contentGenerationTask: undefined,
    outlineGenerationTask: { task_id: '', type: 'business-outline-generation', status: 'success', progress: 100, logs: [...logs, '商务标目录已生成。'], started_at: now(), updated_at: now() },
  });
  updateTask({ status: 'success', progress: 100, logs: [...logs, '商务标目录已生成。'] }, state);
}

async function runBusinessGlobalFactsTask({ aiService, workspaceStore, knowledgeBaseService, updateTask, payload }) {
  let logs = ['开始生成商务全局事实变量。'];
  let currentProgress = 5;
  function log(message, progress = currentProgress) {
    currentProgress = Math.max(currentProgress, Math.min(progress, 99));
    logs = [...logs, message];
    workspaceStore.updateBusinessBid({ globalFactsTask: { task_id: '', type: 'business-global-facts-generation', status: 'running', progress: currentProgress, logs, started_at: now(), updated_at: now() } });
  }

  const storedPlan = workspaceStore.loadBusinessBid() || {};
  const tenderMarkdown = workspaceStore.readTenderMarkdown();
  if (!String(tenderMarkdown || '').trim()) {
    throw new Error('请先导入招标文件，再生成全局事实');
  }
  const clauseItems = storedPlan.clauseItems || [];
  const outlineData = storedPlan.outlineData;
  if (!outlineData?.outline?.length) {
    throw new Error('请先生成目录，再生成全局事实');
  }

  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(storedPlan);
  const referenceKnowledgeSnippetIds = normalizeReferenceSnippetIds(storedPlan);
  const technicalPlanSummary = storedPlan.referenceTechnicalPlanSummary || '';
  const knowledgeItems = loadKnowledgeItems(knowledgeBaseService, referenceKnowledgeDocumentIds, referenceKnowledgeSnippetIds, normalizeReferenceItemIds(storedPlan), log);
  const relevantKnowledge = selectRelevantItems(BUSINESS_FACTS_QUERY, knowledgeItems, { maxItems: MAX_KNOWLEDGE_ITEMS });
  log(`按事实主题筛选：知识库 ${relevantKnowledge.length}/${knowledgeItems.length} 条用于全局事实设定。`, 12);

  updateTask({ status: 'running', progress: 15, logs });
  const messages = [
    {
      role: 'system',
      content: `你是专业的商务标书事实变量整理助手。请基于招标文件、商务响应矩阵与知识库，整理商务标正文需要保持一致的全局事实变量。

关键定义：
1. 全局事实变量不是招标要求摘录，而是商务标正文中需要统一口径的公司资质、报价口径、付款条件、履约/质保、保函要求、交付与售后承诺等确定性设定。
2. 用户资料已给出明确事实时，优先使用资料中的事实值。
3. 资料只给出要求时，转写为本投标统一采用的承诺口径或执行安排。
4. 只输出简体中文，每条 fact 只写短 bullet，可直接指导正文统一写法。`,
    },
    { role: 'user', content: `招标文件正文：\n${String(tenderMarkdown || '').trim().slice(0, 20000)}` },
    { role: 'user', content: `商务响应矩阵：\n${formatClauseMatrix(clauseItems)}` },
    {
      role: 'user',
      content: technicalPlanSummary.trim()
        ? `已生成技术方案（可选参考上下文，已按事实主题筛选）：\n${selectRelevantParagraphs(BUSINESS_FACTS_QUERY, technicalPlanSummary.trim(), { maxParagraphs: MAX_TECH_PARAGRAPHS })}`
        : '未关联技术方案。',
    },
    { role: 'user', content: `参考知识库条目（按事实主题筛选）：\n${formatKnowledgeItems(relevantKnowledge)}` },
    {
      role: 'user',
      content: `请输出商务全局事实变量，JSON 格式如下：
{
  "groups": [
    {
      "id": "company_qualification",
      "title": "公司资质与业绩",
      "content": "- 公司注册资本：人民币 5000 万元。\\n- 相关同类项目业绩：近三年完成 3 个同类项目。"
    }
  ]
}
要求：至少覆盖公司资质与业绩、报价口径、付款条件、履约与质保、保函要求、交付与售后承诺六类。`,
    },
  ];

  const response = await collectJson(aiService, {
    messages,
    temperature: 0.2,
    logTitle: '商务全局事实变量',
    progressLabel: '商务全局事实设定',
    failureMessage: '模型返回的商务全局事实变量格式无效',
    normalizer: (value) => normalizeGlobalFactGroups(value),
    validator: (value) => {
      if (!Array.isArray(value?.groups) || !value.groups.length) {
        throw new Error('商务全局事实结果缺少 groups');
      }
    },
    progressCallback: (message) => log(message, 60),
  });

  const groups = response.groups || [];
  const state = workspaceStore.updateBusinessBid({
    globalFacts: groups,
    contentGenerationTask: undefined,
    contentGenerationSections: {},
    globalFactsTask: { task_id: '', type: 'business-global-facts-generation', status: 'success', progress: 100, logs: [...logs, `商务全局事实变量生成完成：${groups.length} 个大项。`], started_at: now(), updated_at: now() },
  });
  updateTask({ status: 'success', progress: 100, logs: [...logs, `商务全局事实变量生成完成：${groups.length} 个大项。`] }, state);
}

async function runBusinessContentGenerationTask({ aiService, workspaceStore, knowledgeBaseService, updateTask, payload, taskControl }) {
  let logs = ['开始生成商务标正文。'];
  let currentProgress = 0;
  function log(message, progress = currentProgress) {
    currentProgress = Math.max(currentProgress, Math.min(progress, 99));
    logs = [...logs, message];
    workspaceStore.updateBusinessBid({ contentGenerationTask: { task_id: '', type: 'business-content-generation', status: 'running', progress: currentProgress, logs, started_at: now(), updated_at: now() } });
  }

  const storedPlan = workspaceStore.loadBusinessBid() || {};
  const outlineData = storedPlan.outlineData;
  if (!outlineData?.outline?.length) {
    throw new Error('请先生成目录，再生成正文');
  }
  const globalFacts = storedPlan.globalFacts || [];
  const clauseItems = storedPlan.clauseItems || [];

  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(storedPlan);
  const referenceKnowledgeSnippetIds = normalizeReferenceSnippetIds(storedPlan);
  const technicalPlanSummary = storedPlan.referenceTechnicalPlanSummary || '';
  const knowledgeItems = loadKnowledgeItems(knowledgeBaseService, referenceKnowledgeDocumentIds, referenceKnowledgeSnippetIds, normalizeReferenceItemIds(storedPlan), log);

  const minimumWords = Math.max(300, Number(storedPlan.contentGenerationOptions?.minimumWords) || 600);
  const leaves = collectLeafItems(outlineData.outline);
  if (!leaves.length) {
    throw new Error('目录中没有可生成正文的章节');
  }

  const globalFactsText = formatGlobalFacts(globalFacts);
  const clauseMatrixText = formatClauseMatrix(clauseItems);
  log(`已读取 ${knowledgeItems.length} 条知识库条目，正文将逐章按主题相关性筛选注入。`, 8);

  updateTask({ status: 'running', progress: 2, logs });

  let completed = 0;
  for (const leaf of leaves) {
    if (taskControl?.isPauseRequested && taskControl.isPauseRequested()) {
      const state = workspaceStore.updateBusinessBid({
        contentGenerationTask: { task_id: '', type: 'business-content-generation', status: 'paused', progress: currentProgress, logs: [...logs, '商务正文生成已暂停。'], started_at: now(), updated_at: now() },
      });
      updateTask({ status: 'paused', progress: currentProgress, logs: [...logs, '商务正文生成已暂停。'] }, state);
      return;
    }

    const outlinePath = formatOutlineForPrompt([leaf]).split('\n')[0] || leaf.id;

    // ── 模板填充分支 ──────────────────────────────
    let generated = '';
    let usedTemplate = false;
    if (isTemplateCandidate(leaf.description)) {
      const identified = await identifyTemplate(aiService, leaf.description);
      if (identified.has_template && Array.isArray(identified.variables) && identified.variables.length) {
        const tenderMarkdown = workspaceStore.readTenderMarkdown();
        const filled = await fillVariables(identified.variables, globalFacts, clauseItems, tenderMarkdown, aiService);
        generated = applyTemplate(identified.fixed_content, filled);
        const missing = fillCheck(filled, generated);
        if (missing.length && completed === 0) {
          log(`模板章节"${leaf.title}"有 ${missing.length} 个变量未填充，尝试补全。`, 10);
        }
        for (const m of missing) {
          generated = await aiRepairMissing(aiService, generated, [m], globalFacts);
        }
        usedTemplate = true;
        if (completed === 0) {
          log(`章节"${leaf.title}"使用模板填充。`, 10);
        }
      }
    }

    if (!usedTemplate) {
      const chapterClauseTopics = (clauseItems || [])
        .filter((c) => String(leaf.title).includes(c.category) || `${c.category} ${c.title} ${c.requirement}`.includes(leaf.title))
        .map((c) => `${c.category} ${c.title}`)
        .join(' ');
      const chapterQuery = `${leaf.title} ${leaf.description || ''} ${outlinePath} ${chapterClauseTopics} ${BUSINESS_FACTS_QUERY}`;
      const relevantKnowledge = selectRelevantItems(chapterQuery, knowledgeItems, { maxItems: MAX_KNOWLEDGE_ITEMS });
      const relevantTech = technicalPlanSummary.trim()
        ? selectRelevantParagraphs(chapterQuery, technicalPlanSummary.trim(), { maxParagraphs: MAX_TECH_PARAGRAPHS })
        : '';
      if (completed === 0) {
        log(`正文逐章按相关性筛选知识库（每章上限 ${MAX_KNOWLEDGE_ITEMS} 条）。`, 10);
      }
      const messages = [
        {
          role: 'system',
          content: `你是专业的商务标书正文撰写助手。请基于给定章节的标题、描述与全局事实变量，撰写可直接落标的商务正文。

要求：
1. 只使用简体中文，语气为投标方正式承诺口吻。
2. 内容必须围绕商务与合同维度，不要展开纯技术实施方案。
3. 充分复用全局事实变量中的公司资质、报价口径、付款条件、履约/质保、保函、交付与售后承诺，保证前后一致。
4. 必要时以表格呈现响应项、偏离项或报价口径。
5. 正文不少于 ${minimumWords} 字，结构清晰、可直接写入标书。`,
        },
        { role: 'user', content: `当前章节路径：${outlinePath}\n章节标题：${singleLine(leaf.title)}\n章节描述：${singleLine(leaf.description)}` },
        { role: 'user', content: `商务全局事实变量：\n${globalFactsText}` },
        { role: 'user', content: `商务响应矩阵：\n${clauseMatrixText}` },
        {
          role: 'user',
          content: relevantTech
            ? `已生成技术方案（可选参考上下文，已按本章主题筛选）：\n${relevantTech}`
            : '未关联技术方案。',
        },
        { role: 'user', content: `参考知识库条目（按本章主题筛选）：\n${formatKnowledgeItems(relevantKnowledge)}` },
        { role: 'user', content: `请撰写”${singleLine(leaf.title)}”章节的商务正文（Markdown 格式）。` },
      ];

      const content = await aiService.chat({ messages, temperature: 0.6 });
      const freeGen = String(content || '').trim();
      if (!freeGen) {
        throw new Error(`章节”${leaf.title}”正文生成失败`);
      }
      generated = freeGen;
    }

    const nextOutline = (workspaceStore.loadBusinessBid().outlineData?.outline || []).map((item) => (
      mapOutlineItems([item], (node) => (node.id === leaf.id ? { ...node, content: generated } : { ...node }))[0]
    ));
    const sections = { ...(workspaceStore.loadBusinessBid().contentGenerationSections || {}) };
    sections[leaf.id] = {
      id: leaf.id,
      title: leaf.title,
      status: 'success',
      content: generated,
      updated_at: now(),
    };

    completed += 1;
    const progress = Math.round((completed / leaves.length) * 100);
    const state = workspaceStore.updateBusinessBid({
      outlineData: { ...outlineData, outline: nextOutline },
      contentGenerationSections: sections,
      contentGenerationTask: { task_id: '', type: 'business-content-generation', status: 'running', progress, logs: [...logs, `已完成 ${completed}/${leaves.length} 章：${leaf.title}`], started_at: now(), updated_at: now() },
    });
    updateTask({ status: 'running', progress, logs: [...logs, `已完成 ${completed}/${leaves.length} 章：${leaf.title}`] }, state);
  }

  const finalState = workspaceStore.updateBusinessBid({
    contentGenerationTask: { task_id: '', type: 'business-content-generation', status: 'success', progress: 100, logs: [...logs, '商务标正文已全部生成。'], started_at: now(), updated_at: now() },
  });
  updateTask({ status: 'success', progress: 100, logs: [...logs, '商务标正文已全部生成。'] }, finalState);
}

module.exports = {
  runBusinessClauseAnalysisTask,
  runBusinessClauseRegenerationTask,
  runBusinessOutlineAnalysisTask: runBusinessOutlineGenerationTask,
  runBusinessOutlineGenerationTask,
  runBusinessGlobalFactsTask,
  runBusinessContentGenerationTask,
};
