const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  getOpenCodeAgents,
  getOpenCodeConfig,
  getOpenCodePath,
  getOpenCodeSkills,
} = require('./opencodeHttpClient.cjs');
const { isPathInsideAnyRoot } = require('./opencodeEnvironment.cjs');

const ISOLATION_CHECK_TIMEOUT_MS = 15 * 1000;

// 统一比较路径，Windows 下忽略盘符和路径大小写。
function normalizePath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return Boolean(left && right && normalizePath(left) === normalizePath(right));
}

function summarizeSkills(skills) {
  return (Array.isArray(skills) ? skills : []).map((skill) => ({
    name: String(skill?.name || ''),
    ...(skill?.location ? { location: String(skill.location) } : {}),
  }));
}

// 没有文件位置的条目属于 OpenCode 内建项；带位置的 Skill 必须来自允许根目录。
function validateSkills(skills, allowedRoots, violations, source) {
  summarizeSkills(skills).forEach((skill) => {
    if (!skill.location || skill.location === '<built-in>') return;
    if (isPathInsideAnyRoot(allowedRoots, skill.location)) return;
    violations.push(`${source}加载了允许目录之外的 Skill：${skill.name || '未命名'}（${skill.location}）`);
  });
}

function createIsolationCheck(environmentInfo, overrides = {}) {
  const { layout } = environmentInfo;
  return {
    success: false,
    workspace_dir: layout.workspaceDir,
    home_dir: layout.homeDir,
    config_dir: layout.configDir,
    temp_dir: layout.tempDir,
    allowed_roots: [...environmentInfo.allowedRoots],
    effective_permission: '',
    external_read_denied: false,
    loaded_skills: [],
    violations: [],
    ...overrides,
  };
}

function createIsolationError(message, isolationCheck) {
  const error = new Error(message);
  error.selfCheckStage = 'isolation-check';
  error.isolationCheck = isolationCheck;
  return error;
}

