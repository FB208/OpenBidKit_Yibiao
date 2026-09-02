const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadRegisterFunction(ipcMain) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return { ipcMain };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('./duplicateCheckIpc.cjs')];
    return require('./duplicateCheckIpc.cjs').registerDuplicateCheckIpc;
  } finally {
    Module._load = originalLoad;
  }
}

test('标书查重 Excel IPC 原样转发当前文件集合签名', async () => {
  const handlers = new Map();
  const registerDuplicateCheckIpc = loadRegisterFunction({
    handle: (channel, handler) => handlers.set(channel, handler),
  });
  let receivedRequest;
  registerDuplicateCheckIpc({
    duplicateCheckStore: {
      loadDuplicateCheck: () => ({}),
      saveFiles: () => undefined,
      saveUiState: () => undefined,
      updateDuplicateCheckWithoutReload: () => undefined,
      clearDuplicateCheck: () => undefined,
    },
    checkResultExportService: {
      exportDuplicateExcel: async (request) => {
        receivedRequest = request;
        return { success: true, path: 'D:\\查重结果.xlsx' };
      },
    },
  });

  assert.equal(handlers.has('duplicate-check:export-excel'), true);
  const request = { signature: 'current-signature' };
  const result = await handlers.get('duplicate-check:export-excel')({}, request);
  assert.deepEqual(receivedRequest, request);
  assert.deepEqual(result, { success: true, path: 'D:\\查重结果.xlsx' });
});
