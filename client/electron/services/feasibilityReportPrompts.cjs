const OUTLINE_TEMPLATES = {
  government: {
    label: '政府投资项目',
    chapters: [
      '概述',
      '项目建设背景与必要性',
      '需求分析与产出方案',
      '项目选址与要素保障',
      '项目建设方案',
      '项目运营方案',
      '投资估算与资金筹措',
      '影响效果分析',
      '资源节约与生态环境保护',
      '项目风险管控',
      '研究结论及建议',
    ],
    suggestedChildren: [
      ['项目概况', '项目单位概况', '编制依据', '主要结论和建议'],
      ['项目建设背景', '规划政策符合性', '项目建设必要性'],
      ['需求分析', '建设内容和规模', '项目产出方案'],
      ['项目选址', '项目建设条件', '要素保障分析'],
      ['技术方案', '设备方案', '工程方案', '用地征收补偿方案', '数字化方案', '建设管理方案'],
      ['运营模式选择', '运营组织方案', '安全保障方案', '绩效管理方案'],
      ['投资估算', '融资方案', '资金使用计划'],
      ['经济影响分析', '社会影响分析'],
      ['生态环境影响分析', '资源和能源利用效果分析', '碳达峰碳中和分析'],
      ['风险识别与评价', '风险管控方案', '风险应急预案'],
      ['主要研究结论', '问题与建议'],
    ],
  },
  enterprise: {
    label: '企业投资项目',
    chapters: [
      '概述',
      '市场与需求分析',
      '建设方案与技术方案',
      '组织与实施计划',
      '投资估算与融资方案',
      '财务与经济影响分析',
      '资源环境与社会影响',
      '风险分析与对策',
      '研究结论及建议',
    ],
    suggestedChildren: [
      ['项目概况', '项目单位概况', '编制依据', '主要结论和建议'],
      ['项目建设背景', '规划政策符合性', '项目需求分析', '项目产出方案'],
      ['技术方案', '设备方案', '工程方案', '数字化方案', '建设管理方案'],
      ['组织机构与劳动定员', '实施进度', '人员培训计划'],
      ['投资估算', '融资方案'],
      ['盈利能力分析口径', '财务可持续性分析口径'],
      ['经济影响分析', '社会影响分析', '生态环境影响分析'],
      ['风险识别与评价', '风险管控方案', '风险应急预案'],
      ['主要研究结论', '问题与建议'],
    ],
  },
  industrial: {
    label: '工业制造项目',
    chapters: [
      '概述',
      '市场与产品方案',
      '厂址与建设条件',
      '工艺技术方案',
      '总图运输与公用工程',
      '节能环保与职业健康',
      '组织机构与人力资源',
      '实施进度与招标方案',
      '投资估算与资金筹措',
      '财务与风险分析',
      '研究结论及建议',
    ],
    suggestedChildren: [
      ['项目概况', '编制依据与范围', '主要技术经济指标', '结论与建议'],
      ['产品大纲及质量标准', '生产规模及产能安排', '产品市场竞争力'],
      ['厂址选址与建设条件', '总图运输与公用工程'],
      ['工艺技术路线与原理', '主要生产及检测设备选型', '设备自动化与智能化'],
      ['辅助生产设施', '给排水与动力工程'],
      ['能耗分析与节能措施', '三废治理与环保方案', '职业健康与劳动安全'],
      ['组织机构与劳动定员', '人员培训计划'],
      ['项目实施进度节点', '招标方案'],
      ['建设投资与流动资金估算', '资金筹措方案'],
      ['财务评价口径', '敏感性分析与风险管控'],
      ['综合可行性评估', '存在问题及后续实施建议'],
    ],
  },
  hi_tech: {
    label: '高新技术项目',
    chapters: [
      '概述',
      '技术来源与创新性',
      '产品与市场分析',
      '研发与产业化方案',
      '建设内容与实施计划',
      '知识产权与人才保障',
      '投资估算与融资安排',
      '效益与风险分析',
      '研究结论及建议',
    ],
    suggestedChildren: [
      ['项目背景', '编制依据', '技术亮点', '总体结论'],
      ['总体技术架构', '核心算法或关键技术突破', '模块划分与数据流向'],
      ['行业痛点与需求', '产品方案与竞争力'],
      ['研发组织与产业化路径', '软硬件资源配置', '系统集成与测试'],
      ['实施进度', '部署与运维保障'],
      ['知识产权安排', '团队组织与人员培训'],
      ['研发及软硬件投入估算', '资金筹措与使用计划'],
      ['直接与间接经济效益口径', '技术风险与合规风险管控'],
      ['研究结论', '问题与建议'],
    ],
  },
  infrastructure: {
    label: '基础设施项目',
    chapters: [
      '概述',
      '建设必要性与需求预测',
      '建设规模与技术标准',
      '场址与线路方案',
      '工程方案与实施方案',
      '运营管理与维护',
      '投资估算与资金筹措',
      '经济与社会影响',
      '资源环境评价',
      '风险管控',
      '研究结论及建议',
    ],
    suggestedChildren: [
      ['项目概况', '规划依据', '建设规模', '研究结论'],
      ['区域发展规划符合性', '基础设施建设必要性', '需求预测'],
      ['工程建设规模', '技术标准'],
      ['选址及用地征收方案', '路线或场址比选'],
      ['主体工程方案', '配套公用设施方案', '建设工期安排与施工方案'],
      ['运营管理模式', '维护与安全保障', '应急响应预案'],
      ['工程总投资估算', '融资方案'],
      ['社会影响与民生改善评价', '区域经济拉动效益'],
      ['生态与环境影响评价', '水资源及能源保障'],
      ['工程安全与社会稳定风险评估', '风险管控方案'],
      ['总体研究结论', '问题与建议'],
    ],
  },
  eco_environmental: {
    label: '生态环境项目',
    chapters: [
      '概述',
      '环境问题与建设必要性',
      '治理目标与建设内容',
      '技术方案与工艺路线',
      '实施计划与保障措施',
      '投资估算与资金筹措',
      '环境效益与社会影响',
      '风险分析',
      '研究结论及建议',
    ],
    suggestedChildren: [
      ['项目概况', '编制依据', '生态目标', '结论建议'],
      ['国家生态文明政策', '区域生态环境现状与痛点', '项目建设必要性'],
      ['治理目标', '建设内容与规模'],
      ['生态修复或治理技术方案', '主要工艺设备与治理流程', '自动化监控系统'],
      ['工程建设进度安排', '生态监测与长效运营机制'],
      ['工程建设与生态投资估算', '资金筹措方案'],
      ['生态系统服务价值评估', '减碳固碳口径', '社会影响'],
      ['生态风险与环境敏感区防范'],
      ['可行性结论', '问题与建议'],
    ],
  },
  commercial_realestate: {
    label: '商业地产项目',
    chapters: [
      '概述',
      '区域市场与定位分析',
      '规划设计与建设方案',
      '运营模式与招商计划',
      '投资估算与资金筹措',
      '财务与敏感性分析口径',
      '社会影响与风险对策',
      '研究结论及建议',
    ],
    suggestedChildren: [
      ['项目名称与性质', '编制依据', '项目定位', '综合结论'],
      ['区域经济与商业环境', '周边竞争格局与供需分析', '项目定位与客群分析'],
      ['建筑总体规划与指标', '空间布局与功能分区', '景观与建筑风格'],
      ['开发建设周期与节点', '招商与营销推广方案', '物业运营与商业管理'],
      ['开发建设总投资估算', '资金筹措方案'],
      ['销售或租赁收入预测口径', '财务评价口径', '敏感性分析口径'],
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
  return [
    `项目名称：${info.projectName || '【待补充】'}`,
    `项目类型：${info.projectType === 'enterprise' ? '企业投资' : '政府投资'}`,
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

function getOutlineTemplatePrompt(templateId) {
  const template = OUTLINE_TEMPLATES[templateId] || OUTLINE_TEMPLATES.government;
  return `大纲模板：${template.label}\n必须覆盖以下一级章节，可在其下细化到三级目录：\n${template.chapters.map((title, index) => `${index + 1}. ${title}`).join('\n')}`;
}

function buildOutlineTemplateMarkdown(templateId, targetWords) {
  const template = OUTLINE_TEMPLATES[templateId] || OUTLINE_TEMPLATES.government;
  const required = template.chapters.map((title, index) => `${index + 1}. ${title}`).join('\n');
  const suggested = (template.suggestedChildren || []).map((children, index) => {
    const title = template.chapters[index] || `第${index + 1}章`;
    return `### ${index + 1}. ${title}\n${children.map((child) => `- ${child}`).join('\n')}`;
  }).join('\n\n');
  return [
    `# 大纲模板：${template.label}`,
    '',
    `目标总字数约 ${Number(targetWords) || 30000} 字。`,
    '',
    '## 必须覆盖的一级章节',
    '',
    required,
    '',
    '## 建议细化的二级目录',
    '',
    '以下二级标题仅供参考，可按本项目资料合并、拆分或改写，不要当成必须逐条保留的硬编码目录。',
    '',
    suggested,
  ].join('\n');
}

function buildAnalysisSystemPrompt() {
  return [
    '你是严谨的中国建设项目可行性研究资料分析专家。',
    '只能基于项目参数和用户资料提取事实，不得编造金额、规模、工期、财务指标或政策结论。',
    '无资料文件时只使用项目参数（含建设内容与规模）；资料不足时在对应字段写明“资料未提供”，并在 missing_information 中列出缺失项。',
    '输出 JSON 对象，字段必须且仅能为：project_overview、background_and_necessity、demand_and_output、site_and_conditions、construction_and_technical_conditions、operation_conditions、investment_and_financing、impact_and_risks、missing_information。',
    '每个字段为中文 Markdown 段落，不要套一层 JSON 字符串。',
  ].join('');
}

function buildAnalysisMergeSystemPrompt() {
  return '你只能合并多段资料分析结果，消除重复，保留全部已出现事实，不得创造新事实。输出同样字段的 JSON 对象。';
}

function analysisToMarkdown(payload = {}) {
  return ANALYSIS_FIELDS.map(([key, title]) => {
    const body = String(payload[key] || '').trim() || '资料未提供。';
    return `## ${title}\n\n${body}`;
  }).join('\n\n');
}

function buildOutlineSystemPrompt() {
  return [
    '你是可行性研究报告总编。请在给定大纲框架内形成完整、可执行、可编辑的三级以内报告目录。',
    '必须保留结论、风险、影响、投资相关章节。叶子节点不要写 content。',
    '不得编造具体金额、财务指标或尚未出现的项目事实。',
    '输出 JSON：{"outline":[{"title":"","description":"写作重点","children":[{"title":"","description":"","children":[{"title":"","description":""}]}]}]}',
  ].join('');
}

function buildParametersSystemPrompt() {
  return [
    '你是可行性研究报告关键参数审校专家。',
    '根据项目参数、资料分析和目录，整理“关键参数与编制口径”Markdown。',
    '已知事实直接写；未知写【待补充】；资料冲突写【待确认】。',
    '严禁自行编造，不要计算 NPV、IRR、投资回收期等财务指标。',
  ].join('');
}

function buildContentSystemPrompt() {
  return [
    '你是专业的可行性研究报告编制专家。只写当前指定章节正文，使用 Markdown。',
    '不得编造金额、规模、工期或财务指标；未知处使用【待补充】或【待确认】。',
    '对选址、总平面、工艺流程、环境保护、实施进度类章节，可在合适位置插入插图指引，格式严格如下：',
    '> 📸 **【插图指引】：图片名称**',
    '> *说明：此处请插入……建议横版 16:9。*',
    '不要输出本章标题，不要写其他章节。',
  ].join('\n');
}

function buildHumanWritingSystemPrompt() {
  return [
    '你是中文公文与工程咨询报告润色编辑。请对给定章节做自然化审校，使行文更像人工撰写。',
    '必须完整保留所有数量、单位、金额、日期、比例，以及【待补充】【待确认】标记。',
    '不得新增事实、不得删改结论口径、不得计算财务指标。',
    '只输出修订后的 Markdown 正文，不要解释。',
  ].join('');
}

module.exports = {
  OUTLINE_TEMPLATES,
  ANALYSIS_FIELDS,
  formatProjectInfo,
  getOutlineTemplatePrompt,
  buildOutlineTemplateMarkdown,
  buildAnalysisSystemPrompt,
  buildAnalysisMergeSystemPrompt,
  analysisToMarkdown,
  buildOutlineSystemPrompt,
  buildParametersSystemPrompt,
  buildContentSystemPrompt,
  buildHumanWritingSystemPrompt,
};
