import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import DocumentAnalysisPage from './DocumentAnalysisPage';
import BidAnalysisPage from './BidAnalysisPage';
import OutlineEditPage from './OutlineEditPage';
import GlobalFactsPage from './GlobalFactsPage';
import ContentEditPage from './ContentEditPage';
import { useTechnicalPlanWorkflow } from '../hooks/useTechnicalPlanWorkflow';
import { getBidAnalysisTasks } from '../services/bidAnalysisWorkflow';
import { trackPageView } from '../../../shared/analytics/analytics';
import { FloatingToolbar, ToolbarArrowLeftIcon, ToolbarArrowRightIcon, ToolbarDocumentIcon, useToast } from '../../../shared/ui';
import type { BackgroundTaskState, BidAnalysisTasks, ContentGenerationOptions, GlobalFactGroupState, SaveOutlineRequest, TechnicalPlanState, TechnicalPlanStep, TechnicalPlanWorkflowKind } from '../types';
import type { OutlineData, OutlineItem, WordExportProgressEvent } from '../../../shared/types';
import type { ExportFormatConfig } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import type { SectionId } from '../../../shared/types/navigation';

interface TechnicalPlanHomeProps {
  workflowKind: TechnicalPlanWorkflowKind;
  registerLeaveGuard?: (guard: ((nextSection?: string) => Promise<boolean>) | null) => void;
  onSectionChange?: (section: SectionId) => void;
}

interface OutlineSortGuard {
  hasUnsavedSort: () => boolean;
  saveSort: () => Promise<void>;
  discardSort: () => void;
}

interface WorkflowSwitchRequest {
  from: TechnicalPlanWorkflowKind;
  to: TechnicalPlanWorkflowKind;
  navigateBackOnCancel: boolean;
}

const steps: TechnicalPlanStep[] = [
  'document-analysis',
  'bid-analysis',
  'outline-generation',
  'global-facts',
  'content-edit',
  'expand',
];

const stepLabels: Record<TechnicalPlanStep, string> = {
  'document-analysis': '选择标书',
  'bid-analysis': '招标文件解析',
  'outline-generation': '目录生成',
  'global-facts': '全局事实设定',
  'content-edit': '生成正文',
  expand: '扩写改写',
};

const resetState = {
  workflowKind: 'technical-plan' as TechnicalPlanWorkflowKind,
  step: 'document-analysis' as TechnicalPlanStep,
  tenderFile: null,
  originalPlanFile: null,
  projectOverview: '',
  techRequirements: '',
  bidAnalysisMode: 'key' as const,
  bidAnalysisSelectedTaskIds: [] as string[],
  bidAnalysisTasks: {},
  bidAnalysisProgress: 0,
  outlineMode: 'aligned' as const,
  outlineExpansionMode: 'ai-complement' as const,
  referenceKnowledgeDocumentIds: [] as string[],
  bidAnalysisTask: undefined,
  outlineGenerationTask: undefined,
  globalFactsTask: undefined,
  globalFacts: [] as GlobalFactGroupState[],
  contentGenerationTask: undefined,
  contentGenerationOptions: undefined,
  contentGenerationSections: {},
  contentGenerationPlans: {},
  contentGenerationRuntime: undefined,
  outlineData: null,
  pendingSectionSelection: null,
};

function collectLeafItems(items: OutlineItem[]): OutlineItem[] {
  return items.flatMap((item) => item.children?.length ? collectLeafItems(item.children) : [item]);
}

