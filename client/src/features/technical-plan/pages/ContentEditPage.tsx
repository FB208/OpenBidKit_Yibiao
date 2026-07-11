import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import * as Switch from '@radix-ui/react-switch';
import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { trackConfigUsage } from '../../../shared/analytics/analytics';
import { MarkdownEditor, MarkdownFullscreenViewer, MarkdownRenderer, useToast } from '../../../shared/ui';
import type { ClientConfig, ImageModelStatus, OutlineData, OutlineItem } from '../../../shared/types';
import { countReadableWords } from '../../../shared/utils/wordCount';
import type { BackgroundTaskState, ConsistencyRepairMode, ContentGenerationOptions, ContentGenerationSectionStatus, ContentGenerationSections, ContentTableRequirement, OriginalPlanCoverageRepairMode, TechnicalPlanWorkflowKind } from '../types';
import type { ExportFormatConfig } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import { buildExportFormatCssVars } from '../../../shared/utils/exportFormatCss';
import { formatOutlineTitle } from '../../../shared/utils/outlineNumbering';

interface ContentEditPageProps {
  workflowKind: TechnicalPlanWorkflowKind;
  outlineData: OutlineData | null;
  task?: BackgroundTaskState;
  contentGenerationOptions?: ContentGenerationOptions;
  sections: ContentGenerationSections;
  onContentGenerationOptionsChange: (options: ContentGenerationOptions) => Promise<void> | void;
  onContentSaved: (item: OutlineItem, content: string) => Promise<void> | void;
}

type TreeStatus = ContentGenerationSectionStatus | 'partial' | 'planning';

interface OutlineNodeMeta {
  status: TreeStatus;
  leafCount: number;
  words: number;
}

type ContentGenerationAction = 'start' | 'continue' | 'retry_minimum_words' | 'regenerate' | 'regenerate_section';

interface PendingMinimumWordsChoice {
  options: ContentGenerationOptions;
  imageModelAvailable: boolean;
  config: ClientConfig | null;
  currentWords: number;
  minimumWords: number;
}

type NumberInputDraft = number | '';
type DraftContentGenerationOptions = Omit<ContentGenerationOptions, 'minimumWords'> & {
  minimumWords: NumberInputDraft;
};

const statusLabels: Record<TreeStatus, string> = {
  idle: '待生成',
  running: '生成中',
  success: '已生成',
  error: '失败',
  partial: '部分生成',
  planning: '编排中',
};

const imageModelStatusLabels: Record<ImageModelStatus, string> = {
  untested: '未测试',
  available: '可用',
  unavailable: '不可用',
};

const tableRequirementOptions: Array<{ value: ContentTableRequirement; label: string }> = [
  { value: 'none', label: '不要' },
  { value: 'light', label: '少量' },
  { value: 'moderate', label: '适中' },
  { value: 'heavy', label: '大量' },
];

const consistencyRepairModeOptions: Array<{ value: ConsistencyRepairMode; label: string }> = [
  { value: 'agent', label: 'Agent 修复（推荐）' },
  { value: 'normal', label: '普通修复' },
];

const originalPlanCoverageRepairModeOptions: Array<{ value: OriginalPlanCoverageRepairMode; label: string }> = [
  { value: 'agent', label: 'Agent 修复（推荐）' },
  { value: 'normal', label: '普通修复' },
];

const DEFAULT_HTML_IMAGE_TYPES = '甘特图、进度网络图、组织架构图、泳道图、RACI 职责矩阵、风险矩阵、系统架构与拓扑图、WBS 工作分解结构图、鱼骨图、柱状图、折线图、饼图';

const defaultContentGenerationOptions: ContentGenerationOptions = {
  useAiImages: false,
  maxAiImages: 6,
  useMermaidImages: true,
  maxMermaidImages: 10,
  useHtmlImages: true,
  maxHtmlImages: 10,
  htmlImageTypes: DEFAULT_HTML_IMAGE_TYPES,
  tableRequirement: 'heavy',
  minimumWords: 0,
  enableConsistencyAudit: true,
  consistencyRepairMode: 'agent',
  enableOriginalPlanCoverageAudit: false,
  originalPlanCoverageRepairMode: 'agent',
};

function isContentTableRequirement(value: unknown): value is ContentTableRequirement {
  return tableRequirementOptions.some((option) => option.value === value);
}

function isConsistencyRepairMode(value: unknown): value is ConsistencyRepairMode {
  return consistencyRepairModeOptions.some((option) => option.value === value);
}

function isOriginalPlanCoverageRepairMode(value: unknown): value is OriginalPlanCoverageRepairMode {
  return originalPlanCoverageRepairModeOptions.some((option) => option.value === value);
}

function buildDefaultGenerationOptions(imageModelAvailable: boolean, leafCount: number): ContentGenerationOptions {
  const imageLimit = Math.max(1, leafCount);
  return {
    ...defaultContentGenerationOptions,
    useAiImages: imageModelAvailable,
    maxAiImages: Math.min(defaultContentGenerationOptions.maxAiImages, imageLimit),
    maxMermaidImages: Math.min(defaultContentGenerationOptions.maxMermaidImages, imageLimit),
    maxHtmlImages: Math.min(defaultContentGenerationOptions.maxHtmlImages, imageLimit),
  };
}

function normalizeGenerationOptions(options: ContentGenerationOptions | DraftContentGenerationOptions | undefined, imageModelAvailable: boolean, leafCount: number, isExpansionWorkflow = false): ContentGenerationOptions {
  const fallback = buildDefaultGenerationOptions(imageModelAvailable, leafCount);
  const maxAiImagesLimit = Math.max(1, leafCount);
  const requestedMaxAiImages = Number(options?.maxAiImages ?? fallback.maxAiImages);
  const requestedMaxMermaidImages = Number(options?.maxMermaidImages ?? fallback.maxMermaidImages);
  const requestedMaxHtmlImages = Number(options?.maxHtmlImages ?? fallback.maxHtmlImages);
  const requestedMinimumWords = Number(options?.minimumWords ?? fallback.minimumWords);
  const tableRequirement = options?.tableRequirement;

  return {
    useAiImages: Boolean(options?.useAiImages ?? fallback.useAiImages) && imageModelAvailable,
    maxAiImages: Math.max(0, Math.min(Number.isFinite(requestedMaxAiImages) ? Math.round(requestedMaxAiImages) : fallback.maxAiImages, maxAiImagesLimit)),
    useMermaidImages: Boolean(options?.useMermaidImages ?? fallback.useMermaidImages),
    maxMermaidImages: Math.max(0, Math.min(Number.isFinite(requestedMaxMermaidImages) ? Math.round(requestedMaxMermaidImages) : fallback.maxMermaidImages, maxAiImagesLimit)),
    useHtmlImages: Boolean(options?.useHtmlImages ?? fallback.useHtmlImages),
    maxHtmlImages: Math.max(0, Math.min(Number.isFinite(requestedMaxHtmlImages) ? Math.round(requestedMaxHtmlImages) : fallback.maxHtmlImages, maxAiImagesLimit)),
    htmlImageTypes: String(options?.htmlImageTypes ?? fallback.htmlImageTypes),
    tableRequirement: isContentTableRequirement(tableRequirement) ? tableRequirement : fallback.tableRequirement,
    minimumWords: Math.max(0, Number.isFinite(requestedMinimumWords) ? Math.round(requestedMinimumWords) : fallback.minimumWords),
    enableConsistencyAudit: Boolean(options?.enableConsistencyAudit ?? fallback.enableConsistencyAudit),
    consistencyRepairMode: isConsistencyRepairMode(options?.consistencyRepairMode) ? options.consistencyRepairMode : fallback.consistencyRepairMode,
    enableOriginalPlanCoverageAudit: isExpansionWorkflow ? Boolean(options?.enableOriginalPlanCoverageAudit ?? fallback.enableOriginalPlanCoverageAudit) : false,
    originalPlanCoverageRepairMode: isExpansionWorkflow && isOriginalPlanCoverageRepairMode(options?.originalPlanCoverageRepairMode) ? options.originalPlanCoverageRepairMode : fallback.originalPlanCoverageRepairMode,
  };
}

