const fs = require('node:fs');
const path = require('node:path');
const {
  getAgentRuntimeDir,
  getBundledOpencodeToolsBinDir,
} = require('../../utils/paths.cjs');

const SHIM_COMMANDS = [
  'ls',
  'cat',
  'pwd',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'mkdir',
  'cp',
  'mv',
  'rm',
  'touch',
  'basename',
  'dirname',
  'realpath',
  'cut',
  'tr',
  'du',
  'stat',
  'grep',
  'find',
  'sed',
];

const BUNDLED_COMMANDS = ['rg', 'fd', 'jq'];

const AGENTS_MD_CONTENT = `# 易标 OpenCode 智能体工作区

你在易标客户端创建的临时工作区内工作。

可用命令：rg、fd、jq、node、ls、cat、pwd、head、tail、wc、sort、uniq、mkdir、cp、mv、rm、touch、basename、dirname、realpath、cut、tr、du、stat、grep、find、sed。

约定：
- 只读写当前工作区内的文件。
- 不要访问当前工作区外的路径。
- 不要联网。
- 复杂文本处理或 JSON 处理优先使用 node 小脚本，避免依赖不同平台 shell 行为。
- 需要输出结果时，严格写入任务要求的输出文件。
`;

function getRuntimeToolsBinDir(app) {
  return path.join(getAgentRuntimeDir(app), 'service', 'tools', 'bin');
}

function quoteSh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function writeFileIfChanged(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, 'utf-8');
    if (current === content) {
      if (mode && process.platform !== 'win32') {
        try { fs.chmodSync(filePath, mode); } catch {}
      }
      return;
    }
  }
  fs.writeFileSync(filePath, content, 'utf-8');
  if (mode && process.platform !== 'win32') {
    fs.chmodSync(filePath, mode);
  }
}

function getExecutableName(command) {
  return process.platform === 'win32' ? `${command}.exe` : command;
}

function verifyBundledTools(bundledToolsBinDir) {
  if (!fs.existsSync(bundledToolsBinDir)) {
    throw new Error(`OpenCode 常用命令目录不存在：${bundledToolsBinDir}`);
  }

  BUNDLED_COMMANDS.forEach((command) => {
    const executablePath = path.join(bundledToolsBinDir, getExecutableName(command));
    if (!fs.existsSync(executablePath)) {
      throw new Error(`OpenCode 常用命令缺失：${executablePath}`);
    }
    if (process.platform !== 'win32') {
      try { fs.chmodSync(executablePath, 0o755); } catch {}
    }
  });
}

