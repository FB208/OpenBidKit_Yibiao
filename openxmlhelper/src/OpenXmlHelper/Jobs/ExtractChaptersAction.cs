using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

sealed class ExtractChapterSpec
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string SourceTitle { get; set; } = "";
    public string Source { get; set; } = "";
    public int? StartBlock { get; set; }
    public int? EndBlock { get; set; }
    /// <summary>章节字段是否自动填写；为 false 时写入字段时统一改为人工。</summary>
    [JsonPropertyName("auto_fill")]
    public bool? AutoFill { get; set; }
}

sealed class ExtractChaptersRequest
{
    public string Action { get; set; } = "";
    public List<string> Sources { get; set; } = [];
    public List<ExtractChapterSpec> Chapters { get; set; } = [];
    public string Output { get; set; } = "";
}

/// <summary>按 Agent 给出的原文标题或块区间抽出章节，拼成投标模版。</summary>
static class ExtractChaptersAction
{
    public const string Name = "extract-chapters";

    static readonly Regex PrefixPattern = new(
        @"^(第[一二三四五六七八九十百千零0-9]+[章节篇部分]|[0-9]+[\.、．])\s*",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    public static JobResult Execute(string workspace, string jobId)
    {
        if (!TryReadRequest(workspace, jobId, out var request, out var error))
        {
            return JobResult.Fail(error);
        }

        try
        {
            var sourcePaths = WordWorkspace.ResolveSources(workspace, request.Sources);
            if (sourcePaths.Count == 0 || sourcePaths.Any(item => !File.Exists(item)))
            {
                return JobResult.Fail("请重新导入招标文件");
            }

            var chapters = (request.Chapters ?? [])
                .Select(item => new ExtractChapterSpec
                {
                    Id = (item.Id ?? "").Trim(),
                    Title = (item.Title ?? "").Trim(),
                    SourceTitle = (item.SourceTitle ?? "").Trim(),
                    Source = (item.Source ?? "").Trim(),
                    StartBlock = item.StartBlock,
                    EndBlock = item.EndBlock,
                    AutoFill = item.AutoFill,
                })
                .Where(item => item.Title.Length > 0)
                .ToList();
            if (chapters.Count == 0)
            {
                return JobResult.Fail("没有可提取的一级目录");
            }

            var outputPath = WordWorkspace.ResolveWorkspacePath(workspace, request.Output);
            var chaptersOutputPath = Path.ChangeExtension(outputPath, ".chapters.json");
            Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
            if (File.Exists(chaptersOutputPath)) File.Delete(chaptersOutputPath);

            var session = WordWorkspace.OpenSources(workspace, sourcePaths);
            try
            {
                var matches = ResolveChapters(workspace, session, chapters);
                var missing = matches.Where(item => item.Error is not null).Select(item => item.Error!).ToList();
                if (missing.Count > 0)
                {
                    return JobResult.Fail(string.Join("；", missing));
                }

                var duplicateHits = matches
                    .GroupBy(item => $"{item.Hit!.SourcePath}\u0000{item.Hit.BlockIndex}", StringComparer.OrdinalIgnoreCase)
                    .Any(group => group.Count() > 1);
                if (duplicateHits)
                {
                    return JobResult.Fail("多个一级目录命中了招标原文的同一位置");
                }

                var shellPath = sourcePaths[0];
                WordWorkspace.CopyToWritable(shellPath, outputPath);

                using var dest = WordprocessingDocument.Open(outputPath, true);
                var destPart = dest.MainDocumentPart ?? throw new InvalidOperationException("投标模版缺少正文部件");
                var destBody = destPart.Document.Body ?? throw new InvalidOperationException("投标模版正文为空");
                var sectPr = destBody.Elements<Wp.SectionProperties>().LastOrDefault()?.CloneNode(true);
                destBody.RemoveAllChildren();
                var importContexts = new Dictionary<string, CrossDocumentImportContext>(StringComparer.OrdinalIgnoreCase);
                var chapterRanges = new List<TemplateChapterRange>();

                foreach (var match in matches)
                {
                    var hit = match.Hit!;
                    var source = session[hit.SourcePath];
                    var otherStarts = matches
                        .Where(item => WordWorkspace.PathsEqual(item.Hit!.SourcePath, hit.SourcePath))
                        .Select(item => item.Hit!.BlockIndex)
                        .ToHashSet();
                    var range = ExtendRange(
                        source.Blocks,
                        match.Range ?? GetRange(source.Blocks, hit.BlockIndex, otherStarts),
                        otherStarts);
                    var startBlock = destBody.ChildElements.Count;
                    foreach (var block in range)
                    {
                        var cloned = CloneLayoutBlock(block);
                        if (!WordWorkspace.PathsEqual(hit.SourcePath, shellPath))
                        {
                            if (!importContexts.TryGetValue(hit.SourcePath, out var importContext))
                            {
                                importContext = new CrossDocumentImportContext(CreateStyleMap(source.Part, destPart));
                                importContexts[hit.SourcePath] = importContext;
                            }
                            CrossDocumentImport.NormalizeStyleReferences(cloned, importContext.StyleIds);
                            CrossDocumentImport.RemapNumbering(cloned, source.Part, destPart, importContext);
                            CrossDocumentImport.RemapRelationships(cloned, source.Part, destPart, importContext.RelationshipIds);
                        }

                        destBody.AppendChild(cloned);
                    }
                    chapterRanges.Add(new TemplateChapterRange
                    {
                        Id = match.Chapter.Id.Length > 0 ? match.Chapter.Id : null,
                        Title = match.Chapter.Title,
                        AutoFill = match.Chapter.AutoFill ?? true,
                        StartBlock = startBlock,
                        EndBlock = destBody.ChildElements.Count,
                    });
                }

                if (sectPr is not null)
                {
                    destBody.AppendChild(sectPr);
                }

                destPart.Document.Save();
                var chapterRangeFile = new TemplateChapterRangeFile { Chapters = chapterRanges };
                File.WriteAllText(
                    chaptersOutputPath,
                    JsonSerializer.Serialize(chapterRangeFile, JsonOptions.Signal) + "\n",
                    new UTF8Encoding(false));
                return JobResult.Success(Name, WordWorkspace.ToRelativePath(workspace, outputPath));
            }
            finally
            {
                foreach (var source in session.Values)
                {
                    source.Dispose();
                }
            }
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException or IOException)
        {
            return WordWorkspace.FileAccessFailure(workspace, [request.Output, .. request.Sources]);
        }
        catch (Exception exception)
        {
            return JobResult.Fail(exception.Message);
        }
    }

    static List<ChapterMatch> ResolveChapters(string workspace, Dictionary<string, SourceDocument> session, List<ExtractChapterSpec> chapters)
    {
        var result = new List<ChapterMatch>();
        foreach (var chapter in chapters)
        {
            if (chapter.StartBlock is int startBlock)
            {
                var source = ResolveSource(workspace, session, chapter.Source);
                if (source is null)
                {
                    result.Add(new ChapterMatch(chapter, null, null, $"找不到招标原件：{chapter.Title}"));
                    continue;
                }

                if (startBlock < 0 || startBlock >= source.Blocks.Count)
                {
                    result.Add(new ChapterMatch(chapter, null, null, $"块号越界：{chapter.Title}"));
                    continue;
                }

                if (chapter.EndBlock is not int end)
                {
                    result.Add(new ChapterMatch(chapter, null, null, $"块号定位必须同时提供结束块号：{chapter.Title}"));
                    continue;
                }
                if (end <= startBlock || end > source.Blocks.Count)
                {
                    result.Add(new ChapterMatch(chapter, null, null, $"结束块号无效：{chapter.Title}"));
                    continue;
                }

                var range = source.Blocks.GetRange(startBlock, end - startBlock);
                result.Add(new ChapterMatch(chapter, source.Blocks[startBlock], range, null));
                continue;
            }

            var lookupTitle = chapter.SourceTitle;
            if (lookupTitle.Length == 0)
            {
                result.Add(new ChapterMatch(chapter, null, null, $"缺少原文定位：{chapter.Title}"));
                continue;
            }

            var hit = FindByTitle(session, lookupTitle, chapter.Source, workspace);
            if (hit is null)
            {
                result.Add(new ChapterMatch(chapter, null, null, $"招标原文中找不到：{lookupTitle}"));
                continue;
            }
            if (!hit.IsHeading)
            {
                result.Add(new ChapterMatch(chapter, null, null, $"原文标题未设置标题样式，请使用 startBlock 和 endBlock 明确范围：{chapter.Title}"));
                continue;
            }
            result.Add(new ChapterMatch(chapter, hit, null, null));
        }

        return result;
    }

    static SourceDocument? ResolveSource(string workspace, Dictionary<string, SourceDocument> session, string source)
    {
        if (string.IsNullOrWhiteSpace(source))
        {
            return session.Values.FirstOrDefault();
        }

        var full = WordWorkspace.ResolveWorkspacePath(workspace, source);
        if (session.TryGetValue(full, out var document))
        {
            return document;
        }

        return session.Values.FirstOrDefault(item =>
            string.Equals(Path.GetFileName(item.Path), Path.GetFileName(source), StringComparison.OrdinalIgnoreCase));
    }

    static BlockInfo? FindByTitle(Dictionary<string, SourceDocument> session, string title, string sourceHint, string workspace)
    {
        IEnumerable<SourceDocument> sources = session.Values;
        var hinted = ResolveSource(workspace, session, sourceHint);
        if (!string.IsNullOrWhiteSpace(sourceHint) && hinted is not null)
        {
            sources = [hinted];
        }

        BlockInfo? best = null;
        var bestScore = 0;
        foreach (var source in sources)
        {
            foreach (var block in source.Blocks)
            {
                if (block.Kind != "paragraph")
                {
                    continue;
                }

                var score = ScoreTitle(title, block);
                if (score > bestScore)
                {
                    bestScore = score;
                    best = block;
                }
            }
        }

        return bestScore > 0 ? best : null;
    }

    static List<BlockInfo> GetRange(List<BlockInfo> blocks, int startIndex, HashSet<int> allStarts)
    {
        var start = blocks[startIndex];
        var end = blocks.Count;
        for (var index = startIndex + 1; index < blocks.Count; index += 1)
        {
            if (allStarts.Contains(index))
            {
                end = index;
                break;
            }

            var block = blocks[index];
            if (!block.IsHeading)
            {
                continue;
            }

            if (!start.IsHeading || block.OutlineLevel <= start.OutlineLevel)
            {
                end = index;
                break;
            }
        }

        return blocks.GetRange(startIndex, end - startIndex);
    }

    /// <summary>把章末空段、分页符、分节一并纳入，避免原文单独成页的内容被挤到下一章。</summary>
    static List<BlockInfo> ExtendRange(List<BlockInfo> blocks, List<BlockInfo> range, HashSet<int> otherStarts)
    {
        if (range.Count == 0)
        {
            return range;
        }

        var extended = new List<BlockInfo>(range);
        var nextIndex = range[^1].BlockIndex + 1;
        while (nextIndex < blocks.Count && !otherStarts.Contains(nextIndex))
        {
            var next = blocks[nextIndex];
            if (!WordWorkspace.IsLayoutOnly(next))
            {
                break;
            }

            extended.Add(next);
            nextIndex += 1;
        }

        return extended;
    }

    /// <summary>克隆块；中间分节改为分页符，避免打乱整份模版只保留一个节。</summary>
    static OpenXmlElement CloneLayoutBlock(BlockInfo block)
    {
        if (block.Kind == "section-break")
        {
            return CreatePageBreakParagraph();
        }

        var cloned = (OpenXmlElement)block.Element.CloneNode(true);
        // 拼写语法检查标记（w:proofErr）不含内容，留着会让字段扫描把所在段落当作复杂段落整段跳过。
        foreach (var proofError in cloned.Descendants<Wp.ProofError>().ToList())
        {
            proofError.Remove();
        }

        if (cloned is Wp.Paragraph paragraph)
        {
            var section = paragraph.ParagraphProperties?.SectionProperties;
            if (section is not null)
            {
                section.Remove();
                if (!block.HasPageBreak)
                {
                    EnsurePageBreak(paragraph);
                }
            }
        }

        return cloned;
    }

    static Wp.Paragraph CreatePageBreakParagraph()
    {
        return new Wp.Paragraph(new Wp.Run(new Wp.Break { Type = Wp.BreakValues.Page }));
    }

    static void EnsurePageBreak(Wp.Paragraph paragraph)
    {
        if (paragraph.Descendants<Wp.Break>().Any(item => item.Type?.Value == Wp.BreakValues.Page))
        {
            return;
        }

        paragraph.AppendChild(new Wp.Run(new Wp.Break { Type = Wp.BreakValues.Page }));
    }

    internal static int ScoreTitle(string title, BlockInfo block)
    {
        var expected = WordWorkspace.Normalize(title);
        var expectedCore = PrefixPattern.Replace(expected, "").Trim();
        var actual = block.Text;
        var actualCore = PrefixPattern.Replace(actual, "").Trim();
        if (actual.Length == 0)
        {
            return 0;
        }

        var score = 0;
        if (actual == expected || actualCore == expected || actual == expectedCore || actualCore == expectedCore)
        {
            score = 100;
        }
        else if (expectedCore.Length >= 4 && actualCore.Contains(expectedCore, StringComparison.Ordinal))
        {
            score = 70;
        }
        else if (actualCore.Length >= 4 && expectedCore.Contains(actualCore, StringComparison.Ordinal))
        {
            score = 60;
        }

        if (score > 0 && block.IsHeading)
        {
            score += 10;
        }

        return score;
    }

    /** 将外部文档的样式引用映射到第一份 Word 的同 ID 或同名样式。 */
    static Dictionary<string, string?> CreateStyleMap(MainDocumentPart sourcePart, MainDocumentPart destPart)
    {
        var sourceStyles = sourcePart.StyleDefinitionsPart?.Styles?.Elements<Wp.Style>().ToList() ?? [];
        var targetStyles = destPart.StyleDefinitionsPart?.Styles?.Elements<Wp.Style>().ToList() ?? [];
        var targetById = targetStyles
            .Where(style => !string.IsNullOrWhiteSpace(style.StyleId?.Value))
            .GroupBy(style => style.StyleId!.Value!, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        var targetByName = targetStyles
            .Select(style => (Style: style, Key: GetStyleNameKey(style)))
            .Where(item => item.Key.Length > 0)
            .GroupBy(item => item.Key, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.First().Style, StringComparer.OrdinalIgnoreCase);
        var result = new Dictionary<string, string?>(StringComparer.Ordinal);

        foreach (var sourceStyle in sourceStyles)
        {
            var sourceId = sourceStyle.StyleId?.Value;
            if (string.IsNullOrWhiteSpace(sourceId)) continue;
            if (targetById.TryGetValue(sourceId, out var sameId)
                && sameId.Type?.Value == sourceStyle.Type?.Value)
            {
                result[sourceId] = sourceId;
                continue;
            }

            var nameKey = GetStyleNameKey(sourceStyle);
            result[sourceId] = nameKey.Length > 0 && targetByName.TryGetValue(nameKey, out var sameName)
                ? sameName.StyleId?.Value
                : null;
        }

        return result;
    }

    static string GetStyleNameKey(Wp.Style style)
    {
        var name = style.StyleName?.Val?.Value?.Trim() ?? "";
        return name.Length == 0 ? "" : $"{style.Type?.Value}:{name}";
    }

    static bool TryReadRequest(string workspace, string jobId, out ExtractChaptersRequest request, out string error)
    {
        request = new ExtractChaptersRequest();
        error = "";
        try
        {
            var path = Path.Combine(JobFolder.GetJobDirectory(workspace, jobId), JobFolder.RequestFileName);
            var parsed = JsonSerializer.Deserialize<ExtractChaptersRequest>(File.ReadAllText(path, Encoding.UTF8), JsonOptions.File);
            if (parsed is null)
            {
                error = "request.json 无效";
                return false;
            }

            request = parsed;
            return true;
        }
        catch (Exception exception)
        {
            error = $"无法读取 request.json：{exception.Message}";
            return false;
        }
    }

    sealed record ChapterMatch(ExtractChapterSpec Chapter, BlockInfo? Hit, List<BlockInfo>? Range, string? Error);
}
