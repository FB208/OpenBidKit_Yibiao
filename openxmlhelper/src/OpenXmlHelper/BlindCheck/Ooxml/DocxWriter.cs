using System.IO.Compression;
using System.Text;
using System.Xml;
using System.Xml.Linq;

namespace Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

/// <summary>
/// 写出修复副本：按原 zip 的条目顺序新建一个包，只有改过的 part 重新序列化或替换字节，
/// 其余条目（图片、嵌入对象、未改动的 XML）按解压后的原内容照抄。
/// </summary>
sealed class DocxWriter(DocxPackage source)
{
    static readonly XmlWriterSettings WriterSettings = new()
    {
        Encoding = new UTF8Encoding(false),
        Indent = false,
        CheckCharacters = false,
        NewLineHandling = NewLineHandling.None,
    };

    readonly Dictionary<string, XDocument> _xml = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<string, byte[]> _binary = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<string, XDocument> _relationships = new(StringComparer.OrdinalIgnoreCase);
    readonly HashSet<string> _removed = new(StringComparer.OrdinalIgnoreCase);

    public int ChangedParts => _xml.Count + _binary.Count + _relationships.Count + _removed.Count;

    public void SetXml(string part, XDocument document) => _xml[part] = document;

    public void SetBytes(string part, byte[] data) => _binary[part] = data;

    /// <summary>从包里去掉不再被任何关系引用的 part（例如清空页眉后残留的单位标志图片）。</summary>
    public void RemovePart(string part) => _removed.Add(part);

    /// <summary>删除 part 的某条关系（例如取消超链接后不再保留链接地址）。</summary>
    public void RemoveRelationship(string part, string id)
    {
        var name = DocxPackage.RelsNameFor(part);
        if (!_relationships.TryGetValue(name, out var document))
        {
            document = source.Load(name);
            if (document is null) return;
            _relationships[name] = document;
        }

        document.Root?.Elements(W.PackageRel + "Relationship")
            .Where(item => item.Attribute("Id")?.Value == id)
            .Remove();
    }

    /// <summary>该关系是否已在本次修复中删除；判断图片等 part 是否仍被引用时要按修复后的关系算。</summary>
    public bool IsRelationshipRemoved(string part, string id)
    {
        return _relationships.TryGetValue(DocxPackage.RelsNameFor(part), out var document)
            && document.Root?.Elements(W.PackageRel + "Relationship").Any(item => item.Attribute("Id")?.Value == id) != true;
    }

    public void Save(string outputPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
        var temp = outputPath + ".tmp";
        using (var stream = File.Create(temp))
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Create))
        {
            foreach (var name in source.EntryNames)
            {
                var key = name.Replace('\\', '/').TrimStart('/');
                if (_removed.Contains(key)) continue;
                var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
                entry.LastWriteTime = source.LastWriteTime(name);
                using var output = entry.Open();
                if (_xml.TryGetValue(key, out var document) || _relationships.TryGetValue(key, out document))
                {
                    using var writer = XmlWriter.Create(output, WriterSettings);
                    document.Save(writer);
                }
                else if (_binary.TryGetValue(key, out var data))
                {
                    output.Write(data);
                }
                else
                {
                    using var input = source.OpenEntry(name);
                    input.CopyTo(output);
                }
            }
        }

        File.Move(temp, outputPath, overwrite: true);
    }
}
