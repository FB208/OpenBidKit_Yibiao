using System.Text;
using System.Text.RegularExpressions;
using DocumentFormat.OpenXml.Packaging;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>
/// 按文档顺序计算段落自动编号的显示文字。编号先看段落直接格式，再沿段落样式链查找；numId 为 0 表示取消编号。
/// 同一抽象编号共用计数，上级递增时下级重新计数；lvlOverride 的级别定义和起始值优先。不展开编号链接样式，不处理 isLgl 与 lvlRestart。
/// </summary>
sealed class TemplateLayoutNumbering
{
    static readonly Regex Placeholder = new(@"%([1-9])", RegexOptions.CultureInvariant | RegexOptions.Compiled);
    static readonly string[] ChineseDigits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
    static readonly string[] LegalDigits = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
    static readonly string[] HeavenlyStems = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];

    readonly Dictionary<int, NumberingInstance> _instances = [];
    readonly Dictionary<int, Dictionary<int, Wp.Level>> _abstractLevels = [];
    readonly IReadOnlyDictionary<string, Wp.Style> _styles;
    readonly Dictionary<int, int?[]> _counters = [];
    readonly HashSet<int> _startedInstances = [];

    sealed record NumberingInstance(int AbstractId, Dictionary<int, Wp.Level> OverrideLevels, Dictionary<int, int> StartOverrides);

    public TemplateLayoutNumbering(MainDocumentPart part, IReadOnlyDictionary<string, Wp.Style> styles)
    {
        _styles = styles;
        var numbering = part.NumberingDefinitionsPart?.Numbering;
        if (numbering is null) return;
        foreach (var abstractNum in numbering.Elements<Wp.AbstractNum>())
        {
            if (abstractNum.AbstractNumberId?.Value is not int abstractId) continue;
            _abstractLevels[abstractId] = abstractNum.Elements<Wp.Level>()
                .Where(level => level.LevelIndex?.Value is not null)
                .GroupBy(level => level.LevelIndex!.Value)
                .ToDictionary(group => group.Key, group => group.First());
        }
        foreach (var instance in numbering.Elements<Wp.NumberingInstance>())
        {
            if (instance.NumberID?.Value is not int numId || instance.AbstractNumId?.Val?.Value is not int abstractId) continue;
            var overrideLevels = new Dictionary<int, Wp.Level>();
            var startOverrides = new Dictionary<int, int>();
            foreach (var levelOverride in instance.Elements<Wp.LevelOverride>())
            {
                if (levelOverride.LevelIndex?.Value is not int levelIndex) continue;
                if (levelOverride.GetFirstChild<Wp.Level>() is { } level) overrideLevels[levelIndex] = level;
                if (levelOverride.StartOverrideNumberingValue?.Val?.Value is int start) startOverrides[levelIndex] = start;
            }
            _instances[numId] = new NumberingInstance(abstractId, overrideLevels, startOverrides);
        }
    }

    /// <summary>返回段落的编号文字并推进计数；没有编号时返回 null。</summary>
    public string? Next(Wp.Paragraph paragraph)
    {
        var (numId, levelIndex) = ResolveNumbering(paragraph);
        if (numId is not int id || id == 0 || !_instances.TryGetValue(id, out var instance)) return null;
        var level = ResolveLevel(instance, levelIndex);
        if (level is null) return null;

        if (!_counters.TryGetValue(instance.AbstractId, out var counters))
        {
            counters = new int?[9];
            _counters[instance.AbstractId] = counters;
        }
        // 带起始值覆盖的编号实例首次出现时，从覆盖值重新计数。
        if (_startedInstances.Add(id))
        {
            foreach (var (overrideLevel, start) in instance.StartOverrides)
            {
                if (overrideLevel is >= 0 and < 9) counters[overrideLevel] = start - 1;
            }
        }
        counters[levelIndex] = (counters[levelIndex] ?? StartOf(instance, levelIndex) - 1) + 1;
        for (var deeper = levelIndex + 1; deeper < counters.Length; deeper += 1) counters[deeper] = null;

        var format = level.NumberingFormat?.Val?.Value;
        var text = level.LevelText?.Val?.Value ?? "";
        if (format == Wp.NumberFormatValues.Bullet) return text.Length > 0 ? "•" : null;
        var label = Placeholder.Replace(text, match =>
        {
            var referenced = int.Parse(match.Groups[1].Value) - 1;
            var referencedLevel = ResolveLevel(instance, referenced);
            var value = counters[referenced] ?? StartOf(instance, referenced);
            return FormatNumber(value, referencedLevel?.NumberingFormat?.Val?.Value);
        });
        return label.Trim().Length > 0 ? label : null;
    }

    (int? NumId, int Level) ResolveNumbering(Wp.Paragraph paragraph)
    {
        var direct = paragraph.ParagraphProperties?.NumberingProperties;
        int? numId = direct?.NumberingId?.Val?.Value;
        int? level = direct?.NumberingLevelReference?.Val?.Value;
        var styleId = paragraph.ParagraphProperties?.ParagraphStyleId?.Val?.Value;
        var visited = new HashSet<string>(StringComparer.Ordinal);
        while ((numId is null || level is null) && styleId is not null && visited.Add(styleId) && _styles.TryGetValue(styleId, out var style))
        {
            var styleNumbering = style.StyleParagraphProperties?.NumberingProperties;
            numId ??= styleNumbering?.NumberingId?.Val?.Value;
            level ??= styleNumbering?.NumberingLevelReference?.Val?.Value;
            styleId = style.BasedOn?.Val?.Value;
        }
        return (numId, Math.Clamp(level ?? 0, 0, 8));
    }

    Wp.Level? ResolveLevel(NumberingInstance instance, int levelIndex)
    {
        if (instance.OverrideLevels.TryGetValue(levelIndex, out var overrideLevel)) return overrideLevel;
        return _abstractLevels.TryGetValue(instance.AbstractId, out var levels) && levels.TryGetValue(levelIndex, out var level) ? level : null;
    }

    int StartOf(NumberingInstance instance, int levelIndex)
    {
        if (instance.StartOverrides.TryGetValue(levelIndex, out var start)) return start;
        return ResolveLevel(instance, levelIndex)?.StartNumberingValue?.Val?.Value ?? 1;
    }

    static string FormatNumber(int value, Wp.NumberFormatValues? format)
    {
        if (format is null || format == Wp.NumberFormatValues.Decimal) return value.ToString();
        if (format == Wp.NumberFormatValues.DecimalZero) return value < 10 ? $"0{value}" : value.ToString();
        if (format == Wp.NumberFormatValues.DecimalFullWidth || format == Wp.NumberFormatValues.DecimalFullWidth2)
            return new string(value.ToString().Select(digit => (char)('０' + (digit - '0'))).ToArray());
        if (format == Wp.NumberFormatValues.DecimalEnclosedCircle || format == Wp.NumberFormatValues.DecimalEnclosedCircleChinese)
            return value is >= 1 and <= 20 ? ((char)('①' + value - 1)).ToString() : value.ToString();
        if (format == Wp.NumberFormatValues.ChineseCounting || format == Wp.NumberFormatValues.ChineseCountingThousand
            || format == Wp.NumberFormatValues.JapaneseCounting || format == Wp.NumberFormatValues.TaiwaneseCounting
            || format == Wp.NumberFormatValues.TaiwaneseCountingThousand)
            return ChineseCounting(value, ChineseDigits, ["", "十", "百", "千"], format == Wp.NumberFormatValues.ChineseCounting);
        if (format == Wp.NumberFormatValues.ChineseLegalSimplified)
            return ChineseCounting(value, LegalDigits, ["", "拾", "佰", "仟"], false);
        if (format == Wp.NumberFormatValues.IdeographDigital || format == Wp.NumberFormatValues.TaiwaneseDigital)
            return string.Concat(value.ToString().Select(digit => digit == '0' ? "〇" : ChineseDigits[digit - '0']));
        if (format == Wp.NumberFormatValues.IdeographTraditional)
            return value is >= 1 and <= 10 ? HeavenlyStems[value - 1] : value.ToString();
        if (format == Wp.NumberFormatValues.UpperLetter) return Letters(value, 'A');
        if (format == Wp.NumberFormatValues.LowerLetter) return Letters(value, 'a');
        if (format == Wp.NumberFormatValues.UpperRoman) return Roman(value);
        if (format == Wp.NumberFormatValues.LowerRoman) return Roman(value).ToLowerInvariant();
        if (format == Wp.NumberFormatValues.None) return "";
        return value.ToString();
    }

    /// <summary>中文计数：十位为 1 且是最高位时省略“一”（如“十一”），中间连续的零只写一个。</summary>
    static string ChineseCounting(int value, string[] digits, string[] units, bool omitLeadingOne)
    {
        if (value <= 0 || value >= 10000) return value.ToString();
        var text = value.ToString();
        var builder = new StringBuilder();
        var pendingZero = false;
        for (var index = 0; index < text.Length; index += 1)
        {
            var digit = text[index] - '0';
            var unit = units[text.Length - index - 1];
            if (digit == 0)
            {
                pendingZero = builder.Length > 0;
                continue;
            }
            if (pendingZero) builder.Append(digits[0]);
            pendingZero = false;
            if (!(omitLeadingOne && digit == 1 && unit == units[1] && builder.Length == 0)) builder.Append(digits[digit]);
            builder.Append(unit);
        }
        return builder.ToString();
    }

    static string Letters(int value, char first)
    {
        if (value <= 0) return value.ToString();
        // Word 的字母编号超过 26 后重复字母：27 为 AA，53 为 AAA。
        var letter = (char)(first + (value - 1) % 26);
        return new string(letter, (value - 1) / 26 + 1);
    }

    static string Roman(int value)
    {
        if (value <= 0 || value >= 4000) return value.ToString();
        var numerals = new (int Value, string Text)[]
        {
            (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"),
            (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
        };
        var builder = new StringBuilder();
        foreach (var (number, text) in numerals)
        {
            while (value >= number)
            {
                builder.Append(text);
                value -= number;
            }
        }
        return builder.ToString();
    }
}
