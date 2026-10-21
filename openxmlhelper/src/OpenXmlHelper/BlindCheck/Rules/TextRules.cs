using System.Text.RegularExpressions;
using Yibiao.OpenXmlHelper.BlindCheck.Model;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Rules;

/// <summary>
/// 文本内容：英文标点、多余空格、制表符、软回车、特殊字符。
/// 按整段文字判定（文本块边界是任意切分的，逐块判断会把 "3" + ".14" 误判成英文句点）。
/// 这些不是招标文件的格式条款，都是低风险的排版建议。
/// </summary>
static class TextRules
{
    const string Cjk = "\u4E00-\u9FFF\u3400-\u4DBF";
    const string CjkPunct = "，。！？；：、“”‘’（）【】《》〈〉「」『』…—～·";
    const string InlineSpace = "[ \u00A0\u3000\u2000-\u200A]+";

    static readonly Regex EnglishPunct = new("[,.!?;:]");
    static readonly Regex HasCjkPattern = new($"[{Cjk}]");
    static readonly Regex Thousand = new(@"\d,\d{3}");
    static readonly Regex Abbreviation = new(@"\b[A-Za-z]{1,4}\.[A-Za-z]");
    static readonly Regex Version = new(@"\d+\.\d+(\.\d+)*");
    static readonly Regex Url = new(@"(https?://|www\.|\.com|\.cn|\.net|\.org)", RegexOptions.IgnoreCase);
    static readonly Regex Email = new(@"[\w.+-]+@[\w-]+\.[\w.]+");
    static readonly Regex Time = new(@"\d{1,2}:\d{2}");
    static readonly Regex ListNumber = new(@"^\d{1,3}(?:[.．]\d{1,3}){0,4}$");

    // 段首的章节或列表编号（第一章、一、（一）、1.1 等）后面的空格是常规排版，不算多余空格。
    static readonly Regex NumberPrefix = new(@"^[\s\u3000]*(?:第\s*[一二三四五六七八九十百零〇\d]+\s*(?:章|节|篇|部分|条|款|项)|[一二三四五六七八九十百零〇]{1,3}\s*[、.．]|[（(]\s*[一二三四五六七八九十百零〇\d]{1,3}\s*[)）]|\d{1,3}(?:[.．]\d{1,3}){0,4}[.．、)）]?)[ \u00A0\u3000]*");

    static readonly (Regex Pattern, string Name)[] SpacePatterns =
    [
        (new Regex($"([{Cjk}]){InlineSpace}([{Cjk}])"), "中文字符间空格"),
        (new Regex($"([{Cjk}]){InlineSpace}([{Regex.Escape(CjkPunct)}])"), "中文与标点间空格"),
        (new Regex($"([{Regex.Escape(CjkPunct)}]){InlineSpace}([{Cjk}])"), "标点与中文间空格"),
        (new Regex($"([{Cjk}]){InlineSpace}(\\d)"), "中文与数字间空格"),
        (new Regex($"(\\d){InlineSpace}([{Cjk}])"), "数字与中文间空格"),
    ];

    static readonly (char Value, string Name)[] IrregularChars =
    [
        ((char)0x2028, "行分隔符"), ((char)0x2029, "段分隔符"), ((char)0x200B, "零宽空格"), ((char)0x200C, "零宽非连接符"),
        ((char)0x200D, "零宽连接符"), ((char)0xFEFF, "零宽不换行空格"), ((char)0x00A0, "不换行空格"),
    ];

    static readonly Dictionary<char, string> FullWidth = new()
    {
        ['.'] = "。", [','] = "，", [';'] = "；", [':'] = "：", ['?'] = "？", ['!'] = "！",
    };

    static readonly Regex[] RemovableSpacePatterns =
    [
        new($"(?<=[{Cjk}]){InlineSpace}(?=[{Cjk}])"),
        new($"(?<=[{Cjk}]){InlineSpace}(?=[{Regex.Escape(CjkPunct)}])"),
        new($"(?<=[{Regex.Escape(CjkPunct)}]){InlineSpace}(?=[{Cjk}])"),
        new($"(?<=[{Cjk}]){InlineSpace}(?=[0-9])"),
        new($"(?<=[0-9]){InlineSpace}(?=[{Cjk}])"),
    ];

    /// <summary>英文标点对应的全角标点，修复时用。</summary>
    public static char ToFullWidth(char value) => FullWidth.TryGetValue(value, out var text) ? text[0] : value;

