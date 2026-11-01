using System.Text;
using System.Text.Json;
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
    /// <summary>扫描遍历到的全部段落，供生成模版正文和解析 Agent 补充的位置，不写入候选文件。</summary>
    [JsonIgnore]
    public List<TemplateParagraphEntry> Paragraphs { get; set; } = [];
    /// <summary>扫描所用的章节范围（与候选、段落的 Chapter 为同一批对象），按章节顺序。</summary>
    [JsonIgnore]
    public List<TemplateChapterRange> Chapters { get; set; } = [];
}

/// <summary>扫描遍历到的一个段落；定位号由内部位置路径压缩而来，同一份源模版每次扫描都相同。</summary>
sealed class TemplateParagraphEntry
{
    public string Locator { get; set; } = "";
    public string Location { get; set; } = "";
    public Wp.Paragraph Paragraph { get; set; } = null!;
    /// <summary>可写段落为段内纯文字（与候选偏移同一口径），不可写段落为规范化后的显示文字。</summary>
    public string Text { get; set; } = "";
    /// <summary>可写段落中换行和分页的文字偏移（不占字符），模版正文中显示为“⏎”。</summary>
    public List<int> BreakOffsets { get; set; } = [];
    /// <summary>纯文字段落且没有已有控件、不是勾选项，补充位置只能落在可写段落上。</summary>
    public bool Writable { get; set; }
    public Wp.Paragraph? Fallback { get; set; }
    public bool InTextBox { get; set; }
    /// <summary>登记时已生成的候选数，与候选的 Order 同一口径，用于在正文中排列无法落到段落上的候选。</summary>
    public int OrderKey { get; set; }
    public TemplateChapterRange? Chapter { get; set; }
    public string? ChapterName { get; set; }
    public string? TableTitle { get; set; }
    public string? ColumnHeader { get; set; }
    public string? GroupTitle { get; set; }
    public string? TableId { get; set; }
    public int? RowNumber { get; set; }
    public int? ColumnNumber { get; set; }
    /// <summary>表格单元格的同行内容，与该格候选的上下文一致。</summary>
    public string? CellContext { get; set; }
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

    /// <summary>候选所在章节；写入字段时据此判断是否自动填写。</summary>
    [JsonIgnore]
    public TemplateChapterRange? Chapter { get; set; }

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

    /// <summary>表格位置：Target 为本章标题段时在其后插入，否则整段替换 Target。</summary>
    [JsonIgnore]
    public bool InsertAfter { get; set; }

    /// <summary>由 Agent 补充的位置解析而来，id 即补充位置的 id。</summary>
    [JsonIgnore]
    public bool FromPosition { get; set; }

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
    /// <summary>章节字段是否自动填写；目录处理方式不是“模板填写”时为 false。</summary>
    [JsonPropertyName("auto_fill")]
    public bool AutoFill { get; set; } = true;
    /// <summary>规则和页码章节：逐行表格和表格位置由规则和页码 Agent 编制（fill_by=rule）。</summary>
    [JsonPropertyName("rule_page")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? RulePage { get; set; }
    /// <summary>
    /// 章节标题段：true 表示标题段带标题书签（见 TemplateHeadings），false 表示本章没有标题段、导出时按目录标题插入一段；
    /// 老模版没有该项，导出时按目录标题在章节开头查找。
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Heading { get; set; }
    [JsonPropertyName("start_block")]
    public int StartBlock { get; set; }
    [JsonPropertyName("end_block")]
    public int EndBlock { get; set; }
}

/// <summary>读取抽章时与源模版一同写出的章节范围边车文件。</summary>
static class TemplateChapterRanges
{
    public static List<TemplateChapterRange> Read(string inputPath)
    {
        var chapterPath = Path.ChangeExtension(inputPath, ".chapters.json");
        if (!File.Exists(chapterPath))
        {
            throw new InvalidOperationException("投标模版章节范围文件不存在，请重新抽取章节");
        }
        var payload = JsonSerializer.Deserialize<TemplateChapterRangeFile>(
            File.ReadAllText(chapterPath, Encoding.UTF8),
            JsonOptions.File);
        if (payload is null || payload.Version != 1 || payload.Chapters is not { Count: > 0 })
        {
            throw new InvalidOperationException("投标模版章节范围文件无效");
        }
        return payload.Chapters;
    }
}

sealed class TemplateFieldSelection
{
    [JsonPropertyName("candidate_id")]
    public string CandidateId { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>字段描述的对象（单位、人员、项目、文件等）的完整称谓。</summary>
    public string Subject { get; set; } = "";
    [JsonPropertyName("fill_by")]
    public string FillBy { get; set; } = "";
    public string? Instruction { get; set; }
    /// <summary>附件拆分为多个连续位置时的各部分，每部分生成一个字段。</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<TemplateFieldPart>? Parts { get; set; }
}

sealed class TemplateFieldPart
{
    public string Name { get; set; } = "";
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Instruction { get; set; }
}

sealed class TemplateFieldDefinitionFile
{
    public int Version { get; set; } = 2;
    /// <summary>最终模版的章节范围，块号为正文顶层块序号，供确认弹窗按章节展示版式。</summary>
    public List<TemplateChapterRange> Chapters { get; set; } = [];
    public List<TemplateFieldDefinition> Fields { get; set; } = [];
}

/// <summary>最终字段；同一 table_id 下同名不同 row 的字段逐行填写，其余同名字段填同一个值。</summary>
sealed class TemplateFieldDefinition
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Subject { get; set; } = "";
    /// <summary>字段所在章节与表格标题，供填写和确认时判断位置。</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Section { get; set; }
    [JsonPropertyName("fill_by")]
    public string FillBy { get; set; } = "";
    /// <summary>签字、签章、手印、盖章位置，只能线下处理。</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Signature { get; set; }
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
    /// <summary>字段在模版中的原句，【▢】标出填写处，供填写时让取值能直接放进原句。</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Context { get; set; }
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
    /// <summary>Agent 用 op=table 指定的新建表格位置（规则和页码章节没有表格时）。</summary>
    public const string TableSlot = "table-slot";
    /// <summary>Agent 确定导出时去掉的原文（removals），不是字段。</summary>
    public const string FormatText = "format-text";
    /// <summary>Agent 补充的插入点（空位缺失处）。</summary>
    public const string InsertedBlank = "inserted-blank";
    /// <summary>Agent 补充的一段原文（示例文字、填写说明、普通空白），作为字段时替换为填写值。</summary>
    public const string TextSpan = "text-span";
    /// <summary>Agent 补充的择一位置（choose），保留原文，填写时换成选中项。</summary>
    public const string Alternatives = "alternatives";

