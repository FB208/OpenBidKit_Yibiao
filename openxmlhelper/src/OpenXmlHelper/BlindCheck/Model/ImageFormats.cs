using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace Yibiao.OpenXmlHelper.BlindCheck.Model;

/// <summary>
/// 按文件头识别图片格式与尺寸，并提取暗标关心的两类隐藏信息：
/// 位图元数据（EXIF / XMP / PNG 文本块里的作者、版权等）和矢量图（EMF / WMF / SVG）里的文字。
/// 只读取结构，不解码像素；任何字段解析失败都按"没有该信息"处理。
/// </summary>
static class ImageFormats
{
    static readonly Lazy<Encoding> Gbk = new(() =>
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        return Encoding.GetEncoding(936);
    });

    static readonly UTF8Encoding StrictUtf8 = new(false, true);

    static readonly Dictionary<ushort, string> ExifTextTags = new()
    {
        [0x010E] = "描述",
        [0x013B] = "作者",
        [0x8298] = "版权",
    };

    static readonly Dictionary<ushort, string> ExifWindowsTags = new()
    {
        [0x9C9B] = "标题",
        [0x9C9C] = "备注",
        [0x9C9D] = "作者",
        [0x9C9F] = "主题",
    };

    static readonly Dictionary<string, string> PngTextKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Author"] = "作者",
        ["Copyright"] = "版权",
        ["Description"] = "描述",
        ["Comment"] = "备注",
        ["Title"] = "标题",
        ["Source"] = "来源",
        ["Disclaimer"] = "声明",
    };

    static readonly (string Tag, string Label)[] XmpTags =
    [
        ("dc:creator", "作者"),
        ("dc:rights", "版权"),
        ("dc:title", "标题"),
        ("dc:description", "描述"),
    ];

    public static void Describe(byte[] data, ImageInfo info)
    {
        try
        {
            if (StartsWith(data, 0x89, 0x50, 0x4E, 0x47)) ReadPng(data, info);
            else if (StartsWith(data, 0xFF, 0xD8)) ReadJpeg(data, info);
            else if (StartsWith(data, 0x47, 0x49, 0x46)) ReadGif(data, info);
            else if (StartsWith(data, 0x42, 0x4D)) ReadBmp(data, info);
            else if (StartsWith(data, 0x49, 0x49, 0x2A, 0x00) || StartsWith(data, 0x4D, 0x4D, 0x00, 0x2A)) ReadTiff(data, info);
            else if (data.Length > 44 && U32(data, 0) == 1 && data[40] == 0x20 && data[41] == 0x45 && data[42] == 0x4D && data[43] == 0x46) ReadEmf(data, info);
            else if (IsWmf(data)) ReadWmf(data, info);
            else if (StartsWith(data, 0x52, 0x49, 0x46, 0x46) && data.Length > 12 && Encoding.ASCII.GetString(data, 8, 4) == "WEBP") info.Format = "WebP";
            else if (LooksLikeSvg(data)) ReadSvg(data, info);
        }
        catch (Exception exception) when (exception is IndexOutOfRangeException or ArgumentException or InvalidDataException or XmlException)
        {
            // 结构损坏的图片只保留已读出的信息。
        }
    }

    static bool StartsWith(byte[] data, params byte[] prefix)
    {
        if (data.Length < prefix.Length) return false;
        for (var index = 0; index < prefix.Length; index += 1)
        {
            if (data[index] != prefix[index]) return false;
        }

        return true;
    }

    static ushort U16(byte[] data, int offset, bool bigEndian = false)
    {
        return bigEndian ? (ushort)(data[offset] << 8 | data[offset + 1]) : (ushort)(data[offset] | data[offset + 1] << 8);
    }

    static uint U32(byte[] data, int offset, bool bigEndian = false)
    {
        return bigEndian
            ? (uint)(data[offset] << 24 | data[offset + 1] << 16 | data[offset + 2] << 8 | data[offset + 3])
            : (uint)(data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16 | data[offset + 3] << 24);
    }

    /// <summary>元数据文本可能是 UTF-8，也可能是本地 GBK 编码，先按 UTF-8 严格解码，失败再用 GBK。</summary>
    static string DecodeText(byte[] data, int offset, int length)
    {
        if (length <= 0 || offset < 0 || offset + length > data.Length) return "";
        try
        {
            return StrictUtf8.GetString(data, offset, length).Trim('\0', ' ');
        }
        catch (DecoderFallbackException)
        {
            return Gbk.Value.GetString(data, offset, length).Trim('\0', ' ');
        }
    }

    static void AddMetadata(ImageInfo info, string label, string value)
    {
        var text = Regex.Replace(value ?? "", @"[\x00-\x1F]+", " ").Trim();
        if (text.Length == 0 || info.Metadata.Any(item => item.Label == label && item.Value == text)) return;
        info.Metadata.Add((label, text.Length > 200 ? text[..200] : text));
    }

    static void ReadPng(byte[] data, ImageInfo info)
    {
        info.Format = "PNG";
        info.Width = (int)U32(data, 16, true);
        info.Height = (int)U32(data, 20, true);
        var offset = 8;
        while (offset + 12 <= data.Length)
        {
            var length = (int)U32(data, offset, true);
            var type = Encoding.ASCII.GetString(data, offset + 4, 4);
            var start = offset + 8;
            if (length < 0 || start + length > data.Length) break;
            if (type is "tEXt" or "zTXt" or "iTXt") ReadPngText(data, start, length, type, info);
            // eXIf 块的内容就是 TIFF 结构的 EXIF，与 JPEG APP1 去掉 Exif 标识头后相同。
            if (type == "eXIf") ReadTiffMetadata(data, start, start + length, info);
            if (type == "IEND") break;
            offset = start + length + 4;
        }
    }

    static void ReadPngText(byte[] data, int start, int length, string type, ImageInfo info)
    {
        var end = start + length;
        var keywordEnd = Array.IndexOf(data, (byte)0, start, length);
        if (keywordEnd < 0) return;
        var keyword = Encoding.Latin1.GetString(data, start, keywordEnd - start);
        string text;
        if (type == "tEXt")
        {
            text = DecodeText(data, keywordEnd + 1, end - keywordEnd - 1);
        }
        else if (type == "zTXt")
        {
            text = Inflate(data, keywordEnd + 2, end - keywordEnd - 2);
        }
        else
        {
            // iTXt：关键字\0 压缩标志 压缩方法 语言\0 译名\0 正文（UTF-8）
            var compressed = data[keywordEnd + 1] == 1;
            var languageEnd = Array.IndexOf(data, (byte)0, keywordEnd + 3, end - keywordEnd - 3);
            if (languageEnd < 0) return;
            var translatedEnd = Array.IndexOf(data, (byte)0, languageEnd + 1, end - languageEnd - 1);
            if (translatedEnd < 0) return;
            text = compressed ? Inflate(data, translatedEnd + 1, end - translatedEnd - 1) : DecodeText(data, translatedEnd + 1, end - translatedEnd - 1);
        }

        if (keyword.StartsWith("XML:com.adobe.xmp", StringComparison.OrdinalIgnoreCase)) ReadXmp(text, info);
        else if (PngTextKeys.TryGetValue(keyword, out var label)) AddMetadata(info, label, text);
    }

    static string Inflate(byte[] data, int offset, int length)
    {
        if (length <= 0) return "";
        using var input = new MemoryStream(data, offset, length);
        using var zlib = new ZLibStream(input, CompressionMode.Decompress);
        using var reader = new StreamReader(zlib, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    static void ReadJpeg(byte[] data, ImageInfo info)
    {
        info.Format = "JPEG";
        var offset = 2;
        while (offset + 4 <= data.Length)
        {
            if (data[offset] != 0xFF)
            {
                offset += 1;
                continue;
            }

            var marker = data[offset + 1];
            if (marker == 0xD8 || marker == 0x01 || marker is >= 0xD0 and <= 0xD7)
            {
                offset += 2;
                continue;
            }

            if (marker == 0xDA || marker == 0xD9) break;
            var length = U16(data, offset + 2, true);
            var start = offset + 4;
            var segmentLength = length - 2;
            if (segmentLength < 0 || start + segmentLength > data.Length) break;
            if (marker == 0xE1 && segmentLength > 6 && Encoding.ASCII.GetString(data, start, 6) == "Exif\0\0")
            {
                ReadTiffMetadata(data, start + 6, start + segmentLength, info);
            }
            else if (marker == 0xE1 && segmentLength > 29 && Encoding.ASCII.GetString(data, start, 28) == "http://ns.adobe.com/xap/1.0/")
            {
                ReadXmp(DecodeText(data, start + 29, segmentLength - 29), info);
            }
            else if (marker is >= 0xC0 and <= 0xCF && marker is not (0xC4 or 0xC8 or 0xCC) && segmentLength >= 5)
            {
                info.Height = U16(data, start + 1, true);
                info.Width = U16(data, start + 3, true);
            }

            offset = start + segmentLength;
        }
    }

    static void ReadTiff(byte[] data, ImageInfo info)
    {
        info.Format = "TIFF";
        ReadTiffMetadata(data, 0, data.Length, info);
    }

    /// <summary>解析 TIFF 结构的 IFD0（JPEG 的 EXIF 也是这个结构），偏移相对 TIFF 头。</summary>
    static void ReadTiffMetadata(byte[] data, int tiffStart, int limit, ImageInfo info)
    {
        if (tiffStart + 8 > limit) return;
        var bigEndian = data[tiffStart] == 0x4D;
        var ifd = tiffStart + (int)U32(data, tiffStart + 4, bigEndian);
        if (ifd + 2 > limit) return;
        var count = U16(data, ifd, bigEndian);
        for (var index = 0; index < count; index += 1)
        {
            var entry = ifd + 2 + index * 12;
            if (entry + 12 > limit) break;
            var tag = U16(data, entry, bigEndian);
            var type = U16(data, entry + 2, bigEndian);
            var valueCount = (int)U32(data, entry + 4, bigEndian);
            if (tag == 0x8825)
            {
                info.HasGps = HasGpsCoordinates(data, tiffStart, tiffStart + (int)U32(data, entry + 8, bigEndian), limit, bigEndian);
                continue;
            }

            var isText = ExifTextTags.TryGetValue(tag, out var label);
            var isWindows = ExifWindowsTags.TryGetValue(tag, out var windowsLabel);
            if (!isText && !isWindows) continue;
            var unit = type is 1 or 2 or 7 ? 1 : 0;
            if (unit == 0 || valueCount <= 0) continue;
            var valueOffset = valueCount <= 4 ? entry + 8 : tiffStart + (int)U32(data, entry + 8, bigEndian);
            if (valueOffset < 0 || valueOffset + valueCount > limit) continue;
            if (isText) AddMetadata(info, label!, DecodeText(data, valueOffset, valueCount));
            else AddMetadata(info, windowsLabel!, Encoding.Unicode.GetString(data, valueOffset, valueCount - valueCount % 2).Trim('\0', ' '));
        }
    }

    static bool HasGpsCoordinates(byte[] data, int tiffStart, int ifd, int limit, bool bigEndian)
    {
        if (ifd + 2 > limit) return false;
        var count = U16(data, ifd, bigEndian);
        for (var index = 0; index < count; index += 1)
        {
            var entry = ifd + 2 + index * 12;
            if (entry + 12 > limit) break;
            // GPSLatitude（0x0002）存在才算带拍摄位置；只有版本号的 GPS 段不算。
            if (U16(data, entry, bigEndian) == 0x0002) return true;
        }

        return false;
    }

    static void ReadXmp(string xmp, ImageInfo info)
    {
        foreach (var (tag, label) in XmpTags)
        {
            var block = Regex.Match(xmp, $"<{Regex.Escape(tag)}[^>]*>(.*?)</{Regex.Escape(tag)}>", RegexOptions.Singleline);
            if (!block.Success) continue;
            var items = Regex.Matches(block.Groups[1].Value, "<rdf:li[^>]*>([^<]*)</rdf:li>").Select(item => item.Groups[1].Value).ToList();
            var value = items.Count > 0 ? string.Join("；", items) : Regex.Replace(block.Groups[1].Value, "<[^>]+>", "");
            AddMetadata(info, label, System.Net.WebUtility.HtmlDecode(value));
        }
    }

    static void ReadGif(byte[] data, ImageInfo info)
    {
        info.Format = "GIF";
        info.Width = U16(data, 6);
        info.Height = U16(data, 8);
        for (var offset = 13; offset + 2 < data.Length; offset += 1)
        {
            if (data[offset] != 0x21 || data[offset + 1] != 0xFE) continue;
            var builder = new List<byte>();
            var block = offset + 2;
            while (block < data.Length && data[block] != 0)
            {
                var size = data[block];
                if (block + 1 + size > data.Length) break;
                builder.AddRange(data.AsSpan(block + 1, size).ToArray());
                block += 1 + size;
            }

            var bytes = builder.ToArray();
            AddMetadata(info, "备注", DecodeText(bytes, 0, bytes.Length));
            break;
        }
    }

    static void ReadBmp(byte[] data, ImageInfo info)
    {
        info.Format = "BMP";
        if (data.Length < 26) return;
        info.Width = Math.Abs((int)U32(data, 18));
        info.Height = Math.Abs((int)U32(data, 22));
    }

    /// <summary>EMF：EXTTEXTOUTW/A 记录里的文字，以及 EMF+ 注释记录中 DrawString 的文字。</summary>
    static void ReadEmf(byte[] data, ImageInfo info)
    {
        info.Format = "EMF";
        info.IsVector = true;
        var text = new StringBuilder();
        var offset = 0;
        while (offset + 8 <= data.Length)
        {
            var type = U32(data, offset);
            var size = (int)U32(data, offset + 4);
            if (size < 8 || offset + size > data.Length) break;
            if (type is 83 or 84 && size >= 76)
            {
                // 记录头 8 + 边界 16 + 图形模式与缩放 12，之后是 EMRTEXT：参考点 8、字符数 4、字符串偏移 4。
                var emrText = offset + 36;
                var chars = (int)U32(data, emrText + 8);
                var stringOffset = offset + (int)U32(data, emrText + 12);
                if (type == 84 && chars > 0 && stringOffset + chars * 2 <= offset + size)
                {
                    text.Append(Encoding.Unicode.GetString(data, stringOffset, chars * 2));
                }
                else if (type == 83 && chars > 0 && stringOffset + chars <= offset + size)
                {
                    text.Append(Gbk.Value.GetString(data, stringOffset, chars));
                }
            }
            else if (type == 70 && size > 16 && U32(data, offset + 12) == 0x2B464D45)
            {
                ReadEmfPlus(data, offset + 16, offset + 8 + (int)U32(data, offset + 8), text);
            }
            else if (type == 14)
            {
                break;
            }

            offset += size;
        }

        info.VectorText = CleanVectorText(text.ToString());
    }

    static void ReadEmfPlus(byte[] data, int offset, int end, StringBuilder text)
    {
        end = Math.Min(end, data.Length);
        while (offset + 12 <= end)
        {
            var type = U16(data, offset);
            var size = (int)U32(data, offset + 4);
            if (size < 12 || offset + size > end) break;
            // DrawString：画刷 4、格式 4、字符数 4、布局矩形 16，之后是 UTF-16 文本。
            if (type == 0x401C && size >= 40)
            {
                var length = (int)U32(data, offset + 20);
                var start = offset + 40;
                if (length > 0 && start + length * 2 <= offset + size) text.Append(Encoding.Unicode.GetString(data, start, length * 2));
            }

            offset += size;
        }
    }

    static bool IsWmf(byte[] data)
    {
        if (data.Length < 18) return false;
        if (U32(data, 0) == 0x9AC6CDD7) return true;
        var type = U16(data, 0);
        return type is 1 or 2 && U16(data, 2) == 9;
    }

    /// <summary>WMF：TEXTOUT / EXTTEXTOUT 记录里的 ANSI 文字，中文文档按 GBK 解码。</summary>
    static void ReadWmf(byte[] data, ImageInfo info)
    {
        info.Format = "WMF";
        info.IsVector = true;
        var offset = U32(data, 0) == 0x9AC6CDD7 ? 22 : 0;
        offset += U16(data, offset + 2) * 2;
        var text = new StringBuilder();
        while (offset + 6 <= data.Length)
        {
            var words = U32(data, offset);
            var function = U16(data, offset + 4);
            if (words < 3 || offset + words * 2 > data.Length) break;
            var end = offset + (int)words * 2;
            if (function == 0x0521)
            {
                var length = U16(data, offset + 6);
                if (offset + 8 + length <= end) text.Append(Gbk.Value.GetString(data, offset + 8, length));
            }
            else if (function == 0x0A32)
            {
                var length = U16(data, offset + 10);
                var options = U16(data, offset + 12);
                var start = offset + 14 + ((options & 0x0006) != 0 ? 8 : 0);
                if (start + length <= end) text.Append(Gbk.Value.GetString(data, start, length));
            }
            else if (function == 0x0000)
            {
                break;
            }

            offset = end;
        }

        info.VectorText = CleanVectorText(text.ToString());
    }

    static bool LooksLikeSvg(byte[] data)
    {
        var head = Encoding.UTF8.GetString(data, 0, Math.Min(data.Length, 512)).TrimStart('\uFEFF', ' ', '\r', '\n', '\t');
        return head.StartsWith('<') && head.Contains("<svg", StringComparison.OrdinalIgnoreCase);
    }

    static void ReadSvg(byte[] data, ImageInfo info)
    {
        info.Format = "SVG";
        info.IsVector = true;
        using var stream = new MemoryStream(data);
        using var reader = XmlReader.Create(stream, new XmlReaderSettings { DtdProcessing = DtdProcessing.Ignore, XmlResolver = null });
        var document = XDocument.Load(reader);
        var text = string.Concat(document.Descendants().Where(item => item.Name.LocalName == "text").Select(item => item.Value));
        info.VectorText = CleanVectorText(text);
    }

    static string CleanVectorText(string text)
    {
        var value = Regex.Replace(text, @"[\x00-\x1F]+", " ").Trim();
        return value.Length > 2000 ? value[..2000] : value;
    }
}
