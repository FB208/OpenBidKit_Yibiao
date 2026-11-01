const crypto = require('node:crypto');
const Ajv = require('ajv');
const { MARKDOWN_MISSING_RESULT } = require('./bidAnalysisTask.cjs');
const { RULE_PAGE_AGENT_TASK_KEY } = require('./businessTemplateFillAgentConfig.cjs');
const { loadBusinessFillScope, collectLayoutFieldIds, renderBusinessTemplate } = require('./businessTemplateFillTask.cjs');
const { CONTINUE_PROMPT, wasStagePrompted } = require('./contentGenerationAgent.cjs');
const { RULE_FILL_BY, formatPageToken, collectRulePageChapterIds } = require('./rulePageTables.cjs');
const { collectOutlineLeaves, numberOutline } = require('./technicalPlanOutline.cjs');

const RULE_PAGE_STAGE = 'rule-page-compile';
const TABLES_INPUT_FILE = '规则表.json';
const OUTLINE_INPUT_FILE = '投标文件目录.md';
const TENDER_INPUT_FILE = '招标文件.md';
const BID_INFO_INPUT_FILE = '招标关键信息.md';
const GLOBAL_FACTS_INPUT_FILE = '全局事实设定.md';
const OUTPUT_FILE = '规则表结果.json';
// 编制结果文件版本：清单表的行按 from（原地填写表格第几行）/ like（照第几行新增）记录、格子按网格列写入，另有重建表和新建表。
const RULE_PAGE_TABLES_VERSION = 3;
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const CONTENT_MODE_LABELS = {
  'ai-generate': 'AI生成',
  'template-fill': '模板填写',
  'rule-page': '规则和页码',
  'directory-generate': '目录生成',
  'manual-fill': '人工填写',
  other: '其他模式',
};
// 应答依据对应的评分要求：程序按目录标明的依据只给对应文件，不让 Agent 自行判断该参考哪一份。
const SCORING_REFERENCES = {
  technical: { taskId: 'techRequirements', file: '技术评分要求.md', label: '技术评分要求', part: '技术' },
  business: { taskId: 'businessScoring', file: '商务评分要求.md', label: '商务评分要求', part: '商务' },
};
const RULE_BASIS_KEYS = { technical: ['technical'], business: ['business'], both: ['technical', 'business'] };
// Agent 写目录编号，程序换成稳定节点 ID；允许全角冒号和多余空格。
const AGENT_PAGE_REF_PATTERN = /\{\{\s*页码\s*[:：]\s*([^{}]*?)\s*\}\}/g;

const nonEmptyString = { type: 'string', minLength: 1 };
const RULE_PAGE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tables', 'unresolved'],
  properties: {
    tables: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'rows'],
        properties: {
          id: nonEmptyString,
          rebuild: { type: 'boolean' },
          columns: { type: 'array', minItems: 2, items: nonEmptyString },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                from: { type: 'integer', minimum: 1 },
                like: { type: 'integer', minimum: 1 },
                group: nonEmptyString,
                values: { type: 'object', additionalProperties: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    unresolved: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'row', 'column', 'reason'],
        properties: {
          id: nonEmptyString,
          row: { type: 'integer', minimum: 1 },
          column: nonEmptyString,
          reason: nonEmptyString,
        },
      },
    },
  },
};
const validateResultSchema = new Ajv({ allErrors: true, strict: true }).compile(RULE_PAGE_RESULT_SCHEMA);

function textOf(value) {
  return String(value ?? '').trim();
}

// 章节模版内容转为文字给 Agent 参考，规则表的数据行和表格位置换成【T…】标记。
function renderLayoutText(blocks = [], fieldsById, markers) {
  const lines = [];
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      const text = (block.segments || []).map(segment => (segment.field_id
        ? markers.get(segment.field_id) || `［${fieldsById.get(segment.field_id)?.name || '待填写'}］`
        : segment.break ? '\n' : segment.tab ? ' ' : segment.text || '')).join('');
      if (text.trim()) lines.push(text);
    } else if (block.type === 'field') {
      lines.push(markers.get(block.field_id) || renderLayoutText(block.blocks, fieldsById, markers).join('\n'));
    } else if (block.type === 'table') {
      const marked = new Set();
      for (const row of block.rows || []) {
        const cells = row.cells.map(cell => renderLayoutText(cell.blocks, fieldsById, markers).join(' '));
        const marker = cells.find(cell => /^【T\d+[：:]/.test(cell));
        if (marker) {
          if (!marked.has(marker)) lines.push(marker);
          marked.add(marker);
          continue;
        }
        lines.push(`| ${cells.join(' | ')} |`);
      }
    }
  }
  return lines;
}

