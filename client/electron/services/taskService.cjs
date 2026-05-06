const crypto = require('node:crypto');
const { runBidAnalysisTask } = require('./bidAnalysisTask.cjs');
const { runOutlineGenerationTask } = require('./outlineGenerationTask.cjs');

function now() {
  return new Date().toISOString();
}

function createTask(type) {
  return {
    task_id: crypto.randomUUID(),
    type,
    status: 'running',
    progress: 0,
    logs: [],
    started_at: now(),
    updated_at: now(),
  };
}

function createTaskService({ aiService, workspaceStore }) {
  const subscribers = new Set();
  const activeTasks = new Map();

  function emit(task, technicalPlan) {
    const event = { task, technicalPlan };
    for (const webContents of subscribers) {
      if (!webContents.isDestroyed()) {
        webContents.send('tasks:event', event);
      }
    }
  }

  function subscribe(webContents) {
    subscribers.add(webContents);
    const technicalPlan = workspaceStore.loadTechnicalPlan();
    for (const task of activeTasks.values()) {
      if (!webContents.isDestroyed()) {
        webContents.send('tasks:event', { task, technicalPlan });
      }
    }
    webContents.once('destroyed', () => subscribers.delete(webContents));
  }

  function getTaskField(type) {
    return type === 'bid-analysis' ? 'bidAnalysisTask' : 'outlineGenerationTask';
  }

  function startTask(type, payload, runner, initialPartial = {}) {
    const existingTask = activeTasks.get(type);
    if (existingTask?.status === 'running') {
      emit(existingTask, workspaceStore.loadTechnicalPlan());
      return existingTask;
    }

    const task = createTask(type);
    activeTasks.set(type, task);
    const taskField = getTaskField(type);
    let currentTask = task;

    const updateTask = (partial, technicalPlan) => {
      currentTask = {
        ...currentTask,
        ...partial,
        logs: partial.logs ? partial.logs : currentTask.logs,
        updated_at: now(),
      };
      activeTasks.set(type, currentTask);
      if (technicalPlan) emit(currentTask, technicalPlan);
      return currentTask;
    };

    const technicalPlan = workspaceStore.updateTechnicalPlan({ ...initialPartial, [taskField]: currentTask });
    emit(currentTask, technicalPlan);

    runner({ aiService, workspaceStore, updateTask, payload }).catch((error) => {
      const failedTask = updateTask({ status: 'error', error: error.message || '任务执行失败' });
      const nextPlan = workspaceStore.updateTechnicalPlan({ [taskField]: failedTask });
      emit(failedTask, nextPlan);
    }).finally(() => {
      activeTasks.delete(type);
    });

    return currentTask;
  }

  return {
    subscribe,
    startBidAnalysis(payload) {
      return startTask('bid-analysis', payload, runBidAnalysisTask);
    },
    startOutlineGeneration(payload) {
      return startTask('outline-generation', payload, runOutlineGenerationTask, { outlineMode: payload.mode });
    },
    getActiveTasks() {
      return Array.from(activeTasks.values());
    },
  };
}

module.exports = { createTaskService };
