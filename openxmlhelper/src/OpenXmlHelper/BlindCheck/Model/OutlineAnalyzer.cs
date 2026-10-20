using System.Text.RegularExpressions;
using System.Xml.Linq;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Model;

sealed record TocEntry(int Level, string Text, string Normalized);

sealed class TocInfo
{
    public HashSet<XElement> Paragraphs { get; } = new(ReferenceEqualityComparer.Instance);
    /// <summary>域外按目录样式认出的目录段落（目录转成纯文本后剩下的），修复删除目录时按同一标准。</summary>
    public HashSet<XElement> Styled { get; } = new(ReferenceEqualityComparer.Instance);
    public List<TocEntry> Entries { get; } = [];
    public bool HasToc { get; set; }
    public bool HasField { get; set; }
}

/// <summary>标题判定结果：每个正文顶层段落的标题级别与来源。</summary>
sealed class Outline
{
    public TocInfo Toc { get; init; } = new();
    public Dictionary<XElement, int> Levels { get; } = new(ReferenceEqualityComparer.Instance);
    public Dictionary<string, int> SourceCounts { get; } = new(StringComparer.Ordinal);
    /// <summary>每个标题的级别来源：toc / style / pattern。编号兜底的级别只是名义级别，不能用于层级比较。</summary>
    public Dictionary<XElement, string> Sources { get; } = new(ReferenceEqualityComparer.Instance);

    public int? LevelOf(XElement paragraph) => Levels.TryGetValue(paragraph, out var level) ? level : null;

    public string? SourceOf(XElement paragraph) => Sources.GetValueOrDefault(paragraph);

    public bool IsToc(XElement paragraph) => Toc.Paragraphs.Contains(paragraph);

    /// <summary>标题按目录认定（目录有 3 条以上条目）；此时不按编号兜底。</summary>
    public bool UsedToc { get; init; }
}

/// <summary>
/// 标题结构按"目录 → 标题样式/大纲级别 → 编号兜底"的优先级确定，宁少不错：
/// 目录是作者亲自确认的结构；编号兜底只在没有目录时启用，且只认前两级编号。
/// </summary>
static class OutlineAnalyzer
{
    const int MaxFallbackChars = 40;

    static readonly (string Name, Regex Pattern, int Level)[] NumberPatterns =
    [
        ("chapter", new Regex(@"^第\s*[一二三四五六七八九十百零〇\d]+\s*[章篇]"), 1),
        ("part", new Regex(@"^第\s*[一二三四五六七八九十百零〇\d]+\s*部分"), 1),
        ("section", new Regex(@"^第\s*[一二三四五六七八九十百零〇\d]+\s*节"), 2),
        ("cn_dun", new Regex(@"^[一二三四五六七八九十百零〇]{1,3}\s*[、.．]"), 1),
        ("cn_paren", new Regex(@"^[（(]\s*[一二三四五六七八九十百零〇]{1,3}\s*[)）]"), 2),
        ("num_dun", new Regex(@"^\d{1,2}\s*[、]"), 3),
        ("num_multi", new Regex(@"^\d{1,2}(?:\.\d{1,2}){1,4}\.?\s"), 3),
        ("num_dot", new Regex(@"^\d{1,2}\s*[.．]\s*\S"), 3),
        ("num_paren", new Regex(@"^[（(]\s*\d{1,2}\s*[)）]"), 4),
        ("num_rparen", new Regex(@"^\d{1,2}\s*[)）]"), 4),
        ("circle", new Regex(@"^[①-⑳⒈-⒚]"), 5),
        ("di_tiao", new Regex(@"^第\s*\d{1,3}\s*[条款项]"), 3),
    ];

