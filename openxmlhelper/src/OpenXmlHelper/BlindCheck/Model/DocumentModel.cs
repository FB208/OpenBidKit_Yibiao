using System.Text;
using System.Xml.Linq;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Model;

enum ContainerKind
{
    Body,
    Table,
    Header,
    Footer,
    Footnote,
    Endnote,
    Textbox,
}

enum TextKind
{
    Cjk,
    Latin,
    Other,
}

sealed class Container
{
    public ContainerKind Kind { get; init; }
    public string Part { get; init; } = "";
    public string? TableStyleId { get; init; }
    public int? TableIndex { get; init; }
    public int? Row { get; init; }
    public int? Column { get; init; }
    public bool InTable => Kind == ContainerKind.Table;
}

sealed class RunRecord
{
    public required XElement Element { get; init; }
    public required RunFormat Format { get; init; }
    public required string Text { get; init; }
    public TextKind Kind { get; init; }
}

sealed class ParaRecord
{
    public required XElement Element { get; init; }
    public required Container Container { get; init; }
    public required ParaFormat Format { get; init; }
    public required List<RunRecord> Runs { get; init; }
    public required string Text { get; init; }
    public bool IsEmpty { get; init; }
    /// <summary>只有图片/对象占位、没有可见文字的段落。</summary>
    public bool ObjectOnly { get; init; }
    public bool HasPageBreak { get; init; }
    public bool HasSectionBreak { get; init; }
    /// <summary>所在节的序号（从 0 开始）；页眉页脚等不属于正文流的段落为 0。</summary>
    public int SectionIndex { get; set; }
    /// <summary>正文顶层段落序号（从 1 开始，含目录和空段落）。</summary>
    public int? BodyIndex { get; set; }
    /// <summary>所在章节的最近一级标题文字，用于结果定位。</summary>
    public string? HeadingContext { get; set; }
}

sealed class SectionInfo
{
    public int Index { get; init; }
    public int? PageWidth { get; init; }
    public int? PageHeight { get; init; }
    public int? Top { get; init; }
    public int? Bottom { get; init; }
    public int? Left { get; init; }
    public int? Right { get; init; }
    public int Columns { get; init; } = 1;
    /// <summary>文档网格类型：lines / linesAndChars / snapToChars；未定义网格时为 null。</summary>
    public string? DocGridType { get; init; }
    public List<(string Type, string RelationshipId)> HeaderReferences { get; init; } = [];
    public List<(string Type, string RelationshipId)> FooterReferences { get; init; } = [];
}

sealed record BodyBlock(XElement Element, bool IsTable);

/// <summary>
/// 一份 docx 的可检查模型：每个段落带容器类别、生效格式和文本块；
/// 修订删除的内容不参与渲染文本，文本框内段落不混入所在段落。
/// </summary>
sealed class DocumentModel
{
    public const char ObjectPlaceholder = '\uFFFC';

    static readonly HashSet<XName> TransparentRunContainers =
    [
        W.Hyperlink, W.SmartTag, W.Sdt, W.SdtContent, W.Bdo, W.Dir, W.FldSimple, W.CustomXml,
    ];

    public required DocxPackage Package { get; init; }
    public required XElement BodyElement { get; init; }
    public required StyleSheet Sheet { get; init; }
    public required FormatResolver Resolver { get; init; }
    public Dictionary<string, XDocument> Parts { get; } = new(StringComparer.OrdinalIgnoreCase);
    public List<string> HeaderParts { get; } = [];
    public List<string> FooterParts { get; } = [];
    public string? FootnotesPart { get; set; }
    public string? EndnotesPart { get; set; }
    public string? CommentsPart { get; set; }
    public List<SectionInfo> Sections { get; } = [];
    public List<BodyBlock> BodyBlocks { get; } = [];
    public Dictionary<XElement, ParaRecord> Records { get; } = new(ReferenceEqualityComparer.Instance);
    public List<ParaRecord> BodyParagraphs { get; } = [];
    public List<ParaRecord> TableParagraphs { get; } = [];
    public List<ParaRecord> HeaderParagraphs { get; } = [];
    public List<ParaRecord> FooterParagraphs { get; } = [];
    public List<ParaRecord> NoteParagraphs { get; } = [];
    public List<ParaRecord> TextboxParagraphs { get; } = [];
    public int TableCount { get; private set; }

