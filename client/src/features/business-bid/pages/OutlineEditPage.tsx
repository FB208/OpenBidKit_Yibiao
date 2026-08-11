import { useEffect, useRef, useState, type CSSProperties } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useToast } from '../../../shared/ui';
import type { BusinessBidState, BackgroundTaskState } from '../types';
import type { OutlineData, OutlineItem } from '../../../shared/types';
import { KnowledgeReferencePicker } from '../components/KnowledgeReferencePicker';

interface OutlineEditPageProps {
  outlineData: OutlineData | null;
  referenceKnowledgeDocumentIds: string[];
  referenceKnowledgeSnippetIds: string[];
  task?: BackgroundTaskState;
  hasClauseItems: boolean;
  onOutlineSaved: (outlineData: OutlineData) => void;
  onStateChange: (state: BusinessBidState) => void;
}

function collectOutlineIds(items: OutlineItem[], ids = new Set<string>()) {
  items.forEach((item) => {
    ids.add(item.id);
    if (item.children?.length) collectOutlineIds(item.children, ids);
  });
  return ids;
}

function renumberOutlineItems(items: OutlineItem[], parentPrefix = ''): OutlineItem[] {
  return items.map((item, index) => {
    const id = parentPrefix ? `${parentPrefix}.${index + 1}` : `${index + 1}`;
    return { ...item, id, children: item.children?.length ? renumberOutlineItems(item.children, id) : undefined };
  });
}

function updateOutlineItem(items: OutlineItem[], itemId: string, updater: (item: OutlineItem) => OutlineItem): OutlineItem[] {
  return items.map((item) => (item.id === itemId
    ? updater(item)
    : item.children ? { ...item, children: updateOutlineItem(item.children, itemId, updater) } : item));
}

function deleteOutlineItem(items: OutlineItem[], itemId: string): OutlineItem[] {
  return items.flatMap((item) => (item.id === itemId
    ? []
    : { ...item, children: item.children ? deleteOutlineItem(item.children, itemId) : undefined }));
}

function findOutlineItem(items: OutlineItem[], itemId: string): OutlineItem | null {
  for (const item of items) {
    if (item.id === itemId) return item;
    const child = item.children ? findOutlineItem(item.children, itemId) : null;
    if (child) return child;
  }
  return null;
}

