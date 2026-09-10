const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const JSON_VALIDATION_TOOL_NAME = 'json-validation';

// 统一工作区相对路径，供文件读取和预置 Schema 匹配使用。
function normalizeWorkspaceFilePath(filePath) {
  const relativePath = String(filePath || '').trim().replace(/\\/g, '/');
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error('file_path 必须是当前工作区内的非空相对路径');
  }
  return path.posix.normalize(relativePath);
}

// 将 Agent 提供的相对路径解析到当前工作区内。
function resolveWorkspaceFile(workspaceDir, filePath) {
  const relativePath = normalizeWorkspaceFilePath(filePath);
  const workspaceRoot = path.resolve(workspaceDir);
  const resolvedPath = path.resolve(workspaceRoot, relativePath);
  if (resolvedPath !== workspaceRoot && !resolvedPath.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`file_path 超出当前工作区：${filePath}`);
  }
  return { relativePath, resolvedPath };
}

// 将 Ajv 错误转换为 Agent 易于定位和修复的结构。
function normalizeAjvErrors(errors = []) {
  return errors.map((error) => ({
    instancePath: error.instancePath || '/',
    schemaPath: error.schemaPath || '',
    keyword: error.keyword || '',
    message: error.message || '字段不符合 JSON Schema',
    params: error.params || {},
  }));
}

// 生成统一的工具返回结果。
function createToolResult({ filePath, valid, stage, errors = [] }) {
  const payload = {
    valid,
    stage,
    file_path: filePath,
    errors,
    message: valid
      ? 'JSON.parse 和 Ajv 校验均已通过。'
      : '校验未通过，请根据 errors 修复文件后重新校验。',
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
    ...(valid ? {} : { isError: true }),
  };
}

// 每个 Session 共用校验器；只记录受预置规则管理的文件尚未修复的错误。
function createPiJsonValidator({ workspaceDir, validationSchemas = {}, trackFailures = false }) {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const pendingFailures = new Map();

  // 原生文件工具传入绝对路径，独立校验传入相对路径，Windows 下统一大小写。
  function fileKey(filePath) {
    const resolvedPath = path.resolve(workspaceDir, String(filePath || ''));
    return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
  }

  const presetSchemas = new Map(Object.entries(validationSchemas).map(([filePath, schema]) => [
    fileKey(normalizeWorkspaceFilePath(filePath)),
    schema,
  ]));

  // 同一文件后续校验通过即清除错误，不要求尚未生成的其他文件提前存在。
  function recordResult(result) {
    const key = fileKey(result.details.file_path);
    if (trackFailures && presetSchemas.has(key)) {
      if (result.details.valid) pendingFailures.delete(key);
      else pendingFailures.set(key, result.details);
    }
    return result;
  }

  // 校验本次实际写入的完整内容，独立校验也使用相同的解析和 Ajv 规则。
  function validateContent(filePath, source, suppliedSchema) {
    const relativePath = path.relative(workspaceDir, path.resolve(workspaceDir, filePath)).split(path.sep).join('/');
    let data;
    try {
      data = JSON.parse(source);
    } catch (error) {
      return recordResult(createToolResult({
        filePath: relativePath, valid: false, stage: 'parse',
        errors: [{ message: error?.message || String(error) }],
      }));
    }

    let validate;
    try {
      const key = fileKey(filePath);
      const schema = presetSchemas.has(key) ? presetSchemas.get(key) : suppliedSchema;
      if (schema === undefined) throw new Error(`任务未为 ${relativePath} 预置 Schema，调用时必须提供 schema`);
      validate = ajv.compile(schema);
    } catch (error) {
      return recordResult(createToolResult({
        filePath: relativePath, valid: false, stage: 'schema',
        errors: [{ message: error?.message || String(error) }],
      }));
    }

    return recordResult(createToolResult(validate(data)
      ? { filePath: relativePath, valid: true, stage: 'success' }
      : { filePath: relativePath, valid: false, stage: 'validation', errors: normalizeAjvErrors(validate.errors) }));
  }

  // 独立检查已有文件，保留其相对路径约束和读取失败反馈。
  function validateFile(filePath, schema) {
    let source;
    let relativePath;
    try {
      const resolved = resolveWorkspaceFile(workspaceDir, filePath);
      relativePath = resolved.relativePath;
      source = fs.readFileSync(resolved.resolvedPath, 'utf8');
    } catch (error) {
      return recordResult(createToolResult({
        filePath, valid: false, stage: 'read', errors: [{ message: error?.message || String(error) }],
      }));
    }
    return validateContent(relativePath, source, schema);
  }

  // 供结束标记及 Runtime 阶段交接共用，避免未修复结果被当作成功。
  function getPendingError() {
    if (!pendingFailures.size) return '';
    return `以下 JSON 文件尚未通过校验，请修复后再结束当前阶段：\n${Array.from(pendingFailures.values(), (failure) => (
      `${failure.file_path}：${failure.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('；')}`
    )).join('\n')}`;
  }

  // 模型直接结束但仍留下错误时，禁止 Runtime 接受该阶段结果。
  function assertValid() {
    const message = getPendingError();
    if (message) {
      const error = new Error(message);
      error.agentValidationFailed = true;
      throw error;
    }
  }

  return {
    hasPreset: (filePath) => presetSchemas.has(fileKey(filePath)),
    validateContent,
    validateFile,
    getPendingError,
    assertValid,
  };
}

