import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { trackConfigUsage } from '../../../shared/analytics/analytics';
import { AppDialog, MarkdownEditor, MarkdownFullscreenViewer, MarkdownRenderer, ProgressBar, useToast } from '../../../shared/ui';
import { OUTLINE_CONTENT_MODE_LABELS } from '../../../shared/types';
import type { ClientConfig, OutlineContentMode, TechnicalPlanOutlineData as OutlineData, TechnicalPlanOutlineItem as OutlineItem, OutlineWordControlOptions } from '../../../shared/types';
import { countReadableWords } from '../../../shared/utils/wordCount';
import type { BackgroundTaskState, ContentGenerationOptions, ContentGenerationRuntimeState, ContentGenerationSectionStatus, ContentGenerationSections } from '../types';
import ContentWordPreview from '../components/ContentWordPreview';
import { normalizeContentGenerationOptions } from '../contentGenerationOptions';
import type { ExportFormatConfig } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import { buildExportFormatCssVars } from '../../../shared/utils/exportFormatCss';
import { formatOutlineTitle } from '../../../shared/utils/outlineNumbering';

interface ContentEditPageProps {
  stepNumber: string;
  hasOriginalPlan: boolean;
  originalPlanContentHash?: string;
  outlineWordControlSnapshot?: OutlineWordControlOptions;
  outlineData: OutlineData | null;
  task?: BackgroundTaskState;
  contentGenerationRuntime?: ContentGenerationRuntimeState;
  contentGenerationOptions?: ContentGenerationOptions;
  exportTemplateId: string;
  sections: ContentGenerationSections;
  onOpenGenerationSettingsAppearance: () => void;
  onContentGenerationReset: () => Promise<void>;
  onContentSaved: (item: OutlineItem, content: string) => Promise<void> | void;
}

type TreeStatus = ContentGenerationSectionStatus | 'partial' | 'planning' | 'pending';

interface OutlineNodeMeta {
  status: TreeStatus;
  leafCount: number;
  words: number;
}

type ContentGenerationAction = 'start' | 'continue' | 'regenerate' | 'regenerate_section';

const statusLabels: Record<TreeStatus, string> = {
  idle: '待生成',
  running: '生成中',
  success: '已生成',
  error: '失败',
  ignored: '已忽略',
  partial: '部分生成',
  planning: '编排中',
  pending: '待处理',
};

const pendingModeDescriptions: Record<Exclude<OutlineContentMode, 'ai-generate'>, string> = {
  'template-fill': '该小节已标记为模板填写，后续将从招标文件提取并填充内容。',
  'directory-generate': '该小节已标记为目录生成，不进入 AI 正文生成流程。',
  'manual-fill': '该小节已标记为人工填写，请在导出后补充内容。',
  other: '该小节采用其他处理模式，暂不进入 AI 正文生成流程。',
};

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
  const section = sections[item.id];
  return section && Object.prototype.hasOwnProperty.call(section, 'content')
    ? section.content || ''
    : item.content || '';
}

function getLeafStatus(item: OutlineItem, sections: ContentGenerationSections): TreeStatus {
  const section = sections[item.id];
  if (section?.status) {
    return section.status;
  }

  if (getLeafContent(item, sections).trim()) return 'success';
  return item.content_mode === 'ai-generate' ? 'idle' : 'pending';
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
  if (childStatuses.every((status) => status === 'ignored')) {
    return 'ignored';
  }
  if (childStatuses.every((status) => status === 'pending')) {
    return 'pending';
  }
  if (childStatuses.some((status) => status === 'error')) {
    return 'error';
  }
  if (childStatuses.some((status) => status === 'success' || status === 'ignored' || status === 'partial' || status === 'pending')) {
    return 'partial';
  }

  return 'idle';
}

function getParentStatus(childStatuses: TreeStatus[]): TreeStatus {
  if (childStatuses.some((status) => status === 'running')) return 'running';
  if (childStatuses.every((status) => status === 'success')) return 'success';
  if (childStatuses.every((status) => status === 'ignored')) return 'ignored';
  if (childStatuses.every((status) => status === 'pending')) return 'pending';
  if (childStatuses.some((status) => status === 'error')) return 'error';
  if (childStatuses.some((status) => status === 'success' || status === 'ignored' || status === 'partial' || status === 'pending')) return 'partial';
  if (childStatuses.some((status) => status === 'planning')) return 'planning';
  return 'idle';
}

