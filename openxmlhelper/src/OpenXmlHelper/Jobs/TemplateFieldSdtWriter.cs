using System.Text;
using System.Text.RegularExpressions;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using Yibiao.OpenXmlHelper.Ooxml;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>将已确认候选确定性转换为带业务标识的 Word 内容控件。</summary>
static class TemplateFieldSdtWriter
{
    public const string TagPrefix = "yibiao:field:";
    public const string FormatTagPrefix = "yibiao:format:";
    public const string PlaceholderFill = "FCE8E6";
    public const string PlaceholderTextColor = "000000";

    /// <summary>写入字段并返回本次新写入的元素，供调用方只校验工具自身产出的 Open XML。</summary>
    public static IReadOnlyList<OpenXmlElement> Apply(TemplateFieldCandidate candidate, TemplateFieldDefinition field, int wordId)
    {
        var written = new List<OpenXmlElement>();
        if (candidate.Target is Wp.SdtRun existing)
        {
            UpdateExistingControl(existing, field, wordId, written);
            return written;
        }

        if (candidate.Target is Wp.SdtBlock existingBlock)
        {
            UpdateExistingBlockControl(existingBlock, field, wordId, written);
            return written;
        }

        if (candidate.Target is not Wp.Paragraph paragraph)
        {
            throw new InvalidOperationException($"候选位置已失效：{candidate.CandidateId}");
        }

        switch (candidate.Kind)
        {
            case TemplateFieldKinds.CheckboxGroup when candidate.TargetGroup is { Count: > 1 } group:
                WrapParagraphs(group, field, wordId, written);
                break;
            case TemplateFieldKinds.CheckboxGroup:
            case TemplateFieldKinds.Alternatives:
                WrapParagraphRange(paragraph, candidate.Start, candidate.Length, field, wordId, written);
                break;
            case TemplateFieldKinds.AttachmentNote:
                InsertAttachmentSlot(paragraph, field, wordId, written, candidate.FallbackTarget);
                break;
            case TemplateFieldKinds.TableSlot:
                WriteTableSlot(paragraph, candidate.InsertAfter, field, wordId, written);
                break;
            default:
                if (candidate.FallbackTarget is { } fallback)
                {
                    ReplaceFallbackText(fallback, candidate.Start, candidate.Length, field);
                }
                ReplaceParagraphRange(paragraph, candidate.Start, candidate.Length, field, wordId, written);
                break;
        }
        return written;
    }

    /// <summary>拆分的附件按部分顺序占用连续段落：附件位置的第一部分替换原位置，其余部分依次插在其后；附件说明之后全部依次插入。</summary>
    public static IReadOnlyList<OpenXmlElement> ApplyAttachmentParts(
        TemplateFieldCandidate candidate,
        IReadOnlyList<(TemplateFieldDefinition Field, int WordId)> parts)
    {
        if (candidate.Target is not Wp.Paragraph paragraph)
        {
            throw new InvalidOperationException($"候选位置已失效：{candidate.CandidateId}");
        }

        var written = new List<OpenXmlElement>();
        var anchor = paragraph;
        var fallbackAnchor = candidate.FallbackTarget;
        var remaining = parts;
        if (candidate.Kind == TemplateFieldKinds.AttachmentSlot)
        {
            var (field, wordId) = parts[0];
            if (fallbackAnchor is not null)
            {
                ReplaceFallbackText(fallbackAnchor, candidate.Start, candidate.Length, field);
            }
            ReplaceParagraphRange(paragraph, candidate.Start, candidate.Length, field, wordId, written);
            remaining = parts.Skip(1).ToList();
        }
        foreach (var (field, wordId) in remaining)
        {
            (anchor, fallbackAnchor) = InsertAttachmentSlot(anchor, field, wordId, written, fallbackAnchor);
        }
        return written;
    }

    public const char CheckedBox = '☑';

