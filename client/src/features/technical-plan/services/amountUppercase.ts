const DIGITS = '零壹贰叁肆伍陆柒捌玖';
const PLACES = ['仟', '佰', '拾', ''];
const SECTIONS = ['', '万', '亿', '万亿'];

// 整数部分按四位一节读：节内和跨节的连续零只读一个“零”，末尾的零不读。
function convertInteger(digits: string) {
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 4) groups.unshift(digits.slice(Math.max(0, end - 4), end).padStart(4, '0'));
  let result = '';
  let zero = false;
  groups.forEach((group, index) => {
    if (/^0+$/.test(group)) {
      zero = result.length > 0;
      return;
    }
    for (let place = 0; place < 4; place += 1) {
      const digit = Number(group[place]);
      if (digit === 0) {
        if (result) zero = true;
        continue;
      }
      if (zero) result += '零';
      zero = false;
      result += DIGITS[digit] + PLACES[place];
    }
    result += SECTIONS[groups.length - 1 - index];
  });
  return result;
}

/**
 * 金额数字转中文大写，如 123456 → 壹拾贰万叁仟肆佰伍拾陆元整，10005.06 → 壹万零伍元零陆分。
 * 允许千分位逗号、空格、￥ 和末尾的“元”，最多两位小数；不是金额数字时返回 null。
 */
export function toChineseAmount(text: string): string | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.replace(/[,，\s￥¥]/g, '').replace(/元$/, ''));
  if (!match) return null;
  const integer = match[1].replace(/^0+(?=\d)/, '');
  if (integer.length > 16) return null;
  const [jiao, fen] = (match[2] || '').padEnd(2, '0').split('').map(Number);
  const yuan = integer === '0' ? '' : convertInteger(integer);
  if (!yuan && !jiao && !fen) return '零元整';
  let result = yuan ? `${yuan}元` : '';
  if (jiao) result += `${DIGITS[jiao]}角`;
  else if (yuan && fen) result += '零';
  return fen ? `${result}${DIGITS[fen]}分` : `${result}整`;
}
