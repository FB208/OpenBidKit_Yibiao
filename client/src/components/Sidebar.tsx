import * as Tooltip from '@radix-ui/react-tooltip';
import { useState, type ComponentType, type ReactElement, type SVGProps } from 'react';
import { getAppMenuItems, getParentMenuItemBySection } from '../app/menuConfig';
import type { AppMenuItem, SectionId } from '../shared/types/navigation';
import { useToast } from '../shared/ui';
import logoUrl from '../../assets/icon_256.png';

interface SidebarProps {
  activeSection: SectionId;
  developerMode: boolean;
  onSectionChange: (section: SectionId) => void;
}

const navigationIcons: Record<SectionId, ComponentType<SVGProps<SVGSVGElement>>> = {
  'bid-generation': BidGenerationIcon,
  'technical-plan': DocumentIcon,
  'existing-plan-expansion': DocumentIcon,
  'business-bid': BriefcaseIcon,
  'knowledge-base': ArchiveIcon,
  'document-knowledge-base': ArchiveIcon,
  'image-knowledge-base': ArchiveIcon,
  resources: ResourcesIcon,
  'bid-check': BidCheckIcon,
  'duplicate-check': CompareIcon,
  'rejection-check': ShieldIcon,
  'ai-evaluation': BidCheckIcon,
  'template-settings': DocumentIcon,
  'my-templates': DocumentIcon,
  'new-template': DocumentIcon,
  'export-format': DocumentIcon,
  'bid-opportunity': RadarIcon,
  'developer-test': FlaskIcon,
  'developer-json-test': FlaskIcon,
  'developer-prompt-lab': FlaskIcon,
  'developer-parser-sandbox': FlaskIcon,
  'developer-export-preview': FlaskIcon,
  'developer-expansion-replace-test': FlaskIcon,
  'developer-agent-test': FlaskIcon,
  'plugin-manager': PluginIcon,
  settings: GearIcon,
};

const USER_GUIDE_URL = 'https://wiki.agnet.top/';

function Sidebar({ activeSection, developerMode, onSectionChange }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { showToast } = useToast();
  const menuItems = getAppMenuItems(developerMode);
  const activeParent = getParentMenuItemBySection(activeSection, developerMode);

  const handleMenuItemClick = (item: AppMenuItem) => {
    if (!item.notice) {
      onSectionChange(item.id);
      return;
    }

    showToast(item.notice.message, 'info', {
      duration: 7000,
      actions: item.notice.externalUrl ? [
        {
          label: item.notice.actionLabel || '打开链接',
          variant: 'primary',
          onClick: () => openExternalUrl(item.notice?.externalUrl || ''),
        },
      ] : undefined,
    });
  };

  return (
    <aside className={`sidebar ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="sidebar-surface" />

      <div className="brand-block">
        <div className="brand-mark" aria-hidden="true">
          <img src={logoUrl} alt="" />
        </div>
        <div className="brand-copy">
          <span>易标</span>
          <strong>投标工具箱</strong>
        </div>
      </div>

      <button
        type="button"
        className="collapse-button"
        onClick={() => setCollapsed((value) => !value)}
        aria-label={collapsed ? '展开菜单' : '收起菜单'}
      >
        <ChevronIcon className={collapsed ? 'rotate-180' : ''} />
      </button>

      <nav className="sidebar-nav" aria-label="主菜单">
        {menuItems.map((item) => {
          const Icon = navigationIcons[item.id];
          const isActive = item.id === activeSection || activeParent?.id === item.id;
          const button = (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${isActive ? 'is-active' : ''}`}
              onClick={() => handleMenuItemClick(item)}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
            >
              <span className="nav-icon" aria-hidden="true">
                <Icon />
              </span>
              <span className="nav-copy">
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          );

          return collapsed ? wrapTooltip(item.label, button) : button;
        })}
      </nav>

      <div className="sidebar-footer">
        {collapsed ? wrapTooltip('使用文档', renderUserGuideButton()) : renderUserGuideButton()}
        {collapsed ? wrapTooltip('设置', renderSettingsButton(activeSection, onSectionChange)) : renderSettingsButton(activeSection, onSectionChange)}
      </div>
    </aside>
  );
}

