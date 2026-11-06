using System.Text.RegularExpressions;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>
/// 把模版提取 Agent 通读正文后补充的位置和要去掉的原文解析为候选：at 指模版正文中的可写段落，按 op 用 before/after/text 在段内唯一定位。
/// 程序只保证能够执行（定位存在且唯一、范围不交叉）；哪里填写、去掉什么由 Agent 按含义判断，与已选候选是否冲突由写入前的重叠检查判断。
/// </summary>
static class TemplatePositionResolver
{
    public const string InsertOp = "insert";
    public const string SpanOp = "span";
    public const string ChooseOp = "choose";
    public const string AttachmentOp = "attachment";
    public const string TableOp = "table";
    /// <summary>去掉的原文写成格式文字控件，id 由程序按顺序编号。</summary>
    public const string RemovalIdPrefix = "rm";

    /// <summary>解析全部补充位置并追加到扫描结果的候选中；有问题时汇总后一次报错。</summary>
    public static List<TemplateFieldCandidate> Resolve(IReadOnlyList<TemplatePosition>? positions, TemplateFieldCandidateFile scan)
    {
        var entries = new Dictionary<string, TemplateParagraphEntry>(StringComparer.Ordinal);
        foreach (var entry in scan.Paragraphs) entries.TryAdd(entry.Locator, entry);
        var candidateIds = scan.Candidates.Select(item => item.CandidateId).ToHashSet(StringComparer.Ordinal);
        var usedIds = new HashSet<string>(StringComparer.Ordinal);
        var order = scan.Candidates.Select(item => item.Order).DefaultIfEmpty(-1).Max() + 1;
        var errors = new List<string>();
        var resolved = new List<TemplateFieldCandidate>();

        foreach (var position in positions ?? [])
        {
            var id = (position.Id ?? "").Trim();
            var at = (position.At ?? "").Trim();
            var op = (position.Op ?? "").Trim().ToLowerInvariant();
            var label = id.Length > 0 ? id : $"{at} 处缺少 id 的补充位置";
            if (id.Length == 0) { errors.Add($"{label}：每个补充位置都要有 id"); continue; }
            if (!usedIds.Add(id)) { errors.Add($"{id}：id 重复"); continue; }
            if (candidateIds.Contains(id)) { errors.Add($"{id}：与已有候选 id 相同，请换一个（如 p1、p2）"); continue; }
            if (!entries.TryGetValue(at, out var entry)) { errors.Add($"{id}：定位号“{at}”不在投标模版正文中"); continue; }
            if (entry.Chapter is null) { errors.Add($"{id}：{at} 不在已确认的章节内"); continue; }
            if (!entry.Writable)
            {
                errors.Add($"{id}：{at} 标有〔不可标记〕（含域、图片、修订或已有控件），不能补充位置");
                continue;
            }

            var problem = op switch
            {
                InsertOp => ResolveInsert(position, entry, out var candidate) ?? Add(candidate),
                SpanOp => ResolveRange(position, entry, TemplateFieldKinds.TextSpan, out var candidate) ?? Add(candidate),
                ChooseOp => ResolveChoose(position, entry, out var candidate) ?? Add(candidate),
                AttachmentOp => ResolveAttachment(position, entry, out var candidate) ?? Add(candidate),
                TableOp => ResolveTable(position, entry, out var candidate) ?? Add(candidate),
                _ => $"op 只能是 {InsertOp}、{SpanOp}、{ChooseOp}、{AttachmentOp} 或 {TableOp}",
            };
            if (problem is not null) errors.Add($"{id}：{problem}");

            string? Add(TemplateFieldCandidate? candidate)
            {
                candidate!.CandidateId = id;
                candidate.Order = order++;
                resolved.Add(candidate);
                return null;
            }
        }

        if (errors.Count > 0)
        {
            throw new InvalidOperationException($"补充位置无效：{string.Join("；", errors.Take(10))}。请修改分类文件中的 positions 后重新提交。");
        }

        // 补充位置之间不能重叠；与规则候选的冲突只在两者都被选用时才有影响，交给写入前的重叠检查。
        var overlaps = resolved
            .SelectMany((item, index) => resolved.Skip(index + 1)
                .Where(other => ReferenceEquals(item.Target, other.Target)
                    && TemplateFieldScanner.RangesOverlap(item.Start, item.Length, other.Start, other.Length))
                .Select(other => $"{item.CandidateId} 与 {other.CandidateId}"))
            .ToList();
        if (overlaps.Count > 0)
        {
            throw new InvalidOperationException($"补充位置无效：这些补充位置在同一段内重叠，只保留一个：{string.Join("、", overlaps.Take(10))}。");
        }

        scan.Candidates.AddRange(resolved);
        return resolved;
    }

