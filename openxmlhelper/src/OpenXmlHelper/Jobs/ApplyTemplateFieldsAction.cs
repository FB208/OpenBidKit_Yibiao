using System.Text;
using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>按 Agent 的候选分类生成带内容控件的最终模板及精简字段清单。</summary>
static class ApplyTemplateFieldsAction
{
    public const string Name = "apply-template-fields";

    public static JobResult Execute(string workspace, string jobId)
    {
        if (!TryReadRequest(workspace, jobId, out var request, out var error))
        {
            return JobResult.Fail(error);
        }

        string? tempDocumentPath = null;
        string? tempFieldsPath = null;
        try
        {
            var inputPath = WordWorkspace.ResolveWorkspacePath(workspace, request.Input);
            var outputPath = WordWorkspace.ResolveWorkspacePath(workspace, request.Output);
            var fieldsOutputPath = WordWorkspace.ResolveWorkspacePath(workspace, request.FieldsOutput);
            if (!File.Exists(inputPath)) return JobResult.Fail("投标模版源文件不存在");
            if (WordWorkspace.PathsEqual(inputPath, outputPath)) return JobResult.Fail("源模版和最终模版不能使用同一路径");

            Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
            Directory.CreateDirectory(Path.GetDirectoryName(fieldsOutputPath)!);
            tempDocumentPath = $"{outputPath}.{Guid.NewGuid():N}.tmp.docx";
            tempFieldsPath = $"{fieldsOutputPath}.{Guid.NewGuid():N}.tmp";
            File.Copy(inputPath, tempDocumentPath, overwrite: true);

            TemplateFieldDefinitionFile definitions;
            using (var document = WordprocessingDocument.Open(tempDocumentPath, true))
            {
                var candidates = TemplateFieldScanner.Scan(document);
                var normalized = NormalizeSelections(request, candidates);
                var mainPart = document.MainDocumentPart ?? throw new InvalidOperationException("投标模版缺少正文部件");
                var nextWordId = mainPart.Document.Descendants<Wp.SdtId>()
                    .Select(item => item.Val?.Value ?? 0)
                    .DefaultIfEmpty(0)
                    .Max() + 1;
                definitions = new TemplateFieldDefinitionFile();
                var applications = new List<(TemplateFieldCandidate Candidate, TemplateFieldDefinition Field, int WordId)>();
                foreach (var item in normalized.OrderBy(item => item.Candidate.Order))
                {
                    var field = new TemplateFieldDefinition
                    {
                        Id = $"f{definitions.Fields.Count + 1:D4}",
                        Name = item.Selection.Name,
                        FillBy = item.Selection.FillBy,
                        Instruction = item.Selection.Instruction,
                    };
                    definitions.Fields.Add(field);
                    applications.Add((item.Candidate, field, nextWordId++));
                }

                foreach (var application in applications
                    .OrderByDescending(item => item.Candidate.Start)
                    .ThenByDescending(item => item.Candidate.Order))
                {
                    TemplateFieldSdtWriter.Apply(application.Candidate, application.Field, application.WordId);
                }

                mainPart.Document.Save();
                var validationErrors = new OpenXmlValidator(FileFormatVersions.Microsoft365).Validate(document).Take(10).ToList();
                if (validationErrors.Count > 0)
                {
                    var details = string.Join("；", validationErrors.Select(item => item.Description));
                    throw new InvalidOperationException($"投标模版 Open XML 校验失败：{details}");
                }
            }

            File.WriteAllText(
                tempFieldsPath,
                JsonSerializer.Serialize(definitions, JsonOptions.File) + "\n",
                new UTF8Encoding(false));
            File.Move(tempDocumentPath, outputPath, overwrite: true);
            tempDocumentPath = null;
            File.Move(tempFieldsPath, fieldsOutputPath, overwrite: true);
            tempFieldsPath = null;
            return JobResult.Success(Name, WordWorkspace.ToRelativePath(workspace, outputPath), definitions.Fields.Count);
        }
        catch (Exception exception)
        {
            return JobResult.Fail(exception.Message);
        }
        finally
        {
            TryDelete(tempDocumentPath);
            TryDelete(tempFieldsPath);
        }
    }

