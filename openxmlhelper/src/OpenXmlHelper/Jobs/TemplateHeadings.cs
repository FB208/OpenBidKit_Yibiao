using System.Text.RegularExpressions;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>
/// 章节标题段：整本导出时加大纲级别和章节编号的段落，模版提取时确定并以书签记在模版中，导出时不再猜测。
/// Agent 可在分类文件 headings 中指定（at 为该章顶层段落，null 表示没有标题段）；未指定的章节按目录标题认定：
/// 去掉 Agent 要去掉的文字后，章节开头几个非空顶层段落中与目录标题评分不低于 60 的一段（口径同抽章），找不到时为没有标题段，
/// 导出时按目录标题插入一段，不拿正文段落充当标题。
/// </summary>
static class TemplateHeadings
{
    /// <summary>标题段书签名前缀，后接章节序号；整本导出并入时用完即删。</summary>
    public const string BookmarkPrefix = "_YbH";
    const int CheckParagraphCount = 3;
    const int MatchScore = 60;
    static readonly Regex TopLevelPattern = new(@"^body/\d+:p$", RegexOptions.CultureInvariant);

    /// <summary>按章节顺序返回各章标题段，null 为没有标题段；指定有问题时汇总后一次报错。</summary>
    public static List<TemplateParagraphEntry?> Resolve(
        IReadOnlyList<TemplateHeading>? headings,
        TemplateFieldCandidateFile scan,
        IReadOnlyList<TemplateFieldCandidate> removals)
    {
        var errors = new List<string>();
        var specified = new Dictionary<string, TemplateHeading>(StringComparer.Ordinal);
        var chapterIds = scan.Chapters.Select(item => item.Id ?? "").ToHashSet(StringComparer.Ordinal);
        foreach (var heading in headings ?? [])
        {
            var id = (heading.ChapterId ?? "").Trim();
            if (id.Length == 0 || !chapterIds.Contains(id)) errors.Add($"chapter_id“{id}”不是已确认目录的 id");
            else if (!specified.TryAdd(id, heading)) errors.Add($"章节 {id} 重复指定");
        }
        var entries = new Dictionary<string, TemplateParagraphEntry>(StringComparer.Ordinal);
        foreach (var entry in scan.Paragraphs) entries.TryAdd(entry.Locator, entry);

        var result = new List<TemplateParagraphEntry?>();
        foreach (var chapter in scan.Chapters)
        {
            if (chapter.Id is null || !specified.TryGetValue(chapter.Id, out var heading))
            {
                result.Add(FindDefault(scan, chapter, removals));
                continue;
            }
            var at = heading.At?.Trim();
            if (string.IsNullOrEmpty(at))
            {
                result.Add(null);
                continue;
            }
            if (!entries.TryGetValue(at, out var target) || target.Chapter?.StartBlock != chapter.StartBlock)
            {
                errors.Add($"“{chapter.Title}”的标题段 {at} 不是该章的段落");
            }
            else if (!TopLevelPattern.IsMatch(target.Location))
            {
                errors.Add($"“{chapter.Title}”的标题段 {at} 必须是正文顶层段落（不在表格、文本框或内容控件中）");
            }
            else if (RemainingText(target, removals).Length == 0)
            {
                errors.Add($"“{chapter.Title}”的标题段 {at} 的文字全部被去掉了，请另选标题段或写 null");
            }
            else
            {
                result.Add(target);
                continue;
            }
            result.Add(null);
        }
        if (errors.Count > 0)
        {
            throw new InvalidOperationException($"headings 无效：{string.Join("；", errors.Take(10))}。请修改分类文件后重新提交。");
        }
        return result;
    }

    /// <summary>按目录标题认定标题段：去掉要去掉的文字后，开头几个非空顶层段落中评分最高且不低于 60 的一段。</summary>
    public static TemplateParagraphEntry? FindDefault(
        TemplateFieldCandidateFile scan,
        TemplateChapterRange chapter,
        IReadOnlyList<TemplateFieldCandidate> removals)
    {
        return scan.Paragraphs
            .Where(entry => entry.Chapter?.StartBlock == chapter.StartBlock && TopLevelPattern.IsMatch(entry.Location))
            .Select(entry => (Entry: entry, Text: RemainingText(entry, removals)))
            .Where(item => item.Text.Length > 0)
            .Take(CheckParagraphCount)
            .Select((item, index) => (item.Entry, Index: index, Score: ExtractChaptersAction.ScoreTitle(
                chapter.Title,
                WordWorkspace.CreateBlock(item.Entry.Paragraph, "", "", index) with { Text = item.Text })))
            .Where(item => item.Score >= MatchScore)
            .OrderByDescending(item => item.Score)
            .ThenBy(item => item.Index)
            .Select(item => item.Entry)
            .FirstOrDefault();
    }

    /// <summary>段落去掉 Agent 要去掉的文字后的规范化文字。</summary>
    static string RemainingText(TemplateParagraphEntry entry, IReadOnlyList<TemplateFieldCandidate> removals)
    {
        var text = entry.Text;
        foreach (var removal in removals
            .Where(item => ReferenceEquals(item.Target, entry.Paragraph))
            .OrderByDescending(item => item.Start))
        {
            text = text.Remove(removal.Start, removal.Length);
        }
        return WordWorkspace.Normalize(text);
    }

    /// <summary>在各章标题段开头写入零宽书签 _YbH&lt;章节序号&gt;；返回各章是否有标题段。</summary>
    public static List<bool> Mark(Wp.Body body, IReadOnlyList<TemplateParagraphEntry?> headings)
    {
        var nextId = body.Descendants<Wp.BookmarkStart>()
            .Select(item => int.TryParse(item.Id?.Value, out var value) ? value : 0)
            .DefaultIfEmpty(0)
            .Max() + 1;
        for (var index = 0; index < headings.Count; index += 1)
        {
            if (headings[index]?.Paragraph is not { } paragraph) continue;
            var id = (nextId++).ToString(System.Globalization.CultureInfo.InvariantCulture);
            var start = new Wp.BookmarkStart { Id = id, Name = $"{BookmarkPrefix}{index}" };
            if (paragraph.ParagraphProperties is { } properties) paragraph.InsertAfter(start, properties);
            else paragraph.PrependChild(start);
            paragraph.InsertAfter(new Wp.BookmarkEnd { Id = id }, start);
        }
        return headings.Select(item => item is not null).ToList();
    }
}
