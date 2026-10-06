@echo off
setlocal
chcp 65001 >nul
title Configure local AtomGit Actions Runner
set "ATOMGIT_RUNNER_SETUP_FILE=%~f0"
set "ATOMGIT_RUNNER_INSTALL_DIR=%~1"
rem Run as the signed-in user's administrator. Optional argument: installation directory.
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
$startupName = 'YibiaoAtomGitRunner'
$mutexName = 'Local\YibiaoAtomGitRunner'

# 只查找当前安装目录内指定名称的 Runner 进程。
function Get-InstalledRunnerProcess {
  param([string]$InstallDir, [string]$Name)
  $prefix = $InstallDir.TrimEnd('\') + '\'
  Get-CimInstance Win32_Process -Filter "Name='$Name'" | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  }
}

# 在任务空闲时停用旧系统服务和当前用户实例，供重复运行脚本时修复。
function Stop-RunnerForRepair {
  param([string]$InstallDir)
  if (Get-InstalledRunnerProcess $InstallDir 'Runner.Worker.exe') {
    throw 'Runner 正在执行任务，请等任务结束后重新运行配置脚本。'
  }
  $serviceFile = Join-Path $InstallDir '.service'
  if (Test-Path -LiteralPath $serviceFile) {
    $serviceName = (Get-Content -LiteralPath $serviceFile -Raw -Encoding UTF8).Trim()
    $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    if ($service) {
      if ($service.State -ne 'Stopped') {
        Stop-Service -Name $serviceName
        (Get-Service -Name $serviceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
      }
      if ($service.StartMode -ne 'Disabled') { Set-Service -Name $serviceName -StartupType Disabled }
      Write-Host '旧 Runner 系统服务已停用。'
    }
  }
  foreach ($listener in @(Get-InstalledRunnerProcess $InstallDir 'Runner.Listener.exe')) {
    $process = Get-Process -Id $listener.ProcessId
    Stop-Process -Id $listener.ProcessId
    if (-not $process.WaitForExit(10000)) { throw '旧 Runner 尚未退出，请稍后重试。' }
  }
  # 官方 run.cmd 退出后，等待原后台启动脚本释放互斥锁。
  $mutex = New-Object System.Threading.Mutex($false, $mutexName)
  try {
    if (-not $mutex.WaitOne(10000)) { throw '旧后台启动脚本尚未退出，请稍后重试。' }
    $mutex.ReleaseMutex()
  } finally {
    $mutex.Dispose()
  }
}

# 下载并校验官方 Runner 安装包，只用于尚未安装的目录。
function Install-RunnerPackage {
  param([string]$InstallDir, [string]$Architecture)
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/actions/runner/releases/latest' -Headers @{
    'Accept' = 'application/vnd.github+json'
    'User-Agent' = 'yibiao-runner-setup'
  }
  $assets = @($release.assets | Where-Object { $_.name -like "actions-runner-win-$Architecture-*.zip" })
  if ($assets.Count -ne 1 -or $assets[0].digest -notmatch '^sha256:[0-9a-f]{64}$') {
    throw '官方发布未提供对应安装包或 SHA-256，安装已停止。'
  }
  $asset = $assets[0]
  $archive = Join-Path ([IO.Path]::GetTempPath()) ('atomgit-runner-' + [Guid]::NewGuid().ToString('N') + '.zip')
  try {
    Write-Host "正在下载 $($asset.name)..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive -UseBasicParsing
    $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $asset.digest.Substring(7)) { throw 'Runner 安装包 SHA-256 不匹配。' }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $InstallDir
  } finally {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  }
}

# 首次安装时注册到 GitHub；不创建 Windows 系统服务。
function Register-Runner {
  param([string]$InstallDir, [string]$Architecture)
  Write-Host ''
  Write-Host "打开：$repoUrl/settings/actions/runners/new"
  Write-Host '选择 Windows，复制 Configure 命令中 --token 后面的临时注册令牌（有效期一小时）。'
  Write-Host '不要输入 AtomGit Token 或 GitHub PAT。'
  $secureToken = Read-Host '粘贴临时注册令牌' -AsSecureString
  try {
    $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    try {
      $registrationToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer).Trim()
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    }
    if (-not $registrationToken) { throw '注册令牌不能为空。' }
    Push-Location -LiteralPath $InstallDir
    try {
      $configArguments = @(
        '--unattended', '--url', $repoUrl, '--token', $registrationToken,
        '--name', "atomgit-$env:COMPUTERNAME-$Architecture", '--labels', 'atomgit-upload', '--work', '_work'
      )
      & .\config.cmd @configArguments
      if ($LASTEXITCODE -ne 0) { throw 'Runner 注册失败，请查看上方输出。' }
    } finally {
      Pop-Location
    }
  } finally {
    $registrationToken = $null
    $secureToken.Dispose()
  }
}

