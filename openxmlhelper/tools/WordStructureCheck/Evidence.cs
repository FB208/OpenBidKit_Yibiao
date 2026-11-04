using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using static Yibiao.OpenXmlHelper.WordStructureCheck.DocBuilder;
using V = DocumentFormat.OpenXml.Vml;

namespace Yibiao.OpenXmlHelper.WordStructureCheck;

/// <summary>
/// evidence 模式：生成各自违反一条候选规则的最小文档，供 Word 复测规则表。
/// expected.txt 记录 Word 16 的实测结果（OPEN 能打开 / FAIL 打不开），check-word-open.ps1 据此比对。
/// </summary>
static class Evidence
{
    public static void Run(string directory)
    {
        Directory.CreateDirectory(directory);
        var expected = new List<string>();
        void Case(string name, string result, Action<MainDocumentPart, Body> build)
        {
            Make(directory, name, build);
            expected.Add($"{name} {result}");
        }

        Case("00_baseline", "OPEN", (_, b) => b.Append(P("前"), Ok(), P("后")));

        // R1 单元格
        Case("tc_empty", "FAIL", (_, b) => b.Append(P("前"), T(true, R(C(), C(P("2")))), P("后")));
        Case("tc_only_bookmark", "FAIL", (_, b) => b.Append(P("前"), T(true, R(C(new BookmarkStart { Id = "1", Name = "bm" }, new BookmarkEnd { Id = "1" }), C(P("2")))), P("后")));
        Case("tc_ends_with_table", "FAIL", (_, b) => b.Append(P("前"), T(true, R(C(P("x"), Ok()), C(P("2")))), P("后")));
        Case("tc_only_table", "FAIL", (_, b) => b.Append(P("前"), T(true, R(C(Ok()), C(P("2")))), P("后")));
        Case("tc_only_empty_block_sdt", "FAIL", (_, b) => b.Append(P("前"), T(true, R(C(BlockControl()), C(P("2")))), P("后")));
        Case("tc_para_then_empty_block_sdt", "FAIL", (_, b) => b.Append(P("前"), T(true, R(C(P("x"), BlockControl()), C(P("2")))), P("后")));
        Case("tc_ends_with_block_sdt", "OPEN", (_, b) => b.Append(P("前"), T(true, R(C(BlockControl(P("s"))), C(P("2")))), P("后")));
        Case("tc_sdt_with_para_then_table_then_para", "OPEN", (_, b) => b.Append(P("前"), T(true, R(C(BlockControl(P("s"), Ok(), P("t"))), C(P("2")))), P("后")));
        Case("tc_para_then_bookmark_end", "OPEN", (_, b) => b.Append(P("前"), T(true, R(C(new Paragraph(new BookmarkStart { Id = "1", Name = "bm" }, new Run(new Text("x"))), new BookmarkEnd { Id = "1" }), C(P("2")))), P("后")));
        Case("tc_para_then_comment_range_end", "OPEN", (main, b) =>
        {
            AddComment(main, "0", "批注");
            b.Append(P("前"), T(true, R(C(new Paragraph(new CommentRangeStart { Id = "0" }, new Run(new Text("x")), new Run(new CommentReference { Id = "0" })), new CommentRangeEnd { Id = "0" }), C(P("2")))), P("后"));
        });

        // R2 行与表格
        Case("tr_no_cells", "FAIL", (_, b) => b.Append(P("前"), T(true, R(), R(C(P("1")), C(P("2")))), P("后")));
        Case("tbl_no_rows", "OPEN", (_, b) => b.Append(P("前"), T(true), P("后")));
        Case("tbl_no_grid", "OPEN", (_, b) => b.Append(P("前"), T(false, R(C(P("1")), C(P("2")))), P("后")));
        Case("tr_gridspan_exceeds", "OPEN", (_, b) =>
        {
            var wide = C(P("跨三列"));
            wide.TableCellProperties!.AppendChild(new GridSpan { Val = 3 });
            b.Append(P("前"), T(true, R(wide), R(C(P("1")), C(P("2")))), P("后"));
        });
        Case("tr_vmerge_continue_only", "OPEN", (_, b) =>
        {
            var merged = C(P(""));
            merged.TableCellProperties!.AppendChild(new VerticalMerge());
            b.Append(P("前"), T(true, R(merged, C(P("2")))), P("后"));
        });

        // R3 悬空引用
        Case("comment_reference_missing_comment", "FAIL", (_, b) => b.Append(new Paragraph(new Run(new Text("前")), new Run(new CommentReference { Id = "5" }))));
        Case("footnote_reference_missing", "FAIL", (_, b) => b.Append(new Paragraph(new Run(new Text("前")), new Run(new FootnoteReference { Id = 7 }))));
        Case("endnote_reference_missing", "FAIL", (_, b) => b.Append(new Paragraph(new Run(new Text("前")), new Run(new EndnoteReference { Id = 7 }))));
        Case("hyperlink_rid_missing", "FAIL", (_, b) => b.Append(new Paragraph(new Run(new Text("前")), new Hyperlink(new Run(new Text("链接"))) { Id = "rIdMissing" })));
        Case("header_reference_missing", "FAIL", (_, b) => b.Append(P("前"), Section(new HeaderReference { Type = HeaderFooterValues.Default, Id = "rIdMissing" })));
        Case("image_embed_missing", "OPEN", (_, b) => b.Append(new Paragraph(new Run(new Drawing(PictureXml("rIdMissing"))))));

        // R4 成对标记（Word 能打开，按稳定性收录）
        Case("bookmark_start_only", "OPEN", (_, b) => b.Append(new Paragraph(new BookmarkStart { Id = "1", Name = "bm" }, new Run(new Text("前"))), P("后")));
        Case("bookmark_end_only", "OPEN", (_, b) => b.Append(new Paragraph(new Run(new Text("前")), new BookmarkEnd { Id = "1" }), P("后")));
        Case("field_begin_only", "OPEN", (_, b) => b.Append(new Paragraph(new Run(new Text("前")), new Run(new FieldChar { FieldCharType = FieldCharValues.Begin }),
            new Run(new FieldCode(" PAGE ") { Space = SpaceProcessingModeValues.Preserve })), P("后")));
        Case("field_end_only", "OPEN", (_, b) => b.Append(new Paragraph(new Run(new Text("前")), new Run(new FieldChar { FieldCharType = FieldCharValues.End })), P("后")));
        Case("field_separate_end_no_begin", "OPEN", (_, b) => b.Append(new Paragraph(new Run(new Text("前")), new Run(new FieldChar { FieldCharType = FieldCharValues.Separate }),
            new Run(new Text("1")), new Run(new FieldChar { FieldCharType = FieldCharValues.End })), P("后")));
        Case("comment_range_start_only", "OPEN", (main, b) =>
        {
            AddComment(main, "0", "批注");
            b.Append(new Paragraph(new CommentRangeStart { Id = "0" }, new Run(new Text("前"))));
        });

        // 正常编辑也会出现的写法（不收进规则表）
        Case("body_ends_with_table", "OPEN", (_, b) => b.Append(P("前"), Ok()));
        Case("body_no_blocks", "OPEN", (_, _) => { });
        Case("body_only_empty_block_sdt", "OPEN", (_, b) => b.Append(BlockControl()));
        Case("sdt_block_empty", "OPEN", (_, b) => b.Append(P("前"), BlockControl(), P("后")));
        Case("sdt_run_empty", "OPEN", (_, b) => b.Append(new Paragraph(new Run(new Text("前")), new SdtRun(new SdtProperties(new SdtId { Val = 12 }), new SdtContentRun()), new Run(new Text("后")))));
        Case("hyperlink_no_runs", "OPEN", (_, b) => b.Append(new Paragraph(new Run(new Text("前")), new Hyperlink { Anchor = "bm" }, new Run(new Text("后")))));
        Case("comment_empty", "OPEN", (main, b) =>
        {
            var comments = main.AddNewPart<WordprocessingCommentsPart>();
            comments.Comments = new Comments(new Comment { Id = "0", Author = "a" });
            comments.Comments.Save();
            b.Append(new Paragraph(new CommentRangeStart { Id = "0" }, new Run(new Text("前")), new CommentRangeEnd { Id = "0" }, new Run(new CommentReference { Id = "0" })));
        });
        Case("footnote_empty", "OPEN", (main, b) =>
        {
            var notes = main.AddNewPart<FootnotesPart>();
            notes.Footnotes = new Footnotes(
                new Footnote(P("")) { Type = FootnoteEndnoteValues.Separator, Id = -1 },
                new Footnote(P("")) { Type = FootnoteEndnoteValues.ContinuationSeparator, Id = 0 },
                new Footnote { Id = 1 });
            notes.Footnotes.Save();
            b.Append(new Paragraph(new Run(new Text("前")), new Run(new FootnoteReference { Id = 1 })));
        });
        Case("header_empty", "OPEN", (main, b) =>
        {
            var header = main.AddNewPart<HeaderPart>();
            header.Header = new Header();
            header.Header.Save();
            b.Append(P("前"), Section(new HeaderReference { Type = HeaderFooterValues.Default, Id = main.GetIdOfPart(header) }));
        });
        Case("textbox_empty", "OPEN", (_, b) => b.Append(new Paragraph(new Run(new Picture(new V.Shape(new V.TextBox(new TextBoxContent())) { Id = "tb1", Style = "width:120pt;height:60pt" })))));
        Case("textbox_ends_with_table", "OPEN", (_, b) => b.Append(new Paragraph(new Run(new Picture(new V.Shape(new V.TextBox(new TextBoxContent(P("x"), Ok()))) { Id = "tb1", Style = "width:200pt;height:80pt" })))));
        Case("wps_textbox_ok", "OPEN", (_, b) => b.Append(new Paragraph(new Run(new Drawing(WpsTextBox(P("框内").OuterXml)))), P("后")));
        Case("wps_textbox_empty", "OPEN", (_, b) => b.Append(new Paragraph(new Run(new Drawing(WpsTextBox("")))), P("后")));
        Case("wps_textbox_ends_with_table", "OPEN", (_, b) => b.Append(new Paragraph(new Run(new Drawing(WpsTextBox(P("x").OuterXml + Ok().OuterXml)))), P("后")));
        Case("wps_textbox_only_bookmark", "OPEN", (_, b) => b.Append(new Paragraph(new Run(new Drawing(WpsTextBox(
            new BookmarkStart { Id = "1", Name = "bm" }.OuterXml + new BookmarkEnd { Id = "1" }.OuterXml)))), P("后")));

        File.WriteAllLines(Path.Combine(directory, "expected.txt"), expected);
        Console.WriteLine($"evidence：已生成 {expected.Count} 个文档到 {directory}");
    }

    public static void AddComment(MainDocumentPart main, string id, string text)
    {
        var part = main.WordprocessingCommentsPart ?? main.AddNewPart<WordprocessingCommentsPart>();
        part.Comments ??= new Comments();
        part.Comments.AppendChild(new Comment(P(text)) { Id = id, Author = "a" });
        part.Comments.Save();
    }

    public static string PictureXml(string relationshipId) => $"""
<w:drawing xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="31" name="Pic"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="p.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>
""";

    static string WpsTextBox(string content) => $"""
<w:drawing xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="2540000" cy="1016000"/><wp:docPr id="21" name="TB"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="1016000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr><wps:txbx><w:txbxContent>{content}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing>
""";
}
