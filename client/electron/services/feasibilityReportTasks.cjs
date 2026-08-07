const { splitUserTextByContextLimit } = require('../utils/userTextSplitter.cjs');
const feasibilityReportAgents = {
  humanWriting: {
    name: '正文撰写智能体',
    description: '负责根据项目资料与选定章节格式编制研究报告正文',
  },
};

const analysisFields = [
  ['project_overview', '项目概况'],
  ['background_and_necessity', '建设背景与必要性'],
  ['demand_and_output', '需求分析与产出方案'],
  ['site_and_conditions', '项目选址与要素保障'],
  ['construction_and_technical_conditions', '建设内容与技术条件'],
  ['operation_conditions', '运营条件'],
  ['investment_and_financing', '投资与资金资料'],
  ['impact_and_risks', '影响效果与风险'],
  ['missing_information', '缺失资料清单'],
];

const governmentTemplate = [
  ['概述', ['项目概况', '项目单位概况', '编制依据', '主要结论和建议']],
  ['项目建设背景和必要性', ['项目建设背景', '规划政策符合性', '项目建设必要性']],
  ['项目需求分析与产出方案', ['需求分析', '建设内容和规模', '项目产出方案']],
  ['项目选址与要素保障', ['项目选址', '项目建设条件', '要素保障分析']],
  ['项目建设方案', ['技术方案', '设备方案', '工程方案', '用地征收补偿方案', '数字化方案', '建设管理方案']],
  ['项目运营方案', ['运营模式选择', '运营组织方案', '安全保障方案', '绩效管理方案']],
  ['项目投融资与财务方案', ['投资估算', '融资方案', '财务可持续性分析']],
  ['项目影响效果分析', ['经济影响分析', '社会影响分析', '生态环境影响分析', '资源和能源利用效果分析', '碳达峰碳中和分析']],
  ['项目风险管控方案', ['风险识别与评价', '风险管控方案', '风险应急预案']],
  ['研究结论及建议', ['主要研究结论', '问题与建议']],
];

const enterpriseTemplate = [
  ['概述', ['项目概况', '项目单位概况', '编制依据', '主要结论和建议']],
  ['项目建设背景、需求分析及产出方案', ['项目建设背景', '规划政策符合性', '项目需求分析', '项目产出方案']],
  ['项目选址与要素保障', ['项目选址', '项目建设条件', '要素保障分析']],
  ['项目建设方案', ['技术方案', '设备方案', '工程方案', '数字化方案', '建设管理方案']],
  ['项目运营方案', ['运营模式选择', '运营组织方案', '安全保障方案', '绩效管理方案']],
  ['项目投融资与财务方案', ['投资估算', '盈利能力分析', '融资方案', '债务清偿能力分析', '财务可持续性分析']],
  ['项目影响效果分析', ['经济影响分析', '社会影响分析', '生态环境影响分析', '资源和能源利用效果分析', '碳达峰碳中和分析']],
  ['项目风险管控方案', ['风险识别与评价', '风险管控方案', '风险应急预案']],
  ['研究结论及建议', ['主要研究结论', '问题与建议']],
];

const industrialTemplate = [
  ['概述', ['项目概况', '编制依据与范围', '主要技术经济指标', '结论与建议']],
  ['项目建设背景与必要性', ['国家与行业政策背景', '市场需求与产能缺口', '建设必要性分析']],
  ['产品方案与生产规模', ['产品大纲及质量标准', '生产规模及产能安排', '产品市场竞争力']],
  ['工艺技术与主要设备方案', ['工艺技术路线与原理', '主要生产及检测设备选型', '设备自动化与智能化']],
  ['厂址选择与公用工程', ['厂址选址与建设条件', '总图运输与公用工程', '辅助生产设施']],
  ['节能减排与环境保护', ['能耗分析与节能措施', '三废治理与环保方案', '绿色制造与低碳指标']],
  ['项目实施进度与组织架构', ['组织机构与劳动定员', '人员培训计划', '项目实施进度节点']],
  ['投资估算与资金筹措', ['建设投资与流动资金估算', '资金筹措方案及还本付息']],
  ['财务评价与风险评估', ['营业收入及成本预测', 'NPV/IRR/投资回收期计算', '敏感性分析与风险管控']],
  ['结论及建议', ['综合可行性评估', '存在问题及后续实施建议']],
];

const hiTechTemplate = [
  ['概述', ['项目背景', '编制依据', '技术亮点', '总体结论']],
  ['项目建设背景与必要性', ['数字经济/高新技术政策背景', '行业痛点与技术创新必要性', '经济与社会价值']],
  ['技术路线与系统架构设计', ['总体技术架构', '核心算法/关键技术突破', '模块划分与数据流向']],
  ['数据要素与网络安全方案', ['数据采集与存储方案', '网络安全与等级保护', '数据合规与隐私保护']],
  ['软硬件设备与部署实施', ['软硬件资源配置', '云原生/边缘计算部署', '系统集成与测试']],
  ['运营模式与运维保障', ['业务运营模式', '运维管理与SLA保障', '团队组织与人员培训']],
  ['投资估算与资金筹措', ['研发及软硬件投入估算', '资金筹措与使用计划']],
  ['效益分析与财务评价', ['直接与间接经济效益', '财务可行性指标分析']],
  ['风险管控与结论', ['技术风险与合规风险管控', '研究结论与建议']],
];

