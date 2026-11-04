using DocumentFormat.OpenXml;
using Yibiao.OpenXmlHelper.Ooxml;
using Yibiao.OpenXmlHelper.BlindCheck.Model;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Fix;

/// <summary>一个域：简单域是 w:fldSimple；复杂域由 begin / separate / end 三个 fldChar 和中间的文本块组成。</summary>
sealed class FieldInstance
{
    public OpenXmlElement? Simple { get; init; }
    public string Instruction { get; set; } = "";
    public string Kind { get; set; } = "unknown";
    public List<OpenXmlElement> Runs { get; } = [];
    public List<OpenXmlElement> Markers { get; } = [];
    public List<OpenXmlElement> InstructionTexts { get; } = [];
    public bool InResult { get; set; }
}

/// <summary>在文本块层面定位域，支持整个删除（连同显示结果）或取消域、保留显示结果。</summary>
static class FieldEditor
{
    public static List<FieldInstance> Collect(OpenXmlElement root)
    {
        var fields = new List<FieldInstance>();
        var stack = new List<FieldInstance>();
        foreach (var element in root.Descendants())
        {
            if (element.Name == W.FldSimple)
            {
                var instruction = W.Attr(element, "instr") ?? "";
                fields.Add(new FieldInstance { Simple = element, Instruction = instruction, Kind = FieldScanner.Classify(instruction) });
                continue;
            }

            if (element.Name != W.R_) continue;
            foreach (var open in stack) open.Runs.Add(element);
            foreach (var child in element.Elements())
            {
                if (child.Name == W.FldChar)
                {
                    var type = W.Attr(child, "fldCharType");
                    if (type == "begin")
                    {
                        var field = new FieldInstance();
                        field.Runs.Add(element);
                        field.Markers.Add(child);
                        stack.Add(field);
                    }
                    else if (stack.Count > 0 && type == "separate")
                    {
                        stack[^1].Markers.Add(child);
                        stack[^1].InResult = true;
                    }
                    else if (stack.Count > 0 && type == "end")
                    {
                        var field = stack[^1];
                        field.Markers.Add(child);
                        field.Kind = FieldScanner.Classify(field.Instruction);
                        fields.Add(field);
                        stack.RemoveAt(stack.Count - 1);
                    }
                }
                else if (child.Name == W.InstrText && stack.Count > 0 && !stack[^1].InResult)
                {
                    stack[^1].Instruction += child.Value;
                    stack[^1].InstructionTexts.Add(child);
                }
            }
        }

        return fields;
    }

    /// <summary>
    /// 删除整个域：身份类域的显示结果本身就是人名、文件名，必须一起删掉。
    /// 开始和结束标记所在的文本块可能还带着域外的正文，只删标记范围内的子元素，其余文本块整个删除。
    /// </summary>
    public static void DeleteWhole(FieldInstance field)
    {
        if (field.Simple is not null)
        {
            if (field.Simple.Parent is not null) WordStructure.Remove(field.Simple);
            return;
        }

        // 一次整批交给结构层：整个域的标记一起删除，不会被当成“只删了一半的域”去降级剩余部分。
        var begin = field.Markers[0];
        var end = field.Markers[^1];
        var removed = new List<OpenXmlElement>();
        var partial = new List<OpenXmlElement>();
        foreach (var run in field.Runs)
        {
            if (run.Parent is null) continue;
            var hasBegin = begin.Parent == run;
            var hasEnd = end.Parent == run;
            if (!hasBegin && !hasEnd)
            {
                removed.Add(run);
                continue;
            }

            var children = run.Elements().ToList();
            var from = hasBegin ? children.IndexOf(begin) : 0;
            var to = hasEnd ? children.IndexOf(end) : children.Count - 1;
            for (var index = from; index <= to; index += 1)
            {
                if (children[index].Name != W.RPr) removed.Add(children[index]);
            }

            partial.Add(run);
        }

        WordStructure.RemoveRange(removed);
        partial.ForEach(PropertyWriter.RemoveIfEmptyRun);
    }

    /// <summary>取消域：去掉域标记和指令，保留显示结果的文字。</summary>
    public static void Unlink(FieldInstance field)
    {
        if (field.Simple is not null)
        {
            WordStructure.Unwrap(field.Simple);
            return;
        }

        WordStructure.RemoveRange(field.Markers.Concat(field.InstructionTexts).Where(element => element.Parent is not null).ToList());

        foreach (var run in field.Runs) PropertyWriter.RemoveIfEmptyRun(run);
    }

    public static IEnumerable<OpenXmlElement> ResultRuns(FieldInstance field)
    {
        if (field.Simple is not null) return field.Simple.Elements(W.R_);
        return field.Runs.Where(run => run.Parent is not null && run.Element(W.FldChar) is null && run.Element(W.InstrText) is null);
    }
}