    public const string TextField = "text";
    public const string ChoiceField = "choice";
    public const string SelectField = "select";
    public const string AttachmentField = "attachment";
    public const string TableField = "table";

    /// <summary>规则和页码 Agent 编制的字段：规则表的数据行单元格和表格位置。</summary>
    public const string RuleFillBy = "rule";

    public static string ToFieldKind(string candidateKind) => candidateKind switch
    {
        CheckboxGroup => ChoiceField,
        Alternatives => SelectField,
        AttachmentSlot or AttachmentNote => AttachmentField,
        TableSlot => TableField,
        _ => TextField,
    };
}

sealed class ScanTemplateFieldsRequest
{
    public string Action { get; set; } = "";
    public string Input { get; set; } = "";
}

/// <summary>回填一个字段：文字字段给 value，勾选项给 selected，择一给 option，附件给 image（工作区相对路径），逐行清单表未使用的单元格给 blank。</summary>
sealed class TemplateFieldFillValue
{
    public string Id { get; set; } = "";
    public string? Value { get; set; }
    public List<string>? Selected { get; set; }
    public string? Option { get; set; }
    public string? Image { get; set; }
    public bool? Blank { get; set; }
}

sealed class FillTemplateFieldsRequest
{
    public string Action { get; set; } = "";
    public string Input { get; set; } = "";
    public string Output { get; set; } = "";
    public List<TemplateFieldFillValue> Values { get; set; } = [];
    /// <summary>规则和页码的编制结果，在 values 之后写入。</summary>
    [JsonPropertyName("rule_tables")]
    public List<RuleTableFill> RuleTables { get; set; } = [];
    /// <summary>整本导出时清单表未使用行的字段 ID：整行字段都在其中时删除该行（见 ListRowRemover）。</summary>
    [JsonPropertyName("remove_row_field_ids")]
    public List<string> RemoveRowFieldIds { get; set; } = [];
}

/// <summary>
/// 一张规则表，三种形态：清单表给出规则字段 field_ids 和 rows（from / like，按网格列写格子）；
/// 重建给出 field_ids、rebuild=true、columns 和 rows，程序以新表替换原表；表格位置给出 slot、columns 和 rows，新表放在该位置。
/// </summary>
sealed class RuleTableFill
{
    [JsonPropertyName("field_ids")]
    public List<string>? FieldIds { get; set; }
    public string? Slot { get; set; }
    public bool Rebuild { get; set; }
    public List<string> Columns { get; set; } = [];
    public List<RuleTableRow> Rows { get; set; } = [];
}

/// <summary>
/// 规则表的一行结果。清单表：from 为原地填写表格第几行（全部行从 1 起，只替换该行规则格），like 为照第几行新增一行，cells 按网格列给出格子文字。
/// 新建或重建的表：values 按 columns 顺序给出各格文字，group 为整行合并的分组行。
/// </summary>
sealed class RuleTableRow
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? From { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Like { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Group { get; set; }
    public List<string> Values { get; set; } = [];
    public List<RuleTableCell> Cells { get; set; } = [];
}

/// <summary>清单表一行中的一格：column 为起始网格列（0 起，与模版版式的 column 一致）。</summary>
sealed class RuleTableCell
{
    public int Column { get; set; }
    public string Value { get; set; } = "";
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
    /// <summary>Agent 通读模版正文后补充的位置，id 与候选 id 一样用于 fields。</summary>
    public List<TemplatePosition> Positions { get; set; } = [];
    /// <summary>Agent 确定导出时去掉的原文；未列入的一律保留。</summary>
    public List<TemplateRemoval> Removals { get; set; } = [];
    /// <summary>Agent 指定的章节标题段；未列出的章节由程序按目录标题认定。</summary>
    public List<TemplateHeading> Headings { get; set; } = [];
}

/// <summary>导出时去掉的一段原文：at 为段落定位号，text 为段内原文，before/after 在段内不唯一时区分。</summary>
sealed class TemplateRemoval
{
    public string At { get; set; } = "";
    public string Text { get; set; } = "";
    public string? Before { get; set; }
    public string? After { get; set; }
}

/// <summary>章节标题段：at 为该章顶层段落的定位号，null 表示本章没有标题段、导出时按目录标题插入。</summary>
sealed class TemplateHeading
{
    [JsonPropertyName("chapter_id")]
    public string ChapterId { get; set; } = "";
    public string? At { get; set; }
}

/// <summary>Agent 补充的位置：at 为模版正文中的段落定位号，按 op 用 before/after/text 在段内唯一定位。</summary>
sealed class TemplatePosition
{
    public string Id { get; set; } = "";
    public string At { get; set; } = "";
    public string Op { get; set; } = "";
    public string? Before { get; set; }
    public string? After { get; set; }
    public string? Text { get; set; }
    public List<string>? Options { get; set; }
}
