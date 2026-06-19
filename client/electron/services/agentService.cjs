const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getAgentRuntimeDir } = require('../utils/paths.cjs');
const { startIsolatedOpenCodeServer } = require('./opencode/opencodeServerRunner.cjs');
const { runOpenCodeTask } = require('./opencode/opencodeHttpClient.cjs');

function safeRelativePath(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw.includes('..')) {
    throw new Error(`非法文件路径：${value}`);
  }
  const lower = raw.toLowerCase();
  const reserved =
    lower === 'opencode.json'
    || lower === 'opencode.jsonc'
    || lower === 'agents.md'
    || lower === 'claude.md'
    || lower.startsWith('.opencode/')
    || lower.startsWith('.config/opencode/')
    || lower.startsWith('.claude/');
  if (reserved) {
    throw new Error(`OpenCode 保留路径或指令文件不允许作为任务输入：${value}`);
  }
  return raw;
}

function writeWorkspaceFiles(workspaceDir, files = []) {
  fs.mkdirSync(workspaceDir, { recursive: true });

  files.forEach((file) => {
    const relativePath = safeRelativePath(file.path);
    const targetPath = path.join(workspaceDir, relativePath);
    const resolvedRoot = path.resolve(workspaceDir);
    const resolvedTarget = path.resolve(targetPath);

    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`文件路径越界：${file.path}`);
    }

    fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
    fs.writeFileSync(resolvedTarget, String(file.content || ''), 'utf-8');
  });
}

function createDefaultAgentPrompt({ task, outputFile }) {
  return `你是易标投标工具箱中的自主智能体。请只在当前工作目录内工作。

任务：
${task}

要求：
1. 先阅读当前目录中的输入文件。
2. 自主判断下一步需要做什么。
3. 如需产出结果，请写入 ${outputFile}。
4. 不要访问当前工作目录外的文件。
5. 不要联网。
6. 最终回复请包含：发现的问题、处理动作、输出文件路径。`;
}

function createAgentService({ app, configStore }) {
  async function runTask(payload = {}) {
    const taskId = payload.task_id || crypto.randomUUID();
    const title = payload.title || '易标智能体任务';
    const outputFile = payload.output_file || 'agent-result.md';
    const taskRoot = path.join(getAgentRuntimeDir(app), taskId);
    const workspaceDir = path.join(taskRoot, 'workspace');

    writeWorkspaceFiles(workspaceDir, payload.files || []);

    const prompt = payload.prompt || createDefaultAgentPrompt({
      task: payload.task || '请分析当前输入文件，并输出可执行结果。',
      outputFile,
    });

    const controller = new AbortController();
    const timeoutMs = Number(payload.timeout_ms || 10 * 60 * 1000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const server = await startIsolatedOpenCodeServer({
      app,
      configStore,
      workspaceDir,
      taskId,
      keepRuntime: Boolean(payload.keep_runtime),
    });

    try {
      const result = await runOpenCodeTask(server, {
        title,
        prompt,
        signal: controller.signal,
      });

      const outputPath = path.join(workspaceDir, safeRelativePath(outputFile));
      const outputContent = fs.existsSync(outputPath)
        ? fs.readFileSync(outputPath, 'utf-8')
        : '';

      return {
        success: true,
        task_id: taskId,
        title,
        workspace_dir: workspaceDir,
        output_file: outputFile,
        output_content: outputContent,
        assistant_text: result.text,
        diff: result.diff,
        session_id: result.session?.id || '',
      };
    } finally {
      clearTimeout(timer);
      await server.close();
    }
  }

  return {
    runTask,
  };
}

module.exports = {
  createAgentService,
};
