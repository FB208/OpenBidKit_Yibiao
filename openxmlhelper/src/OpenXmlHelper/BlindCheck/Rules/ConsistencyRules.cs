using System.Text.RegularExpressions;
using Yibiao.OpenXmlHelper.BlindCheck.Model;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Rules;

/// <summary>
/// 一致性：只在预设没有固定要求的项上兜底，以全文多数为准找少数派。
/// 预设写了固定值的项（如正文宋体四号）由字体、段落规则负责，这里不重复报。
/// 正文中文字体只统计中文文本块，西文文本块（Times New Roman 等）不参与；图名不参与正文比较。
/// 这些结论不来自招标文件，一律是低风险建议，并作为候选交给 AI 复核判定是否需要处理。
/// </summary>
static class ConsistencyRules
{
    const string Han = "\u4E00-\u9FFF\u3400-\u4DBF";

    /// <summary>手写标题编号：家族相同才比较连续性；多段编号带上前缀，"1.2" 与 "2.2" 不是同一组。</summary>
    static readonly (string Family, Regex Pattern)[] NumberPatterns =
    [
        ("di", new Regex(@"^第\s*([一二三四五六七八九十百零〇\d]{1,4})\s*(章|篇|节|部分|条|款)")),
        ("cn_dun", new Regex(@"^([一二三四五六七八九十百零〇]{1,3})\s*[、.．]")),
        ("cn_paren", new Regex(@"^[（(]\s*([一二三四五六七八九十百零〇]{1,3})\s*[)）]")),
        ("num_multi", new Regex(@"^((?:\d{1,3}[.．]){1,4})(\d{1,3})(?![\d.．])")),
        ("num_dun", new Regex(@"^(\d{1,3})\s*、")),
        ("num_dot", new Regex(@"^(\d{1,3})\s*[.．](?!\d)")),
        ("num_paren", new Regex(@"^[（(]\s*(\d{1,3})\s*[)）]")),
        ("num_rparen", new Regex(@"^(\d{1,3})\s*[)）]")),
    ];

    static readonly Regex Spaces = new(@"[\s\u3000]+");
    static readonly Regex HasText = new($"[{Han}A-Za-z]");

    public static IEnumerable<RuleSpec> All()
    {
        yield return new RuleSpec { Id = "consistency.heading_format", Title = "同级标题格式一致性", Category = "consistency", Severity = Severity.Low, Candidate = true, Whole = CheckHeadingFormat };
        yield return new RuleSpec { Id = "consistency.heading_numbering", Title = "标题编号连续性", Category = "consistency", Severity = Severity.Low, Candidate = true, Whole = CheckHeadingNumbering };
        yield return new RuleSpec { Id = "consistency.heading_level_jump", Title = "标题层级跳跃", Category = "consistency", Severity = Severity.Low, Candidate = true, Whole = CheckLevelJump };
        yield return new RuleSpec { Id = "consistency.heading_content", Title = "标题内容异常", Category = "consistency", Severity = Severity.Low, Candidate = true, Whole = CheckHeadingContent };
        yield return new RuleSpec { Id = "consistency.body_format", Title = "正文格式一致性", Category = "consistency", Severity = Severity.Low, Candidate = true, Whole = CheckBodyFormat };
        yield return new RuleSpec { Id = "consistency.mixed_fonts", Title = "段内字体混用", Category = "consistency", Severity = Severity.Low, Candidate = true, Whole = CheckMixedFonts };
    }

    /// <summary>正文里的标题段落，按文档顺序。</summary>
    static IEnumerable<(ParaRecord Record, int Level)> Headings(RuleContext context)
    {
        foreach (var record in context.Groups.Body)
        {
            if (record.IsEmpty || context.HeadingLevel(record) is not { } level) continue;
            yield return (record, level);
        }
    }

    static IEnumerable<ParaRecord> BodyText(RuleContext context)
    {
        return context.Groups.Body.Where(record => !record.IsEmpty && !record.ObjectOnly && context.HeadingLevel(record) is null && !context.Groups.Captions.Contains(record.Element));
    }

    static bool Visible(RunRecord run) => !string.IsNullOrWhiteSpace(run.Text.Replace(DocumentModel.ObjectPlaceholder.ToString(), ""));

