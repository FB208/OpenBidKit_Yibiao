let piModulesPromise = null;

// 延迟加载 ESM Pi SDK，供 CommonJS Electron Main 复用。
function loadPiModules() {
  if (!piModulesPromise) {
    piModulesPromise = Promise.all([
      import('@earendil-works/pi-coding-agent'),
      import('@earendil-works/pi-ai'),
    ]).then(([codingAgent, piAi]) => ({ codingAgent, piAi }));
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

// 创建完全内存化的 Pi Session，不读取外部配置、上下文或扩展。
async function createPiSession({ workspaceDir, environment, proxyInfo, config, timeoutMs }) {
  const { codingAgent, piAi } = await loadPiModules();
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

  const settingsManager = codingAgent.SettingsManager.inMemory({
    defaultProvider: 'yibiao',
    defaultModel: 'default',
    defaultThinkingLevel: 'off',
    defaultProjectTrust: 'never',
    retry: { enabled: false, provider: { maxRetries: 0, timeoutMs } },
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
    noContextFiles: true,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: () => ({
      agentsFiles: [{ path: '<yibiao-agent-workspace>', content: environment.instructions }],
    }),
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
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
  const { session } = await codingAgent.createAgentSession({
    cwd: workspaceDir,
    agentDir: environment.layout.agentDir,
    model,
    modelRuntime,
    thinkingLevel: 'off',
    tools: ['read', 'bash', 'edit', 'write', 'find', 'ls'],
    customTools: [bashTool],
    resourceLoader,
    settingsManager,
    sessionManager: codingAgent.SessionManager.inMemory(workspaceDir),
  });
  return {
    session,
    snapshot: {
      sdk_version: codingAgent.VERSION || '',
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
