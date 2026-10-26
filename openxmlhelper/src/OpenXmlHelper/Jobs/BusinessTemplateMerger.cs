using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using A = DocumentFormat.OpenXml.Drawing;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>整本导出并入的已填商务模版：模版路径与字段清单中各章节的顶层块范围。</summary>
sealed record BusinessTemplateSource(string Path, IReadOnlyList<TemplateChapterRange> Chapters);

/// <summary>
/// 把已填写商务模版的章节按原样并入整本导出文档。
/// 模版样式以新 ID 复制进来，不映射到导出文档的同名样式，表单的字体、行距和表格保持模版原样；
/// 字段内容控件只保留内容，签章与未填占位由回填阶段决定。
/// </summary>
sealed class BusinessTemplateMerger : IDisposable
{
    const string StyleIdPrefix = "YbTpl";
    const string StyleNamePrefix = "商务模版 ";
    // 格式自检书签按已有书签数量编号；模版书签整体偏移，避免与之重号。
    const int BookmarkIdOffset = 1_000_000;
    // 与一级目录标题核对一致：标题可能与“附件N”分两段，只看章节开头的几段。
    const int TitleCheckParagraphCount = 3;
    const int TitleMatchScore = 60;

    static readonly string[] FirstLineIndentAttributes = ["firstLine", "hanging", "firstLineChars", "hangingChars"];

    readonly WordprocessingDocument _source;
    readonly MainDocumentPart _sourcePart;
    readonly MainDocumentPart _destPart;
    readonly List<OpenXmlElement> _blocks;
    readonly Dictionary<string, TemplateChapterRange> _chapters;
    readonly Wp.SectionProperties? _section;
    readonly A.FontScheme? _fontScheme;
    readonly string _eastAsiaScript;
    readonly CrossDocumentImportContext _context;
    readonly string? _defaultParagraphStyle;
    readonly string? _defaultTableStyle;
    readonly List<string> _fieldIds = [];
    readonly HashSet<string> _fieldIdSet = new(StringComparer.Ordinal);
    readonly List<string> _warnings = [];

    BusinessTemplateMerger(WordprocessingDocument source, BusinessTemplateSource template, MainDocumentPart destPart)
    {
        _source = source;
        _sourcePart = source.MainDocumentPart ?? throw new InvalidOperationException("商务模版缺少正文部件");
        _destPart = destPart;
        var body = _sourcePart.Document?.Body ?? throw new InvalidOperationException("商务模版正文为空");
        _blocks = body.ChildElements.Where(item => item is not Wp.SectionProperties).ToList();
        _section = body.Elements<Wp.SectionProperties>().LastOrDefault();
        _chapters = template.Chapters
            .Where(item => !string.IsNullOrWhiteSpace(item.Id))
            .GroupBy(item => item.Id!, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        _fontScheme = _sourcePart.ThemePart?.Theme?.ThemeElements?.FontScheme;
        _eastAsiaScript = EastAsiaScript(_sourcePart.DocumentSettingsPart?.Settings?.GetFirstChild<Wp.ThemeFontLanguages>()?.EastAsia?.Value);

        var sourceStyles = _sourcePart.StyleDefinitionsPart?.Styles?.Elements<Wp.Style>().ToList() ?? [];
        var styleIds = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var style in sourceStyles)
        {
            var id = style.StyleId?.Value;
            if (!string.IsNullOrWhiteSpace(id)) styleIds[id] = StyleIdPrefix + id;
        }
        _context = new CrossDocumentImportContext(styleIds);
        _defaultParagraphStyle = DefaultStyleId(sourceStyles, Wp.StyleValues.Paragraph);
        _defaultTableStyle = DefaultStyleId(sourceStyles, Wp.StyleValues.Table);
        ImportStyles(sourceStyles);
    }

    /// <summary>只读打开模版并把全部样式复制进导出文档；整次导出共用一份编号与关系迁移记录。</summary>
    public static BusinessTemplateMerger Open(BusinessTemplateSource template, MainDocumentPart destPart)
    {
        var source = WordprocessingDocument.Open(template.Path, false);
        try
        {
            return new BusinessTemplateMerger(source, template, destPart);
        }
        catch
        {
            source.Dispose();
            throw;
        }
    }

