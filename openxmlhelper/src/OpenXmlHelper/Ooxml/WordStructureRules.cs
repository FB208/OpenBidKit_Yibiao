using DocumentFormat.OpenXml;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Ooxml;

/// <summary>
/// 容器规则（Word 16 实测）：
/// R1 单元格必须以段落结尾，块级控件在末尾时控件内以段落结尾也算，空控件不算；书签、批注范围等标记不参与判断。
/// R2 一行至少一个单元格，表格至少一行。
/// </summary>
static class WordStructureRules
{
    /// <summary>单元格、行、表格以外承载正文的块级元素。</summary>
    public static bool IsBlock(OpenXmlElement element) =>
        element is Wp.Paragraph or Wp.Table or Wp.SdtBlock or Wp.CustomXmlBlock or Wp.AltChunk;

    /// <summary>块级、行级、单元格级元素；删除这类元素时标记移到相邻段落，其余元素的标记原位保留。</summary>
    public static bool IsBlockLike(OpenXmlElement element) =>
        IsBlock(element) || IsRowLevel(element) || IsCellLevel(element);

    public static bool IsRowLevel(OpenXmlElement element) => element is Wp.TableRow or Wp.SdtRow or Wp.CustomXmlRow;

    public static bool IsCellLevel(OpenXmlElement element) => element is Wp.TableCell or Wp.SdtCell or Wp.CustomXmlCell;

    /// <summary>R1 约束的单元格：元素是单元格的块级内容（可隔着块级控件），否则为 null。</summary>
    public static Wp.TableCell? OwningCell(OpenXmlElement element)
    {
        for (var parent = element.Parent; parent is not null; parent = parent.Parent)
        {
            if (parent is Wp.TableCell cell) return cell;
            if (parent is not (Wp.SdtContentBlock or Wp.SdtBlock or Wp.CustomXmlBlock)) return null;
        }
        return null;
    }

    /// <summary>不计 excluded 中的元素时，容器是否以段落结尾。</summary>
    public static bool EndsWithParagraph(OpenXmlElement container, IReadOnlySet<OpenXmlElement> excluded) =>
        LastBlock(container, excluded) == Ending.Paragraph;

    enum Ending { Paragraph, Other, Empty }

    static Ending LastBlock(OpenXmlElement container, IReadOnlySet<OpenXmlElement> excluded)
    {
        for (var child = container.LastChild; child is not null; child = child.PreviousSibling())
        {
            if (excluded.Contains(child)) continue;
            switch (child)
            {
                case Wp.Paragraph:
                    return Ending.Paragraph;
                case Wp.SdtBlock control:
                    // 空控件放在末尾同样打不开。
                    return control.SdtContentBlock is { } content && LastBlock(content, excluded) == Ending.Paragraph ? Ending.Paragraph : Ending.Other;
                case Wp.CustomXmlBlock custom:
                    return LastBlock(custom, excluded) == Ending.Paragraph ? Ending.Paragraph : Ending.Other;
                case Wp.Table or Wp.AltChunk:
                    return Ending.Other;
            }
        }
        return Ending.Empty;
    }

    /// <summary>行里是否还有单元格（含控件包着的单元格）。</summary>
    public static bool HasCells(OpenXmlElement row) =>
        row.Descendants<Wp.TableCell>().Any(cell => ReferenceEquals(cell.Ancestors<Wp.TableRow>().FirstOrDefault(), row));

    /// <summary>表格里是否还有行（含控件包着的行）。</summary>
    public static bool HasRows(OpenXmlElement table) =>
        table.Descendants<Wp.TableRow>().Any(row => ReferenceEquals(row.Ancestors<Wp.Table>().FirstOrDefault(), table));

    /// <summary>补在单元格末尾的空段：沿用来源段落的段落属性，去掉编号、段前分页和分节符，不改变版面。</summary>
    public static Wp.Paragraph EmptyParagraph(Wp.Paragraph? source)
    {
        var paragraph = new Wp.Paragraph();
        if (source?.ParagraphProperties?.CloneNode(true) is Wp.ParagraphProperties properties)
        {
            properties.NumberingProperties = null;
            properties.PageBreakBefore = null;
            properties.SectionProperties = null;
            paragraph.AppendChild(properties);
        }
        return paragraph;
    }
}
