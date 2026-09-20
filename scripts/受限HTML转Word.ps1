<#
.SYNOPSIS
独立调用 OpenXmlHelper，将正文 Agent 工作区中的受限 HTML 合并为 Word。
.EXAMPLE
powershell.exe -NoProfile -STA -File .\受限HTML转Word.ps1
.EXAMPLE
.\受限HTML转Word.ps1 -HelperPath C:\Tools\openxmlhelper.exe -InputDirectory D:\输出\正文 -OutputPath D:\输出\正文测试.docx
.EXAMPLE
.\受限HTML转Word.ps1 -HelperPath C:\Tools\openxmlhelper.exe -SelfTest
.NOTES
支持 Windows PowerShell 5.1；仅依赖 Windows/.NET 与外部 OpenXmlHelper。
读取当前生成协议，不调用项目代码、数据库或 AI。特殊页眉页脚装饰不在本测试范围内。
#>
[CmdletBinding()]
param(
    [string]$HelperPath,
    [string]$InputDirectory,
    [string]$OutputPath,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

# 读取明确指定的 UTF-8 JSON，缺失或格式错误直接报告。
function Read-InputJson([string]$File) {
    if (-not [IO.File]::Exists($File)) { throw "缺少输入文件：$File" }
    try { return ([IO.File]::ReadAllText($File, $utf8) | ConvertFrom-Json) }
    catch { throw "JSON 文件无法读取：$File`n$($_.Exception.Message)" }
}

# 将输入中的相对文件路径限制在选中的工作区内。
function Resolve-InputFile([string]$Root, [string]$Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative) -or $Relative.Contains(':')) {
        throw "必须使用工作区相对文件路径：$Relative"
    }
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $file = [IO.Path]::GetFullPath([IO.Path]::Combine($base, $Relative))
    if (-not $file.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw "文件路径超出工作区：$Relative" }
    if (-not [IO.File]::Exists($file)) { throw "引用文件不存在：$file" }
    return $file
}

# 按目录顺序合并正文，只保留结果清单涉及的小节及其祖先标题。
function Get-OutlineHtml($Nodes, $Sections, [int]$Level, [string]$Root, $Visited) {
    foreach ($node in $Nodes) {
        $children = @(Get-OutlineHtml $node.children $Sections ($Level + 1) $Root $Visited) -join "`n"
        $body = ''
        $id = [string]$node.id
        if ($Sections.ContainsKey($id)) {
            if (-not $Visited.Add($id)) { throw "目录中出现重复小节：$id" }
            $file = Resolve-InputFile $Root ([string]$Sections[$id].file)
            if ([IO.Path]::GetExtension($file) -ne '.html') { throw "正文文件必须为 HTML：$file" }
            $body = [IO.File]::ReadAllText($file, $utf8)
            if ([string]::IsNullOrWhiteSpace($body)) { throw "正文文件为空：$file" }
        }
        if ($body -or $children) {
            if ($Level -gt 6) { throw "当前转换器最多支持六级章节标题：$id" }
            $title = [Net.WebUtility]::HtmlEncode([string]$node.title)
            "<!-- yibiao:block -->`n<h$Level>$title</h$Level>`n$body`n$children"
        }
    }
}

