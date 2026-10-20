using System.Text.RegularExpressions;
using Yibiao.OpenXmlHelper.BlindCheck.Model;

namespace Yibiao.OpenXmlHelper.BlindCheck.Rules;

/// <summary>
/// 匿名性检查：敏感词、自称、企业名称、联系方式、证件号、网址、占位符。
/// 内置检测器都带上下文校验压误报：企业名只认强后缀，证件号做校验位计算，
/// 招标人、监理、供电公司等第三方默认忽略。
/// </summary>
static class PrivacyRules
{
    const int MaxFindings = 3000;

    static readonly string[] SelfReferences = ["我公司", "我司", "本公司", "我单位", "本单位", "我集团", "我厂", "我企业"];

    /// <summary>表单字段名：只有写成"联系电话：""单位名称:"或单独占一个单元格时才是待填字段，正文叙述里出现不报。</summary>
    static readonly string[] FieldLabels =
    [
        "投标人名称", "公司名称", "企业名称", "单位名称", "供应商名称", "联系地址", "联系电话", "联系人",
        "传真", "邮政编码", "营业执照", "资质证书编号", "开户行", "开户银行",
    ];

    static readonly string[] MarkLabels = ["版权所有", "copyright", "©", "®", "™"];

    static readonly string[] DefaultIgnoreOrgs =
    [
        "供电公司", "供电局", "招标人", "招标代理", "招标方", "采购人", "业主", "监理公司", "监理单位",
        "设计院", "检测机构", "质检站", "供电所", "人民政府", "建设局", "发改委", "财政局", "公共资源交易中心",
    ];

    static readonly string[] StrongSuffixes = new[]
    {
        "股份有限公司", "有限责任公司", "集团有限公司", "有限公司", "设计研究院", "勘察设计院", "设计院", "研究院",
        "研究所", "事务所", "工程有限公司", "科技有限公司", "建设有限公司", "电气有限公司", "实业有限公司",
        "机电有限公司", "安装有限公司", "建工有限公司",
    }.OrderByDescending(item => item.Length).ToArray();

    static readonly Regex StrongCompany = new($"[\u4E00-\u9FFFA-Za-z0-9]{{2,30}}(?:{string.Join("|", StrongSuffixes)})");
    static readonly Regex FunctionWords = new(
        "(通过|由于|经过|根据|按照|采用|负责|组织|实施|验收|施工|管理|以及|或者|并且|进行|完成|确保|满足|符合|达到|提供|使用|建立|"
        + "邀请|委托|聘请|聘用|选择|选定|指定|配合|协调|联系|"
        + "的|和|与|及|或|等|由|向|至|于|在|为|以|对|从|按|如|因|是|也|凡|把|将|让|使|被|给|同|跟)");

    /// <summary>泛指的机构修饰与行业词：去掉后不剩专名的（如"第三方会计师事务所""专业检测有限公司"）不是具体企业。</summary>
    static readonly Regex GenericOrgWords = new(
        "(第三方|专业|相关|其他|其它|外部|独立|当地|本地|知名|权威|合格|有资质|具备资质|具有资质|"
        + "会计师|律师|审计|检测|监理|造价|咨询|设计|勘察|评估|测绘|鉴定|认证|质量|环境|安全|工程|技术)");
    static readonly Regex Mobile = new("(?<![0-9])1[3-9][0-9]{9}(?![0-9])");
    static readonly Regex Landline = new(@"(?<![0-9])(?:0[0-9]{2,3}[-\s]?)[0-9]{7,8}(?![0-9])");
    static readonly Regex IdCard = new("(?<![0-9Xx])([0-9]{17}[0-9Xx])(?![0-9Xx])");
    static readonly Regex CreditCode = new("(?<![0-9A-Za-z])([0-9A-HJ-NPQRTUWXY]{2}[0-9]{6}[0-9A-HJ-NPQRTUWXY]{10})(?![0-9A-Za-z])");
    static readonly Regex Email = new("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}");
    static readonly Regex Url = new(@"(?:https?://|www\.)[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+", RegexOptions.IgnoreCase);
    static readonly Regex Domain = new(@"(?<![\w.@-])([A-Za-z0-9-]{2,}\.(?:com\.cn|cn\.com|com|cn|net|org|edu|gov))(?![\w.-])", RegexOptions.IgnoreCase);
    static readonly Regex BankAccount = new("(?<![0-9])([0-9]{16,25})(?![0-9])");
    static readonly Regex Placeholder = new(@"[\[【（(]\s*(?:填写|输入|待填|此处填写|XXX+|xxx+|某某|某公司|公司名称|单位名称)[^\])）】]*[\])）】]");
    static readonly Regex PlaceholderMarks = new("[×xX＊*]{2,}|＿{2,}|_{3,}");