const infrastructureTemplate = [
  ['概述', ['项目概况', '规划依据', '建设规模', '研究结论']],
  ['建设背景与规划符合性', ['区域发展规划符合性', '基础设施建设必要性', '交通/公用事业需求']],
  ['建设规模与工程技术方案', ['工程建设规模', '主体工程与路线方案', '配套公用设施方案']],
  ['线路选址与要素保障', ['选址及用地征收方案', '水资源及能源保障', '生态与环境影响评价']],
  ['工程建设与运营保障方案', ['建设工期安排与施工方案', '运营管理模式与安全保障', '应急响应预案']],
  ['投资估算与融资方案', ['工程总投资估算', '政府专项债/PPP/自筹融资方案']],
  ['社会经济与公益效益评价', ['社会影响与民生改善评价', '区域经济拉动效益']],
  ['风险管控与结论', ['工程安全与社会稳定风险评估', '总体研究结论']],
];

const ecoEnvironmentalTemplate = [
  ['概述', ['项目概况', '编制依据', '生态目标', '结论建议']],
  ['背景与生态保护必要性', ['国家生态文明政策', '区域生态环境现状与痛点', '项目建设必要性']],
  ['资源禀赋与工程选址', ['自然地理与资源条件', '工程选址与合规性分析', '用地与水资源保障']],
  ['技术方案与工艺流程', ['生态修复/农业循环技术方案', '主要工艺设备与治理流程', '自动化监控系统']],
  ['生态效益与碳中和评估', ['生态系统服务价值评估', '减碳/固碳量预测与碳达峰']],
  ['项目建设与运营管理', ['工程建设进度安排', '生态监测与长效运营机制']],
  ['投资估算与资金筹措', ['工程建设与生态投资估算', '绿色金融/政府补贴资金']],
  ['财务与可持续性分析', ['直接收益与生态补偿收益', '财务可持续性评估']],
  ['风险防范与结论', ['生态风险与环境敏感区防范', '可行性结论与建议']],
];

const commercialRealestateTemplate = [
  ['概述', ['项目名称与性质', '编制依据', '项目定位', '综合结论']],
  ['项目背景与区域市场分析', ['区域经济与商业环境', '周边竞争格局与供需分析', '项目定位与客群分析']],
  ['建设规模与规划设计方案', ['建筑总体规划与指标', '空间布局与功能分区', '景观与建筑风格']],
  ['选址条件与配套要素保障', ['项目选址与交通条件', '市政配套与要素保障', '土地获取与权属说明']],
  ['开发进度与营销运营方案', ['开发建设周期与节点', '招商与营销推广方案', '物业运营与商业管理']],
  ['投资估算与资金筹措', ['开发建设总投资估算', '资金筹措与动态现金流']],
  ['财务评价与敏感性分析', ['销售/租赁收入预测', 'NPV/IRR/动态回收期分析', '售价及出租率敏感性测试']],
  ['社会效益与风险控制', ['区域商业激活与就业带动', '市场与政策风险防范']],
  ['研究结论与建议', ['总体可行性结论', '项目实施推进建议']],
];

const templatesMap = {
  government: governmentTemplate,
  enterprise: enterpriseTemplate,
  industrial: industrialTemplate,
  hi_tech: hiTechTemplate,
  infrastructure: infrastructureTemplate,
  eco_environmental: ecoEnvironmentalTemplate,
  commercial_realestate: commercialRealestateTemplate,
};

function templateAsPrompt(templateKind) {
  const template = templatesMap[templateKind] || governmentTemplate;
  return template.map(([title, children], index) => `${index + 1}. ${title}\n${children.map((child, childIndex) => `   ${index + 1}.${childIndex + 1} ${child}`).join('\n')}`).join('\n');
}

function now() {
  return new Date().toISOString();
}

function pushLog(logs, message) {
  logs.push(String(message || ''));
  return logs.slice(-100);
}

function stringifyProjectInfo(info = {}) {
  const typeLabel = info.projectType === 'enterprise' ? '企业投资项目' : '政府投资项目';
  return [
    `项目名称：${info.projectName || '【待补充】'}`,
    `项目类型：${typeLabel}`,
    `所属行业：${info.industry || '【待补充】'}`,
    `建设单位：${info.projectUnit || '【待补充】'}`,
    `建设地点：${info.constructionLocation || '【待补充】'}`,
    `建设规模：${info.constructionScale || '【待补充】'}`,
    `建设期：${Number(info.constructionPeriod || 0)} 年`,
    `运营期：${Number(info.operationPeriod || 0)} 年`,
    `总投资：${info.totalInvestment || '【待补充】'}`,
    `资金来源：${info.fundingSource || '【待补充】'}`,
  ].join('\n');
}

function normalizeAnalysis(value) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(analysisFields.map(([key]) => [key, String(source[key] || '').trim()]));
}

function renderAnalysisMarkdown(value) {
  const analysis = normalizeAnalysis(value);
  return analysisFields.map(([key, title]) => {
    const content = analysis[key] || (key === 'missing_information' ? '- 【待补充】尚未识别到明确缺失项，请人工核对资料完整性。' : '【待补充】现有资料未提供足够信息。');
    return `## ${title}\n\n${content}`;
  }).join('\n\n');
}

