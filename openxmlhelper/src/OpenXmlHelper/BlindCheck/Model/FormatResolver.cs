using System.Globalization;
using System.Xml.Linq;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Model;

/// <summary>格式来源层级，按优先级从高到低。</summary>
static class FormatSource
{
    public const string Direct = "direct";
    public const string CharStyle = "char_style";
    public const string ParaStyle = "para_style";
    public const string TableStyle = "table_style";
    public const string DocDefault = "doc_default";
}

/// <summary>rPr/pPr 摊平成 {属性名: 子元素}；只收 w 命名空间的子元素。</summary>
sealed class PropMap : Dictionary<string, XElement>
{
    public PropMap() : base(StringComparer.Ordinal)
    {
    }

    public static PropMap Of(XElement? container, string? exclude = null)
    {
        var map = new PropMap();
        if (container is null) return map;
        foreach (var child in container.Elements())
        {
            if (child.Name.Namespace != W.Ns) continue;
            var name = child.Name.LocalName;
            if (name == exclude) continue;
            map[name] = child;
        }

        return map;
    }
}

/// <summary>一串按优先级排好的属性层，元素级"首个命中胜出"，多属性元素可逐属性合并。</summary>
sealed class PropLevels
{
    readonly List<(string Source, PropMap Props)> _items = [];

    public void Add(string source, PropMap? props)
    {
        if (props is { Count: > 0 }) _items.Add((source, props));
    }

    /// <summary>样式链按"子样式在前、父样式在后"逐层加入，同名元素和字体槽位才能逐层继承。</summary>
    public void AddRange(string source, IEnumerable<PropMap> layers)
    {
        foreach (var props in layers) Add(source, props);
    }

    public IReadOnlyList<(string Source, PropMap Props)> Items => _items;

    public XElement? Get(string name)
    {
        foreach (var (_, props) in _items)
        {
            if (props.TryGetValue(name, out var element)) return element;
        }

        return null;
    }

    public string? SourceOf(string name)
    {
        foreach (var (source, props) in _items)
        {
            if (props.ContainsKey(name)) return source;
        }

        return null;
    }

    /// <summary>逐属性合并 name 元素：每个属性取最高优先级层的值。</summary>
    public Dictionary<string, (string Value, string Source, int Rank)> MergedAttrs(string name)
    {
        var result = new Dictionary<string, (string, string, int)>(StringComparer.Ordinal);
        for (var rank = 0; rank < _items.Count; rank += 1)
        {
            var (source, props) = _items[rank];
            if (!props.TryGetValue(name, out var element)) continue;
            foreach (var attribute in element.Attributes())
            {
                if (attribute.IsNamespaceDeclaration) continue;
                if (attribute.Name.Namespace != W.Ns && attribute.Name.Namespace != XNamespace.None) continue;
                result.TryAdd(attribute.Name.LocalName, (attribute.Value, source, rank));
            }
        }

        return result;
    }
}

sealed class RunFormat
{
    public string? FontEastAsia { get; set; }
    public string? FontAscii { get; set; }
    public string? FontHAnsi { get; set; }
    public string? FontSource { get; set; }
    public double? SizePt { get; set; }
    public bool? Bold { get; set; }
    public bool? Italic { get; set; }
    public string? Underline { get; set; }
    public bool? Strike { get; set; }
    public bool? DoubleStrike { get; set; }
    public bool? Caps { get; set; }
    public bool? SmallCaps { get; set; }
    public bool? Emboss { get; set; }
    public bool? Imprint { get; set; }
    public bool? Outline { get; set; }
    public bool? Shadow { get; set; }
    public bool? Vanish { get; set; }
    /// <summary>没有直接设置隐藏、又有两层及以上样式都设了隐藏：开关属性可能互相抵消，实际是否可见不确定。</summary>
    public bool VanishStacked { get; set; }
    public bool? SpecVanish { get; set; }
    public string? ColorRgb { get; set; }
    public string? ColorTheme { get; set; }
    public string? Highlight { get; set; }
    /// <summary>文字底纹（w:rPr/w:shd）的可见颜色 RRGGBB；没有底纹或底纹为白色、自动时为 null。</summary>
    public string? Shading { get; set; }
    /// <summary>superscript / subscript / baseline。</summary>
    public string? VertAlign { get; set; }
    public double? CharSpacingPt { get; set; }
    public int? ScalePct { get; set; }
    public Dictionary<string, string> Sources { get; } = new(StringComparer.Ordinal);
}

