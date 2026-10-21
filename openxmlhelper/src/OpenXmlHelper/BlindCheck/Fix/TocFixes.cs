using System.Xml.Linq;
using Yibiao.OpenXmlHelper.BlindCheck.Model;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Fix;

/// <summary>
/// 删除目录（预设为"不得有目录"时）。只删有明确标记的目录：目录域（连同 Word 自动目录外面的内容控件）、
/// 域外按目录样式认出的目录（与检查同一标准）、以"××目录"标题开头且每行都与后文段落相同的手工目录，以及紧挨着的目录标题；
/// 只按点导引和页码形状认出、没有目录标题的手工目录可能误伤正文，留给人工。
/// 删除后整理接缝：前后内容之间只保留一处换页，空出来的节并入相邻的节，避免多出空白页。
/// </summary>
static class TocFixes
{
    static readonly XName PageBreakBefore = W.Ns + "pageBreakBefore";
    static readonly XName DocPartGallery = W.Ns + "docPartGallery";
    static readonly XName SdtPr = W.Ns + "sdtPr";
    static readonly XName PPrChange = W.Ns + "pPrChange";
    static readonly XName BookmarkStart = W.Ns + "bookmarkStart";
    static readonly XName BookmarkEnd = W.Ns + "bookmarkEnd";

    /// <summary>
    /// 一处目录删除后的接缝：目录前面最近的内容块（没有时为文档开头）、原来前后内容之间是否换页，
    /// 以及原来和目录同页的空段落（目录删掉后会挪到封面末尾或正文开头，变成多余的空行）。
    /// </summary>
    sealed record Seam(XElement? Before, bool NeedsBreak, List<XElement> Strays);

    public static int Fix(FixContext fix)
    {
        var model = fix.Model;
        if (fix.Rules.Profile.Text("structure.check_toc_present", "hint") != "forbid") return 0;
        var toc = fix.Rules.Outline.Toc;
        var body = model.BodyElement;
        var blocks = Blocks(body);
        var position = new Dictionary<XElement, int>(ReferenceEqualityComparer.Instance);
        for (var index = 0; index < blocks.Count; index += 1) position[blocks[index]] = index;

        var fields = FieldEditor.Collect(body).Where(field => field.Kind == "toc").ToList();
        var spanned = new HashSet<XElement>(ReferenceEqualityComparer.Instance);
        foreach (var field in fields)
        {
            var first = TopIndex(field.Simple ?? field.Markers[0], position);
            var last = TopIndex(field.Simple ?? field.Markers[^1], position);
            if (first is null || last is null) continue;
            for (var index = first.Value; index <= last.Value; index += 1)
            {
                if (blocks[index].Name == W.P) spanned.Add(blocks[index]);
            }
        }

        // 整段清掉的段落：域外的目录样式条目、目录标题、手工目录的各行。
        var removed = new HashSet<XElement>(toc.Styled.Where(item => position.ContainsKey(item) && !spanned.Contains(item)), ReferenceEqualityComparer.Instance);
        var ranges = new List<(int From, int End)>();
        foreach (var (start, end) in Regions(blocks, block => spanned.Contains(block) || removed.Contains(block)))
        {
            var from = start;
            if (FindTitle(model, blocks, start) is { } title)
            {
                removed.Add(title);
                from = position[title];
            }

            ranges.Add((from, end));
        }

        foreach (var (title, lines) in ManualTocs(model, toc, blocks, block => spanned.Contains(block) || removed.Contains(block)))
        {
            removed.Add(title);
            removed.UnionWith(lines);
            ranges.Add((position[title], position[lines[^1]]));
        }

        if (toc.Paragraphs.Any(item => position.ContainsKey(item) && !spanned.Contains(item) && !removed.Contains(item) && DocumentModel.ParagraphText(item).Trim().Length > 0))
        {
            fix.Note("没有目录标题的手工目录（按点导引和页码，或与后文标题重复的编号行识别）没有自动删除，请人工确认后删除");
        }

        if (fields.Count == 0 && ranges.Count == 0) return 0;

        // 只靠目录认定的标题（没有标题样式或大纲级别）：把目录里的级别写成段落的大纲级别。打印看不出变化，
        // 删掉目录后标题结构不变，复查不会把它们当成正文。
        var outline = fix.Rules.Outline;
        foreach (var (paragraph, source) in outline.Sources)
        {
            if (source != "toc" || removed.Contains(paragraph) || !model.Records.TryGetValue(paragraph, out var record) || record.Format.HeadingLevel is not null) continue;
            if (outline.LevelOf(paragraph) is { } level and >= 1 and <= 9) PropertyWriter.SetVal(PropertyWriter.ParagraphChild(paragraph, "outlineLvl"), PropertyWriter.Number(level - 1));
        }

        var seams =ranges.OrderBy(item => item.From).Select(item => MakeSeam(model, blocks, item.From, item.End)).ToList();
        var tablePairs = AdjacentTables(body);
        var endsWithTable = LastBlock(body)?.Name == W.Tbl;
        var sdts = new HashSet<XElement>(ReferenceEqualityComparer.Instance);
        fields.ForEach(FieldEditor.DeleteWhole);
        foreach (var paragraph in spanned.Concat(removed))
        {
            if (paragraph.Parent is null) continue;
            sdts.UnionWith(paragraph.Ancestors(W.Sdt));
            // 域可能结束在下一个标题里：域外还有正文的段落保留，只清掉空的超链接外壳。
            if (!removed.Contains(paragraph) && Visible(paragraph) && !IsTitle(model, paragraph))
            {
                paragraph.Elements(W.Hyperlink).Where(link => !link.Descendants(W.R_).Any()).ToList().ForEach(link => link.Remove());
                continue;
            }

            Vacate(model, paragraph);
        }

        CleanSdts(sdts);
        foreach (var seam in seams) Mend(model, body, seam);
        KeepTablesApart(body, tablePairs, endsWithTable);
        fix.Touch(model.DocumentPart);
        return Math.Max(1, ranges.Count);
    }