    static List<(TemplateFieldCandidate Candidate, TemplateFieldSelection Selection)> NormalizeSelections(
        ApplyTemplateFieldsRequest request,
        TemplateFieldCandidateFile candidateFile)
    {
        var candidateMap = candidateFile.Candidates.ToDictionary(item => item.CandidateId, StringComparer.Ordinal);
        var ignoredIds = (request.IgnoredCandidateIds ?? [])
            .Select(item => (item ?? "").Trim())
            .Where(item => item.Length > 0)
            .ToList();

        var selections = (request.Fields ?? []).Select(item => new TemplateFieldSelection
        {
            CandidateId = (item.CandidateId ?? "").Trim(),
            Name = (item.Name ?? "").Trim(),
            FillBy = (item.FillBy ?? "").Trim().ToLowerInvariant(),
            Instruction = string.IsNullOrWhiteSpace(item.Instruction) ? null : item.Instruction.Trim(),
        }).ToList();
        if (selections.Any(item => item.CandidateId.Length == 0 || item.Name.Length == 0))
        {
            throw new InvalidOperationException("模板字段缺少 candidate_id 或 name");
        }
        if (selections.Any(item => item.FillBy is not ("ai" or "manual")))
        {
            throw new InvalidOperationException("fill_by 只能是 ai 或 manual");
        }

        var fieldIds = selections.Select(item => item.CandidateId).ToList();
        var duplicateFieldIds = fieldIds
            .GroupBy(item => item, StringComparer.Ordinal)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key)
            .ToList();
        var duplicateIgnoredIds = ignoredIds
            .GroupBy(item => item, StringComparer.Ordinal)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key)
            .ToList();
        var overlapIds = fieldIds.Intersect(ignoredIds, StringComparer.Ordinal).ToList();
        var classifiedIds = fieldIds.Concat(ignoredIds).Distinct(StringComparer.Ordinal).ToList();
        var unknownIds = classifiedIds.Where(item => !candidateMap.ContainsKey(item)).ToList();
        var missingIds = candidateMap.Keys.Except(classifiedIds, StringComparer.Ordinal).ToList();
        var classificationErrors = new List<string>();
        if (duplicateFieldIds.Count > 0) classificationErrors.Add($"fields 重复：{string.Join('、', duplicateFieldIds)}");
        if (duplicateIgnoredIds.Count > 0) classificationErrors.Add($"ignored_candidate_ids 重复：{string.Join('、', duplicateIgnoredIds)}");
        if (overlapIds.Count > 0) classificationErrors.Add($"同时出现在 fields 和 ignored_candidate_ids：{string.Join('、', overlapIds)}");
        if (unknownIds.Count > 0) classificationErrors.Add($"无效候选：{string.Join('、', unknownIds)}");
        if (missingIds.Count > 0) classificationErrors.Add($"尚未分类：{string.Join('、', missingIds)}");
        if (classificationErrors.Count > 0)
        {
            throw new InvalidOperationException(
                $"候选分类未通过（候选总数 {candidateMap.Count}，fields {selections.Count} 项，ignored_candidate_ids {ignoredIds.Count} 项）：{string.Join("；", classificationErrors)}。" +
                "apply-template-fields 不会记忆或合并前一次失败调用的参数；请重新提交完整 fields 和 ignored_candidate_ids，每个候选必须且只能归入一类，禁止增量补交或使用通配符。");
        }

        var inconsistent = selections
            .GroupBy(item => item.Name, StringComparer.Ordinal)
            .FirstOrDefault(group => group.Select(item => $"{item.FillBy}\u0000{item.Instruction ?? ""}").Distinct(StringComparer.Ordinal).Count() > 1);
        if (inconsistent is not null)
        {
            throw new InvalidOperationException($"同名字段的 fill_by 和 instruction 必须一致：{inconsistent.Key}");
        }

        return selections.Select(item => (candidateMap[item.CandidateId], item)).ToList();
    }

    static bool TryReadRequest(string workspace, string jobId, out ApplyTemplateFieldsRequest request, out string error)
    {
        request = new ApplyTemplateFieldsRequest();
        error = "";
        try
        {
            var path = Path.Combine(JobFolder.GetJobDirectory(workspace, jobId), JobFolder.RequestFileName);
            var parsed = JsonSerializer.Deserialize<ApplyTemplateFieldsRequest>(File.ReadAllText(path, Encoding.UTF8), JsonOptions.File);
            if (parsed is null
                || string.IsNullOrWhiteSpace(parsed.Input)
                || string.IsNullOrWhiteSpace(parsed.Output)
                || string.IsNullOrWhiteSpace(parsed.FieldsOutput))
            {
                error = "request.json 缺少 input、output 或 fields_output";
                return false;
            }
            request = parsed;
            request.Input = request.Input.Trim();
            request.Output = request.Output.Trim();
            request.FieldsOutput = request.FieldsOutput.Trim();
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
