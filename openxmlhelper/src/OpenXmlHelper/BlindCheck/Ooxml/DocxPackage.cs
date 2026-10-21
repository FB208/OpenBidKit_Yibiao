using System.IO.Compression;
using System.Xml;
using System.Xml.Linq;

namespace Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

sealed record PackageRelationship(string Id, string Type, string Target, bool External);

/// <summary>
/// 只读打开 docx 包。直接按 zip 条目和关系文件定位 part，
/// 不经过 SDK 的强类型包装，畸形超链接等关系不会让整份文档打不开。
/// </summary>
sealed class DocxPackage : IDisposable
{
    const string OfficeDocumentType = "/officeDocument";

    static readonly XmlReaderSettings ReaderSettings = new()
    {
        DtdProcessing = DtdProcessing.Ignore,
        XmlResolver = null,
        CheckCharacters = false,
    };

    readonly ZipArchive _zip;
    readonly Dictionary<string, ZipArchiveEntry> _entries;
    readonly Dictionary<string, IReadOnlyList<PackageRelationship>> _relationships = new(StringComparer.OrdinalIgnoreCase);

    public string DocumentPart { get; }

    DocxPackage(ZipArchive zip)
    {
        _zip = zip;
        _entries = new Dictionary<string, ZipArchiveEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in zip.Entries)
        {
            if (entry.FullName.EndsWith('/')) continue;
            _entries[entry.FullName.Replace('\\', '/').TrimStart('/')] = entry;
        }

        DocumentPart = Relationships("")
            .Where(item => item.Type.EndsWith(OfficeDocumentType, StringComparison.Ordinal) && !item.External)
            .Select(item => ResolveTarget("", item.Target))
            .FirstOrDefault(Has)
            ?? "word/document.xml";
    }

    public static DocxPackage Open(string path)
    {
        FileStream? stream = null;
        try
        {
            stream = File.OpenRead(path);
            return new DocxPackage(new ZipArchive(stream, ZipArchiveMode.Read, leaveOpen: false));
        }
        catch (InvalidDataException)
        {
            stream?.Dispose();
            throw new InvalidOperationException("无法读取文档：文件不是有效的 .docx，可能已加密、损坏或是 .doc 改了扩展名，请在 Word / WPS 中另存为 .docx 后重试");
        }
    }

    public bool Has(string name) => _entries.ContainsKey(name);

    /// <summary>按 zip 内原顺序列出全部条目名（不含目录）。</summary>
    public IEnumerable<string> EntryNames => _zip.Entries.Where(entry => !entry.FullName.EndsWith('/')).Select(entry => entry.FullName);

    /// <summary>打开原条目的数据流，用于原样复制未改动的 part。</summary>
    public Stream OpenEntry(string fullName) => _zip.GetEntry(fullName)!.Open();

    public DateTimeOffset LastWriteTime(string fullName) => _zip.GetEntry(fullName)?.LastWriteTime ?? DateTimeOffset.Now;

    public long SizeOf(string name) => _entries.TryGetValue(name, out var entry) ? entry.Length : 0;

    /// <summary>读取 part 的原始字节；不存在时返回 null。</summary>
    public byte[]? ReadBytes(string name)
    {
        if (!_entries.TryGetValue(name, out var entry)) return null;
        using var stream = entry.Open();
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }

    /// <summary>读取 part 的 XML；不存在时返回 null。</summary>
    public XDocument? Load(string name)
    {
        if (!_entries.TryGetValue(name, out var entry)) return null;
        using var stream = entry.Open();
        using var reader = XmlReader.Create(stream, ReaderSettings);
        return XDocument.Load(reader, LoadOptions.PreserveWhitespace);
    }

    /// <summary>可选 part 解析失败时按缺失处理，单个附属 part 损坏不阻断整份检查。</summary>
    public XDocument? TryLoad(string name)
    {
        try
        {
            return Load(name);
        }
        catch (XmlException)
        {
            return null;
        }
    }

    /// <summary>读取 part 的关系；part 为空字符串表示包根关系。</summary>
    public IReadOnlyList<PackageRelationship> Relationships(string part)
    {
        if (_relationships.TryGetValue(part, out var cached)) return cached;
        var list = new List<PackageRelationship>();
        var relsName = RelsNameFor(part);
        var document = TryLoad(relsName);
        if (document?.Root is not null)
        {
            foreach (var element in document.Root.Elements(W.PackageRel + "Relationship"))
            {
                var id = element.Attribute("Id")?.Value ?? "";
                var type = element.Attribute("Type")?.Value ?? "";
                var target = element.Attribute("Target")?.Value ?? "";
                var external = string.Equals(element.Attribute("TargetMode")?.Value, "External", StringComparison.OrdinalIgnoreCase);
                if (id.Length > 0) list.Add(new PackageRelationship(id, type, target, external));
            }
        }

        _relationships[part] = list;
        return list;
    }

    /// <summary>包内全部关系，附带关系所属的源 part（包根关系的源 part 为空字符串）。</summary>
    public IEnumerable<(string SourcePart, PackageRelationship Relationship)> AllRelationships()
    {
        foreach (var name in _entries.Keys.Where(item => item.EndsWith(".rels", StringComparison.OrdinalIgnoreCase)).ToList())
        {
            var slash = name.LastIndexOf("_rels/", StringComparison.Ordinal);
            if (slash < 0) continue;
            var source = name[..slash] + name[(slash + "_rels/".Length)..^".rels".Length];
            foreach (var relationship in Relationships(source)) yield return (source, relationship);
        }
    }

    /// <summary>[Content_Types].xml 里是否为该 part 单独声明了类型；有单独声明的 part 不能直接从包里删掉。</summary>
    public bool HasContentTypeOverride(string part)
    {
        var types = TryLoad("[Content_Types].xml")?.Root;
        return types is not null && types.Elements()
            .Any(item => item.Name.LocalName == "Override" && string.Equals(item.Attribute("PartName")?.Value?.TrimStart('/'), part, StringComparison.OrdinalIgnoreCase));
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

    public static string RelsNameFor(string part)
    {
        if (string.IsNullOrEmpty(part)) return "_rels/.rels";
        var slash = part.LastIndexOf('/');
        return slash >= 0
            ? part[..slash] + "/_rels/" + part[(slash + 1)..] + ".rels"
            : "_rels/" + part + ".rels";
    }

    public void Dispose() => _zip.Dispose();
}
