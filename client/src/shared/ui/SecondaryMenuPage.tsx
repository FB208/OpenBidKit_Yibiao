import type { AppMenuItem, AppSubMenuItem, SectionId } from '../types/navigation';
import { useToast } from './ToastProvider';

interface SecondaryMenuPageProps {
  menuItem: AppMenuItem;
  onNavigate: (section: SectionId) => void;
}

function SecondaryMenuPage({ menuItem, onNavigate }: SecondaryMenuPageProps) {
  const children = menuItem.children ?? [];
  const { showToast } = useToast();

  const handleItemClick = (item: AppSubMenuItem) => {
    if (!item.notice) {
      onNavigate(item.id);
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
    <div className="page-stack secondary-menu-page">
      <section className="panel secondary-menu-list-panel">
        <div className="secondary-menu-list-head">
          <div>
            <span>{menuItem.label}</span>
            <p>{menuItem.description}</p>
          </div>
        </div>

        {children.length ? (
          <div className="secondary-menu-list" aria-label={`${menuItem.label}二级菜单`}>
            {children.map((item) => (
              <button key={item.id} type="button" className="secondary-menu-row" onClick={() => handleItemClick(item)}>
                <span className="secondary-menu-row-icon" aria-hidden="true">
                  <SubMenuIcon item={item} />
                </span>
                <span className="secondary-menu-row-copy">
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
                <span className="secondary-menu-row-arrow">
                  <ArrowIcon />
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="secondary-menu-empty">
            <strong>暂无二级入口</strong>
            <span>当前一级菜单还没有配置可进入的子功能。</span>
          </div>
        )}
      </section>
    </div>
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

function SubMenuIcon({ item }: { item: AppSubMenuItem }) {
  switch (item.icon) {
    case 'document':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M7 3.8h6.6L17 7.2v13H7z" />
          <path d="M13.3 4v3.6h3.5" />
          <path d="M9.5 12h5" />
          <path d="M9.5 15.2h4" />
        </svg>
      );
    case 'expand':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M5.5 6.2h8.8v5.7H5.5z" />
          <path d="M9.2 15.3h9.3" />
          <path d="M9.2 18.4h6.5" />
          <path d="M16 5.5h2.5V8" />
          <path d="m13.8 10.2 4.4-4.4" />
          <path d="M5.5 15.3h1.2" />
          <path d="M5.5 18.4h1.2" />
        </svg>
      );
    case 'briefcase':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M5 8.2h14v10.3H5z" />
          <path d="M9 8.2V5.5h6v2.7" />
          <path d="M5 12.3h14" />
          <path d="M10.5 12.3v1.8h3v-1.8" />
        </svg>
      );
    case 'compare':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M7 5.8h7.5" />
          <path d="M7 9.1h5.4" />
          <path d="M5.5 15.3h7.5" />
          <path d="M5.5 18.6h5.4" />
          <path d="m16.5 13.6 2 2 2-2" />
          <path d="M18.5 15.6V5.2" />
          <path d="m7.5 8.7-2-2 2-2" />
          <path d="M5.5 6.7v10.5" />
        </svg>
      );
    case 'shield':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 3.8 18.2 6v5.2c0 4.1-2.45 7.25-6.2 8.75-3.75-1.5-6.2-4.65-6.2-8.75V6z" />
          <path d="m9 12 2 2 4-4.4" />
        </svg>
      );
    case 'code':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m8 9-3 3 3 3" />
          <path d="m16 9 3 3-3 3" />
          <path d="m13.5 6-3 12" />
        </svg>
      );
    case 'prompt':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M5 6.5h14v10H9l-4 3z" />
          <path d="M8.5 10h7" />
          <path d="M8.5 13h4.5" />
        </svg>
      );
    case 'file':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M7 3.8h6.5L17 7.3v12.9H7z" />
          <path d="M13.2 4v3.6h3.5" />
          <path d="M9.5 12h5" />
          <path d="M9.5 15h3.5" />
        </svg>
      );
    case 'export':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 4v10" />
          <path d="m8.5 10.5 3.5 3.5 3.5-3.5" />
          <path d="M5.5 15v4h13v-4" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M6 5.5h12v13H6z" />
          <path d="M9 9h6" />
          <path d="M9 12h6" />
          <path d="M9 15h4" />
        </svg>
      );
  }
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M5 12h13" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

export default SecondaryMenuPage;
