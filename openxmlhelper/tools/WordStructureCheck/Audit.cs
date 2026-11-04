using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using Yibiao.OpenXmlHelper.Ooxml;

namespace Yibiao.OpenXmlHelper.WordStructureCheck;

/// <summary>audit：按规则表检查文档结构，返回问题列表（空表示通过）。原件自带的不规范写法同样会列出。</summary>
static class Audit
{
    const string RelationshipNamespace = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    static readonly IReadOnlySet<OpenXmlElement> None = new HashSet<OpenXmlElement>();

    public static List<string> Check(string path)
    {
        var problems = new List<string>();
        using var document = WordprocessingDocument.Open(path, false);
        var main = document.MainDocumentPart ?? throw new InvalidOperationException("缺少正文部件");
        var commentIds = main.WordprocessingCommentsPart?.Comments?.Elements<Comment>().Select(item => item.Id?.Value).OfType<string>().ToHashSet() ?? [];
        var footnoteIds = main.FootnotesPart?.Footnotes?.Elements<Footnote>().Select(item => item.Id?.Value).OfType<long>().ToHashSet() ?? [];
        var endnoteIds = main.EndnotesPart?.Endnotes?.Elements<Endnote>().Select(item => item.Id?.Value).OfType<long>().ToHashSet() ?? [];

        foreach (var part in StoryParts(main))
        {
            if (part.RootElement is not { } root) continue;
            var label = part.Uri.OriginalString;
            foreach (var cell in root.Descendants<TableCell>().Where(cell => !WordStructureRules.EndsWithParagraph(cell, None)))
            {
                problems.Add($"R1 {label}：单元格不以段落结尾（文字“{Excerpt(cell.InnerText)}”）");
            }
            foreach (var row in root.Descendants<TableRow>().Where(row => !WordStructureRules.HasCells(row))) problems.Add($"R2 {label}：行里没有单元格");
            foreach (var table in root.Descendants<Table>().Where(table => !WordStructureRules.HasRows(table))) problems.Add($"R2 {label}：表格没有行");

            var relationshipIds = part.Parts.Select(pair => pair.RelationshipId)
                .Concat(part.HyperlinkRelationships.Select(item => item.Id))
                .Concat(part.ExternalRelationships.Select(item => item.Id))
                .Concat(part.DataPartReferenceRelationships.Select(item => item.Id))
                .ToHashSet(StringComparer.Ordinal);
            foreach (var element in root.Descendants())
            {
                foreach (var attribute in element.GetAttributes().Where(item => item.NamespaceUri == RelationshipNamespace))
                {
                    if (!relationshipIds.Contains(attribute.Value ?? "")) problems.Add($"R3 {label}：{element.LocalName} 的 r:{attribute.LocalName}={attribute.Value} 指向不存在的关系");
                }
            }
            foreach (var reference in root.Descendants<CommentReference>().Where(item => !commentIds.Contains(item.Id?.Value ?? "")))
            {
                problems.Add($"R3 {label}：批注引用 {reference.Id?.Value} 指向不存在的批注");
            }
            foreach (var reference in root.Descendants<FootnoteReference>().Where(item => item.Id?.Value is not { } id || !footnoteIds.Contains(id)))
            {
                problems.Add($"R3 {label}：脚注引用 {reference.Id?.Value} 指向不存在的脚注");
            }
            foreach (var reference in root.Descendants<EndnoteReference>().Where(item => item.Id?.Value is not { } id || !endnoteIds.Contains(id)))
            {
                problems.Add($"R3 {label}：尾注引用 {reference.Id?.Value} 指向不存在的尾注");
            }

            var starts = root.Descendants<BookmarkStart>().Select(item => item.Id?.Value ?? "").ToHashSet();
            var ends = root.Descendants<BookmarkEnd>().Select(item => item.Id?.Value ?? "").ToHashSet();
            foreach (var id in starts.Except(ends)) problems.Add($"R4 {label}：书签 {id} 只有起点");
            foreach (var id in ends.Except(starts)) problems.Add($"R4 {label}：书签 {id} 只有终点");
            var rangeStarts = root.Descendants<CommentRangeStart>().Select(item => item.Id?.Value ?? "").ToHashSet();
            var rangeEnds = root.Descendants<CommentRangeEnd>().Select(item => item.Id?.Value ?? "").ToHashSet();
            foreach (var id in rangeStarts.Except(rangeEnds)) problems.Add($"R4 {label}：批注范围 {id} 只有起点");
            foreach (var id in rangeEnds.Except(rangeStarts)) problems.Add($"R4 {label}：批注范围 {id} 只有终点");
            foreach (var id in rangeStarts.Union(rangeEnds).Where(id => !commentIds.Contains(id))) problems.Add($"R4 {label}：批注范围 {id} 没有批注条目");
            var depth = 0;
            foreach (var fieldChar in root.Descendants<FieldChar>())
            {
                var type = fieldChar.FieldCharType?.Value;
                if (type == FieldCharValues.Begin) depth += 1;
                else if (type == FieldCharValues.End && --depth < 0)
                {
                    problems.Add($"R4 {label}：域结束标记没有对应的开始标记");
                    depth = 0;
                }
                else if (type == FieldCharValues.Separate && depth == 0) problems.Add($"R4 {label}：域分隔标记不在域内");
            }
            if (depth > 0) problems.Add($"R4 {label}：{depth} 个域没有结束标记");
        }
        return problems;
    }

    static IEnumerable<OpenXmlPart> StoryParts(MainDocumentPart main)
    {
        yield return main;
        foreach (var part in main.HeaderParts) yield return part;
        foreach (var part in main.FooterParts) yield return part;
        if (main.FootnotesPart is { } footnotes) yield return footnotes;
        if (main.EndnotesPart is { } endnotes) yield return endnotes;
        if (main.WordprocessingCommentsPart is { } comments) yield return comments;
    }

    static string Excerpt(string text) => text.Length > 20 ? text[..20] + "…" : text;
}