    /// <summary>向已标记的字段控件写入值，保留字段标识；image 为已解析的图片绝对路径。返回本次新写入或修改的元素供调用方校验。</summary>
    public static IReadOnlyList<OpenXmlElement> Fill(
        MainDocumentPart mainPart,
        Wp.SdtElement control,
        TemplateFieldFillValue value,
        Func<uint> nextDrawingId)
    {
        var written = new List<OpenXmlElement>();
        var properties = control.GetFirstChild<Wp.SdtProperties>();
        // 原件自带控件处于占位显示时，Word 会把写入内容当作灰色占位，点击即清空。
        if (properties is not null) WordStructure.RemoveChildren<Wp.ShowingPlaceholder>(properties);
        var name = properties?.GetFirstChild<Wp.SdtAlias>()?.Val?.Value ?? value.Id;
        if (value.Selected is { } selected)
        {
            CheckOptions(control, name, selected, written);
            return written;
        }

        if (value.Option is { } option)
        {
            ChooseOption(control, name, option, written);
            return written;
        }

        if (value.Image is { } imagePath)
        {
            FillImage(mainPart, control, name, imagePath, nextDrawingId(), written);
            return written;
        }

        var blank = value.Blank == true;
        // 留空只清除待填写占位；勾选项等原有内容保持原样。
        if (blank && !control.InnerText.Contains(PlaceholderText(name), StringComparison.Ordinal)) return written;
        IReadOnlyList<string> lines = blank ? [""] : (value.Value ?? "").Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        switch (control)
        {
            case Wp.SdtRun run:
            {
                if (!blank) lines = FitFollowingText(lines, FollowingText(run));
                var content = run.SdtContentRun ?? run.AppendChild(new Wp.SdtContentRun());
                var sourceRun = content.Descendants<Wp.Run>().FirstOrDefault();
                var valueRun = CreateValueRun(lines, sourceRun);
                WordStructure.ReplaceContent(content, [valueRun]);
                written.Add(valueRun);
                break;
            }
            case Wp.SdtBlock block:
            {
                var content = block.SdtContentBlock ?? block.AppendChild(new Wp.SdtContentBlock());
                var sourceParagraph = content.Descendants<Wp.Paragraph>().FirstOrDefault();
                var sourceRun = sourceParagraph?.Descendants<Wp.Run>().FirstOrDefault();
                var paragraphs = new List<OpenXmlElement>();
                foreach (var line in lines)
                {
                    var paragraph = new Wp.Paragraph();
                    if (sourceParagraph?.ParagraphProperties is not null)
                    {
                        paragraph.AppendChild((Wp.ParagraphProperties)sourceParagraph.ParagraphProperties.CloneNode(true));
                    }
                    paragraph.AppendChild(CreateValueRun([line], sourceRun));
                    paragraphs.Add(paragraph);
                }
                WordStructure.ReplaceContent(content, paragraphs);
                written.AddRange(paragraphs);
                break;
            }
            default:
                throw new InvalidOperationException($"模版字段 {value.Id} 的控件类型不支持填写");
        }
        FillFallback(control, name, lines);
        return written;
    }

    /// <summary>勾选项只把选中项前的方框改为已勾选，选项文字和格式保持原样。</summary>
    static void CheckOptions(Wp.SdtElement control, string name, IReadOnlyCollection<string> selected, List<OpenXmlElement> written)
    {
        var segments = control switch
        {
            Wp.SdtRun run => [run.SdtContentRun?.Descendants<Wp.Text>().ToList() ?? []],
            _ => control.Descendants<Wp.Paragraph>().Select(item => item.Descendants<Wp.Text>().ToList()).ToList(),
        };
        var found = new HashSet<string>(StringComparer.Ordinal);
        foreach (var texts in segments)
        {
            var joined = string.Concat(texts.Select(item => item.Text));
            foreach (Match match in TemplateFieldScanner.CheckboxOptionPattern.Matches(joined))
            {
                var option = TemplateFieldScanner.TrimOption(match.Groups["option"].Value);
                if (!selected.Contains(option)) continue;
                found.Add(option);
                var offset = match.Index;
                foreach (var text in texts)
                {
                    if (offset < text.Text.Length)
                    {
                        text.Text = $"{text.Text[..offset]}{CheckedBox}{text.Text[(offset + 1)..]}";
                        written.Add(text);
                        break;
                    }
                    offset -= text.Text.Length;
                }
            }
        }
        var missing = selected.Where(item => !found.Contains(item)).ToList();
        if (missing.Count > 0)
        {
            throw new InvalidOperationException($"勾选项“{name}”中找不到选项：{string.Join('、', missing)}");
        }
    }

    /// <summary>择一只把控件内的备选原文换成选中项，沿用原文格式；不按后文调整，选中项必须出现在原文中。</summary>
    static void ChooseOption(Wp.SdtElement control, string name, string option, List<OpenXmlElement> written)
    {
        if (control is not Wp.SdtRun run || run.SdtContentRun is not { } content)
        {
            throw new InvalidOperationException($"择一“{name}”的控件类型不支持填写");
        }
        if (!content.InnerText.Contains(option, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"择一“{name}”中找不到选项：{option}");
        }
        var sourceRun = content.Descendants<Wp.Run>().FirstOrDefault();
        var chosen = sourceRun is null
            ? new Wp.Run(new Wp.Text(option) { Space = SpaceProcessingModeValues.Preserve })
            : CreateTextRun(option, sourceRun);
        WordStructure.ReplaceContent(content, [chosen]);
        written.Add(chosen);
    }

