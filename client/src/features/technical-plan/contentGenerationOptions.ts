import type { ContentGenerationOptions, ContentTableRequirement } from './types';

export const DEFAULT_HTML_IMAGE_TYPES = '甘特图、进度网络图、组织架构图、泳道图、RACI 职责矩阵、风险矩阵、系统架构与拓扑图、WBS 工作分解结构图、鱼骨图、柱状图、折线图、饼图';

export const defaultContentGenerationOptions: ContentGenerationOptions = {
  useAiImages: false,
  maxAiImages: 6,
  useMermaidImages: true,
  maxMermaidImages: 5,
  useHtmlImages: true,
  maxHtmlImages: 10,
  htmlImageTypes: DEFAULT_HTML_IMAGE_TYPES,
  tableRequirement: 'heavy',
};

function isContentTableRequirement(value: unknown): value is ContentTableRequirement {
  return value === 'none' || value === 'light' || value === 'moderate' || value === 'heavy';
}

// 根据模型状态和目录规模生成正文配置默认值。
function buildDefaultGenerationOptions(imageModelAvailable: boolean, leafCount: number): ContentGenerationOptions {
  const imageLimit = leafCount > 0 ? leafCount : Number.MAX_SAFE_INTEGER;
  return {
    ...defaultContentGenerationOptions,
    useAiImages: imageModelAvailable,
    maxAiImages: Math.min(defaultContentGenerationOptions.maxAiImages, imageLimit),
    maxMermaidImages: Math.min(defaultContentGenerationOptions.maxMermaidImages, imageLimit),
    maxHtmlImages: Math.min(defaultContentGenerationOptions.maxHtmlImages, imageLimit),
  };
}

// 统一正文配置边界，供生成设置和正文任务启动共同使用。
export function normalizeContentGenerationOptions(
  options: ContentGenerationOptions | undefined,
  imageModelAvailable: boolean,
  leafCount: number,
): ContentGenerationOptions {
  const fallback = buildDefaultGenerationOptions(imageModelAvailable, leafCount);
  const imageLimit = leafCount > 0 ? leafCount : Number.MAX_SAFE_INTEGER;
  const requestedMaxAiImages = Number(options?.maxAiImages ?? fallback.maxAiImages);
  const requestedMaxMermaidImages = Number(options?.maxMermaidImages ?? fallback.maxMermaidImages);
  const requestedMaxHtmlImages = Number(options?.maxHtmlImages ?? fallback.maxHtmlImages);

  return {
    useAiImages: Boolean(options?.useAiImages ?? fallback.useAiImages) && imageModelAvailable,
    maxAiImages: Math.max(0, Math.min(Number.isFinite(requestedMaxAiImages) ? Math.round(requestedMaxAiImages) : fallback.maxAiImages, imageLimit)),
    useMermaidImages: Boolean(options?.useMermaidImages ?? fallback.useMermaidImages),
    maxMermaidImages: Math.max(0, Math.min(Number.isFinite(requestedMaxMermaidImages) ? Math.round(requestedMaxMermaidImages) : fallback.maxMermaidImages, imageLimit)),
    useHtmlImages: Boolean(options?.useHtmlImages ?? fallback.useHtmlImages),
    maxHtmlImages: Math.max(0, Math.min(Number.isFinite(requestedMaxHtmlImages) ? Math.round(requestedMaxHtmlImages) : fallback.maxHtmlImages, imageLimit)),
    htmlImageTypes: String(options?.htmlImageTypes ?? fallback.htmlImageTypes),
    tableRequirement: isContentTableRequirement(options?.tableRequirement) ? options.tableRequirement : fallback.tableRequirement,
  };
}
