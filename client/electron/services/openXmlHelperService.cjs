const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { compactLogError, createDeveloperLogger } = require('../utils/developerLog.cjs');
const {
  getOpenXmlHelperDebugExecutablePath,
  getOpenXmlHelperProjectPath,
  getOpenXmlJobDir,
  getOpenXmlJobsDir,
  getBundledOpenXmlHelperPath,
  getWorkspaceDir,
} = require('../utils/paths.cjs');

const SIGNAL_VERSION = 1;
const PING_TIMEOUT_MS = 15000;
const JOB_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const TEMPLATE_PREVIEW_FILE = 'preview.docx';
const TEMPLATE_PREVIEW_TIMEOUT_MS = 120000;
const TEMPLATE_PREVIEW_ASSET_ROOT = 'preview-assets';
const TEMPLATE_PREVIEW_CACHE_SIZE = 5;

/** 生成任务编号：时间戳加短随机串。 */
function createJobId() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

/** 保留上游取消原因，并为无原因取消补充稳定错误码。 */
function getAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Open XML 任务已取消');
  error.code = 'TASK_CANCELLED';
  return error;
}

/**
 * 一个独立的助手进程及其任务队列。
 * 超时和取消都要终止整个助手，所以互不相干的用途必须各自持有一个，
 * 否则模板预览超时会连带杀掉正在跑的导出任务。
 */
