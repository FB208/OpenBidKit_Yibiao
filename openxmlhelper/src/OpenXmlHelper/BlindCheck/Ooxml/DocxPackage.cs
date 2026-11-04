using System.Text;
using System.Xml;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using Yibiao.OpenXmlHelper.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

sealed record PackageRelationship(string Id, string Type, string Target, bool External);

/// <summary>
/// 一个 XML 部件：部件名（与 zip 条目名一致，如 word/document.xml）、SDK 部件和根元素。
/// 有强类型根元素的部件直接用 SDK 的根元素；没有的（如 docProps/core.xml）按原文解析成未知元素树。
/// </summary>
sealed class PartXml(string name, OpenXmlPart part, OpenXmlElement root)
{
    static readonly XmlWriterSettings WriterSettings = new() { Encoding = new UTF8Encoding(false), Indent = false };

    public string Name => name;
    public OpenXmlPart Part => part;
    public OpenXmlElement Root => root;

    /// <summary>根元素及其全部后代（对应 XDocument.Descendants）。</summary>
    public IEnumerable<OpenXmlElement> Descendants() => root.DescendantsAndSelf();

    public IEnumerable<OpenXmlElement> Descendants(WName name) => root.DescendantsAndSelf(name);

    /// <summary>把根元素写回部件；只对改过的部件调用，未改动的部件保持原字节。</summary>
    public void Save()
    {
        if (root is OpenXmlPartRootElement typed)
        {
            typed.Save();
            return;
        }

        using var stream = part.GetStream(FileMode.Create, FileAccess.Write);
        using var writer = XmlWriter.Create(stream, WriterSettings);
        writer.WriteStartDocument(true);
        root.WriteTo(writer);
    }
}

/// <summary>
/// 用 OpenXML SDK 打开 docx 包。检查、导出只读打开；修复、编辑在副本上读写打开（AutoSave=false），
/// 只有调用了 <see cref="PartXml.Save"/> 的部件会重新序列化，其余部件保持原字节。
/// 部件按 zip 条目名定位，模型、定位编号和结果里的 part 字段都用这个名称。
/// </summary>
sealed class DocxPackage : IDisposable
{
    const string UnreadableMessage = "无法读取文档：文件不是有效的 .docx，可能已加密、损坏或是 .doc 改了扩展名，请在 Word / WPS 中另存为 .docx 后重试";

    readonly WordprocessingDocument _document;
    readonly Dictionary<string, OpenXmlPart> _parts = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<string, PartXml> _loaded = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<string, IReadOnlyList<PackageRelationship>> _relationships = new(StringComparer.OrdinalIgnoreCase);

    public string DocumentPart { get; }

    public WordprocessingDocument Document => _document;

    DocxPackage(WordprocessingDocument document)
    {
        _document = document;
        IndexParts();
        DocumentPart = document.MainDocumentPart is { } main ? NameOf(main) : "word/document.xml";
    }

    void IndexParts()
    {
        _parts.Clear();
        foreach (var part in _document.GetAllParts()) _parts.TryAdd(NameOf(part), part);
    }

    public static DocxPackage Open(string path, bool writable = false)
    {
        try
        {
            return new DocxPackage(WordprocessingDocument.Open(path, writable, new OpenSettings { AutoSave = false }));
        }
        catch (Exception exception) when (exception is OpenXmlPackageException or FileFormatException or InvalidDataException)
        {
            throw new InvalidOperationException(UnreadableMessage);
        }
    }

    /// <summary>SDK 部件的名称，与 zip 条目名逐字一致（不带开头的 /）。</summary>
    public static string NameOf(OpenXmlPart part) => part.Uri.OriginalString.TrimStart('/');

    public bool Has(string name) => _parts.ContainsKey(name);

    public OpenXmlPart? Part(string name) => _parts.GetValueOrDefault(name);

    /// <summary>关系的源：空字符串表示包本身，否则是该名称的部件。</summary>
    public OpenXmlPartContainer? Container(string name) => name.Length == 0 ? _document : Part(name);

    /// <summary>读取 part 的原始字节；不存在时返回 null。</summary>
    public byte[]? ReadBytes(string name)
    {
        if (Part(name) is not { } part) return null;
        using var stream = part.GetStream(FileMode.Open, FileAccess.Read);
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }

