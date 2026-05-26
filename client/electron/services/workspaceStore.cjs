const fs = require('node:fs');
const path = require('node:path');
const { getDuplicateCheckDir, getDuplicateCheckFilePath, getRejectionCheckFilePath, getTechnicalPlanFilePath } = require('../utils/paths.cjs');
const { deleteImportedImageBatches } = require('../utils/importedImages.cjs');

function createWorkspaceStore(app) {
  const technicalPlanFile = getTechnicalPlanFilePath(app);
  const duplicateCheckFile = getDuplicateCheckFilePath(app);
  const duplicateCheckDir = getDuplicateCheckDir(app);
  const rejectionCheckFile = getRejectionCheckFilePath(app);

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

    updateDuplicateCheck(partial) {
      const prev = this.loadDuplicateCheck() || {};
      const next = { ...prev, ...partial };
      this.saveDuplicateCheck(next);
      return next;
    },

    clearDuplicateCheck() {
      try {
        if (fs.existsSync(duplicateCheckFile)) {
          fs.unlinkSync(duplicateCheckFile);
        }
        if (fs.existsSync(duplicateCheckDir)) {
          fs.rmSync(duplicateCheckDir, { recursive: true, force: true });
        }
        deleteImportedImageBatches(app, 'duplicate-check-content');
        return { success: true, message: '标书查重缓存已清空', file_path: duplicateCheckFile };
      } catch (error) {
        throw new Error(`标书查重缓存清空失败：${error.message}`);
      }
    },

    loadRejectionCheck() {
      if (!fs.existsSync(rejectionCheckFile)) {
        return null;
      }

      try {
        const raw = fs.readFileSync(rejectionCheckFile, 'utf-8');
        return JSON.parse(raw);
      } catch (error) {
        throw new Error(`废标项检查缓存读取失败：${error.message}`);
      }
    },

    saveRejectionCheck(state) {
      try {
        fs.mkdirSync(path.dirname(rejectionCheckFile), { recursive: true });
        fs.writeFileSync(rejectionCheckFile, JSON.stringify(state, null, 2), 'utf-8');
        return { success: true, message: '废标项检查缓存已保存', file_path: rejectionCheckFile };
      } catch (error) {
        throw new Error(`废标项检查缓存保存失败：${error.message}`);
      }
    },

    clearRejectionCheck() {
      try {
        if (fs.existsSync(rejectionCheckFile)) {
          fs.unlinkSync(rejectionCheckFile);
        }
        deleteImportedImageBatches(app, 'rejection-check');
        return { success: true, message: '废标项检查缓存已清空', file_path: rejectionCheckFile };
      } catch (error) {
        throw new Error(`废标项检查缓存清空失败：${error.message}`);
      }
    },
  };
}

module.exports = {
  createWorkspaceStore,
};
