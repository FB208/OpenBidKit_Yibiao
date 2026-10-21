// 暗标合规检查的数据库迁移、Store、预设和任务落库验证，使用系统临时目录中的独立 SQLite 工作区。
// better-sqlite3 按 Electron ABI 编译，需用 Electron 的 Node 运行（client 目录）：
//   set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd scripts/check-blind-check-store.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const AdmZip = require('adm-zip');
const { createSqliteDatabase } = require('../electron/services/sqliteDatabase.cjs');
const { createTaskLogStore } = require('../electron/services/taskLogStore.cjs');
const { createBlindCheckStore } = require('../electron/services/blindCheckStore.cjs');
const { runBlindCheckTask } = require('../electron/services/blindCheckTask.cjs');
const { runBlindCheckFixTask } = require('../electron/services/blindCheckFixTask.cjs');
const { createOpenXmlHelperService } = require('../electron/services/openXmlHelperService.cjs');
const { fixScope, issueSummary } = require('../electron/services/blindCheckReview.cjs');
const { FIX_RULE_IDS } = require('../electron/services/blindCheckPresets.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), '暗标检查存储验证-'));
const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), '暗标检查原件-'));
const app = { isPackaged: false, getPath: () => userData, getAppPath: () => path.join(__dirname, '..'), once: () => {} };
const credentialLibraryService = { load: () => ({ profile: { companyName: '北京华夏建设有限公司', phone: '13812345678', email: '' } }) };
const technicalPlanStore = {
  readTenderMarkdown: () => '附表七：技术暗标编制要求。正文四号宋体。',
  listTenderSourceFiles: () => [{ id: 'tender-01', fileName: '某项目招标文件.pdf' }],
};
let database;
let store;
let helper;

function writeDocx(fileName, paragraphs) {
  const zip = new AdmZip();
  const body = paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join('');
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417"/></w:sectPr></w:body></w:document>`, 'utf8'));
  const filePath = path.join(inputDir, fileName);
  zip.writeZip(filePath);
  return filePath;
}

before(() => {
  database = createSqliteDatabase(app);
  const taskLogStore = createTaskLogStore({ db: database.db });
  store = createBlindCheckStore({ app, db: database.db, taskLogStore, credentialLibraryService, technicalPlanStore });
  helper = createOpenXmlHelperService({ app });
});

after(async () => {
  await helper?.close();
  await helper?.closeBlindCheck();
  database?.close();
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(inputDir, { recursive: true, force: true });
});

test('迁移到 v42，暗标检查、修复与 AI 复核表齐全且初始状态正确', () => {
  assert.equal(Number(database.db.pragma('user_version', { simple: true })), 42);
  // 客户端声明的版本要等于最新迁移，否则已是上一版本的数据库启动时不会执行新迁移。
  assert.equal(database.schemaVersion, 42);
  const columns = (table) => database.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
  assert.ok(columns('blind_check_presets').includes('source_json'));
  assert.ok(['ai_review_enabled', 'fix_ai_enabled'].every((name) => columns('blind_check_meta').includes(name)));
  assert.ok(['candidate', 'items_json'].every((name) => columns('blind_check_finding_groups').includes(name)));
  assert.ok(['items_json', 'new_groups_json', 'clauses_json', 'agent_json'].every((name) => columns('blind_check_fix_results').includes(name)));
  const tables = database.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'blind_check_%'").all().map((row) => row.name).sort();
  assert.deepEqual(tables, ['blind_check_finding_groups', 'blind_check_fix_groups', 'blind_check_fix_results', 'blind_check_meta', 'blind_check_presets', 'blind_check_results', 'blind_check_reviews', 'blind_check_tasks']);
  const state = store.loadBlindCheck();
  assert.equal(state.step, 'upload');
  assert.equal(state.presetId, 'builtin-general');
  assert.equal(state.file, null);
  assert.equal(state.result.status, 'idle');
  assert.equal(state.review.status, 'idle');
  assert.equal(state.aiReviewEnabled, true, '检查弹窗默认选程序检查 + AI 复核');
  assert.equal(state.fixAiEnabled, true, '修复弹窗默认选程序修复 + AI 修复');
  assert.equal(state.fixResult.status, 'idle');
  assert.ok(state.fixRules.includes('struct.doc_props') && !state.fixRules.includes('para.page_break_before'), '默认勾选不含段前分页');
  assert.equal(store.getInputSignature(), null);
});

