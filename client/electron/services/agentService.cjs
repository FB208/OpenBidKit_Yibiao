const fs = require('node:fs');
const path = require('node:path');
const { dialog } = require('electron');
const { createOpenCodeRuntimeService } = require('./opencode/opencodeRuntimeService.cjs');
const {
  buildSelfCheckReportMarkdown,
  formatTimestampForFilename,
  sanitizeReportFilename,
} = require('./opencode/opencodeSelfCheckService.cjs');

function createAgentService({ app, configStore, mainWindow }) {
  const runtime = createOpenCodeRuntimeService({ app, configStore, mainWindow });

  async function exportSelfCheckReport(result = {}) {
    const markdown = buildSelfCheckReportMarkdown(result);
    const defaultDir = app?.getPath ? app.getPath('documents') : process.env.USERPROFILE || process.cwd();
    const defaultName = `${sanitizeReportFilename('智能体自检报告')}-${formatTimestampForFilename(result?.checked_at)}.md`;
    const saveResult = await dialog.showSaveDialog({
      title: '导出智能体自检报告',
      defaultPath: path.join(defaultDir, defaultName),
      filters: [{ name: 'Markdown 文档', extensions: ['md'] }],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { success: false, canceled: true, message: '已取消导出' };
    }

    fs.writeFileSync(saveResult.filePath, markdown, 'utf-8');
    return { success: true, path: saveResult.filePath, message: '智能体自检报告已导出' };
  }

  return {
    warmup: () => runtime.warmup(),
    runTask: (payload) => runtime.runTask(payload),
    selfCheck: () => runtime.runSelfCheck(),
    getStatus: () => runtime.getStatus(),
    restart: (reason) => runtime.restart(reason || 'manual'),
    markRestartPending: (reason) => runtime.markRestartPending(reason),
    handleConfigChanged: (nextConfig, previousConfig) => runtime.handleConfigChanged(nextConfig, previousConfig),
    onStatus: (listener) => runtime.onStatus(listener),
    exportSelfCheckReport,
    close: () => runtime.close(),
  };
}

module.exports = {
  createAgentService,
};