// 以固定超时执行 OpenCode CLI 调试命令，避免预检阻塞客户端启动。
function runOpenCodeCli(opencodeBin, args, options) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(opencodeBin, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`OpenCode 逻辑隔离预检超时：${args.join(' ')}`));
    }, options.timeoutMs || ISOLATION_CHECK_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += String(chunk || ''); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`OpenCode 逻辑隔离预检无法启动：${error?.message || String(error)}`));
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`OpenCode 逻辑隔离预检失败：${args.join(' ')}，code=${code ?? 'null'}，signal=${signal || 'null'}${stderr.trim() ? `\n${stderr.trim()}` : ''}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseDebugPaths(output) {
  const result = {};
  String(output || '').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^(\S+)\s+(.+?)\s*$/);
    if (match) result[match[1]] = match[2];
  });
  return result;
}

function parseDebugSkills(output) {
  try {
    const value = JSON.parse(String(output || '').trim() || '[]');
    if (!Array.isArray(value)) throw new Error('返回值不是数组');
    return value;
  } catch (error) {
    throw new Error(`无法解析 opencode debug skill 输出：${error?.message || String(error)}`);
  }
}

// 正式启动前先验证 CLI 使用的全局目录和 Skill 来源。
async function runOpenCodeCliIsolationPreflight({ opencodeBin, workspaceDir, env, environmentInfo }) {
  const isolationCheck = createIsolationCheck(environmentInfo);
  try {
    const pathsResult = await runOpenCodeCli(
      opencodeBin,
      ['debug', 'paths', '--pure'],
      { cwd: workspaceDir, env },
    );
    const skillsResult = await runOpenCodeCli(
      opencodeBin,
      ['debug', 'skill', '--pure'],
      { cwd: workspaceDir, env },
    );
    const debugPaths = parseDebugPaths(pathsResult.stdout);
    const requiredPaths = ['home', 'data', 'bin', 'log', 'repos', 'cache', 'config', 'state', 'tmp'];
    requiredPaths.forEach((key) => {
      const value = debugPaths[key];
      if (!value) {
        isolationCheck.violations.push(`opencode debug paths 缺少 ${key} 路径`);
        return;
      }
      if (!isPathInsideAnyRoot(environmentInfo.mutableRoots, value)) {
        isolationCheck.violations.push(`OpenCode ${key} 路径越界：${value}`);
      }
    });
    if (debugPaths.home && !samePath(debugPaths.home, environmentInfo.layout.homeDir)) {
      isolationCheck.violations.push(`OpenCode HOME 不符合预期：${debugPaths.home}`);
    }
    if (debugPaths.config && !samePath(debugPaths.config, environmentInfo.layout.configDir)) {
      isolationCheck.violations.push(`OpenCode 配置目录不符合预期：${debugPaths.config}`);
    }

    const skills = parseDebugSkills(skillsResult.stdout);
    isolationCheck.loaded_skills = summarizeSkills(skills);
    validateSkills(skills, environmentInfo.skillRoots, isolationCheck.violations, 'CLI 预检');
    if (isolationCheck.violations.length) {
      throw createIsolationError(`OpenCode 逻辑隔离预检失败：${isolationCheck.violations.join('；')}`, isolationCheck);
    }
    return { debugPaths, skills: isolationCheck.loaded_skills };
  } catch (error) {
    if (error?.isolationCheck) throw error;
    isolationCheck.violations.push(error?.message || String(error));
    throw createIsolationError(`OpenCode 逻辑隔离预检失败：${error?.message || String(error)}`, isolationCheck);
  }
}

function getExternalDirectoryPermission(config) {
  const value = config?.permission?.external_directory;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return String(value['*'] || '');
  return '';
}

function validateEmptyObject(value, label, violations) {
  if (value && typeof value === 'object' && Object.keys(value).length) {
    violations.push(`${label}包含未授权配置：${Object.keys(value).join('、')}`);
  }
}

function validateEffectiveConfig(config, environmentInfo, violations) {
  const expectedAgentsPath = environmentInfo.toolEnvironment.agentsPath;
  const instructions = Array.isArray(config?.instructions) ? config.instructions : [];
  if (!instructions.length || instructions.some((item) => !samePath(item, expectedAgentsPath))) {
    violations.push(`最终额外指令来源不符合预期：${instructions.join('、') || '无'}`);
  }
  const plugins = Array.isArray(config?.plugin) ? config.plugin : [];
  const pluginOrigins = Array.isArray(config?.plugin_origins) ? config.plugin_origins : [];
  if (plugins.length || pluginOrigins.length) {
    violations.push('最终配置中存在外部插件');
  }
  const skillPaths = Array.isArray(config?.skills?.paths) ? config.skills.paths : [];
  const skillUrls = Array.isArray(config?.skills?.urls) ? config.skills.urls : [];
  if (skillUrls.length) violations.push(`最终配置中存在远程 Skill：${skillUrls.join('、')}`);
  skillPaths.forEach((item) => {
    if (!isPathInsideAnyRoot(environmentInfo.skillRoots, item)) {
      violations.push(`最终配置中的 Skill 路径越界：${item}`);
    }
  });
  validateEmptyObject(config?.mcp, 'MCP', violations);
  if (config?.shell !== environmentInfo.shellPath) {
    violations.push(`最终 Shell 不符合预期：${config?.shell || '未设置'}`);
  }
  const providerIds = Object.keys(config?.provider || {});
  if (providerIds.length !== 1 || providerIds[0] !== 'yibiao') {
    violations.push(`最终 Provider 配置受到外部污染：${providerIds.join('、') || '无'}`);
  }
  if (config?.model !== 'yibiao/default' || config?.small_model !== 'yibiao/default') {
    violations.push('最终模型配置受到外部污染');
  }
}

function validateAgentPermissions(agents, environmentInfo, violations) {
  const list = Array.isArray(agents) ? agents : [];
  if (!list.length) {
    violations.push('OpenCode Server 未返回 Agent 权限信息');
    return false;
  }
  let valid = true;
  list.forEach((agent) => {
    const rules = Array.isArray(agent?.permission) ? agent.permission : [];
    const externalRules = rules.filter((rule) => rule?.permission === 'external_directory');
    const wildcardDenyIndex = externalRules.findLastIndex(
      (rule) => rule?.pattern === '*' && rule?.action === 'deny',
    );
    if (wildcardDenyIndex < 0) {
      valid = false;
      violations.push(`Agent ${agent?.name || '未命名'} 缺少 external_directory * deny`);
      return;
    }
    externalRules.slice(wildcardDenyIndex + 1).forEach((rule) => {
      if (rule?.action === 'deny') return;
      if (rule?.action === 'allow' && isPathInsideAnyRoot(environmentInfo.permissionExceptionRoots, rule?.pattern)) return;
      valid = false;
      violations.push(`Agent ${agent?.name || '未命名'} 在 * deny 后存在越界规则：${rule?.pattern || '未知'} ${rule?.action || '未知'}`);
    });
  });
  return valid;
}

// 健康检查通过后，从实际 Server 读取最终路径、配置、Skill 和 Agent 权限。
async function verifyOpenCodeServerIsolation({ server, environmentInfo }) {
  const isolationCheck = createIsolationCheck(environmentInfo);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('OpenCode 逻辑隔离验证超时')), ISOLATION_CHECK_TIMEOUT_MS);
  try {
    const serverPaths = await getOpenCodePath(server, { signal: controller.signal });
    const config = await getOpenCodeConfig(server, { signal: controller.signal });
    const skills = await getOpenCodeSkills(server, { signal: controller.signal });
    const agents = await getOpenCodeAgents(server, { signal: controller.signal });
    if (!samePath(serverPaths?.directory, environmentInfo.layout.workspaceDir)) {
      isolationCheck.violations.push(`OpenCode Server 工作目录越界：${serverPaths?.directory || '未知'}`);
    }
    if (serverPaths?.worktree !== '/' && !samePath(serverPaths?.worktree, environmentInfo.layout.workspaceDir)) {
      isolationCheck.violations.push(`OpenCode Server 工作树越界：${serverPaths?.worktree || '未知'}`);
    }
    if (!samePath(serverPaths?.home, environmentInfo.layout.homeDir)) {
      isolationCheck.violations.push(`OpenCode Server HOME 不符合预期：${serverPaths?.home || '未知'}`);
    }
    if (!samePath(serverPaths?.config, environmentInfo.layout.configDir)) {
      isolationCheck.violations.push(`OpenCode Server 配置目录不符合预期：${serverPaths?.config || '未知'}`);
    }
    if (!samePath(serverPaths?.state, environmentInfo.layout.stateDir)) {
      isolationCheck.violations.push(`OpenCode Server 状态目录不符合预期：${serverPaths?.state || '未知'}`);
    }

    isolationCheck.effective_permission = getExternalDirectoryPermission(config);
    if (isolationCheck.effective_permission !== 'deny') {
      isolationCheck.violations.push(`external_directory 最终权限不是 deny：${isolationCheck.effective_permission || '未设置'}`);
    }
    validateEffectiveConfig(config, environmentInfo, isolationCheck.violations);
    isolationCheck.loaded_skills = summarizeSkills(skills);
    validateSkills(skills, environmentInfo.skillRoots, isolationCheck.violations, 'OpenCode Server');
    const agentPermissionValid = validateAgentPermissions(agents, environmentInfo, isolationCheck.violations);
    isolationCheck.external_read_denied = isolationCheck.effective_permission === 'deny' && agentPermissionValid;
    isolationCheck.success = isolationCheck.violations.length === 0;
    if (!isolationCheck.success) {
      throw createIsolationError(`OpenCode 逻辑隔离验证失败：${isolationCheck.violations.join('；')}`, isolationCheck);
    }
    return isolationCheck;
  } catch (error) {
    if (error?.isolationCheck) throw error;
    isolationCheck.violations.push(error?.message || String(error));
    throw createIsolationError(`OpenCode 逻辑隔离验证失败：${error?.message || String(error)}`, isolationCheck);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  runOpenCodeCliIsolationPreflight,
  verifyOpenCodeServerIsolation,
};