sealed class ParaFormat
{
    public string? StyleId { get; set; }
    public string? StyleName { get; set; }
    public int? HeadingLevel { get; set; }
    public string? Alignment { get; set; }
    public string? LineRule { get; set; }
    public double? LinePt { get; set; }
    public double? LineMultiple { get; set; }
    public double? SpaceBeforePt { get; set; }
    public double? SpaceAfterPt { get; set; }
    public double? SpaceBeforeLines { get; set; }
    public double? SpaceAfterLines { get; set; }
    public bool BeforeAutoSpacing { get; set; }
    public bool AfterAutoSpacing { get; set; }
    public int? FirstLineTwips { get; set; }
    public int? FirstLineChars { get; set; }
    public int? HangingTwips { get; set; }
    public int? HangingChars { get; set; }
    public bool HangingWins { get; set; }
    public bool PageBreakBefore { get; set; }
    /// <summary>"如果定义了文档网格，则对齐到网格"；未设置时 Word 默认开启。</summary>
    public bool SnapToGrid { get; set; } = true;
    public double? MarkSizePt { get; set; }
    /// <summary>"字符"单位对应的磅值，取段内首个文本块字号，没有时取段落标记字号，再没有按 12 磅。</summary>
    public double CharUnitPt { get; set; } = 12.0;
    public Dictionary<string, string> Sources { get; } = new(StringComparer.Ordinal);

    /// <summary>
    /// 生效的首行缩进（字符数，悬挂为负）。Chars 变体非 0 时优先；
    /// Word 改用厘米缩进时会写 firstLineChars="0" 抵消样式里的字符缩进，所以 0 视为未设置。
    /// </summary>
    public double? EffectiveFirstLineChars()
    {
        double? Resolve(int? chars, int? twips)
        {
            if (chars is { } c && c != 0) return c / 100.0;
            if (twips is { } t) return t / (CharUnitPt * Units.TwipsPerPt);
            if (chars is not null) return 0;
            return null;
        }

        if (HangingWins)
        {
            var hanging = Resolve(HangingChars, HangingTwips);
            return hanging is null ? null : -hanging;
        }

        var first = Resolve(FirstLineChars, FirstLineTwips);
        if (first is not null) return first;
        var fallback = Resolve(HangingChars, HangingTwips);
        return fallback is null ? null : -fallback;
    }

    /// <summary>段前（磅）。beforeLines 优先于 before，与 Word 一致。</summary>
    public double EffectiveSpaceBeforePt()
    {
        if (SpaceBeforeLines is { } lines) return lines * Units.PtPerSpacingLine;
        return SpaceBeforePt ?? 0;
    }

    public double EffectiveSpaceAfterPt()
    {
        if (SpaceAfterLines is { } lines) return lines * Units.PtPerSpacingLine;
        return SpaceAfterPt ?? 0;
    }
}

/// <summary>
/// 按 docDefaults → 表格样式 → 段落样式（basedOn 链）→ 字符样式 → 直接格式 求值实际生效格式。
/// 段落标记格式 w:pPr/w:rPr 只作用于段落标记本身（ECMA-376 17.3.1.29），不参与文本块求值。
/// </summary>
sealed class FormatResolver
{
    readonly StyleSheet _sheet;
    readonly ThemeInfo _theme;
    readonly PropMap _docDefaultRPr;
    readonly PropMap _docDefaultPPr;
    readonly Dictionary<string, List<PropMap>> _paraStyleRPr = new(StringComparer.Ordinal);
    readonly Dictionary<string, List<PropMap>> _paraStylePPr = new(StringComparer.Ordinal);
    readonly Dictionary<string, List<PropMap>> _charStyleRPr = new(StringComparer.Ordinal);
    readonly Dictionary<string, List<PropMap>> _tableStyleRPr = new(StringComparer.Ordinal);
    readonly Dictionary<string, List<PropMap>> _tableStylePPr = new(StringComparer.Ordinal);

    static readonly (string Slot, string Name, string Theme)[] FontSlots =
    [
        ("ascii", "ascii", "asciiTheme"),
        ("hAnsi", "hAnsi", "hAnsiTheme"),
        ("eastAsia", "eastAsia", "eastAsiaTheme"),
    ];

    public FormatResolver(StyleSheet sheet, ThemeInfo theme)
    {
        _sheet = sheet;
        _theme = theme;
        _docDefaultRPr = PropMap.Of(sheet.DocDefaultRPr);
        _docDefaultPPr = PropMap.Of(sheet.DocDefaultPPr);
    }

