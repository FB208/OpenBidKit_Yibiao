import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useToast } from '../../../shared/ui';
import type { BackgroundTaskState } from '../types';
import type { OutlineData, OutlineItem, OutlineMode } from '../../../shared/types';

interface OutlineEditPageProps {
  projectOverview: string;
  techRequirements: string;
  outlineMode: OutlineMode;
  outlineData: OutlineData | null;
  task?: BackgroundTaskState;
  onOutlineModeChange: (mode: OutlineMode) => void;
  onOutlineGenerated: (outlineData: OutlineData) => void;
}

function collectOutlineIds(items: OutlineItem[], ids = new Set<string>()) {
  items.forEach((item) => {
    ids.add(item.id);
    if (item.children?.length) {
      collectOutlineIds(item.children, ids);
    }
  });
  return ids;
}

function collectRootIds(items: OutlineItem[]) {
  return new Set(items.map((item) => item.id));
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function renumberOutlineItems(items: OutlineItem[], parentPrefix = ''): OutlineItem[] {
  return items.map((item, index) => {
    const id = parentPrefix ? `${parentPrefix}.${index + 1}` : `${index + 1}`;
    return {
      ...item,
      id,
      children: item.children?.length ? renumberOutlineItems(item.children, id) : undefined,
    };
  });
}

function updateOutlineItem(items: OutlineItem[], itemId: string, updater: (item: OutlineItem) => OutlineItem): OutlineItem[] {
  return items.map((item) => {
    if (item.id === itemId) {
      return updater(item);
    }

    return {
      ...item,
      children: item.children ? updateOutlineItem(item.children, itemId, updater) : undefined,
    };
  });
}

function deleteOutlineItem(items: OutlineItem[], itemId: string): OutlineItem[] {
  return items.flatMap((item) => {
    if (item.id === itemId) {
      return [];
    }

    return [{
      ...item,
      children: item.children ? deleteOutlineItem(item.children, itemId) : undefined,
    }];
  });
}

function findOutlineItem(items: OutlineItem[], itemId: string): OutlineItem | null {
  for (const item of items) {
    if (item.id === itemId) {
      return item;
    }
    const child = item.children ? findOutlineItem(item.children, itemId) : null;
    if (child) {
      return child;
    }
  }
  return null;
}

function OutlineEditPage({
  projectOverview,
  techRequirements,
  outlineMode,
  outlineData,
  task,
  onOutlineModeChange,
  onOutlineGenerated,
}: OutlineEditPageProps) {
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [startingOutline, setStartingOutline] = useState(false);
  const [localStartAt, setLocalStartAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const logListRef = useRef<HTMLDivElement | null>(null);
  const { showToast } = useToast();
  const selectedItem = outlineData && selectedItemId ? findOutlineItem(outlineData.outline, selectedItemId) : null;
  const taskRunning = task?.status === 'running';
  const taskFailed = task?.status === 'error';
  const generating = startingOutline || taskRunning;
  const progressLogs = task?.logs || [];
  const latestLog = progressLogs[progressLogs.length - 1];
  const progress = generating
    ? Math.max(5, Math.min(99, task?.progress || 5))
    : taskFailed
      ? Math.max(0, Math.min(99, task?.progress || 0))
      : outlineData || task?.status === 'success'
        ? 100
        : 0;
  const statusText = generating ? '运行中' : taskFailed ? '失败' : outlineData ? '已完成' : '未开始';
  const aiStatusTitle = generating ? 'AI 正在工作' : taskFailed ? '生成失败' : outlineData ? '目录已生成' : '等待生成';
  const statusMessage = taskFailed ? task?.error || latestLog || '目录生成失败，请查看开发者日志。' : latestLog || '点击生成目录后，这里会显示目录生成、审核和修正过程。';
  const startedAt = task?.started_at ? Date.parse(task.started_at) : NaN;
  const updatedAt = task?.updated_at ? Date.parse(task.updated_at) : NaN;
  const effectiveStartedAt = Number.isFinite(startedAt) ? startedAt : localStartAt;
  const elapsedText = generating && effectiveStartedAt ? `已运行 ${formatDuration(nowTick - effectiveStartedAt)}` : '';
  const staleText = generating && Number.isFinite(updatedAt) ? `最近更新 ${Math.floor(Math.max(0, nowTick - updatedAt) / 1000)} 秒前` : '';

  useEffect(() => {
    if (outlineData?.outline?.length) {
      const validIds = collectOutlineIds(outlineData.outline);
      setExpandedItems((prev) => {
        const next = new Set([...prev].filter((id) => validIds.has(id)));
        return next.size ? next : collectRootIds(outlineData.outline);
      });
      setSelectedItemId((prev) => (prev && validIds.has(prev) ? prev : outlineData.outline[0]?.id || null));
      return;
    }

    setExpandedItems(new Set());
    setSelectedItemId(null);
  }, [outlineData]);

  useEffect(() => {
    if (task?.status) {
      setStartingOutline(false);
      if (task.status !== 'running') {
        setLocalStartAt(null);
      }
    }
  }, [task?.status]);

  useEffect(() => {
    if (!generating) {
      return;
    }

    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [generating]);

  useEffect(() => {
    if (logListRef.current) {
      logListRef.current.scrollTop = logListRef.current.scrollHeight;
    }
  }, [progressLogs.length]);

  const generateOutline = async () => {
    if (!projectOverview || !techRequirements) {
      showToast('请先完成招标文件解析', 'info');
      return;
    }

    try {
      const startedNow = Date.now();
      setStartingOutline(true);
      setLocalStartAt(startedNow);
      setNowTick(startedNow);
      await window.yibiao?.tasks.startOutlineGeneration({
        overview: projectOverview,
        requirements: techRequirements,
        mode: outlineMode,
      });
      showToast('目录生成任务已在后台启动', 'success');
    } catch (error) {
      setStartingOutline(false);
      setLocalStartAt(null);
      showToast(error instanceof Error ? error.message : '启动目录生成任务失败', 'error');
    }
  };

  const updateOutline = (outline: OutlineItem[]) => {
    if (!outlineData) {
      return;
    }
    onOutlineGenerated({ ...outlineData, outline: renumberOutlineItems(outline) });
  };

  const startEditing = (item: OutlineItem) => {
    if (generating) {
      return;
    }
    setSelectedItemId(item.id);
    setEditingItemId(item.id);
    setEditTitle(item.title);
    setEditDescription(item.description);
  };

  const saveEditing = () => {
    if (!outlineData || !editingItemId || generating) {
      return;
    }

    updateOutline(updateOutlineItem(outlineData.outline, editingItemId, (item) => ({
      ...item,
      title: editTitle.trim() || item.title,
      description: editDescription.trim(),
    })));
    setEditingItemId(null);
    showToast('目录项已更新', 'success');
  };

  const addRootItem = () => {
    if (!outlineData || generating) {
      return;
    }

    const newItem: OutlineItem = {
      id: `${outlineData.outline.length + 1}`,
      title: '新目录项',
      description: '请编辑描述',
    };
    updateOutline([...outlineData.outline, newItem]);
    setSelectedItemId(newItem.id);
    setTimeout(() => startEditing(newItem), 0);
  };

  const addChildItem = (parentId: string) => {
    if (!outlineData || generating) {
      return;
    }

    const parent = findOutlineItem(outlineData.outline, parentId);
    const nextIndex = (parent?.children?.length || 0) + 1;
    const newItem: OutlineItem = {
      id: `${parentId}.${nextIndex}`,
      title: '新目录项',
      description: '请编辑描述',
    };

    updateOutline(updateOutlineItem(outlineData.outline, parentId, (item) => ({
      ...item,
      children: [...(item.children || []), newItem],
    })));
    setExpandedItems((prev) => new Set(prev).add(parentId));
    setSelectedItemId(newItem.id);
    setTimeout(() => startEditing(newItem), 0);
  };

  const removeItem = (itemId: string) => {
    if (!outlineData || generating) {
      return;
    }
    updateOutline(deleteOutlineItem(outlineData.outline, itemId));
    setSelectedItemId(null);
    showToast('目录项已删除', 'success');
  };

  const toggleExpanded = (itemId: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  const expandAllItems = () => {
    if (outlineData?.outline?.length) {
      setExpandedItems(collectOutlineIds(outlineData.outline));
    }
  };

  const collapseAllItems = () => {
    setExpandedItems(new Set());
  };

  const handleModeChange = (mode: OutlineMode) => {
    if (generating || outlineMode === mode) {
      return;
    }
    onOutlineModeChange(mode);
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
          >
            {hasChildren ? '›' : '•'}
          </button>
          <button
            type="button"
            className="outline-tree-content"
            onClick={() => setSelectedItemId(item.id)}
            onDoubleClick={() => hasChildren && toggleExpanded(item.id)}
          >
            <strong>{item.id} {item.title}</strong>
            <small>{item.description || '无描述'}</small>
          </button>
        </div>
        {hasChildren && isExpanded && item.children?.map((child) => renderItem(child, level + 1))}
      </div>
    );
  };

  return (
    <div className="plan-step-body outline-generation-page">
      <section className="outline-command-bar">
        <div>
          <span className="section-kicker">STEP 03</span>
          <strong>目录生成</strong>
          <p>复用旧版目录生成逻辑，生成后可直接调整章节标题、描述和层级。</p>
        </div>
        <div className="outline-mode-switch" role="radiogroup" aria-label="目录模式">
          <button type="button" className={outlineMode === 'free' ? 'is-active' : ''} onClick={() => handleModeChange('free')} disabled={generating}>自由生成</button>
          <button type="button" className={outlineMode === 'aligned' ? 'is-active' : ''} onClick={() => handleModeChange('aligned')} disabled={generating}>按评分项对齐</button>
        </div>
        <button type="button" className="primary-action" onClick={generateOutline} disabled={generating || !projectOverview || !techRequirements}>
          {generating ? 'AI 正在生成目录' : outlineData ? '重新生成目录' : '生成目录'}
        </button>
      </section>

      <section className="outline-generation-workspace">
        <aside className="outline-progress-panel">
          <div className="analysis-result-head">
            <strong>生成过程</strong>
            <span>{statusText}</span>
          </div>
          <div className="outline-progress-log" ref={logListRef}>
            <div className={`outline-ai-status${generating ? ' is-running' : ''}${taskFailed ? ' is-error' : ''}`}>
              <div className="outline-ai-status-row">
                <span className="outline-ai-pulse" aria-hidden="true" />
                <strong>{aiStatusTitle}</strong>
                <em>{progress}%</em>
              </div>
              <div className="outline-ai-progress" aria-label={`目录生成进度 ${progress}%`}>
                <span style={{ width: `${progress}%` }} />
              </div>
              <p>{statusMessage}</p>
              {(elapsedText || staleText) && (
                <div className="outline-ai-meta">
                  {elapsedText && <span>{elapsedText}</span>}
                  {staleText && <span>{staleText}</span>}
                </div>
              )}
            </div>
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
              <button type="button" onClick={expandAllItems} disabled={!outlineData?.outline?.length}>全部展开</button>
              <button type="button" onClick={collapseAllItems} disabled={!outlineData?.outline?.length}>全部折叠</button>
            </div>
          </div>
          {outlineData?.outline?.length ? (
            <div className="outline-tree-list">
              {outlineData.outline.map((item) => renderItem(item))}
            </div>
          ) : (
            <div className="markdown-empty-state outline-empty-state">
              <strong>尚未生成目录</strong>
              <p>先完成招标文件解析，再生成技术方案目录。</p>
            </div>
          )}
        </section>

        <aside className="outline-detail-panel">
          <div className="analysis-result-head">
            <div>
              <strong>目录项详情</strong>
              <span>{selectedItem ? selectedItem.id : '未选择'}</span>
            </div>
            {outlineData && (
              <button type="button" className="outline-add-root-action" onClick={addRootItem} disabled={generating}>
                添加一级目录
              </button>
            )}
          </div>
          {selectedItem ? (
            <div className="outline-detail-body">
              {generating && (
                <div className="outline-detail-lock">
                  目录生成任务正在运行，当前目录暂不可编辑，避免覆盖后台生成结果。
                </div>
              )}
              {editingItemId === selectedItem.id ? (
                <>
                  <label>
                    <span>标题</span>
                    <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} disabled={generating} />
                  </label>
                  <label>
                    <span>描述</span>
                    <textarea value={editDescription} onChange={(event) => setEditDescription(event.target.value)} disabled={generating} />
                  </label>
                  <div className="outline-detail-actions">
                    <button type="button" className="primary-action" onClick={saveEditing} disabled={generating}>保存</button>
                    <button type="button" className="secondary-action" onClick={() => setEditingItemId(null)}>取消</button>
                  </div>
                </>
              ) : (
                <>
                  <h3>{selectedItem.title}</h3>
                  <p>{selectedItem.description || '无描述'}</p>
                  {selectedItem.source_requirement_title && <small>来源评分项：{selectedItem.source_requirement_title}</small>}
                  <div className="outline-detail-actions">
                    <button type="button" className="primary-action" onClick={() => startEditing(selectedItem)} disabled={generating}>编辑</button>
                    <button type="button" className="secondary-action" onClick={() => addChildItem(selectedItem.id)} disabled={generating}>添加子目录</button>
                    <button type="button" className="danger-action" onClick={() => removeItem(selectedItem.id)} disabled={generating}>删除</button>
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
    </div>
  );
}

export default OutlineEditPage;
