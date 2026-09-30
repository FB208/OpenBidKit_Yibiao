using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>扫描投标模板正文中的明确占位、空单元格、勾选项和附件位置，输出供 Agent 分类的稳定候选。</summary>
static class TemplateFieldScanner
{
    const RegexOptions PatternOptions = RegexOptions.CultureInvariant | RegexOptions.Compiled;
    const int ContextRadius = 60;
    const int CellContextTextLimit = 40;

    static readonly Regex PlaceholderPattern = new(
        @"_{2,}|＿{2,}|【\s*(?:待填写|人工处理)\s*[：:]?[^】]*】|\(\s*\)|（\s*）",
        PatternOptions);
    static readonly Regex TrailingLabelPattern = new(
        @"(?<label>[\p{L}\p{N}（）()《》/·\-]{2,30})[：:]\s*$",
        PatternOptions);
    static readonly Regex ExplicitNamePattern = new(
        @"【\s*(?:待填写|人工处理)\s*[：:]\s*(?<name>[^】]+)】",
        PatternOptions);
    static readonly Regex SignaturePattern = new(@"签字|签名|签章|手印", PatternOptions);
    static readonly Regex StampPattern = new(@"盖章|公章|印章", PatternOptions);
    static readonly Regex StampLabelEndPattern = new(@"(?:盖章|公章|印章)$", PatternOptions);
    static readonly Regex BracketHintPattern = new(@"[（(](?<hint>[^（）()\r\n]{1,20})[）)]", PatternOptions);
    static readonly Regex TrailingHintPattern = new(@"[（(](?<hint>[^（）()\r\n]{1,20})[）)]\s*$", PatternOptions);
    static readonly Regex LeadingHintPattern = new(@"^\s*[（(](?<hint>[^（）()\r\n]{1,20})[）)]", PatternOptions);
    static readonly Regex NameHintPattern = new(
        @"(?:名称|地址|住所|姓名|职务|职称|编号|号码|电话|手机|日期|时间|期限|金额|代码|账号|帐号|开户行|邮编|传真|邮箱|网址)$",
        PatternOptions);
    static readonly Regex MaterialPattern = new(@"扫描|复印|影印|照片|粘贴", PatternOptions);
    static readonly Regex InnerBlankPattern = new(@"[ 　]{2,}", PatternOptions);
    static readonly Regex BlankGapPattern = new(
        @"(?<label>[\p{L}\p{N}（）()《》/·\-]{2,30})[：:](?<gap>[ 　]*)(?<hint>[（(][^（）()\r\n]{1,12}[）)])[ 　。.]*$",
        PatternOptions);
    static readonly Regex DateGapPattern = new(@"(?<y>[ 　]+)年(?<m>[ 　]+)月(?<d>[ 　]+)日", PatternOptions);
    internal static readonly Regex CheckboxOptionPattern = new(@"[□☐](?<option>[^□☐]*)", PatternOptions);
    static readonly Regex AttachmentNotePattern = new(
        @"(?:后附|附后|另附|附[：:])(?<material>[^。；;]{0,60}(?:复印件|扫描件|证书|执照|证明|证件|资料))",
        PatternOptions);
    static readonly Regex AttachmentSlotPattern = new(
        @"^[（(]?(?:此处)?(?:粘贴|附)?(?<name>[^：:。，,；;]{2,30}?)(?:扫描或复印件?|扫描件|复印件|影印件|照片|粘贴处)[）)]?$",
        PatternOptions);
    static readonly Regex AfterLabelExcludePattern = new(@"(?:如下|以下|下列|如次)$", PatternOptions);
    static readonly Regex TableTitlePattern = new(
        @"(?:表|表格|一览表|应答表|明细表|汇总表)(?:\s*[（(][^）)]*[）)])?\s*$",
        PatternOptions);
    static readonly Regex NumberedGroupPattern = new(
        @"^(?:[（(][一二三四五六七八九十百0-9]+[）)]|[一二三四五六七八九十百]+[、.．]|[0-9]+[、.．])\s*\S+",
        PatternOptions);
    static readonly Regex SentenceLikePattern = new(
        @"我公司|本公司|见第|投标文件|[。；;！？!?：:]",
        PatternOptions);

    public static TemplateFieldCandidateFile Scan(
        WordprocessingDocument document,
        IReadOnlyList<TemplateChapterRange>? chapterRanges = null)
    {
        var part = document.MainDocumentPart ?? throw new InvalidOperationException("投标模版缺少正文部件");
        var body = part.Document.Body ?? throw new InvalidOperationException("投标模版正文为空");
        var result = new TemplateFieldCandidateFile();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var order = 0;
        var blocks = body.ChildElements.ToList();
        var chapters = NormalizeChapterRanges(chapterRanges, blocks.Count);

        for (var blockIndex = 0; blockIndex < blocks.Count; blockIndex += 1)
        {
            var block = blocks[blockIndex];
            var blockPath = $"body/{blockIndex}:{block.LocalName}";
            var firstCandidate = result.Candidates.Count;
            var checkboxGroup = CollectCheckboxParagraphs(blocks, blockIndex);
            if (checkboxGroup.Count >= 2)
            {
                AddCheckboxGroup(checkboxGroup, blockPath, SuggestGroupName(blocks, blockIndex), result.Candidates, seen, ref order);
            }
            else if (block is Wp.Table table)
            {
                var chapter = FindChapter(chapters, blockIndex);
                ScanTable(
                    table,
                    blockPath,
                    $"t{blockIndex}",
                    FindTableTitle(body, blockIndex, chapter),
                    result.Candidates,
                    seen,
                    ref order);
            }
            else
            {
                ScanElement(block, blockPath, result.Candidates, seen, ref order);
            }

            var chapterName = FindChapter(chapters, blockIndex)?.Title;
            for (var index = firstCandidate; index < result.Candidates.Count; index += 1)
            {
                result.Candidates[index].ChapterName = Optional(Limit(chapterName ?? "", 120));
            }
            blockIndex += Math.Max(0, checkboxGroup.Count - 1);
        }

        BuildStructureContexts(result);
        return result;
    }

