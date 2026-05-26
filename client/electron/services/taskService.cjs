const crypto = require('node:crypto');
const { runBidAnalysisTask } = require('./bidAnalysisTask.cjs');
const { runContentGenerationTask } = require('./contentGenerationTask.cjs');
const { runOutlineGenerationTask } = require('./outlineGenerationTask.cjs');
const { runRejectionCheckTask, runRejectionItemsExtractionTask } = require('./rejectionCheckTask.cjs');

const taskFields = {
  'bid-analysis': 'bidAnalysisTask',
  'outline-generation': 'outlineGenerationTask',
  'content-generation': 'contentGenerationTask',
};

const rejectionTaskFields = {
  'rejection-items-extraction': 'extractionTask',
  'rejection-check-run': 'checkTask',
};

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

function createTaskService({ aiService, workspaceStore, knowledgeBaseService }) {
  const subscribers = new Set();
  const activeTasks = new Map();

  function emit(task, snapshot) {
    const event = { task, ...snapshot };
    for (const webContents of subscribers) {
      if (!webContents.isDestroyed()) {
        webContents.send('tasks:event', event);
      }
    }
  }

  function getSnapshotForTask(task) {
    if (taskFields[task.type]) {
      return { technicalPlan: workspaceStore.loadTechnicalPlan() };
    }
    if (rejectionTaskFields[task.type]) {
      return { rejectionCheck: workspaceStore.loadRejectionCheck() };
    }
    return {};
  }

  function subscribe(webContents) {
    subscribers.add(webContents);
    for (const task of activeTasks.values()) {
      if (!webContents.isDestroyed()) {
        webContents.send('tasks:event', { task, ...getSnapshotForTask(task) });
      }
    }
    webContents.once('destroyed', () => subscribers.delete(webContents));
  }

  function getTaskField(type) {
    return taskFields[type];
  }

  function startTask(type, payload, runner, initialPartial = {}) {
    const existingTask = activeTasks.get(type);
    if (existingTask?.status === 'running') {
      emit(existingTask, { technicalPlan: workspaceStore.loadTechnicalPlan() });
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
      if (technicalPlan) emit(currentTask, { technicalPlan });
      return currentTask;
    };

    const technicalPlan = workspaceStore.updateTechnicalPlan({ ...initialPartial, [taskField]: currentTask });
    emit(currentTask, { technicalPlan });

    runner({ aiService, workspaceStore, knowledgeBaseService, updateTask, payload }).catch((error) => {
      const failedTask = updateTask({ status: 'error', error: error.message || '任务执行失败' });
      const nextPlan = workspaceStore.updateTechnicalPlan({ [taskField]: failedTask });
      emit(failedTask, { technicalPlan: nextPlan });
    }).finally(() => {
      activeTasks.delete(type);
    });

    return currentTask;
  }

  function startRejectionTask(type, payload, runner, initialPartial = {}) {
    const existingTask = activeTasks.get(type);
    if (existingTask?.status === 'running') {
      emit(existingTask, { rejectionCheck: workspaceStore.loadRejectionCheck() });
      return existingTask;
    }

    const task = createTask(type);
    activeTasks.set(type, task);
    const taskField = rejectionTaskFields[type];
    let currentTask = task;

    const updateTask = (partial, rejectionCheck) => {
      currentTask = {
        ...currentTask,
        ...partial,
        logs: partial.logs ? partial.logs : currentTask.logs,
        updated_at: now(),
      };
      activeTasks.set(type, currentTask);
      if (rejectionCheck) emit(currentTask, { rejectionCheck });
      return currentTask;
    };

    const rejectionCheck = workspaceStore.updateRejectionCheck({ ...initialPartial, [taskField]: currentTask });
    emit(currentTask, { rejectionCheck });

    runner({ aiService, workspaceStore, knowledgeBaseService, updateTask, payload }).catch((error) => {
      const failedTask = updateTask({ status: 'error', error: error.message || '任务执行失败' });
      const nextState = workspaceStore.updateRejectionCheck({ [taskField]: failedTask });
      emit(failedTask, { rejectionCheck: nextState });
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
      return startTask('outline-generation', payload, runOutlineGenerationTask, {
        outlineMode: payload?.mode,
        referenceKnowledgeDocumentIds: Array.isArray(payload?.reference_knowledge_document_ids) ? payload.reference_knowledge_document_ids : [],
      });
    },
    startContentGeneration(payload) {
      return startTask('content-generation', payload, runContentGenerationTask);
    },
    startRejectionItemsExtraction(payload) {
      return startRejectionTask('rejection-items-extraction', payload, runRejectionItemsExtractionTask, payload?.workspaceState || {});
    },
    startRejectionCheck(payload) {
      return startRejectionTask('rejection-check-run', payload, runRejectionCheckTask, payload?.workspaceState || {});
    },
    getActiveTasks() {
      return Array.from(activeTasks.values());
    },
  };
}

module.exports = { createTaskService };