    public static IEnumerable<char> IrregularCharacters => IrregularChars.Select(item => item.Value);

    /// <summary>
    /// 与「多余空格」检查口径一致的可删除位置：行首行尾空格、章节编号之后以外的中文间空格、
    /// 预设要求时的全角空格。修复只删这些位置，保证修完后复查不再报。
    /// </summary>
    public static HashSet<int> RemovableSpaces(string text, BlindCheckProfile profile)
    {
        var result = new HashSet<int>();
        if (profile.Bool("text.space_rules.strip_leading_trailing", true) && text.Trim().Length > 0)
        {
            for (var index = 0; index < text.Length && IsInlineSpace(text[index]); index += 1) result.Add(index);
            for (var index = text.Length - 1; index >= 0 && IsInlineSpace(text[index]); index -= 1) result.Add(index);
        }

        if (profile.Bool("text.space_rules.remove_between_cjk", true))
        {
            var prefix = NumberPrefix.Match(text);
            var prefixEnd = prefix.Success ? prefix.Length : 0;
            foreach (var pattern in RemovableSpacePatterns)
            {
                foreach (Match match in pattern.Matches(text))
                {
                    if (match.Index < prefixEnd) continue;
                    for (var index = match.Index; index < match.Index + match.Length; index += 1) result.Add(index);
                }
            }
        }

        if (profile.Bool("text.space_rules.forbid_fullwidth_space", false))
        {
            for (var index = 0; index < text.Length; index += 1)
            {
                if (text[index] == (char)0x3000) result.Add(index);
            }
        }

        return result;
    }

    public static IEnumerable<RuleSpec> All()
    {
        yield return new RuleSpec { Id = "text.english_punct", Title = "英文标点", Category = "text", Severity = Severity.Low, PerParagraph = CheckEnglishPunct };
        yield return new RuleSpec { Id = "text.spaces", Title = "多余空格", Category = "text", Severity = Severity.Low, PerParagraph = CheckSpaces };
        yield return new RuleSpec { Id = "text.linebreak", Title = "手动换行", Category = "text", Severity = Severity.Low, SkipEmpty = false, PerParagraph = CheckLineBreak };
        yield return new RuleSpec { Id = "text.tabs", Title = "制表符", Category = "text", Severity = Severity.Low, SkipEmpty = false, PerParagraph = CheckTabs };
        yield return new RuleSpec { Id = "text.irregular", Title = "特殊字符", Category = "text", Severity = Severity.Low, SkipEmpty = false, PerParagraph = CheckIrregular };
        yield return new RuleSpec { Id = "text.halfwidth_punct", Title = "半角括号", Category = "text", Severity = Severity.Low, PerParagraph = CheckHalfwidthBrackets };
        yield return new RuleSpec { Id = "text.fullwidth_digit", Title = "全角数字", Category = "text", Severity = Severity.Low, PerParagraph = CheckFullwidthDigits };
        yield return new RuleSpec { Id = "text.fullwidth_latin", Title = "全角字母", Category = "text", Severity = Severity.Low, PerParagraph = CheckFullwidthLetters };
    }

    static bool IsCjkChar(char value) => value is >= '\u4E00' and <= '\u9FFF' or >= '\u3400' and <= '\u4DBF';

    /// <summary>
    /// 中文层级编号里的点号不是英文句点：1.编制依据、2.1 概述。
    /// 点号前是数字、编号起点在行首或分隔符后、点号后不是数字。
    /// </summary>
    static bool IsChineseListNumber(string text, int dotIndex)
    {
        var index = dotIndex - 1;
        if (index < 0 || !char.IsDigit(text[index])) return false;
        while (index >= 0 && (char.IsDigit(text[index]) || text[index] is '.' or '．')) index -= 1;
        var start = index + 1;
        if (start > 0 && !" \t\u3000、，,；;（(【[]」".Contains(text[start - 1])) return false;
        if (!ListNumber.IsMatch(text[start..dotIndex])) return false;
        return dotIndex + 1 >= text.Length || !char.IsDigit(text[dotIndex + 1]);
    }

    static bool LooksNumeric(string text, int index)
    {
        return index > 0 && index + 1 < text.Length && char.IsDigit(text[index - 1]) && char.IsDigit(text[index + 1]);
    }

