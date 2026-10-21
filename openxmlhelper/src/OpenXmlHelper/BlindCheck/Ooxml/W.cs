using System.Xml.Linq;

namespace Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

/// <summary>暗标检查读取 OOXML 时用到的命名空间与元素名。</summary>
static class W
{
    public static readonly XNamespace Ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    public static readonly XNamespace R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    public static readonly XNamespace A = "http://schemas.openxmlformats.org/drawingml/2006/main";
    public static readonly XNamespace V = "urn:schemas-microsoft-com:vml";
    public static readonly XNamespace Mc = "http://schemas.openxmlformats.org/markup-compatibility/2006";
    public static readonly XNamespace PackageRel = "http://schemas.openxmlformats.org/package/2006/relationships";

    public static readonly XName Body = Ns + "body";
    public static readonly XName P = Ns + "p";
    public static readonly XName PPr = Ns + "pPr";
    public static readonly XName R_ = Ns + "r";
    public static readonly XName RPr = Ns + "rPr";
    public static readonly XName T = Ns + "t";
    public static readonly XName Tbl = Ns + "tbl";
    public static readonly XName TblPr = Ns + "tblPr";
    public static readonly XName TblStyle = Ns + "tblStyle";
    public static readonly XName Tr = Ns + "tr";
    public static readonly XName Tc = Ns + "tc";
    public static readonly XName TcPr = Ns + "tcPr";
    public static readonly XName Shd = Ns + "shd";
    public static readonly XName Sdt = Ns + "sdt";
    public static readonly XName SdtContent = Ns + "sdtContent";
    public static readonly XName CustomXml = Ns + "customXml";
    public static readonly XName SectPr = Ns + "sectPr";
    public static readonly XName PgSz = Ns + "pgSz";
    public static readonly XName PgMar = Ns + "pgMar";
    public static readonly XName Cols = Ns + "cols";
    public static readonly XName HeaderReference = Ns + "headerReference";
    public static readonly XName FooterReference = Ns + "footerReference";
    public static readonly XName PStyle = Ns + "pStyle";
    public static readonly XName RStyle = Ns + "rStyle";
    public static readonly XName Style = Ns + "style";
    public static readonly XName DocDefaults = Ns + "docDefaults";
    public static readonly XName RPrDefault = Ns + "rPrDefault";
    public static readonly XName PPrDefault = Ns + "pPrDefault";
    public static readonly XName Name = Ns + "name";
    public static readonly XName Aliases = Ns + "aliases";
    public static readonly XName BasedOn = Ns + "basedOn";
    public static readonly XName QFormat = Ns + "qFormat";
    public static readonly XName OutlineLvl = Ns + "outlineLvl";
    public static readonly XName NumPr = Ns + "numPr";
    public static readonly XName NumId = Ns + "numId";
    public static readonly XName Ilvl = Ns + "ilvl";
    public static readonly XName Tab = Ns + "tab";
    public static readonly XName Br = Ns + "br";
    public static readonly XName Cr = Ns + "cr";
    public static readonly XName NoBreakHyphen = Ns + "noBreakHyphen";
    public static readonly XName SoftHyphen = Ns + "softHyphen";
    public static readonly XName Sym = Ns + "sym";
    public static readonly XName DelText = Ns + "delText";
    public static readonly XName Drawing = Ns + "drawing";
    public static readonly XName Pict = Ns + "pict";
    public static readonly XName Object = Ns + "object";
    public static readonly XName FldChar = Ns + "fldChar";
    public static readonly XName InstrText = Ns + "instrText";
    public static readonly XName FldSimple = Ns + "fldSimple";
    public static readonly XName Hyperlink = Ns + "hyperlink";
    public static readonly XName SmartTag = Ns + "smartTag";
    public static readonly XName Bdo = Ns + "bdo";
    public static readonly XName Dir = Ns + "dir";
    public static readonly XName Ins = Ns + "ins";
    public static readonly XName Del = Ns + "del";
    public static readonly XName MoveFrom = Ns + "moveFrom";
    public static readonly XName MoveTo = Ns + "moveTo";
    public static readonly XName TxbxContent = Ns + "txbxContent";
    public static readonly XName VTxbxContent = V + "txbxContent";
    public static readonly XName McFallback = Mc + "Fallback";
    public static readonly XName Comment = Ns + "comment";

    public static readonly XName Val = Ns + "val";
    public static readonly XName Type = Ns + "type";
    public static readonly XName StyleId = Ns + "styleId";
    public static readonly XName RId = R + "id";

    /// <summary>读取 w 命名空间下的属性值。</summary>
    public static string? Attr(XElement? element, string localName)
    {
        return element?.Attribute(Ns + localName)?.Value;
    }

    public static string? ValOf(XElement? element)
    {
        return element?.Attribute(Val)?.Value;
    }

    /// <summary>ST_OnOff：元素不存在返回 null；存在且未写 val 视为开启。</summary>
    public static bool? OnOff(XElement? element)
    {
        if (element is null) return null;
        var value = element.Attribute(Val)?.Value;
        if (value is null) return true;
        return value is not ("false" or "0" or "off");
    }

    public static int? IntAttr(XElement? element, string localName)
    {
        var raw = Attr(element, localName);
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (int.TryParse(raw, out var value)) return value;
        return double.TryParse(raw, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var number)
            ? (int)number
            : null;
    }
}
