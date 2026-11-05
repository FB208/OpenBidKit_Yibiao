const path = require('node:path');
const { getAiRawLogsDir } = require('./paths.cjs');
const { buildAiLogFileName } = require('./aiLog.cjs');
const { enqueueJsonLine } = require('./silentFileLog.cjs');

// 保存错误原文及原因链，不用响应正文覆盖本地异常。
function serializeRawLogError(error) {
  if (!error) return null;
  if (typeof error !== 'object') return { message: String(error) };
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    status: error.status || error.statusCode,
    stack: error.stack,
    cause: error.cause ? serializeRawLogError(error.cause) : undefined,
  };
}

// 同一请求的原始数据按时间追加到独立文件；日志异常不影响模型调用。
function createAiRawLog(app, config, requestId, logTitle) {
  if (!config?.developer_mode) return null;
  const fileName = buildAiLogFileName({ request_id: requestId, log_title: logTitle }).replace(/\.json$/, '.jsonl');
  const filePath = path.join(getAiRawLogsDir(app), fileName);
  const startedAt = Date.now();
  let attempts = 0;
  let totalBytes = 0;

  // 复用逐文件 FIFO 队列，保存完整记录且不等待磁盘写入。
  function record(type, data = {}) {
    try {
      enqueueJsonLine(filePath, { type, created_at: new Date().toISOString(), ...data });
    } catch {
      // 日志采集不能打断请求。
    }
  }

  record('start', { request_id: requestId, log_title: logTitle });
  return {
    // 每次实际发送均建立独立状态，重试在同一文件中保留全部尝试。
    beginAttempt() {
      const attempt = ++attempts;
      const attemptStartedAt = Date.now();
      const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
      let receivedBytes = 0;
      let responseEnded = false;
      let finished = false;

      // 响应中断也写出解码缓冲区及接收统计。
      function endResponse(status, error) {
        if (responseEnded) return;
        responseEnded = true;
        const tail = decoder.decode();
        if (tail) record('response_chunk', { attempt, data: tail });
        record('response_end', { attempt, status, received_bytes: receivedBytes, error: serializeRawLogError(error) });
      }

      return {
        // 请求体按实际发送值记录；鉴权密钥不写入文件。
        request(url, headers, body) {
          const loggedHeaders = Object.fromEntries(new Headers(headers));
          delete loggedHeaders.authorization;
          delete loggedHeaders['x-api-key'];
          record('request', { attempt, url, method: 'POST', headers: loggedHeaders, body });
        },
        // 在解析和代理改写前记录响应，并原样交回同一条消费链。
        captureResponse(response) {
          record('response_headers', {
            attempt,
            url: response.url,
            status: response.status,
            status_text: response.statusText,
            headers: Object.fromEntries(response.headers),
          });
          if (!response.body) {
            endResponse('completed');
            return response;
          }
          const reader = response.body.getReader();
          const body = new ReadableStream({
            // 按下游读取节奏采集，避免额外分支提前消费上游。
            async pull(controller) {
              try {
                const { done, value } = await reader.read();
                if (done) {
                  endResponse('completed');
                  reader.releaseLock();
                  controller.close();
                  return;
                }
                receivedBytes += value.byteLength;
                totalBytes += value.byteLength;
                const data = decoder.decode(value, { stream: true });
                record('response_chunk', { attempt, byte_length: value.byteLength, data });
                controller.enqueue(value);
              } catch (error) {
                endResponse('failed', error);
                reader.releaseLock();
                controller.error(error);
              }
            },
            // 下游取消时保留已接收片段，并继续传递取消原因。
            async cancel(reason) {
              endResponse('cancelled', reason);
              try { await reader.cancel(reason); } finally { reader.releaseLock(); }
            },
          }, { highWaterMark: 0 });
          const captured = new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
          for (const key of ['url', 'redirected', 'type']) {
            Object.defineProperty(captured, key, { value: response[key] });
          }
          return captured;
        },
        // 保存每次尝试的业务结果，HTTP 200 不代表模型请求成功。
        finish(status, error, signal) {
          if (finished) return;
          finished = true;
          // 解析器可能在错误事件或结束标记处停止，仍保留最后的解码片段。
          if (!responseEnded) endResponse('stopped', error);
          record('attempt_end', {
            attempt, status, duration_ms: Date.now() - attemptStartedAt,
            received_bytes: receivedBytes, error: serializeRawLogError(error),
            abort_reason: signal?.aborted ? serializeRawLogError(signal.reason) : null,
          });
        },
        // 记录代理侧上游错误与本地中断原因。
        record(type, data) {
          record(type, { attempt, ...data });
        },
      };
    },
    // 业务调用结束时追加总结果，不覆盖此前的请求或响应。
    finish(status, error, signal) {
      record('end', {
        request_id: requestId, status, attempts,
        duration_ms: Date.now() - startedAt, received_bytes: totalBytes,
        error: serializeRawLogError(error),
        abort_reason: signal?.aborted ? serializeRawLogError(signal.reason) : null,
      });
    },
  };
}

module.exports = { createAiRawLog };