    static string? ResolveInsert(TemplatePosition position, TemplateParagraphEntry entry, out TemplateFieldCandidate? candidate)
    {
        candidate = null;
        var before = position.Before ?? "";
        var after = position.After ?? "";
        if (position.Text is not null || position.Options is not null) return "insert 只用 before 和 after 定位，不写 text 或 options";
        if (before.Length == 0 && after.Length == 0) return "insert 至少要给出 before 或 after";
        var pattern = (before.Length > 0 ? $"(?<={ToPattern(before)})" : "") + (after.Length > 0 ? $"(?={ToPattern(after)})" : "");
        var matches = Regex.Matches(entry.Text, pattern, RegexOptions.CultureInvariant);
        if (matches.Count != 1) return MatchProblem(entry, matches.Count, "before/after 之间的位置");
        candidate = Create(entry, TemplateFieldKinds.InsertedBlank, entry.Paragraph, matches[0].Index, 0);
        return null;
    }

    static string? ResolveRange(TemplatePosition position, TemplateParagraphEntry entry, string kind, out TemplateFieldCandidate? candidate)
    {
        candidate = null;
        var text = position.Text ?? "";
        if (text.Length == 0) return kind switch
        {
            TemplateFieldKinds.Alternatives => $"{ChooseOp} 必须给出 text",
            TemplateFieldKinds.FormatText => "必须给出要去掉的 text",
            _ => $"{SpanOp} 必须给出 text",
        };
        if (kind != TemplateFieldKinds.Alternatives && position.Options is not null) return "span 不写 options";
        var before = position.Before ?? "";
        var after = position.After ?? "";
        var pattern = (before.Length > 0 ? $"(?<={ToPattern(before)})" : "")
            + ToPattern(text)
            + (after.Length > 0 ? $"(?={ToPattern(after)})" : "");
        var matches = Regex.Matches(entry.Text, pattern, RegexOptions.CultureInvariant);
        if (matches.Count != 1) return MatchProblem(entry, matches.Count, $"“{text}”");
        candidate = Create(entry, kind, entry.Paragraph, matches[0].Index, matches[0].Length);
        return null;
    }

    static string? ResolveChoose(TemplatePosition position, TemplateParagraphEntry entry, out TemplateFieldCandidate? candidate)
    {
        candidate = null;
        if (entry.InTextBox) return "文本框中的段落不能使用 choose";
        var problem = ResolveRange(position, entry, TemplateFieldKinds.Alternatives, out candidate);
        if (problem is not null) return problem;
        var covered = candidate!.Text ?? "";
        var options = (position.Options ?? [])
            .Select(item => (item ?? "").Trim())
            .ToList();
        if (options.Count < 2) return "choose 至少要给出两个 options";
        if (options.Any(item => item.Length == 0)) return "options 中有空选项";
        if (options.Distinct(StringComparer.Ordinal).Count() != options.Count) return "options 不能重复";
        var missing = options.Where(item => !covered.Contains(item, StringComparison.Ordinal)).ToList();
        if (missing.Count > 0) return $"选项必须是 text 中原有的文字，不能自拟：{string.Join("、", missing)}";
        candidate.Options = options;
        return null;
    }

