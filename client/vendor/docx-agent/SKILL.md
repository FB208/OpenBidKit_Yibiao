---
name: docx-high-fidelity-tools
description: Build, run, and drive docx-agent — a Python library for high-fidelity DOCX editing. Use when asked to run docx-agent, drive its docx operations, build it, test it, or operate on a Word document without breaking styles.
---

docx-agent 是一个面向 Agent 的 DOCX 高保真操作库（纯 Python，无 GUI/server）。
驱动它不是启动服务，而是调用库函数对真实 docx 做操作并产出结果文档。主入口是
`driver.py`，它以 agent 真实使用库的方式跑一遍
「定位→写入→删除→复制→跨文档→校验」端到端流程，产出可验证的 docx。

所有路径相对于项目根 `docx-agent/`。

## Prerequisites

Python ≥ 3.12 + python-docx + lxml。当前容器（Windows）实测可用：

```bash
python -c "import sys; print(sys.version)"        # 3.13.3
python -c "import docx; print(docx.__version__)"   # 1.2.0
python -c "import lxml"                            # 已装
```

Linux 干净机器上：`sudo apt-get install -y python3 python3-pip` 后
`pip install python-docx lxml`。无系统级 GUI/字体依赖（纯 OOXML 字节操作）。

## Setup

依赖已在环境中。从干净仓库复现：

```bash
cd docx-agent
pip install python-docx lxml
```

项目 `pyproject.toml` 的 `dependencies` 为空（python-docx/lxml 按需装即可）。
样本文档已内置：`input/base.docx`（主样本）、`input/target_plain.docx`（贫瘠目标，跨文档测试用）。

## Run (agent path) — 首选

driver 是库类项目的「launch + interact」入口。它对真实 docx 执行完整工作流并产出结果：

```bash
PYTHONUTF8=1 python driver.py
```

可选参数：

```bash
# 指定输入 docx 与输出目录
python driver.py --input input/base.docx --outdir output/driver_demo
```

driver 做的事（每步打印 ✅/❌，结束打印 PASS/FAIL 与产出清单）：

1. 前置：`validate_openable` + 加载文档
2. 定位：段落索引 / 文本(多run) / 标题层级 / 书签 / 表格坐标
3. 写入：追加文本(保样式) / 插入段落 / 表格新增行+填充
4. 删除：删段落 / 删run(保样式) / 清空单元格(保tcPr)
5. 复制：同文档复制段落 / 复制图片段(rId复用)
6. 跨文档深度复制：图片/样式/编号/书签全部搬运
7. 校验：`compare_documents`(styles.xml 不应变) + 指纹稳定性

产出（在 `output/driver_demo/`）：`after_write.docx` / `after_delete.docx` /
`after_copy.docx` / `xdoc_demo.docx`。退出码 0=全部通过。

## 直接调用库（不走 driver）

大多数 PRS 触及内部函数，agent 想直接调用单个方法时：

```python
import sys; sys.path.insert(0, ".")
from docx import Document
from src import locator, writer, verifier

doc = Document("input/base.docx")
loc = locator.locate_by_text(doc, "正文宋体四号")   # 段落7
writer.append_text_to_paragraph(doc, loc, "【追加】", inherit_style=True)
doc.save("output/demo.docx")

r = verifier.compare_documents("input/base.docx", "output/demo.docx",
        expected_changes=[{"paragraph": 7, "path": "runs[1]"}])
assert r["unexpected_changes"] == [] and not r["styles_xml_changed"]
```

完整方法清单见 `SKILL.md`（项目根，面向 agent 的 API 手册）。

## Test

跑测试套件（94 条用例，自动断言 + 样式校验）：

```bash
PYTHONUTF8=1 python tests/run_tests.py
```

产出 `output/OVERVIEW.md`（全部测试状态汇总）+ 每个测试的 `output/{id}_{name}/`
（含 result.docx / summary.md / style_report.json）。当前 94/94 通过。

单个模块自测：

```bash
python src/verifier.py    # 各模块 __main__ 都有 _self_test
python src/clipboard.py
```

## 解析真实结构（开发首要步骤）

对任意新 docx，第一步用 `tools/inspect_base.py` 看真实结构（杜绝凭记忆编造 XML）：

