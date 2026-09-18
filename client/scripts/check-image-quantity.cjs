// PowerShell (client): $env:ELECTRON_RUN_AS_NODE="1"; .\node_modules\.bin\electron.cmd scripts/check-image-quantity.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createSqliteDatabase, schemaVersion } = require('../electron/services/sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('../electron/services/technicalPlanStore.cjs');

// 在临时中文路径验证图片数量保存、重新打开和数据库升级，不接触用户工作区。
function checkImageQuantity() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '易标-图片数量-'));
  const testApp = Object.assign(new EventEmitter(), { getPath: () => directory });
  let database;
  try {
    database = createSqliteDatabase(testApp);
    let store = createTechnicalPlanStore({ app: testApp, db: database.db });
    const initial = store.loadGenerationConfig().contentGenerationOptions;
    assert.equal(initial.imageQuantity, 'light');
    const settings = { ...initial, useAiImages: false, useMermaidImages: true, useHtmlImages: false, maxAiImages: 2, maxMermaidImages: 3, maxHtmlImages: 4 };
    for (const imageQuantity of ['none', 'light', 'heavy']) {
      const expected = { ...settings, imageQuantity };
      assert.deepEqual(store.saveContentGenerationOptions(expected).contentGenerationOptions, expected);
      database.close();
      database = createSqliteDatabase(testApp);
      store = createTechnicalPlanStore({ app: testApp, db: database.db });
      assert.deepEqual(store.loadGenerationConfig().contentGenerationOptions, expected);
    }
    // 移除新增列后按 v32 重新打开，确认升级只补充默认档位。
    database.db.exec('ALTER TABLE technical_plan_generation_config DROP COLUMN image_quantity');
    database.db.pragma('user_version = 32');
    database.close();
    database = createSqliteDatabase(testApp);
    store = createTechnicalPlanStore({ app: testApp, db: database.db });
    assert.deepEqual(store.loadGenerationConfig().contentGenerationOptions, { ...settings, imageQuantity: 'light' });
    assert.equal(database.db.pragma('user_version', { simple: true }), schemaVersion);
    console.log('图片数量：默认值、三个档位保存回读、重新打开及 v32 升级检查通过。');
  } finally {
    database?.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

checkImageQuantity();
