using System.Text;
using System.Text.RegularExpressions;
using DocumentFormat.OpenXml;
using Yibiao.OpenXmlHelper.Ooxml;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

sealed record PageAnchor(string Bookmark, bool AfterToc);

sealed record PageRefResult(int Count, int MissingCount, IReadOnlyList<PageAnchor> Anchors);

/// <summary>商务章节并入时要加的锚点：起点与终点各列出被引用的目录节点 ID，书签 ID 由整本导出统一分配。</summary>
sealed record PageAnchorRequest(IReadOnlyList<string> StartNodeIds, IReadOnlyList<string> EndNodeIds, Func<string> NextId);

/// <summary>
/// 整本导出的页码引用：Main 在被引用小节的标题前、子树末尾写锚点标记（商务章节在并入时加），这里换成零宽书签；
/// 正文中的 {{YBPAGE:节点ID}}（或合并相邻小节的 {{YBPAGE:起点ID:终点ID}}）换成 IF 域，起止页相同时只显示一个数，否则显示“起-止”；
/// 带 |text 后缀的文字写法显示“第3页”或“第3页至第7页”。写法由 Agent 按上下文选择，在 Word 中更新域后同样成立。
/// 页码先写等宽占位，由 Main 测量后经 fill-toc-page-numbers 回填。
/// </summary>
static class PageReferenceBuilder
{
    public const string MarkerPrefix = "YIBIAOANCHOR:";
    public const string BookmarkPrefix = "_YbP";
    const string StartPrefix = "_YbPS";
    const string EndPrefix = "_YbPE";
    // 避开格式自检书签（从 0 起）、商务模版书签（+1,000,000）和目录书签（2,000,000 起）。
    public const int FirstBookmarkId = 3_000_000;
    const string Placeholder = "0000";
    const string MissingMark = "【待填写：页码】";

    // {{YBPAGE:节点ID}} 引用一个小节；{{YBPAGE:起点ID:终点ID}} 是 Main 合并的相邻小节，从起点小节开头到终点小节结尾；|text 为文字写法。
    static readonly Regex TokenPattern = new(@"\{\{YBPAGE:(?<id>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?::(?<end>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}))?(?<text>\|text)?\}\}", RegexOptions.CultureInvariant | RegexOptions.Compiled);
    static readonly Regex PageRefPattern = new(@"PAGEREF\s+(?<name>_YbP[SE][0-9a-f]{32})", RegexOptions.CultureInvariant | RegexOptions.Compiled);

    static string BookmarkName(bool start, string nodeId) =>
        (start ? StartPrefix : EndPrefix) + nodeId.Replace("-", "", StringComparison.Ordinal).ToLowerInvariant();

    /// <summary>把锚点标记段落换成书签：S 加在下一块首段开头，E 加在上一块末段末尾，标记段落删除。</summary>
    public static void ApplyAnchors(Wp.Body body, Func<string> nextId)
    {
        foreach (var marker in body.Elements<Wp.Paragraph>().Where(IsMarker).ToList())
        {
            var parts = marker.InnerText.Trim()[MarkerPrefix.Length..].Split(':', 2);
            if (parts.Length != 2 || parts[0] is not ("S" or "E")) throw new InvalidOperationException($"页码锚点标记无效：{marker.InnerText}");
            var start = parts[0] == "S";
            var target = start ? FirstParagraph(Sibling(marker, next: true)) : LastParagraph(Sibling(marker, next: false));
            if (target is null) throw new InvalidOperationException("页码锚点缺少对应正文块");
            AddBookmark(target, BookmarkName(start, parts[1]), nextId(), atStart: start);
            WordStructure.Remove(marker);
        }
    }

    /// <summary>商务章节在并入时加锚点：起点为章节标题段，终点为本章正文结束处（见 FindChapterEnd）。</summary>
    public static void ApplyChapterAnchors(
        IReadOnlyList<OpenXmlElement> blocks,
        Wp.Paragraph? title,
        IReadOnlyList<string> startNodeIds,
        IReadOnlyList<string> endNodeIds,
        Func<string> nextId)
    {
        if (blocks.Count == 0) return;
        var first = title ?? FirstParagraph(blocks[0]);
        var last = FindChapterEnd(blocks, first);
        foreach (var nodeId in startNodeIds)
        {
            if (first is not null) AddBookmark(first, BookmarkName(true, nodeId), nextId(), atStart: true);
        }
        foreach (var nodeId in endNodeIds)
        {
            if (last is not null) AddBookmark(last, BookmarkName(false, nodeId), nextId(), atStart: false);
        }
    }