```bash
PYTHONUTF8=1 python tools/inspect_base.py
# 产出 logs/base_structure.md（段落/表格/样式/图片/书签/编号/批注/页眉页脚）
```

## Gotchas

- **Windows 中文输出乱码**：所有 Python 命令加 `PYTHONUTF8=1`（脚本内 print 中文到 GBK 控制台会乱码，但不影响文件产出）。
- **python-docx 的 `paragraph.text`** 在 run 含非 `<w:t>` 子元素（如 drawing）时会抛 `TypeError: sequence item...NoneType` —— driver 计数图片时不能用它，改用 lxml 的 `p._p.iter("{...a...}blip")` 直接遍历。
- **跨文档复制后 `res["new_p"]` 引用不可靠**：保存文档后该元素引用失效，要重新 `Document(path)` 加载再计数。
- **styles.xml 跨文档会变是预期**：跨文档复制会把源样式/编号定义注入目标，属正常依赖搬运，不是 bug。
- **段落数变化时 verifier 索引对齐失效**：插入/删除段落后的全量 `compare_documents` 会连锁误报，需用 expected_changes 放行新增段或改用前缀零差异判定（见 `tests/run_tests.py`）。

## Troubleshooting

| 症状                                                          | 修复                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ModuleNotFoundError: No module named 'src'`                  | 从项目根运行，或脚本已内置 `sys.path.insert(0, ROOT)`；直接 `python src/xxx.py` 也可 |
| `TypeError: sequence item 1: expected str instance, NoneType` | 用了 python-docx `.text` 访问含图片的段落；改用 lxml 直接拼接 `<w:t>`                |
| 图片段复制后「0 个图片」                                      | 在保存后重新 `Document(path)` 加载再数 blip，别用返回的 `new_p` 引用                 |
| 跨文档后 `styles.xml changed=True`                            | 预期行为（依赖注入），不是校验失败                                                   |

## 实战案例：填写招标文件表单（投标承诺书）

以真实招标 docx（925 段、12 表）的「投标承诺书」表单填写为参照，沉淀可直接复用的套路与坑。
表单行常见三种形态，对应三种填写策略：

| 行形态 | 示例 | 策略（推荐原语） |
| --- | --- | --- |
| 纯文案 + 末尾补值 | `致：…`、`9．其他承诺：` | `append_text_to_paragraph(..., run_props={"underline": True})` 末尾追加 |
| 下划线占位符 `________` | `单位地址：_____________________` | `replace_placeholder(doc, anchor, r"_{2,}", value, run_props=...)` 就地替换 |
| 占位符带后缀 | `法定代表人…：________ (签字或盖章)` | `replace_placeholder` 就地替换，值落在占位符原位、后缀自动拆 run 保留其后 |
| 空格占位 | `日期：2025年  月  日` | `fill_date_slots(doc, anchor, markers=["年","月"], values=["2","9"])` 删空白 slot 后插值 |

> 下方「关键经验」中的坑现多已由 `replace_placeholder` / `fill_date_slots` / `run_props` / `expect_text_contains` / `check_no_placeholders` 等原语封装，调用方通常无需手写 lxml；经验本身仍列出以备排查或自定义扩展。

### 关键经验（踩坑总结）

1. **定位优先用段落绝对索引** `locate_by_paragraph_index`。
   表单里常有重复文案（如两处「联系电话：」「电子邮箱：」），`locate_by_text` 子串匹配会歧义。
   填写类操作只动 run、不增删段落，索引全程稳定，用绝对索引最稳。
   现已由 `locate_by_paragraph_index(..., expect_text_contains="...")` 封装防漂移校验：传入预期
   子串，索引若漂移到错误段落会当场抛 `LocateError`（含实际文本），不再静默填错。

2. **占位符填写必须「就地替换」，不能「末尾追加」**。
   `append_text_to_paragraph` 把值加到段落最末。对 `法定代表人…：________ (签字或盖章)` 这类
   带后缀的行，追加会把值甩到 `(签字或盖章)` 之后 → `…代理人：________ (签字或盖章)张明远`，错位。
   正确做法：定位含占位符的 run，拆成「值 run + 后缀 run」就地替换。
   现已由 `replace_placeholder` 封装：自动拆「前缀→值→后缀」三段 run，后缀沿用原 rPr。

3. **下划线占位符用正则 `_{2,}` 匹配任意长度**，别硬编码 `________`（8 个）。
   不同行占位符长度不同（地址行 21 个、邮编行 11 个…），`str.split("________")` 只切前 8 个，
   剩余下划线残留在结果里 → `_____________值`。用 `re.search(r"_{2,}", text)` 取首段连续下划线。
   现已由 `replace_placeholder` 封装：`pattern` 接受 `re.Pattern` 或 str（自动 compile），默认
   传 `r"_{2,}"` 即可覆盖任意长度。未命中会抛 `WriterError`，不再静默残留。

4. **run 插入顺序：lxml `addnext` 正序 + 顺移 anchor**。
   要得到 `before → value → after`，从原 run 起逐个 `anchor.addnext(nr); anchor = nr`。
   ⚠️ 不要用「逆序 addnext」——那会得到反序。也不要把新 `<w:r>` append 进父 `<w:r>`（run 不可嵌套，
   会静默丢失文本）。
   现已由 `replace_placeholder` / `fill_date_slots` 封装：内部均用正序 addnext + 顺移 anchor，
   新 run 作为段落 `<w:p>` 直接子级插入，调用方无需手写。

5. **下划线样式：复用占位符 run 的 rPr，加 `<w:u w:val="single"/>`**。
   `rPr` 必须是 `<w:r>` 的第一个子元素；`<w:t>` 跟在后面。给填写值加下划线可与原占位符视觉一致，
   便于区分填写项。`_ensure_underline(rpr)` 已有则不动，避免重复。
   现已由 `run_props={"underline": True}` 封装：`replace_placeholder` / `fill_date_slots` /
   `append_text_to_paragraph` / `insert_paragraph_after` / `insert_text_at_anchor` 均支持
   `run_props` 参数，内部复用占位符/锚点 run 的 rPr 作 deepcopy 模板再叠加，无需手写 rPr。

6. **空格占位的日期行：「先删除再补充」**。
   `日期：2025年  月  日` 的「年」「月」run 后各跟一个空白 run（`  `）作月/日占位。
   不要末尾追加整串日期 → `…日2025年2月9日` 重复。正确：删掉「年/月」后的空白 slot run，
   再 `anchor.addnext(值 run)`（年→插月，月→插日），年份 2025 保留。
   现已由 `fill_date_slots` 封装：`fill_date_slots(doc, anchor, markers=["年","月"],
   values=["2","9"])` 一步完成「删空白 slot + 插值 run」，slot 非空或 marker 后非 `<w:r>`
   会抛 `WriterError`。

7. **校验：`compare_documents` 的 `unexpected_changes` 要传 `expected_changes` 白名单**。
   否则任何新增 run 都被报「意外改动」（属 SKILL Gotcha）。确认 `styles_xml_changed=False`、
   段落数不变、改动段落全在目标范围内即可。校验函数里匹配 run 用**精确等值**（`ts == needle`），
   别用子串（`in`）——年份 `2025` 含字符 `2`，会误命中月份校验。
   收尾还可用 `verifier.check_no_placeholders(doc, patterns=[r"_{2,}"])` 扫描全文档占位符残留，
   返回 `{"has_placeholder", "matches":[{paragraph,text,pattern}], "checked_patterns"}`，用于
   填写类任务的收尾断言。

### 临时脚本约定

工作过程产出的临时脚本统一放 `tmp/`，**任务结束删除**（不留痕，不污染仓库）。脚本内用项目根相对路径
（`input/`、`output/`、`src/`），从项目根 `uv run python tmp/xxx.py` 运行，cwd 即项目根。
产出文档放 `output/<场景>/`，是最终交付物，保留。

## 表单字段填写 API（新增原语）

针对「表单字段填写」场景新增的语义层原语，均在 `src/writer.py` / `src/locator.py` / `src/verifier.py`。
向后兼容：既有函数签名仅新增可选参数（默认值保持旧行为）。

### writer.replace_placeholder —— 占位符就地替换
```python
def replace_placeholder(doc, anchor, pattern, value,
                        run_props: dict | None = None,
                        occurrence: int = 1) -> dict
