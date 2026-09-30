const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// 在实际服务代码的独立上下文中替换 HTTP，不发起外部请求或扩展生产接口。
function loadService(fetch) {
  const filename = path.join(__dirname, 'aiService.cjs');
  const context = {
    require: createRequire(filename), module: { exports: {} },
    console, process, Buffer, URL, AbortController, setTimeout, clearTimeout, TextDecoder, fetch,
  };
  vm.runInNewContext(`${fs.readFileSync(filename, 'utf-8')}\nmodule.exports = { chatWithConfig };`, context);
  return context.module.exports;
}

// 普通响应直接返回 JSON；流式响应按 SSE 分块返回同样的内容与结束原因。
function response(mode, finishReason) {
  if (mode === 'normal') {
    return { ok: true, json: async () => ({ choices: [{ message: { content: '<p>正文' }, finish_reason: finishReason }], usage: { total_tokens: 1 } }) };
  }
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: '<p>正文' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`,
    'data: [DONE]\n\n',
  ].map(text => new TextEncoder().encode(text));
  return { ok: true, body: { getReader: () => ({ read: async () => (chunks.length ? { value: chunks.shift(), done: false } : { done: true }) }) } };
}

test('要求完整输出的请求遇到长度截断时报错，其他请求保持原有返回', async () => {
  for (const mode of ['normal', 'stream']) {
    let finishReason;
    const { chatWithConfig } = loadService(async () => response(mode, finishReason));
    const config = { text_model_provider: 'custom', api_key: 'test-key', model_name: 'test-model', base_url: 'https://example.invalid/v1', request_mode: mode };
    const request = { messages: [{ role: 'user', content: '写正文' }] };
    finishReason = 'length';
    await assert.rejects(chatWithConfig(null, config, { ...request, reject_truncated_output: true }), /模型输出达到长度上限被截断/, mode);
    assert.equal(await chatWithConfig(null, config, request), '<p>正文', `${mode} 未要求时沿用原行为`);
    finishReason = 'stop';
    assert.equal(await chatWithConfig(null, config, { ...request, reject_truncated_output: true }), '<p>正文', `${mode} 正常结束不受影响`);
  }
});
