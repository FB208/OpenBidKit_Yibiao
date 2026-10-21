using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

namespace Yibiao.OpenXmlHelper.BlindCheck.Fix;

sealed class FixValidationResult
{
    public bool Checked { get; init; }
    public string SkippedReason { get; init; } = "";
    public int OriginalErrors { get; init; }
    public int FixedErrors { get; init; }
    public List<string> NewErrors { get; init; } = [];
}

/// <summary>
/// 用 Open XML SDK 分别校验原文件和修复副本，按"错误类型 + part + 元素"对比。
/// WPS 生成的文档本身常有不规范之处，只有副本多出原文件没有的错误才算修复引入的问题。
/// </summary>
static class FixValidation
{
    public static FixValidationResult Compare(string originalPath, string fixedPath)
    {
        Dictionary<string, (int Count, string Description)> before;
        try
        {
            before = Collect(originalPath);
        }
        catch (Exception exception) when (exception is OpenXmlPackageException or InvalidDataException or IOException or InvalidOperationException or System.Xml.XmlException)
        {
            return new FixValidationResult { SkippedReason = $"原文件无法用 Open XML SDK 打开（{exception.Message}），已跳过结构校验" };
        }

        Dictionary<string, (int Count, string Description)> after;
        try
        {
            after = Collect(fixedPath);
        }
        catch (Exception exception) when (exception is OpenXmlPackageException or InvalidDataException or IOException or InvalidOperationException or System.Xml.XmlException)
        {
            return new FixValidationResult { Checked = true, NewErrors = [$"修复副本无法用 Open XML SDK 打开：{exception.Message}"] };
        }

        var added = after
            .Where(item => item.Value.Count > (before.TryGetValue(item.Key, out var original) ? original.Count : 0))
            .Select(item => item.Value.Description)
            .Distinct()
            .ToList();
        return new FixValidationResult
        {
            Checked = true,
            OriginalErrors = before.Values.Sum(item => item.Count),
            FixedErrors = after.Values.Sum(item => item.Count),
            NewErrors = added,
        };
    }

    static Dictionary<string, (int Count, string Description)> Collect(string path)
    {
        var result = new Dictionary<string, (int Count, string Description)>(StringComparer.Ordinal);
        using var document = WordprocessingDocument.Open(path, false);
        // MaxNumberOfErrors = 0 表示不限条数，原文件错误很多时也能逐类对比。
        var validator = new OpenXmlValidator(FileFormatVersions.Microsoft365) { MaxNumberOfErrors = 0 };
        foreach (var error in validator.Validate(document))
        {
            var key = $"{error.Id}|{error.Part?.Uri}|{error.Node?.LocalName}";
            result[key] = result.TryGetValue(key, out var existing) ? (existing.Count + 1, existing.Description) : (1, error.Description ?? error.Id ?? "未知错误");
        }

        return result;
    }
}
