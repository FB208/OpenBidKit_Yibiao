import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useState } from 'react';
import DocumentAnalysisPage from './DocumentAnalysisPage';
import BidAnalysisPage from './BidAnalysisPage';
import OutlineEditPage from '../../technical-plan/pages/OutlineEditPage';
import GlobalFactsPage from './GlobalFactsPage';
import ContentEditPage from './ContentEditPage';
import ExpandPage from './ExpandPage';
import { useBusinessBidWorkflow } from '../hooks/useBusinessBidWorkflow';
import { FloatingToolbar, ToolbarArrowLeftIcon, ToolbarArrowRightIcon, ToolbarDocumentIcon, useToast } from '../../../shared/ui';
import { BUSINESS_BID_STEPS, BUSINESS_BID_STEP_LABELS } from '../types';
import type { BusinessBidState, BusinessBidStep, OutlineData } from '../types';
import type { WordExportProgressEvent } from '../../../shared/types';
import type { ExportFormatConfig, ExportTemplateRecord } from '../../../shared/types/exportFormat';
import type { OutlineMode, OutlineExpansionMode, OutlineWordControlOptions, SaveOutlineSelectionRequest } from '../../../shared/types';
import type { SaveOutlineRequest } from '../../technical-plan/types';


function updateOutlineItemContent(items: OutlineData['outline'], itemId: string, content: string): OutlineData['outline'] {
  return items.map((item) => {
    if (item.id === itemId) return { ...item, content };
    return item.children?.length ? { ...item, children: updateOutlineItemContent(item.children, itemId, content) } : item;
  });
}

