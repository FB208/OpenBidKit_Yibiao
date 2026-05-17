const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { dialog } = require('electron');
const AdmZip = require('adm-zip');
const { getImportedImagesDir } = require('../utils/paths.cjs');

const parserLabels = {
  local: '本地解析',
  'mineru-accurate-api': 'MinerU 精准解析 API',
  'mineru-agent-api': 'MinerU-Agent 轻量解析 API',
};

const localSupportedExtensions = new Set(['.txt', '.md', '.markdown', '.docx', '.pdf', '.doc', '.wps']);
const mineruAgentSupportedExtensions = new Set([
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.jp2', '.webp', '.gif', '.bmp', '.xls', '.xlsx',
]);
const mineruAccurateSupportedExtensions = new Set([
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.jp2', '.webp', '.gif', '.bmp', '.html',
]);
const duplicateCheckSupportedExtensions = new Set(['.doc', '.docx', '.wps', '.pdf', '.md', '.markdown']);
const remoteImageTimeoutMs = 10000;
const markdownImagePattern = /!\[(?<alt>[^\]]*)\]\((?<target><[^>]+>|[^)\s]+)(?<title>\s+"[^"]*")?\)/gi;
const htmlImageSrcPattern = /(<img\b[^>]*?\bsrc=["'])(?<src>[^"']+)(["'][^>]*>)/gi;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSupportedExtensions(provider) {
  if (provider === 'mineru-agent-api') {
    return mineruAgentSupportedExtensions;
  }
  if (provider === 'mineru-accurate-api') {
    return mineruAccurateSupportedExtensions;
  }
  return localSupportedExtensions;
}

function getSelectableExtensions(provider) {
  if (provider === 'local') {
    return localSupportedExtensions;
  }
  return new Set([...getSupportedExtensions(provider), ...localSupportedExtensions]);
}

function resolveFileParser(config, filePath) {
  const requestedProvider = config.file_parser?.provider || 'local';
  const ext = path.extname(filePath).toLowerCase();
  const requestedSupported = getSupportedExtensions(requestedProvider).has(ext);
  if (requestedSupported) {
    return { provider: requestedProvider, requestedProvider, ext, supported: true, fallbackToLocal: false };
  }

  if (requestedProvider !== 'local' && localSupportedExtensions.has(ext)) {
    return { provider: 'local', requestedProvider, ext, supported: true, fallbackToLocal: true };
  }

  return { provider: requestedProvider, requestedProvider, ext, supported: false, fallbackToLocal: false };
}

async function parseLocalDocument(filePath, options = {}) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.txt') {
    return fs.readFile(filePath, 'utf-8');
  }

  const { convertPathToMarkdown } = await import('./doc2markdown/convert.mjs');
  return convertPathToMarkdown(filePath, { includeImages: options.preserveImages });
}

function formatImportError(error) {
  const rawMessage = error instanceof Error ? error.message : String(error || '未知错误');
  if (/Can't find end of central directory|is this a zip file/i.test(rawMessage)) {
    return '文件解析失败：该文件不是有效的 DOCX 文档，请用 Word/WPS 另存为标准 DOCX 后重试';
  }
  return `文件解析失败：${rawMessage || '未知错误'}`;
}

async function parseWithMineruAgent(filePath, options = {}) {
  const fileName = path.basename(filePath);
  const createResponse = await fetch('https://mineru.net/api/v1/agent/parse/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_name: fileName,
      language: 'ch',
      enable_table: true,
      is_ocr: true,
      enable_formula: true,
    }),
  });
  const createResult = await createResponse.json();
  if (!createResponse.ok || createResult.code !== 0) {
    throw new Error(`申请 MinerU-Agent 上传链接失败：HTTP ${createResponse.status}，${JSON.stringify(createResult)}`);
  }

  const taskId = createResult.data?.task_id;
  const fileUrl = createResult.data?.file_url;
  if (!taskId || !fileUrl) {
    throw new Error(`MinerU-Agent 响应缺少 task_id/file_url：${JSON.stringify(createResult)}`);
  }

  await uploadFile(fileUrl, filePath);
  const finalResult = await pollMineruAgent(taskId, fileName);
  const markdownUrl = finalResult.data.markdown_url;
  if (!markdownUrl) {
    throw new Error('MinerU-Agent 解析完成但未返回 markdown_url');
  }
  return downloadText(markdownUrl, '下载 MinerU-Agent Markdown 失败').then((markdown) => (
    options.preserveImages
      ? rewriteMarkdownImages(markdown, options.assets, { baseUrl: markdownUrl })
      : stripMarkdownImages(markdown)
  ));
}

