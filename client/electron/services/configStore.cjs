const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getConfigFilePath } = require('../utils/paths.cjs');

const textModelProviders = ['jinlong', 'volcengine', 'xiaomi', 'deepseek', 'longcat', 'custom'];
const oldXiaomiBaseUrl = 'https://api.xiaomimimo.com/v1';

const textProviderBaseUrls = {
  jinlong: 'https://jlaudeapi.com/v1',
  volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
  xiaomi: 'https://token-plan-cn.xiaomimimo.com/v1',
  deepseek: 'https://api.deepseek.com',
  longcat: 'https://api.longcat.chat/openai/v1',
  custom: '',
};

const defaultTextModelProfiles = {
  jinlong: {
    api_key: '',
    base_url: textProviderBaseUrls.jinlong,
    model_name: 'gpt-3.5-turbo',
  },
  volcengine: {
    api_key: '',
    base_url: textProviderBaseUrls.volcengine,
    model_name: '',
  },
  xiaomi: {
    api_key: '',
    base_url: textProviderBaseUrls.xiaomi,
    model_name: '',
  },
  deepseek: {
    api_key: '',
    base_url: textProviderBaseUrls.deepseek,
    model_name: '',
  },
  longcat: {
    api_key: '',
    base_url: textProviderBaseUrls.longcat,
    model_name: '',
  },
  custom: {
    api_key: '',
    base_url: '',
    model_name: '',
  },
};

const defaultConfig = {
  text_model_provider: 'jinlong',
  text_model_profiles: defaultTextModelProfiles,
  api_key: '',
  base_url: textProviderBaseUrls.jinlong,
  model_name: 'gpt-3.5-turbo',
  image_model: {
    provider: 'volcengine',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    api_key: '',
    model_name: '',
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  file_parser: {
    provider: 'local',
    mineru_token: '',
  },
  developer_mode: false,
  real_time_render: true,
  analytics_client_id: '',
  analytics_created_at: '',
};

function createAnalyticsClientId() {
  return crypto.randomUUID();
}

function createAnalyticsCreatedAt() {
  return new Date().toISOString().slice(0, 10);
}

function isTextModelProvider(value) {
  return textModelProviders.includes(value);
}

function normalizeTextModelProfile(provider, profile) {
  const defaults = defaultTextModelProfiles[provider];
  const source = profile || {};
  const sourceBaseUrl = source.base_url !== undefined ? source.base_url : defaults.base_url;
  return {
    api_key: source.api_key !== undefined ? source.api_key : defaults.api_key,
    base_url: provider === 'xiaomi' && sourceBaseUrl === oldXiaomiBaseUrl ? defaults.base_url : sourceBaseUrl,
    model_name: source.model_name !== undefined ? source.model_name : defaults.model_name,
  };
}

function normalizeTextModelProfiles(sourceProfiles) {
  const profiles = {};
  textModelProviders.forEach((provider) => {
    profiles[provider] = normalizeTextModelProfile(
      provider,
      sourceProfiles && typeof sourceProfiles === 'object' ? sourceProfiles[provider] : null,
    );
  });
  return profiles;
}

function textProfileFromFlatConfig(source, fallback, provider) {
  const sourceBaseUrl = source.base_url !== undefined ? source.base_url : fallback.base_url;
  return {
    api_key: source.api_key !== undefined ? source.api_key : fallback.api_key,
    base_url: provider === 'xiaomi' && sourceBaseUrl === oldXiaomiBaseUrl ? fallback.base_url : sourceBaseUrl,
    model_name: source.model_name !== undefined ? source.model_name : fallback.model_name,
  };
}

function normalizeConfig(config) {
  const source = config || {};
  const fileParser = source.file_parser ? source.file_parser : {};
  const hasTextProvider = Object.prototype.hasOwnProperty.call(source, 'text_model_provider');
  const sourceTextProvider = isTextModelProvider(source.text_model_provider)
    ? source.text_model_provider
    : '';
  const textModelProvider = sourceTextProvider || (hasTextProvider || config ? 'custom' : defaultConfig.text_model_provider);
  const textModelProfiles = normalizeTextModelProfiles(source.text_model_profiles);
  textModelProfiles[textModelProvider] = textProfileFromFlatConfig(source, textModelProfiles[textModelProvider], textModelProvider);
  const activeTextProfile = textModelProfiles[textModelProvider];

  return {
    ...defaultConfig,
    ...source,
    text_model_provider: textModelProvider,
    text_model_profiles: textModelProfiles,
    api_key: activeTextProfile.api_key,
    base_url: activeTextProfile.base_url,
    model_name: activeTextProfile.model_name,
    image_model: {
      ...defaultConfig.image_model,
      ...(source.image_model ? source.image_model : {}),
    },
    file_parser: {
      provider: fileParser.provider || defaultConfig.file_parser.provider,
      mineru_token: fileParser.mineru_token || defaultConfig.file_parser.mineru_token,
    },
  };
}

function createConfigStore(app) {
  const configFile = getConfigFilePath(app);

  function persist(config) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
  }

  function withAnalyticsIdentity(config) {
    if (config.analytics_client_id && config.analytics_created_at) {
      return config;
    }

    return {
      ...config,
      analytics_client_id: config.analytics_client_id || createAnalyticsClientId(),
      analytics_created_at: config.analytics_created_at || createAnalyticsCreatedAt(),
    };
  }

  return {
    getConfigFilePath() {
      return configFile;
    },

    load() {
      if (!fs.existsSync(configFile)) {
        const config = withAnalyticsIdentity(normalizeConfig());
        persist(config);
        return config;
      }

      try {
        const raw = fs.readFileSync(configFile, 'utf-8');
        const parsedConfig = JSON.parse(raw);
        const config = normalizeConfig(parsedConfig);
        const nextConfig = withAnalyticsIdentity(config);
        if (JSON.stringify(parsedConfig) !== JSON.stringify(nextConfig)) {
          persist(nextConfig);
        }
        return nextConfig;
      } catch (error) {
        throw new Error(`配置文件读取失败：${error.message}`);
      }
    },

    save(config) {
      try {
        const currentConfig = fs.existsSync(configFile)
          ? normalizeConfig(JSON.parse(fs.readFileSync(configFile, 'utf-8')))
          : normalizeConfig();
        const nextConfig = withAnalyticsIdentity(normalizeConfig({
          ...currentConfig,
          ...config,
          text_model_profiles: {
            ...currentConfig.text_model_profiles,
            ...(config && config.text_model_profiles ? config.text_model_profiles : {}),
          },
          analytics_client_id: config?.analytics_client_id || currentConfig.analytics_client_id,
          analytics_created_at: config?.analytics_created_at || currentConfig.analytics_created_at,
        }));
        persist(nextConfig);
        return { success: true, message: '配置已保存', config_path: configFile };
      } catch (error) {
        throw new Error(`配置文件保存失败：${error.message}`);
      }
    },
  };
}

module.exports = {
  createConfigStore,
};
