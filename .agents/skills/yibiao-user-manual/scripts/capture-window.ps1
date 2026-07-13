[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [int]$ProcessId = 0,

  [Parameter(Mandatory = $true)]
  [string]$WindowTitlePattern,

  [ValidateRange(0, 10000)]
  [int]$DelayMilliseconds = 1500
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

if (-not ('YibiaoManual.NativeWindow' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace YibiaoManual {
  [StructLayout(LayoutKind.Sequential)]
  public struct NativeRect {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  public static class NativeWindow {
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out NativeRect rect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out NativeRect rect, int size);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  }
}
'@
}

function Get-VisibleCandidates {
  param([string]$Pattern)

  return @(Get-Process | Where-Object {
      $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$Pattern*"
    })
}

try {
  [void][YibiaoManual.NativeWindow]::SetProcessDpiAwarenessContext([IntPtr](-4))
} catch {
  # Older Windows versions may not expose per-monitor-v2 awareness. Continue with the current context.
}

$process = $null

if ($ProcessId -gt 0) {
  $process = Get-Process -Id $ProcessId -ErrorAction Stop
  if ($process.MainWindowHandle -eq 0) {
    throw "Process $ProcessId has no visible main window."
  }
} else {
  $candidates = @(Get-VisibleCandidates -Pattern $WindowTitlePattern)
  if ($candidates.Count -gt 1) {
    $candidateText = ($candidates | ForEach-Object { "PID=$($_.Id), Title=$($_.MainWindowTitle)" }) -join '; '
    throw "Multiple matching windows found. Use -ProcessId to select one: $candidateText"
  }
  if ($candidates.Count -eq 1) {
    $process = $candidates[0]
  }
}

if ($null -eq $process) {
  throw "No release window matched '$WindowTitlePattern'. Open and activate the release app with Windows app control first; ask the user when its path is unknown."
}

$handle = [IntPtr]$process.MainWindowHandle
if ($DelayMilliseconds -gt 0) {
  Start-Sleep -Milliseconds $DelayMilliseconds
}

$process.Refresh()
$handle = [IntPtr]$process.MainWindowHandle
$rect = New-Object YibiaoManual.NativeRect
$rectSize = [Runtime.InteropServices.Marshal]::SizeOf([type][YibiaoManual.NativeRect])
$dwmResult = [YibiaoManual.NativeWindow]::DwmGetWindowAttribute($handle, 9, [ref]$rect, $rectSize)
if ($dwmResult -ne 0) {
  if (-not [YibiaoManual.NativeWindow]::GetWindowRect($handle, [ref]$rect)) {
    throw 'Unable to read the release window bounds.'
  }
}

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
  throw "Invalid release window size: ${width}x${height}."
}

$fullOutputPath = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = [IO.Path]::GetDirectoryName($fullOutputPath)
if (-not [string]::IsNullOrWhiteSpace($outputDirectory)) {
  [void](New-Item -ItemType Directory -Path $outputDirectory -Force)
}

$bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $hdc = $graphics.GetHdc()
  try {
    $printed = [YibiaoManual.NativeWindow]::PrintWindow($handle, $hdc, 2)
  } finally {
    $graphics.ReleaseHdc($hdc)
  }
  if (-not $printed) {
    throw 'PrintWindow failed to capture the target release window.'
  }
  $bitmap.Save($fullOutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}

[pscustomobject]@{
  output_path = $fullOutputPath
  process_id = $process.Id
  window_title = $process.MainWindowTitle
  width = $width
  height = $height
}
