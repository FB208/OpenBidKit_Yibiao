const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  BUNDLED_COMMANDS,
  SHIM_COMMANDS,
} = require('../agent/agentToolEnvironment.cjs');

const EXPECTED_PI_TOOLS = ['read', 'bash', 'edit', 'write', 'find', 'ls'];
const CRITICAL_COMMANDS = new Set(['node', ...BUNDLED_COMMANDS]);
const COMMANDS = ['node', ...BUNDLED_COMMANDS, ...SHIM_COMMANDS];

// 创建 Pi 自检的标准步骤列表。
function createPiSelfCheckSteps() {
  return [
    { id: 'sdk', label: 'Pi SDK', status: 'pending' },
    { id: 'runtime', label: '运行环境', status: 'pending' },
    { id: 'resources', label: '资源加载', status: 'pending' },
    { id: 'tools', label: '工具环境', status: 'pending' },
    { id: 'agent', label: '智能体任务', status: 'pending' },
    { id: 'output', label: '输出校验', status: 'pending' },
  ];
}

function getExecutableName(command) {
  return process.platform === 'win32' ? `${command}.exe` : command;
}

function getExpectedCommandPath(environment, command) {
  if (command === 'node') {
    return path.join(environment.toolEnvironment.runtimeToolsBinDir, process.platform === 'win32' ? 'node.cmd' : 'node');
  }
  if (BUNDLED_COMMANDS.includes(command)) {
    return path.join(environment.toolEnvironment.bundledToolsBinDir, getExecutableName(command));
  }
  return path.join(environment.toolEnvironment.runtimeToolsBinDir, process.platform === 'win32' ? `${command}.cmd` : command);
}

function getCommandLine(command) {
  const windows = process.platform === 'win32';
  const commands = {
    basename: 'basename a/b/c.txt',
    cat: 'cat tool-check-input.txt',
    cp: 'cp tool-check-input.txt cp-output.txt',
    cut: 'cut -c 1-3 tool-check-input.txt',
    dirname: 'dirname a/b/c.txt',
    du: 'du -s .',
    fd: 'fd --version',
    find: 'find . -name tool-check-input.txt',
    grep: 'grep alpha tool-check-input.txt',
    head: 'head -n 1 tool-check-input.txt',
    jq: 'jq --version',
    ls: 'ls .',
    mkdir: 'mkdir mkdir-output',
    mv: 'mv mv-source.txt mv-output.txt',
    node: 'node -e "console.log(process.version)"',
    pwd: 'pwd',
    realpath: 'realpath .',
    rg: 'rg --version',
    rm: 'rm rm-source.txt',
    sed: 'sed s/alpha/ALPHA/ tool-check-input.txt',
    sort: 'sort tool-check-input.txt',
    stat: 'stat tool-check-input.txt',
    tail: 'tail -n 1 tool-check-input.txt',
    touch: 'touch touch-output.txt',
    tr: windows ? 'Get-Content -Raw tool-check-input.txt | tr a A' : 'tr a A < tool-check-input.txt',
    uniq: 'sort tool-check-input.txt | uniq',
    wc: 'wc -l tool-check-input.txt',
  };
  return commands[command] || `${command} --version`;
}

function prepareCommandFixture(checkDir, command) {
  if (command === 'cp') fs.rmSync(path.join(checkDir, 'cp-output.txt'), { force: true });
  if (command === 'mkdir') fs.rmSync(path.join(checkDir, 'mkdir-output'), { recursive: true, force: true });
  if (command === 'mv') {
    fs.writeFileSync(path.join(checkDir, 'mv-source.txt'), 'move me\n', 'utf-8');
    fs.rmSync(path.join(checkDir, 'mv-output.txt'), { force: true });
  }
  if (command === 'rm') fs.writeFileSync(path.join(checkDir, 'rm-source.txt'), 'remove me\n', 'utf-8');
  if (command === 'touch') fs.rmSync(path.join(checkDir, 'touch-output.txt'), { force: true });
}

