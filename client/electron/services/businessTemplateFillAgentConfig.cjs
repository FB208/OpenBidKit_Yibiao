// 商务模版填写使用独立持久任务，与正文主会话并行，不共用 Session。
const BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY = 'technical-plan-business-template-fill';

module.exports = { BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY };
