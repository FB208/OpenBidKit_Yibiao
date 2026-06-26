const { execFile } = require('node:child_process');

function execFileUtf8(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 20000,
      ...options,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function normalizeFontName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function addFontName(target, value) {
  const name = normalizeFontName(value);
  if (!name) return;
  target.add(name);
}

function sortFontNames(fonts) {
  return Array.from(fonts).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

async function listWindowsFonts() {
  const script = [
    "$OutputEncoding = [System.Text.Encoding]::UTF8",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Drawing",
    "$fonts = New-Object System.Drawing.Text.InstalledFontCollection",
    "$fonts.Families | ForEach-Object { $_.Name } | Sort-Object -Unique",
  ].join('; ');
  const output = await execFileUtf8('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  const fonts = new Set();
  output.split(/\r?\n/).forEach((line) => addFontName(fonts, line));
  return sortFontNames(fonts);
}

function collectMacFontRecord(fonts, record) {
  if (!record || typeof record !== 'object') return;
  addFontName(fonts, record.family);
  addFontName(fonts, record._name);
  addFontName(fonts, record.name);

  const typefaces = Array.isArray(record.typefaces) ? record.typefaces : [];
  typefaces.forEach((typeface) => {
    addFontName(fonts, typeface.family);
    addFontName(fonts, typeface._name);
    addFontName(fonts, typeface.name);
  });
}

async function listMacFonts() {
  const output = await execFileUtf8('/usr/sbin/system_profiler', ['SPFontsDataType', '-json'], { timeout: 30000 });
  const payload = JSON.parse(output || '{}');
  const fonts = new Set();
  const records = Array.isArray(payload.SPFontsDataType) ? payload.SPFontsDataType : [];
  records.forEach((record) => collectMacFontRecord(fonts, record));
  return sortFontNames(fonts);
}

function createSystemFontService() {
  let cache = null;

  async function list() {
    if (cache) return cache;

    if (process.platform === 'win32') {
      cache = await listWindowsFonts();
      return cache;
    }

    if (process.platform === 'darwin') {
      cache = await listMacFonts();
      return cache;
    }

    cache = [];
    return cache;
  }

  return { list };
}

module.exports = {
  createSystemFontService,
};
