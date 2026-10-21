using System.Globalization;
using System.Xml.Linq;
using Yibiao.OpenXmlHelper.BlindCheck.Model;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Rules;

/// <summary>
/// 图片：彩色图片（像素抽样由 Main 用 nativeImage 完成，结论随请求传入）、
/// 图表 / SmartArt / 形状的彩色（读取填充和线条颜色）、矢量图里的文字、图片元数据。每张图片定位到第一次出现的段落。
/// </summary>
static class ImageRules
{
    static readonly XNamespace ChartNs = "http://schemas.openxmlformats.org/drawingml/2006/chart";
    static readonly XNamespace DiagramNs = "http://schemas.openxmlformats.org/drawingml/2006/diagram";
    static readonly XNamespace WpsNs = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape";
    static readonly HashSet<string> VmlShapes = ["shape", "rect", "roundrect", "oval", "line", "polyline", "arc", "curve"];
    static readonly HashSet<string> NeutralNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "black", "white", "gray", "grey", "silver", "dkGray", "ltGray", "darkGray", "lightGray", "dimGray", "gainsboro", "whiteSmoke",
    };

    /// <summary>与 Main 判定位图彩色像素用的 RGB 通道差阈值一致。</summary>
    const int ColorSpread = 40;

    public static IEnumerable<RuleSpec> All()
    {
        yield return new RuleSpec { Id = "image.color", Title = "彩色图片", Category = "image", Severity = Severity.Medium, Whole = CheckColor };
        yield return new RuleSpec { Id = "image.graphic_color", Title = "彩色图表和图形", Category = "image", Severity = Severity.Medium, Whole = CheckGraphicColor };
        yield return new RuleSpec { Id = "image.vector", Title = "矢量图中的文字", Category = "image", Severity = Severity.High, Whole = CheckVectorText };
        yield return new RuleSpec { Id = "image.meta", Title = "图片元数据", Category = "image", Severity = Severity.High, Whole = CheckMetadata };
    }

    static string Uses(ImageInfo image) => image.Uses > 1 ? $"，文中引用 {image.Uses} 次" : "";

    static Finding Locate(RuleContext context, RuleSpec rule, ImageInfo image, string message, string detail, string hint, string text, Severity? severity = null)
    {
        if (image.FirstRecord is { } record) return context.At(rule, record, message, detail, hint, severity: severity, text: text);
        return context.Global(rule, message, context.PartLabel(image.FirstSourcePart), detail, hint, text, severity);
    }

    static IEnumerable<Finding> CheckColor(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("image.check_color", false)) yield break;
        foreach (var image in context.Images)
        {
            if (!context.ImageFacts.TryGetValue(image.Part, out var fact) || !fact.Color) continue;
            yield return Locate(context, rule, image, "存在彩色图片",
                $"{image.Describe()}，彩色像素约占 {Math.Round(fact.ColorRatio * 100)}%{Uses(image)}",
                "按招标文件要求把图片转为黑白或灰度后重新插入",
                image.FileName);
        }
    }

    /// <summary>
    /// 图表、SmartArt、形状和文本框的彩色：按显式填充、线条颜色和样式默认色判断，不自动修复；
    /// 矢量图（EMF / WMF / SVG）解码不了颜色，开启彩色检查时提示人工确认。
    /// </summary>
    static IEnumerable<Finding> CheckGraphicColor(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("image.check_color", false)) yield break;
        var model = context.Model;
        var theme = model.Resolver.Theme;
        foreach (var (part, document) in model.Parts)
        {
            if (part == model.CommentsPart || document.Root is null) continue;
            var relationships = model.Package.Relationships(part).Where(item => !item.External).ToDictionary(item => item.Id, item => DocxPackage.ResolveTarget(part, item.Target), StringComparer.Ordinal);
            string? Target(XElement element, string attribute) => element.Attribute(W.R + attribute)?.Value is { } id ? relationships.GetValueOrDefault(id) : null;

            foreach (var element in document.Root.Descendants())
            {
                if (element.Ancestors(W.McFallback).Any()) continue;
                (string Message, string Detail, string Hint)? hit = null;
                if (element.Name == ChartNs + "chart" && Target(element, "id") is { } chartPart && ChartColor(model, chartPart, theme) is { } chartColor)
                {
                    hit = ("图表使用了彩色", $"图表颜色：{chartColor}", "选中图表 → 图表设计 → 更改颜色，选单色（灰色）方案，或把各系列改为黑白灰");
                }
                else if (element.Name == DiagramNs + "relIds" && Target(element, "cs") is { } colorsPart
                    && model.Package.TryLoad(colorsPart)?.Root is { } colorsRoot && FirstColorful(colorsRoot.Descendants(), theme) is { } diagramColor)
                {
                    hit = ("SmartArt 图形使用了彩色", $"配色中含有{diagramColor}", "选中 SmartArt → SmartArt 设计 → 更改颜色，选黑白或灰度方案");
                }
                else if (element.Name == WpsNs + "wsp" && ShapeColor(element, theme) is { } shapeColor)
                {
                    hit = ("形状或文本框使用了彩色", $"填充或线条颜色：{shapeColor}", "选中形状 → 形状格式 → 把填充和轮廓改为黑白灰或无");
                }
                else if (element.Name.Namespace == W.V && VmlShapes.Contains(element.Name.LocalName) && VmlColor(element) is { } vmlColor)
                {
                    hit = ("形状或文本框使用了彩色", $"填充或线条颜色：{vmlColor}", "选中形状 → 形状格式 → 把填充和轮廓改为黑白灰或无");
                }

                if (hit is not { } found) continue;
                var paragraph = element.Ancestors(W.P).FirstOrDefault();
                yield return paragraph is not null && model.Records.TryGetValue(paragraph, out var record)
                    ? context.At(rule, record, found.Message, found.Detail, found.Hint)
                    : context.Global(rule, found.Message, context.PartLabel(part), found.Detail, found.Hint);
            }
        }

        foreach (var image in context.Images.Where(item => item.IsVector))
        {
            yield return Locate(context, rule, image, "矢量图无法自动判断是否为彩色",
                $"{image.Describe()}是矢量图，程序不能解码颜色{Uses(image)}",
                "打开图片确认是否为黑白；是彩色时在绘图软件中改为黑白后重新插入",
                image.FileName, Severity.Low);
        }
    }

    static bool IsColorElement(XElement element) =>
        element.Name.Namespace == W.A && element.Name.LocalName is "srgbClr" or "schemeClr" or "sysClr" or "prstClr";

    static bool HasFill(XElement? container) =>
        container?.Elements().Any(item => item.Name.LocalName is "noFill" or "solidFill" or "gradFill" or "pattFill" or "blipFill" or "grpFill") ?? false;

    /// <summary>容器（spPr 或线条 ln）里显式写的填充颜色元素，含线条的填充；阴影等效果的颜色不算。</summary>
    static IEnumerable<XElement> FillColors(XElement? container)
    {
        if (container is null) return [];
        var fills = container.Elements()
            .Where(item => item.Name.LocalName is "solidFill" or "gradFill" or "pattFill")
            .SelectMany(item => item.Descendants().Where(IsColorElement));
        return container.Element(W.A + "ln") is { } line ? fills.Concat(FillColors(line)) : fills;
    }

    /// <summary>颜色元素是彩色时返回说明文字（如"#4472C4""主题色 accent1（#4472C4）"），否则 null。</summary>
    static string? Colorful(XElement color, ThemeInfo theme)
    {
        var value = color.Attribute("val")?.Value;
        switch (color.Name.LocalName)
        {
            case "srgbClr":
                return SpreadOf(value) > ColorSpread ? $"#{value!.ToUpperInvariant()}" : null;
            case "sysClr":
                var last = color.Attribute("lastClr")?.Value;
                return SpreadOf(last) > ColorSpread ? $"#{last!.ToUpperInvariant()}" : null;
            case "schemeClr":
                var resolved = theme.ResolveScheme(value);
                if (resolved is null) return value is not null && (value.StartsWith("accent", StringComparison.Ordinal) || value.Contains("Hlink", StringComparison.OrdinalIgnoreCase) || value == "hlink") ? $"主题色 {value}" : null;
                return SpreadOf(resolved) > ColorSpread ? $"主题色 {value}（#{resolved}）" : null;
            case "prstClr":
                return value is not null && !NeutralNames.Contains(value) ? value : null;
            default:
                return null;
        }
    }

    static int SpreadOf(string? rgb)
    {
        if (rgb is null || rgb.Length != 6 || !int.TryParse(rgb, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var value)) return 0;
        var red = (value >> 16) & 0xFF;
        var green = (value >> 8) & 0xFF;
        var blue = value & 0xFF;
        return Math.Max(red, Math.Max(green, blue)) - Math.Min(red, Math.Min(green, blue));
    }

    static string? FirstColorful(IEnumerable<XElement> elements, ThemeInfo theme) =>
        elements.Where(IsColorElement).Select(item => Colorful(item, theme)).FirstOrDefault(item => item is not null);

    /// <summary>形状：spPr 里显式的填充和线条颜色；没写填充或线条时按 wps:style 的默认色（idx 为 0 表示无）。</summary>
    static string? ShapeColor(XElement shape, ThemeInfo theme)
    {
        var properties = shape.Element(WpsNs + "spPr");
        var style = shape.Element(WpsNs + "style");
        IEnumerable<XElement> StyleColors(string name) =>
            style?.Element(W.A + name) is { } reference && int.TryParse(reference.Attribute("idx")?.Value, out var index) && index > 0 ? reference.Elements() : [];
        var colors = FillColors(properties);
        if (!HasFill(properties)) colors = colors.Concat(StyleColors("fillRef"));
        if (!HasFill(properties?.Element(W.A + "ln"))) colors = colors.Concat(StyleColors("lnRef"));
        return FirstColorful(colors, theme);
    }

    /// <summary>
    /// 图表：各系列和数据点显式写的颜色；有系列没写颜色时按自动配色判断——有配色部件看部件里的颜色，
    /// 没有时看图表样式（1、9、17、25、33、41 是灰度样式，未设置时 Word 用彩色的样式 2）。
    /// </summary>
    static string? ChartColor(DocumentModel model, string chartPart, ThemeInfo theme)
    {
        var root = model.Package.TryLoad(chartPart)?.Root;
        var plot = root?.Descendants(ChartNs + "plotArea").FirstOrDefault();
        if (root is null || plot is null) return null;
        var automatic = false;
        foreach (var series in plot.Descendants(ChartNs + "ser"))
        {
            var properties = series.Element(ChartNs + "spPr");
            var colors = FillColors(properties).Concat(series.Elements(ChartNs + "dPt").SelectMany(point => FillColors(point.Element(ChartNs + "spPr"))));
            if (FirstColorful(colors, theme) is { } color) return color;
            if (!HasFill(properties) && !HasFill(properties?.Element(W.A + "ln"))) automatic = true;
        }

        if (!automatic) return null;
        if (model.Package.RelatedParts(chartPart, "/chartColorStyle").FirstOrDefault() is { } colorsPart)
        {
            return model.Package.TryLoad(colorsPart)?.Root is { } colorsRoot && FirstColorful(colorsRoot.Descendants(), theme) is { } paletteColor
                ? $"自动配色（{paletteColor}）"
                : null;
        }

        var styleValue = root.Descendants(ChartNs + "style").FirstOrDefault()?.Attribute("val")?.Value;
        return int.TryParse(styleValue, out var styleIndex) && styleIndex % 8 == 1 ? null : "自动配色（彩色）";
    }

    /// <summary>VML 形状：fillcolor / strokecolor（未写时 Word 默认白色填充、黑色线条）。</summary>
    static string? VmlColor(XElement shape)
    {
        static bool Off(string? value) => value is "f" or "false";
        foreach (var (name, toggle) in new[] { ("fillcolor", "filled"), ("strokecolor", "stroked") })
        {
            if (Off(shape.Attribute(toggle)?.Value) || shape.Attribute(name)?.Value is not { } raw) continue;
            var value = raw.Split(' ')[0].Trim();
            if (value.StartsWith('#'))
            {
                var hex = value[1..];
                if (hex.Length == 3) hex = string.Concat(hex.Select(ch => $"{ch}{ch}"));
                if (SpreadOf(hex) > ColorSpread) return $"#{hex.ToUpperInvariant()}";
            }
            else if (value.Length > 0 && char.IsLetter(value[0]) && !NeutralNames.Contains(value) && !value.StartsWith("window", StringComparison.OrdinalIgnoreCase))
            {
                return value;
            }
        }

        return null;
    }

    static IEnumerable<Finding> CheckVectorText(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("image.check_vector", true)) yield break;
        foreach (var image in context.Images.Where(item => item.IsVector && item.VectorText.Length > 0))
        {
            var hits = PrivacyRules.IdentityHits(context, image.VectorText);
            if (hits.Count > 0)
            {
                var first = hits[0];
                yield return Locate(context, rule, image, "矢量图中含有身份信息",
                    $"{image.Describe()}中的文字{string.Join("；", hits.Take(3).Select(hit => hit.Message))}{Uses(image)}",
                    "在原始绘图软件中删除图框、标注里的单位名称等信息后重新导出插入，或改为不含文字的图片",
                    RuleContext.Snippet(image.VectorText, first.Index, first.Value.Length));
                continue;
            }

            yield return Locate(context, rule, image, "矢量图中含有文字，请人工确认",
                $"{image.Describe()}中可提取到文字，未发现身份信息，请确认图框、标注里没有单位名称等内容{Uses(image)}",
                "双击图片或在原始绘图软件中检查图中文字",
                RuleContext.Snippet(image.VectorText), Severity.Low);
        }
    }

    static IEnumerable<Finding> CheckMetadata(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("image.check_metadata", true)) yield break;
        foreach (var image in context.Images)
        {
            if (image.Metadata.Count > 0)
            {
                var fields = string.Join("；", image.Metadata.Select(item => $"{item.Label}：{RuleContext.Truncate(item.Value, 40)}"));
                var hits = image.Metadata.SelectMany(item => PrivacyRules.IdentityHits(context, item.Value)).ToList();
                if (hits.Count > 0)
                {
                    yield return Locate(context, rule, image, "图片元数据中含有身份信息",
                        $"{image.Describe()}的元数据{string.Join("；", hits.Take(3).Select(hit => hit.Message))}。字段：{fields}",
                        "用画图等软件另存图片（或在文件属性 → 详细信息中删除属性和个人信息）后重新插入",
                        RuleContext.Truncate(fields, 80));
                }
                else
                {
                    yield return Locate(context, rule, image, "图片元数据含作者、版权等信息，请人工确认",
                        $"{image.Describe()}带有元数据，未发现身份信息，请确认其中没有单位或个人信息。字段：{fields}",
                        "用画图等软件另存图片（或在文件属性 → 详细信息中删除属性和个人信息）后重新插入",
                        RuleContext.Truncate(fields, 80), Severity.Low);
                }
            }

            if (image.HasGps)
            {
                yield return Locate(context, rule, image, "图片含拍摄位置（GPS）信息",
                    $"{image.Describe()}的 EXIF 中记录了拍摄位置，可能暴露投标人所在地",
                    "在文件属性 → 详细信息中删除属性和个人信息，或另存后重新插入",
                    image.FileName, Severity.Low);
            }
        }
    }
}
