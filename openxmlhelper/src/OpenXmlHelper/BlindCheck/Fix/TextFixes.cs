using System.Text;
using System.Xml.Linq;
using Yibiao.OpenXmlHelper.BlindCheck.Model;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;
using Yibiao.OpenXmlHelper.BlindCheck.Rules;

namespace Yibiao.OpenXmlHelper.BlindCheck.Fix;

/// <summary>按整段文字计算出的逐字修改：替换和删除，位置是整段渲染文字中的下标，并记下提出修改的规则。</summary>
sealed class TextEdits
{
    public Dictionary<int, (char Value, string RuleId)> Replace { get; } = [];
    public Dictionary<int, string> Delete { get; } = [];
    public bool IsEmpty => Replace.Count == 0 && Delete.Count == 0;
}

/// <summary>
/// 标点、空格、特殊字符、手动换行修复。判断必须按整段文字做（文本块切分是任意的，"3" + ".14" 分在两块时逐块判断会误改），
/// 再把要改的位置按每个子元素贡献的文字长度对应回各个 w:t，其余元素不动。
/// </summary>
static class TextFixes
{
    static readonly HashSet<char> DeletedIrregular = [(char)0x200B, (char)0x200C, (char)0x200D, (char)0xFEFF, (char)0x2028, (char)0x2029];
    const char NoBreakSpace = (char)0x00A0;

    public static bool Supports(string ruleId) => ruleId is "text.english_punct" or "text.spaces" or "text.irregular";

    /// <summary>收集一条规则在本段要做的修改；同一位置先提出的规则生效，删除优先于替换。</summary>
    public static void Collect(string ruleId, RuleContext context, ParaRecord record, TextEdits edits)
    {
        var text = record.Text;
        switch (ruleId)
        {
            case "text.english_punct":
                foreach (var (index, value) in TextRules.FindEnglishPunct(text))
                {
                    edits.Replace.TryAdd(index, (TextRules.ToFullWidth(value), ruleId));
                }

                break;
            case "text.spaces":
                foreach (var index in TextRules.RemovableSpaces(text, context.Profile))
                {
                    edits.Delete.TryAdd(index, ruleId);
                }

                break;
            case "text.irregular":
                for (var index = 0; index < text.Length; index += 1)
                {
                    if (DeletedIrregular.Contains(text[index])) edits.Delete.TryAdd(index, ruleId);
                    else if (text[index] == NoBreakSpace) edits.Replace.TryAdd(index, (' ', ruleId));
                }

                break;
        }
    }

    /// <summary>
    /// 把整段的修改对应回各个 w:t；改空的 w:t 删除，只剩属性的文本块一并删除。
    /// 返回各规则实际改动的字符数：落在制表符、符号等非 w:t 元素上的修改不会执行，也不计数。
    /// </summary>
    public static Dictionary<string, int> Apply(ParaRecord record, TextEdits edits)
    {
        var applied = new Dictionary<string, int>(StringComparer.Ordinal);
        if (edits.IsEmpty) return applied;
        var offset = 0;
        foreach (var run in record.Runs)
        {
            var runChanged = false;
            foreach (var child in run.Element.Elements().ToList())
            {
                var piece = DocumentModel.PieceText(child);
                if (child.Name == W.T && piece.Length > 0)
                {
                    var builder = new StringBuilder(piece.Length);
                    for (var index = 0; index < piece.Length; index += 1)
                    {
                        var position = offset + index;
                        if (edits.Delete.TryGetValue(position, out var deletedBy))
                        {
                            applied[deletedBy] = applied.GetValueOrDefault(deletedBy) + 1;
                            continue;
                        }

                        if (edits.Replace.TryGetValue(position, out var replacement) && replacement.Value != piece[index])
                        {
                            applied[replacement.RuleId] = applied.GetValueOrDefault(replacement.RuleId) + 1;
                            builder.Append(replacement.Value);
                        }
                        else
                        {
                            builder.Append(piece[index]);
                        }
                    }

                    var value = builder.ToString();
                    if (value != piece)
                    {
                        if (value.Length == 0) child.Remove();
                        else PropertyWriter.SetTextValue(child, value);
                        runChanged = true;
                    }
                }

                offset += piece.Length;
            }

            if (runChanged) PropertyWriter.RemoveIfEmptyRun(run.Element);
        }

        return applied;
    }

