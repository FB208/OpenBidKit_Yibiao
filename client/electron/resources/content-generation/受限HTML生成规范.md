# 投标正文受限 HTML 生成规范

每个小节输出一个 UTF-8 HTML 片段文件。不要输出 Markdown、代码围栏、html/head/body 包装、解释或外层章节标题。章节标题由目录提供，本节正文不使用 h1～h6。

正文禁止使用 LaTeX 语法，包括 $...$、$$...$$、\(...\)、\[...\] 及 \frac、\text、\circ 等命令。公式、参数和单位使用普通文字、Unicode 数学符号及受限 HTML 的 <sup>、<sub> 表达，例如 22 ℃ ± 2 ℃、40%～65%、≥30 m<sup>3</sup>/(h·人)。参考材料中的 LaTeX 在写入正文时也须转换为上述表达，保持数值、单位和含义不变。

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

后处理例外：用户选择“不要表格”（table_requirement=none）时，一致性审计完成后将所有数据表格（包括原方案表格）转换为普通段落或列表，完整保留数据、表头对应关系、单位、条件及备注。imageText、threeImages、fourImages 图片表格整块保留，不参与去表格。此例外仅用于去表格阶段，不改变生成、扩缩写和审计阶段的表格保留规则。

新增表格遵守本节编排的 table.needed：为 false 时不新增数据表格；为 true 时围绕 table.purpose 使用表格，仅在编排允许且能改善本节信息表达时新增数据表格，不以增加版式种类为目的插入表格。已还原底稿中的原表格仍须保留其数据和含义，整理为受限 HTML，不受该标记限制；内容冲突以全局事实设定为准。

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

新增配图要求以正文编排决策.json 的 image_requirements 为准。无图模式不新增图片、不留占位、不调用配图工具。图片类型开关定义允许使用的生成方式，AI 占比目标用于本轮整体配图规划，各小节及全文均无须覆盖全部已开启类型。HTML 图片遵循用户设置的允许类型。根据新增图片要表达的内容和结构查阅配图类型对照表.md。未找到对应类型时，优先采用用途、结构相近类型所对应的生成方式；仍无法归类时，使用 AI 生图。始终遵守用户的图片类型开关设置：对照表仅用于确定生成方式，不代表该方式已获允许；对应生成方式被关闭时，不生成该图，也不因该方式被关闭而改用其他方式。

有图模式且 AI 生图开启时，按 image_requirements 提供的本轮 AI 图片目标占比 60% 规划新增配图。主 Agent 在并发写作前优先寻找适合实物、场景、效果、物理结构、工艺、操作等可视化表达的主题，并依次确定布局、表达目的、图片类型和生成方式。需要准确表达流程、逻辑或数据时，继续按对照表使用 HTML/Mermaid，不为比例要求把这些图强行改为 AI 图片。无图或 AI 生图关闭时不应用 AI 占比目标。

占比按本轮实际新增图片张数计算：单张图片和图片表格各 1 张，三列图片 3 张，四宫格 4 张。原方案图片不计入分子或分母，即使 data-yb-generation="aiImage" 也不视为本轮 AI 生图。60% 是主 Agent 统筹的整体规划目标，不是上限，不要求精确命中，也不要求每个小节分别达到该比例；保持既定布局名额，不额外加图凑比例。暂停重试沿用本轮安排，已完成的新图计入本轮统计；局部生成只统计本轮新增图片，单节修改不追补全文比例。

批量正文生成的新增布局名额由正文编排决策.json 的 image_layout_quota 提供：total_groups 为本轮总组数，single、imageText、threeImages、fourImages 分别为单张图片、图片表格、三列图片、四宫格的组数。主 Agent 在并发写作前统一分配到本轮目标小节，并在各节写作要求中明确布局、组数及每张图的表达目的、图片类型和生成方式（aiImage/htmlImage/mermaid）。并发写作模型只执行本节分配，不自行改变生成方式，不自行承担或重新分配全局名额，也不独立承担 AI 图片占比目标；未分配布局的小节不新增配图。布局名额仅用于本轮批量生成，后续单节修改按用户要求执行，不重新分配全文名额。

