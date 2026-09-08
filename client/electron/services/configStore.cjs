const fs = require('node:fs');
const path = require('node:path');
const { getConfigFilePath } = require('../utils/paths.cjs');
const { createAnalyticsClientId } = require('../utils/machineIdentity.cjs');
const { defaultExportFormat, normalizeExportFormat } = require('./exportFormatDefaults.cjs');

const textModelProviders = ['jinlong', 'volcengine', 'deepseek', 'agnes', 'custom'];
const imageModelProviders = ['jinlong', 'volcengine', 'google-ai-studio', 'agnes', 'custom', 'comfyui'];
const aiRequestModes = ['normal', 'stream'];
const updateChannels = ['github', 'cloudflare', 'atomgit'];
const DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT = 400000;
const DEFAULT_TEXT_CONCURRENCY_LIMIT = 10;
const DEFAULT_TEXT_TEMPERATURE = 0.7;
const DEFAULT_IMAGE_CONCURRENCY_LIMIT = 2;
const DEFAULT_COMPONENT_CONCURRENCY_LIMIT = 5;
const MIN_COMPONENT_CONCURRENCY_LIMIT = 1;
const MAX_COMPONENT_CONCURRENCY_LIMIT = 20;
const DEFAULT_AGENT_AUTO_ANSWER_ENABLED = false;
const openAICompatibleImageSizes = ['auto', '1K', '2K', '3K', '4K', '1024x768', '1024x1024', '768x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '3840x2160', '2160x3840'];
const googleImageSizes = ['512', '1K', '2K', '4K'];
const agnesImageRatios = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];

const textProviderBaseUrls = {
  jinlong: 'https://jlaudeapi.com/v1',
  volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
  deepseek: 'https://api.deepseek.com',
  agnes: 'https://apihub.agnes-ai.com/v1',
  custom: '',
};

const defaultTextModelProfiles = {
  jinlong: {
    api_key: '',
    base_url: textProviderBaseUrls.jinlong,
    model_name: 'gpt-3.5-turbo',
    multimodal_enabled: false,
    reasoning_effort: '',
    context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT,
    concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT,
    temperature_enabled: false,
    temperature: DEFAULT_TEXT_TEMPERATURE,
    request_mode: 'stream',
  },
  volcengine: {
    api_key: '',
    base_url: textProviderBaseUrls.volcengine,
    model_name: '',
    multimodal_enabled: false,
    reasoning_effort: '',
    context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT,
    concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT,
    temperature_enabled: false,
    temperature: DEFAULT_TEXT_TEMPERATURE,
    request_mode: 'stream',
  },
  deepseek: {
    api_key: '',
    base_url: textProviderBaseUrls.deepseek,
    model_name: '',
    multimodal_enabled: false,
    reasoning_effort: '',
    context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT,
    concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT,
    temperature_enabled: false,
    temperature: DEFAULT_TEXT_TEMPERATURE,
    request_mode: 'stream',
  },
  agnes: {
    api_key: '',
    base_url: textProviderBaseUrls.agnes,
    model_name: '',
    multimodal_enabled: false,
    reasoning_effort: '',
    context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT,
    concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT,
    temperature_enabled: false,
    temperature: DEFAULT_TEXT_TEMPERATURE,
    request_mode: 'stream',
  },
  custom: {
    api_key: '',
    base_url: '',
    model_name: '',
    multimodal_enabled: false,
    reasoning_effort: '',
    context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT,
    concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT,
    temperature_enabled: false,
    temperature: DEFAULT_TEXT_TEMPERATURE,
    request_mode: 'stream',
  },
};

