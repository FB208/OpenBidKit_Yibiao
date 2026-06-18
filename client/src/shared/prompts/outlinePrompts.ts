import type { ChatMessage, OutlineItem, TechnicalRequirementGroup } from '../types';

export interface BuildOutlineMessagesInput {
  overview: string;
  requirements: string;
  oldOutline?: string;
  suggestions?: string[];
}

export interface BuildChildrenOutlineMessagesInput extends BuildOutlineMessagesInput {
  parentItem: OutlineItem;
  requirementGroup?: TechnicalRequirementGroup;
}

function formatSuggestions(suggestions?: string[]) {
  if (!suggestions?.length) {
    return '';
  }

  return `\n\n本轮修正建议：\n${suggestions.map((item, index) => `${index + 1}. ${item}`).join('\n')}`;
}

function childrenOutlineJsonExample(parentId?: string) {
  const id = String(parentId || '1').trim() || '1';
  return `{
  "children": [
    {
      "id": "${id}.1",
      "title": "二级目录标题",
      "description": "二级目录说明",
      "children": [
        {
          "id": "${id}.1.1",
          "title": "三级目录标题",
          "description": "三级目录说明"
        },
        {
          "id": "${id}.1.2",
          "title": "三级目录标题",
          "description": "三级目录说明"
        }
      ]
    }
  ]
}`;
}

function childrenOutlineStructureRules(parentId?: string) {
  const id = String(parentId || '1').trim() || '1';
  return `结构要求：
1. 顶层 children 只能放当前一级目录的直接子目录，也就是二级目录。
2. 每个二级目录都必须包含非空 children 数组，children 内是三级目录。
3. 不要把评分细项直接作为没有子节点的二级目录；应先归纳二级主题，再在其下展开三级响应要点、实施措施、证明材料或验收标准。
4. 三级目录只包含 id、title、description，不要继续包含 children。
5. 编号必须以当前一级目录编号 ${id} 为前缀，例如二级 ${id}.1，三级 ${id}.1.1。

返回示例：
${childrenOutlineJsonExample(id)}`;
}

export function buildRequirementGroupsMessages(requirements: string, suggestions?: string[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你是一个专业的招标文件分析专家。请从技术评分要求中提取适合作为技术标一级目录的评分大类。

要求：
1. 只提取技术评分大类，不要提取商务、报价、资质等非技术类条目。
2. 每个大类都必须适合作为技术标一级目录标题，标题要专业、简洁、完整。
3. 同一大类下的细项、子项、分值说明、评分标准要归入 detail_points，不要拆成多个一级目录。
4. requirement_id 必须唯一，使用 R1、R2、R3 这种格式。
5. 只返回 JSON，格式必须为 {"groups": [...]}，不要输出其他内容。

JSON 格式要求：
{ "groups": [{ "requirement_id": "R1", "title": "", "description": "", "detail_points": ["", ""] }] }`,
    },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
    { role: 'user', content: `请提取所有适合作为技术标一级目录的技术评分大类，保持顺序稳定，并把每个大类下的评分细项归入 detail_points。${formatSuggestions(suggestions)}` },
  ];
}

export function buildAlignedChildrenOutlineMessages({ overview, requirements, parentItem, requirementGroup, oldOutline, suggestions }: BuildChildrenOutlineMessagesInput): ChatMessage[] {
  const detailPoints = requirementGroup?.detail_points?.filter(Boolean).map((item) => `- ${item}`).join('\n') || '- 未提供明确细项，请根据评分大类描述合理展开';

  return [
    {
      role: 'system',
      content: `你是一个专业的标书编写专家。请围绕指定的技术评分大类，为已经固定好的一级目录生成二级和三级目录。

要求：
1. 一级目录标题和顺序已经固定，不能修改、重命名、合并或删除一级目录。
2. 只输出当前一级目录下的二级和三级目录，不要重复输出一级目录本身。
3. 二级和三级目录要覆盖当前技术评分大类及其细项，不能越界写入其他评分大类内容。
4. 返回标准 JSON，格式为 {"children": [...]}，每个节点必须包含 id、title、description。
5. 只返回 JSON，不要输出其他内容。

${childrenOutlineStructureRules(parentItem.id)}`,
    },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求原文：\n${requirements}` },
    ...(oldOutline ? [{ role: 'user' as const, content: `用户自己编写的目录参考：\n${oldOutline}` }] : []),
    { role: 'user', content: `当前固定一级目录：\n编号：${parentItem.id}\n标题：${parentItem.title}\n描述：${parentItem.description}` },
    { role: 'user', content: `当前对应的技术评分大类：\nrequirement_id：${requirementGroup?.requirement_id || ''}\n标题：${requirementGroup?.title || ''}\n描述：${requirementGroup?.description || ''}\n细项：\n${detailPoints}` },
    { role: 'user', content: `请仅生成该一级目录下的二级、三级目录；每个二级目录必须包含三级目录，一级目录标题必须保持为当前给定标题，返回格式必须是 {"children": [...]}。${formatSuggestions(suggestions)}` },
  ];
}

export function buildAlignedOutlineReviewMessages({ overview, requirements, groupsJson, outlineJson }: BuildOutlineMessagesInput & { groupsJson: string; outlineJson: string }): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你是一个严格的招标文件目录审核专家。请审核目录是否与技术评分大类一一对应，并判断二三级目录是否覆盖各评分大类的细项。

要求：
1. 一级目录必须与提供的技术评分大类一一对应，数量一致、顺序一致、标题必须完全一致。
2. 不允许缺失技术评分大类，也不允许新增、合并、改写一级目录。
3. 二级和三级目录要围绕各自对应的技术评分大类与细项展开。
4. 只返回 JSON，格式为：{"passed": true, "suggestions": []}。`,
    },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
    { role: 'user', content: `技术评分大类 JSON：\n${groupsJson}` },
    { role: 'user', content: `待审核目录 JSON：\n${outlineJson}` },
    { role: 'user', content: '请判断该目录是否满足一一对应要求。若满足则返回 passed=true；若不满足则返回 passed=false，并给出具体修改建议。' },
  ];
}