test('导入只接受 .docx，副本落在工作区，换文件清理旧副本', async () => {
  await assert.rejects(store.importFile(path.join(inputDir, '技术标.doc')), /仅支持 \.docx/);
  const first = await store.importFile(writeDocx('第一份技术标.docx', ['第一份']));
  assert.equal(first.file.fileName, '第一份技术标.docx');
  let canceled = 0;
  const second = await store.importFile(writeDocx('第二份技术标.docx', ['第二份']), { beforeCommit: async () => { canceled += 1; } });
  assert.equal(canceled, 1, '提交前先取消运行中的检查');
  assert.equal(second.file.fileName, '第二份技术标.docx');
  const sourceFiles = fs.readdirSync(path.join(userData, 'workspace', 'blind-check', 'source'));
  assert.deepEqual(sourceFiles, [`${second.file.id}.docx`]);
});

test('预设：内置只读，复制后可改并规范，删除后回到通用预设，签名随预设变化', () => {
  assert.equal(store.listPresets().filter((preset) => preset.builtin).length, 4);
  assert.throws(() => store.updatePreset('builtin-general', { name: '改名' }), /内置预设不能修改/);
  const before = store.getInputSignature();
  const created = store.createPreset({ name: '某项目暗标要求', basePresetId: 'builtin-hebei' });
  assert.equal(store.loadBlindCheck().presetId, created.id);
  assert.equal(created.profile.body.line_pt, 30);
  const updated = store.updatePreset(created.id, { profile: { ...created.profile, body: { ...created.profile.body, size_pt: 200, line_rule: '固定值' }, unknown: true } });
  assert.equal(updated.profile.body.size_pt, 72);
  assert.equal(updated.profile.body.line_rule, 'exact');
  assert.equal(updated.profile.unknown, undefined);
  assert.notEqual(store.getInputSignature(), before);
  store.deletePreset(created.id);
  assert.equal(store.loadBlindCheck().presetId, 'builtin-general');
  assert.equal(store.getInputSignature(), before);
  const copy = store.createPreset({ basePresetId: 'builtin-general' });
  assert.notEqual(store.getInputSignature(), before, '格式配置相同的另一份预设（招标依据可能不同）也算不同输入');
  store.deletePreset(copy.id);
});

test('AI 提取的预设：新建并选中，出处随预设保存，重名时自动编号，技术方案招标文件可作为来源', () => {
  assert.deepEqual(store.getTenderSources(), { technicalPlan: { available: true, fileName: '某项目招标文件.pdf' } });
  assert.match(store.readTechnicalPlanTender().content, /技术暗标/);
  const source = {
    version: 1,
    tenderName: '某项目招标文件.pdf',
    extractedAt: new Date().toISOString(),
    fields: { 'body.size_pt': { value: 14, evidence: '正文四号宋体', verified: true } },
    unspecified: ['body.alignment'],
    manual: ['标题居中'],
    dropped: [],
    notes: '',
  };
  const first = store.createExtractedPreset({ tenderName: '某项目招标文件.pdf', profile: { body: { size_pt: 14, alignment: null } }, source, tenderContent: '附表七：技术暗标编制要求。' });
  assert.equal(first.name, '某项目招标文件（AI 提取）');
  assert.deepEqual(store.readPresetTender(first.id), { fileName: '某项目招标文件.pdf', content: '附表七：技术暗标编制要求。' }, '招标文件正文随预设保存，供 AI 复核对照');
  assert.equal(store.loadBlindCheck().presetId, first.id, '生成后选中');
  assert.deepEqual(first.source, source);
  assert.match(first.description, /提取 1 项格式要求/);
  const second = store.createExtractedPreset({ tenderName: '某项目招标文件.pdf', profile: {}, source });
  assert.equal(second.name, '某项目招标文件（AI 提取）（2）');
  const renamed = store.updatePreset(first.id, { name: '改过名的预设' });
  assert.deepEqual(renamed.source, source, '改名或改格式不丢出处');
  assert.equal(store.readPresetTender(second.id), null, '没有保存招标文件正文的预设');
  store.deletePreset(first.id);
  store.deletePreset(second.id);
  assert.equal(store.readPresetTender(first.id), null, '删除预设时一并删除招标文件正文');
});

