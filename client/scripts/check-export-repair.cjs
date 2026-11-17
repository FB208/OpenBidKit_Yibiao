// 导出修复端到端检查（Electron 主进程、真实文本模型）。
// 用法（在 client/ 下）：node_modules\.bin\electron.cmd scripts/check-export-repair.cjs <样本 userData 目录> [inspect|convert|none ...]
// 每个场景：复制样本工作区到临时目录 → 用仓库根目录 .env.test 的文本模型替换配置（不使用样本中的密钥）→ 注入故障 →
// 按导出入口的流程导出失败、启用 AI 调整并修复 → 等待调整任务结束 → 输出耗时、模型轮数、工具调用、工作区文件 → 再次整本导出确认。
// 场景：inspect 删掉某节一个 </figure>（预检失败）；convert 把某张图片引用改为反斜杠路径（预检通过、转换器拒绝）；none 不注入，只验证样本能直接导出。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const CLIENT = path.resolve(__dirname, '..');
const service = name => require(path.join(CLIENT, 'electron/services', name));
const ADJUSTMENT_KEY = 'technical-plan-document-adjustment';
const CONTENT_KEY = 'technical-plan-content-generation';
const TIMEOUT_MS = 30 * 60 * 1000;
const [sampleArg, ...caseArgs] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const cases = caseArgs.length ? caseArgs : ['inspect', 'convert'];
if (!sampleArg) {
  console.log('用法：electron scripts/check-export-repair.cjs <样本 userData 目录> [inspect|convert|none ...]');
  process.exit(1);
}
const sample = path.resolve(sampleArg);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-export-repair-'));
const userData = path.join(root, cases[0]);
const log = (...args) => console.log('[export-repair]', ...args);

function readEnvTest() {
  const file = path.resolve(CLIENT, '..', '.env.test');
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  if (!values.api_key || !values.base_url || !values.model_name) throw new Error('.env.test 缺少 api_key、base_url 或 model_name');
  return values;
}

// 只复制业务数据和 Agent 运行环境；清掉样本里的调整会话和失败现场，模型配置换成测试模型并清空其他密钥。
function prepareUserData(target, model) {
  fs.mkdirSync(target, { recursive: true });
  for (const name of ['workspace', 'agent-runtime', 'user_config.json', 'license.json']) {
    if (fs.existsSync(path.join(sample, name))) fs.cpSync(path.join(sample, name), path.join(target, name), { recursive: true });
  }
  fs.rmSync(path.join(target, 'agent-runtime/pi/tasks', ADJUSTMENT_KEY), { recursive: true, force: true });
  fs.rmSync(path.join(target, 'workspace/technical-plan/export-failures'), { recursive: true, force: true });
  const configFile = path.join(target, 'user_config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  for (const profile of Object.values(config.text_model_profiles || {})) profile.api_key = '';
  if (config.image_model) config.image_model.api_key = '';
  config.text_model_provider = 'custom';
  config.text_model_profiles = { ...config.text_model_profiles, custom: {
    ...(config.text_model_profiles?.custom || {}), api_key: model.api_key, base_url: model.base_url, model_name: model.model_name,
    context_length_limit: 128000, request_mode: 'stream',
  } };
  Object.assign(config, { api_key: model.api_key, base_url: model.base_url, model_name: model.model_name, context_length_limit: 128000 });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
}

// 按文件名顺序选第一个符合条件的小节注入故障，返回改动说明。
function injectFault(target, kind) {
  if (kind === 'none') return '未注入故障';
  const dir = path.join(target, 'agent-runtime/pi/tasks', CONTENT_KEY, 'workspace/正文');
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const html = fs.readFileSync(file, 'utf8');
    if (kind === 'inspect' && html.includes('</figure>')) {
      fs.writeFileSync(file, html.replace('</figure>', ''), 'utf8');
      return `删除 正文/${name} 中第一个 </figure>`;
    }
    const match = html.match(/data-yb-asset-ref="图片\/([^"]+)"/);
    if (kind === 'convert' && match) {
      fs.writeFileSync(file, html.replace(match[0], `data-yb-asset-ref="图片\\${match[1]}"`), 'utf8');
      return `把 正文/${name} 中的图片引用 图片/${match[1]} 改为反斜杠路径`;
    }
  }
  throw new Error(`没有找到可注入 ${kind} 故障的小节`);
}

