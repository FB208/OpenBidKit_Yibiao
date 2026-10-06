const AGENT_TASK_FAILURE_TOOL_NAME = 'report-failure';
const AGENT_REPORTED_FAILURE_CODE = 'AGENT_REPORTED_FAILURE';
const CONTINUE_OPTION = { label: '降低质量继续', description: '放宽质量要求，只保证流程能完成，结果需要人工核对', custom: false };
const TERMINATE_OPTION = { label: '终止任务', description: '结束当前任务，可补充资料或调整设置后重新执行', custom: false };
const CUSTOM_OPTION = { label: '补充处理要求', description: '输入您希望 Agent 如何继续处理', custom: true };
const TERMINATION_OPTIONS = [CONTINUE_OPTION, TERMINATE_OPTION, CUSTOM_OPTION];

function buildTerminationQuestion(reason) {
  return `Agent 认为当前任务无法按原要求继续：\n\n${reason}\n\n继续执行需要降低质量要求：数量、篇幅、专业性和资料依据都会放宽，内容可能不完整、与项目实际不符，需要您后续人工核对。是否终止当前任务？`;
}

function buildContinueInstruction(answer) {
  const lines = [
    '用户选择不终止任务，要求继续执行。',
    '- 质量要求已放宽：任务要求中的数量、篇幅、层级、专业性、资料依据和真实性等质量要求均可降低或放弃，不足部分可用通用内容、推测内容或占位内容补齐。',
    '- 唯一底线：按任务要求写出必需文件，结构和格式通过程序校验，使流程能够稳定进入下一步。',
    '- 不得以同一原因再次请求终止，立即调整做法继续执行。',
  ];
  if (answer.is_custom) {
    lines.push(`用户补充要求：${answer.answer}`, '该要求优先执行，与上述放宽规则冲突时以用户要求为准。');
  }
  return lines.join('\n');
}

// 失败交回父 Agent 的子会话直接报告失败；其余 Agent 请求终止时由用户决定是否终止。
function createPiTaskFailureTool({ Type, reportTaskFailure, requestTerminationDecision }) {
  if (typeof requestTerminationDecision !== 'function') {
    return {
      name: AGENT_TASK_FAILURE_TOOL_NAME,
      label: '报告任务失败',
      description: '可自行修复的问题应先修复；需要用户决策时按本任务的提问规则处理。无法在当前任务允许的处理规则内完成要求时，报告面向普通用户的具体原因并立即结束任务。',
      promptSnippet: '任务确实无法继续时，使用自然中文报告具体原因并立即结束，不要删除、清空或重命名文件。',
      promptGuidelines: [
        '可自行修复的问题继续修复；需要用户选择有效方案时按本任务的提问规则处理，有 ask-user 工具时调用该工具。当无法在当前任务允许的处理规则内完成要求时，调用 report-failure 并说明原因。任务明确允许的补充设定、占位或概括性表达按对应规范执行；不得虚构工具执行结果、文件存在状态或任务完成情况。',
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

  // 用户选择继续后再次请求终止必须人工确认，避免自动作答反复放行形成死循环。
  let continued = false;
  return {
    name: AGENT_TASK_FAILURE_TOOL_NAME,
    label: '请求终止任务',
    description: '只有判断当前任务无法按要求继续时调用。程序会向用户说明原因并确认是否终止：用户确认后任务结束；用户选择继续时，工具会返回放宽后的执行要求，你必须按该要求继续完成任务。',
    promptSnippet: '任务确实无法按要求继续时，用自然中文说明原因并请求终止；是否终止由用户决定，用户选择继续时必须降低要求完成任务。',
    promptGuidelines: [
      '可自行修复的问题继续修复；需要用户在有效方案之间选择时按本任务的提问规则处理。只有判断当前任务无法按要求继续时才调用 report-failure，由用户决定是否终止；不得以其他方式自行结束或放弃任务，不得虚构工具执行结果、文件存在状态或任务完成情况。',
      'reason 必须直接面向普通用户，说明无法继续的具体业务原因，不得使用文件名、字段名、JSON 属性或内部错误码。',
      '用户确认终止后任务会立即结束，不要再调用任何工具；用户选择继续时，严格按工具返回的要求降低质量继续执行，不得以同一原因再次请求终止。',
      '不得通过删除、清空或重命名输入、过程或输出文件表达失败。',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      reason: Type.String({
        minLength: 1,
        description: '面向普通用户的无法继续原因，会展示给用户用于决定是否终止任务。',
      }),
    }, { additionalProperties: false }),
    execute: async (toolCallId, params, signal) => {
      const reason = String(params.reason || '').trim();
      const answer = await requestTerminationDecision({
        tool_call_id: toolCallId,
        question: buildTerminationQuestion(reason),
        options: TERMINATION_OPTIONS,
        auto_answer: !continued,
      }, signal);
      if (answer.selected_option === TERMINATE_OPTION.label) {
        reportTaskFailure(`${reason}（已按您的选择终止任务）`);
        const result = { terminated: true, reason };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      }
      continued = true;
      return {
        content: [{ type: 'text', text: buildContinueInstruction(answer) }],
        details: { terminated: false, selected_option: answer.selected_option, ...(answer.is_custom ? { user_reply: answer.answer } : {}) },
      };
    },
  };
}

module.exports = {
  AGENT_REPORTED_FAILURE_CODE,
  AGENT_TASK_FAILURE_TOOL_NAME,
  createPiTaskFailureTool,
};