```
- 用途：在锚点段落内把**首个**（或第 occurrence 个）匹配 `pattern`（正则）的占位符片段就地替换为
  `value`，保留占位符 run 的 rPr（可叠加 `run_props`）。占位符 run 含后缀文本时自动拆出新 run
  承载后缀（沿用原 rPr，不叠加 run_props）。run 顺序 `before → value → after`（正序 addnext）。
- `anchor`：复用 `_resolve_anchor`（dict / int / `<w:p>`）。`pattern`：`re.Pattern` 或 str（自动
  compile），匹配**单个 run 内拼接后的文本**（不跨 run）。
- `run_props`：支持 `underline`(bool)/`bold`(bool)/`italic`(bool)/`color`(hex str)/`strike`(bool)。
  复用占位符 run 的 rPr 作 deepcopy 模板再叠加。
- **未命中抛 `WriterError`（不静默跳过）**；`value=""` 抛 `WriterError`。
- 返回 `{doc, paragraph_index, replaced_run_index, value_run_index, locator, changes}`。
- 与既有函数关系：是 `append_text_to_paragraph` 的「就地替换」补足——后者只追加到段末，前者精确替换
  段内占位符片段，避免带后缀行的值错位。

### writer.fill_date_slots —— 空白占位 slot 填写（日期行）
```python
def fill_date_slots(doc, anchor, markers: list[str], values: list[str],
                    run_props: dict | None = None) -> dict
