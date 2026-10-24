using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>跨文档复制正文块时共用的样式引用、编号和关系迁移；抽章与整本导出并入商务模版共用。</summary>
static class CrossDocumentImport
{
    const string RelationshipNamespace = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

    /** 保留基准文档已有样式；找不到对应样式时移除外部样式引用并保留直接格式。 */
    internal static void NormalizeStyleReferences(OpenXmlElement cloned, Dictionary<string, string?> styleIds)
    {
        foreach (var style in cloned.Descendants<Wp.ParagraphStyleId>().ToList())
        {
            ApplyStyleMap(style.Val?.Value, styleIds, value => style.Val = value, style.Remove);
        }
        foreach (var style in cloned.Descendants<Wp.RunStyle>().ToList())
        {
            ApplyStyleMap(style.Val?.Value, styleIds, value => style.Val = value, style.Remove);
        }
        foreach (var style in cloned.Descendants<Wp.TableStyle>().ToList())
        {
            ApplyStyleMap(style.Val?.Value, styleIds, value => style.Val = value, style.Remove);
        }
        foreach (var style in cloned.Descendants<Wp.StyleLink>().ToList())
        {
            ApplyStyleMap(style.Val?.Value, styleIds, value => style.Val = value, style.Remove);
        }
        foreach (var style in cloned.Descendants<Wp.NumberingStyleLink>().ToList())
        {
            ApplyStyleMap(style.Val?.Value, styleIds, value => style.Val = value, style.Remove);
        }
    }

    internal static void ApplyStyleMap(
        string? sourceId,
        Dictionary<string, string?> styleIds,
        Action<string> apply,
        Action remove)
    {
        if (!string.IsNullOrWhiteSpace(sourceId)
            && styleIds.TryGetValue(sourceId, out var targetId)
            && !string.IsNullOrWhiteSpace(targetId))
        {
            apply(targetId);
            return;
        }
        remove();
    }

    /** 为跨文档段落复制独立编号定义，避免 numId 误指向基准文档中的其他列表。 */
    internal static void RemapNumbering(
        OpenXmlElement cloned,
        MainDocumentPart sourcePart,
        MainDocumentPart destPart,
        CrossDocumentImportContext context)
    {
        foreach (var properties in cloned.Descendants<Wp.NumberingProperties>().ToList())
        {
            var sourceNumberId = properties.NumberingId?.Val?.Value;
            // numId=0 表示取消样式带来的编号，原样保留。
            if (sourceNumberId is null or 0) continue;
            var targetNumberId = ImportNumbering(sourceNumberId.Value, sourcePart, destPart, context);
            if (targetNumberId is null)
            {
                properties.Remove();
                continue;
            }
            properties.NumberingId!.Val = targetNumberId.Value;
        }
    }

    internal static int? ImportNumbering(
        int sourceNumberId,
        MainDocumentPart sourcePart,
        MainDocumentPart destPart,
        CrossDocumentImportContext context)
    {
        if (context.NumberingIds.TryGetValue(sourceNumberId, out var cached)) return cached;
        var sourceNumberingPart = sourcePart.NumberingDefinitionsPart;
        var sourceNumbering = sourceNumberingPart?.Numbering;
        if (sourceNumberingPart is null || sourceNumbering is null) return null;
        var sourceInstance = sourceNumbering.Elements<Wp.NumberingInstance>()
            .FirstOrDefault(item => item.NumberID?.Value == sourceNumberId);
        var sourceAbstractId = sourceInstance?.AbstractNumId?.Val?.Value;
        if (sourceInstance is null || sourceAbstractId is null) return null;
        var sourceAbstract = sourceNumbering.Elements<Wp.AbstractNum>()
            .FirstOrDefault(item => item.AbstractNumberId?.Value == sourceAbstractId.Value);
        if (sourceAbstract is null) return null;

        var destNumberingPart = destPart.NumberingDefinitionsPart ?? destPart.AddNewPart<NumberingDefinitionsPart>();
        destNumberingPart.Numbering ??= new Wp.Numbering();
        var destNumbering = destNumberingPart.Numbering;
        var targetAbstractId = destNumbering.Elements<Wp.AbstractNum>()
            .Select(item => item.AbstractNumberId?.Value ?? -1)
            .DefaultIfEmpty(-1)
            .Max() + 1;
        var targetNumberId = destNumbering.Elements<Wp.NumberingInstance>()
            .Select(item => item.NumberID?.Value ?? 0)
            .DefaultIfEmpty(0)
            .Max() + 1;

        var copiedAbstract = (Wp.AbstractNum)sourceAbstract.CloneNode(true);
        copiedAbstract.AbstractNumberId = targetAbstractId;
        NormalizeStyleReferences(copiedAbstract, context.StyleIds);
        RemapPictureBullets(copiedAbstract, sourceNumberingPart, destNumberingPart, context);
        var firstInstance = destNumbering.Elements<Wp.NumberingInstance>().FirstOrDefault();
        if (firstInstance is null) destNumbering.AppendChild(copiedAbstract);
        else destNumbering.InsertBefore(copiedAbstract, firstInstance);

        var copiedInstance = (Wp.NumberingInstance)sourceInstance.CloneNode(true);
        copiedInstance.NumberID = targetNumberId;
        copiedInstance.AbstractNumId ??= new Wp.AbstractNumId();
        copiedInstance.AbstractNumId.Val = targetAbstractId;
        destNumbering.AppendChild(copiedInstance);
        destNumbering.Save();
        context.NumberingIds[sourceNumberId] = targetNumberId;
        return targetNumberId;
    }

