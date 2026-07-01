const fs = require('node:fs');
const path = require('node:path');

function normalizeContextLimit(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 400000;
}

function normalizeOutputLimit(contextLengthLimit) {
  const context = normalizeContextLimit(contextLengthLimit);
  return Math.max(32768, Math.floor(context * 0.5));
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
              output: normalizeOutputLimit(contextLengthLimit),
            },
          },
        },
      },
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
