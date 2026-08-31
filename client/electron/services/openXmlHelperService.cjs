const { spawn, execFileSync } = require('node:child_process');
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

/** 拉起 Open XML 助手，按任务目录提交动作并等待完成信号。 */
function createOpenXmlHelperService({ app, configStore } = {}) {
  let child = null;
  let stdoutBuffer = '';
  let queue = Promise.resolve();
  let terminationPromise = null;
  const pending = new Map();
  const logger = createDeveloperLogger({
    app,
    config: configStore?.load?.() || {},
    moduleName: 'openxml-helper',
    name: 'openxml-helper',
  });

  function writeLog(event, payload = {}) {
    logger.write(event, payload);
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
      writeLog('openxml.signal.parse_error', { line, error: compactLogError(error) });
      return;
    }

    if (signal?.v !== SIGNAL_VERSION || signal?.type !== 'done') {
      writeLog('openxml.signal.ignored', { line });
      return;
    }

    const jobId = String(signal.job || '').trim();
    const waiter = pending.get(jobId);
    if (!waiter) {
      writeLog('openxml.signal.unmatched', { job: jobId });
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

    let command;
    let args;
    if (app.isPackaged) {
      command = getBundledOpenXmlHelperPath(app);
      args = ['--workspace', workspace];
    } else {
      buildDebugHelper();
      command = getOpenXmlHelperDebugExecutablePath();
      args = ['--workspace', workspace];
    }

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
      writeLog('openxml.helper.stderr', { message: String(chunk || '').trim() });
    });
    next.on('error', (error) => {
      writeLog('openxml.helper.spawn_error', { error: compactLogError(error) });
      if (child === next) {
        child = null;
        stdoutBuffer = '';
        rejectPending(error);
      }
    });
    next.on('exit', (code, signal) => {
      writeLog('openxml.helper.exit', { code, signal });
      if (child === next) {
        child = null;
        stdoutBuffer = '';
        rejectPending(new Error('Open XML 助手已退出'));
      }
    });

    child = next;
    writeLog('openxml.helper.started', { command, packaged: Boolean(app.isPackaged) });
  }

  /** 开发态编译助手，避免 dotnet run 污染 stdout。 */
  function buildDebugHelper() {
    const projectPath = getOpenXmlHelperProjectPath();
    if (!fs.existsSync(projectPath)) {
      throw new Error(`找不到 Open XML 助手工程：${projectPath}`);
    }

    execFileSync('dotnet', ['build', projectPath, '-nologo', '-v', 'q'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 180000,
      env: {
        ...process.env,
        DOTNET_NOLOGO: '1',
      },
    });
  }

  function ensureStarted() {
    if (child && !child.killed) {
      return;
    }
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

      ensureStarted();
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
          writeLog(event, { job: jobId, action: jobAction });
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

  function ping() {
    return runJob({ action: 'ping', timeoutMs: PING_TIMEOUT_MS });
  }

  /** 结束助手进程并拒绝未完成任务。 */
  async function close() {
    const waiters = [...pending.values()];
    pending.clear();
    for (const waiter of waiters) waiter.cleanup?.();
    await terminateHelper();
    for (const waiter of waiters) waiter.reject(new Error('Open XML 助手已关闭'));
  }

  return {
    ping,
    runJob,
    close,
  };
}

module.exports = {
  createOpenXmlHelperService,
};
