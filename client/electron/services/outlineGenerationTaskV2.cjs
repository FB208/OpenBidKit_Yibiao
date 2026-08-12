const { OUTLINE_AGENT_TASK_KEY } = require('./outlineGenerationAgentV2Config.cjs');

const DEFAULT_ESTIMATED_SECTION_WORDS = 3000;
const OUTLINE_OUTPUT_FILE = 'outline.json';
const TECHNICAL_SCORE_GROUPS_FILE = 'technical-score-groups.json';
const SCORE_DIRECTORY_PLAN_FILE = 'score-directory-plan.json';
const LEAF_ALLOCATION_FILE = 'leaf-allocation.json';
const LEAF_ALLOCATION_CONTEXT_FILE = 'leaf-allocation-context.json';
const OUTLINE_REVIEW_FILE = 'outline-review.json';
const OUTLINE_REVIEW_CONTEXT_FILE = 'outline-review-context.json';
const AI_CONTENT_MODE = 'ai-generate';
const CONTENT_MODES = ['ai-generate', 'template-fill', 'point-to-point', 'other'];

function createDirectoryNodeSchema(level, root = false) {
  const baseProperties = {
    id: { type: 'string', pattern: `^[1-9]\\d*(?:\\.[1-9]\\d*){${level - 1}}$` },
    title: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    ...(root ? {
      attr: { type: 'string', enum: ['通用', '商务', '资信', '技术', '其他'] },
      branch_id: { type: 'string', minLength: 1 },
    } : {}),
  };
  const baseRequired = ['id', 'title', 'description', ...(root ? ['attr'] : [])];
  const leafSchema = {
    type: 'object',
    required: [...baseRequired, 'content_mode'],
    additionalProperties: false,
    properties: {
      ...baseProperties,
      content_mode: { type: 'string', enum: CONTENT_MODES },
      content_mode_note: { type: 'string' },
    },
  };
  if (level < 6) {
    const branchSchema = {
      type: 'object',
      required: [...baseRequired, 'children'],
      additionalProperties: false,
      properties: {
        ...baseProperties,
        children: {
          type: 'array',
          minItems: 2,
          items: createDirectoryNodeSchema(level + 1),
        },
      },
    };
    return { oneOf: [leafSchema, branchSchema] };
  }
  return leafSchema;
}

const ROOT_NODE_SCHEMA = createDirectoryNodeSchema(1, true);

const OUTLINE_JSON_SCHEMA = {
  type: 'object',
  required: ['outline'],
  additionalProperties: false,
  properties: {
    outline: {
      type: 'array',
      minItems: 1,
      items: ROOT_NODE_SCHEMA,
    },
  },
};

const TECHNICAL_SCORE_GROUPS_SCHEMA = {
  type: 'object',
  required: ['groups'],
  additionalProperties: false,
  properties: {
    groups: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['requirement_id', 'title', 'description', 'detail_points'],
        additionalProperties: false,
        properties: {
          requirement_id: { type: 'string', pattern: '^R[1-9]\\d*$' },
          title: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          detail_points: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  },
};

const SCORE_DIRECTORY_PLAN_SCHEMA = {
  type: 'object',
  required: ['allow_root_changes', 'branches', 'extra_titles'],
  additionalProperties: false,
  properties: {
    allow_root_changes: { type: 'boolean' },
    branches: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['branch_id', 'root_id', 'root_title', 'score_item_level', 'mappings'],
        additionalProperties: false,
        properties: {
          branch_id: { type: 'string', minLength: 1 },
          root_id: { type: 'string', pattern: '^[1-9]\\d*(?:\\.[1-9]\\d*)*$' },
          root_title: { type: 'string', minLength: 1 },
          score_item_level: { type: 'integer', minimum: 1, maximum: 6 },
          mappings: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['requirement_id', 'target_title'],
              additionalProperties: false,
              properties: {
                requirement_id: { type: 'string', pattern: '^R[1-9]\\d*$' },
                target_title: { type: 'string', minLength: 1 },
                additional_titles: {
                  type: 'array',
                  minItems: 1,
                  items: { type: 'string', minLength: 1 },
                },
                adjustment_note: { type: 'string' },
              },
            },
          },
        },
      },
    },
    extra_titles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['branch_id', 'title', 'reason'],
        additionalProperties: false,
        properties: {
          branch_id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};

const OUTLINE_REVIEW_SCHEMA = {
  type: 'object',
  required: ['status', 'issues', 'user_feedback', 'summary'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['passed', 'simple_fix', 'user_feedback', 'user_refuse'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['category', 'problem', 'repair', 'confirmation_required'],
        additionalProperties: false,
        properties: {
          category: {
            type: 'string',
            enum: ['leaf-count', 'score-coverage', 'duplicate-directory', 'professional-structure'],
          },
          problem: { type: 'string', minLength: 1 },
          repair: { type: 'string', minLength: 1 },
          confirmation_required: { type: 'boolean' },
        },
      },
    },
    user_feedback: { type: 'string' },
    summary: { type: 'string', minLength: 1 },
  },
};

const LEAF_ALLOCATION_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      required: ['mode', 'target_ai_leaf_count', 'fixed_ai_leaf_count', 'allocatable_ai_leaf_count', 'allocations'],
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['allocated'] },
        target_ai_leaf_count: { type: 'integer', minimum: 1 },
        fixed_ai_leaf_count: { type: 'integer', minimum: 0 },
        allocatable_ai_leaf_count: { type: 'integer', minimum: 1 },
        allocations: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['branch_id', 'leaf_count'],
            additionalProperties: false,
            properties: {
              branch_id: { type: 'string', minLength: 1 },
              leaf_count: { type: 'integer', minimum: 2 },
            },
          },
        },
      },
    },
    {
      type: 'object',
      required: ['mode', 'target_ai_leaf_count', 'fixed_ai_leaf_count', 'allocatable_ai_leaf_count', 'allocations'],
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['agent-decides'] },
        target_ai_leaf_count: { type: 'null' },
        fixed_ai_leaf_count: { type: 'integer', minimum: 0 },
        allocatable_ai_leaf_count: { type: 'null' },
        allocations: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['branch_id'],
            additionalProperties: false,
            properties: {
              branch_id: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    },
  ],
};

function formatProgressTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  return Array.from(title).slice(0, 20).join('');
}

function normalizeWordControlOptions(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const integer = (input) => {
    const number = Number(input);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
  };
  return {
    minimumWords: integer(raw.minimumWords),
    maximumWords: integer(raw.maximumWords),
    sectionWords: integer(raw.sectionWords),
    strictSectionWords: Boolean(raw.strictSectionWords) && integer(raw.sectionWords) > 0,
  };
}

