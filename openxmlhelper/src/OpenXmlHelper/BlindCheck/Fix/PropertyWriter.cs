using System.Globalization;
using System.Xml.Linq;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Fix;

/// <summary>
/// 按 schema 顺序写属性元素。w:rPr / w:pPr / w:sectPr / w:tcPr / w:lvl 的子元素是有序序列，
/// 直接追加会让 Word 报"文件已损坏"或静默丢弃格式。不认识的子元素（WPS、w14 扩展等）视为排在最后，原位保留。
/// </summary>
static class PropertyWriter
{
    // ECMA-376 Part 1：CT_RPr（17.3.2.28）
    static readonly string[] RunOrder =
    [
        "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow",
        "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern",
        "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs",
        "em", "lang", "eastAsianLayout", "specVanish", "oMath", "ins", "del", "moveFrom", "moveTo", "rPrChange",
    ];

    // CT_PPr（17.3.1.26）
    static readonly string[] ParagraphOrder =
    [
        "pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl", "numPr",
        "suppressLineNumbers", "pBdr", "shd", "tabs", "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct",
        "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd", "snapToGrid", "spacing", "ind",
        "contextualSpacing", "mirrorIndents", "suppressOverlap", "jc", "textDirection", "textAlignment",
        "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr", "sectPr", "pPrChange",
    ];

    // CT_SectPr（17.6.17）
    static readonly string[] SectionOrder =
    [
        "headerReference", "footerReference", "footnotePr", "endnotePr", "type", "pgSz", "pgMar", "paperSrc",
        "pgBorders", "lnNumType", "pgNumType", "cols", "formProt", "vAlign", "noEndnote", "titlePg", "textDirection",
        "bidi", "rtlGutter", "docGrid", "printerSettings", "sectPrChange",
    ];

    // CT_TcPr（17.4.70）
    static readonly string[] CellOrder =
    [
        "cnfStyle", "tcW", "gridSpan", "hMerge", "vMerge", "tcBorders", "shd", "noWrap", "tcMar", "textDirection",
        "tcFitText", "vAlign", "hideMark", "headers", "cellIns", "cellDel", "cellMerge", "tcPrChange",
    ];

    // CT_Lvl（17.9.6）
    static readonly string[] LevelOrder =
    [
        "start", "numFmt", "lvlRestart", "pStyle", "isLgl", "suff", "lvlText", "lvlPicBulletId", "legacy", "lvlJc", "pPr", "rPr",
    ];

    static readonly Dictionary<string, int> RunIndex = Index(RunOrder);
    static readonly Dictionary<string, int> ParagraphIndex = Index(ParagraphOrder);
    static readonly Dictionary<string, int> SectionIndex = Index(SectionOrder);
    static readonly Dictionary<string, int> CellIndex = Index(CellOrder);
    static readonly Dictionary<string, int> LevelIndex = Index(LevelOrder);

    static Dictionary<string, int> Index(string[] order) => order.Select((name, index) => (name, index)).ToDictionary(item => item.name, item => item.index, StringComparer.Ordinal);

    static readonly XName XmlSpace = XNamespace.Xml + "space";

    public static string Number(double value) => Math.Round(value).ToString(CultureInfo.InvariantCulture);

    /// <summary>取得或创建属性容器（rPr / pPr / tcPr），容器是父元素的第一个子元素。</summary>
    static XElement Container(XElement parent, XName name)
    {
        var existing = parent.Element(name);
        if (existing is not null) return existing;
        var created = new XElement(name);
        parent.AddFirst(created);
        return created;
    }

    public static XElement RunProperties(XElement run) => Container(run, W.RPr);

    public static XElement ParagraphProperties(XElement paragraph) => Container(paragraph, W.PPr);

    public static XElement CellProperties(XElement cell) => Container(cell, W.TcPr);

    /// <summary>取得或按顺序插入名为 name 的子元素。</summary>
    static XElement Child(XElement container, string name, Dictionary<string, int> order)
    {
        var xname = W.Ns + name;
        var existing = container.Element(xname);
        if (existing is not null) return existing;
        var created = new XElement(xname);
        var target = order.GetValueOrDefault(name, int.MaxValue);
        var after = container.Elements().FirstOrDefault(item => item.Name.Namespace != W.Ns || order.GetValueOrDefault(item.Name.LocalName, int.MaxValue) > target);
        if (after is null) container.Add(created);
        else after.AddBeforeSelf(created);
        return created;
    }

    public static XElement RunChild(XElement run, string name) => Child(RunProperties(run), name, RunIndex);

    public static XElement ParagraphChild(XElement paragraph, string name) => Child(ParagraphProperties(paragraph), name, ParagraphIndex);

    public static XElement SectionChild(XElement section, string name) => Child(section, name, SectionIndex);

    public static XElement CellChild(XElement cell, string name) => Child(CellProperties(cell), name, CellIndex);

    /// <summary>编号级别定义（w:lvl）的子元素。</summary>
    public static XElement LevelChild(XElement level, string name) => Child(level, name, LevelIndex);

    public static void SetAttr(XElement element, string name, string? value)
    {
        element.SetAttributeValue(W.Ns + name, value);
    }

    public static void SetVal(XElement element, string? value) => SetAttr(element, "val", value);

    /// <summary>
    /// 开关属性：开启写 &lt;w:b/&gt;；关闭写 &lt;w:b w:val="0"/&gt;。
    /// 不能用删除属性来关闭，格式从样式继承时删掉文本块上的属性也关不掉。
    /// </summary>
    public static void SetRunToggle(XElement run, string name, bool on)
    {
        var element = RunChild(run, name);
        SetVal(element, on ? null : "0");
    }

    public static void SetRunValue(XElement run, string name, string value)
    {
        SetVal(RunChild(run, name), value);
    }

    /// <summary>设置字体槽位并去掉同槽位的主题字体，主题字体优先于显式字体。</summary>
    public static void SetRunFonts(XElement run, string? eastAsia = null, string? latin = null)
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

    public static void SetRunSize(XElement run, double pt)
    {
        var half = (pt * 2).ToString("0.##", CultureInfo.InvariantCulture);
        SetRunValue(run, "sz", half);
        SetRunValue(run, "szCs", half);
    }

    public static void SetRunColorBlack(XElement run)
    {
        var color = RunChild(run, "color");
        SetVal(color, "000000");
        foreach (var name in new[] { "themeColor", "themeShade", "themeTint" }) SetAttr(color, name, null);
    }

    public static void SetParagraphToggle(XElement paragraph, string name, bool on)
    {
        SetVal(ParagraphChild(paragraph, name), on ? null : "0");
    }

    public static void SetTextValue(XElement text, string value)
    {
        text.Value = value;
        if (value.Length > 0 && (char.IsWhiteSpace(value[0]) || char.IsWhiteSpace(value[^1]))) text.SetAttributeValue(XmlSpace, "preserve");
    }

    /// <summary>删除只剩属性容器的文本块，避免留下空 w:r。</summary>
    public static void RemoveIfEmptyRun(XElement? run)
    {
        if (run is null || run.Name != W.R_ || run.Parent is null) return;
        if (run.Elements().All(item => item.Name == W.RPr)) run.Remove();
    }
}
