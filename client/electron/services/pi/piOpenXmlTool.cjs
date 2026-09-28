const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const OPENXML_TOOL_NAME = 'openxml';
const LIST_BLOCKS_ACTION = 'list-blocks';
const EXTRACT_CHAPTERS_ACTION = 'extract-chapters';
const SCAN_TEMPLATE_FIELDS_ACTION = 'scan-template-fields';
const APPLY_TEMPLATE_FIELDS_ACTION = 'apply-template-fields';
const AGENT_BLOCKS_FILE = '招标原文结构.txt';
const AGENT_TEMPLATE_SOURCE_FILE = '投标模版源文件.docx';
const AGENT_FIELD_CANDIDATES_FILE = '投标模版字段候选.json';
const AGENT_TEMPLATE_FILE = 'bid-template.docx';
const AGENT_TEMPLATE_FIELDS_FILE = 'bid-template-fields.json';
const DEFAULT_TIMEOUT_MS = 300000;
// 与 openXmlHelperService 的 OPENXML_ENVIRONMENT_ERROR_CODE 一致；此处不引用服务模块，避免 Pi 层加载 Electron 依赖。
const OPENXML_ENVIRONMENT_ERROR_CODE = 'OPENXML_ENVIRONMENT';
const REPEATED_FAILURE_LIMIT = 3;
const TEMPLATE_STEP_COUNT = 4;
const ACTION_LABELS = {
  [LIST_BLOCKS_ACTION]: '读取招标原文结构',
  [EXTRACT_CHAPTERS_ACTION]: '抽取投标模版章节',
  [SCAN_TEMPLATE_FIELDS_ACTION]: '识别待填位置',
  [APPLY_TEMPLATE_FIELDS_ACTION]: '写入字段',
};
const TEMPLATE_FIELD_CLASSIFICATION_SCHEMA = {
  type: 'object',
  required: ['fields', 'ignored_candidate_ids'],
  additionalProperties: false,
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        required: ['candidate_id', 'name', 'fill_by'],
        additionalProperties: false,
        properties: {
          candidate_id: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          fill_by: { type: 'string', enum: ['ai', 'manual'] },
          instruction: { type: 'string' },
        },
      },
    },
    ignored_candidate_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
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
  reportTaskFailure,
  onStep,
}) {
  // 分类从模型生成的文件读取，保留原工具参数的结构校验。
  const validateFieldSelections = new Ajv({ allErrors: true, strict: true }).compile(TEMPLATE_FIELD_CLASSIFICATION_SCHEMA);
  let repeatedFailure = { key: '', count: 0 };
  // 列块、抽章、扫描和开始写入字段各推进一步；进度回调失败不影响工具执行。
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
    description: '列出招标 Word 原文块、抽取投标模版章节、扫描待填候选，并把确认后的候选写成 Word 内容控件。按 list-blocks、extract-chapters、scan-template-fields、apply-template-fields 顺序调用。apply-template-fields 只传 fields_file，工具读取文件内全部候选的完整分类；失败时编辑该文件后重新提交路径，不要在工具参数里重复输出字段清单。',
    promptSnippet: '用 openxml 抽取投标模版、扫描待填候选并写入内容控件。',
    parameters: Type.Object({
      action: Type.String({
        enum: [LIST_BLOCKS_ACTION, EXTRACT_CHAPTERS_ACTION, SCAN_TEMPLATE_FIELDS_ACTION, APPLY_TEMPLATE_FIELDS_ACTION],
        description: '依次列块、抽章、扫描待填候选、应用字段标记。',
      }),
      chapters: Type.Optional(Type.Array(Type.Object({
        id: Type.Optional(Type.String()),
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
        description: 'apply-template-fields 必填，当前工作区内的分类 JSON 文件路径。顶层为 fields 和 ignored_candidate_ids 数组；fields 每项包含 candidate_id、name、fill_by（ai 或 manual），可选 instruction。',
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
          const result = await openXmlHelperService.runJob({
            action: LIST_BLOCKS_ACTION,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            request: { sources: businessSources },
            signal,
          });
          const blocksPath = path.join(result.jobDir, 'blocks.json');
          if (!fs.existsSync(blocksPath)) {
            throw new Error('助手没有写出原文结构');
          }
          const blockCount = result.blockCount || result.block_count || 0;
          fs.writeFileSync(
            path.join(workspaceDir, AGENT_BLOCKS_FILE),
            formatBlockOutline(JSON.parse(fs.readFileSync(blocksPath, 'utf8'))),
            'utf8',
          );
          emitStep(1, `已读取招标原文结构，共 ${blockCount} 个原文块`);
          return createToolResult({
            ok: true,
            action,
            file_path: AGENT_BLOCKS_FILE,
            block_count: blockCount,
            message: `已写入 ${AGENT_BLOCKS_FILE}，请用 read 一次读完后按原文标题或块号抽章。`,
          });
        }

        if (action === EXTRACT_CHAPTERS_ACTION) {
          const chapters = resolveChapterSources(
            normalizeChapters(params.chapters),
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

          if (bidTemplateSourcePath && fs.existsSync(bidTemplateSourcePath)) {
            fs.copyFileSync(bidTemplateSourcePath, path.join(workspaceDir, AGENT_TEMPLATE_SOURCE_FILE));
          }

          emitStep(2, `已抽取 ${chapters.length} 个章节`);
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
          const candidatesPath = path.join(result.jobDir, 'template-field-candidates.json');
          if (!fs.existsSync(candidatesPath)) {
            throw new Error('助手没有写出投标模版字段候选');
          }
          const candidateData = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
          fs.writeFileSync(
            path.join(workspaceDir, AGENT_FIELD_CANDIDATES_FILE),
            `${JSON.stringify(candidateData, null, 2)}\n`,
            'utf8',
          );
          const toolPayload = {
            ok: true,
            action,
            file_path: AGENT_FIELD_CANDIDATES_FILE,
            version: candidateData.version,
            default_suggested_fill_by: candidateData.default_suggested_fill_by,
            contexts: candidateData.contexts,
            candidates: candidateData.candidates,
            candidate_count: candidateData.candidates.length,
            message: `已写入 ${AGENT_FIELD_CANDIDATES_FILE}，当前结果已包含紧凑候选，请逐项分类后调用 apply-template-fields。`,
          };
          emitStep(3, `识别到 ${candidateData.candidates.length} 个待填位置，正在分类`);
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
          const selections = JSON.parse(fs.readFileSync(path.join(workspaceDir, classificationPath), 'utf8'));
          if (!validateFieldSelections(selections)) {
            const errors = validateFieldSelections.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('；');
            throw new Error(`分类文件结构无效，请修改 ${classificationPath} 后重新提交路径：${errors}`);
          }
          const fields = normalizeTemplateFields(selections.fields);
          const ignoredCandidateIds = normalizeIgnoredCandidateIds(selections.ignored_candidate_ids);
          emitStep(4, `正在写入 ${fields.length} 个字段`);
          const result = await openXmlHelperService.runJob({
            action: APPLY_TEMPLATE_FIELDS_ACTION,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            request: {
              input: bidTemplateSourceRelativePath,
              output: bidTemplateRelativePath,
              fields_output: bidTemplateFieldsRelativePath,
              fields,
              ignored_candidate_ids: ignoredCandidateIds,
            },
            signal,
          });
          if (!bidTemplatePath || !bidTemplateFieldsPath
            || !fs.existsSync(bidTemplatePath) || !fs.existsSync(bidTemplateFieldsPath)) {
            throw new Error('助手没有同时写出投标模版和字段清单');
          }
          fs.copyFileSync(bidTemplatePath, path.join(workspaceDir, AGENT_TEMPLATE_FILE));
          fs.copyFileSync(bidTemplateFieldsPath, path.join(workspaceDir, AGENT_TEMPLATE_FIELDS_FILE));
          return createToolResult({
            ok: true,
            action,
            file_path: AGENT_TEMPLATE_FIELDS_FILE,
            template_file_path: AGENT_TEMPLATE_FILE,
            output: result.output || bidTemplateRelativePath,
            field_count: result.blockCount || result.block_count || fields.length,
            message: '投标模版字段标记和字段清单已生成。',
          });
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

function normalizeTemplateFields(fields) {
  return (Array.isArray(fields) ? fields : []).map((item) => ({
    candidate_id: String(item?.candidate_id || '').trim(),
    name: String(item?.name || '').trim(),
    fill_by: String(item?.fill_by || '').trim(),
    ...(String(item?.instruction || '').trim() ? { instruction: String(item.instruction).trim() } : {}),
  }));
}

function normalizeIgnoredCandidateIds(candidateIds) {
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

module.exports = {
  OPENXML_TOOL_NAME,
  TEMPLATE_FIELD_CLASSIFICATION_SCHEMA,
  createPiOpenXmlTool,
};
