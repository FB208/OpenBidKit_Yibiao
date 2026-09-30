const assert = require('node:assert/strict');
const fs = require('node:fs');
const { NATIVE_AGENT_TOOLS } = require('../electron/services/agent/agentToolEnvironment.cjs');
const os = require('node:os');
const path = require('node:path');
const { buildContentGenerationFiles, runContentGenerationAgent } = require('../electron/services/contentGenerationAgent.cjs');
const { CONSISTENCY_TOOLS, LEDGER_FILE, LEDGER_JSON, extractConsistencyLedger, sectionAuditText } = require('../electron/services/contentGenerationConsistencyTools.cjs');
const { AI_QUEUE_SCOPE_PAUSED, createQueueScopePausedError } = require('../electron/utils/aiRequestQueue.cjs');
const { AI_UPSTREAM_UNAVAILABLE } = require('../electron/utils/aiBatchGuard.cjs');
const { markAiRequestError } = require('../electron/utils/aiRetry.cjs');
const { taskFilePath } = require('../electron/services/contentGenerationTaskFiles.cjs');
const { editContentSections } = require('../electron/services/contentGenerationEditTools.cjs');
const { createPiSession } = require('../electron/services/pi/piSessionFactory.cjs');

// 使用真实输入与业务工具，只模拟小节核对模型和主 Agent 的决策，修复子任务执行真实 Pi 原生 edit。
async function check() {
  const { Type } = await import('typebox');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '正文一致性-'));
  const workspaceDir = path.join(root, '中文工作区');
  const targets = ['one', 'two'].map((id, index) => ({ item: { id, number: `1.${index + 1}`, title: `小节${index + 1}`, content_mode: 'ai-generate' } }));
  const files = buildContentGenerationFiles({ outline: targets.map(target => target.item), targets, plans: {},
    projectOverview: '工期六十天', globalFacts: [{ title: '工期', content: '六十天' }], globalFactsMode: 'placeholder',
    wordControl: {}, generationOptions: { imageQuantity: 0 }, template: { config: {} }, documentIds: [],
  });
  const figure = '<figure id="图" data-yb-generation="aiImage" data-yb-size="wide"><template data-yb-role="prompt">保留原图的生图提示词</template><img alt="图" data-yb-asset-ref="图片/原图.png"><figcaption>现场</figcaption></figure>';
  const sectionHtml = id => `<!-- yibiao:block -->\n<p id="${id}_p1">仅属于${id}的材料，工期六十天。</p>\n<!-- yibiao:block -->\n<ol id="${id}_ol1"><li>进场</li><li>验收</li></ol>\n<!-- yibiao:block -->\n<table id="${id}_t1"><caption>参数表</caption><tr><th>项目</th><th>数值</th></tr><tr><td>工期</td><td>60天</td></tr></table>\n<!-- yibiao:block -->\n${figure.replace('id="图"', `id="${id}_fig1"`)}\n<!-- yibiao:block -->\n<p id='${id}_sq'>单引号编号段落</p>\n<!-- yibiao:block -->\n<p>缺少编号段落</p>`;
  let savedState;
  let action;
  let childAction;
  let activeTools;
  let failExtract = new Set();
  let referenceIssue = false;
  // 只在需要核对台账登记的场景提供 baseline，其余场景沿用无登记的调用方式。
  let baseline;
  const baselineGroups = {};
  const progress = [];
  const activities = [];
  const warmups = [];
  const requests = [];
  const pause = new Error('模拟暂停');
  const ledgerJson = path.join(workspaceDir, '正文一致性事实台账.json');
  const readLedger = () => fs.readFileSync(path.join(workspaceDir, LEDGER_FILE), 'utf8');

  // 各场景共用相同的最小文件输入，避免依赖用户数据库或外部模型。
  function reset() {
    savedState = {};
    baseline = undefined;
    for (const key of Object.keys(baselineGroups)) delete baselineGroups[key];
    requests.length = 0;
    warmups.length = 0;
    failExtract = new Set();
    for (const file of files) {
      const destination = path.join(workspaceDir, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.content, 'utf8');
    }
    for (const file of ['正文一致性事实台账.json', LEDGER_FILE]) fs.rmSync(path.join(workspaceDir, file), { force: true });
    fs.mkdirSync(path.join(workspaceDir, '图片'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '图片/原图.png'), Buffer.from([1]));
    fs.mkdirSync(path.join(workspaceDir, '正文'), { recursive: true });
    for (const { item } of targets) fs.writeFileSync(path.join(workspaceDir, `正文/${item.id}.html`), sectionHtml(item.id), 'utf8');
    fs.writeFileSync(path.join(workspaceDir, '正文生成结果.json'), JSON.stringify({ sections: targets.map(({ item }) => ({ section_id: item.id, file: `正文/${item.id}.html`, words: 8 })) }), 'utf8');
  }
  // 核对模型返回带方括号的段落 ID，验证程序的输出边界规整与校验。
  const aiService = {
    async chat(request) { warmups.push(request); return ''; },
    async requestJson(request) {
      requests.push(request);
      const id = request.logTitle.includes('小节1') ? 'one' : 'two';
      if (failExtract.has(id)) throw new Error(`模拟${id}核对失败`);
      const output = request.normalizer(id === 'one'
        ? { issues: referenceIssue ? [{ block_id: 'one_p1', type: '小节内部矛盾', problem: '参考小节的问题不进入本轮', evidence: '', suggestion: '' }] : [], facts: [{ category: '日期与期限', subject: '工期', value: '六十天', block_id: '[one_p1]', quote: '工期六十天' }] }
        : { issues: [{ block_id: 'two_t1', type: '与全局事实冲突', problem: '表格工期写成60天以外的口径', evidence: '全局事实：工期六十天', suggestion: '统一为六十天' }],
          facts: [{ category: '日期与期限', subject: '工期', value: '60天', block_id: 'two_t1', quote: '工期 | 60天' }, { category: '人数与数量', subject: '项目负责人', value: '1名', block_id: '', quote: '' }] });
      request.validator(output);
      return output;
    },
  };
  const service = {
    hasPersistentTaskSession: () => true,
    loadPersistentTask: () => ({ state: savedState, paths: { workspaceDir } }),
    updatePersistentTask(_key, partial) { savedState = { ...savedState, ...structuredClone(partial) }; },
    async runTask(payload) {
      if (!payload.primary_session) return childAction(payload);
      const tools = payload.create_tools({ Type, workspaceDir, baseline, setActiveTools: names => { activeTools = names; } });
      // 与 Runtime 一致：发送下一阶段提示词前等待与压缩并行的程序步骤。
      const handoff = async () => { payload.validateOutput({}, { workspace_dir: workspaceDir }); return payload.continueTask({}, { workspace_dir: workspaceDir }); };
      const next = async () => {
        const continuation = await handoff();
        await continuation?.await_before_prompt;
        return continuation;
      };
      const finish = (issues, extra = {}) => tools.find(tool => tool.name === 'complete-consistency-round').execute('finish', { summary: '检查了工期和跨节承诺', remaining_issues: issues, ...extra });
      await action({ payload, tools, next, handoff, finish });
      return { workspace_dir: workspaceDir };
    },
  };
  // 修复任务写入固定任务文件后无参数提交；工具在调用时同步读取文件。
  const submit = (tool, callId, params, ...rest) => {
    const target = path.join(workspaceDir, taskFilePath('repair'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(params), 'utf8');
    return tool.execute(callId, {}, ...rest);
  };
  const run = resume => runContentGenerationAgent({ agentService: service, aiService, signal: new AbortController().signal, resume,
    hasKnowledgeBase: false, buildFiles: () => files, onConsistencyProgress: state => progress.push(structuredClone(state)),
    onActivity: event => activities.push(event),
  });
  try {
    // 核对输入只保留段落 ID、正文、表格数据和图注，不含标签、注释、行号及图片提示词。
    const text = sectionAuditText(`${sectionHtml('one')}\r\n<!-- yibiao:block -->\r\n<table id="one_t2" data-yb-preset="imageText"><tr><td>${figure}</td><td>左图说明</td></tr></table>`);
    assert.match(text, /^\[one_p1\] 仅属于one的材料，工期六十天。$/m);
    assert.match(text, /^\[one_ol1\] 1\. 进场\n2\. 验收$/m);
    assert.match(text, /^\[one_t1\] 表：参数表\n项目 \| 数值\n工期 \| 60天$/m);
    assert.match(text, /^\[one_fig1\] \[图 one_fig1：现场\]$/m);
    assert.match(text, /^\[one_sq\] 单引号编号段落$/m);
    assert.match(text, /^\[第6块\] 缺少编号段落$/m);
    // 上下标和换行保留原意，不把 10³ 读成 103，也不让换行两侧文字粘连。
    const units = sectionAuditText('<p id="unit">风量≥30 m<sup>3</sup>/(h·人)，浓度10<sup>-6</sup>，CO<sub>2</sub>，指数x<sup>n+1</sup>，比较<sup>a&lt;b</sup>，甲方<br>乙方</p><table id="unit_t"><tr><td>值守<br/>2名</td><td>硬件<br>3名</td></tr></table>');
    assert.equal(units, '[unit] 风量≥30 m^3/(h·人)，浓度10^-6，CO_2，指数x^(n+1)，比较^(a<b)，甲方 乙方\n[unit_t] 值守 2名 | 硬件 3名');
    assert.match(text, /^\[one_t2\] \[图 图：现场\] \| 左图说明$/m);
    assert.doesNotMatch(text, /生图提示词|<|yibiao:block|L0000/);

    // 进入审计先并发核对各小节并生成台账，主 Agent 拿台账接手；少量小节可直接修改，结果在提交时校验。
    reset();
    action = async ({ payload, next, handoff, finish }) => {
      const start = await handoff();
      assert.equal(start.stage, 'auditing');
      assert.equal(start.compact_before_prompt, true);
      assert.ok(start.await_before_prompt instanceof Promise, '小节核对交给 Runtime 与压缩并行');
      assert.equal(savedState.consistency.status, 'extracting', '交接返回时核对仍在进行，不阻塞压缩');
      await start.await_before_prompt;
      assert.equal(requests.length, 2);
      assert.equal(warmups.length, 1, '多节核对前预热公共前缀');
      assert.equal(warmups[0].output_token_limit, 1);
      assert.equal(requests[0].messages[0].content, requests[1].messages[0].content, '核对 system 全轮相同');
      const shared = requests.map(request => request.messages[1].content.split('\n\n本节：')[0]);
      assert.equal(shared[0], shared[1], '公共材料在前，便于复用前缀缓存');
      assert.equal(shared[0], warmups[0].messages[1].content);
      assert.ok(requests.every(request => !/生图提示词|<p|yibiao:block/.test(request.messages[1].content)), '核对输入不含 HTML 和图片提示词');
      // 核对输入使用程序分配的段落编号，不暴露可能不规范的原始 ID。
      assert.ok(requests[0].messages[1].content.includes('本节正文（方括号内为段落编号）：\n[B1] 仅属于one的材料'));
      assert.ok(requests[0].messages[1].content.includes('[B6] 缺少编号段落'));
      assert.doesNotMatch(requests[0].messages[1].content, /\[one_p1\]|\[第6块\]/);
      assert.ok(!requests[0].messages[1].content.includes('仅属于two的材料'), '核对请求只含本节正文');
      // 只核对正文前后矛盾和与全局事实冲突：不提供项目概述、写作阶段事实处理要求，不追究依据、用词和承诺。
      const system = requests[0].messages[0].content;
      assert.ok(requests.every(request => request.messages[1].content.startsWith('全局事实设定（完整内容）：') && !request.messages[1].content.includes('项目概述')));
      assert.doesNotMatch(system, /事实缺失处理方式|无依据设定|无依据引用|项目概述/);
      assert.match(system, /只关注两类问题：正文前后矛盾，以及正文与全局事实设定冲突/);
      assert.match(system, /用词、称谓、表述不同或详略不同/);
      assert.match(system, /承诺语气强弱/);
      assert.match(system, /不追究内容是否有材料依据/);
      assert.throws(() => requests[0].validator({ issues: [{ block_id: '', type: '无依据设定', problem: '新增岗位', evidence: '', suggestion: '' }], facts: [] }), /合法 type/);
      assert.throws(() => requests[0].validator({ issues: [], facts: [{ category: '职责分工', subject: '值守', value: '负责值守', block_id: '', quote: '' }] }), /合法 category/);
      // 段落编号换回真实 ID（含单引号 id 和程序补的块序号），本节真实 ID 与块内图片 id 原样保留，改写、越界或他节的编号置空，不作为失败。
      const normalized = requests[0].normalizer({ issues: [{ block_id: '[B6]', type: '小节内部矛盾', problem: '前后不一致', evidence: '', suggestion: '' }],
        facts: [{ category: '其他', subject: '列表', value: '两项', block_id: 'B2', quote: '' }, { category: '其他', subject: '单引号段落', value: '已编号', block_id: 'B5', quote: '' },
          { category: '其他', subject: '图片', value: '现场', block_id: 'one_fig1', quote: '' }, { category: '其他', subject: '改写编号', value: '无', block_id: 's_1_1_ol001', quote: '' },
          { category: '其他', subject: '越界编号', value: '无', block_id: 'B99', quote: '' }, { category: '其他', subject: '他节 ID', value: '无', block_id: 'two_p1', quote: '' }] });
      assert.deepEqual(normalized.issues.map(issue => issue.block_id), ['第6块']);
      assert.deepEqual(normalized.facts.map(fact => fact.block_id), ['one_ol1', 'one_sq', 'one_fig1', '', '', '']);
      requests[0].validator(normalized);
      assert.throws(() => requests[0].validator({ issues: [{ block_id: '', type: '润色建议', problem: '文风', evidence: '', suggestion: '' }], facts: [] }), /合法 type/);
      const ledger = readLedger();
      assert.ok(ledger.indexOf('1.1 小节1｜小节 ID：one｜文件：正文/one.html') < ledger.indexOf('1.2 小节2'));
      assert.match(ledger, /小节核对发现的问题（共 1 项）\n1\. \[1\.2 小节2｜two｜two_t1\] 与全局事实冲突：/);
      assert.match(ledger, /### 日期与期限\n- 工期：六十天 —— 1\.1 \[one_p1\]“工期六十天”\n- 工期：60天 —— 1\.2 \[two_t1\]/);
      assert.match(ledger, /### 人数与数量\n- 项目负责人：1名 —— 1\.2 \[未定位\]/);
      assert.doesNotMatch(ledger, /参考|本轮目标\]/, '全文生成时没有参考小节标注');
      assert.doesNotMatch(ledger, /核对失败的小节/, '全部核对成功时不列失败小节');
      assert.equal(savedState.consistency.status, 'running');
      assert.equal(savedState.consistency.extract_completed, 2);
      assert.ok(progress.some(state => state.status === 'extracting'));
      assert.match(start.prompt, /正文一致性事实台账\.md/);
      assert.match(start.prompt, /一次完成审计和修复，不分轮次/);
      assert.match(start.prompt, /需要修改的小节超过 5 个时通过 repair-sections 并发修复；5 个及以下可以直接修改对应小节文件/);
      assert.match(start.prompt, /提交时程序逐节核对，不一致会退回并附上原始图片块/);
      assert.match(start.prompt, /将需要修改的小节写入 任务\/一致性修复\.json/);
      assert.match(start.prompt, /可按类别分段读取，但须覆盖其中全部问题和全部类别的事实/);
      assert.match(start.prompt, /台账列出“核对失败的小节”时.*先调用 recheck-sections 重新核对.*manually_checked_section_ids 中列出/);
      assert.doesNotMatch(start.prompt, /调用一次 repair-sections|同时发出多个|完整阅读全局事实设定.md和该台账/);
      assert.doesNotMatch(start.prompt, /事实缺失处理方式|以“【待填写】”标记/, '审计不套用写作阶段的事实处理要求');
      assert.match(start.prompt, /只处理两类问题：正文前后矛盾/);
      assert.match(start.prompt, /由你选定一个合理取值/);
      assert.match(start.prompt, /不撤回或削弱承诺/);
      assert.match(start.prompt, /服务期统一为一年/);
      assert.doesNotMatch(start.prompt, /称谓、频次或数量口径|本轮为新增小节审计/);
      assert.doesNotMatch(start.prompt, /知识库/);
      assert.deepEqual(activeTools, CONSISTENCY_TOOLS);
      assert.ok(activeTools.includes('bash'));
      payload.before_tool_call({ toolCall: { name: 'bash' }, args: { command: 'pwd' } });
      for (const name of ['check-word-count', 'adjust-sections', 'generate-sections']) {
        assert.equal(activeTools.includes(name), false);
        assert.throws(() => payload.before_tool_call({ toolCall: { name }, args: { path: '正文/one.html' } }), /正文编辑期间不能|当前阶段仅统计字数/);
      }
      // 文件修改不在写入时拦截：主 Agent 可直接修改少量小节，也可写修复任务文件。
      for (const name of ['edit', 'write']) {
        payload.before_tool_call({ toolCall: { name }, args: { path: '正文/one.html' } });
        payload.before_tool_call({ toolCall: { name }, args: { path: '任务/一致性修复.json' } });
      }
      assert.equal(Object.hasOwn(payload, 'before_file_write'), false);
      const repeated = await next();
      assert.equal(repeated.stage, 'auditing', '未提交结论不能跳过审计');
      assert.equal(repeated.prompt, '继续之前的任务', '运行中提前结束只续接原任务，不重发审计要求');
      await finish(['采购人未明确驻场人员总数与岗位配置的对应关系']);
      assert.throws(() => payload.before_tool_call({ toolCall: { name: 'repair-sections' }, args: {} }), /结论已经提交/);
      assert.equal((await next()).complete, true, '提交结论后直接结束，不开下一轮');
    };
    await run(false);
    assert.equal(savedState.consistency.status, 'completed');
    assert.deepEqual(savedState.consistency.remaining_issues, ['采购人未明确驻场人员总数与岗位配置的对应关系']);
    assert.equal(requests.length, 2, '遗留问题不触发重新核对');
    action = async ({ payload, next }) => {
      assert.match(payload.prompt, /已经结束/);
      assert.equal((await next()).complete, true);
    };
    await run(true);
    assert.equal(requests.length, 2, '已完成的审计恢复时不再核对');

    // 个别小节核对失败不中断审计：失败原因写入台账交给主 Agent，未处理时不能提交；恢复时只补核对失败的小节。
    reset();
    failExtract = new Set(['two']);
    action = async ({ next, finish }) => {
      const start = await next();
      assert.equal(start.stage, 'auditing');
      assert.equal(savedState.consistency.status, 'running', '核对失败的小节交给主 Agent，不中断审计');
      const stored = JSON.parse(fs.readFileSync(ledgerJson, 'utf8'));
      assert.deepEqual(Object.keys(stored.sections), ['one']);
      assert.deepEqual(stored.failures, { two: '模拟two核对失败' });
      assert.match(readLedger(), /## 核对失败的小节（共 1 节，其问题和事实未列入本台账）\n先调用 recheck-sections 重新核对[^\n]*manually_checked_section_ids 中列出。\n- 1\.2 小节2｜小节 ID：two｜文件：正文\/two\.html｜原因：模拟two核对失败/);
      assert.match(readLedger(), /小节核对发现的问题（共 0 项）/);
      assert.ok(progress.some(state => state.status === 'running'));
      await assert.rejects(finish([]), /以下小节尚无核对结果：1\.2 小节2（two）。先调用 recheck-sections 重新核对/);
      throw pause;
    };
    await assert.rejects(run(false), error => error === pause);
    failExtract = new Set();
    requests.length = 0;
    warmups.length = 0;
    action = async ({ payload }) => {
      assert.equal(payload.initial_stage, 'auditing');
      assert.equal(payload.files.length, 0);
      assert.deepEqual(requests.map(request => request.logTitle), ['一致性核对-1.2-小节2'], '恢复只核对失败的小节');
      assert.equal(warmups.length, 0, '单节核对不预热');
      assert.equal(savedState.consistency.status, 'running');
      assert.match(readLedger(), /小节核对发现的问题（共 1 项）/);
      assert.doesNotMatch(readLedger(), /核对失败的小节/);
      assert.deepEqual(JSON.parse(fs.readFileSync(ledgerJson, 'utf8')).failures, {});
      assert.match(payload.prompt, /正文一致性事实台账\.md/);
      throw pause;
    };
    await assert.rejects(run(true), error => error === pause);
    requests.length = 0;
    action = async ({ finish, next }) => {
      assert.equal(requests.length, 0, '比对阶段恢复不重复核对');
      await finish([]);
      assert.equal((await next()).complete, true);
    };
    await run(true);

    // 主 Agent 重新核对：仍失败时返回原因，可自行核对后在提交时列出；已有结果和范围外的小节不执行，并刷新台账登记。
    reset();
    baseline = { setGroup(name, files) { baselineGroups[name] = [...files]; }, release() {}, saveRecord() {}, loadRecord() {} };
    failExtract = new Set(['two']);
    action = async ({ next, tools, finish }) => {
      await next();
      const recheck = tools.find(tool => tool.name === 'recheck-sections');
      requests.length = 0;
      delete baselineGroups['consistency-ledger'];
      const failed = (await recheck.execute('recheck', { section_ids: ['two', 'one', 'missing'] })).details;
      assert.equal(failed.total, 3);
      assert.equal(failed.success, 0);
      assert.deepEqual(failed.unresolved.map(item => item.section_id), ['two', 'one', 'missing']);
      assert.equal(failed.unresolved[0].error, '模拟two核对失败');
      assert.match(failed.unresolved[1].error, /已有核对结果/);
      assert.match(failed.unresolved[2].error, /不属于审计范围/);
      assert.deepEqual(requests.map(request => request.logTitle), ['一致性核对-1.2-小节2'], '只重新核对失败的小节');
      assert.deepEqual(baselineGroups['consistency-ledger'], [LEDGER_JSON, LEDGER_FILE], '程序改写台账后重新登记');
      await finish([], { manually_checked_section_ids: ['two', 'one'] });
    };
    await run(false);
    assert.equal(savedState.consistency.status, 'completed');
    assert.deepEqual(savedState.consistency.manually_checked_section_ids, ['two'], '只记录确实未核对成功的小节');

    reset();
    baseline = { setGroup(name, files) { baselineGroups[name] = [...files]; }, release() {}, saveRecord() {}, loadRecord() {} };
    failExtract = new Set(['two']);
    action = async ({ next, tools, finish }) => {
      await next();
      failExtract = new Set();
      const passed = (await tools.find(tool => tool.name === 'recheck-sections').execute('recheck', { section_ids: ['two'] })).details;
      assert.deepEqual(passed, { total: 1, success: 1, unresolved: [] });
      const stored = JSON.parse(fs.readFileSync(ledgerJson, 'utf8'));
      assert.deepEqual(Object.keys(stored.sections).sort(), ['one', 'two']);
      assert.deepEqual(stored.failures, {});
      assert.doesNotMatch(readLedger(), /核对失败的小节/);
      assert.match(readLedger(), /1\. \[1\.2 小节2｜two｜two_t1\] 与全局事实冲突/);
      await finish([]);
    };
    await run(false);
    assert.equal(savedState.consistency.status, 'completed');
    assert.equal(savedState.consistency.manually_checked_section_ids, undefined);

    // 检索只在目标小节纯文本中匹配，不命中图片提示词，并返回段落 ID。
    reset();
    fs.writeFileSync(path.join(workspaceDir, '正文/outside.html'), '<p id="x">工期六十天</p>', 'utf8');
    action = async ({ next, tools, finish }) => {
      await next();
      const search = tools.find(tool => tool.name === 'search-sections');
      const found = (await search.execute('search', { keywords: ['工期', '不存在'] })).details;
      assert.equal(found.total, 4);
      assert.equal(found.truncated, false);
      assert.deepEqual(found.matches.map(match => `${match.section_id}/${match.block_id}`), ['one/one_p1', 'one/one_t1', 'two/two_p1', 'two/two_t1']);
      assert.equal((await search.execute('prompt', { keywords: ['生图提示词'] })).details.total, 0);
      assert.equal((await search.execute('scope', { keywords: ['验收'], section_ids: ['two'] })).details.matches[0].section_id, 'two');
      await finish([]);
    };
    await run(false);

    // 并发修复：真实原生 edit、图片保护、失败登记与重试，并返回改动段落前后文本。
    reset();
    const repairContents = new Map(targets.map(({ item }) => {
      const html = `<!-- yibiao:block -->\r\n<p id="${item.id}_p1">仅属于${item.id}的小节材料${'完整正文😀'.repeat(1000)}</p>\r\n<!-- yibiao:block -->\r\n<p id="${item.id}_p2">工期六十天</p><table id="${item.id}_t1"><tr><td>参数</td><td>六十天</td></tr></table>${figure}`;
      fs.writeFileSync(path.join(workspaceDir, `正文/${item.id}.html`), html, 'utf8');
      return [`正文/${item.id}.html`, html];
    }));
    let started = 0;
    let release;
    let bothStarted;
    const gate = new Promise(resolve => { release = resolve; });
    const startedGate = new Promise(resolve => { bothStarted = resolve; });
    let failOne = true;
    const batchPrompts = [];
    childAction = async payload => {
      started++;
      if (failOne) batchPrompts.push(payload.prompt);
      if (started === 2) bothStarted();
      await gate;
      assert.equal(payload.failure_handled_by_parent, true);
      assert.equal(payload.workspace_dir, workspaceDir);
      assert.deepEqual(payload.active_tools, [...NATIVE_AGENT_TOOLS, 'report-failure']);
      payload.before_tool_call({ toolCall: { name: 'bash' }, args: { command: 'pwd' } });
      assert.equal(payload.summary_enabled, false);
      assert.match(payload.prompt, /优先使用已提供的正文和规范直接修改，通常无需重复读取/);
      assert.match(payload.prompt, /段落 ID 只用于定位/);
      assert.match(payload.prompt, /只改与矛盾直接相关的数值或陈述，其他用词、称谓和表述保持原样/);
      assert.ok(payload.prompt.includes(fs.readFileSync(path.join(workspaceDir, '受限HTML生成规范.md'), 'utf8')));
      assert.ok(payload.prompt.endsWith(repairContents.get(payload.output_file)), '输入必须包含本节完整原文，保留换行、表格和图片');
      const otherId = payload.output_file.endsWith('one.html') ? 'two' : 'one';
      assert.ok(!payload.prompt.includes(`仅属于${otherId}的小节材料`), '不注入其他小节正文');
      if (!failOne) assert.match(payload.prompt, /失败后重新派发前的最新内容/);
      assert.match(payload.prompt, /只修复主 Agent 指定的矛盾/);
      if (failOne && payload.output_file.endsWith('one.html')) throw new Error('模拟可恢复子任务失败');
      const created = await createPiSession({ workspaceDir, environment: { shellPath: process.env.ComSpec, layout: { agentDir: path.join(root, 'agent') }, instructions: '测试原生编辑', env: {} },
        config: {}, timeoutMs: 60000, summaryEnabled: false, proxyInfo: { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        activeTools: payload.active_tools, beforeToolCall: payload.before_tool_call,
      });
      try {
        const edit = created.session.agent.state.tools.find(tool => tool.name === 'edit');
        const sectionPath = path.join(workspaceDir, payload.output_file);
        const original = fs.readFileSync(sectionPath, 'utf8');
        // 删掉图片的修改照常写入，子任务提交时退回并附上派发时的原始图片块。
        await edit.execute('bad', { path: payload.output_file, edits: [{ oldText: figure, newText: '' }] });
        assert.throws(() => payload.validateOutput({ output_content: fs.readFileSync(sectionPath, 'utf8') }), /原始图片块 1/);
        fs.writeFileSync(sectionPath, original, 'utf8');
        await edit.execute('fix', { path: payload.output_file, edits: [{ oldText: '工期六十天', newText: '工期统一为六十天' }] });
        payload.validateOutput({ output_content: fs.readFileSync(path.join(workspaceDir, payload.output_file), 'utf8') });
      } finally { created.session.dispose(); }
      return {};
    };
    action = async ({ next, tools, finish }) => {
      await next();
      const repair = tools.find(tool => tool.name === 'repair-sections');
      const invalid = (await submit(repair, 'invalid', { sections: [{ section_id: 'outside', instructions: '修复' }] })).details.results;
      assert.match(invalid[0].error, /不属于本轮目标：outside.*原样复制/);
      assert.equal(started, 0, 'ID 错误的项不派发子任务');
      const batch = submit(repair, 'batch', { sections: targets.map(({ item }) => ({ section_id: item.id, instructions: '统一工期六十天' })) });
      await startedGate;
      await assert.rejects(finish([]), /等待全部/);
      release();
      const batchOutput = await batch;
      const results = batchOutput.details.results;
      assert.deepEqual(results.map(item => item.status), ['error', 'success']);
      assert.equal(results[0].changes, undefined, '失败小节不返回改动');
      assert.deepEqual(results[1].changes, [{ block_id: 'two_p2', before: '工期六十天', after: '工期统一为六十天' }], '只返回改动段落前后文本');
      // 模型只接收统计和未成功项，改动对比写入程序清单按需读取。
      assert.deepEqual(JSON.parse(batchOutput.content[0].text), { total: 2, success: 1, skipped: 0, unresolved: [results[0]], detail_file: '程序清单/一致性修复结果.json' });
      // 程序清单按小节累积本轮全部派发结果，此前未执行的错误 ID 项同样保留。
      const recorded = JSON.parse(fs.readFileSync(path.join(workspaceDir, '程序清单/一致性修复结果.json'), 'utf8'));
      assert.deepEqual(recorded.results, [...invalid, ...results]);
      assert.deepEqual(recorded.summary, { repaired: 1, failed: 2 });
      // 同批子会话共用规则和规范在前，小节身份与正文在“本次任务”之后，便于复用请求前缀缓存。
      const shared = batchPrompts.map(prompt => prompt.slice(0, prompt.indexOf('本次任务：')));
      assert.equal(batchPrompts.length, 2);
      assert.equal(shared[0], shared[1]);
      assert.ok(!targets.some(({ item }) => shared[0].includes(`正文/${item.id}.html`)), '公共段不含小节文件');
      await assert.rejects(finish([]), /修复任务未成功/);
      throw pause;
    };
    await assert.rejects(run(false), error => error === pause);
    assert.deepEqual(savedState.consistency.failed_sections, ['one']);
    assert.deepEqual(savedState.consistency.repaired_section_ids, ['two'], '已修复小节随持久状态保存');
    const sourceFile = path.join(workspaceDir, '正文/one.html');
    const latestHtml = `${repairContents.get('正文/one.html')}<p>失败后重新派发前的最新内容</p>`;
    fs.writeFileSync(sourceFile, latestHtml, 'utf8');
    repairContents.set('正文/one.html', latestHtml);
    failOne = false;
    requests.length = 0;
    activities.length = 0;
    // 审计要求已在原会话发出（Runtime 记录 prompted_stage），继续时只发送“继续之前的任务”。
    savedState = { ...savedState, prompted_stage: 'auditing' };
    const ledgerBefore = fs.readFileSync(ledgerJson, 'utf8');
    action = async ({ payload, next, tools, finish }) => {
      assert.equal(payload.prompt, '继续之前的任务');
      assert.equal(requests.length, 0, '修复阶段恢复不重复核对');
      assert.equal(activities.some(event => event.progress?.step === 'consistency-extract'), false, '比对修复中续跑不回到核对步骤');
      assert.equal(fs.readFileSync(ledgerJson, 'utf8'), ledgerBefore, '无缺失小节时不重写台账');
      await assert.rejects(finish([]), /修复任务未成功/);
      const result = await submit(tools.find(tool => tool.name === 'repair-sections'), 'retry', { sections: [{ section_id: 'one', instructions: '统一工期六十天' }] });
      assert.equal(result.details.results[0].status, 'success');
      assert.deepEqual(result.details.results[0].changes.map(change => change.block_id), ['one_p2']);
      const accumulated = JSON.parse(fs.readFileSync(path.join(workspaceDir, '程序清单/一致性修复结果.json'), 'utf8'));
      assert.deepEqual(accumulated.summary, { repaired: 2, failed: 1 }, '失败小节重试成功后按最新状态计入已修复');
      assert.deepEqual(accumulated.results.find(item => item.section_id === 'two').changes.map(change => change.block_id), ['two_p2'], '其他小节此前的改动保留');
      assert.equal(accumulated.results.find(item => item.section_id === 'one').status, 'success');
      await finish([]);
      assert.equal((await next()).complete, true);
    };
    await run(true);
    assert.equal(started, 3, '重试只重新派发失败小节');
    assert.deepEqual(savedState.consistency.repaired_section_ids, ['two', 'one']);

    // 批次输入边界与并发：错误 ID 不拖累同批并给出候选，同节要求合并，统一规则下发，不同批次并发且同一小节互斥。
    reset();
    const childPrompts = [];
    const childGates = new Map();
    let childFailures = new Set();
    const hold = id => {
      const entry = {};
      entry.wait = new Promise(resolve => { entry.release = resolve; });
      entry.startedPromise = new Promise(resolve => { entry.started = resolve; });
      childGates.set(id, entry);
      return entry;
    };
    childAction = async payload => {
      const id = decodeURIComponent(path.basename(payload.output_file, '.html'));
      childPrompts.push({ id, prompt: payload.prompt });
      const entry = childGates.get(id);
      if (entry) { entry.started(); await entry.wait; }
      if (childFailures.has(id)) throw new Error(`模拟${id}修复失败`);
      const file = path.join(workspaceDir, payload.output_file);
      if (payload.prompt.includes('改工期')) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('工期六十天', '工期统一为六十天'), 'utf8');
      return {};
    };
    action = async ({ next, tools, finish }) => {
      await next();
      const repair = tools.find(tool => tool.name === 'repair-sections');
      assert.equal(repair.executionMode, 'sequential', '修复任务来自固定任务文件，派发按顺序执行');
      assert.equal(tools.find(tool => tool.name === 'complete-consistency-round').executionMode, 'sequential');
      const mixed = (await submit(repair, 'mixed', { sections: [
        { section_id: 'two-typo', instructions: '改工期' },
        { section_id: 'one', instructions: '改工期' },
        { section_id: 'one', instructions: '补充说明依据' },
      ] })).details.results;
      assert.deepEqual(mixed.map(item => [item.section_id, item.status]), [['two-typo', 'error'], ['one', 'success']]);
      assert.match(mixed[0].error, /不属于本轮目标：two-typo.*1\.2 小节2（two）/);
      assert.deepEqual(mixed[1].changes, [{ block_id: 'one_p1', before: '仅属于one的材料，工期六十天。', after: '仅属于one的材料，工期统一为六十天。' }]);
      const merged = childPrompts.filter(item => item.id === 'one');
      assert.equal(merged.length, 1, '同一小节的多项要求合并为一个子任务');
      assert.match(merged[0].prompt, /改工期\n补充说明依据/);
      // 统一规则进入同批公共段；只需自查的小节收到自查要求，不修改也能成功结束。
      childPrompts.length = 0;
      const ruled = (await submit(repair, 'rules', { rules: '工期统一写作六十天', sections: [{ section_id: 'one', instructions: '' }, { section_id: 'two', instructions: '' }] })).details.results;
      assert.deepEqual(ruled.map(item => [item.status, item.changes.length]), [['success', 0], ['success', 0]]);
      const shared = childPrompts.map(item => item.prompt.slice(0, item.prompt.indexOf('本次任务：')));
      assert.equal(shared[0], shared[1]);
      assert.match(shared[0], /本批统一修复规则[\s\S]*工期统一写作六十天/);
      assert.ok(childPrompts.every(item => item.prompt.slice(item.prompt.indexOf('本次任务：')).includes('按本批统一修复规则在本节全文按语义自查')));
      assert.match((await submit(repair, 'empty', { sections: [{ section_id: 'one', instructions: ' ' }] })).details.results[0].error, /缺少修复要求/);
      // 不同批次并发执行；同一小节正在修复时逐项拒绝；失败登记基于最新状态，先结束的批次不覆盖其他批次。
      const holdOne = hold('one');
      const holdTwo = hold('two');
      childFailures = new Set(['one']);
      const first = submit(repair, 'first', { sections: [{ section_id: 'one', instructions: '改工期' }] });
      const second = submit(repair, 'second', { sections: [{ section_id: 'two', instructions: '改工期' }] });
      await Promise.all([holdOne.startedPromise, holdTwo.startedPromise]);
      assert.deepEqual([...savedState.consistency.failed_sections].sort(), ['one', 'two']);
      assert.match((await submit(repair, 'busy', { sections: [{ section_id: 'one', instructions: '改工期' }] })).details.results[0].error, /正在其他批次中修复/);
      await assert.rejects(finish([]), /等待全部/);
      holdTwo.release();
      assert.equal((await second).details.results[0].status, 'success');
      assert.deepEqual(savedState.consistency.failed_sections, ['one'], '先结束的批次只移除自己的成功小节');
      holdOne.release();
      assert.equal((await first).details.results[0].status, 'error');
      assert.deepEqual(savedState.consistency.failed_sections, ['one']);
      childGates.clear();
      childFailures = new Set();
      assert.equal((await submit(repair, 'retry', { sections: [{ section_id: 'one', instructions: '改工期' }] })).details.results[0].status, 'success');
      await finish([]);
    };
    await run(false);
    assert.equal(savedState.consistency.status, 'completed');

    // 新增小节审计：已完成小节作为只读参考参与核对和检索，问题不进入本轮，也不能被修复。
    reset();
    const decisionFile = path.join(workspaceDir, '正文编排决策.json');
    const incrementalDecisions = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
    incrementalDecisions.completed_sections = [{ id: 'one', number: '1.1', title: '小节1', file: '正文/one.html' }];
    incrementalDecisions.targets = incrementalDecisions.targets.filter(section => section.id === 'two');
    fs.writeFileSync(decisionFile, JSON.stringify(incrementalDecisions), 'utf8');
    fs.writeFileSync(path.join(workspaceDir, '正文生成结果.json'), JSON.stringify({ sections: [{ section_id: 'two', file: '正文/two.html', words: 8 }] }), 'utf8');
    referenceIssue = true;
    action = async ({ next, tools, finish }) => {
      const start = await next();
      assert.equal(requests.length, 2, '参考小节首次参与核对');
      assert.match(requests.find(request => request.logTitle.includes('小节1')).messages[1].content, /本节为已完成的参考小节：issues 返回空数组/);
      assert.doesNotMatch(requests.find(request => request.logTitle.includes('小节2')).messages[1].content, /参考小节/);
      const ledger = readLedger();
      assert.ok(ledger.includes('- [参考·只读] 1.1 小节1｜小节 ID：one'));
      assert.ok(ledger.indexOf('- [参考·只读] 1.1 小节1') < ledger.indexOf('- [本轮目标] 1.2 小节2'), '按目录顺序列出参考与目标小节');
      assert.match(ledger, /本轮目标小节核对发现的问题（共 1 项）\n1\. \[1\.2 小节2/);
      assert.doesNotMatch(ledger, /参考小节的问题不进入本轮/);
      assert.match(ledger, /- 工期：六十天 —— 1\.1（参考） \[one_p1\]/);
      assert.match(start.prompt, /本轮为新增小节审计/);
      assert.match(start.prompt, /只能提交本轮目标小节/);
      const found = (await tools.find(tool => tool.name === 'search-sections').execute('search', { keywords: ['工期六十天'] })).details.matches;
      assert.deepEqual(found.map(match => [match.section_id, match.reference === true]), [['one', true], ['two', false]]);
      const rejected = (await submit(tools.find(tool => tool.name === 'repair-sections'), 'reference', { sections: [{ section_id: 'one', instructions: '改工期' }] })).details.results[0];
      assert.match(rejected.error, /已完成的参考小节，本轮只修改新增小节/);
      await finish([]);
    };
    await run(false);
    // 再次审计：未变化的参考小节复用核对结果，正文变化的小节重新核对，台账版本变化时全部重新核对。
    const rerun = async () => {
      requests.length = 0;
      savedState = {};
      action = async ({ next, finish }) => { await next(); await finish([]); };
      await run(false);
      return requests.map(request => request.logTitle);
    };
    fs.appendFileSync(path.join(workspaceDir, '正文/two.html'), '\n<!-- yibiao:block -->\n<p id="two_new">新增内容</p>', 'utf8');
    assert.deepEqual(await rerun(), ['一致性核对-1.2-小节2'], '参考小节未变化时不重复核对');
    fs.appendFileSync(path.join(workspaceDir, '正文/one.html'), '\n<!-- yibiao:block -->\n<p id="one_new">参考小节已变化</p>', 'utf8');
    assert.deepEqual(await rerun(), ['一致性核对-1.1-小节1'], '参考小节正文变化后重新核对');
    const staleLedger = JSON.parse(fs.readFileSync(ledgerJson, 'utf8'));
    for (const entry of Object.values(staleLedger.sections)) entry.version = 1;
    fs.writeFileSync(ledgerJson, JSON.stringify(staleLedger), 'utf8');
    assert.equal((await rerun()).length, 2, '台账版本变化后全部重新核对');
    // 比对修复中恢复：修复改动正文后不重新核对，只补缺失小节。
    requests.length = 0;
    savedState = {};
    action = async ({ next }) => {
      await next();
      fs.appendFileSync(path.join(workspaceDir, '正文/two.html'), '\n<!-- yibiao:block -->\n<p id="two_fix">修复后内容</p>', 'utf8');
      throw pause;
    };
    await assert.rejects(run(false), error => error === pause);
    assert.equal(savedState.consistency.status, 'running');
    action = async ({ next, finish }) => {
      assert.equal(requests.length, 0, '比对修复中恢复不因正文变化重新核对');
      await finish([]);
      assert.equal((await next()).complete, true);
    };
    await run(true);
    referenceIssue = false;

    // 服务端连续失败时停止派发剩余小节并以真实原因报错，已完成的核对保留；暂停时队列丢弃的请求记为已中断并按暂停抛出。
    const bulkDir = path.join(root, '批量核对');
    const bulkSections = Array.from({ length: 12 }, (_, index) => ({ id: `s${index + 1}`, number: `2.${index + 1}`, title: `批量${index + 1}`, file: `正文/s${index + 1}.html` }));
    fs.mkdirSync(path.join(bulkDir, '正文'), { recursive: true });
    fs.writeFileSync(path.join(bulkDir, '正文编排决策.json'), JSON.stringify({ targets: bulkSections, completed_sections: [] }), 'utf8');
    fs.writeFileSync(path.join(bulkDir, '全局事实设定.md'), '工期六十天', 'utf8');
    for (const section of bulkSections) fs.writeFileSync(path.join(bulkDir, section.file), `<p id="${section.id}_p1">工期六十天</p>`, 'utf8');
    const bulkProgress = [];
    let bulkCalls = 0;
    const bulkAi = mode => ({
      async chat() { return ''; },
      requestJson(request) {
        bulkCalls += 1;
        if (mode === 'paused') return Promise.reject(createQueueScopePausedError());
        if (bulkCalls === 1) return Promise.resolve(request.normalizer({ issues: [], facts: [] }));
        if (bulkCalls <= 11) return Promise.reject(markAiRequestError(new Error('AI请求结算失败，请求已结束'), { retryable: false }));
        return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
      },
    });
    const extractBulk = mode => extractConsistencyLedger({ aiService: bulkAi(mode), workspaceDir: bulkDir, signal: new AbortController().signal,
      onActivity: event => bulkProgress.push(...(event.progress?.items || [])) });
    await assert.rejects(extractBulk('upstream'), error => error.code === AI_UPSTREAM_UNAVAILABLE && /连续 10 个请求失败.*最后一次错误：AI请求结算失败，请求已结束/.test(error.message));
    const bulkLedger = JSON.parse(fs.readFileSync(path.join(bulkDir, LEDGER_JSON), 'utf8'));
    assert.deepEqual(Object.keys(bulkLedger.sections), ['s1'], '已完成的核对保留');
    assert.equal(Object.keys(bulkLedger.failures).length, 10);
    assert.equal(bulkProgress.filter(item => item.status === 'cancelled').length, 1, '停止后未完成的小节记为已中断');
    assert.equal(fs.existsSync(path.join(bulkDir, LEDGER_FILE)), false, '服务端故障时不交给主 Agent');
    fs.rmSync(path.join(bulkDir, LEDGER_JSON));
    bulkProgress.length = 0;
    await assert.rejects(extractBulk('paused'), error => error.code === AI_QUEUE_SCOPE_PAUSED);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bulkDir, LEDGER_JSON), 'utf8')).failures, {}, '暂停丢弃不记为核对失败');
    assert.equal(bulkProgress.filter(item => item.status === 'error').length, 0);
    assert.equal(bulkProgress.filter(item => item.status === 'cancelled').length, 12);

    // 共用入口默认不注入材料，其他编辑任务仍要求自行读取文件。
    let defaultPrompt;
    await editContentSections({ jobs: [{ section_id: 'one', instructions: '默认编辑路径' }],
      targets: new Map([['one', { id: 'one', number: '1.1', title: '小节1', file: '正文/one.html' }]]),
      workspaceDir, signal: new AbortController().signal, activity: { pending: 0 },
      agentService: { async runTask(payload) { defaultPrompt = payload.prompt; } },
      title: '默认编辑', instructions: '保留原流程',
    });
    assert.match(defaultPrompt, /阅读受限 HTML 规范，并根据本次任务读取目标正文/);
    assert.doesNotMatch(defaultPrompt, /本小节启动时的完整 HTML|仅属于one的小节材料/);
    console.log('通过：纯文本核对输入、段落编号映射与无效编号置空、核对与压缩并行、前缀预热、台账分组、主 Agent 可直接修改少量小节、单轮提交即结束、核对失败交主 Agent 及恢复只补失败小节、重新核对与人工核对提交把关、服务端连续失败提前停止、暂停丢弃记为已中断、检索、真实并发修复及改动对比、图片保护及失败重试、错误 ID 部分执行与候选、同节合并、统一规则自查、多批次并发与按小节互斥、只查前后矛盾与全局事实冲突、新增小节以已完成小节为只读参考、台账按正文哈希和版本复用。');
  } finally {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

check().catch(error => { console.error(error); process.exitCode = 1; });
