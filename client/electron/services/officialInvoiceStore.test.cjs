// 运行：ELECTRON_RUN_AS_NODE=1 npx electron --test electron/services/officialInvoiceStore.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { createSqliteDatabase, schemaVersion } = require('./sqliteDatabase.cjs');
const { createOfficialInvoiceStore } = require('./officialInvoiceStore.cjs');

// 从固定的已发布 main 提交生成真实旧库；运行升级测试需保留该 Git 历史。
function loadPublishedMainDatabase() {
  const source = execFileSync('git', [
    'show', '4b4680faf56495e6e81cbe121be09bf51b886f1c:client/electron/services/sqliteDatabase.cjs',
  ], { cwd: __dirname, encoding: 'utf8' });
  const filename = path.join(__dirname, 'published-main-database.cjs');
  const historicalModule = new Module(filename);
  historicalModule.filename = filename;
  historicalModule.paths = Module._nodeModulePaths(__dirname);
  historicalModule._compile(source, filename);
  assert.equal(historicalModule.exports.schemaVersion, 24);
  return historicalModule.exports.createSqliteDatabase;
}

// 检查此次合并新增的结构及统一配置迁移应移除的旧存储。
function assertMergedSchema(db) {
  assert.equal(db.pragma('user_version', { simple: true }), schemaVersion);
  for (const table of [
    'official_invoice_info', 'technical_plan_generation_config',
    'technical_plan_generation_bid_tasks', 'technical_plan_generation_reference_docs',
    'credential_library_profile', 'credential_library_certificates',
    'credential_library_employees', 'credential_library_projects',
    'credential_library_other_materials', 'credential_library_images',
  ]) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
  }
  const configColumns = db.prepare('PRAGMA table_info(technical_plan_generation_config)').all().map((row) => row.name);
  for (const column of ['outline_mode', 'export_template_id', 'export_template_scope', 'image_quantity']) {
    assert.ok(configColumns.includes(column), column);
  }
  assert.ok(!configColumns.includes('content_generation_template_id'));
  assert.ok(db.prepare('PRAGMA table_info(credential_library_employees)').all().some((row) => row.name === 'id_validity_mode'));
  assert.ok(db.prepare('PRAGMA table_info(export_templates)').all().some((row) => row.name === 'is_system'));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'technical_plan_reference_docs'").get(), undefined);
  const metaColumns = db.prepare('PRAGMA table_info(technical_plan_meta)').all().map((row) => row.name);
  for (const column of [
    'bid_analysis_mode', 'bid_analysis_selected_task_ids_json', 'bid_section_mode',
    'outline_mode', 'outline_expansion_mode', 'global_facts_mode',
    'outline_word_control_options_json', 'content_generation_options_json',
  ]) {
    assert.ok(!metaColumns.includes(column), column);
  }
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
}

test('开票信息支持空白读取、企业与个人覆盖保存及重新打开数据库恢复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '易标-开票-'));
  const app = { getPath: () => dir, once() {} };
  let database;
  try {
    database = createSqliteDatabase(app);
    assertMergedSchema(database.db);
    let store = createOfficialInvoiceStore({ db: database.db });
    assert.deepEqual(store.get(), { titleType: 'enterprise', buyer: '', taxNumber: '', email: '' });
    const enterprise = { titleType: 'enterprise', buyer: '示例企业', taxNumber: '91310000TEST1234567', email: 'invoice@example.com' };
    store.save(enterprise);
    database.close();
    database = createSqliteDatabase(app);
    store = createOfficialInvoiceStore({ db: database.db });
    assert.deepEqual(store.get(), enterprise);
    const individual = { titleType: 'individual', buyer: '张三', taxNumber: '', email: 'person@example.com' };
    store.save(individual);
    assert.deepEqual(store.get(), individual);
    assert.equal(database.db.prepare('SELECT count(*) AS count FROM official_invoice_info').get().count, 1);
  } finally {
    database?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const fromVersion of [23, 24]) {
  test(`main v${fromVersion} 升级完整执行分支迁移并保留开票信息与正文`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '易标-合并升级-'));
    const app = { getPath: () => dir, once() {} };
    let database;
    try {
      database = loadPublishedMainDatabase()(app);
      // main 的 v24 仅增加开票表，移除此表即还原 v23 结构。
      if (fromVersion === 23) {
        database.db.exec('DROP TABLE official_invoice_info; PRAGMA user_version = 23;');
      }
      const invoice = { titleType: 'enterprise', buyer: '升级验证企业', taxNumber: 'TEST24', email: 'test@example.com' };
      if (fromVersion === 24) createOfficialInvoiceStore({ db: database.db }).save(invoice);
      database.db.exec(`
        INSERT INTO technical_plan_meta
          (id, tender_file_name, outline_mode, outline_word_control_options_json, created_at, updated_at)
          VALUES (1, '原招标文件.docx', 'standalone-technical', '{"minimumWords":30000}', '2026-09-18', '2026-09-18');
        INSERT INTO technical_plan_reference_docs (document_id, sort_order) VALUES ('旧参考选择', 0);
        INSERT INTO technical_plan_outline_nodes (node_id, sort_order, level, title, content, created_at, updated_at)
          VALUES ('1', 0, 1, '原有目录', '原有正文保持完整。', '2026-09-18', '2026-09-18');
      `);
      const before = database.db.prepare('SELECT * FROM technical_plan_outline_nodes').all();
      database.close();
      const executed = [];
      database = createSqliteDatabase(app, { onStatus(status) {
        if (status.phase === 'upgrading') executed.push(status.migrationVersion);
      } });
      assert.deepEqual(executed, Array.from({ length: 33 - fromVersion }, (_, index) => fromVersion + index + 1));
      assertMergedSchema(database.db);
      assert.deepEqual(database.db.prepare('SELECT * FROM technical_plan_outline_nodes').all(), before);
      assert.equal(database.db.prepare('SELECT tender_file_name FROM technical_plan_meta').get().tender_file_name, '原招标文件.docx');
      // 既有策略重置旧生成设置，不将旧配置值复制进新表。
      assert.equal(database.db.prepare('SELECT count(*) AS count FROM technical_plan_generation_config').get().count, 0);
      if (fromVersion === 24) assert.deepEqual(createOfficialInvoiceStore({ db: database.db }).get(), invoice);
      createOfficialInvoiceStore({ db: database.db }).save(invoice);
      database.close();
      executed.length = 0;
      database = createSqliteDatabase(app, { onStatus(status) {
        if (status.phase === 'upgrading') executed.push(status.migrationVersion);
      } });
      assert.deepEqual(executed, []);
      assertMergedSchema(database.db);
      assert.deepEqual(database.db.prepare('SELECT * FROM technical_plan_outline_nodes').all(), before);
      assert.deepEqual(createOfficialInvoiceStore({ db: database.db }).get(), invoice);
    } finally {
      database?.close();
      assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
