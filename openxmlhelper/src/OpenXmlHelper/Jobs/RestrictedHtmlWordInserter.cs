using System.Buffers.Binary;
using System.Text.RegularExpressions;
using AngleSharp.Dom;
using AngleSharp.Html.Parser;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;
using HtmlToOpenXml;
using A = DocumentFormat.OpenXml.Drawing;
using DW = DocumentFormat.OpenXml.Drawing.Wordprocessing;
using PIC = DocumentFormat.OpenXml.Drawing.Pictures;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>把受限 HTML 转为 Open XML 块并替换指定块级内容控件。</summary>
static partial class RestrictedHtmlWordInserter
{
    public const string TagPrefix = "yibiao:body:";
    const long EmusPerTwip = 635L;
    const long EmusPerPoint = 12_700L;
    const long DefaultPageWidthTwips = 11_906L;
    const long DefaultPageMarginTwips = 1_134L;
    const long DefaultColumnSpacingTwips = 720L;
    const string FigureTokenPrefix = "YIBIAOFIGURE";

    const long AssetCacheLimitBytes = 32L * 1024 * 1024;

    static readonly Dictionary<string, CachedAsset> AssetCache = new(StringComparer.OrdinalIgnoreCase);
    static long AssetCacheBytes;

    static readonly IReadOnlyDictionary<string, FigureSize> FigureSizes = new Dictionary<string, FigureSize>(StringComparer.Ordinal)
    {
        ["square"] = new(0.65, 1, 1),
        ["wide"] = new(0.80, 3, 2),
        ["tall"] = new(0.50, 3, 4),
        ["panorama"] = new(0.90, 16, 9),
    };

