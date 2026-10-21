import { useEffect, useMemo, useRef, useState } from 'react';
import { MagicWandIcon } from '@radix-ui/react-icons';
import { AppSwitch, ProgressBar } from '../../../shared/ui';
import { fixGroups } from '../fixItems';
import type { BlindCheckFixResultState, BlindCheckTaskState } from '../types';
import { severityLabels } from './FindingGroupList';
import FixItemList from './FixItemList';
import { StepHeader, StepTabs, type StepTab } from './StepLayout';

type FixTab = 'items' | 'result';

interface FixPanelProps {
  fixRules: string[];
  /** 最终问题清单里每条规则的处数。 */
  currentCounts: Record<string, number>;
  fixResult: BlindCheckFixResultState;
  fixTask?: BlindCheckTaskState;
  running: boolean;
  /** 当前文件和预设已有成功的检查结果。 */
  checkReady: boolean;
  /** 修复结果对应的检查条件已变化。 */
  stale: boolean;
  busy: boolean;
  /** 当前检查条件的 AI 复核已完成，修复时可续接复核会话。 */
  reviewReady: boolean;
  onToggle: (ruleId: string, enabled: boolean) => void;
  onStart: () => void;
}

/**
 * 第四步自动修复：与格式要求、检查结果同样是标题卡 + 页签 + 内容卡片。
 * 页签是修复项和修复结果；修复结果只列本次修复范围内的问题和修复后新出现的问题，每处只有已修复、待人工处理两种状态。
 */