    /// <summary>附件写入内嵌图片：等比缩放且不放大原图，宽不超过所在单元格或版心，高不超过版心；文本框兼容显示写入字段名称。</summary>
    static void FillImage(
        MainDocumentPart mainPart,
        Wp.SdtElement control,
        string name,
        string imagePath,
        uint drawingId,
        List<OpenXmlElement> written)
    {
        using var stream = File.OpenRead(imagePath);
        RestrictedHtmlWordInserter.ImageDimensions? dimensions;
        PartTypeInfo partType;
        try
        {
            (dimensions, partType) = RestrictedHtmlWordInserter.ReadImageInfo(stream, imagePath, null);
        }
        catch (InvalidOperationException error)
        {
            throw new InvalidOperationException($"附件“{name}”的图片无法写入：{error.Message}");
        }
        stream.Position = 0;
        var (width, height) = FitImage(dimensions, ResolveImageMaxWidth(mainPart, control), RestrictedHtmlWordInserter.ResolvePageContentHeight(mainPart, control));
        var drawing = RestrictedHtmlWordInserter.CreateInlineDrawing(mainPart, stream, partType, width, height, drawingId, Path.GetFileName(imagePath), name);
        switch (control)
        {
            case Wp.SdtRun run:
            {
                var content = run.SdtContentRun ?? run.AppendChild(new Wp.SdtContentRun());
                var imageRun = new Wp.Run(drawing);
                WordStructure.ReplaceContent(content, [imageRun]);
                written.Add(imageRun);
                break;
            }
            case Wp.SdtBlock block:
            {
                var content = block.SdtContentBlock ?? block.AppendChild(new Wp.SdtContentBlock());
                var sourceParagraph = content.Descendants<Wp.Paragraph>().FirstOrDefault();
                var paragraph = new Wp.Paragraph();
                if (sourceParagraph?.ParagraphProperties is not null)
                {
                    paragraph.AppendChild((Wp.ParagraphProperties)sourceParagraph.ParagraphProperties.CloneNode(true));
                }
                paragraph.AppendChild(new Wp.Run(drawing));
                WordStructure.ReplaceContent(content, [paragraph]);
                written.Add(paragraph);
                break;
            }
            default:
                throw new InvalidOperationException($"模版字段 {name} 的控件类型不支持填写");
        }
        FillFallback(control, name, [name]);
    }

    /// <summary>所在表格单元格设置了固定宽度时取单元格宽度（扣除默认左右边距），否则取版心宽度。</summary>
    static long ResolveImageMaxWidth(MainDocumentPart mainPart, Wp.SdtElement control)
    {
        var pageWidth = RestrictedHtmlWordInserter.ResolvePageContentWidth(mainPart, control);
        var cellWidth = control.Ancestors<Wp.TableCell>().FirstOrDefault()?.TableCellProperties?.TableCellWidth;
        if (cellWidth?.Type?.Value != Wp.TableWidthUnitValues.Dxa || !long.TryParse(cellWidth.Width?.Value, out var twips)) return pageWidth;
        var available = (twips - DefaultCellMarginTwips * 2) * RestrictedHtmlWordInserter.EmusPerTwip;
        return available > 0 ? Math.Min(available, pageWidth) : pageWidth;
    }

    /// <summary>按 96 DPI 计算原始尺寸，等比缩小到不超过给定宽高；尺寸未知时取正方形。</summary>
    static (long Width, long Height) FitImage(RestrictedHtmlWordInserter.ImageDimensions? dimensions, long maxWidth, long maxHeight)
    {
        if (dimensions is null || dimensions.Width <= 0 || dimensions.Height <= 0)
        {
            var side = Math.Min(maxWidth, maxHeight);
            return (side, side);
        }
        double width = dimensions.Width * EmusPerPixel;
        double height = dimensions.Height * EmusPerPixel;
        var scale = Math.Min(1.0, Math.Min(maxWidth / width, maxHeight / height));
        return (Math.Max(1L, (long)Math.Round(width * scale)), Math.Max(1L, (long)Math.Round(height * scale)));
    }

    const long EmusPerPixel = 9_525L;
    const long DefaultCellMarginTwips = 108L;

    /// <summary>字段占位文字：AI 填写与人工处理相同，与正文和导出提示统一为“【待填写】”，用户搜索一个关键词即可找到。</summary>
    static string PlaceholderText(string name) => $"【待填写：{name}】";