function buildAnalysisMessages(projectInfo, source, segmentIndex, totalSegments) {
  return [
    {
      role: 'system',
      content: '你是严谨的中国建设项目可行性研究资料分析专家。只能基于项目参数和用户资料提取事实；不得编造金额、规模、地点、期限、政策名称或技术参数。',
    },
    {
      role: 'user',
      content: `项目基础参数：\n${stringifyProjectInfo(projectInfo)}\n\n当前资料分段：${segmentIndex}/${totalSegments}\n\n${source}`,
    },
    {
      role: 'user',
      content: `请把当前资料中可用于编制可行性研究报告的信息整理为 JSON。

要求：
1. project_overview：项目名称、单位、地点、性质、规模、建设内容、工期等。
2. background_and_necessity：背景、问题、规划政策关系和建设必要性。
3. demand_and_output：需求对象、现状缺口、建设规模依据和预期产出。
4. site_and_conditions：选址、用地、交通、市政、资源、审批和建设条件。
5. construction_and_technical_conditions：技术路线、工程、设备、数字化和建设管理资料。
6. operation_conditions：运营模式、组织、安全、绩效和运维资料。
7. investment_and_financing：投资、费用、资金来源、收益、成本和融资资料。
8. impact_and_risks：经济、社会、生态、能源、碳排放和风险资料。
9. missing_information：只列出本段明显缺失、矛盾或需要用户确认的关键资料；不要把当前分段未出现但可能存在于其他分段的内容武断判定为缺失。
10. 每个字段输出 Markdown 文本；没有信息时输出空字符串。只返回 JSON。

JSON 格式：
${JSON.stringify(Object.fromEntries(analysisFields.map(([key]) => [key, 'Markdown 文本'])), null, 2)}`,
    },
  ];
}

function buildAnalysisMergeMessages(projectInfo, parts) {
  return [
    { role: 'system', content: '你是严谨的可行性研究资料合并专家。只能合并用户提供的分析结果，不得创造新事实。' },
    { role: 'user', content: `项目基础参数：\n${stringifyProjectInfo(projectInfo)}\n\n分段分析结果：\n${JSON.stringify(parts, null, 2)}` },
    {
      role: 'user',
      content: `请合并重复信息、保留具体事实并标明资料矛盾。missing_information 只保留综合全部分段后仍然缺失、矛盾或需要确认的关键项。只返回与输入相同字段的 JSON。`,
    },
  ];
}

async function collectJson(aiService, options) {
  if (aiService?.collectJsonResponse) return aiService.collectJsonResponse(options);
  if (aiService?.requestJson) return aiService.requestJson(options);
  throw new Error('AI 服务尚未初始化');
}

async function runFeasibilityAnalysisTask({ aiService, workspaceStore, updateTask }) {
  const state = workspaceStore.loadFeasibilityReport();
  const source = workspaceStore.readCombinedSourceMarkdown().trim();
  if (!state.projectInfo.projectName) throw new Error('请先填写项目名称');
  if (!source) throw new Error('请先上传项目资料');
  const logs = [];
  const config = typeof aiService.getConfig === 'function' ? aiService.getConfig() : {};
  const segments = splitUserTextByContextLimit(source, config);
  const sourceSegments = segments.length ? segments : [source];
  pushLog(logs, `已读取 ${state.sourceFiles.length} 份项目资料，拆分为 ${sourceSegments.length} 段。`);
  updateTask({ status: 'running', progress: 5, logs }, state);

  const results = [];
  for (let index = 0; index < sourceSegments.length; index += 1) {
    const result = await collectJson(aiService, {
      messages: buildAnalysisMessages(state.projectInfo, sourceSegments[index], index + 1, sourceSegments.length),
      response_format: { type: 'json_object' },
      logTitle: `可研资料分析-第${index + 1}段`,
      progressLabel: `可研资料分析第${index + 1}段`,
    });
    results.push(normalizeAnalysis(result));
    pushLog(logs, `已完成项目资料第 ${index + 1}/${sourceSegments.length} 段分析。`);
    updateTask({ status: 'running', progress: Math.min(82, 8 + Math.round(((index + 1) / sourceSegments.length) * 70)), logs }, workspaceStore.loadFeasibilityReport());
  }

  const merged = results.length > 1
    ? normalizeAnalysis(await collectJson(aiService, {
      messages: buildAnalysisMergeMessages(state.projectInfo, results),
      response_format: { type: 'json_object' },
      logTitle: '可研资料分析-结果合并',
      progressLabel: '可研资料分析合并',
    }))
    : results[0];
  const analysisMarkdown = renderAnalysisMarkdown(merged);
  const finalState = workspaceStore.updateFeasibilityReport({
    analysisMarkdown,
    outlineData: null,
    keyParametersMarkdown: '',
    outlineTask: undefined,
    parametersTask: undefined,
    contentTask: undefined,
    humanWritingTask: undefined,
  });
  pushLog(logs, '项目资料分析完成，请核对缺失资料和关键事实。');
  updateTask({ status: 'success', progress: 100, logs }, finalState);
}

