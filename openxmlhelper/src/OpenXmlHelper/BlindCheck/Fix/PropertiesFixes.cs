using Yibiao.OpenXmlHelper.BlindCheck.Rules;

namespace Yibiao.OpenXmlHelper.BlindCheck.Fix;

/// <summary>文档属性与图片元数据：这些信息不在正文里，但随文件一起提交，评审方可以直接读到。</summary>
static class PropertiesFixes
{
    /// <summary>清空作者、最后修改者、单位、经理，模板名重置为 Normal，删除被报出的自定义属性；开关与检查一致。</summary>
    public static int FixDocumentProperties(FixContext fix)
    {
        var package = fix.Package;
        var profile = fix.Rules.Profile;
        var count = 0;

        var corePart = package.RelatedPart("", "/core-properties", "docProps/core.xml");
        if (fix.Extra(corePart)?.Root is { } core)
        {
            foreach (var (name, toggle) in new[] { ("creator", "props.check_author"), ("lastModifiedBy", "props.check_last_modified_by") })
            {
                var element = StructureRules.LocalChild(core, name);
                if (element is null || element.Value.Trim().Length == 0 || !profile.Bool(toggle, true)) continue;
                element.Value = "";
                count += 1;
            }

            if (count > 0) fix.Touch(corePart!);
        }

        var appPart = package.RelatedPart("", "/extended-properties", "docProps/app.xml");
        if (fix.Extra(appPart)?.Root is { } app)
        {
            var changed = false;
            var company = StructureRules.LocalChild(app, "Company");
            if (company is not null && company.Value.Trim().Length > 0 && profile.Bool("props.check_company", true))
            {
                company.Value = "";
                // 经理字段同属单位信息，检查不单独报，清单位时一并清空。
                if (StructureRules.LocalChild(app, "Manager") is { } manager) manager.Value = "";
                changed = true;
                count += 1;
            }

            var template = StructureRules.LocalChild(app, "Template");
            if (template is not null && template.Value.Trim().Length > 0 && !StructureRules.DefaultTemplates.Contains(template.Value.Trim()) && profile.Bool("props.check_template", true))
            {
                template.Value = "Normal.dotm";
                changed = true;
                count += 1;
            }

            if (changed) fix.Touch(appPart!);
        }

        var customPart = package.RelatedPart("", "/custom-properties", "docProps/custom.xml");
        if (profile.Bool("props.check_custom_props", true) && fix.Extra(customPart)?.Root is { } custom)
        {
            var removable = custom.Elements()
                .Where(item => item.Attribute("name")?.Value is { Length: > 0 } name && !StructureRules.BenignCustomProperties.Contains(name))
                .ToList();
            if (removable.Count > 0)
            {
                removable.ForEach(item => item.Remove());
                fix.Touch(customPart!);
                count += removable.Count;
            }
        }

        return count;
    }

    /// <summary>去掉带作者、版权、拍摄位置等元数据的图片里的元数据段，不改像素。</summary>
    public static int FixImageMetadata(FixContext fix)
    {
        var count = 0;
        foreach (var image in fix.Rules.Images.Where(item => item.Metadata.Count > 0 || item.HasGps))
        {
            var data = fix.Package.ReadBytes(image.Part);
            var stripped = data is null ? null : ImageMetadataStripper.Strip(data);
            if (stripped is null)
            {
                fix.Note($"{image.FileName}（{image.Format}）的元数据无法自动去除，请用画图等软件另存后重新插入");
                continue;
            }

            fix.Writer.SetBytes(image.Part, stripped);
            count += 1;
        }

        return count;
    }
}

/// <summary>按文件结构删除元数据段：JPEG 的 APP1（EXIF / XMP）、APP13 和注释段，PNG 的文本块与 eXIf 块；其余字节原样保留。</summary>
static class ImageMetadataStripper
{
    static readonly HashSet<string> PngMetadataChunks = ["tEXt", "zTXt", "iTXt", "eXIf"];

    public static byte[]? Strip(byte[] data)
    {
        if (data.Length > 4 && data[0] == 0xFF && data[1] == 0xD8) return StripJpeg(data);
        if (data.Length > 8 && data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4E && data[3] == 0x47) return StripPng(data);
        return null;
    }

    static byte[] StripJpeg(byte[] data)
    {
        using var output = new MemoryStream(data.Length);
        output.Write(data, 0, 2);
        var offset = 2;
        while (offset + 4 <= data.Length)
        {
            if (data[offset] != 0xFF) break;
            var marker = data[offset + 1];
            if (marker == 0xFF)
            {
                offset += 1;
                continue;
            }

            if (marker == 0xDA || marker == 0xD9) break;
            if (marker == 0x01 || marker is >= 0xD0 and <= 0xD7)
            {
                output.Write(data, offset, 2);
                offset += 2;
                continue;
            }

            var end = offset + 2 + (data[offset + 2] << 8 | data[offset + 3]);
            if (end > data.Length) break;
            if (marker is not (0xE1 or 0xED or 0xFE)) output.Write(data, offset, end - offset);
            offset = end;
        }

        if (offset < data.Length) output.Write(data, offset, data.Length - offset);
        return output.ToArray();
    }

    static byte[] StripPng(byte[] data)
    {
        using var output = new MemoryStream(data.Length);
        output.Write(data, 0, 8);
        var offset = 8;
        while (offset + 12 <= data.Length)
        {
            var length = data[offset] << 24 | data[offset + 1] << 16 | data[offset + 2] << 8 | data[offset + 3];
            var type = System.Text.Encoding.ASCII.GetString(data, offset + 4, 4);
            var end = offset + 12 + length;
            if (length < 0 || end > data.Length) break;
            if (!PngMetadataChunks.Contains(type)) output.Write(data, offset, end - offset);
            offset = end;
            if (type == "IEND") break;
        }

        if (offset < data.Length) output.Write(data, offset, data.Length - offset);
        return output.ToArray();
    }
}
