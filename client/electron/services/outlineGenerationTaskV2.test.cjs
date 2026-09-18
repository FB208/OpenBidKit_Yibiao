const test = require('node:test');
const assert = require('node:assert/strict');

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

test('无评分任务首次生成和恢复时均遵守原方案来源限制，补充模式仍可使用其他资料', async () => {
  for (const originalOnly of [true, false]) {
    for (const restoring of [false, true]) {
      const root = { id: '1', title: '实施方案', description: '原方案章节', attr: '技术', content_mode: 'ai-generate' };
      const result = { output_content: JSON.stringify({ outline: [root] }) };
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
              return result;
            }
            assert.equal(options.initial_stage, 'children_generation');
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
            const adjustment = await options.continueTask(result, meta);
            assert.equal(adjustment.stage, 'leaf_adjustment');
            if (originalOnly) assert.match(adjustment.prompt, /不得为凑字数或小节数量新增、拆分章节/);
            const review = await options.continueTask(result, { ...meta, workflow_stage: 'leaf_adjustment', user_question_answers: [{ workflow_stage: 'leaf_adjustment', selected_option: '接受当前结果' }] });
            assert.equal(review.stage, 'outline_review');
            assert.ok(review.files.every((file) => !/score|allocation/.test(file.path)));
            assert.equal('score_mapping' in JSON.parse(review.files.find((file) => file.path === 'outline-review-context.json').content), false);
            for (const file of review.files) assert.ok(review.prompt.includes(file.content));
            if (originalOnly) {
              assert.ok(review.prompt.includes('【文件开始：原方案.md】\n# 实施方案\n【文件结束：原方案.md】'));
              assert.match(review.prompt, /目录来源仅限原方案.md/);
              assert.doesNotMatch(review.prompt, /专业经验只能补充通用目录结构/);
            }
            await options.continueTask(result, { ...meta, workflow_stage: 'outline_review' });
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
        taskControl: { signal: new AbortController().signal, waitForOutlineSelection: async () => ({ items: [root], selectedIds: ['1'] }) },
        payload: { no_technical_score_mode: true, word_control_options: { minimumWords: 3000, sectionWords: 3000 }, ...(restoring ? { agent_resume: { phase: 'outline-selection' } } : {}) },
      });
      assert.equal(task.status, 'success');
      assert.equal(knowledgeReads, originalOnly ? 0 : 1);
    }
  }
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
    { id: '1', title: '目录', description: '全文目录', attr: '目录', content_mode: 'directory-generate' },
    { id: '2', title: '授权书', description: '授权材料', attr: '商务/资信', content_mode: 'template-fill' },
    { id: '3', title: '报价', description: '报价材料', attr: '报价', content_mode: 'manual-fill' },
    { id: '4', title: '实施方案', description: '实施内容', attr: '技术', content_mode: 'ai-generate' },
  ];
  for (const [outlineMode, expectedIds] of [
    ['response-file', ['1', '2', '3', '4']],
    ['standalone-technical', ['4']],
    ['standalone-business', ['1', '2', '3']],
  ]) {
    let task = { task_id: '无评分范围检查', stats: {} };
    let savedOutline;
    let calls = 0;
    const selectedIds = outlineMode === 'standalone-technical' ? ['1'] : ['1', '2', '3'];
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
          return { output_content: JSON.stringify({ outline: items }) };
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
          assert.deepEqual(task.stats.outline_selection.selected_ids, expectedIds);
          return { items, selectedIds };
        },
      },
      payload: { no_technical_score_mode: true },
    });
    assert.equal(calls, 1);
    assert.equal(task.status, 'success');
    assert.equal(task.stats.agent.resume_payload.no_technical_score_mode, true);
    assert.equal(task.stats.agent.resume_payload.outline_mode, outlineMode);
    assert.deepEqual(savedOutline.outline, items.filter((item) => selectedIds.includes(item.id)));
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
  assert.equal(enforceMinimumLeafTarget(2, 0, 1, {
    maximumWords: 4000,
    sectionWords: 3000,
    strictSectionWords: true,
  }), 1);
  assert.throws(
    () => enforceMinimumLeafTarget(4, 0, 6, {
      maximumWords: 4000,
      sectionWords: 1000,
      strictSectionWords: true,
    }),
    /最多容纳 5 个 AI 生成小节，但独立成册目录至少需要 6 个/,
  );
});

