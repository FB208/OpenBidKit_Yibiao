using System.Text;
using System.Text.Json;

namespace Yibiao.OpenXmlHelper.Jobs;

sealed class ListBlocksRequest
{
    public string Action { get; set; } = "";
    public List<string> Sources { get; set; } = [];
}

/// <summary>列出招标 Word 的段落和表格块，供 Agent 对齐一级目录。</summary>
static class ListBlocksAction
{
    public const string Name = "list-blocks";
    public const string OutputFileName = "blocks.json";

    public static JobResult Execute(string workspace, string jobId)
    {
        if (!TryReadRequest(workspace, jobId, out var request, out var error))
        {
            return JobResult.Fail(error);
        }

        try
        {
            var sourcePaths = WordWorkspace.ResolveSources(workspace, request.Sources);
            if (sourcePaths.Count == 0 || sourcePaths.Any(item => !File.Exists(item)))
            {
                return JobResult.Fail("请重新导入招标文件");
            }

            var session = WordWorkspace.OpenSources(workspace, sourcePaths);
            try
            {
                var payload = new
                {
                    sources = session.Values.Select(source => new
                    {
                        path = source.RelativePath,
                        blocks = source.Blocks.Select(block => new
                        {
                            index = block.BlockIndex,
                            kind = block.Kind,
                            heading = block.IsHeading,
                            outline_level = block.OutlineLevel,
                            empty = block.Text.Length == 0,
                            page_break = block.HasPageBreak,
                            section_break = block.HasSectionBreak,
                            text = WordWorkspace.PreviewText(block.Text),
                        }),
                    }),
                };

                var jobDir = JobFolder.GetJobDirectory(workspace, jobId);
                var outputPath = Path.Combine(jobDir, OutputFileName);
                File.WriteAllText(outputPath, JsonSerializer.Serialize(payload, JsonOptions.File) + "\n", new UTF8Encoding(false));
                var blockCount = session.Values.Sum(item => item.Blocks.Count);
                return JobResult.Success(Name, OutputFileName, blockCount);
            }
            finally
            {
                foreach (var source in session.Values)
                {
                    source.Dispose();
                }
            }
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException or IOException)
        {
            return WordWorkspace.FileAccessFailure(workspace, request.Sources);
        }
        catch (Exception exception)
        {
            return JobResult.Fail(exception.Message);
        }
    }

    static bool TryReadRequest(string workspace, string jobId, out ListBlocksRequest request, out string error)
    {
        request = new ListBlocksRequest();
        error = "";
        try
        {
            var path = Path.Combine(JobFolder.GetJobDirectory(workspace, jobId), JobFolder.RequestFileName);
            var parsed = JsonSerializer.Deserialize<ListBlocksRequest>(File.ReadAllText(path, Encoding.UTF8), JsonOptions.File);
            if (parsed is null)
            {
                error = "request.json 无效";
                return false;
            }

            request = parsed;
            return true;
        }
        catch (Exception exception)
        {
            error = $"无法读取 request.json：{exception.Message}";
            return false;
        }
    }
}