    static void ScanElement(
        OpenXmlElement element,
        string path,
        List<TemplateFieldCandidate> candidates,
        HashSet<string> seen,
        ref int order)
    {
        if (element is Wp.SdtRun runControl)
        {
            ScanExistingControl(runControl, path, candidates, seen, ref order);
            return;
        }

        if (element is Wp.SdtBlock blockControl)
        {
            // 已填写固定内容的块级控件不作为候选，继续扫描其中的正文。
            if (!ScanExistingControl(blockControl, path, candidates, seen, ref order) && blockControl.SdtContentBlock is { } content)
            {
                ScanChildren(content.ChildElements.ToList(), $"{path}/content", candidates, seen, ref order);
            }
            return;
        }

        if (element is Wp.SdtCell or Wp.SdtRow)
        {
            return;
        }

        if (element is Wp.Paragraph paragraph)
        {
            ScanParagraph(paragraph, path, candidates, seen, ref order);
            return;
        }

        if (element is Wp.Table table)
        {
            ScanTable(table, path, TableIdFromPath(path), null, candidates, seen, ref order);
            return;
        }

        ScanChildren(element.ChildElements.ToList(), path, candidates, seen, ref order);
    }

    static void ScanChildren(
        IReadOnlyList<OpenXmlElement> children,
        string path,
        List<TemplateFieldCandidate> candidates,
        HashSet<string> seen,
        ref int order)
    {
        for (var index = 0; index < children.Count; index += 1)
        {
            var child = children[index];
            var childPath = $"{path}/{index}:{child.LocalName}";
            var checkboxGroup = CollectCheckboxParagraphs(children, index);
            if (checkboxGroup.Count >= 2)
            {
                AddCheckboxGroup(checkboxGroup, childPath, SuggestGroupName(children, index), candidates, seen, ref order);
                index += checkboxGroup.Count - 1;
                continue;
            }
            ScanElement(child, childPath, candidates, seen, ref order);
        }
    }

    static void ScanTable(
        Wp.Table table,
        string path,
        string tableId,
        string? tableTitle,
        List<TemplateFieldCandidate> candidates,
        HashSet<string> seen,
        ref int order)
    {
        var rows = BuildTableRows(table);
        var columnCount = Math.Max(
            table.GetFirstChild<Wp.TableGrid>()?.Elements<Wp.GridColumn>().Count() ?? 0,
            rows.SelectMany(item => item.Cells).Select(item => item.ColumnStart + item.ColumnSpan).DefaultIfEmpty(0).Max());
        var firstMeaningfulRow = rows.FirstOrDefault(item => item.Cells.Any(cell => cell.Text.Length > 0));
        var internalTitleRow = firstMeaningfulRow is not null
            && TryReadFullWidthText(firstMeaningfulRow, columnCount, out var firstRowText)
            && IsTableTitle(firstRowText)
                ? firstMeaningfulRow
                : null;
        var effectiveTableTitle = internalTitleRow is null
            ? tableTitle
            : TryReadFullWidthText(internalTitleRow, columnCount, out var internalTitle) ? internalTitle : tableTitle;
        var activeHeaders = new string?[columnCount];
        string? groupTitle = null;
        var mayInferHeader = true;
        var previousWasHeader = false;

        foreach (var row in rows)
        {
            var isInternalTitle = ReferenceEquals(row, internalTitleRow);
            var isFullWidthText = TryReadFullWidthText(row, columnCount, out var fullWidthText);
            var isGroup = isFullWidthText && !isInternalTitle && IsGroupTitle(fullWidthText);
            var explicitHeader = HasExplicitTableHeader(row.Row);
            var isHeader = !isGroup && (explicitHeader || mayInferHeader && IsHeaderShaped(row, columnCount));

            if (isGroup)
            {
                groupTitle = Optional(Limit(fullWidthText, 120));
                mayInferHeader = true;
                previousWasHeader = false;
            }
            else if (isHeader)
            {
                if (!previousWasHeader)
                {
                    Array.Clear(activeHeaders);
                }
                MergeColumnHeaders(activeHeaders, row);
                mayInferHeader = false;
                previousWasHeader = true;
            }
            else if (!isInternalTitle)
            {
                mayInferHeader = false;
                previousWasHeader = false;
            }

            var rowTexts = row.Cells.Select(item => ReadCellText(item.Cell)).ToList();
            foreach (var cellInfo in row.Cells)
            {
                var cell = cellInfo.Cell;
                var cellPath = $"{path}/row/{row.RowIndex}/cell/{cellInfo.CellIndex}";
                var firstCandidate = candidates.Count;
                var rowContext = BuildCellContext(row, cellInfo);
                var columnHeader = ReadColumnHeader(activeHeaders, cellInfo.ColumnStart, cellInfo.ColumnSpan);
                var cellLabel = FindCellLabel(row, cellInfo, columnHeader);
                var cellName = CleanName(SplitLabelHint(cellLabel).Core);
                var paragraphs = cell.Elements<Wp.Paragraph>().ToList();
                ScanChildren(paragraphs, $"{cellPath}/p", candidates, seen, ref order);

                if (IsSimpleEmptyCell(cell, rowTexts[cellInfo.CellIndex]))
                {
                    var targetParagraph = paragraphs.FirstOrDefault();
                    if (targetParagraph is not null)
                    {
                        AddCandidate(
                            candidates,
                            seen,
                            ref order,
                            kind: TemplateFieldKinds.EmptyTableCell,
                            location: $"{cellPath}/p/0",
                            text: "",
                            context: rowContext,
                            suggestedName: cellName,
                            suggestedFillBy: SuggestFillBy(cellLabel, ""),
                            target: targetParagraph,
                            start: 0,
                            length: 0);
                    }
                }

                for (var index = firstCandidate; index < candidates.Count; index += 1)
                {
                    var candidate = candidates[index];
                    // 同行信息只补充到输出，不参与稳定 candidate_id。
                    candidate.Context = Optional(MergeCellContext(rowContext, candidate.Context));
                    candidate.SuggestedName ??= Optional(Limit(cellName, 80));
                    candidate.TableTitle = Optional(Limit(effectiveTableTitle ?? "", 120));
                    candidate.ColumnHeader = Optional(Limit(columnHeader, 120));
                    candidate.GroupTitle = groupTitle;
                    candidate.TableId = tableId;
                    candidate.RowNumber = row.RowIndex + 1;
                    candidate.ColumnNumber = cellInfo.ColumnStart + 1;
                    candidate.OutputLocation = null;
                }
            }
        }
    }

