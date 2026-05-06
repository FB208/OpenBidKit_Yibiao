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

function outlineSystemPrompt() {
  return `你是一个专业的标书编写专家。根据提供的项目概述和技术评分要求，生成投标文件中技术标部分的目录结构。
如果用户提供了自己编写的目录，你要保证目录满足技术评分要求，并充分结合用户自己编写的目录。

要求：
1. 目录结构要全面覆盖技术标的所有必要章节。
2. 章节名称要专业、准确，符合投标文件规范。
3. 一级目录名称要与技术评分要求中的章节名称一致；如果技术评分要求中没有明确章节名称，则结合内容总结一级目录名称。
4. 一共包括三级目录。
5. 返回标准 JSON 格式，包含章节编号、标题、描述和子章节。
6. 只返回 JSON，不要输出任何其他内容。

JSON 格式要求：
{
  "outline": [
    {
      "id": "1",
      "title": "",
      "description": "",
      "children": [
        {
          "id": "1.1",
          "title": "",
          "description": "",
          "children": [
            { "id": "1.1.1", "title": "", "description": "" }
          ]
        }
      ]
    }
  ]
}`;
}

function topLevelSystemPrompt() {
  return `你是一个专业的标书编写专家。根据提供的项目概述和技术评分要求，生成投标文件中技术标部分的一级目录结构。

要求：
1. 只生成一级目录，不要生成二级和三级目录。
2. 一级目录名称要专业、准确，符合投标文件规范。
3. 一级目录名称要尽量与技术评分要求中的章节名称一致；如果技术评分要求中没有明确章节名称，则结合内容总结一级目录名称。
4. 返回标准 JSON 格式，使用 outline 字段，每个一级目录必须包含 id、title、description。
5. 只返回 JSON，不要输出任何其他内容。

JSON 格式要求：
{ "outline": [{ "id": "1", "title": "", "description": "" }] }`;
}

export function buildOutlineMessages({ overview, requirements, oldOutline, suggestions }: BuildOutlineMessagesInput): ChatMessage[] {
  return [
    { role: 'system', content: outlineSystemPrompt() },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
    ...(oldOutline ? [{ role: 'user' as const, content: `用户自己编写的目录：\n${oldOutline}` }] : []),
    {
      role: 'user',
      content: oldOutline
        ? `请在满足技术评分要求的前提下，充分结合用户自己编写的目录，生成完整的技术标目录结构。${formatSuggestions(suggestions)}`
        : `请生成完整的技术标目录结构，确保覆盖所有技术评分要点。${formatSuggestions(suggestions)}`,
    },
  ];
}

export function buildTopLevelOutlineMessages({ overview, requirements, oldOutline, suggestions }: BuildOutlineMessagesInput): ChatMessage[] {
  return [
    { role: 'system', content: topLevelSystemPrompt() },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
    ...(oldOutline ? [{ role: 'user' as const, content: `用户自己编写的目录：\n${oldOutline}` }] : []),
    {
      role: 'user',
      content: oldOutline
        ? `请在满足技术评分要求的前提下，充分结合用户自己编写的目录，仅生成一级目录，不要生成二级和三级目录。返回 JSON 使用 outline 字段。${formatSuggestions(suggestions)}`
        : `请仅生成一级目录列表，不要生成二级和三级目录。返回 JSON 使用 outline 字段。${formatSuggestions(suggestions)}`,
    },
  ];
}

export function buildRequirementGroupsMessages(requirements: string, suggestions?: string[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你是一个专业的招标文件分析专家。请从技术评分要求中提取适合作为技术标一级目录的评分大类。

要求：
1. 只提取技术评分大类，不要提取商务、报价、资质、售后服务等非技术类条目。
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

export function buildChildrenOutlineMessages({ overview, requirements, parentItem, oldOutline, suggestions }: BuildChildrenOutlineMessagesInput): ChatMessage[] {
  const parentId = parentItem.id || '1';
  const parentTitle = parentItem.title || '未命名一级目录';
  const parentDescription = parentItem.description || '';

  return [
    {
      role: 'system',
      content: `你是一个专业的标书编写专家。请围绕指定的一级目录，生成其下属的二级目录和三级目录。

要求：
1. 只输出当前一级目录下的二级和三级目录，不要重复输出一级目录本身。
2. 返回标准 JSON，格式为 {"children": [...]}。
3. children 中只能包含当前一级目录的直接子目录，每个节点必须包含 id、title、description。
4. 二级目录下如有三级目录，同样使用 children 字段。
5. 章节编号必须以给定的一级目录编号为前缀，例如父级是 2，则二级目录编号从 2.1 开始，三级目录编号从 2.1.1 开始。
6. 只返回 JSON，不要输出其他内容。`,
    },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
    ...(oldOutline ? [{ role: 'user' as const, content: `用户自己编写的目录：\n${oldOutline}` }] : []),
    { role: 'user', content: `当前一级目录：\n编号：${parentId}\n标题：${parentTitle}\n描述：${parentDescription}` },
    { role: 'user', content: `请仅生成该一级目录下的二级、三级目录，返回格式必须是 {"children": [...]}。${formatSuggestions(suggestions)}` },
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
4. 返回标准 JSON，格式为 {"children": [...]}。
5. 章节编号必须以给定的一级目录编号为前缀。
6. 只返回 JSON，不要输出其他内容。`,
    },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求原文：\n${requirements}` },
    ...(oldOutline ? [{ role: 'user' as const, content: `用户自己编写的目录参考：\n${oldOutline}` }] : []),
    { role: 'user', content: `当前固定一级目录：\n编号：${parentItem.id}\n标题：${parentItem.title}\n描述：${parentItem.description}` },
    { role: 'user', content: `当前对应的技术评分大类：\nrequirement_id：${requirementGroup?.requirement_id || ''}\n标题：${requirementGroup?.title || ''}\n描述：${requirementGroup?.description || ''}\n细项：\n${detailPoints}` },
    { role: 'user', content: `请仅生成该一级目录下的二级、三级目录，一级目录标题必须保持为当前给定标题，返回格式必须是 {"children": [...]}。${formatSuggestions(suggestions)}` },
  ];
}

export function buildOutlineReviewMessages({ overview, requirements, outlineJson }: BuildOutlineMessagesInput & { outlineJson: string }): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你是一个严格的招标文件目录审核专家。请审核目录是否符合项目概述和技术评分要求。

要求：
1. 重点检查目录是否完整覆盖技术评分要点。
2. 检查一级目录名称是否专业、准确，是否尽量与评分项原文保持一致。
3. 检查目录层级是否清晰，是否达到三级目录要求，是否存在明显遗漏、错位、重复或不合理章节。
4. 只返回 JSON，格式为：{"passed": true, "suggestions": []}。
5. 若不通过，suggestions 中必须给出具体、可执行的修改建议。`,
    },
    { role: 'user', content: `项目概述：\n${overview}` },
    { role: 'user', content: `技术评分要求：\n${requirements}` },
    { role: 'user', content: `待审核目录 JSON：\n${outlineJson}` },
    { role: 'user', content: '请判断该目录是否满足要求。若满足则返回 passed=true；若不满足则返回 passed=false，并给出具体修改建议。' },
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
