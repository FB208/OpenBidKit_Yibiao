[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ManualRoot,

  [string[]]$Scope = @(),

  [int]$ExpectedConfigDocs = -1,

  [int]$ExpectedUsageDocs = -1,

  [int]$ExpectedImageRefs = -1,

  [switch]$Json,

  [switch]$ValidateChangelog,

  [string]$ChangelogBaselineVersion = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$root = (Resolve-Path -LiteralPath $ManualRoot -ErrorAction Stop).Path.TrimEnd([IO.Path]::DirectorySeparatorChar)
$configName = -join @([char]0x914D, [char]0x7F6E)
$usageName = -join @([char]0x4F7F, [char]0x7528)
$annotatedName = -join @([char]0x6807, [char]0x6CE8)
$releaseNotesName = 'v2' + (-join @([char]0x7248, [char]0x672C, [char]0x66F4, [char]0x65B0, [char]0x65E5, [char]0x5FD7)) + '.md'
$releaseNotesTitle = -join @(
  [char]0x6613, [char]0x6807, [char]0x6295, [char]0x6807, [char]0x5DE5, [char]0x5177, [char]0x7BB1,
  [char]0x7248, [char]0x672C, [char]0x66F4, [char]0x65B0, [char]0x65E5, [char]0x5FD7
)
$newCategory = -join @([char]0x65B0, [char]0x589E)
$improvedCategory = -join @([char]0x4F18, [char]0x5316)
$fixedCategory = -join @([char]0x4FEE, [char]0x590D)
$changedCategory = -join @([char]0x8C03, [char]0x6574)
$releaseNoteCategories = @($newCategory, $improvedCategory, $fixedCategory, $changedCategory)
$sentencePeriod = [string][char]0x3002
$configDirectory = Join-Path $root $configName
$usageDirectory = Join-Path $root $usageName
$imageDirectory = Join-Path $root 'images'
$annotatedDirectory = Join-Path $imageDirectory $annotatedName
$releaseNotesPath = Join-Path $root $releaseNotesName
$issues = New-Object System.Collections.Generic.List[object]
$normalizedScopes = @($Scope | ForEach-Object { $_.Replace('/', '\').TrimStart('\').TrimEnd('\') } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$changelogOnly = $ValidateChangelog -and $normalizedScopes.Count -eq 1 -and $normalizedScopes[0] -eq $releaseNotesName

# Convert an absolute path under the manual root to a relative path.
function Get-RelativePath {
  param([string]$Path)
  $fullPath = [IO.Path]::GetFullPath($Path)
  if ($fullPath -eq $root) {
    return ''
  }
  return $fullPath.Substring($root.Length + 1)
}

# Decide whether a relative manual path belongs to the requested validation scope.
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

# Add a structured issue to the validation result.
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

if (-not $changelogOnly) {
  foreach ($requiredDirectory in @($configDirectory, $usageDirectory, $imageDirectory, $annotatedDirectory)) {
    if (-not (Test-Path -LiteralPath $requiredDirectory -PathType Container)) {
      Add-Issue 'missing-directory' (Get-RelativePath $requiredDirectory) 'A required manual directory is missing.' ($normalizedScopes.Count -eq 0)
    }
  }
}

$rootFiles = @(Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue)
foreach ($file in $rootFiles) {
  if ($file.Name -ne $releaseNotesName) {
    Add-Issue 'root-file' $file.Name 'Only the v2 release notes file is allowed in the manual root.' (Test-InScope $file.Name)
  }
}

$configDocs = @()
if (Test-Path -LiteralPath $configDirectory) {
  $configDocs = @(Get-ChildItem -LiteralPath $configDirectory -Filter *.md -File)
}
$usageDocs = @()
if (Test-Path -LiteralPath $usageDirectory) {
  $usageDocs = @(Get-ChildItem -LiteralPath $usageDirectory -Filter *.md -File)
}
$markdownFiles = if ($changelogOnly) { @() } else { @($configDocs) + @($usageDocs) }

if (-not $changelogOnly -and $normalizedScopes.Count -eq 0) {
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

# Validate the release notes only when the caller explicitly selects that task.
if ($ValidateChangelog) {
  $releaseNotesInScope = Test-InScope $releaseNotesName
  $baselineVersionValue = $null
  if (-not [string]::IsNullOrWhiteSpace($ChangelogBaselineVersion)) {
    $baselineMatch = [regex]::Match($ChangelogBaselineVersion, '^v2\.(\d+)\.(\d+)$')
    if (-not $baselineMatch.Success) {
      Add-Issue 'release-baseline-format' $releaseNotesName 'The changelog baseline version is invalid.' $releaseNotesInScope
    } else {
      $baselineVersionValue = [version]::Parse("2.$($baselineMatch.Groups[1].Value).$($baselineMatch.Groups[2].Value)")
    }
  }

  if (-not (Test-Path -LiteralPath $releaseNotesPath -PathType Leaf)) {
    Add-Issue 'missing-release-notes' $releaseNotesName 'The v2 release notes file is missing.' $releaseNotesInScope
  } else {
    $releaseContent = Get-Content -LiteralPath $releaseNotesPath -Encoding utf8 -Raw
    $releaseLines = @($releaseContent -split '\r?\n')

    if ($releaseLines.Count -eq 0 -or $releaseLines[0] -ne "# $releaseNotesTitle") {
      Add-Issue 'release-title' $releaseNotesName 'The release notes must start with the required product title.' $releaseNotesInScope
    }
    if ([regex]::IsMatch($releaseContent, '(?m)[ \t]+$')) {
      Add-Issue 'release-trailing-whitespace' $releaseNotesName 'Found trailing whitespace in the release notes.' $releaseNotesInScope
    }

    $seenVersions = @{}
    $releaseVersions = New-Object System.Collections.Generic.List[object]
    $currentVersion = $null
    $currentVersionLine = 0
    $currentVersionCategoryCount = 0
    $enforceCurrentVersionCategoryOrder = $true
    $currentCategory = $null
    $currentCategoryLine = 0
    $currentCategoryBulletCount = 0
    $seenCategories = @{}
    $lastCategoryIndex = -1

    for ($index = 1; $index -lt $releaseLines.Count; $index += 1) {
      $line = $releaseLines[$index]
      $lineNumber = $index + 1
      if ([string]::IsNullOrWhiteSpace($line)) {
        continue
      }

      if ($line.StartsWith('## ')) {
        if ($null -ne $currentCategory -and $currentCategoryBulletCount -eq 0) {
          Add-Issue 'release-empty-category' $releaseNotesName "Category at line $currentCategoryLine has no list items." $releaseNotesInScope
        }
        if ($null -ne $currentVersion -and $currentVersionCategoryCount -eq 0) {
          Add-Issue 'release-empty-version' $releaseNotesName "Version at line $currentVersionLine has no valid categories." $releaseNotesInScope
        }

        $currentVersion = $null
        $currentVersionLine = $lineNumber
        $currentVersionCategoryCount = 0
        $enforceCurrentVersionCategoryOrder = $true
        $currentCategory = $null
        $currentCategoryLine = 0
        $currentCategoryBulletCount = 0
        $seenCategories = @{}
        $lastCategoryIndex = -1

        $versionMatch = [regex]::Match($line, '^## (v2\.(\d+)\.(\d+))$')
        if (-not $versionMatch.Success) {
          Add-Issue 'release-version-format' $releaseNotesName "Invalid version heading at line $lineNumber." $releaseNotesInScope
          continue
        }

        $versionText = $versionMatch.Groups[1].Value
        $versionValue = [version]::Parse("2.$($versionMatch.Groups[2].Value).$($versionMatch.Groups[3].Value)")
        $enforceCurrentVersionCategoryOrder = $null -eq $baselineVersionValue -or $versionValue.CompareTo($baselineVersionValue) -gt 0
        if ($seenVersions.ContainsKey($versionText)) {
          Add-Issue 'release-duplicate-version' $releaseNotesName "Duplicate version $versionText at line $lineNumber." $releaseNotesInScope
        } else {
          $seenVersions[$versionText] = $true
        }
        if ($releaseVersions.Count -gt 0 -and $releaseVersions[$releaseVersions.Count - 1].value.CompareTo($versionValue) -le 0) {
          Add-Issue 'release-version-order' $releaseNotesName "Version $versionText at line $lineNumber is not in descending order." $releaseNotesInScope
        }
        $releaseVersions.Add([pscustomobject]@{ text = $versionText; value = $versionValue; line = $lineNumber })
        $currentVersion = $versionText
        continue
      }

      if ($line.StartsWith('### ')) {
        if ($null -ne $currentCategory -and $currentCategoryBulletCount -eq 0) {
          Add-Issue 'release-empty-category' $releaseNotesName "Category at line $currentCategoryLine has no list items." $releaseNotesInScope
        }

        $currentCategory = $line.Substring(4).Trim()
        $currentCategoryLine = $lineNumber
        $currentCategoryBulletCount = 0
        if ($null -eq $currentVersion) {
          Add-Issue 'release-category-without-version' $releaseNotesName "Category at line $lineNumber is not under a valid version." $releaseNotesInScope
          continue
        }

        $categoryIndex = [array]::IndexOf($releaseNoteCategories, $currentCategory)
        if ($categoryIndex -lt 0) {
          Add-Issue 'release-category-name' $releaseNotesName "Invalid category at line $lineNumber." $releaseNotesInScope
          continue
        }
        $currentVersionCategoryCount += 1
        if ($seenCategories.ContainsKey($currentCategory)) {
          Add-Issue 'release-duplicate-category' $releaseNotesName "Duplicate category at line $lineNumber." $releaseNotesInScope
        } else {
          $seenCategories[$currentCategory] = $true
        }
        if ($enforceCurrentVersionCategoryOrder -and $categoryIndex -le $lastCategoryIndex) {
          Add-Issue 'release-category-order' $releaseNotesName "Category at line $lineNumber is out of order." $releaseNotesInScope
        }
        $lastCategoryIndex = $categoryIndex
        continue
      }

      if ($line.StartsWith('- ')) {
        if ($null -eq $currentVersion -or $null -eq $currentCategory) {
          Add-Issue 'release-list-position' $releaseNotesName "List item at line $lineNumber is not under a category." $releaseNotesInScope
          continue
        }
        $currentCategoryBulletCount += 1
        $bulletText = $line.Substring(2).Trim()
        if ([string]::IsNullOrWhiteSpace($bulletText) -or -not $bulletText.EndsWith($sentencePeriod)) {
          Add-Issue 'release-list-style' $releaseNotesName "List item at line $lineNumber must be a non-empty sentence ending with a Chinese period." $releaseNotesInScope
        }
        continue
      }

      Add-Issue 'release-content-format' $releaseNotesName "Unsupported content at line $lineNumber." $releaseNotesInScope
    }

    if ($null -ne $currentCategory -and $currentCategoryBulletCount -eq 0) {
      Add-Issue 'release-empty-category' $releaseNotesName "Category at line $currentCategoryLine has no list items." $releaseNotesInScope
    }
    if ($null -ne $currentVersion -and $currentVersionCategoryCount -eq 0) {
      Add-Issue 'release-empty-version' $releaseNotesName "Version at line $currentVersionLine has no valid categories." $releaseNotesInScope
    }
    if ($null -ne $baselineVersionValue -and -not $seenVersions.ContainsKey($ChangelogBaselineVersion)) {
      Add-Issue 'release-baseline-missing' $releaseNotesName 'The changelog baseline version does not exist in the release notes.' $releaseNotesInScope
    }
    if ($releaseVersions.Count -eq 0) {
      Add-Issue 'release-missing-version' $releaseNotesName 'The release notes contain no valid v2 version headings.' $releaseNotesInScope
    }
  }
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
  release_notes_checked = [bool]$ValidateChangelog
  blocking_issues = $blockingIssues.Count
  out_of_scope_issues = $outOfScopeIssues.Count
  issues = $issues.ToArray()
}

if ($Json) {
  $result | ConvertTo-Json -Depth 6
} else {
  $result | Select-Object success, manual_root, scope, config_docs, usage_docs, image_references, checked_images, release_notes_checked, blocking_issues, out_of_scope_issues | Format-List
  foreach ($issue in $issues) {
    $label = if ($issue.in_scope) { 'ERROR' } else { 'OUT-OF-SCOPE' }
    Write-Host "[$label][$($issue.code)] $($issue.path): $($issue.message)"
  }
}

if (-not $result.success) {
  exit 1
}
