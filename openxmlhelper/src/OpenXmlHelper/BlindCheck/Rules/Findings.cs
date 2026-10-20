namespace Yibiao.OpenXmlHelper.BlindCheck.Rules;

/// <summary>严重度：high 可能直接废标（身份泄露等），medium 明确违反格式要求，low 需人工确认。</summary>
enum Severity
{
    High = 0,
    Medium = 1,
    Low = 2,
}

sealed class Finding
{
    public required string RuleId { get; init; }
    public required Severity Severity { get; init; }
    public required string Message { get; init; }
    public string Where { get; init; } = "全文";
    public string Text { get; init; } = "";
    public string Detail { get; init; } = "";
    public string Origin { get; init; } = "";
    public string Hint { get; init; } = "";
    /// <summary>段落定位编号（p12、t3.r2.c1 等），与标书结构导出和 Agent 编辑共用；全文类问题为空。</summary>
    public string Locator { get; init; } = "";
    /// <summary>候选问题：规则只能初筛，是否真的违反暗标要求交给 AI 复核判定。</summary>
    public bool Candidate { get; init; }
}

sealed class FindingSample
{
    public string Where { get; init; } = "";
    public string Text { get; init; } = "";
    public string Detail { get; init; } = "";
    public string Origin { get; init; } = "";
    public string Hint { get; init; } = "";
}

/// <summary>交给 AI 复核的定位条目：比样本多出段落编号，数量上限更高。</summary>
sealed class FindingItem
{
    public string Where { get; init; } = "";
    public string Text { get; init; } = "";
    public string Detail { get; init; } = "";
    public string Locator { get; init; } = "";
}

sealed class FindingGroup
{
    public string RuleId { get; init; } = "";
    public string RuleTitle { get; init; } = "";
    public string Category { get; init; } = "";
    public string Severity { get; init; } = "";
    public string Message { get; init; } = "";
    public bool Candidate { get; init; }
    public int Count { get; set; }
    public List<FindingSample> Samples { get; init; } = [];
    public List<FindingItem> Items { get; init; } = [];
}

/// <summary>
/// 按"规则 + 严重度 + 结论 + 是否候选"在线归并：一份标书原始发现可能有十几万条，
/// 每组只保留首尾分布的样本，其余折叠为数量；另按文档顺序保留前若干条带段落编号的定位条目供 AI 复核。
/// </summary>
sealed class FindingAggregator
{
    const int MaxSamples = 6;
    const int MaxItems = 200;

    sealed class Bucket
    {
        public required RuleSpec Rule { get; init; }
        public required Severity Severity { get; init; }
        public required string Message { get; init; }
        public required bool Candidate { get; init; }
        public int Count;
        public readonly List<Finding> Head = [];
        public readonly Queue<Finding> Tail = new();
        public readonly List<Finding> Items = [];
    }

    readonly Dictionary<string, Bucket> _buckets = new(StringComparer.Ordinal);

    public int Total { get; private set; }

    public void Add(RuleSpec rule, Finding finding)
    {
        var candidate = rule.Candidate || finding.Candidate;
        var key = $"{finding.RuleId}\u0001{(int)finding.Severity}\u0001{finding.Message}\u0001{candidate}";
        if (!_buckets.TryGetValue(key, out var bucket))
        {
            bucket = new Bucket { Rule = rule, Severity = finding.Severity, Message = finding.Message, Candidate = candidate };
            _buckets[key] = bucket;
        }

        bucket.Count += 1;
        Total += 1;
        if (bucket.Items.Count < MaxItems) bucket.Items.Add(finding);
        if (bucket.Head.Count < MaxSamples)
        {
            bucket.Head.Add(finding);
            return;
        }

        bucket.Tail.Enqueue(finding);
        if (bucket.Tail.Count > MaxSamples / 2) bucket.Tail.Dequeue();
    }

    public Dictionary<string, int> CountBySeverity()
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal) { ["high"] = 0, ["medium"] = 0, ["low"] = 0 };
        foreach (var bucket in _buckets.Values)
        {
            counts[SeverityName(bucket.Severity)] += bucket.Count;
        }

        return counts;
    }

    public List<FindingGroup> Groups()
    {
        return _buckets.Values
            .OrderBy(bucket => bucket.Severity)
            .ThenByDescending(bucket => bucket.Count)
            .ThenBy(bucket => bucket.Rule.Id, StringComparer.Ordinal)
            .Select(bucket => new FindingGroup
            {
                RuleId = bucket.Rule.Id,
                RuleTitle = bucket.Rule.Title,
                Category = bucket.Rule.Category,
                Severity = SeverityName(bucket.Severity),
                Message = bucket.Message,
                Candidate = bucket.Candidate,
                Count = bucket.Count,
                Samples = Samples(bucket),
                Items = bucket.Items.Select(item => new FindingItem { Where = item.Where, Text = item.Text, Detail = item.Detail, Locator = item.Locator }).ToList(),
            })
            .ToList();
    }

    /// <summary>样本覆盖文档首尾：超出上限时用末尾样本替换后一半。</summary>
    static List<FindingSample> Samples(Bucket bucket)
    {
        var findings = bucket.Tail.Count == 0
            ? bucket.Head
            : bucket.Head.Take(MaxSamples - bucket.Tail.Count).Concat(bucket.Tail).ToList();
        return findings.Select(item => new FindingSample
        {
            Where = item.Where,
            Text = item.Text,
            Detail = item.Detail,
            Origin = item.Origin,
            Hint = item.Hint,
        }).ToList();
    }

    public static string SeverityName(Severity severity) => severity switch
    {
        Severity.High => "high",
        Severity.Medium => "medium",
        _ => "low",
    };
}