    /// <summary>正文顶层的段落和表格，内容控件、自定义 XML 里的展开（与检查模型的正文块一致）。</summary>
    static List<XElement> Blocks(XElement body)
    {
        var blocks = new List<XElement>();
        Collect(body);
        return blocks;

        void Collect(XElement parent)
        {
            foreach (var child in parent.Elements())
            {
                if (child.Name == W.P || child.Name == W.Tbl) blocks.Add(child);
                else if (child.Name == W.Sdt) Collect(child.Element(W.SdtContent) ?? child);
                else if (child.Name == W.CustomXml || child.Name == W.SdtContent) Collect(child);
            }
        }
    }

    /// <summary>元素所在的正文顶层段落序号；在表格单元格里时返回 null。</summary>
    static int? TopIndex(XElement element, Dictionary<XElement, int> position)
    {
        var paragraph = element.AncestorsAndSelf(W.P).LastOrDefault();
        return paragraph is not null && position.TryGetValue(paragraph, out var index) ? index : null;
    }

    static string? StyleName(DocumentModel model, XElement paragraph, out string? styleId)
    {
        styleId = W.ValOf(paragraph.Element(W.PPr)?.Element(W.PStyle));
        return styleId is null ? null : model.Sheet.ById.GetValueOrDefault(styleId)?.DisplayName;
    }

    static bool IsTocStyle(DocumentModel model, XElement paragraph)
    {
        var name = StyleName(model, paragraph, out var styleId);
        return OutlineAnalyzer.TocLevelOfStyle(name, styleId) is not null;
    }

    static bool IsTitle(DocumentModel model, XElement paragraph)
    {
        var name = StyleName(model, paragraph, out var styleId);
        return OutlineAnalyzer.IsTocTitleStyle(name, styleId) || OutlineAnalyzer.IsTocTitle(DocumentModel.ParagraphText(paragraph));
    }

