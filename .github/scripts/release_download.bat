@echo off
setlocal
title Download latest Yibiao release

set "PS1_FILE=%TEMP%\download_yibiao_latest.ps1"

> "%PS1_FILE%" echo $ErrorActionPreference = 'Stop'
>> "%PS1_FILE%" echo $ProgressPreference = 'SilentlyContinue'
>> "%PS1_FILE%" echo [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
>> "%PS1_FILE%" echo $repo = 'FB208/OpenBidKit_Yibiao'
>> "%PS1_FILE%" echo $api = "https://api.github.com/repos/$repo/releases/latest"
>> "%PS1_FILE%" echo $headers = @{
>> "%PS1_FILE%" echo   'User-Agent' = 'Windows-Release-Downloader'
>> "%PS1_FILE%" echo   'Accept' = 'application/vnd.github+json'
>> "%PS1_FILE%" echo }
>> "%PS1_FILE%" echo Write-Host 'Fetching latest release...'
>> "%PS1_FILE%" echo $release = Invoke-RestMethod -Uri $api -Headers $headers
>> "%PS1_FILE%" echo $tag = $release.tag_name
>> "%PS1_FILE%" echo $out = Join-Path (Get-Location) "Yibiao-$tag"
>> "%PS1_FILE%" echo New-Item -ItemType Directory -Force -Path $out ^| Out-Null
>> "%PS1_FILE%" echo Write-Host "Latest version: $tag"
>> "%PS1_FILE%" echo if (-not $release.assets -or $release.assets.Count -eq 0) {
>> "%PS1_FILE%" echo   Write-Host 'No release assets found.'
>> "%PS1_FILE%" echo   exit 1
>> "%PS1_FILE%" echo }
>> "%PS1_FILE%" echo foreach ($asset in $release.assets) {
>> "%PS1_FILE%" echo   $file = Join-Path $out $asset.name
>> "%PS1_FILE%" echo   Write-Host "Downloading: $($asset.name)"
>> "%PS1_FILE%" echo   Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -Headers $headers
>> "%PS1_FILE%" echo }
>> "%PS1_FILE%" echo Write-Host ''
>> "%PS1_FILE%" echo Write-Host "Done. Save path: $out"

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_FILE%"

echo.
pause