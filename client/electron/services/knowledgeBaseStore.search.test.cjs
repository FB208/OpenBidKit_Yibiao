const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createKnowledgeBaseStore } = require('./knowledgeBaseStore.cjs');

function createFixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE knowledge_folders (
      folder_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_documents (
      document_id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      status TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      title TEXT NOT NULL,
      resume TEXT NOT NULL,
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare('INSERT INTO knowledge_folders VALUES (?, ?, 0, ?, ?)').run('folder-a', '项目资料', '2026-01-01', '2026-01-01');
  db.prepare('INSERT INTO knowledge_folders VALUES (?, ?, 1, ?, ?)').run('folder-b', '历史标书', '2026-01-01', '2026-01-01');
  db.prepare('INSERT INTO knowledge_documents VALUES (?, ?, ?, ?, 0, ?)').run('doc-a', 'folder-a', '实施方案.docx', 'success', '2026-02-01');
  db.prepare('INSERT INTO knowledge_documents VALUES (?, ?, ?, ?, 0, ?)').run('doc-b', 'folder-b', '运维说明.docx', 'success', '2026-01-15');
  db.prepare('INSERT INTO knowledge_documents VALUES (?, ?, ?, ?, 0, ?)').run('doc-c', 'folder-b', '处理中.docx', 'matching', '2026-03-01');
  const insertItem = db.prepare('INSERT INTO knowledge_items (document_id, item_id, title, resume, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  insertItem.run('doc-a', 'A-1', '质量保证体系', '覆盖质量目标和检查机制', '方案正文包含质量保证关键字。', 0);
  insertItem.run('doc-b', 'B-1', '运维流程', '提供质量保证服务', '正文不含目标词。', 0);
  insertItem.run('doc-c', 'C-1', '质量保证草稿', '处理中内容', '不应被检索', 0);
  const app = { getPath: () => path.join(os.tmpdir(), 'knowledge-search-test') };
  return { db, store: createKnowledgeBaseStore({ app, db }) };
}

test('search returns a successful document when its file name matches', () => {
  const { db, store } = createFixture();
  try {
    const results = store.search('实施方案');
    assert.equal(results.length, 1);
    assert.equal(results[0].match_field, 'file_name');
    assert.equal(results[0].file_name, '实施方案.docx');
  } finally {
    db.close();
  }
});

test('search returns matches across successful knowledge documents with title matches first', () => {
  const { db, store } = createFixture();
  try {
    const results = store.search('质量保证');
    assert.deepEqual(results.map((item) => item.item_id), ['A-1', 'B-1']);
    assert.equal(results[0].match_field, 'title');
    assert.equal(results[0].folder_name, '项目资料');
    assert.equal(results[1].match_field, 'resume');
    assert.match(results[1].snippet, /质量保证/);
  } finally {
    db.close();
  }
});


test('search ignores unfinished documents and blank keywords', () => {
  const { db, store } = createFixture();
  try {
    assert.equal(store.search('草稿').length, 0);
    assert.deepEqual(store.search('  '), []);
  } finally {
    db.close();
  }
});
