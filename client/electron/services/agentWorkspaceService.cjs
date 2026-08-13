const crypto = require('node:crypto');
const { OUTLINE_AGENT_TASK_KEY } = require('./outlineGenerationAgentV2Config.cjs');

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

/**
 * 通用 Agent 工作空间服务：向插件暴露可对话的 Agent 工作空间。
 * 当前仅内置目录生成工作空间；后续其他持久 Agent 任务可按同样的
 * provider 形态（descriptor + sendMessage）注册接入。
 */
function createAgentWorkspaceService({ agentService, taskService, technicalPlanStore }) {
  const chatSubscribers = new Set();
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
    'content-generation': '正文生成',
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
      return {
        id: this.id,
        title: '目录生成',
        status: busyReason ? 'busy' : 'ready',
        busy_reason: busyReason,
        has_generated_content: countGeneratedLeaves(plan.outlineData.outline) > 0,
      };
    },
    sendMessage(message) {
      return taskService.startOutlineAdjustment({ requirement: message });
    },
  };

  const providers = [outlineWorkspaceProvider];

  function buildWorkspaceEntry(provider) {
    const descriptor = provider.buildDescriptor();
    if (!descriptor) return null;
    const state = getChatState(provider.id);
    return {
      ...descriptor,
      pending: state.pending,
      messages: state.messages.map((message) => ({ ...message })),
    };
  }

  function listAgentWorkspaces() {
    return providers
      .map((provider) => buildWorkspaceEntry(provider))
      .filter(Boolean);
  }

  function sendAgentWorkspaceMessage(payload = {}) {
    const workspaceId = String(payload.workspaceId || payload.workspace_id || '');
    const message = String(payload.message || '').trim();
    const provider = providers.find((item) => item.id === workspaceId);
    if (!provider) {
      throw new Error('当前没有可执行任务');
    }
    if (!message) {
      throw new Error('请输入调整要求');
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

  function onAgentWorkspaceChatEvent(callback) {
    chatSubscribers.add(callback);
    return () => chatSubscribers.delete(callback);
  }

  // 目录调整任务结束后把最终回复写回对话记录。
  taskService.subscribeCallback((event) => {
    const task = event?.task;
    if (task?.type !== 'outline-adjustment') return;
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
  });

  return {
    listAgentWorkspaces,
    sendAgentWorkspaceMessage,
    onAgentWorkspaceChatEvent,
  };
}

module.exports = { createAgentWorkspaceService };