async function pollMineruAgent(taskId, fileName) {
  const startedAt = Date.now();
  const timeoutMs = 300000;
  const intervalMs = 3000;

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(`https://mineru.net/api/v1/agent/parse/${taskId}`);
    const result = await response.json();
    if (!response.ok || result.code !== 0) {
      throw new Error(`查询 MinerU-Agent 任务失败：HTTP ${response.status}，${JSON.stringify(result)}`);
    }

    const data = result.data || {};
    if (data.state === 'done') {
      return { raw: result, data };
    }
    if (data.state === 'failed') {
      throw new Error(`MinerU-Agent 解析失败：${data.err_msg || '未知错误'}${data.err_code ? ` (${data.err_code})` : ''}`);
    }
    console.log(`WAIT ${fileName}: ${data.state || 'unknown'}`);
    await sleep(intervalMs);
  }

  throw new Error(`MinerU-Agent 轮询超时，请稍后重试，task_id: ${taskId}`);
}

async function parseWithMineruAccurate(filePath, token, options = {}) {
  if (!token) {
    throw new Error('请先在设置中填写 MinerU Token');
  }

  const fileName = path.basename(filePath);
  const createResponse = await fetch('https://mineru.net/api/v4/file-urls/batch', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: [{ name: fileName, data_id: makeDataId(fileName), is_ocr: true }],
      model_version: 'vlm',
      language: 'ch',
      enable_table: true,
      enable_formula: true,
    }),
  });
  const createResult = await createResponse.json();
  if (!createResponse.ok || createResult.code !== 0) {
    throw new Error(`申请 MinerU 精准解析上传链接失败：HTTP ${createResponse.status}，${JSON.stringify(createResult)}`);
  }

  const batchId = createResult.data?.batch_id;
  const fileUrl = createResult.data?.file_urls?.[0];
  if (!batchId || !fileUrl) {
    throw new Error(`MinerU 精准解析响应缺少 batch_id/file_url：${JSON.stringify(createResult)}`);
  }

  await uploadFile(fileUrl, filePath);
  const finalResult = await pollMineruAccurate(token, batchId, fileName);
  const fullZipUrl = finalResult.item.full_zip_url;
  if (!fullZipUrl) {
    throw new Error('MinerU 精准解析完成但未返回 full_zip_url');
  }
  const zipBuffer = await downloadBuffer(fullZipUrl);
  return extractMarkdownFromZip(zipBuffer, options);
}

async function pollMineruAccurate(token, batchId, fileName) {
  const startedAt = Date.now();
  const timeoutMs = 600000;
  const intervalMs = 5000;

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(`https://mineru.net/api/v4/extract-results/batch/${batchId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
    });
    const result = await response.json();
    if (!response.ok || result.code !== 0) {
      throw new Error(`查询 MinerU 精准解析任务失败：HTTP ${response.status}，${JSON.stringify(result)}`);
    }

    const items = result.data?.extract_result || [];
    const item = items.find((candidate) => candidate.file_name === fileName) || items[0];
    if (item?.state === 'done') {
      return { raw: result, item };
    }
    if (item?.state === 'failed') {
      throw new Error(`MinerU 精准解析失败：${item.err_msg || '未知错误'}`);
    }
    console.log(`WAIT ${fileName}: ${item?.state || 'unknown'}`);
    await sleep(intervalMs);
  }

  throw new Error(`MinerU 精准解析轮询超时，请稍后重试，batch_id: ${batchId}`);
}

async function uploadFile(fileUrl, filePath) {
  const buffer = await fs.readFile(filePath);
  const response = await fetch(fileUrl, { method: 'PUT', body: buffer });
  if (!response.ok) {
    throw new Error(`文件上传失败：HTTP ${response.status}，${await response.text()}`);
  }
}

async function downloadText(url, fallbackMessage) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${fallbackMessage}：HTTP ${response.status}`);
  }
  return response.text();
}

