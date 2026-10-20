using System.Globalization;
using System.Text;
using System.Xml.Linq;
using Yibiao.OpenXmlHelper.BlindCheck.Model;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;
using Yibiao.OpenXmlHelper.BlindCheck.Rules;

namespace Yibiao.OpenXmlHelper.BlindCheck.Review;

/// <summary>标书里的一张图片或一个图形（按出现位置计，同一张图引用两次算两个）。</summary>
sealed class DumpImage
{
    public string Id { get; init; } = "";
    /// <summary>所在段落的定位编号。</summary>
    public string Locator { get; init; } = "";
    /// <summary>嵌入的图片 part（word/media/...）；文本框等纯图形为空。</summary>
    public string Part { get; init; } = "";
    public string Name { get; init; } = "";
    public string Description { get; init; } = "";
    public string Title { get; init; } = "";
    public double? WidthCm { get; init; }
    public double? HeightCm { get; init; }

    /// <summary>DrawingML 的 wp:docPr 或 VML 的 v:shape，编辑替代文字时用；不输出。</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public XElement? Element { get; init; }
    [System.Text.Json.Serialization.JsonIgnore]
    public string SourcePart { get; init; } = "";
}

sealed class DocumentDumpResult
{
    public string Text { get; init; } = "";
    public List<DumpImage> Images { get; init; } = [];
}

/// <summary>
/// 把标书按段落导出为一行一段的文本，供 AI 复核阅读、检索和定位：每行以段落编号开头，
/// 标出标题级别、目录、封面、分页分节和图片；另列分节页码设置、页眉页脚和图片清单。
/// 段内文字与渲染文字逐字对应，只把手动换行、制表符和图片占位换成单个可见符号，Agent 编辑按同样规则匹配。
/// </summary>
static class DocumentDump
{
    public const char LineBreakMark = '⏎';
    public const char TabMark = '⇥';
    public const char ObjectMark = '◇';

    static readonly XNamespace Wp = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
    static readonly XNamespace O = "urn:schemas-microsoft-com:office:office";
    const double EmuPerCm = 360000;
    const double TwipsPerCm = 566.929;

    /// <summary>段落的展示文字：与渲染文字等长，换行、制表符、对象占位各换成一个可见符号。</summary>
    public static string DisplayText(string rendered)
    {
        return rendered.Replace('\n', LineBreakMark).Replace('\t', TabMark).Replace(DocumentModel.ObjectPlaceholder, ObjectMark);
    }

    public static List<DumpImage> CollectImages(DocumentModel model)
    {
        var images = new List<DumpImage>();
        var parts = new List<string> { model.DocumentPart };
        parts.AddRange(model.HeaderParts);
        parts.AddRange(model.FooterParts);
        foreach (var part in parts)
        {
            if (!model.Parts.TryGetValue(part, out var document) || document.Root is null) continue;
            var targets = model.Package.Relationships(part)
                .Where(item => !item.External)
                .ToDictionary(item => item.Id, item => DocxPackage.ResolveTarget(part, item.Target), StringComparer.Ordinal);
            foreach (var element in document.Root.Descendants())
            {
                if (element.Ancestors(W.McFallback).Any()) continue;
                if (element.Name == Wp + "docPr")
                {
                    var holder = element.Parent;
                    // 文本框里的文字按段落导出，在所在段落注明"文本框：内容见…"，不当作图片。
                    if (holder?.Descendants(W.TxbxContent).Any() == true) continue;
                    var extent = holder?.Element(Wp + "extent");
                    var embed = holder?.Descendants(W.A + "blip").Select(item => item.Attribute(W.R + "embed")?.Value).FirstOrDefault(item => item is not null);
                    images.Add(new DumpImage
                    {
                        Id = $"img{images.Count + 1}",
                        Locator = LocatorOf(model, element),
                        Part = embed is not null && targets.TryGetValue(embed, out var target) ? target : "",
                        Name = element.Attribute("name")?.Value ?? "",
                        Description = element.Attribute("descr")?.Value ?? "",
                        Title = element.Attribute("title")?.Value ?? "",
                        WidthCm = Cm(extent?.Attribute("cx")?.Value, EmuPerCm),
                        HeightCm = Cm(extent?.Attribute("cy")?.Value, EmuPerCm),
                        Element = element,
                        SourcePart = part,
                    });
                }
                else if (element.Name == W.V + "shape" && element.Element(W.V + "imagedata") is { } data)
                {
                    var id = data.Attribute(W.R + "id")?.Value;
                    images.Add(new DumpImage
                    {
                        Id = $"img{images.Count + 1}",
                        Locator = LocatorOf(model, element),
                        Part = id is not null && targets.TryGetValue(id, out var target) ? target : "",
                        Name = element.Attribute("id")?.Value ?? "",
                        Description = element.Attribute("alt")?.Value ?? "",
                        Title = data.Attribute(O + "title")?.Value ?? "",
                        Element = element,
                        SourcePart = part,
                    });
                }
            }
        }

        return images;
    }