    /// <summary>
    /// 段落定位编号：正文 p{序号}；表格 t{表}.r{行}.c{列}，同一单元格多段时再加 .{第几段}；
    /// 页眉页脚 hdr{n}.{k} / ftr{n}.{k}；脚注尾注 fn.{k} / en.{k}；文本框 tb{k}。
    /// 同一份文件每次建模得到的编号相同，检查结果、标书结构导出和 Agent 编辑都按它定位。
    /// </summary>
    public Dictionary<XElement, string> Locators { get; } = new(ReferenceEqualityComparer.Instance);

    /// <summary>header/footer part -> 引用它的 (节序号, 类型)，用于结果定位。</summary>
    public Dictionary<string, (int Section, string Type)> HeaderFooterOwners { get; } = new(StringComparer.OrdinalIgnoreCase);

    public static DocumentModel Load(DocxPackage package)
    {
        var documentPart = package.DocumentPart;
        var document = package.Load(documentPart) ?? throw new InvalidOperationException("文档缺少正文部分（word/document.xml）");
        var body = document.Root?.Element(W.Body)
            ?? throw new InvalidOperationException("无法识别文档正文，可能是 Strict Open XML 格式，请在 Word 中另存为普通 .docx 后重试");

        var sheet = StyleSheet.Parse(package.TryLoad(package.RelatedPart(documentPart, "/styles", "word/styles.xml") ?? ""));
        var theme = ThemeInfo.Parse(package.TryLoad(package.RelatedPart(documentPart, "/theme", "word/theme/theme1.xml") ?? ""));
        var model = new DocumentModel
        {
            Package = package,
            BodyElement = body,
            Sheet = sheet,
            Resolver = new FormatResolver(sheet, theme),
        };
        model.Parts[documentPart] = document;

        foreach (var part in package.RelatedParts(documentPart, "/header").Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (package.TryLoad(part) is { } xml)
            {
                model.Parts[part] = xml;
                model.HeaderParts.Add(part);
            }
        }

        foreach (var part in package.RelatedParts(documentPart, "/footer").Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (package.TryLoad(part) is { } xml)
            {
                model.Parts[part] = xml;
                model.FooterParts.Add(part);
            }
        }

        model.FootnotesPart = model.LoadOptional(package.RelatedPart(documentPart, "/footnotes", "word/footnotes.xml"));
        model.EndnotesPart = model.LoadOptional(package.RelatedPart(documentPart, "/endnotes", "word/endnotes.xml"));
        model.CommentsPart = model.LoadOptional(package.RelatedPart(documentPart, "/comments", "word/comments.xml"));

        model.CollectSections(documentPart);
        model.CollectBodyBlocks(body, model.BodyBlocks);
        return model;
    }

    string? LoadOptional(string? part)
    {
        if (part is null || Package.TryLoad(part) is not { } xml) return null;
        Parts[part] = xml;
        return part;
    }

    public string DocumentPart => Package.DocumentPart;

    /// <summary>为全部段落建立格式记录；onProgress 收到 0~1 的进度。</summary>
    public void BuildRecords(Action<double> onProgress)
    {
        var total = Math.Max(1, BodyBlocks.Count);
        var bodyIndex = 0;
        // 带 sectPr 的段落是所在节的最后一段，之后的内容属于下一节。
        var sectionIndex = 0;
        for (var index = 0; index < BodyBlocks.Count; index += 1)
        {
            var block = BodyBlocks[index];
            if (block.IsTable)
            {
                TableCount += 1;
                foreach (var record in TableParagraphRecords(block.Element, TableCount))
                {
                    record.SectionIndex = sectionIndex;
                    TableParagraphs.Add(record);
                }
            }
            else
            {
                bodyIndex += 1;
                var record = CreateRecord(block.Element, new Container { Kind = ContainerKind.Body, Part = DocumentPart });
                record.BodyIndex = bodyIndex;
                record.SectionIndex = Math.Min(sectionIndex, Math.Max(0, Sections.Count - 1));
                BodyParagraphs.Add(record);
                if (record.HasSectionBreak) sectionIndex += 1;
            }

            if (index % 200 == 0) onProgress((double)index / total);
        }

        foreach (var part in HeaderParts)
        {
            AddPartParagraphs(part, ContainerKind.Header, HeaderParagraphs);
        }

        foreach (var part in FooterParts)
        {
            AddPartParagraphs(part, ContainerKind.Footer, FooterParagraphs);
        }

        if (FootnotesPart is not null) AddPartParagraphs(FootnotesPart, ContainerKind.Footnote, NoteParagraphs);
        if (EndnotesPart is not null) AddPartParagraphs(EndnotesPart, ContainerKind.Endnote, NoteParagraphs);

        foreach (var textbox in TextboxContents(BodyElement))
        {
            foreach (var paragraph in textbox.Descendants(W.P))
            {
                if (Records.ContainsKey(paragraph)) continue;
                TextboxParagraphs.Add(CreateRecord(paragraph, new Container { Kind = ContainerKind.Textbox, Part = DocumentPart }));
            }
        }

        BuildLocators();
        onProgress(1);
    }