function deriveTargetLeafCount(options) {
  const sectionWords = options.sectionWords > 0 ? options.sectionWords : DEFAULT_ESTIMATED_SECTION_WORDS;
  if (options.minimumWords > 0 && options.maximumWords > 0) {
    return Math.ceil(((options.minimumWords + options.maximumWords) / 2) / sectionWords);
  }
  if (options.maximumWords > 0) {
    return Math.floor(options.maximumWords / sectionWords) - 2;
  }
  if (options.minimumWords > 0) {
    return Math.ceil(options.minimumWords / sectionWords) + 2;
  }
  return null;
}

// 统一目录层级编号，并按父子节点形态整理目录字段。
function renumberOutline(items, prefix = '') {
  return (items || []).map((item, index) => {
    const id = prefix ? `${prefix}.${index + 1}` : String(index + 1);
    const hasChildren = Array.isArray(item?.children) && item.children.length;
    const next = {
      id,
      title: String(item?.title || '').trim(),
      description: String(item?.description || '').trim(),
      ...(prefix ? {} : { attr: item?.attr }),
      ...(!prefix && String(item?.branch_id || '').trim() ? { branch_id: String(item.branch_id).trim() } : {}),
      ...(!hasChildren ? {
        content_mode: item?.content_mode,
        ...(item?.content_mode === 'other' && String(item?.content_mode_note || '').trim()
          ? { content_mode_note: String(item.content_mode_note).trim() }
          : {}),
      } : {}),
    };
    if (hasChildren) {
      next.children = renumberOutline(item.children, id);
    }
    return next;
  });
}

// 接受 Agent 的完整目录结果，并统一整理层级编号和节点字段。
function buildFinalOutline(candidate) {
  return { outline: renumberOutline(candidate?.outline || []) };
}

// 移除仅供 Agent 工作流关联分支的内部字段，再写入正式业务目录。
function stripOutlineInternalFields(candidate) {
  const strip = (items) => (items || []).map((item) => {
    const { branch_id: _branchId, children, ...rest } = item || {};
    return Array.isArray(children) && children.length
      ? { ...rest, children: strip(children) }
      : rest;
  });
  return { outline: strip(candidate?.outline || []) };
}

// 在子目录生成前，把规划分支标识附加到当前可对应的一级目录。
function attachBranchIdsToRoots(items, scoreDirectoryPlan) {
  const branchesByRootId = new Map();
  (scoreDirectoryPlan?.branches || []).forEach((branch) => {
    const rootId = String(branch.root_id || '').split('.')[0];
    if (!branchesByRootId.has(rootId)) branchesByRootId.set(rootId, branch);
  });
  return (items || []).map((item) => {
    const branch = branchesByRootId.get(item.id);
    return branch?.root_title === item.title ? { ...item, branch_id: branch.branch_id } : item;
  });
}

// 按最终目录中的稳定分支标识同步规划所记录的当前编号和标题。
function synchronizeScoreDirectoryPlan(scoreDirectoryPlan, items) {
  const rootsByBranchId = new Map(
    (items || [])
      .filter((item) => String(item?.branch_id || '').trim())
      .map((item) => [String(item.branch_id).trim(), item]),
  );
  return {
    ...scoreDirectoryPlan,
    branches: (scoreDirectoryPlan?.branches || []).map((branch) => {
      const root = rootsByBranchId.get(branch.branch_id);
      return root ? { ...branch, root_id: root.id, root_title: root.title } : branch;
    }),
  };
}

function countAiLeaves(items) {
  return (items || []).reduce((total, item) => (
    Array.isArray(item?.children) && item.children.length
      ? total + countAiLeaves(item.children)
      : total + (item?.content_mode === AI_CONTENT_MODE ? 1 : 0)
  ), 0);
}

function countLeavesByMode(items, counts = Object.fromEntries(CONTENT_MODES.map((mode) => [mode, 0]))) {
  (items || []).forEach((item) => {
    if (Array.isArray(item?.children) && item.children.length) {
      countLeavesByMode(item.children, counts);
    } else if (CONTENT_MODES.includes(item?.content_mode)) {
      counts[item.content_mode] += 1;
    }
  });
  return counts;
}

// 汇总目录层级、父节点和内容模式等确定性结构信息。
function collectOutlineStructure(items) {
  const result = {
    max_depth: 0,
    parent_count: 0,
    single_child_nodes: [],
    invalid_leaf_content_modes: [],
  };
  const visit = (nodes, depth) => {
    (nodes || []).forEach((item) => {
      result.max_depth = Math.max(result.max_depth, depth);
      const children = Array.isArray(item?.children) ? item.children : [];
      if (children.length) {
        result.parent_count += 1;
        if (children.length < 2) {
          result.single_child_nodes.push({ id: item.id, title: item.title, child_count: children.length });
        }
        visit(children, depth + 1);
      } else if (!CONTENT_MODES.includes(item?.content_mode)) {
        result.invalid_leaf_content_modes.push({ id: item.id, title: item.title, content_mode: item?.content_mode || '' });
      }
    });
  };
  visit(items, 1);
  return result;
}

function collectNodesAtLevel(item, currentDepth, targetDepth, result = []) {
  if (!item) return result;
  if (currentDepth === targetDepth) {
    result.push(item);
    return result;
  }
  if (currentDepth < targetDepth) {
    (item.children || []).forEach((child) => collectNodesAtLevel(child, currentDepth + 1, targetDepth, result));
  }
  return result;
}

// 对照用户确认的评分规划，机械检查目标标题是否位于指定分支和层级。
function collectScoreMappingCoverage(items, scoreDirectoryPlan) {
  const extraTitles = Array.isArray(scoreDirectoryPlan?.extra_titles) ? scoreDirectoryPlan.extra_titles : [];
  const branches = (scoreDirectoryPlan?.branches || []).map((branch) => {
    const root = (items || []).find((item) => item?.branch_id === branch.branch_id);
    const expectedTitles = [
      ...(branch.mappings || []).flatMap((mapping) => [mapping.target_title, ...(mapping.additional_titles || [])]),
      ...extraTitles.filter((item) => item.branch_id === branch.branch_id).map((item) => item.title),
    ].filter(Boolean);
    const uniqueExpectedTitles = [...new Set(expectedTitles)];
    const actualNodes = root ? collectNodesAtLevel(root, 1, branch.score_item_level) : [];
    const actualTitles = actualNodes.map((item) => item.title);
    const actualTitleSet = new Set(actualTitles);
    const expectedTitleSet = new Set(uniqueExpectedTitles);
    return {
      branch_id: branch.branch_id,
      planned_root_id: branch.root_id,
      current_root_id: root?.id || '',
      root_title: root?.title || branch.root_title,
      score_item_level: branch.score_item_level,
      root_found: Boolean(root),
      expected_titles: uniqueExpectedTitles,
      actual_titles: actualTitles,
      missing_titles: uniqueExpectedTitles.filter((title) => !actualTitleSet.has(title)),
      unexpected_titles: actualTitles.filter((title) => !expectedTitleSet.has(title)),
      mappings: (branch.mappings || []).map((mapping) => {
        const titles = [mapping.target_title, ...(mapping.additional_titles || [])].filter(Boolean);
        return {
          requirement_id: mapping.requirement_id,
          expected_titles: titles,
          matched_titles: titles.filter((title) => actualTitleSet.has(title)),
        };
      }),
    };
  });
  return {
    valid: branches.every((branch) => (
      branch.root_found
      && branch.missing_titles.length === 0
      && branch.unexpected_titles.length === 0
    )),
    branches,
  };
}

