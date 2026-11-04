using DocumentFormat.OpenXml;
using Yibiao.OpenXmlHelper.Ooxml;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>
/// 规则和页码：清单表按编制结果逐行处理，from 行原地填写该行的规则格（招标文件印好的内容不动），
/// like 行照该行的格式新增一行并按网格列写入各格；没被引用、只有规则格和序号的空行删除，印有内容的行保留。
/// 重建时以新表替换原表；表格位置换成新建表格。新表正文沿用模版默认段落样式，单线边框、表头加粗并在跨页时重复，分组行整行合并。
/// 哪些行保留、新增多少行、是否重建、各格写什么由规则和页码 Agent 决定，程序只按结果执行。
/// </summary>
static class RuleTableWriter
{
    const string Word2010Namespace = "http://schemas.microsoft.com/office/word/2010/wordml";
    const int DefaultContentWidthTwips = 9638;

    public static IReadOnlyList<OpenXmlElement> Fill(
        Wp.Body body,
        IReadOnlyDictionary<string, List<Wp.SdtElement>> controls,
        RuleTableFill table)
    {
        if (!string.IsNullOrWhiteSpace(table.Slot))
        {
            var control = Single(controls, table.Slot.Trim());
            if (control is not Wp.SdtBlock block)
            {
                throw new InvalidOperationException($"表格位置 {table.Slot} 不是块级内容控件");
            }
            var created = BuildTable(body, table);
            var content = block.SdtContentBlock ?? block.AppendChild(new Wp.SdtContentBlock());
            WordStructure.ReplaceContent(content, [created]);
            return [created];
        }
        var (ids, tableElement) = FindTable(controls, table);
        if (!table.Rebuild) return FillListTable(ids, tableElement, table);
        var rebuilt = BuildTable(body, table);
        WordStructure.Replace(tableElement, rebuilt);
        return [rebuilt];
    }

    /// <summary>规则字段所在的表格；字段须都在同一表格中。</summary>
    static (HashSet<string> Ids, Wp.Table Table) FindTable(IReadOnlyDictionary<string, List<Wp.SdtElement>> controls, RuleTableFill table)
    {
        var ids = (table.FieldIds ?? []).Select(item => (item ?? "").Trim()).Where(item => item.Length > 0).ToHashSet(StringComparer.Ordinal);
        if (ids.Count == 0) throw new InvalidOperationException("规则表缺少字段");
        var tables = ids
            .Select(id => Single(controls, id).Ancestors<Wp.TableRow>().FirstOrDefault()?.Parent as Wp.Table
                ?? throw new InvalidOperationException($"规则表字段 {id} 不在表格中"))
            .Distinct()
            .ToList();
        if (tables.Count != 1) throw new InvalidOperationException("规则表字段不在同一表格");
        return (ids, tables[0]);
    }

