const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { numberOutline, collectOutlineIds, acceptAgentOutline, NODE_ID_PATTERN } = require('./technicalPlanOutline.cjs');

const {
  runOutlineGenerationTaskV2,
  isMissingTechnicalScoreItems,
  createInitialPrompt,
  createNoTechnicalScoreChildrenPrompt,
  createNoTechnicalScoreReviewPrompt,
  createScorePlanningPrompt,
  createChildrenPrompt,
  enforceMinimumLeafTarget,
} = require('./outlineGenerationTaskV2.cjs');

// 按运行时顺序先校验，再将同一份标准化结果交给业务阶段。
async function submitStage(request, candidate, meta) {
  const validation_result = await request.validateOutput(candidate, meta);
  return request.continueTask(candidate, { ...meta, validation_result });
}

test('无评分任务首次生成和恢复时均遵守原方案来源限制，补充模式仍可使用其他资料', async () => {
  for (const originalOnly of [true, false]) {
    for (const restoring of [false, true]) {
      let root = { id: randomUUID(), number: '1', title: '实施方案', description: '原方案章节', attr: '技术', content_mode: 'ai-generate' };
      let result = { output_content: JSON.stringify({ outline: [root] }) };
      let task = { task_id: 'test-outline', stats: {} };
      let knowledgeReads = 0;
      const checkMaterials = (files) => {
        const paths = files.map((file) => file.path);
        assert.ok(paths.includes('原方案.md'));
        assert.equal(paths.includes('项目概述.md'), !originalOnly);
        assert.equal(paths.includes('响应文件要求.md'), !originalOnly);
        assert.equal(paths.includes('参考知识库/参考资料-1.md'), !originalOnly);
      };
      await runOutlineGenerationTaskV2({
        aiService: { isDeveloperMode: () => false },
        agentService: {
          updatePersistentTask() {},
          async runTask(options) {
            checkMaterials(options.files);
            if (options.initial_stage === 'initial-outline') {
              if (originalOnly) assert.match(options.prompt, /目录来源仅限原方案.md/);
              assert.equal(options.max_retries, 1);
              assert.deepEqual(options.prepare_output_files, ['outline.json']);
              const generated = options.validateOutput({ output_content: JSON.stringify({ outline: [{ ...root, id: null }] }) });
              let written;
              await options.continueTask(result, { validation_result: generated, writeFiles: async files => { written = JSON.parse(files[0].content); } });
              assert.deepEqual(written, generated);
              root = generated.outline[0];
              result = { output_content: JSON.stringify(generated) };
              return { ...result, validation_result: generated };
            }
            assert.equal(options.initial_stage, 'children_generation');
            assert.equal(options.max_retries, 1);
            assert.deepEqual(options.prepare_output_files, []);
            if (originalOnly) assert.match(options.prompt, /目录来源仅限原方案.md/);
            assert.equal(options.auto_validate_json, true);
            assert.equal(options.summary_enabled, false);
            const meta = {
              workflow_stage: 'children_generation', user_question_answers: [], writeFiles: async () => {},
              readFile: async (file) => {
                assert.ok(['原方案.md', 'outline-review.json'].includes(file), `无评分模式不应读取 ${file}`);
                return file === '原方案.md' ? '# 实施方案' : JSON.stringify({ status: 'passed', issues: [], summary: '通过', user_feedback: '' });
              },
            };
            const adjustment = await submitStage(options, result, meta);
            assert.equal(adjustment.stage, 'leaf_adjustment');
            if (originalOnly) assert.match(adjustment.prompt, /不得为凑字数或小节数量新增、拆分章节/);
            const review = await submitStage(options, result, { ...meta, workflow_stage: 'leaf_adjustment', user_question_answers: [{ workflow_stage: 'leaf_adjustment', selected_option: '接受当前结果' }] });
            assert.equal(review.stage, 'outline_review');
            assert.deepEqual(review.prepare_output_files, ['outline-review.json']);
            assert.ok(review.files.every((file) => !/score|allocation/.test(file.path)));
            assert.equal('score_mapping' in JSON.parse(review.files.find((file) => file.path === 'outline-review-context.json').content), false);
            for (const file of review.files) assert.ok(review.prompt.includes(file.content));
            if (originalOnly) {
              assert.ok(review.prompt.includes('【文件开始：原方案.md】\n# 实施方案\n【文件结束：原方案.md】'));
              assert.match(review.prompt, /目录来源仅限原方案.md/);
              assert.doesNotMatch(review.prompt, /专业经验只能补充通用目录结构/);
            }
            await submitStage(options, result, { ...meta, workflow_stage: 'outline_review' });
            return result;
          },
        },
        workspaceStore: {
          loadTechnicalPlan: () => ({
            outlineMode: 'response-file', originalPlanFile: {},
            outlineExpansionMode: originalOnly ? 'original-only' : 'ai-complement',
            projectOverview: '项目背景', referenceKnowledgeDocumentIds: ['reference'],
            bidAnalysisTasks: { techRequirements: { status: 'success', content: '未提取到' }, responseFileRequirements: { content: '响应要求' } },
          }),
          readOriginalPlanMarkdown: () => '# 实施方案',
          hasBidTemplate: () => false,
        },
        knowledgeBaseService: { readReferences: () => { knowledgeReads += 1; return [{ markdown: '知识库内容' }]; } },
        updateTask: (patch) => { task = { ...task, ...patch }; return task; },
        checkpointTask: (patch) => { task = { ...task, ...patch }; return { task }; },
        taskControl: { signal: new AbortController().signal, waitForOutlineSelection: async () => ({ items: [root], selectedIds: [root.id] }) },
        payload: { no_technical_score_mode: true, word_control_options: { minimumWords: 3000, sectionWords: 3000 }, ...(restoring ? { agent_resume: { phase: 'outline-selection' } } : {}) },
      });
      assert.equal(task.status, 'success');
      assert.equal(knowledgeReads, originalOnly ? 0 : 1);
    }
  }
});