    // 行内字段后紧跟的下一个标签，如“日期：”。
    static readonly Regex FollowingLabelPattern = new(@"^[\p{IsCJKUnifiedIdeographs}A-Za-z]{1,8}[：:]", RegexOptions.CultureInvariant | RegexOptions.Compiled);

    /// <summary>行内字段之后同段紧跟的文字（取前 12 个字），用于判断是否与下一个标签相连。</summary>
    static string FollowingText(Wp.SdtRun control)
    {
        var builder = new StringBuilder();
        foreach (var sibling in control.ElementsAfter())
        {
            foreach (var text in sibling.Descendants<Wp.Text>()) builder.Append(text.Text);
            if (builder.Length >= 12) break;
        }
        return builder.ToString();
    }

    /// <summary>
    /// 单行取值后紧跟“标签：”且值不以空白结尾时补两个全角空格，避免原下划线空位填写后与下一个标签相连；只是排版，不改取值文字。
    /// 取值能否放进原句由填写 Agent 按字段原句判断，程序不按字形截改。
    /// </summary>
    static IReadOnlyList<string> FitFollowingText(IReadOnlyList<string> lines, string following)
    {
        if (lines.Count != 1 || lines[0].Length == 0 || following.Length == 0) return lines;
        var value = lines[0];
        if (!char.IsWhiteSpace(value[^1]) && FollowingLabelPattern.IsMatch(following)) value += "　　";
        return [value];
    }

    /// <summary>文本框兼容显示（mc:Fallback）只有纯文字占位，按同名占位的出现顺序同步写入相同文字。</summary>
    static void FillFallback(Wp.SdtElement control, string name, IReadOnlyList<string> lines)
    {
        var choice = control.Ancestors<AlternateContentChoice>().FirstOrDefault();
        var fallback = choice?.Parent?.GetFirstChild<AlternateContentFallback>();
        if (choice is null || fallback is null) return;
        var index = choice.Descendants<Wp.SdtElement>()
            .Where(item => item.GetFirstChild<Wp.SdtProperties>()?.GetFirstChild<Wp.SdtAlias>()?.Val?.Value == name)
            .ToList()
            .IndexOf(control);
        var placeholder = PlaceholderText(name);
        var runs = fallback.Descendants<Wp.Run>().Where(item => ReadRunText(item) == placeholder).ToList();
        if (index < 0 || index >= runs.Count) return;
        WordStructure.Replace(runs[index], CreateValueRun(lines, runs[index]));
    }

    /// <summary>沿用占位格式并去掉淡红底，多行值用换行符分隔。</summary>
    internal static Wp.Run CreateValueRun(IReadOnlyList<string> lines, Wp.Run? sourceRun)
    {
        var properties = sourceRun?.RunProperties is null
            ? new Wp.RunProperties()
            : (Wp.RunProperties)sourceRun.RunProperties.CloneNode(true);
        WordStructure.RemoveChildren<Wp.Shading>(properties);
        if (properties.RunStyle?.Val?.Value == "PlaceholderText") WordStructure.Remove(properties.RunStyle);
        var run = new Wp.Run(properties);
        for (var index = 0; index < lines.Count; index += 1)
        {
            if (index > 0) run.AppendChild(new Wp.Break());
            if (lines[index].Length > 0)
            {
                run.AppendChild(new Wp.Text(lines[index]) { Space = SpaceProcessingModeValues.Preserve });
            }
        }
        return run;
    }

    static void UpdateExistingControl(Wp.SdtRun control, TemplateFieldDefinition field, int wordId, List<OpenXmlElement> written)
    {
        var properties = control.SdtProperties ?? control.PrependChild(new Wp.SdtProperties());
        WriteIdentity(properties, field, wordId, written);

        var content = control.SdtContentRun ?? control.AppendChild(new Wp.SdtContentRun());
        var sourceRun = content.Elements<Wp.Run>().FirstOrDefault();
        var placeholder = CreatePlaceholderRun(field, sourceRun);
        WordStructure.ReplaceContent(content, [placeholder]);
        written.Add(placeholder);
    }

