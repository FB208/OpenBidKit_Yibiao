using System.Text;
using System.Text.RegularExpressions;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>
/// 把扫描结果写成模版提取 Agent 通读的文字：按章节分组，每个非空段落一行“定位号  文字”。
/// 模版正文（Render）在原位标出已识别的候选，供分类和补充位置；效果正文（RenderPreview）按分类结果显示导出后的样子，供 Agent 审阅。
/// Agent 补充位置时用定位号指段落、用段内文字唯一定位（见 TemplatePositionResolver），两边的文字口径相同。
/// </summary>
static class TemplateTextRenderer
{
    public const string FileName = "template-text.txt";
    public const string PreviewFileName = "template-preview.txt";
    /// <summary>连续空格中的每个空格显示为此标记；补充位置的锚点里它匹配任意一个空格类字符。</summary>
    public const char BlankMark = '␣';
    /// <summary>制表符显示为此标记，锚点里它匹配制表符。</summary>
    public const char TabMark = '⇥';
    /// <summary>段内换行和分页显示为此标记；它们不占字符，锚点里忽略。</summary>
    public const char BreakMark = '⏎';

    static readonly Regex BlankRunPattern = new(@"[ 　 ]{2,}", RegexOptions.CultureInvariant | RegexOptions.Compiled);
    static readonly Regex LetterPattern = new(@"\p{L}|\p{N}", RegexOptions.CultureInvariant | RegexOptions.Compiled);

    const string LocatorNote = "定位号中 b 为正文块号，.r/.c 为表格行号和行内第几个单元格，.p 为单元格内第几段，.s 为内容控件内第几块，.x 为文本框，.n 为其他容器内第几个子元素。";
    const string MarkNote = "␣ 表示连续空格中的一个空格，⇥ 表示制表符，⏎ 表示段内换行或分页（不占字符）；空段落已省略。";

    /// <summary>模版正文：候选在原位标出；每章开头写章节 id 和按目录标题认定的默认标题段。</summary>
    public static string Render(TemplateFieldCandidateFile scan)
    {
        var headings = scan.Chapters.Select(chapter => TemplateHeadings.FindDefault(scan, chapter, [])).ToList();
        var intro = $"投标模版正文：每行一个段落，格式为“定位号  文字”。{LocatorNote}\n"
            + $"〔c_…〕为已识别的候选插入点，〔c_…：原文〕为覆盖该原文的候选；{MarkNote}〔不可标记〕的段落不能补充位置或去掉文字。\n"
            + "每章标题行给出章节 id 和程序按目录标题认定的默认标题段（导出时加章节编号的段落），“无”表示导出时按目录标题插入一段。\n";
        return RenderCore(
            scan,
            scan.Candidates,
            (candidate, original) => original.Length == 0 ? $"〔{candidate.CandidateId}〕" : $"〔{candidate.CandidateId}：{original}〕",
            (chapter, index) => $"【章节 {chapter.Id}：{chapter.Title}】默认标题段：{HeadingLabel(headings[index])}",
            intro,
            showWritable: true);
    }

    /// <summary>
    /// 效果正文：按分类结果显示导出后的样子。labels 为选用的字段候选及其显示（【字段名】等），removals 显示为〔已去掉：原文〕，
    /// 未选用的候选按原文显示；每章开头写实际标题段。
    /// </summary>
    public static string RenderPreview(
        TemplateFieldCandidateFile scan,
        IReadOnlyDictionary<TemplateFieldCandidate, string> labels,
        IReadOnlyList<TemplateFieldCandidate> removals,
        IReadOnlyList<TemplateParagraphEntry?> headings,
        IReadOnlyList<List<TemplateRepeatItem>> repeats)
    {
        var intro = $"投标模版效果正文：按当前分类显示导出后的样子，每行一个段落，格式为“定位号  文字”，定位号与投标模版正文相同。{LocatorNote}\n"
            + "【字段名】为填写位置，【字段名←原文】为替换该原文的填写位置，〔择一 字段名：原文〕〔勾选 字段名：原文〕保留原文供选择，〔附件 字段名〕为图片位置，"
            + $"〔规则 列名〕〔规则表 名称〕由规则和页码编制，〔已去掉：原文〕为导出时去掉的文字；{MarkNote}\n"
            + "〔条目 清单id·第N条〕标出可重复条目中的段落，填写时按实际条数使用，未用到的条目导出时删除。\n"
            + "每章标题行给出导出时加章节编号的标题段。\n";
        var shown = labels.Keys.Concat(removals).ToList();
        return RenderCore(
            scan,
            shown,
            (candidate, original) => candidate.Kind == TemplateFieldKinds.FormatText
                ? $"〔已去掉：{original}〕"
                : string.Format(labels[candidate], original),
            (chapter, index) => $"【章节 {chapter.Id}：{chapter.Title}】标题段：{HeadingLabel(headings[index], chapter.Title)}",
            intro,
            showWritable: false,
            entry => TemplateRepeats.Locate(repeats, entry.Paragraph) is { } item ? TemplateRepeats.PreviewLabel(item) : "");
    }

