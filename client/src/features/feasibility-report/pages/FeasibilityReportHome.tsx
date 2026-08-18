import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import { AppDialog, AppSwitch, FloatingToolbar, ProgressBar, ToolbarArrowLeftIcon, ToolbarArrowRightIcon, ToolbarDocumentIcon, ToolbarSparkleIcon, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type { OutlineItem } from '../../../shared/types';
import type { ExportFormatConfig, ExportTemplateRecord } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import type { SectionId } from '../../../shared/types/navigation';
import { TemplatePreview } from '../../export-format/pages/ExportFormatPage';
import { buildExportFormatCssVars } from '../../../shared/utils/exportFormatCss';
import type { WordExportProgressEvent } from '../../../shared/types';
import AnalysisPage from './AnalysisPage';
import ContentPage from './ContentPage';
import MaterialsPage from './MaterialsPage';
import OutlinePage from './OutlinePage';
import ParametersPage from './ParametersPage';
import SourcesPage from './SourcesPage';
import type { FeasibilityExportOptions, FeasibilityOutlineTemplate, FeasibilityProjectInfo, FeasibilityReportState, FeasibilityReportStep } from '../types';
import {
  DEFAULT_FEASIBILITY_EXPORT_OPTIONS,
  DEFAULT_FEASIBILITY_PROJECT_INFO,
  FEASIBILITY_STEP_LABELS,
  FEASIBILITY_STEPS,
} from '../types';

interface FeasibilityReportHomeProps {
  registerLeaveGuard?: (guard: ((nextSection?: string) => Promise<boolean>) | null) => void;
  onSectionChange?: (section: SectionId) => void;
}

const initialExportProgress = {
  open: false,
  running: false,
  progress: 0,
  message: '',
  warnings: [] as string[],
  filePath: '',
  error: '',
};

const PET_PLUGIN_ID = 'openbidkit-pet';

function hasOwn(value: object | null | undefined, field: string) {
  return Object.prototype.hasOwnProperty.call(value || {}, field);
}

function isActiveStatus(status?: string) {
  return status === 'running' || status === 'pausing';
}

function sameProjectInfo(left: FeasibilityProjectInfo, right: FeasibilityProjectInfo) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const emptyState: FeasibilityReportState = {
  step: 'materials',
  projectInfo: DEFAULT_FEASIBILITY_PROJECT_INFO,
  sourceFiles: [],
  analysisMarkdown: '',
  outlineTemplate: 'government',
  targetWords: 30000,
  referenceDocumentIds: [],
  keyParametersMarkdown: '',
  outlineData: null,
};

function FeasibilityReportHome({ registerLeaveGuard, onSectionChange }: FeasibilityReportHomeProps) {
  const { showToast } = useToast();
  const [state, setState] = useState<FeasibilityReportState>(emptyState);
  const [draftProjectInfo, setDraftProjectInfo] = useState<FeasibilityProjectInfo>(DEFAULT_FEASIBILITY_PROJECT_INFO);
  const [analysisDraft, setAnalysisDraft] = useState('');
  const [parametersDraft, setParametersDraft] = useState('');
  const [busyImport, setBusyImport] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [exportOptions, setExportOptions] = useState<FeasibilityExportOptions>(DEFAULT_FEASIBILITY_EXPORT_OPTIONS);
  const [exportTemplateDialogOpen, setExportTemplateDialogOpen] = useState(false);
  const [exportTemplates, setExportTemplates] = useState<ExportTemplateRecord[]>([]);
  const [exportTemplatesLoading, setExportTemplatesLoading] = useState(false);
  const [exportTemplateSearch, setExportTemplateSearch] = useState('');
  const [selectedExportTemplateId, setSelectedExportTemplateId] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(initialExportProgress);
  const [petInstallDialogOpen, setPetInstallDialogOpen] = useState(false);
  const [installingPetPlugin, setInstallingPetPlugin] = useState(false);

  const activeIndex = Math.max(0, FEASIBILITY_STEPS.indexOf(state.step));
  const analysisRunning = isActiveStatus(state.analysisTask?.status);
  const outlineRunning = isActiveStatus(state.outlineTask?.status);
  const outlineAdjusting = isActiveStatus(state.outlineAdjustmentTask?.status);
  const parametersRunning = isActiveStatus(state.parametersTask?.status);
  const contentRunning = isActiveStatus(state.contentTask?.status);
  const contentPaused = state.contentTask?.status === 'paused';
  const reviewRunning = isActiveStatus(state.humanWritingTask?.status);
  const anyRunning = analysisRunning || outlineRunning || outlineAdjusting || parametersRunning || contentRunning || reviewRunning;
  const selectedExportTemplate = exportTemplates.find((item) => item.template_id === selectedExportTemplateId) || null;
  const exportTemplatePreviewStyle = useMemo(
    () => buildExportFormatCssVars(selectedExportTemplate?.config || DEFAULT_EXPORT_FORMAT),
    [selectedExportTemplate],
  );
  const filteredExportTemplates = useMemo(() => {
    const keyword = exportTemplateSearch.trim().toLowerCase();
    if (!keyword) return exportTemplates;
    return exportTemplates.filter((template) => template.template_name.toLowerCase().includes(keyword));
  }, [exportTemplateSearch, exportTemplates]);

  useEffect(() => {
    trackPageView(`feasibility-report/${state.step}`);
    void window.yibiao?.ui?.setCurrentView({ section: 'feasibility-report', step: state.step });
  }, [state.step]);

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | undefined;

    const applyTaskPatch = (event: { feasibilityReportPatch?: Partial<FeasibilityReportState> }) => {
      const patch = event.feasibilityReportPatch;
      if (!patch) return;
      setState((prev) => {
        const next = { ...prev };
        (Object.keys(patch) as Array<keyof FeasibilityReportState>).forEach((key) => {
          if (hasOwn(patch, key)) {
            (next as Record<string, unknown>)[key] = patch[key];
          }
        });
        return next;
      });
      if (hasOwn(patch, 'analysisMarkdown') && patch.analysisMarkdown !== undefined) {
        setAnalysisDraft(patch.analysisMarkdown || '');
      }
      if (hasOwn(patch, 'keyParametersMarkdown') && patch.keyParametersMarkdown !== undefined) {
        setParametersDraft(patch.keyParametersMarkdown || '');
      }
      if (hasOwn(patch, 'projectInfo') && patch.projectInfo) {
        setDraftProjectInfo(patch.projectInfo);
      }
    };

    void (async () => {
      try {
        const next = await window.yibiao?.feasibilityReport.loadState();
        if (!mounted) return;
        if (next) {
          setState(next);
          setDraftProjectInfo(next.projectInfo);
          setAnalysisDraft(next.analysisMarkdown);
          setParametersDraft(next.keyParametersMarkdown);
        }
      } catch (error) {
        if (mounted) {
          showToast(error instanceof Error ? error.message : '读取可研状态失败', 'error');
        }
      }
      if (!mounted || !window.yibiao?.tasks) return;
      unsubscribe = window.yibiao.tasks.onTaskEvent(applyTaskPatch);
      window.yibiao.tasks.getActiveTasks().catch(() => undefined);
    })();

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [showToast]);

  useEffect(() => {
    registerLeaveGuard?.(async () => {
      if (anyRunning) {
        showToast('后台任务仍在运行，离开页面不会取消任务。', 'info');
      }
      return true;
    });
    return () => registerLeaveGuard?.(null);
  }, [anyRunning, registerLeaveGuard, showToast]);

  const applyLoadedState = (next: FeasibilityReportState) => {
    setState(next);
    setDraftProjectInfo(next.projectInfo);
    setAnalysisDraft(next.analysisMarkdown);
    setParametersDraft(next.keyParametersMarkdown);
  };

  const persistProjectInfoIfNeeded = async () => {
    if (sameProjectInfo(draftProjectInfo, state.projectInfo)) {
      return state;
    }
    const saved = await window.yibiao!.feasibilityReport.saveProjectInfo(draftProjectInfo);
    applyLoadedState(saved);
    return saved;
  };

  const persistAnalysisIfNeeded = async () => {
    if (analysisDraft === state.analysisMarkdown) return;
    const next = await window.yibiao!.feasibilityReport.saveAnalysis(analysisDraft);
    applyLoadedState(next);
  };

  const persistParametersIfNeeded = async () => {
    if (parametersDraft === state.keyParametersMarkdown) return;
    const next = await window.yibiao!.feasibilityReport.saveKeyParameters(parametersDraft);
    applyLoadedState(next);
  };

  const switchStep = async (step: FeasibilityReportStep) => {
    if (step !== 'materials' && !draftProjectInfo.projectName.trim()) {
      showToast('请先填写项目名称', 'info');
      return;
    }
    const movingForward = FEASIBILITY_STEPS.indexOf(step) > activeIndex;
    try {
      if (state.step === 'materials') {
        await persistProjectInfoIfNeeded();
      }
      if (movingForward && state.step === 'analysis') {
        await persistAnalysisIfNeeded();
      }
      if (movingForward && state.step === 'parameters') {
        await persistParametersIfNeeded();
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存当前步骤失败', 'error');
      return;
    }
    setState((prev) => ({ ...prev, step }));
    window.yibiao?.feasibilityReport.updateStep(step).catch((error) => {
      showToast(error instanceof Error ? error.message : '保存步骤失败', 'error');
    });
  };

  const goToOffset = async (offset: number) => {
    const next = FEASIBILITY_STEPS[activeIndex + offset];
    if (next) await switchStep(next);
  };

  const importSources = async (filePaths?: string[]) => {
    setBusyImport(true);
    try {
      const result = await window.yibiao!.feasibilityReport.importSourceDocuments(filePaths);
      if (!result?.success) {
        showToast(result?.message || '未导入文件', result?.message === '已取消选择' ? 'info' : 'error');
        return;
      }
      applyLoadedState(await window.yibiao!.feasibilityReport.loadState());
      showToast(result.message || '资料已导入', 'success');
    } finally {
      setBusyImport(false);
    }
  };

  const removeSource = async (sourceId: string) => {
    const result = await window.yibiao!.feasibilityReport.removeSourceDocument(sourceId);
    if (!result.success) {
      showToast(result.message || '移除失败', 'error');
      return;
    }
    applyLoadedState(await window.yibiao!.feasibilityReport.loadState());
    showToast(result.message || '已移除资料', 'success');
  };

  const startAnalysis = async () => {
    try {
      await persistProjectInfoIfNeeded();
      await window.yibiao!.tasks.startFeasibilityAnalysis();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动分析失败', 'error');
    }
  };

  const saveAnalysis = async () => {
    setSaving(true);
    try {
      const next = await window.yibiao!.feasibilityReport.saveAnalysis(analysisDraft);
      applyLoadedState(next);
      showToast('资料分析已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存分析失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const startOutline = async (config: {
    outlineTemplate: FeasibilityOutlineTemplate;
    targetWords: number;
    referenceDocumentIds: string[];
  }) => {
    try {
      await window.yibiao!.tasks.startFeasibilityOutline(config);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动目录生成失败', 'error');
    }
  };

  const saveKeyParameters = async () => {
    setSaving(true);
    try {
      const next = await window.yibiao!.feasibilityReport.saveKeyParameters(parametersDraft);
      applyLoadedState(next);
      showToast('关键参数已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存关键参数失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const loadExportTemplates = useCallback(async () => {
    setExportTemplatesLoading(true);
    try {
      const templates = await window.yibiao?.templates.list();
      const nextTemplates = templates || [];
      setExportTemplates(nextTemplates);
      setSelectedExportTemplateId((prev) => (nextTemplates.some((item) => item.template_id === prev) ? prev : nextTemplates[0]?.template_id || ''));
    } catch (error) {
      setExportTemplates([]);
      setSelectedExportTemplateId('');
      showToast(error instanceof Error ? error.message : '读取导出模板失败', 'error');
    } finally {
      setExportTemplatesLoading(false);
    }
  }, [showToast]);

  const openExportTemplateDialog = async () => {
    if (!state.outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }
    setExportTemplateDialogOpen(true);
    setExportTemplateSearch('');
    await loadExportTemplates();
  };

  const runExportWord = async (exportFormat: ExportFormatConfig) => {
    if (!state.outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }
    const requestId = `export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let unsubscribe: (() => void) | undefined;
    try {
      setIsExporting(true);
      setExportProgress({
        ...initialExportProgress,
        open: true,
        running: true,
        progress: 2,
        message: '正在准备导出 Word。',
      });
      unsubscribe = window.yibiao?.export.onWordExportProgress((event: WordExportProgressEvent) => {
        if (event.requestId && event.requestId !== requestId) return;
        setExportProgress((prev) => ({
          ...prev,
          open: true,
          running: event.phase === 'running',
          progress: event.progress,
          message: event.message,
          warnings: event.warnings || prev.warnings,
          error: event.phase === 'error' ? event.message : '',
        }));
      });
      const result = await window.yibiao!.export.exportWord({
        requestId,
        project_name: state.projectInfo.projectName || '可行性研究报告',
        outline: state.outlineData.outline,
        export_format: exportFormat,
        feasibility_options: {
          ...exportOptions,
          project_info: state.projectInfo,
        },
      });
      if (result.canceled) {
        setExportProgress(initialExportProgress);
        showToast('已取消导出', 'info');
        return;
      }
      if (!result.success) {
        throw new Error(result.message || '导出失败');
      }
      setExportProgress((prev) => ({
        ...prev,
        open: true,
        running: false,
        progress: 100,
        message: result.message || 'Word 已导出，请打开文档核对封面、附表和正文。',
        warnings: result.warnings || prev.warnings,
        filePath: result.path || '',
      }));
      showToast(result.message || 'Word 已导出', result.warnings?.length ? 'info' : 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出失败';
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
      setIsExporting(false);
      unsubscribe?.();
    }
  };

  const confirmExportTemplate = async () => {
    if (!selectedExportTemplate) {
      showToast('请先选择导出模板', 'info');
      return;
    }
    setExportTemplateDialogOpen(false);
    await runExportWord(selectedExportTemplate.config);
  };

  const createExportTemplate = () => {
    if (!onSectionChange) {
      showToast('请从左侧菜单进入模板设置新建模板', 'info');
      return;
    }
    setExportTemplateDialogOpen(false);
    onSectionChange('new-template');
  };

  const handleOpenExportedFile = async () => {
    if (!exportProgress.filePath) return;
    try {
      await window.yibiao?.export.openFile(exportProgress.filePath);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开文件失败', 'error');
    }
  };

  const openPetAiChat = useCallback(async () => {
    await window.yibiao!.plugins.notifyEvent(PET_PLUGIN_ID, 'open-ai-chat');
  }, []);

  const handleAiAdjustClick = useCallback(async () => {
    try {
      const plugins = await window.yibiao!.plugins.getAvailablePlugins();
      const pet = plugins.find((plugin) => plugin.id === PET_PLUGIN_ID);
      if (!pet) {
        showToast('插件市场中未找到桌宠插件，请在插件市场刷新后重试', 'error');
        return;
      }
      if (!pet.installed || !pet.enabled) {
        setPetInstallDialogOpen(true);
        return;
      }
      await openPetAiChat();
      showToast('请在桌宠对话框中输入调整要求', 'info');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开桌宠 AI 对话失败', 'error');
    }
  }, [openPetAiChat, showToast]);

  const installPetPluginAndOpenChat = useCallback(async () => {
    setInstallingPetPlugin(true);
    try {
      const plugins = await window.yibiao!.plugins.getAvailablePlugins();
      const pet = plugins.find((plugin) => plugin.id === PET_PLUGIN_ID);
      if (!pet) {
        throw new Error('插件市场中未找到桌宠插件');
      }
      if (!pet.installed) {
        await window.yibiao!.plugins.install(PET_PLUGIN_ID);
      }
      await window.yibiao!.plugins.enable(PET_PLUGIN_ID);
      setPetInstallDialogOpen(false);
      await openPetAiChat();
      showToast('桌宠已启用，请在桌宠对话框中输入调整要求', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '安装桌宠插件失败', 'error');
    } finally {
      setInstallingPetPlugin(false);
    }
  }, [openPetAiChat, showToast]);

  const aiAdjustDisabled = !state.outlineData?.outline?.length || outlineRunning || outlineAdjusting;
  const aiAdjustTooltip = outlineAdjusting
    ? 'AI 正在按要求调整目录，请稍候'
    : outlineRunning || !state.outlineData?.outline?.length
      ? '目录生成结束后才能使用 AI 调整'
      : '通过桌宠 AI 对话调整当前目录';

  const nextDisabled = state.step === 'materials'
    ? !draftProjectInfo.projectName.trim()
    : state.step === 'sources'
      ? busyImport
      : state.step === 'analysis'
        ? !state.analysisMarkdown.trim() || analysisRunning
        : state.step === 'outline'
          ? !state.outlineData?.outline?.length || outlineRunning || outlineAdjusting
          : state.step === 'parameters'
            ? !state.keyParametersMarkdown.trim() || parametersRunning
            : true;

  const toolbarGroups: FloatingToolbarGroup[] = [
    {
      id: 'feasibility-reset',
      actions: [{ id: 'reset', label: '重置', variant: 'danger', onClick: () => setResetOpen(true) }],
    },
    ...(state.step === 'outline' ? [{
      id: 'feasibility-ai',
      actions: [
        {
          id: 'ai-adjust',
          label: outlineAdjusting ? 'AI调整中' : 'AI调整',
          icon: <ToolbarSparkleIcon />,
          variant: 'ai' as const,
          disabled: aiAdjustDisabled,
          tooltip: aiAdjustTooltip,
          onClick: () => { void handleAiAdjustClick(); },
        },
      ],
    }] : []),
    {
      id: 'feasibility-navigation',
      actions: state.step === 'content'
        ? [
          {
            id: 'previous-step',
            label: '上一步',
            icon: <ToolbarArrowLeftIcon />,
            disabled: activeIndex <= 0 || anyRunning,
            onClick: () => { void goToOffset(-1); },
          },
          {
            id: 'export-word',
            label: isExporting ? '导出中...' : '导出 Word',
            icon: <ToolbarDocumentIcon />,
            variant: 'primary',
            disabled: contentRunning || reviewRunning || isExporting || !state.outlineData,
            onClick: () => { void openExportTemplateDialog(); },
          },
        ]
        : [
          {
            id: 'previous-step',
            label: '上一步',
            icon: <ToolbarArrowLeftIcon />,
            disabled: activeIndex <= 0,
            tooltip: activeIndex <= 0 ? '当前已经是第一步' : `返回${FEASIBILITY_STEP_LABELS[FEASIBILITY_STEPS[activeIndex - 1]]}`,
            onClick: () => { void goToOffset(-1); },
          },
          {
            id: 'next-step',
            label: '下一步',
            icon: <ToolbarArrowRightIcon />,
            variant: 'primary',
            disabled: nextDisabled,
            tooltip: nextDisabled ? '请先完成本步骤' : `进入${FEASIBILITY_STEP_LABELS[FEASIBILITY_STEPS[activeIndex + 1]]}`,
            onClick: () => { void goToOffset(1); },
          },
        ],
    },
  ];

  return (
    <div className="page-stack technical-workbench">
      {state.step === 'materials' && (
        <MaterialsPage
          projectInfo={draftProjectInfo}
          onProjectInfoChange={setDraftProjectInfo}
        />
      )}
      {state.step === 'sources' && (
        <SourcesPage
          sourceFiles={state.sourceFiles}
          busy={busyImport}
          onImport={importSources}
          onRemove={removeSource}
        />
      )}
      {state.step === 'analysis' && (
        <AnalysisPage
          analysisMarkdown={analysisDraft}
          task={state.analysisTask}
          running={analysisRunning}
          saving={saving}
          dirty={analysisDraft !== state.analysisMarkdown}
          onChange={setAnalysisDraft}
          onSave={saveAnalysis}
          onStart={startAnalysis}
        />
      )}
      {state.step === 'outline' && (
        <OutlinePage
          outlineTemplate={state.outlineTemplate}
          targetWords={state.targetWords}
          referenceDocumentIds={state.referenceDocumentIds}
          outlineData={state.outlineData}
          task={outlineAdjusting ? state.outlineAdjustmentTask : state.outlineTask}
          running={outlineRunning || outlineAdjusting}
          locked={contentRunning || contentPaused || reviewRunning || outlineAdjusting}
          hasAnalysis={Boolean(state.analysisMarkdown.trim())}
          onConfigChange={async (config) => {
            const next = await window.yibiao!.feasibilityReport.saveOutlineConfig(config);
            setState(next);
          }}
          onOutlineSaved={async (request) => {
            const patch = await window.yibiao!.feasibilityReport.saveOutline(request);
            setState((prev) => ({ ...prev, ...patch }));
          }}
          onStart={startOutline}
        />
      )}
      {state.step === 'parameters' && (
        <ParametersPage
          keyParametersMarkdown={parametersDraft}
          task={state.parametersTask}
          running={parametersRunning}
          saving={saving}
          dirty={parametersDraft !== state.keyParametersMarkdown}
          hasOutline={Boolean(state.outlineData?.outline?.length)}
          onChange={setParametersDraft}
          onSave={saveKeyParameters}
          onStart={async () => {
            try {
              await window.yibiao!.tasks.startFeasibilityParameters();
            } catch (error) {
              showToast(error instanceof Error ? error.message : '启动关键参数生成失败', 'error');
            }
          }}
        />
      )}
      {state.step === 'content' && (
        <ContentPage
          outlineData={state.outlineData}
          contentTask={state.contentTask}
          humanWritingTask={state.humanWritingTask}
          generating={contentRunning}
          reviewing={reviewRunning}
          locked={contentRunning || contentPaused || reviewRunning}
          hasKeyParameters={Boolean(state.keyParametersMarkdown.trim())}
          onSave={async (item: OutlineItem, content: string) => {
            const patch = await window.yibiao!.feasibilityReport.saveChapterContent({ nodeId: item.id, content });
            setState((prev) => ({ ...prev, ...patch }));
            showToast('章节已保存', 'success');
          }}
        />
      )}

      <FloatingToolbar groups={toolbarGroups} label="可行性研究报告工具条" />

      <AppDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        kicker="重置"
        title="重置可研报告？"
        description="将清空本模块的项目资料、分析、目录、关键参数和正文，不影响技术方案、知识库和其他功能。"
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setResetOpen(false)}>取消</button>
            <button
              type="button"
              className="danger-action"
              onClick={() => {
                void window.yibiao!.feasibilityReport.clear().then(async (result) => {
                  setResetOpen(false);
                  applyLoadedState(await window.yibiao!.feasibilityReport.loadState());
                  showToast(result.message || '已重置', 'success');
                }).catch((error) => showToast(error instanceof Error ? error.message : '重置失败', 'error'));
              }}
            >确认重置</button>
          </>
        )}
      />

      <AppDialog
        open={petInstallDialogOpen}
        onOpenChange={(open) => !open && !installingPetPlugin && setPetInstallDialogOpen(false)}
        kicker="AI 调整"
        title="需要安装桌宠插件"
        description="AI 调整通过桌宠的 AI 对话完成。当前桌宠插件尚未安装或未启用，是否立即安装并启用？"
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setPetInstallDialogOpen(false)} disabled={installingPetPlugin}>取消</button>
            <button type="button" className="primary-action" onClick={() => { void installPetPluginAndOpenChat(); }} disabled={installingPetPlugin}>
              {installingPetPlugin ? '正在安装...' : '安装并启用'}
            </button>
          </>
        )}
      />

      <Dialog.Root open={exportTemplateDialogOpen} onOpenChange={(open) => !open && !isExporting && setExportTemplateDialogOpen(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="export-template-select-dialog feasibility-export-dialog">
            <div className="export-template-select-head">
              <div>
                <span className="section-kicker">Word 导出</span>
                <Dialog.Title>导出可行性研究报告</Dialog.Title>
                <Dialog.Description>选择已保存模板，并确认封面、编制说明和基本情况附表。无财务测算时只会生成项目基本情况表。</Dialog.Description>
              </div>
              <Dialog.Close className="detail-help-close" type="button" aria-label="关闭模板选择" disabled={isExporting}>×</Dialog.Close>
            </div>

            <div className="feasibility-export-options">
              <label>
                <span>可研专用封面</span>
                <AppSwitch checked={exportOptions.includeCover} onCheckedChange={(checked) => setExportOptions((prev) => ({ ...prev, includeCover: checked }))} aria-label="可研专用封面" />
              </label>
              <label>
                <span>编制说明</span>
                <AppSwitch checked={exportOptions.includePreparationNotes} onCheckedChange={(checked) => setExportOptions((prev) => ({ ...prev, includePreparationNotes: checked }))} aria-label="编制说明" />
              </label>
              <label>
                <span>基本情况附表</span>
                <AppSwitch checked={exportOptions.includeAppendixTables} onCheckedChange={(checked) => setExportOptions((prev) => ({ ...prev, includeAppendixTables: checked }))} aria-label="基本情况附表" />
              </label>
              <label>
                <span>编制单位</span>
                <input value={exportOptions.preparationUnit} onChange={(event) => setExportOptions((prev) => ({ ...prev, preparationUnit: event.target.value }))} placeholder="导出封面和编制说明使用" />
              </label>
              <label>
                <span>密级</span>
                <input value={exportOptions.securityLevel} onChange={(event) => setExportOptions((prev) => ({ ...prev, securityLevel: event.target.value }))} placeholder="可留空" />
              </label>
            </div>

            <div className="export-template-select-body">
              <section className="export-template-select-list-panel" aria-label="模板列表">
                <input
                  className="export-template-select-search"
                  type="text"
                  value={exportTemplateSearch}
                  onChange={(event) => setExportTemplateSearch(event.target.value)}
                  placeholder="搜索模板名称"
                />
                <div className="export-template-select-list">
                  {exportTemplatesLoading ? (
                    <div className="export-template-select-empty"><strong>正在读取模板</strong><span>请稍候...</span></div>
                  ) : null}
                  {!exportTemplatesLoading && filteredExportTemplates.length === 0 ? (
                    <div className="export-template-select-empty">
                      <strong>{exportTemplates.length ? '没有匹配模板' : '暂无可用模板'}</strong>
                      <span>{exportTemplates.length ? '请换个关键词搜索，或新建一个模板。' : '请先新建并保存模板，保存后再返回导出。'}</span>
                      <button type="button" className="secondary-action" onClick={createExportTemplate} disabled={isExporting}>新建模板</button>
                    </div>
                  ) : null}
                  {!exportTemplatesLoading && filteredExportTemplates.map((template) => {
                    const selected = selectedExportTemplate?.template_id === template.template_id;
                    return (
                      <button
                        type="button"
                        className={`export-template-select-row${selected ? ' is-active' : ''}`}
                        key={template.template_id}
                        onClick={() => setSelectedExportTemplateId(template.template_id)}
                      >
                        <strong>{template.template_name}</strong>
                      </button>
                    );
                  })}
                </div>
              </section>
              <section className="export-template-select-preview" aria-label="模板预览">
                {selectedExportTemplate ? (
                  <>
                    <div className="export-template-select-preview-head">
                      <span className="section-kicker">预览</span>
                      <strong>{selectedExportTemplate.template_name}</strong>
                    </div>
                    <TemplatePreview config={selectedExportTemplate.config} previewStyle={exportTemplatePreviewStyle} />
                  </>
                ) : (
                  <div className="export-template-select-preview-empty">
                    <strong>暂无模板预览</strong>
                    <span>选择模板后会在这里显示预览。</span>
                  </div>
                )}
              </section>
            </div>

            <div className="content-regenerate-actions export-template-select-actions">
              <button type="button" className="secondary-action" onClick={createExportTemplate} disabled={isExporting}>新建模板</button>
              <Dialog.Close className="secondary-action" type="button" disabled={isExporting}>取消</Dialog.Close>
              <button type="button" className="primary-action" onClick={() => { void confirmExportTemplate(); }} disabled={exportTemplatesLoading || !selectedExportTemplate || isExporting}>继续导出</button>
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
              <Dialog.Description>正在将封面、附表、正文、表格和插图指引写入 Word 文档。</Dialog.Description>
            </div>
            <div className="export-progress-body">
              <ProgressBar value={exportProgress.progress} label={`Word 导出进度 ${exportProgress.progress}%`} />
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
                {!exportProgress.error && exportProgress.filePath ? <button className="primary-action" type="button" onClick={() => { void handleOpenExportedFile(); }}>打开文件</button> : null}
                <Dialog.Close className={exportProgress.filePath && !exportProgress.error ? 'secondary-action' : 'primary-action'} type="button">知道了</Dialog.Close>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export default FeasibilityReportHome;