test('资信库敏感词：含企业简称，可关闭，关闭后签名变化', () => {
  const words = store.getCredentialWords();
  assert.deepEqual(words.map((item) => item.value), ['北京华夏建设有限公司', '北京华夏建设', '13812345678']);
  const withWords = store.prepareCheckInput();
  assert.equal(withWords.sensitiveWords.filter((item) => item.source === 'credential').length, 3);
  store.setUseCredentialWords(false);
  const withoutWords = store.prepareCheckInput();
  assert.equal(withoutWords.sensitiveWords.length, 0);
  assert.notEqual(withoutWords.signature, withWords.signature);
  store.setUseCredentialWords(true);
});

test('任务：真实助手检查后结果与任务状态一次落库，重新加载可读', async () => {
  await store.importFile(writeDocx('含企业信息.docx', ['本项目由北京华夏建设有限公司实施，联系电话13812345678。']));
  const tasks = [];
  const checkpointTask = (taskPatch, workspacePatch = {}) => {
    const task = { task_id: 'task-1', type: 'blind-check-run', started_at: new Date().toISOString(), updated_at: new Date().toISOString(), logs: [], ...taskPatch };
    tasks.push(task);
    store.updateBlindCheckWithoutReload({ ...workspacePatch, checkTask: task });
    return { task };
  };
  await runBlindCheckTask({
    workspaceStore: store,
    openXmlHelperService: helper,
    updateTask: () => undefined,
    checkpointTask,
    payload: { aiReview: false },
    taskControl: { signal: new AbortController().signal },
  });
  assert.deepEqual(tasks.map((task) => task.status), ['running', 'success']);
  const state = store.loadBlindCheck();
  assert.equal(state.checkTask.status, 'success');
  assert.equal(state.result.status, 'success');
  assert.equal(state.result.inputSignature, store.getInputSignature());
  assert.ok(state.result.summary.high >= 2);
  const messages = state.result.groups.map((group) => group.message);
  assert.ok(messages.includes('出现敏感词「北京华夏建设有限公司」'), JSON.stringify(messages));
  assert.ok(messages.includes('出现敏感词「13812345678」'), JSON.stringify(messages));
  assert.ok(!messages.includes('出现敏感词「北京华夏建设」'), '简称随全称一起出现时不重复报');
  assert.ok(!messages.some((message) => message.startsWith('出现手机号')), '已作为敏感词报出的电话不再由内置检测器重复报');
  assert.ok(state.result.groups.every((group) => group.id && group.samples.length > 0));
  assert.equal(state.review.status, 'skipped', '选择仅程序检查时不做 AI 复核');
  assert.equal(state.aiReviewEnabled, false, '记住本次检查方式，作为下次弹窗的默认选项');
  assert.deepEqual(state.issues.map((issue) => issue.id).sort(), state.result.groups.map((group) => group.id).sort(), '没有复核时最终问题清单就是程序结果');
  assert.deepEqual(issueSummary(state.issues), state.result.summary);
});

