'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { getDocxAgentCliPath } = require('../utils/paths.cjs');

const CLI_TIMEOUT_MS = 180000;
const PY_MIN_MAJOR = 3;
const PY_MIN_MINOR = 12;

function parsePythonVersion(output) {
  const match = String(output || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function runCommand(command, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message || error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill(); } catch {}
        resolve({ code: -1, stdout, stderr: '命令超时' });
      }
    }, timeoutMs);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf-8'); });
    child.on('error', (error) => finish(-1, String(error?.message || error)));
    child.on('close', (code) => finish(code));
  });
}

function createDocxAgentService({ app } = {}) {
  const cliPath = getDocxAgentCliPath(app);
  let runtimePromise = null;

  async function detectRuntime() {
    if (!fs.existsSync(cliPath)) {
      return { available: false, reason: `docx-agent 命令行工具缺失：${cliPath}` };
    }
    if (app?.isPackaged) {
      return { available: false, reason: '当前安装包暂未内置 docx-agent 运行时，模板填写高保真粘贴不可用；正式包将随 PyInstaller 侧车提供。' };
    }
    const candidates = process.env.YIBIAO_PYTHON
      ? [{ command: process.env.YIBIAO_PYTHON, baseArgs: [] }]
      : [
          { command: 'python', baseArgs: [] },
          { command: 'python3', baseArgs: [] },
          { command: 'py', baseArgs: ['-3'] },
        ];
    for (const candidate of candidates) {
      const versionRun = await runCommand(
        candidate.command,
        [...candidate.baseArgs, '-c', 'import sys; print(sys.version)'],
      );
      if (versionRun.code !== 0 || !versionRun.stdout.trim()) continue;
      const version = parsePythonVersion(versionRun.stdout);
      if (!version) continue;
      if (version.major < PY_MIN_MAJOR
        || (version.major === PY_MIN_MAJOR && version.minor < PY_MIN_MINOR)) {
        return {
          available: false,
          reason: `检测到 Python ${version.major}.${version.minor}，模板填写需要本机安装 Python ${PY_MIN_MAJOR}.${PY_MIN_MINOR} 或更高版本，并安装 python-docx、lxml。`,
        };
      }
      const depsRun = await runCommand(
        candidate.command,
        [...candidate.baseArgs, '-c', 'import docx, lxml'],
      );
      if (depsRun.code !== 0) {
        return {
          available: false,
          reason: `Python 依赖缺失：请执行 pip install python-docx lxml 后重试（${depsRun.stderr.trim().split('\n').pop() || 'import 失败'}）`,
        };
      }
      return { available: true, command: candidate.command, baseArgs: candidate.baseArgs, version };
    }
    return { available: false, reason: '未检测到可用的 Python 3.12+ 运行环境，模板填写高保真粘贴不可用；请安装 Python 3.12 及以上版本并执行 pip install python-docx lxml。' };
  }

  async function ensureRuntime() {
    if (!runtimePromise) {
      runtimePromise = detectRuntime().catch((error) => ({
        available: false,
        reason: `docx-agent 运行时检测失败：${error?.message || error}`,
      }));
    }
    const runtime = await runtimePromise;
    if (!runtime.available) {
      throw new Error(runtime.reason);
    }
    return runtime;
  }

  async function resetRuntimeCache() {
    runtimePromise = null;
  }

  async function runOp(payload) {
    const runtime = await ensureRuntime();
    return new Promise((resolve, reject) => {
      const child = spawn(runtime.command, [...runtime.baseArgs, cliPath], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { child.kill(); } catch {}
          reject(new Error(`docx-agent 命令超时（op=${payload?.op}）`));
        }
      }, CLI_TIMEOUT_MS);
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf-8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf-8'); });
      child.on('error', (error) => finish(reject, new Error(`docx-agent 启动失败：${error?.message || error}`)));
      child.on('close', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(stdout.trim().split('\n').pop() || 'null');
        } catch {}
        if (!parsed) {
          finish(reject, new Error(`docx-agent 输出解析失败（op=${payload?.op}）${stderr ? `：${stderr.trim().split('\n').pop()}` : ''}`));
          return;
        }
        if (parsed.ok === false) {
          finish(reject, new Error(parsed.error || 'docx-agent 操作失败'));
          return;
        }
        finish(resolve, parsed);
      });
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
        child.stdin.end();
      } catch (error) {
        finish(reject, new Error(`docx-agent 输入写入失败：${error?.message || error}`));
      }
    });
  }

  function inspect(docPath) {
    return runOp({ op: 'inspect', doc: docPath });
  }

  function locate(docPath, params = {}) {
    return runOp({
      op: 'locate',
      doc: docPath,
      strategy: params.strategy,
      text: params.text,
      section_text: params.sectionText,
      level: params.level,
      keywords: params.keywords,
    });
  }

  function extractRange(params) {
    return runOp({
      op: 'extract_range',
      src: params.src,
      out: params.out,
      start_kind: params.startKind,
      start: params.start,
      end: params.end,
      table_index: params.tableIndex,
      expect_text: params.expectText,
    });
  }

  function copyRange(params) {
    return runOp({
      op: 'copy_range',
      src: params.src,
      tgt: params.tgt,
      out: params.out,
      anchor_bookmark: params.anchorBookmark,
      start: params.start,
      end: params.end,
    });
  }

  return {
    ensureRuntime,
    resetRuntimeCache,
    inspect,
    locate,
    extractRange,
    copyRange,
    getCliPath: () => cliPath,
  };
}

module.exports = { createDocxAgentService };
