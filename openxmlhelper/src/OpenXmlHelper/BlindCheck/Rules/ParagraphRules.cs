using Yibiao.OpenXmlHelper.BlindCheck.Model;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Rules;

/// <summary>
/// 段落格式：对齐、行距、首行缩进、段前段后、段前分页。表格段落不查（表格另有配置）；
/// 行距、段前段后连标题一起查（招标文件通常写"所有标题及正文"），对齐、首行缩进只查正文，图名、表名不查；
/// 只有图片的段落不按正文行距和缩进判定。
/// </summary>
static class ParagraphRules
{
    static readonly Dictionary<string, string> AlignNames = new(StringComparer.Ordinal)
    {
        ["left"] = "左对齐", ["start"] = "左对齐", ["center"] = "居中", ["right"] = "右对齐", ["end"] = "右对齐",
        ["both"] = "两端对齐", ["justify"] = "两端对齐", ["distribute"] = "分散对齐",
    };

    static readonly Dictionary<string, string[]> AlignEquivalents = new(StringComparer.Ordinal)
    {
        ["left"] = ["left", "start", ""],
        ["right"] = ["right", "end"],
        ["center"] = ["center"],
        ["both"] = ["both", "justify"],
    };

    public static IEnumerable<RuleSpec> All()
    {
        yield return new RuleSpec { Id = "para.alignment", Title = "段落对齐方式", Category = "paragraph", Severity = Severity.Medium, InTable = false, Kinds = RuleKinds.BodyText, SkipObjectOnly = true, PerParagraph = CheckAlignment };
        yield return new RuleSpec { Id = "para.line_spacing", Title = "行距", Category = "paragraph", Severity = Severity.Medium, InTable = false, SkipObjectOnly = true, PerParagraph = CheckLineSpacing };
        yield return new RuleSpec { Id = "para.first_line_indent", Title = "首行缩进", Category = "paragraph", Severity = Severity.Medium, InTable = false, Kinds = RuleKinds.BodyText, SkipObjectOnly = true, PerParagraph = CheckFirstLineIndent };
        yield return new RuleSpec { Id = "para.space_before_after", Title = "段前段后间距", Category = "paragraph", Severity = Severity.Low, InTable = false, SkipObjectOnly = true, PerParagraph = CheckSpacing };
        yield return new RuleSpec { Id = "para.page_break_before", Title = "段前分页", Category = "paragraph", Severity = Severity.Low, PerParagraph = CheckPageBreakBefore };
        yield return new RuleSpec { Id = "para.snap_to_grid", Title = "对齐到网格", Category = "paragraph", Severity = Severity.Low, InTable = false, SkipObjectOnly = true, PerParagraph = CheckSnapToGrid };
    }

    public static string AlignName(string? value)
    {
        if (string.IsNullOrEmpty(value)) return "左对齐（未设置）";
        return AlignNames.GetValueOrDefault(value, value);
    }

    public static bool AlignMatches(string target, string? current)
    {
        var allowed = AlignEquivalents.GetValueOrDefault(target, [target]);
        return allowed.Contains(current ?? "");
    }

    static IEnumerable<Finding> CheckAlignment(RuleContext context, RuleSpec rule, ParaRecord record)
    {
        var target = context.TargetFor(record).Target.Alignment;
        if (string.IsNullOrEmpty(target) || context.Groups.Captions.Contains(record.Element)) yield break;
        var current = record.Format.Alignment;
        if (AlignMatches(target, current)) yield break;
        // 要求左对齐时用了两端对齐，视觉几乎一致，降为低风险。
        var severity = target == "left" && current is "both" or "justify" ? Severity.Low : (Severity?)null;
        yield return context.At(rule, record, "段落对齐方式不符合要求",
            $"当前「{AlignName(current)}」，要求「{AlignName(target)}」",
            "开始 → 段落 → 对齐方式",
            context.Origin(record.Format.Sources.GetValueOrDefault("jc"), record), severity);
    }

    static string RuleName(string? rule) => rule switch
    {
        "exact" => "固定值",
        "atLeast" => "最小值",
        _ => "多倍行距",
    };

    static IEnumerable<Finding> CheckLineSpacing(RuleContext context, RuleSpec rule, ParaRecord record)
    {
        var target = context.TargetFor(record).Target;
        var format = record.Format;
        var origin = context.Origin(format.Sources.GetValueOrDefault("spacing.line"), record);
        var currentRule = format.LineRule ?? "auto";

        if (target.LineRule == "multiple")
        {
            if (target.LineMultiple is not { } wantMultiple) yield break;
            if (currentRule != "auto")
            {
                yield return context.At(rule, record, "行距类型不符合要求",
                    $"当前「{RuleName(currentRule)} {Units.Number(format.LinePt ?? 0)} 磅」，要求「{Units.Number(wantMultiple)} 倍行距」",
                    "开始 → 段落 → 行距 → 多倍行距", origin);
                yield break;
            }

            var currentMultiple = format.LineMultiple ?? 1.0;
            if (Math.Abs(currentMultiple - wantMultiple) > 0.02)
            {
                yield return context.At(rule, record, "行距倍数不符合要求",
                    $"当前 {Units.Number(currentMultiple)} 倍，要求 {Units.Number(wantMultiple)} 倍",
                    "开始 → 段落 → 行距 → 多倍行距", origin);
            }

            yield break;
        }

        if (target.LinePt is not { } wantPt) yield break;
        var wantName = RuleName(target.LineRule);
        if (format.LinePt is not { } currentPt)
        {
            var current = format.LineMultiple is { } multiple ? $"{Units.Number(multiple)} 倍行距" : "单倍行距（未设置）";
            yield return context.At(rule, record, $"行距未设为{wantName}",
                $"当前「{current}」，要求「{wantName} {Units.Number(wantPt)} 磅」",
                $"开始 → 段落 → 行距 → {wantName}，设置值 {Units.Number(wantPt)} 磅", origin);
            yield break;
        }

        if (currentRule != target.LineRule)
        {
            yield return context.At(rule, record, "行距类型不符合要求",
                $"当前「{RuleName(currentRule)} {Units.Number(currentPt)} 磅」，要求「{wantName} {Units.Number(wantPt)} 磅」",
                $"开始 → 段落 → 行距 → {wantName}", origin);
            yield break;
        }

        if (Math.Abs(currentPt - wantPt) > target.ToleranceLinePt)
        {
            yield return context.At(rule, record, "行距数值不符合要求",
                $"当前 {Units.Number(currentPt)} 磅，要求 {Units.Number(wantPt)} 磅",
                $"开始 → 段落 → 行距 → {wantName}，设置值 {Units.Number(wantPt)} 磅", origin);
        }
    }

