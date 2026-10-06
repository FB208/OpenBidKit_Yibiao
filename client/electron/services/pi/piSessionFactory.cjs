const {
  createPiJsonValidationTool,
  createPiJsonValidator,
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

const { NATIVE_AGENT_TOOLS } = require('../agent/agentToolEnvironment.cjs');
let piModulesPromise = null;
const FIXED_TOOL_LIST_INSTRUCTIONS = '工具列表覆盖本任务的全部阶段。read、write、edit、bash、grep、find、ls 全程可用，优先按当前任务指导选择工具；业务工具仍按当前阶段使用。';

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
async function createPiSession({ workspaceDir, sessionsDir, sessionFile, environment, proxyInfo, config, timeoutMs, jsonValidationSchemas, requestUserQuestion, requestTerminationDecision, reportTaskFailure, openXmlTool, createTools, activeTools, beforeToolCall, summaryEnabled = true, isFinalToolCall, fixedToolList = false, baseline }) {
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
  const jsonValidator = createPiJsonValidator({ workspaceDir, validationSchemas: jsonValidationSchemas });

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
      ...(fixedToolList ? [FIXED_TOOL_LIST_INSTRUCTIONS] : []),
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
    requestTerminationDecision,
  }));
  const openXmlCustomTool = openXmlTool
    ? codingAgent.defineTool(createPiOpenXmlTool({
      workspaceDir,
      Type: typebox.Type,
      reportTaskFailure,
      ...openXmlTool,
    }))
    : null;
  const sessionManager = sessionFile
    ? codingAgent.SessionManager.open(sessionFile, sessionsDir, workspaceDir)
    : sessionsDir
      ? codingAgent.SessionManager.create(workspaceDir, sessionsDir)
      : codingAgent.SessionManager.inMemory(workspaceDir);
  // 业务工具按调用注入，公共 Pi 层不依赖业务服务。
  let session;
  let requestedTools;
  // 原生工具不随业务阶段收缩，自定义工具保持任务声明的权限。
  const withNativeTools = names => [...new Set([...NATIVE_AGENT_TOOLS, ...names])];
  // 恢复任务可在创建时设定权限；运行中切换使用 Pi 的工具列表接口。
  // 固定工具清单时只更新阶段门禁，system prompt 与 tools 保持不变以复用请求前缀缓存。
  const setActiveTools = toolNames => {
    requestedTools = withNativeTools(toolNames);
    if (!fixedToolList) session?.setActiveToolsByName(requestedTools);
  };
  const taskTools = (createTools?.({ Type: typebox.Type, workspaceDir, setActiveTools, baseline }) || []).map(tool => codingAgent.defineTool(tool));
  let customTools = [bashTool, jsonValidationTool, userQuestionTool, taskFailureTool, ...(openXmlCustomTool ? [openXmlCustomTool] : []), ...taskTools];
  if (summaryEnabled === false && !isFinalToolCall) {
    customTools = [
      codingAgent.createReadToolDefinition(workspaceDir, { autoResizeImages: false }),
      codingAgent.createEditToolDefinition(workspaceDir),
      codingAgent.createWriteToolDefinition(workspaceDir),
      codingAgent.createFindToolDefinition(workspaceDir),
      codingAgent.createLsToolDefinition(workspaceDir),
      codingAgent.createGrepToolDefinition(workspaceDir),
      ...customTools,
    ].map(withTaskCompletionParameter);
  }
  const defaultTools = [...NATIVE_AGENT_TOOLS, 'json-validation', 'ask-user', AGENT_TASK_FAILURE_TOOL_NAME, ...(openXmlCustomTool ? [OPENXML_TOOL_NAME] : []), ...taskTools.map(tool => tool.name)];
  const initialTools = withNativeTools(requestedTools || activeTools || defaultTools);
  // SDK 的 tools 同时限定注册范围；先注册本任务全部工具，再按阶段启用。
  ({ session } = await codingAgent.createAgentSession({
    cwd: workspaceDir,
    agentDir: environment.layout.agentDir,
    model,
    modelRuntime,
    thinkingLevel: 'off',
    tools: [...new Set([...defaultTools, ...initialTools])],
    customTools,
    resourceLoader,
    settingsManager,
    sessionManager,
  }));
  session.setActiveToolsByName(fixedToolList ? defaultTools : initialTools);
  if (beforeToolCall) {
    // 列表切换只影响下一轮；逐次执行前还须拦住当前轮已排定的禁用调用。
    const previousBeforeToolCall = session.agent.beforeToolCall;
    session.agent.beforeToolCall = async (context, signal) => {
      await beforeToolCall(context, signal);
      return previousBeforeToolCall?.(context, signal);
    };
  }
  if (fixedToolList) {
    // 阶段门禁最先执行，禁用工具不进入业务回调。
    requestedTools = initialTools;
    const previousBeforeToolCall = session.agent.beforeToolCall;
    session.agent.beforeToolCall = async (context, signal) => {
      if (!requestedTools.includes(context.toolCall.name)) throw new Error(`当前阶段不能调用 ${context.toolCall.name}，请只使用当前阶段说明的工具。`);
      return previousBeforeToolCall?.(context, signal);
    };
  }
  if (summaryEnabled === false) installTaskCompletionHook(session.agent, isFinalToolCall);
  return {
    session,
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
      active_tools: fixedToolList ? [...requestedTools] : session.getActiveToolNames(),
      registered_tools: session.getActiveToolNames(),
    },
  };
}

module.exports = {
  createPiSession,
  loadPiModules,
};
