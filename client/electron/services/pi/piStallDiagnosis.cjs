const Ajv = require('ajv');
const { STAGE_LOOP_LIMIT } = require('./piStageLoopGuard.cjs');

// 阶段空转后的诊断：暂停原 Agent，由诊断 Agent 阅读源码资料、原工作区和原会话记录，给出处理结论；
// Runtime 只按结论分支（发说明继续、停止或调用业务登记的收尾函数），语义判断交给诊断 Agent。
const AGENT_STALLED_LOOP_CODE = 'AGENT_STALLED_LOOP';
const STALL_DIAGNOSIS_LIMIT = 2;
const DIAGNOSIS_OUTPUT_FILE = '诊断结论.json';
const SESSION_RECORD_FILE = '原会话记录.md';
const DIAGNOSIS_TIMEOUT_MS = 20 * 60 * 1000;
const RECORD_LIMITS = { prompt: 20000, text: 2000, args: 2000, result: 2000, error: 8000, total: 200000 };
const CATEGORY_LABELS = { guide: '原 Agent 能处理', stop: '需要停止', finish: '执行收尾' };

function createStalledLoopError(message) {
  const error = new Error(message);
  error.code = AGENT_STALLED_LOOP_CODE;
  return error;
}

function clip(value, limit) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断，原文 ${text.length} 字符）` : text;
}

function textOf(content) {
  if (!Array.isArray(content)) return String(content ?? '');
  return content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n');
}

function argumentsText(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value ?? {}); } catch { return String(value); }
}

// 从会话分支摘录本阶段记录：逐轮列出程序提示、助手文字、工具调用和结果；跳过思考内容，重复提示合并，超长时保留首条提示和最近记录。
function extractSessionRecord(sessionManager, fromEntryId, { stage = '', sessionFile = '' } = {}) {
  const branch = sessionManager?.getBranch?.() || [];
  const startIndex = fromEntryId ? branch.findIndex(entry => entry.id === fromEntryId) + 1 : 0;
  const blocks = [];
  let lastPrompt = null;
  let round = 0;
  for (const entry of branch.slice(Math.max(0, startIndex))) {
    if (entry.type === 'compaction') {
      blocks.push(`> 上下文压缩：${clip(entry.summary, 500)}`);
      continue;
    }
    if (entry.type !== 'message' || !entry.message) continue;
    const message = entry.message;
    if (message.role === 'user') {
      round += 1;
      const text = textOf(message.content);
      blocks.push(`## 第 ${round} 轮 程序提示\n${text === lastPrompt ? '（与上一条程序提示相同）' : clip(text, RECORD_LIMITS.prompt)}`);
      lastPrompt = text;
    } else if (message.role === 'assistant') {
      const lines = [];
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === 'text' && part.text?.trim()) lines.push(`助手：${clip(part.text.trim(), RECORD_LIMITS.text)}`);
        else if (part?.type === 'toolCall') lines.push(`调用 ${part.name}：${clip(argumentsText(part.arguments), RECORD_LIMITS.args)}`);
      }
      if (message.stopReason === 'error' || message.errorMessage) lines.push(`助手请求出错：${clip(message.errorMessage || message.stopReason, RECORD_LIMITS.error)}`);
      if (lines.length) blocks.push(lines.join('\n'));
    } else if (message.role === 'toolResult') {
      blocks.push(`结果 ${message.toolName}${message.isError ? '（报错）' : ''}：${clip(textOf(message.content), message.isError ? RECORD_LIMITS.error : RECORD_LIMITS.result)}`);
    }
  }
  const header = `# 原会话记录\n阶段：${stage || '未命名'}；范围：本次运行进入该阶段以后的会话记录（共 ${round} 轮程序提示）。${sessionFile ? `完整会话文件：${sessionFile}` : ''}`;
  let total = header.length;
  const kept = [];
  // 首条阶段提示必须保留，其余从最近的记录往前取，超出上限时标明省略。
  const first = blocks.length ? blocks[0] : '';
  total += first.length;
  let index = blocks.length - 1;
  for (; index > 0; index -= 1) {
    if (total + blocks[index].length > RECORD_LIMITS.total) break;
    total += blocks[index].length;
    kept.unshift(blocks[index]);
  }
  const omitted = index;
  return [header, first, ...(omitted > 0 ? [`…（中间 ${omitted} 条记录已省略，需要时检索完整会话文件）`] : []), ...kept].filter(Boolean).join('\n\n');
}

