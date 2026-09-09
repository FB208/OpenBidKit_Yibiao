using System.Globalization;
using System.Text.Json;
using AngleSharp.Dom;
using AngleSharp.Html.Parser;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using A = DocumentFormat.OpenXml.Drawing;
using DW = DocumentFormat.OpenXml.Drawing.Wordprocessing;
using PIC = DocumentFormat.OpenXml.Drawing.Pictures;
using Wps = DocumentFormat.OpenXml.Office2010.Word.DrawingShape;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>用受限 HTML 和导出格式配置生成可直接预览的 Word 文档。</summary>
static class RestrictedHtmlDocumentRenderer
{
    const string HeadingMarker = "YIBIAOHEADING";
    const string TableCaptionMarker = "YIBIAOTABLECAPTION:";
    const string FigureCaptionMarker = "YIBIAOFIGURECAPTION:";
    const string UnorderedListMarker = "YIBIAOLISTU:";
    const string OrderedListMarker = "YIBIAOLISTO:";

    static readonly IReadOnlyDictionary<string, (double Width, double Height)> PaperSizes =
        new Dictionary<string, (double Width, double Height)>(StringComparer.OrdinalIgnoreCase)
        {
            ["a4"] = (210, 297),
            ["a3"] = (297, 420),
            ["a5"] = (148, 210),
            ["b4"] = (250, 353),
            ["b5"] = (176, 250),
            ["letter"] = (215.9, 279.4),
            ["legal"] = (215.9, 355.6),
            ["16k"] = (184, 260),
        };

    static readonly IReadOnlyDictionary<string, double> ChineseFontSizes =
        new Dictionary<string, double>(StringComparer.Ordinal)
        {
            ["初号"] = 42,
            ["小初"] = 36,
            ["一号"] = 26,
            ["小一"] = 24,
            ["二号"] = 22,
            ["小二"] = 18,
            ["三号"] = 16,
            ["小三"] = 15,
            ["四号"] = 14,
            ["小四"] = 12,
            ["五号"] = 10.5,
            ["小五"] = 9,
            ["六号"] = 7.5,
            ["小六"] = 6.5,
        };

    // 样张 HTML 是常量，配置每变一次就重新解析一遍纯属浪费；只留最近一份，克隆后再改写。
    static string _parsedHtmlSource = "";
    static IDocument? _parsedHtml;

    /// <summary>一次样张渲染的产物：块数，以及按文档顺序排列的段落角色。</summary>
    public readonly record struct RenderResult(int BlockCount, IReadOnlyList<string> ParagraphRoles);

    /// <summary>新建骨架、直接写入 HTML 正文，再统一应用模板格式。</summary>
    public static RenderResult Render(
        string assetRoot,
        string outputPath,
        string html,
        JsonElement exportFormat,
        ChromeAssets? chrome = null)
    {
        chrome ??= ChromeAssets.Empty;
        var format = new FormatReader(exportFormat);
        var prepared = PrepareHtml(html, format);
        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
        if (File.Exists(outputPath)) File.Delete(outputPath);

        using var document = WordprocessingDocument.Create(outputPath, WordprocessingDocumentType.Document);
        CreateSkeleton(document, format, chrome);
        var mainPart = document.MainDocumentPart!;
        // 样张是临时派生文件；完整校验仍由正式正文插入路径负责。
        var blockCount = RestrictedHtmlWordInserter.InsertIntoContent(
            assetRoot,
            mainPart,
            mainPart.Document.Body!,
            format.Number(format.Section("image"), "max_width_percent", 90),
            prepared.Document,
            cacheAssets: true);
        ApplyFormatting(document, format, prepared.Tables);
        return new RenderResult(blockCount, CollectParagraphRoles(document));
    }

    /// <summary>
    /// 按文档顺序列出正文里每个段落的角色。
    /// 预览侧的编辑器按同样的顺序枚举段落，两边用下标对齐，
    /// 所以这里必须包含表格单元格内的段落，且顺序不能与最终 XML 有出入。
    /// </summary>
    static IReadOnlyList<string> CollectParagraphRoles(WordprocessingDocument document)
    {
        var content = document.MainDocumentPart?.Document.Body;
        if (content is null) return [];

        var roles = new List<string>();
        foreach (var paragraph in content.Descendants<Wp.Paragraph>())
        {
            var styleId = paragraph.ParagraphProperties?.ParagraphStyleId?.Val?.Value ?? "";
            roles.Add(styleId.StartsWith("Heading", StringComparison.Ordinal)
                ? styleId.ToLowerInvariant()
                : "other");
        }
        return roles;
    }

    /// <summary>解析样张 HTML；同一份源码复用上次的解析结果，每次交出独立副本。</summary>
    static IDocument ParseHtml(string html)
    {
        if (_parsedHtml is null || !string.Equals(_parsedHtmlSource, html, StringComparison.Ordinal))
        {
            _parsedHtml = new HtmlParser().ParseDocument(html);
            _parsedHtmlSource = html;
        }

        return (IDocument)_parsedHtml.Clone(true);
    }

    /// <summary>给标题、列表和图表标题加入临时标记，供 Word 后处理精确识别。</summary>
    static PreparedHtml PrepareHtml(string html, FormatReader format)
    {
        var document = ParseHtml(html);
        var counters = new int[6];
        foreach (var heading in document.QuerySelectorAll("h1,h2,h3,h4,h5,h6"))
        {
            var level = int.Parse(heading.LocalName[1..], CultureInfo.InvariantCulture);
            counters[level - 1] += 1;
            Array.Clear(counters, level, counters.Length - level);
            var number = FormatHeadingNumber(counters[..level], format.Heading(level));
            var separator = number.Length > 0 && NeedsSpace(number) ? " " : "";
            heading.InsertBefore(
                document.CreateTextNode($"{HeadingMarker}{level}:{number}{separator}"),
                heading.FirstChild);
        }

        foreach (var item in document.QuerySelectorAll("li"))
        {
            var marker = item.ParentElement?.LocalName == "ol" ? OrderedListMarker : UnorderedListMarker;
            item.InsertBefore(document.CreateTextNode(marker), item.FirstChild);
        }

        var tables = document.QuerySelectorAll("table").Select(ReadTableSpec).ToList();
        foreach (var table in document.QuerySelectorAll("table").ToList())
        {
            var caption = table.Children.FirstOrDefault(item => item.LocalName == "caption");
            if (caption is null) continue;
            var paragraph = document.CreateElement("p");
            paragraph.TextContent = $"{TableCaptionMarker}{caption.TextContent.Trim()}";
            table.ParentElement?.InsertBefore(paragraph, table);
            caption.Remove();
        }

        foreach (var caption in document.QuerySelectorAll("figcaption"))
        {
            caption.TextContent = $"{FigureCaptionMarker}{caption.TextContent.Trim()}";
        }

        return new PreparedHtml(document, tables);
    }

    /// <summary>记录每张源表格的行列角色，转换后据此设置单元格样式。</summary>
    static TableSpec ReadTableSpec(IElement table)
    {
        var rows = new List<(IElement Row, bool IsHeaderRow)>();
        foreach (var child in table.Children)
        {
            if (child.LocalName == "tr") rows.Add((child, false));
            else if (child.LocalName is "thead" or "tbody" or "tfoot")
            {
                rows.AddRange(child.Children
                    .Where(item => item.LocalName == "tr")
                    .Select(item => (item, child.LocalName == "thead")));
            }
        }

        return new TableSpec(rows.Select(source =>
            new TableRowSpec(source.IsHeaderRow, source.Row.Children
                .Where(item => item.LocalName is "th" or "td")
                .Select(cell => ResolveCellRole(cell, source.IsHeaderRow))
                .ToList())).ToList());
    }

    static CellRole ResolveCellRole(IElement cell, bool isHeaderRow)
    {
        var scope = cell.GetAttribute("scope") ?? "";
        if (isHeaderRow || scope == "col") return CellRole.Header;
        if (scope == "row") return CellRole.FirstColumn;
        return CellRole.Body;
    }

    /// <summary>创建包含页面、样式、页眉页脚的空白文档。</summary>
    static void CreateSkeleton(WordprocessingDocument document, FormatReader format, ChromeAssets chrome)
    {
        var mainPart = document.AddMainDocumentPart();
        AddStyles(mainPart, format);
        AddDocumentSettings(mainPart);

        var section = CreateSectionProperties(mainPart, format, chrome);
        mainPart.Document = new Wp.Document(new Wp.Body(section));
        mainPart.Document.Save();
    }

    /// <summary>写入默认正文与六级标题样式，HTML 转换器可直接复用。</summary>
    static void AddStyles(MainDocumentPart mainPart, FormatReader format)
    {
        var stylesPart = mainPart.AddNewPart<StyleDefinitionsPart>();
        var body = format.Section("body_text");
        var styles = new Wp.Styles(
            new Wp.Style(
                new Wp.StyleName { Val = "Normal" },
                // 正文逐段应用间距；Normal 不携带行单位，避免标题、图注和表格继承正文段间距。
                new Wp.StyleParagraphProperties(CreateSpacing(0, 0, 1)),
                CreateStyleRunProperties(
                    format.Text(body, "font", "宋体"),
                    FontHalfPoints(format.Text(body, "size", "小四")),
                    null,
                    null))
            {
                Type = Wp.StyleValues.Paragraph,
                StyleId = "Normal",
                Default = true,
            });

        for (var level = 1; level <= 6; level += 1)
        {
            var heading = format.Heading(level);
            styles.AppendChild(new Wp.Style(
                new Wp.StyleName { Val = $"Heading {level}" },
                new Wp.BasedOn { Val = "Normal" },
                new Wp.NextParagraphStyle { Val = "Normal" },
                new Wp.StyleParagraphProperties(
                    new Wp.KeepNext(),
                    CreateSpacing(
                        format.Number(heading, "spacing_before_pt", level <= 3 ? 10 : 5),
                        format.Number(heading, "spacing_after_pt", level <= 3 ? 10 : 5),
                        format.Number(heading, "line_spacing", 1)),
                    new Wp.OutlineLevel { Val = level - 1 }),
                CreateStyleRunProperties(
                    format.Text(heading, "font", level <= 5 ? "黑体" : "宋体"),
                    FontHalfPoints(format.Text(heading, "size", level == 1 ? "小二" : level == 2 ? "四号" : "小四")),
                    format.Bool(heading, "bold", false),
                    Color(format.Text(heading, "text_color", "#243048"), "243048")))
            {
                Type = Wp.StyleValues.Paragraph,
                StyleId = $"Heading{level}",
            });
        }

        stylesPart.Styles = styles;
        stylesPart.Styles.Save();
    }

