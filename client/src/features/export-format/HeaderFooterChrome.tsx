import type { ExportFormatConfig, HeaderFooterStyle, PageSetupConfig } from '../../shared/types/exportFormat';
import { HEADER_FOOTER_STYLE_OPTIONS, isDecorativeHeaderFooterStyle, isHtmlHeaderFooterStyle, resolveHeaderFooterStyle } from '../../shared/types/exportFormat';
import { fillChromeHeaderHtml, fillFooterChromeSvg } from './headerFooterChromeTemplates';

function hexLuminance(hex: string): number {
  const raw = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(raw)) return 0;
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000;
}

function contrastText(background: string): string {
  return hexLuminance(background) < 160 ? '#ffffff' : '#111111';
}

function darkenHex(hex: string, amount = 0.18): string {
  const raw = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(raw)) return '#111111';
  const channel = (start: number) => Math.max(0, Math.round(Number.parseInt(raw.slice(start, start + 2), 16) * (1 - amount)));
  return `#${[0, 2, 4].map((start) => channel(start).toString(16).padStart(2, '0')).join('')}`;
}

export function formatPreviewPageNumber(page: PageSetupConfig, pageIndex = 0): string {
  const pageNo = Math.max(1, Number(page.page_number_start) || 1) + pageIndex;
  const pad = Number(page.page_number_pad) || 0;
  const token = pad > 0 ? String(pageNo).padStart(pad, '0') : String(pageNo);
  return String(page.page_number_format || '第{page}页').replace('{page}', token);
}

export function showPageHeaderChrome(page: PageSetupConfig): boolean {
  if (!page.header_enabled) return false;
  if (isDecorativeHeaderFooterStyle(page.header_footer_style)) return true;
  return Boolean((page.header_text || '').trim());
}

export function showPageFooterChrome(page: PageSetupConfig): boolean {
  return Boolean((page.footer_enabled && page.footer_text.trim()) || page.page_number_enabled);
}

interface ChromeColors {
  bar: string;
  accent: string;
  onBar: string;
  onAccent: string;
  badge: string;
  slot: string;
}

export function resolveChromeColors(page: PageSetupConfig): ChromeColors {
  const bar = page.chrome_bar_color || '#e8eef5';
  const accent = page.chrome_accent_color || '#536176';
  const onAccent = contrastText(accent);
  return {
    bar,
    accent,
    onBar: contrastText(bar) === '#ffffff' ? '#ffffff' : accent,
    onAccent,
    badge: darkenHex(accent, 0.12),
    slot: onAccent,
  };
}

interface ChromePartProps {
  config: ExportFormatConfig;
  pageIndex?: number;
}

function chromeClass(style: HeaderFooterStyle, extra = ''): string {
  return `page-chrome is-${style}${extra ? ` ${extra}` : ''}`;
}

export function PageHeaderChrome({ config }: ChromePartProps) {
  const page = config.page;
  if (!showPageHeaderChrome(page)) return null;

  const style = resolveHeaderFooterStyle(page.header_footer_style);
  const colors = resolveChromeColors(page);
  const headerText = (page.header_text || '').trim();
  const badgeText = String(page.header_badge_text || '').trim().slice(0, 4);

  if (style === 'band') {
    return (
      <div className={chromeClass(style, 'page-chrome-header')} style={{ background: colors.bar, color: colors.onBar }}>
        <span className="page-chrome-badge" style={{ background: colors.accent, color: colors.onAccent }}>{badgeText}</span>
        <span className="page-chrome-center">{headerText}</span>
        <span className="page-chrome-spacer" aria-hidden="true" />
      </div>
    );
  }

  if (style === 'rules') {
    return (
      <div className={chromeClass(style, 'page-chrome-header')} style={{ color: page.header_color }}>
        <span className="page-chrome-text">{headerText}</span>
        <span className="page-chrome-rules" style={{ borderColor: colors.accent }} />
      </div>
    );
  }

  if (isHtmlHeaderFooterStyle(style)) {
    return (
      <div
        className={chromeClass(style, 'page-chrome-header is-html')}
        dangerouslySetInnerHTML={{
          __html: fillChromeHeaderHtml(style, {
            accent: colors.accent,
            bar: colors.bar,
            text: headerText,
            font: page.header_font,
            size: page.header_size,
          }),
        }}
      />
    );
  }

  if (style === 'footer-badge') {
    return (
      <div className={chromeClass(style, 'page-chrome-header')} style={{ color: page.header_color, borderColor: colors.accent }}>
        <span className="page-chrome-text">{headerText}</span>
      </div>
    );
  }

  return (
    <div className={chromeClass(style, 'page-chrome-header')} style={{ color: page.header_color, textAlign: undefined }}>
      {headerText}
    </div>
  );
}

