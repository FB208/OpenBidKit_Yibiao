const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const { BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY } = require('./businessTemplateFillAgentConfig.cjs');
const { CONTINUE_PROMPT, wasStagePrompted } = require('./contentGenerationAgent.cjs');
const { CREDENTIAL_IMAGE_FIELD_LABELS } = require('./credentialLibraryService.cjs');
const { appendGeneratedChapters, readTemplateLayout } = require('./pi/piOpenXmlTool.cjs');
const { buildRuleTableFills, convertAgentPageRefs, createPageRefDisplay, isRuleField, numberedNodes, toAgentPageRefs } = require('./rulePageTables.cjs');
const { buildOutlineInput, collectOutlineLeaves, numberOutline } = require('./technicalPlanOutline.cjs');

const BUSINESS_TEMPLATE_FILL_STAGE = 'business-template-fill';
const FIELDS_INPUT_FILE = '商务模版待填字段.json';
const CREDENTIAL_INPUT_FILE = '资信库.json';
const TENDER_INPUT_FILE = '招标文件.md';
const BID_INFO_INPUT_FILE = '招标关键信息.md';
const GLOBAL_FACTS_INPUT_FILE = '全局事实设定.md';
const OUTLINE_INPUT_FILE = '投标文件目录.md';
const FILL_OUTPUT_FILE = '商务模版填写结果.json';
const FILL_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const FILL_RENDER_TIMEOUT_MS = 5 * 60 * 1000;
const PROJECT_TYPE_LABELS = { service: '服务', goods: '货物', construction: '工程' };

const nonEmptyString = { type: 'string', minLength: 1 };
const FILL_VALUE_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: nonEmptyString,
    value: nonEmptyString,
    selected: { type: 'array', minItems: 1, items: nonEmptyString },
    image_id: nonEmptyString,
  },
};
// 填写项的引用：普通字段只写 name，清单中的格子同时写 table_id 和 row。
const FILL_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: nonEmptyString,
    table_id: nonEmptyString,
    row: { type: 'integer', minimum: 1 },
  },
};
// 商务生成模板：招标文件要求、但商务模版中没有格式或位置的内容（证明材料、承诺或声明、只有标题章节的正文），
// 与提取模板同属商务模版。attach 附在目录叶子 after 之后、带标题；body 作为只有标题的商务章节 after 的正文。
// blocks 每项一段：text 中 {{字段名}} 为填写位置，attachment 为只放一张图片的附件位置；fields 列出新名称的字段。
const GENERATED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'after', 'basis', 'blocks'],
  properties: {
    mode: { enum: ['attach', 'body'] },
    after: nonEmptyString,
    title: nonEmptyString,
    basis: nonEmptyString,
    blocks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { text: nonEmptyString, attachment: nonEmptyString },
      },
    },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'subject', 'kind', 'fill_by'],
        properties: {
          name: nonEmptyString,
          subject: nonEmptyString,
          kind: { enum: ['text', 'attachment'] },
          fill_by: { enum: ['ai', 'manual'] },
        },
      },
    },
  },
};
// value、selected、image_id 的互斥及字段类型在 validateOutput 中按填写项检查。
const BUSINESS_TEMPLATE_FILL_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['values', 'rows', 'unresolved'],
  properties: {
    values: { type: 'array', items: FILL_VALUE_ITEM_SCHEMA },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['table_id', 'row', 'values'],
        properties: {
          table_id: nonEmptyString,
          row: { type: 'integer', minimum: 1 },
          values: { type: 'array', items: FILL_VALUE_ITEM_SCHEMA },
        },
      },
    },
    unresolved: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['reason'],
        properties: {
          name: nonEmptyString,
          table_id: nonEmptyString,
          row: { type: 'integer', minimum: 1 },
          reason: nonEmptyString,
        },
      },
    },
    // 联动：target 与 source 同值（same）或为其金额大写（uppercase），由确认弹窗随来源同步。
    links: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'source', 'form'],
        properties: {
          target: FILL_REF_SCHEMA,
          source: FILL_REF_SCHEMA,
          form: { enum: ['same', 'uppercase'] },
        },
      },
    },
    generated: { type: 'array', items: GENERATED_SCHEMA },
  },
};
const ajv = new Ajv({ allErrors: true, strict: true });
const validateFillSchema = ajv.compile(BUSINESS_TEMPLATE_FILL_JSON_SCHEMA);

const FIELD_KINDS = new Set(['text', 'choice', 'select', 'attachment']);
const OPTION_KINDS = new Set(['choice', 'select']);
const FILL_VALUE_KEYS = ['value', 'selected', 'image_id'];
// link 为填写 Agent 声明的联动 { source: 来源填写项的首个字段 ID, form }，随填写状态保存和重置。
const UNIT_STATE_KEYS = [...FILL_VALUE_KEYS, 'blank', 'unresolved_reason', 'link'];

// 字段清单 v2：同一表格内同名字段出现在多行时逐行填写，可重复条目（entry，table_id 为条目清单 id、row 为第几条）中的字段逐条填写，其余同名字段填同一个值；同名字段的 fill_by 一致。
// 规则和页码字段（fill_by=rule）由规则和页码 Agent 编制，不形成商务填写项。
function groupFieldUnits(allFields = []) {
  const fields = allFields.filter(field => !isRuleField(field));
  const tableRows = new Map();
  for (const field of fields) {
    if (!field.table_id || !Number.isInteger(field.row)) continue;
    const key = `${field.table_id}\u0000${field.name}`;
    if (!tableRows.has(key)) tableRows.set(key, new Set());
    tableRows.get(key).add(field.row);
  }
  const units = [];
  const unitsByKey = new Map();
  for (const field of fields) {
    // 可重复条目（entry）中的字段总是逐条填写。
    const perRow = Boolean(field.table_id) && (field.entry || (tableRows.get(`${field.table_id}\u0000${field.name}`)?.size || 0) >= 2);
    const key = perRow ? `row\u0000${field.table_id}\u0000${field.row}\u0000${field.name}` : `name\u0000${field.name}`;
    let unit = unitsByKey.get(key);
    if (!unit) {
      unit = {
        key,
        name: field.name,
        kind: FIELD_KINDS.has(field.kind) ? field.kind : 'text',
        fill_by: field.fill_by,
        ...(field.subject ? { subject: field.subject } : {}),
        ...(field.section ? { section: field.section } : {}),
        ...(field.instruction ? { instruction: field.instruction } : {}),
        ...(OPTION_KINDS.has(field.kind) ? { options: field.options || [] } : {}),
        ...(perRow ? { table_id: field.table_id, row: field.row, ...(field.entry ? { entry: true } : {}) } : {}),
        // 字段在模版中的原句（老模版没有），同名字段取第一处，供填写时让取值能放进原句。
        ...(field.context ? { context: field.context } : {}),
        field_ids: [],
      };
      unitsByKey.set(key, unit);
      units.push(unit);
    }
    unit.field_ids.push(field.id);
  }
  return units;
}

// 逐行清单表和可重复条目按行（条）决定是否保留占位：有任一格已填的行保留空格的占位；一行都没填时只保留第一行，其余行为未使用的空行。
// 签章格子不算已填。确认弹窗（BusinessFillDocument.tsx 的 findIdleListUnitKeys）按同一规则实时计算，改动时同步。
function findIdleListUnits(units, isUnitFilled) {
  const tables = new Map();
  for (const unit of units) {
    if (!unit.table_id) continue;
    if (!tables.has(unit.table_id)) tables.set(unit.table_id, []);
    tables.get(unit.table_id).push(unit);
  }
  const idle = new Set();
  for (const tableUnits of tables.values()) {
    const used = new Set(tableUnits.filter(isUnitFilled).map(unit => unit.row));
    const kept = used.size ? used : new Set([Math.min(...tableUnits.map(unit => unit.row))]);
    for (const unit of tableUnits) {
      if (!kept.has(unit.row)) idle.add(unit.key);
    }
  }
  return idle;
}

// 导出时清单表按行处理：未使用的行写入留空并返回其字段 ID（整本导出删除这些行和条目），保留占位的空格去掉 AI 留下的留空标记，字段值本身不变。
function applyListRowMarks(fields = []) {
  const fieldsById = new Map(fields.map(field => [field.id, field]));
  const units = groupFieldUnits(fields).filter(unit => unit.table_id);
  const idle = findIdleListUnits(units, unit => !unit.field_ids.every(id => fieldsById.get(id)?.signature)
    && hasFilledValue(readUnitState(unit, fieldsById)));
  const idleByField = new Map(units.flatMap(unit => unit.field_ids.map(id => [id, idle.has(unit.key)])));
  return {
    fields: fields.map((field) => {
      if (!idleByField.has(field.id) || hasFilledValue(field)) return field;
      const rest = Object.fromEntries(Object.entries(field).filter(([key]) => key !== 'blank'));
      return idleByField.get(field.id) ? { ...rest, blank: true } : rest;
    }),
    idleFieldIds: [...idleByField].filter(([, isIdle]) => isIdle).map(([id]) => id),
  };
}

// 副 Agent 只填写 fill_by=ai 的填写项，附件从资信库图片中推荐。
function buildFillUnits(fields = []) {
  return groupFieldUnits(fields).filter(unit => unit.fill_by === 'ai');
}

function hasFilledValue(target) {
  return FILL_VALUE_KEYS.some(key => Object.hasOwn(target, key));
}

