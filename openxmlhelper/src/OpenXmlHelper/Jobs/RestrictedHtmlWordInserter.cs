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

/// <summary>未能导出、已在原位改为文字提示的配图及原因，随任务结果返回 Main。</summary>
sealed record ImageWarning(string AssetRef, string Reason);

/// <summary>一次转换共用的配图上下文：Main 按扩展名声明的图片类型，以及未能导出的配图。</summary>
sealed class FigureAssets(IReadOnlyDictionary<string, string>? declaredTypes = null)
{
    public IReadOnlyDictionary<string, string> DeclaredTypes { get; } = declaredTypes ?? new Dictionary<string, string>();
    public List<ImageWarning> Warnings { get; } = [];
}

/// <summary>把受限 HTML 转为 Open XML 块，写入文档正文或指定块级内容控件。</summary>
static partial class RestrictedHtmlWordInserter
{
    public const string TagPrefix = "yibiao:body:";
    internal const long EmusPerTwip = 635L;
    const long EmusPerPoint = 12_700L;
    const long DefaultPageWidthTwips = 11_906L;
    const long DefaultPageHeightTwips = 16_838L;
    const long DefaultPageMarginTwips = 1_134L;
    const long DefaultColumnSpacingTwips = 720L;
    const string FigureTokenPrefix = "YIBIAOFIGURE";

    const long AssetCacheLimitBytes = 32L * 1024 * 1024;

    static readonly Dictionary<string, CachedAsset> AssetCache = new(StringComparer.OrdinalIgnoreCase);
    static long AssetCacheBytes;

