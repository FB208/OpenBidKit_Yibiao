const AGENT_USER_QUESTION_TOOL_NAME = 'ask-user';

// 创建供 Agent 在关键事项不确定时向用户提问的专用工具。
function createPiUserQuestionTool({ Type, requestUserQuestion }) {
  return {
    name: AGENT_USER_QUESTION_TOOL_NAME,
    label: '询问用户',
    description: '当任务材料无法确定且不同选择会实质影响结果时，暂停执行并向普通用户提出一个简单易懂的问题。提供 2 至 5 个互斥选项，将推荐选项放在第一项；每个选项必须声明是否需要用户输入具体要求，且最多只能有一个自定义输入选项。',
    promptSnippet: '在关键事项无法从材料中确定时，使用普通用户能理解的自然中文提问并等待回答。',
    promptGuidelines: [
      '已有材料足以判断时自主执行，不要调用 ask-user。',
      '只有不确定事项会实质影响结果时才调用 ask-user；每次只问一个问题，提供 2 至 5 个互斥选项，并将无需用户补充输入的推荐选项放在第一项。每个选项都必须填写 custom。',
      '问题、选项名称和选项说明必须面向不懂软件开发的普通用户，只说明业务对象、推荐结果、实际影响和可选操作，语言简单、自然且容易决策。',
      '禁止向用户展示变量名、字段名、文件名、JSON 属性、英文状态、内部编号或其他软件实现术语；必须把内部信息转换为具体名称、数量、层级和调整效果等业务表述。',
      '问题、选项名称和选项说明不得复述、概括或改写当前任务 Prompt 中的要求，只呈现分析后确实需要用户确认的结论或不确定事项。',
      '存在多个实际确认事项时，使用简单 Markdown 按“简短说明、空行、分行要点、空行、最后确认问题”组织；每个要点只表达一件事，不要增加小标题或输出连续长段落。',
      '选项名称使用“按推荐方案处理”“保持当前结果”等可直接判断结果的简短操作文案，不得描述程序处理步骤或数据结构。',
      '普通选项设置 custom=false；只有需要用户选中后输入具体要求时才设置 custom=true。custom=true 的选项最多只能有一个，通常放在最后，且必须使用“补充具体要求”等明确操作名称，不得使用含义模糊的“其他”。',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      question: Type.String({
        minLength: 1,
        description: '需要普通用户确认的具体业务问题，必须使用简单自然的中文，不得包含任何软件实现术语或复述任务要求；存在多个实际确认事项时使用简单 Markdown 分行列出要点。',
      }),
      options: Type.Array(Type.Object({
        label: Type.String({
          minLength: 1,
          description: '简短、明确且可直接判断结果的操作名称，不得包含内部字段或技术标识。',
        }),
        description: Type.Optional(Type.String({
          description: '使用普通用户能理解的语言说明该选项的业务结果或影响。',
        })),
        custom: Type.Boolean({
          description: '是否需要用户在选中后输入具体要求。普通选项为 false，自定义输入选项为 true；一次提问最多只能有一个 true。',
        }),
      }, { additionalProperties: false }), {
        minItems: 2,
        maxItems: 5,
        description: '候选选项，第一项必须是 custom=false 的推荐选项；自定义输入选项计入总数。',
      }),
    }, { additionalProperties: false }),
    execute: async (toolCallId, params, signal) => {
      if (typeof requestUserQuestion !== 'function') {
        throw new Error('用户提问通道未初始化');
      }
      const customOptionCount = params.options.filter((option) => option.custom === true).length;
      if (customOptionCount > 1) {
        throw new Error('自定义输入选项最多只能有一个，请调整选项后重新提问');
      }
      if (params.options[0]?.custom === true) {
        throw new Error('推荐选项不能要求用户补充输入，请调整选项后重新提问');
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