// 同一填写项展开到的字段值相同，取第一个字段的当前值。
function readUnitState(unit, fieldsById) {
  const field = fieldsById.get(unit.field_ids[0]) || {};
  return Object.fromEntries(UNIT_STATE_KEYS.filter(key => Object.hasOwn(field, key)).map(key => [key, field[key]]));
}

function describeUnit(unit) {
  return {
    name: unit.name,
    ...(unit.subject ? { subject: unit.subject } : {}),
    kind: unit.kind,
    ...(unit.instruction ? { instruction: unit.instruction } : {}),
    ...(unit.options ? { options: unit.options } : {}),
    ...(unit.context ? { context: unit.context } : {}),
  };
}

// 按表格汇总逐行单元格：列取各行出现过的全部字段，行号沿用 Word 表格中的 1 基行号；可重复条目按清单汇总，行号为第几条。
function groupTableUnits(units) {
  const tables = new Map();
  for (const unit of units) {
    if (!unit.table_id) continue;
    if (!tables.has(unit.table_id)) tables.set(unit.table_id, { table_id: unit.table_id, section: unit.section, entries: Boolean(unit.entry), columns: new Map(), rows: new Set(), cells: new Map() });
    const table = tables.get(unit.table_id);
    if (!table.columns.has(unit.name)) table.columns.set(unit.name, describeUnit(unit));
    table.rows.add(unit.row);
    table.cells.set(`${unit.row}\u0000${unit.name}`, unit);
  }
  return tables;
}

// chapters 按目录顺序列出范围内的商务模版章节，title_only 表示除标题外没有内容，由填写 Agent 写商务生成模板作为正文。
function buildFieldsInput(units, chapters = []) {
  return {
    ...(chapters.length ? { chapters } : {}),
    fields: units.filter(unit => !unit.table_id).map(unit => ({ ...describeUnit(unit), ...(unit.section ? { section: unit.section } : {}), count: unit.field_ids.length })),
    tables: [...groupTableUnits(units).values()].map(table => ({
      table_id: table.table_id,
      ...(table.entries ? { entries: true } : {}),
      ...(table.section ? { section: table.section } : {}),
      columns: [...table.columns.values()],
      rows: [...table.rows].sort((a, b) => a - b),
    })),
  };
}

function textOf(value) {
  return String(value ?? '').trim();
}

function pickFilled(entries) {
  return Object.fromEntries(entries.map(([key, value]) => [key, textOf(value)]).filter(([, value]) => value));
}

function formatValidity(mode, from, to) {
  if (mode === 'long-term') return '长期';
  if (mode === 'range') return `${textOf(from) || '未填写'} 至 ${textOf(to) || '未填写'}`;
  return '';
}

// 记录下的图片目录只给 id、栏目和名称，不提供图片内容。
function imagesOf(snapshot, ownerType, ownerId) {
  return (snapshot.images || [])
    .filter(image => image.ownerType === ownerType && image.ownerId === ownerId)
    .map(image => ({ id: image.imageId, 栏目: CREDENTIAL_IMAGE_FIELD_LABELS[image.fieldKey] || image.fieldKey, 名称: image.customName || image.originalName }));
}

function withImages(record, images) {
  return images.length ? { ...record, 图片: images } : record;
}

// 键名沿用资信库页面文案；附带图片目录，不提供水印和时间戳。
function buildCredentialLibraryInput(snapshot = {}) {
  const profile = snapshot.profile || {};
  const profileImages = (snapshot.images || []).filter(image => image.ownerType === 'profile');
  return {
    ...(profileImages.length ? { 企业图片: imagesOf(snapshot, 'profile', profileImages[0].ownerId) } : {}),
    基本信息: pickFilled([
      ['公司名称', profile.companyName],
      ['统一社会信用代码', profile.unifiedSocialCreditCode],
      ['电话', profile.phone],
      ['传真', profile.fax],
      ['邮政编码', profile.postalCode],
      ['邮箱', profile.email],
      ['法定代表人', profile.legalRepresentative],
      ['法定代表人身份证号', profile.legalRepresentativeIdNumber],
      ['注册资本', profile.registeredCapital],
      ['经营期限开始', profile.operatingPeriodStart],
      ['经营期限结束', profile.operatingPeriodEnd],
      ['所在行业', profile.industry],
      ['公司性质', profile.companyType],
      ['参保人数', profile.insuredEmployeeCount],
      ['上年度从业人员（人）', profile.lastYearEmployeeCount],
      ['上年度营业收入（万元）', profile.lastYearRevenue],
      ['上年度资产总额（万元）', profile.lastYearTotalAssets],
      ['地址', profile.address],
      ['经营范围', profile.businessScope],
      ['公司介绍', profile.companyIntro],
    ]),
    资质: (snapshot.certificates || []).map(item => withImages(pickFilled([
      ['名称', item.name],
      ['编号', item.number],
      ['有效期', formatValidity(item.validityMode, item.validFrom, item.validTo)],
    ]), imagesOf(snapshot, 'certificate', item.certificateId))),
    员工: (snapshot.employees || []).map(item => withImages(pickFilled([
      ['姓名', item.name],
      ['身份证号', item.idNumber],
      ['职务', item.position],
      ['职称', item.professionalTitle],
      ['性别', item.gender],
      ['联系电话', item.phone],
      ['身份证有效期', formatValidity(item.idValidityMode, item.idValidFrom, item.idValidTo)],
      ['学历', item.education],
      ['学校', item.school],
      ['专业', item.major],
      ['人员简介', item.introduction],
    ]), imagesOf(snapshot, 'employee', item.employeeId))),
    业绩: (snapshot.projects || []).map(item => withImages(pickFilled([
      ['项目名称', item.projectName],
      ['项目编号', item.projectNumber],
      ['客户名称', item.customerName],
      ['项目类型', PROJECT_TYPE_LABELS[item.projectType] || item.projectType],
      ['项目负责人', item.projectManager],
      ['合同金额', item.contractAmount],
      ['开始日期', item.startDate],
      ['结束日期', item.endDate],
      ['项目状态', item.projectStatus],
      ['项目介绍', item.introduction],
    ]), imagesOf(snapshot, 'project', item.projectId))),
    财务信息: pickFilled([
      ['开户名称', profile.bankAccountName],
      ['银行账号', profile.bankAccountNumber],
      ['开户银行', profile.bankName],
      ['银行行号', profile.bankRoutingNumber],
      ['纳税证明信息时间', profile.taxCertificateDate],
      ['纳税证明备注', profile.taxCertificateNote],
      ['财务审计报告信息时间', profile.auditReportDate],
      ['财务审计报告备注', profile.auditReportNote],
      ['社保缴纳证明信息时间', profile.socialSecurityCertificateDate],
      ['社保缴纳证明备注', profile.socialSecurityCertificateNote],
    ]),
    其他: (snapshot.otherMaterials || []).map(item => withImages(pickFilled([
      ['资料名称', item.name],
      ['备注', item.note],
    ]), imagesOf(snapshot, 'other', item.materialId))),
  };
}

function buildBusinessTemplateFillFiles({ units, chapters, credentialLibrary, tenderMarkdown, bidKeyInfoText, globalFactsText, outline }) {
  return [
    { path: FIELDS_INPUT_FILE, content: `${JSON.stringify(buildFieldsInput(units, chapters), null, 2)}\n` },
    { path: CREDENTIAL_INPUT_FILE, content: `${JSON.stringify(buildCredentialLibraryInput(credentialLibrary), null, 2)}\n` },
    { path: OUTLINE_INPUT_FILE, content: `${buildOutlineInput(outline)}\n` },
    { path: TENDER_INPUT_FILE, content: `${textOf(tenderMarkdown) || '未提供'}\n` },
    { path: BID_INFO_INPUT_FILE, content: `${textOf(bidKeyInfoText) || '未提供'}\n` },
    // 目录没有 AI 小节时不设全局事实，只按招标文件和招标关键信息填写。
    ...(textOf(globalFactsText) ? [{ path: GLOBAL_FACTS_INPUT_FILE, content: `${textOf(globalFactsText)}\n` }] : []),
  ];
}

