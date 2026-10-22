const { numberMarkdownLines } = require('../utils/markdownLineView.cjs');
const { buildBidSectionContextHint } = require('../utils/bidSectionContext.cjs');
const { AGENT_BLOCKS_FILE, readTenderBlockOutline } = require('./pi/piOpenXmlTool.cjs');
const { collectOutlineLeaves } = require('./technicalPlanOutline.cjs');

// 完整投标文件和商务标独立成册的一级目录依据：招标文件格式章节，或找不到格式章节时的响应文件要求。
const FORMAT_TEMPLATE_BASIS = 'format-template';
const RESPONSE_REQUIREMENTS_BASIS = 'response-requirements';
const OUTLINE_BASES = [FORMAT_TEMPLATE_BASIS, RESPONSE_REQUIREMENTS_BASIS];
const MARKDOWN_STRUCTURE_FILE = '招标原文（带行号）.md';
// 原文位置和“中标后使用”只在一级目录确认阶段使用，进入后续阶段前去掉。
const SELECTION_ONLY_FIELDS = ['source', 'post_award'];
// 标题核对取起始位置后的前几个非空块，兼容“附件N”与标题分两段的写法。
const TITLE_CHECK_UNIT_COUNT = 3;
const EXCERPT_CHARS = 60;
const BUSINESS_DEFAULT_CONTENT_MODES = new Set(['template-fill', 'directory-generate', 'manual-fill']);

function normalizeSourcePath(value) {
  return String(value || '').trim().replace(/\\/g, '/');
}

