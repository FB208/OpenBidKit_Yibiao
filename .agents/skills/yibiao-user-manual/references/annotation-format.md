# 截图标注格式

使用归一化坐标描述标签和目标点，所有坐标均以图片宽高为 0–1 范围。这样同一格式可适配不同 DPI 截图。

## JSON 格式

```json
{
  "style": {
    "label_color": "#FF4619",
    "text_color": "#FFFFFF",
    "font_family": "Microsoft YaHei",
    "font_size": 40,
    "line_width": 9,
    "target_radius": 18,
    "corner_radius": 18
  },
  "annotations": [
    {
      "text": "① 填写 API Key",
      "label": {
        "x": 0.36,
        "y": 0.32,
        "width": 0.18,
        "height": 0.06
      },
      "target": {
        "x": 0.80,
        "y": 0.45
      }
    }
  ]
}
```

`style` 可以省略，脚本会使用示例中的默认样式。`annotations` 必须包含 1–5 项。

## 布局规则

- 每条文案使用编号开头并控制在 4–12 个汉字，例如“① 选择文件”“② 等待全部完成”。
- 把标签放在页面空白区域，不覆盖按钮、状态、表格内容和正文。
- 把目标点放在按钮中心或需复核内容旁边，箭头由脚本自动选择标签边缘作为起点。
- 同一张图优先标出必点操作、等待条件和提交前复核点，不标注显而易见的装饰元素。
- 先查看原始分辨率截图再确定坐标；生成后再次目视检查箭头落点。

## 命令示例

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\capture-window.ps1 `
  -OutputPath "使用说明\images\03-文本模型配置.png" `
  -WindowTitlePattern "易标投标工具箱"

powershell -NoProfile -ExecutionPolicy Bypass -File scripts\annotate-screenshot.ps1 `
  -InputPath "使用说明\images\03-文本模型配置.png" `
  -OutputPath "使用说明\images\标注\03-文本模型配置.png" `
  -SpecPath "$env:TEMP\03-文本模型配置.json"
```

不得把输出路径设为原图路径。脚本会保留原图分辨率、DPI 和未标注区域，只增加标签、箭头和目标圈。
