const stableSystemPrompt = `你是专业的招标文件分析助手。请严格基于用户提供的招标文件原文完成提取和总结。

通用要求：
1. 保持信息全面、准确，尽量使用原文内容，不要自行编造。
2. 如果原文没有提及，明确写“没有提及”或“原文未提及”。
3. 只输出最终结果，不输出过程、提示语或客套话。
4. 始终使用简体中文。`;

function jsonTask(title, goals, outputJson) {
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

function buildInvalidBidAndRejectionItemsPrompt() {
  return `任务：提取并分析招标文件中的“无效投标”和“废标项”。

概念边界：
1. “无效投标”指投标人、投标文件、签章密封、递交时间、报价、保证金、资格条件、实质性响应等原因导致投标被认定为无效、否决、不予受理或按无效响应处理的情形。
2. “废标项”指可能导致项目废标、采购失败、重新招标、终止评审、有效投标人不足或实质性响应不足的条款或风险项。
3. 原文使用“否决投标”“投标无效”“不予受理”“无效响应”“重大偏差”“实质性偏离”“废标情形”等同义表达时，也要按上述边界归类。

输出要求：
1. 必须明确区分“无效投标”和“废标项”。
2. “原文中明确提到的”只能提取招标文件原文中明确出现或同义表达的内容，尽量保留原文关键句；如果没有提及，写“- 原文未提及”。
3. “此类标书还可能涉及的”只补充原文未明确提及、但结合本招标文件类型和招投标经验判断非常重要的高风险遗漏项。
4. 不要罗列所有常见可能项，不要输出泛泛的通用清单；每个小节最多输出 3-5 条。
5. 如果没有明显需要补充的关键项，写“- 暂未发现必须补充的高风险项”。
6. 经验补充项每条前缀使用“重点补充：”，并用一句话说明为什么需要关注。
7. 不要使用表格，使用 Markdown 列表。
8. 仅输出下方格式，不要输出解释、过程或额外段落。
9. 不要输出三重引号、代码块标记或其他格式包裹符。

输出格式：
# 原文中明确提到的

## 无效投标
- ...

## 废标项
- ...

# 此类标书还可能涉及的

## 无效投标
- 重点补充：...

## 废标项
- 重点补充：...`;
}

const tasks = [
  {
    id: 'projectOverview', label: '项目概述', required: true, output: 'markdown', description: '提取项目基本信息、背景目的、规模预算、时间安排、实施内容和技术特点。',
    prompt: () => `任务：提取并总结项目概述信息。

请重点关注项目名称、基本信息、背景目的、规模预算、时间安排、实施内容、技术特点和其他关键要求。

工作要求：保持信息全面准确，尽量使用原文内容；只关注与项目实施有关的内容，不提取商务信息；直接返回整理好的项目概述。`,
  },
  {
    id: 'techRequirements', label: '技术评分要求', required: true, output: 'markdown', description: '提取技术评分项、权重分值、评分标准和原文位置。',
    prompt: () => `任务：提取技术评分要求。

重点识别“技术评分”“评标方法”“评分标准”“技术参数”“技术要求”“技术方案”“技术部分”“评审要素”相关章节，不要提取商务、价格、资质等无关条目。

每一项按以下结构输出：
【评分项名称】：<原文描述，保留专业术语>
【权重/分值】：<具体分值或占比>
【评分标准】：<详细规则>
【数据来源】：<章节、条款、页码或表格位置>

若没有明确技术评分表，请根据上下文判断技术评分相关内容。直接返回提取结果。`,
  },
  { id: 'projectInfo', label: '项目信息', required: false, output: 'json', description: '项目名称、编号、类型、预算和地址。', prompt: () => jsonTask('提取项目信息', '提取项目名称、项目编号、项目类型、项目预算、项目地址。', `{"project_name":"项目名称","project_number":"项目编号","project_type":"项目类型","project_budget":"项目预算","project_address":"项目地址"}`) },
  { id: 'partAInfo', label: '甲方信息', required: false, output: 'json', description: '招标人公司、地址、联系人和电话。', prompt: () => jsonTask('提取甲方信息', '提取公司名称、地址、联系人、联系电话。', `{"company_name":"公司名称","address":"地址","contact_person":"联系人","contact_phone":"联系电话"}`) },
  { id: 'agentInfo', label: '代理机构信息', required: false, output: 'json', description: '代理机构联系方式和账户信息。', prompt: () => jsonTask('提取代理机构信息', '提取代理机构名称、地址、联系人、电话、邮箱和银行账户信息。', `{"company_name":"公司名称","address":"地址","contact_person":"联系人","contact_phone":"联系电话","email":"联系邮箱","bank_account_name":"银行账户名称","bank_account_number":"银行账户账号","bank_account_address":"银行账户开户行","bank_account_address_detail":"银行账户开户行地址"}`) },
  { id: 'keyInfo', label: '投标关键节点', required: false, output: 'json', description: '公告、获取文件、递交、截止和开标信息。', prompt: () => jsonTask('提取投标关键节点', '提取招标公告发布日期、招标文件获取方式、售价、获取时间、提交地点、截止时间、开标时间、开标地点和其他注意事项。', `{"bid_announcement_time":"招标公告发布日期","bid_file_get_way":"招标文件获取方式","bid_file_price":"招标文件售价","get_bid_file_time":"获取招标文件时间","bid_document_submission_location":"投标文件提交地点","bid_submission_deadline":"投标截止时间","bid_opening_time":"开标时间","bid_opening_address":"开标地点","other_notes":"其他注意事项"}`) },
  { id: 'marginInfo', label: '投标保证金', required: false, output: 'json', description: '保证金金额、方式、截止和退还条件。', prompt: () => jsonTask('提取投标保证金信息', '提取投标保证金、缴纳方式、截止日期、退还条件、不予退还情形和其他注意事项。', `{"bidding_deposit":"投标保证金","payment_method":"缴纳方式","due_date":"截止日期","refund_conditions":"退还条件","non_refundable_conditions":"不予退还的情形","other_notes":"其他注意事项"}`) },
  { id: 'qualificationReview', label: '资格性审查', required: false, output: 'markdown', description: '投标人资格条件和资格审查要求。', prompt: () => '任务：提取招标文件中关于投标人资格性审查的信息。整理成方便阅读的 Markdown，不要使用表格；如果原文是表格，请转换为列表。仅输出整理结果。' },
  { id: 'complianceCheck', label: '符合性检查', required: false, output: 'markdown', description: '文件完整性、有效性、规范和偏差处理要求。', prompt: () => '任务：总结招标文件中关于符合性检查的信息，包括文件完整性、文件有效性、文件规范、偏差处理等。整理成 Markdown，不要使用表格。仅输出整理结果。' },
  { id: 'openBid', label: '开标要求', required: false, output: 'json', description: '开标时间地点、参与要求、无效标和流程。', prompt: () => jsonTask('提取开标信息', '提取时间地点、参与要求、无效标认定、异议处理、开标流程。', `{"time_place":"时间地点","part_req":"参与要求","invalid_bid":"无效标认定","objection":"异议处理","bid_process":"开标流程"}`) },
  { id: 'evaluationBid', label: '评标要求', required: false, output: 'json', description: '评标委员会、评分构成、方法和原则。', prompt: () => jsonTask('提取评标信息', '提取评标委员会组成、职责、评分构成、评标方法类型、评标原则和方法细节、其他评标相关说明。', `{"committee":"评标委员会组成","duties":"评标委员会职责","scoring":"评分构成","method":"评标方法类型","principles":"评标原则和方法细节","others":"其他和评标相关的说明"}`) },
  { id: 'businessScoring', label: '商务评分要求', required: false, output: 'markdown', description: '商务评分因素，为商务方案准备。', prompt: () => '任务：提取招标文件中的商务评分因素，为编写投标文件中的商务方案做准备。整理成 Markdown，不要使用表格。仅输出整理结果。' },
  { id: 'discardedBids', label: '无效标与废标项', required: false, output: 'markdown', description: '投标无效、废标相关风险项。', prompt: buildInvalidBidAndRejectionItemsPrompt },
  { id: 'signingProcess', label: '合同授予与签订', required: false, output: 'json', description: '中标公示、合同签订、履约保证金和合同文本。', prompt: () => jsonTask('提取合同授予和签订流程', '提取中标公示、合同签订、履约保证金、合同文本等信息。', `{"bid_notice":"中标公示","contract_sign":"合同签订","performance_bond":"履约保证金","contract_text":"合同文本"}`) },
  { id: 'terminationCondition', label: '合同解除和终止', required: false, output: 'json', description: '违约解除、不可抗力、合同终止和争议解决。', prompt: () => jsonTask('提取合同解除和终止条件', '提取违约解除、不可抗力、合同终止、争议解决等信息。', `{"breach_termination":"违约解除","force_majeure":"不可抗力","contract_termination":"合同终止","dispute_resolution":"争议解决"}`) },
];

function getBidAnalysisTasks(mode) {
  return mode === 'key' ? tasks.filter((task) => task.required) : tasks;
}

function getBidAnalysisTaskById(taskId) {
  return tasks.find((task) => task.id === taskId);
}

function buildMessages(fileContent, task) {
  return [
    { role: 'system', content: stableSystemPrompt },
    { role: 'user', content: `以下是完整招标文件 Markdown 原文。后续任务必须仅基于这份原文完成：\n\n${fileContent}` },
    { role: 'user', content: task.prompt() },
  ];
}

async function runSingleBidAnalysisPromptTask({ aiService, fileContent, task, onChunk }) {
  let content = '';
  await aiService.streamChat({ messages: buildMessages(fileContent, task), temperature: 0.1, response_format: task.output === 'json' ? { type: 'json_object' } : undefined }, (event) => {
    if (event.type === 'chunk' && event.chunk) {
      content += event.chunk;
      if (typeof onChunk === 'function') {
        onChunk(content, event.chunk, event);
      }
    }
  });

  return content;
}

function runInvalidBidAndRejectionItemsExtraction({ aiService, fileContent, onChunk }) {
  const task = getBidAnalysisTaskById('discardedBids');
  if (!task) {
    throw new Error('未找到无效投标与废标项解析任务');
  }

  return runSingleBidAnalysisPromptTask({ aiService, fileContent, task, onChunk });
}

async function runBidAnalysisTask({ aiService, workspaceStore, updateTask, payload }) {
  const mode = payload.mode || 'key';
  const selectedTasks = getBidAnalysisTasks(mode);
  const realTimeRender = payload.real_time_render !== false && payload.realTimeRender !== false;
  const initialLogs = realTimeRender
    ? ['开始解析招标文件。']
    : ['开始解析招标文件。', '实时渲染已关闭，每项解析完成后再刷新结果。'];
  let technicalPlan = workspaceStore.updateTechnicalPlan({ bidAnalysisMode: mode, bidAnalysisTask: updateTask({ status: 'running', progress: 0, logs: initialLogs }) });
  const currentTasks = technicalPlan.bidAnalysisTasks || {};
  const tasksToRun = selectedTasks.filter((task) => currentTasks[task.id]?.status !== 'success');

  function doneProgress(nextTasks) {
    const done = selectedTasks.filter((task) => ['success', 'error'].includes(nextTasks[task.id]?.status)).length;
    return Math.round((done / selectedTasks.length) * 100);
  }

  async function runOne(task) {
    workspaceStore.updateTechnicalPlan({
      bidAnalysisTasks: { ...(workspaceStore.loadTechnicalPlan()?.bidAnalysisTasks || {}), [task.id]: { id: task.id, label: task.label, status: 'running', content: '' } },
    });

    const content = await runSingleBidAnalysisPromptTask({
      aiService,
      fileContent: payload.fileContent,
      task,
      onChunk: (nextContent) => {
        if (!realTimeRender) {
          return;
        }
        const prev = workspaceStore.loadTechnicalPlan() || {};
        const nextTasks = { ...(prev.bidAnalysisTasks || {}), [task.id]: { id: task.id, label: task.label, status: 'running', content: nextContent } };
        technicalPlan = workspaceStore.updateTechnicalPlan({ bidAnalysisTasks: nextTasks, bidAnalysisProgress: doneProgress(nextTasks) });
        updateTask({ status: 'running', progress: technicalPlan.bidAnalysisProgress || 0 }, technicalPlan);
      },
    });

    const prev = workspaceStore.loadTechnicalPlan() || {};
    const nextTasks = { ...(prev.bidAnalysisTasks || {}), [task.id]: { id: task.id, label: task.label, status: 'success', content } };
    const partial = { bidAnalysisTasks: nextTasks, bidAnalysisProgress: doneProgress(nextTasks) };
    if (task.id === 'projectOverview') partial.projectOverview = content;
    if (task.id === 'techRequirements') partial.techRequirements = content;
    technicalPlan = workspaceStore.updateTechnicalPlan(partial);
    updateTask({ status: 'running', progress: technicalPlan.bidAnalysisProgress || 0 }, technicalPlan);
  }

  await Promise.all(tasksToRun.map((task) => runOne(task).catch((error) => {
    const prev = workspaceStore.loadTechnicalPlan() || {};
    const nextTasks = { ...(prev.bidAnalysisTasks || {}), [task.id]: { id: task.id, label: task.label, status: 'error', content: prev.bidAnalysisTasks?.[task.id]?.content || '', error: error.message || '解析失败' } };
    technicalPlan = workspaceStore.updateTechnicalPlan({ bidAnalysisTasks: nextTasks, bidAnalysisProgress: doneProgress(nextTasks) });
    updateTask({ status: 'running', progress: technicalPlan.bidAnalysisProgress || 0, logs: [`${task.label}解析失败：${error.message || '未知错误'}`] }, technicalPlan);
  })));

  technicalPlan = workspaceStore.updateTechnicalPlan({ bidAnalysisTask: updateTask({ status: 'success', progress: 100, logs: ['招标文件解析完成。'] }) });
  updateTask({ status: 'success', progress: 100 }, technicalPlan);
}

module.exports = {
  buildInvalidBidAndRejectionItemsPrompt,
  getBidAnalysisTaskById,
  getBidAnalysisTasks,
  runInvalidBidAndRejectionItemsExtraction,
  runBidAnalysisTask,
  runSingleBidAnalysisPromptTask,
};
