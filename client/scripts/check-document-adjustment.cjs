// 投标文件 AI 调整端到端检查（Electron 主进程、真实文本模型）。
// 用法（在 client/ 下）：node_modules\.bin\electron.cmd scripts/check-document-adjustment.cjs <样本 userData 目录> [步骤 ...]
// 步骤：export:inspect | export:convert | export:none，或一个 UTF-8 的 .json 步骤文件：
//   [{ "type": "user", "requirement": "调整要求", "section_ids": ["可选"] }, { "type": "export", "fault": "inspect" }]
// 所有步骤在同一个临时 userData、同一个调整会话中依次执行，用来检查任务切换后是否只处理本次任务。
// 准备：复制样本工作区到临时目录 → 清掉样本里的调整会话和失败现场 → 用仓库根目录 .env.test 的文本模型替换配置（不使用样本中的密钥）
// → 把转换助手工程复制到临时目录单独编译运行（不占用本机开发版应用正在使用的 Debug 助手）。
// 人工调整：未启用时先启用，再按桌宠入口发送要求。导出修复：注入故障 → 按导出入口的流程导出失败并修复 → 再次整本导出确认。
// export 故障：inspect 删掉某节一个 </figure>（预检失败）；convert 把某张图片引用改为反斜杠路径（预检通过、转换器拒绝）；none 不注入，只验证样本能直接导出。
// 每步输出耗时、模型轮数、工具调用、编辑文件、bash 命令、调整工作区文件，以及正式目录中新出现的文件。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const CLIENT = path.resolve(__dirname, '..');
const service = name => require(path.join(CLIENT, 'electron/services', name));
const ADJUSTMENT_KEY = 'technical-plan-document-adjustment';
const CONTENT_KEY = 'technical-plan-content-generation';
const TIMEOUT_MS = 30 * 60 * 1000;
const [sampleArg, ...stepArgs] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
if (!sampleArg) {
  console.log('用法：electron scripts/check-document-adjustment.cjs <样本 userData 目录> [export:inspect|export:convert|export:none|步骤.json ...]');
  process.exit(1);
}
const sample = path.resolve(sampleArg);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-document-adjustment-'));
const userData = path.join(root, 'userData');
const log = (...args) => console.log('[adjustment]', ...args);

function parseSteps(args) {
  const steps = (args.length ? args : ['export:inspect']).flatMap(arg => {
    if (arg.endsWith('.json')) return JSON.parse(fs.readFileSync(path.resolve(arg), 'utf8'));
    const match = arg.match(/^export:(inspect|convert|none)$/);
    if (!match) throw new Error(`无法识别的步骤：${arg}`);
    return [{ type: 'export', fault: match[1] }];
  });
  for (const step of steps) {
    if (step.type === 'user' && !String(step.requirement || '').trim() && !step.section_ids?.length) throw new Error('人工调整步骤缺少 requirement');
    if (!['user', 'export'].includes(step.type)) throw new Error(`未知步骤类型：${step.type}`);
  }
  return steps;
}

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

// 开发模式下转换助手每次使用前都会 dotnet build 共享的 Debug 输出，本机正在运行的开发版应用会占用它导致编译失败。
// 检查时把助手工程复制到临时目录单独编译和运行，不影响正在运行的应用；必须在加载 openXmlHelperService 之前调用。
function isolateOpenXmlHelper() {
  const source = path.resolve(CLIENT, '..', 'openxmlhelper');
  const target = path.join(root, 'openxmlhelper');
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(source, 'global.json'), path.join(target, 'global.json'));
  fs.cpSync(path.join(source, 'src/OpenXmlHelper'), path.join(target, 'src/OpenXmlHelper'), {
    recursive: true, filter: file => !/[\\/]OpenXmlHelper[\\/](bin|obj)$/.test(file) });
  const paths = require(path.join(CLIENT, 'electron/utils/paths.cjs'));
  const projectDir = path.join(target, 'src/OpenXmlHelper');
  paths.getOpenXmlHelperProjectPath = () => path.join(projectDir, 'OpenXmlHelper.csproj');
  paths.getOpenXmlHelperDebugExecutablePath = () => path.join(projectDir, 'bin/Debug/net10.0', process.platform === 'win32' ? 'openxmlhelper.exe' : 'openxmlhelper');
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

