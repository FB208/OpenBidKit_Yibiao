const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');

/** 读取已完成缓存的媒体，支持播放器拖动所需的单段 Range 请求。 */
async function createNoticeMediaResponse(request, filePath) {
  try {
    if (path.basename(filePath) !== 'media') return new Response('Not found', { status: 404 });
    const manifest = JSON.parse(await fsp.readFile(path.join(path.dirname(filePath), 'complete.json'), 'utf8'));
    const file = await fsp.open(filePath, 'r');
    let streaming = false;
    try {
      const { size } = await file.stat();
      if (size !== manifest.byteLength || !size) return new Response('Not found', { status: 404 });
      const headers = new Headers({
        'Content-Type': manifest.contentType,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(size),
      });
      let start = 0;
      let end = size - 1;
      const range = request.headers.get('range');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        }
        if (match[1]) {
          start = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        } else {
          start = Math.max(0, size - Number(match[2]));
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        }
        headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
        headers.set('Content-Length', String(end - start + 1));
      }
      if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
      const stream = file.createReadStream({ start, end, autoClose: true });
      streaming = true;
      return new Response(Readable.toWeb(stream), { status: range ? 206 : 200, headers });
    } finally {
      if (!streaming) await file.close();
    }
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

module.exports = { createNoticeMediaResponse };