test('首次一级目录在修复回调中拒绝空内容、损坏 JSON 和错误结构，通过后返回解析结果', async () => {
  const finished = new Error('校验检查完成');
  let task = { task_id: 'test-initial-outline-validation', stats: {} };
  await assert.rejects(runOutlineGenerationTaskV2({
    agentService: {
      updatePersistentTask() {},
      async runTask(options) {
        assert.equal(options.initial_stage, 'initial-outline');
        assert.equal(options.max_retries, 1);
        const validate = (output_content) => options.validateOutput({ output_content });
        for (const content of [undefined, '', ' \n\t']) {
          assert.throws(() => validate(content), /outline\.json 未写入或内容为空/);
        }
        assert.throws(() => validate('{"outline":['), /outline\.json不是合法 JSON/);
        for (const value of [null, {}, { outline: [] }, { outline: [{ id: '1', title: '实施方案' }] }]) {
          assert.throws(() => validate(JSON.stringify(value)), /outline\.json 不符合结构要求/);
        }
        const valid = { outline: [{ id: null, title: '实施方案', description: '实施安排', attr: '技术', content_mode: 'ai-generate' }] };
        const accepted = validate(JSON.stringify(valid));
        assert.match(accepted.outline[0].id, new RegExp(NODE_ID_PATTERN));
        assert.equal(accepted.outline[0].number, '1');
        assert.equal(accepted.outline[0].title, valid.outline[0].title);
        throw finished;
      },
    },
    workspaceStore: {
      loadTechnicalPlan: () => ({
        bidAnalysisTasks: { techRequirements: { status: 'success', content: '未提取到' } },
      }),
    },
    updateTask: (patch) => { task = { ...task, ...patch }; return task; },
    checkpointTask: (patch) => { task = { ...task, ...patch }; return { task }; },
    taskControl: {
      signal: new AbortController().signal,
      waitForOutlineSelection: async () => assert.fail('校验通过前不得进入一级目录确认'),
    },
    payload: { no_technical_score_mode: true },
  }), (error) => error === finished);
});

