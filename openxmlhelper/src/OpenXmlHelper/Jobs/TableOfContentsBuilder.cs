using System.Globalization;
using System.Text;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>目录的一个条目：指向标题书签、目录级别（1 起）、条目文字，以及标题是否排在目录之后。</summary>
sealed record TocEntry(string Bookmark, int Level, string Text, bool AfterToc);

/// <summary>整本导出生成的目录；块号口径同抽章，StartBlock 为目录页起始块（含），EndBlock 为目录块之后（不含）。</summary>
sealed record TocResult(IReadOnlyList<TocEntry> Entries, int StartBlock, int EndBlock);

/// <summary>目录条目的字体、字号、行距和每级缩进，由渲染器按目录所在样式范围算好后传入。</summary>
sealed record TocStyleSpec(string Font, int HalfPoints, Wp.SpacingBetweenLines Spacing, int IndentPerLevelTwips);

/// <summary>
/// 整本导出的 Word 原生目录：目录生成小节的正文标记换成目录库内容控件，内含 TOC 域，
/// 条目按 Word 的 \o \u 口径收集有效大纲级别 0-8 的段落，链接到标题书签，页码为 PAGEREF 域。
/// 页码先写等宽占位，由 Main 测量版式后经 fill-toc-page-numbers 回填。
/// </summary>
static class TableOfContentsBuilder
{
    /// <summary>Main 写在目录生成小节正文中的标记段落。</summary>
    public const string Marker = "YIBIAOTOC";
    public const string Tag = "yibiao:toc";
    public const string TitleStyleId = "TOCHeading";

    // 页码回填只会变窄，不会新增换行；四位足够覆盖常见篇幅。
    const string Placeholder = "0000";
    const int FirstBookmarkNumber = 100000001;
    // 避开格式自检书签（从 0 起）和商务模版书签（+1,000,000 偏移）。
    const int FirstBookmarkId = 2_000_000;

    public static bool IsToc(Wp.SdtBlock sdt) =>
        sdt.SdtProperties?.GetFirstChild<Wp.Tag>()?.Val?.Value == Tag;

    /// <summary>把正文中的目录标记段落换成目录库内容控件，内容先放一个空段落；没有标记时返回 null。</summary>
    public static Wp.SdtBlock? ReplaceMarker(Wp.Body body)
    {
        var markers = body.Elements<Wp.Paragraph>().Where(paragraph => paragraph.InnerText.Trim() == Marker).ToList();
        if (markers.Count == 0) return null;
        if (markers.Count > 1) throw new InvalidOperationException("整本导出只能生成一个目录");
        // sdtPr 子元素按 schema 顺序构造：alias、tag、id、docPartObj。
        var sdt = new Wp.SdtBlock(
            new Wp.SdtProperties(
                new Wp.SdtAlias { Val = "目录" },
                new Wp.Tag { Val = Tag },
                new Wp.SdtId { Val = Random.Shared.Next(1, int.MaxValue) },
                new Wp.SdtContentDocPartObject(
                    new Wp.DocPartGallery { Val = "Table of Contents" },
                    new Wp.DocPartUnique())),
            new Wp.SdtContentBlock(new Wp.Paragraph()));
        markers[0].InsertBeforeSelf(sdt);
        markers[0].Remove();
        return sdt;
    }

    /// <summary>
    /// 写目录样式，把目录标题改为“TOC Heading”使其不进入目录，给大纲段落加书签并生成目录域。
    /// 须在整本合成、分栏和页框处理之后调用。
    /// </summary>
    public static TocResult Build(MainDocumentPart mainPart, Wp.Body body, Wp.SdtBlock sdt, Wp.Paragraph title, int titleLevel, Wp.Paragraph startBlock, TocStyleSpec spec)
    {
        AddStyles(mainPart, titleLevel, spec, TabPositionTwips(body, sdt));
        var titleProperties = title.ParagraphProperties ??= new Wp.ParagraphProperties();
        titleProperties.ParagraphStyleId = new Wp.ParagraphStyleId { Val = TitleStyleId };
        titleProperties.OutlineLevel = new Wp.OutlineLevel { Val = 9 };

        var entries = CollectEntries(mainPart, body, sdt);
        var content = sdt.SdtContentBlock ?? sdt.AppendChild(new Wp.SdtContentBlock());
        content.RemoveAllChildren();
        if (entries.Count == 0)
        {
            content.AppendChild(new Wp.Paragraph(
                new Wp.ParagraphProperties(new Wp.ParagraphStyleId { Val = "TOC1" }),
                FieldChar(Wp.FieldCharValues.Begin),
                FieldCode(" TOC \\o \"1-9\" \\h \\z \\u "),
                FieldChar(Wp.FieldCharValues.Separate),
                TextRun("未找到目录项"),
                FieldChar(Wp.FieldCharValues.End)));
        }
        for (var index = 0; index < entries.Count; index += 1)
        {
            content.AppendChild(CreateEntry(entries[index], first: index == 0, last: index == entries.Count - 1));
        }

        var errors = new OpenXmlValidator(FileFormatVersions.Microsoft365).Validate(sdt).Take(10).ToList();
        if (errors.Count > 0) throw new InvalidOperationException($"目录 Open XML 校验失败：{string.Join("；", errors.Select(item => item.Description))}");

        var blocks = body.ChildElements.Where(item => item is not Wp.SectionProperties).ToList();
        return new TocResult(entries, blocks.IndexOf(startBlock), blocks.IndexOf(sdt) + 1);
    }

