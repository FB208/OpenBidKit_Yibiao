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
  return `请只在当前工作目录内工作。

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

function createTaskAbortController(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const abort = (reason) => {
    if (!controller.signal.aborted) {
      controller.abort(reason || new Error('Agent 任务已取消'));
    }
  };
  const onParentAbort = () => abort(parentSignal.reason);

  if (parentSignal?.aborted) {
    abort(parentSignal.reason);
  } else if (parentSignal) {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  const timer = setTimeout(() => abort(new Error('Agent 任务执行超时')), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      if (parentSignal) {
        try { parentSignal.removeEventListener('abort', onParentAbort); } catch {}
      }
    },
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason || new Error('Agent 任务已取消');
  }
}

function readOutputContent(workspaceDir, outputFile) {
  const outputPath = path.join(workspaceDir, safeRelativePath(outputFile));
  return {
    path: outputPath,
    content: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '',
  };
}

function annotateAgentError(error, meta) {
  error.agentTaskId = meta.taskId;
  error.agentTitle = meta.title;
  error.agentWorkspaceDir = meta.workspaceDir;
  error.agentRuntimeRoot = meta.runtimeRoot || '';
  error.agentOutputFile = meta.outputFile;
  error.agentOutputPath = meta.outputPath || '';
  error.agentPartialOutput = meta.outputContent || '';
  error.agentPartialOutputChars = String(meta.outputContent || '').length;
  error.openCodeRequestLog = Array.isArray(meta.requestLog) ? meta.requestLog : [];
  error.openCodeStderrTail = meta.stderrTail || '';
  return error;
}

function createAgentService({ app, configStore }) {
  async function runTask(payload = {}) {
    const taskId = payload.task_id || crypto.randomUUID();
    const title = payload.title || '易标智能体任务';
    const outputFile = payload.output_file || 'agent-result.md';
    const taskRoot = path.join(getAgentRuntimeDir(app), taskId);
    const workspaceDir = path.join(taskRoot, 'workspace');

    const prompt = payload.prompt || createDefaultAgentPrompt({
      task: payload.task || '请分析当前输入文件，并输出可执行结果。',
      outputFile,
    });

    const timeoutMs = Number(payload.timeout_ms || 10 * 60 * 1000);
    const abortController = createTaskAbortController(payload.signal, timeoutMs);

    let server = null;
    try {
      throwIfAborted(abortController.signal);
      writeWorkspaceFiles(workspaceDir, payload.files || []);

      server = await startIsolatedOpenCodeServer({
        app,
        configStore,
        workspaceDir,
        taskId,
        keepRuntime: Boolean(payload.keep_runtime),
        timeoutMs,
      });
      throwIfAborted(abortController.signal);

      let result = null;
      try {
        result = await runOpenCodeTask(server, {
          title,
          prompt,
          signal: abortController.signal,
        });
      } catch (error) {
        const output = readOutputContent(workspaceDir, outputFile);
        annotateAgentError(error, {
          taskId,
          title,
          workspaceDir,
          runtimeRoot: server?.runtimeRoot || taskRoot,
          outputFile,
          outputPath: output.path,
          outputContent: output.content,
          requestLog: server?.requestLog || [],
          stderrTail: server?.getStderrTail?.(8000) || '',
        });
        throw error;
      }

      const output = readOutputContent(workspaceDir, outputFile);

      return {
        success: true,
        task_id: taskId,
        title,
        workspace_dir: workspaceDir,
        runtime_root: server?.runtimeRoot || taskRoot,
        output_file: outputFile,
        output_content: output.content,
        assistant_text: result.text,
        diff: result.diff,
        session_id: result.session?.id || '',
        opencode_request_log: server?.requestLog || [],
        opencode_stderr_tail: server?.getStderrTail?.(8000) || '',
      };
    } catch (error) {
      if (!error.agentTaskId) {
        const output = readOutputContent(workspaceDir, outputFile);
        annotateAgentError(error, {
          taskId,
          title,
          workspaceDir,
          runtimeRoot: server?.runtimeRoot || taskRoot,
          outputFile,
          outputPath: output.path,
          outputContent: output.content,
          requestLog: server?.requestLog || [],
          stderrTail: server?.getStderrTail?.(8000) || '',
        });
      }
      throw error;
    } finally {
      abortController.cleanup();
      if (server) {
        await server.close();
      }
    }
  }

  return {
    runTask,
  };
}

module.exports = {
  createAgentService,
};