function diagnosisSchema(categories) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['category', 'cause', 'evidence'],
    properties: {
      category: { type: 'string', enum: categories },
      cause: { type: 'string', minLength: 1 },
      evidence: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      guidance: { type: 'string' },
      user_message: { type: 'string' },
    },
  };
}

// 结果文件先按 Schema 校验，再检查各类结论的必填说明；问题交回诊断 Agent 修复。
function parseDiagnosis(content, categories) {
  const issue = message => ({ value: null, issues: [{ severity: 'blocking', file: DIAGNOSIS_OUTPUT_FILE, message }] });
  let value;
  try {
    value = JSON.parse(String(content || ''));
  } catch (error) {
    return issue(`${DIAGNOSIS_OUTPUT_FILE} 不是有效 JSON：${error.message}`);
  }
  const validate = new Ajv({ allErrors: true, strict: true }).compile(diagnosisSchema(categories));
  if (!validate(value)) return issue(`${DIAGNOSIS_OUTPUT_FILE} 不符合要求：${validate.errors.map(error => `${error.instancePath || '/'} ${error.message}`).join('；')}`);
  if (value.category === 'guide' && !value.guidance?.trim()) return issue('category 为 guide 时必须填写 guidance：给原 Agent 的具体处理说明。');
  if (value.category !== 'guide' && !value.user_message?.trim()) return issue(`category 为 ${value.category} 时必须填写 user_message：面向用户的简短说明。`);
  return { value, issues: [] };
}

function describePrevious(previous) {
  return previous.map((item, index) => item.diagnosis
    ? `第 ${index + 1} 次诊断：结论 ${item.diagnosis.category}（${CATEGORY_LABELS[item.diagnosis.category]}）；原因：${item.diagnosis.cause}${item.diagnosis.guidance ? `；发给原 Agent 的处理说明：${item.diagnosis.guidance}` : ''}`
    : `第 ${index + 1} 次诊断未能完成：${item.error}`).join('\n');
}

