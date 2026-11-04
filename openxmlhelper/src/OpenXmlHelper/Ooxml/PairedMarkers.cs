using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Ooxml;

/// <summary>
/// R4 成对标记：书签、域、批注不能只剩一半。按整批被删内容判断，须在删除之前调用。
/// - 书签：显式删除任一端时两端都删；删内容时书签保留——行内删除原位留下，块级删除时 start 移到下一个保留段落开头、end 移到上一个保留段落末尾，
///   两端都在被删内容里时一起移到下一个保留段落开头（没有则上一段末尾）；有替换内容时移到替换内容里；找不到可放的段落才整对删除。
/// - 域：只删到一部分 begin/separate/end 时，剩下的部分退化为普通文字：去掉其余域字符和整个指令区，保留结果区。
/// - 批注：删到范围起点、终点或引用中的任意一个，整条批注删除（其余标记、引用、批注条目及扩展部件中的对应项）；条目不可达时只清理标记。
/// </summary>
sealed class PairedMarkers
{
    readonly HashSet<OpenXmlElement> _content;
    readonly IReadOnlyList<OpenXmlElement>? _anchors;
    readonly bool _keepEnclosedBookmarks;
    readonly List<OpenXmlElement> _extra = [];
    readonly HashSet<OpenXmlElement> _extraSet = new(ReferenceEqualityComparer.Instance);
    readonly Dictionary<OpenXmlElement, RootIndex> _roots = new(ReferenceEqualityComparer.Instance);
    readonly Dictionary<Wp.Paragraph, OpenXmlElement> _startCursors = new(ReferenceEqualityComparer.Instance);

    PairedMarkers(IReadOnlyList<OpenXmlElement> content, IReadOnlyList<OpenXmlElement>? anchors, bool keepEnclosedBookmarks)
    {
        _content = new HashSet<OpenXmlElement>(content, ReferenceEqualityComparer.Instance);
        _anchors = anchors;
        _keepEnclosedBookmarks = keepEnclosedBookmarks;
    }

    /// <summary>
    /// 处理 content（将被删除的最上层元素）里的成对标记，返回需要一并删除的元素。anchors 为替换内容，书签移到其中。
    /// keepEnclosedBookmarks 为 false 时两端都在 content 里的书签随内容删除（取子集生成新文档时用）。
    /// </summary>
    public static List<OpenXmlElement> Prepare(IReadOnlyList<OpenXmlElement> content, IReadOnlyList<OpenXmlElement>? anchors, bool keepEnclosedBookmarks = true)
    {
        var markers = new PairedMarkers(content, anchors, keepEnclosedBookmarks);
        markers.Run(content);
        return markers._extra;
    }

    public static bool IsBookmarkMarker(OpenXmlElement element) => element is Wp.BookmarkStart or Wp.BookmarkEnd;

    public static bool IsCommentMarker(OpenXmlElement element) =>
        element is Wp.CommentRangeStart or Wp.CommentRangeEnd or Wp.CommentReference;

    /// <summary>清空段落等容器时保留在原位的零宽标记。</summary>
    public static bool IsZeroWidthMarker(OpenXmlElement element) =>
        element is Wp.BookmarkStart or Wp.BookmarkEnd or Wp.CommentRangeStart or Wp.CommentRangeEnd;

