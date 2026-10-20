using System.Xml.Linq;
using System.Diagnostics;
using System.Text.RegularExpressions;
using Yibiao.OpenXmlHelper.BlindCheck.Model;

namespace Yibiao.OpenXmlHelper.BlindCheck.Rules;

/// <summary>规则作用的段落角色：全部，或只查正文段落（排除标题）。</summary>
enum RuleKinds
{
    All,
    BodyText,
}

/// <summary>一条规则：元信息、作用范围和检查函数。三种检查函数只设其一。</summary>
sealed class RuleSpec
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    public required string Category { get; init; }
    public required Severity Severity { get; init; }
    public bool DefaultEnabled { get; init; } = true;
    /// <summary>候选规则：只能初筛（统计推断、启发式识别），报出的问题都交给 AI 复核判定是否真的违反要求。</summary>
    public bool Candidate { get; init; }
    /// <summary>逐段规则是否作用于正文顶层段落与表格内段落。</summary>
    public bool InBody { get; init; } = true;
    public bool InTable { get; init; } = true;
    public RuleKinds Kinds { get; init; } = RuleKinds.All;
    public bool SkipEmpty { get; init; } = true;
    public bool SkipObjectOnly { get; init; }
    /// <summary>
    /// 逐段规则是否覆盖全部区域：除正文外，还检查封面、目录、页眉页脚、脚注尾注和文本框。
    /// 这些区域的格式由招标文件另行规定或不受正文要求约束，只有隐藏文字这类与格式无关的规则才查。
    /// </summary>
    public bool AllRegions { get; init; }
    public Func<RuleContext, RuleSpec, IEnumerable<Finding>>? Whole { get; init; }
    public Func<RuleContext, RuleSpec, ParaRecord, IEnumerable<Finding>>? PerParagraph { get; init; }
    public Func<RuleContext, RuleSpec, ParaRecord, RunRecord, IEnumerable<Finding>>? PerRun { get; init; }
}

/// <summary>引擎为规则准备的分组：目录区间整体排除在正文规则之外。</summary>
sealed class ParaGroups
{
    public List<ParaRecord> All { get; } = [];
    public List<ParaRecord> Body { get; } = [];
    public List<ParaRecord> Table { get; } = [];
    public List<ParaRecord> Toc { get; } = [];
    /// <summary>封面段落：不参与正文格式规则，身份信息照常检查。</summary>
    public List<ParaRecord> Cover { get; } = [];
    public HashSet<XElement> CoverElements { get; } = new(ReferenceEqualityComparer.Instance);
    /// <summary>图名、表名：不按正文的对齐和首行缩进检查，也不参与正文一致性比较；字体、字号、行距照常检查。</summary>
    public HashSet<XElement> Captions { get; } = new(ReferenceEqualityComparer.Instance);
}

sealed class RuleContext
{
    static readonly Regex Spaces = new(@"\s+");
    static readonly Regex CaptionStart = new(@"^(附图|附表|图|表)\s*([0-9０-９一二三四五六七八九十]|[：:．.、\-—–])");
    const int MaxCaptionChars = 40;

    public required DocumentModel Model { get; init; }
    public required BlindCheckProfile Profile { get; init; }
    public required Outline Outline { get; init; }
    public required ParaGroups Groups { get; init; }
    public required IReadOnlyList<SensitiveWord> SensitiveWords { get; init; }
    public IReadOnlyList<ImageInfo> Images { get; init; } = [];
    /// <summary>Main 解码图片得到的结论，按图片 part 名索引；未开启彩色检查时为空。</summary>
    public IReadOnlyDictionary<string, ImageFact> ImageFacts { get; init; } = new Dictionary<string, ImageFact>();

    const int MaxCoverLines = 15;
    const int MaxCoverChars = 300;
    const int MaxCoverBlocks = 80;

