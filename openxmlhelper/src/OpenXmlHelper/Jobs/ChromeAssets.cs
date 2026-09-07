using System.Text.Json;

namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>页眉/页脚文字的完整区域，单位 cm，相对纸张左上角。</summary>
sealed record ChromeTextBox(double StartCm, double EndCm, double TopCm, double HeightCm);

/// <summary>页眉文字层描述。</summary>
sealed class ChromeHeaderText
{
    public string Color { get; init; } = "";
    public bool Bold { get; init; }
    public string Align { get; init; } = "";
    public ChromeTextBox? Box { get; init; }
    /// <summary>band 样式左侧徽标块的文字，其余样式为 null。</summary>
    public ChromeHeaderText? Badge { get; init; }
}

/// <summary>页脚文字层描述。页码底色走 run 级底纹，宽度自动贴合文字。</summary>
sealed class ChromeFooterText
{
    public string Color { get; init; } = "";
    public string Align { get; init; } = "";
    public ChromeTextBox? Box { get; init; }
    public string PageNumberColor { get; init; } = "";
    /// <summary>为空表示页码不加底纹。</summary>
    public string PageNumberShading { get; init; } = "";
    public bool PageNumberBold { get; init; }
    public string PageNumberAlign { get; init; } = "";
    public ChromeTextBox? PageNumberBox { get; init; }
}

/// <summary>
/// 渲染进程传来的页眉页脚装饰。装饰本身是 PNG（SVG 栅格化而来），
/// 文字与页码仍由 Word 原生 run 承担，位置由这里的文字层描述给出。
/// </summary>
sealed class ChromeAssets
{
    public static readonly ChromeAssets Empty = new();

    public string HeaderImagePath { get; private set; } = "";
    public string FooterImagePath { get; private set; } = "";
    public double HeaderHeightCm { get; private set; }
    public double FooterHeightCm { get; private set; }
    public double FooterTopCm { get; private set; }
    public double FooterDistanceCm { get; private set; }
    /// <summary>页眉段落距页顶。有装饰时为 0（文字靠浮动文本框定位），plain 为 Word 默认的 1.25cm。</summary>
    public double HeaderDistanceCm { get; private set; }
    public double MarginTopCm { get; private set; }
    public double MarginBottomCm { get; private set; }
    public ChromeHeaderText? HeaderText { get; private set; }
    public ChromeFooterText? FooterText { get; private set; }

    public bool HasHeaderImage => HeaderImagePath.Length > 0 && File.Exists(HeaderImagePath);
    public bool HasFooterImage => FooterImagePath.Length > 0 && File.Exists(FooterImagePath);
    /// <summary>调用方是否提供了几何；没有时沿用配置里的页边距。</summary>
    public bool HasLayout => MarginTopCm > 0 || MarginBottomCm > 0;

    static string Text(JsonElement parent, string name, string fallback = "")
        => parent.ValueKind == JsonValueKind.Object
            && parent.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.String
                ? value.GetString() ?? fallback
                : fallback;

    static double Number(JsonElement parent, string name, double fallback = 0)
        => parent.ValueKind == JsonValueKind.Object
            && parent.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.Number
                ? value.GetDouble()
                : fallback;

    static bool Bool(JsonElement parent, string name)
        => parent.ValueKind == JsonValueKind.Object
            && parent.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.True;

    static JsonElement Child(JsonElement parent, string name)
        => parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var value)
            ? value
            : default;

    /// <summary>读取共享布局的文字区域；null 表示使用普通段落。</summary>
    static ChromeTextBox? TextBox(JsonElement parent)
    {
        var box = Child(parent, "box");
        return box.ValueKind == JsonValueKind.Object
            ? new ChromeTextBox(Number(box, "startCm"), Number(box, "endCm"), Number(box, "topCm"), Number(box, "heightCm"))
            : null;
    }

    /// <summary>解析请求里的 chrome_assets；缺失或非法时返回 Empty，调用方回退到无装饰。</summary>
    public static ChromeAssets From(string workspace, JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object) return Empty;

        var root = Text(element, "root");
        var assets = new ChromeAssets
        {
            HeaderHeightCm = Number(element, "header_height_cm"),
            FooterHeightCm = Number(element, "footer_height_cm"),
            FooterTopCm = Number(element, "footer_top_cm"),
            FooterDistanceCm = Number(element, "footer_distance_cm"),
            HeaderDistanceCm = Number(element, "header_distance_cm", 1.25),
            MarginTopCm = Number(element, "margin_top_cm"),
            MarginBottomCm = Number(element, "margin_bottom_cm"),
        };

        if (root.Length > 0)
        {
            var dir = WordWorkspace.ResolveWorkspacePath(workspace, root);
            assets.HeaderImagePath = ResolveImage(dir, Text(element, "header"));
            assets.FooterImagePath = ResolveImage(dir, Text(element, "footer"));
        }

        var layout = Child(element, "text_layout");
        var header = Child(layout, "header");
        if (header.ValueKind == JsonValueKind.Object)
        {
            var badge = Child(header, "badge");
            assets.HeaderText = new ChromeHeaderText
            {
                Color = Text(header, "color"),
                Bold = Bool(header, "bold"),
                Align = Text(header, "align"),
                Box = TextBox(header),
                Badge = badge.ValueKind == JsonValueKind.Object
                    ? new ChromeHeaderText
                    {
                        Color = Text(badge, "color"),
                        Bold = Bool(badge, "bold"),
                        Align = Text(badge, "align"),
                        Box = TextBox(badge),
                    }
                    : null,
            };
        }

        var footer = Child(layout, "footer");
        if (footer.ValueKind == JsonValueKind.Object)
        {
            var pageNumber = Child(footer, "pageNumber");
            assets.FooterText = new ChromeFooterText
            {
                Color = Text(footer, "color"),
                Align = Text(footer, "align"),
                Box = TextBox(footer),
                PageNumberColor = Text(pageNumber, "color"),
                PageNumberShading = Text(pageNumber, "shadingFill"),
                PageNumberBold = Bool(pageNumber, "bold"),
                PageNumberAlign = Text(pageNumber, "align"),
                PageNumberBox = TextBox(pageNumber),
            };
        }

        return assets;
    }

    /// <summary>装饰图必须是目录内的普通文件名，拒绝路径穿越。</summary>
    static string ResolveImage(string directory, string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return "";
        if (!string.Equals(name, Path.GetFileName(name), StringComparison.Ordinal)) return "";
        var full = Path.Combine(directory, name);
        return File.Exists(full) ? full : "";
    }
}