    void Run(IReadOnlyList<OpenXmlElement> content)
    {
        var bookmarks = new List<(OpenXmlElement Owner, OpenXmlElement Marker)>();
        var comments = new List<(OpenXmlElement Root, string Id)>();
        var fieldRoots = new List<OpenXmlElement>();
        foreach (var owner in content)
        {
            var root = DocumentOrder.Root(owner);
            foreach (var element in owner.Descendants().Prepend(owner))
            {
                switch (element)
                {
                    case Wp.BookmarkStart or Wp.BookmarkEnd:
                        bookmarks.Add((owner, element));
                        break;
                    case Wp.CommentRangeStart or Wp.CommentRangeEnd or Wp.CommentReference:
                        if (MarkerId(element) is { Length: > 0 } commentId && !comments.Contains((root, commentId))) comments.Add((root, commentId));
                        break;
                    case Wp.FieldChar:
                        if (!fieldRoots.Contains(root)) fieldRoots.Add(root);
                        break;
                }
            }
        }
        foreach (var group in bookmarks.GroupBy(item => (Root: DocumentOrder.Root(item.Owner), Id: MarkerId(item.Marker))))
        {
            HandleBookmark(group.Key.Root, group.Key.Id, group.ToList());
        }
        foreach (var (root, id) in comments) HandleComment(root, id);
        foreach (var root in fieldRoots) HandleFields(root);
    }

    void HandleBookmark(OpenXmlElement root, string id, List<(OpenXmlElement Owner, OpenXmlElement Marker)> found)
    {
        var index = Index(root);
        var start = index.BookmarkStart(id);
        var end = index.BookmarkEnd(id);
        // 显式删除书签：另一端一起删。
        if (found.Any(item => ReferenceEquals(item.Owner, item.Marker)))
        {
            if (start is not null && !InContent(start)) AddExtra(start);
            if (end is not null && !InContent(end)) AddExtra(end);
            return;
        }
        var startOwner = start is not null ? OwnerOf(start) : null;
        var endOwner = end is not null ? OwnerOf(end) : null;
        if (!_keepEnclosedBookmarks && startOwner is not null && endOwner is not null) return;
        var startBlock = startOwner is not null && WordStructureRules.IsBlockLike(startOwner);
        var endBlock = endOwner is not null && WordStructureRules.IsBlockLike(endOwner);
        if (startOwner is not null && endOwner is not null && startBlock && endBlock)
        {
            if (NextParagraph(startOwner) is { } next)
            {
                InsertAtStart(next, start!);
                InsertAtStart(next, end!);
            }
            else if (PreviousParagraph(endOwner) is { } previous)
            {
                MoveTo(previous, start!);
                MoveTo(previous, end!);
            }
            return;
        }
        if (startOwner is not null)
        {
            if (!startBlock) KeepInPlace(start!, startOwner);
            else if (NextParagraph(startOwner) is { } next) InsertAtStart(next, start!);
            else if (end is not null && endOwner is null) AddExtra(end);
        }
        if (endOwner is not null)
        {
            if (!endBlock) KeepInPlace(end!, endOwner);
            else if (PreviousParagraph(endOwner) is { } previous) MoveTo(previous, end!);
            else if (start is not null && startOwner is null) AddExtra(start);
        }
    }

    void HandleComment(OpenXmlElement root, string id)
    {
        foreach (var marker in Index(root).CommentMarkers(id))
        {
            if (!InContent(marker)) AddExtra(marker);
        }
        if (root is not OpenXmlPartRootElement { OpenXmlPart: { } part } || part.OpenXmlPackage is not WordprocessingDocument document) return;
        if (document.MainDocumentPart is not { } main) return;
        // 其他正文部件里的同一批注标记一并清掉，改动的部件立即保存。
        foreach (var story in StoryRoots(main).Where(story => !ReferenceEquals(story, root)))
        {
            var others = story.Descendants().Where(element => IsCommentMarker(element) && MarkerId(element) == id).ToList();
            if (others.Count == 0) continue;
            foreach (var marker in others) RemoveMarker(marker);
            ((OpenXmlPartRootElement)story).Save();
        }
        RemoveCommentEntry(main, id);
    }

