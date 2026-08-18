import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ProgressBar, useToast } from '../../../shared/ui';
import type { KnowledgeBaseIndex } from '../../knowledge-base/types';
import type { OutlineData, OutlineItem } from '../../../shared/types';
import { formatOutlineTitle } from '../../../shared/utils/outlineNumbering';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import type { FeasibilityBackgroundTaskState, FeasibilityOutlineTemplate, FeasibilitySaveOutlineRequest } from '../types';
import { FEASIBILITY_OUTLINE_TEMPLATE_LABELS } from '../types';

interface OutlinePageProps {
  outlineTemplate: FeasibilityOutlineTemplate;
  targetWords: number;
  referenceDocumentIds: string[];
  outlineData: OutlineData | null;
  task?: FeasibilityBackgroundTaskState;
  running: boolean;
  locked: boolean;
  hasAnalysis: boolean;
  onConfigChange: (config: { outlineTemplate: FeasibilityOutlineTemplate; targetWords: number; referenceDocumentIds: string[] }) => Promise<void>;
  onOutlineSaved: (request: FeasibilitySaveOutlineRequest) => Promise<void>;
  onStart: (config: { outlineTemplate: FeasibilityOutlineTemplate; targetWords: number; referenceDocumentIds: string[] }) => Promise<void>;
}

const emptyKnowledgeIndex: KnowledgeBaseIndex = { folders: [], documents: [] };
const templateIds = Object.keys(FEASIBILITY_OUTLINE_TEMPLATE_LABELS) as FeasibilityOutlineTemplate[];

function collectIds(items: OutlineItem[], ids: string[] = []) {
  items.forEach((item) => {
    ids.push(item.id);
    if (item.children?.length) collectIds(item.children, ids);
  });
  return ids;
}

function findItem(items: OutlineItem[], id: string): OutlineItem | null {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.children?.length) {
      const found = findItem(item.children, id);
      if (found) return found;
    }
  }
  return null;
}

function mapItems(items: OutlineItem[], mapper: (item: OutlineItem) => OutlineItem): OutlineItem[] {
  return items.map((item) => {
    const withMappedChildren = item.children?.length
      ? { ...item, children: mapItems(item.children, mapper) }
      : item;
    return mapper(withMappedChildren);
  });
}

function removeItem(items: OutlineItem[], id: string): OutlineItem[] {
  return items.filter((item) => item.id !== id).map((item) => (
    item.children?.length ? { ...item, children: removeItem(item.children, id) } : item
  ));
}