    static readonly HashSet<string> FallbackPatterns = ["chapter", "part", "section", "cn_dun", "cn_paren", "num_dun", "num_dot"];
    static readonly Regex SentenceEnd = new(@"[。；;：:,，]$");
    static readonly Regex Leader = new(@"[.．·…]{3,}");
    static readonly Regex PageTail = new(@"\d{1,4}\s*$");
    static readonly Regex Whitespace = new(@"[\s\u3000]+");
    static readonly Regex TocStyle = new(@"^(?:toc|目录|contents)\s*([1-9１-９])?$", RegexOptions.IgnoreCase);
    static readonly Regex TocTitleStyle = new(@"^(?:toc\s*heading|toc\s*标题|目录标题)$", RegexOptions.IgnoreCase);
    static readonly Regex ContentsTitle = new(@"^(?:tableof)?contents$", RegexOptions.IgnoreCase);

    /// <summary>目录标题："目录""目 录""施工组织设计目录""表目录"等以目录、目次结尾的短行，或 Contents。</summary>
    public static bool IsTocTitle(string text)
    {
        var value = Whitespace.Replace(text ?? "", "");
        return (value.Length <= 20 && (value.EndsWith("目录", StringComparison.Ordinal) || value.EndsWith("目次", StringComparison.Ordinal))) || ContentsTitle.IsMatch(value);
    }

    /// <summary>目录标题样式（Word 的 TOC Heading、WPS 的目录标题）。</summary>
    public static bool IsTocTitleStyle(string? styleName, string? styleId)
    {
        return (styleName is not null && TocTitleStyle.IsMatch(styleName.Trim())) || (styleId is not null && TocTitleStyle.IsMatch(styleId));
    }

    public static (string Name, int Level)? MatchNumber(string text)
    {
        var value = text.Trim();
        if (value.Length == 0) return null;
        foreach (var (name, pattern, level) in NumberPatterns)
        {
            if (pattern.IsMatch(value)) return (name, level);
        }

        return null;
    }

    public static string NormalizeTitle(string text)
    {
        var value = Leader.Replace(text ?? "", "");
        value = value.Replace("\t", "");
        value = Regex.Replace(value, @"\s*\d{1,4}\s*$", "");
        value = Whitespace.Replace(value, "");
        value = value.Replace('（', '(').Replace('）', ')').Replace('．', '.').Replace('。', '.').Replace('：', ':').Replace('，', ',');
        return value.Trim();
    }

    static bool LooksLikeHeading(string text, int maxLength)
    {
        var value = text.Trim();
        if (value.Length == 0 || value.Length > maxLength) return false;
        if (SentenceEnd.IsMatch(value) || Leader.IsMatch(value) || value.Contains('\n')) return false;
        return !PageTail.IsMatch(value);
    }

    /// <param name="numberFallback">没有目录可依时是否按编号兜底；删除了目录的修复副本复查时沿用原文的认法，传 false。</param>
    public static Outline Analyze(DocumentModel model, bool numberFallback = true)
    {
        var toc = DetectToc(model);
        var useToc = toc.HasToc && toc.Entries.Count >= 3;
        var outline = new Outline { Toc = toc, UsedToc = useToc };
        var tocIndex = new Dictionary<string, List<int>>(StringComparer.Ordinal);
        if (useToc)
        {
            foreach (var entry in toc.Entries.Where(item => item.Normalized.Length > 0))
            {
                if (!tocIndex.TryGetValue(entry.Normalized, out var list)) tocIndex[entry.Normalized] = list = [];
                list.Add(entry.Level);
            }
        }

        var consumed = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var record in model.BodyParagraphs)
        {
            if (record.IsEmpty || toc.Paragraphs.Contains(record.Element)) continue;
            var text = record.Text.Trim();
            var normalized = NormalizeTitle(text);
            int? level = null;
            string? source = null;

            if (useToc && normalized.Length > 0 && tocIndex.TryGetValue(normalized, out var levels))
            {
                var used = consumed.GetValueOrDefault(normalized);
                if (used < levels.Count)
                {
                    consumed[normalized] = used + 1;
                    if (levels[used] > 0)
                    {
                        level = levels[used];
                        source = "toc";
                    }
                }
            }

            if (level is null && record.Format.HeadingLevel is >= 1 and <= 9 && text.Length <= 200)
            {
                level = record.Format.HeadingLevel;
                source = "style";
            }

            if (level is null && !useToc && numberFallback && MatchNumber(text) is { } match
                && FallbackPatterns.Contains(match.Name) && LooksLikeHeading(text, MaxFallbackChars))
            {
                level = match.Level;
                source = "pattern";
            }

            if (level is null || source is null) continue;
            outline.Levels[record.Element] = level.Value;
            outline.Sources[record.Element] = source;
        }

