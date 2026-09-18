const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 沿用请求构造测试的隔离方式，直接验证生产函数，不扩展服务接口。
const context = { require, module: { exports: {} }, console, process, Buffer, URL };
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, 'aiService.cjs'), 'utf-8')
    + '\nmodule.exports = { prepareMultimodalMessages, createChatRequestBody };',
  context,
);
const { prepareMultimodalMessages, createChatRequestBody } = context.module.exports;

// 覆盖纯文本、内容块及混合输入，确认消息顺序、输入和 JSON 输出配置不变。
test('合并 system 消息时保留文本及结构化内容', async () => {
  const textPart = { type: 'text', text: '请输出 {"结果":"中文"}' };
  const imagePart = { type: 'image_url', image_url: { url: 'data:image/png;base64,test' } };
  const cases = [
    { contents: ['规则一', '规则二'], expected: '规则一\n\n规则二' },
    { contents: [[textPart]], expected: [textPart] },
    { contents: ['规则一', [textPart, imagePart], '规则二'], expected: [
      { type: 'text', text: '规则一' }, { type: 'text', text: '\n\n' },
      textPart, imagePart, { type: 'text', text: '\n\n' }, { type: 'text', text: '规则二' },
    ] },
    { contents: ['', [], '  '], expected: undefined },
    { contents: [], expected: undefined },
  ];
  for (const { contents, expected } of cases) {
    const user = { role: 'user', content: '问题' };
    const assistant = { role: 'assistant', content: '答复' };
    const messages = [user, ...contents.map((content) => ({ role: 'system', content })), assistant];
    const original = JSON.stringify(messages);
    const config = { multimodal_enabled: true, model_name: 'test-model' };
    const prepared = await prepareMultimodalMessages(config, messages);
    assert.deepEqual(JSON.parse(JSON.stringify(prepared)), expected === undefined
      ? [user, assistant] : [{ role: 'system', content: expected }, user, assistant]);
    assert.equal(JSON.stringify(messages), original);
    if (expected !== undefined) {
      // 模拟服务端直接拼接文本块，验证消息边界仍为空行。
      const flattenText = (content) => Array.isArray(content)
        ? content.filter((part) => part.type === 'text').map((part) => part.text).join('') : content;
      assert.equal(flattenText(prepared[0].content), contents.map(flattenText).join('\n\n'));
    }
    for (const stream of [false, true]) {
      const response_format = { type: 'json_object' };
      const body = createChatRequestBody(config, { messages: prepared, response_format }, { stream });
      assert.deepEqual(body.response_format, response_format);
      assert.equal(body.messages, prepared);
    }
  }
});
