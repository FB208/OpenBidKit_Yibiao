<# 
.SYNOPSIS
    Sync .env.secrets to GitHub Secrets

.DESCRIPTION
    Read .env.secrets file and sync all key-value pairs to GitHub Secrets using gh CLI.

.EXAMPLE
    .\.github\scripts\sync-secrets.ps1
#>

$ErrorActionPreference = "Stop"

# Get project root directory
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$EnvFile = Join-Path $ProjectRoot ".env.secrets"

# Check if .env.secrets exists
if (-not (Test-Path $EnvFile)) {
    Write-Host "[ERROR] .env.secrets not found" -ForegroundColor Red
    Write-Host "        Please copy .env.secrets.example to .env.secrets and fill in the values" -ForegroundColor Yellow
    exit 1
}

# Check if gh is installed
try {
    $null = Get-Command gh -ErrorAction Stop
} catch {
    Write-Host "[ERROR] GitHub CLI (gh) not installed" -ForegroundColor Red
    Write-Host "        Run: winget install GitHub.cli" -ForegroundColor Yellow
    exit 1
}

# Check if gh is logged in
$authStatus = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] GitHub CLI not logged in" -ForegroundColor Red
    Write-Host "        Run: gh auth login" -ForegroundColor Yellow
    exit 1
}

Write-Host "[INFO] Reading config: $EnvFile" -ForegroundColor Cyan
Write-Host ""

# Read and parse .env.secrets
$secrets = @{}
Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    # Skip empty lines and comments
    if ($line -and -not $line.StartsWith("#")) {
        $eqIndex = $line.IndexOf("=")
        if ($eqIndex -gt 0) {
            $key = $line.Substring(0, $eqIndex).Trim()
            $value = $line.Substring($eqIndex + 1).Trim()
            $secrets[$key] = $value
        }
    }
}

if ($secrets.Count -eq 0) {
    Write-Host "[WARN] No valid config found in file" -ForegroundColor Yellow
    exit 0
}

Write-Host "[INFO] Syncing $($secrets.Count) secrets to GitHub..." -ForegroundColor Cyan
Write-Host ""

$successCount = 0
$failCount = 0

foreach ($key in $secrets.Keys) {
    $value = $secrets[$key]
    Write-Host "   Setting $key ... " -NoNewline
    
    try {
        # Use pipeline to pass value, avoid exposing secrets in command line
        $value | gh secret set $key 2>&1 | Out-Null
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK]" -ForegroundColor Green
            $successCount++
        } else {
            Write-Host "[FAIL]" -ForegroundColor Red
            $failCount++
        }
    } catch {
        Write-Host "[FAIL] $_" -ForegroundColor Red
        $failCount++
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Gray
if ($failCount -eq 0) {
    Write-Host "[DONE] Successfully synced $successCount secrets" -ForegroundColor Green
} else {
    Write-Host "[DONE] Success: $successCount, Failed: $failCount" -ForegroundColor Yellow
}

# Show current secrets list
Write-Host ""
Write-Host "[INFO] Current repository secrets:" -ForegroundColor Cyan
gh secret list