    // 可按文件头核对的格式；扩展名声明为其中之一而文件头不符时，说明内容与声明不一致，不按声明原样嵌入。
    static readonly HashSet<string> DetectableImageTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png", "image/jpeg", "image/gif", "image/bmp", "image/webp",
        "image/tiff", "image/emf", "image/x-emf", "image/wmf", "image/x-wmf",
    };

    /// <summary>
    /// 画框适配方式。
    /// cover 把图裁成画框比例，适合实景照片；contain 只把画框当成上界，
    /// 图按自己的真实比例缩放进去，一个像素都不切——流程图、信息图必须走这条。
    /// 不写 data-yb-fit 时保持 cover，老文档行为不变。
    /// </summary>
    enum FigureFit
    {
        Cover,
        Contain,
    }

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
        string html,
        FigureAssets assets)
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
                    htmlDocument,
                    assets);
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

    /// <summary>在已打开的 Word 文档中定位指定内容控件并写入正文。</summary>
    static int InsertIntoDocument(
        string workspace,
        WordprocessingDocument wordDocument,
        string targetId,
        double imageMaxWidthPercent,
        IDocument htmlDocument,
        FigureAssets assets)
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

        var content = targets[0].SdtContentBlock ?? targets[0].AppendChild(new Wp.SdtContentBlock());
        return InsertIntoContent(workspace, mainPart, content, imageMaxWidthPercent, htmlDocument, assets);
    }

    /// <summary>直接写入正文或内容控件，保留文档末尾的分节属性并替换配图标记。</summary>
    internal static int InsertIntoContent(
        string workspace,
        MainDocumentPart mainPart,
        OpenXmlCompositeElement content,
        double imageMaxWidthPercent,
        IDocument htmlDocument,
        FigureAssets assets,
        bool cacheAssets = false)
    {
        var prepared = PrepareHtml(workspace, imageMaxWidthPercent, htmlDocument, assets, cacheAssets);
        // 每个 ol 独立计数，不能沿用前一个列表；显式 start 仍由转换器处理。
        var converter = new HtmlConverter(mainPart) { ContinueNumbering = false };
        var blocks = converter.Parse(prepared.Html);
        var section = content.GetFirstChild<Wp.SectionProperties>();
        content.RemoveAllChildren();
        content.Append(blocks);
        if (!content.ChildElements.Any()) content.AppendChild(new Wp.Paragraph());
        if (section is not null) content.AppendChild(section);
        InsertFigures(mainPart, content, prepared.Figures);
        System.Diagnostics.Debug.Assert(section is null || ReferenceEquals(content.LastChild, section));
        mainPart.Document.Save();
        return content.ChildElements.Count - (section is null ? 0 : 1);
    }

    /// <summary>提取配图信息，并用普通段落标记保留图片在正文或表格中的位置。</summary>
    static PreparedHtml PrepareHtml(
        string workspace,
        double imageMaxWidthPercent,
        IDocument document,
        FigureAssets assets,
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
            var token = $"{FigureTokenPrefix}{Guid.NewGuid():N}";
            var alt = image.GetAttribute("alt")?.Trim() ?? "";
            var caption = figure.Children.FirstOrDefault(item => item.LocalName == "figcaption")?.TextContent?.Trim() ?? "";
            var parent = figure.ParentElement ?? throw new InvalidOperationException("figure 缺少父节点");
            var placement = ResolveFigurePlacement(figure, size, imageMaxWidthPercent);
            var fit = ResolveFigureFit(figure);
            CachedAsset asset;
            try
            {
                if (!File.Exists(assetPath)) throw new InvalidOperationException("图片文件不存在");
                asset = LoadAsset(assetPath, cacheAssets, assets.DeclaredTypes.GetValueOrDefault(assetRef));
            }
            catch (Exception error)
            {
                // 单张图片无法导出时原位改为文字提示并保留图注，其余正文照常转换。
                assets.Warnings.Add(new ImageWarning(assetRef, error.Message));
                var notice = document.CreateElement("p");
                var emphasis = document.CreateElement("em");
                emphasis.TextContent = alt.Length > 0 ? $"[图片无法导出：{alt}]" : "[图片无法导出]";
                notice.AppendChild(emphasis);
                parent.InsertBefore(notice, figure);
                if (caption.Length > 0)
                {
                    var captionParagraph = document.CreateElement("p");
                    captionParagraph.TextContent = caption;
                    parent.InsertBefore(captionParagraph, figure);
                }
                figure.Remove();
                continue;
            }
            figures.Add(new FigureSpec(
                token,
                assetPath,
                alt,
                caption,
                size,
                placement,
                fit,
                asset.Dimensions,
                asset.PartType,
                asset.Bytes));

            var placeholder = document.CreateElement("p");
            placeholder.TextContent = token;
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
        OpenXmlCompositeElement content,
        IReadOnlyList<FigureSpec> figures)
    {
        if (figures.Count == 0) return;
        var specs = figures.ToDictionary(item => item.Token, StringComparer.Ordinal);
        var contentWidth = ResolvePageContentWidth(mainPart, content);
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
        if (spec.Fit == FigureFit.Contain)
        {
            // 画框此时只是上界：按图片自己的比例缩进去，宁可留白也不切内容。
            // 高度只会小于等于版面预算，所以排版侧的装箱结论仍然成立。
            (width, height) = FitInside(spec.Dimensions, width, height);
        }
        var crop = spec.Fit == FigureFit.Contain
            ? new CropValues(0, 0, 0, 0)
            : ResolveCenterCrop(spec.Dimensions, spec.Size);
        Wp.Drawing drawing;
        using (var stream = spec.Bytes is null
            ? (Stream)File.OpenRead(spec.AssetPath)
            : new MemoryStream(spec.Bytes, writable: false))
        {
            drawing = CreateInlineDrawing(mainPart, stream, spec.PartType, width, height, drawingId, Path.GetFileName(spec.AssetPath), spec.Alt, crop);
        }

        return new Wp.Paragraph(
            new Wp.ParagraphProperties(new Wp.Justification { Val = Wp.JustificationValues.Center }),
            new Wp.Run(drawing));
    }

    /// <summary>写入图片部件并创建内嵌图片，正文配图与模版附件共用。</summary>
    internal static Wp.Drawing CreateInlineDrawing(
        MainDocumentPart mainPart,
        Stream data,
        PartTypeInfo partType,
        long width,
        long height,
        uint drawingId,
        string name,
        string alt,
        CropValues? crop = null)
    {
        var imagePart = mainPart.AddImagePart(partType);
        imagePart.FeedData(data);
        var relationshipId = mainPart.GetIdOfPart(imagePart);
        crop ??= new CropValues(0, 0, 0, 0);

        return new Wp.Drawing(
            new DW.Inline(
                new DW.Extent { Cx = width, Cy = height },
                new DW.EffectExtent { LeftEdge = 0L, TopEdge = 0L, RightEdge = 0L, BottomEdge = 0L },
                new DW.DocProperties { Id = drawingId, Name = name, Description = alt },
                new DW.NonVisualGraphicFrameDrawingProperties(new A.GraphicFrameLocks { NoChangeAspect = true }),
                new A.Graphic(
                    new A.GraphicData(
                        new PIC.Picture(
                            new PIC.NonVisualPictureProperties(
                                new PIC.NonVisualDrawingProperties { Id = drawingId, Name = name, Description = alt },
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
    }

    static Wp.Paragraph CreateCaptionParagraph(string caption)
    {
        return new Wp.Paragraph(
            new Wp.ParagraphProperties(new Wp.Justification { Val = Wp.JustificationValues.Center }),
            new Wp.Run(new Wp.Text(caption) { Space = SpaceProcessingModeValues.Preserve }));
    }

    /// <summary>读取正文或目标内容控件所在节的宽度，未设置页面参数时按 A4 与 2 cm 页边距处理。</summary>
    internal static long ResolvePageContentWidth(MainDocumentPart mainPart, OpenXmlCompositeElement target)
    {
        var section = FindSection(mainPart, target);
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

    /// <summary>读取目标所在节的版心高度，未设置页面参数时按 A4 与 2 cm 页边距处理。</summary>
    internal static long ResolvePageContentHeight(MainDocumentPart mainPart, OpenXmlCompositeElement target)
    {
        var section = FindSection(mainPart, target);
        var pageHeightValue = section?.GetFirstChild<Wp.PageSize>()?.Height?.Value;
        var pageHeight = pageHeightValue is null ? DefaultPageHeightTwips : (long)pageHeightValue.Value;
        var margins = section?.GetFirstChild<Wp.PageMargin>();
        var topValue = margins?.Top?.Value;
        var bottomValue = margins?.Bottom?.Value;
        var top = topValue is null ? DefaultPageMarginTwips : Math.Abs((long)topValue.Value);
        var bottom = bottomValue is null ? DefaultPageMarginTwips : Math.Abs((long)bottomValue.Value);
        return Math.Max(1L, pageHeight - top - bottom) * EmusPerTwip;
    }

    static Wp.SectionProperties? FindSection(MainDocumentPart mainPart, OpenXmlCompositeElement target)
    {
        var body = mainPart.Document.Body;
        var passedTarget = false;
        return target is Wp.Body
            ? target.GetFirstChild<Wp.SectionProperties>()
            : body is null ? null : FindFollowingSectionProperties(body, target, ref passedTarget);
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

    /// <summary>读取配图真实格式、尺寸及可选缓存字节，避免同一批样张配图被反复读盘。</summary>
    static CachedAsset LoadAsset(string path, bool cacheAssets, string? declaredType)
    {
        if (!cacheAssets)
        {
            using var file = File.OpenRead(path);
            var image = ReadImageInfo(file, path, declaredType);
            return new CachedAsset(null, image.Dimensions, image.PartType);
        }

        var info = new FileInfo(path);
        var key = $"{path}|{info.LastWriteTimeUtc.Ticks}|{info.Length}";
        if (AssetCache.TryGetValue(key, out var cached)) return cached;

        var bytes = File.ReadAllBytes(path);
        using var stream = new MemoryStream(bytes, writable: false);
        var metadata = ReadImageInfo(stream, path, declaredType);
        var asset = new CachedAsset(bytes, metadata.Dimensions, metadata.PartType);
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

    /// <summary>
    /// 按文件头识别格式，尺寸解析和 Word 图片类型共用结果，不依赖文件后缀；尺寸读不到时交由画框决定大小。
    /// 文件头无法识别时，仅在 Main 按扩展名声明了无法按文件头核对的图片类型时原样嵌入，交给 Word 显示。
    /// </summary>
    internal static (ImageDimensions? Dimensions, PartTypeInfo PartType) ReadImageInfo(Stream stream, string path, string? declaredType)
    {
        var format = DetectImageFormat(stream);
        if (format is null)
        {
            if (declaredType is null
                || !declaredType.StartsWith("image/", StringComparison.OrdinalIgnoreCase)
                || DetectableImageTypes.Contains(declaredType))
            {
                throw new InvalidOperationException("无法识别图片格式");
            }
            return (null, new PartTypeInfo(declaredType, Path.GetExtension(path).ToLowerInvariant()));
        }
        try
        {
            return (format.Value.ReadDimensions(stream), format.Value.PartType);
        }
        catch (Exception error) when (error is EndOfStreamException or InvalidOperationException)
        {
            return (null, format.Value.PartType);
        }
    }

    /// <summary>按文件头识别可核对的图片格式，返回 Word 图片类型及尺寸读取方法；无法识别时返回 null。</summary>
    static (PartTypeInfo PartType, Func<Stream, ImageDimensions> ReadDimensions)? DetectImageFormat(Stream stream)
    {
        Span<byte> header = stackalloc byte[44];
        header = header[..stream.ReadAtLeast(header, header.Length, throwOnEndOfStream: false)];
        stream.Position = 0;
        if (header.StartsWith(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }))
            return (ImagePartType.Png, ReadPngDimensions);
        if (header.StartsWith(new byte[] { 0xFF, 0xD8, 0xFF }))
            return (ImagePartType.Jpeg, ReadJpegDimensions);
        if (header.StartsWith("GIF87a"u8) || header.StartsWith("GIF89a"u8))
            return (ImagePartType.Gif, ReadGifDimensions);
        if (header.StartsWith("BM"u8))
            return (ImagePartType.Bmp, ReadBmpDimensions);
        if (header.Length >= 12 && header[..4].SequenceEqual("RIFF"u8) && header[8..12].SequenceEqual("WEBP"u8))
            return (new PartTypeInfo("image/webp", ".webp"), ReadWebpDimensions);
        // 标准 TIFF 为 42，BigTIFF 为 43；两者都按原字节嵌入，BigTIFF 不读尺寸。
        if (header.StartsWith("II*\0"u8) || header.StartsWith("MM\0*"u8) || header.StartsWith("II+\0"u8) || header.StartsWith("MM\0+"u8))
            return (ImagePartType.Tiff, ReadTiffDimensions);
        if (header.Length >= 44 && BinaryPrimitives.ReadUInt32LittleEndian(header[..4]) == 1 && header[40..44].SequenceEqual(" EMF"u8))
            return (ImagePartType.Emf, ReadEmfDimensions);
        if (header.StartsWith(WmfPlaceableKey)
            || (header.Length >= 6
                && BinaryPrimitives.ReadUInt16LittleEndian(header[..2]) is 1 or 2
                && BinaryPrimitives.ReadUInt16LittleEndian(header[2..4]) == 9
                && BinaryPrimitives.ReadUInt16LittleEndian(header[4..6]) is 0x0100 or 0x0300))
            return (ImagePartType.Wmf, ReadWmfDimensions);
        return null;
    }

    static ReadOnlySpan<byte> WmfPlaceableKey => [0xD7, 0xCD, 0xC6, 0x9A];

    /// <summary>读取 TIFF 首个图像目录中的宽高。</summary>
    static ImageDimensions ReadTiffDimensions(Stream stream)
    {
        Span<byte> header = stackalloc byte[8];
        stream.ReadExactly(header);
        var littleEndian = header[0] == (byte)'I';
        if (TiffUInt16(header[2..4], littleEndian) != 42) throw new InvalidOperationException("BigTIFF 不读取尺寸");
        stream.Position = TiffUInt32(header[4..8], littleEndian);
        Span<byte> entry = stackalloc byte[12];
        stream.ReadExactly(entry[..2]);
        var width = 0;
        var height = 0;
        for (var remaining = TiffUInt16(entry[..2], littleEndian); remaining > 0; remaining -= 1)
        {
            stream.ReadExactly(entry);
            var tag = TiffUInt16(entry[..2], littleEndian);
            if (tag is not (256 or 257)) continue;
            // 宽高可为 SHORT(3) 或 LONG(4)，值直接存放在条目内。
            var value = TiffUInt16(entry[2..4], littleEndian) == 3
                ? TiffUInt16(entry[8..10], littleEndian)
                : (int)Math.Min(TiffUInt32(entry[8..12], littleEndian), int.MaxValue);
            if (tag == 256) width = value;
            else height = value;
        }
        return ValidDimensions(width, height);
    }

    static int TiffUInt16(ReadOnlySpan<byte> bytes, bool littleEndian)
    {
        return littleEndian ? BinaryPrimitives.ReadUInt16LittleEndian(bytes) : BinaryPrimitives.ReadUInt16BigEndian(bytes);
    }

    static uint TiffUInt32(ReadOnlySpan<byte> bytes, bool littleEndian)
    {
        return littleEndian ? BinaryPrimitives.ReadUInt32LittleEndian(bytes) : BinaryPrimitives.ReadUInt32BigEndian(bytes);
    }

    /// <summary>EMF 头记录的 rclFrame 以 0.01 毫米记录画面物理尺寸；无效时退回设备像素边界 rclBounds。</summary>
    static ImageDimensions ReadEmfDimensions(Stream stream)
    {
        Span<byte> header = stackalloc byte[40];
        stream.ReadExactly(header);
        var frameWidth = (long)BinaryPrimitives.ReadInt32LittleEndian(header[32..36]) - BinaryPrimitives.ReadInt32LittleEndian(header[24..28]);
        var frameHeight = (long)BinaryPrimitives.ReadInt32LittleEndian(header[36..40]) - BinaryPrimitives.ReadInt32LittleEndian(header[28..32]);
        if (frameWidth is > 0 and <= int.MaxValue && frameHeight is > 0 and <= int.MaxValue)
        {
            return new ImageDimensions((int)frameWidth, (int)frameHeight);
        }
        var boundsWidth = (long)BinaryPrimitives.ReadInt32LittleEndian(header[16..20]) - BinaryPrimitives.ReadInt32LittleEndian(header[8..12]) + 1;
        var boundsHeight = (long)BinaryPrimitives.ReadInt32LittleEndian(header[20..24]) - BinaryPrimitives.ReadInt32LittleEndian(header[12..16]) + 1;
        return ValidDimensions((int)Math.Clamp(boundsWidth, 0, int.MaxValue), (int)Math.Clamp(boundsHeight, 0, int.MaxValue));
    }

    /// <summary>可放置 WMF 的头部直接记录边界框；标准 WMF 取记录中的 SetWindowExt 画布范围。</summary>
    static ImageDimensions ReadWmfDimensions(Stream stream)
    {
        Span<byte> header = stackalloc byte[22];
        stream.ReadExactly(header);
        if (header.StartsWith(WmfPlaceableKey))
        {
            return ValidDimensions(
                Math.Abs(BinaryPrimitives.ReadInt16LittleEndian(header[10..12]) - BinaryPrimitives.ReadInt16LittleEndian(header[6..8])),
                Math.Abs(BinaryPrimitives.ReadInt16LittleEndian(header[12..14]) - BinaryPrimitives.ReadInt16LittleEndian(header[8..10])));
        }

        // 标准头 18 字节；每条记录以字（2 字节）计长度，META_EOF 为 0。
        stream.Position = 18;
        Span<byte> record = stackalloc byte[10];
        while (stream.Position + 6 <= stream.Length)
        {
            var start = stream.Position;
            stream.ReadExactly(record[..6]);
            var words = BinaryPrimitives.ReadUInt32LittleEndian(record[..4]);
            var function = BinaryPrimitives.ReadUInt16LittleEndian(record[4..6]);
            if (function == 0 || words < 3) break;
            if (function == 0x020C)
            {
                // META_SETWINDOWEXT 参数依次为高、宽。
                stream.ReadExactly(record[6..10]);
                return ValidDimensions(
                    Math.Abs((int)BinaryPrimitives.ReadInt16LittleEndian(record[8..10])),
                    Math.Abs((int)BinaryPrimitives.ReadInt16LittleEndian(record[6..8])));
            }
            stream.Position = start + words * 2L;
        }
        throw new InvalidOperationException("WMF 未记录画布尺寸");
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
    /// <summary>读取 data-yb-fit；不写或写了不认识的值时按 cover 处理，保持旧行为。</summary>
    static FigureFit ResolveFigureFit(IElement figure)
    {
        return (figure.GetAttribute("data-yb-fit") ?? "").Trim() switch
        {
            "contain" => FigureFit.Contain,
            _ => FigureFit.Cover,
        };
    }

    /// <summary>按图片真实比例缩放到不超过给定画框，返回实际占用的宽高；尺寸未知时占满画框。</summary>
    static (long Width, long Height) FitInside(ImageDimensions? dimensions, long boxWidth, long boxHeight)
    {
        if (dimensions is null || dimensions.Width <= 0 || dimensions.Height <= 0) return (boxWidth, boxHeight);
        var sourceRatio = (double)dimensions.Width / dimensions.Height;
        var boxRatio = (double)boxWidth / boxHeight;
        // 图比画框扁就顶着宽走，比画框瘦就顶着高走。
        return sourceRatio > boxRatio
            ? (boxWidth, Math.Max(1L, (long)Math.Round(boxWidth / sourceRatio)))
            : (Math.Max(1L, (long)Math.Round(boxHeight * sourceRatio)), boxHeight);
    }

    static CropValues ResolveCenterCrop(ImageDimensions? dimensions, FigureSize size)
    {
        // 尺寸未知时无法计算裁切比例，按画框原样放置。
        if (dimensions is null) return new CropValues(0, 0, 0, 0);
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
    internal sealed record ImageDimensions(int Width, int Height);

    sealed record CachedAsset(byte[]? Bytes, ImageDimensions? Dimensions, PartTypeInfo PartType);
    internal sealed record CropValues(int Left, int Top, int Right, int Bottom);
    sealed record FigureSpec(
        string Token,
        string AssetPath,
        string Alt,
        string Caption,
        FigureSize Size,
        FigurePlacement Placement,
        FigureFit Fit,
        ImageDimensions? Dimensions,
        PartTypeInfo PartType,
        byte[]? Bytes);
    sealed record PreparedHtml(string Html, IReadOnlyList<FigureSpec> Figures);

    [GeneratedRegex("^[A-Za-z][A-Za-z0-9_-]{0,63}$", RegexOptions.CultureInvariant)]
    private static partial Regex TargetIdPattern();
}