// 按 ipc/index.cjs 的装配方式组装导出与调整任务需要的服务（不注册 IPC、不启动插件）。
function createServices() {
  const configStore = service('configStore.cjs').createConfigStore(app);
  service('localImageRenderService.cjs').initLocalImageRenderService({ configStore });
  const aiService = service('aiService.cjs').createAiService({ app, configStore });
  const autoConfirmationService = service('autoConfirmationService.cjs').createAutoConfirmationService({ configStore });
  const licenseService = service('licenseService.cjs').createLicenseService({ app, configStore });
  const agentService = service('agentService.cjs').createAgentService({ app, configStore, aiService, licenseService, autoConfirmationService });
  const fileService = service('fileService.cjs').createFileService({ app, configStore });
  const openXmlHelperService = service('openXmlHelperService.cjs').createOpenXmlHelperService({ app, configStore });
  const sqliteDatabase = service('sqliteDatabase.cjs').createSqliteDatabase(app, { onStatus: () => {} });
  const db = sqliteDatabase.db;
  const taskLogStore = service('taskLogStore.cjs').createTaskLogStore({ db });
  const credentialLibraryService = service('credentialLibraryService.cjs').createCredentialLibraryService({ app, db });
  const knowledgeBaseStore = service('knowledgeBaseStore.cjs').createKnowledgeBaseStore({ app, db });
  const knowledgeBaseService = service('knowledgeBaseService.cjs').createKnowledgeBaseService({ app, aiService, configStore, knowledgeBaseStore });
  const technicalPlanStore = service('technicalPlanStore.cjs').createTechnicalPlanStore({ app, db, fileService, agentService, taskLogStore, configStore });
  const feasibilityReportStore = service('feasibilityReportStore.cjs').createFeasibilityReportStore({ app, db, fileService, taskLogStore, agentService });
  const duplicateCheckStore = service('duplicateCheckStore.cjs').createDuplicateCheckStore({ app, db, taskLogStore });
  const rejectionCheckStore = service('rejectionCheckStore.cjs').createRejectionCheckStore({ app, db, fileService, technicalPlanStore, taskLogStore });
  const blindCheckStore = service('blindCheckStore.cjs').createBlindCheckStore({ app, db, taskLogStore, credentialLibraryService, fileService, technicalPlanStore });
  const templateStore = service('templateStore.cjs').createTemplateStore({ db });
  templateStore.syncSystemTemplates();
  const duplicateCheckService = service('duplicateCheckService.cjs').createDuplicateCheckService({ app, configStore, workspaceStore: duplicateCheckStore });
  let taskService;
  const technicalPlanExport = service('technicalPlanExport.cjs').createTechnicalPlanExport({ app, technicalPlanStore, templateStore, agentService, openXmlHelperService, credentialLibraryService,
    startAdjustment: payload => taskService.startBidDocumentAdjustment(payload),
    beginExport: () => taskService.beginTechnicalPlanExport(),
  });
  taskService = service('taskService.cjs').createTaskService({ app, technicalPlanExport, templateStore, aiService, agentService, autoConfirmationService, technicalPlanStore, rejectionCheckStore, duplicateCheckStore, blindCheckStore, feasibilityReportStore, knowledgeBaseService, duplicateCheckService, openXmlHelperService, credentialLibraryService });
  return { technicalPlanStore, technicalPlanExport, taskService, openXmlHelperService, sqliteDatabase };
}

// 与 exportService.exportWord 的技术方案分支相同：预检问题和转换错误都交给 repair；这里不弹保存框，成功时只返回字节数。
async function exportOnce({ technicalPlanExport }, { capture = true } = {}) {
  const release = technicalPlanExport.beginExport?.();
  let snapshot;
  try {
    snapshot = technicalPlanExport.prepare();
    const issues = technicalPlanExport.inspect(snapshot);
    if (issues.length) {
      release?.();
      return { ok: false, phase: 'inspect', message: issues.map(issue => `${issue.section}：${issue.problems.join('；')}`).join('\n'),
        outcome: capture ? technicalPlanExport.repair(new Error(`导出前发现 ${issues.length} 个问题小节`), snapshot, issues) : null };
    }
    const result = await technicalPlanExport.build(snapshot, { stats: {}, captureFailures: capture });
    return { ok: true, bytes: result.buffer.length, warnings: result.warnings };
  } catch (error) {
    release?.();
    return { ok: false, phase: 'build', message: error.message, outcome: capture && snapshot ? technicalPlanExport.repair(error, snapshot) : null };
  } finally {
    release?.();
  }
}

