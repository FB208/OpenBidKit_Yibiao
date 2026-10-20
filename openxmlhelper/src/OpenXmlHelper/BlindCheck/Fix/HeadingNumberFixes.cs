using System.Text.RegularExpressions;
using System.Xml.Linq;
using Yibiao.OpenXmlHelper.BlindCheck.Model;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;
using Yibiao.OpenXmlHelper.BlindCheck.Rules;
using static Yibiao.OpenXmlHelper.BlindCheck.Fix.PropertyWriter;
using HeadingNumber = Yibiao.OpenXmlHelper.BlindCheck.Rules.StructureRules.HeadingNumber;

namespace Yibiao.OpenXmlHelper.BlindCheck.Fix;

/// <summary>
/// 标题序号改为阿拉伯数字分级编号（招标文件要求时）。只改有把握的三种情况，其余记一条说明留给人工：
/// 自动编号把标题用到的编号级别改为阿拉伯数字；第一个阿拉伯数字标题之前带其他序号的同级或上级标题是文档总标题或分册名，删去序号；
/// 全文手写的都是其他序号、层级从 1 级逐级展开且同级写法一致时，按标题级别重排为 1、1.1、1.1.1。
/// 手写序号改动后，目录里对应条目的文字一并修改；自动编号的目录要在 Word 中更新域。
/// </summary>
static class HeadingNumberFixes
{
    static readonly Regex Spaces = new(@"\s+");
    static readonly Regex NumberChars = new(@"[一二三四五六七八九十百零〇\d]+");
    static readonly Regex Letters = new(@"[IVXⅠ-Ⅻ]+|[A-Za-z]");
    static readonly Regex Circled = new(@"[①-⑳]");

    public static int Fix(FixContext fix)
    {
        var numbering = NumberingFormats.Load(fix.Model, fix.Extra);
        var headings = StructureRules.HeadingNumbers(fix.Rules, numbering);
        var count = FixAutoNumbers(fix, numbering, headings, out var manual);
        var renames = WrittenRenames(headings, out var unsure);
        manual += unsure + headings.Count(item => item.Kind == "arabic" && item.DepthMismatch);

        var toc = fix.Model.BodyElement.Descendants(W.P).Where(fix.Rules.Outline.IsToc).ToList();
        foreach (var (heading, replacement) in renames)
        {
            var element = heading.Record.Element;
            var title = OutlineAnalyzer.NormalizeTitle(DocumentModel.ParagraphText(element));
            if (!ReplacePrefix(element, heading.Prefix, replacement))
            {
                manual += 1;
                continue;
            }

            fix.Touch(heading.Record);
            count += 1;
            var entry = toc.FirstOrDefault(item => OutlineAnalyzer.NormalizeTitle(DocumentModel.ParagraphText(item)) == title);
            if (entry is null) continue;
            toc.Remove(entry);
            if (ReplacePrefix(entry, heading.Prefix, replacement)) fix.Touch(fix.Model.DocumentPart);
        }

        if (manual > 0) fix.Note($"有 {manual} 个标题的序号写法混用或层级不清，没有自动修改，请对照招标要求手动改为阿拉伯数字分级编号");
        return count;
    }

    /// <summary>把段落开头的手写序号换成 replacement（空串即删去），序号后的空格一并去掉；开头不是这个序号时不改。</summary>
    static bool ReplacePrefix(XElement paragraph, string prefix, string replacement)
    {
        var text = DocumentModel.ParagraphText(paragraph);
        var start = text.Length - text.TrimStart(' ', '　', '\t').Length;
        if (prefix.Length == 0 || !text[start..].StartsWith(prefix, StringComparison.Ordinal)) return false;
        var end = start + prefix.Length;
        while (end < text.Length && text[end] is ' ' or '　') end += 1;
        return TextFixes.ReplaceRange(paragraph, start, end - start, replacement);
    }

    /// <summary>序号的写法：数字、字母、圈码换成占位符后的样子，如"第#章""（#）""#、"。</summary>
    static string ShapeOf(string prefix)
    {
        var value = Spaces.Replace(prefix, "").Replace('(', '（').Replace(')', '）').Replace('．', '.');
        return NumberChars.Replace(Letters.Replace(Circled.Replace(value, "①"), "A"), "#");
    }

