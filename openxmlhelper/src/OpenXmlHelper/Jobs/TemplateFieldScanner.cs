using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>扫描投标模板正文中的明确占位和简单空单元格，输出供 Agent 分类的稳定候选。</summary>
static class TemplateFieldScanner
{
    static readonly Regex PlaceholderPattern = new(
        @"_{2,}|＿{2,}|【\s*(?:待填写|人工处理)\s*[：:]?[^】]*】|\(\s*\)|（\s*）",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);
    static readonly Regex TrailingLabelPattern = new(
        @"(?<label>[\p{L}\p{N}（）()《》/·\-]{2,30})[：:]\s*$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);
    static readonly Regex ExplicitNamePattern = new(
        @"【\s*(?:待填写|人工处理)\s*[：:]\s*(?<name>[^】]+)】",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);
    static readonly Regex ManualPattern = new(
        @"签字|签名|签章|盖章|公章|印章|手印|法定代表人签|授权代表签",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);
    static readonly Regex TableTitlePattern = new(
        @"(?:表|表格|一览表|应答表|明细表|汇总表)(?:\s*[（(][^）)]*[）)])?\s*$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);
    static readonly Regex NumberedGroupPattern = new(
        @"^(?:[（(][一二三四五六七八九十百0-9]+[）)]|[一二三四五六七八九十百]+[、.．]|[0-9]+[、.．])\s*\S+",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);
    static readonly Regex SentenceLikePattern = new(
        @"我公司|本公司|见第|投标文件|[。；;！？!?：:]",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    public static TemplateFieldCandidateFile Scan(
        WordprocessingDocument document,
        IReadOnlyList<TemplateChapterRange>? chapterRanges = null)
    {
        var part = document.MainDocumentPart ?? throw new InvalidOperationException("投标模版缺少正文部件");
        var body = part.Document.Body ?? throw new InvalidOperationException("投标模版正文为空");
        var result = new TemplateFieldCandidateFile();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var order = 0;
        var chapters = NormalizeChapterRanges(chapterRanges, body.ChildElements.Count);

        for (var blockIndex = 0; blockIndex < body.ChildElements.Count; blockIndex += 1)
        {
            var block = body.ChildElements[blockIndex];
            var blockPath = $"body/{blockIndex}:{block.LocalName}";
            var firstCandidate = result.Candidates.Count;
            if (block is Wp.Table table)
            {
                var chapter = FindChapter(chapters, blockIndex);
                ScanTable(
                    table,
                    blockPath,
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
            ScanExistingControl(blockControl, path, candidates, seen, ref order);
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
            ScanTable(table, path, null, candidates, seen, ref order);
            return;
        }

        for (var index = 0; index < element.ChildElements.Count; index += 1)
        {
            var child = element.ChildElements[index];
            ScanElement(child, $"{path}/{index}:{child.LocalName}", candidates, seen, ref order);
        }
    }

    static void ScanTable(
        Wp.Table table,
        string path,
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
                var rowContext = BuildCellContext(rowTexts, cellInfo.CellIndex);
                var paragraphs = cell.Elements<Wp.Paragraph>().ToList();
                for (var paragraphIndex = 0; paragraphIndex < paragraphs.Count; paragraphIndex += 1)
                {
                    ScanParagraph(
                        paragraphs[paragraphIndex],
                        $"{cellPath}/p/{paragraphIndex}",
                        candidates,
                        seen,
                        ref order);
                }

                if (IsSimpleEmptyCell(cell, rowTexts[cellInfo.CellIndex]))
                {
                    var targetParagraph = paragraphs.FirstOrDefault();
                    if (targetParagraph is not null)
                    {
                        AddCandidate(
                            candidates,
                            seen,
                            ref order,
                            kind: "empty-table-cell",
                            location: $"{cellPath}/p/0",
                            text: "",
                            context: rowContext,
                            suggestedName: SuggestName(rowContext),
                            suggestedFillBy: SuggestFillBy(rowContext),
                            target: targetParagraph,
                            start: 0,
                            length: 0);
                    }
                }

                var columnHeader = ReadColumnHeader(activeHeaders, cellInfo.ColumnStart, cellInfo.ColumnSpan);
                for (var index = firstCandidate; index < candidates.Count; index += 1)
                {
                    var candidate = candidates[index];
                    // 同行信息只补充到输出，不参与稳定 candidate_id。
                    candidate.Context = Optional(MergeCellContext(rowContext, candidate.Context));
                    candidate.TableTitle = Optional(Limit(effectiveTableTitle ?? "", 120));
                    candidate.ColumnHeader = Optional(Limit(columnHeader, 120));
                    candidate.GroupTitle = groupTitle;
                    candidate.RowNumber = row.RowIndex + 1;
                    candidate.ColumnNumber = cellInfo.ColumnStart + 1;
                    candidate.OutputLocation = null;
                }
            }
        }
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

    static void ScanExistingControl(
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
        var controlText = WordWorkspace.Normalize(control.InnerText ?? "");
        var context = Limit(controlText, 200);
        AddCandidate(
            candidates,
            seen,
            ref order,
            kind: "existing-content-control",
            location: path,
            text: controlText,
            context,
            suggestedName: name.Length > 0 ? name : SuggestName(controlText),
            suggestedFillBy: SuggestFillBy($"{name} {controlText}"),
            target: control,
            start: 0,
            length: 0);
    }

    static void ScanParagraph(
        Wp.Paragraph paragraph,
        string path,
        List<TemplateFieldCandidate> candidates,
        HashSet<string> seen,
        ref int order)
    {
        var existingControls = paragraph.Descendants<Wp.SdtRun>().ToList();
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

        var placeholderMatches = PlaceholderPattern.Matches(text).Cast<Match>().ToList();
        foreach (var match in placeholderMatches)
        {
            var context = BuildContext(text, match.Index, match.Length);
            var explicitName = ExplicitNamePattern.Match(match.Value).Groups["name"].Value.Trim();
            AddCandidate(
                candidates,
                seen,
                ref order,
                kind: "text-placeholder",
                location: path,
                text: match.Value,
                context,
                suggestedName: explicitName.Length > 0 ? explicitName : SuggestName(text[..match.Index]),
                suggestedFillBy: SuggestFillBy(context),
                target: paragraph,
                start: match.Index,
                length: match.Length);
        }

        foreach (var underlined in FindUnderlinedWhitespace(paragraph, text))
        {
            if (placeholderMatches.Any(match =>
                underlined.Start < match.Index + match.Length
                && match.Index < underlined.Start + underlined.Length))
            {
                continue;
            }
            var context = BuildContext(text, underlined.Start, underlined.Length);
            AddCandidate(
                candidates,
                seen,
                ref order,
                kind: "underlined-space",
                location: path,
                text: text.Substring(underlined.Start, underlined.Length),
                context,
                suggestedName: SuggestName(text[..underlined.Start]),
                suggestedFillBy: SuggestFillBy(context),
                target: paragraph,
                start: underlined.Start,
                length: underlined.Length);
        }

        var trailingLabel = TrailingLabelPattern.Match(text);
        if (trailingLabel.Success)
        {
            var label = trailingLabel.Groups["label"].Value.Trim();
            AddCandidate(
                candidates,
                seen,
                ref order,
                kind: "after-label",
                location: path,
                text: "",
                context: BuildContext(text, text.Length, 0),
                suggestedName: CleanName(label),
                suggestedFillBy: SuggestFillBy(text),
                target: paragraph,
                start: text.Length,
                length: 0);
        }
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

    static List<(int Start, int Length)> FindUnderlinedWhitespace(Wp.Paragraph paragraph, string text)
    {
        var result = new List<(int Start, int Length)>();
        var offset = 0;
        foreach (var run in paragraph.Elements<Wp.Run>())
        {
            var runText = string.Concat(run.Elements<Wp.Text>().Select(item => item.Text));
            var underline = run.RunProperties?.Underline;
            if (underline is not null && underline.Val?.Value != Wp.UnderlineValues.None)
            {
                foreach (Match match in Regex.Matches(runText, @"[\s　]{2,}", RegexOptions.CultureInvariant))
                {
                    result.Add((offset + match.Index, match.Length));
                }
            }
            offset += runText.Length;
        }
        return result.Where(item => item.Start >= 0 && item.Start + item.Length <= text.Length).ToList();
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

    static string BuildCellContext(IReadOnlyList<string> rowTexts, int cellIndex)
    {
        var parts = new List<string>();
        for (var index = 0; index < rowTexts.Count; index += 1)
        {
            if (index == cellIndex || rowTexts[index].Length == 0) continue;
            parts.Add($"第{index + 1}列：{rowTexts[index]}");
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

    static string BuildContext(string text, int start, int length)
    {
        var from = Math.Max(0, start - 80);
        var to = Math.Min(text.Length, start + length + 80);
        return Limit(text[from..to].Replace('\t', ' '), 200);
    }

    static string SuggestName(string context)
    {
        var value = WordWorkspace.Normalize(context);
        var explicitName = ExplicitNamePattern.Match(value).Groups["name"].Value.Trim();
        if (explicitName.Length > 0) return CleanName(explicitName);
        var label = TrailingLabelPattern.Match(value).Groups["label"].Value.Trim();
        if (label.Length > 0) return CleanName(label);
        var pieces = Regex.Split(value, @"[：:；;，,。\s]+", RegexOptions.CultureInvariant)
            .Select(CleanName)
            .Where(item => item.Length >= 2 && item.Length <= 30)
            .ToList();
        return pieces.LastOrDefault() ?? "";
    }

    static string CleanName(string value)
    {
        return Regex.Replace(value ?? "", @"^[\s（(]*|[\s）)＿_]+$", "").Trim();
    }

    static string SuggestFillBy(string context)
    {
        return ManualPattern.IsMatch(context ?? "") ? "manual" : "ai";
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
        int length)
    {
        var identity = $"v1\u0000{location}\u0000{kind}\u0000{start}\u0000{length}\u0000{text}\u0000{context}";
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
            Target = target,
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

    sealed record TableRowInfo(Wp.TableRow Row, int RowIndex, List<TableCellInfo> Cells);

    sealed record TableCellInfo(
        Wp.TableCell Cell,
        int CellIndex,
        int ColumnStart,
        int ColumnSpan,
        string Text);
}