test('自动修复：修复项规范后保存，修复副本与结果落库，原文件不变，换文件时一并清掉', async () => {
  const saved = store.saveFixRules(['struct.doc_props', 'privacy.keyword', 'font.size', 'struct.doc_props']);
  assert.deepEqual(saved.fixRules, ['struct.doc_props', 'font.size'], '只保留可修复的规则并去重');
  store.saveFixRules(['struct.doc_props', 'font.size', 'text.spaces']);

  const tasks = [];
  const checkpointTask = (taskPatch, workspacePatch = {}) => {
    const task = { task_id: 'fix-1', type: 'blind-check-fix', started_at: new Date().toISOString(), updated_at: new Date().toISOString(), logs: [], ...taskPatch };
    tasks.push(task);
    store.updateBlindCheckWithoutReload({ ...workspacePatch, fixTask: task });
    return { task };
  };
  const input = store.prepareFixInput();
  const sourceHash = fs.readFileSync(input.sourcePath).toString('base64');
  await runBlindCheckFixTask({
    workspaceStore: store,
    openXmlHelperService: helper,
    updateTask: () => undefined,
    checkpointTask,
    payload: { ai: false },
    taskControl: { signal: new AbortController().signal },
  });
  assert.deepEqual(tasks.map((task) => task.status), ['running', 'success'], tasks.at(-1)?.error);
  assert.equal(fs.readFileSync(input.sourcePath).toString('base64'), sourceHash, '原文件副本不改动');
  const state = store.loadBlindCheck();
  assert.equal(state.fixTask.status, 'success');
  assert.equal(state.fixResult.status, 'success');
  assert.equal(state.fixResult.inputSignature, store.getInputSignature());
  assert.deepEqual(state.fixResult.fixRules, ['struct.doc_props', 'font.size', 'text.spaces']);
  assert.ok(state.fixResult.outputPath && fs.existsSync(state.fixResult.outputPath));
  const inScope = state.issues.filter((issue) => state.fixResult.fixRules.includes(issue.ruleId));
  assert.deepEqual(state.fixResult.items.filter((item) => !item.isNew).map((item) => item.id), inScope.map((issue) => issue.id), '仅程序修复时只对开着的修复项覆盖的问题对账，身份文字等不进入');
  assert.deepEqual(state.fixResult.beforeSummary, issueSummary(inScope));
  const sum = (key, items = state.fixResult.items) => items.reduce((total, item) => total + item[key], 0);
  assert.equal(state.fixResult.beforeSummary.total + sum('count', state.fixResult.items.filter((item) => item.isNew)), sum('fixed') + sum('pending'), '修复前 + 新出现 = 已修复 + 待人工');
  assert.equal(state.fixResult.afterSummary.total, sum('pending'));
  assert.equal(store.getFixedDocument()?.path, state.fixResult.outputPath);
  assert.equal(state.fixAiEnabled, false, '记住本次修复方式');
  assert.equal(state.fixResult.agent.reason, '本次选择仅程序修复');

  await store.importFile(writeDocx('第三份技术标.docx', ['第三份']));
  const replaced = store.loadBlindCheck();
  assert.equal(replaced.fixResult.status, 'idle');
  assert.equal(replaced.fixTask, undefined);
  assert.equal(store.getFixedDocument(), null);
  assert.ok(!fs.existsSync(state.fixResult.outputPath), '换文件后删除旧修复副本');
  await assert.rejects(runBlindCheckFixTask({
    workspaceStore: store,
    openXmlHelperService: helper,
    updateTask: () => undefined,
    checkpointTask,
    taskControl: { signal: new AbortController().signal },
  }), /请先完成当前文件和格式预设的检查/);
});

/**
 * 假 Agent：按阶段生成复核结果或处理结果，走真实的提交校验和业务工具，持久会话状态放在内存里。
 * 用来验证程序初筛 → AI 复核 → 程序修复 → AI 修复 → 逐条对账的完整接线，不调用模型。
 */
function createFakeAgentService({ review, fix }) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), '暗标复核Agent-'));
  const persistent = { exists: false, state: {} };
  const stages = [];
  return {
    stages,
    async runTask(payload) {
      stages.push(payload.initial_stage);
      if (payload.persistent_task.mode === 'create') {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        fs.mkdirSync(workspaceDir, { recursive: true });
        persistent.exists = true;
        persistent.state = { run_id: payload.task_id, session_file: 'session.jsonl' };
      } else {
        assert.equal(persistent.state.run_id, payload.task_id, '续接前已对齐持久任务的 run_id');
      }
      for (const file of payload.files || []) fs.writeFileSync(path.join(workspaceDir, file.path), file.content, 'utf8');
      const build = payload.initial_stage === 'blind-check-review' ? review : fix;
      const output = await build({ payload, workspaceDir, read: (name) => fs.readFileSync(path.join(workspaceDir, name), 'utf8') });
      const report = await payload.validateOutput({ output_content: JSON.stringify(output) });
      if (report.issues.length) throw new Error(report.issues.map((issue) => issue.message).join('；'));
      return { task_id: payload.task_id, validation_result: report.value, assistant_text: '' };
    },
    updatePersistentTask(_key, partial) {
      persistent.state = { ...persistent.state, ...partial };
      return { state: persistent.state };
    },
    hasPersistentTaskSession: () => persistent.exists,
    loadPersistentTask: () => (persistent.exists ? { paths: { workspaceDir }, state: persistent.state } : null),
    deletePersistentTask() {
      persistent.exists = false;
      persistent.state = {};
    },
    dispose: () => fs.rmSync(workspaceDir, { recursive: true, force: true }),
  };
}

