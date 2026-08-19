import { useEffect, useRef } from 'react';
import { MarkdownEditor, MarkdownFullscreenViewer, MarkdownRenderer, ProgressBar, useToast } from '../../../shared/ui';
import type { FeasibilityBackgroundTaskState } from '../types';

interface AnalysisPageProps {
  analysisMarkdown: string;
  task?: FeasibilityBackgroundTaskState;
  running: boolean;
  saving: boolean;
  dirty: boolean;
  onChange: (value: string) => void;
  onSave: () => Promise<void>;
  onStart: () => Promise<void>;
}

function AnalysisPage({ analysisMarkdown, task, running, saving, dirty, onChange, onSave, onStart }: AnalysisPageProps) {
  const { showToast } = useToast();
  const progress = Number(task?.progress || 0);
  const progressLogs = task?.logs || [];
  const latestLog = progressLogs[progressLogs.length - 1] || '';
  const failed = task?.status === 'error';
  const hasContent = Boolean(analysisMarkdown.trim());
  const logListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (logListRef.current) {
      logListRef.current.scrollTop = logListRef.current.scrollHeight;
    }
  }, [progressLogs.length]);

  const copyAnalysis = async () => {
    if (!analysisMarkdown.trim()) {
      showToast('当前没有可复制的内容', 'info');
      return;
    }
    await navigator.clipboard.writeText(analysisMarkdown);
    showToast('资料分析内容已复制', 'success');
  };

  return (
    <div className="plan-step-body global-facts-page">
      <section className="global-facts-command-bar">
        <div>
          <span className="section-kicker">STEP 03</span>
          <strong>资料分析</strong>
          <p>后台会按九个板块提取事实；无附件时按项目参数分析。</p>
        </div>
        <div className="global-facts-command-actions">
          <button type="button" className="primary-action" onClick={() => { void onStart(); }} disabled={running}>
            {running ? '分析中...' : hasContent ? '重新分析' : '开始分析'}
          </button>
        </div>
      </section>

      <section className="global-facts-workspace feasibility-markdown-workspace">
        <aside className="outline-progress-panel">
          <div className="analysis-result-head">
            <strong>生成过程</strong>
            <span>{running ? '进行中' : failed ? '失败' : hasContent ? '已完成' : '等待开始'}</span>
          </div>
          <div className="content-outline-stats">
            <ProgressBar value={progress} active={running} label={`资料分析进度 ${progress}%`} />
            <p>{failed ? task?.error || latestLog || '分析失败，请重试。' : latestLog || '点击“开始分析”后，后台会提取项目事实。'}</p>
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
              <span className="section-kicker">分析结果</span>
              <strong>资料事实</strong>
              <p>可直接编辑；保存后会清空后续目录、关键参数和正文。</p>
            </div>
            <div className="global-facts-reader-actions">
              <button type="button" className="secondary-action" onClick={() => { void copyAnalysis(); }} disabled={!hasContent}>复制</button>
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
                  value={analysisMarkdown}
                  onChange={onChange}
                  disabled={running || saving}
                  placeholder="分析完成后可在这里编辑事实摘要。"
                  fullscreenTitle="编辑资料分析"
                />
              </div>
              <MarkdownFullscreenViewer className="global-facts-preview-pane markdown-viewer" title="资料分析全屏预览">
                <MarkdownRenderer allowRawHtml={false}>{analysisMarkdown}</MarkdownRenderer>
              </MarkdownFullscreenViewer>
            </div>
          ) : (
            <div className="markdown-empty-state global-facts-empty">
              <strong>等待资料分析</strong>
              <p>点击“开始分析”后，后台会提取项目事实。</p>
            </div>
          )}
        </article>
      </section>
    </div>
  );
}

export default AnalysisPage;
