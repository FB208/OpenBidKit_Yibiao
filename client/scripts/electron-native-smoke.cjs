const { app } = require('electron');

function exitWithCode(code) {
  if (app?.isReady?.()) {
    app.exit(code);
    return;
  }
  process.exit(code);
}

function runSmoke() {
  try {
    console.log(`[native-smoke] electron=${process.versions.electron || 'unknown'} node=${process.versions.node} modules=${process.versions.modules} platform=${process.platform} arch=${process.arch}`);
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    try {
      const row = db.prepare('SELECT 1 AS ok').get();
      if (!row || row.ok !== 1) {
        throw new Error(`Unexpected SQLite result: ${JSON.stringify(row)}`);
      }
    } finally {
      db.close();
    }
    console.log('[native-smoke] better-sqlite3 loaded and queried successfully.');
    exitWithCode(0);
  } catch (error) {
    console.error('[native-smoke] Electron native dependency smoke test failed.');
    console.error(error?.stack || error?.message || String(error));
    exitWithCode(1);
  }
}

if (app?.whenReady) {
  app.whenReady().then(runSmoke, (error) => {
    console.error('[native-smoke] Electron app failed to become ready.');
    console.error(error?.stack || error?.message || String(error));
    exitWithCode(1);
  });
} else {
  runSmoke();
}
