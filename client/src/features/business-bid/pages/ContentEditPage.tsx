import { useEffect, useState, type CSSProperties } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { MarkdownEditor, MarkdownFullscreenViewer, MarkdownRenderer, useToast } from '../../../shared/ui';
import type { OutlineData, OutlineItem } from '../../../shared/types';
import type { BackgroundTaskState, BusinessBidContentGenerationOptions, ContentGenerationSectionState, BusinessBidState } from '../types';

interface ContentEditPageProps {
  outlineData: OutlineData | null;
  task?: BackgroundTaskState;
  contentGenerationOptions?: BusinessBidContentGenerationOptions;
  sections: Record<string, ContentGenerationSectionState>;
  onContentGenerationOptionsChange: (options: BusinessBidContentGenerationOptions) => void;
  onStateChange: (state: BusinessBidState) => void;
  onContentSaved: (item: OutlineItem, content: string) => void;
}

function collectLeafItems(items: OutlineItem[]): OutlineItem[] {
  return items.flatMap((item) => (item.children?.length ? collectLeafItems(item.children) : [item]));
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

function statusLabels(status: string) {
  return { idle: '待生成', running: '生成中', success: '已生成', error: '失败' }[status] || '待生成';
}

export default function ContentEditPage({
  outlineData,
  task,
  contentGenerationOptions,
  sections,
  onContentGenerationOptionsChange,
  onStateChange,
  onContentSaved,
}: ContentEditPageProps) {
  const { showToast } = useToast();
  const leaves = outlineData?.outline ? collectLeafItems(outlineData.outline) : [];
  const [selectedItemId, setSelectedItemId] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [draftContent, setDraftContent] = useState('');
  const [pausePending, setPausePending] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [draftMinWords, setDraftMinWords] = useState(contentGenerationOptions?.minimumWords ?? 600);

  const firstLeafId = leaves[0]?.id || '';
  const selectedItem = outlineData?.outline && selectedItemId ? findItem(outlineData.outline, selectedItemId) : null;
  const selectedIsLeaf = Boolean(selectedItem && !selectedItem.children?.length);
  const selectedContent = selectedItem && selectedIsLeaf ? sections[selectedItem.id]?.content || selectedItem.content || '' : '';
  const editing = Boolean(selectedItem && selectedIsLeaf && editingItemId === selectedItem.id);
  const running = task?.status === 'running';
  const pausing = task?.status === 'pausing' || pausePending;
  const paused = task?.status === 'paused';
  const taskFailed = task?.status === 'error';
  const taskInFlight = running || pausing;
  const completedCount = leaves.filter((item) => sections[item.id]?.status === 'success').length;
  const progress = leaves.length ? Math.round((completedCount / leaves.length) * 100) : 0;
  const latestLog = task?.logs?.[task.logs.length - 1] || '';
  const generationButtonLabel = pausing
    ? '正在暂停中...'
    : running
      ? '暂停'
      : paused
        ? '继续'
        : completedCount === leaves.length && leaves.length
          ? '重新生成正文'
          : completedCount > 0
            ? '继续生成正文'
            : '生成正文';

  useEffect(() => {
    if (!outlineData?.outline?.length) {
      setSelectedItemId('');
      return;
    }
    if (!selectedItemId || !findItem(outlineData.outline, selectedItemId)) {
      setSelectedItemId(firstLeafId || outlineData.outline[0].id);
    }
  }, [firstLeafId, outlineData, selectedItemId]);

  useEffect(() => {
    if (task?.status !== 'running') setPausePending(false);
  }, [task?.status]);

  useEffect(() => {
    if (!selectedItem || selectedItem.id === editingItemId) return;
    setEditingItemId(null);
    setIsPreviewing(false);
    setDraftContent('');
  }, [editingItemId, selectedItem]);

  const launchContentGeneration = async (regenerate: boolean) => {
    if (!outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }
    await onContentGenerationOptionsChange({ minimumWords: draftMinWords });
    setConfigOpen(false);
    await window.yibiao?.tasks.startBusinessContentGeneration({ regenerate, minimumWords: draftMinWords });
    showToast(regenerate ? '商务正文重新生成任务已在后台启动' : '商务正文生成任务已在后台启动', 'success');
  };

  const pauseGeneration = async () => {
    if (!running) return;
    setPausePending(true);
    try {
      await window.yibiao?.tasks.pauseBusinessContentGeneration();
      showToast('正在暂停商务正文生成', 'info');
    } catch (error) {
      setPausePending(false);
      showToast(error instanceof Error ? error.message : '暂停正文生成失败', 'error');
    }
  };

  const resumeGeneration = async () => {
    if (!paused) return;
    try {
      await window.yibiao?.tasks.startBusinessContentGeneration({ resume: true });
      showToast('已继续商务正文生成任务', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '继续正文生成失败', 'error');
    }
  };

  const handleGenerationButton = () => {
    if (running) void pauseGeneration();
    else if (paused) void resumeGeneration();
    else if (completedCount === leaves.length && leaves.length) setConfigOpen(true);
    else void launchContentGeneration(completedCount > 0);
  };

  const startEditing = () => {
    if (taskInFlight) {
      showToast('请先完成当前正文生成任务，再编辑正文', 'info');
      return;
    }
    if (!selectedItem || !selectedIsLeaf) {
      showToast('请选择一个叶子小节后再编辑正文', 'info');
      return;
    }
    setEditingItemId(selectedItem.id);
    setIsPreviewing(false);
    setDraftContent(selectedContent);
  };

  const saveEditing = async () => {
    if (taskInFlight || !selectedItem || !selectedIsLeaf || !outlineData?.outline?.length) return;
    try {
      onContentSaved(selectedItem, draftContent);
      setEditingItemId(null);
      setIsPreviewing(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '正文保存失败', 'error');
    }
  };

  const renderTree = (items: OutlineItem[], level = 0) => items.map((item) => {
    const status = sections[item.id]?.status || (item.content?.trim() ? 'success' : 'idle');
    const isLeaf = !item.children?.length;
    return (
      <div className="content-outline-node" key={item.id} style={{ '--content-level': level } as CSSProperties}>
        <button
          type="button"
          className={`content-outline-item is-${status}${selectedItemId === item.id ? ' is-active' : ''}`}
          onClick={() => setSelectedItemId(item.id)}
        >
          <span className="content-outline-dot" aria-hidden="true" />
          <span className="content-outline-text">
            <strong>{item.id} {item.title}</strong>
            <small>{statusLabels(status)}{isLeaf ? ` · ${sections[item.id]?.content?.length || item.content?.length || 0} 字` : ''}</small>
          </span>
        </button>
        {item.children?.length ? renderTree(item.children, level + 1) : null}
      </div>
    );
  });

  if (!outlineData?.outline?.length) {
    return (
      <div className="plan-step-body content-generation-page">
        <section className="markdown-empty-state content-generation-empty">
          <strong>暂无目录</strong>
          <p>请先在目录生成步骤完成商务标目录，再进入正文生成。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="plan-step-body content-generation-page business-content-page">
      <section className="content-generation-command-bar">
        <div>
          <span className="section-kicker">STEP 05</span>
          <strong>正文生成</strong>
          <p>按目录叶子小节并发生成商务标正文，页面切换不会中断后台任务。</p>
        </div>
        <div className="content-generation-stats" aria-label="正文生成统计">
          <span><strong>{leaves.length}</strong> 个小节</span>
          <span><strong>{completedCount}</strong> 已生成</span>
          <span><strong>{progress}%</strong></span>
        </div>
        <div className="content-generation-actions">
          <button type="button" className="outline-config-action" onClick={() => setConfigOpen(true)} disabled={taskInFlight || !leaves.length} aria-label="打开正文生成配置">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 0 1-4 0v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 0 1 0-4h.08A1.7 1.7 0 0 0 4.6 8.93a1.7 1.7 0 0 0-.34-1.87l-.05-.05a2 2 0 0 1 2.83-2.83l.05.05a1.7 1.7 0 0 0 1.87.34A1.7 1.7 0 0 0 10 3.01V3a2 2 0 0 1 4 0v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 0 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z" /></svg>
          </button>
          <button type="button" className="primary-action" onClick={handleGenerationButton} disabled={pausing || !leaves.length}>
            {generationButtonLabel}
          </button>
        </div>
      </section>

      <section className="content-generation-workspace">
        <aside className="content-outline-panel">
          <div className="analysis-result-head">
            <strong>标书目录</strong>
            <span>{leaves.length} 个小节</span>
          </div>
          <div className={`content-outline-stats${progress > 0 && progress < 100 ? ' is-active' : ''}`}>
            <div className="content-generation-progress-track" aria-label={`正文生成进度 ${progress}%`}><span style={{ width: `${progress}%` }} /></div>
            <p>{taskInFlight ? (latestLog || '商务正文生成任务正在运行。') : paused ? '商务正文生成已暂停，可导出当前已完成内容或点击继续。' : completedCount ? `已生成 ${completedCount} 个小节。` : '点击生成正文后，目录会实时显示每个小节状态。'}</p>
          </div>
          <div className="content-outline-list">{renderTree(outlineData.outline)}</div>
        </aside>

        <article className="content-reader-panel">
          <div className="content-reader-head">
            <div>
              <span className="section-kicker">正文内容</span>
              <strong>{selectedItem ? `${selectedItem.id} ${selectedItem.title}` : '选择小节'}</strong>
              <p>{selectedItem?.description || '选择左侧目录项查看生成正文。'}</p>
            </div>
            <div className="content-reader-actions">
              {editing ? (
                <>
                  <button type="button" className="secondary-action" onClick={() => setIsPreviewing((prev) => !prev)}>{isPreviewing ? '编辑' : '预览'}</button>
                  <button type="button" className="primary-action" onClick={saveEditing} disabled={taskInFlight}>保存</button>
                  <button type="button" className="secondary-action" onClick={() => setEditingItemId(null)}>取消</button>
                </>
              ) : (
                <button type="button" className="secondary-action" onClick={startEditing} disabled={!selectedItem || !selectedIsLeaf || taskInFlight}>编辑</button>
              )}
            </div>
          </div>

          {selectedItem && selectedIsLeaf && editing && !isPreviewing ? (
            <MarkdownEditor value={draftContent} onChange={setDraftContent} placeholder="输入 Markdown 正文..." disabled={taskInFlight} />
          ) : selectedItem && selectedIsLeaf && editing && isPreviewing ? (
            <MarkdownFullscreenViewer className="markdown-viewer content-generation-output" title="正文预览全屏查看">
              {draftContent.trim() ? <MarkdownRenderer>{draftContent}</MarkdownRenderer> : <p className="content-editor-empty">暂无预览内容</p>}
            </MarkdownFullscreenViewer>
          ) : selectedItem && selectedIsLeaf && selectedContent.trim() ? (
            <MarkdownFullscreenViewer className="markdown-viewer content-generation-output" title={`${selectedItem.id} ${selectedItem.title}全屏查看`}>
              <MarkdownRenderer>{selectedContent}</MarkdownRenderer>
            </MarkdownFullscreenViewer>
          ) : selectedItem && selectedIsLeaf ? (
            <div className="markdown-empty-state content-generation-empty">
              <strong>{sections[selectedItem.id]?.status === 'error' ? sections[selectedItem.id]?.error || '正文生成失败' : '正文待生成'}</strong>
              <p>{taskInFlight ? '如果该小节正在生成，模型返回内容后会实时显示在这里。' : paused ? '任务已暂停，可先导出当前内容或点击继续。' : '点击生成正文后，后台会按目录小节生成内容。'}</p>
            </div>
          ) : (
            <div className="markdown-empty-state content-generation-empty">
              <strong>当前是目录分组</strong>
              <p>该目录下包含 {selectedItem?.children ? collectLeafItems(selectedItem.children).length : 0} 个小节，请选择叶子小节查看具体正文。</p>
            </div>
          )}
        </article>
      </section>

      <Dialog.Root open={configOpen} onOpenChange={(open) => !open && setConfigOpen(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-generation-config-card" aria-describedby={undefined}>
            <div className="content-regenerate-card-head"><Dialog.Title>正文生成配置</Dialog.Title></div>
            <div className="content-generation-config-list">
              <label className="content-generation-config-row">
                <span><strong>最低字数</strong></span>
                <input
                  type="number"
                  min="0"
                  step="100"
                  value={draftMinWords}
                  onChange={(event) => setDraftMinWords(Math.max(0, Number(event.target.value) || 0))}
                />
              </label>
            </div>
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="primary-action" onClick={() => void launchContentGeneration(completedCount === leaves.length && leaves.length > 0)}>
                {completedCount === leaves.length && leaves.length > 0 ? '重新生成' : '开始生成'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
