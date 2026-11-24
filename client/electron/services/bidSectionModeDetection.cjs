const { splitUserTextByContextLimit } = require('../utils/userTextSplitter.cjs');

const JEV_SEGMENT_LIMIT = 200000;
const sectionQuestion = {
  instructions: '本次招标项目是否实际划分为两个或以上独立的投标范围？',
  criteria: {
    true: '原文明确划分出至少两个可分别投标或分别评审、授标的标段、标包、采购包、包件或标的。',
    false: '本次只有一个或未划分独立投标范围。章节、采购明细、同一标段的重复提及，以及仅在通用条款或模板中提到多个标段，均不算实际划分。',
  },
};

// 按字符切分 Jev 输入，不重叠也不截断字符。
function splitJevSegments(markdown) {
  if (markdown.length <= JEV_SEGMENT_LIMIT) return [markdown];
  const segments = [];
  let start = 0;
  let offset = 0;
  let count = 0;
  for (const character of markdown) {
    offset += character.length;
    if (++count === JEV_SEGMENT_LIMIT) {
      segments.push(markdown.slice(start, offset));
      start = offset;
      count = 0;
    }
  }
  if (start < offset) segments.push(markdown.slice(start));
  return segments;
}

// 判断完整原文的单、多标段；Jev 不可用的部分由普通文本模型接手。
async function detectBidSectionMode(markdown, aiService, signal) {
  const config = aiService.getConfig();
  const apiKey = config.components.jev_api_key;
  let textInputs = [markdown];
  if (apiKey) {
    const segments = splitJevSegments(markdown);
    const results = await Promise.allSettled(segments.map((state) => aiService.requestJevNoul({
      apiKey, state, question: sectionQuestion, signal,
    })));
    signal.throwIfAborted();
    const unexpected = results.find((result) => result.status === 'rejected' && !result.reason?.isAiRequestError);
    if (unexpected) throw unexpected.reason;
    if (results.some((result) => result.status === 'fulfilled' && result.value >= 0.5)) return 'multiple';
    textInputs = segments.filter((_segment, index) => results[index].status === 'rejected');
  }

  const results = await Promise.allSettled(textInputs
    .flatMap((text) => splitUserTextByContextLimit(text, config))
    .map((text) => aiService.requestJson({
      messages: [
        {
          role: 'system',
          content: `${sectionQuestion.instructions}\n是：${sectionQuestion.criteria.true}\n否：${sectionQuestion.criteria.false}\n只返回 JSON 对象，字段 has_multiple 必须为布尔值。`,
        },
        { role: 'user', content: text },
      ],
      signal,
      logTitle: '自动识别标段',
      progressLabel: '自动识别标段',
      // 只验证模型能否提供布尔判断，不补做语义规则。
      validator(result) {
        if (typeof result?.has_multiple !== 'boolean') {
          throw new Error('has_multiple 必须是布尔值');
        }
      },
    })));
  signal.throwIfAborted();
  if (results.some((result) => result.status === 'fulfilled' && result.value.has_multiple)) return 'multiple';
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return 'single';
}

module.exports = { detectBidSectionMode };