function buildOutlineMeta(items: OutlineItem[], sections: ContentGenerationSections, planning: boolean, sectionWords: Record<string, number> = {}) {
  const meta = new Map<string, OutlineNodeMeta>();

  function visit(item: OutlineItem): OutlineNodeMeta {
    if (!item.children?.length) {
      const baseStatus = getLeafStatus(item, sections);
      const status: TreeStatus = planning && item.content_mode === 'ai-generate' && baseStatus === 'idle' ? 'planning' : baseStatus;
      const words = item.content_mode === 'ai-generate' ? sectionWords[item.id] || 0 : countWords(getLeafContent(item, sections));
      const nodeMeta: OutlineNodeMeta = { status, leafCount: 1, words: status === 'ignored' ? 0 : words };
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
  stepNumber,
  hasOriginalPlan,
  originalPlanContentHash,
  outlineWordControlSnapshot,
  outlineData,
  task,
  contentGenerationRuntime,
  contentGenerationOptions,
  exportTemplateId,
  sections,
  onOpenGenerationSettingsAppearance,
  onContentGenerationReset,
  onContentSaved,
}: ContentEditPageProps) {
  const { showToast } = useToast();
  const allLeaves = useMemo(() => outlineData?.outline ? collectLeafItems(outlineData.outline) : [], [outlineData]);
  const leaves = useMemo(() => allLeaves.filter((item) => item.content_mode === 'ai-generate'), [allLeaves]);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [draftContent, setDraftContent] = useState('');
  const [confirmRegenerateItem, setConfirmRegenerateItem] = useState<OutlineItem | null>(null);
  const [requirementItem, setRequirementItem] = useState<OutlineItem | null>(null);
  const [regenerateRequirement, setRegenerateRequirement] = useState('');
  const [statsCollapsed, setStatsCollapsed] = useState(false);
  const [continuePostProcessingDialogOpen, setContinuePostProcessingDialogOpen] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const [pausePending, setPausePending] = useState(false);
  const [developerStageActionPending, setDeveloperStageActionPending] = useState<'continue' | 'restart' | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [sectionSubmitting, setSectionSubmitting] = useState(false);
  const [templateRequiredDialogOpen, setTemplateRequiredDialogOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormatConfig>(DEFAULT_EXPORT_FORMAT);
  const [developerMode, setDeveloperMode] = useState(false);
  const firstLeafId = allLeaves[0]?.id || '';
  const selectedItem = outlineData?.outline && selectedItemId ? findItem(outlineData.outline, selectedItemId) : null;
  const selectedIsLeaf = Boolean(selectedItem && !selectedItem.children?.length);
  const selectedIsWord = selectedIsLeaf && selectedItem?.content_mode === 'ai-generate';
  // 只在当前小节的转换记录改变时刷新，其他小节的进度不重复加载 Word。
  const selectedWordConverted = Boolean(contentGenerationRuntime?.html_output?.word_sections.some((section) => section.section_id === selectedItemId));
  const wordRefreshKey = `${task?.task_id || ''}:${selectedWordConverted}`;
  // 清空任务或目录快照变化时使旧预览失效；普通转换进度沿用当前文档。
  const hasContentTask = Boolean(task || contentGenerationRuntime?.html_output);
  const wordContentContext = useMemo(() => ({}), [outlineData, hasContentTask]);
  const selectedContent = selectedItem && selectedIsLeaf ? getLeafContent(selectedItem, sections) : '';
  const exportFormatPreviewStyle = useMemo<CSSProperties>(() => buildExportFormatCssVars(exportFormat), [exportFormat]);
  const running = task?.status === 'running';
  const pausing = task?.status === 'pausing' || pausePending;
  const paused = task?.status === 'paused';
  const taskFailed = task?.status === 'error';
  const taskInFlight = running || pausing;
  const phaseVisible = taskInFlight || paused || taskFailed;
  const taskBlocksGeneration = taskInFlight || paused || sectionSubmitting;
  const contentStats = task?.stats?.content;
  const originalRestoration = hasOriginalPlan && typeof contentStats?.original_restoration?.total_words === 'number' && contentStats.original_restoration.source_hash === originalPlanContentHash
    ? contentStats?.original_restoration : undefined;
  const developerStageGate = developerMode && paused ? contentStats?.developer_stage_gate : undefined;
  const progressDetail = task?.progress_detail || contentStats?.output_progress;
  const planning = phaseVisible && contentStats?.phase === 'planning';
  const restoring = phaseVisible && contentStats?.phase === 'restoring';
  const auditing = phaseVisible && contentStats?.phase === 'auditing';
  const tableCleaning = phaseVisible && contentStats?.phase === 'table-cleaning';
  const contentCorrecting = auditing || tableCleaning;
  const sectionWords = contentGenerationRuntime?.section_words;
  const outlineMeta = useMemo(() => outlineData?.outline ? buildOutlineMeta(outlineData.outline, sections, planning, sectionWords) : new Map<string, OutlineNodeMeta>(), [outlineData, planning, sections, sectionWords]);
  const contentSummary = useMemo(() => leaves.reduce((summary, item) => {
    const status = getLeafStatus(item, sections);
    return {
      completedCount: summary.completedCount + (status === 'success' ? 1 : 0),
      failedCount: summary.failedCount + (status === 'error' ? 1 : 0),
      ignoredCount: summary.ignoredCount + (status === 'ignored' ? 1 : 0),
      totalWords: summary.totalWords + (status === 'ignored' ? 0 : (outlineMeta.get(item.id)?.words || 0)),
    };
  }, { completedCount: 0, failedCount: 0, ignoredCount: 0, totalWords: 0 }), [leaves, outlineMeta, sections]);
  const { completedCount, failedCount, ignoredCount, totalWords } = contentSummary;
  const resolvedCount = completedCount + ignoredCount;
  const unresolvedCount = Math.max(0, leaves.length - resolvedCount);
  const modeCounts = allLeaves.reduce<Record<OutlineContentMode, number>>((counts, item) => {
    if (item.content_mode) counts[item.content_mode] += 1;
    return counts;
  }, { 'ai-generate': 0, 'template-fill': 0, 'directory-generate': 0, 'manual-fill': 0, other: 0 });
  const pendingCount = modeCounts['template-fill'] + modeCounts['directory-generate'] + modeCounts['manual-fill'] + modeCounts.other;
  const progress = leaves.length ? Math.round((resolvedCount / leaves.length) * 100) : 0;
  const planningTotal = contentStats?.planning_total || leaves.length;
  const planningCompleted = contentStats?.planning_completed || 0;
  const planningProgress = planningTotal ? Math.round((planningCompleted / planningTotal) * 100) : 0;
  const minimumWords = contentStats?.minimum_words ?? outlineWordControlSnapshot?.minimumWords ?? 0;
  const maximumWords = contentStats?.maximum_words ?? outlineWordControlSnapshot?.maximumWords ?? 0;
  const currentWords = contentStats?.current_words ?? totalWords;
  const retryingTableCleanup = taskFailed && contentStats?.phase === 'table-cleaning';
  const awaitingContentDecision = taskFailed && Boolean(contentStats?.awaiting_content_decision);
  const retryingWordConversion = taskFailed && ['sections-completed', 'word-converting'].includes(contentStats?.phase || '');
  const retryingConsistency = taskFailed && contentStats?.phase === 'auditing';
  const retryingSectionModification = taskFailed && Boolean(contentGenerationRuntime?.target_item_id) && contentStats?.phase === 'generating';
  const retryingBodyGeneration = taskFailed && !contentGenerationRuntime?.target_item_id && contentStats?.phase === 'generating';
  const latestTaskLog = task?.logs?.[task.logs.length - 1] || '';
  const taskErrorMessage = task?.error || latestTaskLog || '正文生成任务失败';
  const consistencyRound = contentStats?.consistency_round || 1;
  const consistencyComplete = contentStats?.consistency_status === 'completed';
  const auditProgress = consistencyComplete ? 100 : Math.round(((consistencyRound - 1) / 3) * 100);
  const tableCleanupTotal = contentStats?.table_cleanup_total || 0;
  const tableCleanupCompleted = contentStats?.table_cleanup_completed || 0;
  const tableCleanupProgress = tableCleanupTotal ? Math.round((tableCleanupCompleted / tableCleanupTotal) * 100) : 0;
  const auditCorrectionCount = `第 ${consistencyRound}/3 轮`;
  const contentCorrectionProgress = tableCleaning ? tableCleanupProgress : auditProgress;
  const contentCorrectionCount = tableCleaning
    ? tableCleanupTotal ? `${tableCleanupCompleted}/${tableCleanupTotal}` : '检查中'
    : auditCorrectionCount;
  const wordTargetText = minimumWords > 0 && maximumWords > 0 ? `${minimumWords} 至 ${maximumWords} 字` : minimumWords > 0 ? `不少于 ${minimumWords} 字` : maximumWords > 0 ? `不超过 ${maximumWords} 字` : '未限制';
  const htmlOutputProgress = progressDetail?.mode === 'html' || progressDetail?.mode === 'html-single';
  const currentProgressDetail = (phaseVisible || htmlOutputProgress) && progressDetail?.phase === contentStats?.phase ? progressDetail : undefined;
  const displayProgress = htmlOutputProgress ? task?.progress || 0 : currentProgressDetail ? currentProgressDetail.phase_progress : planning ? planningProgress : contentCorrecting ? contentCorrectionProgress : progress;
  const displayProgressLabel = currentProgressDetail ? currentProgressDetail.phase_label : planning ? '编排统计' : restoring ? '原方案还原' : contentCorrecting ? '内容矫正' : '生成统计';
  const displayProgressCount = auditing ? auditCorrectionCount : htmlOutputProgress && currentProgressDetail
    ? `${currentProgressDetail.completed}/${currentProgressDetail.total}`
    : planning
    ? `${planningCompleted}/${planningTotal}`
    : restoring && currentProgressDetail
      ? `${currentProgressDetail.completed}/${currentProgressDetail.total}`
    : contentCorrecting
      ? contentCorrectionCount
          : `${resolvedCount}/${leaves.length}`;
  const progressPhaseLabel = currentProgressDetail ? currentProgressDetail.phase_label : planning ? '正文编排' : restoring ? '原方案还原' : contentCorrecting ? '内容矫正' : '正文生成';
  const progressTone = planning
    ? 'success'
    : contentCorrecting
      ? 'sky'
      : 'primary';
  const progressActive = taskInFlight && (htmlOutputProgress || planning || restoring || contentCorrecting);
  const progressDescription = developerStageGate
    ? `${progressPhaseLabel}阶段已完成。可继续下一阶段，或从正文编排重新执行全部阶段。`
    : taskFailed
    ? taskErrorMessage
    : htmlOutputProgress && currentProgressDetail && ['generating', 'sections-completed', 'word-converting', 'word-completed'].includes(currentProgressDetail.phase)
    ? `${paused ? '已暂停：' : ''}${currentProgressDetail.phase_label}，${currentProgressDetail.phase === 'generating' ? '已保存' : '已完成'} ${currentProgressDetail.completed}/${currentProgressDetail.total} 个小节。`
    : planning
    ? paused ? `正文生成已暂停在编排阶段，已完成 ${planningCompleted}/${planningTotal} 个小节。` : `正在编排正文结构，已完成 ${planningCompleted}/${planningTotal} 个小节。`
    : restoring
      ? paused
        ? `正文生成已暂停在原方案还原阶段，已完成 ${progressDetail?.completed || 0}/${progressDetail?.total || 0} 个小节。`
        : `${progressDetail?.step_label || '正在还原原方案内容'}，已完成 ${progressDetail?.completed || 0}/${progressDetail?.total || 0} 个小节。`
    : auditing
      ? `${paused ? '已暂停：' : ''}主 Agent 一致性审计及修复，第 ${consistencyRound}/3 轮。${contentStats?.consistency_summary || ''}`
      : tableCleaning
        ? `${paused ? '已暂停：' : ''}将数据表格转换为普通文字，保留图片表格。${tableCleanupTotal ? `已处理 ${tableCleanupCompleted}/${tableCleanupTotal} 个小节。` : '正在检查本次正文。'}`
          : pausing
            ? '正在暂停正文生成，已发出的 AI 请求完成后会停止调度新任务。'
            : running
              ? latestTaskLog || '正文生成任务正在运行。'
              : paused
                ? '正文生成已暂停，可点击继续。'
                : resolvedCount
                  ? `已生成 ${completedCount} 个小节${ignoredCount ? `，已忽略 ${ignoredCount} 个小节` : ''}，共 ${totalWords} 字。`
                  : '点击生成正文后，目录会实时显示每个小节状态。';
  const selectedStatus = selectedItem ? outlineMeta.get(selectedItem.id)?.status || 'idle' : 'idle';
  const generationButtonLabel = pausing
    ? '正在暂停中...'
    : running
      ? '暂停'
      : paused
        ? '继续'
        : retryingSectionModification
          ? '重试小节修改'
        : retryingBodyGeneration
          ? '重试正文生成'
        : retryingConsistency
          ? '继续一致性审计'
        : retryingWordConversion
          ? '重试 Word 转换'
        : retryingTableCleanup
          ? '重试去表格'
          : resolvedCount === leaves.length && leaves.length
              ? '重新生成正文'
              : completedCount > 0
                ? '继续生成正文'
                : '生成正文';
  const editing = Boolean(selectedItem && selectedIsLeaf && editingItemId === selectedItem.id);
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
        setDeveloperMode(Boolean(config.developer_mode));
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
    if (task?.status !== 'paused') {
      setDeveloperStageActionPending(null);
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

    if (developerStageGate) setDeveloperStageActionPending('continue');
    try {
      await window.yibiao?.tasks.startContentGeneration({
        resume: true,
        ...(developerStageGate ? { developerStageAction: 'continue', developerStage: developerStageGate } : {}),
      });
      showToast(developerStageGate ? '已开始执行下一阶段' : '已继续正文生成任务', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '继续正文生成失败', 'error');
    } finally {
      setDeveloperStageActionPending(null);
    }
  };

  // 新建正文会话前确认“长嘛样”中保存的模板仍然存在。
  const ensureValidContentTemplate = async () => {
    const template = exportTemplateId ? await window.yibiao?.templates.get(exportTemplateId) : null;
    if (template) return true;
    setTemplateRequiredDialogOpen(true);
    return false;
  };

  // 开发者阶段停点直接复用全量重新生成，不保留当前阶段产物。
  const restartContentGeneration = async () => {
    if (!developerStageGate || developerStageActionPending) return;
    try {
      if (!await ensureValidContentTemplate()) return;
      setDeveloperStageActionPending('restart');
      setEditingItemId(null);
      setIsPreviewing(false);
      setDraftContent('');
      await window.yibiao?.tasks.startContentGeneration({ developerRestart: true, regenerate: true });
      showToast('已从正文编排重新执行全部阶段', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重新执行正文生成失败', 'error');
    } finally {
      setDeveloperStageActionPending(null);
    }
  };

  // 停止当前任务并清空正文阶段，供开发者从头重试完整流程。
  const resetContentGeneration = async () => {
    if (resetPending) return;
    setResetPending(true);
    try {
      setEditingItemId(null);
      setIsPreviewing(false);
      setDraftContent('');
      await onContentGenerationReset();
      setResetDialogOpen(false);
      showToast('正文阶段已重置', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重置正文阶段失败', 'error');
    } finally {
      setResetPending(false);
    }
  };

  // 失败重试续接原正文会话及后处理阶段，转换失败则只续转 Word。
  const retryFailedSections = async () => {
    if (taskBlocksGeneration || (!retryingWordConversion && !retryingConsistency && !retryingSectionModification && !retryingBodyGeneration && !retryingTableCleanup && (!awaitingContentDecision || !unresolvedCount))) return;
    try {
      await window.yibiao?.tasks.startContentGeneration({ retryFailedSections: true });
      trackConfigUsage({ content_generation_action: 'retry_failed_sections' });
      showToast(retryingTableCleanup ? '去表格已从原会话继续' : retryingSectionModification ? '小节修改已从原会话继续' : retryingBodyGeneration ? '正文生成已从原会话继续' : retryingConsistency ? '一致性审计已从原会话继续' : retryingWordConversion ? 'Word 转换重试已在后台启动' : '失败小节重试任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动失败小节重试失败', 'error');
    }
  };

  // 用户确认后忽略剩余失败或未完成小节，直接执行剩余内容检查。
  const continuePostProcessing = async () => {
    if (!awaitingContentDecision || taskBlocksGeneration) return;
    try {
      await window.yibiao?.tasks.startContentGeneration({ continuePostProcessing: true });
      trackConfigUsage({ content_generation_action: 'continue_with_ignored_sections' });
      setContinuePostProcessingDialogOpen(false);
      showToast('后续处理任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动后续处理失败', 'error');
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
    if (retryingWordConversion || retryingConsistency || retryingSectionModification || retryingBodyGeneration || retryingTableCleanup) {
      void retryFailedSections();
      return;
    }
    void startGeneration();
  };

  const launchContentGeneration = async ({
    savedGenerationOptions,
    nextImageModelAvailable,
    config,
    regenerate,
    contentGenerationAction,
    simulatePartialFailures = false,
  }: {
    savedGenerationOptions: ContentGenerationOptions;
    nextImageModelAvailable: boolean;
    config?: ClientConfig | null;
    regenerate: boolean;
    contentGenerationAction: ContentGenerationAction;
    simulatePartialFailures?: boolean;
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
      simulatePartialFailures,
      generationOptions: {
        useAiImages: nextImageModelAvailable && savedGenerationOptions.useAiImages,
        useMermaidImages: savedGenerationOptions.useMermaidImages,
        useHtmlImages: savedGenerationOptions.useHtmlImages,
        htmlImageTypes: savedGenerationOptions.htmlImageTypes,
        tableRequirement: savedGenerationOptions.tableRequirement,
      },
    });
    trackConfigUsage({
      table_requirement: savedGenerationOptions.tableRequirement,
      use_mermaid_images: savedGenerationOptions.useMermaidImages,
      use_ai_images: nextImageModelAvailable && savedGenerationOptions.useAiImages,
      content_generation_action: contentGenerationAction,
      enable_consistency_audit: true,
      consistency_repair_mode: 'agent',
      enable_original_plan_coverage_audit: false,
    }, config);
    showToast(simulatePartialFailures
      ? '随机失败模式正文生成任务已在后台启动'
      : regenerate ? '正文重新生成任务已在后台启动' : '正文生成任务已在后台启动', 'success');
  };

  const startGeneration = async (simulatePartialFailures = false) => {
    if (!outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }

    try {
      if (!await ensureValidContentTemplate()) return;
      const config = await window.yibiao?.config.load();
      const nextImageModelStatus = config?.image_model?.status || 'untested';
      const nextImageModelAvailable = nextImageModelStatus === 'available';
      const savedGenerationOptions = normalizeContentGenerationOptions(contentGenerationOptions, nextImageModelAvailable);
      const regenerate = leaves.length > 0 && resolvedCount === leaves.length;
      const contentGenerationAction: ContentGenerationAction = regenerate
          ? 'regenerate'
          : resolvedCount > 0
            ? 'continue'
            : 'start';
      await launchContentGeneration({ savedGenerationOptions, nextImageModelAvailable, config, regenerate, contentGenerationAction, simulatePartialFailures });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动正文生成任务失败', 'error');
    }
  };

  const startSectionRegeneration = async () => {
    if (taskBlocksGeneration || !outlineData?.outline?.length || !requirementItem) {
      return;
    }

    setSectionSubmitting(true);
    try {
      const config = await window.yibiao?.config.load();
      const nextImageModelStatus = config?.image_model?.status || 'untested';
      const nextImageModelAvailable = nextImageModelStatus === 'available';
      const savedGenerationOptions = normalizeContentGenerationOptions(contentGenerationOptions, nextImageModelAvailable);
      await window.yibiao?.tasks.startContentGeneration({
        regenerate: true,
        targetItemId: requirementItem.id,
        requirement: regenerateRequirement,
      });
      trackConfigUsage({
        table_requirement: savedGenerationOptions.tableRequirement,
        use_mermaid_images: savedGenerationOptions.useMermaidImages,
        use_ai_images: nextImageModelAvailable && savedGenerationOptions.useAiImages,
        content_generation_action: 'regenerate_section',
        enable_consistency_audit: false,
        consistency_repair_mode: 'agent',
        enable_original_plan_coverage_audit: false,
      }, config);
      setSelectedItemId(requirementItem.id);
      setRequirementItem(null);
      setRegenerateRequirement('');
      showToast('小节重新生成任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动小节重新生成失败', 'error');
    } finally {
      setSectionSubmitting(false);
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
    const modeLabel = isLeaf && item.content_mode ? OUTLINE_CONTENT_MODE_LABELS[item.content_mode] : '';

    return (
      <div className="content-outline-node" key={item.id} style={{ '--content-level': level } as CSSProperties}>
        <button
          type="button"
          className={`content-outline-item is-${status}${selectedItemId === item.id ? ' is-active' : ''}`}
          onClick={() => setSelectedItemId(item.id)}
        >
          <span className="content-outline-dot" aria-hidden="true" />
          <span className="content-outline-text">
            <strong>{formatOutlineTitle(item.number, item.title, exportFormat.headings[Math.min(level, 5)])}</strong>
            <small>{isLeaf ? item.content_mode === 'ai-generate' ? `${modeLabel} · Word 预览` : `${modeLabel || '未标记'} · ${statusLabels[status]} · ${words} 字` : `${leafCount} 个小节`}</small>
          </span>
          {isLeaf && item.content_mode === 'ai-generate' && (status === 'success' || status === 'error') ? (
            <Popover.Root
              open={!taskBlocksGeneration && confirmRegenerateItem?.id === item.id}
              onOpenChange={(open) => setConfirmRegenerateItem(open && !taskBlocksGeneration ? item : null)}
            >
              <Popover.Trigger asChild>
                <em
                  className={taskBlocksGeneration ? undefined : 'is-clickable'}
                  aria-disabled={taskBlocksGeneration}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (taskBlocksGeneration) event.preventDefault();
                  }}
                >重新生成</em>
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
            <em>{isLeaf && item.content_mode === 'ai-generate' ? '查看 Word' : statusLabels[status]}</em>
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
          <span className="section-kicker">STEP {stepNumber}</span>
          <strong>正文生成</strong>
          <p>只对标记为“AI生成”的叶子小节生成正文，其他模式保留为待处理。</p>
        </div>
        <div className="content-generation-stats" aria-label="正文生成统计">
          <span><strong>{leaves.length}</strong> 个 AI 小节</span>
          {typeof contentStats?.word_conversion_completed === 'number' && <span><strong>{contentStats.word_conversion_completed}</strong> 本次 Word 已转换</span>}
          {ignoredCount > 0 && <span><strong>{ignoredCount}</strong> 已忽略</span>}
          <span title={`模板填写 ${modeCounts['template-fill']}，目录生成 ${modeCounts['directory-generate']}，人工填写 ${modeCounts['manual-fill']}，其他模式 ${modeCounts.other}`}><strong>{pendingCount}</strong> 待处理</span>
          {hasOriginalPlan && (
            <span title="按原方案导入的图片引用统计，回填时同时核对本地资源；原图不受新增配图数量设置影响。">
              原方案图片 <strong>{originalRestoration && typeof originalRestoration.total_images === 'number'
                ? `${originalRestoration.restored_images}/${originalRestoration.total_images}` : '待统计'}</strong>
            </span>
          )}
          {hasOriginalPlan && (
            <span title={originalRestoration
              ? `已回填 ${originalRestoration.restored_words.toLocaleString()} / 原文共 ${originalRestoration.total_words.toLocaleString()} 字。已还原原文字数 ÷ 原方案总字数，使用相同可读字数口径，不计新增目录标题和结构标记，不代表后续扩写的内容保留率。${originalRestoration.rate === null ? '没有可统计内容。' : ''}`
              : '原方案还原完成后统计。'}>
              原方案还原率 <strong>{originalRestoration
                ? originalRestoration.rate === null ? '—' : `${originalRestoration.rate.toFixed(1)}%`
                : '待统计'}</strong>
            </span>
          )}
        </div>
        <div className="content-generation-actions">
          {developerMode && (
            <>
              {!paused && (
                <button type="button" className="secondary-action" onClick={() => void startGeneration(true)} disabled={taskBlocksGeneration || leaves.length < 2}>
                  以随机失败模式开始
                </button>
              )}
              <button
                type="button"
                className="danger-action"
                onClick={() => setResetDialogOpen(true)}
                disabled={resetPending}
              >
                {resetPending ? '正在重置...' : '重置正文阶段'}
              </button>
            </>
          )}
          {developerStageGate ? (
            <>
              <button
                type="button"
                className="secondary-action"
                onClick={() => void restartContentGeneration()}
                disabled={Boolean(developerStageActionPending)}
              >
                {developerStageActionPending === 'restart' ? '正在重新执行...' : '从正文编排重新执行'}
              </button>
              <button
                type="button"
                className="primary-action"
                onClick={() => void resumeGeneration()}
                disabled={Boolean(developerStageActionPending)}
              >
                {developerStageActionPending === 'continue' ? '正在继续...' : '继续下一阶段'}
              </button>
            </>
          ) : awaitingContentDecision ? (
            <>
              {unresolvedCount > 0 && (
                <button type="button" className="primary-action" onClick={() => void retryFailedSections()} disabled={taskBlocksGeneration}>
                  重试失败小节
                </button>
              )}
              <button type="button" className="secondary-action" onClick={() => setContinuePostProcessingDialogOpen(true)} disabled={taskBlocksGeneration}>
                继续后续流程
              </button>
            </>
          ) : (
            <button type="button" className="primary-action" onClick={handleGenerationButtonClick} disabled={sectionSubmitting || pausing || !leaves.length}>
              {generationButtonLabel}
            </button>
          )}
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
                <ProgressBar value={displayProgress} tone={progressTone} active={progressActive} label={`${progressPhaseLabel}进度 ${displayProgress}%`} />
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
              <strong>{selectedItem ? `${selectedItem.number} ${selectedItem.title}` : '选择小节'}</strong>
              <p>{selectedItem?.description || '选择左侧目录项查看生成正文。'}</p>
            </div>
            <div className="content-reader-actions">
              <span className={`content-status-badge is-${selectedIsWord ? 'pending' : selectedStatus}`}>{selectedIsWord ? 'Word 只读预览' : statusLabels[selectedStatus]}</span>
              {selectedIsWord ? null : editing ? (
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

          {selectedItem && selectedIsWord ? (
            <ContentWordPreview key={selectedItem.id} sectionId={selectedItem.id} refreshKey={wordRefreshKey} contentContext={wordContentContext} />
          ) : selectedItem && selectedIsLeaf && editing && !isPreviewing ? (
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
            <MarkdownFullscreenViewer className="markdown-viewer content-generation-output export-format-preview" style={exportFormatPreviewStyle} title={`${selectedItem.number} ${selectedItem.title}全屏查看`}>
              <MarkdownContent content={selectedContent} onPreviewImage={handlePreviewImage} />
            </MarkdownFullscreenViewer>
          ) : selectedItem && selectedIsLeaf ? (
            <div className="markdown-empty-state content-generation-empty">
              <strong>{getLeafStatus(selectedItem, sections) === 'error'
                ? sections[selectedItem.id]?.error || '正文生成失败'
                : getLeafStatus(selectedItem, sections) === 'ignored'
                  ? '该小节已按用户选择忽略'
                  : selectedItem.content_mode === 'ai-generate' ? '正文待生成' : '该小节等待后续处理'}</strong>
              <p>{getLeafStatus(selectedItem, sections) === 'ignored'
                ? '该小节不参与一致性检查；如需补充，可直接编辑正文。'
                : selectedItem.content_mode && selectedItem.content_mode !== 'ai-generate'
                ? `${pendingModeDescriptions[selectedItem.content_mode]}${selectedItem.content_mode === 'other' && selectedItem.content_mode_note ? ` ${selectedItem.content_mode_note}` : ''}`
                : taskInFlight ? '如果该小节正在生成，模型返回内容后会实时显示在这里。' : paused ? '任务已暂停，可点击继续。' : '点击生成正文后，后台会按 AI 生成小节生成内容。'}</p>
            </div>
          ) : (
            <div className="markdown-empty-state content-generation-empty">
              <strong>当前是目录分组</strong>
              <p>该目录下包含 {selectedItem?.children ? collectLeafItems(selectedItem.children).length : 0} 个小节，请选择叶子小节查看具体正文。</p>
            </div>
          )}
        </article>
      </section>

      <AppDialog
        open={templateRequiredDialogOpen}
        onOpenChange={setTemplateRequiredDialogOpen}
        kicker="正文生成"
        title="未选择有效的正文模板"
        description="正文生成前，请先在 STEP 02“长嘛样”中选择有效的正文模板。"
        actions={(
          <button
            type="button"
            className="primary-action"
            onClick={() => {
              setTemplateRequiredDialogOpen(false);
              onOpenGenerationSettingsAppearance();
            }}
          >
            确定
          </button>
        )}
      />

      <Dialog.Root
        open={resetDialogOpen}
        onOpenChange={(open) => {
          if (!resetPending) setResetDialogOpen(open);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card">
            <div className="content-regenerate-card-head">
              <Dialog.Title>重置正文阶段？</Dialog.Title>
              <Dialog.Description>
                将停止当前正文任务，并清空已生成正文、生成进度、正文编排缓存。目录、全局事实及 Step 02 生成设置会保留。
              </Dialog.Description>
            </div>
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button" disabled={resetPending}>取消</Dialog.Close>
              <button type="button" className="danger-action" onClick={() => void resetContentGeneration()} disabled={resetPending}>
                {resetPending ? '正在重置...' : '确认重置'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={continuePostProcessingDialogOpen} onOpenChange={setContinuePostProcessingDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card content-incomplete-decision-card">
            <div className="content-regenerate-card-head">
              <Dialog.Title>忽略未完成小节并继续？</Dialog.Title>
              <Dialog.Description asChild>
                <div className="content-incomplete-decision-copy">
                  <p className="content-incomplete-decision-summary">
                    仍有 <strong>{unresolvedCount} 个</strong>正文小节失败或未完成。
                  </p>
                  <div className="content-incomplete-decision-impact">
                    <strong>确认继续后：</strong>
                    <ul>
                      <li>这些小节将标记为“已忽略”</li>
                      <li>不再参与一致性检查</li>
                    </ul>
                  </div>
                  <p className="content-incomplete-decision-warning">
                    完成后将不再提供失败小节重试入口。
                  </p>
                </div>
              </Dialog.Description>
            </div>
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="primary-action" onClick={() => void continuePostProcessing()}>确认并继续</button>
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
              <Dialog.Title>{requirementItem?.number} {requirementItem?.title}</Dialog.Title>
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