// 调整结束后可能自动启动规则和页码编制；等其他技术方案任务结束再进入下一步，返回等待秒数。
async function waitForIdle(taskService) {
  const started = Date.now();
  await new Promise(resolve => setTimeout(resolve, 1000));
  while (/任务执行中/.test(taskService.getDocumentAdjustmentBlocker())) {
    if (Date.now() - started > TIMEOUT_MS) throw new Error('后续任务长时间未结束');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return Math.round((Date.now() - started) / 1000);
}

// 从调整会话还原本步执行情况：只统计本步开始后的消息。
function summarizeSession(target, since) {
  const taskDir = path.join(target, 'agent-runtime/pi/tasks', ADJUSTMENT_KEY);
  const sessionsDir = path.join(taskDir, 'sessions');
  const summary = { rounds: 0, tools: {}, bash: [], edits: [] };
  for (const name of fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []) {
    for (const line of fs.readFileSync(path.join(sessionsDir, name), 'utf8').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      const message = entry.message;
      if (message?.role !== 'assistant' || new Date(entry.timestamp).getTime() < since) continue;
      summary.rounds += 1;
      for (const part of message.content || []) {
        if (part.type !== 'toolCall') continue;
        summary.tools[part.name] = (summary.tools[part.name] || 0) + 1;
        if (part.name === 'bash') summary.bash.push(String(part.arguments?.command || '').replace(/\s+/g, ' ').slice(0, 200));
        if (['edit', 'write'].includes(part.name)) summary.edits.push(part.arguments?.path);
      }
    }
  }
  const workspace = path.join(taskDir, 'workspace');
  summary.workspaceFiles = fs.existsSync(workspace) ? fs.readdirSync(workspace) : [];
  return summary;
}

// 正式目录的顶层文件列表，用来发现留在正式位置的临时文件；程序自己写的导出失败现场不算。
function listFormalDirs(target) {
  const dirs = [path.join(target, 'workspace'), path.join(target, 'workspace/technical-plan'),
    path.join(target, 'agent-runtime/pi/tasks', CONTENT_KEY, 'workspace')];
  return new Set(dirs.flatMap(dir => fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(name => name !== 'export-failures').map(name => path.join(dir, name)) : []));
}

async function runStep(index, step, services) {
  const label = step.type === 'user' ? `人工调整：${String(step.requirement || '').replace(/\s+/g, ' ').slice(0, 60)}` : `导出修复：${step.fault}`;
  log(`===== 第 ${index + 1} 步 ${label}`);
  const formalBefore = listFormalDirs(userData);
  const started = Date.now();
  let settled;
  if (step.type === 'user') {
    if (!services.technicalPlanStore.isDocumentAdjustmentEnabled()) services.taskService.enableDocumentAdjustment({});
    settled = waitForAdjustment(services.taskService);
    services.taskService.startBidDocumentAdjustment({ origin: 'user', requirement: step.requirement, sectionIds: step.section_ids });
  } else {
    log(injectFault(userData, step.fault));
    const first = await exportOnce(services);
    if (first.ok) {
      log(step.fault === 'none' ? `样本直接导出成功：${first.bytes} 字节` : '注入故障后导出仍然成功，场景无效');
      return { label, passed: step.fault === 'none' };
    }
    log(`首次导出失败（${first.phase}）：${first.message.slice(0, 400)}`);
    settled = waitForAdjustment(services.taskService);
    if (first.outcome?.failureId) services.taskService.enableDocumentAdjustment({ exportFailureId: first.outcome.failureId });
    else if (!first.outcome?.started) throw new Error('导出失败后未能启动调整任务');
  }
  const task = await settled;
  const seconds = Math.round((Date.now() - started) / 1000);
  const adjustment = task.stats?.adjustment || {};
  const session = summarizeSession(userData, started);
  log(`调整任务结束：${task.status}，耗时 ${seconds} 秒${step.type === 'export' ? `，验收导出 ${adjustment.export_verified ? '通过' : '未通过'}` : ''}`);
  if (task.error) log(`错误：${task.error}`);
  log(`结果说明：${String(adjustment.summary || '').slice(0, 400)}`);
  log(`改动小节：${JSON.stringify(adjustment.changed_node_ids || [])}`);
  log(`模型轮数 ${session.rounds}；工具调用 ${JSON.stringify(session.tools)}`);
  log(`编辑/写入：${JSON.stringify(session.edits)}`);
  log(`bash 命令：\n  ${session.bash.join('\n  ') || '（无）'}`);
  log(`调整工作区文件：${session.workspaceFiles.join('、')}`);
  const leftovers = [...listFormalDirs(userData)].filter(file => !formalBefore.has(file));
  log(`正式目录新增文件：${leftovers.join('、') || '（无）'}`);
  let passed = task.status === 'success';
  if (step.type === 'export') {
    const second = await exportOnce(services, { capture: false });
    log(second.ok ? `修复后再次导出成功：${second.bytes} 字节` : `修复后再次导出失败（${second.phase}）：${second.message.slice(0, 400)}`);
    passed = passed && second.ok;
  }
  const waited = await waitForIdle(services.taskService);
  if (waited > 3) log(`等待调整后的后续任务结束：${waited} 秒`);
  return { label, passed, seconds, rounds: session.rounds };
}

app.setPath('userData', userData);
app.whenReady().then(async () => {
  const results = [];
  let steps = [];
  let crashed = false;
  try {
    steps = parseSteps(stepArgs);
    prepareUserData(userData, readEnvTest());
    log(`临时目录 ${userData}，共 ${steps.length} 步`);
    isolateOpenXmlHelper();
    const services = createServices();
    for (const [index, step] of steps.entries()) results.push(await runStep(index, step, services));
  } catch (error) {
    crashed = true;
    log('检查异常：', error.stack || error.message);
  } finally {
    for (const [index, result] of results.entries()) {
      log(`第 ${index + 1} 步 ${result.passed ? '通过' : '未通过'}：${result.label}${result.seconds !== undefined ? `（${result.seconds} 秒，${result.rounds} 轮）` : ''}`);
    }
    const passed = !crashed && results.length === steps.length && results.every(result => result.passed);
    log(passed ? '全部通过' : '未通过');
    app.exit(passed ? 0 : 1);
  }
});
