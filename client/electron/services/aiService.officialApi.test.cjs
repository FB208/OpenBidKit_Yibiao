const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// 在实际服务代码的独立上下文中替换 HTTP，不发起外部请求或扩展生产接口。
function loadService(file, exports, fetch) {
  const filename = path.join(__dirname, file);
  const context = {
    require: createRequire(filename), module: { exports: {} },
    console, process, Buffer, URL, AbortController, setTimeout, clearTimeout, fetch,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf-8') + `\nmodule.exports = { ${exports} };`, context);
  return context.module.exports;
}

// 验证普通、流式、JSON 和 Agent 最终请求仅为官方服务附加标识。
test('官方请求携带开源客户端标识，其他服务商不携带且不按 URL 判断', async () => {
  let sent;
  const service = loadService('aiService.cjs', 'createChatRequestBody, createAgentChatRequestBody, fetchChatCompletion, createHeaders', async (url, options) => {
    sent = { url, headers: options.headers, body: JSON.parse(options.body) };
    return { ok: true };
  });
  const messages = [{ role: 'user', content: '测试' }];
  const tools = [{ type: 'function', function: { name: 'test_tool', parameters: { type: 'object' } } }];
  for (const provider of ['official', 'jinlong', 'volcengine', 'deepseek', 'agnes', 'custom']) {
    const config = {
      text_model_provider: provider, api_key: 'test-key', model_name: 'yibiao-text',
      base_url: 'https://v3.yibiao.pro/qhp-yibiao/anonymous/yibiao/openai/v1',
      output_token_limit: 128000, request_mode: 'stream',
    };
    const bodies = [
      service.createChatRequestBody(config, { messages }),
      service.createChatRequestBody(config, { messages }, { stream: true }),
      service.createChatRequestBody(config, { messages, response_format: { type: 'json_object' } }, { stream: true }),
      service.createAgentChatRequestBody(config, { messages, tools, max_tokens: 32768 }),
    ];
    for (const body of bodies) {
      await service.fetchChatCompletion(null, config, body, { signal: new AbortController().signal });
      assert.equal(sent.url, `${config.base_url}/chat/completions`);
      assert.equal(sent.headers.Authorization, 'Bearer test-key');
      assert.equal(sent.headers['Content-Type'], 'application/json');
      assert.equal(Object.hasOwn(sent.headers, 'X-Yibiao-Client-Type'), provider === 'official');
      if (provider === 'official') assert.equal(sent.headers['X-Yibiao-Client-Type'], 'open-source');
      assert.equal(sent.body.max_completion_tokens, 128000);
      if (provider === 'official') assert.equal(Object.hasOwn(sent.body, 'max_tokens'), false);
      else assert.equal(sent.body.max_tokens, 128000);
      assert.equal(Object.hasOwn(sent.body, 'temperature'), false);
      assert.equal(Object.hasOwn(sent.body, 'reasoning_effort'), false);
      if (body.tools) assert.deepEqual(sent.body.tools, tools);
      if (body.response_format) assert.equal(sent.body.response_format.type, 'json_object');
    }
  }
  // 生图复用的基础请求头没有文本服务商参数，不附带官方文本标识。
  assert.equal(Object.hasOwn(service.createHeaders('test-key'), 'X-Yibiao-Client-Type'), false);
});

// 自检直连请求与业务出口遵循同一个官方标识规则。
test('Pi 自检仅为官方直连请求附加开源客户端标识', async () => {
  let headers;
  const { runTextModelProbe } = loadService('pi/piSelfCheckService.cjs', 'runTextModelProbe', async (_url, options) => {
    headers = options.headers;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  for (const provider of ['official', 'custom']) {
    const result = await runTextModelProbe({
      text_model_provider: provider, api_key: 'test-key', model_name: 'yibiao-text',
      base_url: 'https://v3.yibiao.pro/qhp-yibiao/anonymous/yibiao/openai/v1',
    }, { id: 'normal', label: '普通请求', stream: false });
    assert.equal(result.success, true, result.message);
    assert.equal(Object.hasOwn(headers, 'X-Yibiao-Client-Type'), provider === 'official');
    if (provider === 'official') assert.equal(headers['X-Yibiao-Client-Type'], 'open-source');
  }
});
