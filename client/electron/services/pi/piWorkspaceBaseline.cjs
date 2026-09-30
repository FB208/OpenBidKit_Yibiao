const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MANIFEST_FILE = 'manifest.json';
const COPIES_DIR = 'files';
const RECORDS_DIR = 'records';

function hashOf(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// 登记键统一为工作区内的 POSIX 相对路径，暂停恢复后仍能对应同一文件。
function toRelative(workspaceDir, file) {
  const relative = path.relative(path.resolve(workspaceDir), path.resolve(workspaceDir, String(file || '')));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`受保护文件必须位于工作区内：${file}`);
  return relative.split(path.sep).join('/');
}

// 程序写入、Agent 不应改动的文件在工作区外保存原件；提交校验前比对，被改或被删的直接还原。
// 分组由调用方命名，整体替换某组时不影响其他组；登记随任务目录持久保存，暂停恢复后继续生效。
function createWorkspaceBaseline({ workspaceDir, baselineDir }) {
  const manifestPath = path.join(baselineDir, MANIFEST_FILE);
  const copiesDir = path.join(baselineDir, COPIES_DIR);
  let groups = {};
  try {
    groups = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).groups || {};
  } catch {}

  // 同时清理不再被任何分组引用的原件副本。
  function save() {
    fs.mkdirSync(copiesDir, { recursive: true });
    const used = new Set(Object.values(groups).flatMap(entries => Object.values(entries).map(entry => entry.hash)));
    for (const name of fs.readdirSync(copiesDir)) {
      if (!used.has(name)) fs.rmSync(path.join(copiesDir, name), { force: true });
    }
    fs.writeFileSync(`${manifestPath}.tmp`, JSON.stringify({ groups }, null, 2), 'utf8');
    fs.renameSync(`${manifestPath}.tmp`, manifestPath);
  }

  // 记录当前内容和文件状态；文件不存在时不登记。
  function snapshot(relative) {
    const absolute = path.join(workspaceDir, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return null;
    const buffer = fs.readFileSync(absolute);
    const hash = hashOf(buffer);
    const copy = path.join(copiesDir, hash);
    if (!fs.existsSync(copy)) {
      fs.mkdirSync(copiesDir, { recursive: true });
      fs.writeFileSync(copy, buffer);
    }
    const { size, mtimeMs } = fs.statSync(absolute);
    return { hash, size, mtime: mtimeMs };
  }

  function entriesFor(files) {
    return Object.fromEntries(files.map(file => toRelative(workspaceDir, file))
      .map(relative => [relative, snapshot(relative)])
      .filter(([, entry]) => entry));
  }

  return {
    // 追加或刷新登记；程序自己改写受保护文件后调用。
    protect(group, files) {
      if (!files.length) return;
      groups[group] = { ...groups[group], ...entriesFor(files) };
      save();
    },
    // 以当前内容整体替换分组。
    setGroup(group, files) {
      groups[group] = entriesFor(files);
      save();
    },
    // 解除登记，交给 Agent 修改的文件不再还原。
    release(group, files) {
      const entries = { ...groups[group] };
      for (const file of files) delete entries[toRelative(workspaceDir, file)];
      groups[group] = entries;
      save();
    },
    files(group) {
      return Object.keys(groups[group] || {});
    },
    // 大小与修改时间未变的文件视为未改动，其余按内容哈希比对后还原；返回还原的相对路径。
    restore() {
      const restored = new Set();
      for (const entries of Object.values(groups)) {
        for (const [relative, entry] of Object.entries(entries)) {
          const absolute = path.join(workspaceDir, relative);
          const stat = fs.existsSync(absolute) ? fs.statSync(absolute) : null;
          if (stat?.isFile() && stat.size === entry.size && stat.mtimeMs === entry.mtime) continue;
          if (stat?.isFile() && hashOf(fs.readFileSync(absolute)) === entry.hash) {
            entry.mtime = stat.mtimeMs;
            continue;
          }
          fs.mkdirSync(path.dirname(absolute), { recursive: true });
          fs.copyFileSync(path.join(copiesDir, entry.hash), absolute);
          entry.mtime = fs.statSync(absolute).mtimeMs;
          restored.add(relative);
        }
      }
      save();
      return [...restored];
    },
    // 业务在同一任务目录保存校验依据（如图片块原文），不放入 Agent 工作区。
    saveRecord(name, value) {
      const file = path.join(baselineDir, RECORDS_DIR, `${name}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(value), 'utf8');
      fs.renameSync(`${file}.tmp`, file);
    },
    loadRecord(name) {
      try {
        return JSON.parse(fs.readFileSync(path.join(baselineDir, RECORDS_DIR, `${name}.json`), 'utf8'));
      } catch {
        return null;
      }
    },
  };
}

module.exports = { createWorkspaceBaseline };