```
- 用途：针对 `日期：2025年  月  日` 这类「年/月/日之间用空白 run 占位」的行。定位文本 strip 后
  等于 `markers`（如 `["年","月"]`）的 run，取其紧邻下一个兄弟 run，若为空白 slot 则删除并在
  marker run 后 `addnext` 值 run。`markers` 与 `values` 按位置对应。
- `run_props=None` 时默认 `{"underline": True}`；显式传 `{}` 则不加样式。
- slot 非空 / marker 后非 `<w:r>` / 长度不等 -> 抛 `WriterError`。
- 返回 `{doc, paragraph_index, filled:[{marker,value,value_run_index}], locator, changes}`。
- 与既有函数关系：`replace_placeholder` 处理「下划线占位符」，本函数处理「空白 run 占位」的日期行
  这类无法用正则 `_{2,}` 命中的场景。

### 写入函数新增 run_props 参数
`append_text_to_paragraph` / `insert_paragraph_after` / `insert_text_at_anchor` 均新增可选参数
`run_props: dict | None = None`（默认 None，行为不变）。传入时对生成的新 run 叠加样式（语义同
`replace_placeholder` 的 `run_props`）。内部共享 `_apply_run_props(rpr, run_props)` 辅助函数。

### locator.locate_by_paragraph_index 新增 expect_text_contains
```python
def locate_by_paragraph_index(doc, index, expect_text_contains: str | None = None)
```
- 默认 None，行为不变。传入时若该段文本不含此子串，抛 `LocateError`（含实际文本，便于排错）。
- 用途：把硬编码索引的「静默填错」挡在定位阶段——文档结构一变，索引漂移到错误段落会当场失败。

### verifier.check_no_placeholders —— 占位符残留检查
```python
def check_no_placeholders(doc_or_path, patterns: list[str] | None = None) -> dict
```
- 扫描所有 body 段落文本，检测是否残留占位符形态。默认 `patterns=[r"_{2,}"]`（≥2 个连续下划线）。
- 返回 `{"has_placeholder": bool, "matches":[{"paragraph":int,"text":str,"pattern":str}],
  "checked_patterns":[...]}`。
- 用途：填写类任务收尾断言（注意全文档可能含本次未填的其它占位符，可按段落范围过滤 matches）。
- 与既有函数关系：`compare_documents` 校验样式无损，本函数校验「内容填完无残留」，互补。

## 语义层 API（Semantic Layer）

在「原语级」之上新增一层「语义级」函数，覆盖真实投标/招标文档处理场景，把常见任务从
「10 步手写 lxml + 正则」压缩到「3 步调用」。全部为**新增函数 + 可选参数**，严格向后兼容。
模块：`src/locator.py` / `src/writer.py` / `src/structure.py`（新建）/ `src/verifier.py`。
约定：不命中/失败必抛异常（`LocateError`/`WriterError`/`StructureError`/`VerifierError`），
绝不静默跳过；取段落文本统一用 lxml iter('w:t')；标题检测两种来源都认（pStyle 经 styles.xml
name 翻译 + outlineLvl）。

### locator.locate_by_heading —— 按标题文本+大纲层级定位
```python
def locate_by_heading(doc, text=None, level=1, occurrence=1, exact=False) -> dict
```
- 用途：按「标题文本 + 大纲层级」定位标题段落。解决 `locate_by_text("第六章 …")` 误命中正文列举项。
- 判定「是标题」：pPr 含 `outlineLvl` 且 `val==level-1`，**或** pPr 含 `pStyle` 且该 style 的
  `name` 为 `heading {level}`（经 styles.xml 翻译；无 styles.xml 时退化用 HEADING_PSTYLE 数值映射）。
  **两种来源都认**——base.docx 用 pStyle=1/2/3，烟草招标.docx 用 outlineLvl=0。
- `text=None` 退化为「第 occurrence 个该层级标题」（向后兼容 `locate_by_heading_level`）；
  非 None 时默认 `text in ptext`（子串），`exact=True` 则 `ptext.strip()==text`。
- 返回 `{paragraph_index, p_elem, text, pStyle, outlineLvl, locator}`。未命中抛 `LocateError`
  （含已扫描标题数与首个标题文本）。`level` 越界抛 `LocateError`；`occurrence<1` 抛 `ValueError`。

### locator.locate_in_section —— 章节范围内定位
```python
def locate_in_section(doc, section_text, target_text, level=1,
                      exact_section=False, occurrence=1) -> dict
