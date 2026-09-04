import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { AppDialog, AppSwitch, isLibreOfficeRequiredMessage, UploadEmpty, UploadFilePill, UploadRow, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { ImageModelStatus, OutlineExpansionMode, OutlineMode, OutlineWordControlOptions } from '../../../shared/types';
import type { ExportTemplateRecord } from '../../../shared/types/exportFormat';
import type { KnowledgeBaseIndex, KnowledgeDocument } from '../../knowledge-base/types';
import { RestrictedHtmlRenderer } from '../components/RestrictedHtmlRenderer';
import type { ContentGenerationOptions, ContentIllustrationKind, ContentTableRequirement, GlobalFactsMode, TechnicalPlanOriginalPlanFile, TechnicalPlanState } from '../types';
import { DEFAULT_HTML_IMAGE_TYPES, normalizeContentGenerationOptions } from '../contentGenerationOptions';
import { contentGenerationTemplates, getContentGenerationTemplate, type ContentGenerationTemplateId } from '../contentGenerationTemplates';
import aiImageExampleUrl from '../../../../assets/generate_img_example/ai.png';
import mermaidImageExampleUrl from '../../../../assets/generate_img_example/mermaid.png';
import htmlImageExampleUrl from '../../../../assets/generate_img_example/html.png';

type GenerationSettingsTab = 'content' | 'existing-plan' | 'knowledge' | 'length' | 'illustration' | 'writing' | 'appearance';

interface GenerationSettingsPageProps {
  originalPlanFile: TechnicalPlanOriginalPlanFile | null;
  outlineMode: OutlineMode;
  outlineModeRequiresRegeneration: boolean;
  outlineExpansionMode: OutlineExpansionMode;
  outlineWordControlOptions: OutlineWordControlOptions;
  outlineWordControlSnapshot?: OutlineWordControlOptions;
  referenceKnowledgeDocumentIds: string[];
  globalFactsMode: GlobalFactsMode;
  contentGenerationTemplateId: ContentGenerationTemplateId;
  exportTemplateId: string;
  exportTemplates: ExportTemplateRecord[];
  exportTemplatesLoading: boolean;
  contentGenerationOptions?: ContentGenerationOptions;
  contentLeafCount: number;
  hasOutlineData: boolean;
  outlineConfigLocked: boolean;
  globalFactsConfigLocked: boolean;
  contentConfigLocked: boolean;
  onOriginalPlanChanged: (state: TechnicalPlanState) => void;
  onOutlineModeChange: (outlineMode: OutlineMode) => Promise<void>;
  onOutlineExpansionModeChange: (outlineExpansionMode: OutlineExpansionMode) => Promise<void>;
  onOutlineWordControlOptionsChange: (options: OutlineWordControlOptions) => Promise<void>;
  onReferenceKnowledgeDocumentIdsChange: (documentIds: string[]) => Promise<void>;
  onGlobalFactsModeChange: (globalFactsMode: GlobalFactsMode) => Promise<void>;
  onContentGenerationTemplateIdChange: (templateId: ContentGenerationTemplateId) => Promise<void>;
  onExportTemplateIdChange: (templateId: string) => Promise<void>;
  onCreateExportTemplate?: () => void;
  onContentGenerationOptionsChange: (options: ContentGenerationOptions) => Promise<void>;
}

interface WordControlDraft {
  minimumWords: string;
  maximumWords: string;
  sectionWords: string;
  strictSectionWords: boolean;
}

const tabs: Array<{ id: GenerationSettingsTab; label: string }> = [
  { id: 'content', label: '写嘛' },
  { id: 'existing-plan', label: '我有方案' },
  { id: 'knowledge', label: '知识库' },
  { id: 'length', label: '写多少' },
  { id: 'illustration', label: '插图吗' },
  { id: 'writing', label: '怎么写' },
  { id: 'appearance', label: '长嘛样' },
];
const emptyKnowledgeIndex: KnowledgeBaseIndex = { folders: [], documents: [] };

const documentOptions: Array<{ value: OutlineMode; title: string; description: string }> = [
  {
    value: 'response-file',
    title: '完整投标文件',
    description: '按照招标文件响应要求完整生成',
  },
  {
    value: 'standalone-technical',
    title: '技术文件独立成册',
    description: '一级目录从技术评分大项开始',
  },
  {
    value: 'standalone-business',
    title: '商务标独立成册',
    description: '按照招标文件响应要求仅生成商务部分',
  },
];
const outlineExpansionModeLabels: Record<OutlineExpansionMode, string> = {
  'original-only': '仅使用原方案目录',
  'ai-complement': 'AI基于原方案补充',
};
const outlineExpansionModeOptions: Array<{ value: OutlineExpansionMode; title: string; description: string }> = [
  {
    value: 'original-only',
    title: outlineExpansionModeLabels['original-only'],
    description: '提取并补漏原方案目录后直接作为新目录；知识库不参与目录补充，但会用于后续全局事实和正文生成。',
  },
  {
    value: 'ai-complement',
    title: outlineExpansionModeLabels['ai-complement'],
    description: '保留原方案一级目录，在其基础上补充招标评分项缺口，并可继续使用知识库增强。',
  },
];
const globalFactsModeOptions: Array<{ value: GlobalFactsMode; title: string; description: string }> = [
  {
    value: 'fabricate',
    title: '胡咧咧模式',
    description: '未在参考材料中找到的直接证据，但经评估，正文中可能用到，为保证全文一致，会由 AI 直接杜撰。如：涉及人员名单，但用户未提供，AI 会编辑不存在的人名。此模式写完的技术方案直接完整可用，无需人工干预。',
  },
  {
    value: 'omit',
    title: '别招欠模式',
    description: '选题范围与胡咧咧模式相同。未在参考材料中找到具体值时，仍会保留该项，改写成符合招标要求的笼统口径，不写具体人员、时间、地点、业绩、证书、规格型号或实施细节。如：涉及人员名单但用户未提供，会保留岗位事实并写成按招标要求配备，而不是编造人名或忽略该项。正文阶段同样沿用笼统写法。',
  },
  {
    value: 'placeholder',
    title: '放着我来模式',
    description: '选题范围与胡咧咧模式相同。未在参考材料中找到具体值时，仍会保留该项，并将值标记为【待填写】。如：涉及人员名单但用户未提供，会保留岗位事实并写成【待填写】。用户需要二次修改后再进入正文生成阶段。正文生产时的任何不确定项也会使用【待填写】占位。',
  },
];
const tableRequirementOptions: Array<{ value: ContentTableRequirement; label: string }> = [
  { value: 'none', label: '不要' },
  { value: 'light', label: '少量' },
  { value: 'moderate', label: '适中' },
  { value: 'heavy', label: '大量' },
];
const imageModelStatusLabels: Record<ImageModelStatus, string> = {
  untested: '未测试',
  available: '可用',
  unavailable: '不可用',
};
const imageGenerationExamples: Record<ContentIllustrationKind, { src: string; alt: string }> = {
  ai: { src: aiImageExampleUrl, alt: 'AI 生图示例' },
  mermaid: { src: mermaidImageExampleUrl, alt: 'Mermaid 生图示例' },
  html: { src: htmlImageExampleUrl, alt: 'HTML 生图示例' },
};
const WORD_COUNT_INPUT_UNIT = 10000;
// 渲染生图示例入口使用的帮助图标。
function ImageExampleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.7 9.1a2.5 2.5 0 0 1 4.7 1.2c0 1.8-2.4 2.1-2.4 3.7" />
      <path d="M12 17h.01" strokeWidth="2.4" />
    </svg>
  );
}

