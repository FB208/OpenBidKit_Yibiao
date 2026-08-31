const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Windows 句柄延迟释放与只读属性都会让删除报这些错误码。
const lockErrorCodes = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
const holderQueryTimeoutMs = 30000;
const holderQueryMaxFiles = 256;

function isFileLockError(error) {
  return lockErrorCodes.has(error?.code);
}

/** 本应用全部进程(Main + Electron 渲染/GPU 等子进程),这些不能强杀,占用时改走回收目录。 */
function getOwnPids() {
  const pids = new Set([process.pid]);
  try {
    // 纯 Node 环境(测试)下 require('electron') 返回二进制路径字符串,需要判空
    const electron = require('electron');
    const metrics = electron?.app?.getAppMetrics?.() || [];
    for (const item of metrics) {
      if (Number.isInteger(item?.pid)) pids.add(item.pid);
    }
  } catch {
    // 无 electron 环境时只保护当前进程
  }
  return pids;
}

/** Windows 上 fs.copyFile 会连带拷贝只读属性,删除前统一清掉。 */
function clearReadonlyDeep(targetPath) {
  let stats;
  try {
    stats = fs.lstatSync(targetPath);
  } catch {
    return;
  }
  try {
    fs.chmodSync(targetPath, stats.isDirectory() ? 0o777 : 0o666);
  } catch {
    // 清属性失败不阻断,交给删除重试
  }
  if (!stats.isDirectory()) return;
  let names = [];
  try {
    names = fs.readdirSync(targetPath);
  } catch {
    return;
  }
  for (const name of names) {
    clearReadonlyDeep(path.join(targetPath, name));
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 自实现重试:新版 Node 的 rmSync 原生 maxRetries 对 EPERM 并不可靠,句柄释放延迟需手动等待。 */
function rmWithRetrySync(targetPath) {
  let lastError;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!isFileLockError(error)) throw error;
      sleepSync(200);
    }
  }
  throw lastError;
}

function collectFiles(targetPath, limit) {
  const files = [];
  const walk = (current) => {
    if (files.length >= limit) return;
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch {
      return;
    }
    if (!stats.isDirectory()) {
      files.push(current);
      return;
    }
    let names = [];
    try {
      names = fs.readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      if (files.length >= limit) return;
      walk(path.join(current, name));
    }
  };
  walk(targetPath);
  return files;
}

// 通过 Windows Restart Manager 精确列出占用这些文件的进程 PID。
const windowsRestartManagerSource = `
using System;
using System.Runtime.InteropServices;
public static class YibiaoRmHelper {
  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint pSessionHandle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
  public static int[] GetLockingPids(string[] files) {
    uint session;
    if (RmStartSession(out session, 0, Guid.NewGuid().ToString()) != 0) return new int[0];
    try {
      if (RmRegisterResources(session, (uint)files.Length, files, 0, null, 0, null) != 0) return new int[0];
      uint needed = 0, count = 0, reasons = 0;
      int result = RmGetList(session, out needed, ref count, null, ref reasons);
      if (needed == 0) return new int[0];
      RM_PROCESS_INFO[] info = new RM_PROCESS_INFO[needed];
      count = needed;
      if (RmGetList(session, out needed, ref count, info, ref reasons) != 0) return new int[0];
      int[] pids = new int[count];
      for (int i = 0; i < count; i++) pids[i] = info[i].Process.dwProcessId;
      return pids;
    } finally {
      RmEndSession(session);
    }
  }
}
`;

const windowsHolderQueryScript = [
  "$ErrorActionPreference = 'Stop'",
  `Add-Type -TypeDefinition @'
${windowsRestartManagerSource}
'@ -Language CSharp`,
  "$files = $env:YIBIAO_LOCKED_FILES -split '\\|' | Where-Object { $_ }",
  'if ($files.Count -gt 0) { [YibiaoRmHelper]::GetLockingPids([string[]]$files) | ForEach-Object { Write-Output $_ } }',
].join('\n');

function parsePidOutput(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 4);
}

