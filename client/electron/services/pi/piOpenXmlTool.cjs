const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const OPENXML_TOOL_NAME = 'openxml';
const LIST_BLOCKS_ACTION = 'list-blocks';
const EXTRACT_CHAPTERS_ACTION = 'extract-chapters';
const SCAN_TEMPLATE_FIELDS_ACTION = 'scan-template-fields';
const APPLY_TEMPLATE_FIELDS_ACTION = 'apply-template-fields';
const CONFIRM_TEMPLATE_FIELDS_ACTION = 'confirm-template-fields';
const READ_TEMPLATE_LAYOUT_ACTION = 'read-template-layout';
const APPEND_GENERATED_CHAPTERS_ACTION = 'append-generated-chapters';
const AGENT_BLOCKS_FILE = '招标原文结构.txt';
const AGENT_TEMPLATE_SOURCE_FILE = '投标模版源文件.docx';
const AGENT_FIELD_CANDIDATES_FILE = '投标模版字段候选.json';
const AGENT_TEMPLATE_TEXT_FILE = '投标模版正文.txt';
const AGENT_TEMPLATE_PREVIEW_FILE = '投标模版效果.txt';
const AGENT_TEMPLATE_FILE = 'bid-template.docx';
const AGENT_TEMPLATE_FIELDS_FILE = 'bid-template-fields.json';
const DEFAULT_TIMEOUT_MS = 300000;
// 与 openXmlHelperService 的 OPENXML_ENVIRONMENT_ERROR_CODE 一致；此处不引用服务模块，避免 Pi 层加载 Electron 依赖。
const OPENXML_ENVIRONMENT_ERROR_CODE = 'OPENXML_ENVIRONMENT';
const REPEATED_FAILURE_LIMIT = 3;
// 审阅效果正文后修改并重新应用的建议上限，达到后提示直接确认，不强制。
const REVIEW_APPLY_LIMIT = 3;
// 原文结构由目录任务在一级目录阶段之前准备，模版提取只推进抽章、扫描和写入字段三步。
const TEMPLATE_STEP_COUNT = 3;
const ACTION_LABELS = {
  [LIST_BLOCKS_ACTION]: '读取招标原文结构',
  [EXTRACT_CHAPTERS_ACTION]: '抽取投标模版章节',
  [SCAN_TEMPLATE_FIELDS_ACTION]: '识别待填位置',
  [APPLY_TEMPLATE_FIELDS_ACTION]: '写入字段',
  [CONFIRM_TEMPLATE_FIELDS_ACTION]: '确认模版',
};
const TEMPLATE_FIELD_CLASSIFICATION_SCHEMA = {
  type: 'object',
  required: ['fields', 'ignored_candidate_ids'],
  additionalProperties: false,
  properties: {
    // Agent 通读投标模版正文后补充的位置；id 与候选 id 一样用于 fields，定位由助手校验。
    positions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'at', 'op'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          at: { type: 'string', minLength: 1 },
          op: { type: 'string', enum: ['insert', 'span', 'choose', 'attachment', 'table'] },
          before: { type: 'string' },
          after: { type: 'string' },
          text: { type: 'string', minLength: 1 },
          options: { type: 'array', minItems: 2, items: { type: 'string', minLength: 1 } },
        },
      },
    },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        required: ['candidate_id', 'name', 'subject', 'fill_by'],
        additionalProperties: false,
        properties: {
          // 规则候选的 id，或 positions 中补充位置的 id。
          candidate_id: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          subject: { type: 'string', minLength: 1 },
          fill_by: { type: 'string', enum: ['ai', 'manual', 'rule'] },
          instruction: { type: 'string' },
          // 附件拆分为多个连续位置，每部分一张图片、生成一个字段。
          parts: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              required: ['name'],
              additionalProperties: false,
              properties: {
                name: { type: 'string', minLength: 1 },
                instruction: { type: 'string' },
              },
            },
          },
        },
      },
    },
    ignored_candidate_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
    // 导出时去掉的原文：at 为段落定位号，text 为段内原文，before/after 在段内不唯一时区分；未列入的保留。
    removals: {
      type: 'array',
      items: {
        type: 'object',
        required: ['at', 'text'],
        additionalProperties: false,
        properties: {
          at: { type: 'string', minLength: 1 },
          text: { type: 'string', minLength: 1 },
          before: { type: 'string' },
          after: { type: 'string' },
        },
      },
    },
    // 章节标题段：at 为该章顶层段落的定位号，null 表示没有标题段；未列出的章节由程序按目录标题认定。
    headings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['chapter_id', 'at'],
        additionalProperties: false,
        properties: {
          chapter_id: { type: 'string', minLength: 1 },
          at: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
    },
    // 可重复条目：每项一组，entries 按顺序给出各条的首末段落定位号（to 省略时同 from），至少两条。
    repeats: {
      type: 'array',
      items: {
        type: 'object',
        required: ['entries'],
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              required: ['from'],
              additionalProperties: false,
              properties: {
                from: { type: 'string', minLength: 1 },
                to: { type: 'string', minLength: 1 },
              },
            },
          },
        },
      },
    },
  },
};

