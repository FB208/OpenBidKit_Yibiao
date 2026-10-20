using System.Xml.Linq;

namespace Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

/// <summary>
/// theme1.xml 的字体方案与配色方案。docDefaults 通常只写 eastAsiaTheme="minorEastAsia"，
/// 真正的默认中文字体在主题里；不解析主题就判断不了没显式设字体的正文。
/// </summary>
sealed class ThemeInfo
{
    static readonly string[] ScriptPriority = ["Hans", "Hant", "Jpan", "Hang", "Kore"];

    static readonly Dictionary<string, string> ThemeColorMap = new(StringComparer.Ordinal)
    {
        ["dark1"] = "dk1", ["light1"] = "lt1", ["dark2"] = "dk2", ["light2"] = "lt2",
        ["text1"] = "dk1", ["text2"] = "dk2", ["background1"] = "lt1", ["background2"] = "lt2",
        ["accent1"] = "accent1", ["accent2"] = "accent2", ["accent3"] = "accent3",
        ["accent4"] = "accent4", ["accent5"] = "accent5", ["accent6"] = "accent6",
        ["hyperlink"] = "hlink", ["followedHyperlink"] = "folHlink",
    };

    static readonly Dictionary<string, string> SystemColors = new(StringComparer.OrdinalIgnoreCase)
    {
        ["windowText"] = "000000", ["window"] = "FFFFFF", ["highlight"] = "0078D7",
        ["btnFace"] = "F0F0F0", ["btnShadow"] = "A0A0A0", ["grayText"] = "808080",
        ["captionText"] = "000000", ["infoText"] = "000000",
    };

    readonly Dictionary<string, string> _fonts = new(StringComparer.Ordinal);
    readonly Dictionary<string, string> _colors = new(StringComparer.Ordinal);

    public static ThemeInfo Parse(XDocument? document)
    {
        var theme = new ThemeInfo();
        var root = document?.Root;
        if (root is null) return theme;

        var scheme = root.Descendants(W.A + "fontScheme").FirstOrDefault();
        if (scheme is not null)
        {
            theme.ReadFontBlock("major", scheme.Element(W.A + "majorFont"));
            theme.ReadFontBlock("minor", scheme.Element(W.A + "minorFont"));
        }

        var colors = root.Descendants(W.A + "clrScheme").FirstOrDefault();
        if (colors is not null)
        {
            foreach (var child in colors.Elements())
            {
                var srgb = child.Element(W.A + "srgbClr")?.Attribute("val")?.Value;
                var system = child.Element(W.A + "sysClr");
                var value = srgb
                    ?? system?.Attribute("lastClr")?.Value
                    ?? (system?.Attribute("val")?.Value is { } name && SystemColors.TryGetValue(name, out var mapped) ? mapped : null);
                if (!string.IsNullOrWhiteSpace(value)) theme._colors[child.Name.LocalName] = value.ToUpperInvariant();
            }
        }

        return theme;
    }

    void ReadFontBlock(string prefix, XElement? block)
    {
        if (block is null) return;
        var latin = block.Element(W.A + "latin")?.Attribute("typeface")?.Value;
        if (!string.IsNullOrWhiteSpace(latin))
        {
            _fonts[prefix + "Ascii"] = latin;
            _fonts[prefix + "HAnsi"] = latin;
        }

        var complex = block.Element(W.A + "cs")?.Attribute("typeface")?.Value;
        if (!string.IsNullOrWhiteSpace(complex)) _fonts[prefix + "Bidi"] = complex;

        var eastAsia = block.Element(W.A + "ea")?.Attribute("typeface")?.Value;
        if (!string.IsNullOrWhiteSpace(eastAsia))
        {
            _fonts[prefix + "EastAsia"] = eastAsia;
            return;
        }

        // WPS 等文档的 ea 常为空，按 script 表回退，中文优先 Hans。
        var scripts = block.Elements(W.A + "font")
            .Select(item => (Script: item.Attribute("script")?.Value, Face: item.Attribute("typeface")?.Value))
            .Where(item => !string.IsNullOrWhiteSpace(item.Script) && !string.IsNullOrWhiteSpace(item.Face))
            .GroupBy(item => item.Script!, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First().Face!, StringComparer.Ordinal);
        foreach (var script in ScriptPriority)
        {
            if (scripts.TryGetValue(script, out var face))
            {
                _fonts[prefix + "EastAsia"] = face;
                return;
            }
        }
    }

    /// <summary>"minorEastAsia" -> 字体名。</summary>
    public string? ResolveFont(string? key)
    {
        return key is not null && _fonts.TryGetValue(key, out var value) ? value : null;
    }

    /// <summary>"accent1" / "text1" -> RRGGBB。</summary>
    public string? ResolveColor(string? key)
    {
        if (key is null || !ThemeColorMap.TryGetValue(key, out var slot)) return null;
        return _colors.TryGetValue(slot, out var value) ? value : null;
    }

    static readonly Dictionary<string, string> SchemeAliases = new(StringComparer.Ordinal)
    {
        ["tx1"] = "dk1", ["tx2"] = "dk2", ["bg1"] = "lt1", ["bg2"] = "lt2",
    };

    /// <summary>DrawingML 的 schemeClr（"accent1" / "tx1" / "bg1"）-> RRGGBB；phClr 等占位色返回 null。</summary>
    public string? ResolveScheme(string? key)
    {
        if (key is null) return null;
        return _colors.TryGetValue(SchemeAliases.GetValueOrDefault(key, key), out var value) ? value : null;
    }
}
