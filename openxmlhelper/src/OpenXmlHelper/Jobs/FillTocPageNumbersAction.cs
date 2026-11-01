using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

sealed class FillTocPageNumbersRequest
{
    public string Action { get; set; } = "";
    public string Input { get; set; } = "";
    public string Output { get; set; } = "";

    /// <summary>目录书签到显示页码；没有或为空的条目页码留空。不传时不回填目录，文档也可以没有目录。</summary>
    [JsonPropertyName("page_numbers")]
    public Dictionary<string, string>? PageNumbers { get; set; }

    /// <summary>页码引用锚点书签到显示页码；不传时不回填页码引用。</summary>
    [JsonPropertyName("page_refs")]
    public Dictionary<string, string>? PageRefs { get; set; }
}

/// <summary>
/// 把 Main 测量得到的页码写入整本导出目录和页码引用的域缓存值；完整文档和只含目录的小文档都用此动作。
/// 只校验改动的目录内容控件和页码引用段落。
/// </summary>
static class FillTocPageNumbersAction
{
    public const string Name = "fill-toc-page-numbers";

    public static JobResult Execute(string workspace, string jobId)
    {
        try
        {
            var jobDirectory = JobFolder.GetJobDirectory(workspace, jobId);
            var request = JsonSerializer.Deserialize<FillTocPageNumbersRequest>(
                File.ReadAllText(Path.Combine(jobDirectory, JobFolder.RequestFileName), Encoding.UTF8),
                JsonOptions.File);
            if (request is null || !IsJobDocx(request.Input) || !IsJobDocx(request.Output))
            {
                return JobResult.Fail("input 和 output 必须是当前任务目录内的 docx 文件名");
            }
            var inputPath = Path.Combine(jobDirectory, request.Input.Trim());
            if (!File.Exists(inputPath)) return JobResult.Fail("待回填目录页码的 Word 不存在");

            using var stream = new MemoryStream();
            using (var source = File.OpenRead(inputPath)) source.CopyTo(stream);
            int? tocMissing = null;
            int? refMissing = null;
            using (var document = WordprocessingDocument.Open(stream, true))
            {
                var body = document.MainDocumentPart?.Document?.Body ?? throw new InvalidOperationException("Word 缺少正文");
                var touched = new List<OpenXmlElement>();
                if (request.PageNumbers is { } pageNumbers)
                {
                    var tocs = body.Descendants<Wp.SdtBlock>().Where(TableOfContentsBuilder.IsToc).ToList();
                    if (tocs.Count != 1) throw new InvalidOperationException("文档中没有程序生成的目录");
                    tocMissing = TableOfContentsBuilder.FillPageNumbers(tocs[0], pageNumbers);
                    touched.Add(tocs[0]);
                }
                if (request.PageRefs is { } pageRefs)
                {
                    refMissing = PageReferenceBuilder.FillPageNumbers(body, pageRefs, touched);
                }
                var validator = new OpenXmlValidator(FileFormatVersions.Microsoft365);
                var errors = touched.SelectMany(item => validator.Validate(item)).Take(10).ToList();
                if (errors.Count > 0) throw new InvalidOperationException($"页码 Open XML 校验失败：{string.Join("；", errors.Select(item => item.Description))}");
                document.MainDocumentPart!.Document.Save();
            }
            File.WriteAllBytes(Path.Combine(jobDirectory, request.Output.Trim()), stream.ToArray());
            var result = JobResult.Success(Name, request.Output.Trim());
            if (tocMissing is not null) result.Toc = new TocJobResult { MissingCount = tocMissing };
            if (refMissing is not null) result.PageRefs = new PageRefJobResult { MissingCount = refMissing };
            return result;
        }
        catch (Exception exception)
        {
            return JobResult.Fail(exception.Message);
        }
    }

    static bool IsJobDocx(string? name)
    {
        var value = (name ?? "").Trim();
        return value.Length > 0
            && string.Equals(value, Path.GetFileName(value), StringComparison.Ordinal)
            && string.Equals(Path.GetExtension(value), ".docx", StringComparison.OrdinalIgnoreCase);
    }
}
