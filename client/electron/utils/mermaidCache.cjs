const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getGeneratedImagesDir } = require('./paths.cjs');

const MERMAID_CACHE_DIR_NAME = 'mermaid-cache';
const MERMAID_CACHE_VERSION = 1;
const MERMAID_CACHE_OUTPUT_TYPE = 'png';
const MERMAID_CACHE_THEME = 'default';
const MERMAID_CACHE_BG_COLOR = '!white';

function normalizeMermaidCode(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function createMermaidCacheHash(code, options = {}) {
  const payload = {
    version: MERMAID_CACHE_VERSION,
    outputType: MERMAID_CACHE_OUTPUT_TYPE,
    theme: options.theme || MERMAID_CACHE_THEME,
    bgColor: options.bgColor || MERMAID_CACHE_BG_COLOR,
    code: normalizeMermaidCode(code),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function getMermaidCacheDir(app) {
  return path.join(getGeneratedImagesDir(app), MERMAID_CACHE_DIR_NAME);
}

function getMermaidCacheFilePath(app, hash) {
  return path.join(getMermaidCacheDir(app), `${hash}.png`);
}

function getMermaidCacheAssetUrl(hash) {
  return `yibiao-asset://generated-images/${encodeURIComponent(MERMAID_CACHE_DIR_NAME)}/${encodeURIComponent(`${hash}.png`)}`;
}

function getMermaidCacheEntry(app, code, options = {}) {
  const normalizedCode = normalizeMermaidCode(code);
  const hash = createMermaidCacheHash(normalizedCode, options);
  const filePath = getMermaidCacheFilePath(app, hash);
  return {
    hash,
    code: normalizedCode,
    filePath,
    assetUrl: getMermaidCacheAssetUrl(hash),
    exists: fs.existsSync(filePath),
  };
}

function saveMermaidCacheImage(app, hash, buffer) {
  if (!buffer?.length) return null;
  const cacheDir = getMermaidCacheDir(app);
  fs.mkdirSync(cacheDir, { recursive: true });
  const filePath = getMermaidCacheFilePath(app, hash);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  fs.renameSync(tempPath, filePath);
  return {
    filePath,
    assetUrl: getMermaidCacheAssetUrl(hash),
  };
}

function clearMermaidCache(app) {
  const cacheDir = getMermaidCacheDir(app);
  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

module.exports = {
  clearMermaidCache,
  getMermaidCacheEntry,
  getMermaidCacheDir,
  getMermaidCacheAssetUrl,
  normalizeMermaidCode,
  saveMermaidCacheImage,
};
