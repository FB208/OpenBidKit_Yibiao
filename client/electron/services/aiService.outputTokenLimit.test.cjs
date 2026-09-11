const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createConfigStore } = require('./configStore.cjs');

// 在隔离上下文中访问实际请求构造函数，不扩展生产服务接口。
const context = { require, module: { exports: {} }, console, process, Buffer, URL };
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, 'aiService.cjs'), 'utf-8')
    + '\nmodule.exports = { createChatRequestBody, createAgentChatRequestBody };',
  context,
);
const { createChatRequestBody, createAgentChatRequestBody } = context.module.exports;

// 验证普通、流式、JSON 和 Agent 请求的最终输出参数。
test('输出上限同时控制两个参数，空值和 0 移除 SDK 参数', () => {
  const messages = [{ role: 'user', content: '测试' }];
  for (const output_token_limit of [8192, 0, '', undefined]) {
    for (const stream of [false, true]) {
      const config = { model_name: 'test-model', output_token_limit, request_mode: stream ? 'stream' : 'normal' };
      const bodies = [
        createChatRequestBody(config, { messages }, { stream }),
        createChatRequestBody(config, { messages, response_format: { type: 'json_object' } }, { stream }),
        createChatRequestBody(config, { messages, response_format: { type: 'json_object' } }, { stream, omitResponseFormat: true }),
        createAgentChatRequestBody(config, { messages, max_tokens: 100, max_completion_tokens: 200, max_output_tokens: 300 }),
      ];
      for (const body of bodies) {
        if (output_token_limit > 0) {
          assert.equal(body.max_tokens, output_token_limit);
          assert.equal(body.max_completion_tokens, output_token_limit);
        } else {
          assert.equal(Object.hasOwn(body, 'max_tokens'), false);
          assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
        }
        assert.equal(Object.hasOwn(body, 'max_output_tokens'), false);
      }
    }
  }
});

// 验证输出上限随服务商保存，清空后重新加载为 0。
test('输出上限保存重载、服务商切换及清空', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '易标输出上限-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = { getPath: () => directory };
  const store = createConfigStore(app);
  assert.equal(store.load().output_token_limit, 0);
  store.save({ text_model_provider: 'custom', ...store.load().text_model_profiles.custom, output_token_limit: 8192 });
  assert.equal(createConfigStore(app).load().output_token_limit, 8192);
  store.save({ text_model_provider: 'deepseek', ...store.load().text_model_profiles.deepseek, output_token_limit: 4096 });
  assert.equal(store.load().output_token_limit, 4096);
  store.save({ text_model_provider: 'custom', ...store.load().text_model_profiles.custom });
  assert.equal(store.load().output_token_limit, 8192);
  store.save({ output_token_limit: '' });
  assert.equal(createConfigStore(app).load().output_token_limit, 0);
  assert.equal(store.load().text_model_profiles.deepseek.output_token_limit, 4096);
});