    /// <summary>删除批注条目，以及 commentsExtended、commentsIds、commentsExtensible 中按 paraId / durableId 对应的项。</summary>
    internal static void RemoveCommentEntry(MainDocumentPart main, string id)
    {
        var comments = main.WordprocessingCommentsPart?.Comments;
        var comment = comments?.Elements<Wp.Comment>().FirstOrDefault(item => item.Id?.Value == id);
        if (comments is null || comment is null) return;
        var paraIds = comment.Descendants<Wp.Paragraph>()
            .Select(paragraph => paragraph.ParagraphId?.Value)
            .OfType<string>()
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        comment.Remove();
        comments.Save();
        var durableIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        RemoveEntries(main.WordprocessingCommentsExPart?.RootElement, item => AttributeValue(item, "paraId") is { } paraId && paraIds.Contains(paraId));
        RemoveEntries(main.WordprocessingCommentsIdsPart?.RootElement, item =>
        {
            if (AttributeValue(item, "paraId") is not { } paraId || !paraIds.Contains(paraId)) return false;
            if (AttributeValue(item, "durableId") is { } durableId) durableIds.Add(durableId);
            return true;
        });
        RemoveEntries(main.WordCommentsExtensiblePart?.RootElement, item => AttributeValue(item, "durableId") is { } durableId && durableIds.Contains(durableId));
    }

    static void RemoveEntries(OpenXmlPartRootElement? root, Func<OpenXmlElement, bool> match)
    {
        if (root is null) return;
        var entries = root.ChildElements.Where(match).ToList();
        if (entries.Count == 0) return;
        foreach (var entry in entries) entry.Remove();
        root.Save();
    }

    static string? AttributeValue(OpenXmlElement element, string localName) =>
        element.GetAttributes().FirstOrDefault(attribute => attribute.LocalName == localName).Value;

    /// <summary>可能含批注标记的正文部件根元素：正文、页眉页脚、脚注尾注。</summary>
    internal static IEnumerable<OpenXmlElement> StoryRoots(MainDocumentPart main)
    {
        if (main.Document is { } document) yield return document;
        foreach (var header in main.HeaderParts) if (header.Header is { } root) yield return root;
        foreach (var footer in main.FooterParts) if (footer.Footer is { } root) yield return root;
        if (main.FootnotesPart?.Footnotes is { } footnotes) yield return footnotes;
        if (main.EndnotesPart?.Endnotes is { } endnotes) yield return endnotes;
    }

    sealed class FieldInfo
    {
        public required Wp.FieldChar Begin { get; init; }
        public Wp.FieldChar? Separate { get; set; }
        public Wp.FieldChar? End { get; set; }
    }

    void HandleFields(OpenXmlElement root)
    {
        var stack = new Stack<FieldInfo>();
        var fields = new List<FieldInfo>();
        foreach (var fieldChar in root.Descendants<Wp.FieldChar>())
        {
            var type = fieldChar.FieldCharType?.Value;
            if (type == Wp.FieldCharValues.Begin) stack.Push(new FieldInfo { Begin = fieldChar });
            else if (type == Wp.FieldCharValues.Separate && stack.Count > 0) stack.Peek().Separate ??= fieldChar;
            else if (type == Wp.FieldCharValues.End && stack.Count > 0)
            {
                var field = stack.Pop();
                field.End = fieldChar;
                fields.Add(field);
            }
        }
        fields.AddRange(stack);
        List<Wp.Run>? runs = null;
        Dictionary<OpenXmlElement, int>? runIndex = null;
        foreach (var field in fields)
        {
            var chars = new[] { field.Begin, field.Separate, field.End }.OfType<Wp.FieldChar>().ToList();
            var removed = chars.Count(InContent);
            if (removed == 0 || removed == chars.Count) continue;
            // 退化为普通文字：去掉指令区（begin 与 separate 之间，没有 separate 时到 end）和其余域字符，结果区保留。
            if (field.Begin.Parent is Wp.Run beginRun && (field.Separate ?? field.End)?.Parent is Wp.Run stopRun)
            {
                runs ??= root.Descendants<Wp.Run>().ToList();
                if (runIndex is null)
                {
                    runIndex = new Dictionary<OpenXmlElement, int>(ReferenceEqualityComparer.Instance);
                    for (var position = 0; position < runs.Count; position += 1) runIndex[runs[position]] = position;
                }
                if (runIndex.TryGetValue(beginRun, out var from) && runIndex.TryGetValue(stopRun, out var to))
                {
                    for (var position = from + 1; position < to; position += 1)
                    {
                        if (!InContent(runs[position])) AddExtra(runs[position]);
                    }
                }
                foreach (var code in beginRun.Elements().Concat(stopRun.Elements()).Where(element => element is Wp.FieldCode or Wp.DeletedFieldCode))
                {
                    if (!InContent(code)) AddExtra(code);
                }
            }
            foreach (var fieldChar in chars)
            {
                if (!InContent(fieldChar)) AddExtra(fieldChar);
            }
        }
    }