function parseWordCountDraft(value: string) {
  if (!value) return 0;
  if (!/^\d*(?:\.\d{0,4})?$/.test(value)) return null;
  const number = Number(value);
  const words = Math.round(number * WORD_COUNT_INPUT_UNIT);
  return Number.isSafeInteger(words) && words >= 0 ? words : null;
}

function formatWordCountDraft(words: number) {
  return String(Math.max(0, Math.round(Number(words) || 0)) / WORD_COUNT_INPUT_UNIT);
}

function normalizeWordControlDraft(values: WordControlDraft) {
  const minimumWords = parseWordCountDraft(values.minimumWords);
  const maximumWords = parseWordCountDraft(values.maximumWords);
  const sectionWords = parseWordCountDraft(values.sectionWords);
  if (minimumWords === null || maximumWords === null || sectionWords === null) {
    throw new Error('字数设置只允许填写非负整数');
  }
  const options: OutlineWordControlOptions = {
    minimumWords,
    maximumWords,
    sectionWords,
    strictSectionWords: sectionWords > 0 && values.strictSectionWords,
  };
  if (minimumWords > 0 && maximumWords > 0 && maximumWords < minimumWords) {
    throw new Error('最多字数不能低于最少字数');
  }
  const effectiveSectionWords = sectionWords > 0 ? sectionWords : 3000;
  const minimumLeafCount = minimumWords > 0 ? Math.ceil(minimumWords / effectiveSectionWords) : null;
  const maximumLeafCount = maximumWords > 0 ? Math.floor(maximumWords / effectiveSectionWords) : null;
  if (maximumLeafCount !== null && maximumLeafCount < 1) {
    throw new Error('当前最多字数无法形成有效叶子节点范围，请调整最多字数或每小节字数');
  }
  if (minimumLeafCount !== null && maximumLeafCount !== null && minimumLeafCount > maximumLeafCount) {
    throw new Error('当前设置无法形成有效叶子节点范围，请调整最少字数、最多字数或每小节字数');
  }
  return options;
}

function getEstimatedPages(minimumWords: number, maximumWords: number) {
  const baseWords = minimumWords > 0 && maximumWords > 0
    ? (minimumWords + maximumWords) / 2
    : minimumWords || maximumWords;
  return baseWords > 0 ? Math.ceil(baseWords / 650) : null;
}

function areWordControlOptionsEqual(left?: OutlineWordControlOptions, right?: OutlineWordControlOptions) {
  return Boolean(left && right
    && left.minimumWords === right.minimumWords
    && left.maximumWords === right.maximumWords
    && left.sectionWords === right.sectionWords
    && left.strictSectionWords === right.strictSectionWords);
}

function getInitialExpandedKnowledgeFolders(index: KnowledgeBaseIndex) {
  const firstAvailableFolder = index.folders.find((folder) => (
    index.documents.some((document) => document.folder_id === folder.id && document.status === 'success')
  ));
  return new Set(firstAvailableFolder ? [firstAvailableFolder.id] : []);
}

function includesKeyword(value: string, keyword: string) {
  return value.toLowerCase().includes(keyword);
}

function normalizeGlobalFactsMode(value: GlobalFactsMode | undefined): GlobalFactsMode {
  return value === 'omit' || value === 'placeholder' ? value : 'fabricate';
}