function writeNodeShim(binDir) {
  if (process.platform === 'win32') {
    writeFileIfChanged(path.join(binDir, 'node.cmd'), [
      '@echo off',
      'setlocal',
      'if "%YIBIAO_ELECTRON_NODE%"=="" set "YIBIAO_ELECTRON_NODE=node"',
      'set "ELECTRON_RUN_AS_NODE=1"',
      '"%YIBIAO_ELECTRON_NODE%" %*',
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n'));
    return;
  }

  writeFileIfChanged(path.join(binDir, 'node'), [
    '#!/bin/sh',
    ': "${YIBIAO_ELECTRON_NODE:=node}"',
    'ELECTRON_RUN_AS_NODE=1 exec "$YIBIAO_ELECTRON_NODE" "$@"',
    '',
  ].join('\n'), 0o755);
}

function writeCommandShim(binDir, command, runnerPath) {
  if (process.platform === 'win32') {
    writeFileIfChanged(path.join(binDir, `${command}.cmd`), [
      '@echo off',
      'setlocal',
      'if "%YIBIAO_ELECTRON_NODE%"=="" set "YIBIAO_ELECTRON_NODE=node"',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `"%YIBIAO_ELECTRON_NODE%" "${runnerPath}" "${command}" %*`,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n'));
    return;
  }

  writeFileIfChanged(path.join(binDir, command), [
    '#!/bin/sh',
    ': "${YIBIAO_ELECTRON_NODE:=node}"',
    `ELECTRON_RUN_AS_NODE=1 exec "$YIBIAO_ELECTRON_NODE" ${quoteSh(runnerPath)} ${quoteSh(command)} "$@"`,
    '',
  ].join('\n'), 0o755);
}

function toolRunnerMain() {
  const fs = require('node:fs');
  const path = require('node:path');

  function out(value) {
    process.stdout.write(String(value));
  }

  function err(command, message) {
    process.stderr.write(`${command}: ${message}\n`);
  }

  function readStdin() {
    try { return fs.readFileSync(0, 'utf-8'); } catch { return ''; }
  }

  function readText(file) {
    if (!file || file === '-') return readStdin();
    return fs.readFileSync(file, 'utf-8');
  }

  function readAll(files) {
    if (!files.length) return readStdin();
    return files.map((file) => readText(file)).join('');
  }

  function splitLines(text) {
    const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function wildcardToRegExp(pattern) {
    const source = String(pattern || '')
      .split('')
      .map((char) => {
        if (char === '*') return '.*';
        if (char === '?') return '.';
        return escapeRegExp(char);
      })
      .join('');
    return new RegExp(`^${source}$`);
  }

  function normalizeOutputPath(value) {
    return String(value || '').replace(/\\/g, '/');
  }

  function walk(current, callback, depth = 0, maxDepth = Infinity) {
    const stat = fs.lstatSync(current);
    callback(current, stat, depth);
    if (!stat.isDirectory() || depth >= maxDepth) return;
    for (const name of fs.readdirSync(current)) {
      walk(path.join(current, name), callback, depth + 1, maxDepth);
    }
  }

  function directorySize(target) {
    let size = 0;
    walk(target, (filePath, stat) => {
      if (stat.isFile()) size += stat.size;
    });
    return size;
  }

  function formatHumanSize(size) {
    const units = ['B', 'K', 'M', 'G', 'T'];
    let value = Number(size || 0);
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)}${units[index]}`;
  }

  function parseNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function commandPwd() {
    out(`${process.cwd()}\n`);
    return 0;
  }

  function commandLs(args) {
    const options = { all: false, long: false, one: false };
    const targets = [];
    for (const arg of args) {
      if (arg.startsWith('-') && arg !== '-') {
        if (arg.includes('a')) options.all = true;
        if (arg.includes('l')) options.long = true;
        if (arg.includes('1')) options.one = true;
      } else {
        targets.push(arg);
      }
    }
    const listTargets = targets.length ? targets : ['.'];
    let exitCode = 0;
    listTargets.forEach((target, targetIndex) => {
      try {
        const stat = fs.lstatSync(target);
        if (listTargets.length > 1) {
          if (targetIndex > 0) out('\n');
          out(`${target}:\n`);
        }
        if (!stat.isDirectory()) {
          out(`${target}\n`);
          return;
        }
        const entries = fs.readdirSync(target)
          .filter((name) => options.all || !name.startsWith('.'))
          .sort((a, b) => a.localeCompare(b));
        if (options.long) {
          entries.forEach((name) => {
            const filePath = path.join(target, name);
            const itemStat = fs.lstatSync(filePath);
            const type = itemStat.isDirectory() ? 'd' : '-';
            out(`${type} ${String(itemStat.size).padStart(10, ' ')} ${itemStat.mtime.toISOString()} ${name}\n`);
          });
          return;
        }
        out(`${entries.join(options.one ? '\n' : '  ')}${entries.length ? '\n' : ''}`);
      } catch (error) {
        err('ls', `${target}: ${error.message}`);
        exitCode = 1;
      }
    });
    return exitCode;
  }

  function commandCat(args) {
    const files = args.filter((arg) => !arg.startsWith('-'));
    out(readAll(files));
    return 0;
  }

  function parseLineLimit(args, defaultValue) {
    const rest = [];
    let limit = defaultValue;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-n' || arg === '--lines') {
        limit = parseNumber(args[index + 1], limit);
        index += 1;
      } else if (arg.startsWith('--lines=')) {
        limit = parseNumber(arg.slice('--lines='.length), limit);
      } else if (/^-n\d+$/.test(arg)) {
        limit = parseNumber(arg.slice(2), limit);
      } else if (/^-\d+$/.test(arg)) {
        limit = parseNumber(arg.slice(1), limit);
      } else {
        rest.push(arg);
      }
    }
    return { limit: Math.max(0, limit), files: rest };
  }

  function printSelectedLines(command, files, selector) {
    const targets = files.length ? files : ['-'];
    targets.forEach((file, index) => {
      const text = readText(file);
      const lines = selector(splitLines(text));
      if (targets.length > 1) {
        if (index > 0) out('\n');
        out(`==> ${file} <==\n`);
      }
      if (lines.length) out(`${lines.join('\n')}\n`);
    });
  }

  function commandHead(args) {
    const parsed = parseLineLimit(args, 10);
    printSelectedLines('head', parsed.files, (lines) => lines.slice(0, parsed.limit));
    return 0;
  }

  function commandTail(args) {
    const parsed = parseLineLimit(args, 10);
    printSelectedLines('tail', parsed.files, (lines) => parsed.limit ? lines.slice(-parsed.limit) : []);
    return 0;
  }

  function commandWc(args) {
    const options = { lines: false, words: false, bytes: false };
    const files = [];
    for (const arg of args) {
      if (arg.startsWith('-') && arg !== '-') {
        if (arg.includes('l')) options.lines = true;
        if (arg.includes('w')) options.words = true;
        if (arg.includes('c')) options.bytes = true;
      } else {
        files.push(arg);
      }
    }
    if (!options.lines && !options.words && !options.bytes) {
      options.lines = true;
      options.words = true;
      options.bytes = true;
    }
    const targets = files.length ? files : ['-'];
    const totals = { lines: 0, words: 0, bytes: 0 };
    targets.forEach((file) => {
      const text = readText(file);
      const counts = {
        lines: (text.match(/\n/g) || []).length,
        words: text.trim() ? text.trim().split(/\s+/).length : 0,
        bytes: Buffer.byteLength(text),
      };
      totals.lines += counts.lines;
      totals.words += counts.words;
      totals.bytes += counts.bytes;
      const parts = [];
      if (options.lines) parts.push(String(counts.lines).padStart(8, ' '));
      if (options.words) parts.push(String(counts.words).padStart(8, ' '));
      if (options.bytes) parts.push(String(counts.bytes).padStart(8, ' '));
      if (file !== '-') parts.push(file);
      out(`${parts.join(' ')}\n`);
    });
    if (targets.length > 1) {
      const parts = [];
      if (options.lines) parts.push(String(totals.lines).padStart(8, ' '));
      if (options.words) parts.push(String(totals.words).padStart(8, ' '));
      if (options.bytes) parts.push(String(totals.bytes).padStart(8, ' '));
      parts.push('total');
      out(`${parts.join(' ')}\n`);
    }
    return 0;
  }

  function commandSort(args) {
    const options = { reverse: false, unique: false, numeric: false };
    const files = [];
    for (const arg of args) {
      if (arg.startsWith('-') && arg !== '-') {
        if (arg.includes('r')) options.reverse = true;
        if (arg.includes('u')) options.unique = true;
        if (arg.includes('n')) options.numeric = true;
      } else {
        files.push(arg);
      }
    }
    let lines = splitLines(readAll(files));
    lines.sort((a, b) => {
      if (options.numeric) return Number(a) - Number(b);
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });
    if (options.unique) lines = lines.filter((line, index) => index === 0 || line !== lines[index - 1]);
    if (options.reverse) lines.reverse();
    if (lines.length) out(`${lines.join('\n')}\n`);
    return 0;
  }

  function commandUniq(args) {
    const count = args.includes('-c');
    const files = args.filter((arg) => arg !== '-c');
    const lines = splitLines(readAll(files));
    const result = [];
    for (const line of lines) {
      const last = result[result.length - 1];
      if (last && last.value === line) last.count += 1;
      else result.push({ value: line, count: 1 });
    }
    result.forEach((item) => out(`${count ? String(item.count).padStart(7, ' ') + ' ' : ''}${item.value}\n`));
    return 0;
  }

  function commandMkdir(args) {
    const parents = args.includes('-p') || args.includes('--parents');
    const dirs = args.filter((arg) => arg !== '-p' && arg !== '--parents');
    dirs.forEach((dir) => fs.mkdirSync(dir, { recursive: parents }));
    return 0;
  }

  function copyRecursive(source, target) {
    const stat = fs.lstatSync(source);
    if (stat.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      fs.readdirSync(source).forEach((name) => copyRecursive(path.join(source, name), path.join(target, name)));
      return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  function commandCp(args) {
    const recursive = args.some((arg) => /^-.*[rR]/.test(arg));
    const values = args.filter((arg) => !arg.startsWith('-'));
    if (values.length < 2) throw new Error('missing file operand');
    const target = values[values.length - 1];
    const sources = values.slice(0, -1);
    const targetIsDir = fs.existsSync(target) && fs.statSync(target).isDirectory();
    if (sources.length > 1 && !targetIsDir) throw new Error('target is not a directory');
    sources.forEach((source) => {
      const stat = fs.lstatSync(source);
      if (stat.isDirectory() && !recursive) throw new Error(`omitting directory '${source}'`);
      const destination = targetIsDir ? path.join(target, path.basename(source)) : target;
      copyRecursive(source, destination);
    });
    return 0;
  }

  function commandMv(args) {
    const values = args.filter((arg) => !arg.startsWith('-'));
    if (values.length < 2) throw new Error('missing file operand');
    const target = values[values.length - 1];
    const sources = values.slice(0, -1);
    const targetIsDir = fs.existsSync(target) && fs.statSync(target).isDirectory();
    if (sources.length > 1 && !targetIsDir) throw new Error('target is not a directory');
    sources.forEach((source) => {
      const destination = targetIsDir ? path.join(target, path.basename(source)) : target;
      try {
        fs.renameSync(source, destination);
      } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        copyRecursive(source, destination);
        fs.rmSync(source, { recursive: true, force: true });
      }
    });
    return 0;
  }

  function commandRm(args) {
    const force = args.some((arg) => /^-.*f/.test(arg));
    const recursive = args.some((arg) => /^-.*[rR]/.test(arg));
    const targets = args.filter((arg) => !arg.startsWith('-'));
    targets.forEach((target) => {
      if (!fs.existsSync(target)) {
        if (!force) throw new Error(`cannot remove '${target}': No such file or directory`);
        return;
      }
      const stat = fs.lstatSync(target);
      if (stat.isDirectory() && !recursive) throw new Error(`cannot remove '${target}': Is a directory`);
      fs.rmSync(target, { recursive, force });
    });
    return 0;
  }

  function commandTouch(args) {
    const files = args.filter((arg) => !arg.startsWith('-'));
    const now = new Date();
    files.forEach((file) => {
      if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'w'));
      fs.utimesSync(file, now, now);
    });
    return 0;
  }

  function stripTrailingSeparators(value) {
    return String(value || '').replace(/[\\/]+$/g, '') || value;
  }

  function commandBasename(args) {
    const target = stripTrailingSeparators(args[0] || '');
    const suffix = args[1] || '';
    let name = path.basename(target);
    if (suffix && name.endsWith(suffix)) name = name.slice(0, -suffix.length);
    out(`${name}\n`);
    return 0;
  }

  function commandDirname(args) {
    const target = stripTrailingSeparators(args[0] || '.');
    out(`${path.dirname(target) || '.'}\n`);
    return 0;
  }

  function commandRealpath(args) {
    const targets = args.length ? args : ['.'];
    targets.forEach((target) => out(`${fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target)}\n`));
    return 0;
  }

  function parseListSpec(spec) {
    const ranges = String(spec || '').split(',').filter(Boolean).map((part) => {
      const match = part.match(/^(\d*)-(\d*)$/);
      if (match) {
        return { start: match[1] ? Number(match[1]) : 1, end: match[2] ? Number(match[2]) : Infinity };
      }
      const value = Number(part);
      return { start: value, end: value };
    });
    return (index) => ranges.some((range) => index >= range.start && index <= range.end);
  }

  function commandCut(args) {
    let delimiter = '\t';
    let fields = '';
    let chars = '';
    const files = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-d') {
        delimiter = args[index + 1] || delimiter;
        index += 1;
      } else if (arg.startsWith('-d')) {
        delimiter = arg.slice(2) || delimiter;
      } else if (arg === '-f') {
        fields = args[index + 1] || fields;
        index += 1;
      } else if (arg.startsWith('-f')) {
        fields = arg.slice(2);
      } else if (arg === '-c') {
        chars = args[index + 1] || chars;
        index += 1;
      } else if (arg.startsWith('-c')) {
        chars = arg.slice(2);
      } else if (!arg.startsWith('-')) {
        files.push(arg);
      }
    }
    const text = readAll(files);
    const lines = splitLines(text);
    if (fields) {
      const include = parseListSpec(fields);
      lines.forEach((line) => {
        const parts = line.split(delimiter);
        out(`${parts.filter((_, index) => include(index + 1)).join(delimiter)}\n`);
      });
      return 0;
    }
    const include = parseListSpec(chars || '1-');
    lines.forEach((line) => out(`${Array.from(line).filter((_, index) => include(index + 1)).join('')}\n`));
    return 0;
  }

  function decodeSet(value) {
    return String(value || '')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');
  }

  function expandCharSet(value) {
    const text = decodeSet(value);
    const chars = [];
    for (let index = 0; index < text.length; index += 1) {
      if (index + 2 < text.length && text[index + 1] === '-') {
        const start = text.charCodeAt(index);
        const end = text.charCodeAt(index + 2);
        const step = start <= end ? 1 : -1;
        for (let code = start; step > 0 ? code <= end : code >= end; code += step) chars.push(String.fromCharCode(code));
        index += 2;
      } else {
        chars.push(text[index]);
      }
    }
    return chars;
  }

  function commandTr(args) {
    const deleteMode = args[0] === '-d';
    const values = deleteMode ? args.slice(1) : args;
    const input = readStdin();
    const set1 = expandCharSet(values[0] || '');
    if (deleteMode) {
      const deleting = new Set(set1);
      out(Array.from(input).filter((char) => !deleting.has(char)).join(''));
      return 0;
    }
    const set2 = expandCharSet(values[1] || '');
    const map = new Map();
    set1.forEach((char, index) => map.set(char, set2[Math.min(index, set2.length - 1)] || ''));
    out(Array.from(input).map((char) => map.has(char) ? map.get(char) : char).join(''));
    return 0;
  }

  function commandDu(args) {
    const summarize = args.includes('-s') || args.includes('--summarize');
    const human = args.includes('-h') || args.includes('--human-readable');
    const targets = args.filter((arg) => !arg.startsWith('-'));
    const values = targets.length ? targets : ['.'];
    values.forEach((target) => {
      if (summarize || !fs.lstatSync(target).isDirectory()) {
        const size = directorySize(target);
        out(`${human ? formatHumanSize(size) : size}\t${normalizeOutputPath(target)}\n`);
        return;
      }
      walk(target, (filePath, stat) => {
        if (stat.isDirectory()) {
          const size = directorySize(filePath);
          out(`${human ? formatHumanSize(size) : size}\t${normalizeOutputPath(filePath)}\n`);
        }
      });
    });
    return 0;
  }

  function commandStat(args) {
    const targets = args.filter((arg) => !arg.startsWith('-'));
    targets.forEach((target, index) => {
      const stat = fs.lstatSync(target);
      if (index > 0) out('\n');
      out(`File: ${target}\n`);
      out(`Size: ${stat.size}\n`);
      out(`Type: ${stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'}\n`);
      out(`Modified: ${stat.mtime.toISOString()}\n`);
    });
    return 0;
  }

  function collectGrepFiles(values, recursive) {
    const files = [];
    if (!values.length) return ['-'];
    values.forEach((value) => {
      const stat = fs.lstatSync(value);
      if (stat.isDirectory()) {
        if (!recursive) throw new Error(`${value}: Is a directory`);
        walk(value, (filePath, itemStat) => {
          if (itemStat.isFile()) files.push(filePath);
        });
      } else {
        files.push(value);
      }
    });
    return files;
  }

  function commandGrep(args) {
    const options = { ignoreCase: false, lineNumber: false, recursive: false, invert: false, fixed: false, list: false, count: false, withFilename: null };
    let pattern = '';
    const values = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-e') {
        pattern = args[index + 1] || '';
        index += 1;
      } else if (arg.startsWith('-') && arg !== '-') {
        if (arg.includes('i')) options.ignoreCase = true;
        if (arg.includes('n')) options.lineNumber = true;
        if (arg.includes('r') || arg.includes('R')) options.recursive = true;
        if (arg.includes('v')) options.invert = true;
        if (arg.includes('F')) options.fixed = true;
        if (arg.includes('l')) options.list = true;
        if (arg.includes('c')) options.count = true;
        if (arg.includes('H')) options.withFilename = true;
        if (arg.includes('h')) options.withFilename = false;
      } else if (!pattern) {
        pattern = arg;
      } else {
        values.push(arg);
      }
    }
    if (!pattern) throw new Error('missing pattern');
    const files = collectGrepFiles(values, options.recursive);
    const flags = options.ignoreCase ? 'i' : '';
    const regexp = new RegExp(options.fixed ? escapeRegExp(pattern) : pattern, flags);
    const showFilename = options.withFilename === true || (options.withFilename === null && files.length > 1);
    let matchedAny = false;
    files.forEach((file) => {
      const lines = splitLines(readText(file));
      let fileMatches = 0;
      lines.forEach((line, lineIndex) => {
        const matched = regexp.test(line);
        regexp.lastIndex = 0;
        if ((matched && !options.invert) || (!matched && options.invert)) {
          matchedAny = true;
          fileMatches += 1;
          if (!options.list && !options.count) {
            const prefix = [showFilename && file !== '-' ? file : '', options.lineNumber ? String(lineIndex + 1) : ''].filter(Boolean).join(':');
            out(`${prefix ? `${normalizeOutputPath(prefix)}:` : ''}${line}\n`);
          }
        }
      });
      if (options.list && fileMatches) out(`${normalizeOutputPath(file)}\n`);
      if (options.count) out(`${showFilename && file !== '-' ? `${normalizeOutputPath(file)}:` : ''}${fileMatches}\n`);
    });
    return matchedAny ? 0 : 1;
  }

  function commandFind(args) {
    const roots = [];
    let index = 0;
    while (index < args.length && !args[index].startsWith('-') && args[index] !== '!' && args[index] !== '(') {
      roots.push(args[index]);
      index += 1;
    }
    if (!roots.length) roots.push('.');
    const filters = [];
    let maxDepth = Infinity;
    let minDepth = 0;
    let negateNext = false;
    while (index < args.length) {
      const token = args[index];
      if (token === '!' || token === '-not') {
        negateNext = true;
        index += 1;
        continue;
      }
      if (token === '-maxdepth') {
        maxDepth = parseNumber(args[index + 1], maxDepth);
        index += 2;
        continue;
      }
      if (token === '-mindepth') {
        minDepth = parseNumber(args[index + 1], minDepth);
        index += 2;
        continue;
      }
      if (token === '-name' || token === '-path') {
        const pattern = wildcardToRegExp(args[index + 1] || '');
        const field = token === '-name' ? 'name' : 'path';
        const negated = negateNext;
        filters.push((filePath) => {
          const candidate = field === 'name' ? path.basename(filePath) : normalizeOutputPath(filePath);
          const ok = pattern.test(candidate);
          return negated ? !ok : ok;
        });
        negateNext = false;
        index += 2;
        continue;
      }
      if (token === '-type') {
        const type = args[index + 1] || '';
        const negated = negateNext;
        filters.push((filePath, stat) => {
          const ok = type === 'f' ? stat.isFile() : type === 'd' ? stat.isDirectory() : true;
          return negated ? !ok : ok;
        });
        negateNext = false;
        index += 2;
        continue;
      }
      index += 1;
    }
    roots.forEach((root) => {
      walk(root, (filePath, stat, depth) => {
        if (depth < minDepth) return;
        if (!filters.every((filter) => filter(filePath, stat))) return;
        const relative = path.relative(root, filePath);
        const display = relative && root === '.' ? `.${path.sep}${relative}` : relative ? path.join(root, relative) : root;
        out(`${normalizeOutputPath(display)}\n`);
      }, 0, maxDepth);
    });
    return 0;
  }

  function parseSedSubstitution(script) {
    if (!script.startsWith('s') || script.length < 2) return null;
    const delimiter = script[1];
    const parts = [];
    let current = '';
    let escaped = false;
    for (let index = 2; index < script.length; index += 1) {
      const char = script[index];
      if (escaped) {
        current += char;
        escaped = false;
      } else if (char === '\\') {
        current += char;
        escaped = true;
      } else if (char === delimiter) {
        parts.push(current);
        current = '';
        if (parts.length === 2) {
          parts.push(script.slice(index + 1));
          break;
        }
      } else {
        current += char;
      }
    }
    if (parts.length < 3) return null;
    return { pattern: parts[0], replacement: parts[1], flags: parts[2] };
  }

  function parseSedAddress(value, lineNumber, totalLines, line) {
    if (!value) return true;
    if (value === '$') return lineNumber === totalLines;
    if (/^\d+$/.test(value)) return lineNumber === Number(value);
    if (value.startsWith('/') && value.endsWith('/')) {
      return new RegExp(value.slice(1, -1)).test(line);
    }
    return true;
  }

  function sedAddressMatch(address, lineNumber, totalLines, line) {
    const parts = String(address || '').split(',');
    if (parts.length === 1) return parseSedAddress(parts[0], lineNumber, totalLines, line);
    const start = parts[0] === '$' ? totalLines : Number(parts[0] || 1);
    const end = parts[1] === '$' ? totalLines : Number(parts[1] || totalLines);
    return lineNumber >= start && lineNumber <= end;
  }

  function commandSed(args) {
    let quiet = false;
    let script = '';
    const files = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-n') {
        quiet = true;
      } else if (arg === '-e') {
        script = args[index + 1] || script;
        index += 1;
      } else if (!script) {
        script = arg;
      } else {
        files.push(arg);
      }
    }
    if (!script) throw new Error('missing script');
    const text = readAll(files);
    const lines = splitLines(text);
    const totalLines = lines.length;
    const printMatch = script.match(/^(.+)p$/);
    const substitution = parseSedSubstitution(script);
    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      let nextLine = line;
      let printed = false;
      if (substitution) {
        const flags = substitution.flags.includes('g') ? 'g' : '';
        const regexp = new RegExp(substitution.pattern, flags);
        const changed = regexp.test(nextLine);
        regexp.lastIndex = 0;
        const replacement = substitution.replacement.replace(/\$/g, '$$$$').replace(/&/g, '$$$&');
        nextLine = nextLine.replace(regexp, replacement);
        if (quiet && substitution.flags.includes('p') && changed) {
          out(`${nextLine}\n`);
          printed = true;
        }
      } else if (printMatch && sedAddressMatch(printMatch[1], lineNumber, totalLines, line)) {
        out(`${line}\n`);
        printed = true;
      }
      if (!quiet && !printed) out(`${nextLine}\n`);
    });
    return 0;
  }

  const command = process.argv[2];
  const args = process.argv.slice(3);
  const commands = {
    basename: commandBasename,
    cat: commandCat,
    cp: commandCp,
    cut: commandCut,
    dirname: commandDirname,
    du: commandDu,
    find: commandFind,
    grep: commandGrep,
    head: commandHead,
    ls: commandLs,
    mkdir: commandMkdir,
    mv: commandMv,
    pwd: commandPwd,
    realpath: commandRealpath,
    rm: commandRm,
    sed: commandSed,
    sort: commandSort,
    stat: commandStat,
    tail: commandTail,
    touch: commandTouch,
    tr: commandTr,
    uniq: commandUniq,
    wc: commandWc,
  };

  try {
    if (!commands[command]) throw new Error(`unsupported command: ${command || ''}`);
    const exitCode = commands[command](args);
    process.exitCode = typeof exitCode === 'number' ? exitCode : 0;
  } catch (error) {
    err(command || 'tool', error?.message || String(error));
    process.exitCode = 1;
  }
}