    const string CreditCodeChars = "0123456789ABCDEFGHJKLMNPQRTUWXY";
    static readonly int[] CreditCodeWeights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
    static readonly int[] IdWeights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const string IdCheckChars = "10X98765432";

    public sealed record Hit(string Kind, string Value, int Index, string Message, Severity Severity, string? Source = null);

    static readonly HashSet<string> IdentityKinds = ["word", "company", "phone", "id", "uscc", "email", "url", "regex"];

    /// <summary>
    /// 只能初筛的命中：按后缀识别的企业名可能是招标人、监理等第三方，表单字段名、长数字串、占位符要看上下文，
    /// 交给 AI 复核判定；敏感词、自称、联系方式、证件号等是确定的事实，由程序直接下结论。
    /// </summary>
    static readonly HashSet<string> CandidateKinds = ["company", "label", "bank", "placeholder"];

    public static IEnumerable<RuleSpec> All()
    {
        yield return new RuleSpec { Id = "privacy.keyword", Title = "敏感信息/身份泄露", Category = "privacy", Severity = Severity.High, Whole = Check };
    }

    static IEnumerable<Finding> Check(RuleContext context, RuleSpec rule)
    {
        var profile = context.Profile;
        var whitelist = profile.Strings("privacy.whitelist");
        var ignoreOrgs = profile.Strings("privacy.ignore_orgs").Concat(DefaultIgnoreOrgs).ToList();
        var userPatterns = profile.Strings("privacy.regex").Select(TryRegex).Where(item => item is not null).Cast<Regex>().ToList();
        var builtin = profile.Bool("privacy.enable_builtin", true);

        var targets = context.Groups.Body
            .Concat(context.Groups.Cover)
            .Concat(context.Groups.Table)
            .Concat(context.Model.TextboxParagraphs)
            .Concat(context.Model.HeaderParagraphs)
            .Concat(context.Model.FooterParagraphs)
            .Concat(context.Model.NoteParagraphs);
        if (profile.Bool("privacy.check_toc", true)) targets = targets.Concat(context.Groups.Toc);

        var count = 0;
        foreach (var record in targets)
        {
            if (string.IsNullOrWhiteSpace(record.Text)) continue;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var words = new List<string>();
            foreach (var hit in Scan(record.Text, context, whitelist, ignoreOrgs, userPatterns, builtin, record.Container.InTable))
            {
                if (!seen.Add(hit.Kind + "\u0001" + hit.Value)) continue;
                // 同一段里已报的敏感词（含资信库信息）覆盖的内容不再重复报：企业简称随全称一起出现、内置检测器命中同一处时都跳过。
                if (words.Any(word => word.Contains(hit.Value, StringComparison.OrdinalIgnoreCase) || hit.Value.Contains(word, StringComparison.OrdinalIgnoreCase))) continue;
                if (hit.Kind == "word") words.Add(hit.Value);
                yield return context.At(rule, record, hit.Message, Detail(hit), Hint(hit.Kind), severity: hit.Severity,
                    text: RuleContext.Snippet(record.Text, hit.Index, hit.Value.Length), candidate: CandidateKinds.Contains(hit.Kind));
                count += 1;
                if (count >= MaxFindings) yield break;
            }
        }
    }

