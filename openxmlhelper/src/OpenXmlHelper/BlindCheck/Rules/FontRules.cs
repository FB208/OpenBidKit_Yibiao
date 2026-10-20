using Yibiao.OpenXmlHelper.BlindCheck.Model;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Rules;

/// <summary>字体名归一：宋体 / SimSun / 宋体-简 是同一字体，不归一会大量误报。</summary>
static class FontNames
{
    static readonly Dictionary<string, string> Aliases = new(StringComparer.Ordinal)
    {
        ["simsun"] = "宋体", ["宋体"] = "宋体", ["songti"] = "宋体", ["宋体-简"] = "宋体",
        ["nsimsun"] = "新宋体", ["新宋体"] = "新宋体",
        ["simhei"] = "黑体", ["黑体"] = "黑体", ["heiti"] = "黑体",
        ["fangsong"] = "仿宋", ["仿宋"] = "仿宋", ["仿宋_gb2312"] = "仿宋", ["simfang"] = "仿宋", ["仿宋gb2312"] = "仿宋", ["fangsong_gb2312"] = "仿宋",
        ["kaiti"] = "楷体", ["楷体"] = "楷体", ["楷体_gb2312"] = "楷体", ["simkai"] = "楷体", ["楷体gb2312"] = "楷体", ["kaiti_gb2312"] = "楷体",
        ["microsoft yahei"] = "微软雅黑", ["微软雅黑"] = "微软雅黑", ["msyh"] = "微软雅黑", ["yahei"] = "微软雅黑",
        ["dengxian"] = "等线", ["等线"] = "等线",
        ["stsong"] = "华文宋体", ["华文宋体"] = "华文宋体",
        ["stkaiti"] = "华文楷体", ["华文楷体"] = "华文楷体",
        ["stfangsong"] = "华文仿宋", ["华文仿宋"] = "华文仿宋",
        ["stheiti"] = "华文黑体", ["华文黑体"] = "华文黑体",
        ["youyuan"] = "幼圆", ["幼圆"] = "幼圆",
        ["lisu"] = "隶书", ["隶书"] = "隶书",
        ["times new roman"] = "times new roman", ["times"] = "times new roman",
        ["arial"] = "arial", ["calibri"] = "calibri", ["courier new"] = "courier new", ["courier"] = "courier new", ["cambria"] = "cambria",
    };

    public static string? Normalize(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        var value = name.Trim().Trim('"', '\'');
        var key = value.ToLowerInvariant();
        if (Aliases.TryGetValue(key, out var mapped)) return mapped;
        return Aliases.TryGetValue(key.Replace(" ", ""), out mapped) ? mapped : value;
    }

    public static bool Same(string? left, string? right)
    {
        return string.Equals(Normalize(left), Normalize(right), StringComparison.OrdinalIgnoreCase);
    }
}

/// <summary>
/// 文本块级格式：字体按字符类别分别判定（中文看 eastAsia、西文看 ascii/hAnsi），
/// 加粗等按继承后的生效值判断；表格文字的字体字号由表格规则负责，加粗、颜色等效果按表格配置（默认同正文）检查。
/// </summary>
static class FontRules
{
    public static IEnumerable<RuleSpec> All()
    {
        yield return new RuleSpec { Id = "font.chinese", Title = "中文字体", Category = "font", Severity = Severity.Medium, InTable = false, PerRun = CheckChineseFont };
        yield return new RuleSpec { Id = "font.western", Title = "西文字体", Category = "font", Severity = Severity.Medium, InTable = false, PerRun = CheckWesternFont };
        yield return new RuleSpec { Id = "font.size", Title = "字号", Category = "font", Severity = Severity.Medium, InTable = false, PerRun = CheckSize };
        yield return new RuleSpec { Id = "font.bold", Title = "加粗", Category = "font", Severity = Severity.Medium, PerRun = CheckBold };
        yield return new RuleSpec { Id = "font.italic", Title = "斜体", Category = "font", Severity = Severity.Medium, PerRun = CheckItalic };
        yield return new RuleSpec { Id = "font.underline", Title = "下划线", Category = "font", Severity = Severity.Medium, PerRun = CheckUnderline };
        yield return new RuleSpec { Id = "font.color", Title = "文字颜色", Category = "font", Severity = Severity.Medium, PerRun = CheckColor };
        yield return new RuleSpec { Id = "font.highlight", Title = "突出显示和文字底纹", Category = "font", Severity = Severity.Medium, PerRun = CheckHighlight };
        yield return new RuleSpec { Id = "font.effects", Title = "异常字体效果", Category = "font", Severity = Severity.Medium, PerRun = CheckEffects };
        yield return new RuleSpec { Id = "font.char_spacing", Title = "字符间距", Category = "font", Severity = Severity.Low, PerRun = CheckCharSpacing };
        yield return new RuleSpec { Id = "font.scaling", Title = "字体缩放", Category = "font", Severity = Severity.Low, PerRun = CheckScaling };
        yield return new RuleSpec { Id = "font.script", Title = "上下标", Category = "font", Severity = Severity.Low, PerParagraph = CheckScript };
        yield return new RuleSpec { Id = "text.hidden", Title = "隐藏文字", Category = "privacy", Severity = Severity.High, SkipEmpty = false, AllRegions = true, PerRun = CheckHidden };
    }

