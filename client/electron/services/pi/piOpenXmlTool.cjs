const fs = require('node:fs');
const path = require('node:path');

const OPENXML_TOOL_NAME = 'openxml';
const LIST_BLOCKS_ACTION = 'list-blocks';
const EXTRACT_CHAPTERS_ACTION = 'extract-chapters';
const SCAN_TEMPLATE_FIELDS_ACTION = 'scan-template-fields';
const APPLY_TEMPLATE_FIELDS_ACTION = 'apply-template-fields';
const AGENT_BLOCKS_FILE = '招标原文结构.json';
const AGENT_TEMPLATE_SOURCE_FILE = '投标模版源文件.docx';
const AGENT_FIELD_CANDIDATES_FILE = '投标模版字段候选.json';
const AGENT_TEMPLATE_FILE = 'bid-template.docx';
const AGENT_TEMPLATE_FIELDS_FILE = 'bid-template-fields.json';
const DEFAULT_TIMEOUT_MS = 300000;

function createToolResult(payload, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
    ...(isError ? { isError: true } : {}),
  };
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
}) {
  return {
    name: OPENXML_TOOL_NAME,
    label: 'Open XML 助手',
    description: '列出招标 Word 原文块、抽取投标模版章节、扫描待填候选，并把确认后的候选写成 Word 内容控件。按 list-blocks、extract-chapters、scan-template-fields、apply-template-fields 顺序调用。',
    promptSnippet: '用 openxml 抽取投标模版、扫描待填候选并写入内容控件。',
    parameters: Type.Object({
      action: Type.String({
        enum: [LIST_BLOCKS_ACTION, EXTRACT_CHAPTERS_ACTION, SCAN_TEMPLATE_FIELDS_ACTION, APPLY_TEMPLATE_FIELDS_ACTION],
        description: '依次列块、抽章、扫描待填候选、应用字段标记。',
      }),
      chapters: Type.Optional(Type.Array(Type.Object({
        id: Type.Optional(Type.String()),
        title: Type.String({ minLength: 1, description: '投标模版里使用的一级目录标题。' }),
        sourceTitle: Type.Optional(Type.String({ description: '招标 Word 里的真实标题，仅适用于招标原文结构中 heading=true 的标题。' })),
        source: Type.Optional(Type.String({ description: '该章所在原件在招标原文结构.json 中的完整 source.path；多份 Word 原件时必填。' })),
        startBlock: Type.Optional(Type.Number({ minimum: 0, description: '起始标题块号，含；heading=false 时必须与 endBlock 一起提供。' })),
        endBlock: Type.Optional(Type.Number({ minimum: 1, description: '结束块号，不含；使用 startBlock 时应停在下一同级章节或附件之前。' })),
      }, { additionalProperties: false }), {
        description: 'extract-chapters 必填。heading=true 可提供 sourceTitle；heading=false 必须提供 startBlock 和 endBlock。',
      })),
      fields: Type.Optional(Type.Array(Type.Object({
        candidate_id: Type.String({ minLength: 1, description: '投标模版字段候选.json 中的候选 ID。' }),
        name: Type.String({ minLength: 1, description: '字段名称；相同内容出现多处时必须使用完全相同的 name。' }),
        fill_by: Type.String({ enum: ['ai', 'manual'], description: 'ai 表示未来由 AI 填写；manual 表示必须人工处理。' }),
        instruction: Type.Optional(Type.String({ description: '仅在字段名称不足以说明要求时填写。' })),
      }, { additionalProperties: false }), {
        description: 'apply-template-fields 中保留并标记为内容控件的候选。',
      })),
      ignored_candidate_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        description: 'apply-template-fields 中确认不是待填字段的全部候选 ID。',
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
          const agentPath = path.join(workspaceDir, AGENT_BLOCKS_FILE);
          fs.copyFileSync(blocksPath, agentPath);
          return createToolResult({
            ok: true,
            action,
            file_path: AGENT_BLOCKS_FILE,
            block_count: result.blockCount || result.block_count || 0,
            message: `已写入 ${AGENT_BLOCKS_FILE}，请用 read 阅读后按原文标题或块号抽章。`,
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
          fs.copyFileSync(candidatesPath, path.join(workspaceDir, AGENT_FIELD_CANDIDATES_FILE));
          return createToolResult({
            ok: true,
            action,
            file_path: AGENT_FIELD_CANDIDATES_FILE,
            candidate_count: result.blockCount || result.block_count || 0,
            message: `已写入 ${AGENT_FIELD_CANDIDATES_FILE}，请逐项分类后调用 apply-template-fields。`,
          });
        }

        if (action === APPLY_TEMPLATE_FIELDS_ACTION) {
          if (!bidTemplateSourcePath || !fs.existsSync(bidTemplateSourcePath)) {
            throw new Error('请先调用 extract-chapters 抽取投标模版章节');
          }
          const fields = normalizeTemplateFields(params.fields);
          const ignoredCandidateIds = normalizeIgnoredCandidateIds(params.ignored_candidate_ids);
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
        return createToolResult({
          ok: false,
          action: params?.action || '',
          error: error?.message || String(error),
        }, true);
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
  createPiOpenXmlTool,
};