// 版式中含有给定字段的表格，按文档顺序取第一张。
function findLayoutTable(blocks = [], fieldIds) {
  for (const block of blocks) {
    if (block.type === 'field') {
      const nested = findLayoutTable(block.blocks, fieldIds);
      if (nested) return nested;
    }
    if (block.type !== 'table') continue;
    if ((block.rows || []).some(row => row.cells.some(cell => [...collectLayoutFieldIds(cell.blocks)].some(id => fieldIds.has(id))))) return block;
  }
  return null;
}

/**
 * 模版表格的全部行（含表头行、分段行），从 1 起编号；每格给出网格列、名称、是否待填和原文（待填处标为“［待填：名称］”）。
 * 名称取上方最近一个同格数、不含待填格的行（表头）同位置文字；待填格取不到时用字段名，其余写“第N格”；同一行内重名时加格号。
 * 补齐的 gridBefore / gridAfter 空格没有网格列，不列出。
 */
function describeTableRows(table, ids, fieldsById, markers) {
  const result = [];
  (table.rows || []).forEach((row, rowIndex) => {
    const cells = (row.cells || []).filter(cell => cell.column !== undefined);
    const header = [...result].reverse().find(item => item.cells.length === cells.length && !item.cells.some(cell => cell.fill));
    const labels = [];
    const described = cells.map((cell, index) => {
      const fieldIds = [...collectLayoutFieldIds(cell.blocks)].filter(fieldId => ids.has(fieldId));
      const base = header?.cells[index]?.text || (fieldIds.length ? fieldsById.get(fieldIds[0])?.name : '') || `第${index + 1}格`;
      const label = labels.includes(base) ? `${base}（第${index + 1}格）` : base;
      labels.push(label);
      const cellMarkers = new Map([...markers, ...fieldIds.map(fieldId => [fieldId, `［待填：${label}］`])]);
      const text = renderLayoutText(cell.blocks, fieldsById, cellMarkers).join(' ').replace(/\s+/g, ' ').trim();
      return { column: cell.column, label, fill: fieldIds.length > 0, text };
    });
    result.push({ row: rowIndex + 1, cells: described });
  });
  return result;
}

/**
 * 当前目录中规则和页码章节的待编制表格：清单表给出全部行及各格名称，由 Agent 决定每行原地填写（from）、照某行新增（like）
 * 或整表重建；表格位置（kind=table 字段）由 Agent 按编制说明确定列。每张表带目录标明的应答依据（basis）。
 * 程序编号 T1…，结果按编号回写。不按内容判断表格是预印还是空白，行的取舍和增减都交给 Agent。
 */
function collectRuleTableSpecs(scope, outline) {
  const ruleChapterIds = new Set(collectRulePageChapterIds(outline, scope.template));
  const basisById = new Map(collectOutlineLeaves(outline).map(({ item }) => [item.id, item.rule_basis]));
  const fieldsById = new Map((scope.template.fields || []).map(field => [field.id, field]));
  const specs = [];
  for (const chapter of scope.chapters.filter(item => ruleChapterIds.has(item.id))) {
    const chapterFieldIds = collectLayoutFieldIds(chapter.blocks);
    const ruleFields = (scope.template.fields || []).filter(field => chapterFieldIds.has(field.id) && field.fill_by === RULE_FILL_BY);
    const basis = basisById.get(chapter.id);
    const markers = new Map();
    const chapterSpecs = [];
    for (const tableId of [...new Set(ruleFields.filter(field => field.table_id).map(field => field.table_id))]) {
      const fields = ruleFields.filter(field => field.table_id === tableId);
      const id = `T${specs.length + chapterSpecs.length + 1}`;
      const ids = new Set(fields.map(field => field.id));
      const table = findLayoutTable(chapter.blocks, ids);
      if (!table) continue;
      for (const field of fields) markers.set(field.id, `［${id}待填：${field.name}］`);
      chapterSpecs.push({
        id,
        node_id: chapter.id,
        chapter: chapter.title,
        basis,
        kind: 'list',
        field_ids: fields.map(field => field.id),
        rows: describeTableRows(table, ids, fieldsById, markers),
      });
    }
    for (const field of ruleFields.filter(item => item.kind === 'table')) {
      const id = `T${specs.length + chapterSpecs.length + 1}`;
      markers.set(field.id, `【${id}：在此新建表格】`);
      chapterSpecs.push({
        id,
        node_id: chapter.id,
        chapter: chapter.title,
        basis,
        kind: 'new',
        name: field.name,
        ...(field.instruction ? { instruction: field.instruction } : {}),
        slot: field.id,
      });
    }
    const chapterText = renderLayoutText(chapter.blocks, fieldsById, markers).join('\n');
    specs.push(...chapterSpecs.map(spec => ({ ...spec, chapter_text: chapterText })));
  }
  return specs;
}