    static bool Blank(RunRecord run) => string.IsNullOrWhiteSpace(run.Text);

    /// <summary>不含中文的文本块（纯数字、西文）是否按字号要求检查；表格字号检查同样适用。</summary>
    public static bool LatinSizeChecked(RuleContext context, RunRecord run)
    {
        return TextKinds.HasCjk(run.Text) || context.Profile.Bool("body.check_latin_size", true);
    }

    static IEnumerable<Finding> CheckChineseFont(RuleContext context, RuleSpec rule, ParaRecord record, RunRecord run)
    {
        // 中西文混排的文本块（如"采用BIM技术"）按是否含中文判断，不按主要类别二选一。
        if (!TextKinds.HasCjk(run.Text)) yield break;
        var target = context.TargetFor(record).Target.FontCn;
        if (string.IsNullOrEmpty(target)) yield break;
        var current = run.Format.FontEastAsia;
        if (current is null)
        {
            yield return context.At(rule, record, "中文字体无法确定",
                "该文字未设置中文字体，样式和主题中也找不到，打开时可能被替代字体显示",
                $"选中文字，把中文字体设为「{target}」");
            yield break;
        }

        if (FontNames.Same(current, target)) yield break;
        yield return context.At(rule, record, $"中文字体不是{target}",
            $"当前「{current}」，要求「{target}」",
            $"选中文字，在「中文字体」中设为「{target}」",
            context.Origin(run.Format.FontSource, record));
    }

    static IEnumerable<Finding> CheckWesternFont(RuleContext context, RuleSpec rule, ParaRecord record, RunRecord run)
    {
        if (!TextKinds.HasLatin(run.Text)) yield break;
        var target = context.TargetFor(record).Target.FontEn;
        if (string.IsNullOrEmpty(target)) yield break;
        var current = run.Format.FontAscii ?? run.Format.FontHAnsi;
        if (current is null || FontNames.Same(current, target)) yield break;
        yield return context.At(rule, record, $"西文字体不是{target}",
            $"当前「{current}」，要求「{target}」",
            $"选中文字，在「西文字体」中设为「{target}」",
            context.Origin(run.Format.FontSource, record));
    }

    static IEnumerable<Finding> CheckSize(RuleContext context, RuleSpec rule, ParaRecord record, RunRecord run)
    {
        // 字号默认不分中西文：单独成块的数字、西文（如"2026""GB 50300"）同样要求正文字号；
        // 招标文件写"数字、英文字符不做要求"时（body.check_latin_size 为 false）不查。只含图片等对象的文本块不查。
        if (!run.Text.Any(ch => !char.IsWhiteSpace(ch) && ch != DocumentModel.ObjectPlaceholder)) yield break;
        if (!LatinSizeChecked(context, run)) yield break;
        var target = context.TargetFor(record).Target;
        if (target.SizePt is not { } want) yield break;
        if (run.Format.SizePt is not { } current)
        {
            yield return context.At(rule, record, "字号无法确定",
                "该文字未设置字号，样式中也找不到",
                $"选中文字，把字号设为{Units.FormatPt(want)}");
            yield break;
        }

        if (Math.Abs(current - want) <= target.TolerancePt) yield break;
        yield return context.At(rule, record, $"字号不是{Units.FormatPt(want)}",
            $"当前{Units.FormatPt(current)}，要求{Units.FormatPt(want)}",
            $"选中文字，把字号设为{Units.FormatPt(want)}",
            context.Origin(run.Format.Sources.GetValueOrDefault("sz"), record));
    }

