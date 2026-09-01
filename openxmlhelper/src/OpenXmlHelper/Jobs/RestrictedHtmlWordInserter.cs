using System.Text.RegularExpressions;
using AngleSharp.Dom;
using AngleSharp.Html.Parser;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;
using HtmlToOpenXml;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>把受限 HTML 转为 Open XML 块并替换指定块级内容控件。</summary>
static partial class RestrictedHtmlWordInserter
{
    public const string TagPrefix = "yibiao:body:";

    /// <summary>在 Word 文件的指定内容控件中插入受限 HTML，成功后原子替换原文件。</summary>
    public static int Insert(string documentPath, string targetId, string html)
    {
        var normalizedTargetId = (targetId ?? "").Trim();
        if (!TargetIdPattern().IsMatch(normalizedTargetId))
        {
            throw new InvalidOperationException("target_id 不合法");
        }
        if (string.IsNullOrWhiteSpace(html))
        {
            throw new InvalidOperationException("受限 HTML 为空");
        }

        var tempPath = $"{documentPath}.{Guid.NewGuid():N}.tmp.docx";
        try
        {
            File.Copy(documentPath, tempPath, overwrite: true);
            int blockCount;
            using (var document = WordprocessingDocument.Open(tempPath, true))
            {
                var mainPart = document.MainDocumentPart ?? throw new InvalidOperationException("Word 缺少正文部件");
                var tag = $"{TagPrefix}{normalizedTargetId}";
                var targets = mainPart.Document.Descendants<Wp.SdtBlock>()
                    .Where(item => string.Equals(
                        item.SdtProperties?.GetFirstChild<Wp.Tag>()?.Val?.Value,
                        tag,
                        StringComparison.Ordinal))
                    .ToList();
                if (targets.Count != 1)
                {
                    throw new InvalidOperationException(targets.Count == 0
                        ? $"找不到块级内容控件：{tag}"
                        : $"块级内容控件不唯一：{tag}");
                }

                var converter = new HtmlConverter(mainPart);
                var blocks = converter.Parse(PrepareHtml(html));
                var content = targets[0].SdtContentBlock ?? targets[0].AppendChild(new Wp.SdtContentBlock());
                content.RemoveAllChildren();
                foreach (var block in blocks)
                {
                    content.AppendChild(block);
                }
                if (!content.ChildElements.Any()) content.AppendChild(new Wp.Paragraph());
                blockCount = content.ChildElements.Count;
                mainPart.Document.Save();

                var errors = new OpenXmlValidator(FileFormatVersions.Microsoft365).Validate(document).Take(10).ToList();
                if (errors.Count > 0)
                {
                    throw new InvalidOperationException(
                        $"Word Open XML 校验失败：{string.Join("；", errors.Select(item => item.Description))}");
                }
            }

            File.Move(tempPath, documentPath, overwrite: true);
            return blockCount;
        }
        finally
        {
            try { File.Delete(tempPath); } catch { }
        }
    }

    /// <summary>移除本阶段不处理的配图块，其余结构交给 HTML 转换器。</summary>
    static string PrepareHtml(string html)
    {
        var document = new HtmlParser().ParseDocument(html);
        foreach (var figure in document.QuerySelectorAll("figure").ToList()) figure.Remove();
        foreach (var template in document.QuerySelectorAll("template").ToList()) template.Remove();
        foreach (var image in document.QuerySelectorAll("img").ToList()) image.Remove();
        return document.Body?.InnerHtml ?? "";
    }

    [GeneratedRegex("^[A-Za-z][A-Za-z0-9_-]{0,63}$", RegexOptions.CultureInvariant)]
    private static partial Regex TargetIdPattern();
}