function waitForAdjustment(taskService) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`调整任务超过 ${TIMEOUT_MS / 60000} 分钟未结束`)); }, TIMEOUT_MS);
    const unsubscribe = taskService.subscribeCallback(({ task }) => {
      if (task?.type !== 'bid-document-adjustment' || !['success', 'error'].includes(task.status)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(task);
    });
  });
}

// 从调整会话还原执行情况：模型轮数、各工具调用次数、bash 命令和工作区文件。
function summarizeSession(target) {
  const taskDir = path.join(target, 'agent-runtime/pi/tasks', ADJUSTMENT_KEY);
  const sessionsDir = path.join(taskDir, 'sessions');
  const summary = { rounds: 0, tools: {}, bash: [], edits: [] };
  for (const name of fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []) {
    for (const line of fs.readFileSync(path.join(sessionsDir, name), 'utf8').split('\n').filter(Boolean)) {
      const message = JSON.parse(line).message;
      if (message?.role !== 'assistant') continue;
      summary.rounds += 1;
      for (const part of message.content || []) {
        if (part.type !== 'toolCall') continue;
        summary.tools[part.name] = (summary.tools[part.name] || 0) + 1;
        if (part.name === 'bash') summary.bash.push(String(part.arguments?.command || '').slice(0, 160));
        if (['edit', 'write'].includes(part.name)) summary.edits.push(part.arguments?.path);
      }
    }
  }
  const workspace = path.join(taskDir, 'workspace');
  summary.workspaceFiles = fs.existsSync(workspace) ? fs.readdirSync(workspace) : [];
  return summary;
}

async function runCase(kind, model) {
  const target = path.join(root, kind);
  if (target !== userData) throw new Error('每次只能运行一个场景：Electron 的 userData 只能在启动前设置');
  prepareUserData(target, model);
  const fault = injectFault(target, kind);
  log(`场景 ${kind}：${fault}；临时目录 ${target}`);
  const services = createServices();
  const first = await exportOnce(services);
  if (first.ok) {
    log(kind === 'none' ? `样本直接导出成功：${first.bytes} 字节` : '注入故障后导出仍然成功，场景无效');
    return kind === 'none';
  }
  log(`首次导出失败（${first.phase}）：${first.message.slice(0, 400)}`);
  const started = Date.now();
  const settled = waitForAdjustment(services.taskService);
  if (first.outcome?.failureId) services.taskService.enableDocumentAdjustment({ exportFailureId: first.outcome.failureId });
  else if (!first.outcome?.started) throw new Error('导出失败后未能启动调整任务');
  const task = await settled;
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  const adjustment = task.stats?.adjustment || {};
  const session = summarizeSession(target);
  log(`调整任务结束：${task.status}，耗时 ${seconds} 秒，验收导出 ${adjustment.export_verified ? '通过' : '未通过'}`);
  if (task.error) log(`错误：${task.error}`);
  log(`结果说明：${String(adjustment.summary || '').slice(0, 400)}`);
  log(`模型轮数 ${session.rounds}；工具调用 ${JSON.stringify(session.tools)}`);
  log(`编辑/写入：${JSON.stringify(session.edits)}`);
  log(`bash 命令：\n  ${session.bash.join('\n  ') || '（无）'}`);
  log(`调整工作区文件：${session.workspaceFiles.join('、')}`);
  const second = await exportOnce(services, { capture: false });
  log(second.ok ? `修复后再次导出成功：${second.bytes} 字节` : `修复后再次导出失败（${second.phase}）：${second.message.slice(0, 400)}`);
  return task.status === 'success' && second.ok;
}

app.setPath('userData', userData);
app.whenReady().then(async () => {
  let passed = false;
  try {
    if (cases.length > 1) log(`只运行第一个场景 ${cases[0]}；其他场景请分别启动：Electron 的 userData 只能在启动前设置`);
    passed = await runCase(cases[0], readEnvTest());
  } catch (error) {
    log('检查异常：', error.stack || error.message);
  } finally {
    log(passed ? '通过' : '未通过');
    app.exit(passed ? 0 : 1);
  }
});