    /// <summary>
    /// 按结果顺序处理：from 行原地填写（须按行号递增）；like 行克隆该行，接在上一结果行之后，
    /// 所照的行位于上一结果行之后时放到所照行前面，使新增条目落在所照行所在的分段。克隆行去掉纵向合并。
    /// 只返回写入的文字，行和格子沿用模版原有标记，不交给校验。
    /// </summary>
    static IReadOnlyList<OpenXmlElement> FillListTable(HashSet<string> ids, Wp.Table tableElement, RuleTableFill table)
    {
        var rows = tableElement.Elements<Wp.TableRow>().ToList();
        var templates = rows.Select(row => (Wp.TableRow)row.CloneNode(true)).ToList();
        var used = new HashSet<int>();
        var written = new List<OpenXmlElement>();
        Wp.TableRow? cursor = null;
        // 上一结果行在原表中的位置：原地填写的行为其行号，插在第 N 行前的新增行为 N - 0.5。
        var cursorOrder = 0.0;
        var lastFrom = 0;
        foreach (var row in table.Rows)
        {
            if ((row.From is null) == (row.Like is null))
            {
                throw new InvalidOperationException("规则表每行须且只能给出 from 或 like");
            }
            var index = (row.From ?? row.Like)!.Value;
            if (index < 1 || index > rows.Count)
            {
                throw new InvalidOperationException($"规则表只有 {rows.Count} 行，引用了第 {index} 行，请重新编制规则和页码");
            }
            if (row.From is not null)
            {
                if (index <= lastFrom) throw new InvalidOperationException("规则表原地填写的行须按行号递增，请重新编制规则和页码");
                lastFrom = index;
                used.Add(index);
                var target = rows[index - 1];
                WriteCells(target, ids, row.Cells, inPlace: true, written);
                cursor = target;
                cursorOrder = index;
                continue;
            }
            var clone = (Wp.TableRow)templates[index - 1].CloneNode(true);
            RemoveRevisionIds(clone);
            // 克隆行里的书签会与样板行重名，去掉。
            WordStructure.RemoveBookmarks(clone.Descendants<Wp.BookmarkStart>().ToList());
            // 样板行若参与纵向合并，克隆会让合并错位，新增行一律不合并。
            foreach (var properties in clone.Elements<Wp.TableCell>().Select(cell => cell.TableCellProperties).OfType<Wp.TableCellProperties>())
            {
                WordStructure.RemoveChildren<Wp.VerticalMerge>(properties);
            }
            WriteCells(clone, ids, row.Cells, inPlace: false, written);
            if (cursor is null || index > cursorOrder)
            {
                rows[index - 1].InsertBeforeSelf(clone);
                cursorOrder = index - 0.5;
            }
            else
            {
                cursor.InsertAfterSelf(clone);
            }
            cursor = clone;
        }
        // 没被原地填写的行：带规则格、除规则格外没有原文（序号除外）的空行删除，印有内容的保留占位，交给用户处理。
        for (var index = 1; index <= rows.Count; index += 1)
        {
            if (used.Contains(index)) continue;
            var row = rows[index - 1];
            if (row.Descendants<Wp.SdtElement>().Any(control => ids.Contains(FieldId(control)))
                && IsBlankDataRow(row, ids)
                && !row.Descendants<Wp.VerticalMerge>().Any())
            {
                WordStructure.Remove(row);
            }
        }
        return written;
    }

    /// <summary>规则格以外只有数字、标点和空白（如序号）的数据行。</summary>
    static bool IsBlankDataRow(Wp.TableRow row, HashSet<string> ids)
    {
        var literal = string.Concat(row.Descendants<Wp.Text>()
            .Where(text => !text.Ancestors<Wp.SdtElement>().Any(control => ids.Contains(FieldId(control))))
            .Select(text => text.Text));
        return literal.All(item => char.IsWhiteSpace(item) || char.IsDigit(item) || char.IsPunctuation(item));
    }

    /// <summary>
    /// 按网格列写入格子：格内有规则控件时换成文字（多个控件时写入第一个，其余清空）；
    /// 没有规则控件的格子，原地填写时不动，新增行整格换成给定文字。
    /// </summary>
    static void WriteCells(Wp.TableRow row, HashSet<string> ids, IReadOnlyList<RuleTableCell> cells, bool inPlace, List<OpenXmlElement> written)
    {
        var cellsByColumn = new Dictionary<int, Wp.TableCell>();
        var column = row.TableRowProperties?.GetFirstChild<Wp.GridBefore>()?.Val?.Value ?? 0;
        foreach (var cell in row.Elements<Wp.TableCell>())
        {
            cellsByColumn[column] = cell;
            column += Math.Max(1, cell.TableCellProperties?.GridSpan?.Val?.Value ?? 1);
        }
        foreach (var item in cells)
        {
            if (!cellsByColumn.TryGetValue(item.Column, out var cell))
            {
                throw new InvalidOperationException($"规则表的行没有从第 {item.Column + 1} 列开始的单元格，请重新编制规则和页码");
            }
            var controls = cell.Descendants<Wp.SdtElement>().Where(control => ids.Contains(FieldId(control))).ToList();
            if (controls.Count > 0)
            {
                ReplaceControl(controls[0], item.Value, written);
                foreach (var extra in controls.Skip(1)) ReplaceControl(extra, "", written);
            }
            else if (!inPlace)
            {
                written.Add(SetCellText(cell, item.Value));
            }
        }
    }

