// 商务模版填写使用独立持久任务，与正文主会话并行，不共用 Session。
const BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY = 'technical-plan-business-template-fill';
// 规则和页码编制同样是正文期间的独立持久任务，与商务模版填写并行。
const RULE_PAGE_AGENT_TASK_KEY = 'technical-plan-rule-page';

module.exports = { BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY, RULE_PAGE_AGENT_TASK_KEY };