    /// <summary>
    /// 图片元数据、矢量图文字等非正文内容只取能直接识别投标人的命中：
    /// 敏感词、企业名称、联系方式、证件号、网址和自定义规则，不含自称、表单字段和占位符。
    /// </summary>
    public static List<Hit> IdentityHits(RuleContext context, string text)
    {
        var profile = context.Profile;
        var hits = new List<Hit>();
        if (string.IsNullOrWhiteSpace(text)) return hits;
        var ignoreOrgs = profile.Strings("privacy.ignore_orgs").Concat(DefaultIgnoreOrgs).ToList();
        var userPatterns = profile.Strings("privacy.regex").Select(TryRegex).Where(item => item is not null).Cast<Regex>().ToList();
        var words = new List<string>();
        foreach (var hit in Scan(text, context, profile.Strings("privacy.whitelist"), ignoreOrgs, userPatterns, false))
        {
            if (!IdentityKinds.Contains(hit.Kind)) continue;
            if (words.Any(word => word.Contains(hit.Value, StringComparison.OrdinalIgnoreCase) || hit.Value.Contains(word, StringComparison.OrdinalIgnoreCase))) continue;
            if (hit.Kind == "word") words.Add(hit.Value);
            if (hits.Any(item => item.Kind == hit.Kind && item.Value == hit.Value)) continue;
            hits.Add(hit);
        }

        return hits;
    }