function createBusinessTemplateFillPrompt({ resume = false, hasGlobalFacts = false } = {}) {
  return `请只在当前工作目录内工作。已有材料足以判断时自主执行，不要调用 ask-user。${resume ? '这是之前中断任务的继续：先检查已有的结果文件，保留有效内容，只补齐或修正未完成部分。' : ''}

任务：为投标文件商务模版的待填字段取值，并为招标文件要求、但模版中没有格式的内容写出商务生成模板，结果写入 ${FILL_OUTPUT_FILE}。程序会校验结果并写入 Word，你不读写任何 Word 文件，也不修改输入文件。

输入文件：
- ${FIELDS_INPUT_FILE}：fields 为普通字段，同名字段填同一个值，count 为该字段在模版中出现的次数；tables 为逐行填写的清单表，每个表格给出列（columns）和可用行号（rows），每一行代表一条记录，不要求填满；entries=true 的是模版中按条目重复的段落（如多个标的时依次写的各条），每条为一行，rows 为可用的条序号，用法与表格相同。kind=text 为文字字段，kind=choice 为勾选项并给出 options，kind=select 为择一并给出 options，kind=attachment 为附件图片。subject 是该字段所描述的对象（要填写谁或什么的信息），section 是字段或表格所在的章节和表格标题，context 是字段在模版中的原句（【▢…】为填写处，表格为同行内容）。chapters 按目录顺序列出商务模版章节的目录编号和标题，title_only=true 表示该章除标题外没有内容。
- ${CREDENTIAL_INPUT_FILE}：投标人的资信库，包括基本信息、资质、员工、业绩、财务信息和其他资料；企业图片和各条记录下的“图片”列出可用图片的 id、栏目和名称。
- ${TENDER_INPUT_FILE}：当前标段的招标文件全文。
- ${BID_INFO_INPUT_FILE}：项目概述和招标关键信息。
- ${OUTLINE_INPUT_FILE}：本投标文件的完整目录，带编号、处理方式和说明，供 generated 指定放置位置。${hasGlobalFacts ? `
- ${GLOBAL_FACTS_INPUT_FILE}：本次投标已确定的全局事实。` : ''}

取值规则（先按 subject 确定应填写哪个对象的信息，名称不足以判断时结合 section 和招标文件中该位置的上下文判断）：
1. 企业信息（名称、统一社会信用代码、法定代表人、地址、电话、开户行、账号等）只取资信库，原样使用，不改写。
2. 人员、证书、业绩只能选资信库中的真实记录，按招标文件的资格和评分要求选最匹配的。${hasGlobalFacts ? '全局事实已指定的人员在资信库中存在时必须选同一人；不在资信库中时，相关字段列入 unresolved 并说明原因。' : ''}
3. tables 中同一行各列取自同一条记录，不同行取不同记录。只把有真实记录的行写入 rows，从该表格 rows 列出的第一行起按顺序连续使用；记录用完后剩余的行不要写入 rows 或 unresolved，程序会把它们留空。已使用的行中个别列没有依据时，按单元格列入 unresolved（写 table_id、row、name 和 reason）。一条可用记录都没有时，只把该表格的第一行整行列入 unresolved（只写 table_id、row 和 reason）。序号类列按行顺序填写。
4. 项目信息（项目名称、项目编号、招标人、工期或服务期、质量标准、投标有效期等）${hasGlobalFacts ? '以全局事实为准，全局事实未提及时取招标文件原文。' : `取招标文件原文和${BID_INFO_INPUT_FILE}。`}
5. 勾选项只能从 options 中原样选择，可以多选；择一只能从 options 中原样选一项；没有依据时列入 unresolved。
6. 附件用 image_id 从资信库图片中选择一张：按栏目和所属记录匹配材料，人员、证书、业绩相关附件必须属于已选用的同一人员、证书或业绩记录；同一张图片可用于多处；没有匹配的图片时列入 unresolved。
7. 报价、金额、日期以及任何找不到明确依据的内容一律列入 unresolved 并写明原因，不编造、不估算。需要投标人补充的内容只能这样交给程序：列入 unresolved 的位置，程序会在 Word 中统一标成【待填写：…】，投标人靠全文搜索这个标记逐项补齐。取值和商务生成模板的文字中，不写“暂缺”“待补充”“后附”“另行提供”一类说明，也不要自己写“【待填写】”。
8. 每个值为一段纯文本，需要多行时用换行符；有 instruction 时按其格式要求填写。有 context 时，取值要能直接放进原句的填写处：原句在填写处前后已有的文字（如“项目”“公司”、单位）不要在取值中重复。
9. 同一项内容（如投标总价）在多处出现但字段不同时，选其中一处正常填写或列入 unresolved，其余位置用 links 声明为 same（同值）；某处是另一处金额的大写时声明为 uppercase。确认时投标人只需填写来源一处，程序同步其他位置并换算大写。声明了 links 的位置（target）不再写入 values、rows 的值或 unresolved。same 只用于整项内容相同的位置；只填其中一部分的位置（如模版把年、月、日分开填写）不声明 links，按第 7 条各自列入 unresolved。各份文件落款处的签署日期（含封面的投标日期）通常是同一天，同样选其中一处按第 7 条列入 unresolved，其余声明为 same；招标文件或资料明确要求不同日期的除外。
10. generated 写商务生成模板：招标文件要求、但商务模版中没有对应格式或位置的内容，由你按招标文件写成模板，程序把它写进商务模版并照常填写。只在以下情况写，招标文件没有要求的不写：
   - 资格要求、评分标准、投标须知中的资格证明文件条款或各格式的备注（如“证明材料按顺序附后”）要求附上的证明材料，且模版中没有对应的附件位置；清单表中逐行列出的业绩、人员等，按行的顺序每条记录一项，附该记录中招标文件要求的各类图片。招标文件要求附上的每项材料都至少写一个附件位置，资信库中有没有都要写；资信库没有、不全或不符合招标要求（如年度、有效期不符）时，把该附件列入 unresolved 并写明原因，不要省略附件位置、改在文字中说明；
   - 招标文件明确要求投标人出具承诺或声明、但没有给出格式的条款；只是叙述要求、并未要求出具承诺或声明的条款不写，已在其他格式文件中承诺或声明过的不重复；
   - ${FIELDS_INPUT_FILE} 的 chapters 中 title_only=true 的章节，按招标文件对该章的要求写出正文。
   每项写 mode、after、basis（依据的条款或评分项）、blocks，以及需要时的 fields。mode=attach 放在 after 指定的目录叶子之后（写 ${OUTLINE_INPUT_FILE} 中的编号：对应的格式文件、“其他资料”或“资格证明”类章节，或相关正文小节），写 title（会进入投标文件目录）；mode=body 作为 after 指定的 title_only 章节的正文，不写 title。blocks 每项一段：{"text":"…"} 为文字段，其中 {{字段名}} 为填写位置；{"attachment":"字段名"} 为一个附件位置，只放一张图片，材料有多张图片时按顺序写多个附件位置，名称各不相同。承诺和声明的正文照录招标文件要求的内容，改为承诺语气，不新增内容；落款按招标文件要求写（投标人名称、日期，需要签字或盖章时写签字或盖章位置）。
   填写位置的名称：与 ${FIELDS_INPUT_FILE} 中已有字段是同一项信息时用相同名称（如投标人名称、投标日期），程序会把它们合为同一个填写项，不必列入 fields；其余新名称在 fields 中写 name、subject、kind（text 或 attachment）和 fill_by（签字、签名、盖章位置为 manual，其余为 ai）。新名称的 ai 字段同样按以上规则在 values 中取值或列入 unresolved：附件用 image_id 从资信库图片中选择，资信库没有或不全时列入 unresolved 并写明缺少什么，不得用不相关的图片充数。文字中需要写本投标文件页码时按第 11 条写页码引用。
11. 需要写本投标文件中某部分所在页码的字段（如“该声明函见投标文件第__页”），写页码引用，不写页码数字：{{页码:目录编号}} 写成数字（3 或 3-7），原句已有“第…页”时用；{{页码文字:目录编号}} 写成“第3页”或“第3页至第7页”。编号取自 ${OUTLINE_INPUT_FILE}，指向该内容所在的小节，程序导出时换成实际页码。
12. 人员的性别、出生日期、年龄，资料没有直接给出时按其身份证号推算，年龄按招标关键信息中的开标日期计算周岁；没有身份证号时列入 unresolved。企业规模（中型企业、小型企业、微型企业）按招标文件明确的所属行业和资信库中的上年度从业人员、营业收入、资产总额，依《中小企业划型标准规定》判断；指标缺少、无法判断时列入 unresolved。

结果格式（${FILL_OUTPUT_FILE}）：
{"values":[{"name":"普通文字字段","value":"取值"},{"name":"普通勾选项","selected":["选项"]},{"name":"附件","image_id":"图片 id"}],"rows":[{"table_id":"表格ID","row":2,"values":[{"name":"列名","value":"取值"}]}],"unresolved":[{"name":"普通字段","reason":"原因"},{"name":"某证明材料","reason":"资信库中没有符合招标要求的该项材料"},{"table_id":"表格ID","row":2,"name":"列名","reason":"该列无依据的原因"}],"links":[{"target":{"table_id":"表格ID","row":2,"name":"列名"},"source":{"name":"普通字段"},"form":"same"},{"target":{"name":"大写字段"},"source":{"name":"普通字段"},"form":"uppercase"}]}
- generated 每项示例：{"mode":"attach","after":"7","title":"某项目合同及验收证明","basis":"评分标准“供应商实施能力”","blocks":[{"attachment":"某项目合同（第1页）"},{"attachment":"某项目验收报告"}],"fields":[{"name":"某项目合同（第1页）","subject":"某项目","kind":"attachment","fill_by":"ai"},{"name":"某项目验收报告","subject":"某项目","kind":"attachment","fill_by":"ai"}]}；{"mode":"attach","after":"6","title":"某某承诺书","basis":"技术要求（二）","blocks":[{"text":"致：{{采购人名称}}"},{"text":"我公司承诺：…"},{"text":"投标人名称（公章）：{{投标人名称}}"},{"text":"日期：{{投标日期}}"}]}。没有时可省略。
- links 可省略；target、source 引用普通字段时只写 name，引用表格格子时同时写 table_id、row 和 name，都只能是文字字段，source 不能是另一条 links 的 target。
- 每个普通字段（links 的 target 除外）必须且只能出现在 values 或 unresolved 中一次；写入 rows 的行，每一列都必须给出取值或按单元格列入 unresolved；未使用的行不要写。
- 文字字段用 value，勾选项和择一用 selected（择一只写一项），附件用 image_id；没有表格时 rows 写空数组。
- 程序已预建空的结果文件，首次填充使用 write，内容较多时可分多次写入：首次用 write，之后用 edit 补充，每次写入后保持完整有效 JSON。可用 json-validation 自查结构。
- 提交后程序会逐项校验，不通过会把问题退回给你，届时修改同一文件。完成后直接结束，不输出总结。`;
}

