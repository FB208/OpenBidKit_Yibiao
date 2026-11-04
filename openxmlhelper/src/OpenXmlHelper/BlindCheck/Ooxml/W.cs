using System.Globalization;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using Yibiao.OpenXmlHelper.Ooxml;

namespace Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

/// <summary>命名空间；Ns + "p" 得到元素名，写法与原 LINQ to XML 版一致。</summary>
readonly record struct WNamespace(string Uri)
{
    public static WName operator +(WNamespace ns, string localName) => new(ns, localName);

    public static implicit operator WNamespace(string uri) => new(uri);

    public override string ToString() => Uri;
}

/// <summary>限定名，按命名空间和本地名比较；字符串隐式转换为无命名空间的名称（如 VML 属性 "fillcolor"）。</summary>
readonly record struct WName(WNamespace Namespace, string LocalName)
{
    public static implicit operator WName(string localName) => new(W.None, localName);

    public override string ToString() => $"{{{Namespace.Uri}}}{LocalName}";
}

/// <summary>属性名与原始字符串值；值不按 schema 解析，原件里的非法写法原样保留。</summary>
readonly record struct WAttribute(WName Name, string Value);

/// <summary>
/// 暗标检查读写 OOXML 用到的命名空间、元素名，以及在 OpenXML SDK 元素上按名称读取的扩展：
/// 读取一律按名称和原始字符串，不走强类型属性，保持原有的宽松解析；删除和移动经结构层（Ooxml/WordStructure）。
/// </summary>
static class W
{
    public static readonly WNamespace None = new("");
    public static readonly WNamespace Ns = new("http://schemas.openxmlformats.org/wordprocessingml/2006/main");
    public static readonly WNamespace R = new("http://schemas.openxmlformats.org/officeDocument/2006/relationships");
    public static readonly WNamespace A = new("http://schemas.openxmlformats.org/drawingml/2006/main");
    public static readonly WNamespace V = new("urn:schemas-microsoft-com:vml");
    public static readonly WNamespace Mc = new("http://schemas.openxmlformats.org/markup-compatibility/2006");
    public static readonly WNamespace XmlNs = new("http://www.w3.org/XML/1998/namespace");

    public static readonly WName Body = Ns + "body";
    public static readonly WName P = Ns + "p";
    public static readonly WName PPr = Ns + "pPr";
    public static readonly WName R_ = Ns + "r";
    public static readonly WName RPr = Ns + "rPr";
    public static readonly WName T = Ns + "t";
    public static readonly WName Tbl = Ns + "tbl";
    public static readonly WName TblPr = Ns + "tblPr";
    public static readonly WName TblStyle = Ns + "tblStyle";
    public static readonly WName Tr = Ns + "tr";
    public static readonly WName Tc = Ns + "tc";
    public static readonly WName TcPr = Ns + "tcPr";
    public static readonly WName Shd = Ns + "shd";
    public static readonly WName Sdt = Ns + "sdt";
    public static readonly WName SdtContent = Ns + "sdtContent";
    public static readonly WName CustomXml = Ns + "customXml";
    public static readonly WName SectPr = Ns + "sectPr";
    public static readonly WName PgSz = Ns + "pgSz";
    public static readonly WName PgMar = Ns + "pgMar";
    public static readonly WName Cols = Ns + "cols";
    public static readonly WName HeaderReference = Ns + "headerReference";
    public static readonly WName FooterReference = Ns + "footerReference";
    public static readonly WName PStyle = Ns + "pStyle";
    public static readonly WName RStyle = Ns + "rStyle";
    public static readonly WName Style = Ns + "style";
    public static readonly WName DocDefaults = Ns + "docDefaults";
    public static readonly WName RPrDefault = Ns + "rPrDefault";
    public static readonly WName PPrDefault = Ns + "pPrDefault";
    public static readonly WName Name = Ns + "name";
    public static readonly WName Aliases = Ns + "aliases";
    public static readonly WName BasedOn = Ns + "basedOn";
    public static readonly WName QFormat = Ns + "qFormat";
    public static readonly WName OutlineLvl = Ns + "outlineLvl";
    public static readonly WName NumPr = Ns + "numPr";
    public static readonly WName NumId = Ns + "numId";
    public static readonly WName Ilvl = Ns + "ilvl";
    public static readonly WName Tab = Ns + "tab";
    public static readonly WName Br = Ns + "br";
    public static readonly WName Cr = Ns + "cr";
    public static readonly WName NoBreakHyphen = Ns + "noBreakHyphen";
    public static readonly WName Sym = Ns + "sym";
    public static readonly WName Drawing = Ns + "drawing";
    public static readonly WName Pict = Ns + "pict";
    public static readonly WName Object = Ns + "object";
    public static readonly WName FldChar = Ns + "fldChar";
    public static readonly WName InstrText = Ns + "instrText";
    public static readonly WName FldSimple = Ns + "fldSimple";
    public static readonly WName Hyperlink = Ns + "hyperlink";
    public static readonly WName SmartTag = Ns + "smartTag";
    public static readonly WName Bdo = Ns + "bdo";
    public static readonly WName Dir = Ns + "dir";
    public static readonly WName Ins = Ns + "ins";
    public static readonly WName MoveTo = Ns + "moveTo";
    public static readonly WName TxbxContent = Ns + "txbxContent";
    // 真实 VML 写法是 v:textbox/w:txbxContent，不存在 v:txbxContent；沿用原判断（已知问题，见开发说明）。
    public static readonly WName VTxbxContent = V + "txbxContent";
    public static readonly WName McFallback = Mc + "Fallback";
    public static readonly WName Comment = Ns + "comment";

