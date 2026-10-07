using System.Text;
using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;
using DW = DocumentFormat.OpenXml.Drawing.Wordprocessing;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>以空白底稿为基准，把字段值写入对应内容控件，生成已填写的投标模版。</summary>
static class FillTemplateFieldsAction
{
    public const string Name = "fill-template-fields";

    public static JobResult Execute(string workspace, string jobId)
    {
        if (!TryReadRequest(workspace, jobId, out var request, out var error))
        {
            return JobResult.Fail(error);
        }

        string? tempDocumentPath = null;
        try
        {
            var inputPath = WordWorkspace.ResolveWorkspacePath(workspace, request.Input);
            var outputPath = WordWorkspace.ResolveWorkspacePath(workspace, request.Output);
            if (!File.Exists(inputPath)) return JobResult.Fail("商务模版空白底稿不存在，请重新生成目录");
            if (WordWorkspace.PathsEqual(inputPath, outputPath)) return JobResult.Fail("空白底稿和填写结果不能使用同一路径");
            var values = NormalizeValues(request.Values);
            foreach (var value in values.Where(item => item.Image is not null))
            {
                value.Image = WordWorkspace.ResolveWorkspacePath(workspace, value.Image!);
                if (!File.Exists(value.Image)) return JobResult.Fail($"附件图片不存在：{value.Id}");
            }

            Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
            tempDocumentPath = $"{outputPath}.{Guid.NewGuid():N}.tmp.docx";
            WordWorkspace.CopyToWritable(inputPath, tempDocumentPath);

            using (var document = WordprocessingDocument.Open(tempDocumentPath, true))
            {
                var wordDocument = document.MainDocumentPart?.Document ?? throw new InvalidOperationException("投标模版缺少正文部件");
                // 文本框兼容显示（mc:Fallback）只有纯文字占位，不含内容控件。
                var controls = (wordDocument.Body?.Descendants<Wp.SdtElement>() ?? [])
                    .Where(item => !item.Ancestors<AlternateContentFallback>().Any())
                    .Select(item => (Control: item, Tag: item.GetFirstChild<Wp.SdtProperties>()?.GetFirstChild<Wp.Tag>()?.Val?.Value ?? ""))
                    .Where(item => item.Tag.StartsWith(TemplateFieldSdtWriter.TagPrefix, StringComparison.Ordinal))
                    .GroupBy(item => item.Tag[TemplateFieldSdtWriter.TagPrefix.Length..], StringComparer.Ordinal)
                    .ToDictionary(group => group.Key, group => group.Select(item => item.Control).ToList(), StringComparer.Ordinal);

                var mainPart = document.MainDocumentPart!;
                var drawingId = wordDocument.Descendants<DW.DocProperties>()
                    .Select(item => item.Id?.Value ?? 0U)
                    .DefaultIfEmpty(0U)
                    .Max();
                var writtenElements = new List<OpenXmlElement>();
                foreach (var value in values)
                {
                    if (!controls.TryGetValue(value.Id, out var matched))
                    {
                        throw new InvalidOperationException($"模版字段 {value.Id} 不存在，请重新生成目录");
                    }
                    if (matched.Count != 1)
                    {
                        throw new InvalidOperationException($"模版字段 {value.Id} 对应 {matched.Count} 个内容控件，请重新生成目录");
                    }
                    writtenElements.AddRange(TemplateFieldSdtWriter.Fill(mainPart, matched[0], value, () => ++drawingId));
                }

                wordDocument.Save();
                // 与 apply-template-fields 一致，只校验本动作写入且仍留在文档中的元素。
                var validator = new OpenXmlValidator(FileFormatVersions.Microsoft365);
                var validationErrors = writtenElements
                    .Where(item => item.Ancestors<Wp.Document>().Any())
                    .SelectMany(item => validator.Validate(item))
                    .Take(10)
                    .ToList();
                if (validationErrors.Count > 0)
                {
                    var details = string.Join("；", validationErrors.Select(item => item.Description));
                    throw new InvalidOperationException($"投标模版 Open XML 校验失败：{details}");
                }
            }

            File.Move(tempDocumentPath, outputPath, overwrite: true);
            tempDocumentPath = null;
            return JobResult.Success(Name, WordWorkspace.ToRelativePath(workspace, outputPath), values.Count);
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException or IOException)
        {
            return WordWorkspace.FileAccessFailure(workspace, request.Output);
        }
        catch (Exception exception)
        {
            return JobResult.Fail(exception.Message);
        }
        finally
        {
            TryDelete(tempDocumentPath);
        }
    }

    /// <summary>每个字段只能出现一次，文字、勾选项、图片、留空恰好给出一种；文字值和图片路径非空，勾选项至少选中一项。</summary>
    static List<TemplateFieldFillValue> NormalizeValues(IEnumerable<TemplateFieldFillValue>? source)
    {
        var values = (source ?? []).Select(item => new TemplateFieldFillValue
        {
            Id = (item.Id ?? "").Trim(),
            Value = item.Value,
            Selected = item.Selected?.Select(option => (option ?? "").Trim()).Where(option => option.Length > 0).Distinct(StringComparer.Ordinal).ToList(),
            Image = string.IsNullOrWhiteSpace(item.Image) ? null : item.Image.Trim(),
            Blank = item.Blank,
        }).ToList();
        var problems = new List<string>();
        var duplicates = values.GroupBy(item => item.Id, StringComparer.Ordinal).Where(group => group.Count() > 1).Select(group => group.Key).ToList();
        if (duplicates.Count > 0) problems.Add($"字段重复：{string.Join('、', duplicates)}");
        if (values.Any(item => item.Id.Length == 0)) problems.Add("存在缺少 id 的字段");
        var invalid = values
            .Where(item => (item.Value is not null ? 1 : 0) + (item.Selected is not null ? 1 : 0) + (item.Image is not null ? 1 : 0) + (item.Blank == true ? 1 : 0) != 1
                || (item.Selected is not null ? item.Selected.Count == 0 : item.Value is not null && string.IsNullOrWhiteSpace(item.Value)))
            .Select(item => item.Id)
            .ToList();
        if (invalid.Count > 0) problems.Add($"字段值为空，或未恰好给出文字、勾选项、图片、留空之一：{string.Join('、', invalid)}");
        if (problems.Count > 0) throw new InvalidOperationException($"回填字段无效：{string.Join("；", problems)}");
        return values;
    }

    static bool TryReadRequest(string workspace, string jobId, out FillTemplateFieldsRequest request, out string error)
    {
        request = new FillTemplateFieldsRequest();
        error = "";
        try
        {
            var path = Path.Combine(JobFolder.GetJobDirectory(workspace, jobId), JobFolder.RequestFileName);
            var parsed = JsonSerializer.Deserialize<FillTemplateFieldsRequest>(File.ReadAllText(path, Encoding.UTF8), JsonOptions.File);
            if (parsed is null || string.IsNullOrWhiteSpace(parsed.Input) || string.IsNullOrWhiteSpace(parsed.Output))
            {
                error = "request.json 缺少 input 或 output";
                return false;
            }
            request = parsed;
            request.Input = request.Input.Trim();
            request.Output = request.Output.Trim();
            return true;
        }
        catch (Exception exception)
        {
            error = $"无法读取 request.json：{exception.Message}";
            return false;
        }
    }

    static void TryDelete(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        try { File.Delete(path); } catch {}
    }
}