function unitLabel(unit) {
  if (!unit.table_id) return unit.name;
  return unit.entry ? `${unit.name}（第${unit.row}条）` : `${unit.name}（表格第${unit.row}行）`;
}

// 清单中一行的称呼：可重复条目为“条目 e1 第 2 条”，表格为“表格 t3 第 2 行”。
function rowLabel(table, row) {
  return table.entries ? `条目 ${table.table_id} 第 ${row} 条` : `表格 ${table.table_id} 第 ${row} 行`;
}

function blockingIssue(message, extra = {}) {
  return { severity: 'blocking', file: FILL_OUTPUT_FILE, message, ...extra };
}

function qualityIssue(message, extra = {}) {
  return { severity: 'quality', file: FILL_OUTPUT_FILE, message, ...extra };
}

// JSON 与结构错误转为阻塞问题，交由提交修复；文件读取等程序异常照常抛出。
function parseFillResult(content) {
  let payload;
  try {
    payload = JSON.parse(String(content || '').replace(/^﻿/, '').trim());
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { payload: null, issues: [blockingIssue(`${FILL_OUTPUT_FILE} 不是合法 JSON：${error.message}`)] };
  }
  if (!validateFillSchema(payload)) {
    return {
      payload: null,
      issues: validateFillSchema.errors.map(item => blockingIssue(`${FILL_OUTPUT_FILE} 结构无效：${item.instancePath || '/'} ${item.message}`, { path: item.instancePath || '/' })),
    };
  }
  return { payload, issues: [] };
}

// 文字段中的填写位置 {{字段名}}；以“页码”开头的是页码引用，按页码规则换算。
const GENERATED_FIELD_PATTERN = /\{\{\s*(?!页码)([^{}]+?)\s*\}\}/g;

/**
 * 商务生成模板只核对能否执行：放置位置存在，引用的名称已有或已定义、同名类型一致，页码引用可换算。
 * 每个填写位置生成一个字段（id 为 g0001 起），与已有字段同名时沿用其 subject 和 fill_by，由 groupFieldUnits 合为同一填写项。
 * scope 为范围内的提取字段（含人工字段，供同名合并）和提取章节（body 只能挂在其中）。
 */
function readGeneratedTemplates(items = [], scope, outline, pageNodes, issues) {
  const leaves = new Map(collectOutlineLeaves(numberOutline(outline)).map(({ item }) => [item.number, item]));
  const scopeChapters = new Map((scope.chapters || []).map(chapter => [chapter.id, chapter]));
  const existing = new Map();
  for (const field of scope.fields || []) {
    if (!field.table_id && !isRuleField(field) && !existing.has(field.name)) existing.set(field.name, field);
  }
  const defined = new Map();
  for (const item of items) {
    for (const field of item.fields || []) {
      const name = field.name.trim();
      const same = existing.get(name);
      if (same && same.kind !== field.kind) issues.push(blockingIssue(`generated 的字段“${name}”与模版中的同名字段类型不同（模版为 ${same.kind}），同名字段类型必须一致`));
      if (!defined.has(name)) defined.set(name, { name, subject: field.subject.trim(), kind: field.kind, fill_by: field.fill_by });
    }
  }
  const definitionOf = (name) => {
    const field = existing.get(name);
    return field ? { name, subject: field.subject, kind: field.kind, fill_by: field.fill_by } : defined.get(name);
  };
  const chapters = [];
  const fields = [];
  items.forEach((item, index) => {
    const label = `generated 第 ${index + 1} 项${item.title ? `“${item.title.trim()}”` : ''}`;
    const node = leaves.get(item.after.trim());
    let section = item.title?.trim() || '';
    if (!node) {
      issues.push(blockingIssue(`${label} 的 after“${item.after}”不是 ${OUTLINE_INPUT_FILE} 中的目录叶子编号`));
    } else if (item.mode === 'body') {
      const chapter = scopeChapters.get(node.id);
      if (!chapter) issues.push(blockingIssue(`${label} 是 body，after“${item.after}”须是商务模版章节（见 ${FIELDS_INPUT_FILE} 的 chapters）`));
      else section = chapter.title;
    }
    if (item.mode === 'attach' && !item.title) issues.push(blockingIssue(`${label} 是 attach，必须写 title`));
    const addField = (name, kind) => {
      const definition = definitionOf(name);
      if (!definition) {
        issues.push(blockingIssue(`${label} 的“${name}”既不是模版中已有的字段，也没有在 fields 中定义`));
        return null;
      }
      if (definition.kind !== kind) {
        issues.push(blockingIssue(`${label} 的“${name}”是${definition.kind === 'attachment' ? '附件' : definition.kind === 'text' ? '文字字段' : '勾选项或择一'}，${kind === 'attachment' ? 'attachment 只能引用附件字段' : '文字段中只能引用文字字段'}`));
        return null;
      }
      const id = `g${String(fields.length + 1).padStart(4, '0')}`;
      fields.push({ id, name, subject: definition.subject, section, fill_by: definition.fill_by, kind, generated: true });
      return id;
    };
    const blocks = item.blocks.map((block, blockIndex) => {
      if (Object.hasOwn(block, 'text') === Object.hasOwn(block, 'attachment')) {
        issues.push(blockingIssue(`${label} 的 blocks 第 ${blockIndex + 1} 项必须且只能写 text 或 attachment 之一`));
        return { segments: [] };
      }
      if (block.attachment) {
        const id = addField(block.attachment.trim(), 'attachment');
        return { segments: id ? [{ field_id: id }] : [] };
      }
      const segments = [];
      const pushText = (text) => {
        if (!text) return;
        const converted = convertAgentPageRefs(text, pageNodes, OUTLINE_INPUT_FILE);
        for (const problem of converted.problems) issues.push(blockingIssue(`${label}：${problem}`));
        segments.push({ text: converted.value });
      };
      let last = 0;
      const text = block.text.replace(/\r\n?/g, '\n');
      for (const match of text.matchAll(GENERATED_FIELD_PATTERN)) {
        pushText(text.slice(last, match.index));
        const id = addField(match[1].trim(), 'text');
        if (id) segments.push({ field_id: id });
        last = match.index + match[0].length;
      }
      pushText(text.slice(last));
      return { segments };
    });
    chapters.push({
      id: crypto.randomUUID(),
      mode: item.mode,
      after: node?.id,
      basis: item.basis.trim(),
      ...(item.mode === 'attach' && item.title ? { title: item.title.trim() } : {}),
      section,
      blocks,
    });
  });
  return { chapters, fields };
}

