用 Python + React 打造一个开源的 AI 写标书智能体~

完整代码已开源。

代码很多，文章只放主要代码和提示词，完整代码可以查看开源项目。

Github: https://github.com/FB208/OpenBidKit_Yibiao

Gitee: https://gitee.com/yibiao-ai/OpenBidKit_Yibiao

今天是第五期，我参考OpenCode的自我反思、矫正机制，优化了标书提纲生成，不再依赖模型自身能力“抽卡”，而是通过自我反思、矫正机制确保任何弱模型都能稳定输出结果。（测试用的LongCat-Flash-Lite）

第二期已经讲过一次“生成标书提纲”，当时的核心思路是：

1. 短标书 + 强模型，可以一次性生成完整 JSON。
2. 长标书 + 普通模型，就拆成一级目录、二三级目录分步生成。
3. 最后再校验 JSON 格式，把多个结果拼成完整目录。

这个方案已经能解决大部分问题。

但后面真拿一些便宜模型、弱模型去跑，就会发现一个更现实的问题：

**不是模型不会写目录，而是无法做到稳定，生成目录的质量完全依靠运气。**

尤其是标书目录这种三级嵌套结构，模型很容易出现下面这些问题：

1. JSON 语法错误，少逗号、少括号。
2. 外面套了 markdown 代码块。
3. 返回了一堆解释文字，不是纯 JSON。
4. 字段名写错，比如把 `children` 写成 `child`。
5. 只生成了两级目录，没有达到三级。
6. 一级目录和评分项对不上。
7. 分步生成时编号混乱。

在标书智能体里，目录是后续正文生成、缓存、编辑、导出 Word 等一切步骤的基础。目录 JSON 一旦出错，后面所有流程都无法正常进行。

所以这一期重点聊：

**如何让弱模型也能稳定输出复杂 JSON。**