test('前后端均识别仅缺少技术评分项，且不误判局部字段缺失', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../../src/features/technical-plan/services/bidAnalysisWorkflow.ts'), 'utf8');
  const renderer = { exports: {}, require: () => ({}) };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, renderer);
  const cases = [
    ['未提取到', true],
    ['## 技术评分项\n\n没有提及\n\n## 技术评分要求\n偏离扣分规则：每项扣一分。', true],
    ['## 技术评分项\r\n\r\n没有提及\r\n\r\n## 技术评分要求\r\n符合性要求', true],
    ['## 技术评分要求\n符合性要求\n\n## 技术评分项\n没有提及', true],
    ['## 技术评分项\n【评分项名称】：实施方案\n【权重/分值】：没有提及\n\n## 技术评分要求\n没有提及', false],
    ['## 技术评分项\n\n## 技术评分要求\n没有提及', false],
    ['## 技术评分要求\n没有提及', false],
    ['', false],
    [undefined, false],
  ];
  for (const [content, expected] of cases) {
    assert.equal(isMissingTechnicalScoreItems(content), expected, `Main: ${content}`);
    assert.equal(renderer.exports.isMissingTechnicalScoreItems(content), expected, `Renderer: ${content}`);
  }
});

test('解析未完成和未确认无评分时均不启动 Agent', async () => {
  for (const [techRequirements, payload, message] of [
    [{ status: 'error', content: '未提取到' }, { no_technical_score_mode: true }, /请先完成技术评分要求解析/],
    [{ status: 'success', content: '' }, { no_technical_score_mode: true }, /请先完成技术评分要求解析/],
    [{ status: 'success', content: '未提取到' }, {}, /请先确认/],
  ]) {
    await assert.rejects(runOutlineGenerationTaskV2({
      workspaceStore: { loadTechnicalPlan: () => ({ bidAnalysisTasks: { techRequirements } }) },
      agentService: { runTask: () => assert.fail('不应启动 Agent') },
      payload,
    }), message);
  }
});

test('无评分时保留三种范围的默认选择，纯商务目录只提取模板且不启动 AI 扩展', async () => {
  const items = [
    { id: null, title: '目录', description: '全文目录', attr: '目录', content_mode: 'directory-generate' },
    { id: null, title: '授权书', description: '授权材料', attr: '商务/资信', content_mode: 'template-fill' },
    { id: null, title: '报价', description: '报价材料', attr: '报价', content_mode: 'manual-fill' },
    { id: null, title: '实施方案', description: '实施内容', attr: '技术', content_mode: 'ai-generate' },
  ];
  for (const [outlineMode, expectedIds] of [
    ['response-file', ['1', '2', '3', '4']],
    ['standalone-technical', ['4']],
    ['standalone-business', ['1', '2', '3']],
  ]) {
    let task = { task_id: '无评分范围检查', stats: {} };
    let savedOutline;
    let calls = 0;
    const selectedNumbers = outlineMode === 'standalone-technical' ? ['1'] : ['1', '2', '3'];
    await runOutlineGenerationTaskV2({
      workspaceStore: {
        loadTechnicalPlan: () => ({ outlineMode, bidAnalysisTasks: { techRequirements: { status: 'success', content: '未提取到' } } }),
        listTenderSourceDocxRelativePaths: () => [],
        hasBidTemplate: () => false,
      },
      agentService: {
        updatePersistentTask() {},
        async runTask(options) {
          calls += 1;
          assert.equal(options.initial_stage, 'initial-outline', '非 AI 选择不应再次生成技术目录');
          assert.equal(options.auto_validate_json, true);
          assert.equal(options.summary_enabled, false);
          const result = { output_content: JSON.stringify({ outline: items }) };
          return { ...result, validation_result: options.validateOutput(result) };
        },
      },
      updateTask: (patch) => (task = { ...task, ...patch }),
      checkpointTask: (patch, workspacePatch) => {
        task = { ...task, ...patch };
        if (workspacePatch?.outlineData) savedOutline = workspacePatch.outlineData;
        return { task };
      },
      taskControl: {
        signal: new AbortController().signal,
        waitForOutlineSelection: async () => {
          const selection = task.stats.outline_selection;
          assert.deepEqual(selection.items.filter(item => selection.selected_ids.includes(item.id)).map(item => item.number), expectedIds);
          return { items: selection.items, selectedIds: selection.items.filter(item => selectedNumbers.includes(item.number)).map(item => item.id) };
        },
      },
      payload: { no_technical_score_mode: true },
    });
    assert.equal(calls, 1);
    assert.equal(task.status, 'success');
    assert.equal(task.stats.agent.resume_payload.no_technical_score_mode, true);
    assert.equal(task.stats.agent.resume_payload.outline_mode, outlineMode);
    assert.deepEqual(savedOutline.outline.map(item => item.title), task.stats.outline_selection.items.filter(item => selectedNumbers.includes(item.number)).map(item => item.title));
    savedOutline.outline.forEach(item => assert.match(item.id, new RegExp(NODE_ID_PATTERN)));
    assert.equal(task.stats.template_agent?.status, outlineMode === 'standalone-technical' ? undefined : 'skipped');
  }
});