function renumberWithMap(items: OutlineItem[], prefix = ''): { outline: OutlineItem[]; idMap: Record<string, string> } {
  const idMap: Record<string, string> = {};
  const outline = items.map((item, index) => {
    const id = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
    const child = item.children?.length ? renumberWithMap(item.children, id) : null;
    idMap[item.id] = id;
    if (child) Object.assign(idMap, child.idMap);
    return {
      ...item,
      id,
      children: child?.outline,
    };
  });
  return { outline, idMap };
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function OutlinePage({
  outlineTemplate,
  targetWords,
  referenceDocumentIds,
  outlineData,
  task,
  running,
  locked,
  hasAnalysis,
  onConfigChange,
  onOutlineSaved,
  onStart,
}: OutlinePageProps) {
  const { showToast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draftTemplate, setDraftTemplate] = useState(outlineTemplate);
  const [draftWords, setDraftWords] = useState(String(targetWords));
  const [draftKnowledgeIds, setDraftKnowledgeIds] = useState(referenceDocumentIds);
  const [knowledgeIndex, setKnowledgeIndex] = useState(emptyKnowledgeIndex);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [progressCollapsed, setProgressCollapsed] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const logListRef = useRef<HTMLDivElement | null>(null);

  const selectedItem = useMemo(
    () => (outlineData?.outline?.length && selectedItemId ? findItem(outlineData.outline, selectedItemId) : null),
    [outlineData, selectedItemId],
  );
  const progressLogs = task?.logs || [];
  const latestLog = progressLogs[progressLogs.length - 1] || '';
  const failed = task?.status === 'error';
  const mutationLocked = running || locked;
  const adjusting = task?.type === 'feasibility-outline-adjustment';
  const progress = running
    ? Math.max(5, Math.min(99, Number(task?.progress || 0) || 5))
    : failed
      ? Math.max(0, Math.min(99, Number(task?.progress || 0) || 0))
      : outlineData || task?.status === 'success'
        ? 100
        : 0;
  const statusMessage = failed ? task?.error || latestLog || (adjusting ? '目录调整失败' : '目录生成失败') : latestLog || '等待生成任务启动。';
  const startedAt = task?.started_at ? Date.parse(task.started_at) : NaN;
  const updatedAt = task?.updated_at ? Date.parse(task.updated_at) : NaN;
  const elapsedText = running && Number.isFinite(startedAt) ? `已运行 ${formatDuration(nowTick - startedAt)}` : '';
  const staleText = running && Number.isFinite(updatedAt) ? `最近更新 ${Math.floor(Math.max(0, nowTick - updatedAt) / 1000)} 秒前` : '';

  useEffect(() => {
    window.yibiao?.knowledgeBase.list().then(setKnowledgeIndex).catch(() => setKnowledgeIndex(emptyKnowledgeIndex));
  }, []);

  useEffect(() => {
    const ids = outlineData?.outline ? collectIds(outlineData.outline) : [];
    setExpandedItems(new Set(ids));
    if (!selectedItemId && ids[0]) setSelectedItemId(ids[0]);
  }, [outlineData, selectedItemId]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (logListRef.current) {
      logListRef.current.scrollTop = logListRef.current.scrollHeight;
    }
  }, [progressLogs.length]);

  const openDialog = () => {
    setDraftTemplate(outlineTemplate);
    setDraftWords(String(targetWords));
    setDraftKnowledgeIds(referenceDocumentIds);
    setDialogOpen(true);
  };

  const saveConfigAndStart = async () => {
    const words = Math.round(Number(draftWords) || 0);
    if (words < 1000) {
      showToast('目标总字数不能低于 1000', 'info');
      return;
    }
    const config = {
      outlineTemplate: draftTemplate,
      targetWords: words,
      referenceDocumentIds: draftKnowledgeIds,
    };
    await onConfigChange(config);
    setDialogOpen(false);
    await onStart(config);
  };

  const persist = async (outline: OutlineItem[], reason: FeasibilitySaveOutlineRequest['reason'], affectedNodeIds?: string[]) => {
    const numbered = renumberWithMap(outline);
    await onOutlineSaved({
      outlineData: { ...(outlineData || { outline: [] }), outline: numbered.outline },
      reason,
      idMap: numbered.idMap,
      affectedNodeIds: affectedNodeIds?.map((id) => numbered.idMap[id] || id),
    });
    setSelectedItemId((prev) => (prev ? numbered.idMap[prev] || prev : prev));
    setExpandedItems((prev) => new Set([...prev].map((id) => numbered.idMap[id] || id)));
  };

  const saveEditing = async () => {
    if (!outlineData?.outline || !selectedItem) return;
    const title = editTitle.trim();
    if (!title) {
      showToast('请填写目录标题', 'info');
      return;
    }
    await persist(mapItems(outlineData.outline, (item) => (
      item.id === selectedItem.id ? { ...item, title, description: editDescription.trim() } : item
    )), 'edit', [selectedItem.id]);
    setEditing(false);
    showToast('目录项已保存', 'success');
  };

  const addRoot = async () => {
    const outline = [...(outlineData?.outline || []), { id: 'temp', title: '新章节', description: '' }];
    await persist(outline, 'add-root', ['temp']);
  };

  const addChild = async (parentId: string) => {
    if (!outlineData?.outline) return;
    if ((parentId.split('.').length) >= 3) {
      showToast('最多支持三级目录', 'info');
      return;
    }
    await persist(mapItems(outlineData.outline, (item) => (
      item.id === parentId
        ? { ...item, children: [...(item.children || []), { id: `${parentId}.temp`, title: '新小节', description: '' }] }
        : item
    )), 'add-child', [parentId, `${parentId}.temp`]);
  };

  const deleteItem = async (id: string) => {
    if (!outlineData?.outline) return;
    await persist(removeItem(outlineData.outline, id), 'delete');
    setSelectedItemId('');
  };

  const renderItem = (item: OutlineItem, level = 0) => {
    const hasChildren = Boolean(item.children?.length);
    const expanded = expandedItems.has(item.id);
    return (
      <div className="outline-tree-node" key={item.id} style={{ '--outline-level': level } as CSSProperties}>
        <div className={`outline-tree-item${selectedItemId === item.id ? ' is-active' : ''}`}>
          <button
            type="button"
            className={`outline-tree-toggle${hasChildren ? '' : ' is-leaf'}${expanded ? ' is-expanded' : ''}`}
            onClick={() => hasChildren && setExpandedItems((prev) => {
              const next = new Set(prev);
              if (next.has(item.id)) next.delete(item.id);
              else next.add(item.id);
              return next;
            })}
            disabled={!hasChildren}
          >
            {hasChildren ? '›' : '•'}
          </button>
          <button type="button" className="outline-tree-content" onClick={() => { setSelectedItemId(item.id); setEditing(false); }}>
            <strong>{formatOutlineTitle(item.id, item.title, DEFAULT_EXPORT_FORMAT.headings[Math.min(item.id.split('.').length - 1, 5)])}</strong>
          </button>
        </div>
        {hasChildren && expanded && item.children?.map((child) => renderItem(child, level + 1))}
      </div>
    );
  };

  return (
    <div className="plan-step-body outline-generation-page">
      <section className="outline-command-bar">
        <div>
          <span className="section-kicker">STEP 04</span>
          <strong>报告目录</strong>
          <p>当前模板：{FEASIBILITY_OUTLINE_TEMPLATE_LABELS[outlineTemplate]}；目标约 {targetWords.toLocaleString('zh-CN')} 字；知识库 {referenceDocumentIds.length ? `已选 ${referenceDocumentIds.length} 个文档` : '未选择'}。</p>
        </div>
        <div className="outline-command-actions">
          <button type="button" className="outline-config-action" onClick={openDialog} disabled={running || mutationLocked || !hasAnalysis} aria-label="打开目录生成配置" title="目录生成配置">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 0 1-4 0v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 0 1 0-4h.08A1.7 1.7 0 0 0 4.6 8.93a1.7 1.7 0 0 0-.34-1.87l-.05-.05a2 2 0 0 1 2.83-2.83l.05.05a1.7 1.7 0 0 0 1.87.34A1.7 1.7 0 0 0 10 3.01V3a2 2 0 0 1 4 0v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 0 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
            </svg>
          </button>
          <button type="button" className="primary-action" onClick={openDialog} disabled={running || mutationLocked || !hasAnalysis}>
            {running
              ? (adjusting ? 'AI 正在调整目录' : 'AI 正在生成目录')
              : outlineData ? '重新生成目录' : '生成报告目录'}
          </button>
        </div>
      </section>

      <section className="outline-generation-workspace">
        <aside className="outline-progress-panel">
          <div className="analysis-result-head">
            <strong>{adjusting ? '调整过程' : '生成过程'}</strong>
            <span>{running ? '进行中' : failed ? '失败' : outlineData ? '已完成' : '等待开始'}</span>
          </div>
          <div className={`content-outline-stats outline-progress-summary${progressCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setProgressCollapsed((prev) => !prev)} aria-expanded={!progressCollapsed}>
              <span>{adjusting ? '调整进度' : '生成进度'}</span>
              <strong>{progress}%</strong>
              <em>{progressCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!progressCollapsed && (
              <div className="content-outline-stats-body">
                <ProgressBar value={progress} label={`${adjusting ? '目录调整' : '目录生成'}进度 ${progress}%`} />
                <p>{statusMessage}</p>
                {(elapsedText || staleText) && (
                  <div className="outline-progress-meta">
                    {elapsedText && <span>{elapsedText}</span>}
                    {staleText && <span>{staleText}</span>}
                  </div>
                )}
                {failed && <small>{task?.error || latestLog || (adjusting ? '目录调整失败' : '目录生成失败')}</small>}
              </div>
            )}
          </div>
          <div className="outline-progress-log" ref={logListRef}>
            {progressLogs.length ? progressLogs.map((item, index) => (
              <p className={index === progressLogs.length - 1 ? 'is-latest' : ''} key={`${item}-${index}`}>{item}</p>
            )) : <p>等待生成任务启动。</p>}
          </div>
        </aside>

        <section className="outline-tree-panel">
          <div className="analysis-result-head outline-tree-head">
            <div>
              <strong>目录结构</strong>
              <span>{outlineData?.outline?.length || 0} 个一级目录</span>
            </div>
            <div className="outline-tree-tools">
              <button type="button" onClick={() => { void addRoot(); }} disabled={mutationLocked || !outlineData}>新增一级</button>
            </div>
          </div>
          {outlineData?.outline?.length ? (
            <div className="outline-tree-list">
              {outlineData.outline.map((item) => renderItem(item))}
            </div>
          ) : (
            <div className="markdown-empty-state outline-empty-state">
              <strong>尚未生成目录</strong>
              <p>{hasAnalysis ? '选择大纲模板并生成三级以内报告目录。' : '请先完成资料分析。'}</p>
            </div>
          )}
        </section>

        <aside className="outline-detail-panel">
          <div className="analysis-result-head">
            <div>
              <strong>目录项详情</strong>
              <span>{selectedItem ? selectedItem.id : '未选择'}</span>
            </div>
          </div>
          {selectedItem ? (
            <div className="outline-detail-body">
              {editing ? (
                <>
                  <label>
                    <span>标题</span>
                    <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} disabled={mutationLocked} />
                  </label>
                  <label>
                    <span>写作重点</span>
                    <textarea value={editDescription} onChange={(event) => setEditDescription(event.target.value)} disabled={mutationLocked} />
                  </label>
                  <div className="outline-detail-actions">
                    <button type="button" className="primary-action" onClick={() => { void saveEditing(); }} disabled={mutationLocked}>保存</button>
                    <button type="button" className="secondary-action" onClick={() => setEditing(false)}>取消</button>
                  </div>
                </>
              ) : (
                <>
                  <h3>{selectedItem.title}</h3>
                  <p>{selectedItem.description || '无写作重点'}</p>
                  <div className="outline-detail-actions">
                    <button type="button" className="primary-action" onClick={() => { setEditTitle(selectedItem.title); setEditDescription(selectedItem.description || ''); setEditing(true); }} disabled={mutationLocked}>编辑</button>
                    <button type="button" className="secondary-action" onClick={() => { void addChild(selectedItem.id); }} disabled={mutationLocked}>添加子项</button>
                    <button type="button" className="danger-action" onClick={() => { void deleteItem(selectedItem.id); }} disabled={mutationLocked}>删除</button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="markdown-empty-state outline-empty-state">
              <strong>选择一个目录项</strong>
              <p>在左侧目录树中选择章节后，可查看并编辑标题和写作重点。</p>
            </div>
          )}
        </aside>
      </section>

      <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="outline-generation-config-card">
            <Dialog.Title className="sr-only">生成报告目录</Dialog.Title>
            <Dialog.Description className="sr-only">选择大纲模板、目标字数和可选知识库文档。</Dialog.Description>
            <div className="outline-generation-config-body">
              <div className="outline-generation-config-left">
                <section className="outline-generation-config-section">
                  <div className="outline-generation-config-head">
                    <strong>目录生成配置</strong>
                    <span>最多三级目录</span>
                  </div>
                  <div className="outline-word-control-grid">
                    <label>
                      <span>大纲模板</span>
                      <select value={draftTemplate} onChange={(event) => setDraftTemplate(event.target.value as FeasibilityOutlineTemplate)}>
                        {templateIds.map((id) => <option value={id} key={id}>{FEASIBILITY_OUTLINE_TEMPLATE_LABELS[id]}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>目标总字数</span>
                      <input value={draftWords} onChange={(event) => setDraftWords(event.target.value)} />
                    </label>
                  </div>
                  <small className="outline-word-control-help">目标总字数不能低于 1000。保存目录会清空关键参数和受影响章节正文。</small>
                </section>
              </div>
              <section className="outline-generation-config-section outline-knowledge-picker">
                <div className="outline-generation-config-head">
                  <strong>参考知识库</strong>
                  <span>已选择 {draftKnowledgeIds.length} 个文档</span>
                </div>
                <div className="outline-knowledge-document-list">
                  {knowledgeIndex.documents.filter((doc) => doc.status === 'success').map((doc) => {
                    const selected = draftKnowledgeIds.includes(doc.id);
                    return (
                      <label key={doc.id} className={`outline-knowledge-document${selected ? ' is-selected' : ''}`}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={(event) => setDraftKnowledgeIds((prev) => (
                            event.target.checked ? [...prev, doc.id] : prev.filter((id) => id !== doc.id)
                          ))}
                        />
                        <span><strong>{doc.file_name}</strong></span>
                      </label>
                    );
                  })}
                  {!knowledgeIndex.documents.some((doc) => doc.status === 'success') && (
                    <div className="outline-knowledge-empty"><strong>暂无可用知识库文档</strong><span>可稍后在知识库中导入后再生成目录。</span></div>
                  )}
                </div>
              </section>
            </div>
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="primary-action" onClick={() => { void saveConfigAndStart(); }} disabled={running || mutationLocked}>
                {outlineData ? '重新生成目录' : '开始生成'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export default OutlinePage;