    static IEnumerable<Finding> CheckFirstLineIndent(RuleContext context, RuleSpec rule, ParaRecord record)
    {
        var target = context.TargetFor(record).Target;
        if (target.FirstLineIndentChars is not { } want || context.Groups.Captions.Contains(record.Element)) yield break;
        var current = record.Format.EffectiveFirstLineChars() ?? 0;
        if (Math.Abs(current - want) <= target.ToleranceIndentChars) yield break;
        yield return context.At(rule, record, "首行缩进不符合要求",
            $"当前 {Units.Number(current)} 字符，要求 {Units.Number(want)} 字符",
            $"开始 → 段落 → 特殊 → 首行，缩进值 {Units.Number(want)} 字符",
            context.Origin(record.Format.Sources.GetValueOrDefault("ind"), record));
    }

    static IEnumerable<Finding> CheckSpacing(RuleContext context, RuleSpec rule, ParaRecord record)
    {
        var target = context.TargetFor(record).Target;
        var format = record.Format;
        // 自动间距（多见于从网页粘贴的内容）由 Word 按约 14 磅显示，不等于任何明确的磅值要求。
        if (target.SpaceBeforePt is { } autoBefore && format.BeforeAutoSpacing)
        {
            yield return context.At(rule, record, "段前间距为自动",
                $"当前段前为「自动」（Word 约按 14 磅显示），要求 {Units.Number(autoBefore)} 磅",
                $"开始 → 段落 → 间距 → 段前，取消「自动」并设为 {Units.Number(autoBefore)} 磅");
        }
        else if (target.SpaceBeforePt is { } wantBefore)
        {
            var current = format.EffectiveSpaceBeforePt();
            if (Math.Abs(current - wantBefore) > 0.5)
            {
                yield return context.At(rule, record, "段前间距不符合要求",
                    $"当前段前 {Units.Number(current)} 磅，要求 {Units.Number(wantBefore)} 磅",
                    "开始 → 段落 → 间距 → 段前");
            }
        }

        if (target.SpaceAfterPt is { } autoAfter && format.AfterAutoSpacing)
        {
            yield return context.At(rule, record, "段后间距为自动",
                $"当前段后为「自动」（Word 约按 14 磅显示），要求 {Units.Number(autoAfter)} 磅",
                $"开始 → 段落 → 间距 → 段后，取消「自动」并设为 {Units.Number(autoAfter)} 磅");
        }
        else if (target.SpaceAfterPt is { } wantAfter)
        {
            var current = format.EffectiveSpaceAfterPt();
            if (Math.Abs(current - wantAfter) > 0.5)
            {
                yield return context.At(rule, record, "段后间距不符合要求",
                    $"当前段后 {Units.Number(current)} 磅，要求 {Units.Number(wantAfter)} 磅",
                    "开始 → 段落 → 间距 → 段后");
            }
        }
    }

    static IEnumerable<Finding> CheckPageBreakBefore(RuleContext context, RuleSpec rule, ParaRecord record)
    {
        if (!record.Format.PageBreakBefore) yield break;
        yield return context.At(rule, record, "段落设置了「段前分页」",
            "该段前被强制换页，会造成版面留白，请确认是否必要",
            "开始 → 段落 → 换行和分页 → 取消「段前分页」");
    }

    /// <summary>
    /// 节定义了文档网格、段落又勾选了"对齐到网格"时，非固定值行距会被放大到网格行高的整数倍；
    /// 固定值行距不受网格影响，不报。
    /// </summary>
    static IEnumerable<Finding> CheckSnapToGrid(RuleContext context, RuleSpec rule, ParaRecord record)
    {
        if (!context.Profile.Bool("body.check_snap_to_grid", false) || !record.Format.SnapToGrid) yield break;
        var sections = context.Model.Sections;
        if (sections.Count == 0 || sections[Math.Min(record.SectionIndex, sections.Count - 1)].DocGridType is null) yield break;
        if (record.Format.LineRule == "exact") yield break;
        var current = record.Format.LineRule == "atLeast" && record.Format.LinePt is { } pt
            ? $"最小值 {Units.Number(pt)} 磅"
            : $"{Units.Number(record.Format.LineMultiple ?? 1.0)} 倍行距";
        yield return context.At(rule, record, "段落对齐到文档网格，实际行距可能被放大",
            $"所在节定义了文档网格，本段行距为「{current}」，Word 会把行高放大到网格行高的整数倍",
            "开始 → 段落 → 取消勾选「如果定义了文档网格，则对齐到网格」，或改用固定值行距");
    }
}