// 汇总生成前配置，并管理已有方案与参考知识库。
function GenerationSettingsPage({
  originalPlanFile,
  outlineMode,
  outlineModeRequiresRegeneration,
  outlineExpansionMode,
  outlineWordControlOptions,
  outlineWordControlSnapshot,
  referenceKnowledgeDocumentIds,
  globalFactsMode,
  contentGenerationTemplateId,
  exportTemplateId,
  exportTemplates,
  exportTemplatesLoading,
  contentGenerationOptions,
  contentLeafCount,
  hasOutlineData,
  outlineConfigLocked,
  globalFactsConfigLocked,
  contentConfigLocked,
  onOriginalPlanChanged,
  onOutlineModeChange,
  onOutlineExpansionModeChange,
  onOutlineWordControlOptionsChange,
  onReferenceKnowledgeDocumentIdsChange,
  onGlobalFactsModeChange,
  onContentGenerationTemplateIdChange,
  onExportTemplateIdChange,
  onCreateExportTemplate,
  onContentGenerationOptionsChange,
}: GenerationSettingsPageProps) {
  const [activeTab, setActiveTab] = useState<GenerationSettingsTab>('content');
  const [originalPlanBusy, setOriginalPlanBusy] = useState(false);
  const [outlineModeBusy, setOutlineModeBusy] = useState(false);
  const [outlineExpansionModeBusy, setOutlineExpansionModeBusy] = useState(false);
  const [draftMinimumWords, setDraftMinimumWords] = useState(formatWordCountDraft(outlineWordControlOptions.minimumWords));
  const [draftMaximumWords, setDraftMaximumWords] = useState(formatWordCountDraft(outlineWordControlOptions.maximumWords));
  const [draftSectionWords, setDraftSectionWords] = useState(formatWordCountDraft(outlineWordControlOptions.sectionWords));
  const [draftStrictSectionWords, setDraftStrictSectionWords] = useState(outlineWordControlOptions.strictSectionWords);
  const [wordControlBusy, setWordControlBusy] = useState(false);
  const [draftKnowledgeDocumentIds, setDraftKnowledgeDocumentIds] = useState<string[]>(referenceKnowledgeDocumentIds);
  const [knowledgeSearch, setKnowledgeSearch] = useState('');
  const [expandedKnowledgeFolderIds, setExpandedKnowledgeFolderIds] = useState<Set<string>>(new Set());
  const [knowledgeIndex, setKnowledgeIndex] = useState<KnowledgeBaseIndex>(emptyKnowledgeIndex);
  const [loadingKnowledge, setLoadingKnowledge] = useState(false);
  const [knowledgeSaving, setKnowledgeSaving] = useState(false);
  const [globalFactsModeBusy, setGlobalFactsModeBusy] = useState(false);
  const [contentTemplateBusy, setContentTemplateBusy] = useState(false);
  const [exportTemplateBusy, setExportTemplateBusy] = useState(false);
  const [previewContentTemplateId, setPreviewContentTemplateId] = useState<ContentGenerationTemplateId | null>(null);
  const [imageModelStatus, setImageModelStatus] = useState<ImageModelStatus>('untested');
  const [draftTableRequirement, setDraftTableRequirement] = useState<ContentTableRequirement>(() => (
    normalizeContentGenerationOptions(contentGenerationOptions, false, contentLeafCount).tableRequirement
  ));
  const [draftIllustrationOptions, setDraftIllustrationOptions] = useState<ContentGenerationOptions>(() => (
    normalizeContentGenerationOptions(contentGenerationOptions, false, contentLeafCount)
  ));
  const [contentOptionsBusy, setContentOptionsBusy] = useState(false);
  const [htmlImageTypesDialogOpen, setHtmlImageTypesDialogOpen] = useState(false);
  const [htmlImageTypesDraft, setHtmlImageTypesDraft] = useState(DEFAULT_HTML_IMAGE_TYPES);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();
  const activeTabLabel = tabs.find((tab) => tab.id === activeTab)?.label || '';
  const parsedDraftMinimumWords = parseWordCountDraft(draftMinimumWords) ?? 0;
  const parsedDraftMaximumWords = parseWordCountDraft(draftMaximumWords) ?? 0;
  const parsedDraftSectionWords = parseWordCountDraft(draftSectionWords) ?? 0;
  const estimatedPages = getEstimatedPages(parsedDraftMinimumWords, parsedDraftMaximumWords);
  const normalizedDraftOptions: OutlineWordControlOptions = {
    minimumWords: parsedDraftMinimumWords,
    maximumWords: parsedDraftMaximumWords,
    sectionWords: parsedDraftSectionWords,
    strictSectionWords: parsedDraftSectionWords > 0 && draftStrictSectionWords,
  };
  const wordControlRequiresRegeneration = Boolean(
    hasOutlineData && !areWordControlOptionsEqual(normalizedDraftOptions, outlineWordControlSnapshot),
  );
  const knowledgeSelectionDisabled = loadingKnowledge || knowledgeSaving || outlineConfigLocked;
  const imageModelAvailable = imageModelStatus === 'available';
  const contentImageLimit = contentLeafCount > 0 ? contentLeafCount : Number.MAX_SAFE_INTEGER;
  const currentContentGenerationOptions = normalizeContentGenerationOptions(
    contentGenerationOptions,
    imageModelAvailable,
    contentLeafCount,
  );
  const currentContentTemplate = getContentGenerationTemplate(contentGenerationTemplateId);
  const previewContentTemplate = previewContentTemplateId ? getContentGenerationTemplate(previewContentTemplateId) : null;
  const selectedExportTemplate = exportTemplates.find((template) => template.template_id === exportTemplateId) || null;

  useEffect(() => {
    setDraftMinimumWords(formatWordCountDraft(outlineWordControlOptions.minimumWords));
    setDraftMaximumWords(formatWordCountDraft(outlineWordControlOptions.maximumWords));
    setDraftSectionWords(formatWordCountDraft(outlineWordControlOptions.sectionWords));
    setDraftStrictSectionWords(outlineWordControlOptions.strictSectionWords);
  }, [outlineWordControlOptions]);

  useEffect(() => {
    setDraftKnowledgeDocumentIds(referenceKnowledgeDocumentIds);
  }, [referenceKnowledgeDocumentIds]);

  useEffect(() => {
    let cancelled = false;
    window.yibiao?.config.load().then((config) => {
      if (!cancelled) setImageModelStatus(config.image_model?.status || 'untested');
    }).catch((error) => console.warn('读取生图模型状态失败', error));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const nextOptions = normalizeContentGenerationOptions(
      contentGenerationOptions,
      imageModelAvailable,
      contentLeafCount,
    );
    setDraftTableRequirement(nextOptions.tableRequirement);
    setDraftIllustrationOptions(nextOptions);
  }, [contentGenerationOptions, contentLeafCount, imageModelAvailable]);

  useEffect(() => {
    if (activeTab !== 'knowledge') return;
    setDraftKnowledgeDocumentIds(referenceKnowledgeDocumentIds);
    setKnowledgeSearch('');
    void loadKnowledgeIndex();
  }, [activeTab, referenceKnowledgeDocumentIds]);

  const resolveDroppedFilePaths = (files: FileList) =>
    Array.from(files).map((file) => window.yibiao?.file.getPathForFile(file) || '').filter(Boolean);

  // 支持标准页签键盘导航，并把焦点同步到新页签。
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    setActiveTab(nextTab.id);
    document.getElementById(`generation-settings-tab-${nextTab.id}`)?.focus();
  };

  // 数字输入按回车时通过失焦统一触发校验和保存。
  const blurInputOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur();
  };

  // 导入或替换已有方案，并刷新技术方案状态。
  const importOriginalPlan = async (filePaths?: string[]) => {
    try {
      setOriginalPlanBusy(true);
      const result = await window.yibiao?.technicalPlan.importOriginalPlanDocument(filePaths);
      if (!result?.success) {
        const message = result?.message || '未导入文件';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, message === '已取消选择' ? 'info' : 'error');
        return;
      }
      if (!result.markdown) {
        showToast('已有方案解析结果为空', 'error');
        return;
      }
      onOriginalPlanChanged(await window.yibiao!.technicalPlan.loadState());
      showToast(result.message || '已有方案已导入', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '已有方案解析失败';
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setOriginalPlanBusy(false);
    }
  };

  // 删除已有方案并切回普通生成流程。
  const removeOriginalPlan = async () => {
    try {
      setOriginalPlanBusy(true);
      const result = await window.yibiao!.technicalPlan.removeOriginalPlanDocument();
      if (!result.success) {
        showToast(result.message || '移除已有方案失败', 'error');
        return;
      }
      onOriginalPlanChanged(await window.yibiao!.technicalPlan.loadState());
      setRemoveDialogOpen(false);
      showToast(result.message || '已移除已有方案', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '移除已有方案失败', 'error');
    } finally {
      setOriginalPlanBusy(false);
    }
  };

  // 保存投标文件生成范围；已有结果继续保留到用户重新生成目录。
  const saveOutlineMode = async (nextOutlineMode: OutlineMode) => {
    if (nextOutlineMode === outlineMode || outlineModeBusy) return;
    try {
      setOutlineModeBusy(true);
      await onOutlineModeChange(nextOutlineMode);
      showToast('保存成功', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存生成范围失败', 'error');
    } finally {
      setOutlineModeBusy(false);
    }
  };

  // 保存原方案目录使用方式，不改变当前已生成目录。
  const saveOutlineExpansionMode = async (nextMode: OutlineExpansionMode) => {
    if (nextMode === outlineExpansionMode || outlineExpansionModeBusy) return;
    try {
      setOutlineExpansionModeBusy(true);
      await onOutlineExpansionModeChange(nextMode);
      showToast('保存成功', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存原方案目录使用方式失败', 'error');
    } finally {
      setOutlineExpansionModeBusy(false);
    }
  };

  // 按目录生成阶段原有规则校验并保存篇幅设置。
  const saveWordControlOptions = async (overrides: Partial<WordControlDraft> = {}) => {
    if (wordControlBusy) return;
    const draft = {
      minimumWords: draftMinimumWords,
      maximumWords: draftMaximumWords,
      sectionWords: draftSectionWords,
      strictSectionWords: draftStrictSectionWords,
      ...overrides,
    };
    let options: OutlineWordControlOptions;
    try {
      options = normalizeWordControlDraft(draft);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存篇幅设置失败', 'error');
      return;
    }

    setDraftMinimumWords(formatWordCountDraft(options.minimumWords));
    setDraftMaximumWords(formatWordCountDraft(options.maximumWords));
    setDraftSectionWords(formatWordCountDraft(options.sectionWords));
    setDraftStrictSectionWords(options.strictSectionWords);
    if (areWordControlOptionsEqual(options, outlineWordControlOptions)) return;

    try {
      setWordControlBusy(true);
      await onOutlineWordControlOptionsChange(options);
      showToast('保存成功', 'success');
    } catch (error) {
      setDraftMinimumWords(formatWordCountDraft(outlineWordControlOptions.minimumWords));
      setDraftMaximumWords(formatWordCountDraft(outlineWordControlOptions.maximumWords));
      setDraftSectionWords(formatWordCountDraft(outlineWordControlOptions.sectionWords));
      setDraftStrictSectionWords(outlineWordControlOptions.strictSectionWords);
      showToast(error instanceof Error ? error.message : '保存篇幅设置失败', 'error');
    } finally {
      setWordControlBusy(false);
    }
  };

  // 加载知识库索引，供生成任务选择参考文档。
  const loadKnowledgeIndex = async () => {
    try {
      setLoadingKnowledge(true);
      const index = await window.yibiao?.knowledgeBase.list();
      const nextIndex = index || emptyKnowledgeIndex;
      setKnowledgeIndex(nextIndex);
      setExpandedKnowledgeFolderIds(getInitialExpandedKnowledgeFolders(nextIndex));
    } catch (error) {
      setKnowledgeIndex(emptyKnowledgeIndex);
      setExpandedKnowledgeFolderIds(new Set());
      showToast(error instanceof Error ? error.message : '读取知识库失败', 'error');
    } finally {
      setLoadingKnowledge(false);
    }
  };

  // 保存目录与正文生成共用的参考知识库。
  const saveReferenceKnowledgeDocumentIds = async (nextDocumentIds: string[]) => {
    if (knowledgeSaving) return;
    const unchanged = nextDocumentIds.length === referenceKnowledgeDocumentIds.length
      && nextDocumentIds.every((documentId, index) => documentId === referenceKnowledgeDocumentIds[index]);
    setDraftKnowledgeDocumentIds(nextDocumentIds);
    if (unchanged) return;
    try {
      setKnowledgeSaving(true);
      await onReferenceKnowledgeDocumentIdsChange(nextDocumentIds);
      showToast('保存成功', 'success');
    } catch (error) {
      setDraftKnowledgeDocumentIds(referenceKnowledgeDocumentIds);
      showToast(error instanceof Error ? error.message : '保存参考知识库失败', 'error');
    } finally {
      setKnowledgeSaving(false);
    }
  };

  // 保存全局事实与正文共用的不确定信息补全方式。
  const saveGlobalFactsMode = async (value: GlobalFactsMode) => {
    const nextMode = normalizeGlobalFactsMode(value);
    if (nextMode === globalFactsMode || globalFactsModeBusy) return;
    try {
      setGlobalFactsModeBusy(true);
      await onGlobalFactsModeChange(nextMode);
      showToast('保存成功', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存全局事实配置失败', 'error');
    } finally {
      setGlobalFactsModeBusy(false);
    }
  };

  // 保存排版风格选择；当前仅用于结构预览，不影响正文生成结果。
  const saveContentGenerationTemplate = async (templateId: ContentGenerationTemplateId) => {
    if (templateId === contentGenerationTemplateId || contentTemplateBusy) return;
    try {
      setContentTemplateBusy(true);
      await onContentGenerationTemplateIdChange(templateId);
      showToast('保存成功', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存排版风格失败', 'error');
    } finally {
      setContentTemplateBusy(false);
    }
  };

  // 保存当前项目后续预览和 Word 导出共用的模板。
  const saveExportTemplate = async (templateId: string) => {
    if (templateId === exportTemplateId || exportTemplateBusy) return;
    try {
      setExportTemplateBusy(true);
      await onExportTemplateIdChange(templateId);
      showToast('保存成功', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存导出模板失败', 'error');
    } finally {
      setExportTemplateBusy(false);
    }
  };

  // 保存表格及三类配图设置，不改变已有正文和配图结果。
  const saveContentOptions = async (value: ContentGenerationOptions) => {
    if (contentOptionsBusy) return false;
    const nextOptions = normalizeContentGenerationOptions(value, imageModelAvailable, contentLeafCount);
    setDraftTableRequirement(nextOptions.tableRequirement);
    setDraftIllustrationOptions(nextOptions);
    if (JSON.stringify(nextOptions) === JSON.stringify(currentContentGenerationOptions)) return true;
    try {
      setContentOptionsBusy(true);
      await onContentGenerationOptionsChange(nextOptions);
      showToast('保存成功', 'success');
      return true;
    } catch (error) {
      setDraftTableRequirement(currentContentGenerationOptions.tableRequirement);
      setDraftIllustrationOptions(currentContentGenerationOptions);
      showToast(error instanceof Error ? error.message : '保存正文生成设置失败', 'error');
      return false;
    } finally {
      setContentOptionsBusy(false);
    }
  };

  const openHtmlImageTypesDialog = () => {
    setHtmlImageTypesDraft(draftIllustrationOptions.htmlImageTypes);
    setHtmlImageTypesDialogOpen(true);
  };

  const confirmHtmlImageTypes = async () => {
    const saved = await saveContentOptions({
      ...draftIllustrationOptions,
      tableRequirement: draftTableRequirement,
      htmlImageTypes: htmlImageTypesDraft,
    });
    if (saved) setHtmlImageTypesDialogOpen(false);
  };

  const toggleKnowledgeDocument = (document: KnowledgeDocument) => {
    if (document.status !== 'success' || knowledgeSelectionDisabled) return;
    const nextDocumentIds = draftKnowledgeDocumentIds.includes(document.id)
      ? draftKnowledgeDocumentIds.filter((id) => id !== document.id)
      : [...draftKnowledgeDocumentIds, document.id];
    void saveReferenceKnowledgeDocumentIds(nextDocumentIds);
  };

  const toggleKnowledgeFolder = (folderId: string) => {
    setExpandedKnowledgeFolderIds((current) => (current.has(folderId) ? new Set() : new Set([folderId])));
  };

  const selectKnowledgeFolder = (documents: KnowledgeDocument[]) => {
    if (knowledgeSelectionDisabled) return;
    const ids = documents.filter((document) => document.status === 'success').map((document) => document.id);
    void saveReferenceKnowledgeDocumentIds([...draftKnowledgeDocumentIds, ...ids.filter((id) => !draftKnowledgeDocumentIds.includes(id))]);
  };

  const deselectKnowledgeFolder = (documents: KnowledgeDocument[]) => {
    if (knowledgeSelectionDisabled) return;
    const ids = new Set(documents.map((document) => document.id));
    void saveReferenceKnowledgeDocumentIds(draftKnowledgeDocumentIds.filter((id) => !ids.has(id)));
  };

  const removeKnowledgeDocument = (documentId: string) => {
    if (knowledgeSelectionDisabled) return;
    void saveReferenceKnowledgeDocumentIds(draftKnowledgeDocumentIds.filter((id) => id !== documentId));
  };

  const clearKnowledgeDocuments = () => {
    if (knowledgeSelectionDisabled) return;
    void saveReferenceKnowledgeDocumentIds([]);
  };

  // 渲染可搜索、按文件夹展开的知识库选择器。
  const renderKnowledgePicker = () => {
    const keyword = knowledgeSearch.trim().toLowerCase();
    const availableDocuments = knowledgeIndex.documents.filter((document) => document.status === 'success');
    const selectedDocuments = draftKnowledgeDocumentIds
      .map((documentId) => knowledgeIndex.documents.find((document) => document.id === documentId))
      .filter((document): document is KnowledgeDocument => Boolean(document));
    const visibleFolders = knowledgeIndex.folders.flatMap((folder) => {
      const folderDocuments = availableDocuments.filter((document) => document.folder_id === folder.id);
      const folderMatched = keyword ? includesKeyword(folder.name, keyword) : false;
      const documents = keyword
        ? folderDocuments.filter((document) => folderMatched || includesKeyword(document.file_name, keyword))
        : folderDocuments;
      return documents.length ? [{ folder, documents }] : [];
    });
    const visibleDocumentCount = visibleFolders.reduce((total, group) => total + group.documents.length, 0);

    return (
      <section className="outline-generation-config-section outline-knowledge-picker generation-settings-knowledge-section">
        <div className="outline-generation-config-head">
          <strong>参考知识库</strong>
          <span>已选择 {draftKnowledgeDocumentIds.length} 个文档</span>
        </div>
        {loadingKnowledge ? (
          <div className="outline-knowledge-empty">正在读取知识库...</div>
        ) : !availableDocuments.length ? (
          <div className="outline-knowledge-empty">暂无已完成的知识库文档，可先到知识库上传并处理完成后再选择。</div>
        ) : (
          <div className="outline-knowledge-compact">
            <div className="outline-knowledge-search-row">
              <input
                className="outline-knowledge-search"
                value={knowledgeSearch}
                onChange={(event) => setKnowledgeSearch(event.target.value)}
                disabled={knowledgeSelectionDisabled}
                placeholder="搜索文件夹或文档"
              />
              <span>{keyword ? `匹配 ${visibleDocumentCount} 个文档` : `共 ${availableDocuments.length} 个可用文档`}</span>
            </div>
            <div className="outline-knowledge-grid">
              <div className="outline-knowledge-browser">
                <div className="outline-knowledge-pane-head">
                  <strong>知识库</strong>
                  <span>{visibleFolders.length} 个文件夹</span>
                </div>
                <div className="outline-knowledge-folder-list compact">
                  {visibleFolders.length ? visibleFolders.map(({ folder, documents }) => {
                    const expanded = keyword ? true : expandedKnowledgeFolderIds.has(folder.id);
                    const selectedCount = documents.filter((document) => draftKnowledgeDocumentIds.includes(document.id)).length;
                    return (
                      <section className="outline-knowledge-folder compact" key={folder.id}>
                        <div className="outline-knowledge-folder-head compact">
                          <button type="button" onClick={() => toggleKnowledgeFolder(folder.id)} disabled={Boolean(keyword)} aria-expanded={expanded}>
                            <span>{expanded ? '▾' : '▸'}</span>
                            <strong>{folder.name}</strong>
                          </button>
                          <small>{documents.length} 个 / 已选 {selectedCount}</small>
                          <div className="outline-knowledge-folder-actions">
                            <button type="button" onClick={() => selectKnowledgeFolder(documents)} disabled={knowledgeSelectionDisabled}>全选</button>
                            <button type="button" onClick={() => deselectKnowledgeFolder(documents)} disabled={knowledgeSelectionDisabled || !selectedCount}>取消</button>
                          </div>
                        </div>
                        {expanded && (
                          <div className="outline-knowledge-document-list compact">
                            {documents.map((document) => {
                              const selected = draftKnowledgeDocumentIds.includes(document.id);
                              return (
                                <label className={`outline-knowledge-document compact${selected ? ' is-selected' : ''}`} key={document.id}>
                                  <input type="checkbox" checked={selected} onChange={() => toggleKnowledgeDocument(document)} disabled={knowledgeSelectionDisabled} />
                                  <strong title={document.file_name}>{document.file_name}</strong>
                                  <small>{document.item_count || 0} 条</small>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </section>
                    );
                  }) : <div className="outline-knowledge-empty compact">没有匹配的知识库文档</div>}
                </div>
              </div>
              <aside className="outline-knowledge-selected-pane">
                <div className="outline-knowledge-pane-head">
                  <strong>本次已选</strong>
                  <button type="button" onClick={clearKnowledgeDocuments} disabled={knowledgeSelectionDisabled || !draftKnowledgeDocumentIds.length}>清空</button>
                </div>
                {selectedDocuments.length ? (
                  <div className="outline-knowledge-selected-list">
                    {selectedDocuments.map((document) => (
                      <div className="outline-knowledge-selected-item" key={document.id}>
                        <strong title={document.file_name}>{document.file_name}</strong>
                        <button type="button" onClick={() => removeKnowledgeDocument(document.id)} disabled={knowledgeSelectionDisabled}>移除</button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="outline-knowledge-empty compact">未选择知识库文档</div>
                )}
              </aside>
            </div>
          </div>
        )}
      </section>
    );
  };

  return (
    <div className="plan-step-body generation-settings-page">
      <section className="generation-settings-shell">
        <header className="bid-analysis-command-bar generation-settings-command-bar">
          <div>
            <span className="section-kicker">STEP 02</span>
            <strong>生成设置</strong>
            <p>配置修改后自动保存且不清空已有结果，后续重新生成时使用新设置。</p>
          </div>
        </header>

        <div className="document-switch-tabs generation-settings-tabs" role="tablist" aria-label="生成设置分类">
          {tabs.map((tab, index) => {
            const active = tab.id === activeTab;
            return (
              <button
                type="button"
                className={`document-switch-tab generation-settings-tab${active ? ' is-active' : ''}`}
                id={`generation-settings-tab-${tab.id}`}
                aria-selected={active}
                aria-controls="generation-settings-panel"
                role="tab"
                tabIndex={active ? 0 : -1}
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div
          className="bid-analysis-workspace generation-settings-panel"
          id="generation-settings-panel"
          aria-labelledby={`generation-settings-tab-${activeTab}`}
          role="tabpanel"
        >
          {activeTab === 'content' ? (
            <fieldset className="generation-settings-option-grid" disabled={outlineModeBusy}>
              <legend className="sr-only">选择投标文件生成范围</legend>
              {documentOptions.map((option, index) => (
                <label className={`generation-settings-option${outlineMode === option.value ? ' is-selected' : ''}`} key={option.value}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <input
                    type="radio"
                    name="technical-plan-outline-mode"
                    value={option.value}
                    checked={outlineMode === option.value}
                    onChange={() => void saveOutlineMode(option.value)}
                  />
                  <strong>{option.title}</strong>
                  <small>{option.description}</small>
                </label>
              ))}
              <div className="generation-settings-option-status" role="status" aria-live="polite">
                {outlineModeBusy
                  ? '正在保存生成范围...'
                  : outlineModeRequiresRegeneration
                    ? '生成范围已改变，当前目录和正文仍保留原结果，重新生成目录后生效。'
                    : ''}
              </div>
            </fieldset>
          ) : activeTab === 'existing-plan' ? (
            <div className="generation-settings-stack">
              <UploadRow
                title="基于上传的方案进行扩写"
                className="generation-settings-existing-upload"
                actions={(
                  <button type="button" className="primary-action" onClick={() => void importOriginalPlan()} disabled={originalPlanBusy}>
                    {originalPlanBusy ? '处理中...' : originalPlanFile ? '替换' : '上传'}
                  </button>
                )}
                onDropFiles={(files) => {
                  const paths = resolveDroppedFilePaths(files);
                  if (paths.length) void importOriginalPlan(paths);
                }}
                dropDisabled={originalPlanBusy}
              >
                {originalPlanFile ? (
                  <UploadFilePill
                    badge="MD"
                    name={originalPlanFile.fileName}
                    meta={[originalPlanFile.parserLabel, `${originalPlanFile.markdownChars} 字`].filter(Boolean).join(' · ')}
                    onRemove={() => setRemoveDialogOpen(true)}
                    removeLabel="移除"
                    removeDisabled={originalPlanBusy}
                  />
                ) : (
                  <UploadEmpty title="等待已有技术方案" hint="上传后将在目录和正文阶段保留、优化并扩充原方案内容。">
                    <button type="button" className="text-button" onClick={() => void importOriginalPlan()} disabled={originalPlanBusy}>选择已有方案</button>
                  </UploadEmpty>
                )}
              </UploadRow>
              {originalPlanFile && (
                <section className="outline-generation-config-section outline-expansion-mode-section generation-settings-config-section">
                  <div className="outline-generation-config-head">
                    <strong>原方案目录使用方式</strong>
                    <span>{outlineExpansionModeLabels[outlineExpansionMode]}</span>
                  </div>
                  <div className="outline-expansion-mode-switch">
                    {outlineExpansionModeOptions.map((option) => {
                      const selected = outlineExpansionMode === option.value;
                      return (
                        <button
                          type="button"
                          className={`outline-expansion-mode-option${selected ? ' is-selected' : ''}`}
                          key={option.value}
                          onClick={() => void saveOutlineExpansionMode(option.value)}
                          disabled={outlineConfigLocked || outlineExpansionModeBusy}
                          aria-pressed={selected}
                        >
                          <strong>{option.title}</strong>
                          <span>{option.description}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}
            </div>
          ) : activeTab === 'knowledge' ? (
            renderKnowledgePicker()
          ) : activeTab === 'length' ? (
            <section className="outline-word-control-section generation-settings-length-section">
              <div className="content-generation-config-row">
                <span>
                  <strong>全文字数/页数预设</strong>
                  <small>在目录生成阶段，就要预设好全文生成的字数，默认0表示不控制</small>
                </span>
              </div>
              <div className="outline-word-control-options">
                <div className="outline-word-control-grid">
                  <label>
                    <span>最少字数（万）</span>
                    <input inputMode="decimal" value={draftMinimumWords} disabled={outlineConfigLocked || wordControlBusy} onChange={(event) => /^\d*(?:\.\d{0,4})?$/.test(event.target.value) && setDraftMinimumWords(event.target.value)} onKeyDown={blurInputOnEnter} onBlur={() => {
                      const value = formatWordCountDraft(parseWordCountDraft(draftMinimumWords) ?? 0);
                      setDraftMinimumWords(value);
                      void saveWordControlOptions({ minimumWords: value });
                    }} />
                  </label>
                  <label>
                    <span>最多字数（万）</span>
                    <input inputMode="decimal" value={draftMaximumWords} disabled={outlineConfigLocked || wordControlBusy} onChange={(event) => /^\d*(?:\.\d{0,4})?$/.test(event.target.value) && setDraftMaximumWords(event.target.value)} onKeyDown={blurInputOnEnter} onBlur={() => {
                      const value = formatWordCountDraft(parseWordCountDraft(draftMaximumWords) ?? 0);
                      setDraftMaximumWords(value);
                      void saveWordControlOptions({ maximumWords: value });
                    }} />
                  </label>
                  <label>
                    <span>每小节字数（万）</span>
                    <input inputMode="decimal" value={draftSectionWords} disabled={outlineConfigLocked || wordControlBusy} onChange={(event) => {
                      if (!/^\d*(?:\.\d{0,4})?$/.test(event.target.value)) return;
                      setDraftSectionWords(event.target.value);
                    }} onKeyDown={blurInputOnEnter} onBlur={() => {
                      const sectionWords = parseWordCountDraft(draftSectionWords) ?? 0;
                      const value = formatWordCountDraft(sectionWords);
                      const strictSectionWords = sectionWords > 0 && draftStrictSectionWords;
                      setDraftSectionWords(value);
                      setDraftStrictSectionWords(strictSectionWords);
                      void saveWordControlOptions({ sectionWords: value, strictSectionWords });
                    }} />
                  </label>
                </div>
                <small className="outline-word-control-help">
                  <span>填2代表20000字，0.15代表1500字，默认0表示不控制，AI默认生成多少就是多少。</span>
                  <span>如果<strong className="outline-word-control-highlight">您使用的不是gpt-5.6-sol</strong>，推荐按照您模型的能力上限填写每小节字数，否则扩写过程会非常漫长。</span>
                </small>
                <div className="content-generation-config-row">
                  <span>
                    <strong>强控小节字数</strong>
                    <small>{draftStrictSectionWords ? '强制控制每小节字数必须是预设值的正负 20%' : '仅控制总字数'}</small>
                  </span>
                  <AppSwitch checked={draftStrictSectionWords} onCheckedChange={(checked) => {
                    setDraftStrictSectionWords(checked);
                    void saveWordControlOptions({ strictSectionWords: checked });
                  }} disabled={outlineConfigLocked || wordControlBusy || parsedDraftSectionWords === 0} aria-label="强控小节字数，允许范围为预设值的正负 20%" />
                </div>
                <div className="outline-word-control-estimate">
                  <div className="outline-word-control-estimate-label">预估页数</div>
                  <div className="outline-word-control-estimate-value">
                    {estimatedPages === null ? (
                      <span className="outline-word-control-estimate-empty">--</span>
                    ) : (
                      <>
                        <span className="outline-word-control-estimate-number">{estimatedPages}</span>
                        <span className="outline-word-control-estimate-unit">页</span>
                      </>
                    )}
                  </div>
                  <div className="outline-word-control-estimate-hint">
                    {estimatedPages === null ? '请先设置总字数范围' : '页数和排版有关，无法精确预估'}
                  </div>
                </div>
              </div>
              <div className="content-generation-config-group generation-settings-table-requirement">
                <label className="content-generation-config-row">
                  <span>
                    <strong>表格需求</strong>
                    <small>设置正文编排时需要安排的表格数量倾向。</small>
                  </span>
                  <select
                    value={draftTableRequirement}
                    disabled={contentConfigLocked || contentOptionsBusy}
                    onChange={(event) => {
                      const tableRequirement = event.target.value as ContentTableRequirement;
                      void saveContentOptions({ ...draftIllustrationOptions, tableRequirement });
                    }}
                  >
                    {tableRequirementOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                  </select>
                </label>
              </div>
              {wordControlRequiresRegeneration && (
                <div className="outline-word-control-notice">
                  {outlineWordControlSnapshot ? '生成目录后若修改了字数设置，需要重新生成目录才能生效！' : '当前目录缺少字数控制生效配置，请重新生成目录。'}
                </div>
              )}
            </section>
          ) : activeTab === 'illustration' ? (
            <section className="generation-settings-illustration-section">
              <div className="content-generation-config-list">
                <div className="content-generation-config-group">
                  <div className="content-generation-config-row">
                    <div className="content-generation-image-option-title">
                      <strong>使用 AI 生图</strong>
                      <button type="button" className="content-generation-example-button" onClick={() => setPreviewImage(imageGenerationExamples.ai)} aria-label="查看 AI 生图示例" title="查看 AI 生图示例">
                        <ImageExampleIcon />
                      </button>
                    </div>
                    <div className="content-generation-config-control">
                      <em className={`content-image-status is-${imageModelStatus}`}>{imageModelStatusLabels[imageModelStatus]}</em>
                      <AppSwitch
                        checked={draftIllustrationOptions.useAiImages && imageModelAvailable}
                        disabled={contentConfigLocked || contentOptionsBusy || !imageModelAvailable}
                        onCheckedChange={(checked) => void saveContentOptions({
                          ...draftIllustrationOptions,
                          tableRequirement: draftTableRequirement,
                          useAiImages: checked,
                        })}
                        aria-label="是否使用 AI 生图"
                      />
                    </div>
                  </div>
                  {draftIllustrationOptions.useAiImages && imageModelAvailable && (
                    <label className="content-generation-config-row">
                      <span><strong>AI 生图上限</strong></span>
                      <input
                        type="number"
                        min="0"
                        max={contentLeafCount > 0 ? contentLeafCount : undefined}
                        value={draftIllustrationOptions.maxAiImages}
                        disabled={contentConfigLocked || contentOptionsBusy}
                        onChange={(event) => setDraftIllustrationOptions((current) => ({
                          ...current,
                          maxAiImages: Math.max(0, Math.min(Number(event.target.value) || 0, contentImageLimit)),
                        }))}
                        onKeyDown={blurInputOnEnter}
                        onBlur={() => void saveContentOptions({ ...draftIllustrationOptions, tableRequirement: draftTableRequirement })}
                      />
                    </label>
                  )}
                </div>
                <div className="content-generation-config-group">
                  <div className="content-generation-config-row">
                    <div className="content-generation-image-option-title">
                      <strong>使用 Mermaid 生图</strong>
                      <button type="button" className="content-generation-example-button" onClick={() => setPreviewImage(imageGenerationExamples.mermaid)} aria-label="查看 Mermaid 生图示例" title="查看 Mermaid 生图示例">
                        <ImageExampleIcon />
                      </button>
                    </div>
                    <AppSwitch
                      checked={draftIllustrationOptions.useMermaidImages}
                      disabled={contentConfigLocked || contentOptionsBusy}
                      onCheckedChange={(checked) => void saveContentOptions({
                        ...draftIllustrationOptions,
                        tableRequirement: draftTableRequirement,
                        useMermaidImages: checked,
                      })}
                      aria-label="是否使用 Mermaid 生图"
                    />
                  </div>
                  {draftIllustrationOptions.useMermaidImages && (
                    <label className="content-generation-config-row">
                      <span><strong>Mermaid 生图上限</strong></span>
                      <input
                        type="number"
                        min="0"
                        max={contentLeafCount > 0 ? contentLeafCount : undefined}
                        value={draftIllustrationOptions.maxMermaidImages}
                        disabled={contentConfigLocked || contentOptionsBusy}
                        onChange={(event) => setDraftIllustrationOptions((current) => ({
                          ...current,
                          maxMermaidImages: Math.max(0, Math.min(Number(event.target.value) || 0, contentImageLimit)),
                        }))}
                        onKeyDown={blurInputOnEnter}
                        onBlur={() => void saveContentOptions({ ...draftIllustrationOptions, tableRequirement: draftTableRequirement })}
                      />
                    </label>
                  )}
                </div>
                <div className="content-generation-config-group">
                  <div className="content-generation-config-row">
                    <div className="content-generation-image-option-title">
                      <strong>生成 HTML 图片</strong>
                      <button type="button" className="content-generation-example-button" onClick={() => setPreviewImage(imageGenerationExamples.html)} aria-label="查看 HTML 生图示例" title="查看 HTML 生图示例">
                        <ImageExampleIcon />
                      </button>
                    </div>
                    <AppSwitch
                      checked={draftIllustrationOptions.useHtmlImages}
                      disabled={contentConfigLocked || contentOptionsBusy}
                      onCheckedChange={(checked) => void saveContentOptions({
                        ...draftIllustrationOptions,
                        tableRequirement: draftTableRequirement,
                        useHtmlImages: checked,
                      })}
                      aria-label="是否生成 HTML 图片"
                    />
                  </div>
                  {draftIllustrationOptions.useHtmlImages && (
                    <label className="content-generation-config-row">
                      <span><strong>HTML 生图上限</strong></span>
                      <input
                        type="number"
                        min="0"
                        max={contentLeafCount > 0 ? contentLeafCount : undefined}
                        value={draftIllustrationOptions.maxHtmlImages}
                        disabled={contentConfigLocked || contentOptionsBusy}
                        onChange={(event) => setDraftIllustrationOptions((current) => ({
                          ...current,
                          maxHtmlImages: Math.max(0, Math.min(Number(event.target.value) || 0, contentImageLimit)),
                        }))}
                        onKeyDown={blurInputOnEnter}
                        onBlur={() => void saveContentOptions({ ...draftIllustrationOptions, tableRequirement: draftTableRequirement })}
                      />
                    </label>
                  )}
                </div>
                {draftIllustrationOptions.useHtmlImages && (
                  <div className="content-generation-config-group">
                    <div className="content-generation-config-row">
                      <span>
                        <strong>高级设置</strong>
                        <small>设置允许生成的 HTML 图片类型。</small>
                      </span>
                      <button type="button" className="secondary-action" onClick={openHtmlImageTypesDialog} disabled={contentConfigLocked || contentOptionsBusy}>打开</button>
                    </div>
                  </div>
                )}
              </div>
            </section>
          ) : activeTab === 'writing' ? (
            <section className="generation-settings-writing-section">
              <div className="global-facts-mode-list" role="radiogroup" aria-label="事实补全模式">
                {globalFactsModeOptions.map((option) => {
                  const selected = globalFactsMode === option.value;
                  return (
                    <button
                      type="button"
                      className={`global-facts-mode-option${selected ? ' is-selected' : ''}`}
                      key={option.value}
                      onClick={() => void saveGlobalFactsMode(option.value)}
                      disabled={globalFactsConfigLocked || globalFactsModeBusy}
                      role="radio"
                      aria-checked={selected}
                    >
                      <strong>{option.title}</strong>
                      <span>{option.description}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ) : activeTab === 'appearance' ? (
            <section className="generation-settings-appearance-section">
              <section className="generation-settings-export-template-section">
                <div className="generation-settings-appearance-head">
                  <strong>导出模板选择</strong>
                  <span>决定预览和最终 Word 的纸张、页眉页脚、字体、标题、表格及图片样式。</span>
                </div>
                <div className="generation-settings-export-template-control">
                  <select
                    value={selectedExportTemplate?.template_id || ''}
                    disabled={exportTemplatesLoading || exportTemplateBusy || !exportTemplates.length}
                    onChange={(event) => void saveExportTemplate(event.target.value)}
                    aria-label="导出模板选择"
                  >
                    <option value="" disabled>{exportTemplatesLoading ? '正在读取模板...' : '请选择导出模板'}</option>
                    {exportTemplates.map((template) => <option value={template.template_id} key={template.template_id}>{template.template_name}</option>)}
                  </select>
                  {onCreateExportTemplate && <button type="button" className="secondary-action" onClick={onCreateExportTemplate}>新建模板</button>}
                </div>
                {!exportTemplatesLoading && !exportTemplates.length && <p className="generation-settings-export-template-status">暂无可用模板，请先新建并保存 Word 导出模板。</p>}
                {!exportTemplatesLoading && exportTemplateId && !selectedExportTemplate && <p className="generation-settings-export-template-status is-error">原导出模板已被删除，请重新选择。</p>}
              </section>

              <div className="generation-settings-appearance-head">
                <strong>排版风格选择</strong>
                <span>{selectedExportTemplate ? `排版风格只改变内容组织，纸张和外观仍由“${selectedExportTemplate.template_name}”决定。` : '请先选择导出模板，再查看和选择排版结构。'}</span>
              </div>
              <fieldset className="content-template-grid" disabled={contentTemplateBusy || !selectedExportTemplate} aria-label="排版风格选择">
                {contentGenerationTemplates.map((template) => {
                  const selected = currentContentTemplate.id === template.id;
                  return (
                    <article className={`content-template-option${selected ? ' is-selected' : ''}`} key={template.id}>
                      <div className="content-template-summary">
                        <div>
                          <strong>{template.name}</strong>
                          <p>{template.description}</p>
                        </div>
                        <span>{template.recommendation}</span>
                      </div>
                      <div className="content-template-actions">
                        <label className="content-template-radio">
                          <input
                            type="radio"
                            name="content-generation-template"
                            value={template.id}
                            checked={selected}
                            onChange={() => void saveContentGenerationTemplate(template.id)}
                          />
                          <span>{selected ? '当前模板' : '选择此模板'}</span>
                        </label>
                        <button type="button" className="secondary-action" onClick={() => setPreviewContentTemplateId(template.id)}>查看完整预览</button>
                      </div>
                      <div className="content-template-thumbnail" aria-hidden="true">
                        {selectedExportTemplate && (
                          <RestrictedHtmlRenderer
                            value={template.displayHtml}
                            config={selectedExportTemplate.config}
                            columns={template.id === 'visual-table' ? 2 : 1}
                            compact
                          />
                        )}
                      </div>
                    </article>
                  );
                })}
              </fieldset>
            </section>
          ) : (
            <div className="generation-settings-placeholder" role="status">
              <strong>{activeTabLabel}设置待补充</strong>
              <p>当前先保留页面结构，后续按实际规则逐项接入。</p>
            </div>
          )}
        </div>
      </section>

      <Dialog.Root open={Boolean(previewContentTemplate)} onOpenChange={(open) => !open && setPreviewContentTemplateId(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal content-template-preview-modal" />
          <Dialog.Content className="content-template-preview-dialog">
            <div className="content-template-preview-dialog-head">
              <div>
                <Dialog.Title>{previewContentTemplate?.name || '模板完整预览'}</Dialog.Title>
                <Dialog.Description>{previewContentTemplate ? `${previewContentTemplate.recommendation}；当前按所选导出模板真实分页，可纵向滚动查看全部页面。` : '当前按所选导出模板真实分页。'}</Dialog.Description>
              </div>
              <Dialog.Close className="image-preview-close" type="button" aria-label="关闭模板预览">×</Dialog.Close>
            </div>
            <div className="content-template-preview-dialog-body">
              {previewContentTemplateId && selectedExportTemplate && (
                <RestrictedHtmlRenderer
                  value={previewContentTemplate?.displayHtml || ''}
                  config={selectedExportTemplate.config}
                  columns={previewContentTemplateId === 'visual-table' ? 2 : 1}
                />
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={htmlImageTypesDialogOpen} onOpenChange={(open) => !contentOptionsBusy && setHtmlImageTypesDialogOpen(open)}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal html-image-types-modal" />
          <Dialog.Content className="content-regenerate-card html-image-types-card" aria-describedby={undefined}>
            <div className="content-regenerate-card-head">
              <Dialog.Title>HTML 可生成的图片类型</Dialog.Title>
            </div>
            <textarea
              value={htmlImageTypesDraft}
              onChange={(event) => setHtmlImageTypesDraft(event.target.value)}
              disabled={contentOptionsBusy}
              aria-label="HTML 可生成的图片类型"
            />
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button" disabled={contentOptionsBusy}>取消</Dialog.Close>
              <button type="button" className="primary-action" onClick={() => void confirmHtmlImageTypes()} disabled={contentOptionsBusy}>{contentOptionsBusy ? '正在保存...' : '确认'}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={Boolean(previewImage)} onOpenChange={(open) => !open && setPreviewImage(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="image-preview-modal" />
          <Dialog.Content className="image-preview-card">
            <Dialog.Close className="image-preview-close" type="button" aria-label="关闭图片预览">×</Dialog.Close>
            <Dialog.Title>{previewImage?.alt || '图片预览'}</Dialog.Title>
            {previewImage && <img src={previewImage.src} alt={previewImage.alt} />}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <AppDialog
        open={removeDialogOpen}
        onOpenChange={(open) => !originalPlanBusy && setRemoveDialogOpen(open)}
        kicker="移除已有方案"
        title="确认切回普通生成模式"
        description="移除后会保留招标文件、目录、全局事实、正文、生成进度和配图结果；后续重新生成时不再使用原方案。"
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setRemoveDialogOpen(false)} disabled={originalPlanBusy}>取消</button>
            <button type="button" className="danger-action" onClick={() => void removeOriginalPlan()} disabled={originalPlanBusy}>
              {originalPlanBusy ? '正在移除...' : '确认移除'}
            </button>
          </>
        )}
      />
    </div>
  );
}

export default GenerationSettingsPage;
