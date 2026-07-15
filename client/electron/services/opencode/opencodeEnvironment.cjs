const fs = require('node:fs');
const path = require('node:path');
const {
  getAgentCacheDir,
  getBundledOpencodeBinaryPath,
} = require('../../utils/paths.cjs');
const {
  applyOpenCodeToolEnvironment,
  ensureOpenCodeToolEnvironment,
} = require('./opencodeToolEnvironment.cjs');

// 统一生成 OpenCode 使用的目录，避免 Server 与自检各自拼装 HOME/XDG。
function createOpenCodeEnvironmentLayout({ app, runtimeRoot, workspaceDir }) {
  const homeDir = path.join(runtimeRoot, 'home');
  const configHome = path.join(homeDir, '.config');
  const dataHome = path.join(homeDir, '.local', 'share');
  const stateHome = path.join(homeDir, '.local', 'state');
  const cacheHome = path.join(getAgentCacheDir(app), 'opencode-cache');
  const tempDir = path.join(runtimeRoot, 'tmp');
  const appDataDir = path.join(homeDir, 'AppData', 'Roaming');
  const localAppDataDir = path.join(homeDir, 'AppData', 'Local');

  return {
    runtimeRoot,
    workspaceDir,
    homeDir,
    configHome,
    configDir: path.join(configHome, 'opencode'),
    dataHome,
    dataDir: path.join(dataHome, 'opencode'),
    toolOutputDir: path.join(dataHome, 'opencode', 'tool-output'),
    stateHome,
    stateDir: path.join(stateHome, 'opencode'),
    cacheHome,
    cacheDir: path.join(cacheHome, 'opencode'),
    tempDir,
    opencodeTempDir: path.join(tempDir, 'opencode'),
    appDataDir,
    localAppDataDir,
    opencodeConfigPath: path.join(runtimeRoot, 'opencode.json'),
  };
}

// 创建 OpenCode 启动前必须存在的全部应用专用目录。
function ensureOpenCodeEnvironmentDirectories(layout) {
  const directories = [
    layout.runtimeRoot,
    layout.workspaceDir,
    layout.homeDir,
    layout.configDir,
    layout.dataHome,
    layout.dataDir,
    layout.toolOutputDir,
    layout.stateHome,
    layout.stateDir,
    layout.cacheHome,
    layout.cacheDir,
    layout.tempDir,
    layout.opencodeTempDir,
  ];
  if (process.platform === 'win32') {
    directories.push(layout.appDataDir, layout.localAppDataDir);
  }

  try {
    directories.forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
  } catch (error) {
    throw new Error(`OpenCode 逻辑隔离目录创建失败：${error?.message || String(error)}`);
  }
}

// 返回当前系统允许保留的基础命令目录，不读取用户 PATH。
function getSystemPathEntries() {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    if (!systemRoot) {
      throw new Error('OpenCode 逻辑隔离初始化失败：无法获取 Windows 系统目录');
    }
    return [
      path.join(systemRoot, 'System32'),
      systemRoot,
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    ];
  }

  return ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
}

// 构建只包含系统基础变量和易标隔离目录的进程环境。
function buildOpenCodeBaseEnv(layout) {
  const pathValue = getSystemPathEntries().join(path.delimiter);
  const env = {
    HOME: layout.homeDir,
    USERPROFILE: layout.homeDir,
    XDG_CONFIG_HOME: layout.configHome,
    XDG_DATA_HOME: layout.dataHome,
    XDG_CACHE_HOME: layout.cacheHome,
    XDG_STATE_HOME: layout.stateHome,
    TEMP: layout.tempDir,
    TMP: layout.tempDir,
    TMPDIR: layout.tempDir,
    PATH: pathValue,
    OPENCODE_CONFIG: layout.opencodeConfigPath,
    OPENCODE_CONFIG_DIR: layout.configDir,
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
  };

  ['LANG', 'LC_ALL'].forEach((key) => {
    if (process.env[key]) env[key] = process.env[key];
  });

  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    const parsedHome = path.parse(layout.homeDir);
    env.Path = pathValue;
    env.SystemRoot = systemRoot;
    env.WINDIR = systemRoot;
    env.ComSpec = path.join(systemRoot, 'System32', 'cmd.exe');
    env.PATHEXT = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
    env.APPDATA = layout.appDataDir;
    env.LOCALAPPDATA = layout.localAppDataDir;
    env.HOMEDRIVE = parsedHome.root.replace(/[\\/]$/, '');
    env.HOMEPATH = layout.homeDir.slice(parsedHome.root.length - 1);
  }

  return env;
}

// 准备 OpenCode 正式进程和自检共同使用的环境描述。
function prepareOpenCodeEnvironment({ app, runtimeRoot, workspaceDir }) {
  const layout = createOpenCodeEnvironmentLayout({ app, runtimeRoot, workspaceDir });
  ensureOpenCodeEnvironmentDirectories(layout);
  const toolEnvironment = ensureOpenCodeToolEnvironment({ app, workspaceDir });
  const env = applyOpenCodeToolEnvironment(buildOpenCodeBaseEnv(layout), toolEnvironment);
  const opencodeBinaryPath = getBundledOpencodeBinaryPath(app);
  const skillRoots = Array.from(new Set([
    path.resolve(runtimeRoot),
    path.resolve(path.dirname(opencodeBinaryPath)),
    path.resolve(toolEnvironment.bundledToolsBinDir),
  ]));
  const allowedRoots = Array.from(new Set([
    ...skillRoots,
    path.resolve(getAgentCacheDir(app)),
  ]));

  return {
    layout,
    toolEnvironment,
    env,
    allowedRoots,
    skillRoots,
    mutableRoots: [path.resolve(runtimeRoot), path.resolve(getAgentCacheDir(app))],
    permissionExceptionRoots: [path.resolve(layout.toolOutputDir)],
  };
}

// 生成固定为无用户配置文件的 Shell 路径。
function getOpenCodeShellPath() {
  if (process.platform !== 'win32') return '/bin/sh';
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) {
    throw new Error('OpenCode 逻辑隔离初始化失败：无法获取 Windows PowerShell 路径');
  }
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// 判断目标是否位于指定根目录内，Windows 下忽略路径大小写。
function isPathInsideRoot(rootDir, targetPath) {
  if (!rootDir || !targetPath) return false;
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (!relative) return true;
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  if (process.platform !== 'win32') return true;
  const normalizedRoot = root.toLowerCase();
  const normalizedTarget = target.toLowerCase();
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

// 判断目标是否位于任一允许根目录内。
function isPathInsideAnyRoot(roots, targetPath) {
  return (roots || []).some((root) => isPathInsideRoot(root, targetPath));
}

module.exports = {
  createOpenCodeEnvironmentLayout,
  ensureOpenCodeEnvironmentDirectories,
  getOpenCodeShellPath,
  isPathInsideAnyRoot,
  isPathInsideRoot,
  prepareOpenCodeEnvironment,
};
