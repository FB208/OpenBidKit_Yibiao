const fs = require('node:fs');
const path = require('node:path');

const DISABLED_BUILTIN_PROVIDERS = [
  'anthropic',
  'openai',
  'gemini',
  'google',
  'openrouter',
  'github-copilot',
  'amazon-bedrock',
  'azure',
  'deepseek',
  'xai',
];

function normalizeContextLimit(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 400000;
}

function normalizeTimeoutMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 300000;
}

function buildOpenCodeConfig({ proxyBaseUrl, contextLengthLimit, timeoutMs }) {
  const providerTimeout = normalizeTimeoutMs(timeoutMs);
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    model: 'yibiao/default',
    small_model: 'yibiao/default',
    enabled_providers: ['yibiao'],
    disabled_providers: DISABLED_BUILTIN_PROVIDERS,
    provider: {
      yibiao: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Yibiao AI',
        options: {
          baseURL: `${proxyBaseUrl}/v1`,
          apiKey: '{env:YIBIAO_OPENCODE_PROXY_TOKEN}',
          timeout: providerTimeout,
        },
        models: {
          default: {
            name: 'Yibiao Current Text Model',
            limit: {
              context: normalizeContextLimit(contextLengthLimit),
              output: 16384,
            },
          },
        },
      },
    },
    permission: {
      read: {
        '*': 'allow',
        '*.env': 'deny',
        '*.env.*': 'deny',
        '*.env.example': 'allow',
      },
      grep: 'allow',
      glob: 'allow',
      edit: 'allow',
      webfetch: 'deny',
      websearch: 'deny',
      external_directory: 'deny',
      question: 'deny',
      doom_loop: 'deny',
      bash: {
        '*': 'deny',
        'git status*': 'allow',
        'git diff*': 'allow',
        'git ls-files*': 'allow',
        'ls *': 'allow',
        'dir *': 'allow',
        'find *': 'allow',
        'grep *': 'allow',
        'rg *': 'allow',
        'cat *': 'allow',
        'type *': 'allow',
      },
    },
    formatter: false,
    lsp: false,
    mcp: {},
    instructions: [],
    watcher: {
      ignore: [
        'node_modules/**',
        'dist/**',
        'release/**',
        '.git/**',
      ],
    },
  };
}

function writeOpenCodeConfig(configPath, input) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = buildOpenCodeConfig(input);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return config;
}

module.exports = {
  buildOpenCodeConfig,
  writeOpenCodeConfig,
};