    /// <summary>替换 part 的字节（如去掉元数据后的图片）。</summary>
    public void SetBytes(string name, byte[] data)
    {
        if (Part(name) is not { } part) return;
        using var stream = new MemoryStream(data, writable: false);
        part.FeedData(stream);
    }

    /// <summary>读取 XML 部件；不存在时返回 null。同一部件只解析一次，修改直接作用在返回的元素树上。</summary>
    public PartXml? Load(string name)
    {
        if (_loaded.TryGetValue(name, out var cached)) return cached;
        if (Part(name) is not { } part) return null;
        var xml = new PartXml(name, part, part.RootElement ?? W.LoadUntyped(part));
        _loaded[name] = xml;
        return xml;
    }

    /// <summary>可选 part 解析失败时按缺失处理，单个附属 part 损坏不阻断整份检查。</summary>
    public PartXml? TryLoad(string name)
    {
        try
        {
            return Load(name);
        }
        catch (Exception exception) when (exception is XmlException or InvalidDataException or OpenXmlPackageException)
        {
            return null;
        }
    }

    /// <summary>part 的关系；part 为空字符串表示包根关系。部件关系在前（按关系文件顺序），外部关系、超链接、数据部件引用在后。</summary>
    public IReadOnlyList<PackageRelationship> Relationships(string part)
    {
        if (_relationships.TryGetValue(part, out var cached)) return cached;
        var list = new List<PackageRelationship>();
        if (Container(part) is { } container)
        {
            foreach (var pair in container.Parts)
            {
                list.Add(new PackageRelationship(pair.RelationshipId, pair.OpenXmlPart.RelationshipType, "/" + NameOf(pair.OpenXmlPart), false));
            }

            foreach (var item in container.ExternalRelationships) list.Add(new PackageRelationship(item.Id, item.RelationshipType, item.Uri.OriginalString, item.IsExternal));
            foreach (var item in container.HyperlinkRelationships) list.Add(new PackageRelationship(item.Id, item.RelationshipType, item.Uri.OriginalString, item.IsExternal));
            foreach (var item in container.DataPartReferenceRelationships)
            {
                list.Add(new PackageRelationship(item.Id, item.RelationshipType, "/" + item.DataPart.Uri.OriginalString.TrimStart('/'), false));
            }
        }

        _relationships[part] = list;
        return list;
    }

    /// <summary>删除 part 的一条关系，经结构层先处理指向它的引用；内部部件不再被引用时随之删除。</summary>
    public void DeleteRelationship(string part, string id)
    {
        if (Container(part) is not { } container) return;
        WordStructure.DeleteRelationship(container, id);
        _relationships.Remove(part);
        IndexParts();
    }

    /// <summary>按关系类型后缀查找内部 part，例如 "/styles"。</summary>
    public IEnumerable<string> RelatedParts(string part, string typeSuffix)
    {
        return Relationships(part)
            .Where(item => !item.External && item.Type.EndsWith(typeSuffix, StringComparison.Ordinal))
            .Select(item => ResolveTarget(part, item.Target))
            .Where(Has);
    }

    public string? RelatedPart(string part, string typeSuffix, string fallback)
    {
        var found = RelatedParts(part, typeSuffix).FirstOrDefault();
        if (found is not null) return found;
        return Has(fallback) ? fallback : null;
    }

    public static string ResolveTarget(string sourcePart, string target)
    {
        var value = (target ?? "").Replace('\\', '/');
        if (value.StartsWith('/')) return Normalize(value.TrimStart('/'));
        var slash = sourcePart.LastIndexOf('/');
        var directory = slash >= 0 ? sourcePart[..slash] : "";
        return Normalize(directory.Length > 0 ? directory + "/" + value : value);
    }

    static string Normalize(string path)
    {
        var stack = new List<string>();
        foreach (var segment in path.Split('/'))
        {
            if (segment.Length == 0 || segment == ".") continue;
            if (segment == "..")
            {
                if (stack.Count > 0) stack.RemoveAt(stack.Count - 1);
                continue;
            }

            stack.Add(segment);
        }

        return string.Join('/', stack);
    }

    public void Dispose() => _document.Dispose();
}
