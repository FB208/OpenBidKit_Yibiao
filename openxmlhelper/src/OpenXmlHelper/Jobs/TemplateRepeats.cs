using DocumentFormat.OpenXml;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>一条可重复条目：Parent 下第 StartIndex 至 EndIndex 个子元素（写入前的位置），From、To 为首末段落。</summary>
sealed class TemplateRepeatItem
{
    public string ListId { get; init; } = "";
    public int Number { get; init; }
    public OpenXmlElement Parent { get; init; } = null!;
    public Wp.Paragraph From { get; init; } = null!;
    public Wp.Paragraph To { get; init; } = null!;
    public int StartIndex { get; init; }
    public int EndIndex { get; init; }
    public TemplateChapterRange? Chapter { get; init; }
    /// <summary>条目内的字段 id，写入字段后据此确定条目末尾（附件拆分会在其后插入段落）。</summary>
    public HashSet<string> FieldIds { get; } = new(StringComparer.Ordinal);
}

/// <summary>
/// 可重复条目：模版中按实际条数填写的段落条目（如多个标的时依次写的“1.…”“2.…”），由模版提取 Agent 按语义在分类文件 repeats 中标出，程序只校验能否执行。
/// 条目内字段的 table_id 为清单 id（e1、e2…）、row 为第几条，与逐行清单表一样逐条填写、按同一规则判定未使用的条目。
/// 每条在首段段首、末段段尾写书签 _YbR&lt;清单序号&gt;_&lt;条序号&gt;；整本导出回填时未使用的条目改名为 _YbD…（块数不变），并入章节和截章时删除。
/// </summary>
static class TemplateRepeats
{
    public const string ListIdPrefix = "e";
    public const string BookmarkPrefix = "_YbR";
    public const string IdleBookmarkPrefix = "_YbD";

    /// <summary>解析 Agent 标出的条目；selected 为选用的字段候选及是否为 rule 字段。有问题时汇总后一次报错。</summary>
    public static List<List<TemplateRepeatItem>> Resolve(
        IReadOnlyList<TemplateRepeat>? repeats,
        TemplateFieldCandidateFile scan,
        IReadOnlyList<(TemplateFieldCandidate Candidate, bool Rule)> selected,
        IReadOnlyList<TemplateParagraphEntry?> headings)
    {
        var entries = new Dictionary<string, TemplateParagraphEntry>(StringComparer.Ordinal);
        foreach (var entry in scan.Paragraphs) entries.TryAdd(entry.Locator, entry);
        var errors = new List<string>();
        var lists = new List<List<TemplateRepeatItem>>();
        for (var listIndex = 0; listIndex < (repeats?.Count ?? 0); listIndex += 1)
        {
            var repeat = repeats![listIndex];
            var listId = $"{ListIdPrefix}{listIndex + 1}";
            var items = new List<TemplateRepeatItem>();
            if (repeat.Entries.Count < 2) errors.Add($"repeats 第 {listIndex + 1} 项至少需要两条");
            for (var number = 1; number <= repeat.Entries.Count; number += 1)
            {
                var source = repeat.Entries[number - 1];
                var label = $"repeats 第 {listIndex + 1} 项第 {number} 条";
                var problem = ResolveItem(source, entries, listId, number, out var item);
                if (problem is not null) errors.Add($"{label}：{problem}");
                else items.Add(item!);
            }
            if (items.Select(item => item.Chapter).Distinct().Count() > 1) errors.Add($"repeats 第 {listIndex + 1} 项的各条不在同一章");
            lists.Add(items);
        }
        var all = lists.SelectMany(list => list).ToList();
        for (var index = 0; index < all.Count; index += 1)
        {
            for (var other = index + 1; other < all.Count; other += 1)
            {
                if (Contains(all[index], all[other].From) || Contains(all[other], all[index].From))
                {
                    errors.Add($"{Label(all[index])} 与 {Label(all[other])} 范围重叠");
                }
            }
        }
        foreach (var item in all)
        {
            var members = selected.Where(selection => Contains(item, Host(selection.Candidate))).ToList();
            if (members.Count == 0) errors.Add($"{Label(item)} 中没有选用的字段");
            if (members.Any(selection => selection.Rule)) errors.Add($"{Label(item)} 中有 fill_by=rule 的字段，规则和页码表格不能放在条目中");
            if (headings.Any(heading => heading is not null && Contains(item, heading.Paragraph))) errors.Add($"{Label(item)} 包含章节标题段");
        }
        // 跨段勾选项写入时整体包进块级控件，不能跨越条目边界，否则删除条目会带走或留下其中一部分。
        foreach (var (candidate, _) in selected.Where(selection => selection.Candidate.TargetGroup is { Count: > 1 }))
        {
            if (all.Any(item => candidate.TargetGroup!.Select(paragraph => Contains(item, paragraph)).Distinct().Count() > 1))
            {
                errors.Add($"跨段勾选项 {candidate.CandidateId} 跨越了条目边界");
            }
        }
        if (errors.Count > 0)
        {
            throw new InvalidOperationException($"repeats 无效：{string.Join("；", errors.Take(10))}。请修改分类文件后重新提交。");
        }
        return lists;
    }