    /// <summary>要求 Word 或编辑器打开文档时刷新页码域。</summary>
    static void AddDocumentSettings(MainDocumentPart mainPart)
    {
        var settingsPart = mainPart.AddNewPart<DocumentSettingsPart>();
        settingsPart.Settings = new Wp.Settings(new Wp.UpdateFieldsOnOpen { Val = true });
        settingsPart.Settings.Save();
    }

    /// <summary>按模板构造页面尺寸、边距、分栏及页眉页脚引用。</summary>
    static Wp.SectionProperties CreateSectionProperties(
        MainDocumentPart mainPart,
        FormatReader format,
        ChromeAssets chrome)
    {
        var page = format.Section("page");
        var paper = PaperSizes.TryGetValue(format.Text(page, "paper_size", "a4"), out var found)
            ? found
            : PaperSizes["a4"];
        var landscape = format.Text(page, "orientation", "portrait") == "landscape";
        var width = MmToTwips(landscape ? paper.Height : paper.Width);
        var height = MmToTwips(landscape ? paper.Width : paper.Height);
        var section = new Wp.SectionProperties();

        AddHeaderReferences(mainPart, section, format, chrome);
        AddFooterReferences(mainPart, section, format, chrome);
        section.Append(
            new Wp.PageSize
            {
                Width = (uint)width,
                Height = (uint)height,
                Orient = landscape ? Wp.PageOrientationValues.Landscape : Wp.PageOrientationValues.Portrait,
            },
            new Wp.PageMargin
            {
                // 有装饰时用共享模块算好的边距（已让开装饰带），否则用配置值。
                Top = CmToTwips(chrome.HasLayout
                    ? chrome.MarginTopCm
                    : format.Number(page, "margin_top_cm", 2)),
                Bottom = CmToTwips(chrome.HasLayout
                    ? chrome.MarginBottomCm
                    : format.Number(page, "margin_bottom_cm", 2)),
                Left = (uint)CmToTwips(format.Number(page, "margin_left_cm", 2)),
                Right = (uint)CmToTwips(format.Number(page, "margin_right_cm", 2)),
                // 页眉：有装饰时贴顶（文字由浮动文本框定位），plain 走普通段落流用 1.25cm。
                // 页脚文字与浮动装饰使用共享布局中的距底边距离。
                Header = (uint)CmToTwips(chrome.HasLayout ? chrome.HeaderDistanceCm : 1.25),
                Footer = (uint)CmToTwips(chrome.FooterDistanceCm),
                Gutter = 0U,
            });
        if (format.Bool(page, "page_number_enabled", false))
        {
            section.AppendChild(new Wp.PageNumberType
            {
                Start = Math.Max(1, format.Integer(page, "page_number_start", 1)),
            });
        }
        if (landscape && format.Bool(page, "two_column", false))
        {
            section.AppendChild(new Wp.Columns { ColumnCount = 2, Space = "720" });
        }
        if (format.Bool(page, "first_page_different", false)) section.AppendChild(new Wp.TitlePage());
        return section;
    }

    /// <summary>创建默认页眉；首页不同开启时另设空白首页页眉。</summary>
    static void AddHeaderReferences(
        MainDocumentPart mainPart,
        Wp.SectionProperties section,
        FormatReader format,
        ChromeAssets chrome)
    {
        var page = format.Section("page");
        if (!format.Bool(page, "header_enabled", false)) return;

        var headerPart = mainPart.AddNewPart<HeaderPart>();
        headerPart.Header = new Wp.Header(CreateHeaderContent(format, chrome, headerPart));
        headerPart.Header.Save();
        section.AppendChild(new Wp.HeaderReference
        {
            Type = Wp.HeaderFooterValues.Default,
            Id = mainPart.GetIdOfPart(headerPart),
        });

        if (!format.Bool(page, "first_page_different", false)) return;
        var firstPart = mainPart.AddNewPart<HeaderPart>();
        firstPart.Header = new Wp.Header(new Wp.Paragraph());
        firstPart.Header.Save();
        section.AppendChild(new Wp.HeaderReference
        {
            Type = Wp.HeaderFooterValues.First,
            Id = mainPart.GetIdOfPart(firstPart),
        });
    }

    /// <summary>创建默认页脚；装饰样式分别承载页码和正文区域。</summary>
    static void AddFooterReferences(
        MainDocumentPart mainPart,
        Wp.SectionProperties section,
        FormatReader format,
        ChromeAssets chrome)
    {
        var page = format.Section("page");
        if (!format.Bool(page, "footer_enabled", false)
            && !format.Bool(page, "page_number_enabled", false)) return;

        var footerPart = mainPart.AddNewPart<FooterPart>();
        footerPart.Footer = new Wp.Footer(CreateFooterContent(format, chrome, footerPart));
        footerPart.Footer.Save();
        section.AppendChild(new Wp.FooterReference
        {
            Type = Wp.HeaderFooterValues.Default,
            Id = mainPart.GetIdOfPart(footerPart),
        });

        if (!format.Bool(page, "first_page_different", false)) return;
        var firstPart = mainPart.AddNewPart<FooterPart>();
        firstPart.Footer = new Wp.Footer(new Wp.Paragraph());
        firstPart.Footer.Save();
        section.AppendChild(new Wp.FooterReference
        {
            Type = Wp.HeaderFooterValues.First,
            Id = mainPart.GetIdOfPart(firstPart),
        });
    }

    /// <summary>
    /// 页眉/页脚里的满页宽装饰图。
    ///
    /// 相对纸张定位、置于文字之下、不参与环绕 —— 这是 Word 做水印和信纸底图的标准做法，
    /// 装饰因此可以出血到页边之外，不受正文栏宽约束，也不占文档流高度。
    /// 段落底纹只能画矩形，渐变和斜切必须走图片。
    /// </summary>
    static Wp.Run CreateAnchoredPicture(
        OpenXmlPartContainer container,
        string imagePath,
        uint drawingId,
        string name,
        double widthCm,
        double heightCm,
        double xCm,
        double yCm,
        uint zIndex)
    {
        // 页眉和页脚各自持有 ImagePart，关系 ID 不能跨部件复用。
        var imagePart = container switch
        {
            HeaderPart header => header.AddImagePart(ImagePartType.Png),
            FooterPart footer => footer.AddImagePart(ImagePartType.Png),
            _ => throw new InvalidOperationException("装饰图只能挂在页眉或页脚部件上"),
        };
        using (var stream = File.OpenRead(imagePath))
        {
            imagePart.FeedData(stream);
        }
        var relationshipId = container.GetIdOfPart(imagePart);

        var extent = new DW.Extent { Cx = CmToEmu(widthCm), Cy = CmToEmu(heightCm) };
        var picture = new PIC.Picture(
            new PIC.NonVisualPictureProperties(
                new PIC.NonVisualDrawingProperties { Id = drawingId, Name = name },
                new PIC.NonVisualPictureDrawingProperties()),
            new PIC.BlipFill(
                new A.Blip { Embed = relationshipId, CompressionState = A.BlipCompressionValues.Print },
                new A.Stretch(new A.FillRectangle())),
            new PIC.ShapeProperties(
                new A.Transform2D(
                    new A.Offset { X = 0L, Y = 0L },
                    new A.Extents { Cx = extent.Cx, Cy = extent.Cy }),
                new A.PresetGeometry(new A.AdjustValueList()) { Preset = A.ShapeTypeValues.Rectangle }));

        // 子元素顺序由 schema 强制：
        // simplePos -> positionH -> positionV -> extent -> effectExtent -> wrap -> docPr -> cNvGraphicFramePr -> graphic
        var anchor = new DW.Anchor(
            new DW.SimplePosition { X = 0L, Y = 0L },
            new DW.HorizontalPosition(new DW.PositionOffset(CmToEmu(xCm).ToString(CultureInfo.InvariantCulture)))
            { RelativeFrom = DW.HorizontalRelativePositionValues.Page },
            new DW.VerticalPosition(new DW.PositionOffset(CmToEmu(yCm).ToString(CultureInfo.InvariantCulture)))
            { RelativeFrom = DW.VerticalRelativePositionValues.Page },
            extent,
            new DW.EffectExtent { LeftEdge = 0L, TopEdge = 0L, RightEdge = 0L, BottomEdge = 0L },
            new DW.WrapNone(),
            new DW.DocProperties { Id = drawingId, Name = name },
            new DW.NonVisualGraphicFrameDrawingProperties(new A.GraphicFrameLocks { NoChangeAspect = true }),
            new A.Graphic(new A.GraphicData(picture)
            { Uri = "http://schemas.openxmlformats.org/drawingml/2006/picture" }))
        {
            DistanceFromTop = 0U,
            DistanceFromBottom = 0U,
            DistanceFromLeft = 0U,
            DistanceFromRight = 0U,
            SimplePos = false,
            RelativeHeight = zIndex,
            BehindDoc = true,
            Locked = false,
            LayoutInCell = true,
            AllowOverlap = true,
        };
        return new Wp.Run(new Wp.Drawing(anchor));
    }

    /// <summary>页眉页脚文字块的基础段落：零间距、单倍行距，对齐由调用方给定。</summary>
    static Wp.Paragraph CreateChromeParagraph(string alignment)
    {
        return new Wp.Paragraph(new Wp.ParagraphProperties(
            new Wp.SpacingBetweenLines { Before = "0", After = "0", Line = "240", LineRule = Wp.LineSpacingRuleValues.Auto },
            new Wp.Justification { Val = Alignment(alignment) }));
    }