    /// <summary>已并入章节中出现的字段 ID，按文档顺序去重。</summary>
    public IReadOnlyList<string> FieldIds => _fieldIds;

    /// <summary>并入时去掉的、无法迁移的内容说明。</summary>
    public IReadOnlyList<string> Warnings => _warnings;

    /// <summary>
    /// 复制一章的正文块。章节紧跟分节符或父目录标题时去掉开头的分页，避免空白页和孤立标题页；
    /// 与目录标题匹配的段落写入大纲级别，供导航窗格和 Word 自动目录使用。
    /// </summary>
    public IReadOnlyList<OpenXmlElement> ImportChapter(string chapterId, string title, int level, bool stripLeadingPageBreak)
    {
        if (!_chapters.TryGetValue(chapterId, out var chapter))
        {
            throw new InvalidOperationException($"商务模版中没有“{title}”对应的章节，请重新生成目录");
        }
        if (chapter.StartBlock < 0 || chapter.EndBlock > _blocks.Count || chapter.StartBlock >= chapter.EndBlock)
        {
            throw new InvalidOperationException("商务模版与字段清单不一致，请重新生成目录");
        }

        var container = new Wp.Body(_blocks
            .Skip(chapter.StartBlock)
            .Take(chapter.EndBlock - chapter.StartBlock)
            .Select(block => block.CloneNode(true)));
        UnwrapFieldControls(container);
        RemoveUnsupported(container, title);
        ResolveThemeFonts(container);
        ApplyDefaultStyles(container);
        CrossDocumentImport.NormalizeStyleReferences(container, _context.StyleIds);
        CrossDocumentImport.RemapNumbering(container, _sourcePart, _destPart, _context);
        CrossDocumentImport.RemapRelationships(container, _sourcePart, _destPart, _context.RelationshipIds);
        OffsetBookmarks(container);
        if (stripLeadingPageBreak) StripLeadingPageBreak(container);
        MarkOutlineLevel(container, title, level);

        var blocks = container.ChildElements.ToList();
        foreach (var block in blocks) block.Remove();
        return blocks;
    }

    /// <summary>
    /// 模版部分使用模版自己的纸张、方向、页边距和字符网格，不分栏。
    /// 有页眉页脚装饰时，上下边距取两者较大值、页眉页脚距离沿用装饰布局，避免与装饰重叠。
    /// </summary>
    public void ApplyPageSettings(Wp.SectionProperties section, bool keepChromeMargins)
    {
        section.RemoveAllChildren<Wp.Columns>();
        if (_section is null) return;
        if (_section.GetFirstChild<Wp.PageSize>() is { } size)
        {
            section.RemoveAllChildren<Wp.PageSize>();
            section.AddChild(size.CloneNode(true), true);
        }
        if (_section.GetFirstChild<Wp.PageMargin>() is { } margin)
        {
            var copy = (Wp.PageMargin)margin.CloneNode(true);
            if (keepChromeMargins && section.GetFirstChild<Wp.PageMargin>() is { } current)
            {
                copy.Top = Math.Max(copy.Top?.Value ?? 0, current.Top?.Value ?? 0);
                copy.Bottom = Math.Max(copy.Bottom?.Value ?? 0, current.Bottom?.Value ?? 0);
                if (current.Header is not null) copy.Header = current.Header.Value;
                if (current.Footer is not null) copy.Footer = current.Footer.Value;
            }
            section.RemoveAllChildren<Wp.PageMargin>();
            section.AddChild(copy, true);
        }
        section.RemoveAllChildren<Wp.DocGrid>();
        if (_section.GetFirstChild<Wp.DocGrid>() is { } grid) section.AddChild(grid.CloneNode(true), true);
    }

    public void Dispose() => _source.Dispose();

