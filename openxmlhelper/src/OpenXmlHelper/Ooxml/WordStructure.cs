using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Ooxml;

/// <summary>结构操作的实际效果：删除，或因单元格须以段落结尾而降级为清空。</summary>
enum StructureResult
{
    Removed,
    Cleared,
}

/// <summary>
/// 结构操作层：助手里删除、清空、替换、移动 Open XML 元素的唯一入口（直接调用 SDK 删除 API 会被 BannedSymbols.txt 拦下）。
/// 按 Word 实测的规则表自动处理，规则只作用于本次操作影响到的位置，不修复原件已有的不规范写法：
/// R1 单元格以段落结尾（WordStructureRules）；R2 行有单元格、表格有行；R3 引用指向存在的目标（ReferenceIntegrity）；
/// R4 书签、域、批注不只剩一半（PairedMarkers）。规则细则见 openxmlhelper/开发说明.md「结构规则与结构操作层」。
/// 活文档与脱离文档的克隆树一样适用；改动其他部件（批注条目等）时立即保存该部件，调用方只负责保存自己编辑的部件。
/// </summary>
static class WordStructure
{
    /// <summary>删除元素。是单元格末尾段落时降级为清空（保留段落属性和书签等零宽标记），返回 Cleared。</summary>
    public static StructureResult Remove(OpenXmlElement element) =>
        RemoveCore([element], null).Contains(element) ? StructureResult.Cleared : StructureResult.Removed;

    /// <summary>整批删除，按整批判断成对标记；返回降级为清空的段落。</summary>
    public static IReadOnlyCollection<OpenXmlElement> RemoveRange(IEnumerable<OpenXmlElement> elements) => RemoveCore(elements, null);

    /// <summary>删除 parent 下类型为 T 的直接子元素。</summary>
    public static void RemoveChildren<T>(OpenXmlElement parent) where T : OpenXmlElement =>
        RemoveCore(parent.Elements<T>().ToList(), null);

    /// <summary>把 parent 下类型为 T 的子元素换成 child，按 schema 顺序放置。</summary>
    public static T SetSingleChild<T>(OpenXmlCompositeElement parent, T child) where T : OpenXmlElement
    {
        RemoveChildren<T>(parent);
        parent.AddChild(child, throwOnError: true);
        return child;
    }

    /// <summary>清空容器内容：保留段落、单元格的属性元素和书签、批注范围等零宽标记，其余删除。</summary>
    public static void ClearContent(OpenXmlElement container) => RemoveCore(ClearableChildren(container), null);

    /// <summary>用新内容替换容器内容：新内容放在原内容位置，旧内容里的书签移到新内容里。</summary>
    public static void ReplaceContent(OpenXmlElement container, IEnumerable<OpenXmlElement> newChildren)
    {
        var old = ClearableChildren(container);
        var added = newChildren.ToList();
        var anchor = old.FirstOrDefault();
        foreach (var child in added)
        {
            if (anchor is not null) anchor.InsertBeforeSelf(child);
            else container.AppendChild(child);
        }
        RemoveCore(old, added);
    }

    /// <summary>用 replacement 替换 old：先插入新元素再删除旧元素，旧元素里的书签移到新元素里。返回 old 的处理结果。</summary>
    public static StructureResult Replace(OpenXmlElement old, OpenXmlElement replacement) => Replace(old, [replacement]);

    /// <summary>用多个新元素依次替换 old。</summary>
    public static StructureResult Replace(OpenXmlElement old, IReadOnlyList<OpenXmlElement> replacements)
    {
        foreach (var item in replacements) old.InsertBeforeSelf(item);
        return RemoveCore([old], replacements).Contains(old) ? StructureResult.Cleared : StructureResult.Removed;
    }

    /// <summary>去掉外壳（内容控件、超链接、智能标记、customXml、fldSimple、修订包装等），内容留在原位置。</summary>
    public static void Unwrap(OpenXmlElement wrapper)
    {
        var holder = wrapper is Wp.SdtElement
            ? wrapper.ChildElements.FirstOrDefault(child => child is Wp.SdtContentRun or Wp.SdtContentBlock or Wp.SdtContentCell or Wp.SdtContentRow)
            : wrapper;
        var children = holder?.ChildElements.Where(child => !IsWrapperProperties(child)).ToList() ?? [];
        foreach (var child in children)
        {
            child.Remove();
            wrapper.InsertBeforeSelf(child);
        }
        RemoveCore([wrapper], null);
    }

    /// <summary>从原位置摘下元素（随后插入别处或交给调用方）；原容器按 R1、R2 检查，标记随元素一起走。</summary>
    public static T Detach<T>(T element) where T : OpenXmlElement
    {
        var source = SourceState.Capture(element);
        element.Remove();
        source.Restore();
        return element;
    }

    public static T MoveBefore<T>(T element, OpenXmlElement anchor) where T : OpenXmlElement =>
        Move(element, item => anchor.InsertBeforeSelf(item));