// 逐项核对覆盖范围、字段类型、选项和图片，返回统一提交报告；未使用的表格行展开为留空。
// scope 给出范围内的提取字段和章节时，先读商务生成模板，合并其字段后再按填写项核对取值。
function validateBusinessTemplateFillResult(payload, units, imageIds = new Set(), outline = [], scope = null) {
  const issues = [];
  // 页码引用的目录编号换成节点 ID，整本导出时换成页码域。
  const pageNodes = numberedNodes(outline);
  const generated = readGeneratedTemplates(payload.generated, scope || { fields: [], chapters: [] }, outline, pageNodes, issues);
  if (scope && generated.fields.length) units = buildFillUnits([...scope.fields, ...generated.fields]);
  const scalars = new Map(units.filter(unit => !unit.table_id).map(unit => [unit.name, unit]));
  const tables = groupTableUnits(units);
  const decided = new Map();
  const entries = {};
  const unresolved = [];
  const usedRows = new Map([...tables.keys()].map(id => [id, new Set()]));
  const wholeRows = new Map([...tables.keys()].map(id => [id, new Set()]));
  const cellUnresolved = [];
  let filledCount = 0;
  let blankRowCount = 0;

  function decide(unit, label, decision) {
    if (decided.has(unit.key)) {
      issues.push(blockingIssue(`${label} 重复出现`));
      return;
    }
    decided.set(unit.key, decision);
    if (decision.reason) {
      unresolved.push({ label: unitLabel(unit), reason: decision.reason });
      for (const id of unit.field_ids) entries[id] = { unresolved_reason: decision.reason };
      return;
    }
    filledCount += 1;
    for (const id of unit.field_ids) entries[id] = { ...decision };
  }

  function checkValue(unit, item, label) {
    const provided = FILL_VALUE_KEYS.filter(key => Object.hasOwn(item, key));
    if (provided.length !== 1) {
      issues.push(blockingIssue(`${label} 必须且只能填写 value、selected 或 image_id 之一`));
      return null;
    }
    const hasValue = provided[0] === 'value';
    const hasSelected = provided[0] === 'selected';
    if (unit.kind === 'attachment') {
      if (provided[0] !== 'image_id') {
        issues.push(blockingIssue(`${label} 是附件，必须用 image_id 从资信库图片中选择`));
        return null;
      }
      if (!imageIds.has(item.image_id)) {
        issues.push(blockingIssue(`${label} 的图片 ${item.image_id} 不在资信库中`));
        return null;
      }
      return { image_id: item.image_id };
    }
    if (OPTION_KINDS.has(unit.kind)) {
      if (!hasSelected) {
        issues.push(blockingIssue(`${label} 是${unit.kind === 'select' ? '择一' : '勾选项'}，必须用 selected 从 options 中选择`));
        return null;
      }
      const selected = [...new Set(item.selected.map(option => option.trim()))];
      const invalid = selected.filter(option => !unit.options.includes(option));
      if (invalid.length) {
        issues.push(blockingIssue(`${label} 的选项不在 options 中：${invalid.join('、')}；可选：${unit.options.join('、')}`));
        return null;
      }
      if (unit.kind === 'select' && selected.length !== 1) {
        issues.push(blockingIssue(`${label} 是择一，selected 只能写一项`));
        return null;
      }
      return { selected };
    }
    if (!hasValue) {
      issues.push(blockingIssue(`${label} 是文字字段，必须用 value 填写`));
      return null;
    }
    const converted = convertAgentPageRefs(item.value.replace(/\r\n?/g, '\n'), pageNodes, OUTLINE_INPUT_FILE);
    for (const problem of converted.problems) issues.push(blockingIssue(`${label}：${problem}`));
    return converted.problems.length ? null : { value: converted.value };
  }

  function findTable(tableId, row, context) {
    const table = tables.get(tableId);
    if (!table) {
      issues.push(blockingIssue(`${context}：未知表格 ${tableId}`));
      return null;
    }
    if (!table.rows.has(row)) {
      issues.push(blockingIssue(`${context}：表格 ${tableId} 没有第 ${row} 行`));
      return null;
    }
    return table;
  }

  for (const item of payload.values) {
    const unit = scalars.get(item.name);
    if (!unit) {
      issues.push(blockingIssue(`values 中的“${item.name}”不是普通待填字段${tables.size ? '（表格列请写在 rows 中）' : ''}`));
      continue;
    }
    const decision = checkValue(unit, item, `“${item.name}”`);
    if (decision) decide(unit, `“${item.name}”`, decision);
  }

  for (const rowItem of payload.rows) {
    const table = findTable(rowItem.table_id, rowItem.row, 'rows');
    if (!table) continue;
    usedRows.get(rowItem.table_id).add(rowItem.row);
    for (const item of rowItem.values) {
      const label = `${rowLabel(table, rowItem.row)}“${item.name}”`;
      if (!table.columns.has(item.name)) {
        issues.push(blockingIssue(`${label} 不是该表格的列`));
        continue;
      }
      // 列与行按表格汇总，个别行没有该列时忽略这一项。
      const unit = table.cells.get(`${rowItem.row}\u0000${item.name}`);
      if (!unit) continue;
      const decision = checkValue(unit, item, label);
      if (decision) decide(unit, label, decision);
    }
  }

  for (const item of payload.unresolved) {
    const reason = item.reason.trim();
    if (!Object.hasOwn(item, 'table_id') && !Object.hasOwn(item, 'row')) {
      const unit = item.name ? scalars.get(item.name) : null;
      if (!unit) {
        issues.push(blockingIssue(item.name ? `unresolved 中的“${item.name}”不是普通待填字段` : 'unresolved 中有缺少 name 的普通字段'));
        continue;
      }
      decide(unit, `“${item.name}”`, { reason });
      continue;
    }
    if (!Object.hasOwn(item, 'table_id') || !Object.hasOwn(item, 'row')) {
      issues.push(blockingIssue('unresolved 中的表格项必须同时填写 table_id 和 row'));
      continue;
    }
    const table = findTable(item.table_id, item.row, 'unresolved');
    if (!table) continue;
    if (item.name) {
      const label = `${rowLabel(table, item.row)}“${item.name}”`;
      if (!table.columns.has(item.name)) {
        issues.push(blockingIssue(`${label} 不是该表格的列`));
        continue;
      }
      // 单元格无法确定只用于已写入 rows 的行，等全部行登记后再判断。
      cellUnresolved.push({ table, item, label, reason });
      continue;
    }
    wholeRows.get(item.table_id).add(item.row);
    for (const unit of [...table.cells.values()].filter(cell => cell.row === item.row)) {
      decide(unit, `${rowLabel(table, item.row)}“${unit.name}”`, { reason });
    }
  }

  for (const { table, item, label, reason } of cellUnresolved) {
    if (!usedRows.get(table.table_id).has(item.row)) {
      issues.push(blockingIssue(`${label} 所在行没有写入 rows；单元格 unresolved 只用于已填写的行，未使用的行不要写入，程序会留空`));
      continue;
    }
    const unit = table.cells.get(`${item.row}\u0000${item.name}`);
    if (unit) decide(unit, label, { reason });
  }

  // 联动在其他取值都登记后处理：来源同值且已有取值时一并写入，其余等确认弹窗按来源同步或换算。
  function findLinkUnit(ref, context) {
    if (!Object.hasOwn(ref, 'table_id') && !Object.hasOwn(ref, 'row')) {
      const unit = scalars.get(ref.name);
      if (!unit) issues.push(blockingIssue(`${context}“${ref.name}”不是普通待填字段`));
      return unit || null;
    }
    if (!Object.hasOwn(ref, 'table_id') || !Object.hasOwn(ref, 'row')) {
      issues.push(blockingIssue(`${context}引用表格格子时必须同时填写 table_id 和 row`));
      return null;
    }
    const table = findTable(ref.table_id, ref.row, context);
    if (!table) return null;
    const unit = table.cells.get(`${ref.row}\u0000${ref.name}`);
    if (!unit) {
      issues.push(blockingIssue(`${context}${rowLabel(table, ref.row)}没有“${ref.name}”`));
      return null;
    }
    if (!usedRows.get(table.table_id).has(ref.row)) {
      issues.push(blockingIssue(`${context}${rowLabel(table, ref.row)}没有写入 rows；联动只用于已填写的行`));
      return null;
    }
    return unit;
  }
  const links = (payload.links || []).map((item, index) => ({
    item,
    label: `links 第 ${index + 1} 项`,
    target: findLinkUnit(item.target, `links 第 ${index + 1} 项 target：`),
    source: findLinkUnit(item.source, `links 第 ${index + 1} 项 source：`),
  }));
  const linkTargets = new Set(links.map(link => link.target?.key).filter(Boolean));
  for (const { item, label, target, source } of links) {
    if (!target || !source) continue;
    if (target.kind !== 'text' || source.kind !== 'text') {
      issues.push(blockingIssue(`${label}：target 和 source 都只能是文字字段`));
      continue;
    }
    if (target.key === source.key) {
      issues.push(blockingIssue(`${label}：target 和 source 是同一个位置`));
      continue;
    }
    if (linkTargets.has(source.key)) {
      issues.push(blockingIssue(`${label}：source“${unitLabel(source)}”是另一条 links 的 target，请改为指向其来源`));
      continue;
    }
    if (decided.has(target.key)) {
      issues.push(blockingIssue(`${label}：“${unitLabel(target)}”已声明联动，不要再写入 values、rows 的值或 unresolved`));
      continue;
    }
    const link = { source: source.field_ids[0], form: item.form };
    const sourceValue = decided.get(source.key)?.value;
    const copied = item.form === 'same' && sourceValue ? { value: sourceValue } : null;
    const reason = item.form === 'same' ? `随“${unitLabel(source)}”填写` : `按“${unitLabel(source)}”换算大写`;
    decided.set(target.key, copied || { reason });
    if (copied) filledCount += 1;
    else unresolved.push({ label: unitLabel(target), reason });
    for (const id of target.field_ids) entries[id] = { link, ...(copied || { unresolved_reason: reason }) };
  }

  for (const unit of units.filter(item => !item.table_id && !decided.has(item.key))) {
    issues.push(blockingIssue(`“${unit.name}” 尚未填写或列入 unresolved`));
  }

  for (const table of tables.values()) {
    const orderedRows = [...table.rows].sort((a, b) => a - b);
    const used = usedRows.get(table.table_id);
    const whole = wholeRows.get(table.table_id);
    if (!used.size && !whole.size) {
      issues.push(blockingIssue(`表格 ${table.table_id} 一行都没有填写；没有可用记录时，把第 ${orderedRows[0]} 行整行列入 unresolved`));
    }
    const usedOrdered = [...used].sort((a, b) => a - b);
    if (usedOrdered.some((row, index) => row !== orderedRows[index])) {
      issues.push(qualityIssue(`表格 ${table.table_id} 已填写的行应从第 ${orderedRows[0]} 行起连续使用，当前为第 ${usedOrdered.join('、')} 行`));
    }
    if (whole.size && (used.size || [...whole].some(row => row !== orderedRows[0]))) {
      issues.push(qualityIssue(`表格 ${table.table_id} 的整行 unresolved 只用于没有任何记录时的第 ${orderedRows[0]} 行；未使用的行不要写入，程序会留空`));
    }
    for (const row of orderedRows) {
      const cells = [...table.cells.values()].filter(cell => cell.row === row);
      if (used.has(row)) {
        // 已使用行缺列按行汇总，退回修复时按行计数判断进展。
        const missing = cells.filter(cell => !decided.has(cell.key)).map(cell => cell.name);
        if (missing.length) issues.push(blockingIssue(`${rowLabel(table, row)}缺少：${missing.join('、')}，请填写取值或按单元格列入 unresolved`));
        continue;
      }
      if (whole.has(row)) continue;
      blankRowCount += 1;
      for (const cell of cells) {
        for (const id of cell.field_ids) entries[id] = { blank: true };
      }
    }
  }

  const blocked = issues.some(issue => issue.severity === 'blocking');
  return {
    value: blocked ? null : {
      entries,
      generated,
      stats: { field_count: units.length, filled_count: filledCount, unresolved, blank_row_count: blankRowCount },
    },
    issues,
    minimumGoal: '结果文件是完整有效 JSON；每个普通字段（含商务生成模板中的新字段）和已写入 rows 的表格行都有取值或列入 unresolved；文字、勾选项和附件的写法、选项及图片合法；商务生成模板的放置位置和引用的字段有效。',
  };
}

