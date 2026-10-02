import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const DEFAULT_RELEASE_PREFIX = 'release';
const KEEP_VERSION_COUNT = 2;
const ASSET_CONCURRENCY = 3;

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optionalEnv(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function normalizePrefix(value) {
  return String(value || DEFAULT_RELEASE_PREFIX)
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function joinKey(prefix, fileName) {
  return prefix ? `${prefix}/${fileName}` : fileName;
}

function normalizePublicBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function createPublicUrl(publicBaseUrl, key) {
  const encodedKey = String(key)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${publicBaseUrl}/${encodedKey}`;
}

function contentTypeFromFileName(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'application/x-yaml; charset=utf-8';
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  if (lower.endsWith('.msi')) return 'application/octet-stream';
  if (lower.endsWith('.blockmap')) return 'application/octet-stream';
  return 'application/octet-stream';
}

function cacheControlFromFileName(fileName) {
  if (/^latest(?:-mac)?\.(?:yml|yaml|json)$/i.test(fileName)) {
    return 'no-cache';
  }
  return 'public, max-age=3600';
}

async function readGithubRelease(releaseJsonPath, tagName) {
  const raw = await fs.readFile(releaseJsonPath, 'utf-8');
  const release = JSON.parse(raw);
  if (!release.tagName && !release.tag_name) {
    release.tagName = tagName;
  }
  return release;
}

/** 根据构建时生成的文件清单发布索引，不重新下载或读取安装包。 */
function buildLatestJson({ assetMetadata, githubRelease, publicBaseUrl, prefix, tagName }) {
  const files = assetMetadata.map((asset) => {
    const key = joinKey(prefix, asset.name);
    return {
      name: asset.name,
      key,
      url: createPublicUrl(publicBaseUrl, key),
      size: asset.size,
      contentType: asset.contentType,
    };
  });

  const resolvedTagName = githubRelease.tagName || githubRelease.tag_name || tagName;
  const version = String(resolvedTagName || '').replace(/^v/i, '');
  return {
    version,
    tagName: resolvedTagName,
    name: githubRelease.name || resolvedTagName,
    body: githubRelease.body || '',
    isPrerelease: Boolean(githubRelease.isPrerelease),
    isDraft: Boolean(githubRelease.isDraft),
    githubReleaseUrl: githubRelease.url || '',
    releaseBaseUrl: prefix ? createPublicUrl(publicBaseUrl, prefix) : publicBaseUrl,
    files,
    generatedAt: new Date().toISOString(),
  };
}

function createR2Client({ accountId, accessKeyId, secretAccessKey }) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

async function putObject(client, bucket, key, filePath, fileName) {
  const stat = await fs.stat(filePath);
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: createReadStream(filePath),
    ContentLength: stat.size,
    ContentType: contentTypeFromFileName(fileName),
    CacheControl: cacheControlFromFileName(fileName),
  }));
  console.log(`Uploaded R2 object: ${key}`);
}

async function putJsonObject(client, bucket, key, value) {
  const body = JSON.stringify(value, null, 2);
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentLength: Buffer.byteLength(body),
    ContentType: 'application/json; charset=utf-8',
    CacheControl: 'no-cache',
  }));
  console.log(`Uploaded R2 object: ${key}`);
}

async function listR2Objects(client, bucket, prefix) {
  const objects = [];
  let continuationToken;
  do {
    const result = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix ? `${prefix}/` : '',
      ContinuationToken: continuationToken,
    }));
    objects.push(...(result.Contents || []));
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

function extractVersionFromKey(key, prefix) {
  const expectedPrefix = prefix ? `${prefix}/` : '';
  if (!key.startsWith(expectedPrefix)) return '';
  const fileName = key.slice(expectedPrefix.length);
  return fileName.match(/^Yibiao-(.+?)-(?:win|mac|linux)-/i)?.[1] || '';
}

function parseVersion(value) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.+)?$/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrereleaseSegment(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a.localeCompare(b);
}

function compareVersions(a, b) {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);
  if (!parsedA || !parsedB) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }

  for (const key of ['major', 'minor', 'patch']) {
    if (parsedA[key] !== parsedB[key]) return parsedA[key] - parsedB[key];
  }

  if (parsedA.prerelease.length === 0 && parsedB.prerelease.length === 0) return 0;
  if (parsedA.prerelease.length === 0) return 1;
  if (parsedB.prerelease.length === 0) return -1;

  const maxLength = Math.max(parsedA.prerelease.length, parsedB.prerelease.length);
  for (let index = 0; index < maxLength; index += 1) {
    const segmentA = parsedA.prerelease[index];
    const segmentB = parsedB.prerelease[index];
    if (segmentA === undefined) return -1;
    if (segmentB === undefined) return 1;
    const segmentResult = comparePrereleaseSegment(segmentA, segmentB);
    if (segmentResult !== 0) return segmentResult;
  }

  return 0;
}

function chooseObjectsToDelete(objects, prefix) {
  const releaseObjects = [];
  const versions = new Set();

  for (const object of objects) {
    const key = object.Key || '';
    const version = extractVersionFromKey(key, prefix);
    if (!version) continue;
    versions.add(version);
    releaseObjects.push({ key, version });
  }

  const keptVersions = new Set(
    [...versions]
      .sort(compareVersions)
      .slice(-KEEP_VERSION_COUNT),
  );
  const deletedKeys = releaseObjects
    .filter((object) => !keptVersions.has(object.version))
    .map((object) => object.key)
    .sort();

  return {
    keptVersions: [...keptVersions].sort(compareVersions).reverse(),
    deletedKeys,
  };
}

async function deleteR2Objects(client, bucket, keys) {
  for (let index = 0; index < keys.length; index += 1000) {
    const chunk = keys.slice(index, index + 1000);
    await client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: chunk.map((Key) => ({ Key })),
        Quiet: true,
      },
    }));
    for (const key of chunk) {
      console.log(`Deleted old R2 object: ${key}`);
    }
  }
}

/** 并发处理本平台文件，失败时停止派发并等待其余上传退出。 */
async function mapAssetFiles(filePaths, handler) {
  const results = new Array(filePaths.length);
  let nextIndex = 0;
  let failure = null;
  /** 每个 worker 领取并处理一个文件。 */
  async function worker() {
    while (!failure && nextIndex < filePaths.length) {
      const index = nextIndex++;
      try {
        results[index] = await handler(filePaths[index]);
      } catch (error) {
        failure ||= error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(ASSET_CONCURRENCY, filePaths.length) }, () => worker()));
  if (failure) throw failure;
  return results;
}

/** 在产物所在机器计算大小及 SHA256，供 R2 索引和 Gitee 下载表复用。 */
async function inspectAssetFile(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  const { size } = await fs.stat(filePath);
  const name = path.basename(filePath);
  return { name, size, sha256: hash.digest('hex'), contentType: contentTypeFromFileName(name) };
}

/** 保存仅包含文件信息的小型清单，后续任务无需安装包本体。 */
async function writeAssetManifest(tagName, files) {
  const manifestPath = requireEnv('RELEASE_ASSET_MANIFEST');
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify({ tagName, files }, null, 2), 'utf-8');
}

/** 创建已有 R2 上传配置，预发布版本不会调用此函数。 */
function readR2Context() {
  const accountId = requireEnv('R2_ACCOUNT_ID');
  const accessKeyId = requireEnv('R2_ACCESS_KEY_ID');
  const secretAccessKey = requireEnv('R2_SECRET_ACCESS_KEY');
  const bucket = requireEnv('R2_BUCKET');
  const prefix = normalizePrefix(optionalEnv('R2_RELEASE_PREFIX', DEFAULT_RELEASE_PREFIX));
  const client = createR2Client({ accountId, accessKeyId, secretAccessKey });
  return { client, bucket, prefix };
}

/** 构建阶段只上传当前平台附件，更新清单和旧版本清理由收尾阶段处理。 */
async function uploadBuildAssets({ filePaths, githubRelease, tagName }) {
  const context = githubRelease.isPrerelease ? null : readR2Context();
  const files = await mapAssetFiles(filePaths, async (filePath) => {
    const [metadata] = await Promise.all([
      inspectAssetFile(filePath),
      context && putObject(context.client, context.bucket, joinKey(context.prefix, path.basename(filePath)), filePath, path.basename(filePath)),
    ]);
    return metadata;
  });
  await writeAssetManifest(tagName, files);
  console.log(`Build asset manifest saved: ${tagName}, files=${files.length}, R2=${context ? 'uploaded' : 'prerelease skipped'}`);
}

/** 合并三个平台的文件信息，补入最终更新清单。 */
async function collectAssetMetadata(tagName, manifestFiles) {
  const metadataDir = requireEnv('RELEASE_METADATA_DIR');
  const manifests = await Promise.all(['windows', 'macos-x64', 'macos-arm64'].map(async (platform) => {
    const filePath = path.join(metadataDir, `release-metadata-${platform}`, 'assets.json');
    const manifest = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    if (manifest.tagName !== tagName) throw new Error(`Release asset manifest tag mismatch: ${platform}`);
    return manifest.files;
  }));
  const files = [...manifests.flat(), ...await mapAssetFiles(manifestFiles, inspectAssetFile)];
  const names = new Set();
  for (const file of files) {
    if (names.has(file.name)) throw new Error(`Duplicate release asset: ${file.name}`);
    names.add(file.name);
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** 全部平台成功后一次性发布更新清单、latest.json，并沿用旧版本清理规则。 */
async function finalizeRelease({ filePaths, githubRelease, tagName }) {
  const assetMetadata = await collectAssetMetadata(tagName, filePaths);
  await writeAssetManifest(tagName, assetMetadata);
  if (githubRelease.isPrerelease) {
    console.log(`Skipping R2 publication for prerelease: ${tagName}`);
    return;
  }
  const { client, bucket, prefix } = readR2Context();
  const publicBaseUrl = normalizePublicBaseUrl(requireEnv('R2_PUBLIC_BASE_URL'));
  await mapAssetFiles(filePaths, (filePath) => putObject(client, bucket, joinKey(prefix, path.basename(filePath)), filePath, path.basename(filePath)));
  const latestJson = buildLatestJson({ assetMetadata, githubRelease, publicBaseUrl, prefix, tagName });
  await putJsonObject(client, bucket, joinKey(prefix, 'latest.json'), latestJson);

  const objects = await listR2Objects(client, bucket, prefix);
  const { keptVersions, deletedKeys } = chooseObjectsToDelete(objects, prefix);
  console.log(`Keeping release versions: ${keptVersions.join(', ') || '(none)'}.`);

  if (deletedKeys.length > 0) {
    await deleteR2Objects(client, bucket, deletedKeys);
  } else {
    console.log('No old R2 release objects to delete.');
  }

  console.log(`R2 release published: ${latestJson.tagName}`);
}

/** 执行构建机直接上传或仅含小型清单文件的最终发布。 */
async function main() {
  const tagName = requireEnv('TAG_NAME');
  const githubRelease = await readGithubRelease(requireEnv('GITHUB_RELEASE_JSON'), tagName);
  if (githubRelease.tagName !== tagName || githubRelease.isDraft) {
    throw new Error(`GitHub Release must be published and match tag ${tagName}.`);
  }
  const filePaths = process.argv.slice(3);
  if (filePaths.length === 0) throw new Error('No local release files supplied.');
  if (process.argv[2] === '--upload') {
    await uploadBuildAssets({ filePaths, githubRelease, tagName });
  } else if (process.argv[2] === '--finalize') {
    await finalizeRelease({ filePaths, githubRelease, tagName });
  } else {
    throw new Error('Expected --upload <files...> or --finalize <manifests...>.');
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