test('无技术评分项模式使用独立的生成与审核规则', () => {
  const initialPrompt = createInitialPrompt('按已有资料生成目录。', {
    standaloneTechnical: true,
    noTechnicalScoreMode: true,
  });
  const childrenPrompt = createNoTechnicalScoreChildrenPrompt({ targetLeafCount: 12, standaloneTechnical: true });
  const reviewPrompt = createNoTechnicalScoreReviewPrompt({ targetLeafCount: 12, actualLeafCount: 12, inputFiles: [] });

  assert.match(initialPrompt, /专业经验补充通用、合理的技术方案主题/);
  assert.doesNotMatch(initialPrompt, /一级目录必须直接对应技术评分大项/);
  assert.match(childrenPrompt, /不要判断是否存在评分项/);
  assert.match(childrenPrompt, /不得编造具体项目事实、参数、业绩或承诺/);
  assert.doesNotMatch(childrenPrompt, /technical-score-groups|score-directory-plan|report-failure/);
  assert.doesNotMatch(childrenPrompt, /point-to-point/);
  assert.match(childrenPrompt, /directory-generate/);
  assert.match(childrenPrompt, /manual-fill/);
  assert.match(childrenPrompt, /自动校验/);
  assert.match(reviewPrompt, /不要判断、补造或检查评分项/);
  assert.doesNotMatch(reviewPrompt, /评分覆盖|score-directory-plan/);
});

test('独立成册模式直接以技术评分大项作为一级目录', () => {
  const prompt = createInitialPrompt('按响应文件要求生成。', { standaloneTechnical: true });

  assert.match(prompt, /一级目录必须直接对应技术评分大项/);
  assert.match(prompt, /不得创建“技术方案”“项目管理方案”“监理大纲”“监理大纲（暗标）”“施工组织设计”“技术标”/);
  assert.match(prompt, /不得加入商务\/资信、投标函、授权委托书/);
});

test('独立成册评分规划把根节点固定为评分项层级', () => {
  const prompt = createScorePlanningPrompt({ standaloneTechnical: true });

  assert.match(prompt, /程序已确认本任务存在技术评分项/);
  assert.doesNotMatch(prompt, /如果技术评分信息中没有任何/);
  assert.match(prompt, /score_item_level 固定为 1/);
  assert.match(prompt, /target_title 必须与 root_title 完全一致/);
  assert.match(prompt, /不得再创建“技术方案”“项目管理方案”“监理大纲”“监理大纲（暗标）”“施工组织设计”“技术标”/);
});

test('独立成册生成子目录时不重复评分项根标题', () => {
  const prompt = createChildrenPrompt({
    hasOriginalPlan: false,
    originalOnly: false,
    targetLeafCount: 10,
    allowRootChanges: false,
    standaloneTechnical: true,
  });

  assert.match(prompt, /现有一级根节点本身就是评分项映射节点/);
  assert.match(prompt, /不得在根节点下面再次生成同名评分项/);
  assert.doesNotMatch(prompt, /"title":"技术方案"/);
});

test('独立成册末级小节目标至少覆盖每个技术分支', () => {
  assert.equal(enforceMinimumLeafTarget(10, 0, 6), 10);
  assert.equal(enforceMinimumLeafTarget(14, 0, 6), 14);
  assert.equal(enforceMinimumLeafTarget(4, 0, 6), 6);
  assert.equal(enforceMinimumLeafTarget(10, 2, 5), 10);
  assert.equal(enforceMinimumLeafTarget(null, 0, 6), null);
  assert.equal(enforceMinimumLeafTarget(2, 0, 1), 2);
});