export default function FixPanel({ fixRules, currentCounts, fixResult, fixTask, running, checkReady, stale, busy, reviewReady, onToggle, onStart }: FixPanelProps) {
  const selected = useMemo(() => new Set(fixRules), [fixRules]);
  const showResult = !running && fixResult.status === 'success' && !stale;
  const [tab, setTab] = useState<FixTab>(() => (running || showResult ? 'result' : 'items'));
  const items = fixResult.items || [];
  const fixedCount = items.reduce((sum, item) => sum + item.fixed, 0);
  const pendingCount = items.reduce((sum, item) => sum + item.pending, 0);
  const canStart = checkReady && !running && !busy && (fixRules.length > 0 || reviewReady);

  // 修复任务在写入修复结果前就失败（启动校验不通过、数据库异常等）时，错误只记在任务上，这里单独显示。
  const startError = !running && fixTask?.status === 'error' && fixResult.status !== 'error'
    && (!fixResult.updatedAt || Date.parse(fixTask.updated_at) > Date.parse(fixResult.updatedAt))
    ? fixTask.error || '启动修复失败'
    : '';

  // 开始修复后切到修复结果，看进度和结果；本次打开页面后新启动的任务失败时也切过去看原因。
  const initialTaskRef = useRef(fixTask?.task_id);
  useEffect(() => {
    if (running || (startError && fixTask?.task_id !== initialTaskRef.current)) setTab('result');
  }, [running, startError, fixTask?.task_id]);

  const resultTabSummary = (): Pick<StepTab<FixTab>, 'summary' | 'warning'> => {
    if (running) return { summary: '修复中...' };
    if (startError || (fixResult.status === 'error' && !stale)) return { summary: '修复失败', warning: true };
    if (fixResult.status === 'success' && stale) return { summary: '已失效，请重新修复', warning: true };
    if (!showResult) return { summary: '未修复' };
    return { summary: `已修复 ${fixedCount} 处 · 待人工 ${pendingCount} 处`, warning: pendingCount > 0 };
  };

  const tabs: StepTab<FixTab>[] = [
    { id: 'items', label: '修复项', summary: `已开启 ${fixRules.length} 项` },
    { id: 'result', label: '修复结果', ...resultTabSummary() },
  ];

  const renderItems = () => (
    <>
      {!checkReady && !running && (
        <div className="blind-check-readonly-note">请先在「检查结果」完成当前文件和格式预设的检查，再进行修复。</div>
      )}
      <div className="blind-check-preset-editor">
        {fixGroups.map((group) => (
          <section className="blind-check-preset-section" key={group.id}>
            <div className="blind-check-preset-section-head">
              <strong>{group.title}</strong>
              <small>{group.description}</small>
            </div>
            <div className="content-generation-config-list">
              {group.items.map((item) => {
                const count = currentCounts[item.ruleId] || 0;
                return (
                  <div className="content-generation-config-row" key={item.ruleId}>
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.hint}</small>
                    </span>
                    <div className="blind-check-fix-control">
                      <em className={count ? 'has-issues' : ''}>{count ? `当前 ${count} 处` : '未发现'}</em>
                      <AppSwitch checked={selected.has(item.ruleId)} disabled={running || busy} onCheckedChange={(checked) => onToggle(item.ruleId, checked)} aria-label={item.label} />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </>
  );

  const renderResult = () => (
    <>
      {startError && (
        <div className="blind-check-rule-errors">
          <strong>修复没有启动成功</strong>
          <pre className="blind-check-error">{startError}</pre>
        </div>
      )}
      {renderResultBody()}
    </>
  );

  const renderResultBody = () => {
    if (running) {
      const progress = Math.max(0, Math.min(100, fixTask?.progress ?? 0));
      return (
        <div className="blind-check-running">
          <span className="section-kicker">暗标自动修复</span>
          <h3>正在修复文档</h3>
          <p>{fixTask?.logs?.at(-1) || '正在准备修复。'}</p>
          <ProgressBar value={progress} label={`暗标自动修复进度 ${progress}%`} />
        </div>
      );
    }
    if (fixResult.status === 'error' && !stale) {
      return (
        <div className="markdown-empty-state rejection-finding-empty is-error">
          <strong>修复失败</strong>
          <pre className="blind-check-error">{fixResult.error || '暗标自动修复失败，原文件未改动，请重新修复。'}</pre>
        </div>
      );
    }
    if (fixResult.status === 'success' && stale) {
      return <div className="blind-check-readonly-note">文件、格式预设或敏感词已变化，之前的修复结果已失效，请重新检查后再修复。</div>;
    }
    if (!showResult) {
      if (startError) return null;
      return (
        <div className="markdown-empty-state rejection-finding-empty">
          <strong>还没有修复结果</strong>
          <p>在「修复项」里选好要修复的内容，再点「开始修复」。</p>
        </div>
      );
    }
    return (
      <>
        <div className="blind-check-summary-cards">
          {(['high', 'medium', 'low'] as const).map((severity) => (
            <article className={`is-${severity}`} key={severity}>
              <span>{severityLabels[severity]}</span>
              <strong>
                {`${fixResult.beforeSummary?.[severity] ?? 0} → ${fixResult.afterSummary?.[severity] ?? 0}`}
                <small>处</small>
              </strong>
            </article>
          ))}
        </div>
        {items.length > 0 ? <FixItemList items={items} /> : (
          <div className="markdown-empty-state rejection-finding-empty">
            <strong>没有需要修复的问题</strong>
          </div>
        )}
      </>
    );
  };

  return (
    <>
      <StepHeader kicker="STEP 04" title="自动修复">
        <button type="button" className="primary-action" onClick={onStart} disabled={!canStart}>
          <MagicWandIcon />
          {running ? '修复中...' : fixResult.status === 'success' && !stale ? '重新修复' : '开始修复'}
        </button>
      </StepHeader>

      <StepTabs label="自动修复" panelId="blind-check-fix-panel" active={tab} onSelect={setTab} tabs={tabs} />

      <section className="blind-check-step-panel" role="tabpanel" id="blind-check-fix-panel" aria-labelledby={`blind-check-fix-panel-tab-${tab}`}>
        {tab === 'items' ? renderItems() : renderResult()}
      </section>
    </>
  );
}