// 统一入口：先解析结构，再逐项核对，返回 Runtime 的提交报告。
function checkBusinessTemplateFillResult(content, units, imageIds, outline, scope = null) {
  const parsed = parseFillResult(content);
  if (!parsed.payload) return { value: null, issues: parsed.issues, minimumGoal: '结果文件是完整有效 JSON，结构符合 Schema。' };
  return validateBusinessTemplateFillResult(parsed.payload, units, imageIds, outline, scope);
}

// 执行失败续写原文件；提交退回只补充文件信息，问题清单和修复模式由公共层拼接。
function buildRetryPrompt(request) {
  if (request.kind === 'execution') {
    return `上一轮执行失败：${String(request.error?.message || request.error).slice(0, 800)}\n请在当前会话和工作区中继续完成 ${FILL_OUTPUT_FILE}，已有有效内容保留，不要重做已完成部分。`;
  }
  return `结果文件为当前工作目录根目录的 ${FILL_OUTPUT_FILE}，用 edit 或 write 修改同一文件并保持完整有效 JSON；未使用的表格行不要写入，程序会留空。修复后直接结束，不输出总结。`;
}

// 确认后按填写项重算统计：有值计入已填，无值的人工项计入人工处理（按名称），无值的 AI 项计入无法确定，留空的行单独计数。
function summarizeFillStats(fields = []) {
  const fieldsById = new Map(fields.map(field => [field.id, field]));
  const units = groupFieldUnits(fields);
  const manualNames = new Set();
  const unresolved = [];
  const blankRows = new Set();
  let filledCount = 0;
  for (const unit of units) {
    const state = readUnitState(unit, fieldsById);
    if (hasFilledValue(state)) filledCount += 1;
    else if (state.blank) blankRows.add(`${unit.table_id}\u0000${unit.row}`);
    else if (unit.fill_by === 'manual') manualNames.add(unit.name);
    else unresolved.push({ label: unitLabel(unit), reason: state.unresolved_reason || '未填写' });
  }
  return { field_count: units.length, filled_count: filledCount, manual_count: manualNames.size, unresolved, blank_row_count: blankRows.size };
}

// 用户确认值以填写项 key 为单位展开到字段：有值写入；为空时保留原有的留空和无法确定原因，其余不写值以保留占位。
// 联动声明随填写项保留；联动位置的值由确认弹窗按来源计算后随其他值一起提交。
// 弹窗显示的 {{页码:编号}} 按当前目录换回节点 ID 标记；用户手填的数字或写错的编号照原样保存。
function buildConfirmedEntries(fields = [], values = [], outline = []) {
  const fieldsById = new Map(fields.map(field => [field.id, field]));
  const pageNodes = numberedNodes(outline);
  const submitted = new Map(values.map(item => [item.key, item]));
  const entries = {};
  for (const unit of groupFieldUnits(fields)) {
    const item = submitted.get(unit.key) || {};
    const state = readUnitState(unit, fieldsById);
    const entry = item.image_id ? { image_id: item.image_id }
      : item.selected?.length ? { selected: item.selected }
        : textOf(item.value) ? { value: convertAgentPageRefs(String(item.value).replace(/\r\n?/g, '\n'), pageNodes, '').value }
          : state.blank ? { blank: true }
            : state.unresolved_reason ? { unresolved_reason: state.unresolved_reason }
              : null;
    if (!entry && !state.link) continue;
    for (const id of unit.field_ids) entries[id] = { ...entry, ...(state.link ? { link: state.link } : {}) };
  }
  return entries;
}

// 版式块中出现的字段 ID，规则同确认弹窗 BusinessFillDocument.tsx 的 collectFieldIds()。
function collectLayoutFieldIds(blocks = [], output = new Set()) {
  for (const block of blocks) {
    if (block.type === 'field' && block.field_id) output.add(block.field_id);
    for (const segment of block.segments || []) {
      if (segment.field_id) output.add(segment.field_id);
    }
    for (const row of block.rows || []) {
      for (const cell of row.cells || []) collectLayoutFieldIds(cell.blocks, output);
    }
  }
  return output;
}

// 商务部分跟随当前目录：提取章节只取仍为非 AI 叶子的模版章节；商务生成模板随所挂目录叶子（attach）或所挂提取章节（body）进入范围。
// 字段按底稿版式的块号归属章节，有商务生成模板时读 base 底稿。目录生成叶子由整本导出生成目录，老项目已抽进模版的目录章节也不填写。
async function loadBusinessFillScope({ workspaceStore, openXmlHelperService, signal }) {
  const template = workspaceStore.readBidTemplateFields();
  const leaves = collectOutlineLeaves(workspaceStore.loadTechnicalPlan().outlineData?.outline);
  const allLeafIds = new Set(leaves.map(({ item }) => item.id));
  const leafIds = new Set(leaves
    .filter(({ item }) => !['ai-generate', 'directory-generate'].includes(item.content_mode))
    .map(({ item }) => item.id));
  const layout = await readTemplateLayout({ openXmlHelperService, input: workspaceStore.getBidTemplateBaseRelativePath(), signal });
  const extracted = (template.chapters || []).filter(chapter => !chapter.generated && leafIds.has(chapter.id));
  const extractedIds = new Set(extracted.map(chapter => chapter.id));
  const generated = (template.chapters || []).filter(chapter => chapter.generated
    && (chapter.generated.mode === 'body' ? extractedIds.has(chapter.generated.after) : allLeafIds.has(chapter.generated.after)));
  const chapters = [...extracted, ...generated]
    .map(chapter => ({ ...chapter, blocks: layout.blocks.filter(block => block.index >= chapter.start_block && block.index < chapter.end_block) }));
  const fieldIds = new Set();
  for (const chapter of chapters) collectLayoutFieldIds(chapter.blocks, fieldIds);
  return { template, layout, chapters, fields: (template.fields || []).filter(field => fieldIds.has(field.id)) };
}

// 除标题外没有内容：没有字段和表格，有文字的段落不超过一段（标题段）。只看版式结构，不判断语义。
function isTitleOnlyChapter(blocks = []) {
  if (collectLayoutFieldIds(blocks).size || blocks.some(block => block.type === 'table')) return false;
  return blocks.filter(block => (block.segments || []).some(segment => textOf(segment.text))).length <= 1;
}

// 填写 Agent 的章节输入：范围内的提取章节按目录编号列出，标出只有标题的章节。
function buildChapterInputs(chapters, outline) {
  const numbers = new Map(collectOutlineLeaves(numberOutline(outline)).map(({ item }) => [item.id, item.number]));
  return chapters
    .filter(chapter => !chapter.generated && numbers.has(chapter.id))
    .map(chapter => ({ number: numbers.get(chapter.id), title: chapter.title, ...(isTitleOnlyChapter(chapter.blocks) ? { title_only: true } : {}) }));
}

// 商务生成模板写入 base 底稿（提取底稿末尾追加），再把章节和字段定义并入字段清单；没有生成模板时删除 base 底稿。
async function saveGeneratedTemplates({ workspaceStore, openXmlHelperService, generated, signal }) {
  if (!generated?.chapters.length) {
    workspaceStore.saveGeneratedTemplates(null);
    return;
  }
  const appended = await appendGeneratedChapters({
    openXmlHelperService,
    input: workspaceStore.getBidTemplateBlankRelativePath(),
    output: workspaceStore.getBidTemplateGeneratedBaseRelativePath(),
    chapters: generated.chapters.map(({ id, title, blocks }) => ({ id, ...(title ? { title } : {}), blocks })),
    fields: generated.fields.map(({ generated: _generated, ...field }) => field),
    signal,
  });
  const ranges = new Map(appended.chapters.map(item => [item.id, item]));
  const details = new Map(appended.fields.map(field => [field.id, field]));
  workspaceStore.saveGeneratedTemplates({
    chapters: generated.chapters.map(chapter => ({
      id: chapter.id,
      title: chapter.title || chapter.section,
      auto_fill: true,
      ...(chapter.title ? { heading: true } : {}),
      generated: { mode: chapter.mode, after: chapter.after, basis: chapter.basis },
      start_block: ranges.get(chapter.id).start_block,
      end_block: ranges.get(chapter.id).end_block,
    })),
    fields: generated.fields.map(field => ({
      ...field,
      ...(details.get(field.id)?.signature ? { signature: true } : {}),
      context: details.get(field.id)?.context,
    })),
  });
}

// 确认弹窗的章节顺序：提取章节按目录顺序；body 并入所挂章节；attach 排在所挂目录叶子之后（挂在非商务叶子时排在其后的商务章节之前），注明附于哪个小节。
function arrangeReviewChapters(chapters, outline) {
  const leaves = collectOutlineLeaves(numberOutline(outline));
  const order = new Map(leaves.map(({ item }, index) => [item.id, index]));
  const labels = new Map(leaves.map(({ item }) => [item.id, `${item.number} ${item.title}`]));
  const bodies = new Map();
  for (const chapter of chapters.filter(item => item.generated?.mode === 'body')) {
    bodies.set(chapter.generated.after, [...(bodies.get(chapter.generated.after) || []), ...chapter.blocks]);
  }
  return chapters
    .filter(chapter => chapter.generated?.mode !== 'body')
    .map((chapter, index) => ({
      chapter: chapter.generated
        ? { ...chapter, attached_to: labels.get(chapter.generated.after) }
        : { ...chapter, blocks: [...chapter.blocks, ...(bodies.get(chapter.id) || [])] },
      key: [order.get(chapter.generated?.after ?? chapter.id) ?? Number.MAX_SAFE_INTEGER, chapter.generated ? 1 : 0, index],
    }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2])
    .map(item => item.chapter);
}