    static void UpdateExistingBlockControl(Wp.SdtBlock control, TemplateFieldDefinition field, int wordId, List<OpenXmlElement> written)
    {
        var properties = control.SdtProperties ?? control.PrependChild(new Wp.SdtProperties());
        WriteIdentity(properties, field, wordId, written);

        var content = control.SdtContentBlock ?? control.AppendChild(new Wp.SdtContentBlock());
        var sourceParagraph = content.Elements<Wp.Paragraph>().FirstOrDefault();
        var sourceRun = sourceParagraph?.Descendants<Wp.Run>().FirstOrDefault();
        var paragraph = new Wp.Paragraph();
        if (sourceParagraph?.ParagraphProperties is not null)
        {
            paragraph.AppendChild((Wp.ParagraphProperties)sourceParagraph.ParagraphProperties.CloneNode(true));
        }
        paragraph.AppendChild(CreatePlaceholderRun(field, sourceRun));
        WordStructure.ReplaceContent(content, [paragraph]);
        written.Add(paragraph);
    }

    // 已有内容控件只替换字段标识，其余属性保持原样。
    // sdtPr 在 SDK 中是选择结构，AddChild 会清空其他子元素，因此按位置插到 rPr 之后。
    static void WriteIdentity(Wp.SdtProperties properties, TemplateFieldDefinition field, int wordId, List<OpenXmlElement> written)
    {
        WordStructure.RemoveChildren<Wp.SdtAlias>(properties);
        WordStructure.RemoveChildren<Wp.SdtId>(properties);
        WordStructure.RemoveChildren<Wp.Tag>(properties);
        OpenXmlElement[] identity =
        [
            new Wp.SdtAlias { Val = field.Name },
            new Wp.Tag { Val = $"{TagPrefix}{field.Id}" },
            new Wp.SdtId { Val = wordId },
        ];
        OpenXmlElement? anchor = properties.GetFirstChild<Wp.RunProperties>();
        foreach (var element in identity)
        {
            anchor = anchor is null ? properties.PrependChild(element) : properties.InsertAfter(element, anchor);
            written.Add(element);
        }
    }

    static void ReplaceParagraphRange(
        Wp.Paragraph paragraph,
        int start,
        int length,
        TemplateFieldDefinition field,
        int wordId,
        List<OpenXmlElement> written)
    {
        var runs = paragraph.Elements<Wp.Run>().ToList();
        var runTexts = runs.Select(ReadRunText).ToList();
        EnsureRange(runTexts, start, length, field);
        var control = CreateControl(field, wordId, FindStyleRun(runs, runTexts, start));
        written.Add(control);
        ReplaceRange(paragraph, runs, runTexts, start, length, control, field, written);
    }

    /// <summary>文本框兼容显示只同步占位文字，不写内容控件；文字不一致时保持原样。</summary>
    static void ReplaceFallbackText(Wp.Paragraph paragraph, int start, int length, TemplateFieldDefinition field)
    {
        var runs = paragraph.Elements<Wp.Run>().ToList();
        var runTexts = runs.Select(ReadRunText).ToList();
        if (start < 0 || length < 0 || start + length > runTexts.Sum(item => item.Length)) return;
        var placeholder = CreatePlaceholderRun(field, FindStyleRun(runs, runTexts, start));
        ReplaceRange(paragraph, runs, runTexts, start, length, placeholder, field, null);
    }

    static void ReplaceRange(
        Wp.Paragraph paragraph,
        IReadOnlyList<Wp.Run> runs,
        IReadOnlyList<string> runTexts,
        int start,
        int length,
        OpenXmlElement replacement,
        TemplateFieldDefinition field,
        List<OpenXmlElement>? written)
    {
        if (runs.Count == 0)
        {
            if (start != 0 || length != 0) throw new InvalidOperationException($"模板字段位置已漂移：{field.Name}");
            paragraph.AppendChild(replacement);
            return;
        }

        if (length == 0)
        {
            InsertAt(paragraph, runs, runTexts, start, replacement, written);
            return;
        }

        var end = start + length;
        var firstIndex = FindRunIndex(runTexts, start, preferNextAtBoundary: true);
        var lastIndex = FindRunIndex(runTexts, end, preferNextAtBoundary: false);
        if (firstIndex < 0 || lastIndex < firstIndex)
        {
            throw new InvalidOperationException($"模板字段位置已漂移：{field.Name}");
        }

        // 被替换的文字去掉；范围起点处的换行和分页留在前面，范围内和终点处的移到替换内容之后，不丢失版面断点。
        SplitAround(
            runs, runTexts, firstIndex, lastIndex,
            before: (position => position < start, position => position <= start),
            middle: [replacement],
            after: (position => position >= end, position => position > start),
            written);
    }

