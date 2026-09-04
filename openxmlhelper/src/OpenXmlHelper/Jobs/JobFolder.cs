using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>任务请求。</summary>
sealed class JobRequest
{
    public string Action { get; set; } = "";
}

/// <summary>任务结果。</summary>
sealed class JobResult
{
    public bool Ok { get; set; }
    public string? Action { get; set; }
    public string? Error { get; set; }
    public string? Output { get; set; }
    public int? BlockCount { get; set; }

    /// <summary>正文段落角色，按文档顺序；供预览侧按角色定位段落做增量改样式。</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<string>? ParagraphRoles { get; set; }

    public static JobResult Success(string action, string? output = null, int? blockCount = null) => new()
    {
        Ok = true,
        Action = action,
        Output = output,
        BlockCount = blockCount,
    };

    public static JobResult Fail(string error) => new() { Ok = false, Error = error };
}

/// <summary>解析任务目录并读写 request / result。</summary>
static class JobFolder
{
    public const string JobsFolderName = "openxml-jobs";
    public const string RequestFileName = "request.json";
    public const string ResultFileName = "result.json";

    static readonly Regex JobIdPattern = new("^[A-Za-z0-9._-]+$", RegexOptions.CultureInvariant | RegexOptions.Compiled);

    /// <summary>校验任务编号，防止路径穿越。</summary>
    public static bool IsValidJobId(string jobId)
    {
        return !string.IsNullOrWhiteSpace(jobId) && JobIdPattern.IsMatch(jobId);
    }

    public static string GetJobDirectory(string workspace, string jobId)
    {
        var jobsRoot = Path.GetFullPath(Path.Combine(workspace, JobsFolderName));
        var jobDir = Path.GetFullPath(Path.Combine(jobsRoot, jobId));
        if (!IsInsideDirectory(jobsRoot, jobDir))
        {
            throw new InvalidOperationException("任务目录越出工作区");
        }

        return jobDir;
    }

    /// <summary>读取 request.json；目录或文件不存在时返回失败原因。</summary>
    public static bool TryReadRequest(string workspace, string jobId, out JobRequest request, out string error)
    {
        request = new JobRequest();
        error = "";
        string jobDir;
        try
        {
            jobDir = GetJobDirectory(workspace, jobId);
        }
        catch (Exception exception)
        {
            error = exception.Message;
            return false;
        }

        if (!Directory.Exists(jobDir))
        {
            error = "找不到任务目录";
            return false;
        }

        var requestPath = Path.Combine(jobDir, RequestFileName);
        if (!File.Exists(requestPath))
        {
            error = "找不到 request.json";
            return false;
        }

        try
        {
            var json = File.ReadAllText(requestPath, Encoding.UTF8);
            var parsed = JsonSerializer.Deserialize<JobRequest>(json, JsonOptions.File);
            if (parsed is null || string.IsNullOrWhiteSpace(parsed.Action))
            {
                error = "request.json 缺少 action";
                return false;
            }

            request = parsed;
            request.Action = parsed.Action.Trim();
            return true;
        }
        catch (Exception exception)
        {
            error = $"无法读取 request.json：{exception.Message}";
            return false;
        }
    }

    /// <summary>写入 result.json。目录不存在时返回 false。</summary>
    public static bool TryWriteResult(string workspace, string jobId, JobResult result)
    {
        try
        {
            var jobDir = GetJobDirectory(workspace, jobId);
            if (!Directory.Exists(jobDir))
            {
                return false;
            }

            var json = JsonSerializer.Serialize(result, JsonOptions.File);
            File.WriteAllText(Path.Combine(jobDir, ResultFileName), json + "\n", new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            return true;
        }
        catch
        {
            return false;
        }
    }

    static bool IsInsideDirectory(string parent, string child)
    {
        var root = Path.GetFullPath(parent)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        var full = Path.GetFullPath(child);
        return full.StartsWith(root, StringComparison.OrdinalIgnoreCase);
    }
}
