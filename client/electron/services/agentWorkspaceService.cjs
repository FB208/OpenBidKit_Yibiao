const crypto = require('node:crypto');
const { OUTLINE_AGENT_TASK_KEY } = require('./outlineGenerationAgentV2Config.cjs');
const { GLOBAL_FACTS_AGENT_TASK_KEY } = require('./globalFactsAgentV2Config.cjs');
const { CONTENT_PLANNING_AGENT_TASK_KEY } = require('./contentPlanningAgentConfig.cjs');
const { FEASIBILITY_OUTLINE_AGENT_TASK_KEY } = require('./feasibilityOutlineAgentConfig.cjs');

function now() {
  return new Date().toISOString();
}

function isActiveTaskStatus(status) {
  return status === 'running' || status === 'pausing';
}

function countGeneratedLeaves(items) {
  return (items || []).reduce((total, item) => (
    Array.isArray(item?.children) && item.children.length
      ? total + countGeneratedLeaves(item.children)
      : total + (String(item?.content || '').trim() ? 1 : 0)
  ), 0);
}

const STEP_WORKSPACE_IDS = Object.freeze({
  'outline-generation': OUTLINE_AGENT_TASK_KEY,
  'global-facts': GLOBAL_FACTS_AGENT_TASK_KEY,
  'content-edit': CONTENT_PLANNING_AGENT_TASK_KEY,
});

const TECHNICAL_PLAN_SECTIONS = new Set(['technical-plan', 'existing-plan-expansion']);

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
 * 可调整任务通过 provider 的 sendMessage 接入，正文编排当前只注册只读工作空间。
 */
function createAgentWorkspaceService({ agentService, taskService, technicalPlanStore, feasibilityReportStore }) {
  const chatSubscribers = new Set();
  const primaryChatSubscribers = new Set();
  const workspaceChangeSubscribers = new Set();
  const primaryWorkspaceChangeSubscribers = new Set();
  // 当前可见页；未上报前无生效工作空间。不写库。
  let currentView = { section: '', step: '' };
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
    if (agentService.isPrimarySession({ task_key: workspaceId })) {
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
    'bid-section-extraction': '多标段识别',
    'bid-analysis': '招标文件解析',
    'outline-generation': '目录生成',
    'outline-adjustment': '目录AI调整',
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
      const hasGeneratedContent = countGeneratedLeaves(plan.outlineData.outline) > 0;
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
      const hasGeneratedContent = countGeneratedLeaves(plan.outlineData?.outline) > 0;
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

  const contentPlanningWorkspaceProvider = {
    id: CONTENT_PLANNING_AGENT_TASK_KEY,
    buildDescriptor() {
      const plan = technicalPlanStore.loadTechnicalPlan() || {};
      const activeTasks = taskService.getActiveTasks();
      const busyTask = activeTasks.find((task) => task.group === 'technical-plan' && isActiveTaskStatus(task.status));
      const hasSession = agentService.hasPersistentTaskSession(CONTENT_PLANNING_AGENT_TASK_KEY);
      if (!hasSession) {
        if (busyTask?.type === 'content-generation') {
          return {
            id: this.id,
            title: '正文编排',
            status: 'busy',
            busy_reason: '正文生成任务正在准备或执行正文编排',
            has_generated_content: false,
            empty_hint: '正文编排工作空间将在 Agent 启动后保留。',
          };
        }
        return null;
      }
      const taskReason = busyTask
        ? `${technicalPlanTaskLabels[busyTask.type] || busyTask.type}任务执行中，请等待完成`
        : '正文编排工作空间已保留，暂不支持继续调整';
      return {
        id: this.id,
        title: '正文编排',
        status: 'busy',
        busy_reason: taskReason,
        has_generated_content: countGeneratedLeaves(plan.outlineData?.outline) > 0,
        empty_hint: '正文编排工作空间已保留，暂不支持继续调整。',
      };
    },
    sendMessage() {
      throw new Error('正文编排工作空间暂不支持 AI 调整');
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
      const hasGeneratedContent = countGeneratedLeaves(report.outlineData.outline) > 0;
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

  const providers = [outlineWorkspaceProvider, globalFactsWorkspaceProvider, contentPlanningWorkspaceProvider, feasibilityOutlineWorkspaceProvider];

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
    const taskKey = String(agentService.getPrimarySession()?.task_key || '');
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

  agentService.onPrimarySessionChanged(() => emitPrimaryWorkspacesChanged());

  // 新建持久 Agent 工作空间时同步重置对应的内存聊天记录。
  let lastOutlineGenerationTaskId = null;
  let lastGlobalFactsGenerationTaskId = null;
  let lastContentGenerationTaskId = null;
  let lastFeasibilityOutlineTaskId = null;

  taskService.subscribeCallback((event) => {
    const task = event?.task;
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
    if (task?.type === 'content-generation') {
      if (task.task_id && task.task_id !== lastContentGenerationTaskId) {
        lastContentGenerationTaskId = task.task_id;
        if (!agentService.hasPersistentTaskSession(CONTENT_PLANNING_AGENT_TASK_KEY)) {
          resetChatState(CONTENT_PLANNING_AGENT_TASK_KEY);
        }
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
