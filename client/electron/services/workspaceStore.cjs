const fs = require('node:fs');
const path = require('node:path');
const { getDuplicateCheckFilePath, getTechnicalPlanFilePath } = require('../utils/paths.cjs');
const { deleteImportedImageBatches } = require('../utils/importedImages.cjs');

function createWorkspaceStore(app) {
  const technicalPlanFile = getTechnicalPlanFilePath(app);
  const duplicateCheckFile = getDuplicateCheckFilePath(app);

  return {
    getTechnicalPlanFilePath() {
      return technicalPlanFile;
    },

    loadTechnicalPlan() {
      if (!fs.existsSync(technicalPlanFile)) {
        return null;
      }

      try {
        const raw = fs.readFileSync(technicalPlanFile, 'utf-8');
        return JSON.parse(raw);
      } catch (error) {
        throw new Error(`技术方案缓存读取失败：${error.message}`);
      }
    },

    saveTechnicalPlan(state) {
      try {
        fs.mkdirSync(path.dirname(technicalPlanFile), { recursive: true });
        fs.writeFileSync(technicalPlanFile, JSON.stringify(state, null, 2), 'utf-8');
        return { success: true, message: '技术方案缓存已保存', file_path: technicalPlanFile };
      } catch (error) {
        throw new Error(`技术方案缓存保存失败：${error.message}`);
      }
    },

    updateTechnicalPlan(partial) {
      const prev = this.loadTechnicalPlan() || {};
      const next = { ...prev, ...partial };
      this.saveTechnicalPlan(next);
      return next;
    },

    clearTechnicalPlan() {
      try {
        if (fs.existsSync(technicalPlanFile)) {
          fs.unlinkSync(technicalPlanFile);
        }
        deleteImportedImageBatches(app, 'technical-plan');
        return { success: true, message: '技术方案缓存已清空', file_path: technicalPlanFile };
      } catch (error) {
        throw new Error(`技术方案缓存清空失败：${error.message}`);
      }
    },

    loadDuplicateCheck() {
      if (!fs.existsSync(duplicateCheckFile)) {
        return null;
      }

      try {
        const raw = fs.readFileSync(duplicateCheckFile, 'utf-8');
        return JSON.parse(raw);
      } catch (error) {
        throw new Error(`标书查重缓存读取失败：${error.message}`);
      }
    },

    saveDuplicateCheck(state) {
      try {
        fs.mkdirSync(path.dirname(duplicateCheckFile), { recursive: true });
        fs.writeFileSync(duplicateCheckFile, JSON.stringify(state, null, 2), 'utf-8');
        return { success: true, message: '标书查重缓存已保存', file_path: duplicateCheckFile };
      } catch (error) {
        throw new Error(`标书查重缓存保存失败：${error.message}`);
      }
    },

    clearDuplicateCheck() {
      try {
        if (fs.existsSync(duplicateCheckFile)) {
          fs.unlinkSync(duplicateCheckFile);
        }
        return { success: true, message: '标书查重缓存已清空', file_path: duplicateCheckFile };
      } catch (error) {
        throw new Error(`标书查重缓存清空失败：${error.message}`);
      }
    },
  };
}

module.exports = {
  createWorkspaceStore,
};
