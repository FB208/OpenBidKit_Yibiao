import type { KeyboardEvent, ReactNode } from 'react';
import OfficialAccountControls from './OfficialAccountControls';
import OfficialApiStatement from './OfficialApiStatement';
import OfficialInvoicePanel from './OfficialInvoicePanel';
import OfficialOrdersPanel from './OfficialOrdersPanel';
import OfficialTransactionsPanel from './OfficialTransactionsPanel';

const officialApiTabs = [
  { id: 'statement', label: '声明' },
  { id: 'orders', label: '订单' },
  { id: 'transactions', label: '流水' },
  { id: 'invoice', label: '开票信息' },
] as const;

export type OfficialApiTab = typeof officialApiTabs[number]['id'];

interface OfficialApiPanelProps {
  tab: OfficialApiTab;
  onTabChange: (tab: OfficialApiTab) => void;
  modelControls: ReactNode;
  rechargeRequested: boolean;
  onRechargeRequestHandled: () => void;
}

// 组合模型操作、官方账户及信息页签，供文本和生图设置共用。
export default function OfficialApiPanel({
  tab: activeTab,
  onTabChange,
  modelControls,
  rechargeRequested,
  onRechargeRequestHandled,
}: OfficialApiPanelProps) {
  // 用方向键及首尾键切换官方账户页签，并同步键盘焦点。
  const handleOfficialApiTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = officialApiTabs.findIndex((tab) => tab.id === activeTab);
    const nextIndex = event.key === 'ArrowRight' ? (index + 1) % officialApiTabs.length
      : event.key === 'ArrowLeft' ? (index + officialApiTabs.length - 1) % officialApiTabs.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? officialApiTabs.length - 1
      : -1;
    if (nextIndex === -1) return;
    event.preventDefault();
    const nextTab = officialApiTabs[nextIndex].id;
    onTabChange(nextTab);
    event.currentTarget.querySelector<HTMLButtonElement>(`#official-api-tab-${nextTab}`)?.focus();
  };

  return (
    <>
      <div className="settings-list">
        {modelControls}
        <OfficialAccountControls
          onViewOrders={() => onTabChange('orders')}
          rechargeRequested={rechargeRequested}
          onRechargeRequestHandled={onRechargeRequestHandled}
        />
      </div>
      <div className="official-api-details">
        <div className="official-api-tabs" role="tablist" aria-label="官方账户信息" onKeyDown={handleOfficialApiTabKeyDown}>
          {officialApiTabs.map((tab) => (
            <button
              type="button"
              className={`official-api-tab${activeTab === tab.id ? ' is-active' : ''}`}
              role="tab"
              id={`official-api-tab-${tab.id}`}
              aria-controls={`official-api-panel-${tab.id}`}
              aria-selected={activeTab === tab.id}
              tabIndex={activeTab === tab.id ? 0 : -1}
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div
          className="official-api-tab-content"
          role="tabpanel"
          id={`official-api-panel-${activeTab}`}
          aria-labelledby={`official-api-tab-${activeTab}`}
          tabIndex={0}
        >
          {activeTab === 'statement' ? (
            <OfficialApiStatement />
          ) : activeTab === 'orders' ? (
            <OfficialOrdersPanel />
          ) : activeTab === 'invoice' ? (
            <OfficialInvoicePanel />
          ) : (
            <OfficialTransactionsPanel />
          )}
        </div>
      </div>
    </>
  );
}