    static Regex? TryRegex(string pattern)
    {
        try
        {
            return new Regex(pattern, RegexOptions.None, TimeSpan.FromMilliseconds(200));
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    static bool Whitelisted(IReadOnlyList<string> whitelist, string value)
    {
        return whitelist.Any(item => string.Equals(item, value, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>字段名后面紧跟冒号，或单元格里基本只有这个字段名，才算待填字段；返回位置，不是字段时返回 -1。</summary>
    static int FieldLabelIndex(string text, string label, bool isCell)
    {
        if (isCell && text.Trim().TrimEnd(':', '：').Trim().Length <= label.Length + 2 && text.Contains(label, StringComparison.Ordinal))
        {
            return text.IndexOf(label, StringComparison.Ordinal);
        }

        for (var index = text.IndexOf(label, StringComparison.Ordinal); index >= 0; index = text.IndexOf(label, index + label.Length, StringComparison.Ordinal))
        {
            var after = text[(index + label.Length)..].TrimStart(' ', '\t', (char)0x3000);
            if (after.StartsWith(':') || after.StartsWith('：')) return index;
        }

        return -1;
    }

    static IEnumerable<Hit> Scan(string text, RuleContext context, IReadOnlyList<string> whitelist, IReadOnlyList<string> ignoreOrgs, IReadOnlyList<Regex> userPatterns, bool builtin, bool isCell = false)
    {
        var profile = context.Profile;
        foreach (var word in context.SensitiveWords)
        {
            var index = text.IndexOf(word.Text, StringComparison.OrdinalIgnoreCase);
            if (index < 0 || Whitelisted(whitelist, word.Text)) continue;
            yield return new Hit("word", word.Text, index, $"出现敏感词「{word.Text}」", Severity.High, word.Source);
        }

        if (builtin)
        {
            foreach (var word in SelfReferences)
            {
                var index = text.IndexOf(word, StringComparison.Ordinal);
                if (index >= 0 && !Whitelisted(whitelist, word)) yield return new Hit("self", word, index, $"出现自称「{word}」", Severity.Medium);
            }

            foreach (var label in FieldLabels)
            {
                var index = FieldLabelIndex(text, label, isCell);
                if (index >= 0 && !Whitelisted(whitelist, label)) yield return new Hit("label", label, index, $"出现敏感字段「{label}」", Severity.Low);
            }

            foreach (var label in MarkLabels)
            {
                var index = text.IndexOf(label, StringComparison.OrdinalIgnoreCase);
                if (index >= 0 && !Whitelisted(whitelist, label)) yield return new Hit("label", label, index, $"出现敏感字段「{label}」", Severity.Low);
            }
        }

        foreach (var pattern in userPatterns)
        {
            foreach (Match match in SafeMatches(pattern, text))
            {
                if (match.Length == 0 || Whitelisted(whitelist, match.Value)) continue;
                yield return new Hit("regex", match.Value, match.Index, $"命中自定义规则「{RuleContext.Truncate(match.Value, 30)}」", Severity.High);
            }
        }

        if (profile.Bool("privacy.check_company_suffix", true))
        {
            foreach (var (name, index) in CompanyCandidates(text, ignoreOrgs))
            {
                if (Whitelisted(whitelist, name) || whitelist.Any(item => item.Length > 0 && name.Contains(item, StringComparison.OrdinalIgnoreCase))) continue;
                yield return new Hit("company", name, index, $"出现企业名称「{name}」", Severity.High);
            }
        }

        var idNumbers = new HashSet<string>(StringComparer.Ordinal);
        if (profile.Bool("privacy.check_phone", true))
        {
            foreach (Match match in Mobile.Matches(text))
            {
                if (!Whitelisted(whitelist, match.Value)) yield return new Hit("phone", match.Value, match.Index, $"出现手机号「{match.Value}」", Severity.High);
            }

            foreach (Match match in Landline.Matches(text))
            {
                if (!Whitelisted(whitelist, match.Value)) yield return new Hit("phone", match.Value, match.Index, $"出现固定电话「{match.Value}」", Severity.High);
            }
        }

        if (profile.Bool("privacy.check_id_card", true))
        {
            foreach (Match match in IdCard.Matches(text))
            {
                var value = match.Groups[1].Value;
                if (!IdValid(value) || Whitelisted(whitelist, value)) continue;
                idNumbers.Add(value);
                yield return new Hit("id", value, match.Index, $"出现身份证号「{value}」", Severity.High);
            }
        }

        if (profile.Bool("privacy.check_credit_code", true))
        {
            foreach (Match match in CreditCode.Matches(text))
            {
                var value = match.Groups[1].Value;
                if (!CreditCodeValid(value) || Whitelisted(whitelist, value)) continue;
                yield return new Hit("uscc", value, match.Index, $"出现统一社会信用代码「{value}」", Severity.High);
            }
        }

        if (profile.Bool("privacy.check_email", true))
        {
            foreach (Match match in Email.Matches(text))
            {
                if (!Whitelisted(whitelist, match.Value)) yield return new Hit("email", match.Value, match.Index, $"出现邮箱地址「{match.Value}」", Severity.High);
            }
        }

        if (profile.Bool("privacy.check_url", true))
        {
            foreach (var match in Url.Matches(text).Concat(Domain.Matches(text)))
            {
                var value = match.Value;
                var lower = value.ToLowerInvariant();
                if (Whitelisted(whitelist, value) || lower.Contains("example.com") || lower.EndsWith("w3.org") || lower.EndsWith(".gov") || lower.Contains(".gov.cn")) continue;
                yield return new Hit("url", value, match.Index, $"出现网址「{value}」", Severity.High);
            }
        }

        if (profile.Bool("privacy.check_bank_account", true))
        {
            foreach (Match match in BankAccount.Matches(text))
            {
                var value = match.Groups[1].Value;
                if (idNumbers.Contains(value) || Whitelisted(whitelist, value)) continue;
                yield return new Hit("bank", value, match.Index, $"出现疑似银行账号「{value}」", Severity.Low);
            }
        }

        if (profile.Bool("privacy.check_placeholder", true))
        {
            foreach (var match in Placeholder.Matches(text).Concat(PlaceholderMarks.Matches(text)))
            {
                if (!Whitelisted(whitelist, match.Value)) yield return new Hit("placeholder", match.Value, match.Index, $"残留未填写的占位符「{match.Value}」", Severity.Medium);
            }
        }
    }

    static IEnumerable<Match> SafeMatches(Regex pattern, string text)
    {
        var matches = new List<Match>();
        try
        {
            foreach (Match match in pattern.Matches(text)) matches.Add(match);
        }
        catch (RegexMatchTimeoutException)
        {
            // 用户正则回溯过深时放弃本段，不拖住整份检查。
        }

        return matches;
    }

    /// <summary>
    /// 只认强后缀（有限公司、设计院、事务所…），从后缀往左回溯名称主体，遇功能词截断，
    /// 避免"配合供电公司验收""出厂"这类普通表达被当成企业名。
    /// </summary>
    static List<(string Name, int Index)> CompanyCandidates(string text, IReadOnlyList<string> ignoreOrgs)
    {
        var found = new List<(string Name, int Index)>();
        foreach (Match match in StrongCompany.Matches(text))
        {
            var whole = match.Value;
            var suffix = StrongSuffixes.First(item => whole.EndsWith(item, StringComparison.Ordinal));
            var bodyEnd = match.Index + match.Length - suffix.Length;
            var start = Math.Max(match.Index, bodyEnd - 24);
            var body = text[start..bodyEnd];
            var lastFunction = FunctionWords.Matches(body).LastOrDefault();
            if (lastFunction is not null)
            {
                start += lastFunction.Index + lastFunction.Length;
                body = body[(lastFunction.Index + lastFunction.Length)..];
            }

            body = body.Trim();
            if (body.Length < 2 || GenericOrgWords.Replace(body, "").Length < 2) continue;
            var name = body + suffix;
            if (ignoreOrgs.Any(item => item.Length > 0 && name.Contains(item, StringComparison.Ordinal))) continue;
            found.Add((name, start));
        }

        // 去掉被更长候选包含的短候选。
        var keep = new List<(string Name, int Index)>();
        foreach (var candidate in found.DistinctBy(item => item.Name).OrderByDescending(item => item.Name.Length))
        {
            if (!keep.Any(item => item.Name.Contains(candidate.Name, StringComparison.Ordinal))) keep.Add(candidate);
        }

        return keep;
    }

    static bool CreditCodeValid(string code)
    {
        if (code.Length != 18) return false;
        var total = 0;
        for (var index = 0; index < 17; index += 1)
        {
            var value = CreditCodeChars.IndexOf(code[index]);
            if (value < 0) return false;
            total += value * CreditCodeWeights[index];
        }

        var check = 31 - total % 31;
        if (check == 31) check = 0;
        return CreditCodeChars[check] == code[17];
    }

    static bool IdValid(string code)
    {
        if (code.Length != 18) return false;
        var total = 0;
        for (var index = 0; index < 17; index += 1)
        {
            if (code[index] is < '0' or > '9') return false;
            total += (code[index] - '0') * IdWeights[index];
        }

        return IdCheckChars[total % 11] == char.ToUpperInvariant(code[17]);
    }

    static string Detail(Hit hit) => hit.Kind switch
    {
        "word" => hit.Source == "credential"
            ? "该词来自资信库中的本单位信息，出现即可能暴露投标人身份"
            : "命中预设中的自定义敏感词，出现即可能暴露投标人身份",
        "self" => "自称会让评审方识别出投标单位，暗标要求全文匿名，通常改为「投标人」",
        "label" => "这是表单字段名，若已填写具体信息即构成泄露；若是空白表格可保留，请人工确认",
        "company" => "文中出现完整企业名称，属于可直接识别投标单位的文字",
        "phone" => "联系方式属于可识别身份的信息",
        "id" => "身份证号属于个人敏感信息",
        "uscc" => "统一社会信用代码可直接反查企业",
        "email" => "邮箱地址可能包含企业域名",
        "url" => "网址可能指向企业官网，属于可识别身份的信息",
        "bank" => "连续长数字串疑似银行账号，请人工确认",
        "placeholder" => "模板占位符未替换，可能被视为未响应招标文件",
        "regex" => "命中预设中的自定义规则",
        _ => "",
    };

    static string Hint(string kind) => kind switch
    {
        "word" or "self" or "company" => "替换为「投标人」或删除，同时检查页眉页脚、图片和文档属性",
        "label" => "确认该字段是否已填写实际信息；空白表格可忽略，否则删除或留空",
        "url" => "删除网址，或取消超链接后删除",
        "placeholder" => "按招标文件要求填写实际内容",
        _ => "删除该信息，或替换为通用表述",
    };
}
