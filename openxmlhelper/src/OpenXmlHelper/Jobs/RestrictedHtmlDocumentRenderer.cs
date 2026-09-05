using System.Globalization;
using System.Text.Json;
using AngleSharp.Dom;
using AngleSharp.Html.Parser;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
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
    public static RenderResult Render(string assetRoot, string outputPath, string html, JsonElement exportFormat)
    {
        var format = new FormatReader(exportFormat);
        var prepared = PrepareHtml(html, format);
        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
        if (File.Exists(outputPath)) File.Delete(outputPath);

        using var document = WordprocessingDocument.Create(outputPath, WordprocessingDocumentType.Document);
        CreateSkeleton(document, format);
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
    static void CreateSkeleton(WordprocessingDocument document, FormatReader format)
    {
        var mainPart = document.AddMainDocumentPart();
        AddStyles(mainPart, format);
        AddDocumentSettings(mainPart);

        var section = CreateSectionProperties(mainPart, format);
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
                new Wp.StyleParagraphProperties(CreateSpacing(
                    format.Number(body, "spacing_before_pt", 0),
                    format.Number(body, "spacing_after_pt", 0),
                    format.Number(body, "line_spacing_multiple", 1.2))),
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
    static Wp.SectionProperties CreateSectionProperties(MainDocumentPart mainPart, FormatReader format)
    {
        var page = format.Section("page");
        var paper = PaperSizes.TryGetValue(format.Text(page, "paper_size", "a4"), out var found)
            ? found
            : PaperSizes["a4"];
        var landscape = format.Text(page, "orientation", "portrait") == "landscape";
        var width = MmToTwips(landscape ? paper.Height : paper.Width);
        var height = MmToTwips(landscape ? paper.Width : paper.Height);
        var section = new Wp.SectionProperties();

        AddHeaderReferences(mainPart, section, format);
        AddFooterReferences(mainPart, section, format);
        section.Append(
            new Wp.PageSize
            {
                Width = (uint)width,
                Height = (uint)height,
                Orient = landscape ? Wp.PageOrientationValues.Landscape : Wp.PageOrientationValues.Portrait,
            },
            new Wp.PageMargin
            {
                Top = CmToTwips(format.Number(page, "margin_top_cm", 2)),
                Bottom = CmToTwips(format.Number(page, "margin_bottom_cm", 2)),
                Left = (uint)CmToTwips(format.Number(page, "margin_left_cm", 2)),
                Right = (uint)CmToTwips(format.Number(page, "margin_right_cm", 2)),
                Header = (uint)CmToTwips(1.25),
                Footer = (uint)CmToTwips(format.Number(page, "footer_distance_cm", 1.75)),
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
        FormatReader format)
    {
        var page = format.Section("page");
        if (!format.Bool(page, "header_enabled", false)) return;

        var headerPart = mainPart.AddNewPart<HeaderPart>();
        headerPart.Header = new Wp.Header(CreateHeaderParagraph(format));
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

    /// <summary>创建默认页脚；页码和页脚文字共用同一段落。</summary>
    static void AddFooterReferences(
        MainDocumentPart mainPart,
        Wp.SectionProperties section,
        FormatReader format)
    {
        var page = format.Section("page");
        var footerEnabled = format.Bool(page, "footer_enabled", false);
        var pageNumberEnabled = format.Bool(page, "page_number_enabled", false);
        if (!footerEnabled && !pageNumberEnabled) return;

        var footerPart = mainPart.AddNewPart<FooterPart>();
        footerPart.Footer = new Wp.Footer(CreateFooterParagraph(format));
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

    /// <summary>使用 Word 原生底纹与边框呈现各类页眉样式。</summary>
    static Wp.Paragraph CreateHeaderParagraph(FormatReader format)
    {
        var page = format.Section("page");
        var style = NormalizeChromeStyle(format.Text(page, "header_footer_style", "plain"));
        var bar = Color(format.Text(page, "chrome_bar_color", "#e8eef5"), "E8EEF5");
        var accent = Color(format.Text(page, "chrome_accent_color", "#536176"), "536176");
        var textColor = style switch
        {
            "band" or "slant" => ContrastColor(bar),
            "top-bar" => ContrastColor(accent),
            _ => Color(format.Text(page, "header_color", "#536176"), "536176"),
        };
        var text = format.Text(page, "header_text", "").Trim();
        var badge = format.Text(page, "header_badge_text", "").Trim();
        if (badge.Length > 4) badge = badge[..4];
        if (badge.Length > 0 && style != "plain") text = $"{badge}    {text}";

        var properties = new Wp.ParagraphProperties(
            new Wp.SpacingBetweenLines { Before = "0", After = "80", Line = "240", LineRule = Wp.LineSpacingRuleValues.Auto },
            new Wp.Justification { Val = Alignment(format.Text(page, "header_alignment", "居中对齐")) });
        ApplyChrome(properties, style, bar, accent, top: false);
        return new Wp.Paragraph(
            properties,
            CreateRun(
                text,
                format.Text(page, "header_font", "宋体"),
                FontHalfPoints(format.Text(page, "header_size", "小五")),
                textColor,
                style is "band" or "top-bar" or "slant",
                false));
    }

    /// <summary>创建带可刷新 PAGE 域的页脚段落。</summary>
    static Wp.Paragraph CreateFooterParagraph(FormatReader format)
    {
        var page = format.Section("page");
        var style = NormalizeChromeStyle(format.Text(page, "header_footer_style", "plain"));
        var bar = Color(format.Text(page, "chrome_bar_color", "#e8eef5"), "E8EEF5");
        var accent = Color(format.Text(page, "chrome_accent_color", "#536176"), "536176");
        var textColor = style switch
        {
            "band" or "slant" => ContrastColor(bar),
            "top-bar" or "footer-badge" => ContrastColor(accent),
            _ => Color(format.Text(page, "footer_color", "#536176"), "536176"),
        };
        var font = format.Text(page, "footer_font", "宋体");
        var size = FontHalfPoints(format.Text(page, "footer_size", "小五"));
        var properties = new Wp.ParagraphProperties(
            new Wp.SpacingBetweenLines { Before = "80", After = "0", Line = "240", LineRule = Wp.LineSpacingRuleValues.Auto },
            new Wp.Justification { Val = Alignment(format.Text(page, "footer_alignment", "居中对齐")) });
        ApplyChrome(properties, style, bar, accent, top: true);
        var paragraph = new Wp.Paragraph(properties);

        if (format.Bool(page, "footer_enabled", false))
        {
            var footerText = format.Text(page, "footer_text", "").Trim();
            if (footerText.Length > 0) paragraph.AppendChild(CreateRun(footerText, font, size, textColor, false, false));
        }
        if (format.Bool(page, "footer_enabled", false) && format.Bool(page, "page_number_enabled", false))
        {
            paragraph.AppendChild(CreateRun("    ", font, size, textColor, false, false));
        }
        if (format.Bool(page, "page_number_enabled", false))
        {
            AppendPageNumber(
                paragraph,
                format.Text(page, "page_number_format", "第{page}页"),
                format.Integer(page, "page_number_pad", 0),
                font,
                size,
                textColor);
        }
        if (!paragraph.Elements<Wp.Run>().Any()) paragraph.AppendChild(new Wp.Run(new Wp.Text("")));
        return paragraph;
    }

    /// <summary>按当前装饰主题为页眉页脚段落增加底纹或分隔线。</summary>
    static void ApplyChrome(Wp.ParagraphProperties properties, string style, string bar, string accent, bool top)
    {
        var anchor = properties.GetFirstChild<Wp.SpacingBetweenLines>();
        if (style == "band")
        {
            InsertBefore(properties, new Wp.Shading { Val = Wp.ShadingPatternValues.Clear, Fill = bar }, anchor);
            return;
        }
        if (style == "top-bar")
        {
            InsertBefore(properties, CreateHorizontalBorders(accent, top ? 14U : 6U, top ? 6U : 14U), anchor);
            InsertBefore(properties, new Wp.Shading { Val = Wp.ShadingPatternValues.Clear, Fill = accent }, anchor);
            return;
        }
        if (style == "slant")
        {
            InsertBefore(properties, CreateSideBorder(accent, left: !top, size: 24), anchor);
            InsertBefore(properties, new Wp.Shading { Val = Wp.ShadingPatternValues.Clear, Fill = bar }, anchor);
            return;
        }
        if (style == "footer-badge")
        {
            InsertBefore(properties, CreateHorizontalBorders(accent, top ? 12U : 0U, top ? 0U : 12U), anchor);
            InsertBefore(properties, new Wp.Shading { Val = Wp.ShadingPatternValues.Clear, Fill = top ? accent : bar }, anchor);
            return;
        }
        if (style == "letterhead")
        {
            InsertBefore(properties, CreateSideBorder(accent, left: !top, size: 20), anchor);
            return;
        }
        if (style == "frame")
        {
            InsertBefore(properties, CreateParagraphBorders(accent, topOnly: false, sidesOnly: false, size: 8), anchor);
            return;
        }
        if (style == "rules")
        {
            InsertBefore(properties, CreateHorizontalBorders(accent, top ? 12U : 5U, top ? 5U : 12U), anchor);
        }
    }

    /// <summary>把格式字符串中的 {page} 替换为 Word 页码域。</summary>
    static void AppendPageNumber(
        Wp.Paragraph paragraph,
        string format,
        int pad,
        string font,
        int size,
        string color)
    {
        if (format.Length == 0) format = "第{page}页";
        var markerIndex = format.IndexOf("{page}", StringComparison.Ordinal);
        if (markerIndex < 0)
        {
            paragraph.AppendChild(CreateRun(format, font, size, color, false, false));
            return;
        }
        var prefix = format[..markerIndex];
        var suffix = format[(markerIndex + 6)..];
        if (prefix.Length > 0) paragraph.AppendChild(CreateRun(prefix, font, size, color, false, false));

        paragraph.AppendChild(CreateFieldRun(Wp.FieldCharValues.Begin, font, size, color));
        var picture = pad > 0 ? $" \\# \"{new string('0', Math.Clamp(pad, 1, 6))}\"" : "";
        var codeRun = CreateRun($" PAGE{picture} ", font, size, color, false, false);
        var codeText = codeRun.GetFirstChild<Wp.Text>();
        if (codeText is not null)
        {
            codeText.Remove();
            codeRun.AppendChild(new Wp.FieldCode($" PAGE{picture} ") { Space = SpaceProcessingModeValues.Preserve });
        }
        paragraph.AppendChild(codeRun);
        paragraph.AppendChild(CreateFieldRun(Wp.FieldCharValues.Separate, font, size, color));
        paragraph.AppendChild(CreateRun(pad > 0 ? new string('0', Math.Clamp(pad, 1, 6)) : "1", font, size, color, false, false));
        paragraph.AppendChild(CreateFieldRun(Wp.FieldCharValues.End, font, size, color));
        if (suffix.Length > 0) paragraph.AppendChild(CreateRun(suffix, font, size, color, false, false));
    }

    static Wp.Run CreateFieldRun(Wp.FieldCharValues type, string font, int size, string color)
    {
        var run = CreateRun("", font, size, color, false, false);
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
        ApplyTwoColumnHeadingSections(mainPart, content, format);
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
        ApplyHeadingBorder(properties, format, level);
        ApplyRuns(
            paragraph,
            format.Text(heading, "font", level <= 5 ? "黑体" : "宋体"),
            halfPoints,
            Color(format.Text(heading, "text_color", "#243048"), "243048"),
            format.Bool(heading, "bold", false),
            null);
    }

    /// <summary>章节边框用原生段落边框和底纹表达，保证编辑器与 Word 一致。</summary>
    static void ApplyHeadingBorder(Wp.ParagraphProperties properties, FormatReader format, int level)
    {
        properties.RemoveAllChildren<Wp.ParagraphBorders>();
        properties.RemoveAllChildren<Wp.Shading>();
        var border = format.Section("heading_border");
        if (!format.Bool(border, "enabled", false)) return;

        var color = Color(format.Text(border, "border_color", "#cfd8ee"), "CFD8EE");
        var fill = Color(format.ArrayText(border, "level_cell_colors", level - 1, "#ffffff"), "FFFFFF");
        var leftOnly = format.Text(border, "structure", "上下结构") == "左右结构"
            || (format.Bool(border, "min_heading_left_enabled", false) && level >= 3);
        SetSingleChild(properties, CreateParagraphBorders(color, topOnly: false, sidesOnly: leftOnly, size: 8));
        SetSingleChild(properties, new Wp.Shading { Val = Wp.ShadingPatternValues.Clear, Fill = fill });
    }

    /// <summary>应用正文格式；列表保留编号缩进，不再使用首行缩进。</summary>
    static void ApplyBody(Wp.Paragraph paragraph, FormatReader format, bool isList)
    {
        var body = format.Section("body_text");
        var halfPoints = FontHalfPoints(format.Text(body, "size", "小四"));
        SetParagraphLayout(
            paragraph,
            Alignment(format.Text(body, "alignment", "左对齐")),
            format.Number(body, "spacing_before_pt", 0),
            format.Number(body, "spacing_after_pt", 0),
            format.Number(body, "line_spacing_multiple", 1.2),
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
                SetSingleChild(rowProperties, new Wp.CantSplit());
                rowProperties.RemoveAllChildren<Wp.TableHeader>();
                if (spec is not null && rowIndex < spec.Rows.Count && spec.Rows[rowIndex].IsHeaderRow)
                {
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
        properties.AppendChild(new Wp.TableWidth
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
                0,
                4,
                format.Number(format.Section("body_text"), "line_spacing_multiple", 1.2),
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

        foreach (var abstractNumber in numbering.Elements<Wp.AbstractNum>())
        {
            foreach (var level in abstractNumber.Elements<Wp.Level>())
            {
                var levelIndex = Math.Clamp(level.LevelIndex?.Value ?? 0, 0, 8);
                var currentFormat = level.GetFirstChild<Wp.NumberingFormat>()?.Val?.Value;
                var unordered = currentFormat == Wp.NumberFormatValues.Bullet;
                if (unordered) ApplyUnorderedLevel(level, format.Text(body, "list_style", "disc"), halfPoints);
                else ApplyOrderedLevel(level, format.Text(body, "ordered_list_style", "decimal-dot"), levelIndex);

                var left = CharsToTwips(indentChars * (levelIndex + 1), halfPoints);
                var hanging = Math.Min(left, CharsToTwips(1, halfPoints));
                var paragraphProperties = level.GetFirstChild<Wp.PreviousParagraphProperties>()
                    ?? AddChild(level, new Wp.PreviousParagraphProperties());
                SetSingleChild(paragraphProperties, new Wp.Indentation
                {
                    Left = left.ToString(CultureInfo.InvariantCulture),
                    Hanging = hanging.ToString(CultureInfo.InvariantCulture),
                });
            }
        }
        numbering.Save();
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
        var properties = EnsureParagraphProperties(paragraph);
        SetSingleChild(properties, new Wp.Justification { Val = alignment });
        SetSingleChild(properties, CreateSpacing(beforePoints, afterPoints, lineMultiple));
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

    static Wp.ParagraphBorders CreateHorizontalBorders(string color, uint topSize, uint bottomSize)
    {
        var borders = new Wp.ParagraphBorders();
        if (topSize > 0)
        {
            borders.AppendChild(new Wp.TopBorder
            {
                Val = Wp.BorderValues.Single,
                Color = color,
                Size = topSize,
                Space = 1U,
            });
        }
        if (bottomSize > 0)
        {
            borders.AppendChild(new Wp.BottomBorder
            {
                Val = Wp.BorderValues.Single,
                Color = color,
                Size = bottomSize,
                Space = 1U,
            });
        }
        return borders;
    }

    static Wp.ParagraphBorders CreateSideBorder(string color, bool left, uint size)
    {
        return left
            ? new Wp.ParagraphBorders(new Wp.LeftBorder
            {
                Val = Wp.BorderValues.Single,
                Color = color,
                Size = size,
                Space = 3U,
            })
            : new Wp.ParagraphBorders(new Wp.RightBorder
            {
                Val = Wp.BorderValues.Single,
                Color = color,
                Size = size,
                Space = 3U,
            });
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

    static string NormalizeChromeStyle(string value)
    {
        if (value == "spine") return "letterhead";
        if (value == "seal") return "frame";
        return value is "band" or "rules" or "top-bar" or "footer-badge" or "slant" or "letterhead" or "frame"
            ? value
            : "plain";
    }

    static string Color(string value, string fallback)
    {
        var normalized = (value ?? "").Trim().TrimStart('#');
        return normalized.Length == 6 && normalized.All(Uri.IsHexDigit)
            ? normalized.ToUpperInvariant()
            : fallback;
    }

    static string ContrastColor(string color)
    {
        if (color.Length != 6) return "FFFFFF";
        var red = int.Parse(color[..2], NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        var green = int.Parse(color[2..4], NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        var blue = int.Parse(color[4..], NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        return (red * 299 + green * 587 + blue * 114) / 1000 < 160 ? "FFFFFF" : "111111";
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
