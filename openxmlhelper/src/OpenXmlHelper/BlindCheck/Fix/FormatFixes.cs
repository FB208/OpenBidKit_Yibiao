using Yibiao.OpenXmlHelper.BlindCheck.Model;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;
using static Yibiao.OpenXmlHelper.BlindCheck.Fix.PropertyWriter;

namespace Yibiao.OpenXmlHelper.BlindCheck.Fix;

/// <summary>
/// 段落与文本块格式修复：只写有问题的那一项，目标值取自检查用的同一个入口 TargetFor。
/// 关闭类格式写显式关闭值，样式继承来的加粗、斜体等才能真正关掉。
/// </summary>
static class FormatFixes
{
    public static readonly Dictionary<string, Action<FixContext, ParaRecord>> Paragraph = new(StringComparer.Ordinal)
    {
        ["para.alignment"] = FixAlignment,
        ["para.line_spacing"] = FixLineSpacing,
        ["para.first_line_indent"] = (fix, record) => SetFirstLine(record, fix.Rules.TargetFor(record).Target.FirstLineIndentChars),
        ["para.space_before_after"] = FixSpacing,
        ["para.page_break_before"] = (_, record) => SetParagraphToggle(record.Element, "pageBreakBefore", false),
        ["para.snap_to_grid"] = (_, record) => SetParagraphToggle(record.Element, "snapToGrid", false),
        ["table.indent"] = (fix, record) => SetFirstLine(record, fix.Rules.Profile.Table.FirstLineIndentChars),
    };

    public static readonly Dictionary<string, Action<FixContext, ParaRecord, RunRecord>> Run = new(StringComparer.Ordinal)
    {
        ["font.chinese"] = (fix, record, run) => SetRunFonts(run.Element, eastAsia: fix.Rules.TargetFor(record).Target.FontCn),
        ["font.western"] = (fix, record, run) => SetRunFonts(run.Element, latin: fix.Rules.TargetFor(record).Target.FontEn),
        ["font.size"] = (fix, record, run) => SetSize(run, fix.Rules.TargetFor(record).Target.SizePt),
        ["font.bold"] = FixBold,
        ["font.italic"] = (_, _, run) => SetToggles(run, false, "i", "iCs"),
        ["font.underline"] = (_, _, run) => SetRunValue(run.Element, "u", "none"),
        ["font.color"] = (_, _, run) => SetRunColorBlack(run.Element),
        ["font.highlight"] = (_, _, run) => ClearHighlight(run),
        ["font.effects"] = FixEffects,
        ["font.char_spacing"] = (_, _, run) => SetRunValue(run.Element, "spacing", "0"),
        ["font.scaling"] = (_, _, run) => SetRunValue(run.Element, "w", "100"),
        ["text.hidden"] = (_, _, run) => DeleteHiddenContent(run),
        ["table.font"] = (fix, _, run) => SetRunFonts(run.Element, eastAsia: fix.Rules.Profile.Table.FontCn),
        ["table.size"] = (fix, _, run) => SetSize(run, fix.Rules.Profile.Table.SizePt),
    };

    /// <summary>
    /// 检查报出、但修复不处理的文字块，在计数前排除，留给人工：隐藏来自多层样式叠加时实际可能可见，
    /// 删除会丢正文（其他修复写的是显式格式，求值近似不会改坏，不需要排除）。
    /// </summary>
    public static bool CanFixRun(string ruleId, RunRecord run) => ruleId != "text.hidden" || !run.Format.VanishStacked;

    static void FixAlignment(FixContext fix, ParaRecord record)
    {
        var target = fix.Rules.TargetFor(record).Target.Alignment;
        if (string.IsNullOrEmpty(target)) return;
        SetVal(ParagraphChild(record.Element, "jc"), target);
    }

    static void FixLineSpacing(FixContext fix, ParaRecord record)
    {
        var target = fix.Rules.TargetFor(record).Target;
        if (target.LineRule == "multiple")
        {
            if (target.LineMultiple is not { } multiple) return;
            var spacing = ParagraphChild(record.Element, "spacing");
            SetAttr(spacing, "line", Number(multiple * 240));
            SetAttr(spacing, "lineRule", "auto");
            return;
        }

        if (target.LinePt is not { } pt) return;
        var element = ParagraphChild(record.Element, "spacing");
        SetAttr(element, "line", Number(pt * Units.TwipsPerPt));
        SetAttr(element, "lineRule", target.LineRule);
    }