    static string LocatorOf(DocumentModel model, XElement element)
    {
        foreach (var paragraph in element.Ancestors(W.P))
        {
            if (model.Locators.TryGetValue(paragraph, out var locator)) return locator;
        }

        return "";
    }

    static double? Cm(string? value, double unit)
    {
        return long.TryParse(value, out var number) && number > 0 ? Math.Round(number / unit, 1) : null;
    }

    static string Number(double value) => value.ToString("0.##", CultureInfo.InvariantCulture);

    public static DocumentDumpResult Build(RuleContext context)
    {
        var model = context.Model;
        var images = CollectImages(model);
        var imagesByLocator = images.Where(item => item.Locator.Length > 0).GroupBy(item => item.Locator).ToDictionary(group => group.Key, group => group.Select(item => item.Id).ToList());
        var builder = new StringBuilder();
        builder.AppendLine("# 标书正文");
        builder.AppendLine($"说明：每行一段，方括号里是段落编号，引用位置和提交修改都用这个编号。段内 {LineBreakMark} 是手动换行，{TabMark} 是制表符，{ObjectMark} 是图片、图形或文本框（图片在行尾注明 img 编号，详见文末图片清单）。");
        builder.AppendLine("行内〔〕里都是程序加的标注，不是标书原文：〔标题N〕第 N 级标题，〔目录〕〔封面〕所在区域，〔空段〕没有文字的段落，〔域：…〕段内的域代码，〔文本框：内容见…〕本段里的文本框及其内容所在段落，〔文本框内〕该段位于文本框中，〔分页符〕〔分节符〕分页分节。");
        builder.AppendLine();

        AppendSections(builder, model);
        AppendHeaderFooter(builder, context, imagesByLocator);

        builder.AppendLine("## 正文");
        var tables = model.TableParagraphs.GroupBy(item => item.Container.TableIndex ?? 0).ToDictionary(group => group.Key, group => group.ToList());
        var tableIndex = 0;
        foreach (var block in model.BodyBlocks)
        {
            if (block.IsTable)
            {
                tableIndex += 1;
                if (!tables.TryGetValue(tableIndex, out var cells)) continue;
                var rows = cells.Max(item => item.Container.Row ?? 0) + 1;
                builder.AppendLine($"〔表格 {tableIndex} 开始，{rows} 行〕");
                foreach (var record in cells) AppendParagraph(builder, context, record, imagesByLocator);
                builder.AppendLine($"〔表格 {tableIndex} 结束〕");
                continue;
            }

            if (model.Records.TryGetValue(block.Element, out var paragraph)) AppendParagraph(builder, context, paragraph, imagesByLocator);
        }

        if (model.TextboxParagraphs.Count > 0)
        {
            builder.AppendLine();
            builder.AppendLine("## 正文中的文本框");
            foreach (var record in model.TextboxParagraphs.Where(item => !item.Element.Ancestors(W.McFallback).Any())) AppendParagraph(builder, context, record, imagesByLocator);
        }

        if (model.NoteParagraphs.Count > 0)
        {
            builder.AppendLine();
            builder.AppendLine("## 脚注和尾注");
            foreach (var record in model.NoteParagraphs.Where(item => !item.IsEmpty)) AppendParagraph(builder, context, record, imagesByLocator);
        }

        builder.AppendLine();
        builder.AppendLine("## 图片和图形");
        if (images.Count == 0) builder.AppendLine("（无）");
        foreach (var image in images)
        {
            var size = image.WidthCm is { } width && image.HeightCm is { } height ? $"；显示尺寸 {Number(width)}×{Number(height)} 厘米" : "";
            var source = image.Part.Length > 0 ? $"嵌入图片 {image.Part}" : "图形或文本框（不是图片文件）";
            builder.AppendLine($"[{image.Id}] 位于 {(image.Locator.Length > 0 ? image.Locator : "非段落位置")}；{source}{size}；名称「{image.Name}」；替代文字「{image.Description}」{(image.Title.Length > 0 ? $"；标题「{image.Title}」" : "")}");
        }

        // 统一用 \n 换行，Agent 按行检索、Main 按行拆分时不受系统换行符影响。
        return new DocumentDumpResult { Text = builder.ToString().Replace("\r\n", "\n"), Images = images };
    }

