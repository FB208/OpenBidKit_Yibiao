const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const {
  getAgentRuntimeDir,
  getAgentCacheDir,
  getBundledOpencodeBinaryPath,
} = require('../../utils/paths.cjs');
const { createAiServiceOpenAiProxy } = require('./aiServiceOpenAiProxy.cjs');
const { writeOpenCodeConfig } = require('./opencodeConfigFactory.cjs');

function randomId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
}

function createBasicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function ensureExecutable(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`OpenCode binary 不存在：${filePath}`);
  }

  if (process.platform !== 'win32') {
    try { fs.chmodSync(filePath, 0o755); } catch {}
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('无法分配本地端口'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function buildMinimalChildEnv(extra) {
  const keepKeys = [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'ComSpec',
  ];

  const env = {};
  keepKeys.forEach((key) => {
    if (process.env[key]) env[key] = process.env[key];
  });

  return { ...env, ...extra };
}

function createStderrBuffer(limit = 20000) {
  let value = '';

  return {
    push(chunk) {
      value += String(chunk || '');
      if (value.length > limit) {
        value = value.slice(-limit);
      }
    },
    tail(size = 4000) {
      return value.slice(-size);
    },
  };
}

function createOutputBuffer(limit = 20000) {
  let value = '';

  return {
    push(chunk) {
      value += String(chunk || '');
      if (value.length > limit) {
        value = value.slice(-limit);
      }
    },
    tail(size = 4000) {
      return value.slice(-size);
    },
  };
}

function getFetchCauseMessage(error) {
  const cause = error?.cause;
  if (!cause) return '';
  return [cause.code, cause.message].filter(Boolean).join('：');
}

function attachOpenCodeDiagnostics(error, meta = {}) {
  if (!error || typeof error !== 'object') return error;
  const stderrTail = meta.stderrBuffer?.tail?.(8000) || meta.stderrTail || '';
  const stdoutTail = meta.stdoutBuffer?.tail?.(8000) || meta.stdoutTail || '';
  error.openCodeBinaryPath = meta.opencodeBin || error.openCodeBinaryPath || '';
  error.openCodeWorkspaceDir = meta.workspaceDir || error.openCodeWorkspaceDir || '';
  error.openCodeRuntimeRoot = meta.runtimeRoot || error.openCodeRuntimeRoot || '';
  error.openCodeBaseUrl = meta.baseUrl || error.openCodeBaseUrl || '';
  error.openCodePort = meta.port || error.openCodePort || 0;
  error.openCodeExitCode = meta.exitInfo?.code ?? error.openCodeExitCode;
  error.openCodeExitSignal = meta.exitInfo?.signal || error.openCodeExitSignal || '';
  error.openCodeSpawnError = meta.spawnError?.message || error.openCodeSpawnError || '';
  error.openCodeStderrTail = stderrTail;
  error.openCodeStdoutTail = stdoutTail;
  error.openCodeLastHealthError = meta.lastError?.message || error.openCodeLastHealthError || '';
  error.openCodeLastHealthCause = getFetchCauseMessage(meta.lastError) || error.openCodeLastHealthCause || '';
  return error;
}

function createOpenCodeStartError(message, meta = {}) {
  const stderrTail = meta.stderrBuffer?.tail?.(4000) || '';
  const stdoutTail = meta.stdoutBuffer?.tail?.(4000) || '';
  const details = [];
  const cause = getFetchCauseMessage(meta.lastError);
  if (meta.lastError?.message) details.push(`lastError: ${meta.lastError.message}${cause ? ` (${cause})` : ''}`);
  if (meta.exitInfo) details.push(`exit: code=${meta.exitInfo.code ?? 'null'} signal=${meta.exitInfo.signal || 'null'}`);
  if (meta.spawnError?.message) details.push(`spawnError: ${meta.spawnError.message}`);
  if (stdoutTail) details.push(`stdout:\n${stdoutTail}`);
  if (stderrTail) details.push(`stderr:\n${stderrTail}`);
  const error = new Error(`${message}${details.length ? `\n${details.join('\n')}` : ''}`);
  return attachOpenCodeDiagnostics(error, meta);
}

function normalizeTimeoutMs(value, fallback = 10 * 60 * 1000) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

async function waitForOpenCodeHealth({ baseUrl, authHeader, stderrBuffer, stdoutBuffer, childState, timeoutMs = 30000 }) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    if (childState?.spawnError) {
      throw createOpenCodeStartError('OpenCode Server 启动失败：无法启动 OpenCode 进程', {
        ...childState.meta,
        stderrBuffer,
        stdoutBuffer,
        spawnError: childState.spawnError,
        lastError,
      });
    }
    if (childState?.exitInfo) {
      throw createOpenCodeStartError('OpenCode Server 启动失败：OpenCode 进程在健康检查通过前退出', {
        ...childState.meta,
        stderrBuffer,
        stdoutBuffer,
        exitInfo: childState.exitInfo,
        lastError,
      });
    }

    try {
      const response = await fetch(`${baseUrl}/global/health`, {
        headers: { Authorization: authHeader },
      });
      if (response.ok) return true;
      lastError = new Error(`health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw createOpenCodeStartError(`OpenCode Server 启动超时：${lastError?.message || 'unknown error'}`, {
    ...childState?.meta,
    stderrBuffer,
    stdoutBuffer,
    exitInfo: childState?.exitInfo,
    spawnError: childState?.spawnError,
    lastError,
  });
}

function killChild(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 2000);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    try { child.kill('SIGTERM'); } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function closeAiProxy(aiProxy) {
  if (!aiProxy) return;
  try { await aiProxy.close(); } catch {}
}

async function cleanupRuntime(runtimeRoot, keepRuntime) {
  if (keepRuntime || !runtimeRoot) return;
  try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
}

async function startIsolatedOpenCodeServer({
  app,
  configStore,
  workspaceDir,
  taskId = randomId('agent'),
  keepRuntime = false,
  timeoutMs,
}) {
  const agentTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const opencodeBin = getBundledOpencodeBinaryPath(app);
  ensureExecutable(opencodeBin);

  fs.mkdirSync(workspaceDir, { recursive: true });

  const runtimeRoot = path.join(getAgentRuntimeDir(app), taskId);
  const tempHome = path.join(runtimeRoot, 'home');
  const configDir = path.join(tempHome, '.config', 'opencode');
  const dataHome = path.join(tempHome, '.local', 'share');
  const cacheHome = path.join(getAgentCacheDir(app), 'opencode-cache');
  const opencodeConfigPath = path.join(configDir, 'opencode.json');

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataHome, { recursive: true });
  fs.mkdirSync(cacheHome, { recursive: true });

  let aiProxy = null;
  let child = null;
  const stderrBuffer = createStderrBuffer();
  const stdoutBuffer = createOutputBuffer();

  try {
    aiProxy = createAiServiceOpenAiProxy({ app, configStore, timeoutMs: agentTimeoutMs });
    const aiProxyInfo = await aiProxy.start();

    const currentConfig = configStore.load();
    const opencodeConfig = writeOpenCodeConfig(opencodeConfigPath, {
      proxyBaseUrl: aiProxyInfo.baseUrl,
      contextLengthLimit: currentConfig.context_length_limit,
      timeoutMs: agentTimeoutMs,
    });

    const port = await findFreePort();
    const username = 'yibiao';
    const password = crypto.randomBytes(24).toString('base64url');
    const baseUrl = `http://127.0.0.1:${port}`;
    const authHeader = createBasicAuth(username, password);
    const childState = {
      spawnError: null,
      exitInfo: null,
      meta: {
        opencodeBin,
        workspaceDir,
        runtimeRoot,
        baseUrl,
        port,
      },
    };

    const env = buildMinimalChildEnv({
      HOME: tempHome,
      USERPROFILE: tempHome,
      XDG_CONFIG_HOME: path.join(tempHome, '.config'),
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
      OPENCODE_CONFIG: opencodeConfigPath,
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig),
      OPENCODE_PERMISSION: JSON.stringify(opencodeConfig.permission),
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      YIBIAO_OPENCODE_PROXY_TOKEN: aiProxyInfo.token,
    });

    child = spawn(opencodeBin, [
      'serve',
      '--pure',
      '--hostname', '127.0.0.1',
      '--port', String(port),
    ], {
      cwd: workspaceDir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => stdoutBuffer.push(chunk));
    child.stderr.on('data', (chunk) => stderrBuffer.push(chunk));

    child.once('error', (error) => {
      childState.spawnError = error;
      stderrBuffer.push(`\n[spawn error] ${error?.message || String(error)}\n`);
    });

    child.once('exit', (code, signal) => {
      childState.exitInfo = { code, signal };
      if (code !== 0) {
        console.warn('[opencode] server exited', {
          code,
          signal,
          stdout: stdoutBuffer.tail(4000),
          stderr: stderrBuffer.tail(4000),
        });
      }
    });

    await waitForOpenCodeHealth({ baseUrl, authHeader, stderrBuffer, stdoutBuffer, childState, timeoutMs: 30000 });

    return {
      taskId,
      baseUrl,
      authHeader,
      workspaceDir,
      runtimeRoot,
      child,
      requestLog: [],
      getStderrTail(size = 4000) {
        return stderrBuffer.tail(size);
      },
      getStdoutTail(size = 4000) {
        return stdoutBuffer.tail(size);
      },
      async close() {
        await killChild(child);
        await closeAiProxy(aiProxy);
        await cleanupRuntime(runtimeRoot, keepRuntime);
      },
    };
  } catch (error) {
    await killChild(child);
    await closeAiProxy(aiProxy);
    await cleanupRuntime(runtimeRoot, keepRuntime);
    throw attachOpenCodeDiagnostics(error, {
      opencodeBin,
      workspaceDir,
      runtimeRoot,
      stderrBuffer,
      stdoutBuffer,
    });
  }
}

module.exports = {
  startIsolatedOpenCodeServer,
};
