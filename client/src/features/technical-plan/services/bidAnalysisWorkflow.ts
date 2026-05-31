import { aiClient } from '../../../shared/ai/aiClient';
import { buildInvalidBidAndRejectionItemsPrompt } from '../../../shared/prompts';
import type { ChatMessage } from '../../../shared/types';
import type { BidAnalysisMode } from '../types';

export interface BidAnalysisTaskDefinition {
  id: string;
  label: string;
  description: string;
  required: boolean;
  output: 'markdown' | 'json';
  buildTaskPrompt: () => string;
}

const stableSystemPrompt = `你是专业的招标文件分析助手。请严格基于用户提供的招标文件原文完成提取和总结。

通用要求：
1. 保持信息全面、准确，尽量使用原文内容，不要自行编造。
2. 如果原文没有提及，明确写“没有提及”或“原文未提及”。
3. 只输出最终结果，不输出过程、提示语或客套话。
4. 始终使用简体中文。`;

function buildMessages(fileContent: string, taskPrompt: string): ChatMessage[] {
  return [
    { role: 'system', content: stableSystemPrompt },
    { role: 'user', content: `以下是完整招标文件 Markdown 原文。后续任务必须仅基于这份原文完成：\n\n${fileContent}` },
    { role: 'user', content: taskPrompt },
  ];
}

function jsonTask(title: string, goals: string, outputJson: string) {
  return `任务：${title}

目标：${goals}

约束：
1. 输出格式必须为 JSON。
2. 严格按照以下 JSON 格式输出，只修改 value，禁止修改 key 和结构。
3. 原文中没有的字段填充“没有提及”。

JSON 格式：
${outputJson}

仅输出 JSON，不要输出其他内容。`;
}

