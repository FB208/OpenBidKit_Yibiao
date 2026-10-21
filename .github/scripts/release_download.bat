@echo off
setlocal
chcp 65001 >nul
title Publish Yibiao release to AtomGit

if "%~1"=="" (
  echo Usage: release_download.bat ^<tag^>
  exit /b 1
)
set "TAG_NAME=%~1"
set "ATOMGIT_ENTRY_FILE=%~f0"
set "ATOMGIT_SCRIPT_DIR=%~dp0"
rem Load the embedded PowerShell as UTF-8, including Chinese paths and messages.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $source = [IO.File]::ReadAllText($env:ATOMGIT_ENTRY_FILE, [Text.Encoding]::UTF8); & ([ScriptBlock]::Create(($source -split '(?m)^# POWERSHELL_START\r?$', 2)[1])) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
exit /b %ERRORLEVEL%

# POWERSHELL_START
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 调用共用的准备、上传或完成阶段，原样传递失败结果。
function Invoke-ReleasePhase {
  param([string]$Phase, [string[]]$PhaseArgs = @())
  & node (Join-Path $env:ATOMGIT_SCRIPT_DIR 'sync-atomgit-release.mjs') $Phase @PhaseArgs
  if ($LASTEXITCODE -ne 0) { throw "AtomGit release phase failed: $Phase" }
}

# 每次运行使用独立临时目录，下载和日志不写入日常开发目录。
$workRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$workRoot = [IO.Path]::GetFullPath($workRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$workDir = Join-Path $workRoot ('yibiao-atomgit-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workDir | Out-Null
$env:GITHUB_RELEASE_JSON = Join-Path $workDir 'release.json'
try {
  Invoke-ReleasePhase '--prepare'
  $release = Get-Content -LiteralPath $env:GITHUB_RELEASE_JSON -Encoding UTF8 -Raw | ConvertFrom-Json
  $githubHeaders = @{ 'User-Agent' = 'Windows-Release-Downloader' }
  $downloadedFiles = @()
  foreach ($asset in $release.pendingAssets) {
    $file = Join-Path $workDir $asset.name
    Write-Host "Downloading: $($asset.name)"
    Invoke-WebRequest -Uri $asset.url -OutFile $file -Headers $githubHeaders -UseBasicParsing
    $downloadedFiles += $file
  }
  foreach ($file in $downloadedFiles) {
    Invoke-ReleasePhase '--upload' $file
  }
  Invoke-ReleasePhase '--finalize'
} finally {
  # 仅清理本次创建且确认位于临时根目录下的目录。
  $cleanupTarget = [IO.Path]::GetFullPath($workDir)
  if ([IO.Path]::GetDirectoryName($cleanupTarget) -eq $workRoot -and
      [IO.Path]::GetFileName($cleanupTarget).StartsWith('yibiao-atomgit-')) {
    Remove-Item -LiteralPath $cleanupTarget -Recurse -Force
  }
}