function createHelperRunner({ app, writeLog, ensureExecutable, name }) {
  let child = null;
  let stdoutBuffer = '';
  let queue = Promise.resolve();
  let terminationPromise = null;
  const pending = new Map();

  function log(event, payload = {}) {
    writeLog(event, { helper: name, ...payload });
  }

  function rejectPending(error) {
    for (const [jobId, waiter] of pending.entries()) {
      waiter.cleanup?.();
      waiter.reject(error);
      pending.delete(jobId);
    }
  }

  function handleStdoutChunk(chunk) {
    stdoutBuffer += String(chunk || '');
    let newline = stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.trim()) {
        handleSignalLine(line);
      }
      newline = stdoutBuffer.indexOf('\n');
    }
  }

  function handleSignalLine(line) {
    let signal;
    try {
      signal = JSON.parse(line);
    } catch (error) {
      log('openxml.signal.parse_error', { line, error: compactLogError(error) });
      return;
    }

    if (signal?.v !== SIGNAL_VERSION || signal?.type !== 'done') {
      log('openxml.signal.ignored', { line });
      return;
    }

    const jobId = String(signal.job || '').trim();
    const waiter = pending.get(jobId);
    if (!waiter) {
      log('openxml.signal.unmatched', { job: jobId });
      return;
    }

    waiter.cleanup?.();
    pending.delete(jobId);
    waiter.resolve({ ok: signal.ok === true });
  }

  /** 拉起已编译或已打包的助手进程。 */
  function spawnHelper() {
    const workspace = getWorkspaceDir(app);
    fs.mkdirSync(getOpenXmlJobsDir(app), { recursive: true });

    const command = app.isPackaged
      ? getBundledOpenXmlHelperPath(app)
      : getOpenXmlHelperDebugExecutablePath();
    const args = ['--workspace', workspace];

    if (!fs.existsSync(command)) {
      throw new Error(`找不到 Open XML 助手：${command}`);
    }

    const next = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        DOTNET_NOLOGO: '1',
      },
    });

    next.stdout.setEncoding('utf8');
    next.stderr.setEncoding('utf8');
    next.stdout.on('data', handleStdoutChunk);
    next.stderr.on('data', (chunk) => {
      log('openxml.helper.stderr', { message: String(chunk || '').trim() });
    });
    next.on('error', (error) => {
      log('openxml.helper.spawn_error', { error: compactLogError(error) });
      if (child === next) {
        child = null;
        stdoutBuffer = '';
        rejectPending(error);
      }
    });
    next.on('exit', (code, signal) => {
      log('openxml.helper.exit', { code, signal });
      if (child === next) {
        child = null;
        stdoutBuffer = '';
        rejectPending(new Error('Open XML 助手已退出'));
      }
    });

    child = next;
    log('openxml.helper.started', { command, packaged: Boolean(app.isPackaged) });
  }

  async function ensureStarted() {
    if (child && !child.killed) {
      return;
    }
    await ensureExecutable();
    if (child && !child.killed) return;
    spawnHelper();
  }

  /** 终止当前助手并等待进程退出；下一次任务会重新拉起。 */
  async function terminateHelper() {
    if (terminationPromise) return terminationPromise;
    const current = child;
    child = null;
    stdoutBuffer = '';
    if (!current) return;

    terminationPromise = new Promise((resolve) => {
      let settled = false;
      const timers = [];
      const finish = () => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        resolve();
      };
      if (current.exitCode !== null || current.signalCode !== null) {
        finish();
        return;
      }
      current.once('exit', finish);
      current.once('error', finish);
      // 2 秒未退出补发强杀,但必须继续等真实退出:提前放行会让删除流程撞上仍被持有的文件句柄
      timers.push(setTimeout(() => {
        try { current.kill('SIGKILL'); } catch {}
      }, 2000));
      // 进程僵死无法回收时的最终兜底,残留句柄交由删除侧的占用进程强杀处理
      timers.push(setTimeout(finish, 15000));
      try {
        current.stdin?.end();
      } catch {}
      try {
        current.kill();
      } catch {
        finish();
      }
    });
    try {
      await terminationPromise;
    } finally {
      terminationPromise = null;
    }
  }

  function sendRun(jobId) {
    if (!child?.stdin || child.stdin.destroyed) {
      throw new Error('Open XML 助手尚未就绪');
    }
    child.stdin.write(`${JSON.stringify({ v: SIGNAL_VERSION, type: 'run', job: jobId })}\n`, 'utf8');
  }

  function readResult(jobId) {
    const resultPath = path.join(getOpenXmlJobDir(app, jobId), 'result.json');
    const raw = fs.readFileSync(resultPath, 'utf8');
    return JSON.parse(raw);
  }

  function enqueue(work, signal) {
    let started = false;
    const execute = async () => {
      started = true;
      if (signal?.aborted) throw getAbortError(signal);
      return work();
    };
    const run = queue.then(execute, execute);
    queue = run.then(() => undefined, () => undefined);
    if (!signal) return run;

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const settle = (handler, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        handler(value);
      };
      const onAbort = () => {
        if (!started) settle(reject, getAbortError(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      run.then(
        (value) => settle(resolve, value),
        (error) => settle(reject, error),
      );
    });
  }

  /** 写入任务目录、发送 run，并等待 done；取消或超时时终止当前助手。 */
  async function runJob({ action, request = {}, prepare, timeoutMs = PING_TIMEOUT_MS, signal } = {}) {
    const jobAction = String(action || '').trim();
    if (!jobAction) {
      throw new Error('缺少 action');
    }
    if (signal?.aborted) throw getAbortError(signal);

    return enqueue(async () => {
      const jobId = createJobId();
      if (!JOB_ID_PATTERN.test(jobId)) {
        throw new Error(`任务编号不合法：${jobId}`);
      }

      const jobDir = getOpenXmlJobDir(app, jobId);
      fs.mkdirSync(jobDir, { recursive: true });
      fs.writeFileSync(path.join(jobDir, 'request.json'), `${JSON.stringify({ ...request, action: jobAction }, null, 2)}\n`, 'utf8');
      if (typeof prepare === 'function') {
        await prepare(jobDir);
      }
      if (signal?.aborted) throw getAbortError(signal);

      await ensureStarted();
      if (signal?.aborted) {
        await terminateHelper();
        throw getAbortError(signal);
      }

      const completionSignal = await new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
        };
        const stopAndReject = (error, event) => {
          if (!pending.has(jobId)) return;
          pending.delete(jobId);
          cleanup();
          log(event, { job: jobId, action: jobAction });
          void terminateHelper().then(
            () => reject(error),
            () => reject(error),
          );
        };
        const onAbort = () => stopAndReject(getAbortError(signal), 'openxml.job.cancelled');
        timer = setTimeout(() => {
          stopAndReject(new Error('Open XML 助手等待完成超时'), 'openxml.job.timeout');
        }, timeoutMs);
        pending.set(jobId, { resolve, reject, cleanup });
        signal?.addEventListener?.('abort', onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        try {
          sendRun(jobId);
        } catch (error) {
          cleanup();
          pending.delete(jobId);
          reject(error);
        }
      });

      let result;
      try {
        result = readResult(jobId);
      } catch (error) {
        if (!completionSignal.ok) {
          throw new Error('Open XML 助手执行失败，且没有 result.json');
        }
        throw error;
      }

      if (!result?.ok) {
        throw new Error(String(result?.error || 'Open XML 助手执行失败'));
      }

      return { ...result, jobDir };
    }, signal);
  }

  /** 结束助手进程并拒绝未完成任务。 */
  async function close() {
    const waiters = [...pending.values()];
    pending.clear();
    for (const waiter of waiters) waiter.cleanup?.();
    await terminateHelper();
    for (const waiter of waiters) waiter.reject(new Error('Open XML 助手已关闭'));
  }

  return { runJob, close };
}