function templateAsPrompt(templateKind) {
  const template = templateKind === 'enterprise' ? enterpriseTemplate : governmentTemplate;
  return template.map(([title, children], index) => `${index + 1}. ${title}\n${children.map((child, childIndex) => `   ${index + 1}.${childIndex + 1} ${child}`).join('\n')}`).join('\n');
}

function loadKnowledgeItems(knowledgeBaseService, documentIds) {
  if (!documentIds.length || !knowledgeBaseService?.getOutlineReferences) return [];
  const result = knowledgeBaseService.getOutlineReferences(documentIds);
  return Array.isArray(result?.items) ? result.items.map((item) => ({
    id: String(item?.id || '').trim(),
    title: String(item?.title || '').trim(),
    resume: String(item?.resume || '').trim(),
  })).filter((item) => item.id && item.title) : [];
}

function normalizeOutline(items, allowedKnowledgeIds, level = 1, path = []) {
  if (!Array.isArray(items) || level > 3) return [];
  return items.map((item, index) => {
    const numberPath = [...path, index + 1];
    const id = numberPath.join('.');
    const children = normalizeOutline(item?.children, allowedKnowledgeIds, level + 1, numberPath);
    const knowledgeItemIds = Array.isArray(item?.knowledge_item_ids)
      ? [...new Set(item.knowledge_item_ids.map((value) => String(value || '').trim()).filter((value) => allowedKnowledgeIds.has(value)))]
      : [];
    return {
      id,
      title: String(item?.title || '').replace(/^第?[一二三四五六七八九十百\d.、\s]+[章节篇]?\s*/, '').trim(),
      description: String(item?.description || '').trim(),
      ...(knowledgeItemIds.length ? { knowledge_item_ids: knowledgeItemIds } : {}),
      ...(children.length ? { children } : {}),
    };
  }).filter((item) => item.title);
}

function buildOutlineMessages(state, knowledgeItems) {
  return [
    {
      role: 'system',
      content: '你是可行性研究报告总编。请基于项目实际资料，在通用大纲框架内形成完整、可执行、可编辑的三级以内报告目录。',
    },
    { role: 'user', content: `项目基础参数：\n${stringifyProjectInfo(state.projectInfo)}` },
    { role: 'user', content: `项目资料分析：\n${state.analysisMarkdown}` },
    { role: 'user', content: `选用的通用大纲：\n${templateAsPrompt(state.outlineTemplate)}` },
    {
      role: 'user',
      content: `参考知识库轻量条目：\n${knowledgeItems.length ? JSON.stringify(knowledgeItems, null, 2) : '未选择知识库'}\n\n目标总字数约 ${state.targetWords} 字。`,
    },
    {
      role: 'user',
      content: `生成要求：
1. 一级目录原则上保留通用大纲主框架，可根据项目明显不适用的内容合并或调整，但不得遗漏结论、风险、影响和投资相关内容。
2. 二、三级目录必须结合本项目资料具体化，避免只有空泛通用标题。
3. description 写明本节应论证的重点、已知资料和缺失资料处理要求。
4. 只能在叶子节点填写 knowledge_item_ids，只能从参考知识库 id 中选择，可以为空数组。
5. 不要输出正文 content，不要编造项目事实。
6. 只返回 JSON，不要输出 Markdown 代码块。

JSON 格式：
{
  "outline": [
    {
      "title": "一级目录",
      "description": "本章说明",
      "children": [
        {
          "title": "二级目录",
          "description": "本节写作重点",
          "knowledge_item_ids": ["documentId::itemId"]
        }
      ]
    }
  ]
}`,
    },
  ];
}

async function runFeasibilityOutlineTask({ aiService, workspaceStore, knowledgeBaseService, updateTask, payload }) {
  const state = workspaceStore.loadFeasibilityReport();
  if (!state.analysisMarkdown.trim()) throw new Error('请先完成项目资料分析');
  const referenceKnowledgeDocumentIds = Array.isArray(payload?.referenceKnowledgeDocumentIds)
    ? payload.referenceKnowledgeDocumentIds
    : state.referenceKnowledgeDocumentIds;
  const configState = workspaceStore.updateFeasibilityReport({
    outlineTemplate: payload?.outlineTemplate || state.outlineTemplate,
    targetWords: payload?.targetWords || state.targetWords,
    referenceKnowledgeDocumentIds,
  });
  const logs = [];
  pushLog(logs, '正在读取资料分析和参考知识库。');
  updateTask({ status: 'running', progress: 10, logs }, configState);
  const knowledgeItems = loadKnowledgeItems(knowledgeBaseService, referenceKnowledgeDocumentIds);
  pushLog(logs, knowledgeItems.length ? `已读取 ${knowledgeItems.length} 条知识库轻量条目。` : '本次未使用知识库条目。');
  updateTask({ status: 'running', progress: 22, logs }, workspaceStore.loadFeasibilityReport());
  const raw = await collectJson(aiService, {
    messages: buildOutlineMessages(workspaceStore.loadFeasibilityReport(), knowledgeItems),
    response_format: { type: 'json_object' },
    logTitle: '可研报告目录生成',
    progressLabel: '可研报告目录生成',
  });
  const outline = normalizeOutline(raw?.outline, new Set(knowledgeItems.map((item) => item.id)));
  if (!outline.length) throw new Error('模型未返回有效的可研报告目录');
  const latest = workspaceStore.loadFeasibilityReport();
  const finalState = workspaceStore.updateFeasibilityReport({
    outlineData: {
      project_name: latest.projectInfo.projectName,
      project_overview: latest.analysisMarkdown.slice(0, 2000),
      outline,
    },
    keyParametersMarkdown: '',
    parametersTask: undefined,
    contentTask: undefined,
    humanWritingTask: undefined,
  });
  pushLog(logs, `可研报告目录生成完成，共 ${outline.length} 个一级章节。`);
  updateTask({ status: 'success', progress: 100, logs }, finalState);
}

