using System.Text;
using System.Text.Json;
using DocumentFormat.OpenXml.Packaging;

namespace Yibiao.OpenXmlHelper.Jobs;

sealed class ReadTemplateLayoutRequest
{
    public string Action { get; set; } = "";
    public string Input { get; set; } = "";
}

/// <summary>读取投标模版版式，供商务模版确认弹窗按原表格、原段落还原表单。</summary>
static class ReadTemplateLayoutAction
{
    public const string Name = "read-template-layout";
    public const string OutputFileName = "template-layout.json";

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
            using var document = WordprocessingDocument.Open(inputPath, false);
            var layout = TemplateLayoutReader.Read(document);
            var outputPath = Path.Combine(JobFolder.GetJobDirectory(workspace, jobId), OutputFileName);
            File.WriteAllText(
                outputPath,
                JsonSerializer.Serialize(layout, JsonOptions.Signal) + "\n",
                new UTF8Encoding(false));
            return JobResult.Success(Name, OutputFileName, layout.Blocks.Count);
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

    static bool TryReadRequest(string workspace, string jobId, out ReadTemplateLayoutRequest request, out string error)
    {
        request = new ReadTemplateLayoutRequest();
        error = "";
        try
        {
            var path = Path.Combine(JobFolder.GetJobDirectory(workspace, jobId), JobFolder.RequestFileName);
            var parsed = JsonSerializer.Deserialize<ReadTemplateLayoutRequest>(File.ReadAllText(path, Encoding.UTF8), JsonOptions.File);
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
