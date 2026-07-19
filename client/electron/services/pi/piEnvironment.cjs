const fs = require('node:fs');
const path = require('node:path');
const { getAgentRuntimeDir } = require('../../utils/paths.cjs');
const {
  applyAgentToolEnvironment,
  ensureAgentToolEnvironment,
  getAgentWorkspaceInstructions,
} = require('../agent/agentToolEnvironment.cjs');

// 创建 Pi 独立运行目录，避免读取用户的 Pi 配置目录。
function createPiEnvironmentLayout(app, runtimeId) {
  const runtimeRoot = path.join(getAgentRuntimeDir(app), runtimeId);
  const serviceRoot = path.join(runtimeRoot, 'service');
  const homeDir = path.join(serviceRoot, 'home');
  return {
    runtimeRoot,
    serviceRoot,
    workspaceDir: path.join(serviceRoot, 'workspace'),
    tasksRoot: path.join(runtimeRoot, 'tasks'),
    homeDir,
    agentDir: path.join(homeDir, '.pi', 'agent'),
    tempDir: path.join(serviceRoot, 'tmp'),
  };
}

// 创建 Pi 运行所需目录和共享命令环境。
function preparePiEnvironment(app, runtimeId) {
  const layout = createPiEnvironmentLayout(app, runtimeId);
  Object.values(layout).forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
  const toolEnvironment = ensureAgentToolEnvironment({
    app,
    runtimeRoot: layout.serviceRoot,
    workspaceDir: layout.workspaceDir,
    writeInstructions: false,
  });
  const env = applyAgentToolEnvironment({
    ...process.env,
    HOME: layout.homeDir,
    USERPROFILE: layout.homeDir,
    TEMP: layout.tempDir,
    TMP: layout.tempDir,
    TMPDIR: layout.tempDir,
  }, toolEnvironment);
  const shellPath = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : '/bin/sh';
  const shellCommandPrefix = process.platform === 'win32'
    ? [
      "@('cat', 'cp', 'ls', 'mkdir', 'mv', 'pwd', 'rm', 'sort') | ForEach-Object { Remove-Item -LiteralPath \"Alias:$_\" -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath \"Function:$_\" -Force -ErrorAction SilentlyContinue }",
      '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    ].join('\n')
    : '';
  return {
    layout,
    env,
    shellPath,
    shellCommandPrefix,
    toolEnvironment,
    instructions: getAgentWorkspaceInstructions(),
  };
}

module.exports = {
  createPiEnvironmentLayout,
  preparePiEnvironment,
};