    /// <summary>
    /// 字段在效果正文中的显示，{0} 处为原文：替换类为【名称】（原文有文字时带“←原文”），勾选和择一保留原文，附件、规则表、规则单元格按类型标出。
    /// </summary>
    public static string PreviewLabel(TemplateFieldCandidate candidate, IReadOnlyList<string> names, bool rule)
    {
        var name = string.Join("、", names).Replace("{", "{{").Replace("}", "}}");
        if (rule) return candidate.Kind == TemplateFieldKinds.TableSlot ? $"〔规则表 {name}〕" : $"〔规则 {name}〕";
        return candidate.Kind switch
        {
            TemplateFieldKinds.CheckboxGroup => $"〔勾选 {name}：{{0}}〕",
            TemplateFieldKinds.Alternatives => $"〔择一 {name}：{{0}}〕",
            TemplateFieldKinds.AttachmentSlot or TemplateFieldKinds.AttachmentNote => $"〔附件 {name}〕",
            _ when LetterPattern.IsMatch(candidate.Text ?? "") && !candidate.Kind.Equals(TemplateFieldKinds.ExistingControl, StringComparison.Ordinal)
                => $"【{name}←{{0}}】",
            _ => $"【{name}】",
        };
    }

    static string HeadingLabel(TemplateParagraphEntry? heading, string? title = null) => heading is null
        ? title is null ? "无" : $"无（导出时插入“{title}”）"
        : $"{heading.Locator} {Show(heading.Text).Trim()}";

    static string RenderCore(
        TemplateFieldCandidateFile scan,
        IReadOnlyList<TemplateFieldCandidate> candidates,
        Func<TemplateFieldCandidate, string, string> mark,
        Func<TemplateChapterRange, int, string> header,
        string intro,
        bool showWritable,
        Func<TemplateParagraphEntry, string>? prefix = null)
    {
        var entries = new Dictionary<Wp.Paragraph, TemplateParagraphEntry>(ReferenceEqualityComparer.Instance);
        foreach (var entry in scan.Paragraphs) entries.TryAdd(entry.Paragraph, entry);

        // 可写段落中的候选按偏移嵌进文字；表格位置、不可写段落中的候选列在行尾；落不到已登记段落的候选单独成行。
        var inline = new Dictionary<Wp.Paragraph, List<TemplateFieldCandidate>>(ReferenceEqualityComparer.Instance);
        var trailing = new Dictionary<Wp.Paragraph, List<TemplateFieldCandidate>>(ReferenceEqualityComparer.Instance);
        var unplaced = new List<TemplateFieldCandidate>();
        foreach (var candidate in candidates)
        {
            var host = candidate.Target as Wp.Paragraph ?? candidate.Target?.Ancestors<Wp.Paragraph>().FirstOrDefault();
            if (host is null || !entries.TryGetValue(host, out var entry))
            {
                unplaced.Add(candidate);
                continue;
            }
            var atEnd = candidate.Kind is TemplateFieldKinds.TableSlot
                || !entry.Writable
                || !ReferenceEquals(candidate.Target, host);
            var target = atEnd ? trailing : inline;
            if (!target.TryGetValue(host, out var list)) target[host] = list = [];
            list.Add(candidate);
        }

        var items = scan.Paragraphs
            .Select((entry, index) => (Key: entry.OrderKey, Kind: 0, Index: index, Entry: (TemplateParagraphEntry?)entry, Candidate: (TemplateFieldCandidate?)null))
            .Concat(unplaced.Select((candidate, index) => (Key: candidate.Order, Kind: 1, Index: index, Entry: (TemplateParagraphEntry?)null, Candidate: (TemplateFieldCandidate?)candidate)))
            .OrderBy(item => item.Key)
            .ThenBy(item => item.Kind)
            .ThenBy(item => item.Index);

        var builder = new StringBuilder(intro);
        TemplateChapterRange? currentChapter = null;
        foreach (var item in items)
        {
            var chapter = item.Entry?.Chapter ?? item.Candidate?.Chapter;
            if (chapter is null) continue;
            var line = item.Entry is { } entry
                ? RenderEntry(entry, inline.GetValueOrDefault(entry.Paragraph), trailing.GetValueOrDefault(entry.Paragraph), mark, showWritable, prefix?.Invoke(entry) ?? "")
                : $"{TemplateFieldScanner.ToLocator(item.Candidate!.Location)}  {(showWritable ? "〔不可标记〕" : "")}{mark(item.Candidate!, Show(item.Candidate!.Text ?? ""))}";
            if (line is null) continue;
            if (!ReferenceEquals(chapter, currentChapter))
            {
                var index = scan.Chapters.FindIndex(range => range.StartBlock == chapter.StartBlock);
                builder.Append('\n').Append(header(chapter, index)).Append('\n');
                currentChapter = chapter;
            }
            builder.Append(line).Append('\n');
        }
        return builder.ToString();
    }

