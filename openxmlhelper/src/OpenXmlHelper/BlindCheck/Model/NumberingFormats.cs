using System.Text.RegularExpressions;
using System.Xml.Linq;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Model;

/// <summary>段落自动编号（Word 多级列表）的显示格式：编号格式、编号文字模板里用到的各级格式，以及模板里的级数。</summary>
sealed record AutoNumber(string Format, string Text, IReadOnlyList<string> Formats)
{
    /// <summary>编号文字里的级数，如 "%1.%2" 为 2。</summary>
    public int Depth => Formats.Count;
}

/// <summary>段落用到的编号级别：numId、所属抽象编号、级别序号，以及生效的级别定义（lvlOverride 里的优先）。</summary>
sealed record NumberingLevel(string NumId, string AbstractId, int Index, XElement Level);

/// <summary>
/// numbering.xml 的最小读取：num → abstractNum（含 lvlOverride 里的级别定义）→ 各级 numFmt / lvlText。
/// 段落的编号先看直接格式的 numPr，再看段落样式链；numId 为 0 表示取消编号。numStyleLink 等链接样式不展开。
/// </summary>
sealed class NumberingFormats
{
    static readonly Regex Placeholder = new(@"%(\d)");

    readonly Dictionary<string, (string AbstractId, Dictionary<int, XElement> Levels)> _nums = new(StringComparer.Ordinal);
    readonly StyleSheet _sheet;

    NumberingFormats(StyleSheet sheet) => _sheet = sheet;

    /// <summary>numbering.xml 的 part 名；文档没有编号定义时为 null。</summary>
    public string? Part { get; private set; }

    /// <summary>load 指定读取 part 的方式：修复时传入修复上下文的读取，改动的就是要写回的那份 XML。</summary>
    public static NumberingFormats Load(DocumentModel model, Func<string, XDocument?>? load = null)
    {
        var formats = new NumberingFormats(model.Sheet);
        var part = model.Package.RelatedPart(model.DocumentPart, "/numbering", "word/numbering.xml");
        var root = part is null ? null : (load ?? model.Package.TryLoad)(part)?.Root;
        if (root is null) return formats;
        formats.Part = part;
        var abstracts = root.Elements(W.Ns + "abstractNum")
            .Where(item => W.Attr(item, "abstractNumId") is not null)
            .GroupBy(item => W.Attr(item, "abstractNumId")!, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => Levels(group.First()), StringComparer.Ordinal);
        foreach (var num in root.Elements(W.Ns + "num"))
        {
            var numId = W.Attr(num, "numId");
            var abstractId = W.ValOf(num.Element(W.Ns + "abstractNumId"));
            if (numId is null || abstractId is null || !abstracts.TryGetValue(abstractId, out var baseLevels)) continue;
            var levels = new Dictionary<int, XElement>(baseLevels);
            foreach (var overrideLevel in num.Elements(W.Ns + "lvlOverride"))
            {
                if (overrideLevel.Element(W.Ns + "lvl") is { } level && W.IntAttr(overrideLevel, "ilvl") is { } index) levels[index] = level;
            }

            formats._nums[numId] = (abstractId, levels);
        }

        return formats;
    }

    static Dictionary<int, XElement> Levels(XElement abstractNum)
    {
        var result = new Dictionary<int, XElement>();
        foreach (var level in abstractNum.Elements(W.Ns + "lvl"))
        {
            if (W.IntAttr(level, "ilvl") is { } index) result.TryAdd(index, level);
        }

        return result;
    }

    /// <summary>段落用到的编号级别；没有编号或编号被取消时返回 null。</summary>
    public NumberingLevel? LevelOf(ParaRecord record)
    {
        var numPr = record.Element.Element(W.PPr)?.Element(W.NumPr);
        string? numId = W.ValOf(numPr?.Element(W.NumId));
        int? ilvl = W.IntAttr(numPr?.Element(W.Ilvl), "val");
        if (numId is null)
        {
            foreach (var style in _sheet.Chain(_sheet.ResolveParagraphStyle(record.Format.StyleId), "paragraph"))
            {
                if (style.PPr?.Element(W.NumPr) is not { } styleNumPr) continue;
                numId ??= W.ValOf(styleNumPr.Element(W.NumId));
                ilvl ??= W.IntAttr(styleNumPr.Element(W.Ilvl), "val");
                if (numId is not null) break;
            }
        }

        if (numId is null or "0" || !_nums.TryGetValue(numId, out var num)) return null;
        var current = ilvl ?? 0;
        return num.Levels.TryGetValue(current, out var level) ? new NumberingLevel(numId, num.AbstractId, current, level) : null;
    }

    /// <summary>numId 下某一级生效的级别定义。</summary>
    public XElement? Level(string numId, int index)
    {
        return _nums.TryGetValue(numId, out var num) ? num.Levels.GetValueOrDefault(index) : null;
    }

    /// <summary>段落的自动编号；没有编号或编号被取消时返回 null。</summary>
    public AutoNumber? Of(ParaRecord record)
    {
        if (LevelOf(record) is not { } used) return null;
        var level = used.Level;
        var text = W.ValOf(level.Element(W.Ns + "lvlText")) ?? "";
        // isLgl（正规编号）把编号文字里引用的各级都显示成阿拉伯数字。
        var legal = level.Element(W.Ns + "isLgl") is { } isLgl && W.OnOff(isLgl) != false;
        string FormatOf(int index) => legal ? "decimal" : W.ValOf((Level(used.NumId, index) ?? level).Element(W.Ns + "numFmt")) ?? "decimal";
        var referenced = Placeholder.Matches(text).Select(match => FormatOf(int.Parse(match.Groups[1].Value) - 1)).ToList();
        return new AutoNumber(FormatOf(used.Index), text, referenced);
    }
}