    /// <summary>键值表取紧邻左侧标签，清单表取列头；都没有时取同行更左侧的标签。</summary>
    static string FindCellLabel(TableRowInfo row, TableCellInfo self, string columnHeader)
    {
        var leftCells = row.Cells
            .Where(item => item.ColumnStart + item.ColumnSpan <= self.ColumnStart)
            .OrderByDescending(item => item.ColumnStart)
            .ToList();
        var adjacent = leftCells.FirstOrDefault();
        if (adjacent is not null
            && adjacent.ColumnStart + adjacent.ColumnSpan == self.ColumnStart
            && IsLabelText(adjacent.Text))
        {
            return adjacent.Text;
        }
        if (columnHeader.Length > 0) return columnHeader;
        return leftCells.FirstOrDefault(item => IsLabelText(item.Text))?.Text ?? "";
    }

    static bool IsLabelText(string text)
    {
        return text.Length is > 0 and <= 40
            && !PlaceholderPattern.IsMatch(text)
            && !CheckboxOptionPattern.IsMatch(text);
    }

    /// <summary>校验抽章阶段记录的目标正文范围，保持原顺序供扫描定位。</summary>
    static List<TemplateChapterRange> NormalizeChapterRanges(
        IReadOnlyList<TemplateChapterRange>? chapterRanges,
        int blockCount)
    {
        var result = new List<TemplateChapterRange>();
        var previousEnd = 0;
        foreach (var item in chapterRanges ?? [])
        {
            var title = (item.Title ?? "").Trim();
            if (title.Length == 0
                || item.StartBlock < 0
                || item.EndBlock <= item.StartBlock
                || item.EndBlock > blockCount
                || result.Count > 0 && item.StartBlock < previousEnd)
            {
                throw new InvalidOperationException("投标模版章节范围文件无效");
            }

            result.Add(new TemplateChapterRange
            {
                Id = Optional(item.Id),
                Title = title,
                StartBlock = item.StartBlock,
                EndBlock = item.EndBlock,
            });
            previousEnd = item.EndBlock;
        }
        return result;
    }

    static TemplateChapterRange? FindChapter(IReadOnlyList<TemplateChapterRange> chapters, int blockIndex)
    {
        return chapters.FirstOrDefault(item => blockIndex >= item.StartBlock && blockIndex < item.EndBlock);
    }

    /// <summary>只采用同章内明确的标题段或表名，避免把普通标签误作表题。</summary>
    static string? FindTableTitle(
        Wp.Body body,
        int tableBlockIndex,
        TemplateChapterRange? chapter)
    {
        var lowerBound = chapter?.StartBlock ?? 0;
        for (var index = tableBlockIndex - 1; index >= lowerBound; index -= 1)
        {
            var block = body.ChildElements[index];
            if (block is Wp.Table) break;
            if (block is not Wp.Paragraph paragraph) continue;
            var text = WordWorkspace.Normalize(paragraph.InnerText ?? "");
            if (text.Length == 0) continue;
            if (IsTableTitle(text)) return Limit(text, 120);
            if (IsHeadingParagraph(paragraph)) break;
        }
        return null;
    }

    static bool IsHeadingParagraph(Wp.Paragraph paragraph)
    {
        var outlineLevel = paragraph.ParagraphProperties?.OutlineLevel?.Val?.Value;
        if (outlineLevel is not null && outlineLevel.Value < 9) return true;
        var styleId = paragraph.ParagraphProperties?.ParagraphStyleId?.Val?.Value ?? "";
        return styleId.StartsWith("Heading", StringComparison.OrdinalIgnoreCase)
            || styleId.StartsWith("标题", StringComparison.Ordinal);
    }

    static bool IsTableTitle(string value)
    {
        var text = WordWorkspace.Normalize(value);
        return text.Length is > 0 and <= 100 && TableTitlePattern.IsMatch(text);
    }

    static bool IsGroupTitle(string value)
    {
        var text = WordWorkspace.Normalize(value);
        var isNumbered = NumberedGroupPattern.IsMatch(text);
        var sentenceText = isNumbered ? text.TrimEnd('：', ':') : text;
        if (text.Length is 0 or > 80 || SentenceLikePattern.IsMatch(sentenceText)) return false;
        return text.Length <= 30 || isNumbered;
    }

    /// <summary>把物理单元格映射到 Word 表格逻辑网格，跨列单元格占用连续逻辑列。</summary>
    static List<TableRowInfo> BuildTableRows(Wp.Table table)
    {
        var result = new List<TableRowInfo>();
        var rows = table.Elements<Wp.TableRow>().ToList();
        for (var rowIndex = 0; rowIndex < rows.Count; rowIndex += 1)
        {
            var row = rows[rowIndex];
            var column = row.TableRowProperties?.GetFirstChild<Wp.GridBefore>()?.Val?.Value ?? 0;
            var cells = new List<TableCellInfo>();
            var physicalCells = row.Elements<Wp.TableCell>().ToList();
            for (var cellIndex = 0; cellIndex < physicalCells.Count; cellIndex += 1)
            {
                var cell = physicalCells[cellIndex];
                var span = Math.Max(1, cell.TableCellProperties?.GridSpan?.Val?.Value ?? 1);
                cells.Add(new TableCellInfo(
                    cell,
                    cellIndex,
                    column,
                    span,
                    WordWorkspace.Normalize(cell.InnerText ?? "")));
                column += span;
            }
            result.Add(new TableRowInfo(row, rowIndex, cells));
        }
        return result;
    }