    static string? ResolveItem(
        TemplateRepeatEntry source,
        IReadOnlyDictionary<string, TemplateParagraphEntry> entries,
        string listId,
        int number,
        out TemplateRepeatItem? item)
    {
        item = null;
        var fromAt = (source.From ?? "").Trim();
        var toAt = string.IsNullOrWhiteSpace(source.To) ? fromAt : source.To.Trim();
        if (!entries.TryGetValue(fromAt, out var from)) return $"定位号 {fromAt} 不在投标模版正文中";
        if (!entries.TryGetValue(toAt, out var to)) return $"定位号 {toAt} 不在投标模版正文中";
        if (from.Chapter is null || !ReferenceEquals(from.Chapter, to.Chapter)) return "首末段落须在同一个已确认章节内";
        if (from.InTextBox || to.InTextBox) return "文本框中的段落不能作为条目";
        var parent = from.Paragraph.Parent;
        if (parent is null || !ReferenceEquals(parent, to.Paragraph.Parent)) return $"{fromAt} 与 {toAt} 不在同一层级（须同在正文或同一单元格中）";
        var children = parent.ChildElements.ToList();
        var start = children.IndexOf(from.Paragraph);
        var end = children.IndexOf(to.Paragraph);
        if (start > end) return $"{fromAt} 在 {toAt} 之后";
        item = new TemplateRepeatItem
        {
            ListId = listId,
            Number = number,
            Parent = parent,
            From = from.Paragraph,
            To = to.Paragraph,
            StartIndex = start,
            EndIndex = end,
            Chapter = from.Chapter,
        };
        return null;
    }

    /// <summary>候选所在的条目（写入前按位置判断）；不在任何条目中时为 null。</summary>
    public static TemplateRepeatItem? Locate(IEnumerable<List<TemplateRepeatItem>> lists, OpenXmlElement? element) =>
        element is null ? null : lists.SelectMany(list => list).FirstOrDefault(item => Contains(item, element));

    public static OpenXmlElement? Host(TemplateFieldCandidate candidate) =>
        (OpenXmlElement?)candidate.TargetGroup?.FirstOrDefault() ?? candidate.Target;

    public static string PreviewLabel(TemplateRepeatItem item) => $"〔条目 {item.ListId}·第{item.Number}条〕";

    static string Label(TemplateRepeatItem item) => $"条目 {item.ListId} 第 {item.Number} 条";

    static bool Contains(TemplateRepeatItem item, OpenXmlElement? element)
    {
        if (element is null) return false;
        var top = SelfAndAncestors(element).FirstOrDefault(node => ReferenceEquals(node.Parent, item.Parent));
        if (top is null) return false;
        var index = item.Parent.ChildElements.ToList().IndexOf(top);
        return index >= item.StartIndex && index <= item.EndIndex;
    }