    /// <summary>按书签回填 PAGEREF 缓存页码；映射中没有或为空的写空，返回缺失条数。</summary>
    public static int FillPageNumbers(Wp.SdtBlock sdt, IReadOnlyDictionary<string, string> pageNumbers)
    {
        var missing = 0;
        foreach (var link in sdt.Descendants<Wp.Hyperlink>())
        {
            var bookmark = link.Anchor?.Value ?? "";
            var value = pageNumbers.TryGetValue(bookmark, out var found) ? (found ?? "").Trim() : "";
            if (value.Length == 0) missing += 1;
            // 条目结构：文字、制表符、PAGEREF begin / instr / separate / 结果 / end。
            var inPageRef = false;
            var inResult = false;
            var written = false;
            foreach (var run in link.Elements<Wp.Run>())
            {
                var fieldChar = run.GetFirstChild<Wp.FieldChar>()?.FieldCharType?.Value;
                if (fieldChar == Wp.FieldCharValues.Begin) inPageRef = false;
                else if (fieldChar == Wp.FieldCharValues.Separate) inResult = inPageRef;
                else if (fieldChar == Wp.FieldCharValues.End) inResult = false;
                else if (run.GetFirstChild<Wp.FieldCode>()?.Text.Contains("PAGEREF", StringComparison.Ordinal) == true) inPageRef = true;
                else if (inResult)
                {
                    foreach (var text in run.Elements<Wp.Text>().ToList())
                    {
                        if (written) text.Remove();
                        else text.Text = value;
                        written = true;
                    }
                }
            }
        }
        return missing;
    }

    /// <summary>
    /// 截出只含目录页的小文档，供 Main 复测目录占几页：保留起止范围内的块和其中的分节，
    /// 末尾分节换成目录所在节，起始块不分页，删掉正文不再引用的图片。
    /// </summary>
    public static void WriteTocOnly(string sourcePath, string outputPath, int startBlock, int endBlock)
    {
        using var stream = new MemoryStream();
        using (var source = File.OpenRead(sourcePath)) source.CopyTo(stream);
        using (var document = WordprocessingDocument.Open(stream, true))
        {
            var mainPart = document.MainDocumentPart ?? throw new InvalidOperationException("Word 缺少正文部件");
            var body = mainPart.Document?.Body ?? throw new InvalidOperationException("Word 缺少正文");
            var blocks = body.ChildElements.Where(item => item is not Wp.SectionProperties).ToList();
            if (startBlock < 0 || endBlock > blocks.Count || startBlock >= endBlock) throw new InvalidOperationException("目录范围无效");
            var section = blocks.Skip(endBlock).OfType<Wp.Paragraph>()
                .Select(paragraph => paragraph.ParagraphProperties?.SectionProperties)
                .FirstOrDefault(item => item is not null)
                ?? body.Elements<Wp.SectionProperties>().Last();
            var finalSection = (Wp.SectionProperties)section.CloneNode(true);
            for (var index = 0; index < blocks.Count; index += 1)
            {
                if (index < startBlock || index >= endBlock) blocks[index].Remove();
            }
            body.RemoveAllChildren<Wp.SectionProperties>();
            body.AppendChild(finalSection);
            if (blocks[startBlock] is Wp.Paragraph first)
            {
                (first.ParagraphProperties ??= new Wp.ParagraphProperties()).PageBreakBefore = new Wp.PageBreakBefore { Val = false };
            }

            const string relationshipNamespace = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
            var referenced = body.Descendants()
                .SelectMany(element => element.GetAttributes())
                .Where(attribute => attribute.NamespaceUri == relationshipNamespace)
                .Select(attribute => attribute.Value)
                .ToHashSet(StringComparer.Ordinal);
            foreach (var image in mainPart.ImageParts.ToList())
            {
                if (!referenced.Contains(mainPart.GetIdOfPart(image))) mainPart.DeletePart(image);
            }
            mainPart.Document!.Save();
        }
        File.WriteAllBytes(outputPath, stream.ToArray());
    }