    static bool TryReadFullWidthText(TableRowInfo row, int columnCount, out string text)
    {
        text = "";
        if (columnCount <= 0) return false;
        var nonEmpty = row.Cells.Where(item => item.Text.Length > 0).ToList();
        if (nonEmpty.Count != 1) return false;
        var cell = nonEmpty[0];
        if (cell.ColumnStart != 0 || cell.ColumnSpan < columnCount) return false;
        text = cell.Text;
        return true;
    }

    static bool HasExplicitTableHeader(Wp.TableRow row)
    {
        return row.TableRowProperties?.GetFirstChild<Wp.TableHeader>() is not null;
    }

    /// <summary>保守识别三列以上表格起始处或分组后的短文本表头行。</summary>
    static bool IsHeaderShaped(TableRowInfo row, int columnCount)
    {
        if (columnCount <= 2) return false;
        var nonEmpty = row.Cells.Where(item => item.Text.Length > 0).ToList();
        if (nonEmpty.Count < 3
            || nonEmpty.Any(item => item.Text.Length > 30
                || SentenceLikePattern.IsMatch(item.Text)
                || PlaceholderPattern.IsMatch(item.Text)))
        {
            return false;
        }
        var coveredColumns = nonEmpty.Sum(item => item.ColumnSpan);
        var formattedCells = nonEmpty.Count(HasHeaderFormatting);
        return coveredColumns >= Math.Max(3, (int)Math.Ceiling(columnCount * 0.6))
            && formattedCells >= (int)Math.Ceiling(nonEmpty.Count * 0.6);
    }

    /// <summary>读取单元格直接格式，只把明显的表头视觉特征作为推断依据。</summary>
    static bool HasHeaderFormatting(TableCellInfo cell)
    {
        var centered = cell.Cell.Elements<Wp.Paragraph>().Any(paragraph =>
            paragraph.ParagraphProperties?.Justification?.Val?.Value == Wp.JustificationValues.Center);
        var bold = cell.Cell.Descendants<Wp.Run>().Any(run =>
            run.RunProperties?.Bold is { } value && (value.Val is null || value.Val.Value));
        var fill = cell.Cell.TableCellProperties?.GetFirstChild<Wp.Shading>()?.Fill?.Value ?? "";
        var shaded = fill.Length > 0
            && !string.Equals(fill, "auto", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(fill, "FFFFFF", StringComparison.OrdinalIgnoreCase);
        return centered || bold || shaded;
    }

    static void MergeColumnHeaders(string?[] headers, TableRowInfo row)
    {
        foreach (var cell in row.Cells.Where(item => item.Text.Length > 0))
        {
            var end = Math.Min(headers.Length, cell.ColumnStart + cell.ColumnSpan);
            for (var column = Math.Max(0, cell.ColumnStart); column < end; column += 1)
            {
                var current = headers[column];
                if (current is null)
                {
                    headers[column] = cell.Text;
                }
                else if (!current.Split(" / ", StringSplitOptions.None).Contains(cell.Text, StringComparer.Ordinal))
                {
                    headers[column] = $"{current} / {cell.Text}";
                }
            }
        }
    }

    static string ReadColumnHeader(string?[] headers, int columnStart, int columnSpan)
    {
        if (headers.Length == 0 || columnStart >= headers.Length) return "";
        var end = Math.Min(headers.Length, columnStart + columnSpan);
        return string.Join(
            " / ",
            headers[Math.Max(0, columnStart)..end]
                .Where(item => !string.IsNullOrWhiteSpace(item))
                .Distinct(StringComparer.Ordinal));
    }

    /// <summary>相同章节、表格、列和分组只写一次，候选通过 context_id 引用。</summary>
    static void BuildStructureContexts(TemplateFieldCandidateFile result)
    {
        var ids = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var candidate in result.Candidates)
        {
            if (candidate.ChapterName is null
                && candidate.TableTitle is null
                && candidate.ColumnHeader is null
                && candidate.GroupTitle is null)
            {
                continue;
            }

            var key = $"{candidate.ChapterName}\u0000{candidate.TableTitle}\u0000{candidate.ColumnHeader}\u0000{candidate.GroupTitle}";
            if (!ids.TryGetValue(key, out var contextId))
            {
                contextId = $"ctx_{result.Contexts.Count + 1:D4}";
                ids[key] = contextId;
                result.Contexts.Add(new TemplateFieldStructureContext
                {
                    ContextId = contextId,
                    ChapterName = candidate.ChapterName,
                    TableTitle = candidate.TableTitle,
                    ColumnHeader = candidate.ColumnHeader,
                    GroupTitle = candidate.GroupTitle,
                });
            }
            candidate.StructureContextId = contextId;
        }
    }

    /// <summary>只把显示占位、内容为空或已带易标字段标识的控件作为候选；返回是否已作为候选。</summary>
    static bool ScanExistingControl(
        OpenXmlElement control,
        string path,
        List<TemplateFieldCandidate> candidates,
        HashSet<string> seen,
        ref int order)
    {
        var properties = control switch
        {
            Wp.SdtRun run => run.SdtProperties,
            Wp.SdtBlock block => block.SdtProperties,
            _ => null,
        };
        var name = properties?.GetFirstChild<Wp.SdtAlias>()?.Val?.Value?.Trim() ?? "";
        var tag = properties?.GetFirstChild<Wp.Tag>()?.Val?.Value ?? "";
        var showingPlaceholder = properties?.GetFirstChild<Wp.ShowingPlaceholder>() is not null;
        var controlText = WordWorkspace.Normalize(control.InnerText ?? "");
        if (controlText.Length > 0
            && !showingPlaceholder
            && !tag.StartsWith(TemplateFieldSdtWriter.TagPrefix, StringComparison.Ordinal))
        {
            return false;
        }

        AddCandidate(
            candidates,
            seen,
            ref order,
            kind: TemplateFieldKinds.ExistingControl,
            location: path,
            text: controlText,
            context: Limit(controlText, 200),
            suggestedName: name.Length > 0 ? name : SuggestName(controlText),
            suggestedFillBy: SuggestFillBy(name.Length > 0 ? name : controlText, ""),
            target: control,
            start: 0,
            length: 0);
        return true;
    }

