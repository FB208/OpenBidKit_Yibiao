import { copyFile, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MICROSOFT_WORD_PROG_IDS,
  WPS_WORD_PROG_IDS,
  findLibreOfficeCommand,
  findPowerShellCommand,
  isComProgIdRegistered,
  runProcess,
} from '../doc2markdown/convert.mjs';

// 几百页带图片的标书导出较慢，比 .doc 转 .docx 的超时宽松得多。
const PDF_EXPORT_TIMEOUT_MS = 15 * 60 * 1000;
const BACKEND_CACHE_MS = 60 * 1000;

// ExportAsFixedFormat 的第 11 个参数为 1 时按标题生成书签；该接口不可用时退回 SaveAs（格式 17 即 PDF，没有书签）。
// 只读打开、不更新域，导出结果与文档当前内容一致。
const POWERSHELL_PDF_EXPORT_SCRIPT = [
  'param(',
  '  [Parameter(Mandatory=$true)][string]$ProgId,',
  '  [Parameter(Mandatory=$true)][string]$InputPath,',
  '  [Parameter(Mandatory=$true)][string]$OutputPath',
  ')',
  '$ErrorActionPreference = "Stop"',
  'function Release-ComObject([object]$ComObject) {',
  '  if ($null -ne $ComObject) {',
  '    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($ComObject) } catch {}',
  '  }',
  '}',
  '$app = $null',
  '$doc = $null',
  'try {',
  '  $app = New-Object -ComObject $ProgId',
  '  try { $app.Visible = $false } catch {}',
  '  try { $app.DisplayAlerts = 0 } catch {}',
  '  try { $app.AutomationSecurity = 3 } catch {}',
  '  $doc = $app.Documents.Open($InputPath, $false, $true, $false)',
  '  $bookmarks = 1',
  '  try {',
  '    $doc.ExportAsFixedFormat($OutputPath, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1, $true, $true, $false)',
  '  } catch {',
  '    $bookmarks = 0',
  '    if (Test-Path -LiteralPath $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }',
  '    try { $doc.SaveAs2($OutputPath, 17) } catch { $doc.SaveAs($OutputPath, 17) }',
  '  }',
  '  if (!(Test-Path -LiteralPath $OutputPath)) { throw "output missing" }',
  '  Write-Output "BOOKMARKS=$bookmarks"',
  '} finally {',
  '  if ($null -ne $doc) { try { $doc.Close($false) } catch {} }',
  '  if ($null -ne $app) { try { $app.Quit() } catch {} }',
  '  Release-ComObject $doc',
  '  Release-ComObject $app',
  '  [GC]::Collect()',
  '  [GC]::WaitForPendingFinalizers()',
  '}',
  '',
].join('\n');

let backendCache = null;

async function findFirstRegisteredProgId(progIds) {
  for (const progId of progIds) {
    if (await isComProgIdRegistered(progId)) return progId;
  }
  return '';
}

/** 探测本机可用的转换程序；探测要查注册表和试运行命令，结果短时间内复用。 */
async function detectBackends() {
  if (backendCache && Date.now() - backendCache.time < BACKEND_CACHE_MS) {
    return backendCache.backends;
  }

  const backends = [];
  const powershell = await findPowerShellCommand();
  if (powershell) {
    const wordProgId = await findFirstRegisteredProgId(MICROSOFT_WORD_PROG_IDS);
    if (wordProgId) backends.push({ type: 'word', label: 'Microsoft Word', powershell, progId: wordProgId });
    const wpsProgId = await findFirstRegisteredProgId(WPS_WORD_PROG_IDS);
    if (wpsProgId) backends.push({ type: 'wps', label: 'WPS Office', powershell, progId: wpsProgId });
  }
  const soffice = await findLibreOfficeCommand();
  if (soffice) backends.push({ type: 'libreoffice', label: 'LibreOffice', soffice });

  backendCache = { time: Date.now(), backends };
  return backends;
}

