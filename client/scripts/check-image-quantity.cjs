// PowerShell (client): $env:ELECTRON_RUN_AS_NODE="1"; .\node_modules\.bin\electron.cmd scripts/check-image-quantity.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createSqliteDatabase, schemaVersion } = require('../electron/services/sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('../electron/services/technicalPlanStore.cjs');

// 在临时中文路径验证配图比例保存、重新打开和数据库升级，不接触用户工作区。
function checkImageQuantity() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '易标-配图比例-'));
  const testApp = Object.assign(new EventEmitter(), { getPath: () => directory });
  let database;
  let store;

  // 按真实重启流程重新打开数据库，并清理上次实例的退出监听。
  function reopen() {
    database?.close();
    testApp.removeAllListeners();
    database = createSqliteDatabase(testApp);
    store = createTechnicalPlanStore({ app: testApp, db: database.db });
  }

  // 同时检查声明类型、实际存储类型和业务回读值，避免只验证保存接口的返回值。
  function assertIntegerRatio(expected) {
    const column = database.db.prepare('PRAGMA table_info(technical_plan_generation_config)').all()
      .find((item) => item.name === 'image_quantity');
    assert.equal(column.type, 'INTEGER');
    assert.equal(column.dflt_value, '30');
    assert.deepEqual(database.db.prepare('SELECT image_quantity, typeof(image_quantity) AS value_type FROM technical_plan_generation_config WHERE id = 1').get(), {
      image_quantity: expected,
      value_type: 'integer',
    });
    assert.equal(store.loadGenerationConfig().contentGenerationOptions.imageQuantity, expected);
    assert.equal(database.db.pragma('user_version', { simple: true }), schemaVersion);
  }

  try {
    reopen();
    const initial = store.loadGenerationConfig().contentGenerationOptions;
    assertIntegerRatio(30);
    const settings = { ...initial, useAiImages: false, useMermaidImages: true, useHtmlImages: false };
    for (const imageQuantity of Array.from({ length: 11 }, (_, index) => index * 10)) {
      const expected = { ...settings, imageQuantity };
      assert.deepEqual(store.saveContentGenerationOptions(expected).contentGenerationOptions, expected);
      reopen();
      assertIntegerRatio(imageQuantity);
      assert.deepEqual(store.loadGenerationConfig().contentGenerationOptions, expected);
    }

    // 已有整数列同样恢复默认比例，其他配置保持原样。
    const integerConfig = database.db.prepare('SELECT * FROM technical_plan_generation_config WHERE id = 1').get();
    database.db.pragma('user_version = 35');
    reopen();
    assertIntegerRatio(30);
    assert.deepEqual(database.db.prepare('SELECT * FROM technical_plan_generation_config WHERE id = 1').get(), { ...integerConfig, image_quantity: 30 });

    // 旧三档及数字文本一律恢复默认 30%，不做旧数据转换。
    const numericRatios = Array.from({ length: 11 }, (_, index) => index * 10);
    const cases = [
      ...numericRatios.flatMap((ratio) => [String(ratio), `${ratio}.0`]),
      'none', 'light', 'heavy',
    ];
    for (const previous of cases) {
      database.db.exec(`
        ALTER TABLE technical_plan_generation_config DROP COLUMN image_quantity;
        ALTER TABLE technical_plan_generation_config ADD COLUMN image_quantity TEXT NOT NULL DEFAULT 'light';
      `);
      database.db.prepare('UPDATE technical_plan_generation_config SET image_quantity = ? WHERE id = 1').run(previous);
      const before = database.db.prepare('SELECT * FROM technical_plan_generation_config WHERE id = 1').get();
      database.db.pragma('user_version = 35');
      reopen();
      assertIntegerRatio(30);
      const migrated = { ...before, image_quantity: 30 };
      assert.deepEqual(database.db.prepare('SELECT * FROM technical_plan_generation_config WHERE id = 1').get(), migrated);
      assert.deepEqual(store.loadGenerationConfig().contentGenerationOptions, { ...settings, imageQuantity: 30 });
      reopen();
      assert.deepEqual(database.db.prepare('SELECT * FROM technical_plan_generation_config WHERE id = 1').get(), migrated);
    }

    // 升级后的旧库仍能保存全部比例并正确回读，不再次产生数字文本。
    for (const imageQuantity of numericRatios) {
      store.saveContentGenerationOptions({ ...settings, imageQuantity });
      reopen();
      assertIntegerRatio(imageQuantity);
    }

    // 移除新增列后按 v32 重新打开，确认升级只补充默认比例。
    database.db.exec('ALTER TABLE technical_plan_generation_config DROP COLUMN image_quantity');
    database.db.pragma('user_version = 32');
    reopen();
    assert.deepEqual(store.loadGenerationConfig().contentGenerationOptions, { ...settings, imageQuantity: 30 });
    assertIntegerRatio(30);
    console.log('配图比例：新库默认值、11 档保存回读、v32 缺列升级、v35 文本/整数旧值统一重置为 30%、其他配置保留及重复启动检查通过。');
  } finally {
    database?.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

checkImageQuantity();