test('最终审核直接收到四份完整最新材料，与写回文件一致，覆盖直接审核及数量确认后的审核', async () => {
  for (const acceptLeafDifference of [false, true]) {
    let root = { id: randomUUID(), number: '1', title: '技术方案', description: '技术响应', attr: '技术', content_mode: 'ai-generate' };
    const { content_mode, ...branchRoot } = root;
    const latestOutline = { outline: [{
      ...branchRoot, title: '最新技术方案',
      children: ['评分项一', '评分项二'].map((title, index) => ({
        id: null, title, description: '最新目录说明', content_mode: 'ai-generate',
      })),
    }] };
    const latestScore = `# 技术评分项\r\n${'完整评分条款，保留中文及换行。\r\n'.repeat(2500)}原文末尾`;
    let task = { task_id: '审核输入检查', stats: {} };
    let reviews = 0;
    await runOutlineGenerationTaskV2({
      workspaceStore: { loadTechnicalPlan: () => ({
        techRequirements: '任务开始时的旧评分内容',
        bidAnalysisTasks: { techRequirements: { status: 'success', content: '任务开始时的旧评分内容' } },
      }) },
      checkpointTask: (patch) => ({ task: (task = { ...task, ...patch }) }),
      updateTask: (patch) => (task = { ...task, ...patch }),
      taskControl: {
        signal: new AbortController().signal,
        waitForOutlineSelection: async () => ({ items: [root], selectedIds: [root.id] }),
      },
      payload: {
        agent_resume: { phase: 'outline-selection' },
        no_technical_score_mode: true,
        word_control_options: acceptLeafDifference ? { minimumWords: 3000, maximumWords: 3000, sectionWords: 1000 } : {},
      },
      agentService: {
        updatePersistentTask() {},
        // 运行真实业务阶段交接，仅替代模型和工作区 I/O，不调用收费模型。
        async runTask(request) {
          assert.equal(request.initial_stage, 'score-planning', '存在评分项时不能被无评分确认标记改变流程');
          const workspace = new Map(request.files.map((file) => [file.path, file.content]));
          workspace.set('technical-score-groups.json', JSON.stringify({ groups: ['评分项一', '评分项二'].map((title, index) => ({
            requirement_id: `R${index + 1}`, title, description: title, detail_points: [title],
          })) }));
          workspace.set('score-directory-plan.json', JSON.stringify({
            allow_root_changes: true, extra_titles: [],
            branches: [{
              root_id: root.id, root_title: root.title, score_item_level: 2,
              mappings: ['评分项一', '评分项二'].map((title, index) => ({ requirement_id: `R${index + 1}`, target_title: title })),
            }],
          }));
          const reads = [];
          const meta = {
            workflow_stage: 'score-planning', user_question_answers: [],
            readFile: async (filePath) => {
              reads.push(filePath);
              assert.ok(workspace.has(filePath));
              return workspace.get(filePath);
            },
            writeFiles: async (files) => files.forEach((file) => workspace.set(file.path, file.content)),
          };
          const children = await submitStage(request, { output_content: workspace.get('outline.json') }, meta);
          assert.equal(children.stage, 'children_generation');
          await meta.writeFiles(children.files);
          workspace.set('技术评分信息.md', latestScore);
          let candidate = { output_content: JSON.stringify(latestOutline) };
          let review = await submitStage(request, candidate, { ...meta, workflow_stage: 'children_generation' });
          if (acceptLeafDifference) {
            assert.equal(review.stage, 'leaf_adjustment');
            await meta.writeFiles(review.files);
            candidate = { output_content: workspace.get('outline.json') };
            review = await submitStage(request, candidate, {
              ...meta, workflow_stage: 'leaf_adjustment',
              user_question_answers: [{ workflow_stage: 'leaf_adjustment', selected_option: '接受当前结果' }],
            });
          }
          assert.equal(review.stage, 'outline_review');
          assert.deepEqual(reads, ['technical-score-groups.json', 'score-directory-plan.json', '技术评分信息.md']);
          assert.doesNotMatch(review.prompt, /开始审核时一次性并行读取|任务开始时的旧评分内容/);
          assert.match(review.prompt, /请直接开始审核，无需重复读取这些文件/);
          assert.equal((review.prompt.match(/【文件开始：/g) || []).length, 4);
          for (const file of [...review.files, { path: '技术评分信息.md', content: latestScore }]) {
            assert.ok(review.prompt.includes(`【文件开始：${file.path}】\n${file.content}\n【文件结束：${file.path}】`), `${file.path} 必须完整原样进入首轮审核输入`);
          }
          await meta.writeFiles(review.files);
          const sentOutline = JSON.parse(workspace.get('outline.json'));
          assert.equal(sentOutline.outline[0].id, root.id);
          assert.match(sentOutline.outline[0].children[0].id, new RegExp(NODE_ID_PATTERN));
          assert.equal(sentOutline.outline[0].children[0].number, '1.1');
          assert.equal(sentOutline.outline[0].title, '最新技术方案');
          assert.equal(JSON.parse(workspace.get('score-directory-plan.json')).branches[0].root_title, '最新技术方案');
          assert.equal(JSON.parse(workspace.get('outline-review-context.json')).leaf_count.current_ai_generate, 2);
          workspace.set('outline-review.json', JSON.stringify({ status: 'passed', issues: [], user_feedback: '', summary: '审核通过' }));
          const result = { output_content: workspace.get('outline.json') };
          assert.deepEqual(await submitStage(request, result, { ...meta, workflow_stage: 'outline_review' }), { complete: true });
          reviews += 1;
          return result;
        },
      },
    });
    assert.equal(reviews, 1);
    assert.equal(task.status, 'success');
  }
});

