using System.Text.RegularExpressions;
using System.Xml.Linq;
using Yibiao.OpenXmlHelper.BlindCheck.Model;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Rules;

/// <summary>
/// 结构与元数据：修订、批注、页眉页脚、页码、目录、文本框、超链接、域代码、文档属性、空段落。
/// 一个残留页码、一处未接受修订、一个带公司名的页眉，都是暗标的直接废标项。
/// </summary>
static class StructureRules
{
    static readonly HashSet<string> RevisionNames =
    [
        "ins", "del", "moveFrom", "moveTo", "pPrChange", "rPrChange", "tblPrChange", "tcPrChange",
        "trPrChange", "sectPrChange", "numberingChange", "tblGridChange", "cellIns", "cellDel", "cellMerge",
    ];

    public static readonly HashSet<string> SuspectFields =
    [
        "filename", "author", "company", "username", "useraddress", "userinitials", "docproperty",
        "info", "createdate", "savedate", "lastsavedby", "template",
    ];

    public static readonly HashSet<string> PageFields = ["page", "numpages", "sectionpages"];
    public static readonly HashSet<string> DefaultTemplates = new(StringComparer.OrdinalIgnoreCase) { "Normal.dotm", "Normal.dot", "Normal", "Normal.wpt", "normal.dotx" };
    public static readonly HashSet<string> BenignCustomProperties = new(StringComparer.OrdinalIgnoreCase) { "KSOProductBuildVer" };

    static readonly Regex PageNumberText = new(@"^\s*(第\s*\d+\s*页(\s*[,，]?\s*共\s*\d+\s*页)?|Page\s*\d+(\s*of\s*\d+)?)\s*$", RegexOptions.IgnoreCase);
    static readonly Regex PageNumberOnly = new(@"^[\s\d第页共/／\-—–_.,，|]*$|^\s*page\s*\d+(\s*of\s*\d+)?\s*$", RegexOptions.IgnoreCase);
    public static readonly Regex QuotedTarget = new("\"([^\"]+)\"");
    public static readonly string[] BorderSides = ["top", "left", "bottom", "right", "between", "bar"];

    public static IEnumerable<RuleSpec> All()
    {
        yield return new RuleSpec { Id = "struct.revision", Title = "未接受的修订", Category = "structure", Severity = Severity.High, Whole = CheckRevisions };
        yield return new RuleSpec { Id = "struct.comment", Title = "批注", Category = "structure", Severity = Severity.High, Whole = CheckComments };
        yield return new RuleSpec { Id = "struct.header_footer", Title = "页眉页脚内容", Category = "structure", Severity = Severity.High, Whole = CheckHeaderFooter };
        yield return new RuleSpec { Id = "struct.empty_paragraph", Title = "空段落", Category = "structure", Severity = Severity.Medium, Whole = CheckEmptyParagraphs };
        yield return new RuleSpec { Id = "struct.page_number_text", Title = "正文页码文字与缺少页码", Category = "structure", Severity = Severity.Medium, Whole = CheckPageNumberText };
        yield return new RuleSpec { Id = "struct.toc", Title = "目录", Category = "structure", Severity = Severity.Medium, Whole = CheckToc };
        yield return new RuleSpec { Id = "struct.heading_number", Title = "标题序号格式", Category = "structure", Severity = Severity.Medium, Whole = CheckHeadingNumberFormat };
        yield return new RuleSpec { Id = "struct.textbox", Title = "文本框", Category = "structure", Severity = Severity.Low, Whole = CheckTextbox };
        yield return new RuleSpec { Id = "struct.bookmark", Title = "命名书签", Category = "structure", Severity = Severity.Low, Whole = CheckBookmarks };
        yield return new RuleSpec { Id = "struct.hyperlink", Title = "超链接", Category = "privacy", Severity = Severity.High, Whole = CheckHyperlinks };
        yield return new RuleSpec { Id = "struct.field", Title = "域代码", Category = "privacy", Severity = Severity.High, Whole = CheckFields };
        yield return new RuleSpec { Id = "struct.doc_props", Title = "文档属性", Category = "privacy", Severity = Severity.High, Whole = CheckDocumentProperties };
    }

