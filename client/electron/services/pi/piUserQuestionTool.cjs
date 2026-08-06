const AGENT_USER_QUESTION_TOOL_NAME = 'ask-user';

// 创建供 Agent 在关键事项不确定时向用户提问的专用工具。
function createPiUserQuestionTool({ Type, requestUserQuestion }) {
  return {
    name: AGENT_USER_QUESTION_TOOL_NAME,
    label: '询问用户',
    description: '当任务材料无法确定且不同选择会实质影响结果时，暂停执行并向用户提出一个问题。提供 2 至 5 个互斥选项，将推荐选项放在第一项；程序会自动追加“其他”，不要自行提供。',
    promptSnippet: '在关键事项无法从材料中确定时向用户提问并等待回答。',
    promptGuidelines: [
      '已有材料足以判断时自主执行，不要调用 ask-user。',
      '只有不确定事项会实质影响结果时才调用 ask-user；每次只问一个问题，提供 2 至 5 个互斥选项，并将推荐选项放在第一项。',
      '不要在选项中提供“其他”，程序会自动追加自由输入选项。',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      question: Type.String({
        minLength: 1,
        description: '需要用户确认的具体问题。',
      }),
      options: Type.Array(Type.Object({
        label: Type.String({
          minLength: 1,
          description: '简短、明确且可直接选择的选项名称。',
        }),
        description: Type.Optional(Type.String({
          description: '说明该选项的含义或影响。',
        })),
      }, { additionalProperties: false }), {
        minItems: 2,
        maxItems: 5,
        description: '候选选项，第一项必须是推荐选项。',
      }),
    }, { additionalProperties: false }),
    execute: async (toolCallId, params, signal) => {
      if (typeof requestUserQuestion !== 'function') {
        throw new Error('用户提问通道未初始化');
      }
      const answer = await requestUserQuestion({
        tool_call_id: toolCallId,
        question: params.question,
        options: params.options,
      }, signal);
      const result = { answered: true, ...answer };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

module.exports = {
  AGENT_USER_QUESTION_TOOL_NAME,
  createPiUserQuestionTool,
};