![image-20260506170040744](https://oss.agnet.top/keep/2026/05/06/20260506170042816.png)

## 一、不要只相信提示词

```text
只返回 JSON，不要输出任何其他内容。
必须严格按照以下格式输出。
如果输出错误你会受到惩罚。
```

这种写法当然有用，但不够。

因为弱模型的问题不是“不知道要输出 JSON”，而是它在复杂任务里很容易失控。

所以我的思路是：

**提示词只负责提高第一次成功率，真正的稳定性要靠工作流。**

现在项目里的目录生成，已经不是简单的一次模型调用，而是一个完整流程：

1. 先生成目录。
2. 校验 JSON 语法。
3. 校验 Pydantic Schema。
4. 校验业务规则。
5. 失败后尝试修复 JSON。
6. 修复失败后重试。
7. 完整目录失败后切换分步生成。
8. 生成后再让模型审核目录质量。
9. 审核不通过，再带着建议重新生成一次。

也就是说，模型不是“答一次就结束”，而是有批改、有返工、有兜底。

![json生成流程图](https://oss.agnet.top/keep/2026/05/04/20260504113901445.png)

## 二、先定义标准 JSON 结构

目录结构在后端用 Pydantic 定义。

核心结构如下：

```python
class OutlineItem(BaseModel):
    """目录项"""

    id: str
    title: str
    description: str
    source_requirement_id: Optional[str] = None
    source_requirement_title: Optional[str] = None
    children: Optional[List["OutlineItem"]] = None
    content: Optional[str] = None


class OutlineResponse(BaseModel):
    """目录响应"""

    outline: List[OutlineItem]


class OutlineChildrenResponse(BaseModel):
    """指定一级目录下的子目录响应。"""

    children: List[OutlineItem]


class OutlineReviewResponse(BaseModel):
    """目录审核响应。"""

    passed: bool
    suggestions: List[str] = Field(default_factory=list)
```

这样做的好处是，模型输出以后，不是简单 `json.loads()` 一下就算通过，而是要真正符合结构。

完整目录要求是：

```json
{
  "outline": [
    {
      "id": "1",
      "title": "",
      "description": "",
      "children": [
        {
          "id": "1.1",
          "title": "",
          "description": "",
          "children": [
            {
              "id": "1.1.1",
              "title": "",
              "description": ""
            }
          ]
        }
      ]
    }
  ]
}
```

这里有一个很关键的点：

**合法 JSON 不等于可用 JSON。**

比如模型返回下面这种内容，它是合法 JSON，但对我们没用：

```json
{
  "outline": [
    {
      "id": "1",
      "title": "项目理解",
      "description": "项目理解"
    }
  ]
}
```

因为它只有一级目录，不满足标书目录的三级结构要求。

所以还需要业务校验。

```python
@classmethod
def _validate_complete_outline(cls, payload: Dict[str, Any]) -> None:
    """校验完整目录至少达到三级结构。"""
    outline = payload.get("outline") or []
    if not outline:
        raise ValueError("目录不能为空")

    if cls._outline_depth(outline) < 3:
        raise ValueError("完整目录至少需要三级结构")
```



## 三、统一封装 JSON 生成函数

项目里所有需要 JSON 输出的地方，都会走同一个函数：

```python
async def collect_json_response(
    self,
    messages: list[dict[str, str]],
    temperature: float = 0.7,
    schema: type[BaseModel] | None = None,
    validator: JsonValidator | None = None,
    progress_callback: ProgressCallback | None = None,
    progress_label: str = "JSON结果",
    failure_message: str = "模型返回的 JSON 数据格式无效",
) -> Dict[str, Any]:
    """收集并校验 JSON 响应。"""
```

它做了几件事：

1. 请求模型。
2. 优先使用 JSON 模式。
3. 如果当前模型不支持 `response_format`，自动切换普通请求。
4. 提取模型返回中的 JSON。
5. 用 Pydantic 校验。
6. 执行业务校验。
7. 失败后进入 JSON 修复流程。
8. 连续失败后再抛出错误。

其中 JSON 模式请求是这样的：

```python
content = await self.collect_chat_completion(
    messages,
    temperature=temperature,
    response_format={"type": "json_object"}
    if use_response_format
    else None,
)
```

但是很多 OpenAI-like 服务并不完全支持 `response_format`。

所以这里没有把系统稳定性绑定在 JSON 模式上，而是做了兼容处理：

```python
except AppError as exc:
    if (
        not use_response_format
        or not self._is_response_format_unsupported_error(exc.message)
    ):
        raise

    await self.emit_progress(
        progress_callback,
        "当前模型不支持结构化 JSON 响应，已降级为普通请求解析。",
    )
    content = await self.collect_chat_completion(
        messages,
        temperature=temperature,
        response_format=None,
    )
    return content, False
```

这里虽然是“降级”，但不是功能降级，而是兼容不同模型接口。



## 四、失败后不是重新问，而是定向修复

如果模型返回的 JSON 校验失败，系统不会立刻重来。

因为很多时候，模型已经生成了大部分正确内容，只是某个字段错了，或者外面多了一层代码块。

这时候推倒重来很浪费，而且新结果也未必更好。

所以我加了一个 JSON 修复助手。

提示词如下：

```python
system_prompt = """你是一个严格的 JSON 修复助手。请根据给出的原始内容和校验问题，修复现有结果。

要求：
1. 优先在原结果基础上做最小必要修改，不要整体重写
2. 尽量保留原有结构、字段值、节点顺序和已生成内容
3. 若缺少必填字段，应结合现有上下文补齐合理内容，不要用空字符串敷衍
4. 若存在多余说明、代码块包裹、字段名错误、children 结构不规范或顶层包裹错误，应修正为合法 JSON
5. 只返回修复后的完整 JSON，不要输出任何解释
"""
```

修复时会把三部分信息传给模型：

1. 目标结果类型，比如“完整目录”“一级目录”“章节子目录”。
2. 当前校验问题，比如 JSON 语法错误、字段缺失、三级目录不足。
3. 模型刚才返回的原始内容。

代码如下：

```python
repair_messages = build_json_repair_messages(
    invalid_content=invalid_content,
    issues=issues,
    target_description=progress_label,
)
```

这一步其实就是一个非常实用的“自我修复”。

不是简单告诉模型“你错了，再来一次”。

而是告诉它：

1. 你刚才输出了什么。
2. 哪里错了。
3. 现在要在原结果基础上修。
4. 不要重新发挥。

这对弱模型特别有效。

因为弱模型生成复杂 JSON 可能不稳定，但让它修一个已经接近正确的 JSON，成功率会高很多。

## 五、校验问题要明确告诉模型

修复能不能成功，很大程度取决于错误信息是否具体。

所以代码里会把 JSON 解析错误和 Pydantic 校验错误都格式化成可读问题。

```python
@staticmethod
def _format_json_issues(error: Exception) -> list[str]:
    """格式化 JSON 解析或校验问题。"""
    if isinstance(error, json.JSONDecodeError):
        return [
            f"JSON 语法错误：第 {error.lineno} 行第 {error.colno} 列附近 {error.msg}。"
        ]

    if isinstance(error, ValidationError):
        issues: list[str] = []
        for item in error.errors():
            location = ".".join(str(part) for part in item.get("loc", [])) or "root"
            message = item.get("msg", "字段校验失败")
            issues.append(f"{location}: {message}")
        return issues or [str(error)]

    return [str(error)]
```

比如模型少了 `description` 字段，修复助手拿到的就不是一句“格式不对”，而是类似：

```text
outline.0.children.1.description: Field required
```

模型知道具体哪里错，修复成功率自然更高。

## 六、完整目录失败，切换分步生成

即使有 JSON 修复，也不能保证一次性生成完整三级目录永远成功。

尤其是弱模型，输出长 JSON 时很容易中途断掉。

所以目录生成还有一个兜底策略：

**完整生成失败，就切换为分步生成。**

核心代码如下：

```python
try:
    outline = await self._generate_outline_full(
        overview=overview,
        requirements=requirements,
        uploaded_expand=uploaded_expand,
        old_outline=old_outline,
        suggestions=suggestions,
        progress_callback=progress_callback,
    )
    return outline, "full"
except AppError as exc:
    if exc.message != "模型返回的目录数据格式无效":
        raise
    await self.ai.emit_progress(
        progress_callback,
        "一次性生成完整目录失败，切换为分步生成模式。",
    )
    outline = await self._generate_outline_fallback(
        overview=overview,
        requirements=requirements,
        uploaded_expand=uploaded_expand,
        old_outline=old_outline,
        suggestions=suggestions,
        progress_callback=progress_callback,
    )
    return outline, "fallback"
```

分步生成的逻辑是：

1. 先生成一级目录。
2. 遍历每个一级目录。
3. 单独生成这个一级目录下面的二三级目录。
4. 把多个结果组装起来。
5. 程序统一重新编号。
6. 最后再做完整目录校验。

```python
top_level_outline = await self._generate_top_level_outline(...)

top_level_items = top_level_outline.get("outline", [])
assembled_items: list[dict[str, Any]] = []

for index, item in enumerate(top_level_items, start=1):
    children_response = await self._generate_outline_children(
        overview=overview,
        requirements=requirements,
        parent_item=item,
        uploaded_expand=uploaded_expand,
        old_outline=old_outline,
        suggestions=suggestions,
        progress_callback=progress_callback,
    )

    children = children_response.get("children") or []
    if children:
        merged_item["children"] = children

    assembled_items.append(merged_item)

outline = self._renumber_outline({"outline": assembled_items})
```

弱模型一次生成不了一个大 JSON，那就让它每次只生成一小段 JSON。

最后由程序负责组装。

这里还有一个细节：编号不要完全相信模型。

经过大量测试，即使在提示词中告诉了模型，你生成的是第二章的目录，但返回的编号仍然是从`1`开始的，甚至有可能乱编号。

所以最终会用程序统一编号：

```python
@classmethod
def _renumber_items(
    cls,
    items: list[dict[str, Any]],
    parent_prefix: str = "",
) -> list[dict[str, Any]]:
    """递归重排目录项编号。"""
    normalized_items: list[dict[str, Any]] = []
    for index, item in enumerate(items, start=1):
        item_id = f"{parent_prefix}.{index}" if parent_prefix else str(index)
        normalized_item = {**item, "id": item_id}
        children = item.get("children") or []
        if children:
            normalized_item["children"] = cls._renumber_items(children, item_id)
        else:
            normalized_item.pop("children", None)
        normalized_items.append(normalized_item)

    return normalized_items
```

能用代码保证的事情，就不要交给模型保证。

## 七、让模型审核自己生成的目录

上面解决的是 JSON 稳定性。

但目录生成还有另一个问题：

JSON 格式正确，不代表目录质量正确。

比如它可能漏掉了某个评分项，或者一级目录没有和技术评分要求对应起来。

所以生成完成后，还会进入审核流程。

审核提示词如下：

```python
system_prompt = """你是一个严格的招标文件目录审核专家。请审核目录是否符合项目概述和技术评分要求。

要求：
1. 重点检查目录是否完整覆盖技术评分要点
2. 检查一级目录名称是否专业、准确，是否尽量与评分项原文保持一致
3. 检查目录层级是否清晰，是否达到三级目录要求，是否存在明显遗漏、错位、重复或不合理章节
4. 只返回 JSON，格式为：{"passed": true, "suggestions": []}
5. 若不通过，suggestions 中必须给出具体、可执行的修改建议
6. 除了 JSON 外，不要输出任何其他内容
"""
```

审核结果结构很简单：

```json
{
  "passed": false,
  "suggestions": [
    "补充系统安全保障相关章节",
    "一级目录需要更贴近技术评分项名称"
  ]
}
```

目录生成主流程如下：

```python
first_outline, generation_mode = await self._generate_outline_by_mode(...)

first_review = await self._review_outline(
    overview=overview,
    requirements=requirements,
    outline=first_outline,
    progress_callback=progress_callback,
    stage_label="首次审核",
)

if first_review["passed"]:
    return first_outline

suggestions = first_review.get("suggestions") or [
    "请根据项目概述和技术评分要求补全目录覆盖范围，并修正不合理章节。"
]

second_outline, _ = await self._generate_outline_by_mode(
    overview=overview,
    requirements=requirements,
    uploaded_expand=uploaded_expand,
    old_outline=old_outline,
    mode=generation_mode,
    progress_callback=progress_callback,
    suggestions=suggestions,
)
```

如果审核不通过，就把审核建议回灌给生成 Prompt，再重新生成。



## 八、一一对应模式：把一级目录交给程序锁死

后来我又加了一个“一一对应模式”。

原因是很多招标文件的技术评分要求非常明确，技术标目录最好和评分大类一一对应。

如果把一级目录完全交给模型，它可能会合并、改写、漏掉某些评分大类。

所以一一对应模式的思路是：

1. 先从技术评分要求中提取评分大类。
2. 程序根据评分大类直接构造一级目录。
3. 一级目录标题、顺序、关联评分项都锁死。
4. 模型只负责生成每个一级目录下的二三级目录。
5. 最后再校验一级目录和评分大类是否完全一致。

提取评分大类的提示词：

```python
system_prompt = """你是一个专业的招标文件分析专家。请从技术评分要求中提取适合作为技术标一级目录的评分大类。

要求：
1. 只提取技术评分大类，不要提取商务、报价、资质、售后服务等非技术类条目
2. 每个大类都必须适合作为技术标一级目录标题，标题要专业、简洁、完整
3. 同一大类下的细项、子项、分值说明、评分标准要归入 detail_points，不要拆成多个一级目录
4. requirement_id 必须唯一，使用 R1、R2、R3 这种格式
5. description 需要概括该大类关注的核心内容
6. detail_points 中保留该大类下的关键评分细项，使用简洁短句
7. 只返回 JSON，格式必须为 {"groups": [...]}，不要输出任何其他内容
"""
```

程序构造一级目录：

```python
@staticmethod
def _build_top_level_outline_from_groups(
    groups: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """根据技术评分大类直接构造一级目录。"""
    outline: list[dict[str, Any]] = []
    for index, group in enumerate(groups, start=1):
        title = str(group.get("title") or "").strip()
        outline.append(
            {
                "id": str(index),
                "title": title,
                "description": str(group.get("description") or title).strip(),
                "source_requirement_id": str(
                    group.get("requirement_id") or f"R{index}"
                ).strip(),
                "source_requirement_title": title,
            }
        )
    return outline
```

校验一级目录映射：

```python
if len(outline_items) != len(groups):
    raise ValueError("一级目录数量必须与技术评分大类数量一致")

for index, (item, group) in enumerate(zip(outline_items, groups), start=1):
    expected_title = str(group.get("title") or "").strip()
    actual_title = str(item.get("title") or "").strip()
    if actual_title != expected_title:
        raise ValueError(
            f"第 {index} 个一级目录标题必须严格等于技术评分大类标题：{expected_title}"
        )
```

这个模式的核心思想是：

**不要让模型决定所有事情。**

能由程序确定的结构，就用程序确定。

模型只负责它擅长的部分。



## 九、总结

本次升级的核心，不是强化提示词和工作流，而是引入自我反思的过程，让AI生成的结果从“抽卡”模式正式转变为“返回稳定结果”的模式。经测试

以前是：

```text
用户输入 -> 模型生成 -> 返回结果
```

现在是：

```text
用户输入
-> 模型生成
-> JSON 解析
-> Schema 校验
-> 业务校验
-> JSON 修复
-> 多轮重试
-> 分步生成
-> 目录审核
-> 建议回灌
-> 二次生成
-> 返回结果
```

所以让弱模型稳定输出复杂 JSON，我觉得关键不是一个神奇 Prompt，而是下面几条工程原则：

1. 提示词要明确，但不能只靠提示词。
2. 所有 JSON 输出必须走统一解析和校验。
3. 校验不只看语法，还要看业务规则。
4. 失败后优先修复已有结果，不要直接推倒重来。
5. 修复时要把具体错误原因告诉模型。
6. 大 JSON 生成失败，就拆成多个小 JSON。
7. 编号、映射关系这类确定性逻辑，尽量交给程序。
8. 生成后要审核，审核建议要能回流到下一轮生成。
9. 长流程要通过 SSE 告诉用户系统正在做什么。

一句话总结：

**弱模型不是不能用，而是不能裸用。**

只要给它加上校验、修复、重试、分步生成和自我审核，一样可以稳定完成复杂 JSON 输出。

### 完整代码已开源

Github: https://github.com/FB208/OpenBidKit_Yibiao

Gitee: https://gitee.com/yibiao-ai/OpenBidKit_Yibiao
