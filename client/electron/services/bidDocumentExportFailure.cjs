const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getTechnicalPlanExportFailureDir } = require('../utils/paths.cjs');

const PHASE_LABELS = {
  inspect: '导出前检查', assemble: '读取正文', business: '生成商务模版', convert: '转换整本 Word',
  'page-numbers': '回填目录页码', refresh: '刷新调整结果',
};

// 仅在失败后固化当次转换输入；正式正文、图片仍通过原路径读取。
// 整本 HTML 单独写入 assembled.html，failure.json 只保留错误链、阶段和小节对照，快照只留导出配置。
function captureExportFailure(app, snapshot, error, details = {}) {
  if (error.export_failure_id) return error.export_failure_id;
  const id = crypto.randomUUID();
  const dir = getTechnicalPlanExportFailureDir(app, id);
  fs.mkdirSync(dir, { recursive: true });
  const artifacts = {};
  for (const [name, file] of Object.entries({
    helper: error.openxml?.jobDir,
    assets: details.temporaryAssets,
    business: details.businessInput,
  })) {
    if (!file || !fs.existsSync(file)) continue;
    const target = path.join(dir, name === 'business' ? 'business.docx' : name);
    fs.cpSync(file, target, { recursive: true });
    artifacts[name] = target;
  }
  const { html, temporaryAssets: _temporaryAssets, ...rest } = details;
  if (html) {
    artifacts.html = path.join(dir, 'assembled.html');
    fs.writeFileSync(artifacts.html, html, 'utf8');
  }
  const errors = [];
  for (let current = error; current && errors.length < 8; current = current.cause) {
    errors.push({ message: current.message || String(current), code: current.code, stack: current.stack });
  }
  fs.writeFileSync(path.join(dir, 'failure.json'), JSON.stringify({
    id, at: new Date().toISOString(), errors,
    snapshot: {
      project_name: snapshot.project_name,
      export_format: snapshot.export_format,
      export_template_scope: snapshot.export_template_scope,
      workspaceDir: snapshot.workspaceDir,
    },
    details: rest, artifacts, openxml: error.openxml,
  }, null, 2), 'utf8');
  error.export_failure_id = id;
  return id;
}

// 读取已发生的错误记录，供启用调整和生成修复要求复用。
function readExportFailure(app, id) {
  const dir = getTechnicalPlanExportFailureDir(app, id);
  return { dir, ...JSON.parse(fs.readFileSync(path.join(dir, 'failure.json'), 'utf8')) };
}

// 修复要求由程序按失败现场拼出：预检问题逐节列出，其他阶段给出错误链和现场文件用途。
// 结束判据只有一个：调整任务验收时按原导出配置实际整本导出成功。
function buildExportRepairRequirement(failure) {
  const phase = failure.details?.phase;
  const issues = failure.details?.issues || [];
  const problem = phase === 'inspect' && issues.length
    ? `导出前检查发现以下小节的正文结构问题：\n${issues.map(issue => `- ${issue.section}（${issue.file}）：${issue.problems.join('；')}`).join('\n')}`
    : `导出在“${PHASE_LABELS[phase] || phase || '未知'}”阶段失败，报错：\n${failure.errors.map(error => error.message).join('\n')}`;
  const files = [
    'failure.json：错误链（含堆栈）、失败阶段，以及各小节编号、标题与正文文件的对照',
    failure.artifacts?.html && 'assembled.html：本次交给转换器的整本 HTML',
    failure.artifacts?.helper && 'helper/：转换器的请求和结果',
    failure.artifacts?.assets && 'assets/：本次转换使用的图片副本',
    failure.artifacts?.business && 'business.docx：本次生成的商务模版',
  ].filter(Boolean);
  return `修复整本导出失败，使导出恢复成功。
${problem}

失败现场（只读）：${failure.dir}
${files.map(item => `- ${item}`).join('\n')}

处理方式：
1. 按报错定位到具体小节或文件；需要时查阅源码中抛出该错误的位置，弄清它要求的结构。
2. 只修改造成这次失败的数据，不靠删除正文段落、图片或小节来规避报错。
3. 改完直接结束本轮。程序会按原导出配置重新整本导出：成功即完成，失败会把新的报错发回本会话。不要自己编写导出、转换或核对脚本，不检查与报错无关的内容。
4. 确认问题出在程序或本机环境、无法通过修改本项目数据解决时，用 report-failure 说明原因。`;
}

module.exports = { captureExportFailure, readExportFailure, buildExportRepairRequirement };