function writeToolRunner(binDir) {
  const runnerPath = path.join(binDir, 'yibiao-tool-runner.cjs');
  const source = `'use strict';\n(${toolRunnerMain.toString()})();\n`;
  writeFileIfChanged(runnerPath, source);
  return runnerPath;
}

function ensureRuntimeShims(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const runnerPath = writeToolRunner(binDir);
  writeNodeShim(binDir);
  SHIM_COMMANDS.forEach((command) => writeCommandShim(binDir, command, runnerPath));
  return runnerPath;
}

function writeOpenCodeAgentsFile(workspaceDir) {
  if (!workspaceDir) return '';
  const targetPath = path.join(workspaceDir, 'AGENTS.md');
  writeFileIfChanged(targetPath, AGENTS_MD_CONTENT);
  return targetPath;
}

function prependPathEntries(env, entries) {
  const pathKey = process.platform === 'win32' && env.Path ? 'Path' : 'PATH';
  const existingPath = env[pathKey] || env.PATH || env.Path || '';
  const nextPath = [...entries, existingPath].filter(Boolean).join(path.delimiter);
  env.PATH = nextPath;
  if (process.platform === 'win32') env.Path = nextPath;
  env.YIBIAO_ELECTRON_NODE = process.execPath;
  return env;
}

function ensureOpenCodeToolEnvironment({ app, workspaceDir } = {}) {
  const runtimeToolsBinDir = getRuntimeToolsBinDir(app);
  const bundledToolsBinDir = getBundledOpencodeToolsBinDir(app);
  ensureRuntimeShims(runtimeToolsBinDir);
  verifyBundledTools(bundledToolsBinDir);
  const agentsPath = writeOpenCodeAgentsFile(workspaceDir);
  return {
    runtimeToolsBinDir,
    bundledToolsBinDir,
    agentsPath,
    pathEntries: [runtimeToolsBinDir, bundledToolsBinDir],
  };
}

function applyOpenCodeToolEnvironment(env, toolEnvironment) {
  return prependPathEntries(env, toolEnvironment?.pathEntries || []);
}

module.exports = {
  AGENTS_MD_CONTENT,
  BUNDLED_COMMANDS,
  SHIM_COMMANDS,
  applyOpenCodeToolEnvironment,
  ensureOpenCodeToolEnvironment,
  getRuntimeToolsBinDir,
  writeOpenCodeAgentsFile,
};