    /// <summary>在 Word 文件的指定内容控件中插入受限 HTML，成功后原子替换原文件。</summary>
    public static int Insert(
        string workspace,
        string documentPath,
        string targetId,
        double imageMaxWidthPercent,
        string html)
    {
        if (string.IsNullOrWhiteSpace(html))
        {
            throw new InvalidOperationException("受限 HTML 为空");
        }

        var htmlDocument = new HtmlParser().ParseDocument(html);
        var tempPath = $"{documentPath}.{Guid.NewGuid():N}.tmp.docx";
        try
        {
            File.Copy(documentPath, tempPath, overwrite: true);
            int blockCount;
            using (var wordDocument = WordprocessingDocument.Open(tempPath, true))
            {
                blockCount = InsertIntoDocument(
                    workspace,
                    wordDocument,
                    targetId,
                    imageMaxWidthPercent,
                    htmlDocument);
                var errors = new OpenXmlValidator(FileFormatVersions.Microsoft365).Validate(wordDocument).Take(10).ToList();
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

    /// <summary>向已打开的 Word 文档插入已解析 HTML；供一次性预览复用同一个包会话。</summary>
    internal static int InsertIntoDocument(
        string workspace,
        WordprocessingDocument wordDocument,
        string targetId,
        double imageMaxWidthPercent,
        IDocument htmlDocument,
        bool cacheAssets = false)
    {
        var normalizedTargetId = (targetId ?? "").Trim();
        if (!TargetIdPattern().IsMatch(normalizedTargetId))
        {
            throw new InvalidOperationException("target_id 不合法");
        }

        var mainPart = wordDocument.MainDocumentPart ?? throw new InvalidOperationException("Word 缺少正文部件");
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

        var prepared = PrepareHtml(workspace, imageMaxWidthPercent, htmlDocument, cacheAssets);
        var converter = new HtmlConverter(mainPart);
        var blocks = converter.Parse(prepared.Html);
        var content = targets[0].SdtContentBlock ?? targets[0].AppendChild(new Wp.SdtContentBlock());
        content.RemoveAllChildren();
        foreach (var block in blocks)
        {
            content.AppendChild(block);
        }
        if (!content.ChildElements.Any()) content.AppendChild(new Wp.Paragraph());
        InsertFigures(mainPart, targets[0], content, prepared.Figures);
        mainPart.Document.Save();
        return content.ChildElements.Count;
    }

    /// <summary>提取配图信息，并用普通段落标记保留图片在正文或表格中的位置。</summary>
    static PreparedHtml PrepareHtml(
        string workspace,
        double imageMaxWidthPercent,
        IDocument document,
        bool cacheAssets)
    {
        var figures = new List<FigureSpec>();
        foreach (var figure in document.QuerySelectorAll("figure").ToList())
        {
            var sizeName = (figure.GetAttribute("data-yb-size") ?? "").Trim();
            if (!FigureSizes.TryGetValue(sizeName, out var size))
            {
                throw new InvalidOperationException("figure 缺少合法 data-yb-size");
            }

            var images = figure.Children.Where(item => item.LocalName == "img").ToList();
            if (images.Count != 1)
            {
                throw new InvalidOperationException("figure 必须包含一个 img");
            }
            var image = images[0];
            var assetRef = (image.GetAttribute("data-yb-asset-ref") ?? "").Trim();
            if (assetRef.Length == 0)
            {
                throw new InvalidOperationException("导出 figure 时 img 必须包含 data-yb-asset-ref");
            }
            if (assetRef.Contains('\\') || Path.IsPathRooted(assetRef) || assetRef.Split('/').Contains("..", StringComparer.Ordinal))
            {
                throw new InvalidOperationException("data-yb-asset-ref 必须是工作区内的相对路径");
            }

            var assetPath = WordWorkspace.ResolveWorkspacePath(workspace, assetRef);
            if (!File.Exists(assetPath))
            {
                throw new InvalidOperationException($"图片资产不存在：{assetRef}");
            }

            var token = $"{FigureTokenPrefix}{Guid.NewGuid():N}";
            var caption = figure.Children.FirstOrDefault(item => item.LocalName == "figcaption")?.TextContent?.Trim() ?? "";
            var placement = ResolveFigurePlacement(figure, size, imageMaxWidthPercent);
            var asset = LoadAsset(assetPath, cacheAssets);
            figures.Add(new FigureSpec(
                token,
                assetPath,
                image.GetAttribute("alt")?.Trim() ?? "",
                caption,
                size,
                placement,
                asset.Dimensions,
                asset.Bytes));

            var placeholder = document.CreateElement("p");
            placeholder.TextContent = token;
            var parent = figure.ParentElement ?? throw new InvalidOperationException("figure 缺少父节点");
            parent.InsertBefore(placeholder, figure);
            figure.Remove();
        }

        if (document.QuerySelector("img") is not null)
        {
            throw new InvalidOperationException("img 必须位于 figure 内");
        }
        foreach (var template in document.QuerySelectorAll("template").ToList()) template.Remove();
        return new PreparedHtml(document.Body?.InnerHtml ?? "", figures);
    }

    /// <summary>按图片所在表格单元格计算可用宽度；独立图片使用尺寸预设宽度。</summary>
    static FigurePlacement ResolveFigurePlacement(IElement figure, FigureSize size, double imageMaxWidthPercent)
    {
        var layers = new List<TableCellPlacement>();
        var current = figure.ParentElement;
        while (current is not null)
        {
            while (current is not null && current.LocalName is not ("td" or "th"))
            {
                current = current.ParentElement;
            }
            if (current is null) break;
            var cell = current;

            current = cell.ParentElement;
            while (current is not null && current.LocalName != "table")
            {
                current = current.ParentElement;
            }
            if (current is null) break;
            var table = current;
            layers.Add(ResolveTableCellPlacement(table, cell));
            current = table.ParentElement;
        }

        if (layers.Count == 0)
        {
            return new FigurePlacement(Math.Min(size.WidthRatio, imageMaxWidthPercent / 100.0), 0);
        }

        layers.Reverse();
        var widthRatio = 1.0;
        var horizontalPaddingPoints = 0.0;
        foreach (var layer in layers)
        {
            widthRatio *= layer.WidthRatio;
            horizontalPaddingPoints = horizontalPaddingPoints * layer.WidthRatio + layer.HorizontalPaddingPoints;
        }
        return new FigurePlacement(widthRatio, horizontalPaddingPoints);
    }

    /// <summary>计算单层表格中目标单元格的宽度占比和水平内边距。</summary>
    static TableCellPlacement ResolveTableCellPlacement(IElement table, IElement cell)
    {
        var preset = table.GetAttribute("data-yb-preset") ?? "";
        var rowCells = cell.ParentElement?.Children
            .Where(item => item.LocalName is "td" or "th")
            .ToList() ?? [];
        var cellIndex = rowCells.FindIndex(item => ReferenceEquals(item, cell));
        if (preset == "imageText")
        {
            return cellIndex == 0
                ? new TableCellPlacement(0.44, 0)
                : new TableCellPlacement(0.56, 12);
        }
        if (preset == "threeImages") return new TableCellPlacement(1.0 / 3.0, 12);
        if (preset == "fourImages") return new TableCellPlacement(0.5, 12);

        return new TableCellPlacement(ResolveLogicalCellWidthRatio(table, cell), 12);
    }

    /// <summary>按照 rowspan、colspan 构建完整逻辑网格并计算目标单元格占比。</summary>
    static double ResolveLogicalCellWidthRatio(IElement table, IElement cell)
    {
        var carry = new List<int>();
        var logicalColumns = 0;
        var ownColumns = PositiveInteger(cell.GetAttribute("colspan"));
        foreach (var section in table.Children.Where(item => item.LocalName is "thead" or "tbody"))
        {
            foreach (var row in section.Children.Where(item => item.LocalName == "tr"))
            {
                var column = 0;
                foreach (var rowCell in row.Children.Where(item => item.LocalName is "td" or "th"))
                {
                    while (column < carry.Count && carry[column] > 0) column += 1;
                    var colspan = PositiveInteger(rowCell.GetAttribute("colspan"));
                    var rowspan = PositiveInteger(rowCell.GetAttribute("rowspan"));
                    while (carry.Count < column + colspan) carry.Add(0);
                    if (rowspan > 1)
                    {
                        for (var offset = 0; offset < colspan; offset += 1)
                        {
                            carry[column + offset] = rowspan;
                        }
                    }
                    column += colspan;
                }

                var rowWidth = Math.Max(column, carry.FindLastIndex(value => value > 0) + 1);
                logicalColumns = Math.Max(logicalColumns, rowWidth);
                for (var index = 0; index < carry.Count; index += 1)
                {
                    carry[index] = Math.Max(0, carry[index] - 1);
                }
            }
        }
        return logicalColumns > 0 ? (double)ownColumns / logicalColumns : 1.0;
    }

    static int PositiveInteger(string? value)
    {
        return int.TryParse(value, out var parsed) && parsed > 0 ? parsed : 1;
    }

    /// <summary>把转换后的标记段落替换为图片段落和可选图注。</summary>
    static void InsertFigures(
        MainDocumentPart mainPart,
        Wp.SdtBlock target,
        Wp.SdtContentBlock content,
        IReadOnlyList<FigureSpec> figures)
    {
        if (figures.Count == 0) return;
        var specs = figures.ToDictionary(item => item.Token, StringComparer.Ordinal);
        var contentWidth = ResolvePageContentWidth(mainPart, target);
        var nextDrawingId = mainPart.Document.Descendants<DW.DocProperties>()
            .Select(item => item.Id?.Value ?? 0U)
            .DefaultIfEmpty(0U)
            .Max() + 1U;
        var inserted = 0;

        foreach (var paragraph in content.Descendants<Wp.Paragraph>().ToList())
        {
            var token = paragraph.InnerText.Trim();
            if (!specs.TryGetValue(token, out var spec)) continue;
            paragraph.InsertBeforeSelf(CreateImageParagraph(mainPart, spec, contentWidth, nextDrawingId++));
            if (spec.Caption.Length > 0) paragraph.InsertBeforeSelf(CreateCaptionParagraph(spec.Caption));
            paragraph.Remove();
            inserted += 1;
        }

        if (inserted != figures.Count)
        {
            throw new InvalidOperationException("部分 figure 无法定位到 Word 插入位置");
        }
    }

    /// <summary>创建固定比例画框，并通过 DrawingML 居中裁切图片。</summary>
    static Wp.Paragraph CreateImageParagraph(
        MainDocumentPart mainPart,
        FigureSpec spec,
        long pageContentWidth,
        uint drawingId)
    {
        var width = Math.Max(1L, (long)Math.Round(pageContentWidth * spec.Placement.WidthRatio));
        width = Math.Max(1L, width - (long)Math.Round(spec.Placement.HorizontalPaddingPoints * EmusPerPoint));
        var height = Math.Max(1L, (long)Math.Round(width * (double)spec.Size.AspectHeight / spec.Size.AspectWidth));
        var imagePart = mainPart.AddImagePart(ResolveImagePartType(spec.AssetPath));
        using (var stream = spec.Bytes is null
            ? (Stream)File.OpenRead(spec.AssetPath)
            : new MemoryStream(spec.Bytes, writable: false))
        {
            imagePart.FeedData(stream);
        }
        var relationshipId = mainPart.GetIdOfPart(imagePart);
        var crop = ResolveCenterCrop(spec.Dimensions, spec.Size);
        var name = Path.GetFileName(spec.AssetPath);

        var drawing = new Wp.Drawing(
            new DW.Inline(
                new DW.Extent { Cx = width, Cy = height },
                new DW.EffectExtent { LeftEdge = 0L, TopEdge = 0L, RightEdge = 0L, BottomEdge = 0L },
                new DW.DocProperties { Id = drawingId, Name = name, Description = spec.Alt },
                new DW.NonVisualGraphicFrameDrawingProperties(new A.GraphicFrameLocks { NoChangeAspect = true }),
                new A.Graphic(
                    new A.GraphicData(
                        new PIC.Picture(
                            new PIC.NonVisualPictureProperties(
                                new PIC.NonVisualDrawingProperties { Id = drawingId, Name = name, Description = spec.Alt },
                                new PIC.NonVisualPictureDrawingProperties()),
                            new PIC.BlipFill(
                                new A.Blip { Embed = relationshipId, CompressionState = A.BlipCompressionValues.Print },
                                new A.SourceRectangle
                                {
                                    Left = crop.Left,
                                    Top = crop.Top,
                                    Right = crop.Right,
                                    Bottom = crop.Bottom,
                                },
                                new A.Stretch(new A.FillRectangle())),
                            new PIC.ShapeProperties(
                                new A.Transform2D(
                                    new A.Offset { X = 0L, Y = 0L },
                                    new A.Extents { Cx = width, Cy = height }),
                                new A.PresetGeometry(new A.AdjustValueList()) { Preset = A.ShapeTypeValues.Rectangle })))
                    { Uri = "http://schemas.openxmlformats.org/drawingml/2006/picture" }))
            {
                DistanceFromTop = 0U,
                DistanceFromBottom = 0U,
                DistanceFromLeft = 0U,
                DistanceFromRight = 0U,
            });

        return new Wp.Paragraph(
            new Wp.ParagraphProperties(new Wp.Justification { Val = Wp.JustificationValues.Center }),
            new Wp.Run(drawing));
    }

    static Wp.Paragraph CreateCaptionParagraph(string caption)
    {
        return new Wp.Paragraph(
            new Wp.ParagraphProperties(new Wp.Justification { Val = Wp.JustificationValues.Center }),
            new Wp.Run(new Wp.Text(caption) { Space = SpaceProcessingModeValues.Preserve }));
    }

    /// <summary>读取目标内容控件所在节的正文宽度，未设置页面参数时按 A4 与 2 cm 页边距处理。</summary>
    static long ResolvePageContentWidth(MainDocumentPart mainPart, Wp.SdtBlock target)
    {
        var body = mainPart.Document.Body;
        var passedTarget = false;
        var section = body is null ? null : FindFollowingSectionProperties(body, target, ref passedTarget);
        var pageWidthValue = section?.GetFirstChild<Wp.PageSize>()?.Width?.Value;
        var pageWidth = pageWidthValue is null ? DefaultPageWidthTwips : (long)pageWidthValue.Value;
        var margins = section?.GetFirstChild<Wp.PageMargin>();
        var leftValue = margins?.Left?.Value;
        var rightValue = margins?.Right?.Value;
        var left = leftValue is null ? DefaultPageMarginTwips : leftValue.Value;
        var right = rightValue is null ? DefaultPageMarginTwips : rightValue.Value;
        var contentWidth = Math.Max(1L, pageWidth - left - right);
        var columns = section?.GetFirstChild<Wp.Columns>();
        var columnCount = Math.Max(1, (int)(columns?.ColumnCount?.Value ?? 1));
        if (columnCount > 1)
        {
            var spacing = long.TryParse(columns?.Space?.Value, out var parsedSpacing)
                ? Math.Max(0L, parsedSpacing)
                : DefaultColumnSpacingTwips;
            contentWidth = Math.Max(1L, contentWidth - spacing * (columnCount - 1)) / columnCount;
        }
        return Math.Max(1L, contentWidth) * EmusPerTwip;
    }

    /// <summary>按文档顺序查找目标位置之后最近的分节属性。</summary>
    static Wp.SectionProperties? FindFollowingSectionProperties(
        OpenXmlElement parent,
        OpenXmlElement target,
        ref bool passedTarget)
    {
        foreach (var child in parent.ChildElements)
        {
            if (ReferenceEquals(child, target))
            {
                passedTarget = true;
                continue;
            }
            if (passedTarget && child is Wp.SectionProperties section) return section;
            var nested = FindFollowingSectionProperties(child, target, ref passedTarget);
            if (nested is not null) return nested;
        }
        return null;
    }

    static PartTypeInfo ResolveImagePartType(string path)
    {
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".png" => ImagePartType.Png,
            ".jpg" or ".jpeg" => ImagePartType.Jpeg,
            ".gif" => ImagePartType.Gif,
            ".bmp" => ImagePartType.Bmp,
            ".webp" => new PartTypeInfo("image/webp", ".webp"),
            _ => throw new InvalidOperationException("Word 配图仅支持 PNG、JPEG、GIF、BMP 和 WebP"),
        };
    }

    /// <summary>读取常用图片格式的像素尺寸，用于计算居中裁切。</summary>
    /// <summary>读取配图字节与尺寸；预览路径会缓存，避免同一批样张配图被反复读盘。</summary>
    static CachedAsset LoadAsset(string path, bool cacheAssets)
    {
        if (!cacheAssets) return new CachedAsset(null, ReadImageDimensions(path));

        var info = new FileInfo(path);
        var key = $"{path}|{info.LastWriteTimeUtc.Ticks}|{info.Length}";
        if (AssetCache.TryGetValue(key, out var cached)) return cached;

        var bytes = File.ReadAllBytes(path);
        using var stream = new MemoryStream(bytes, writable: false);
        var asset = new CachedAsset(bytes, ReadImageDimensions(Path.GetExtension(path), stream));
        // 只服务体量固定的样张配图；超出上限说明来源不对，整体丢弃而不是无限增长。
        if (AssetCacheBytes + bytes.LongLength > AssetCacheLimitBytes)
        {
            AssetCache.Clear();
            AssetCacheBytes = 0;
        }
        AssetCache[key] = asset;
        AssetCacheBytes += bytes.LongLength;
        return asset;
    }

    static ImageDimensions ReadImageDimensions(string path)
    {
        using var stream = File.OpenRead(path);
        return ReadImageDimensions(Path.GetExtension(path), stream);
    }

    static ImageDimensions ReadImageDimensions(string extension, Stream stream)
    {
        return extension.ToLowerInvariant() switch
        {
            ".png" => ReadPngDimensions(stream),
            ".jpg" or ".jpeg" => ReadJpegDimensions(stream),
            ".gif" => ReadGifDimensions(stream),
            ".bmp" => ReadBmpDimensions(stream),
            ".webp" => ReadWebpDimensions(stream),
            _ => throw new InvalidOperationException("Word 配图仅支持 PNG、JPEG、GIF、BMP 和 WebP"),
        };
    }

    /// <summary>读取 WebP 的 VP8、VP8L 或 VP8X 画布尺寸。</summary>
    static ImageDimensions ReadWebpDimensions(Stream stream)
    {
        Span<byte> riff = stackalloc byte[12];
        stream.ReadExactly(riff);
        if (!riff[..4].SequenceEqual("RIFF"u8) || !riff[8..12].SequenceEqual("WEBP"u8))
        {
            throw new InvalidOperationException("WebP 图片格式无效");
        }

        Span<byte> chunk = stackalloc byte[8];
        stream.ReadExactly(chunk);
        var chunkSize = BinaryPrimitives.ReadUInt32LittleEndian(chunk[4..8]);
        if (chunk[..4].SequenceEqual("VP8X"u8))
        {
            if (chunkSize < 10) throw new InvalidOperationException("WebP VP8X 图片格式无效");
            Span<byte> payload = stackalloc byte[10];
            stream.ReadExactly(payload);
            return ValidDimensions(
                1 + payload[4] + (payload[5] << 8) + (payload[6] << 16),
                1 + payload[7] + (payload[8] << 8) + (payload[9] << 16));
        }
        if (chunk[..4].SequenceEqual("VP8 "u8))
        {
            if (chunkSize < 10) throw new InvalidOperationException("WebP VP8 图片格式无效");
            Span<byte> payload = stackalloc byte[10];
            stream.ReadExactly(payload);
            if (!payload[3..6].SequenceEqual(new byte[] { 0x9D, 0x01, 0x2A }))
            {
                throw new InvalidOperationException("WebP VP8 图片格式无效");
            }
            return ValidDimensions(
                BinaryPrimitives.ReadUInt16LittleEndian(payload[6..8]) & 0x3FFF,
                BinaryPrimitives.ReadUInt16LittleEndian(payload[8..10]) & 0x3FFF);
        }
        if (chunk[..4].SequenceEqual("VP8L"u8))
        {
            if (chunkSize < 5) throw new InvalidOperationException("WebP VP8L 图片格式无效");
            Span<byte> payload = stackalloc byte[5];
            stream.ReadExactly(payload);
            if (payload[0] != 0x2F) throw new InvalidOperationException("WebP VP8L 图片格式无效");
            var bits = BinaryPrimitives.ReadUInt32LittleEndian(payload[1..5]);
            return ValidDimensions((int)(bits & 0x3FFF) + 1, (int)((bits >> 14) & 0x3FFF) + 1);
        }
        throw new InvalidOperationException("WebP 图片缺少 VP8、VP8L 或 VP8X 图像块");
    }

    static ImageDimensions ReadPngDimensions(Stream stream)
    {
        Span<byte> header = stackalloc byte[24];
        stream.ReadExactly(header);
        if (!header[..8].SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }))
        {
            throw new InvalidOperationException("PNG 图片格式无效");
        }
        return ValidDimensions(
            BinaryPrimitives.ReadInt32BigEndian(header[16..20]),
            BinaryPrimitives.ReadInt32BigEndian(header[20..24]));
    }