// 去掉空白、标点和 Markdown 标记后比较标题，只容忍序号和格式标注的删减。
function normalizeTitleText(value) {
  return String(value || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function truncateText(value, maxChars = EXCERPT_CHARS) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return Array.from(text).length > maxChars ? `${Array.from(text).slice(0, maxChars).join('')}…` : text;
}

/**
 * 准备一级目录阶段的原文结构，覆盖全部导入文件：Word 原件用助手列块（位置为块号）；
 * 没有 Word 原件的文件合并后加行号（位置为行号），全部没有 Word 原件时对当前招标正文加行号。
 * units 按来源（原件路径或带行号原文文件名）保存位置类型、非空块（或行）及位置上界，供程序核对 Agent 填写的原文位置。
 */
async function prepareTenderStructure({ workspaceStore, openXmlHelperService, signal }) {
  const sources = workspaceStore.listTenderSourceDocxRelativePaths();
  const files = [];
  const units = new Map();
  if (sources.length) {
    if (!openXmlHelperService?.runJob) throw new Error('Open XML 助手尚未初始化');
    const outline = await readTenderBlockOutline({ openXmlHelperService, sources, signal });
    files.push({ path: AGENT_BLOCKS_FILE, content: outline.text });
    for (const source of outline.sources) {
      const blocks = Array.isArray(source.blocks) ? source.blocks : [];
      units.set(normalizeSourcePath(source.path), {
        kind: 'blocks',
        min: 0,
        end: blocks.reduce((max, block) => Math.max(max, Number(block.index) + 1), 0),
        entries: blocks
          .filter((block) => !block.empty && String(block.text || '').trim())
          .map((block) => ({ position: Number(block.index), text: String(block.text || '') })),
      });
    }
  }
  // 混合导入时只补充没有 Word 原件的文件，避免同一份内容出现两套位置。
  const markdown = sources.length
    ? workspaceStore.listTenderSourceMarkdownsWithoutDocx()
      .map((file) => `【文件：${file.fileName}】\n${file.markdown.trim()}`)
      .join('\n\n')
    : String(workspaceStore.readTenderMarkdown() || '');
  if (markdown.trim()) {
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    files.push({ path: MARKDOWN_STRUCTURE_FILE, content: numberMarkdownLines(markdown) });
    units.set(MARKDOWN_STRUCTURE_FILE, {
      kind: 'lines',
      min: 1,
      end: lines.length + 1,
      entries: lines
        .map((text, index) => ({ position: index + 1, text }))
        .filter((entry) => entry.text.trim()),
    });
  } else if (!sources.length) {
    throw new Error('请先导入招标文件，再生成目录');
  }
  return { files, units, multipleSources: units.size > 1 };
}

// 多标段时说明当前投标范围；原文结构来自完整原件，可能包含其他标段的格式。
function buildOutlineSectionHint(storedPlan) {
  const selectedSectionId = storedPlan?.tenderFile?.selectedSectionId;
  const selectedSection = selectedSectionId && Array.isArray(storedPlan?.bidSections)
    ? storedPlan.bidSections.find((section) => section.id === selectedSectionId)
    : null;
  const hint = buildBidSectionContextHint(selectedSection, {
    hasSelectedSection: storedPlan?.bidSectionMode === 'multiple' && Boolean(selectedSectionId),
  });
  return hint
    ? `${hint}\n原文结构来自完整的招标原件，可能包含其他标段的内容；各标段的投标文件格式不同时，只提取当前标段适用的格式。`
    : '';
}

/** 构造完整投标文件和商务标独立成册的一级目录提示词；只写通用原则，不列举章节名或表单名。 */
function createFormatOutlinePrompt({ structure, fallbackInstruction, sectionHint, outputRequirements, outputFile }) {
  const hasBlocks = [...structure.units.values()].some((unit) => unit.kind === 'blocks');
  const hasLines = structure.units.has(MARKDOWN_STRUCTURE_FILE);
  const structureDescriptions = [
    hasBlocks ? `${AGENT_BLOCKS_FILE}：招标 Word 原件的原文结构，每行一个非空原文块，格式为“块号 [标记] 文本”，位置编号就是块号。` : '',
    hasLines
      ? `${MARKDOWN_STRUCTURE_FILE}：${hasBlocks ? '没有 Word 原件的招标文件（如 PDF）的正文，按文件依次排列，每份以“【文件：文件名】”开头；' : '招标文件正文，'}每行以“L+六位行号 |”开头，位置编号取 L 后的行号数字（去掉前导 0）；同一行号带 [n/m] 的是超长行的分片。`
      : '',
  ].filter(Boolean);
  const sourceInstruction = structure.multipleSources
    ? `原文来自多份文件，format_scope 的每一段和每个节点的 source 都要填写 source 字段：位于 Word 原件中的，填写该原件在 ${AGENT_BLOCKS_FILE} 中“原件：”后列出的完整路径${hasLines ? `；位于 ${MARKDOWN_STRUCTURE_FILE} 中的，填写 ${MARKDOWN_STRUCTURE_FILE}` : ''}。`
    : '只有一份原文，source 中不需要填写 source 字段。';
  return `请只在当前工作目录内工作。
${outputRequirements}

任务：
我们的目标是为编写投标文件准备目录。招标文件通常会规定投标文件由哪些文件组成，并给出这些文件的格式供投标人照着编制；目录必须忠实取自这部分内容。${sectionHint ? `\n${sectionHint}` : ''}

材料：
${structureDescriptions.map((item) => `- ${item}`).join('\n')}
- 上述原文是判断和提取目录的依据，需要完整阅读后再判断。${structureDescriptions.length > 1 ? '格式章节可能只在其中一份中，也可能分布在两份中。' : ''}
- 其他文件只在没有找到格式章节时按下文第三步使用，或用于理解项目背景和术语。

第一步：判断招标文件是否给出了投标文件的组成和格式。
1. 按内容功能判断：招标文件中规定投标人应提交哪些文件、并给出这些文件的格式、样式或待填写文本的部分，就是格式章节。它可能是一个独立章节，也可能是集中放在文件末尾的一组附件。不同招标文件对这部分的叫法不同，判断依据是内容，不是标题用语。须知、评审办法等只提到应提交某些材料而没有给出格式的内容，不算格式章节。
2. 找到格式章节时，basis 填 ${FORMAT_TEMPLATE_BASIS}，format_scope 是数组，填该部分的位置，通常只有一段；格式分在几处（例如部分格式在另一份文件中）时，按招标文件规定的投标文件组成顺序逐段填写。找不到时 basis 填 ${RESPONSE_REQUIREMENTS_BASIS}，format_scope 填 null，并按第三步处理。

第二步（basis=${FORMAT_TEMPLATE_BASIS}）：按格式章节提取目录。
1. 格式章节自身列出的每一个文件或格式条目对应一个节点，按原文顺序排列。格式章节的顶层条目作为一级目录；只有格式章节本身把若干条目归在某个上级条目之下时，才按原文层级生成子目录，不得自行归类或增加层级。
2. 不合并、不拆分、不新增、不删除条目。招标文件其他位置对材料的统称不另建节点，它们指的就是格式章节中对应的文件。
3. title 取原文中该条目的标题，只去掉序号、附件编号、章节编号等前缀和仅表示格式或样式的标注，其余文字原样保留，不改写、不补充、不概括。
4. 原文只给出标题、要求投标人自行编写内容的条目，同样作为节点。
5. 只在中标后、签订合同或履约验收时使用、投标阶段不需要提交的条目也要列出，并设置 post_award=true；其他节点不填写 post_award。
6. 位置规则：start 为起始位置；end 为结束位置之后的第一个位置，不包含在范围内。format_scope 的各段合起来覆盖整个格式章节。每个节点必须填写 source：start 为该条目标题所在位置；end 为同一段内下一个同级条目的起始位置，最后一个条目取父节点或该段的 end。每个一级目录必须完整位于 format_scope 的某一段内，一级目录按 format_scope 的段落顺序排列；子节点必须与父节点位于同一份文件且范围位于父节点内，同级节点按位置递增且不重叠。${sourceInstruction}
7. 原文中有投标文件目录或组成清单时，用它核对条目是否齐全、顺序是否一致。

第三步（basis=${RESPONSE_REQUIREMENTS_BASIS}）：${fallbackInstruction}只生成平铺的一级目录，不生成 children，不填写 source 和 post_award。

字段要求：
1. 顶层必须是对象，包含 basis、format_scope 和 outline。所有节点 id 填 null，程序接收后分配唯一 ID；数组顺序表示目录顺序；number 由程序计算，不要用编号充当 ID。
2. 一级目录必须填写 attr，子目录不填写 attr。attr 从“通用”“商务/资信”“技术”“其他”“目录”“报价”“业绩”中选择。
3. 叶子节点填写 content_mode，父节点只包含 children，不包含 content_mode 或 content_mode_note。一级目录叶子：attr=商务/资信或业绩时必须使用 template-fill；attr=目录时必须使用 directory-generate；attr=报价时必须使用 manual-fill。子目录叶子按内容判断：按格式填写的文件使用 template-fill，投标文件目录使用 directory-generate，报价使用 manual-fill。需要投标人自行编写方案正文的条目使用 ai-generate（一级目录的 attr 选“技术”）。无法归类的使用 other，并在 content_mode_note 说明原因。
4. description 简要说明该文件的用途。
5. 结构示例（只示意字段，标题、层级和数量以原文为准）：{"basis":"${FORMAT_TEMPLATE_BASIS}","format_scope":[{"start":120,"end":480}],"outline":[{"id":null,"title":"原文条目标题","description":"用途说明","attr":"商务/资信","content_mode":"template-fill","source":{"start":121,"end":160}},{"id":null,"title":"原文条目标题","description":"用途说明","attr":"商务/资信","source":{"start":160,"end":240},"children":[{"id":null,"title":"原文子条目标题","description":"用途说明","content_mode":"template-fill","source":{"start":161,"end":200}},{"id":null,"title":"原文子条目标题","description":"用途说明","content_mode":"template-fill","source":{"start":200,"end":240}}]}]}
6. ${outputFile} 必须是纯 JSON，不包含 Markdown 代码块或解释文字。程序已预置 Schema，可用 json-validation 自查，只传 file_path；本阶段结束后程序会校验结构，并逐项核对 source 位置与原文标题，不通过会退回问题清单继续修复。`;
}

/** 核对格式章节目录的原文位置与标题；返回统一提交报告的 blocking 问题。 */
function validateFormatOutline(generated, structure, file) {
  const issues = [];
  const addIssue = (path, message) => issues.push({ severity: 'blocking', file, path, message });
  const outline = Array.isArray(generated?.outline) ? generated.outline : [];

  if (generated?.basis !== FORMAT_TEMPLATE_BASIS) {
    if (generated?.format_scope !== null) {
      addIssue('/format_scope', `basis=${RESPONSE_REQUIREMENTS_BASIS} 时 format_scope 必须为 null`);
    }
    outline.forEach((item, index) => {
      if (item.children?.length || item.source !== undefined || item.post_award !== undefined) {
        addIssue(`/outline/${index}`, `basis=${RESPONSE_REQUIREMENTS_BASIS} 时只生成平铺的一级目录，「${item.title}」不得填写 children、source 或 post_award`);
      }
    });
    return issues;
  }

  // 解析来源并检查位置上下界；无法解析时记录问题并返回 null。
  const resolveRange = (anchor, path, label) => {
    if (!anchor) {
      addIssue(path, `${label}缺少 source 原文位置`);
      return null;
    }
    let key;
    if (anchor.source) {
      key = normalizeSourcePath(anchor.source);
      if (!structure.units.has(key)) {
        addIssue(`${path}/source`, `${label}的 source「${anchor.source}」不是原文结构中列出的来源，可选值：${[...structure.units.keys()].join('、')}`);
        return null;
      }
    } else if (structure.units.size === 1) {
      key = structure.units.keys().next().value;
    } else {
      addIssue(`${path}/source`, `原文来自多份文件，${label}必须填写 source 字段`);
      return null;
    }
    const unit = structure.units.get(key);
    const { start, end } = anchor;
    if (start >= end) {
      addIssue(path, `${label}的位置 [${start}, ${end}) 无效，start 必须小于 end`);
      return null;
    }
    if (start < unit.min || end > unit.end) {
      addIssue(path, `${label}的位置 [${start}, ${end}) 超出原文范围 [${unit.min}, ${unit.end})`);
      return null;
    }
    return { key, unit, start, end };
  };

  // 格式章节可以分在几处，各段不得重叠；只有一段时沿用“格式章节”的称呼。
  const scopeAnchors = Array.isArray(generated.format_scope) ? generated.format_scope : [];
  const scopeLabel = (index) => (scopeAnchors.length > 1 ? `格式章节第 ${index + 1} 段` : '格式章节');
  const scopes = scopeAnchors.map((anchor, index) => {
    const range = resolveRange(anchor, `/format_scope/${index}`, scopeLabel(index));
    return range && { ...range, label: scopeLabel(index) };
  });
  if (!scopes.length) addIssue('/format_scope', `basis=${FORMAT_TEMPLATE_BASIS} 时 format_scope 必须填写格式章节的位置`);
  if (!scopes.length || scopes.some((scope) => !scope)) return issues;
  scopes.forEach((scope, index) => {
    const overlapped = scopes.findIndex((other, otherIndex) => otherIndex < index
      && other.key === scope.key && other.start < scope.end && scope.start < other.end);
    if (overlapped >= 0) addIssue(`/format_scope/${index}`, `${scope.label}与${scopes[overlapped].label}的位置重叠`);
  });
  if (issues.length) return issues;

  const checkTitle = (item, range, path) => {
    const units = range.unit.entries
      .filter((entry) => entry.position >= range.start && entry.position < range.end)
      .slice(0, TITLE_CHECK_UNIT_COUNT);
    const title = normalizeTitleText(item.title);
    const haystack = normalizeTitleText(units.map((entry) => entry.text).join(''));
    if (title && haystack.includes(title)) return;
    const excerpt = units.map((entry) => `${entry.position} ${truncateText(entry.text)}`).join('；') || '（该范围内没有文字）';
    addIssue(`${path}/title`, `「${item.title}」与位置 ${range.start} 起的原文不符，该位置开始的原文为：${excerpt}。title 只能去掉序号、编号前缀和格式标注，其余照抄原文，不得改写、合并或补充；位置有误时请把 source.start 改为该条目标题所在位置。`);
  };

  // 节点须位于上级范围内：一级目录的上级是 format_scope 的各段，并按段落顺序排列；子目录的上级是父节点。
  // 同一上级范围内的同级节点按位置递增且不重叠。
  const visit = (items, parents, path) => {
    let parentIndex = 0;
    let previousEnd = parents[0].start;
    items.forEach((item, index) => {
      const nodePath = `${path}/${index}`;
      const label = `「${item.title}」`;
      const range = resolveRange(item.source, `${nodePath}/source`, label);
      if (!range) return;
      const matched = parents.findIndex((parent) => parent.key === range.key
        && range.start >= parent.start && range.end <= parent.end);
      if (matched < 0) {
        const sameSource = parents.filter((parent) => parent.key === range.key);
        addIssue(`${nodePath}/source`, sameSource.length
          ? `${label}的位置 [${range.start}, ${range.end}) 超出${sameSource.map((parent) => `${parent.label}的范围 [${parent.start}, ${parent.end})`).join('、')}`
          : `${label}必须与${parents.map((parent) => parent.label).join('或')}位于同一份文件`);
      } else if (matched < parentIndex) {
        addIssue(`${nodePath}/source`, `${label}位于${parents[matched].label}，一级目录须按 format_scope 的段落顺序排列`);
      } else {
        if (matched > parentIndex) {
          parentIndex = matched;
          previousEnd = parents[matched].start;
        }
        if (range.start < previousEnd) {
          addIssue(`${nodePath}/source`, `${label}的位置 [${range.start}, ${range.end}) 与前一个同级目录重叠或顺序颠倒；同级目录须按原文顺序排列，end 取下一个同级目录的起始位置`);
        }
        previousEnd = Math.max(previousEnd, range.end);
      }
      checkTitle(item, range, nodePath);
      if (item.children?.length) visit(item.children, [{ ...range, label }], `${nodePath}/children`);
    });
  };
  visit(outline, scopes, '/outline');
  return issues;
}

/**
 * 一级目录确认弹窗的默认勾选：技术文件独立成册勾选技术目录；
 * 完整投标文件勾选除中标后使用以外的全部节点；商务标独立成册只勾选模板填写、目录生成、人工填写叶子及其上级。
 */
function collectDefaultSelectedIds(items, outlineMode) {
  if (outlineMode === 'standalone-technical') {
    return (items || []).filter((item) => item.attr === '技术').map((item) => item.id);
  }
  const selectedIds = [];
  const visit = (nodes) => {
    let anySelected = false;
    for (const item of nodes || []) {
      if (item.post_award) continue;
      const selected = item.children?.length
        ? visit(item.children)
        : outlineMode !== 'standalone-business' || BUSINESS_DEFAULT_CONTENT_MODES.has(item.content_mode);
      if (selected) {
        selectedIds.push(item.id);
        anySelected = true;
      }
    }
    return anySelected;
  };
  visit(items);
  return selectedIds;
}

/**
 * 收集已确认的模板填写叶子，交给模版提取；带原文位置时提取直接按位置抽章。
 * 位于带行号原文中的条目没有 Word 原件可抽，留在目录中按待模板填写处理。
 */
function collectTemplateItems(items) {
  return collectOutlineLeaves(items)
    .filter(({ item }) => item.content_mode === 'template-fill'
      && normalizeSourcePath(item.source?.source) !== MARKDOWN_STRUCTURE_FILE)
    .map(({ item, path }) => ({
      id: item.id,
      title: item.title,
      path: path.join(' / '),
      ...(item.source ? { source: item.source } : {}),
    }));
}

module.exports = {
  FORMAT_TEMPLATE_BASIS,
  RESPONSE_REQUIREMENTS_BASIS,
  OUTLINE_BASES,
  SELECTION_ONLY_FIELDS,
  prepareTenderStructure,
  buildOutlineSectionHint,
  createFormatOutlinePrompt,
  validateFormatOutline,
  collectDefaultSelectedIds,
  collectTemplateItems,
};