export function PageFooterChrome({ config, pageIndex = 0 }: ChromePartProps) {
  const page = config.page;
  if (!showPageFooterChrome(page)) return null;

  const style = resolveHeaderFooterStyle(page.header_footer_style);
  const colors = resolveChromeColors(page);
  const footerText = page.footer_enabled ? page.footer_text.trim() : '';
  const pageNumberText = page.page_number_enabled ? formatPreviewPageNumber(page, pageIndex) : '';

  if (style === 'band') {
    return (
      <div className={chromeClass(style, 'page-chrome-footer')} style={{ background: colors.accent, color: colors.onAccent }}>
        <span className="page-chrome-spacer" aria-hidden="true" />
        <span className="page-chrome-center">{footerText}</span>
        {pageNumberText ? (
          <span className="page-chrome-badge is-page" style={{ background: colors.badge, color: contrastText(colors.badge) }}>{pageNumberText}</span>
        ) : <span className="page-chrome-spacer" aria-hidden="true" />}
      </div>
    );
  }

  if (style === 'rules') {
    return (
      <div className={chromeClass(style, 'page-chrome-footer')} style={{ color: page.footer_color }}>
        <span className="page-chrome-rules" style={{ borderColor: colors.accent }} />
        <span className="page-chrome-text">
          {footerText ? <span>{footerText}</span> : null}
          {pageNumberText ? <span>{pageNumberText}</span> : null}
        </span>
      </div>
    );
  }

  if (style === 'top-bar') {
    return (
      <div
        className={chromeClass(style, 'page-chrome-footer is-slot')}
        style={{ background: colors.accent, color: colors.onAccent }}
      >
        <span
          className="page-chrome-footer-mark"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: fillFooterChromeSvg(style, colors.onAccent) }}
        />
        <span className="page-chrome-center is-slot" style={{ background: '#fff', color: colors.accent }}>{footerText}</span>
        <span className="page-chrome-page-box is-badge" style={{ background: colors.badge, color: contrastText(colors.badge) }}>{pageNumberText}</span>
      </div>
    );
  }

  if (style === 'slant') {
    return (
      <div
        className={chromeClass(style, 'page-chrome-footer is-slant')}
        style={{ background: colors.bar, color: colors.accent }}
      >
        <span
          className="page-chrome-footer-mark is-accent"
          style={{ background: colors.accent, color: colors.onAccent }}
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: fillFooterChromeSvg(style, colors.onAccent) }}
        />
        <span className="page-chrome-center">{footerText}</span>
        <span className="page-chrome-page-box is-badge" style={{ background: colors.badge, color: contrastText(colors.badge) }}>{pageNumberText}</span>
      </div>
    );
  }

  if (style === 'letterhead') {
    return (
      <div
        className={chromeClass(style, 'page-chrome-footer is-letterhead')}
        style={{ background: '#fff', color: colors.accent, borderColor: colors.accent }}
      >
        <span className="page-chrome-center is-left">{footerText}</span>
        <span className="page-chrome-accent-bar" style={{ background: colors.accent }} aria-hidden="true" />
        <span className="page-chrome-page-box" style={{ color: colors.accent }}>{pageNumberText}</span>
      </div>
    );
  }

  if (style === 'frame') {
    return (
      <div
        className={chromeClass(style, 'page-chrome-footer is-frame')}
        style={{ background: '#fff', color: colors.accent, borderColor: colors.accent }}
      >
        <span
          className="page-chrome-footer-mark"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: fillFooterChromeSvg(style, colors.accent) }}
        />
        <span className="page-chrome-center">{footerText}</span>
        <span className="page-chrome-page-box is-frame" style={{ borderColor: colors.accent }}>{pageNumberText}</span>
      </div>
    );
  }

  if (style === 'footer-badge') {
    return (
      <div className={chromeClass(style, 'page-chrome-footer')} style={{ background: colors.bar, color: colors.onBar }}>
        <span className="page-chrome-center">{footerText}</span>
        {pageNumberText ? (
          <span className="page-chrome-badge is-page" style={{ background: colors.accent, color: colors.onAccent }}>{pageNumberText}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div className={chromeClass(style, 'page-chrome-footer')} style={page.footer_enabled ? undefined : { textAlign: 'center', color: page.footer_color }}>
      {footerText ? <span>{footerText}</span> : null}
      {pageNumberText ? <span>{pageNumberText}</span> : null}
    </div>
  );
}

function StyleThumbBody() {
  return (
    <span className="header-footer-style-thumb-body">
      <i /><i /><i /><i />
    </span>
  );
}

export function HeaderFooterStyleThumb({ style, bar, accent }: { style: HeaderFooterStyle; bar: string; accent: string }) {
  const barColor = bar || '#e8eef5';
  const accentColor = accent || '#536176';

  if (style === 'band') {
    return (
      <span className="header-footer-style-thumb is-band" aria-hidden="true">
        <span className="header-footer-style-thumb-bar" style={{ background: barColor }}>
          <i style={{ background: accentColor }} />
        </span>
        <StyleThumbBody />
        <span className="header-footer-style-thumb-bar is-footer" style={{ background: accentColor }}>
          <i style={{ background: darkenHex(accentColor) }} />
        </span>
      </span>
    );
  }

  if (style === 'rules') {
    return (
      <span className="header-footer-style-thumb is-rules" aria-hidden="true">
        <span className="header-footer-style-thumb-caption" style={{ background: accentColor }} />
        <span className="header-footer-style-thumb-line" style={{ borderColor: accentColor }} />
        <StyleThumbBody />
        <span className="header-footer-style-thumb-line" style={{ borderColor: accentColor }} />
        <span className="header-footer-style-thumb-caption" style={{ background: accentColor }} />
      </span>
    );
  }

  if (style === 'top-bar') {
    return (
      <span className="header-footer-style-thumb is-top-bar" aria-hidden="true">
        <span className="header-footer-style-thumb-ribbon" style={{ background: accentColor }}>
          <i style={{ background: darkenHex(accentColor, 0.32) }} />
          <b style={{ background: barColor }} />
          <em style={{ background: darkenHex(accentColor, 0.38) }} />
        </span>
        <StyleThumbBody />
        <span className="header-footer-style-thumb-ribbon is-footer" style={{ background: accentColor }}>
          <i style={{ background: darkenHex(accentColor, 0.18) }} />
          <b style={{ background: '#fff' }} />
          <em style={{ background: darkenHex(accentColor) }} />
        </span>
      </span>
    );
  }

  if (style === 'footer-badge') {
    return (
      <span className="header-footer-style-thumb is-footer-badge" aria-hidden="true">
        <span className="header-footer-style-thumb-hairline" style={{ background: accentColor }} />
        <StyleThumbBody />
        <span className="header-footer-style-thumb-bar is-footer" style={{ background: barColor }}>
          <i style={{ background: accentColor }} />
        </span>
      </span>
    );
  }

  if (style === 'slant') {
    return (
      <span className="header-footer-style-thumb is-slant" aria-hidden="true">
        <span className="header-footer-style-thumb-slant" style={{ background: barColor }}>
          <i style={{ background: accentColor }} />
        </span>
        <StyleThumbBody />
        <span className="header-footer-style-thumb-bar is-footer" style={{ background: barColor }}>
          <i style={{ background: accentColor }} />
        </span>
      </span>
    );
  }

  if (style === 'letterhead') {
    return (
      <span className="header-footer-style-thumb is-letterhead" aria-hidden="true">
        <span className="header-footer-style-thumb-letter-head">
          <i style={{ background: accentColor }} />
          <b style={{ background: accentColor }} />
        </span>
        <StyleThumbBody />
        <span className="header-footer-style-thumb-letter-foot">
          <b style={{ background: accentColor }} />
          <em />
        </span>
      </span>
    );
  }

  if (style === 'frame') {
    return (
      <span className="header-footer-style-thumb is-frame" aria-hidden="true">
        <span className="header-footer-style-thumb-frame-head" style={{ borderColor: accentColor }}>
          <i style={{ background: accentColor }} />
          <i style={{ background: accentColor }} />
          <b />
        </span>
        <StyleThumbBody />
        <span className="header-footer-style-thumb-frame-foot" style={{ borderColor: accentColor }}>
          <em style={{ borderColor: accentColor }} />
        </span>
      </span>
    );
  }

  return (
    <span className="header-footer-style-thumb is-plain" aria-hidden="true">
      <span className="header-footer-style-thumb-caption" />
      <StyleThumbBody />
      <span className="header-footer-style-thumb-caption" />
    </span>
  );
}

interface StylePickerProps {
  value: HeaderFooterStyle;
  bar: string;
  accent: string;
  onChange: (style: HeaderFooterStyle) => void;
}

export function HeaderFooterStylePicker({ value, bar, accent, onChange }: StylePickerProps) {
  return (
    <div className="header-footer-style-picker" role="radiogroup" aria-label="页眉页脚样式">
      {HEADER_FOOTER_STYLE_OPTIONS.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={`header-footer-style-card${selected ? ' is-selected' : ''}`}
            onClick={() => onChange(option.value)}
            role="radio"
            aria-checked={selected}
            title={option.description}
          >
            <HeaderFooterStyleThumb style={option.value} bar={bar} accent={accent} />
            <strong>{option.label}</strong>
          </button>
        );
      })}
    </div>
  );
}
