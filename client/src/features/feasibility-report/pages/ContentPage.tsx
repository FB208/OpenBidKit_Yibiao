import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { MarkdownEditor, MarkdownFullscreenViewer, MarkdownRenderer, ProgressBar, useToast } from '../../../shared/ui';
import type { OutlineData, OutlineItem } from '../../../shared/types';
import { formatOutlineTitle } from '../../../shared/utils/outlineNumbering';
import type { ExportFormatConfig } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import { buildExportFormatCssVars } from '../../../shared/utils/exportFormatCss';
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

type TreeStatus = 'idle' | 'running' | 'success' | 'error' | 'partial';

interface OutlineNodeMeta {
  status: TreeStatus;
  leafCount: number;
}

const statusLabels: Record<TreeStatus, string> = {
  idle: '待生成',
  running: '生成中',
  success: '已生成',
  error: '失败',
  partial: '部分生成',
};

function getLeafStatus(
  item: OutlineItem,
  options: { running: boolean; failed: boolean; activeLeafTitle: string },
): TreeStatus {
  if (options.running && options.activeLeafTitle && item.title === options.activeLeafTitle) return 'running';
  if (item.content?.trim()) return 'success';
  if (options.failed && options.activeLeafTitle && item.title === options.activeLeafTitle) return 'error';
  return 'idle';
}

function getParentStatus(childStatuses: TreeStatus[]): TreeStatus {
  if (childStatuses.some((status) => status === 'running')) return 'running';
  if (childStatuses.every((status) => status === 'success')) return 'success';
  if (childStatuses.some((status) => status === 'error')) return 'error';
  if (childStatuses.some((status) => status === 'success' || status === 'partial')) return 'partial';
  return 'idle';
}

function buildOutlineMeta(
  items: OutlineItem[],
  options: { running: boolean; failed: boolean; activeLeafTitle: string },
) {
  const meta = new Map<string, OutlineNodeMeta>();

  function visit(item: OutlineItem): OutlineNodeMeta {
    if (!item.children?.length) {
      const nodeMeta = { status: getLeafStatus(item, options), leafCount: 1 };
      meta.set(item.id, nodeMeta);
      return nodeMeta;
    }

    const children = item.children.map(visit);
    const nodeMeta = {
      status: getParentStatus(children.map((child) => child.status)),
      leafCount: children.reduce((sum, child) => sum + child.leafCount, 0),
    };
    meta.set(item.id, nodeMeta);
    return nodeMeta;
  }

  items.forEach(visit);
  return meta;
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
  const [statsCollapsed, setStatsCollapsed] = useState(false);
  const [pausePending, setPausePending] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormatConfig>(DEFAULT_EXPORT_FORMAT);
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
  const displayProgressLabel = inReviewPhase ? '审校统计' : '生成统计';
  const statusMessage = failed
    ? task?.error || latestLog || (inReviewPhase ? '自然化审校失败' : '正文生成失败')
    : latestLog || (paused
      ? '正文生成已暂停，可点击继续从中断处恢复。'
      : generatedCount === leaves.length && leaves.length
        ? `已生成 ${generatedCount} 个章节，可重新生成全文。`
        : generatedCount
          ? `已生成 ${generatedCount} / ${leaves.length} 个章节。`
          : '点击右上角“生成正文”后，后台会按叶子章节撰写并自动审校。');
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
  const exportFormatPreviewStyle = useMemo<CSSProperties>(() => buildExportFormatCssVars(exportFormat), [exportFormat]);
  const outlineMeta = useMemo(
    () => buildOutlineMeta(outlineData?.outline || [], { running, failed, activeLeafTitle }),
    [activeLeafTitle, failed, outlineData, running],
  );

  useEffect(() => {
    if (!selectedItemId && leaves[0]) setSelectedItemId(leaves[0].id);
  }, [leaves, selectedItemId]);

  useEffect(() => {
    window.yibiao?.config.load()
      .then((config) => {
        if (config?.export_format) setExportFormat(config.export_format);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (contentTask?.status !== 'running') setPausePending(false);
  }, [contentTask?.status]);

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

  const renderTree = (items: OutlineItem[], level = 0): ReactNode => items.map((item) => {
    const isLeaf = !item.children?.length;
    const meta = outlineMeta.get(item.id);
    const status = meta?.status || 'idle';
    const leafCount = meta?.leafCount || 0;
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
            <strong>{formatOutlineTitle(item.id, item.title, exportFormat.headings[Math.min(item.id.split('.').length - 1, 5)])}</strong>
            <small>{isLeaf ? statusText : `${statusText} · ${leafCount} 个章节`}</small>
          </span>
          <em>{statusText}</em>
        </button>
        {item.children?.length ? renderTree(item.children, level + 1) : null}
      </div>
    );
  });

  const selectedStatus = selectedItem
    ? (outlineMeta.get(selectedItem.id)?.status || 'idle')
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
          <strong>正文生成</strong>
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

      <section className="content-generation-workspace">
        <aside className="content-outline-panel">
          <div className="analysis-result-head">
            <strong>报告目录</strong>
            <span>{leaves.length} 个章节</span>
          </div>
          <div className={`content-outline-stats${statsCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setStatsCollapsed((prev) => !prev)} aria-expanded={!statsCollapsed}>
              <span>{displayProgressLabel}</span>
              <strong>{generatedCount}/{leaves.length}</strong>
              <em>{statsCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!statsCollapsed && (
              <div className="content-outline-stats-body">
                <ProgressBar
                  value={progress}
                  tone={inReviewPhase ? 'sky' : 'primary'}
                  active={running}
                  label={`${phaseLabel}进度 ${progress}%`}
                />
                <p>{statusMessage}</p>
                {failed && <small>{task?.error || latestLog || (inReviewPhase ? '自然化审校失败' : '正文生成失败')}</small>}
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
              <strong>{selectedItem ? `${selectedItem.id} ${selectedItem.title}` : '选择章节'}</strong>
              <p>{selectedItem?.description || '选择左侧目录项查看生成正文。'}</p>
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
              className="markdown-viewer content-generation-output export-format-preview"
              style={exportFormatPreviewStyle}
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
              <p>该目录下包含 {selectedItem ? (outlineMeta.get(selectedItem.id)?.leafCount || 0) : 0} 个章节，请选择叶子章节查看具体正文。</p>
            </div>
          )}
        </article>
      </section>
    </div>
  );
}

export default ContentPage;