    /// <summary>把单元格文字换成给定内容：沿用第一个文字所在 run 的格式，多行用换行；空单元格补一个 run。只保留第一段。</summary>
    static Wp.Run SetCellText(Wp.TableCell cell, string value)
    {
        var paragraphs = cell.Elements<Wp.Paragraph>().ToList();
        var paragraph = paragraphs.FirstOrDefault() ?? cell.AppendChild(new Wp.Paragraph());
        WordStructure.RemoveRange(paragraphs.Skip(1).ToList());
        var sourceRun = paragraph.Descendants<Wp.Run>().FirstOrDefault(run => run.Elements<Wp.Text>().Any()) ?? paragraph.Descendants<Wp.Run>().FirstOrDefault();
        var run = new Wp.Run();
        if (sourceRun?.RunProperties is not null) run.AppendChild((Wp.RunProperties)sourceRun.RunProperties.CloneNode(true));
        AppendLines(run, value);
        WordStructure.ClearContent(paragraph);
        return paragraph.AppendChild(run);
    }

    /// <summary>按 columns 和 rows 新建表格（表格位置和重建共用）：首行为表头，分组行整行合并。</summary>
    static Wp.Table BuildTable(Wp.Body body, RuleTableFill table)
    {
        if (table.Columns.Count == 0) throw new InvalidOperationException("规则表缺少列");
        if (table.Rows.Count == 0) throw new InvalidOperationException("新建的规则表没有行");
        if (table.Rows.Any(row => row.Group is null && row.Values.Count != table.Columns.Count))
        {
            throw new InvalidOperationException("规则表各行的单元格数必须与列数一致");
        }
        var columnWidth = ContentWidth(body) / table.Columns.Count;
        var result = new Wp.Table(
            new Wp.TableProperties(
                new Wp.TableWidth { Type = Wp.TableWidthUnitValues.Pct, Width = "5000" },
                new Wp.TableBorders(
                    new Wp.TopBorder { Val = Wp.BorderValues.Single, Size = 4U, Space = 0U, Color = "auto" },
                    new Wp.LeftBorder { Val = Wp.BorderValues.Single, Size = 4U, Space = 0U, Color = "auto" },
                    new Wp.BottomBorder { Val = Wp.BorderValues.Single, Size = 4U, Space = 0U, Color = "auto" },
                    new Wp.RightBorder { Val = Wp.BorderValues.Single, Size = 4U, Space = 0U, Color = "auto" },
                    new Wp.InsideHorizontalBorder { Val = Wp.BorderValues.Single, Size = 4U, Space = 0U, Color = "auto" },
                    new Wp.InsideVerticalBorder { Val = Wp.BorderValues.Single, Size = 4U, Space = 0U, Color = "auto" })),
            new Wp.TableGrid(table.Columns.Select(_ => new Wp.GridColumn { Width = columnWidth.ToString(System.Globalization.CultureInfo.InvariantCulture) })));
        var header = new Wp.TableRow(new Wp.TableRowProperties(new Wp.TableHeader()));
        foreach (var column in table.Columns) header.AppendChild(CreateCell(column, columnWidth, 1, header: true));
        result.AppendChild(header);
        foreach (var row in table.Rows)
        {
            var created = new Wp.TableRow();
            if (row.Group is not null) created.AppendChild(CreateCell(row.Group, columnWidth, table.Columns.Count, header: false, bold: true));
            else foreach (var value in row.Values) created.AppendChild(CreateCell(value, columnWidth, 1, header: false));
            result.AppendChild(created);
        }
        return result;
    }

    static Wp.TableCell CreateCell(string value, int columnWidth, int span, bool header, bool bold = false)
    {
        var paragraph = new Wp.Paragraph(new Wp.ParagraphProperties(
            // 模版正文常带首行缩进，表格内不缩进。
            new Wp.Indentation { Left = "0", FirstLine = "0", FirstLineChars = 0 },
            new Wp.Justification { Val = header ? Wp.JustificationValues.Center : Wp.JustificationValues.Left }));
        var run = header || bold ? new Wp.Run(new Wp.RunProperties(new Wp.Bold())) : new Wp.Run();
        AppendLines(run, value);
        paragraph.AppendChild(run);
        var properties = new Wp.TableCellProperties(
            new Wp.TableCellWidth { Type = Wp.TableWidthUnitValues.Dxa, Width = (columnWidth * span).ToString(System.Globalization.CultureInfo.InvariantCulture) });
        if (span > 1) properties.AppendChild(new Wp.GridSpan { Val = span });
        properties.AppendChild(new Wp.TableCellVerticalAlignment { Val = Wp.TableVerticalAlignmentValues.Center });
        return new Wp.TableCell(properties, paragraph);
    }

