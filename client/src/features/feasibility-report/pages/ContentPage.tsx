import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MarkdownEditor, MarkdownFullscreenViewer, MarkdownRenderer, ProgressBar, useToast } from '../../../shared/ui';
import type { OutlineData, OutlineItem } from '../../../shared/types';
import { formatOutlineTitle } from '../../../shared/utils/outlineNumbering';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import type { FeasibilityBackgroundTaskState } from '../types';
import { collectFeasibilityLeaves } from '../types';

interface ContentPageProps {
  outlineData: OutlineData | null;
  contentTask?: FeasibilityBackgroundTaskState;
  humanWritingTask?: FeasibilityBackgroundTaskState;
  generating: boolean;
  reviewing: boolean;
  locked: boolean;
  hasKeyParameters: boolean;
  onSave: (item: OutlineItem, content: string) => Promise<void>;
}

const statusLabels: Record<string, string> = {
  idle: '待生成',
  running: '进行中',
  success: '已生成',
  error: '失败',
  pending: '目录分组',
};

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function collectLeafCount(item: OutlineItem): number {
  if (!item.children?.length) return 1;
  return item.children.reduce((sum, child) => sum + collectLeafCount(child), 0);
}

function readContentPhase(task?: FeasibilityBackgroundTaskState) {
  const stats = task?.stats;
  if (!stats || typeof stats !== 'object' || !('phase' in stats)) return '';
  return String((stats as { phase?: string }).phase || '');
}