    void ImportStyles(IReadOnlyList<Wp.Style> sourceStyles)
    {
        var destStyles = _destPart.StyleDefinitionsPart?.Styles ?? throw new InvalidOperationException("导出文档缺少样式部件");
        var defaults = _sourcePart.StyleDefinitionsPart?.Styles?.DocDefaults;
        var runDefaults = defaults?.RunPropertiesDefault?.RunPropertiesBaseStyle?.CloneNode(true);
        var paragraphDefaults = defaults?.ParagraphPropertiesDefault?.ParagraphPropertiesBaseStyle?.CloneNode(true);
        if (runDefaults is not null) ResolveThemeFonts(runDefaults);

        foreach (var style in sourceStyles)
        {
            var id = style.StyleId?.Value;
            if (string.IsNullOrWhiteSpace(id)) continue;
            var copy = (Wp.Style)style.CloneNode(true);
            copy.StyleId = _context.StyleIds[id];
            copy.Default = null;
            copy.StyleName = new Wp.StyleName { Val = StyleNamePrefix + (style.StyleName?.Val?.Value ?? id) };
            // 复制来的样式不进快速样式库，避免导出文档的样式列表被模版样式挤满。
            copy.PrimaryStyle = null;
            RemapStyleLink(copy.BasedOn, value => copy.BasedOn!.Val = value, () => copy.BasedOn = null);
            RemapStyleLink(copy.NextParagraphStyle, value => copy.NextParagraphStyle!.Val = value, () => copy.NextParagraphStyle = null);
            RemapStyleLink(copy.LinkedStyle, value => copy.LinkedStyle!.Val = value, () => copy.LinkedStyle = null);
            CrossDocumentImport.NormalizeStyleReferences(copy, _context.StyleIds);
            CrossDocumentImport.RemapNumbering(copy, _sourcePart, _destPart, _context);
            ResolveThemeFonts(copy);
            // docDefaults 只并进根段落样式；字符样式叠加在段落样式之上，并入会盖掉段落样式的属性。
            if (copy.BasedOn is null && copy.Type?.Value == Wp.StyleValues.Paragraph)
            {
                if (runDefaults is not null) MergeProperties(copy.StyleRunProperties ??= new Wp.StyleRunProperties(), runDefaults);
                if (paragraphDefaults is not null) MergeProperties(copy.StyleParagraphProperties ??= new Wp.StyleParagraphProperties(), paragraphDefaults);
            }
            destStyles.AppendChild(copy);
        }
        destStyles.Save();
    }

    void RemapStyleLink(Wp.String253Type? link, Action<string> apply, Action remove)
    {
        if (link is null) return;
        CrossDocumentImport.ApplyStyleMap(link.Val?.Value, _context.StyleIds, apply, remove);
    }

    /// <summary>样式缺少的属性取 docDefaults；两边都有的字体、语言、间距和缩进按属性逐个补齐。</summary>
    static void MergeProperties(OpenXmlCompositeElement target, OpenXmlElement defaults)
    {
        foreach (var child in defaults.ChildElements)
        {
            var existing = target.ChildElements.FirstOrDefault(item => item.GetType() == child.GetType());
            if (existing is null)
            {
                target.AddChild(child.CloneNode(true), false);
                continue;
            }
            if (child is not (Wp.RunFonts or Wp.Languages or Wp.SpacingBetweenLines or Wp.Indentation)) continue;
            var skipFirstLine = child is Wp.Indentation
                && existing.GetAttributes().Any(attribute => FirstLineIndentAttributes.Contains(attribute.LocalName));
            foreach (var attribute in child.GetAttributes())
            {
                if (skipFirstLine && FirstLineIndentAttributes.Contains(attribute.LocalName)) continue;
                if (existing.GetAttributes().Any(item => item.LocalName == attribute.LocalName && item.NamespaceUri == attribute.NamespaceUri)) continue;
                existing.SetAttribute(attribute);
            }
        }
    }

