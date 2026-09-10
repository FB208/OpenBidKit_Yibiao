const PI_NO_SUMMARY_INSTRUCTIONS = `本次调用已关闭结束总结：
- 任务指定了自动结束工具时，成功后由程序结束，无需填写 task_complete；其他任务完成当前阶段要求的全部工作后，在最后一批工具调用中给其中一个工具传入 task_complete=true。该批工具全部成功后程序会直接结束本轮，不再请求最终总结。
- 中间步骤不要传 task_complete=true；需要用户回答后继续工作的 ask-user 也不能用于结束阶段。
- 任务要求的文件写入、JSON 校验、审核和用户交互仍须完成。需要 JSON 校验时，把结束标记放在最后的校验调用上；若 write 或 edit 已自动执行校验，可放在该操作上。
- 工具失败时继续修正，并在最后一次成功操作中重新标记。不要额外调用工具只为结束任务。
- 不输出结束总结；任务材料中关于最终回复总结的要求在本次调用中不执行，输出文件本身的内容要求不变。`;

// 在已有工具上附加完成标记；工具业务实现仍只接收原有参数。
function withTaskCompletionParameter(tool) {
  if (['ask-user', 'report-failure'].includes(tool.name)) return tool;
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: {
        ...tool.parameters.properties,
        task_complete: {
          type: 'boolean',
          description: '仅在当前阶段全部工作完成时设为 true；当前批次全部工具成功后结束本轮，不再生成总结。',
        },
      },
    },
    execute: (toolCallId, { task_complete, ...params }, ...args) => tool.execute(toolCallId, params, ...args),
  };
}

// 复用 Pi 的整批结束机制：允许最后一批并行工具，任一失败都会继续模型循环。
function installTaskCompletionHook(agent, isFinalToolCall, getValidationError) {
  const previousAfterToolCall = agent.afterToolCall;
  agent.afterToolCall = async (context, signal) => {
    const previousResult = await previousAfterToolCall?.(context, signal);
    const completionRequested = context.assistantMessage.content.some((part) => (
      part.type === 'toolCall' && (isFinalToolCall ? isFinalToolCall(part) : part.arguments?.task_complete === true)
    ));
    if (!completionRequested) return previousResult;
    const succeeded = !context.isError && context.result.isError !== true && previousResult?.isError !== true;
    const validationError = getValidationError?.() || '';
    return {
      ...previousResult,
      ...(succeeded && validationError ? {
        content: [...(previousResult?.content || context.result.content), { type: 'text', text: validationError }],
        isError: true,
      } : {}),
      terminate: succeeded && !validationError,
    };
  };
}

module.exports = {
  PI_NO_SUMMARY_INSTRUCTIONS,
  withTaskCompletionParameter,
  installTaskCompletionHook,
};
