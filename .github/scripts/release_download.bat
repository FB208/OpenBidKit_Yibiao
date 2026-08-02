@echo off
setlocal
title Download and upload latest Yibiao release

set "PS1_FILE=%TEMP%\download_yibiao_latest.ps1"
set "ATOMGIT_ENV_FILE=%~dp0.env"

> "%PS1_FILE%" echo $ErrorActionPreference = 'Stop'
>> "%PS1_FILE%" echo $ProgressPreference = 'SilentlyContinue'
>> "%PS1_FILE%" echo [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
>> "%PS1_FILE%" echo $githubRepo = 'FB208/OpenBidKit_Yibiao'
>> "%PS1_FILE%" echo $githubApi = "https://api.github.com/repos/$githubRepo/releases/latest"
>> "%PS1_FILE%" echo $atomOwner = 'FB208'
>> "%PS1_FILE%" echo $atomRepo = 'OpenBidKit_Yibiao'
>> "%PS1_FILE%" echo $atomApiBase = 'https://api.atomgit.com'
>> "%PS1_FILE%" echo $githubHeaders = @{
>> "%PS1_FILE%" echo   'User-Agent' = 'Windows-Release-Downloader'
>> "%PS1_FILE%" echo   'Accept' = 'application/vnd.github+json'
>> "%PS1_FILE%" echo }
>> "%PS1_FILE%" echo function Read-AtomGitToken {
>> "%PS1_FILE%" echo   param([string]$EnvFile)
>> "%PS1_FILE%" echo   if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
>> "%PS1_FILE%" echo     throw "AtomGit config file not found: $EnvFile"
>> "%PS1_FILE%" echo   }
>> "%PS1_FILE%" echo   foreach ($rawLine in Get-Content -LiteralPath $EnvFile -Encoding UTF8) {
>> "%PS1_FILE%" echo     $line = $rawLine.Trim()
>> "%PS1_FILE%" echo     if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
>> "%PS1_FILE%" echo     $separatorIndex = $line.IndexOf('=')
>> "%PS1_FILE%" echo     if ($separatorIndex -lt 0) { continue }
>> "%PS1_FILE%" echo     $key = $line.Substring(0, $separatorIndex).Trim()
>> "%PS1_FILE%" echo     if ($key -ne 'ATOMGIT_TOKEN') { continue }
>> "%PS1_FILE%" echo     $value = $line.Substring($separatorIndex + 1).Trim()
>> "%PS1_FILE%" echo     if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"))) {
>> "%PS1_FILE%" echo       $value = $value.Substring(1, $value.Length - 2)
>> "%PS1_FILE%" echo     }
>> "%PS1_FILE%" echo     if ([string]::IsNullOrWhiteSpace($value)) { throw 'ATOMGIT_TOKEN cannot be empty.' }
>> "%PS1_FILE%" echo     return $value
>> "%PS1_FILE%" echo   }
>> "%PS1_FILE%" echo   throw 'ATOMGIT_TOKEN is missing from the AtomGit config file.'
>> "%PS1_FILE%" echo }
>> "%PS1_FILE%" echo function Get-AssetContentType {
>> "%PS1_FILE%" echo   param([string]$FileName)
>> "%PS1_FILE%" echo   switch ([IO.Path]::GetExtension($FileName).ToLowerInvariant()) {
>> "%PS1_FILE%" echo     '.exe' { return 'application/vnd.microsoft.portable-executable' }
>> "%PS1_FILE%" echo     '.zip' { return 'application/zip' }
>> "%PS1_FILE%" echo     '.dmg' { return 'application/x-apple-diskimage' }
>> "%PS1_FILE%" echo     '.yml' { return 'application/yaml' }
>> "%PS1_FILE%" echo     '.yaml' { return 'application/yaml' }
>> "%PS1_FILE%" echo     default { return 'application/octet-stream' }
>> "%PS1_FILE%" echo   }
>> "%PS1_FILE%" echo }
>> "%PS1_FILE%" echo function Upload-AtomGitAsset {
>> "%PS1_FILE%" echo   param([string]$FilePath, [string]$Tag, [hashtable]$ApiHeaders)
>> "%PS1_FILE%" echo   $fileName = [IO.Path]::GetFileName($FilePath)
>> "%PS1_FILE%" echo   $encodedOwner = [Uri]::EscapeDataString($atomOwner)
>> "%PS1_FILE%" echo   $encodedRepo = [Uri]::EscapeDataString($atomRepo)
>> "%PS1_FILE%" echo   $encodedTag = [Uri]::EscapeDataString($Tag)
>> "%PS1_FILE%" echo   $encodedFileName = [Uri]::EscapeDataString($fileName)
>> "%PS1_FILE%" echo   $uploadApi = "$atomApiBase/api/v5/repos/$encodedOwner/$encodedRepo/releases/$encodedTag/upload_url?file_name=$encodedFileName"
>> "%PS1_FILE%" echo   Write-Host "Getting AtomGit upload URL: $fileName"
>> "%PS1_FILE%" echo   $uploadTarget = Invoke-RestMethod -Uri $uploadApi -Method Get -Headers $ApiHeaders
>> "%PS1_FILE%" echo   if ([string]::IsNullOrWhiteSpace([string]$uploadTarget.url)) {
>> "%PS1_FILE%" echo     throw "AtomGit did not return an upload URL for $fileName."
>> "%PS1_FILE%" echo   }
>> "%PS1_FILE%" echo   $uploadHeaders = @{}
>> "%PS1_FILE%" echo   if ($null -ne $uploadTarget.headers) {
>> "%PS1_FILE%" echo     foreach ($property in $uploadTarget.headers.PSObject.Properties) {
>> "%PS1_FILE%" echo       $uploadHeaders[$property.Name] = [string]$property.Value
>> "%PS1_FILE%" echo     }
>> "%PS1_FILE%" echo   }
>> "%PS1_FILE%" echo   $contentType = Get-AssetContentType -FileName $fileName
>> "%PS1_FILE%" echo   if ($uploadHeaders.ContainsKey('Content-Type')) {
>> "%PS1_FILE%" echo     $contentType = $uploadHeaders['Content-Type']
>> "%PS1_FILE%" echo     $uploadHeaders.Remove('Content-Type')
>> "%PS1_FILE%" echo   }
>> "%PS1_FILE%" echo   Write-Host "Uploading to AtomGit: $fileName"
>> "%PS1_FILE%" echo   Invoke-WebRequest -Uri $uploadTarget.url -Method Put -Headers $uploadHeaders -ContentType $contentType -InFile $FilePath -UseBasicParsing ^| Out-Null
>> "%PS1_FILE%" echo }
>> "%PS1_FILE%" echo $atomToken = Read-AtomGitToken -EnvFile $env:ATOMGIT_ENV_FILE
>> "%PS1_FILE%" echo $atomApiHeaders = @{
>> "%PS1_FILE%" echo   'Accept' = 'application/json'
>> "%PS1_FILE%" echo   'Authorization' = "Bearer $atomToken"
>> "%PS1_FILE%" echo }
>> "%PS1_FILE%" echo Write-Host 'Fetching latest GitHub release...'
>> "%PS1_FILE%" echo $release = Invoke-RestMethod -Uri $githubApi -Headers $githubHeaders
>> "%PS1_FILE%" echo $tag = $release.tag_name
>> "%PS1_FILE%" echo $out = Join-Path (Get-Location) "Yibiao-$tag"
>> "%PS1_FILE%" echo New-Item -ItemType Directory -Force -Path $out ^| Out-Null
>> "%PS1_FILE%" echo Write-Host "Latest version: $tag"
>> "%PS1_FILE%" echo if (-not $release.assets -or $release.assets.Count -eq 0) {
>> "%PS1_FILE%" echo   throw 'No GitHub release assets found.'
>> "%PS1_FILE%" echo }
>> "%PS1_FILE%" echo $downloadedFiles = @()
>> "%PS1_FILE%" echo foreach ($asset in $release.assets) {
>> "%PS1_FILE%" echo   $file = Join-Path $out $asset.name
>> "%PS1_FILE%" echo   Write-Host "Downloading: $($asset.name)"
>> "%PS1_FILE%" echo   Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -Headers $githubHeaders -UseBasicParsing
>> "%PS1_FILE%" echo   $downloadedFiles += $file
>> "%PS1_FILE%" echo }
>> "%PS1_FILE%" echo Write-Host ''
>> "%PS1_FILE%" echo Write-Host 'All GitHub release assets downloaded. Starting AtomGit upload...'
>> "%PS1_FILE%" echo foreach ($file in $downloadedFiles) {
>> "%PS1_FILE%" echo   Upload-AtomGitAsset -FilePath $file -Tag $tag -ApiHeaders $atomApiHeaders
>> "%PS1_FILE%" echo }
>> "%PS1_FILE%" echo Write-Host ''
>> "%PS1_FILE%" echo Write-Host "Done. Save path: $out"
>> "%PS1_FILE%" echo Write-Host "AtomGit release: https://atomgit.com/$atomOwner/$atomRepo/releases/$tag"

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_FILE%"
set "EXIT_CODE=%ERRORLEVEL%"
del /q "%PS1_FILE%" >nul 2>&1

echo.
if not "%EXIT_CODE%"=="0" echo Release download or AtomGit upload failed.
pause
exit /b %EXIT_CODE%