    /// <summary>目录 1-9 级与目录标题样式；同 ID 已存在时替换。目录标题继承同级标题样式，只取消大纲级别。</summary>
    static void AddStyles(MainDocumentPart mainPart, int titleLevel, TocStyleSpec spec, int tabPosition)
    {
        var styles = mainPart.StyleDefinitionsPart?.Styles ?? throw new InvalidOperationException("Word 缺少样式部件");
        var ids = Enumerable.Range(1, 9).Select(level => $"TOC{level}").Append(TitleStyleId).ToHashSet(StringComparer.Ordinal);
        foreach (var style in styles.Elements<Wp.Style>().Where(item => ids.Contains(item.StyleId?.Value ?? "")).ToList()) style.Remove();

        var halfPoints = spec.HalfPoints.ToString(CultureInfo.InvariantCulture);
        for (var level = 1; level <= 9; level += 1)
        {
            var spacing = (Wp.SpacingBetweenLines)spec.Spacing.CloneNode(true);
            styles.AppendChild(new Wp.Style(
                new Wp.StyleName { Val = $"toc {level}" },
                new Wp.BasedOn { Val = "Normal" },
                new Wp.NextParagraphStyle { Val = "Normal" },
                new Wp.UIPriority { Val = 39 },
                new Wp.UnhideWhenUsed(),
                new Wp.StyleParagraphProperties(
                    new Wp.Tabs(new Wp.TabStop
                    {
                        Val = Wp.TabStopValues.Right,
                        Leader = Wp.TabStopLeaderCharValues.Dot,
                        Position = tabPosition,
                    }),
                    spacing,
                    new Wp.Indentation { Left = (spec.IndentPerLevelTwips * (level - 1)).ToString(CultureInfo.InvariantCulture) }),
                new Wp.StyleRunProperties(
                    new Wp.RunFonts { Ascii = spec.Font, HighAnsi = spec.Font, EastAsia = spec.Font, ComplexScript = spec.Font },
                    new Wp.FontSize { Val = halfPoints },
                    new Wp.FontSizeComplexScript { Val = halfPoints }))
            {
                Type = Wp.StyleValues.Paragraph,
                StyleId = $"TOC{level}",
            });
        }
        styles.AppendChild(new Wp.Style(
            new Wp.StyleName { Val = "TOC Heading" },
            new Wp.BasedOn { Val = titleLevel is >= 1 and <= 6 ? $"Heading{titleLevel}" : "Normal" },
            new Wp.NextParagraphStyle { Val = "Normal" },
            new Wp.UIPriority { Val = 39 },
            new Wp.UnhideWhenUsed(),
            new Wp.StyleParagraphProperties(new Wp.OutlineLevel { Val = 9 }))
        {
            Type = Wp.StyleValues.Paragraph,
            StyleId = TitleStyleId,
        });
        styles.Save();
    }