function countMermaidDiagrams(content: string) {
  const mermaidBlocks = (String(content || '').match(/```mermaid[\s\S]*?```/gi) || []).length;
  const mermaidInkImages = (String(content || '').match(/https:\/\/mermaid\.ink\/img\//gi) || []).length;
  return mermaidBlocks + mermaidInkImages;
}

function countOutlineMermaidDiagrams(items: OutlineItem[]) {
  return collectLeafItems(items).reduce((sum, item) => sum + countMermaidDiagrams(item.content || ''), 0);
}

interface ExportProgressState {
  open: boolean;
  running: boolean;
  progress: number;
  message: string;
  warnings: string[];
  mermaidCount: number;
  error?: string;
}

const initialExportProgress: ExportProgressState = {
  open: false,
  running: false,
  progress: 0,
  message: '',
  warnings: [],
  mermaidCount: 0,
};

const MAX_UI_TASK_LOGS = 80;
const requiredBidAnalysisTasks = getBidAnalysisTasks('key');

function hasOwnField<T extends object>(value: T, field: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function trimTaskLogs(task?: BackgroundTaskState): BackgroundTaskState | undefined {
  if (!task?.logs || task.logs.length <= MAX_UI_TASK_LOGS) {
    return task;
  }

  return { ...task, logs: task.logs.slice(-MAX_UI_TASK_LOGS) };
}

function areRequiredBidAnalysisTasksReady(tasks: BidAnalysisTasks) {
  return requiredBidAnalysisTasks.every((task) => {
    const state = tasks[task.id];
    return state?.status === 'success' && state.content.trim();
  });
}

function workflowKindFromSection(section?: string): TechnicalPlanWorkflowKind | null {
  if (section === 'technical-plan') return 'technical-plan';
  if (section === 'existing-plan-expansion') return 'existing-plan-expansion';
  return null;
}

function workflowLabel(kind: TechnicalPlanWorkflowKind) {
  return kind === 'existing-plan-expansion' ? '已有方案扩写' : '生成技术方案';
}

function hasRunningTechnicalPlanTask(state: TechnicalPlanState) {
  return [state.bidAnalysisTask, state.outlineGenerationTask, state.globalFactsTask, state.contentGenerationTask]
    .some((task) => task?.status === 'running' || task?.status === 'pausing');
}

function hasWorkflowSpecificProgress(state: TechnicalPlanState) {
  return Boolean(
    state.originalPlanFile
    || state.outlineData
    || state.globalFacts.length > 0
    || Object.keys(state.contentGenerationSections || {}).length > 0
    || Object.keys(state.contentGenerationPlans || {}).length > 0
    || state.contentGenerationRuntime
    || state.contentGenerationOptions
    || state.outlineGenerationTask
    || state.globalFactsTask
    || state.contentGenerationTask
    || ['outline-generation', 'global-facts', 'content-edit', 'expand'].includes(state.step),
  );
}

function updateOutlineItemContent(items: OutlineItem[], itemId: string, content: string): OutlineItem[] {
  return items.map((item) => {
    if (item.id === itemId) {
      return { ...item, content };
    }

    return item.children?.length
      ? { ...item, children: updateOutlineItemContent(item.children, itemId, content) }
      : item;
  });
}

function TechnicalPlanHome({ workflowKind, registerLeaveGuard, onSectionChange }: TechnicalPlanHomeProps) {
  const { hydrated, state, setState } = useTechnicalPlanWorkflow();
  const { showToast } = useToast();
  const [tenderMarkdown, setTenderMarkdown] = useState('');
  const [originalPlanMarkdown, setOriginalPlanMarkdown] = useState('');
  const [exportProgress, setExportProgress] = useState<ExportProgressState>(initialExportProgress);
  const [exportFormat, setExportFormat] = useState<ExportFormatConfig>(DEFAULT_EXPORT_FORMAT);
  const [sortLeaveDialogOpen, setSortLeaveDialogOpen] = useState(false);
  const [savingSortBeforeLeave, setSavingSortBeforeLeave] = useState(false);
  const [workflowSwitchRequest, setWorkflowSwitchRequest] = useState<WorkflowSwitchRequest | null>(null);
  const [switchingWorkflow, setSwitchingWorkflow] = useState(false);
  const sortGuardRef = useRef<OutlineSortGuard | null>(null);
  const sortLeaveResolverRef = useRef<((allowed: boolean) => void) | null>(null);
  const workflowSwitchResolverRef = useRef<((allowed: boolean) => void) | null>(null);
  const skippedWorkflowSwitchPromptRef = useRef<TechnicalPlanWorkflowKind | null>(null);
  const lastExecutedWorkflowSwitchRef = useRef<TechnicalPlanWorkflowKind | null>(null);
  const activeIndex = steps.indexOf(state.step);
  const bidAnalysisReady = areRequiredBidAnalysisTasksReady(state.bidAnalysisTasks);
  const globalFactsReady = state.globalFacts.length > 0 && state.globalFactsTask?.status === 'success';
  const contentTaskStatus = state.contentGenerationTask?.status;
  const isContentGenerating = contentTaskStatus === 'running' || contentTaskStatus === 'pausing';
  const isContentPaused = contentTaskStatus === 'paused';
  const isExporting = exportProgress.running;
  const hasPendingSectionSelection = Boolean(state.pendingSectionSelection);
  const requiresOriginalPlan = workflowKind === 'existing-plan-expansion';
  const isNextDisabled = activeIndex >= steps.length - 1
    || (state.step === 'document-analysis' && (!state.tenderFile || hasPendingSectionSelection || (requiresOriginalPlan && !state.originalPlanFile)))
    || (state.step === 'bid-analysis' && !bidAnalysisReady)
    || (state.step === 'outline-generation' && !state.outlineData)
    || (state.step === 'global-facts' && !globalFactsReady);
  const nextTooltip = state.step === 'document-analysis' && hasPendingSectionSelection
    ? '请先选择本次投标范围'
    : state.step === 'document-analysis' && !state.tenderFile
      ? '上传完招标文件后才能进入下一步'
      : state.step === 'document-analysis' && requiresOriginalPlan && !state.originalPlanFile
        ? '上传完原方案后才能进入下一步'
        : state.step === 'bid-analysis' && !bidAnalysisReady
          ? '招标文件解析完成后才能进入目录生成'
          : state.step === 'outline-generation' && !state.outlineData
            ? '目录生成完成后才能进入全局事实设定'
            : state.step === 'global-facts' && !globalFactsReady
              ? '全局事实设定完成后才能进入正文生成'
              : activeIndex >= steps.length - 1
                ? '当前已经是最后一步'
                : `进入${stepLabels[steps[activeIndex + 1]]}`;

  const resolveSortLeave = (allowed: boolean) => {
    sortLeaveResolverRef.current?.(allowed);
    sortLeaveResolverRef.current = null;
    setSortLeaveDialogOpen(false);
  };

  const executeWorkflowSwitch = useCallback(async (targetWorkflowKind: TechnicalPlanWorkflowKind) => {
    if (!window.yibiao?.technicalPlan.switchWorkflowKind) {
      showToast('技术方案工作流切换服务尚未初始化', 'error');
      return false;
    }

    try {
      setSwitchingWorkflow(true);
      const saved = await window.yibiao.technicalPlan.switchWorkflowKind(targetWorkflowKind);
      lastExecutedWorkflowSwitchRef.current = targetWorkflowKind;
      setState((prev) => ({ ...prev, ...saved, workflowKind: targetWorkflowKind }));
      setOriginalPlanMarkdown('');
      showToast(`已切换到${workflowLabel(targetWorkflowKind)}`, 'success');
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : '切换技术方案工作流失败', 'error');
      return false;
    } finally {
      setSwitchingWorkflow(false);
    }
  }, [setState, showToast]);

  const resolveWorkflowSwitch = useCallback((allowed: boolean) => {
    const request = workflowSwitchRequest;
    workflowSwitchResolverRef.current?.(allowed);
    workflowSwitchResolverRef.current = null;
    setWorkflowSwitchRequest(null);
    if (!allowed && request?.navigateBackOnCancel) {
      skippedWorkflowSwitchPromptRef.current = request.to;
      onSectionChange?.(request.from);
    }
  }, [onSectionChange, workflowSwitchRequest]);

  const openWorkflowSwitchDialog = useCallback((targetWorkflowKind: TechnicalPlanWorkflowKind, navigateBackOnCancel: boolean) => {
    setWorkflowSwitchRequest({
      from: state.workflowKind,
      to: targetWorkflowKind,
      navigateBackOnCancel,
    });
    return new Promise<boolean>((resolve) => {
      workflowSwitchResolverRef.current = resolve;
    });
  }, [state.workflowKind]);

  const confirmSortLeaveOnly = useCallback(async () => {
    const guard = sortGuardRef.current;
    if (!guard?.hasUnsavedSort()) {
      return true;
    }

    setSortLeaveDialogOpen(true);
    return new Promise<boolean>((resolve) => {
      sortLeaveResolverRef.current = resolve;
    });
  }, []);

  const confirmPendingSortLeave = useCallback(async (nextSection?: string) => {
    const targetWorkflowKind = workflowKindFromSection(nextSection);
    if (!targetWorkflowKind || targetWorkflowKind === state.workflowKind) {
      return confirmSortLeaveOnly();
    }

    if (hasRunningTechnicalPlanTask(state)) {
      showToast('当前有技术方案任务正在运行，请等待任务结束后再切换模式', 'info');
      return false;
    }

    const sortAllowed = await confirmSortLeaveOnly();
    if (!sortAllowed) {
      return false;
    }

    if (hasWorkflowSpecificProgress(state)) {
      return openWorkflowSwitchDialog(targetWorkflowKind, false);
    }

    return executeWorkflowSwitch(targetWorkflowKind);
  }, [confirmSortLeaveOnly, executeWorkflowSwitch, openWorkflowSwitchDialog, showToast, state]);

  const continueSorting = () => {
    resolveSortLeave(false);
  };

  const discardSortAndLeave = () => {
    sortGuardRef.current?.discardSort();
    resolveSortLeave(true);
  };

  const saveSortAndLeave = async () => {
    const guard = sortGuardRef.current;
    if (!guard) {
      resolveSortLeave(true);
      return;
    }

    try {
      setSavingSortBeforeLeave(true);
      await guard.saveSort();
      resolveSortLeave(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存排序失败', 'error');
    } finally {
      setSavingSortBeforeLeave(false);
    }
  };

  const cancelWorkflowSwitch = () => {
    resolveWorkflowSwitch(false);
  };

  const confirmWorkflowSwitch = async () => {
    if (!workflowSwitchRequest) {
      return;
    }

    const switched = await executeWorkflowSwitch(workflowSwitchRequest.to);
    if (switched) {
      resolveWorkflowSwitch(true);
    }
  };

  useEffect(() => {
    if (!hydrated) return;

    trackPageView(`${workflowKind}/${state.step}`);
  }, [hydrated, state.step, workflowKind]);

  useEffect(() => {
    if (!hydrated || state.workflowKind === workflowKind) return;
    if (skippedWorkflowSwitchPromptRef.current === workflowKind) return;
    if (lastExecutedWorkflowSwitchRef.current === state.workflowKind) return;
    if (workflowSwitchRequest || switchingWorkflow) return;

    const run = async () => {
      if (hasRunningTechnicalPlanTask(state)) {
        showToast('当前有技术方案任务正在运行，请等待任务结束后再切换模式', 'info');
        onSectionChange?.(state.workflowKind);
        return;
      }

      if (hasWorkflowSpecificProgress(state)) {
        await openWorkflowSwitchDialog(workflowKind, true);
        return;
      }

      const switched = await executeWorkflowSwitch(workflowKind);
      if (!switched) {
        onSectionChange?.(state.workflowKind);
      }
    };

    void run();
  }, [executeWorkflowSwitch, hydrated, onSectionChange, openWorkflowSwitchDialog, showToast, state, switchingWorkflow, workflowKind, workflowSwitchRequest]);

  useEffect(() => {
    if (state.workflowKind === workflowKind) {
      skippedWorkflowSwitchPromptRef.current = null;
      lastExecutedWorkflowSwitchRef.current = null;
    }
  }, [state.workflowKind, workflowKind]);

  useEffect(() => {
    let cancelled = false;
    window.yibiao?.config.load().then((cfg) => {
      if (!cancelled && cfg?.export_format) {
        setExportFormat(cfg.export_format);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!registerLeaveGuard) return;
    registerLeaveGuard(confirmPendingSortLeave);
    return () => registerLeaveGuard(null);
  }, [confirmPendingSortLeave, registerLeaveGuard]);

  const switchStep = async (step: TechnicalPlanStep) => {
    if (step === state.step) {
      return;
    }
    const allowed = await confirmPendingSortLeave();
    if (!allowed) {
      return;
    }

    setState((prev) => ({ ...prev, step }));
    window.yibiao?.technicalPlan.updateStep(step).catch((error) => {
      showToast(error instanceof Error ? error.message : '保存技术方案步骤失败', 'error');
    });
  };

  const goToOffset = async (offset: number) => {
    const nextStep = steps[activeIndex + offset];
    if (nextStep) {
      await switchStep(nextStep);
    }
  };

  useEffect(() => {
    if (!window.yibiao?.tasks) {
      return;
    }

    const unsubscribe = window.yibiao.tasks.onTaskEvent<typeof state>((event) => {
      const taskType = (event.task as { type?: string } | undefined)?.type;
      const latestTask = trimTaskLogs(event.task as BackgroundTaskState | undefined);
      const technicalPlan = event.technicalPlanPatch || event.technicalPlan;

      if (!technicalPlan) {
        return;
      }

      setState((prev) => {
        if (taskType === 'bid-analysis') {
          const outlineDataReset = hasOwnField(technicalPlan, 'outlineData') && technicalPlan.outlineData === null;
          return {
            ...prev,
            bidAnalysisTask: trimTaskLogs(technicalPlan.bidAnalysisTask) || latestTask,
            bidAnalysisMode: technicalPlan.bidAnalysisMode ?? prev.bidAnalysisMode,
            bidAnalysisSelectedTaskIds: Array.isArray(technicalPlan.bidAnalysisSelectedTaskIds)
              ? technicalPlan.bidAnalysisSelectedTaskIds
              : prev.bidAnalysisSelectedTaskIds,
            bidAnalysisTasks: {
              ...prev.bidAnalysisTasks,
              ...(technicalPlan.bidAnalysisTasks || {}),
              ...(event.bidItem ? { [event.bidItem.id]: event.bidItem } : {}),
            },
            bidAnalysisProgress: technicalPlan.bidAnalysisProgress ?? prev.bidAnalysisProgress,
            projectOverview: technicalPlan.projectOverview ?? prev.projectOverview,
            techRequirements: technicalPlan.techRequirements ?? prev.techRequirements,
            outlineGenerationTask: outlineDataReset ? undefined : prev.outlineGenerationTask,
            globalFactsTask: outlineDataReset ? undefined : prev.globalFactsTask,
            globalFacts: outlineDataReset ? [] : prev.globalFacts,
            contentGenerationTask: outlineDataReset ? undefined : prev.contentGenerationTask,
            contentGenerationOptions: outlineDataReset ? undefined : prev.contentGenerationOptions,
            contentGenerationSections: outlineDataReset ? {} : prev.contentGenerationSections,
            contentGenerationPlans: outlineDataReset ? {} : prev.contentGenerationPlans,
            contentGenerationRuntime: outlineDataReset ? undefined : prev.contentGenerationRuntime,
            outlineData: hasOwnField(technicalPlan, 'outlineData') ? (technicalPlan.outlineData || null) : prev.outlineData,
          };
        }

        if (taskType === 'outline-generation') {
          const hasOutlineData = hasOwnField(technicalPlan, 'outlineData');
          const nextOutlineData = hasOutlineData ? (technicalPlan.outlineData || null) : prev.outlineData;
          const outlineDataChanged = nextOutlineData !== prev.outlineData;

          return {
            ...prev,
            outlineGenerationTask: trimTaskLogs(technicalPlan.outlineGenerationTask) || latestTask,
            outlineMode: technicalPlan.outlineMode ?? prev.outlineMode,
            outlineExpansionMode: technicalPlan.outlineExpansionMode ?? prev.outlineExpansionMode,
            referenceKnowledgeDocumentIds: Array.isArray(technicalPlan.referenceKnowledgeDocumentIds)
              ? technicalPlan.referenceKnowledgeDocumentIds
              : prev.referenceKnowledgeDocumentIds,
            outlineData: nextOutlineData,
            globalFactsTask: hasOwnField(technicalPlan, 'globalFactsTask') ? trimTaskLogs(technicalPlan.globalFactsTask) : prev.globalFactsTask,
            globalFacts: hasOwnField(technicalPlan, 'globalFacts') ? (technicalPlan.globalFacts || []) : prev.globalFacts,
            contentGenerationTask: hasOwnField(technicalPlan, 'contentGenerationTask') ? trimTaskLogs(technicalPlan.contentGenerationTask) : (outlineDataChanged ? undefined : prev.contentGenerationTask),
            contentGenerationSections: hasOwnField(technicalPlan, 'contentGenerationSections') ? (technicalPlan.contentGenerationSections || {}) : (outlineDataChanged ? {} : prev.contentGenerationSections),
            contentGenerationPlans: hasOwnField(technicalPlan, 'contentGenerationPlans') ? (technicalPlan.contentGenerationPlans || {}) : (outlineDataChanged ? {} : prev.contentGenerationPlans),
            contentGenerationRuntime: hasOwnField(technicalPlan, 'contentGenerationRuntime') ? technicalPlan.contentGenerationRuntime : (outlineDataChanged ? undefined : prev.contentGenerationRuntime),
          };
        }

        if (taskType === 'global-facts-generation') {
          const hasGlobalFacts = hasOwnField(technicalPlan, 'globalFacts');
          const globalFactsChanged = hasGlobalFacts && technicalPlan.globalFacts !== prev.globalFacts;
          return {
            ...prev,
            globalFactsTask: trimTaskLogs(technicalPlan.globalFactsTask) || latestTask,
            globalFacts: hasGlobalFacts ? (technicalPlan.globalFacts || []) : prev.globalFacts,
            contentGenerationTask: globalFactsChanged ? undefined : prev.contentGenerationTask,
            contentGenerationSections: globalFactsChanged ? {} : prev.contentGenerationSections,
            contentGenerationPlans: globalFactsChanged ? {} : prev.contentGenerationPlans,
            contentGenerationRuntime: globalFactsChanged ? undefined : prev.contentGenerationRuntime,
          };
        }

        if (taskType === 'content-generation') {
          const hasPatchOutlineData = hasOwnField(technicalPlan, 'outlineData') || hasOwnField(event, 'outlineData');
          const patchOutlineData = hasOwnField(technicalPlan, 'outlineData') ? technicalPlan.outlineData : event.outlineData;
          const contentSection = event.contentSection;
          const nextSections = hasOwnField(technicalPlan, 'contentGenerationSections')
            ? (technicalPlan.contentGenerationSections || {})
            : contentSection
              ? { ...prev.contentGenerationSections, [contentSection.id]: contentSection }
              : prev.contentGenerationSections;
          const nextOutlineData = hasPatchOutlineData
            ? (patchOutlineData || null)
            : contentSection?.content !== undefined && prev.outlineData
              ? { ...prev.outlineData, outline: updateOutlineItemContent(prev.outlineData.outline, contentSection.id, contentSection.content) }
              : prev.outlineData;
          return {
            ...prev,
            contentGenerationTask: latestTask || trimTaskLogs(technicalPlan.contentGenerationTask),
            outlineMode: technicalPlan.outlineMode ?? prev.outlineMode,
            referenceKnowledgeDocumentIds: Array.isArray(technicalPlan.referenceKnowledgeDocumentIds)
              ? technicalPlan.referenceKnowledgeDocumentIds
              : prev.referenceKnowledgeDocumentIds,
            contentGenerationSections: nextSections,
            contentGenerationPlans: hasOwnField(technicalPlan, 'contentGenerationPlans') ? (technicalPlan.contentGenerationPlans || {}) : prev.contentGenerationPlans,
            contentGenerationRuntime: hasOwnField(technicalPlan, 'contentGenerationRuntime') ? technicalPlan.contentGenerationRuntime : prev.contentGenerationRuntime,
            outlineData: nextOutlineData,
          };
        }

        return prev;
      });
    });
    window.yibiao.tasks.getActiveTasks().catch((error) => {
      console.warn('获取后台任务状态失败', error);
    });

    return unsubscribe;
  }, [setState]);

  useEffect(() => {
    if (state.step !== 'document-analysis') {
      return;
    }
    if (!state.tenderFile) {
      setTenderMarkdown('');
      return;
    }
    let mounted = true;
    window.yibiao?.technicalPlan.readTenderMarkdown().then((markdown) => {
      if (mounted) setTenderMarkdown(markdown || '');
    }).catch((error) => {
      if (mounted) showToast(error instanceof Error ? error.message : '读取招标文件 Markdown 失败', 'error');
    });
    return () => {
      mounted = false;
    };
  }, [showToast, state.step, state.tenderFile]);

  useEffect(() => {
    if (state.step !== 'document-analysis' || !requiresOriginalPlan) {
      setOriginalPlanMarkdown('');
      return;
    }
    if (!state.originalPlanFile) {
      setOriginalPlanMarkdown('');
      return;
    }
    let mounted = true;
    window.yibiao?.technicalPlan.readOriginalPlanMarkdown().then((markdown) => {
      if (mounted) setOriginalPlanMarkdown(markdown || '');
    }).catch((error) => {
      if (mounted) showToast(error instanceof Error ? error.message : '读取原方案 Markdown 失败', 'error');
    });
    return () => {
      mounted = false;
    };
  }, [requiresOriginalPlan, showToast, state.originalPlanFile, state.step]);

  const exportWord = async () => {
    if (!state.outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }

    // 每次导出前重新读取最新配置（用户可能在导出格式页修改过）
    let latestExportFormat = exportFormat;
    try {
      const cfg = await window.yibiao?.config.load();
      if (cfg?.export_format) {
        latestExportFormat = cfg.export_format;
      }
    } catch { /* 读不到用已有值 */ }

    const requestId = `export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const mermaidCount = countOutlineMermaidDiagrams(state.outlineData.outline);
    let unsubscribe: (() => void) | undefined;

    try {
      setExportProgress({
        open: true,
        running: true,
        progress: 2,
        message: mermaidCount
          ? `检测到 ${mermaidCount} 张 Mermaid 图，导出时会转换为 Word 图片，可能需要稍等。`
          : '正在准备导出 Word。',
        warnings: [],
        mermaidCount,
      });

      unsubscribe = window.yibiao?.export.onWordExportProgress((event: WordExportProgressEvent) => {
        if (event.requestId && event.requestId !== requestId) {
          return;
        }

        setExportProgress((prev) => ({
          ...prev,
          open: true,
          running: event.phase === 'running',
          progress: event.progress,
          message: event.message,
          warnings: event.warnings || prev.warnings,
          error: event.phase === 'error' ? event.message : undefined,
        }));
      });

      const result = await window.yibiao?.export.exportWord({
        requestId,
        project_name: state.outlineData.project_name,
        outline: state.outlineData.outline,
        export_format: latestExportFormat,
      });
      if (result?.canceled) {
        setExportProgress(initialExportProgress);
        showToast('已取消导出', 'info');
        return;
      }
      setExportProgress((prev) => ({
        ...prev,
        open: true,
        running: false,
        progress: 100,
        message: result?.message || 'Word 已导出，请打开文档核对图片、表格和版式。',
        warnings: result?.warnings || prev.warnings,
      }));
      showToast(result?.message || 'Word 已导出', result?.warnings?.length ? 'info' : 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出 Word 失败';
      setExportProgress((prev) => ({
        ...prev,
        open: true,
        running: false,
        progress: 100,
        message,
        error: message,
      }));
      showToast(message, 'error');
    } finally {
      unsubscribe?.();
    }
  };

  const saveChapterContent = async (item: OutlineItem, content: string) => {
    if (!state.outlineData?.outline?.length) {
      throw new Error('当前没有可保存的目录');
    }

    const updatedOutlineData = {
      ...state.outlineData,
      outline: updateOutlineItemContent(state.outlineData.outline, item.id, content),
    };
    const updatedSections = {
      ...state.contentGenerationSections,
      [item.id]: {
        id: item.id,
        title: item.title || '未命名章节',
        status: content.trim() ? 'success' as const : 'idle' as const,
        content,
        updated_at: new Date().toISOString(),
      },
    };

    setState((prev) => ({
      ...prev,
      outlineData: updatedOutlineData,
      contentGenerationSections: updatedSections,
    }));
    const saved = await window.yibiao?.technicalPlan.saveChapterContent({ nodeId: item.id, content });
    if (saved) setState((prev) => ({ ...prev, ...saved }));
  };

  const resetTechnicalPlan = async () => {
    if (!window.confirm('会清空整个技术方案编写进度，是否确认？')) {
      return;
    }

    try {
      const result = await window.yibiao?.technicalPlan.clear();
      setState(result?.state || { ...resetState, workflowKind });
      setTenderMarkdown('');
      setOriginalPlanMarkdown('');
      showToast(result?.message || '技术方案已重置', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重置技术方案失败', 'error');
    }
  };

  const saveContentGenerationOptions = async (contentGenerationOptions: ContentGenerationOptions) => {
    const saved = await window.yibiao?.technicalPlan.saveContentGenerationOptions(contentGenerationOptions);
    setState((prev) => ({ ...prev, ...(saved || {}), contentGenerationOptions }));
  };

  const saveGlobalFacts = async (globalFacts: GlobalFactGroupState[]) => {
    const saved = await window.yibiao?.technicalPlan.saveGlobalFacts(globalFacts);
    setState((prev) => ({ ...prev, ...(saved || {}), globalFacts }));
  };

  const saveOutline = async (request: SaveOutlineRequest) => {
    const saved = await window.yibiao?.technicalPlan.saveOutline(request);
    setState((prev) => ({ ...prev, ...(saved || {}), outlineData: saved?.outlineData || request.outlineData }));
  };

  const generatedContentCount = state.outlineData?.outline
    ? collectLeafItems(state.outlineData.outline).filter((item) => item.content?.trim()).length
    : 0;
  const workflowSwitchClearText = workflowSwitchRequest?.to === 'technical-plan'
    ? '原方案、目录、全局事实、正文和生成进度'
    : '目录、全局事实、正文和生成进度';

  const navigationActions = state.step === 'content-edit'
    ? [
      {
        id: 'previous-step',
        label: '上一步',
        icon: <ToolbarArrowLeftIcon />,
        disabled: activeIndex <= 0,
        tooltip: activeIndex <= 0 ? '当前已经是第一步' : `返回${stepLabels[steps[activeIndex - 1]]}`,
        onClick: () => { void goToOffset(-1); },
      },
      {
        id: 'export-word',
        label: isExporting ? '导出中...' : '导出 Word',
        icon: <ToolbarDocumentIcon />,
        variant: 'primary' as const,
        disabled: isContentGenerating || isExporting || !state.outlineData,
        tooltip: isContentGenerating ? '正文生成或暂停处理中，完成暂停后再导出' : isExporting ? 'Word 正在导出，请稍候' : isContentPaused ? '正文生成已暂停，可导出当前已完成内容' : generatedContentCount ? '导出当前技术方案正文' : '可导出空目录文档，建议先生成正文',
        onClick: exportWord,
      },
    ]
    : [
      {
        id: 'previous-step',
        label: '上一步',
        icon: <ToolbarArrowLeftIcon />,
        disabled: activeIndex <= 0,
        tooltip: activeIndex <= 0 ? '当前已经是第一步' : `返回${stepLabels[steps[activeIndex - 1]]}`,
        onClick: () => { void goToOffset(-1); },
      },
      {
        id: 'next-step',
        label: '下一步',
        icon: <ToolbarArrowRightIcon />,
        variant: 'primary' as const,
        disabled: isNextDisabled,
        tooltip: nextTooltip,
        onClick: () => { void goToOffset(1); },
      },
    ];

  const toolbarGroups = [
    {
      id: 'technical-plan-reset',
      actions: [
        {
          id: 'reset',
          label: '重置',
          variant: 'danger' as const,
          tooltip: '清空当前技术方案流程',
          onClick: resetTechnicalPlan,
        },
        {
          id: 'home',
          label: '首页',
          variant: state.step === 'document-analysis' ? 'primary' as const : 'secondary' as const,
          tooltip: '回到选择标书',
          onClick: () => { void switchStep('document-analysis'); },
        },
      ],
    },
    {
      id: 'technical-plan-navigation',
      actions: navigationActions,
    },
  ];

  return (
    <div className="page-stack technical-workbench">
      {state.step === 'document-analysis' && (
        <DocumentAnalysisPage
          workflowKind={workflowKind}
          tenderFile={state.tenderFile}
          tenderMarkdown={tenderMarkdown}
          originalPlanFile={state.originalPlanFile}
          originalPlanMarkdown={originalPlanMarkdown}
          pendingSectionSelection={state.pendingSectionSelection}
          onFileImported={(nextState, markdown) => {
            setState((prev) => ({ ...prev, ...nextState }));
            setTenderMarkdown(markdown);
          }}
          onOriginalPlanImported={(nextState, markdown) => {
            setState((prev) => ({ ...prev, ...nextState }));
            setOriginalPlanMarkdown(markdown);
          }}
          onStateChanged={(nextState) => setState((prev) => ({ ...prev, ...nextState }))}
        />
      )}

      {state.step === 'bid-analysis' && (
        <BidAnalysisPage
          hasTenderFile={Boolean(state.tenderFile)}
          mode={state.bidAnalysisMode}
          selectedTaskIds={state.bidAnalysisSelectedTaskIds}
          tasks={state.bidAnalysisTasks}
          task={state.bidAnalysisTask}
          progress={state.bidAnalysisProgress}
          onProgressChange={(progress) => setState((prev) => ({ ...prev, bidAnalysisProgress: progress }))}
          onConfigSaved={(nextState) => setState((prev) => ({ ...prev, ...nextState }))}
        />
      )}
      {state.step === 'outline-generation' && (
        <OutlineEditPage
          workflowKind={workflowKind}
          projectOverview={state.projectOverview}
          techRequirements={state.techRequirements}
          outlineExpansionMode={state.outlineExpansionMode || 'ai-complement'}
          referenceKnowledgeDocumentIds={state.referenceKnowledgeDocumentIds}
          outlineData={state.outlineData}
          task={state.outlineGenerationTask}
          contentTaskStatus={state.contentGenerationTask?.status}
          onOutlineConfigChange={({ referenceKnowledgeDocumentIds, outlineExpansionMode }) => {
            setState((prev) => ({ ...prev, outlineMode: 'aligned', outlineExpansionMode, referenceKnowledgeDocumentIds }));
            window.yibiao?.technicalPlan.saveOutlineConfig({ referenceKnowledgeDocumentIds, outlineExpansionMode }).then((saved) => {
              setState((prev) => ({ ...prev, ...saved }));
            }).catch((error) => {
              showToast(error instanceof Error ? error.message : '保存目录配置失败', 'error');
            });
          }}
          onOutlineSaved={saveOutline}
          onSortGuardChange={(guard) => {
            sortGuardRef.current = guard;
          }}
        />
      )}
      {state.step === 'global-facts' && (
        <GlobalFactsPage
          outlineData={state.outlineData}
          globalFacts={state.globalFacts}
          task={state.globalFactsTask}
          onGlobalFactsSaved={saveGlobalFacts}
        />
      )}
      {state.step === 'content-edit' && (
        <ContentEditPage
          workflowKind={workflowKind}
          outlineData={state.outlineData}
          task={state.contentGenerationTask}
          contentGenerationOptions={state.contentGenerationOptions}
          sections={state.contentGenerationSections}
          onContentGenerationOptionsChange={saveContentGenerationOptions}
          onContentSaved={saveChapterContent}
        />
      )}
      {state.step === 'expand' && (
        <section className="empty-panel compact-placeholder">
          <div className="feature-under-development-overlay" role="status" aria-live="polite">
            <strong>正在开发中，敬请期待</strong>
            <span>此功能尚未完成，请先不要使用。</span>
          </div>
          <span className="section-kicker">STEP 06</span>
          <h3>扩写改写</h3>
          <p>后续接入旧方案导入、章节扩写和人工校准。</p>
        </section>
      )}

      <Dialog.Root open={sortLeaveDialogOpen} onOpenChange={(open) => !open && continueSorting()}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card outline-sort-leave-card">
            <div className="content-regenerate-card-head">
              <span className="section-kicker">目录排序</span>
              <Dialog.Title>排序结果是否保存</Dialog.Title>
              <Dialog.Description>
                当前目录排序还没有保存。保存后会更新目录编号并保留已生成正文；不保存则丢弃本次排序草稿。
              </Dialog.Description>
            </div>
            <div className="content-regenerate-actions">
              <button type="button" className="secondary-action" onClick={continueSorting} disabled={savingSortBeforeLeave}>继续排序</button>
              <button type="button" className="secondary-action" onClick={discardSortAndLeave} disabled={savingSortBeforeLeave}>不保存</button>
              <button type="button" className="primary-action" onClick={() => { void saveSortAndLeave(); }} disabled={savingSortBeforeLeave}>
                {savingSortBeforeLeave ? '正在保存...' : '保存排序'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={Boolean(workflowSwitchRequest)} onOpenChange={(open) => !open && !switchingWorkflow && cancelWorkflowSwitch()}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card workflow-switch-card">
            <div className="content-regenerate-card-head">
              <span className="section-kicker">切换模式</span>
              <Dialog.Title>确认切换到{workflowSwitchRequest ? workflowLabel(workflowSwitchRequest.to) : '新模式'}</Dialog.Title>
              <Dialog.Description>
                {workflowSwitchRequest
                  ? `当前保存的进度是「${workflowLabel(workflowSwitchRequest.from)}」模式生成的。切换到「${workflowLabel(workflowSwitchRequest.to)}」会清空之前的已有进度。是否继续？`
                  : '切换模式会清空当前模式下的生成进度。'}
              </Dialog.Description>
            </div>
            <div className="workflow-switch-summary">
              <span>保留：招标文件、招标文件解析结果、参考知识库选择</span>
              <span>清空：{workflowSwitchClearText}</span>
            </div>
            <div className="content-regenerate-actions">
              <button type="button" className="secondary-action" onClick={cancelWorkflowSwitch} disabled={switchingWorkflow}>取消</button>
              <button type="button" className="primary-action" onClick={() => { void confirmWorkflowSwitch(); }} disabled={switchingWorkflow}>
                {switchingWorkflow ? '正在切换...' : '继续切换'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={exportProgress.open}
        onOpenChange={(open) => {
          if (!open && !exportProgress.running) {
            setExportProgress(initialExportProgress);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="export-progress-card">
            <div className="content-regenerate-card-head">
              <span className="section-kicker">Word 导出</span>
              <Dialog.Title>{exportProgress.running ? '正在导出 Word' : exportProgress.error ? '导出失败' : '导出完成'}</Dialog.Title>
              <Dialog.Description>
                {exportProgress.mermaidCount > 0
                  ? `本次包含 ${exportProgress.mermaidCount} 张 Mermaid 图，导出时会通过 mermaid.ink 转换成 Word 图片，速度受网络影响。`
                  : '正在将正文、表格和图片写入 Word 文档。'}
              </Dialog.Description>
            </div>
            <div className="export-progress-body">
              <div className="content-generation-progress-track" aria-label={`Word 导出进度 ${exportProgress.progress}%`}>
                <span style={{ width: `${exportProgress.progress}%` }} />
              </div>
              <p>{exportProgress.message || '正在处理导出任务，请稍候。'}</p>
              {exportProgress.warnings.length > 0 && (
                <div className="export-warning-list">
                  <strong>需要核对</strong>
                  {exportProgress.warnings.slice(0, 4).map((warning) => <small key={warning}>{warning}</small>)}
                  {exportProgress.warnings.length > 4 && <small>还有 {exportProgress.warnings.length - 4} 条图片提示，请打开导出的 Word 核对。</small>}
                </div>
              )}
            </div>
            {!exportProgress.running && (
              <div className="content-regenerate-actions">
                <Dialog.Close className="primary-action" type="button">知道了</Dialog.Close>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <FloatingToolbar groups={toolbarGroups} label="技术方案工具条" />
    </div>
  );
}

export default TechnicalPlanHome;
