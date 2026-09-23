const fs = require('node:fs');
const path = require('node:path');
const { CONTENT_GENERATION_AGENT_TASK_KEY, checkSectionHtml } = require('./contentGenerationAgent.cjs');
const { createContentGenerationImageTools, validateContentImageReferences } = require('./contentGenerationImageTools.cjs');
const { countHtmlWords } = require('./contentGenerationWordTools.cjs');
const { convertContentSections } = require('./contentGenerationOutput.cjs');

// 从当前目录按稳定 ID 定位小节；显示编号由当前树顺序计算。
function findSection(items, id, prefix = '') {
  for (const [index, item] of items.entries()) {
    const number = prefix ? `${prefix}.${index + 1}` : String(index + 1);
    if (item.id === id) return { ...item, number };
    const found = findSection(item.children || [], id, number);
    if (found) return found;
  }
}

// 只提交本次小节与用户要求，资料读取由原会话中的 Agent 自行决定。
function modificationPrompt(section, file, requirement) {
  return `本次任务是修改小节 ${section.number} ${section.title}，稳定 ID：${section.id}，文件：${file}。
先读取该文件，再按用户要求使用原生 edit 修改，只修改这个小节。遵守原有受限 HTML 规范和全局事实设定；未要求调整的内容和图片保持不变，原方案表格和图片继续保留。需要配图时使用现有图片工具，HTML/Mermaid 源码写入图片/下的新文件，按工具返回的 asset_ref 引用，不覆盖已有图片文件。
本次不重新编排、还原，不执行全文字数调整或一致性审计，也不修改正文生成结果.json。完成正文及所需图片后，在最后一次成功文件操作上标记 task_complete=true，程序负责转换 Word。
用户修改要求：
${requirement || '保留本节实质信息、事实参数、承诺及现有图片，整理段落顺序、合并重复表述，并修正含糊或不连贯的表达。'}`;
}