    /// <summary>
    /// 本章正文结束处：章末最后一个有文字或图片的段落（表格取其最后一段），只看标题段之后。
    /// 下一章的引导文字（如“附件N”）是否属于本章由模版提取 Agent 判断，需要去掉的已在并入时先行去掉。
    /// </summary>
    static Wp.Paragraph? FindChapterEnd(IReadOnlyList<OpenXmlElement> blocks, Wp.Paragraph? title)
    {
        for (var index = blocks.Count - 1; index >= 0; index -= 1)
        {
            if (blocks[index] is Wp.SectionProperties) continue;
            if (blocks[index] is not Wp.Paragraph paragraph) return LastParagraph(blocks[index]);
            if (ReferenceEquals(paragraph, title)
                || paragraph.InnerText.Trim().Length > 0
                || paragraph.Descendants().Any(item => item is Wp.Drawing or Wp.Picture or Wp.EmbeddedObject))
            {
                return paragraph;
            }
        }
        return LastParagraph(blocks[^1]);
    }

    /// <summary>把页码引用标记换成 IF/PAGEREF 域；被引用小节没有导出（没有书签）时写“【待填写：页码】”。返回全部锚点供 Main 测量。</summary>
    public static PageRefResult ReplaceReferences(Wp.Body body, Wp.SdtBlock? toc)
    {
        var names = body.Descendants<Wp.BookmarkStart>()
            .Select(item => item.Name?.Value ?? "")
            .Where(item => item.StartsWith(BookmarkPrefix, StringComparison.Ordinal))
            .ToHashSet(StringComparer.Ordinal);
        var count = 0;
        var missing = 0;
        foreach (var run in body.Descendants<Wp.Run>()
            .Where(item => item.Elements<Wp.Text>().Any(text => TokenPattern.IsMatch(text.Text)))
            .ToList())
        {
            var replacement = new List<Wp.Run>();
            foreach (var child in run.ChildElements.Where(item => item is not Wp.RunProperties).ToList())
            {
                if (child is not Wp.Text text || !TokenPattern.IsMatch(text.Text))
                {
                    // 非标记内容（域字符、制表符等）移入新 run，原 run 只剩标记文字再删，避免被当成删掉了一半的域。
                    replacement.Add(CreateRun(run.RunProperties, WordStructure.Detach(child)));
                    continue;
                }
                var position = 0;
                foreach (Match match in TokenPattern.Matches(text.Text))
                {
                    if (match.Index > position) replacement.Add(TextRun(run.RunProperties, text.Text[position..match.Index]));
                    var start = BookmarkName(true, match.Groups["id"].Value);
                    var end = BookmarkName(false, match.Groups["end"].Success ? match.Groups["end"].Value : match.Groups["id"].Value);
                    count += 1;
                    if (names.Contains(start) && names.Contains(end))
                    {
                        replacement.AddRange(CreateReference(run.RunProperties, start, end, match.Groups["text"].Success));
                    }
                    else
                    {
                        missing += 1;
                        replacement.Add(TextRun(run.RunProperties, MissingMark));
                    }
                    position = match.Index + match.Length;
                }
                if (position < text.Text.Length) replacement.Add(TextRun(run.RunProperties, text.Text[position..]));
            }
            foreach (var item in replacement) run.InsertBeforeSelf(item);
            WordStructure.Remove(run);
        }

        var anchors = new List<PageAnchor>();
        var afterToc = false;
        foreach (var paragraph in body.Descendants<Wp.Paragraph>())
        {
            if (toc is not null && paragraph.Ancestors<Wp.SdtBlock>().Contains(toc))
            {
                afterToc = true;
                continue;
            }
            anchors.AddRange(paragraph.Elements<Wp.BookmarkStart>()
                .Select(item => item.Name?.Value ?? "")
                .Where(item => item.StartsWith(BookmarkPrefix, StringComparison.Ordinal))
                .Select(item => new PageAnchor(item, afterToc)));
        }
        return new PageRefResult(count, missing, anchors);
    }

