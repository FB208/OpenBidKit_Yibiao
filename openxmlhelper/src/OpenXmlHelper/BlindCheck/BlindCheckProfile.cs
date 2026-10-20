using System.Text.Json.Nodes;
using Yibiao.OpenXmlHelper.BlindCheck.Rules;

namespace Yibiao.OpenXmlHelper.BlindCheck;

/// <summary>某类段落（正文/标题/表格）的格式目标。null 表示该项不检查。</summary>
sealed class FormatTarget
{
    public string? FontCn { get; set; }
    public string? FontEn { get; set; }
    public double? SizePt { get; set; }
    public string LineRule { get; set; } = "exact";
    public double? LinePt { get; set; }
    public double? LineMultiple { get; set; }
    public double? SpaceBeforePt { get; set; }
    public double? SpaceAfterPt { get; set; }
    public double? FirstLineIndentChars { get; set; }
    public string? Alignment { get; set; }
    public bool? Bold { get; set; }
    public bool AllowBold { get; set; }
    public bool AllowItalic { get; set; }
    public bool AllowUnderline { get; set; }
    public bool AllowColor { get; set; }
    public bool AllowHighlight { get; set; }
    public bool AllowCharSpacing { get; set; } = true;
    public bool AllowFontScaling { get; set; } = true;
    public double TolerancePt { get; set; } = 0.5;
    public double ToleranceLinePt { get; set; } = 0.5;
    public double ToleranceIndentChars { get; set; } = 0.1;

    public FormatTarget Clone() => (FormatTarget)MemberwiseClone();
}

/// <summary>
/// 格式档案（预设）。Main 已把用户预设与默认值合并并规范过，这里只按路径取值，缺省时用兜底值。
/// </summary>
sealed class BlindCheckProfile
{
    readonly JsonObject _root;
    readonly Dictionary<int, FormatTarget> _headingTargets = [];

    public FormatTarget Body { get; }
    public FormatTarget Table { get; }

    BlindCheckProfile(JsonObject root)
    {
        _root = root;
        Body = ReadTarget("body", null);
        // 表格没单独规定的项沿用正文：招标文件"均不得加粗""不允许使用彩色"这类要求同样约束表格文字。
        Table = ReadTarget("table", Body);
    }

    public static BlindCheckProfile From(JsonObject? root) => new(root ?? []);

    FormatTarget ReadTarget(string section, FormatTarget? fallback)
    {
        var target = fallback?.Clone() ?? new FormatTarget();
        var node = Node(section) as JsonObject;
        if (node is null) return target;
        target.FontCn = Text(node, "font_cn", target.FontCn);
        target.FontEn = Text(node, "font_en", target.FontEn);
        target.SizePt = Number(node, "size_pt", target.SizePt);
        target.LineRule = Text(node, "line_rule", target.LineRule) ?? "exact";
        target.LinePt = Number(node, "line_pt", target.LinePt);
        target.LineMultiple = Number(node, "line_multiple", target.LineMultiple);
        target.SpaceBeforePt = Number(node, "space_before_pt", target.SpaceBeforePt);
        target.SpaceAfterPt = Number(node, "space_after_pt", target.SpaceAfterPt);
        target.FirstLineIndentChars = Number(node, "first_line_indent_chars", target.FirstLineIndentChars);
        target.Alignment = Text(node, "alignment", target.Alignment);
        var inherit = fallback is not null;
        target.AllowBold = AllowOf(node, "allow_bold", target.AllowBold, inherit);
        target.AllowItalic = AllowOf(node, "allow_italic", target.AllowItalic, inherit);
        target.AllowUnderline = AllowOf(node, "allow_underline", target.AllowUnderline, inherit);
        target.AllowColor = AllowOf(node, "allow_color", target.AllowColor, inherit);
        target.AllowHighlight = AllowOf(node, "allow_highlight", target.AllowHighlight, inherit);
        target.AllowCharSpacing = AllowOf(node, "allow_char_spacing", target.AllowCharSpacing, inherit);
        target.AllowFontScaling = AllowOf(node, "allow_font_scaling", target.AllowFontScaling, inherit);
        target.TolerancePt = Number(node, "tolerance_pt", target.TolerancePt) ?? 0.5;
        target.ToleranceLinePt = Number(node, "tolerance_line_pt", target.ToleranceLinePt) ?? 0.5;
        target.ToleranceIndentChars = Number(node, "tolerance_indent_chars", target.ToleranceIndentChars) ?? 0.1;
        return target;
    }