    /// <summary>右对齐页码的制表位：目录所在节的正文宽度，分栏时取单栏宽度。</summary>
    static int TabPositionTwips(Wp.Body body, Wp.SdtBlock sdt)
    {
        var section = sdt.ElementsAfter().OfType<Wp.Paragraph>()
            .Select(paragraph => paragraph.ParagraphProperties?.SectionProperties)
            .FirstOrDefault(item => item is not null)
            ?? body.Elements<Wp.SectionProperties>().LastOrDefault();
        var size = section?.GetFirstChild<Wp.PageSize>();
        var margin = section?.GetFirstChild<Wp.PageMargin>();
        var width = (int)(size?.Width?.Value ?? 11906U)
            - (int)(margin?.Left?.Value ?? 1134U)
            - (int)(margin?.Right?.Value ?? 1134U)
            - (int)(margin?.Gutter?.Value ?? 0U);
        var columns = section?.GetFirstChild<Wp.Columns>();
        var count = columns?.ColumnCount?.Value ?? 1;
        if (count >= 2)
        {
            var space = int.TryParse(columns?.Space?.Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : 720;
            width = (width - space * (count - 1)) / count;
        }
        return Math.Max(1, width);
    }

    /// <summary>按文档顺序收集有效大纲级别 0-8 的段落（含表格内，不含文本框和目录自身），并加上目录书签。</summary>
    static List<TocEntry> CollectEntries(MainDocumentPart mainPart, Wp.Body body, Wp.SdtBlock sdt)
    {
        var styleLevels = WordWorkspace.ReadStyleOutlineLevels(mainPart);
        var styles = (mainPart.StyleDefinitionsPart?.Styles?.Elements<Wp.Style>() ?? [])
            .Where(style => !string.IsNullOrWhiteSpace(style.StyleId?.Value))
            .GroupBy(style => style.StyleId!.Value!, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        var numbering = new TemplateLayoutNumbering(mainPart, styles);
        var names = body.Descendants<Wp.BookmarkStart>()
            .Select(item => item.Name?.Value)
            .Where(item => item is not null)
            .ToHashSet(StringComparer.Ordinal);
        var nextId = Math.Max(FirstBookmarkId, body.Descendants<Wp.BookmarkStart>()
            .Select(item => int.TryParse(item.Id?.Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var id) ? id : 0)
            .DefaultIfEmpty(0)
            .Max() + 1);
        var nextNumber = FirstBookmarkNumber;
        var entries = new List<TocEntry>();
        var afterToc = false;
        foreach (var paragraph in body.Descendants<Wp.Paragraph>().ToList())
        {
            if (paragraph.Ancestors<Wp.SdtBlock>().Contains(sdt))
            {
                afterToc = true;
                continue;
            }
            // Word 目录不收文本框；兼容显示的文本框在 Fallback 里，同样含 txbxContent。
            if (paragraph.Ancestors<Wp.TextBoxContent>().Any()) continue;
            var label = numbering.Next(paragraph);
            var level = WordWorkspace.ReadOutlineLevel(paragraph, styleLevels);
            if (level >= 9) continue;
            var text = ParagraphText(paragraph);
            if (text.Length == 0) continue;
            if (!string.IsNullOrWhiteSpace(label)) text = $"{label.Trim()} {text}";

            string name;
            do name = $"_Toc{nextNumber++}"; while (!names.Add(name));
            var id = (nextId++).ToString(CultureInfo.InvariantCulture);
            // docx-editor 只收集段落直接子级的书签，起止都放在段落这一层。
            var start = new Wp.BookmarkStart { Id = id, Name = name };
            if (paragraph.ParagraphProperties is { } properties) paragraph.InsertAfter(start, properties);
            else paragraph.PrependChild(start);
            paragraph.AppendChild(new Wp.BookmarkEnd { Id = id });
            entries.Add(new TocEntry(name, level + 1, text, afterToc));
        }
        return entries;
    }

    /// <summary>段落可见文字；制表符和换行记为空格，不含段内文本框。</summary>
    static string ParagraphText(Wp.Paragraph paragraph)
    {
        var builder = new StringBuilder();
        foreach (var element in paragraph.Descendants())
        {
            if (element is not (Wp.Text or Wp.TabChar or Wp.Break or Wp.CarriageReturn)) continue;
            if (element.Ancestors<Wp.TextBoxContent>().Any()) continue;
            builder.Append(element is Wp.Text text ? text.Text : " ");
        }
        return WordWorkspace.Normalize(builder.ToString());
    }

    /// <summary>目录条目：超链接内为文字、制表符和 PAGEREF 页码域；TOC 域起于首条、止于末条段尾。</summary>
    static Wp.Paragraph CreateEntry(TocEntry entry, bool first, bool last)
    {
        var paragraph = new Wp.Paragraph(new Wp.ParagraphProperties(
            new Wp.ParagraphStyleId { Val = $"TOC{Math.Clamp(entry.Level, 1, 9)}" }));
        if (first)
        {
            paragraph.Append(
                FieldChar(Wp.FieldCharValues.Begin),
                FieldCode(" TOC \\o \"1-9\" \\h \\z \\u "),
                FieldChar(Wp.FieldCharValues.Separate));
        }
        paragraph.AppendChild(new Wp.Hyperlink(
            TextRun(entry.Text),
            new Wp.Run(new Wp.TabChar()),
            FieldChar(Wp.FieldCharValues.Begin),
            FieldCode($" PAGEREF {entry.Bookmark} \\h "),
            FieldChar(Wp.FieldCharValues.Separate),
            TextRun(Placeholder),
            FieldChar(Wp.FieldCharValues.End))
        {
            Anchor = entry.Bookmark,
            History = true,
        });
        if (last) paragraph.AppendChild(FieldChar(Wp.FieldCharValues.End));
        return paragraph;
    }

    static Wp.Run FieldChar(Wp.FieldCharValues type) => new(new Wp.FieldChar { FieldCharType = type });

    static Wp.Run FieldCode(string code) => new(new Wp.FieldCode(code) { Space = SpaceProcessingModeValues.Preserve });

    static Wp.Run TextRun(string text) => new(new Wp.Text(text) { Space = SpaceProcessingModeValues.Preserve });
}