    static void AppendSections(StringBuilder builder, DocumentModel model)
    {
        builder.AppendLine("## 分节与页码");
        var sectionElements = model.BodyElement.Descendants(W.P)
            .Select(paragraph => paragraph.Element(W.PPr)?.Element(W.SectPr))
            .Where(item => item is not null)
            .Cast<XElement>()
            .ToList();
        if (model.BodyElement.Element(W.SectPr) is { } last) sectionElements.Add(last);
        var footerIds = model.FooterParts.Select((part, index) => (part, id: $"ftr{index + 1}")).ToDictionary(item => item.part, item => item.id, StringComparer.OrdinalIgnoreCase);
        var headerIds = model.HeaderParts.Select((part, index) => (part, id: $"hdr{index + 1}")).ToDictionary(item => item.part, item => item.id, StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < model.Sections.Count; index += 1)
        {
            var section = model.Sections[index];
            var element = index < sectionElements.Count ? sectionElements[index] : null;
            var paragraphs = model.BodyParagraphs.Where(item => item.SectionIndex == index).ToList();
            var range = paragraphs.Count > 0 ? $"p{paragraphs[0].BodyIndex}–p{paragraphs[^1].BodyIndex}" : "无段落";
            var paper = section.PageWidth is { } width && section.PageHeight is { } height
                ? $"纸张 {Number(Math.Round(width / TwipsPerCm, 1))}×{Number(Math.Round(height / TwipsPerCm, 1))} 厘米{(width > height ? "（横向）" : "")}"
                : "纸张未设置";
            var margins = $"页边距 上 {Margin(section.Top)} 下 {Margin(section.Bottom)} 左 {Margin(section.Left)} 右 {Margin(section.Right)} 厘米";
            var pageNumber = element?.Element(W.Ns + "pgNumType");
            var start = W.Attr(pageNumber, "start");
            var format = W.Attr(pageNumber, "fmt");
            var numbering = start is not null ? $"页码从 {start} 开始" : index == 0 ? "页码从 1 开始（默认）" : "页码接续前一节";
            if (format is not null && format != "decimal") numbering += $"，格式 {format}";
            var owners = model.HeaderFooterOwners.Where(item => item.Value.Section == index).ToList();
            string References(Dictionary<string, string> ids, string label)
            {
                var found = owners.Where(item => ids.ContainsKey(item.Key)).Select(item => $"{ids[item.Key]}{TypeLabel(item.Value.Type)}").ToList();
                return found.Count > 0 ? $"{label} {string.Join("、", found)}" : index == 0 ? $"无{label}" : $"{label}沿用前一节";
            }

            var titlePage = element?.Element(W.Ns + "titlePg") is { } title && W.Attr(title, "val") is null or "1" or "true" or "on" ? "；首页不同" : "";
            var headers = References(headerIds, "页眉");
            var footers = References(footerIds, "页脚");
            if (index == 0 && owners.Count == 0) numbering = "本节没有页眉页脚，不显示页码";
            builder.AppendLine($"第 {index + 1} 节（{range}）：{paper}；{margins}；分栏 {section.Columns}；{headers}；{footers}；{numbering}{titlePage}");
        }

        builder.AppendLine();
    }

    static string Margin(int? twips) => twips is { } value ? Number(Math.Round(value / TwipsPerCm, 2)) : "未设置";

    static string TypeLabel(string type) => type switch
    {
        "first" => "（首页）",
        "even" => "（偶数页）",
        _ => "",
    };

    static void AppendHeaderFooter(StringBuilder builder, RuleContext context, Dictionary<string, List<string>> imagesByLocator)
    {
        var model = context.Model;
        builder.AppendLine("## 页眉页脚");
        var parts = model.HeaderParts.Select((part, index) => (part, id: $"hdr{index + 1}", label: "页眉"))
            .Concat(model.FooterParts.Select((part, index) => (part, id: $"ftr{index + 1}", label: "页脚")))
            .ToList();
        if (parts.Count == 0) builder.AppendLine("（无）");
        foreach (var (part, id, label) in parts)
        {
            var records = model.HeaderParagraphs.Concat(model.FooterParagraphs)
                .Where(item => item.Container.Part == part && !item.Element.Ancestors(W.McFallback).Any())
                .ToList();
            builder.AppendLine($"程序判断：{label} {id}{DescribeHeaderFooter(model, part, records, imagesByLocator)}");
            foreach (var record in records) AppendParagraph(builder, context, record, imagesByLocator);
        }

        builder.AppendLine();
    }

    static readonly System.Text.RegularExpressions.Regex PageNumberLike = new(@"^[\s\d第页共/／\-—–_.,，|]*$");