    /// <summary>段内按字数占比最多的中文字体（归一后的名称）。</summary>
    static string? DominantFont(ParaRecord record)
    {
        return record.Runs
            .Where(run => run.Kind == TextKind.Cjk && Visible(run) && run.Format.FontEastAsia is not null)
            .GroupBy(run => FontNames.Normalize(run.Format.FontEastAsia)!)
            .OrderByDescending(group => group.Sum(run => run.Text.Length))
            .Select(group => group.Key)
            .FirstOrDefault();
    }

    static double? DominantSize(ParaRecord record)
    {
        return record.Runs
            .Where(run => Visible(run) && run.Format.SizePt is not null)
            .GroupBy(run => run.Format.SizePt!.Value)
            .OrderByDescending(group => group.Sum(run => run.Text.Length))
            .Select(group => (double?)group.Key)
            .FirstOrDefault();
    }

    static bool? DominantBold(ParaRecord record)
    {
        var runs = record.Runs.Where(Visible).ToList();
        if (runs.Count == 0) return null;
        var bold = runs.Where(run => run.Format.Bold == true).Sum(run => run.Text.Length);
        return bold * 2 > runs.Sum(run => run.Text.Length);
    }

    static string AlignKey(string? value) => value switch
    {
        null or "" or "start" or "left" => "left",
        "end" or "right" => "right",
        "justify" or "both" => "both",
        _ => value,
    };

    static string Percent(double share) => $"{Math.Round(share * 100)}%";

    /// <summary>众数及其占比；没有过半的多数时返回 null，不做判断。</summary>
    static (string Value, double Share)? Majority(IEnumerable<(string Value, double Weight)> items)
    {
        var totals = new Dictionary<string, double>(StringComparer.Ordinal);
        foreach (var (value, weight) in items) totals[value] = totals.GetValueOrDefault(value) + weight;
        var sum = totals.Values.Sum();
        if (sum <= 0) return null;
        var top = totals.OrderByDescending(item => item.Value).First();
        var share = top.Value / sum;
        return share > 0.5 ? (top.Key, share) : null;
    }

    sealed record Trait(string Name, Func<ParaRecord, string?> Read);