    static void ScanParagraph(
        Wp.Paragraph paragraph,
        string path,
        List<TemplateFieldCandidate> candidates,
        HashSet<string> seen,
        ref int order,
        Wp.Paragraph? fallback = null)
    {
        ScanTextBoxes(paragraph, path, candidates, seen, ref order);
        var existingControls = paragraph.Descendants<Wp.SdtRun>()
            .Where(item => ReferenceEquals(item.Ancestors<Wp.Paragraph>().FirstOrDefault(), paragraph))
            .ToList();
        if (existingControls.Count > 0)
        {
            for (var index = 0; index < existingControls.Count; index += 1)
            {
                ScanExistingControl(existingControls[index], $"{path}/sdt/{index}", candidates, seen, ref order);
            }
            return;
        }

        if (!IsSimpleParagraph(paragraph)) return;
        var text = ReadParagraphText(paragraph);
        if (text.Length == 0)
        {
            return;
        }

        foreach (var hit in FindParagraphCandidates(text, ReadUnderlineMap(paragraph, text.Length)))
        {
            AddCandidate(
                candidates,
                seen,
                ref order,
                kind: hit.Kind,
                location: path,
                text: text.Substring(hit.Start, hit.Length),
                context: BuildMarkedContext(text, hit.Start, hit.Length),
                suggestedName: hit.Name,
                suggestedFillBy: hit.FillBy,
                target: paragraph,
                start: hit.Start,
                length: hit.Length,
                options: hit.Options,
                fallback: fallback);
        }
    }

    /// <summary>扫描文本框段落；mc:AlternateContent 只扫 Choice，并记录 Fallback 中同文段落供写入时同步。</summary>
    static void ScanTextBoxes(
        Wp.Paragraph paragraph,
        string path,
        List<TemplateFieldCandidate> candidates,
        HashSet<string> seen,
        ref int order)
    {
        var boxes = new List<(Wp.Paragraph Paragraph, Wp.Paragraph? Fallback)>();
        foreach (var alternate in paragraph.Descendants<AlternateContent>().Where(item => !item.Ancestors<AlternateContent>().Any()))
        {
            var choice = alternate.GetFirstChild<AlternateContentChoice>();
            if (choice is null) continue;
            var choiceParagraphs = ReadTextBoxParagraphs(choice);
            var fallbackParagraphs = alternate.GetFirstChild<AlternateContentFallback>() is { } fallbackRoot
                ? ReadTextBoxParagraphs(fallbackRoot)
                : [];
            var paired = fallbackParagraphs.Count == choiceParagraphs.Count;
            for (var index = 0; index < choiceParagraphs.Count; index += 1)
            {
                var candidate = paired ? fallbackParagraphs[index] : null;
                var sameText = candidate is not null
                    && IsSimpleParagraph(candidate)
                    && string.Equals(ReadParagraphText(candidate), ReadParagraphText(choiceParagraphs[index]), StringComparison.Ordinal);
                boxes.Add((choiceParagraphs[index], sameText ? candidate : null));
            }
        }

        foreach (var content in paragraph.Descendants<Wp.TextBoxContent>().Where(item => !item.Ancestors<AlternateContent>().Any()))
        {
            boxes.AddRange(content.Elements<Wp.Paragraph>().Select(item => (item, (Wp.Paragraph?)null)));
        }

        for (var index = 0; index < boxes.Count; index += 1)
        {
            ScanParagraph(boxes[index].Paragraph, $"{path}/txbx/{index}", candidates, seen, ref order, boxes[index].Fallback);
        }
    }

    static List<Wp.Paragraph> ReadTextBoxParagraphs(OpenXmlElement root)
    {
        return root.Descendants<Wp.TextBoxContent>()
            .Where(item => !item.Ancestors<Wp.TextBoxContent>().Any())
            .SelectMany(item => item.Elements<Wp.Paragraph>())
            .ToList();
    }

