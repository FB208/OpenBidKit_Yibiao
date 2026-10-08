const crypto = require('node:crypto');
const Ajv = require('ajv');
const { BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY } = require('./businessTemplateFillAgentConfig.cjs');
const { CONTINUE_PROMPT, wasStagePrompted } = require('./contentGenerationAgent.cjs');
const { CREDENTIAL_IMAGE_FIELD_LABELS } = require('./credentialLibraryService.cjs');

const BUSINESS_TEMPLATE_FILL_STAGE = 'business-template-fill';
const FIELDS_INPUT_FILE = '商务模版待填字段.json';
const CREDENTIAL_INPUT_FILE = '资信库.json';
const TENDER_INPUT_FILE = '招标文件.md';
const BID_INFO_INPUT_FILE = '招标关键信息.md';
const GLOBAL_FACTS_INPUT_FILE = '全局事实设定.md';
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
  },
};
const ajv = new Ajv({ allErrors: true, strict: true });
const validateFillSchema = ajv.compile(BUSINESS_TEMPLATE_FILL_JSON_SCHEMA);

const FIELD_KINDS = new Set(['text', 'choice', 'attachment']);
const FILL_VALUE_KEYS = ['value', 'selected', 'image_id'];
const UNIT_STATE_KEYS = [...FILL_VALUE_KEYS, 'blank', 'unresolved_reason'];

// 字段清单 v2：同一表格内同名字段出现在多行时逐行填写，其余同名字段填同一个值；同名字段的 fill_by 一致。
function groupFieldUnits(fields = []) {
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
    const perRow = Boolean(field.table_id) && (tableRows.get(`${field.table_id}\u0000${field.name}`)?.size || 0) >= 2;
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
        ...(field.kind === 'choice' ? { options: field.options || [] } : {}),
        ...(perRow ? { table_id: field.table_id, row: field.row } : {}),
        field_ids: [],
      };
      unitsByKey.set(key, unit);
      units.push(unit);
    }
    unit.field_ids.push(field.id);
  }
  return units;
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
  };
}

// 按表格汇总逐行单元格：列取各行出现过的全部字段，行号沿用 Word 表格中的 1 基行号。
function groupTableUnits(units) {
  const tables = new Map();
  for (const unit of units) {
    if (!unit.table_id) continue;
    if (!tables.has(unit.table_id)) tables.set(unit.table_id, { table_id: unit.table_id, section: unit.section, columns: new Map(), rows: new Set(), cells: new Map() });
    const table = tables.get(unit.table_id);
    if (!table.columns.has(unit.name)) table.columns.set(unit.name, describeUnit(unit));
    table.rows.add(unit.row);
    table.cells.set(`${unit.row}\u0000${unit.name}`, unit);
  }
  return tables;
}

