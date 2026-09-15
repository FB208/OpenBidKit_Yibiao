using System.Text;
using System.Text.Json;
using DocumentFormat.OpenXml.Packaging;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>扫描内部投标模板并把待填候选写入任务目录，供模板 Agent 分类。</summary>
static class ScanTemplateFieldsAction
{
    public const string Name = "scan-template-fields";
    public const string OutputFileName = "template-field-candidates.json";

    public static JobResult Execute(string workspace, string jobId)
    {
        if (!TryReadRequest(workspace, jobId, out var request, out var error))
        {
            return JobResult.Fail(error);
        }

        try
        {
            var inputPath = WordWorkspace.ResolveWorkspacePath(workspace, request.Input);
            if (!File.Exists(inputPath)) return JobResult.Fail("投标模版源文件不存在");
            var chapterRanges = ReadChapterRanges(inputPath);
            using var document = WordprocessingDocument.Open(inputPath, false);
            var payload = TemplateFieldScanner.Scan(document, chapterRanges);
            var outputPath = Path.Combine(JobFolder.GetJobDirectory(workspace, jobId), OutputFileName);
            File.WriteAllText(
                outputPath,
                JsonSerializer.Serialize(payload, JsonOptions.Signal) + "\n",
                new UTF8Encoding(false));
            return JobResult.Success(Name, OutputFileName, payload.Candidates.Count);
        }
        catch (Exception exception)
        {
            return JobResult.Fail(exception.Message);
        }
    }

    /// <summary>读取与抽章源模版相邻的章节范围。</summary>
    static IReadOnlyList<TemplateChapterRange> ReadChapterRanges(string inputPath)
    {
        var chapterPath = Path.ChangeExtension(inputPath, ".chapters.json");
        if (!File.Exists(chapterPath))
        {
            throw new InvalidOperationException("投标模版章节范围文件不存在，请重新抽取章节");
        }
        var payload = JsonSerializer.Deserialize<TemplateChapterRangeFile>(
            File.ReadAllText(chapterPath, Encoding.UTF8),
            JsonOptions.File);
        if (payload is null || payload.Version != 1 || payload.Chapters is not { Count: > 0 })
        {
            throw new InvalidOperationException("投标模版章节范围文件无效");
        }
        return payload.Chapters;
    }

    static bool TryReadRequest(string workspace, string jobId, out ScanTemplateFieldsRequest request, out string error)
    {
        request = new ScanTemplateFieldsRequest();
        error = "";
        try
        {
            var path = Path.Combine(JobFolder.GetJobDirectory(workspace, jobId), JobFolder.RequestFileName);
            var parsed = JsonSerializer.Deserialize<ScanTemplateFieldsRequest>(File.ReadAllText(path, Encoding.UTF8), JsonOptions.File);
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