    /// <summary>格式文字保留原文和格式，只把范围包进格式文字控件，导出和预览时由 BusinessTemplateMerger.RemoveFormatText 去掉。</summary>
    public static IReadOnlyList<OpenXmlElement> MarkFormatText(TemplateFieldCandidate candidate, int wordId)
    {
        if (candidate.Target is not Wp.Paragraph paragraph) throw new InvalidOperationException($"候选位置已失效：{candidate.CandidateId}");
        var written = new List<OpenXmlElement>();
        WrapRange(
            paragraph,
            candidate.Start,
            candidate.Length,
            [new Wp.SdtAlias { Val = "格式文字" }, new Wp.SdtId { Val = wordId }, new Wp.Tag { Val = $"{FormatTagPrefix}{candidate.CandidateId}" }],
            candidate.CandidateId,
            written);
        return written;
    }

    /// <summary>同段勾选项保留原文和格式，只把覆盖范围包进内容控件。</summary>
    static void WrapParagraphRange(
        Wp.Paragraph paragraph,
        int start,
        int length,
        TemplateFieldDefinition field,
        int wordId,
        List<OpenXmlElement> written) =>
        WrapRange(paragraph, start, length, CreateIdentity(field, wordId), field.Name, written);

    static void WrapRange(
        Wp.Paragraph paragraph,
        int start,
        int length,
        OpenXmlElement[] identity,
        string label,
        List<OpenXmlElement> written)
    {
        var runs = paragraph.Elements<Wp.Run>().ToList();
        var runTexts = runs.Select(ReadRunText).ToList();
        var end = start + length;
        var firstIndex = FindRunIndex(runTexts, start, preferNextAtBoundary: true);
        var lastIndex = FindRunIndex(runTexts, end, preferNextAtBoundary: false);
        if (start < 0 || length <= 0 || end > runTexts.Sum(item => item.Length) || firstIndex < 0 || lastIndex < firstIndex)
        {
            throw new InvalidOperationException($"模板字段位置已漂移：{label}");
        }

        // 范围内的文字、制表符和中间的换行分页包进控件，起点处的断点留在前面，终点处的留在后面。
        var covered = new List<Wp.Run>();
        for (var index = firstIndex; index <= lastIndex; index += 1)
        {
            var runStart = runTexts.Take(index).Sum(item => item.Length);
            if (SliceRun(runs[index], runStart, position => position >= start && position < end, position => position > start && position < end) is { } slice)
            {
                covered.Add(slice);
            }
        }

        written.AddRange(identity);
        var control = new Wp.SdtRun(new Wp.SdtProperties(identity), new Wp.SdtContentRun(covered));
        SplitAround(
            runs, runTexts, firstIndex, lastIndex,
            before: (position => position < start, position => position <= start),
            middle: [control],
            after: (position => position >= end, position => position >= end),
            written);
    }

    /// <summary>跨段勾选项整体包进块级内容控件，选项段落原样保留。</summary>
    static void WrapParagraphs(
        IReadOnlyList<Wp.Paragraph> paragraphs,
        TemplateFieldDefinition field,
        int wordId,
        List<OpenXmlElement> written)
    {
        var first = paragraphs[0];
        if (paragraphs.Any(item => !ReferenceEquals(item.Parent, first.Parent)))
        {
            throw new InvalidOperationException($"模板字段位置已漂移：{field.Name}");
        }

        var identity = CreateIdentity(field, wordId);
        written.AddRange(identity);
        var content = new Wp.SdtContentBlock();
        first.InsertBeforeSelf(new Wp.SdtBlock(new Wp.SdtProperties(identity), content));
        foreach (var paragraph in paragraphs) WordStructure.AppendTo(paragraph, content);
    }

    /// <summary>
    /// 表格位置写成块级内容控件，内容为一段占位（沿用原段落格式）；回填时整体换成表格。
    /// 替换编制说明时原段落移除，顶层块数不变；章节只有标题时在标题段之后插入。
    /// </summary>
    static void WriteTableSlot(
        Wp.Paragraph paragraph,
        bool insertAfter,
        TemplateFieldDefinition field,
        int wordId,
        List<OpenXmlElement> written)
    {
        var identity = CreateIdentity(field, wordId);
        written.AddRange(identity);
        var placeholder = CreateSlotParagraph(paragraph, CreatePlaceholderRun(field, paragraph.Elements<Wp.Run>().FirstOrDefault()));
        written.Add(placeholder);
        var control = new Wp.SdtBlock(new Wp.SdtProperties(identity), new Wp.SdtContentBlock(placeholder));
        if (insertAfter)
        {
            paragraph.InsertAfterSelf(control);
            return;
        }
        WordStructure.Replace(paragraph, control);
    }

