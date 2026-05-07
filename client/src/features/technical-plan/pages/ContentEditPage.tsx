import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useToast } from '../../../shared/ui';
import type { OutlineData, OutlineItem } from '../../../shared/types';
import type { BackgroundTaskState, ContentGenerationSectionStatus, ContentGenerationSections } from '../types';

interface ContentEditPageProps {
  outlineData: OutlineData | null;
  projectOverview: string;
  task?: BackgroundTaskState;
  sections: ContentGenerationSections;
  onContentSaved: (item: OutlineItem, content: string) => Promise<void> | void;
}

type TreeStatus = ContentGenerationSectionStatus | 'partial';

const statusLabels: Record<TreeStatus, string> = {
  idle: '待生成',
  running: '生成中',
  success: '已生成',
  error: '失败',
  partial: '部分生成',
};

function collectLeafItems(items: OutlineItem[]): OutlineItem[] {
  return items.flatMap((item) => item.children?.length ? collectLeafItems(item.children) : [item]);
}

function findItem(items: OutlineItem[], id: string): OutlineItem | null {
  for (const item of items) {
    if (item.id === id) {
      return item;
    }

    if (item.children?.length) {
      const found = findItem(item.children, id);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function countWords(content: string) {
  return content.replace(/\s+/g, '').length;
}

function getLeafContent(item: OutlineItem, sections: ContentGenerationSections) {
  return sections[item.id]?.content || item.content || '';
}

function getLeafStatus(item: OutlineItem, sections: ContentGenerationSections): ContentGenerationSectionStatus {
  const section = sections[item.id];
  if (section?.status) {
    return section.status;
  }

  return getLeafContent(item, sections).trim() ? 'success' : 'idle';
}

function getTreeStatus(item: OutlineItem, sections: ContentGenerationSections): TreeStatus {
  if (!item.children?.length) {
    return getLeafStatus(item, sections);
  }

  const childStatuses = item.children.map((child) => getTreeStatus(child, sections));
  if (childStatuses.some((status) => status === 'running')) {
    return 'running';
  }
  if (childStatuses.every((status) => status === 'success')) {
    return 'success';
  }
  if (childStatuses.some((status) => status === 'error')) {
    return 'error';
  }
  if (childStatuses.some((status) => status === 'success' || status === 'partial')) {
    return 'partial';
  }

  return 'idle';
}

function ContentEditPage({ outlineData, projectOverview, task, sections, onContentSaved }: ContentEditPageProps) {
  const { showToast } = useToast();
  const leaves = useMemo(() => outlineData?.outline ? collectLeafItems(outlineData.outline) : [], [outlineData]);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [draftContent, setDraftContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const firstLeafId = leaves[0]?.id || '';
  const selectedItem = outlineData?.outline && selectedItemId ? findItem(outlineData.outline, selectedItemId) : null;
  const selectedIsLeaf = Boolean(selectedItem && !selectedItem.children?.length);
  const selectedContent = selectedItem && selectedIsLeaf ? getLeafContent(selectedItem, sections) : '';
  const selectedStatus = selectedItem ? getTreeStatus(selectedItem, sections) : 'idle';
  const running = task?.status === 'running';
  const completedCount = leaves.filter((item) => getLeafStatus(item, sections) === 'success').length;
  const failedCount = leaves.filter((item) => getLeafStatus(item, sections) === 'error').length;
  const totalWords = leaves.reduce((sum, item) => sum + countWords(getLeafContent(item, sections)), 0);
  const progress = leaves.length ? Math.round((completedCount / leaves.length) * 100) : 0;
  const editing = Boolean(selectedItem && selectedIsLeaf && editingItemId === selectedItem.id);

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
    if (!selectedItem || selectedItem.id === editingItemId) {
      return;
    }
    setEditingItemId(null);
    setIsPreviewing(false);
    setDraftContent('');
  }, [editingItemId, selectedItem]);

  const startGeneration = async () => {
    if (!outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }

    try {
      const regenerate = leaves.length > 0 && completedCount === leaves.length;
      await window.yibiao?.tasks.startContentGeneration({
        outlineData,
        projectOverview: outlineData.project_overview || projectOverview,
        regenerate,
      });
      showToast(regenerate ? '正文重新生成任务已在后台启动' : '正文生成任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动正文生成任务失败', 'error');
    }
  };

  const startEditingContent = () => {
    if (!selectedItem || !selectedIsLeaf) {
      showToast('请选择一个叶子小节后再编辑正文', 'info');
      return;
    }

    setEditingItemId(selectedItem.id);
    setIsPreviewing(false);
    setDraftContent(selectedContent);
  };

  const togglePreview = () => {
    setIsPreviewing((prev) => !prev);
  };

  const cancelEditingContent = () => {
    setEditingItemId(null);
    setIsPreviewing(false);
    setDraftContent('');
  };

  const saveEditingContent = async () => {
    if (!selectedItem || !selectedIsLeaf || !outlineData?.outline?.length) {
      return;
    }

    try {
      await onContentSaved(selectedItem, draftContent);
      setEditingItemId(null);
      setIsPreviewing(false);
      showToast('正文已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '正文保存失败', 'error');
    }
  };

  const insertMarkdown = (prefix: string, suffix = '') => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const scrollTop = textarea.scrollTop;
    const selected = draftContent.slice(start, end) || '文本';
    const next = draftContent.slice(0, start) + prefix + selected + suffix + draftContent.slice(end);
    setDraftContent(next);

    requestAnimationFrame(() => {
      textarea.focus();
      textarea.scrollTop = scrollTop;
      textarea.selectionStart = start + prefix.length;
      textarea.selectionEnd = start + prefix.length + selected.length;
    });
  };

  const renderTree = (items: OutlineItem[], level = 0): ReactNode => items.map((item) => {
    const status = getTreeStatus(item, sections);
    const isLeaf = !item.children?.length;
    const leafCount = isLeaf ? 1 : collectLeafItems(item.children || []).length;
    const words = isLeaf ? countWords(getLeafContent(item, sections)) : collectLeafItems(item.children || []).reduce((sum, leaf) => sum + countWords(getLeafContent(leaf, sections)), 0);

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
            <small>{isLeaf ? `${statusLabels[status]} · ${words} 字` : `${statusLabels[status]} · ${leafCount} 个小节 · ${words} 字`}</small>
          </span>
          <em>{statusLabels[status]}</em>
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
          <p>请先在目录生成步骤完成技术方案目录，再进入正文生成。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="plan-step-body content-generation-page">
      <section className="content-generation-command-bar">
        <div>
          <span className="section-kicker">STEP 04</span>
          <strong>正文生成</strong>
          <p>按目录叶子小节并发生成技术方案正文，页面切换不会中断后台任务。</p>
        </div>
        <div className="content-generation-stats" aria-label="正文生成统计">
          <span><strong>{leaves.length}</strong> 个小节</span>
          <span><strong>{completedCount}</strong> 已生成</span>
          <span><strong>{totalWords}</strong> 字</span>
        </div>
        <button type="button" className="primary-action" onClick={startGeneration} disabled={running || !leaves.length}>
          {running ? '正文生成中...' : completedCount === leaves.length && leaves.length ? '重新生成正文' : completedCount > 0 ? '继续生成正文' : '生成正文'}
        </button>
      </section>

      <section className="content-generation-progress-card">
        <div className="analysis-result-head">
          <strong>生成统计</strong>
          <span>{completedCount}/{leaves.length} 小节{failedCount ? `，失败 ${failedCount} 个` : ''}</span>
        </div>
        <div className="content-generation-progress-track" aria-label={`正文生成进度 ${progress}%`}>
          <span style={{ width: `${progress}%` }} />
        </div>
        <p>{running ? task?.logs?.[task.logs.length - 1] || '正文生成任务正在运行。' : completedCount ? '已生成的正文会自动写入当前目录结构，可直接导出 Word。' : '点击生成正文后，左侧目录树会实时显示每个小节的生成状态。'}</p>
      </section>

      <section className="content-generation-workspace">
        <aside className="content-outline-panel">
          <div className="analysis-result-head">
            <strong>目录树</strong>
            <span>{leaves.length} 个小节</span>
          </div>
          <div className="content-outline-list">
            {renderTree(outlineData.outline)}
          </div>
        </aside>

        <article className="content-reader-panel">
          <div className="content-reader-head">
            <div>
              <span className="section-kicker">正文内容</span>
              <strong>{selectedItem ? `${selectedItem.id} ${selectedItem.title}` : '选择小节'}</strong>
              <p>{selectedItem?.description || '选择左侧目录项查看生成正文。'}</p>
            </div>
            <div className="content-reader-actions">
              <span className={`content-status-badge is-${selectedStatus}`}>{statusLabels[selectedStatus]}</span>
              {editing ? (
                <>
                  <button type="button" className={isPreviewing ? 'secondary-action' : 'primary-action'} onClick={togglePreview}>
                    {isPreviewing ? '编辑' : '预览'}
                  </button>
                  <button type="button" className="primary-action" onClick={saveEditingContent}>保存</button>
                  <button type="button" className="secondary-action" onClick={cancelEditingContent}>取消</button>
                </>
              ) : (
                <button type="button" className="secondary-action" onClick={startEditingContent} disabled={!selectedItem || !selectedIsLeaf || running}>编辑</button>
              )}
            </div>
          </div>

          {selectedItem && selectedIsLeaf && editing && !isPreviewing ? (
            <div className="content-editor-shell">
              <div className="content-editor-toolbar">
                <button type="button" onClick={() => insertMarkdown('**', '**')} title="加粗"><strong>B</strong></button>
                <button type="button" onClick={() => insertMarkdown('*', '*')} title="斜体"><em>I</em></button>
                <button type="button" onClick={() => insertMarkdown('## ')} title="标题">H</button>
                <button type="button" onClick={() => insertMarkdown('> ')} title="引用">❝</button>
                <button type="button" onClick={() => insertMarkdown('- ')} title="无序列表">•</button>
                <button type="button" onClick={() => insertMarkdown('1. ')} title="有序列表">1.</button>
              </div>
              <textarea
                ref={textareaRef}
                className="content-editor-textarea"
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
                placeholder="输入 Markdown 正文..."
              />
            </div>
          ) : selectedItem && selectedIsLeaf && editing && isPreviewing ? (
            <div className="markdown-viewer content-generation-output">
              {draftContent.trim() ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {draftContent}
                </ReactMarkdown>
              ) : (
                <p className="content-editor-empty">暂无预览内容</p>
              )}
            </div>
          ) : selectedItem && selectedIsLeaf && selectedContent.trim() ? (
            <div className="markdown-viewer content-generation-output">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {selectedContent}
              </ReactMarkdown>
            </div>
          ) : selectedItem && selectedIsLeaf ? (
            <div className="markdown-empty-state content-generation-empty">
              <strong>{getLeafStatus(selectedItem, sections) === 'error' ? sections[selectedItem.id]?.error || '正文生成失败' : '正文待生成'}</strong>
              <p>{running ? '如果该小节正在生成，模型返回内容后会实时显示在这里。' : '点击生成正文后，后台会按目录小节生成内容。'}</p>
            </div>
          ) : (
            <div className="markdown-empty-state content-generation-empty">
              <strong>当前是目录分组</strong>
              <p>该目录下包含 {selectedItem?.children ? collectLeafItems(selectedItem.children).length : 0} 个小节，请选择叶子小节查看具体正文。</p>
            </div>
          )}
        </article>
      </section>
    </div>
  );
}

export default ContentEditPage;