    public static readonly WName Val = Ns + "val";
    public static readonly WName Type = Ns + "type";
    public static readonly WName RId = R + "id";

    // 新写属性时用的前缀；已有元素上的属性沿用元素自己的命名空间声明。
    static readonly Dictionary<string, string> Prefixes = new(StringComparer.Ordinal)
    {
        [Ns.Uri] = "w",
        [R.Uri] = "r",
        [A.Uri] = "a",
        [V.Uri] = "v",
        [Mc.Uri] = "mc",
        ["urn:schemas-microsoft-com:office:office"] = "o",
        ["http://schemas.microsoft.com/office/word/2010/wordml"] = "w14",
        ["http://schemas.microsoft.com/office/word/2012/wordml"] = "w15",
        ["http://www.w3.org/XML/1998/namespace"] = "xml",
    };

    /// <summary>读取 w 命名空间下的属性值。</summary>
    public static string? Attr(OpenXmlElement? element, string localName) => element?.Attribute(Ns + localName)?.Value;

    public static string? ValOf(OpenXmlElement? element) => element?.Attribute(Val)?.Value;

    /// <summary>ST_OnOff：元素不存在返回 null；存在且未写 val 视为开启。</summary>
    public static bool? OnOff(OpenXmlElement? element)
    {
        if (element is null) return null;
        var value = element.Attribute(Val)?.Value;
        if (value is null) return true;
        return value is not ("false" or "0" or "off");
    }

