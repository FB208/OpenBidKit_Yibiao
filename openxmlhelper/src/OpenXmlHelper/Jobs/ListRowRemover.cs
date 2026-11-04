using System.Text.RegularExpressions;
using Yibiao.OpenXmlHelper.Ooxml;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>
/// 整本导出删除清单表未使用的行（未使用由 Main 按确认弹窗的空行规则判定）。
/// 只删整行字段都在列表中、字段以外只有序号类文字、且不参与纵向合并的行，其余行保留。
/// </summary>
static class ListRowRemover
{
    // 字段以外允许的文字：预印的序号、标点和空白。
    static readonly Regex SerialOnly = new(@"^[\s\d\p{P}]*$", RegexOptions.CultureInvariant | RegexOptions.Compiled);

    public static int Remove(IReadOnlyDictionary<string, List<Wp.SdtElement>> controls, IReadOnlyCollection<string> fieldIds)
    {
        var ids = fieldIds.ToHashSet(StringComparer.Ordinal);
        var rows = ids
            .Where(controls.ContainsKey)
            .SelectMany(id => controls[id])
            .Select(control => control.Ancestors<Wp.TableRow>().FirstOrDefault())
            .OfType<Wp.TableRow>()
            .Where(row => row.Parent is not null)
            .Distinct()
            .ToList();
        var removed = 0;
        foreach (var row in rows)
        {
            var fields = row.Descendants<Wp.SdtElement>().Where(control => FieldId(control) is not null).ToList();
            if (fields.Any(control => !ids.Contains(FieldId(control)!))) continue;
            var outside = string.Concat(row.Descendants<Wp.Text>()
                .Where(text => !text.Ancestors<Wp.SdtElement>().Any(control => FieldId(control) is not null))
                .Select(text => text.Text));
            if (!SerialOnly.IsMatch(outside) || row.Descendants<Wp.VerticalMerge>().Any()) continue;
            WordStructure.Remove(row);
            removed += 1;
        }
        return removed;
    }

    static string? FieldId(Wp.SdtElement control)
    {
        var tag = control.GetFirstChild<Wp.SdtProperties>()?.GetFirstChild<Wp.Tag>()?.Val?.Value ?? "";
        return tag.StartsWith(TemplateFieldSdtWriter.TagPrefix, StringComparison.Ordinal) ? tag[TemplateFieldSdtWriter.TagPrefix.Length..] : null;
    }
}
