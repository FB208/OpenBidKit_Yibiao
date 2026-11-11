const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const MAX_REDIRECTS = 5;

function requestModuleForUrl(url) {
  if (url.protocol === 'https:') return https;
  if (url.protocol === 'http:') return http;
  throw new Error(`不支持的下载地址协议：${url.protocol}`);
}

/**
 * 下载文件到指定路径：先写临时文件，完成后替换目标文件。
 * options.expectedSize 大于 0 时校验大小；onProgress 收到 0-100 的百分比；
 * label 是错误文案里的文件称呼，incompleteMessage 可覆盖大小不符时的提示。
 */
function downloadFile(url, destinationPath, options = {}, redirectCount = 0) {
  const { expectedSize = 0, onProgress, label = '文件' } = options;
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error(`${label}下载地址无效`));
      return;
    }

    let settled = false;
    let tempPath = '';
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (tempPath) {
        try { fs.rmSync(tempPath, { force: true }); } catch {}
      }
      reject(error);
    };

    let request;
    try {
      request = requestModuleForUrl(parsedUrl).get(parsedUrl, { headers: { 'User-Agent': 'yibiao-client' } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirectCount >= MAX_REDIRECTS) {
            fail(new Error(`${label}下载重定向次数过多`));
            return;
          }
          downloadFile(new URL(response.headers.location, parsedUrl).toString(), destinationPath, options, redirectCount + 1)
            .then(resolve, reject);
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          fail(new Error(`${label}下载失败：${response.statusCode}`));
          return;
        }

        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        tempPath = `${destinationPath}.${process.pid}.${Date.now()}.tmp`;
        const output = fs.createWriteStream(tempPath);
        const total = Number(response.headers['content-length'] || expectedSize || 0);
        let downloaded = 0;

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            onProgress?.(Math.max(0, Math.min(100, (downloaded / total) * 100)));
          }
        });
        response.on('error', fail);
        output.on('error', fail);
        output.on('finish', () => {
          output.close(() => {
            try {
              fs.rmSync(destinationPath, { force: true });
              fs.renameSync(tempPath, destinationPath);
              tempPath = '';
              if (expectedSize && fs.statSync(destinationPath).size !== expectedSize) {
                throw new Error(options.incompleteMessage || `${label}下载不完整，请重试`);
              }
              onProgress?.(100);
              settled = true;
              resolve(destinationPath);
            } catch (error) {
              if (!tempPath) {
                try { fs.rmSync(destinationPath, { force: true }); } catch {}
              }
              fail(error);
            }
          });
        });

        response.pipe(output);
      });
    } catch (error) {
      fail(error);
      return;
    }

    request.on('error', fail);
    request.setTimeout(60000, () => {
      request.destroy(new Error(`下载${label}超时`));
    });
  });
}

module.exports = { downloadFile };
