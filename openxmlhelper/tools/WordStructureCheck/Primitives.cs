using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using Yibiao.OpenXmlHelper.Ooxml;
using static Yibiao.OpenXmlHelper.WordStructureCheck.DocBuilder;

namespace Yibiao.OpenXmlHelper.WordStructureCheck;

/// <summary>
/// primitives 模式：对每条规则用结构层原语做一次“危险删除”，检查原语的处理结果并写出文档；
/// 随后对输出逐个 audit，再用 check-word-open.ps1 交给 Word 打开，全部应能打开。
/// </summary>
static class Primitives
{
    static readonly List<string> Failures = [];

    public static int Run(string directory)
    {
        Directory.CreateDirectory(directory);
        var outputs = new List<string>();
        void Case(string name, Action<MainDocumentPart, Body> build, Action<MainDocumentPart, Body> edit) =>
            outputs.Add(Make(directory, name, build, edit));

        // R1 单元格以段落结尾
        Case("r1_cell_only_paragraph",
            (_, b) => b.Append(P("前"), T(true, R(C(P("格内唯一")), C(P("2")))), P("后")),
            (_, b) =>
            {
                var paragraph = Find(b, "格内唯一");
                Expect(WordStructure.Remove(paragraph) == StructureResult.Cleared, "单元格唯一段落应降级为清空");
                Expect(paragraph.Parent is TableCell && paragraph.InnerText.Length == 0, "清空后段落仍在单元格里且没有文字");
            });
        Case("r1_cell_last_paragraph_after_table",
            (_, b) => b.Append(P("前"), T(true, R(C(P("a"), Ok(), P("末段")), C(P("2")))), P("后")),
            (_, b) => Expect(WordStructure.Remove(Find(b, "末段")) == StructureResult.Cleared, "表格后的末段应降级为清空"));
        Case("r1_cell_trailing_control",
            (_, b) => b.Append(P("前"), T(true, R(C(BlockControl(P("控件内"))), C(P("2")))), P("后")),
            (_, b) =>
            {
                var control = b.Descendants<SdtBlock>().First();
                var cell = control.Ancestors<TableCell>().First();
                Expect(WordStructure.Remove(control) == StructureResult.Removed, "末尾控件应删除");
                Expect(cell.LastChild is Paragraph, "删除末尾控件后应补一个空段");
            });
        Case("r1_cell_range_all_paragraphs",
            (_, b) => b.Append(P("前"), T(true, R(C(P("甲"), P("乙"), P("丙")), C(P("2")))), P("后")),
            (_, b) =>
            {
                var cell = Find(b, "甲").Ancestors<TableCell>().First();
                var cleared = WordStructure.RemoveRange(cell.Elements<Paragraph>().ToList());
                Expect(cleared.Count == 1 && cell.Elements<Paragraph>().Count() == 1, "整批删光单元格段落时保留一个清空的段落");
            });
        Case("r1_clear_control_content_in_cell",
            (_, b) => b.Append(P("前"), T(true, R(C(BlockControl(P("一"), P("二"))), C(P("2")))), P("后")),
            (_, b) =>
            {
                var content = b.Descendants<SdtContentBlock>().First();
                WordStructure.ClearContent(content);
                Expect(content.Elements<Paragraph>().Count() == 1, "清空单元格末尾控件的内容时保留一个段落");
            });
        Case("r1_replace_paragraph_with_table",
            (_, b) => b.Append(P("前"), T(true, R(C(P("旧段")), C(P("2")))), P("后")),
            (_, b) =>
            {
                var old = Find(b, "旧段");
                Expect(WordStructure.Replace(old, Ok()) == StructureResult.Cleared, "替换成表格时末段降级为清空，留在表格后");
            });
        Case("r1_unwrap_control_in_cell",
            (_, b) => b.Append(P("前"), T(true, R(C(BlockControl(P("去壳"))), C(P("2")))), P("后")),
            (_, b) =>
            {
                WordStructure.Unwrap(b.Descendants<SdtBlock>().First());
                Expect(Find(b, "去壳").Parent is TableCell, "去壳后段落直接留在单元格里");
            });
        Case("r1_move_out_of_cell",
            (_, b) => b.Append(P("前"), T(true, R(C(P("移出")), C(P("2")))), P("后")),
            (_, b) =>
            {
                var paragraph = Find(b, "移出");
                var cell = paragraph.Ancestors<TableCell>().First();
                WordStructure.MoveBefore(paragraph, b.Elements<Table>().First());
                Expect(cell.LastChild is Paragraph, "段落移出后原单元格补一个空段");
            });
        Case("r1_clone_tree",
            (_, b) => b.Append(P("前"), T(true, R(C(P("克隆源")), C(P("2")))), P("后")),
            (_, b) =>
            {
                var row = b.Descendants<TableRow>().First();
                var clone = (TableRow)row.CloneNode(true);
                Expect(WordStructure.Remove(Find(clone, "克隆源")) == StructureResult.Cleared, "克隆树上同样按 R1 处理");
                row.InsertAfterSelf(clone);
            });

        // R2 行与表格
        Case("r2_remove_all_cells_of_row",
            (_, b) => b.Append(P("前"), T(true, R(C(P("删行1")), C(P("删行2"))), R(C(P("3")), C(P("4")))), P("后")),
            (_, b) =>
            {
                var row = Find(b, "删行1").Ancestors<TableRow>().First();
                WordStructure.RemoveRange(row.Elements<TableCell>().ToList());
                Expect(row.Parent is null, "单元格删光后整行删除");
            });
        Case("r2_remove_all_rows_of_nested_table",
            (_, b) => b.Append(P("前"), T(true, R(C(T(true, R(C(P("内1")), C(P("内2")))), P("外")), C(P("2")))), P("后")),
            (_, b) =>
            {
                var nested = Find(b, "内1").Ancestors<Table>().First();
                var cell = nested.Ancestors<TableCell>().First();
                WordStructure.RemoveRange(nested.Elements<TableRow>().ToList());
                Expect(nested.Parent is null && cell.LastChild is Paragraph, "行删光后整表删除，外层单元格仍以段落结尾");
            });

        // R4 书签
        Case("r4_bookmark_start_half",
            (_, b) => b.Append(new Paragraph(new BookmarkStart { Id = "1", Name = "bm" }, TextRun("起点段")), P("中间"), new Paragraph(TextRun("终点段"), new BookmarkEnd { Id = "1" })),
            (_, b) =>
            {
                WordStructure.Remove(Find(b, "起点段"));
                Expect(Find(b, "中间").Elements<BookmarkStart>().Any(), "书签起点移到下一段开头");
            });
        Case("r4_bookmark_end_half",
            (_, b) => b.Append(new Paragraph(new BookmarkStart { Id = "1", Name = "bm" }, TextRun("起点段")), P("中间"), new Paragraph(TextRun("终点段"), new BookmarkEnd { Id = "1" })),
            (_, b) =>
            {
                WordStructure.Remove(Find(b, "终点段"));
                Expect(Find(b, "中间").LastChild is BookmarkEnd, "书签终点移到上一段末尾");
            });
        Case("r4_bookmark_both_in_removed_block",
            (_, b) => b.Append(P("前"), new Paragraph(new BookmarkStart { Id = "1", Name = "_YbPS0001" }, TextRun("整对"), new BookmarkEnd { Id = "1" }), P("下一段")),
            (_, b) =>
            {
                WordStructure.Remove(Find(b, "整对"));
                var next = Find(b, "下一段");
                Expect(next.Elements<BookmarkStart>().Any() && next.Elements<BookmarkEnd>().Any(), "两端都被删时一起移到下一段开头");
            });
        Case("r4_bookmark_explicit",
            (_, b) => b.Append(new Paragraph(new BookmarkStart { Id = "1", Name = "bm" }, TextRun("显式")), new Paragraph(TextRun("另一端"), new BookmarkEnd { Id = "1" })),
            (_, b) =>
            {
                WordStructure.RemoveBookmarks([b.Descendants<BookmarkStart>().First()]);
                Expect(!b.Descendants<BookmarkEnd>().Any(), "显式删除书签时另一端一起删");
            });
        Case("r4_bookmark_inline",
            (_, b) => b.Append(new Paragraph(TextRun("甲"), new Hyperlink(new BookmarkStart { Id = "1", Name = "bm" }, TextRun("链接")) { Anchor = "x" }, TextRun("乙"), new BookmarkEnd { Id = "1" })),
            (_, b) =>
            {
                WordStructure.Remove(b.Descendants<Hyperlink>().First());
                Expect(b.Descendants<BookmarkStart>().Any(), "行内删除时书签原位保留");
            });

        // R4 域
        Case("r4_field_half",
            (_, b) => b.Append(
                new Paragraph(TextRun("前"), new Run(new FieldChar { FieldCharType = FieldCharValues.Begin }), new Run(new FieldCode(" PAGE ") { Space = SpaceProcessingModeValues.Preserve }),
                    new Run(new FieldChar { FieldCharType = FieldCharValues.Separate }), TextRun("结果一")),
                new Paragraph(TextRun("结果二"), new Run(new FieldChar { FieldCharType = FieldCharValues.End }))),
            (_, b) =>
            {
                WordStructure.Remove(Find(b, "结果二"));
                Expect(!b.Descendants<FieldChar>().Any() && !b.Descendants<FieldCode>().Any(), "域被删一半时退化为普通文字");
                Expect(b.InnerText.Contains("结果一"), "退化后保留结果区文字");
            });

        // R4 批注
        Case("r4_comment_half",
            (main, b) =>
            {
                Evidence.AddComment(main, "0", "批注内容");
                b.Append(new Paragraph(new CommentRangeStart { Id = "0" }, TextRun("批注起点")), new Paragraph(TextRun("批注终点"), new CommentRangeEnd { Id = "0" }, new Run(new CommentReference { Id = "0" })));
            },
            (main, b) =>
            {
                WordStructure.Remove(Find(b, "批注终点"));
                Expect(!b.Descendants<CommentRangeStart>().Any(), "删到批注一部分时其余标记一起删");
                Expect(!main.WordprocessingCommentsPart!.Comments!.Elements<Comment>().Any(), "批注条目一起删");
            });
        Case("r4_remove_all_comments",
            (main, b) =>
            {
                Evidence.AddComment(main, "0", "一");
                Evidence.AddComment(main, "1", "二");
                b.Append(new Paragraph(new CommentRangeStart { Id = "0" }, TextRun("甲"), new CommentRangeEnd { Id = "0" }, new Run(new CommentReference { Id = "0" })),
                    new Paragraph(new CommentRangeStart { Id = "1" }, TextRun("乙"), new CommentRangeEnd { Id = "1" }, new Run(new CommentReference { Id = "1" })));
            },
            (main, _) => WordStructure.RemoveAllComments(main));

        // R3 引用
        Case("r3_delete_hyperlink_relationship",
            (main, b) =>
            {
                var link = main.AddHyperlinkRelationship(new Uri("https://example.com/"), true);
                b.Append(new Paragraph(TextRun("前"), new Hyperlink(TextRun("外部链接")) { Id = link.Id }));
            },
            (main, b) =>
            {
                WordStructure.DeleteRelationship(main, b.Descendants<Hyperlink>().First().Id!.Value!);
                Expect(!b.Descendants<Hyperlink>().Any() && b.InnerText.Contains("外部链接"), "删除超链接关系时去壳保留文字");
            });
        Case("r3_delete_image_part",
            (main, b) =>
            {
                var image = main.AddImagePart(ImagePartType.Png);
                using (var stream = new MemoryStream(Convert.FromBase64String(OnePixelPng))) image.FeedData(stream);
                b.Append(T(true, R(C(new Paragraph(new Run(new Drawing(Evidence.PictureXml(main.GetIdOfPart(image)))))), C(P("2")))));
            },
            (main, b) =>
            {
                WordStructure.DeletePart(main, main.ImageParts.First());
                Expect(!b.Descendants<Drawing>().Any() && !main.ImageParts.Any(), "删除图片部件时连带删除引用它的图片");
            });
        Case("r3_delete_header_part",
            (main, b) =>
            {
                var header = main.AddNewPart<HeaderPart>();
                header.Header = new Header(P("页眉"));
                header.Header.Save();
                b.Append(P("正文"), Section(new HeaderReference { Type = HeaderFooterValues.Default, Id = main.GetIdOfPart(header) }));
            },
            (main, b) =>
            {
                WordStructure.DeletePart(main, main.HeaderParts.First());
                Expect(!b.Descendants<HeaderReference>().Any(), "删除页眉部件时连带删除页眉引用");
            });

        var problems = 0;
        foreach (var output in outputs)
        {
            foreach (var problem in Audit.Check(output))
            {
                Failures.Add($"{Path.GetFileNameWithoutExtension(output)}：audit {problem}");
                problems += 1;
            }
        }
        foreach (var failure in Failures) Console.WriteLine($"不通过 {failure}");
        Console.WriteLine($"primitives：{outputs.Count} 个用例，{Failures.Count} 处不通过，输出在 {directory}");
        return Failures.Count == 0 ? 0 : 1;
    }

    static Run TextRun(string text) => new(new Text(text) { Space = SpaceProcessingModeValues.Preserve });

    static Paragraph Find(OpenXmlElement root, string text) =>
        root.Descendants<Paragraph>().First(paragraph => paragraph.InnerText.Contains(text, StringComparison.Ordinal));

    static void Expect(bool condition, string message)
    {
        if (!condition) Failures.Add(message);
    }

    const string OnePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
}
