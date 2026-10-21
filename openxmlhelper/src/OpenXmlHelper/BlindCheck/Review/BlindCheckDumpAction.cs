using System.Text;
using System.Text.Json;
using Yibiao.OpenXmlHelper.Jobs;

namespace Yibiao.OpenXmlHelper.BlindCheck.Review;

/// <summary>导出标书结构：按段落编号逐行列出正文、页眉页脚、分节页码和图片，供 AI 复核阅读和定位。</summary>
static class BlindCheckDumpAction
{
    public const string Name = "blind-check-dump";
    public const string OutputFileName = "blind-check-dump.json";

    public static JobResult Execute(string workspace, string jobId)
    {
        string jobDir;
        BlindCheckInspectRequest request;
        try
        {
            jobDir = JobFolder.GetJobDirectory(workspace, jobId);
            var json = File.ReadAllText(Path.Combine(jobDir, JobFolder.RequestFileName), Encoding.UTF8);
            request = JsonSerializer.Deserialize<BlindCheckInspectRequest>(json, JsonOptions.File) ?? throw new InvalidOperationException("request.json 无效");
        }
        catch (Exception exception)
        {
            return JobResult.Fail($"无法读取 request.json：{exception.Message}");
        }

        var progress = new ProgressWriter(Path.Combine(jobDir, BlindCheckInspectAction.ProgressFileName));
        try
        {
            var sourcePath = WordWorkspace.ResolveWorkspacePath(workspace, request.Source);
            if (!File.Exists(sourcePath)) return JobResult.Fail("找不到要导出的文档，请重新选择文件");
            using var session = BlindCheckSession.Open(sourcePath, request, new ProgressRange(progress, 0, 0.9));
            BlindCheckInspectAction.WriteJson(Path.Combine(jobDir, OutputFileName), DocumentDump.Build(session.Context));
            progress.Report(0.99, "导出完成");
            return JobResult.Success(Name, OutputFileName);
        }
        catch (InvalidOperationException exception)
        {
            return JobResult.Fail(exception.Message);
        }
        catch (Exception exception)
        {
            return JobResult.Fail(BlindCheckInspectAction.UnexpectedMessage("导出标书结构失败", exception));
        }
    }
}
