// 暗标检查新旧助手对比：同一批文档、同一批请求，分别用两份助手运行检查、结构导出、自动修复和 AI 编辑，逐项比较输出。
// 用于暗标检查实现层改造（如 LINQ to XML 迁移到 OpenXML SDK）前后的等价验证；差异须能对上改造说明里的预期行为变化。
// 用法（client 目录）：node scripts/compare-blind-check-helpers.cjs --old <助手目录> --new <助手目录> --corpus <docx 目录> [--out <结果目录>]
// 助手目录是 openxmlhelper 编译产物所在目录（含 openxmlhelper.exe），可先把两版分别复制出来。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOpenXmlHelperService } = require('../electron/services/openXmlHelperService.cjs');
const { FIX_RULE_IDS, listBuiltinPresets, normalizeProfile } = require('../electron/services/blindCheckPresets.cjs');

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, index, list) => {
  if (item.startsWith('--')) pairs.push([item.slice(2), list[index + 1]]);
  return pairs;
}, []));
if (!args.old || !args.new || !args.corpus) {
  console.error('用法：node scripts/compare-blind-check-helpers.cjs --old <助手目录> --new <助手目录> --corpus <docx 目录> [--out <结果目录>]');
  process.exit(2);
}
const outRoot = path.resolve(args.out || fs.mkdtempSync(path.join(os.tmpdir(), '暗标对比-')));
const documents = fs.readdirSync(args.corpus).filter((name) => name.toLowerCase().endsWith('.docx')).sort();

// 内置预设各一份，加一份打开全部细项规则。
const profiles = [
  ...listBuiltinPresets().map((preset) => ({ id: preset.id, profile: preset.profile })),
  {
    id: 'all-detail-rules',
    profile: normalizeProfile({
      page: { check_sections: true },
      body: { check_snap_to_grid: true, check_vert_align: true },
      table: { alignment: 'center', check_merge: true },
      structure: { check_bookmarks: true },
      text: { check_halfwidth_brackets: true, check_fullwidth_digits: true, check_fullwidth_letters: true },
    }),
  },
];
const defaultProfile = profiles[0].profile;
const sensitiveWords = [{ text: '有限公司', source: 'custom' }, { text: '建设', source: 'custom' }];
const IGNORED_KEYS = new Set(['duration_ms', 'output', 'output_bytes']);

/** 从导出文本里挑一组固定的编辑：正文段替换两个字、单元格段整段删除、删一个正文段、清第一张图片的替代文字。 */
function buildEdits(dump) {
  const lines = dump.text.split('\n').map((line) => line.match(/^\[([a-z]+\.?[0-9][0-9a-z.]*)\] (.*)$/)).filter(Boolean);
  const plain = (text) => text.replace(/〔[^〕]*〕/g, '').trim();
  const edits = [];
  const body = lines.find((match) => /^p\d+$/.test(match[1]) && plain(match[2]).length >= 6);
  if (body) edits.push({ op: 'replace', target: body[1], find: plain(body[2]).slice(0, 2), replace: '某某' });
  const cell = lines.find((match) => /^t\d+\.r\d+\.c\d+$/.test(match[1]) && plain(match[2]).length > 0);
  if (cell) edits.push({ op: 'delete_paragraph', target: cell[1], find: plain(cell[2]) });
  const removable = lines.filter((match) => /^p\d+$/.test(match[1]) && plain(match[2]).length > 0 && !/〔(标题|目录|封面|分节符|分页符|段前分页)/.test(match[2]));
  if (removable[3]) edits.push({ op: 'delete_paragraph', target: removable[3][1], find: plain(removable[3][2]) });
  if (dump.images?.length) edits.push({ op: 'clear_image_alt', target: dump.images[0].id });
  return edits;
}

async function runHelper(label, helperDir) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), `暗标对比-${label}-`));
  const sourceDir = path.join(userData, 'workspace', 'blind-check', 'source');
  fs.mkdirSync(sourceDir, { recursive: true });
  process.env.YIBIAO_OPENXML_HELPER_DIR = path.resolve(helperDir);
  const app = { isPackaged: true, getPath: () => userData, getAppPath: () => path.join(__dirname, '..') };
  const service = createOpenXmlHelperService({ app });
  const results = {};
  try {
    for (const name of documents) {
      fs.copyFileSync(path.join(args.corpus, name), path.join(sourceDir, name));
      const source = `blind-check/source/${name}`;
      const output = `blind-check/fixed/${name}`;
      const record = (results[name] = { timings: {} });
      const timed = async (key, run) => {
        const started = Date.now();
        try {
          record[key] = await run();
        } catch (error) {
          record[key] = { error: error.message };
        }
        record.timings[key] = Date.now() - started;
      };
      for (const { id, profile } of profiles) {
        await timed(`inspect:${id}`, () => service.runBlindCheck({ source, profile, sensitive_words: sensitiveWords, image_facts: [] }));
      }
      await timed('dump', () => service.runBlindCheckDump({ source, profile: defaultProfile, sensitive_words: sensitiveWords, image_facts: [] }));
      await timed('fix', () => service.runBlindCheckFix({ source, output, profile: defaultProfile, sensitive_words: sensitiveWords, image_facts: [], fix_rules: FIX_RULE_IDS }));
      const headingFallback = record.fix?.heading_fallback !== false;
      await timed('fixed-dump', () => service.runBlindCheckDump({ source: output, profile: defaultProfile, sensitive_words: sensitiveWords, image_facts: [], heading_fallback: headingFallback }));
      if (record['fixed-dump']?.text) {
        record.edits = buildEdits(record['fixed-dump']);
        await timed('edit', () => service.runBlindCheckEdit({ source: output, original: source, profile: defaultProfile, sensitive_words: sensitiveWords, image_facts: [], heading_fallback: headingFallback, edits: record.edits }));
      }
      console.log(`[${label}] ${name}：${Object.entries(record.timings).map(([key, ms]) => `${key} ${ms}ms`).join('，')}`);
    }
  } finally {
    await service.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
  fs.mkdirSync(outRoot, { recursive: true });
  fs.writeFileSync(path.join(outRoot, `${label}.json`), JSON.stringify(results, null, 2), 'utf8');
  return results;
}

/** 逐层比较，返回差异的路径与两边的值（截断）。 */
function diff(left, right, at = '', out = []) {
  if (out.length >= 200) return out;
  if (left === right) return out;
  const shape = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);
  if (shape(left) !== shape(right) || shape(left) !== 'object' && shape(left) !== 'array') {
    out.push({ at, old: JSON.stringify(left)?.slice(0, 300), new: JSON.stringify(right)?.slice(0, 300) });
    return out;
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (IGNORED_KEYS.has(key)) continue;
    diff(left[key], right[key], at ? `${at}.${key}` : key, out);
  }
  return out;
}

(async () => {
  const before = await runHelper('old', args.old);
  const after = await runHelper('new', args.new);
  const report = {};
  for (const name of documents) {
    const { timings: oldTimings, ...oldRest } = before[name];
    const { timings: newTimings, ...newRest } = after[name];
    report[name] = { differences: diff(oldRest, newRest), timings: { old: oldTimings, new: newTimings } };
    const count = report[name].differences.length;
    console.log(`${count === 0 ? '一致' : `${count} 处差异`}  ${name}`);
    for (const item of report[name].differences.slice(0, 20)) console.log(`    ${item.at}\n      旧：${item.old}\n      新：${item.new}`);
  }
  fs.writeFileSync(path.join(outRoot, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`结果目录：${outRoot}`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