// 在内存工作区检查真实阶段回调，检查结束后停止，不调用模型或业务存储。
async function inspectDirectoryStages({ rootCount = 1, wordTarget = false } = {}, inspect) {
  const roots = Array.from({ length: rootCount }, (_, index) => ({
    id: randomUUID(), title: `技术分支${index + 1}`, description: '实施安排', attr: '技术', content_mode: 'ai-generate',
  }));
  let task = { task_id: '阶段产物检查', stats: {} };
  const finished = new Error('阶段检查完成');
  await assert.rejects(runOutlineGenerationTaskV2({
    workspaceStore: { loadTechnicalPlan: () => ({
      techRequirements: '技术评分材料', bidAnalysisTasks: { techRequirements: { status: 'success', content: '技术评分材料' } },
    }) },
    updateTask: patch => (task = { ...task, ...patch }),
    checkpointTask: patch => ({ task: (task = { ...task, ...patch }) }),
    taskControl: { signal: new AbortController().signal, waitForOutlineSelection: async () => ({ items: roots, selectedIds: roots.map(root => root.id) }) },
    payload: { agent_resume: { phase: 'outline-selection' }, word_control_options: wordTarget ? { minimumWords: 12000, maximumWords: 12000, sectionWords: 3000 } : {} },
    agentService: {
      updatePersistentTask() {},
      async runTask(request) {
        const workspace = new Map(request.files.map(file => [file.path, file.content]));
        workspace.set('technical-score-groups.json', JSON.stringify({ groups: roots.map((root, index) => ({
          requirement_id: `R${index + 1}`, title: root.title, description: root.description, detail_points: ['实施内容'],
        })) }));
        workspace.set('score-directory-plan.json', JSON.stringify({ allow_root_changes: false, extra_titles: [], branches: roots.map((root, index) => ({
          root_id: root.id, root_title: root.title, score_item_level: 1, mappings: [{ requirement_id: `R${index + 1}`, target_title: root.title }],
        })) }));
        const meta = {
          workflow_stage: request.initial_stage, user_question_answers: [],
          readFile: async file => workspace.get(file),
          writeFiles: async files => files.forEach(file => workspace.set(file.path, file.content)),
        };
        await inspect({ request, workspace, meta, roots });
        throw finished;
      },
    },
  }), error => error === finished);
}

