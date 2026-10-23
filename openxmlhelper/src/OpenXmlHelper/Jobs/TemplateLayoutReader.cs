using System.Globalization;
using System.Text.Json.Serialization;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

sealed class TemplateLayoutFile
{
    public int Version { get; set; } = 1;
    /// <summary>正文默认字号（磅），段落 size 与之不同时才输出。</summary>
    [JsonPropertyName("base_size")]
    public double BaseSize { get; set; }
    public List<TemplateLayoutBlock> Blocks { get; set; } = [];
}

/// <summary>版式块：type 为 paragraph、table 或 field（块级字段控件）；顶层块带正文顶层块序号 index。</summary>
sealed class TemplateLayoutBlock
{
    public string Type { get; set; } = "paragraph";
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Index { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Align { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public TemplateLayoutIndent? Indent { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Heading { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Label { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? Size { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<TemplateLayoutSegment>? Segments { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<double>? Columns { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Borders { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<TemplateLayoutRow>? Rows { get; set; }
    [JsonPropertyName("field_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? FieldId { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<TemplateLayoutBlock>? Blocks { get; set; }
}

/// <summary>缩进以 em 计：first_line 为首行缩进（悬挂缩进为负），left 为左缩进。</summary>
sealed class TemplateLayoutIndent
{
    [JsonPropertyName("first_line")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? FirstLine { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? Left { get; set; }
}

sealed class TemplateLayoutRow
{
    public List<TemplateLayoutCell> Cells { get; set; } = [];
}

sealed class TemplateLayoutCell
{
    [JsonPropertyName("col_span")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? ColSpan { get; set; }
    [JsonPropertyName("row_span")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? RowSpan { get; set; }
    /// <summary>只在单元格四边都显式去掉边框时写 false。</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Borders { get; set; }
    public List<TemplateLayoutBlock> Blocks { get; set; } = [];
}

/// <summary>段落片段：文字（可带加粗、下划线）、行内字段控件、换行或制表位，四者互斥。</summary>
sealed class TemplateLayoutSegment
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Text { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Bold { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Underline { get; set; }
    [JsonPropertyName("field_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? FieldId { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Break { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Tab { get; set; }
}

/// <summary>
/// 把投标模版读成供确认弹窗还原表单的版式：段落保留对齐、缩进、编号、加粗、下划线和字号，表格保留列宽、合并单元格和有无边框，
/// 字段内容控件只输出字段 ID。文本框段落放在宿主段落之后；图片、分页、分节和 mc:Fallback 不输出。
/// </summary>
sealed class TemplateLayoutReader
{
    const double DefaultFontSize = 10;

    readonly IReadOnlyDictionary<string, Wp.Style> _styles;
    readonly IReadOnlyDictionary<string, int> _styleOutlineLevels;
    readonly TemplateLayoutNumbering _numbering;
    readonly string? _defaultParagraphStyleId;
    readonly Wp.RunPropertiesBaseStyle? _defaultRunProperties;
    readonly double _baseSize;

    TemplateLayoutReader(MainDocumentPart part)
    {
        _styles = part.StyleDefinitionsPart?.Styles?.Elements<Wp.Style>()
            .Where(style => !string.IsNullOrWhiteSpace(style.StyleId?.Value))
            .GroupBy(style => style.StyleId!.Value!, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal)
            ?? new Dictionary<string, Wp.Style>(StringComparer.Ordinal);
        _styleOutlineLevels = WordWorkspace.ReadStyleOutlineLevels(part);
        _numbering = new TemplateLayoutNumbering(part, _styles);
        _defaultParagraphStyleId = _styles.Values
            .FirstOrDefault(style => style.Type?.Value == Wp.StyleValues.Paragraph && style.Default?.Value == true)?.StyleId?.Value;
        _defaultRunProperties = part.StyleDefinitionsPart?.Styles?.DocDefaults?.RunPropertiesDefault?.RunPropertiesBaseStyle;
        _baseSize = ParseHalfPoints(ParagraphStyleChain(_defaultParagraphStyleId)
            .Select(style => style.StyleRunProperties?.FontSize?.Val?.Value)
            .FirstOrDefault(value => value is not null) ?? _defaultRunProperties?.FontSize?.Val?.Value) ?? DefaultFontSize;
    }

    public static TemplateLayoutFile Read(WordprocessingDocument document)
    {
        var part = document.MainDocumentPart ?? throw new InvalidOperationException("投标模版缺少正文部件");
        var body = part.Document.Body ?? throw new InvalidOperationException("投标模版正文为空");
        var reader = new TemplateLayoutReader(part);
        var result = new TemplateLayoutFile { BaseSize = reader._baseSize };
        var children = body.ChildElements.ToList();
        for (var index = 0; index < children.Count; index += 1)
        {
            foreach (var block in reader.ReadBlock(children[index]))
            {
                block.Index = index;
                result.Blocks.Add(block);
            }
        }
        return result;
    }

    IEnumerable<TemplateLayoutBlock> ReadBlock(OpenXmlElement element)
    {
        switch (element)
        {
            case Wp.Paragraph paragraph:
                return ReadParagraph(paragraph);
            case Wp.Table table:
                return [ReadTable(table)];
            case Wp.SdtBlock control:
                var content = control.SdtContentBlock?.ChildElements.SelectMany(ReadBlock).ToList() ?? [];
                return FieldIdOf(control) is { } fieldId
                    ? [new TemplateLayoutBlock { Type = "field", FieldId = fieldId, Blocks = content }]
                    : content;
            case Wp.CustomXmlBlock custom:
                return custom.ChildElements.SelectMany(ReadBlock).ToList();
            default:
                return [];
        }
    }

    List<TemplateLayoutBlock> ReadParagraph(Wp.Paragraph paragraph)
    {
        var segments = new List<TemplateLayoutSegment>();
        var textBoxes = new List<Wp.TextBoxContent>();
        ReadInline(paragraph, paragraph, segments, textBoxes);
        var blocks = new List<TemplateLayoutBlock>();
        var label = _numbering.Next(paragraph);
        // 只含分页、分节的段落不输出，避免表单中出现无意义的空白。
        var pageBreakOnly = segments.Count == 0 && label is null
            && paragraph.Descendants<Wp.Break>().Any(item => item.Type?.Value == Wp.BreakValues.Page);
        if (!pageBreakOnly && !(segments.Count == 0 && label is null && textBoxes.Count > 0))
        {
            var size = ParagraphSize(paragraph);
            blocks.Add(new TemplateLayoutBlock
            {
                Align = ResolveAlign(paragraph),
                Indent = ResolveIndent(paragraph, size),
                Heading = WordWorkspace.ReadOutlineLevel(paragraph, _styleOutlineLevels) < 9 || WordWorkspace.HasHeadingStyle(paragraph) ? true : null,
                Label = label,
                Size = Math.Abs(size - _baseSize) > 0.01 ? size : null,
                Segments = MergeSegments(segments),
            });
        }
        foreach (var textBox in textBoxes)
        {
            blocks.AddRange(textBox.ChildElements.SelectMany(ReadBlock));
        }
        return blocks;
    }

    /// <summary>按文档顺序收集段落内的文字、字段控件、换行和制表位；文本框只取 mc:Choice 中的内容。</summary>
    void ReadInline(OpenXmlElement container, Wp.Paragraph paragraph, List<TemplateLayoutSegment> segments, List<Wp.TextBoxContent> textBoxes)
    {
        foreach (var child in container.ChildElements)
        {
            switch (child)
            {
                case Wp.Run run:
                    ReadRun(run, paragraph, segments, textBoxes);
                    break;
                case Wp.SdtRun control when FieldIdOf(control) is { } fieldId:
                    segments.Add(new TemplateLayoutSegment { FieldId = fieldId });
                    break;
                case Wp.SdtRun control:
                    if (control.SdtContentRun is { } content) ReadInline(content, paragraph, segments, textBoxes);
                    break;
                case Wp.DeletedRun or Wp.ParagraphProperties:
                    break;
                case AlternateContent alternate:
                    if (alternate.GetFirstChild<AlternateContentChoice>() is { } choice) ReadInline(choice, paragraph, segments, textBoxes);
                    break;
                case Wp.Hyperlink or Wp.SimpleField or Wp.InsertedRun or Wp.CustomXmlRun or Wp.MoveToRun:
                    ReadInline(child, paragraph, segments, textBoxes);
                    break;
            }
        }
    }

    void ReadRun(Wp.Run run, Wp.Paragraph paragraph, List<TemplateLayoutSegment> segments, List<Wp.TextBoxContent> textBoxes)
    {
        var bold = ResolveBold(run, paragraph);
        var underline = run.RunProperties?.Underline?.Val?.Value is { } value && value != Wp.UnderlineValues.None;
        foreach (var child in run.ChildElements)
        {
            switch (child)
            {
                case Wp.Text text when text.Text.Length > 0:
                    segments.Add(new TemplateLayoutSegment { Text = text.Text, Bold = bold ? true : null, Underline = underline ? true : null });
                    break;
                case Wp.TabChar:
                    segments.Add(new TemplateLayoutSegment { Tab = true });
                    break;
                case Wp.Break item when item.Type?.Value is null || item.Type.Value == Wp.BreakValues.TextWrapping:
                    segments.Add(new TemplateLayoutSegment { Break = true });
                    break;
                case Wp.CarriageReturn:
                    segments.Add(new TemplateLayoutSegment { Break = true });
                    break;
                case Wp.NoBreakHyphen:
                    segments.Add(new TemplateLayoutSegment { Text = "-", Bold = bold ? true : null });
                    break;
                case AlternateContent alternate:
                    if (alternate.GetFirstChild<AlternateContentChoice>() is { } choice) CollectTextBoxes(choice, textBoxes);
                    break;
                case Wp.Drawing or Wp.Picture:
                    CollectTextBoxes(child, textBoxes);
                    break;
            }
        }
    }

    /// <summary>只收集最外层的文本框，嵌套文本框随外层文本框的段落递归读取。</summary>
    static void CollectTextBoxes(OpenXmlElement root, List<Wp.TextBoxContent> textBoxes)
    {
        var contents = root.Descendants<Wp.TextBoxContent>()
            .Where(item => !item.Ancestors<AlternateContentFallback>().Any())
            .ToList();
        textBoxes.AddRange(contents.Where(item => !item.Ancestors<Wp.TextBoxContent>().Any(contents.Contains)));
    }

    /// <summary>合并相邻且格式相同的文字片段。</summary>
    static List<TemplateLayoutSegment> MergeSegments(List<TemplateLayoutSegment> segments)
    {
        var merged = new List<TemplateLayoutSegment>();
        foreach (var segment in segments)
        {
            var previous = merged.LastOrDefault();
            if (segment.Text is not null && previous?.Text is not null
                && previous.Bold == segment.Bold && previous.Underline == segment.Underline)
            {
                previous.Text += segment.Text;
                continue;
            }
            merged.Add(segment);
        }
        return merged;
    }

    TemplateLayoutBlock ReadTable(Wp.Table table)
    {
        var rows = TemplateFieldScanner.BuildTableRows(table);
        var gridWidths = table.GetFirstChild<Wp.TableGrid>()?.Elements<Wp.GridColumn>()
            .Select(column => double.TryParse(column.Width?.Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var width) ? Math.Max(width, 0) : 0)
            .ToList() ?? [];
        var columnCount = Math.Max(
            gridWidths.Count,
            rows.Select(row => row.Cells.Select(cell => cell.ColumnStart + cell.ColumnSpan).DefaultIfEmpty(0).Max()
                + (row.Row.TableRowProperties?.GetFirstChild<Wp.GridAfter>()?.Val?.Value ?? 0)).DefaultIfEmpty(0).Max());
        var widths = Enumerable.Range(0, columnCount).Select(index => index < gridWidths.Count && gridWidths[index] > 0 ? gridWidths[index] : 0).ToList();
        var known = widths.Where(width => width > 0).ToList();
        var fallbackWidth = known.Count > 0 ? known.Average() : 1;
        widths = widths.Select(width => width > 0 ? width : fallbackWidth).ToList();
        var total = widths.Sum();

        var layoutRows = new List<TemplateLayoutRow>();
        for (var rowIndex = 0; rowIndex < rows.Count; rowIndex += 1)
        {
            var row = rows[rowIndex];
            var layoutRow = new TemplateLayoutRow();
            var gridBefore = row.Row.TableRowProperties?.GetFirstChild<Wp.GridBefore>()?.Val?.Value ?? 0;
            if (gridBefore > 0) layoutRow.Cells.Add(new TemplateLayoutCell { ColSpan = gridBefore > 1 ? gridBefore : null, Borders = false });
            foreach (var cell in row.Cells)
            {
                var merge = cell.Cell.TableCellProperties?.VerticalMerge;
                // 纵向合并的续格并入起始格，不单独输出。
                if (merge is not null && merge.Val?.Value != Wp.MergedCellValues.Restart) continue;
                var rowSpan = merge is null ? 1 : 1 + CountMergedRows(rows, rowIndex, cell.ColumnStart);
                layoutRow.Cells.Add(new TemplateLayoutCell
                {
                    ColSpan = cell.ColumnSpan > 1 ? cell.ColumnSpan : null,
                    RowSpan = rowSpan > 1 ? rowSpan : null,
                    Borders = HasNoCellBorders(cell.Cell) ? false : null,
                    Blocks = cell.Cell.ChildElements.SelectMany(ReadBlock).ToList(),
                });
            }
            var gridAfter = row.Row.TableRowProperties?.GetFirstChild<Wp.GridAfter>()?.Val?.Value ?? 0;
            if (gridAfter > 0) layoutRow.Cells.Add(new TemplateLayoutCell { ColSpan = gridAfter > 1 ? gridAfter : null, Borders = false });
            layoutRows.Add(layoutRow);
        }

        return new TemplateLayoutBlock
        {
            Type = "table",
            Columns = widths.Select(width => Math.Round(width / total * 100, 2)).ToList(),
            Borders = HasTableBorders(table),
            Rows = layoutRows,
        };
    }

    static int CountMergedRows(List<TemplateFieldScanner.TableRowInfo> rows, int rowIndex, int columnStart)
    {
        var count = 0;
        for (var next = rowIndex + 1; next < rows.Count; next += 1)
        {
            var cell = rows[next].Cells.FirstOrDefault(item => item.ColumnStart == columnStart);
            var merge = cell?.Cell.TableCellProperties?.VerticalMerge;
            if (merge is null || merge.Val?.Value == Wp.MergedCellValues.Restart) break;
            count += 1;
        }
        return count;
    }

    /// <summary>WPS 常把边框写在每个单元格上而表格本身不设边框，任一单元格有可见边框也按有边框处理。</summary>
    bool HasTableBorders(Wp.Table table)
    {
        if (table.Elements<Wp.TableRow>().SelectMany(row => row.Elements<Wp.TableCell>())
            .Any(cell => cell.TableCellProperties?.TableCellBorders is { } cellBorders && HasVisibleBorder(cellBorders))) return true;
        if (table.GetFirstChild<Wp.TableProperties>()?.TableBorders is { } direct) return HasVisibleBorder(direct);
        var styleId = table.GetFirstChild<Wp.TableProperties>()?.TableStyle?.Val?.Value;
        var visited = new HashSet<string>(StringComparer.Ordinal);
        while (styleId is not null && visited.Add(styleId) && _styles.TryGetValue(styleId, out var style))
        {
            if (style.StyleTableProperties?.TableBorders is { } borders) return HasVisibleBorder(borders);
            styleId = style.BasedOn?.Val?.Value;
        }
        return false;
    }

    static bool HasVisibleBorder(OpenXmlElement borders)
    {
        return borders.ChildElements.OfType<Wp.BorderType>().Any(border => IsVisible(border.Val?.Value));
    }

    static bool HasNoCellBorders(Wp.TableCell cell)
    {
        var borders = cell.TableCellProperties?.TableCellBorders;
        if (borders is null) return false;
        Wp.BorderType?[] sides =
        [
            borders.TopBorder,
            borders.BottomBorder,
            (Wp.BorderType?)borders.LeftBorder ?? borders.StartBorder,
            (Wp.BorderType?)borders.RightBorder ?? borders.EndBorder,
        ];
        return sides.All(side => side is not null && !IsVisible(side.Val?.Value));
    }

    static bool IsVisible(Wp.BorderValues? value)
    {
        return value is not null && value != Wp.BorderValues.None && value != Wp.BorderValues.Nil;
    }

    string? ResolveAlign(Wp.Paragraph paragraph)
    {
        var value = paragraph.ParagraphProperties?.Justification?.Val?.Value
            ?? ParagraphStyleChain(ParagraphStyleId(paragraph))
                .Select(style => style.StyleParagraphProperties?.Justification?.Val?.Value)
                .FirstOrDefault(item => item is not null);
        if (value is null) return null;
        if (value == Wp.JustificationValues.Center) return "center";
        if (value == Wp.JustificationValues.Right || value == Wp.JustificationValues.End) return "right";
        if (value == Wp.JustificationValues.Both || value == Wp.JustificationValues.Distribute) return "justify";
        return null;
    }

    /// <summary>字符单位（百分之一字符）直接换算成 em；twips 按段落字号换算。悬挂缩进记为负的首行缩进。</summary>
    TemplateLayoutIndent? ResolveIndent(Wp.Paragraph paragraph, double size)
    {
        var indentation = paragraph.ParagraphProperties?.Indentation
            ?? ParagraphStyleChain(ParagraphStyleId(paragraph))
                .Select(style => style.StyleParagraphProperties?.Indentation)
                .FirstOrDefault(item => item is not null);
        if (indentation is null) return null;
        double? FromTwips(string? value) => double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var twips) ? twips / 20 / size : null;
        double? firstLine = indentation.FirstLineChars?.Value is int firstChars ? firstChars / 100.0
            : indentation.HangingChars?.Value is int hangingChars ? -hangingChars / 100.0
            : FromTwips(indentation.FirstLine?.Value) ?? -FromTwips(indentation.Hanging?.Value);
        double? left = indentation.LeftChars?.Value is int leftChars ? leftChars / 100.0
            : indentation.StartCharacters?.Value is int startChars ? startChars / 100.0
            : FromTwips(indentation.Left?.Value ?? indentation.Start?.Value);
        firstLine = firstLine is double first && Math.Abs(first) >= 0.05 ? Math.Round(first, 2) : null;
        left = left is double leftValue && Math.Abs(leftValue) >= 0.05 ? Math.Round(leftValue, 2) : null;
        return firstLine is null && left is null ? null : new TemplateLayoutIndent { FirstLine = firstLine, Left = left };
    }

    /// <summary>段落字号取第一个有文字的 run，没有文字时取段落标记，均按样式链解析。</summary>
    double ParagraphSize(Wp.Paragraph paragraph)
    {
        var run = paragraph.Descendants<Wp.Run>().FirstOrDefault(item => item.Elements<Wp.Text>().Any(text => text.Text.Trim().Length > 0)
            && !item.Ancestors<Wp.TextBoxContent>().Any());
        var direct = run?.RunProperties?.FontSize?.Val?.Value
            ?? (run is null ? paragraph.ParagraphProperties?.ParagraphMarkRunProperties?.GetFirstChild<Wp.FontSize>()?.Val?.Value : null);
        return ParseHalfPoints(direct
            ?? CharacterStyleChain(run?.RunProperties?.RunStyle?.Val?.Value).Select(style => style.StyleRunProperties?.FontSize?.Val?.Value).FirstOrDefault(value => value is not null)
            ?? ParagraphStyleChain(ParagraphStyleId(paragraph)).Select(style => style.StyleRunProperties?.FontSize?.Val?.Value).FirstOrDefault(value => value is not null)
            ?? _defaultRunProperties?.FontSize?.Val?.Value) ?? DefaultFontSize;
    }

    bool ResolveBold(Wp.Run run, Wp.Paragraph paragraph)
    {
        var bold = run.RunProperties?.Bold
            ?? CharacterStyleChain(run.RunProperties?.RunStyle?.Val?.Value).Select(style => style.StyleRunProperties?.Bold).FirstOrDefault(item => item is not null)
            ?? ParagraphStyleChain(ParagraphStyleId(paragraph)).Select(style => style.StyleRunProperties?.Bold).FirstOrDefault(item => item is not null)
            ?? _defaultRunProperties?.Bold;
        return bold is not null && (bold.Val?.Value ?? true);
    }

    string? ParagraphStyleId(Wp.Paragraph paragraph)
    {
        return paragraph.ParagraphProperties?.ParagraphStyleId?.Val?.Value ?? _defaultParagraphStyleId;
    }

    IEnumerable<Wp.Style> ParagraphStyleChain(string? styleId) => StyleChain(styleId);

    IEnumerable<Wp.Style> CharacterStyleChain(string? styleId) => StyleChain(styleId);

    IEnumerable<Wp.Style> StyleChain(string? styleId)
    {
        var visited = new HashSet<string>(StringComparer.Ordinal);
        while (styleId is not null && visited.Add(styleId) && _styles.TryGetValue(styleId, out var style))
        {
            yield return style;
            styleId = style.BasedOn?.Val?.Value;
        }
    }

    static double? ParseHalfPoints(string? value)
    {
        return double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var halfPoints) && halfPoints > 0
            ? halfPoints / 2
            : null;
    }

    static string? FieldIdOf(Wp.SdtElement control)
    {
        var tag = control.GetFirstChild<Wp.SdtProperties>()?.GetFirstChild<Wp.Tag>()?.Val?.Value ?? "";
        return tag.StartsWith(TemplateFieldSdtWriter.TagPrefix, StringComparison.Ordinal)
            ? tag[TemplateFieldSdtWriter.TagPrefix.Length..]
            : null;
    }
}
