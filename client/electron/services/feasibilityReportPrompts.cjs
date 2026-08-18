const OUTLINE_TEMPLATES = {
  government: {
    label: '政府投资项目通用大纲（2023版标准）',
    chapters: [
      '概述',
      '项目建设背景和必要性',
      '项目需求分析与产出方案',
      '项目选址与要素保障',
      '项目建设方案',
      '项目运营方案',
      '项目投融资与财务方案',
      '项目影响效果分析',
      '项目风险管控方案',
      '研究结论及建议',
    ],
    suggestedChildren: [
      ['项目概况', '项目单位概况', '编制依据', '主要结论和建议'],
      ['项目建设背景', '规划政策符合性', '项目建设必要性'],
      ['需求分析', '建设内容和规模', '项目产出方案'],
      ['项目选址', '项目建设条件', '要素保障分析'],
      ['技术方案', '设备方案', '工程方案', '用地征收补偿方案', '数字化方案', '建设管理方案'],
      ['运营模式选择', '运营组织方案', '安全保障方案', '绩效管理方案'],
      ['投资估算', '融资方案', '财务可持续性分析'],
      ['经济影响分析', '社会影响分析', '生态环境影响分析', '资源和能源利用效果分析', '碳达峰碳中和分析'],
      ['风险识别与评价', '风险管控方案', '风险应急预案'],
      ['主要研究结论', '问题与建议'],
    ],
  },
  enterprise: {
    label: '企业投资项目参考大纲（2023版标准）',
    chapters: [
      '概述',
      '项目建设背景、需求分析及产出方案',
      '项目选址与要素保障',
      '项目建设方案',
      '项目运营方案',
      '项目投融资与财务方案',
      '项目影响效果分析',
      '项目风险管控方案',
      '研究结论及建议',
    ],
    suggestedChildren: [
      ['项目概况', '项目单位概况', '编制依据', '主要结论和建议'],
      ['项目建设背景', '规划政策符合性', '项目需求分析', '项目产出方案'],
      ['项目选址', '项目建设条件', '要素保障分析'],
      ['技术方案', '设备方案', '工程方案', '数字化方案', '建设管理方案'],
      ['运营模式选择', '运营组织方案', '安全保障方案', '绩效管理方案'],
      ['投资估算', '盈利能力分析', '融资方案', '债务清偿能力分析', '财务可持续性分析'],
      ['经济影响分析', '社会影响分析', '生态环境影响分析', '资源和能源利用效果分析', '碳达峰碳中和分析'],
      ['风险识别与评价', '风险管控方案', '风险应急预案'],
      ['主要研究结论', '问题与建议'],
    ],
  },
  industrial: {
    label: '工业与高端制造可行性研究大纲',
    chapters: [
      '概述',
      '项目建设背景与必要性',
      '产品方案与生产规模',
      '工艺技术与主要设备方案',
      '厂址选择与公用工程',
      '节能减排与环境保护',
      '项目实施进度与组织架构',
      '投资估算与资金筹措',
      '财务评价与风险评估',
      '结论及建议',
    ],
    suggestedChildren: [
      ['项目概况', '编制依据与范围', '主要技术经济指标', '结论与建议'],
      ['国家与行业政策背景', '市场需求与产能缺口', '建设必要性分析'],
      ['产品大纲及质量标准', '生产规模及产能安排', '产品市场竞争力'],
      ['工艺技术路线与原理', '主要生产及检测设备选型', '设备自动化与智能化'],
      ['厂址选址与建设条件', '总图运输与公用工程', '辅助生产设施'],
      ['能耗分析与节能措施', '三废治理与环保方案', '绿色制造与低碳指标'],
      ['组织机构与劳动定员', '人员培训计划', '项目实施进度节点'],
      ['建设投资与流动资金估算', '资金筹措方案及还本付息'],
      ['营业收入及成本预测', 'NPV/IRR/投资回收期计算', '敏感性分析与风险管控'],
      ['综合可行性评估', '存在问题及后续实施建议'],
    ],
  },
  hi_tech: {
    label: '高新技术与数字化/信息化大纲',
    chapters: [
      '概述',
      '项目建设背景与必要性',
      '技术路线与系统架构设计',
      '数据要素与网络安全方案',
      '软硬件设备与部署实施',
      '运营模式与运维保障',
      '投资估算与资金筹措',
      '效益分析与财务评价',
      '风险管控与结论',
    ],
    suggestedChildren: [
      ['项目背景', '编制依据', '技术亮点', '总体结论'],
      ['数字经济/高新技术政策背景', '行业痛点与技术创新必要性', '经济与社会价值'],
      ['总体技术架构', '核心算法/关键技术突破', '模块划分与数据流向'],
      ['数据采集与存储方案', '网络安全与等级保护', '数据合规与隐私保护'],
      ['软硬件资源配置', '云原生/边缘计算部署', '系统集成与测试'],
      ['业务运营模式', '运维管理与SLA保障', '团队组织与人员培训'],
      ['研发及软硬件投入估算', '资金筹措与使用计划'],
      ['直接与间接经济效益', '财务可行性指标分析'],
      ['技术风险与合规风险管控', '研究结论与建议'],
    ],
  },
  infrastructure: {
    label: '基础设施与公用事业大纲',
    chapters: [
      '概述',
      '建设背景与规划符合性',
      '建设规模与工程技术方案',
      '线路选址与要素保障',
      '工程建设与运营保障方案',
      '投资估算与融资方案',
      '社会经济与公益效益评价',
      '风险管控与结论',
    ],
    suggestedChildren: [
      ['项目概况', '规划依据', '建设规模', '研究结论'],
      ['区域发展规划符合性', '基础设施建设必要性', '交通/公用事业需求'],
      ['工程建设规模', '主体工程与路线方案', '配套公用设施方案'],
      ['选址及用地征收方案', '水资源及能源保障', '生态与环境影响评价'],
      ['建设工期安排与施工方案', '运营管理模式与安全保障', '应急响应预案'],
      ['工程总投资估算', '政府专项债/PPP/自筹融资方案'],
      ['社会影响与民生改善评价', '区域经济拉动效益'],
      ['工程安全与社会稳定风险评估', '总体研究结论'],
    ],
  },
  eco_environmental: {
    label: '农业与生态环保项目大纲',
    chapters: [
      '概述',
      '背景与生态保护必要性',
      '资源禀赋与工程选址',
      '技术方案与工艺流程',
      '生态效益与碳中和评估',
      '项目建设与运营管理',
      '投资估算与资金筹措',
      '财务与可持续性分析',
      '风险防范与结论',
    ],
    suggestedChildren: [
      ['项目概况', '编制依据', '生态目标', '结论建议'],
      ['国家生态文明政策', '区域生态环境现状与痛点', '项目建设必要性'],
      ['自然地理与资源条件', '工程选址与合规性分析', '用地与水资源保障'],
      ['生态修复/农业循环技术方案', '主要工艺设备与治理流程', '自动化监控系统'],
      ['生态系统服务价值评估', '减碳/固碳量预测与碳达峰'],
      ['工程建设进度安排', '生态监测与长效运营机制'],
      ['工程建设与生态投资估算', '绿色金融/政府补贴资金'],
      ['直接收益与生态补偿收益', '财务可持续性评估'],
      ['生态风险与环境敏感区防范', '可行性结论与建议'],
    ],
  },
  commercial_realestate: {
    label: '商业/园区与地产开发大纲',
    chapters: [
      '概述',
      '项目背景与区域市场分析',
      '建设规模与规划设计方案',
      '选址条件与配套要素保障',
      '开发进度与营销运营方案',
      '投资估算与资金筹措',
      '财务评价与敏感性分析',
      '社会效益与风险控制',
      '研究结论与建议',
    ],
    suggestedChildren: [
      ['项目名称与性质', '编制依据', '项目定位', '综合结论'],
      ['区域经济与商业环境', '周边竞争格局与供需分析', '项目定位与客群分析'],
      ['建筑总体规划与指标', '空间布局与功能分区', '景观与建筑风格'],
      ['项目选址与交通条件', '市政配套与要素保障', '土地获取与权属说明'],
      ['开发建设周期与节点', '招商与营销推广方案', '物业运营与商业管理'],
      ['开发建设总投资估算', '资金筹措与动态现金流'],
      ['销售/租赁收入预测', 'NPV/IRR/动态回收期分析', '售价及出租率敏感性测试'],
      ['区域商业激活与就业带动', '市场与政策风险防范'],
      ['总体可行性结论', '项目实施推进建议'],
    ],
  },
};

