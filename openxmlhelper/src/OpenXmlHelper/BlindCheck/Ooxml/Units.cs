using System.Globalization;

namespace Yibiao.OpenXmlHelper.BlindCheck.Ooxml;

/// <summary>
/// OOXML 单位换算集中在这里：twip = 1/20 磅，sz 是半磅，
/// spacing/@line 在 lineRule=auto 时是 1/240 行、其余是 twip。
/// </summary>
static class Units
{
    public const double TwipsPerPt = 20.0;
    public const double TwipsPerCm = 1440.0 / 2.54;
    /// <summary>beforeLines/afterLines 的一行按 12 磅换算，与预览补丁口径一致。</summary>
    public const double PtPerSpacingLine = 12.0;

    static readonly (string Name, double Pt)[] ChineseSizes =
    [
        ("初号", 42), ("小初", 36), ("一号", 26), ("小一", 24), ("二号", 22), ("小二", 18),
        ("三号", 16), ("小三", 15), ("四号", 14), ("小四", 12), ("五号", 10.5), ("小五", 9),
        ("六号", 7.5), ("小六", 6.5), ("七号", 5.5), ("八号", 5),
    ];

    public static double TwipsToPt(double twips) => twips / TwipsPerPt;

    public static double TwipsToCm(double twips) => twips / TwipsPerCm;

    public static double HalfPtToPt(double halfPoints) => halfPoints / 2.0;

    /// <summary>磅值转最接近的中文字号名，差距过大时返回 null。</summary>
    public static string? ChineseSizeName(double pt)
    {
        string? best = null;
        var bestDiff = double.MaxValue;
        foreach (var (name, value) in ChineseSizes)
        {
            var diff = Math.Abs(value - pt);
            if (diff < bestDiff)
            {
                best = name;
                bestDiff = diff;
            }
        }

        return bestDiff < 0.3 ? best : null;
    }

    /// <summary>14 -> "四号（14磅）"，13 -> "13磅"。</summary>
    public static string FormatPt(double pt)
    {
        var name = ChineseSizeName(pt);
        var number = Number(pt);
        return name is null ? $"{number}磅" : $"{name}（{number}磅）";
    }

    public static string Number(double value, int digits = 2)
    {
        return Math.Round(value, digits).ToString("0.##", CultureInfo.InvariantCulture);
    }
}