function buildFieldsInput(units) {
  return {
    fields: units.filter(unit => !unit.table_id).map(unit => ({ ...describeUnit(unit), ...(unit.section ? { section: unit.section } : {}), count: unit.field_ids.length })),
    tables: [...groupTableUnits(units).values()].map(table => ({
      table_id: table.table_id,
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
      ['邮箱', profile.email],
      ['法定代表人', profile.legalRepresentative],
      ['注册资本', profile.registeredCapital],
      ['经营期限开始', profile.operatingPeriodStart],
      ['经营期限结束', profile.operatingPeriodEnd],
      ['所在行业', profile.industry],
      ['公司性质', profile.companyType],
      ['参保人数', profile.insuredEmployeeCount],
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

function buildBusinessTemplateFillFiles({ units, credentialLibrary, tenderMarkdown, bidKeyInfoText, globalFactsText }) {
  return [
    { path: FIELDS_INPUT_FILE, content: `${JSON.stringify(buildFieldsInput(units), null, 2)}\n` },
    { path: CREDENTIAL_INPUT_FILE, content: `${JSON.stringify(buildCredentialLibraryInput(credentialLibrary), null, 2)}\n` },
    { path: TENDER_INPUT_FILE, content: `${textOf(tenderMarkdown) || '未提供'}\n` },
    { path: BID_INFO_INPUT_FILE, content: `${textOf(bidKeyInfoText) || '未提供'}\n` },
    { path: GLOBAL_FACTS_INPUT_FILE, content: `${textOf(globalFactsText) || '未提供'}\n` },
  ];
}

function createBusinessTemplateFillPrompt({ resume = false } = {}) {
  return `请只在当前工作目录内工作。已有材料足以判断时自主执行，不要调用 ask-user。${resume ? '这是之前中断任务的继续：先检查已有的结果文件，保留有效内容，只补齐或修正未完成部分。' : ''}

任务：为投标文件商务模版的待填字段取值，结果写入 ${FILL_OUTPUT_FILE}。程序会校验结果并写入 Word，你不读写任何 Word 文件，也不修改输入文件。

输入文件：
- ${FIELDS_INPUT_FILE}：fields 为普通字段，同名字段填同一个值，count 为该字段在模版中出现的次数；tables 为逐行填写的清单表，每个表格给出列（columns）和可用行号（rows），每一行代表一条记录，不要求填满。kind=text 为文字字段，kind=choice 为勾选项并给出 options，kind=attachment 为附件图片。subject 是该字段所描述的对象（要填写谁或什么的信息），section 是字段或表格所在的章节和表格标题。
- ${CREDENTIAL_INPUT_FILE}：投标人的资信库，包括基本信息、资质、员工、业绩、财务信息和其他资料；企业图片和各条记录下的“图片”列出可用图片的 id、栏目和名称。
- ${TENDER_INPUT_FILE}：当前标段的招标文件全文。
- ${BID_INFO_INPUT_FILE}：项目概述和招标关键信息。
- ${GLOBAL_FACTS_INPUT_FILE}：本次投标已确定的全局事实。

取值规则（先按 subject 确定应填写哪个对象的信息，名称不足以判断时结合 section 和招标文件中该位置的上下文判断）：
1. 企业信息（名称、统一社会信用代码、法定代表人、地址、电话、开户行、账号等）只取资信库，原样使用，不改写。
2. 人员、证书、业绩只能选资信库中的真实记录，按招标文件的资格和评分要求选最匹配的。全局事实已指定的人员在资信库中存在时必须选同一人；不在资信库中时，相关字段列入 unresolved 并说明原因。
3. tables 中同一行各列取自同一条记录，不同行取不同记录。只把有真实记录的行写入 rows，从该表格 rows 列出的第一行起按顺序连续使用；记录用完后剩余的行不要写入 rows 或 unresolved，程序会把它们留空。已使用的行中个别列没有依据时，按单元格列入 unresolved（写 table_id、row、name 和 reason）。一条可用记录都没有时，只把该表格的第一行整行列入 unresolved（只写 table_id、row 和 reason）。序号类列按行顺序填写。
4. 项目信息（项目名称、项目编号、招标人、工期或服务期、质量标准、投标有效期等）以全局事实为准，全局事实未提及时取招标文件原文。
5. 勾选项只能从 options 中原样选择，可以多选；没有依据时列入 unresolved。
6. 附件用 image_id 从资信库图片中选择一张：按栏目和所属记录匹配材料，人员、证书、业绩相关附件必须属于已选用的同一人员、证书或业绩记录；同一张图片可用于多处；没有匹配的图片时列入 unresolved。
7. 报价、金额、日期以及任何找不到明确依据的内容一律列入 unresolved 并写明原因，不编造、不估算。
8. 每个值为一段纯文本，需要多行时用换行符；有 instruction 时按其格式要求填写。

结果格式（${FILL_OUTPUT_FILE}）：
{"values":[{"name":"普通文字字段","value":"取值"},{"name":"普通勾选项","selected":["选项"]},{"name":"附件","image_id":"图片 id"}],"rows":[{"table_id":"表格ID","row":2,"values":[{"name":"列名","value":"取值"}]}],"unresolved":[{"name":"普通字段","reason":"原因"},{"table_id":"表格ID","row":2,"name":"列名","reason":"该列无依据的原因"}]}
- 每个普通字段必须且只能出现在 values 或 unresolved 中一次；写入 rows 的行，每一列都必须给出取值或按单元格列入 unresolved；未使用的行不要写。
- 文字字段用 value，勾选项用 selected，附件用 image_id；没有表格时 rows 写空数组。
- 程序已预建空的结果文件，首次填充使用 write，内容较多时可分多次写入：首次用 write，之后用 edit 补充，每次写入后保持完整有效 JSON。可用 json-validation 自查结构。
- 提交后程序会逐项校验，不通过会把问题退回给你，届时修改同一文件。完成后直接结束，不输出总结。`;
}

function unitLabel(unit) {
  return unit.table_id ? `${unit.name}（表格第${unit.row}行）` : unit.name;
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

// 逐项核对覆盖范围、字段类型、选项和图片，返回统一提交报告；未使用的表格行展开为留空。
function validateBusinessTemplateFillResult(payload, units, imageIds = new Set()) {
  const issues = [];
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
    if (unit.kind === 'choice') {
      if (!hasSelected) {
        issues.push(blockingIssue(`${label} 是勾选项，必须用 selected 从 options 中选择`));
        return null;
      }
      const selected = [...new Set(item.selected.map(option => option.trim()))];
      const invalid = selected.filter(option => !unit.options.includes(option));
      if (invalid.length) {
        issues.push(blockingIssue(`${label} 的选项不在 options 中：${invalid.join('、')}；可选：${unit.options.join('、')}`));
        return null;
      }
      return { selected };
    }
    if (!hasValue) {
      issues.push(blockingIssue(`${label} 是文字字段，必须用 value 填写`));
      return null;
    }
    return { value: item.value.replace(/\r\n?/g, '\n') };
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
      const label = `表格 ${rowItem.table_id} 第 ${rowItem.row} 行“${item.name}”`;
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
      const label = `表格 ${item.table_id} 第 ${item.row} 行“${item.name}”`;
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
      decide(unit, `表格 ${item.table_id} 第 ${item.row} 行“${unit.name}”`, { reason });
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
        if (missing.length) issues.push(blockingIssue(`表格 ${table.table_id} 第 ${row} 行缺少：${missing.join('、')}，请填写取值或按单元格列入 unresolved`));
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
      stats: { field_count: units.length, filled_count: filledCount, unresolved, blank_row_count: blankRowCount },
    },
    issues,
    minimumGoal: '结果文件是完整有效 JSON；每个普通字段和已写入 rows 的表格行都有取值或列入 unresolved；文字、勾选项和附件的写法、选项及图片合法。',
  };
}

// 统一入口：先解析结构，再逐项核对，返回 Runtime 的提交报告。
function checkBusinessTemplateFillResult(content, units, imageIds) {
  const parsed = parseFillResult(content);
  if (!parsed.payload) return { value: null, issues: parsed.issues, minimumGoal: '结果文件是完整有效 JSON，结构符合 Schema。' };
  return validateBusinessTemplateFillResult(parsed.payload, units, imageIds);
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
function buildConfirmedEntries(fields = [], values = []) {
  const fieldsById = new Map(fields.map(field => [field.id, field]));
  const submitted = new Map(values.map(item => [item.key, item]));
  const entries = {};
  for (const unit of groupFieldUnits(fields)) {
    const item = submitted.get(unit.key) || {};
    const state = readUnitState(unit, fieldsById);
    const entry = item.image_id ? { image_id: item.image_id }
      : item.selected?.length ? { selected: item.selected }
        : textOf(item.value) ? { value: String(item.value).replace(/\r\n?/g, '\n') }
          : state.blank ? { blank: true }
            : state.unresolved_reason ? { unresolved_reason: state.unresolved_reason }
              : null;
    if (!entry) continue;
    for (const id of unit.field_ids) entries[id] = entry;
  }
  return entries;
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

// 确认弹窗数据：全部填写项及当前值，以及资信库图片目录。
function loadBusinessFillReview({ workspaceStore, credentialLibraryService }) {
  const fields = workspaceStore.readBidTemplateFields().fields || [];
  const fieldsById = new Map(fields.map(field => [field.id, field]));
  const snapshot = credentialLibraryService.load();
  const owners = imageOwnerLabels(snapshot);
  return {
    units: groupFieldUnits(fields).map(unit => ({
      key: unit.key,
      name: unit.name,
      kind: unit.kind,
      fill_by: unit.fill_by,
      ...(unit.subject ? { subject: unit.subject } : {}),
      ...(unit.section ? { section: unit.section } : {}),
      ...(unit.instruction ? { instruction: unit.instruction } : {}),
      ...(unit.options ? { options: unit.options } : {}),
      ...(unit.table_id ? { table_id: unit.table_id, row: unit.row } : {}),
      ...readUnitState(unit, fieldsById),
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
  const fields = workspaceStore.readBidTemplateFields().fields || [];
  const manualCount = new Set(fields.filter(field => field.fill_by === 'manual').map(field => field.name)).size;

  if (current.phase === 'filling') {
    const units = buildFillUnits(fields);
    if (!units.length) {
      workspaceStore.saveBidTemplateFieldValues({});
      // 没有 AI 填写项也交给用户确认人工字段和附件；完全没有字段时直接回填。
      update({ phase: fields.length ? 'reviewing' : 'rendering', field_count: 0, filled_count: 0, manual_count: manualCount, unresolved: [], blank_row_count: 0, accepted_issues: [] });
    } else {
      const imageIds = new Set((credentialLibraryService.load().images || []).map(image => image.imageId));
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
          prompt: prompted ? CONTINUE_PROMPT : createBusinessTemplateFillPrompt({ resume: resumeSession }),
          output_file: FILL_OUTPUT_FILE,
          prepare_output_files: [FILL_OUTPUT_FILE],
          // 输入只在新会话写入；继续时沿用工作区已有快照。
          files: resumeSession ? [] : buildBusinessTemplateFillFiles({
            units,
            credentialLibrary: credentialLibraryService.load(),
            tenderMarkdown: workspaceStore.readTenderMarkdown(),
            bidKeyInfoText: inputs.bidKeyInfoText,
            globalFactsText: inputs.globalFactsText,
          }),
          signal,
          timeout_ms: FILL_AGENT_TIMEOUT_MS,
          persistent_task: { task_key: BUSINESS_TEMPLATE_FILL_AGENT_TASK_KEY, mode: resumeSession ? 'resume' : 'create' },
          initial_stage: BUSINESS_TEMPLATE_FILL_STAGE,
          json_validation_schemas: { [FILL_OUTPUT_FILE]: BUSINESS_TEMPLATE_FILL_JSON_SCHEMA },
          max_retries: 1,
          validateOutput: candidate => checkBusinessTemplateFillResult(candidate.output_content, units, imageIds),
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
      workspaceStore.saveBidTemplateFieldValues(validated.entries);
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
      workspaceStore.saveBidTemplateFieldValues(buildConfirmedEntries(workspaceStore.readBidTemplateFields().fields || [], confirmed.values));
    }
    update({ phase: 'rendering', ...summarizeFillStats(workspaceStore.readBidTemplateFields().fields || []), confirmed_by: confirmed ? 'user' : 'auto' });
  }

  if (current.phase === 'rendering') {
    signal?.throwIfAborted();
    const imagePaths = new Map((credentialLibraryService.load().images || []).map(image => [image.imageId, `credential-library/${image.relativePath}`]));
    const missingImages = new Set();
    const values = [];
    for (const field of workspaceStore.readBidTemplateFields().fields || []) {
      if (Object.hasOwn(field, 'image_id')) {
        const image = imagePaths.get(field.image_id);
        // 确认后图片已从资信库删除时保留占位。
        if (image) values.push({ id: field.id, image });
        else missingImages.add(field.name);
      } else if (Object.hasOwn(field, 'selected')) values.push({ id: field.id, selected: field.selected });
      else if (Object.hasOwn(field, 'blank')) values.push({ id: field.id, blank: true });
      else if (Object.hasOwn(field, 'value')) values.push({ id: field.id, value: field.value });
    }
    await openXmlHelperService.runJob({
      action: 'fill-template-fields',
      request: {
        input: workspaceStore.getBidTemplateBlankRelativePath(),
        output: workspaceStore.getBidTemplateRelativePath(),
        values,
      },
      timeoutMs: FILL_RENDER_TIMEOUT_MS,
      signal,
    });
    update({
      phase: 'completed',
      ...(missingImages.size ? {
        filled_count: Math.max(0, (current.filled_count || 0) - missingImages.size),
        unresolved: [...(current.unresolved || []), ...[...missingImages].map(label => ({ label, reason: '所选资信库图片已删除，保留占位' }))],
      } : {}),
    });
  }
  return current;
}

module.exports = {
  BUSINESS_TEMPLATE_FILL_STAGE,
  FILL_OUTPUT_FILE,
  BUSINESS_TEMPLATE_FILL_JSON_SCHEMA,
  groupFieldUnits,
  buildFillUnits,
  buildFieldsInput,
  buildConfirmedEntries,
  summarizeFillStats,
  loadBusinessFillReview,
  buildCredentialLibraryInput,
  parseFillResult,
  validateBusinessTemplateFillResult,
  checkBusinessTemplateFillResult,
  runBusinessTemplateFill,
};