test('阶段产物校验逐个指出缺失、空白、非法 JSON 和结构错误，评分双文件错误一次汇总', async () => {
  await inspectDirectoryStages({}, async ({ request, workspace, meta, roots }) => {
    assert.equal(request.max_retries, 1);
    workspace.set('leaf-allocation.json', JSON.stringify({ mode: 'allocated', target_ai_leaf_count: 2, fixed_ai_leaf_count: 0, allocatable_ai_leaf_count: 2, allocations: [{ root_id: roots[0].id, leaf_count: 2 }] }));
    workspace.set('outline-review.json', JSON.stringify({ status: 'passed', issues: [], user_feedback: '', summary: '审核通过' }));
    const stages = {
      'score-planning': ['technical-score-groups.json', 'score-directory-plan.json'],
      leaf_allocation: ['leaf-allocation.json'],
      children_generation: ['outline.json'],
      leaf_adjustment: ['outline.json'],
      outline_review: ['outline.json', 'outline-review.json'],
    };
    for (const [workflow_stage, files] of Object.entries(stages)) {
      for (const file of files) {
        const valid = workspace.get(file);
        for (const [content, message] of [[undefined, '未写入或内容为空'], [' \r\n\t', '未写入或内容为空'], ['{', '不是合法 JSON'], ['{}', '不符合结构要求']]) {
          workspace.set(file, content);
          await assert.rejects(request.validateOutput({ output_content: workspace.get('outline.json') }, { ...meta, workflow_stage }), error => {
            assert.ok(error.message.includes(file), `${workflow_stage} 应指明 ${file}`);
            assert.ok(error.message.includes(message));
            return true;
          });
        }
        workspace.set(file, valid);
      }
      await request.validateOutput({ output_content: workspace.get('outline.json') }, { ...meta, workflow_stage });
    }
    workspace.delete('technical-score-groups.json');
    workspace.delete('score-directory-plan.json');
    await assert.rejects(request.validateOutput({ output_content: workspace.get('outline.json') }, meta), error => {
      assert.match(error.message, /technical-score-groups\.json.*\nscore-directory-plan\.json/);
      error.agentValidationFailed = true;
      const prompt = request.buildRetryPrompt(error, meta);
      assert.match(prompt, /当前 Session 修复一轮/);
      assert.ok(prompt.includes(error.message));
      assert.match(prompt, /已通过的文件保留/);
      assert.match(prompt, /不要重复询问已确认事项/);
      return true;
    });
    assert.equal(request.buildRetryPrompt(new Error('网络错误'), meta), null);
  });
});

test('仅多技术分支且有字数目标时预建 AI 分配文件，其他分支由程序提供分配结果', async () => {
  for (const rootCount of [1, 2]) {
    for (const wordTarget of [false, true]) {
      await inspectDirectoryStages({ rootCount, wordTarget }, async ({ request, workspace, meta, roots }) => {
        assert.deepEqual(request.prepare_output_files, ['technical-score-groups.json', 'score-directory-plan.json']);
        let transition = await submitStage(request, { output_content: workspace.get('outline.json') }, meta);
        if (rootCount > 1 && wordTarget) {
          assert.equal(transition.stage, 'leaf_allocation');
          assert.deepEqual(transition.prepare_output_files, ['leaf-allocation.json']);
          const context = JSON.parse(transition.files.find(file => file.path === 'leaf-allocation-context.json').content);
          assert.equal(context.target_ai_leaf_count, 4);
          workspace.set('leaf-allocation.json', JSON.stringify({ ...context, technical_branches: undefined, allocations: roots.map(root => ({ root_id: root.id, leaf_count: 2 })) }));
          transition = await submitStage(request, { output_content: workspace.get('outline.json') }, { ...meta, workflow_stage: 'leaf_allocation' });
        }
        assert.equal(transition.stage, 'children_generation');
        assert.deepEqual(transition.prepare_output_files || [], []);
        const allocation = JSON.parse(transition.files.find(file => file.path === 'leaf-allocation.json').content);
        assert.equal(allocation.mode, wordTarget ? 'allocated' : 'agent-decides');
        assert.equal(allocation.allocations.length, rootCount);
        assert.equal(allocation.target_ai_leaf_count, wordTarget ? 4 : null);
      });
    }
  }
});

test('阶段校验拒绝未知和重复节点，交接沿用校验分配的身份，审核文件缺失时不能通过', async () => {
  await inspectDirectoryStages({}, async ({ request, workspace, meta, roots }) => {
    await submitStage(request, { output_content: workspace.get('outline.json') }, meta);
    const childrenMeta = { ...meta, workflow_stage: 'children_generation' };
    for (const [outline, reason] of [[[{ ...roots[0], id: randomUUID() }], '未知 ID'], [[roots[0], roots[0]], '重复']]) {
      await assert.rejects(request.validateOutput({ output_content: JSON.stringify({ outline }) }, childrenMeta), error => {
        assert.match(error.message, /outline\.json 节点身份不符合要求/);
        assert.ok(error.message.includes(reason));
        return true;
      });
    }
    const { content_mode, ...branch } = roots[0];
    const candidate = { output_content: JSON.stringify({ outline: [{ ...branch, children: ['实施', '保障'].map(title => ({
      id: null, title, description: title, content_mode: 'ai-generate',
    })) }] }) };
    const validation_result = await request.validateOutput(candidate, childrenMeta);
    const accepted = validation_result['outline.json'];
    const review = await request.continueTask(candidate, { ...childrenMeta, validation_result });
    assert.equal(review.stage, 'outline_review');
    assert.deepEqual(review.prepare_output_files, ['outline-review.json']);
    assert.deepEqual(JSON.parse(review.files.find(file => file.path === 'outline.json').content), accepted);
    await meta.writeFiles(review.files);
    const finalCandidate = { output_content: workspace.get('outline.json') };
    const reviewMeta = { ...meta, workflow_stage: 'outline_review' };
    await assert.rejects(request.validateOutput(finalCandidate, reviewMeta), /outline-review\.json 未写入或内容为空/);
    workspace.set('outline-review.json', JSON.stringify({ status: 'passed', issues: [], user_feedback: '', summary: '审核通过' }));
    const reviewed = await request.validateOutput(finalCandidate, reviewMeta);
    assert.deepEqual(reviewed['outline.json'], accepted);
    assert.deepEqual(await request.continueTask(finalCandidate, { ...reviewMeta, validation_result: reviewed }), { complete: true });
    assert.deepEqual(JSON.parse(workspace.get('outline.json')), accepted);
  });
});

