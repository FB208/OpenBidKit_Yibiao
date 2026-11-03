using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

sealed class AppendGeneratedChaptersRequest
{
    public string Action { get; set; } = "";
    public string Input { get; set; } = "";
    public string Output { get; set; } = "";
    public List<GeneratedChapterSpec> Chapters { get; set; } = [];
    /// <summary>生成章节中各字段的定义（id、name、subject、section、fill_by、kind），签章标记和原句由本动作补齐。</summary>
    public List<TemplateFieldDefinition> Fields { get; set; } = [];
}

/// <summary>一个商务生成模板：title 为空时没有标题段（作为只有标题的提取章节的正文），blocks 每项一段。</summary>
sealed class GeneratedChapterSpec
{
    public string Id { get; set; } = "";
    public string? Title { get; set; }
    public List<GeneratedBlockSpec> Blocks { get; set; } = [];
}

/// <summary>一段内容：按顺序的文字和字段；附件位置为只含一个附件字段的段落。</summary>
sealed class GeneratedBlockSpec
{
    public List<GeneratedSegmentSpec> Segments { get; set; } = [];
}

sealed class GeneratedSegmentSpec
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Text { get; set; }
    [JsonPropertyName("field_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? FieldId { get; set; }
}

sealed class GeneratedChapterRange
{
    public string Id { get; set; } = "";
    [JsonPropertyName("start_block")]
    public int StartBlock { get; set; }
    [JsonPropertyName("end_block")]
    public int EndBlock { get; set; }
}

sealed class AppendGeneratedChaptersResult
{
    public List<GeneratedChapterRange> Chapters { get; set; } = [];
    public List<TemplateFieldDefinition> Fields { get; set; } = [];
}

/// <summary>
/// 把商务填写 Agent 写出的商务生成模板追加到提取底稿末尾，生成 base 底稿：每章依次写入标题段（带标题书签）和各段内容，
/// 字段用与提取字段相同的内容控件，之后由 fill-template-fields 按字段清单回填。追加在末尾，提取章节的块号不变。
/// </summary>
static class AppendGeneratedChaptersAction
{
    public const string Name = "append-generated-chapters";
    public const string OutputFileName = "generated-chapters.json";
    const string FieldMark = "【▢】";

    public static JobResult Execute(string workspace, string jobId)
    {
        if (!TryReadRequest(workspace, jobId, out var request, out var error))
        {
            return JobResult.Fail(error);
        }

        string? tempDocumentPath = null;
        try
        {
            var inputPath = WordWorkspace.ResolveWorkspacePath(workspace, request.Input);
            var outputPath = WordWorkspace.ResolveWorkspacePath(workspace, request.Output);
            if (!File.Exists(inputPath)) return JobResult.Fail("商务模版空白底稿不存在，请重新生成目录");
            if (WordWorkspace.PathsEqual(inputPath, outputPath)) return JobResult.Fail("提取底稿和生成底稿不能使用同一路径");
            var fields = request.Fields.ToDictionary(field => field.Id, StringComparer.Ordinal);

            Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
            tempDocumentPath = $"{outputPath}.{Guid.NewGuid():N}.tmp.docx";
            WordWorkspace.CopyToWritable(inputPath, tempDocumentPath);

            var result = new AppendGeneratedChaptersResult();
            using (var document = WordprocessingDocument.Open(tempDocumentPath, true))
            {
                var wordDocument = document.MainDocumentPart?.Document ?? throw new InvalidOperationException("投标模版缺少正文部件");
                var body = wordDocument.Body ?? throw new InvalidOperationException("投标模版缺少正文");
                var section = body.Elements<Wp.SectionProperties>().LastOrDefault();
                var blockCount = body.ChildElements.Count(item => item is not Wp.SectionProperties);
                var nextWordId = body.Descendants<Wp.SdtId>().Select(item => item.Val?.Value ?? 0).DefaultIfEmpty(0).Max() + 1;
                var nextBookmarkId = body.Descendants<Wp.BookmarkStart>()
                    .Select(item => int.TryParse(item.Id?.Value, out var id) ? id : 0)
                    .DefaultIfEmpty(0)
                    .Max() + 1;
                var written = new List<OpenXmlElement>();
                var contexts = new Dictionary<string, string>(StringComparer.Ordinal);

                void Append(Wp.Paragraph paragraph)
                {
                    if (section is null) body.AppendChild(paragraph);
                    else section.InsertBeforeSelf(paragraph);
                    written.Add(paragraph);
                }

                for (var chapterIndex = 0; chapterIndex < request.Chapters.Count; chapterIndex += 1)
                {
                    var chapter = request.Chapters[chapterIndex];
                    var start = blockCount;
                    if (!string.IsNullOrWhiteSpace(chapter.Title))
                    {
                        // 标题段同提取模板：标题书签标出标题段，导出时写大纲级别并按全局标题样式排版。
                        var id = (nextBookmarkId++).ToString(System.Globalization.CultureInfo.InvariantCulture);
                        Append(new Wp.Paragraph(
                            new Wp.ParagraphProperties(new Wp.Justification { Val = Wp.JustificationValues.Center }),
                            new Wp.BookmarkStart { Id = id, Name = $"{TemplateHeadings.BookmarkPrefix}g{chapterIndex}" },
                            new Wp.Run(new Wp.RunProperties(new Wp.Bold()), new Wp.Text(chapter.Title.Trim()) { Space = SpaceProcessingModeValues.Preserve }),
                            new Wp.BookmarkEnd { Id = id }));
                        blockCount += 1;
                    }
                    foreach (var block in chapter.Blocks)
                    {
                        var paragraph = new Wp.Paragraph();
                        foreach (var segment in block.Segments)
                        {
                            if (segment.FieldId is { } fieldId)
                            {
                                if (!fields.TryGetValue(fieldId, out var field)) throw new InvalidOperationException($"生成模板字段 {fieldId} 缺少定义");
                                paragraph.AppendChild(TemplateFieldSdtWriter.CreateFieldControl(field, nextWordId++));
                                contexts[fieldId] = string.Concat(block.Segments.Select(item => item == segment ? FieldMark : item.Text ?? ""));
                            }
                            else if (!string.IsNullOrEmpty(segment.Text))
                            {
                                paragraph.AppendChild(new Wp.Run(new Wp.Text(segment.Text) { Space = SpaceProcessingModeValues.Preserve }));
                            }
                        }
                        Append(paragraph);
                        blockCount += 1;
                    }
                    result.Chapters.Add(new GeneratedChapterRange { Id = chapter.Id, StartBlock = start, EndBlock = blockCount });
                }

                foreach (var field in request.Fields)
                {
                    if (!contexts.TryGetValue(field.Id, out var context)) throw new InvalidOperationException($"生成模板字段 {field.Id} 没有写入任何段落");
                    // 签章位置口径同 apply-template-fields：人工字段的名称符合扫描器的签字、签章、手印、盖章规则。
                    field.Signature = field.FillBy == "manual" && TemplateFieldScanner.SuggestFillBy(field.Name, "") == "manual" ? true : null;
                    field.Context = context;
                    result.Fields.Add(field);
                }

                wordDocument.Save();
                var validator = new OpenXmlValidator(FileFormatVersions.Microsoft365);
                var validationErrors = written.SelectMany(item => validator.Validate(item)).Take(10).ToList();
                if (validationErrors.Count > 0)
                {
                    throw new InvalidOperationException($"商务生成模板 Open XML 校验失败：{string.Join("；", validationErrors.Select(item => item.Description))}");
                }
            }

            File.Move(tempDocumentPath, outputPath, overwrite: true);
            tempDocumentPath = null;
            File.WriteAllText(
                Path.Combine(JobFolder.GetJobDirectory(workspace, jobId), OutputFileName),
                JsonSerializer.Serialize(result, JsonOptions.Signal) + "\n",
                new UTF8Encoding(false));
            return JobResult.Success(Name, OutputFileName, result.Chapters.Count);
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException or IOException)
        {
            return WordWorkspace.FileAccessFailure(workspace, request.Output);
        }
        catch (Exception exception)
        {
            return JobResult.Fail(exception.Message);
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(tempDocumentPath))
            {
                try { File.Delete(tempDocumentPath); } catch {}
            }
        }
    }

    static bool TryReadRequest(string workspace, string jobId, out AppendGeneratedChaptersRequest request, out string error)
    {
        request = new AppendGeneratedChaptersRequest();
        error = "";
        try
        {
            var path = Path.Combine(JobFolder.GetJobDirectory(workspace, jobId), JobFolder.RequestFileName);
            var parsed = JsonSerializer.Deserialize<AppendGeneratedChaptersRequest>(File.ReadAllText(path, Encoding.UTF8), JsonOptions.File);
            if (parsed is null || string.IsNullOrWhiteSpace(parsed.Input) || string.IsNullOrWhiteSpace(parsed.Output))
            {
                error = "request.json 缺少 input 或 output";
                return false;
            }
            request = parsed;
            request.Input = request.Input.Trim();
            request.Output = request.Output.Trim();
            return true;
        }
        catch (Exception exception)
        {
            error = $"无法读取 request.json：{exception.Message}";
            return false;
        }
    }
}
