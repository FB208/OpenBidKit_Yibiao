[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ManualRoot,

  [string[]]$Scope = @(),

  [int]$ExpectedConfigDocs = -1,

  [int]$ExpectedUsageDocs = -1,

  [int]$ExpectedImageRefs = -1,

  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$root = (Resolve-Path -LiteralPath $ManualRoot -ErrorAction Stop).Path.TrimEnd([IO.Path]::DirectorySeparatorChar)
$configName = -join @([char]0x914D, [char]0x7F6E)
$usageName = -join @([char]0x4F7F, [char]0x7528)
$annotatedName = -join @([char]0x6807, [char]0x6CE8)
$configDirectory = Join-Path $root $configName
$usageDirectory = Join-Path $root $usageName
$imageDirectory = Join-Path $root 'images'
$annotatedDirectory = Join-Path $imageDirectory $annotatedName
$issues = New-Object System.Collections.Generic.List[object]
$normalizedScopes = @($Scope | ForEach-Object { $_.Replace('/', '\').TrimStart('\').TrimEnd('\') } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

function Get-RelativePath {
  param([string]$Path)
  $fullPath = [IO.Path]::GetFullPath($Path)
  if ($fullPath -eq $root) {
    return ''
  }
  return $fullPath.Substring($root.Length + 1)
}

function Test-InScope {
  param([string]$RelativePath)
  if ($normalizedScopes.Count -eq 0) {
    return $true
  }
  foreach ($scopeItem in $normalizedScopes) {
    if ($RelativePath -eq $scopeItem -or $RelativePath.StartsWith("$scopeItem\", [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Add-Issue {
  param(
    [string]$Code,
    [string]$Path,
    [string]$Message,
    [bool]$InScope,
    [string]$Severity = 'error'
  )
  $issues.Add([pscustomobject]@{
      code = $Code
      path = $Path
      message = $Message
      in_scope = $InScope
      severity = $Severity
    })
}

foreach ($requiredDirectory in @($configDirectory, $usageDirectory, $imageDirectory, $annotatedDirectory)) {
  if (-not (Test-Path -LiteralPath $requiredDirectory -PathType Container)) {
    Add-Issue 'missing-directory' (Get-RelativePath $requiredDirectory) 'A required manual directory is missing.' ($normalizedScopes.Count -eq 0)
  }
}

$rootFiles = @(Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue)
foreach ($file in $rootFiles) {
  Add-Issue 'root-file' $file.Name 'The manual root must not contain an index or other files.' ($normalizedScopes.Count -eq 0)
}

$configDocs = if (Test-Path -LiteralPath $configDirectory) { @(Get-ChildItem -LiteralPath $configDirectory -Filter *.md -File) } else { @() }
$usageDocs = if (Test-Path -LiteralPath $usageDirectory) { @(Get-ChildItem -LiteralPath $usageDirectory -Filter *.md -File) } else { @() }
$markdownFiles = @($configDocs) + @($usageDocs)

if ($normalizedScopes.Count -eq 0) {
  if ($ExpectedConfigDocs -ge 0 -and $configDocs.Count -ne $ExpectedConfigDocs) {
    Add-Issue 'config-count' $configName "Expected $ExpectedConfigDocs configuration documents; got $($configDocs.Count)." $true
  }
  if ($ExpectedUsageDocs -ge 0 -and $usageDocs.Count -ne $ExpectedUsageDocs) {
    Add-Issue 'usage-count' $usageName "Expected $ExpectedUsageDocs usage documents; got $($usageDocs.Count)." $true
  }
}

$imageReferenceCount = 0
$checkedImages = @{}
$localLinkPattern = '(?<!\!)\[[^\]]+\]\((?<target>[^)]+)\)'
$imageLinkPattern = '!\[[^\]]*\]\((?<target>[^)]+)\)'
$navigationPattern = '\u8FD4\u56DE\u603B\u76EE\u5F55|\u4E0A\u4E00\u7BC7|\u4E0B\u4E00\u7BC7|\u5F00\u59CB\u4F7F\u7528|\u603B\u76EE\u5F55'

foreach ($file in $markdownFiles) {
  $relativeFile = Get-RelativePath $file.FullName
  $inScope = Test-InScope $relativeFile
  $content = Get-Content -LiteralPath $file.FullName -Encoding utf8 -Raw

  if ([regex]::IsMatch($content, $navigationPattern)) {
    Add-Issue 'navigation' $relativeFile 'Found a root-index or previous/next navigation label.' $inScope
  }
  if ([regex]::IsMatch($content, '(?m)[ \t]+$')) {
    Add-Issue 'trailing-whitespace' $relativeFile 'Found trailing whitespace.' $inScope
  }

  foreach ($match in [regex]::Matches($content, $imageLinkPattern)) {
    $imageReferenceCount += 1
    $rawTarget = $match.Groups['target'].Value.Trim()
    if ($rawTarget.StartsWith('<') -and $rawTarget.EndsWith('>')) {
      $rawTarget = $rawTarget.Substring(1, $rawTarget.Length - 2)
    }
    $decodedTarget = [Uri]::UnescapeDataString($rawTarget).Replace('/', '\')
    $resolvedTarget = [IO.Path]::GetFullPath((Join-Path $file.DirectoryName $decodedTarget))
    $relativeTarget = Get-RelativePath $resolvedTarget
    if (-not (Test-Path -LiteralPath $resolvedTarget -PathType Leaf)) {
      Add-Issue 'missing-image' $relativeFile "Image does not exist: $rawTarget" $inScope
      continue
    }

    $annotatedPrefix = [IO.Path]::GetFullPath($annotatedDirectory).TrimEnd('\') + '\'
    if (-not $resolvedTarget.StartsWith($annotatedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      Add-Issue 'unannotated-reference' $relativeFile "Documents must reference screenshots under images/annotated: $rawTarget" $inScope
    }

    if (-not $checkedImages.ContainsKey($resolvedTarget)) {
      $checkedImages[$resolvedTarget] = $true
      $annotated = $null
      $original = $null
      try {
        $annotated = [System.Drawing.Image]::FromFile($resolvedTarget)
        if ($annotated.RawFormat.Guid -ne [System.Drawing.Imaging.ImageFormat]::Png.Guid) {
          Add-Issue 'not-png' $relativeTarget 'The annotated screenshot is not a valid PNG.' $inScope
        }
        if ($annotated.Width -lt 1600 -or $annotated.Height -lt 900) {
          Add-Issue 'low-resolution' $relativeTarget "Annotated screenshot resolution is too low: $($annotated.Width)x$($annotated.Height)." $inScope
        }

        $originalPath = Join-Path $imageDirectory ([IO.Path]::GetFileName($resolvedTarget))
        if (-not (Test-Path -LiteralPath $originalPath -PathType Leaf)) {
          Add-Issue 'missing-original' $relativeTarget 'The same-name original screenshot is missing.' $inScope
        } else {
          $original = [System.Drawing.Image]::FromFile($originalPath)
          if ($original.Width -ne $annotated.Width -or $original.Height -ne $annotated.Height) {
            Add-Issue 'dimension-mismatch' $relativeTarget "Annotated size $($annotated.Width)x$($annotated.Height) differs from original size $($original.Width)x$($original.Height)." $inScope
          }
        }
      } catch {
        Add-Issue 'invalid-image' $relativeTarget "Image cannot be read: $($_.Exception.Message)" $inScope
      } finally {
        if ($null -ne $original) { $original.Dispose() }
        if ($null -ne $annotated) { $annotated.Dispose() }
      }
    }
  }

  foreach ($match in [regex]::Matches($content, $localLinkPattern)) {
    $rawTarget = $match.Groups['target'].Value.Trim()
    if ($rawTarget -match '^(https?://|mailto:|#)') {
      continue
    }
    if ($rawTarget.StartsWith('<') -and $rawTarget.EndsWith('>')) {
      $rawTarget = $rawTarget.Substring(1, $rawTarget.Length - 2)
    }
    $pathOnly = ($rawTarget -split '#', 2)[0]
    if ([string]::IsNullOrWhiteSpace($pathOnly)) {
      continue
    }
    $resolvedTarget = [IO.Path]::GetFullPath((Join-Path $file.DirectoryName ([Uri]::UnescapeDataString($pathOnly).Replace('/', '\'))))
    if (-not (Test-Path -LiteralPath $resolvedTarget)) {
      Add-Issue 'missing-link' $relativeFile "Local link does not exist: $rawTarget" $inScope
    }
  }
}

if ($normalizedScopes.Count -eq 0 -and $ExpectedImageRefs -ge 0 -and $imageReferenceCount -ne $ExpectedImageRefs) {
  Add-Issue 'image-ref-count' '.' "Expected $ExpectedImageRefs image references; got $imageReferenceCount." $true
}

$blockingIssues = @($issues | Where-Object { $_.severity -eq 'error' -and $_.in_scope })
$outOfScopeIssues = @($issues | Where-Object { -not $_.in_scope })
$result = [pscustomobject]@{
  success = $blockingIssues.Count -eq 0
  manual_root = $root
  scope = [string[]]$normalizedScopes
  config_docs = $configDocs.Count
  usage_docs = $usageDocs.Count
  image_references = $imageReferenceCount
  checked_images = $checkedImages.Count
  blocking_issues = $blockingIssues.Count
  out_of_scope_issues = $outOfScopeIssues.Count
  issues = $issues.ToArray()
}

if ($Json) {
  $result | ConvertTo-Json -Depth 6
} else {
  $result | Select-Object success, manual_root, scope, config_docs, usage_docs, image_references, checked_images, blocking_issues, out_of_scope_issues | Format-List
  foreach ($issue in $issues) {
    $label = if ($issue.in_scope) { 'ERROR' } else { 'OUT-OF-SCOPE' }
    Write-Host "[$label][$($issue.code)] $($issue.path): $($issue.message)"
  }
}

if (-not $result.success) {
  exit 1
}