/** 标书结构文本里第一个包含 text 的段落编号。 */
function locatorOf(dumpText, text) {
  return dumpText.split(/\r?\n/).find((line) => /^\[(p|t)\S*\] /.test(line) && line.includes(text))?.match(/^\[(\S+)\]/)[1];
}

test('AI 复核与 AI 修复：假 Agent 走完整流程，修复结果与检查结果逐条对应', async () => {
  const tender = '第五章 技术暗标编制要求：技术暗标中不得出现投标人名称、以往工程名称等可识别投标人身份的信息。';
  const preset = store.createExtractedPreset({
    tenderName: '某项目招标文件.pdf',
    profile: {},
    source: { version: 1, tenderName: '某项目招标文件.pdf', extractedAt: new Date().toISOString(), fields: {}, unspecified: [], manual: [], dropped: [], notes: '' },
    tenderContent: tender,
  });
  await store.importFile(writeDocx('AI 复核.docx', ['本项目由北京华夏建设有限公司实施，联系电话13812345678。', '本工程为某某泵站改造工程，工期45天。']));
  store.saveFixRules(['struct.doc_props']);
  const { Type } = await import('typebox');
  let sensitiveGroup;
  let failFix = false;
  const agentService = createFakeAgentService({
    async review({ payload, read }) {
      const dump = read('标书正文.txt');
      assert.match(read('招标文件.md'), /技术暗标编制要求/, '复核材料里有招标文件全文');
      const groups = JSON.parse(read('程序检查结果.json'));
      sensitiveGroup = groups.find((group) => group.message === '出现敏感词「北京华夏建设有限公司」');
      assert.ok(sensitiveGroup?.items[0]?.target, '程序问题带段落编号');
      const target = locatorOf(dump, '某某泵站改造工程');
      const good = {
        summary: '标书写成了其他工程，且出现投标人名称。',
        clauses: [{ id: 'c1', requirement: '不得出现可识别投标人身份的信息', basis: '技术暗标中不得出现投标人名称、以往工程名称等可识别投标人身份的信息', status: 'fail', explanation: '出现投标人名称和其他工程名称', issues: [sensitiveGroup.id, 'a1'] }],
        candidates: groups.filter((group) => group.candidate).map((group) => ({ id: group.id, verdict: 'not_problem', reason: '第三方单位' })),
        issues: [{ id: 'a1', title: '写成了其他工程', severity: 'high', category: 'privacy', basis: '以往工程名称等可识别投标人身份的信息', detail: '工程名称与招标项目不符', suggestion: '改为本工程', locations: [{ target, text: '某某泵站改造工程' }] }],
      };
      const bad = { ...good, clauses: [{ ...good.clauses[0], basis: '招标文件里没有的一句话要求' }], issues: [{ ...good.issues[0], locations: [{ target, text: '标书里没有的文字' }] }] };
      const rejected = await payload.validateOutput({ output_content: JSON.stringify(bad) });
      assert.ok(rejected.issues.some((issue) => /招标文件中找不到/.test(issue.message)), '编造的招标依据被退回');
      assert.ok(rejected.issues.some((issue) => /找不到.*请逐字摘录标书原文/.test(issue.message)), '编造的标书摘录被退回');
      return good;
    },
    async fix({ payload, workspaceDir, read }) {
      const openItems = JSON.parse(read('待处理问题.json'));
      assert.ok(openItems.some((item) => item.id === 'a1') && openItems.some((item) => item.id === sensitiveGroup.id));
      const dump = read('修复后标书正文.txt');
      const tools = payload.create_tools({ Type, workspaceDir });
      const edit = tools.find((tool) => tool.name === 'apply-edits');
      const result = await edit.execute('call-1', {
        edits: [
          { issue: 'a1', op: 'replace', target: locatorOf(dump, '某某泵站改造工程'), find: '某某泵站改造工程', replace: '本工程' },
          { issue: sensitiveGroup.id, op: 'replace', target: locatorOf(dump, '北京华夏建设有限公司'), find: '北京华夏建设有限公司', replace: '投标人' },
          { issue: 'a1', op: 'replace', target: 'p99', find: '不存在', replace: '' },
        ],
      });
      assert.equal(result.details.applied, 2, JSON.stringify(result.details));
      if (failFix) throw new Error('模型请求失败：连接超时');
      assert.match(result.details.results[2].message, /找不到段落 p99/);
      assert.match(read('修复后标书正文.txt'), /本工程为本工程/, '编辑后更新标书结构');
      const recheck = await tools.find((tool) => tool.name === 'recheck').execute('call-2', {});
      assert.deepEqual(recheck.details.newProblems, [], '修改没有引入新问题');
      return {
        summary: '已删除投标人名称和其他工程名称，联系电话留给人工。',
        items: openItems.map((item) => (item.id === 'a1' || item.id === sensitiveGroup.id
          ? { id: item.id, action: 'fixed', reason: '', suggestion: '' }
          : { id: item.id, action: 'manual', reason: '需要投标人确认是否保留', suggestion: '删除联系电话' })),
        clauses: [{ id: 'c1', status: 'pass', explanation: '已删除' }],
      };
    },
  });
  const taskControl = { signal: new AbortController().signal };
  const checkpoints = (type) => (taskPatch, workspacePatch = {}) => {
    const task = { task_id: `${type}-1`, type, started_at: new Date().toISOString(), updated_at: new Date().toISOString(), logs: [], ...taskPatch };
    store.updateBlindCheckWithoutReload({ ...workspacePatch, [type === 'blind-check-run' ? 'checkTask' : 'fixTask']: task });
    return { task };
  };
  try {
    await runBlindCheckTask({ agentService, aiService: {}, workspaceStore: store, openXmlHelperService: helper, updateTask: () => undefined, checkpointTask: checkpoints('blind-check-run'), payload: { aiReview: true }, taskControl });
    const checked = store.loadBlindCheck();
    assert.equal(checked.review.status, 'success', checked.review.error);
    assert.equal(checked.review.inputSignature, checked.result.inputSignature);
    assert.equal(checked.review.review.issues[0].id, 'a1');
    assert.equal(checked.review.review.hasTender, true);
    const candidateTotal = checked.result.groups.filter((group) => group.candidate).reduce((total, group) => total + group.count, 0);
    assert.equal(issueSummary(checked.issues).total, checked.result.summary.total - candidateTotal + 1, '判为不是问题的候选不计，AI 补充的问题计入');
    assert.ok(checked.issues.every((issue) => issue.ruleId === '' || !checked.result.groups.find((group) => group.id === issue.id)?.candidate), '整组判为不是问题的候选不出现在清单里');
    assert.ok(checked.issues.find((issue) => issue.id === sensitiveGroup.id).requirements.some((item) => /技术暗标中不得出现投标人名称/.test(item.text)), '不符合的条款挂到关联问题上');

    await runBlindCheckFixTask({ agentService, aiService: {}, workspaceStore: store, openXmlHelperService: helper, updateTask: () => undefined, checkpointTask: checkpoints('blind-check-fix'), payload: { ai: true }, taskControl });
    assert.deepEqual(agentService.stages, ['blind-check-review', 'blind-check-fix'], '检查和修复共用同一个持久会话');
    const fixed = store.loadBlindCheck().fixResult;
    assert.equal(fixed.status, 'success', fixed.error);
    assert.equal(fixed.agent.status, 'success');
    const byId = Object.fromEntries(fixed.items.map((item) => [item.id, item]));
    const scope = fixScope(checked.issues, { fixRules: ['struct.doc_props'], fixableRules: new Set(FIX_RULE_IDS), ai: true });
    assert.deepEqual(fixed.items.filter((item) => !item.isNew).map((item) => item.id), scope.map((issue) => issue.id), '选了 AI 修复时，范围是开着的修复项覆盖的问题加上没有修复项覆盖的问题，关掉的修复项不进入');
    assert.deepEqual([byId.a1.fixed, byId.a1.pending], [1, 0]);
    assert.deepEqual([byId[sensitiveGroup.id].pending, byId[sensitiveGroup.id].edits[0].after.includes('投标人')], [0, true], '修改前后文字随结果保存');
    const phone = fixed.items.find((item) => item.message === '出现敏感词「13812345678」');
    assert.deepEqual([phone.pending > 0, phone.reason, phone.suggestion], [true, '需要投标人确认是否保留', '删除联系电话']);
    assert.ok(fixed.items.every((item) => !item.isNew), '修改没有引入新问题');
    const xml = new AdmZip(fixed.outputPath).readAsText('word/document.xml');
    assert.ok(!xml.includes('北京华夏建设有限公司') && xml.includes('本工程为本工程'), '修复副本里已改掉');
    const fixedSum = fixed.items.reduce((sum, item) => sum + item.fixed, 0);
    assert.ok(scope.length < checked.issues.length, '关掉的修复项覆盖的问题确实被排除');
    assert.deepEqual(fixed.beforeSummary, issueSummary(scope));
    assert.equal(fixed.beforeSummary.total, fixedSum + fixed.afterSummary.total, '修复前 = 已修复 + 待人工');

    // AI 修复改到一半失败：已执行的修改留在副本里，按副本实际状态对账，修改记录照常保存。
    failFix = true;
    await runBlindCheckFixTask({ agentService, aiService: {}, workspaceStore: store, openXmlHelperService: helper, updateTask: () => undefined, checkpointTask: checkpoints('blind-check-fix'), payload: { ai: true }, taskControl });
    const failed = store.loadBlindCheck().fixResult;
    assert.equal(failed.status, 'success', failed.error);
    assert.deepEqual([failed.agent.status, failed.agent.error], ['error', '模型请求失败：连接超时']);
    const failedById = Object.fromEntries(failed.items.map((item) => [item.id, item]));
    assert.deepEqual([failedById.a1.fixed, failedById.a1.pending, failedById.a1.edits.length], [1, 0, 1], 'AI 补充的问题按副本正文核对，已改掉的不算待人工');
    assert.equal(failedById[sensitiveGroup.id].pending, 0);
    assert.equal(failed.items.find((item) => item.message === '出现敏感词「13812345678」').reason, '自动修复未完成：模型请求失败：连接超时');
  } finally {
    agentService.dispose();
    store.deletePreset(preset.id);
    store.setAiReviewEnabled(false);
  }
});