image_needed 表示本节是否进入新增配图范围：为 false 时不新增图片；为 true 时可承接主 Agent 分配的布局。image_suitability_score 为 0～10 分的配图适配评分，用于选择更合适的布局承接小节，不用于取消本轮名额。可在适合的小节安排多组，不要求每个入选小节恰好一组，不设每节图片张数上限。单张图片与图片表格可依据说明文字的必要性互换，两者合计组数保持不变；三列图片和四宫格按分配组数执行，不自行拆成单张。组内图片围绕共同主题表达不同信息，避免重复。布局与生成方式分别判断，AI、HTML、Mermaid 仍遵守类型开关和对照表。

并发正文写作阶段只生成分配的新增图片布局和受限 HTML 结构，填写生成类型、用途说明、替代文本及必要图注，暂不填写图片资源引用。主 Agent 在当前会话内生成图片后调用 apply-section-images 批量回填工具返回的 asset_ref；已有原图直接使用提供的资源引用。暂停或失败重试沿用本轮名额，已完成布局计入完成数量，仅补未完成部分。全部并发写作及配图结束后，由主 Agent 核对新增布局名额、图组内容、图片引用及生成方式分布，再进入字数检查；AI 占比是规划目标，不因比例偏差新增失败条件或额外加图。

上述布局名额、类型开关和 image_needed 仅针对新增图片。已还原底稿中的原图按本节 restored_content.images 的对应关系直接复用 asset_ref，保留原图、引用顺序和表格中的图文对应关系，不重新生图，不受无图或类型开关限制，原图及其布局不占新增布局名额。原图使用完整的 figure、template、img 和图注结构，统一填写 data-yb-generation="aiImage"，唯一、非空的 template data-yb-role="prompt" 写“复用原方案图片，不重新生成”并可补充图片说明。原图统一使用 data-yb-generation="aiImage" 作为受限 HTML 格式标记。原图身份及资源路径以 restored_content.images 为准；该标记不构成调用 AI 生图的指令。原表格单元格中的原图可用 figure 保留。

最终正文中的每个 img 必须带 data-yb-asset-ref，值为图片工具返回或本节原图对应关系提供的 asset_ref，即当前 Agent 工作区相对路径（图片/xxx.png、原图/xxx.png 等）。不写 src、绝对路径、远程链接或 base64，不虚构图片文件。所有图组中的图片都须补齐资源引用后才能提交结果清单。

- 所有 figure（包括原图）必须有唯一 id、合法的 data-yb-generation 和 data-yb-size。
- data-yb-generation 按对照表填写：ai 对应 aiImage，html 对应 htmlImage，mermaid 对应 mermaid；统一调用 generate-section-images，kind 分别填 ai、html、mermaid。新增图片的类型与实际调用的生成工具一致；原图按上述规则使用 aiImage，不触发生图。
- data-yb-size 表示图片画框比例：square 为 1:1 方形，wide 为 3:2 横向，tall 为 3:4 纵向，panorama 为 16:9 横向；这是正文排版画框，不是生图服务的 size 参数。
- data-yb-fit="contain" 保持原图比例、完整显示、不裁剪；data-yb-fit="cover" 铺满画框，比例不一致时会裁剪。省略时 Word 转换默认按 cover 处理。流程图、信息图及需要完整保留的原方案图片应明确使用 contain；实景示意图仅在允许裁剪边缘时使用 cover。
- 每个 figure 必须包含且仅包含一个非空的 template[data-yb-role="prompt"]。新增图片的模板应说明表达目的、主要对象及其关系，必要时说明图中文字或数据；不得嵌入绘图源码。原图模板填写复用说明。所有 figure 包含一个 img，带非空 alt；独立图和图组内的图带 figcaption。
- 配图块之间用正文衔接，不连续堆图。不要照抄模板示例的配图内容。

```html
<!-- yibiao:block -->
<figure id="s_1_2_fig001" data-yb-generation="mermaid" data-yb-size="wide" data-yb-fit="contain">
  <template data-yb-role="prompt">本项目实施阶段及交接关系。</template>
  <img alt="实施阶段及交接关系示意图" data-yb-asset-ref="图片/实施阶段.png">
  <figcaption>实施阶段与交接关系</figcaption>
</figure>
```