    /// <summary>找出中文语境里的英文标点；3.14、1,000、v1.2、e.g.、网址、邮箱、12:30 不算。</summary>
    public static List<(int Index, char Value)> FindEnglishPunct(string text)
    {
        var hits = new List<(int, char)>();
        if (string.IsNullOrEmpty(text) || !HasCjkPattern.IsMatch(text)) return hits;
        foreach (Match match in EnglishPunct.Matches(text))
        {
            var index = match.Index;
            var value = match.Value[0];
            var context = text[Math.Max(0, index - 12)..Math.Min(text.Length, index + 12)];
            if (value == '.' && (LooksNumeric(text, index) || IsChineseListNumber(text, index))) continue;
            if (value == '.' && (Abbreviation.IsMatch(context) || Version.IsMatch(context))) continue;
            if (value == ',' && Thousand.IsMatch(context)) continue;
            if (value == ':' && Time.IsMatch(context)) continue;
            if (Url.IsMatch(context) || Email.IsMatch(context)) continue;
            var nearCjk = (index > 0 && IsCjkChar(text[index - 1])) || (index + 1 < text.Length && IsCjkChar(text[index + 1]));
            if (nearCjk) hits.Add((index, value));
        }

        return hits;
    }

    static IEnumerable<Finding> CheckEnglishPunct(RuleContext context, RuleSpec rule, ParaRecord record)
    {
        if (!context.Profile.Bool("text.check_english_punct", true)) yield break;
        var hits = FindEnglishPunct(record.Text);
        if (hits.Count == 0) yield break;
        var chars = string.Concat(hits.Select(item => item.Value).Distinct().OrderBy(item => item));
        var first = hits[0];
        yield return context.At(rule, record, $"中文内容中使用了英文标点（{chars}）",
            $"本段共 {hits.Count} 处，例如「{first.Value}」应改为「{FullWidth.GetValueOrDefault(first.Value, "全角标点")}」",
            "把中文语境里的 , . ; : ? ! 替换为 ，。；：？！",
            text: RuleContext.Snippet(record.Text, first.Index, 1));
    }

    static bool IsInlineSpace(char value) => char.IsWhiteSpace(value) && value is not ('\n' or '\t' or '\r');

    static IEnumerable<Finding> CheckSpaces(RuleContext context, RuleSpec rule, ParaRecord record)
    {
        if (!context.Profile.Bool("text.check_spaces", true)) yield break;
        var text = record.Text;
        var kinds = new List<string>();
        var firstIndex = -1;
        void Hit(string name, int index)
        {
            if (!kinds.Contains(name)) kinds.Add(name);
            if (firstIndex < 0) firstIndex = index;
        }

        if (context.Profile.Bool("text.space_rules.strip_leading_trailing", true) && text.Trim().Length > 0)
        {
            if (IsInlineSpace(text[0])) Hit("行首空格", 0);
            if (IsInlineSpace(text[^1])) Hit("行尾空格", text.Length - 1);
        }

        if (context.Profile.Bool("text.space_rules.remove_between_cjk", true))
        {
            var prefix = NumberPrefix.Match(text);
            var prefixEnd = prefix.Success ? prefix.Length : 0;
            foreach (var (pattern, name) in SpacePatterns)
            {
                var match = pattern.Matches(text).FirstOrDefault(item => item.Index + item.Length - 1 > prefixEnd);
                if (match is not null) Hit(name, match.Index);
            }
        }

        if (context.Profile.Bool("text.space_rules.forbid_fullwidth_space", false) && text.IndexOf('\u3000') is var full and >= 0)
        {
            Hit("全角空格", full);
        }

        if (kinds.Count == 0) yield break;
        yield return context.At(rule, record, $"存在多余空格（{string.Join("、", kinds)}）",
            "多余空格会造成排版不齐，也可能被视为标记", "删除行首行尾空格以及中文之间的空格，缩进请用段落格式设置",
            text: RuleContext.Snippet(text, firstIndex, 1));
    }