    static List<(int Start, int End)> Regions(List<XElement> blocks, Func<XElement, bool> member)
    {
        var regions = new List<(int, int)>();
        for (var index = 0; index < blocks.Count; index += 1)
        {
            if (!member(blocks[index])) continue;
            var start = index;
            while (index + 1 < blocks.Count && member(blocks[index + 1])) index += 1;
            regions.Add((start, index));
        }

        return regions;
    }

    /// <summary>目录前面单独一行的目录标题，中间最多隔两个空段落。</summary>
    static XElement? FindTitle(DocumentModel model, List<XElement> blocks, int start)
    {
        for (var index = start - 1; index >= 0 && index >= start - 3; index -= 1)
        {
            var block = blocks[index];
            if (block.Name != W.P) return null;
            if (IsTitle(model, block)) return block;
            if (Visible(block)) return null;
        }

        return null;
    }

    /// <summary>
    /// 手工目录：一行"××目录"标题，下面连续 3 行以上，每行去掉点导引和页码后都与后文某段文字相同（行间可隔空段落）。
    /// 至少一行是检查认出的目录段落时才删，与检查口径一致；没有目录标题的不删。
    /// </summary>
    static List<(XElement Title, List<XElement> Lines)> ManualTocs(DocumentModel model, TocInfo toc, List<XElement> blocks, Func<XElement, bool> handled)
    {
        var texts = blocks.Select(block => block.Name == W.P ? DocumentModel.ParagraphText(block) : "").ToList();
        var lastIndex = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var index = 0; index < blocks.Count; index += 1)
        {
            var normalized = OutlineAnalyzer.NormalizeTitle(texts[index]);
            if (normalized.Length > 0) lastIndex[normalized] = index;
        }

        var result = new List<(XElement, List<XElement>)>();
        for (var index = 0; index < blocks.Count; index += 1)
        {
            if (blocks[index].Name != W.P || handled(blocks[index]) || !IsTitle(model, blocks[index])) continue;
            var lines = new List<XElement>();
            var pending = new List<XElement>();
            var count = 0;
            var cursor = index + 1;
            for (; cursor < blocks.Count; cursor += 1)
            {
                var block = blocks[cursor];
                if (block.Name != W.P || handled(block)) break;
                if (texts[cursor].Trim().Length == 0)
                {
                    if (Visible(block) || HasPageBreak(block) || SectionOf(block) is not null) break;
                    pending.Add(block);
                    continue;
                }

                var normalized = OutlineAnalyzer.NormalizeTitle(texts[cursor]);
                if (normalized.Length == 0 || !lastIndex.TryGetValue(normalized, out var last) || last <= cursor) break;
                if (lines.Count > 0) lines.AddRange(pending);
                pending.Clear();
                lines.Add(block);
                count += 1;
            }

            if (count < 3 || !lines.Any(toc.Paragraphs.Contains)) continue;
            result.Add((blocks[index], lines));
            index = cursor - 1;
        }