export const bidAnalysisTasks: BidAnalysisTaskDefinition[] = [
  {
    id: 'projectOverview',
    label: '项目概述',
    description: '提取项目基本信息、背景目的、规模预算、时间安排、实施内容和技术特点。',
    required: true,
    output: 'markdown',
    buildTaskPrompt: () => `任务：提取并总结项目概述信息。

请重点关注：
1. 项目名称和基本信息
2. 项目背景和目的
3. 项目规模和预算
4. 项目时间安排
5. 项目要实施的具体内容
6. 主要技术特点
7. 其他关键要求

工作要求：
1. 保持信息全面准确，尽量使用原文内容，不要自行编写。
2. 只关注与项目实施有关的内容，不提取商务信息。
3. 直接返回整理好的项目概述，除此之外不返回任何其他内容。`,
  },
  {
    id: 'techRequirements',
    label: '技术评分要求',
    description: '提取技术评分项、权重分值、评分标准和原文位置。',
    required: true,
    output: 'markdown',
    buildTaskPrompt: () => `任务：提取技术评分要求。

目标定位：
1. 重点识别与“技术评分”“评标方法”“评分标准”“技术参数”“技术要求”“技术方案”“技术部分”“评审要素”相关的章节。
2. 不要提取商务、价格、资质等与技术类评分项无关的条目。

每一项按以下结构输出，信息缺失时标注“未提及”：
【评分项名称】：<原文描述，保留专业术语>
【权重/分值】：<具体分值或占比>
【评分标准】：<详细规则>
【数据来源】：<章节、条款、页码或表格位置>

处理规则：
1. 若没有明确“技术评分表”，根据上下文判断技术评分相关内容。
2. 若评分项以表格形式呈现，按行提取，并标注“[表格数据]”。
3. 若存在二级评分项，用缩进或编号体现层级关系。
4. 单位尽量统一为“分”或“%”，必要时注明原文单位。

直接返回提取结果，除此之外不输出任何其他内容。`,
  },
  {
    id: 'projectInfo',
    label: '项目信息',
    description: '项目名称、编号、类型、预算和地址。',
    required: false,
    output: 'json',
    buildTaskPrompt: () => jsonTask('提取项目信息', '提取项目名称、项目编号、项目类型、项目预算、项目地址。', `{
  "project_name": "项目名称",
  "project_number": "项目编号",
  "project_type": "项目类型",
  "project_budget": "项目预算",
  "project_address": "项目地址"
}`),
  },
  {
    id: 'partAInfo',
    label: '甲方信息',
    description: '招标人公司、地址、联系人和电话。',
    required: false,
    output: 'json',
    buildTaskPrompt: () => jsonTask('提取甲方信息', '提取公司名称、地址、联系人、联系电话。', `{
  "company_name": "公司名称",
  "address": "地址",
  "contact_person": "联系人",
  "contact_phone": "联系电话"
}`),
  },
  {
    id: 'agentInfo',
    label: '代理机构信息',
    description: '代理机构联系方式和账户信息。',
    required: false,
    output: 'json',
    buildTaskPrompt: () => jsonTask('提取代理机构信息', '提取代理机构名称、地址、联系人、电话、邮箱和银行账户信息。', `{
  "company_name": "公司名称",
  "address": "地址",
  "contact_person": "联系人",
  "contact_phone": "联系电话",
  "email": "联系邮箱",
  "bank_account_name": "银行账户名称",
  "bank_account_number": "银行账户账号",
  "bank_account_address": "银行账户开户行",
  "bank_account_address_detail": "银行账户开户行地址"
}`),
  },
  {
    id: 'keyInfo',
    label: '投标关键节点',
    description: '公告、获取文件、递交、截止和开标信息。',
    required: false,
    output: 'json',
    buildTaskPrompt: () => jsonTask('提取投标关键节点', '提取招标公告发布日期、招标文件获取方式、售价、获取时间、提交地点、截止时间、开标时间、开标地点和其他注意事项。', `{
  "bid_announcement_time": "招标公告发布日期",
  "bid_file_get_way": "招标文件获取方式",
  "bid_file_price": "招标文件售价",
  "get_bid_file_time": "获取招标文件时间",
  "bid_document_submission_location": "投标文件提交地点",
  "bid_submission_deadline": "投标截止时间",
  "bid_opening_time": "开标时间",
  "bid_opening_address": "开标地点",
  "other_notes": "其他注意事项"
}`),
  },
  {
    id: 'marginInfo',
    label: '投标保证金',
    description: '保证金金额、方式、截止和退还条件。',
    required: false,
    output: 'json',
    buildTaskPrompt: () => jsonTask('提取投标保证金信息', '提取投标保证金、缴纳方式、截止日期、退还条件、不予退还情形和其他注意事项。', `{
  "bidding_deposit": "投标保证金",
  "payment_method": "缴纳方式",
  "due_date": "截止日期",
  "refund_conditions": "退还条件",
  "non_refundable_conditions": "不予退还的情形",
  "other_notes": "其他注意事项"
}`),
  },
  {
    id: 'qualificationReview',
    label: '资格性审查',
    description: '投标人资格条件和资格审查要求。',
    required: false,
    output: 'markdown',
    buildTaskPrompt: () => '任务：提取招标文件中关于投标人资格性审查的信息。整理成方便阅读的 Markdown，不要使用表格；如果原文是表格，请转换为列表。仅输出整理结果。',
  },
  {
    id: 'complianceCheck',
    label: '符合性检查',
    description: '文件完整性、有效性、规范和偏差处理要求。',
    required: false,
    output: 'markdown',
    buildTaskPrompt: () => '任务：总结招标文件中关于符合性检查的信息，一般包括文件完整性、文件有效性、文件规范、偏差处理等。整理成 Markdown，不要使用表格；如果原文是表格，请转换为列表。仅输出整理结果。',
  },
  {
    id: 'openBid',
    label: '开标要求',
    description: '开标时间地点、参与要求、无效标和流程。',
    required: false,
    output: 'json',
    buildTaskPrompt: () => jsonTask('提取开标信息', '提取时间地点、参与要求、无效标认定、异议处理、开标流程。开标流程只涉及开标，不涉及评标和定标。', `{
  "time_place": "时间地点",
  "part_req": "参与要求",
  "invalid_bid": "无效标认定",
  "objection": "异议处理",
  "bid_process": "开标流程"
}`),
  },
  {
    id: 'evaluationBid',
    label: '评标要求',
    description: '评标委员会、评分构成、方法和原则。',
    required: false,
    output: 'json',
    buildTaskPrompt: () => jsonTask('提取评标信息', '提取评标委员会组成、职责、评分构成、评标方法类型、评标原则和方法细节、其他评标相关说明。', `{
  "committee": "评标委员会组成",
  "duties": "评标委员会职责",
  "scoring": "评分构成",
  "method": "评标方法类型",
  "principles": "评标原则和方法细节",
  "others": "其他和评标相关的说明"
}`),
  },
  {
    id: 'businessScoring',
    label: '商务评分要求',
    description: '商务评分因素，为商务方案准备。',
    required: false,
    output: 'markdown',
    buildTaskPrompt: () => '任务：提取招标文件中的商务评分因素，为编写投标文件中的商务方案做准备。保持原文准确性，整理成方便阅读的 Markdown，不要使用表格；如果原文是表格，请转换为列表。仅输出整理结果。',
  },
  {
    id: 'discardedBids',
    label: '无效标与废标项',
    description: '投标无效、废标相关风险项。',
    required: false,
    output: 'markdown',
    buildTaskPrompt: buildInvalidBidAndRejectionItemsPrompt,
  },
  {
    id: 'signingProcess',
    label: '合同授予与签订',
    description: '中标公示、合同签订、履约保证金和合同文本。',
    required: false,
    output: 'json',
    buildTaskPrompt: () => jsonTask('提取合同授予和签订流程', '提取中标公示、合同签订、履约保证金、合同文本等信息。', `{
  "bid_notice": "中标公示",
  "contract_sign": "合同签订",
  "performance_bond": "履约保证金",
  "contract_text": "合同文本"
}`),
  },
  {
    id: 'terminationCondition',
    label: '合同解除和终止',
    description: '违约解除、不可抗力、合同终止和争议解决。',
    required: false,
    output: 'json',
    buildTaskPrompt: () => jsonTask('提取合同解除和终止条件', '提取违约解除、不可抗力、合同终止、争议解决等信息。', `{
  "breach_termination": "违约解除",
  "force_majeure": "不可抗力",
  "contract_termination": "合同终止",
  "dispute_resolution": "争议解决"
}`),
  },
];

export function getBidAnalysisTasks(mode: BidAnalysisMode) {
  return mode === 'key' ? bidAnalysisTasks.filter((task) => task.required) : bidAnalysisTasks;
}

export function getBidAnalysisTaskById(taskId: string) {
  return bidAnalysisTasks.find((task) => task.id === taskId);
}

export function requestBidAnalysisTask(
  fileContent: string,
  task: BidAnalysisTaskDefinition
) {
  return aiClient.chat({
    messages: buildMessages(fileContent, task.buildTaskPrompt()),
    temperature: 0.1,
    response_format: task.output === 'json' ? { type: 'json_object' } : undefined,
  });
}

export function requestInvalidBidAndRejectionItemsTask(fileContent: string) {
  const task = getBidAnalysisTaskById('discardedBids');
  if (!task) {
    throw new Error('未找到无效投标与废标项解析任务');
  }

  return requestBidAnalysisTask(fileContent, task);
}
