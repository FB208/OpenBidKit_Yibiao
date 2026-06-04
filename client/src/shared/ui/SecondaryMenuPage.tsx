import type { AppMenuItem, AppSubMenuItem, SectionId } from '../types/navigation';

interface SecondaryMenuPageProps {
  menuItem: AppMenuItem;
  onNavigate: (section: SectionId) => void;
}

function SecondaryMenuPage({ menuItem, onNavigate }: SecondaryMenuPageProps) {
  const children = menuItem.children ?? [];

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
              <button key={item.id} type="button" className="secondary-menu-row" onClick={() => onNavigate(item.id)}>
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

function SubMenuIcon({ item }: { item: AppSubMenuItem }) {
  switch (item.icon) {
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
