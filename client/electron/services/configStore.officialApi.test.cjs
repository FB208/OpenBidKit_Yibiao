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
  assert.equal(initial.base_url, '');
  assert.equal(initial.model_name, '');
  assert.ok(initial.analytics_client_id);

  const customProfile = {
    ...initial.text_model_profiles.custom,
    api_key: 'test-key',
    base_url: 'https://example.com/v1',
    model_name: '测试模型',
  };
  store.save({ text_model_provider: 'custom', ...customProfile });
  const existing = store.load();
  delete existing.official_api_model_type;
  fs.writeFileSync(store.getConfigFilePath(), JSON.stringify(existing), 'utf-8');
  assert.equal(store.load().text_model_provider, 'custom');
  assert.deepEqual(store.load().text_model_profiles.custom, customProfile);

  for (const modelType of ['high-quality', 'cost-effective']) {
    store.save({
      text_model_provider: 'official',
      official_api_model_type: modelType,
      ...initial.text_model_profiles.official,
    });
    const reloaded = createConfigStore(app).load();
    assert.equal(reloaded.text_model_provider, 'official');
    assert.equal(reloaded.official_api_model_type, modelType);
    assert.equal(reloaded.analytics_client_id, initial.analytics_client_id);
    assert.deepEqual(reloaded.text_model_profiles.custom, customProfile);
    assert.deepEqual(reloaded.text_model_profiles.official, initial.text_model_profiles.official);
  }

  store.save({ text_model_provider: 'custom', ...store.load().text_model_profiles.custom });
  const restored = createConfigStore(app).load();
  assert.equal(restored.text_model_provider, 'custom');
  assert.equal(restored.api_key, customProfile.api_key);
  assert.equal(restored.base_url, customProfile.base_url);
  assert.equal(restored.model_name, customProfile.model_name);
});
