@echo off
setlocal
chcp 65001 >nul
title Configure local AtomGit Actions Runner
set "ATOMGIT_RUNNER_SETUP_FILE=%~f0"
set "ATOMGIT_RUNNER_INSTALL_DIR=%~1"
rem Run as administrator. Optional argument: a new, empty installation directory.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $source = [IO.File]::ReadAllText($env:ATOMGIT_RUNNER_SETUP_FILE, [Text.Encoding]::UTF8); & ([ScriptBlock]::Create(($source -split '(?m)^# POWERSHELL_START\r?$', 2)[1])) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
set "SETUP_EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %SETUP_EXIT_CODE%

# POWERSHELL_START
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repoUrl = 'https://github.com/FB208/OpenBidKit_Yibiao'

# Windows 服务配置需要管理员权限，Git 需要对服务账户可用。
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '请右键此脚本，选择“以管理员身份运行”。'
}
$machineGit = [Environment]::GetEnvironmentVariable('Path', 'Machine').Split(';') | Where-Object {
  $_ -and (Test-Path -LiteralPath (Join-Path ([Environment]::ExpandEnvironmentVariables($_.Trim('"'))) 'git.exe'))
} | Select-Object -First 1
if (-not $machineGit) {
  throw '请先安装面向所有用户的 Git for Windows，并将 Git 加入系统 PATH，然后重新运行此脚本。'
}

# 使用独立的新目录，不覆盖已经存在的 Runner 配置。
$installDir = if ($env:ATOMGIT_RUNNER_INSTALL_DIR) {
  [IO.Path]::GetFullPath($env:ATOMGIT_RUNNER_INSTALL_DIR)
} else {
  Join-Path $env:SystemDrive 'actions-runner-yibiao-atomgit'
}
if (Test-Path -LiteralPath $installDir) {
  if (Get-ChildItem -LiteralPath $installDir -Force | Select-Object -First 1) {
    throw "安装目录不是空目录：$installDir。已有 Runner 无需重新注册；新安装请指定另一个空目录。"
  }
}
$runnerArch = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
  'X64' { 'x64' }
  'Arm64' { 'arm64' }
  default { throw '此安装脚本支持 Windows x64 和 ARM64。' }
}

# 从 GitHub 官方发布获取对应系统的安装包，并校验官方 SHA-256。
Write-Host "目标仓库：$repoUrl"
Write-Host "安装目录：$installDir"
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/actions/runner/releases/latest' -Headers @{
  'Accept' = 'application/vnd.github+json'
  'User-Agent' = 'yibiao-runner-setup'
}
$asset = @($release.assets | Where-Object { $_.name -like "actions-runner-win-$runnerArch-*.zip" })
if ($asset.Count -ne 1 -or $asset[0].digest -notmatch '^sha256:[0-9a-f]{64}$') {
  throw '官方发布未提供对应安装包或 SHA-256，安装已停止。'
}
$asset = $asset[0]
$archive = Join-Path ([IO.Path]::GetTempPath()) ('atomgit-runner-' + [Guid]::NewGuid().ToString('N') + '.zip')
try {
  Write-Host "正在下载 $($asset.name)..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive -UseBasicParsing
  $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $asset.digest.Substring(7)) { throw 'Runner 安装包 SHA-256 不匹配。' }
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Expand-Archive -LiteralPath $archive -DestinationPath $installDir
} finally {
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
}

# 只需要 GitHub 临时注册令牌；不要在这里输入 AtomGit Token 或 GitHub PAT。
Write-Host ''
Write-Host "打开：$repoUrl/settings/actions/runners/new"
Write-Host '选择 Windows，复制 Configure 命令中 --token 后面的值（有效期一小时）。'
$secureToken = Read-Host '粘贴临时注册令牌' -AsSecureString
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
  $registrationToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer).Trim()
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
}
if (-not $registrationToken) { throw '注册令牌不能为空。' }

# 注册为项目专用 Runner，并由官方配置程序安装 Windows 后台服务。
Push-Location -LiteralPath $installDir
try {
  & .\config.cmd --unattended --url $repoUrl --token $registrationToken `
    --name "atomgit-$env:COMPUTERNAME-$runnerArch" --labels 'atomgit-upload' --work '_work' `
    --runasservice --windowslogonaccount 'NT AUTHORITY\NETWORK SERVICE'
  if ($LASTEXITCODE -ne 0) { throw 'Runner 注册或服务安装失败，请查看上方输出。' }
  $serviceName = (Get-Content -LiteralPath '.service' -Raw).Trim()
  Start-Service -Name $serviceName
  (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
  Write-Host ''
  Write-Host "配置完成，Windows 服务已启动：$serviceName"
  Write-Host "请在 $repoUrl/settings/actions/runners 确认状态为 Idle，标签包含 atomgit-upload。"
  Write-Host '发布凭据由工作流注入，无需在此目录配置 .env。电脑需要保持开机、联网且不休眠。'
} finally {
  $registrationToken = $null
  $secureToken.Dispose()
  Pop-Location
}
