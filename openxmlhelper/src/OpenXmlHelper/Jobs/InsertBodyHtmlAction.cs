using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Yibiao.OpenXmlHelper.Jobs;

sealed class InsertBodyHtmlRequest
{
    public string Action { get; set; } = "";
    public string Input { get; set; } = "";
    [JsonPropertyName("target_id")]
    public string TargetId { get; set; } = "";
    public string Html { get; set; } = "";
}

/// <summary>将受限 HTML 插入 Word 的指定块级内容控件。</summary>
static class InsertBodyHtmlAction
{
    public const string Name = "insert-body-html";

    public static JobResult Execute(string workspace, string jobId)
    {
        try
        {
            var requestPath = Path.Combine(JobFolder.GetJobDirectory(workspace, jobId), JobFolder.RequestFileName);
            var request = JsonSerializer.Deserialize<InsertBodyHtmlRequest>(File.ReadAllText(requestPath, Encoding.UTF8), JsonOptions.File);
            if (request is null
                || string.IsNullOrWhiteSpace(request.Input)
                || string.IsNullOrWhiteSpace(request.TargetId)
                || string.IsNullOrWhiteSpace(request.Html))
            {
                return JobResult.Fail("request.json 缺少 input、target_id 或 html");
            }

            var documentPath = WordWorkspace.ResolveWorkspacePath(workspace, request.Input);
            if (!File.Exists(documentPath)) return JobResult.Fail("Word 文件不存在");
            var blockCount = RestrictedHtmlWordInserter.Insert(documentPath, request.TargetId, request.Html);
            return JobResult.Success(Name, WordWorkspace.ToRelativePath(workspace, documentPath), blockCount);
        }
        catch (Exception exception)
        {
            return JobResult.Fail(exception.Message);
        }
    }
}