    public StyleSheet Sheet => _sheet;

    public ThemeInfo Theme => _theme;

    /// <summary>
    /// 样式链各层的属性，子样式在前。不预先合并：子样式只写了 rFonts 的西文槽位或段后间距时，
    /// 父样式的中文字体、行距仍要能逐槽位、逐属性继承下来。
    /// </summary>
    List<PropMap> StyleProps(Dictionary<string, List<PropMap>> cache, string? styleId, string type, Func<StyleInfo, XElement?> select, string? exclude = null)
    {
        var key = styleId ?? "";
        if (cache.TryGetValue(key, out var cached)) return cached;
        var style = type == "paragraph" ? _sheet.ResolveParagraphStyle(styleId) : styleId is null ? null : _sheet.ById.GetValueOrDefault(styleId);
        var layers = _sheet.Chain(style, type).Select(item => PropMap.Of(select(item), exclude)).Where(item => item.Count > 0).ToList();
        cache[key] = layers;
        return layers;
    }

    List<PropMap> ParaStyleRPr(string? styleId) => StyleProps(_paraStyleRPr, styleId, "paragraph", style => style.RPr);
    List<PropMap> ParaStylePPr(string? styleId) => StyleProps(_paraStylePPr, styleId, "paragraph", style => style.PPr, "rPr");
    List<PropMap> CharStyleRPr(string? styleId) => styleId is null ? [] : StyleProps(_charStyleRPr, styleId, "character", style => style.RPr);
    List<PropMap> TableStyleRPr(string? styleId) => styleId is null ? [] : StyleProps(_tableStyleRPr, styleId, "table", style => style.RPr);
    List<PropMap> TableStylePPr(string? styleId) => styleId is null ? [] : StyleProps(_tableStylePPr, styleId, "table", style => style.PPr, "rPr");

    public ParaFormat ResolveParagraph(XElement paragraph, string? tableStyleId)
    {
        var pPr = paragraph.Element(W.PPr);
        var direct = PropMap.Of(pPr);
        var styleId = W.ValOf(direct.GetValueOrDefault("pStyle"));
        if (styleId is not null && !_sheet.ById.ContainsKey(styleId)) styleId = null;

        var levels = new PropLevels();
        var directWithoutMark = PropMap.Of(pPr, "rPr");
        levels.Add(FormatSource.Direct, directWithoutMark);
        levels.AddRange(FormatSource.ParaStyle, ParaStylePPr(styleId));
        levels.AddRange(FormatSource.TableStyle, TableStylePPr(tableStyleId));
        levels.Add(FormatSource.DocDefault, _docDefaultPPr);

        var style = _sheet.ResolveParagraphStyle(styleId);
        var format = new ParaFormat
        {
            StyleId = styleId ?? style?.Id,
            StyleName = style?.DisplayName,
            HeadingLevel = style?.HeadingLevel,
        };

        var outline = W.IntAttr(levels.Get("outlineLvl"), "val");
        if (format.HeadingLevel is null && outline is >= 0 and <= 8) format.HeadingLevel = outline + 1;

        var jc = levels.Get("jc");
        format.Alignment = W.ValOf(jc);
        if (levels.SourceOf("jc") is { } jcSource) format.Sources["jc"] = jcSource;

        var spacing = levels.MergedAttrs("spacing");
        if (spacing.Count > 0)
        {
            var line = IntOf(spacing, "line");
            if (line is not null)
            {
                format.LineRule = spacing.TryGetValue("lineRule", out var rule) ? rule.Value : "auto";
                if (format.LineRule == "auto") format.LineMultiple = line.Value / 240.0;
                else format.LinePt = Units.TwipsToPt(line.Value);
                format.Sources["spacing.line"] = spacing["line"].Source;
            }

            if (IntOf(spacing, "before") is { } before) format.SpaceBeforePt = Units.TwipsToPt(before);
            if (IntOf(spacing, "after") is { } after) format.SpaceAfterPt = Units.TwipsToPt(after);
            if (IntOf(spacing, "beforeLines") is { } beforeLines) format.SpaceBeforeLines = beforeLines / 100.0;
            if (IntOf(spacing, "afterLines") is { } afterLines) format.SpaceAfterLines = afterLines / 100.0;
            format.BeforeAutoSpacing = IsOn(spacing, "beforeAutospacing");
            format.AfterAutoSpacing = IsOn(spacing, "afterAutospacing");
        }

        var indent = levels.MergedAttrs("ind");
        if (indent.Count > 0)
        {
            format.FirstLineTwips = IntOf(indent, "firstLine");
            format.FirstLineChars = IntOf(indent, "firstLineChars");
            format.HangingTwips = IntOf(indent, "hanging");
            format.HangingChars = IntOf(indent, "hangingChars");
            // 首行缩进与悬挂缩进是同一项设置，取出现在更高优先级层的那一组。
            var firstRank = MinRank(indent, "firstLine", "firstLineChars");
            var hangingRank = MinRank(indent, "hanging", "hangingChars");
            format.HangingWins = hangingRank < firstRank;
            var source = format.HangingWins ? SourceOf(indent, "hanging", "hangingChars") : SourceOf(indent, "firstLine", "firstLineChars");
            if (source is not null) format.Sources["ind"] = source;
        }

        format.PageBreakBefore = W.OnOff(levels.Get("pageBreakBefore")) ?? false;
        format.SnapToGrid = W.OnOff(levels.Get("snapToGrid")) ?? true;
        var markSize = W.IntAttr(pPr?.Element(W.RPr)?.Element(W.Ns + "sz"), "val");
        if (markSize is not null) format.MarkSizePt = Units.HalfPtToPt(markSize.Value);
        format.CharUnitPt = format.MarkSizePt ?? 12.0;
        return format;
    }

