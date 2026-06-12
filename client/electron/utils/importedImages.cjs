const fs = require('node:fs');
const path = require('node:path');
const { getImportedImagesDir } = require('./paths.cjs');

function isPathInsideDirectory(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeImportedImageScope(scope) {
  return String(scope || '').trim().replace(/[^A-Za-z0-9._-]+/g, '_');
}

function removeImportedImageBatchDir(baseDir, entryName) {
  const targetPath = path.resolve(baseDir, entryName);
  if (!isPathInsideDirectory(baseDir, targetPath) || targetPath === baseDir) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function deleteImportedImageBatches(app, scopePrefix) {
  const prefix = String(scopePrefix || '').trim();
  if (!prefix || !app?.getPath) return;

  const baseDir = path.resolve(getImportedImagesDir(app));
  if (!fs.existsSync(baseDir)) return;

  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== prefix && !entry.name.startsWith(`${prefix}-`)) continue;
    removeImportedImageBatchDir(baseDir, entry.name);
  }
}

function deleteImportedImageBatchesForExactScope(app, scope) {
  const safeScope = normalizeImportedImageScope(scope);
  if (!safeScope || !app?.getPath) return;

  const baseDir = path.resolve(getImportedImagesDir(app));
  if (!fs.existsSync(baseDir)) return;

  const exactBatchPattern = new RegExp(`^${safeScope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{10,}-[0-9a-f]{8}$`, 'i');
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!exactBatchPattern.test(entry.name)) continue;
    removeImportedImageBatchDir(baseDir, entry.name);
  }
}

module.exports = {
  deleteImportedImageBatches,
  deleteImportedImageBatchesForExactScope,
};
