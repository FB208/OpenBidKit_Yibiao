// 运行：ELECTRON_RUN_AS_NODE=1 npx electron --test electron/services/officialInvoiceStore.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSqliteDatabase } = require('./sqliteDatabase.cjs');
const { createOfficialInvoiceStore } = require('./officialInvoiceStore.cjs');

test('开票信息支持空白读取、企业与个人覆盖保存及重新打开数据库恢复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '易标-开票-'));
  const app = { getPath: () => dir, once() {} };
  let database;
  try {
    database = createSqliteDatabase(app);
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
