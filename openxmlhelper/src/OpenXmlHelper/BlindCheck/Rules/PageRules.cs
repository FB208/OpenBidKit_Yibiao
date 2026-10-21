using Yibiao.OpenXmlHelper.BlindCheck.Model;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Rules;

/// <summary>页面设置：纸张、方向、页边距、分栏。按节检查。</summary>
static class PageRules
{
    public static IEnumerable<RuleSpec> All()
    {
        yield return new RuleSpec { Id = "page.paper_size", Title = "纸张大小", Category = "page", Severity = Severity.Medium, Whole = CheckPaper };
        yield return new RuleSpec { Id = "page.orientation", Title = "纸张方向", Category = "page", Severity = Severity.Low, Whole = CheckOrientation };
        yield return new RuleSpec { Id = "page.margins", Title = "页边距", Category = "page", Severity = Severity.Medium, Whole = CheckMargins };
        yield return new RuleSpec { Id = "page.columns", Title = "分栏", Category = "page", Severity = Severity.Low, Whole = CheckColumns };
        yield return new RuleSpec { Id = "page.sections", Title = "各节页面设置一致", Category = "page", Severity = Severity.Low, Whole = CheckSections };
        yield return new RuleSpec { Id = "page.background", Title = "页面背景色", Category = "page", Severity = Severity.Medium, Whole = CheckBackground };
    }

    static string SectionLabel(RuleContext context, int index)
    {
        return context.Model.Sections.Count > 1 ? $"第 {index + 1} 节" : "全文";
    }

    public static (string Name, double Width, double Height) Paper(RuleContext context)
    {
        var paper = (context.Profile.Text("page.paper", "A4") ?? "A4").ToUpperInvariant();
        return paper switch
        {
            "A3" => ("A3", 29.7, 42.0),
            "LETTER" => ("Letter", 21.59, 27.94),
            _ => ("A4", 21.0, 29.7),
        };
    }

    static IEnumerable<Finding> CheckPaper(RuleContext context, RuleSpec rule)
    {
        if (context.Profile.Text("page.paper") is null) yield break;
        var (name, width, height) = Paper(context);
        foreach (var section in context.Model.Sections)
        {
            if (section.PageWidth is not { } w || section.PageHeight is not { } h) continue;
            var currentWidth = Units.TwipsToCm(w);
            var currentHeight = Units.TwipsToCm(h);
            // 允许横排：比较长短边。
            var longSide = Math.Max(currentWidth, currentHeight);
            var shortSide = Math.Min(currentWidth, currentHeight);
            if (Math.Abs(longSide - Math.Max(width, height)) <= 0.05 && Math.Abs(shortSide - Math.Min(width, height)) <= 0.05) continue;
            yield return context.Global(rule, $"纸张大小不是 {name}", SectionLabel(context, section.Index),
                $"当前 {Units.Number(currentWidth)}×{Units.Number(currentHeight)} cm，应为 {Units.Number(width)}×{Units.Number(height)} cm",
                $"布局 → 纸张大小 → {name}");
        }
    }