const defaultImageModelProfiles = {
  jinlong: {
    provider: 'jinlong',
    base_url: 'https://img-api.jlaudeapi.com/v1',
    api_key: '',
    model_name: 'gpt-image-2',
    image_size: '1024x1024',
    request_mode: 'normal',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  volcengine: {
    provider: 'volcengine',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    api_key: '',
    model_name: '',
    image_size: '1024x1024',
    image_ratio: '1:1',
    request_mode: 'normal',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  'google-ai-studio': {
    provider: 'google-ai-studio',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    api_key: '',
    model_name: 'gemini-3.1-flash-image-preview',
    image_size: '1K',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  agnes: {
    provider: 'agnes',
    base_url: 'https://apihub.agnes-ai.com/v1',
    api_key: '',
    model_name: '',
    image_size: '1024x1024',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  custom: {
    provider: 'custom',
    base_url: '',
    api_key: '',
    model_name: '',
    image_size: '1024x1024',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  comfyui: {
    provider: 'comfyui',
    base_url: 'http://127.0.0.1:8188',
    api_key: '',
    model_name: 'z-image-turbo',
    image_size: '1024x1024',
    request_mode: 'normal',
    concurrency_limit: 1,
    comfyui_workflow: '',
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
};

const defaultConfig = {
  text_model_provider: 'jinlong',
  text_model_profiles: defaultTextModelProfiles,
  api_key: '',
  base_url: textProviderBaseUrls.jinlong,
  model_name: 'gpt-3.5-turbo',
  multimodal_enabled: false,
  reasoning_effort: '',
  context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT,
  concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT,
  temperature_enabled: false,
  temperature: DEFAULT_TEXT_TEMPERATURE,
  request_mode: 'stream',
  image_model: {
    ...defaultImageModelProfiles.jinlong,
  },
  image_model_profiles: defaultImageModelProfiles,
  components: {
    file_parser: {
      provider: 'local',
      mineru_token: '',
    },
    mermaid_concurrency_limit: DEFAULT_COMPONENT_CONCURRENCY_LIMIT,
    html_concurrency_limit: DEFAULT_COMPONENT_CONCURRENCY_LIMIT,
  },
  update_channel: 'atomgit',
  gpu_hardware_acceleration_enabled: true,
  gpu_hardware_acceleration_configured: true,
  export_format: defaultExportFormat,
  agent_auto_answer_enabled: DEFAULT_AGENT_AUTO_ANSWER_ENABLED,
  developer_mode: false,
  developer_token_stats_auto_open: false,
  developer_agent_monitor_auto_open: false,
  storage_cleanup_version: 0,
  analytics_client_id: '',
  analytics_created_at: '',
};

function createAnalyticsCreatedAt() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isTextModelProvider(value) {
  return textModelProviders.includes(value);
}

function isImageModelProvider(value) {
  return imageModelProviders.includes(value);
}

function normalizeAiRequestMode(value, fallback = 'stream') {
  return aiRequestModes.includes(value) ? value : fallback;
}

function normalizeUpdateChannel(value, fallback = defaultConfig.update_channel) {
  return updateChannels.includes(value) ? value : fallback;
}

function normalizeTextContextLengthLimit(value, fallback = DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeTextConcurrencyLimit(value, fallback = DEFAULT_TEXT_CONCURRENCY_LIMIT) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

// 归一化文本模型温度，OpenAI Like 接口通用范围为 0-2。
function normalizeTextTemperature(value, fallback = DEFAULT_TEXT_TEMPERATURE) {
  if (value === '' || value === null || value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 2 ? number : fallback;
}

// 归一化文本模型温度开关。
function normalizeTextTemperatureEnabled(value, fallback = false) {
  return value === undefined ? fallback : Boolean(value);
}

// 归一化文本模型多模态开关，旧配置缺失时默认关闭。
function normalizeTextMultimodalEnabled(value, fallback = false) {
  return value === undefined ? fallback : Boolean(value);
}

// 归一化文本模型思考强度，空字符串表示不发送该参数。
function normalizeReasoningEffort(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value).trim();
}

function normalizeImageConcurrencyLimit(value, fallback = DEFAULT_IMAGE_CONCURRENCY_LIMIT) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

// 归一化组件转换并发量，限制在 1-20。
function normalizeComponentConcurrencyLimit(value, fallback = DEFAULT_COMPONENT_CONCURRENCY_LIMIT) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_COMPONENT_CONCURRENCY_LIMIT, Math.max(MIN_COMPONENT_CONCURRENCY_LIMIT, Math.round(number)));
}

// 归一化组件设置（文件解析 + Mermaid/HTML 转换并发）。
function normalizeComponentsConfig(source) {
  const components = source && typeof source === 'object' ? source : {};
  const fileParser = components.file_parser && typeof components.file_parser === 'object'
    ? components.file_parser
    : {};
  return {
    file_parser: {
      provider: fileParser.provider || defaultConfig.components.file_parser.provider,
      mineru_token: fileParser.mineru_token || defaultConfig.components.file_parser.mineru_token,
    },
    mermaid_concurrency_limit: normalizeComponentConcurrencyLimit(
      components.mermaid_concurrency_limit,
      defaultConfig.components.mermaid_concurrency_limit,
    ),
    html_concurrency_limit: normalizeComponentConcurrencyLimit(
      components.html_concurrency_limit,
      defaultConfig.components.html_concurrency_limit,
    ),
  };
}

function normalizeTextModelProfile(provider, profile) {
  const defaults = defaultTextModelProfiles[provider];
  const source = profile || {};
  const sourceBaseUrl = provider === 'custom'
    ? source.base_url !== undefined ? source.base_url : defaults.base_url
    : defaults.base_url;
  return {
    api_key: source.api_key !== undefined ? source.api_key : defaults.api_key,
    base_url: sourceBaseUrl,
    model_name: source.model_name !== undefined ? source.model_name : defaults.model_name,
    multimodal_enabled: normalizeTextMultimodalEnabled(source.multimodal_enabled, defaults.multimodal_enabled),
    reasoning_effort: normalizeReasoningEffort(source.reasoning_effort, defaults.reasoning_effort),
    context_length_limit: normalizeTextContextLengthLimit(source.context_length_limit, defaults.context_length_limit),
    concurrency_limit: normalizeTextConcurrencyLimit(source.concurrency_limit, defaults.concurrency_limit),
    temperature_enabled: normalizeTextTemperatureEnabled(source.temperature_enabled, defaults.temperature_enabled),
    temperature: normalizeTextTemperature(source.temperature, defaults.temperature),
    request_mode: normalizeAiRequestMode(source.request_mode, defaults.request_mode),
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
  const sourceBaseUrl = provider === 'custom'
    ? source.base_url !== undefined ? source.base_url : fallback.base_url
    : fallback.base_url;
  return {
    api_key: source.api_key !== undefined ? source.api_key : fallback.api_key,
    base_url: sourceBaseUrl,
    model_name: source.model_name !== undefined ? source.model_name : fallback.model_name,
    multimodal_enabled: normalizeTextMultimodalEnabled(source.multimodal_enabled, fallback.multimodal_enabled),
    reasoning_effort: normalizeReasoningEffort(source.reasoning_effort, fallback.reasoning_effort),
    context_length_limit: normalizeTextContextLengthLimit(source.context_length_limit !== undefined ? source.context_length_limit : fallback.context_length_limit, fallback.context_length_limit),
    concurrency_limit: normalizeTextConcurrencyLimit(source.concurrency_limit !== undefined ? source.concurrency_limit : fallback.concurrency_limit, fallback.concurrency_limit),
    temperature_enabled: normalizeTextTemperatureEnabled(source.temperature_enabled, fallback.temperature_enabled),
    temperature: normalizeTextTemperature(source.temperature !== undefined ? source.temperature : fallback.temperature, fallback.temperature),
    request_mode: normalizeAiRequestMode(source.request_mode !== undefined ? source.request_mode : fallback.request_mode, fallback.request_mode),
  };
}

function hasTextModelProfileData(profile) {
  return Boolean(profile && ['api_key', 'base_url', 'model_name'].some((key) => String(profile[key] || '').trim()));
}

function getSourceTextModelProfiles(source) {
  return source.text_model_profiles && typeof source.text_model_profiles === 'object'
    ? source.text_model_profiles
    : {};
}

function pickTextProfileField(primary, secondary, fallback) {
  if (primary !== undefined && String(primary).trim()) return primary;
  if (secondary !== undefined && String(secondary).trim()) return secondary;
  if (primary !== undefined) return primary;
  if (secondary !== undefined) return secondary;
  return fallback;
}

function textProfileFromUnknownProvider(source, sourceProvider, fallback) {
  const sourceProfiles = getSourceTextModelProfiles(source);
  const selectedProfile = sourceProvider ? sourceProfiles[sourceProvider] : null;
  return {
    api_key: pickTextProfileField(source.api_key, selectedProfile?.api_key, fallback.api_key),
    base_url: pickTextProfileField(source.base_url, selectedProfile?.base_url, fallback.base_url),
    model_name: pickTextProfileField(source.model_name, selectedProfile?.model_name, fallback.model_name),
    multimodal_enabled: normalizeTextMultimodalEnabled(source.multimodal_enabled ?? selectedProfile?.multimodal_enabled, fallback.multimodal_enabled),
    reasoning_effort: normalizeReasoningEffort(source.reasoning_effort ?? selectedProfile?.reasoning_effort, fallback.reasoning_effort),
    context_length_limit: normalizeTextContextLengthLimit(pickTextProfileField(source.context_length_limit, selectedProfile?.context_length_limit, fallback.context_length_limit), fallback.context_length_limit),
    concurrency_limit: normalizeTextConcurrencyLimit(pickTextProfileField(source.concurrency_limit, selectedProfile?.concurrency_limit, fallback.concurrency_limit), fallback.concurrency_limit),
    temperature_enabled: normalizeTextTemperatureEnabled(source.temperature_enabled ?? selectedProfile?.temperature_enabled, fallback.temperature_enabled),
    temperature: normalizeTextTemperature(pickTextProfileField(source.temperature, selectedProfile?.temperature, fallback.temperature), fallback.temperature),
    request_mode: normalizeAiRequestMode(pickTextProfileField(source.request_mode, selectedProfile?.request_mode, fallback.request_mode), fallback.request_mode),
  };
}

function getImageSizeOptions(provider) {
  return provider === 'google-ai-studio' ? googleImageSizes : openAICompatibleImageSizes;
}

function normalizeImageSize(provider, value, fallback) {
  const options = getImageSizeOptions(provider);
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (options.includes(candidate)) {
    return candidate;
  }

  const fallbackCandidate = typeof fallback === 'string' ? fallback.trim() : '';
  if (options.includes(fallbackCandidate)) {
    return fallbackCandidate;
  }

  return provider === 'google-ai-studio' ? '1K' : '1024x1024';
}

// 归一化 Agnes 2.1 图片宽高比。
function normalizeImageRatio(value) {
  return agnesImageRatios.includes(value) ? value : '1:1';
}

function normalizeImageModelProfile(provider, profile) {
  const defaults = defaultImageModelProfiles[provider];
  const source = profile || {};
  const useProviderDefaultImageModel = provider === 'jinlong' && !String(source.model_name ?? '').trim();
  return {
    provider,
    base_url: provider === 'custom' || provider === 'comfyui'
      ? source.base_url !== undefined ? source.base_url : defaults.base_url
      : defaults.base_url,
    api_key: source.api_key !== undefined ? source.api_key : defaults.api_key,
    model_name: useProviderDefaultImageModel ? defaults.model_name : source.model_name !== undefined ? source.model_name : defaults.model_name,
    image_size: normalizeImageSize(provider, useProviderDefaultImageModel ? defaults.image_size : source.image_size, defaults.image_size),
    ...(provider === 'agnes' ? { image_ratio: normalizeImageRatio(source.image_ratio) } : {}),
    request_mode: normalizeAiRequestMode(useProviderDefaultImageModel ? defaults.request_mode : source.request_mode, defaults.request_mode),
    concurrency_limit: normalizeImageConcurrencyLimit(source.concurrency_limit, defaults.concurrency_limit),
    comfyui_workflow: source.comfyui_workflow !== undefined ? String(source.comfyui_workflow) : (defaults.comfyui_workflow || ''),
    status: useProviderDefaultImageModel ? defaults.status : source.status !== undefined ? source.status : defaults.status,
    tested_at: useProviderDefaultImageModel ? defaults.tested_at : source.tested_at !== undefined ? source.tested_at : defaults.tested_at,
    last_error: useProviderDefaultImageModel ? defaults.last_error : source.last_error !== undefined ? source.last_error : defaults.last_error,
  };
}

function normalizeImageModelProfiles(sourceProfiles) {
  const profiles = {};
  imageModelProviders.forEach((provider) => {
    profiles[provider] = normalizeImageModelProfile(
      provider,
      sourceProfiles && typeof sourceProfiles === 'object' ? sourceProfiles[provider] : null,
    );
  });
  return profiles;
}

function normalizeConfig(config) {
  const source = config || {};
  const hasTextProvider = Object.prototype.hasOwnProperty.call(source, 'text_model_provider');
  const rawTextProvider = typeof source.text_model_provider === 'string' ? source.text_model_provider : '';
  const sourceTextProvider = isTextModelProvider(rawTextProvider) ? rawTextProvider : '';
  const textModelProvider = sourceTextProvider
    || (hasTextProvider ? defaultConfig.text_model_provider : config ? 'custom' : defaultConfig.text_model_provider);
  const textModelProfiles = normalizeTextModelProfiles(source.text_model_profiles);
  if (sourceTextProvider) {
    const fallbackProfile = textModelProfiles[textModelProvider]
      || defaultTextModelProfiles[textModelProvider];
    textModelProfiles[textModelProvider] = textProfileFromFlatConfig(source, fallbackProfile, textModelProvider);
  } else if (textModelProvider === 'custom' && !hasTextModelProfileData(textModelProfiles.custom)) {
    textModelProfiles.custom = textProfileFromUnknownProvider(source, rawTextProvider, textModelProfiles.custom);
  }
  const activeTextProfile = textModelProfiles[textModelProvider];
  const sourceImageModel = source.image_model && typeof source.image_model === 'object' ? source.image_model : {};
  const imageModelProvider = isImageModelProvider(sourceImageModel.provider) ? sourceImageModel.provider : defaultConfig.image_model.provider;
  const imageModelProfiles = normalizeImageModelProfiles(source.image_model_profiles);
  imageModelProfiles[imageModelProvider] = normalizeImageModelProfile(imageModelProvider, sourceImageModel);
  const activeImageProfile = imageModelProfiles[imageModelProvider];
  const hasGpuHardwareAccelerationEnabled = typeof source.gpu_hardware_acceleration_enabled === 'boolean';
  const hasGpuHardwareAccelerationConfigured = typeof source.gpu_hardware_acceleration_configured === 'boolean';
  const gpuHardwareAccelerationConfigured = hasGpuHardwareAccelerationConfigured
    ? source.gpu_hardware_acceleration_configured
    : defaultConfig.gpu_hardware_acceleration_configured;
  const gpuHardwareAccelerationEnabled = gpuHardwareAccelerationConfigured === false
    ? defaultConfig.gpu_hardware_acceleration_enabled
    : hasGpuHardwareAccelerationEnabled ? source.gpu_hardware_acceleration_enabled : defaultConfig.gpu_hardware_acceleration_enabled;

  return {
    ...defaultConfig,
    text_model_provider: textModelProvider,
    text_model_profiles: textModelProfiles,
    api_key: activeTextProfile.api_key,
    base_url: activeTextProfile.base_url,
    model_name: activeTextProfile.model_name,
    multimodal_enabled: activeTextProfile.multimodal_enabled,
    reasoning_effort: activeTextProfile.reasoning_effort,
    context_length_limit: activeTextProfile.context_length_limit,
    concurrency_limit: activeTextProfile.concurrency_limit,
    temperature_enabled: activeTextProfile.temperature_enabled,
    temperature: activeTextProfile.temperature,
    request_mode: activeTextProfile.request_mode,
    image_model: activeImageProfile,
    image_model_profiles: imageModelProfiles,
    components: normalizeComponentsConfig(source.components),
    update_channel: normalizeUpdateChannel(source.update_channel),
    gpu_hardware_acceleration_enabled: gpuHardwareAccelerationEnabled,
    gpu_hardware_acceleration_configured: gpuHardwareAccelerationConfigured === false ? true : gpuHardwareAccelerationConfigured,
    export_format: normalizeExportFormat(source.export_format),
    agent_auto_answer_enabled: source.agent_auto_answer_enabled === undefined
      ? defaultConfig.agent_auto_answer_enabled
      : Boolean(source.agent_auto_answer_enabled),
    developer_mode: source.developer_mode === undefined ? defaultConfig.developer_mode : Boolean(source.developer_mode),
    developer_token_stats_auto_open: source.developer_token_stats_auto_open === undefined ? defaultConfig.developer_token_stats_auto_open : Boolean(source.developer_token_stats_auto_open),
    developer_agent_monitor_auto_open: source.developer_agent_monitor_auto_open === undefined ? defaultConfig.developer_agent_monitor_auto_open : Boolean(source.developer_agent_monitor_auto_open),
    storage_cleanup_version: Number.isFinite(Number(source.storage_cleanup_version))
      ? Math.max(0, Math.floor(Number(source.storage_cleanup_version)))
      : defaultConfig.storage_cleanup_version,
    analytics_client_id: source.analytics_client_id || defaultConfig.analytics_client_id,
    analytics_created_at: source.analytics_created_at || defaultConfig.analytics_created_at,
  };
}

function createConfigStore(app) {
  const configFile = getConfigFilePath(app);

  function persist(config) {
    let tempFile = '';
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    try {
      tempFile = `${configFile}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(config, null, 2), 'utf-8');
      fs.renameSync(tempFile, configFile);
    } catch (error) {
      if (tempFile) {
        try { fs.rmSync(tempFile, { force: true }); } catch {}
      }
      throw error;
    }
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
          image_model_profiles: {
            ...currentConfig.image_model_profiles,
            ...(config && config.image_model_profiles ? config.image_model_profiles : {}),
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
