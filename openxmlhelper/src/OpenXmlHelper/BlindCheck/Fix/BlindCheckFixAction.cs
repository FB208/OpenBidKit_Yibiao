using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;
using Yibiao.OpenXmlHelper.Jobs;

namespace Yibiao.OpenXmlHelper.BlindCheck.Fix;

sealed class BlindCheckFixRequest : BlindCheckInspectRequest
{
    /// <summary>修复副本在工作区内的相对路径；原文件不改动。</summary>
    public string Output { get; set; } = "";

    [JsonPropertyName("fix_rules")]
    public List<string> FixRules { get; set; } = [];
}

sealed class BlindCheckFixReport
{
    public int Version { get; init; } = 1;
    public string Output { get; init; } = "";
    public long SourceBytes { get; init; }
    public long OutputBytes { get; init; }
    public Dictionary<string, int> Fixes { get; init; } = [];
    public List<string> Notes { get; init; } = [];
    public FixValidationResult Validation { get; init; } = new();
    public long DurationMs { get; init; }

    /// <summary>复查修复副本时是否按编号兜底认标题；删除了原文赖以认标题的目录时为 false，后续复查修复副本要沿用。</summary>
    public bool HeadingFallback { get; init; } = true;
    public BlindCheckReport After { get; init; } = new();
}

/// <summary>
/// 暗标自动修复：在检查模型上按选中的规则最小改动，写出工作区副本，用 Open XML SDK 对比校验，
/// 再用同一份预设复查副本。校验发现修复引入的新错误时不交付副本。
/// </summary>
static class BlindCheckFixAction
{
    public const string Name = "blind-check-fix";
    public const string OutputFileName = "blind-check-fix-result.json";

    public static JobResult Execute(string workspace, string jobId)
    {
        string jobDir;
        BlindCheckFixRequest request;
        try
        {
            jobDir = JobFolder.GetJobDirectory(workspace, jobId);
            var json = File.ReadAllText(Path.Combine(jobDir, JobFolder.RequestFileName), Encoding.UTF8);
            request = JsonSerializer.Deserialize<BlindCheckFixRequest>(json, JsonOptions.File) ?? throw new InvalidOperationException("request.json 无效");
        }
        catch (Exception exception)
        {
            return JobResult.Fail($"无法读取 request.json：{exception.Message}");
        }

        var progress = new ProgressWriter(Path.Combine(jobDir, BlindCheckInspectAction.ProgressFileName));
        string? outputPath = null;
        try
        {
            var sourcePath = WordWorkspace.ResolveWorkspacePath(workspace, request.Source);
            if (!File.Exists(sourcePath)) return JobResult.Fail("找不到待修复的文档，请重新选择文件");
            if (request.FixRules.Count == 0) return JobResult.Fail("请至少选择一项修复内容");
            outputPath = WordWorkspace.ResolveWorkspacePath(workspace, request.Output);
            var stopwatch = Stopwatch.StartNew();

            Dictionary<string, int> fixes;
            List<string> notes;
            using (var session = BlindCheckSession.Open(sourcePath, request, new ProgressRange(progress, 0, 0.3)))
            {
                var writer = new DocxWriter(session.Package);
                var fix = new FixContext(session, writer);
                BlindCheckFixer.Run(fix, request.FixRules.ToHashSet(StringComparer.Ordinal), new ProgressRange(progress, 0.3, 0.45));
                fix.Commit();
                progress.Report(0.46, "正在写出修复副本");
                writer.Save(outputPath);
                fixes = fix.Counts;
                notes = fix.Notes;
                // 原文按目录认标题，目录删掉后复查若改按编号兜底，正文里的编号短句会被当成标题，报出并非修复引入的问题。
                if (fixes.ContainsKey("struct.toc") && session.Context.Outline.UsedToc) request.HeadingFallback = false;
            }

            progress.Report(0.5, "正在校验修复副本");
            var validation = FixValidation.Compare(sourcePath, outputPath);
            if (validation.NewErrors.Count > 0)
            {
                File.Delete(outputPath);
                return JobResult.Fail($"修复副本未通过 Open XML 结构校验，已放弃本次修复，原文件未改动：{string.Join("；", validation.NewErrors.Take(5))}");
            }

            if (validation.SkippedReason.Length > 0) notes.Add(validation.SkippedReason);
            BlindCheckReport after;
            using (var session = BlindCheckSession.Open(outputPath, request, new ProgressRange(progress, 0.62, 0.75)))
            {
                after = session.Inspect(new ProgressRange(progress, 0.75, 0.98));
            }

            var report = new BlindCheckFixReport
            {
                Output = request.Output,
                SourceBytes = new FileInfo(sourcePath).Length,
                OutputBytes = new FileInfo(outputPath).Length,
                Fixes = fixes,
                Notes = notes,
                Validation = validation,
                DurationMs = stopwatch.ElapsedMilliseconds,
                HeadingFallback = request.HeadingFallback,
                After = after,
            };
            BlindCheckInspectAction.WriteJson(Path.Combine(jobDir, OutputFileName), report);
            progress.Report(0.99, "修复完成");
            return JobResult.Success(Name, OutputFileName);
        }
        catch (InvalidOperationException exception)
        {
            TryDelete(outputPath);
            return JobResult.Fail(exception.Message);
        }
        catch (Exception exception)
        {
            TryDelete(outputPath);
            return JobResult.Fail(BlindCheckInspectAction.UnexpectedMessage("暗标修复失败", exception));
        }
    }

    static void TryDelete(string? path)
    {
        try
        {
            if (path is not null && File.Exists(path)) File.Delete(path);
        }
        catch (IOException)
        {
        }
    }
}
