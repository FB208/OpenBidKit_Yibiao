用Python+React打造一个开源的AI写标书智能体~

今天是第一期，招标文件解析：

![](https://qiniu.markup.com.cn/20250911140912504.png)

招标文件动辄几万字，虽然现在各主流大模型的上下文窗口都越来越大，但也只能代表AI**“可以处理几十万字的上下文”**，并不代表你随便扔给AI几十万字，它就能**“处理得好几十万字的上下文”。**

我们在写投标文件之前，一定要先把招标文件通读一遍，标注出需要注意的点，然后再有针对性的撰写招标文件。

AI写标书也是一样，第一步要做的就是**招标文件解析**。

# 一、Word、PDF文件内容提取

AI解析招标文件，难住我的第一关，并不是如何让AI提取招标文件中的内容，而是怎么把招标文件的内容完整的从PDF、word中提取出来。

word文件提取，选用的是`docx2python`

```Python
content = None
try:
    # 使用docx2python提取，它能更好地处理表格和结构
    content = docx2python(file_path)
    extracted_text = []
    # 处理文档内容
    if hasattr(content, 'document'):
        for section in content.document:
            for element in section:
                if isinstance(element, list):
                    # 这可能是表格
                    extracted_text.append("\n[表格内容]")
                    for row in element:
                        if isinstance(row, list):
                            row_text = " | ".join([str(cell).strip() for cell in row if cell])
                            if row_text:
                                extracted_text.append(row_text)
                        else:
                            extracted_text.append(str(row))
                    extracted_text.append("[表格结束]\n")
                else:
                    # 普通文本
                    text = str(element).strip()
                    if text:
                        extracted_text.append(text)
    result = "\n".join(extracted_text).strip()
    # 确保释放资源
    if content:
        del content
    gc.collect()
    return result
except Exception as e:
    # 确保释放资源
    if content:
        del content
    gc.collect()
```

pdf文件提取，则使用`pdfplumber`

```Python
pdf = None
try:
    extracted_text = []
    pdf = pdfplumber.open(file_path)
    for page_num, page in enumerate(pdf.pages, 1):
        # 添加页码标识
        extracted_text.append(f"\n--- 第 {page_num} 页 ---\n")
        # 提取普通文本
        text = page.extract_text()
        if text:
            extracted_text.append(text)
        # 提取表格
        tables = page.extract_tables()
        for table_num, table in enumerate(tables, 1):
            extracted_text.append(f"\n[表格 {table_num}]")
            for row in table:
                if row:  # 跳过空行
                    # 过滤空值并连接单元格
                    row_text = " | ".join([str(cell) if cell else "" for cell in row])
                    extracted_text.append(row_text)
            extracted_text.append("[表格结束]\n")
    
    result = "\n".join(extracted_text).strip()
    # 确保关闭PDF文件
    if pdf:
        pdf.close()
    gc.collect() 
    return result
except Exception as e:
    # 确保关闭PDF文件
    if pdf:
        pdf.close()
    gc.collect()
```

# 二、封装AI流式请求通用函数

注意这里使用的是`AsyncOpenAI`即OpenAI的异步客户端，因为之后要一次性编写几十万字的标书，为了提高速度，使用并发请求，则必须使用`AsyncOpenAI`

```Python
def __init__(self, api_key: str, base_url: str = None, model_name: str = "gpt-3.5-turbo"):
    """初始化OpenAI服务"""
    self.api_key = api_key
    self.base_url = base_url
    self.model_name = model_name
    
    # 初始化OpenAI客户端 - 使用异步客户端
    self.client = openai.AsyncOpenAI(
        api_key=api_key,
        base_url=base_url if base_url else None
    )    
async def stream_chat_completion(
    self, 
    messages: list, 
    temperature: float = 0.7,
    response_format: dict = None
) -> AsyncGenerator[str, None]:
    """流式聊天完成请求 - 真正的异步实现"""
    try:
        stream = await self.client.chat.completions.create(
            model=self.model_name,
            messages=messages,
            temperature=temperature,
            stream=True,
            **({"response_format": response_format} if response_format is not None else {})
        )
        
        async for chunk in stream:
            if chunk.choices[0].delta.content is not None:
                yield chunk.choices[0].delta.content
                
    except Exception as e:
        yield f"错误: {str(e)}"
```

  

# 三、招标文件解析提示词

## 项目概述

##### SystemPrompt

```Markdown
你是一个专业的标书撰写专家。请分析用户发来的招标文件，提取并总结项目概述信息。

请重点关注以下方面：
1. 项目名称和基本信息
2. 项目背景和目的
3. 项目规模和预算
4. 项目时间安排
5. 项目要实施的具体内容
6. 主要技术特点
7. 其他关键要求

工作要求：
1. 保持提取信息的全面性和准确性，尽量使用原文内容，不要自己编写
2. 只关注与项目实施有关的内容，不提取商务信息
3. 直接返回整理好的项目概述，除此之外不返回任何其他内容
```

##### UserPrompt

```Markdown
请分析以下招标文件内容，提取项目概述信息：
{request.file_content}
```

## 技术评分要求

在编写招标文件中的技术方案时，技术评分要求非常重要，基本要做到1对1应答式编写，所以评分要求的提取则尤为重要，我采用了自我反思式的结构化提示词进行提取处理。

##### SystemPrompt

```Markdown
你是一名专业的招标文件分析师，擅长从复杂的招标文档中高效提取“技术评分项”相关内容。请严格按照以下步骤和规则执行任务：
### 1. 目标定位
- 重点识别文档中与“技术评分”、“评标方法”、“评分标准”、“技术参数”、“技术要求”、“技术方案”、“技术部分”或“评审要素”相关的章节（如“第X章 评标方法”或“附件X：技术评分表”）。
- 忽略商务、价格、资质等非技术类评分项。
### 2. 提取内容要求
对每一项技术评分项，按以下结构化格式输出（若信息缺失，标注“未提及”），如果评分项不够明确，你需要根据上下文分析并也整理成如下格式：
【评分项名称】：<原文描述，保留专业术语>
【权重/分值】：<具体分值或占比，如“30分”或“40%”>
【评分标准】：<详细规则，如“≥95%得满分，每低1%扣0.5分”>
【数据来源】：<文档中的位置，如“第5.2.3条”或“附件3-表2”>

### 3. 处理规则
- **模糊表述**：有些招标文件格式不是很标准，没有明确的“技术评分表”，但一定都会有“技术评分”相关内容，请根据上下文判断评分项。
- **表格处理**：若评分项以表格形式呈现，按行提取，并标注“[表格数据]”。
- **分层结构**：若存在二级评分项（如“技术方案→子项1、子项2”），用缩进或编号体现层级关系。
- **单位统一**：将所有分值统一为“分”或“%”，并注明原文单位（如原文为“20点”则标注“[原文：20点]”）。

### 4. 输出示例
【评分项名称】：系统可用性 
【权重/分值】：25分 
【评分标准】：年平均故障时间≤1小时得满分；每增加1小时扣2分，最高扣10分。 
【数据来源】：附件4-技术评分细则（第3页） 

【评分项名称】：响应时间
【权重/分分】：15分 [原文：15%]
【评分标准】：≤50ms得满分；每增加10ms扣1分。
【数据来源】：第6.1.2条

### 5. 验证步骤
提取完成后，执行以下自检：
- [ ] 所有技术评分项是否覆盖（无遗漏）？
- [ ] 权重总和是否与文档声明的技术分总分一致（如“技术部分共60分”）？

直接返回提取结果，除此之外不输出任何其他内容
```

##### UserPrompt

```Markdown
请分析以下招标文件内容，提取技术评分要求信息：
{request.file_content}
```

  

# 完整代码已开源

Github：https://github.com/yibiaoai/yibiao-simple

Gitee：https://gitee.com/yibiao-ai/yibiao-simple