test('最终审核直接收到四份完整最新材料，与写回文件一致，覆盖直接审核及数量确认后的审核', async () => {
  for (const acceptLeafDifference of [false, true]) {
    const root = { id: '1', title: '技术方案', description: '技术响应', attr: '技术', content_mode: 'ai-generate' };
    const latestOutline = { outline: [{
      ...root, id: '7', title: '最新技术方案', branch_id: 'B1',
      children: ['评分项一', '评分项二'].map((title, index) => ({
        id: `7.${index + 4}`, title, description: '最新目录说明', content_mode: 'ai-generate',
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
        waitForOutlineSelection: async () => ({ items: [root], selectedIds: ['1'] }),
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
          workspace.set('score-directory-plan.json', JSON.stringify({
            allow_root_changes: true, extra_titles: [],
            branches: [{
              branch_id: 'B1', root_id: '1', root_title: root.title, score_item_level: 2,
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
          const children = await request.continueTask({ output_content: workspace.get('outline.json') }, meta);
          assert.equal(children.stage, 'children_generation');
          await meta.writeFiles(children.files);
          workspace.set('技术评分信息.md', latestScore);
          const candidate = { output_content: JSON.stringify(latestOutline) };
          let review = await request.continueTask(candidate, { ...meta, workflow_stage: 'children_generation' });
          if (acceptLeafDifference) {
            assert.equal(review.stage, 'leaf_adjustment');
            await meta.writeFiles(review.files);
            review = await request.continueTask(candidate, {
              ...meta, workflow_stage: 'leaf_adjustment',
              user_question_answers: [{ workflow_stage: 'leaf_adjustment', selected_option: '接受当前结果' }],
            });
          }
          assert.equal(review.stage, 'outline_review');
          assert.deepEqual(reads, ['score-directory-plan.json', '技术评分信息.md']);
          assert.doesNotMatch(review.prompt, /开始审核时一次性并行读取|任务开始时的旧评分内容/);
          assert.match(review.prompt, /请直接开始审核，无需重复读取这些文件/);
          assert.equal((review.prompt.match(/【文件开始：/g) || []).length, 4);
          for (const file of [...review.files, { path: '技术评分信息.md', content: latestScore }]) {
            assert.ok(review.prompt.includes(`【文件开始：${file.path}】\n${file.content}\n【文件结束：${file.path}】`), `${file.path} 必须完整原样进入首轮审核输入`);
          }
          await meta.writeFiles(review.files);
          const sentOutline = JSON.parse(workspace.get('outline.json'));
          assert.equal(sentOutline.outline[0].id, '1');
          assert.equal(sentOutline.outline[0].children[0].id, '1.1');
          assert.equal(sentOutline.outline[0].title, '最新技术方案');
          assert.equal(JSON.parse(workspace.get('score-directory-plan.json')).branches[0].root_title, '最新技术方案');
          assert.equal(JSON.parse(workspace.get('outline-review-context.json')).leaf_count.current_ai_generate, 2);
          workspace.set('outline-review.json', JSON.stringify({ status: 'passed', issues: [], user_feedback: '', summary: '审核通过' }));
          const result = { output_content: workspace.get('outline.json') };
          assert.deepEqual(await request.continueTask(result, { ...meta, workflow_stage: 'outline_review' }), { complete: true });
          reviews += 1;
          return result;
        },
      },
    });
    assert.equal(reviews, 1);
    assert.equal(task.status, 'success');
  }
});