```
- 用途：先定位「文本==section_text 且为 level 级标题」的章节，再在该章节范围内（该标题到下一个
  同级/更高级标题前）找 `target_text`。解决「投标人名称：」在多节重复时的歧义。
- 章节范围界定：从 section 标题段本身起，到遇到 `outlineLvl <= level` 的另一标题前
  （section 标题段本身参与 target 匹配——同段命中也算）。
- 返回 `{paragraph_index, p_elem, text, section_heading:{index,text,level}, locator}`。
  section 未找到 / 范围内未命中 / occurrence 超出均抛 `LocateError`。

### locator.locate_table_by_header —— 按表头关键词定位表格
```python
def locate_table_by_header(doc, header_keywords, occurrence=1) -> dict
```
- 用途：按表头关键词定位表格。`header_keywords` 为 list[str]，表头首行拼接文本**同时包含全部关键词**
  即命中。
- 返回 `{table_index, tbl_elem, header_cells:[str], locator}`。空 list 抛 `ValueError`；
  未命中抛 `LocateError`。

### writer.replace_all_placeholders —— 同段多占位符一次性替换
```python
def replace_all_placeholders(doc, anchor, pattern, values, run_props=None) -> dict
```
- 用途：同段内**所有**匹配 `pattern` 的占位符，按出现顺序一次性替换为 `values` 列表。解决多占位符
  同段（`姓名：___性别：___年龄：___职务：___`）用 occurrence 逐个替换时 run 拆分导致索引漂移。
- 实现：先一遍扫描按 run 分组记录命中，再从后往前替换（同一 run 多匹配时按 match 顺序切片段）。
  每个占位符走与 `replace_placeholder` 相同的「前缀→值→后缀」三段拆分，值 run 叠加 `run_props`。
- `values` 长度必须 == 命中数，否则抛 `WriterError`（明确告知「命中 N 个，传 M 个值」）。
  任一 `value==""` 抛 `WriterError`；命中 0 抛 `WriterError`（不静默）。
- 返回 `{paragraph_index, replaced:[{rank, replaced_run_index, value_run_index, value}],
  locator, changes}`。

### writer.set_paragraph_text —— 整段替换文本
```python
def set_paragraph_text(doc, anchor, text, inherit_style=True, run_props=None) -> dict
```
- 用途：整段替换文本为 `text`，保留首个有 rPr 的 run 作模板（`inherit_style=True`）或无 rPr（False）。
- 实现：删段落内所有 `<w:r>` 与 `<w:hyperlink>`（保留 pPr 与 bookmarkStart/End），用模板 rPr 构造
  单个值 run。`run_props` 叠加。
- `text==""` → 清空段落全部 run（保留 pPr），返回 `run_index=None`，不抛（区别于 append 的空值抛错）。
  段落无 run 无 rPr 模板时，`inherit_style=True` 也无样式（等价 False）。
- 返回 `{paragraph_index, run_index, locator, changes}`。

### writer.set_cell_by_label —— 标签｜值 表格写入
```python
def set_cell_by_label(doc, table_index, label, value, mode="replace",
                      direction="right", inherit_style=True,
                      strip_colon=True, occurrence=1) -> dict
