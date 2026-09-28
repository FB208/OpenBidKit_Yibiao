using System.Text.RegularExpressions;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

sealed record SourceDocument(string Path, string RelativePath, WordprocessingDocument Document, MainDocumentPart Part, List<BlockInfo> Blocks) : IDisposable
{
    public void Dispose() => Document.Dispose();
}

sealed record BlockInfo
{
    public required OpenXmlElement Element { get; init; }
    public string SourcePath { get; init; } = "";
    public string RelativePath { get; init; } = "";
    public int BlockIndex { get; init; }
    public string Kind { get; init; } = "other";
    public string Text { get; init; } = "";
    public bool IsHeading { get; init; }
    public int OutlineLevel { get; init; }
    public bool HeadingStyle { get; init; }
    public bool HasPageBreak { get; init; }
    public bool HasSectionBreak { get; init; }
    public bool IsLayoutOnly { get; init; }
}

/// <summary>在工作区内打开招标 Word，并按块列出正文。</summary>
static class WordWorkspace
{
    public const int TextPreviewLimit = 500;

    public static string ResolveWorkspacePath(string workspace, string relativeOrAbsolute)
    {
        var value = (relativeOrAbsolute ?? "").Trim().Replace('/', Path.DirectorySeparatorChar);
        if (value.Length == 0)
        {
            throw new InvalidOperationException("路径为空");
        }

        var full = Path.GetFullPath(Path.IsPathRooted(value) ? value : Path.Combine(workspace, value));
        var root = Path.GetFullPath(workspace).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("路径越出工作区");
        }

