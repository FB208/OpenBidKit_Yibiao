const fs = require('node:fs');
const path = require('node:path');
const { getImportedImagesDir } = require('./paths.cjs');

function isPathInsideDirectory(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function deleteImportedImageBatches(app, scopePrefix) {
  const prefix = String(scopePrefix || '').trim();
  if (!prefix || !app?.getPath) return;

  const baseDir = path.resolve(getImportedImagesDir(app));
  if (!fs.existsSync(baseDir)) return;

  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== prefix && !entry.name.startsWith(`${prefix}-`)) continue;

    const targetPath = path.resolve(baseDir, entry.name);
    if (!isPathInsideDirectory(baseDir, targetPath) || targetPath === baseDir) continue;
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

module.exports = {
  deleteImportedImageBatches,
};