    /// <summary>被删内容里包含该元素的最上层元素；不在被删内容里时为 null。</summary>
    OpenXmlElement? OwnerOf(OpenXmlElement element)
    {
        for (OpenXmlElement? node = element; node is not null; node = node.Parent)
        {
            if (_content.Contains(node)) return node;
        }
        return null;
    }

    bool InContent(OpenXmlElement element) => OwnerOf(element) is not null;

    void AddExtra(OpenXmlElement element)
    {
        if (_extraSet.Add(element)) _extra.Add(element);
    }

    /// <summary>行内删除：标记留在原位置（被删元素之前）。</summary>
    static void KeepInPlace(OpenXmlElement marker, OpenXmlElement owner)
    {
        marker.Remove();
        owner.InsertBeforeSelf(marker);
    }

    void InsertAtStart(Wp.Paragraph paragraph, OpenXmlElement marker)
    {
        marker.Remove();
        if (_startCursors.TryGetValue(paragraph, out var cursor)) cursor.InsertAfterSelf(marker);
        else if (paragraph.ParagraphProperties is { } properties) properties.InsertAfterSelf(marker);
        else paragraph.PrependChild(marker);
        _startCursors[paragraph] = marker;
    }

    static void MoveTo(Wp.Paragraph paragraph, OpenXmlElement marker)
    {
        marker.Remove();
        paragraph.AppendChild(marker);
    }

    static void RemoveMarker(OpenXmlElement marker)
    {
        var run = marker.Parent as Wp.Run;
        marker.Remove();
        if (run is not null && run.ChildElements.All(child => child is Wp.RunProperties)) run.Remove();
    }

    /// <summary>块级删除时 start 的去处：替换内容里的第一段，否则下一个保留段落。</summary>
    Wp.Paragraph? NextParagraph(OpenXmlElement owner)
    {
        if (_anchors is not null && _anchors.SelectMany(AnchorParagraphs).FirstOrDefault() is { } first) return first;
        var candidates = Index(DocumentOrder.Root(owner)).StoryParagraphs(StoryOf(owner), this);
        var position = Index(DocumentOrder.Root(owner)).Order(owner);
        return candidates.FirstOrDefault(item => item.Order > position).Paragraph;
    }

    /// <summary>块级删除时 end 的去处：替换内容里的最后一段，否则上一个保留段落。</summary>
    Wp.Paragraph? PreviousParagraph(OpenXmlElement owner)
    {
        if (_anchors is not null && _anchors.SelectMany(AnchorParagraphs).LastOrDefault() is { } last) return last;
        var candidates = Index(DocumentOrder.Root(owner)).StoryParagraphs(StoryOf(owner), this);
        var position = Index(DocumentOrder.Root(owner)).Order(owner);
        return candidates.LastOrDefault(item => item.Order < position).Paragraph;
    }

    static IEnumerable<Wp.Paragraph> AnchorParagraphs(OpenXmlElement anchor) =>
        anchor is Wp.Paragraph paragraph ? [paragraph] : anchor.Descendants<Wp.Paragraph>();

    /// <summary>书签只在同一叙述范围内移动：文本框里的内容只移到同一文本框，正文不移进文本框。</summary>
    static OpenXmlElement? StoryOf(OpenXmlElement element) => element.Ancestors<Wp.TextBoxContent>().FirstOrDefault();

