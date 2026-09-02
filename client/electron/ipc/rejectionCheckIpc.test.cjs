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
    delete require.cache[require.resolve('./rejectionCheckIpc.cjs')];
    return require('./rejectionCheckIpc.cjs').registerRejectionCheckIpc;
  } finally {
    Module._load = originalLoad;
  }
}

test('废标检查 Excel IPC 原样转发当前签名请求', async () => {
  const handlers = new Map();
  const registerRejectionCheckIpc = loadRegisterFunction({
    handle: (channel, handler) => handlers.set(channel, handler),
  });
  let receivedRequest;
  registerRejectionCheckIpc({
    rejectionCheckStore: {
      loadRejectionCheck: () => ({}),
      saveUiState: () => undefined,
      updateRejectionCheckWithoutReload: () => undefined,
    },
    taskService: {
      importRejectionCheckDocument: () => undefined,
      importRejectionCheckTenderFromTechnicalPlan: () => undefined,
      removeRejectionCheckDocument: () => undefined,
      resetRejectionCheck: () => undefined,
    },
    checkResultExportService: {
      exportRejectionExcel: async (request) => {
        receivedRequest = request;
        return { success: true, path: 'D:\\结果.xlsx' };
      },
    },
  });

  assert.equal(handlers.has('rejection-check:export-excel'), true);
  const request = { rejectionInputSignature: 'rejection-current', bidSignature: 'bid-current' };
  const result = await handlers.get('rejection-check:export-excel')({}, request);
  assert.deepEqual(receivedRequest, request);
  assert.deepEqual(result, { success: true, path: 'D:\\结果.xlsx' });
});