// 生成供最终 Agent 审核直接采用的宿主程序确定性检查结果。
function buildOutlineReviewContext({ outline, scoreDirectoryPlan, targetLeafCount }) {
  const items = outline?.outline || [];
  const leafCounts = countLeavesByMode(items);
  const structure = collectOutlineStructure(items);
  const acceptableMin = targetLeafCount === null ? null : Math.max(1, targetLeafCount - 2);
  const acceptableMax = targetLeafCount === null ? null : targetLeafCount + 2;
  return {
    leaf_count: {
      target: targetLeafCount,
      current_ai_generate: leafCounts[AI_CONTENT_MODE],
      acceptable_min: acceptableMin,
      acceptable_max: acceptableMax,
      within_acceptable_range: targetLeafCount === null
        ? true
        : leafCounts[AI_CONTENT_MODE] >= acceptableMin && leafCounts[AI_CONTENT_MODE] <= acceptableMax,
      by_content_mode: leafCounts,
    },
    structure: {
      ...structure,
      valid: structure.max_depth <= 6
        && structure.single_child_nodes.length === 0
        && structure.invalid_leaf_content_modes.length === 0,
    },
    score_mapping: collectScoreMappingCoverage(items, scoreDirectoryPlan),
  };
}

function readJson(content, label) {
  try {
    return JSON.parse(String(content || '').trim());
  } catch (error) {
    throw new Error(`${label}不是合法 JSON：${error?.message || String(error)}`);
  }
}

function normalizeReferenceDocumentIds(storedPlan) {
  const ids = storedPlan?.referenceKnowledgeDocumentIds || [];
  return Array.isArray(ids) ? [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))] : [];
}

function buildKnowledgeFiles(knowledgeBaseService, documentIds) {
  if (!knowledgeBaseService?.readReferences) return [];
  return knowledgeBaseService.readReferences(documentIds, { includeMarkdown: true, includeItems: false })
    .map((reference, index) => ({
      path: `参考知识库/参考资料-${index + 1}.md`,
      content: String(reference?.markdown || '').trim(),
    }))
    .filter((file) => file.content);
}

function createInitialPrompt(taskInstruction) {
  return `请只在当前工作目录内工作。

任务：
我们的目标是为编写响应文件/投标文件准备一级目录。
${taskInstruction}

请生成一级目录 JSON，并将结果写入 ${OUTLINE_OUTPUT_FILE}。

字段要求：
1. 顶层必须是对象，唯一字段 outline 是一级目录数组；此阶段暂时不要生成 children。
2. 一级目录 id 是从 1 开始且不重复的连续序号字符串。
3. title 必须是可直接用于投标文件目录的正式标题，不得包含“附件1”“附件一”“第一章”等编号或前缀。
4. description 是目录说明。
5. attr 必须从“通用”“商务”“资信”“技术”“其他”中选择。
6. 每个一级目录当前都是叶子节点，必须根据它后续应采用的内容处理方式填写 content_mode：技术方案正文使用 ai-generate；需要从招标文件提取并套用表格或格式的商务、资信材料使用 template-fill；需要在全部正文完成并确定 Word 页码后回填的点对点应答表使用 point-to-point；无法归类的特殊内容使用 other，并在 content_mode_note 说明原因。
7. ${OUTLINE_OUTPUT_FILE} 必须是纯 JSON，不包含 Markdown 代码块或解释文字。
8. 完整结构示例：{"outline":[{"id":"1","title":"技术方案","description":"技术方案目录说明","attr":"技术","content_mode":"ai-generate"},{"id":"2","title":"特殊资料","description":"特殊资料目录说明","attr":"其他","content_mode":"other","content_mode_note":"说明特殊处理原因"}]}。content_mode_note 只在 content_mode=other 且确有说明时填写。
9. 程序已预置 Schema。写入后调用 json-validation，只传 {"file_path":"${OUTLINE_OUTPUT_FILE}"}；校验失败后必须先修改文件，再重新校验。`;
}

function createLeafAllocationPrompt() {
  return `请继续使用当前 Pi Session 已读取的技术评分信息、知识库、原方案和目录规划，为多个技术一级目录分配“AI生成”叶子数量。

要求：
1. 阅读 ${OUTLINE_OUTPUT_FILE}、${TECHNICAL_SCORE_GROUPS_FILE}、${SCORE_DIRECTORY_PLAN_FILE} 和 ${LEAF_ALLOCATION_CONTEXT_FILE}。
2. 综合各一级目录负责的评分项数量、评分细项数量、内容复杂度以及已读取的参考资料，合理分配 allocatable_ai_leaf_count。
3. allocations 必须恰好覆盖 context 中 technical_branches 的全部 branch_id，每个 branch_id 只出现一次，每个目录至少分配 2 个。branch_id 是不会因目录重新编号而变化的内部稳定标识。
4. 所有 leaf_count 之和必须等于 allocatable_ai_leaf_count。
5. 将结果写入 ${LEAF_ALLOCATION_FILE}，保留 context 中的 mode、target_ai_leaf_count、fixed_ai_leaf_count 和 allocatable_ai_leaf_count。
6. 不要修改 ${OUTLINE_OUTPUT_FILE}、${TECHNICAL_SCORE_GROUPS_FILE} 或 ${SCORE_DIRECTORY_PLAN_FILE}。
7. 输出格式为 {"mode":"allocated","target_ai_leaf_count":20,"fixed_ai_leaf_count":1,"allocatable_ai_leaf_count":19,"allocations":[{"branch_id":"B1","leaf_count":10},{"branch_id":"B2","leaf_count":9}]}。
8. 完成后调用 json-validation 校验 ${LEAF_ALLOCATION_FILE}，只传 file_path。`;
}