        if (!useToc) MarkManualToc(model, outline);
        foreach (var source in outline.Sources.Values)
        {
            outline.SourceCounts[source] = outline.SourceCounts.GetValueOrDefault(source) + 1;
        }

        return outline;
    }

    /// <summary>
    /// 手写目录：正文前部连续 3 条以上编号兜底认出的"标题"，文字与后文的标题逐一相同，
    /// 说明它们是手工录入的目录列表（常见于没有页码的"施工组织设计目录"）。
    /// 这些段落归入目录，不再当作标题检查；紧挨在列表前的"××目录"标题行一并归入。
    /// </summary>
    static void MarkManualToc(DocumentModel model, Outline outline)
    {
        var records = model.BodyParagraphs.Where(record => !record.IsEmpty).ToList();
        var lastIndex = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var index = 0; index < records.Count; index += 1)
        {
            if (outline.LevelOf(records[index].Element) is null) continue;
            lastIndex[NormalizeTitle(records[index].Text)] = index;
        }

        bool IsDuplicate(int index)
        {
            var record = records[index];
            return outline.SourceOf(record.Element) == "pattern"
                && lastIndex.TryGetValue(NormalizeTitle(record.Text), out var last)
                && last > index;
        }

        var start = 0;
        while (start < records.Count)
        {
            if (!IsDuplicate(start))
            {
                start += 1;
                continue;
            }

            var end = start;
            while (end + 1 < records.Count && IsDuplicate(end + 1)) end += 1;
            if (end - start + 1 >= 3)
            {
                if (start > 0 && IsTocTitle(records[start - 1].Text) && outline.LevelOf(records[start - 1].Element) is null)
                {
                    outline.Toc.Paragraphs.Add(records[start - 1].Element);
                }

                for (var index = start; index <= end; index += 1)
                {
                    var record = records[index];
                    outline.Levels.Remove(record.Element);
                    outline.Sources.Remove(record.Element);
                    outline.Toc.Paragraphs.Add(record.Element);
                    outline.Toc.Entries.Add(new TocEntry(0, record.Text, NormalizeTitle(record.Text)));
                }
            }

            start = end + 1;
        }
    }

    /// <summary>识别目录：TOC 域范围 + 目录样式 + 点导引/页码形状三重证据。</summary>
    static TocInfo DetectToc(DocumentModel model)
    {
        var info = new TocInfo();
        var paragraphs = model.BodyElement.Descendants(W.P).ToList();
        var position = new Dictionary<XElement, int>(ReferenceEqualityComparer.Instance);
        for (var index = 0; index < paragraphs.Count; index += 1) position[paragraphs[index]] = index;

        foreach (var field in FieldScanner.Scan(model.BodyElement).Where(item => item.Kind == "toc"))
        {
            info.HasToc = true;
            info.HasField = true;
            if (field.Begin is null || !position.TryGetValue(field.Begin, out var start)) continue;
            var end = field.End is not null && position.TryGetValue(field.End, out var found) ? found : Math.Min(start + 1200, paragraphs.Count - 1);
            for (var index = start; index <= end; index += 1)
            {
                // 域结束在下一个标题里（"目录域结束 + 分页 + 标题文字"同一段）时，这一段是正文，不算目录。
                var paragraph = paragraphs[index];
                if ((index == start || index == end) && OnlyOutside(paragraph, field)) continue;
                info.Paragraphs.Add(paragraph);
            }
        }

        var inField = new HashSet<XElement>(info.Paragraphs, ReferenceEqualityComparer.Instance);
        info.Styled.UnionWith(StyledToc(model, paragraphs, inField));
        foreach (var paragraph in paragraphs)
        {
            if (paragraph.Parent?.Name == W.Tc) continue;
            var level = TocLevelOfStyle(model, paragraph);
            var text = TextOf(model, paragraph);
            if (level is not null && (inField.Contains(paragraph) || info.Styled.Contains(paragraph)))
            {
                info.Paragraphs.Add(paragraph);
                info.HasToc = true;
                info.Entries.Add(new TocEntry(level.Value, text, NormalizeTitle(text)));
                continue;
            }

            var trimmed = text.Trim();
            if (trimmed.Length > 0 && (Leader.IsMatch(text) || text.Contains('\t')) && PageTail.IsMatch(text) && MatchNumber(trimmed) is not null)
            {
                info.Paragraphs.Add(paragraph);
                info.Entries.Add(new TocEntry(0, text, NormalizeTitle(text)));
            }
        }

        if (info.Entries.Count == 0 && info.Paragraphs.Count > 0)
        {
            foreach (var paragraph in paragraphs.Where(info.Paragraphs.Contains))
            {
                var text = DocumentModel.ParagraphText(paragraph);
                if (text.Trim().Length > 0) info.Entries.Add(new TocEntry(0, text, NormalizeTitle(text)));
            }
        }

        return info;
    }

    static string TextOf(DocumentModel model, XElement paragraph) => model.Records.TryGetValue(paragraph, out var record) ? record.Text : DocumentModel.ParagraphText(paragraph);

    static int? TocLevelOfStyle(DocumentModel model, XElement paragraph)
    {
        var styleId = W.ValOf(paragraph.Element(W.PPr)?.Element(W.PStyle));
        return TocLevelOfStyle(styleId is null ? null : model.Sheet.ById.GetValueOrDefault(styleId)?.DisplayName, styleId);
    }

    /// <summary>
    /// 域外套用目录样式的段落：成片出现，且前面有目录标题或过半以页码结尾才算目录（目录转成纯文本后的样子）；
    /// 正文里偶然套用目录样式、没有页码的段落不算。
    /// </summary>
    static HashSet<XElement> StyledToc(DocumentModel model, List<XElement> paragraphs, HashSet<XElement> inField)
    {
        var result = new HashSet<XElement>(ReferenceEqualityComparer.Instance);
        bool Member(int index) => paragraphs[index].Parent?.Name != W.Tc && !inField.Contains(paragraphs[index]) && TocLevelOfStyle(model, paragraphs[index]) is not null;
        for (var index = 0; index < paragraphs.Count; index += 1)
        {
            if (!Member(index)) continue;
            var start = index;
            while (index + 1 < paragraphs.Count && Member(index + 1)) index += 1;
            var texts = Enumerable.Range(start, index - start + 1).Select(item => TextOf(model, paragraphs[item])).Where(text => text.Trim().Length > 0).ToList();
            if (texts.Count == 0) continue;
            if (!TitledBefore(model, paragraphs, start) && texts.Count(text => PageTail.IsMatch(text)) * 2 < texts.Count) continue;
            for (var item = start; item <= index; item += 1) result.Add(paragraphs[item]);
        }

        return result;
    }

    /// <summary>前面最近的非空段落（中间最多隔两个空段落）是目录标题。</summary>
    static bool TitledBefore(DocumentModel model, List<XElement> paragraphs, int start)
    {
        for (var index = start - 1; index >= 0 && index >= start - 3; index -= 1)
        {
            var text = TextOf(model, paragraphs[index]);
            if (text.Trim().Length == 0) continue;
            var styleId = W.ValOf(paragraphs[index].Element(W.PPr)?.Element(W.PStyle));
            return IsTocTitle(text) || IsTocTitleStyle(styleId is null ? null : model.Sheet.ById.GetValueOrDefault(styleId)?.DisplayName, styleId);
        }

        return false;
    }

    /// <summary>段落里的文字全在域外（域开始之前或结束之后），域里没有文字。</summary>
    static bool OnlyOutside(XElement paragraph, FieldSpan field)
    {
        var inside = false;
        var outside = false;
        foreach (var text in paragraph.Descendants(W.T).Where(item => item.Value.Trim().Length > 0))
        {
            var simple = field.BeginMarker == field.EndMarker;
            var within = simple
                ? text.Ancestors().Contains(field.BeginMarker)
                : (field.BeginMarker is null || text.IsAfter(field.BeginMarker)) && (field.EndMarker is null || text.IsBefore(field.EndMarker));
            if (within) inside = true;
            else outside = true;
        }

        return outside && !inside;
    }

    public static int? TocLevelOfStyle(string? styleName, string? styleId)
    {
        foreach (var value in new[] { styleName, styleId })
        {
            if (string.IsNullOrWhiteSpace(value)) continue;
            var match = TocStyle.Match(value.Trim());
            if (!match.Success) continue;
            var group = match.Groups[1];
            if (!group.Success) return 1;
            var digit = group.Value[0];
            return digit >= '１' && digit <= '９' ? digit - '１' + 1 : digit - '0';
        }

        return null;
    }
}