    static IEnumerable<Finding> CheckBold(RuleContext context, RuleSpec rule, ParaRecord record, RunRecord run)
    {
        if (Blank(run)) yield break;
        var (target, role, level) = context.TargetFor(record);
        var bold = run.Format.Bold ?? false;
        var origin = context.Origin(run.Format.Sources.GetValueOrDefault("b"), record);
        if (role == "heading")
        {
            if (target.Bold is not { } want || want == bold) yield break;
            yield return want
                ? context.At(rule, record, "标题未加粗", $"要求 {level} 级标题加粗", "选中标题文字 → 加粗（Ctrl+B）", origin)
                : context.At(rule, record, "标题不应加粗", $"要求 {level} 级标题不加粗", "选中标题文字 → 取消加粗（Ctrl+B）", origin);
            yield break;
        }

        if (target.AllowBold || !bold) yield break;
        yield return role == "table"
            ? context.At(rule, record, "表格文字使用了加粗", "格式要求表格文字不加粗", "选中表格文字 → 取消加粗（Ctrl+B）", origin)
            : context.At(rule, record, "正文使用了加粗", "格式要求正文不加粗", "选中文字 → 取消加粗（Ctrl+B）", origin);
    }

    static IEnumerable<Finding> CheckItalic(RuleContext context, RuleSpec rule, ParaRecord record, RunRecord run)
    {
        if (Blank(run) || run.Format.Italic != true || context.TargetFor(record).Target.AllowItalic) yield break;
        yield return context.At(rule, record, "文字使用了斜体", "暗标通常要求统一不使用斜体", "选中文字 → 取消倾斜（Ctrl+I）",
            context.Origin(run.Format.Sources.GetValueOrDefault("i"), record));
    }

    static IEnumerable<Finding> CheckUnderline(RuleContext context, RuleSpec rule, ParaRecord record, RunRecord run)
    {
        var underline = run.Format.Underline;
        if (underline is null or "none" || context.TargetFor(record).Target.AllowUnderline) yield break;
        yield return context.At(rule, record, "文字带下划线", $"下划线类型：{underline}", "选中文字 → 取消下划线（Ctrl+U）",
            context.Origin(run.Format.Sources.GetValueOrDefault("u"), record));
    }

    static IEnumerable<Finding> CheckColor(RuleContext context, RuleSpec rule, ParaRecord record, RunRecord run)
    {
        if (Blank(run) || context.TargetFor(record).Target.AllowColor) yield break;
        var rgb = run.Format.ColorRgb?.TrimStart('#').ToUpperInvariant();
        if (rgb is null or "000000" or "AUTO" || rgb.Length < 6) yield break;
        // 极深的灰视同黑色。
        if (int.TryParse(rgb[..2], System.Globalization.NumberStyles.HexNumber, null, out var red)
            && int.TryParse(rgb[2..4], System.Globalization.NumberStyles.HexNumber, null, out var green)
            && int.TryParse(rgb[4..6], System.Globalization.NumberStyles.HexNumber, null, out var blue)
            && red < 40 && green < 40 && blue < 40)
        {
            yield break;
        }

        var theme = run.Format.ColorTheme is null ? "" : $"（主题色 {run.Format.ColorTheme}）";
        yield return context.At(rule, record, "文字不是黑色", $"当前颜色 #{rgb}{theme}", "选中文字 → 字体颜色 → 自动",
            context.Origin(run.Format.Sources.GetValueOrDefault("color"), record));
    }

    /// <summary>突出显示（高亮）和文字底纹：招标文件"不得添加字符底纹"一类要求两者都算。</summary>
    static IEnumerable<Finding> CheckHighlight(RuleContext context, RuleSpec rule, ParaRecord record, RunRecord run)
    {
        if (Blank(run) || context.TargetFor(record).Target.AllowHighlight) yield break;
        var highlight = run.Format.Highlight;
        if (highlight is not null and not "none")
        {
            yield return context.At(rule, record, "文字带突出显示（高亮）", $"高亮颜色：{highlight}", "选中文字 → 文本突出显示颜色 → 无颜色",
                context.Origin(run.Format.Sources.GetValueOrDefault("highlight"), record));
        }

        if (run.Format.Shading is { } shading)
        {
            yield return context.At(rule, record, "文字带底纹", $"底纹颜色 #{shading}", "选中文字 → 边框和底纹 → 底纹 → 填充选「无颜色」",
                context.Origin(run.Format.Sources.GetValueOrDefault("shd"), record));
        }
    }

