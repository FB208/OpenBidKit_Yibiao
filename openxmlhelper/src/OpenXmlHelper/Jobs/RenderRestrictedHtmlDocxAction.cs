using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Yibiao.OpenXmlHelper.Jobs;

sealed class RenderRestrictedHtmlDocxRequest
{
    public string Action { get; set; } = "";
    public string Html { get; set; } = "";
    public string Output { get; set; } = "preview.docx";

    /// <summary>配图所在目录，相对工作区；留空时使用任务目录。</summary>
    [JsonPropertyName("asset_root")]
    public string AssetRoot { get; set; } = "";

    [JsonPropertyName("export_format")]
    public JsonElement ExportFormat { get; set; }
}

/// <summary>把受限 HTML 按导出模板配置生成一份新的 Word 文档。</summary>
static class RenderRestrictedHtmlDocxAction
{
    public const string Name = "render-restricted-html-docx";

    /// <summary>读取任务参数，在当前任务目录中生成 docx。</summary>
    public static JobResult Execute(string workspace, string jobId)
    {
        try
        {
            var jobDirectory = JobFolder.GetJobDirectory(workspace, jobId);
            var requestPath = Path.Combine(jobDirectory, JobFolder.RequestFileName);
            var request = JsonSerializer.Deserialize<RenderRestrictedHtmlDocxRequest>(
                File.ReadAllText(requestPath, Encoding.UTF8),
                JsonOptions.File);
            if (request is null
                || string.IsNullOrWhiteSpace(request.Html)
                || request.ExportFormat.ValueKind != JsonValueKind.Object)
            {
                return JobResult.Fail("request.json 缺少 html 或 export_format");
            }

            var outputName = string.IsNullOrWhiteSpace(request.Output) ? "preview.docx" : request.Output.Trim();
            if (!string.Equals(outputName, Path.GetFileName(outputName), StringComparison.Ordinal)
                || !string.Equals(Path.GetExtension(outputName), ".docx", StringComparison.OrdinalIgnoreCase))
            {
                return JobResult.Fail("output 必须是当前任务目录内的 docx 文件名");
            }

            // 样张配图在多次预览之间不变，允许调用方指定一份共享目录，省去每次任务复制。
            var assetRoot = string.IsNullOrWhiteSpace(request.AssetRoot)
                ? jobDirectory
                : WordWorkspace.ResolveWorkspacePath(workspace, request.AssetRoot);
            if (!Directory.Exists(assetRoot))
            {
                return JobResult.Fail($"配图目录不存在：{request.AssetRoot}");
            }

            var outputPath = Path.Combine(jobDirectory, outputName);
            var rendered = RestrictedHtmlDocumentRenderer.Render(
                assetRoot,
                outputPath,
                request.Html,
                request.ExportFormat);
            var result = JobResult.Success(Name, outputName, rendered.BlockCount);
            result.ParagraphRoles = rendered.ParagraphRoles;
            return result;
        }
        catch (Exception exception)
        {
            return JobResult.Fail(exception.Message);
        }
    }
}