    /// <summary>
    /// 封面：正文开头到第一个分页符或分节符为止的内容。其间出现标题或表格、文字超过 15 段 300 字、
    /// 或开头 80 段内找不到分页时都不算封面，宁可不识别也不把正文当封面跳过。
    /// </summary>
    static List<ParaRecord> DetectCover(DocumentModel model, Outline outline)
    {
        var candidates = new List<ParaRecord>();
        var lines = 0;
        var chars = 0;
        foreach (var block in model.BodyBlocks.Take(MaxCoverBlocks))
        {
            if (block.IsTable || !model.Records.TryGetValue(block.Element, out var record)) return [];
            if (record.Format.PageBreakBefore && candidates.Count > 0) return lines > 0 ? candidates : [];
            var ends = record.HasPageBreak || record.HasSectionBreak;
            if (outline.IsToc(block.Element)) return ends && lines > 0 ? candidates : [];
            if (outline.LevelOf(block.Element) is not null) return [];
            candidates.Add(record);
            if (!record.IsEmpty)
            {
                lines += 1;
                chars += record.Text.Trim().Length;
                if (lines > MaxCoverLines || chars > MaxCoverChars) return [];
            }

            if (ends) return lines > 0 ? candidates : [];
        }

        return [];
    }

    public static ParaGroups CollectGroups(DocumentModel model, Outline outline, bool detectCover)
    {
        var groups = new ParaGroups();
        if (detectCover)
        {
            foreach (var record in DetectCover(model, outline))
            {
                groups.Cover.Add(record);
                groups.CoverElements.Add(record.Element);
            }
        }

        var tables = model.TableParagraphs.GroupBy(item => item.Container.TableIndex ?? 0).ToDictionary(group => group.Key, group => group.ToList());
        var bodyRecords = model.BodyParagraphs.GetEnumerator();
        var blocks = model.BodyBlocks;
        var tableIndex = 0;
        string? heading = null;
        for (var index = 0; index < blocks.Count; index += 1)
        {
            var block = blocks[index];
            if (block.IsTable)
            {
                tableIndex += 1;
                if (!tables.TryGetValue(tableIndex, out var records)) continue;
                foreach (var record in records)
                {
                    record.HeadingContext = heading;
                    groups.Table.Add(record);
                    groups.All.Add(record);
                }

                continue;
            }

            if (!bodyRecords.MoveNext()) break;
            var paragraph = bodyRecords.Current;
            // 目录前面单独一行的"目录"二字属于目录，不按正文格式检查。
            var tocTitle = OutlineAnalyzer.IsTocTitle(paragraph.Text)
                && index + 1 < blocks.Count && !blocks[index + 1].IsTable && outline.IsToc(blocks[index + 1].Element);
            if (outline.IsToc(paragraph.Element) || tocTitle)
            {
                groups.Toc.Add(paragraph);
                continue;
            }

            if (groups.CoverElements.Contains(paragraph.Element)) continue;

            if (outline.LevelOf(paragraph.Element) is not null) heading = Truncate(Spaces.Replace(paragraph.Text, " ").Trim(), 30);
            else if (IsCaption(model, blocks, index, paragraph)) groups.Captions.Add(paragraph.Element);
            paragraph.HeadingContext = heading;
            groups.Body.Add(paragraph);
            groups.All.Add(paragraph);
        }

        return groups;
    }

    /// <summary>
    /// 图名、表名：40 字以内、以"图、表、附图、附表"加编号或标点开头，并且紧挨着只有图片的段落或表格
    /// （中间隔的空段落不算）。
    /// </summary>
    static bool IsCaption(DocumentModel model, List<BodyBlock> blocks, int index, ParaRecord paragraph)
    {
        var text = paragraph.Text.Trim();
        if (text.Length == 0 || text.Length > MaxCaptionChars || !CaptionStart.IsMatch(text)) return false;
        bool Neighbor(int step)
        {
            for (var at = index + step; at >= 0 && at < blocks.Count; at += step)
            {
                if (blocks[at].IsTable) return true;
                if (!model.Records.TryGetValue(blocks[at].Element, out var record)) return false;
                if (record.ObjectOnly) return true;
                if (!record.IsEmpty) return false;
            }

            return false;
        }

        return Neighbor(-1) || Neighbor(1);
    }