单张图片采用独立 figure，图片本身即可表达意图，附简短图注。图片表格 imageText 为一行两列，左格一个 figure、右格说明文字；仅含一张图片，适用于需要配套文字解释图片的内容。threeImages 为一行三列，每格一个 figure，用于三项相关内容并列展示；fourImages 为两行两列，每格一个 figure，用于四项相关内容组合展示。图文表格左图可省略 figcaption，其他图必须有图注。图组使用统一画框；table 有 caption，不使用 thead、合并单元格或嵌套表格。各图均按上述规则填写实际图片资源引用。

原图复用示例（asset_ref 必须取自本节原图对应关系）：

```html
<!-- yibiao:block -->
<figure id="original_fig_001" data-yb-generation="aiImage" data-yb-size="wide" data-yb-fit="contain">
  <template data-yb-role="prompt">复用原方案现场图片，不重新生成。</template>
  <img alt="现场图片" data-yb-asset-ref="原图/xxx.png">
  <figcaption>现场图片</figcaption>
</figure>
```

## 图片清单与地址回填

正文 figure 布局保存后，主 Agent 使用 list-section-images 读取本轮目标的最新图片清单，无须自行编写扫描脚本。清单包含小节、figure 标识、生成方式、画框比例、提示词、图注及当前图片引用，image_id 由小节 ID 和 figure ID 共同确定，原样用于后续图片工具。不同小节可以使用相同 figure ID，同一小节内必须唯一。已有有效图片直接复用；reused_original 标记原方案图片，不因 aiImage 属性触发生图，原图文件缺失时修复引用。发现结构或提示词问题，仍可读取、编辑正文后重新提取；section_ids 可只刷新相关小节。

生成及布局修复完成后，使用 apply-section-images 的 images 数组批量回填，每项提供 image_id、图片工具返回的 asset_ref，以及清单原 asset_ref 作为 previous_asset_ref（未填写时传空字符串）。程序重新读取正文，只修改 img 的 data-yb-asset-ref，同一小节合并保存，其余文字、注释、换行及图组布局保持原样。回填不是生图工具，不提交失败图片、绘图源码或布局问题尚未处理的项。同一小节有回填错误时该小节整组不写入，其他成功小节保留；按返回结果修复，引用已变化时先刷新清单。相同引用重复提交不会重复修改。暂停后基于最新清单复用成功产物；全文进入图片保护阶段后不再允许回填，单小节修改只处理当前目标。

## 三类图片工具

本轮全部待生成 AI、HTML、Mermaid 图片通过 generate-section-images 的 images 一次混合提交，不按章节、类型或固定小批次拆分，单张也用一项数组。每项填写清单 image_id、kind（ai/html/mermaid）和 prompt。程序同时向既有生图及文本队列提交任务，超限自动排队；每张源码完成后立即进入对应本地渲染队列，不等待其他源码或 AI 图片。逐项报告进度，整批结束后返回 results；按 image_id 对应正文图片，检查 status、stage、error、source_file、asset_ref 及 HTML layout_issues。success 才可回填，needs_repair 表示布局仍需修复，error/cancelled 表示失败或未完成；不能把已保存源码当成图片生成完成。

- AI 生图：kind=ai，size 必填，逐图读取对应 figure 的 data-yb-size，按 square=1:1、wide=3:2、tall=3:4、panorama=16:9 选择匹配的具体生图尺寸；当前金龙 gpt-image-2-1k 的 tall 使用已验证的 768x1024。可选 style、title；不能把 tall 等画框名称当作尺寸，不得省略 size 或统一沿用默认方图；prompt 同步保留相同的比例与横向/竖向构图要求。尺寸被服务端拒绝时按失败结果修正该项，不通过省略尺寸重试。返回像素可能由服务端调整，不要求与请求像素完全相等。返回的 asset_ref 已指向当前工作区内的图片副本。
- HTML/Mermaid：kind=html/mermaid，HTML 另填与正文画框一致的 frame_size。prompt 提供图片类型、表达目的、准确内容和数据，不能只给文件路径或要求模型自行检索；并发模型没有主会话上下文。源码独立保存为图片/下的新文件，随后自动转图。有 source_file 的失败或未完成项直接修复、转图，不重新生成源码；无源码的失败项才重新提交生成。

