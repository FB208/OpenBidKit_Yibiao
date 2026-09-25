// 提取唯一完整代码块，忽略外围说明；保留源码内部字符，不拼接或修复源码。
function extractAiSource(response, kind) {
  const text = response.trim();
  const fences = [...text.matchAll(/^[ \t]*`{3,}[^\r\n]*\r?$/gm)];
  if (!fences.length) {
    if (!text) throw new Error('AI 源码不能为空');
    return text;
  }
  const wrapped = text.match(/^[ \t]*```([^\r\n`]*)\r?\n([\s\S]*?)(?:\r?\n)?^[ \t]*```[ \t]*\r?$/m);
  if (fences.length !== 2 || !wrapped) {
    throw new Error('AI 源码须为纯源码或唯一完整代码块，不能包含多个代码块或未闭合围栏');
  }
  const language = wrapped[1].trim().toLowerCase();
  if (language && language !== kind) throw new Error(`源码围栏语言应为 ${kind}，实际为 ${language}`);
  if (!wrapped[2].trim()) throw new Error('AI 源码不能为空');
  return wrapped[2];
}

module.exports = { extractAiSource };
