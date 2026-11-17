const { BID_DOCUMENT_ADJUSTMENT_KEY, adjustmentSections, buildAdjustmentContext, buildAdjustmentFiles,
  adjustmentWorkspaceInstructions, buildAdjustmentPrompt, buildSectionRequirement } = require('./bidDocumentAdjustmentContext.cjs');
const { captureAdjustmentState, synchronizeAdjustment } = require('./bidDocumentAdjustmentSync.cjs');
const { captureExportFailure, readExportFailure, buildExportRepairRequirement } = require('./bidDocumentExportFailure.cjs');
const { createContentGenerationImageTools, imageToolNames } = require('./contentGenerationImageTools.cjs');
const { resolveImageKinds } = require('./contentImageKinds.cjs');
const { NATIVE_AGENT_TOOLS } = require('./agent/agentToolEnvironment.cjs');

// 正文首次生成后的人工要求、小节修改补写和导出修复共用独立持久会话；收尾只刷新实际改动。
async function runBidDocumentAdjustmentTask({ app, agentService, aiService, workspaceStore, openXmlHelperService,
  credentialLibraryService, technicalPlanExport, payload, taskControl, updateTask, checkpointTask }) {
  const signal = taskControl.signal;
  let task = checkpointTask({ stats: { adjustment: { origin: payload.origin, requirement: payload.requirement, section_ids: payload.sectionIds,
    failure_id: payload.failureId, export_options: payload.exportOptions, phase: 'preparing' } }, logs: ['正在准备投标文件 AI 调整'] }).task;
  if (workspaceStore.hasBidTemplate()) workspaceStore.ensureBidTemplateBlank();
  const context = await buildAdjustmentContext({ app, workspaceStore, agentService });
  if (!context.plan.outlineData?.outline?.length) throw new Error('当前没有可调整的投标文件');
  const previous = agentService.loadPersistentTask(BID_DOCUMENT_ADJUSTMENT_KEY);
  let before = previous?.state.sync_before || captureAdjustmentState(workspaceStore, agentService);
  let failureId = payload.failureId;
  const changedIds = new Set();
  // 本轮改变了目录结构时，结束后由任务服务自动重新编制规则和页码。
  let rulePageRecompile = false;
  let revision;
  let exported;
  let logs = task.logs;
  // 日志与任务阶段沿用现有 checkpoint / 内存事件分工。
  function phase(value, message) {
    logs = [...logs, message];
    task = checkpointTask({ logs, stats: { ...task.stats, adjustment: { ...task.stats.adjustment, phase: value } } }).task;
  }
  function activity(event) {
    if (event.visible !== false && event.message) updateTask({ logs: [...logs, event.message] });
  }
  // 记录本轮修改前的正式状态，异常退出后下一轮仍能刷新上次已写入的内容。
  function markPending() {
    if (agentService.loadPersistentTask(BID_DOCUMENT_ADJUSTMENT_KEY)) {
      agentService.updatePersistentTask(BID_DOCUMENT_ADJUSTMENT_KEY, { sync_before: before });
    }
  }
  async function refresh(convert) {
    const result = await synchronizeAdjustment({ workspaceStore, agentService, openXmlHelperService, credentialLibraryService,
      before, signal, checkpointTask, onActivity: activity, convert,
      onOutlineStructureChanged() { rulePageRecompile = true; } });
    result.changedNodeIds.forEach(id => changedIds.add(id));
    revision = result.revision || revision;
    before = result.snapshot;
    markPending();
  }
  // 配图方式沿用用户的正文配图设置。
  const imageKinds = resolveImageKinds(context.plan.contentGenerationOptions);
  try {
    // 导出修复不另设诊断：调整会话按失败现场自行定位和修改，结束本轮后由验收实际整本导出。
    const requirement = payload.origin === 'export' ? buildExportRepairRequirement(readExportFailure(app, failureId))
      : payload.sectionIds?.length ? buildSectionRequirement(context, payload.sectionIds, payload.requirement) : payload.requirement;
    if (!String(requirement || '').trim()) throw new Error('请输入调整要求');
    const resume = agentService.hasPersistentTaskSession(BID_DOCUMENT_ADJUSTMENT_KEY);
    if (resume) agentService.updatePersistentTask(BID_DOCUMENT_ADJUSTMENT_KEY, {
      run_id: task.task_id, status: 'running', error: null, origin: payload.origin, failure_id: failureId,
    });
    markPending();
    phase('adjusting', payload.origin === 'export' ? '正在修复导出问题' : '正在调整投标文件');
    const result = await agentService.runTask({
      task_id: task.task_id, title: '投标文件 AI 调整', primary_session: true,
      persistent_task: { task_key: BID_DOCUMENT_ADJUSTMENT_KEY, mode: resume ? 'resume' : 'new' },
      initial_stage: 'document-adjustment', prompt: buildAdjustmentPrompt(context, requirement),
      workspace_instructions: `${adjustmentWorkspaceInstructions(context)}${failureId ? `\n可只读查阅导出失败现场：${readExportFailure(app, failureId).dir}` : ''}`,
      // 目录与材料说明按最新数据写入工作区，提示词只保留本次要求和结束方式；结果说明取结束总结。
      files: buildAdjustmentFiles(context),
      signal, max_retries: 0, timeout_ms: 60 * 60 * 1000,
      active_tools: [...NATIVE_AGENT_TOOLS, 'ask-user', 'report-failure', 'json-validation',
        ...(context.bodyDir ? imageToolNames(imageKinds) : [])],
      create_tools: toolContext => context.bodyDir ? createContentGenerationImageTools({
        aiService, signal, imageKinds, onActivity: activity, resourceWorkspaceDir: context.bodyDir,
        htmlImageOptimization: context.plan.contentGenerationOptions?.htmlImageOptimization === true,
        getSections: () => adjustmentSections(workspaceStore.loadTechnicalPlan().outlineData?.outline).filter(item => item.content_mode === 'ai-generate'),
      }, toolContext) : [],
      onSessionStarted() { markPending(); },
      onActivity: activity,
      async validateOutput() {
        phase('refreshing', '正在刷新正式内容和预览');
        try {
          await refresh(payload.origin !== 'export');
          if (payload.origin === 'export') {
            phase('verifying', '正在按原导出配置转换整本 Word');
            const snapshot = technicalPlanExport.prepare({ exportFormat: payload.exportOptions.exportFormat });
            snapshot.export_template_scope = payload.exportOptions.exportTemplateScope;
            const issues = technicalPlanExport.inspect(snapshot);
            if (issues.length) {
              const error = new Error(issues.flatMap(issue => issue.problems.map(problem => `${issue.section}：${problem}`)).join('\n'));
              failureId = captureExportFailure(app, snapshot, error, { phase: 'inspect', issues });
              throw error;
            }
            exported = await technicalPlanExport.build(snapshot, { signal, stats: {}, onProgress: event => activity({ message: event.message }) });
            signal.throwIfAborted();
          }
          return { value: { changed_node_ids: [...changedIds] }, issues: [] };
        } catch (error) {
          signal.throwIfAborted();
          if (payload.origin === 'export') {
            failureId = error.export_failure_id || captureExportFailure(app,
              technicalPlanExport.prepare({ exportFormat: payload.exportOptions.exportFormat }), error, { phase: 'refresh' });
          }
          return { value: null, issues: [{ severity: 'blocking', message: error.message }],
            minimumGoal: '保持正式数据格式和关联可用；导出修复必须实际完成整本 Word 转换，保留无关内容。' };
        }
      },
      // 验收未通过的报错原文由 Runtime 写入退回提示；导出修复只补充新的失败现场，不重新诊断。
      async buildRetryPrompt(request) {
        markPending();
        if (payload.origin === 'export' && request.kind === 'submission' && failureId) {
          return `新的失败现场（只读）：${readExportFailure(app, failureId).dir}。按上面的报错继续修改；改完直接结束本轮，程序会再次整本导出验收。`;
        }
        return '根据最新错误继续修改正式数据，保留已完成内容。';
      },
    });
    phase('refreshing', '正在保存调整结果');
    const summary = String(result.assistant_text || result.output_content || '投标文件已按要求调整。').trim();
    const adjustment = { ...task.stats.adjustment, phase: 'completed', summary,
      failure_id: failureId, changed_node_ids: [...changedIds], content_revision: revision, rule_page_recompile: rulePageRecompile,
      ...(exported ? { export_verified: true, warnings: exported.warnings } : {}) };
    agentService.updatePersistentTask(BID_DOCUMENT_ADJUSTMENT_KEY, { sync_before: null, status: 'success', phase: 'completed', error: null });
    checkpointTask({ status: 'success', progress: 100, logs: [...logs, '投标文件 AI 调整完成'],
      stats: { ...task.stats, adjustment } });
  } catch (error) {
    if (signal.aborted) throw error;
    // 失败也刷新实际已写入的数据；刷新错误随原错误展示，不虚报成功。
    try { await refresh(false); } catch (refreshError) {
      error = new Error(`${error.message}\n内容刷新未完成：${refreshError.message}`, { cause: error });
    }
    if (agentService.loadPersistentTask(BID_DOCUMENT_ADJUSTMENT_KEY)) {
      agentService.updatePersistentTask(BID_DOCUMENT_ADJUSTMENT_KEY, { status: 'error', error: error.message, failure_id: failureId });
    }
    checkpointTask({ status: 'error', error: error.message, logs: [...logs, error.message],
      stats: { ...task.stats, adjustment: { ...task.stats.adjustment, failure_id: failureId, rule_page_recompile: rulePageRecompile } } });
  }
}

module.exports = { runBidDocumentAdjustmentTask };
