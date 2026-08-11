import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../../../shared/ui';
import type { BusinessBidClauseItem, BusinessBidClauseResponseStatus, BusinessBidClauseTasks, BusinessBidState, BackgroundTaskState } from '../types';
import { KnowledgeReferencePicker } from '../components/KnowledgeReferencePicker';

interface BidAnalysisPageProps {
  hasTenderFile: boolean;
  tasks: BusinessBidClauseTasks;
  progress: number;
  task?: BackgroundTaskState;
  clauseItems: BusinessBidClauseItem[];
  hasExplicitContentList?: boolean;
  requiredBusinessContents?: string[];
  templateApplied?: boolean;
  referenceKnowledgeDocumentIds: string[];
  referenceKnowledgeSnippetIds: string[];
  onStateChange: (state: BusinessBidState) => void;
}

const statusOptions: BusinessBidClauseResponseStatus[] = ['已响应', '待确认', '需复核', '不满足'];

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export default function BidAnalysisPage({ hasTenderFile, tasks, progress, task, clauseItems, hasExplicitContentList, requiredBusinessContents, templateApplied, referenceKnowledgeDocumentIds, referenceKnowledgeSnippetIds, onStateChange }: BidAnalysisPageProps) {
  const { showToast } = useToast();
  const [starting, setStarting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftItems, setDraftItems] = useState<BusinessBidClauseItem[]>(clauseItems);
  const [progressCollapsed, setProgressCollapsed] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [pdfExporting, setPdfExporting] = useState(false);
  // 模板补充提示相关状态
  const [showTemplatePrompt, setShowTemplatePrompt] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [templateDocIds, setTemplateDocIds] = useState<string[]>(referenceKnowledgeDocumentIds);
  const [templateSnippetIds, setTemplateSnippetIds] = useState<string[]>(referenceKnowledgeSnippetIds);
  const [regenerating, setRegenerating] = useState(false);
  const logListRef = useRef<HTMLDivElement | null>(null);

  // 同步 templateDocIds/templateSnippetIds 与 props（当用户在 DocumentAnalysisPage 更改选择后）
  useEffect(() => {
    setTemplateDocIds(referenceKnowledgeDocumentIds);
  }, [referenceKnowledgeDocumentIds]);
  useEffect(() => {
    setTemplateSnippetIds(referenceKnowledgeSnippetIds);
  }, [referenceKnowledgeSnippetIds]);

  // 同步 clauseItems（已由后端自动标红）到 draftItems
  useEffect(() => {
    setDraftItems(clauseItems);
  }, [clauseItems]);

  const running = starting || task?.status === 'running';
  const taskFailed = task?.status === 'error';
  const taskDone = task?.status === 'success' || clauseItems.length > 0;
  // 解析完成后，如果招标文件中没有明确的商务标内容清单且未使用模板，显示模板提示
  const showTemplateSuggestion = taskDone && hasExplicitContentList === false && !templateApplied && clauseItems.length > 0;
  const progressLogs = task?.logs || [];
  const latestLog = progressLogs[progressLogs.length - 1];
  const effectiveProgress = running ? Math.max(5, Math.min(99, progress || 5)) : taskFailed ? Math.max(0, Math.min(99, progress || 0)) : taskDone ? 100 : 0;

  const grouped = useMemo(() => {
    const map = new Map<string, BusinessBidClauseItem[]>();
    draftItems.forEach((item) => {
      const list = map.get(item.category) || [];
      list.push(item);
      map.set(item.category, list);
    });
    return Array.from(map.entries());
  }, [draftItems]);

  const statusCounts = useMemo(() => {
    const counts: Record<BusinessBidClauseResponseStatus, number> = { 已响应: 0, 待确认: 0, 需复核: 0, 不满足: 0 };
    draftItems.forEach((item) => { counts[item.response_status] += 1; });
    return counts;
  }, [draftItems]);

  useEffect(() => {
    if (running) {
      const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
      return () => window.clearInterval(timer);
    }
    return undefined;
  }, [running]);

  useEffect(() => {
    if (logListRef.current) {
      logListRef.current.scrollTop = logListRef.current.scrollHeight;
    }
  }, [progressLogs.length]);

  const startAnalysis = async () => {
    if (!hasTenderFile) {
      showToast('请先导入招标文件', 'info');
      return;
    }
    try {
      setStarting(true);
      await window.yibiao?.tasks.startBusinessClauseAnalysis({});
      showToast('商务条款解析任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动商务条款解析失败', 'error');
    } finally {
      setStarting(false);
    }
  };

  const updateItem = (id: string, patch: Partial<BusinessBidClauseItem>) => {
    setEditing(true);
    setDraftItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const saveItems = async () => {
    try {
      const state = await window.yibiao?.businessBid.saveClauseItems(draftItems);
      if (state) onStateChange(state);
      setEditing(false);
      showToast('商务响应矩阵已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存商务响应矩阵失败', 'error');
    }
  };

  const exportPdf = async () => {
    if (!draftItems.length) {
      showToast('暂无商务响应矩阵数据', 'info');
      return;
    }
    try {
      setPdfExporting(true);
      const result = await window.yibiao?.businessBid.exportPdf(draftItems);
      if (result?.canceled) {
        showToast('已取消导出', 'info');
        return;
      }
      if (result?.success) {
        showToast(result.message || 'PDF 已导出', 'success');
      } else {
        showToast(result?.message || '导出 PDF 失败', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '导出 PDF 失败', 'error');
    } finally {
      setPdfExporting(false);
    }
  };

  // ── 模板重生成 ───────────────────────────
  const startTemplateRegeneration = async () => {
    // 将知识库文档 ID 和片段 ID 一并传递到后端
    const templateItemIds = [
      ...templateDocIds,
      ...templateSnippetIds,
    ];
    if (!templateItemIds.length) {
      showToast('请先选择商务标模板', 'info');
      return;
    }
    try {
      setRegenerating(true);
      setTemplatePickerOpen(false);
      setShowTemplatePrompt(false);
      await window.yibiao?.tasks.startBusinessClauseRegeneration({ templateItemIds });
      showToast('已启动基于模板的商务矩阵重新生成', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动模板重生成失败', 'error');
    } finally {
      setRegenerating(false);
    }
  };

  const startedAt = task?.started_at ? Date.parse(task.started_at) : NaN;
  const updatedAt = task?.updated_at ? Date.parse(task.updated_at) : NaN;
  const elapsedText = running && Number.isFinite(startedAt) ? `已运行 ${formatDuration(nowTick - startedAt)}` : '';
  const staleText = running && Number.isFinite(updatedAt) ? `最近更新 ${Math.floor(Math.max(0, nowTick - updatedAt) / 1000)} 秒前` : '';

  return (
    <div className="plan-step-body bid-analysis-page">
      <section className="bid-analysis-command-bar">
        <div>
          <span className="section-kicker">STEP 02</span>
          <strong>商务条款解析</strong>
          <p>从招标文件中抽取付款、履约、质保、报价有效期、偏离等条款，形成可复核的商务响应矩阵。</p>
        </div>
        <div className="bid-analysis-stats">
          <span><strong>{draftItems.length}</strong> 项条款</span>
          <span className="is-ok">已响应 {statusCounts.已响应}</span>
          <span className="is-warn">待确认 {statusCounts.待确认}</span>
          <span className="is-danger">需复核 {statusCounts.需复核}</span>
        </div>
        <button type="button" className="primary-action" onClick={() => void startAnalysis()} disabled={running || !hasTenderFile}>
          {running ? '解析中...' : draftItems.length ? '重新解析' : '开始解析'}
        </button>
        <button type="button" className="secondary-action" onClick={() => void exportPdf()} disabled={pdfExporting || !draftItems.length}>
          {pdfExporting ? '导出中...' : '导出 PDF'}
        </button>
      </section>

      <section className="bid-analysis-workspace">
        <aside className="bid-analysis-progress-panel">
          <div className="analysis-result-head">
            <strong>解析过程</strong>
            <span>{running ? '运行中' : taskFailed ? '失败' : taskDone ? '已完成' : '未开始'}</span>
          </div>
          <div className={`content-outline-stats bid-analysis-progress${progressCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setProgressCollapsed((prev) => !prev)} aria-expanded={!progressCollapsed}>
              <span>解析进度</span>
              <strong>{effectiveProgress}%</strong>
              <em>{progressCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!progressCollapsed && (
              <div className="content-outline-stats-body">
                <div className={`content-generation-progress-track${running ? ' is-active' : ''}`} aria-label={`商务条款解析进度 ${effectiveProgress}%`}>
                  <span style={{ width: `${effectiveProgress}%` }} />
                </div>
                <p>{taskFailed ? task?.error || latestLog || '商务条款解析失败。' : latestLog || '点击“开始解析”后，后台会抽取商务条款并生成响应矩阵。'}</p>
                {(elapsedText || staleText) && (
                  <div className="outline-progress-meta">
                    {elapsedText && <span>{elapsedText}</span>}
                    {staleText && <span>{staleText}</span>}
                  </div>
                )}
                {taskFailed && <small>失败后不会自动重试，可点击“重新解析”。</small>}
              </div>
            )}
          </div>
          <div className="bid-analysis-log" ref={logListRef}>
            {progressLogs.length ? progressLogs.map((item, index) => (
              <p className={index === progressLogs.length - 1 ? 'is-latest' : ''} key={`${item}-${index}`}>{item}</p>
            )) : <p>等待解析任务启动。</p>}
          </div>
        </aside>

        <article className="bid-analysis-matrix">
          <div className="bid-analysis-matrix-head">
            <strong>商务响应矩阵草稿</strong>
            {draftItems.length > 0 && (
              <button type="button" className="primary-action" onClick={() => void saveItems()} disabled={!editing}>
                {editing ? '保存修改' : '已保存'}
              </button>
            )}
          </div>

          {/* 招标文件有明确清单时展示检测结果 */}
          {taskDone && hasExplicitContentList === true && requiredBusinessContents && requiredBusinessContents.length > 0 && (
            <div className="bid-analysis-explicit-list">
              <div className="bid-analysis-explicit-list-head">
                <strong>已识别招标文件中的商务标应包含内容清单</strong>
                <span>{requiredBusinessContents.length} 项</span>
              </div>
              <ol className="bid-analysis-explicit-list-items">
                {requiredBusinessContents.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ol>
            </div>
          )}

          {/* 招标文件无明确清单时的模板提示 */}
          {showTemplateSuggestion && (
            <div className="bid-analysis-template-suggestion">
              <div className="bid-analysis-template-suggestion-body">
                <strong>招标文件中未识别到明确的商务标应包含内容清单</strong>
                <p>当前矩阵基于 AI 通用判断生成。建议从知识库中选择商务标模板文件，用模板约束后重新生成更完整的矩阵。</p>
              </div>
              <div className="bid-analysis-template-suggestion-actions">
                <button type="button" className="primary-action" onClick={() => setTemplatePickerOpen(true)} disabled={regenerating}>
                  {regenerating ? '重生成中...' : '选择模板'}
                </button>
                <button type="button" className="secondary-action" onClick={() => setShowTemplatePrompt(false)}>知道了</button>
              </div>
            </div>
          )}

          {grouped.length ? (
            grouped.map(([category, items]) => (
              <section className="bid-analysis-group" key={category}>
                <div className="bid-analysis-group-head">
                  <strong>{category}</strong>
                  <span>{items.length} 项</span>
                </div>
                {items.map((item) => (
                  <article className={`bid-clause-card${item.isImportant ? ' is-important' : ''}`} key={item.id}>
                    <div className="bid-clause-card-head">
                      <button
                        type="button"
                        className={`bid-clause-star${item.isImportant ? ' is-starred' : ''}`}
                        onClick={() => updateItem(item.id, { isImportant: !item.isImportant })}
                        disabled={running}
                        title={item.isImportant ? '取消标记重要' : '标记为重要'}
                      >
                        {item.isImportant ? '★' : '☆'}
                      </button>
                      <strong>{item.title}</strong>
                      <select
                        className={`bid-clause-status is-${item.response_status}`}
                        value={item.response_status}
                        disabled={running}
                        onChange={(event) => updateItem(item.id, { response_status: event.target.value as BusinessBidClauseResponseStatus })}
                      >
                        {statusOptions.map((option) => <option value={option} key={option}>{option}</option>)}
                      </select>
                    </div>
                    <div className="bid-clause-field">
                      <span>招标要求</span>
                      <textarea value={item.requirement} disabled={running} onChange={(event) => updateItem(item.id, { requirement: event.target.value })} />
                    </div>
                    <div className="bid-clause-field">
                      <span>响应内容</span>
                      <textarea value={item.response_detail} disabled={running} onChange={(event) => updateItem(item.id, { response_detail: event.target.value })} />
                    </div>
                    <div className="bid-clause-field">
                      <span>偏离说明</span>
                      <textarea value={item.deviation} disabled={running} onChange={(event) => updateItem(item.id, { deviation: event.target.value })} />
                    </div>
                  </article>
                ))}
              </section>
            ))
          ) : (
            <div className="markdown-empty-state bid-analysis-empty">
              <strong>{running ? '正在生成响应矩阵' : '暂无商务响应矩阵'}</strong>
              <p>{hasTenderFile ? '点击“开始解析”后，AI 会基于招标文件生成可复核的响应矩阵。' : '请先完成招标文件导入。'}</p>
            </div>
          )}
        </article>
      </section>

      {/* 模板选择弹窗 */}
      {templatePickerOpen && (
        <div className="bid-analysis-template-dialog-backdrop" onClick={() => !regenerating && setTemplatePickerOpen(false)}>
          <div className="bid-analysis-template-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="bid-analysis-template-dialog-head">
              <strong>选择商务标模板</strong>
              <p>从知识库中选择包含商务标内容清单的文档或片段，系统将按模板约束重新生成响应矩阵。</p>
            </div>
            <div className="bid-analysis-template-dialog-body">
              <KnowledgeReferencePicker
                documentIds={templateDocIds}
                snippetIds={templateSnippetIds}
                onChange={(docIds, snippetIds) => {
                  setTemplateDocIds(docIds);
                  setTemplateSnippetIds(snippetIds);
                }}
              />
            </div>
            <div className="bid-analysis-template-dialog-actions">
              <button type="button" className="secondary-action" onClick={() => setTemplatePickerOpen(false)} disabled={regenerating}>取消</button>
              <button type="button" className="primary-action" onClick={() => void startTemplateRegeneration()} disabled={regenerating || (!templateDocIds.length && !templateSnippetIds.length)}>
                {regenerating ? '重生成中...' : '应用模板并重新生成'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