function countMermaidDiagrams(content: string) {
  const blocks = (String(content || '').match(/```mermaid[\s\S]*?```/gi) || []).length;
  const ink = (String(content || '').match(/https:\/\/mermaid\.ink\/img\//gi) || []).length;
  return blocks + ink;
}

function countOutlineMermaid(items: OutlineData['outline']) {
  const collect = (list: OutlineData['outline']): number => list.reduce((sum, item) => sum + countMermaidDiagrams(item.content || '') + (item.children ? collect(item.children) : 0), 0);
  return collect(items);
}

const MAX_UI_TASK_LOGS = 80;

function trimTaskLogs<T extends { logs?: string[] } | undefined>(task: T): T {
  if (!task?.logs || task.logs.length <= MAX_UI_TASK_LOGS) return task;
  return { ...task, logs: task.logs.slice(-MAX_UI_TASK_LOGS) };
}

interface ExportProgressState {
  open: boolean;
  running: boolean;
  progress: number;
  message: string;
  warnings: string[];
  mermaidCount: number;
  filePath?: string;
  error?: string;
}

const initialExportProgress: ExportProgressState = { open: false, running: false, progress: 0, message: '', warnings: [], mermaidCount: 0 };

export default function BusinessBidHome() {
  const { hydrated, state, setState } = useBusinessBidWorkflow();
  const { showToast } = useToast();
  const [tenderMarkdown, setTenderMarkdown] = useState('');
  const [hasTechnicalPlan, setHasTechnicalPlan] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgressState>(initialExportProgress);
  const [exportTemplateDialogOpen, setExportTemplateDialogOpen] = useState(false);
  const [exportTemplates, setExportTemplates] = useState<ExportTemplateRecord[]>([]);
  const [exportTemplatesLoading, setExportTemplatesLoading] = useState(false);
  const [exportTemplateSearch, setExportTemplateSearch] = useState('');
  const [selectedExportTemplateId, setSelectedExportTemplateId] = useState('');
  const activeIndex = BUSINESS_BID_STEPS.indexOf(state.step);
  const isExporting = exportProgress.running;

  const filteredExportTemplates = useMemo(() => {
    const keyword = exportTemplateSearch.trim().toLowerCase();
    if (!keyword) return exportTemplates;
    return exportTemplates.filter((template) => template.template_name.toLowerCase().includes(keyword));
  }, [exportTemplateSearch, exportTemplates]);
  const selectedExportTemplate = filteredExportTemplates.find((template) => template.template_id === selectedExportTemplateId) || filteredExportTemplates[0] || null;

  const isClauseTaskRunning = state.clauseAnalysisTask?.status === 'running';
  const isOutlineTaskRunning = state.outlineGenerationTask?.status === 'running';
  const isFactsTaskRunning = state.globalFactsTask?.status === 'running';
  const contentTaskStatus = state.contentGenerationTask?.status;
  const isContentGenerating = contentTaskStatus === 'running' || contentTaskStatus === 'pausing';
  const generatedContentCount = state.outlineData?.outline
    ? collectLeaf(state.outlineData.outline).filter((item) => item.content?.trim()).length
    : 0;

  useEffect(() => {
    if (hydrated) window.yibiao?.businessBid.hasTechnicalPlan().then((value) => setHasTechnicalPlan(Boolean(value))).catch(() => setHasTechnicalPlan(false));
  }, [hydrated, state.referenceTechnicalPlan]);

  useEffect(() => {
    if (!hydrated || state.step !== 'document-analysis') return;
    if (!state.tenderFile) { setTenderMarkdown(''); return; }
    let mounted = true;
    window.yibiao?.businessBid.readTenderMarkdown().then((markdown) => { if (mounted) setTenderMarkdown(markdown || ''); }).catch(() => {});
    return () => { mounted = false; };
  }, [hydrated, state.step, state.tenderFile]);

  useEffect(() => {
    if (!hydrated || !window.yibiao?.tasks) return undefined;
    const unsubscribe = window.yibiao.tasks.onTaskEvent<BusinessBidState>((event) => {
      const businessBidPatch = event.businessBidPatch as Partial<BusinessBidState> | undefined;
      if (!businessBidPatch && !event.businessBid) return;
      const patch = businessBidPatch || {};
      setState((prev) => ({
        ...prev,
        ...patch,
        clauseAnalysisTask: patch.clauseAnalysisTask ? trimTaskLogs(patch.clauseAnalysisTask) : prev.clauseAnalysisTask,
        outlineGenerationTask: patch.outlineGenerationTask ? trimTaskLogs(patch.outlineGenerationTask) : prev.outlineGenerationTask,
        globalFactsTask: patch.globalFactsTask ? trimTaskLogs(patch.globalFactsTask) : prev.globalFactsTask,
        contentGenerationTask: patch.contentGenerationTask ? trimTaskLogs(patch.contentGenerationTask) : prev.contentGenerationTask,
      }));
    });
    window.yibiao.tasks.getActiveTasks().catch(() => {});
    return unsubscribe;
  }, [hydrated, setState]);

  const switchStep = async (step: BusinessBidStep) => {
    if (step === state.step) return;
    setState((prev) => ({ ...prev, step }));
    window.yibiao?.businessBid.updateStep(step).catch((error) => showToast(error instanceof Error ? error.message : '保存步骤失败', 'error'));
  };

  const goToOffset = async (offset: number) => {
    const nextStep = BUSINESS_BID_STEPS[activeIndex + offset];
    if (nextStep) await switchStep(nextStep);
  };

  const resetBusinessBid = async () => {
    if (!window.confirm('会清空整个商务标编写进度，是否确认？')) return;
    try {
      const result = await window.yibiao?.businessBid.clear();
      if (result?.state) setState(result.state);
      setTenderMarkdown('');
      showToast(result?.message || '商务标已重置', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重置商务标失败', 'error');
    }
  };

  const isNextDisabled = activeIndex >= BUSINESS_BID_STEPS.length - 1
    || (state.step === 'document-analysis' && !state.tenderFile)
    || (state.step === 'bid-analysis' && !(state.clauseItems?.length))
    || (state.step === 'outline-generation' && !state.outlineData)
    || (state.step === 'global-facts' && !state.globalFacts.length);

  const nextTooltip = state.step === 'document-analysis' && !state.tenderFile
    ? '上传完招标文件后才能进入下一步'
    : state.step === 'bid-analysis' && !(state.clauseItems?.length)
      ? '商务条款解析完成后才能进入目录生成'
      : state.step === 'outline-generation' && !state.outlineData
        ? '目录生成完成后才能进入全局事实设定'
        : state.step === 'global-facts' && !state.globalFacts.length
          ? '全局事实设定完成后才能进入正文生成'
          : activeIndex >= BUSINESS_BID_STEPS.length - 1
            ? '当前已经是最后一步'
            : `进入${BUSINESS_BID_STEP_LABELS[BUSINESS_BID_STEPS[activeIndex + 1]]}`;

  const loadExportTemplates = async () => {
    setExportTemplatesLoading(true);
    try {
      const templates = await window.yibiao?.templates.list();
      const next = templates || [];
      setExportTemplates(next);
      setSelectedExportTemplateId((prev) => (next.some((t) => t.template_id === prev) ? prev : next[0]?.template_id || ''));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取导出模板失败', 'error');
    } finally {
      setExportTemplatesLoading(false);
    }
  };

  const openExportTemplateDialog = async () => {
    if (!state.outlineData?.outline?.length) { showToast('请先生成目录', 'info'); return; }
    setExportTemplateDialogOpen(true);
    setExportTemplateSearch('');
    await loadExportTemplates();
  };

  const runExportWord = async (latestExportFormat: ExportFormatConfig) => {
    if (!state.outlineData?.outline?.length) { showToast('请先生成目录', 'info'); return; }
    const requestId = `export-business-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const mermaidCount = countOutlineMermaid(state.outlineData.outline);
    let unsubscribe: (() => void) | undefined;
    try {
      setExportProgress({ open: true, running: true, progress: 2, message: mermaidCount ? `检测到 ${mermaidCount} 张 Mermaid 图，导出时会转换为 Word 图片。` : '正在准备导出 Word。', warnings: [], mermaidCount });
      unsubscribe = window.yibiao?.export.onWordExportProgress((event: WordExportProgressEvent) => {
        if (event.requestId && event.requestId !== requestId) return;
        setExportProgress((prev) => ({ ...prev, open: true, running: event.phase === 'running', progress: event.progress, message: event.message, warnings: event.warnings || prev.warnings, error: event.phase === 'error' ? event.message : undefined }));
      });
      const result = await window.yibiao?.export.exportWord({ requestId, project_name: state.outlineData.project_name, outline: state.outlineData.outline, export_format: latestExportFormat });
      if (result?.canceled) { setExportProgress(initialExportProgress); showToast('已取消导出', 'info'); return; }
      setExportProgress((prev) => ({ ...prev, open: true, running: false, progress: 100, message: result?.message || 'Word 已导出，请打开文档核对图片、表格和版式。', warnings: result?.warnings || prev.warnings, filePath: result?.path }));
      showToast(result?.message || 'Word 已导出', result?.warnings?.length ? 'info' : 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出 Word 失败';
      setExportProgress((prev) => ({ ...prev, open: true, running: false, progress: 100, message, error: message }));
      showToast(message, 'error');
    } finally {
      unsubscribe?.();
    }
  };

  const confirmExportTemplate = async () => {
    if (!selectedExportTemplate) { showToast('请先选择导出模板', 'info'); return; }
    setExportTemplateDialogOpen(false);
    await runExportWord(selectedExportTemplate.config);
  };

  const handleOpenExportedFile = async () => {
    if (!exportProgress.filePath) return;
    try { await window.yibiao?.export.openFile(exportProgress.filePath); } catch (error) { showToast(error instanceof Error ? error.message : '打开文件失败', 'error'); }
  };

  const saveChapterContent = async (item: OutlineData['outline'][number], content: string) => {
    if (!state.outlineData?.outline?.length) throw new Error('当前没有可保存的目录');
    const updatedOutlineData = { ...state.outlineData, outline: updateOutlineItemContent(state.outlineData.outline, item.id, content) };
    const updatedSections = { ...state.contentGenerationSections, [item.id]: { id: item.id, title: item.title || '未命名章节', status: content.trim() ? 'success' as const : 'idle' as const, content, updated_at: new Date().toISOString() } };
    setState((prev) => ({ ...prev, outlineData: updatedOutlineData, contentGenerationSections: updatedSections }));
    const saved = await window.yibiao?.businessBid.saveChapterContent({ nodeId: item.id, content });
    if (saved) setState((prev) => ({ ...prev, ...saved }));
  };

  const saveOutlineConfig = async (config: {
    referenceKnowledgeDocumentIds: string[];
    outlineMode?: OutlineMode;
    referenceKnowledgeSnippetIds?: string[];
    referenceKnowledgeItemIds?: string[];
    outlineExpansionMode?: OutlineExpansionMode;
    wordControlOptions: OutlineWordControlOptions;
  }) => {
    const saved = await window.yibiao?.businessBid.saveOutlineConfig({
      referenceKnowledgeDocumentIds: config.referenceKnowledgeDocumentIds,
      referenceKnowledgeSnippetIds: config.referenceKnowledgeSnippetIds,
      referenceKnowledgeItemIds: config.referenceKnowledgeItemIds,
      outlineExpansionMode: config.outlineExpansionMode,
      wordControlOptions: config.wordControlOptions,
    });
    setState((prev) => ({ ...prev, ...(saved || {}) }));
  };

  const saveOutlineSelection = async (request: SaveOutlineSelectionRequest) => {
    await window.yibiao?.tasks.saveOutlineSelection({
      taskId: request.taskId,
      items: request.items,
      selectedIds: request.selectedIds,
    });
  };

  const saveOutline = async (request: SaveOutlineRequest) => {
    const saved = await window.yibiao?.businessBid.saveOutline(request);
    setState((prev) => ({ ...prev, ...(saved || {}), outlineData: saved?.outlineData || request.outlineData }));
  };

  const saveGlobalFacts = async (globalFacts: BusinessBidState['globalFacts']) => {
    setState((prev) => ({ ...prev, globalFacts }));
  };

  const saveClauseItems = async (clauseItems: BusinessBidState['clauseItems'] = []) => {
    setState((prev) => ({ ...prev, clauseItems: clauseItems || [] }));
  };

  const saveContentGenerationOptions = async (options: { minimumWords: number }) => {
    const saved = await window.yibiao?.businessBid.saveContentGenerationOptions(options);
    setState((prev) => ({ ...prev, ...(saved || {}), contentGenerationOptions: options }));
  };

  const saveBusinessBidState = async (nextState: BusinessBidState) => {
    setState((prev) => ({ ...prev, ...nextState }));
  };

  const navigationActions = state.step === 'content-edit' || state.step === 'expand'
    ? [
      { id: 'previous-step', label: '上一步', icon: <ToolbarArrowLeftIcon />, disabled: activeIndex <= 0, tooltip: activeIndex <= 0 ? '当前已经是第一步' : `返回${BUSINESS_BID_STEP_LABELS[BUSINESS_BID_STEPS[activeIndex - 1]]}`, onClick: () => { void goToOffset(-1); } },
      { id: 'export-word', label: isExporting ? '导出中...' : '导出 Word', icon: <ToolbarDocumentIcon />, variant: 'primary' as const, disabled: isContentGenerating || isExporting || !state.outlineData, tooltip: isContentGenerating ? '正文生成或暂停处理中，完成暂停后再导出' : isExporting ? 'Word 正在导出，请稍候' : generatedContentCount ? '导出当前商务标正文' : '可导出空目录文档，建议先生成正文', onClick: () => { void openExportTemplateDialog(); } },
    ]
    : [
      { id: 'previous-step', label: '上一步', icon: <ToolbarArrowLeftIcon />, disabled: activeIndex <= 0, tooltip: activeIndex <= 0 ? '当前已经是第一步' : `返回${BUSINESS_BID_STEP_LABELS[BUSINESS_BID_STEPS[activeIndex - 1]]}`, onClick: () => { void goToOffset(-1); } },
      { id: 'next-step', label: '下一步', icon: <ToolbarArrowRightIcon />, variant: 'primary' as const, disabled: isNextDisabled, tooltip: nextTooltip, onClick: () => { void goToOffset(1); } },
    ];

  const toolbarGroups = [
    { id: 'business-bid-reset', actions: [{ id: 'reset', label: '重置', variant: 'danger' as const, tooltip: '清空当前商务标流程', onClick: () => { void resetBusinessBid(); } }, { id: 'home', label: '首页', variant: state.step === 'document-analysis' ? 'primary' as const : 'secondary' as const, tooltip: '回到导入招标文件', onClick: () => { void switchStep('document-analysis'); } }] },
    { id: 'business-bid-navigation', actions: navigationActions },
  ];

  return (
    <div className="page-stack technical-workbench business-workbench">
      <nav className="business-step-bar" aria-label="商务标步骤">
        {BUSINESS_BID_STEPS.map((step, index) => (
          <button
            type="button"
            key={step}
            className={`business-step-item${step === state.step ? ' is-active' : ''}${index < activeIndex ? ' is-done' : ''}`}
            onClick={() => { void switchStep(step); }}
            disabled={isClauseTaskRunning || isOutlineTaskRunning || isFactsTaskRunning || isContentGenerating}
          >
            <span className="business-step-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="business-step-label">{BUSINESS_BID_STEP_LABELS[step]}</span>
          </button>
        ))}
      </nav>

      {state.step === 'document-analysis' && (
        <DocumentAnalysisPage
          tenderFile={state.tenderFile}
          tenderMarkdown={tenderMarkdown}
          referenceTechnicalPlan={state.referenceTechnicalPlan}
          referenceTechnicalPlanSummary={state.referenceTechnicalPlanSummary}
          referenceKnowledgeDocumentIds={state.referenceKnowledgeDocumentIds}
          referenceKnowledgeSnippetIds={state.referenceKnowledgeSnippetIds}
          hasTechnicalPlan={hasTechnicalPlan}
          onTenderImported={(nextState, markdown) => { setState((prev) => ({ ...prev, ...nextState })); setTenderMarkdown(markdown); }}
          onStateChange={(nextState) => { void saveBusinessBidState(nextState); }}
        />
      )}
      {state.step === 'bid-analysis' && (
        <BidAnalysisPage
          hasTenderFile={Boolean(state.tenderFile)}
          tasks={state.clauseAnalysisTasks}
          progress={state.clauseAnalysisProgress}
          task={state.clauseAnalysisTask}
          clauseItems={state.clauseItems || []}
          hasExplicitContentList={state.hasExplicitContentList}
          requiredBusinessContents={state.requiredBusinessContents}
          templateApplied={state.templateApplied}
          referenceKnowledgeDocumentIds={state.referenceKnowledgeDocumentIds}
          referenceKnowledgeSnippetIds={state.referenceKnowledgeSnippetIds}
          onStateChange={(nextState) => { void saveClauseItems(nextState.clauseItems); void saveBusinessBidState(nextState); }}
        />
      )}
      {state.step === 'outline-generation' && (
        <OutlineEditPage
          kind="business"
          workflowKind="technical-plan"
          projectOverview=""
          outlineData={state.outlineData}
          outlineWordControlOptions={state.outlineWordControlOptions}
          outlineWordControlSnapshot={state.outlineWordControlSnapshot}
          outlineExpansionMode={state.outlineExpansionMode}
          referenceKnowledgeDocumentIds={state.referenceKnowledgeDocumentIds}
          referenceKnowledgeSnippetIds={state.referenceKnowledgeSnippetIds}
          referenceKnowledgeItemIds={state.referenceKnowledgeItemIds || []}
          task={state.outlineGenerationTask}
          contentTaskStatus={state.contentGenerationTask?.status}
          hasClauseItems={Boolean(state.clauseItems?.length)}
          onOutlineConfigChange={saveOutlineConfig}
          onOutlineSaved={saveOutline}
          onOutlineSelectionSaved={saveOutlineSelection}
        />
      )}
      {state.step === 'global-facts' && (
        <GlobalFactsPage
          outlineData={state.outlineData}
          globalFacts={state.globalFacts}
          task={state.globalFactsTask}
          onStateChange={(nextState) => { void saveGlobalFacts(nextState.globalFacts); void saveBusinessBidState(nextState); }}
        />
      )}
      {state.step === 'content-edit' && (
        <ContentEditPage
          outlineData={state.outlineData}
          task={state.contentGenerationTask}
          contentGenerationOptions={state.contentGenerationOptions}
          sections={state.contentGenerationSections}
          onContentGenerationOptionsChange={saveContentGenerationOptions}
          onStateChange={(nextState) => { void saveBusinessBidState(nextState); }}
          onContentSaved={saveChapterContent}
        />
      )}
      {state.step === 'expand' && (
        <ExpandPage
          outlineData={state.outlineData}
          clauseItems={state.clauseItems || []}
          globalFacts={state.globalFacts}
          sections={state.contentGenerationSections}
          onExport={() => { void openExportTemplateDialog(); }}
        />
      )}

      <Dialog.Root open={exportTemplateDialogOpen} onOpenChange={(open) => !open && !isExporting && setExportTemplateDialogOpen(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="export-template-select-dialog">
            <div className="export-template-select-head">
              <div>
                <span className="section-kicker">Word 导出</span>
                <Dialog.Title>选择导出模板</Dialog.Title>
                <Dialog.Description>选择一个已保存模板后继续导出。模板样式应用范围保持现有导出逻辑。</Dialog.Description>
              </div>
              <Dialog.Close className="detail-help-close" type="button" aria-label="关闭模板选择" disabled={isExporting}>×</Dialog.Close>
            </div>
            <div className="export-template-select-body">
              <section className="export-template-select-list-panel" aria-label="模板列表">
                <input className="export-template-select-search" type="text" value={exportTemplateSearch} onChange={(event) => setExportTemplateSearch(event.target.value)} placeholder="搜索模板名称" />
                <div className="export-template-select-list">
                  {exportTemplatesLoading ? <div className="export-template-select-empty"><strong>正在读取模板</strong><span>请稍候...</span></div>
                    : !exportTemplatesLoading && filteredExportTemplates.length === 0 ? (
                      <div className="export-template-select-empty"><strong>{exportTemplates.length ? '没有匹配模板' : '暂无可用模板'}</strong><span>{exportTemplates.length ? '请换个关键词搜索，或新建一个模板。' : '请先新建并保存模板，保存后再返回导出。'}</span></div>
                    ) : filteredExportTemplates.map((template) => (
                      <button type="button" className={`export-template-select-row${selectedExportTemplate?.template_id === template.template_id ? ' is-active' : ''}`} key={template.template_id} onClick={() => setSelectedExportTemplateId(template.template_id)}>
                        <strong>{template.template_name}</strong>
                      </button>
                    ))}
                </div>
              </section>
            </div>
            <div className="content-regenerate-actions export-template-select-actions">
              <Dialog.Close className="secondary-action" type="button" disabled={isExporting}>取消</Dialog.Close>
              <button type="button" className="primary-action" onClick={() => { void confirmExportTemplate(); }} disabled={exportTemplatesLoading || !selectedExportTemplate || isExporting}>继续导出</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={exportProgress.open} onOpenChange={(open) => { if (!open && !exportProgress.running) setExportProgress(initialExportProgress); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="export-progress-card">
            <div className="content-regenerate-card-head">
              <span className="section-kicker">Word 导出</span>
              <Dialog.Title>{exportProgress.running ? '正在导出 Word' : exportProgress.error ? '导出失败' : '导出完成'}</Dialog.Title>
            </div>
            <div className="export-progress-body">
              <div className="content-generation-progress-track" aria-label={`Word 导出进度 ${exportProgress.progress}%`}><span style={{ width: `${exportProgress.progress}%` }} /></div>
              <p>{exportProgress.message || '正在处理导出任务，请稍候。'}</p>
            </div>
            {!exportProgress.running && (
              <div className="content-regenerate-actions">
                {!exportProgress.error && exportProgress.filePath && <button className="primary-action" type="button" onClick={() => { void handleOpenExportedFile(); }}>打开文件</button>}
                <Dialog.Close className={exportProgress.filePath && !exportProgress.error ? 'secondary-action' : 'primary-action'} type="button">知道了</Dialog.Close>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <FloatingToolbar groups={toolbarGroups} label="商务标工具条" />
    </div>
  );
}

function collectLeaf(items: OutlineData['outline']): OutlineData['outline'] {
  return items.flatMap((item) => (item.children?.length ? collectLeaf(item.children) : [item]));
}
