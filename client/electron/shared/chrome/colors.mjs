/**
 * 页眉页脚配色推导 —— 全仓唯一实现。
 *
 * 迁移自 client/src/shared/ui/HeaderFooterChrome.tsx 的 hexLuminance / contrastText /
 * darkenHex / resolveChromeColors，行为保持逐字节一致（含非法输入的兜底分支）。
 * 此前同一套逻辑在 HeaderFooterChrome.tsx、headerFooterChromeTemplates.ts 和
 * C# 的 ContrastColor 里各有一份，三处会各自漂移。
 */

const HEX6 = /^[0-9a-f]{6}$/i;

/** 去掉 # 并校验；非 6 位十六进制返回 null。 */
function rawHex(hex) {
  const raw = String(hex || '').replace('#', '');
  return HEX6.test(raw) ? raw : null;
}

/** YIQ 感知亮度，0–255。非法输入按 0（当作最暗）处理。 */
export function hexLuminance(hex) {
  const raw = rawHex(hex);
  if (raw === null) return 0;
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000;
}

/** 给定底色，挑一个能读的字色。阈值 160 沿用原实现。 */
export function contrastText(background) {
  return hexLuminance(background) < 160 ? '#ffffff' : '#111111';
}

/** 每通道等比压暗。非法输入返回 #111111。 */
export function darkenHex(hex, amount = 0.18) {
  const raw = rawHex(hex);
  if (raw === null) return '#111111';
  const channel = (start) =>
    Math.max(0, Math.round(Number.parseInt(raw.slice(start, start + 2), 16) * (1 - amount)));
  return `#${[0, 2, 4].map((start) => channel(start).toString(16).padStart(2, '0')).join('')}`;
}

/** 取 [r,g,b]，非法输入按黑色处理。 */
function channels(hex) {
  const raw = rawHex(hex);
  if (raw === null) return [0, 0, 0];
  return [0, 2, 4].map((i) => Number.parseInt(raw.slice(i, i + 2), 16));
}

function toHex(rgb) {
  return `#${rgb
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * CSS color-mix(in srgb, a <ratio>%, b) 的等价实现。
 * SVG 没有 color-mix，原 HTML 模板里的每一处都要在生成期算成具体色值。
 * @param {number} ratioA a 的占比，0–1
 */
export function mix(a, b, ratioA) {
  const A = channels(a);
  const B = channels(b);
  return toHex(A.map((v, i) => v * ratioA + B[i] * (1 - ratioA)));
}

/** 规范成 #rrggbb；非法时用 fallback。 */
export function normalizeHex(value, fallback) {
  const raw = rawHex(value);
  return raw === null ? fallback : `#${raw}`;
}

export const DEFAULT_BAR = '#e8eef5';
export const DEFAULT_ACCENT = '#536176';

/**
 * 由页面配置推出整套装饰用色。
 * @param {{chrome_bar_color?: string, chrome_accent_color?: string}} page
 */
export function resolveChromeColors(page) {
  const bar = page?.chrome_bar_color || DEFAULT_BAR;
  const accent = page?.chrome_accent_color || DEFAULT_ACCENT;
  const onAccent = contrastText(accent);
  return {
    bar,
    accent,
    onAccent,
    // 浅底上不用纯白，改用强调色，避免白底白字
    onBar: contrastText(bar) === '#ffffff' ? '#ffffff' : accent,
    badge: darkenHex(accent, 0.12),
    slot: onAccent,
  };
}