/** 拉起 Open XML 助手，按任务目录提交动作并等待完成信号。 */
function createOpenXmlHelperService({ app, configStore } = {}) {
  let debugBuildPromise = null;
  let previewAssetPromise = null;
  let previewActive = null;
  let previewPending = null;
  // 模板预览会在几份配置之间来回切换，留一小段最近结果就能把重复生成挡在链路之外。
  const previewCache = new Map();
  const logger = createDeveloperLogger({
    app,
    config: configStore?.load?.() || {},
    moduleName: 'openxml-helper',
    name: 'openxml-helper',
  });

  function writeLog(event, payload = {}) {
    logger.write(event, payload);
  }

  /** 开发态异步编译助手，避免首次预览同步阻塞 Main 进程。 */
  function buildDebugHelper() {
    if (debugBuildPromise) return debugBuildPromise;
    const projectPath = getOpenXmlHelperProjectPath();
    if (!fs.existsSync(projectPath)) {
      return Promise.reject(new Error(`找不到 Open XML 助手工程：${projectPath}`));
    }

    debugBuildPromise = new Promise((resolve, reject) => {
      execFile('dotnet', ['build', projectPath, '-nologo', '-v', 'q'], {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: 180000,
        env: {
          ...process.env,
          DOTNET_NOLOGO: '1',
        },
      }, (error) => {
        if (error) {
          debugBuildPromise = null;
          reject(error);
          return;
        }
        resolve();
      });
    });
    return debugBuildPromise;
  }

  async function ensureExecutable() {
    if (!app.isPackaged) await buildDebugHelper();
  }

  const runner = createHelperRunner({ app, writeLog, ensureExecutable, name: 'main' });
  const previewRunner = createHelperRunner({ app, writeLog, ensureExecutable, name: 'preview' });

  function ping() {
    return runner.runJob({ action: 'ping', timeoutMs: PING_TIMEOUT_MS });
  }

  /**
   * 把样张配图同步到工作区内的共享目录。
   * 配图在多次预览之间不变，逐个任务复制只会白白写盘，这里只在源文件变化时更新。
   */
  function syncPreviewAssets() {
    if (previewAssetPromise) return previewAssetPromise;
    previewAssetPromise = (async () => {
      const sourceDir = path.join(app.getAppPath(), 'assets', 'content-template-preview');
      const targetDir = path.join(getWorkspaceDir(app), TEMPLATE_PREVIEW_ASSET_ROOT, 'assets');
      fs.mkdirSync(targetDir, { recursive: true });

      const sources = fs.readdirSync(sourceDir).filter((item) => item.toLowerCase().endsWith('.webp'));
      for (const name of sources) {
        const source = path.join(sourceDir, name);
        const target = path.join(targetDir, name);
        const sourceStat = fs.statSync(source);
        const targetStat = fs.existsSync(target) ? fs.statSync(target) : null;
        if (targetStat && targetStat.size === sourceStat.size && targetStat.mtimeMs >= sourceStat.mtimeMs) {
          continue;
        }
        fs.copyFileSync(source, target);
      }

      const known = new Set(sources);
      for (const name of fs.readdirSync(targetDir)) {
        if (!known.has(name)) fs.rmSync(path.join(targetDir, name), { force: true });
      }
      return TEMPLATE_PREVIEW_ASSET_ROOT;
    })().catch((error) => {
      previewAssetPromise = null;
      throw error;
    });
    return previewAssetPromise;
  }

  function readPreviewCache(key) {
    if (!previewCache.has(key)) return null;
    const entry = previewCache.get(key);
    previewCache.delete(key);
    previewCache.set(key, entry);
    return entry;
  }

  function writePreviewCache(key, entry) {
    previewCache.set(key, entry);
    while (previewCache.size > TEMPLATE_PREVIEW_CACHE_SIZE) {
      previewCache.delete(previewCache.keys().next().value);
    }
  }

  /**
   * 将模板样张交给 OpenXmlHelper 生成 DOCX。
   * 返回值带上内容指纹和段落角色表：前者让调用方判断样张是否真的变了
   * （字节相同却换了一份新数组，会让编辑器白白重开一次文档），
   * 后者让预览侧能按角色定位段落，对部分改动走增量而不是重新生成整篇。
   */
  function renderRestrictedHtmlDocx(html, exportFormat) {
    const key = crypto.createHash('sha256').update(html).update('\0').update(JSON.stringify(exportFormat)).digest('hex');
    const cached = readPreviewCache(key);
    if (cached) {
      settleSupersededPreview({ key, ...cached });
      return Promise.resolve({ key, ...cached });
    }
    if (previewActive?.key === key) {
      settleSupersededPreview(previewActive.promise);
      return previewActive.promise;
    }
    if (previewPending?.key === key) {
      return previewPending.promise;
    }

    const request = { key, html, exportFormat };
    if (!previewActive) {
      return startPreview(request);
    }

    const next = createPendingPreview(request);
    if (previewPending) previewPending.resolve(next.promise);
    previewPending = next;
    return next.promise;
  }

  /** 创建尚未进入 Open XML 队列的最后一次预览请求。 */
  function createPendingPreview(request) {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { ...request, promise, resolve, reject };
  }

  /** 当前配置已有结果时，让被覆盖的等待调用跟随该结果正常结束。 */
  function settleSupersededPreview(result) {
    if (!previewPending) return;
    const superseded = previewPending;
    previewPending = null;
    superseded.resolve(result);
  }

  /** 启动一个预览；结束后只把最后一次等待配置送入队列。 */
  function startPreview(request) {
    const promise = createRestrictedHtmlDocx(request.html, request.exportFormat)
      .then((rendered) => ({ key: request.key, ...rendered }));
    const task = { key: request.key, promise };
    previewActive = task;
    promise.then(
      (result) => {
        writePreviewCache(task.key, { bytes: result.bytes, roles: result.roles });
        finishPreview(task);
      },
      () => finishPreview(task),
    );
    return promise;
  }

  /** 完成运行中的预览，并提升唯一保留的等待请求。 */
  function finishPreview(task) {
    if (previewActive !== task) return;
    previewActive = null;
    const next = previewPending;
    previewPending = null;
    if (!next) return;
    startPreview(next).then(next.resolve, next.reject);
  }

  /** 执行一次样张生成任务；同配置的多个预览实例共用上层缓存。 */
  async function createRestrictedHtmlDocx(html, exportFormat) {
    const assetRoot = await syncPreviewAssets();
    const result = await previewRunner.runJob({
      action: 'render-restricted-html-docx',
      request: { html, export_format: exportFormat, asset_root: assetRoot },
      timeoutMs: TEMPLATE_PREVIEW_TIMEOUT_MS,
    });

    try {
      return {
        bytes: new Uint8Array(fs.readFileSync(path.join(result.jobDir, TEMPLATE_PREVIEW_FILE))),
        roles: Array.isArray(result.paragraphRoles) ? result.paragraphRoles : [],
      };
    } finally {
      const jobsRoot = path.resolve(getOpenXmlJobsDir(app));
      const jobDir = path.resolve(result.jobDir);
      if (path.dirname(jobDir) === jobsRoot) fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }

  /** 结束助手进程并拒绝未完成任务。 */
  async function close() {
    const queuedPreview = previewPending;
    previewPending = null;
    previewActive = null;
    previewCache.clear();
    queuedPreview?.reject(new Error('Open XML 助手已关闭'));
    await Promise.all([runner.close(), previewRunner.close()]);
  }

  if (!app.isPackaged) {
    void buildDebugHelper().catch((error) => {
      writeLog('openxml.helper.build_error', { error: compactLogError(error) });
    });
  }

  return {
    ping,
    runJob: runner.runJob,
    renderRestrictedHtmlDocx,
    close,
  };
}

module.exports = {
  createOpenXmlHelperService,
};