function compactOutput(value, maxLength = 500) {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function executeCommand(environment, command, cwd) {
  const commandLine = getCommandLine(command);
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${environment.shellCommandPrefix}\n${commandLine}`]
    : ['-c', commandLine];
  const startedAt = Date.now();
  const child = spawnSync(environment.shellPath, args, {
    cwd,
    env: environment.env,
    encoding: 'utf-8',
    timeout: 10000,
    windowsHide: true,
  });
  return {
    exit_code: child.status ?? (child.error ? 1 : 0),
    duration_ms: Date.now() - startedAt,
    stdout: compactOutput(child.stdout),
    stderr: compactOutput(child.stderr || child.error?.message),
    timed_out: child.error?.code === 'ETIMEDOUT',
  };
}

// 在 Pi 实际 Shell 环境中逐项执行共享命令，关键命令失败时判定自检失败。
function runPiToolEnvironmentSelfCheck(environment) {
  const checkDir = path.join(environment.layout.tempDir, `pi-tool-check-${Date.now()}`);
  try {
    fs.mkdirSync(checkDir, { recursive: true });
    fs.writeFileSync(path.join(checkDir, 'tool-check-input.txt'), 'alpha\nbeta\nalpha\ngamma\n', 'utf-8');
    const items = COMMANDS.map((command) => {
      prepareCommandFixture(checkDir, command);
      const execution = executeCommand(environment, command, checkDir);
      const critical = CRITICAL_COMMANDS.has(command);
      const success = execution.exit_code === 0 && !execution.timed_out;
      return {
        id: command,
        label: command,
        status: success ? 'success' : critical ? 'error' : 'warning',
        message: success ? '可用' : execution.timed_out ? '执行超时' : execution.stderr || `执行失败，exit=${execution.exit_code}`,
        detail: getExpectedCommandPath(environment, command),
        ...execution,
      };
    });
    const successCount = items.filter((item) => item.status === 'success').length;
    const warningCount = items.filter((item) => item.status === 'warning').length;
    const errorCount = items.filter((item) => item.status === 'error').length;
    return {
      success: errorCount === 0,
      summary: `${successCount}/${items.length} 可用${warningCount ? `，${warningCount} 个警告` : ''}${errorCount ? `，${errorCount} 个失败` : ''}`,
      items,
    };
  } finally {
    try { fs.rmSync(checkDir, { recursive: true, force: true }); } catch {}
  }
}

// 校验 Pi 只加载内置上下文，并精确启用方案指定工具。
function validatePiSessionSnapshot(snapshot = {}) {
  const activeTools = Array.isArray(snapshot.active_tools) ? snapshot.active_tools : [];
  const resourcesValid = snapshot.context_files?.length === 1
    && snapshot.context_files[0] === '<yibiao-agent-workspace>'
    && !snapshot.skills?.length
    && !snapshot.prompts?.length
    && !snapshot.extensions?.length;
  const toolsValid = activeTools.length === EXPECTED_PI_TOOLS.length
    && EXPECTED_PI_TOOLS.every((tool) => activeTools.includes(tool));
  return { resourcesValid, toolsValid };
}

// 将 Pi 自检信息转换为 Renderer 使用的公共诊断区。
function createPiDiagnosticSections({ layout, sdkVersion, sessionSnapshot = {}, toolCheck } = {}) {
  const validation = validatePiSessionSnapshot(sessionSnapshot);
  const toolStatus = !toolCheck?.success || !validation.toolsValid
    ? 'error'
    : toolCheck.items?.some((item) => item.status === 'warning') ? 'warning' : 'success';
  return [
    {
      id: 'pi-runtime',
      title: 'Pi 运行环境',
      status: sdkVersion ? 'success' : 'error',
      summary: 'Pi 使用应用专用目录和内存 Session',
      details: [
        { label: 'SDK 版本', value: sdkVersion || '-' },
        { label: '运行目录', value: layout.runtimeRoot },
        { label: 'Agent 配置目录', value: layout.agentDir },
        { label: '工作区', value: layout.workspaceDir },
      ],
    },
    {
      id: 'pi-resources',
      title: '资源加载',
      status: validation.resourcesValid ? 'success' : 'error',
      summary: validation.resourcesValid ? '仅加载易标内置工作区指令' : '资源加载结果不符合配置',
      details: [
        { label: '上下文文件', value: sessionSnapshot.context_files?.join('、') || '-' },
        { label: 'Skill', value: String(sessionSnapshot.skills?.length || 0) },
        { label: 'Prompt', value: String(sessionSnapshot.prompts?.length || 0) },
        { label: '扩展', value: String(sessionSnapshot.extensions?.length || 0) },
      ],
    },
    {
      id: 'pi-tools',
      title: '工具环境',
      status: toolStatus,
      summary: validation.toolsValid ? toolCheck?.summary || '共享命令检查完成' : 'Pi 工具注册结果不符合配置',
      items: [
        ...EXPECTED_PI_TOOLS.map((tool) => ({
          id: `tool-${tool}`,
          label: tool,
          status: sessionSnapshot.active_tools?.includes(tool) ? 'success' : 'error',
          message: sessionSnapshot.active_tools?.includes(tool) ? '已启用' : '未启用',
        })),
        ...(toolCheck?.items || []).map((item) => ({
          id: `command-${item.id}`,
          label: item.label,
          status: item.status,
          message: item.message,
          detail: item.detail,
        })),
      ],
    },
  ];
}

module.exports = {
  EXPECTED_PI_TOOLS,
  createPiDiagnosticSections,
  createPiSelfCheckSteps,
  runPiToolEnvironmentSelfCheck,
  validatePiSessionSnapshot,
};
