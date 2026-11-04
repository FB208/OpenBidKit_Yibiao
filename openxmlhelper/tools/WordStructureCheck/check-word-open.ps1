# 用本机 Word 逐个以只读方式打开目录里的 docx，打印 OPEN / FAIL。
# 目录里有 expected.txt（evidence 模式生成）时逐项比对实测结果；没有时要求全部 OPEN。有不一致时退出码为 1。
# 用法：powershell -ExecutionPolicy Bypass -File check-word-open.ps1 <目录>
param([Parameter(Mandatory = $true)][string]$Directory)

$expected = @{}
$expectedFile = Join-Path $Directory 'expected.txt'
if (Test-Path -LiteralPath $expectedFile) {
  foreach ($line in Get-Content -LiteralPath $expectedFile -Encoding UTF8) {
    $parts = $line.Split(' ')
    if ($parts.Count -eq 2) { $expected[$parts[0]] = $parts[1] }
  }
}

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$version = $word.Version
$mismatch = 0
try {
  foreach ($file in Get-ChildItem -LiteralPath $Directory -Filter *.docx | Sort-Object Name) {
    $result = 'OPEN'
    $detail = ''
    try {
      $document = $word.Documents.Open($file.FullName, $false, $true, $false)
      $document.Close($false)
    } catch {
      $result = 'FAIL'
      $detail = ($_.Exception.Message -split "`n")[0].Trim()
    }
    $want = if ($expected.ContainsKey($file.BaseName)) { $expected[$file.BaseName] } else { 'OPEN' }
    $flag = if ($result -eq $want) { '  ' } else { $mismatch += 1; '!!' }
    Write-Output ("{0} {1,-4} {2} {3}" -f $flag, $result, $file.BaseName, $detail)
  }
} finally {
  $word.Quit()
}
Write-Output ("Word {0}：{1} 处与预期不一致" -f $version, $mismatch)
if ($mismatch -gt 0) { exit 1 }
