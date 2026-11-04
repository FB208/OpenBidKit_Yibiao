using DocumentFormat.OpenXml;

namespace Yibiao.OpenXmlHelper.Ooxml;

/// <summary>文档顺序：按开始标签出现的先后比较同一棵树里的两个元素，祖先排在后代之前。</summary>
static class DocumentOrder
{
    /// <summary>a 是否在 b 之前；不在同一棵树时返回 false。</summary>
    public static bool IsBefore(OpenXmlElement a, OpenXmlElement b) => Compare(a, b) < 0;

    /// <summary>a 是否在 b 之后；不在同一棵树时返回 false。</summary>
    public static bool IsAfter(OpenXmlElement a, OpenXmlElement b) => Compare(a, b) > 0;

    /// <summary>负数表示 a 在前，正数表示 a 在后，0 表示同一元素或不在同一棵树。</summary>
    public static int Compare(OpenXmlElement a, OpenXmlElement b)
    {
        if (ReferenceEquals(a, b)) return 0;
        var pathA = PathFromRoot(a);
        var pathB = PathFromRoot(b);
        if (!ReferenceEquals(pathA[0], pathB[0])) return 0;
        var depth = 0;
        while (depth < pathA.Count && depth < pathB.Count && ReferenceEquals(pathA[depth], pathB[depth])) depth += 1;
        // 一方是另一方的祖先：祖先在前。
        if (depth == pathA.Count) return -1;
        if (depth == pathB.Count) return 1;
        var parent = pathA[depth - 1];
        foreach (var child in parent.ChildElements)
        {
            if (ReferenceEquals(child, pathA[depth])) return -1;
            if (ReferenceEquals(child, pathB[depth])) return 1;
        }
        return 0;
    }

    /// <summary>根元素下全部后代（含根）按文档顺序的序号，批量比较时先建索引。</summary>
    public static Dictionary<OpenXmlElement, int> Index(OpenXmlElement root)
    {
        var index = new Dictionary<OpenXmlElement, int>(ReferenceEqualityComparer.Instance) { [root] = 0 };
        foreach (var element in root.Descendants()) index[element] = index.Count;
        return index;
    }

    /// <summary>元素所在树的最上层元素（部件根元素，或脱离文档的克隆容器）。</summary>
    public static OpenXmlElement Root(OpenXmlElement element)
    {
        var top = element;
        while (top.Parent is not null) top = top.Parent;
        return top;
    }

    static List<OpenXmlElement> PathFromRoot(OpenXmlElement element)
    {
        var path = new List<OpenXmlElement>();
        for (OpenXmlElement? node = element; node is not null; node = node.Parent) path.Add(node);
        path.Reverse();
        return path;
    }
}