    public static T MoveAfter<T>(T element, OpenXmlElement anchor) where T : OpenXmlElement =>
        Move(element, item => anchor.InsertAfterSelf(item));

    public static T AppendTo<T>(T element, OpenXmlElement parent) where T : OpenXmlElement =>
        Move(element, item => parent.AppendChild(item));

    public static T PrependTo<T>(T element, OpenXmlElement parent) where T : OpenXmlElement =>
        Move(element, item => parent.PrependChild(item));

    /// <summary>显式删除书签（传入任一端），另一端一起删。</summary>
    public static void RemoveBookmarks(IEnumerable<OpenXmlElement> markers) => RemoveCore(markers, null);

    /// <summary>删除 root 下的全部批注标记；root 在文档里时连带批注条目和扩展部件里的对应项。</summary>
    public static void RemoveAllComments(OpenXmlElement root) =>
        RemoveCore(root.Descendants().Where(PairedMarkers.IsCommentMarker).ToList(), null);

    /// <summary>删除文档的全部批注：各正文部件里的标记和引用、批注条目，扩展部件（commentsExtended / Ids / Extensible / people）只保留根元素。</summary>
    public static void RemoveAllComments(MainDocumentPart main)
    {
        // 条目随后整体清空，标记直接摘除即可；批注标记是零宽或位于 run 内，摘除不影响 R1、R2。
        foreach (var story in PairedMarkers.StoryRoots(main).ToList())
        {
            var markers = story.Descendants().Where(PairedMarkers.IsCommentMarker).ToList();
            if (markers.Count == 0) continue;
            RemoveExtra(markers);
            ((OpenXmlPartRootElement)story).Save();
        }
        if (main.WordprocessingCommentsPart?.Comments is { } comments && comments.HasChildren)
        {
            foreach (var comment in comments.Elements<Wp.Comment>().ToList()) comment.Remove();
            comments.Save();
        }
        foreach (var root in new[]
        {
            main.WordprocessingCommentsExPart?.RootElement,
            main.WordprocessingCommentsIdsPart?.RootElement,
            main.WordCommentsExtensiblePart?.RootElement,
            main.WordprocessingPeoplePart?.RootElement,
        })
        {
            if (root is null || !root.HasChildren) continue;
            root.RemoveAllChildren();
            root.Save();
        }
    }

    /// <summary>删除部件：先按 R3 处理指向它的引用。</summary>
    public static void DeletePart(OpenXmlPartContainer container, OpenXmlPart part) => ReferenceIntegrity.DeletePart(container, part);

    /// <summary>删除关系（部件、超链接或外部关系）：先按 R3 处理指向它的引用。</summary>
    public static void DeleteRelationship(OpenXmlPartContainer container, string id) => ReferenceIntegrity.DeleteRelationship(container, id);

    /// <summary>元素是否仍在某个部件的文档树里。</summary>
    public static bool IsAttached(OpenXmlElement element) =>
        DocumentOrder.Root(element) is OpenXmlPartRootElement { OpenXmlPart: not null };

    /// <summary>
    /// 删除的核心流程：规整目标 → R1 决定哪些末尾段落降级为清空 → R4 处理成对标记 → 摘除 → 一并删除标记的另一端等 →
    /// R2 删掉变空的行和表格 → R1 给仍不以段落结尾的单元格补空段。anchors 为替换内容。返回降级为清空的段落。
    /// </summary>
    static HashSet<OpenXmlElement> RemoveCore(IEnumerable<OpenXmlElement> elements, IReadOnlyList<OpenXmlElement>? anchors)
    {
        var targets = Normalize(elements);
        var cleared = new HashSet<OpenXmlElement>(ReferenceEqualityComparer.Instance);
        if (targets.Count == 0) return cleared;
        var targetSet = new HashSet<OpenXmlElement>(targets, ReferenceEqualityComparer.Instance);

        // R1：单元格删除后若不再以段落结尾，保留其中最早一个可保留的段落并清空；没有可保留的段落时删除后补空段。
        var appendSources = new Dictionary<Wp.TableCell, Wp.Paragraph?>(ReferenceEqualityComparer.Instance);
        foreach (var group in targets.Where(WordStructureRules.IsBlock).GroupBy(WordStructureRules.OwningCell))
        {
            if (group.Key is not { } cell || WordStructureRules.EndsWithParagraph(cell, targetSet)) continue;
            var keep = group.OfType<Wp.Paragraph>().FirstOrDefault(paragraph =>
            {
                targetSet.Remove(paragraph);
                var ok = WordStructureRules.EndsWithParagraph(cell, targetSet);
                targetSet.Add(paragraph);
                return ok;
            });
            if (keep is not null)
            {
                cleared.Add(keep);
                targetSet.Remove(keep);
            }
            else
            {
                appendSources[cell] = group.SelectMany(item => item is Wp.Paragraph paragraph ? new[] { paragraph } : item.Descendants<Wp.Paragraph>()).LastOrDefault();
            }
        }

        var content = targets.Where(target => !cleared.Contains(target)).ToList();
        foreach (var paragraph in cleared) content.AddRange(ClearableChildren(paragraph));

        // R2：记下被删单元格所在的行、被删行所在的表格，删除后检查是否变空。
        var rows = content.Where(WordStructureRules.IsCellLevel).Select(item => item.Ancestors<Wp.TableRow>().FirstOrDefault()).OfType<Wp.TableRow>().Distinct().ToList();
        var tables = content.Where(WordStructureRules.IsRowLevel).Select(item => item.Ancestors<Wp.Table>().FirstOrDefault()).OfType<Wp.Table>().Distinct().ToList();

        var extra = PairedMarkers.Prepare(content, anchors);
        foreach (var element in content) element.Remove();
        RemoveExtra(extra);

        var emptied = rows.Where(row => row.Parent is not null && !WordStructureRules.HasCells(row)).Cast<OpenXmlElement>()
            .Concat(tables.Where(table => table.Parent is not null && !WordStructureRules.HasRows(table)))
            .ToList();
        if (emptied.Count > 0) RemoveCore(emptied, null);

        foreach (var (cell, source) in appendSources)
        {
            if (!WordStructureRules.EndsWithParagraph(cell, EmptySet)) cell.AppendChild(WordStructureRules.EmptyParagraph(source));
        }
        return cleared;
    }