    /// <summary>附件说明保持原文，在其后插入一段附件占位；文本框兼容显示同步插入纯文字占位。返回新插入的段落，供后续部分继续向后插入。</summary>
    static (Wp.Paragraph Slot, Wp.Paragraph? FallbackSlot) InsertAttachmentSlot(
        Wp.Paragraph paragraph,
        TemplateFieldDefinition field,
        int wordId,
        List<OpenXmlElement> written,
        Wp.Paragraph? fallback)
    {
        var control = CreateControl(field, wordId, paragraph.Elements<Wp.Run>().LastOrDefault());
        written.Add(control);
        var slot = paragraph.InsertAfterSelf(CreateSlotParagraph(paragraph, control));
        var fallbackSlot = fallback?.InsertAfterSelf(CreateSlotParagraph(
            fallback,
            CreatePlaceholderRun(field, fallback.Elements<Wp.Run>().LastOrDefault())));
        return (slot, fallbackSlot);
    }

    /// <summary>沿用说明段落格式，去掉分节、编号和段前分页，避免插入段改变版面结构。</summary>
    static Wp.Paragraph CreateSlotParagraph(Wp.Paragraph source, OpenXmlElement content)
    {
        var slot = new Wp.Paragraph();
        if (source.ParagraphProperties?.CloneNode(true) is Wp.ParagraphProperties properties)
        {
            WordStructure.RemoveChildren<Wp.SectionProperties>(properties);
            WordStructure.RemoveChildren<Wp.NumberingProperties>(properties);
            WordStructure.RemoveChildren<Wp.PageBreakBefore>(properties);
            slot.AppendChild(properties);
        }
        slot.AppendChild(content);
        return slot;
    }

    static void InsertAt(
        Wp.Paragraph paragraph,
        IReadOnlyList<Wp.Run> runs,
        IReadOnlyList<string> runTexts,
        int start,
        OpenXmlElement replacement,
        List<OpenXmlElement>? written)
    {
        // 插入点归前面的文字（插在标签之后），同一位置的换行和分页留在插入内容之后，字段不会被挤到下一行或下一页。
        var runIndex = FindRunIndex(runTexts, start, preferNextAtBoundary: false);
        if (runIndex < 0)
        {
            if (start == 0) runs[0].InsertBeforeSelf(replacement);
            else runs[^1].InsertAfterSelf(replacement);
            return;
        }

        SplitAround(
            runs, runTexts, runIndex, runIndex,
            before: (position => position < start, position => position < start),
            middle: [replacement],
            after: (position => position >= start, position => position >= start),
            written);
    }

    /// <summary>
    /// 把 firstIndex 到 lastIndex 的 run 按位置切成前段和后段，与中间内容一起插回原位置，再删除原 run。
    /// 每段各给一对判断：文字和制表符按字符位置，换行和分页按所在位置（不占字符）。
    /// </summary>
    static void SplitAround(
        IReadOnlyList<Wp.Run> runs,
        IReadOnlyList<string> runTexts,
        int firstIndex,
        int lastIndex,
        (Func<int, bool> Char, Func<int, bool> ZeroWidth) before,
        IReadOnlyList<OpenXmlElement> middle,
        (Func<int, bool> Char, Func<int, bool> ZeroWidth) after,
        List<OpenXmlElement>? written)
    {
        var anchor = runs[firstIndex];
        var befores = new List<Wp.Run>();
        var afters = new List<Wp.Run>();
        for (var index = firstIndex; index <= lastIndex; index += 1)
        {
            var runStart = runTexts.Take(index).Sum(item => item.Length);
            if (SliceRun(runs[index], runStart, before.Char, before.ZeroWidth) is { } head) befores.Add(head);
            if (SliceRun(runs[index], runStart, after.Char, after.ZeroWidth) is { } tail) afters.Add(tail);
        }
        foreach (var run in befores) AddWritten(written, anchor.InsertBeforeSelf(run));
        foreach (var element in middle) anchor.InsertBeforeSelf(element);
        foreach (var run in afters) AddWritten(written, anchor.InsertBeforeSelf(run));
        WordStructure.RemoveRange(runs.Skip(firstIndex).Take(lastIndex - firstIndex + 1).ToList());
    }