    /// <summary>字段内容控件只保留内容，并记录字段 ID；其他来源的内容控件保持原样。</summary>
    void UnwrapFieldControls(Wp.Body container)
    {
        // 倒序先处理内层控件，外层去壳时内容已是普通元素。
        var controls = container.Descendants<Wp.SdtElement>().ToList();
        controls.Reverse();
        var fieldIds = new List<string>();
        foreach (var control in controls)
        {
            var tag = control.SdtProperties?.GetFirstChild<Wp.Tag>()?.Val?.Value;
            if (tag is null || !tag.StartsWith(TemplateFieldSdtWriter.TagPrefix, StringComparison.Ordinal)) continue;
            fieldIds.Add(tag[TemplateFieldSdtWriter.TagPrefix.Length..]);
            var content = control.ChildElements.FirstOrDefault(item => item is Wp.SdtContentRun or Wp.SdtContentBlock or Wp.SdtContentCell or Wp.SdtContentRow);
            foreach (var child in content?.ChildElements.ToList() ?? [])
            {
                child.Remove();
                control.InsertBeforeSelf(child);
            }
            control.Remove();
        }
        fieldIds.Reverse();
        foreach (var id in fieldIds)
        {
            if (_fieldIdSet.Add(id)) _fieldIds.Add(id);
        }
    }

    /// <summary>批注不随模版导出；脚注尾注暂不迁移，去掉引用并提示。分节由导出统一安排。</summary>
    void RemoveUnsupported(Wp.Body container, string title)
    {
        foreach (var element in container.Descendants().Where(item => item is Wp.CommentRangeStart or Wp.CommentRangeEnd or Wp.CommentReference).ToList())
        {
            element.Remove();
        }
        var notes = container.Descendants().Where(item => item is Wp.FootnoteReference or Wp.EndnoteReference).ToList();
        foreach (var note in notes) note.Remove();
        if (notes.Count > 0) _warnings.Add($"商务模版“{title}”中的 {notes.Count} 处脚注或尾注未导出，请在 Word 中补充");
        foreach (var section in container.Descendants<Wp.SectionProperties>().ToList()) section.Remove();
    }

    /// <summary>主题字体换成模版主题中的具体字体，导出文档没有模版的主题部件。</summary>
    void ResolveThemeFonts(OpenXmlElement root)
    {
        if (_fontScheme is null) return;
        foreach (var fonts in root.Descendants<Wp.RunFonts>())
        {
            if (ThemeFont(fonts.AsciiTheme?.InnerText) is { Length: > 0 } ascii)
            {
                fonts.Ascii = ascii;
                fonts.AsciiTheme = null;
            }
            if (ThemeFont(fonts.HighAnsiTheme?.InnerText) is { Length: > 0 } highAnsi)
            {
                fonts.HighAnsi = highAnsi;
                fonts.HighAnsiTheme = null;
            }
            if (ThemeFont(fonts.EastAsiaTheme?.InnerText) is { Length: > 0 } eastAsia)
            {
                fonts.EastAsia = eastAsia;
                fonts.EastAsiaTheme = null;
            }
            if (ThemeFont(fonts.ComplexScriptTheme?.InnerText) is { Length: > 0 } complexScript)
            {
                fonts.ComplexScript = complexScript;
                fonts.ComplexScriptTheme = null;
            }
        }
    }

    string? ThemeFont(string? value)
    {
        if (_fontScheme is null || string.IsNullOrEmpty(value)) return null;
        A.FontCollectionType? fonts = value.StartsWith("major", StringComparison.Ordinal) ? _fontScheme.MajorFont : _fontScheme.MinorFont;
        if (fonts is null) return null;
        if (value.EndsWith("EastAsia", StringComparison.Ordinal))
        {
            var eastAsian = fonts.EastAsianFont?.Typeface?.Value;
            return string.IsNullOrEmpty(eastAsian)
                ? fonts.Elements<A.SupplementalFont>().FirstOrDefault(item => item.Script?.Value == _eastAsiaScript)?.Typeface?.Value
                : eastAsian;
        }
        return value.EndsWith("Bidi", StringComparison.Ordinal)
            ? fonts.ComplexScriptFont?.Typeface?.Value
            : fonts.LatinFont?.Typeface?.Value;
    }

    static string EastAsiaScript(string? language)
    {
        var value = (language ?? "").ToLowerInvariant();
        if (value.StartsWith("ja", StringComparison.Ordinal)) return "Jpan";
        if (value.StartsWith("ko", StringComparison.Ordinal)) return "Hang";
        return value is "zh-tw" or "zh-hk" or "zh-mo" ? "Hant" : "Hans";
    }