    /// <summary>段落之后紧跟空段落时用它作附件位（如单元格里标签下的留白），否则在该段之后插入附件位。</summary>
    static string? ResolveAttachment(TemplatePosition position, TemplateParagraphEntry entry, out TemplateFieldCandidate? candidate)
    {
        candidate = null;
        if (position.Before is not null || position.After is not null || position.Text is not null || position.Options is not null)
        {
            return "attachment 只写 at，附件位放在该段之后";
        }
        if (!entry.InTextBox && entry.Paragraph.NextSibling() is Wp.Paragraph next && IsBlankParagraph(next))
        {
            candidate = Create(entry, TemplateFieldKinds.AttachmentSlot, next, 0, 0);
            candidate.FallbackTarget = null;
            return null;
        }
        candidate = Create(entry, TemplateFieldKinds.AttachmentNote, entry.Paragraph, entry.Text.Length, 0);
        return null;
    }

    /// <summary>新建表格的位置：整段替换 at 段落；at 为本章标题段时改为插在其后（写入前按标题段确定）。只能是正文顶层段落。</summary>
    static string? ResolveTable(TemplatePosition position, TemplateParagraphEntry entry, out TemplateFieldCandidate? candidate)
    {
        candidate = null;
        if (position.Before is not null || position.After is not null || position.Text is not null || position.Options is not null)
        {
            return "table 只写 at，表格替换该段（该段是本章标题段时插在其后）";
        }
        if (!TopLevelPattern.IsMatch(entry.Location)) return "table 只能指向正文中的顶层段落（不在表格、文本框或内容控件中）";
        candidate = Create(entry, TemplateFieldKinds.TableSlot, entry.Paragraph, 0, entry.Text.Length);
        return null;
    }

    static readonly Regex TopLevelPattern = new(@"^body/\d+:p$", RegexOptions.CultureInvariant);

    /// <summary>
    /// 解析要去掉的原文：同段内唯一的一段原文，生成格式文字候选（id 为 rm1、rm2…），写入时包进格式文字控件，导出和预览时去掉。
    /// 文本框中的文字有兼容显示副本无法同步，不能去掉。有问题时汇总后一次报错。
    /// </summary>
    public static List<TemplateFieldCandidate> ResolveRemovals(IReadOnlyList<TemplateRemoval>? removals, TemplateFieldCandidateFile scan)
    {
        var entries = new Dictionary<string, TemplateParagraphEntry>(StringComparer.Ordinal);
        foreach (var entry in scan.Paragraphs) entries.TryAdd(entry.Locator, entry);
        var errors = new List<string>();
        var resolved = new List<TemplateFieldCandidate>();
        for (var index = 0; index < (removals?.Count ?? 0); index += 1)
        {
            var removal = removals![index];
            var at = (removal.At ?? "").Trim();
            var label = $"removals 第 {index + 1} 项（{at}）";
            if (!entries.TryGetValue(at, out var entry)) { errors.Add($"{label}：定位号不在投标模版正文中"); continue; }
            if (entry.Chapter is null) { errors.Add($"{label}：不在已确认的章节内"); continue; }
            if (!entry.Writable) { errors.Add($"{label}：该段标有〔不可标记〕，不能去掉其中的文字"); continue; }
            if (entry.InTextBox) { errors.Add($"{label}：文本框中的文字不能去掉"); continue; }
            var position = new TemplatePosition { Before = removal.Before, After = removal.After, Text = removal.Text ?? "" };
            var problem = ResolveRange(position, entry, TemplateFieldKinds.FormatText, out var candidate);
            if (problem is not null) { errors.Add($"{label}：{problem}"); continue; }
            candidate!.CandidateId = $"{RemovalIdPrefix}{index + 1}";
            resolved.Add(candidate);
        }
        if (errors.Count > 0)
        {
            throw new InvalidOperationException($"removals 无效：{string.Join("；", errors.Take(10))}。请修改分类文件后重新提交。");
        }
        var overlaps = resolved
            .SelectMany((item, index) => resolved.Skip(index + 1)
                .Where(other => ReferenceEquals(item.Target, other.Target)
                    && TemplateFieldScanner.RangesOverlap(item.Start, item.Length, other.Start, other.Length))
                .Select(other => $"{item.Location} 中的“{item.Text}”与“{other.Text}”"))
            .ToList();
        if (overlaps.Count > 0)
        {
            throw new InvalidOperationException($"removals 无效：同一段内去掉的文字重叠，合并成一项：{string.Join("、", overlaps.Take(10))}。");
        }
        return resolved;
    }

