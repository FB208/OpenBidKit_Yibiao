const {
  createPiJsonValidationTool,
  createPiJsonValidator,
  withAutomaticJsonValidation,
} = require('./piJsonValidationTool.cjs');
const {
  createPiUserQuestionTool,
} = require('./piUserQuestionTool.cjs');
const {
  AGENT_TASK_FAILURE_TOOL_NAME,
  createPiTaskFailureTool,
} = require('./piTaskFailureTool.cjs');
const {
  OPENXML_TOOL_NAME,
  createPiOpenXmlTool,
} = require('./piOpenXmlTool.cjs');
const {
  createPiRetryErrorNormalizer,
} = require('./piRetryErrorNormalizer.cjs');
const {
  PI_NO_SUMMARY_INSTRUCTIONS,
  withTaskCompletionParameter,
  installTaskCompletionHook,
} = require('./piSummaryControl.cjs');

let piModulesPromise = null;

// 延迟加载 ESM Pi SDK，供 CommonJS Electron Main 复用。
function loadPiModules() {
  if (!piModulesPromise) {
    piModulesPromise = Promise.all([
      import('@earendil-works/pi-coding-agent'),
      import('@earendil-works/pi-ai'),
      import('typebox'),
    ]).then(([codingAgent, piAi, typebox]) => ({ codingAgent, piAi, typebox }));
  }
  return piModulesPromise;
}

function normalizeContextLimit(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 400000;
}

function normalizeOutputLimit(contextLength) {
  const normalizedContextLength = normalizeContextLimit(contextLength);
  return Math.min(32768, normalizedContextLength);
}