    /// <summary>按优先级识别段落内候选，后识别的类型不与已识别范围重叠。</summary>
    static List<ParagraphHit> FindParagraphCandidates(string text, bool[] underlined)
    {
        var hits = new List<ParagraphHit>();
        bool Overlaps(int start, int length) => hits.Any(hit => RangesOverlap(hit.Start, hit.Length, start, length));
        void AddBlank(string kind, int start, int length, string? name = null)
        {
            if (Overlaps(start, length)) return;
            var (label, hint) = ReadBlankContext(text, start, length);
            hits.Add(new ParagraphHit(kind, start, length, name ?? SuggestBlankName(text, start, length), SuggestFillBy(label, hint)));
        }

        foreach (Match match in PlaceholderPattern.Matches(text))
        {
            var explicitName = ExplicitNamePattern.Match(match.Value).Groups["name"].Value.Trim();
            AddBlank(TemplateFieldKinds.TextPlaceholder, match.Index, match.Length, explicitName.Length > 0 ? CleanName(explicitName) : null);
        }

        foreach (Match match in BracketHintPattern.Matches(text))
        {
            var hint = match.Groups["hint"].Value;
            if (!IsUnderlined(underlined, match.Index, match.Length) || !IsPlaceholderHint(hint, requireNameHint: false)) continue;
            var start = match.Index;
            var end = match.Index + match.Length;
            while (start > 0 && underlined[start - 1] && IsBlankChar(text[start - 1])) start -= 1;
            while (end < text.Length && underlined[end] && IsBlankChar(text[end])) end += 1;
            AddBlank(TemplateFieldKinds.HintPlaceholder, start, end - start, CleanName(hint));
        }

        foreach (var blank in FindUnderlinedWhitespace(underlined, text))
        {
            AddBlank(TemplateFieldKinds.UnderlinedSpace, blank.Start, blank.Length);
        }

        foreach (Match match in BracketHintPattern.Matches(text))
        {
            var hint = match.Groups["hint"].Value;
            if (!IsPlaceholderHint(hint, requireNameHint: true)) continue;
            AddBlank(TemplateFieldKinds.HintPlaceholder, match.Index, match.Length, CleanName(hint));
        }

        var gap = BlankGapPattern.Match(text);
        if (gap.Success && IsSignatureOrStamp(gap.Groups["hint"].Value))
        {
            var start = gap.Groups["gap"].Index;
            if (!hits.Any(hit => hit.Start >= start))
            {
                AddBlank(TemplateFieldKinds.BlankGap, start, gap.Groups["gap"].Length, CleanName(gap.Groups["label"].Value));
            }
        }

        foreach (Match match in DateGapPattern.Matches(text))
        {
            foreach (var unit in new[] { "y", "m", "d" })
            {
                var group = match.Groups[unit];
                AddBlank(TemplateFieldKinds.BlankGap, group.Index, group.Length);
            }
        }

        var boxes = CheckboxOptionPattern.Matches(text).Cast<Match>().ToList();
        var options = boxes.Select(item => TrimOption(item.Groups["option"].Value)).Where(item => item.Length > 0).ToList();
        if (options.Count >= 2)
        {
            var start = boxes[0].Index;
            var lastOption = boxes[^1].Groups["option"];
            var end = lastOption.Index + lastOption.Value.TrimEnd().Length;
            if (!Overlaps(start, end - start))
            {
                hits.Add(new ParagraphHit(TemplateFieldKinds.CheckboxGroup, start, end - start, SuggestName(text[..start]), "ai", options));
            }
        }

        var note = AttachmentNotePattern.Match(text);
        if (note.Success && !Overlaps(text.Length, 0))
        {
            hits.Add(new ParagraphHit(TemplateFieldKinds.AttachmentNote, text.Length, 0, CleanMaterialName(note.Groups["material"].Value), "manual"));
        }

        var trimmed = text.Trim();
        var slot = AttachmentSlotPattern.Match(trimmed);
        if (hits.Count == 0 && slot.Success)
        {
            hits.Add(new ParagraphHit(
                TemplateFieldKinds.AttachmentSlot,
                text.IndexOf(trimmed, StringComparison.Ordinal),
                trimmed.Length,
                CleanName(slot.Groups["name"].Value),
                "manual"));
        }

        var trailing = TrailingLabelPattern.Match(text);
        if (trailing.Success && IsAfterLabel(text, trailing) && !Overlaps(text.Length, 0))
        {
            var label = trailing.Groups["label"].Value.Trim();
            hits.Add(new ParagraphHit(TemplateFieldKinds.AfterLabel, text.Length, 0, CleanName(label), SuggestFillBy(label, "")));
        }

        return hits.OrderBy(hit => hit.Start).ThenBy(hit => hit.Length).ToList();
    }

    static bool RangesOverlap(int firstStart, int firstLength, int secondStart, int secondLength)
    {
        if (firstLength == 0 && secondLength == 0) return firstStart == secondStart;
        if (firstLength == 0) return firstStart > secondStart && firstStart < secondStart + secondLength;
        if (secondLength == 0) return secondStart > firstStart && secondStart < firstStart + firstLength;
        return firstStart < secondStart + secondLength && secondStart < firstStart + firstLength;
    }

    /// <summary>括号提示作为占位时不能是签字盖章、材料说明或内含空白的标签。</summary>
    static bool IsPlaceholderHint(string hint, bool requireNameHint)
    {
        var value = hint.Trim();
        if (value.Length == 0 || InnerBlankPattern.IsMatch(hint)) return false;
        if (IsSignatureOrStamp(value) || MaterialPattern.IsMatch(value)) return false;
        return !requireNameHint || NameHintPattern.IsMatch(value);
    }

    static bool IsSignatureOrStamp(string value)
    {
        return SignaturePattern.IsMatch(value) || StampPattern.IsMatch(value);
    }

    /// <summary>句末“如下：”或长句结尾的冒号不是待填标签。</summary>
    static bool IsAfterLabel(string text, Match trailing)
    {
        var label = trailing.Groups["label"].Value.Trim();
        if (AfterLabelExcludePattern.IsMatch(label) || label.Length > 12) return false;
        var before = text[..trailing.Index].TrimEnd();
        var endsWithSentence = before.Length > 0 && before[^1] is '。' or '！' or '？' or '!' or '?';
        return !(endsWithSentence && label.Length > 6);
    }

    static bool[] ReadUnderlineMap(Wp.Paragraph paragraph, int length)
    {
        var result = new bool[length];
        var offset = 0;
        foreach (var run in paragraph.Elements<Wp.Run>())
        {
            var runLength = run.Elements<Wp.Text>().Sum(item => item.Text.Length);
            var underline = run.RunProperties?.Underline;
            if (underline is not null && underline.Val?.Value != Wp.UnderlineValues.None)
            {
                for (var index = offset; index < Math.Min(length, offset + runLength); index += 1)
                {
                    result[index] = true;
                }
            }
            offset += runLength;
        }
        return result;
    }

    static bool IsUnderlined(bool[] underlined, int start, int length)
    {
        for (var index = start; index < start + length; index += 1)
        {
            if (index >= underlined.Length || !underlined[index]) return false;
        }
        return length > 0;
    }

    static bool IsBlankChar(char value)
    {
        return value == '　' || char.IsWhiteSpace(value);
    }

    static bool IsSimpleParagraph(Wp.Paragraph paragraph)
    {
        if (paragraph.Descendants<Wp.FieldChar>().Any()
            || paragraph.Descendants<Wp.FieldCode>().Any()
            || paragraph.Descendants<Wp.Drawing>().Any()
            || paragraph.Descendants<Wp.DeletedRun>().Any()
            || paragraph.Descendants<Wp.InsertedRun>().Any()
            || paragraph.Descendants<Wp.Hyperlink>().Any())
        {
            return false;
        }

        if (!paragraph.ChildElements.All(item => item is Wp.ParagraphProperties or Wp.Run))
        {
            return false;
        }

        return paragraph.Elements<Wp.Run>()
            .All(run => run.ChildElements.All(item => item is Wp.RunProperties or Wp.Text));
    }

