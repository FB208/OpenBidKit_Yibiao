import { useCallback, useEffect, useMemo, useState } from 'react';
import { MarkdownEditor, MarkdownRenderer, useToast } from '../../../shared/ui';
import type { OutlineData } from '../../../shared/types';
import type { BackgroundTaskState, GlobalFactGroupState } from '../types';

interface GlobalFactsPageProps {
  outlineData: OutlineData | null;
  globalFacts: GlobalFactGroupState[];
  task?: BackgroundTaskState;
  onGlobalFactsSaved: (globalFacts: GlobalFactGroupState[]) => Promise<void> | void;
}

const statusLabels: Record<string, string> = {
  idle: '未开始',
  running: '生成中',
  success: '已完成',
  error: '失败',
};

function createFactId() {
  const randomId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `manual_${randomId.replace(/[^a-zA-Z0-9_-]/g, '_')}`.toLowerCase();
}

function formatUpdatedAt(value?: string) {
  if (!value) return '';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function getProgress(task: BackgroundTaskState | undefined, hasFacts: boolean) {
  if (task?.status === 'running') return Math.max(5, Math.min(99, task.progress || 5));
  if (task?.status === 'error') return Math.max(0, Math.min(99, task.progress || 0));
  return hasFacts ? 100 : 0;
}

function GlobalFactsPage({ outlineData, globalFacts, task, onGlobalFactsSaved }: GlobalFactsPageProps) {
  const { showToast } = useToast();
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(globalFacts[0]?.id || null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progressCollapsed, setProgressCollapsed] = useState(false);
  const hasOutline = Boolean(outlineData?.outline?.length);
  const running = starting || task?.status === 'running';
  const taskFailed = task?.status === 'error';
  const activeGroup = globalFacts.find((group) => group.id === selectedGroupId) || globalFacts[0] || null;
  const progress = getProgress(task, globalFacts.length > 0);
  const statusKey = running ? 'running' : taskFailed ? 'error' : globalFacts.length ? 'success' : 'idle';
  const latestLog = task?.logs?.[task.logs.length - 1] || '';
  const totalChars = useMemo(() => globalFacts.reduce((sum, group) => sum + group.content.length, 0), [globalFacts]);
  const dirty = Boolean(activeGroup && (draftTitle !== activeGroup.title || draftContent !== activeGroup.content));

  const startGeneration = useCallback(async () => {
    if (!hasOutline) {
      showToast('请先生成目录，再进行全局事实设定', 'info');
      return;
    }

    try {
      setStarting(true);
      await window.yibiao?.tasks.startGlobalFactsGeneration({});
      showToast('全局事实设定任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动全局事实设定失败', 'error');
    } finally {
      setStarting(false);
    }
  }, [hasOutline, showToast]);

  useEffect(() => {
    if (!globalFacts.length) {
      setSelectedGroupId(null);
      return;
    }

    setSelectedGroupId((prev) => globalFacts.some((group) => group.id === prev) ? prev : globalFacts[0].id);
  }, [globalFacts]);

  useEffect(() => {
    if (!activeGroup) {
      setDraftTitle('');
      setDraftContent('');
      return;
    }

    setDraftTitle(activeGroup.title);
    setDraftContent(activeGroup.content);
  }, [activeGroup?.id, activeGroup?.title, activeGroup?.content]);

  const saveFacts = async (nextFacts: GlobalFactGroupState[], message = '全局事实已保存') => {
    try {
      setSaving(true);
      await onGlobalFactsSaved(nextFacts);
      showToast(message, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存全局事实失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveActiveGroup = async () => {
    if (!activeGroup) return;
    const title = draftTitle.trim();
    const content = draftContent.trim();
    if (!title || !content) {
      showToast('标题和内容不能为空', 'info');
      return;
    }

    await saveFacts(globalFacts.map((group) => (
      group.id === activeGroup.id
        ? { ...group, title, content, updated_at: new Date().toISOString() }
        : group
    )));
  };

  const addFactGroup = async () => {
    const nextGroup: GlobalFactGroupState = {
      id: createFactId(),
      title: '新增事实大项',
      content: '- 项目经理：张伟，高级工程师，负责总体协调和质量把关。',
      updated_at: new Date().toISOString(),
    };
    await saveFacts([...globalFacts, nextGroup], '已新增事实大项');
    setSelectedGroupId(nextGroup.id);
  };

  const deleteActiveGroup = async () => {
    if (!activeGroup) return;
    await saveFacts(globalFacts.filter((group) => group.id !== activeGroup.id), '已删除事实大项');
  };

  const copyActiveGroup = async () => {
    if (!draftContent.trim()) {
      showToast('当前没有可复制的内容', 'info');
      return;
    }
    await navigator.clipboard.writeText(draftContent);
    showToast('全局事实内容已复制', 'success');
  };

  return (
    <div className="plan-step-body global-facts-page">
      <section className="global-facts-command-bar">
        <div>
          <span className="section-kicker">STEP 04</span>
          <strong>全局事实设定</strong>
          <p>基于目录提前预设正文会反复用到的事实变量，避免各小节随机生成人员、时间、型号等内容。</p>
        </div>
        <div className="global-facts-stats">
          <span><strong>{globalFacts.length}</strong> 个大项</span>
          <span><strong>{totalChars}</strong> 字</span>
        </div>
        <button type="button" className="primary-action" onClick={() => startGeneration()} disabled={running || !hasOutline}>
          {running ? '生成中...' : globalFacts.length ? '重新解析' : '开始解析'}
        </button>
      </section>

      <section className="global-facts-workspace">
        <aside className="global-facts-panel" aria-label="全局事实大项列表">
          <div className="analysis-result-head global-facts-panel-head">
            <strong>事实大项</strong>
            <span className={`content-status-badge is-${statusKey}`}>{statusLabels[statusKey]}</span>
          </div>
          <div className={`content-outline-stats global-facts-progress${progressCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setProgressCollapsed((prev) => !prev)} aria-expanded={!progressCollapsed}>
              <span>设定进度</span>
              <strong>{progress}%</strong>
              <em>{progressCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!progressCollapsed && (
              <div className="content-outline-stats-body">
                <div className={`content-generation-progress-track${running ? ' is-active' : ''}`} aria-label={`全局事实设定进度 ${progress}%`}>
                  <span style={{ width: `${progress}%` }} />
                </div>
                <p>{taskFailed ? task?.error || latestLog || '全局事实设定失败，请重新解析。' : latestLog || '点击“开始解析”后，后台会生成全局事实变量。'}</p>
                {taskFailed && <small>失败后不会自动重试，可点击“重新解析”。</small>}
              </div>
            )}
          </div>
          <div className="global-facts-list">
            {globalFacts.length ? globalFacts.map((group) => (
              <button
                type="button"
                className={`global-facts-item${group.id === activeGroup?.id ? ' is-active' : ''}`}
                key={group.id}
                onClick={() => setSelectedGroupId(group.id)}
              >
                <strong>{group.title}</strong>
                <small>{group.content.length} 字{group.updated_at ? ` · ${formatUpdatedAt(group.updated_at)}` : ''}</small>
              </button>
            )) : (
              <div className="global-facts-empty-list">
                <strong>{running ? '正在生成全局事实' : '暂无全局事实'}</strong>
                <p>{hasOutline ? '点击“开始解析”后，等待后台任务返回事实大项。' : '请先完成目录生成。'}</p>
              </div>
            )}
          </div>
          <div className="global-facts-panel-actions">
            <button type="button" className="secondary-action" onClick={addFactGroup} disabled={running || saving}>新增大项</button>
          </div>
        </aside>

        <article className="global-facts-reader">
          <div className="global-facts-reader-head">
            <div>
              <span className="section-kicker">事实内容</span>
              <strong>{activeGroup?.title || '等待全局事实'}</strong>
              <p>{activeGroup ? '可直接编辑事实变量；保存后会清空旧正文生成缓存，避免继续使用旧内容。' : '全局事实生成完成后，可在这里查看和编辑。'}</p>
            </div>
            <div className="global-facts-reader-actions">
              <button type="button" className="secondary-action" onClick={copyActiveGroup} disabled={!activeGroup || !draftContent}>复制</button>
              <button type="button" className="danger-action" onClick={deleteActiveGroup} disabled={!activeGroup || running || saving}>删除</button>
              <button type="button" className="primary-action" onClick={saveActiveGroup} disabled={!activeGroup || !dirty || running || saving}>保存</button>
            </div>
          </div>

          {activeGroup ? (
            <div className="global-facts-editor-grid">
              <div className="global-facts-edit-pane">
                <label>
                  <span>大项标题</span>
                  <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} disabled={running || saving} />
                </label>
                <MarkdownEditor
                  value={draftContent}
                  onChange={setDraftContent}
                  disabled={running || saving}
                  placeholder="填写后续正文需要统一使用的事实变量，例如人员、时间、型号、服务承诺等..."
                />
              </div>
              <div className="global-facts-preview-pane markdown-viewer">
                {draftContent.trim() ? (
                  <MarkdownRenderer allowRawHtml={false}>{draftContent}</MarkdownRenderer>
                ) : (
                  <p className="content-editor-empty">暂无预览内容</p>
                )}
              </div>
            </div>
          ) : (
            <div className="markdown-empty-state global-facts-empty">
              <strong>{hasOutline ? '等待全局事实生成' : '请先生成目录'}</strong>
              <p>{hasOutline ? '点击“开始解析”后，AI 会基于目录提前生成正文可能反复用到的短小事实变量。' : '目录生成完成后，点击“开始解析”生成全局事实。'}</p>
            </div>
          )}
        </article>
      </section>
    </div>
  );
}

export default GlobalFactsPage;
