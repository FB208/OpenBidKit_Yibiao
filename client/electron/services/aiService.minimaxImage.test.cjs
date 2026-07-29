const test = require('node:test');
const assert = require('node:assert/strict');
const { __test__ } = require('./aiService.cjs');

test('MiniMax 生图请求体使用原生字段并把尺寸枚举映射为 aspect_ratio', () => {
  const body = __test__.createMiniMaxImageRequestBody(
    { model_name: 'image-01', image_size: '1536x1024' },
    '一张示意图',
  );
  assert.equal(body.model, 'image-01');
  assert.equal(body.prompt, '一张示意图');
  assert.equal(body.response_format, 'url');
  assert.equal(body.n, 1);
  assert.equal(body.prompt_optimizer, true);
  assert.equal(body.aspect_ratio, '3:2');
  assert.ok(!('size' in body));
});

test('尺寸为 auto 时不下发 aspect_ratio', () => {
  const ratio = __test__.normalizeMiniMaxAspectRatio({ image_size: 'auto' });
  assert.equal(ratio, '');
  const body = __test__.createMiniMaxImageRequestBody({ model_name: 'image-01', image_size: 'auto' }, 'p');
  assert.ok(!('aspect_ratio' in body));
});

test('从 data.image_urls 解析图片地址', () => {
  const urls = __test__.extractMiniMaxImageUrls({
    data: { image_urls: ['https://example.com/a.png', '', 'https://example.com/b.png'] },
    base_resp: { status_code: 0 },
  });
  assert.deepEqual(urls, ['https://example.com/a.png', 'https://example.com/b.png']);
});

test('base_resp.status_code 非 0 时返回状态错误信息', () => {
  const message = __test__.getMiniMaxImageStatusError(
    { base_resp: { status_code: 1004, status_msg: 'invalid api key' } },
    '生图失败',
  );
  assert.equal(message, 'invalid api key');
  const ok = __test__.getMiniMaxImageStatusError({ base_resp: { status_code: 0 } }, '生图失败');
  assert.equal(ok, '');
});

test('日志脱敏隐藏 base64 图片数据', () => {
  const safe = __test__.safeMiniMaxImageResponse({
    data: { image_urls: ['https://example.com/a.png'], image_base64: ['AAAA'] },
    base_resp: { status_code: 0 },
  });
  assert.equal(safe.data.image_base64, '[base64 omitted]');
  assert.deepEqual(safe.data.image_urls, ['https://example.com/a.png']);
});