    /// <summary>规则字段换成文字：行内控件沿用占位格式（去掉淡红底），块级控件每行一段。</summary>
    static void ReplaceControl(Wp.SdtElement control, string value, List<OpenXmlElement> written)
    {
        var lines = SplitLines(value);
        var sourceRun = control.Descendants<Wp.Run>().FirstOrDefault();
        var replacements = new List<OpenXmlElement>();
        if (control is Wp.SdtBlock block)
        {
            var sourceParagraph = block.Descendants<Wp.Paragraph>().FirstOrDefault();
            foreach (var line in lines)
            {
                var paragraph = new Wp.Paragraph();
                if (sourceParagraph?.ParagraphProperties is not null)
                {
                    paragraph.AppendChild((Wp.ParagraphProperties)sourceParagraph.ParagraphProperties.CloneNode(true));
                }
                written.Add(paragraph.AppendChild(TemplateFieldSdtWriter.CreateValueRun([line], sourceRun)));
                replacements.Add(paragraph);
            }
        }
        else
        {
            var run = TemplateFieldSdtWriter.CreateValueRun(lines, sourceRun);
            written.Add(run);
            replacements.Add(run);
        }
        WordStructure.Replace(control, replacements);
    }

    static void AppendLines(Wp.Run run, string value)
    {
        var lines = SplitLines(value);
        for (var index = 0; index < lines.Count; index += 1)
        {
            if (index > 0) run.AppendChild(new Wp.Break());
            if (lines[index].Length > 0) run.AppendChild(new Wp.Text(lines[index]) { Space = SpaceProcessingModeValues.Preserve });
        }
    }

    static List<string> SplitLines(string? value) =>
        (value ?? "").Replace("\r\n", "\n").Replace('\r', '\n').Split('\n').ToList();

    static Wp.SdtElement Single(IReadOnlyDictionary<string, List<Wp.SdtElement>> controls, string id)
    {
        if (!controls.TryGetValue(id, out var matched))
        {
            throw new InvalidOperationException($"模版字段 {id} 不存在，请重新生成目录");
        }
        if (matched.Count != 1)
        {
            throw new InvalidOperationException($"模版字段 {id} 对应 {matched.Count} 个内容控件，请重新生成目录");
        }
        return matched[0];
    }

    static string FieldId(Wp.SdtElement control)
    {
        var tag = control.GetFirstChild<Wp.SdtProperties>()?.GetFirstChild<Wp.Tag>()?.Val?.Value ?? "";
        return tag.StartsWith(TemplateFieldSdtWriter.TagPrefix, StringComparison.Ordinal) ? tag[TemplateFieldSdtWriter.TagPrefix.Length..] : "";
    }

    /// <summary>克隆行去掉 w14:paraId / w14:textId，避免与原文重复，由 Word 重新生成。</summary>
    static void RemoveRevisionIds(OpenXmlElement root)
    {
        foreach (var element in root.Descendants().Prepend(root))
        {
            element.RemoveAttribute("paraId", Word2010Namespace);
            element.RemoveAttribute("textId", Word2010Namespace);
        }
    }

    /// <summary>新建表格的列宽按最后一节的版心宽度均分，表宽另以百分比铺满。</summary>
    static int ContentWidth(Wp.Body body)
    {
        var section = body.Elements<Wp.SectionProperties>().LastOrDefault();
        var pageWidth = (int?)section?.GetFirstChild<Wp.PageSize>()?.Width?.Value;
        var margin = section?.GetFirstChild<Wp.PageMargin>();
        if (pageWidth is not int width || margin is null) return DefaultContentWidthTwips;
        var content = width - (int)(margin.Left?.Value ?? 0U) - (int)(margin.Right?.Value ?? 0U);
        return content > 0 ? content : DefaultContentWidthTwips;
    }
}
