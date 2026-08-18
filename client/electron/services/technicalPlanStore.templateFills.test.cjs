const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSqliteDatabase } = require('./sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('./technicalPlanStore.cjs');

function createFixture() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-store-fills-'));
  const app = { getPath: () => userDataDir, once: () => {} };
  const database = createSqliteDatabase(app);
  const store = createTechnicalPlanStore({
    app,
    db: database.db,
    fileService: {},
    agentService: { deletePersistentTask: () => {} },
    taskLogStore: { sync: () => {}, list: () => [] },
  });
  return { store, userDataDir, database };
}

function leaf(id, title, mode = 'ai-generate') {
  return { id, title, description: '', content_mode: mode };
}

function seedFill(store, nodeId) {
  const relativePath = `technical-plan/template-fills/${nodeId}.docx`;
  const absolutePath = path.join(store.getTemplateFillsDir(), `${nodeId}.docx`);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `snapshot:${nodeId}`, 'utf-8');
  store.updateTechnicalPlan({
    templateFills: {
      [nodeId]: {
        nodeId,
        status: 'success',
        previewText: `预览:${nodeId}`,
        snapshotRelPath: relativePath,
      },
    },
  });
}

function snapshotExists(store, nodeId) {
  return fs.existsSync(path.join(store.getTemplateFillsDir(), `${nodeId}.docx`));
}

test('saveOutline replace 清空全部 template fills 并删除快照目录', () => {
  const { store, userDataDir, database } = createFixture();
  try {
    const outline = { project_name: 'p', outline: [
      { id: '1', title: '一', description: '', content_mode: 'ai-generate', children: [leaf('1.1', '1.1 小节')] },
      { id: '2', title: '二', description: '', content_mode: 'ai-generate', children: [leaf('2.1', '2.1 小节')] },
    ] };
    store.saveOutline({ outlineData: outline, reason: 'replace' });
    seedFill(store, '1.1');
    seedFill(store, '2.1');
    assert.equal(Object.keys(store.getTemplateFills()).length, 2);

    store.saveOutline({
      outlineData: {
        project_name: 'p',
        outline: [
          { id: '1', title: '新一', description: '', content_mode: 'ai-generate', children: [leaf('1.1', '新 1.1 小节')] },
        ],
      },
      reason: 'replace',
    });

    assert.deepEqual(store.getTemplateFills(), {});
    assert.equal(fs.existsSync(store.getTemplateFillsDir()), false);
  } finally {
    database.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('saveOutline edit 只失效受影响节点，其余 fills 保留', () => {
  const { store, userDataDir, database } = createFixture();
  try {
    const outline = { project_name: 'p', outline: [
      { id: '1', title: '一', description: '', content_mode: 'ai-generate', children: [leaf('1.1', '1.1 小节', 'template-fill')] },
      { id: '2', title: '二', description: '', content_mode: 'ai-generate', children: [leaf('2.1', '2.1 小节', 'template-fill')] },
    ] };
    store.saveOutline({ outlineData: outline, reason: 'replace' });
    seedFill(store, '1.1');
    seedFill(store, '2.1');

    const edited = { project_name: 'p', outline: [
      { id: '1', title: '一（改）', description: '改了描述', content_mode: 'ai-generate', children: [leaf('1.1', '1.1 小节改名', 'template-fill')] },
      outline.outline[1],
    ] };
    const result = store.saveOutline({ outlineData: edited, reason: 'edit', affectedNodeIds: ['1.1'] });

    const fills = store.getTemplateFills();
    assert.equal(fills['1.1'], undefined);
    assert.equal(snapshotExists(store, '1.1'), false);
    assert.equal(fills['2.1']?.status, 'success');
    assert.equal(snapshotExists(store, '2.1'), true);
    assert.equal(result.templateFills['2.1']?.status, 'success');
    assert.equal(result.templateFills['1.1'], undefined);
  } finally {
    database.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('saveOutline delete 失效被删子树，重编号兄弟节点的 fills 跟随 idMap 保留', () => {
  const { store, userDataDir, database } = createFixture();
  try {
    const outline = { project_name: 'p', outline: [
      { id: '1', title: '一', description: '', content_mode: 'ai-generate', children: [
        leaf('1.1', '1.1 小节', 'template-fill'),
        leaf('1.2', '1.2 小节', 'template-fill'),
      ] },
    ] };
    store.saveOutline({ outlineData: outline, reason: 'replace' });
    seedFill(store, '1.1');
    seedFill(store, '1.2');

    // 删除 1.1，1.2 重编号为 1.1：旧 1.1 的 fill 必须失效，原 1.2 的 fill 必须保留到新编号上
    const afterDelete = { project_name: 'p', outline: [
      { id: '1', title: '一', description: '', content_mode: 'ai-generate', children: [leaf('1.1', '1.2 小节', 'template-fill')] },
    ] };
    const result = store.saveOutline({
      outlineData: afterDelete,
      reason: 'delete',
      affectedNodeIds: ['1.1'],
      idMap: { '1.2': '1.1' },
    });

    const fills = store.getTemplateFills();
    assert.equal(fills['1.1']?.previewText, '预览:1.2');
    assert.equal(result.templateFills['1.1']?.previewText, '预览:1.2');
    assert.equal(Object.keys(fills).length, 1);
    // 原 1.1 的快照文件（快照名 1.1.docx）被删，原 1.2 的快照文件（1.2.docx）保留
    assert.equal(snapshotExists(store, '1.1'), false);
    assert.equal(snapshotExists(store, '1.2'), true);
  } finally {
    database.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('saveOutline sort 重映射 fills 主键且不失效，返回值带最新 templateFills', () => {
  const { store, userDataDir, database } = createFixture();
  try {
    const outline = { project_name: 'p', outline: [
      { id: '1', title: '一', description: '', content_mode: 'ai-generate', children: [
        leaf('1.1', '1.1 小节', 'template-fill'),
        leaf('1.2', '1.2 小节', 'template-fill'),
      ] },
    ] };
    store.saveOutline({ outlineData: outline, reason: 'replace' });
    seedFill(store, '1.1');
    seedFill(store, '1.2');

    // 1.1 与 1.2 互换：idMap 1.1->1.2, 1.2->1.1
    const sorted = { project_name: 'p', outline: [
      { id: '1', title: '一', description: '', content_mode: 'ai-generate', children: [
        leaf('1.1', '1.2 小节', 'template-fill'),
        leaf('1.2', '1.1 小节', 'template-fill'),
      ] },
    ] };
    const result = store.saveOutline({
      outlineData: sorted,
      reason: 'sort',
      idMap: { '1.1': '1.2', '1.2': '1.1' },
    });

    const fills = store.getTemplateFills();
    assert.equal(fills['1.1']?.previewText, '预览:1.2');
    assert.equal(fills['1.2']?.previewText, '预览:1.1');
    assert.equal(result.templateFills['1.1']?.previewText, '预览:1.2');
    assert.equal(result.templateFills['1.2']?.previewText, '预览:1.1');
    assert.equal(snapshotExists(store, '1.1'), true);
    assert.equal(snapshotExists(store, '1.2'), true);
  } finally {
    database.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
