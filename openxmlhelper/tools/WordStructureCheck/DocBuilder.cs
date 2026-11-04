using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.WordStructureCheck;

/// <summary>构造最小测试文档的工具。</summary>
static class DocBuilder
{
    public static Paragraph P(string text) => new(new Run(new Text(text) { Space = SpaceProcessingModeValues.Preserve }));

    public static TableCell C(params OpenXmlElement[] content)
    {
        var cell = new TableCell(new TableCellProperties(new TableCellWidth { Width = "4000", Type = TableWidthUnitValues.Dxa }));
        foreach (var item in content) cell.AppendChild(item);
        return cell;
    }

    public static TableRow R(params TableCell[] cells) => new(cells);

    public static Table T(bool grid, params TableRow[] rows)
    {
        var table = new Table(new TableProperties(
            new TableWidth { Width = "5000", Type = TableWidthUnitValues.Pct },
            new TableBorders(
                new TopBorder { Val = BorderValues.Single, Size = 4 }, new BottomBorder { Val = BorderValues.Single, Size = 4 },
                new LeftBorder { Val = BorderValues.Single, Size = 4 }, new RightBorder { Val = BorderValues.Single, Size = 4 },
                new InsideHorizontalBorder { Val = BorderValues.Single, Size = 4 }, new InsideVerticalBorder { Val = BorderValues.Single, Size = 4 })));
        if (grid) table.AppendChild(new TableGrid(new GridColumn { Width = "4000" }, new GridColumn { Width = "4000" }));
        foreach (var row in rows) table.AppendChild(row);
        return table;
    }

    public static Table Ok() => T(true, R(C(P("1")), C(P("2"))));

    public static SdtBlock BlockControl(params OpenXmlElement[] content) =>
        new(new SdtProperties(new SdtId { Val = 11 }), new SdtContentBlock(content));

    public static SectionProperties Section(params OpenXmlElement[] references)
    {
        var section = new SectionProperties(references);
        section.Append(
            new PageSize { Width = 11906, Height = 16838 },
            new PageMargin { Top = 1440, Bottom = 1440, Left = 1800, Right = 1800, Header = 851, Footer = 992, Gutter = 0 });
        return section;
    }

    /// <summary>新建文档：build 写正文；正文末尾没有分节属性时补一个。edit 在保存前对文档做修改（验证原语用）。</summary>
    public static string Make(string directory, string name, Action<MainDocumentPart, Body> build, Action<MainDocumentPart, Body>? edit = null)
    {
        var path = Path.Combine(directory, name + ".docx");
        using var document = WordprocessingDocument.Create(path, WordprocessingDocumentType.Document);
        var main = document.AddMainDocumentPart();
        main.Document = new Document(new Body());
        var body = main.Document.Body!;
        build(main, body);
        if (body.LastChild is not SectionProperties) body.AppendChild(Section());
        edit?.Invoke(main, body);
        main.Document.Save();
        return path;
    }
}