    /// <summary>切出 run 中满足判断的内容，沿用原 run 属性；渲染缓存的分页标记丢弃；没有内容时返回 null。</summary>
    static Wp.Run? SliceRun(Wp.Run run, int runStart, Func<int, bool> keepChar, Func<int, bool> keepZeroWidth)
    {
        var slice = new Wp.Run();
        if (run.RunProperties is not null) slice.AppendChild((Wp.RunProperties)run.RunProperties.CloneNode(true));
        var offset = runStart;
        var hasContent = false;
        foreach (var child in run.ChildElements)
        {
            switch (child)
            {
                case Wp.RunProperties or Wp.LastRenderedPageBreak:
                    break;
                case Wp.Text text:
                {
                    var builder = new StringBuilder();
                    for (var index = 0; index < text.Text.Length; index += 1)
                    {
                        if (keepChar(offset + index)) builder.Append(text.Text[index]);
                    }
                    if (builder.Length > 0)
                    {
                        slice.AppendChild(new Wp.Text(builder.ToString()) { Space = SpaceProcessingModeValues.Preserve });
                        hasContent = true;
                    }
                    offset += text.Text.Length;
                    break;
                }
                case Wp.TabChar:
                    if (keepChar(offset))
                    {
                        slice.AppendChild(child.CloneNode(true));
                        hasContent = true;
                    }
                    offset += 1;
                    break;
                default:
                    if (keepZeroWidth(offset))
                    {
                        slice.AppendChild(child.CloneNode(true));
                        hasContent = true;
                    }
                    break;
            }
        }
        return hasContent ? slice : null;
    }

    static void EnsureRange(IReadOnlyList<string> runTexts, int start, int length, TemplateFieldDefinition field)
    {
        if (start < 0 || length < 0 || start + length > runTexts.Sum(item => item.Length))
        {
            throw new InvalidOperationException($"模板字段位置已漂移：{field.Name}");
        }
    }

    static void AddWritten(List<OpenXmlElement>? written, OpenXmlElement element)
    {
        written?.Add(element);
    }

    static int FindRunIndex(IReadOnlyList<string> runTexts, int offset, bool preferNextAtBoundary)
    {
        var cursor = 0;
        for (var index = 0; index < runTexts.Count; index += 1)
        {
            var next = cursor + runTexts[index].Length;
            if (offset < next || (!preferNextAtBoundary && offset == next && runTexts[index].Length > 0))
            {
                return index;
            }
            cursor = next;
        }
        return -1;
    }

    static Wp.Run? FindStyleRun(IReadOnlyList<Wp.Run> runs, IReadOnlyList<string> runTexts, int start)
    {
        if (runs.Count == 0) return null;
        var index = FindRunIndex(runTexts, start, preferNextAtBoundary: true);
        return index >= 0 ? runs[index] : runs[^1];
    }

    static OpenXmlElement[] CreateIdentity(TemplateFieldDefinition field, int wordId) =>
    [
        new Wp.SdtAlias { Val = field.Name },
        new Wp.SdtId { Val = wordId },
        new Wp.Tag { Val = $"{TagPrefix}{field.Id}" },
    ];

    /// <summary>商务生成模板的字段控件：与提取字段同一标识和占位写法，文字格式沿用段落默认样式。</summary>
    internal static Wp.SdtRun CreateFieldControl(TemplateFieldDefinition field, int wordId) => CreateControl(field, wordId, null);

    static Wp.SdtRun CreateControl(TemplateFieldDefinition field, int wordId, Wp.Run? sourceRun)
    {
        var content = new Wp.SdtContentRun(CreatePlaceholderRun(field, sourceRun));
        return new Wp.SdtRun(new Wp.SdtProperties(CreateIdentity(field, wordId)), content);
    }

    static Wp.Run CreatePlaceholderRun(TemplateFieldDefinition field, Wp.Run? sourceRun)
    {
        var properties = sourceRun?.RunProperties is null
            ? new Wp.RunProperties()
            : (Wp.RunProperties)sourceRun.RunProperties.CloneNode(true);
        WordStructure.RemoveChildren<Wp.Color>(properties);
        WordStructure.RemoveChildren<Wp.Shading>(properties);
        properties.AddChild(new Wp.Color { Val = PlaceholderTextColor }, throwOnError: true);
        properties.AddChild(
            new Wp.Shading
            {
                Val = Wp.ShadingPatternValues.Clear,
                Color = "auto",
                Fill = PlaceholderFill,
            },
            throwOnError: true);
        return new Wp.Run(
            properties,
            new Wp.Text(PlaceholderText(field.Name)) { Space = SpaceProcessingModeValues.Preserve });
    }

    static Wp.Run CreateTextRun(string text, Wp.Run sourceRun)
    {
        var run = new Wp.Run();
        if (sourceRun.RunProperties is not null)
        {
            run.AppendChild((Wp.RunProperties)sourceRun.RunProperties.CloneNode(true));
        }
        run.AppendChild(new Wp.Text(text) { Space = SpaceProcessingModeValues.Preserve });
        return run;
    }

    static string ReadRunText(Wp.Run run) => TemplateFieldScanner.RunText(run);
}