async function downloadBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载 MinerU 精准解析结果失败：HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function extractMarkdownFromZip(zipBuffer, options = {}) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  const fullMd = entries.find((entry) => /(^|[/\\])full\.md$/i.test(entry.entryName));
  const anyMd = entries.find((entry) => entry.entryName.toLowerCase().endsWith('.md'));
  const target = fullMd || anyMd;
  if (!target) {
    throw new Error('MinerU 精准解析结果 zip 中未找到 Markdown 文件');
  }
  const markdown = target.getData().toString('utf8');
  if (!options.preserveImages) {
    return stripMarkdownImages(markdown);
  }
  return rewriteMarkdownImages(markdown, options.assets, {
    zipEntries: entries,
    markdownEntryName: target.entryName,
  });
}

function makeDataId(fileName) {
  return fileName.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 96) || 'document';
}

async function createLocalFileSelection(filePath) {
  const stats = await fs.stat(filePath);
  const extension = path.extname(filePath).toLowerCase();
  return {
    id: crypto.createHash('sha1').update(filePath).digest('hex'),
    file_name: path.basename(filePath),
    file_path: filePath,
    extension,
    size: stats.size,
    modified_at: stats.mtime.toISOString(),
  };
}

function isPreserveImagesEnabled(config) {
  return config.file_parser?.preserve_images !== false;
}

function stripMarkdownImages(text) {
  return String(text || '')
    .replace(markdownImagePattern, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}

function createAssetContext(app, scope = 'documents') {
  if (!app?.getPath) return null;
  const safeScope = String(scope || 'documents').replace(/[^A-Za-z0-9._-]+/g, '_') || 'documents';
  const batchId = `${safeScope}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  return {
    baseDir: path.join(getImportedImagesDir(app), batchId),
    urlPrefix: `yibiao-asset://imported-images/${encodeURIComponent(batchId)}`,
    index: 0,
  };
}

async function deleteImportedImageAssets(assets) {
  if (!assets?.baseDir) return;
  await fs.rm(assets.baseDir, { recursive: true, force: true });
}

function imageExtensionFromMime(mime) {
  const normalized = String(mime || '').toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return '.jpg';
  if (normalized.includes('png')) return '.png';
  if (normalized.includes('gif')) return '.gif';
  if (normalized.includes('bmp')) return '.bmp';
  if (normalized.includes('webp')) return '.webp';
  return '';
}