    public static int? IntAttr(OpenXmlElement? element, string localName)
    {
        var raw = Attr(element, localName);
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (int.TryParse(raw, out var value)) return value;
        return double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var number)
            ? (int)number
            : null;
    }

    /// <summary>
    /// 按名称新建元素：以将要放入的父元素为上下文解析，得到与 SDK 读入时相同的强类型元素（同名在不同父元素下可能是不同类型）。
    /// content 可以是属性、子元素（已有父元素的会先克隆）或它们的序列。
    /// </summary>
    public static OpenXmlElement New(OpenXmlElement parent, WName name, params object?[] content)
    {
        var key = (parent.GetType(), name);
        if (!Prototypes.TryGetValue(key, out var prototype))
        {
            var parentPrefix = string.IsNullOrEmpty(parent.Prefix) ? PrefixOf(new WNamespace(parent.NamespaceUri)) : parent.Prefix;
            var childPrefix = PrefixOf(name.Namespace);
            var declarations = parentPrefix == childPrefix
                ? $"xmlns:{parentPrefix}=\"{parent.NamespaceUri}\""
                : $"xmlns:{parentPrefix}=\"{parent.NamespaceUri}\" xmlns:{childPrefix}=\"{name.Namespace.Uri}\"";
            var xml = $"<{parentPrefix}:{parent.LocalName} {declarations}><{childPrefix}:{name.LocalName}/></{parentPrefix}:{parent.LocalName}>";
            var holder = Activator.CreateInstance(parent.GetType(), xml) as OpenXmlElement
                ?? throw new InvalidOperationException($"无法在 {parent.LocalName} 下新建 {name.LocalName}");
            prototype = holder.FirstChild ?? throw new InvalidOperationException($"无法在 {parent.LocalName} 下新建 {name.LocalName}");
            Prototypes[key] = prototype;
        }
        var created = prototype.CloneNode(false);
        Append(created, content);
        return created;
    }

    static readonly Dictionary<(System.Type, WName), OpenXmlElement> Prototypes = [];

    // SDK 的 GetAttributes() 每次都把全部属性复制成新列表；按名称读属性时同一元素往往连读几个（如 rFonts 的各槽位），
    // 只缓存最近读过的一个元素。属性只经 SetAttributeValue 修改，修改时作废缓存。
    [ThreadStatic] static OpenXmlElement? _attributesOwner;
    [ThreadStatic] static IList<OpenXmlAttribute>? _attributes;

    internal static IList<OpenXmlAttribute> AttributesOf(OpenXmlElement element)
    {
        if (!ReferenceEquals(element, _attributesOwner) || _attributes is null)
        {
            _attributes = element.GetAttributes();
            _attributesOwner = element;
        }

        return _attributes;
    }

    internal static void AttributesChanged(OpenXmlElement element)
    {
        if (ReferenceEquals(element, _attributesOwner)) _attributesOwner = null;
    }

    /// <summary>
    /// 读取没有强类型根元素的部件（如 docProps/core.xml）：SDK 不认识的元素得到未知元素，文字和属性原样保留。
    /// </summary>
    public static OpenXmlElement LoadUntyped(OpenXmlPart part)
    {
        using var reader = OpenXmlReader.Create(part);
        while (reader.Read())
        {
            if (reader.IsStartElement) return reader.LoadCurrentElement() ?? throw new InvalidDataException($"{part.Uri} 没有根元素");
        }

        throw new InvalidDataException($"{part.Uri} 没有根元素");
    }

    /// <summary>
    /// 把一个 XML 元素片段解析成元素（SDK 不认识的得到未知元素，未知元素的文字只能这样写入）。
    /// SDK 没有公开解析未知元素的接口，借一个强类型宿主元素解析后取出其中的子元素。
    /// </summary>
    public static OpenXmlElement Parse(string xml)
    {
        var host = new DocumentFormat.OpenXml.Wordprocessing.Body($"<w:body xmlns:w=\"{Ns.Uri}\">{xml}</w:body>");
        return host.FirstChild?.CloneNode(true) ?? throw new InvalidDataException("XML 片段没有元素");
    }

    internal static string PrefixOf(WNamespace ns) =>
        ns.Uri.Length == 0 ? "" : Prefixes.TryGetValue(ns.Uri, out var prefix) ? prefix : "ns" + (Math.Abs(ns.Uri.GetHashCode()) % 1000);

    internal static IEnumerable<object> Flatten(object?[] content)
    {
        foreach (var item in content)
        {
            switch (item)
            {
                case null:
                    continue;
                case OpenXmlElement or WAttribute:
                    yield return item;
                    break;
                case System.Collections.IEnumerable sequence and not string:
                    foreach (var inner in Flatten(sequence.Cast<object?>().ToArray())) yield return inner;
                    break;
                default:
                    throw new ArgumentException($"不支持的内容类型：{item.GetType().Name}");
            }
        }
    }

    // 与 LINQ to XML 一致：加入已有父元素的元素时先克隆，原位置不动。
    internal static OpenXmlElement Detached(OpenXmlElement element) => element.Parent is null ? element : element.CloneNode(true);

    internal static void Append(OpenXmlElement target, object?[] content)
    {
        foreach (var item in Flatten(content))
        {
            if (item is WAttribute attribute) target.SetAttributeValue(attribute.Name, attribute.Value);
            else target.AppendChild(Detached((OpenXmlElement)item));
        }
    }
}

/// <summary>OpenXML SDK 元素上按名称读写的扩展，用法与原 LINQ to XML 版一致。</summary>
static class WElementExtensions
{
    extension(OpenXmlElement element)
    {
        public WName Name => new(new WNamespace(element.NamespaceUri), element.LocalName);

        /// <summary>全部后代文字（对应 XElement.Value）；只有 w:t、w:instrText 这类文字元素可以写入。</summary>
        public string Value
        {
            get => element.InnerText;
            set
            {
                if (element is not OpenXmlLeafTextElement text) throw new InvalidOperationException($"{element.LocalName} 不是文字元素");
                text.Text = value;
            }
        }

        public OpenXmlElement? Element(WName name) => element.ChildElements.FirstOrDefault(child => child.Name == name);

        public IEnumerable<OpenXmlElement> Elements(WName name) => element.ChildElements.Where(child => child.Name == name);