# 仅复制正文实际引用的图片，保留相对目录，不扫描或执行配图 HTML 源码。
function Copy-ReferencedImages([string]$Html, [string]$Root, [string]$AssetRoot) {
    foreach ($image in [regex]::Matches($Html, '(?is)<img\b[^>]*>')) {
        $attribute = [regex]::Match($image.Value, '(?is)\bdata-yb-asset-ref\s*=\s*(["''])(.*?)\1')
        if (-not $attribute.Success) { throw "正文仍有未完成的图片占位（缺少 data-yb-asset-ref）：$($image.Value)" }
        $reference = [Net.WebUtility]::HtmlDecode($attribute.Groups[2].Value)
        $source = Resolve-InputFile $Root $reference
        $relative = $source.Substring($Root.TrimEnd('\', '/').Length + 1)
        $destination = [IO.Path]::Combine($AssetRoot, $relative)
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
        [IO.File]::Copy($source, $destination, $true)
    }
}

# 启动独立助手，发送一条 UTF-8 开工信号，关闭 stdin 后等待它完成并退出。
function Invoke-OpenXmlHelper([string]$Exe, [string]$Workspace) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Exe
    $start.Arguments = '--workspace "' + $Workspace + '"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = $utf8
    $start.StandardErrorEncoding = $utf8
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    $started = $false
    try {
        $started = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $signalBytes = $utf8.GetBytes('{"v":1,"type":"run","job":"convert"}' + "`n")
        $process.StandardInput.BaseStream.Write($signalBytes, 0, $signalBytes.Length)
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(120000)) { throw 'OpenXmlHelper 转换超过 120 秒，已终止本次转换。' }
        $output = $stdout.GetAwaiter().GetResult()
        $errorText = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "OpenXmlHelper 退出码 $($process.ExitCode)：$errorText" }
        $done = $output | ConvertFrom-Json
        if ($done.type -ne 'done' -or $done.job -ne 'convert') { throw "OpenXmlHelper 返回了无效完成信号：$output" }
        $result = Read-InputJson (Join-Path $Workspace 'openxml-jobs/convert/result.json')
        if (-not $done.ok -or -not $result.ok) { throw "OpenXmlHelper 转换失败：$($result.error)" }
    }
    finally {
        if ($started -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
}

# 独立转换入口；原始文件只读，任务文件和图片副本均放入临时工作区。
function Convert-RestrictedHtml([string]$Exe, [string]$Directory, [string]$Destination) {
    $exePath = [IO.Path]::GetFullPath($Exe)
    if (-not [IO.File]::Exists($exePath)) { throw "OpenXmlHelper 不存在：$exePath" }
    $root = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/')
    if (-not [IO.Directory]::Exists($root)) { throw "输入目录不存在：$root" }
    if ([IO.Path]::GetFileName($root) -eq '正文') { $root = [IO.Path]::GetDirectoryName($root) }
    $manifest = Read-InputJson (Join-Path $root '正文生成结果.json')
    $decisions = Read-InputJson (Join-Path $root '正文编排决策.json')
    $template = Read-InputJson (Join-Path $root '所选模板配置.json')
    if ($null -eq $template.config -or $template.config -isnot [pscustomobject]) { throw '所选模板配置.json 缺少 config 对象。' }
    if (-not $decisions.outline -or -not $manifest.sections) { throw '正文编排目录或生成结果清单为空。' }
    $sections = @{}
    foreach ($section in $manifest.sections) {
        $id = [string]$section.section_id
        if (-not $id -or $sections.ContainsKey($id)) { throw "结果清单小节 ID 为空或重复：$id" }
        $sections[$id] = $section
    }
    $visited = New-Object 'System.Collections.Generic.HashSet[string]'
    $html = @(Get-OutlineHtml $decisions.outline $sections 1 $root $visited) -join "`n"
    if ($visited.Count -ne $sections.Count) { throw '结果清单中有小节未出现在正文编排目录中。' }
    $destinationPath = [IO.Path]::GetFullPath($Destination)
    if ([IO.Path]::GetExtension($destinationPath) -ne '.docx') { throw '输出文件扩展名必须为 .docx。' }
    if ([IO.File]::Exists($destinationPath)) { throw "输出文件已存在，请选择新的文件名：$destinationPath" }
    if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($destinationPath))) { throw '输出文件夹不存在。' }
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
    $workspace = Join-Path $temporaryRoot ('restricted-html-word-' + [guid]::NewGuid().ToString('N'))
    try {
        $job = Join-Path $workspace 'openxml-jobs/convert'
        [void][IO.Directory]::CreateDirectory($job)
        $assets = Join-Path $workspace 'assets'
        [void][IO.Directory]::CreateDirectory($assets)
        Copy-ReferencedImages $html $root $assets
        $request = @{ action = 'render-restricted-html-docx'; html = $html; output = 'converted.docx'; asset_root = 'assets'; export_format = $template.config }
        [IO.File]::WriteAllText((Join-Path $job 'request.json'), ($request | ConvertTo-Json -Depth 100), $utf8)
        Invoke-OpenXmlHelper $exePath $workspace
        [IO.File]::Copy((Join-Path $job 'converted.docx'), $destinationPath, $false)
        Write-Host "转换完成：$($sections.Count) 个小节 → $destinationPath"
    }
    finally {
        # 删除前核对绝对路径，只清理本次生成且位于临时目录下的任务目录。
        if ([IO.Directory]::Exists($workspace) -and [IO.Path]::GetDirectoryName($workspace) -eq $temporaryRoot -and [IO.Path]::GetFileName($workspace).StartsWith('restricted-html-word-')) {
            Remove-Item -LiteralPath $workspace -Recurse -Force
        }
    }
}