    static IEnumerable<Finding> CheckLineBreak(RuleContext context, RuleSpec rule, ParaRecord record)
    {
        if (!context.Profile.Bool("text.check_manual_linebreak", true)) yield break;
        var count = record.Text.Count(item => item == '\n');
        if (count == 0) yield break;
        // 文字里直接夹带的换行字符（多见于程序生成的文档）：Word 显示为空格，查找替换的 ^l 也找不到。
        var inText = record.Runs.Sum(run => run.Element.Elements(W.T).Sum(text => text.Value.Count(item => item == '\n')));
        yield return context.At(rule, record, "存在手动换行符",
            inText == count
                ? $"本段文字里夹有 {count} 个换行字符，本应分开的几段内容并成了一段，Word 中显示为空格"
                : $"本段有 {count} 个手动换行（Shift+Enter），会让每页行数不可控",
            inText == count ? "在该位置按回车分成两段" : "把手动换行改为段落回车（查找替换：^l 替换为 ^p）",
            text: RuleContext.Snippet(record.Text, record.Text.IndexOf('\n'), 1));
    }

    static IEnumerable<Finding> CheckTabs(RuleContext context, RuleSpec rule, ParaRecord record)
    {
        if (!context.Profile.Bool("text.check_tabs", true)) yield break;
        var count = record.Text.Count(item => item == '\t');
        if (count == 0) yield break;
        yield return context.At(rule, record, "文本中使用了制表符（Tab）",
            $"本段有 {count} 个制表符，容易造成缩进不一致", "删除制表符，改用段落缩进对齐",
            text: RuleContext.Snippet(record.Text, record.Text.IndexOf('\t'), 1));
    }

    static IEnumerable<Finding> CheckIrregular(RuleContext context, RuleSpec rule, ParaRecord record)
    {
        if (!context.Profile.Bool("text.check_irregular", true)) yield break;
        var found = IrregularChars.Where(item => record.Text.Contains(item.Value)).ToList();
        if (found.Count == 0) yield break;
        yield return context.At(rule, record, $"存在特殊不可见字符（{string.Join("、", found.Select(item => item.Name))}）",
            "这些字符肉眼不可见，会导致格式异常，也可能被用作标记", "用查找替换清除这些字符",
            text: RuleContext.Snippet(record.Text, record.Text.IndexOf(found[0].Value), 1));
    }

    /// <summary>中文语境的半角括号：括号紧挨着汉字，如"设备(含安装)"。</summary>
    static IEnumerable<Finding> CheckHalfwidthBrackets(RuleContext context, RuleSpec rule, ParaRecord record)
    {
        if (!context.Profile.Bool("text.check_halfwidth_brackets", false)) yield break;
        var text = record.Text;
        var hits = new List<int>();
        for (var index = 0; index < text.Length; index += 1)
        {
            if (text[index] is not ('(' or ')')) continue;
            var nearCjk = (index > 0 && IsCjkChar(text[index - 1])) || (index + 1 < text.Length && IsCjkChar(text[index + 1]));
            if (nearCjk) hits.Add(index);
        }

        if (hits.Count == 0) yield break;
        yield return context.At(rule, record, "中文内容中使用了半角括号",
            $"本段共 {hits.Count} 处，中文语境应使用全角括号（）",
            "把中文语境里的 ( ) 替换为（）",
            text: RuleContext.Snippet(text, hits[0], 1));
    }

    static IEnumerable<Finding> CheckFullwidth(RuleContext context, RuleSpec rule, ParaRecord record, string switchPath, Func<char, bool> match, string name, string hint)
    {
        if (!context.Profile.Bool(switchPath, false)) yield break;
        var text = record.Text;
        var first = -1;
        var count = 0;
        for (var index = 0; index < text.Length; index += 1)
        {
            if (!match(text[index])) continue;
            count += 1;
            if (first < 0) first = index;
        }

        if (count == 0) yield break;
        yield return context.At(rule, record, $"使用了全角{name}",
            $"本段共 {count} 个全角{name}，例如「{text[first]}」，与半角{name}混用会显得不统一",
            hint,
            text: RuleContext.Snippet(text, first, 1));
    }

    static IEnumerable<Finding> CheckFullwidthDigits(RuleContext context, RuleSpec rule, ParaRecord record)
    {
        return CheckFullwidth(context, rule, record, "text.check_fullwidth_digits", value => value is >= '０' and <= '９', "数字",
            "把全角数字 ０-９ 替换为半角数字 0-9");
    }

    static IEnumerable<Finding> CheckFullwidthLetters(RuleContext context, RuleSpec rule, ParaRecord record)
    {
        return CheckFullwidth(context, rule, record, "text.check_fullwidth_letters", value => value is >= 'Ａ' and <= 'Ｚ' or >= 'ａ' and <= 'ｚ', "字母",
            "把全角字母替换为半角字母（开始 → 更改大小写 → 半角）");
    }
}
