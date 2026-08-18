import { useEffect, useRef, useState } from 'react';
import { MarkdownEditor, MarkdownFullscreenViewer, MarkdownRenderer, ProgressBar, useToast } from '../../../shared/ui';
import type { FeasibilityBackgroundTaskState } from '../types';

interface ParametersPageProps {
  keyParametersMarkdown: string;
  task?: FeasibilityBackgroundTaskState;
  running: boolean;
  saving: boolean;
  dirty: boolean;
  hasOutline: boolean;
  onChange: (value: string) => void;
  onSave: () => Promise<void>;
  onStart: () => Promise<void>;
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function ParametersPage({
  keyParametersMarkdown,
  task,
  running,
  saving,
  dirty,
  hasOutline,
  onChange,
  onSave,
  onStart,
}: ParametersPageProps) {
  const { showToast } = useToast();
  const [progressCollapsed, setProgressCollapsed] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const logListRef = useRef<HTMLDivElement | null>(null);
  const progressLogs = task?.logs || [];
  const latestLog = progressLogs[progressLogs.length - 1] || '';
  const failed = task?.status === 'error';
  const hasContent = Boolean(keyParametersMarkdown.trim());
  const progress = running
    ? Math.max(5, Math.min(99, Number(task?.progress || 0) || 5))
    : failed
      ? Math.max(0, Math.min(99, Number(task?.progress || 0) || 0))
      : hasContent || task?.status === 'success'
        ? 100
        : 0;
  const statusMessage = failed
    ? task?.error || latestLog || '生成失败，请重试。'
    : latestLog || (hasOutline ? '点击“生成关键参数”后，后台会整理编制口径。' : '请先完成报告目录。');
  const startedAt = task?.started_at ? Date.parse(task.started_at) : NaN;
  const updatedAt = task?.updated_at ? Date.parse(task.updated_at) : NaN;
  const elapsedText = running && Number.isFinite(startedAt) ? `已运行 ${formatDuration(nowTick - startedAt)}` : '';
  const staleText = running && Number.isFinite(updatedAt) ? `最近更新 ${Math.floor(Math.max(0, nowTick - updatedAt) / 1000)} 秒前` : '';

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

  const copyParameters = async () => {
    if (!keyParametersMarkdown.trim()) {
      showToast('当前没有可复制的内容', 'info');
      return;
    }
    await navigator.clipboard.writeText(keyParametersMarkdown);
    showToast('关键参数内容已复制', 'success');
  };

  return (
    <div className="plan-step-body global-facts-page">
      <section className="global-facts-command-bar">
        <div>
          <span className="section-kicker">STEP 05</span>
          <strong>关键参数</strong>
          <p>请重点核对“【待补充】”和“【待确认】”。保存修改后，旧正文会被清空以避免使用过期参数。本步骤不自动计算 NPV、IRR、回收期。</p>
        </div>
        <div className="global-facts-command-actions">
          <button type="button" className="primary-action" onClick={() => { void onStart(); }} disabled={running || !hasOutline}>
            {running ? '生成中...' : hasContent ? '重新生成' : '生成关键参数'}
          </button>
        </div>
      </section>

      <section className="global-facts-workspace feasibility-markdown-workspace">
        <aside className="outline-progress-panel">
          <div className="analysis-result-head">
            <strong>生成过程</strong>
            <span>{running ? '进行中' : failed ? '失败' : hasContent ? '已完成' : '等待开始'}</span>
          </div>
          <div className={`content-outline-stats outline-progress-summary${progressCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setProgressCollapsed((prev) => !prev)} aria-expanded={!progressCollapsed}>
              <span>生成进度</span>
              <strong>{progress}%</strong>
              <em>{progressCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!progressCollapsed && (
              <div className="content-outline-stats-body">
                <ProgressBar value={progress} active={running} label={`关键参数进度 ${progress}%`} />
                <p>{statusMessage}</p>
                {(elapsedText || staleText) && (
                  <div className="outline-progress-meta">
                    {elapsedText && <span>{elapsedText}</span>}
                    {staleText && <span>{staleText}</span>}
                  </div>
                )}
                {failed && <small>{task?.error || latestLog || '生成失败，请重试。'}</small>}
              </div>
            )}
          </div>
          <div className="outline-progress-log" ref={logListRef}>
            {progressLogs.length ? progressLogs.map((item, index) => (
              <p className={index === progressLogs.length - 1 ? 'is-latest' : ''} key={`${item}-${index}`}>{item}</p>
            )) : <p>等待生成任务启动。</p>}
          </div>
        </aside>

        <article className="global-facts-reader">
          <div className="global-facts-reader-head">
            <div>
              <span className="section-kicker">编制口径</span>
              <strong>关键参数</strong>
              <p>可直接编辑。请重点核对“【待补充】”和“【待确认】”。保存修改后，旧正文会被清空。</p>
            </div>
            <div className="global-facts-reader-actions">
              <button type="button" className="secondary-action" onClick={() => { void copyParameters(); }} disabled={!hasContent}>复制</button>
              <button
                type="button"
                className="primary-action"
                onClick={() => { void onSave(); }}
                disabled={!dirty || running || saving || !hasContent}
              >
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>

          {hasContent ? (
            <div className="global-facts-editor-grid">
              <div className="global-facts-edit-pane feasibility-analysis-edit-pane">
                <MarkdownEditor
                  value={keyParametersMarkdown}
                  onChange={onChange}
                  disabled={running || saving}
                  placeholder="生成后可在这里核对关键参数与编制口径。"
                  fullscreenTitle="编辑关键参数"
                />
              </div>
              <MarkdownFullscreenViewer className="global-facts-preview-pane markdown-viewer" title="关键参数全屏预览">
                <MarkdownRenderer allowRawHtml={false}>{keyParametersMarkdown}</MarkdownRenderer>
              </MarkdownFullscreenViewer>
            </div>
          ) : (
            <div className="markdown-empty-state global-facts-empty">
              <strong>等待关键参数</strong>
              <p>{hasOutline ? '点击“生成关键参数”后，后台会整理编制口径。' : '请先完成报告目录。'}</p>
            </div>
          )}
        </article>
      </section>
    </div>
  );
}

export default ParametersPage;