    /// <summary>
    /// 按书签回填页码引用：PAGEREF 写各自页码，外层 IF 按域代码求值（见 EvaluateIf），数字和文字两种写法、新旧文档都适用；页码缺失时都写空。
    /// 返回缺页码的引用数，touched 收集改动的段落供调用方校验。
    /// </summary>
    public static int FillPageNumbers(Wp.Body body, IReadOnlyDictionary<string, string> pages, List<OpenXmlElement> touched)
    {
        var missing = 0;
        string PageOf(string name) => pages.TryGetValue(name, out var value) ? (value ?? "").Trim() : "";
        foreach (var paragraph in body.Descendants<Wp.Paragraph>()
            .Where(item => item.Descendants<Wp.FieldCode>().Any(code => PageRefPattern.IsMatch(code.Text)))
            .ToList())
        {
            var stack = new Stack<FieldFrame>();
            foreach (var run in paragraph.Descendants<Wp.Run>().ToList())
            {
                var fieldChar = run.GetFirstChild<Wp.FieldChar>()?.FieldCharType?.Value;
                if (fieldChar == Wp.FieldCharValues.Begin)
                {
                    stack.Push(new FieldFrame());
                    continue;
                }
                if (stack.Count == 0) continue;
                var frame = stack.Peek();
                if (fieldChar == Wp.FieldCharValues.Separate)
                {
                    frame.InResult = true;
                }
                else if (fieldChar == Wp.FieldCharValues.End)
                {
                    stack.Pop();
                    var instruction = string.Concat(frame.Parts.Select(part => part.Text ?? ""));
                    if (PageRefPattern.Match(instruction) is { Success: true } reference)
                    {
                        var name = reference.Groups["name"].Value;
                        SetResult(frame.ResultRuns, PageOf(name));
                        if (stack.Count > 0) stack.Peek().Parts.Add((null, name));
                    }
                    else if (instruction.TrimStart().StartsWith("IF", StringComparison.Ordinal) && frame.Parts.Count(part => part.Reference is not null) >= 2)
                    {
                        var value = EvaluateIf(frame.Parts, PageOf);
                        if (value.Length == 0) missing += 1;
                        SetResult(frame.ResultRuns, value);
                    }
                }
                else if (!frame.InResult && run.GetFirstChild<Wp.FieldCode>() is { } code)
                {
                    frame.Parts.Add((code.Text, null));
                }
                else if (frame.InResult)
                {
                    frame.ResultRuns.Add(run);
                }
            }
            touched.Add(paragraph);
        }
        return missing;
    }

    /// <summary>域代码按顺序记下的文字（Text）和嵌套 PAGEREF 的书签（Reference）。</summary>
    sealed class FieldFrame
    {
        public List<(string? Text, string? Reference)> Parts { get; } = [];
        public bool InResult { get; set; }
        public List<Wp.Run> ResultRuns { get; } = [];
    }

    /// <summary>
    /// IF "{起}" = "{止}" "相同时" "不同时"：按引号切出四段，嵌套 PAGEREF 换成页码后比较前两段，取相应的显示文字；
    /// 任一页码缺失时为空。数字和文字写法、旧文档的 IF 域都按同一方式求值。
    /// </summary>
    static string EvaluateIf(IReadOnlyList<(string? Text, string? Reference)> parts, Func<string, string> pageOf)
    {
        var segments = new List<StringBuilder> { new() };
        foreach (var (text, reference) in parts)
        {
            if (reference is not null)
            {
                var page = pageOf(reference);
                if (page.Length == 0) return "";
                segments[^1].Append(page);
                continue;
            }
            foreach (var character in text ?? "")
            {
                if (character == '"') segments.Add(new StringBuilder());
                else segments[^1].Append(character);
            }
        }
        if (segments.Count < 8) return "";
        return segments[1].ToString() == segments[3].ToString() ? segments[5].ToString() : segments[7].ToString();
    }

    static void SetResult(IReadOnlyList<Wp.Run> runs, string value)
    {
        var written = false;
        foreach (var text in runs.SelectMany(run => run.Elements<Wp.Text>()).ToList())
        {
            if (written) WordStructure.Remove(text);
            else text.Text = value;
            written = true;
        }
    }