async function openExternalUrl(url: string) {
  if (!url) return;

  if (window.yibiao?.openExternal) {
    await window.yibiao.openExternal(url);
    return;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
}

function renderSettingsButton(activeSection: SectionId, onSectionChange: (section: SectionId) => void) {
  const isActive = activeSection === 'settings';

  return (
    <button
      type="button"
      className={`settings-trigger ${isActive ? 'is-active' : ''}`}
      onClick={() => onSectionChange('settings')}
      aria-current={isActive ? 'page' : undefined}
      aria-label="设置"
    >
      <span className="nav-icon" aria-hidden="true">
        <GearIcon />
      </span>
      <span className="settings-copy">
        <strong>设置</strong>
        <small>模型与解析配置</small>
      </span>
    </button>
  );
}

function renderUserGuideButton() {
  return (
    <button
      type="button"
      className="settings-trigger"
      onClick={() => void openExternalUrl(USER_GUIDE_URL)}
      aria-label="使用文档"
    >
      <span className="nav-icon" aria-hidden="true">
        <BookIcon />
      </span>
      <span className="settings-copy">
        <strong>使用文档</strong>
        <small>教程与功能共创</small>
      </span>
    </button>
  );
}

function wrapTooltip(label: string, child: ReactElement) {
  return (
    <Tooltip.Root key={label}>
      <Tooltip.Trigger asChild>{child}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" side="right" align="center" sideOffset={12}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function BidGenerationIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M6 5.2h7.2l4.8 4.8v8.8H6z" />
      <path d="M13 5.5V10h4.5" />
      <path d="M8.8 13.2h6.4" />
      <path d="M8.8 16.3h4.5" />
      <path d="M4.5 7.2v13h12" />
    </svg>
  );
}

function DocumentIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M7 3.75h6.7L18 8.05v12.2H7z" />
      <path d="M13.5 4v4.35h4.25" />
      <path d="M9.5 12.2h5" />
      <path d="M9.5 15.7h4" />
    </svg>
  );
}

function BriefcaseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M5 8h14v11.5H5z" />
      <path d="M9 8V5.5h6V8" />
      <path d="M5 12.5h14" />
      <path d="M10.5 12.5v2h3v-2" />
    </svg>
  );
}

function ArchiveIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M5 7.5h14v12H5z" />
      <path d="M4 4.5h16v3H4z" />
      <path d="M9 11.2h6" />
    </svg>
  );
}

function ResourcesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M4.8 6.4h4v12.2h-4z" />
      <path d="M10.1 4.8h4.2v13.8h-4.2z" />
      <path d="m15.4 7.1 3.4-.9 2.7 10.8-3.4.85z" />
      <path d="M4 19.3h16.8" />
    </svg>
  );
}

function BidCheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M7 4.2h10v15.6H7z" />
      <path d="M9.5 8h5" />
      <path d="m9.5 12.3 1.5 1.5 3.7-4" />
      <path d="M9.5 17h5" />
      <path d="M5 6.2v15h10" />
    </svg>
  );
}

function CompareIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M7 5.5h7.5" />
      <path d="M7 9h5.5" />
      <path d="M5 15.5h7.5" />
      <path d="M5 19h5.5" />
      <path d="M16.5 13.5l2 2 2-2" />
      <path d="M18.5 15.5V5" />
      <path d="M7.5 8.5l-2-2 2-2" />
      <path d="M5.5 6.5V17" />
    </svg>
  );
}

function ShieldIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M12 3.5 18.5 6v5.4c0 4.25-2.55 7.55-6.5 9.1-3.95-1.55-6.5-4.85-6.5-9.1V6z" />
      <path d="m9 12.2 2 2 4-4.5" />
    </svg>
  );
}

function RadarIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Z" />
      <path d="M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z" />
      <path d="M12 12 18 6" />
      <path d="M12 12h.01" />
    </svg>
  );
}

function FlaskIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M9 3.8h6" />
      <path d="M10.5 3.8v5.4l-4.2 7.4c-.85 1.5.24 3.4 1.96 3.4h7.48c1.72 0 2.81-1.9 1.96-3.4l-4.2-7.4V3.8" />
      <path d="M8.5 15.8h7" />
      <path d="M10 12.5h4" />
    </svg>
  );
}

function GearIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" />
      <path d="m19.1 13.5.1-1.5-.1-1.5 2-1.5-2-3.4-2.45.95a8.2 8.2 0 0 0-2.55-1.45L13.75 2h-3.5L9.9 5.1a8.2 8.2 0 0 0-2.55 1.45L4.9 5.6l-2 3.4 2 1.5L4.8 12l.1 1.5-2 1.5 2 3.4 2.45-.95A8.2 8.2 0 0 0 9.9 18.9l.35 3.1h3.5l.35-3.1a8.2 8.2 0 0 0 2.55-1.45l2.45.95 2-3.4z" />
    </svg>
  );
}

function PluginIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M8 3v5" />
      <path d="M16 3v5" />
      <path d="M6 8h12v2a6 6 0 0 1-12 0z" />
      <path d="M12 16v5" />
    </svg>
  );
}

function BookIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M5.5 4.5h5.2c1.25 0 2.3 1.05 2.3 2.3v12.7c-.45-.8-1.25-1.3-2.3-1.3H5.5z" />
      <path d="M18.5 4.5h-5.2C12.05 4.5 11 5.55 11 6.8v12.7c.45-.8 1.25-1.3 2.3-1.3h5.2z" />
      <path d="M8 8h2" />
      <path d="M14 8h2" />
    </svg>
  );
}

function ChevronIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="m14 7-5 5 5 5" />
    </svg>
  );
}

export default Sidebar;