- HTML 图片修复：首次生成已自动转图；需要修复布局或重试转图时，将待修复 HTML 文件放入 images 数组，一次调用 render-html-image。每项必填 image_id、source_file 和 frame_size；source_file 为源码相对路径，frame_size 与正文对应 figure 的 data-yb-size 一致。源文件可包含 html/head/body、style、div、SVG 等绘图结构，与受限正文分开；不依赖外部资源。生成前按画框比例确定固定设计尺寸：square=1240×1240、wide=1240×827、tall=1240×1653、panorama=1240×698。以 body 为画布，程序统一设置宽高及四周40px内边距，边距包含在上述尺寸内；例如 square 的内容区域为1160×1160。保留 body 的 Flex/Grid 布局，不额外包一层画布或重复添加外层边距。标题区和主体区共同利用内部空间，主体使用 Flex/Grid 分配剩余高度，卡片、节点及图形均衡分布，避免内容集中顶部、底部大面积留白。采用正式简洁的配色、统一字体和线条，模块间距协调；正文和节点文字不小于24px。不通过无意义文字、拉伸图形、单纯撑高空卡片或整体缩小内容填充版面。程序按固定尺寸以2倍像素输出，不按滚动高度扩大截图；内容不得侵入边距或超出画布。按 results 中的 image_id 对应正文图片，逐项检查 status、error 和 layout_issues。存在布局问题时，依据反馈调整对应源码的内容组织、字号和间距后重新渲染，不使用隐藏溢出来掩盖裁切；问题解决后，使用本次工具返回的图片资源引用。
- Mermaid 图片修复：首次生成已保存 .mmd 文件并自动转图；需要修复或重试时，将相关源文件放入 images 数组，一次调用 render-mermaid-image。每项必填 image_id 和 source_file，按 results 中的 image_id 对应正文图片，逐项检查 status 和 error。根据图的类型选择 Mermaid 语法：流程图使用 flowchart，思维导图使用 mindmap，实体关系图使用 erDiagram。按所选语法正确处理中文标签，保持节点和连线清晰，避免过度密集；语法或渲染报错时修改源文件后重试。

两种转图工具均只接受 images 数组，单张也使用一项数组，不使用旧单图参数。它们只负责本地渲染，各自沿用已有组件并发队列，超限自动排队，不另行调用模型编写或修复源码。渲染报错或 HTML 布局问题由主 Agent 读取相应源码并修改，只将失败或需要修正的项重新批量提交转图，保留其他成功结果。源文件保留；图片以工具返回路径为准，成功且布局问题已处理后，通过 apply-section-images 将 asset_ref 批量回填到对应 img。暂停时工具等待本批请求退出，将已完成图片、已保存源码及未完成状态返回既有会话；恢复先核对会话结果与最新清单，成功图片直接复用，有源码的项继续修复或转图，无源码的剩余任务再混合提交生成。仅补齐缺失或需要修改的部分。图片生成发生在当前正文 Agent 会话内。

## 模板与字数

正文模板.html 是结构参考，所选模板配置.json 是用户排版设置。参考模板组织段落、列表和表格，按内容选择合适的结构，不要求每个小节包含所有元素，也不复制示例正文。

样张与模板设置页面共用，包含用于展示标题样式的 h1～h6；这些标题不是正文生成要求，小节正文仍不得使用 h1～h6 或输出外层章节标题。样张中的图片仅示范布局、提示词和图注，示例图片引用已移除；不要照抄示例图注或提示词，应结合本节内容和配图要求生成，并使用配图工具返回的真实图片引用。

字数要求以正文编排决策.json 为准。统计可读正文，排除 HTML 标签和 template 中的图片用途文字。全文字数要求是整体目标，不是单节目标。主 Agent 按 word_control.checkTotalWords 决定是否检查总字数范围：为 false 时仅统计本次目标小节字数，不依据全文上下限扩缩写本次小节。并发正文模型以请求中明确提供的字数要求为准，不独立承担全文目标。

存在本节 restored_content 时，完整核对对应底稿并遵守 restoration_requirements：主 Agent 读取指定底稿文件，并发正文模型核对请求中提供的完整底稿。依据当前项目、章节职责和编排重点整理为受限 HTML，保留实质内容、原表格和原图，不得以重新撰写的内容替代底稿中应保留的信息；发生冲突时以全局事实设定为准。本节底稿已超过小节目标字数，或全文已有正文已超过全文上限时，只整理、不扩写，不为压字数删除实质内容；否则根据现有要求适当扩写。未设置的字数目标不参与判断。没有本节底稿时沿用正常生成流程，不借用其他小节材料。