    static ImageDimensions ReadGifDimensions(Stream stream)
    {
        Span<byte> header = stackalloc byte[10];
        stream.ReadExactly(header);
        if (!header[..3].SequenceEqual("GIF"u8)) throw new InvalidOperationException("GIF 图片格式无效");
        return ValidDimensions(
            BinaryPrimitives.ReadUInt16LittleEndian(header[6..8]),
            BinaryPrimitives.ReadUInt16LittleEndian(header[8..10]));
    }

    static ImageDimensions ReadBmpDimensions(Stream stream)
    {
        Span<byte> header = stackalloc byte[26];
        stream.ReadExactly(header);
        if (!header[..2].SequenceEqual("BM"u8)) throw new InvalidOperationException("BMP 图片格式无效");
        return ValidDimensions(
            BinaryPrimitives.ReadInt32LittleEndian(header[18..22]),
            Math.Abs(BinaryPrimitives.ReadInt32LittleEndian(header[22..26])));
    }

    static ImageDimensions ReadJpegDimensions(Stream stream)
    {
        using var reader = new BinaryReader(stream);
        if (reader.ReadByte() != 0xFF || reader.ReadByte() != 0xD8)
        {
            throw new InvalidOperationException("JPEG 图片格式无效");
        }

        while (stream.Position < stream.Length)
        {
            byte prefix;
            do { prefix = reader.ReadByte(); } while (prefix != 0xFF && stream.Position < stream.Length);
            byte marker;
            do { marker = reader.ReadByte(); } while (marker == 0xFF && stream.Position < stream.Length);
            if (marker is 0xD8 or 0xD9) continue;
            var segmentLength = ReadBigEndianUInt16(reader);
            if (segmentLength < 2) break;
            if (IsJpegStartOfFrame(marker))
            {
                _ = reader.ReadByte();
                var height = ReadBigEndianUInt16(reader);
                var width = ReadBigEndianUInt16(reader);
                return ValidDimensions(width, height);
            }
            stream.Seek(segmentLength - 2, SeekOrigin.Current);
        }
        throw new InvalidOperationException("无法读取 JPEG 图片尺寸");
    }