    /// <summary>
    /// 页眉页脚内容的程序判断：空白、只有页码（有 PAGE 域且文字只是页码）、或有页码以外的内容；
    /// 页码放在文本框里、文本框或段落居中时一并写明，Agent 不必再从行内标注推断。
    /// </summary>
    static string DescribeHeaderFooter(DocumentModel model, string part, List<ParaRecord> records, Dictionary<string, List<string>> imagesByLocator)
    {
        var texts = records.Where(item => item.Element.Ancestors(W.TxbxContent).Any() || !item.Element.Descendants(W.TxbxContent).Any())
            .Select(item => item.Text.Replace(DocumentModel.ObjectPlaceholder.ToString(), "").Trim())
            .Where(item => item.Length > 0)
            .ToList();
        var root = model.Parts.GetValueOrDefault(part)?.Root;
        var fields = root is null ? [] : root.Descendants(W.InstrText).Select(item => item.Value).Concat(root.Descendants(W.FldSimple).Select(item => W.Attr(item, "instr") ?? ""))
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Select(item => item.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries)[0].ToUpperInvariant())
            .Distinct()
            .ToList();
        var pictures = records.Sum(item => model.Locators.TryGetValue(item.Element, out var locator) && imagesByLocator.TryGetValue(locator, out var ids) ? ids.Count : 0);
        var inTextbox = records.Any(item => item.Element.Ancestors(W.TxbxContent).Any() && item.Text.Trim().Length > 0);
        var centered = root?.Descendants(Wp + "positionH").Any(item => item.Element(Wp + "align")?.Value == "center") == true
            || records.Any(item => item.Text.Trim().Length > 0 && item.Format.Alignment == "center");
        var picturesText = pictures > 0 ? $"，另有图片 {pictures} 张" : "";
        if (texts.Count == 0 && fields.Count == 0) return pictures > 0 ? $"：没有文字，有图片 {pictures} 张" : "：空白";
        if (fields.Contains("PAGE") && texts.All(item => PageNumberLike.IsMatch(item)))
        {
            var details = new List<string> { $"{string.Join("、", fields)} 域" };
            if (inTextbox) details.Add("在文本框中");
            if (centered) details.Add("水平居中");
            return $"：只有页码（{string.Join("，", details)}）{picturesText}";
        }

        var sample = string.Join(" / ", texts.Take(3));
        return $"：有页码以外的内容「{(sample.Length > 60 ? sample[..60] + "…" : sample)}」{(fields.Count > 0 ? $"，含 {string.Join("、", fields)} 域" : "")}{picturesText}";
    }

    static void AppendParagraph(StringBuilder builder, RuleContext context, ParaRecord record, Dictionary<string, List<string>> imagesByLocator)
    {
        var model = context.Model;
        if (!model.Locators.TryGetValue(record.Element, out var locator)) return;
        var marks = new StringBuilder();
        if (record.Element.Ancestors(W.TxbxContent).Any()) marks.Append("〔文本框内〕");
        if (context.Groups.CoverElements.Contains(record.Element)) marks.Append("〔封面〕");
        if (context.Outline.IsToc(record.Element)) marks.Append("〔目录〕");
        if (record.Container.Kind == ContainerKind.Body && context.Outline.LevelOf(record.Element) is { } level) marks.Append($"〔标题{level}〕");
        if (record.Format.PageBreakBefore) marks.Append("〔段前分页〕");
        var text = DisplayText(record.Text);
        var tail = new StringBuilder();
        // 只标本段自己的域，文本框里的域标在文本框内的段落上。
        bool Own(XElement item) => item.Ancestors(W.P).FirstOrDefault() == record.Element;
        var fields = record.Element.Descendants(W.InstrText).Where(Own).Select(item => item.Value.Trim()).Where(item => item.Length > 0)
            .Concat(record.Element.Descendants(W.FldSimple).Where(Own).Select(item => (W.Attr(item, "instr") ?? "").Trim()))
            .Where(item => item.Length > 0)
            .Select(item => item.Split(' ', StringSplitOptions.RemoveEmptyEntries)[0])
            .Distinct()
            .ToList();
        if (fields.Count > 0) tail.Append($" 〔域：{string.Join("、", fields)}〕");
        if (imagesByLocator.TryGetValue(locator, out var images)) tail.Append($" 〔{string.Join("、", images)}〕");
        var textboxes = record.Element.Descendants(W.TxbxContent)
            .Where(item => !item.Ancestors(W.McFallback).Any() && item.Ancestors(W.P).FirstOrDefault() == record.Element)
            .SelectMany(item => item.Descendants(W.P))
            .Select(item => model.Locators.GetValueOrDefault(item))
            .Where(item => !string.IsNullOrEmpty(item))
            .ToList();
        if (textboxes.Count > 0) tail.Append($" 〔文本框：内容见 {string.Join("、", textboxes)}〕");
        if (record.HasPageBreak) tail.Append(" 〔分页符〕");
        if (record.HasSectionBreak) tail.Append(" 〔分节符〕");
        if (record.IsEmpty && !record.ObjectOnly && text.Trim().Length == 0) text = "〔空段〕";
        builder.Append('[').Append(locator).Append("] ").Append(marks).Append(text).Append(tail).AppendLine();
    }
}