// 图片所属记录的展示名，供确认弹窗分组。
function imageOwnerLabels(snapshot = {}) {
  const labels = new Map();
  for (const item of snapshot.certificates || []) labels.set(`certificate\u0000${item.certificateId}`, `资质：${item.name || '未命名'}`);
  for (const item of snapshot.employees || []) labels.set(`employee\u0000${item.employeeId}`, `员工：${item.name || '未命名'}`);
  for (const item of snapshot.projects || []) labels.set(`project\u0000${item.projectId}`, `业绩：${item.projectName || '未命名'}`);
  for (const item of snapshot.otherMaterials || []) labels.set(`other\u0000${item.materialId}`, `其他：${item.name || '未命名'}`);
  return labels;
}

// 确认弹窗数据：当前目录商务章节的填写项及当前值、资信库图片目录，以及按章节分组的模版版式。
// 版式读取空白底稿（正文填写开始前已创建），其块结构与已填写的模版一致；规则和页码字段只读显示。
async function loadBusinessFillReview({ workspaceStore, credentialLibraryService, openXmlHelperService }) {
  const { layout, chapters, fields } = await loadBusinessFillScope({ workspaceStore, openXmlHelperService });
  const fieldsById = new Map(fields.map(field => [field.id, field]));
  const snapshot = credentialLibraryService.load();
  const owners = imageOwnerLabels(snapshot);
  const units = groupFieldUnits(fields);
  const unitsByFieldId = new Map(units.flatMap(unit => unit.field_ids.map(id => [id, unit])));
  const outline = workspaceStore.loadTechnicalPlan().outlineData?.outline || [];
  const numbersById = new Map([...numberedNodes(outline)].map(([number, item]) => [item.id, number]));
  return {
    units: units.map((unit) => {
      // 联动的来源换成填写项 key 和名称，供弹窗按来源的当前输入同步；来源不在当前范围时不联动。
      const { link, ...state } = readUnitState(unit, fieldsById);
      const source = link && unitsByFieldId.get(link.source);
      return {
        key: unit.key,
        name: unit.name,
        kind: unit.kind,
        fill_by: unit.fill_by,
        field_ids: unit.field_ids,
        ...(unit.field_ids.every(id => fieldsById.get(id)?.signature) ? { signature: true } : {}),
        ...(unit.subject ? { subject: unit.subject } : {}),
        ...(unit.section ? { section: unit.section } : {}),
        ...(unit.instruction ? { instruction: unit.instruction } : {}),
        ...(unit.options ? { options: unit.options } : {}),
        ...(unit.table_id ? { table_id: unit.table_id, row: unit.row, ...(unit.entry ? { entry: true } : {}) } : {}),
        ...state,
        // 页码引用显示为 {{页码:编号}}，确认时按当前目录换回。
        ...(typeof state.value === 'string' ? { value: toAgentPageRefs(state.value, numbersById) } : {}),
        ...(source ? { link: { key: source.key, form: link.form, source_name: unitLabel(source) } } : {}),
      };
    }),
    rule_field_ids: fields.filter(isRuleField).map(field => field.id),
    base_size: layout.base_size,
    chapters: arrangeReviewChapters(chapters, outline).map(chapter => ({
      id: chapter.id,
      title: chapter.title,
      auto_fill: chapter.auto_fill !== false,
      ...(chapter.attached_to ? { attached_to: chapter.attached_to } : {}),
      blocks: chapter.blocks,
    })),
    images: (snapshot.images || []).map(image => ({
      image_id: image.imageId,
      group: image.ownerType === 'profile' ? '企业资料' : owners.get(`${image.ownerType}\u0000${image.ownerId}`) || '其他',
      label: CREDENTIAL_IMAGE_FIELD_LABELS[image.fieldKey] || image.fieldKey,
      name: image.customName || image.originalName,
      asset_url: image.assetUrl,
    })),
  };
}

// 正文页预览：按字段清单块号从当前已回填的 bid-template.docx 现截单章，不落盘；没有对应章节时返回 null。
// 规则和页码章节尚未编制（或目录变更后待重编）时返回 null，页面显示待编制。
async function previewBusinessChapter({ workspaceStore, openXmlHelperService, nodeId }) {
  if (!workspaceStore.hasBidTemplate()) return null;
  const chapter = (workspaceStore.readBidTemplateFields().chapters || []).find(item => item.id === nodeId);
  if (!chapter || (chapter.rule_page && !workspaceStore.readRulePageTables())) return null;
  return openXmlHelperService.createTemplateChapterDocx({
    input: workspaceStore.getBidTemplateRelativePath(),
    startBlock: chapter.start_block,
    endBlock: chapter.end_block,
  });
}

// 按阶段续跑：filling 运行副 Agent 并保存字段值，reviewing 等待用户确认，rendering 以底稿重新生成 Word；值已确认时只重试回填。
async function runBusinessTemplateFill({
  agentService,
  workspaceStore,
  credentialLibraryService,
  openXmlHelperService,
  inputs,
  state,
  primarySession = false,
  signal,
  isPauseError = () => false,
  waitForReview,
  onState,
  onActivity,
}) {
  let current = { ...state };
  const update = (patch) => {
    current = { ...current, ...patch, updated_at: new Date().toISOString() };
    onState?.(current);
    return current;
  };
  // 填写和统计只处理当前目录中的商务章节；回填 Word 仍按全部字段，范围外字段保留占位。
  // 商务生成模板写入后字段增加，置空 scopeFieldIds 重新读取范围。
  let scopeFieldIds = null;
  let scopeChapters = [];
  const readScopeFields = async () => {
    if (!scopeFieldIds) {
      const scope = await loadBusinessFillScope({ workspaceStore, openXmlHelperService, signal });
      scopeFieldIds = new Set(scope.fields.map(field => field.id));
      scopeChapters = scope.chapters;
    }
    return (workspaceStore.readBidTemplateFields().fields || []).filter(field => scopeFieldIds.has(field.id) && !isRuleField(field));
  };

  if (current.phase === 'filling') {
    const fields = await readScopeFields();
    const manualCount = new Set(fields.filter(field => field.fill_by === 'manual').map(field => field.name)).size;
    const units = buildFillUnits(fields);
    // 商务生成模板按招标要求写出，与有没有 AI 填写项无关：有商务章节就运行填写 Agent。
    if (!units.length && !scopeChapters.length) {
      workspaceStore.saveBidTemplateFieldValues({});
      workspaceStore.saveGeneratedTemplates(null);
      // 没有 AI 填写项也交给用户确认人工字段和附件；完全没有字段时直接回填。
      update({ phase: fields.length ? 'reviewing' : 'rendering', field_count: 0, filled_count: 0, manual_count: manualCount, unresolved: [], blank_row_count: 0, accepted_issues: [] });
    } else {
      const imageIds = new Set((credentialLibraryService.load().images || []).map(image => image.imageId));
      const outline = workspaceStore.loadTechnicalPlan().outlineData?.outline || [];
      signal?.throwIfAborted();
      const resumeSession = agentService.hasPersistentTaskSession(BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY);
      // 要求已在原会话发出时，继续只发送“继续之前的任务”。
      const prompted = resumeSession && wasStagePrompted(agentService.loadPersistentTask(BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY)?.state, BUSINESS_TEMPLATE_FILL_STAGE);
      const runId = crypto.randomUUID();
      if (resumeSession) {
        agentService.updatePersistentTask(BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY, {
          run_id: runId, status: 'running', phase: BUSINESS_TEMPLATE_FILL_STAGE, agent_connection: 'running', error: null,
        });
      }
      let result;
      try {
        result = await agentService.runTask({
          task_id: runId,
          title: '商务模版填写 Agent',
          primary_session: primarySession,
          summary_enabled: false,
          prompt: prompted ? CONTINUE_PROMPT : createBusinessTemplateFillPrompt({ resume: resumeSession, hasGlobalFacts: Boolean(textOf(inputs.globalFactsText)) }),
          output_file: FILL_OUTPUT_FILE,
          prepare_output_files: [FILL_OUTPUT_FILE],
          // 输入只在新会话写入；继续时沿用工作区已有快照。
          files: resumeSession ? [] : buildBusinessTemplateFillFiles({
            units,
            chapters: buildChapterInputs(scopeChapters, outline),
            credentialLibrary: credentialLibraryService.load(),
            tenderMarkdown: workspaceStore.readTenderMarkdown(),
            bidKeyInfoText: inputs.bidKeyInfoText,
            globalFactsText: inputs.globalFactsText,
            outline,
          }),
          signal,
          timeout_ms: FILL_AGENT_TIMEOUT_MS,
          persistent_task: { task_key: BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY, mode: resumeSession ? 'resume' : 'create' },
          initial_stage: BUSINESS_TEMPLATE_FILL_STAGE,
          json_validation_schemas: { [FILL_OUTPUT_FILE]: BUSINESS_TEMPLATE_FILL_JSON_SCHEMA },
          max_retries: 1,
          validateOutput: candidate => checkBusinessTemplateFillResult(candidate.output_content, units, imageIds, outline, { fields, chapters: scopeChapters }),
          buildRetryPrompt,
          onActivity,
        });
      } catch (error) {
        if (agentService.hasPersistentTaskSession(BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY)) {
          const paused = isPauseError(error);
          agentService.updatePersistentTask(BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY, {
            status: paused ? 'paused' : 'error', agent_connection: 'idle', ...(paused ? {} : { error: error?.message || String(error) }),
          });
        }
        throw error;
      }
      signal?.throwIfAborted();
      // Runtime 只在提交通过后返回，直接使用本轮已经验收的结果。
      const validated = result.validation_result;
      // 连续修复无改善后按原样放行的质量问题随状态记录，供任务日志说明。
      const acceptedIssues = (result.accepted_submission_issues || []).flatMap(item => item.issues.map(issue => issue.message));
      // 先把商务生成模板并入商务模版，再按合并后的字段清单保存取值。
      await saveGeneratedTemplates({ workspaceStore, openXmlHelperService, generated: validated.generated, signal });
      workspaceStore.saveBidTemplateFieldValues(validated.entries);
      scopeFieldIds = null;
      agentService.updatePersistentTask(BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY, {
        status: 'success', phase: 'completed', agent_connection: 'idle', error: null, completed_at: new Date().toISOString(),
      });
      update({ phase: 'reviewing', ...validated.stats, manual_count: manualCount, accepted_issues: acceptedIssues });
    }
  }

  if (current.phase === 'reviewing') {
    signal?.throwIfAborted();
    // 返回 null 表示自动确认，保留已保存的值。
    const confirmed = await waitForReview(signal);
    if (confirmed) {
      workspaceStore.saveBidTemplateFieldValues(buildConfirmedEntries(workspaceStore.readBidTemplateFields().fields || [], confirmed.values, workspaceStore.loadTechnicalPlan().outlineData?.outline));
    }
    update({ phase: 'rendering', ...summarizeFillStats(await readScopeFields()), confirmed_by: confirmed ? 'user' : 'auto' });
  }

  if (current.phase === 'rendering') {
    signal?.throwIfAborted();
    const missingImages = await renderBusinessTemplate({
      workspaceStore, credentialLibraryService, openXmlHelperService,
      fields: workspaceStore.readBidTemplateFields().fields || [],
      signal,
    });
    update({ phase: 'completed', ...excludeMissingImages(current, missingImages) });
  }
  return current;
}