    static string ReadParagraphText(Wp.Paragraph paragraph)
    {
        var builder = new StringBuilder();
        foreach (var run in paragraph.Elements<Wp.Run>())
        {
            foreach (var text in run.Elements<Wp.Text>())
            {
                builder.Append(text.Text);
            }
        }
        return builder.ToString();
    }

    /// <summary>相邻带下划线的空白合并为一个空位，跨 run 也按一个计算。</summary>
    static List<(int Start, int Length)> FindUnderlinedWhitespace(bool[] underlined, string text)
    {
        var result = new List<(int Start, int Length)>();
        var index = 0;
        while (index < text.Length)
        {
            if (!underlined[index] || !IsBlankChar(text[index]))
            {
                index += 1;
                continue;
            }
            var start = index;
            while (index < text.Length && underlined[index] && IsBlankChar(text[index])) index += 1;
            if (index - start >= 2) result.Add((start, index - start));
        }
        return result;
    }

    static List<Wp.Paragraph> CollectCheckboxParagraphs(IReadOnlyList<OpenXmlElement> siblings, int index)
    {
        var group = new List<Wp.Paragraph>();
        for (var cursor = index; cursor < siblings.Count; cursor += 1)
        {
            if (siblings[cursor] is not Wp.Paragraph paragraph || !IsCheckboxOptionParagraph(paragraph)) break;
            group.Add(paragraph);
        }
        return group;
    }

    /// <summary>单独成段、以方框开头且只有一个选项的段落视为勾选项。</summary>
    static bool IsCheckboxOptionParagraph(Wp.Paragraph paragraph)
    {
        if (!IsSimpleParagraph(paragraph)) return false;
        var text = ReadParagraphText(paragraph).Trim();
        return text.Length > 1
            && (text[0] is '□' or '☐')
            && CheckboxOptionPattern.Matches(text).Count == 1;
    }

    static string SuggestGroupName(IReadOnlyList<OpenXmlElement> siblings, int index)
    {
        if (index == 0 || siblings[index - 1] is not Wp.Paragraph previous) return "";
        var label = TrailingLabelPattern.Match(ReadParagraphText(previous));
        return label.Success ? CleanName(label.Groups["label"].Value) : "";
    }

    static void AddCheckboxGroup(
        List<Wp.Paragraph> group,
        string path,
        string name,
        List<TemplateFieldCandidate> candidates,
        HashSet<string> seen,
        ref int order)
    {
        var texts = group.Select(item => ReadParagraphText(item).Trim()).ToList();
        AddCandidate(
            candidates,
            seen,
            ref order,
            kind: TemplateFieldKinds.CheckboxGroup,
            location: path,
            text: "",
            context: $"【▢{string.Join(" / ", texts)}】",
            suggestedName: name,
            suggestedFillBy: "ai",
            target: group[0],
            start: 0,
            length: 0,
            options: texts.Select(item => TrimOption(item[1..])).Where(item => item.Length > 0).ToList(),
            targetGroup: group);
    }

    internal static string TrimOption(string value)
    {
        return value.Trim().TrimEnd('，', ',', '；', ';', '。', '、').Trim();
    }

    /// <summary>取“后附”后的材料说明作为建议名称，去掉末尾未闭合的括号说明。</summary>
    static string CleanMaterialName(string value)
    {
        var name = value.Trim().TrimStart('、', '，', ',', '：', ':');
        var bracket = name.LastIndexOfAny(['（', '(']);
        if (bracket > 0 && name.IndexOfAny(['）', ')'], bracket) < 0) name = name[..bracket];
        return CleanName(name);
    }

    static bool IsSimpleEmptyCell(Wp.TableCell cell, string text)
    {
        if (text.Length > 0) return false;
        if (cell.Elements<Wp.Table>().Any()
            || cell.Descendants<Wp.Drawing>().Any()
            || cell.Descendants<Wp.FieldChar>().Any()
            || cell.Descendants<Wp.SdtElement>().Any())
        {
            return false;
        }

        var merge = cell.TableCellProperties?.VerticalMerge;
        if (merge is not null && merge.Val?.Value != Wp.MergedCellValues.Restart) return false;
        return cell.Elements<Wp.Paragraph>().Count() == 1;
    }

    static string ReadCellText(Wp.TableCell cell)
    {
        return WordWorkspace.Normalize(string.Join(" ", cell.Elements<Wp.Paragraph>().Select(ReadParagraphText)));
    }

    /// <summary>按网格列列出同行内容，并用【▢第N列】标出当前单元格。</summary>
    static string BuildCellContext(TableRowInfo row, TableCellInfo self)
    {
        var parts = new List<string>();
        foreach (var item in row.Cells.OrderBy(cell => cell.ColumnStart))
        {
            var column = item.ColumnStart + 1;
            if (ReferenceEquals(item, self))
            {
                parts.Add($"【▢第{column}列】");
            }
            else if (item.Text.Length > 0)
            {
                parts.Add($"第{column}列：{Limit(item.Text, CellContextTextLimit)}");
            }
        }
        return Limit(string.Join("；", parts), 240);
    }

    /// <summary>把同行标签放在候选自身内容前，截断时优先保留字段语义。</summary>
    static string MergeCellContext(string rowContext, string? candidateContext)
    {
        var ownContext = candidateContext ?? "";
        if (rowContext.Length == 0 || string.Equals(rowContext, ownContext, StringComparison.Ordinal)) return ownContext;
        if (ownContext.Length == 0) return rowContext;
        return Limit($"{rowContext}；{ownContext}", 240);
    }

    /// <summary>在候选位置插入【▢原文】标记，同段多个空位据此区分。</summary>
    static string BuildMarkedContext(string text, int start, int length)
    {
        var from = Math.Max(0, start - ContextRadius);
        var to = Math.Min(text.Length, start + length + ContextRadius);
        var target = text.Substring(start, length).Trim();
        return $"{text[from..start]}【▢{target}】{text[(start + length)..to]}".Replace('\t', ' ');
    }