function findHolderPidsWindows(files) {
  if (!files.length) return [];
  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsHolderQueryScript],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: holderQueryTimeoutMs,
      env: { ...process.env, YIBIAO_LOCKED_FILES: files.join('|') },
    },
  );
  return parsePidOutput(output);
}

function findHolderPidsPosix(targetPath, isDirectory) {
  const args = isDirectory ? ['-t', '+D', targetPath] : ['-t', '--', targetPath];
  try {
    const output = execFileSync('lsof', args, { encoding: 'utf8', timeout: holderQueryTimeoutMs });
    return parsePidOutput(output);
  } catch (error) {
    // lsof 在没有任何占用者时退出码为 1
    return parsePidOutput(error?.stdout);
  }
}

function findHolderPids(targetPath) {
  let isDirectory = false;
  try {
    isDirectory = fs.lstatSync(targetPath).isDirectory();
  } catch {
    return [];
  }
  if (process.platform === 'win32') {
    return findHolderPidsWindows(collectFiles(targetPath, holderQueryMaxFiles));
  }
  return findHolderPidsPosix(targetPath, isDirectory);
}

function killPid(pid) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: holderQueryTimeoutMs,
        stdio: 'ignore',
      });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch {
    return false;
  }
}

/** 软锁(句柄带 share-delete)时可把目标改名移入回收目录,物理删除延迟到下次清理。 */
function moveToTrashSync(targetPath, trashDir) {
  fs.mkdirSync(trashDir, { recursive: true });
  const trashName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${path.basename(targetPath)}`;
  const trashPath = path.join(trashDir, trashName);
  fs.renameSync(targetPath, trashPath);
  return trashPath;
}

const pendingDeletesFileName = 'pending-deletes.json';
const pendingDeletesLimit = 100;

function getEntryFingerprint(targetPath) {
  try {
    const stats = fs.lstatSync(targetPath);
    return {
      type: stats.isDirectory() ? 'dir' : 'file',
      size: stats.size,
      mtime_ms: stats.mtimeMs,
    };
  } catch {
    return null;
  }
}

function readPendingDeletes(trashDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(trashDir, pendingDeletesFileName), 'utf-8'));
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.path === 'string' && item.path) : [];
  } catch {
    return [];
  }
}

function writePendingDeletes(trashDir, entries) {
  try {
    const filePath = path.join(trashDir, pendingDeletesFileName);
    if (!entries.length) {
      fs.rmSync(filePath, { force: true });
      return;
    }
    fs.mkdirSync(trashDir, { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(entries.slice(-pendingDeletesLimit), null, 2)}\n`, 'utf-8');
  } catch {
    // 登记失败不阻断清理流程
  }
}

/**
 * 硬锁(占用者是本应用进程等无法强杀/移动的情况)时登记延迟删除:
 * 自有进程的句柄在应用重启后必然释放,下次启动统一补删。
 * 记录文件指纹,若路径后来被合法新内容复用则放弃补删,避免误删用户数据。
 */
function deferRemoval(targetPath, trashDir) {
  const fingerprint = getEntryFingerprint(targetPath);
  if (!fingerprint) return;
  const resolved = path.resolve(targetPath);
  const entries = readPendingDeletes(trashDir).filter((item) => item.path !== resolved);
  entries.push({ path: resolved, ...fingerprint });
  writePendingDeletes(trashDir, entries);
}

/**
 * 强制删除工作区文件或目录,按五级递进:
 * 1. 清只读属性 + 重试删除(覆盖句柄延迟释放);
 * 2. 仍被占用时定位占用进程,外部进程与自有子进程(openxmlhelper 等)一律强杀;
 * 3. 占用者属于本应用进程(Main/渲染进程)时无法自杀,记录 self-locked 日志;
 * 4. 强杀后仍删不掉且提供 trashDir 时,尝试改名移入回收目录(对软锁有效);
 * 5. 改名也失败且 deferOnFailure 开启时,登记延迟删除并放行,重启后由启动清理补删。
 * 走不到第 5 级(未开启 defer)且仍失败时抛出原始错误,由调用方包装提示。
 */
