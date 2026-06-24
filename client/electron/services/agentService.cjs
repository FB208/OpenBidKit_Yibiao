const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { dialog } = require('electron');
const {
  getAgentRuntimeDir,
  getBundledOpencodeBinaryPath,
  getDeveloperLogsDir,
} = require('../utils/paths.cjs');
const { startIsolatedOpenCodeServer } = require('./opencode/opencodeServerRunner.cjs');
const { runOpenCodeTask } = require('./opencode/opencodeHttpClient.cjs');

const SELF_CHECK_TASK_ID = 'agent-self-check-latest';
const SELF_CHECK_OUTPUT_FILE = 'agent-self-check-result.json';
const SELF_CHECK_EXPECTED_MESSAGE = 'YIBIAO_AGENT_SELF_CHECK_OK';
const SELF_CHECK_TIMEOUT_MS = 2 * 60 * 1000;

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

function nowIso() {
  return new Date().toISOString();
}

function clipText(value, maxLength = 4000) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...（已截断，原始长度 ${text.length}）` : text;
}

function createStageError(stage, message) {
  const error = new Error(message);
  error.selfCheckStage = stage;
  return error;
}

function createSelfCheckSteps() {
  return [
    { id: 'prepare', label: '清理旧自检日志和运行目录', status: 'pending', message: '' },
    { id: 'binary-check', label: '检查 OpenCode 程序文件', status: 'pending', message: '' },
    { id: 'agent-run', label: '执行极简智能体任务', status: 'pending', message: '' },
    { id: 'output-check', label: '校验智能体输出', status: 'pending', message: '' },
  ];
}

function updateSelfCheckStep(steps, id, status, message) {
  const step = steps.find((item) => item.id === id);
  if (!step) return;
  step.status = status;
  step.message = message || '';
  step.updated_at = nowIso();
}

function getCurrentSelfCheckStage(steps) {
  return steps.find((step) => step.status === 'running')?.id || 'agent-run';
}

function createSelfCheckLogger(app) {
  const logDir = getDeveloperLogsDir(app, 'agent-self-check');
  const logFile = path.join(logDir, 'latest.jsonl');
  let setupError = '';

  try {
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.mkdirSync(logDir, { recursive: true });
  } catch (error) {
    setupError = error?.message || String(error);
  }

  return {
    logDir,
    logFile,
    setupError,
    write(event, payload = {}) {
      if (setupError) return;
      try {
        fs.appendFileSync(logFile, `${JSON.stringify({ at: nowIso(), event, ...payload })}\n`, 'utf-8');
      } catch (error) {
        setupError = error?.message || String(error);
      }
    },
    getSetupError() {
      return setupError;
    },
  };
}

function compactSelfCheckError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error || '智能体自检失败'),
    stage: error?.selfCheckStage || '',
    stack: clipText(error?.stack || '', 3000),
    agent_task_id: error?.agentTaskId || '',
    agent_title: error?.agentTitle || '',
    agent_workspace_dir: error?.agentWorkspaceDir || error?.openCodeWorkspaceDir || '',
    agent_runtime_root: error?.agentRuntimeRoot || error?.openCodeRuntimeRoot || '',
    agent_output_file: error?.agentOutputFile || '',
    agent_output_path: error?.agentOutputPath || '',
    agent_partial_output_chars: error?.agentPartialOutputChars || 0,
    agent_partial_output: clipText(error?.agentPartialOutput || '', 2000),
    opencode_binary_path: error?.openCodeBinaryPath || '',
    opencode_base_url: error?.openCodeBaseUrl || '',
    opencode_port: error?.openCodePort || 0,
    opencode_exit_code: error?.openCodeExitCode,
    opencode_exit_signal: error?.openCodeExitSignal || '',
    opencode_spawn_error: error?.openCodeSpawnError || '',
    opencode_last_health_error: error?.openCodeLastHealthError || '',
    opencode_last_health_cause: error?.openCodeLastHealthCause || '',
    opencode_stdout_tail: clipText(error?.openCodeStdoutTail || '', 4000),
    opencode_stderr_tail: clipText(error?.openCodeStderrTail || '', 4000),
    opencode_request_log: Array.isArray(error?.openCodeRequestLog) ? error.openCodeRequestLog : [],
  };
}

function buildSelfCheckPrompt() {
  return `请完成易标智能体自检。