```
- 用途：在表格中找到文本==`label` 的单元格，把其**指定方向相邻**单元格写为 `value`。专治「标签｜值」
  合并表（如基本信息表、开票信息表）。
- `direction`："right"=右侧相邻 tc（同行下一列）；"below"=下方相邻 tc（同列下一行）。
- `label` 匹配：strip 后精确等值；`strip_colon=True`（默认）时 label 与单元格文本都 rstrip「：:」后比较。
  `occurrence` 选第几个匹配（默认 1）。
- label 未找到抛 `LocateError`；值单元格不存在（label 在行/列末尾）抛 `WriterError`；
  `value==""` 抛 `WriterError`（清空用 `deleter.clear_table_cell`）。
- 返回 `{table_index, label_cell:{row,col}, value_cell:{row,col}, locator, changes}`。

### structure 模块（新建 src/structure.py）—— 结构性操作
模块异常：`StructureError(Exception)`。依赖 `src.locator` 与 `src.writer._resolve_anchor`。

```python
def add_page_break_before(doc, anchor) -> dict
```
- 给锚点段落 pPr 插入 `<w:pageBreakBefore/>`，使其从新页开始。pPr 不存在则新建；已存在则幂等不重复插。
  返回 `{paragraph_index, added:bool, locator, changes}`。

```python
def remove_page_break(doc, anchor) -> dict
```
- 移除锚点段落的分页：删 pPr 内 `<w:pageBreakBefore/>`，**并删段内 run 里的 `<w:br w:type="page"/>`**
  （含承载该 br 且仅含 br 的空 run）。实战中封面标题继承的 `<w:br type="page"/>` 会产生空白首页，必须
  一并清理。返回 `{paragraph_index, removed_pbb:bool, removed_br:bool, locator, changes}`。
  无分页可删时两标志为 False（不抛）。

```python
def remove_section_break(doc, anchor=None, all_inline=False) -> dict
```
- 移除内嵌分节符（段落 pPr 内的 `<w:sectPr>`）。`anchor` 非 None 移该段；`all_inline=True` 移除 body
  中所有段落的内嵌 sectPr（统一由末尾 body 级 sectPr 控制）。两者至少传一，否则抛 `ValueError`。
  返回 `{removed_count, removed:[{paragraph_index}], locator, changes}`。
  移除后其 headerReference/footerReference 关系成为孤儿（无害，Word 容忍）——不清理 rels。

```python
def delete_range(doc, start_anchor, end_anchor_exclusive=None, *, delete_start=True) -> dict
```
- 删除 body 中从 `start_anchor` 到 `end_anchor_exclusive`（不含）之间的所有子元素（p 与 tbl）。
  `end_anchor_exclusive=None` 删到 body 末尾 sectPr 前；`delete_start=False` 保留 start 段从其下一兄弟删起。
  锚点复用 `_resolve_anchor`（dict/int/`<w:p>`）。start/end 非 body 直接子元素、end 在 start 之前均抛
  `StructureError`。**不删 body 末尾 `<w:sectPr>`**（始终保留）。
  返回 `{deleted_count, deleted_paragraphs, deleted_tables, locator, changes}`。

```python
def delete_section(doc, section_text, level=1, *, delete_heading=True) -> dict
```
- 删除某 H 标题章节的全部内容（标题到下一同级/更高级标题前）。是 `locate_by_heading` + 范围删除的组合。
  `delete_heading=True` 连标题段一起删；False 保留标题。章节未找到抛 `LocateError`。
  返回 `{section_heading:{index,text}, deleted_count, locator, changes}`。

```python
def insert_toc_field(doc, anchor, toc_level="1-3", title="目  录",
                     page_break=True, update_prompt=True) -> dict