    /// <summary>未指定或指向不存在样式的段落、表格，在模版中使用默认样式；导出文档里显式写出改名后的默认样式。</summary>
    void ApplyDefaultStyles(Wp.Body container)
    {
        if (_defaultParagraphStyle is not null)
        {
            foreach (var paragraph in container.Descendants<Wp.Paragraph>())
            {
                var styleId = paragraph.ParagraphProperties?.ParagraphStyleId?.Val?.Value;
                if (styleId is not null && _context.StyleIds.ContainsKey(styleId)) continue;
                (paragraph.ParagraphProperties ??= new Wp.ParagraphProperties()).ParagraphStyleId = new Wp.ParagraphStyleId { Val = _defaultParagraphStyle };
            }
        }
        if (_defaultTableStyle is not null)
        {
            foreach (var table in container.Descendants<Wp.Table>())
            {
                var properties = table.GetFirstChild<Wp.TableProperties>() ?? table.PrependChild(new Wp.TableProperties());
                var styleId = properties.TableStyle?.Val?.Value;
                if (styleId is not null && _context.StyleIds.ContainsKey(styleId)) continue;
                properties.TableStyle = new Wp.TableStyle { Val = _defaultTableStyle };
            }
        }
    }

    static string? DefaultStyleId(IEnumerable<Wp.Style> styles, Wp.StyleValues type)
    {
        return styles.FirstOrDefault(style => style.Type?.Value == type && style.Default?.Value == true)?.StyleId?.Value;
    }

    static void OffsetBookmarks(Wp.Body container)
    {
        foreach (var start in container.Descendants<Wp.BookmarkStart>())
        {
            if (int.TryParse(start.Id?.Value, out var id)) start.Id = (id + BookmarkIdOffset).ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
        foreach (var end in container.Descendants<Wp.BookmarkEnd>())
        {
            if (int.TryParse(end.Id?.Value, out var id)) end.Id = (id + BookmarkIdOffset).ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
    }

    /// <summary>
    /// 去掉章节开头空段落和首个文字段落中、正文之前的分页；只承载分页的空段落一并删除。
    /// 段前分页可能来自段落样式，删除直接属性关不掉，因此显式写入不分页。正文页单章预览同样使用。
    /// </summary>
    internal static void StripLeadingPageBreak(Wp.Body container)
    {
        foreach (var block in container.ChildElements.ToList())
        {
            if (block is not Wp.Paragraph paragraph) return;
            (paragraph.ParagraphProperties ??= new Wp.ParagraphProperties()).PageBreakBefore = new Wp.PageBreakBefore { Val = false };
            var removed = false;
            foreach (var element in paragraph.Descendants().ToList())
            {
                if (element is Wp.Text { Text.Length: > 0 } or Wp.Drawing or Wp.Picture or Wp.EmbeddedObject or Wp.TabChar) break;
                if (element is Wp.Break pageBreak && pageBreak.Type?.Value == Wp.BreakValues.Page)
                {
                    pageBreak.Remove();
                    removed = true;
                }
            }
            if (paragraph.InnerText.Trim().Length > 0 || paragraph.Descendants<Wp.Drawing>().Any()) return;
            if (removed) paragraph.Remove();
        }
    }

    /// <summary>在章节开头几段中找与目录标题最接近的段落写入大纲级别，找不到时用第一个非空段落。</summary>
    static void MarkOutlineLevel(Wp.Body container, string title, int level)
    {
        var candidates = container.Elements<Wp.Paragraph>()
            .Where(paragraph => WordWorkspace.Normalize(paragraph.InnerText ?? "").Length > 0)
            .Take(TitleCheckParagraphCount)
            .ToList();
        if (candidates.Count == 0) return;
        var target = candidates
            .Select((paragraph, index) => (Paragraph: paragraph, Index: index, Score: ExtractChaptersAction.ScoreTitle(title, WordWorkspace.CreateBlock(paragraph, "", "", index))))
            .Where(item => item.Score >= TitleMatchScore)
            .OrderByDescending(item => item.Score)
            .ThenBy(item => item.Index)
            .Select(item => item.Paragraph)
            .FirstOrDefault() ?? candidates[0];
        (target.ParagraphProperties ??= new Wp.ParagraphProperties()).OutlineLevel = new Wp.OutlineLevel { Val = Math.Clamp(level, 1, 9) - 1 };
    }
}