    /// <summary>空位后紧跟年/月/日时取日期表达式前的标签并加单位，其余取空位前的标签。</summary>
    static string SuggestBlankName(string text, int start, int length)
    {
        var after = text[Math.Min(text.Length, start + length)..].TrimStart();
        var unit = after.Length > 0 && after[0] is '年' or '月' or '日' ? after[0].ToString() : "";
        if (unit.Length == 0) return SuggestName(StripTrailingHint(text[..start]));
        var expressionStart = start;
        while (expressionStart > 0 && IsDateExpressionChar(text[expressionStart - 1])) expressionStart -= 1;
        var label = SuggestName(StripTrailingHint(text[..expressionStart]));
        return $"{(label.Length > 0 ? label : "日期")}（{unit}）";
    }

    static bool IsDateExpressionChar(char value)
    {
        return IsBlankChar(value)
            || value is >= '0' and <= '9'
            || value is >= '０' and <= '９'
            || value is '年' or '月';
    }

    /// <summary>读取空位自身的标签和紧邻括号提示，供建议填写方式使用。</summary>
    static (string Label, string Hint) ReadBlankContext(string text, int start, int length)
    {
        var before = text[..start].TrimEnd();
        var hints = new List<string>();
        var trailingHint = TrailingHintPattern.Match(before);
        if (trailingHint.Success)
        {
            hints.Add(trailingHint.Groups["hint"].Value);
            before = before[..trailingHint.Index].TrimEnd();
        }
        var labelMatch = TrailingLabelPattern.Match(before);
        var label = labelMatch.Success ? labelMatch.Groups["label"].Value.Trim() : "";
        var leadingHint = LeadingHintPattern.Match(text[Math.Min(text.Length, start + length)..]);
        if (leadingHint.Success) hints.Add(leadingHint.Groups["hint"].Value);
        return (label, string.Join(" ", hints));
    }

    static (string Core, string Hint) SplitLabelHint(string label)
    {
        var value = (label ?? "").Trim();
        var hint = TrailingHintPattern.Match(value);
        return hint.Success
            ? (value[..hint.Index].Trim(), hint.Groups["hint"].Value)
            : (value, "");
    }

    static string StripTrailingHint(string value)
    {
        return TrailingHintPattern.Replace(value.TrimEnd(), "");
    }

    static string SuggestName(string context)
    {
        var value = WordWorkspace.Normalize(context);
        var explicitName = ExplicitNamePattern.Match(value).Groups["name"].Value.Trim();
        if (explicitName.Length > 0) return CleanName(explicitName);
        var label = TrailingLabelPattern.Match(value).Groups["label"].Value.Trim();
        if (label.Length > 0) return TakeUnclosedBracketText(CleanName(label));
        var pieces = Regex.Split(value, @"[：:；;，,。\s]+", RegexOptions.CultureInvariant)
            .Select(CleanName)
            .Where(item => item.Length >= 2 && item.Length <= 30)
            .ToList();
        return TakeUnclosedBracketText(pieces.LastOrDefault() ?? "");
    }

    /// <summary>“参加（招标编号”“的法定代表人（职务”这类未闭合括号内的文字才是空位标签。</summary>
    static string TakeUnclosedBracketText(string value)
    {
        var open = value.LastIndexOfAny(['（', '(']);
        return open >= 0 && open + 1 < value.Length && value.IndexOfAny(['）', ')'], open) < 0
            ? CleanName(value[(open + 1)..])
            : value;
    }

    static string CleanName(string value)
    {
        return Regex.Replace(value ?? "", @"^[\s（(]*|[\s）)＿_]+$", "").Trim();
    }

    /// <summary>签字类或纯盖章区建议人工；名称等文字旁的盖章提示仍由程序填写文字。</summary>
    static string SuggestFillBy(string label, string hint)
    {
        var (core, labelHint) = SplitLabelHint(label);
        var hints = $"{hint} {labelHint}";
        if (SignaturePattern.IsMatch(core) || SignaturePattern.IsMatch(hints)) return "manual";
        if (StampLabelEndPattern.IsMatch(core)) return "manual";
        if (CleanName(core).Length == 0 && StampPattern.IsMatch(hints)) return "manual";
        return "ai";
    }

    static string TableIdFromPath(string path)
    {
        return $"t{string.Join("_", Regex.Matches(path, @"\d+").Select(item => item.Value))}";
    }

    static void AddCandidate(
        List<TemplateFieldCandidate> candidates,
        HashSet<string> seen,
        ref int order,
        string kind,
        string location,
        string text,
        string context,
        string suggestedName,
        string suggestedFillBy,
        OpenXmlElement target,
        int start,
        int length,
        List<string>? options = null,
        List<Wp.Paragraph>? targetGroup = null,
        Wp.Paragraph? fallback = null)
    {
        var identity = $"v2\u0000{location}\u0000{kind}\u0000{start}\u0000{length}\u0000{text}\u0000{context}";
        var candidateId = $"c_{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)))[..16].ToLowerInvariant()}";
        if (!seen.Add(candidateId)) return;
        candidates.Add(new TemplateFieldCandidate
        {
            CandidateId = candidateId,
            Kind = kind,
            Location = location,
            OutputLocation = location,
            Text = Optional(Limit(text, 120)),
            Context = Optional(Limit(context, 240)),
            SuggestedName = Optional(Limit(suggestedName, 80)),
            SuggestedFillBy = suggestedFillBy == "manual" ? "manual" : null,
            Options = options is { Count: > 0 } ? options : null,
            Target = target,
            TargetGroup = targetGroup,
            FallbackTarget = fallback,
            Start = start,
            Length = length,
            Order = order++,
        });
    }

    static string Limit(string value, int maxLength)
    {
        var text = value ?? "";
        return text.Length <= maxLength ? text : text[..maxLength];
    }

    static string? Optional(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }

    sealed record ParagraphHit(string Kind, int Start, int Length, string Name, string FillBy, List<string>? Options = null);

    sealed record TableRowInfo(Wp.TableRow Row, int RowIndex, List<TableCellInfo> Cells);

    sealed record TableCellInfo(
        Wp.TableCell Cell,
        int CellIndex,
        int ColumnStart,
        int ColumnSpan,
        string Text);
}
