import slotHeaderTemplate from '../../../electron/resources/header-footer/slot-header.html?raw';
import slantHeaderTemplate from '../../../electron/resources/header-footer/slant-header.html?raw';
import letterheadHeaderTemplate from '../../../electron/resources/header-footer/letterhead-header.html?raw';
import frameHeaderTemplate from '../../../electron/resources/header-footer/frame-header.html?raw';
import footerMarkTemplate from '../../../electron/resources/header-footer/footer-mark.svg?raw';
import footerSlashTemplate from '../../../electron/resources/header-footer/footer-slash.svg?raw';
import footerLetterTemplate from '../../../electron/resources/header-footer/footer-letter.svg?raw';
import footerFrameTemplate from '../../../electron/resources/header-footer/footer-frame.svg?raw';
import { chineseFontToCss, chineseSizeToPt } from '../../shared/utils/exportFormatCss';
import type { HeaderFooterStyle } from '../../shared/types/exportFormat';

function fillTemplate(source: string, vars: Record<string, string>): string {
  return source.replace(/\{\{(\w+)\}\}/g, (_, key: string) => (vars[key] == null ? '' : vars[key]));
}

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeHex(value: string, fallback: string): string {
  const raw = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw}`;
  return fallback;
}

function hexLuminance(hex: string): number {
  const raw = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(raw)) return 0;
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000;
}

const HEADER_TEMPLATES: Partial<Record<HeaderFooterStyle, string>> = {
  'top-bar': slotHeaderTemplate,
  slant: slantHeaderTemplate,
  letterhead: letterheadHeaderTemplate,
  frame: frameHeaderTemplate,
};

const FOOTER_MARK_TEMPLATES: Partial<Record<HeaderFooterStyle, string>> = {
  'top-bar': footerMarkTemplate,
  slant: footerSlashTemplate,
  letterhead: footerLetterTemplate,
  frame: footerFrameTemplate,
};

export interface ChromeHeaderVars {
  accent: string;
  bar: string;
  text: string;
  font: string;
  size?: string;
}

function headerTemplateVars(vars: ChromeHeaderVars): Record<string, string> {
  const accent = normalizeHex(vars.accent, '#536176');
  return {
    accent,
    bar: normalizeHex(vars.bar, '#e8eef5'),
    onAccent: hexLuminance(accent) < 160 ? '#ffffff' : '#111111',
    text: escapeHtml(vars.text),
    font: chineseFontToCss(vars.font),
    sizePt: String(chineseSizeToPt(vars.size || '小五')),
  };
}

export function fillChromeHeaderHtml(style: HeaderFooterStyle, vars: ChromeHeaderVars): string {
  const source = HEADER_TEMPLATES[style] || slotHeaderTemplate;
  return fillTemplate(source, headerTemplateVars(vars));
}

export function fillSlotHeaderHtml(vars: ChromeHeaderVars): string {
  return fillChromeHeaderHtml('top-bar', vars);
}

export function fillFooterChromeSvg(style: HeaderFooterStyle, mark: string): string {
  const source = FOOTER_MARK_TEMPLATES[style] || footerMarkTemplate;
  return fillTemplate(source, {
    mark: normalizeHex(mark, '#ffffff'),
  });
}

export function fillFooterMarkSvg(mark: string): string {
  return fillFooterChromeSvg('top-bar', mark);
}