function imageExtensionFromPath(value) {
  const ext = path.extname(String(value || '').split(/[?#]/)[0]).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(ext) ? (ext === '.jpeg' ? '.jpg' : ext) : '';
}

async function saveImportedImage(assets, buffer, sourceName, mime) {
  if (!assets || !buffer?.length) return null;
  const ext = imageExtensionFromMime(mime) || imageExtensionFromPath(sourceName) || '.png';
  assets.index += 1;
  const fileName = `image-${String(assets.index).padStart(4, '0')}${ext}`;
  await fs.mkdir(assets.baseDir, { recursive: true });
  await fs.writeFile(path.join(assets.baseDir, fileName), buffer);
  return `${assets.urlPrefix}/${encodeURIComponent(fileName)}`;
}

function cleanMarkdownImageTarget(target) {
  const value = String(target || '').trim();
  return value.startsWith('<') && value.endsWith('>') ? value.slice(1, -1) : value;
}

function parseDataUrl(value) {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(String(value || ''));
  if (!match) return null;
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') };
}

async function loadRemoteImage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remoteImageTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType && !/^image\//i.test(contentType)) return null;
    return { buffer: Buffer.from(await response.arrayBuffer()), mime: contentType };
  } finally {
    clearTimeout(timeout);
  }
}

function findZipEntryImage(zipEntries, imagePath, markdownEntryName) {
  let decodedPath = imagePath;
  try {
    decodedPath = decodeURIComponent(imagePath);
  } catch {
    decodedPath = imagePath;
  }
  const normalized = decodedPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const markdownDir = path.posix.dirname(String(markdownEntryName || '').replace(/\\/g, '/'));
  const candidates = [
    normalized,
    path.posix.normalize(path.posix.join(markdownDir === '.' ? '' : markdownDir, normalized)),
  ].map((item) => item.replace(/^\/+/, '').toLowerCase());
  const direct = zipEntries.find((entry) => candidates.includes(entry.entryName.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()));
  if (direct) return direct;
  const basename = path.posix.basename(normalized).toLowerCase();
  return zipEntries.find((entry) => path.posix.basename(entry.entryName.replace(/\\/g, '/')).toLowerCase() === basename);
}

function isPathInsideDirectory(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveImageToAssetUrl(source, assets, context = {}) {
  const value = cleanMarkdownImageTarget(source);
  if (!value) return null;
  if (/^yibiao-asset:\/\//i.test(value)) return value;

  const data = parseDataUrl(value);
  if (data) {
    return saveImportedImage(assets, data.buffer, 'data-image', data.mime);
  }

  if (/^https?:\/\//i.test(value) || context.baseUrl) {
    try {
      const url = /^https?:\/\//i.test(value) ? value : new URL(value, context.baseUrl).toString();
      const loaded = await loadRemoteImage(url);
      if (loaded) {
        return saveImportedImage(assets, loaded.buffer, url, loaded.mime);
      }
    } catch {
      return null;
    }
  }

  if (context.zipEntries) {
    const entry = findZipEntryImage(context.zipEntries, value, context.markdownEntryName);
    if (entry && !entry.isDirectory) {
      return saveImportedImage(assets, entry.getData(), entry.entryName, '');
    }
  }

  if (context.localBaseDir && !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    try {
      let decodedValue = value;
      try {
        decodedValue = decodeURIComponent(value);
      } catch {
        decodedValue = value;
      }
      if (path.isAbsolute(decodedValue)) {
        return null;
      }
      const baseDir = path.resolve(context.localBaseDir);
      const localPath = path.resolve(baseDir, decodedValue);
      if (!isPathInsideDirectory(baseDir, localPath)) {
        return null;
      }
      const buffer = await fs.readFile(localPath);
      return saveImportedImage(assets, buffer, localPath, '');
    } catch {
      return null;
    }
  }

  return null;
}

async function rewriteMarkdownImages(markdown, assets, context = {}) {
  let result = String(markdown || '');
  const markdownMatches = [...result.matchAll(markdownImagePattern)];
  for (const match of markdownMatches) {
    const nextUrl = await resolveImageToAssetUrl(match.groups?.target || '', assets, context);
    const alt = match.groups?.alt || '';
    const title = match.groups?.title || '';
    result = result.replace(match[0], nextUrl ? `![${alt}](${nextUrl}${title})` : '');
  }

  const htmlMatches = [...result.matchAll(htmlImageSrcPattern)];
  for (const match of htmlMatches) {
    const nextUrl = await resolveImageToAssetUrl(match.groups?.src || '', assets, context);
    result = result.replace(match[0], nextUrl ? `${match[1]}${nextUrl}${match[3]}` : '');
  }
  return result;
}

async function parseDocumentWithConfig(app, filePath, config, options = {}) {
  const parser = resolveFileParser(config, filePath);
  if (!parser.supported) {
    throw new Error(`当前${parserLabels[parser.requestedProvider] || '解析方式'}不支持该文件格式`);
  }
  const provider = parser.provider;
  const preserveImages = isPreserveImagesEnabled(config);
  const assets = preserveImages ? createAssetContext(app, options.assetScope || 'documents') : null;
  const parseOptions = { preserveImages, assets };
  let markdown = '';
  try {
    if (provider === 'mineru-agent-api') {
      markdown = await parseWithMineruAgent(filePath, parseOptions);
    } else if (provider === 'mineru-accurate-api') {
      markdown = await parseWithMineruAccurate(filePath, config.file_parser?.mineru_token || '', parseOptions);
    } else {
      markdown = await parseLocalDocument(filePath, parseOptions);
      markdown = preserveImages ? await rewriteMarkdownImages(markdown, assets, { localBaseDir: path.dirname(filePath) }) : stripMarkdownImages(markdown);
    }
  } catch (error) {
    await deleteImportedImageAssets(assets).catch(() => undefined);
    throw error;
  }
  return preserveImages ? markdown : stripMarkdownImages(markdown);
}

function createFileService({ app, configStore } = {}) {
  return {
    async importDocument() {
      const config = configStore ? configStore.load() : { file_parser: { provider: 'local' } };
      const provider = config.file_parser?.provider || 'local';
      const supportedExtensions = getSelectableExtensions(provider);
      const result = await dialog.showOpenDialog({
        title: '选择招标文件',
        properties: ['openFile'],
        filters: [
          { name: parserLabels[provider] || '招标文件', extensions: [...supportedExtensions].map((item) => item.slice(1)) },
          { name: '所有文件', extensions: ['*'] },
        ],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, message: '已取消选择' };
      }

      const filePath = result.filePaths[0];
      const ext = path.extname(filePath).toLowerCase();
      const parser = resolveFileParser(config, filePath);

      if (!supportedExtensions.has(ext)) {
        return { success: false, message: `当前${parserLabels[provider] || '解析方式'}不支持该文件格式` };
      }

      let fileContent = '';
      try {
        fileContent = (await parseDocumentWithConfig(app, filePath, config, { assetScope: 'technical-plan' })).trim();
      } catch (error) {
        return {
          success: false,
          message: formatImportError(error),
          file_name: path.basename(filePath),
          parser_provider: parser.provider,
          parser_label: parserLabels[parser.provider] || '本地解析',
        };
      }

      if (!fileContent) {
        return { success: false, message: '未提取到有效 Markdown 内容，请检查文件内容' };
      }

      return {
        success: true,
        message: parser.fallbackToLocal ? '文件解析完成，当前格式已自动使用本地解析' : '文件解析完成',
        file_content: fileContent,
        file_name: path.basename(filePath),
        parser_provider: parser.provider,
        parser_label: parserLabels[parser.provider] || '本地解析',
      };
    },

    async selectDuplicateCheckFiles(options = {}) {
      const multiple = options?.multiple !== false;
      const result = await dialog.showOpenDialog({
        title: multiple ? '选择投标文件' : '选择招标文件',
        properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: [
          { name: '标书文档', extensions: [...duplicateCheckSupportedExtensions].map((item) => item.slice(1)) },
          { name: '所有文件', extensions: ['*'] },
        ],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, message: '已取消选择', files: [] };
      }

      const supportedPaths = result.filePaths.filter((filePath) => duplicateCheckSupportedExtensions.has(path.extname(filePath).toLowerCase()));
      if (!supportedPaths.length) {
        return { success: false, message: '未选择支持的文件类型', files: [] };
      }

      const files = await Promise.all(supportedPaths.map(createLocalFileSelection));
      return {
        success: true,
        message: `已选择 ${files.length} 个文件`,
        files,
      };
    },
  };
}

module.exports = {
  createFileService,
  parseDocumentWithConfig,
  resolveFileParser,
};
