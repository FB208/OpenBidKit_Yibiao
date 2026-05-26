import type { ChatMessage } from '../types';

export interface BuildJsonRepairMessagesInput {
  invalidContent: string;
  issues: string[];
  targetDescription: string;
}

export function buildJsonRepairMessages({
  invalidContent,
  issues,
  targetDescription,
}: BuildJsonRepairMessagesInput): ChatMessage[] {
  const issueLines = issues.map((item, index) => `${index + 1}. ${item}`).join('\n');

  return [
    {
      role: 'system',
      content: '你是一个严格的 JSON 修复助手。必须修复 JSON 字符串中的非法反斜杠转义，例如将 1\\. 改为 1.，或将必须保留的反斜杠写成 \\\\。只返回修复后的完整 JSON，不要输出任何解释。',
    },
    { role: 'user', content: `目标结果类型：${targetDescription}` },
    { role: 'user', content: `当前校验问题：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${invalidContent}\n\`\`\`` },
  ];
}
