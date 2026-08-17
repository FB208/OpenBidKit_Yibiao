import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import type { KnowledgeBaseIndex, KnowledgeDocument } from '../../knowledge-base/types';
import MarkdownEditor from '../../../shared/ui/MarkdownEditor';
import MarkdownRenderer from '../../../shared/ui/MarkdownRenderer';
import { useToast } from '../../../shared/ui';
import type { OutlineData, OutlineItem } from '../../../shared/types';
import { DEFAULT_EXPORT_FORMAT, type ExportTemplateRecord } from '../../../shared/types/exportFormat';
import type { TaskEvent } from '../../../shared/types/ipc';
import type {
  FeasibilityOutlineTemplate,
  FeasibilityProjectInfo,
  FeasibilityReportState,
  FeasibilityReportStep,
  FeasibilityTaskState,
} from '../types';

const steps: Array<{ id: FeasibilityReportStep; label: string; description: string }> = [
  { id: 'materials', label: '项目资料', description: '填写基础参数并上传项目资料' },
  { id: 'analysis', label: '资料分析', description: '分析事实与缺失稽查' },
  { id: 'outline', label: '报告目录', description: '选择模板、知识库并生成目录' },
  { id: 'parameters', label: '关键参数', description: '统一全文事实与编制口径' },
  { id: 'content', label: '正文与导出', description: '生成、编辑并导出报告' },
];

const emptyKnowledgeIndex: KnowledgeBaseIndex = { folders: [], documents: [] };

const initialState: FeasibilityReportState = {
  step: 'materials',
  projectInfo: {
    projectName: '',
    projectType: 'government',
    industry: '',
    constructionLocation: '',
    constructionScale: '',
    constructionPeriod: 2,
    operationPeriod: 20,
    totalInvestment: '',
    fundingSource: '',
    projectUnit: '',
  },
  sourceFiles: [],
  analysisMarkdown: '',
  outlineTemplate: 'government',
  targetWords: 30000,
  referenceKnowledgeDocumentIds: [],
  keyParametersMarkdown: '',
  outlineData: null,
};

function isTaskRunning(task?: FeasibilityTaskState) {
  return task?.status === 'running';
}

function collectLeafItems(items: OutlineItem[]): OutlineItem[] {
  return items.flatMap((item) => (item.children?.length ? collectLeafItems(item.children) : [item]));
}

function updateOutlineItem(items: OutlineItem[], nodeId: string, patch: Partial<OutlineItem>): OutlineItem[] {
  return items.map((item) => {
    if (item.id === nodeId) return { ...item, ...patch };
    if (!item.children?.length) return item;
    return { ...item, children: updateOutlineItem(item.children, nodeId, patch) };
  });
}

function deleteOutlineItem(items: OutlineItem[], nodeId: string): OutlineItem[] {
  return items.filter((item) => item.id !== nodeId).map((item) => (
    item.children?.length ? { ...item, children: deleteOutlineItem(item.children, nodeId) } : item
  ));
}