    /// <summary>手写序号的改法（标题 → 新序号，空串表示删去序号）；unsure 是无法判断、留给人工的标题数。</summary>
    static List<(HeadingNumber Heading, string Replacement)> WrittenRenames(List<HeadingNumber> headings, out int unsure)
    {
        var others = headings.Count(item => item.Kind == "other");
        unsure = 0;
        if (others == 0) return [];

        var firstArabic = headings.FindIndex(item => item.Kind is "arabic" or "auto");
        if (firstArabic >= 0)
        {
            // 后面的阿拉伯数字从 1 开始编号，说明前面带其他序号的标题不在这套编号里，是总标题或分册名。
            var first = headings[firstArabic];
            var startsAtOne = first.Kind == "auto" || first.Prefix.TakeWhile(char.IsAsciiDigit).SequenceEqual("1");
            var titles = startsAtOne ? headings.Take(firstArabic).Where(item => item.Kind == "other" && item.Level <= first.Level).ToList() : [];
            unsure = others - titles.Count;
            return titles.Select(item => (item, "")).ToList();
        }

        var numbered = headings.SkipWhile(item => item.Kind == "none").ToList();
        if (numbered.Any(item => item.Kind != "other") || !Renumberable(numbered))
        {
            unsure = others;
            return [];
        }

        var counters = new int[10];
        var result = new List<(HeadingNumber, string)>();
        foreach (var heading in numbered)
        {
            counters[heading.Level] += 1;
            Array.Clear(counters, heading.Level + 1, counters.Length - heading.Level - 1);
            var number = string.Join(".", counters.Skip(1).Take(heading.Level));
            result.Add((heading, number + (heading.Prefix.TrimEnd().EndsWith('、') ? "、" : " ")));
        }

        return result;
    }

    /// <summary>能否按级别重排：从 1 级开始、不跳级，同级的序号写法相同、不同级的写法不同（否则级别多半没识别对）。</summary>
    static bool Renumberable(List<HeadingNumber> numbered)
    {
        var previous = 0;
        var shapes = new Dictionary<int, string>();
        foreach (var heading in numbered)
        {
            if (heading.Level > previous + 1 || heading.Level >= 10) return false;
            var shape = ShapeOf(heading.Prefix);
            if (shapes.TryGetValue(heading.Level, out var known) && known != shape) return false;
            shapes[heading.Level] = shape;
            previous = heading.Level;
        }

        return shapes.Values.Distinct().Count() == shapes.Count;
    }

    /// <summary>
    /// 自动编号：把有问题的标题用到的编号级别改为阿拉伯数字（加 isLgl，引用的上级也显示为阿拉伯数字），
    /// 编号文字改为与标题级别相同的级数（如 2 级为"%1.%2"），保留原来的"、"后缀和编号后的制表符或空格。
    /// 同一套编号里各标题"级别序号 − 标题级别"必须一致，且这些级别没有被正文列表共用，否则改动会让编号错位或波及正文列表，留给人工。
    /// </summary>
    static int FixAutoNumbers(FixContext fix, NumberingFormats numbering, List<HeadingNumber> headings, out int manual)
    {
        manual = 0;
        var used = headings.Where(item => item.Kind == "auto")
            .Select(item => (Heading: item, Level: numbering.LevelOf(item.Record)!))
            .ToList();
        if (numbering.Part is null || !used.Any(item => item.Heading.OtherFormat is not null || item.Heading.DepthMismatch)) return 0;

        var headingElements = headings.Select(item => item.Record.Element).ToHashSet(ReferenceEqualityComparer.Instance);
        var listLevels = fix.Rules.Groups.All
            .Where(record => !headingElements.Contains(record.Element))
            .Select(numbering.LevelOf)
            .Where(item => item is not null)
            .Select(item => (item!.AbstractId, item.Index))
            .ToHashSet();
        var count = 0;
        foreach (var group in used.GroupBy(item => item.Level.AbstractId))
        {
            var wrong = group.Where(item => item.Heading.OtherFormat is not null || item.Heading.DepthMismatch).ToList();
            if (wrong.Count == 0) continue;
            var offsets = group.Select(item => item.Level.Index - item.Heading.Level + 1).Distinct().ToList();
            if (offsets.Count != 1 || offsets[0] < 0 || group.Any(item => listLevels.Contains((item.Level.AbstractId, item.Level.Index))))
            {
                manual += wrong.Count;
                continue;
            }

            foreach (var (heading, target) in wrong.DistinctBy(item => item.Level.Level))
            {
                var level = target.Level;
                var text = W.ValOf(level.Element(W.Ns + "lvlText")) ?? "";
                var placeholders = Enumerable.Range(offsets[0] + 1, heading.Level).Select(index => $"%{index}");
                var format = LevelChild(level, "numFmt");
                SetVal(format, "decimal");
                SetAttr(format, "format", null);
                LevelChild(level, "isLgl");
                SetVal(LevelChild(level, "lvlText"), string.Join(".", placeholders) + (text.TrimEnd().EndsWith('、') ? "、" : ""));
            }

            count += wrong.Count;
        }

        if (count > 0)
        {
            fix.Touch(numbering.Part);
            if (fix.Rules.Outline.Toc.HasToc) fix.Note($"已把 {count} 个标题的自动编号改为阿拉伯数字，目录里的编号要在 Word 中右键目录「更新域」后才会变");
        }

        return count;
    }
}