# 内置检查覆盖真实 DOCX 转换、顺序、标题、表格、图片及缺失图片报错。
function Test-Conversion([string]$Exe) {
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
    $fixture = Join-Path $temporaryRoot ('restricted-html-test-' + [guid]::NewGuid().ToString('N'))
    try {
        [void][IO.Directory]::CreateDirectory((Join-Path $fixture '正文'))
        [void][IO.Directory]::CreateDirectory((Join-Path $fixture '图片'))
        $bitmap = New-Object Drawing.Bitmap(16, 16)
        try { $bitmap.Save((Join-Path $fixture '图片/示意.png'), [Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
        $first = '<!-- yibiao:block --><p id="p1">先读正文甲</p><!-- yibiao:block --><table id="t1" data-yb-preset="plain"><tbody><tr><td>表格验证</td></tr></tbody></table><!-- yibiao:block --><figure id="f1" data-yb-generation="htmlImage" data-yb-size="square"><template data-yb-role="prompt">不进入正文的配图提示词</template><img alt="示意" data-yb-asset-ref="图片/示意.png"><figcaption>示意图注</figcaption></figure>'
        [IO.File]::WriteAllText((Join-Path $fixture '正文/1.2.html'), $first, $utf8)
        [IO.File]::WriteAllText((Join-Path $fixture '正文/1.10.html'), '<!-- yibiao:block --><p id="p2">后读正文乙</p>', $utf8)
        [IO.File]::WriteAllText((Join-Path $fixture '图片/不应读取.html'), '不应进入Word的配图源代码', $utf8)
        [IO.File]::WriteAllText((Join-Path $fixture '正文生成结果.json'), '{"sections":[{"section_id":"1.10","file":"正文/1.10.html"},{"section_id":"1.2","file":"正文/1.2.html"}]}', $utf8)
        [IO.File]::WriteAllText((Join-Path $fixture '正文编排决策.json'), '{"outline":[{"id":"1","title":"父章节","children":[{"id":"1.2","title":"前小节"},{"id":"1.10","title":"后小节"}]},{"id":"2","title":"未生成章节"}]}', $utf8)
        [IO.File]::WriteAllText((Join-Path $fixture '所选模板配置.json'), '{"config":{"page":{"paper_size":"a4"},"body_text":{"font":"宋体","size":"小四"}}}', $utf8)
        foreach ($directory in @($fixture, (Join-Path $fixture '正文'))) {
            $docx = Join-Path $fixture ([guid]::NewGuid().ToString('N') + '.docx')
            Convert-RestrictedHtml $Exe $directory $docx
            $zip = [IO.Compression.ZipFile]::OpenRead($docx)
            try {
                $reader = New-Object IO.StreamReader($zip.GetEntry('word/document.xml').Open(), $utf8)
                try { $xml = $reader.ReadToEnd() } finally { $reader.Dispose() }
                if ($xml.IndexOf('先读正文甲') -lt 0 -or $xml.IndexOf('后读正文乙') -lt $xml.IndexOf('先读正文甲')) { throw '检查失败：正文顺序错误。' }
                if (-not $xml.Contains('父章节') -or -not $xml.Contains('Heading2') -or -not $xml.Contains('表格验证')) { throw '检查失败：标题或表格缺失。' }
                if ($xml -match '配图提示词|不应进入Word|未生成章节') { throw '检查失败：错误地加入了无关内容。' }
                if (@($zip.Entries | Where-Object { $_.FullName -match '(^|/)media/' }).Count -ne 1) { throw '检查失败：图片没有正确嵌入。' }
            } finally { $zip.Dispose() }
        }
        if ([IO.File]::ReadAllText((Join-Path $fixture '正文/1.2.html'), $utf8) -ne $first) { throw '检查失败：原始正文被修改。' }
        [IO.File]::Delete((Join-Path $fixture '图片/示意.png'))
        $failed = $false
        try { Convert-RestrictedHtml $Exe $fixture (Join-Path $fixture '缺失图.docx') }
        catch { if ($_.Exception.Message -notlike '*引用文件不存在*') { throw }; $failed = $true }
        if (-not $failed) { throw '检查失败：缺图未报错。' }
        Write-Host '独立转换检查通过：两种目录选择、编排顺序、标题层级、表格、图片、源码排除及原文保护。'
    }
    finally {
        if ([IO.Directory]::Exists($fixture) -and [IO.Path]::GetDirectoryName($fixture) -eq $temporaryRoot -and [IO.Path]::GetFileName($fixture).StartsWith('restricted-html-test-')) {
            Remove-Item -LiteralPath $fixture -Recurse -Force
        }
    }
}

# 参数未提供时使用原生窗口；取消选择即结束，不启动转换。
$interactive = -not $SelfTest -and (-not $HelperPath -or -not $InputDirectory -or -not $OutputPath)
try {
    if ($SelfTest) {
        if (-not $HelperPath) { throw '自检必须通过 -HelperPath 指定 OpenXmlHelper。' }
        Test-Conversion $HelperPath
        return
    }
    if ($interactive) {
        Add-Type -AssemblyName System.Windows.Forms
        if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { throw '请使用 powershell.exe -STA -File 运行脚本，以启用文件选择窗口。' }
        [Windows.Forms.Application]::EnableVisualStyles()
    }
    if (-not $InputDirectory) {
        $dialog = New-Object Windows.Forms.FolderBrowserDialog
        try {
            $dialog.Description = '选择正文 Agent 工作区根目录，或其中的“正文”文件夹'
            $dialog.ShowNewFolderButton = $false
            if ($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { return }
            $InputDirectory = $dialog.SelectedPath
        } finally { $dialog.Dispose() }
    }
    if (-not $HelperPath) {
        $dialog = New-Object Windows.Forms.OpenFileDialog
        try {
            $dialog.Title = '选择 OpenXmlHelper 可执行程序'
            $dialog.Filter = 'OpenXmlHelper 程序 (openxmlhelper.exe)|openxmlhelper.exe'
            if ($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { return }
            $HelperPath = $dialog.FileName
        } finally { $dialog.Dispose() }
    }
    if (-not $OutputPath) {
        $dialog = New-Object Windows.Forms.SaveFileDialog
        try {
            $dialog.Title = '保存合并后的 Word（请选择新的文件名）'
            $dialog.Filter = 'Word 文档 (*.docx)|*.docx'
            $dialog.FileName = '正文测试-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.docx'
            $dialog.InitialDirectory = $InputDirectory
            if ($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { return }
            $OutputPath = $dialog.FileName
        } finally { $dialog.Dispose() }
    }
    Convert-RestrictedHtml $HelperPath $InputDirectory $OutputPath
    if ($interactive) { [void][Windows.Forms.MessageBox]::Show("转换完成：`n$OutputPath", '受限 HTML 转 Word') }
}
catch {
    if ($interactive -and ('System.Windows.Forms.MessageBox' -as [type])) { [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, '转换失败') }
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
}