    /// <summary>
    /// 写入字段后为每条加书签：起点在首个顶层元素的第一段段首，终点在末个顶层元素的最后一段段尾；
    /// 首末段落被跨段勾选项包住时按包住它的控件算，末尾紧跟本条附件拆分插入的段落时延伸到其后。
    /// </summary>
    public static void Mark(Wp.Body body, IEnumerable<List<TemplateRepeatItem>> lists)
    {
        var nextId = body.Descendants<Wp.BookmarkStart>()
            .Select(item => int.TryParse(item.Id?.Value, out var value) ? value : 0)
            .DefaultIfEmpty(0)
            .Max() + 1;
        var listIndex = 0;
        foreach (var list in lists)
        {
            listIndex += 1;
            foreach (var item in list)
            {
                var first = SelfAndAncestors(item.From).First(node => ReferenceEquals(node.Parent, item.Parent));
                var last = SelfAndAncestors(item.To).First(node => ReferenceEquals(node.Parent, item.Parent));
                while (last.NextSibling() is { } next && next.Descendants<Wp.SdtElement>().Any(control => item.FieldIds.Contains(FieldId(control) ?? "")))
                {
                    last = next;
                }
                var startParagraph = first as Wp.Paragraph ?? first.Descendants<Wp.Paragraph>().First();
                var endParagraph = last as Wp.Paragraph ?? last.Descendants<Wp.Paragraph>().Last();
                var id = (nextId++).ToString(System.Globalization.CultureInfo.InvariantCulture);
                var start = new Wp.BookmarkStart { Id = id, Name = $"{BookmarkPrefix}{listIndex}_{item.Number}" };
                if (startParagraph.ParagraphProperties is { } properties) startParagraph.InsertAfter(start, properties);
                else startParagraph.PrependChild(start);
                endParagraph.AppendChild(new Wp.BookmarkEnd { Id = id });
            }
        }
    }

    /// <summary>整本导出回填：条目内字段控件全部在未使用列表中时，把该条书签改名为待删（块数不变，并入和截章时删除）。</summary>
    public static int MarkIdle(Wp.Body body, IReadOnlyCollection<string> fieldIds)
    {
        var ids = fieldIds.ToHashSet(StringComparer.Ordinal);
        var marked = 0;
        foreach (var (start, elements) in Ranges(body, BookmarkPrefix))
        {
            var fields = elements
                .SelectMany(element => element.Descendants<Wp.SdtElement>())
                .Where(control => !control.Ancestors<AlternateContentFallback>().Any())
                .Select(FieldId)
                .OfType<string>()
                .ToList();
            if (fields.Count == 0 || fields.Any(id => !ids.Contains(id))) continue;
            start.Name = IdleBookmarkPrefix + start.Name!.Value![BookmarkPrefix.Length..];
            marked += 1;
        }
        return marked;
    }

    /// <summary>
    /// 删除标为待删的条目，并去掉全部条目书签。范围内有分节属性时保留该条。
    /// 与 RemoveFormatText 一致：范围内的其他书签移到下一段，首段的段前分页移到下一段；单元格须以段落结尾，删空时补一个空段落。
    /// 整本导出并入章节和正文页单章预览都调用。
    /// </summary>
    public static void RemoveIdle(OpenXmlElement container)
    {
        foreach (var (_, elements) in Ranges(container, IdleBookmarkPrefix))
        {
            if (elements.Any(element => element.Descendants<Wp.SectionProperties>().Any())) continue;
            var parent = elements[0].Parent;
            var firstParagraph = elements[0] as Wp.Paragraph ?? elements[0].Descendants<Wp.Paragraph>().FirstOrDefault();
            if (elements[^1].NextSibling() is Wp.Paragraph next)
            {
                var anchor = (OpenXmlElement?)next.ParagraphProperties;
                foreach (var bookmark in elements
                    .SelectMany(element => element.Descendants())
                    .Where(node => node is Wp.BookmarkStart start ? !IsRepeatBookmark(start) : node is Wp.BookmarkEnd)
                    .ToList())
                {
                    if (bookmark is Wp.BookmarkEnd end && IsRepeatEnd(container, end)) continue;
                    bookmark.Remove();
                    anchor = anchor is null ? next.PrependChild(bookmark) : next.InsertAfter(bookmark, anchor);
                }
                if (firstParagraph?.ParagraphProperties?.PageBreakBefore is { } pageBreak && (pageBreak.Val is null || pageBreak.Val.Value))
                {
                    (next.ParagraphProperties ??= new Wp.ParagraphProperties()).PageBreakBefore = new Wp.PageBreakBefore();
                }
            }
            foreach (var element in elements) element.Remove();
            if (parent is Wp.TableCell cell && cell.LastChild is not Wp.Paragraph) cell.AppendChild(EmptyParagraph(firstParagraph));
        }
        var starts = container.Descendants<Wp.BookmarkStart>().Where(IsRepeatBookmark).ToList();
        var ids = starts.Select(item => item.Id?.Value).ToHashSet(StringComparer.Ordinal);
        foreach (var end in container.Descendants<Wp.BookmarkEnd>().Where(item => ids.Contains(item.Id?.Value)).ToList()) end.Remove();
        foreach (var start in starts) start.Remove();
    }