    static IEnumerable<Finding> CheckEffects(RuleContext context, RuleSpec rule, ParaRecord record, RunRecord run)
    {
        if (Blank(run)) yield break;
        var format = run.Format;
        var effects = new List<string>();
        if (format.Strike == true) effects.Add("删除线");
        if (format.DoubleStrike == true) effects.Add("双删除线");
        if (format.Caps == true) effects.Add("全部大写");
        if (format.SmallCaps == true) effects.Add("小型大写");
        if (format.Emboss == true) effects.Add("阳文");
        if (format.Imprint == true) effects.Add("阴文");
        if (format.Outline == true) effects.Add("空心");
        if (format.Shadow == true) effects.Add("阴影");
        if (effects.Count == 0) yield break;
        yield return context.At(rule, record, $"存在异常字体效果（{string.Join("、", effects)}）",
            "这些效果在暗标中通常被视为标记行为", "选中文字 → 字体 → 效果，全部取消");
    }

    static IEnumerable<Finding> CheckCharSpacing(RuleContext context, RuleSpec rule, ParaRecord record, RunRecord run)
    {
        if (Blank(run) || context.TargetFor(record).Target.AllowCharSpacing) yield break;
        if (run.Format.CharSpacingPt is not { } spacing || Math.Abs(spacing) < 0.01) yield break;
        yield return context.At(rule, record, "存在字符间距调整",
            $"字符间距 {Units.Number(spacing)} 磅，可能被视为隐形标记", "选中文字 → 字体 → 高级 → 间距：标准",
            context.Origin(run.Format.Sources.GetValueOrDefault("spacing"), record));
    }

    static IEnumerable<Finding> CheckScaling(RuleContext context, RuleSpec rule, ParaRecord record, RunRecord run)
    {
        if (Blank(run) || context.TargetFor(record).Target.AllowFontScaling) yield break;
        if (run.Format.ScalePct is not { } scale || scale == 100) yield break;
        yield return context.At(rule, record, "存在字体缩放", $"当前缩放 {scale}%，正常应为 100%", "选中文字 → 字体 → 高级 → 缩放：100%",
            context.Origin(run.Format.Sources.GetValueOrDefault("w"), record));
    }

    /// <summary>技术标里 m³、H₂O 很常见，默认关闭；按段落报一处，列出前几个上下标。</summary>
    static IEnumerable<Finding> CheckScript(RuleContext context, RuleSpec rule, ParaRecord record)
    {
        if (!context.Profile.Bool("body.check_vert_align", false)) yield break;
        var runs = record.Runs.Where(run => !Blank(run) && run.Format.VertAlign is "superscript" or "subscript").ToList();
        if (runs.Count == 0) yield break;
        var samples = string.Join("、", runs.Take(3).Select(run => $"「{RuleContext.Truncate(run.Text.Trim(), 10)}」{(run.Format.VertAlign == "superscript" ? "上标" : "下标")}"));
        yield return context.At(rule, record, "存在上标或下标文字",
            $"本段共 {runs.Count} 处，例如 {samples}",
            "确认上下标是否必要（如单位 m³ 可保留）；不需要时选中文字取消上标或下标",
            context.Origin(runs[0].Format.Sources.GetValueOrDefault("vertAlign"), record));
    }

    static IEnumerable<Finding> CheckHidden(RuleContext context, RuleSpec rule, ParaRecord record, RunRecord run)
    {
        if (!context.Profile.Bool("structure.check_hidden_text", true)) yield break;
        if (run.Format.Vanish != true && run.Format.SpecVanish != true) yield break;
        yield return context.At(rule, record, "存在隐藏文字",
            "隐藏文字平时看不到，但可能残留企业信息，提交后可被读取", "选中文字 → 字体 → 效果 → 取消「隐藏」",
            context.Origin(run.Format.Sources.GetValueOrDefault("vanish"), record),
            text: RuleContext.Snippet(run.Text));
    }
}