/** 本机可用的转换程序，按默认尝试顺序排列：Word、WPS、LibreOffice。 */
export async function listPdfBackends() {
  return (await detectBackends()).map(({ type, label }) => ({ type, label }));
}

/** .wps 文件优先交给 WPS，其余按 Word、WPS、LibreOffice 的顺序尝试，排版最接近原文档的排在前面。 */
function orderBackends(backends, inputPath) {
  if (path.extname(inputPath).toLowerCase() !== '.wps') return backends;
  return [...backends.filter((backend) => backend.type === 'wps'), ...backends.filter((backend) => backend.type !== 'wps')];
}

async function runComPdfExport(backend, inputPath, outputPath, workDir) {
  const scriptPath = path.join(workDir, 'office-pdf-export.ps1');
  await writeFile(scriptPath, POWERSHELL_PDF_EXPORT_SCRIPT, 'utf8');
  const { stdout } = await runProcess(backend.powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    backend.progId,
    inputPath,
    outputPath,
  ], { timeoutMs: PDF_EXPORT_TIMEOUT_MS });
  return { bookmarks: /BOOKMARKS=1/.test(stdout) };
}

async function runLibreOfficePdfExport(backend, inputPath, outputPath, workDir) {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'yibiao-pdf-lo-profile-'));
  try {
    await runProcess(backend.soffice, [
      '--headless',
      '--nologo',
      '--nolockcheck',
      '--nodefault',
      '--nofirststartwizard',
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--convert-to',
      'pdf',
      '--outdir',
      workDir,
      inputPath,
    ], { timeoutMs: PDF_EXPORT_TIMEOUT_MS });
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }

  const generated = path.join(workDir, `${path.basename(inputPath, path.extname(inputPath))}.pdf`);
  if (generated !== outputPath) {
    await copyFile(generated, outputPath);
    await rm(generated, { force: true });
  }
  // LibreOffice 默认按标题导出书签。
  return { bookmarks: true };
}

async function isPdfFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(5), 0, 5, 0);
    return bytesRead === 5 && buffer.toString('latin1') === '%PDF-';
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

function summarizeError(error) {
  return String(error instanceof Error ? error.message : error || '未知错误')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join('；')
    .slice(0, 500);
}

/**
 * 用本机 Office 把 Word 文档导出成单层 PDF，写到 workDir/source.pdf。
 * 先把文档复制到 workDir 下的 ASCII 文件名再转换，避免中文路径和原文件被占用的影响。
 * 返回实际使用的转换程序，以及导出的 PDF 是否带标题书签。
 */
export async function exportWordToPdf(inputPath, workDir) {
  const backends = orderBackends(await detectBackends(), inputPath);
  if (!backends.length) {
    throw new Error('未找到可用的转换程序，请安装 Microsoft Word、WPS Office 或 LibreOffice 后重试');
  }

  const inputCopy = path.join(workDir, `source${path.extname(inputPath).toLowerCase() || '.docx'}`);
  const outputPath = path.join(workDir, 'source.pdf');
  await copyFile(inputPath, inputCopy);

  const attempts = [];
  for (const backend of backends) {
    await rm(outputPath, { force: true });
    try {
      const result = backend.type === 'libreoffice'
        ? await runLibreOfficePdfExport(backend, inputCopy, outputPath, workDir)
        : await runComPdfExport(backend, inputCopy, outputPath, workDir);
      if (!(await isPdfFile(outputPath))) {
        throw new Error('没有生成有效的 PDF 文件');
      }
      return { pdfPath: outputPath, backend: { type: backend.type, label: backend.label }, bookmarks: result.bookmarks, attempts };
    } catch (error) {
      attempts.push({ label: backend.label, error: summarizeError(error) });
    }
  }

  const detail = attempts.map((attempt) => `${attempt.label}：${attempt.error}`).join('；');
  throw new Error(`导出 PDF 失败，请关闭正在运行的 Office/WPS 后重试。${detail}`);
}
