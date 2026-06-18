import {
  buildAlignedChildrenOutlineMessages,
  buildAlignedOutlineReviewMessages,
  buildRequirementGroupsMessages,
} from '../../../shared/prompts';
import { aiClient } from '../../../shared/ai';
import type { OutlineData, OutlineItem, TechnicalRequirementGroup } from '../../../shared/types';

type ProgressCallback = (message: string) => void;

interface OutlineReviewResult {
  passed: boolean;
  suggestions: string[];
}

interface ChildrenResponse {
  children: OutlineItem[];
}

interface RequirementGroupsResponse {
  groups: TechnicalRequirementGroup[];
}

export interface GenerateOutlineOptions {
  overview: string;
  requirements: string;
  oldOutline?: string;
  onProgress?: ProgressCallback;
}

function emit(onProgress: ProgressCallback | undefined, message: string) {
  onProgress?.(message);
}

function outlineDepth(items: OutlineItem[]): number {
  if (!items.length) {
    return 0;
  }

  return 1 + Math.max(...items.map((item) => outlineDepth(item.children || [])));
}

function formatOutlineItemLabel(item: OutlineItem, fallback: string) {
  return item.id ? `${item.id} ${item.title || fallback}` : item.title || fallback;
}

function formatMissingOutlineLabels(items: OutlineItem[], limit = 8) {
  const labels = items.map((item, index) => formatOutlineItemLabel(item, `第 ${index + 1} 个目录`));
  const visible = labels.slice(0, limit).join('、');
  return labels.length > limit ? `${visible} 等 ${labels.length} 个目录` : visible;
}

function validateOutline(outline: OutlineData) {
  if (!outline.outline?.length) {
    throw new Error('目录不能为空');
  }

  if (outlineDepth(outline.outline) < 3) {
    throw new Error('完整目录至少需要三级结构');
  }

  const shallowItems = outline.outline.filter((item) => outlineDepth([item]) < 3);
  if (shallowItems.length) {
    throw new Error(`完整目录至少需要三级结构，以下一级目录缺少三级目录：${formatMissingOutlineLabels(shallowItems)}`);
  }
}

function validateChildren(payload: ChildrenResponse) {
  if (!payload.children?.length) {
    throw new Error('二级目录不能为空');
  }

  const secondLevelWithoutThird = payload.children.filter((item) => !item.children?.length);
  if (secondLevelWithoutThird.length) {
    throw new Error(`二级目录必须包含三级目录，缺失三级目录：${formatMissingOutlineLabels(secondLevelWithoutThird)}`);
  }

  if (outlineDepth(payload.children) < 2) {
    throw new Error('二级目录必须包含三级目录');
  }
}

function renumberItems(items: OutlineItem[], parentPrefix = ''): OutlineItem[] {
  return items.map((item, index) => {
    const id = parentPrefix ? `${parentPrefix}.${index + 1}` : `${index + 1}`;
    const children = item.children?.length ? renumberItems(item.children, id) : undefined;

    return {
      ...item,
      id,
      children,
    };
  });
}

function renumberOutline(outline: OutlineData): OutlineData {
  return { ...outline, outline: renumberItems(outline.outline || []) };
}

async function requestJson<TResult>(messages: Parameters<typeof aiClient.requestJson>[0]['messages'], temperature = 0.7, logTitle = '目录生成') {
  return aiClient.requestJson<TResult>({ messages, temperature, logTitle });
}

function buildTopLevelFromGroups(groups: TechnicalRequirementGroup[]): OutlineItem[] {
  return groups.map((group, index) => ({
    id: `${index + 1}`,
    title: group.title,
    description: group.description || group.title,
    source_requirement_id: group.requirement_id,
    source_requirement_title: group.title,
  }));
}