function createScorePlanningPrompt() {
  return `用户已经确认最终保留的一级目录，${OUTLINE_OUTPUT_FILE} 已由程序重新整理并编号。工作区也已加入技术评分信息和用户选择的参考资料。

请完成技术评分项结构化和目录规划：
1. 阅读 ${OUTLINE_OUTPUT_FILE}、技术评分信息.md，以及存在的原方案.md 和参考知识库目录。
2. 只从技术评分信息.md 的“技术评分项”中提取适合在技术方案中一一响应、展开编写的评分大项。“技术评分要求”只能作为评分标准、扣分规则和编写约束，不得提取为评分项。
3. 将评分大项写入 ${TECHNICAL_SCORE_GROUPS_FILE}，完整结构为 {"groups":[{"requirement_id":"R1","title":"评分大项","description":"关注内容","detail_points":["关键评分细项"]}]}。根对象只能包含 groups；保持原顺序、专业术语和关键评分细项，requirement_id 使用连续的 R1、R2 格式。
4. 判断技术方案位于哪些目录分支，以及每个分支内评分项对应节点应统一处于哪个层级。不同分支可以使用不同层级，不预设必须是二级目录。优先选择 attr=技术且 content_mode=ai-generate 的一级目录；template-fill、point-to-point 和 other 是特殊处理叶子，不得作为普通技术方案分支展开，除非先向用户说明并取得调整批准。
5. 默认每个评分项对应一个独立同层级节点，节点标题与评分大项基本一一对应；detail_points 用于后续生成更下级目录。
6. 只有以下偏离需要用户批准：合并或拆分评分项、遗漏评分项对应节点、增加评分项中不存在的同层级大项、改变分支评分项目标层级，以及新增、删除、合并或调整用户已确认的一级目录。普通标题规范化和评分项下级目录扩展不需要询问。
7. 无论是否存在偏离，都必须调用一次 ask-user 让用户确认。没有偏离时，question 只说明你分析得出的技术方案所在目录和评分项所在层级，最多使用两句话且不要使用列表；存在偏离时，只补充实际需要用户批准的偏离及影响，存在多个实际确认事项时才使用简单 Markdown 分行列出。question、选项名称和选项说明不得复述、概括或改写本任务 Prompt 中的要求，只呈现你分析后确实需要用户确认的结论或不确定事项。第一项给出推荐方案；另提供一个名为“调整目录安排”等明确业务名称的选项并设置 custom=true，让用户说明希望调整的位置或层级，其他选项均设置 custom=false。
8. 根据用户回答写入 ${SCORE_DIRECTORY_PLAN_FILE}。完整字段层级示例：{"branches":[{"branch_id":"B1","root_id":"2","root_title":"技术方案","score_item_level":2,"mappings":[{"requirement_id":"R1","target_title":"评分大项目录标题","additional_titles":["经批准拆分出的同级标题"],"adjustment_note":"用户批准的调整说明"}]}],"extra_titles":[{"branch_id":"B1","title":"经批准增加的同层级标题","reason":"增加原因"}],"allow_root_changes":false}。branches 中每个分支填写唯一且后续保持不变的 branch_id，并用当前 ${OUTLINE_OUTPUT_FILE} 中尚未调整的一级目录编号和标题填写 root_id、root_title；统一填写 score_item_level，并让每个 requirement_id 在 mappings 中恰好出现一次。后续新增、重排或改名一级目录时，branch_id 仍用于稳定关联同一技术分支，不能随 root_id 改变；程序会在完整目录重新编号后同步 root_id 和 root_title。默认一一对应；经用户批准合并时，多个 mapping 可以使用相同 target_title；经用户批准拆分时才填写 mapping.additional_titles；合并或拆分时才填写 adjustment_note。extra_titles 必须位于根对象，经批准增加同层级大项时才写入条目，否则使用空数组。
9. 默认锁定一级目录，allow_root_changes=false；只有用户明确批准一级目录调整时才设为 true。
10. 分别调用 json-validation 校验 ${TECHNICAL_SCORE_GROUPS_FILE} 和 ${SCORE_DIRECTORY_PLAN_FILE}，调用时只传 file_path；校验失败后必须先修改对应文件，再重新校验。
11. 此阶段不要修改 ${OUTLINE_OUTPUT_FILE}。`;
}

function createChildrenPrompt({ hasOriginalPlan, originalOnly, targetLeafCount, allowRootChanges }) {
  const branchInstruction = !hasOriginalPlan
    ? '没有原方案时，以技术评分信息.md 为主要依据生成目录。'
    : originalOnly
      ? '已选择仅使用原方案目录：以原方案.md 为主建立规划层级及以下目录，再用技术评分信息.md 补充原方案语义上确实缺失的技术要求，意思相近的内容不要重复添加。'
      : '已提供原方案且允许 AI 补充：以技术评分信息.md 为主，在评分项目录规划指定的层级覆盖关键大项，原方案.md 用于辅助生成更下级目录。';
  const leafInstruction = targetLeafCount === null
    ? '本次未设置总字数目标，请根据材料复杂度自主确定合理的“AI生成”叶子节点数量。'
    : `严格参考 ${LEAF_ALLOCATION_FILE} 中的分配，使最终完整目录合计约有 ${targetLeafCount} 个 content_mode=ai-generate 的叶子节点。`;
  const rootInstruction = allowRootChanges
    ? `用户已批准 ${SCORE_DIRECTORY_PLAN_FILE} 中记录的一级目录调整，只能按该规划进行必要修改并重新编号。`
    : '一级目录的数量、顺序、id、title、description、attr 均已由用户确认，必须保持不变；未扩展为父节点的一级目录还必须保留其 content_mode。';
  return `请继续使用当前上下文，为 ${OUTLINE_OUTPUT_FILE} 生成完整目录。生成方式和处理顺序由你自主决定，但必须严格遵循评分项目录规划。

要求：
1. ${branchInstruction}
2. 以 ${TECHNICAL_SCORE_GROUPS_FILE} 为技术评分项权威清单，以 ${SCORE_DIRECTORY_PLAN_FILE} 为评分项与目录位置的权威规划。
3. 每个 branch 的 mappings 必须在该分支的 score_item_level 层级生成对应节点。branch_id 是技术分支稳定标识：对应的最终一级目录必须保留同名 branch_id，即使一级目录新增、删除、改名、重排或重新编号也不得改变；非技术分支一级目录不要填写 branch_id。默认每个评分项形成一个独立节点；多个 mapping 使用相同 target_title 表示用户已批准合并，additional_titles 表示用户已批准将该评分项拆成多个同级节点。
4. mappings 中的 target_title 是评分项对应节点标题，必须基本保持评分大项的专业表述；detail_points 主要用于生成其下级目录。
5. extra_titles 是用户已批准增加的同层级大项；除此之外不得自行增加技术评分项中不存在的同层级标题。
6. “技术评分要求”只能作为评分标准、扣分口径、判定规则和目录说明约束，不能生成独立评分项节点。
7. ${rootInstruction}
8. 未纳入评分项目录规划的一级目录和分支保持原样，不得增加子目录。
9. 如果存在参考知识库或原方案，只能用于完善评分项对应节点的下级结构，不得改变评分项映射或引入未经批准的同层级大项。
10. ${leafInstruction}${LEAF_ALLOCATION_FILE} 中 allocations 使用 branch_id 指向技术分支，不使用可能变化的 root_id。评分项完整对应和目录质量优先于数量目标。
11. 每个最终叶子节点必须填写 content_mode：技术方案正文为 ai-generate；从招标文件提取后按模板填写为 template-fill；需要在 Word 页码确定后回填为 point-to-point；其他特殊内容为 other，并用 content_mode_note 说明。父节点不得包含 content_mode 或 content_mode_note。
12. 任意非叶子节点的 children 至少包含两个节点，不要创建只有一个子节点的冗余层级。
13. 目录层级可变，但最多六级；一级目录包含 attr，子目录不包含 attr。所有 id 必须使用层级点号编号：一级为 1、2，二级为 2.1、2.2，三级为 2.1.1、2.1.2，后续层级依此类推，并与实际父子位置一致。
14. title 只写纯标题，不包含章节编号或 Markdown 标记。
15. ${OUTLINE_OUTPUT_FILE} 的完整结构示例：{"outline":[{"id":"1","title":"技术应答表","description":"应答表说明","attr":"技术","content_mode":"point-to-point"},{"id":"2","title":"技术方案","description":"技术方案说明","attr":"技术","branch_id":"B1","children":[{"id":"2.1","title":"评分大项","description":"评分大项说明","children":[{"id":"2.1.1","title":"具体方案一","description":"具体方案说明","content_mode":"ai-generate"},{"id":"2.1.2","title":"具体方案二","description":"具体方案说明","content_mode":"ai-generate"}]},{"id":"2.2","title":"另一评分大项","description":"评分大项说明","content_mode":"ai-generate"}]}]}。branch_id 只写在评分规划对应的技术一级目录上；示例只说明字段位置和编号方式，实际层级与标题必须按任务材料生成。
16. 直接覆盖写回 ${OUTLINE_OUTPUT_FILE}，完成后调用 json-validation 校验，只传 file_path；校验失败后必须先修改文件，再重新校验。`;
}

