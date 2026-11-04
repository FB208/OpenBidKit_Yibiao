using System.Globalization;
using DocumentFormat.OpenXml;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;
using Yibiao.OpenXmlHelper.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Fix;

/// <summary>
/// 写属性元素。新元素按将要放入的父元素解析成 SDK 强类型元素，再由 SDK 按 schema 顺序插入（AddChild）：
/// w:rPr / w:pPr / w:sectPr / w:lvl 的子元素是有序序列，直接追加会让 Word 报"文件已损坏"或静默丢弃格式。
/// SDK 不认识的父元素（WPS 扩展等）里只能追加到末尾。
/// </summary>
static class PropertyWriter
{
    static readonly WName XmlSpace = W.XmlNs + "space";

    public static string Number(double value) => Math.Round(value).ToString(CultureInfo.InvariantCulture);

    /// <summary>取得或按 schema 顺序插入名为 name 的子元素。</summary>
    static OpenXmlElement Child(OpenXmlElement parent, WName name)
    {
        var existing = parent.Element(name);
        if (existing is not null) return existing;
        return Insert(parent, W.New(parent, name));
    }

    /// <summary>把元素按 schema 顺序插入 parent；SDK 不认识的位置追加到末尾。</summary>
    public static OpenXmlElement Insert(OpenXmlElement parent, OpenXmlElement child)
    {
        if (parent is not OpenXmlCompositeElement composite || !composite.AddChild(child, throwOnError: false)) parent.AppendChild(child);
        return child;
    }

    static OpenXmlElement RunProperties(OpenXmlElement run) => Child(run, W.RPr);

    public static OpenXmlElement ParagraphProperties(OpenXmlElement paragraph) => Child(paragraph, W.PPr);

    public static OpenXmlElement RunChild(OpenXmlElement run, string name) => Child(RunProperties(run), W.Ns + name);

    public static OpenXmlElement ParagraphChild(OpenXmlElement paragraph, string name) => Child(ParagraphProperties(paragraph), W.Ns + name);

    public static OpenXmlElement SectionChild(OpenXmlElement section, string name) => Child(section, W.Ns + name);

    /// <summary>编号级别定义（w:lvl）的子元素。</summary>
    public static OpenXmlElement LevelChild(OpenXmlElement level, string name) => Child(level, W.Ns + name);

    public static void SetAttr(OpenXmlElement element, string name, string? value)
    {
        element.SetAttributeValue(W.Ns + name, value);
    }

    public static void SetVal(OpenXmlElement element, string? value) => SetAttr(element, "val", value);

    /// <summary>
    /// 开关属性：开启写 &lt;w:b/&gt;；关闭写 &lt;w:b w:val="0"/&gt;。
    /// 不能用删除属性来关闭，格式从样式继承时删掉文本块上的属性也关不掉。
    /// </summary>
    public static void SetRunToggle(OpenXmlElement run, string name, bool on)
    {
        var element = RunChild(run, name);
        SetVal(element, on ? null : "0");
    }

    public static void SetRunValue(OpenXmlElement run, string name, string value)
    {
        SetVal(RunChild(run, name), value);
    }

    /// <summary>设置字体槽位并去掉同槽位的主题字体，主题字体优先于显式字体。</summary>
    public static void SetRunFonts(OpenXmlElement run, string? eastAsia = null, string? latin = null)
    {
        var fonts = RunChild(run, "rFonts");
        if (eastAsia is not null)
        {
            SetAttr(fonts, "eastAsia", eastAsia);
            SetAttr(fonts, "eastAsiaTheme", null);
        }

        if (latin is not null)
        {
            SetAttr(fonts, "ascii", latin);
            SetAttr(fonts, "hAnsi", latin);
            SetAttr(fonts, "asciiTheme", null);
            SetAttr(fonts, "hAnsiTheme", null);
        }
    }

    public static void SetRunSize(OpenXmlElement run, double pt)
    {
        var half = (pt * 2).ToString("0.##", CultureInfo.InvariantCulture);
        SetRunValue(run, "sz", half);
        SetRunValue(run, "szCs", half);
    }

    public static void SetRunColorBlack(OpenXmlElement run)
    {
        var color = RunChild(run, "color");
        SetVal(color, "000000");
        foreach (var name in new[] { "themeColor", "themeShade", "themeTint" }) SetAttr(color, name, null);
    }

    public static void SetParagraphToggle(OpenXmlElement paragraph, string name, bool on)
    {
        SetVal(ParagraphChild(paragraph, name), on ? null : "0");
    }

    public static void SetTextValue(OpenXmlElement text, string value)
    {
        text.Value = value;
        if (value.Length > 0 && (char.IsWhiteSpace(value[0]) || char.IsWhiteSpace(value[^1]))) text.SetAttributeValue(XmlSpace, "preserve");
    }

    /// <summary>删除只剩属性容器的文本块，避免留下空 w:r。</summary>
    public static void RemoveIfEmptyRun(OpenXmlElement? run)
    {
        if (run is null || run.Name != W.R_ || run.Parent is null) return;
        if (run.Elements().All(item => item.Name == W.RPr)) WordStructure.Remove(run);
    }
}