function forceRemoveSync(targetPath, { onEvent, trashDir, deferOnFailure = false } = {}) {
  if (!fs.existsSync(targetPath)) return;
  clearReadonlyDeep(targetPath);
  try {
    rmWithRetrySync(targetPath);
    return;
  } catch (error) {
    if (!isFileLockError(error)) throw error;
    onEvent?.('force-remove.locked', { target_path: targetPath, code: error?.code });
    let holders = [];
    try {
      holders = [...new Set(findHolderPids(targetPath))];
    } catch (queryError) {
      onEvent?.('force-remove.holder-query-failed', {
        target_path: targetPath,
        error: queryError?.message || String(queryError),
      });
    }
    const ownPids = getOwnPids();
    const selfHolders = holders.filter((pid) => ownPids.has(pid));
    const killablePids = holders.filter((pid) => !ownPids.has(pid));
    if (selfHolders.length) {
      onEvent?.('force-remove.self-locked', { target_path: targetPath, pids: selfHolders });
    }
    const killed = killablePids.filter((pid) => killPid(pid));
    onEvent?.('force-remove.holders-killed', { target_path: targetPath, pids: killablePids, killed });
    clearReadonlyDeep(targetPath);
    try {
      rmWithRetrySync(targetPath);
      onEvent?.('force-remove.completed', { target_path: targetPath, killed_count: killed.length });
      return;
    } catch (finalError) {
      if (!isFileLockError(finalError) || !trashDir) throw finalError;
      try {
        const trashPath = moveToTrashSync(targetPath, trashDir);
        onEvent?.('force-remove.moved-to-trash', { target_path: targetPath, trash_path: trashPath });
        return;
      } catch (renameError) {
        onEvent?.('force-remove.trash-move-failed', {
          target_path: targetPath,
          code: renameError?.code,
          error: renameError?.message || String(renameError),
        });
      }
      if (!deferOnFailure) throw finalError;
      deferRemoval(targetPath, trashDir);
      onEvent?.('force-remove.deferred', { target_path: targetPath, self_locked: selfHolders.length > 0 });
    }
  }
}

/** 处理登记在册的延迟删除:指纹不符说明路径已被合法新内容复用,放弃补删。 */
function processPendingDeletes(trashDir, onEvent) {
  const entries = readPendingDeletes(trashDir);
  if (!entries.length) return;
  const remaining = [];
  for (const entry of entries) {
    const fingerprint = getEntryFingerprint(entry.path);
    if (!fingerprint) continue;
    if (fingerprint.type !== entry.type || fingerprint.size !== entry.size || fingerprint.mtime_ms !== entry.mtime_ms) {
      onEvent?.('force-remove.pending-delete-dropped', { target_path: entry.path });
      continue;
    }
    try {
      clearReadonlyDeep(entry.path);
      fs.rmSync(entry.path, { recursive: true, force: true });
      onEvent?.('force-remove.pending-delete-completed', { target_path: entry.path });
    } catch (error) {
      remaining.push(entry);
      onEvent?.('force-remove.pending-delete-skipped', { target_path: entry.path, code: error?.code });
    }
  }
  writePendingDeletes(trashDir, remaining);
}

/** 启动时调用:补删延迟删除条目,并清空回收目录中已移入的残留;仍被占用的留到下次。 */
function cleanupTrashDirSync(trashDir, { onEvent } = {}) {
  processPendingDeletes(trashDir, onEvent);
  let names = [];
  try {
    names = fs.readdirSync(trashDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === pendingDeletesFileName) continue;
    const targetPath = path.join(trashDir, name);
    try {
      clearReadonlyDeep(targetPath);
      fs.rmSync(targetPath, { recursive: true, force: true });
    } catch (error) {
      onEvent?.('force-remove.trash-cleanup-skipped', { target_path: targetPath, code: error?.code });
    }
  }
}

module.exports = {
  cleanupTrashDirSync,
  forceRemoveSync,
  isFileLockError,
};