function createLeafAdjustmentPrompt(targetLeafCount, actualLeafCount) {
  return `程序计算当前完整目录共有 ${actualLeafCount} 个“AI生成”叶子节点，目标是 ${targetLeafCount} 个。

请先调用一次 ask-user，说明目标数、当前数、差距及目录质量影响，只能按以下顺序提供三个固定选项，不得改名、增删或调整顺序：
1. “接受当前结果”，custom=false：保持当前目录并进入最终审核。
2. “允许 Agent 自行调整”，custom=false：由你在不破坏目录质量的前提下合理调整一次。
3. “自定义需求”，custom=true：按用户填写的具体要求调整。

根据本轮 ask-user 回答处理：
1. 用户选择“接受当前结果”时，不要修改 ${OUTLINE_OUTPUT_FILE}。
2. 用户选择“允许 Agent 自行调整”或“自定义需求”时，必须继续遵循 ${SCORE_DIRECTORY_PLAN_FILE}：不得删除、移动或改变评分项对应节点的目标层级，不得新增未经批准的同层级大项；优先调整评分项节点下面的更深层目录。
3. 只通过合理调整 ai-generate 叶子的目录结构满足数量目标，不得为了凑数把 template-fill、point-to-point 或 other 改成 ai-generate，也不得改变非 AI 叶子的处理模式。
4. 调整后仍须保持完整根结构 {"outline":[一级目录节点]}，id 必须使用与父子位置一致的层级点号编号；技术一级目录必须保留 ${SCORE_DIRECTORY_PLAN_FILE} 中对应的 branch_id，不能因增删、移动或重新编号而改变；父节点只含 children，不含 content_mode，叶子节点只含 content_mode，不含 children。
5. 不要机械增加重复、空泛或近义目录。完成调整后覆盖写回 ${OUTLINE_OUTPUT_FILE}，并调用 json-validation 校验，只传 file_path；校验失败后必须先修改文件，再重新校验。`;
}

function createOutlineReviewPrompt({ targetLeafCount, actualLeafCount, allowRootChanges }) {
  const leafCountReview = targetLeafCount === null
    ? ''
    : `\n- “AI生成”叶子数量：程序计算目标为 ${targetLeafCount} 个，当前为 ${actualLeafCount} 个，可接受范围为 ${Math.max(1, targetLeafCount - 2)} 至 ${targetLeafCount + 2} 个。只统计 content_mode=ai-generate 的最终叶子节点；修复后仍须保持在此范围内。`;
  const rootRequirement = allowRootChanges
    ? `一级目录只能保持用户已批准的 ${SCORE_DIRECTORY_PLAN_FILE} 规划，不得提出规划之外的新调整。`
    : '一级目录已经由用户确认，数量、顺序、标题、描述和属性不得修改。';
  return `请对当前完整技术方案目录执行最终审核，并在用户确认后完成必要修复。

开始审核时一次性并行读取 ${OUTLINE_REVIEW_CONTEXT_FILE}、${OUTLINE_OUTPUT_FILE}、技术评分信息.md 和 ${SCORE_DIRECTORY_PLAN_FILE}，不要探索工作区或读取其他文件。${OUTLINE_REVIEW_CONTEXT_FILE} 是宿主程序计算的确定性审核结果，叶子数量、内容模式数量、最大层级、父节点数量、单子节点和评分节点机械映射均直接采用其中结果，不要重新统计、编写脚本或执行额外结构检查；你只负责评分语义覆盖、近义重复和专业合理性审核。

审核维度：${leafCountReview}
- 评分覆盖：直接以技术评分信息.md 为原始依据，逐项检查其中适合技术方案响应的评分大项是否被目录准确覆盖；结构化评分项和目录规划用于核对已确认的映射，但不能掩盖原始评分信息中的遗漏。
- 重复目录：检查全部子目录中是否存在重复、近义、含义重叠或仅换一种说法的节点；不同专业分支下确有独立含义的同名标题不应机械判重。
- 专业合理性：评估目录层级、颗粒度、逻辑顺序、标题表达、节点归属以及内容处理模式是否适合正式技术投标文件。

审核与修复流程：
1. 必须先完整审核并形成问题清单，不得边审核边修改。
2. 如果没有问题，不要修改 ${OUTLINE_OUTPUT_FILE}；写入 ${OUTLINE_REVIEW_FILE}，status=passed、issues=[]、user_feedback=""，summary 说明通过原因。
3. 如果发现问题，先为每个问题记录 category、problem、推荐 repair 和 confirmation_required，不得提前修改目录。
4. 只有以下问题可设 confirmation_required=false：标题或说明的专业化优化；不涉及评分项映射节点、目标层级和一级目录的明显重复或近义子目录合并。评分覆盖缺失、叶子数量超出合理范围、评分项目标层级调整、一级目录调整、增加或拆分目录、跨分支移动以及明显结构重排均必须设为 true。
5. 如果全部问题都不需要确认，可以直接执行文案优化或轻微去重，不得调用 ask-user；完成后设置 status=simple_fix、user_feedback=""。静默修复不得改变评分项映射、评分项目标层级和一级目录，且不得使 AI 生成叶子数量超出程序给出的合理范围。
6. 只要存在一个 confirmation_required=true 的问题，本轮所有问题都不得提前修改。集中调用一次 ask-user，question 使用多行文本完整列出问题及推荐修复方案；提供 2 至 5 个互斥选项，第一项是推荐修复方案，并提供保留当前目录的选项；另提供一个名为“调整修复方案”等明确业务名称的选项并设置 custom=true，让用户说明具体修改要求，其他选项均设置 custom=false。custom=true 的选项最多只能有一个。
7. 根据 ask-user 返回的 answer 执行最终处理：用户要求全部或部分修改时更新 ${OUTLINE_OUTPUT_FILE} 并设置 status=user_feedback；用户明确拒绝修改或要求保留现状时不得修改目录并设置 status=user_refuse。将 answer 原文完整写入 user_feedback，修改完成后不得再次询问用户。
8. ${rootRequirement}
9. 修复必须继续遵守 ${SCORE_DIRECTORY_PLAN_FILE} 中用户确认的评分项映射、目标层级和一级目录调整边界。补回遗漏映射、合并重复目录或优化层级时，不得引入未经用户批准的评分大项规划变更。
10. 技术一级目录必须保留 ${SCORE_DIRECTORY_PLAN_FILE} 中对应的 branch_id；调整一级目录顺序或编号时不得修改 branch_id。结构事实以 ${OUTLINE_REVIEW_CONTEXT_FILE} 为准；如果其中确定性检查不通过，直接依据列出的节点和缺失项形成问题并修复，不要重新统计。任何语义修复仍必须保证叶子保留合法 content_mode、父节点不包含 content_mode 或 content_mode_note、父节点至少有两个 children 且目录最多六级。
11. 最终将完整问题清单和处理结果写入 ${OUTLINE_REVIEW_FILE}。无问题时完整格式为 {"status":"passed","issues":[],"user_feedback":"","summary":"审核通过原因"}；有问题时完整格式为 {"status":"user_feedback","issues":[{"category":"score-coverage","problem":"问题说明","repair":"修复方案","confirmation_required":true}],"user_feedback":"用户回答原文","summary":"处理结果"}。category 只能是 leaf-count、score-coverage、duplicate-directory、professional-structure；status 按本流程选择 passed、simple_fix、user_feedback 或 user_refuse。
12. 分别调用 json-validation 校验 ${OUTLINE_OUTPUT_FILE} 和 ${OUTLINE_REVIEW_FILE}，只传 file_path；校验失败后必须先修改对应文件，再重新校验。`;
}