// 创建隔离的 Pi Session；持久任务可在后续完整执行中重新打开原 Session。
async function createPiSession({ workspaceDir, sessionsDir, sessionFile, environment, proxyInfo, config, timeoutMs, jsonValidationSchemas, requestUserQuestion, reportTaskFailure, openXmlTool, summaryEnabled = true, isFinalToolCall, autoValidateJson = false }) {
  const { codingAgent, piAi, typebox } = await loadPiModules();
  const credentials = new piAi.InMemoryCredentialStore();
  const modelsStore = new piAi.InMemoryModelsStore();
  const modelRuntime = await codingAgent.ModelRuntime.create({
    credentials,
    modelsStore,
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider('yibiao', {
    name: 'Yibiao AI',
    baseUrl: `${proxyInfo.baseUrl}/v1`,
    api: 'openai-completions',
    models: [{
      id: 'default',
      name: 'Yibiao Current Text Model',
      reasoning: false,
      input: ['text'],
      contextWindow: normalizeContextLimit(config.context_length_limit),
      maxTokens: normalizeOutputLimit(config.context_length_limit),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: false,
        maxTokensField: 'max_tokens',
      },
    }],
  });
  await modelRuntime.setRuntimeApiKey('yibiao', proxyInfo.token);
  const model = modelRuntime.getModel('yibiao', 'default');
  if (!model) throw new Error('Pi Agent 模型注册失败');
  const jsonValidator = createPiJsonValidator({ workspaceDir, validationSchemas: jsonValidationSchemas, trackFailures: autoValidateJson });

  const settingsManager = codingAgent.SettingsManager.inMemory({
    defaultProvider: 'yibiao',
    defaultModel: 'default',
    defaultThinkingLevel: 'off',
    defaultProjectTrust: 'never',
    retry: { enabled: true, provider: { maxRetries: 0, timeoutMs } },
    compaction: { enabled: true },
    images: { autoResize: false, blockImages: true },
    enableInstallTelemetry: false,
    enableAnalytics: false,
    shellPath: environment.shellPath,
    httpIdleTimeoutMs: timeoutMs,
  }, { projectTrusted: false });
  const resourceLoader = new codingAgent.DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir: environment.layout.agentDir,
    settingsManager,
    extensionFactories: [createPiRetryErrorNormalizer()],
    noContextFiles: true,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: () => ({
      agentsFiles: [{ path: '<yibiao-agent-workspace>', content: environment.instructions }],
    }),
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [
      ...(summaryEnabled === false ? [PI_NO_SUMMARY_INSTRUCTIONS] : []),
      ...(autoValidateJson ? [`本次调用已开启 JSON 自动校验：${Object.keys(jsonValidationSchemas || {}).join('、')}。这些是预置规则对应的文件，不要求提前生成后续阶段文件。
- 指定文件统一通过 write 或 edit 生成和修改，工具会自动执行 JSON.parse 和 Ajv 校验。已通过自动校验的内容不要重复调用 json-validation。
- 校验失败时文件仍已修改，继续根据错误修复；相关多处修改合并到一次 edit 调用，随后自动校验完整文件。
- 只检查已有且未修改的文件，或检查没有预置规则的文件时，仍使用 json-validation。不要为了触发自动校验而重写文件。
- 关闭结束总结且工具提供 task_complete 时，可将完成标记放在最后一次自动校验的 write 或 edit 上；还有未修复错误时不能结束。`] : []),
    ],
  });
  await resourceLoader.reload();
  const bashTool = codingAgent.createBashToolDefinition(workspaceDir, {
    shellPath: environment.shellPath,
    commandPrefix: environment.shellCommandPrefix,
    spawnHook: ({ command, cwd, env }) => ({
      command,
      cwd,
      env: { ...env, ...environment.env },
    }),
  });
  const jsonValidationTool = codingAgent.defineTool(createPiJsonValidationTool({
    Type: typebox.Type,
    validator: jsonValidator,
  }));
  const userQuestionTool = codingAgent.defineTool(createPiUserQuestionTool({
    Type: typebox.Type,
    requestUserQuestion,
  }));
  const taskFailureTool = codingAgent.defineTool(createPiTaskFailureTool({
    Type: typebox.Type,
    reportTaskFailure,
  }));
  const openXmlCustomTool = openXmlTool
    ? codingAgent.defineTool(createPiOpenXmlTool({
      workspaceDir,
      Type: typebox.Type,
      ...openXmlTool,
    }))
    : null;
  const sessionManager = sessionFile
    ? codingAgent.SessionManager.open(sessionFile, sessionsDir, workspaceDir)
    : sessionsDir
      ? codingAgent.SessionManager.create(workspaceDir, sessionsDir)
      : codingAgent.SessionManager.inMemory(workspaceDir);
  let customTools = [bashTool, jsonValidationTool, userQuestionTool, taskFailureTool, ...(openXmlCustomTool ? [openXmlCustomTool] : [])];
  if (autoValidateJson) {
    customTools.push(
      withAutomaticJsonValidation(codingAgent.createWriteToolDefinition, workspaceDir, jsonValidator),
      withAutomaticJsonValidation(codingAgent.createEditToolDefinition, workspaceDir, jsonValidator),
    );
  }
  if (summaryEnabled === false && !isFinalToolCall) {
    customTools = [
      codingAgent.createReadToolDefinition(workspaceDir, { autoResizeImages: false }),
      ...(!autoValidateJson ? [codingAgent.createEditToolDefinition(workspaceDir), codingAgent.createWriteToolDefinition(workspaceDir)] : []),
      codingAgent.createFindToolDefinition(workspaceDir),
      codingAgent.createLsToolDefinition(workspaceDir),
      ...customTools,
    ].map(withTaskCompletionParameter);
  }
  const { session } = await codingAgent.createAgentSession({
    cwd: workspaceDir,
    agentDir: environment.layout.agentDir,
    model,
    modelRuntime,
    thinkingLevel: 'off',
    tools: ['read', 'bash', 'edit', 'write', 'find', 'ls', 'json-validation', 'ask-user', AGENT_TASK_FAILURE_TOOL_NAME, ...(openXmlCustomTool ? [OPENXML_TOOL_NAME] : [])],
    customTools,
    resourceLoader,
    settingsManager,
    sessionManager,
  });
  if (autoValidateJson) {
    // Pi 默认仅把抛出的异常标为失败；转发校验失败标记，同时保留工具内容和编辑差异。
    const previousAfterToolCall = session.agent.afterToolCall;
    session.agent.afterToolCall = async (context, signal) => {
      const result = await previousAfterToolCall?.(context, signal);
      return context.result.isError === true ? { ...result, isError: true } : result;
    };
  }
  if (summaryEnabled === false) installTaskCompletionHook(session.agent, isFinalToolCall, autoValidateJson ? jsonValidator.getPendingError : undefined);
  return {
    session,
    assertJsonValidationPassed: jsonValidator.assertValid,
    sessionFile: session.sessionFile || sessionManager.getSessionFile() || '',
    snapshot: {
      sdk_version: codingAgent.VERSION || '',
      model: {
        provider: model.provider || '',
        id: model.id || '',
        api: model.api || '',
        base_url: model.baseUrl || '',
        context_window: Number(model.contextWindow || 0),
        max_tokens: Number(model.maxTokens || 0),
      },
      transport: {
        proxy_base_url: proxyInfo.baseUrl,
        proxy_port: Number(proxyInfo.port || 0),
        provider_timeout_ms: Number(timeoutMs || 0),
        http_idle_timeout_ms: Number(timeoutMs || 0),
      },
      context_files: resourceLoader.getAgentsFiles().agentsFiles.map((item) => item.path),
      skills: resourceLoader.getSkills().skills.map((item) => item.name),
      prompts: resourceLoader.getPrompts().prompts.map((item) => item.name),
      extensions: resourceLoader.getExtensions().extensions.map((item) => item.path),
      active_tools: session.getActiveToolNames(),
    },
  };
}

module.exports = {
  createPiSession,
  loadPiModules,
};