function ContentPage({
  outlineData,
  contentTask,
  humanWritingTask,
  generating,
  reviewing,
  locked,
  hasKeyParameters,
  onSave,
}: ContentPageProps) {
  const { showToast } = useToast();
  const [selectedItemId, setSelectedItemId] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState(true);
  const [progressCollapsed, setProgressCollapsed] = useState(false);
  const [pausePending, setPausePending] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const logListRef = useRef<HTMLDivElement | null>(null);
  const leaves = useMemo(() => collectFeasibilityLeaves(outlineData?.outline || []), [outlineData]);
  const selectedItem = useMemo(() => {
    const find = (items: OutlineItem[]): OutlineItem | null => {
      for (const item of items) {
        if (item.id === selectedItemId) return item;
        if (item.children?.length) {
          const found = find(item.children);
          if (found) return found;
        }
      }
      return null;
    };
    return outlineData?.outline ? find(outlineData.outline) : null;
  }, [outlineData, selectedItemId]);
  const generatedCount = leaves.filter((item) => item.content?.trim()).length;
  const pendingCount = Math.max(0, leaves.length - generatedCount);
  const contentPhase = readContentPhase(contentTask);
  const inReviewPhase = reviewing || contentPhase === 'human-writing';
  const pausing = pausePending || contentTask?.status === 'pausing';
  const running = generating || reviewing;
  const paused = !running && contentTask?.status === 'paused';
  const task = generating || paused || !reviewing ? contentTask : (humanWritingTask || contentTask);
  const progressLogs = task?.logs || [];
  const latestLog = progressLogs[progressLogs.length - 1] || '';
  const failed = task?.status === 'error';
  const selectedIsLeaf = Boolean(selectedItem && !selectedItem.children?.length);
  const progress = running
    ? Math.max(5, Math.min(99, Number(task?.progress || 0) || 5))
    : failed || paused
      ? Math.max(0, Math.min(99, Number(task?.progress || 0) || 0))
      : generatedCount && generatedCount === leaves.length
        ? 100
        : Math.max(0, Math.min(99, leaves.length ? Math.round((generatedCount / leaves.length) * 100) : Number(task?.progress || 0) || 0));
  const phaseLabel = inReviewPhase ? '审校' : '正文生成';
  const statusLabel = running ? '进行中' : failed ? '失败' : paused ? '已暂停' : generatedCount === leaves.length && leaves.length ? '已完成' : generatedCount ? '部分完成' : '等待开始';
  const statusMessage = failed
    ? task?.error || latestLog || (inReviewPhase ? '自然化审校失败' : '正文生成失败')
    : latestLog || (paused
      ? '正文生成已暂停，可点击继续从中断处恢复。'
      : generatedCount === leaves.length && leaves.length
        ? `已生成 ${generatedCount} 个章节，可重新生成全文。`
        : generatedCount
          ? `已生成 ${generatedCount} / ${leaves.length} 个章节。`
          : '点击右上角“生成正文”后，后台会按叶子章节撰写并自动审校。');
  const startedAt = task?.started_at ? Date.parse(task.started_at) : NaN;
  const updatedAt = task?.updated_at ? Date.parse(task.updated_at) : NaN;
  const elapsedText = running && Number.isFinite(startedAt) ? `已运行 ${formatDuration(nowTick - startedAt)}` : '';
  const staleText = running && Number.isFinite(updatedAt) ? `最近更新 ${Math.floor(Math.max(0, nowTick - updatedAt) / 1000)} 秒前` : '';
  const activeLeafTitle = latestLog.match(/^正在(?:撰写|审校)：(.+)$/)?.[1] || '';
  const generationButtonLabel = pausing
    ? '正在暂停中...'
    : running
      ? '暂停'
      : paused
        ? '继续'
        : generatedCount === leaves.length && leaves.length
          ? '重新生成正文'
          : generatedCount > 0
            ? '继续生成正文'
            : '生成正文';

  useEffect(() => {
    if (!selectedItemId && leaves[0]) setSelectedItemId(leaves[0].id);
  }, [leaves, selectedItemId]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (contentTask?.status !== 'running') setPausePending(false);
  }, [contentTask?.status]);

  useEffect(() => {
    if (logListRef.current) {
      logListRef.current.scrollTop = logListRef.current.scrollHeight;
    }
  }, [progressLogs.length]);

  const startEditing = () => {
    if (!selectedItem || !selectedIsLeaf) return;
    setDraft(selectedItem.content || '');
    setEditing(true);
    setPreview(false);
  };

  const startContentGeneration = async (payload: { onlyMissing?: boolean; resume?: boolean }) => {
    try {
      await window.yibiao!.tasks.startFeasibilityContent(payload);
      showToast(payload.resume
        ? '已继续正文生成任务'
        : payload.onlyMissing
          ? '正文补写任务已在后台启动'
          : generatedCount === leaves.length && leaves.length
            ? '正文重新生成任务已在后台启动'
            : '正文生成任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动正文生成失败', 'error');
    }
  };

  const pauseContentGeneration = async () => {
    setPausePending(true);
    try {
      await window.yibiao!.tasks.pauseFeasibilityContent();
      showToast('正在暂停正文生成，当前 AI 请求完成后会停止调度新任务', 'info');
    } catch (error) {
      setPausePending(false);
      showToast(error instanceof Error ? error.message : '暂停正文生成失败', 'error');
    }
  };

  const handleGenerationButtonClick = () => {
    if (running) {
      void pauseContentGeneration();
      return;
    }
    if (paused) {
      void startContentGeneration({ resume: true, onlyMissing: true });
      return;
    }
    if (generatedCount === leaves.length && leaves.length) {
      void startContentGeneration({ onlyMissing: false });
      return;
    }
    void startContentGeneration({ onlyMissing: generatedCount > 0 });
  };

  const getItemStatus = (item: OutlineItem, isLeaf: boolean) => {
    if (!isLeaf) return 'pending';
    if (running && activeLeafTitle && item.title === activeLeafTitle) return 'running';
    if (item.content?.trim()) return 'success';
    if (failed && activeLeafTitle && item.title === activeLeafTitle) return 'error';
    return 'idle';
  };

  const renderTree = (items: OutlineItem[], level = 0): ReactNode => items.map((item) => {
    const isLeaf = !item.children?.length;
    const status = getItemStatus(item, isLeaf);
    const leafCount = isLeaf ? 1 : collectLeafCount(item);
    const statusText = status === 'running'
      ? (inReviewPhase ? '审校中' : '生成中')
      : statusLabels[status];
    return (
      <div className="content-outline-node" key={item.id} style={{ '--content-level': level } as CSSProperties}>
        <button
          type="button"
          className={`content-outline-item is-${status}${selectedItemId === item.id ? ' is-active' : ''}`}
          onClick={() => { setSelectedItemId(item.id); setEditing(false); }}
        >
          <span className="content-outline-dot" aria-hidden="true" />
          <span className="content-outline-text">
            <strong>{formatOutlineTitle(item.id, item.title, DEFAULT_EXPORT_FORMAT.headings[Math.min(item.id.split('.').length - 1, 5)])}</strong>
            <small>{isLeaf ? statusText : `${statusText} · ${leafCount} 个章节`}</small>
          </span>
          {isLeaf ? <em>{statusText}</em> : null}
        </button>
        {item.children?.length ? renderTree(item.children, level + 1) : null}
      </div>
    );
  });

  const selectedStatus = selectedItem
    ? getItemStatus(selectedItem, selectedIsLeaf)
    : 'idle';
  const selectedContent = (editing ? draft : selectedItem?.content) || '';
  const selectedStatusText = selectedStatus === 'running'
    ? (inReviewPhase ? '审校中' : '生成中')
    : statusLabels[selectedStatus];

  if (!outlineData?.outline?.length) {
    return (
      <div className="plan-step-body content-generation-page">
        <section className="markdown-empty-state content-generation-empty">
          <strong>暂无目录</strong>
          <p>请先完成报告目录和关键参数，再生成正文。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="plan-step-body content-generation-page">
      <section className="content-generation-command-bar">
        <div>
          <span className="section-kicker">STEP 06</span>
          <strong>正文与导出</strong>
          <p>按叶子章节增量生成正文，完成后自动自然化审校。选址、工艺、环保、进度类章节会插入插图指引框。</p>
        </div>
        <div className="content-generation-stats" aria-label="正文生成统计">
          <span><strong>{leaves.length}</strong> 个章节</span>
          <span><strong>{generatedCount}</strong> 已生成</span>
          {pendingCount > 0 && <span><strong>{pendingCount}</strong> 待生成</span>}
        </div>
        <div className="content-generation-actions">
          <button
            type="button"
            className="primary-action"
            onClick={handleGenerationButtonClick}
            disabled={pausing || !leaves.length || !hasKeyParameters}
          >
            {generationButtonLabel}
          </button>
        </div>
      </section>

      <section className="content-generation-workspace feasibility-content-workspace">
        <aside className="outline-progress-panel">
          <div className="analysis-result-head">
            <strong>{inReviewPhase ? '审校过程' : '生成过程'}</strong>
            <span>{statusLabel}</span>
          </div>
          <div className={`content-outline-stats outline-progress-summary${progressCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setProgressCollapsed((prev) => !prev)} aria-expanded={!progressCollapsed}>
              <span>{inReviewPhase ? '审校进度' : '生成进度'}</span>
              <strong>{progress}%</strong>
              <em>{progressCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!progressCollapsed && (
              <div className="content-outline-stats-body">
                <ProgressBar value={progress} active={running} label={`${phaseLabel}进度 ${progress}%`} />
                <p>{statusMessage}</p>
                {(elapsedText || staleText) && (
                  <div className="outline-progress-meta">
                    {elapsedText && <span>{elapsedText}</span>}
                    {staleText && <span>{staleText}</span>}
                  </div>
                )}
                {failed && <small>{task?.error || latestLog || (inReviewPhase ? '自然化审校失败' : '正文生成失败')}</small>}
              </div>
            )}
          </div>
          <div className="outline-progress-log" ref={logListRef}>
            {progressLogs.length ? progressLogs.map((item, index) => (
              <p className={index === progressLogs.length - 1 ? 'is-latest' : ''} key={`${item}-${index}`}>{item}</p>
            )) : <p>等待生成任务启动。</p>}
          </div>
        </aside>

        <aside className="content-outline-panel">
          <div className="analysis-result-head">
            <strong>报告目录</strong>
            <span>{leaves.length} 个章节</span>
          </div>
          <div className="content-outline-list">
            {renderTree(outlineData.outline)}
          </div>
        </aside>

        <article className="content-reader-panel">
          <div className="content-reader-head">
            <div>
              <span className="section-kicker">章节正文</span>
              <strong>{selectedItem ? `${selectedItem.id} ${selectedItem.title}` : '选择章节'}</strong>
              <p>{selectedItem?.description || '选择左侧叶子章节查看或编辑正文。'}</p>
            </div>
            <div className="content-reader-actions">
              <span className={`content-status-badge is-${selectedStatus}`}>{selectedStatusText}</span>
              {editing ? (
                <>
                  <button type="button" className={preview ? 'secondary-action' : 'primary-action'} onClick={() => setPreview((value) => !value)}>
                    {preview ? '编辑' : '预览'}
                  </button>
                  <button
                    type="button"
                    className="primary-action"
                    disabled={locked}
                    onClick={() => {
                      if (!selectedItem) return;
                      void onSave(selectedItem, draft).then(() => setEditing(false));
                    }}
                  >保存</button>
                  <button type="button" className="secondary-action" onClick={() => setEditing(false)}>取消</button>
                </>
              ) : (
                <button type="button" className="secondary-action" onClick={startEditing} disabled={!selectedIsLeaf || locked}>编辑</button>
              )}
            </div>
          </div>
          {selectedIsLeaf && editing && !preview ? (
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              disabled={locked}
              placeholder="输入 Markdown 正文..."
              fullscreenTitle={selectedItem?.title || '编辑章节'}
            />
          ) : selectedIsLeaf && selectedContent.trim() ? (
            <MarkdownFullscreenViewer
              className="markdown-viewer content-generation-output"
              title={selectedItem ? `${selectedItem.id} ${selectedItem.title}全屏查看` : '正文预览全屏查看'}
            >
              <MarkdownRenderer allowRawHtml={false}>{selectedContent}</MarkdownRenderer>
            </MarkdownFullscreenViewer>
          ) : selectedIsLeaf ? (
            <div className="markdown-empty-state content-generation-empty">
              <strong>{selectedStatus === 'error' ? (task?.error || '正文生成失败') : selectedStatus === 'running' ? (inReviewPhase ? '正在审校此章节' : '正在生成此章节') : '正文待生成'}</strong>
              <p>{selectedStatus === 'running'
                ? '模型返回内容后会显示在这里。'
                : paused
                  ? '任务已暂停，可先导出当前内容或点击继续。'
                  : running
                    ? '当前正在处理其他章节，完成后会更新这里的状态。'
                    : '点击右上角生成正文后，后台会按叶子章节撰写并自动审校。'}</p>
            </div>
          ) : (
            <div className="markdown-empty-state content-generation-empty">
              <strong>当前是目录分组</strong>
              <p>该目录下包含 {selectedItem ? collectLeafCount(selectedItem) : 0} 个章节，请选择叶子章节查看具体正文。</p>
            </div>
          )}
        </article>
      </section>
    </div>
  );
}

export default ContentPage;