    /// <summary>
    /// 把段落渲染文字中 [start, start + length) 的字符换成 value：value 写进范围开头所在的 w:t，其余字符删除，删空的 w:t 和文本块一并去掉。
    /// 范围里有制表符、符号等非 w:t 内容时不改，返回 false。
    /// </summary>
    public static bool ReplaceRange(XElement paragraph, int start, int length, string value)
    {
        var offset = 0;
        var pieces = new List<(XElement Element, int Start)>();
        foreach (var run in DocumentModel.RenderedRuns(paragraph))
        {
            foreach (var child in run.Elements())
            {
                var piece = DocumentModel.PieceText(child);
                if (piece.Length > 0 && offset < start + length && offset + piece.Length > start) pieces.Add((child, offset));
                offset += piece.Length;
            }
        }

        if (pieces.Count == 0 || pieces.Any(item => item.Element.Name != W.T)) return false;
        for (var index = 0; index < pieces.Count; index += 1)
        {
            var (element, at) = pieces[index];
            var text = element.Value;
            var updated = text[..Math.Max(0, start - at)] + (index == 0 ? value : "") + text[Math.Min(text.Length, start + length - at)..];
            if (updated.Length > 0)
            {
                PropertyWriter.SetTextValue(element, updated);
                continue;
            }

            var run = element.Parent;
            element.Remove();
            PropertyWriter.RemoveIfEmptyRun(run);
        }

        return true;
    }

    /// <summary>手动换行：软回车 w:br（分页符、分栏符除外）、w:cr，以及 w:t 里夹带的换行字符，返回所含的换行数。</summary>
    static int LineBreaks(XElement child)
    {
        if (child.Name == W.T) return child.Value.Count(item => item == '\n');
        return (child.Name == W.Br && W.Attr(child, "type") is null or "textWrapping") || child.Name == W.Cr ? 1 : 0;
    }

    /// <summary>去掉拆出的新段开头的空格：缩进由段落格式负责，换行后手打的空格留着会多缩进。</summary>
    static void TrimLeadingSpaces(XElement paragraph)
    {
        foreach (var text in DocumentModel.RenderedRuns(paragraph).SelectMany(run => run.Elements(W.T)).ToList())
        {
            var value = text.Value.TrimStart(' ', '　');
            if (value.Length > 0)
            {
                PropertyWriter.SetTextValue(text, value);
                return;
            }

            var run = text.Parent;
            text.Remove();
            PropertyWriter.RemoveIfEmptyRun(run);
        }
    }

    static bool Visible(IEnumerable<XNode> nodes)
    {
        return nodes.OfType<XElement>().SelectMany(element => element.DescendantsAndSelf()).Any(item =>
            (item.Name == W.T && item.Value.Trim().Length > 0) || item.Name == W.Drawing || item.Name == W.Pict || item.Name == W.Object || item.Name == W.Sym
            || (item.Name.Namespace == W.Mc && item.Name.LocalName == "AlternateContent"));
    }