# 生成当前用户后台启动脚本，并更新该用户的登录自启动项。
function Set-RunnerUserStartup {
  param([string]$InstallDir)
  $launcherSource = @'
# 当前 Windows 用户登录后，使用用户环境运行已有的 GitHub Runner。
$ErrorActionPreference = 'Stop'
$runnerRoot = $PSScriptRoot
$statePath = Join-Path $runnerRoot '_diag\user-session-start.json'
$mutex = New-Object System.Threading.Mutex($false, 'Local\YibiaoAtomGitRunner')
$ownsMutex = $false
try {
  # 避免登录自启与手动启动同时拉起同一个 Runner。
  $ownsMutex = $mutex.WaitOne(0)
  if (-not $ownsMutex) { exit 0 }
  $nodeCommand = Get-Command node.exe -ErrorAction Stop
  $gitCommand = Get-Command git.exe -ErrorAction Stop
  $nodeVersion = (& $nodeCommand.Source --version).Trim()
  if ($LASTEXITCODE -ne 0) { throw '当前用户的 Node 无法执行。' }
  $gitVersion = (& $gitCommand.Source --version).Trim()
  if ($LASTEXITCODE -ne 0) { throw '当前用户的 Git 无法执行。' }
  [pscustomobject]@{
    StartedAt = (Get-Date).ToString('o')
    Identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    LauncherPid = $PID
    LauncherParentPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
    NodePath = $nodeCommand.Source
    NodeVersion = $nodeVersion
    GitPath = $gitCommand.Source
    GitVersion = $gitVersion
  } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
  # 官方 run.cmd 负责更新后的重启；统一日志编码并隐藏窗口。
  $startOptions = @{
    FilePath = $env:ComSpec
    ArgumentList = '/d /c "chcp 65001>nul && run.cmd"'
    WorkingDirectory = $runnerRoot
    WindowStyle = 'Hidden'
    Wait = $true
    RedirectStandardOutput = Join-Path $runnerRoot '_diag\user-runner.stdout.log'
    RedirectStandardError = Join-Path $runnerRoot '_diag\user-runner.stderr.log'
  }
  Start-Process @startOptions
} catch {
  [pscustomobject]@{
    FailedAt = (Get-Date).ToString('o')
    Identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    Error = $_.Exception.Message
  } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
  exit 1
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
'@
  $launcherPath = Join-Path $InstallDir 'start-user-runner.ps1'
  New-Item -ItemType Directory -Path (Join-Path $InstallDir '_diag') -Force | Out-Null
  # PowerShell 5.1 读取含中文的脚本需要 UTF-8 BOM。
  [IO.File]::WriteAllText($launcherPath, $launcherSource, [Text.UTF8Encoding]::new($true))
  $powerShellPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherPath + '"'
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  if (-not (Test-Path -LiteralPath $runKey)) { New-Item -Path $runKey -Force | Out-Null }
  New-ItemProperty -LiteralPath $runKey -Name $startupName -Value ('"' + $powerShellPath + '" ' + $arguments) -PropertyType String -Force | Out-Null
  return [pscustomobject]@{Executable=$powerShellPath;Arguments=$arguments}
}

# 从真实桌面进程启动 Runner，避免继承安装程序的管理员或临时环境。
function Start-RunnerFromDesktop {
  param([string]$InstallDir, $Desktop, $Launcher)
  $statePath = Join-Path $InstallDir '_diag\user-session-start.json'
  if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath }
  $Desktop.Document.Application.ShellExecute($Launcher.Executable, $Launcher.Arguments, $InstallDir, 'open', 0)
  $deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 500
    $listener = @(Get-InstalledRunnerProcess $InstallDir 'Runner.Listener.exe')
  } while ($listener.Count -eq 0 -and (Get-Date) -lt $deadline)
  if ($listener.Count -eq 0) {
    $details = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 } else { '未生成启动记录。' }
    throw "Runner 未能启动，请查看 $InstallDir\_diag\user-runner.stderr.log。启动记录：$details"
  }
  $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host "运行账户：$($state.Identity)"
  Write-Host "实际 Node：$($state.NodeVersion)（$($state.NodePath)）"
  Write-Host "实际 Git：$($state.GitVersion)（$($state.GitPath)）"
}

