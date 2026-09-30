import type { ContentGenerationOptions, ContentTableRequirement } from './types';

export const DEFAULT_HTML_IMAGE_TYPES = '甘特图、进度网络图、组织架构图、泳道图、RACI 职责矩阵、风险矩阵、系统架构与拓扑图、WBS 工作分解结构图、鱼骨图、柱状图、折线图、饼图';

export const defaultContentGenerationOptions: ContentGenerationOptions = {
  imageQuantity: 30,
  useAiImages: false,
  useMermaidImages: true,
  useHtmlImages: true,
  htmlImageOptimization: false,
  wordCountRepair: false,
  layoutCheck: false,
  htmlImageTypes: DEFAULT_HTML_IMAGE_TYPES,
  tableRequirement: 'heavy',
};

function isContentTableRequirement(value: unknown): value is ContentTableRequirement {
  return value === 'none' || value === 'light' || value === 'moderate' || value === 'heavy';
}

// 统一正文配置边界；已保存的 AI 开关不随模型可用性变化。
export function normalizeContentGenerationOptions(
  options: ContentGenerationOptions | undefined,
  imageModelAvailable: boolean,
): ContentGenerationOptions {
  const fallback = { ...defaultContentGenerationOptions, useAiImages: imageModelAvailable };

  return {
    imageQuantity: options?.imageQuantity ?? fallback.imageQuantity,
    useAiImages: Boolean(options?.useAiImages ?? fallback.useAiImages),
    useMermaidImages: Boolean(options?.useMermaidImages ?? fallback.useMermaidImages),
    useHtmlImages: Boolean(options?.useHtmlImages ?? fallback.useHtmlImages),
    htmlImageOptimization: Boolean(options?.htmlImageOptimization ?? fallback.htmlImageOptimization),
    wordCountRepair: Boolean(options?.wordCountRepair ?? fallback.wordCountRepair),
    layoutCheck: Boolean(options?.layoutCheck ?? fallback.layoutCheck),
    htmlImageTypes: String(options?.htmlImageTypes ?? fallback.htmlImageTypes),
    tableRequirement: isContentTableRequirement(options?.tableRequirement) ? options.tableRequirement : fallback.tableRequirement,
  };
}