    static string MarkerId(OpenXmlElement element) => element switch
    {
        Wp.BookmarkStart start => start.Id?.Value ?? "",
        Wp.BookmarkEnd end => end.Id?.Value ?? "",
        Wp.CommentRangeStart start => start.Id?.Value ?? "",
        Wp.CommentRangeEnd end => end.Id?.Value ?? "",
        Wp.CommentReference reference => reference.Id?.Value ?? "",
        _ => "",
    };

    RootIndex Index(OpenXmlElement root)
    {
        if (!_roots.TryGetValue(root, out var index))
        {
            index = new RootIndex(root);
            _roots[root] = index;
        }
        return index;
    }

    /// <summary>一棵树的标记索引与文档顺序，按需建立，一次操作内复用。</summary>
    sealed class RootIndex(OpenXmlElement root)
    {
        Dictionary<string, Wp.BookmarkStart>? _starts;
        Dictionary<string, Wp.BookmarkEnd>? _ends;
        Dictionary<string, List<OpenXmlElement>>? _comments;
        Dictionary<OpenXmlElement, int>? _order;
        readonly Dictionary<OpenXmlElement, List<(int Order, Wp.Paragraph Paragraph)>> _stories = new(ReferenceEqualityComparer.Instance);
        List<(int Order, Wp.Paragraph Paragraph)>? _bodyStory;

        public Wp.BookmarkStart? BookmarkStart(string id)
        {
            ScanMarkers();
            return _starts!.GetValueOrDefault(id);
        }

        public Wp.BookmarkEnd? BookmarkEnd(string id)
        {
            ScanMarkers();
            return _ends!.GetValueOrDefault(id);
        }

        public IReadOnlyList<OpenXmlElement> CommentMarkers(string id)
        {
            ScanMarkers();
            return _comments!.GetValueOrDefault(id) ?? [];
        }

        public int Order(OpenXmlElement element)
        {
            _order ??= DocumentOrder.Index(root);
            return _order.GetValueOrDefault(element, -1);
        }

        /// <summary>同一叙述范围内、不在被删内容里的段落，按文档顺序排列；不含 mc:Fallback 里的兼容副本。</summary>
        public List<(int Order, Wp.Paragraph Paragraph)> StoryParagraphs(OpenXmlElement? story, PairedMarkers owner)
        {
            if (story is null && _bodyStory is not null) return _bodyStory;
            if (story is not null && _stories.TryGetValue(story, out var cached)) return cached;
            var scope = story ?? root;
            var result = scope.Descendants<Wp.Paragraph>()
                .Where(paragraph => ReferenceEquals(StoryOf(paragraph), story)
                    && !paragraph.Ancestors<AlternateContentFallback>().Any()
                    && !owner.InContent(paragraph))
                .Select(paragraph => (Order(paragraph), paragraph))
                .ToList();
            if (story is null) _bodyStory = result;
            else _stories[story] = result;
            return result;
        }

        void ScanMarkers()
        {
            if (_starts is not null) return;
            _starts = new Dictionary<string, Wp.BookmarkStart>(StringComparer.Ordinal);
            _ends = new Dictionary<string, Wp.BookmarkEnd>(StringComparer.Ordinal);
            _comments = new Dictionary<string, List<OpenXmlElement>>(StringComparer.Ordinal);
            foreach (var element in root.Descendants())
            {
                switch (element)
                {
                    case Wp.BookmarkStart start when start.Id?.Value is { } id:
                        _starts.TryAdd(id, start);
                        break;
                    case Wp.BookmarkEnd end when end.Id?.Value is { } id:
                        _ends.TryAdd(id, end);
                        break;
                    default:
                        if (IsCommentMarker(element) && MarkerId(element) is { Length: > 0 } commentId)
                        {
                            if (!_comments.TryGetValue(commentId, out var list)) _comments[commentId] = list = [];
                            list.Add(element);
                        }
                        break;
                }
            }
        }
    }
}