    static readonly IReadOnlySet<OpenXmlElement> EmptySet = new HashSet<OpenXmlElement>(ReferenceEqualityComparer.Instance);

    /// <summary>去掉没有父元素的、重复的、以及已被其祖先覆盖的目标。</summary>
    static List<OpenXmlElement> Normalize(IEnumerable<OpenXmlElement> elements)
    {
        var seen = new HashSet<OpenXmlElement>(ReferenceEqualityComparer.Instance);
        var candidates = elements.Where(element => element?.Parent is not null && seen.Add(element)).ToList();
        var set = new HashSet<OpenXmlElement>(candidates, ReferenceEqualityComparer.Instance);
        return candidates.Where(element => !element.Ancestors().Any(set.Contains)).ToList();
    }

    /// <summary>R4 带出的需一并删除的元素（书签另一端、批注其余标记、退化域的标记和指令）；删后留下的空 run 一并去掉。</summary>
    static void RemoveExtra(List<OpenXmlElement> extra)
    {
        foreach (var element in extra)
        {
            if (element.Parent is null) continue;
            var run = element.Parent as Wp.Run;
            element.Remove();
            if (run?.Parent is not null && run.ChildElements.All(child => child is Wp.RunProperties)) run.Remove();
        }
    }

    /// <summary>清空时要删除的子元素：不含段落和单元格的属性元素，也不含书签、批注范围等零宽标记。</summary>
    static List<OpenXmlElement> ClearableChildren(OpenXmlElement container) =>
        container.ChildElements
            .Where(child => child is not (Wp.ParagraphProperties or Wp.TableCellProperties) && !PairedMarkers.IsZeroWidthMarker(child))
            .ToList();

    // SDK 3 没有 smartTag 的强类型类，按元素名识别其属性元素。
    static bool IsWrapperProperties(OpenXmlElement child) =>
        child is Wp.SdtProperties or Wp.SdtEndCharProperties or Wp.CustomXmlProperties or Wp.FieldData || child.LocalName == "smartTagPr";

    static T Move<T>(T element, Action<T> insert) where T : OpenXmlElement
    {
        var source = SourceState.Capture(element);
        if (element.Parent is not null) element.Remove();
        insert(element);
        source.Restore();
        return element;
    }

    /// <summary>移动元素时原容器的状态：插入新位置后再检查原单元格、行、表格，避免先摘下就误补空段。</summary>
    sealed class SourceState
    {
        Wp.TableCell? _cell;
        Wp.Paragraph? _source;
        Wp.TableRow? _row;
        Wp.Table? _table;

        public static SourceState Capture(OpenXmlElement element)
        {
            var state = new SourceState();
            if (element.Parent is null) return state;
            if (WordStructureRules.IsBlock(element))
            {
                state._cell = WordStructureRules.OwningCell(element);
                state._source = element as Wp.Paragraph ?? element.Descendants<Wp.Paragraph>().LastOrDefault();
            }
            if (WordStructureRules.IsCellLevel(element)) state._row = element.Ancestors<Wp.TableRow>().FirstOrDefault();
            if (WordStructureRules.IsRowLevel(element)) state._table = element.Ancestors<Wp.Table>().FirstOrDefault();
            return state;
        }

        public void Restore()
        {
            if (_row is { Parent: not null } row && !WordStructureRules.HasCells(row)) RemoveCore([row], null);
            if (_table is { Parent: not null } table && !WordStructureRules.HasRows(table)) RemoveCore([table], null);
            if (_cell is { Parent: not null } cell && !WordStructureRules.EndsWithParagraph(cell, EmptySet))
            {
                cell.AppendChild(WordStructureRules.EmptyParagraph(_source));
            }
        }
    }
}