function parseMinimumWordsInput(value: string): NumberInputDraft {
  if (value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : '';
}

function collectLeafItems(items: OutlineItem[]): OutlineItem[] {
  return items.flatMap((item) => item.children?.length ? collectLeafItems(item.children) : [item]);
}

function findItem(items: OutlineItem[], id: string): OutlineItem | null {
  for (const item of items) {
    if (item.id === id) {
      return item;
    }

    if (item.children?.length) {
      const found = findItem(item.children, id);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function countWords(content: string) {
  return countReadableWords(content);
}

function getLeafContent(item: OutlineItem, sections: ContentGenerationSections) {
  return sections[item.id]?.content || item.content || '';
}

function getLeafStatus(item: OutlineItem, sections: ContentGenerationSections): ContentGenerationSectionStatus {
  const section = sections[item.id];
  if (section?.status) {
    return section.status;
  }

  return getLeafContent(item, sections).trim() ? 'success' : 'idle';
}

function getTreeStatus(item: OutlineItem, sections: ContentGenerationSections): TreeStatus {
  if (!item.children?.length) {
    return getLeafStatus(item, sections);
  }

  const childStatuses = item.children.map((child) => getTreeStatus(child, sections));
  if (childStatuses.some((status) => status === 'running')) {
    return 'running';
  }
  if (childStatuses.every((status) => status === 'success')) {
    return 'success';
  }
  if (childStatuses.some((status) => status === 'error')) {
    return 'error';
  }
  if (childStatuses.some((status) => status === 'success' || status === 'partial')) {
    return 'partial';
  }

  return 'idle';
}

function getParentStatus(childStatuses: TreeStatus[]): TreeStatus {
  if (childStatuses.some((status) => status === 'running')) return 'running';
  if (childStatuses.every((status) => status === 'success')) return 'success';
  if (childStatuses.some((status) => status === 'error')) return 'error';
  if (childStatuses.some((status) => status === 'success' || status === 'partial')) return 'partial';
  if (childStatuses.some((status) => status === 'planning')) return 'planning';
  return 'idle';
}

function buildOutlineMeta(items: OutlineItem[], sections: ContentGenerationSections, planning: boolean) {
  const meta = new Map<string, OutlineNodeMeta>();

  function visit(item: OutlineItem): OutlineNodeMeta {
    if (!item.children?.length) {
      const baseStatus = getLeafStatus(item, sections);
      const status: TreeStatus = planning && baseStatus === 'idle' ? 'planning' : baseStatus;
      const nodeMeta: OutlineNodeMeta = { status, leafCount: 1, words: countWords(getLeafContent(item, sections)) };
      meta.set(item.id, nodeMeta);
      return nodeMeta;
    }

    const children = item.children.map(visit);
    const nodeMeta = {
      status: getParentStatus(children.map((child) => child.status)),
      leafCount: children.reduce((sum, child) => sum + child.leafCount, 0),
      words: children.reduce((sum, child) => sum + child.words, 0),
    };
    meta.set(item.id, nodeMeta);
    return nodeMeta;
  }

  items.forEach(visit);
  return meta;
}

const MarkdownContent = memo(function MarkdownContent({ content, onPreviewImage }: { content: string; onPreviewImage: (src: string, alt: string) => void }) {
  return (
    <MarkdownRenderer
      imageMode="preview"
      imageClassName="markdown-clickable-image"
      renderMermaid
      onPreviewImage={onPreviewImage}
    >
      {content}
    </MarkdownRenderer>
  );
});

function ContentEditPage({
  workflowKind,
  outlineData,
  task,
  contentGenerationOptions,
  sections,
  onContentGenerationOptionsChange,
  onContentSaved,
}: ContentEditPageProps) {
  const { showToast } = useToast();
  const isExpansionWorkflow = workflowKind === 'existing-plan-expansion';
  const leaves = useMemo(() => outlineData?.outline ? collectLeafItems(outlineData.outline) : [], [outlineData]);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [draftContent, setDraftContent] = useState('');
  const [confirmRegenerateItem, setConfirmRegenerateItem] = useState<OutlineItem | null>(null);
  const [requirementItem, setRequirementItem] = useState<OutlineItem | null>(null);
  const [regenerateRequirement, setRegenerateRequirement] = useState('');
  const [statsCollapsed, setStatsCollapsed] = useState(false);
  const [imageModelStatus, setImageModelStatus] = useState<ImageModelStatus>('untested');
  const [generationDialogOpen, setGenerationDialogOpen] = useState(false);
  const [draftGenerationOptions, setDraftGenerationOptions] = useState<DraftContentGenerationOptions>(defaultContentGenerationOptions);
  const [htmlImageTypesDialogOpen, setHtmlImageTypesDialogOpen] = useState(false);
  const [htmlImageTypesDraft, setHtmlImageTypesDraft] = useState(DEFAULT_HTML_IMAGE_TYPES);
  const [pendingMinimumWordsChoice, setPendingMinimumWordsChoice] = useState<PendingMinimumWordsChoice | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const [pausePending, setPausePending] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormatConfig>(DEFAULT_EXPORT_FORMAT);
  const firstLeafId = leaves[0]?.id || '';
  const selectedItem = outlineData?.outline && selectedItemId ? findItem(outlineData.outline, selectedItemId) : null;
  const selectedIsLeaf = Boolean(selectedItem && !selectedItem.children?.length);
  const selectedContent = selectedItem && selectedIsLeaf ? getLeafContent(selectedItem, sections) : '';
  const exportFormatPreviewStyle = useMemo<CSSProperties>(() => buildExportFormatCssVars(exportFormat), [exportFormat]);
  const running = task?.status === 'running';
  const pausing = task?.status === 'pausing' || pausePending;
  const paused = task?.status === 'paused';
  const taskFailed = task?.status === 'error';
  const taskInFlight = running || pausing;
  const phaseVisible = taskInFlight || paused || taskFailed;
  const taskBlocksGeneration = taskInFlight || paused;
  const generationStrategyLocked = paused;
  const contentStats = task?.stats?.content;
  const planning = phaseVisible && contentStats?.phase === 'planning';
  const restoring = phaseVisible && contentStats?.phase === 'restoring';
  const outlineExpanding = phaseVisible && contentStats?.phase === 'outline-expanding';
  const expanding = phaseVisible && contentStats?.phase === 'expanding';
  const originalAuditing = phaseVisible && contentStats?.phase === 'original-auditing';
  const auditing = phaseVisible && contentStats?.phase === 'auditing';
  const tableCleaning = phaseVisible && contentStats?.phase === 'table-cleaning';
  const contentCorrecting = originalAuditing || auditing || tableCleaning;
  const illustrationPlanning = phaseVisible && contentStats?.phase === 'illustration-planning';
  const illustrationGenerating = phaseVisible && contentStats?.phase === 'illustration-generating';
  const outlineMeta = useMemo(() => outlineData?.outline ? buildOutlineMeta(outlineData.outline, sections, planning) : new Map<string, OutlineNodeMeta>(), [outlineData, planning, sections]);
  const contentSummary = useMemo(() => leaves.reduce((summary, item) => {
    const status = getLeafStatus(item, sections);
    return {
      completedCount: summary.completedCount + (status === 'success' ? 1 : 0),
      failedCount: summary.failedCount + (status === 'error' ? 1 : 0),
      totalWords: summary.totalWords + (outlineMeta.get(item.id)?.words || 0),
    };
  }, { completedCount: 0, failedCount: 0, totalWords: 0 }), [leaves, outlineMeta, sections]);
  const { completedCount, failedCount, totalWords } = contentSummary;
  const progress = leaves.length ? Math.round((completedCount / leaves.length) * 100) : 0;
  const planningTotal = contentStats?.planning_total || leaves.length;
  const planningCompleted = contentStats?.planning_completed || 0;
  const planningProgress = planningTotal ? Math.round((planningCompleted / planningTotal) * 100) : 0;
  const outlineExpansionTotal = contentStats?.outline_expansion_total || 3;
  const outlineExpansionCompleted = contentStats?.outline_expansion_completed || 0;
  const outlineExpansionStepTotal = contentStats?.outline_expansion_step_total || outlineExpansionTotal;
  const outlineExpansionStepCompleted = contentStats?.outline_expansion_step_total
    ? contentStats?.outline_expansion_step_completed || 0
    : outlineExpansionCompleted;
  const outlineExpansionRound = contentStats?.outline_expansion_round || Math.min(outlineExpansionCompleted + 1, outlineExpansionTotal);
  const outlineExpansionRoundTotal = contentStats?.outline_expansion_round_total || outlineExpansionTotal;
  const outlineExpansionStepLabel = contentStats?.outline_expansion_step_label || '';
  const outlineExpansionProgress = outlineExpansionStepTotal ? Math.round((outlineExpansionStepCompleted / outlineExpansionStepTotal) * 100) : 0;
  const minimumWords = contentStats?.minimum_words ?? contentGenerationOptions?.minimumWords ?? 0;
  const currentWords = contentStats?.current_words ?? totalWords;
  const minimumWordsUnmet = minimumWords > 0 && currentWords < minimumWords;
  const canRetryMinimumWords = taskFailed && minimumWordsUnmet && completedCount === leaves.length;
  const canRetryContentCorrection = taskFailed
    && leaves.length > 0
    && completedCount === leaves.length
    && ['original-auditing', 'auditing', 'table-cleaning', 'illustration-planning', 'illustration-generating'].includes(String(contentStats?.phase || ''));
  const retryingIllustrationPlanning = canRetryContentCorrection && contentStats?.phase === 'illustration-planning';
  const retryingIllustrationGeneration = canRetryContentCorrection && contentStats?.phase === 'illustration-generating';
  const latestTaskLog = task?.logs?.[task.logs.length - 1] || '';
  const taskErrorMessage = task?.error || latestTaskLog || '正文生成任务失败';
  const wordExpansionProgress = minimumWords ? Math.min(100, Math.round((currentWords / minimumWords) * 100)) : 0;
  const auditGroupTotal = contentStats?.audit_group_total || 0;
  const auditGroupCompleted = contentStats?.audit_group_completed || 0;
  const auditConflictTotal = contentStats?.audit_conflict_total || 0;
  const auditFixTotal = contentStats?.audit_fix_total || 0;
  const auditFixCompleted = contentStats?.audit_fix_completed || 0;
  const auditFixFailed = contentStats?.audit_fix_failed || 0;
  const auditAgentMode = contentStats?.audit_repair_mode === 'agent';
  const auditAgentStepTotal = contentStats?.audit_agent_step_total || 0;
  const auditAgentStepCompleted = contentStats?.audit_agent_step_completed || 0;
  const auditAgentStepLabel = contentStats?.audit_agent_step_label || '';
  const auditAgentChangedSections = contentStats?.audit_agent_changed_sections || 0;
  const auditAgentFailedSections = contentStats?.audit_agent_failed_sections || 0;
  const auditProgress = auditAgentMode && auditAgentStepTotal
    ? Math.round((auditAgentStepCompleted / auditAgentStepTotal) * 100)
    : auditFixTotal
    ? Math.round((auditFixCompleted / auditFixTotal) * 100)
    : auditGroupTotal
      ? Math.round((auditGroupCompleted / auditGroupTotal) * 100)
      : 0;
  const tableCleanupTotal = contentStats?.table_cleanup_total || 0;
  const tableCleanupCompleted = contentStats?.table_cleanup_completed || 0;
  const tableCleanupRewritten = contentStats?.table_cleanup_rewritten || 0;
  const tableCleanupSkipped = contentStats?.table_cleanup_skipped || 0;
  const tableCleanupProgress = tableCleanupTotal ? Math.round((tableCleanupCompleted / tableCleanupTotal) * 100) : 0;
  const auditCorrectionCount = auditFixTotal
    ? `${auditFixCompleted}/${auditFixTotal}`
    : auditAgentMode && auditAgentStepTotal
      ? `${auditAgentStepCompleted}/${auditAgentStepTotal}`
      : auditGroupTotal
        ? `${auditGroupCompleted}/${auditGroupTotal}`
        : '检查中';
  const contentCorrectionProgress = tableCleaning ? tableCleanupProgress : auditProgress;
  const contentCorrectionCount = tableCleaning
    ? tableCleanupTotal ? `${tableCleanupCompleted}/${tableCleanupTotal}` : '检查中'
    : auditCorrectionCount;
  const illustrationPlanningStepTotal = contentStats?.illustration_planning_step_total || 3;
  const illustrationPlanningStepCompleted = contentStats?.illustration_planning_step_completed || 0;
  const illustrationPlanningStepLabel = contentStats?.illustration_planning_step_label || '';
  const illustrationCandidateTotal = (contentStats?.illustration_candidate_html || 0)
    + (contentStats?.illustration_candidate_mermaid || 0)
    + (contentStats?.illustration_candidate_ai || 0);
  const illustrationSelectedTotal = (contentStats?.illustration_selected_html || 0)
    + (contentStats?.illustration_selected_mermaid || 0)
    + (contentStats?.illustration_selected_ai || 0);
  const illustrationPlanningProgress = Math.round((illustrationPlanningStepCompleted / illustrationPlanningStepTotal) * 100);
  const illustrationGenerationTotal = contentStats?.illustration_generation_total || 0;
  const illustrationGenerationCompleted = contentStats?.illustration_generation_completed || 0;
  const illustrationGenerationProgress = illustrationGenerationTotal ? Math.round((illustrationGenerationCompleted / illustrationGenerationTotal) * 100) : 0;
  const illustrationGenerationStepLabel = contentStats?.illustration_generation_step_label || '';
  const illustrationGenerationCount = `HTML ${contentStats?.illustration_generation_html_completed || 0}/${contentStats?.illustration_generation_html_total || 0}，Mermaid ${contentStats?.illustration_generation_mermaid_completed || 0}/${contentStats?.illustration_generation_mermaid_total || 0}，AI ${contentStats?.illustration_generation_ai_completed || 0}/${contentStats?.illustration_generation_ai_total || 0}`;
  const displayProgress = planning ? planningProgress : outlineExpanding ? outlineExpansionProgress : expanding ? wordExpansionProgress : contentCorrecting ? contentCorrectionProgress : illustrationPlanning ? illustrationPlanningProgress : illustrationGenerating ? illustrationGenerationProgress : progress;
  const displayProgressLabel = planning ? '编排统计' : restoring ? '原方案还原' : outlineExpanding ? '补目录' : expanding ? '扩写进度' : contentCorrecting ? '内容矫正' : illustrationPlanning ? '图片编排' : illustrationGenerating ? '图片生成' : '生成统计';
  const displayProgressCount = planning
    ? `${planningCompleted}/${planningTotal}`
    : outlineExpanding
      ? `${outlineExpansionStepCompleted}/${outlineExpansionStepTotal}`
      : expanding
        ? `${wordExpansionProgress}%`
        : contentCorrecting
          ? contentCorrectionCount
          : illustrationPlanning
            ? `${illustrationPlanningStepCompleted}/${illustrationPlanningStepTotal}`
            : illustrationGenerating
              ? `${illustrationGenerationCompleted}/${illustrationGenerationTotal}`
            : `${completedCount}/${leaves.length}`;
  const progressPhaseLabel = planning ? '正文编排' : restoring ? '原方案还原' : outlineExpanding ? '正文补目录' : expanding ? '正文扩写' : contentCorrecting ? '内容矫正' : illustrationPlanning ? '全文图片编排' : illustrationGenerating ? '全文图片生成' : '正文生成';
  const progressTrackClass = `content-generation-progress-track${planning ? ' is-planning' : ''}${outlineExpanding ? ' is-outline-expanding' : ''}${contentCorrecting ? ' is-auditing' : ''}${illustrationPlanning || illustrationGenerating ? ' is-illustration-planning' : ''}${taskInFlight && (planning || outlineExpanding || expanding || contentCorrecting || illustrationPlanning || illustrationGenerating) ? ' is-active' : ''}`;
  const progressDescription = taskFailed
    ? minimumWordsUnmet
      ? `正文扩写失败：当前 ${currentWords}/${minimumWords} 字。${taskErrorMessage}`
      : taskErrorMessage
    : planning
    ? paused ? `正文生成已暂停在编排阶段，已完成 ${planningCompleted}/${planningTotal} 个小节。` : `正在编排正文结构，已完成 ${planningCompleted}/${planningTotal} 个小节。`
    : outlineExpanding
      ? paused
        ? `正文生成已暂停在补目录阶段，第 ${outlineExpansionRound}/${outlineExpansionRoundTotal} 轮，已完成 ${outlineExpansionStepCompleted}/${outlineExpansionStepTotal} 步。${outlineExpansionStepLabel}`
        : `正在补目录，第 ${outlineExpansionRound}/${outlineExpansionRoundTotal} 轮：${outlineExpansionStepLabel || `已完成 ${outlineExpansionCompleted}/${outlineExpansionTotal} 轮`}`
      : expanding
        ? paused ? `正文生成已暂停在扩写阶段，最低字数达成 ${wordExpansionProgress}%。` : `正在扩写正文，最低字数达成 ${wordExpansionProgress}%。`
        : originalAuditing
            ? paused
              ? auditAgentMode
                ? `内容矫正已暂停在原方案覆盖 Agent 修复阶段，步骤 ${auditAgentStepCompleted}/${auditAgentStepTotal}。${auditAgentStepLabel}`
                : `内容矫正已暂停在原方案覆盖检查阶段，审计 ${auditGroupCompleted}/${auditGroupTotal} 个小节，修复 ${auditFixCompleted}/${auditFixTotal} 个小节。`
              : auditAgentMode
                ? auditAgentFailedSections
                  ? `原方案覆盖 Agent 修复未完成：${auditAgentFailedSections} 个小节需人工核对，任务将继续进入后续流程。`
                  : auditAgentStepCompleted >= auditAgentStepTotal && auditAgentChangedSections
                    ? `原方案覆盖 Agent 修复完成：已回写 ${auditAgentChangedSections} 个小节。`
                    : `正在内容矫正：${auditAgentStepLabel || 'Agent 正在检查并补回原方案内容'}，步骤 ${auditAgentStepCompleted}/${auditAgentStepTotal || 5}。`
                : auditFixTotal
                ? `正在内容矫正：补写原方案缺失内容，已完成 ${auditFixCompleted}/${auditFixTotal} 个小节${auditFixFailed ? `，${auditFixFailed} 个需人工核对` : ''}。`
                : `正在内容矫正：检查原方案覆盖情况，已完成 ${auditGroupCompleted}/${auditGroupTotal} 个小节${auditConflictTotal ? `，发现 ${auditConflictTotal} 个需核对来源段` : ''}。`
          : auditing
            ? paused
              ? auditAgentMode
                ? `内容矫正已暂停在 Agent 全文一致性修复阶段，步骤 ${auditAgentStepCompleted}/${auditAgentStepTotal}。${auditAgentStepLabel}`
                : `内容矫正已暂停在全文一致性检查阶段，审计 ${auditGroupCompleted}/${auditGroupTotal} 组，修复 ${auditFixCompleted}/${auditFixTotal} 个小节。`
              : auditAgentMode
                ? auditAgentStepCompleted >= auditAgentStepTotal && auditAgentChangedSections
                  ? `Agent 一致性修复完成：已回写 ${auditAgentChangedSections} 个小节。`
                  : `正在内容矫正：${auditAgentStepLabel || 'Agent 正在审计并修复全文'}，步骤 ${auditAgentStepCompleted}/${auditAgentStepTotal || 5}。`
                : auditFixTotal
                ? `正在内容矫正：修复一致性冲突，已完成 ${auditFixCompleted}/${auditFixTotal} 个小节${auditFixFailed ? `，${auditFixFailed} 个需人工核对` : ''}。`
                : `正在内容矫正：检查全文一致性，已完成 ${auditGroupCompleted}/${auditGroupTotal} 组${auditConflictTotal ? `，发现 ${auditConflictTotal} 个冲突小节` : ''}。`
            : tableCleaning
              ? paused
                ? `内容矫正已暂停在表格清理阶段，已处理 ${tableCleanupCompleted}/${tableCleanupTotal} 个表格。`
                : tableCleanupTotal
                  ? `正在内容矫正：将表格转换为普通文字描述，已处理 ${tableCleanupCompleted}/${tableCleanupTotal} 个表格，已转换 ${tableCleanupRewritten} 个${tableCleanupSkipped ? `，跳过 ${tableCleanupSkipped} 个` : ''}。`
                  : '正在内容矫正：检查正文中是否存在需要转换的表格。'
              : illustrationPlanning
                ? paused
                  ? `正文生成已暂停在全文图片编排阶段，步骤 ${illustrationPlanningStepCompleted}/${illustrationPlanningStepTotal}。${illustrationPlanningStepLabel}`
                  : `${illustrationPlanningStepLabel || 'Agent 正在阅读全文并编排图片'}，步骤 ${illustrationPlanningStepCompleted}/${illustrationPlanningStepTotal}${illustrationCandidateTotal ? `，候选 ${illustrationCandidateTotal} 项，保留 ${illustrationSelectedTotal} 项` : ''}。`
                : illustrationGenerating
                  ? paused
                    ? `正文生成已暂停在图片生成阶段，已完成 ${illustrationGenerationCompleted}/${illustrationGenerationTotal} 项。${illustrationGenerationCount}`
                    : `${illustrationGenerationStepLabel || '正在根据最终正文生成图片'}，已完成 ${illustrationGenerationCompleted}/${illustrationGenerationTotal} 项。${illustrationGenerationCount}`
                : pausing
                  ? '正在暂停正文生成，已发出的 AI 请求完成后会停止调度新任务。'
                  : running
                    ? latestTaskLog || '正文生成任务正在运行。'
                    : paused
                      ? '正文生成已暂停，可导出当前已完成内容或点击继续。'
                      : completedCount
                        ? `已生成 ${completedCount} 个小节，共 ${totalWords} 字。`
                        : '点击生成正文后，目录会实时显示每个小节状态。';
  const selectedStatus = selectedItem ? outlineMeta.get(selectedItem.id)?.status || 'idle' : 'idle';
  const generationButtonLabel = pausing
    ? '正在暂停中...'
    : running
      ? '暂停'
      : paused
        ? '继续'
        : canRetryContentCorrection
          ? retryingIllustrationGeneration ? '重试图片生成' : retryingIllustrationPlanning ? '重试图片编排' : '重试内容矫正'
          : canRetryMinimumWords
            ? '继续补足字数'
            : completedCount === leaves.length && leaves.length
              ? '重新生成正文'
              : completedCount > 0
                ? '继续生成正文'
                : '生成正文';
  const editing = Boolean(selectedItem && selectedIsLeaf && editingItemId === selectedItem.id);
  const imageModelAvailable = imageModelStatus === 'available';

  const handlePreviewImage = useCallback((src: string, alt: string) => setPreviewImage({ src, alt }), []);

  useEffect(() => {
    if (!outlineData?.outline?.length) {
      setSelectedItemId('');
      return;
    }

    if (!selectedItemId || !findItem(outlineData.outline, selectedItemId)) {
      setSelectedItemId(firstLeafId || outlineData.outline[0].id);
    }
  }, [firstLeafId, outlineData, selectedItemId]);

  useEffect(() => {
    window.yibiao?.config.load()
      .then((config) => {
        setImageModelStatus(config.image_model?.status || 'untested');
        if (config.export_format) {
          setExportFormat(config.export_format);
        }
      })
      .catch((error) => console.warn('读取开发者模式失败', error));
  }, []);

  useEffect(() => {
    if (task?.status !== 'running') {
      setPausePending(false);
    }
  }, [task?.status]);

  useEffect(() => {
    if (!selectedItem || selectedItem.id === editingItemId) {
      return;
    }
    setEditingItemId(null);
    setIsPreviewing(false);
    setDraftContent('');
  }, [editingItemId, selectedItem]);

  const openGenerationDialog = async () => {
    if (!outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }
    if (taskInFlight) {
      showToast('正文生成任务进行中，请暂停后再修改配置', 'info');
      return;
    }

    try {
      const config = await window.yibiao?.config.load();
      const nextStatus = config?.image_model?.status || 'untested';
      const available = nextStatus === 'available';
      setImageModelStatus(nextStatus);
      setDraftGenerationOptions(normalizeGenerationOptions(contentGenerationOptions, available, leaves.length, isExpansionWorkflow));
      setGenerationDialogOpen(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取生成配置失败', 'error');
    }
  };

  const saveDraftGenerationOptions = async (showSuccess: boolean, imageAvailable = imageModelAvailable) => {
    const normalizedDraftOptions = normalizeGenerationOptions(draftGenerationOptions, imageAvailable, leaves.length, isExpansionWorkflow);
    const currentOptions = contentGenerationOptions
      ? { ...defaultContentGenerationOptions, ...contentGenerationOptions }
      : normalizeGenerationOptions(undefined, imageAvailable, leaves.length, isExpansionWorkflow);
    const nextOptions = paused ? currentOptions : normalizedDraftOptions;
    await onContentGenerationOptionsChange(nextOptions);
    setDraftGenerationOptions(normalizeGenerationOptions(nextOptions, imageAvailable, leaves.length, isExpansionWorkflow));

    if (showSuccess) {
      setGenerationDialogOpen(false);
      showToast('正文生成配置已保存', 'success');
    }

    return nextOptions;
  };

  const saveGenerationOptions = async () => {
    try {
      await saveDraftGenerationOptions(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '正文生成配置保存失败', 'error');
    }
  };

  // 打开 HTML 图片类型设置并建立独立草稿。
  const openHtmlImageTypesDialog = () => {
    setHtmlImageTypesDraft(draftGenerationOptions.htmlImageTypes);
    setHtmlImageTypesDialogOpen(true);
  };

  // 确认 HTML 图片类型设置并写回主配置草稿。
  const confirmHtmlImageTypes = () => {
    setDraftGenerationOptions((prev) => ({ ...prev, htmlImageTypes: htmlImageTypesDraft }));
    setHtmlImageTypesDialogOpen(false);
  };

  const shouldAskMinimumWordsChoice = (options: ContentGenerationOptions) => leaves.length > 0
    && completedCount === leaves.length
    && !canRetryMinimumWords
    && options.minimumWords > 0
    && totalWords < options.minimumWords;

  const openGenerationChoiceOrDialog = async () => {
    if (!outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }
    if (taskInFlight) {
      showToast('正文生成任务进行中，请暂停后再修改配置', 'info');
      return;
    }

    try {
      const config = await window.yibiao?.config.load();
      const nextStatus = config?.image_model?.status || 'untested';
      const available = nextStatus === 'available';
      const savedOptions = normalizeGenerationOptions(contentGenerationOptions, available, leaves.length, isExpansionWorkflow);
      setImageModelStatus(nextStatus);
      if (shouldAskMinimumWordsChoice(savedOptions)) {
        setPendingMinimumWordsChoice({
          options: savedOptions,
          imageModelAvailable: available,
          config: config || null,
          currentWords: totalWords,
          minimumWords: savedOptions.minimumWords,
        });
        return;
      }

      setDraftGenerationOptions(savedOptions);
      setGenerationDialogOpen(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取生成配置失败', 'error');
    }
  };

  const pauseGeneration = async () => {
    if (!running) {
      return;
    }

    setPausePending(true);
    try {
      await window.yibiao?.tasks.pauseContentGeneration();
      showToast('正在暂停正文生成，当前 AI 请求完成后会停止调度新任务', 'info');
    } catch (error) {
      setPausePending(false);
      showToast(error instanceof Error ? error.message : '暂停正文生成失败', 'error');
    }
  };

  const resumeGeneration = async () => {
    if (!paused) {
      return;
    }

    try {
      await window.yibiao?.tasks.startContentGeneration({ resume: true });
      showToast('已继续正文生成任务', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '继续正文生成失败', 'error');
    }
  };

  const retryContentCorrection = async () => {
    if (!canRetryContentCorrection) {
      return;
    }

    try {
      await window.yibiao?.tasks.startContentGeneration({ retryContentCorrection: true });
      showToast(retryingIllustrationPlanning ? '全文图片编排重试任务已在后台启动' : '内容矫正重试任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : retryingIllustrationPlanning ? '重试全文图片编排失败' : '重试内容矫正失败', 'error');
    }
  };

  const handleGenerationButtonClick = () => {
    if (running) {
      void pauseGeneration();
      return;
    }
    if (paused) {
      void resumeGeneration();
      return;
    }
    if (canRetryContentCorrection) {
      void retryContentCorrection();
      return;
    }
    if (completedCount === leaves.length && leaves.length) {
      void openGenerationChoiceOrDialog();
      return;
    }
    void openGenerationDialog();
  };

  const launchContentGeneration = async ({
    savedGenerationOptions,
    nextImageModelAvailable,
    config,
    regenerate,
    contentGenerationAction,
  }: {
    savedGenerationOptions: ContentGenerationOptions;
    nextImageModelAvailable: boolean;
    config?: ClientConfig | null;
    regenerate: boolean;
    contentGenerationAction: ContentGenerationAction;
  }) => {
    if (!outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }

    if (regenerate) {
      setEditingItemId(null);
      setIsPreviewing(false);
      setDraftContent('');
    }

    await window.yibiao?.tasks.startContentGeneration({
      regenerate,
      generationOptions: {
        useAiImages: nextImageModelAvailable && savedGenerationOptions.useAiImages,
        maxAiImages: savedGenerationOptions.maxAiImages,
        useMermaidImages: savedGenerationOptions.useMermaidImages,
        maxMermaidImages: savedGenerationOptions.maxMermaidImages,
        useHtmlImages: savedGenerationOptions.useHtmlImages,
        maxHtmlImages: savedGenerationOptions.maxHtmlImages,
        htmlImageTypes: savedGenerationOptions.htmlImageTypes,
        tableRequirement: savedGenerationOptions.tableRequirement,
        minimumWords: savedGenerationOptions.minimumWords,
        enableConsistencyAudit: savedGenerationOptions.enableConsistencyAudit,
        consistencyRepairMode: savedGenerationOptions.consistencyRepairMode,
        enableOriginalPlanCoverageAudit: isExpansionWorkflow && savedGenerationOptions.enableOriginalPlanCoverageAudit,
        originalPlanCoverageRepairMode: isExpansionWorkflow ? savedGenerationOptions.originalPlanCoverageRepairMode : undefined,
      },
    });
    trackConfigUsage({
      table_requirement: savedGenerationOptions.tableRequirement,
      use_mermaid_images: savedGenerationOptions.useMermaidImages,
      use_ai_images: nextImageModelAvailable && savedGenerationOptions.useAiImages,
      content_generation_action: contentGenerationAction,
      minimum_words: savedGenerationOptions.minimumWords,
      enable_consistency_audit: savedGenerationOptions.enableConsistencyAudit,
      consistency_repair_mode: savedGenerationOptions.enableConsistencyAudit ? savedGenerationOptions.consistencyRepairMode : undefined,
      enable_original_plan_coverage_audit: isExpansionWorkflow && savedGenerationOptions.enableOriginalPlanCoverageAudit,
      original_plan_coverage_repair_mode: isExpansionWorkflow && savedGenerationOptions.enableOriginalPlanCoverageAudit ? savedGenerationOptions.originalPlanCoverageRepairMode : undefined,
    }, config);
    setGenerationDialogOpen(false);
    setPendingMinimumWordsChoice(null);
    showToast(contentGenerationAction === 'retry_minimum_words' ? '正文补足字数任务已在后台启动' : regenerate ? '正文重新生成任务已在后台启动' : '正文生成任务已在后台启动', 'success');
  };

  const startGeneration = async () => {
    if (!outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }

    try {
      const config = await window.yibiao?.config.load();
      const nextImageModelStatus = config?.image_model?.status || 'untested';
      const nextImageModelAvailable = nextImageModelStatus === 'available';
      setImageModelStatus(nextImageModelStatus);
      const savedGenerationOptions = await saveDraftGenerationOptions(false, nextImageModelAvailable);
      if (shouldAskMinimumWordsChoice(savedGenerationOptions)) {
        setPendingMinimumWordsChoice({
          options: savedGenerationOptions,
          imageModelAvailable: nextImageModelAvailable,
          config: config || null,
          currentWords: totalWords,
          minimumWords: savedGenerationOptions.minimumWords,
        });
        setGenerationDialogOpen(false);
        return;
      }

      const regenerate = leaves.length > 0 && completedCount === leaves.length && !canRetryMinimumWords;
      const contentGenerationAction: ContentGenerationAction = canRetryMinimumWords
        ? 'retry_minimum_words'
        : regenerate
          ? 'regenerate'
          : completedCount > 0
            ? 'continue'
            : 'start';
      await launchContentGeneration({ savedGenerationOptions, nextImageModelAvailable, config, regenerate, contentGenerationAction });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动正文生成任务失败', 'error');
    }
  };

  const continueMinimumWordsExpansion = async () => {
    if (!pendingMinimumWordsChoice) {
      return;
    }

    try {
      await launchContentGeneration({
        savedGenerationOptions: pendingMinimumWordsChoice.options,
        nextImageModelAvailable: pendingMinimumWordsChoice.imageModelAvailable,
        config: pendingMinimumWordsChoice.config,
        regenerate: false,
        contentGenerationAction: 'retry_minimum_words',
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动正文补足字数任务失败', 'error');
    }
  };

  const regenerateAfterMinimumWordsChoice = async () => {
    if (!pendingMinimumWordsChoice) {
      return;
    }

    try {
      await launchContentGeneration({
        savedGenerationOptions: pendingMinimumWordsChoice.options,
        nextImageModelAvailable: pendingMinimumWordsChoice.imageModelAvailable,
        config: pendingMinimumWordsChoice.config,
        regenerate: true,
        contentGenerationAction: 'regenerate',
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动正文重新生成任务失败', 'error');
    }
  };

  const startSectionRegeneration = async () => {
    if (!outlineData?.outline?.length || !requirementItem) {
      return;
    }

    try {
      const config = await window.yibiao?.config.load();
      const nextImageModelStatus = config?.image_model?.status || 'untested';
      const nextImageModelAvailable = nextImageModelStatus === 'available';
      const savedGenerationOptions = normalizeGenerationOptions(contentGenerationOptions, nextImageModelAvailable, leaves.length, isExpansionWorkflow);
      setImageModelStatus(nextImageModelStatus);
      await window.yibiao?.tasks.startContentGeneration({
        regenerate: true,
        targetItemId: requirementItem.id,
        requirement: regenerateRequirement,
        generationOptions: {
          useAiImages: nextImageModelAvailable && savedGenerationOptions.useAiImages,
          maxAiImages: savedGenerationOptions.maxAiImages,
          useMermaidImages: savedGenerationOptions.useMermaidImages,
          maxMermaidImages: savedGenerationOptions.maxMermaidImages,
          useHtmlImages: savedGenerationOptions.useHtmlImages,
          maxHtmlImages: savedGenerationOptions.maxHtmlImages,
          htmlImageTypes: savedGenerationOptions.htmlImageTypes,
          tableRequirement: savedGenerationOptions.tableRequirement,
          enableConsistencyAudit: savedGenerationOptions.enableConsistencyAudit,
          consistencyRepairMode: savedGenerationOptions.consistencyRepairMode,
          enableOriginalPlanCoverageAudit: isExpansionWorkflow && savedGenerationOptions.enableOriginalPlanCoverageAudit,
          originalPlanCoverageRepairMode: isExpansionWorkflow ? 'normal' : undefined,
        },
      });
      trackConfigUsage({
        table_requirement: savedGenerationOptions.tableRequirement,
        use_mermaid_images: savedGenerationOptions.useMermaidImages,
        use_ai_images: nextImageModelAvailable && savedGenerationOptions.useAiImages,
        content_generation_action: 'regenerate_section',
        minimum_words: savedGenerationOptions.minimumWords,
        enable_consistency_audit: savedGenerationOptions.enableConsistencyAudit,
        consistency_repair_mode: savedGenerationOptions.enableConsistencyAudit ? savedGenerationOptions.consistencyRepairMode : undefined,
        enable_original_plan_coverage_audit: isExpansionWorkflow && savedGenerationOptions.enableOriginalPlanCoverageAudit,
        original_plan_coverage_repair_mode: isExpansionWorkflow && savedGenerationOptions.enableOriginalPlanCoverageAudit ? 'normal' : undefined,
      }, config);
      setSelectedItemId(requirementItem.id);
      setRequirementItem(null);
      setRegenerateRequirement('');
      showToast('小节重新生成任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动小节重新生成失败', 'error');
    }
  };

  const startEditingContent = () => {
    if (taskBlocksGeneration) {
      showToast('请先完成当前正文生成任务，再编辑正文', 'info');
      return;
    }

    if (!selectedItem || !selectedIsLeaf) {
      showToast('请选择一个叶子小节后再编辑正文', 'info');
      return;
    }

    setEditingItemId(selectedItem.id);
    setIsPreviewing(false);
    setDraftContent(selectedContent);
  };

  const togglePreview = () => {
    setIsPreviewing((prev) => !prev);
  };

  const cancelEditingContent = () => {
    setEditingItemId(null);
    setIsPreviewing(false);
    setDraftContent('');
  };

  const saveEditingContent = async () => {
    if (taskBlocksGeneration) {
      showToast('当前正文生成任务正在运行或已暂停，暂不能保存正文', 'info');
      return;
    }

    if (!selectedItem || !selectedIsLeaf || !outlineData?.outline?.length) {
      return;
    }

    try {
      await onContentSaved(selectedItem, draftContent);
      setEditingItemId(null);
      setIsPreviewing(false);
      showToast('正文已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '正文保存失败', 'error');
    }
  };

  const renderTree = (items: OutlineItem[], level = 0): ReactNode => items.map((item) => {
    const meta = outlineMeta.get(item.id);
    const status = meta?.status || 'idle';
    const isLeaf = !item.children?.length;
    const leafCount = meta?.leafCount || 0;
    const words = meta?.words || 0;

    return (
      <div className="content-outline-node" key={item.id} style={{ '--content-level': level } as CSSProperties}>
        <button
          type="button"
          className={`content-outline-item is-${status}${selectedItemId === item.id ? ' is-active' : ''}`}
          onClick={() => setSelectedItemId(item.id)}
        >
          <span className="content-outline-dot" aria-hidden="true" />
          <span className="content-outline-text">
            <strong>{formatOutlineTitle(item.id, item.title, exportFormat.headings[Math.min(item.id.split('.').length - 1, 5)])}</strong>
            <small>{isLeaf ? `${statusLabels[status]} · ${words} 字` : `${statusLabels[status]} · ${leafCount} 个小节 · ${words} 字`}</small>
          </span>
          {isLeaf && (status === 'success' || status === 'error') ? (
            <Popover.Root
              open={confirmRegenerateItem?.id === item.id}
              onOpenChange={(open) => setConfirmRegenerateItem(open ? item : null)}
            >
              <Popover.Trigger asChild>
                <em
                  className="is-clickable"
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >{statusLabels[status]}</em>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="content-regenerate-popover" side="top" align="end" sideOffset={8}>
                  <strong>重新生成此小节？</strong>
                  <span>{status === 'error' ? '将重新尝试生成失败的小节。' : '将覆盖当前正文内容。'}</span>
                  <div>
                    <button
                      type="button"
                      className="primary-action"
                      disabled={taskBlocksGeneration}
                      onClick={() => {
                        setRequirementItem(item);
                        setRegenerateRequirement('');
                        setConfirmRegenerateItem(null);
                      }}
                    >是</button>
                    <Popover.Close className="secondary-action" type="button">否</Popover.Close>
                  </div>
                  <Popover.Arrow className="content-regenerate-popover-arrow" />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          ) : (
            <em>{statusLabels[status]}</em>
          )}
        </button>
        {item.children?.length ? renderTree(item.children, level + 1) : null}
      </div>
    );
  });

  if (!outlineData?.outline?.length) {
    return (
      <div className="plan-step-body content-generation-page">
        <section className="markdown-empty-state content-generation-empty">
          <strong>暂无目录</strong>
          <p>请先在目录生成步骤完成技术方案目录，再进入正文生成。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="plan-step-body content-generation-page">
      <section className="content-generation-command-bar">
        <div>
          <span className="section-kicker">STEP 05</span>
          <strong>正文生成</strong>
          <p>按目录叶子小节并发生成技术方案正文，页面切换不会中断后台任务。</p>
        </div>
        <div className="content-generation-stats" aria-label="正文生成统计">
          <span><strong>{leaves.length}</strong> 个小节</span>
          <span><strong>{completedCount}</strong> 已生成</span>
          <span><strong>{totalWords}</strong> 字</span>
        </div>
        <div className="content-generation-actions">
          <button
            type="button"
            className="outline-config-action"
            onClick={openGenerationDialog}
            disabled={taskInFlight || !leaves.length}
            aria-label="打开正文生成配置"
            title="正文生成配置"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 0 1-4 0v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 0 1 0-4h.08A1.7 1.7 0 0 0 4.6 8.93a1.7 1.7 0 0 0-.34-1.87l-.05-.05a2 2 0 0 1 2.83-2.83l.05.05a1.7 1.7 0 0 0 1.87.34A1.7 1.7 0 0 0 10 3.01V3a2 2 0 0 1 4 0v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 0 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
            </svg>
          </button>
          <button type="button" className="primary-action" onClick={handleGenerationButtonClick} disabled={pausing || !leaves.length}>
            {generationButtonLabel}
          </button>
        </div>
      </section>

      <section className="content-generation-workspace">
        <aside className="content-outline-panel">
          <div className="analysis-result-head">
            <strong>标书目录</strong>
            <span>{leaves.length} 个小节</span>
          </div>
          <div className={`content-outline-stats${statsCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setStatsCollapsed((prev) => !prev)} aria-expanded={!statsCollapsed}>
              <span>{displayProgressLabel}</span>
              <strong>{displayProgressCount}</strong>
              <em>{statsCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!statsCollapsed && (
              <div className="content-outline-stats-body">
                <div className={progressTrackClass} aria-label={`${progressPhaseLabel}进度 ${displayProgress}%`}>
                  <span style={{ width: `${displayProgress}%` }} />
                </div>
                <p>{progressDescription}</p>
                {failedCount > 0 && <small>失败 {failedCount} 个小节</small>}
              </div>
            )}
          </div>
          <div className="content-outline-list">
            {renderTree(outlineData.outline)}
          </div>
        </aside>

        <article className="content-reader-panel">
          <div className="content-reader-head">
            <div>
              <span className="section-kicker">正文内容</span>
              <strong>{selectedItem ? `${selectedItem.id} ${selectedItem.title}` : '选择小节'}</strong>
              <p>{selectedItem?.description || '选择左侧目录项查看生成正文。'}</p>
            </div>
            <div className="content-reader-actions">
              <span className={`content-status-badge is-${selectedStatus}`}>{statusLabels[selectedStatus]}</span>
              {editing ? (
                <>
                  <button type="button" className={isPreviewing ? 'secondary-action' : 'primary-action'} onClick={togglePreview}>
                    {isPreviewing ? '编辑' : '预览'}
                  </button>
                  <button type="button" className="primary-action" onClick={saveEditingContent} disabled={taskBlocksGeneration}>保存</button>
                  <button type="button" className="secondary-action" onClick={cancelEditingContent}>取消</button>
                </>
              ) : (
                <button type="button" className="secondary-action" onClick={startEditingContent} disabled={!selectedItem || !selectedIsLeaf || taskBlocksGeneration}>编辑</button>
              )}
            </div>
          </div>

          {selectedItem && selectedIsLeaf && editing && !isPreviewing ? (
            <MarkdownEditor
              value={draftContent}
              onChange={setDraftContent}
              placeholder="输入 Markdown 正文..."
              disabled={taskBlocksGeneration}
            />
          ) : selectedItem && selectedIsLeaf && editing && isPreviewing ? (
            <MarkdownFullscreenViewer className="markdown-viewer content-generation-output export-format-preview" style={exportFormatPreviewStyle} title="正文预览全屏查看">
              {draftContent.trim() ? (
                <MarkdownContent content={draftContent} onPreviewImage={handlePreviewImage} />
              ) : (
                <p className="content-editor-empty">暂无预览内容</p>
              )}
            </MarkdownFullscreenViewer>
          ) : selectedItem && selectedIsLeaf && selectedContent.trim() ? (
            <MarkdownFullscreenViewer className="markdown-viewer content-generation-output export-format-preview" style={exportFormatPreviewStyle} title={`${selectedItem.id} ${selectedItem.title}全屏查看`}>
              <MarkdownContent content={selectedContent} onPreviewImage={handlePreviewImage} />
            </MarkdownFullscreenViewer>
          ) : selectedItem && selectedIsLeaf ? (
            <div className="markdown-empty-state content-generation-empty">
              <strong>{getLeafStatus(selectedItem, sections) === 'error' ? sections[selectedItem.id]?.error || '正文生成失败' : '正文待生成'}</strong>
              <p>{taskInFlight ? '如果该小节正在生成，模型返回内容后会实时显示在这里。' : paused ? '任务已暂停，可先导出当前内容或点击继续。' : '点击生成正文后，后台会按目录小节生成内容。'}</p>
            </div>
          ) : (
            <div className="markdown-empty-state content-generation-empty">
              <strong>当前是目录分组</strong>
              <p>该目录下包含 {selectedItem?.children ? collectLeafItems(selectedItem.children).length : 0} 个小节，请选择叶子小节查看具体正文。</p>
            </div>
          )}
        </article>
      </section>

      <Dialog.Root
        open={generationDialogOpen}
        onOpenChange={(open) => {
          setGenerationDialogOpen(open);
          if (!open) setHtmlImageTypesDialogOpen(false);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-generation-config-card" aria-describedby={undefined}>
            <div className="content-regenerate-card-head">
              <Dialog.Title>正文生成配置</Dialog.Title>
            </div>
            <div className="content-generation-config-list">
              <label className="content-generation-config-row">
                <span>
                  <strong>表格需求</strong>
                </span>
                <select
                  value={draftGenerationOptions.tableRequirement}
                  disabled={generationStrategyLocked}
                  onChange={(event) => setDraftGenerationOptions((prev) => ({ ...prev, tableRequirement: event.target.value as ContentTableRequirement }))}
                >
                  {tableRequirementOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="content-generation-config-row">
                <span>
                  <strong>最低字数</strong>
                </span>
                <input
                  type="number"
                  min="0"
                  step="1000"
                  value={draftGenerationOptions.minimumWords}
                  disabled={generationStrategyLocked}
                  onChange={(event) => setDraftGenerationOptions((prev) => ({
                    ...prev,
                    minimumWords: parseMinimumWordsInput(event.target.value),
                  }))}
                />
              </label>
              <label className="content-generation-config-row">
                <span>
                  <strong>全文一致性审计</strong>
                </span>
                <Switch.Root
                  className="content-generation-switch"
                  checked={draftGenerationOptions.enableConsistencyAudit}
                  disabled={generationStrategyLocked}
                  onCheckedChange={(checked) => setDraftGenerationOptions((prev) => ({ ...prev, enableConsistencyAudit: checked }))}
                  aria-label="是否启用全文一致性审计"
                >
                  <Switch.Thumb className="content-generation-switch-thumb" />
                </Switch.Root>
              </label>
              {draftGenerationOptions.enableConsistencyAudit && (
                <label className="content-generation-config-row">
                  <span>
                    <strong>一致性修复方式</strong>
                  </span>
                  <select
                    value={draftGenerationOptions.consistencyRepairMode}
                    disabled={generationStrategyLocked}
                    onChange={(event) => setDraftGenerationOptions((prev) => ({ ...prev, consistencyRepairMode: event.target.value as ConsistencyRepairMode }))}
                  >
                    {consistencyRepairModeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                  </select>
                </label>
              )}
              {isExpansionWorkflow && (
                <>
                  <label className="content-generation-config-row">
                    <span>
                      <strong>原方案覆盖审计</strong>
                    </span>
                    <Switch.Root
                      className="content-generation-switch"
                      checked={draftGenerationOptions.enableOriginalPlanCoverageAudit}
                      disabled={generationStrategyLocked}
                      onCheckedChange={(checked) => setDraftGenerationOptions((prev) => ({ ...prev, enableOriginalPlanCoverageAudit: checked }))}
                      aria-label="是否启用原方案覆盖审计"
                    >
                      <Switch.Thumb className="content-generation-switch-thumb" />
                    </Switch.Root>
                  </label>
                  {draftGenerationOptions.enableOriginalPlanCoverageAudit && (
                    <label className="content-generation-config-row">
                      <span>
                        <strong>原方案覆盖修复方式</strong>
                      </span>
                      <select
                        value={draftGenerationOptions.originalPlanCoverageRepairMode}
                        disabled={generationStrategyLocked}
                        onChange={(event) => setDraftGenerationOptions((prev) => ({ ...prev, originalPlanCoverageRepairMode: event.target.value as OriginalPlanCoverageRepairMode }))}
                      >
                        {originalPlanCoverageRepairModeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                  )}
                </>
              )}
              <label className="content-generation-config-row">
                <span>
                  <strong>使用 AI 生图</strong>
                </span>
                <div className="content-generation-config-control">
                  <em className={`content-image-status is-${imageModelStatus}`}>{imageModelStatusLabels[imageModelStatus]}</em>
                  <Switch.Root
                    className="content-generation-switch"
                    checked={draftGenerationOptions.useAiImages && imageModelAvailable}
                    disabled={generationStrategyLocked || !imageModelAvailable}
                    onCheckedChange={(checked) => setDraftGenerationOptions((prev) => ({ ...prev, useAiImages: checked }))}
                    aria-label="是否使用 AI 生图"
                  >
                    <Switch.Thumb className="content-generation-switch-thumb" />
                  </Switch.Root>
                </div>
              </label>
              {draftGenerationOptions.useAiImages && imageModelAvailable && (
                <label className="content-generation-config-row">
                  <span><strong>AI 生图上限</strong></span>
                  <input
                    type="number"
                    min="0"
                    max={Math.max(1, leaves.length)}
                    value={draftGenerationOptions.maxAiImages}
                    disabled={generationStrategyLocked}
                    onChange={(event) => setDraftGenerationOptions((prev) => ({
                      ...prev,
                      maxAiImages: Math.max(0, Math.min(Number(event.target.value) || 0, Math.max(1, leaves.length))),
                    }))}
                  />
                </label>
              )}
              <label className="content-generation-config-row">
                <span><strong>使用 Mermaid 生图</strong></span>
                <Switch.Root
                  className="content-generation-switch"
                  checked={draftGenerationOptions.useMermaidImages}
                  disabled={generationStrategyLocked}
                  onCheckedChange={(checked) => setDraftGenerationOptions((prev) => ({ ...prev, useMermaidImages: checked }))}
                  aria-label="是否使用 Mermaid 生图"
                >
                  <Switch.Thumb className="content-generation-switch-thumb" />
                </Switch.Root>
              </label>
              {draftGenerationOptions.useMermaidImages && (
                <label className="content-generation-config-row">
                  <span><strong>Mermaid 生图上限</strong></span>
                  <input
                    type="number"
                    min="0"
                    max={Math.max(1, leaves.length)}
                    value={draftGenerationOptions.maxMermaidImages}
                    disabled={generationStrategyLocked}
                    onChange={(event) => setDraftGenerationOptions((prev) => ({
                      ...prev,
                      maxMermaidImages: Math.max(0, Math.min(Number(event.target.value) || 0, Math.max(1, leaves.length))),
                    }))}
                  />
                </label>
              )}
              <label className="content-generation-config-row">
                <span><strong>生成 HTML 图片</strong></span>
                <Switch.Root
                  className="content-generation-switch"
                  checked={draftGenerationOptions.useHtmlImages}
                  disabled={generationStrategyLocked}
                  onCheckedChange={(checked) => setDraftGenerationOptions((prev) => ({ ...prev, useHtmlImages: checked }))}
                  aria-label="是否生成 HTML 图片"
                >
                  <Switch.Thumb className="content-generation-switch-thumb" />
                </Switch.Root>
              </label>
              {draftGenerationOptions.useHtmlImages && (
                <>
                  <label className="content-generation-config-row">
                    <span><strong>HTML 生图上限</strong></span>
                    <input
                      type="number"
                      min="0"
                      max={Math.max(1, leaves.length)}
                      value={draftGenerationOptions.maxHtmlImages}
                      disabled={generationStrategyLocked}
                      onChange={(event) => setDraftGenerationOptions((prev) => ({
                        ...prev,
                        maxHtmlImages: Math.max(0, Math.min(Number(event.target.value) || 0, Math.max(1, leaves.length))),
                      }))}
                    />
                  </label>
                  <div className="content-generation-config-row">
                    <span><strong>高级设置</strong></span>
                    <button type="button" className="secondary-action" onClick={openHtmlImageTypesDialog} disabled={generationStrategyLocked}>打开</button>
                  </div>
                </>
              )}
            </div>
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="secondary-action" onClick={saveGenerationOptions} disabled={taskInFlight || paused}>
                保存配置
              </button>
              {!paused && <button type="button" className="primary-action" onClick={startGeneration} disabled={taskBlocksGeneration}>{canRetryMinimumWords ? '继续补足字数' : '开始生成'}</button>}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={htmlImageTypesDialogOpen} onOpenChange={setHtmlImageTypesDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal html-image-types-modal" />
          <Dialog.Content className="content-regenerate-card html-image-types-card" aria-describedby={undefined}>
            <div className="content-regenerate-card-head">
              <Dialog.Title>HTML 可生成的图片类型</Dialog.Title>
            </div>
            <textarea
              value={htmlImageTypesDraft}
              onChange={(event) => setHtmlImageTypesDraft(event.target.value)}
              aria-label="HTML 可生成的图片类型"
            />
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="primary-action" onClick={confirmHtmlImageTypes}>确认</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={Boolean(pendingMinimumWordsChoice)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingMinimumWordsChoice(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-generation-config-card">
            <div className="content-regenerate-card-head">
              <span className="section-kicker">补齐字数</span>
              <Dialog.Title>正文已生成，是否继续补齐字数？</Dialog.Title>
              <Dialog.Description>
                当前约 {pendingMinimumWordsChoice?.currentWords ?? totalWords} 字，新的最低字数为 {pendingMinimumWordsChoice?.minimumWords ?? 0} 字。可以保留现有正文继续补齐，也可以清空后重新生成。
              </Dialog.Description>
            </div>
            <div className="content-generation-config-note">
              选择“继续补齐字数”会保留已生成正文，仅执行补目录和正文扩写；选择“清空重新生成”会覆盖当前全部正文。
            </div>
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="secondary-action" onClick={regenerateAfterMinimumWordsChoice} disabled={taskBlocksGeneration}>清空重新生成</button>
              <button type="button" className="primary-action" onClick={continueMinimumWordsExpansion} disabled={taskBlocksGeneration}>继续补齐字数</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={Boolean(requirementItem)}
        onOpenChange={(open) => {
          if (!open) {
            setRequirementItem(null);
            setRegenerateRequirement('');
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card">
            <div className="content-regenerate-card-head">
              <span className="section-kicker">重新生成</span>
              <Dialog.Title>{requirementItem?.id} {requirementItem?.title}</Dialog.Title>
              <Dialog.Description>输入本次重新生成的具体要求，AI 会只覆盖当前小节正文。</Dialog.Description>
            </div>
            <textarea
              value={regenerateRequirement}
              onChange={(event) => setRegenerateRequirement(event.target.value)}
              placeholder="例如：强化实施步骤，减少背景描述，突出设备配置与运维响应。"
            />
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="primary-action" onClick={startSectionRegeneration} disabled={taskBlocksGeneration}>开始重新生成</button>
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
    </div>
  );
}

export default ContentEditPage;