    /// <summary>连续空格逐个显示为 ␣（单个空格照常显示），制表符显示为 ⇥。</summary>
    public static string Show(string value) =>
        BlankRunPattern.Replace(value ?? "", match => new string(BlankMark, match.Length)).Replace('\t', TabMark);

    static string? RenderEntry(
        TemplateParagraphEntry entry,
        List<TemplateFieldCandidate>? inline,
        List<TemplateFieldCandidate>? trailing,
        Func<TemplateFieldCandidate, string, string> mark,
        bool showWritable,
        string prefix)
    {
        var text = entry.Text;
        var content = new StringBuilder();
        var extra = new List<TemplateFieldCandidate>(trailing ?? []);
        // 换行和分页不占字符，按偏移插入 ⏎；候选起点处的断点显示在候选之前。
        var breaks = new Queue<int>(entry.BreakOffsets.Order());
        string Piece(int from, int to, bool includeEnd)
        {
            var piece = new StringBuilder();
            var position = from;
            while (breaks.Count > 0 && (breaks.Peek() < to || includeEnd && breaks.Peek() == to))
            {
                var at = Math.Max(position, breaks.Dequeue());
                piece.Append(Show(text[position..at])).Append(BreakMark);
                position = at;
            }
            return piece.Append(Show(text[position..to])).ToString();
        }
        var cursor = 0;
        foreach (var candidate in (inline ?? []).OrderBy(item => item.Start).ThenBy(item => item.Length))
        {
            if (candidate.Start < cursor || candidate.Start + candidate.Length > text.Length)
            {
                extra.Add(candidate);
                continue;
            }
            content.Append(Piece(cursor, candidate.Start, includeEnd: true));
            content.Append(mark(candidate, candidate.Length == 0 ? "" : Piece(candidate.Start, candidate.Start + candidate.Length, includeEnd: false)));
            cursor = candidate.Start + candidate.Length;
        }
        content.Append(Piece(cursor, text.Length, includeEnd: true));
        var marks = string.Concat(extra.OrderBy(item => item.Order).Select(item => mark(item, Show(item.Text ?? ""))));
        if (text.Trim().Length == 0 && content.ToString().Trim().Length == 0 && marks.Length == 0) return null;
        var body = text.Trim().Length == 0 ? $"（空）{content}" : content.ToString();
        return $"{entry.Locator}  {prefix}{(showWritable && !entry.Writable ? "〔不可标记〕" : "")}{body}{marks}";
    }
}