        return result;
    }

    static Seam MakeSeam(DocumentModel model, List<XElement> blocks, int from, int end)
    {
        var before = from - 1;
        while (before >= 0 && IsGap(blocks[before])) before -= 1;
        var after = end + 1;
        while (after < blocks.Count && IsGap(blocks[after])) after += 1;
        var needs = false;
        if (before >= 0 && blocks[before].Name == W.P) needs = TrailingBreaks(blocks[before]).Count > 0 || PageSection(blocks[before]);
        for (var index = before + 1; index < after; index += 1)
        {
            var block = blocks[index];
            needs |= block.Name == W.P && (HasPageBreak(block) || PageSection(block) || BreaksBefore(model, block));
        }

        if (after < blocks.Count && blocks[after].Name == W.P) needs |= BreaksBefore(model, blocks[after]) || LeadingBreaks(blocks[after]).Count > 0;
        var strays = Strays(model, blocks, from, end, before, after);
        // 标题和目录之间的空段落同样在目录页上。
        for (var index = from + 1; index <= end; index += 1)
        {
            if (blocks[index].Name == W.P && !Visible(blocks[index]) && !HasPageBreak(blocks[index]) && SectionOf(blocks[index]) is null) strays.Add(blocks[index]);
        }

        // 以目录前最近的内容块定位接缝：它不会被删除；中间的空段落可能被删掉。
        return new Seam(before >= 0 ? blocks[before] : null, needs, strays);
    }

    /// <summary>
    /// 和目录同页的空段落：目录前面到上一处换页之间、目录后面到下一处换页之间的空段落（没有分页符和分节符）。
    /// 目录和前后内容在同一页（中间没有换页）时，那一侧的空段落是正常的间隔，不算。
    /// </summary>
    static List<XElement> Strays(DocumentModel model, List<XElement> blocks, int from, int end, int before, int after)
    {
        var strays = new List<XElement>();
        bool Separator(XElement block) => HasPageBreak(block) || PageSection(block);

        // 目录本身以段前分页开始时，前面的空段落在上一页，不算。
        if (!BreaksBefore(model, blocks[from]))
        {
            var side = new List<XElement>();
            var index = from - 1;
            for (; index > before; index -= 1)
            {
                if (Separator(blocks[index])) break;
                side.Add(blocks[index]);
                if (BreaksBefore(model, blocks[index])) break;
            }

            var paged = index > before
                || side.Any(block => BreaksBefore(model, block))
                || (before >= 0 && blocks[before].Name == W.P && (TrailingBreaks(blocks[before]).Count > 0 || PageSection(blocks[before])))
                || before < 0;
            if (paged) strays.AddRange(side);
        }

        var tail = new List<XElement>();
        var cursor = end + 1;
        var ended = false;
        for (; cursor < after; cursor += 1)
        {
            if (BreaksBefore(model, blocks[cursor])) { ended = true; break; }
            if (Separator(blocks[cursor])) { ended = true; break; }
            tail.Add(blocks[cursor]);
        }

        if (ended || after >= blocks.Count || (blocks[after].Name == W.P && (BreaksBefore(model, blocks[after]) || LeadingBreaks(blocks[after]).Count > 0))) strays.AddRange(tail);
        return strays;
    }

    static bool IsVisibleElement(XElement element)
    {
        if (element.Name == W.T) return element.Value.Trim().Length > 0;
        if (element.Name == W.Tab || element.Name == W.Sym) return element.Parent?.Name == W.R_;
        if (element.Name == W.Br) return W.Attr(element, "type") != "page";
        return element.Name == W.Drawing || element.Name == W.Pict || element.Name == W.Object || element.Name == W.FldChar || element.Name == W.TxbxContent;
    }

    /// <summary>段落里有可见内容：文字、图片、对象、制表符、换行或域。分页符不算。</summary>
    internal static bool Visible(XElement paragraph) => paragraph.Descendants().Any(IsVisibleElement);

    /// <summary>接缝里的段落：没有可见内容，只可能带分页符或分节符。</summary>
    static bool IsGap(XElement block) => block.Name == W.P && !Visible(block);

    internal static XElement? SectionOf(XElement paragraph) => paragraph.Element(W.PPr)?.Element(W.SectPr);

    /// <summary>带分节符且新节另起一页（连续分节不换页）。</summary>
    static bool PageSection(XElement paragraph)
    {
        var section = SectionOf(paragraph);
        return section is not null && W.ValOf(section.Element(W.Type)) != "continuous";
    }

    static bool HasPageBreak(XElement paragraph) => paragraph.Descendants(W.Br).Any(item => W.Attr(item, "type") == "page" && !item.Ancestors(W.TxbxContent).Any());

    /// <summary>段落设置了段前分页（直接设置或来自样式）。</summary>
    internal static bool BreaksBefore(DocumentModel model, XElement paragraph)
    {
        var direct = paragraph.Element(W.PPr)?.Element(PageBreakBefore);
        if (direct is not null) return W.OnOff(direct) ?? true;
        var style = model.Sheet.ResolveParagraphStyle(W.ValOf(paragraph.Element(W.PPr)?.Element(W.PStyle)));
        return model.Sheet.Chain(style, "paragraph").Select(item => item.PPr?.Element(PageBreakBefore)).FirstOrDefault(item => item is not null) is { } inherited && (W.OnOff(inherited) ?? true);
    }

    /// <summary>找分页符位置时的内容：可见内容里去掉域标记（域结果的文字仍算）。</summary>
    static bool IsContent(XElement element) => element.Name != W.FldChar && IsVisibleElement(element);

    /// <summary>段末的分页符：最后一处内容之后的分页符。</summary>
    internal static List<XElement> TrailingBreaks(XElement paragraph)
    {
        var breaks = new List<XElement>();
        foreach (var element in paragraph.Descendants().Reverse())
        {
            if (element.Name == W.Br && W.Attr(element, "type") == "page") breaks.Add(element);
            else if (IsContent(element)) break;
        }

        return breaks;
    }

    /// <summary>段首的分页符：第一处内容之前的分页符（例如目录域结束后紧跟分页符和标题文字）。</summary>
    internal static List<XElement> LeadingBreaks(XElement paragraph)
    {
        var breaks = new List<XElement>();
        foreach (var element in paragraph.Descendants())
        {
            if (element.Name == W.Br && W.Attr(element, "type") == "page") breaks.Add(element);
            else if (IsContent(element)) break;
        }

        return breaks;
    }

    static void RemoveBreaks(IEnumerable<XElement> breaks)
    {
        foreach (var item in breaks.ToList())
        {
            var run = item.Parent;
            item.Remove();
            PropertyWriter.RemoveIfEmptyRun(run);
        }
    }

    /// <summary>删除段落；段内书签的另一端一起删掉，避免留下不成对的书签。</summary>
    static void DeleteParagraph(XElement paragraph)
    {
        var root = paragraph.Document?.Root;
        foreach (var mark in paragraph.Descendants().Where(item => item.Name == BookmarkStart || item.Name == BookmarkEnd).ToList())
        {
            var id = W.Attr(mark, "id");
            var other = mark.Name == BookmarkStart ? BookmarkEnd : BookmarkStart;
            root?.Descendants(other).Where(item => W.Attr(item, "id") == id && !item.Ancestors().Contains(paragraph)).ToList().ForEach(item => item.Remove());
        }

        paragraph.Remove();
    }

    /// <summary>
    /// 清掉目录段落：带分节符或分页符的段落只留段落属性和分页符（去掉目录样式和段前分页），交给接缝整理决定去留；
    /// 其余整段删除。
    /// </summary>
    static void Vacate(DocumentModel model, XElement paragraph)
    {
        if (SectionOf(paragraph) is null && !HasPageBreak(paragraph))
        {
            DeleteParagraph(paragraph);
            return;
        }

        var pageBreaks = paragraph.Descendants(W.Br).Count(item => W.Attr(item, "type") == "page");
        foreach (var node in paragraph.Nodes().Where(node => node is not XElement element || element.Name != W.PPr).ToList()) node.Remove();
        for (var index = 0; index < pageBreaks; index += 1) paragraph.Add(new XElement(W.R_, new XElement(W.Br, new XAttribute(W.Type, "page"))));
        var properties = paragraph.Element(W.PPr);
        if (properties is null) return;
        if (IsTocStyle(model, paragraph) || IsTitle(model, paragraph)) properties.Element(W.PStyle)?.Remove();
        properties.Element(PageBreakBefore)?.Remove();
    }

    /// <summary>目录所在的内容控件：清空的去掉；Word 自动目录的内容控件（目录库）把剩下的段落移出来再去掉。</summary>
    static void CleanSdts(HashSet<XElement> sdts)
    {
        foreach (var sdt in sdts.OrderByDescending(item => item.Ancestors().Count()))
        {
            if (sdt.Parent is null) continue;
            var content = sdt.Element(W.SdtContent);
            if (content is null || !content.Elements().Any())
            {
                sdt.Remove();
                continue;
            }

            var gallery = W.ValOf(sdt.Element(SdtPr)?.Descendants(DocPartGallery).FirstOrDefault());
            if (gallery is null || !(gallery.Contains("Table of Contents", StringComparison.OrdinalIgnoreCase) || gallery.Contains("目录"))) continue;
            var nodes = content.Nodes().ToList();
            foreach (var node in nodes) node.Remove();
            sdt.AddBeforeSelf(nodes);
            sdt.Remove();
        }
    }

    /// <summary>
    /// 整理接缝：目录前后最近的两块内容之间只保留一处换页。依次优先用分节符（前一块内容自带的，或接缝里第一个分节符，
    /// 后者移到前一段上，免得空段落单独占一页）、前一块内容的段末分页符、接缝里最前面的分页段落、后一块内容的段首分页符，
    /// 其余去掉，空出来的节并入下一节；原来换页、删完却不换页时在前一块内容末尾补一个分页符。
    /// 接缝在文档开头或末尾时不需要换页。
    /// </summary>
    static void Mend(DocumentModel model, XElement body, Seam seam)
    {
        foreach (var stray in seam.Strays)
        {
            if (stray.Parent is not null && !Visible(stray) && SectionOf(stray) is null && !HasPageBreak(stray)) DeleteParagraph(stray);
        }

        var blocks = Blocks(body);
        var anchor = seam.Before is { Parent: not null } before ? blocks.IndexOf(before) : -1;
        var start = anchor;
        while (start >= 0 && IsGap(blocks[start])) start -= 1;
        var end = anchor + 1;
        while (end < blocks.Count && IsGap(blocks[end])) end += 1;
        var previous = start >= 0 ? blocks[start] : null;
        var next = end < blocks.Count ? blocks[end] : null;
        var gaps = blocks.Skip(start + 1).Take(end - start - 1).ToList();
        var sections = gaps.Where(item => SectionOf(item) is not null).ToList();
        var pages = gaps.Where(item => SectionOf(item) is null && HasPageBreak(item)).ToList();
        var previousParagraph = previous?.Name == W.P ? previous : null;
        var leading = next?.Name == W.P ? LeadingBreaks(next) : [];

        if (previous is null || next is null || (previousParagraph is not null && PageSection(previousParagraph)))
        {
            // 文档开头、末尾，或前一块内容自带分节符：接缝里的节都是空节，分页符都多余。
            sections.ForEach(item => DropSection(body, item));
            pages.ForEach(StripBreaks);
            RemoveBreaks(leading);
            if (next is null && previousParagraph is not null) RemoveBreaks(TrailingBreaks(previousParagraph));
            return;
        }

        var separated = false;
        if (sections.Count > 0)
        {
            sections.Skip(1).ToList().ForEach(item => DropSection(body, item));
            var keep = sections[0];
            separated = PageSection(keep);
            MoveSectionUp(blocks, keep);
            if (keep.Parent is not null && HasPageBreak(keep)) StripBreaks(keep);
        }

        if (separated || (previousParagraph is not null && TrailingBreaks(previousParagraph).Count > 0))
        {
            if (separated && previousParagraph is not null) RemoveBreaks(TrailingBreaks(previousParagraph));
            pages.ForEach(StripBreaks);
            RemoveBreaks(leading);
        }
        else if (pages.Count > 0)
        {
            // 留最前面的分页段落：它多半是目录前原有的换页，也是检查认封面的分界，留下它封面识别不变。
            pages.Skip(1).ToList().ForEach(StripBreaks);
            RemoveBreaks(leading);
        }
        else if (leading.Count > 0)
        {
            RemoveBreaks(leading.Skip(1));
        }
        else if (seam.NeedsBreak && !(next.Name == W.P && BreaksBefore(model, next)))
        {
            if (previousParagraph is not null) previousParagraph.Add(new XElement(W.R_, new XElement(W.Br, new XAttribute(W.Type, "page"))));
            else next.AddBeforeSelf(new XElement(W.P, new XElement(W.R_, new XElement(W.Br, new XAttribute(W.Type, "page")))));
        }
    }

    /// <summary>去掉分页符；只剩段落属性的段落删除（分节段落保留）。</summary>
    static void StripBreaks(XElement paragraph)
    {
        RemoveBreaks(paragraph.Descendants(W.Br).Where(item => W.Attr(item, "type") == "page"));
        if (SectionOf(paragraph) is null && !Visible(paragraph)) DeleteParagraph(paragraph);
    }

    /// <summary>
    /// 把接缝里的分节符移到紧挨着的上一段（同一节的最后一段），分节段落本身没有内容时删除。
    /// 上一块是表格或已带分节符时保留原位。
    /// </summary>
    static void MoveSectionUp(List<XElement> blocks, XElement paragraph)
    {
        var index = blocks.IndexOf(paragraph);
        var target = index > 0 ? blocks[index - 1] : null;
        if (target is null || target.Name != W.P || target.Parent is null || SectionOf(target) is not null) return;
        var section = SectionOf(paragraph)!;
        section.Remove();
        var properties = target.Element(W.PPr);
        if (properties is null)
        {
            properties = new XElement(W.PPr);
            target.AddFirst(properties);
        }

        if (properties.Element(PPrChange) is { } change) change.AddBeforeSelf(section);
        else properties.Add(section);
        if (!Visible(paragraph) && !HasPageBreak(paragraph)) DeleteParagraph(paragraph);
    }

    /// <summary>
    /// 去掉空节：分节符所在段落没有内容时一起删除。下一节没有的页眉页脚引用从本节补过去，
    /// 原来沿用本节页眉页脚的后续各节保持不变。
    /// </summary>
    static void DropSection(XElement body, XElement paragraph)
    {
        var section = SectionOf(paragraph)!;
        var all = body.Descendants(W.SectPr).Where(item => item.Parent?.Name == W.PPr || item.Parent == body).ToList();
        var next = all.SkipWhile(item => item != section).Skip(1).FirstOrDefault();
        if (next is not null)
        {
            foreach (var reference in section.Elements().Where(item => item.Name == W.HeaderReference || item.Name == W.FooterReference).Reverse())
            {
                if (!next.Elements(reference.Name).Any(item => W.Attr(item, "type") == W.Attr(reference, "type"))) next.AddFirst(new XElement(reference));
            }
        }

        section.Remove();
        if (!Visible(paragraph) && !HasPageBreak(paragraph)) DeleteParagraph(paragraph);
    }

    static XElement? LastBlock(XElement body) => Blocks(body).LastOrDefault();

    static HashSet<XElement> AdjacentTables(XElement body)
    {
        return new HashSet<XElement>(
            body.Descendants(W.Tbl).Where(table => table.ElementsAfterSelf().FirstOrDefault()?.Name == W.Tbl),
            ReferenceEqualityComparer.Instance);
    }

    /// <summary>删段后原本隔开的两个表格会并在一起，文档也不能以表格结尾：补一个空段落。</summary>
    static void KeepTablesApart(XElement body, HashSet<XElement> pairs, bool endedWithTable)
    {
        foreach (var table in body.Descendants(W.Tbl).ToList())
        {
            if (table.ElementsAfterSelf().FirstOrDefault()?.Name == W.Tbl && !pairs.Contains(table)) table.AddAfterSelf(new XElement(W.P));
        }

        if (!endedWithTable && LastBlock(body) is { } last && last.Name == W.Tbl) last.AddAfterSelf(new XElement(W.P));
    }
}
