// 商务标专用 Prompt 构造器。
// 商务标对标技术方案工作流，但业务语义不同：聚焦商务响应、报价口径、合同偏离与资信材料。

export interface BusinessBidKnowledgeItem {
  id: string;
  title: string;
  resume?: string;
  content: string;
}

export interface BusinessBidClauseItem {
  id: string;
  category: string;
  title: string;
  requirement: string;
  response_status: '已响应' | '待确认' | '需复核' | '不满足';
  response_detail: string;
  deviation: string;
}

export interface BusinessBidOutlineItem {
  id: string;
  title: string;
  description?: string;
  children?: BusinessBidOutlineItem[];
}

function singleLine(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function formatBusinessBidKnowledgeItems(items: BusinessBidKnowledgeItem[]): string {
  if (!items.length) return '未选择参考知识库。';
  return items
    .map((item, index) => `<knowledge_item index="${index + 1}" id="${singleLine(item.id)}">
标题：${singleLine(item.title)}
简介：${singleLine(item.resume)}
正文：
${singleLine(item.content)}
</knowledge_item>`)
    .join('\n\n');
}

export function formatBusinessBidClauseMatrix(clauses: BusinessBidClauseItem[]): string {
  if (!clauses.length) return '尚未生成商务响应矩阵。';
  return clauses
    .map((clause) => `## ${singleLine(clause.category)} / ${singleLine(clause.title)}
- 招标要求：${singleLine(clause.requirement)}
- 响应状态：${singleLine(clause.response_status)}
- 响应内容：${singleLine(clause.response_detail)}
- 偏离说明：${singleLine(clause.deviation)}`)
    .join('\n\n');
}

export interface BusinessBidClauseAnalysisContext {
  tenderMarkdown: string;
  knowledgeItems: BusinessBidKnowledgeItem[];
  technicalPlanSummary?: string;
}

export function buildBusinessClauseAnalysisMessages(context: BusinessBidClauseAnalysisContext) {
  const knowledgeBlock = formatBusinessBidKnowledgeItems(context.knowledgeItems);
  const technicalPlanBlock = context.technicalPlanSummary?.trim()
    ? `已生成技术方案（作为可选参考上下文）：
${context.technicalPlanSummary.trim()}`
    : '未关联技术方案，本次仅基于招标文件与知识库。';

  return [
    {
      role: 'system',
      content: `你是专业的商务标书编制助手，擅长从招标文件中抽取商务条款并形成可复核的响应矩阵。

输出要求：
1. 只使用简体中文。
2. 聚焦商务维度：付款条件、履约保证金、质保/运维、报价有效期、合同条款偏离、资信与业绩要求、交付与供货周期、违约责任等。
3. 技术参数、施工/实施细节等纯技术内容不要纳入商务响应矩阵。
4. 对每条商务条款给出明确的响应状态：已响应 / 待确认 / 需复核 / 不满足，并写出可落到标书中的响应内容与偏离说明。
5. 只返回 JSON，不要输出分析过程。`,
    },
    {
      role: 'user',
      content: `招标文件正文：
${context.tenderMarkdown.trim() || '未提供招标文件内容。'}`,
    },
    {
      role: 'user',
      content: technicalPlanBlock,
    },
    {
      role: 'user',
      content: `参考知识库条目：
${knowledgeBlock}`,
    },
    {
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
要求：clauses 至少覆盖付款、履约/质保、报价有效期、合同偏离、资信业绩、交付周期等核心商务主题；响应状态必须如实判断；响应内容应当具体、可用于标书。`,
    },
  ];
}

export interface BusinessBidOutlineContext {
  tenderMarkdown: string;
  clauseMatrixText: string;
  knowledgeItems: BusinessBidKnowledgeItem[];
  technicalPlanSummary?: string;
  projectName?: string;
}

export function buildBusinessOutlineMessages(context: BusinessBidOutlineContext) {
  const knowledgeBlock = formatBusinessBidKnowledgeItems(context.knowledgeItems);
  const technicalPlanBlock = context.technicalPlanSummary?.trim()
    ? `已生成技术方案（可选参考上下文，商务标可引用其中已确认的事实设定）：
${context.technicalPlanSummary.trim()}`
    : '未关联技术方案。';

  return [
    {
      role: 'system',
      content: `你是专业的商务标书目录设计助手。请基于商务响应矩阵与招标文件，设计一份层级清晰、可直接用于标书编写的商务标目录。

要求：
1. 只使用简体中文。
2. 目录应为三级结构：章（1.）→ 节（1.1）→ 点（1.1.1）。
3. 必须覆盖：投标函与法定代表人身份证明、商务响应表、报价说明与报价汇总、合同条款偏离表、资格审查与资信业绩材料、供货/交付与售后服务承诺、付款与履约保障等。
4. 不要照搬技术实施方案的细节，聚焦商务与合同维度。
5. 只返回 JSON。`,
    },
    {
      role: 'user',
      content: `项目/标段名称：${singleLine(context.projectName) || '未提供'}`,
    },
    {
      role: 'user',
      content: `商务响应矩阵：
${context.clauseMatrixText}`,
    },
    {
      role: 'user',
      content: `招标文件正文：
${context.tenderMarkdown.trim().slice(0, 20000) || '未提供招标文件内容。'}`,
    },
    {
      role: 'user',
      content: technicalPlanBlock,
    },
    {
      role: 'user',
      content: `参考知识库条目：
${knowledgeBlock}`,
    },
    {
      role: 'user',
      content: `请输出商务标目录，JSON 格式如下：
{
  "project_name": "项目/标段名称",
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
要求：outline 至少 6 个一级章，且每个一级章至少 2 个二级节，形成完整商务标结构。`,
    },
  ];
}

export interface BusinessBidGlobalFactsContext {
  tenderMarkdown: string;
  clauseMatrixText: string;
  knowledgeItems: BusinessBidKnowledgeItem[];
  technicalPlanSummary?: string;
}

export function buildBusinessGlobalFactsMessages(context: BusinessBidGlobalFactsContext) {
  const knowledgeBlock = formatBusinessBidKnowledgeItems(context.knowledgeItems);
  const technicalPlanBlock = context.technicalPlanSummary?.trim()
    ? `已生成技术方案（可选参考上下文）：
${context.technicalPlanSummary.trim()}`
    : '未关联技术方案。';

  return [
    {
      role: 'system',
      content: `你是专业的商务标书事实变量整理助手。请基于招标文件、商务响应矩阵与知识库，整理商务标正文需要保持一致的全局事实变量。

关键定义：
1. 全局事实变量不是招标要求摘录，而是商务标正文中需要统一口径的公司资质、报价口径、付款条件、履约/质保、保函要求、交付与售后承诺等确定性设定。
2. 用户资料已给出明确事实时，优先使用资料中的事实值。
3. 资料只给出要求时，转写为本投标统一采用的承诺口径或执行安排。
4. 只输出简体中文，每条 fact 只写短 bullet，可直接指导正文统一写法。`,
    },
    {
      role: 'user',
      content: `招标文件正文：
${context.tenderMarkdown.trim().slice(0, 20000) || '未提供招标文件内容。'}`,
    },
    {
      role: 'user',
      content: `商务响应矩阵：
${context.clauseMatrixText}`,
    },
    {
      role: 'user',
      content: technicalPlanBlock,
    },
    {
      role: 'user',
      content: `参考知识库条目：
${knowledgeBlock}`,
    },
    {
      role: 'user',
      content: `请输出商务全局事实变量，JSON 格式如下：
{
  "groups": [
    {
      "id": "company_qualification",
      "title": "公司资质与业绩",
      "content": "- 公司注册资本：人民币 5000 万元。\n- 相关同类项目业绩：近三年完成 3 个同类项目。"
    }
  ]
}
要求：至少覆盖公司资质与业绩、报价口径、付款条件、履约与质保、保函要求、交付与售后承诺六类。`,
    },
  ];
}

export interface BusinessBidContentContext {
  outlineItem: BusinessBidOutlineItem;
  outlinePath: string;
  globalFactsText: string;
  clauseMatrixText: string;
  knowledgeItems: BusinessBidKnowledgeItem[];
  technicalPlanSummary?: string;
  minimumWords: number;
}

export function buildBusinessContentMessages(context: BusinessBidContentContext) {
  const knowledgeBlock = formatBusinessBidKnowledgeItems(context.knowledgeItems);
  const technicalPlanBlock = context.technicalPlanSummary?.trim()
    ? `已生成技术方案（可选参考上下文）：
${context.technicalPlanSummary.trim()}`
    : '未关联技术方案。';

  return [
    {
      role: 'system',
      content: `你是专业的商务标书正文撰写助手。请基于给定章节的标题、描述与全局事实变量，撰写可直接落标的商务正文。

要求：
1. 只使用简体中文，语气为投标方正式承诺口吻。
2. 内容必须围绕商务与合同维度，不要展开纯技术实施方案。
3. 充分复用全局事实变量中的公司资质、报价口径、付款条件、履约/质保、保函、交付与售后承诺，保证前后一致。
4. 必要时以表格呈现响应项、偏离项或报价口径。
5. 正文不少于 ${context.minimumWords} 字，结构清晰、可直接写入标书。`,
    },
    {
      role: 'user',
      content: `当前章节路径：${context.outlinePath}
章节标题：${singleLine(context.outlineItem.title)}
章节描述：${singleLine(context.outlineItem.description)}`,
    },
    {
      role: 'user',
      content: `商务全局事实变量：
${context.globalFactsText}`,
    },
    {
      role: 'user',
      content: `商务响应矩阵：
${context.clauseMatrixText}`,
    },
    {
      role: 'user',
      content: technicalPlanBlock,
    },
    {
      role: 'user',
      content: `参考知识库条目：
${knowledgeBlock}`,
    },
    {
      role: 'user',
      content: `请撰写“${singleLine(context.outlineItem.title)}”章节的商务正文（Markdown 格式）。`,
    },
  ];
}
