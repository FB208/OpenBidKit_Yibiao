import type { OfficialConsumeRecord } from '../../../shared/types/officialAccount';

export const aiTypeLabels: Record<NonNullable<OfficialConsumeRecord['aiType']>, string> = {
  TEXT_GENERATION: '性价比文本',
  REASONING: '高质量文本',
  IMAGE_GENERATION: '图片生成',
};

// 金额按分保存为字符串，直接移位小数点显示为元，不经过浮点运算。
export function formatFenAsYuan(fen: string) {
  const digits = fen.padStart(3, '0');
  return `${digits.slice(0, -2).replace(/^0+(?=\d)/, '')}.${digits.slice(-2)}`;
}