// 运行 V2 目录业务任务；完整 Agent 执行之间通过程序确认衔接并复用同一持久 Session。
async function runOutlineGenerationTaskV2({ agentService, workspaceStore, knowledgeBaseService, updateTask, checkpointTask, taskControl, payload }) {
  const storedPlan = workspaceStore.loadTechnicalPlan() || {};
  const restoringOutlineSelection = payload?.agent_resume?.phase === 'outline-selection';
  const hasOriginalPlan = Boolean(storedPlan.originalPlanFile);
  const originalOnly = hasOriginalPlan && storedPlan.outlineExpansionMode === 'original-only';
  const originalPlan = hasOriginalPlan ? workspaceStore.readOriginalPlanMarkdown() : '';
  const responseFileRequirements = storedPlan.bidAnalysisTasks?.responseFileRequirements?.content || '';
  const wordControlOptions = normalizeWordControlOptions(payload?.word_control_options || storedPlan.outlineWordControlOptions);
  const targetLeafCount = deriveTargetLeafCount(wordControlOptions);
  const referenceDocumentIds = normalizeReferenceDocumentIds(storedPlan);
  const knowledgeFiles = buildKnowledgeFiles(knowledgeBaseService, referenceDocumentIds);
  const jsonValidationSchemas = {
    [OUTLINE_OUTPUT_FILE]: OUTLINE_JSON_SCHEMA,
    [TECHNICAL_SCORE_GROUPS_FILE]: TECHNICAL_SCORE_GROUPS_SCHEMA,
    [SCORE_DIRECTORY_PLAN_FILE]: SCORE_DIRECTORY_PLAN_SCHEMA,
    [LEAF_ALLOCATION_FILE]: LEAF_ALLOCATION_SCHEMA,
    [OUTLINE_REVIEW_FILE]: OUTLINE_REVIEW_SCHEMA,
  };

  let initialFiles;
  let taskInstruction;
  if (originalOnly) {
    initialFiles = [{ path: '原方案.md', content: originalPlan }];
    taskInstruction = '只根据原方案材料提取一级目录。';
  } else {
    initialFiles = [
      { path: '响应文件要求.md', content: responseFileRequirements },
      { path: '项目概述.md', content: storedPlan.projectOverview || '' },
      ...(hasOriginalPlan ? [{ path: '原方案.md', content: originalPlan }] : []),
    ];
    taskInstruction = hasOriginalPlan
      ? '严格按照响应文件要求.md 组织一级目录，它是目录结构和标题来源的唯一依据。项目概述.md 仅用于理解背景和术语，不得据此新增一级目录；原方案.md 仅用于参考标题表达。'
      : '严格按照响应文件要求.md 组织一级目录，它是目录结构和标题来源的唯一依据。项目概述.md 仅用于理解背景和术语，不得据此新增一级目录。';
  }

  let logs = restoringOutlineSelection
    ? [...(Array.isArray(storedPlan.outlineGenerationTask?.logs) ? storedPlan.outlineGenerationTask.logs : []), '已恢复一级目录确认状态']
    : ['开始生成一级目录'];
  let currentProgress = restoringOutlineSelection ? Number(storedPlan.outlineGenerationTask?.progress || 30) : 10;
  const initialCheckpoint = checkpointTask({ status: 'running', progress: currentProgress, logs });
  let task = initialCheckpoint.task;
  let lockedRoots = [];
  let technicalBranches = [];
  let scoreDirectoryPlan = null;
  let allowRootChanges = false;
  let fixedAiLeafCount = 0;
  let allocatedAiLeafCount = null;
  let finalOutline = null;
  let actualLeafCount = 0;
  let leafWarning = '';
  let wordAdjustmentAttempts = 0;
  let outlineReview = null;

  function updateAgentState(partial = {}) {
    const checkpoint = checkpointTask({
      stats: {
        ...(task.stats || {}),
        agent: {
          ...(task.stats?.agent || {}),
          task_key: OUTLINE_AGENT_TASK_KEY,
          run_id: task.task_id,
          resume_payload: {
            reference_knowledge_document_ids: referenceDocumentIds,
            outline_mode: storedPlan.outlineMode,
            outline_expansion_mode: storedPlan.outlineExpansionMode,
            word_control_options: wordControlOptions,
          },
          ...partial,
        },
      },
    });
    task = checkpoint.task;
  }

  function publish(message, progress, statsPatch = {}) {
    const text = String(message || '').trim();
    if (text && text !== logs[logs.length - 1]) logs = [...logs, text];
    currentProgress = Math.max(currentProgress, progress || currentProgress);
    task = updateTask({
      status: 'running',
      progress: currentProgress,
      logs,
      stats: { ...(task.stats || {}), ...statsPatch },
    });
  }

  function publishAgentActivity(event = {}) {
    const title = formatProgressTitle(event.message);
    if (!title || event.visible === false) return;
    publish(title, Math.max(currentProgress, 20));
  }

  function syncAgentCheckpoint(checkpoint) {
    updateAgentState({
      status: checkpoint.status,
      phase: checkpoint.phase,
      agent_connection: checkpoint.agent_connection,
      session_file: checkpoint.session_file,
    });
  }

  function applyConfirmedSelection(confirmed) {
    const selectedIdSet = new Set(confirmed.selectedIds);
    lockedRoots = renumberOutline(confirmed.items.filter((item) => selectedIdSet.has(item.id)));
    const checkpoint = checkpointTask({
      stats: {
        ...(task.stats || {}),
        outline_selection: {
          items: confirmed.items,
          selected_ids: confirmed.selectedIds,
          confirmed: true,
        },
      },
    });
    task = checkpoint.task;
  }

  function continueWithChildrenGeneration(allocations) {
    publish('技术方案目录已确认，开始生成子目录', 55, {
      outline: {
        phase: 'generating',
        current_leaf_count: 0,
        target_leaf_count: targetLeafCount,
        word_adjustment_attempts: 0,
      },
    });
    return {
      stage: 'children_generation',
      message: 'Agent 正在生成子目录',
      prompt: createChildrenPrompt({ hasOriginalPlan, originalOnly, targetLeafCount, allowRootChanges }),
      files: [
        { path: OUTLINE_OUTPUT_FILE, content: JSON.stringify({ outline: lockedRoots }, null, 2) },
        {
          path: LEAF_ALLOCATION_FILE,
          content: JSON.stringify({
            mode: targetLeafCount === null ? 'agent-decides' : 'allocated',
            target_ai_leaf_count: targetLeafCount,
            fixed_ai_leaf_count: fixedAiLeafCount,
            allocatable_ai_leaf_count: allocatedAiLeafCount,
            allocations,
          }, null, 2),
        },
      ],
    };
  }

  function continueWithOutlineReview() {
    const reviewContext = buildOutlineReviewContext({
      outline: finalOutline,
      scoreDirectoryPlan,
      targetLeafCount,
    });
    publish('子目录生成完成，正在准备最终审核', 88, {
      outline: {
        phase: 'reviewing',
        current_leaf_count: actualLeafCount,
        target_leaf_count: targetLeafCount,
        word_adjustment_attempts: wordAdjustmentAttempts,
      },
    });
    return {
      stage: 'outline_review',
      message: 'Agent 正在审核并修复目录',
      prompt: createOutlineReviewPrompt({ targetLeafCount, actualLeafCount, allowRootChanges }),
      files: [
        { path: OUTLINE_OUTPUT_FILE, content: JSON.stringify(finalOutline, null, 2) },
        { path: SCORE_DIRECTORY_PLAN_FILE, content: JSON.stringify(scoreDirectoryPlan, null, 2) },
        { path: OUTLINE_REVIEW_CONTEXT_FILE, content: JSON.stringify(reviewContext, null, 2) },
      ],
    };
  }

  if (!restoringOutlineSelection) {
    updateAgentState({ status: 'running', phase: 'initial-outline', agent_connection: 'running', session_file: '' });
    const initialResult = await agentService.runTask({
      task_id: task.task_id,
      title: '技术方案一级目录生成',
      prompt: createInitialPrompt(taskInstruction),
      output_file: OUTLINE_OUTPUT_FILE,
      files: initialFiles,
      signal: taskControl.signal,
      persistent_task: {
        task_key: OUTLINE_AGENT_TASK_KEY,
        mode: 'create',
      },
      initial_stage: 'initial-outline',
      initial_stage_index: 0,
      json_validation_schemas: jsonValidationSchemas,
      max_retries: 0,
      onActivity: publishAgentActivity,
      onCheckpoint: syncAgentCheckpoint,
    });
    const generated = readJson(initialResult.output_content, OUTLINE_OUTPUT_FILE);
    const items = generated.outline || [];
    const defaultSelectedIds = items.filter((item) => item.attr === '技术').map((item) => item.id);
    const selection = { items, selected_ids: defaultSelectedIds, confirmed: false };
    publish('一级目录已生成，等待用户确认', 30, { outline_selection: selection });
    agentService.updatePersistentTask(OUTLINE_AGENT_TASK_KEY, {
      status: 'waiting-outline-selection',
      phase: 'outline-selection',
      agent_connection: 'idle',
      error: null,
    });
    updateAgentState({ status: 'waiting-outline-selection', phase: 'outline-selection', agent_connection: 'idle' });
  }

  const confirmed = await taskControl.waitForOutlineSelection();
  applyConfirmedSelection(confirmed);
  publish('一级目录已确认，正在识别技术方案目录', 40);
  agentService.updatePersistentTask(OUTLINE_AGENT_TASK_KEY, {
    status: 'running',
    phase: 'score-planning',
    agent_connection: 'idle',
  });
  updateAgentState({ status: 'running', phase: 'score-planning', agent_connection: 'idle' });

  const agentResult = await agentService.runTask({
    task_id: task.task_id,
    title: '技术方案目录生成 V2',
    prompt: createScorePlanningPrompt(),
    output_file: OUTLINE_OUTPUT_FILE,
    files: [
      { path: OUTLINE_OUTPUT_FILE, content: JSON.stringify({ outline: lockedRoots }, null, 2) },
      { path: '技术评分信息.md', content: storedPlan.techRequirements || '' },
      ...knowledgeFiles,
    ],
    signal: taskControl.signal,
    persistent_task: {
      task_key: OUTLINE_AGENT_TASK_KEY,
      mode: 'resume',
    },
    initial_stage: 'score-planning',
    initial_stage_index: 1,
    json_validation_schemas: jsonValidationSchemas,
    max_retries: 0,
    onActivity: publishAgentActivity,
    onCheckpoint: syncAgentCheckpoint,
    continueTask: async (candidate, meta) => {
      if (meta.workflow_stage === 'outline_review') {
        const reviewedOutline = readJson(candidate.output_content, OUTLINE_OUTPUT_FILE);
        const normalizedReviewedOutline = buildFinalOutline(reviewedOutline);
        outlineReview = readJson(await meta.readFile(OUTLINE_REVIEW_FILE), OUTLINE_REVIEW_FILE);
        finalOutline = normalizedReviewedOutline;
        scoreDirectoryPlan = synchronizeScoreDirectoryPlan(scoreDirectoryPlan, finalOutline.outline);
        actualLeafCount = countAiLeaves(finalOutline.outline);
        await meta.writeFiles([
          { path: OUTLINE_OUTPUT_FILE, content: JSON.stringify(finalOutline, null, 2) },
          { path: SCORE_DIRECTORY_PLAN_FILE, content: JSON.stringify(scoreDirectoryPlan, null, 2) },
        ]);
        if (targetLeafCount !== null) {
          if (actualLeafCount === targetLeafCount) {
            leafWarning = '';
          } else if (leafWarning) {
            leafWarning = `AI 生成小节目标为 ${targetLeafCount}，用户已确认最终保留当前 ${actualLeafCount} 个。`;
          }
        }
        const reviewMessage = outlineReview.status === 'passed'
          ? '目录审核通过'
          : outlineReview.status === 'simple_fix'
            ? '目录审核完成，Agent 已自动微调简单问题'
            : outlineReview.status === 'user_feedback'
              ? '目录审核完成，已按用户反馈修复'
              : '目录审核完成，用户选择保留当前目录';
        publish(reviewMessage, 95, {
          outline: {
            phase: 'reviewing',
            current_leaf_count: actualLeafCount,
            target_leaf_count: targetLeafCount,
            word_adjustment_attempts: wordAdjustmentAttempts,
          },
        });
        return { complete: true };
      }

      if (meta.stage === 1) {
        scoreDirectoryPlan = readJson(await meta.readFile(SCORE_DIRECTORY_PLAN_FILE), SCORE_DIRECTORY_PLAN_FILE);
        lockedRoots = attachBranchIdsToRoots(lockedRoots, scoreDirectoryPlan);
        technicalBranches = scoreDirectoryPlan.branches.map((branch) => ({
          branch_id: branch.branch_id,
          root_id: branch.root_id.split('.')[0],
          root_title: branch.root_title,
        }));
        allowRootChanges = scoreDirectoryPlan.allow_root_changes === true;
        fixedAiLeafCount = lockedRoots
          .filter((root) => !root.branch_id && root.content_mode === AI_CONTENT_MODE).length;
        allocatedAiLeafCount = targetLeafCount === null ? null : targetLeafCount - fixedAiLeafCount;
        if (allocatedAiLeafCount !== null && technicalBranches.length > 1) {
          publish('技术方案目录已确认，Agent 正在分配 AI 生成小节', 50);
          return {
            stage: 'leaf_allocation',
            message: 'Agent 正在分配 AI 生成小节',
            prompt: createLeafAllocationPrompt(),
            files: [{
              path: LEAF_ALLOCATION_CONTEXT_FILE,
              content: JSON.stringify({
                mode: 'allocated',
                target_ai_leaf_count: targetLeafCount,
                fixed_ai_leaf_count: fixedAiLeafCount,
                allocatable_ai_leaf_count: allocatedAiLeafCount,
                technical_branches: technicalBranches,
              }, null, 2),
            }],
          };
        }
        const allocations = allocatedAiLeafCount === null
          ? technicalBranches.map((branch) => ({ branch_id: branch.branch_id }))
          : [{ branch_id: technicalBranches[0].branch_id, leaf_count: allocatedAiLeafCount }];
        return continueWithChildrenGeneration(allocations);
      }

      if (meta.workflow_stage === 'leaf_allocation') {
        const allocationPayload = readJson(await meta.readFile(LEAF_ALLOCATION_FILE), LEAF_ALLOCATION_FILE);
        return continueWithChildrenGeneration(allocationPayload.allocations);
      }

      const candidateOutline = readJson(candidate.output_content, OUTLINE_OUTPUT_FILE);
      finalOutline = buildFinalOutline(candidateOutline);
      scoreDirectoryPlan = synchronizeScoreDirectoryPlan(scoreDirectoryPlan, finalOutline.outline);
      actualLeafCount = countAiLeaves(finalOutline.outline);
      const latestLeafAnswer = meta.workflow_stage === 'leaf_adjustment'
        ? [...meta.user_question_answers].reverse().find((item) => item.workflow_stage === 'leaf_adjustment')
        : null;
      if (latestLeafAnswer && latestLeafAnswer.selected_option !== '接受当前结果') {
        wordAdjustmentAttempts += 1;
      }
      if (targetLeafCount === null || actualLeafCount === targetLeafCount) return continueWithOutlineReview();

      if (latestLeafAnswer?.selected_option === '接受当前结果') {
        leafWarning = `AI 生成小节目标为 ${targetLeafCount}，用户已接受当前 ${actualLeafCount} 个。`;
        return continueWithOutlineReview();
      }

      publish('AI 生成小节数量存在差异，等待用户决定', 75, {
        outline: {
          phase: 'word-adjusting',
          current_leaf_count: actualLeafCount,
          target_leaf_count: targetLeafCount,
          word_adjustment_attempts: wordAdjustmentAttempts,
        },
      });
      return {
        stage: 'leaf_adjustment',
        message: 'Agent 正在询问如何处理小节数量差异',
        prompt: createLeafAdjustmentPrompt(targetLeafCount, actualLeafCount),
        files: [
          { path: OUTLINE_OUTPUT_FILE, content: JSON.stringify(finalOutline, null, 2) },
          { path: SCORE_DIRECTORY_PLAN_FILE, content: JSON.stringify(scoreDirectoryPlan, null, 2) },
        ],
      };
    },
  });

  if (!finalOutline) {
    const candidateOutline = readJson(agentResult.output_content, OUTLINE_OUTPUT_FILE);
    finalOutline = buildFinalOutline(candidateOutline);
    scoreDirectoryPlan = synchronizeScoreDirectoryPlan(scoreDirectoryPlan, finalOutline.outline);
    actualLeafCount = countAiLeaves(finalOutline.outline);
  }
  const persistedFinalOutline = stripOutlineInternalFields(finalOutline);
  const finalLogs = [...logs, '目录生成与审核完成', ...(leafWarning ? [leafWarning] : [])];
  const finalTaskPatch = {
    status: 'success',
    progress: 100,
    error: undefined,
    logs: finalLogs,
    stats: {
      ...(task.stats || {}),
      outline: {
        phase: 'done',
        current_leaf_count: actualLeafCount,
        target_leaf_count: targetLeafCount,
        leaf_counts_by_mode: countLeavesByMode(finalOutline.outline),
        word_adjustment_attempts: wordAdjustmentAttempts,
        ...(leafWarning ? { word_adjustment_warning: leafWarning, word_adjustment_warning_kind: 'leaf-count' } : {}),
      },
    },
  };
  const finalCheckpoint = checkpointTask(finalTaskPatch, {
    outlineData: { ...persistedFinalOutline, project_overview: storedPlan.projectOverview || '' },
    outlineWordControlSnapshot: wordControlOptions,
    contentGenerationTask: undefined,
    contentGenerationSections: {},
    contentGenerationPlans: {},
    contentGenerationRuntime: undefined,
    contentIllustrationPlan: undefined,
  });
  task = finalCheckpoint.task;
  agentService.updatePersistentTask(OUTLINE_AGENT_TASK_KEY, {
    status: 'success',
    phase: 'completed',
    agent_connection: 'idle',
    error: null,
    completed_at: new Date().toISOString(),
  });
}

module.exports = { runOutlineGenerationTaskV2 };