    static IEnumerable<Finding> CheckHeadingFormat(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("consistency.check_heading_format", true)) yield break;
        foreach (var group in Headings(context).GroupBy(item => item.Level).OrderBy(group => group.Key))
        {
            var records = group.Select(item => item.Record).ToList();
            if (records.Count < 3) continue;
            var target = context.Profile.Heading(group.Key);
            var traits = new List<Trait>();
            if (string.IsNullOrEmpty(target.FontCn)) traits.Add(new Trait("中文字体", DominantFont));
            if (target.SizePt is null) traits.Add(new Trait("字号", record => DominantSize(record) is { } size ? Units.FormatPt(size) : null));
            if (target.Bold is null) traits.Add(new Trait("加粗", record => DominantBold(record) switch { true => "加粗", false => "不加粗", _ => null }));
            traits.Add(new Trait("对齐方式", record => ParagraphRules.AlignName(AlignKey(record.Format.Alignment))));
            traits.Add(new Trait("首行缩进", record => $"{Units.Number(Math.Round((record.Format.EffectiveFirstLineChars() ?? 0) * 2) / 2)} 字符"));

            var differences = records.ToDictionary(record => record, _ => new List<string>());
            foreach (var trait in traits)
            {
                var values = records.Select(record => (Record: record, Value: trait.Read(record))).Where(item => item.Value is not null).ToList();
                if (values.Count < 3 || Majority(values.Select(item => (item.Value!, 1.0))) is not { } majority) continue;
                foreach (var (record, value) in values)
                {
                    if (value == majority.Value) continue;
                    differences[record].Add($"{trait.Name}为「{value}」，同级多数为「{majority.Value}」（{Percent(majority.Share)}）");
                }
            }

            foreach (var record in records)
            {
                var items = differences[record];
                if (items.Count == 0) continue;
                yield return context.At(rule, record, $"{group.Key} 级标题格式与同级多数不一致",
                    string.Join("；", items),
                    "对同级标题统一使用同一个标题样式，或用格式刷与同级标题保持一致");
            }
        }
    }

    static int? ParseNumber(string text)
    {
        if (int.TryParse(text, out var number)) return number;
        const string Digits = "零一二三四五六七八九";
        var total = 0;
        var current = 0;
        foreach (var value in text)
        {
            if (value == '〇')
            {
                current = 0;
                continue;
            }

            var digit = Digits.IndexOf(value);
            if (digit >= 0) current = digit;
            else if (value == '十')
            {
                total += (current == 0 ? 1 : current) * 10;
                current = 0;
            }
            else if (value == '百')
            {
                total += (current == 0 ? 1 : current) * 100;
                current = 0;
            }
            else return null;
        }

        return total + current;
    }

    /// <summary>识别手写编号：返回编号家族、序号和编号原文；Word 自动编号不在段落文字里，不参与。</summary>
    static (string Family, int Value, string Label, int Length)? ReadNumber(string text)
    {
        var value = text.TrimStart(' ', '\u3000', '\t');
        foreach (var (family, pattern) in NumberPatterns)
        {
            var match = pattern.Match(value);
            if (!match.Success) continue;
            if (family == "num_multi")
            {
                if (ParseNumber(match.Groups[2].Value) is not { } last) return null;
                return ($"num_multi:{match.Groups[1].Value.Replace('．', '.')}", last, match.Value, match.Length);
            }

            if (ParseNumber(match.Groups[1].Value) is not { } number) return null;
            var key = family == "di" ? $"di:{match.Groups[2].Value}" : family;
            return (key, number, match.Value.Trim(), match.Length);
        }

        return null;
    }

    static IEnumerable<Finding> CheckHeadingNumbering(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("consistency.check_heading_numbering", true)) yield break;
        // 每级记录上一个同级标题的编号；遇到上级标题时，下级重新计数。
        var last = new Dictionary<int, (string Family, int Value, string Label)>();
        foreach (var (record, level) in Headings(context))
        {
            foreach (var deeper in last.Keys.Where(key => key > level).ToList()) last.Remove(deeper);
            if (ReadNumber(record.Text) is not { } number) continue;
            if (last.TryGetValue(level, out var previous) && previous.Family == number.Family)
            {
                if (number.Value == previous.Value)
                {
                    yield return context.At(rule, record, "标题编号重复",
                        $"上一个同级标题编号为「{previous.Label}」，此处仍为「{number.Label}」",
                        "核对标题编号是否重复；建议改用 Word 多级列表自动编号");
                }
                else if (number.Value > previous.Value + 1)
                {
                    yield return context.At(rule, record, "标题编号不连续",
                        $"上一个同级标题编号为「{previous.Label}」，此处为「{number.Label}」，中间缺少 {number.Value - previous.Value - 1} 个编号",
                        "核对是否遗漏章节或编号写错；建议改用 Word 多级列表自动编号");
                }
            }

            // 编号变小视为新的一组（例如附件重新从 1 开始），不报。
            last[level] = (number.Family, number.Value, number.Label);
        }
    }

    static IEnumerable<Finding> CheckLevelJump(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("consistency.check_heading_level_jump", true)) yield break;
        (int Level, string Text)? previous = null;
        foreach (var (record, level) in Headings(context))
        {
            // 编号兜底的级别是按编号样式给的名义级别（如"1、"记为 3 级），不能和真实大纲级别比较跳跃。
            if (context.Outline.SourceOf(record.Element) == "pattern") continue;
            if (previous is { } prior && level > prior.Level + 1)
            {
                yield return context.At(rule, record, "标题层级跳跃",
                    $"上一个标题是 {prior.Level} 级「{prior.Text}」，此处直接出现 {level} 级标题，中间缺少 {prior.Level + 1} 级",
                    "检查标题样式或大纲级别是否设错，必要时补齐中间层级");
            }

            previous = (level, RuleContext.Truncate(Spaces.Replace(record.Text, " ").Trim(), 20));
        }
    }

    static IEnumerable<Finding> CheckHeadingContent(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("consistency.check_heading_content", true)) yield break;
        var maxChars = (int)(context.Profile.Number("consistency.heading_max_chars") ?? 60);
        foreach (var (record, level) in Headings(context))
        {
            if (record.ObjectOnly) continue;
            var text = Spaces.Replace(record.Text.Replace(DocumentModel.ObjectPlaceholder.ToString(), ""), "");
            var rest = ReadNumber(record.Text) is { } number ? record.Text.TrimStart(' ', '\u3000', '\t')[number.Length..] : record.Text;
            if (!HasText.IsMatch(rest))
            {
                yield return context.At(rule, record, "标题只有编号没有文字",
                    $"{level} 级标题「{RuleContext.Truncate(text, 20)}」没有标题文字",
                    "补全标题文字，或取消该段的标题样式");
            }
            else if (text.Length > maxChars)
            {
                yield return context.At(rule, record, "标题文字过长",
                    $"{level} 级标题共 {text.Length} 字，超过 {maxChars} 字，常见原因是正文段落误用了标题样式",
                    "确认该段是否为标题；正文段落请改用正文样式");
            }
        }
    }

    static IEnumerable<Finding> CheckBodyFormat(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("consistency.check_body_format", true)) yield break;
        var body = context.Profile.Body;
        var records = BodyText(context).ToList();
        if (records.Count < 3) yield break;

        if (string.IsNullOrEmpty(body.FontCn))
        {
            var weights = records.SelectMany(record => record.Runs)
                .Where(run => run.Kind == TextKind.Cjk && Visible(run) && run.Format.FontEastAsia is not null)
                .Select(run => (FontNames.Normalize(run.Format.FontEastAsia)!, (double)run.Text.Length));
            if (Majority(weights) is { } majority)
            {
                foreach (var record in records)
                {
                    if (DominantFont(record) is not { } font || font == majority.Value) continue;
                    yield return context.At(rule, record, "正文中文字体与多数段落不一致",
                        $"本段为「{font}」，正文多数为「{majority.Value}」（约占 {Percent(majority.Share)}）",
                        $"确认字体是否需要统一；统一时把中文字体设为「{majority.Value}」");
                }
            }
        }

        if (body.SizePt is null)
        {
            var weights = records.SelectMany(record => record.Runs)
                .Where(run => Visible(run) && run.Format.SizePt is not null)
                .Select(run => (Units.Number(run.Format.SizePt!.Value), (double)run.Text.Length));
            if (Majority(weights) is { } majority)
            {
                var want = double.Parse(majority.Value, System.Globalization.CultureInfo.InvariantCulture);
                foreach (var record in records)
                {
                    if (DominantSize(record) is not { } size || Math.Abs(size - want) <= body.TolerancePt) continue;
                    yield return context.At(rule, record, "正文字号与多数段落不一致",
                        $"本段为{Units.FormatPt(size)}，正文多数为{Units.FormatPt(want)}（约占 {Percent(majority.Share)}）",
                        $"确认字号是否需要统一；统一时设为{Units.FormatPt(want)}");
                }
            }
        }

        if (string.IsNullOrEmpty(body.Alignment))
        {
            var alignments = records.Select(record => AlignKey(record.Format.Alignment)).ToList();
            var counts = alignments.GroupBy(item => item).ToDictionary(group => group.Key, group => group.Count());
            var top = counts.OrderByDescending(item => item.Value).First();
            for (var index = 0; index < records.Count; index += 1)
            {
                var key = alignments[index];
                var share = (double)counts[key] / records.Count;
                if (key == top.Key || share >= 0.05) continue;
                yield return context.At(rule, records[index], "正文对齐方式与多数段落不一致",
                    $"本段为「{ParagraphRules.AlignName(key)}」，正文多数为「{ParagraphRules.AlignName(top.Key)}」，该对齐方式只占 {Percent(share)}",
                    "确认是否为图表标题等特殊段落；不是时与正文统一对齐方式",
                    severity: Severity.Low);
            }
        }
    }

    static IEnumerable<Finding> CheckMixedFonts(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("consistency.check_mixed_fonts", true) || !string.IsNullOrEmpty(context.Profile.Body.FontCn)) yield break;
        foreach (var record in BodyText(context))
        {
            var fonts = record.Runs
                .Where(run => run.Kind == TextKind.Cjk && Visible(run) && run.Format.FontEastAsia is not null)
                .Select(run => FontNames.Normalize(run.Format.FontEastAsia)!)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            if (fonts.Count < 2) continue;
            yield return context.At(rule, record, "段内混用多种中文字体",
                $"本段使用了 {string.Join("、", fonts.Select(font => $"「{font}」"))}",
                "选中整段，统一设置中文字体");
        }
    }
}