    /// <summary>标题目标：标题档案里写了的项覆盖正文，没写的沿用正文（例如只规定标题字号、行距仍按正文）。</summary>
    public FormatTarget Heading(int level)
    {
        if (_headingTargets.TryGetValue(level, out var cached)) return cached;
        var target = Body.Clone();
        target.Bold = null;
        if (Node($"headings.{level}") is JsonObject node)
        {
            if (Text(node, "font_cn", null) is { } fontCn) target.FontCn = fontCn;
            if (Text(node, "font_en", null) is { } fontEn) target.FontEn = fontEn;
            if (Number(node, "size_pt", null) is { } size) target.SizePt = size;
            else if (node.ContainsKey("size_pt")) target.SizePt = null;
            if (node["bold"] is JsonValue bold && bold.TryGetValue<bool>(out var value)) target.Bold = value;
        }

        _headingTargets[level] = target;
        return target;
    }

    /// <summary>按路径取节点；exists 区分"缺这个字段"和"值为 null"。</summary>
    JsonNode? Lookup(string path, out bool exists)
    {
        exists = false;
        JsonNode? current = _root;
        foreach (var part in path.Split('.'))
        {
            if (current is not JsonObject obj || !obj.TryGetPropertyValue(part, out var next)) return null;
            current = next;
        }

        exists = true;
        return current;
    }

    public JsonNode? Node(string path) => Lookup(path, out _);

    /// <summary>开关：缺字段用兜底值；null 表示招标文件未要求，按不检查处理。</summary>
    public bool Bool(string path, bool fallback)
    {
        var node = Lookup(path, out var exists);
        if (!exists) return fallback;
        return node is JsonValue value && value.TryGetValue<bool>(out var result) && result;
    }

    public string? Text(string path, string? fallback = null)
    {
        return Node(path) is JsonValue value && value.TryGetValue<string>(out var result) && !string.IsNullOrWhiteSpace(result) ? result.Trim() : fallback;
    }

    public double? Number(string path, double? fallback = null)
    {
        return Node(path) is JsonValue value && value.TryGetValue<double>(out var result) ? result : fallback;
    }

    public List<string> Strings(string path)
    {
        return Node(path) is JsonArray array
            ? array.OfType<JsonValue>()
                .Select(item => item.TryGetValue<string>(out var text) ? text.Trim() : "")
                .Where(item => item.Length > 0)
                .Distinct(StringComparer.Ordinal)
                .ToList()
            : [];
    }

    /// <summary>单条规则开关：rules.&lt;id&gt;.enabled；未覆盖时用规则默认值。</summary>
    public bool RuleEnabled(string ruleId, bool fallback)
    {
        return Node("rules") is JsonObject rules && rules[ruleId] is JsonObject rule && rule["enabled"] is JsonValue value && value.TryGetValue<bool>(out var enabled)
            ? enabled
            : fallback;
    }

    public Severity? RuleSeverity(string ruleId)
    {
        if (Node("rules") is not JsonObject rules || rules[ruleId] is not JsonObject rule) return null;
        if (rule["severity"] is not JsonValue value || !value.TryGetValue<string>(out var text)) return null;
        return text switch
        {
            "high" => Severity.High,
            "medium" => Severity.Medium,
            "low" => Severity.Low,
            _ => null,
        };
    }

    static string? Text(JsonObject node, string name, string? fallback)
    {
        if (!node.TryGetPropertyValue(name, out var value)) return fallback;
        if (value is null) return null;
        return value is JsonValue item && item.TryGetValue<string>(out var text) && !string.IsNullOrWhiteSpace(text) ? text.Trim() : null;
    }

    static double? Number(JsonObject node, string name, double? fallback)
    {
        if (!node.TryGetPropertyValue(name, out var value)) return fallback;
        if (value is null) return null;
        return value is JsonValue item && item.TryGetValue<double>(out var number) ? number : fallback;
    }

    /// <summary>
    /// "允许"类开关：缺字段用兜底值；null 时，正文表示招标文件未要求、不检查（视为允许），
    /// 表格表示同正文（沿用兜底值）。
    /// </summary>
    static bool AllowOf(JsonObject node, string name, bool fallback, bool inherit)
    {
        if (!node.TryGetPropertyValue(name, out var value)) return fallback;
        if (value is null) return inherit ? fallback : true;
        return value is JsonValue item && item.TryGetValue<bool>(out var result) ? result : fallback;
    }
}