    public int? HeadingLevel(ParaRecord record) => record.Container.Kind == ContainerKind.Body ? Outline.LevelOf(record.Element) : null;

    /// <summary>
    /// 按段落角色取格式目标：表格用表格配置；标题用标题配置覆盖正文；其余用正文配置。
    /// 检查与将来的修复共用这一个入口，避免"报错但修不掉"。
    /// </summary>
    public (FormatTarget Target, string Role, int? Level) TargetFor(ParaRecord record)
    {
        if (record.Container.InTable) return (Profile.Table, "table", null);
        var level = HeadingLevel(record);
        return level is { } value ? (Profile.Heading(value), "heading", value) : (Profile.Body, "body", null);
    }

    public Severity SeverityOf(RuleSpec rule, Severity? specific = null)
    {
        return Profile.RuleSeverity(rule.Id) ?? specific ?? rule.Severity;
    }

    public string Where(ParaRecord record)
    {
        var container = record.Container;
        var location = container.Kind switch
        {
            ContainerKind.Body => Outline.IsToc(record.Element) ? "目录" : Groups.CoverElements.Contains(record.Element) ? "封面" : $"正文第 {record.BodyIndex} 段",
            ContainerKind.Table => $"第 {container.TableIndex} 个表格 第 {container.Row + 1} 行第 {container.Column + 1} 列",
            ContainerKind.Header => PartLabel(container.Part),
            ContainerKind.Footer => PartLabel(container.Part),
            ContainerKind.Footnote => "脚注",
            ContainerKind.Endnote => "尾注",
            ContainerKind.Textbox => "文本框",
            _ => "全文",
        };
        return string.IsNullOrEmpty(record.HeadingContext) ? location : $"{location} · {record.HeadingContext}";
    }

    /// <summary>页眉页脚 part 的人读名称："第 2 节页眉（首页）"。</summary>
    public string PartLabel(string part)
    {
        var isHeader = Model.HeaderParts.Contains(part, StringComparer.OrdinalIgnoreCase);
        var isFooter = Model.FooterParts.Contains(part, StringComparer.OrdinalIgnoreCase);
        var kind = isHeader ? "页眉" : isFooter ? "页脚" : part == Model.FootnotesPart ? "脚注" : part == Model.EndnotesPart ? "尾注" : part == Model.CommentsPart ? "批注" : "正文";
        if ((!isHeader && !isFooter) || !Model.HeaderFooterOwners.TryGetValue(part, out var owner)) return kind;
        var type = owner.Type switch
        {
            "first" => "（首页）",
            "even" => "（偶数页）",
            _ => "",
        };
        return Model.Sections.Count > 1 ? $"第 {owner.Section + 1} 节{kind}{type}" : $"{kind}{type}";
    }

    public string Origin(string? source, ParaRecord record)
    {
        return source switch
        {
            FormatSource.Direct => "直接格式",
            FormatSource.CharStyle => "字符样式",
            FormatSource.ParaStyle => string.IsNullOrEmpty(record.Format.StyleName) ? "段落样式" : $"段落样式「{record.Format.StyleName}」",
            FormatSource.TableStyle => "表格样式",
            FormatSource.DocDefault => "文档默认格式",
            _ => "",
        };
    }

    public static string Snippet(string text, int start = -1, int length = 0)
    {
        var value = text ?? "";
        if (start >= 0)
        {
            var from = Math.Max(0, start - 20);
            var to = Math.Min(value.Length, start + length + 20);
            var piece = Spaces.Replace(value[from..to], " ");
            return (from > 0 ? "…" : "") + piece.Trim() + (to < value.Length ? "…" : "");
        }

        return Truncate(Spaces.Replace(value, " ").Trim(), 60);
    }

