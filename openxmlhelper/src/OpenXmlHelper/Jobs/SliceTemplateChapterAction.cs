using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using DocumentFormat.OpenXml.Packaging;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

sealed class SliceTemplateChapterRequest
{
    public string Action { get; set; } = "";
    public string Input { get; set; } = "";
    [JsonPropertyName("start_block")]
    public int StartBlock { get; set; }
    [JsonPropertyName("end_block")]
    public int EndBlock { get; set; }
}

/// <summary>按字段清单的块号从已回填的商务模版截出单章 Word，供正文页只读预览；不改动原文件。</summary>
static class SliceTemplateChapterAction
{
    public const string Name = "slice-template-chapter";
    public const string OutputFileName = "chapter.docx";

    public static JobResult Execute(string workspace, string jobId)
    {
        if (!TryReadRequest(workspace, jobId, out var request, out var error))
        {
            return JobResult.Fail(error);
        }

        try
        {
            var inputPath = WordWorkspace.ResolveWorkspacePath(workspace, request.Input);
            if (!File.Exists(inputPath)) return JobResult.Fail("商务模版不存在，请重新生成目录");
            // 允许 Word 打开或回填替换文件时读取；在内存副本上截取。
            using var stream = new MemoryStream();
            using (var source = new FileStream(inputPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                source.CopyTo(stream);
            }

            using (var document = WordprocessingDocument.Open(stream, true))
            {
                var body = document.MainDocumentPart?.Document.Body ?? throw new InvalidOperationException("商务模版正文为空");
                // 块号口径与抽章、整本导出一致：正文顶层元素，不含末尾 sectPr。
                var blocks = body.ChildElements.Where(item => item is not Wp.SectionProperties).ToList();
                if (request.StartBlock < 0 || request.EndBlock > blocks.Count || request.StartBlock >= request.EndBlock)
                {
                    return JobResult.Fail("商务模版与字段清单不一致，请重新生成目录");
                }
                // 抽章已把内部分节改为分页，模版只有末尾 sectPr，删除区间外的块即可。
                for (var index = 0; index < blocks.Count; index++)
                {
                    if (index < request.StartBlock || index >= request.EndBlock) blocks[index].Remove();
                }
                BusinessTemplateMerger.StripLeadingPageBreak(body);
                document.MainDocumentPart!.Document.Save();
            }

            var outputPath = Path.Combine(JobFolder.GetJobDirectory(workspace, jobId), OutputFileName);
            File.WriteAllBytes(outputPath, stream.ToArray());
            return JobResult.Success(Name, OutputFileName, request.EndBlock - request.StartBlock);
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException or IOException)
        {
            return WordWorkspace.FileAccessFailure(workspace, request.Input);
        }
        catch (Exception exception)
        {
            return JobResult.Fail(exception.Message);
        }
    }

    static bool TryReadRequest(string workspace, string jobId, out SliceTemplateChapterRequest request, out string error)
    {
        request = new SliceTemplateChapterRequest();
        error = "";
        try
        {
            var path = Path.Combine(JobFolder.GetJobDirectory(workspace, jobId), JobFolder.RequestFileName);
            var parsed = JsonSerializer.Deserialize<SliceTemplateChapterRequest>(File.ReadAllText(path, Encoding.UTF8), JsonOptions.File);
            if (parsed is null || string.IsNullOrWhiteSpace(parsed.Input))
            {
                error = "request.json 缺少 input";
                return false;
            }
            request = parsed;
            request.Input = request.Input.Trim();
            return true;
        }
        catch (Exception exception)
        {
            error = $"无法读取 request.json：{exception.Message}";
            return false;
        }
    }
}
