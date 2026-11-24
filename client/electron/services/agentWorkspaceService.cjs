const crypto = require('node:crypto');
const { OUTLINE_AGENT_TASK_KEY } = require('./outlineGenerationAgentV2Config.cjs');
const { GLOBAL_FACTS_AGENT_TASK_KEY } = require('./globalFactsAgentV2Config.cjs');
const { CONTENT_GENERATION_AGENT_TASK_KEY } = require('./contentGenerationAgent.cjs');
const { BID_DOCUMENT_ADJUSTMENT_KEY } = require('./bidDocumentAdjustmentContext.cjs');
const { BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY, RULE_PAGE_AGENT_TASK_KEY } = require('./businessTemplateFillAgentConfig.cjs');
const { FEASIBILITY_OUTLINE_AGENT_TASK_KEY } = require('./feasibilityOutlineAgentConfig.cjs');

function now() {
  return new Date().toISOString();
}

function isActiveTaskStatus(status) {
  return status === 'running' || status === 'pausing';
}

// 技术方案 AI 正文使用生成记录判断；底稿和可研仍读取 content。
function hasGeneratedBody(items, plan = {}) {
  return Boolean(plan.contentGenerationTask?.stats?.content?.generation_completed) || (items || []).some(item => (
    item?.children?.length
      ? hasGeneratedBody(item.children, plan)
      : Boolean(String(item?.content || '').trim()) || (item?.content_mode === 'ai-generate' && (
        plan.contentGenerationSections?.[item.id]?.status === 'success'
        || Object.hasOwn(plan.contentGenerationRuntime?.section_words || {}, item.id)
        || plan.contentGenerationRuntime?.html_output?.word_sections.some(section => section.section_id === item.id)
      ))
  ));
}

const STEP_WORKSPACE_IDS = Object.freeze({
  'outline-generation': OUTLINE_AGENT_TASK_KEY,
  'global-facts': GLOBAL_FACTS_AGENT_TASK_KEY,
  'content-edit': BID_DOCUMENT_ADJUSTMENT_KEY,
});

// 正文阶段的程序会话成为主会话时，桌宠统一显示投标文件调整工作区。
const DOCUMENT_STAGE_TASK_KEYS = new Set([CONTENT_GENERATION_AGENT_TASK_KEY, BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY, RULE_PAGE_AGENT_TASK_KEY]);

const TECHNICAL_PLAN_SECTIONS = new Set(['technical-plan']);

function normalizeCurrentView(view = {}) {
  const section = String(view.section || '').trim();
  const rawStep = view.step;
  const step = rawStep == null || rawStep === '' ? '' : String(rawStep).trim();
  return { section, step };
}

function getMappedWorkspaceId(view) {
  if (view?.section === 'feasibility-report' && view.step === 'outline') {
    return FEASIBILITY_OUTLINE_AGENT_TASK_KEY;
  }
  if (!TECHNICAL_PLAN_SECTIONS.has(view?.section)) return null;
  return STEP_WORKSPACE_IDS[view.step] || null;
}

/**
 * 通用 Agent 工作空间服务：向插件暴露持久 Agent 工作空间。
 * 可调整任务通过 provider 的 sendMessage 接入；正文阶段统一由投标文件调整工作区承接。
 */