function makeLocalOutlineId() {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function countGeneratedSections(outlineData: OutlineData | null) {
  if (!outlineData?.outline?.length) return 0;
  return collectLeafItems(outlineData.outline).filter((item) => String(item.content || '').trim()).length;
}

function FeasibilityReportHome() {
  const { showToast } = useToast();
  const bridge = window.yibiao!;
  const [hydrated, setHydrated] = useState(false);
  const [state, setState] = useState<FeasibilityReportState>(initialState);
  const [knowledgeIndex, setKnowledgeIndex] = useState<KnowledgeBaseIndex>(emptyKnowledgeIndex);
  const [knowledgeSearch, setKnowledgeSearch] = useState('');
  const [sourcePreview, setSourcePreview] = useState('');
  const [sourcePreviewTitle, setSourcePreviewTitle] = useState('');
  const [loadingSourcePreview, setLoadingSourcePreview] = useState(false);
  const [selectedContentNodeId, setSelectedContentNodeId] = useState('');
  const [exportTemplates, setExportTemplates] = useState<ExportTemplateRecord[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportedPath, setExportedPath] = useState('');
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  const [exportCover, setExportCover] = useState(true);
  const [exportNotes, setExportNotes] = useState(true);
  const [exportAppendix, setExportAppendix] = useState(true);
  const [preparationUnit, setPreparationUnit] = useState('可行性研究报告编制中心');
  const [documentCode, setDocumentCode] = useState('');

  const activeStepIndex = steps.findIndex((step) => step.id === state.step);
  const leafItems = useMemo(() => collectLeafItems(state.outlineData?.outline || []), [state.outlineData]);
  const selectedContentNode = leafItems.find((item) => item.id === selectedContentNodeId) || leafItems[0];
  const generatedSections = countGeneratedSections(state.outlineData);
  const anyTaskRunning = [state.analysisTask, state.outlineTask, state.parametersTask, state.contentTask, state.humanWritingTask].some(isTaskRunning);

  const loadState = useCallback(async () => {
    const nextState = await bridge.feasibilityReport.loadState();
    setState(nextState);
    setHydrated(true);
    return nextState;
  }, []);

  useEffect(() => {
    void loadState().catch((error) => showToast(error instanceof Error ? error.message : '读取可研工作区失败', 'error'));
    const unsubscribe = bridge.tasks.onTaskEvent((event: TaskEvent) => {
      if (event.feasibilityReport) setState(event.feasibilityReport);
    });
    void bridge.tasks.getActiveTasks();
    return unsubscribe;
  }, [loadState, showToast]);

  useEffect(() => {
    if (!hydrated) return;
    trackPageView(`feasibility-report/${state.step}`);
  }, [hydrated, state.step]);

  useEffect(() => {
    if (!selectedContentNodeId && leafItems[0]) setSelectedContentNodeId(leafItems[0].id);
    if (selectedContentNodeId && !leafItems.some((item) => item.id === selectedContentNodeId)) {
      setSelectedContentNodeId(leafItems[0]?.id || '');
    }
  }, [leafItems, selectedContentNodeId]);

  useEffect(() => {
    if (state.step !== 'outline') return;
    void bridge.knowledgeBase.list().then(setKnowledgeIndex).catch((error) => {
      showToast(error instanceof Error ? error.message : '读取知识库失败', 'error');
    });
  }, [showToast, state.step]);

  useEffect(() => {
    if (state.step !== 'content') return;
    void bridge.templates.list().then((templates) => {
      setExportTemplates(templates);
      setSelectedTemplateId((current) => current || templates[0]?.template_id || '');
    }).catch((error) => showToast(error instanceof Error ? error.message : '读取导出模板失败', 'error'));
  }, [showToast, state.step]);

  const patchProjectInfo = <K extends keyof FeasibilityProjectInfo>(key: K, value: FeasibilityProjectInfo[K]) => {
    setState((current) => ({
      ...current,
      projectInfo: { ...current.projectInfo, [key]: value },
    }));
  };

  const saveProjectInfo = async (silent = false) => {
    if (!state.projectInfo.projectName.trim()) {
      showToast('请先填写项目名称', 'info');
      return false;
    }
    const saved = await bridge.feasibilityReport.saveProjectInfo(state.projectInfo);
    setState(saved);
    if (!silent) showToast('项目基础参数已保存', 'success');
    return true;
  };

  const importSources = async () => {
    try {
      const result = await bridge.feasibilityReport.importSourceDocuments();
      if (!result.success) {
        if (result.message !== '已取消选择') showToast(result.message || '项目资料导入失败', 'error');
        return;
      }
      setState(result.state);
      setSourcePreview(result.markdown || '');
      setSourcePreviewTitle('全部项目资料');
      showToast(result.message || '项目资料已导入', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '项目资料导入失败', 'error');
    }
  };

  const previewSource = async (sourceId?: string) => {
    try {
      setLoadingSourcePreview(true);
      const markdown = sourceId
        ? await bridge.feasibilityReport.readSourceMarkdown(sourceId)
        : await bridge.feasibilityReport.readCombinedSourceMarkdown();
      const source = state.sourceFiles.find((item) => item.id === sourceId);
      setSourcePreview(markdown);
      setSourcePreviewTitle(source?.fileName || '全部项目资料');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取项目资料失败', 'error');
    } finally {
      setLoadingSourcePreview(false);
    }
  };

  const startAnalysis = async () => {
    try {
      if (!(await saveProjectInfo(true))) return;
      if (!state.sourceFiles.length) {
        showToast('请先上传项目资料', 'info');
        return;
      }
      await bridge.tasks.startFeasibilityAnalysis({});
      await loadState();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动项目资料分析失败', 'error');
    }
  };

  const saveAnalysis = async () => {
    const saved = await bridge.feasibilityReport.saveAnalysis(state.analysisMarkdown);
    setState(saved);
    showToast('资料分析结果已保存，目录和后续正文需重新生成', 'success');
  };

  const toggleKnowledgeDocument = (document: KnowledgeDocument) => {
    if (document.status !== 'success' || isTaskRunning(state.outlineTask)) return;
    setState((current) => ({
      ...current,
      referenceKnowledgeDocumentIds: current.referenceKnowledgeDocumentIds.includes(document.id)
        ? current.referenceKnowledgeDocumentIds.filter((id) => id !== document.id)
        : [...current.referenceKnowledgeDocumentIds, document.id],
    }));
  };

  const startOutline = async () => {
    try {
      const payload = {
        outlineTemplate: state.outlineTemplate,
        targetWords: state.targetWords,
        referenceKnowledgeDocumentIds: state.referenceKnowledgeDocumentIds,
      };
      const saved = await bridge.feasibilityReport.saveOutlineConfig(payload);
      setState(saved);
      await bridge.tasks.startFeasibilityOutline(payload);
      await loadState();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动可研目录生成失败', 'error');
    }
  };

  const setOutlineItems = (items: OutlineItem[]) => {
    setState((current) => ({
      ...current,
      outlineData: {
        project_name: current.projectInfo.projectName,
        project_overview: current.outlineData?.project_overview || '',
        outline: items,
      },
    }));
  };

  const addOutlineChild = (nodeId: string) => {
    const items = state.outlineData?.outline || [];
    const addChild = (nodes: OutlineItem[]): OutlineItem[] => nodes.map((node) => {
      if (node.id === nodeId) {
        return {
          ...node,
          children: [...(node.children || []), { id: makeLocalOutlineId(), title: '新建章节', description: '' }],
        };
      }
      return node.children?.length ? { ...node, children: addChild(node.children) } : node;
    });
    setOutlineItems(addChild(items));
  };

  const saveOutline = async () => {
    if (!state.outlineData?.outline?.length) {
      showToast('目录不能为空', 'info');
      return;
    }
    const saved = await bridge.feasibilityReport.saveOutline(state.outlineData);
    setState(saved);
    showToast('目录已保存，关键参数和正文需重新生成', 'success');
  };

  const startParameters = async () => {
    try {
      await bridge.tasks.startFeasibilityParameters({});
      await loadState();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动关键参数生成失败', 'error');
    }
  };

  const saveKeyParameters = async () => {
    const saved = await bridge.feasibilityReport.saveKeyParameters(state.keyParametersMarkdown);
    setState(saved);
    showToast('关键参数已保存，已有正文已清空以避免口径冲突', 'success');
  };

  const startContent = async (onlyMissing = false) => {
    try {
      await bridge.tasks.startFeasibilityContent({ onlyMissing });
      await loadState();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动可研正文生成失败', 'error');
    }
  };

  const startHumanWriting = async () => {
    try {
      await bridge.tasks.startFeasibilityHumanWriting({});
      await loadState();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动自然化审校失败', 'error');
    }
  };

  const saveSelectedChapter = async () => {
    if (!selectedContentNode) return;
    const saved = await bridge.feasibilityReport.saveChapterContent({
      nodeId: selectedContentNode.id,
      content: selectedContentNode.content || '',
    });
    setState(saved);
    showToast('当前章节已保存', 'success');
  };

  const runExport = async () => {
    if (!state.outlineData?.outline?.length) {
      showToast('请先生成报告目录', 'info');
      return;
    }
    const selectedTemplate = exportTemplates.find((template) => template.template_id === selectedTemplateId);
    try {
      setExporting(true);
      setExportedPath('');
      const result = await bridge.export.exportWord({
        requestId: `feasibility-export-${Date.now()}`,
        project_name: state.projectInfo.projectName || '可行性研究报告',
        outline: state.outlineData.outline,
        export_format: selectedTemplate?.config || DEFAULT_EXPORT_FORMAT,
        is_feasibility: true,
        project_info: state.projectInfo,
        feasibility_options: {
          includeCover: exportCover,
          includePreparationNotes: exportNotes,
          includeAppendixTables: exportAppendix,
          preparationUnit: preparationUnit.trim() || '可行性研究报告编制中心',
          documentCode: documentCode.trim() || `KYBG-${Date.now().toString().slice(-6)}`,
          securityLevel: '内部资料 / 普通',
        },
      });
      if (result.canceled) return;
      setExportedPath(result.path || '');
      showToast(result.message || '可研报告 Word 已导出', result.warnings?.length ? 'info' : 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '导出 Word 失败', 'error');
    } finally {
      setExporting(false);
    }
  };

  const goToStep = async (nextStep: FeasibilityReportStep) => {
    if (anyTaskRunning) {
      showToast('当前有可研生成任务正在运行，请等待任务结束', 'info');
      return;
    }
    const saved = await bridge.feasibilityReport.updateStep(nextStep);
    setState(saved);
  };

  const goNext = async () => {
    if (state.step === 'materials') {
      if (!(await saveProjectInfo(true))) return;
      if (!state.sourceFiles.length) {
        showToast('请先上传项目资料', 'info');
        return;
      }
    }
    if (state.step === 'analysis' && !state.analysisMarkdown.trim()) {
      showToast('请先完成项目资料分析', 'info');
      return;
    }
    if (state.step === 'outline' && !state.outlineData?.outline?.length) {
      showToast('请先生成报告目录', 'info');
      return;
    }
    if (state.step === 'parameters' && !state.keyParametersMarkdown.trim()) {
      showToast('请先完成关键参数与编制口径', 'info');
      return;
    }
    const next = steps[activeStepIndex + 1];
    if (next) await goToStep(next.id);
  };

  const resetWorkspace = async () => {
    try {
      const result = await bridge.feasibilityReport.clear();
      setState(result.state);
      setSourcePreview('');
      setSourcePreviewTitle('');
      setExportedPath('');
      setResetDialogOpen(false);
      showToast(result.message || '可研工作区已清空', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '清空可研工作区失败', 'error');
    }
  };

  const renderTaskProgress = (task?: FeasibilityTaskState) => {
    if (!task) return null;
    return (
      <section className={`feasibility-task-card is-${task.status}`}>
        <div className="feasibility-task-head">
          <strong>{task.status === 'running' ? '正在执行' : task.status === 'success' ? '任务已完成' : '任务执行失败'}</strong>
          <span>{Math.round(task.progress || 0)}%</span>
        </div>
        <div className="feasibility-progress-track"><span style={{ width: `${Math.max(0, Math.min(100, task.progress || 0))}%` }} /></div>
        <p>{task.error || task.logs?.[task.logs.length - 1] || '正在准备任务...'}</p>
      </section>
    );
  };

  const renderMaterials = () => (
    <div className="feasibility-grid feasibility-materials-grid">
      <section className="feasibility-card">
        <div className="feasibility-card-head">
          <div><span className="section-kicker">STEP 01</span><h2>项目基础参数</h2></div>
          <button type="button" className="secondary-action" onClick={() => void saveProjectInfo()} disabled={anyTaskRunning}>保存参数</button>
        </div>
        <div className="feasibility-form-grid">
          <label className="full"><span>项目名称 *</span><input value={state.projectInfo.projectName} onChange={(event) => patchProjectInfo('projectName', event.target.value)} placeholder="请输入项目名称" /></label>
          <label><span>项目类型</span><select value={state.projectInfo.projectType} onChange={(event) => patchProjectInfo('projectType', event.target.value === 'enterprise' ? 'enterprise' : 'government')}><option value="government">政府投资项目</option><option value="enterprise">企业投资项目</option></select></label>
          <label><span>所属行业</span><input value={state.projectInfo.industry} onChange={(event) => patchProjectInfo('industry', event.target.value)} placeholder="如市政、能源、信息化" /></label>
          <label><span>建设单位</span><input value={state.projectInfo.projectUnit} onChange={(event) => patchProjectInfo('projectUnit', event.target.value)} placeholder="请输入建设单位" /></label>
          <label><span>建设地点</span><input value={state.projectInfo.constructionLocation} onChange={(event) => patchProjectInfo('constructionLocation', event.target.value)} placeholder="请输入建设地点" /></label>
          <label className="full"><span>建设内容与规模</span><textarea value={state.projectInfo.constructionScale} onChange={(event) => patchProjectInfo('constructionScale', event.target.value)} placeholder="概述拟建内容、服务对象和建设规模" /></label>
          <label><span>建设期（年）</span><input type="number" min="0" value={state.projectInfo.constructionPeriod} onChange={(event) => patchProjectInfo('constructionPeriod', Number(event.target.value) || 0)} /></label>
          <label><span>运营期（年）</span><input type="number" min="1" value={state.projectInfo.operationPeriod} onChange={(event) => patchProjectInfo('operationPeriod', Math.max(1, Number(event.target.value) || 1))} /></label>
          <label><span>项目总投资</span><input value={state.projectInfo.totalInvestment} onChange={(event) => patchProjectInfo('totalInvestment', event.target.value)} placeholder="如 5000 万元；未知可留空" /></label>
          <label><span>资金来源</span><input value={state.projectInfo.fundingSource} onChange={(event) => patchProjectInfo('fundingSource', event.target.value)} placeholder="如财政资金、企业自筹" /></label>
        </div>
        <div className="feasibility-phase-note">第一阶段只保存已知投资口径，不自动计算 NPV、IRR、回收期等复杂财务指标。</div>
      </section>
      <section className="feasibility-card">
        <div className="feasibility-card-head">
          <div><span className="section-kicker">项目资料</span><h2>上传并预览</h2></div>
          <button type="button" className="primary-action" onClick={() => void importSources()} disabled={anyTaskRunning}>选择资料</button>
        </div>
        <div className="feasibility-source-list">
          {state.sourceFiles.length ? state.sourceFiles.map((file) => (
            <button type="button" key={file.id} className="feasibility-source-item" onClick={() => void previewSource(file.id)}>
              <strong>{file.fileName}</strong><span>{file.markdownChars.toLocaleString()} 字 · {file.parserLabel || '已解析'}</span>
            </button>
          )) : <div className="feasibility-empty"><strong>尚未上传项目资料</strong><p>可选择 Word、PDF、Excel、Markdown 等当前解析方式支持的文件。</p></div>}
        </div>
        {state.sourceFiles.length > 1 && <button type="button" className="text-action" onClick={() => void previewSource()}>预览全部合并资料</button>}
        {(loadingSourcePreview || sourcePreview) && (
          <div className="feasibility-source-preview">
            <strong>{loadingSourcePreview ? '正在读取...' : sourcePreviewTitle}</strong>
            {!loadingSourcePreview && <div className="markdown-body"><MarkdownRenderer allowRawHtml={false}>{sourcePreview}</MarkdownRenderer></div>}
          </div>
        )}
      </section>
    </div>
  );

  const renderAnalysis = () => (
    <section className="feasibility-card feasibility-editor-card">
      <div className="feasibility-card-head">
        <div><span className="section-kicker">STEP 02</span><h2>项目资料分析</h2><p>提取可研编制所需事实，并明确缺失或矛盾信息。</p></div>
        <div className="feasibility-head-actions">
          <button type="button" className="secondary-action" onClick={() => void saveAnalysis()} disabled={anyTaskRunning || !state.analysisMarkdown.trim()}>保存修改</button>
          <button type="button" className="primary-action" onClick={() => void startAnalysis()} disabled={anyTaskRunning}>{state.analysisMarkdown ? '重新分析' : '开始分析'}</button>
        </div>
      </div>
      {renderTaskProgress(state.analysisTask)}
      <MarkdownEditor value={state.analysisMarkdown} onChange={(analysisMarkdown) => setState((current) => ({ ...current, analysisMarkdown }))} disabled={isTaskRunning(state.analysisTask)} placeholder="分析完成后将在这里显示项目概况、建设必要性、建设条件、投资资料和缺失项。" fullscreenTitle="项目资料分析" />
    </section>
  );

  const filteredKnowledgeDocuments = knowledgeIndex.documents.filter((document) => {
    if (document.status !== 'success') return false;
    const keyword = knowledgeSearch.trim().toLowerCase();
    return !keyword || document.file_name.toLowerCase().includes(keyword);
  });

  const renderOutlineNode = (item: OutlineItem, level = 1) => (
    <div className={`feasibility-outline-node level-${level}`} key={item.id}>
      <div className="feasibility-outline-node-row">
        <span className="feasibility-outline-level">L{level}</span>
        <input value={item.title} onChange={(event) => setOutlineItems(updateOutlineItem(state.outlineData?.outline || [], item.id, { title: event.target.value }))} />
        {level < 3 && <button type="button" onClick={() => addOutlineChild(item.id)}>添加子项</button>}
        <button type="button" className="danger-text" onClick={() => setOutlineItems(deleteOutlineItem(state.outlineData?.outline || [], item.id))}>删除</button>
      </div>
      <textarea value={item.description || ''} onChange={(event) => setOutlineItems(updateOutlineItem(state.outlineData?.outline || [], item.id, { description: event.target.value }))} placeholder="本节写作重点" />
      {Array.isArray(item.source_references) && item.source_references.length > 0 && (
        <div className="feasibility-source-tags">
          {item.source_references.map((s) => (
            <span key={s.id} className={`feasibility-source-tag ${s.type === 'knowledge_base' ? 'tag-kb' : s.type === 'key_parameter' ? 'tag-param' : ''}`}>
              🏷️ {s.name}
            </span>
          ))}
        </div>
      )}
      {item.children?.map((child) => renderOutlineNode(child, level + 1))}
    </div>
  );

  const renderOutline = () => (
    <div className="feasibility-grid feasibility-outline-grid">
      <section className="feasibility-card feasibility-outline-config">
        <div className="feasibility-card-head"><div><span className="section-kicker">STEP 03</span><h2>目录生成配置</h2></div></div>
        <label>
          <span>通用大纲</span>
          <select value={state.outlineTemplate} onChange={(event) => setState((current) => ({ ...current, outlineTemplate: event.target.value as FeasibilityOutlineTemplate }))} disabled={anyTaskRunning}>
            <option value="government">政府投资项目通用大纲（2023版标准）</option>
            <option value="enterprise">企业投资项目参考大纲（2023版标准）</option>
            <option value="industrial">工业与高端制造可行性研究大纲</option>
            <option value="hi_tech">高新技术与数字化/信息化大纲</option>
            <option value="infrastructure">基础设施与公用事业大纲</option>
            <option value="eco_environmental">农业与生态环保项目大纲</option>
            <option value="commercial_realestate">商业/园区与地产开发大纲</option>
          </select>
        </label>
        <label><span>目标总字数</span><input type="number" min="1000" step="1000" value={state.targetWords} onChange={(event) => setState((current) => ({ ...current, targetWords: Math.max(1000, Number(event.target.value) || 30000) }))} disabled={anyTaskRunning} /></label>
        <div className="feasibility-knowledge-picker">
          <div className="feasibility-subhead"><strong>参考知识库</strong><span>已选 {state.referenceKnowledgeDocumentIds.length} 个</span></div>
          <input value={knowledgeSearch} onChange={(event) => setKnowledgeSearch(event.target.value)} placeholder="搜索知识库文档" />
          <div className="feasibility-knowledge-list">
            {filteredKnowledgeDocuments.map((document) => (
              <label key={document.id} className={state.referenceKnowledgeDocumentIds.includes(document.id) ? 'is-selected' : ''}>
                <input type="checkbox" checked={state.referenceKnowledgeDocumentIds.includes(document.id)} onChange={() => toggleKnowledgeDocument(document)} disabled={anyTaskRunning} />
                <span><strong>{document.file_name}</strong><small>{document.item_count || 0} 条知识</small></span>
              </label>
            ))}
            {!filteredKnowledgeDocuments.length && <div className="feasibility-empty compact">没有可用的知识库文档</div>}
          </div>
        </div>
        <button type="button" className="primary-action wide" onClick={() => void startOutline()} disabled={anyTaskRunning}>{state.outlineData ? '重新生成目录' : '生成报告目录'}</button>
        {renderTaskProgress(state.outlineTask)}
      </section>
      <section className="feasibility-card feasibility-outline-editor">
        <div className="feasibility-card-head">
          <div><h2>可研报告目录</h2><p>最多三级；保存目录会清空旧关键参数和正文。</p></div>
          <div className="feasibility-head-actions"><button type="button" className="secondary-action" onClick={() => setOutlineItems([...(state.outlineData?.outline || []), { id: makeLocalOutlineId(), title: '新建一级章节', description: '' }])} disabled={anyTaskRunning}>添加一级章节</button><button type="button" className="primary-action" onClick={() => void saveOutline()} disabled={anyTaskRunning || !state.outlineData?.outline?.length}>保存目录</button></div>
        </div>
        <div className="feasibility-outline-tree">{state.outlineData?.outline?.length ? state.outlineData.outline.map((item) => renderOutlineNode(item)) : <div className="feasibility-empty"><strong>尚未生成目录</strong><p>选择通用大纲、目标字数和知识库后开始生成。</p></div>}</div>
      </section>
    </div>
  );

  const renderParameters = () => (
    <section className="feasibility-card feasibility-editor-card">
      <div className="feasibility-card-head">
        <div><span className="section-kicker">STEP 04</span><h2>关键参数与编制口径</h2><p>全文涉及的地点、规模、投资、工期和技术路线统一从这里读取。</p></div>
        <div className="feasibility-head-actions"><button type="button" className="secondary-action" onClick={() => void saveKeyParameters()} disabled={anyTaskRunning || !state.keyParametersMarkdown.trim()}>保存修改</button><button type="button" className="primary-action" onClick={() => void startParameters()} disabled={anyTaskRunning}>{state.keyParametersMarkdown ? '重新生成' : '生成关键参数'}</button></div>
      </div>
      {renderTaskProgress(state.parametersTask)}
      <div className="feasibility-warning">请重点核对“【待补充】”和“【待确认】”。保存修改后，旧正文会被清空以避免使用过期参数。</div>
      <MarkdownEditor value={state.keyParametersMarkdown} onChange={(keyParametersMarkdown) => setState((current) => ({ ...current, keyParametersMarkdown }))} disabled={isTaskRunning(state.parametersTask)} placeholder="生成后将在这里显示关键参数和统一编制口径。" fullscreenTitle="关键参数与编制口径" />
    </section>
  );

  const renderContent = () => (
    <div className="feasibility-content-layout">
      <aside className="feasibility-card feasibility-content-sidebar">
        <div className="feasibility-card-head"><div><span className="section-kicker">STEP 05</span><h2>报告章节</h2></div></div>
        <div className="feasibility-content-summary"><strong>{generatedSections}/{leafItems.length}</strong><span>已生成小节</span></div>
        {generatedSections > 0 && generatedSections < leafItems.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '8px' }}>
            <button type="button" className="primary-action wide" onClick={() => void startContent(true)} disabled={anyTaskRunning}>
              ⚡ 补充生成未完成章节 ({leafItems.length - generatedSections} 节)
            </button>
            <button type="button" className="secondary-action wide" onClick={() => void startContent(false)} disabled={anyTaskRunning}>
              ↺ 重新生成全篇正文
            </button>
          </div>
        ) : (
          <button type="button" className="primary-action wide" onClick={() => void startContent(false)} disabled={anyTaskRunning || !leafItems.length}>
            {generatedSections === leafItems.length ? '↺ 重新生成全篇正文' : '⚡ 生成全篇正文'}
          </button>
        )}
        {renderTaskProgress(state.contentTask)}
        <div className="feasibility-agent-card">
          <div><strong>自然化审校 Agent</strong><span>可选</span></div>
          <p>保护事实和参数，压缩重复表达，改善中文词序，清理模板腔与模型腔，同时保持正式可研文风。</p>
          <div className="feasibility-agent-skills"><span>事实保护</span><span>段落推进</span><span>自然中文</span><span>模型腔清理</span></div>
          <button type="button" className="secondary-action wide" onClick={() => void startHumanWriting()} disabled={anyTaskRunning || !generatedSections}>{state.humanWritingTask?.status === 'success' ? '重新自然化审校' : '自然化审校全文'}</button>
        </div>
        {renderTaskProgress(state.humanWritingTask)}
        <div className="feasibility-chapter-list">
          {leafItems.map((item) => <button type="button" key={item.id} className={selectedContentNode?.id === item.id ? 'is-active' : ''} onClick={() => setSelectedContentNodeId(item.id)}><span>{item.title}</span><small>{String(item.content || '').trim() ? '已生成' : '待生成'}</small></button>)}
        </div>
      </aside>
      <section className="feasibility-card feasibility-content-editor">
        <div className="feasibility-card-head">
          <div><h2>{selectedContentNode?.title || '选择报告章节'}</h2><p>{selectedContentNode?.description || '生成后可逐章编辑并保存。'}</p></div>
          <button type="button" className="secondary-action" onClick={() => void saveSelectedChapter()} disabled={anyTaskRunning || !selectedContentNode}>保存当前章节</button>
        </div>
        {selectedContentNode ? <MarkdownEditor value={selectedContentNode.content || ''} onChange={(content) => setOutlineItems(updateOutlineItem(state.outlineData?.outline || [], selectedContentNode.id, { content }))} disabled={isTaskRunning(state.contentTask) || isTaskRunning(state.humanWritingTask)} placeholder="尚未生成本章节正文。" fullscreenTitle={selectedContentNode.title} /> : <div className="feasibility-empty">目录中没有可编辑的叶子章节</div>}
        <div className="feasibility-export-bar" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div className="feasibility-export-options-grid">
            <label><input type="checkbox" checked={exportCover} onChange={(e) => setExportCover(e.target.checked)} />包含可研专用 Word 封面</label>
            <label><input type="checkbox" checked={exportNotes} onChange={(e) => setExportNotes(e.target.checked)} />包含编制说明与责任表</label>
            <label><input type="checkbox" checked={exportAppendix} onChange={(e) => setExportAppendix(e.target.checked)} />自动生成标准附表汇总</label>
          </div>
          <div style={{ display: 'flex', gap: '9px', justifyContent: 'flex-end', alignItems: 'center', marginTop: '8px' }}>
            <label style={{ minWidth: '180px' }}><span>编制单位</span><input value={preparationUnit} onChange={(e) => setPreparationUnit(e.target.value)} placeholder="编制单位全称" /></label>
            <label style={{ minWidth: '140px' }}><span>Word 模板</span><select value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}><option value="">默认模板</option>{exportTemplates.map((template) => <option key={template.template_id} value={template.template_id}>{template.template_name}</option>)}</select></label>
            <button type="button" className="primary-action" onClick={() => void runExport()} disabled={exporting || anyTaskRunning || !state.outlineData}>{exporting ? '导出中...' : '导出 Word'}</button>
            {exportedPath && <button type="button" className="secondary-action" onClick={() => void bridge.export.openFile(exportedPath)}>打开文件</button>}
          </div>
        </div>
      </section>
    </div>
  );

  if (!hydrated) return <div className="feasibility-loading">正在读取可研工作区...</div>;

  return (
    <div className="feasibility-report-page">
      <header className="feasibility-page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="section-kicker">报告生成</span>
            <span style={{
              fontSize: '11px',
              fontWeight: 700,
              padding: '2px 7px',
              borderRadius: '12px',
              background: '#2f6fed',
              color: '#ffffff',
              lineHeight: '1.2',
              letterSpacing: '0.5px',
            }}>Beta</span>
          </div>
          <h1>可行性研究报告</h1>
          <p>{state.projectInfo.projectName || '先填写项目参数并上传项目资料，逐步生成完整报告。'}</p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button type="button" className="danger-action" onClick={() => setResetDialogOpen(true)} disabled={anyTaskRunning}>重置可研</button>
        </div>
      </header>
      <nav className="feasibility-stepper" aria-label="可研报告生成步骤">
        {steps.map((step, index) => <button type="button" key={step.id} className={state.step === step.id ? 'is-active' : index < activeStepIndex ? 'is-complete' : ''} onClick={() => void goToStep(step.id)}><span>{index + 1}</span><div><strong>{step.label}</strong><small>{step.description}</small></div></button>)}
      </nav>
      <main className="feasibility-workspace">
        {state.step === 'materials' && renderMaterials()}
        {state.step === 'analysis' && renderAnalysis()}
        {state.step === 'outline' && renderOutline()}
        {state.step === 'parameters' && renderParameters()}
        {state.step === 'content' && renderContent()}
      </main>
      <footer className="feasibility-navigation">
        <button type="button" className="secondary-action" disabled={activeStepIndex <= 0 || anyTaskRunning} onClick={() => void goToStep(steps[activeStepIndex - 1].id)}>上一步</button>
        <span>第 {activeStepIndex + 1} 步，共 {steps.length} 步</span>
        <button type="button" className="primary-action" disabled={activeStepIndex >= steps.length - 1 || anyTaskRunning} onClick={() => void goNext()}>下一步</button>
      </footer>

      <Dialog.Root open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card feasibility-reset-dialog">
            <div className="content-regenerate-card-head"><Dialog.Title>确认重置可研工作区</Dialog.Title><Dialog.Description>这会删除已上传项目资料、分析结果、目录、关键参数和全部正文，不影响标书与知识库。</Dialog.Description></div>
            <div className="content-regenerate-actions"><Dialog.Close asChild><button type="button" className="secondary-action">取消</button></Dialog.Close><button type="button" className="danger-action" onClick={() => void resetWorkspace()}>确认重置</button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export default FeasibilityReportHome;
