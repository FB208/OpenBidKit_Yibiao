using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Ooxml;

/// <summary>
/// R3 引用完整性：删除部件或关系前，先处理部件根元素里指向它的引用。
/// 超链接去壳保留文字；图片、对象、图表等删除承载它的 w:drawing / w:pict / w:object；页眉页脚引用等其他元素直接删除。
/// 引用只会出现在关系所属部件的根元素里；处理时同样经过 R1、R4。
/// </summary>
static class ReferenceIntegrity
{
    const string RelationshipNamespace = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const string VmlOfficeNamespace = "urn:schemas-microsoft-com:office:office";

    public static void DeletePart(OpenXmlPartContainer container, OpenXmlPart part)
    {
        RemoveReferences(container, container.GetIdOfPart(part));
        container.DeletePart(part);
    }

    public static void DeleteRelationship(OpenXmlPartContainer container, string id)
    {
        // IdPartPair 是结构体，找不到时得到的默认值部件为 null。
        if (container.Parts.FirstOrDefault(pair => pair.RelationshipId == id).OpenXmlPart is { } part)
        {
            DeletePart(container, part);
            return;
        }
        RemoveReferences(container, id);
        if (container.HyperlinkRelationships.Any(item => item.Id == id)
            || container.ExternalRelationships.Any(item => item.Id == id)
            || container.DataPartReferenceRelationships.Any(item => item.Id == id))
        {
            container.DeleteReferenceRelationship(id);
        }
    }

    static void RemoveReferences(OpenXmlPartContainer container, string id)
    {
        if (container is not OpenXmlPart { RootElement: { } root }) return;
        var referencing = root.Descendants()
            .Where(element => element.GetAttributes().Any(attribute =>
                (attribute.NamespaceUri == RelationshipNamespace || attribute.NamespaceUri == VmlOfficeNamespace && attribute.LocalName == "relid")
                && attribute.Value == id))
            .ToList();
        var unwrap = new List<OpenXmlElement>();
        var remove = new List<OpenXmlElement>();
        foreach (var element in referencing)
        {
            if (element is Wp.Hyperlink) unwrap.Add(element);
            else remove.Add(element.Ancestors().LastOrDefault(item => item is Wp.Drawing or Wp.Picture or Wp.EmbeddedObject) ?? element);
        }
        foreach (var element in unwrap) WordStructure.Unwrap(element);
        WordStructure.RemoveRange(remove.Distinct());
    }
}
