function formatSegmentResults(segmentResults) {
  const items = Array.isArray(segmentResults) ? segmentResults : [];
  return items
    .map((item, index) => {
      const segmentIndex = item?.segmentIndex || index + 1;
      const totalSegments = item?.totalSegments || items.length;
      return `## 第 ${segmentIndex}/${totalSegments} 段解析结果\n${String(item?.content || '').trim()}`;
    })
    .join('\n\n');
}

function buildMergeMessages({ segmentResults, taskPrompt, output, systemPrompt, sectionHint, taskLabel }) {
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  if (sectionHint) {
    messages.push({ role: 'system', content: sectionHint });
  }

  const outputRequirement = output === 'json'
    ? '最终只返回一个 JSON 对象，不要输出 Markdown、代码块、解释或额外文字。'
    : '最终只返回整理后的 Markdown 内容，不要输出解释、过程或额外提示语。';

  messages.push({
    role: 'user',
    content: `以下内容来自同一份招标文件按段分别解析后的结果。每段结果只代表该片段内的信息，不代表整份文件的完整结论。

当前合并任务：${taskLabel || '招标文件解析结果合并'}

合并要求：
1. 如果某段写“没有提及”“原文未提及”“本段未提及”，只表示该片段没有相关信息；如果其他片段提供了有效信息，应以有效信息为准。
2. 删除重复、空泛、冲突的片段性表述，保留更完整、更具体的信息。
3. 保留所有有价值、可用于最终结果的信息，不要遗漏分段结果中的明确内容。
4. 不要新增分段结果中没有的信息，不要自行编造。
5. 最终输出必须符合原始任务要求。
6. ${outputRequirement}

原始任务要求：
${taskPrompt}

分段解析结果：
${formatSegmentResults(segmentResults)}`,
  });

  return messages;
}

async function mergeSegmentedAiResults({
  aiService,
  segmentResults,
  taskPrompt,
  output,
  systemPrompt,
  sectionHint,
  taskLabel,
  logTitle,
}) {
  return aiService.chat({
    messages: buildMergeMessages({ segmentResults, taskPrompt, output, systemPrompt, sectionHint, taskLabel }),
    temperature: 0.1,
    response_format: output === 'json' ? { type: 'json_object' } : undefined,
    logTitle: logTitle || `分段结果合并-${taskLabel || 'AI任务'}`,
  });
}

module.exports = {
  mergeSegmentedAiResults,
};
