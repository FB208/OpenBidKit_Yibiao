@echo off
setlocal
chcp 65001 >nul
title Download and upload latest Yibiao release
rem Manual entry: no tag argument; read ATOMGIT_TOKEN from .env beside this script.

set "ATOMGIT_ENV_FILE=%~dp0.env"
set "ATOMGIT_LATEST_ENTRY_FILE=%~f0"
rem Load the embedded PowerShell as UTF-8, including Chinese paths and messages.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $source = [IO.File]::ReadAllText($env:ATOMGIT_LATEST_ENTRY_FILE, [Text.Encoding]::UTF8); & ([ScriptBlock]::Create(($source -split '(?m)^# POWERSHELL_START\r?$', 2)[1])) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" echo Release download or AtomGit upload failed.
pause
exit /b %EXIT_CODE%

# POWERSHELL_START
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$githubRepo = 'FB208/OpenBidKit_Yibiao'
$githubApi = "https://api.github.com/repos/$githubRepo/releases/latest"
$atomOwner = 'FB208'
$atomRepo = 'OpenBidKit_Yibiao'
$atomApiBase = 'https://api.atomgit.com'
$githubHeaders = @{
  'User-Agent' = 'Windows-Release-Downloader'
  'Accept' = 'application/vnd.github+json'
}

# 从同目录 .env 读取旧版 ATOMGIT_TOKEN，支持注释、空行和引号。
function Read-AtomGitToken {
  param([string]$EnvFile)
  if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    throw "AtomGit config file not found: $EnvFile"
  }
  foreach ($rawLine in Get-Content -LiteralPath $EnvFile -Encoding UTF8) {
    $line = $rawLine.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
    $separatorIndex = $line.IndexOf('=')
    if ($separatorIndex -lt 0) { continue }
    $key = $line.Substring(0, $separatorIndex).Trim()
    if ($key -ne 'ATOMGIT_TOKEN') { continue }
    $value = $line.Substring($separatorIndex + 1).Trim()
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    if ([string]::IsNullOrWhiteSpace($value)) { throw 'ATOMGIT_TOKEN cannot be empty.' }
    return $value
  }
  throw 'ATOMGIT_TOKEN is missing from the AtomGit config file.'
}

# 根据附件扩展名选择默认 Content-Type。
function Get-AssetContentType {
  param([string]$FileName)
  switch ([IO.Path]::GetExtension($FileName).ToLowerInvariant()) {
    '.exe' { return 'application/vnd.microsoft.portable-executable' }
    '.zip' { return 'application/zip' }
    '.dmg' { return 'application/x-apple-diskimage' }
    '.yml' { return 'application/yaml' }
    '.yaml' { return 'application/yaml' }
    default { return 'application/octet-stream' }
  }
}

# 按 AtomGit 返回的上传地址和请求头上传到对应 tag 的发行版。
function Upload-AtomGitAsset {
  param([string]$FilePath, [string]$Tag, [hashtable]$ApiHeaders)
  $fileName = [IO.Path]::GetFileName($FilePath)
  $encodedOwner = [Uri]::EscapeDataString($atomOwner)
  $encodedRepo = [Uri]::EscapeDataString($atomRepo)
  $encodedTag = [Uri]::EscapeDataString($Tag)
  $encodedFileName = [Uri]::EscapeDataString($fileName)
  $uploadApi = "$atomApiBase/api/v5/repos/$encodedOwner/$encodedRepo/releases/$encodedTag/upload_url?file_name=$encodedFileName"
  Write-Host "Getting AtomGit upload URL: $fileName"
  $uploadTarget = Invoke-RestMethod -Uri $uploadApi -Method Get -Headers $ApiHeaders
  if ([string]::IsNullOrWhiteSpace([string]$uploadTarget.url)) {
    throw "AtomGit did not return an upload URL for $fileName."
  }
  $uploadHeaders = @{}
  if ($null -ne $uploadTarget.headers) {
    foreach ($property in $uploadTarget.headers.PSObject.Properties) {
      $uploadHeaders[$property.Name] = [string]$property.Value
    }
  }
  $contentType = Get-AssetContentType -FileName $fileName
  if ($uploadHeaders.ContainsKey('Content-Type')) {
    $contentType = $uploadHeaders['Content-Type']
    $uploadHeaders.Remove('Content-Type')
  }
  Write-Host "Uploading to AtomGit: $fileName"
  Invoke-WebRequest -Uri $uploadTarget.url -Method Put -Headers $uploadHeaders -ContentType $contentType -InFile $FilePath -UseBasicParsing | Out-Null
}

$atomToken = Read-AtomGitToken -EnvFile $env:ATOMGIT_ENV_FILE
$atomApiHeaders = @{
  'Accept' = 'application/json'
  'Authorization' = "Bearer $atomToken"
}
Write-Host 'Fetching latest GitHub release...'
$release = Invoke-RestMethod -Uri $githubApi -Headers $githubHeaders
$tag = $release.tag_name
$out = Join-Path (Get-Location) "Yibiao-$tag"
New-Item -ItemType Directory -Force -Path $out | Out-Null
Write-Host "Latest version: $tag"
if (-not $release.assets -or $release.assets.Count -eq 0) {
  throw 'No GitHub release assets found.'
}
$downloadedFiles = @()
foreach ($asset in $release.assets) {
  $file = Join-Path $out $asset.name
  Write-Host "Downloading: $($asset.name)"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -Headers $githubHeaders -UseBasicParsing
  $downloadedFiles += $file
}
Write-Host ''
Write-Host 'All GitHub release assets downloaded. Starting AtomGit upload...'
foreach ($file in $downloadedFiles) {
  Upload-AtomGitAsset -FilePath $file -Tag $tag -ApiHeaders $atomApiHeaders
}
Write-Host ''
Write-Host "Done. Save path: $out"
Write-Host "AtomGit release: https://atomgit.com/$atomOwner/$atomRepo/releases/$tag"
