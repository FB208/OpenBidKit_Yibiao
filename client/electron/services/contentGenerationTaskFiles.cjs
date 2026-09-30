const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const { AI_IMAGE_STYLES } = require('./aiImageStyles.cjs');

// Agent 写入、批量工具读取的任务文件；固定路径便于预置 Schema，提交工具读取时校验。
const TASK_DIR = '任务';
// 程序生成、供 Agent 按需读取的清单和结果，随工具调用覆盖。
const LIST_DIR = '程序清单';
// 单节修改与正文主任务共用工作区，任务文件和清单放在独立子目录，互不清理。
const SECTION_MODIFICATION_SUBDIR = '单节修改';
const TASK_FILES = {
  sections: '正文生成.json', images: '配图生成.json', renderHtml: 'HTML转图.json', renderMermaid: 'Mermaid转图.json',
  applyImages: '图片回填.json', adjust: '扩缩写.json', repair: '一致性修复.json', tables: '去表格.json', layout: '格式补写.json',
};
const LIST_FILES = {
  images: '正文图片清单.json', words: '正文字数统计.json', repair: '一致性修复结果.json', tables: '去表格进度.json', layout: '格式补写任务.json',
  submission: '提交校验问题.json',
};
const TASK_FILE_WRITING = '写完再调用对应工具提交。';

const text = { type: 'string' };
const id = { type: 'string', minLength: 1 };
const regenerate = { type: 'boolean' };
const frameSize = { enum: ['square', 'wide', 'tall', 'panorama'] };
const aiSize = { type: 'string', pattern: '\\S' };
const aiStyle = { enum: Object.keys(AI_IMAGE_STYLES) };
const list = (key, items) => ({ type: 'object', additionalProperties: false, required: [key], properties: { [key]: { type: 'array', minItems: 1, items } } });
const object = (required, optional = {}) => ({
  type: 'object', additionalProperties: false, required: Object.keys(required), properties: { ...required, ...optional },
});
// 按生成方式补充必填项；then 中重复声明属性以满足 Ajv 严格模式。
const imageItem = {
  ...object({ image_id: id, kind: { enum: ['ai', 'html', 'mermaid'] }, prompt: { type: 'string', minLength: 1 } },
    { size: aiSize, title: text, style: aiStyle, frame_size: frameSize, regenerate }),
  allOf: [
    { if: { properties: { kind: { const: 'ai' } } }, then: { properties: { size: aiSize, style: aiStyle }, required: ['size', 'style'] } },
    { if: { properties: { kind: { const: 'html' } } }, then: { properties: { frame_size: frameSize }, required: ['frame_size'] } },
  ],
};
// 结构与原工具参数一致；Schema 不要求一次写全，完整性由工具提交时按业务规则检查。
const TASK_FILE_SCHEMAS = {
  sections: list('sections', object({ section_id: id, instructions: text, references: text }, { regenerate })),
  images: list('images', imageItem),
  renderHtml: list('images', object({ image_id: id, source_file: id, frame_size: frameSize }, { regenerate })),
  renderMermaid: list('images', object({ image_id: id, source_file: id }, { regenerate })),
  applyImages: list('images', object({ image_id: id, asset_ref: id, previous_asset_ref: text })),
  adjust: list('sections', object({ section_id: id, instructions: text })),
  repair: object({ sections: list('sections', object({ section_id: id, instructions: text })).properties.sections }, { rules: text }),
  tables: list('sections', object({ section_id: id, instructions: text }, { regenerate })),
  layout: list('section_ids', id),
};
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(Object.entries(TASK_FILE_SCHEMAS).map(([key, schema]) => [key, ajv.compile(schema)]));

function taskFilePath(key, dir = TASK_DIR) {
  return `${dir}/${TASK_FILES[key]}`;
}

// 任务文件均为 Agent 结果，不登记为受保护文件。
function taskFilePaths(dir = TASK_DIR) {
  return Object.keys(TASK_FILES).map(key => taskFilePath(key, dir));
}

// 供 Agent 用 json-validation 自查；主任务登记全部任务文件，单节修改只登记图片任务。
function taskFileSchemas(dir = TASK_DIR, keys = Object.keys(TASK_FILES)) {
  return Object.fromEntries(keys.map(key => [taskFilePath(key, dir), TASK_FILE_SCHEMAS[key]]));
}

// 工具提交时读取完整任务文件，结构错误直接交回 Agent 修正。
function readTaskFile(workspaceDir, key, dir = TASK_DIR) {
  const file = taskFilePath(key, dir);
  const target = path.join(workspaceDir, file);
  if (!fs.existsSync(target)) throw new Error(`请先将任务写入 ${file}，再调用本工具提交`);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(target, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    throw new Error(`${file} 不是有效 JSON：${error.message}`);
  }
  if (!validators[key](value)) throw new Error(`${file} 格式错误：${ajv.errorsText(validators[key].errors, { dataVar: file })}`);
  return value;
}

// 程序清单整文件覆盖，供 Agent 按需分页读取或检索。
function writeListFile(workspaceDir, key, value, dir = LIST_DIR) {
  const file = `${dir}/${LIST_FILES[key]}`;
  const target = path.join(workspaceDir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(`${target}.tmp`, target);
  return file;
}

// 读取程序清单，用于在本轮已有记录上累积；文件不存在时返回 null。
function readListFile(workspaceDir, key, dir = LIST_DIR) {
  const target = path.join(workspaceDir, `${dir}/${LIST_FILES[key]}`);
  return fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
}

// 新一轮任务清空上一轮任务文件和清单；主任务清理包含单节修改子目录。
function clearTaskArtifacts(workspaceDir, subdir = '') {
  for (const dir of [TASK_DIR, LIST_DIR]) fs.rmSync(path.join(workspaceDir, dir, subdir), { recursive: true, force: true });
}

// 模型只接收统计和未成功项，逐项完整结果保存在工具 details 中。
function compactResults(results) {
  const count = status => results.filter(item => item.status === status).length;
  return { total: results.length, success: count('success'), skipped: count('skipped'),
    unresolved: results.filter(item => !['success', 'skipped'].includes(item.status)) };
}

module.exports = {
  TASK_DIR, LIST_DIR, SECTION_MODIFICATION_SUBDIR, TASK_FILES, LIST_FILES, TASK_FILE_SCHEMAS, TASK_FILE_WRITING,
  taskFilePath, taskFilePaths, taskFileSchemas, readTaskFile, writeListFile, readListFile, clearTaskArtifacts, compactResults,
};