    /// <summary>
    /// 手动换行改为段落回车：在换行处把段落拆开，后面的段落沿用原段落格式（段前分页只留在第一段，分节符留在最后一段），
    /// 拆出来的空行不保留，新段开头的空格去掉（缩进交给段落格式）。标题、带编号或图文框的段落、含域的段落，
    /// 以及换行落在超链接、修订等包装里的段落不拆，记一条说明留给人工。在逐段修复之后执行，前面改好的文本块随拆分带到新段落。
    /// 返回处理的换行数。
    /// </summary>
    public static int SplitLineBreaks(FixContext fix, IEnumerable<ParaRecord> records)
    {
        var count = 0;
        var skipped = 0;
        foreach (var record in records)
        {
            var paragraph = record.Element;
            var direct = paragraph.Elements(W.R_).Sum(run => run.Elements().Sum(LineBreaks));
            if (paragraph.Parent is null || direct == 0) continue;
            var pPr = paragraph.Element(W.PPr);
            if (direct != DocumentModel.RenderedRuns(paragraph).Sum(run => run.Elements().Sum(LineBreaks))
                || fix.Rules.HeadingLevel(record) is not null || StructureFixes.HasNumbering(fix, record)
                || pPr?.Element(W.Ns + "framePr") is not null || paragraph.Descendants(W.FldChar).Any())
            {
                skipped += 1;
                continue;
            }

            var segments = new List<List<XNode>> { new() };
            foreach (var node in paragraph.Nodes().Where(node => node != pPr).ToList())
            {
                node.Remove();
                if (node is not XElement run || run.Name != W.R_ || !run.Elements().Any(child => LineBreaks(child) > 0))
                {
                    segments[^1].Add(node);
                    continue;
                }

                var rPr = run.Element(W.RPr);
                XElement NewRun() => new(W.R_, run.Attributes(), rPr is null ? null : new XElement(rPr));
                var piece = NewRun();
                void Flush()
                {
                    if (piece.Elements().Any(item => item.Name != W.RPr)) segments[^1].Add(piece);
                    piece = NewRun();
                }

                foreach (var child in run.Elements().Where(item => item != rPr).ToList())
                {
                    child.Remove();
                    if (child.Name != W.T && LineBreaks(child) > 0)
                    {
                        Flush();
                        segments.Add([]);
                    }
                    else if (child.Name == W.T && child.Value.Contains('\n'))
                    {
                        var lines = child.Value.Replace("\r", "").Split('\n');
                        for (var index = 0; index < lines.Length; index += 1)
                        {
                            if (index > 0)
                            {
                                Flush();
                                segments.Add([]);
                            }

                            if (lines[index].Length == 0) continue;
                            var text = new XElement(W.T);
                            PropertyWriter.SetTextValue(text, lines[index]);
                            piece.Add(text);
                        }
                    }
                    else
                    {
                        piece.Add(child);
                    }
                }

                Flush();
            }

            // 没有可见内容的片段（连续换行、段尾换行留下的空行）并进前一段，书签等标记不丢。
            var kept = new List<List<XNode>>();
            var leading = new List<XNode>();
            foreach (var segment in segments)
            {
                if (!Visible(segment))
                {
                    (kept.Count > 0 ? kept[^1] : leading).AddRange(segment);
                    continue;
                }

                segment.InsertRange(0, leading);
                leading.Clear();
                kept.Add(segment);
            }

            if (kept.Count == 0) kept.Add(leading);
            paragraph.Add(kept[0]);
            var previous = paragraph;
            for (var index = 1; index < kept.Count; index += 1)
            {
                var properties = pPr is null ? null : new XElement(pPr);
                if (index < kept.Count - 1) properties?.Element(W.SectPr)?.Remove();
                var next = new XElement(W.P, properties, kept[index]);
                // 段前分页可能来自样式，新段写显式关闭值才关得掉。
                if (record.Format.PageBreakBefore) PropertyWriter.SetParagraphToggle(next, "pageBreakBefore", false);
                previous.AddAfterSelf(next);
                TrimLeadingSpaces(next);
                previous = next;
            }

            // 分节符属于原段落的最后一行，留在拆出的最后一段。
            if (kept.Count > 1) pPr?.Element(W.SectPr)?.Remove();
            count += direct;
            fix.Touch(record);
        }

        if (skipped > 0) fix.Note($"有 {skipped} 段的手动换行在标题、编号段落或超链接、域中，没有自动拆分，请在 Word 中手动处理");
        return count;
    }
}
