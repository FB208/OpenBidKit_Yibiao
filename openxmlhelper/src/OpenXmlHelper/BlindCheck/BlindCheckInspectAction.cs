using System.Diagnostics;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Yibiao.OpenXmlHelper.BlindCheck.Model;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;
using Yibiao.OpenXmlHelper.BlindCheck.Rules;
using Yibiao.OpenXmlHelper.Jobs;

namespace Yibiao.OpenXmlHelper.BlindCheck;

sealed class SensitiveWord
{
    public string Text { get; set; } = "";
    /// <summary>custom：预设里的自定义敏感词；credential：资信库中的本单位信息。</summary>
    public string Source { get; set; } = "custom";
}

/// <summary>Main 用 nativeImage 抽样得到的单张图片结论。</summary>
sealed class ImageFact
{
    public string Part { get; set; } = "";
    public bool Color { get; set; }

    [JsonPropertyName("color_ratio")]
    public double ColorRatio { get; set; }
}

class BlindCheckInspectRequest
{
    public string Action { get; set; } = "";
    public string Source { get; set; } = "";
    public JsonObject? Profile { get; set; }

    [JsonPropertyName("sensitive_words")]
    public List<SensitiveWord> SensitiveWords { get; set; } = [];

    [JsonPropertyName("image_facts")]
    public List<ImageFact> ImageFacts { get; set; } = [];

    /// <summary>没有目录可依时是否按编号兜底认标题。修复删除了目录、而原文按目录认标题时，修复副本的复查传 false，标题认法与检查时一致。</summary>
    [JsonPropertyName("heading_fallback")]
    public bool HeadingFallback { get; set; } = true;
}

sealed class BlindCheckStats
{
    public int Paragraphs { get; init; }
    public int BodyParagraphs { get; init; }
    public int TableParagraphs { get; init; }
    public int Tables { get; init; }
    public int Sections { get; init; }
    public int TocEntries { get; init; }
    public int Headings { get; init; }
    public Dictionary<string, int> HeadingSources { get; init; } = [];
    public int CoverParagraphs { get; init; }
    public int Images { get; init; }
    public Dictionary<string, int> ImageFormats { get; init; } = [];
    public int VectorImages { get; init; }
    public int RulesChecked { get; init; }
    public long DurationMs { get; init; }
}

sealed class BlindCheckReport
{
    public int Version { get; init; } = 1;
    public Dictionary<string, int> Summary { get; init; } = [];
    public BlindCheckStats Stats { get; init; } = new();
    public List<FindingGroup> Groups { get; init; } = [];
    public List<string> RuleErrors { get; init; } = [];
}

/// <summary>
/// 暗标合规检查：读取工作区内的 docx，按预设逐条规则检查，归并后写出结果文件。
/// 进度写在任务目录的 progress.json（先写临时文件再替换），信号格式不变。
/// </summary>
static class BlindCheckInspectAction
{
    public const string Name = "blind-check-inspect";
    public const string ProgressFileName = "progress.json";
    public const string OutputFileName = "blind-check-result.json";

    static readonly JsonSerializerOptions OutputOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

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

        var progress = new ProgressWriter(Path.Combine(jobDir, ProgressFileName));
        try
        {
            var sourcePath = WordWorkspace.ResolveWorkspacePath(workspace, request.Source);
            if (!File.Exists(sourcePath)) return JobResult.Fail("找不到待检查的文档，请重新选择文件");

            using var session = BlindCheckSession.Open(sourcePath, request, new ProgressRange(progress, 0, 0.45));
            var report = session.Inspect(new ProgressRange(progress, 0.45, 0.98));
            WriteJson(Path.Combine(jobDir, OutputFileName), report);
            progress.Report(0.99, "检查完成");
            return JobResult.Success(Name, OutputFileName);
        }
        catch (InvalidOperationException exception)
        {
            return JobResult.Fail(exception.Message);
        }
        catch (Exception exception)
        {
            return JobResult.Fail(UnexpectedMessage("暗标检查失败", exception));
        }
    }

    public static void WriteJson(string path, object value)
    {
        File.WriteAllText(path, JsonSerializer.Serialize(value, OutputOptions), new UTF8Encoding(false));
    }

    /// <summary>未预期的异常保留类型和调用栈前几行，便于用户反馈后定位。</summary>
    public static string UnexpectedMessage(string title, Exception exception)
    {
        var stack = string.Join('\n', (exception.StackTrace ?? "").Split('\n').Take(8).Select(line => line.TrimEnd()));
        return $"{title}：{exception.GetType().Name}: {exception.Message}\n{stack}";
    }
}
