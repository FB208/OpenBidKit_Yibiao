const fs = require('node:fs');
const path = require('node:path');
const { getTechnicalPlanFilePath } = require('../utils/paths.cjs');

function createWorkspaceStore(app) {
  const technicalPlanFile = getTechnicalPlanFilePath(app);

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
        return { success: true, message: '技术方案缓存已清空', file_path: technicalPlanFile };
      } catch (error) {
        throw new Error(`技术方案缓存清空失败：${error.message}`);
      }
    },
  };
}

module.exports = {
  createWorkspaceStore,
};