```
- 在锚点段后插入「目录标题段 + 标准 TOC 域」。TOC 域结构：
  `fldChar begin → instrText 'TOC \o "{level}" \h \z \u' → fldChar separate → 占位文本 → fldChar end`。
  `title=None` 只插 TOC 域段；`page_break=True` 给标题段加 `pageBreakBefore`；`update_prompt=True` 在
  separate 后插灰色占位文本提示更新域。anchor 是 body 末尾段时新段插到 sectPr 前。
  返回 `{anchor_paragraph_index, title_paragraph_index, toc_field_paragraph_index, locator, changes}`。

### structure.renumber_list —— 排序列表编号快速重排序
```python
def renumber_list(doc, anchors, *, mode="auto", start=1) -> dict
```
- 用途：把一组列表段落的编号从「错乱的 4、5、6」重排为「连续的 1、2、3」。**自动检测两种成因**：
  - **自动编号（numPr）**：段落带 `<w:numPr><w:numId/></w:numPr>`，编号文本不在段落里、由 Word
    渲染算出。「4、5、6」常见成因是多个本该独立的列表复用了同一 `numId` 导致续号。修法：给这组段落
    **克隆出一个全新独立的 numId**（连带克隆其 abstractNum 定义），使其从 `start` 起号，旧定义保留
    供其它列表继续使用。
  - **手动文本编号**：段落开头是「4.」「4、」「(4)」「4)」等纯文本字符，无 numPr。修法：按段在组内
    的位置把段首编号文本替换为「1.」「2.」…（沿用原分隔符形态；多级如 `4.1.` 只换首级为 `1.1.`）。
- `anchors`：列表段落的锚点序列（list/tuple），每个元素复用 `_resolve_anchor`（dict/int/`<w:p>`），
  **顺序即重排后的编号顺序**。
- `mode`：`"auto"`（默认，按首个段成因判定，numPr 优先）/ `"numpr"`（仅自动编号，遇手动段抛错）
  / `"text"`（仅手动文本，遇 numPr 段抛错）。
- `start`：起始编号，默认 1。
- 返回 `{mode_detected:"numpr"|"text"|"mixed", start, count, renumbered:[{paragraph_index, rank,
  old, new, kind}], locator, changes}`。组内成因不一致时 `mode_detected="mixed"`，仍按首个成因统一处理。
- 边界：`anchors` 空 -> `ValueError`；`mode="auto"` 下段既无 numPr 又无可识别段首编号 -> `StructureError`；
  `mode` 不匹配成因 -> `StructureError`；自动编号模式无 numbering part -> `StructureError`。
- 样式保护：自动编号只改 numId 值与新增 numbering 定义，不动 pPr 其它子元素/run/旧定义；手动文本
  只换段首编号 run 文本，正文 run 与 pPr/rPr 全保留。
- 与既有函数关系：库首个处理「列表编号」的能力（既有模块无 numPr/numId 处理）。专治投标文档中
  删减列表项后编号断续、或跨段复制列表导致续号的常见痛点。

### 页眉页脚文本读写（reader 读 + structure 写）
库**首个**页眉(header)/页脚(footer)能力。读在 `src/reader.py`（非 mutate），写在 `src/structure.py`。

```python
def get_header_text(doc, *, section_index=0, which="default") -> dict
def get_footer_text(doc, *, section_index=0, which="default") -> dict
```
- 读取页眉/页脚文本，**非 mutate**（不创建/改任何 part、不动 sectPr/rels）。`which`：`default`/`first_page`/
  `even_page`（对应 headerReference/footerReference 的 `@w:type` default/first/even）。
- **linked 继承**：目标 section 无自有 part（`is_linked_to_previous=True`）时向更前 section 回溯取同
  kind/which 的 effective 文本（Word 继承语义）；回溯到头仍无（首 section 也 linked）→ `text=""`。
- 返回 `{text, paragraph_count, section_index, which, linked:bool, has_part:bool, locator}`。
  `linked`=目标 section 自身是否继承；`has_part`=回溯链上是否找到提供文本的 part。
- **实现要点（避坑）**：python-docx 代理对 linked 的 header/footer 访问 `.paragraphs`/`._element`
  **会 mutate**（创建 part 并断开 link）。本函数改走 raw rels：`sectPr` 上 `headerReference`/`footerReference`
  取 `r:id` → `doc.part.rels[rId].target_part.element` → `_paragraph_text`。`is_linked_to_previous` getter
  本身非 mutate，可安全用于判定。
- 边界：`doc` 非 Document → `ReaderError`；`section_index` 越界 → `ReaderError`；`which` 非法 → `ValueError`。

```python
def set_header_text(doc, text, *, section_index=0, which="default", align=None,
                    inherit_style=True) -> dict