    internal static void RemapPictureBullets(
        Wp.AbstractNum abstractNum,
        NumberingDefinitionsPart sourcePart,
        NumberingDefinitionsPart destPart,
        CrossDocumentImportContext context)
    {
        foreach (var reference in abstractNum.Descendants<Wp.LevelPictureBulletId>().ToList())
        {
            var sourceId = reference.Val?.Value;
            if (sourceId is null) continue;
            var targetId = ImportPictureBullet(sourceId.Value, sourcePart, destPart, context);
            if (targetId is null) reference.Remove();
            else reference.Val = targetId.Value;
        }
    }

    internal static int? ImportPictureBullet(
        int sourceId,
        NumberingDefinitionsPart sourcePart,
        NumberingDefinitionsPart destPart,
        CrossDocumentImportContext context)
    {
        if (context.PictureBulletIds.TryGetValue(sourceId, out var cached)) return cached;
        var sourceBullet = sourcePart.Numbering?.Elements<Wp.NumberingPictureBullet>()
            .FirstOrDefault(item => item.NumberingPictureBulletId?.Value == sourceId);
        if (sourceBullet is null || destPart.Numbering is null) return null;
        var targetId = destPart.Numbering.Elements<Wp.NumberingPictureBullet>()
            .Select(item => item.NumberingPictureBulletId?.Value ?? -1)
            .DefaultIfEmpty(-1)
            .Max() + 1;
        var copied = (Wp.NumberingPictureBullet)sourceBullet.CloneNode(true);
        copied.NumberingPictureBulletId = targetId;
        RemapRelationships(copied, sourcePart, destPart, context.RelationshipIds);
        var firstAbstract = destPart.Numbering.Elements<Wp.AbstractNum>().FirstOrDefault();
        if (firstAbstract is null) destPart.Numbering.PrependChild(copied);
        else destPart.Numbering.InsertBefore(copied, firstAbstract);
        context.PictureBulletIds[sourceId] = targetId;
        return targetId;
    }

    /** 复制图片、超链接、图表和嵌入对象等关系，并改写克隆内容中的 r:id。 */
    internal static void RemapRelationships(
        OpenXmlElement cloned,
        OpenXmlPart sourcePart,
        OpenXmlPart destPart,
        Dictionary<string, string> relationshipIds)
    {
        foreach (var element in SelfAndDescendants(cloned))
        {
            foreach (var attribute in element.GetAttributes().ToList())
            {
                if (attribute.NamespaceUri != RelationshipNamespace || string.IsNullOrWhiteSpace(attribute.Value)) continue;
                var cacheKey = $"{sourcePart.Uri}\u0000{attribute.Value}";
                if (!relationshipIds.TryGetValue(cacheKey, out var targetId))
                {
                    targetId = CopyRelationship(sourcePart, destPart, attribute.Value);
                    relationshipIds[cacheKey] = targetId;
                }
                element.SetAttribute(new OpenXmlAttribute(
                    attribute.Prefix,
                    attribute.LocalName,
                    attribute.NamespaceUri,
                    targetId));
            }
        }
    }

    internal static string CopyRelationship(OpenXmlPart sourcePart, OpenXmlPart destPart, string relationshipId)
    {
        var hyperlink = sourcePart.HyperlinkRelationships.FirstOrDefault(item => item.Id == relationshipId);
        if (hyperlink is not null)
        {
            return destPart.AddHyperlinkRelationship(hyperlink.Uri, hyperlink.IsExternal).Id;
        }

        var external = sourcePart.ExternalRelationships.FirstOrDefault(item => item.Id == relationshipId);
        if (external is not null)
        {
            return destPart.AddExternalRelationship(external.RelationshipType, external.Uri).Id;
        }

        var relatedPart = sourcePart.Parts
            .Where(item => item.RelationshipId == relationshipId)
            .Select(item => item.OpenXmlPart)
            .FirstOrDefault();
        if (relatedPart is null)
        {
            throw new InvalidOperationException($"无法解析跨文档关系：{relationshipId}");
        }

        try
        {
            var copied = destPart.AddPart(relatedPart);
            return destPart.GetIdOfPart(copied);
        }
        catch (Exception exception)
        {
            throw new InvalidOperationException($"无法迁移跨文档关系：{relationshipId}", exception);
        }
    }

    internal static IEnumerable<OpenXmlElement> SelfAndDescendants(OpenXmlElement element)
    {
        yield return element;
        foreach (var descendant in element.Descendants()) yield return descendant;
    }
}

sealed class CrossDocumentImportContext(Dictionary<string, string?> styleIds)
{
    public Dictionary<string, string?> StyleIds { get; } = styleIds;
    public Dictionary<int, int> NumberingIds { get; } = [];
    public Dictionary<int, int> PictureBulletIds { get; } = [];
    public Dictionary<string, string> RelationshipIds { get; } = new(StringComparer.Ordinal);
}
