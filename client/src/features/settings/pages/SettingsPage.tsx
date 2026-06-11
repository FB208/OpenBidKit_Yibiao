import { useEffect, useState } from 'react';
import { trackConfigUsage } from '../../../shared/analytics/analytics';
import { FloatingToolbar, InputWithAction, useToast } from '../../../shared/ui';
import { showUpdateReadyToast } from '../../../shared/updateToast';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type { AiRequestMode, ClientConfig, FileParserProvider, ImageModelConfig, ImageModelProfiles, ImageModelProvider, ImageModelStatus, TextModelConfig, TextModelProfiles, TextModelProvider } from '../../../shared/types';
import type { SettingsPageState } from '../types';

type SettingsTab = 'general' | 'text-model' | 'image-model' | 'file-parser' | 'about';
type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'downloaded' | 'error' | 'disabled';

const settingsTabs: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: '通用' },
  { id: 'text-model', label: '文本模型' },
  { id: 'image-model', label: '生图模型' },
  { id: 'file-parser', label: '文件解析' },
  { id: 'about', label: '关于' },
];

const textModelProviders: Array<{ value: TextModelProvider; label: string }> = [
  { value: 'jinlong', label: '金龙中转站【推荐】' },
  { value: 'volcengine', label: '火山方舟' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'longcat', label: '龙猫' },
  { value: 'custom', label: '自定义' },
];

const aiRequestModeOptions: Array<{ value: AiRequestMode; label: string }> = [
  { value: 'normal', label: '普通请求' },
  { value: 'stream', label: '流式请求' },
];

const textProviderDefaults: TextModelProfiles = {
  jinlong: { api_key: '', base_url: 'https://jlaudeapi.com/v1', model_name: 'gpt-3.5-turbo', request_mode: 'stream' },
  volcengine: { api_key: '', base_url: 'https://ark.cn-beijing.volces.com/api/v3', model_name: '', request_mode: 'stream' },
  deepseek: { api_key: '', base_url: 'https://api.deepseek.com', model_name: '', request_mode: 'stream' },
  longcat: { api_key: '', base_url: 'https://api.longcat.chat/openai/v1', model_name: '', request_mode: 'stream' },
  custom: { api_key: '', base_url: '', model_name: '', request_mode: 'stream' },
};

const textProviderApiKeyUrls: Partial<Record<TextModelProvider, string>> = {
  jinlong: 'https://s.markup.com.cn/jl',
  volcengine: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  deepseek: 'https://platform.deepseek.com/api_keys',
  longcat: 'https://longcat.chat/platform/api_keys',
};

function createDefaultTextModelProfiles(): TextModelProfiles {
  return textModelProviders.reduce((profiles, provider) => ({
    ...profiles,
    [provider.value]: { ...textProviderDefaults[provider.value] },
  }), {} as TextModelProfiles);
}

function normalizeAiRequestMode(value?: AiRequestMode): AiRequestMode {
  return value === 'normal' ? 'normal' : 'stream';
}

function normalizeTextModelProfile(provider: TextModelProvider, profile?: Partial<TextModelConfig>): TextModelConfig {
  const defaults = textProviderDefaults[provider];
  const baseUrl = provider === 'custom' ? profile?.base_url ?? defaults.base_url : defaults.base_url;
  return {
    api_key: profile?.api_key ?? defaults.api_key,
    base_url: baseUrl,
    model_name: profile?.model_name ?? defaults.model_name,
    request_mode: normalizeAiRequestMode(profile?.request_mode ?? defaults.request_mode),
  };
}

function normalizeTextModelProfiles(profiles?: Partial<TextModelProfiles>): TextModelProfiles {
  return textModelProviders.reduce((nextProfiles, provider) => ({
    ...nextProfiles,
    [provider.value]: normalizeTextModelProfile(provider.value, profiles?.[provider.value]),
  }), {} as TextModelProfiles);
}

function textProfileFromState(textModel: SettingsPageState['textModel']): TextModelConfig {
  return {
    api_key: textModel.api_key,
    base_url: textModel.provider === 'custom' ? textModel.base_url : textProviderDefaults[textModel.provider].base_url,
    model_name: textModel.model_name,
    request_mode: textModel.request_mode,
  };
}

const imageProviders: Array<{ value: ImageModelProvider; label: string }> = [
  { value: 'jinlong', label: '金龙中转站【推荐】' },
  { value: 'volcengine', label: '火山方舟' },
  { value: 'google-ai-studio', label: 'Google AI Studio' },
  { value: 'custom', label: '自定义 OpenAI-like' },
];