        public IEnumerable<OpenXmlElement> Descendants(WName name) => element.Descendants().Where(item => item.Name == name);

        public IEnumerable<OpenXmlElement> DescendantsAndSelf() => element.Descendants().Prepend(element);

        public IEnumerable<OpenXmlElement> DescendantsAndSelf(WName name) => element.DescendantsAndSelf().Where(item => item.Name == name);

        public IEnumerable<OpenXmlElement> Ancestors(WName name) => element.Ancestors().Where(item => item.Name == name);

        public IEnumerable<OpenXmlElement> AncestorsAndSelf() => element.Ancestors().Prepend(element);

        public IEnumerable<OpenXmlElement> AncestorsAndSelf(WName name) => element.AncestorsAndSelf().Where(item => item.Name == name);

        public IEnumerable<OpenXmlElement> ElementsAfterSelf() => element.ElementsAfter();

        public IEnumerable<OpenXmlElement> ElementsAfterSelf(WName name) => element.ElementsAfter().Where(item => item.Name == name);

        public IEnumerable<OpenXmlElement> ElementsBeforeSelf() => element.ElementsBefore();

        /// <summary>子节点；SDK 没有空白文字节点，与子元素相同。</summary>
        public IEnumerable<OpenXmlElement> Nodes() => element.ChildElements;

        public WAttribute? Attribute(WName name)
        {
            if (!element.HasAttributes) return null;
            foreach (var attribute in W.AttributesOf(element))
            {
                if (attribute.LocalName == name.LocalName && attribute.NamespaceUri == name.Namespace.Uri) return new WAttribute(name, attribute.Value ?? "");
            }
            return null;
        }

        public IEnumerable<WAttribute> Attributes() =>
            element.HasAttributes
                ? W.AttributesOf(element).Select(attribute => new WAttribute(new WName(new WNamespace(attribute.NamespaceUri), attribute.LocalName), attribute.Value ?? ""))
                : [];

        /// <summary>写属性；value 为 null 时删除该属性。</summary>
        public void SetAttributeValue(WName name, object? value)
        {
            W.AttributesChanged(element);
            if (value is null)
            {
                if (element.Attribute(name) is not null) element.RemoveAttribute(name.LocalName, name.Namespace.Uri);
                return;
            }
            var text = Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
            element.SetAttribute(new OpenXmlAttribute(W.PrefixOf(name.Namespace), name.LocalName, name.Namespace.Uri, text));
        }

        public bool IsAfter(OpenXmlElement other) => DocumentOrder.IsAfter(element, other);

        public bool IsBefore(OpenXmlElement other) => DocumentOrder.IsBefore(element, other);

        public void Add(params object?[] content) => W.Append(element, content);

        public void AddFirst(params object?[] content)
        {
            OpenXmlElement? previous = null;
            foreach (var item in W.Flatten(content))
            {
                if (item is WAttribute attribute)
                {
                    element.SetAttributeValue(attribute.Name, attribute.Value);
                    continue;
                }
                var child = W.Detached((OpenXmlElement)item);
                if (previous is null) element.PrependChild(child);
                else previous.InsertAfterSelf(child);
                previous = child;
            }
        }

        public void AddBeforeSelf(params object?[] content)
        {
            foreach (var item in W.Flatten(content).OfType<OpenXmlElement>()) element.InsertBeforeSelf(W.Detached(item));
        }

        public void AddAfterSelf(params object?[] content)
        {
            var anchor = element;
            foreach (var item in W.Flatten(content).OfType<OpenXmlElement>())
            {
                var child = W.Detached(item);
                anchor.InsertAfterSelf(child);
                anchor = child;
            }
        }

        /// <summary>删除全部子节点（经结构层）。</summary>
        public void RemoveNodes() => WordStructure.RemoveRange(element.ChildElements.ToList());

        public void ReplaceNodes(params object?[] content)
        {
            element.RemoveNodes();
            W.Append(element, content);
        }
    }

    extension(IEnumerable<OpenXmlElement> elements)
    {
        public IEnumerable<OpenXmlElement> Elements(WName name) => elements.SelectMany(element => element.Elements(name));

        public IEnumerable<OpenXmlElement> Descendants(WName name) => elements.SelectMany(element => element.Descendants(name));

        public IEnumerable<OpenXmlElement> DescendantsAndSelf() => elements.SelectMany(element => element.DescendantsAndSelf());
    }
}