function buildDiagnosisPrompt({ title, stage, prompt, sourceDir, workspaceDir, sessionFile, stateFile, categories, attempt, previous }) {
  const finish = categories.includes('finish');
  const sources = [
    `1. 当前工作区中的 ${SESSION_RECORD_FILE}：程序从原会话摘录的本阶段记录，逐轮列出程序提示、原 Agent 的工具调用和结果。先读它。`,
    `2. 诊断资料目录：${sourceDir}。这是本客户端的源码，按仓库原目录结构存放（sql/、client/、openxmlhelper/）。先读 client/开发说明.md 了解框架和流程约定，再按阶段名、工具名和提示中的关键词检索相关代码，弄清这个阶段要求做什么、程序如何判断完成、原 Agent 应该调用什么工具。`,
    `3. 原任务工作区：${workspaceDir}。`,
    ...(sessionFile ? [`4. 原会话文件：${sessionFile}。JSONL 格式，内容较大，需要时用 rg 检索。`] : []),
    ...(stateFile ? [`${sessionFile ? 5 : 4}. 任务状态：${stateFile}。`] : []),
  ];
  const categoryRules = [
    '- guide：原 Agent 用当前阶段已有的工具就能完成。在 guidance 中直接对原 Agent 写处理说明：下一步调用哪个工具、关键参数、完成标记放在哪个调用上，以及要避免的做法；不要让它重做已完成的工作。',
    '- stop：问题出在程序或数据状态上，原 Agent 用现有工具无法处理，或者继续执行会损坏结果。在 user_message 中面向不懂软件开发的用户，简单说明发生了什么、建议怎么做，不出现文件名、字段名、代码等术语。',
    ...(finish ? ['- finish：本阶段剩余工作对后续流程没有严重影响，可以由程序结束本阶段（程序会代为执行本阶段的程序工具或复核收尾，未完成的部分记为遗留问题），然后进入下一阶段。在 user_message 中面向用户说明哪些工作没有完成、对结果有什么影响，同样不出现软件术语。'] : []),
  ];
  return `你是易标投标工具箱的诊断 Agent。另一个 Agent（下称原 Agent）正在执行「${title}」任务，在阶段「${stage}」连续 ${STAGE_LOOP_LIMIT} 轮结束本轮都没有完成阶段要求，程序每轮原样重发了同一条提示。程序已暂停原 Agent，由你查明原因并给出处理结论。

程序反复发出的提示：
<<<
${prompt}
>>>

可以阅读的资料：
${sources.join('\n')}
这些资料只能阅读和分析，绝不修改、删除或移动其中任何文件；不访问以上路径之外的位置。可以使用全部工具和命令（包括 bash），笔记、脚本和结论只写在当前工作区。

分析方法：对照源码中该阶段的要求和完成条件，弄清原 Agent 每轮做了什么、为什么没有达到完成条件，例如调用了错误的工具、把完成标记放在了别的工具上、工具反复报错、误解了要求，或者程序或数据状态异常。结论要有依据，引用会话记录轮次、工作区文件或源码中的具体位置。

结论只能选一类（category）：
${categoryRules.join('\n')}
选择顺序：原 Agent 能处理时选 guide；原 Agent 无法处理时，${finish ? '剩余工作不影响后续流程的选 finish，否则选 stop' : '选 stop'}。
${previous.length ? `\n这是第 ${attempt} 次诊断。之前的情况：\n${describePrevious(previous)}\n程序已按上一次结论处理，但原 Agent 之后仍连续 ${STAGE_LOOP_LIMIT} 轮没有进展，或上一次诊断没有完成。重新分析原因，不要重复同样的建议；原 Agent 确实无法按说明完成时，改选其他结论。\n` : ''}
输出：把结论写入当前工作区的 ${DIAGNOSIS_OUTPUT_FILE}，用 json-validation 自查后结束本任务。字段：
- category：${categories.join('、')} 之一；
- cause：问题原因，一两句话；
- evidence：依据数组，每项写明出处和内容；
- guidance：category 为 guide 时必填；
- user_message：category 为 ${categories.filter(item => item !== 'guide').join(' 或 ')} 时必填。`;
}

// 诊断任务的工作区约定例外：允许只读访问工作区外的诊断资料和原任务文件。
function buildWorkspaceInstructions(readablePaths) {
  return `本任务例外：除当前工作区外，还可以只读访问以下路径：\n${readablePaths.map(item => `- ${item}`).join('\n')}\n不得修改、删除或移动这些路径中的任何文件；其余约定不变。`;
}

// 发给原 Agent 的续接提示：说明程序检测到的情况和诊断结论，最后附上原阶段要求。
function buildGuidancePrompt(diagnosis, stagePrompt) {
  return `程序检测到你在当前阶段连续 ${STAGE_LOOP_LIMIT} 轮结束本轮都没有完成阶段要求，已暂停并诊断了原因。\n诊断原因：${diagnosis.cause}\n处理说明：${diagnosis.guidance}\n按处理说明继续完成本阶段，保留已完成的内容。\n\n本阶段要求：\n${stagePrompt}`;
}

