const fs = require('node:fs');
const { load } = require('cheerio');
const { AI_QUEUE_SCOPE_PAUSED } = require('../utils/aiRequestQueue.cjs');
const { createAiBatchGuard, isBatchCancelled } = require('../utils/aiBatchGuard.cjs');

// 程序逐项调用模型的批处理：并发由 AI 队列控制，单项失败交给 onError 记录后继续；
// 服务端连续失败时停止派发剩余项并抛出，暂停时按暂停抛出，已完成的结果由调用方及时落盘保留。
async function runAiBatch({ items, signal, run, onError = () => {} }) {
  const guard = createAiBatchGuard({ signal });
  const settled = await Promise.allSettled(items.map(async item => {
    try {
      guard.signal.throwIfAborted();
      return await run(item, guard);
    } catch (error) {
      const cancelled = isBatchCancelled(error, guard.signal);
      if (!cancelled) guard.failure(error);
      onError(item, error, { cancelled });
      if (cancelled) throw error;
      return undefined;
    }
  }));
  signal.throwIfAborted();
  if (guard.error) throw guard.error;
  const paused = settled.find(item => item.status === 'rejected' && item.reason?.code === AI_QUEUE_SCOPE_PAUSED);
  if (paused) throw paused.reason;
}

// 同一对话最多请求两次：首次结果不理想时附上反馈追问一次；两次都未通过时取最接近要求的可用结果。
// evaluate 返回 { accept: true, value }、{ value, distance, feedback, reason }（可用备选）或 { feedback, reason }（不可用），抛错视为不可用。
async function requestWithFollowUp({ aiService, guard, logTitle, messages, evaluate }) {
  const conversation = [...messages];
  let fallback = null;
  let reason = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const reply = await aiService.chat({ signal: guard.signal, logTitle, reject_truncated_output: true, messages: conversation });
    guard.signal.throwIfAborted();
    guard.success();
    let result;
    try {
      result = evaluate(reply);
    } catch (error) {
      result = { feedback: `上次输出不可用：${error.message}。请修正后按原要求重新输出。`, reason: error.message };
    }
    if (result.accept) return result.value;
    if (result.value !== undefined && (!fallback || result.distance < fallback.distance)) fallback = result;
    reason = result.reason || result.feedback;
    conversation.push({ role: 'assistant', content: reply }, { role: 'user', content: result.feedback });
  }
  if (fallback) return fallback.value;
  throw new Error(reason);
}

// 顶层元素和 yibiao:block 分隔注释及其源码偏移，按位置拼接时不重新序列化正文。
function topLevelNodes(html) {
  const $ = load(html, { sourceCodeLocationInfo: true }, false);
  const nodes = $.root().contents().toArray().flatMap(node => {
    const location = node.sourceCodeLocation;
    if (!location) return [];
    if (node.type === 'comment') return /^\s*yibiao:block\s*$/.test(node.data) ? [{ kind: 'marker', node, start: location.startOffset, end: location.endOffset }] : [];
    return node.type === 'tag' ? [{ kind: 'element', node, start: location.startOffset, end: location.endOffset }] : [];
  });
  return { $, nodes };
}

// 按源码偏移从后往前替换或插入，未涉及的内容逐字节保持不变。
function spliceHtml(html, edits) {
  return [...edits].sort((left, right) => right.start - left.start)
    .reduce((source, edit) => source.slice(0, edit.start) + edit.text + source.slice(edit.end), html);
}

// 本节已有的元素 id，新增块按前缀续编时避开。
function collectIds($) {
  return new Set($('[id]').map((_index, element) => $(element).attr('id')).get());
}

// 生成不与本节已有 id 重复的新 id，长度符合受限 HTML 要求。
function uniqueId(base, used) {
  const prefix = /^[A-Za-z]/.test(base) ? base.slice(0, 56) : `b_${base}`.slice(0, 56);
  let id = prefix;
  for (let index = 2; used.has(id); index += 1) id = `${prefix}_${index}`;
  used.add(id);
  return id;
}

function writeHtml(file, html) {
  fs.writeFileSync(`${file}.tmp`, html, 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

module.exports = { runAiBatch, requestWithFollowUp, topLevelNodes, spliceHtml, collectIds, uniqueId, writeHtml };
