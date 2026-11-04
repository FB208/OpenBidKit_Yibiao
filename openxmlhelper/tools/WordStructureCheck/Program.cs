using Yibiao.OpenXmlHelper.WordStructureCheck;

// 用法（在 openxmlhelper 下）：
//   dotnet run --project tools/WordStructureCheck -- evidence <输出目录>     生成规则表实测文档，再用 check-word-open.ps1 复测
//   dotnet run --project tools/WordStructureCheck -- primitives <输出目录>   用结构层原语做危险删除并 audit，再用 check-word-open.ps1 打开
//   dotnet run --project tools/WordStructureCheck -- audit <docx 或目录>...  按规则表检查已有文档的结构
if (args.Length < 2)
{
    Console.Error.WriteLine("用法：evidence <目录> | primitives <目录> | audit <docx 或目录>...");
    return 2;
}

switch (args[0])
{
    case "evidence":
        Evidence.Run(Path.GetFullPath(args[1]));
        return 0;
    case "primitives":
        return Primitives.Run(Path.GetFullPath(args[1]));
    case "audit":
        var failed = 0;
        foreach (var path in args.Skip(1).SelectMany(item => Directory.Exists(item) ? Directory.GetFiles(item, "*.docx") : [item]))
        {
            var problems = Audit.Check(path);
            Console.WriteLine($"{(problems.Count == 0 ? "通过" : $"{problems.Count} 处问题")}  {Path.GetFileName(path)}");
            foreach (var problem in problems.Take(30)) Console.WriteLine($"    {problem}");
            if (problems.Count > 30) Console.WriteLine($"    …另有 {problems.Count - 30} 处");
            if (problems.Count > 0) failed += 1;
        }
        return failed == 0 ? 0 : 1;
    default:
        Console.Error.WriteLine($"未知模式：{args[0]}");
        return 2;
}