async function extractRequirementGroups(options: GenerateOutlineOptions, suggestions?: string[]) {
  const payload = await requestJson<RequirementGroupsResponse>(
    buildRequirementGroupsMessages(options.requirements, suggestions),
    0.3,
    '目录生成-技术评分大类'
  );
  if (!payload.groups?.length) {
    throw new Error('技术评分大类不能为空');
  }
  return payload.groups;
}

async function generateAlignedChildren(options: GenerateOutlineOptions, parentItem: OutlineItem, requirementGroup: TechnicalRequirementGroup, suggestions?: string[]) {
  const payload = await requestJson<ChildrenResponse>(buildAlignedChildrenOutlineMessages({
    overview: options.overview,
    requirements: options.requirements,
    oldOutline: options.oldOutline,
    parentItem,
    requirementGroup,
    suggestions,
  }), 0.7, `目录生成-${parentItem.title || '未命名章节'}子目录`);
  validateChildren(payload);
  return payload.children;
}

async function generateAlignedOutline(options: GenerateOutlineOptions, groups: TechnicalRequirementGroup[], suggestions?: string[]) {
  const topLevelItems = buildTopLevelFromGroups(groups);
  const assembledItems: OutlineItem[] = [];

  for (const [index, item] of topLevelItems.entries()) {
    emit(options.onProgress, `正在生成第 ${index + 1}/${topLevelItems.length} 个评分大类的二三级目录：${item.title || '未命名章节'}。`);
    assembledItems.push({
      ...item,
      children: await generateAlignedChildren(options, item, groups[index], suggestions),
    });
  }

  const outline = renumberOutline({ outline: assembledItems });
  validateOutline(outline);
  return outline;
}

async function reviewAlignedOutline(options: GenerateOutlineOptions, groups: TechnicalRequirementGroup[], outline: OutlineData, stageLabel: string) {
  emit(options.onProgress, `${stageLabel}中。`);
  return requestJson<OutlineReviewResult>(buildAlignedOutlineReviewMessages({
    overview: options.overview,
    requirements: options.requirements,
    groupsJson: JSON.stringify({ groups }),
    outlineJson: JSON.stringify(outline),
  }), 0.3, `目录生成-${stageLabel}`);
}

async function generateAlignedOutlineWorkflow(options: GenerateOutlineOptions) {
  emit(options.onProgress, '开始提取技术评分大类。');
  const groups = await extractRequirementGroups(options);
  emit(options.onProgress, '技术评分大类提取完成，正在构建一级目录。');
  const firstOutline = await generateAlignedOutline(options, groups);
  emit(options.onProgress, '目录生成完成，正在审核与技术评分项的对应关系。');
  const firstReview = await reviewAlignedOutline(options, groups, firstOutline, '首次审核');

  if (firstReview.passed) {
    emit(options.onProgress, '目录审核通过，准备返回结果。');
    return firstOutline;
  }

  const suggestions = firstReview.suggestions?.length ? firstReview.suggestions : ['请保持一级目录与技术评分大类标题完全一致，并补全各大类下遗漏的评分细项。'];
  emit(options.onProgress, '目录审核未通过，正在根据修改建议重新提取技术评分大类并重新生成目录。');

  try {
    const revisedGroups = await extractRequirementGroups(options, suggestions);
    const secondOutline = await generateAlignedOutline(options, revisedGroups, suggestions);
    emit(options.onProgress, '二次生成完成，开始最终审核。');
    const secondReview = await reviewAlignedOutline(options, revisedGroups, secondOutline, '最终审核');
    emit(options.onProgress, secondReview.passed ? '最终审核通过，准备返回修正后的结果。' : '最终审核未完全通过，已返回修正后的第二次结果。');
    return secondOutline;
  } catch {
    emit(options.onProgress, '根据审核建议重新生成失败，已回退到首次生成结果。');
    return firstOutline;
  }
}

export async function requestOutlineGeneration(options: GenerateOutlineOptions) {
  const outline = await generateAlignedOutlineWorkflow(options);

  return {
    ...outline,
    project_overview: options.overview,
  };
}