    void BuildLocators()
    {
        foreach (var record in BodyParagraphs) Locators[record.Element] = $"p{record.BodyIndex}";
        foreach (var cell in TableParagraphs.GroupBy(record => (record.Container.TableIndex, record.Container.Row, record.Container.Column)))
        {
            var key = $"t{cell.Key.TableIndex}.r{(cell.Key.Row ?? 0) + 1}.c{(cell.Key.Column ?? 0) + 1}";
            var records = cell.ToList();
            for (var index = 0; index < records.Count; index += 1)
            {
                Locators[records[index].Element] = records.Count == 1 ? key : $"{key}.{index + 1}";
            }
        }

        void Numbered(IEnumerable<ParaRecord> records, Func<ParaRecord, string> prefix)
        {
            foreach (var group in records.GroupBy(prefix))
            {
                var index = 0;
                foreach (var record in group) Locators.TryAdd(record.Element, $"{group.Key}.{++index}");
            }
        }

        Numbered(HeaderParagraphs, record => $"hdr{HeaderParts.IndexOf(record.Container.Part) + 1}");
        Numbered(FooterParagraphs, record => $"ftr{FooterParts.IndexOf(record.Container.Part) + 1}");
        Numbered(NoteParagraphs, record => record.Container.Kind == ContainerKind.Footnote ? "fn" : "en");
        var textbox = 0;
        foreach (var record in TextboxParagraphs) Locators.TryAdd(record.Element, $"tb{++textbox}");
    }

    void AddPartParagraphs(string part, ContainerKind kind, List<ParaRecord> target)
    {
        var root = Parts[part].Root;
        if (root is null) return;
        foreach (var paragraph in root.Descendants(W.P))
        {
            target.Add(CreateRecord(paragraph, new Container { Kind = kind, Part = part }));
        }
    }

    /// <summary>文本框内容：VML 回退副本与 DrawingML 主副本只取一份，避免重复计数。</summary>
    public static IEnumerable<XElement> TextboxContents(XElement root)
    {
        return root.Descendants()
            .Where(element => element.Name == W.TxbxContent || element.Name == W.VTxbxContent)
            .Where(element => !element.Ancestors(W.McFallback).Any());
    }

    void CollectSections(string documentPart)
    {
        var relationships = Package.Relationships(documentPart).ToDictionary(item => item.Id, StringComparer.Ordinal);
        var sectionElements = BodyElement.Descendants(W.P)
            .Select(paragraph => paragraph.Element(W.PPr)?.Element(W.SectPr))
            .Where(item => item is not null)
            .Cast<XElement>()
            .ToList();
        if (BodyElement.Element(W.SectPr) is { } last) sectionElements.Add(last);

        for (var index = 0; index < sectionElements.Count; index += 1)
        {
            var element = sectionElements[index];
            var size = element.Element(W.PgSz);
            var margin = element.Element(W.PgMar);
            var section = new SectionInfo
            {
                Index = index,
                PageWidth = W.IntAttr(size, "w"),
                PageHeight = W.IntAttr(size, "h"),
                Top = W.IntAttr(margin, "top"),
                Bottom = W.IntAttr(margin, "bottom"),
                Left = W.IntAttr(margin, "left"),
                Right = W.IntAttr(margin, "right"),
                Columns = Math.Max(1, W.IntAttr(element.Element(W.Cols), "num") ?? 1),
                DocGridType = W.Attr(element.Element(W.Ns + "docGrid"), "type") is { } grid && grid != "default" ? grid : null,
                HeaderReferences = element.Elements(W.HeaderReference)
                    .Select(item => (W.Attr(item, "type") ?? "default", item.Attribute(W.RId)?.Value ?? ""))
                    .ToList(),
                FooterReferences = element.Elements(W.FooterReference)
                    .Select(item => (W.Attr(item, "type") ?? "default", item.Attribute(W.RId)?.Value ?? ""))
                    .ToList(),
            };
            Sections.Add(section);

            foreach (var (type, id) in section.HeaderReferences.Concat(section.FooterReferences))
            {
                if (!relationships.TryGetValue(id, out var relationship) || relationship.External) continue;
                var part = DocxPackage.ResolveTarget(documentPart, relationship.Target);
                HeaderFooterOwners.TryAdd(part, (index, type));
            }
        }
    }