要求：
1. 阅读 self-check-input.txt。
2. 必须把以下纯 JSON 写入 ${SELF_CHECK_OUTPUT_FILE}：
{"ok":true,"message":"${SELF_CHECK_EXPECTED_MESSAGE}"}
3. 不要写入 Markdown 代码块，不要添加解释文字。`;
}

function parseSelfCheckOutput(content) {
  const raw = String(content || '').trim();
  if (!raw) {
    throw createStageError('output-check', '智能体自检未生成输出文件内容');
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw createStageError('output-check', `智能体自检输出不是合法 JSON：${error?.message || String(error)}`);
  }
}

function validateSelfCheckOutput(content) {
  const data = parseSelfCheckOutput(content);
  if (data?.ok !== true || data?.message !== SELF_CHECK_EXPECTED_MESSAGE) {
    throw createStageError('output-check', `智能体自检输出不符合预期：${clipText(content, 1000)}`);
  }
  return data;
}

function formatSelfCheckDetails(result) {
  const lines = [
    `状态：${result.success ? '正常' : '异常'}`,
    `时间：${result.checked_at}`,
    `消息：${result.message}`,
    `OpenCode 路径：${result.opencode_binary_path || '-'}`,
    `运行目录：${result.runtime_root || '-'}`,
    `工作目录：${result.workspace_dir || '-'}`,
    `自检日志：${result.log_file || '-'}`,
  ];

  lines.push('');
  lines.push('阶段：');
  result.steps.forEach((step) => {
    lines.push(`- ${step.label}：${step.status}${step.message ? `，${step.message}` : ''}`);
  });

  if (result.error) {
    lines.push('');
    lines.push('错误：');
    lines.push(result.error.message || String(result.error));
  }

  if (result.diagnostics?.opencode_last_health_cause) {
    lines.push(`health cause：${result.diagnostics.opencode_last_health_cause}`);
  }
  if (result.diagnostics?.opencode_spawn_error) {
    lines.push(`spawn error：${result.diagnostics.opencode_spawn_error}`);
  }
  if (result.diagnostics?.opencode_exit_code !== undefined || result.diagnostics?.opencode_exit_signal) {
    lines.push(`exit：code=${result.diagnostics.opencode_exit_code ?? 'null'} signal=${result.diagnostics.opencode_exit_signal || 'null'}`);
  }
  if (result.diagnostics?.opencode_stdout_tail) {
    lines.push('');
    lines.push('stdout tail：');
    lines.push(result.diagnostics.opencode_stdout_tail);
  }
  if (result.diagnostics?.opencode_stderr_tail) {
    lines.push('');
    lines.push('stderr tail：');
    lines.push(result.diagnostics.opencode_stderr_tail);
  }
  if (result.diagnostics?.opencode_request_log?.length) {
    lines.push('');
    lines.push('OpenCode request log：');
    lines.push(JSON.stringify(result.diagnostics.opencode_request_log, null, 2));
  }
  if (result.output_content) {
    lines.push('');
    lines.push('输出：');
    lines.push(clipText(result.output_content, 1000));
  }

  return lines.join('\n');
}

function sanitizeReportFilename(value) {
  return String(value || '智能体自检报告')
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/g, '') || '智能体自检报告';
}

function formatTimestampForFilename(value) {
  const date = value ? new Date(value) : new Date();
  const source = Number.isNaN(date.getTime()) ? new Date() : date;
  const pad = (number) => String(number).padStart(2, '0');
  return [
    source.getFullYear(),
    pad(source.getMonth() + 1),
    pad(source.getDate()),
    '-',
    pad(source.getHours()),
    pad(source.getMinutes()),
    pad(source.getSeconds()),
  ].join('');
}

function markdownValue(value) {
  if (value === undefined || value === null || value === '') return '-';
  return String(value);
}

function markdownFence(value, language = '') {
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const text = String(content || '').trim();
  const fence = text.includes('```') ? '````' : '```';
  return `${fence}${language}\n${text || '-'}\n${fence}`;
}

function buildSelfCheckReportMarkdown(input = {}) {
  const result = input && typeof input === 'object' ? input : {};
  const diagnostics = result.diagnostics || result.error || {};
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const lines = [
    '# 易标智能体自检报告',
    '',
    '## 基本信息',
    '',
    `- 状态：${result.success ? '正常' : '异常'}`,
    `- 消息：${markdownValue(result.message)}`,
    `- 检测时间：${markdownValue(result.checked_at)}`,
    `- 耗时：${result.duration_ms ? `${result.duration_ms} ms` : '-'}`,
    `- OpenCode 路径：${markdownValue(result.opencode_binary_path || diagnostics.opencode_binary_path)}`,
    `- Runtime 目录：${markdownValue(result.runtime_root || diagnostics.agent_runtime_root)}`,
    `- Workspace 目录：${markdownValue(result.workspace_dir || diagnostics.agent_workspace_dir)}`,
    `- 输出文件：${markdownValue(result.output_path || diagnostics.agent_output_path)}`,
    `- 自检日志：${markdownValue(result.log_file)}`,
    '',
    '## 自检阶段',
    '',
  ];

  if (steps.length) {
    lines.push('| 阶段 | 状态 | 信息 | 更新时间 |');
    lines.push('| --- | --- | --- | --- |');
    steps.forEach((step) => {
      lines.push(`| ${markdownValue(step.label).replace(/\|/g, '\\|')} | ${markdownValue(step.status).replace(/\|/g, '\\|')} | ${markdownValue(step.message).replace(/\|/g, '\\|')} | ${markdownValue(step.updated_at).replace(/\|/g, '\\|')} |`);
    });
  } else {
    lines.push('无阶段信息。');
  }

  lines.push('', '## 错误详情', '');
  if (result.error || !result.success) {
    lines.push(`- 名称：${markdownValue(diagnostics.name)}`);
    lines.push(`- 阶段：${markdownValue(diagnostics.stage)}`);
    lines.push(`- 信息：${markdownValue(diagnostics.message || result.message)}`);
    lines.push(`- OpenCode Base URL：${markdownValue(diagnostics.opencode_base_url)}`);
    lines.push(`- OpenCode 端口：${markdownValue(diagnostics.opencode_port)}`);
    lines.push(`- 进程退出码：${markdownValue(diagnostics.opencode_exit_code)}`);
    lines.push(`- 进程退出信号：${markdownValue(diagnostics.opencode_exit_signal)}`);
    lines.push(`- Spawn 错误：${markdownValue(diagnostics.opencode_spawn_error)}`);
    lines.push(`- Health 错误：${markdownValue(diagnostics.opencode_last_health_error)}`);
    lines.push(`- Health 原因：${markdownValue(diagnostics.opencode_last_health_cause)}`);
  } else {
    lines.push('本次自检未发现错误。');
  }

  lines.push('', '## 页面展示详情', '', markdownFence(result.detail_text || '', 'text'));
  lines.push('', '## 智能体输出', '', markdownFence(result.output_content || diagnostics.agent_partial_output || '', 'json'));
  lines.push('', '## OpenCode stdout tail', '', markdownFence(diagnostics.opencode_stdout_tail || '', 'text'));
  lines.push('', '## OpenCode stderr tail', '', markdownFence(diagnostics.opencode_stderr_tail || '', 'text'));
  lines.push('', '## OpenCode request log', '', markdownFence(diagnostics.opencode_request_log || [], 'json'));
  lines.push('', '## 完整结构化结果', '', markdownFence(result, 'json'));

  return `${lines.join('\n')}\n`;
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
  error.openCodeStdoutTail = meta.stdoutTail || '';
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
          stdoutTail: server?.getStdoutTail?.(8000) || '',
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
        opencode_stdout_tail: server?.getStdoutTail?.(8000) || '',
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
          stdoutTail: server?.getStdoutTail?.(8000) || '',
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

  async function selfCheck() {
    const checkedAt = nowIso();
    const startedAt = Date.now();
    const steps = createSelfCheckSteps();
    const logger = createSelfCheckLogger(app);
    const taskRoot = path.join(getAgentRuntimeDir(app), SELF_CHECK_TASK_ID);
    const workspaceDir = path.join(taskRoot, 'workspace');
    const outputPath = path.join(workspaceDir, SELF_CHECK_OUTPUT_FILE);
    const opencodeBinaryPath = getBundledOpencodeBinaryPath(app);

    let agentResult = null;
    let outputContent = '';

    try {
      updateSelfCheckStep(steps, 'prepare', 'running', '正在清理旧自检运行目录');
      fs.rmSync(taskRoot, { recursive: true, force: true });
      updateSelfCheckStep(steps, 'prepare', 'success', logger.getSetupError() ? `自检日志初始化失败：${logger.getSetupError()}` : '已清理旧自检日志和运行目录');

      logger.write('self-check.started', {
        task_id: SELF_CHECK_TASK_ID,
        opencode_binary_path: opencodeBinaryPath,
        runtime_root: taskRoot,
        workspace_dir: workspaceDir,
      });

      updateSelfCheckStep(steps, 'binary-check', 'running', '正在检查 OpenCode 程序文件');
      if (!fs.existsSync(opencodeBinaryPath)) {
        throw createStageError('binary-check', `OpenCode binary 不存在：${opencodeBinaryPath}`);
      }
      updateSelfCheckStep(steps, 'binary-check', 'success', opencodeBinaryPath);

      updateSelfCheckStep(steps, 'agent-run', 'running', '正在启动 OpenCode Server 并执行极简任务');
      agentResult = await runTask({
        task_id: SELF_CHECK_TASK_ID,
        title: '易标智能体自检',
        prompt: buildSelfCheckPrompt(),
        output_file: SELF_CHECK_OUTPUT_FILE,
        files: [
          { path: 'self-check-input.txt', content: 'YIBIAO_AGENT_SELF_CHECK_INPUT' },
        ],
        timeout_ms: SELF_CHECK_TIMEOUT_MS,
        keep_runtime: true,
      });
      updateSelfCheckStep(steps, 'agent-run', 'success', `session_id=${agentResult.session_id || '-'}`);

      updateSelfCheckStep(steps, 'output-check', 'running', '正在校验智能体输出');
      outputContent = String(agentResult.output_content || '').trim();
      validateSelfCheckOutput(outputContent);
      updateSelfCheckStep(steps, 'output-check', 'success', '输出内容符合预期');

      const result = {
        success: true,
        status: 'normal',
        message: '智能体自检正常',
        checked_at: checkedAt,
        duration_ms: Date.now() - startedAt,
        log_dir: logger.logDir,
        log_file: logger.logFile,
        runtime_root: taskRoot,
        workspace_dir: workspaceDir,
        output_file: SELF_CHECK_OUTPUT_FILE,
        output_path: outputPath,
        output_content: outputContent,
        opencode_binary_path: opencodeBinaryPath,
        steps,
        diagnostics: {
          opencode_request_log: agentResult.opencode_request_log || [],
          opencode_stdout_tail: clipText(agentResult.opencode_stdout_tail || '', 4000),
          opencode_stderr_tail: clipText(agentResult.opencode_stderr_tail || '', 4000),
        },
      };
      result.detail_text = formatSelfCheckDetails(result);
      logger.write('self-check.completed', result);
      return result;
    } catch (error) {
      const stage = error?.selfCheckStage || getCurrentSelfCheckStage(steps);
      updateSelfCheckStep(steps, stage, 'error', error?.message || String(error || '智能体自检失败'));
      const diagnostics = compactSelfCheckError(error);
      outputContent = outputContent || diagnostics.agent_partial_output || '';

      const result = {
        success: false,
        status: 'error',
        message: error?.message || '智能体自检失败',
        checked_at: checkedAt,
        duration_ms: Date.now() - startedAt,
        log_dir: logger.logDir,
        log_file: logger.logFile,
        runtime_root: diagnostics.agent_runtime_root || taskRoot,
        workspace_dir: diagnostics.agent_workspace_dir || workspaceDir,
        output_file: SELF_CHECK_OUTPUT_FILE,
        output_path: diagnostics.agent_output_path || outputPath,
        output_content: outputContent,
        opencode_binary_path: diagnostics.opencode_binary_path || opencodeBinaryPath,
        steps,
        error: diagnostics,
        diagnostics,
      };
      result.detail_text = formatSelfCheckDetails(result);
      logger.write('self-check.failed', result);
      return result;
    }
  }

  async function exportSelfCheckReport(result = {}) {
    const markdown = buildSelfCheckReportMarkdown(result);
    const defaultDir = app?.getPath ? app.getPath('documents') : process.env.USERPROFILE || process.cwd();
    const defaultName = `${sanitizeReportFilename('智能体自检报告')}-${formatTimestampForFilename(result?.checked_at)}.md`;
    const saveResult = await dialog.showSaveDialog({
      title: '导出智能体自检报告',
      defaultPath: path.join(defaultDir, defaultName),
      filters: [{ name: 'Markdown 文档', extensions: ['md'] }],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { success: false, canceled: true, message: '已取消导出' };
    }

    fs.writeFileSync(saveResult.filePath, markdown, 'utf-8');
    return { success: true, path: saveResult.filePath, message: '智能体自检报告已导出' };
  }

  return {
    runTask,
    selfCheck,
    exportSelfCheckReport,
  };
}

module.exports = {
  createAgentService,
};
