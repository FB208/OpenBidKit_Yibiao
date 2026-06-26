/**
 * 目录编号格式化工具
 * 每个标题级别独立选择编号格式：Word 多级编号或自定义模板
 */

import type { HeadingStyleConfig } from '../types/exportFormat';

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

function numberToCircled(num: number): string {
  const circled = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
  return circled[num - 1] || String(num);
}

function numberToAlpha(num: number, upper = false): string {
  let n = Math.max(1, Math.floor(num));
  let value = '';
  while (n > 0) {
    n -= 1;
    value = String.fromCharCode(97 + (n % 26)) + value;
    n = Math.floor(n / 26);
  }
  return upper ? value.toUpperCase() : value;
}

function numberToRoman(num: number, upper = false): string {
  let n = Math.max(1, Math.min(3999, Math.floor(num)));
  const pairs: Array<[number, string]> = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
    [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
    [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let value = '';
  pairs.forEach(([amount, symbol]) => {
    while (n >= amount) {
      value += symbol;
      n -= amount;
    }
  });
  return upper ? value.toUpperCase() : value;
}

/**
 * 将 outline id 拆成有效数字层级。
 */
export function outlineNumberParts(id: string): number[] {
  return String(id || '')
    .split('.')
    .map((part) => parseInt(part, 10))
    .filter((part) => Number.isFinite(part) && part > 0);
}

type HeadingNumberingConfig = Pick<HeadingStyleConfig, 'numbering_format' | 'numbering_template'>;

/**
 * 根据 outline id 和标题编号配置生成编号前缀。
 */
export function formatOutlineNumber(id: string, heading: HeadingNumberingConfig | null | undefined): string {
  const parts = outlineNumberParts(id);
  if (!parts.length) return '';

  if (heading?.numbering_format === 'outline-decimal') {
    return parts.join('.');
  }

  if (heading?.numbering_format !== 'custom') return '';

  const lastPart = parts[parts.length - 1];
  const cn = numberToChinese(lastPart);
  const tail = (parts.length >= 3 ? parts.slice(2) : [lastPart]).join('.');
  return String(heading.numbering_template || '')
    .replace(/\{zh\}/g, cn)
    .replace(/\{num\}/g, String(lastPart))
    .replace(/\{tail\}/g, tail)
    .replace(/\{full\}/g, parts.join('.'))
    .replace(/\{circled\}/g, numberToCircled(lastPart))
    .replace(/\{alpha\}/g, numberToAlpha(lastPart))
    .replace(/\{ALPHA\}/g, numberToAlpha(lastPart, true))
    .replace(/\{roman\}/g, numberToRoman(lastPart))
    .replace(/\{ROMAN\}/g, numberToRoman(lastPart, true))
    .trim();
}

function shouldInsertSpaceAfterNumber(prefix: string): boolean {
  return !/[、，。；：）)】\]》〉]$/.test(prefix);
}

/**
 * 将目录项 id + title 按指定编号格式拼接为完整标题文本。
 */
export function formatOutlineTitle(id: string, title: string, heading: HeadingNumberingConfig | null | undefined): string {
  const prefix = formatOutlineNumber(id, heading);
  if (!prefix) return String(title || '');
  return `${prefix}${shouldInsertSpaceAfterNumber(prefix) ? ' ' : ''}${title || ''}`;
}
