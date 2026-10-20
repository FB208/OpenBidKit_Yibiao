using System.Xml.Linq;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Model;

/// <summary>文档里一张图片（按 media part 去重）的格式、尺寸、首次出现位置，以及元数据和矢量图中的文字。</summary>
sealed class ImageInfo
{
    public required string Part { get; init; }
    public string Format { get; set; } = "未知";
    public int? Width { get; set; }
    public int? Height { get; set; }
    public bool IsVector { get; set; }
    public long Bytes { get; set; }
    public int Uses { get; set; }
    /// <summary>首次出现的段落；图片挂在图形对象等非段落位置时为 null。</summary>
    public ParaRecord? FirstRecord { get; set; }
    public string FirstSourcePart { get; set; } = "";
    /// <summary>作者、版权、描述等可能包含身份信息的元数据字段。</summary>
    public List<(string Label, string Value)> Metadata { get; } = [];
    public bool HasGps { get; set; }
    /// <summary>矢量图（EMF/WMF/SVG）中可提取的文字，按记录顺序拼接。</summary>
    public string VectorText { get; set; } = "";

    public string FileName => Part[(Part.LastIndexOf('/') + 1)..];

    public string Describe()
    {
        var size = Width is { } w && Height is { } h ? $"，{w}×{h}" : "";
        return $"{FileName}（{Format}{size}）";
    }
}

/// <summary>收集正文、页眉页脚、脚注尾注里引用的图片：DrawingML 的 r:embed / r:link 与 VML 的 imagedata。</summary>
static class ImageCatalog
{
    const string ImageRelationship = "/image";
    static readonly XName Embed = W.R + "embed";
    static readonly XName Link = W.R + "link";
    static readonly XName Id = W.R + "id";

    public static List<ImageInfo> Collect(DocumentModel model)
    {
        var images = new Dictionary<string, ImageInfo>(StringComparer.OrdinalIgnoreCase);
        foreach (var (part, document) in model.Parts)
        {
            if (part == model.CommentsPart || document.Root is null) continue;
            var targets = model.Package.Relationships(part)
                .Where(item => !item.External && item.Type.EndsWith(ImageRelationship, StringComparison.Ordinal))
                .ToDictionary(item => item.Id, item => DocxPackage.ResolveTarget(part, item.Target), StringComparer.Ordinal);
            if (targets.Count == 0) continue;

            foreach (var element in document.Root.Descendants())
            {
                var id = element.Attribute(Embed)?.Value
                    ?? element.Attribute(Link)?.Value
                    ?? (element.Name.Namespace == W.V ? element.Attribute(Id)?.Value : null);
                if (id is null || !targets.TryGetValue(id, out var target)) continue;
                // 兼容内容的 VML 回退副本与 DrawingML 主副本是同一张图，只计一次。
                if (element.Ancestors(W.McFallback).Any()) continue;
                if (!images.TryGetValue(target, out var info))
                {
                    var paragraph = element.Ancestors(W.P).FirstOrDefault();
                    info = new ImageInfo
                    {
                        Part = target,
                        FirstSourcePart = part,
                        FirstRecord = paragraph is null ? null : model.Records.GetValueOrDefault(paragraph),
                    };
                    images[target] = info;
                }

                info.Uses += 1;
            }
        }

        foreach (var info in images.Values)
        {
            var data = model.Package.ReadBytes(info.Part);
            if (data is null) continue;
            info.Bytes = data.Length;
            ImageFormats.Describe(data, info);
        }

        return images.Values.ToList();
    }
}
