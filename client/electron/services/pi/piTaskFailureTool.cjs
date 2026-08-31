const AGENT_TASK_FAILURE_TOOL_NAME = 'report-failure';
const AGENT_REPORTED_FAILURE_CODE = 'AGENT_REPORTED_FAILURE';

// 创建供 Agent 在现有材料无法支持任务完成时主动报告失败的专用工具。
function createPiTaskFailureTool({ Type, reportTaskFailure }) {
  return {
    name: AGENT_TASK_FAILURE_TOOL_NAME,
    label: '报告任务失败',
    description: '当现有材料无法满足任务要求且继续执行只能编造结果时，报告面向普通用户的具体原因并立即结束任务。',
    promptSnippet: '任务确实无法继续时，使用自然中文报告具体原因并立即结束，不要删除、清空或重命名文件。',
    promptGuidelines: [
      '可自行修复的问题继续修复；需要用户选择有效方案时使用 ask-user；只有现有材料无法支持任务完成且继续只能编造时才调用 report-failure。',
      'reason 必须直接面向普通用户，说明无法继续的具体业务原因和需要补充或调整的内容，不得使用文件名、字段名、JSON 属性或内部错误码。',
      '调用 report-failure 后任务会立即结束，不要再调用任何工具，也不得通过删除、清空或重命名输入、过程或输出文件表达失败。',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      reason: Type.String({
        minLength: 1,
        description: '面向普通用户的任务失败原因，并说明需要补充或调整的业务内容。',
      }),
    }, { additionalProperties: false }),
    execute: async (toolCallId, params) => {
      if (typeof reportTaskFailure !== 'function') {
        throw new Error('任务失败报告通道未初始化');
      }
      reportTaskFailure(params.reason);
      const result = { reported: true, reason: params.reason };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

module.exports = {
  AGENT_REPORTED_FAILURE_CODE,
  AGENT_TASK_FAILURE_TOOL_NAME,
  createPiTaskFailureTool,
};
