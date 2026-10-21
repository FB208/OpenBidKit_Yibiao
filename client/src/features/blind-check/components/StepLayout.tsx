import type { ReactNode } from 'react';

/** 格式要求、检查结果、自动修复三步共用的页面结构：标题卡 + 页签条 + 内容卡片。 */

export function StepHeader({ kicker, title, children }: { kicker: string; title: string; children?: ReactNode }) {
  return (
    <section className="rejection-result-command-bar blind-check-step-bar">
      <div>
        <span className="section-kicker">{kicker}</span>
        <strong>{title}</strong>
      </div>
      <div className="blind-check-step-toolbar">{children}</div>
    </section>
  );
}

export interface StepTab<T extends string> {
  id: T;
  label: string;
  /** 页签第二行的摘要 */
  summary: string;
  /** 有需要处理的内容时摘要显示警示色 */
  warning?: boolean;
}

/** 页签条：名称 + 摘要两行，页签放不下时横向滚动。panelId 是对应内容卡片的 id。 */
export function StepTabs<T extends string>({ tabs, active, onSelect, label, panelId }: {
  tabs: StepTab<T>[];
  active: T;
  onSelect: (id: T) => void;
  label: string;
  panelId: string;
}) {
  return (
    <div className="document-switch-tabs generation-settings-tabs blind-check-step-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            type="button"
            className={`document-switch-tab generation-settings-tab${selected ? ' is-active' : ''}${tab.warning ? ' blind-check-step-tab-warning' : ''}`}
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            id={`${panelId}-tab-${tab.id}`}
            key={tab.id}
            title={`${tab.label}：${tab.summary}`}
            onClick={() => onSelect(tab.id)}
          >
            <span className="generation-settings-tab-label">{tab.label}</span>
            <small className="generation-settings-tab-summary">{tab.summary}</small>
          </button>
        );
      })}
    </div>
  );
}