    /// <summary>按文档顺序收集正文顶层段落与表格，穿过内容控件和自定义 XML 包装。</summary>
    void CollectBodyBlocks(XElement parent, List<BodyBlock> blocks)
    {
        foreach (var child in parent.Elements())
        {
            if (child.Name == W.P) blocks.Add(new BodyBlock(child, false));
            else if (child.Name == W.Tbl) blocks.Add(new BodyBlock(child, true));
            else if (child.Name == W.Sdt) CollectBodyBlocks(child.Element(W.SdtContent) ?? child, blocks);
            else if (child.Name == W.CustomXml || child.Name == W.SdtContent) CollectBodyBlocks(child, blocks);
        }
    }

    IEnumerable<ParaRecord> TableParagraphRecords(XElement table, int tableIndex)
    {
        var styleId = W.ValOf(table.Element(W.TblPr)?.Element(W.TblStyle));
        var row = 0;
        foreach (var tableRow in Unwrap(table, W.Tr))
        {
            var column = 0;
            foreach (var cell in Unwrap(tableRow, W.Tc))
            {
                var container = new Container
                {
                    Kind = ContainerKind.Table,
                    Part = DocumentPart,
                    TableStyleId = styleId,
                    TableIndex = tableIndex,
                    Row = row,
                    Column = column,
                };
                foreach (var record in CellParagraphRecords(cell, container, tableIndex))
                {
                    yield return record;
                }

                column += 1;
            }

            row += 1;
        }
    }

    IEnumerable<ParaRecord> CellParagraphRecords(XElement parent, Container container, int tableIndex)
    {
        foreach (var child in parent.Elements())
        {
            if (child.Name == W.P)
            {
                yield return CreateRecord(child, container);
            }
            else if (child.Name == W.Tbl)
            {
                foreach (var record in TableParagraphRecords(child, tableIndex)) yield return record;
            }
            else if (child.Name == W.Sdt || child.Name == W.SdtContent || child.Name == W.CustomXml)
            {
                foreach (var record in CellParagraphRecords(child.Name == W.Sdt ? child.Element(W.SdtContent) ?? child : child, container, tableIndex))
                {
                    yield return record;
                }
            }
        }
    }

    /// <summary>取 parent 下的 name 元素，穿过内容控件与自定义 XML 包装。</summary>
    static IEnumerable<XElement> Unwrap(XElement parent, XName name)
    {
        foreach (var child in parent.Elements())
        {
            if (child.Name == name) yield return child;
            else if (child.Name == W.Sdt || child.Name == W.SdtContent || child.Name == W.CustomXml)
            {
                foreach (var nested in Unwrap(child.Name == W.Sdt ? child.Element(W.SdtContent) ?? child : child, name)) yield return nested;
            }
        }
    }

    ParaRecord CreateRecord(XElement paragraph, Container container)
    {
        if (Records.TryGetValue(paragraph, out var cached)) return cached;
        var format = Resolver.ResolveParagraph(paragraph, container.TableStyleId);
        var runs = new List<RunRecord>();
        var text = new StringBuilder();
        var hasPageBreak = false;
        foreach (var run in RenderedRuns(paragraph))
        {
            var runText = RunText(run, ref hasPageBreak);
            var runFormat = Resolver.ResolveRun(run, format, container.TableStyleId);
            runs.Add(new RunRecord { Element = run, Format = runFormat, Text = runText, Kind = TextKinds.Dominant(runText) });
            text.Append(runText);
        }

        var firstSized = runs.FirstOrDefault(item => item.Text.Length > 0 && item.Format.SizePt is not null);
        if (firstSized is not null) format.CharUnitPt = firstSized.Format.SizePt!.Value;

        var value = text.ToString();
        var visible = value.Replace(ObjectPlaceholder.ToString(), "");
        var record = new ParaRecord
        {
            Element = paragraph,
            Container = container,
            Format = format,
            Runs = runs,
            Text = value,
            IsEmpty = string.IsNullOrWhiteSpace(value),
            ObjectOnly = string.IsNullOrWhiteSpace(visible) && value.Contains(ObjectPlaceholder),
            HasPageBreak = hasPageBreak,
            HasSectionBreak = paragraph.Element(W.PPr)?.Element(W.SectPr) is not null,
        };
        Records[paragraph] = record;
        return record;
    }