function moveSibling(items: OutlineItem[], draggedId: string, direction: 'up' | 'down'): OutlineItem[] {
  const index = items.findIndex((item) => item.id === draggedId);
  if (index < 0) return items;
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function moveOutlineSibling(items: OutlineItem[], parentId: string | null, draggedId: string, direction: 'up' | 'down'): OutlineItem[] {
  if (parentId === null) return renumberOutlineItems(moveSibling(items, draggedId, direction));
  return items.map((item) => (item.id === parentId
    ? { ...item, children: renumberOutlineItems(moveSibling(item.children || [], draggedId, direction)) }
    : item.children ? { ...item, children: moveOutlineSibling(item.children, parentId, draggedId, direction) } : item));
}

export default function OutlineEditPage({
  outlineData,
  referenceKnowledgeDocumentIds,
  referenceKnowledgeSnippetIds,
  task,
  hasClauseItems,
  onOutlineSaved,
  onStateChange,
}: OutlineEditPageProps) {
  const { showToast } = useToast();
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [startingOutline, setStartingOutline] = useState(false);
  const [progressCollapsed, setProgressCollapsed] = useState(false);
  const [generationDialogOpen, setGenerationDialogOpen] = useState(false);
  const [draftDocIds, setDraftDocIds] = useState<string[]>(referenceKnowledgeDocumentIds);
  const [draftSnippetIds, setDraftSnippetIds] = useState<string[]>(referenceKnowledgeSnippetIds);
  const logListRef = useRef<HTMLDivElement | null>(null);

  const taskRunning = task?.status === 'running';
  const taskFailed = task?.status === 'error';
  const generating = startingOutline || taskRunning;
  const contentMutationLocked = false;
  const outlineMutationLocked = generating || contentMutationLocked;
  const progressLogs = task?.logs || [];
  const latestLog = progressLogs[progressLogs.length - 1];
  const progress = generating ? Math.max(5, Math.min(99, task?.progress || 5)) : taskFailed ? Math.max(0, Math.min(99, task?.progress || 0)) : outlineData ? 100 : 0;
  const selectedItem = outlineData && selectedItemId ? findOutlineItem(outlineData.outline, selectedItemId) : null;

  useEffect(() => {
    if (outlineData?.outline?.length) {
      const validIds = collectOutlineIds(outlineData.outline);
      setExpandedItems((prev) => {
        const next = new Set([...prev].filter((id) => validIds.has(id)));
        return next.size ? next : new Set(outlineData.outline.map((item) => item.id));
      });
      setSelectedItemId((prev) => (prev && validIds.has(prev) ? prev : outlineData.outline[0]?.id || null));
    } else {
      setExpandedItems(new Set());
      setSelectedItemId(null);
    }
  }, [outlineData]);

  useEffect(() => { setDraftDocIds(referenceKnowledgeDocumentIds); setDraftSnippetIds(referenceKnowledgeSnippetIds); }, [referenceKnowledgeDocumentIds, referenceKnowledgeSnippetIds]);

  useEffect(() => {
    if (task?.status) setStartingOutline(false);
  }, [task?.status]);

  useEffect(() => {
    if (logListRef.current) logListRef.current.scrollTop = logListRef.current.scrollHeight;
  }, [progressLogs.length]);

  const saveOutlineChange = async (outline: OutlineItem[], reason: string) => {
    if (!outlineData) return;
    try {
      const renumbered = renumberOutlineItems(outline);
      const nextOutlineData = { ...outlineData, outline: renumbered };
      onOutlineSaved(nextOutlineData);
      showToast(reason, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存目录失败', 'error');
    }
  };

  const generateOutline = async () => {
    if (!hasClauseItems) {
      showToast('请先完成商务条款解析', 'info');
      return;
    }
    try {
      setStartingOutline(true);
      await window.yibiao?.businessBid.saveOutlineConfig({ referenceKnowledgeDocumentIds: draftDocIds, referenceKnowledgeSnippetIds: draftSnippetIds });
      setGenerationDialogOpen(false);
      await window.yibiao?.tasks.startBusinessOutlineGeneration({
        reference_knowledge_document_ids: draftDocIds,
        reference_knowledge_snippet_ids: draftSnippetIds,
      });
      showToast('商务目录生成任务已在后台启动', 'success');
    } catch (error) {
      setStartingOutline(false);
      showToast(error instanceof Error ? error.message : '启动目录生成任务失败', 'error');
    }
  };

  const startEditing = (item: OutlineItem) => {
    if (outlineMutationLocked) return;
    setSelectedItemId(item.id);
    setEditingItemId(item.id);
    setEditTitle(item.title);
    setEditDescription(item.description);
  };

  const saveEditing = async () => {
    if (!outlineData || !editingItemId || outlineMutationLocked) return;
    try {
      await saveOutlineChange(updateOutlineItem(outlineData.outline, editingItemId, (item) => ({
        ...item, title: editTitle.trim() || item.title, description: editDescription.trim(),
      })), '目录项已更新，相关正文已清空');
      setEditingItemId(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存目录项失败', 'error');
    }
  };

  const addRootItem = async () => {
    if (!outlineData || outlineMutationLocked) return;
    const newItem: OutlineItem = { id: `${outlineData.outline.length + 1}`, title: '新目录项', description: '请编辑描述' };
    try {
      await saveOutlineChange([...outlineData.outline, newItem], '一级目录已添加');
      setSelectedItemId(newItem.id);
      setEditingItemId(newItem.id);
      setEditTitle(newItem.title);
      setEditDescription(newItem.description);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '添加一级目录失败', 'error');
    }
  };

  const addChildItem = async (parentId: string) => {
    if (!outlineData || outlineMutationLocked) return;
    const parent = findOutlineItem(outlineData.outline, parentId);
    const nextIndex = (parent?.children?.length || 0) + 1;
    const newItem: OutlineItem = { id: `${parentId}.${nextIndex}`, title: '新目录项', description: '请编辑描述' };
    try {
      await saveOutlineChange(updateOutlineItem(outlineData.outline, parentId, (item) => ({ ...item, children: [...(item.children || []), newItem] })), '子目录已添加，父目录正文已清空');
      setExpandedItems((prev) => new Set(prev).add(parentId));
      setSelectedItemId(newItem.id);
      setEditingItemId(newItem.id);
      setEditTitle(newItem.title);
      setEditDescription(newItem.description);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '添加子目录失败', 'error');
    }
  };

  const removeItem = async (itemId: string) => {
    if (!outlineData || outlineMutationLocked) return;
    try {
      const nextOutline = deleteOutlineItem(outlineData.outline, itemId);
      if (!nextOutline.length) {
        showToast('至少保留一个目录项', 'info');
        return;
      }
      await saveOutlineChange(nextOutline, '目录项已删除');
      setSelectedItemId(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除目录项失败', 'error');
    }
  };

  const moveItem = async (itemId: string, direction: 'up' | 'down') => {
    if (!outlineData || outlineMutationLocked) return;
    const location = findLocation(outlineData.outline, itemId);
    const next = moveOutlineSibling(outlineData.outline, location?.parentId ?? null, itemId, direction);
    try {
      await saveOutlineChange(next, '目录顺序已调整');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '调整目录顺序失败', 'error');
    }
  };

  const findLocation = (items: OutlineItem[], itemId: string, parentId: string | null = null): { parentId: string | null } | null => {
    for (const item of items) {
      if (item.id === itemId) return { parentId };
      if (item.children) {
        const found = findLocation(item.children, itemId, item.id);
        if (found) return found;
      }
    }
    return null;
  };

  const toggleExpanded = (itemId: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  };

  const renderItem = (item: OutlineItem, level = 0) => {
    const hasChildren = Boolean(item.children?.length);
    const isExpanded = expandedItems.has(item.id);
    const isActive = selectedItemId === item.id;
    return (
      <div className="outline-tree-node" key={item.id} style={{ '--outline-level': level } as CSSProperties}>
        <div className={`outline-tree-item${isActive ? ' is-active' : ''}`}>
          <button
            type="button"
            className={`outline-tree-toggle${hasChildren ? '' : ' is-leaf'}${isExpanded ? ' is-expanded' : ''}`}
            onClick={() => hasChildren && toggleExpanded(item.id)}
            disabled={!hasChildren}
            aria-label={hasChildren ? `${isExpanded ? '折叠' : '展开'} ${item.title}` : `${item.title} 无子目录`}
          >{hasChildren ? '›' : '•'}</button>
          <button type="button" className="outline-tree-content" onClick={() => setSelectedItemId(item.id)}>
            <strong>{item.id} {item.title}</strong>
          </button>
          {!outlineMutationLocked && (
            <span className="outline-tree-item-tools">
              <button type="button" onClick={() => void moveItem(item.id, 'up')} disabled={level < 0}>↑</button>
              <button type="button" onClick={() => void moveItem(item.id, 'down')}>↓</button>
            </span>
          )}
        </div>
        {hasChildren && isExpanded && item.children?.map((child) => renderItem(child, level + 1))}
      </div>
    );
  };

  return (
    <div className="plan-step-body outline-generation-page business-outline-page">
      <section className="outline-command-bar">
        <div>
          <span className="section-kicker">STEP 03</span>
          <strong>商务标目录生成</strong>
          <p>基于商务响应矩阵与参考知识库，生成投标函、响应表、报价、偏离表、资信材料等结构。</p>
        </div>
        <div className="outline-command-actions">
          <button type="button" className="primary-action" onClick={() => setGenerationDialogOpen(true)} disabled={generating || !hasClauseItems}>
            {generating ? 'AI 正在生成目录' : outlineData ? '重新生成目录' : '生成目录'}
          </button>
        </div>
      </section>

      <section className="outline-generation-workspace">
        <aside className="outline-progress-panel">
          <div className="analysis-result-head">
            <strong>生成过程</strong>
            <span>{generating ? '运行中' : taskFailed ? '失败' : outlineData ? '已完成' : '未开始'}</span>
          </div>
          <div className={`content-outline-stats outline-progress-summary${progressCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setProgressCollapsed((prev) => !prev)} aria-expanded={!progressCollapsed}>
              <span>生成进度</span>
              <strong>{progress}%</strong>
              <em>{progressCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!progressCollapsed && (
              <div className="content-outline-stats-body">
                <div className="content-generation-progress-track" aria-label={`目录生成进度 ${progress}%`}><span style={{ width: `${progress}%` }} /></div>
                <p>{taskFailed ? task?.error || latestLog || '目录生成失败。' : latestLog || '点击生成目录后，这里会显示目录生成过程。'}</p>
              </div>
            )}
          </div>
          <div className="outline-progress-log" ref={logListRef}>
            {progressLogs.length ? progressLogs.map((item, index) => <p className={index === progressLogs.length - 1 ? 'is-latest' : ''} key={`${item}-${index}`}>{item}</p>) : <p>等待生成任务启动。</p>}
          </div>
        </aside>

        <section className="outline-tree-panel">
          <div className="analysis-result-head outline-tree-head">
            <div><strong>目录结构</strong><span>{outlineData?.outline?.length || 0} 个一级目录</span></div>
            {outlineData && <div className="outline-tree-tools">
              <button type="button" className="outline-add-root-action" onClick={() => void addRootItem()} disabled={outlineMutationLocked}>添加一级目录</button>
            </div>}
          </div>
          {outlineData?.outline?.length ? (
            <div className="outline-tree-list">{outlineData.outline.map((item) => renderItem(item))}</div>
          ) : (
            <div className="markdown-empty-state outline-empty-state">
              <strong>尚未生成目录</strong>
              <p>先完成商务条款解析，再生成商务标目录。</p>
            </div>
          )}
        </section>

        <aside className="outline-detail-panel">
          <div className="analysis-result-head"><div><strong>目录项详情</strong><span>{selectedItem ? selectedItem.id : '未选择'}</span></div></div>
          {selectedItem ? (
            <div className="outline-detail-body">
              {editingItemId === selectedItem.id ? (
                <>
                  <label><span>标题</span><input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} disabled={outlineMutationLocked} /></label>
                  <label><span>描述</span><textarea value={editDescription} onChange={(event) => setEditDescription(event.target.value)} disabled={outlineMutationLocked} /></label>
                  <div className="outline-detail-actions">
                    <button type="button" className="primary-action" onClick={() => void saveEditing()} disabled={outlineMutationLocked}>保存</button>
                    <button type="button" className="secondary-action" onClick={() => setEditingItemId(null)}>取消</button>
                  </div>
                </>
              ) : (
                <>
                  <h3>{selectedItem.title}</h3>
                  <p>{selectedItem.description || '无描述'}</p>
                  <div className="outline-detail-actions">
                    <button type="button" className="primary-action" onClick={() => startEditing(selectedItem)} disabled={outlineMutationLocked}>编辑</button>
                    <button type="button" className="secondary-action" onClick={() => void addChildItem(selectedItem.id)} disabled={outlineMutationLocked}>添加子目录</button>
                    <button type="button" className="danger-action" onClick={() => void removeItem(selectedItem.id)} disabled={outlineMutationLocked}>删除</button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="markdown-empty-state outline-empty-state">
              <strong>选择一个目录项</strong>
              <p>在左侧目录树中选择章节后，可查看并编辑标题和描述。</p>
            </div>
          )}
        </aside>
      </section>

      <Dialog.Root open={generationDialogOpen} onOpenChange={(open) => !open && setGenerationDialogOpen(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="outline-generation-config-card">
            <Dialog.Title className="sr-only">{outlineData ? '重新生成目录' : '生成目录'}</Dialog.Title>
            <Dialog.Description className="sr-only">选择本次目录生成方式和参考知识库。</Dialog.Description>
            <div className="outline-generation-config-body">
              <section className="outline-generation-config-section outline-knowledge-picker">
                <div className="outline-generation-config-head">
                  <strong>参考知识库</strong>
                  <span>已选择 {draftDocIds.length} 个文档 / {draftSnippetIds.length} 个片段</span>
                </div>
                <KnowledgeReferencePicker
                  disabled={generating}
                  documentIds={draftDocIds}
                  snippetIds={draftSnippetIds}
                  onChange={(docIds, snippetIds) => { setDraftDocIds(docIds); setDraftSnippetIds(snippetIds); }}
                />
              </section>
            </div>
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="primary-action" onClick={() => void generateOutline()} disabled={generating || !hasClauseItems}>
                开始生成
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