// 覆盖身份创建、保留及 AI 输出边界，不依赖收费模型。
test('节点排序只改显示编号，新增分配唯一 ID，拒绝未知或重复身份', () => {
  const draft = ['甲', '乙'].map(title => ({ id: null, title, description: title, attr: '技术', content_mode: 'ai-generate' }));
  const created = acceptAgentOutline(draft);
  assert.notEqual(created[0].id, created[1].id);
  const known = collectOutlineIds(created);
  const sorted = acceptAgentOutline([created[1], created[0], { ...draft[0], title: '新增' }], known);
  assert.equal(sorted[0].id, created[1].id);
  assert.equal(sorted[0].number, '1');
  assert.equal(sorted[1].id, created[0].id);
  assert.equal(sorted[1].number, '2');
  assert.match(sorted[2].id, new RegExp(NODE_ID_PATTERN));
  assert.throws(() => acceptAgentOutline([created[0], created[0]], known), /重复/);
  assert.throws(() => acceptAgentOutline([{ ...draft[0], id: randomUUID() }], known), /未知 ID/);
  assert.throws(() => acceptAgentOutline([{ ...draft[0], id: '1.1' }], known), /未知 ID/);
});

// AI 调整新增节点也只分配一次，并将与数据库相同的正式身份写回会话。
test('AI 调整保留已有节点身份并写回新节点 ID', async () => {
  const { runOutlineAdjustmentTask } = require('./outlineAdjustmentTask.cjs');
  const existing = acceptAgentOutline([{ id: null, title: '已有', description: '说明', attr: '技术', content_mode: 'ai-generate' }]);
  let written;
  let saved;
  let task = { task_id: 'adjust', stats: {} };
  await runOutlineAdjustmentTask({
    agentService: {
      hasPersistentTaskSession: () => true, updatePersistentTask() {},
      async runTask(options) {
        const input = JSON.parse(options.files[0].content);
        assert.equal(input.outline[0].id, existing[0].id);
        const candidate = { output_content: JSON.stringify({ outline: [
          { ...input.outline[0], title: '改名' },
          { id: null, title: '新增', description: '说明', attr: '技术', content_mode: 'ai-generate' },
        ] }) };
        options.validateOutput(candidate);
        await options.continueTask(candidate, { writeFiles: async files => { written = JSON.parse(files[0].content); } });
        return candidate;
      },
    },
    workspaceStore: {
      loadTechnicalPlan: () => ({ outlineData: { outline: existing } }),
      saveOutline(request) { saved = request; return { outlineData: request.outlineData }; },
    },
    updateTask: patch => (task = { ...task, ...patch }),
    checkpointTask: patch => ({ task: (task = { ...task, ...patch }) }),
    taskControl: { signal: new AbortController().signal }, payload: { requirement: '改名并新增' },
  });
  assert.deepEqual(saved.outlineData.outline, written.outline);
  assert.equal(saved.reason, 'replace', '保留现有正文失效规则');
  assert.equal(written.outline[0].id, existing[0].id);
  assert.match(written.outline[1].id, new RegExp(NODE_ID_PATTERN));
  assert.notEqual(written.outline[1].id, existing[0].id);
  assert.equal(written.outline[1].number, '2');
});