# 安装和停用旧服务需要管理员权限；Runner 始终从当前登录用户的桌面启动。
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '请使用当前登录的 Windows 用户，右键此脚本选择“以管理员身份运行”。'
}
$sessionId = (Get-Process -Id $PID).SessionId
$explorer = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Where-Object { $_.SessionId -eq $sessionId } | Select-Object -First 1
if (-not $explorer -or (Invoke-CimMethod -InputObject $explorer -MethodName GetOwnerSid).Sid -ne $identity.User.Value) {
  throw '请在当前 Windows 用户的桌面中运行，不要使用其他用户的管理员账户。'
}
$shellWindows = (New-Object -ComObject Shell.Application).Windows()
$desktopHandle = 0
$desktop = $shellWindows.FindWindowSW(0, 0, 8, [ref]$desktopHandle, 1)
if (-not $desktop.Document.Application) { throw '未找到当前 Windows 桌面，无法配置用户登录自启动。' }
foreach ($dependency in @('node.exe', 'git.exe')) {
  $command = Get-Command $dependency -ErrorAction SilentlyContinue
  if (-not $command) { throw "当前用户找不到 $dependency，请先安装并确保命令在当前用户的终端中可用。" }
  & $command.Source --version
  if ($LASTEXITCODE -ne 0) { throw "当前用户无法执行 $dependency。" }
}

$installDir = if ($env:ATOMGIT_RUNNER_INSTALL_DIR) {
  [IO.Path]::GetFullPath($env:ATOMGIT_RUNNER_INSTALL_DIR)
} else {
  Join-Path $env:SystemDrive 'actions-runner-yibiao-atomgit'
}
$runnerArch = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
  'X64' { 'x64' }
  'Arm64' { 'arm64' }
  default { throw '此安装脚本支持 Windows x64 和 ARM64。' }
}
Write-Host "目标仓库：$repoUrl"
Write-Host "安装目录：$installDir"

# 已有注册信息只修复启动方式；未注册的完整安装包可以继续完成注册。
$registrationFile = Join-Path $installDir '.runner'
$packageReady = (Test-Path -LiteralPath (Join-Path $installDir 'config.cmd')) -and
  (Test-Path -LiteralPath (Join-Path $installDir 'run.cmd')) -and
  (Test-Path -LiteralPath (Join-Path $installDir 'bin\Runner.Listener.exe'))
if (Test-Path -LiteralPath $registrationFile) {
  $registration = Get-Content -LiteralPath $registrationFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($registration.gitHubUrl.TrimEnd('/') -ne $repoUrl) { throw '此目录的 Runner 属于其他仓库，未修改。' }
  if (-not $packageReady) { throw '已有 Runner 的程序文件不完整，请先检查安装目录。' }
  Write-Host "发现已注册的 Runner：$($registration.agentName)。保留注册信息，修复当前用户启动配置。"
} else {
  if (-not $packageReady) {
    if ((Test-Path -LiteralPath $installDir) -and (Get-ChildItem -LiteralPath $installDir -Force | Select-Object -First 1)) {
      throw '目标目录包含其他文件，请指定空目录或已有 Runner 的安装目录。'
    }
    Install-RunnerPackage $installDir $runnerArch
  }
  Register-Runner $installDir $runnerArch
}
Stop-RunnerForRepair $installDir
$launcher = Set-RunnerUserStartup $installDir
Start-RunnerFromDesktop $installDir $desktop $launcher
Write-Host ''
Write-Host '配置完成：Runner 已在当前用户环境中后台启动，后续登录 Windows 时自动启动。'
Write-Host "请在 $repoUrl/settings/actions/runners 确认状态为 Idle，标签包含 atomgit-upload。"
Write-Host '直接使用当前用户的 Node、Git 和代理配置，不限制 Node 版本，也不会下载 Node。'
Write-Host '电脑需要保持用户登录、联网且不休眠。需要重启 Runner 时，重新运行本脚本即可。'
