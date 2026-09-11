const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createInitialPrompt,
  createScorePlanningPrompt,
  createChildrenPrompt,
  enforceMinimumLeafTarget,
  runOutlineGenerationTaskV2,
} = require('./outlineGenerationTaskV2.cjs');

test('独立成册模式直接以技术评分大项作为一级目录', () => {
  const prompt = createInitialPrompt('按响应文件要求生成。', { standaloneTechnical: true });

  assert.match(prompt, /一级目录必须直接对应技术评分大项/);
  assert.match(prompt, /不得创建“技术方案”“项目管理方案”“监理大纲”“监理大纲（暗标）”“施工组织设计”“技术标”/);
  assert.match(prompt, /不得加入商务\/资信、投标函、授权委托书/);
});

test('独立成册评分规划把根节点固定为评分项层级', () => {
  const prompt = createScorePlanningPrompt({ standaloneTechnical: true });

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
      workspaceStore: { loadTechnicalPlan: () => ({ techRequirements: '任务开始时的旧评分内容' }) },
      checkpointTask: (patch) => ({ task: (task = { ...task, ...patch }) }),
      updateTask: (patch) => (task = { ...task, ...patch }),
      taskControl: {
        signal: new AbortController().signal,
        waitForOutlineSelection: async () => ({ items: [root], selectedIds: ['1'] }),
      },
      payload: {
        agent_resume: { phase: 'outline-selection' },
        word_control_options: acceptLeafDifference ? { minimumWords: 3000, maximumWords: 3000, sectionWords: 1000 } : {},
      },
      agentService: {
        updatePersistentTask() {},
        // 运行真实业务阶段交接，仅替代模型和工作区 I/O，不调用收费模型。
        async runTask(request) {
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
