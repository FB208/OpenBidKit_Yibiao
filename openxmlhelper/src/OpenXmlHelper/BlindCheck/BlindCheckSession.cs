using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Yibiao.OpenXmlHelper.BlindCheck.Model;
using Yibiao.OpenXmlHelper.BlindCheck.Ooxml;
using Yibiao.OpenXmlHelper.BlindCheck.Rules;

namespace Yibiao.OpenXmlHelper.BlindCheck;

/// <summary>进度写在任务目录的 progress.json（先写临时文件再替换），Main 定时读取。</summary>
sealed class ProgressWriter(string path)
{
    double _last = -1;
    string _label = "";

    public void Report(double fraction, string label)
    {
        var value = Math.Clamp(fraction, 0, 0.99);
        if (Math.Abs(value - _last) < 0.005 && label == _label) return;
        _last = value;
        _label = label;
        try
        {
            var temp = path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(new { frac = Math.Round(value, 3), label }), new UTF8Encoding(false));
            File.Move(temp, path, overwrite: true);
        }
        catch (IOException)
        {
            // Main 正在读取时替换可能失败，下一次进度会再写。
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}

/// <summary>把 0~1 的局部进度映射到整体进度的一段区间，检查和修复后复查共用同一套阶段。</summary>
sealed class ProgressRange(ProgressWriter writer, double from, double to)
{
    public void Report(double fraction, string label) => writer.Report(from + (to - from) * Math.Clamp(fraction, 0, 1), label);
}

/// <summary>
/// 一次检查会话：打开文档、建立格式模型、识别目录标题与封面、收集图片，得到规则上下文。
/// 检查动作直接出报告；修复动作在同一个模型上改 XML，再对写出的副本重新开一个会话复查。
/// </summary>
sealed class BlindCheckSession : IDisposable
{
    readonly Stopwatch _stopwatch;

    public DocxPackage Package { get; }
    public RuleContext Context { get; }

    BlindCheckSession(DocxPackage package, RuleContext context, Stopwatch stopwatch)
    {
        Package = package;
        Context = context;
        _stopwatch = stopwatch;
    }

    public static BlindCheckSession Open(string path, BlindCheckInspectRequest request, ProgressRange progress)
    {
        var stopwatch = Stopwatch.StartNew();
        progress.Report(0.04, "正在读取文档");
        var package = DocxPackage.Open(path);
        try
        {
            progress.Report(0.13, "正在解析样式与主题");
            var model = DocumentModel.Load(package);
            progress.Report(0.27, "正在分析段落格式");
            model.BuildRecords(fraction => progress.Report(0.27 + fraction * 0.66, "正在分析段落格式"));
            progress.Report(0.95, "正在识别目录与标题");
            var outline = OutlineAnalyzer.Analyze(model, request.HeadingFallback);
            var profile = BlindCheckProfile.From(request.Profile);
            var groups = RuleContext.CollectGroups(model, outline, profile.Bool("structure.skip_cover", true));
            progress.Report(0.98, "正在读取图片");
            var images = ImageCatalog.Collect(model);
            var context = new RuleContext
            {
                Model = model,
                Profile = profile,
                Outline = outline,
                Groups = groups,
                SensitiveWords = request.SensitiveWords
                    .Where(item => !string.IsNullOrWhiteSpace(item.Text))
                    .Select(item => new SensitiveWord { Text = item.Text.Trim(), Source = item.Source == "credential" ? "credential" : "custom" })
                    .DistinctBy(item => item.Text)
                    .ToList(),
                Images = images,
                ImageFacts = request.ImageFacts
                    .Where(item => !string.IsNullOrEmpty(item.Part))
                    .DistinctBy(item => item.Part, StringComparer.OrdinalIgnoreCase)
                    .ToDictionary(item => item.Part, StringComparer.OrdinalIgnoreCase),
            };
            return new BlindCheckSession(package, context, stopwatch);
        }
        catch
        {
            package.Dispose();
            throw;
        }
    }

    public BlindCheckReport Inspect(ProgressRange progress)
    {
        var context = Context;
        var result = RuleEngine.Run(context, (index, total, title) => progress.Report((double)index / Math.Max(1, total), $"正在检查：{title}"));
        progress.Report(1, "正在汇总结果");
        var model = context.Model;
        var groups = context.Groups;
        var images = context.Images;
        var summary = result.Findings.CountBySeverity();
        summary["total"] = result.Findings.Total;
        return new BlindCheckReport
        {
            Summary = summary,
            Stats = new BlindCheckStats
            {
                Paragraphs = groups.All.Count,
                BodyParagraphs = groups.Body.Count,
                TableParagraphs = groups.Table.Count,
                Tables = model.TableCount,
                Sections = model.Sections.Count,
                TocEntries = context.Outline.Toc.Entries.Count,
                Headings = context.Outline.Levels.Count,
                HeadingSources = context.Outline.SourceCounts,
                CoverParagraphs = groups.Cover.Count,
                Images = images.Count,
                ImageFormats = images.GroupBy(item => item.Format).OrderByDescending(group => group.Count()).ToDictionary(group => group.Key, group => group.Count()),
                VectorImages = images.Count(item => item.IsVector),
                RulesChecked = result.RuleCount,
                DurationMs = _stopwatch.ElapsedMilliseconds,
            },
            Groups = result.Findings.Groups(),
            RuleErrors = result.Errors,
        };
    }

    public void Dispose() => Package.Dispose();
}