const ANALYSIS_FIELDS = [
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

function formatProjectInfo(info = {}) {
  const typeLabel = info.projectType === 'enterprise' ? '企业投资项目' : '政府投资项目';
  return [
    `项目名称：${info.projectName || '【待补充】'}`,
    `项目类型：${typeLabel}`,
    `所属行业：${info.industry || '【待补充】'}`,
    `建设单位：${info.constructionUnit || '【待补充】'}`,
    `建设地点：${info.location || '【待补充】'}`,
    `建设内容与规模：${info.constructionContent || '【待补充】'}`,
    `建设期：${info.constructionPeriodYears || '【待补充】'} 年`,
    `运营期：${info.operationPeriodYears || '【待补充】'} 年`,
    `总投资：${info.totalInvestment || '【待补充】'}`,
    `资金来源：${info.fundingSource || '【待补充】'}`,
  ].join('\n');
}

function formatOutlineTemplateTree(templateId) {
  const template = OUTLINE_TEMPLATES[templateId] || OUTLINE_TEMPLATES.government;
  return template.chapters.map((title, index) => {
    const children = template.suggestedChildren?.[index] || [];
    return `${index + 1}. ${title}\n${children.map((child, childIndex) => `  ${index + 1}.${childIndex + 1} ${child}`).join('\n')}`;
  }).join('\n');
}

function getOutlineTemplatePrompt(templateId) {
  const template = OUTLINE_TEMPLATES[templateId] || OUTLINE_TEMPLATES.government;
  return `选用的通用大纲：${template.label}\n${formatOutlineTemplateTree(templateId)}`;
}

function buildOutlineTemplateMarkdown(templateId, targetWords) {
  const template = OUTLINE_TEMPLATES[templateId] || OUTLINE_TEMPLATES.government;
  return [
    `# 选用的通用大纲：${template.label}`,
    '',
    `目标总字数约 ${Number(targetWords) || 30000} 字。`,
    '',
    '一级目录原则上保留本大纲主框架，可根据项目明显不适用的内容合并或调整，但不得遗漏结论、风险、影响和投资相关内容。',
    '二、三级目录必须结合本项目资料具体化；下列二级标题是大纲组成部分，应作为细化起点写入目录，而不是可忽略的参考清单。',
    '',
    formatOutlineTemplateTree(templateId),
  ].join('\n');
}

function buildAnalysisSystemPrompt() {
  return [
    '你是严谨的中国建设项目可行性研究资料分析专家。只能基于项目参数和用户资料提取事实；不得编造金额、规模、地点、期限、政策名称或技术参数。',
    '无资料文件时只使用项目参数（含建设内容与规模）；此时资料块可能为“未导入资料文件”。',
  ].join('');
}

function buildAnalysisUserInstruction(segmentIndex, totalSegments) {
  return `请把当前资料中可用于编制可行性研究报告的信息整理为 JSON。

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

当前资料分段：${segmentIndex}/${totalSegments}

JSON 格式：
${JSON.stringify(Object.fromEntries(ANALYSIS_FIELDS.map(([key]) => [key, 'Markdown 文本'])), null, 2)}`;
}

function buildAnalysisMergeSystemPrompt() {
  return '你是严谨的可行性研究资料合并专家。只能合并用户提供的分析结果，不得创造新事实。';
}

function buildAnalysisMergeUserInstruction() {
  return '请合并重复信息、保留具体事实并标明资料矛盾。missing_information 只保留综合全部分段后仍然缺失、矛盾或需要确认的关键项。只返回与输入相同字段的 JSON。';
}

function analysisToMarkdown(payload = {}) {
  return ANALYSIS_FIELDS.map(([key, title]) => {
    const raw = String(payload[key] || '').trim();
    const body = raw || (key === 'missing_information'
      ? '- 【待补充】尚未识别到明确缺失项，请人工核对资料完整性。'
      : '【待补充】现有资料未提供足够信息。');
    return `## ${title}\n\n${body}`;
  }).join('\n\n');
}

function buildOutlineSystemPrompt() {
  return '你是可行性研究报告总编。请基于项目实际资料，在通用大纲框架内形成完整、可执行、可编辑的三级以内报告目录。';
}

function buildParametersSystemPrompt() {
  return '你是可行性研究报告的关键参数审校专家。你必须区分已知事实与缺失信息，严禁自行编造数字、政策、设备参数、地点或资金安排。';
}

function buildParametersUserInstruction() {
  return `请生成“关键参数与编制口径”Markdown，至少包含：项目身份信息、建设目标与规模、建设地点与条件、建设期与进度、技术路线与主要设备、投资与资金来源、运营期与组织、安全环保能源口径、经济社会效益口径、风险与待确认事项。

规则：
1. 已有明确事实直接写入。
2. 未提供的关键参数统一写“【待补充】”，不要填常见值或经验值。
3. 资料存在冲突时写“【待确认】”并列出冲突内容。
4. 本阶段不自动计算 NPV、IRR、回收期等财务指标。
5. 使用二级标题和简短 bullet，直接输出 Markdown。`;
}

function buildContentSystemPrompt() {
  return '你是专业的可行性研究报告编制专家。正文必须基于用户提供的项目事实和资料，论证清晰、语言正式。不得编造金额、规模、地点、期限、批复、政策名称、设备参数或财务指标。';
}

function buildContentWritingRules() {
  return `写作规则：
1. 只生成当前叶子章节正文，不重复输出章节标题。
2. 对已有资料进行分析、论证和结构化表达；可以使用 Markdown 小标题、列表和必要表格。
3. 没有依据的关键数据明确写“【待补充】”或采用不含虚构数字的定性表达。
4. 不把需求、建议或通用规范写成已经完成的事实。
5. 与全文关键参数保持一致。
6. 若当前章节涉及项目选址与建设条件、总图布置、工艺流程、环保设施或实施进度等工程技术/选址章节，请在最佳位置嵌入且仅嵌入 1 处插图指引框，格式固定为：
> 📸 **【插图指引】：图片名称**
> *说明：此处请插入...*
7. 直接输出 Markdown 正文。`;
}

function buildHumanWritingSystemPrompt() {
  return [
    '你是中文公文与工程咨询报告润色编辑。请对给定章节做自然化审校，使行文更像人工撰写。',
    '保护事实和参数，压缩重复表达，改善中文词序，清理模板腔与模型腔，同时保持正式可研文风。',
    '必须完整保留所有数量、单位、金额、日期、比例，以及【待补充】【待确认】标记。',
    '不得新增事实、不得删改结论口径、不得计算财务指标。',
    '不得输出章节标题，不得补写资料中不存在的事实。只输出修订后的 Markdown 正文，不要解释。',
  ].join('');
}

function renderOutlineForPrompt(items, prefix = '') {
  return (items || []).flatMap((item, index) => {
    const number = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
    return [`${number} ${item.title}${item.description ? `：${item.description}` : ''}`, ...renderOutlineForPrompt(item.children, number)];
  }).join('\n');
}

module.exports = {
  OUTLINE_TEMPLATES,
  ANALYSIS_FIELDS,
  formatProjectInfo,
  formatOutlineTemplateTree,
  getOutlineTemplatePrompt,
  buildOutlineTemplateMarkdown,
  buildAnalysisSystemPrompt,
  buildAnalysisUserInstruction,
  buildAnalysisMergeSystemPrompt,
  buildAnalysisMergeUserInstruction,
  analysisToMarkdown,
  buildOutlineSystemPrompt,
  buildParametersSystemPrompt,
  buildParametersUserInstruction,
  buildContentSystemPrompt,
  buildContentWritingRules,
  buildHumanWritingSystemPrompt,
  renderOutlineForPrompt,
};