    /// <summary>沿用原段落格式的空段落，去掉编号和段前分页。</summary>
    static Wp.Paragraph EmptyParagraph(Wp.Paragraph? source)
    {
        var paragraph = new Wp.Paragraph();
        if (source?.ParagraphProperties?.CloneNode(true) is Wp.ParagraphProperties properties)
        {
            properties.NumberingProperties = null;
            properties.PageBreakBefore = null;
            paragraph.AppendChild(properties);
        }
        return paragraph;
    }

    static bool IsRepeatBookmark(Wp.BookmarkStart start) =>
        start.Name?.Value is { } name && (name.StartsWith(BookmarkPrefix, StringComparison.Ordinal) || name.StartsWith(IdleBookmarkPrefix, StringComparison.Ordinal));

    static bool IsRepeatEnd(OpenXmlElement container, Wp.BookmarkEnd end) =>
        container.Descendants<Wp.BookmarkStart>().Any(start => start.Id?.Value == end.Id?.Value && IsRepeatBookmark(start));

    /// <summary>名称以 prefix 开头的条目书签各自覆盖的元素：起止段落在共同父元素下的兄弟区间，整个控件内容都在区间内时取控件本身。</summary>
    static List<(Wp.BookmarkStart Start, List<OpenXmlElement> Elements)> Ranges(OpenXmlElement container, string prefix)
    {
        var result = new List<(Wp.BookmarkStart, List<OpenXmlElement>)>();
        foreach (var start in container.Descendants<Wp.BookmarkStart>()
            .Where(item => item.Name?.Value?.StartsWith(prefix, StringComparison.Ordinal) == true)
            .ToList())
        {
            var end = container.Descendants<Wp.BookmarkEnd>().FirstOrDefault(item => item.Id?.Value == start.Id?.Value);
            var startParagraph = start.Ancestors<Wp.Paragraph>().FirstOrDefault();
            var endParagraph = end?.Ancestors<Wp.Paragraph>().FirstOrDefault();
            if (startParagraph is null || endParagraph is null) continue;
            var common = SelfAndAncestors(startParagraph).FirstOrDefault(node => SelfAndAncestors(endParagraph).Contains(node));
            if (common is null) continue;
            if (common is Wp.Paragraph)
            {
                result.Add((start, new List<OpenXmlElement> { common }));
                continue;
            }
            var first = SelfAndAncestors(startParagraph).First(node => ReferenceEquals(node.Parent, common));
            var last = SelfAndAncestors(endParagraph).First(node => ReferenceEquals(node.Parent, common));
            while (common is Wp.SdtContentBlock && common.Parent is Wp.SdtBlock control && control.Parent is not null
                && ReferenceEquals(first, common.FirstChild) && ReferenceEquals(last, common.LastChild))
            {
                first = last = control;
                common = control.Parent;
            }
            var elements = new List<OpenXmlElement>();
            for (OpenXmlElement? node = first; node is not null; node = node.NextSibling())
            {
                elements.Add(node);
                if (ReferenceEquals(node, last)) break;
            }
            result.Add((start, elements));
        }
        return result;
    }

    static IEnumerable<OpenXmlElement> SelfAndAncestors(OpenXmlElement element) => element.Ancestors().Prepend(element);

    static string? FieldId(Wp.SdtElement control)
    {
        var tag = control.GetFirstChild<Wp.SdtProperties>()?.GetFirstChild<Wp.Tag>()?.Val?.Value ?? "";
        return tag.StartsWith(TemplateFieldSdtWriter.TagPrefix, StringComparison.Ordinal) ? tag[TemplateFieldSdtWriter.TagPrefix.Length..] : null;
    }
}