sealed class FieldSpan
{
    public string Kind { get; set; } = "unknown";
    public XElement? Begin { get; init; }
    public XElement? End { get; set; }
    /// <summary>开始和结束标记（复杂域的 begin / end fldChar，简单域是 fldSimple 本身）。</summary>
    public XElement? BeginMarker { get; init; }
    public XElement? EndMarker { get; set; }
    public string Instruction { get; set; } = "";
}

/// <summary>按 fldChar begin/separate/end 配对扫描复杂域，并收集 instrText 指令。</summary>
static class FieldScanner
{
    public static List<FieldSpan> Scan(XElement root)
    {
        var fields = new List<FieldSpan>();
        var stack = new Stack<FieldSpan>();
        foreach (var element in root.Descendants())
        {
            if (element.Name == W.FldChar)
            {
                var type = W.Attr(element, "fldCharType");
                if (type == "begin")
                {
                    stack.Push(new FieldSpan { Begin = OwningParagraph(element), BeginMarker = element });
                }
                else if (type == "end" && stack.Count > 0)
                {
                    var field = stack.Pop();
                    field.End = OwningParagraph(element);
                    field.EndMarker = element;
                    field.Kind = Classify(field.Instruction);
                    fields.Add(field);
                }
            }
            else if (element.Name == W.InstrText && stack.Count > 0)
            {
                stack.Peek().Instruction += element.Value;
            }
            else if (element.Name == W.FldSimple)
            {
                var instruction = W.Attr(element, "instr") ?? "";
                var paragraph = OwningParagraph(element);
                fields.Add(new FieldSpan { Begin = paragraph, End = paragraph, BeginMarker = element, EndMarker = element, Instruction = instruction, Kind = Classify(instruction) });
            }
        }

        return fields;
    }

    static XElement? OwningParagraph(XElement element) => element.Ancestors(W.P).FirstOrDefault();

    public static string Classify(string instruction)
    {
        var value = instruction.Trim().ToUpperInvariant();
        var keyword = value.Split((char[]?)null, 2, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
        return keyword switch
        {
            "TOC" => "toc",
            "PAGEREF" => "pageref",
            "PAGE" => "page",
            "NUMPAGES" => "numpages",
            "HYPERLINK" => "hyperlink",
            _ => keyword.ToLowerInvariant(),
        };
    }
}