function renderOutlineForPrompt(items, prefix = '') {
  return (items || []).flatMap((item, index) => {
    const number = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
    return [`${number} ${item.title}${item.description ? `：${item.description}` : ''}`, ...renderOutlineForPrompt(item.children, number)];
  }).join('\n');
}

async function runFeasibilityParametersTask({ aiService, workspaceStore, knowledgeBaseService, updateTask }) {
  const state = workspaceStore.loadFeasibilityReport();
  if (!state.outlineData?.outline?.length) throw new Error('请先生成报告目录');
  const knowledgeItems = loadKnowledgeItems(knowledgeBaseService, state.referenceKnowledgeDocumentIds);
  const logs = ['正在提取可研报告关键参数与统一口径。'];
  updateTask({ status: 'running', progress: 12, logs }, state);
  const content = await aiService.chat({
    messages: [
      { role: 'system', content: '你是可行性研究报告的关键参数审校专家。你必须区分已知事实与缺失信息，严禁自行编造数字、政策、设备参数、地点或资金安排。' },
      { role: 'user', content: `项目基础参数：\n${stringifyProjectInfo(state.projectInfo)}\n\n项目资料分析：\n${state.analysisMarkdown}` },
      { role: 'user', content: `报告目录：\n${renderOutlineForPrompt(state.outlineData.outline)}` },
      { role: 'user', content: `知识库轻量条目：\n${knowledgeItems.length ? JSON.stringify(knowledgeItems, null, 2) : '未选择知识库'}` },
      {
        role: 'user',
        content: `请生成“关键参数与编制口径”Markdown，至少包含：项目身份信息、建设目标与规模、建设地点与条件、建设期与进度、技术路线与主要设备、投资与资金来源、运营期与组织、安全环保能源口径、经济社会效益口径、风险与待确认事项。

规则：
1. 已有明确事实直接写入。
2. 未提供的关键参数统一写“【待补充】”，不要填常见值或经验值。
3. 资料存在冲突时写“【待确认】”并列出冲突内容。
4. 本阶段不自动计算 NPV、IRR、回收期等财务指标。
5. 使用二级标题和简短 bullet，直接输出 Markdown。`,
      },
    ],
    temperature: 0.1,
  });
  const markdown = String(content || '').trim();
  if (!markdown) throw new Error('模型未返回关键参数与编制口径');
  const finalState = workspaceStore.updateFeasibilityReport({
    keyParametersMarkdown: markdown,
    outlineData: {
      ...state.outlineData,
      outline: clearContent(state.outlineData.outline),
    },
    contentTask: undefined,
    humanWritingTask: undefined,
  });
  pushLog(logs, '关键参数与编制口径生成完成，请人工核对待补充项。');
  updateTask({ status: 'success', progress: 100, logs }, finalState);
}

function clearContent(items) {
  return (items || []).map((item) => ({
    ...item,
    content: undefined,
    ...(item.children?.length ? { children: clearContent(item.children) } : {}),
  }));
}

function collectLeafContexts(items, parents = []) {
  const result = [];
  for (const item of items || []) {
    const nextParents = [...parents, item];
    if (item.children?.length) result.push(...collectLeafContexts(item.children, nextParents));
    else result.push({ item, parents });
  }
  return result;
}

function loadKnowledgeContentMap(knowledgeBaseService, documentIds) {
  const map = new Map();
  if (!knowledgeBaseService?.readItems) return map;
  for (const documentId of documentIds || []) {
    const items = knowledgeBaseService.readItems(documentId);
    for (const item of Array.isArray(items) ? items : []) {
      const id = `${documentId}::${String(item?.id || '').trim()}`;
      if (!item?.content) continue;
      map.set(id, { title: String(item.title || ''), resume: String(item.resume || ''), content: String(item.content || '') });
    }
  }
  return map;
}

function scoreKnowledge(item, chapter) {
  const query = `${chapter.title}${chapter.description || ''}`;
  const target = `${item.title}${item.resume}`;
  const chars = [...new Set(query.replace(/[\s，。；：、（）()《》“”]/g, ''))];
  return chars.reduce((score, char) => score + (target.includes(char) ? 1 : 0), 0);
}