// 已解析的评分要求原文；未解析、解析失败或整项未提取到时为空。
function readScoringReferences(bidAnalysisTasks = {}) {
  return Object.fromEntries(Object.entries(SCORING_REFERENCES).map(([key, reference]) => {
    const task = bidAnalysisTasks[reference.taskId];
    const content = task?.status === 'success' ? textOf(task.content) : '';
    return [key, content === MARKDOWN_MISSING_RESULT ? '' : content];
  }));
}

// 本次要写入工作区的评分要求文件：只写有表格依据它、且已解析出内容的那几份。
function collectScoringReferenceFiles(specs, references) {
  const keys = new Set(specs.flatMap(spec => RULE_BASIS_KEYS[spec.basis] || []));
  return Object.entries(SCORING_REFERENCES)
    .filter(([key]) => keys.has(key) && references[key])
    .map(([key, reference]) => ({ path: reference.file, content: `${references[key]}\n` }));
}

// 每张表的应答依据说明：写明应答哪一部分、参考哪个文件；没有依据或没有对应评分要求时明确只依据招标原文条款。
function describeRuleBasis(basis, references) {
  const keys = RULE_BASIS_KEYS[basis];
  if (!keys) return '本表未指定应答依据：只依据表格所指的招标原文条款，不参考评分要求文件。';
  const describe = (key) => {
    const reference = SCORING_REFERENCES[key];
    return references[key] ? `参考 ${reference.file}` : `本次没有${reference.label}，只依据招标原文条款`;
  };
  if (keys.length === 1) return `本表应答${SCORING_REFERENCES[keys[0]].part}部分，${describe(keys[0])}。`;
  return `本表同时应答技术和商务：${keys.map(key => `${SCORING_REFERENCES[key].part}条目${describe(key)}`).join('；')}。`;
}

function buildTablesInput(specs, references) {
  return {
    tables: specs.map(spec => ({
      id: spec.id,
      chapter: spec.chapter,
      kind: spec.kind,
      basis: describeRuleBasis(spec.basis, references),
      ...(spec.kind === 'list'
        ? {
          template_rows: spec.rows.map(row => {
            const fill = row.cells.filter(cell => cell.fill).map(cell => cell.label);
            return {
              row: row.row,
              text: `| ${row.cells.map(cell => cell.text).join(' | ')} |`,
              cells: row.cells.map(cell => cell.label),
              ...(fill.length ? { fill } : {}),
            };
          }),
        }
        : { name: spec.name }),
      ...(spec.instruction ? { instruction: spec.instruction } : {}),
      chapter_text: spec.chapter_text,
    })),
  };
}

// 投标文件目录：编号、标题、处理方式和说明，页码引用按编号指向小节。
function buildOutlineInput(outline) {
  const lines = [];
  const visit = (items, depth) => {
    for (const item of items || []) {
      const mode = item.children?.length ? '' : `（${CONTENT_MODE_LABELS[item.content_mode] || item.content_mode}）`;
      const description = textOf(item.description);
      lines.push(`${'  '.repeat(depth)}- ${item.number} ${item.title}${mode}${description ? `：${description}` : ''}`);
      visit(item.children, depth + 1);
    }
  };
  visit(numberOutline(outline), 0);
  return lines.join('\n');
}

