namespace Yibiao.OpenXmlHelper.BlindCheck.Rules;

/// <summary>规则注册表：按"隐私 → 结构 → 图片 → 页面 → 段落 → 字体 → 文本 → 表格 → 一致性"汇总，规则 ID 不可重复。</summary>
static class RuleCatalog
{
    public static readonly IReadOnlyList<RuleSpec> All = Build();

    static List<RuleSpec> Build()
    {
        var rules = PrivacyRules.All()
            .Concat(StructureRules.All())
            .Concat(ImageRules.All())
            .Concat(PageRules.All())
            .Concat(ParagraphRules.All())
            .Concat(FontRules.All())
            .Concat(TextRules.All())
            .Concat(TableRules.All())
            .Concat(ConsistencyRules.All())
            .ToList();
        var duplicate = rules.GroupBy(rule => rule.Id).FirstOrDefault(group => group.Count() > 1);
        if (duplicate is not null) throw new InvalidOperationException($"重复的规则 ID：{duplicate.Key}");
        return rules;
    }
}