def set_footer_text(doc, text, *, section_index=0, which="default", align=None,
                    inherit_style=True) -> dict
```
- 设置页眉/页脚文本（替换目标 part 首段文本）。`which` 同上；`align`：`None`/`left`/`center`/`right`
  设首段 `pPr/jc`；`inherit_style`：True 取该 part 首个有 rPr 的 run 作模板（保留字体），False 无 rPr。
- **part 创建**：通过 python-docx 代理确保目标 part 存在（linked 则设 `is_linked_to_previous=False`
  触发 part 创建，由 python-docx 完成 headerReference/rels/Content_Types 仪式），取首段 `<w:p>`，
  清空其 `<w:r>/<w:hyperlink>`（保留 pPr/bookmark），加单个值 run。rPr 模板逻辑复用
  `writer.set_paragraph_text`。
- `text=""` → 清空首段 run（保留 pPr 与 part），不抛。幂等：重复写同文本不堆叠 run（先清空再写）。
- 返回 `{doc, section_index, which, paragraph_count, run_index, align, locator, changes}`；
  `changes` 项 `paragraph: None, path: "sections[i].header.{which}.paragraphs[0]"`。
- 边界：`section_index` 越界 → `StructureError`；`which` 非法 → `ValueError`；`align` 非 left/center/right/None
  → `ValueError`。base.docx 无 header/footer part → 写入时自动创建（改 rels/Content_Types，**不改 styles.xml**，
  verifier 标准 body 对比无意外改动）。
- 实战：写页脚公司名/页眉项目名/首页豁免（配合 `which="first_page"`）。

### verifier.check_structure —— 一次性结构断言
```python
def check_structure(doc, *, h1_titles=None, each_h1_on_own_page=False,
                    toc_field=False, no_inline_section_breaks=False,
                    min_h1_count=None) -> dict
```
- 一次性断言文档结构，返回不满足项清单。替代实战末尾手写的「遍历查 H1/分页/TOC」。
  `h1_titles`（list[str]，子串匹配，顺序敏感）；`each_h1_on_own_page`（每个 H1 须带 pageBreakBefore，
  第一个除外）；`toc_field`（body 含 instrText 文本含 "TOC"）；`no_inline_section_breaks`（body 段落 pPr
  无内嵌 sectPr）；`min_h1_count`（H1 数 ≥ 此值）。
- 返回 `{passed:bool, h1_count, h1_titles_found, violations:[{check, detail}], locator}`。
  `passed = len(violations)==0`。H1 判定复用 locator 两种来源。

### verifier.render_to_pdf_and_check —— PDF 渲染分页校验
```python
def render_to_pdf_and_check(docx_path, expected_first_lines=None,
                            soffice_path=None, outdir=None) -> dict
```
- 调 LibreOffice headless 把 docx 转 PDF，用 pypdf 提取每页首行，校验分页顺序。**这是验证「分页是否真的
  生效」的唯一可靠手段**（XML 层的 pageBreakBefore 是否生效需看渲染）。
- `expected_first_lines`（list[str]，期望各页首行包含的文本，子串，按页顺序）；None 则只转 PDF 不校验。
  `soffice_path` 探测优先级：`shutil.which("soffice")` / `which("libreoffice")` / Windows 常见路径
  `C:\Program Files\LibreOffice\program\soffice.exe` / `(x86)` 版。探测不到抛 `VerifierError`（附安装提示）。
  `pypdf` 运行时 import，缺失抛 `VerifierError`（不作为硬依赖）。
- 返回 `{pdf_path, page_count, page_first_lines, passed:bool, violations, locator}`。
  `expected_first_lines` 长度 > 实际页数记 violation「页数不足」；逐页首行不含期望记 violation。
  转换失败抛 `VerifierError`（含 stderr）。**依赖外部 LibreOffice，不进 run_tests.py**（仅在函数自测里用）。