function createToolResult(payload, compact = false, details = payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, compact ? 0 : 2) }],
    details,
  };
}

/** 把原文块整理成一行一块的紧凑文本，省略空块但保留原块号。 */
function formatBlockOutline(payload) {
  const lines = ['每行一个非空原文块，格式为“块号 [标记] 文本”。[标题N] 表示可用 sourceTitle 定位的原文标题（N 为大纲级别），[表格] 为整张表格的文字，[分页]、[分节] 表示该块带分页或分节；空块已省略，块号保持原值。'];
  for (const source of Array.isArray(payload?.sources) ? payload.sources : []) {
    const blocks = Array.isArray(source.blocks) ? source.blocks : [];
    lines.push('', `原件：${source.path}（共 ${blocks.length} 块）`);
    for (const block of blocks) {
      if (block.empty) continue;
      const level = Number(block.outline_level);
      const tags = [
        block.heading ? `[标题${level >= 0 && level < 9 ? level + 1 : ''}]` : '',
        block.kind === 'table' ? '[表格]' : '',
        block.page_break ? '[分页]' : '',
        block.section_break ? '[分节]' : '',
      ].join('');
      lines.push(`${block.index}${tags ? ` ${tags}` : ''} ${String(block.text || '').replace(/\s+/g, ' ').trim()}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// 任务目录只用于读取助手输出，结果写入工作区后即删除，避免 openxml-jobs 持续累积。
function removeJobDir(result) {
  if (result?.jobDir) fs.rmSync(result.jobDir, { recursive: true, force: true });
}

/** 调用助手列出招标 Word 原文块，返回紧凑原文结构文本和原始块数据，供 Agent 阅读和程序核对。 */
async function readTenderBlockOutline({ openXmlHelperService, sources, signal }) {
  const result = await openXmlHelperService.runJob({
    action: LIST_BLOCKS_ACTION,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    request: { sources },
    signal,
  });
  try {
    const blocksPath = path.join(result.jobDir, 'blocks.json');
    if (!fs.existsSync(blocksPath)) {
      throw new Error('助手没有写出原文结构');
    }
    const payload = JSON.parse(fs.readFileSync(blocksPath, 'utf8'));
    return {
      text: formatBlockOutline(payload),
      blockCount: result.blockCount || result.block_count || 0,
      sources: Array.isArray(payload?.sources) ? payload.sources : [],
    };
  } finally {
    removeJobDir(result);
  }
}

/** 调用助手读取投标模版版式（段落、表格和字段控件位置），供商务模版确认弹窗还原表单。 */
async function readTemplateLayout({ openXmlHelperService, input, signal }) {
  const result = await openXmlHelperService.runJob({
    action: READ_TEMPLATE_LAYOUT_ACTION,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    request: { input },
    signal,
  });
  try {
    const layoutPath = path.join(result.jobDir, 'template-layout.json');
    if (!fs.existsSync(layoutPath)) {
      throw new Error('助手没有写出商务模版版式');
    }
    return JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
  } finally {
    removeJobDir(result);
  }
}

function normalizeRelativePath(filePath) {
  const relativePath = String(filePath || '').trim().replace(/\\/g, '/');
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error('路径必须是当前工作区内的相对路径');
  }
  return path.posix.normalize(relativePath);
}

/** 创建 Agent 可调用的 Open XML 工具，内部转调主程序助手服务。 */
function createPiOpenXmlTool({
  workspaceDir,
  Type,
  openXmlHelperService,
  listBusinessSources,
  resolveAgentSources,
  bidTemplateSourcePath,
  bidTemplateSourceRelativePath,
  bidTemplatePath,
  bidTemplateRelativePath,
  bidTemplateFieldsPath,
  bidTemplateFieldsRelativePath,
  templateChapters,
  reportTaskFailure,
  onStep,
}) {
  // 分类从模型生成的文件读取，保留原工具参数的结构校验。
  const validateFieldSelections = new Ajv({ allErrors: true, strict: true }).compile(TEMPLATE_FIELD_CLASSIFICATION_SCHEMA);
  let repeatedFailure = { key: '', count: 0 };
  // 最近一次成功应用时分类文件的内容和累计成功次数；确认时要求分类文件此后没有修改。
  let lastApplied = null;
  let appliedCount = 0;
  // 抽章、扫描和开始写入字段各推进一步；进度回调失败不影响工具执行。
  const emitStep = (step, message) => {
    try { onStep?.({ step, total: TEMPLATE_STEP_COUNT, message }); } catch {}
  };
  // 环境错误或同一动作连续返回相同错误时直接报告失败，避免 Agent 反复重试或自行改动运行环境。
  const handleFailure = (action, error) => {
    const message = error?.message || String(error);
    if (error?.code === OPENXML_ENVIRONMENT_ERROR_CODE) {
      reportTaskFailure?.(message);
      return;
    }
    const key = `${action}\u0000${message}`;
    repeatedFailure = { key, count: repeatedFailure.key === key ? repeatedFailure.count + 1 : 1 };
    if (repeatedFailure.count >= REPEATED_FAILURE_LIMIT) {
      reportTaskFailure?.(`投标模版提取在“${ACTION_LABELS[action] || action}”这一步连续 ${repeatedFailure.count} 次遇到同一问题：${message}`);
    }
  };
  const tool = {
    name: OPENXML_TOOL_NAME,
    label: 'Open XML 助手',
    description: '抽取投标模版章节、扫描待填候选，并按分类文件写入 Word 内容控件。按 extract-chapters、scan-template-fields、apply-template-fields、confirm-template-fields 顺序调用；招标原文结构.txt 已由程序准备，缺失时才用 list-blocks 重新生成。scan-template-fields 写出带定位号的投标模版正文.txt。apply-template-fields 只传 fields_file，成功后写出投标模版效果.txt，审阅无误后调用 confirm-template-fields 结束；失败时编辑分类文件后重新提交路径，不要在工具参数里重复输出字段清单。',
    promptSnippet: '用 openxml 抽取投标模版、扫描待填候选并写入内容控件。',
    parameters: Type.Object({
      action: Type.String({
        enum: [LIST_BLOCKS_ACTION, EXTRACT_CHAPTERS_ACTION, SCAN_TEMPLATE_FIELDS_ACTION, APPLY_TEMPLATE_FIELDS_ACTION, CONFIRM_TEMPLATE_FIELDS_ACTION],
        description: '依次列块、抽章、扫描待填候选、应用分类、审阅后确认。',
      }),
      chapters: Type.Optional(Type.Array(Type.Object({
        id: Type.Optional(Type.String({ description: '已确认模板目录中该目录的 id。' })),
        title: Type.String({ minLength: 1, description: '投标模版里使用的一级目录标题。' }),
        sourceTitle: Type.Optional(Type.String({ description: '招标 Word 里的真实标题，仅适用于招标原文结构中标记为 [标题N] 的块。' })),
        source: Type.Optional(Type.String({ description: '该章所在原件在招标原文结构.txt 中“原件：”后列出的完整路径；多份 Word 原件时必填。' })),
        startBlock: Type.Optional(Type.Number({ minimum: 0, description: '起始标题块号，含；标题块没有 [标题N] 标记时必须与 endBlock 一起提供。' })),
        endBlock: Type.Optional(Type.Number({ minimum: 1, description: '结束块号，不含；使用 startBlock 时应停在下一同级章节或附件之前。' })),
      }, { additionalProperties: false }), {
        description: 'extract-chapters 必填。带 [标题N] 标记的标题可提供 sourceTitle；没有该标记时必须提供 startBlock 和 endBlock。',
      })),
      fields_file: Type.Optional(Type.String({
        minLength: 1,
        description: 'apply-template-fields 必填，当前工作区内的分类 JSON 文件路径。顶层为 fields 和 ignored_candidate_ids 数组，可选 positions、removals、headings 和 repeats 数组；positions 每项包含 id、at（投标模版正文中的定位号）、op（insert、span、choose、attachment 或 table），按 op 填写 before、after、text、options；removals 每项包含 at、text，可选 before、after；headings 每项包含 chapter_id 和 at（定位号或 null）；repeats 每项包含 entries（至少两条，每条 from 和可选 to 为首末段落定位号）；fields 每项包含 candidate_id（规则候选或补充位置的 id）、name、subject、fill_by（ai、manual 或 rule），可选 instruction；附件需要多张图片时用 parts 拆分。',
      })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params, signal) => {
      try {
        if (!openXmlHelperService?.runJob) {
          throw new Error('Open XML 助手尚未初始化');
        }

        const action = String(params.action || '').trim();
        const businessSources = listBusinessSources();
        if (!businessSources.length) {
          throw new Error('请重新导入招标文件');
        }

        if (action === LIST_BLOCKS_ACTION) {
          const { text, blockCount } = await readTenderBlockOutline({
            openXmlHelperService,
            sources: businessSources,
            signal,
          });
          fs.writeFileSync(path.join(workspaceDir, AGENT_BLOCKS_FILE), text, 'utf8');
          return createToolResult({
            ok: true,
            action,
            file_path: AGENT_BLOCKS_FILE,
            block_count: blockCount,
            message: `已写入 ${AGENT_BLOCKS_FILE}，请按块号定点读取需要核对的部分后抽章。`,
          });
        }

        if (action === EXTRACT_CHAPTERS_ACTION) {
          const chapters = resolveChapterSources(
            bindTemplateChapters(normalizeChapters(params.chapters), templateChapters),
            businessSources,
            resolveAgentSources,
          );
          if (!chapters.length) {
            throw new Error('extract-chapters 需要 chapters');
          }
          const missingLocate = chapters.filter((item) => !item.sourceTitle && item.startBlock == null);
          if (missingLocate.length) {
            throw new Error(`这些章节缺少原文定位：${missingLocate.map((item) => item.title).join('、')}`);
          }

          const result = await openXmlHelperService.runJob({
            action: EXTRACT_CHAPTERS_ACTION,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            request: {
              sources: businessSources,
              chapters,
              output: bidTemplateSourceRelativePath,
            },
            signal,
          });
          removeJobDir(result);

          if (bidTemplateSourcePath && fs.existsSync(bidTemplateSourcePath)) {
            fs.copyFileSync(bidTemplateSourcePath, path.join(workspaceDir, AGENT_TEMPLATE_SOURCE_FILE));
          }

          emitStep(1, `已抽取 ${chapters.length} 个章节`);
          return createToolResult({
            ok: true,
            action,
            file_path: AGENT_TEMPLATE_SOURCE_FILE,
            output: result.output || bidTemplateSourceRelativePath,
            message: '投标模版章节已抽取，请继续扫描待填字段。',
          });
        }

        if (action === SCAN_TEMPLATE_FIELDS_ACTION) {
          if (!bidTemplateSourcePath || !fs.existsSync(bidTemplateSourcePath)) {
            throw new Error('请先调用 extract-chapters 抽取投标模版章节');
          }
          const result = await openXmlHelperService.runJob({
            action: SCAN_TEMPLATE_FIELDS_ACTION,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            request: { input: bidTemplateSourceRelativePath },
            signal,
          });
          let candidateData;
          let templateText;
          try {
            const candidatesPath = path.join(result.jobDir, 'template-field-candidates.json');
            const templateTextPath = path.join(result.jobDir, 'template-text.txt');
            if (!fs.existsSync(candidatesPath) || !fs.existsSync(templateTextPath)) {
              throw new Error('助手没有写出投标模版字段候选和模版正文');
            }
            candidateData = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
            templateText = fs.readFileSync(templateTextPath, 'utf8');
          } finally {
            removeJobDir(result);
          }
          fs.writeFileSync(
            path.join(workspaceDir, AGENT_FIELD_CANDIDATES_FILE),
            `${JSON.stringify(candidateData, null, 2)}\n`,
            'utf8',
          );
          fs.writeFileSync(path.join(workspaceDir, AGENT_TEMPLATE_TEXT_FILE), templateText, 'utf8');
          const toolPayload = {
            ok: true,
            action,
            file_path: AGENT_FIELD_CANDIDATES_FILE,
            template_text_path: AGENT_TEMPLATE_TEXT_FILE,
            version: candidateData.version,
            default_suggested_fill_by: candidateData.default_suggested_fill_by,
            contexts: candidateData.contexts,
            candidates: candidateData.candidates,
            candidate_count: candidateData.candidates.length,
            message: `已写入 ${AGENT_FIELD_CANDIDATES_FILE} 和 ${AGENT_TEMPLATE_TEXT_FILE}，当前结果已包含紧凑候选。请通读 ${AGENT_TEMPLATE_TEXT_FILE}，写好分类文件后调用 apply-template-fields。`,
          };
          emitStep(2, `识别到 ${candidateData.candidates.length} 个待填位置，正在分类`);
          return createToolResult(toolPayload, true, {
            ok: true,
            action,
            file_path: AGENT_FIELD_CANDIDATES_FILE,
            candidate_count: candidateData.candidates.length,
          });
        }

        if (action === APPLY_TEMPLATE_FIELDS_ACTION) {
          if (!bidTemplateSourcePath || !fs.existsSync(bidTemplateSourcePath)) {
            throw new Error('请先调用 extract-chapters 抽取投标模版章节');
          }
          const classificationPath = normalizeRelativePath(params.fields_file);
          if (classificationPath === '..' || classificationPath.startsWith('../')) {
            throw new Error('fields_file 必须位于当前工作区内');
          }
          const classificationContent = fs.readFileSync(path.join(workspaceDir, classificationPath), 'utf8');
          const selections = JSON.parse(classificationContent);
          if (!validateFieldSelections(selections)) {
            const errors = validateFieldSelections.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('；');
            throw new Error(`分类文件结构无效，请修改 ${classificationPath} 后重新提交路径：${errors}`);
          }
          const fields = normalizeTemplateFields(selections.fields);
          const ignoredCandidateIds = normalizeCandidateIds(selections.ignored_candidate_ids);
          const positions = normalizePositions(selections.positions);
          const removals = normalizeRemovals(selections.removals);
          const headings = normalizeHeadings(selections.headings);
          const repeats = normalizeRepeats(selections.repeats);
          emitStep(3, `正在写入 ${fields.length} 个字段`);
          const result = await openXmlHelperService.runJob({
            action: APPLY_TEMPLATE_FIELDS_ACTION,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            request: {
              input: bidTemplateSourceRelativePath,
              output: bidTemplateRelativePath,
              fields_output: bidTemplateFieldsRelativePath,
              fields,
              ignored_candidate_ids: ignoredCandidateIds,
              positions,
              removals,
              headings,
              repeats,
            },
            signal,
          });
          try {
            const previewPath = path.join(result.jobDir, 'template-preview.txt');
            if (!fs.existsSync(previewPath)) throw new Error('助手没有写出投标模版效果正文');
            fs.writeFileSync(path.join(workspaceDir, AGENT_TEMPLATE_PREVIEW_FILE), fs.readFileSync(previewPath, 'utf8'), 'utf8');
          } finally {
            removeJobDir(result);
          }
          if (!bidTemplatePath || !bidTemplateFieldsPath
            || !fs.existsSync(bidTemplatePath) || !fs.existsSync(bidTemplateFieldsPath)) {
            throw new Error('助手没有同时写出投标模版和字段清单');
          }
          fs.copyFileSync(bidTemplatePath, path.join(workspaceDir, AGENT_TEMPLATE_FILE));
          fs.copyFileSync(bidTemplateFieldsPath, path.join(workspaceDir, AGENT_TEMPLATE_FIELDS_FILE));
          lastApplied = { path: classificationPath, content: classificationContent };
          appliedCount += 1;
          return createToolResult({
            ok: true,
            action,
            file_path: AGENT_TEMPLATE_FIELDS_FILE,
            preview_path: AGENT_TEMPLATE_PREVIEW_FILE,
            template_file_path: AGENT_TEMPLATE_FILE,
            output: result.output || bidTemplateRelativePath,
            field_count: result.blockCount || result.block_count || fields.length,
            message: appliedCount >= REVIEW_APPLY_LIMIT
              ? `已按分类生成投标模版和 ${AGENT_TEMPLATE_PREVIEW_FILE}，已修改应用 ${appliedCount} 次：只剩明显错误时再修改，否则直接调用 confirm-template-fields 确认。`
              : `已按分类生成投标模版。请通读 ${AGENT_TEMPLATE_PREVIEW_FILE} 审阅导出效果，有问题修改分类文件后重新应用，确认无误后调用 confirm-template-fields。`,
          });
        }

        if (action === CONFIRM_TEMPLATE_FIELDS_ACTION) {
          if (!lastApplied) {
            throw new Error('请先调用 apply-template-fields 应用分类文件，并审阅投标模版效果.txt');
          }
          const current = fs.existsSync(path.join(workspaceDir, lastApplied.path))
            ? fs.readFileSync(path.join(workspaceDir, lastApplied.path), 'utf8')
            : '';
          if (current !== lastApplied.content) {
            throw new Error(`${lastApplied.path} 在上次应用后有修改，请先重新调用 apply-template-fields，审阅新的投标模版效果.txt 后再确认`);
          }
          return createToolResult({ ok: true, action, file_path: AGENT_TEMPLATE_FIELDS_FILE, message: '投标模版已确认。' });
        }

        throw new Error(`未知动作：${action}`);
      } catch (error) {
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : error;
        }
        throw error;
      }
    },
  };
  return {
    ...tool,
    // 成功后清空连续失败计数；失败时判断是否需要直接终止任务。
    execute: async (toolCallId, params, signal) => {
      try {
        const result = await tool.execute(toolCallId, params, signal);
        repeatedFailure = { key: '', count: 0 };
        return result;
      } catch (error) {
        if (!signal?.aborted) handleFailure(String(params?.action || '').trim(), error);
        throw error;
      }
    },
  };
}

function normalizeChapters(chapters) {
  return (Array.isArray(chapters) ? chapters : [])
    .map((item) => ({
      id: String(item?.id || '').trim(),
      title: String(item?.title || '').trim(),
      sourceTitle: String(item?.sourceTitle || '').trim(),
      source: String(item?.source || '').trim(),
      startBlock: Number.isFinite(Number(item?.startBlock)) ? Math.floor(Number(item.startBlock)) : undefined,
      endBlock: Number.isFinite(Number(item?.endBlock)) ? Math.floor(Number(item.endBlock)) : undefined,
    }))
    .filter((item) => item.title);
}

/**
 * 按已确认目录核对抽章：每个目录恰好抽一章，按目录顺序排列，并注入是否自动填写和是否为规则和页码章节。
 * 未提供已确认目录时（如其他调用方）保持原样。
 */
function bindTemplateChapters(chapters, templateChapters) {
  if (!Array.isArray(templateChapters)) return chapters;
  const order = new Map(templateChapters.map((item, index) => [item.id, index]));
  const seen = new Set();
  const problems = [];
  for (const chapter of chapters) {
    if (!order.has(chapter.id)) problems.push(`「${chapter.title}」的 id 不是已确认目录的 id`);
    else if (seen.has(chapter.id)) problems.push(`「${chapter.title}」重复抽取`);
    seen.add(chapter.id);
  }
  const missing = templateChapters.filter((item) => !seen.has(item.id)).map((item) => item.title);
  if (missing.length) problems.push(`以下目录尚未抽取：${missing.join('、')}`);
  if (problems.length) {
    throw new Error(`抽章与已确认目录不一致：${problems.join('；')}。每个已确认目录抽一章，id 填该目录的 id。`);
  }
  return [...chapters]
    .sort((left, right) => order.get(left.id) - order.get(right.id))
    .map((chapter) => ({
      ...chapter,
      auto_fill: templateChapters[order.get(chapter.id)].auto_fill !== false,
      ...(templateChapters[order.get(chapter.id)].rule_page ? { rule_page: true } : {}),
    }));
}

function normalizeTemplateFields(fields) {
  return (Array.isArray(fields) ? fields : []).map((item) => ({
    candidate_id: String(item?.candidate_id || '').trim(),
    name: String(item?.name || '').trim(),
    subject: String(item?.subject || '').trim(),
    fill_by: String(item?.fill_by || '').trim(),
    ...(String(item?.instruction || '').trim() ? { instruction: String(item.instruction).trim() } : {}),
    ...(Array.isArray(item?.parts) ? {
      parts: item.parts.map((part) => ({
        name: String(part?.name || '').trim(),
        ...(String(part?.instruction || '').trim() ? { instruction: String(part.instruction).trim() } : {}),
      })),
    } : {}),
  }));
}

// 锚点文字保留原样（空白也参与定位），只去掉 id、at、op 两端的空白；未提供的键不传，便于助手区分“没写”和“写了空串”。
function normalizePositions(positions) {
  return (Array.isArray(positions) ? positions : []).map((item) => ({
    id: String(item?.id || '').trim(),
    at: String(item?.at || '').trim(),
    op: String(item?.op || '').trim(),
    ...(typeof item?.before === 'string' ? { before: item.before } : {}),
    ...(typeof item?.after === 'string' ? { after: item.after } : {}),
    ...(typeof item?.text === 'string' ? { text: item.text } : {}),
    ...(Array.isArray(item?.options) ? { options: item.options.map((option) => String(option ?? '')) } : {}),
  }));
}

// 去掉的原文同样保留锚点原样，只去掉 at 两端的空白。
function normalizeRemovals(removals) {
  return (Array.isArray(removals) ? removals : []).map((item) => ({
    at: String(item?.at || '').trim(),
    text: String(item?.text ?? ''),
    ...(typeof item?.before === 'string' ? { before: item.before } : {}),
    ...(typeof item?.after === 'string' ? { after: item.after } : {}),
  }));
}

function normalizeHeadings(headings) {
  return (Array.isArray(headings) ? headings : []).map((item) => ({
    chapter_id: String(item?.chapter_id || '').trim(),
    at: typeof item?.at === 'string' && item.at.trim() ? item.at.trim() : null,
  }));
}

function normalizeRepeats(repeats) {
  return (Array.isArray(repeats) ? repeats : []).map((item) => ({
    entries: (Array.isArray(item?.entries) ? item.entries : []).map((entry) => ({
      from: String(entry?.from || '').trim(),
      ...(typeof entry?.to === 'string' && entry.to.trim() ? { to: entry.to.trim() } : {}),
    })),
  }));
}

function normalizeCandidateIds(candidateIds) {
  return (Array.isArray(candidateIds) ? candidateIds : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

/** 由程序绑定章节来源；多份 Word 时禁止省略 source。 */
function resolveChapterSources(chapters, businessSources, resolveAgentSources) {
  const multiple = businessSources.length > 1;
  return chapters.map((chapter) => {
    if (!chapter.source) {
      if (multiple) {
        throw new Error(`多份 Word 原件时章节必须填写 source：${chapter.title}`);
      }
      return { ...chapter, source: businessSources[0] };
    }
    const sourceHint = normalizeRelativePath(chapter.source);
    const resolved = resolveAgentSources(sourceHint);
    if (resolved.length !== 1) {
      throw new Error(`无法唯一确定章节原件：${chapter.title}`);
    }
    return { ...chapter, source: resolved[0] };
  });
}

// 商务生成模板追加到提取底稿末尾，写出 base 底稿；返回各章块号，以及补齐签章标记和原句的字段定义。
async function appendGeneratedChapters({ openXmlHelperService, input, output, chapters, fields, signal }) {
  const result = await openXmlHelperService.runJob({
    action: APPEND_GENERATED_CHAPTERS_ACTION,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    request: { input, output, chapters, fields },
    signal,
  });
  try {
    const outputPath = path.join(result.jobDir, 'generated-chapters.json');
    if (!fs.existsSync(outputPath)) {
      throw new Error('助手没有写出商务生成模板');
    }
    return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } finally {
    removeJobDir(result);
  }
}

module.exports = {
  AGENT_BLOCKS_FILE,
  AGENT_TEMPLATE_PREVIEW_FILE,
  CONFIRM_TEMPLATE_FIELDS_ACTION,
  OPENXML_TOOL_NAME,
  TEMPLATE_FIELD_CLASSIFICATION_SCHEMA,
  createPiOpenXmlTool,
  readTenderBlockOutline,
  appendGeneratedChapters,
  readTemplateLayout,
};