    /// <summary>
    /// IF "{PAGEREF S}" = "{PAGEREF E}" "相同时" "不同时"：数字写法为“{S}”/“{S}-{E}”，文字写法为“第{S}页”/“第{S}页至第{E}页”。
    /// 嵌套域和结果都沿用原文字格式，结果先写等宽占位。
    /// </summary>
    static IEnumerable<Wp.Run> CreateReference(Wp.RunProperties? properties, string start, string end, bool text)
    {
        IEnumerable<Wp.Run> PageRef(string name) =>
        [
            FieldChar(properties, Wp.FieldCharValues.Begin),
            FieldCode(properties, $" PAGEREF {name} "),
            FieldChar(properties, Wp.FieldCharValues.Separate),
            TextRun(properties, Placeholder),
            FieldChar(properties, Wp.FieldCharValues.End),
        ];
        IEnumerable<Wp.Run> Code(string value) => [FieldCode(properties, value)];
        IEnumerable<Wp.Run> same = text ? [.. Code("第"), .. PageRef(start), .. Code("页")] : PageRef(start);
        IEnumerable<Wp.Run> range = text
            ? [.. Code("第"), .. PageRef(start), .. Code("页至第"), .. PageRef(end), .. Code("页")]
            : [.. PageRef(start), .. Code("-"), .. PageRef(end)];
        return new[] { FieldChar(properties, Wp.FieldCharValues.Begin), FieldCode(properties, " IF \"") }
            .Concat(PageRef(start))
            .Append(FieldCode(properties, "\" = \""))
            .Concat(PageRef(end))
            .Append(FieldCode(properties, "\" \""))
            .Concat(same)
            .Append(FieldCode(properties, "\" \""))
            .Concat(range)
            .Append(FieldCode(properties, "\" "))
            .Append(FieldChar(properties, Wp.FieldCharValues.Separate))
            .Append(TextRun(properties, text ? $"第{Placeholder}页" : Placeholder))
            .Append(FieldChar(properties, Wp.FieldCharValues.End));
    }

    /// <summary>零宽书签：docx-editor 只收集段落直接子级的书签，起止都放在段落这一层。</summary>
    internal static void AddBookmark(Wp.Paragraph paragraph, string name, string id, bool atStart)
    {
        var start = new Wp.BookmarkStart { Id = id, Name = name };
        if (atStart)
        {
            if (paragraph.ParagraphProperties is { } properties) paragraph.InsertAfter(start, properties);
            else paragraph.PrependChild(start);
            paragraph.InsertAfter(new Wp.BookmarkEnd { Id = id }, start);
            return;
        }
        paragraph.AppendChild(start);
        paragraph.AppendChild(new Wp.BookmarkEnd { Id = id });
    }

    static bool IsMarker(Wp.Paragraph paragraph) => paragraph.InnerText.Trim().StartsWith(MarkerPrefix, StringComparison.Ordinal);

    /// <summary>跳过相邻的其他锚点标记，取真正的正文块。</summary>
    static OpenXmlElement? Sibling(OpenXmlElement marker, bool next)
    {
        var current = next ? marker.NextSibling() : marker.PreviousSibling();
        while (current is Wp.Paragraph paragraph && IsMarker(paragraph))
        {
            current = next ? current.NextSibling() : current.PreviousSibling();
        }
        return current is Wp.SectionProperties ? null : current;
    }

    static Wp.Paragraph? FirstParagraph(OpenXmlElement? element) =>
        element as Wp.Paragraph ?? element?.Descendants<Wp.Paragraph>().FirstOrDefault();

    static Wp.Paragraph? LastParagraph(OpenXmlElement? element) =>
        element as Wp.Paragraph ?? element?.Descendants<Wp.Paragraph>().LastOrDefault();

    static Wp.Run CreateRun(Wp.RunProperties? properties, OpenXmlElement child)
    {
        var run = new Wp.Run();
        if (properties is not null) run.AppendChild((Wp.RunProperties)properties.CloneNode(true));
        run.AppendChild(child);
        return run;
    }

    static Wp.Run TextRun(Wp.RunProperties? properties, string text) =>
        CreateRun(properties, new Wp.Text(text) { Space = SpaceProcessingModeValues.Preserve });

    static Wp.Run FieldChar(Wp.RunProperties? properties, Wp.FieldCharValues type) =>
        CreateRun(properties, new Wp.FieldChar { FieldCharType = type });

    static Wp.Run FieldCode(Wp.RunProperties? properties, string code) =>
        CreateRun(properties, new Wp.FieldCode(code) { Space = SpaceProcessingModeValues.Preserve });
}