    static IEnumerable<Finding> CheckOrientation(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("page.check_orientation", true)) yield break;
        foreach (var section in context.Model.Sections)
        {
            if (section.PageWidth is not { } w || section.PageHeight is not { } h || w <= h) continue;
            yield return context.Global(rule, "存在横向页面", SectionLabel(context, section.Index),
                $"当前 {Units.Number(Units.TwipsToCm(w))}×{Units.Number(Units.TwipsToCm(h))} cm（横向），暗标正文通常要求纵向",
                "确认招标文件是否允许横向页；不允许时在「布局 → 纸张方向」改为纵向");
        }
    }

    static IEnumerable<Finding> CheckMargins(RuleContext context, RuleSpec rule)
    {
        var tolerance = context.Profile.Number("body.tolerance_margin_cm") ?? 0.02;
        var sides = new (string Key, string Label, Func<SectionInfo, int?> Read)[]
        {
            ("margin_top_cm", "上边距", section => section.Top),
            ("margin_bottom_cm", "下边距", section => section.Bottom),
            ("margin_left_cm", "左边距", section => section.Left),
            ("margin_right_cm", "右边距", section => section.Right),
        };
        foreach (var section in context.Model.Sections)
        {
            foreach (var (key, label, read) in sides)
            {
                if (read(section) is not { } twips || context.Profile.Number($"page.{key}") is not { } expected) continue;
                // 负的上下边距表示"不随页眉页脚移动"，取绝对值比较。
                var current = Units.TwipsToCm(Math.Abs(twips));
                if (Math.Abs(current - expected) <= tolerance) continue;
                yield return context.Global(rule, $"{label}不符合要求", SectionLabel(context, section.Index),
                    $"当前 {Units.Number(current)} cm，要求 {Units.Number(expected)} cm",
                    "布局 → 页边距 → 自定义页边距");
            }
        }
    }

    static IEnumerable<Finding> CheckColumns(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("page.forbid_columns", true)) yield break;
        foreach (var section in context.Model.Sections.Where(item => item.Columns > 1))
        {
            yield return context.Global(rule, "存在分栏排版", SectionLabel(context, section.Index),
                $"该节分为 {section.Columns} 栏，暗标正文一般要求单栏",
                "布局 → 栏 → 一栏");
        }
    }

    /// <summary>
    /// 页面背景色（设计 → 页面颜色）：招标文件不允许彩色时检查（正文不允许彩色文字或开启了彩色图片检查），
    /// 白色和自动不报。
    /// </summary>
    static IEnumerable<Finding> CheckBackground(RuleContext context, RuleSpec rule)
    {
        if (context.Profile.Body.AllowColor && !context.Profile.Bool("image.check_color", false)) yield break;
        if (BackgroundColor(context.Model) is not { } color) yield break;
        yield return context.Global(rule, "页面设置了背景颜色", "全文",
            $"页面颜色 #{color}，格式要求不允许使用彩色",
            "设计 → 页面颜色 → 无颜色", $"#{color}");
    }

    /// <summary>w:document/w:background 的颜色（含主题色）；没有背景、白色或自动时为 null。</summary>
    public static string? BackgroundColor(DocumentModel model)
    {
        var background = model.BodyElement.Parent?.Element(W.Ns + "background");
        if (background is null) return null;
        var color = W.Attr(background, "color");
        if ((string.IsNullOrEmpty(color) || color.Equals("auto", StringComparison.OrdinalIgnoreCase)) && W.Attr(background, "themeColor") is { } theme)
        {
            color = model.Resolver.Theme.ResolveColor(theme);
        }

        return string.IsNullOrEmpty(color) || color.Equals("auto", StringComparison.OrdinalIgnoreCase) || color.Equals("FFFFFF", StringComparison.OrdinalIgnoreCase)
            ? null
            : color.ToUpperInvariant();
    }

    static string Size(int? twips) => twips is { } value ? Units.Number(Units.TwipsToCm(Math.Abs(value))) : "未设置";

    /// <summary>各节与第 1 节比较纸张、方向、页边距和分栏，只报不同的项。</summary>
    static IEnumerable<Finding> CheckSections(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("page.check_sections", false) || context.Model.Sections.Count < 2) yield break;
        var first = context.Model.Sections[0];
        var items = new (string Label, Func<SectionInfo, string> Read)[]
        {
            ("纸张", section => $"{Size(section.PageWidth)}×{Size(section.PageHeight)} cm"),
            ("上边距", section => $"{Size(section.Top)} cm"),
            ("下边距", section => $"{Size(section.Bottom)} cm"),
            ("左边距", section => $"{Size(section.Left)} cm"),
            ("右边距", section => $"{Size(section.Right)} cm"),
            ("分栏", section => $"{section.Columns} 栏"),
        };
        foreach (var section in context.Model.Sections.Skip(1))
        {
            var differences = items
                .Where(item => item.Read(section) != item.Read(first))
                .Select(item => $"{item.Label} {item.Read(section)}（第 1 节为 {item.Read(first)}）")
                .ToList();
            if (differences.Count == 0) continue;
            yield return context.Global(rule, "页面设置与第 1 节不同", SectionLabel(context, section.Index),
                string.Join("；", differences),
                "确认该节是否需要单独的页面设置（如横向附图）；不需要时在「布局 → 页面设置」中与第 1 节保持一致");
        }
    }
}