        return full;
    }

    public static string ToRelativePath(string workspace, string fullPath)
    {
        var root = Path.GetFullPath(workspace).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var full = Path.GetFullPath(fullPath);
        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase))
        {
            return Path.GetFileName(full);
        }

        return full[root.Length..].Replace('\\', '/');
    }

    public static bool PathsEqual(string left, string right)
    {
        return string.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>文件被占用或无读写权限时返回可直接告知用户的环境错误。</summary>
    public static JobResult FileAccessFailure(string workspace, IEnumerable<string?> paths)
    {
        var names = paths
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Select(item => ToRelativePath(workspace, Path.IsPathRooted(item!) ? item! : Path.Combine(workspace, item!)))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        var target = names.Count > 0 ? $"“{string.Join("”、“", names)}”" : "投标模版相关文件";
        return JobResult.Fail(
            $"无法读写文件{target}：文件可能正被 Word、WPS 等程序打开，或当前用户没有读写权限。请关闭占用该文件的程序后重试。",
            JobResult.EnvironmentErrorKind);
    }

    public static JobResult FileAccessFailure(string workspace, string? path) => FileAccessFailure(workspace, [path]);

    /// <summary>复制出可写副本；File.Copy 会带上源文件的只读属性，导致覆盖或随后写入被拒绝。</summary>
    public static void CopyToWritable(string sourcePath, string destPath)
    {
        ClearReadOnly(destPath);
        File.Copy(sourcePath, destPath, overwrite: true);
        ClearReadOnly(destPath);
    }

    static void ClearReadOnly(string path)
    {
        if (!File.Exists(path)) return;
        var attributes = File.GetAttributes(path);
        if (attributes.HasFlag(FileAttributes.ReadOnly))
        {
            File.SetAttributes(path, attributes & ~FileAttributes.ReadOnly);
        }
    }

    public static List<string> ResolveSources(string workspace, IEnumerable<string>? sources)
    {
        return (sources ?? [])
            .Select(item => ResolveWorkspacePath(workspace, item))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    public static Dictionary<string, SourceDocument> OpenSources(string workspace, IEnumerable<string> sourcePaths)
    {
        var map = new Dictionary<string, SourceDocument>(StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach (var path in sourcePaths)
            {
                var document = WordprocessingDocument.Open(path, false);
                var part = document.MainDocumentPart ?? throw new InvalidOperationException($"无法打开招标原件：{path}");
                var body = part.Document.Body ?? throw new InvalidOperationException($"招标原件没有正文：{path}");
                var styleOutlineLevels = ReadStyleOutlineLevels(part);
                var blocks = new List<BlockInfo>();
                var index = 0;
                foreach (var child in body.ChildElements)
                {
                    blocks.Add(CreateBlock(child, path, ToRelativePath(workspace, path), index, styleOutlineLevels));
                    index += 1;
                }

                map[path] = new SourceDocument(path, ToRelativePath(workspace, path), document, part, blocks);
            }

            return map;
        }
        catch
        {
            foreach (var source in map.Values)
            {
                source.Dispose();
            }

            throw;
        }
    }

    public static BlockInfo CreateBlock(
        OpenXmlElement element,
        string sourcePath,
        string relativePath,
        int index,
        IReadOnlyDictionary<string, int>? styleOutlineLevels = null)
    {
        var paragraph = element as Wp.Paragraph;
        var kind = element is Wp.SectionProperties
            ? "section-break"
            : paragraph is not null ? "paragraph" : element is Wp.Table ? "table" : "other";
        var text = kind == "section-break" ? "" : Normalize(element.InnerText ?? "");
        var outlineLevel = ReadOutlineLevel(paragraph, styleOutlineLevels);
        var headingStyle = HasHeadingStyle(paragraph);
        var hasPageBreak = HasPageBreak(element);
        var hasSectionBreak = kind == "section-break" || HasSectionBreak(paragraph);
        return new BlockInfo
        {
            Element = element,
            SourcePath = sourcePath,
            RelativePath = relativePath,
            BlockIndex = index,
            Kind = kind,
            Text = text,
            IsHeading = paragraph is not null && (outlineLevel < 9 || headingStyle),
            OutlineLevel = outlineLevel,
            HeadingStyle = headingStyle,
            HasPageBreak = hasPageBreak,
            HasSectionBreak = hasSectionBreak,
            IsLayoutOnly = text.Length == 0 || kind == "section-break",
        };
    }

    public static bool IsLayoutOnly(BlockInfo block)
    {
        return block.IsLayoutOnly;
    }

    public static string PreviewText(string text)
    {
        var value = text ?? "";
        return value.Length <= TextPreviewLimit ? value : value[..TextPreviewLimit];
    }

    public static string Normalize(string value)
    {
        return Regex.Replace(value ?? "", @"\s+", " ").Trim();
    }

    /** 段落直接层级优先，否则使用段落样式继承得到的层级。 */
    static int ReadOutlineLevel(Wp.Paragraph? paragraph, IReadOnlyDictionary<string, int>? styleOutlineLevels)
    {
        var directLevel = paragraph?.ParagraphProperties?.OutlineLevel?.Val?.Value;
        if (directLevel is not null) return directLevel.Value;
        var styleId = paragraph?.ParagraphProperties?.ParagraphStyleId?.Val?.Value;
        return !string.IsNullOrWhiteSpace(styleId)
            && styleOutlineLevels?.TryGetValue(styleId, out var styleLevel) == true
                ? styleLevel
                : 9;
    }

    /** 解析 styles.xml 中每个样式通过 basedOn 继承后的真实大纲层级。 */
    static Dictionary<string, int> ReadStyleOutlineLevels(MainDocumentPart part)
    {
        var styles = part.StyleDefinitionsPart?.Styles?.Elements<Wp.Style>()
            .Where(style => !string.IsNullOrWhiteSpace(style.StyleId?.Value))
            .GroupBy(style => style.StyleId!.Value!, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal)
            ?? new Dictionary<string, Wp.Style>(StringComparer.Ordinal);
        var levels = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var styleId in styles.Keys)
        {
            levels[styleId] = ResolveStyleOutlineLevel(styleId, styles, levels, []);
        }
        return levels;
    }

    static int ResolveStyleOutlineLevel(
        string styleId,
        IReadOnlyDictionary<string, Wp.Style> styles,
        IReadOnlyDictionary<string, int> resolved,
        HashSet<string> visiting)
    {
        if (resolved.TryGetValue(styleId, out var cached)) return cached;
        if (!styles.TryGetValue(styleId, out var style) || !visiting.Add(styleId)) return 9;
        try
        {
            var directLevel = style.StyleParagraphProperties?.OutlineLevel?.Val?.Value;
            if (directLevel is not null) return directLevel.Value;
            var basedOn = style.BasedOn?.Val?.Value;
            return !string.IsNullOrWhiteSpace(basedOn)
                ? ResolveStyleOutlineLevel(basedOn, styles, resolved, visiting)
                : 9;
        }
        finally
        {
            visiting.Remove(styleId);
        }
    }

    static bool HasHeadingStyle(Wp.Paragraph? paragraph)
    {
        var style = paragraph?.ParagraphProperties?.ParagraphStyleId?.Val?.Value ?? "";
        return style.StartsWith("Heading", StringComparison.OrdinalIgnoreCase)
            || style.StartsWith("标题", StringComparison.Ordinal);
    }

    static bool HasPageBreak(OpenXmlElement element)
    {
        if (element is not Wp.Paragraph paragraph)
        {
            return false;
        }

        var pageBreakBefore = paragraph.ParagraphProperties?.PageBreakBefore;
        if (pageBreakBefore is not null && (pageBreakBefore.Val is null || pageBreakBefore.Val.Value))
        {
            return true;
        }

        return paragraph.Descendants<Wp.Break>().Any(item => item.Type?.Value == Wp.BreakValues.Page)
            || paragraph.Descendants<Wp.LastRenderedPageBreak>().Any();
    }

    static bool HasSectionBreak(Wp.Paragraph? paragraph)
    {
        return paragraph?.ParagraphProperties?.SectionProperties is not null;
    }
}