function selectKnowledgeContents(chapter, knowledgeMap) {
  const explicitIds = Array.isArray(chapter.knowledge_item_ids) ? chapter.knowledge_item_ids : [];
  const explicit = explicitIds.map((id) => knowledgeMap.get(id)).filter(Boolean);
  const selected = explicit.length
    ? explicit
    : Array.from(knowledgeMap.values()).map((item) => ({ item, score: scoreKnowledge(item, chapter) })).filter((entry) => entry.score > 1).sort((a, b) => b.score - a.score).slice(0, 3).map((entry) => entry.item);
  let used = 0;
  const blocks = [];
  for (const item of selected) {
    const block = `### ${item.title}\n\n${item.content}`.trim();
    if (used + block.length > 24000) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks.join('\n\n');
}

function stripMarkdownFence(value) {
  return String(value || '').trim().replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

async function runFeasibilityContentTask({ aiService, workspaceStore, knowledgeBaseService, updateTask, payload = {} }) {
  let state = workspaceStore.loadFeasibilityReport();
  if (!state.outlineData?.outline?.length) throw new Error('请先生成报告目录');
  if (!state.keyParametersMarkdown.trim()) throw new Error('请先完成关键参数与编制口径');
  const allLeaves = collectLeafContexts(state.outlineData.outline);
  if (!allLeaves.length) throw new Error('报告目录没有可生成的叶子章节');

  const onlyMissing = payload && payload.onlyMissing === true;
  const leaves = onlyMissing
    ? allLeaves.filter(({ item }) => !String(item.content || '').trim())
    : allLeaves;

  if (onlyMissing && leaves.length === 0) {
    const logs = ['所有小节正文已生成完毕，无需补充生成。'];
    updateTask({ status: 'success', progress: 100, logs }, state);
    return;
  }

  const targetPerSection = Math.max(600, Math.round(state.targetWords / allLeaves.length));
  const knowledgeMap = loadKnowledgeContentMap(knowledgeBaseService, state.referenceKnowledgeDocumentIds);
  const logs = [];
  pushLog(logs, `开始${onlyMissing ? '补充生成未完成的' : '生成'} ${leaves.length} 个正文小节（全篇共 ${allLeaves.length} 小节），单节参考目标约 ${targetPerSection} 字。`);
  updateTask({ status: 'running', progress: 3, logs }, state);

  for (let index = 0; index < leaves.length; index += 1) {
    const { item, parents } = leaves[index];
    const knowledge = selectKnowledgeContents(item, knowledgeMap);
    const chapterPath = [...parents.map((parent) => parent.title), item.title].join(' > ');
    pushLog(logs, `正在生成 ${index + 1}/${leaves.length}：${chapterPath}`);
    updateTask({ status: 'running', progress: Math.max(4, Math.round((index / leaves.length) * 94)), logs }, workspaceStore.loadFeasibilityReport());
    const response = await aiService.chat({
      messages: [
        {
          role: 'system',
          content: `你是专业的可行性研究报告编制专家。正文必须基于用户提供的项目事实和资料，论证清晰、语言正式。不得编造金额、规模、地点、期限、批复、政策名称、设备参数或财务指标。`,
        },
        { role: 'user', content: `项目基础参数：\n${stringifyProjectInfo(state.projectInfo)}` },
        { role: 'user', content: `项目资料分析：\n${state.analysisMarkdown}` },
        { role: 'user', content: `全文关键参数与编制口径：\n${state.keyParametersMarkdown}` },
        {
          role: 'user',
          content: `当前章节路径：${chapterPath}\n章节写作重点：${item.description || '围绕章节标题展开充分论证。'}\n参考目标字数：约 ${targetPerSection} 字。`,
        },
        ...(knowledge ? [{ role: 'user', content: `可吸收的知识库素材如下。请改写到本项目语境，不要提及“知识库”“历史文档”或资料来源：\n\n${knowledge}` }] : []),
        {
          role: 'user',
          content: `写作规则：
1. 只生成当前叶子章节正文，不重复输出章节标题。
2. 对已有资料进行分析、论证和结构化表达；可以使用 Markdown 小标题、列表和必要表格。
3. 没有依据的关键数据明确写“【待补充】”或采用不含虚构数字的定性表达。
4. 不把需求、建议或通用规范写成已经完成的事实。
5. 与全文关键参数保持一致。
6. 若当前章节涉及项目选址与建设条件、总图布置、工艺流程、环保设施或实施进度等工程技术/选址章节，请在最佳位置嵌入且仅嵌入 1 处插图指引框，格式固定为：
> 📸 **【插图指引】：图片名称**
> *说明：此处请插入...*
7. 直接输出 Markdown 正文。`,
        },
      ],
      temperature: 0.2,
    });
    const content = stripMarkdownFence(response);
    if (!content) throw new Error(`“${item.title}”未生成有效正文`);
    state = workspaceStore.saveChapterContent({ nodeId: item.id, content });
  }

  pushLog(logs, `可行性研究报告正文生成完成，共完成 ${leaves.length} 个小节。`);
  updateTask({ status: 'success', progress: 100, logs }, state);
}

const protectedQuantityPattern = /(?:\d+(?:\.\d+)?(?:\s*(?:-|～|~|至)\s*\d+(?:\.\d+)?)?\s*(?:亿元|万元|元|%|％|年|个月|月|日|天|小时|平方米|平方公里|亩|公里|米|千米|吨|千瓦时|千瓦|兆瓦|人|户|家|项|套|台|个|座|栋|层|次))/g;

function collectProtectedWritingTokens(content) {
  const source = String(content || '');
  const quantities = source.match(protectedQuantityPattern) || [];
  const markers = source.match(/【(?:待补充|待确认)】/g) || [];
  return [...new Set([...quantities, ...markers].map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

function findMissingProtectedTokens(original, revised) {
  const normalizedRevised = String(revised || '').replace(/\s+/g, ' ');
  return collectProtectedWritingTokens(original).filter((token) => !normalizedRevised.includes(token));
}

async function runFeasibilityHumanWritingTask({ aiService, workspaceStore, updateTask }) {
  let state = workspaceStore.loadFeasibilityReport();
  if (!state.outlineData?.outline?.length) throw new Error('请先生成可研报告正文');
  const leaves = collectLeafContexts(state.outlineData.outline).filter(({ item }) => String(item.content || '').trim());
  if (!leaves.length) throw new Error('当前没有可审校的可研报告正文');

  const agent = feasibilityReportAgents.humanWriting;
  const logs = [`${agent.name} 已启动，共 ${leaves.length} 个正文小节。`];
  let revisedCount = 0;
  let protectedCount = 0;
  updateTask({ status: 'running', progress: 2, logs }, state);

  for (let index = 0; index < leaves.length; index += 1) {
    const { item, parents } = leaves[index];
    const original = String(item.content || '').trim();
    const chapterPath = [...parents.map((parent) => parent.title), item.title].join(' > ');
    pushLog(logs, `正在审校 ${index + 1}/${leaves.length}：${chapterPath}`);
    updateTask({ status: 'running', progress: Math.max(3, Math.round((index / leaves.length) * 94)), logs }, workspaceStore.loadFeasibilityReport());

    const response = await aiService.chat({
      messages: [
        { role: 'system', content: agent.systemPrompt },
        { role: 'user', content: `项目基础参数：\n${stringifyProjectInfo(state.projectInfo)}` },
        { role: 'user', content: `全文关键参数与编制口径：\n${state.keyParametersMarkdown}` },
        {
          role: 'user',
          content: `当前章节路径：${chapterPath}\n\n请只审校下面的已有正文。不得输出章节标题，不得补写资料中不存在的事实。\n\n${original}`,
        },
      ],
      temperature: 0.15,
    });
    const revised = stripMarkdownFence(response);
    const missingTokens = findMissingProtectedTokens(original, revised);
    if (!revised || missingTokens.length) {
      protectedCount += 1;
      pushLog(logs, !revised
        ? `“${item.title}”未返回有效正文，已保留原稿。`
        : `“${item.title}”触及受保护参数（${missingTokens.slice(0, 3).join('、')}），已保留原稿。`);
      continue;
    }
    state = workspaceStore.saveChapterContent({ nodeId: item.id, content: revised });
    revisedCount += 1;
  }

  pushLog(logs, `${agent.name} 完成：更新 ${revisedCount} 节，因事实保护保留原稿 ${protectedCount} 节。`);
  updateTask({ status: 'success', progress: 100, logs }, state);
}

function runFeasibilityValidationCheck(state) {
  const projectInfo = state?.projectInfo || {};
  const missingParameters = [];

  const requiredFields = [
    { field: 'projectName', label: '项目名称', suggestion: '请填写准确的项目立项名称' },
    { field: 'projectUnit', label: '建设单位', suggestion: '请填写项目申报或建设单位全称' },
    { field: 'industry', label: '所属行业', suggestion: '请指定项目所属国民经济行业或领域' },
    { field: 'constructionLocation', label: '建设地点', suggestion: '请指明具体建设省市区或园区地点' },
    { field: 'constructionScale', label: '建设规模', suggestion: '请明确具体的建设规模与产能/面积指标' },
    { field: 'totalInvestment', label: '总投资金额', suggestion: '请指定估算总投资额（如 5000万元）' },
    { field: 'fundingSource', label: '资金来源', suggestion: '请说明自有资金、银行贷款或政府补助比例' },
  ];

  for (const item of requiredFields) {
    const val = String(projectInfo[item.field] || '').trim();
    if (!val || val.includes('【待补充】') || val.toUpperCase().includes('TBD')) {
      missingParameters.push(item);
    }
  }

  const missingMaterials = [];
  const analysisText = String(state?.analysisMarkdown || '');
  const missingSectionMatch = analysisText.match(/##\s*缺失资料清单\s*([\s\S]*?)(?=##|$)/);
  if (missingSectionMatch && missingSectionMatch[1]) {
    const lines = missingSectionMatch[1].split('\n');
    for (const line of lines) {
      const trimmed = line.replace(/^[\s*\-•\d.+]+/, '').trim();
      if (trimmed && !trimmed.includes('尚未识别到明确缺失项') && !trimmed.includes('【待补充】')) {
        missingMaterials.push(trimmed);
      }
    }
  }

  const uncertainParameters = [];
  const combinedText = `${JSON.stringify(projectInfo)}\n${state?.keyParametersMarkdown || ''}`;
  const uncertainKeywords = [
    { pattern: /(?:暂定|待定|拟定|初步估算|预计|尚需核实)[^,，;；\n]{2,30}/g, risk: 'high', rec: '建议与项目单位或工程规划核实确定' },
    { pattern: /(?:预估|约|左右|大致|区间在)[^,，;；\n]{2,20}/g, risk: 'medium', rec: '建议在编制说明或测算章节说明浮动区间' },
  ];

  let idCounter = 1;
  for (const rule of uncertainKeywords) {
    let match;
    while ((match = rule.pattern.exec(combinedText)) !== null) {
      const expr = match[0].trim();
      if (!uncertainParameters.some((u) => u.expression === expr)) {
        uncertainParameters.push({
          id: `unc-${idCounter++}`,
          source: '基础参数与测算口径',
          parameterName: expr.slice(0, 10),
          expression: expr,
          riskLevel: rule.risk,
          recommendation: rule.rec,
        });
      }
      if (uncertainParameters.length >= 10) break;
    }
  }

  let score = 100;
  score -= missingParameters.length * 8;
  score -= missingMaterials.length * 6;
  score -= uncertainParameters.filter((u) => u.riskLevel === 'high').length * 5;
  score -= uncertainParameters.filter((u) => u.riskLevel === 'medium').length * 2;
  score = Math.max(10, Math.min(100, score));

  return {
    score,
    missingParameters,
    missingMaterials,
    uncertainParameters,
  };
}

function runFeasibilityConsistencyCheck(state) {
  const outlineData = state?.outlineData;
  if (!outlineData || !Array.isArray(outlineData.outline)) {
    return { totalCheckedNodes: 0, issueCount: 0, issues: [] };
  }

  function collectLeafNodes(items) {
    return (items || []).flatMap((item) => (item.children?.length ? collectLeafNodes(item.children) : [item]));
  }

  const leafNodes = collectLeafNodes(outlineData.outline).filter((node) => String(node.content || '').trim());
  const issues = [];
  const projectInfo = state?.projectInfo || {};

  const masterInvestmentRaw = String(projectInfo.totalInvestment || '').trim();
  const masterAmountMatch = masterInvestmentRaw.match(/([\d.]+)\s*(万|亿元|万元|亿)?/);
  let masterNumber = null;
  let masterUnit = '万元';
  if (masterAmountMatch) {
    masterNumber = parseFloat(masterAmountMatch[1]);
    masterUnit = masterAmountMatch[2] || '万元';
  }

  let issueId = 1;
  for (const node of leafNodes) {
    const content = String(node.content || '');

    if (masterNumber !== null && (node.title.includes('投资') || node.title.includes('费用') || node.title.includes('估算') || content.includes('总投资'))) {
      const amountRegex = /(?:总投资|估算投资|投资额|总金额)[^\d.]{0,10}([\d.]+)\s*(万元|亿元|万|亿)/g;
      let match;
      while ((match = amountRegex.exec(content)) !== null) {
        const foundNum = parseFloat(match[1]);
        const foundUnit = match[2];
        let normalizedFoundInWan = foundNum;
        if (foundUnit === '亿元' || foundUnit === '亿') normalizedFoundInWan = foundNum * 10000;
        let normalizedMasterInWan = masterNumber;
        if (masterUnit === '亿元' || masterUnit === '亿') normalizedMasterInWan = masterNumber * 10000;

        if (Math.abs(normalizedFoundInWan - normalizedMasterInWan) > 0.01) {
          issues.push({
            id: `iss-${issueId++}`,
            nodeId: node.id,
            nodeTitle: node.title,
            category: 'investment',
            masterValue: masterInvestmentRaw || `${masterNumber}${masterUnit}`,
            foundValue: match[0],
            excerpt: content.slice(Math.max(0, match.index - 20), Math.min(content.length, match.index + match[0].length + 20)),
            recommendation: `建议统一为基础参数中的总投资额“${masterInvestmentRaw}”`,
          });
        }
      }
    }

    if (projectInfo.constructionPeriod && (node.title.includes('工期') || node.title.includes('进度') || node.title.includes('建设期'))) {
      const periodRegex = /(?:建设期|工期|施工期)[^\d]{0,8}(\d+)\s*(年|个月|月)/g;
      let pMatch;
      while ((pMatch = periodRegex.exec(content)) !== null) {
        const foundVal = parseInt(pMatch[1], 10);
        const unit = pMatch[2];
        const masterYears = Number(projectInfo.constructionPeriod);
        let foundYears = foundVal;
        if (unit.includes('月')) foundYears = foundVal / 12;

        if (Math.abs(foundYears - masterYears) > 0.1) {
          issues.push({
            id: `iss-${issueId++}`,
            nodeId: node.id,
            nodeTitle: node.title,
            category: 'period',
            masterValue: `建设期 ${masterYears} 年`,
            foundValue: pMatch[0],
            excerpt: content.slice(Math.max(0, pMatch.index - 20), Math.min(content.length, pMatch.index + pMatch[0].length + 20)),
            recommendation: `建议统一为基础参数中的建设工期“${masterYears} 年”`,
          });
        }
      }
    }
  }

  return {
    totalCheckedNodes: leafNodes.length,
    issueCount: issues.length,
    issues,
  };
}

module.exports = {
  runFeasibilityAnalysisTask,
  runFeasibilityOutlineTask,
  runFeasibilityParametersTask,
  runFeasibilityContentTask,
  runFeasibilityHumanWritingTask,
  runFeasibilityValidationCheck,
  runFeasibilityConsistencyCheck,
};