    public static string Truncate(string value, int length) => value.Length <= length ? value : value[..length] + "…";

    public Finding At(RuleSpec rule, ParaRecord record, string message, string detail, string hint, string origin = "", Severity? severity = null, string? text = null, bool candidate = false)
    {
        return new Finding
        {
            RuleId = rule.Id,
            Severity = SeverityOf(rule, severity),
            Message = message,
            Where = Where(record),
            Text = text ?? Snippet(record.Text),
            Detail = detail,
            Origin = origin,
            Hint = hint,
            Locator = Model.Locators.GetValueOrDefault(record.Element, ""),
            Candidate = candidate,
        };
    }

    public Finding Global(RuleSpec rule, string message, string where, string detail, string hint, string text = "", Severity? severity = null)
    {
        return new Finding
        {
            RuleId = rule.Id,
            Severity = SeverityOf(rule, severity),
            Message = message,
            Where = where,
            Text = text,
            Detail = detail,
            Hint = hint,
        };
    }
}

sealed class RuleRunResult
{
    public FindingAggregator Findings { get; } = new();
    public List<string> Errors { get; } = [];
    public int RuleCount { get; set; }
}

static class RuleEngine
{
    public static RuleRunResult Run(RuleContext context, Action<int, int, string> onRule)
    {
        var result = new RuleRunResult();
        var rules = RuleCatalog.All.Where(rule => context.Profile.RuleEnabled(rule.Id, rule.DefaultEnabled)).ToList();
        result.RuleCount = rules.Count;
        for (var index = 0; index < rules.Count; index += 1)
        {
            var rule = rules[index];
            onRule(index, rules.Count, rule.Title);
            try
            {
                foreach (var finding in Execute(context, rule)) result.Findings.Add(rule, finding);
            }
            catch (Exception exception)
            {
                // 单条规则出错不影响其余规则，错误随结果一并展示。
                result.Errors.Add($"规则「{rule.Title}」执行失败：{exception.Message}");
                Debug.WriteLine(exception);
            }
        }

        return result;
    }

    static IEnumerable<Finding> Execute(RuleContext context, RuleSpec rule)
    {
        if (rule.Whole is not null)
        {
            foreach (var finding in rule.Whole(context, rule)) yield return finding;
            yield break;
        }

        foreach (var record in rule.AllRegions ? context.Groups.All.Concat(OtherRegions(context)) : context.Groups.All)
        {
            if (!Applies(context, rule, record)) continue;
            if (rule.PerRun is not null)
            {
                foreach (var run in record.Runs)
                {
                    if (run.Text.Length == 0) continue;
                    foreach (var finding in rule.PerRun(context, rule, record, run)) yield return finding;
                }
            }
            else if (rule.PerParagraph is not null)
            {
                foreach (var finding in rule.PerParagraph(context, rule, record)) yield return finding;
            }
        }
    }

    /// <summary>正文以外、只由 <see cref="RuleSpec.AllRegions"/> 规则检查的段落。</summary>
    public static IEnumerable<ParaRecord> OtherRegions(RuleContext context)
    {
        return context.Groups.Cover
            .Concat(context.Groups.Toc)
            .Concat(context.Model.HeaderParagraphs)
            .Concat(context.Model.FooterParagraphs)
            .Concat(context.Model.NoteParagraphs)
            .Concat(context.Model.TextboxParagraphs);
    }

    public static bool Applies(RuleContext context, RuleSpec rule, ParaRecord record)
    {
        if (record.Container.InTable ? !rule.InTable : !rule.InBody) return false;
        if (rule.SkipEmpty && record.IsEmpty) return false;
        if (rule.SkipObjectOnly && record.ObjectOnly) return false;
        if (rule.Kinds == RuleKinds.BodyText && context.HeadingLevel(record) is not null) return false;
        return true;
    }
}