    static ushort ReadBigEndianUInt16(BinaryReader reader)
    {
        Span<byte> bytes = stackalloc byte[2];
        reader.BaseStream.ReadExactly(bytes);
        return BinaryPrimitives.ReadUInt16BigEndian(bytes);
    }

    static bool IsJpegStartOfFrame(byte marker)
    {
        return marker is 0xC0 or 0xC1 or 0xC2 or 0xC3 or 0xC5 or 0xC6 or 0xC7
            or 0xC9 or 0xCA or 0xCB or 0xCD or 0xCE or 0xCF;
    }

    static ImageDimensions ValidDimensions(int width, int height)
    {
        if (width <= 0 || height <= 0) throw new InvalidOperationException("图片尺寸无效");
        return new ImageDimensions(width, height);
    }

    /// <summary>计算 DrawingML 千分之一百分比单位的居中 cover 裁切值。</summary>
    static CropValues ResolveCenterCrop(ImageDimensions dimensions, FigureSize size)
    {
        var sourceRatio = (double)dimensions.Width / dimensions.Height;
        var targetRatio = (double)size.AspectWidth / size.AspectHeight;
        if (Math.Abs(sourceRatio - targetRatio) < 0.0001) return new CropValues(0, 0, 0, 0);
        if (sourceRatio > targetRatio)
        {
            var horizontal = Math.Clamp((int)Math.Round((1.0 - targetRatio / sourceRatio) * 50_000), 0, 49_999);
            return new CropValues(horizontal, 0, horizontal, 0);
        }
        var vertical = Math.Clamp((int)Math.Round((1.0 - sourceRatio / targetRatio) * 50_000), 0, 49_999);
        return new CropValues(0, vertical, 0, vertical);
    }

    sealed record FigureSize(double WidthRatio, int AspectWidth, int AspectHeight);
    sealed record FigurePlacement(double WidthRatio, double HorizontalPaddingPoints);
    sealed record TableCellPlacement(double WidthRatio, double HorizontalPaddingPoints);
    sealed record ImageDimensions(int Width, int Height);

    sealed record CachedAsset(byte[]? Bytes, ImageDimensions Dimensions);
    sealed record CropValues(int Left, int Top, int Right, int Bottom);
    sealed record FigureSpec(
        string Token,
        string AssetPath,
        string Alt,
        string Caption,
        FigureSize Size,
        FigurePlacement Placement,
        ImageDimensions Dimensions,
        byte[]? Bytes);
    sealed record PreparedHtml(string Html, IReadOnlyList<FigureSpec> Figures);

    [GeneratedRegex("^[A-Za-z][A-Za-z0-9_-]{0,63}$", RegexOptions.CultureInvariant)]
    private static partial Regex TargetIdPattern();
}