    /// <summary>首行缩进同时写字符数和 twip，去掉直接格式里的悬挂缩进；字符数 0 时两者都写 0，抵消样式里的缩进。</summary>
    static void SetFirstLine(ParaRecord record, double? want)
    {
        if (want is not { } chars) return;
        var indent = ParagraphChild(record.Element, "ind");
        SetAttr(indent, "hanging", null);
        SetAttr(indent, "hangingChars", null);
        if (chars <= 0.001)
        {
            SetAttr(indent, "firstLineChars", "0");
            SetAttr(indent, "firstLine", "0");
            return;
        }

        SetAttr(indent, "firstLineChars", Number(chars * 100));
        SetAttr(indent, "firstLine", Number(chars * record.Format.CharUnitPt * Units.TwipsPerPt));
    }

    /// <summary>段前段后：按"行"设置的间距优先于磅值，原来用了行单位时一并改写。</summary>
    static void FixSpacing(FixContext fix, ParaRecord record)
    {
        var target = fix.Rules.TargetFor(record).Target;
        var format = record.Format;
        if (target.SpaceBeforePt is { } before && (format.BeforeAutoSpacing || Math.Abs(format.EffectiveSpaceBeforePt() - before) > 0.5))
        {
            var spacing = ParagraphChild(record.Element, "spacing");
            if (format.BeforeAutoSpacing) SetAttr(spacing, "beforeAutospacing", "0");
            SetAttr(spacing, "before", Number(before * Units.TwipsPerPt));
            if (format.SpaceBeforeLines is not null) SetAttr(spacing, "beforeLines", Number(before / Units.PtPerSpacingLine * 100));
        }

        if (target.SpaceAfterPt is { } after && (format.AfterAutoSpacing || Math.Abs(format.EffectiveSpaceAfterPt() - after) > 0.5))
        {
            var spacing = ParagraphChild(record.Element, "spacing");
            if (format.AfterAutoSpacing) SetAttr(spacing, "afterAutospacing", "0");
            SetAttr(spacing, "after", Number(after * Units.TwipsPerPt));
            if (format.SpaceAfterLines is not null) SetAttr(spacing, "afterLines", Number(after / Units.PtPerSpacingLine * 100));
        }
    }

    static void SetSize(RunRecord run, double? pt)
    {
        if (pt is { } value) SetRunSize(run.Element, value);
    }

    static void SetToggles(RunRecord run, bool on, params string[] names)
    {
        foreach (var name in names) SetRunToggle(run.Element, name, on);
    }

    /// <summary>标题按标题要求开或关加粗；正文不允许加粗时关闭。</summary>
    static void FixBold(FixContext fix, ParaRecord record, RunRecord run)
    {
        var (target, role, _) = fix.Rules.TargetFor(record);
        SetToggles(run, role == "heading" && target.Bold == true, "b", "bCs");
    }

    /// <summary>取消突出显示，并把文字底纹写成显式的"清除、自动"，样式继承来的底纹也能去掉。</summary>
    static void ClearHighlight(RunRecord run)
    {
        if (run.Format.Highlight is not null and not "none") SetRunValue(run.Element, "highlight", "none");
        if (run.Format.Shading is null) return;
        var shading = RunChild(run.Element, "shd");
        SetVal(shading, "clear");
        SetAttr(shading, "color", "auto");
        SetAttr(shading, "fill", "auto");
        foreach (var name in new[] { "themeColor", "themeTint", "themeShade", "themeFill", "themeFillTint", "themeFillShade" }) SetAttr(shading, name, null);
    }

    static void FixEffects(FixContext fix, ParaRecord record, RunRecord run)
    {
        var format = run.Format;
        var effects = new (string Name, bool? On)[]
        {
            ("strike", format.Strike), ("dstrike", format.DoubleStrike), ("caps", format.Caps), ("smallCaps", format.SmallCaps),
            ("emboss", format.Emboss), ("imprint", format.Imprint), ("outline", format.Outline), ("shadow", format.Shadow),
        };
        foreach (var (name, on) in effects)
        {
            if (on == true) SetRunToggle(run.Element, name, false);
        }
    }

    /// <summary>
    /// 隐藏文字直接删除而不是取消隐藏：隐藏内容常常就是残留的单位信息，取消隐藏反而会把它印出来。
    /// 域标记（fldChar / instrText）保留，避免拆坏域结构。
    /// </summary>
    static void DeleteHiddenContent(RunRecord run)
    {
        foreach (var child in run.Element.Elements().ToList())
        {
            if (child.Name == W.RPr || child.Name == W.FldChar || child.Name == W.InstrText) continue;
            child.Remove();
        }

        RemoveIfEmptyRun(run.Element);
    }
}
