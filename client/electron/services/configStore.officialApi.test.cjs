const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConfigStore } = require('./configStore.cjs');

// 使用临时中文路径，验证官方默认值、选择持久化及第三方配置隔离。
test('官方 API 设置保存重载后保留模型类型、账号和第三方配置', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '易标官方API-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = { getPath: () => directory };
  const store = createConfigStore(app);
  const initial = store.load();
  assert.equal(initial.text_model_provider, 'official');
  assert.equal(initial.official_api_model_type, 'cost-effective');
  assert.equal(initial.api_key, '');
  const officialProfile = {
    api_key: '',
    base_url: 'https://v3.yibiao.pro/qhp-yibiao/anonymous/yibiao/openai/v1',
    model_name: 'yibiao-text',
    multimodal_enabled: true,
    reasoning_effort: '',
    context_length_limit: 258000,
    output_token_limit: 128000,
    concurrency_limit: 50,
    temperature_enabled: false,
    temperature: 0.7,
    request_mode: 'stream',
  };
  assert.deepEqual(initial.text_model_profiles.official, officialProfile);
  for (const [field, value] of Object.entries(officialProfile)) assert.equal(initial[field], value);
  assert.ok(initial.analytics_client_id);

  const customProfile = {
    ...initial.text_model_profiles.custom,
    api_key: 'test-key',
    base_url: 'https://example.com/v1',
    model_name: '测试模型',
  };
  store.save({ text_model_provider: 'custom', ...customProfile });
  // 后台更新官方档案，不切换当前服务商，也不改变第三方 Key。
  store.save({ text_model_profiles: { official: { api_key: 'official-first' } } });
  assert.equal(store.load().text_model_provider, 'custom');
  assert.equal(store.load().api_key, customProfile.api_key);
  assert.deepEqual(store.load().text_model_profiles.official, { ...officialProfile, api_key: 'official-first' });

  for (const modelType of ['high-quality', 'cost-effective']) {
    const modelName = modelType === 'high-quality' ? 'yibiao-reasoning' : 'yibiao-text';
    store.save({ text_model_provider: 'official' });
    store.save({ official_api_model_type: modelType, model_name: modelName });
    const reloaded = createConfigStore(app).load();
    assert.equal(reloaded.official_api_model_type, modelType);
    assert.equal(reloaded.analytics_client_id, initial.analytics_client_id);
    assert.deepEqual(reloaded.text_model_profiles.custom, customProfile);
    const expected = { ...officialProfile, api_key: 'official-first', model_name: modelName };
    assert.deepEqual(reloaded.text_model_profiles.official, expected);
    for (const [field, value] of Object.entries(expected)) assert.equal(reloaded[field], value);
  }

  // 设置页旧快照省略自动维护的 Key，后台写入后再保存也不能将其覆盖。
  const { api_key: oldKey, ...stale } = store.load();
  const { api_key: oldProfileKey, ...official } = stale.text_model_profiles.official;
  stale.text_model_profiles.official = official;
  store.save({ text_model_profiles: { official: { api_key: 'official-latest' } } });
  store.save({ ...stale, model_name: 'yibiao-reasoning', official_api_model_type: 'high-quality' });
  assert.equal(store.load().api_key, 'official-latest');
  assert.equal(store.load().text_model_profiles.official.api_key, 'official-latest');

  store.save({ text_model_provider: 'custom' });
  const restored = createConfigStore(app).load();
  assert.deepEqual(restored.text_model_profiles.custom, customProfile);
  assert.equal(restored.api_key, customProfile.api_key);
  store.save({ text_model_provider: 'official' });
  assert.equal(store.load().model_name, 'yibiao-reasoning');
  assert.equal(store.load().api_key, 'official-latest');

  // 局部字段合并适用于其他渠道，清空字段仍显式生效。
  store.save({ text_model_profiles: { custom: { api_key: 'custom-updated' } } });
  store.save({ text_model_provider: 'custom' });
  assert.equal(store.load().api_key, 'custom-updated');
  assert.equal(store.load().base_url, customProfile.base_url);
  store.save({ api_key: '' });
  assert.equal(store.load().api_key, '');
  assert.equal(store.load().text_model_profiles.official.api_key, 'official-latest');
});
