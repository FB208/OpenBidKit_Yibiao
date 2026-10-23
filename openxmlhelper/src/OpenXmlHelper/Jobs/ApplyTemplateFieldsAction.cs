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
            WordWorkspace.CopyToWritable(inputPath, tempDocumentPath);

            var chapterRanges = TemplateChapterRanges.Read(inputPath);
            TemplateFieldDefinitionFile definitions;
            using (var document = WordprocessingDocument.Open(tempDocumentPath, true))
            {
                var candidates = TemplateFieldScanner.Scan(document, chapterRanges);
                var normalized = NormalizeSelections(request, candidates);
                var mainPart = document.MainDocumentPart ?? throw new InvalidOperationException("投标模版缺少正文部件");
                var body = mainPart.Document.Body ?? throw new InvalidOperationException("投标模版正文为空");
                // 写入会插入附件段落、把跨段勾选项包进块级控件，先记下各章首块，写完再换算块号。
                var chapterStarts = chapterRanges.Select(item => body.ChildElements[item.StartBlock]).ToList();
                var nextWordId = mainPart.Document.Descendants<Wp.SdtId>()
                    .Select(item => item.Val?.Value ?? 0)
                    .DefaultIfEmpty(0)
                    .Max() + 1;
                definitions = new TemplateFieldDefinitionFile();
                var applications = new List<(TemplateFieldCandidate Candidate, List<(TemplateFieldDefinition Field, int WordId)> Fields)>();
                foreach (var item in normalized.OrderBy(item => item.Candidate.Order))
                {
                    var kind = TemplateFieldKinds.ToFieldKind(item.Candidate.Kind);
                    var fields = new List<(TemplateFieldDefinition Field, int WordId)>();
                    // 拆分的附件按部分顺序各占一个字段，未拆分的候选只有一项。
                    foreach (var part in item.Fields)
                    {
                        var field = new TemplateFieldDefinition
                        {
                            Id = $"f{definitions.Fields.Count + 1:D4}",
                            Name = part.Name,
                            Subject = item.Selection.Subject,
                            Section = ResolveSection(item.Candidate),
                            FillBy = part.FillBy,
                            // 人工字段的位置标签或 Agent 定的字段名符合扫描器的签字、签章、手印、盖章规则时，记为签章位置。
                            Signature = part.FillBy == "manual"
                                && (item.Candidate.SuggestedFillBy == "manual" || TemplateFieldScanner.SuggestFillBy(part.Name, "") == "manual")
                                ? true
                                : null,
                            Instruction = part.Instruction,
                            Kind = kind,
                            Options = kind == TemplateFieldKinds.ChoiceField ? item.Candidate.Options : null,
                            TableId = item.Candidate.TableId,
                            Row = item.Candidate.TableId is null ? null : item.Candidate.RowNumber,
                        };
                        definitions.Fields.Add(field);
                        fields.Add((field, nextWordId++));
                    }
                    applications.Add((item.Candidate, fields));
                }

                var writtenElements = new List<OpenXmlElement>();
                foreach (var application in applications
                    .OrderByDescending(item => item.Candidate.Start)
                    .ThenByDescending(item => item.Candidate.Order))
                {
                    writtenElements.AddRange(application.Fields.Count == 1
                        ? TemplateFieldSdtWriter.Apply(application.Candidate, application.Fields[0].Field, application.Fields[0].WordId)
                        : TemplateFieldSdtWriter.ApplyAttachmentParts(application.Candidate, application.Fields));
                }

                definitions.Chapters = ResolveFinalChapters(body, chapterRanges, chapterStarts);
                mainPart.Document.Save();
                // 原件自带的不规范写法由 Word/WPS 兼容，只校验本动作写入且仍留在文档中的元素。
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

            VerifyFieldControls(tempDocumentPath, definitions);

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
            TryDelete(tempFieldsPath);
        }
    }

    /// <summary>按各章首块写入后所在的顶层块换算最终块号；章节首尾相接，最后一章止于正文末尾（不含分节属性）。</summary>
    static List<TemplateChapterRange> ResolveFinalChapters(
        Wp.Body body,
        IReadOnlyList<TemplateChapterRange> chapterRanges,
        IReadOnlyList<OpenXmlElement> chapterStarts)
    {
        var blocks = body.ChildElements.ToList();
        var blockCount = blocks.Count(item => item is not Wp.SectionProperties);
        var starts = chapterStarts.Select((element, index) =>
        {
            var top = element.Parent is Wp.Body ? element : element.Ancestors().FirstOrDefault(item => item.Parent is Wp.Body);
            var position = top is null ? -1 : blocks.IndexOf(top);
            if (position < 0) throw new InvalidOperationException($"写入字段后找不到章节起点：{chapterRanges[index].Title}");
            return position;
        }).ToList();
        return chapterRanges.Select((item, index) => new TemplateChapterRange
        {
            Id = item.Id,
            Title = item.Title,
            AutoFill = item.AutoFill,
            StartBlock = starts[index],
            EndBlock = index + 1 < starts.Count ? starts[index + 1] : blockCount,
        }).ToList();
    }

    /// <summary>重新打开保存后的模版，确认每个字段恰好对应一个内容控件且控件 id 唯一。</summary>
    static void VerifyFieldControls(string documentPath, TemplateFieldDefinitionFile definitions)
    {
        using var document = WordprocessingDocument.Open(documentPath, false);
        // 文本框兼容显示（mc:Fallback）只同步文字，不含内容控件。
        var controls = (document.MainDocumentPart?.Document?.Body?.Descendants<Wp.SdtProperties>() ?? [])
            .Where(item => !item.Ancestors<AlternateContentFallback>().Any())
            .Select(item => (
                Tag: item.GetFirstChild<Wp.Tag>()?.Val?.Value ?? "",
                WordId: item.GetFirstChild<Wp.SdtId>()?.Val?.Value))
            .ToList();
        var wordIdCounts = controls
            .Where(item => item.WordId is not null)
            .GroupBy(item => item.WordId!.Value)
            .ToDictionary(group => group.Key, group => group.Count());
        var problems = new List<string>();
        foreach (var field in definitions.Fields)
        {
            var matched = controls.Where(item => item.Tag == $"{TemplateFieldSdtWriter.TagPrefix}{field.Id}").ToList();
            if (matched.Count != 1)
            {
                problems.Add($"{field.Name}（{field.Id}）对应 {matched.Count} 个内容控件");
            }
            else if (matched[0].WordId is not int wordId || wordIdCounts[wordId] != 1)
            {
                problems.Add($"{field.Name}（{field.Id}）的内容控件 id 缺失或重复");
            }
        }

        if (problems.Count > 0)
        {
            throw new InvalidOperationException($"投标模版产物检查失败：{string.Join("；", problems.Take(10))}");
        }
    }

    /// <summary>规范化后的分类：Fields 为最终字段的名称、说明与填写方式，拆分的附件按部分顺序展开。</summary>
    sealed record NormalizedSelection(
        TemplateFieldCandidate Candidate,
        TemplateFieldSelection Selection,
        IReadOnlyList<NormalizedField> Fields);

    sealed record NormalizedField(string Name, string? Instruction, string FillBy);

    static List<NormalizedSelection> NormalizeSelections(
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
            Subject = (item.Subject ?? "").Trim(),
            FillBy = (item.FillBy ?? "").Trim().ToLowerInvariant(),
            Instruction = string.IsNullOrWhiteSpace(item.Instruction) ? null : item.Instruction.Trim(),
            Parts = item.Parts?.Select(part => new TemplateFieldPart
            {
                Name = (part.Name ?? "").Trim(),
                Instruction = string.IsNullOrWhiteSpace(part.Instruction) ? null : part.Instruction.Trim(),
            }).ToList(),
        }).ToList();
        if (selections.Any(item => item.CandidateId.Length == 0 || item.Name.Length == 0 || item.Subject.Length == 0))
        {
            throw new InvalidOperationException("模板字段缺少 candidate_id、name 或 subject");
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

        // parts 只用于附件位置，至少两项且候选内不重名；部分未写 instruction 时沿用所在项。
        var partErrors = new List<string>();
        foreach (var item in selections.Where(item => item.Parts is not null))
        {
            var candidateKind = candidateMap[item.CandidateId].Kind;
            if (candidateKind is not (TemplateFieldKinds.AttachmentSlot or TemplateFieldKinds.AttachmentNote))
            {
                partErrors.Add($"{item.CandidateId} 不是附件位置，不能使用 parts");
                continue;
            }
            var parts = item.Parts!;
            if (parts.Count < 2) partErrors.Add($"{item.CandidateId} 的 parts 至少需要两项，只有一张图片时不要使用 parts");
            if (parts.Any(part => part.Name.Length == 0)) partErrors.Add($"{item.CandidateId} 的 parts 存在空名称");
            var duplicatedParts = parts.GroupBy(part => part.Name, StringComparer.Ordinal).Where(group => group.Count() > 1).Select(group => group.Key).ToList();
            if (duplicatedParts.Count > 0) partErrors.Add($"{item.CandidateId} 的 parts 名称重复：{string.Join('、', duplicatedParts)}");
        }
        if (partErrors.Count > 0)
        {
            throw new InvalidOperationException($"附件拆分无效：{string.Join("；", partErrors)}");
        }

        // 非自动填写章节的字段改为人工；同名字段在自动填写章节中由程序填写时，这些位置沿用同一个值。拆分的附件按各部分名称分别判断。
        IEnumerable<string> SelectionNames(TemplateFieldSelection item) => item.Parts?.Select(part => part.Name) ?? [item.Name];
        var autoFilledNames = selections
            .Where(item => candidateMap[item.CandidateId].Chapter?.AutoFill != false && item.FillBy == "ai")
            .SelectMany(SelectionNames)
            .ToHashSet(StringComparer.Ordinal);

        var normalized = selections.Select(item =>
        {
            var manualChapter = candidateMap[item.CandidateId].Chapter?.AutoFill == false;
            NormalizedField ToField(string name, string? instruction) => new(
                name,
                instruction,
                manualChapter ? (autoFilledNames.Contains(name) ? "ai" : "manual") : item.FillBy);
            return new NormalizedSelection(
                candidateMap[item.CandidateId],
                item,
                item.Parts is { } parts
                    ? parts.Select(part => ToField(part.Name, part.Instruction ?? item.Instruction)).ToList()
                    : [ToField(item.Name, item.Instruction)]);
        }).ToList();
        var expanded = normalized
            .SelectMany(item => item.Fields.Select(field => (
                field.Name,
                field.Instruction,
                item.Selection.Subject,
                field.FillBy,
                item.Selection.CandidateId,
                Kind: TemplateFieldKinds.ToFieldKind(item.Candidate.Kind))))
            .ToList();

        var inconsistent = expanded
            .GroupBy(item => item.Name, StringComparer.Ordinal)
            .FirstOrDefault(group => group.Select(item => $"{item.Subject}\u0000{item.FillBy}\u0000{item.Instruction ?? ""}").Distinct(StringComparer.Ordinal).Count() > 1);
        if (inconsistent is not null)
        {
            throw new InvalidOperationException($"同名字段的 subject、fill_by 和 instruction 必须一致：{inconsistent.Key}");
        }

        var mixedKinds = expanded
            .GroupBy(item => item.Name, StringComparer.Ordinal)
            .FirstOrDefault(group => group.Select(item => item.Kind).Distinct(StringComparer.Ordinal).Count() > 1);
        if (mixedKinds is not null)
        {
            throw new InvalidOperationException($"同名字段的类型必须一致（文本、勾选项、附件不能同名）：{mixedKinds.Key}，涉及 {string.Join('、', mixedKinds.Select(item => item.CandidateId).Distinct(StringComparer.Ordinal))}");
        }

        return normalized;
    }

    /// <summary>章节名与表格标题以“ / ”连接，两者相同时只写一次，均为空时不写。</summary>
    static string? ResolveSection(TemplateFieldCandidate candidate)
    {
        var parts = new[] { candidate.ChapterName, candidate.TableTitle }
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Select(item => item!.Trim())
            .Distinct(StringComparer.Ordinal)
            .ToList();
        return parts.Count > 0 ? string.Join(" / ", parts) : null;
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
