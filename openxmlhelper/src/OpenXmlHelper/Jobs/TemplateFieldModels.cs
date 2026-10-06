using System.Text.Json.Serialization;
using DocumentFormat.OpenXml;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

sealed class TemplateFieldCandidateFile
{
    public int Version { get; set; } = 1;
    [JsonPropertyName("default_suggested_fill_by")]
    public string DefaultSuggestedFillBy { get; set; } = "ai";
    public List<TemplateFieldStructureContext> Contexts { get; set; } = [];
    public List<TemplateFieldCandidate> Candidates { get; set; } = [];
}

sealed class TemplateFieldStructureContext
{
    [JsonPropertyName("context_id")]
    public string ContextId { get; set; } = "";
    [JsonPropertyName("chapter_name")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ChapterName { get; set; }
    [JsonPropertyName("table_title")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? TableTitle { get; set; }
    [JsonPropertyName("column_header")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ColumnHeader { get; set; }
    [JsonPropertyName("group_title")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? GroupTitle { get; set; }
}

sealed class TemplateFieldCandidate
{
    [JsonPropertyName("candidate_id")]
    public string CandidateId { get; set; } = "";
    public string Kind { get; set; } = "";
    [JsonIgnore]
    public string Location { get; set; } = "";
    [JsonPropertyName("location")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? OutputLocation { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Text { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Context { get; set; }
    [JsonPropertyName("suggested_name")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? SuggestedName { get; set; }
    [JsonPropertyName("suggested_fill_by")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? SuggestedFillBy { get; set; }
    [JsonPropertyName("context_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? StructureContextId { get; set; }
    [JsonPropertyName("table_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? TableId { get; set; }
    [JsonPropertyName("row_number")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? RowNumber { get; set; }
    [JsonPropertyName("column_number")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? ColumnNumber { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? Options { get; set; }

    [JsonIgnore]
    public string? ChapterName { get; set; }

    [JsonIgnore]
    public string? TableTitle { get; set; }

    [JsonIgnore]
    public string? ColumnHeader { get; set; }

    [JsonIgnore]
    public string? GroupTitle { get; set; }

    [JsonIgnore]
    public OpenXmlElement? Target { get; set; }

    /// <summary>跨段勾选项按顺序列出全部选项段落。</summary>
    [JsonIgnore]
    public List<Wp.Paragraph>? TargetGroup { get; set; }

    /// <summary>文本框在 mc:Fallback 中的同文段落，写入时同步占位文字。</summary>
    [JsonIgnore]
    public Wp.Paragraph? FallbackTarget { get; set; }

    [JsonIgnore]
    public int Start { get; set; }

    [JsonIgnore]
    public int Length { get; set; }

    [JsonIgnore]
    public int Order { get; set; }
}

sealed class TemplateChapterRangeFile
{
    public int Version { get; set; } = 1;
    public List<TemplateChapterRange> Chapters { get; set; } = [];
}

sealed class TemplateChapterRange
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Id { get; set; }
    public string Title { get; set; } = "";
    [JsonPropertyName("start_block")]
    public int StartBlock { get; set; }
    [JsonPropertyName("end_block")]
    public int EndBlock { get; set; }
}

sealed class TemplateFieldSelection
{
    [JsonPropertyName("candidate_id")]
    public string CandidateId { get; set; } = "";
    public string Name { get; set; } = "";
    [JsonPropertyName("fill_by")]
    public string FillBy { get; set; } = "";
    public string? Instruction { get; set; }
}

sealed class TemplateFieldDefinitionFile
{
    public int Version { get; set; } = 2;
    public List<TemplateFieldDefinition> Fields { get; set; } = [];
}

/// <summary>最终字段；同一 table_id 下同名不同 row 的字段逐行填写，其余同名字段填同一个值。</summary>
sealed class TemplateFieldDefinition
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    [JsonPropertyName("fill_by")]
    public string FillBy { get; set; } = "";
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Instruction { get; set; }
    public string Kind { get; set; } = TemplateFieldKinds.TextField;
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? Options { get; set; }
    [JsonPropertyName("table_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? TableId { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Row { get; set; }
}

/// <summary>扫描候选类型及其对应的最终字段类型。</summary>
static class TemplateFieldKinds
{
    public const string ExistingControl = "existing-content-control";
    public const string TextPlaceholder = "text-placeholder";
    public const string UnderlinedSpace = "underlined-space";
    public const string HintPlaceholder = "hint-placeholder";
    public const string BlankGap = "blank-gap";
    public const string AfterLabel = "after-label";
    public const string EmptyTableCell = "empty-table-cell";
    public const string CheckboxGroup = "checkbox-group";
    public const string AttachmentSlot = "attachment-slot";
    public const string AttachmentNote = "attachment-note";

    public const string TextField = "text";
    public const string ChoiceField = "choice";
    public const string AttachmentField = "attachment";

    public static string ToFieldKind(string candidateKind) => candidateKind switch
    {
        CheckboxGroup => ChoiceField,
        AttachmentSlot or AttachmentNote => AttachmentField,
        _ => TextField,
    };
}

sealed class ScanTemplateFieldsRequest
{
    public string Action { get; set; } = "";
    public string Input { get; set; } = "";
}

/// <summary>回填一个字段：文字字段给 value，勾选项给 selected，逐行清单表未使用的单元格给 blank。</summary>
sealed class TemplateFieldFillValue
{
    public string Id { get; set; } = "";
    public string? Value { get; set; }
    public List<string>? Selected { get; set; }
    public bool? Blank { get; set; }
}

sealed class FillTemplateFieldsRequest
{
    public string Action { get; set; } = "";
    public string Input { get; set; } = "";
    public string Output { get; set; } = "";
    public List<TemplateFieldFillValue> Values { get; set; } = [];
}

sealed class ApplyTemplateFieldsRequest
{
    public string Action { get; set; } = "";
    public string Input { get; set; } = "";
    public string Output { get; set; } = "";
    [JsonPropertyName("fields_output")]
    public string FieldsOutput { get; set; } = "";
    public List<TemplateFieldSelection> Fields { get; set; } = [];
    [JsonPropertyName("ignored_candidate_ids")]
    public List<string> IgnoredCandidateIds { get; set; } = [];
}