    static IEnumerable<Finding> CheckRevisions(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("structure.check_revisions", true)) yield break;
        foreach (var (part, document) in context.Model.Parts)
        {
            var counts = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var element in document.Descendants())
            {
                if (element.Name.Namespace != W.Ns || !RevisionNames.Contains(element.Name.LocalName)) continue;
                var label = element.Name.LocalName switch
                {
                    "ins" => "插入",
                    "del" => "删除",
                    "moveFrom" or "moveTo" => "移动",
                    _ => "格式修改",
                };
                counts[label] = counts.GetValueOrDefault(label) + 1;
            }

            if (counts.Count == 0) continue;
            var detail = string.Join("、", counts.Select(item => $"{item.Key} {item.Value} 处"));
            yield return context.Global(rule, "存在未接受的修订", context.PartLabel(part),
                $"{detail}。未接受的修订会暴露修改痕迹，评审时可能显示被删除的内容",
                "审阅 → 接受 → 接受所有修订，并关闭「修订」");
        }
    }

    static IEnumerable<Finding> CheckComments(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("structure.check_comments", true) || context.Model.CommentsPart is not { } part) yield break;
        var comments = context.Model.Parts[part].Root?.Elements(W.Comment).ToList() ?? [];
        if (comments.Count == 0) yield break;
        var authors = comments.Select(item => W.Attr(item, "author")).Where(item => !string.IsNullOrWhiteSpace(item)).Distinct().ToList();
        yield return context.Global(rule, "文档残留批注", "批注",
            $"共 {comments.Count} 条批注，批注作者：{(authors.Count > 0 ? string.Join("、", authors) : "未知")}。批注会暴露作者和单位信息",
            "审阅 → 删除 → 删除文档中的所有批注");
    }

    static IEnumerable<Finding> CheckHeaderFooter(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("structure.check_header_footer", true)) yield break;
        var pageMode = context.Profile.Text("structure.page_number");
        foreach (var part in context.Model.HeaderParts.Concat(context.Model.FooterParts))
        {
            var root = context.Model.Parts[part].Root;
            if (root is null) continue;
            var isHeader = context.Model.HeaderParts.Contains(part);
            var label = context.PartLabel(part);
            var place = isHeader ? "页眉" : "页脚";
            // 文本框的 DrawingML 主副本和 VML 回退副本各有一个页码域，只算一份。
            var pageFields = FieldScanner.Scan(root).Count(field => PageFields.Contains(field.Kind) && field.Begin?.Ancestors(W.McFallback).Any() != true);
            var pageAllowed = PageNumberAllowed(pageMode, isHeader);
            if (!pageAllowed && pageFields > 0)
            {
                yield return context.Global(rule, $"{place}中存在页码", label,
                    pageMode == "footer_only" ? $"发现 {pageFields} 处页码域，招标文件要求页码只出现在页脚" : $"发现 {pageFields} 处页码域，暗标通常要求不出现页码",
                    $"双击{place}区域，删除页码");
            }

            if (!ContentForbidden(context.Profile, pageMode, isHeader)) continue;
            var texts = HeaderFooterMarks(context.Model.Sheet, root, pageFields > 0);
            if (texts.Count == 0) continue;
            var content = RuleContext.Truncate(string.Join(" / ", texts.Take(4)), 80);
            yield return context.Global(rule, $"{place}存在内容", label,
                !isHeader && pageMode == "footer_only"
                    ? $"内容：{content}。招标文件要求页脚只出现页码"
                    : $"内容：{content}。页眉页脚常残留企业名称或标志，暗标要求清空",
                pageAllowed ? $"双击{place}，只保留页码，删除其他内容（含图片和横线）" : $"双击{place}，删除全部内容（含图片和横线）", content);
        }
    }

    /// <summary>页码要求（structure.page_number）：forbid 不得有页码；footer_only 页脚只准出现页码；null 不限。</summary>
    public static bool PageNumberAllowed(string? pageMode, bool isHeader)
    {
        return pageMode != "forbid" && !(pageMode == "footer_only" && isHeader);
    }

    /// <summary>页眉页脚是否不允许有页码以外的内容；"页脚只准出现页码"时页脚一律不允许。</summary>
    public static bool ContentForbidden(BlindCheckProfile profile, string? pageMode, bool isHeader)
    {
        return isHeader
            ? profile.Bool("structure.forbid_header_content", true)
            : profile.Bool("structure.forbid_footer_content", true) || pageMode == "footer_only";
    }

    /// <summary>页眉页脚里页码以外的文字和对象；有页码域时，只含页码的段落算页码，不算内容。</summary>
    public static List<string> HeaderFooterContent(XElement element, bool hasPageFields)
    {
        return HeaderFooterTexts(element).Where(text => !hasPageFields || !PageNumberOnly.IsMatch(text)).ToList();
    }

    /// <summary>
    /// 页眉页脚里页码以外的可见内容，检查和修复共用同一口径：文字和对象，加上可见的段落边框，记为"[横线]"
    /// （中文版 Word 的「页眉」样式自带下边框，文字删光后横线仍显示在每页顶部）。表格按其中的文字计入。
    /// </summary>
    public static List<string> HeaderFooterMarks(StyleSheet sheet, XElement root, bool hasPageFields)
    {
        var contents = HeaderFooterContent(root, hasPageFields);
        if (BorderedParagraphs(sheet, root).Any()) contents.Add("[横线]");
        return contents;
    }

    /// <summary>显示边框的段落；文本框里的段落随文本框计入内容，不单独看。</summary>
    public static IEnumerable<XElement> BorderedParagraphs(StyleSheet sheet, XElement element)
    {
        return element.DescendantsAndSelf(W.P)
            .Where(paragraph => !paragraph.Ancestors().Any(item => item.Name == W.TxbxContent || item.Name == W.VTxbxContent) && HasVisibleBorder(sheet, paragraph));
    }

    /// <summary>段落实际显示的边框：每一边先看直接设置，再沿段落样式链往上找，nil、none 算没有。</summary>
    static bool HasVisibleBorder(StyleSheet sheet, XElement paragraph)
    {
        var properties = paragraph.Element(W.PPr);
        var style = sheet.ResolveParagraphStyle(W.ValOf(properties?.Element(W.PStyle)));
        var layers = new[] { properties }.Concat(sheet.Chain(style, "paragraph").Select(item => item.PPr))
            .Select(item => item?.Element(W.Ns + "pBdr"))
            .OfType<XElement>()
            .ToList();
        return BorderSides.Any(side => layers.Select(layer => layer.Element(W.Ns + side)).FirstOrDefault(item => item is not null) is { } border
            && W.ValOf(border) is not (null or "nil" or "none"));
    }

    /// <summary>
    /// 页眉页脚各段显示的文字：文本框按框内文字计入（WPS 插入的页码就是一个只含页码域的文本框），
    /// 图片等其他对象记为"[图片]"；文本框里的段落随所在对象计入，不再单独列出。
    /// </summary>
    public static IEnumerable<string> HeaderFooterTexts(XElement element)
    {
        foreach (var paragraph in element.DescendantsAndSelf(W.P))
        {
            if (paragraph.Ancestors().Any(item => item.Name == W.TxbxContent || item.Name == W.VTxbxContent)) continue;
            var text = string.Concat(DocumentModel.RenderedRuns(paragraph).SelectMany(run => run.Elements()).Select(ObjectAwareText)).Trim();
            if (text.Length > 0) yield return text;
        }
    }

    static string ObjectAwareText(XElement child)
    {
        var text = DocumentModel.PieceText(child);
        if (text != DocumentModel.ObjectPlaceholder.ToString()) return text;
        return DocumentModel.TextboxContents(child).FirstOrDefault() is { } textbox
            ? string.Concat(textbox.Descendants(W.P).Select(DocumentModel.ParagraphText)).Trim()
            : "[图片]";
    }

    static IEnumerable<Finding> CheckEmptyParagraphs(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("structure.check_empty_paragraphs", true)) yield break;
        var model = context.Model;

        // 单元格必须至少有一个段落，唯一的空段落是结构必需的；全空且多于一个时才算多余。
        foreach (var cell in model.BodyElement.Descendants(W.Tc))
        {
            var paragraphs = cell.Elements(W.P).Select(item => model.Records.GetValueOrDefault(item)).Where(item => item is not null).Cast<ParaRecord>().ToList();
            if (paragraphs.Count < 2 || paragraphs.Any(item => !item.IsEmpty)) continue;
            foreach (var record in paragraphs.Skip(1))
            {
                yield return context.At(rule, record, "单元格内存在多余空段落",
                    $"该单元格有 {paragraphs.Count} 个空段落（需保留 1 个），多余的会造成额外空行", "删除多余空行，保留一个");
            }
        }

        // 表格之间必须隔一个段落、文末最后一个段落不能删，这两类空段落不报。
        var blocks = model.BodyBlocks;
        var required = new HashSet<XElement>(ReferenceEqualityComparer.Instance);
        for (var index = 0; index < blocks.Count; index += 1)
        {
            if (blocks[index].IsTable) continue;
            var previousTable = index > 0 && blocks[index - 1].IsTable;
            var nextTable = index + 1 < blocks.Count && blocks[index + 1].IsTable;
            if ((previousTable && nextTable) || index == blocks.Count - 1) required.Add(blocks[index].Element);
        }

        foreach (var record in context.Groups.Body)
        {
            if (!record.IsEmpty || record.HasSectionBreak || required.Contains(record.Element)) continue;
            if (record.HasPageBreak)
            {
                yield return context.At(rule, record, "存在含分页符的空段落",
                    "该空段落用分页符强制换页，会多占一行；要求每页固定行数时会不符",
                    "可删除本段，改为在下一段设置「段前分页」", severity: Severity.Low);
                continue;
            }

            // 直接删掉会让后文回到上一页，修复时不删，提示里写明换页要转到下一段。
            if (record.Format.PageBreakBefore)
            {
                yield return context.At(rule, record, "存在设置段前分页的空段落",
                    "该空段落靠「段前分页」让后文另起一页，会多占一行；要求每页固定行数时会不符",
                    "可删除本段，改为在下一段设置「段前分页」", severity: Severity.Low);
                continue;
            }

            yield return context.At(rule, record, "存在空段落",
                "空段落会造成多余空行，要求每页固定行数时会导致版面不符", "删除该空行");
        }
    }

    /// <summary>
    /// 页码只准出现在页脚或不得有页码时，正文里手写的"第 X 页"要报；
    /// "页脚只准出现页码"时页脚一个页码域都没有，给出低风险提示（不按节逐个报，目录节常常不编页码）。
    /// </summary>
    static IEnumerable<Finding> CheckPageNumberText(RuleContext context, RuleSpec rule)
    {
        var pageMode = context.Profile.Text("structure.page_number");
        if (pageMode is null) yield break;
        if (pageMode == "footer_only" && context.Profile.Bool("structure.check_header_footer", true)
            && !context.Model.FooterParts.Any(part => context.Model.Parts[part].Root is { } root && FieldScanner.Scan(root).Any(field => PageFields.Contains(field.Kind))))
        {
            yield return context.Global(rule, "页脚中没有页码", "页脚",
                "招标文件要求页脚出现页码，文档的页脚里没有页码域",
                "插入 → 页码 → 页面底端，按招标文件要求的格式插入页码", severity: Severity.Low);
        }

        foreach (var record in context.Groups.Body)
        {
            var text = record.Text.Trim();
            if (text.Length == 0 || !PageNumberText.IsMatch(text)) continue;
            yield return context.At(rule, record, "正文中出现页码文字", $"内容：{text}", "删除该行");
        }
    }

    static IEnumerable<Finding> CheckToc(RuleContext context, RuleSpec rule)
    {
        var mode = context.Profile.Text("structure.check_toc_present", "hint");
        if (mode == "ignore") yield break;
        var toc = context.Outline.Toc;
        // HasToc 只标记目录域和目录样式（同时决定能否用目录条目判定标题）；按点导引页码或手写识别出的目录只有条目，同样算有目录。
        var present = toc.HasToc || toc.Entries.Count > 0;
        if (present && mode == "forbid")
        {
            // 从未更新过的目录域不显示任何内容，但在 Word / WPS 中更新域后就会生成目录。
            var detail = toc.Entries.Count > 0
                ? $"共 {toc.Entries.Count} 条目录条目，部分招标文件要求暗标不得有目录"
                : "文档中有一个尚未更新的空目录域，当前不显示内容，但更新域（F9）后会生成目录";
            yield return context.Global(rule, toc.Entries.Count > 0 ? "文档包含目录" : "文档包含空的目录域", "目录",
                detail, "确认招标文件要求；如不允许，删除目录或目录域（可在 Alt+F9 显示域代码后删除）");
        }
        else if (!present && mode == "require")
        {
            yield return context.Global(rule, "未检测到目录", "全文", "招标文件要求提供目录时需补充",
                "引用 → 目录 → 自动目录", severity: Severity.Low);
        }

        if (toc.Entries.Count > 0 && !toc.HasField)
        {
            yield return context.Global(rule, "目录疑似手工录入", "目录",
                "手工目录不会随正文标题自动更新，容易与实际标题不一致",
                "建议用「引用 → 目录」自动生成", severity: Severity.Low);
        }
    }

    /// <summary>手写的阿拉伯数字分级序号："1、""1.1""1.1.1 "，组数就是级数；后面紧跟数字的（如"2026年"）不算。</summary>
    static readonly Regex ArabicNumber = new(@"^(\d{1,3})((?:[.．]\d{1,3})*)(?![\d.．]*\d)");

    /// <summary>手写的其他序号：第一章、一、（一）、①、A、Ⅰ 等。</summary>
    static readonly Regex OtherNumber = new(@"^(第\s*[一二三四五六七八九十百零〇\d]{1,4}\s*[章篇节部分条款]|[一二三四五六七八九十百零〇]{1,3}\s*[、.．]|[（(]\s*[一二三四五六七八九十百零〇\d]{1,3}\s*[)）]|[①-⑳]|[A-Za-z]\s*[、.．)）]|[IVXⅠ-Ⅻ]+\s*[、.．])");

    /// <summary>
    /// 一个标题的序号。Kind：auto 自动编号、arabic 手写阿拉伯数字、other 手写其他序号、none 没有序号；
    /// Prefix 是手写序号的原文，Depth 是阿拉伯数字编号的级数。
    /// </summary>
    public sealed record HeadingNumber(ParaRecord Record, int Level, bool Nominal, string Kind, string Prefix, int Depth, AutoNumber? Auto)
    {
        /// <summary>出现在第一个带序号的标题之前、本身没有序号的标题：文档总标题或分册名，不要求序号。</summary>
        public bool Title { get; init; }

        /// <summary>自动编号用到的不是阿拉伯数字的格式；全是阿拉伯数字时为 null。</summary>
        public string? OtherFormat => Auto?.Formats.Prepend(Auto.Format).FirstOrDefault(format => format is not ("decimal" or "decimalZero"));

        /// <summary>阿拉伯数字编号的级数与标题级别不符；按编号样式兜底识别的标题级别只是名义级别，不比较。</summary>
        public bool DepthMismatch => Kind is "auto" or "arabic" && OtherFormat is null && !Nominal && Depth != Level;
    }

    /// <summary>正文各标题的序号：自动编号看编号定义，手写编号看开头的序号。检查和修复共用。</summary>
    public static List<HeadingNumber> HeadingNumbers(RuleContext context, NumberingFormats numbering)
    {
        var result = new List<HeadingNumber>();
        foreach (var record in context.Groups.Body)
        {
            if (record.IsEmpty || context.HeadingLevel(record) is not { } level) continue;
            var nominal = context.Outline.SourceOf(record.Element) == "pattern";
            var text = record.Text.TrimStart(' ', '　', '\t');
            if (numbering.Of(record) is { } auto) result.Add(new HeadingNumber(record, level, nominal, "auto", "", Math.Max(1, auto.Depth), auto));
            else if (ArabicNumber.Match(text) is { Success: true } match) result.Add(new HeadingNumber(record, level, nominal, "arabic", match.Value, 1 + match.Groups[2].Value.Count(ch => ch is '.' or '．'), null));
            else if (OtherNumber.Match(text) is { Success: true } other) result.Add(new HeadingNumber(record, level, nominal, "other", other.Value, 0, null));
            else result.Add(new HeadingNumber(record, level, nominal, "none", "", 0, null));
        }

        var first = result.FindIndex(item => item.Kind != "none");
        for (var index = 0; index < first; index += 1) result[index] = result[index] with { Title = true };
        return result;
    }

    static string NumberExample(int level) => string.Join(".", Enumerable.Repeat("1", Math.Max(1, level)));

    static string FormatName(string format) => format switch
    {
        "decimal" or "decimalZero" => "阿拉伯数字",
        "chineseCounting" or "chineseCountingThousand" or "chineseLegalSimplified" or "ideographTraditional" or "ideographDigital" or "ideographLegalTraditional" => "中文数字",
        "upperRoman" or "lowerRoman" => "罗马数字",
        "upperLetter" or "lowerLetter" => "字母",
        _ when format.StartsWith("decimalEnclosed", StringComparison.Ordinal) => "带圈或括号数字",
        _ => format,
    };

    /// <summary>
    /// 招标文件要求标题序号用阿拉伯数字分级编排（一级 1、二级 1.1、三级 1.1.1）时检查：
    /// 自动编号看编号格式和编号文字的级数，手写编号看开头的序号；按编号样式兜底识别的标题级别只是名义级别，不比较级数。
    /// 第一个带序号的标题之前没有序号的标题是文档总标题，不报。
    /// </summary>
    static IEnumerable<Finding> CheckHeadingNumberFormat(RuleContext context, RuleSpec rule)
    {
        if (context.Profile.Text("structure.heading_numbering") != "arabic") yield break;
        const string Hint = "把标题序号改为阿拉伯数字分级编号（一级 1、二级 1.1、三级 1.1.1）；如果是招标文件规定的分册或章节名称，可保留";
        foreach (var heading in HeadingNumbers(context, NumberingFormats.Load(context.Model)))
        {
            var (record, level) = (heading.Record, heading.Level);
            if (heading.OtherFormat is { } other)
            {
                yield return context.At(rule, record, "标题序号不是阿拉伯数字", $"自动编号为{FormatName(other)}（编号格式「{heading.Auto!.Text}」），要求 {level} 级标题为「{NumberExample(level)}」", Hint);
            }
            else if (heading.Kind == "other")
            {
                yield return context.At(rule, record, "标题序号不是阿拉伯数字", $"当前序号「{heading.Prefix.Trim()}」，要求 {level} 级标题为「{NumberExample(level)}」", Hint);
            }
            else if (heading.Kind == "none" && !heading.Title)
            {
                yield return context.At(rule, record, "标题没有序号", $"招标文件要求标题按阿拉伯数字分级编号，{level} 级标题应为「{NumberExample(level)}」", Hint, severity: Severity.Low);
            }
            else if (heading.DepthMismatch)
            {
                var current = heading.Kind == "auto" ? $"自动编号「{heading.Auto!.Text}」" : heading.Prefix;
                yield return context.At(rule, record, "标题序号级数与标题级别不符", $"当前「{current}」是 {heading.Depth} 级编号，本标题为 {level} 级，应为「{NumberExample(level)}」", Hint);
            }
        }
    }

    static IEnumerable<Finding> CheckTextbox(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("structure.check_textbox", true)) yield break;
        var count = DocumentModel.TextboxContents(context.Model.BodyElement).Count();
        if (count == 0) yield break;
        yield return context.Global(rule, "文档中存在文本框", "正文",
            $"共 {count} 个文本框。文本框内容不受正文格式约束，常被用来放图注或说明，容易被判为格式不一致",
            "确认是否必要，必要时把文本框内容转为正文");
    }

    /// <summary>
    /// 用户手动插入的书签：名称里出现敏感词等身份信息报高风险，其余列出名称供人工确认。
    /// 以下划线开头的是 Word 自动生成的隐藏书签（_Toc、_GoBack、_Ref 等），不报。
    /// </summary>
    static IEnumerable<Finding> CheckBookmarks(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("structure.check_bookmarks", false)) yield break;
        var names = new List<string>();
        foreach (var bookmark in context.Model.BodyElement.Descendants(W.Ns + "bookmarkStart"))
        {
            var name = W.Attr(bookmark, "name");
            if (string.IsNullOrWhiteSpace(name) || name.StartsWith('_') || names.Contains(name)) continue;
            names.Add(name);
            var hits = PrivacyRules.IdentityHits(context, name);
            if (hits.Count == 0) continue;
            var paragraph = bookmark.AncestorsAndSelf(W.P).FirstOrDefault() ?? bookmark.ElementsAfterSelf(W.P).FirstOrDefault();
            var detail = $"书签「{name}」{hits[0].Message}，书签名称可在「插入 → 书签」中看到";
            const string Hint = "插入 → 书签，删除或重命名该书签";
            yield return paragraph is not null && context.Model.Records.TryGetValue(paragraph, out var record)
                ? context.At(rule, record, "书签名称含有身份信息", detail, Hint, severity: Severity.High)
                : context.Global(rule, "书签名称含有身份信息", "书签", detail, Hint, name, Severity.High);
        }

        if (names.Count == 0) yield break;
        yield return context.Global(rule, "文档含命名书签", "书签",
            $"共 {names.Count} 个：{RuleContext.Truncate(string.Join("、", names), 120)}。请确认书签名称没有单位或个人信息",
            "插入 → 书签，删除无关书签", RuleContext.Truncate(string.Join("、", names), 60));
    }

    static IEnumerable<Finding> CheckHyperlinks(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("structure.check_hyperlink", true)) yield break;
        foreach (var (part, document) in context.Model.Parts)
        {
            var root = document.Root;
            if (root is null) continue;
            var relationships = context.Model.Package.Relationships(part).ToDictionary(item => item.Id, StringComparer.Ordinal);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var link in root.Descendants(W.Hyperlink))
            {
                var id = link.Attribute(W.RId)?.Value;
                if (id is null || !seen.Add(id) || !relationships.TryGetValue(id, out var relationship)) continue;
                if (!relationship.External && !IsExternalTarget(relationship.Target)) continue;
                yield return HyperlinkFinding(context, rule, part, link, relationship.Target);
            }

            foreach (var field in FieldScanner.Scan(root).Where(item => item.Kind == "hyperlink"))
            {
                var target = QuotedTarget.Match(field.Instruction) is { Success: true } match ? match.Groups[1].Value : field.Instruction.Trim();
                if (!IsExternalTarget(target) || !seen.Add("field:" + target)) continue;
                yield return HyperlinkFinding(context, rule, part, field.Begin, target);
            }
        }
    }

    public static bool IsExternalTarget(string target)
    {
        return target.StartsWith("http", StringComparison.OrdinalIgnoreCase)
            || target.StartsWith("mailto", StringComparison.OrdinalIgnoreCase)
            || target.StartsWith("ftp", StringComparison.OrdinalIgnoreCase)
            || target.StartsWith("www.", StringComparison.OrdinalIgnoreCase);
    }

    static Finding HyperlinkFinding(RuleContext context, RuleSpec rule, string part, XElement? element, string target)
    {
        var paragraph = element?.AncestorsAndSelf(W.P).FirstOrDefault();
        var record = paragraph is null ? null : context.Model.Records.GetValueOrDefault(paragraph);
        var detail = $"链接目标：{RuleContext.Truncate(target, 120)}。超链接可能指向企业官网或邮箱，是身份泄露的典型途径";
        const string hint = "选中链接 → 右键 → 取消超链接";
        return record is null
            ? context.Global(rule, "存在外部超链接", context.PartLabel(part), detail, hint, RuleContext.Truncate(target, 60))
            : context.At(rule, record, "存在外部超链接", detail, hint);
    }

    static IEnumerable<Finding> CheckFields(RuleContext context, RuleSpec rule)
    {
        if (!context.Profile.Bool("structure.check_field_codes", true)) yield break;
        foreach (var (part, document) in context.Model.Parts)
        {
            if (document.Root is null) continue;
            var hits = FieldScanner.Scan(document.Root)
                .Where(field => SuspectFields.Contains(field.Kind))
                .GroupBy(field => field.Kind.ToUpperInvariant())
                .Select(group => $"{group.Key}（{group.Count()}）")
                .ToList();
            if (hits.Count == 0) continue;
            yield return context.Global(rule, "存在可能泄露身份的域代码", context.PartLabel(part),
                $"发现域：{string.Join("、", hits)}。这类域更新时会插入作者、文件名、公司等信息",
                "按 Alt+F9 显示域代码，删除这些域，或选中后按 Ctrl+Shift+F9 转为普通文字");
        }
    }

    static IEnumerable<Finding> CheckDocumentProperties(RuleContext context, RuleSpec rule)
    {
        var package = context.Model.Package;
        const string hint = "文件 → 信息 → 检查问题 → 检查文档，删除「文档属性和个人信息」";
        var core = package.TryLoad(package.RelatedPart("", "/core-properties", "docProps/core.xml") ?? "")?.Root;
        var app = package.TryLoad(package.RelatedPart("", "/extended-properties", "docProps/app.xml") ?? "")?.Root;
        var custom = package.TryLoad(package.RelatedPart("", "/custom-properties", "docProps/custom.xml") ?? "")?.Root;

        var checks = new (string Name, string Label, string Switch)[]
        {
            ("creator", "作者", "props.check_author"),
            ("lastModifiedBy", "最后修改者", "props.check_last_modified_by"),
        };
        foreach (var (name, label, toggle) in checks)
        {
            var value = LocalChild(core, name)?.Value.Trim();
            if (string.IsNullOrEmpty(value) || !context.Profile.Bool(toggle, true)) continue;
            yield return context.Global(rule, $"文档属性中残留「{label}」", "文档属性",
                $"{label}：{value}。文档属性随文件一起提交，评审方可直接读取", hint, value);
        }

        var company = LocalChild(app, "Company")?.Value.Trim();
        if (!string.IsNullOrEmpty(company) && context.Profile.Bool("props.check_company", true))
        {
            yield return context.Global(rule, "文档属性中残留「单位」", "文档属性", $"单位：{company}", hint, company);
        }

        var template = LocalChild(app, "Template")?.Value.Trim();
        if (!string.IsNullOrEmpty(template) && !DefaultTemplates.Contains(template) && context.Profile.Bool("props.check_template", true))
        {
            yield return context.Global(rule, "文档属性中残留模板名称", "文档属性",
                $"模板：{template}。模板名可能包含单位或项目名称", hint, template, Severity.Low);
        }

        if (custom is not null && context.Profile.Bool("props.check_custom_props", true))
        {
            var names = custom.Elements()
                .Select(item => item.Attribute("name")?.Value)
                .Where(item => !string.IsNullOrWhiteSpace(item) && !BenignCustomProperties.Contains(item!))
                .Cast<string>()
                .ToList();
            if (names.Count > 0)
            {
                yield return context.Global(rule, "文档含自定义属性", "文档属性",
                    $"共 {names.Count} 项：{RuleContext.Truncate(string.Join("、", names), 120)}。请确认其中没有单位或个人信息",
                    "文件 → 信息 → 属性 → 高级属性 → 自定义，删除无关属性", "", Severity.Low);
            }
        }
    }

    public static XElement? LocalChild(XElement? parent, string localName)
    {
        return parent?.Elements().FirstOrDefault(item => item.Name.LocalName == localName);
    }
}