test('换文件或移除文件时，与待检文档无关的 AI 提取任务保持不变', async () => {
  store.updateBlindCheckWithoutReload({
    extractionTask: { task_id: 'extract-1', type: 'blind-check-preset-extraction', status: 'running', started_at: new Date().toISOString(), updated_at: new Date().toISOString(), logs: [] },
  });
  assert.equal(store.loadBlindCheck().extractionTask?.status, 'running');
  await store.importFile(writeDocx('第四份技术标.docx', ['第四份']), { beforeCommit: async () => {} });
  assert.equal(store.loadBlindCheck().extractionTask?.task_id, 'extract-1', '换文件后保留提取任务');
  await store.removeFile({ beforeCommit: async () => {} });
  assert.equal(store.loadBlindCheck().extractionTask?.task_id, 'extract-1', '移除文件后保留提取任务');
  store.updateBlindCheckWithoutReload({ extractionTask: undefined });
});

test('移除文档与重置：清空结果和副本，保留用户预设', async () => {
  const preset = store.createPreset({ name: '保留的预设', basePresetId: 'builtin-general' });
  const removed = await store.removeFile();
  assert.equal(removed.file, null);
  assert.equal(removed.result.status, 'idle');
  store.clearBlindCheck();
  assert.ok(store.listPresets().some((item) => item.id === preset.id));
  assert.deepEqual(fs.readdirSync(path.join(userData, 'workspace', 'blind-check', 'source')), []);
});