    public RunFormat ResolveRun(XElement run, ParaFormat paragraph, string? tableStyleId)
    {
        var direct = PropMap.Of(run.Element(W.RPr));
        var charStyleId = W.ValOf(direct.GetValueOrDefault("rStyle"));
        if (charStyleId is not null && !_sheet.ById.ContainsKey(charStyleId)) charStyleId = null;

        var levels = new PropLevels();
        levels.Add(FormatSource.Direct, direct);
        levels.AddRange(FormatSource.CharStyle, CharStyleRPr(charStyleId));
        levels.AddRange(FormatSource.ParaStyle, ParaStyleRPr(paragraph.StyleId));
        levels.AddRange(FormatSource.TableStyle, TableStyleRPr(tableStyleId));
        levels.Add(FormatSource.DocDefault, _docDefaultRPr);

        var format = new RunFormat();
        ResolveFonts(format, levels);

        var size = W.IntAttr(levels.Get("sz"), "val");
        if (size is not null)
        {
            format.SizePt = Units.HalfPtToPt(size.Value);
            format.Sources["sz"] = levels.SourceOf("sz")!;
        }

        format.Bold = W.OnOff(levels.Get("b"));
        format.Italic = W.OnOff(levels.Get("i"));
        format.Underline = W.ValOf(levels.Get("u")) ?? (levels.Get("u") is null ? null : "single");
        format.Strike = W.OnOff(levels.Get("strike"));
        format.DoubleStrike = W.OnOff(levels.Get("dstrike"));
        format.Caps = W.OnOff(levels.Get("caps"));
        format.SmallCaps = W.OnOff(levels.Get("smallCaps"));
        format.Emboss = W.OnOff(levels.Get("emboss"));
        format.Imprint = W.OnOff(levels.Get("imprint"));
        format.Outline = W.OnOff(levels.Get("outline"));
        format.Shadow = W.OnOff(levels.Get("shadow"));
        format.Vanish = W.OnOff(levels.Get("vanish"));
        // 开关属性写在样式里是"切换"，这里只按最高一层取值；多层样式叠加时单独标出，删除隐藏文字前要避开。
        format.VanishStacked = !direct.ContainsKey("vanish") && levels.Items.Count(item => W.OnOff(item.Props.GetValueOrDefault("vanish")) == true) >= 2;
        format.SpecVanish = W.OnOff(levels.Get("specVanish"));
        format.Highlight = W.ValOf(levels.Get("highlight"));
        format.VertAlign = W.ValOf(levels.Get("vertAlign"));

        var color = levels.Get("color");
        if (color is not null)
        {
            var value = W.ValOf(color);
            var theme = W.Attr(color, "themeColor");
            format.ColorTheme = theme;
            // 带淡色/深色修饰（themeTint/themeShade）时，Word 已把修饰后的实际颜色写在 w:val（如"黑色，文字 1，淡色 50%"写 7F7F7F），直接取它。
            var tinted = W.Attr(color, "themeTint") is not null || W.Attr(color, "themeShade") is not null;
            if (theme is not null && tinted && !IsAuto(value)) format.ColorRgb = value!.ToUpperInvariant();
            else if (theme is not null) format.ColorRgb = _theme.ResolveColor(theme) ?? (IsAuto(value) ? null : value?.ToUpperInvariant());
            else format.ColorRgb = IsAuto(value) ? "000000" : value?.ToUpperInvariant();
            format.Sources["color"] = levels.SourceOf("color")!;
        }

        format.Shading = ShadingColor(levels.Get("shd"));

        var spacing = W.IntAttr(levels.Get("spacing"), "val");
        if (spacing is not null) format.CharSpacingPt = Units.TwipsToPt(spacing.Value);
        format.ScalePct = W.IntAttr(levels.Get("w"), "val");
        foreach (var name in new[] { "b", "i", "u", "highlight", "shd", "vanish", "spacing", "w", "vertAlign" })
        {
            if (levels.SourceOf(name) is { } source) format.Sources[name] = source;
        }

        return format;
    }

