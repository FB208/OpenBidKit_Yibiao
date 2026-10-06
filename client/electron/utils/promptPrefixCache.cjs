const { setTimeout: delay } = require('node:timers/promises');

const PREFIX_WARMUP_SETTLE_MS = 1500;

// 公共材料单独作为一条 user 消息：模型服务只在消息边界复用前缀缓存，同一条消息内的相同前缀不会命中；
// 预热与正式请求共用本函数，保证该消息逐字相同。没有公共材料时只有 system 和本项内容。
function sharedPrefixMessages(system, sharedInput, itemInput) {
  return [
    { role: 'system', content: system },
    ...(sharedInput ? [{ role: 'user', content: sharedInput }] : []),
    ...(itemInput ? [{ role: 'user', content: itemInput }] : []),
  ];
}

// 模型服务只在请求最后一条消息末尾写入缓存，后续请求仅在消息边界命中；
// 多个请求共用的前缀先用只含该前缀的短请求写入，失败不影响后续请求。
// 未传 signal 时由调用方的队列作用域负责取消。
async function warmPromptPrefix({ aiService, messages, signal, onActivity, logTitle, label }) {
  onActivity?.({ message: `正在预热${label}缓存` });
  try {
    await aiService.chat({ signal, logTitle, output_token_limit: 1, messages });
    // 部分服务在请求结束后才异步构建前缀缓存，稍候再放开后续请求。
    await delay(PREFIX_WARMUP_SETTLE_MS, undefined, signal ? { signal } : undefined);
  } catch (error) {
    signal?.throwIfAborted();
    onActivity?.({ message: `${label}缓存预热失败，直接继续：${error.message}` });
  }
}

module.exports = { sharedPrefixMessages, warmPromptPrefix };
