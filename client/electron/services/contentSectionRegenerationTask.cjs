const fs = require('node:fs');
const { NATIVE_AGENT_TOOLS } = require('./agent/agentToolEnvironment.cjs');
const path = require('node:path');
const { CONTENT_GENERATION_AGENT_TASK_KEY, CONTINUE_PROMPT, wasStagePrompted, BASELINE_GROUPS, checkSectionHtml, listSectionFiles } = require('./contentGenerationAgent.cjs');
const { createContentGenerationImageTools, validateContentImageReferences } = require('./contentGenerationImageTools.cjs');
const { countHtmlWords } = require('./contentGenerationWordTools.cjs');
const { convertContentSections } = require('./contentGenerationOutput.cjs');
const { findHtmlStructureIssues } = require('../utils/htmlStructure.cjs');
const { TASK_DIR, LIST_DIR, SECTION_MODIFICATION_SUBDIR, TASK_FILE_WRITING, taskFilePath, taskFileSchemas, clearTaskArtifacts } = require('./contentGenerationTaskFiles.cjs');

// 单节修改与正文主任务共用工作区，图片任务文件和清单放在独立子目录，不影响主任务未完成的任务文件。
const TASK_SUBDIR = `${TASK_DIR}/${SECTION_MODIFICATION_SUBDIR}`;
const IMAGE_TASK_KEYS = ['images', 'renderHtml', 'renderMermaid', 'applyImages'];

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
先读取该文件，再按用户要求优先使用原生 edit 修改，可按需使用 bash 处理工作区文件，只修改这个小节的正文；其他小节和输入资料由程序维护，被改动的会在提交时还原。遵守原有受限 HTML 规范和全局事实设定；未要求调整的内容和图片保持不变，原方案表格和图片继续保留。本次新增或改写的正文禁止使用 LaTeX 语法，包括 $...$、$$...$$、\\(...\\)、\\[...\\] 及 \\frac、\\text、\\circ 等命令。公式、参数和单位使用普通文字、Unicode 数学符号及受限 HTML 的 <sup>、<sub> 表达，例如 22 ℃ ± 2 ℃、40%～65%、≥30 m<sup>3</sup>/(h·人)。参考材料中的 LaTeX 在写入正文时也须转换为上述表达，保持数值、单位和含义不变。需要配图时先保存 figure 布局，再调用 list-section-images 读取本小节最新图片清单，可传本节 section_ids 直接取得明细；image_id 沿用清单标识，不自行重编，原图和未要求调整的有效图片直接复用。需要修正结构或提示词时可 read/edit 后重新提取。完成本次要求的配图生成、失败项修复和正文图片引用更新，保留有效的已有成果。清单和源码的读取、任务整理及处理批次由你自主决定，可分批读取、分批保存和提交，无需一次掌握全部图片明细。将本次待生成的 AI、HTML、Mermaid 图片写入 ${taskFilePath('images', TASK_SUBDIR)}，格式为 {"images":[{"image_id":"清单标识","kind":"ai/html/mermaid","prompt":"…"}]}，再调用 generate-section-images 提交。每项提供清单 image_id、kind 和准确的内容与数据 prompt；AI 另填与画框比例一致的具体 size 及与 template 画面形式一致的 style，prompt 正向描述画面且与已有图片在主体或视角景别上区分，HTML 另填与正文画框一致的 frame_size。已有有效图片的项自动跳过；用户要求替换已有图片时，对应项加 "regenerate": true，原方案图片不重新生成。${TASK_FILE_WRITING}程序向现有生图及文本队列同时提交，源码逐张完成后立即本地转图，超限自动排队。每张成功图片由程序立即回填正文；按返回的 unresolved 逐项检查 status、stage 和 error，按工具说明处理未成功项。有 source_file 的失败或未完成项直接读取、必要时修改源码后写入 ${taskFilePath('renderHtml', TASK_SUBDIR)} 或 ${taskFilePath('renderMermaid', TASK_SUBDIR)}（每项 image_id、source_file，HTML 另填 frame_size），再调用对应 render 工具。无源码的失败项才重试生成。render 工具成功后同样自动回填，无须再调用 apply-section-images。仅对返回 applied=false 的项，按 apply_error 刷新清单后写入 ${taskFilePath('applyImages', TASK_SUBDIR)}（每项 image_id、图片工具返回的 asset_ref 和 previous_asset_ref），再调用 apply-section-images 重试；程序只更新对应 img 的引用。状态非 success 的项不回填。仅重试失败或需要修正的项，不覆盖已有图片文件。暂停恢复时核对最新清单（成功图片已回填）与会话中的未完成项，复用已保存源码；已完成的图片再次提交时自动跳过，无源码的剩余项提交生成工具，已有源码的剩余项使用对应 render 工具。
本次不重新编排、还原，不执行全文字数调整或一致性审计，也不修改正文生成结果.json。完成正文及所需图片后，在最后一次成功的 edit、bash、图片生成、转图或 apply-section-images 操作上标记 task_complete=true，程序负责转换 Word。
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
  const htmlImageOptimization = stored.contentGenerationOptions?.htmlImageOptimization === true;
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

  // 保存当前小节的真实字数和转换输入，不依赖或改写全文结果清单。
  function sectionResult(html) {
    words = countHtmlWords(html);
    runtime.section_words[id] = words;
    return { workspaceDir, sections: [{ section_id: id, number: section.number, title: section.title, file, words }] };
  }

  // 转换阶段继续直接读取产物，文件和执行错误按原流程抛出。
  function readSection() {
    const html = checkSectionHtml(fs.readFileSync(path.join(workspaceDir, file), 'utf8'));
    validateContentImageReferences(workspaceDir, html);
    return sectionResult(html);
  }

  // 单节修改是独立主任务，逐项报告提交问题并使用 Runtime 的统一修复预算。
  function validateSectionOutput(candidate) {
    const html = String(candidate.output_content || '').trim();
    const issues = [];
    const issue = message => ({ severity: 'blocking', file, section_id: id, message });
    try {
      checkSectionHtml(html);
    } catch (error) {
      if (error?.code || error?.constructor !== Error) throw error;
      issues.push(issue(error.message));
    }
    issues.push(...findHtmlStructureIssues(html).map(issue));
    try {
      validateContentImageReferences(workspaceDir, html);
    } catch (error) {
      // 校验器的普通 Error 是引用问题；OS 错误和其他执行异常继续抛出。
      if (error?.code || error?.constructor !== Error) throw error;
      issues.push(issue(error.message));
    }
    return { value: issues.length ? null : sectionResult(html), issues };
  }

  try {
    publish('running');
    checkPause();
    signal.throwIfAborted();
    if (!['sections-completed', 'word-converting', 'word-completed'].includes(runtime.phase)) {
      // 新一次修改清空上次单节修改的任务文件和清单；继续修改保留。
      if (!continuing) clearTaskArtifacts(workspaceDir, SECTION_MODIFICATION_SUBDIR);
      // 修改要求已在原会话发出时，继续只发送“继续之前的任务”；新一次修改清除上次的记录。
      const modificationPrompted = continuing
        && wasStagePrompted(agentService.loadPersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY)?.state, 'section-modification');
      agentService.updatePersistentTask(CONTENT_GENERATION_AGENT_TASK_KEY, {
        run_id: task.task_id, status: 'running', phase: 'section-modification', agent_connection: 'running', error: null,
        ...(!continuing ? { prompted_stage: null } : {}),
      });
      await agentService.runTask({
        task_id: task.task_id, title: `修改正文小节：${section.number} ${section.title}`,
        primary_session: true, summary_enabled: false, signal,
        persistent_task: { task_key: CONTENT_GENERATION_AGENT_TASK_KEY, mode: 'resume' },
        initial_stage: 'section-modification', output_file: file,
        prompt: modificationPrompted ? CONTINUE_PROMPT : modificationPrompt(section, file, runtime.regenerate_requirement),
        max_retries: 1, timeout_ms: 30 * 60 * 1000,
        json_validation_schemas: taskFileSchemas(TASK_SUBDIR, IMAGE_TASK_KEYS),
        active_tools: [...NATIVE_AGENT_TOOLS, 'ask-user', 'report-failure', 'list-section-images', 'apply-section-images', 'generate-section-images', 'render-html-image', 'render-mermaid-image'],
        create_tools: context => {
          // 新一次修改登记本节以外的全部小节，被改动的在提交时还原；继续修改沿用已保存的登记。
          if (!continuing) context.baseline?.setGroup(BASELINE_GROUPS.sections, listSectionFiles(workspaceDir).filter(item => item !== file));
          // 配图遇服务端连续失败时直接结束本次修改，不交回 Agent 反复重试。
          return createContentGenerationImageTools({ aiService, signal, htmlImageOptimization, sections: [{ ...section, file }],
            failTask: error => { if (!controller.signal.aborted) controller.abort(error); },
            taskDir: TASK_SUBDIR, listDir: `${LIST_DIR}/${SECTION_MODIFICATION_SUBDIR}` }, context);
        },
        validateOutput: validateSectionOutput,
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
      onStructureRepaired(message) {
        logs.push(message);
      },
      onImagesSkipped(message) {
        logs.push(message);
      },
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