// 复用 Pi 文件操作及其同文件队列，在写入回调内校验，保留 edit 的差异结果。
function withAutomaticJsonValidation(createTool, workspaceDir, validator) {
  const tool = createTool(workspaceDir);
  return {
    ...tool,
    description: `${tool.description}\n本次任务已开启 JSON 自动校验：有预置 Schema 的文件写入或修改后立即校验；失败时文件仍已修改，请继续修复。已通过自动校验的内容无需再调用 json-validation。`,
    execute: async (...args) => {
      let validationResult;
      const operationTool = createTool(workspaceDir, {
        operations: {
          mkdir: (directory) => fs.promises.mkdir(directory, { recursive: true }),
          readFile: (filePath) => fs.promises.readFile(filePath),
          access: (filePath) => fs.promises.access(filePath, fs.constants.R_OK | fs.constants.W_OK),
          writeFile: async (filePath, content) => {
            await fs.promises.writeFile(filePath, content, 'utf8');
            if (validator.hasPreset(filePath)) validationResult = validator.validateContent(filePath, content);
          },
        },
      });
      const result = await operationTool.execute(...args);
      if (!validationResult) return result;
      return {
        ...result,
        content: [
          ...result.content,
          ...(validationResult.isError ? [{ type: 'text', text: '文件已写入，但 JSON 校验未通过；请根据以下错误修复。' }] : []),
          ...validationResult.content,
        ],
        details: { ...result.details, validation: validationResult.details },
        ...(validationResult.isError ? { isError: true } : {}),
      };
    },
  };
}

// 创建独立校验工具，继续支持只检查已有文件和调用方提供的 Schema。
function createPiJsonValidationTool({ Type, validator }) {
  return {
    name: JSON_VALIDATION_TOOL_NAME,
    label: 'JSON 校验',
    description: '使用 JSON.parse 和 Ajv 校验当前工作区内的 JSON 文件。任务已预置 Schema 时只传 file_path；没有预置时根据输出要求提供完整 schema。校验失败后修复文件并再次调用。',
    promptSnippet: '使用 JSON.parse 和 Ajv 校验工作区内的 JSON 文件。',
    parameters: Type.Object({
      file_path: Type.String({
        minLength: 1,
        description: '待校验 JSON 文件相对于当前工作区的路径。',
      }),
      schema: Type.Optional(Type.Union([
        Type.Object({}, { additionalProperties: true }),
        Type.Boolean(),
      ], {
        description: '仅在任务没有为目标文件预置 Schema 时提供，根据当前任务输出要求构造 JSON Schema Draft-07。',
      })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => validator.validateFile(params.file_path, params.schema),
  };
}

module.exports = {
  JSON_VALIDATION_TOOL_NAME,
  createPiJsonValidator,
  createPiJsonValidationTool,
  withAutomaticJsonValidation,
};