// 单节修改沿用正文任务和持久 Session；完成 HTML 后仅转换当前小节。
async function runContentSectionRegenerationTask({ agentService, aiService, workspaceStore, openXmlHelperService, payload, previousState, taskControl, updateTask, checkpointTask }) {
  const stored = previousState || workspaceStore.loadTechnicalPlan();
  const continuing = Boolean(payload.resume || payload.retryFailedSections || payload.retry_failed_sections);
  const previousRuntime = stored.contentGenerationRuntime || {};
  const id = continuing ? previousRuntime.target_item_id : payload.targetItemId;
  const section = findSection(stored.outlineData?.outline || [], id);
  if (!section || section.children?.length || section.content_mode !== 'ai-generate') throw new Error('未找到要修改的 AI 正文小节');
  if (!agentService.hasPersistentTaskSession(CONTENT_GENERATION_AGENT_TASK_KEY)) throw new Error('原正文 Agent 会话不存在，无法修改小节');
  const { paths: { workspaceDir } } = agentService.loadPersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY);
  const file = `正文/${encodeURIComponent(id)}.html`;
  if (!fs.existsSync(path.join(workspaceDir, file))) throw new Error(`小节 ${section.number} ${section.title} 的正文 HTML 不存在，无法修改`);
  const runtime = {
    ...previousRuntime, generation_started: true, target_item_id: id,
    section_words: { ...(previousRuntime.section_words || {}) },
    regenerate_requirement: continuing ? previousRuntime.regenerate_requirement : String(payload.requirement || '').trim(),
    phase: continuing ? previousRuntime.phase : 'generating', developer_stage_gate: '',
    html_output: {
      workspace_dir: workspaceDir, word_output_dir: workspaceStore.getContentWordOutputDir(),
      word_sections: (previousRuntime.html_output?.word_sections || []).filter(item => continuing || item.section_id !== id),
    },
  };
  let logs = [`${continuing ? '继续修改' : '开始修改'}小节：${section.number} ${section.title}。`];
  let task;
  let words = 0;
  let agentState;
  const controller = new AbortController();
  const signal = AbortSignal.any([taskControl.signal, controller.signal]);
  const checkPause = () => {
    if (taskControl.isPauseRequested() && !controller.signal.aborted) controller.abort(new Error('小节修改已暂停'));
  };
  const watcher = setInterval(checkPause, 500);

  // 只汇总当前目录的 AI 叶子，单节修改不把全文统计替换为本节字数。
  function totalWords(items) {
    return items.reduce((sum, item) => sum + (item.children?.length ? totalWords(item.children)
      : item.content_mode === 'ai-generate'
        ? runtime.section_words[item.id] || 0 : 0), 0);
  }

  // 使用原有阶段字段持久化进度，恢复时不把已存在的 HTML 当成修改完成。
  function publish(status, error) {
    const converted = runtime.phase === 'word-completed';
    const edited = runtime.phase !== 'generating';
    const label = converted ? '修改完成' : edited ? '正在转换 Word' : '正在修改小节';
    const progress = converted ? (status === 'success' ? 100 : 95) : edited ? 80 : 10;
    const detail = { mode: 'html-single', phase: runtime.phase, phase_label: label, phase_progress: converted ? 100 : 0,
      completed: converted ? 1 : 0, total: 1, step: runtime.phase, step_label: label };
    runtime.updated_at = new Date().toISOString();
    const sectionState = { ...stored.contentGenerationSections?.[id], id, title: section.title,
      content: stored.contentGenerationSections?.[id]?.content || section.content || '',
      status: status === 'success' ? 'success' : 'error', error, updated_at: runtime.updated_at };
    task = checkpointTask({ status, progress, progress_detail: detail, logs, error, pause_requested: false,
      stats: { ...(agentState ? { agent: agentState } : {}), content: {
        phase: runtime.phase, planning_total: 0, planning_completed: 0, generation_total: 1, generation_completed: edited ? 1 : 0,
        generated_html_words: words, generated_html_workspace: workspaceDir,
        current_words: totalWords(stored.outlineData.outline),
        word_conversion_total: 1, word_conversion_completed: converted ? 1 : 0, output_progress: detail,
      } },
    }, {
      contentGenerationRuntime: runtime,
      ...(['success', 'error'].includes(status) ? { contentGenerationItem: { nodeId: id, section: sectionState } } : {}),
    }, { ...(['success', 'error'].includes(status) ? { contentSection: sectionState } : {}) }).task;
  }

  // 直接读取目标产物，不依赖或改写全文结果清单。
  function readSection() {
    const html = checkSectionHtml(fs.readFileSync(path.join(workspaceDir, file), 'utf8'));
    validateContentImageReferences(workspaceDir, html);
    words = countHtmlWords(html);
    runtime.section_words[id] = words;
    return { workspaceDir, sections: [{ section_id: id, number: section.number, title: section.title, file, words }] };
  }

  try {
    publish('running');
    checkPause();
    signal.throwIfAborted();
    if (!['sections-completed', 'word-converting', 'word-completed'].includes(runtime.phase)) {
      agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, {
        run_id: task.task_id, status: 'running', phase: 'section-modification', agent_connection: 'running', error: null,
      });
      await agentService.runTask({
        task_id: task.task_id, title: `修改正文小节：${section.number} ${section.title}`,
        primary_session: true, summary_enabled: false, signal,
        persistent_task: { task_key: CONTENT_GENERATION_AGENT_TASK_KEY, mode: 'resume' },
        initial_stage: 'section-modification', output_file: file,
        prompt: modificationPrompt(section, file, runtime.regenerate_requirement),
        max_retries: 1, timeout_ms: 30 * 60 * 1000,
        active_tools: ['read', 'edit', 'write', 'find', 'ls', 'ask-user', 'report-failure', 'generate-image', 'render-html-image', 'render-mermaid-image'],
        create_tools: context => createContentGenerationImageTools({ aiService, signal }, context),
        validateOutput: () => readSection(),
        onCheckpoint(checkpoint) {
          agentState = { ...checkpoint, task_key: CONTENT_GENERATION_AGENT_TASK_KEY, run_id: task.task_id };
          publish('running');
        },
        onActivity(event) {
          if (event.visible === false || !event.message) return;
          updateTask({ logs: [...logs, event.message] });
        },
      });
      readSection();
      runtime.phase = 'sections-completed';
      logs.push('小节 HTML 修改完成，准备转换 Word。');
      publish('running');
      agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, { status: 'success', phase: 'completed', agent_connection: 'idle', error: null });
    }
    checkPause();
    signal.throwIfAborted();
    const result = readSection();
    runtime.phase = 'word-converting';
    publish('running');
    await convertContentSections({ result, outputDir: runtime.html_output.word_output_dir,
      openXmlHelperService, signal, completed: runtime.html_output.word_sections,
      onProgress(converted) {
        runtime.html_output.word_sections = [...runtime.html_output.word_sections.filter(item => item.section_id !== id), ...converted];
        runtime.phase = 'word-completed';
        logs.push('小节 Word 已更新。');
        publish('running');
      },
    });
    signal.throwIfAborted();
    runtime.phase = 'word-completed';
    publish('success');
  } catch (error) {
    if (taskControl.signal.aborted) throw error;
    const paused = taskControl.isPauseRequested();
    if (runtime.phase === 'generating') {
      agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, { status: paused ? 'paused' : 'error', agent_connection: 'idle', error: paused ? null : error.message });
    }
    logs.push(paused ? '小节修改已暂停，继续时从当前阶段恢复。' : error.message);
    publish(paused ? 'paused' : 'error', paused ? undefined : error.message);
  } finally {
    clearInterval(watcher);
  }
}

module.exports = { runContentSectionRegenerationTask };
