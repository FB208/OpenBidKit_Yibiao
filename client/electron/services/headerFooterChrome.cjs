const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_DIR = path.join(__dirname, '..', 'resources', 'header-footer');

const SIZE_TO_PT = {
  初号: 42,
  小初: 36,
  一号: 26,
  小一: 24,
  二号: 22,
  小二: 18,
  三号: 16,
  小三: 15,
  四号: 14,
  小四: 12,
  五号: 10.5,
  小五: 9,
  六号: 7.5,
  小六: 6.5,
};

const FONT_TO_CSS = {
  宋体: "'SimSun', 'STSong', serif",
  新宋体: "'NSimSun', 'SimSun', serif",
  黑体: "'SimHei', 'STHeiti', sans-serif",
  楷体: "'KaiTi', 'STKaiti', 'Kai', serif",
  仿宋: "'FangSong', 'STFangsong', serif",
  微软雅黑: "'Microsoft YaHei', sans-serif",
  等线: "'DengXian', 'Microsoft YaHei', sans-serif",
};

const HEADER_TEMPLATES = {
  'top-bar': 'slot-header.html',
  slant: 'slant-header.html',
  letterhead: 'letterhead-header.html',
  frame: 'frame-header.html',
};

const FOOTER_MARK_TEMPLATES = {
  'top-bar': 'footer-mark.svg',
  slant: 'footer-slash.svg',
  letterhead: 'footer-letter.svg',
  frame: 'footer-frame.svg',
};

function fillTemplate(source, vars) {
  return String(source || '').replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] == null ? '' : String(vars[key])));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeHex(value, fallback) {
  const raw = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toLowerCase()}`;
  return fallback;
}

function hexLuminance(hex) {
  const raw = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(raw)) return 0;
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000;
}

function contrastOn(hex) {
  return hexLuminance(hex) < 160 ? '#ffffff' : '#111111';
}

function chineseSizeToPt(sizeName) {
  return SIZE_TO_PT[sizeName] || 9;
}

function fontToCss(fontName) {
  if (FONT_TO_CSS[fontName]) return FONT_TO_CSS[fontName];
  const name = String(fontName || '').trim();
  return name ? `'${name}', 'Microsoft YaHei', sans-serif` : "'SimSun', 'STSong', serif";
}

function readTemplate(fileName) {
  return fs.readFileSync(path.join(TEMPLATE_DIR, fileName), 'utf8');
}

function headerTemplateVars({ accent, bar, text, font, sizePt }) {
  const accentHex = normalizeHex(accent, '#536176');
  return {
    accent: accentHex,
    bar: normalizeHex(bar, '#e8eef5'),
    onAccent: contrastOn(accentHex),
    text: escapeHtml(text),
    font: fontToCss(font),
    sizePt: String(sizePt || chineseSizeToPt('小五')),
  };
}

function fillChromeHeaderHtml(style, vars) {
  const fileName = HEADER_TEMPLATES[style] || HEADER_TEMPLATES['top-bar'];
  return fillTemplate(readTemplate(fileName), headerTemplateVars(vars));
}

function fillSlotHeaderHtml(vars) {
  return fillChromeHeaderHtml('top-bar', vars);
}

function fillFooterChromeSvg(style, mark) {
  const fileName = FOOTER_MARK_TEMPLATES[style] || FOOTER_MARK_TEMPLATES['top-bar'];
  return fillTemplate(readTemplate(fileName), {
    mark: normalizeHex(mark, '#ffffff'),
  });
}

function fillFooterMarkSvg(mark) {
  return fillFooterChromeSvg('top-bar', mark);
}

module.exports = {
  chineseSizeToPt,
  fillChromeHeaderHtml,
  fillFooterChromeSvg,
  fillFooterMarkSvg,
  fillSlotHeaderHtml,
  fontToCss,
  normalizeHex,
};
