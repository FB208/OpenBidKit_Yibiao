const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const JSON_VALIDATION_TOOL_NAME = 'json-validation';

// 将 Agent 提供的相对路径解析到当前工作区内。
function resolveWorkspaceFile(workspaceDir, filePath) {
  const relativePath = String(filePath || '').trim().replace(/\\/g, '/');
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error('file_path 必须是当前工作区内的非空相对路径');
  }

  const workspaceRoot = path.resolve(workspaceDir);
  const resolvedPath = path.resolve(workspaceRoot, relativePath);
  if (resolvedPath !== workspaceRoot && !resolvedPath.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`file_path 超出当前工作区：${filePath}`);
  }
  return resolvedPath;
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
      : '校验未通过，请根据 errors 修复文件后再次调用 json-validation。',
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
    ...(valid ? {} : { isError: true }),
  };
}

// 创建只负责 JSON 解析与 Schema 校验的 Pi 自定义工具。
function createPiJsonValidationTool({ workspaceDir, Type }) {
  const ajv = new Ajv({ allErrors: true, strict: true });
  return {
    name: JSON_VALIDATION_TOOL_NAME,
    label: 'JSON 校验',
    description: '使用 JSON.parse 和 Ajv 校验当前工作区内的 JSON 文件。根据任务明确给出的输出格式构造完整 JSON Schema，校验失败后修复文件并再次调用。',
    promptSnippet: '使用 JSON.parse 和 Ajv 校验工作区内的 JSON 文件。',
    parameters: Type.Object({
      file_path: Type.String({
        minLength: 1,
        description: '待校验 JSON 文件相对于当前工作区的路径。',
      }),
      schema: Type.Union([
        Type.Object({}, { additionalProperties: true }),
        Type.Boolean(),
      ], {
        description: '根据当前任务输出要求构造的 JSON Schema Draft-07。',
      }),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      let source;
      try {
        const resolvedPath = resolveWorkspaceFile(workspaceDir, params.file_path);
        source = fs.readFileSync(resolvedPath, 'utf-8');
      } catch (error) {
        return createToolResult({
          filePath: params.file_path,
          valid: false,
          stage: 'read',
          errors: [{ message: error?.message || String(error) }],
        });
      }

      let data;
      try {
        data = JSON.parse(source);
      } catch (error) {
        return createToolResult({
          filePath: params.file_path,
          valid: false,
          stage: 'parse',
          errors: [{ message: error?.message || String(error) }],
        });
      }

      let validate;
      try {
        validate = ajv.compile(params.schema);
      } catch (error) {
        return createToolResult({
          filePath: params.file_path,
          valid: false,
          stage: 'schema',
          errors: [{ message: error?.message || String(error) }],
        });
      }

      if (!validate(data)) {
        return createToolResult({
          filePath: params.file_path,
          valid: false,
          stage: 'validation',
          errors: normalizeAjvErrors(validate.errors),
        });
      }

      return createToolResult({
        filePath: params.file_path,
        valid: true,
        stage: 'success',
      });
    },
  };
}

module.exports = {
  JSON_VALIDATION_TOOL_NAME,
  createPiJsonValidationTool,
};
