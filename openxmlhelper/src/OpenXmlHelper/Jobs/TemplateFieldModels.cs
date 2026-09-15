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
    [JsonPropertyName("row_number")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? RowNumber { get; set; }
    [JsonPropertyName("column_number")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? ColumnNumber { get; set; }

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
    public int Version { get; set; } = 1;
    public List<TemplateFieldDefinition> Fields { get; set; } = [];
}

sealed class TemplateFieldDefinition
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    [JsonPropertyName("fill_by")]
    public string FillBy { get; set; } = "";
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Instruction { get; set; }
}

sealed class ScanTemplateFieldsRequest
{
    public string Action { get; set; } = "";
    public string Input { get; set; } = "";
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