const imageProviderDefaults: ImageModelProfiles = {
  jinlong: {
    provider: 'jinlong',
    base_url: 'https://jlaudeapi.com/v1',
    api_key: '',
    model_name: '',
    request_mode: 'stream',
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  volcengine: {
    provider: 'volcengine',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    api_key: '',
    model_name: '',
    request_mode: 'stream',
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  'google-ai-studio': {
    provider: 'google-ai-studio',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    api_key: '',
    model_name: 'gemini-3.1-flash-image-preview',
    request_mode: 'stream',
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  custom: {
    provider: 'custom',
    base_url: '',
    api_key: '',
    model_name: '',
    request_mode: 'stream',
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
};

const imageProviderApiKeyUrls: Record<ImageModelProvider, string> = {
  jinlong: 'https://s.markup.com.cn/jl',
  volcengine: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  'google-ai-studio': 'https://aistudio.google.com/api-keys',
  custom: '',
};

const imageProviderLabels: Record<ImageModelProvider, string> = {
  jinlong: '金龙中转站',
  volcengine: '火山方舟',
  'google-ai-studio': 'Google AI Studio',
  custom: '自定义生图服务',
};

function getImageBaseUrlDescription(provider: ImageModelProvider) {
  if (provider === 'jinlong') return '金龙中转站 OpenAI 兼容接口地址';
  if (provider === 'volcengine') return '火山方舟 OpenAI 兼容接口地址';
  if (provider === 'custom') return '填写兼容 OpenAI /images/generations 的接口地址';
  return 'Google Gemini API REST 地址';
}

function getImageApiKeyDescription(provider: ImageModelProvider) {
  if (provider === 'jinlong') return '用于调用金龙中转站图片生成 API';
  if (provider === 'volcengine') return '用于调用火山方舟图片生成 API';
  if (provider === 'custom') return '用于调用自定义 OpenAI-like 生图接口';
  return '用于调用 Google AI Studio Gemini API';
}

function getImageModelDescription(provider: ImageModelProvider) {
  if (provider === 'jinlong') return '填写金龙中转站已开通的生图模型名称';
  if (provider === 'volcengine') return '填写火山方舟控制台中已开通的模型或推理接入点 ID';
  if (provider === 'custom') return '填写自定义接口支持的生图模型名称';
  return '选择或填写支持图片生成的 Gemini 模型';
}

function getImageModelPlaceholder(provider: ImageModelProvider) {
  if (provider === 'jinlong') return '请输入已开通的生图模型名称';
  if (provider === 'volcengine') return '请输入已开通的模型或推理接入点 ID';
  if (provider === 'custom') return '请输入 OpenAI-like 生图模型名称';
  return 'gemini-3.1-flash-image-preview';
}

function createDefaultImageModelProfiles(): ImageModelProfiles {
  return imageProviders.reduce((profiles, provider) => ({
    ...profiles,
    [provider.value]: { ...imageProviderDefaults[provider.value] },
  }), {} as ImageModelProfiles);
}

function normalizeImageModelProfile(provider: ImageModelProvider, profile?: Partial<ImageModelConfig>): ImageModelConfig {
  const defaults = imageProviderDefaults[provider];
  return {
    provider,
    base_url: provider === 'custom' ? profile?.base_url ?? defaults.base_url : defaults.base_url,
    api_key: profile?.api_key ?? defaults.api_key,
    model_name: profile?.model_name ?? defaults.model_name,
    request_mode: normalizeAiRequestMode(profile?.request_mode ?? defaults.request_mode),
    status: profile?.status ?? defaults.status,
    tested_at: profile?.tested_at ?? defaults.tested_at,
    last_error: profile?.last_error ?? defaults.last_error,
  };
}

function normalizeImageModelProfiles(profiles?: Partial<ImageModelProfiles>): ImageModelProfiles {
  return imageProviders.reduce((nextProfiles, provider) => ({
    ...nextProfiles,
    [provider.value]: normalizeImageModelProfile(provider.value, profiles?.[provider.value]),
  }), {} as ImageModelProfiles);
}

function imageProfileFromState(imageModel: ImageModelConfig): ImageModelConfig {
  return {
    provider: imageModel.provider,
    base_url: imageModel.provider === 'custom' ? imageModel.base_url || '' : imageProviderDefaults[imageModel.provider].base_url,
    api_key: imageModel.api_key,
    model_name: imageModel.model_name,
    request_mode: imageModel.request_mode,
    status: imageModel.status || 'untested',
    tested_at: imageModel.tested_at || '',
    last_error: imageModel.last_error || '',
  };
}

const imageStatusMeta: Record<ImageModelStatus, { label: string; description: string }> = {
  untested: {
    label: '未测试',
    description: '请点击测试确认当前生图模型可用，正文生成时只有可用状态才会自动配图。',
  },
  available: {
    label: '可用',
    description: '当前生图模型已通过测试，正文生成时会按内容需要自动配图。',
  },
  unavailable: {
    label: '不可用',
    description: '当前生图模型测试失败，正文生成会跳过配图。',
  },
};

function resetImageModelStatus(imageModel: ImageModelConfig): ImageModelConfig {
  return {
    ...imageModel,
    status: 'untested',
    tested_at: '',
    last_error: '',
  };
}

function formatImageTestTime(value?: string) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleString('zh-CN', { hour12: false });
}

const fileParserProviders: Array<{ value: FileParserProvider; label: string }> = [
  { value: 'local', label: '本地解析' },
  { value: 'mineru-accurate-api', label: 'MinerU-精准解析 API' },
  { value: 'mineru-agent-api', label: 'MinerU-Agent 轻量解析 API' },
];

const parserOptions = [
  {
    title: '本地解析',
    badge: '推荐默认',
    tone: 'primary',
    summary: '覆盖大多数 Word 和带文字层 PDF，速度快、无调用限制。',
    items: [
      ['Token', '无需'],
      ['解析速度', '快'],
      ['支持格式', 'pdf、jpeg、png、docx、doc、wps、ofd'],
      ['大小/页数', '无限制'],
      ['解析质量', '高'],
      ['扫描件', '不支持'],
    ],
  },
  {
    title: 'MinerU 精准解析 API',
    badge: '扫描件兜底',
    tone: 'accent',
    summary: '解析质量高，适合本地解析失败或扫描件质量要求高的文档。',
    items: [
      ['Token', '需要'],
      ['解析速度', '慢'],
      ['支持格式', 'pdf、jpeg、png、docx'],
      ['大小/页数', '≤ 200MB / ≤ 200 页'],
      ['解析质量', '高'],
      ['扫描件', '支持'],
    ],
  },
  {
    title: 'MinerU-Agent 轻量解析 API',
    badge: '轻量备用',
    tone: 'muted',
    summary: '无需 Token 但存在 IP 限频，适合轻量文档的备用解析。',
    items: [
      ['Token', '无需（IP 限频）'],
      ['解析速度', '中等'],
      ['支持格式', 'pdf、jpeg、png、docx'],
      ['大小/页数', '≤ 10MB / ≤ 20 页'],
      ['解析质量', '中'],
      ['扫描件', '质量差'],
    ],
  },
];

const initialState: SettingsPageState = {
  textModel: {
    provider: 'jinlong',
    ...textProviderDefaults.jinlong,
  },
  textModelProfiles: createDefaultTextModelProfiles(),
  imageModel: {
    ...imageProviderDefaults.jinlong,
  },
  imageModelProfiles: createDefaultImageModelProfiles(),
  fileParser: {
    provider: 'local',
    mineru_token: '',
  },
  general: {
    developer_mode: false,
  },
};

interface SettingsPageProps {
  onDeveloperModeChange?: (developerMode: boolean) => void;
}

function SettingsPage({ onDeveloperModeChange }: SettingsPageProps) {
  const [state, setState] = useState<SettingsPageState>(initialState);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [savedConfig, setSavedConfig] = useState<ClientConfig | null>(null);
  const [textModels, setTextModels] = useState<string[]>([]);
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState<'text' | 'image' | null>(null);
  const [testingTextModel, setTestingTextModel] = useState(false);
  const [testingImageModel, setTestingImageModel] = useState(false);
  const [imageTestPreview, setImageTestPreview] = useState<{ src: string; title: string } | null>(null);
  const [appVersion, setAppVersion] = useState('');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
  const [updatePercent, setUpdatePercent] = useState(0);
  const [updateVersion, setUpdateVersion] = useState('');
  const [updateError, setUpdateError] = useState('');
  const { showToast } = useToast();

  useEffect(() => {
    void loadTextConfig();
    void window.yibiao?.getVersion().then(setAppVersion);

    const unsubs: Array<() => void> = [];
    unsubs.push(
      window.yibiao?.onUpdateProgress(({ percent }) => {
        setUpdateStatus('downloading');
        setUpdatePercent(Math.round(percent));
      }) ?? (() => {})
    );
    unsubs.push(
      window.yibiao?.onUpdateDownloaded(({ version }) => {
        if (version) {
          setUpdateVersion(version);
        }
        setUpdateStatus('downloaded');
      }) ?? (() => {})
    );
    unsubs.push(
      window.yibiao?.onUpdateError(({ message }) => {
        setUpdateStatus('error');
        setUpdateError(message);
      }) ?? (() => {})
    );

    return () => { unsubs.forEach((unsub) => unsub()); };
  }, []);

  const loadTextConfig = async () => {
    try {
      const config = await window.yibiao?.config.load();
      if (!config) {
        return;
      }

      const textModelProfiles = normalizeTextModelProfiles(config.text_model_profiles);
      const activeTextProfile = normalizeTextModelProfile(config.text_model_provider, textModelProfiles[config.text_model_provider]);
      const imageModelProfiles = normalizeImageModelProfiles(config.image_model_profiles);
      const activeImageProfile = normalizeImageModelProfile(config.image_model.provider, config.image_model);
      imageModelProfiles[activeImageProfile.provider] = activeImageProfile;

      setState((prev) => ({
        ...prev,
        textModel: {
          provider: config.text_model_provider,
          ...activeTextProfile,
        },
        textModelProfiles,
        imageModel: activeImageProfile,
        imageModelProfiles,
        fileParser: {
          provider: config.file_parser.provider,
          mineru_token: config.file_parser.mineru_token || '',
        },
        general: {
          developer_mode: Boolean(config.developer_mode),
        },
      }));
      setSavedConfig(config);
      onDeveloperModeChange?.(Boolean(config.developer_mode));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '加载客户端配置失败';
      showToast(errorMessage, 'error');
    }
  };

  const getCurrentTextModelProfiles = (): TextModelProfiles => ({
    ...state.textModelProfiles,
    [state.textModel.provider]: textProfileFromState(state.textModel),
  });

  const getCurrentImageModelProfiles = (): ImageModelProfiles => ({
    ...state.imageModelProfiles,
    [state.imageModel.provider]: imageProfileFromState(state.imageModel),
  });

  const createClientConfig = (): ClientConfig => {
    const textModelProfiles = getCurrentTextModelProfiles();
    const activeTextProfile = textModelProfiles[state.textModel.provider];
    const imageModelProfiles = getCurrentImageModelProfiles();
    const activeImageProfile = imageModelProfiles[state.imageModel.provider];

    return {
      text_model_provider: state.textModel.provider,
      text_model_profiles: textModelProfiles,
      api_key: activeTextProfile.api_key,
      base_url: activeTextProfile.base_url,
      model_name: activeTextProfile.model_name,
      request_mode: activeTextProfile.request_mode,
      image_model: activeImageProfile,
      image_model_profiles: imageModelProfiles,
      file_parser: {
        provider: state.fileParser.provider,
        mineru_token: state.fileParser.mineru_token || '',
      },
      developer_mode: state.general.developer_mode,
    };
  };

  const checkForUpdates = async () => {
    if (updateStatus === 'checking' || updateStatus === 'downloading') {
      return;
    }

    try {
      setUpdateStatus('checking');
      setUpdatePercent(0);
      setUpdateError('');
      const result = await window.yibiao?.checkUpdate();
      if (!result?.enabled) {
        setUpdateStatus('disabled');
        showToast('开发调试模式不执行自动更新', 'info');
        return;
      }
      if (result.failed) {
        const message = result.message || '检查更新失败';
        setUpdateStatus('error');
        setUpdateError(message);
        showToast(message, 'error');
        return;
      }
      if (!result.updateAvailable) {
        setUpdateStatus('idle');
        showToast('已是最新版本', 'success');
        return;
      }

      const version = result.version || updateVersion;
      setUpdateVersion(version);
      if (result.downloaded) {
        setUpdateStatus('downloaded');
        showUpdateReadyToast(showToast, version);
        return;
      }

      setUpdateStatus('idle');
      showToast('发现新版本，但更新包尚未下载完成，请稍后重试', 'info');
    } catch (error) {
      const message = error instanceof Error ? error.message : '检查更新失败';
      setUpdateStatus('error');
      setUpdateError(message);
      showToast(message, 'error');
    }
  };

  const updateImageModelConfig = (partial: Partial<Omit<ImageModelConfig, 'provider'>>, options: { clearModels?: boolean } = {}) => {
    if (options.clearModels) {
      setImageModels([]);
    }

    setState((prev) => ({
      ...prev,
      ...(() => {
        const imageModel = resetImageModelStatus({ ...prev.imageModel, ...partial });
        return {
          imageModel,
          imageModelProfiles: {
            ...prev.imageModelProfiles,
            [prev.imageModel.provider]: imageProfileFromState(imageModel),
          },
        };
      })(),
    }));
  };

  const updateImageModelProvider = (provider: ImageModelProvider) => {
    setImageModels([]);
    setImageTestPreview(null);
    setState((prev) => ({
      ...prev,
      imageModelProfiles: {
        ...prev.imageModelProfiles,
        [prev.imageModel.provider]: imageProfileFromState(prev.imageModel),
      },
      imageModel: normalizeImageModelProfile(provider, prev.imageModelProfiles[provider]),
    }));
  };

  const saveClientConfig = async (config: ClientConfig) => {
    try {
      const result = await window.yibiao?.config.save(config);
      showToast(result?.success ? '配置已保存' : result?.message || '配置保存失败', result?.success ? 'success' : 'error');
      if (result?.success) {
        setSavedConfig(config);
        onDeveloperModeChange?.(Boolean(config.developer_mode));
        trackConfigUsage({}, config);
      }
      return Boolean(result?.success);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '配置保存失败';
      showToast(errorMessage, 'error');
      return false;
    }
  };

  const saveTextConfig = async () => {
    await saveClientConfig(createClientConfig());
  };

  const updateDeveloperMode = (developerMode: boolean) => {
    setState((prev) => ({
      ...prev,
      general: { ...prev.general, developer_mode: developerMode },
    }));
    onDeveloperModeChange?.(developerMode);
  };

  const updateTextModelProvider = (provider: TextModelProvider) => {
    setTextModels([]);
    setState((prev) => ({
      ...prev,
      textModelProfiles: {
        ...prev.textModelProfiles,
        [prev.textModel.provider]: textProfileFromState(prev.textModel),
      },
      textModel: {
        provider,
        ...normalizeTextModelProfile(provider, prev.textModelProfiles[provider]),
      },
    }));
  };

  const updateTextModelConfig = (partial: Partial<TextModelConfig>, options: { clearModels?: boolean } = {}) => {
    if (options.clearModels) {
      setTextModels([]);
    }

    setState((prev) => ({
      ...prev,
      ...(() => {
        const textModel = { ...prev.textModel, ...partial };
        return {
          textModel,
          textModelProfiles: {
            ...prev.textModelProfiles,
            [prev.textModel.provider]: textProfileFromState(textModel),
          },
        };
      })(),
    }));
  };

  const openTextProviderApiKeyPage = async () => {
    const url = textProviderApiKeyUrls[state.textModel.provider];
    if (!url) {
      showToast('自定义服务商没有预置 API Key 获取页面', 'info');
      return;
    }

    try {
      const result = await window.yibiao?.openExternal(url);
      if (result && !result.success) {
        showToast(result.message || '打开 API Key 获取页面失败', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开 API Key 获取页面失败', 'error');
    }
  };

  const openImageProviderApiKeyPage = async () => {
    const url = imageProviderApiKeyUrls[state.imageModel.provider];
    if (!url) {
      showToast('自定义生图服务没有预置 API Key 获取页面', 'info');
      return;
    }

    try {
      const result = await window.yibiao?.openExternal(url);
      if (result && !result.success) {
        showToast(result.message || '打开生图服务 API Key 获取页面失败', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开生图服务 API Key 获取页面失败', 'error');
    }
  };

  const testTextConfig = async () => {
    try {
      setTestingTextModel(true);
      const config = createClientConfig();
      const result = await window.yibiao?.config.save(config);
      if (result?.success) {
        setSavedConfig(config);
      }
      const content = await window.yibiao?.ai.chat({
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        timeout_ms: 30000,
        timeout_message: '文本模型测试超时，请检查 Base URL、API Key 或模型名称',
        logTitle: '文本模型测试',
      });
      const reply = (content || '').trim();
      showToast(reply ? `测试成功：${reply.slice(0, 160)}` : '测试成功', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '测试失败', 'error');
    } finally {
      setTestingTextModel(false);
    }
  };

  const saveImageConfig = async () => {
    await saveClientConfig(createClientConfig());
  };

  const testImageConfig = async () => {
    try {
      setTestingImageModel(true);
      const config = createClientConfig();
      const result = await window.yibiao?.ai.testImageModel(config);
      if (!result?.success) {
        throw new Error(result?.message || '生图模型测试失败');
      }
      const testedImageModel: ImageModelConfig = {
        ...config.image_model,
        status: 'available',
        tested_at: new Date().toISOString(),
        last_error: '',
      };
      const testedConfig: ClientConfig = {
        ...config,
        image_model: testedImageModel,
        image_model_profiles: {
          ...config.image_model_profiles,
          [testedImageModel.provider]: testedImageModel,
        },
      };
      await window.yibiao?.config.save(testedConfig);
      setState((prev) => ({
        ...prev,
        imageModel: testedConfig.image_model,
        imageModelProfiles: {
          ...prev.imageModelProfiles,
          [testedConfig.image_model.provider]: imageProfileFromState(testedConfig.image_model),
        },
      }));
      setSavedConfig(testedConfig);
      trackConfigUsage({}, testedConfig);
      const previewSrc = result?.image_url || (result?.image_data ? `data:${result.mime_type || 'image/png'};base64,${result.image_data}` : '');

      if (previewSrc) {
        setImageTestPreview({ src: previewSrc, title: `${imageProviderLabels[state.imageModel.provider]} 测试图片` });
      }

      showToast(result?.message || '生图模型测试成功', result?.success ? 'success' : 'error');
    } catch (error) {
      const message = error instanceof Error ? error.message : '生图模型测试失败';
      const config = createClientConfig();
      const failedImageModel: ImageModelConfig = {
        ...config.image_model,
        status: 'unavailable',
        tested_at: new Date().toISOString(),
        last_error: message,
      };
      const failedConfig: ClientConfig = {
        ...config,
        image_model: failedImageModel,
        image_model_profiles: {
          ...config.image_model_profiles,
          [failedImageModel.provider]: failedImageModel,
        },
      };
      await window.yibiao?.config.save(failedConfig).catch(() => undefined);
      setState((prev) => ({
        ...prev,
        imageModel: failedConfig.image_model,
        imageModelProfiles: {
          ...prev.imageModelProfiles,
          [failedConfig.image_model.provider]: imageProfileFromState(failedConfig.image_model),
        },
      }));
      setSavedConfig(failedConfig);
      trackConfigUsage({}, failedConfig);
      showToast(message, 'error');
    } finally {
      setTestingImageModel(false);
    }
  };

  const saveFileParserConfig = async () => {
    await saveClientConfig(createClientConfig());
  };

  const openConfigFolder = async () => {
    try {
      await window.yibiao?.config.openConfigFolder();
      showToast('已打开配置文件夹', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开配置文件夹失败', 'error');
    }
  };

  const fetchTextModels = async () => {
    try {
      setLoadingModels('text');
      const result = await window.yibiao?.config.listModels(createClientConfig());
      const models = result?.models || [];
      setTextModels(models);
      if (result?.success && models.length > 0) {
        setState((prev) => ({
          ...prev,
          ...(() => {
            const textModel = models.includes(prev.textModel.model_name)
              ? prev.textModel
              : { ...prev.textModel, model_name: models[0] };
            return {
              textModel,
              textModelProfiles: {
                ...prev.textModelProfiles,
                [prev.textModel.provider]: textProfileFromState(textModel),
              },
            };
          })(),
        }));
      }
      showToast(result?.message || `获取到 ${result?.models.length || 0} 个文本模型`, result?.success ? 'success' : 'info');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '获取文本模型失败', 'error');
    } finally {
      setLoadingModels(null);
    }
  };

  const fetchImageModels = async () => {
    try {
      setLoadingModels('image');
      if (state.imageModel.provider === 'jinlong' || state.imageModel.provider === 'custom') {
        const providerLabel = imageProviderLabels[state.imageModel.provider];
        const baseUrl = state.imageModel.provider === 'custom'
          ? state.imageModel.base_url || ''
          : state.imageModel.base_url || imageProviderDefaults[state.imageModel.provider].base_url || '';

        if (!state.imageModel.api_key.trim()) {
          setImageModels([]);
          showToast(`请先填写${providerLabel} API Key`, 'info');
          return;
        }

        if (!baseUrl.trim()) {
          setImageModels([]);
          showToast(`请先填写${providerLabel} Base URL`, 'info');
          return;
        }

        const config = createClientConfig();
        const result = await window.yibiao?.config.listModels({
          ...config,
          api_key: state.imageModel.api_key,
          base_url: baseUrl,
          model_name: state.imageModel.model_name,
        });
        const models = result?.models || [];
        setImageModels(models);
        if (result?.success && models.length > 0) {
          setState((prev) => ({
            ...prev,
            ...(() => {
              const imageModel = models.includes(prev.imageModel.model_name)
                ? prev.imageModel
                : resetImageModelStatus({ ...prev.imageModel, model_name: models[0] });
              return {
                imageModel,
                imageModelProfiles: {
                  ...prev.imageModelProfiles,
                  [prev.imageModel.provider]: imageProfileFromState(imageModel),
                },
              };
            })(),
          }));
        }
        showToast(result?.message || `获取到 ${models.length} 个${providerLabel}模型`, result?.success ? 'success' : 'info');
        return;
      }

      if (state.imageModel.provider === 'volcengine') {
        setImageModels([]);
        showToast('火山方舟请填写控制台中已开通的模型或推理接入点 ID。');
        return;
      }

      if (state.imageModel.provider === 'google-ai-studio') {
        const models = [
          'gemini-3.1-flash-image-preview',
          'gemini-3-pro-image-preview',
          'gemini-2.5-flash-image',
        ];
        setImageModels(models);
        setState((prev) => ({
          ...prev,
          ...(() => {
            const imageModel = models.includes(prev.imageModel.model_name)
              ? prev.imageModel
              : resetImageModelStatus({ ...prev.imageModel, model_name: models[0] });
            return {
              imageModel,
              imageModelProfiles: {
                ...prev.imageModelProfiles,
                [prev.imageModel.provider]: imageProfileFromState(imageModel),
              },
            };
          })(),
        }));
        showToast('已载入 Google AI Studio 生图模型', 'success');
        return;
      }

      setImageModels([]);
      showToast('该服务商模型列表接口暂未接入。');
    } finally {
      setLoadingModels(null);
    }
  };

  const isActiveTabDirty = () => {
    if (!savedConfig) {
      return false;
    }

    if (activeTab === 'text-model') {
      return JSON.stringify({
        provider: state.textModel.provider,
        profiles: getCurrentTextModelProfiles(),
      }) !== JSON.stringify({
        provider: savedConfig.text_model_provider,
        profiles: normalizeTextModelProfiles(savedConfig.text_model_profiles),
      });
    }

    if (activeTab === 'general') {
      return Boolean(state.general.developer_mode) !== Boolean(savedConfig.developer_mode);
    }

    if (activeTab === 'image-model') {
      return JSON.stringify({
        provider: state.imageModel.provider,
        profiles: getCurrentImageModelProfiles(),
      }) !== JSON.stringify({
        provider: savedConfig.image_model.provider,
        profiles: normalizeImageModelProfiles(savedConfig.image_model_profiles),
      });
    }

    if (activeTab === 'file-parser') {
      return JSON.stringify(state.fileParser) !== JSON.stringify(savedConfig.file_parser);
    }

    return false;
  };

  const saveActiveTabConfig = async () => {
    if (activeTab === 'general') {
      await saveClientConfig(createClientConfig());
      return;
    }
    if (activeTab === 'text-model') {
      await saveTextConfig();
      return;
    }
    if (activeTab === 'image-model') {
      await saveImageConfig();
      return;
    }
    if (activeTab === 'file-parser') {
      await saveFileParserConfig();
    }
  };

  const canSaveActiveTab = activeTab === 'general' || activeTab === 'text-model' || activeTab === 'image-model' || activeTab === 'file-parser';
  const activeTabDirty = isActiveTabDirty();
  const currentTextProviderDefault = textProviderDefaults[state.textModel.provider];
  const imageModelStatus: ImageModelStatus = state.imageModel.status || 'untested';
  const currentImageStatus = imageStatusMeta[imageModelStatus];
  const imageTestTime = formatImageTestTime(state.imageModel.tested_at);
  const settingsToolbarGroups: FloatingToolbarGroup[] = canSaveActiveTab
    ? [
        {
          id: 'settings-save-state',
          actions: [
            {
              id: 'save-state',
              label: activeTabDirty ? '未保存' : '已保存',
              variant: 'ghost',
              disabled: true,
              onClick: () => undefined,
            },
          ],
        },
        {
          id: 'settings-save-action',
          actions: [
            {
              id: 'save',
              label: '保存',
              variant: 'primary',
              disabled: !activeTabDirty,
              tooltip: activeTabDirty ? '保存当前设置' : '当前设置已保存',
              onClick: saveActiveTabConfig,
            },
          ],
        },
      ]
    : [];

  const updateBusy = updateStatus === 'checking' || updateStatus === 'downloading';
  const updateStatusText = (() => {
    if (updateStatus === 'checking') return '正在检查更新...';
    if (updateStatus === 'downloading') return `正在下载 ${updatePercent}%`;
    if (updateStatus === 'downloaded') return updateVersion ? `新版本 ${updateVersion} 已准备好` : '更新已准备好';
    if (updateStatus === 'error') return `更新失败：${updateError || '未知错误'}`;
    if (updateStatus === 'disabled') return '开发调试模式不执行自动更新';
    return '启动后自动检查，每 30 分钟轮询';
  })();

  return (
    <div className="settings-page">
      <div className="settings-page-scroll">
        <div className="settings-tab-shell" role="tablist" aria-label="设置分类">
          {settingsTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`settings-tab ${activeTab === tab.id ? 'is-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              role="tab"
              aria-selected={activeTab === tab.id}
            >
              {tab.label}
            </button>
          ))}
        </div>

      {activeTab === 'general' && (
        <section className="settings-page-section">
          <div className="settings-section-title">
            <span />
            <strong>通用</strong>
          </div>
          <div className="settings-list">
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>显示语言</strong>
                <span>选择界面的显示语言</span>
              </div>
              <select value="zh-CN" disabled>
                <option value="zh-CN">简体中文</option>
              </select>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>应用主题</strong>
                <span>切换深色或浅色模式</span>
              </div>
              <select value="system" disabled>
                <option value="system">跟随系统</option>
              </select>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>侧边栏布局</strong>
                <span>保持当前经典布局，后续可扩展为紧凑布局</span>
              </div>
              <select value="classic" disabled>
                <option value="classic">经典布局</option>
              </select>
            </div>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>开发者模式</strong>
                <span>会打乱既有工作流，生成大量日志占用磁盘空间，<strong>非专业人士请勿开启</strong></span>
              </div>
              <span className="settings-switch-control">
                <input
                  type="checkbox"
                  checked={state.general.developer_mode}
                  onChange={(event) => updateDeveloperMode(event.target.checked)}
                />
                <span className="settings-switch-track" aria-hidden="true">
                  <span className="settings-switch-thumb" />
                </span>
              </span>
            </label>
            {state.general.developer_mode && (
              <div className="settings-row">
                <div className="settings-row-copy">
                  <strong>配置文件夹</strong>
                  <span>打开本机配置、工作区缓存和开发者日志所在目录</span>
                </div>
                <div className="settings-action-cell">
                  <button type="button" className="inline-action" onClick={openConfigFolder}>
                    打开配置文件夹
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {activeTab === 'text-model' && (
        <section className="settings-page-section">
          <div className="settings-section-title">
            <span />
            <strong>文本模型配置</strong>
          </div>
          <div className="settings-list">
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>服务提供商</strong>
                <span>选择服务商会自动使用预置 Base URL；只有自定义服务商允许修改</span>
              </div>
              <select
                value={state.textModel.provider}
                onChange={(event) => updateTextModelProvider(event.target.value as TextModelProvider)}
              >
                {textModelProviders.map((provider) => (
                  <option value={provider.value} key={provider.value}>{provider.label}</option>
                ))}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>Base URL</strong>
                <span>OpenAI Like 接口地址，用于文本生成和分析任务</span>
              </div>
              <input
                type="text"
                value={state.textModel.base_url}
                placeholder={currentTextProviderDefault.base_url || '例如 https://api.openai.com/v1'}
                onChange={(event) => updateTextModelConfig({ base_url: event.target.value }, { clearModels: true })}
                disabled={state.textModel.provider !== 'custom'}
              />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>API Key</strong>
                <span>仅保存在本机配置文件中，不暴露给 Renderer 以外的原始能力</span>
              </div>
              <InputWithAction
                type="password"
                value={state.textModel.api_key}
                placeholder="请输入文本模型 API Key"
                onChange={(event) => updateTextModelConfig({ api_key: event.target.value }, { clearModels: true })}
                actionLabel="获取"
                actionTitle="打开当前服务商的 API Key 获取页面"
                actionDisabled={!textProviderApiKeyUrls[state.textModel.provider]}
                onAction={() => { void openTextProviderApiKeyPage(); }}
              />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>模型名称</strong>
                <span>可手动录入，也可从当前 Base URL 拉取可用模型</span>
              </div>
              <div className="settings-control-with-action">
                {textModels.length > 0 ? (
                  <select
                    value={state.textModel.model_name}
                    onChange={(event) => updateTextModelConfig({ model_name: event.target.value })}
                  >
                    {textModels.map((model) => <option value={model} key={model}>{model}</option>)}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={state.textModel.model_name}
                    placeholder="例如 deepseek-chat"
                    onChange={(event) => updateTextModelConfig({ model_name: event.target.value })}
                  />
                )}
                <button
                  type="button"
                  className="inline-action"
                  onClick={fetchTextModels}
                  disabled={loadingModels === 'text'}
                >
                  {loadingModels === 'text' && <span className="inline-spinner" aria-hidden="true" />}
                  {loadingModels === 'text' ? '获取中' : '获取'}
                </button>
                <button type="button" className="inline-action" onClick={testTextConfig} disabled={testingTextModel}>
                  {testingTextModel && <span className="inline-spinner" aria-hidden="true" />}
                  {testingTextModel ? '测试中' : '测试'}
                </button>
              </div>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>请求方式</strong>
                <span>流式请求只影响后端调用方式，应用仍等待完整结果后继续流程</span>
              </div>
              <select
                value={state.textModel.request_mode}
                onChange={(event) => updateTextModelConfig({ request_mode: event.target.value as AiRequestMode })}
              >
                {aiRequestModeOptions.map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
        </section>
      )}

      {activeTab === 'image-model' && (
        <section className="settings-page-section">
          <div className="settings-section-title">
            <span />
            <strong>生图模型配置</strong>
          </div>
          <div className={`image-model-status is-${imageModelStatus}`}>
            <div>
              <strong>接口状态：{currentImageStatus.label}</strong>
              <span>{currentImageStatus.description}</span>
              {imageTestTime && <small>最近测试：{imageTestTime}</small>}
              {imageModelStatus === 'unavailable' && state.imageModel.last_error && <small>失败原因：{state.imageModel.last_error}</small>}
            </div>
            <em>{currentImageStatus.label}</em>
          </div>
          <div className="settings-list">
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>服务提供商</strong>
                <span>各家生图接口不统一，先选择服务商再配置模型</span>
              </div>
              <select
                value={state.imageModel.provider}
                onChange={(event) => {
                  const provider = event.target.value as ImageModelProvider;
                  updateImageModelProvider(provider);
                }}
              >
                {imageProviders.map((provider) => (
                  <option value={provider.value} key={provider.value}>{provider.label}</option>
                ))}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>Base URL</strong>
                <span>{getImageBaseUrlDescription(state.imageModel.provider)}</span>
              </div>
              <input
                type="text"
                value={state.imageModel.base_url || ''}
                placeholder={state.imageModel.provider === 'custom' ? 'https://api.example.com/v1' : imageProviderDefaults[state.imageModel.provider].base_url}
                onChange={(event) => updateImageModelConfig({ base_url: event.target.value }, { clearModels: true })}
                disabled={state.imageModel.provider !== 'custom'}
              />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>API Key</strong>
                <span>{getImageApiKeyDescription(state.imageModel.provider)}</span>
              </div>
              <InputWithAction
                type="password"
                value={state.imageModel.api_key}
                placeholder="请输入生图服务 API Key"
                onChange={(event) => updateImageModelConfig({ api_key: event.target.value }, { clearModels: true })}
                actionLabel="获取"
                actionTitle="打开当前生图服务商的 API Key 获取页面"
                onAction={() => { void openImageProviderApiKeyPage(); }}
              />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>模型名称</strong>
                <span>{getImageModelDescription(state.imageModel.provider)}</span>
              </div>
              <div className="settings-control-with-action">
                {imageModels.length > 0 ? (
                  <select
                    value={state.imageModel.model_name}
                    onChange={(event) => updateImageModelConfig({ model_name: event.target.value })}
                  >
                    {imageModels.map((model) => <option value={model} key={model}>{model}</option>)}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={state.imageModel.model_name}
                    placeholder={getImageModelPlaceholder(state.imageModel.provider)}
                    onChange={(event) => updateImageModelConfig({ model_name: event.target.value })}
                  />
                )}
                <button
                  type="button"
                  className="inline-action"
                  onClick={fetchImageModels}
                  disabled={loadingModels === 'image'}
                >
                  {loadingModels === 'image' && <span className="inline-spinner" aria-hidden="true" />}
                  {loadingModels === 'image' ? '获取中' : '获取'}
                </button>
                <button type="button" className="inline-action" onClick={testImageConfig} disabled={testingImageModel}>
                  {testingImageModel && <span className="inline-spinner" aria-hidden="true" />}
                  {testingImageModel ? '测试中' : '测试'}
                </button>
              </div>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>请求方式</strong>
                <span>流式请求只影响后端调用方式，应用仍等待完整图片生成后继续流程</span>
              </div>
              <select
                value={state.imageModel.request_mode}
                onChange={(event) => updateImageModelConfig({ request_mode: event.target.value as AiRequestMode })}
              >
                {aiRequestModeOptions.map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
          {imageTestPreview && (
            <div className="image-test-preview">
              <div>
                <strong>{imageTestPreview.title}</strong>
                <span>用于确认当前生图配置可用</span>
              </div>
              <img src={imageTestPreview.src} alt="生图模型测试结果" />
            </div>
          )}
        </section>
      )}

      {activeTab === 'file-parser' && (
        <section className="settings-page-section">
          <div className="settings-section-title">
            <span />
            <strong>文件解析配置</strong>
          </div>
          <div className="settings-list">
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>文件解析方式</strong>
                <span>优先使用本地解析，复杂扫描件可尝试 MinerU 精准解析 API</span>
              </div>
              <select
                value={state.fileParser.provider}
                onChange={(event) => setState((prev) => ({
                ...prev,
                fileParser: { ...prev.fileParser, provider: event.target.value as FileParserProvider },
              }))}
            >
              {fileParserProviders.map((provider) => (
                  <option value={provider.value} key={provider.value}>{provider.label}</option>
                ))}
              </select>
            </label>
            {state.fileParser.provider === 'mineru-accurate-api' && (
              <label className="settings-row">
                <div className="settings-row-copy">
                  <strong>MinerU Token</strong>
                  <span>仅精准解析 API 需要 Token；轻量解析和本地解析无需填写</span>
                </div>
                <input
                  type="password"
                  value={state.fileParser.mineru_token || ''}
                  placeholder="请输入 MinerU Token"
                  onChange={(event) => setState((prev) => ({
                    ...prev,
                    fileParser: { ...prev.fileParser, mineru_token: event.target.value },
                  }))}
                />
              </label>
            )}
          </div>

          <div className="parser-compare">
            {parserOptions.map((option) => (
              <article className={`parser-card parser-card-${option.tone}`} key={option.title}>
                <div className="parser-card-head">
                  <div>
                    <strong>{option.title}</strong>
                    <p>{option.summary}</p>
                  </div>
                  <span>{option.badge}</span>
                </div>
                <dl className="parser-metrics">
                  {option.items.map(([label, value]) => (
                    <div key={`${option.title}-${label}`}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </article>
            ))}
          </div>
          <div className="parser-note">
            招标文件大多数是 Word 或 Word 导出的带文字层 PDF，本地解析可以适应 95% 以上的情况；如果解析失败，再尝试 MinerU 精准解析 API。
          </div>
        </section>
      )}

      {activeTab === 'about' && (
        <section className="settings-page-section about-section">
          <div className="settings-section-title">
            <span />
            <strong>关于</strong>
          </div>
          <div className="about-grid">
            <div><span>当前版本</span><strong>{appVersion || '...'}</strong></div>
            <div><span>GitHub 仓库</span><a href="https://github.com/FB208/OpenBidKit_Yibiao" target="_blank" rel="noreferrer">FB208/OpenBidKit_Yibiao</a></div>
            <div>
              <span>自动更新</span>
              <strong>{updateStatusText}</strong>
              <button
                type="button"
                className="update-button"
                disabled={updateBusy}
                onClick={() => {
                  if (updateStatus === 'downloaded') {
                    void window.yibiao?.quitAndInstall();
                    return;
                  }
                  void checkForUpdates();
                }}
              >
                {updateStatus === 'downloaded' ? '安装并重启' : updateBusy ? '检查中...' : '检查更新'}
              </button>
            </div>
            <div><span>运行模式</span><strong>独立 Electron 客户端</strong></div>
          </div>
          <div className="privacy-statement">
            <div className="privacy-statement-head">
              <span>Privacy</span>
              <strong>隐私声明</strong>
              <p>本工具尽量把数据处理留在本机和你自行选择的服务商之间，只保留运行所必需的最少信息。</p>
            </div>
            <div className="privacy-list">
              <article className="privacy-item">
                <span>01</span>
                <strong>你的业务数据不会被我收集</strong>
                <p>应用不会上传、收集或保存你配置的 API Key、导入的招标文件、解析后的文档内容、生成的方案正文、导出文件或其他业务结果。</p>
              </article>
              <article className="privacy-item">
                <span>02</span>
                <strong>线上 AI 请求只发送给你配置的服务商</strong>
                <p>当你使用 OpenAI 兼容接口、MinerU 或其他线上 API 时，应用会把完成任务所需的内容发送给你自行配置的服务商。这是实现文档解析、内容生成、模型测试等功能的必要步骤；这些请求不经过我的服务器，我也不会额外留存任何请求内容或生成结果。</p>
              </article>
              <article className="privacy-item">
                <span>03</span>
                <strong>匿名埋点只用于了解功能使用情况</strong>
                <p>为了判断开源项目是否有人使用、哪些功能更常用，应用会把匿名页面访问和功能使用次数上报到 Cloudflare。统计不包含文档内容、文件名、本地路径、API Key、用户输入、生成结果或任何可还原业务内容的信息。</p>
              </article>
            </div>
          </div>
        </section>
      )}
      </div>
      <FloatingToolbar groups={settingsToolbarGroups} label="设置保存工具条" />
    </div>
  );
}

export default SettingsPage;
