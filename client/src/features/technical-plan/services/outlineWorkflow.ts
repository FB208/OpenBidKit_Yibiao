import {
  buildAlignedChildrenOutlineMessages,
  buildAlignedOutlineReviewMessages,
  buildChildrenOutlineMessages,
  buildOutlineMessages,
  buildOutlineReviewMessages,
  buildRequirementGroupsMessages,
  buildTopLevelOutlineMessages,
} from '../../../shared/prompts';
import { aiClient } from '../../../shared/ai';
import type { OutlineData, OutlineItem, OutlineMode, TechnicalRequirementGroup } from '../../../shared/types';

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
  mode: OutlineMode;
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

function validateOutline(outline: OutlineData) {
  if (!outline.outline?.length) {
    throw new Error('目录不能为空');
  }

  if (outlineDepth(outline.outline) < 3) {
    throw new Error('完整目录至少需要三级结构');
  }
}

function validateTopLevelOutline(outline: OutlineData) {
  if (!outline.outline?.length) {
    throw new Error('一级目录不能为空');
  }
}

function validateChildren(payload: ChildrenResponse) {
  if (!payload.children?.length) {
    throw new Error('二级目录不能为空');
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

async function requestJson<TResult>(messages: Parameters<typeof aiClient.requestJson>[0]['messages'], temperature = 0.7) {
  return aiClient.requestJson<TResult>({ messages, temperature });
}

async function generateOutlineFull(options: GenerateOutlineOptions, suggestions?: string[]) {
  emit(options.onProgress, '正在一次性生成完整目录。');
  const outline = await requestJson<OutlineData>(buildOutlineMessages({
    overview: options.overview,
    requirements: options.requirements,
    oldOutline: options.oldOutline,
    suggestions,
  }));
  validateOutline(outline);
  return outline;
}

async function generateTopLevelOutline(options: GenerateOutlineOptions, suggestions?: string[]) {
  const outline = await requestJson<OutlineData>(buildTopLevelOutlineMessages({
    overview: options.overview,
    requirements: options.requirements,
    oldOutline: options.oldOutline,
    suggestions,
  }));
  validateTopLevelOutline(outline);
  return outline;
}

async function generateChildren(options: GenerateOutlineOptions, parentItem: OutlineItem, suggestions?: string[]) {
  const payload = await requestJson<ChildrenResponse>(buildChildrenOutlineMessages({
    overview: options.overview,
    requirements: options.requirements,
    oldOutline: options.oldOutline,
    parentItem,
    suggestions,
  }));
  validateChildren(payload);
  return payload.children;
}

async function generateOutlineFallback(options: GenerateOutlineOptions, suggestions?: string[]) {
  emit(options.onProgress, '正在分步生成目录，先生成一级目录。');
  const topLevelOutline = await generateTopLevelOutline(options, suggestions);
  const assembledItems: OutlineItem[] = [];

  for (const [index, item] of topLevelOutline.outline.entries()) {
    emit(options.onProgress, `正在生成第 ${index + 1}/${topLevelOutline.outline.length} 个一级目录的二三级目录：${item.title || '未命名章节'}。`);
    assembledItems.push({
      ...item,
      children: await generateChildren(options, item, suggestions),
    });
  }

  const outline = renumberOutline({ outline: assembledItems });
  validateOutline(outline);
  return outline;
}

async function generateOutlineByMode(options: GenerateOutlineOptions, mode: 'auto' | 'full' | 'fallback', suggestions?: string[]): Promise<[OutlineData, 'full' | 'fallback']> {
  if (mode === 'full') {
    return [await generateOutlineFull(options, suggestions), 'full'];
  }

  if (mode === 'fallback') {
    return [await generateOutlineFallback(options, suggestions), 'fallback'];
  }

  try {
    return [await generateOutlineFull(options, suggestions), 'full'];
  } catch (error) {
    emit(options.onProgress, '一次性生成完整目录失败，切换为分步生成模式。');
    return [await generateOutlineFallback(options, suggestions), 'fallback'];
  }
}

async function reviewOutline(options: GenerateOutlineOptions, outline: OutlineData, stageLabel: string) {
  emit(options.onProgress, `${stageLabel}中。`);
  return requestJson<OutlineReviewResult>(buildOutlineReviewMessages({
    overview: options.overview,
    requirements: options.requirements,
    outlineJson: JSON.stringify(outline),
  }), 0.3);
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
    0.3
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
  }));
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
  }), 0.3);
}

async function generateFreeOutlineWorkflow(options: GenerateOutlineOptions) {
  emit(options.onProgress, '开始生成目录结构。');
  const [firstOutline, generationMode] = await generateOutlineByMode(options, 'auto');
  emit(options.onProgress, '首次目录生成完成，开始审核目录质量。');
  const firstReview = await reviewOutline(options, firstOutline, '首次审核');

  if (firstReview.passed) {
    emit(options.onProgress, '目录审核通过，准备返回结果。');
    return firstOutline;
  }

  const suggestions = firstReview.suggestions?.length ? firstReview.suggestions : ['请根据项目概述和技术评分要求补全目录覆盖范围，并修正不合理章节。'];
  emit(options.onProgress, '目录审核未通过，正在根据修改建议重新生成。');

  try {
    const [secondOutline] = await generateOutlineByMode(options, generationMode, suggestions);
    emit(options.onProgress, '二次生成完成，开始最终审核。');
    const secondReview = await reviewOutline(options, secondOutline, '最终审核');
    emit(options.onProgress, secondReview.passed ? '最终审核通过，准备返回修正后的结果。' : '最终审核未完全通过，已返回修正后的第二次结果。');
    return secondOutline;
  } catch {
    emit(options.onProgress, '根据审核建议重新生成失败，已回退到首次生成结果。');
    return firstOutline;
  }
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
  const outline = options.mode === 'aligned'
    ? await generateAlignedOutlineWorkflow(options)
    : await generateFreeOutlineWorkflow(options);

  return {
    ...outline,
    project_overview: options.overview,
  };
}