function createRulePagePrompt({ resume = false, hasGlobalFacts = false, referenceFiles = [] } = {}) {
  return `请只在当前工作目录内工作。已有材料足以判断时自主执行，不要调用 ask-user。${resume ? '这是之前中断任务的继续：先检查已有的结果文件，保留有效内容，只补齐或修正未完成部分。' : ''}

任务：按招标文件规定编制投标文件中规则表的行内容，结果写入 ${OUTPUT_FILE}。程序会校验结果并写入 Word，你不读写任何 Word 文件，也不修改输入文件。

输入文件：
- ${TABLES_INPUT_FILE}：需要编制的表格。每张表的 basis 写明这张表应答的部分和应参考的评分要求文件，按 basis 执行，不使用其他评分要求。kind=list 是招标文件给出的表格：template_rows 按顺序列出表格的每一行（含表头行、分段行），text 是该行原文，［待填：名称］是待填的格子，cells 是该行各格的名称，fill 是其中待填格的名称；行可能是空行，也可能已印好招标文件的内容（评分项、招标要求、序号等）。kind=new 是招标文件只给出编制说明（instruction）的位置，由你按说明确定列（columns）并逐行填写。chapter_text 是该章的模版内容，【T…】或［T…］标出表格位置。${referenceFiles.map(file => `
- ${file}：招标文件解析出的评分要求，只供 basis 指明参考它的表格使用。`).join('')}
- ${OUTLINE_INPUT_FILE}：本投标文件的完整目录，带编号、处理方式和说明。
- ${TENDER_INPUT_FILE}：当前标段的招标文件全文。
- ${BID_INFO_INPUT_FILE}：项目概述和招标关键信息。${hasGlobalFacts ? `
- ${GLOBAL_FACTS_INPUT_FILE}：本次投标已确定的全局事实。` : ''}

要求：
1. 先按表格的标题、分段行和表注确定它应答招标文件哪一部分的条款（如项目需求书、商务要求、技术参数、评分表），再按该部分原文逐条列出，每条一行，不遗漏、不合并、不加入该部分以外的条目，顺序与原文一致；原文分段的按段列出。模版已印好的行只是该部分的第一项或示例时，按原文补齐其余各项。序号类列按行编号。
2. 招标要求、评分标准等照录招标文件原文；应答类内容写出具体数值或内容，依据招标文件${hasGlobalFacts ? '和全局事实' : ''}，不编造。basis 指明的评分要求文件用来核对与本表相关的评分口径（如★条款、负偏离扣分、逐条应答要求）是否都已应答、偏离说明是否准确。
3. 需要写本投标文件中对应内容所在页码的单元格，只写 {{页码:目录编号}}，编号取自 ${OUTLINE_INPUT_FILE}，指向响应该项的小节；涉及多个小节时写多个，用“、”分隔。程序导出时换成实际页码，不要自己写页码数字。
4. 没有依据的单元格列入 unresolved 并写明原因。
5. kind=list 的表格有两种做法。招标文件给出的表格适合本表时照模版填写，不要重建。
   照模版填写（不写 rebuild 和 columns）：rows 按最终顺序列出每一行，每行写 from 或 like 之一，values 的键用所照行 cells 中的名称。
   - from=N：原地填写模版第 N 行，values 只写该行的待填格（fill），印好的内容保留不动；from 必须按 N 从小到大出现。
   - like=N：照模版第 N 行的格式新增一行，values 写这一行各格的内容（包括序号、招标要求等），没写的格留空。照分段行新增，就是新增一个分段行。
   - 新增的行接在上一行之后；所照的行在上一行之后时，新增的行放到所照行的位置。因此要放进某一分段的条目，照该分段内的行新增。
   - 没写到的模版行：只有待填格和序号的空行会删除，印有内容的行（表头、分段行、已印好的条目）保留在原位。
   重建（rebuild=true）：模版表格不能容纳本表内容时使用，例如表格把其他部分的内容混在一起，或合并单元格使条目无法逐条列出。写 columns 和 rows，程序用新表替换模版表格。
6. kind=new 和重建的表：columns 至少两列，rows 每行写 values（键为 columns 中的列名）；需要分段时写分组行 {"group":"分段名称"}，分组行整行合并。
结果格式（${OUTPUT_FILE}）：
{"tables":[{"id":"T1","rows":[{"from":2,"values":{"投标应答":"…"}},{"like":5,"values":{"序号":"1","招标要求":"…","投标应答":"…"}}]},{"id":"T2","columns":["序号","评分因素","所在页码"],"rows":[{"group":"一、技术部分"},{"values":{"序号":"1","评分因素":"…","所在页码":"{{页码:3.2}}"}}]}],"unresolved":[{"id":"T1","row":1,"column":"名称","reason":"原因"}]}
- 每张表恰好出现一次；kind=new 和重建必须给出 columns，行不写 from 或 like。
- 待填格（from 行的 fill、like 行所照行的 fill、kind=new 和重建的全部列）都要给出取值，或按格列入 unresolved（row 为 rows 中从 1 起的行序号，column 为格子或列的名称）。
- 程序已预建空的结果文件，首次填充使用 write，内容较多时可分多次写入：首次用 write，之后用 edit 补充，每次写入后保持完整有效 JSON。可用 json-validation 自查结构。
- 提交后程序会逐项校验，不通过会把问题退回给你，届时修改同一文件。完成后直接结束，不输出总结。`;
}