function createAgentWorkspaceService({ agentService, taskService, technicalPlanStore, feasibilityReportStore }) {
  const chatSubscribers = new Set();
  const primaryChatSubscribers = new Set();
  const workspaceChangeSubscribers = new Set();
  const primaryWorkspaceChangeSubscribers = new Set();
  // 当前可见页；未上报前无生效工作空间。不写库。
  let currentView = { section: '', step: '' };
  // 用户显式选中的待启动聊天目标；真正建立 Session 后由主会话登记接管。
  let pendingPrimaryWorkspaceId = null;
  // workspaceId -> { messages, pending, pending_task_id }
  const chatStates = new Map();

  function getChatState(workspaceId) {
    if (!chatStates.has(workspaceId)) {
      chatStates.set(workspaceId, { messages: [], pending: false, pending_task_id: null });
    }
    return chatStates.get(workspaceId);
  }

  function emitChatEvent(workspaceId) {
    const state = getChatState(workspaceId);
    const event = {
      workspace_id: workspaceId,
      messages: state.messages.map((message) => ({ ...message })),
      pending: state.pending,
    };
    for (const callback of chatSubscribers) {
      try {
        callback(event);
      } catch (error) {
        console.error('[agent-workspace] chat 事件回调失败:', error);
      }
    }
    if (getPrimaryWorkspaceId() === workspaceId) {
      for (const callback of primaryChatSubscribers) {
        try {
          callback(event);
        } catch (error) {
          console.error('[agent-workspace] 主 Session chat 事件回调失败:', error);
        }
      }
    }
  }

  function resetChatState(workspaceId) {
    const state = getChatState(workspaceId);
    if (!state.messages.length && !state.pending) return;
    state.messages = [];
    state.pending = false;
    state.pending_task_id = null;
    emitChatEvent(workspaceId);
  }

  function appendMessage(workspaceId, role, text) {
    const state = getChatState(workspaceId);
    state.messages.push({
      id: crypto.randomUUID(),
      role,
      text: String(text || ''),
      at: now(),
    });
  }

  const technicalPlanTaskLabels = {
    'bid-document-adjustment': '投标文件AI调整',
    'bid-section-extraction': '标段识别',
    'bid-analysis': '招标文件解析',
    'outline-generation': '目录生成',
    'outline-adjustment': '目录AI调整',
    'bid-template-extraction': '投标模版提取',
    'rule-page-compile': '规则和页码编制',
    'global-facts-generation': '全局事实设定',
    'global-facts-adjustment': '全局事实AI调整',
    'content-generation': '正文生成',
  };
  const feasibilityReportTaskLabels = {
    'feasibility-analysis': '资料分析',
    'feasibility-outline': '目录生成',
    'feasibility-outline-adjustment': '目录AI调整',
    'feasibility-parameters': '关键参数生成',
    'feasibility-content': '正文生成',
    'feasibility-human-writing': '自然化审校',
  };

  // 目录生成工作空间 provider。
  const outlineWorkspaceProvider = {
    id: OUTLINE_AGENT_TASK_KEY,
    buildDescriptor() {
      const plan = technicalPlanStore.loadTechnicalPlan() || {};
      const activeTasks = taskService.getActiveTasks();
      const busyTask = activeTasks.find((task) => task.group === 'technical-plan' && isActiveTaskStatus(task.status));
      const hasOutline = Boolean(plan.outlineData?.outline?.length);
      const hasSession = agentService.hasPersistentTaskSession(OUTLINE_AGENT_TASK_KEY);

      if (!hasOutline || !hasSession) {
        // 目录生成运行中也视为"正处于该 Agent 工作空间"，只是暂不可发送。
        if (busyTask?.type === 'outline-generation') {
          return {
            id: this.id,
            title: '目录生成',
            status: 'busy',
            busy_reason: '目录生成任务执行中，完成后即可发送调整要求',
            has_generated_content: false,
            empty_hint: '向 Agent 描述你的目录调整要求，例如“把安全管理章节拆成两章”。',
          };
        }
        return null;
      }

      const contentPaused = plan.contentGenerationTask?.status === 'paused';
      const busyReason = busyTask
        ? `${technicalPlanTaskLabels[busyTask.type] || busyTask.type}任务执行中，请等待完成`
        : contentPaused
          ? '正文生成已暂停，请先在主界面继续或重置正文任务'
          : '';
      const hasGeneratedContent = hasGeneratedBody(plan.outlineData.outline, plan);
      return {
        id: this.id,
        title: '目录生成',
        status: busyReason ? 'busy' : 'ready',
        busy_reason: busyReason,
        has_generated_content: hasGeneratedContent,
        empty_hint: '向 Agent 描述你的目录调整要求，例如“把安全管理章节拆成两章”。',
        ...(hasGeneratedContent
          ? { send_warning: '调整目录将清空已生成的正文内容，是否继续？' }
          : {}),
      };
    },
    sendMessage(message) {
      return taskService.startOutlineAdjustment({ requirement: message });
    },
  };

  const globalFactsWorkspaceProvider = {
    id: GLOBAL_FACTS_AGENT_TASK_KEY,
    buildDescriptor() {
      const plan = technicalPlanStore.loadTechnicalPlan() || {};
      const activeTasks = taskService.getActiveTasks();
      const busyTask = activeTasks.find((task) => task.group === 'technical-plan' && isActiveTaskStatus(task.status));
      const hasFacts = Array.isArray(plan.globalFacts) && plan.globalFacts.length > 0;
      const hasSession = agentService.hasPersistentTaskSession(GLOBAL_FACTS_AGENT_TASK_KEY);

      if (!hasFacts || !hasSession) {
        if (busyTask?.type === 'global-facts-generation') {
          return {
            id: this.id,
            title: '全局事实设定',
            status: 'busy',
            busy_reason: '全局事实设定任务执行中，完成后即可发送调整要求',
            has_generated_content: false,
            empty_hint: '向 Agent 描述你的全局事实调整要求。',
          };
        }
        return null;
      }

      const contentPaused = plan.contentGenerationTask?.status === 'paused';
      const busyReason = busyTask
        ? `${technicalPlanTaskLabels[busyTask.type] || busyTask.type}任务执行中，请等待完成`
        : contentPaused
          ? '正文生成已暂停，请先在主界面继续或重置正文任务'
          : '';
      const hasGeneratedContent = hasGeneratedBody(plan.outlineData?.outline, plan);
      return {
        id: this.id,
        title: '全局事实设定',
        status: busyReason ? 'busy' : 'ready',
        busy_reason: busyReason,
        has_generated_content: hasGeneratedContent,
        empty_hint: '向 Agent 描述你的全局事实调整要求。',
        ...(hasGeneratedContent
          ? { send_warning: '调整全局事实将清空已生成的正文内容，是否继续？' }
          : {}),
      };
    },
    sendMessage(message) {
      return taskService.startGlobalFactsAdjustment({ requirement: message });
    },
  };

  const feasibilityOutlineWorkspaceProvider = {
    id: FEASIBILITY_OUTLINE_AGENT_TASK_KEY,
    buildDescriptor() {
      const report = feasibilityReportStore?.loadFeasibilityReport?.() || {};
      const activeTasks = taskService.getActiveTasks();
      const busyTask = activeTasks.find((task) => task.group === 'feasibility-report' && isActiveTaskStatus(task.status));
      const hasOutline = Boolean(report.outlineData?.outline?.length);
      const hasSession = agentService.hasPersistentTaskSession(FEASIBILITY_OUTLINE_AGENT_TASK_KEY);

      if (!hasOutline || !hasSession) {
        if (busyTask?.type === 'feasibility-outline') {
          return {
            id: this.id,
            title: '可研报告目录',
            status: 'busy',
            busy_reason: '报告目录生成任务执行中，完成后即可发送调整要求',
            has_generated_content: false,
            empty_hint: '向 Agent 描述你的目录调整要求，例如“把风险分析拆成两章”。',
          };
        }
        return null;
      }

      const contentPaused = report.contentTask?.status === 'paused';
      const busyReason = busyTask
        ? `${feasibilityReportTaskLabels[busyTask.type] || busyTask.type}任务执行中，请等待完成`
        : contentPaused
          ? '正文生成已暂停，请先在主界面继续或重置正文任务'
          : '';
      const hasGeneratedContent = hasGeneratedBody(report.outlineData.outline);
      return {
        id: this.id,
        title: '可研报告目录',
        status: busyReason ? 'busy' : 'ready',
        busy_reason: busyReason,
        has_generated_content: hasGeneratedContent,
        empty_hint: '向 Agent 描述你的目录调整要求，例如“把风险分析拆成两章”。',
        ...(hasGeneratedContent
          ? { send_warning: '调整目录将清空已生成的关键参数和正文内容，是否继续？' }
          : {}),
      };
    },
    sendMessage(message) {
      return taskService.startFeasibilityOutlineAdjustment({ requirement: message });
    },
  };

  // 正文页唯一的对话工作区：正文、商务填写和规则编制会话成为主会话时也显示在这里，任务结束后直接接受调整要求。
  const documentAdjustmentProvider = {
    id: BID_DOCUMENT_ADJUSTMENT_KEY,
    buildDescriptor() {
      const plan = technicalPlanStore.loadTechnicalPlan();
      if (!plan.outlineData?.outline?.length) return null;
      // 未启用时不能从桌宠直接发消息，须先在正文页确认启用。
      const reason = plan.documentAdjustmentEnabled
        ? taskService.getDocumentAdjustmentBlocker()
        : taskService.getDocumentAdjustmentEnableBlocker() || '请先在正文页点击“AI调整”并确认启用';
      return { id: this.id, title: '投标文件AI调整', status: reason ? 'busy' : 'ready', busy_reason: reason,
        has_generated_content: hasGeneratedBody(plan.outlineData.outline, plan) || plan.bidTemplateExists,
        empty_hint: '请输入投标文件调整要求。' };
    },
    sendMessage(requirement) {
      return taskService.startBidDocumentAdjustment({ origin: 'user', requirement });
    },
  };
  const providers = [outlineWorkspaceProvider, globalFactsWorkspaceProvider, documentAdjustmentProvider, feasibilityOutlineWorkspaceProvider];

  // 首次打开只选择会话目标，不发模型请求、不伪造主 Session。
  function activateWorkspace(workspaceId) {
    const descriptor = providers.find(provider => provider.id === workspaceId)?.buildDescriptor();
    if (!descriptor) throw new Error('当前没有可调整的投标文件');
    if (descriptor.status !== 'ready') throw new Error(descriptor.busy_reason);
    pendingPrimaryWorkspaceId = workspaceId;
    emitWorkspacesChanged();
    return { success: true };
  }

  function buildWorkspaceEntry(provider) {
    const descriptor = provider.buildDescriptor();
    if (!descriptor) return null;
    const mappedId = getMappedWorkspaceId(currentView);
    const state = getChatState(provider.id);
    return {
      ...descriptor,
      active: descriptor.id === mappedId,
      pending: state.pending,
      messages: state.messages.map((message) => ({ ...message })),
    };
  }

  function setCurrentView(view = {}) {
    currentView = normalizeCurrentView(view);
    emitWorkspacesChanged();
  }

  function listAgentWorkspaces() {
    return providers
      .map((provider) => buildWorkspaceEntry(provider))
      .filter(Boolean);
  }

  function getPrimaryWorkspaceId() {
    if (pendingPrimaryWorkspaceId) {
      if (providers.find(provider => provider.id === pendingPrimaryWorkspaceId)?.buildDescriptor()) return pendingPrimaryWorkspaceId;
      pendingPrimaryWorkspaceId = null;
    }
    const primaryKey = String(agentService.getPrimarySession()?.task_key || '');
    const taskKey = DOCUMENT_STAGE_TASK_KEYS.has(primaryKey) ? BID_DOCUMENT_ADJUSTMENT_KEY : primaryKey;
    return providers.some((provider) => provider.id === taskKey) ? taskKey : null;
  }

  function listPrimaryAgentWorkspaces() {
    const workspaceId = getPrimaryWorkspaceId();
    if (!workspaceId) return [];
    const provider = providers.find((item) => item.id === workspaceId);
    const descriptor = provider?.buildDescriptor();
    if (!descriptor) return [];
    const state = getChatState(workspaceId);
    return [{
      ...descriptor,
      active: true,
      pending: state.pending,
      messages: state.messages.map((message) => ({ ...message })),
    }];
  }

  function getActiveWorkspaceId() {
    return listAgentWorkspaces().find((item) => item.active)?.id || null;
  }

  function emitWorkspacesChanged() {
    if (!technicalPlanStore.loadTechnicalPlan().bidDocumentAdjustmentTask && !agentService.hasPersistentTaskSession(BID_DOCUMENT_ADJUSTMENT_KEY)) {
      const state = getChatState(BID_DOCUMENT_ADJUSTMENT_KEY);
      if (state.messages.length) resetChatState(BID_DOCUMENT_ADJUSTMENT_KEY);
    }
    const workspaces = listAgentWorkspaces();
    const event = {
      active_workspace_id: workspaces.find((item) => item.active)?.id || null,
      workspaces,
    };
    for (const callback of workspaceChangeSubscribers) {
      try {
        callback(event);
      } catch (error) {
        console.error('[agent-workspace] 工作空间变更回调失败:', error);
      }
    }
    emitPrimaryWorkspacesChanged();
  }

  function emitPrimaryWorkspacesChanged() {
    const workspaces = listPrimaryAgentWorkspaces();
    const event = {
      active_workspace_id: workspaces[0]?.id || null,
      workspaces,
    };
    for (const callback of primaryWorkspaceChangeSubscribers) {
      try {
        callback(event);
      } catch (error) {
        console.error('[agent-workspace] 主 Session 工作空间变更回调失败:', error);
      }
    }
  }

  function sendAgentWorkspaceMessage(payload = {}, options = {}) {
    const workspaceId = String(payload.workspaceId || payload.workspace_id || '');
    const message = String(payload.message || '').trim();
    const provider = providers.find((item) => item.id === workspaceId);
    if (!provider) {
      throw new Error('当前没有可执行任务');
    }
    if (!message) {
      throw new Error('请输入调整要求');
    }
    const activeWorkspaceId = options.primaryOnly ? getPrimaryWorkspaceId() : getActiveWorkspaceId();
    if (!activeWorkspaceId || workspaceId !== activeWorkspaceId) {
      throw new Error(options.primaryOnly ? '当前没有可对话的主 Session' : '当前步骤没有可对话的工作空间');
    }
    const descriptor = provider.buildDescriptor();
    if (!descriptor) {
      throw new Error('当前没有可执行任务');
    }
    if (descriptor.status !== 'ready') {
      throw new Error(descriptor.busy_reason || 'Agent 忙碌中，请稍后再试');
    }
    const state = getChatState(workspaceId);
    if (state.pending) {
      throw new Error('上一条要求正在处理中，请等待 Agent 回复');
    }

    appendMessage(workspaceId, 'user', message);
    state.pending = true;
    try {
      const task = provider.sendMessage(message);
      state.pending_task_id = task?.task_id || null;
      emitChatEvent(workspaceId);
    } catch (error) {
      state.pending = false;
      state.pending_task_id = null;
      appendMessage(workspaceId, 'error', error?.message || String(error));
      emitChatEvent(workspaceId);
      return { success: false, error: error?.message || String(error) };
    }
    return { success: true };
  }

  function sendPrimaryAgentWorkspaceMessage(payload = {}) {
    return sendAgentWorkspaceMessage(payload, { primaryOnly: true });
  }

  function onAgentWorkspaceChatEvent(callback) {
    chatSubscribers.add(callback);
    return () => chatSubscribers.delete(callback);
  }

  function onPrimaryAgentWorkspaceChatEvent(callback) {
    primaryChatSubscribers.add(callback);
    return () => primaryChatSubscribers.delete(callback);
  }

  function onAgentWorkspacesChanged(callback) {
    workspaceChangeSubscribers.add(callback);
    return () => workspaceChangeSubscribers.delete(callback);
  }

  function onPrimaryAgentWorkspacesChanged(callback) {
    primaryWorkspaceChangeSubscribers.add(callback);
    return () => primaryWorkspaceChangeSubscribers.delete(callback);
  }

  agentService.onPrimarySessionChanged(() => {
    pendingPrimaryWorkspaceId = null;
    emitPrimaryWorkspacesChanged();
  });

  // 新建持久 Agent 工作空间时同步重置对应的内存聊天记录。
  let lastOutlineGenerationTaskId = null;
  let lastGlobalFactsGenerationTaskId = null;
  let lastFeasibilityOutlineTaskId = null;

  taskService.subscribeCallback((event) => {
    const task = event?.task;
    if (task?.type === 'bid-document-adjustment') {
      const state = getChatState(BID_DOCUMENT_ADJUSTMENT_KEY);
      if (isActiveTaskStatus(task.status)) {
        if (!state.pending) {
          pendingPrimaryWorkspaceId = BID_DOCUMENT_ADJUSTMENT_KEY;
          appendMessage(BID_DOCUMENT_ADJUSTMENT_KEY, 'agent', '正在处理投标文件调整任务。');
        }
        state.pending = true;
        state.pending_task_id = task.task_id;
        emitChatEvent(BID_DOCUMENT_ADJUSTMENT_KEY);
        emitPrimaryWorkspacesChanged();
      } else if (task.task_id === state.pending_task_id) {
        state.pending = false;
        state.pending_task_id = null;
        const adjustment = task.stats?.adjustment;
        appendMessage(BID_DOCUMENT_ADJUSTMENT_KEY, task.status === 'success' ? 'agent' : 'error',
          task.status === 'success'
            ? `${adjustment?.summary || '投标文件已调整。'}${adjustment?.export_verified ? '\n整本转换已通过，可以重新导出。' : ''}`
            : task.error || '投标文件调整未完成');
        emitChatEvent(BID_DOCUMENT_ADJUSTMENT_KEY);
        emitPrimaryWorkspacesChanged();
      }
      return;
    }
    if (task?.type === 'outline-generation') {
      if (task.task_id && task.task_id !== lastOutlineGenerationTaskId) {
        lastOutlineGenerationTaskId = task.task_id;
        resetChatState(OUTLINE_AGENT_TASK_KEY);
      }
      return;
    }
    if (task?.type === 'global-facts-generation') {
      if (task.task_id && task.task_id !== lastGlobalFactsGenerationTaskId) {
        lastGlobalFactsGenerationTaskId = task.task_id;
        resetChatState(GLOBAL_FACTS_AGENT_TASK_KEY);
      }
      return;
    }
    if (task?.type === 'feasibility-outline') {
      if (task.task_id && task.task_id !== lastFeasibilityOutlineTaskId) {
        lastFeasibilityOutlineTaskId = task.task_id;
        resetChatState(FEASIBILITY_OUTLINE_AGENT_TASK_KEY);
      }
      return;
    }
    if (task?.type === 'outline-adjustment') {
      const state = getChatState(OUTLINE_AGENT_TASK_KEY);
      if (!state.pending || task.task_id !== state.pending_task_id) return;
      if (task.status === 'success') {
        state.pending = false;
        state.pending_task_id = null;
        appendMessage(OUTLINE_AGENT_TASK_KEY, 'agent', task.stats?.adjustment?.summary || '目录已按要求调整完成。');
        emitChatEvent(OUTLINE_AGENT_TASK_KEY);
      } else if (task.status === 'error') {
        state.pending = false;
        state.pending_task_id = null;
        appendMessage(OUTLINE_AGENT_TASK_KEY, 'error', task.error || '目录 AI 调整失败');
        emitChatEvent(OUTLINE_AGENT_TASK_KEY);
      }
      return;
    }
    if (task?.type === 'feasibility-outline-adjustment') {
      const state = getChatState(FEASIBILITY_OUTLINE_AGENT_TASK_KEY);
      if (!state.pending || task.task_id !== state.pending_task_id) return;
      if (task.status === 'success') {
        state.pending = false;
        state.pending_task_id = null;
        appendMessage(FEASIBILITY_OUTLINE_AGENT_TASK_KEY, 'agent', task.stats?.adjustment?.summary || '报告目录已按要求调整完成。');
        emitChatEvent(FEASIBILITY_OUTLINE_AGENT_TASK_KEY);
      } else if (task.status === 'error') {
        state.pending = false;
        state.pending_task_id = null;
        appendMessage(FEASIBILITY_OUTLINE_AGENT_TASK_KEY, 'error', task.error || '报告目录 AI 调整失败');
        emitChatEvent(FEASIBILITY_OUTLINE_AGENT_TASK_KEY);
      }
      return;
    }
    if (task?.type !== 'global-facts-adjustment') return;
    const state = getChatState(GLOBAL_FACTS_AGENT_TASK_KEY);
    if (!state.pending || task.task_id !== state.pending_task_id) return;
    if (task.status === 'success') {
      state.pending = false;
      state.pending_task_id = null;
      appendMessage(GLOBAL_FACTS_AGENT_TASK_KEY, 'agent', task.stats?.adjustment?.summary || '全局事实已按要求调整完成。');
      emitChatEvent(GLOBAL_FACTS_AGENT_TASK_KEY);
    } else if (task.status === 'error') {
      state.pending = false;
      state.pending_task_id = null;
      appendMessage(GLOBAL_FACTS_AGENT_TASK_KEY, 'error', task.error || '全局事实 AI 调整失败');
      emitChatEvent(GLOBAL_FACTS_AGENT_TASK_KEY);
    }
  });

  return {
    activateWorkspace,
    listAgentWorkspaces,
    listPrimaryAgentWorkspaces,
    sendAgentWorkspaceMessage,
    sendPrimaryAgentWorkspaceMessage,
    onAgentWorkspaceChatEvent,
    onPrimaryAgentWorkspaceChatEvent,
    onAgentWorkspacesChanged,
    onPrimaryAgentWorkspacesChanged,
    emitWorkspacesChanged,
    emitPrimaryWorkspacesChanged,
    setCurrentView,
  };
}

module.exports = { createAgentWorkspaceService };