    static bool IsBlankParagraph(Wp.Paragraph paragraph) =>
        TemplateFieldScanner.IsSimpleParagraph(paragraph)
        && TemplateFieldScanner.ReadParagraphText(paragraph).Trim().Length == 0;

    static TemplateFieldCandidate Create(TemplateParagraphEntry entry, string kind, Wp.Paragraph target, int start, int length)
    {
        // 附件位落在下一个空段落时，上下文标在该段末尾。
        var onEntry = ReferenceEquals(target, entry.Paragraph);
        return new TemplateFieldCandidate
        {
            Kind = kind,
            Location = entry.Location,
            Text = onEntry && length > 0 ? entry.Text.Substring(start, length) : null,
            Context = TemplateFieldScanner.MergeCellContext(
                entry.CellContext ?? "",
                TemplateFieldScanner.BuildMarkedContext(entry.Text, onEntry ? start : entry.Text.Length, onEntry ? length : 0)),
            ChapterName = entry.ChapterName,
            Chapter = entry.Chapter,
            TableTitle = entry.TableTitle,
            ColumnHeader = entry.ColumnHeader,
            GroupTitle = entry.GroupTitle,
            TableId = entry.TableId,
            RowNumber = entry.RowNumber,
            ColumnNumber = entry.ColumnNumber,
            Target = target,
            FallbackTarget = entry.Fallback,
            Start = start,
            Length = length,
            FromPosition = true,
        };
    }

    const string BlankClass = "[ \u3000\u00a0]";
    const string UnderscoreClass = "[_\uff3f]";

    /// <summary>
    /// 锚点按原文逐字匹配，但连续的空格类字符（␣、半角、全角、不换行空格）整体匹配段内一整段空白，
    /// 连续的下划线（_、＿）整体匹配一整段下划线，不论个数，Agent 不必数空位长度；⇥ 匹配制表符，⏎ 不占字符、忽略。
    /// </summary>
    static string ToPattern(string value)
    {
        var text = value.Replace(TemplateTextRenderer.BreakMark.ToString(), "");
        var builder = new System.Text.StringBuilder();
        for (var index = 0; index < text.Length;)
        {
            var item = text[index];
            if (IsBlank(item) || IsUnderscore(item))
            {
                Func<char, bool> same = IsBlank(item) ? IsBlank : IsUnderscore;
                var run = IsBlank(item) ? BlankClass : UnderscoreClass;
                while (index < text.Length && same(text[index])) index += 1;
                builder.Append($"(?<!{run}){run}+(?!{run})");
                continue;
            }
            builder.Append(item == TemplateTextRenderer.TabMark ? @"\t" : Regex.Escape(item.ToString()));
            index += 1;
        }
        return builder.ToString();
    }

    static bool IsBlank(char item) => item is TemplateTextRenderer.BlankMark or ' ' or '\u3000' or '\u00a0';

    static bool IsUnderscore(char item) => item is '_' or '\uff3f';

    static string MatchProblem(TemplateParagraphEntry entry, int count, string target) => count == 0
        ? $"在 {entry.Locator} 中找不到{target}，该段原文：{TemplateTextRenderer.Show(entry.Text)}"
        : $"在 {entry.Locator} 中命中 {count} 处{target}，请加长 before/after 使其唯一；该段原文：{TemplateTextRenderer.Show(entry.Text)}";
}