// 商务填写、规则和页码编制与编辑保存都会回填同一份 bid-template.docx，逐个执行。
let renderQueue = Promise.resolve();

// 以底稿（有商务生成模板时为 base 底稿）按字段值和规则和页码编制结果重新生成商务模版 Word，返回所选图片已从资信库删除的字段名称。
// forExport 时签章位置写入留空、清除“待填写”占位供线下盖章，页码引用保留标记由整本导出换成页码域；否则显示引用的小节标题。
// removeRowFieldIds 为整本导出要删除的清单表未使用行的字段 ID，助手只删整行字段都在其中的行。
async function renderBusinessTemplate({
  workspaceStore,
  credentialLibraryService,
  openXmlHelperService,
  fields,
  signal,
  output = workspaceStore.getBidTemplateRelativePath(),
  forExport = false,
  removeRowFieldIds = [],
}) {
  const imagePaths = new Map((credentialLibraryService.load().images || []).map(image => [image.imageId, `credential-library/${image.relativePath}`]));
  const outline = workspaceStore.loadTechnicalPlan().outlineData?.outline;
  const displayPageRefs = createPageRefDisplay(outline, { forExport });
  const missingImages = new Set();
  const values = [];
  for (const field of fields) {
    if (Object.hasOwn(field, 'image_id')) {
      const image = imagePaths.get(field.image_id);
      // 确认后图片已从资信库删除时保留占位。
      if (image) values.push({ id: field.id, image });
      else missingImages.add(field.name);
    } else if (Object.hasOwn(field, 'selected')) {
      // 择一把备选原文换成选中项，勾选项只改方框。
      values.push(field.kind === 'select' ? { id: field.id, option: field.selected[0] } : { id: field.id, selected: field.selected });
    }
    else if (Object.hasOwn(field, 'blank')) values.push({ id: field.id, blank: true });
    // 纯空白文字值（AI 用空格表示留空）按留空回填，助手不接受空白文字。
    else if (Object.hasOwn(field, 'value')) values.push(textOf(field.value) ? { id: field.id, value: displayPageRefs(field.value) } : { id: field.id, blank: true });
    else if (forExport && field.signature) values.push({ id: field.id, blank: true });
  }
  const ruleTables = buildRuleTableFills(workspaceStore.readRulePageTables(), outline, { forExport });
  const run = renderQueue.then(() => openXmlHelperService.runJob({
    action: 'fill-template-fields',
    request: {
      input: workspaceStore.getBidTemplateBaseRelativePath(),
      output,
      values,
      rule_tables: ruleTables,
      remove_row_field_ids: removeRowFieldIds,
    },
    timeoutMs: FILL_RENDER_TIMEOUT_MS,
    signal,
  }));
  renderQueue = run.catch(() => {});
  await run;
  return missingImages;
}

// 已删除图片的附件不计入已填，改记为无法确定。
function excludeMissingImages(stats, missingImages) {
  if (!missingImages.size) return {};
  return {
    filled_count: Math.max(0, (stats.filled_count || 0) - missingImages.size),
    unresolved: [...(stats.unresolved || []), ...[...missingImages].map(label => ({ label, reason: '所选资信库图片已删除，保留占位' }))],
  };
}

// 填写完成后编辑字段值：先按新值回填 Word，成功后再保存清单，Word 被占用等失败时清单保持原值。
async function editBusinessFillValues({ workspaceStore, credentialLibraryService, openXmlHelperService, state, values }) {
  const scopeFieldIds = new Set((await loadBusinessFillScope({ workspaceStore, openXmlHelperService })).fields.map(field => field.id));
  const fields = workspaceStore.readBidTemplateFields().fields || [];
  const entries = buildConfirmedEntries(fields, values, workspaceStore.loadTechnicalPlan().outlineData?.outline);
  const nextFields = fields.map(field => ({
    ...Object.fromEntries(Object.entries(field).filter(([key]) => !UNIT_STATE_KEYS.includes(key))),
    ...(entries[field.id] || {}),
  }));
  const missingImages = await renderBusinessTemplate({ workspaceStore, credentialLibraryService, openXmlHelperService, fields: nextFields });
  workspaceStore.saveBidTemplateFieldValues(entries);
  const stats = summarizeFillStats(nextFields.filter(field => scopeFieldIds.has(field.id)));
  return { ...state, ...stats, ...excludeMissingImages(stats, missingImages), confirmed_by: 'user', updated_at: new Date().toISOString() };
}

// 整本导出用：以空白底稿和已确认的字段值临时生成一份商务模版，签章位置留白；用户在 Word 中对 bid-template.docx 的修改不带入。
// 清单表未使用的行删除（一行都没填时保留第一行的占位），返回的字段带导出时的留空结果，未填写项统计与 Word 中的标记一致。
async function renderBusinessTemplateForExport({ workspaceStore, credentialLibraryService, openXmlHelperService }) {
  workspaceStore.ensureBidTemplateBlank();
  const template = workspaceStore.readBidTemplateFields();
  const { fields, idleFieldIds } = applyListRowMarks(template.fields || []);
  const name = `bid-template-export-${crypto.randomUUID()}.docx`;
  const output = path.posix.join(path.posix.dirname(workspaceStore.getBidTemplateRelativePath()), name);
  const outputPath = path.join(path.dirname(workspaceStore.getBidTemplatePath()), name);
  const cleanup = () => fs.rmSync(outputPath, { force: true });
  try {
    const missingImages = await renderBusinessTemplate({
      workspaceStore, credentialLibraryService, openXmlHelperService, fields, output, forExport: true, removeRowFieldIds: idleFieldIds,
    });
    return { input: output, chapters: template.chapters || [], fields, missingImages, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// 并入导出的章节中仍待处理的填写项数，口径与确认弹窗一致：未填写、不是未使用的空行，也不是签章位置。
function countPendingUnits(fields = [], fieldIds = []) {
  const exported = new Set(fieldIds);
  const fieldsById = new Map(fields.map(field => [field.id, field]));
  return groupFieldUnits(fields).filter((unit) => {
    if (!unit.field_ids.some(id => exported.has(id))) return false;
    if (unit.field_ids.every(id => fieldsById.get(id)?.signature)) return false;
    const state = readUnitState(unit, fieldsById);
    return !hasFilledValue(state) && !state.blank;
  }).length;
}

module.exports = {
  BUSINESS_TEMPLATE_FILL_STAGE,
  FILL_OUTPUT_FILE,
  BUSINESS_TEMPLATE_FILL_JSON_SCHEMA,
  groupFieldUnits,
  buildFillUnits,
  buildFieldsInput,
  buildCredentialLibraryInput,
  buildConfirmedEntries,
  summarizeFillStats,
  collectLayoutFieldIds,
  loadBusinessFillScope,
  loadBusinessFillReview,
  previewBusinessChapter,
  renderBusinessTemplate,
  editBusinessFillValues,
  renderBusinessTemplateForExport,
  countPendingUnits,
  buildCredentialLibraryInput,
  parseFillResult,
  validateBusinessTemplateFillResult,
  checkBusinessTemplateFillResult,
  runBusinessTemplateFill,
};