    /// <summary>
    /// 按文档顺序产出参与渲染的文本块：穿过超链接、内容控件、域等包装，
    /// 修订插入照常显示，修订删除不显示，段内文本框不属于本段。
    /// </summary>
    public static IEnumerable<XElement> RenderedRuns(XElement paragraph)
    {
        foreach (var child in paragraph.Elements())
        {
            if (child.Name == W.R_)
            {
                yield return child;
            }
            else if (child.Name == W.Ins || child.Name == W.MoveTo || TransparentRunContainers.Contains(child.Name))
            {
                foreach (var nested in RenderedRuns(child)) yield return nested;
            }
        }
    }

    /// <summary>不建格式记录、只取文本的快速路径，供目录识别遍历全部段落使用。</summary>
    public static string ParagraphText(XElement paragraph)
    {
        var builder = new StringBuilder();
        var ignored = false;
        foreach (var run in RenderedRuns(paragraph))
        {
            builder.Append(RunText(run, ref ignored));
        }

        return builder.ToString();
    }

    static string RunText(XElement run, ref bool hasPageBreak)
    {
        var builder = new StringBuilder();
        foreach (var child in run.Elements())
        {
            // 分页符、分栏符不是软回车，单独记录。
            if (child.Name == W.Br && W.Attr(child, "type") is "page" or "column") hasPageBreak = true;
            builder.Append(PieceText(child));
        }

        return builder.ToString();
    }

    /// <summary>文本块中单个子元素贡献的渲染文字；修复时按它把整段文字的位置对应回各个 w:t。</summary>
    public static string PieceText(XElement child)
    {
        var name = child.Name;
        if (name == W.T) return child.Value;
        if (name == W.Tab) return "\t";
        if (name == W.Br) return W.Attr(child, "type") is "page" or "column" ? "" : "\n";
        if (name == W.Cr) return "\n";
        if (name == W.NoBreakHyphen) return "-";
        if (name == W.Sym)
        {
            var code = W.Attr(child, "char");
            return code is not null && int.TryParse(code, System.Globalization.NumberStyles.HexNumber, null, out var value) && value is > 0 and <= 0xFFFF
                ? ((char)value).ToString()
                : "";
        }

        if (name == W.Drawing || name == W.Pict || name == W.Object) return ObjectPlaceholder.ToString();
        if (name.Namespace == W.Mc && name.LocalName == "AlternateContent") return ObjectPlaceholder.ToString();
        return "";
    }
}

static class TextKinds
{
    public static bool IsCjk(char value)
    {
        return value is >= '\u2E80' and <= '\u2EFF'
            or >= '\u3000' and <= '\u303F'
            or >= '\u3040' and <= '\u30FF'
            or >= '\u31C0' and <= '\u31EF'
            or >= '\u3200' and <= '\u4DBF'
            or >= '\u4E00' and <= '\u9FFF'
            or >= '\uF900' and <= '\uFAFF'
            or >= '\uFE30' and <= '\uFE4F'
            or >= '\uFF00' and <= '\uFFEF';
    }

    /// <summary>含中文字符（含全角标点）：这部分文字使用中文字体槽位。</summary>
    public static bool HasCjk(string text) => text.Any(IsCjk);

    /// <summary>含西文字母或数字：这部分文字使用西文字体槽位。</summary>
    public static bool HasLatin(string text) => text.Any(value => value is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9');

    /// <summary>判断文本主要由哪类字符构成，决定该用中文字体还是西文字体。</summary>
    public static TextKind Dominant(string text)
    {
        var cjk = 0;
        var latin = 0;
        foreach (var value in text)
        {
            if (IsCjk(value)) cjk += 1;
            else if (value is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9') latin += 1;
        }

        if (cjk > 0 && cjk >= latin) return TextKind.Cjk;
        return latin > 0 ? TextKind.Latin : TextKind.Other;
    }
}
