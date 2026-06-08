/**
 * 目录编号格式化工具
 * 每个标题级别独立选择编号格式：第一章/第一节/一、/1./（一）/(1) 等
 */

import type { NumberingFormat } from '../types/exportFormat';

/**
 * 阿拉伯数字转中文数字（1~9999）
 * 1→一  10→十  11→十一  21→二十一  101→一百零一
 */
export function numberToChinese(num: number): string {
  const n = Math.max(1, Math.min(9999, Math.floor(num)));
  const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const tens = ['', '十', '二十', '三十', '四十', '五十', '六十', '七十', '八十', '九十'];
  if (n <= 9) return digits[n];
  if (n <= 19) return `十${n === 10 ? '' : digits[n - 10]}`;
  if (n <= 99) {
    const t = Math.floor(n / 10);
    const o = n % 10;
    return `${tens[t]}${o ? digits[o] : ''}`;
  }
  if (n <= 999) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    if (r === 0) return `${digits[h]}百`;
    if (r <= 9) return `${digits[h]}百零${digits[r]}`;
    return `${digits[h]}百${numberToChinese(r)}`;
  }
  const th = Math.floor(n / 1000);
  const r = n % 1000;
  if (r === 0) return `${digits[th]}千`;
  if (r < 100) return `${digits[th]}千零${numberToChinese(r)}`;
  return `${digits[th]}千${numberToChinese(r)}`;
}

/**
 * 根据 outline id 的最后一段数字 + 编号格式，生成编号前缀
 * id 如 "1" → "第一章", "2.3" → 取决于该级格式
 */
export function formatOutlineNumber(id: string, format: NumberingFormat): string {
  const parts = String(id || '').split('.').filter(Boolean);
  if (!parts.length) return '';

  const lastPart = parseInt(parts[parts.length - 1], 10);
  if (!Number.isFinite(lastPart) || lastPart <= 0) return '';

  const cn = numberToChinese(lastPart);

  switch (format) {
    case 'chinese-chapter': return `第${cn}章`;
    case 'chinese-section': return `第${cn}节`;
    case 'chinese-dun':     return `${cn}、`;
    case 'chinese-paren':   return `（${cn}）`;
    case 'arabic-dun':      return `${lastPart}、`;
    case 'arabic-dot':      return `${lastPart}.`;
    case 'arabic-paren':    return `(${lastPart})`;
    case 'arabic':          return `${lastPart}`;
    case 'none':            return '';
    default:                return '';
  }
}

/**
 * 将目录项 id + title 按指定编号格式拼接为完整标题文本
 */
export function formatOutlineTitle(id: string, title: string, numberingFormat: NumberingFormat): string {
  const prefix = formatOutlineNumber(id, numberingFormat);
  return prefix ? `${prefix} ${title || ''}` : String(title || '');
}
