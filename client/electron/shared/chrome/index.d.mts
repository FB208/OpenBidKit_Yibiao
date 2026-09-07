/** 共享页眉页脚装饰模块的类型声明（供渲染进程 TS 使用）。 */

export interface ChromeColors {
  bar: string;
  accent: string;
  onAccent: string;
  onBar: string;
  badge: string;
  slot: string;
}

export interface ChromeLayout {
  style: string;
  widthCm: number;
  heightCm: number;
  marginTopCm: number;
  marginBottomCm: number;
  marginLeftCm: number;
  marginRightCm: number;
  headerVisible: boolean;
  footerVisible: boolean;
  headerHeightCm: number;
  footerHeightCm: number;
  headerTopCm: number;
  footerTopCm: number;
  headerDistanceCm: number;
  footerDistanceCm: number;
  configuredFooterDistanceCm: number;
}

export interface ChromeTextBox {
  startCm: number;
  endCm: number;
  topCm: number;
  heightCm: number;
}

export interface ChromeTextLayout {
  style: string;
  header: {
    text: string;
    badgeText: string;
    color: string;
    bold: boolean;
    font: string;
    size: string;
    align: string;
    box: ChromeTextBox | null;
    badge: { color: string; bold: boolean; align: string; box: ChromeTextBox } | null;
  };
  footer: {
    text: string;
    color: string;
    font: string;
    size: string;
    align: string;
    box: ChromeTextBox | null;
    pageNumber: {
      enabled: boolean;
      format: string;
      pad: number;
      start: number;
      color: string;
      shadingFill: string | null;
      bold: boolean;
      align: string;
      box: ChromeTextBox | null;
    };
  };
}

export interface ChromeResult {
  style: string;
  layout: ChromeLayout;
  colors: ChromeColors;
  /** plain 或未启用时为 null，调用方不要创建图片部件。 */
  headerSvg: string | null;
  footerSvg: string | null;
  textLayout: ChromeTextLayout;
}

export function buildChrome(page?: Record<string, unknown>): ChromeResult;
export function chromeFingerprint(page?: Record<string, unknown>): string;

export function resolveChromeColors(page?: Record<string, unknown>): ChromeColors;
export function resolveChromeLayout(page?: Record<string, unknown>): ChromeLayout;
export function buildTextLayout(page: Record<string, unknown>, colors: ChromeColors, geometry?: ChromeLayout): ChromeTextLayout;
export function buildHeaderSvg(
  style: string, colors: ChromeColors, widthCm: number, heightCm?: number,
): string | null;
export function buildFooterSvg(
  style: string, colors: ChromeColors, widthCm: number, heightCm?: number,
): string | null;

export function contrastText(background: string): string;
export function darkenHex(hex: string, amount?: number): string;
export function hexLuminance(hex: string): number;
export function mix(a: string, b: string, ratioA: number): string;
export function normalizeHex(value: string, fallback: string): string;

export const HEADER_CHROME_HEIGHT_CM: number;
export const FOOTER_HEIGHT_CM: Record<string, number>;
export const FOOTER_COLUMNS: Record<string, { left: number; right: number; barCm?: number }>;
export const HEADER_BADGE_WIDTH_CM: number;
export const HEADER_SLOT: { leftCm: number; rightCm: number; topRatio: number; bottomRatio: number };
export const HEADER_FRAME: { xCm: number; yCm: number };
export const FOOTER_FRAME_INSET_CM: number;
export const CHROME_EDGE_BUDGET_CM: number;
export const CHROME_BODY_CLEARANCE_CM: number;
