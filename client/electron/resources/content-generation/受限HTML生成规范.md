# 投标正文受限 HTML 生成规范

每个小节输出一个 UTF-8 HTML 片段文件。不要输出 Markdown、代码围栏、html/head/body 包装、解释或外层章节标题。章节标题由目录提供，本节正文不使用 h1～h6。

## 基础块

- 每个顶层块前单独一行 `<!-- yibiao:block -->`，块间空一行。
- 顶层仅使用 p、ol、ul、figure、table。每个顶层块有唯一 id，必须以英文字母开头，其后仅含英文字母、数字、下划线或连字符，长度不超过64。使用小节编号前缀避免跨小节重复，例如 s_1_2_p001。
- 行内仅使用 strong、em、u、sup、sub、br。列表使用 li；有序列表可用 start 属性。
- 不使用 div、section、style、class、CSS、脚本、SVG、宽高、颜色、对齐或分页属性。字体、纸张、间距等由所选模板配置管理。
- 普通段落可用无编号加粗引导语。有序列表仅用于步骤、流程、时间顺序等连续内容。

```html
<!-- yibiao:block -->
<p id="s_1_2_p001"><strong>实施要点：</strong>结合当前项目写具体内容。</p>

<!-- yibiao:block -->
<ul id="s_1_2_ul001"><li>第一项措施。</li><li>第二项措施。</li></ul>
```

## 数据表格

遵守本节编排的 table.needed：为 false 时不生成数据表格；为 true 时围绕 table.purpose 使用表格，不为凑版式硬插。

- table 使用 data-yb-preset：plain、headerRow、headerColumn、headerRowAndColumn。
- 使用 caption 作为表题，thead/tbody 包含 tr，tr 包含 th/td。
- 首行表头使用 th scope="col"；首列表头使用 th scope="row"。
- 单元格允许文字、行内标签、段落或列表，不嵌套数据表格；rowspan/colspan 仅使用正整数。避免在一格内堆砌长文。

```html
<!-- yibiao:block -->
<table id="s_1_2_tbl001" data-yb-preset="headerRow">
  <caption>阶段成果</caption>
  <thead><tr><th scope="col">阶段</th><th scope="col">成果</th></tr></thead>
  <tbody><tr><td>实施准备</td><td>计划与责任分工</td></tr></tbody>
</table>
```

## 图片生成与引用

配图要求以正文编排决策.json 的 image_requirements 为准。无图模式不安排图片、不留占位、不调用配图工具。类型开关表示是否允许使用，不代表必须生成；仅在允许的类型中结合正文选择，不要求每节或全文覆盖全部类型。HTML 图片遵循用户设置的允许类型。内容适合时建议优先 AI 图片 > HTML 图片 > Mermaid 图片，不设比例或强制顺序。

参考本节 image_needed 和 image_suitability_score：为 false 时不安排配图；为 true 时结合模板和实际内容判断。少图建议每节 1～3 张，多图建议每节 1～6 张；这些是指导范围，不是固定配额。高分小节可以适当多配，但高分不等于必须多图，不为凑数重复配图或强套图组。少图可参考图片表格、三列图片，多图可参考图片表格、三列图片、四宫格等。需要配图时，正文批量生成工具先写占位和具体用途，主 Agent 在当前会话内生成图片并补全引用。

最终正文中的每个 img 必须带 data-yb-asset-ref，值为图片工具返回的 asset_ref，即当前 Agent 工作区相对路径（图片/xxx.png 等）。不写 src、绝对路径、远程链接或 base64，不虚构图片文件。所有图组中的图片都须补齐资源引用后才能提交结果清单。

- figure 必须有唯一 id、data-yb-generation 和 data-yb-size。
- data-yb-generation：aiImage（实景示意）、mermaid（流程关系）、htmlImage（信息图）。类型与实际调用的生成工具一致。
- data-yb-size：square、wide、tall、panorama；可选 data-yb-fit=contain 或 cover。
- figure 内包含一个 template data-yb-role="prompt"，只写非空的配图要求文字，不嵌入 HTML 或 Mermaid 源码；一个 img，带非空 alt；独立图和图组内的图带 figcaption。
- 配图块之间用正文衔接，不连续堆图。不要照抄模板示例的配图内容。

```html
<!-- yibiao:block -->
<figure id="s_1_2_fig001" data-yb-generation="mermaid" data-yb-size="wide">
  <template data-yb-role="prompt">本项目实施阶段及交接关系。</template>
  <img alt="实施阶段及交接关系示意图" data-yb-asset-ref="图片/实施阶段.png">
  <figcaption>实施阶段与交接关系</figcaption>
</figure>
```

允许的图片表格预设：imageText 为一行两列，左格一个 figure、右格文字；threeImages 为一行三列，每格一个 figure；fourImages 为两行两列，每格一个 figure。图文表格左图可省略 figcaption，其他图必须有图注。图组使用统一画框；table 有 caption，不使用 thead、合并单元格或嵌套表格。各图均按上述规则填写实际图片资源引用。

## 三类图片工具

- AI 生图：调用 generate-image，提供提示词和可选风格、标题、服务支持的尺寸。沿用主程序生图配置，返回的 asset_ref 已指向当前工作区内的图片副本。
- HTML 图片：主 Agent 用 write 将独立配图 HTML 保存到图片/下，再调用 render-html-image，参数 source_file 为该文件相对路径。源文件可包含 html/head/body、style、div、SVG 等绘图结构，与受限正文分开；不依赖外部资源。按 1240px 设计宽度布局，正文和节点文字不小于24px，建议高度不超过1800px，避免溢出、遮挡、裁切。工具返回 PNG 及 layout_issues，出现问题时修改源文件后重新转图。
- Mermaid 图片：主 Agent 将无 Markdown 围栏的 Mermaid 代码保存为图片/下的 .mmd 文件，再调用 render-mermaid-image。优先使用清晰简短的 flowchart，中文节点标签使用双引号，避免图过密；语法或渲染报错时修改源文件后重试。

两种转图工具只负责本地渲染，不另行调用模型编写或修复源码。源文件保留；图片以工具返回路径为准，成功后将 asset_ref 写入对应 img。暂停继续时复用已经完成的图片和源码，仅补齐缺失或需要修改的部分。图片生成发生在当前正文 Agent 会话内。

## 模板与字数

正文模板.html 是结构参考，所选模板配置.json 是用户排版设置。参考模板组织段落、列表和表格，按内容选择合适的结构，不要求每个小节包含所有元素，也不复制示例正文。

字数要求以正文编排决策.json 为准。统计可读正文，排除 HTML 标签和 template 中的图片用途文字。控制各节篇幅并关注全文合计，不把全文字数目标当成单节目标。