function blockingIssue(message) {
  return { severity: 'blocking', file: OUTPUT_FILE, message };
}

/**
 * 逐表核对覆盖、行号和格子，页码引用的目录编号换成节点 ID，无法确定的单元格写成“【待填写：原因】”。
 * 返回统一提交报告；value 中清单表的行按网格列给出格子，新建和重建表的行按列顺序给出各格或分组行。
 */
function validateRulePageResult(payload, specs, outline) {
  const issues = [];
  const nodes = new Map();
  const visit = (items) => {
    for (const item of items || []) {
      nodes.set(item.number, item);
      visit(item.children);
    }
  };
  visit(numberOutline(outline));
  const specIds = new Set(specs.map(spec => spec.id));
  for (const table of payload.tables) {
    if (!specIds.has(table.id)) issues.push(blockingIssue(`表格 ${table.id} 不在 ${TABLES_INPUT_FILE} 中`));
  }
  for (const item of payload.unresolved) {
    if (!specIds.has(item.id)) issues.push(blockingIssue(`unresolved 中的表格 ${item.id} 不在 ${TABLES_INPUT_FILE} 中`));
  }
  const convertCell = (value, label) => {
    const before = issues.length;
    const converted = value.replace(AGENT_PAGE_REF_PATTERN, (match, number) => {
      const node = nodes.get(number);
      if (!node) {
        issues.push(blockingIssue(`${label}的页码引用 ${match} 中的目录编号不存在，编号须取自 ${OUTLINE_INPUT_FILE}`));
        return match;
      }
      if (!node.children?.length && node.content_mode === 'directory-generate') {
        issues.push(blockingIssue(`${label}的页码引用 ${match} 指向投标文件目录，请指向响应该项的小节`));
        return match;
      }
      return formatPageToken(node.id);
    });
    if (issues.length === before && /\{\{(?!YBPAGE:)/.test(converted)) issues.push(blockingIssue(`${label}含有无法识别的 {{…}}，页码引用只能写 {{页码:目录编号}}`));
    return converted;
  };

  const tables = [];
  const unresolved = [];
  let rowCount = 0;
  for (const spec of specs) {
    const matched = payload.tables.filter(table => table.id === spec.id);
    if (matched.length !== 1) {
      issues.push(blockingIssue(matched.length ? `表格 ${spec.id} 出现了 ${matched.length} 次` : `缺少表格 ${spec.id}（${spec.chapter}）`));
      continue;
    }
    const table = matched[0];
    const reasons = new Map(payload.unresolved
      .filter(item => item.id === spec.id)
      .map(item => [`${item.row}\u0000${item.column}`, item.reason]));
    // 有取值时换页码引用；必填格没有取值时取 unresolved 的原因，写成“待填写”。
    const resolveCell = (raw, required, rowIndex, name, rowLabel) => {
      const cellLabel = `${rowLabel}“${name}”`;
      if (textOf(raw)) return convertCell(String(raw), cellLabel);
      if (!required) return '';
      const reason = reasons.get(`${rowIndex + 1}\u0000${name}`);
      if (!reason) {
        issues.push(blockingIssue(`${cellLabel}没有取值，请填写或列入 unresolved`));
        return '';
      }
      unresolved.push({ label: `${spec.chapter} 第 ${rowIndex + 1} 行 ${name}`, reason });
      return `【待填写：${reason}】`;
    };
    if (spec.kind === 'new' && table.rebuild) issues.push(blockingIssue(`表格 ${spec.id} 是新建表，不写 rebuild`));
    const ownColumns = spec.kind === 'new' || table.rebuild === true;
    let rows;
    if (ownColumns) {
      const columns = table.columns;
      if (!columns?.length) {
        issues.push(blockingIssue(`表格 ${spec.id} 是${spec.kind === 'new' ? '新建表' : '重建表'}，必须给出 columns（至少两列）`));
        continue;
      }
      if (new Set(columns).size !== columns.length) {
        issues.push(blockingIssue(`表格 ${spec.id} 的 columns 有重复列名`));
        continue;
      }
      rows = table.rows.map((row, index) => {
        const label = `表格 ${spec.id} 第 ${index + 1} 行`;
        if (row.from !== undefined || row.like !== undefined) {
          issues.push(blockingIssue(`${label}属于${spec.kind === 'new' ? '新建表' : '重建表'}，不写 from 或 like`));
          return null;
        }
        if (row.group !== undefined) return { group: convertCell(row.group, `${label}分组行`) };
        const values = row.values || {};
        const unknown = Object.keys(values).filter(key => !columns.includes(key));
        if (unknown.length) issues.push(blockingIssue(`${label}有不存在的列：${unknown.join('、')}`));
        return { values: columns.map(column => resolveCell(values[column], true, index, column, label)) };
      }).filter(Boolean);
      if (!rows.some(row => row.values)) issues.push(blockingIssue(`表格 ${spec.id} 是${spec.kind === 'new' ? '新建表' : '重建表'}，至少要有一行内容`));
      tables.push({
        id: spec.id,
        node_id: spec.node_id,
        ...(spec.kind === 'list' ? { field_ids: spec.field_ids, rebuild: true } : { slot: spec.slot }),
        columns,
        rows,
      });
    } else {
      if (table.columns) issues.push(blockingIssue(`表格 ${spec.id} 照模版填写时不写 columns；需要重建时写 rebuild=true`));
      let lastFrom = 0;
      rows = table.rows.map((row, index) => {
        const label = `表格 ${spec.id} 第 ${index + 1} 行`;
        if (row.group !== undefined) {
          issues.push(blockingIssue(`${label}：照模版填写的表格不写 group，新增分段行时照模版的分段行用 like`));
          return null;
        }
        if ((row.from === undefined) === (row.like === undefined)) {
          issues.push(blockingIssue(`${label}须且只能写 from 或 like 之一`));
          return null;
        }
        const reference = row.from ?? row.like;
        const template = spec.rows[reference - 1];
        if (!template) {
          issues.push(blockingIssue(`${label}引用了第 ${reference} 行，模版表格只有 ${spec.rows.length} 行`));
          return null;
        }
        if (row.from !== undefined) {
          if (row.from <= lastFrom) issues.push(blockingIssue(`${label}的 from=${row.from} 没有按行号递增`));
          lastFrom = Math.max(lastFrom, row.from);
        }
        const values = row.values || {};
        const names = template.cells.map(cell => cell.label);
        const unknown = Object.keys(values).filter(key => !names.includes(key));
        if (unknown.length) issues.push(blockingIssue(`${label}有第 ${reference} 行没有的格子：${unknown.join('、')}；该行的格子为：${names.join('、')}`));
        // from 行只写待填格，印好的格不动；like 行各格都写入，没写的格留空。
        const targets = row.from !== undefined ? template.cells.filter(cell => cell.fill) : template.cells;
        return {
          ...(row.from !== undefined ? { from: row.from } : { like: row.like }),
          cells: targets.map(cell => ({ column: cell.column, value: resolveCell(values[cell.label], cell.fill, index, cell.label, label) })),
        };
      }).filter(Boolean);
      tables.push({ id: spec.id, node_id: spec.node_id, field_ids: spec.field_ids, rows });
    }
    rowCount += rows.length;
  }
  const blocked = issues.length > 0;
  return {
    value: blocked ? null : { tables, stats: { table_count: tables.length, row_count: rowCount, unresolved } },
    issues,
    minimumGoal: '结果文件是完整有效 JSON；每张表恰好出现一次，照模版填写的表每行写 from 或 like，新建和重建的表给出 columns；待填格都有取值或列入 unresolved；页码引用只写 {{页码:目录编号}} 且编号存在。',
  };
}

function checkRulePageResult(content, specs, outline) {
  let payload;
  try {
    payload = JSON.parse(String(content || '').replace(/^﻿/, '').trim());
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { value: null, issues: [blockingIssue(`${OUTPUT_FILE} 不是合法 JSON：${error.message}`)], minimumGoal: '结果文件是完整有效 JSON，结构符合 Schema。' };
  }
  if (!validateResultSchema(payload)) {
    return {
      value: null,
      issues: validateResultSchema.errors.map(item => blockingIssue(`${OUTPUT_FILE} 结构无效：${item.instancePath || '/'} ${item.message}`)),
      minimumGoal: '结果文件是完整有效 JSON，结构符合 Schema。',
    };
  }
  return validateRulePageResult(payload, specs, outline);
}

function buildRetryPrompt(request) {
  if (request.kind === 'execution') {
    return `上一轮执行失败：${String(request.error?.message || request.error).slice(0, 800)}\n请在当前会话和工作区中继续完成 ${OUTPUT_FILE}，已有有效内容保留，不要重做已完成部分。`;
  }
  return `结果文件为当前工作目录根目录的 ${OUTPUT_FILE}，用 edit 或 write 修改同一文件并保持完整有效 JSON。修复后直接结束，不输出总结。`;
}

/**
 * 按阶段续跑：compiling 运行规则和页码 Agent 并保存编制结果，rendering 以底稿重新回填商务模版 Word。
 * 正文任务中作为副流程与商务模版填写并行；“重新编制”时单独运行。
 */
async function runRulePageCompile({
  agentService,
  workspaceStore,
  credentialLibraryService,
  openXmlHelperService,
  inputs,
  state,
  primarySession = false,
  signal,
  isPauseError = () => false,
  onState,
  onActivity,
}) {
  let current = { ...state };
  const update = (patch) => {
    current = { ...current, ...patch, updated_at: new Date().toISOString() };
    onState?.(current);
    return current;
  };

  if (current.phase === 'compiling') {
    const plan = workspaceStore.loadTechnicalPlan();
    const outline = plan.outlineData?.outline;
    const specs = collectRuleTableSpecs(await loadBusinessFillScope({ workspaceStore, openXmlHelperService, signal }), outline);
    const references = readScoringReferences(plan.bidAnalysisTasks);
    const referenceFiles = collectScoringReferenceFiles(specs, references);
    if (!specs.length) {
      update({ phase: 'completed', table_count: 0, row_count: 0, unresolved: [] });
      return current;
    }
    signal?.throwIfAborted();
    const resumeSession = agentService.hasPersistentTaskSession(RULE_PAGE_AGENT_TASK_KEY);
    const prompted = resumeSession && wasStagePrompted(agentService.loadPersistentTask(RULE_PAGE_AGENT_TASK_KEY)?.state, RULE_PAGE_STAGE);
    const runId = crypto.randomUUID();
    if (resumeSession) {
      agentService.updatePersistentTask(RULE_PAGE_AGENT_TASK_KEY, {
        run_id: runId, status: 'running', phase: RULE_PAGE_STAGE, agent_connection: 'running', error: null,
      });
    }
    const hasGlobalFacts = Boolean(textOf(inputs.globalFactsText));
    let result;
    try {
      result = await agentService.runTask({
        task_id: runId,
        title: '规则和页码 Agent',
        primary_session: primarySession,
        summary_enabled: false,
        prompt: prompted ? CONTINUE_PROMPT : createRulePagePrompt({ resume: resumeSession, hasGlobalFacts, referenceFiles: referenceFiles.map(file => file.path) }),
        output_file: OUTPUT_FILE,
        prepare_output_files: [OUTPUT_FILE],
        // 输入只在新会话写入；继续时沿用工作区已有快照。
        files: resumeSession ? [] : [
          { path: TABLES_INPUT_FILE, content: `${JSON.stringify(buildTablesInput(specs, references), null, 2)}\n` },
          ...referenceFiles,
          { path: OUTLINE_INPUT_FILE, content: `${buildOutlineInput(outline)}\n` },
          { path: TENDER_INPUT_FILE, content: `${textOf(workspaceStore.readTenderMarkdown()) || '未提供'}\n` },
          { path: BID_INFO_INPUT_FILE, content: `${textOf(inputs.bidKeyInfoText) || '未提供'}\n` },
          ...(hasGlobalFacts ? [{ path: GLOBAL_FACTS_INPUT_FILE, content: `${textOf(inputs.globalFactsText)}\n` }] : []),
        ],
        signal,
        timeout_ms: AGENT_TIMEOUT_MS,
        persistent_task: { task_key: RULE_PAGE_AGENT_TASK_KEY, mode: resumeSession ? 'resume' : 'create' },
        initial_stage: RULE_PAGE_STAGE,
        json_validation_schemas: { [OUTPUT_FILE]: RULE_PAGE_RESULT_SCHEMA },
        max_retries: 1,
        validateOutput: candidate => checkRulePageResult(candidate.output_content, specs, outline),
        buildRetryPrompt,
        onActivity,
      });
    } catch (error) {
      if (agentService.hasPersistentTaskSession(RULE_PAGE_AGENT_TASK_KEY)) {
        const paused = isPauseError(error);
        agentService.updatePersistentTask(RULE_PAGE_AGENT_TASK_KEY, {
          status: paused ? 'paused' : 'error', agent_connection: 'idle', ...(paused ? {} : { error: error?.message || String(error) }),
        });
      }
      throw error;
    }
    signal?.throwIfAborted();
    const validated = result.validation_result;
    workspaceStore.saveRulePageTables({ version: RULE_PAGE_TABLES_VERSION, compiled_at: new Date().toISOString(), tables: validated.tables });
    agentService.updatePersistentTask(RULE_PAGE_AGENT_TASK_KEY, {
      status: 'success', phase: 'completed', agent_connection: 'idle', error: null, completed_at: new Date().toISOString(),
    });
    update({ phase: 'rendering', ...validated.stats });
  }

  if (current.phase === 'rendering') {
    signal?.throwIfAborted();
    await renderBusinessTemplate({
      workspaceStore, credentialLibraryService, openXmlHelperService,
      fields: workspaceStore.readBidTemplateFields().fields || [],
      signal,
    });
    update({ phase: 'completed' });
  }
  return current;
}

// 当前目录是否有需要编制的规则和页码章节（模版中带规则字段）。
function hasRulePageChapters(workspaceStore, outline) {
  return workspaceStore.hasBidTemplate() && collectRulePageChapterIds(outline, workspaceStore.readBidTemplateFields()).length > 0;
}

function initialRulePageState() {
  return { phase: 'compiling', status: 'running', table_count: 0, row_count: 0, unresolved: [], error: null, updated_at: new Date().toISOString() };
}

/** 正文页“重新编制”：只运行规则和页码编制，结果写入正文运行时的 rule_page；正文任务运行或暂停时由任务组互斥拦截。 */
async function runRulePageCompileTask({ agentService, workspaceStore, credentialLibraryService, openXmlHelperService, updateTask, checkpointTask, taskControl }) {
  // 输入格式与正文任务一致；延迟加载，避免与正文任务模块互相引用。
  const { formatBidKeyInfoForPrompt, formatBidAnalysisFactsForPrompt, formatGlobalFactsForPrompt } = require('./contentGenerationTask.cjs');
  const plan = workspaceStore.loadTechnicalPlan();
  const outline = plan.outlineData?.outline;
  if (!hasRulePageChapters(workspaceStore, outline)) throw new Error('当前目录没有需要编制的规则和页码小节');
  const hasAiLeaves = collectOutlineLeaves(outline).some(({ item }) => item.content_mode === 'ai-generate');
  workspaceStore.resetRulePageTables();
  agentService.deletePersistentTask(RULE_PAGE_AGENT_TASK_KEY);
  workspaceStore.ensureBidTemplateBlank();
  let logs = ['开始编制规则和页码小节。'];
  const save = (state, patch = {}) => {
    const runtime = { ...(workspaceStore.readContentGenerationRuntime() || {}), rule_page: state };
    checkpointTask({ logs, ...patch }, { contentGenerationRuntime: runtime });
  };
  let state = initialRulePageState();
  save(state, { status: 'running', progress: 5 });
  try {
    state = await runRulePageCompile({
      agentService, workspaceStore, credentialLibraryService, openXmlHelperService,
      inputs: {
        bidKeyInfoText: formatBidKeyInfoForPrompt(plan.outlineData?.project_overview || plan.projectOverview, formatBidAnalysisFactsForPrompt(plan)),
        globalFactsText: hasAiLeaves ? formatGlobalFactsForPrompt(plan.globalFacts || []) : '',
      },
      state,
      primarySession: true,
      signal: taskControl.signal,
      onState(next) {
        state = { ...next, status: next.phase === 'completed' ? 'success' : 'running' };
        if (next.phase === 'rendering') logs = [...logs, `规则和页码已编制（${next.table_count} 张表，${next.row_count} 行，无法确定 ${next.unresolved.length} 处），正在回填商务模版 Word。`];
        save(state, { progress: next.phase === 'rendering' ? 90 : 50 });
      },
      onActivity(event = {}) {
        if (event.visible === false || !event.message) return;
        updateTask({ logs: [...logs, `规则和页码：${event.message}`] });
      },
    });
    logs = [...logs, '规则和页码编制完成。'];
    save({ ...state, status: 'success' }, { status: 'success', progress: 100 });
  } catch (error) {
    logs = [...logs, `规则和页码编制失败：${error?.message || error}`];
    try {
      save({ ...state, status: 'error', error: error?.message || String(error) }, { status: 'error', error: error?.message || String(error) });
    } catch {
      // 任务已取消（如重置）时不再写入。
    }
    throw error;
  }
}

module.exports = {
  RULE_PAGE_STAGE,
  RULE_PAGE_TABLES_VERSION,
  collectRuleTableSpecs,
  checkRulePageResult,
  describeRuleBasis,
  hasRulePageChapters,
  initialRulePageState,
  runRulePageCompile,
  runRulePageCompileTask,
};