// 启动一次诊断子任务并返回已校验的结论；子任务失败时抛出错误，由 resolveStall 计次。
async function runDiagnosisTask({ runChildTask, title, stage, prompt, sourceDir, workspaceDir, sessionFile, stateFile, record, categories, attempt, previous, signal, onActivity }) {
  const readable = [sourceDir, workspaceDir, sessionFile, stateFile].filter(Boolean);
  const result = await runChildTask({
    title: `空转诊断：${title}`,
    primary_session: false,
    failure_handled_by_parent: true,
    summary_enabled: false,
    prompt: buildDiagnosisPrompt({ title, stage, prompt, sourceDir, workspaceDir, sessionFile, stateFile, categories, attempt, previous }),
    files: [{ path: SESSION_RECORD_FILE, content: record }],
    output_file: DIAGNOSIS_OUTPUT_FILE,
    json_validation_schemas: { [DIAGNOSIS_OUTPUT_FILE]: diagnosisSchema(categories) },
    workspace_instructions: buildWorkspaceInstructions(readable),
    max_retries: 1,
    timeout_ms: DIAGNOSIS_TIMEOUT_MS,
    signal,
    onActivity,
    validateOutput: candidate => parseDiagnosis(candidate.output_content, categories),
  });
  return result.validation_result;
}

// 判定空转后按诊断结论处理并返回最终续接：guide 换成诊断说明，stop 抛出停止错误，finish 交给本阶段登记的收尾函数。
// diagnoses 为本阶段已用的诊断记录（含失败），每阶段最多 STALL_DIAGNOSIS_LIMIT 次，用完后再空转直接停止。
async function resolveStall({ continuation, diagnoses, guard, finisher, meta, runDiagnosis, notify, signal }) {
  const categories = finisher ? ['guide', 'stop', 'finish'] : ['guide', 'stop'];
  const retryHint = '已完成的进度保留，可继续任务重试。';
  let diagnosis = null;
  while (!diagnosis) {
    if (diagnoses.length >= STALL_DIAGNOSIS_LIMIT) {
      const done = diagnoses.filter(item => item.diagnosis);
      throw createStalledLoopError(done.length
        ? `Agent 在当前阶段经过 ${diagnoses.length} 次诊断处理后仍没有完成阶段要求，任务已停止；${retryHint}诊断原因：${done.map(item => item.diagnosis.cause).join('；')}`
        : `Agent 在当前阶段连续多轮没有完成阶段要求，诊断未能完成，任务已停止；${retryHint}诊断失败原因：${diagnoses.map(item => item.error).join('；')}`);
    }
    const attempt = diagnoses.length + 1;
    notify(`Agent 在当前阶段连续 ${STAGE_LOOP_LIMIT} 轮没有完成阶段要求，正在诊断原因（第 ${attempt}/${STALL_DIAGNOSIS_LIMIT} 次）`);
    try {
      diagnosis = await runDiagnosis({ attempt, previous: [...diagnoses], categories });
      diagnoses.push({ diagnosis });
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      const reason = error?.message || String(error);
      diagnoses.push({ error: reason });
      notify(`诊断未能完成：${reason.slice(0, 200)}`);
    }
  }
  if (diagnosis.category === 'guide') {
    notify(`诊断结论：${diagnosis.cause}。已把处理说明发给 Agent 继续执行。`);
    guard.restart();
    return { ...continuation, prompt: buildGuidancePrompt(diagnosis, continuation.prompt) };
  }
  if (diagnosis.category === 'finish') {
    notify(`诊断结论：${diagnosis.cause}。由程序结束本阶段：${diagnosis.user_message}`);
    return finisher({ ...meta, diagnosis });
  }
  throw createStalledLoopError(`Agent 在当前阶段连续多轮没有完成阶段要求，经诊断需要停止任务。${diagnosis.user_message}\n${retryHint}`);
}

module.exports = {
  AGENT_STALLED_LOOP_CODE, STALL_DIAGNOSIS_LIMIT, DIAGNOSIS_OUTPUT_FILE, SESSION_RECORD_FILE,
  extractSessionRecord, diagnosisSchema, parseDiagnosis, buildDiagnosisPrompt, buildWorkspaceInstructions,
  buildGuidancePrompt, runDiagnosisTask, resolveStall,
};