    /// <summary>
    /// 字体逐槽位求值：从高优先级层往下找，某层写了主题字体就按主题解析，
    /// 写了字体名就用字体名；只写 w:hint 的层不会遮住下层继承来的字体。
    /// </summary>
    void ResolveFonts(RunFormat format, PropLevels levels)
    {
        foreach (var (slot, name, themeName) in FontSlots)
        {
            foreach (var (source, props) in levels.Items)
            {
                if (!props.TryGetValue("rFonts", out var fonts)) continue;
                var themeKey = W.Attr(fonts, themeName);
                var resolved = themeKey is null ? null : _theme.ResolveFont(themeKey);
                var value = resolved ?? W.Attr(fonts, name);
                if (string.IsNullOrWhiteSpace(value)) continue;
                switch (slot)
                {
                    case "ascii": format.FontAscii = value; break;
                    case "hAnsi": format.FontHAnsi = value; break;
                    default:
                        format.FontEastAsia = value;
                        format.FontSource = source;
                        break;
                }

                break;
            }
        }

        format.FontSource ??= levels.SourceOf("rFonts");
    }

    static bool IsAuto(string? value) => string.IsNullOrEmpty(value) || string.Equals(value, "auto", StringComparison.OrdinalIgnoreCase);

    static bool Visible(string? color) => !IsAuto(color) && !string.Equals(color, "FFFFFF", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// 文字底纹的可见颜色：先看填充色（含主题填充色），再看图案颜色（图案不是"清除"时才显示）；
    /// 白色、自动和 nil 视为没有底纹。
    /// </summary>
    string? ShadingColor(XElement? shd)
    {
        if (shd is null) return null;
        var pattern = W.ValOf(shd);
        if (pattern == "nil") return null;
        var fill = W.Attr(shd, "fill");
        if (IsAuto(fill) && W.Attr(shd, "themeFill") is { } themeFill) fill = _theme.ResolveColor(themeFill);
        if (Visible(fill)) return fill!.ToUpperInvariant();
        var color = W.Attr(shd, "color");
        return pattern is not null and not "clear" && Visible(color) ? color!.ToUpperInvariant() : null;
    }

    static int? IntOf(Dictionary<string, (string Value, string Source, int Rank)> attrs, string name)
    {
        if (!attrs.TryGetValue(name, out var item)) return null;
        if (int.TryParse(item.Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value)) return value;
        return double.TryParse(item.Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) ? (int)number : null;
    }

    static bool IsOn(Dictionary<string, (string Value, string Source, int Rank)> attrs, string name)
    {
        return attrs.TryGetValue(name, out var item) && item.Value is not ("0" or "false" or "off");
    }

    static int MinRank(Dictionary<string, (string Value, string Source, int Rank)> attrs, params string[] names)
    {
        var rank = int.MaxValue;
        foreach (var name in names)
        {
            if (attrs.TryGetValue(name, out var item)) rank = Math.Min(rank, item.Rank);
        }

        return rank;
    }

    static string? SourceOf(Dictionary<string, (string Value, string Source, int Rank)> attrs, params string[] names)
    {
        string? source = null;
        var best = int.MaxValue;
        foreach (var name in names)
        {
            if (attrs.TryGetValue(name, out var item) && item.Rank < best)
            {
                best = item.Rank;
                source = item.Source;
            }
        }

        return source;
    }
}