    /// <summary>
    /// 把一段文字放进锚定浮动文本框，相对纸张绝对定位。
    ///
    /// 用文本框而不是浮动表格或段落框架：后两者的 tblpPr / framePr 定位在
    /// docx-editor.dev 里不生效（实测水平偏移被完全忽略），只有 wp:anchor
    /// 是精确的 —— 和装饰图共用同一套定位机制，两者才能对齐。
    /// 文本框透明无边框，文字仍是可编辑、可搜索的原生 run。
    /// </summary>
    static Wp.Run CreateChromeTextBox(ChromeTextBox box, Wp.Paragraph paragraph, uint drawingId, string name)
    {
        var widthCm = Math.Max(0.1, box.EndCm - box.StartCm);
        var heightCm = Math.Max(0.1, box.HeightCm);
        var extent = new DW.Extent { Cx = CmToEmu(widthCm), Cy = CmToEmu(heightCm) };

        var shape = new Wps.WordprocessingShape(
            new Wps.NonVisualDrawingShapeProperties { TextBox = true },
            new Wps.ShapeProperties(
                new A.Transform2D(
                    new A.Offset { X = 0L, Y = 0L },
                    new A.Extents { Cx = extent.Cx, Cy = extent.Cy }),
                new A.PresetGeometry(new A.AdjustValueList()) { Preset = A.ShapeTypeValues.Rectangle },
                new A.NoFill()),
            new Wps.TextBoxInfo2(new Wp.TextBoxContent(paragraph)),
            // anchor=ctr 让文字在框内垂直居中；四边内边距清零，位置完全由 box 决定
            new Wps.TextBodyProperties
            {
                Rotation = 0,
                Anchor = A.TextAnchoringTypeValues.Center,
                LeftInset = 0,
                TopInset = 0,
                RightInset = 0,
                BottomInset = 0,
            });

        var anchor = new DW.Anchor(
            new DW.SimplePosition { X = 0L, Y = 0L },
            new DW.HorizontalPosition(new DW.PositionOffset(CmToEmu(box.StartCm).ToString(CultureInfo.InvariantCulture)))
            { RelativeFrom = DW.HorizontalRelativePositionValues.Page },
            new DW.VerticalPosition(new DW.PositionOffset(CmToEmu(box.TopCm).ToString(CultureInfo.InvariantCulture)))
            { RelativeFrom = DW.VerticalRelativePositionValues.Page },
            extent,
            new DW.EffectExtent { LeftEdge = 0L, TopEdge = 0L, RightEdge = 0L, BottomEdge = 0L },
            new DW.WrapNone(),
            new DW.DocProperties { Id = drawingId, Name = name },
            new DW.NonVisualGraphicFrameDrawingProperties(),
            new A.Graphic(new A.GraphicData(shape)
            { Uri = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape" }))
        {
            DistanceFromTop = 0U,
            DistanceFromBottom = 0U,
            DistanceFromLeft = 0U,
            DistanceFromRight = 0U,
            SimplePos = false,
            RelativeHeight = drawingId,
            // 文字要压在装饰之上，不能置于文字层下方
            BehindDoc = false,
            Locked = false,
            LayoutInCell = true,
            AllowOverlap = true,
        };
        return new Wp.Run(new Wp.Drawing(anchor));
    }

    /// <summary>浮动表格锚点和末尾必需段落，仅占 1 twip，可同时承载装饰底图。</summary>
    static Wp.Paragraph CreateChromeAnchor(IEnumerable<OpenXmlElement>? children = null)
    {
        var paragraph = CreateChromeParagraph("左对齐");
        SetSingleChild(paragraph.ParagraphProperties!, new Wp.SpacingBetweenLines
        {
            Before = "0", After = "0", Line = "1", LineRule = Wp.LineSpacingRuleValues.Exact,
        });
        if (children is not null) paragraph.Append(children);
        paragraph.AppendChild(new Wp.Run(new Wp.RunProperties(new Wp.FontSize { Val = "1" }), new Wp.Text("")));
        return paragraph;
    }

    /// <summary>按样式分区排版页眉标题和短标记，普通页眉保持段落排版。</summary>
    static IEnumerable<OpenXmlElement> CreateHeaderContent(FormatReader format, ChromeAssets chrome, HeaderPart headerPart)
    {
        var page = format.Section("page");
        var text = format.Text(page, "header_text", "").Trim();
        // 短标记只有 band 样式用得上（前端输入框也只在 band 下显示），
        // 其余样式不得把它并进正文，否则切换样式后会多出改不掉的文字。
        var badge = format.Text(page, "header_badge_text", "").Trim();
        if (badge.Length > 4) badge = badge[..4];

        var layout = chrome.HeaderText;
        var color = layout is not null && layout.Color.Length > 0
            ? Color(layout.Color, "536176")
            : Color(format.Text(page, "header_color", "#536176"), "536176");
        var bold = layout?.Bold ?? false;
        var alignment = layout is not null && layout.Align.Length > 0
            ? layout.Align
            : format.Text(page, "header_alignment", "居中对齐");

        var paragraph = CreateChromeParagraph(alignment);
        var decoration = new List<OpenXmlElement>();
        if (chrome.HasHeaderImage)
        {
            decoration.Add(CreateAnchoredPicture(
                headerPart,
                chrome.HeaderImagePath,
                901U,
                "HeaderDecoration",
                ResolvePaperSize(format).Width,
                chrome.HeaderHeightCm,
                0,
                0,
                10U));
        }

        var font = format.Text(page, "header_font", "宋体");
        var size = FontHalfPoints(format.Text(page, "header_size", "小五"));
        paragraph.AppendChild(CreateRun(text, font, size, color, bold, false));
        if (layout?.Box is { } box)
        {
            // 装饰与各文字块都是浮动对象，全部挂在同一个 1 twip 高的段落上，
            // 页眉区因此不被撑高，位置完全由各自的 anchor 决定。
            var floats = new List<OpenXmlElement>(decoration);
            if (layout.Badge?.Box is { } badgeBox && badge.Length > 0)
            {
                var badgeParagraph = CreateChromeParagraph(layout.Badge.Align);
                badgeParagraph.AppendChild(CreateRun(
                    badge, font, size, Color(layout.Badge.Color, "FFFFFF"), layout.Badge.Bold, false));
                floats.Add(CreateChromeTextBox(badgeBox, badgeParagraph, 911U, "HeaderBadgeText"));
            }
            floats.Add(CreateChromeTextBox(box, paragraph, 912U, "HeaderText"));
            return [CreateChromeAnchor(floats)];
        }
        paragraph.Append(decoration);
        return [paragraph];
    }

    /// <summary>页脚：装饰走锚定图，文字与 PAGE 域仍是原生 run；页码底色用 run 级底纹自动贴合宽度。</summary>
    static IEnumerable<OpenXmlElement> CreateFooterContent(FormatReader format, ChromeAssets chrome, FooterPart footerPart)
    {
        var page = format.Section("page");
        var layout = chrome.FooterText;

        var font = format.Text(page, "footer_font", "宋体");
        var size = FontHalfPoints(format.Text(page, "footer_size", "小五"));
        var textColor = layout is not null && layout.Color.Length > 0
            ? Color(layout.Color, "536176")
            : Color(format.Text(page, "footer_color", "#536176"), "536176");

        var paragraph = CreateChromeParagraph(layout?.Align ?? format.Text(page, "footer_alignment", "居中对齐"));
        var pageParagraph = CreateChromeParagraph(layout?.PageNumberAlign ?? "居中对齐");
        var decoration = new List<OpenXmlElement>();
        if (chrome.HasFooterImage)
        {
            decoration.Add(CreateAnchoredPicture(
                footerPart,
                chrome.FooterImagePath,
                902U,
                "FooterDecoration",
                ResolvePaperSize(format).Width,
                chrome.FooterHeightCm,
                0,
                chrome.FooterTopCm,
                20U));
        }

        var footerEnabled = format.Bool(page, "footer_enabled", false);
        var pageNumberEnabled = format.Bool(page, "page_number_enabled", false);

        if (footerEnabled)
        {
            var footerText = format.Text(page, "footer_text", "").Trim();
            if (footerText.Length > 0)
            {
                paragraph.AppendChild(CreateRun(footerText, font, size, textColor, false, false));
            }
        }
        if (pageNumberEnabled)
        {
            var pageColor = layout is not null && layout.PageNumberColor.Length > 0
                ? Color(layout.PageNumberColor, "536176")
                : textColor;
            AppendPageNumber(
                pageParagraph,
                format.Text(page, "page_number_format", "第{page}页"),
                format.Integer(page, "page_number_pad", 0),
                font,
                size,
                pageColor,
                layout?.PageNumberBold ?? false);

            // 页码文字沿用原生 run 底纹，和所在区域的装饰底色叠加。
            var shading = layout?.PageNumberShading ?? "";
            if (shading.Length > 0)
            {
                var fill = Color(shading, "536176");
                foreach (var run in pageParagraph.Elements<Wp.Run>())
                {
                    // w:rPr 子元素顺序由 schema 强制，shd 排在 sz/szCs 之后
                    run.RunProperties?.AppendChild(new Wp.Shading
                    {
                        Val = Wp.ShadingPatternValues.Clear,
                        Color = "auto",
                        Fill = fill,
                    });
                }
            }
        }
        if (layout?.Box is { } box)
        {
            // 收集所有浮动对象，最后统一挂到一个 1 twip 高的段落上
            var blocks = new List<OpenXmlElement>();
            if (layout.PageNumberBox is { } pageBox)
            {
                // 分区样式：正文与页码各占一块，页码块对准装饰里的色块
                if (paragraph.Elements<Wp.Run>().Any())
                {
                    blocks.Add(CreateChromeTextBox(box, paragraph, 921U, "FooterText"));
                }
                if (pageNumberEnabled)
                {
                    blocks.Add(CreateChromeTextBox(pageBox, pageParagraph, 922U, "FooterPageNumber"));
                }
            }
            else
            {
                // 不分区（rules）：正文与页码合排在同一块里，保持原来的居中一行
                if (paragraph.Elements<Wp.Run>().Any() && pageNumberEnabled)
                {
                    paragraph.AppendChild(CreateRun("    ", font, size, textColor, false, false));
                }
                foreach (var run in pageParagraph.Elements<Wp.Run>().ToArray())
                {
                    run.Remove();
                    paragraph.AppendChild(run);
                }
                if (paragraph.Elements<Wp.Run>().Any())
                {
                    blocks.Add(CreateChromeTextBox(box, paragraph, 921U, "FooterText"));
                }
            }
            blocks.InsertRange(0, decoration);
            return [CreateChromeAnchor(blocks)];
        }
        if (paragraph.Elements<Wp.Run>().Any() && pageNumberEnabled)
        {
            paragraph.AppendChild(CreateRun("    ", font, size, textColor, false, false));
        }
        foreach (var run in pageParagraph.Elements<Wp.Run>().ToArray())
        {
            run.Remove();
            paragraph.AppendChild(run);
        }
        paragraph.Append(decoration);
        if (!paragraph.Elements<Wp.Run>().Any()) paragraph.AppendChild(new Wp.Run(new Wp.Text("")));
        return [paragraph];
    }

    /// <summary>把格式字符串中的 {page} 替换为 Word 页码域。</summary>
    static void AppendPageNumber(
        Wp.Paragraph paragraph,
        string format,
        int pad,
        string font,
        int size,
        string color,
        bool bold = false)
    {
        if (format.Length == 0) format = "第{page}页";
        var markerIndex = format.IndexOf("{page}", StringComparison.Ordinal);
        if (markerIndex < 0)
        {
            paragraph.AppendChild(CreateRun(format, font, size, color, bold, false));
            return;
        }
        var prefix = format[..markerIndex];
        var suffix = format[(markerIndex + 6)..];
        if (prefix.Length > 0) paragraph.AppendChild(CreateRun(prefix, font, size, color, bold, false));

        paragraph.AppendChild(CreateFieldRun(Wp.FieldCharValues.Begin, font, size, color, bold));
        var picture = pad > 0 ? $" \\# \"{new string('0', Math.Clamp(pad, 1, 6))}\"" : "";
        var codeRun = CreateRun($" PAGE{picture} ", font, size, color, bold, false);
        var codeText = codeRun.GetFirstChild<Wp.Text>();
        if (codeText is not null)
        {
            codeText.Remove();
            codeRun.AppendChild(new Wp.FieldCode($" PAGE{picture} ") { Space = SpaceProcessingModeValues.Preserve });
        }
        paragraph.AppendChild(codeRun);
        paragraph.AppendChild(CreateFieldRun(Wp.FieldCharValues.Separate, font, size, color, bold));
        paragraph.AppendChild(CreateRun(pad > 0 ? new string('0', Math.Clamp(pad, 1, 6)) : "1", font, size, color, bold, false));
        paragraph.AppendChild(CreateFieldRun(Wp.FieldCharValues.End, font, size, color, bold));
        if (suffix.Length > 0) paragraph.AppendChild(CreateRun(suffix, font, size, color, bold, false));
    }

    static Wp.Run CreateFieldRun(Wp.FieldCharValues type, string font, int size, string color, bool bold = false)
    {
        var run = CreateRun("", font, size, color, bold, false);
        run.RemoveAllChildren<Wp.Text>();
        run.AppendChild(new Wp.FieldChar { FieldCharType = type });
        return run;
    }

    /// <summary>打开已转换文档，对各类块应用模板中的直接格式。</summary>
    static void ApplyFormatting(WordprocessingDocument document, FormatReader format, IReadOnlyList<TableSpec> tableSpecs)
    {
        var mainPart = document.MainDocumentPart ?? throw new InvalidOperationException("Word 缺少正文部件");
        var content = mainPart.Document.Body ?? throw new InvalidOperationException("Word 缺少正文");

        foreach (var paragraph in content.Descendants<Wp.Paragraph>())
        {
            if (paragraph.Ancestors<Wp.TableCell>().Any()) continue;
            ApplyParagraph(paragraph, format);
        }
        ApplyTables(content, format, tableSpecs);
        ApplyNumbering(mainPart, format);
        // 章节页框会把整章塞进一个表格，一级标题不再是 Body 的直接子元素，
        // 通栏分节那套就落不了地，两者只能二选一。
        if (ChapterFrameEnabled(format)) ApplyChapterParagraphFrames(content, format);
        else ApplyTwoColumnHeadingSections(mainPart, content, format);
        RemoveLeadingPageBreak(content);
        mainPart.Document.Save();
    }

    /// <summary>依据临时标记区分标题、正文、列表和图注。</summary>
    static void ApplyParagraph(Wp.Paragraph paragraph, FormatReader format)
    {
        var text = paragraph.InnerText;
        for (var level = 1; level <= 6; level += 1)
        {
            var marker = $"{HeadingMarker}{level}:";
            if (!text.Contains(marker, StringComparison.Ordinal)) continue;
            RemoveMarker(paragraph, marker);
            ApplyHeading(paragraph, format, level);
            return;
        }
        if (text.Contains(TableCaptionMarker, StringComparison.Ordinal))
        {
            RemoveMarker(paragraph, TableCaptionMarker);
            ApplyCaption(paragraph, format, format.Section("table"), keepNext: true);
            return;
        }
        if (text.Contains(FigureCaptionMarker, StringComparison.Ordinal))
        {
            RemoveMarker(paragraph, FigureCaptionMarker);
            ApplyCaption(paragraph, format, format.Section("image"), keepNext: false);
            return;
        }
        if (paragraph.Descendants<Wp.Drawing>().Any())
        {
            SetParagraphLayout(paragraph, Alignment(format.Text(format.Section("image"), "alignment", "居中对齐")), 0, 0, 1, 0);
            SetImageKeepWithCaption(paragraph);
            return;
        }

        var isList = text.Contains(UnorderedListMarker, StringComparison.Ordinal)
            || text.Contains(OrderedListMarker, StringComparison.Ordinal)
            || paragraph.ParagraphProperties?.NumberingProperties is not null;
        RemoveMarker(paragraph, UnorderedListMarker);
        RemoveMarker(paragraph, OrderedListMarker);
        ApplyBody(paragraph, format, isList);
    }

    /// <summary>应用六级标题的字号、字体、颜色、间距和章节边框。</summary>
    static void ApplyHeading(Wp.Paragraph paragraph, FormatReader format, int level)
    {
        var heading = format.Heading(level);
        var halfPoints = FontHalfPoints(format.Text(heading, "size", level == 1 ? "小二" : level == 2 ? "四号" : "小四"));
        SetParagraphLayout(
            paragraph,
            Alignment(format.Text(heading, "alignment", level == 1 ? "居中对齐" : "两端对齐")),
            format.Number(heading, "spacing_before_pt", level <= 3 ? 10 : 5),
            format.Number(heading, "spacing_after_pt", level <= 3 ? 10 : 5),
            format.Number(heading, "line_spacing", 1),
            CharsToTwips(format.Number(heading, "first_line_indent_chars", 0), halfPoints));
        var properties = EnsureParagraphProperties(paragraph);
        SetSingleChild(properties, new Wp.ParagraphStyleId { Val = $"Heading{level}" });
        SetSingleChild(properties, new Wp.KeepNext());
        SetSingleChild(properties, new Wp.OutlineLevel { Val = level - 1 });
        if (level == 1 && format.Bool(format.Root, "heading_level1_page_break_before", false))
        {
            SetSingleChild(properties, new Wp.PageBreakBefore());
        }
        else
        {
            properties.RemoveAllChildren<Wp.PageBreakBefore>();
        }
        ClearHeadingBorder(properties);
        ApplyRuns(
            paragraph,
            format.Text(heading, "font", level <= 5 ? "黑体" : "宋体"),
            halfPoints,
            Color(format.Text(heading, "text_color", "#243048"), "243048"),
            format.Bool(heading, "bold", false),
            null);
    }

    /// <summary>
    /// 清掉标题段落自带的边框与底纹。
    /// 章节页框的边框和底纹由 ApplyChapterParagraphFrames 统一设置，避免重复画框。
    /// </summary>
    static void ClearHeadingBorder(Wp.ParagraphProperties properties)
    {
        properties.RemoveAllChildren<Wp.ParagraphBorders>();
        properties.RemoveAllChildren<Wp.Shading>();
    }

    /// <summary>应用正文格式；列表保留编号缩进，不再使用首行缩进。</summary>
    static void ApplyBody(Wp.Paragraph paragraph, FormatReader format, bool isList)
    {
        var body = format.Section("body_text");
        var halfPoints = FontHalfPoints(format.Text(body, "size", "小四"));
        SetParagraphLayout(
            paragraph,
            Alignment(format.Text(body, "alignment", "左对齐")),
            CreateBodySpacing(format),
            isList ? 0 : CharsToTwips(format.Number(body, "first_line_indent_chars", 2), halfPoints));
        ApplyRuns(paragraph, format.Text(body, "font", "宋体"), halfPoints, null, null, null);
    }

    /// <summary>应用表题或图注的字体、对齐、粗斜体。</summary>
    static void ApplyCaption(Wp.Paragraph paragraph, FormatReader format, JsonElement style, bool keepNext)
    {
        SetParagraphLayout(
            paragraph,
            Alignment(format.Text(style, "caption_alignment", "居中对齐")),
            0,
            4,
            1,
            0);
        ApplyRuns(
            paragraph,
            format.Text(style, "caption_font", "宋体"),
            FontHalfPoints(format.Text(style, "caption_size", "小五")),
            null,
            format.Bool(style, "caption_bold", false),
            format.Bool(style, "caption_italic", false));
        var properties = EnsureParagraphProperties(paragraph);
        properties.RemoveAllChildren<Wp.KeepNext>();
        if (keepNext) properties.AddChild(new Wp.KeepNext(), throwOnError: true);
    }

    /// <summary>按源 HTML 的表格顺序设置边框、宽度、内边距和单元格角色。</summary>
    static void ApplyTables(
        Wp.Body content,
        FormatReader format,
        IReadOnlyList<TableSpec> tableSpecs)
    {
        var tables = content.Descendants<Wp.Table>().ToList();
        for (var tableIndex = 0; tableIndex < tables.Count; tableIndex += 1)
        {
            var table = tables[tableIndex];
            var spec = tableIndex < tableSpecs.Count ? tableSpecs[tableIndex] : null;
            ApplyTableProperties(table, format);
            var rows = table.Elements<Wp.TableRow>().ToList();
            for (var rowIndex = 0; rowIndex < rows.Count; rowIndex += 1)
            {
                var rowProperties = rows[rowIndex].GetFirstChild<Wp.TableRowProperties>()
                    ?? rows[rowIndex].PrependChild(new Wp.TableRowProperties());
                // 只有表头行禁止跨页；正文行一律允许拆行，否则一行高过整页就再也排不下，
                // 页框里的超长表格会整块被推走，在上一页留下大段空白。
                rowProperties.RemoveAllChildren<Wp.CantSplit>();
                rowProperties.RemoveAllChildren<Wp.TableHeader>();
                if (spec is not null && rowIndex < spec.Rows.Count && spec.Rows[rowIndex].IsHeaderRow)
                {
                    SetSingleChild(rowProperties, new Wp.CantSplit());
                    rowProperties.AddChild(new Wp.TableHeader(), throwOnError: true);
                }
                var cells = rows[rowIndex].Elements<Wp.TableCell>().ToList();
                for (var cellIndex = 0; cellIndex < cells.Count; cellIndex += 1)
                {
                    var role = spec is not null
                        && rowIndex < spec.Rows.Count
                        && cellIndex < spec.Rows[rowIndex].Cells.Count
                            ? spec.Rows[rowIndex].Cells[cellIndex]
                            : CellRole.Body;
                    ApplyTableCell(cells[cellIndex], format, role);
                }
            }
        }
    }

    /// <summary>覆盖 HTML 转换器的默认表格轮廓，使用模板配置。</summary>
    static void ApplyTableProperties(Wp.Table table, FormatReader format)
    {
        var style = format.Section("table");
        var properties = table.GetFirstChild<Wp.TableProperties>() ?? table.PrependChild(new Wp.TableProperties());
        properties.RemoveAllChildren();
        var fullWidth = format.Bool(style, "full_width", true);
        // 满宽表格的宽度用 dxa 写死成正文栏宽。tblW 用百分比时 Word 会把单元格左右边距
        // 加在百分比宽度之外，表格比正文栏宽出两个边距（默认配比 0.4cm），右边顶出页边距。
        // 嵌套表格的百分比是相对父单元格算的，换成绝对宽度会撑破单元格，只处理顶层表格。
        var pinnedWidth = fullWidth && table.Parent is Wp.Body;
        properties.AppendChild(pinnedWidth
            ? new Wp.TableWidth
            {
                Type = Wp.TableWidthUnitValues.Dxa,
                Width = ContentWidthTwips(format).ToString(CultureInfo.InvariantCulture),
            }
            : new Wp.TableWidth
            {
                Type = fullWidth ? Wp.TableWidthUnitValues.Pct : Wp.TableWidthUnitValues.Auto,
                Width = fullWidth ? "5000" : "0",
            });

        var borderColor = Color(format.Text(style, "border_color", "#dcdff6"), "DCDFF6");
        var borderSize = (uint)Math.Clamp((int)Math.Round(format.Number(style, "border_width", 1) * 8), 0, 96);
        properties.AppendChild(new Wp.TableBorders(
            CreateTableBorder<Wp.TopBorder>(borderColor, borderSize),
            CreateTableBorder<Wp.LeftBorder>(borderColor, borderSize),
            CreateTableBorder<Wp.BottomBorder>(borderColor, borderSize),
            CreateTableBorder<Wp.RightBorder>(borderColor, borderSize),
            CreateTableBorder<Wp.InsideHorizontalBorder>(borderColor, borderSize),
            CreateTableBorder<Wp.InsideVerticalBorder>(borderColor, borderSize)));
        properties.AppendChild(new Wp.TableLayout
        {
            Type = fullWidth ? Wp.TableLayoutValues.Fixed : Wp.TableLayoutValues.Autofit,
        });

        var padding = Math.Max(0, (int)Math.Round(format.Number(style, "cell_padding_pt", 6) * 20));
        properties.AppendChild(new Wp.TableCellMarginDefault(
            new Wp.TopMargin { Width = padding.ToString(CultureInfo.InvariantCulture), Type = Wp.TableWidthUnitValues.Dxa },
            new Wp.TableCellLeftMargin { Width = (short)Math.Min(short.MaxValue, padding), Type = Wp.TableWidthValues.Dxa },
            new Wp.BottomMargin { Width = padding.ToString(CultureInfo.InvariantCulture), Type = Wp.TableWidthUnitValues.Dxa },
            new Wp.TableCellRightMargin { Width = (short)Math.Min(short.MaxValue, padding), Type = Wp.TableWidthValues.Dxa }));
    }

    /// <summary>应用表头、首列或普通单元格的独立样式。</summary>
    static void ApplyTableCell(Wp.TableCell cell, FormatReader format, CellRole role)
    {
        var table = format.Section("table");
        var style = format.Child(table, role switch
        {
            CellRole.Header => "header_row",
            CellRole.FirstColumn => "first_column",
            _ => "body_cell",
        });
        var properties = cell.GetFirstChild<Wp.TableCellProperties>() ?? cell.PrependChild(new Wp.TableCellProperties());
        SetSingleChild(properties, new Wp.Shading
        {
            Val = Wp.ShadingPatternValues.Clear,
            Fill = Color(format.Text(style, "background_color", role == CellRole.Header ? "#eef5ff" : "#ffffff"), "FFFFFF"),
        });

        foreach (var paragraph in cell.Descendants<Wp.Paragraph>()
            .Where(item => ReferenceEquals(item.Ancestors<Wp.TableCell>().FirstOrDefault(), cell)))
        {
            var text = paragraph.InnerText;
            if (text.Contains(TableCaptionMarker, StringComparison.Ordinal))
            {
                RemoveMarker(paragraph, TableCaptionMarker);
                ApplyCaption(paragraph, format, format.Section("table"), keepNext: true);
                continue;
            }
            if (text.Contains(FigureCaptionMarker, StringComparison.Ordinal))
            {
                RemoveMarker(paragraph, FigureCaptionMarker);
                ApplyCaption(paragraph, format, format.Section("image"), keepNext: false);
                continue;
            }
            if (paragraph.Descendants<Wp.Drawing>().Any())
            {
                SetParagraphLayout(paragraph, Alignment(format.Text(format.Section("image"), "alignment", "居中对齐")), 0, 0, 1, 0);
                SetImageKeepWithCaption(paragraph);
                continue;
            }

            RemoveMarker(paragraph, UnorderedListMarker);
            RemoveMarker(paragraph, OrderedListMarker);
            SetParagraphLayout(
                paragraph,
                Alignment(format.Text(style, "alignment", role == CellRole.Header ? "居中对齐" : "左对齐")),
                CreateBodySpacing(format, tableCell: true),
                paragraph.ParagraphProperties?.NumberingProperties is null ? 0 : -1);
            ApplyRuns(
                paragraph,
                format.Text(style, "font", role == CellRole.Header ? "黑体" : "宋体"),
                FontHalfPoints(format.Text(style, "size", "小四")),
                Color(format.Text(style, "text_color", "#243048"), "243048"),
                role == CellRole.Header ? true : null,
                null);
        }
    }

    /// <summary>将转换器生成的列表编号统一改成模板选择的项目符号和序号。</summary>
    static void ApplyNumbering(MainDocumentPart mainPart, FormatReader format)
    {
        var numbering = mainPart.NumberingDefinitionsPart?.Numbering;
        if (numbering is null) return;
        var body = format.Section("body_text");
        var halfPoints = FontHalfPoints(format.Text(body, "size", "小四"));
        var indentChars = format.Number(body, "list_indent_chars", 2);
        var framed = ChapterFrameEnabled(format);

        foreach (var abstractNumber in numbering.Elements<Wp.AbstractNum>())
        {
            foreach (var level in abstractNumber.Elements<Wp.Level>())
            {
                var levelIndex = Math.Clamp(level.LevelIndex?.Value ?? 0, 0, 8);
                var currentFormat = level.GetFirstChild<Wp.NumberingFormat>()?.Val?.Value;
                var unordered = currentFormat == Wp.NumberFormatValues.Bullet;
                if (unordered) ApplyUnorderedLevel(level, format.Text(body, "list_style", "disc"), halfPoints);
                else ApplyOrderedLevel(level, format.Text(body, "ordered_list_style", "decimal-dot"), levelIndex);

                var indent = ListLevelIndent(indentChars, levelIndex, halfPoints, framed);
                var paragraphProperties = level.GetFirstChild<Wp.PreviousParagraphProperties>()
                    ?? AddChild(level, new Wp.PreviousParagraphProperties());
                var indentation = new Wp.Indentation { Left = indent.Left.ToString(CultureInfo.InvariantCulture) };
                if (indent.Hanging > 0) indentation.Hanging = indent.Hanging.ToString(CultureInfo.InvariantCulture);
                if (indent.FirstLine > 0) indentation.FirstLine = indent.FirstLine.ToString(CultureInfo.InvariantCulture);
                SetSingleChild(paragraphProperties, indentation);
            }
        }
        numbering.Save();
    }

    /// <summary>
    /// 列表级别的缩进；和 exportService.cjs 的 getListLevelIndent 逐条对应。
    ///
    /// 章节页框打开时改用首行缩进：left 固定为 ChapterFramePaddingTwips，层级由 firstLine 体现。
    /// 页框内每一块的左竖线必须落在同一条线上，而 Word 与预览排版引擎给竖线定位的方式并不一样
    /// ——Word 锚在段落最左那个字符（悬挂出去的编号也算，即 left - hanging），预览引擎锚在
    /// w:ind left。hanging 非零时两边必然有一边是歪的；firstLine 只推首行、两边都不挪竖线，
    /// 是同时对上的唯一写法。代价是折行的文字回到页框内边缘，不与编号后的文字对齐。
    /// </summary>
    static (int Left, int Hanging, int FirstLine) ListLevelIndent(double indentChars, int levelIndex, int halfPoints, bool framed)
    {
        var text = CharsToTwips(indentChars * (levelIndex + 1), halfPoints);
        if (!framed) return (text, Math.Min(text, CharsToTwips(1, halfPoints)), 0);
        return (ChapterFramePaddingTwips, 0, text);
    }

    /// <summary>设置无序列表符号及其字体。</summary>
    static void ApplyUnorderedLevel(Wp.Level level, string style, int halfPoints)
    {
        var marker = style switch
        {
            "none" => ("", "Arial", 1.0),
            "circle" => ("○", "Arial", 0.82),
            "square" => ("■", "Arial", 0.72),
            "diamond" => ("◆", "Arial", 0.72),
            "dash" => ("–", "Arial", 0.9),
            "check" => ("✓", "Segoe UI Symbol", 0.85),
            "arrow" => ("➢", "Segoe UI Symbol", 0.88),
            "sparkle" => ("✧", "Segoe UI Symbol", 0.9),
            _ => ("•", "Arial", 0.75),
        };
        SetSingleChild(level, new Wp.NumberingFormat { Val = Wp.NumberFormatValues.Bullet });
        SetSingleChild(level, new Wp.LevelText { Val = marker.Item1 });
        var runProperties = level.GetFirstChild<Wp.NumberingSymbolRunProperties>()
            ?? AddChild(level, new Wp.NumberingSymbolRunProperties());
        SetSingleChild(runProperties, new Wp.RunFonts
        {
            Ascii = marker.Item2,
            HighAnsi = marker.Item2,
            EastAsia = marker.Item2,
        });
        var markerSize = Math.Max(1, (int)Math.Round(halfPoints * marker.Item3));
        SetSingleChild(runProperties, new Wp.FontSize { Val = markerSize.ToString(CultureInfo.InvariantCulture) });
    }

    /// <summary>设置有序列表的数字、中文、字母或罗马数字格式。</summary>
    static void ApplyOrderedLevel(Wp.Level level, string style, int levelIndex)
    {
        var placeholder = $"%{levelIndex + 1}";
        var (numberFormat, text) = style switch
        {
            "decimal-paren" => (Wp.NumberFormatValues.Decimal, $"{placeholder}）"),
            "decimal-full-paren" => (Wp.NumberFormatValues.Decimal, $"（{placeholder}）"),
            "chinese-dot" => (Wp.NumberFormatValues.ChineseCounting, $"{placeholder}、"),
            "chinese-paren" => (Wp.NumberFormatValues.ChineseCounting, $"（{placeholder}）"),
            "lower-alpha" => (Wp.NumberFormatValues.LowerLetter, $"{placeholder}."),
            "upper-alpha" => (Wp.NumberFormatValues.UpperLetter, $"{placeholder}."),
            "lower-roman" => (Wp.NumberFormatValues.LowerRoman, $"{placeholder}."),
            "upper-roman" => (Wp.NumberFormatValues.UpperRoman, $"{placeholder}."),
            _ => (Wp.NumberFormatValues.Decimal, $"{placeholder}."),
        };
        SetSingleChild(level, new Wp.NumberingFormat { Val = numberFormat });
        SetSingleChild(level, new Wp.LevelText { Val = text });
    }

    /// <summary>设置段落对齐、段前段后、行距和首行缩进。</summary>
    static void SetParagraphLayout(
        Wp.Paragraph paragraph,
        Wp.JustificationValues alignment,
        double beforePoints,
        double afterPoints,
        double lineMultiple,
        int firstLineTwips)
    {
        SetParagraphLayout(paragraph, alignment, CreateSpacing(beforePoints, afterPoints, lineMultiple), firstLineTwips);
    }

    /// <summary>复用段落布局逻辑，允许正文传入原生单位与行距规则。</summary>
    static void SetParagraphLayout(
        Wp.Paragraph paragraph,
        Wp.JustificationValues alignment,
        Wp.SpacingBetweenLines spacing,
        int firstLineTwips)
    {
        var properties = EnsureParagraphProperties(paragraph);
        SetSingleChild(properties, new Wp.Justification { Val = alignment });
        SetSingleChild(properties, spacing);
        if (firstLineTwips < 0) return;
        properties.RemoveAllChildren<Wp.Indentation>();
        if (firstLineTwips > 0)
        {
            properties.AddChild(new Wp.Indentation
            {
                FirstLine = firstLineTwips.ToString(CultureInfo.InvariantCulture),
            }, throwOnError: true);
        }
    }

    /// <summary>为段落内所有文本运行统一基础字体，同时保留 HTML 粗体等内联标记。</summary>
    static void ApplyRuns(
        Wp.Paragraph paragraph,
        string font,
        int halfPoints,
        string? color,
        bool? bold,
        bool? italic)
    {
        foreach (var run in paragraph.Descendants<Wp.Run>())
        {
            var properties = run.RunProperties ?? run.PrependChild(new Wp.RunProperties());
            SetSingleChild(properties, new Wp.RunFonts
            {
                Ascii = font,
                HighAnsi = font,
                EastAsia = font,
                ComplexScript = font,
            });
            SetSingleChild(properties, new Wp.FontSize { Val = halfPoints.ToString(CultureInfo.InvariantCulture) });
            SetSingleChild(properties, new Wp.FontSizeComplexScript { Val = halfPoints.ToString(CultureInfo.InvariantCulture) });
            if (color is not null) SetSingleChild(properties, new Wp.Color { Val = color });
            if (bold.HasValue)
            {
                properties.RemoveAllChildren<Wp.Bold>();
                properties.RemoveAllChildren<Wp.BoldComplexScript>();
                if (bold.Value)
                {
                    properties.AddChild(new Wp.Bold(), throwOnError: true);
                    properties.AddChild(new Wp.BoldComplexScript(), throwOnError: true);
                }
            }
            if (italic.HasValue)
            {
                properties.RemoveAllChildren<Wp.Italic>();
                properties.RemoveAllChildren<Wp.ItalicComplexScript>();
                if (italic.Value)
                {
                    properties.AddChild(new Wp.Italic(), throwOnError: true);
                    properties.AddChild(new Wp.ItalicComplexScript(), throwOnError: true);
                }
            }
        }
    }

    /// <summary>建立一个带指定字体属性的普通文本运行。</summary>
    static Wp.Run CreateRun(
        string text,
        string font,
        int halfPoints,
        string color,
        bool bold,
        bool italic)
    {
        var properties = new Wp.RunProperties(
            new Wp.RunFonts { Ascii = font, HighAnsi = font, EastAsia = font, ComplexScript = font });
        if (bold) properties.AppendChild(new Wp.Bold());
        if (italic) properties.AppendChild(new Wp.Italic());
        properties.Append(
            new Wp.Color { Val = color },
            new Wp.FontSize { Val = halfPoints.ToString(CultureInfo.InvariantCulture) },
            new Wp.FontSizeComplexScript { Val = halfPoints.ToString(CultureInfo.InvariantCulture) });
        return new Wp.Run(
            properties,
            new Wp.Text(text) { Space = SpaceProcessingModeValues.Preserve });
    }

    static Wp.StyleRunProperties CreateStyleRunProperties(
        string font,
        int halfPoints,
        bool? bold,
        string? color)
    {
        var properties = new Wp.StyleRunProperties(
            new Wp.RunFonts { Ascii = font, HighAnsi = font, EastAsia = font, ComplexScript = font });
        if (bold == true) properties.AppendChild(new Wp.Bold());
        if (color is not null) properties.AppendChild(new Wp.Color { Val = color });
        properties.Append(
            new Wp.FontSize { Val = halfPoints.ToString(CultureInfo.InvariantCulture) },
            new Wp.FontSizeComplexScript { Val = halfPoints.ToString(CultureInfo.InvariantCulture) });
        return properties;
    }

    static Wp.ParagraphProperties EnsureParagraphProperties(Wp.Paragraph paragraph)
    {
        return paragraph.ParagraphProperties ?? paragraph.PrependChild(new Wp.ParagraphProperties());
    }

    /// <summary>按正文新协议生成间距；单元格只共享行距，保留段前 0、段后 4pt。</summary>
    static Wp.SpacingBetweenLines CreateBodySpacing(FormatReader format, bool tableCell = false)
    {
        var body = format.Section("body_text");
        var beforeInLines = !tableCell && format.Text(body, "spacing_before_unit", "lines") == "lines";
        var afterInLines = !tableCell && format.Text(body, "spacing_after_unit", "lines") == "lines";
        var before = tableCell ? 0 : format.Number(body, "spacing_before", 0);
        var after = tableCell ? 4 : format.Number(body, "spacing_after", 0);
        var mode = format.Text(body, "line_spacing_mode", "multiple");
        var value = format.Number(body, "line_spacing_value", 1.2);
        var line = mode switch
        {
            "single" => 240,
            "one-and-half" => 360,
            "double" => 480,
            "at-least" or "exact" => value * 20,
            _ => value * 240,
        };
        var spacing = new Wp.SpacingBetweenLines
        {
            // 行距只约束到最小原生单位，不用倍数下限抬高合法的固定值或最小值。
            Line = Math.Max(1, (int)Math.Round(line)).ToString(CultureInfo.InvariantCulture),
            LineRule = mode switch
            {
                "at-least" => Wp.LineSpacingRuleValues.AtLeast,
                "exact" => Wp.LineSpacingRuleValues.Exact,
                _ => Wp.LineSpacingRuleValues.Auto,
            },
        };
        // 行单位按百分之一行写入，磅按 twips 写入；同侧不同时设置两种单位。
        var beforeValue = Math.Max(0, (int)Math.Round(before * (beforeInLines ? 100 : 20)));
        var afterValue = Math.Max(0, (int)Math.Round(after * (afterInLines ? 100 : 20)));
        if (beforeInLines) spacing.BeforeLines = beforeValue;
        else spacing.Before = beforeValue.ToString(CultureInfo.InvariantCulture);
        if (afterInLines) spacing.AfterLines = afterValue;
        else spacing.After = afterValue.ToString(CultureInfo.InvariantCulture);
        return spacing;
    }

    /// <summary>保留标题、图注等非正文段落的磅值间距和倍数行距。</summary>
    static Wp.SpacingBetweenLines CreateSpacing(double beforePoints, double afterPoints, double lineMultiple)
    {
        return new Wp.SpacingBetweenLines
        {
            Before = Math.Max(0, (int)Math.Round(beforePoints * 20)).ToString(CultureInfo.InvariantCulture),
            After = Math.Max(0, (int)Math.Round(afterPoints * 20)).ToString(CultureInfo.InvariantCulture),
            Line = Math.Max(1, (int)Math.Round(Math.Max(0.1, lineMultiple) * 240)).ToString(CultureInfo.InvariantCulture),
            LineRule = Wp.LineSpacingRuleValues.Auto,
        };
    }

    /// <summary>从文本节点中清除仅供格式识别的临时标记。</summary>
    static void RemoveMarker(Wp.Paragraph paragraph, string marker)
    {
        foreach (var text in paragraph.Descendants<Wp.Text>())
        {
            if (text.Text.Contains(marker, StringComparison.Ordinal))
            {
                text.Text = text.Text.Replace(marker, "", StringComparison.Ordinal);
            }
        }
    }

    /// <summary>图片后紧跟图注时保持二者同页。</summary>
    static void SetImageKeepWithCaption(Wp.Paragraph paragraph)
    {
        var properties = EnsureParagraphProperties(paragraph);
        properties.RemoveAllChildren<Wp.KeepNext>();
        var next = paragraph.NextSibling<Wp.Paragraph>();
        if (next?.InnerText.Contains(FigureCaptionMarker, StringComparison.Ordinal) == true)
        {
            properties.AddChild(new Wp.KeepNext(), throwOnError: true);
        }
    }

    // -- 章节页框 --------------------------------------------------------
    //
    // 用段落边框逐块画框，业务表格留在顶层；切分与取色规则和
    // exportService.cjs 的 addOutlineItems / chapterFrameParagraphOptions 对应。

    /// <summary>是否启用章节段落页框。</summary>
    static bool ChapterFrameEnabled(FormatReader format)
    {
        return format.Bool(format.Section("heading_border"), "enabled", false);
    }

    /// <summary>段落的标题级别；1-6 表示 HeadingN，0 表示不是标题。</summary>
    static int HeadingLevelOf(OpenXmlElement element)
    {
        if (element is not Wp.Paragraph paragraph) return 0;
        var styleId = paragraph.ParagraphProperties?.ParagraphStyleId?.Val?.Value ?? "";
        if (!styleId.StartsWith("Heading", StringComparison.Ordinal)) return 0;
        return int.TryParse(styleId.AsSpan(7), out var level) && level >= 1 && level <= 6 ? level : 0;
    }

    /// <summary>
    /// 去掉正文首个段落的分页属性。
    /// 样张直接以一级标题开头，正式导出前面还有标题块；不去掉的话预览会凭空多出一页空白，
    /// 让人以为模板设置有问题。
    /// </summary>
    static void RemoveLeadingPageBreak(Wp.Body content)
    {
        var first = content.ChildElements.FirstOrDefault(item => item is not Wp.SectionProperties);
        if (first is Wp.Paragraph paragraph)
        {
            paragraph.ParagraphProperties?.RemoveAllChildren<Wp.PageBreakBefore>();
        }
    }

    /// <summary>按一级标题把正文切成章；一级标题之前的内容（封面、目录等）不进页框。</summary>
    static List<List<OpenXmlElement>> CollectChapters(Wp.Body content)
    {
        // 先固定住分组，后面要替换节点，不能边遍历边改
        var elements = content.ChildElements
            .Where(item => item is not Wp.SectionProperties)
            .ToList();
        var chapters = new List<List<OpenXmlElement>>();
        List<OpenXmlElement>? current = null;
        foreach (var element in elements)
        {
            if (HeadingLevelOf(element) == 1)
            {
                current = [];
                chapters.Add(current);
            }

            current?.Add(element);
        }

        return chapters;
    }

    // -- 段落边框页框 ----------------------------------------------------
    //
    // 每个块自己画边框，相邻段落的竖线由 Word 和预览引擎合并成一条，
    // 视觉上和整章包一张表一样，但每个块都能独立参与分页：
    // 超长表格可以跨页拆行，正文也不会被整块推走。

    /// <summary>页框竖线与文字之间的留白（twips）。</summary>
    const int ChapterFramePaddingTwips = 115;

    /// <summary>左右边线与文字的距离（磅）。加上 0.75 磅线宽正好等于上面的留白，竖线落在文字栏边缘。</summary>
    const uint ChapterFrameBorderSpacePt = 5;

    /// <summary>横线与文字的距离（磅）。</summary>
    const uint ChapterFrameLineSpacePt = 1;

    /// <summary>用段落边框给每个一级章节画连续页框。</summary>
    static void ApplyChapterParagraphFrames(Wp.Body content, FormatReader format)
    {
        var border = format.Section("heading_border");
        var color = Color(format.Text(border, "border_color", "#cfd8ee"), "CFD8EE");
        var fills = new string[6];
        for (var level = 1; level <= 6; level += 1)
        {
            fills[level - 1] = Color(format.ArrayText(border, "level_cell_colors", level - 1, "#ffffff"), "FFFFFF");
        }

        foreach (var chapter in CollectChapters(content))
        {
            if (chapter.Count == 0) continue;
            foreach (var element in chapter)
            {
                if (element is Wp.Table table)
                {
                    ApplyChapterFrameTableBorders(table, color, format);
                    continue;
                }

                if (element is not Wp.Paragraph paragraph) continue;
                var level = HeadingLevelOf(paragraph);
                // 正文只画左右竖线，交给 Word 和预览引擎合并成一条连续的框；
                // 标题自带上横线和底纹，章尾那条横线由收尾段落补。
                ApplyChapterFrameParagraph(
                    paragraph,
                    color,
                    level > 0 ? fills[Math.Clamp(level - 1, 0, 5)] : null,
                    topLine: level > 0);
            }

            chapter[^1].InsertAfterSelf(CreateChapterFrameClosingParagraph(color));
        }
    }

    /// <summary>给页框内的一个段落加边框、底纹和左右留白。</summary>
    static void ApplyChapterFrameParagraph(
        Wp.Paragraph paragraph,
        string color,
        string? fill,
        bool topLine)
    {
        var properties = EnsureParagraphProperties(paragraph);
        SetSingleChild(properties, CreateChapterFrameBorders(color, topLine));

        if (fill is null) properties.RemoveAllChildren<Wp.Shading>();
        else SetSingleChild(properties, new Wp.Shading { Val = Wp.ShadingPatternValues.Clear, Fill = fill });

        var indentation = properties.GetFirstChild<Wp.Indentation>();
        if (indentation is null)
        {
            indentation = new Wp.Indentation();
            properties.AddChild(indentation, throwOnError: true);
        }

        // 首行缩进已经写进 w:ind，页框留白只能往上叠，不能覆盖。
        // 列表段落的 left / hanging 由编号定义给（ListLevelIndent 已经把留白算进去了），
        // 这里一旦写 w:ind left，段落直接格式就会盖掉编号定义的 left 而 hanging 照旧继承，
        // 最左字符被拉到留白左边，竖线跟着外凸——只补右留白。
        if (properties.GetFirstChild<Wp.NumberingProperties>() is null)
        {
            indentation.Left = AddTwips(indentation.Left, ChapterFramePaddingTwips);
        }

        indentation.Right = AddTwips(indentation.Right, ChapterFramePaddingTwips);
    }

    /// <summary>页框边框；子元素顺序按 OOXML schema 的 top / left / bottom / right。</summary>
    static Wp.ParagraphBorders CreateChapterFrameBorders(string color, bool topLine)
    {
        var borders = new Wp.ParagraphBorders();
        if (topLine) borders.AppendChild(CreateFrameBorder<Wp.TopBorder>(color, ChapterFrameLineSpacePt));
        borders.AppendChild(CreateFrameBorder<Wp.LeftBorder>(color, ChapterFrameBorderSpacePt));
        borders.AppendChild(CreateFrameBorder<Wp.RightBorder>(color, ChapterFrameBorderSpacePt));
        return borders;
    }

    /// <summary>
    /// 章尾收尾段落：只有 1 twip 行高，肉眼看不见，作用是把页框底边那条横线画出来。
    /// 让最后一个块自己画底线做不到——JS 侧的块建好就不可改，两边得用同一套办法。
    /// </summary>
    static Wp.Paragraph CreateChapterFrameClosingParagraph(string color)
    {
        var paragraph = new Wp.Paragraph();
        var properties = EnsureParagraphProperties(paragraph);
        properties.AddChild(CreateChapterFrameBorders(color, topLine: true), throwOnError: true);
        properties.AddChild(new Wp.SpacingBetweenLines
        {
            Before = "0",
            After = "0",
            Line = "20",
            LineRule = Wp.LineSpacingRuleValues.Exact,
        }, throwOnError: true);
        properties.AddChild(new Wp.Indentation
        {
            Left = ChapterFramePaddingTwips.ToString(CultureInfo.InvariantCulture),
            Right = ChapterFramePaddingTwips.ToString(CultureInfo.InvariantCulture),
        }, throwOnError: true);
        return paragraph;
    }

    static string AddTwips(StringValue? value, int delta)
    {
        var current = int.TryParse(value?.Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : 0;
        return (current + delta).ToString(CultureInfo.InvariantCulture);
    }

    static T CreateFrameBorder<T>(string color, uint spacePt) where T : Wp.BorderType, new()
    {
        return new T
        {
            Val = Wp.BorderValues.Single,
            Color = color,
            Size = 6,
            Space = spacePt,
        };
    }

    /// <summary>正文栏的可用宽度；双栏时是单栏宽度。</summary>
    static int ContentWidthTwips(FormatReader format)
    {
        var page = format.Section("page");
        var paper = PaperSizes.TryGetValue(format.Text(page, "paper_size", "a4"), out var found)
            ? found
            : PaperSizes["a4"];
        var landscape = format.Text(page, "orientation", "portrait") == "landscape";
        var width = MmToTwips(landscape ? paper.Height : paper.Width);
        var text = width
            - CmToTwips(format.Number(page, "margin_left_cm", 2))
            - CmToTwips(format.Number(page, "margin_right_cm", 2));
        // 分栏的判断和 BuildSectionProperties 一致：只有横向才真的分栏，栏间距固定 720。
        if (landscape && format.Bool(page, "two_column", false)) text = (text - 720) / 2;
        return Math.Max(1, text);
    }

    /// <summary>
    /// 页框内的业务表格强制满栏宽并接管左右竖线，上下和内部横线保持表格自己的样式。
    /// </summary>
    static void ApplyChapterFrameTableBorders(Wp.Table table, string color, FormatReader format)
    {
        var properties = table.GetFirstChild<Wp.TableProperties>() ?? table.PrependChild(new Wp.TableProperties());
        var width = ContentWidthTwips(format);
        SetSingleChild(properties, new Wp.TableWidth
        {
            Type = Wp.TableWidthUnitValues.Dxa,
            Width = width.ToString(CultureInfo.InvariantCulture),
        });
        SetSingleChild(properties, new Wp.TableLayout { Type = Wp.TableLayoutValues.Fixed });

        // 与 exportService.cjs 的 tableColumnWidths 一致：均分逻辑列，余量补在末列。
        var columnCount = table.Elements<Wp.TableRow>().Max(row => row.Elements<Wp.TableCell>()
            .Sum(cell => cell.TableCellProperties?.GridSpan?.Val?.Value ?? 1));
        var columnWidth = width / columnCount;
        var grid = new Wp.TableGrid();
        for (var index = 0; index < columnCount; index += 1)
        {
            grid.AppendChild(new Wp.GridColumn
            {
                Width = (columnWidth + (index == columnCount - 1 ? width % columnCount : 0))
                    .ToString(CultureInfo.InvariantCulture),
            });
        }
        SetSingleChild(table, grid);
        // 列宽由新网格统一，去掉转换器的旧首选宽度，保留跨列与跨行合并。
        foreach (var cell in table.Elements<Wp.TableRow>().SelectMany(row => row.Elements<Wp.TableCell>()))
        {
            cell.TableCellProperties?.RemoveAllChildren<Wp.TableCellWidth>();
        }

        var borders = properties.GetFirstChild<Wp.TableBorders>();
        if (borders is null)
        {
            borders = new Wp.TableBorders();
            properties.AddChild(borders, throwOnError: true);
        }

        SetSingleChild(borders, CreateTableBorder<Wp.LeftBorder>(color, 6));
        SetSingleChild(borders, CreateTableBorder<Wp.RightBorder>(color, 6));
    }

    /// <summary>双栏文档用连续分节把一级标题单独置于通栏。</summary>
    static void ApplyTwoColumnHeadingSections(
        MainDocumentPart mainPart,
        Wp.Body content,
        FormatReader format)
    {
        var page = format.Section("page");
        if (format.Text(page, "orientation", "portrait") != "landscape"
            || !format.Bool(page, "two_column", false)) return;
        var finalSection = mainPart.Document.Body?.Elements<Wp.SectionProperties>().LastOrDefault();
        if (finalSection is null) return;

        var headings = content.Elements<Wp.Paragraph>()
            .Where(item => item.ParagraphProperties?.ParagraphStyleId?.Val?.Value == "Heading1")
            .ToList();
        var startPropertiesAvailable = true;
        foreach (var heading in headings)
        {
            var hasPriorContent = content.ChildElements
                .TakeWhile(item => !ReferenceEquals(item, heading))
                .Any(item => item is Wp.Table || !string.IsNullOrWhiteSpace(item.InnerText));
            if (hasPriorContent)
            {
                heading.InsertBeforeSelf(new Wp.Paragraph(
                    new Wp.ParagraphProperties(CreateContinuousSection(
                        finalSection,
                        columnCount: 2,
                        includeDocumentStart: startPropertiesAvailable))));
                startPropertiesAvailable = false;
            }

            var properties = EnsureParagraphProperties(heading);
            properties.RemoveAllChildren<Wp.SectionProperties>();
            properties.AppendChild(CreateContinuousSection(
                finalSection,
                columnCount: 1,
                includeDocumentStart: startPropertiesAvailable));
            startPropertiesAvailable = false;
        }

        if (headings.Count == 0) return;
        finalSection.RemoveAllChildren<Wp.TitlePage>();
        finalSection.RemoveAllChildren<Wp.PageNumberType>();
    }

    /// <summary>复制页面和页眉页脚，仅替换连续分节的栏数。</summary>
    static Wp.SectionProperties CreateContinuousSection(
        Wp.SectionProperties source,
        int columnCount,
        bool includeDocumentStart)
    {
        var section = (Wp.SectionProperties)source.CloneNode(true);
        section.RemoveAllChildren<Wp.SectionType>();
        section.RemoveAllChildren<Wp.Columns>();
        if (!includeDocumentStart)
        {
            section.RemoveAllChildren<Wp.TitlePage>();
            section.RemoveAllChildren<Wp.PageNumberType>();
        }

        var pageSize = section.GetFirstChild<Wp.PageSize>();
        InsertBefore(section, new Wp.SectionType { Val = Wp.SectionMarkValues.Continuous }, pageSize);
        var titlePage = section.GetFirstChild<Wp.TitlePage>();
        InsertBefore(section, new Wp.Columns { ColumnCount = (short)columnCount, Space = "720" }, titlePage);
        return section;
    }

    static Wp.ParagraphBorders CreateParagraphBorders(
        string color,
        bool topOnly,
        bool sidesOnly,
        uint size = 6)
    {
        var borders = new Wp.ParagraphBorders();
        if (topOnly)
        {
            borders.AppendChild(new Wp.TopBorder { Val = Wp.BorderValues.Single, Color = color, Size = size, Space = 1U });
            return borders;
        }
        if (sidesOnly)
        {
            borders.Append(
                new Wp.LeftBorder { Val = Wp.BorderValues.Single, Color = color, Size = size, Space = 2U },
                new Wp.RightBorder { Val = Wp.BorderValues.Single, Color = color, Size = size, Space = 2U });
            return borders;
        }
        borders.Append(
            new Wp.TopBorder { Val = Wp.BorderValues.Single, Color = color, Size = size, Space = 1U },
            new Wp.LeftBorder { Val = Wp.BorderValues.Single, Color = color, Size = size, Space = 2U },
            new Wp.BottomBorder { Val = Wp.BorderValues.Single, Color = color, Size = size, Space = 1U },
            new Wp.RightBorder { Val = Wp.BorderValues.Single, Color = color, Size = size, Space = 2U });
        return borders;
    }

    static void InsertBefore<T>(OpenXmlCompositeElement parent, T child, OpenXmlElement? anchor)
        where T : OpenXmlElement
    {
        if (anchor is null) parent.AppendChild(child);
        else parent.InsertBefore(child, anchor);
    }

    static T CreateTableBorder<T>(string color, uint size) where T : Wp.BorderType, new()
    {
        return new T
        {
            Val = size == 0 ? Wp.BorderValues.Nil : Wp.BorderValues.Single,
            Color = color,
            Size = size,
        };
    }

    static void SetSingleChild<T>(OpenXmlCompositeElement parent, T child) where T : OpenXmlElement
    {
        parent.RemoveAllChildren<T>();
        parent.AddChild(child, throwOnError: true);
    }

    static T AddChild<T>(OpenXmlCompositeElement parent, T child) where T : OpenXmlElement
    {
        parent.AddChild(child, throwOnError: true);
        return child;
    }

    static Wp.JustificationValues Alignment(string value)
    {
        return value switch
        {
            "居中对齐" => Wp.JustificationValues.Center,
            "右对齐" => Wp.JustificationValues.Right,
            "两端对齐" => Wp.JustificationValues.Both,
            _ => Wp.JustificationValues.Left,
        };
    }

    static string Color(string value, string fallback)
    {
        var normalized = (value ?? "").Trim().TrimStart('#');
        return normalized.Length == 6 && normalized.All(Uri.IsHexDigit)
            ? normalized.ToUpperInvariant()
            : fallback;
    }

    static int FontHalfPoints(string size)
    {
        return Math.Max(1, (int)Math.Round((ChineseFontSizes.TryGetValue(size, out var points) ? points : 12) * 2));
    }

    static int CharsToTwips(double chars, int halfPoints)
    {
        return Math.Max(0, (int)Math.Round(chars * Math.Max(1, halfPoints) * 10));
    }

    static int CmToTwips(double value) => Math.Max(0, (int)Math.Round(value * 567));

    /// <summary>不钳制符号的 cm→twips。装饰上的文字要贴到页边，缩进必须能取负值。</summary>
    static int CmToTwipsSigned(double value) => (int)Math.Round(value * 567);

    static long CmToEmu(double value) => (long)Math.Round(value * 360000);

    /// <summary>纸张尺寸，单位 cm，已按横纵向交换。</summary>
    static (double Width, double Height) ResolvePaperSize(FormatReader format)
    {
        var page = format.Section("page");
        var paper = PaperSizes.TryGetValue(format.Text(page, "paper_size", "a4"), out var found)
            ? found
            : PaperSizes["a4"];
        var landscape = format.Text(page, "orientation", "portrait") == "landscape";
        return landscape
            ? (paper.Height / 10.0, paper.Width / 10.0)
            : (paper.Width / 10.0, paper.Height / 10.0);
    }
    static int MmToTwips(double value) => Math.Max(1, (int)Math.Round(value * 56.7));

    /// <summary>按模板占位符将标题层级计数格式化为显示编号。</summary>
    static string FormatHeadingNumber(IReadOnlyList<int> rawParts, JsonElement heading)
    {
        var parts = rawParts.Where(item => item > 0).ToArray();
        if (parts.Length == 0) return "";
        var format = FormatReader.GetText(heading, "numbering_format", "custom");
        if (format == "outline-decimal") return string.Join('.', parts);
        if (format != "custom") return "";

        var last = parts[^1];
        var result = FormatReader.GetText(heading, "numbering_template", "");
        for (var level = 1; level <= 6; level += 1)
        {
            var tail = level <= parts.Length ? string.Join('.', parts[(level - 1)..]) : "";
            result = result.Replace($"{{tail{level}}}", tail, StringComparison.Ordinal);
        }
        var genericTail = parts.Length >= 3 ? string.Join('.', parts[2..]) : last.ToString(CultureInfo.InvariantCulture);
        return result
            .Replace("{zh}", NumberToChinese(last), StringComparison.Ordinal)
            .Replace("{num}", last.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal)
            .Replace("{tail}", genericTail, StringComparison.Ordinal)
            .Replace("{full}", string.Join('.', parts), StringComparison.Ordinal)
            .Replace("{circled}", NumberToCircled(last), StringComparison.Ordinal)
            .Replace("{alpha}", NumberToAlpha(last, false), StringComparison.Ordinal)
            .Replace("{ALPHA}", NumberToAlpha(last, true), StringComparison.Ordinal)
            .Replace("{roman}", NumberToRoman(last, false), StringComparison.Ordinal)
            .Replace("{ROMAN}", NumberToRoman(last, true), StringComparison.Ordinal)
            .Trim();
    }

    static bool NeedsSpace(string value)
    {
        return value.Length > 0 && !"、，。；：）)】]》〉".Contains(value[^1]);
    }

    static string NumberToChinese(int value)
    {
        string[] digits = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
        value = Math.Clamp(value, 1, 9999);
        if (value < 10) return digits[value];
        if (value < 20) return $"十{(value == 10 ? "" : digits[value - 10])}";
        if (value < 100) return $"{digits[value / 10]}十{digits[value % 10]}";
        if (value < 1000)
        {
            var rest = value % 100;
            return $"{digits[value / 100]}百{(rest == 0 ? "" : rest < 10 ? $"零{digits[rest]}" : NumberToChinese(rest))}";
        }
        var remainder = value % 1000;
        return $"{digits[value / 1000]}千{(remainder == 0 ? "" : remainder < 100 ? $"零{NumberToChinese(remainder)}" : NumberToChinese(remainder))}";
    }

    static string NumberToCircled(int value)
    {
        string[] values = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];
        return value is >= 1 and <= 20 ? values[value - 1] : value.ToString(CultureInfo.InvariantCulture);
    }

    static string NumberToAlpha(int value, bool upper)
    {
        var number = Math.Max(1, value);
        var result = "";
        while (number > 0)
        {
            number -= 1;
            result = (char)('a' + number % 26) + result;
            number /= 26;
        }
        return upper ? result.ToUpperInvariant() : result;
    }

    static string NumberToRoman(int value, bool upper)
    {
        (int Value, string Text)[] pairs =
        [
            (1000, "m"), (900, "cm"), (500, "d"), (400, "cd"),
            (100, "c"), (90, "xc"), (50, "l"), (40, "xl"),
            (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i"),
        ];
        var number = Math.Clamp(value, 1, 3999);
        var result = "";
        foreach (var pair in pairs)
        {
            while (number >= pair.Value)
            {
                result += pair.Text;
                number -= pair.Value;
            }
        }
        return upper ? result.ToUpperInvariant() : result;
    }

    sealed record PreparedHtml(IDocument Document, IReadOnlyList<TableSpec> Tables);
    sealed record TableSpec(IReadOnlyList<TableRowSpec> Rows);
    sealed record TableRowSpec(bool IsHeaderRow, IReadOnlyList<CellRole> Cells);
    enum CellRole { Header, FirstColumn, Body }

    /// <summary>轻量读取前端 export_format，缺项时使用当前默认模板值。</summary>
    sealed class FormatReader
    {
        public FormatReader(JsonElement root)
        {
            Root = root.Clone();
        }

        public JsonElement Root { get; }

        public JsonElement Section(string name) => Child(Root, name);

        public JsonElement Heading(int level)
        {
            if (!Root.TryGetProperty("headings", out var headings)
                || headings.ValueKind != JsonValueKind.Array
                || level < 1
                || level > headings.GetArrayLength())
            {
                return default;
            }
            return headings[level - 1];
        }

        public JsonElement Child(JsonElement parent, string name)
        {
            return parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var value)
                ? value
                : default;
        }

        public string Text(JsonElement parent, string name, string fallback) => GetText(parent, name, fallback);

        public static string GetText(JsonElement parent, string name, string fallback)
        {
            return parent.ValueKind == JsonValueKind.Object
                && parent.TryGetProperty(name, out var value)
                && value.ValueKind == JsonValueKind.String
                    ? value.GetString() ?? fallback
                    : fallback;
        }

        public double Number(JsonElement parent, string name, double fallback)
        {
            return parent.ValueKind == JsonValueKind.Object
                && parent.TryGetProperty(name, out var value)
                && value.ValueKind == JsonValueKind.Number
                && value.TryGetDouble(out var number)
                    ? number
                    : fallback;
        }

        public int Integer(JsonElement parent, string name, int fallback)
        {
            return parent.ValueKind == JsonValueKind.Object
                && parent.TryGetProperty(name, out var value)
                && value.ValueKind == JsonValueKind.Number
                && value.TryGetInt32(out var number)
                    ? number
                    : fallback;
        }

        public bool Bool(JsonElement parent, string name, bool fallback)
        {
            if (parent.ValueKind != JsonValueKind.Object || !parent.TryGetProperty(name, out var value)) return fallback;
            return value.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => fallback,
            };
        }

        public string ArrayText(JsonElement parent, string name, int index, string fallback)
        {
            if (parent.ValueKind != JsonValueKind.Object
                || !parent.TryGetProperty(name, out var values)
                || values.ValueKind != JsonValueKind.Array
                || index < 0
                || index >= values.GetArrayLength()
                || values[index].ValueKind != JsonValueKind.String)
            {
                return fallback;
            }
            return values[index].GetString() ?? fallback;
        }
    }
}
